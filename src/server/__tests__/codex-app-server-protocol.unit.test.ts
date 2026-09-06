import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

import { afterEach, describe, expect, it, vi } from 'vitest';
import type { McpServerDefinition } from '../../shared/config-types';
import * as mcpCommand from '../utils/mcp-command';

import {
  buildCodexFileChangeResultContent,
  buildCodexCompletedFileChangeInput,
  buildManagedCodexAgentRoleConfig,
  buildCodexAppServerArgs,
  buildCodexAppServerLaunchConfig,
  buildCodexInitializeParams,
  buildCodexSandboxPolicy,
  buildCodexTurnStartParams,
  buildCodexStartedFileChangeInput,
  classifyAndForwardCodexStderr,
  CodexRuntime,
  codexModelCacheKey,
  CODEX_SKILL_EXTRA_ROOTS_SET_TIMEOUT_MS,
  CODEX_SKILL_LIST_TIMEOUT_MS,
  configureCodexSkillExtraRoots,
  createCodexMcpStartupBarrier,
  initializeCodexRpc,
  isCodexNoActiveTurnSteerRejection,
  KNOWN_CODEX_SERVER_REQUEST_METHODS,
  mapCodexTurnCompletedNotification,
  mapCodexTurnPlanUpdatedNotification,
  materializeManagedCodexExtensions,
  resolveCodexThreadModelProvider,
  resolveCodexConversationBranchPoint,
  resolveCodexSkillExtraRoots,
  serializeCodexPermissionResponse,
  summarizeCodexNotificationForLog,
  summarizeCodexThreadParamsForLog,
  type PendingCodexRequest,
} from '../runtimes/codex';
import { projectManagedCodexMcpLaunchConfig } from '../runtimes/managed-codex/extensions/mcp-launch-projection';
import { RuntimeSteerUnavailableError } from '../runtimes/types';

describe('Codex app-server protocol helpers', () => {
  const tempRoots: string[] = [];

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    while (tempRoots.length > 0) {
      const dir = tempRoots.pop();
      if (dir) rmSync(dir, { recursive: true, force: true });
    }
  });

  function tempWorkspace(): string {
    const dir = join(tmpdir(), `myagents-codex-test-${Date.now()}-${Math.random().toString(16).slice(2)}`);
    mkdirSync(dir, { recursive: true });
    tempRoots.push(dir);
    return dir;
  }

  it('materializes native Agent role prompt, model, and Skill references deterministically', () => {
    expect(buildManagedCodexAgentRoleConfig({
      name: 'reviewer',
      description: 'Reviews changes',
      prompt: 'Review carefully.\nDo not guess.',
      model: 'gpt-5.4',
      skills: [{ name: 'testing', path: '/workspace/.claude/skills/testing/SKILL.md' }],
      scope: 'project',
      sourceId: 'workspace:reviewer',
    })).toBe([
      'developer_instructions = "Review carefully.\\nDo not guess."',
      'model = "gpt-5.4"',
      '',
      '[[skills.config]]',
      'path = "/workspace/.claude/skills/testing/SKILL.md"',
      'enabled = true',
      '',
    ].join('\n'));
  });

  it('materializes a long Skill name without using it as a filesystem component', () => {
    const workspace = tempWorkspace();
    const skillDir = join(workspace, 'skill-source');
    const skillPath = join(skillDir, 'SKILL.md');
    mkdirSync(skillDir, { recursive: true });
    const longName = `skill-${'x'.repeat(300)}`;
    const materialized = materializeManagedCodexExtensions({
      revision: 'revision',
      workspacePath: workspace,
      scenario: { type: 'desktop' },
      enabledPluginIds: [],
      skills: [{
        name: longName,
        description: 'Long but valid native name',
        contentSha256: 'sha',
        path: skillPath,
        scope: 'project',
        sourceId: 'workspace',
        sourceLocalId: 'skill-source',
      }],
      commands: [],
      agents: [],
      mcpServers: [],
      dynamicTools: [],
      components: [],
    });

    try {
      expect(materialized.skills.map(skill => skill.name)).toEqual([longName]);
      expect(materialized.skillRoots).toHaveLength(1);
      expect(existsSync(join(materialized.skillRoots[0], '000'))).toBe(true);
    } finally {
      materialized.cleanup();
    }
  });

  it('projects the complete Cuse bundle so relative executable and reference paths resolve', () => {
    const workspace = tempWorkspace();
    const source = join(workspace, 'cuse');
    mkdirSync(join(source, 'scripts'), { recursive: true });
    mkdirSync(join(source, 'references'));
    const binary = process.platform === 'win32' ? 'cuse.exe' : 'cuse';
    writeFileSync(join(source, 'scripts', binary), 'bundled native CLI');
    writeFileSync(join(source, 'references', 'setup.md'), 'setup reference');
    writeFileSync(join(source, 'package.json'), JSON.stringify({ entrypoint: `scripts/${binary}` }));
    writeFileSync(join(source, 'SKILL.md'), 'Cuse');
    const result = materializeManagedCodexExtensions({
      revision: 'cuse', workspacePath: workspace, scenario: { type: 'desktop' },
      enabledPluginIds: [], commands: [], agents: [], mcpServers: [], dynamicTools: [], components: [],
      skills: [{ name: 'cuse', description: 'desktop control', contentSha256: 'sha',
        path: join(source, 'SKILL.md'), scope: 'user', sourceId: 'global', sourceLocalId: 'cuse' }],
    });
    try {
      const projected = join(result.skillRoots[0], '000');
      const metadata = JSON.parse(readFileSync(join(projected, 'package.json'), 'utf8'));
      expect(readFileSync(join(projected, metadata.entrypoint), 'utf8')).toBe('bundled native CLI');
      expect(readFileSync(join(projected, 'references', 'setup.md'), 'utf8')).toBe('setup reference');
    } finally { result.cleanup(); }
    expect(readFileSync(join(source, 'scripts', binary), 'utf8')).toBe('bundled native CLI');
  });

  it('holds Managed Codex Host tools behind the existing permission owner', async () => {
    const runtime = new CodexRuntime();
    const dispatch = vi.fn(async () => ({
      success: true,
      contentItems: [{ type: 'text' as const, text: 'done' }],
    }));
    const rpc = { respond: vi.fn() };
    const process = {
      exited: false,
      threadId: 'thread-one',
      currentTurnId: 'turn-one',
      processGeneration: 'generation-one',
      approvalPolicy: 'on-request',
      rpc,
      pendingRequests: new Map(),
      pendingHostCalls: new Map(),
      settledHostCallIds: new Set(),
      extensionSnapshot: {
        hostToolDispatcher: {
          descriptors: [{ name: 'myagents__mcp__local__write', description: 'Write', inputSchema: { type: 'object' } }],
          dispatch,
          dispose: vi.fn(),
        },
      },
      abortPendingHostCall(callId: string, reason: string) {
        const pending = this.pendingHostCalls.get(callId);
        if (!pending || pending.settled) return;
        pending.settled = true;
        pending.controller.abort();
        this.pendingHostCalls.delete(callId);
        this.settledHostCallIds.add(callId);
        this.rpc.respond(pending.rpcId, {
          success: false,
          contentItems: [{ type: 'inputText', text: reason }],
        });
      },
    };
    const events: unknown[] = [];
    const handle = (runtime as unknown as {
      handleManagedCodexHostToolCall(
        target: typeof process,
        rpcId: number,
        params: Record<string, unknown>,
        emit: (event: unknown) => void,
      ): void;
    }).handleManagedCodexHostToolCall.bind(runtime);

    handle(process, 41, {
      threadId: 'thread-one',
      turnId: 'turn-one',
      callId: 'call-one',
      tool: 'myagents__mcp__local__write',
      arguments: { path: 'README.md' },
    }, event => events.push(event));

    expect(dispatch).not.toHaveBeenCalled();
    expect(events).toEqual([expect.objectContaining({
      kind: 'permission_request',
      requestId: '41',
      toolName: 'myagents__mcp__local__write',
    })]);
    await runtime.respondPermission(
      process as unknown as import('../runtimes/types').RuntimeProcess,
      '41',
      'allow_once',
    );
    await vi.waitFor(() => expect(dispatch).toHaveBeenCalledOnce());
    await vi.waitFor(() => expect(rpc.respond).toHaveBeenCalledWith(41, {
      success: true,
      contentItems: [{ type: 'inputText', text: 'done' }],
    }));
  });

  it('rejects schema-invalid Host arguments before opening permission UI', () => {
    const runtime = new CodexRuntime();
    const rpc = { respond: vi.fn() };
    const events: unknown[] = [];
    const process = {
      exited: false,
      threadId: 'thread-one',
      currentTurnId: 'turn-one',
      processGeneration: 'generation-one',
      approvalPolicy: 'on-request',
      rpc,
      pendingRequests: new Map(),
      pendingHostCalls: new Map(),
      settledHostCallIds: new Set(),
      extensionSnapshot: {
        hostToolDispatcher: {
          descriptors: [{
            name: 'myagents__mcp__local__write',
            description: 'Write',
            inputSchema: {
              type: 'object',
              properties: { path: { type: 'string' } },
              required: ['path'],
              additionalProperties: false,
            },
          }],
          dispatch: vi.fn(),
          dispose: vi.fn(),
        },
      },
    };
    const handle = (runtime as unknown as {
      handleManagedCodexHostToolCall(
        target: typeof process,
        rpcId: number,
        params: Record<string, unknown>,
        emit: (event: unknown) => void,
      ): void;
    }).handleManagedCodexHostToolCall.bind(runtime);

    handle(process, 42, {
      threadId: 'thread-one',
      turnId: 'turn-one',
      callId: 'call-invalid',
      tool: 'myagents__mcp__local__write',
      arguments: { unexpected: true },
    }, event => events.push(event));

    expect(events).toEqual([]);
    expect(process.pendingRequests.size).toBe(0);
    expect(rpc.respond).toHaveBeenCalledWith(42, expect.objectContaining({ success: false }));
  });

  it('logs thread paths and developer instructions as irreversible metadata, never prefixes', () => {
    const developerInstructions = 'private identity and workspace instructions';
    const cwd = '/workspace/private-project';
    const summary = summarizeCodexThreadParamsForLog({
      cwd,
      model: 'gpt-5',
      threadId: 'native-thread-secret',
      developerInstructions,
      dynamicTools: [{ name: 'private-tool', description: 'private schema' }],
    });

    expect(summary).toMatchObject({
      cwd: {
        present: true,
        chars: cwd.length,
        hash: expect.stringMatching(/^[a-f0-9]{12}$/),
      },
      model: 'gpt-5',
      dynamicToolCount: 1,
      threadId: {
        present: true,
        chars: 'native-thread-secret'.length,
        hash: expect.stringMatching(/^[a-f0-9]{12}$/),
      },
      developerInstructions: {
        present: true,
        chars: developerInstructions.length,
        hash: expect.stringMatching(/^[a-f0-9]{12}$/),
      },
    });
    expect(JSON.stringify(summary)).not.toContain('private identity');
    expect(JSON.stringify(summary)).not.toContain('native-thread-secret');
    expect(JSON.stringify(summary)).not.toContain('/workspace/private-project');
    expect(JSON.stringify(summary)).not.toContain('private-tool');
  });

  it('logs Codex notification commands, file paths, tools, and errors only as irreversible metadata', () => {
    const markers = {
      password: 'CODEX_PASSWORD_MARKER',
      input: '/Users/private/CODEX_INPUT_MARKER.pdf',
      output: '/Users/private/CODEX_OUTPUT_MARKER',
      error: 'CODEX_ERROR_MARKER from /Users/private',
    };
    const command = `myagents anydoc convert ${markers.input} --password ${markers.password} --output ${markers.output}`;
    const commandDetail = summarizeCodexNotificationForLog('item/completed', {
      threadId: 'thread-private',
      item: {
        type: 'commandExecution',
        id: 'item-private',
        command,
        exitCode: 1,
        error: { message: markers.error },
      },
    });
    const fileDetail = summarizeCodexNotificationForLog('item/completed', {
      item: {
        type: 'fileChange',
        changes: [
          { path: markers.input, kind: 'update' },
          { path: markers.output, kind: 'add' },
        ],
      },
    });

    expect(commandDetail).toContain('type=commandExecution');
    expect(commandDetail).toContain('command={"present":true');
    expect(commandDetail).toContain('error={"present":true');
    expect(commandDetail).toContain('exit=1');
    expect(fileDetail).toContain('type=fileChange');
    expect(fileDetail).toContain('files=2');
    expect(fileDetail).toContain('paths={"present":true');
    const combined = `${commandDetail} ${fileDetail}`;
    for (const marker of Object.values(markers)) {
      expect(combined).not.toContain(marker);
    }
    expect(combined).not.toContain('myagents anydoc convert');
  });

  it('keeps promoted stderr and generic error events semantic without retaining provider payloads', () => {
    const stderrMarker = 'CODEX_STDERR_PRIVATE_MARKER';
    const providerMarker = 'CODEX_PROVIDER_PRIVATE_MARKER';
    const emitted: unknown[] = [];
    classifyAndForwardCodexStderr(
      `error sending request for url (https://private.invalid/${stderrMarker})`,
      event => emitted.push(event),
    );

    const runtime = new CodexRuntime();
    const parsed = (
      runtime as unknown as {
        parseNotification(
          process: { compactControl: null; threadId: string },
          method: string,
          params: unknown,
          emit: (event: unknown) => void,
        ): unknown;
      }
    ).parseNotification(
      { compactControl: null, threadId: '' },
      'error',
      { error: { message: `${providerMarker} at /Users/private/provider-body` } },
      () => {},
    );

    const messages = [...emitted, parsed].map(event => (
      event as { message: string }
    ).message);
    const combined = messages.join('\n');
    expect(combined).toContain('Codex HTTP request failed');
    expect(combined).toContain('Runtime error detail=');
    expect(messages.every(message => /"hash":"[a-f0-9]{12}"/.test(message))).toBe(true);
    expect(combined).not.toContain(stderrMarker);
    expect(combined).not.toContain(providerMarker);
    expect(combined).not.toContain('private.invalid');
    expect(combined).not.toContain('/Users/private');
  });

  it('uses v2 initialize capabilities and sends initialized notification', async () => {
    const rpc = {
      call: vi.fn().mockResolvedValue({}),
      notify: vi.fn(),
    };

    await initializeCodexRpc(rpc, 1234);

    expect(rpc.call).toHaveBeenCalledWith('initialize', buildCodexInitializeParams(), 1234);
    expect(rpc.notify).toHaveBeenCalledWith('initialized');
    expect(buildCodexInitializeParams()).toMatchObject({
      capabilities: {
        experimentalApi: false,
        requestAttestation: false,
      },
    });
    expect(buildCodexInitializeParams(true)).toMatchObject({
      capabilities: {
        experimentalApi: true,
        requestAttestation: false,
      },
    });
  });

  it('keeps the known Codex server request allowlist in sync with app-server schema', () => {
    expect(KNOWN_CODEX_SERVER_REQUEST_METHODS).toEqual([
      'item/commandExecution/requestApproval',
      'item/fileChange/requestApproval',
      'item/tool/requestUserInput',
      'mcpServer/elicitation/request',
      'item/permissions/requestApproval',
      'item/tool/call',
      'account/chatgptAuthTokens/refresh',
      'attestation/generate',
      'currentTime/read',
      'applyPatchApproval',
      'execCommandApproval',
    ]);
  });

  it('invalidates managed model discovery when the installed runtime pointer changes', () => {
    const oldKey = codexModelCacheKey('managed-provider', {
      source: 'managed-provider',
      commandPath: '/runtime/0.142.2/codex',
      env: {},
      version: '0.142.2',
    });
    const newKey = codexModelCacheKey('managed-provider', {
      source: 'managed-provider',
      commandPath: '/runtime/0.144.1/codex',
      env: {},
      version: '0.144.1',
    });

    expect(newKey).not.toBe(oldKey);
  });

  it('keeps system-cli Codex app-server startup free of managed provider MCP config', () => {
    const env: Record<string, string | undefined> = {};
    expect(buildCodexAppServerArgs({
      commandPath: '/usr/local/bin/codex',
      runtimeSource: 'system-cli',
      codexEnv: env,
      mcpServers: [{
        id: 'fs',
        name: 'Filesystem',
        type: 'stdio',
        command: 'node',
        args: ['server.js'],
        env: { FS_TOKEN: 'secret-token' },
        isBuiltin: false,
      }],
    })).toEqual([
      '/usr/local/bin/codex',
      '-c',
      'project_doc_fallback_filenames=["CLAUDE.md"]',
      'app-server',
    ]);
    expect(env.FS_TOKEN).toBeUndefined();
  });

  it('does not enable Codex default-mode request_user_input at app-server startup', () => {
    const env: Record<string, string | undefined> = {};
    expect(buildCodexAppServerArgs({
      commandPath: '/usr/local/bin/codex',
      runtimeSource: 'managed-provider',
      codexEnv: env,
    })).toEqual([
      '/usr/local/bin/codex',
      '-c',
      'project_doc_fallback_filenames=["CLAUDE.md"]',
      '-c',
      'cli_auth_credentials_store="file"',
      '-c',
      'model_provider="myagents_managed_http"',
      '-c',
      'model_providers.myagents_managed_http.name="OpenAI"',
      '-c',
      'model_providers.myagents_managed_http.wire_api="responses"',
      '-c',
      'model_providers.myagents_managed_http.requires_openai_auth=true',
      '-c',
      'model_providers.myagents_managed_http.supports_websockets=false',
      'app-server',
    ]);

    expect(buildCodexAppServerArgs({
      commandPath: '/usr/local/bin/codex',
      runtimeSource: 'system-cli',
      codexEnv: env,
    })).toEqual([
      '/usr/local/bin/codex',
      '-c',
      'project_doc_fallback_filenames=["CLAUDE.md"]',
      'app-server',
    ]);
  });

  it('owns an explicit HTTP-only OpenAI provider for the managed Codex runtime', () => {
    const launch = buildCodexAppServerLaunchConfig({
      commandPath: '/managed/codex',
      runtimeSource: 'managed-provider',
      codexEnv: {},
    });

    expect(launch.modelProvider).toBe('myagents_managed_http');
    expect(launch.args).toContain('model_provider="myagents_managed_http"');
    expect(launch.args).toContain('model_providers.myagents_managed_http.name="OpenAI"');
    expect(launch.args).toContain('model_providers.myagents_managed_http.wire_api="responses"');
    expect(launch.args).toContain('model_providers.myagents_managed_http.requires_openai_auth=true');
    expect(launch.args).toContain('model_providers.myagents_managed_http.supports_websockets=false');
  });

  it('keeps persisted provider identity for model-unknown legacy resumes', () => {
    expect(resolveCodexThreadModelProvider('myagents_managed_http', undefined, undefined))
      .toBe('myagents_managed_http');
    expect(resolveCodexThreadModelProvider('myagents_managed_http', 'thread-1', 'gpt-5.6-sol'))
      .toBe('myagents_managed_http');
    expect(resolveCodexThreadModelProvider('myagents_managed_http', 'thread-1', undefined))
      .toBeUndefined();
    expect(resolveCodexThreadModelProvider(undefined, undefined, 'gpt-5.6-sol'))
      .toBeUndefined();
  });

  it('injects managed Codex MCP servers through app-server config args without argv secrets', () => {
    const env: Record<string, string | undefined> = { HTTPS_PROXY: 'http://127.0.0.1:7890' };
    const args = buildCodexAppServerArgs({
      commandPath: '/managed/codex',
      runtimeSource: 'managed-provider',
      codexEnv: env,
      mcpServers: [
        {
          id: 'fs.tool',
          name: 'Filesystem',
          type: 'stdio',
          command: 'node',
          args: ['server.js'],
          env: { FS_TOKEN: 'secret-token' },
          isBuiltin: false,
        },
        {
          id: 'remote-http',
          name: 'Remote',
          type: 'http',
          url: 'https://example.com/mcp',
          headers: { Authorization: 'Bearer {{REMOTE_TOKEN}}' },
          env: { REMOTE_TOKEN: 'remote-secret' },
          isBuiltin: false,
        },
      ],
    });

    expect(args).toContain('cli_auth_credentials_store="file"');
    expect(args).toContain('mcp_servers.fs_tool.command="node"');
    expect(args).toContain('mcp_servers.fs_tool.args=["server.js"]');
    expect(args).toContain('mcp_servers.fs_tool.env_vars=["FS_TOKEN","HTTPS_PROXY","NO_PROXY","no_proxy"]');
    expect(args).toContain('mcp_servers.fs_tool.startup_timeout_sec=60');
    expect(args).toContain('mcp_servers.remote-http.url="https://example.com/mcp"');
    expect(args).toContain('mcp_servers.remote-http.env_http_headers={Authorization="MYAGENTS_MCP_REMOTE_HTTP_AUTHORIZATION"}');
    expect(args).toContain('mcp_servers.remote-http.startup_timeout_sec=60');
    expect(args.join('\n')).not.toContain('secret-token');
    expect(args.join('\n')).not.toContain('remote-secret');
    expect(env.FS_TOKEN).toBe('secret-token');
    expect(env.MYAGENTS_MCP_REMOTE_HTTP_AUTHORIZATION).toBe('Bearer remote-secret');
    expect(env.REMOTE_TOKEN).toBeUndefined();
    expect(env.NO_PROXY).toContain('127.0.0.1');
  });

  it('normalizes legacy preset npx MCP commands before managed Codex startup', () => {
    const env: Record<string, string | undefined> = {};
    const launch = buildCodexAppServerLaunchConfig({
      commandPath: '/managed/codex',
      runtimeSource: 'managed-provider',
      codexEnv: env,
      mcpServers: [{
        id: 'playwright',
        name: 'Playwright',
        type: 'stdio',
        command: 'npx',
        args: ['@playwright/mcp@latest', '--isolated'],
        isBuiltin: true,
      }],
    });

    const commandArg = launch.args.find((arg) => arg.startsWith('mcp_servers.playwright.command='));
    const mcpArgs = launch.args.find((arg) => arg.startsWith('mcp_servers.playwright.args='));
    expect(commandArg).toBeDefined();
    expect(commandArg).not.toBe('mcp_servers.playwright.command="npx"');
    expect(mcpArgs).toContain('@playwright/mcp@0.0.68');
    expect(mcpArgs).not.toContain('@latest');
    expect(mcpArgs).toContain('"-y"');
    expect(launch.mcpServerNames).toEqual(['playwright']);
  });

  it('reports the safe Windows npx distribution error at the Managed Codex projection boundary', () => {
    const resolver = vi.spyOn(mcpCommand, 'resolveNpxMcpInvocation');
    resolver.mockImplementationOnce(() => {
      throw new mcpCommand.NpxMcpResolutionError();
    });

    const projection = projectManagedCodexMcpLaunchConfig([{
      id: 'playwright',
      name: 'Playwright',
      type: 'stdio',
      command: 'npx',
      args: ['@playwright/mcp@0.0.68'],
      isBuiltin: true,
    }], {});

    expect(projection.args).toEqual([]);
    expect(projection.failures).toEqual([expect.objectContaining({
      serverId: 'playwright',
      state: 'failed',
      code: 'mcp_projection_rejected',
      message: expect.stringContaining(
        'No complete Windows Node.js distribution with npm/bin/npx-cli.js was found for MCP startup',
      ),
    })]);

    resolver.mockImplementationOnce(() => {
      throw new Error('private unexpected detail');
    });
    const unexpected = projectManagedCodexMcpLaunchConfig([{
      id: 'unexpected',
      name: 'Unexpected',
      type: 'stdio',
      command: 'npx',
      args: ['package-name'],
      isBuiltin: false,
    }], {});
    expect(unexpected.failures[0]?.message).toContain('unexpected launch projection failure');
    expect(unexpected.failures[0]?.message).not.toContain('private unexpected detail');
  });

  it('settles managed Codex MCP readiness only after every injected server is terminal', async () => {
    const barrier = createCodexMcpStartupBarrier(['playwright', 'remote-http']);
    barrier.arm();
    let settled = false;
    const ready = barrier.wait().then((result) => {
      settled = true;
      return result;
    });

    barrier.observe({
      threadId: null,
      name: 'playwright',
      status: 'starting',
      error: null,
      failureReason: null,
    });
    barrier.observe({
      threadId: null,
      name: 'unrelated-user-config',
      status: 'ready',
      error: null,
      failureReason: null,
    });
    barrier.observe({
      threadId: null,
      name: 'playwright',
      status: 'ready',
      error: null,
      failureReason: null,
    });
    await Promise.resolve();
    expect(settled).toBe(false);

    barrier.observe({
      threadId: null,
      name: 'remote-http',
      status: 'failed',
      error: 'connection refused',
      failureReason: null,
    });

    await expect(ready).resolves.toEqual({
      outcome: 'degraded',
      reason: 'terminal_status',
      states: {
        playwright: 'ready',
        'remote-http': 'failed',
      },
      pendingNames: [],
      elapsedMs: expect.any(Number),
    });
  });

  it('soft-degrades when injected MCP startup never reaches a terminal state', async () => {
    vi.useFakeTimers();
    const barrier = createCodexMcpStartupBarrier(['playwright']);
    barrier.arm();
    barrier.observe({
      threadId: null,
      name: 'playwright',
      status: 'starting',
      error: null,
      failureReason: null,
    });

    const startup = barrier.wait();
    await vi.advanceTimersByTimeAsync(10_000);
    await expect(startup).resolves.toEqual({
      outcome: 'degraded',
      reason: 'timeout',
      states: { playwright: 'starting' },
      pendingNames: ['playwright'],
      elapsedMs: 10_000,
    });
  });

  it('releases the startup wait as a failure when the Codex process exits', async () => {
    const barrier = createCodexMcpStartupBarrier(['playwright']);
    barrier.arm();
    const startup = barrier.wait();

    barrier.fail(new Error('Codex process exited during MCP startup with code 1'));

    await expect(startup).rejects.toThrow('Codex process exited during MCP startup with code 1');
  });

  it('charges process initialization to the single absolute MCP dispatch window', async () => {
    vi.useFakeTimers();
    const barrier = createCodexMcpStartupBarrier(['playwright']);
    const acceptedAt = Date.now();

    await vi.advanceTimersByTimeAsync(8_000);
    barrier.arm(acceptedAt);
    const startup = barrier.wait();
    await vi.advanceTimersByTimeAsync(2_000);

    await expect(startup).resolves.toMatchObject({
      outcome: 'degraded',
      reason: 'timeout',
      elapsedMs: 10_000,
    });
  });

  it('returns ready when every injected MCP reaches ready inside the armed window', async () => {
    const barrier = createCodexMcpStartupBarrier(['playwright']);
    barrier.arm();
    barrier.observe({
      threadId: null,
      name: 'playwright',
      status: 'ready',
      error: null,
      failureReason: null,
    });

    await expect(barrier.wait()).resolves.toMatchObject({
      outcome: 'ready',
      pendingNames: [],
      states: { playwright: 'ready' },
    });
  });

  it('keeps waiting when Codex reports cancelled before the same MCP becomes ready', async () => {
    const barrier = createCodexMcpStartupBarrier(['playwright']);
    barrier.arm();
    let settled = false;
    const startup = barrier.wait().then((result) => {
      settled = true;
      return result;
    });

    barrier.observe({
      threadId: null,
      name: 'playwright',
      status: 'starting',
      error: null,
      failureReason: null,
    });
    barrier.observe({
      threadId: null,
      name: 'playwright',
      status: 'cancelled',
      error: null,
      failureReason: null,
    });
    await Promise.resolve();
    expect(settled).toBe(false);

    barrier.observe({
      threadId: null,
      name: 'playwright',
      status: 'ready',
      error: null,
      failureReason: null,
    });

    await expect(startup).resolves.toMatchObject({
      outcome: 'ready',
      pendingNames: [],
      states: { playwright: 'ready' },
    });
  });

  it('does not let a late cancelled status overwrite a terminal MCP failure', async () => {
    const barrier = createCodexMcpStartupBarrier(['playwright', 'remote-http']);
    barrier.arm();
    const startup = barrier.wait();

    barrier.observe({
      threadId: null,
      name: 'playwright',
      status: 'failed',
      error: 'spawn failed',
      failureReason: null,
    });
    barrier.observe({
      threadId: null,
      name: 'playwright',
      status: 'cancelled',
      error: null,
      failureReason: null,
    });
    barrier.observe({
      threadId: null,
      name: 'remote-http',
      status: 'ready',
      error: null,
      failureReason: null,
    });

    await expect(startup).resolves.toMatchObject({
      outcome: 'degraded',
      reason: 'terminal_status',
      pendingNames: [],
      states: {
        playwright: 'failed',
        'remote-http': 'ready',
      },
    });
  });

  it('isolates unsafe managed MCP entries while keeping valid servers launchable', () => {
    const env: Record<string, string | undefined> = {};
    const mcpServers: McpServerDefinition[] = [
      {
        id: 'arg-secret', name: 'Arg Secret', type: 'stdio', command: 'node',
        args: ['server.js', '--api-key', 'sk-test-secret-value'], isBuiltin: false,
      },
      {
        id: 'safe', name: 'Safe', type: 'stdio', command: 'node',
        args: ['safe-server.js'], env: { SAFE_TOKEN: 'safe-secret' }, isBuiltin: false,
      },
      {
        id: 'env-openai', name: 'OpenAI env', type: 'stdio', command: 'node',
        args: ['server.js'], env: { OPENAI_API_KEY: 'must-not-leak' }, isBuiltin: false,
      },
      {
        id: 'url-query', name: 'URL Query', type: 'http',
        url: 'https://example.com/mcp?transport=streamable', isBuiltin: false,
      },
    ];
    const launch = buildCodexAppServerLaunchConfig({
      commandPath: '/managed/codex',
      runtimeSource: 'managed-provider',
      codexEnv: env,
      mcpServers,
    });
    const projection = projectManagedCodexMcpLaunchConfig(mcpServers, {});

    expect(launch.mcpServerNames).toEqual(['safe']);
    expect(launch.args).toContain('mcp_servers.safe.command="node"');
    expect(launch.args.join('\n')).not.toContain('mcp_servers.arg-secret');
    expect(launch.args.join('\n')).not.toContain('mcp_servers.env-openai');
    expect(launch.args.join('\n')).not.toContain('mcp_servers.url-query');
    expect(launch.args.join('\n')).not.toContain('sk-test-secret-value');
    expect(launch.args.join('\n')).not.toContain('must-not-leak');
    expect(env.SAFE_TOKEN).toBe('safe-secret');
    expect(env.OPENAI_API_KEY).toBeUndefined();
    expect(projection.failures).toEqual([
      expect.objectContaining({ serverId: 'arg-secret', message: expect.stringMatching(/credential flag/i) }),
      expect.objectContaining({ serverId: 'env-openai', message: expect.stringMatching(/OPENAI_API_KEY/i) }),
      expect.objectContaining({ serverId: 'url-query', message: expect.stringMatching(/query string/i) }),
    ]);
  });

  it('keeps in-process MCP on the Host path and isolates conflicting native MCP env values', () => {
    expect(() => buildCodexAppServerArgs({
      commandPath: '/managed/codex',
      runtimeSource: 'managed-provider',
      codexEnv: {},
      mcpServers: [{
        id: 'builtin-image', name: 'Builtin image', type: 'stdio',
        command: '__builtin__', args: [], isBuiltin: true,
      }],
    })).not.toThrow();

    const mcpServers: McpServerDefinition[] = [
      { id: 'one', name: 'One', type: 'stdio', command: 'one', env: { TOKEN: 'first' }, isBuiltin: false },
      { id: 'two', name: 'Two', type: 'stdio', command: 'two', env: { TOKEN: 'second' }, isBuiltin: false },
    ];
    const launch = buildCodexAppServerLaunchConfig({
      commandPath: '/managed/codex',
      runtimeSource: 'managed-provider',
      codexEnv: {},
      mcpServers,
    });
    const projection = projectManagedCodexMcpLaunchConfig(mcpServers, {});
    expect(launch.mcpServerNames).toEqual(['one']);
    expect(projection.failures).toEqual([
      expect.objectContaining({ serverId: 'two', message: expect.stringMatching(/TOKEN.*one/i) }),
    ]);
  });

  it('keeps generated HTTP header env ownership isolated from stdio env', () => {
    const env: Record<string, string | undefined> = {};
    const mcpServers: McpServerDefinition[] = [
      {
        id: 'a', name: 'HTTP owner', type: 'http', url: 'https://example.com/mcp',
        headers: { Authorization: 'Bearer http-secret' }, isBuiltin: false,
      },
      {
        id: 'b', name: 'Stdio collision', type: 'stdio', command: 'node',
        env: { MYAGENTS_MCP_A_AUTHORIZATION: 'stdio-secret' }, isBuiltin: false,
      },
    ];
    const launch = buildCodexAppServerLaunchConfig({
      commandPath: '/managed/codex',
      runtimeSource: 'managed-provider',
      codexEnv: env,
      mcpServers,
    });
    const projection = projectManagedCodexMcpLaunchConfig(mcpServers, {});

    expect(launch.mcpServerNames).toEqual(['a']);
    expect(projection.failures).toEqual([
      expect.objectContaining({
        serverId: 'b',
        message: expect.stringMatching(/MYAGENTS_MCP_A_AUTHORIZATION.*a/i),
      }),
    ]);
    expect(env.MYAGENTS_MCP_A_AUTHORIZATION).toBe('Bearer http-secret');
    expect(Object.values(env)).not.toContain('stdio-secret');
  });

  it('injects project .claude/skills as Codex app-server extra skill roots', async () => {
    const workspace = tempWorkspace();
    const projectSkillsDir = join(workspace, '.claude', 'skills');
    mkdirSync(projectSkillsDir, { recursive: true });
    const rpc = { call: vi.fn().mockResolvedValue({}) };

    await expect(configureCodexSkillExtraRoots(rpc, workspace)).resolves.toEqual({
      extraRoots: [projectSkillsDir],
      loadedSkillNames: [],
    });

    expect(resolveCodexSkillExtraRoots(workspace)).toEqual([projectSkillsDir]);
    expect(rpc.call).toHaveBeenCalledWith(
      'skills/extraRoots/set',
      { extraRoots: [projectSkillsDir] },
      CODEX_SKILL_EXTRA_ROOTS_SET_TIMEOUT_MS,
    );
    expect(rpc.call).toHaveBeenCalledWith(
      'skills/list',
      { cwds: [workspace], forceReload: true },
      CODEX_SKILL_LIST_TIMEOUT_MS,
    );
  });

  it('logs Codex Skill parser details without exposing absolute paths', async () => {
    const workspace = tempWorkspace();
    const projectSkillsDir = join(workspace, '.claude', 'skills');
    const expectedSkillPath = join(projectSkillsDir, 'expected-skill', 'SKILL.md');
    mkdirSync(projectSkillsDir, { recursive: true });
    const warning = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const rpc = {
      call: vi.fn(async (method: string) => method === 'skills/list'
        ? {
            data: [{
              skills: [{ name: 'expected-skill', enabled: true, path: expectedSkillPath }],
              errors: [{
                path: join(projectSkillsDir, 'broken', 'SKILL.md'),
                message: 'invalid frontmatter SECRET_SENTINEL BODY_SENTINEL',
              }],
            }],
          }
        : {}),
    };

    await expect(configureCodexSkillExtraRoots(
      rpc,
      workspace,
      1_234,
      [projectSkillsDir],
      [{ name: 'expected-skill', path: expectedSkillPath }],
    )).resolves.toEqual({
      extraRoots: [projectSkillsDir],
      loadedSkillNames: ['expected-skill'],
    });

    expect(warning).toHaveBeenCalledWith(expect.stringContaining('skills/list parser warning'));
    const logLine = warning.mock.calls.flat().join('\n');
    expect(logLine).toContain('<workspace>/.claude/skills/broken/SKILL.md');
    expect(logLine).toContain('message={"present":true,"chars":');
    expect(logLine).not.toContain('invalid frontmatter');
    expect(logLine).not.toContain('SECRET_SENTINEL');
    expect(logLine).not.toContain('BODY_SENTINEL');
    expect(logLine).not.toContain(workspace);
  });

  it('keeps Codex available when one projected Skill is missing after read-back', async () => {
    const workspace = tempWorkspace();
    const projectSkillsDir = join(workspace, '.claude', 'skills');
    mkdirSync(projectSkillsDir, { recursive: true });
    const warning = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const rpc = {
      call: vi.fn(async (method: string) => method === 'skills/list'
        ? {
            data: [{
              skills: [],
              errors: [{ path: join(projectSkillsDir, 'web-access', 'SKILL.md'), message: 'invalid YAML' }],
            }],
          }
        : {}),
    };

    await expect(configureCodexSkillExtraRoots(
      rpc,
      workspace,
      1_234,
      [projectSkillsDir],
      [{ name: 'web-access', path: join(projectSkillsDir, 'web-access', 'SKILL.md') }],
    )).resolves.toEqual({
      extraRoots: [projectSkillsDir],
      loadedSkillNames: [],
    });
    expect(warning).toHaveBeenCalledWith(expect.stringContaining('skills/list parser warning'));
    const warningLog = warning.mock.calls.flat().join('\n');
    expect(warningLog).toContain('continuing without them: web-access');
    expect(warningLog).not.toContain('invalid YAML');
  });

  it('does not let a same-name Skill from another root satisfy projected identity', async () => {
    const workspace = tempWorkspace();
    const projectedRoot = join(workspace, 'projected-skills');
    const projectedPath = join(projectedRoot, 'skill-creator', 'SKILL.md');
    const systemPath = join(workspace, 'system-skills', 'skill-creator', 'SKILL.md');
    mkdirSync(projectedRoot, { recursive: true });
    const rpc = {
      call: vi.fn(async (method: string) => method === 'skills/list'
        ? {
            data: [{
              skills: [{ name: 'skill-creator', enabled: true, path: systemPath }],
              errors: [{ path: projectedPath, message: 'invalid projected Skill' }],
            }],
          }
        : {}),
    };

    await expect(configureCodexSkillExtraRoots(
      rpc,
      workspace,
      1_234,
      [projectedRoot],
      [{ name: 'skill-creator', path: projectedPath }],
    )).resolves.toEqual({
      extraRoots: [projectedRoot],
      loadedSkillNames: [],
    });
  });

  it('skips Codex skill extra roots when project .claude/skills is absent', async () => {
    const workspace = tempWorkspace();
    const rpc = { call: vi.fn().mockResolvedValue({}) };

    await expect(configureCodexSkillExtraRoots(rpc, workspace)).resolves.toEqual({
      extraRoots: [],
      loadedSkillNames: [],
    });

    expect(existsSync(join(workspace, '.claude', 'skills'))).toBe(false);
    expect(resolveCodexSkillExtraRoots(workspace)).toEqual([]);
    expect(rpc.call).not.toHaveBeenCalled();
  });

  it('does not fail Codex startup when managed extraRoots RPC is unavailable', async () => {
    const workspace = tempWorkspace();
    const projectSkillsDir = join(workspace, '.claude', 'skills');
    mkdirSync(projectSkillsDir, { recursive: true });
    const rpc = {
      call: vi.fn().mockRejectedValue(new Error('Method not found: skills/extraRoots/set')),
    };

    await expect(configureCodexSkillExtraRoots(
      rpc,
      workspace,
      5_000,
      [projectSkillsDir],
      [{ name: 'review-helper', path: join(projectSkillsDir, 'review-helper', 'SKILL.md') }],
    )).resolves.toEqual({ extraRoots: [], loadedSkillNames: [] });

    expect(rpc.call).toHaveBeenCalledWith(
      'skills/extraRoots/set',
      { extraRoots: [projectSkillsDir] },
      5000,
    );
  });

  it('passes cwd, approvalPolicy, sandboxPolicy, model, and summary to turn/start', () => {
    expect(buildCodexSandboxPolicy('danger-full-access', '/tmp/ws')).toEqual({ type: 'dangerFullAccess' });
    expect(buildCodexTurnStartParams({
      threadId: 'thread-1',
      input: [{ type: 'text', text: 'hi' }],
      cwd: '/tmp/ws',
      approvalPolicy: 'never',
      sandbox: 'danger-full-access',
      model: 'gpt-5.2-codex',
      clientUserMessageId: 'user-1',
    })).toEqual({
      threadId: 'thread-1',
      input: [{ type: 'text', text: 'hi' }],
      cwd: '/tmp/ws',
      approvalPolicy: 'never',
      sandboxPolicy: { type: 'dangerFullAccess' },
      model: 'gpt-5.2-codex',
      summary: 'concise',
      clientUserMessageId: 'user-1',
    });
  });

  it('resolves a stable before-turn boundary without persisting a previous-turn pointer', () => {
    const turns = [
      { id: 'turn-1', status: 'completed' },
      { id: 'turn-2', status: 'completed' },
    ];
    expect(resolveCodexConversationBranchPoint(turns, 'turn-1')).toEqual({ kind: 'fresh-thread' });
    expect(resolveCodexConversationBranchPoint(turns, 'turn-2')).toEqual({
      kind: 'through-turn',
      runtimeTurnId: 'turn-1',
    });
    expect(() => resolveCodexConversationBranchPoint(turns, 'missing')).toThrow(/anchor/i);
    expect(() => resolveCodexConversationBranchPoint([
      ...turns,
      { id: 'turn-2', status: 'completed' },
    ], 'turn-2')).toThrow(/anchor/i);
    expect(() => resolveCodexConversationBranchPoint([
      { id: 'turn-1', status: 'failed' },
    ], 'turn-1')).toThrow(/not completed/i);
    expect(() => resolveCodexConversationBranchPoint([
      { id: 'turn-1', status: 'failed' },
      { id: 'turn-2', status: 'completed' },
    ], 'turn-2')).toThrow(/previous/i);
    expect(() => resolveCodexConversationBranchPoint(undefined, 'turn-1')).toThrow(/full turn history/i);
  });

  it('branches only through the stable v2 read/fork/unsubscribe RPCs', async () => {
    const runtime = new CodexRuntime();
    const rpc = {
      call: vi.fn(async (method: string) => {
        if (method === 'thread/read') {
          return {
            thread: {
              id: 'source-thread',
              turns: [
                { id: 'turn-1', status: 'completed' },
                { id: 'turn-2', status: 'completed' },
              ],
            },
          };
        }
        if (method === 'thread/fork') return { thread: { id: 'fork-thread' } };
        if (method === 'thread/unsubscribe') return {};
        throw new Error(`unexpected RPC ${method}`);
      }),
    };
    const process = {
      exited: false,
      runtimeSource: 'managed-provider',
      version: '0.146.0',
      threadId: 'source-thread',
      rpc,
    } as unknown as import('../runtimes/types').RuntimeProcess;

    await expect(runtime.branchConversation(process, {
      kind: 'before-turn',
      runtimeTurnId: 'turn-2',
    })).resolves.toEqual({ kind: 'native-thread', runtimeSessionId: 'fork-thread' });
    expect(rpc.call.mock.calls).toEqual([
      ['thread/read', { threadId: 'source-thread', includeTurns: true }, 15_000],
      ['thread/fork', { threadId: 'source-thread', lastTurnId: 'turn-1' }, 15_000],
      ['thread/unsubscribe', { threadId: 'fork-thread' }, 10_000],
    ]);
  });

  it('represents the boundary before the first Codex turn without creating an empty thread', async () => {
    const runtime = new CodexRuntime();
    const rpc = {
      call: vi.fn(async () => ({
        thread: {
          id: 'source-thread',
          turns: [{ id: 'turn-1', status: 'completed' }],
        },
      })),
    };
    const process = {
      exited: false,
      runtimeSource: 'managed-provider',
      version: '0.146.0',
      threadId: 'source-thread',
      rpc,
    } as unknown as import('../runtimes/types').RuntimeProcess;

    await expect(runtime.branchConversation(process, {
      kind: 'before-turn',
      runtimeTurnId: 'turn-1',
    })).resolves.toEqual({ kind: 'fresh-thread' });
    expect(rpc.call).toHaveBeenCalledOnce();
    expect(rpc.call).toHaveBeenCalledWith(
      'thread/read',
      { threadId: 'source-thread', includeTurns: true },
      15_000,
    );
  });

  it.each([
    ['thread/read', { kind: 'before-turn', runtimeTurnId: 'turn-2' }],
    ['thread/fork', { kind: 'through-turn', runtimeTurnId: 'turn-1' }],
  ] as const)('classifies %s schema rejection as a Codex capability mismatch', async (rejectedMethod, boundary) => {
    const runtime = new CodexRuntime();
    const rpc = {
      call: vi.fn(async (method: string) => {
        if (method === rejectedMethod) {
          throw new Error('JSON-RPC error -32602: Invalid params: unknown field');
        }
        if (method === 'thread/read') {
          return {
            thread: {
              id: 'source-thread',
              turns: [
                { id: 'turn-1', status: 'completed' },
                { id: 'turn-2', status: 'completed' },
              ],
            },
          };
        }
        throw new Error(`unexpected RPC ${method}`);
      }),
    };
    const process = {
      exited: false,
      runtimeSource: 'managed-provider',
      version: '0.146.0',
      threadId: 'source-thread',
      rpc,
    } as unknown as import('../runtimes/types').RuntimeProcess;

    await expect(runtime.branchConversation(process, boundary)).rejects.toMatchObject({
      code: 'capability_unavailable',
    });
  });

  it.each([
    ['JSON-RPC error -32601: Method not found', 'capability_unavailable'],
    ['no rollout found for thread', 'anchor_unavailable'],
  ] as const)('normalizes thread/read failure %s', async (failure, expectedCode) => {
    const runtime = new CodexRuntime();
    const process = {
      exited: false,
      runtimeSource: 'managed-provider',
      version: '0.146.0',
      threadId: 'source-thread',
      rpc: { call: vi.fn(async () => { throw new Error(failure); }) },
    } as unknown as import('../runtimes/types').RuntimeProcess;

    await expect(runtime.branchConversation(process, {
      kind: 'before-turn',
      runtimeTurnId: 'turn-2',
    })).rejects.toMatchObject({ code: expectedCode });
  });

  it('normalizes a rejected previous turn boundary as an unavailable anchor', async () => {
    const runtime = new CodexRuntime();
    const process = {
      exited: false,
      runtimeSource: 'managed-provider',
      version: '0.146.0',
      threadId: 'source-thread',
      rpc: {
        call: vi.fn(async (method: string) => {
          if (method === 'thread/fork') throw new Error('unknown turn turn-1');
          throw new Error(`unexpected RPC ${method}`);
        }),
      },
    } as unknown as import('../runtimes/types').RuntimeProcess;

    await expect(runtime.branchConversation(process, {
      kind: 'through-turn',
      runtimeTurnId: 'turn-1',
    })).rejects.toMatchObject({ code: 'anchor_unavailable' });
  });

  it('terminates the source connection when the fork subscription cannot be released', async () => {
    const runtime = new CodexRuntime();
    const rpc = {
      call: vi.fn(async (method: string) => {
        if (method === 'thread/fork') return { thread: { id: 'fork-thread' } };
        if (method === 'thread/unsubscribe') throw new Error('unsubscribe unavailable');
        throw new Error(`unexpected RPC ${method}`);
      }),
    };
    const process = {
      exited: false,
      runtimeSource: 'managed-provider',
      version: '0.146.0',
      threadId: 'source-thread',
      rpc,
    } as unknown as import('../runtimes/types').RuntimeProcess;
    const stop = vi.spyOn(runtime, 'stopSession').mockImplementation(async (target) => {
      target.exited = true;
    });

    await expect(runtime.branchConversation(process, {
      kind: 'through-turn',
      runtimeTurnId: 'turn-1',
    })).resolves.toEqual({ kind: 'native-thread', runtimeSessionId: 'fork-thread' });
    expect(stop).toHaveBeenCalledWith(process);
  });

  // #324 — turn/start.effort: included only when the user picked a non-default
  // level; default/null OMITS the key (conservative shape older codex builds
  // also accept — an explicit null is "no override" per schema but adds noise).
  it('includes effort in turn/start only when set', () => {
    const base = {
      threadId: 'thread-1',
      input: [],
      cwd: '/tmp/ws',
      approvalPolicy: 'never' as const,
      sandbox: 'danger-full-access' as const,
      model: null,
    };
    expect(buildCodexTurnStartParams({ ...base, reasoningEffort: 'xhigh' }).effort).toBe('xhigh');
    expect('effort' in buildCodexTurnStartParams({ ...base, reasoningEffort: null })).toBe(false);
    expect('effort' in buildCodexTurnStartParams(base)).toBe(false);
  });

  it('records Codex config changes as next-turn process state', async () => {
    const runtime = new CodexRuntime();
    const proc = {
      exited: false,
      model: 'gpt-5.1-codex',
      permissionMode: 'full-auto',
      approvalPolicy: 'never',
      sandbox: 'workspace-write',
      reasoningEffort: '',
      defaultPermissionMode: 'full-auto',
    } as unknown as import('../runtimes/types').RuntimeProcess;

    await runtime.setModel(proc, 'gpt-5.2-codex');
    await runtime.setPermissionMode(proc, 'no-restrictions');
    await runtime.setReasoningEffort(proc, 'xhigh');

    const state = proc as unknown as {
      model: string;
      permissionMode: string;
      approvalPolicy: 'never';
      sandbox: 'danger-full-access';
      reasoningEffort: string;
    };
    expect(state.model).toBe('gpt-5.2-codex');
    expect(state.permissionMode).toBe('no-restrictions');
    expect(state.approvalPolicy).toBe('never');
    expect(state.sandbox).toBe('danger-full-access');
    expect(buildCodexTurnStartParams({
      threadId: 'thread-1',
      input: [],
      cwd: '/tmp/ws',
      approvalPolicy: state.approvalPolicy,
      sandbox: state.sandbox,
      model: state.model,
      reasoningEffort: state.reasoningEffort,
    })).toMatchObject({
      model: 'gpt-5.2-codex',
      approvalPolicy: 'never',
      sandboxPolicy: { type: 'dangerFullAccess' },
      effort: 'xhigh',
    });
  });

  it('preserves Codex turn/completed status instead of treating interrupts as success', () => {
    expect(mapCodexTurnCompletedNotification({ status: 'completed' })).toEqual({
      kind: 'turn_complete',
      status: 'completed',
    });

    expect(mapCodexTurnCompletedNotification({ status: 'interrupted' })).toEqual({
      kind: 'turn_complete',
      status: 'interrupted',
      result: 'Turn ended with status interrupted',
    });

    expect(mapCodexTurnCompletedNotification({
      status: 'failed',
      error: { message: 'websocket failed' },
    })).toEqual({
      kind: 'turn_complete',
      status: 'failed',
      error: 'websocket failed',
      result: 'websocket failed',
    });
  });

  it('runs native Managed Codex compaction as a transcript-free control turn', async () => {
    const runtime = new CodexRuntime();
    const rpc = { call: vi.fn(async () => ({})) };
    const codexProc = {
      exited: false,
      runtimeSource: 'managed-provider',
      threadId: 'thread-1',
      currentTurnId: '',
      compactControl: null,
      activeRootTurnAdmission: null,
      exactUsageByTurn: new Map(),
      rpc,
    };
    const parseNotification = (method: string, params: unknown) => (
      runtime as unknown as {
        parseNotification(
          proc: typeof codexProc,
          notificationMethod: string,
          notificationParams: unknown,
          asyncEmit: () => void,
        ): unknown;
      }
    ).parseNotification(codexProc, method, params, () => {});

    const compact = runtime.compactContext(
      codexProc as unknown as import('../runtimes/types').RuntimeProcess,
    );
    await vi.waitFor(() => expect(rpc.call).toHaveBeenCalledWith(
      'thread/compact/start',
      { threadId: 'thread-1' },
      15_000,
    ));

    expect(parseNotification('turn/started', {
      threadId: 'thread-1',
      turn: { id: 'compact-turn', status: 'inProgress' },
    })).toBeNull();
    expect(codexProc.currentTurnId).toBe('compact-turn');
    expect(parseNotification('item/started', {
      threadId: 'thread-1',
      turnId: 'compact-turn',
      item: { type: 'contextCompaction', id: 'compact-item' },
    })).toBeNull();
    expect(parseNotification('turn/completed', {
      threadId: 'thread-1',
      turn: { id: 'compact-turn', status: 'completed', error: null },
    })).toBeNull();

    await expect(compact).resolves.toBeUndefined();
    expect(codexProc.compactControl).toBeNull();
    expect(codexProc.currentTurnId).toBe('');
  });

  it('keeps thread status snapshots separate from turn activity', () => {
    const runtime = new CodexRuntime();
    const codexProc = {
      threadId: 'thread-1',
      currentTurnId: null,
      deferredSubAgentEvents: new Map(),
      subThreadToCard: new Map(),
      subThreadToParent: new Map(),
      subThreadMeta: new Map(),
      collabControlToolParents: new Map(),
      activeSubAgentTurns: new Map(),
      completedSubAgentTurnsBeforeActivity: new Set(),
      subAgentThreadsAwaitingActivity: new Set(),
      codexV2SubAgentActivityObserved: false,
      codexV2InteractionDeliveryByCallId: new Map(),
      subAgentActivitySeenBeforeTurnStart: new Set(),
      subAgentInterruptsInFlight: new Map(),
      pendingMainTurnCompletion: null,
      interruptPendingSubAgentTurns: false,
      releaseHeldMainTurnOnExit: false,
    };
    const parseNotification = (method: string, params: unknown) => (
      runtime as unknown as {
        parseNotification(
          proc: typeof codexProc,
          notificationMethod: string,
          notificationParams: unknown,
          asyncEmit: () => void,
        ): unknown;
      }
    ).parseNotification(codexProc, method, params, () => {});

    // During thread resume Codex can report its pre-turn idle snapshot after
    // MyAgents has already accepted the query. It must not end that active turn.
    expect(parseNotification('thread/status/changed', {
      threadId: 'thread-1',
      status: { type: 'idle' },
    })).toBeNull();
    expect(parseNotification('thread/status/changed', {
      threadId: 'thread-1',
      status: { type: 'active' },
    })).toBeNull();

    expect(parseNotification('thread/status/changed', {
      threadId: 'thread-1',
      status: { type: 'systemError' },
    })).toEqual({ kind: 'status_change', state: 'error' });
    expect(parseNotification('turn/started', {
      threadId: 'thread-1',
      turn: { id: 'turn-2' },
    })).toEqual([
      { kind: 'turn_started' },
      { kind: 'status_change', state: 'running' },
      { kind: 'agent_plan_update', todos: [] },
    ]);
  });

  it('holds an early Codex terminal until the turn/start response binds the root user id', () => {
    const runtime = new CodexRuntime();
    const codexProc = {
      threadId: 'thread-1',
      currentTurnId: '',
      activeSteerTurnId: '',
      activeRootTurnAdmission: null,
      deferredSubAgentEvents: new Map(),
      subThreadToCard: new Map(),
      subThreadToParent: new Map(),
      subThreadMeta: new Map(),
      collabControlToolParents: new Map(),
      activeSubAgentTurns: new Map(),
      completedSubAgentTurnsBeforeActivity: new Set(),
      subAgentThreadsAwaitingActivity: new Set(),
      codexV2SubAgentActivityObserved: false,
      codexV2InteractionDeliveryByCallId: new Map(),
      subAgentActivitySeenBeforeTurnStart: new Set(),
      subAgentLifecycleByThread: new Map(),
      emittedSubAgentLifecycleByCard: new Map(),
      openedReasoningTracesByItem: new Map(),
      exactUsageByTurn: new Map(),
      subAgentInterruptsInFlight: new Map(),
      pendingMainTurnCompletion: null,
      interruptPendingSubAgentTurns: false,
      releaseHeldMainTurnOnExit: false,
    };
    const internals = runtime as unknown as {
      beginRootTurnAdmission(process: object, clientUserMessageId: string): void;
      completeRootTurnAdmission(
        process: object,
        runtimeTurnId: string,
        emit: (event: unknown) => void,
      ): unknown;
      parseNotification(
        process: object,
        method: string,
        params: unknown,
        emit: (event: unknown) => void,
      ): unknown;
    };
    const emitted: unknown[] = [];

    internals.beginRootTurnAdmission(codexProc, 'user-1');
    expect(internals.parseNotification(codexProc, 'turn/completed', {
      threadId: 'thread-1',
      turn: { id: 'turn-1', status: 'completed' },
    }, () => {})).toEqual([]);
    expect(emitted).toEqual([]);
    expect(codexProc.activeSteerTurnId).toBe('');

    internals.completeRootTurnAdmission(codexProc, 'turn-1', event => emitted.push(event));
    expect(codexProc.activeSteerTurnId).toBe('');
    expect(emitted).toEqual([
      { kind: 'root_turn_admitted', runtimeTurnId: 'turn-1', clientUserMessageId: 'user-1' },
      { kind: 'turn_complete', status: 'completed' },
      { kind: 'agent_plan_update', todos: [] },
    ]);
  });

  it('does not restore steerability when an early root terminal is held for a child tail', () => {
    const runtime = new CodexRuntime();
    const codexProc = {
      threadId: 'thread-1',
      currentTurnId: '',
      activeSteerTurnId: '',
      activeRootTurnAdmission: null,
      deferredSubAgentEvents: new Map(),
      subThreadToCard: new Map([['child-thread', 'spawn-call']]),
      subThreadToParent: new Map([['child-thread', 'thread-1']]),
      subThreadMeta: new Map(),
      collabControlToolParents: new Map(),
      activeSubAgentTurns: new Map([['child-thread', 'child-turn']]),
      completedSubAgentTurnsBeforeActivity: new Set(),
      subAgentThreadsAwaitingActivity: new Set(),
      codexV2SubAgentActivityObserved: false,
      codexV2InteractionDeliveryByCallId: new Map(),
      subAgentActivitySeenBeforeTurnStart: new Set(),
      subAgentLifecycleByThread: new Map(),
      emittedSubAgentLifecycleByCard: new Map(),
      openedReasoningTracesByItem: new Map(),
      exactUsageByTurn: new Map(),
      subAgentInterruptsInFlight: new Map(),
      pendingMainTurnCompletion: null,
      interruptPendingSubAgentTurns: false,
      releaseHeldMainTurnOnExit: false,
      exited: false,
    };
    const internals = runtime as unknown as {
      beginRootTurnAdmission(process: object, clientUserMessageId: string): void;
      completeRootTurnAdmission(
        process: object,
        runtimeTurnId: string,
        emit: (event: unknown) => void,
      ): unknown;
      parseNotification(
        process: object,
        method: string,
        params: unknown,
        emit: (event: unknown) => void,
      ): unknown;
    };

    internals.beginRootTurnAdmission(codexProc, 'user-1');
    expect(internals.parseNotification(codexProc, 'turn/completed', {
      threadId: 'thread-1',
      turn: { id: 'turn-1', status: 'completed' },
    }, () => {})).toBeNull();
    expect(codexProc.pendingMainTurnCompletion).not.toBeNull();

    internals.completeRootTurnAdmission(codexProc, 'turn-1', () => {});
    expect(codexProc.currentTurnId).toBe('turn-1');
    expect(codexProc.activeSteerTurnId).toBe('');
    expect(runtime.canSteerMessage?.(codexProc as never)).toBe(false);
  });

  it('classifies only Codex no-active steer rejection as safe to defer', () => {
    expect(isCodexNoActiveTurnSteerRejection(Object.assign(
      new Error('RPC error -32600: no active turn to steer'),
      { code: -32600 },
    ))).toBe(true);
    expect(isCodexNoActiveTurnSteerRejection(Object.assign(
      new Error('RPC error -32600: expected turn id mismatch'),
      { code: -32600 },
    ))).toBe(false);
    expect(isCodexNoActiveTurnSteerRejection(
      new Error('JSON-RPC call "turn/steer" timed out after 15000ms'),
    )).toBe(false);
  });

  it('revokes the stale steer target when Codex definitively rejects it as inactive', async () => {
    const runtime = new CodexRuntime();
    const rejection = Object.assign(
      new Error('RPC error -32600: no active turn to steer'),
      { code: -32600 },
    );
    const codexProc = {
      exited: false,
      threadId: 'thread-1',
      currentTurnId: 'turn-1',
      activeSteerTurnId: 'turn-1',
      rpc: { call: vi.fn(async () => { throw rejection; }) },
    };

    await expect(runtime.steerMessage(
      codexProc as unknown as import('../runtimes/types').RuntimeProcess,
      'next input',
    )).rejects.toBeInstanceOf(RuntimeSteerUnavailableError);
    expect(codexProc.activeSteerTurnId).toBe('');
    expect(codexProc.currentTurnId).toBe('turn-1');
  });

  it('terminates the Codex process when response and notification bind different root turns', () => {
    const runtime = new CodexRuntime();
    const codexProc = {
      exited: false,
      currentTurnId: '',
      activeRootTurnAdmission: {
        clientUserMessageId: 'user-1',
        notificationTurnId: 'turn-from-notification',
      },
    };
    const stop = vi.spyOn(runtime, 'stopSession').mockResolvedValue();
    const internals = runtime as unknown as {
      completeRootTurnAdmission(
        process: object,
        runtimeTurnId: string,
        emit: (event: unknown) => void,
      ): void;
    };

    expect(() => internals.completeRootTurnAdmission(
      codexProc,
      'turn-from-response',
      () => {},
    )).toThrow(/mismatch/i);
    expect(stop).toHaveBeenCalledWith(codexProc);
  });

  it('maps Codex turn/plan/updated into an AgentStatusPanel todo snapshot', () => {
    expect(mapCodexTurnPlanUpdatedNotification({
      plan: [
        { step: 'Inspect status flow', status: 'completed' },
        { step: 'Wire plan updates', status: 'inProgress' },
        { step: 'Run tests', status: 'pending' },
        { step: '   ', status: 'pending' },
      ],
    })).toEqual({
      kind: 'agent_plan_update',
      todos: [
        {
          key: 'codex-plan-0',
          content: 'Inspect status flow',
          activeForm: 'Inspect status flow',
          status: 'completed',
        },
        {
          key: 'codex-plan-1',
          content: 'Wire plan updates',
          activeForm: 'Wire plan updates',
          status: 'in_progress',
        },
        {
          key: 'codex-plan-2',
          content: 'Run tests',
          activeForm: 'Run tests',
          status: 'pending',
        },
      ],
    });
  });

  it('formats fileChange object kinds without leaking [object Object]', () => {
    expect(buildCodexFileChangeResultContent([
      {
        path: '/tmp/a.md',
        kind: { type: 'update', move_path: null },
        diff: '@@ -1 +1 @@\n-old\n+new',
      },
      {
        path: '/tmp/new.md',
        kind: { type: 'add' },
        diff: 'hello',
      },
    ])).toBe('update: /tmp/a.md\n@@ -1 +1 @@\n-old\n+new\n\nadd: /tmp/new.md\nhello');
    expect(buildCodexFileChangeResultContent([
      {
        path: '/tmp/old.md',
        kind: { type: 'move', move_path: '/tmp/new.md' },
      },
    ])).toBe('move: /tmp/old.md -> /tmp/new.md');
    expect(buildCodexFileChangeResultContent([])).toBe('File changed');
  });

  it('keeps started fileChange lightweight and promotes the completed patch as final input', () => {
    const startedChanges = [{
      path: '/workspace/a.ts',
      kind: { type: 'update', move_path: null },
      diff: '@@ -1 +1 @@\n-old started\n+new started',
    }];
    const completedChanges = [{
      path: '/workspace/a.ts',
      kind: { type: 'update', move_path: null },
      diff: '@@ -1 +1 @@\n-old applied\n+new applied',
    }];

    expect(buildCodexStartedFileChangeInput(startedChanges, '/workspace')).toEqual({
      file_path: '/workspace/a.ts',
      cwd: '/workspace',
    });
    expect(buildCodexCompletedFileChangeInput(completedChanges, '/workspace')).toEqual({
      file_path: '/workspace/a.ts',
      cwd: '/workspace',
      changes: completedChanges,
    });
  });

  it('ignores malformed fileChange entries before formatting result text', () => {
    expect(buildCodexFileChangeResultContent([
      null,
      'not-a-change',
      {
        path: '/tmp/old.md',
        kind: { type: 'move', move_path: '/tmp/new.md' },
      },
    ])).toBe('move: /tmp/old.md -> /tmp/new.md');

    expect(buildCodexFileChangeResultContent([null, 'not-a-change'])).toBe('File changed');
  });

  it('serializes command/file approvals with session scope when always allowed', () => {
    const pending: PendingCodexRequest = {
      kind: 'command_approval',
      rpcId: 7,
      method: 'item/commandExecution/requestApproval',
      params: { itemId: 'item-1' },
    };
    expect(serializeCodexPermissionResponse(pending, 'always_allow')).toEqual({
      type: 'result',
      result: { decision: 'acceptForSession' },
    });
    expect(serializeCodexPermissionResponse(pending, 'deny', undefined, true)).toEqual({
      type: 'result',
      result: { decision: 'cancel' },
    });
  });

  it('serializes Codex tool user input answers by native question id without comma-splitting free text', () => {
    const pending: PendingCodexRequest = {
      kind: 'tool_user_input',
      rpcId: 8,
      method: 'item/tool/requestUserInput',
      params: {
        questions: [
          { id: 'choice', question: 'Pick', options: [] },
          { id: 'notes', question: 'Notes', options: [] },
        ],
      },
    };

    expect(serializeCodexPermissionResponse(pending, 'allow_once', {
      answers: { choice: 'A,B', notes: 'custom text, with comma' },
    })).toEqual({
      type: 'result',
      result: {
        answers: {
          choice: { answers: ['A,B'] },
          notes: { answers: ['custom text, with comma'] },
        },
      },
    });
  });

  it('serializes unsupported Codex structured input as non-pending denial results', () => {
    const toolInput: PendingCodexRequest = {
      kind: 'tool_user_input',
      rpcId: 8,
      method: 'item/tool/requestUserInput',
      params: { questions: [{ id: 'choice', question: 'Pick', options: ['A', 'B'] }] },
    };
    expect(serializeCodexPermissionResponse(toolInput, 'deny', undefined, true)).toEqual({
      type: 'result',
      result: { answers: {} },
    });

    const form: PendingCodexRequest = {
      kind: 'mcp_elicitation',
      rpcId: 9,
      method: 'mcpServer/elicitation/request',
      params: {
        mode: 'form',
        requestedSchema: {
          properties: { token: { type: 'string', format: 'password' } },
          required: ['token'],
        },
      },
    };
    expect(serializeCodexPermissionResponse(form, 'deny', undefined, true)).toEqual({
      type: 'result',
      result: { action: 'cancel', content: null, _meta: null },
    });
  });

  it('does not track managed Codex request_user_input as pending even on native-card channels', () => {
    const runtime = new CodexRuntime();
    const pendingRequests = new Map<string, PendingCodexRequest>();
    const respond = vi.fn();
    const respondError = vi.fn();
    const codexProc = {
      pendingRequests,
      scenario: {
        type: 'agent-channel',
        platform: 'feishu',
        sourceType: 'private',
        hostInteraction: { askUserQuestion: 'native-card' },
      },
      runtimeSource: 'managed-provider',
      rpc: { respond, respondError },
    };
    const onEvent = vi.fn();

    (runtime as unknown as {
      handleServerRequest(
        proc: typeof codexProc,
        rpcId: number,
        method: string,
        params: unknown,
        onEvent: (event: unknown) => void,
      ): void;
    }).handleServerRequest(
      codexProc,
      24,
      'item/tool/requestUserInput',
      { questions: [{ id: 'choice', question: 'Pick', options: ['A', 'B'] }] },
      onEvent,
    );

    expect(pendingRequests.size).toBe(0);
    expect(onEvent).not.toHaveBeenCalled();
    expect(respond).toHaveBeenCalledWith(24, { answers: {} });
    expect(respondError).not.toHaveBeenCalled();
  });

  it('does not track unsupported channel MCP form elicitation as pending', () => {
    const runtime = new CodexRuntime();
    const pendingRequests = new Map<string, PendingCodexRequest>();
    const respond = vi.fn();
    const respondError = vi.fn();
    const codexProc = {
      pendingRequests,
      scenario: { type: 'im', hostInteraction: { askUserQuestion: 'none' } },
      rpc: { respond, respondError },
    };
    const onEvent = vi.fn();

    (runtime as unknown as {
      handleServerRequest(
        proc: typeof codexProc,
        rpcId: number,
        method: string,
        params: unknown,
        onEvent: (event: unknown) => void,
      ): void;
    }).handleServerRequest(
      codexProc,
      42,
      'mcpServer/elicitation/request',
      {
        mode: 'form',
        requestedSchema: {
          properties: { token: { type: 'string', format: 'password' } },
          required: ['token'],
        },
      },
      onEvent,
    );

    expect(pendingRequests.size).toBe(0);
    expect(onEvent).not.toHaveBeenCalled();
    expect(respond).toHaveBeenCalledWith(42, { action: 'cancel', content: null, _meta: null });
    expect(respondError).not.toHaveBeenCalled();
  });

  it('serializes MCP elicitations and permission profile requests', () => {
    const elicitation: PendingCodexRequest = {
      kind: 'mcp_elicitation',
      rpcId: 9,
      method: 'mcpServer/elicitation/request',
      params: {
        mode: 'form',
        requestedSchema: {
          properties: {
            branch: { type: 'string' },
            publish: { type: 'boolean', default: false },
            optionalNote: { type: 'string' },
          },
          required: ['branch'],
        },
      },
    };
    expect(serializeCodexPermissionResponse(elicitation, 'allow_once', {
      answers: { branch: 'main', publish: 'true' },
    })).toEqual({
      type: 'result',
      result: {
        action: 'accept',
        content: { branch: 'main', publish: true },
        _meta: null,
      },
    });
    expect(serializeCodexPermissionResponse(elicitation, 'allow_once', {
      answers: { publish: 'true' },
    })).toEqual({
      type: 'error',
      code: -32000,
      message: 'Missing required MCP elicitation answers',
    });

    expect(serializeCodexPermissionResponse({
      ...elicitation,
      params: {
        ...elicitation.params,
        mode: 'openai/form',
      },
    }, 'allow_once', {
      answers: { branch: 'dev/0.2.44' },
    })).toEqual({
      type: 'result',
      result: {
        action: 'accept',
        content: { branch: 'dev/0.2.44', publish: false },
        _meta: null,
      },
    });

    const permissions: PendingCodexRequest = {
      kind: 'permissions_approval',
      rpcId: 10,
      method: 'item/permissions/requestApproval',
      params: {
        permissions: {
          network: { enabled: true },
          fileSystem: null,
        },
      },
    };
    expect(serializeCodexPermissionResponse(permissions, 'always_allow')).toEqual({
      type: 'result',
      result: {
        permissions: { network: { enabled: true } },
        scope: 'session',
      },
    });
    expect(serializeCodexPermissionResponse(permissions, 'deny')).toMatchObject({
      type: 'error',
      code: -32000,
    });
  });
});

// Old Session definitions may bypass the current preset catalogue.
it('omits retired bundled Cuse from Codex launch while retaining custom Cuse', () => {
  const projection = projectManagedCodexMcpLaunchConfig([
    { id: 'legacy-cuse', name: 'Legacy', isBuiltin: true, type: 'stdio', command: '__bundled_cuse__' },
    { id: 'cuse', name: 'Custom', isBuiltin: false, type: 'stdio', command: 'cuse', args: ['mcp'] },
  ], {});
  expect(projection.acceptedServerIds).toEqual(['cuse']);
  expect(projection.failures).toEqual([]);
  expect(projection.args.join(' ')).not.toContain('__bundled_cuse__');
  expect(projection.serverNames).toHaveLength(1);
});

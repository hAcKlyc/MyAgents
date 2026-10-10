import { GENERATED_PROTOCOL_VERSION } from '../../../../contracts/myagents-dsh/public-contract.generated';
import { createServer } from "node:http";
import { createServer as createHttpsServer } from "node:https";
import { execFileSync } from "node:child_process";
import { connect, type Socket } from "node:net";
import type { Duplex } from "node:stream";
import { DshAttachmentRegistry } from "./attachments";
import { INTERNAL_CLI_TOKEN_HEADER } from '../../../shared/externalCliCapabilities';
import type { PermissionReview } from "../../../shared/types/runtime";
import { buildDshChildEnvironment } from "./child-environment";
import type { MethodParams } from "./protocol-types";
import { createHash, randomUUID } from "node:crypto";
import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { describe, expect, it } from "vitest";

import { PRESET_PROVIDERS, type Provider } from "../../../shared/config-types";
import { compileDshProductExtensionPlane } from "./extension-compiler";
import { resolveDshMcpCredential } from './extension-host';
import { createDshInitializeParams } from "./initialize";
import { resolveDshRuntimeInstallation } from "./installation";
import { compileDshModelExecutionProfile } from "./profile-compiler";
import { DSH_CANONICAL_WEB_ADAPTER_ID } from "./canonical-web-provider";
import { DshRuntimeProcessHost, redactDshDiagnosticLine } from "./process-host";
import { DshMutationController } from './mutations';
import { buildDshQuestionAnswer } from './interaction-response';
import { buildDshTurnProjectionSnapshot } from '../../session-engine/dsh-turn-reconciliation';
import {
  DSH_REVERSE_METHOD_NAMES,
  type DshExecutionEnvironment,
  type DshHostRequestHandlers,
  type DshRuntimeNotificationHandlers,
} from "./protocol-types";

const nativeSmokeEnabled = process.env.MYAGENTS_DSH_NATIVE_SMOKE === "1";
const nativeSmokeResourceRoot =
  process.env.MYAGENTS_DSH_NATIVE_SMOKE_RESOURCE_ROOT;
const nativeSoakEnabled = process.env.MYAGENTS_DSH_NATIVE_SOAK === "1";

function requestedNativeSoakIterations(): number {
  const raw = process.env.MYAGENTS_DSH_NATIVE_SOAK_ITERATIONS ?? "12";
  if (!/^\d+$/.test(raw)) {
    throw new Error(
      "MYAGENTS_DSH_NATIVE_SOAK_ITERATIONS must be an integer from 1 to 50",
    );
  }
  const iterations = Number(raw);
  if (iterations < 1 || iterations > 50) {
    throw new Error(
      "MYAGENTS_DSH_NATIVE_SOAK_ITERATIONS must be an integer from 1 to 50",
    );
  }
  return iterations;
}

function processIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ESRCH") return false;
    throw error;
  }
}

async function currentOpenFileDescriptorCount(): Promise<number | undefined> {
  if (process.platform === "win32") return undefined;
  return (await readdir("/dev/fd")).length;
}

async function createNativeHostFixture(
  label: string,
  route?: { productSessionId: string; sidecarPort: number },
  proxyEnvironment?: Readonly<NodeJS.ProcessEnv>,
  testCertificateAuthority?: string,
) {
  const temporaryRoot = await realpath(
    await mkdtemp(join(tmpdir(), `myagents-dsh-process-host-${label}-`)),
  );
  const workspace = join(temporaryRoot, "workspace");
  const runtimeHome = join(temporaryRoot, "runtime-home");
  const attachments = join(temporaryRoot, "attachments");
  await Promise.all([mkdir(workspace), mkdir(runtimeHome), mkdir(attachments)]);
  const resourceRoot = resolve(
    nativeSmokeResourceRoot ?? "src-tauri/resources",
  );
  const installation = await resolveDshRuntimeInstallation({
    resourceRoot,
    nodeExecutablePath: join(resourceRoot, "nodejs/bin/node"),
  });
  const launchEnvironment = buildDshChildEnvironment({
    nodeExecutablePath: installation.nodeExecutablePath, commandDirectories: ["/bin", "/usr/bin"],
    inheritedEnvironment: { HOME: temporaryRoot, USERPROFILE: temporaryRoot, LANG: 'en_US.UTF-8' },
    proxyEnvironment,
    sessionCli: route === undefined ? null : { ...route, internalCliToken: 'fixture-capability' },
  });
  // A generated local test CA is trusted only by this synthetic child process.
  const childEnvironment = testCertificateAuthority === undefined ? launchEnvironment : {
    ...launchEnvironment,
    env: { ...launchEnvironment.env, NODE_EXTRA_CA_CERTS: testCertificateAuthority },
    allowedKeys: [...launchEnvironment.allowedKeys, 'NODE_EXTRA_CA_CERTS'],
  };
  const executionEnvironment: Omit<DshExecutionEnvironment, "digest"> = {
    revision: "native-smoke-execution-v1",
    workspace: {
      identity: `native-${label}-workspace`,
      canonicalRoot: workspace,
    },
    executables: {
      bundledNodeRef: "bundled-node",
      shellRef: "runtime-shell",
      ripgrepRef: "bundled-ripgrep",
      shellDialect: "bash",
      allowedCommandRefs: ["runtime-shell", "bundled-node", "bundled-ripgrep"],
      pathPolicy: "sealed",
    },
    environment: {
      allowedKeys: childEnvironment.allowedKeys,
      inheritedKeys: [],
      secretValues: "reverse-port-only",
    },
    network: { mode: "deny" },
    process: {
      backgroundRetention: "deny",
      maxChildren: 8,
      killTreeOnAbort: true,
    },
    checkpoint: {
      mode: "managed-file-tools",
      version: 1,
      policyRevision: "native-smoke-checkpoint-v1",
      trackedTools: ["Write", "Edit"],
      tracksShell: false,
      tracksChildAgents: false,
      tracksExternalChanges: false,
    },
    attachmentStagingRoot: attachments,
  };
  const hostHandlers = Object.fromEntries(
    DSH_REVERSE_METHOD_NAMES.map((method) => [
      method,
      async (params: Record<string, unknown>) => {
        if (method === "host/credential/resolve") {
          return {
            kind: "availability",
            available: true,
            authoritativeCredentialRevision: String(params.profileRevision),
          };
        }
        throw new Error("Native smoke does not admit reverse work");
      },
    ]),
  ) as unknown as DshHostRequestHandlers;
  const notificationHandlers: DshRuntimeNotificationHandlers = {
    "runtime/event": async () => undefined,
    "host/interaction/cancel": async () => undefined,
  };
  const stderr: string[] = [];
  const createHost = (requests = hostHandlers, notifications = notificationHandlers) =>
    new DshRuntimeProcessHost({
      installation,
      initialize: createDshInitializeParams({
        productSessionId: route?.productSessionId ?? `native-${label}-product-session`,
        productVersion: "0.4.11",
        runtimeHome,
        workspace: {
          path: workspace,
          identity: `native-${label}-workspace`,
        },
        executionEnvironment,
        interaction: "deterministic-headless",
        webSearchAdapters: [DSH_CANONICAL_WEB_ADAPTER_ID],
      }),
      hostHandlers: requests,
      notificationHandlers: notifications,
      childEnvironment,
      handshakeTimeoutMs: 60_000,
      shutdownGraceMs: 10_000,
      onStderrLine: (line) => stderr.push(line),
      redactStderrLine: redactDshDiagnosticLine,
    });
  const host = createHost();
  return {
    createHost,
    hostHandlers,
    executionEnvironment,
    host,
    runtimeHome,
    stderr,
    temporaryRoot,
    workspace,
  };
}

describe.runIf(nativeSmokeEnabled)(
  "DSH RuntimeProcessHost native smoke",
  () => {
    it('applies a complete oversized Skill snapshot through an attachment before Session binding', async () => {
      const fixture = await createNativeHostFixture('large-extensions');
      const registry = new DshAttachmentRegistry(fixture.executionEnvironment.attachmentStagingRoot);
      await registry.initialize();
      const skills = [];
      for (let index = 0; index < 8; index++) {
        const content = `---\nname: large-${index}\ndescription: Synthetic large Skill\n---\n${'中文\\\n'.repeat(20_000)}`;
        const path = join(fixture.workspace, `large-${index}.md`);
        await writeFile(path, content);
        skills.push({ name: `large-${index}`, description: 'Synthetic large Skill', path,
          contentSha256: createHash('sha256').update(content).digest('hex'), scope: 'user' as const, sourceId: 'fixture' });
      }
      const plane = compileDshProductExtensionPlane({ revision: 'large-extensions', workspacePath: fixture.workspace,
        skills, commands: [], agents: [], mcpServers: [], dynamicTools: [] });
      const reference = await registry.publishJson(plane.snapshot);
      expect(reference.sizeBytes).toBeGreaterThan(1_048_576);
      let releases = 0;
      const host = fixture.createHost({ ...fixture.hostHandlers,
        'host/attachment/acquire': params => registry.acquire(params),
        'host/attachment/release': params => { releases++; registry.release(params); return { ok: true }; },
      });
      try {
        await host.start();
        expect(await host.request('extension/replace', { snapshotAttachment: reference })).toMatchObject({
          state: 'applied', effectiveRevision: plane.snapshot.revision,
          components: skills.map(skill => ({ key: `skill:${skill.name}`, state: 'ready' })),
        });
        expect((await host.request('extension/catalog', {})).skills.map(skill => skill.name)).toEqual(skills.map(skill => skill.name));
        expect(releases).toBe(1);
      } finally {
        await host.stop();
        await rm(fixture.temporaryRoot, { recursive: true, force: true });
      }
    }, 60_000);

    it('preflights credential-free stdio MCP through the real credential reverse port', async () => {
      const fixture = await createNativeHostFixture('mcp-preflight');
      const script = join(fixture.workspace, 'mcp.cjs');
      await writeFile(script, `const readline = require('node:readline');
readline.createInterface({ input: process.stdin }).on('line', line => {
  const request = JSON.parse(line);
  if (!Object.hasOwn(request, 'id')) return;
  const result = request.method === 'initialize'
    ? { protocolVersion: request.params.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: 'fixture', version: '1' } }
    : request.method === 'tools/list' ? { tools: [{ name: 'ping', description: 'Synthetic ping', inputSchema: { type: 'object', properties: {} } }] } : {};
  process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: request.id, result }) + '\\n');
});`);
      const plane = compileDshProductExtensionPlane({
        revision: 'mcp-regression', workspacePath: fixture.workspace,
        skills: [], commands: [], agents: [], dynamicTools: [],
        mcpServers: [{ id: 'fixture', name: 'Fixture', type: 'stdio', command: process.execPath, args: [script], isBuiltin: false }],
      });
      const requests: unknown[] = [];
      const host = fixture.createHost({ ...fixture.hostHandlers,
        'host/credential/resolve': params => {
          requests.push(params);
          return resolveDshMcpCredential({ plane, extensionDigest: plane.snapshot.digest, params });
        },
      });
      try {
        await host.start();
        const result = await host.request('extension/replace', plane.snapshot);
        expect({ result, requests, stderr: fixture.stderr }).toMatchObject({
          result: { state: 'applied', components: [{ key: 'mcp:fixture', state: 'ready' }] },
          requests: [expect.objectContaining({ subject: 'mcp', purpose: 'availability' }), expect.objectContaining({ subject: 'mcp', purpose: 'connection' })],
        });
        expect((await host.request('extension/catalog', {})).tools).toContain('mcp__fixture__ping');
      } finally {
        await host.stop();
        await rm(fixture.temporaryRoot, { recursive: true, force: true });
      }
    }, 60_000);

    it('consumes realtime followUp at the next model boundary inside the native root turn', async () => {
      const fixture = await createNativeHostFixture('realtime-inbox');
      const events: Record<string, unknown>[] = [];
      const modelInputs: string[] = [];
      let releaseFirst!: () => void;
      const firstGate = new Promise<void>(resolve => { releaseFirst = resolve; });
      const server = createServer(async (request, response) => {
        const chunks: Buffer[] = [];
        for await (const chunk of request) chunks.push(Buffer.from(chunk));
        modelInputs.push(Buffer.concat(chunks).toString());
        const first = modelInputs.length === 1;
        if (first) await firstGate;
        const emit = (name: string, data: unknown) => response.write(`event: ${name}\ndata: ${JSON.stringify(data)}\n\n`);
        response.writeHead(200, { 'content-type': 'text/event-stream' });
        emit('message_start', { type: 'message_start', message: { id: `realtime-${modelInputs.length}`, type: 'message', role: 'assistant', model: 'claude-sonnet-4-6', content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 10, output_tokens: 0 } } });
        emit('content_block_start', { type: 'content_block_start', index: 0, content_block: first
          ? { type: 'tool_use', id: 'read-fixture', name: 'read', input: {} } : { type: 'text', text: '' } });
        emit('content_block_delta', { type: 'content_block_delta', index: 0, delta: first
          ? { type: 'input_json_delta', partial_json: JSON.stringify({ file_path: 'note.txt' }) }
          : { type: 'text_delta', text: 'Same native turn finished.' } });
        emit('content_block_stop', { type: 'content_block_stop', index: 0 });
        emit('message_delta', { type: 'message_delta', delta: { stop_reason: first ? 'tool_use' : 'end_turn', stop_sequence: null }, usage: { output_tokens: 10 } });
        emit('message_stop', { type: 'message_stop' });
        response.end();
      });
      await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
      const address = server.address();
      if (!address || typeof address === 'string') throw new Error('Fixture port missing');
      const host = fixture.createHost({ ...fixture.hostHandlers,
        'host/credential/resolve': params => params.purpose === 'availability'
          ? { kind: 'availability', available: true, authoritativeCredentialRevision: params.profileRevision }
          : { kind: 'material', authoritativeCredentialRevision: params.profileRevision, material: { apiKey: 'synthetic-realtime-key' } },
        'host/hook/execute': () => ({ state: 'continue' }),
      }, { 'runtime/event': params => { events.push(params); }, 'host/interaction/cancel': () => undefined });
      try {
        await writeFile(join(fixture.workspace, 'note.txt'), 'fixture');
        await host.start();
        const catalog = await host.request('extension/catalog', {});
        const provider = structuredClone(PRESET_PROVIDERS.find(({ id }) => id === 'anthropic-api'))!;
        provider.id = 'native-realtime-fixture'; provider.config.baseUrl = `http://127.0.0.1:${address.port}`;
        const profile = compileDshModelExecutionProfile({ provider, modelId: 'claude-sonnet-4-6' });
        await host.request('session/create', { clientOperationId: 'realtime-bind', persistenceRef: 'realtime-session', provider: profile,
          configRevision: 'realtime-config', extensionDigest: catalog.digest, systemPrompt: '', permissionMode: 'full-autonomous', interactionScenario: 'host-interaction-v1' });
        const digest = createDshInitializeParams({ productSessionId: 'native-realtime-inbox-product-session', productVersion: '0.4.25',
          runtimeHome: fixture.runtimeHome, workspace: { path: fixture.workspace, identity: fixture.executionEnvironment.workspace.identity },
          executionEnvironment: fixture.executionEnvironment, interaction: 'deterministic-headless' }).executionEnvironment.digest;
        await host.request('turn/start', { clientOperationId: 'root-A', clientUserMessageId: 'A', input: { parts: [{ kind: 'text', text: 'Read note.txt' }] },
          configRevision: 'realtime-config', extensionDigest: catalog.digest, executionEnvironmentRevision: fixture.executionEnvironment.revision,
          executionEnvironmentDigest: digest, limits: { maxTurns: 3 }, origin: { kind: 'headless', scenario: 'realtime-inbox' } });
        await expect.poll(() => modelInputs.length, { timeout: 20_000 }).toBe(1);
        await host.request('turn/followUp', { clientOperationId: 'root-A', messageId: 'Inbox-C',
          input: { parts: [{ kind: 'text', text: 'INBOX_REALTIME_MARKER' }] }, delivery: 'realtime' });
        expect(modelInputs[0]).not.toContain('INBOX_REALTIME_MARKER');
        releaseFirst();
        await expect.poll(async () => (await host.request('turn/get', { clientOperationId: 'root-A' })).terminal?.kind, { timeout: 20_000 }).toBe('succeeded');
        expect(modelInputs).toHaveLength(2);
        expect(modelInputs[1]).toContain('INBOX_REALTIME_MARKER');
        const rootTurn = (await host.request('turn/get', { clientOperationId: 'root-A' })).admission?.turnId;
        expect(events).toContainEqual(expect.objectContaining({ turnId: rootTurn,
          event: expect.objectContaining({ kind: 'queued_message', messageId: 'Inbox-C', state: 'delivered' }) }));
      } finally {
        releaseFirst();
        await host.stop();
        server.closeAllConnections();
        await new Promise<void>(resolve => server.close(() => resolve()));
        await rm(fixture.temporaryRoot, { recursive: true, force: true });
      }
    }, 60_000);

    it.runIf(process.platform === 'darwin')('routes packed HTTPS model requests by current Provider policy', async () => {
      const certificateRoot = await mkdtemp(join(tmpdir(), 'myagents-dsh-tls-'));
      const certificate = join(certificateRoot, 'certificate.pem');
      const key = join(certificateRoot, 'key.pem');
      const proxies: ReturnType<typeof createServer>[] = [];
      const sockets = new Set<Socket | Duplex>();
      const proxyReceipts: string[] = [];
      const targetReceipts: string[] = [];
      let fixture: Awaited<ReturnType<typeof createNativeHostFixture>> | undefined;
      let host: DshRuntimeProcessHost | undefined;
      let target: ReturnType<typeof createHttpsServer> | undefined;
      const listen = async (server: ReturnType<typeof createServer>) => {
        await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
        const address = server.address();
        if (!address || typeof address === 'string') throw new Error('TLS fixture did not bind');
        return address.port;
      };
      try {
        execFileSync('/usr/bin/openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '1',
          '-subj', '/CN=provider-route.test', '-addext', 'subjectAltName=DNS:provider-route.test',
          '-keyout', key, '-out', certificate], { stdio: 'ignore' });
        target = createHttpsServer({ key: await readFile(key), cert: await readFile(certificate) }, async (request, response) => {
          for await (const chunk of request) void chunk;
          targetReceipts.push(request.url ?? '');
          const emit = (event: string, data: unknown) => response.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
          response.writeHead(200, { 'content-type': 'text/event-stream' });
          emit('message_start', { type: 'message_start', message: { id: `tls-${targetReceipts.length}`, type: 'message', role: 'assistant', model: 'claude-sonnet-4-6', content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 10, output_tokens: 0 } } });
          emit('content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } });
          emit('content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'TLS fixture complete.' } });
          emit('content_block_stop', { type: 'content_block_stop', index: 0 });
          emit('message_delta', { type: 'message_delta', delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { output_tokens: 10 } });
          emit('message_stop', { type: 'message_stop' });
          response.end();
        });
        const targetPort = await listen(target);
        const proxy = async (name: string) => {
          const server = createServer((_request, response) => { response.writeHead(502); response.end(); });
          proxies.push(server);
          server.on('connect', (request, downstream, head) => {
            if (request.url !== `provider-route.test:${targetPort}`) { downstream.destroy(); return; }
            proxyReceipts.push(name);
            const upstream = connect({ host: '127.0.0.1', port: targetPort });
            for (const socket of [downstream, upstream]) {
              sockets.add(socket);
              socket.on('close', () => sockets.delete(socket));
              socket.on('error', () => { downstream.destroy(); upstream.destroy(); });
            }
            upstream.once('connect', () => {
              downstream.write('HTTP/1.1 200 Connection Established\r\n\r\n');
              if (head.length) upstream.write(head);
              downstream.pipe(upstream); upstream.pipe(downstream);
            });
          });
          return `http://127.0.0.1:${await listen(server)}`;
        };
        const general = await proxy('general');
        const providerA = await proxy('provider-a');
        const providerB = await proxy('provider-b');
        let currentProxy = providerA;
        fixture = await createNativeHostFixture('tls-provider', undefined,
          { HTTP_PROXY: general, HTTPS_PROXY: general, NO_PROXY: '' }, certificate);
        host = fixture.createHost({ ...fixture.hostHandlers,
          'host/credential/resolve': params => params.purpose === 'availability'
            ? { kind: 'availability', available: true, authoritativeCredentialRevision: params.profileRevision }
            : { kind: 'material', authoritativeCredentialRevision: params.profileRevision,
              material: { apiKey: 'synthetic-tls-model-key' }, providerNetwork: { httpsProxy: currentProxy, noProxy: '' } },
        });
        await host.start();
        const catalog = await host.request('extension/catalog', {});
        const provider = structuredClone(PRESET_PROVIDERS.find(({ id }) => id === 'anthropic-api'));
        if (!provider) throw new Error('Fixture Provider is missing');
        provider.id = 'native-anthropic-fixture';
        provider.config.baseUrl = `https://provider-route.test:${targetPort}`;
        const profile = compileDshModelExecutionProfile({ provider, modelId: 'claude-sonnet-4-6' });
        await host.request('session/create', { clientOperationId: 'tls-bind', persistenceRef: 'tls-session', provider: profile,
          configRevision: 'tls-config', extensionDigest: catalog.digest, systemPrompt: '', permissionMode: 'approval-required', interactionScenario: 'host-interaction-v1' });
        const environmentDigest = createDshInitializeParams({ productSessionId: 'native-tls-provider-product-session', productVersion: '0.4.15',
          runtimeHome: fixture.runtimeHome, workspace: { path: fixture.workspace, identity: fixture.executionEnvironment.workspace.identity },
          executionEnvironment: fixture.executionEnvironment, interaction: 'deterministic-headless' }).executionEnvironment.digest;
        for (const [index, selected] of [providerA, providerB].entries()) {
          currentProxy = selected;
          const clientOperationId = `tls-turn-${index}`;
          await host.request('turn/start', { clientOperationId, clientUserMessageId: `tls-input-${index}`, input: { parts: [{ kind: 'text', text: 'Return the synthetic TLS response.' }] },
            configRevision: 'tls-config', extensionDigest: catalog.digest, executionEnvironmentRevision: fixture.executionEnvironment.revision,
            executionEnvironmentDigest: environmentDigest, limits: { maxTurns: 1 }, origin: { kind: 'headless', scenario: 'native-tls-provider' } });
          const activeHost = host;
          await expect.poll(async () => (await activeHost.request('turn/get', { clientOperationId })).terminal?.kind, { timeout: 20_000 }).toBe('succeeded');
        }
        expect(targetReceipts).toEqual(['/v1/messages?beta=true', '/v1/messages?beta=true']);
        expect(proxyReceipts).toEqual(['provider-a', 'provider-b']);
      } finally {
        await host?.stop();
        for (const socket of sockets) socket.destroy();
        for (const server of [...proxies, ...(target ? [target] : [])]) {
          server.closeAllConnections();
          await new Promise<void>(resolve => server.close(() => resolve()));
        }
        if (fixture) await rm(fixture.temporaryRoot, { recursive: true, force: true });
        await rm(certificateRoot, { recursive: true, force: true });
      }
    }, 90_000);

    it.runIf(process.platform !== 'win32').each([false, true])('allows Action tools and routes child Shell approval after a shared grant (large review: %s)', async largeReview => {
      const productSessionId = randomUUID();
      const cliBundlePath = join(resolve(nativeSmokeResourceRoot ?? 'src-tauri/resources'), 'cli/myagents.cjs');
      const cliCommand = `node '${cliBundlePath.replaceAll("'", "'\\''")}' status --json`;
      const curl = '/usr/bin/curl -q -fsS --max-time 5';
      const command = 'printf "%s|%s" "$MYAGENTS_PORT" "$MYAGENTS_SESSION_ID"'
        + `; ${curl} http://dsh-shell-fixture.invalid/root`
        + `; ${curl} "http://127.0.0.1:$MYAGENTS_PORT/shell-loopback"`
        + (largeReview ? ` # ${"example".repeat(10_000)}` : "");
      const spillSizes = [64_000, 64_001, 81_000, 1_053_000];
      const calls = [
        { id: 'fixture-shell-call', name: 'bash', input: { command, workdir: 'child', description: 'Read the current CLI route' } },
        { id: 'fixture-internal-cli-call', name: 'bash', input: { command: cliCommand, workdir: 'child', description: 'Call the bundled internal CLI' } },
        ...spillSizes.map(size => ({ id: `fixture-spill-${size}`, name: 'bash', input: {
          command: `node -e 'process.stdout.write("x".repeat(${size})); process.stderr.write("\\nspill-tail-marker\\n"); process.exitCode=7'`,
          workdir: 'child', description: 'Verify real foreground output retention',
        } })),
        { id: 'fixture-spill-read', name: 'read', input: { file_path: '', offset: 1, limit: 1 } },
        { id: 'fixture-file-write', name: 'write', input: { file_path: 'native-file-tools/note.txt', content: 'alpha\r\nbeta\r\n' } },
        { id: 'fixture-file-read', name: 'read', input: { file_path: 'native-file-tools/note.txt' } },
        { id: 'fixture-file-edit', name: 'edit', input: { file_path: 'native-file-tools/note.txt', old_string: 'alpha\nbeta', new_string: 'ALPHA\nBETA' } },
        { id: 'fixture-file-glob', name: 'glob', input: { pattern: '*.txt', path: 'native-file-tools' } },
        { id: 'fixture-file-grep', name: 'grep', input: { pattern: 'ALPHA', path: 'native-file-tools' } },
        { id: 'fixture-large-read', name: 'read', input: { file_path: 'native-large.txt', limit: 1 } },
        { id: 'fixture-image-read', name: 'read_image', input: { file_path: 'native-pixel.png' } },
        { id: 'fixture-create-call', name: 'TaskCreate', input: { subject: 'Verify approval progress', description: 'Synthetic native regression' } },
        { id: 'fixture-update-call', name: 'TaskUpdate', input: { taskId: 'task-1', status: 'completed' } },
        { id: 'fixture-skill-call', name: 'Skill', input: { skill: 'permission-review' } },
        { id: 'fixture-agent-call', name: 'Agent', input: { subagent_type: 'permission-helper', description: 'Verify child approval', prompt: 'Return the synthetic fixture completion.', run_in_background: false } },
        { id: 'fixture-child-inherited-call', name: 'bash', input: { command: 'printf inherited-child', workdir: 'child', description: 'Verify the shared directory grant' } },
        { id: 'fixture-child-review-call', name: 'bash', input: { command: `printf approved-child; ${curl} http://dsh-shell-fixture.invalid/child`, description: 'Verify child approval at another directory' } },
        undefined, // The foreground child completes before the root continues.
        { id: 'fixture-question-call', name: 'AskUserQuestion', input: { questions: [0, 1, 2].map(index => ({ header: `Step ${index}`, question: `Choose synthetic step ${index}`, options: [{ label: 'Continue', description: 'Complete the fixture' }, { label: 'Stop', description: 'Stop the fixture' }, { label: 'Review, then continue', description: 'Review first' }, { label: 'Later', description: 'Defer' }], multiSelect: index === 1 })) } },
        { id: 'fixture-enter-plan-call', name: 'EnterPlanMode', input: {} },
        { id: 'fixture-plan-write-call', name: 'write', input: { file_path: '', content: '# Synthetic plan\n\nVerify permission continuity.\n' } },
        { id: 'fixture-plan-shell-call', name: 'bash', input: { command: 'printf plan-shell-research', workdir: 'child', description: 'Inspect while Plan mode is active' } },
        { id: 'fixture-exit-plan-call', name: 'ExitPlanMode', input: {} },
      ];
      let requests = 0;
      let childSystemPrompt = '';
      let planSystemPrompt = '';
      let resumedRootInput = '';
      const proxyRequests: string[] = [];
      const cliReceipts: Array<{ token: string | undefined; authorization: string | undefined; sessionId: string | undefined }> = [];
      const childResults = new Map<string, { content?: unknown; is_error?: boolean }>();
      const modelToolResults = new Map<string, { content?: unknown; is_error?: boolean }>();
      const server = createServer(async (request, response) => {
        if (request.url === '/api/admin/status') {
          for await (const chunk of request) void chunk;
          const token = request.headers[INTERNAL_CLI_TOKEN_HEADER.toLowerCase()];
          const sessionId = request.headers['x-myagents-session-id'];
          cliReceipts.push({
            token: typeof token === 'string' ? token : undefined,
            authorization: request.headers.authorization,
            sessionId: typeof sessionId === 'string' ? sessionId : undefined,
          });
          response.writeHead(token === 'fixture-capability' ? 200 : 403, { 'content-type': 'application/json' });
          response.end(JSON.stringify(token === 'fixture-capability'
            ? { success: true, data: { source: 'internal-cli-fixture' } }
            : { success: false, error: 'internal capability required' }));
          return;
        }
        if (request.url?.startsWith('http://')) {
          proxyRequests.push(request.url);
          response.end('shell-proxy-ok');
          return;
        }
        if (request.url === '/shell-loopback') {
          response.end('shell-loopback-ok');
          return;
        }
        const chunks: Buffer[] = [];
        for await (const chunk of request) chunks.push(Buffer.from(chunk));
        const modelRequest = JSON.parse(Buffer.concat(chunks).toString('utf8')) as { messages: { content: unknown }[]; system?: unknown };
        for (const block of modelRequest.messages.flatMap(message => Array.isArray(message.content) ? message.content as { type: string; tool_use_id?: string; content?: unknown; is_error?: boolean }[] : [])) {
          if (block.type === 'tool_result' && block.tool_use_id) modelToolResults.set(block.tool_use_id, block);
          if (block.type === 'tool_result' && (block.tool_use_id === 'fixture-child-inherited-call' || block.tool_use_id === 'fixture-child-review-call')) childResults.set(block.tool_use_id, block);
        }
        const tool = calls[requests++];
        if (tool?.id === 'fixture-child-inherited-call') childSystemPrompt = JSON.stringify({ system: modelRequest.system, messages: modelRequest.messages });
        if (tool?.id === 'fixture-plan-shell-call') planSystemPrompt = JSON.stringify({ system: modelRequest.system, messages: modelRequest.messages });
        if (tool?.id === 'fixture-question-call') resumedRootInput = JSON.stringify(modelRequest.messages);
        let input: Record<string, unknown> | undefined = tool?.input;
        if (tool?.id === 'fixture-spill-read') {
          const content = modelToolResults.get('fixture-spill-64001')?.content;
          const text = typeof content === 'string' ? content : (content as { text: string }[]).map(block => block.text).join('');
          const path = /\[output truncated; full output: (.+)\]/.exec(text)?.[1];
          input = { ...tool.input, file_path: path ?? 'missing-spill-path' };
        }
        if (tool?.id === 'fixture-plan-write-call') {
          const planResult = modelRequest.messages.flatMap(message => Array.isArray(message.content) ? message.content as { type: string; tool_use_id?: string; content?: unknown }[] : [])
            .find(block => block.type === 'tool_result' && block.tool_use_id === 'fixture-enter-plan-call');
          const content = planResult?.content;
          const text = typeof content === 'string' ? content : (content as { text: string }[]).map(block => block.text).join('');
          const plan = JSON.parse(text) as { planPath: string };
          input = { ...tool.input, file_path: plan.planPath };
        }
        const emit = (event: string, data: unknown) => response.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
        response.writeHead(200, { 'content-type': 'text/event-stream' });
        emit('message_start', { type: 'message_start', message: { id: `fixture-message-${requests}`, type: 'message', role: 'assistant', model: 'claude-sonnet-4-6', content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 10, output_tokens: 0 } } });
        emit('content_block_start', { type: 'content_block_start', index: 0, content_block: tool ? { type: 'tool_use', id: tool.id, name: tool.name, input: {} } : { type: 'text', text: '' } });
        emit('content_block_delta', { type: 'content_block_delta', index: 0, delta: tool ? { type: 'input_json_delta', partial_json: JSON.stringify(input) } : { type: 'text_delta', text: 'Fixture complete.' } });
        emit('content_block_stop', { type: 'content_block_stop', index: 0 });
        emit('message_delta', { type: 'message_delta', delta: { stop_reason: tool ? 'tool_use' : 'end_turn', stop_sequence: null }, usage: { output_tokens: 10 } });
        emit('message_stop', { type: 'message_stop' });
        response.end();
      });
      await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
      const address = server.address();
      if (!address || typeof address === 'string') throw new Error('Fixture server did not bind');
      const proxyUrl = `http://127.0.0.1:${address.port}`;
      const fixture = await createNativeHostFixture('shell-review', { productSessionId, sidecarPort: address.port }, {
        HTTP_PROXY: proxyUrl, HTTPS_PROXY: proxyUrl, http_proxy: proxyUrl, https_proxy: proxyUrl,
        NO_PROXY: 'localhost,127.0.0.1,::1', no_proxy: 'localhost,127.0.0.1,::1',
      }).catch(async error => {
        server.closeAllConnections();
        await new Promise<void>(resolve => server.close(() => resolve()));
        throw error;
      });
      const attachments = new DshAttachmentRegistry(fixture.executionEnvironment.attachmentStagingRoot);
      await attachments.initialize();
      await writeFile(join(fixture.workspace, 'native-large.txt'), 'short line\n'.repeat(850_000));
      await writeFile(join(fixture.workspace, 'native-pixel.png'), Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=', 'base64'));
      const reviews: PermissionReview[] = [];
      const approvals: MethodParams<'host/interaction/request'>[] = [];
      const events: Record<string, unknown>[] = [];
      const host = fixture.createHost({
        ...fixture.hostHandlers,
        'host/credential/resolve': params => params.purpose === 'availability'
          ? { kind: 'availability', available: true, authoritativeCredentialRevision: params.profileRevision }
          : { kind: 'material', authoritativeCredentialRevision: params.profileRevision, material: { apiKey: 'synthetic-native-model-key' } },
        'host/hook/execute': () => ({ state: 'continue' }),
        'host/attachment/put': params => attachments.put(params),
        'host/attachment/acquire': params => attachments.acquire(params),
        'host/attachment/release': params => attachments.release(params),
        'host/interaction/request': async params => {
          const approval = params as MethodParams<'host/interaction/request'>;
          if (approval.kind === 'permission') reviews.push(approval.reviewRef ? await attachments.readJson(approval.reviewRef) as PermissionReview : approval.review!);
          approvals.push(approval);
          return { registered: true };
        },
      }, { 'runtime/event': params => { events.push(params); }, 'host/interaction/cancel': () => undefined });
      try {
        await mkdir(join(fixture.workspace, 'child'));
        await host.start();
        const skillPath = join(fixture.workspace, 'SKILL.md');
        const skillContent = '---\nname: permission-review\ndescription: Verify approval continuity\n---\n\nContinue the synthetic fixture.\n';
        await writeFile(skillPath, skillContent);
        const extension = compileDshProductExtensionPlane({
          revision: 'native-shell-review-extensions',
          skills: [{ name: 'permission-review', description: 'Verify approval continuity', contentSha256: createHash('sha256').update(skillContent).digest('hex'), path: skillPath, scope: 'project', sourceId: 'native-permission-regression' }],
          commands: [], agents: [{ name: 'permission-helper', description: 'Verify child approval', prompt: 'Return the synthetic fixture completion.', skills: [], scope: 'project', sourceId: 'native-permission-regression' }], mcpServers: [], dynamicTools: [],
        }).snapshot;
        await host.request('extension/replace', extension);
        const catalog = await host.request('extension/catalog', {});
        const provider = structuredClone(PRESET_PROVIDERS.find(({ id }) => id === 'anthropic-api'));
        if (!provider) throw new Error('Fixture Provider is missing');
        provider.id = 'native-anthropic-fixture';
        provider.config.baseUrl = `http://127.0.0.1:${address.port}`;
        const profile = compileDshModelExecutionProfile({ provider, modelId: 'claude-sonnet-4-6' });
        const binding = await host.request('session/create', { clientOperationId: 'native-shell-review-bind', persistenceRef: 'native-shell-review', provider: profile, configRevision: 'native-shell-review-config', extensionDigest: catalog.digest, systemPrompt: '', permissionMode: 'approval-required', interactionScenario: 'host-interaction-v1' });
        expect(binding.state).toBe('ready');
        const environmentDigest = createDshInitializeParams({ productSessionId, productVersion: '0.4.11', runtimeHome: fixture.runtimeHome, workspace: { path: fixture.workspace, identity: fixture.executionEnvironment.workspace.identity }, executionEnvironment: fixture.executionEnvironment, interaction: 'deterministic-headless' }).executionEnvironment.digest;
        const configured = await host.request('config/apply', { revision: 'native-shell-review-auto', provider: profile, permissionMode: 'approval-required', interactionScenario: 'host-interaction-v1', systemPrompt: '', executionEnvironmentRevision: fixture.executionEnvironment.revision, executionEnvironmentDigest: environmentDigest });
        expect(configured.state).toBe('applied');
        await host.request('turn/start', { clientOperationId: 'native-shell-review-turn', clientUserMessageId: 'native-shell-review-message', input: { parts: [{ kind: 'text', text: 'Read the current CLI route and verify file tools.' }] }, configRevision: 'native-shell-review-auto', extensionDigest: catalog.digest, executionEnvironmentRevision: fixture.executionEnvironment.revision, executionEnvironmentDigest: environmentDigest, limits: { maxTurns: 28 }, origin: { kind: 'headless', scenario: 'native-shell-review' } });
        await expect.poll(() => approvals.length, { timeout: 20_000 }).toBe(1);
        const approval = approvals[0]!;
        expect(approval.authority).toMatchObject({ callId: 'fixture-shell-call', rootCallId: 'fixture-shell-call' });
        expect(approval.reviewRef !== undefined).toBe(largeReview);
        expect(reviews[0]?.operation).toEqual({ kind: 'command', dialect: 'bash', command, cwd: join(fixture.workspace, 'child'), description: 'Read the current CLI route' });
        expect(reviews[0]?.actor.origin).toBe('root');
        expect(events.some(value => (value.event as Record<string, unknown>)?.kind === 'tool' && (value.event as Record<string, unknown>).phase === 'end')).toBe(false);
        const receipt = await host.request('interaction/respond', { interactionId: approval.interactionId, expectedRevision: approval.desiredPolicyRevision, decision: 'always_allow' });
        expect(receipt.state).toBe('applied');
        let approvalIndex = 1;
        let expectedRevision = receipt.state === 'applied' ? receipt.effectivePolicyRevision : '';
        const approveCall = async (callId: string, origin: 'root' | 'foreground_child') => {
          await expect.poll(() => approvals.length, { timeout: 20_000 }).toBe(approvalIndex + 1);
          const next = approvals[approvalIndex++]!;
          const call = calls.find(candidate => candidate?.id === callId)!;
          expect(next.kind).toBe('permission');
          expect((next.schema as Record<string, unknown>).tool).toBe(call.name);
          expect(next.review?.actor.origin).toBe(origin);
          expect(next.authority).toMatchObject({ callId: call.id, rootCallId: call.id });
          expect(next.desiredPolicyRevision).toBe(expectedRevision);
          expect(childResults.has(call.id)).toBe(false);
          const result = await host.request('interaction/respond', { interactionId: next.interactionId, expectedRevision: next.desiredPolicyRevision, decision: 'allow_once' });
          expect(result.state).toBe('applied');
          if (result.state === 'applied') expectedRevision = result.effectivePolicyRevision;
        };
        const answerQuestions = async () => {
          await expect.poll(() => approvals.length, { timeout: 20_000 }).toBe(approvalIndex + 1);
          const next = approvals[approvalIndex++]!;
          expect(next.kind).toBe('ask_user');
          const schema = next.schema as { questions: { id: string; multiSelect?: boolean; options: { label: string }[] }[] };
          expect(schema.questions).toHaveLength(3);
          const invalid = await host.request('interaction/respond', { interactionId: next.interactionId, expectedRevision: next.desiredPolicyRevision, decision: 'answered', value: { answers: schema.questions.map(question => ({ id: question.id, selected: ['invalid synthetic option'] })) } });
          expect(invalid).toMatchObject({ state: 'rejected', code: 'interaction_response_invalid' });
          const answers = schema.questions.map((question, index) => buildDshQuestionAnswer(question.id,
            index === 2 ? { selected: [], custom: 'Write locally, then continue' }
              : { selected: index === 1 ? ['Continue', 'Review, then continue'] : ['Continue'] },
            question.options.map(option => option.label), question.multiSelect === true));
          const result = await host.request('interaction/respond', { interactionId: next.interactionId, expectedRevision: next.desiredPolicyRevision, decision: 'answered', value: { answers } });
          expect(result.state).toBe('applied');
        };
        await approveCall('fixture-create-call', 'root');
        await approveCall('fixture-update-call', 'root');
        await approveCall('fixture-skill-call', 'root');
        await approveCall('fixture-agent-call', 'root');
        await approveCall('fixture-child-review-call', 'foreground_child');
        await answerQuestions();
        await expect.poll(() => approvals.length, { timeout: 20_000 }).toBe(approvalIndex + 1);
        const planApproval = approvals[approvalIndex++]!;
        expect(planApproval.kind).toBe('plan_approval');
        const planQuestion = (planApproval.schema as { questions: { id: string }[] }).questions[0]!;
        expect(await host.request('interaction/respond', {
          interactionId: planApproval.interactionId,
          expectedRevision: planApproval.desiredPolicyRevision,
          decision: 'answered',
          value: { answers: [{ id: planQuestion.id, selected: ['Approve'] }] },
        })).toMatchObject({ state: 'applied' });
        expect(approvals.filter(value => value.kind === 'permission')).toHaveLength(6);
        expect(childResults.size).toBe(2);
        for (const result of childResults.values()) expect(result.is_error, JSON.stringify(result)).not.toBe(true);
        expect(JSON.stringify(childResults.get('fixture-child-inherited-call')?.content)).toContain('inherited-child');
        expect(JSON.stringify(childResults.get('fixture-child-review-call')?.content)).toContain('approved-child');
        expect(JSON.stringify(childResults.get('fixture-child-review-call')?.content)).toContain('shell-proxy-ok');
        await expect.poll(async () => (await host.request('turn/get', { clientOperationId: 'native-shell-review-turn' })).terminal !== undefined, { timeout: 20_000 }).toBe(true);
        const toolResult = events.find(value => (value.event as Record<string, unknown>)?.kind === 'tool' && (value.event as Record<string, unknown>).phase === 'end');
        expect(toolResult).toBeDefined();
        expect(JSON.stringify(toolResult)).toContain(`${address.port}|${productSessionId}`);
        expect(JSON.stringify(toolResult)).toContain('shell-proxy-ok');
        expect(JSON.stringify(toolResult)).toContain('shell-loopback-ok');
        expect(cliReceipts).toEqual([{ token: 'fixture-capability', authorization: undefined, sessionId: productSessionId }]);
        expect(JSON.stringify(modelToolResults.get('fixture-internal-cli-call')?.content)).toContain('internal-cli-fixture');
        expect(proxyRequests).toEqual(['http://dsh-shell-fixture.invalid/root', 'http://dsh-shell-fixture.invalid/child']);
        expect(JSON.stringify(toolResult)).not.toContain('not sealed');
        const toolResults = events.filter(value => (value.event as Record<string, unknown>)?.kind === 'tool' && (value.event as Record<string, unknown>).phase === 'end');
        expect(toolResults).toHaveLength(calls.filter(Boolean).length - childResults.size);
        for (const result of toolResults) expect((result.event as Record<string, unknown>).result).toMatchObject({ isError: false });
        expect(JSON.stringify(toolResults.find(result => result.toolCallId === 'fixture-update-call'))).toContain('completed');
        expect(JSON.stringify(toolResults.at(-1))).toContain('normal');
        expect(JSON.stringify(modelToolResults.get('fixture-question-call'))).toContain('Write locally, then continue');
        expect(JSON.stringify(modelToolResults.get('fixture-question-call'))).toContain('Review, then continue');
        expect(requests).toBe(calls.length + 1);
        expect(planSystemPrompt).toContain('Bash or PowerShell tool only for read-only inspection');
        expect(modelToolResults.get('fixture-plan-shell-call')).toBeDefined();
        expect(modelToolResults.get('fixture-plan-shell-call')?.is_error).not.toBe(true);
        expect(JSON.stringify(modelToolResults.get('fixture-plan-shell-call')?.content)).toContain('plan-shell-research');
        for (const size of spillSizes) {
          const result = modelToolResults.get(`fixture-spill-${size}`);
          expect(result?.is_error).not.toBe(true);
          const text = typeof result?.content === 'string' ? result.content : (result?.content as { text: string }[]).map(block => block.text).join('');
          expect(text).toContain('[exit code: 7]');
          expect(text).toContain('spill-tail-marker');
          const path = /\[output truncated; full output: (.+)\]/.exec(text)?.[1];
          if (size === 64_000) expect(path).toBeUndefined();
          else {
            expect(path).toBeDefined();
            expect(await realpath(path!)).toBe(path);
            expect(await readFile(path!, 'utf8')).toBe('x'.repeat(size));
          }
          const event = events.find(value => value.toolCallId === `fixture-spill-${size}` && (value.event as Record<string, unknown>)?.phase === 'end');
          expect((event?.event as Record<string, unknown>)?.result).toMatchObject({ isError: false, metadata: { exitCode: 7 } });
        }
        expect(modelToolResults.get('fixture-spill-read')?.is_error).not.toBe(true);
        expect(JSON.stringify(modelToolResults.get('fixture-spill-read')?.content)).toContain('x'.repeat(100));
        expect(await readFile(join(fixture.workspace, 'native-file-tools/note.txt'), 'utf8')).toBe('ALPHA\r\nBETA\r\n');
        expect(JSON.stringify(modelToolResults.get('fixture-file-glob')?.content)).toContain('note.txt');
        expect(JSON.stringify(modelToolResults.get('fixture-file-grep')?.content)).toContain('ALPHA');
        expect(JSON.stringify(modelToolResults.get('fixture-large-read')?.content)).toContain('short line');
        const imageResult = modelToolResults.get('fixture-image-read');
        expect(imageResult?.is_error).not.toBe(true);
        expect(JSON.stringify(imageResult?.content)).toContain('"type":"image"');
        expect(JSON.stringify(imageResult?.content)).toContain('"type":"base64"');
        const childInput = JSON.parse(childSystemPrompt) as {
          system?: string | Array<{ text?: string }>;
          messages: Array<{ content: string | Array<{ text?: string }> }>;
        };
        const systemText = typeof childInput.system === 'string' ? childInput.system
          : Array.isArray(childInput.system) ? childInput.system.map(block => block.text ?? '').join('\n') : '';
        const childText = [systemText, ...childInput.messages.flatMap(message => typeof message.content === 'string'
          ? [message.content] : message.content.map(block => block.text ?? ''))].join('\n');
        const identityText = /Your execution identity \(Runtime authority\): (\{[^\n]*\})/.exec(childText)?.[1];
        expect(identityText).toBeDefined();
        expect(JSON.parse(identityText!)).toMatchObject({ model: profile.modelId, provider: profile.providerRouteId, role: 'permission-helper', depth: 1, remainingDepth: 0, canDelegate: false });
        expect(resumedRootInput).toContain('fixture-agent-call');
        expect(resumedRootInput).not.toContain('activation_completion');
        expect(resumedRootInput).not.toContain('Your execution identity (Runtime authority)');
        expect(childSystemPrompt).toContain('Product permissions and shared exact grants apply');
        expect(childSystemPrompt).not.toContain('operations that require approval are rejected automatically');
        // This Provider omits cache buckets, so the native terminal intentionally
        // has no complete usage summary. Reopening must still recover the reply.
        const mutationController = new DshMutationController(host, String(binding.runtimeSessionId));
        const history = await mutationController.readHistory();
        const lookup = await mutationController.getTurn('native-shell-review-turn');
        expect(lookup.terminal?.usage).toBeUndefined();
        const recovered = buildDshTurnProjectionSnapshot(history, new Map([['native-shell-review-turn', lookup]]));
        expect(recovered.assistantTurns).toHaveLength(1);
        expect(recovered.assistantTurns[0]!.assistantMessage.content).toContain('Fixture complete.');
        expect(recovered.assistantTurns[0]!.assistantMessage.usage).toBeUndefined();
      } catch (error) {
        const progress = { requests, results: [...modelToolResults].map(([id, result]) => ({ id, isError: result.is_error, content: JSON.stringify(result.content).slice(0, 1500) })), terminal: await host.request('turn/get', { clientOperationId: 'native-shell-review-turn' }).catch(() => undefined), stderr: fixture.stderr.slice(-5) };
        throw new Error(`Native tool sequence failed: ${JSON.stringify(progress)}`, { cause: error });
      } finally {
        await host.stop();
        attachments.close();
        server.closeAllConnections();
        await new Promise<void>(resolve => server.close(() => resolve()));
        await rm(fixture.temporaryRoot, { recursive: true, force: true });
      }
    }, 120_000);

    it("handshakes with and shuts down the exact staged Runtime", async () => {
      const fixture = await createNativeHostFixture("smoke");
      const {
        executionEnvironment,
        host,
        runtimeHome,
        stderr,
        temporaryRoot,
        workspace,
      } = fixture;
      try {
        const identity = await host.start().catch((error: unknown) => {
          const message = error instanceof Error ? error.message : "unknown";
          throw new Error(
            `Native DSH start failed: ${message}; stderr=${stderr.join(" | ")}`,
          );
        });
        expect(identity).toMatchObject({
          runtimeGeneration: "artifact-process-generation",
          protocolVersion: GENERATED_PROTOCOL_VERSION,
          sessionFormat: "dsh-session-events-v2",
        });
        expect(host.state).toBe("protocol-ready");
        const skillPath = join(workspace, "SKILL.md");
        const skillContent =
          "---\nname: native-review\ndescription: Review native smoke evidence\n---\n\n# Review\n";
        await writeFile(skillPath, skillContent, "utf8");
        const hostTool = {
          name: "native_fixture",
          description: "Returns native smoke fixture data",
          inputSchema: {
            type: "object",
            properties: { query: { type: "string" } },
            required: ["query"],
          },
        };
        const extensionPlane = compileDshProductExtensionPlane({
          revision: "native-smoke-product-extensions-v1",
          skills: [
            {
              name: "native-review",
              description: "Review native smoke evidence",
              contentSha256: createHash("sha256")
                .update(skillContent)
                .digest("hex"),
              path: skillPath,
              scope: "project",
              sourceId: "native-smoke",
            },
          ],
          commands: [
            {
              name: "native-verify",
              description: "Verify native smoke evidence",
              body: "Verify the exact native smoke evidence.",
              scope: "project",
              sourceId: "native-smoke",
            },
          ],
          agents: [
            {
              name: "native-reviewer",
              description: "Reviews native smoke evidence",
              prompt: "Review the exact native smoke evidence.",
              skills: [{ name: "native-review", path: skillPath }],
              scope: "project",
              sourceId: "native-smoke",
            },
          ],
          mcpServers: [],
          dynamicTools: [hostTool],
          hostToolDispatcher: {
            descriptors: [hostTool],
            dispatch: async () => ({
              success: true,
              contentItems: [{ type: "text", text: "native fixture" }],
            }),
            dispose: () => undefined,
          },
        });
        const extension = extensionPlane.snapshot;
        const extensionResult = await host.request(
          "extension/replace",
          extension,
        );
        if (extensionResult.state !== "applied") {
          throw new Error(
            `Native extension replacement failed: ${JSON.stringify(extensionResult)}; stderr=${stderr.join(" | ")}`,
          );
        }
        expect(extensionResult).toMatchObject({
          state: "applied",
          effectiveRevision: extension.revision,
        });
        const extensionCatalog = await host.request("extension/catalog", {});
        expect(extensionCatalog.skills).toEqual(
          expect.arrayContaining([
            expect.objectContaining({ name: "native-review" }),
          ]),
        );
        expect(extensionCatalog.agents).toContain("native-reviewer");
        expect(extensionCatalog.tools).toContain(
          "mcp__myagents_host__native_fixture",
        );
        const provider = PRESET_PROVIDERS.find(
          ({ id }) => id === "anthropic-api",
        );
        if (!provider)
          throw new Error("Anthropic API Provider fixture is unavailable");
        const profile = compileDshModelExecutionProfile({
          provider: { ...structuredClone(provider), id: 'native-anthropic-fixture' } as Provider,
          modelId: "claude-sonnet-4-6",
        });
        const binding = await host.request("session/create", {
          clientOperationId: "native-smoke-session-create",
          persistenceRef: "native-smoke-persistence",
          provider: profile,
          configRevision: "native-smoke-config-v1",
          extensionDigest: String(extensionCatalog.digest),
          systemPrompt: "",
          permissionMode: "approval-required",
          interactionScenario: "host-interaction-v1",
        });
        expect(binding).toMatchObject({ state: "ready" });
        if (binding.state !== "ready") throw new Error("Native Session was not admitted");
        expect(binding.toolCatalog).toMatchObject({
          effectiveTools: expect.arrayContaining(["web_fetch", "web_search"]),
        });
        const applied = await host.request("config/apply", {
          revision: "native-smoke-config-v2",
          provider: profile,
          permissionMode: "approval-required",
          interactionScenario: "host-interaction-v1",
          systemPrompt: "",
          executionEnvironmentRevision: executionEnvironment.revision,
          executionEnvironmentDigest: createDshInitializeParams({
            productSessionId: "native-smoke-product-session",
            productVersion: "0.4.11",
            runtimeHome,
            workspace: { path: workspace, identity: "native-smoke-workspace" },
            executionEnvironment,
            interaction: "deterministic-headless",
          }).executionEnvironment.digest,
        });
        expect(applied).toMatchObject({
          state: "applied",
          effectiveRevision: "native-smoke-config-v2",
        });
        const plan = await host.request("plan/apply", {
          clientOperationId: "native-smoke-plan-normal",
          expectedRevision: "native-smoke-plan-probe",
          mode: "normal",
        });
        expect(plan).toMatchObject({
          state: "already_effective",
          mode: "normal",
        });
        const rules = await host.request("permission/rules/list", {});
        expect(rules).toMatchObject({
          permissionMode: "approval-required",
          rules: [],
        });
        const granted = await host.request("permission/rules/add", {
          expectedRevision: rules.revision,
          tool: "bash",
          permissionClass: "process.execute",
          target: "echo native-smoke",
        });
        expect(granted).toMatchObject({ state: "applied" });
        if (granted.state !== "applied") throw new Error("Native permission rule was not applied");
        expect(granted.rule).toMatchObject({
          tool: "bash",
          permissionClass: "process.execute",
          target: "echo native-smoke",
          origin: "root",
          expiresAt: null,
        });
        const grantedRule = granted.rule as { ruleId: string };
        const grantedRules = await host.request("permission/rules/list", {});
        expect(grantedRules).toMatchObject({
          revision: granted.revision,
          rules: [{ ruleId: grantedRule.ruleId, target: "echo native-smoke" }],
        });
        const revoked = await host.request("permission/rules/revoke", {
          expectedRevision: grantedRules.revision,
          ruleId: grantedRule.ruleId,
        });
        expect(revoked).toMatchObject({ state: "applied" });
        const revokedRules = await host.request("permission/rules/list", {});
        expect(revokedRules).toMatchObject({
          revision: revoked.revision,
          rules: [],
        });
        const liveReplacement = compileDshProductExtensionPlane({
          revision: "native-smoke-product-extensions-v2",
          skills: [],
          commands: [],
          agents: [],
          mcpServers: [],
          dynamicTools: [],
          components: [],
        });
        const replacementResult = await host.request(
          "extension/replace",
          liveReplacement.snapshot,
        );
        expect(replacementResult).toMatchObject({
          state: "applied",
          desiredRevision: liveReplacement.snapshot.revision,
          effectiveRevision: liveReplacement.snapshot.revision,
        });
        const replacementCatalog = await host.request("extension/catalog", {});
        expect(replacementCatalog).toMatchObject({
          revision: liveReplacement.snapshot.revision,
        });
        expect(replacementCatalog.digest).not.toBe(extensionCatalog.digest);
        expect(replacementCatalog.skills).not.toEqual(
          expect.arrayContaining([
            expect.objectContaining({ name: "native-review" }),
          ]),
        );
        expect(replacementCatalog.tools).not.toContain(
          "mcp__myagents_host__native_fixture",
        );
        await host.request("session/close", {
          clientOperationId: "native-smoke-session-close",
        });
        expect(JSON.stringify(stderr)).not.toMatch(
          /(api.?key|authorization|credential-canary)/i,
        );
      } finally {
        await host.stop();
        await rm(temporaryRoot, { recursive: true, force: true });
      }
      expect(host.state).toBe("stopped");
    }, 120_000);

    it("resumes a configured Session and its non-expiring grant after a Runtime process restart", async () => {
      const fixture = await createNativeHostFixture("resume");
      const provider = PRESET_PROVIDERS.find(
        ({ id }) => id === "anthropic-api",
      );
      if (!provider)
        throw new Error("Anthropic API Provider fixture is unavailable");
      const profile = compileDshModelExecutionProfile({
        provider: { ...structuredClone(provider), id: 'native-anthropic-fixture' } as Provider,
        modelId: "claude-sonnet-4-6",
      });
      const extension = compileDshProductExtensionPlane({
        revision: "native-resume-extensions-v1",
        skills: [],
        commands: [],
        agents: [],
        mcpServers: [],
        dynamicTools: [],
        components: [],
      }).snapshot;
      let resumedHost: DshRuntimeProcessHost | undefined;
      try {
        await fixture.host.start();
        const extensionResult = await fixture.host.request(
          "extension/replace",
          extension,
        );
        expect(extensionResult).toMatchObject({
          state: "applied",
          effectiveRevision: extension.revision,
        });
        const catalog = await fixture.host.request("extension/catalog", {});
        const created = await fixture.host.request("session/create", {
          clientOperationId: "native-resume-create",
          persistenceRef: "native-resume-persistence",
          provider: profile,
          configRevision: "native-resume-config-v1",
          extensionDigest: String(catalog.digest),
          systemPrompt: "",
          permissionMode: "approval-required",
          interactionScenario: "host-interaction-v1",
        });
        expect(created).toMatchObject({ state: "ready" });
        const runtimeSessionId = String(created.runtimeSessionId);
        await fixture.host.request("config/apply", {
          revision: "native-resume-config-v2",
          provider: profile,
          permissionMode: "approval-required",
          interactionScenario: "host-interaction-v1",
          systemPrompt: "",
          executionEnvironmentRevision: fixture.executionEnvironment.revision,
          executionEnvironmentDigest: createDshInitializeParams({
            productSessionId: "native-resume-product-session",
            productVersion: "0.4.11",
            runtimeHome: fixture.runtimeHome,
            workspace: {
              path: fixture.workspace,
              identity: "native-resume-workspace",
            },
            executionEnvironment: fixture.executionEnvironment,
            interaction: "deterministic-headless",
          }).executionEnvironment.digest,
        });
        const policy = await fixture.host.request("permission/rules/list", {});
        const grant = await fixture.host.request("permission/rules/add", {
          expectedRevision: policy.revision,
          tool: "bash", permissionClass: "process.execute", target: fixture.workspace,
        });
        expect(grant).toMatchObject({ state: "applied", rule: { expiresAt: null } });
        if (grant.state !== "applied" || !grant.rule) throw new Error("Native Session grant was not applied");
        await fixture.host.stop();

        resumedHost = fixture.createHost();
        await resumedHost.start();
        await resumedHost.request(
          "extension/replace",
          extension,
        );
        const resumed = await resumedHost.request("session/resume", {
          clientOperationId: "native-resume-bind",
          runtimeSessionId,
          persistenceRef: "native-resume-persistence",
          provider: profile,
          configRevision: "native-resume-config-v2",
          extensionDigest: String(catalog.digest),
          systemPrompt: "",
          permissionMode: "approval-required",
          interactionScenario: "host-interaction-v1",
        });
        expect(resumed).toMatchObject({ state: "ready", runtimeSessionId });
        expect(
          await resumedHost.request("permission/rules/list", {}),
        ).toMatchObject({
          permissionMode: "approval-required",
          revision: grant.revision,
          rules: [grant.rule],
        });
        expect(await resumedHost.request("permission/rules/revoke", {
          expectedRevision: grant.revision, ruleId: grant.rule.ruleId,
        })).toMatchObject({ state: "applied" });
        expect(await resumedHost.request("permission/rules/list", {})).toMatchObject({ rules: [] });
      } finally {
        await fixture.host.stop();
        await resumedHost?.stop();
        await rm(fixture.temporaryRoot, { recursive: true, force: true });
      }
    }, 120_000);
  },
);

describe.runIf(nativeSoakEnabled)(
  "DSH RuntimeProcessHost native lifecycle soak",
  () => {
    it("releases every exact packaged Runtime generation within bounded Host resources", async () => {
      const iterations = requestedNativeSoakIterations();
      const rssBefore = process.memoryUsage().rss;
      const descriptorsBefore = await currentOpenFileDescriptorCount();
      const runtimePids: number[] = [];

      for (let index = 0; index < iterations; index += 1) {
        const fixture = await createNativeHostFixture(`soak-${index + 1}`);
        let runtimePid: number | undefined;
        try {
          const identity = await fixture.host.start();
          expect(identity).toMatchObject({
            protocolVersion: GENERATED_PROTOCOL_VERSION,
            sessionFormat: "dsh-session-events-v2",
          });
          runtimePid = fixture.host.pid;
          expect(runtimePid).toBeTypeOf("number");
          const status = await fixture.host.request("runtime/status", {});
          expect(status).toMatchObject({
            runtimeGeneration: identity.runtimeGeneration,
          });
        } finally {
          await fixture.host.stop();
          await rm(fixture.temporaryRoot, { recursive: true, force: true });
        }
        expect(fixture.host.state).toBe("stopped");
        if (runtimePid !== undefined) {
          runtimePids.push(runtimePid);
          expect(processIsAlive(runtimePid)).toBe(false);
        }
      }

      const descriptorsAfter = await currentOpenFileDescriptorCount();
      const rssGrowthBytes = Math.max(0, process.memoryUsage().rss - rssBefore);
      if (descriptorsBefore !== undefined && descriptorsAfter !== undefined) {
        expect(descriptorsAfter).toBeLessThanOrEqual(descriptorsBefore + 8);
      }
      expect(rssGrowthBytes).toBeLessThanOrEqual(192 * 1024 * 1024);
      expect(new Set(runtimePids).size).toBe(iterations);

      process.stdout.write(
        `${JSON.stringify({
          kind: "myagents-dsh-native-lifecycle-soak-v1",
          iterations,
          runtimePids,
          rssGrowthBytes,
          descriptorsBefore,
          descriptorsAfter,
        })}\n`,
      );
    }, 600_000);
  },
);

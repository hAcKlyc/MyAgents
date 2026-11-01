import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { agentReference, sessionReference, REMOTE_DEADLINES } from '@myagents/agent-network-protocol';

import {
  formatCronInstantForDisplay,
  formatCronTaskScheduleForDisplay,
  buildRequestBody,
  buildRoute,
  adminHttpErrorResult,
  buildClaimCancelBody,
  buildSpaceCompleteOperationKey,
  commandResultExitCode,
  cliRequestTimeoutMs,
  callApi,
  TOP_HELP,
  normalizeScheduleFlag,
  normalizeSkillSourceForRequest,
  parseArgs,
  parseDispatchAtValue,
  printAgentList,
  printSkillList,
  printModelList,
  printGoalResult,
  printResult,
  publicCliHelp,
  readWorkspaceTextFile,
  rejectUnsupportedSpaceDryRun,
  resolveCliPort,
  validateCliRouting,
  validateCliCommand,
  validateDryRunSupport,
  validateExternalCliInvocation,
  validateInternalCliInvocation,
  validateSessionMutationAcknowledgement,
} from './myagents';
import {
  EXTERNAL_CLI_PUBLIC_CAPABILITIES,
  EXTERNAL_CLI_PUBLIC_COMMANDS,
  isExternalCliPublicRoute,
} from '../shared/externalCliCapabilities';

const inheritedMyAgentsSessionId = process.env.MYAGENTS_SESSION_ID;

beforeEach(() => {
  delete process.env.MYAGENTS_SESSION_ID;
});

afterEach(() => {
  if (inheritedMyAgentsSessionId === undefined) delete process.env.MYAGENTS_SESSION_ID;
  else process.env.MYAGENTS_SESSION_ID = inheritedMyAgentsSessionId;
});


describe('Session observation CLI', () => {
  it('prints the wrapped observation receipt in JSON and human output', () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const result = { success: true, data: { watches: [{ watchId: 'watch', targetSessionId: 'target', cancelled: true }] } };
    try {
      printResult('session', 'unwatch', result, true);
      expect(JSON.parse(log.mock.calls[0][0])).toEqual(result);
      log.mockClear();
      printResult('session', 'unwatch', result, false);
      expect(log).toHaveBeenCalledWith('watch  target  cancelled');
    } finally { log.mockRestore(); }
  });

  it.each([
    ['state', []], ['watches', ['extra']], ['unwatch', []],
  ] as const)('uses the normal usage exit code for invalid %s arguments', (action, rest) => {
    const exit = vi.spyOn(process, 'exit').mockImplementation((code) => { throw new Error(`exit:${code}`); });
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    try {
      expect(() => buildRequestBody('session', action, [...rest], {})).toThrow('exit:2');
    } finally { exit.mockRestore(); error.mockRestore(); }
  });

  it.each([
    ['session', 'watch', [], {}],
    ['session', 'watch', ['target', 'extra'], {}],
    ['session', 'watch', [], { to: true }],
    ['session', 'watch', [], { targetSessionId: true }],
    ['session', 'watch', ['target'], { prompt: 'new work' }],
    ['session', 'state', [], { sessionId: true }],
    ['session', 'state', [], { sessionId: ' ' }],
    ['session', 'unwatch', [' '], {}],
    ['agent', 'network-diagnose', [], { limit: true }],
    ['agent', 'network-diagnose', [], { limit: 'not-a-number' }],
    ['agent', 'network-diagnose', [], { cursor: true }],
  ] as const)('rejects incomplete observation values for %s %s before any HTTP request', (group, action, rest, flags) => {
    const exit = vi.spyOn(process, 'exit').mockImplementation((code) => { throw new Error(`exit:${code}`); });
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    try {
      expect(() => buildRequestBody(group, action, [...rest], flags)).toThrow('exit:2');
    } finally { exit.mockRestore(); error.mockRestore(); }
  });

  it('keeps state read-only and binds watch management to the current real Session', () => {
    for (const command of [['session','state','sid'], ['session','watches'], ['session','unwatch','watch']]) {
      expect(validateCliCommand(command)).toBeUndefined();
      expect(validateInternalCliInvocation(command, {})).toBeUndefined();
    }
    expect(buildRequestBody('session','state',['sid'],{})).toEqual({ sessionId: 'sid' });
    expect(buildRequestBody('agent','network-diagnose',[],{limit:'3',cursor:'next'})).toEqual({limit:3,cursor:'next'});
    expect(buildRequestBody('agent','network-diagnose',[],{})).toEqual({limit:100,cursor:undefined});
    expect(buildRequestBody('session','watches',[],{})).toEqual({});
    expect(buildRequestBody('session','unwatch',[],{all:true})).toEqual({all:true});
    expect(buildRequestBody('session','unwatch',['watch'],{})).toEqual({watchId:'watch'});
    expect(validateExternalCliInvocation(['session','state','sid'],{})).toBeUndefined();
    expect(validateExternalCliInvocation(['session','watches'],{})).toBeDefined();
    expect(validateExternalCliInvocation(['session','unwatch','watch'],{})).toBeDefined();
    expect(cliRequestTimeoutMs('session/watches')).toBeGreaterThan(22_000);
  });
});

describe('myagents CLI port authority', () => {
  it('keeps --port above inherited Session or Rust-injected Global ports', () => {
    expect(resolveCliPort('32003', '32002')).toBe('32003');
    expect(resolveCliPort(undefined, '32002')).toBe('32002');
    expect(resolveCliPort(undefined, '')).toBe('');
  });
});

describe('CLI dry-run admission', () => {
  it('rejects unsupported Agent and other mutation leaves before request building', () => {
    for (const command of [
      ['agent', 'disable', 'agent-1'],
      ['agent', 'channel', 'remove', 'agent-1', 'channel-1'],
      ['mcp', 'remove', 'server-1'],
      ['session', 'send', 'session-1'],
    ]) {
      const positional = parseArgs([...command, '--dry-run']).positional;
      expect(validateDryRunSupport(positional, { dryRun: true })).toMatchObject({
        code: 'DRY_RUN_UNSUPPORTED',
        error: expect.stringContaining('No changes were applied'),
      });
    }
  });

  it('preserves every documented preview leaf and ordinary commands', () => {
    for (const command of [
      ['mcp', 'add'], ['model', 'add'], ['config', 'set'],
      ['cron', 'add'], ['skill', 'add'], ['tool', 'add'],
    ]) {
      expect(validateDryRunSupport(command, { dryRun: true })).toBeUndefined();
    }
    expect(validateDryRunSupport(['agent', 'disable', 'agent-1'], {})).toBeUndefined();
    expect(parseArgs(['agent', 'disable', 'agent-1', '--dry-run=false']).flags.dryRun).toBe(true);
  });
});

describe('public external CLI declaration', () => {
  it('accepts the bundled external guide examples through the public CLI grammar', () => {
    const guide = readFileSync(join(process.cwd(), 'bundled-guides/external-myagents-cli/SKILL.md'), 'utf8');
    const invocations = [...guide.matchAll(/^<CLI> ([^\n]+)$/gm)]
      .map(([, invocation]) => invocation.trim())
      .filter(invocation => invocation !== '--help' && !invocation.endsWith(' --help'));
    expect(invocations.length).toBeGreaterThan(0);
    for (const invocation of invocations) {
      const { positional, flags } = parseArgs(invocation.split(/\s+/));
      expect(validateExternalCliInvocation(positional, flags), invocation).toBeUndefined();
    }
  });

  it('maps every advertised command to an admitted canonical route', () => {
    expect(new Set(EXTERNAL_CLI_PUBLIC_COMMANDS).size).toBe(EXTERNAL_CLI_PUBLIC_COMMANDS.length);
    for (const { command, route: declaredRoute } of EXTERNAL_CLI_PUBLIC_CAPABILITIES) {
      const [group, action, ...rest] = command.split(' ');
      const route = action ? buildRoute(group, action, rest) : group;
      expect(route, command).toBe(declaredRoute);
      expect(isExternalCliPublicRoute(route), command).toBe(true);
    }
    expect(buildRoute('task', 'remove', ['task-1'])).toBe('task/delete');
    expect(EXTERNAL_CLI_PUBLIC_COMMANDS).toContain('task remove');
  });

  it('rejects undeclared public flags and positional arguments before HTTP', () => {
    expect(validateExternalCliInvocation([], { mystery: true }))
      .toMatchObject({ code: 'UNKNOWN_FLAG' });
    expect(validateExternalCliInvocation(
      ['session', 'get', 'session-1'],
      { json: true, secretOverride: 'nope' },
    )).toMatchObject({ code: 'UNKNOWN_FLAG' });
    expect(validateExternalCliInvocation(
      ['task', 'start', 'task-1', 'extra'],
      {},
    )).toMatchObject({ code: 'ARGUMENT_INVALID' });
    expect(validateExternalCliInvocation(
      ['task', 'remove', 'task-1'],
      { json: true },
    )).toBeUndefined();
  });

  it('keeps outer Session budgets above their inner owner budgets', () => {
    expect(cliRequestTimeoutMs('session/start')).toBeGreaterThan(180_000);
    expect(cliRequestTimeoutMs('session/send')).toBeGreaterThan(35_000);
    expect(cliRequestTimeoutMs('session/get')).toBeGreaterThan(18_000);
    expect(cliRequestTimeoutMs('mcp/test')).toBeGreaterThan(15_000);
    expect(cliRequestTimeoutMs('model/verify')).toBeGreaterThan(45_000);
    // Each probe/install can try main then master; each ZIP transfer gets ten minutes.
    expect(cliRequestTimeoutMs('skill/add')).toBeGreaterThan(2 * (2 * 600_000 + 30_000));
    expect(cliRequestTimeoutMs('cc-plugin/install')).toBeGreaterThan(2 * 600_000 + 30_000);
    expect(cliRequestTimeoutMs('cc-plugin/uninstall')).toBeGreaterThan(330_000);
    expect(cliRequestTimeoutMs('agent/archive')).toBeGreaterThan(2 * 300_000);
    for (const route of ['agent/unarchive', 'agent/resolve-conflict', 'agent/channel/remove']) {
      expect(cliRequestTimeoutMs(route)).toBeGreaterThan(300_000);
    }
    expect(cliRequestTimeoutMs('task/trigger/test')).toBeGreaterThan(310_000);
    expect(cliRequestTimeoutMs('status')).toBe(10_000);
    expect(cliRequestTimeoutMs('session/watch')).toBeGreaterThan(30_000);
  });
  it('distinguishes a response timeout from a refused connection without retrying', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch');
    try {
      fetchMock.mockRejectedValueOnce(new DOMException('deadline', 'TimeoutError'));
      expect(await callApi('model/verify')).toMatchObject({
        code: 'MYAGENTS_REQUEST_TIMEOUT', error: expect.stringContaining('Provider verification'),
      });
      fetchMock.mockRejectedValueOnce(Object.assign(new TypeError('fetch failed'), { cause: { code: 'ECONNREFUSED' } }));
      expect(await callApi('status')).toMatchObject({ code: 'MYAGENTS_UNAVAILABLE' });
      fetchMock.mockRejectedValueOnce(new DOMException('deadline', 'TimeoutError'));
      expect(await callApi('session/send')).toMatchObject({ code: 'admission_unconfirmed' });
      fetchMock.mockRejectedValueOnce(new TypeError('fetch failed'));
      expect(await callApi('status')).toMatchObject({ code: 'MYAGENTS_REQUEST_FAILED' });
      expect(fetchMock).toHaveBeenCalledTimes(4);
    } finally { fetchMock.mockRestore(); }
  });
  it('classifies an interrupted response body and preserves uncertain Session admission', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockImplementation(async () => {
      const body = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new TextEncoder().encode('{"success":'));
          queueMicrotask(() => controller.error(Object.assign(new TypeError('terminated'), {
            cause: { code: 'UND_ERR_SOCKET' },
          })));
        },
      });
      return new Response(body, { headers: { 'Content-Type': 'application/json' } });
    });
    try {
      expect(await callApi('model/verify')).toMatchObject({ code: 'MYAGENTS_REQUEST_FAILED' });
      expect(await callApi('session/send')).toMatchObject({ code: 'admission_unconfirmed' });
      expect(fetchMock).toHaveBeenCalledTimes(2);
    } finally { fetchMock.mockRestore(); }
  });
  it('uses one shared remote budget without changing local start/send budgets', () => {
    const ref = { serviceId: '00000000-0000-0000-0000-000000000001',
      networkId: '00000000-0000-0000-0000-000000000002', mountId: '00000000-0000-0000-0000-000000000003' };
    const agent = agentReference(ref);
    const session = sessionReference({ ...ref, localSessionId: 'session-a' });
    for (const [route, key, value] of [['agent/show', 'agentId', agent], ['session/list', 'agentId', agent],
      ['session/start', 'agentId', agent], ['session/get', 'sessionId', session], ['session/send', 'toSessionId', session],
      ['session/watch', 'targetSessionId', session]]) {
      const method = route.replace('/', '.') as keyof typeof REMOTE_DEADLINES;
      expect(cliRequestTimeoutMs(route, { [key]: value })).toBe(REMOTE_DEADLINES[method].cli);
      expect(REMOTE_DEADLINES[method].cli).toBeGreaterThan(REMOTE_DEADLINES[method].admin);
      expect(REMOTE_DEADLINES[method].admin).toBeGreaterThan(REMOTE_DEADLINES[method].connector);
    }
    expect(cliRequestTimeoutMs('session/start', { agentId: 'local' })).toBe(195_000);
    expect(cliRequestTimeoutMs('session/send', { toSessionId: 'local' })).toBe(40_000);
    expect(() => cliRequestTimeoutMs('session/get', { sessionId: agent })).toThrow();
  });

  it('provides exact offline help for every canonical command and alias', () => {
    for (const capability of EXTERNAL_CLI_PUBLIC_CAPABILITIES) {
      const aliases = 'aliases' in capability ? capability.aliases : [];
      for (const command of [capability.command, ...aliases]) {
        const help = publicCliHelp(command.split(' '));
        expect(help, command).toContain(`myagents ${command}`);
        expect(help, command).toContain('Purpose:');
        expect(help, command).toContain('Effect:');
        expect(help, command).toContain('Result:');
        expect(help, command).toContain('Recovery:');
        expect(help, command).not.toContain('[options]');
        expect(help, command).not.toContain('[fields]');
      }
    }
    expect(publicCliHelp(['task', 'remove'])).not.toContain('myagents task delete');
  });
});

describe('myagents CLI port authority', () => {
  it('rejects a missing or invalid Session route while preserving explicit terminal routing', () => {
    expect(validateCliRouting('31417', 'product-a')).toBeUndefined();
    expect(validateCliRouting('31417', undefined)).toBeUndefined();
    expect(validateCliRouting('', 'product-a')).toBe('CLI_SESSION_ROUTE_REQUIRED');
    expect(validateCliRouting('31417', '')).toBe('CLI_SESSION_SCOPE_INVALID');
    for (const port of ['0', '65536', '-1', '1/path', '31417@evil', 'Infinity', ' 31417']) {
      expect(validateCliRouting(port, 'product-a')).toBe('CLI_SESSION_ROUTE_REQUIRED');
    }
    expect(parseArgs(['--version', '--json'])).toEqual({ positional: [], flags: { version: true, json: true } });
  });
  it('keeps --port above inherited Session or Rust-injected Global ports', () => {
    expect(resolveCliPort('32003', '32002')).toBe('32003');
    expect(resolveCliPort(undefined, '32002')).toBe('32002');
    expect(resolveCliPort(undefined, '')).toBe('');
  });
});

describe('CLI help and Session list output', () => {
  it('routes capability discovery by intent for both local and network collaboration', () => {
    expect(TOP_HELP).toContain('Choose by intent');
    expect(TOP_HELP).toContain('Durable work, scheduling and run tracking: task readme');
    expect(TOP_HELP).toContain('session start (fresh) or send (reuse)');
    expect(TOP_HELP).toContain('agent network-diagnose --json');
    expect(TOP_HELP).toContain('other devices');
  });
  it('prints complete usable remote selectors with separate metadata columns', () => {
    const ref = {
      serviceId: '00000000-0000-4000-8000-000000000010',
      networkId: '00000000-0000-4000-8000-000000000011',
      mountId: '00000000-0000-4000-8000-000000000012',
    };
    const selectors = ['00000000-0000-4000-8000-000000000001', '00000000-0000-4000-8000-000000000002']
      .map(localSessionId => sessionReference({ ...ref, localSessionId }));
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    try {
      printResult('session', 'list', { success: true, data: [
        ...selectors.map(sessionId => ({ sessionId, lastActiveAt: '2026-10-04T01:36:00Z', runtime: 'codex', title: 'Remote' })),
        { sessionId: 'local-session', lastActiveAt: '2026-10-04T01:36:00Z', runtime: 'builtin', title: 'Local' },
      ] }, false);
      const lines = log.mock.calls.map(call => String(call[0]));
      for (const selector of selectors) {
        expect(lines.some(line => line.startsWith(`${selector}  `))).toBe(true);
        expect(buildRequestBody('session', 'state', [selector], {})).toEqual({ sessionId: selector });
      }
      const rows = lines.slice(1);
      expect(new Set(rows.map(row => row.indexOf('2026-10-04T01:36:00Z'))).size).toBe(1);
    } finally {
      log.mockRestore();
    }
  });

  it.each(['status', 'version', 'reload'])('accepts -h and --help for %s', command => {
    for (const flag of ['-h', '--help']) {
      const parsed = parseArgs([command, flag]);
      expect(parsed).toEqual({ positional: [command], flags: { help: true } });
      expect(validateCliCommand(parsed.positional, true)).toBeUndefined();
    }
    expect(parseArgs(['-h', command]).positional).toEqual([command]);
  });

  it('prints a duplicate title/preview once and keeps distinct previews', () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    printResult('session', 'list', { success: true, data: [
      { sessionId: 'one', title: 'Same title', lastMessagePreview: 'Same title' },
      { sessionId: 'two', title: 'Another title', lastMessagePreview: 'Recent reply' },
    ] }, false);
    const output = log.mock.calls.flat().join('\n');
    expect(output.match(/Same title/g)).toHaveLength(1);
    expect(output).toContain('Recent reply');
    log.mockRestore();
  });
});

describe('skill source normalization', () => {
  it('resolves only explicit relative local paths against the CLI caller cwd', () => {
    const cwd = join(tmpdir(), 'skill-caller');
    expect(normalizeSkillSourceForRequest('./private-skill', cwd))
      .toBe(join(cwd, 'private-skill'));
    expect(normalizeSkillSourceForRequest('../private.skill', cwd))
      .toBe(join(tmpdir(), 'private.skill'));
  });

  it('preserves GitHub shorthand, file URLs, and absolute paths', () => {
    expect(normalizeSkillSourceForRequest('private/example', '/tmp/caller'))
      .toBe('private/example');
    expect(normalizeSkillSourceForRequest('file:///tmp/private.skill', '/tmp/caller'))
      .toBe('file:///tmp/private.skill');
    expect(normalizeSkillSourceForRequest('/tmp/private-skill', '/tmp/caller'))
      .toBe('/tmp/private-skill');
  });

  it('normalizes an explicit relative source in the skill add request body', () => {
    expect(buildRequestBody('skill', 'add', ['./private-skill'], { dryRun: true }))
      .toMatchObject({
        url: join(process.cwd(), 'private-skill'),
        scope: 'user',
        dryRun: true,
      });
  });

  it('keeps skill sync preview-only and forwards removal previews without choosing the wrong scope', () => {
    expect(buildRequestBody('skill', 'sync', [], {})).toEqual({ apply: false, names: [] });
    expect(buildRequestBody('skill', 'sync', ['one'], { apply: true })).toEqual({ apply: true, names: ['one'] });
    expect(buildRequestBody('skill', 'remove', ['one'], { dryRun: true, workspace: '/workspace' }))
      .toMatchObject({ name: 'one', scope: undefined, workspacePath: '/workspace', dryRun: true });
    expect(buildRequestBody('skill', 'list', [], { workspace: '/workspace' }))
      .toEqual({ workspacePath: '/workspace' });
  });

  it('normalizes an explicit relative source inside a pasted npx command', () => {
    const cwd = join(tmpdir(), 'skill-caller');
    expect(normalizeSkillSourceForRequest(
      'npx -y skills add ./private-skill --skill private',
      cwd,
    )).toBe(
      `npx -y skills add ${join(cwd, 'private-skill')} --skill private`,
    );
  });
});

describe('myagents CLI command grammar', () => {
  it.each(['diagnose', 'vision', 'im'])('identifies bare %s as missing a subcommand', group => {
    expect(validateCliCommand([group])).toMatchObject({ code: 'SUBCOMMAND_REQUIRED' });
    expect(validateCliCommand([group], true)).toBeUndefined();
  });

  it('distinguishes a published public command prefix from an unknown command', () => {
    expect(validateExternalCliInvocation(['runtime'], {})).toMatchObject({ code: 'SUBCOMMAND_REQUIRED' });
    expect(validateExternalCliInvocation(['runtime', 'unknown'], {})).toMatchObject({ code: 'UNKNOWN_COMMAND' });
    expect(validateCliCommand(['space', 'claim'])).toMatchObject({ code: 'SUBCOMMAND_REQUIRED' });
    expect(validateCliCommand(['space', 'claim'], true)).toBeUndefined();
  });

  it.each(['--bogus-flag', '--bogusFlag'])('preserves the actual unknown flag spelling %s', spelling => {
    const parsed = parseArgs(['runtime', 'list', spelling]);
    expect(validateInternalCliInvocation(parsed.positional, parsed.flags)?.error).toContain(spelling);
    expect(validateExternalCliInvocation(parsed.positional, parsed.flags)?.error).toContain(spelling);
  });

  it('rejects unknown groups and leaves before any HTTP request is possible', () => {
    expect(validateCliCommand(['definitely-unknown'])).toMatchObject({
      code: 'UNKNOWN_COMMAND_GROUP',
      error: expect.stringContaining('definitely-unknown'),
      suggestedCommand: 'myagents --help',
    });
  });

  it('rejects unknown leaves while accepting published nested commands', () => {
    expect(validateCliCommand(['mcp', 'definitely-unknown'])).toMatchObject({
      code: 'UNKNOWN_COMMAND',
      error: expect.stringContaining('mcp definitely-unknown'),
      suggestedCommand: 'myagents mcp --help',
    });
    expect(validateCliCommand(['mcp', 'oauth', 'start'])).toBeUndefined();
    expect(validateCliCommand(['space', 'issue', 'comment', 'get'])).toBeUndefined();
    expect(validateCliCommand(['task', 'trigger', 'test'])).toBeUndefined();
  });

  it('allows group-only help without treating the default action as a command', () => {
    expect(validateCliCommand(['config'], true)).toBeUndefined();
    expect(validateCliCommand(['im'], true)).toBeUndefined();
  });

  it('publishes AnyDoc under one command group and redirects the retired draft name', () => {
    expect(TOP_HELP).toContain('anydoc');
    expect(validateCliCommand(['anydoc', 'convert'])).toBeUndefined();
    expect(validateCliCommand(['anydoc', 'wait'])).toBeUndefined();
    expect(buildRoute('anydoc', 'wait', ['20260815_7f3a91c2b6d4']))
      .toBe('anydoc/status');
    expect(validateCliCommand(['document'])).toMatchObject({
      code: 'UNKNOWN_COMMAND_GROUP',
      suggestedCommand: 'myagents anydoc --help',
    });
  });

  it('publishes the Session-scoped speech commands without exposing scope arguments', () => {
    expect(TOP_HELP).toContain('speech');
    expect(validateCliCommand(['speech', 'transcribe'])).toBeUndefined();
    expect(validateCliCommand(['speech', 'wait'])).toBeUndefined();
    expect(buildRoute('speech', 'wait', ['speech_01'])).toBe('speech/status');
    expect(validateCliCommand(['speech', 'unknown'])).toMatchObject({
      code: 'UNKNOWN_COMMAND',
      suggestedCommand: 'myagents speech --help',
    });
  });
});

describe('myagents CLI AnyDoc contracts', () => {
  it('resolves source and output paths locally without forwarding CLI-only wait', () => {
    const parsed = parseArgs([
      'anydoc',
      'convert',
      '--file',
      './fixtures/report.docx',
      '--output',
      './converted',
      '--password',
      'marker-secret',
      '--wait',
    ]);
    expect(parsed.flags.wait).toBe(true);
    expect(buildRequestBody('anydoc', 'convert', [], parsed.flags)).toEqual({
      sourcePath: join(process.cwd(), 'fixtures/report.docx'),
      outputRoot: join(process.cwd(), 'converted'),
      password: 'marker-secret',
    });
  });

  it('keeps list bounded and gives status/cancel one exact job identity', () => {
    expect(buildRequestBody('anydoc', 'list', [], {})).toEqual({ limit: 20 });
    expect(buildRequestBody('anydoc', 'list', [], { limit: '100' })).toEqual({ limit: 100 });
    expect(buildRequestBody('anydoc', 'status', ['20260815_7f3a91c2b6d4'], {}))
      .toEqual({ jobId: '20260815_7f3a91c2b6d4' });
    expect(buildRequestBody('anydoc', 'cancel', ['20260815_7f3a91c2b6d4'], {}))
      .toEqual({ jobId: '20260815_7f3a91c2b6d4' });
  });

  it('rejects URLs, repeated files, dry-run, and invalid list bounds before transport', () => {
    const exit = vi.spyOn(process, 'exit').mockImplementation(((code?: number) => {
      throw new Error(`process.exit(${code})`);
    }) as typeof process.exit);
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      expect(() => buildRequestBody('anydoc', 'convert', [], {
        file: ['https://example.test/report.pdf'],
      })).toThrow('process.exit(2)');
      expect(() => buildRequestBody('anydoc', 'convert', [], {
        file: ['one.pdf', 'two.pdf'],
      })).toThrow('process.exit(2)');
      expect(() => buildRequestBody('anydoc', 'convert', [], {
        file: ['one.pdf'],
        dryRun: true,
      })).toThrow('process.exit(2)');
      expect(() => buildRequestBody('anydoc', 'list', [], { limit: '0' }))
        .toThrow('process.exit(2)');
    } finally {
      exit.mockRestore();
      error.mockRestore();
    }
  });

  it('prints an accepted receipt with actionable status and cancel commands', () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    try {
      printResult('anydoc', 'convert', {
        success: true,
        data: {
          job: {
            jobId: '20260815_7f3a91c2b6d4',
            state: 'queued',
            output: { documentPath: '/tmp/out/document.md' },
          },
        },
      }, false);
      const output = log.mock.calls.flat().join('\n');
      expect(output).toContain('myagents anydoc status 20260815_7f3a91c2b6d4');
      expect(output).toContain('myagents anydoc cancel 20260815_7f3a91c2b6d4');
      expect(output).toContain('/tmp/out/document.md');
    } finally {
      log.mockRestore();
    }
  });

  it('prints list items from the stable list response contract', () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    try {
      printResult('anydoc', 'list', {
        success: true,
        data: {
          items: [{
            jobId: '20260815_7f3a91c2b6d4',
            state: 'succeeded',
            output: { documentPath: '/tmp/out/document.md', artifactAvailable: true },
          }],
          retentionDays: 30,
        },
      }, false);
      expect(log.mock.calls.flat().join('\n')).toContain(
        '20260815_7f3a91c2b6d4  succeeded  /tmp/out/document.md',
      );
    } finally {
      log.mockRestore();
    }
  });

  it('keeps AnyDoc warnings and terminal errors off stdout', () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      printResult('anydoc', 'status', {
        success: true,
        data: {
          job: {
            jobId: '20260815_7f3a91c2b6d4',
            state: 'succeeded_with_warnings',
            stage: 'finalizing',
            output: { documentPath: '/tmp/out/document.md', artifactAvailable: true },
            warnings: [{ code: 'DOCUMENT_ASSET_SKIPPED', message: 'image omitted' }],
          },
        },
      }, false);
      expect(log.mock.calls.flat().join('\n')).not.toContain('image omitted');
      expect(error.mock.calls.flat().join('\n')).toContain(
        'Warning [DOCUMENT_ASSET_SKIPPED]: image omitted',
      );
      expect(log.mock.calls.flat().join('\n')).not.toContain('Stage: finalizing');
    } finally {
      log.mockRestore();
      error.mockRestore();
    }
  });

  it('does not advertise ghost artifact paths for terminal jobs', () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    try {
      printResult('anydoc', 'list', {
        success: true,
        data: {
          items: [
            {
              jobId: '20260815_failed000001',
              state: 'failed',
              output: { documentPath: '/tmp/ghost-failed/document.md', artifactAvailable: false },
            },
            {
              jobId: '20260815_cancelled001',
              state: 'cancelled',
              output: { documentPath: '/tmp/ghost-cancelled/document.md', artifactAvailable: false },
            },
          ],
        },
      }, false);
      printResult('anydoc', 'status', {
        success: true,
        data: {
          job: {
            jobId: '20260815_failed000001',
            state: 'failed',
            stage: 'finalizing',
            output: { documentPath: '/tmp/ghost-status/document.md', artifactAvailable: false },
          },
        },
      }, false);

      const output = log.mock.calls.flat().join('\n');
      expect(output).toContain('20260815_failed000001  failed  (no artifact)');
      expect(output).toContain('20260815_cancelled001  cancelled  (no artifact)');
      expect(output).toContain('Document: unavailable');
      expect(output).not.toContain('/tmp/ghost-');
      expect(output).not.toContain('Stage: finalizing');
    } finally {
      log.mockRestore();
    }
  });

  it('keeps active job progress visible without claiming an artifact', () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    try {
      printResult('anydoc', 'status', {
        success: true,
        data: {
          job: {
            jobId: '20260815_running00001',
            state: 'running',
            stage: 'ocr',
            output: { documentPath: '/tmp/future/document.md', artifactAvailable: false },
          },
        },
      }, false);

      const output = log.mock.calls.flat().join('\n');
      expect(output).toContain('Stage: ocr');
      expect(output).not.toContain('Document:');
      expect(output).not.toContain('/tmp/future/document.md');
    } finally {
      log.mockRestore();
    }
  });
});

describe('myagents CLI speech contracts', () => {
  it('resolves local paths without forwarding CLI-only wait or caller scope', () => {
    const parsed = parseArgs([
      'speech',
      'transcribe',
      '--file',
      './fixtures/meeting.m4a',
      '--output',
      './transcripts',
      '--wait',
    ]);

    expect(buildRequestBody('speech', 'transcribe', [], parsed.flags)).toEqual({
      sourcePath: join(process.cwd(), 'fixtures/meeting.m4a'),
      outputRoot: join(process.cwd(), 'transcripts'),
    });
  });

  it('keeps list bounded and management commands tied to one exact job id', () => {
    expect(buildRequestBody('speech', 'list', [], {})).toEqual({ limit: 20 });
    expect(buildRequestBody('speech', 'list', [], { limit: '100' })).toEqual({ limit: 100 });
    expect(buildRequestBody('speech', 'status', ['speech_01'], {})).toEqual({ jobId: 'speech_01' });
    expect(buildRequestBody('speech', 'wait', ['speech_01'], {})).toEqual({ jobId: 'speech_01' });
    expect(buildRequestBody('speech', 'cancel', ['speech_01'], {})).toEqual({ jobId: 'speech_01' });
  });

  it('rejects URLs, repeated files, scope flags, dry-run, and invalid list bounds', () => {
    const exit = vi.spyOn(process, 'exit').mockImplementation(((code?: number) => {
      throw new Error(`process.exit(${code})`);
    }) as typeof process.exit);
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      expect(() => buildRequestBody('speech', 'transcribe', [], {
        file: ['https://example.test/meeting.m4a'],
      })).toThrow('process.exit(2)');
      expect(() => buildRequestBody('speech', 'transcribe', [], {
        file: ['one.wav', 'two.wav'],
      })).toThrow('process.exit(2)');
      expect(() => buildRequestBody('speech', 'transcribe', [], {
        file: ['meeting.wav'],
        sessionId: 'forged-session',
      })).toThrow('process.exit(2)');
      expect(() => buildRequestBody('speech', 'transcribe', [], {
        file: ['meeting.wav'],
        workspace: '/tmp/forged-workspace',
      })).toThrow('process.exit(2)');
      expect(() => buildRequestBody('speech', 'transcribe', [], {
        file: ['meeting.wav'],
        dryRun: true,
      })).toThrow('process.exit(2)');
      expect(() => buildRequestBody('speech', 'list', [], { limit: '101' }))
        .toThrow('process.exit(2)');
    } finally {
      exit.mockRestore();
      error.mockRestore();
    }
  });

  it('prints accepted jobs and does not advertise an unavailable artifact', () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    try {
      printResult('speech', 'transcribe', {
        success: true,
        data: {
          job: {
            jobId: 'speech_01',
            state: 'queued',
            output: { transcriptMarkdownPath: '/workspace/transcripts/speech_01/transcript.md' },
          },
        },
      }, false);
      printResult('speech', 'status', {
        success: true,
        data: {
          job: {
            jobId: 'speech_failed',
            state: 'failed',
            output: {
              transcriptMarkdownPath: '/workspace/transcripts/speech_failed/transcript.md',
              artifactAvailable: false,
            },
          },
        },
      }, false);

      const output = log.mock.calls.flat().join('\n');
      expect(output).toContain('myagents speech status speech_01');
      expect(output).toContain('myagents speech cancel speech_01');
      expect(output).toContain('Transcript: unavailable');
      expect(output).not.toContain('/workspace/transcripts/speech_failed/transcript.md');
    } finally {
      log.mockRestore();
    }
  });
});

describe('myagents CLI Sidecar capability diagnostics', () => {
  it('turns Global Sidecar reload rejection into an actionable Session-only error', () => {
    expect(adminHttpErrorResult('reload', 404, 'Not Found')).toMatchObject({
      success: false,
      code: 'SESSION_SIDECAR_REQUIRED',
      error: expect.stringContaining('Session Sidecar'),
      suggestedCommand: 'myagents reload --help',
    });
  });
});

describe('myagents CLI Task notification updates', () => {
  it('accepts exact targets, explicit off/current, empty events and receipt-only operations', () => {
    for (const target of ['off', 'current', '{"type":"conversation","channelId":"c","sessionKey":"group:one"}']) {
      expect(buildRequestBody('task', 'update', ['t'], { notificationTarget: target, notificationEvents: '[]' })).toMatchObject({ notificationPatch: { version: 1, events: [], im: target.startsWith('{') ? JSON.parse(target) : { type: target } } });
    }
    expect(() => buildRequestBody('task', 'update', ['t'], { notificationTarget: 'off', notificationBotChannelId: 'c' })).toThrow();
    expect(buildRequestBody('task', 'notification', ['t'], { deliveryId: 'd', action: 'cancel' })).toEqual({ taskId: 't', deliveryId: 'd', action: 'cancel' });
  });
  it('sends only provided notification fields in the single update mutation', () => {
    expect(buildRequestBody('task', 'update', ['task-1'], {
      notificationDesktop: 'false',
      notificationBotChannelId: 'bot-b',
    })).toEqual({
      id: 'task-1',
      notificationPatch: {
        version: 1,
        desktop: false,
        botChannelId: 'bot-b',
      },
    });
  });

  it('omits notificationPatch when no notification flag was provided', () => {
    expect(buildRequestBody('task', 'update', ['task-1'], {
      name: 'renamed',
    })).toEqual({
      id: 'task-1',
      name: 'renamed',
    });
  });

  it('projects taskMdContentFile into the Task update prompt', () => {
    const dir = mkdtempSync(join(tmpdir(), 'myagents-task-update-'));
    const file = join(dir, 'task.md');
    writeFileSync(file, '# Updated task\n');
    try {
      expect(buildRequestBody('task', 'update', ['task-1'], {
        taskMdContentFile: file,
      })).toEqual({ id: 'task-1', prompt: '# Updated task\n' });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('myagents CLI Task comments', () => {
  it('keeps an explicit Task identity for injected follow-up turns', () => {
    process.env.MYAGENTS_SESSION_ID = 'session-comment';
    expect(buildRequestBody('task', 'comment', ['task-1'], {
      body: 'Verification passed.',
      replyTo: 'comment-user',
    })).toEqual({
      id: 'task-1',
      body: 'Verification passed.',
      replyToCommentId: 'comment-user',
    });
  });

  it('lets the Session Sidecar resolve Task identity only for an active Task turn', () => {
    process.env.MYAGENTS_SESSION_ID = 'session-task-turn';
    expect(buildRequestBody('task', 'comment', [], { body: 'Work completed.' })).toEqual({
      id: undefined,
      body: 'Work completed.',
      replyToCommentId: undefined,
    });
  });
});

describe('myagents CLI Task provider overrides', () => {
  it('forwards the original task.md file path so Rust can re-read app-owned discussion candidates', () => {
    const dir = mkdtempSync(join(tmpdir(), 'myagents-task-candidate-'));
    const file = join(dir, 'task.md');
    writeFileSync(file, '# Current candidate\n');
    try {
      expect(buildRequestBody('task', 'create-direct', ['review'], {
        taskMdFile: file,
      })).toMatchObject({
        taskMdContent: '# Current candidate\n',
        taskMdFile: file,
      });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('forwards providerId with model through Task creation', () => {
    expect(buildRequestBody('task', 'create-direct', ['review'], {
      providerId: 'deepseek',
      model: 'deepseek-chat',
      taskMdContent: 'Review the workspace.',
    })).toMatchObject({
      providerId: 'deepseek',
      model: 'deepseek-chat',
    });
  });

  it('keeps providerId with model on Task update', () => {
    expect(buildRequestBody('task', 'update', ['task-1'], {
      providerId: 'deepseek',
      model: 'deepseek-chat',
    })).toEqual({
      id: 'task-1',
      providerId: 'deepseek',
      model: 'deepseek-chat',
    });
  });
});

describe('myagents CLI Task Detector contracts', () => {
  const trigger = {
    source: { type: 'time' },
    detector: {
      type: 'command',
      command: {
        executable: 'node',
        args: ['scripts/watch inbox.js', '--mode', 'strict'],
        cwd: '/tmp',
      },
      timeoutMs: 10_000,
    },
  };

  it('warns in help that Detector test runs real external side effects', () => {
    expect(TOP_HELP).toContain('Test does not commit MyAgents checkpoint/Activation state');
    expect(TOP_HELP).toContain('external side effects are not rolled back');
  });

  it('routes nested Trigger actions and reads specs/checkpoint fixtures without splitting args', () => {
    const dir = mkdtempSync(join(tmpdir(), 'myagents-trigger-cli-'));
    try {
      const spec = join(dir, 'trigger.json');
      const checkpoint = join(dir, 'checkpoint.json');
      writeFileSync(spec, JSON.stringify(trigger));
      writeFileSync(checkpoint, JSON.stringify({ cursor: '消息 42' }));

      expect(buildRoute('task', 'trigger', ['validate'])).toBe('task/trigger/validate');
      expect(buildRoute('task', 'trigger', ['test', 'task-1'])).toBe('task/trigger/test');
      expect(buildRequestBody('task', 'trigger', ['validate'], { specFile: spec })).toEqual({
        trigger,
      });
      expect(buildRequestBody('task', 'trigger', ['test', 'task-1'], {
        checkpointFile: checkpoint,
        expect: 'quiet',
      })).toEqual({
        taskId: 'task-1',
        checkpoint: { cursor: '消息 42' },
        expect: 'quiet',
      });
      writeFileSync(checkpoint, JSON.stringify({ revision: 1, value: { cursor: 1 } }));
      const exit = vi.spyOn(process, 'exit').mockImplementation(((code?: number) => {
        throw new Error(`process.exit(${code})`);
      }) as typeof process.exit);
      const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
      try {
        expect(() => buildRequestBody('task', 'trigger', ['test', 'task-1'], { checkpointFile: checkpoint }))
          .toThrow('process.exit(2)');
        expect(error.mock.calls.map(([line]) => String(line)).join('\n')).toContain('not a {revision, value} wrapper');
      } finally {
        exit.mockRestore();
        error.mockRestore();
      }
      expect(buildRequestBody('task', 'trigger', ['test'], {
        specFile: spec,
        workspacePath: '/tmp/work space',
      })).toEqual({
        trigger,
        workspacePath: '/tmp/work space',
      });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('resolves current Session before create and supports trigger update/clear actions', () => {
    const previous = process.env.MYAGENTS_SESSION_ID;
    const dir = mkdtempSync(join(tmpdir(), 'myagents-trigger-cli-'));
    try {
      process.env.MYAGENTS_SESSION_ID = 'session-canonical';
      const spec = join(dir, 'trigger.json');
      writeFileSync(spec, JSON.stringify(trigger));
      expect(buildRequestBody('task', 'create-direct', ['watch inbox'], {
        workspaceId: 'ws',
        workspacePath: '/tmp/workspace',
        taskMdContent: 'React only when the detector activates.',
        executionMode: 'recurring',
        intervalMinutes: '5',
        runMode: 'single-session',
        preselectedSessionId: 'current',
        triggerFile: spec,
        deadline: '2026-08-31T23:59:00+08:00',
        maxExecutions: '1',
        aiCanExit: 'true',
      })).toMatchObject({
        runMode: 'single-session',
        preselectedSessionId: 'session-canonical',
        trigger,
        endConditions: {
          deadline: Date.parse('2026-08-31T23:59:00+08:00'),
          maxExecutions: 1,
          aiCanExit: true,
        },
      });
      expect(buildRequestBody('task', 'update', ['task-1'], {
        triggerFile: spec,
      })).toEqual({ id: 'task-1', trigger });
      expect(buildRequestBody('task', 'update', ['task-1'], {
        clearTrigger: true,
      })).toEqual({ id: 'task-1', clearTrigger: true });
      expect(buildRequestBody('task', 'check-now', ['task-1'], {})).toEqual({ id: 'task-1' });
      expect(buildRequestBody('task', 'run-now', ['task-1'], {})).toEqual({
        id: 'task-1',
        actor: 'agent',
        source: 'cli',
      });
      expect(buildRequestBody('task', 'reset-checkpoint', ['task-1'], {})).toEqual({ id: 'task-1' });
    } finally {
      if (previous === undefined) delete process.env.MYAGENTS_SESSION_ID;
      else process.env.MYAGENTS_SESSION_ID = previous;
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('keeps scheduled Task governance on canonical task aliases', () => {
    expect(buildRoute('task', 'readme', [])).toBe('readme/task');
    expect(buildRoute('task', 'start', ['task-1'])).toBe('task/start');
    expect(buildRoute('task', 'stop', ['task-1'])).toBe('task/stop');
    expect(buildRoute('task', 'runs', ['task-1'])).toBe('task/runs');
    expect(buildRoute('task', 'exit', [])).toBe('cron/exit');
    expect(buildRequestBody('task', 'start', ['task-1'], {})).toEqual({
      taskId: 'task-1',
      actor: 'user',
      source: 'cli',
    });
    expect(buildRequestBody('task', 'stop', ['task-1'], {})).toEqual({
      taskId: 'task-1',
      actor: 'user',
      source: 'cli',
    });
    expect(buildRequestBody('task', 'runs', ['task-1'], { limit: '3' })).toEqual({
      taskId: 'task-1',
      limit: 3,
    });
    expect(buildRequestBody('task', 'exit', [], { reason: 'complete' })).toEqual({
      reason: 'complete',
    });
    expect(TOP_HELP).toContain('myagents task start <taskId>');
    expect(TOP_HELP).toContain('myagents task exit --reason');
  });

  it('rejects malformed values on canonical scheduled Task aliases', () => {
    const exit = vi.spyOn(process, 'exit').mockImplementation(((code?: number) => {
      throw new Error(`process.exit(${code})`);
    }) as typeof process.exit);
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    try {
      expect(() => buildRequestBody('task', 'exit', [], { reason: true }))
        .toThrow('process.exit(2)');
      expect(error).toHaveBeenLastCalledWith(expect.stringContaining('--reason requires a value'));

      expect(() => buildRequestBody('task', 'start', [], { id: true }))
        .toThrow('process.exit(2)');
      expect(error).toHaveBeenLastCalledWith(expect.stringContaining('--id requires a value'));

      expect(() => buildRequestBody('task', 'runs', ['task-1'], { limit: 'abc' }))
        .toThrow('process.exit(2)');
      expect(error).toHaveBeenLastCalledWith('Error: task runs --limit must be a positive integer.');

      expect(() => buildRequestBody('task', 'runs', ['task-1'], { limit: '0' }))
        .toThrow('process.exit(2)');
      expect(error).toHaveBeenLastCalledWith('Error: task runs --limit must be a positive integer.');
    } finally {
      exit.mockRestore();
      error.mockRestore();
    }
  });

  it('parses clear-trigger as a presence flag without consuming the next flag', () => {
    expect(parseArgs(['task', 'update', 'task-1', '--clear-trigger', '--json'])).toEqual({
      positional: ['task', 'update', 'task-1'],
      flags: { clearTrigger: true, json: true },
    });
  });

  it('builds compact Task discovery filters and exposes the existing interval startAt', () => {
    expect(buildRequestBody('task', 'list', [], { query: 'release', limit: '20' })).toEqual({
      workspaceId: undefined,
      workspacePath: undefined,
      status: undefined,
      tag: undefined,
      query: 'release',
      limit: 20,
      includeDeleted: undefined,
    });
    expect(buildRequestBody('task', 'create-direct', ['watch later'], {
      taskMdContent: 'Check the external state.',
      executionMode: 'recurring',
      intervalMinutes: '60',
      startAt: '2026-08-04T09:00:00+08:00',
    })).toMatchObject({
      workspaceId: undefined,
      workspacePath: undefined,
      startAt: '2026-08-04T01:00:00.000Z',
      actor: 'user',
      source: 'cli',
    });
  });

  it('rejects an invalid --expect before a request can be built', () => {
    const exit = vi.spyOn(process, 'exit').mockImplementation(((code?: number) => {
      throw new Error(`process.exit(${code})`);
    }) as typeof process.exit);
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    try {
      expect(() => buildRequestBody('task', 'trigger', ['test', 'task-1'], {
        expect: 'activte',
      })).toThrow('process.exit(2)');
      expect(error).toHaveBeenCalledWith('Error: --expect must be quiet or activate.');
    } finally {
      exit.mockRestore();
      error.mockRestore();
    }
  });

  it('rejects unsafe, malformed, and oversized Detector fixture files', () => {
    const dir = mkdtempSync(join(tmpdir(), 'myagents-trigger-files-'));
    const exit = vi.spyOn(process, 'exit').mockImplementation(((code?: number) => {
      throw new Error(`process.exit(${code})`);
    }) as typeof process.exit);
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    try {
      const invalid = join(dir, 'invalid.json');
      const nul = join(dir, 'nul.json');
      const utf8 = join(dir, 'utf8.json');
      const oversized = join(dir, 'oversized.json');
      const target = join(dir, 'target.json');
      const link = join(dir, 'link.json');
      writeFileSync(invalid, '{');
      writeFileSync(nul, Buffer.from('{"x":"\0"}'));
      writeFileSync(utf8, Buffer.from([0xff, 0xfe]));
      writeFileSync(oversized, Buffer.alloc(256 * 1024 + 1, 0x20));
      writeFileSync(target, JSON.stringify(trigger));
      if (process.platform !== 'win32') symlinkSync(target, link);

      const rejected = [invalid, nul, utf8, oversized, join(dir, 'missing.json')];
      if (process.platform !== 'win32') rejected.push(link);
      for (const specFile of rejected) {
        expect(() => buildRequestBody('task', 'trigger', ['validate'], { specFile }))
          .toThrow('process.exit(2)');
      }
      expect(exit).toHaveBeenCalled();
      expect(error).toHaveBeenCalled();
    } finally {
      exit.mockRestore();
      error.mockRestore();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('prints complete program-failure diagnostics in human mode', () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    try {
      printResult('task', 'trigger', {
        success: false,
        error: 'Detector timed out',
        data: {
          result: {
            durationMs: 300_001,
            error: {
              code: 'detector_timeout',
              message: 'Detector timed out',
              occurredAt: 1_775_000_000_000,
              exitCode: 17,
              signal: 'SIGKILL',
              timedOut: true,
              stderrTail: 'tail',
            },
          },
        },
      }, false, {}, ['test']);

      const output = error.mock.calls.flat().join('\n');
      expect(output).toContain('detector_timeout');
      expect(output).toContain('17');
      expect(output).toContain('SIGKILL');
      expect(output).toContain('true');
      expect(output).toContain('tail');
      expect(output).toContain('2026-');
    } finally {
      error.mockRestore();
    }
  });

  it('prints every Trigger command in human/JSON mode and maps command failure to exit 1', () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    try {
      const validate = { success: true };
      const test = {
        success: true,
        data: {
          result: {
            decision: 'activate',
            reason: { code: 'changed', message: 'Changed' },
            event: { id: 'event-1', kind: 'state.changed', occurredAt: '2026-08-03T00:00:00Z' },
            handoff: { summary: 'Changed' },
            durationMs: 12,
            exitCode: 0,
          },
        },
      };
      const check = {
        success: true,
        data: { result: { outcome: 'quiet', state: { checkCount: 4 } } },
      };
      const reset = { success: true };
      printResult('task', 'trigger', validate, false, {}, ['validate']);
      printResult('task', 'trigger', test, false, {}, ['test']);
      printResult('task', 'check-now', check, false);
      printResult('task', 'reset-checkpoint', reset, false);
      expect(log.mock.calls.flat()).toContain('✓ Trigger spec is valid');
      expect(log.mock.calls.flat()).toContain('✓ Detector test completed (MyAgents state was not committed)');
      expect(log.mock.calls.flat()).toContain('  decision: activate');
      expect(log.mock.calls.flat()).toContain('✓ Detector check completed');
      expect(log.mock.calls.flat()).toContain('  outcome: quiet');
      expect(log.mock.calls.flat()).toContain('  checks:  4');
      expect(log.mock.calls.flat()).toContain('✓ Detector checkpoint reset');

      for (const [action, result, rest] of [
        ['trigger', validate, ['validate']],
        ['trigger', test, ['test']],
        ['check-now', check, []],
        ['reset-checkpoint', reset, []],
      ] as const) {
        log.mockClear();
        printResult('task', action, result, true, {}, [...rest]);
        expect(JSON.parse(String(log.mock.calls[0]?.[0]))).toEqual(result);
      }
      expect(commandResultExitCode({ success: true })).toBe(0);
      expect(commandResultExitCode({ success: false, error: 'Detector failed' })).toBe(1);
    } finally {
      log.mockRestore();
    }
  });

  it.each(['check-now', 'reset-checkpoint'])('rejects missing task id for %s with exit 1', (action) => {
    const exit = vi.spyOn(process, 'exit').mockImplementation(((code?: number) => {
      throw new Error(`process.exit(${code})`);
    }) as typeof process.exit);
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    try {
      expect(() => buildRequestBody('task', action, [], {})).toThrow('process.exit(1)');
    } finally {
      exit.mockRestore();
      error.mockRestore();
    }
  });
});

describe('myagents CLI Task dispatch output', () => {
  it.each(['run', 'rerun'])('hides only the internal %s attempt ordinal and preserves the semantic receipt', (action) => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    try {
      printResult('task', action, {
        success: true,
        data: {
          task: { id: 'task-1', status: 'running' },
          attemptOrdinal: 4,
          receipt: {
            operation: action,
            taskId: 'task-1',
            status: 'running',
            statusMeaning: 'The Task scheduler is enabled.',
            changed: true,
          },
        },
      }, true);

      expect(JSON.parse(String(log.mock.calls[0]?.[0]))).toEqual({
        success: true,
        data: {
          task: { id: 'task-1', status: 'running' },
          receipt: {
            operation: action,
            taskId: 'task-1',
            status: 'running',
            statusMeaning: 'The Task scheduler is enabled.',
            changed: true,
          },
        },
      });
    } finally {
      log.mockRestore();
    }
  });
});

describe('myagents CLI Space issue contracts', () => {
  it('advertises the modern Space Issue entry without the stale legacy issue alias', () => {
    expect(TOP_HELP).toContain('space     Discover Cloud Goals and manage Space Issues/attachments');
    expect(TOP_HELP).toContain('myagents space issue view <issueId> --space <slug> --comments --json');
    expect(TOP_HELP).not.toContain('issue     Legacy read-only alias for Space issue view');
  });

  it('routes Goal discovery and builds scoped Goal/update request bodies', () => {
    expect(buildRoute('space', 'goal', ['list'])).toBe('space/goal-list');
    expect(buildRequestBody('space', 'goal', ['list'], {
      space: 'official',
      workspacePath: '/workspace',
      includeArchived: true,
    })).toMatchObject({
      spaceSlug: 'official',
      workspacePath: '/workspace',
      includeArchived: true,
    });

    expect(buildRoute('space', 'issue', ['update', 'iss_1'])).toBe('space/issue-update');
    expect(buildRequestBody('space', 'issue', ['update', 'iss_1'], {
      space: 'official',
      workspacePath: '/workspace',
      title: 'Updated title',
      goal: 'goal_cli',
      humanOnly: 'false',
    })).toMatchObject({
      spaceSlug: 'official',
      issueId: 'iss_1',
      title: 'Updated title',
      goalUpdate: { action: 'set', goalId: 'goal_cli' },
      humanOnly: false,
    });
    expect(buildRequestBody('space', 'issue', ['update', 'iss_1'], {
      space: 'official',
      workspacePath: '/workspace',
      clearGoal: true,
    })).toMatchObject({
      issueId: 'iss_1',
      goalUpdate: { action: 'clear' },
    });
    const titleOnly = buildRequestBody('space', 'issue', ['update', 'iss_1'], {
      space: 'official',
      workspacePath: '/workspace',
      title: 'No Goal change',
    });
    expect(titleOnly).not.toHaveProperty('goalUpdate');
  });

  it.each([
    {
      action: 'issue',
      rest: ['list'],
      route: 'space/issue-list',
      body: { spaceSlug: 'official', workspacePath: '/workspace' },
      flags: {},
    },
    {
      action: 'goal',
      rest: ['list'],
      route: 'space/goal-list',
      body: { spaceSlug: 'official', workspacePath: '/workspace', includeArchived: false },
      flags: {},
    },
    {
      action: 'assignee',
      rest: ['list'],
      route: 'space/assignee-list',
      body: { spaceSlug: 'official', workspacePath: '/workspace' },
      flags: {},
    },
    {
      action: 'whoami',
      rest: [],
      route: 'space/whoami',
      body: { spaceSlug: 'official', workspacePath: '/workspace' },
      flags: {},
    },
    {
      action: 'issue',
      rest: ['attachment', 'add', 'iss_523'],
      route: 'space/attachment-add',
      body: {
        spaceSlug: 'official',
        workspacePath: '/workspace',
        issueId: 'iss_523',
        filePaths: ['evidence.png'],
      },
      flags: { file: ['evidence.png'] },
    },
  ])('keeps #523/#524 $route requests on exact leaf contracts', ({
    action,
    rest,
    route,
    body,
    flags,
  }) => {
    const actualRoute = buildRoute('space', action, rest);
    const actualBody = buildRequestBody('space', action, rest, {
      space: 'official',
      workspacePath: '/workspace',
      ...flags,
    });

    expect(actualRoute).toBe(route);
    expect(actualRoute).not.toMatch(/^space\/(issue|goal|assignee|attachment)$/);
    expect(actualBody).toMatchObject(body);
  });

  it('parses presence flags and explicit human-only booleans without swallowing later flags', () => {
    expect(parseArgs([
      'space', 'goal', 'list', '--space', 'official', '--include-archived', '--json',
    ])).toMatchObject({
      positional: ['space', 'goal', 'list'],
      flags: { space: 'official', includeArchived: true, json: true },
    });
    expect(parseArgs([
      'space', 'issue', 'update', 'iss_1', '--clear-goal', '--json', '--human-only', 'false',
    ])).toMatchObject({
      positional: ['space', 'issue', 'update', 'iss_1'],
      flags: { clearGoal: true, json: true, humanOnly: 'false' },
    });
    expect(parseArgs(['--human-only'])).toMatchObject({ flags: { humanOnly: true } });
    expect(parseArgs(['--human-only=true'])).toMatchObject({ flags: { humanOnly: 'true' } });
    expect(parseArgs(['--human-only=false'])).toMatchObject({ flags: { humanOnly: 'false' } });
    expect(parseArgs(['--human-only', 'maybe', '--json'])).toMatchObject({
      positional: ['maybe'],
      flags: { humanOnly: true, humanOnlyInvalidValue: 'maybe', json: true },
    });
    expect(parseArgs(['record', 'list', '--all', '-p', 'next'])).toMatchObject({
      positional: ['record', 'list'],
      flags: { all: true, prompt: 'next' },
    });
  });

  it('keeps canonical Record requests and legacy Thought aliases distinct', () => {
    expect(TOP_HELP).toContain('record    Manage unified text and audio Records');
    expect(TOP_HELP).toContain('thought   Legacy compatibility alias');
    expect(TOP_HELP).toContain('myagents record list');
    expect(TOP_HELP).not.toContain('  myagents thought list');
    expect(buildRoute('record', 'list', [])).toBe('record/list');
    expect(buildRoute('record', 'create', [])).toBe('record/create');
    expect(buildRequestBody('record', 'list', [], {
      kind: 'audio',
      tag: 'meeting',
      query: 'roadmap',
      limit: '20',
      all: true,
    })).toEqual({
      kind: 'audio',
      tag: 'meeting',
      query: 'roadmap',
      limit: 20,
      archived: 'all',
    });
    expect(buildRequestBody('record', 'create', ['  # Note  '], {})).toEqual({
      content: '# Note',
    });
    expect(buildRoute('thought', 'list', [])).toBe('thought/list');
    expect(buildRequestBody('thought', 'list', [], {
      archived: true,
    })).toEqual({
      kind: undefined,
      tag: undefined,
      query: undefined,
      limit: undefined,
      archived: 'archived',
    });
  });

  it('shows Record creation identity and Space entries in human output', () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    try {
      printResult('record', 'create', { success: true, data: { record: {
        id: 'record-123', title: 'Meeting note', kind: 'text',
      } } }, false);
      expect(log.mock.calls.map(([line]) => String(line)).join('\n')).toContain('record-123');
      log.mockClear();
      printResult('space', 'list', { success: true, data: { items: [
        { slug: 'research-hub', name: 'Research Hub', role: 'owner' },
      ] } }, false);
      expect(log.mock.calls.map(([line]) => String(line)).join('\n')).toContain('research-hub');
    } finally {
      log.mockRestore();
    }
  });

  it('renders Space identity, assignee ids, and effective project Skill state', () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    try {
      printResult('space', 'whoami', { success: true, data: {
        space: { slug: 'myagents', name: 'MyAgents' },
        actor: { type: 'registered_agent', id: 'agent-1', name: 'Mino', source: 'registered_agent_session',
          owner: { name: 'Ethan', role: 'owner' } },
      } }, false);
      printResult('space', 'assignee', { success: true, data: { items: [
        { assigneeId: 'agent:agent-1', name: 'Mino', isSelf: true },
      ] } }, false, {}, ['list']);
      printResult('skill', 'disable', { success: true, data: {
        name: 'nano-pdf', scope: 'project', enabled: false,
      } }, false);
      const output = log.mock.calls.map(([line]) => String(line)).join('\n');
      expect(output).toContain('registered_agent:agent-1');
      expect(output).toContain('Binding: registered_agent_session');
      expect(output).toContain('agent:agent-1');
      expect(output).toContain('Skill nano-pdf disabled');
      expect(output).toContain('scope: project');
    } finally { log.mockRestore(); }
  });

  it('shows structured results for commands without a dedicated text printer', () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    try {
      printResult('space', 'issue', { success: true, data: { items: [
        { id: 'issue-1', state: 'todo' },
      ] } }, false, {}, ['list']);
      const output = log.mock.calls.map(([line]) => String(line)).join('\n');
      expect(output).toContain('issue-1');
      expect(output).toContain('todo');
    } finally { log.mockRestore(); }
  });

  it('labels permission modes as capabilities of the selected runtime', () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    try {
      printResult('runtime', 'describe', { success: true, data: {
        runtime: 'dsh', displayName: 'DSH', installed: true,
        permissionModes: [{ value: 'auto', label: 'Auto' }],
      } }, false);
      expect(log.mock.calls.map(([line]) => String(line)).join('\n'))
        .toContain('Permission modes supported by this runtime:');
    } finally { log.mockRestore(); }
  });

  it('shows the updated Task identity and authoritative state in human output', () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    try {
      printResult('task', 'update', { success: true, data: { task: {
        id: 'task-123', name: 'Daily check', description: 'Check the inbox', status: 'stopped', executionMode: 'recurring',
        docs: { taskMd: '/tmp/task.md' },
      } } }, false);
      const output = log.mock.calls.map(([line]) => String(line)).join('\n');
      expect(output).toContain('Task updated task-123');
      expect(output).toContain('status: stopped');
      expect(output).toContain('description: Check the inbox');
      expect(output).toContain('task.md: /tmp/task.md');
      expect(output).toContain('myagents task get task-123');
    } finally {
      log.mockRestore();
    }
  });

  it('shows current subscriptions separately from the last execution notification decision', () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    try {
      printResult('task', 'get', { success: true, data: {
        id: 'task-notification', name: 'Task', status: 'done',
        notificationDestination: { label: 'Origin chat', availability: 'configured', events: ['execution'], executionResultsSubscribed: true },
        lastExecution: { notification: { events: ['execution', 'done', 'endCondition'], subscribedEvents: [], reason: 'not-subscribed' } },
      } }, false);
      const output = log.mock.calls.map(([line]) => String(line)).join('\n');
      expect(output).toContain('Every execution: subscribed');
      expect(output).toContain('Origin chat (configured)');
      expect(output).toContain('Last execution: not-subscribed; events=execution, done, endCondition; subscribed=(none)');
    } finally { log.mockRestore(); }
  });

  it('prints Task mutation receipts with their task id and resulting status', () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    try {
      printResult('task', 'update-status', { success: true, data: { task: { id: 'task-123', status: 'done' } } }, false);
      printResult('task', 'delete', { success: true, data: { taskId: 'task-123', status: 'deleted' } }, false);
      const output = log.mock.calls.map(([line]) => String(line)).join('\n');
      expect(output).toContain('Task update-status task-123');
      expect(output).toContain('status: done');
      expect(output).toContain('Task delete task-123');
      expect(output).toContain('status: deleted');
    } finally {
      log.mockRestore();
    }
  });

  it('rejects canonical-only Record kind filters on the legacy Thought alias', () => {
    const exit = vi.spyOn(process, 'exit').mockImplementation(((code?: number) => {
      throw new Error(`process.exit(${code})`);
    }) as typeof process.exit);
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    try {
      expect(() => buildRequestBody('thought', 'list', [], { kind: 'audio' }))
        .toThrow('process.exit(1)');
      expect(error).toHaveBeenLastCalledWith(
        'Error: thought list does not support --kind. Use myagents record list --kind text|audio.',
      );
    } finally {
      exit.mockRestore();
      error.mockRestore();
    }
  });

  it('accepts the existing goalId alias and each single body source for update', () => {
    expect(buildRequestBody('space', 'issue', ['update', 'iss_1'], {
      space: 'official',
      workspacePath: '/workspace',
      goalId: 'goal_legacy_alias',
    })).toMatchObject({
      issueId: 'iss_1',
      goalUpdate: { action: 'set', goalId: 'goal_legacy_alias' },
    });
    expect(buildRequestBody('space', 'issue', ['update', 'iss_1'], {
      space: 'official',
      workspacePath: '/workspace',
      body: 'replacement body',
    })).toMatchObject({ issueId: 'iss_1', body: 'replacement body' });

    const dir = mkdtempSync(join(process.cwd(), '.space-update-body-test-'));
    try {
      const bodyPath = join(dir, 'issue.md');
      writeFileSync(bodyPath, 'body from file', 'utf8');
      expect(buildRequestBody('space', 'issue', ['update', 'iss_1'], {
        space: 'official',
        workspacePath: dir,
        bodyFile: bodyPath,
      })).toMatchObject({ issueId: 'iss_1', body: 'body from file' });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('normalizes advertised Issue list booleans before Rust deserialization', () => {
    expect(buildRequestBody('space', 'issue', ['list'], {
      space: 'official',
      workspacePath: '/workspace',
      includeSubtree: 'false',
      humanOnly: 'true',
    })).toMatchObject({ includeSubtree: false, humanOnly: true });
    expect(buildRequestBody('space', 'issue', ['list'], {
      space: 'official',
      workspacePath: '/workspace',
      includeSubtree: 'true',
      humanOnly: 'false',
    })).toMatchObject({ includeSubtree: true, humanOnly: false });
  });

  it('keeps bare human-only compatible before a positional Issue id', () => {
    const { positional, flags } = parseArgs([
      'space', 'issue', 'update', '--human-only', 'iss_1', '--space', 'official',
    ]);
    expect(buildRequestBody(positional[0], positional[1], positional.slice(2), {
      ...flags,
      workspacePath: '/workspace',
    })).toMatchObject({ issueId: 'iss_1', humanOnly: true });
  });

  it('returns one structured local error for update conflicts, invalid booleans, and empty updates', () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const exit = vi.spyOn(process, 'exit').mockImplementation(((code?: number) => {
      throw new Error(`process.exit(${code})`);
    }) as typeof process.exit);
    try {
      const cases: Array<[Record<string, unknown>, string]> = [
        [{ json: true, space: 'official', goal: 'goal_1', clearGoal: true }, 'GOAL_SELECTION_CONFLICT'],
        [{ json: true, space: 'official', body: 'body', bodyFile: 'issue.md' }, 'BODY_SOURCE_CONFLICT'],
        [{ json: true, space: 'official', body: 'body', stdin: true }, 'BODY_SOURCE_CONFLICT'],
        [{ json: true, space: 'official', humanOnly: 'maybe' }, 'BOOLEAN_VALUE_INVALID'],
        [{ json: true, space: 'official', goal: true }, 'FLAG_VALUE_REQUIRED'],
        [{ json: true, space: 'official' }, 'ISSUE_UPDATE_EMPTY'],
      ];
      for (const [flags, code] of cases) {
        expect(() => buildRequestBody('space', 'issue', ['update', 'iss_1'], {
          workspacePath: '/workspace',
          ...flags,
        })).toThrow('process.exit(2)');
        expect(JSON.parse(String(log.mock.calls.at(-1)?.[0]))).toMatchObject({
          success: false,
          code,
          suggestion: expect.any(String),
        });
      }
      expect(error).not.toHaveBeenCalled();
    } finally {
      log.mockRestore();
      error.mockRestore();
      exit.mockRestore();
    }
  });

  it('rejects explicit empty Goal values on create instead of silently creating Inbox', () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const exit = vi.spyOn(process, 'exit').mockImplementation(((code?: number) => {
      throw new Error(`process.exit(${code})`);
    }) as typeof process.exit);
    try {
      for (const goalFlags of [{ goal: '' }, { goalId: '' }, { goal: true }]) {
        expect(() => buildRequestBody('space', 'issue', ['create'], {
          json: true,
          space: 'official',
          title: 'Must not publish',
          body: 'Explicit empty Goal is invalid.',
          ...goalFlags,
        })).toThrow('process.exit(2)');
        expect(JSON.parse(String(log.mock.calls.at(-1)?.[0]))).toMatchObject({
          success: false,
          code: 'FLAG_VALUE_REQUIRED',
        });
      }
    } finally {
      log.mockRestore();
      exit.mockRestore();
    }
  });

  it('validates the update identity before metadata fields', () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const exit = vi.spyOn(process, 'exit').mockImplementation(((code?: number) => {
      throw new Error(`process.exit(${code})`);
    }) as typeof process.exit);
    try {
      expect(() => buildRequestBody('space', 'issue', ['update'], {
        json: true,
        space: 'official',
        title: 'x',
      })).toThrow('process.exit(2)');
      expect(JSON.parse(String(log.mock.calls.at(-1)?.[0]))).toMatchObject({ code: 'ARGUMENT_REQUIRED' });

      expect(() => buildRequestBody('space', 'issue', ['update', 'iss_1'], {
        json: true,
        title: 'x',
      })).toThrow('process.exit(2)');
      expect(JSON.parse(String(log.mock.calls.at(-1)?.[0]))).toMatchObject({ code: 'SPACE_REQUIRED' });
    } finally {
      log.mockRestore();
      exit.mockRestore();
    }
  });

  it('rejects non-metadata update flags instead of partially applying a patch', () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const exit = vi.spyOn(process, 'exit').mockImplementation(((code?: number) => {
      throw new Error(`process.exit(${code})`);
    }) as typeof process.exit);
    try {
      for (const forbidden of [
        { state: 'done' },
        { assignee: 'agent:other' },
        { attachment: 'result.png' },
        { deliveryId: 'delivery_1' },
        { rollback: true },
        { expectedNotificationVersion: '4' },
        { localTaskId: 'task_1' },
      ]) {
        expect(() => buildRequestBody('space', 'issue', ['update', 'iss_1'], {
          json: true,
          space: 'official',
          title: 'partial update must not happen',
          ...forbidden,
        })).toThrow('process.exit(2)');
        expect(JSON.parse(String(log.mock.calls.at(-1)?.[0]))).toMatchObject({
          success: false,
          code: 'UPDATE_FIELD_UNSUPPORTED',
        });
      }
    } finally {
      log.mockRestore();
      exit.mockRestore();
    }
  });

  it('requires an explicit include-subtree boolean and rejects malformed list booleans', () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const exit = vi.spyOn(process, 'exit').mockImplementation(((code?: number) => {
      throw new Error(`process.exit(${code})`);
    }) as typeof process.exit);
    try {
      const cases: Array<[string[], string]> = [
        [['--include-subtree', '--json'], 'FLAG_VALUE_REQUIRED'],
        [['--include-subtree', 'maybe', '--json'], 'BOOLEAN_VALUE_INVALID'],
      ];
      for (const [args, code] of cases) {
        const { flags } = parseArgs(['--space', 'official', ...args]);
        expect(() => buildRequestBody('space', 'issue', ['list'], {
          ...flags,
          workspacePath: '/workspace',
        })).toThrow('process.exit(2)');
        expect(JSON.parse(String(log.mock.calls.at(-1)?.[0]))).toMatchObject({ code });
      }
    } finally {
      log.mockRestore();
      exit.mockRestore();
    }
  });

  it('does not confuse a repeated Issue id with bare human-only syntax', () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const exit = vi.spyOn(process, 'exit').mockImplementation(((code?: number) => {
      throw new Error(`process.exit(${code})`);
    }) as typeof process.exit);
    try {
      const { positional, flags } = parseArgs([
        'space', 'issue', 'update', 'iss_1', '--human-only', 'iss_1', '--space', 'official', '--json',
      ]);
      expect(() => buildRequestBody(positional[0], positional[1], positional.slice(2), {
        ...flags,
        workspacePath: '/workspace',
      })).toThrow('process.exit(2)');
      expect(JSON.parse(String(log.mock.calls.at(-1)?.[0]))).toMatchObject({
        code: 'BOOLEAN_VALUE_INVALID',
      });
    } finally {
      log.mockRestore();
      exit.mockRestore();
    }
  });

  it('keeps executable recovery commands visible with human suggestions', () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    try {
      printResult('space', 'issue', {
        success: false,
        error: 'Goal is archived.',
        suggestion: 'List active Goals and retry.',
        suggestedCommand: 'myagents space goal list --space official --json',
      }, false);
      expect(error.mock.calls.map(call => String(call[0]))).toEqual([
        'Error: Goal is archived.',
        'Suggestion: List active Goals and retry.',
        '  \u2192 Run: myagents space goal list --space official --json',
      ]);
    } finally {
      error.mockRestore();
    }
  });

  it('rejects unsupported Space mutation dry-runs before any HTTP call', () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const exit = vi.spyOn(process, 'exit').mockImplementation(((code?: number) => {
      throw new Error(`process.exit(${code})`);
    }) as typeof process.exit);
    const fetch = vi.fn();
    vi.stubGlobal('fetch', fetch);
    try {
      const mutations = [
        ['space', 'issue', 'create'],
        ['space', 'issue', 'update', 'iss_1'],
        ['space', 'issue', 'comment', 'iss_1'],
        ['space', 'issue', 'status', 'iss_1'],
        ['space', 'issue', 'claim', 'iss_1'],
        ['space', 'issue', 'attachment', 'add', 'iss_1'],
        ['space', 'issue', 'close', 'iss_1'],
        ['space', 'issue', 'complete', 'iss_1'],
        ['space', 'issue', 'cancel-claim', 'iss_1'],
        ['space', 'claim', 'local-task', 'iss_1'],
        ['space', 'attachment', 'add', 'iss_1'],
        ['space', 'attachment', 'download', 'att_1'],
      ];
      for (const positional of mutations) {
        expect(() => rejectUnsupportedSpaceDryRun(
          positional,
          { json: true, dryRun: true, space: 'official' },
        ), positional.join(' ')).toThrow('process.exit(2)');
        const nestedIssueLeaf = positional[1] === 'issue'
          && positional[2] === 'attachment';
        const expectedCommand = positional.slice(0, nestedIssueLeaf ? 4 : 3).join(' ');
        expect(JSON.parse(String(log.mock.calls.at(-1)?.[0]))).toMatchObject({
          suggestion: expect.stringContaining(`Read myagents ${expectedCommand} --help`),
        });
      }
      expect(() => rejectUnsupportedSpaceDryRun(
        ['space', 'issue', 'update'],
        { json: true, dryRun: true, space: 'official', issueId: 'iss_alias' },
      )).toThrow('process.exit(2)');
      expect(JSON.parse(String(log.mock.calls.at(-1)?.[0]))).toMatchObject({
        success: false,
        code: 'DRY_RUN_UNSUPPORTED',
      });
      expect(fetch).not.toHaveBeenCalled();
      expect(() => rejectUnsupportedSpaceDryRun(
        ['space', 'goal', 'list'],
        { json: true, dryRun: true, space: 'official' },
      )).not.toThrow();
    } finally {
      vi.unstubAllGlobals();
      log.mockRestore();
      exit.mockRestore();
    }
  });

  it('routes and builds exact comment lookup by issue and comment id', () => {
    expect(buildRoute('space', 'issue', ['comment', 'get', 'iss_1', 'comment_1']))
      .toBe('space/issue-comment-get');
    expect(buildRequestBody('space', 'issue', ['comment', 'get', 'iss_1', 'comment_1'], {
      space: 'official',
      workspacePath: '/workspace',
      agentId: 'rag_1',
    })).toEqual({
      issueId: 'iss_1',
      commentId: 'comment_1',
      spaceSlug: 'official',
      sessionId: undefined,
      workspaceId: undefined,
      agentId: 'rag_1',
      workspacePath: '/workspace',
    });
  });

  it('keeps the Issue detail default comment window at five', () => {
    expect(buildRequestBody('space', 'issue', ['view', 'iss_1'], {
      space: 'official',
      workspacePath: '/workspace',
    })).toMatchObject({
      issueId: 'iss_1',
      commentsLimit: undefined,
      commentsCursor: undefined,
    });
    expect(buildRoute('space', 'issue', ['comments', 'iss_1']))
      .toBe('space/issue-comments');
    expect(buildRequestBody('space', 'issue', ['comments', 'iss_1'], {
      space: 'official',
      workspacePath: '/workspace',
      cursor: 'opaque-cursor',
    })).toMatchObject({
      issueId: 'iss_1',
      cursor: 'opaque-cursor',
      limit: 20,
    });
  });

  it('uses claim origin to constrain attached-task rollback', () => {
    const claimBody = { issueId: 'iss_1', agentId: 'rag_1', workspacePath: '/workspace' };
    expect(buildClaimCancelBody(claimBody, {
      data: { claim: { id: 'claim_1', origin: 'self_claim' }, notificationVersion: 7 },
    })).toMatchObject({ rollback: true, expectedNotificationVersion: 7 });
    expect(buildClaimCancelBody(claimBody, {
      data: { claim: { id: 'claim_2', origin: 'assignment_confirmation' }, notificationVersion: 9 },
    })).toEqual({
      ...claimBody,
      rollback: true,
    });
  });

  it('generates a stable completion operation key bound to Issue, Task, and result', () => {
    const input = { issueId: 'iss_1', taskOrSessionId: 'task_1', resultComment: 'done' };
    expect(buildSpaceCompleteOperationKey(input)).toBe(buildSpaceCompleteOperationKey(input));
    expect(buildSpaceCompleteOperationKey(input)).not.toBe(
      buildSpaceCompleteOperationKey({ ...input, resultComment: 'different result' }),
    );
  });

  it('builds scoped atomic create/comment requests and the top-level attachment route', () => {
    expect(buildRequestBody('space', 'issue', ['create'], {
      space: 'official',
      workspacePath: '/workspace',
      title: 'A new issue',
      body: 'Details',
      assignee: 'agent:regagent_1',
      attachment: ['one.png'],
      file: ['two.log'],
    })).toMatchObject({
      spaceSlug: 'official',
      title: 'A new issue',
      body: 'Details',
      assigneeId: 'agent:regagent_1',
      filePaths: ['one.png', 'two.log'],
    });

    expect(buildRequestBody('space', 'issue', ['comment', 'iss_1'], {
      space: 'official',
      workspacePath: '/workspace',
      attachment: ['evidence.zip'],
    })).toMatchObject({
      issueId: 'iss_1',
      body: '',
      filePaths: ['evidence.zip'],
    });

    expect(buildRoute('space', 'issue', ['attachment', 'add', 'iss_1']))
      .toBe('space/attachment-add');
    expect(buildRequestBody('space', 'issue', ['attachment', 'add', 'iss_1'], {
      space: 'official',
      workspacePath: '/workspace',
      file: ['report.pdf'],
    })).toMatchObject({ issueId: 'iss_1', filePaths: ['report.pdf'] });
  });

  it('collects both repeatable attachment flag spellings', () => {
    expect(parseArgs([
      'space', 'issue', 'comment', 'iss_1',
      '--space', 'official',
      '--attachment', 'a.png',
      '--attachment=b.log',
      '--file', 'c.zip',
    ])).toMatchObject({
      flags: {
        space: 'official',
        attachment: ['a.png', 'b.log'],
        file: ['c.zip'],
      },
    });
  });

  it('does not let a missing attachment value consume the following JSON flag', () => {
    expect(parseArgs([
      'space', 'issue', 'create',
      '--space', 'official',
      '--title', 'Title',
      '--body', 'Body',
      '--attachment',
      '--json',
    ])).toMatchObject({
      flags: {
        json: true,
        attachment: [],
        attachmentValueMissing: true,
      },
    });

    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const exit = vi.spyOn(process, 'exit').mockImplementation(((code?: number) => {
      throw new Error(`process.exit(${code})`);
    }) as typeof process.exit);
    try {
      const { flags } = parseArgs([
        '--space', 'official',
        '--title', 'Title',
        '--body', 'Body',
        '--file',
        '--json',
      ]);
      expect(() => buildRequestBody('space', 'issue', ['create'], flags)).toThrow('process.exit(2)');
      expect(JSON.parse(String(log.mock.calls.at(-1)?.[0]))).toMatchObject({
        success: false,
        code: 'FLAG_VALUE_REQUIRED',
        suggestion: expect.any(String),
      });
      expect(error).not.toHaveBeenCalled();
    } finally {
      log.mockRestore();
      error.mockRestore();
      exit.mockRestore();
    }
  });

  it('emits a structured recovery contract when a Space slug is missing in JSON mode', () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const exit = vi.spyOn(process, 'exit').mockImplementation(((code?: number) => {
      throw new Error(`process.exit(${code})`);
    }) as typeof process.exit);
    try {
      expect(() => buildRequestBody('space', 'issue', ['view', 'iss_1'], {
        json: true,
        workspacePath: '/workspace',
      })).toThrow('process.exit(2)');
      expect(JSON.parse(String(log.mock.calls[0]?.[0]))).toEqual({
        success: false,
        code: 'SPACE_REQUIRED',
        error: 'This command requires --space <slug>.',
        suggestion: 'Run `myagents space list --json`, then retry with one returned slug.',
        suggestedCommand: 'myagents space list --json',
      });
    } finally {
      log.mockRestore();
      exit.mockRestore();
    }
  });

  it('keeps local Space validation machine-readable in JSON mode', () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const exit = vi.spyOn(process, 'exit').mockImplementation(((code?: number) => {
      throw new Error(`process.exit(${code})`);
    }) as typeof process.exit);
    try {
      expect(() => buildRequestBody('space', 'issue', ['create'], {
        json: true,
        space: 'official',
        workspacePath: '/workspace',
        title: 'Missing body',
        body: '   ',
      })).toThrow('process.exit(2)');
      expect(JSON.parse(String(log.mock.calls.at(-1)?.[0]))).toMatchObject({
        success: false,
        code: 'ISSUE_BODY_REQUIRED',
        suggestion: expect.any(String),
      });

      expect(() => buildRequestBody('space', 'issue', ['attachment', 'add', 'iss_1'], {
        json: true,
        space: 'official',
        workspacePath: '/workspace',
      })).toThrow('process.exit(2)');
      expect(JSON.parse(String(log.mock.calls.at(-1)?.[0]))).toMatchObject({
        success: false,
        code: 'ATTACHMENT_REQUIRED',
        suggestion: expect.any(String),
      });

      expect(() => buildRequestBody('space', 'issue', ['create'], {
        json: true,
        space: 'official',
        workspacePath: '/workspace',
        title: true,
        body: 'A title flag without a value must not throw a TypeError.',
      })).toThrow('process.exit(2)');
      expect(JSON.parse(String(log.mock.calls.at(-1)?.[0]))).toMatchObject({
        success: false,
        code: 'ARGUMENT_REQUIRED',
        suggestion: expect.any(String),
      });

      expect(error).not.toHaveBeenCalled();
    } finally {
      log.mockRestore();
      error.mockRestore();
      exit.mockRestore();
    }
  });
});

describe('myagents CLI Agent / Session collaboration contracts', () => {
  it('advertises Agent discovery and fresh Session collaboration at top level', () => {
    expect(TOP_HELP).toContain('agent     Discover local/network Agents');
    expect(TOP_HELP).toContain('session   Discover, start, message, and observe');
    expect(TOP_HELP).toContain('myagents session start --agent <agentId>');
  });

  it('builds explicit Agent discovery and Session list requests', () => {
    expect(buildRequestBody('agent', 'create', [], { workspacePath: '/repo/new-agent' })).toEqual({
      workspacePath: '/repo/new-agent',
    });
    expect(buildRequestBody('agent', 'list', [], {})).toEqual({ lifecycle: 'active' });
    expect(buildRequestBody('agent', 'list', [], { archived: true })).toEqual({ lifecycle: 'archived' });
    expect(buildRequestBody('agent', 'current', [], {})).toEqual({});
    expect(buildRequestBody('agent', 'show', ['agent-1'], {})).toEqual({ agentId: 'agent-1' });
    expect(buildRequestBody('session', 'list', [], { agent: 'agent-1' })).toEqual({
      agentId: 'agent-1',
      limit: 5,
    });
    expect(buildRequestBody('session', 'list', [], { agentId: 'agent-1', limit: '10' })).toEqual({
      agentId: 'agent-1',
      limit: 10,
    });
    expect(buildRequestBody('session', 'get', ['session-1'], {})).toEqual({
      sessionId: 'session-1',
      limit: 5,
    });
    expect(buildRequestBody('session', 'get', ['session-1'], {
      limit: '50',
      before: 'message-9',
    })).toEqual({
      sessionId: 'session-1',
      limit: 50,
      before: 'message-9',
    });
  });

  it('keeps remote selectors copyable without widening the table or inventing local state', () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    const remoteId = 'ma-agent:1:' + 'a'.repeat(120);
    try {
      printAgentList([
        { agentId: 'local-agent', name: 'Local', enabled: true, archived: false, channelCount: 2 },
        { agentId: remoteId, name: 'Remote', isLocal: false, networkName: 'Office', deviceName: 'Laptop' },
      ]);
      const lines = log.mock.calls.map(call => String(call[0]));
      expect(lines[0].length).toBeLessThan(100);
      expect(lines.find(line => line.includes('Remote'))).not.toContain('disabled');
      expect(lines.find(line => line.includes('Remote'))).not.toMatch(/\bactive\b/);
      expect(lines.join('\n')).not.toContain('undefined');
      expect(lines).toContain('  Agent ID: ' + remoteId);
      expect(lines.join('\n')).toContain('Office');
      expect(lines.join('\n')).toContain('Laptop');
    } finally { log.mockRestore(); }
  });

  it('does not advertise a current Agent marker when the caller has none', () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    try {
      printAgentList([
        {
          agentId: 'agent-user',
          archived: false,
          enabled: true,
          channelCount: 0,
          name: 'mino',
        },
        {
          agentId: 'agent-system',
          archived: false,
          enabled: true,
          channelCount: 0,
          name: 'Mino',
        },
      ]);
      const output = log.mock.calls.flat().join('\n');
      expect(output).toContain('No current Agent for this CLI caller');
      expect(output).not.toContain('* current Agent for this CLI caller');
    } finally {
      log.mockRestore();
    }
  });

  it('builds fresh Session start with the same prompt contract as send', () => {
    expect(buildRequestBody('session', 'start', [], {
      agent: 'agent-1',
      prompt: 'Review this change',
    })).toEqual({
      agentId: 'agent-1',
      prompt: 'Review this change',
      replyBack: true,
    });
    expect(buildRequestBody('session', 'start', [], {
      agentId: 'agent-1',
      prompt: 'Notify only',
      noReply: true,
    })).toEqual({
      agentId: 'agent-1',
      prompt: 'Notify only',
      replyBack: false,
    });
  });

  it('rejects invalid Session discovery/start inputs with exit 3', () => {
    const exit = vi.spyOn(process, 'exit').mockImplementation(((code?: number) => {
      throw new Error(`process.exit(${code})`);
    }) as typeof process.exit);
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      expect(() => buildRequestBody('session', 'list', [], {})).toThrow('process.exit(3)');
      expect(() => buildRequestBody('session', 'list', [], { agent: 'agent-1', limit: 51 }))
        .toThrow('process.exit(3)');
      expect(() => buildRequestBody('session', 'start', [], { prompt: 'work' }))
        .toThrow('process.exit(3)');
      expect(() => buildRequestBody('session', 'start', [], {
        agent: 'agent-1',
        prompt: 'line one\nline two',
      })).toThrow('process.exit(3)');
      expect(() => buildRequestBody('session', 'start', [], {
        agent: 'agent-1',
        prompt: '界'.repeat(3_000),
      })).toThrow('process.exit(3)');
      expect(() => buildRequestBody('session', 'start', [], {
        agent: 'agent-1',
        prompt: 'inline',
        promptFile: true,
      })).toThrow('process.exit(3)');
      expect(() => buildRequestBody('session', 'start', [], {
        agent: 'agent-1',
        promptFile: '/definitely/missing/myagents-prompt.txt',
      })).toThrow('process.exit(3)');
      expect(() => buildRequestBody('agent', 'create', [], {})).toThrow('process.exit(2)');
      expect(() => buildRequestBody('session', 'get', [], {})).toThrow('process.exit(1)');
      expect(() => buildRequestBody('session', 'get', ['session-1'], { limit: 0 }))
        .toThrow('process.exit(2)');
      expect(() => buildRequestBody('session', 'get', ['session-1'], { limit: 501 }))
        .toThrow('process.exit(2)');
    } finally {
      exit.mockRestore();
      error.mockRestore();
    }
  });

  it('fails closed when a Session mutation acknowledgement is incomplete', () => {
    expect(validateSessionMutationAcknowledgement('session/start', {
      success: true,
      sessionId: 'session-new',
    })).toMatchObject({
      success: false,
      code: 'admission_unconfirmed',
      sessionId: 'session-new',
    });
    expect(validateSessionMutationAcknowledgement('session/send', {})).toMatchObject({
      success: false,
      code: 'admission_unconfirmed',
    });
    expect(validateSessionMutationAcknowledgement('session/send', {
      success: false,
      code: 'rejected',
      error: 'busy',
    })).toEqual({ success: false, code: 'rejected', error: 'busy' });
  });

  it('prints an accepted receipt without implying completion', () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    try {
      printResult('session', 'start', {
        success: true,
        accepted: true,
        asynchronous: true,
        agentId: 'agent-1',
        sessionId: 'session-new',
        messageId: 'message-1',
        replyBack: true,
        resultDelivery: 'send.result',
      }, false);
      const output = log.mock.calls.map(call => call.join(' ')).join('\n');
      expect(output).toContain('fresh Session request accepted');
      expect(output).toContain('session-new');
      expect(output).toContain('message-1');
      expect(output).toContain('running asynchronously');
      expect(output).toContain('send.result');
      expect(output).not.toContain('completed');
    } finally {
      log.mockRestore();
    }
  });

  it('prints retained receipt IDs and no-retry guidance for unconfirmed admission', () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      printResult('session', 'start', {
        success: false,
        accepted: null,
        unconfirmed: true,
        error: 'admission acknowledgement was not confirmed',
        agentId: 'agent-1',
        sessionId: 'session-new',
        messageId: 'message-1',
        recoveryHint: {
          recoveryCommand: 'myagents session list --agent agent-1',
          message: 'Check whether the new Session materialized; do not automatically resend.',
        },
      }, false);
      const output = error.mock.calls.map(call => call.join(' ')).join('\n');
      expect(output).toContain('session-new');
      expect(output).toContain('message-1');
      expect(output).toContain('do not automatically resend');
      expect(output).toContain('myagents session list --agent agent-1');
    } finally {
      error.mockRestore();
    }
  });
});

describe('myagents CLI Goal file inputs', () => {
  it('reads shell-sensitive objective and reason text from local files', () => {
    const dir = mkdtempSync(join(process.cwd(), '.goal-cli-test-'));
    try {
      const objectivePath = join(dir, 'objective.txt');
      const reasonPath = join(dir, 'reason.txt');
      const objective = 'finish $(touch should-not-run) with `literal` and "quotes"';
      const reason = 'verified $HOME without shell expansion';
      writeFileSync(objectivePath, objective, 'utf8');
      writeFileSync(reasonPath, reason, 'utf8');

      expect(buildRequestBody('goal', 'create', [], {
        objectiveFile: objectivePath,
      })).toEqual({ objective });
      expect(buildRequestBody('goal', 'update', [], {
        status: 'complete',
        reasonFile: reasonPath,
      })).toEqual({ status: 'complete', reason });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('accepts Goal objective and reason files outside the current workspace', () => {
    const dir = mkdtempSync(join(tmpdir(), 'myagents-goal-cli-external-'));
    try {
      const objectivePath = join(dir, 'objective.txt');
      const reasonPath = join(dir, 'reason.txt');
      writeFileSync(objectivePath, 'objective from system temp', 'utf8');
      writeFileSync(reasonPath, 'reason from system temp', 'utf8');

      expect(buildRequestBody('goal', 'create', [], {
        objectiveFile: objectivePath,
      })).toEqual({ objective: 'objective from system temp' });
      expect(buildRequestBody('goal', 'update', [], {
        status: 'blocked',
        reasonFile: reasonPath,
      })).toEqual({ status: 'blocked', reason: 'reason from system temp' });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('builds existing Goal end conditions without changing the default payload', () => {
    const dir = mkdtempSync(join(process.cwd(), '.goal-cli-end-conditions-test-'));
    try {
      const objectivePath = join(dir, 'objective.txt');
      writeFileSync(objectivePath, 'finish the release', 'utf8');

      expect(buildRequestBody('goal', 'create', [], {
        objectiveFile: objectivePath,
      })).toEqual({ objective: 'finish the release' });
      expect(buildRequestBody('goal', 'create', [], {
        objectiveFile: objectivePath,
        deadline: '2026-07-22T09:00:00+08:00',
        maxExecutions: '5',
        aiCanExit: 'false',
      })).toEqual({
        objective: 'finish the release',
        endConditions: {
          deadline: '2026-07-22T01:00:00.000Z',
          maxExecutions: 5,
          aiCanExit: false,
        },
      });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('rejects ambiguous or invalid Goal end conditions at the CLI boundary', () => {
    const dir = mkdtempSync(join(process.cwd(), '.goal-cli-invalid-end-conditions-test-'));
    const exit = vi.spyOn(process, 'exit').mockImplementation(((code?: number) => {
      throw new Error(`process.exit(${code})`);
    }) as typeof process.exit);
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const objectivePath = join(dir, 'objective.txt');
      writeFileSync(objectivePath, 'finish the release', 'utf8');

      expect(() => buildRequestBody('goal', 'create', [], {
        objectiveFile: objectivePath,
        deadline: '2026-07-22T09:00:00',
      })).toThrow('process.exit(2)');
      expect(() => buildRequestBody('goal', 'create', [], {
        objectiveFile: objectivePath,
        deadline: '2026-02-30T09:00:00+08:00',
      })).toThrow('process.exit(2)');
      expect(() => buildRequestBody('goal', 'create', [], {
        objectiveFile: objectivePath,
        maxExecutions: '0',
      })).toThrow('process.exit(2)');
      expect(() => buildRequestBody('goal', 'create', [], {
        objectiveFile: objectivePath,
        maxExecutions: '1.5',
      })).toThrow('process.exit(2)');
      expect(() => buildRequestBody('goal', 'create', [], {
        objectiveFile: objectivePath,
        aiCanExit: 'sometimes',
      })).toThrow('process.exit(2)');
      expect(() => buildRequestBody('goal', 'create', [], {
        objectiveFile: objectivePath,
        aiCanExit: true,
      })).toThrow('process.exit(2)');
    } finally {
      rmSync(dir, { recursive: true, force: true });
      exit.mockRestore();
      error.mockRestore();
    }
  });

  it('shows settled and current Goal turns separately with effective end conditions', () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    try {
      printGoalResult('get', {
        goal: {
          id: 'goal-1',
          status: 'active',
          turnCount: 3,
          isExecuting: true,
          executionNumber: 4,
          endConditions: {
            deadline: '2026-07-22T01:00:00.000Z',
            maxExecutions: 5,
            aiCanExit: false,
          },
        },
      });

      const output = log.mock.calls.map(call => String(call[0])).join('\n');
      expect(output).toContain('settled turns: 3');
      expect(output).toContain('current turn:  4 (executing)');
      expect(output).toContain('max executions: 5');
      expect(output).toContain('AI can exit:    no');
      expect(output).toContain('[UTC 2026-07-22T01:00:00.000Z]');
      expect(output).not.toContain('  turns:');
    } finally {
      log.mockRestore();
    }
  });

  it('keeps workspace-scoped readers bounded and rejects unsafe file shapes', () => {
    const root = mkdtempSync(join(process.cwd(), '.goal-cli-safety-test-'));
    const workspace = join(root, 'workspace');
    mkdirSync(workspace);
    try {
      const outside = join(root, 'outside.txt');
      writeFileSync(outside, 'outside', 'utf8');
      expect(() => readWorkspaceTextFile(outside, workspace)).toThrow(/inside workspace/);

      const target = join(workspace, 'target.txt');
      const link = join(workspace, 'link.txt');
      writeFileSync(target, 'target', 'utf8');
      symlinkSync(target, link);
      expect(() => readWorkspaceTextFile(link, workspace)).toThrow(/symlink/);

      const oversized = join(workspace, 'oversized.txt');
      writeFileSync(oversized, 'x'.repeat(1024 * 1024 + 1), 'utf8');
      expect(() => readWorkspaceTextFile(oversized, workspace)).toThrow(/exceeds/);

      const nul = join(workspace, 'nul.txt');
      writeFileSync(nul, 'before\0after', 'utf8');
      expect(() => readWorkspaceTextFile(nul, workspace)).toThrow(/NUL/);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('rejects inline and positional Goal text before building an API request', () => {
    const exit = vi.spyOn(process, 'exit').mockImplementation(((code?: number) => {
      throw new Error(`process.exit(${code})`);
    }) as typeof process.exit);
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      expect(() => buildRequestBody('goal', 'create', [], {
        objective: '$(touch should-not-run)',
      })).toThrow('process.exit(2)');
      expect(() => buildRequestBody('goal', 'create', ['positional objective'], {}))
        .toThrow('process.exit(2)');
      expect(() => buildRequestBody('goal', 'update', [], {
        status: 'complete',
        reason: '`touch should-not-run`',
      })).toThrow('process.exit(2)');
    } finally {
      exit.mockRestore();
      error.mockRestore();
    }
  });
});

describe('myagents CLI parseArgs', () => {
  it('normalizes file-only Goal flags to camelCase', () => {
    expect(parseArgs([
      'goal',
      'create',
      '--objective-file',
      'myagents_files/objective.txt',
      '--deadline',
      '2026-07-22T09:00:00+08:00',
      '--max-executions',
      '5',
      '--ai-can-exit',
      'false',
    ])).toMatchObject({
      positional: ['goal', 'create'],
      flags: {
        objectiveFile: 'myagents_files/objective.txt',
        deadline: '2026-07-22T09:00:00+08:00',
        maxExecutions: '5',
        aiCanExit: 'false',
      },
    });
  });

  it('collects consecutive values for repeatable flags', () => {
    expect(parseArgs([
      'model',
      'add',
      '--models',
      'sensenova-6.7-flash-lite',
      'deepseek-v4-flash',
      'glm-5.2',
      '--primary-model',
      'sensenova-6.7-flash-lite',
    ])).toMatchObject({
      positional: ['model', 'add'],
      flags: {
        models: ['sensenova-6.7-flash-lite', 'deepseek-v4-flash', 'glm-5.2'],
        primaryModel: 'sensenova-6.7-flash-lite',
      },
    });
  });

  it('appends repeated repeatable flags instead of overwriting them', () => {
    expect(parseArgs([
      'model',
      'add',
      '--models',
      'A',
      '--models',
      'B',
      '--models=C',
    ])).toMatchObject({
      flags: { models: ['A', 'B', 'C'] },
    });
  });

  it('keeps model names aligned when both model lists use consecutive values', () => {
    expect(parseArgs([
      'model',
      'add',
      '--models',
      'A',
      'B',
      '--model-names',
      'Model A',
      'Model B',
    ])).toMatchObject({
      flags: {
        models: ['A', 'B'],
        modelNames: ['Model A', 'Model B'],
      },
    });
  });

  it('prints each provider primary model and model catalogue in human output', () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    try {
      printModelList([{
        id: 'provider-a',
        name: 'Provider A',
        status: 'valid',
        enabled: true,
        primaryModel: 'model-b',
        models: [
          { model: 'model-a', modelName: 'Model A' },
          { model: 'model-b', modelName: 'Model B' },
        ],
      }]);

      const output = log.mock.calls.map(args => args.join(' ')).join('\n');
      expect(output).toContain('provider-a');
      expect(output).toContain('Primary: model-b');
      expect(output).toContain('model-a (Model A), model-b (Model B)');
    } finally {
      log.mockRestore();
    }
  });

  it('still accepts dash-prefixed values as the first repeatable value', () => {
    expect(parseArgs([
      'mcp',
      'add',
      '--args',
      '--stdio',
      'server.js',
      '--env',
      'TOKEN=secret',
    ])).toMatchObject({
      flags: {
        args: ['--stdio', 'server.js'],
        env: ['TOKEN=secret'],
      },
    });
  });
});

describe('myagents CLI IM contracts', () => {
  it('serializes the advertised send-media file flag as one scalar path', () => {
    for (const args of [
      ['im', 'send-media', '--file', '/tmp/chart.png', '--caption', 'Daily chart'],
      ['im', 'send-media', '--file=/tmp/chart.png', '--caption=Daily chart'],
    ]) {
      const { positional, flags } = parseArgs(args);
      expect(buildRequestBody(
        positional[0],
        positional[1],
        positional.slice(2),
        flags,
      )).toEqual({
        filePath: '/tmp/chart.png',
        caption: 'Daily chart',
      });
    }
  });

  it('keeps the positional compatibility form and rejects missing or ambiguous file input', () => {
    const positional = parseArgs(['im', 'send-media', '/tmp/chart.png']);
    expect(buildRequestBody(
      positional.positional[0],
      positional.positional[1],
      positional.positional.slice(2),
      positional.flags,
    )).toEqual({ filePath: '/tmp/chart.png', caption: undefined });

    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const exit = vi.spyOn(process, 'exit').mockImplementation(((code?: number) => {
      throw new Error(`process.exit(${code})`);
    }) as typeof process.exit);
    try {
      const repeated = parseArgs([
        'im', 'send-media', '--file', '/tmp/a.png', '--file', '/tmp/b.png',
      ]);
      expect(() => buildRequestBody(
        repeated.positional[0],
        repeated.positional[1],
        repeated.positional.slice(2),
        repeated.flags,
      )).toThrow('process.exit(2)');
      expect(error).toHaveBeenCalledWith('Error: im send-media accepts exactly one --file <path>.');

      error.mockClear();
      const missing = parseArgs(['im', 'send-media', '--file', '--caption', 'Daily chart']);
      expect(() => buildRequestBody(
        missing.positional[0],
        missing.positional[1],
        missing.positional.slice(2),
        missing.flags,
      )).toThrow('process.exit(2)');
      expect(error).toHaveBeenCalledWith('Error: im send-media requires --file <path>.');
    } finally {
      error.mockRestore();
      exit.mockRestore();
    }
  });
});

describe('myagents CLI cron time handling', () => {
  it('forwards every supported Task runtime override on cron add and update', () => {
    const runtimeConfig = '{"source":"system-cli","model":"gpt-5.6-sol"}';
    expect(buildRequestBody('cron', 'add', [], {
      name: 'Codex automation',
      prompt: 'Review the workspace',
      workspace: '/tmp/codex-workspace',
      every: '30',
      runtime: 'codex',
      runtimeConfig,
      providerId: 'provider-1',
      model: 'gpt-5.6-sol',
      permissionMode: 'full-auto',
    })).toMatchObject({
      name: 'Codex automation',
      message: 'Review the workspace',
      workspacePath: '/tmp/codex-workspace',
      intervalMinutes: 30,
      runtime: 'codex',
      runtimeConfig: { source: 'system-cli', model: 'gpt-5.6-sol' },
      providerId: 'provider-1',
      model: 'gpt-5.6-sol',
      permissionMode: 'full-auto',
    });
    expect(buildRequestBody('cron', 'update', ['task-1'], {
      runtime: 'codex',
      runtimeConfig,
      providerId: 'provider-1',
      model: 'gpt-5.6-sol',
      permissionMode: 'full-auto',
    })).toEqual({
      taskId: 'task-1',
      patch: {
        runtime: 'codex',
        runtimeConfig: { source: 'system-cli', model: 'gpt-5.6-sol' },
        providerId: 'provider-1',
        model: 'gpt-5.6-sol',
        permissionMode: 'full-auto',
      },
    });
  });

  it('rejects unsupported cron mutation flags instead of silently dropping them', () => {
    const exit = vi.spyOn(process, 'exit').mockImplementation(((code?: number) => {
      throw new Error(`process.exit(${code})`);
    }) as typeof process.exit);
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    try {
      expect(() => buildRequestBody('cron', 'add', [], {
        prompt: 'Do work',
        imaginaryRouting: 'silent-drop',
      })).toThrow('process.exit(2)');
      expect(error).toHaveBeenCalledWith(
        'Error: myagents cron add does not support --imaginary-routing.',
      );
    } finally {
      exit.mockRestore();
      error.mockRestore();
    }
  });

  it('uses the same guarded prompt-file input for cron add and update', () => {
    const dir = mkdtempSync(join(tmpdir(), 'myagents-cron-prompt-file-'));
    try {
      const promptPath = join(dir, 'prompt.txt');
      const prompt = 'line one\n`literal` $(not-executed)\nline three';
      writeFileSync(promptPath, prompt, 'utf8');

      expect(buildRequestBody('cron', 'add', [], {
        promptFile: promptPath,
      })).toMatchObject({ message: prompt });
      expect(buildRequestBody('cron', 'update', ['task-1'], {
        promptFile: promptPath,
      })).toEqual({
        taskId: 'task-1',
        patch: { prompt },
      });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('rejects ambiguous, valueless, and empty cron update inputs', () => {
    const dir = mkdtempSync(join(tmpdir(), 'myagents-cron-empty-prompt-'));
    const exit = vi.spyOn(process, 'exit').mockImplementation(((code?: number) => {
      throw new Error(`process.exit(${code})`);
    }) as typeof process.exit);
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const emptyPromptPath = join(dir, 'prompt.txt');
      writeFileSync(emptyPromptPath, ' \n\t', 'utf8');
      expect(() => buildRequestBody('cron', 'update', ['task-1'], {
        prompt: 'inline',
        promptFile: '/tmp/prompt.txt',
      })).toThrow('process.exit(2)');
      expect(() => buildRequestBody('cron', 'update', ['task-1'], {
        message: 'inline alias',
        promptFile: '/tmp/prompt.txt',
      })).toThrow('process.exit(2)');
      expect(() => buildRequestBody('cron', 'update', ['task-1'], {
        promptFile: true,
      })).toThrow('process.exit(2)');
      expect(() => buildRequestBody('cron', 'update', ['task-1'], {
        prompt: '   ',
      })).toThrow('process.exit(2)');
      expect(() => buildRequestBody('cron', 'update', ['task-1'], {
        promptFile: emptyPromptPath,
      })).toThrow('process.exit(2)');
      expect(() => buildRequestBody('cron', 'update', ['task-1'], {}))
        .toThrow('process.exit(2)');
    } finally {
      rmSync(dir, { recursive: true, force: true });
      exit.mockRestore();
      error.mockRestore();
    }
  });

  it('adds a default IANA timezone to bare cron schedules on create paths', () => {
    expect(normalizeScheduleFlag('0 9 * * *', {
      fillMissingCronTimezone: true,
      defaultTimezone: 'Asia/Shanghai',
    })).toEqual({
      kind: 'cron',
      expr: '0 9 * * *',
      tz: 'Asia/Shanghai',
    });
  });

  it('leaves bare cron schedules timezone-free for update inheritance', () => {
    expect(normalizeScheduleFlag('0 9 * * *')).toEqual({
      kind: 'cron',
      expr: '0 9 * * *',
    });
  });

  it('fills missing JSON cron timezone on create but preserves explicit UTC', () => {
    expect(normalizeScheduleFlag('{"kind":"cron","expr":"0 9 * * *"}', {
      fillMissingCronTimezone: true,
      defaultTimezone: 'Asia/Shanghai',
    })).toMatchObject({
      kind: 'cron',
      expr: '0 9 * * *',
      tz: 'Asia/Shanghai',
    });

    expect(normalizeScheduleFlag('{"kind":"cron","expr":"0 9 * * *","tz":"UTC"}', {
      fillMissingCronTimezone: true,
      defaultTimezone: 'Asia/Shanghai',
    })).toMatchObject({
      kind: 'cron',
      expr: '0 9 * * *',
      tz: 'UTC',
    });
  });

  it('rejects retired loop schedules from ordinary cron commands', () => {
    const exit = vi.spyOn(process, 'exit').mockImplementation(((code?: number) => {
      throw new Error(`process.exit(${code})`);
    }) as typeof process.exit);
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      expect(() => normalizeScheduleFlag('{"kind":"loop"}')).toThrow('process.exit(2)');
      expect(error).toHaveBeenCalledWith(expect.stringContaining('Goal Mode'));
      expect(error).toHaveBeenCalledWith(expect.stringContaining('myagents goal create --objective-file'));
    } finally {
      exit.mockRestore();
      error.mockRestore();
    }
  });

  it('requires explicit offset or Z for one-shot dispatchAt strings', () => {
    expect(parseDispatchAtValue('2026-06-01T09:00:00+08:00')).toBe(Date.parse('2026-06-01T09:00:00+08:00'));
    expect(parseDispatchAtValue('2026-06-01T01:00:00Z')).toBe(Date.parse('2026-06-01T01:00:00Z'));
    expect(() => parseDispatchAtValue('2026-06-01T09:00:00')).toThrow(/explicit timezone offset or Z/);
  });

  it('marks legacy cron schedules without tz as UTC by default in display text', () => {
    expect(formatCronTaskScheduleForDisplay({
      schedule: { kind: 'cron', expr: '0 9 * * *' },
    }, 'long')).toBe('0 9 * * * @ UTC(default)');
  });

  it('formats instants with timezone name and offset for human output', () => {
    expect(formatCronInstantForDisplay('2026-07-09T01:00:00Z', 'Asia/Shanghai', 'long'))
      .toBe('2026-07-09 09:00 Asia/Shanghai (UTC+08:00)');
  });
});


describe('CLI skill availability', () => {
  it('prints Session admission and invocation separately from enabled inventory', () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    try {
      printSkillList([{ name: 'manual-only', scope: 'project', enabled: true,
        runtimeAvailability: { runtime: 'dsh', state: 'ready', effectiveRevision: 'effective-v1', desiredRevision: 'next-v2', component: { modelInvocable: false } } }]);
      const text = log.mock.calls.map(args => args.join(' ')).join('\n');
      expect(text).toContain('Runtime admission: ready; model invocation: unavailable');
      expect(text).toContain('Effective generation: effective-v1; desired: next-v2');
      expect(text).toContain('Enabled reflects installation settings');
    } finally { log.mockRestore(); }
  });
});


describe('concise skill inventory', () => {
  it('parses verbose without consuming the command and routes config discovery', () => {
    expect(parseArgs(['skill', '--verbose', 'list']).positional).toEqual(['skill', 'list']);
    expect(buildRoute('config', 'list', ['proxySettings'])).toBe('config/list');
    expect(buildRequestBody('config', 'list', ['proxySettings'], {})).toEqual({ prefix: 'proxySettings' });
    expect(buildRoute('config', 'unset', ['notARealKey'])).toBe('config/unset');
    expect(buildRequestBody('config', 'unset', ['notARealKey'], { dryRun: true })).toEqual({ key: 'notARealKey', dryRun: true });
  });
  it('hides normal admission details by default while verbose retains them', () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    const skills = [{ name: 'normal', runtimeAvailability: { runtime: 'dsh', state: 'ready', effectiveRevision: 'v1', desiredRevision: 'v1', component: { modelInvocable: true, state: 'applied', code: 'dsh_extension_component_ready' } } }];
    try {
      printSkillList(skills);
      expect(log.mock.calls.flat().join('\n')).not.toContain('Runtime admission:');
      expect(log.mock.calls.flat().join('\n')).not.toContain('Reason:');
      log.mockClear();
      printSkillList(skills, { verbose: true });
      expect(log.mock.calls.flat().join('\n')).toContain('Runtime admission: ready');
    } finally { log.mockRestore(); }
  });
});


describe('internal CLI command admission', () => {
  it('admits the documented Skill inventory detail', () => {
    expect(validateInternalCliInvocation(['skill', 'list'], { verbose: true, workspace: '/test' })).toBeUndefined();
  });
  it('admits the existing Skill removal preview before building the request', () => {
    expect(validateInternalCliInvocation(['skill', 'remove', 'skill-name'], { dryRun: true, scope: 'user' })).toBeUndefined();
    expect(validateDryRunSupport(['skill', 'remove', 'skill-name'], { dryRun: true })).toBeUndefined();
    expect(buildRequestBody('skill', 'remove', ['skill-name'], { dryRun: true, scope: 'user' }))
      .toMatchObject({ name: 'skill-name', dryRun: true, scope: 'user' });
  });
  it.each([
    [[], { frobnicate: true }],
    [['session', 'get', 'session-id'], { bogusflag: true }],
    [['task', 'create-direct'], { totallyBogusFlag: 'yes' }],
    [['session', 'start'], { model: 'ignored-model' }],
    [['agent', 'channel'], { frobnicate: true }],
  ])('rejects silently ignored options before dispatch', (positional, flags) => {
    expect(validateInternalCliInvocation(positional as string[], flags)).toMatchObject({ code: 'UNKNOWN_FLAG' });
  });
  it('rejects a positional argument on readme and preserves real Record filters', () => {
    expect(validateInternalCliInvocation(['vision', 'readme', 'extra-arg'], {})).toMatchObject({ code: 'ARGUMENT_INVALID' });
    expect(validateInternalCliInvocation(['record', 'list'], { limit: '1', json: true })).toBeUndefined();
    expect(buildRequestBody('record', 'get', ['record-id'], {})).toEqual({ id: 'record-id' });
    expect(buildRequestBody('record', 'delete', ['record-id'], {})).toEqual({ id: 'record-id' });
  });
  it('infers recurring schedules on create and update while retaining an omitted update mode', () => {
    const schedule = { name: 'test', workspacePath: '/test', taskMdContent: 'test', cronExpression: '0 9 * * *' };
    expect(buildRequestBody('task', 'create-direct', [], schedule)).toMatchObject({ executionMode: 'recurring' });
    expect(buildRequestBody('task', 'update', ['task-id'], { cronExpression: '0 9 * * *' })).toMatchObject({ executionMode: 'recurring' });
    expect(buildRequestBody('task', 'update', ['task-id'], { name: 'renamed' })).not.toHaveProperty('executionMode');
  });
});

describe('channel message CLI contract', () => {
  it.each([['--input-json', '{"text":"hello"}'], ['--input-file', '/tmp/request.json'], ['--input-file', '-']])('accepts the real %s invocation through the CLI flag gate', (flag, value) => {
    const parsed = parseArgs(['im', 'send-message', flag, value]);
    expect(validateCliCommand(parsed.positional)).toBeUndefined();
    expect(validateInternalCliInvocation(parsed.positional, parsed.flags)).toBeUndefined();
  });
  it('preserves JSON content and rejects authority fields and ambiguous input sources', () => {
    const request = {text:'line one\n"quoted" $literal',target:{type:'user',id:'person',idType:'open_id'}};
    expect(buildRequestBody('im','send-message',[],{inputJson:JSON.stringify(request)})).toEqual(request);
    expect(() => buildRequestBody('im','send-message',[],{inputJson:'{}',inputFile:'file'})).toThrow('exactly one');
    expect(() => buildRequestBody('im','send-message',[],{inputJson:JSON.stringify({...request,sessionId:'forged'})})).toThrow();
  });
  it('prints partial receipts even without --json so accepted content is not retried', () => {
    const log=vi.spyOn(console,'log').mockImplementation(()=>undefined);
    const error=vi.spyOn(console,'error').mockImplementation(()=>undefined);
    const data={status:'partial',items:[{status:'sent',messageIds:['m']},{status:'unknown'}]};
    try {
      printResult('im','send-message',{success:false,data},false);
      expect(JSON.parse(String(log.mock.calls[0]?.[0]))).toEqual(data);
      expect(error).not.toHaveBeenCalled();
    } finally {log.mockRestore();error.mockRestore();}
  });
});

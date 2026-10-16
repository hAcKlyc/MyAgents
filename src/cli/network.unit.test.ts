import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  buildRequestBody, buildRoute, cliRequestTimeoutMs, parseArgs, publicCliHelp,
  validateCliCommand, validateExternalCliInvocation, validateInternalCliInvocation,
} from './myagents';
import { EXTERNAL_CLI_PUBLIC_CAPABILITIES, isExternalCliPublicRoute } from '../shared/externalCliCapabilities';

const uuid = '45f36ff2-4356-4143-ae02-931ec0b057b9';
const commands = [
  ['status', [], {}],
  ['login', ['--connection', 'saved-owned', '--revision', '17'], { connectionId: 'saved-owned', expectedRevision: 17 }],
  ['poll', ['--attempt', uuid], { attemptId: uuid }],
  ['cancel', ['--attempt', uuid], { attemptId: uuid }],
  ['restore', ['--connection', 'saved-owned', '--revision', '17', '--operation-id', uuid], { connectionId: 'saved-owned', expectedRevision: 17, operationId: uuid }],
  ['cancel-restore', ['--operation-id', uuid], { operationId: uuid }],
] as const;

afterEach(() => vi.restoreAllMocks());

describe('saved network CLI contract', () => {
  it.each(commands)('builds only the native %s payload and advertises its route', (action, args, body) => {
    const { positional, flags } = parseArgs(['network', action, ...args]);
    expect(validateCliCommand(positional)).toBeUndefined();
    expect(validateExternalCliInvocation(positional, flags)).toBeUndefined();
    expect(validateInternalCliInvocation(positional, flags)).toBeUndefined();
    expect(buildRoute('network', action, [])).toBe(`network/${action}`);
    expect(buildRequestBody('network', action, [], flags)).toEqual(body);
    expect(isExternalCliPublicRoute(`network/${action}`)).toBe(true);
    expect(publicCliHelp(positional)).toContain(`network ${action}`);
  });

  it.each(commands)('rejects all extra positional values for %s in both caller modes', (action, args) => {
    const { positional, flags } = parseArgs(['network', action, 'injected', ...args]);
    expect(validateExternalCliInvocation(positional, flags)?.code).toBe('ARGUMENT_INVALID');
    expect(validateInternalCliInvocation(positional, flags)?.code).toBe('ARGUMENT_INVALID');
  });

  it.each(['password', 'token', 'api-token', 'issuer', 'device-id', 'principal', 'sidecar-id', 'wait', 'mystery'])(
    'rejects --%s without admitting or forwarding credentials or identity', flag => {
      for (const [action, args] of commands) {
        const { positional, flags } = parseArgs(['network', action, ...args, `--${flag}=injected`]);
        expect(validateExternalCliInvocation(positional, flags)?.code).toBe('UNKNOWN_FLAG');
        expect(validateInternalCliInvocation(positional, flags)?.code).toBe('UNKNOWN_FLAG');
      }
    },
  );

  it.each<[string, Record<string, unknown>]>([
    ['login', {}], ['login', { connection: true, revision: '1' }],
    ['login', { connection: ' ', revision: '1' }],
    ['login', { connection: ' saved', revision: '1' }],
    ['login', { connection: 'x'.repeat(201), revision: '1' }],
    ['login', { connection: 'bad\nconnection', revision: '1' }],
    ...[true, '', '-1', '1.5', '1e2', '0x1', '9007199254740992', ' 1', Infinity].map((revision): [string, Record<string, unknown>] => ['login', { connection: 'saved', revision }]),
    ['poll', {}], ['poll', { attempt: true }], ['poll', { attempt: 'not-a-uuid' }],
    ['cancel', { attempt: 'not-a-uuid' }], ['cancel-restore', { operationId: true }],
    ['restore', { connection: 'saved', revision: '1' }],
    ['restore', { connection: 'saved', revision: '1', operationId: 'not-a-uuid' }],
  ])('rejects invalid %s values before HTTP', (action, flags) => {
    vi.spyOn(process, 'exit').mockImplementation(code => { throw new Error(`exit:${code}`); });
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    expect(() => buildRequestBody('network', action, [], flags)).toThrow('exit:2');
  });

  it('normalizes macOS uuidgen uppercase attempt and operation IDs', () => {
    for (const action of ['poll', 'cancel']) {
      expect(buildRequestBody('network', action, [], { attempt: uuid.toUpperCase() }))
        .toEqual({ attemptId: uuid });
    }
    expect(buildRequestBody('network', 'cancel-restore', [], { operationId: uuid.toUpperCase() }))
      .toEqual({ operationId: uuid });
    expect(buildRequestBody('network', 'restore', [], { connection: 'saved', revision: '0', operationId: uuid.toUpperCase() }))
      .toEqual({ connectionId: 'saved', expectedRevision: 0, operationId: uuid });
  });

  it('preserves zero and the safe integer limit without coercing unsupported number syntax', () => {
    for (const revision of ['0', String(Number.MAX_SAFE_INTEGER)]) {
      expect(buildRequestBody('network', 'login', [], { connection: 'saved', revision }))
        .toEqual({ connectionId: 'saved', expectedRevision: Number(revision) });
    }
  });

  it('keeps network help and the public allowlist narrow and explicit', () => {
    expect(publicCliHelp(['network'])).toContain('network cancel-restore');
    expect(publicCliHelp(['network', 'restore'])).toContain('--operation-id');
    expect(publicCliHelp(['network', 'login'])).toContain('does not open a browser');
    expect(validateExternalCliInvocation(['network'], {})?.code).toBe('SUBCOMMAND_REQUIRED');
    expect(validateCliCommand(['network', 'create'])?.code).toBe('UNKNOWN_COMMAND');
    expect(isExternalCliPublicRoute('network/create')).toBe(false);
    expect(EXTERNAL_CLI_PUBLIC_CAPABILITIES.filter(item => item.command.startsWith('network '))).toHaveLength(6);
    expect(cliRequestTimeoutMs('network/restore')).toBeGreaterThan(40_000);
    expect(cliRequestTimeoutMs('network/login')).toBeGreaterThan(80_000);
    expect(cliRequestTimeoutMs('network/poll')).toBeGreaterThan(80_000);
    expect(publicCliHelp(['network', 'status'])).toContain('loginAttempts {attemptId, connectionId, expiresAt}');
  });
});

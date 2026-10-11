import { chmodSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { resolveHostProviderCredential } from './host-credentials';
import { hostExecutionLimits } from './host-execution-limits';

let directory: string | undefined;
afterEach(() => { vi.unstubAllEnvs(); if (directory) rmSync(directory, { recursive: true, force: true }); });

it('resolves private credential references only in Host mode and rejects unsafe paths', () => {
  directory = mkdtempSync(join(tmpdir(), 'mah-creds-'));
  writeFileSync(join(directory, 'kimi'), 'test-only-token\n', { mode: 0o600 });
  vi.stubEnv('CREDENTIALS_DIRECTORY', directory); vi.stubEnv('MYAGENTS_HOST_MODE', '');
  expect(() => resolveHostProviderCredential('systemd-credential:kimi')).toThrow('unavailable');
  expect(resolveHostProviderCredential('legacy-desktop-token')).toBe('legacy-desktop-token');
  vi.stubEnv('MYAGENTS_HOST_MODE', '1');
  expect(resolveHostProviderCredential('systemd-credential:kimi')).toBe('test-only-token');
  expect(() => resolveHostProviderCredential('systemd-credential:../kimi')).toThrow('unavailable');
  symlinkSync(join(directory, 'kimi'), join(directory, 'linked'));
  expect(() => resolveHostProviderCredential('systemd-credential:linked')).toThrow('private');
  chmodSync(join(directory, 'kimi'), 0o644);
  expect(() => resolveHostProviderCredential('systemd-credential:kimi')).toThrow('private');
  chmodSync(join(directory, 'kimi'), 0o600); writeFileSync(join(directory, 'kimi'), '');
  expect(() => resolveHostProviderCredential('systemd-credential:kimi')).toThrow('invalid');
});

it('requires valid bounded limits in Host mode and leaves desktop Query options unchanged', () => {
  vi.stubEnv('MYAGENTS_HOST_MODE', ''); expect(hostExecutionLimits()).toEqual({});
  vi.stubEnv('MYAGENTS_HOST_MODE', '1'); vi.stubEnv('MYAGENTS_HOST_MAX_TURNS', '6'); vi.stubEnv('MYAGENTS_HOST_MAX_BUDGET_USD', '0.25');
  expect(hostExecutionLimits()).toEqual({ maxTurns: 6, maxBudgetUsd: 0.25 });
  vi.stubEnv('MYAGENTS_HOST_MAX_BUDGET_USD', 'NaN'); expect(() => hostExecutionLimits()).toThrow('invalid');
});

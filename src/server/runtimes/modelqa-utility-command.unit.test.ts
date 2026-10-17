import { afterEach, describe, expect, it, vi } from 'vitest';
import { realpathSync } from 'node:fs';
const flags = vi.hoisted(() => ({ modelqa: false, updaterqa: false }));
vi.mock('../../shared/updaterQa', () => ({ isModelQaBuild: () => flags.modelqa, isUpdaterQaBuild: () => flags.updaterqa }));
import { modelqaUtilityCommand } from './modelqa-utility-command';
afterEach(() => { flags.modelqa = false; flags.updaterqa = false; vi.unstubAllEnvs(); });
describe('modelqa native utility executable admission', () => {
  it.each(['codex', 'claude-code'] as const)('uses only the explicit executable for isolated system %s and skips fallback discovery', runtime => {
    flags.modelqa = true; const binary = realpathSync(process.execPath);
    vi.stubEnv(runtime === 'codex' ? 'MOXBOTS_MODELQA_CODEX_EXECUTABLE' : 'MOXBOTS_MODELQA_CLAUDE_EXECUTABLE', binary);
    const fallback = vi.fn(() => 'never'); expect(modelqaUtilityCommand(runtime, 'system-cli', fallback)).toBe(binary); expect(fallback).not.toHaveBeenCalled();
  });
  it.each(['production', 'updaterqa', 'managed'] as const)('ignores a poisoned override in %s', mode => {
    flags.modelqa = mode !== 'production'; flags.updaterqa = mode === 'updaterqa';
    vi.stubEnv('MOXBOTS_MODELQA_CODEX_EXECUTABLE', 'not/a/binary');
    const fallback = vi.fn(() => '/normal/native');
    expect(modelqaUtilityCommand('codex', mode === 'managed' ? 'managed-provider' : 'system-cli', fallback)).toBe('/normal/native'); expect(fallback).toHaveBeenCalledOnce();
  });
  it.each([undefined, 'relative-command', '/nonexistent/modelqa-native'])('fails closed for missing or invalid approved path %s', path => {
    flags.modelqa = true; vi.stubEnv('MOXBOTS_MODELQA_CODEX_EXECUTABLE', path);
    const fallback = vi.fn(() => 'never'); expect(() => modelqaUtilityCommand('codex', 'system-cli', fallback)).toThrow(); expect(fallback).not.toHaveBeenCalled();
  });
});

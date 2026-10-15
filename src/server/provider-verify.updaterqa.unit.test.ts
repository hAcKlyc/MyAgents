import { describe, expect, it, vi } from 'vitest';
const guards = vi.hoisted(() => ({
  fs: vi.fn((..._args: unknown[]) => { throw new Error('QA must not probe user files'); }),
  exec: vi.fn(() => { throw new Error('QA must not probe OS credentials'); }),
  query: vi.fn(() => { throw new Error('QA must not launch SDK'); }),
}));
vi.mock('../shared/updaterQa', () => ({ isUpdaterQaBuild: () => true, isIsolatedQaBuild: () => true, isModelQaBuild: () => false }));
vi.mock('fs', () => ({ existsSync: guards.fs, readFileSync: guards.fs }));
vi.mock('../shared/appProfile', () => ({ APP_DATA_DIR_NAME: '.moxbot-updaterqa', APP_BUILD_PROFILE: 'moxbot', APP_CLI_NAME: 'moxbot-updaterqa', APP_DISPLAY_NAME: 'MoXBots Updater QA', APP_URL_SCHEME: 'moxbot-updaterqa', APP_WEBSITE_URL: 'https://140.143.183.232/', IS_UPDATER_QA: true }));
vi.mock('child_process', () => ({ execFileSync: guards.exec, execSync: guards.exec }));
vi.mock('@anthropic-ai/claude-agent-sdk', () => ({ query: guards.query }));
vi.mock('./agent-session', () => ({ resolveClaudeCodeCli: guards.exec, buildClaudeSessionEnv: guards.exec, startOneShotBridge: guards.exec, getSidecarPort: guards.exec }));
vi.mock('./utils/admin-config', () => ({ findEffectiveProvider: guards.fs, loadConfig: guards.fs }));
import { checkAnthropicSubscription, verifySubscription, verifyProviderViaSdk, fetchSdkSupportedModels } from './provider-verify';

describe('updater QA disables account and provider credential discovery', () => {
  it('returns unavailable before reading user files, Keychain, provider configs or running SDK', async () => {
    // Importing the existing config owner may inspect its own QA root; it must
    // never consult a daily profile. Provider probes themselves perform no IO.
    for (const [path] of guards.fs.mock.calls) {
      expect(String(path)).toMatch(/\/\.moxbot-updaterqa\/config\.json$/);
    }
    guards.fs.mockClear();
    expect(checkAnthropicSubscription()).toEqual({ available: false });
    expect(await verifySubscription()).toMatchObject({ success: false, error: 'UPDATER_QA_MODEL_EXECUTION_DISABLED' });
    expect(await verifyProviderViaSdk('test-provider', 'https://example.invalid', 'fixture-value', 'api_key')).toMatchObject({ success: false, error: 'UPDATER_QA_MODEL_EXECUTION_DISABLED' });
    expect(await fetchSdkSupportedModels()).toEqual([]);
    expect(guards.fs).not.toHaveBeenCalled();
    expect(guards.exec).not.toHaveBeenCalled();
    expect(guards.query).not.toHaveBeenCalled();
  });
});

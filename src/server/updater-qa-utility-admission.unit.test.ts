import { expect, it, vi } from 'vitest';

const backends = vi.hoisted(() => ({
  query: vi.fn(), runtime: vi.fn(), env: vi.fn(), bridge: vi.fn(), prepare: vi.fn(), config: vi.fn(),
}));
vi.mock('../shared/updaterQa', () => ({ isUpdaterQaBuild: () => true }));
vi.mock('../shared/appProfile', () => ({
  APP_DATA_DIR_NAME: '.moxbot-updaterqa', APP_BUILD_PROFILE: 'moxbot',
  APP_CLI_NAME: 'moxbot-updaterqa', APP_DISPLAY_NAME: 'MoXBots Updater QA',
  APP_URL_SCHEME: 'moxbot-updaterqa', APP_WEBSITE_URL: 'https://140.143.183.232/', IS_UPDATER_QA: true,
}));
vi.mock('./agent-session', () => ({
  buildClaudeSessionEnv: backends.env, resolveClaudeCodeCli: backends.env,
  startOneShotBridge: backends.bridge, getSidecarPort: backends.env,
}));
vi.mock('@anthropic-ai/claude-agent-sdk', () => ({ query: backends.query }));
vi.mock('./runtimes/codex', () => ({ CodexRuntime: backends.runtime }));
vi.mock('./runtimes/claude-code', () => ({ ClaudeCodeRuntime: backends.runtime }));
vi.mock('./utils/managed-proxy-binding', () => ({ prepareProviderBinding: backends.prepare }));
vi.mock('./utils/admin-config', () => ({ loadConfig: backends.config, resolveProviderEnv: backends.prepare }));

import { generateUtilityText, generateTitleExternal } from './title-generator';
import { startSubscriptionLogin, submitSubscriptionLoginCode } from './subscription-auth';
import { analyzeImages } from './official-tools/vision';

it('QA title and text utilities reject before constructing external runtimes, bridges or credentials', async () => {
  expect(await generateTitleExternal([{ user: 'synthetic', assistant: 'fixture' }], 'codex', 'fixture', '/qa')).toBeNull();
  expect(await generateTitleExternal([{ user: 'synthetic', assistant: 'fixture' }], 'claude-code', 'fixture', '/qa')).toBeNull();
  expect(await generateUtilityText({ prompt: 'fixture', systemPrompt: 'fixture', clean: text => text }, 'fixture', { apiProtocol: 'openai' } as never)).toBeNull();
  expect(backends.runtime).not.toHaveBeenCalled();
  expect(backends.bridge).not.toHaveBeenCalled();
  expect(backends.prepare).not.toHaveBeenCalled();
  expect(backends.query).not.toHaveBeenCalled();
});

it('QA OAuth cannot launch a login session or pass an authorization code to the SDK', async () => {
  expect(await startSubscriptionLogin()).toMatchObject({ status: 'error', error: 'UPDATER_QA_EXECUTION_DISABLED' });
  expect(await submitSubscriptionLoginCode('synthetic-authorization-code')).toMatchObject({ status: 'error', error: 'UPDATER_QA_EXECUTION_DISABLED' });
  expect(backends.env).not.toHaveBeenCalled();
  expect(backends.query).not.toHaveBeenCalled();
});

it('QA vision denies before even selecting a provider or resolving an image file', async () => {
  await expect(analyzeImages({ workspacePath: '/qa', images: ['/synthetic/image.png'] } as never)).rejects.toThrow('UPDATER_QA_EXECUTION_DISABLED');
  expect(backends.config).not.toHaveBeenCalled();
  expect(backends.prepare).not.toHaveBeenCalled();
  expect(backends.query).not.toHaveBeenCalled();
});

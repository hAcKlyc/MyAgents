import { afterEach, expect, it, vi } from 'vitest';
const mocks = vi.hoisted(() => ({ query: vi.fn(), close: vi.fn(), release: vi.fn(async () => {}), runtime: vi.fn(), prepare: vi.fn() }));
vi.mock('../shared/updaterQa', () => ({ isModelQaBuild: () => true, isUpdaterQaBuild: () => false, isIsolatedQaBuild: () => true }));
vi.mock('../shared/appProfile', () => ({ APP_BUILD_PROFILE: 'moxbot', APP_DATA_DIR_NAME: '.moxbot-modelqa', APP_CLI_NAME: 'moxbot-modelqa', APP_DISPLAY_NAME: 'MoXBots Model QA', APP_URL_SCHEME: 'moxbot-modelqa', APP_WEBSITE_URL: 'https://140.143.183.232/', IS_MODEL_QA: true, IS_UPDATER_QA: false }));
vi.mock('@anthropic-ai/claude-agent-sdk', () => ({ query: mocks.query }));
vi.mock('./agent-session', () => ({ resolveClaudeCodeCli: () => '/synthetic/cli', buildClaudeSessionEnv: () => ({}), startOneShotBridge: () => null }));
vi.mock('./utils/fs-utils', () => ({ ensureDirSync: () => {} }));
vi.mock('./runtimes/codex', () => ({ CodexRuntime: mocks.runtime }));
vi.mock('./runtimes/claude-code', () => ({ ClaudeCodeRuntime: mocks.runtime }));
vi.mock('./utils/managed-proxy-binding', () => ({ getPreparedSdkSystemPrompt: (_env: unknown, prompt: string) => prompt, prepareProviderBinding: mocks.prepare }));
import { generateUtilityText, generateTitleExternal } from './title-generator';
import { createGuardedSdkQuery } from './utils/sdk-child-launch-guard';
import { hasModelQaUtilityAdmission, withModelQaUtilityAdmission } from './utils/model-qa-utility-admission';

afterEach(() => vi.clearAllMocks());
it('rejects unscoped SDK launch and implicit subscription before credential preparation', async () => {
  const create = vi.fn();
  await expect(createGuardedSdkQuery('/synthetic/cli', create)).rejects.toThrow('MODEL_QA_UTILITY_ONLY');
  expect(create).not.toHaveBeenCalled();
  expect(await generateUtilityText({ prompt: 'synthetic', systemPrompt: 'qa', clean: t => t }, 'model')).toBeNull();
  expect(mocks.prepare).not.toHaveBeenCalled();
  expect(await generateTitleExternal([{ user: 'fixture', assistant: 'fixture' }], 'codex', 'model', '/qa')).toBeNull();
  expect(mocks.runtime).not.toHaveBeenCalled();
});
it('audited real utility owner removes project settings and exposes no tools, MCP or persistence', async () => {
  mocks.prepare.mockImplementation(async ({ providerEnv }: { providerEnv: unknown }) => ({ providerEnv, beforeTurn: async () => {}, release: mocks.release, reportTerminal: async () => {} }));
  mocks.query.mockImplementation(() => {
    expect(hasModelQaUtilityAdmission()).toBe(true);
    return Object.assign((async function* () { yield { type: 'result', subtype: 'success', result: '合成验收建议' }; })(), { close: mocks.close });
  });
  const result = await generateUtilityText({ prompt: 'synthetic', systemPrompt: 'qa', clean: t => t, settingSources: ['project'], requireSuccessfulTerminal: true }, 'explicit-model', { providerId: 'qa-provider', apiKey: 'synthetic-not-a-secret', baseUrl: 'https://fixture.invalid', apiProtocol: 'anthropic' } as never);
  expect(result).toBe('合成验收建议');
  expect(mocks.query.mock.calls[0][0].options).toMatchObject({ tools: [], mcpServers: {}, strictMcpConfig: true, persistSession: false, settingSources: [], maxTurns: 1 });
  expect(hasModelQaUtilityAdmission()).toBe(false);
  expect(mocks.release).toHaveBeenCalledOnce();
});
it('async utility admission never leaks into concurrent ordinary work and is released after error', async () => {
  let release!: () => void;
  const pending = withModelQaUtilityAdmission(async () => { await new Promise<void>(r => { release = r; }); expect(hasModelQaUtilityAdmission()).toBe(true); throw new Error('synthetic'); });
  expect(hasModelQaUtilityAdmission()).toBe(false);
  await expect(createGuardedSdkQuery('/synthetic/cli', vi.fn())).rejects.toThrow('MODEL_QA_UTILITY_ONLY');
  release(); await expect(pending).rejects.toThrow('synthetic');
  expect(hasModelQaUtilityAdmission()).toBe(false);
});
it('detached async callbacks inherit a revoked scope after the utility finishes', async () => {
  let inspect!: () => boolean;
  await withModelQaUtilityAdmission(async () => {
    const { AsyncResource } = await import('node:async_hooks');
    const child = new AsyncResource('synthetic-delayed-child');
    inspect = () => child.runInAsyncScope(hasModelQaUtilityAdmission);
    expect(inspect()).toBe(true);
  });
  expect(inspect()).toBe(false);
});
it('an in-flight management admission cannot spawn after its utility owner has finished', async () => {
  let resolve!: (value: unknown) => void;
  const admitted = new Promise<unknown>(r => { resolve = r; });
  const create = vi.fn();
  let inflight!: Promise<unknown>;
  const managementCall = vi.fn(async (path: string) => path.endsWith('/admit') ? admitted : { ok: true });
  await withModelQaUtilityAdmission(async () => {
    inflight = createGuardedSdkQuery('/synthetic/cli', create, { sidecarId: 'qa-sidecar', managementCall });
  });
  resolve({ ok: true, admitted: true, admissionEpoch: 1 });
  await expect(inflight).rejects.toThrow('MODEL_QA_UTILITY_ONLY');
  expect(create).not.toHaveBeenCalled();
});

import { DSH_PERMISSION_MODES } from '../../shared/types/runtime';
import { afterEach, describe, expect, it, vi } from 'vitest';
const mocks = vi.hoisted(() => ({ modelqa: true, config: {} as Record<string, unknown>,
  codex: vi.fn(async () => '请细化空文件的测试样例。'), claude: vi.fn(async () => '请细化缺失列的测试样例。'),
  dshStart: vi.fn(async (_options: Record<string, unknown>, _callback: (event: { kind: string }) => void) => ({ pid: 99 })), dshRun: vi.fn(async () => '请细化重复数据的预期结果。'), dshStop: vi.fn(async () => {}),
  provider: { id: 'qa-provider', enabled: true, models: [{ model: 'qa-model' }] },
}));
vi.mock('../../shared/updaterQa', () => ({ isUpdaterQaBuild: () => false, isModelQaBuild: () => mocks.modelqa }));
// This route unit toggles the admission flag; compiled profile consistency has separate integration coverage.
vi.mock('../../shared/appProfile', () => ({ APP_BUILD_PROFILE: 'moxbot', APP_DATA_DIR_NAME: '.moxbot-modelqa', APP_CLI_NAME: 'moxbot-modelqa', APP_DISPLAY_NAME: 'MoXBots Model QA' }));
vi.mock('../../shared/integrated-runtimes/provider-constraints', () => ({ getProviderExecutionConstraint: () => ({ kind: 'portable' }) }));
vi.mock('../utils/admin-config', () => ({ loadConfig: vi.fn(() => mocks.config), findEffectiveProvider: vi.fn(() => mocks.provider), resolveProviderEnv: vi.fn(() => ({ apiKey: 'fixture-never-emit' })) }));
vi.mock('../title-generator', () => ({ generateUtilityText: vi.fn(() => { throw new Error('SDK path forbidden'); }) }));
vi.mock('../runtimes/codex-text-utility', () => ({ generateCodexTextUtility: mocks.codex }));
vi.mock('../runtimes/claude-text-utility', () => ({ generateClaudeTextUtility: mocks.claude }));
vi.mock('../integrated-runtimes/dsh/runtime', () => ({ DshRuntime: class { startSession = mocks.dshStart; runTextUtility = mocks.dshRun; stopSession = mocks.dshStop; } }));
vi.mock('node:fs/promises', () => ({ mkdtemp: vi.fn(async () => '/var/tmp/isolated-modelqa'), realpath: vi.fn(async () => '/private/var/tmp/isolated-modelqa'), rm: vi.fn(async () => {}) }));
import { modelqaNextPromptHandler } from './next-prompt';
const choices = [
  { runtime: 'codex', runtimeSource: 'system-cli', model: 'native-codex-model' },
  { runtime: 'claude-code', runtimeSource: 'system-cli', model: 'native-claude-model' },
  { runtime: 'dsh', runtimeSource: 'integrated', providerId: 'qa-provider', model: 'qa-model' },
];
function req(body?: unknown, signal?: AbortSignal) { return new Request('http://localhost/api/modelqa/next-prompt', { method: body ? 'POST' : 'GET', ...(body ? { body: JSON.stringify(body) } : {}), signal }); }
afterEach(() => { vi.clearAllMocks(); mocks.modelqa = true; mocks.config = { modelqaNextPromptRuntimes: choices }; mocks.codex.mockResolvedValue('请细化空文件的测试样例。'); mocks.dshStart.mockResolvedValue({ pid: 99 }); });

describe('isolated modelqa next-prompt acceptance route', () => {
  it('is completely inaccessible in production and for unrelated paths', async () => {
    mocks.modelqa = false;
    expect(await modelqaNextPromptHandler(req())).toBeNull();
    mocks.modelqa = true;
    expect(await modelqaNextPromptHandler(new Request('http://localhost/api/other'))).toBeNull();
    const { loadConfig } = await import('../utils/admin-config'); expect(loadConfig).not.toHaveBeenCalled();
  });
  it('returns only explicitly authorized metadata and never credential/config contents', async () => {
    mocks.config = { providerApiKeys: { secret: 'fixture-never-emit' }, modelqaNextPromptRuntimes: choices };
    const res = await modelqaNextPromptHandler(req());
    expect(res?.status).toBe(200);
    const body = await res!.text();
    expect(body).not.toContain('fixture-never-emit'); expect(JSON.parse(body).runtimes).toHaveLength(3);
    expect(mocks.codex).not.toHaveBeenCalled(); expect(mocks.dshStart).not.toHaveBeenCalled();
  });
  it('does not invent runtime/model metadata when no QA authorization list exists', async () => {
    mocks.config = {};
    expect(await (await modelqaNextPromptHandler(req()))!.json()).toEqual({ runtimes: [] });
  });
  it.each(['prompt', 'workspacePath', 'credential', 'endpoint', 'apiKey'])('rejects arbitrary %s input before native execution', async field => {
    mocks.config = { modelqaNextPromptRuntimes: choices };
    const response = await modelqaNextPromptHandler(req({ ...choices[0], [field]: 'injected' }));
    expect(response?.status).toBe(400); expect(mocks.codex).not.toHaveBeenCalled();
  });
  it('rejects unlisted models and cross-runtime Provider credentials', async () => {
    mocks.config = { modelqaNextPromptRuntimes: choices };
    expect((await modelqaNextPromptHandler(req({ ...choices[0], model: 'not-authorized' })))?.status).toBe(403);
    expect((await modelqaNextPromptHandler(req({ ...choices[0], providerId: 'qa-provider' })))?.status).toBe(400);
  });
  it.each([0, 1])('passes the real owner service synthetic completed CSV context to native runtime %s', async index => {
    mocks.config = { modelqaNextPromptRuntimes: choices };
    const response = await modelqaNextPromptHandler(req(choices[index]));
    expect(response?.status).toBe(200);
    const body = await response!.json();
    expect(body.suggestion).toContain('测试样例');
    expect(body.receipt).toMatchObject({ ...choices[index], syntheticPriorTranscript: true, normalTurnStarted: false, noTools: true });
    const native = index === 0 ? mocks.codex : mocks.claude;
    expect(native).toHaveBeenCalledWith(expect.objectContaining({ prompt: expect.stringContaining('CSV导入'), systemPrompt: expect.stringContaining('untrusted DATA'), workspacePath: '/private/var/tmp/isolated-modelqa', model: choices[index].model }));
    const { rm } = await import('node:fs/promises'); expect(rm).toHaveBeenCalledWith('/var/tmp/isolated-modelqa', { recursive: true, force: true });
  });
  it('prepares DSH without a root turn, runs its native utility, and always stops the isolated session', async () => {
    mocks.config = { modelqaNextPromptRuntimes: choices };
    const response = await modelqaNextPromptHandler(req(choices[2]));
    expect(response?.status).toBe(200);
    expect(mocks.dshStart).toHaveBeenCalledWith(expect.objectContaining({ runtimeSource: 'integrated', providerRoute: { kind: 'provider', providerId: 'qa-provider', model: 'qa-model' } }), expect.any(Function));
    const admitted = mocks.dshStart.mock.calls[0]![0];
    expect(DSH_PERMISSION_MODES.map(mode => mode.value)).toContain(admitted.permissionMode);
    expect((await response!.json()).suggestion).toBe('请细化重复数据的预期结果。');
    expect(admitted).not.toHaveProperty('initialTurn');
    expect(mocks.dshStart.mock.calls[0]![0]).not.toHaveProperty('dshExtensions');
    expect(mocks.dshRun).toHaveBeenCalledTimes(1); expect(mocks.dshStop).toHaveBeenCalledTimes(1);
  });
  it('fails closed if DSH emits a normal turn or tool event during prepare', async () => {
    mocks.config = { modelqaNextPromptRuntimes: choices };
    mocks.dshStart.mockImplementationOnce(async (_options, onEvent) => { onEvent({ kind: 'turn_started' }); return { pid: 99 }; });
    const response = await modelqaNextPromptHandler(req(choices[2]));
    expect(response?.status).toBe(500); expect(await response!.json()).toEqual({ error: 'native_boundary_violation' });
    expect(mocks.dshRun).not.toHaveBeenCalled(); expect(mocks.dshStop).toHaveBeenCalled();
  });
  it('allows only one inference and cancels without retaining the active slot', async () => {
    mocks.config = { modelqaNextPromptRuntimes: choices };
    let finish!: (value: string) => void;
    mocks.codex.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
    const controller = new AbortController();
    const pending = modelqaNextPromptHandler(req(choices[0], controller.signal));
    await vi.waitFor(() => expect(mocks.codex).toHaveBeenCalled());
    expect((await modelqaNextPromptHandler(req(choices[0])))?.status).toBe(409);
    controller.abort(); expect((await pending)?.status).toBe(499);
    expect((await modelqaNextPromptHandler(req(choices[0])))?.status).toBe(409); // Native cancellation cleanup still owns the slot.
    finish('请细化测试');
    await new Promise(resolve => setTimeout(resolve, 0));
    expect((await modelqaNextPromptHandler(req(choices[0])))?.status).toBe(200);
  });
  it('retains the slot until late DSH prepare and stop both settle after cancellation', async () => {
    mocks.config = { modelqaNextPromptRuntimes: choices };
    let prepare!: (value: { pid: number }) => void;
    let stopped!: () => void;
    mocks.dshStop.mockImplementationOnce(() => new Promise<void>(resolve => { stopped = resolve; }));
    mocks.dshStart.mockImplementationOnce(() => new Promise(resolve => { prepare = resolve; }));
    const controller = new AbortController(); const pending = modelqaNextPromptHandler(req(choices[2], controller.signal));
    await vi.waitFor(() => expect(mocks.dshStart).toHaveBeenCalled());
    controller.abort(); expect((await pending)?.status).toBe(499);
    expect((await modelqaNextPromptHandler(req(choices[0])))?.status).toBe(409); // Preparing has not returned a handle.
    prepare({ pid: 99 }); await vi.waitFor(() => expect(mocks.dshStop).toHaveBeenCalled());
    expect((await modelqaNextPromptHandler(req(choices[0])))?.status).toBe(409); // The late handle is still stopping.
    expect(mocks.dshRun).not.toHaveBeenCalled();
    stopped(); await new Promise(resolve => setTimeout(resolve, 0));
    expect((await modelqaNextPromptHandler(req(choices[0])))?.status).toBe(200);
  });
});

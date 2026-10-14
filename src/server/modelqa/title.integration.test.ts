import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';

const state = vi.hoisted(() => ({
  qa: true, dir: '.moxbot-modelqa', home: '', config: {} as Record<string, unknown>,
  providers: [] as Array<Record<string, unknown>>, env: {} as Record<string, unknown>,
  generate: vi.fn(), load: vi.fn(),
}));
vi.mock('node:os', async original => ({ ...await original<typeof import('node:os')>(), homedir: () => state.home }));
vi.mock('../../shared/updaterQa', () => ({ isModelQaBuild: () => state.qa }));
vi.mock('../../shared/appProfile', () => ({ get APP_DATA_DIR_NAME() { return state.dir; } }));
vi.mock('../title-generator', () => ({ generateTitle: state.generate }));
vi.mock('../utils/admin-config', () => ({
  loadConfig: state.load,
  getAllEffectiveProviders: () => state.providers,
  resolveProviderEnv: () => state.env,
}));
import { modelqaTitleHandler } from './title';

const endpoint = 'http://127.0.0.1:32418/api/modelqa/title';
const request = (input: Record<string, unknown> = {}, signal?: AbortSignal) => new Request(endpoint, {
  method: 'POST', headers: { 'Content-Type': 'application/json' }, signal,
  body: JSON.stringify({ providerId: 'qa-kimi', modelId: 'k3', fixtureId: 'expense-summary', requestId: randomUUID(), ...input }),
});
const dispatch = async (req: Request) => {
  const result = await modelqaTitleHandler(req); expect(result).not.toBeNull(); return result!;
};
beforeEach(() => {
  vi.clearAllMocks(); state.qa = true; state.dir = '.moxbot-modelqa';
  state.home = mkdtempSync(join(tmpdir(), 'moxbots-title-modelqa-test-'));
  state.config = { modelqaTitleUtilities: [{ providerId: 'qa-kimi', modelId: 'k3' }] };
  state.providers = [{ id: 'qa-kimi', name: 'QA Kimi', type: 'api', enabled: true, execution: { kind: 'builtin' }, models: [{ model: 'k3', modelName: 'K3' }] },
    { id: 'unapproved', name: 'Other configured provider', type: 'api', models: [{ model: 'other', modelName: 'Other' }] }];
  state.env = { providerId: 'qa-kimi', apiKey: 'synthetic-key-not-for-wire', baseUrl: 'https://provider.example.test', apiProtocol: 'anthropic' };
  state.load.mockImplementation(() => state.config); state.generate.mockResolvedValue('费用包万元展示与毛利校验');
});
afterEach(() => { rmSync(state.home, { recursive: true, force: true }); });

describe('isolated model QA title HTTP owner', () => {
  it('returns production404 before reading config, disk or invoking a model', async () => {
    state.qa = false;
    expect((await dispatch(request())).status).toBe(404);
    expect(state.load).not.toHaveBeenCalled(); expect(state.generate).not.toHaveBeenCalled();
  });
  it('leaves other routes to their existing owner', async () => {
    expect(await modelqaTitleHandler(new Request('http://127.0.0.1/api/chat'))).toBeNull();
    expect(state.load).not.toHaveBeenCalled();
  });
  it('rejects a mixed profile instead of using ordinary app storage', async () => {
    state.dir = '.moxbot'; expect((await dispatch(request())).status).toBe(503);
    expect(state.generate).not.toHaveBeenCalled();
  });
  it('GET lists only explicitly authorized pairs and no credential or endpoint', async () => {
    const result = await dispatch(new Request(endpoint)); const text = await result.text();
    expect(result.headers.get('cache-control')).toBe('no-store');
    expect(text).toContain('qa-kimi'); expect(text).not.toContain('unapproved');
    expect(text).not.toContain('synthetic-key-not-for-wire'); expect(text).not.toContain('provider.example.test');
    expect(state.generate).not.toHaveBeenCalled();
  });
  it('no configured allowlist admits no available key by default', async () => {
    state.config = {};
    expect((await (await dispatch(new Request(endpoint))).json()).providers).toEqual([]);
    expect((await dispatch(request())).status).toBe(403); expect(state.generate).not.toHaveBeenCalled();
  });
  it.each([
    { apiKey: 'caller-key' }, { baseUrl: 'https://untrusted.example/' }, { prompt: 'read private files' },
    { runtime: 'codex' }, { rounds: [{ user: 'arbitrary private context' }] },
  ])('rejects unknown input %j without executing', async extra => {
    expect((await dispatch(request(extra))).status).toBe(400); expect(state.generate).not.toHaveBeenCalled();
  });
  it('rejects unauthorized model or Provider and unknown fixture', async () => {
    expect((await dispatch(request({ modelId: 'other' }))).status).toBe(403);
    expect((await dispatch(request({ providerId: 'unapproved' }))).status).toBe(403);
    expect((await dispatch(request({ fixtureId: 'arbitrary' }))).status).toBe(400);
    expect(state.generate).not.toHaveBeenCalled();
  });
  it('rejects invalid operation IDs and non-JSON payloads', async () => {
    expect((await dispatch(request({ requestId: '../escape' }))).status).toBe(400);
    expect((await dispatch(new Request(endpoint, { method: 'POST', body: 'text' }))).status).toBe(400);
  });
  it('bounds a chunked body even without Content-Length', async () => {
    const stream = new ReadableStream<Uint8Array>({ start(controller) { controller.enqueue(new TextEncoder().encode(' '.repeat(2049))); controller.close(); } });
    const init = { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: stream, duplex: 'half' } as RequestInit;
    expect((await dispatch(new Request(endpoint, init))).status).toBe(413); expect(state.generate).not.toHaveBeenCalled();
  });
  it.each([
    { enabled: false }, { type: 'subscription' }, { execution: { kind: 'runtime', runtimeType: 'codex' } },
  ])('blocks unsafe Provider state %j', async changes => {
    Object.assign(state.providers[0], changes);
    expect((await dispatch(request())).status).toBe(403); expect(state.generate).not.toHaveBeenCalled();
  });
  it.each([
    { apiKey: '' }, { apiKey: '   ' }, { credentialSource: { kind: 'managed-oauth' } },
    { endpointSource: { kind: 'cliproxy' } }, { baseUrl: 'http://provider.example.test' },
  ])('does not borrow ambient credentials or endpoint authorities %j', async changes => {
    Object.assign(state.env, changes);
    expect((await dispatch(request())).status).toBe(403); expect(state.generate).not.toHaveBeenCalled();
  });
  it('passes the fixed real task to the title owner and persists only the safe receipt', async () => {
    const id = randomUUID(); const result = await dispatch(request({ requestId: id })); expect(result.status).toBe(200);
    const call = state.generate.mock.calls[0];
    expect(call[0][0].user).toContain('金额改为万元'); expect(call[0][0].user.length).toBeGreaterThan(200);
    expect(call[1]).toBe('k3'); expect(call[3]).toBe(id); expect(call[4]).toBeInstanceOf(AbortSignal);
    const stored = readFileSync(join(state.home, '.moxbot-modelqa', 'title-utility-receipt.json'), 'utf8');
    expect(stored).toContain('费用包万元展示与毛利校验'); expect(stored).not.toContain('synthetic-key-not-for-wire');
    const loaded = await (await dispatch(new Request(endpoint))).json();
    expect(loaded.receipt.requestId).toBe(id); expect(loaded.receipt.automaticSessionTitle).toBe(false);
    expect(loaded.receipt.toolsEnabled).toBe(false);
    expect((await dispatch(request({ requestId: id }))).status).toBe(409); expect(state.generate).toHaveBeenCalledTimes(1);
  });
  it('failed generation preserves the preceding persisted result', async () => {
    const id = randomUUID(); await dispatch(request({ requestId: id })); state.generate.mockResolvedValueOnce(null);
    expect((await dispatch(request())).status).toBe(502);
    expect((await (await dispatch(new Request(endpoint))).json()).receipt.requestId).toBe(id);
  });
  it('single active operation rejects concurrency and cancellation targets only its own ID', async () => {
    let finish!: (value: string | null) => void;
    state.generate.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
    const id = randomUUID(); const pending = dispatch(request({ requestId: id }));
    await vi.waitFor(() => expect(state.generate).toHaveBeenCalledTimes(1));
    expect((await dispatch(request())).status).toBe(409);
    expect((await dispatch(new Request(`${endpoint}?requestId=${randomUUID()}`, { method: 'DELETE' }))).status).toBe(404);
    expect(state.generate.mock.calls[0][4].aborted).toBe(false);
    expect((await dispatch(new Request(`${endpoint}?requestId=${id}`, { method: 'DELETE' }))).status).toBe(202);
    expect(state.generate.mock.calls[0][4].aborted).toBe(true);
    finish('late model text'); expect((await pending).status).toBe(499);
    expect((await (await dispatch(new Request(endpoint))).json()).receipt).toBeNull();
  });
  it('request disconnection reaches the model signal and suppresses late success', async () => {
    let finish!: (value: string) => void; const controller = new AbortController();
    state.generate.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
    const pending = dispatch(request({}, controller.signal));
    await vi.waitFor(() => expect(state.generate).toHaveBeenCalledTimes(1)); controller.abort();
    expect(state.generate.mock.calls[0][4].aborted).toBe(true); finish('费用包展示');
    expect((await pending).status).toBe(499); expect((await (await dispatch(new Request(endpoint))).json()).receipt).toBeNull();
  });
  it('cancel after commit reports completed rather than rewriting success as cancelled', async () => {
    const id = randomUUID(); await dispatch(request({ requestId: id }));
    const result = await dispatch(new Request(`${endpoint}?requestId=${id}`, { method: 'DELETE' }));
    expect(result.status).toBe(200); expect((await result.json()).status).toBe('completed');
  });
  it('refuses an escaping state directory before model execution', async () => {
    const outside = join(state.home, 'other'); mkdirSync(outside); symlinkSync(outside, join(state.home, '.moxbot-modelqa'));
    expect((await dispatch(request())).status).toBe(503); expect(state.generate).not.toHaveBeenCalled();
  });
  it('does not surface malformed or credential-bearing receipt fields', async () => {
    mkdirSync(join(state.home, '.moxbot-modelqa')); writeFileSync(join(state.home, '.moxbot-modelqa', 'title-utility-receipt.json'), JSON.stringify({ apiKey: 'invalid-saved-secret' }));
    const result = await dispatch(new Request(endpoint)); expect((await result.json()).receipt).toBeNull();
  });
});

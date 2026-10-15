import { describe, it, expect, vi } from 'vitest';
import { runDshTextUtility } from './text-utility';
const task = { prompt: 'synthetic transcript', systemPrompt: 'suggest text only' };
function fixture() {
  const request = vi.fn(async () => ({ state: 'succeeded', text: '请验证边界。' }));
  const process = { exited: false, activeOperationId: undefined as string | undefined, configuration: { profile: { revision: 'frozen-profile' } }, host: { request } };
  return { process, request };
}
describe('DSH native auxiliary utility', () => {
  it('only calls utility/run with the frozen profile and a bounded output, never starts a root turn', async () => {
    const { process, request } = fixture();
    expect(await runDshTextUtility(process as never, task)).toBe('请验证边界。');
    expect(request).toHaveBeenCalledTimes(1);
    expect(request).toHaveBeenCalledWith('utility/run', expect.objectContaining({ ...task, modelProfileRevision: 'frozen-profile', maxTokens: 512, clientOperationId: expect.any(String) }), { signal: expect.any(AbortSignal) });
  });
  it.each(['failed', 'aborted'])('rejects partial text on %s terminal', async state => {
    const { process, request } = fixture(); request.mockResolvedValue({ state, text: 'partial' });
    expect(await runDshTextUtility(process as never, task)).toBeNull();
  });
  it('rejects stale profile, process exit, busy or pre-aborted tasks', async () => {
    const { process, request } = fixture();
    request.mockImplementation(async () => { process.configuration.profile.revision = 'changed'; return { state: 'succeeded', text: 'stale' }; });
    expect(await runDshTextUtility(process as never, task)).toBeNull();
    request.mockClear(); process.activeOperationId = 'root-busy';
    expect(await runDshTextUtility(process as never, task)).toBeNull();
    process.activeOperationId = undefined; process.exited = true;
    expect(await runDshTextUtility(process as never, task)).toBeNull();
    process.exited = false;
    expect(await runDshTextUtility(process as never, { ...task, signal: AbortSignal.abort() })).toBeNull();
    expect(request).not.toHaveBeenCalled();
  });
  it('propagates cancellation to the auxiliary RPC and returns no partial output', async () => {
    const { process, request } = fixture();
    const controller = new AbortController();
    request.mockImplementation(async (...args: unknown[]) => { const opts = args[2] as { signal: AbortSignal }; controller.abort(); expect(opts.signal.aborted).toBe(true); return { state: 'aborted', text: 'partial' }; });
    expect(await runDshTextUtility(process as never, { ...task, signal: controller.signal })).toBeNull();
  });
});

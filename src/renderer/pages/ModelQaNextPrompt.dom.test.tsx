import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ToastProvider } from '@/components/Toast';
import { ImagePreviewProvider } from '@/context/ImagePreviewContext';
const mocks = vi.hoisted(() => ({ enabled: true, fetch: vi.fn() }));
vi.mock('../../shared/updaterQa', () => ({ isModelQaBuild: () => mocks.enabled }));
vi.mock('@/api/apiFetch', () => ({ apiFetch: mocks.fetch }));
vi.mock('@/config/useConfigData', () => ({ useConfigData: () => ({ config: { chatSendShortcut: 'enter' }, projects: [] }) }));
import ModelQaNextPrompt from './ModelQaNextPrompt';
const choice = { runtime: 'codex', runtimeSource: 'system-cli', model: 'native-model' };
const suggestion = '请验证空文件、重复列名和无效日期。';
function mount() { return render(<ToastProvider><ImagePreviewProvider><ModelQaNextPrompt /></ImagePreviewProvider></ToastProvider>); }
beforeEach(() => {
  mocks.enabled = true; mocks.fetch.mockReset(); HTMLElement.prototype.scrollIntoView = vi.fn();
  mocks.fetch.mockImplementation(async (_path, init) => new Response(JSON.stringify(init?.method === 'POST'
    ? { sessionId: 'synthetic-s', anchorMessageId: 'synthetic-a', suggestion, receipt: { ...choice, syntheticPriorTranscript: true, normalTurnStarted: false, noTools: true } }
    : { runtimes: [choice] }), { status: 200 }));
});
describe('modelqa next prompt real-service surface', () => {
  it('is unreachable and performs no request outside the compiled QA profile', () => {
    mocks.enabled = false; mount(); expect(screen.queryByTestId('modelqa-next-prompt')).not.toBeInTheDocument(); expect(mocks.fetch).not.toHaveBeenCalled();
  });
  it('uses the real composer, accepts once as editable draft, and never sends a root turn', async () => {
    mount(); await waitFor(() => expect(screen.getByRole('button', { name: '生成真实建议' })).toBeEnabled());
    fireEvent.click(screen.getByRole('button', { name: '生成真实建议' }));
    await screen.findByTestId('next-prompt-ghost');
    expect(mocks.fetch).toHaveBeenCalledTimes(2);
    const request = mocks.fetch.mock.calls[1][1]; expect(JSON.parse(request.body)).toEqual(choice);
    const input = screen.getByRole('textbox'); expect(input).toHaveValue('');
    const counter = screen.getByTestId('intercepted-send-attempts');
    expect(counter).toHaveAttribute('role', 'status'); expect(counter).toHaveTextContent('已拦截发送尝试：0');
    fireEvent.compositionStart(input); fireEvent.keyDown(input, { key: 'Enter', isComposing: true }); expect(input).toHaveValue('');
    expect(counter).toHaveTextContent('已拦截发送尝试：0');
    fireEvent.compositionEnd(input); fireEvent.keyDown(input, { key: 'Enter' }); expect(input).toHaveValue(suggestion);
    expect(counter).toHaveTextContent('已拦截发送尝试：0');
    fireEvent.keyDown(input, { key: 'Enter', repeat: true }); expect(input).toHaveValue(suggestion);
    expect(counter).toHaveTextContent('已拦截发送尝试：0');
    fireEvent.compositionStart(input); fireEvent.keyDown(input, { key: 'Enter', isComposing: true }); fireEvent.compositionEnd(input);
    expect(counter).toHaveTextContent('已拦截发送尝试：0');
    fireEvent.change(input, { target: { value: '修改后的草稿' } }); fireEvent.keyDown(input, { key: 'Enter' });
    await waitFor(() => expect(counter).toHaveTextContent('已拦截发送尝试：1'));
    expect(input).toHaveValue('修改后的草稿'); expect(mocks.fetch).toHaveBeenCalledTimes(2);
    expect(screen.getByTestId('generation-receipt')).toHaveTextContent('"normalTurnStarted": false');
  });
  it('dismisses with Escape and reports failures visibly', async () => {
    mount(); await waitFor(() => expect(screen.getByRole('button', { name: '生成真实建议' })).toBeEnabled());
    fireEvent.click(screen.getByRole('button', { name: '生成真实建议' })); await screen.findByTestId('next-prompt-ghost');
    fireEvent.keyDown(screen.getByRole('textbox'), { key: 'Escape' }); expect(screen.queryByTestId('next-prompt-ghost')).not.toBeInTheDocument();
    expect(screen.getByTestId('intercepted-send-attempts')).toHaveTextContent('已拦截发送尝试：0');
    mocks.fetch.mockResolvedValueOnce(new Response('{}', { status: 502 }));
    fireEvent.click(screen.getByRole('button', { name: '生成真实建议' })); expect(await screen.findByRole('alert')).toHaveTextContent('真实生成失败');
  });
  it('resets intercepted attempts for each fresh generation without starting a normal task', async () => {
    mount(); const generate = screen.getByRole('button', { name: '生成真实建议' });
    await waitFor(() => expect(generate).toBeEnabled()); fireEvent.click(generate);
    await screen.findByTestId('next-prompt-ghost');
    const input = screen.getByRole('textbox'); fireEvent.keyDown(input, { key: 'Enter' });
    fireEvent.click(screen.getByTitle(/发送/));
    await waitFor(() => expect(screen.getByTestId('intercepted-send-attempts')).toHaveTextContent('已拦截发送尝试：1'));
    expect(mocks.fetch).toHaveBeenCalledTimes(2);
    fireEvent.click(generate); await screen.findByTestId('next-prompt-ghost');
    expect(screen.getByTestId('intercepted-send-attempts')).toHaveTextContent('已拦截发送尝试：0');
    expect(screen.getByRole('textbox')).toHaveValue(''); expect(mocks.fetch).toHaveBeenCalledTimes(3);
  });
  it('reuses one real result for independent composer checks without changing the receipt or requesting generation', async () => {
    mount(); const generate = screen.getByRole('button', { name: '生成真实建议' });
    await waitFor(() => expect(generate).toBeEnabled()); fireEvent.click(generate);
    await screen.findByTestId('next-prompt-ghost');
    const receipt = screen.getByTestId('generation-receipt').textContent;
    const input = screen.getByRole('textbox'); fireEvent.keyDown(input, { key: 'Enter' }); fireEvent.keyDown(input, { key: 'Enter' });
    await waitFor(() => expect(screen.getByTestId('intercepted-send-attempts')).toHaveTextContent('已拦截发送尝试：1'));
    const reset = screen.getByRole('button', { name: '重置草稿与建议（复用本次结果）' });
    fireEvent.click(reset);
    expect(screen.getByRole('textbox')).not.toBe(input); expect(screen.getByRole('textbox')).toHaveValue('');
    expect(screen.getByTestId('next-prompt-ghost')).toHaveTextContent(suggestion);
    expect(screen.getByTestId('intercepted-send-attempts')).toHaveTextContent('已拦截发送尝试：0');
    fireEvent.keyDown(screen.getByRole('textbox'), { key: 'Escape' }); expect(screen.queryByTestId('next-prompt-ghost')).not.toBeInTheDocument();
    fireEvent.click(reset); expect(screen.getByTestId('next-prompt-ghost')).toHaveTextContent(suggestion);
    expect(screen.getByTestId('generation-receipt').textContent).toBe(receipt);
    expect(mocks.fetch).toHaveBeenCalledTimes(2);
  });
});

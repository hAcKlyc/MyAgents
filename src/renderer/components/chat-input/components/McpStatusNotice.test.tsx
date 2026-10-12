import { act, fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { i18n } from '@/i18n';
import { ToastProvider } from '@/components/Toast';
import { McpStatusNotice } from './McpStatusNotice';
import type { McpEffectiveServerSnapshot } from '../../../../shared/mcpEffectiveState';

const failed: McpEffectiveServerSnapshot = {
  id: 'playwright', desired: true, state: 'failed', toolCount: 0,
  errorCode: 'MCP_CONNECTION_TIMEOUT', attemptGeneration: 1, updatedAt: 1,
};
function notice(props: Partial<React.ComponentProps<typeof McpStatusNotice>> = {}) {
  return <ToastProvider><McpStatusNotice server={failed} {...props} /></ToastProvider>;
}

describe('MCP status and explicit retry', () => {
  beforeEach(async () => { await i18n.changeLanguage('zh-CN'); });

  it('shows a useful reason and falls back for old unknown error codes', () => {
    const view = render(notice());
    expect(screen.getByText('工具连接超时')).toBeInTheDocument();
    view.rerender(notice({ server: { ...failed, errorCode: 'upstream-new-code' } }));
    expect(screen.getByText('当前不可用')).toBeInTheDocument();
    expect(screen.queryByText('upstream-new-code')).not.toBeInTheDocument();
  });

  it('distinguishes stale observation, authorization and ready state', () => {
    const retry = vi.fn();
    const view = render(notice({ stale: true }));
    expect(screen.getByText('状态待确认')).toBeInTheDocument();
    view.rerender(notice({ server: { ...failed, state: 'needs_auth' }, onRetry: retry }));
    expect(screen.getByText('需要登录授权')).toBeInTheDocument();
    expect(screen.queryByRole('button')).not.toBeInTheDocument();
    view.rerender(notice({ server: { ...failed, state: 'ready' } }));
    expect(screen.queryByText('工具连接超时')).not.toBeInTheDocument();
  });

  it('blocks busy sessions, deduplicates clicks and explains backend refusal', async () => {
    let resolve!: (result: { success: boolean; errorCode: 'session_busy' }) => void;
    const retry = vi.fn(() => new Promise<{ success: boolean; errorCode: 'session_busy' }>(done => { resolve = done; }));
    const view = render(notice({ busy: true, onRetry: retry }));
    expect(screen.getByRole('button', { name: '重试连接' })).toBeDisabled();
    view.rerender(notice({ onRetry: retry }));
    const button = screen.getByRole('button', { name: '重试连接' });
    fireEvent.click(button);
    fireEvent.click(button);
    expect(retry).toHaveBeenCalledExactlyOnceWith('playwright');
    expect(button).toBeDisabled();
    await act(async () => { resolve({ success: false, errorCode: 'session_busy' }); });
    expect(screen.getByText('请等待当前会话任务完成后重试')).toBeInTheDocument();
    expect(button).toBeEnabled();
  });

  it('preserves a non-2xx Tab API error code without showing raw error text', async () => {
    const retry = vi.fn().mockRejectedValue(Object.assign(new Error('HTTP 409 /private/SECRET'), { errorCode: 'session_busy' }));
    render(notice({ onRetry: retry }));
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: '重试连接' })); });
    expect(screen.getByText('请等待当前会话任务完成后重试')).toBeInTheDocument();
    expect(screen.queryByText(/SECRET/)).not.toBeInTheDocument();
  });

  it('keeps non-JSON 404 failures local and bounded across repeated retries', async () => {
    const retry = vi.fn().mockRejectedValue(Object.assign(new Error('HTTP 404'), { status: 404 }));
    render(notice({ onRetry: retry }));
    for (let attempt = 0; attempt < 3; attempt++) {
      await act(async () => { fireEvent.click(screen.getByRole('button', { name: '重试连接' })); });
    }
    expect(screen.getAllByText(/重连接口不可用（HTTP 404）/)).toHaveLength(1);
    expect(screen.getAllByRole('status')).toHaveLength(1);
  });

  it('starts a stopped environment and waits for a new owner snapshot after acceptance', async () => {
    const retry = vi.fn().mockResolvedValue({ success: true });
    const stopped = { ...failed, state: 'stopped' as const, errorCode: undefined };
    const view = render(notice({ server: stopped, onRetry: retry }));
    expect(screen.getByText('工具环境已停止，下轮消息时启动')).toBeInTheDocument();
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: '启动工具环境' })); });
    expect(screen.getByText('正在启动…')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '启动工具环境' })).toBeDisabled();
    fireEvent.click(screen.getByRole('button', { name: '启动工具环境' }));
    expect(retry).toHaveBeenCalledOnce();
    // Distinct owner observations may be published within the same millisecond.
    view.rerender(notice({ server: { ...failed }, onRetry: retry }));
    expect(screen.getByText('工具连接超时')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '重试连接' })).toBeEnabled();
    view.rerender(notice({ server: { ...failed, state: 'starting', updatedAt: 3 }, onRetry: retry }));
    expect(screen.getByText('正在启动…')).toBeInTheDocument();
    expect(screen.queryByRole('button')).not.toBeInTheDocument();
    view.rerender(notice({ server: { ...failed, state: 'ready', updatedAt: 4 }, onRetry: retry }));
    expect(screen.queryByRole('status')).not.toBeInTheDocument();
  });

  it('shows owner-settled startup failure after retry invalidation unmounts the old row', async () => {
    let reject!: (error: Error) => void;
    const retry = vi.fn(() => new Promise<never>((_, fail) => { reject = fail; }));
    const view = render(notice({ onRetry: retry }));
    fireEvent.click(screen.getByRole('button', { name: '重试连接' }));
    view.rerender(<ToastProvider>{null}</ToastProvider>);
    view.rerender(notice({ server: { ...failed, errorCode: 'MCP_STARTUP_FAILED', updatedAt: 2 }, onRetry: retry }));
    await act(async () => { reject(Object.assign(new Error('HTTP 502'), { status: 502, errorCode: 'retry_failed' })); });
    expect(screen.getByText('当前不可用')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '重试连接' })).toBeEnabled();
    expect(screen.getAllByRole('status')).toHaveLength(1);
  });
});

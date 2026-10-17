import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { BrowserToolEntry } from './BrowserToolEntry';
import type { BrowserResourceStatus } from '../../../../shared/browserTools';
import type { McpEffectiveServerSnapshot } from '../../../../shared/mcpEffectiveState';

const resource = vi.hoisted(() => ({ status: null as BrowserResourceStatus | null }));
vi.mock('@/hooks/useBrowserResourceReady', () => ({ useBrowserResourceStatus: () => resource.status }));

const ready: BrowserResourceStatus = {
  state: 'ready', requiredRevision: 'r1', installedRevision: 'r1', installAuthorized: true,
  retryable: false, automaticRetryCount: 0, statusRevision: 1, updatedAt: '',
};

describe('Agent browser discovery', () => {
  beforeEach(() => { resource.status = null; });

  it('offers setup before the browser is globally enabled without changing the selection', async () => {
    resource.status = { ...ready, state: 'never_installed', installAuthorized: false, installedRevision: undefined };
    const setup = vi.fn(); const toggle = vi.fn();
    render(<BrowserToolEntry available={false} selected={false} onSetup={setup} onToggle={toggle} />);
    expect(screen.getByText('Agent 浏览器')).toBeVisible();
    await userEvent.click(screen.getByRole('button', { name: '安装资源' }));
    expect(setup).toHaveBeenCalledOnce();
    expect(toggle).not.toHaveBeenCalled();
    expect(screen.queryByRole('switch')).not.toBeInTheDocument();
  });

  it('routes resources that are ready but globally disabled to enablement', async () => {
    resource.status = ready;
    const setup = vi.fn();
    render(<BrowserToolEntry available={false} selected={false} onSetup={setup} />);
    await userEvent.click(screen.getByRole('button', { name: '启用工具' }));
    expect(setup).toHaveBeenCalledOnce();
  });

  it('selects only the managed browser when both resource and global gates pass', async () => {
    resource.status = ready;
    const toggle = vi.fn();
    render(<BrowserToolEntry available selected={false} onSetup={vi.fn()} onToggle={toggle} />);
    await userEvent.click(screen.getByRole('switch', { name: 'Agent 浏览器' }));
    expect(toggle).toHaveBeenCalledWith('myagents-browser', true);
    expect(screen.queryByText(/已连接/)).not.toBeInTheDocument();
  });

  it('keeps deselection and recovery available during a failed resource update', async () => {
    resource.status = { ...ready, state: 'update_failed', installedRevision: 'old' };
    const setup = vi.fn(); const toggle = vi.fn();
    render(<BrowserToolEntry available selected onSetup={setup} onToggle={toggle} />);
    await userEvent.click(screen.getByRole('switch'));
    expect(toggle).toHaveBeenCalledWith('myagents-browser', false);
    await userEvent.click(screen.getByRole('button', { name: '设置 Agent 浏览器' }));
    expect(setup).toHaveBeenCalledOnce();
  });

  it('claims connected only for a fresh ready observation from the active runtime', () => {
    resource.status = ready;
    const effective: McpEffectiveServerSnapshot = { id: 'myagents-browser', desired: true, state: 'ready', toolCount: 30, attemptGeneration: 2, updatedAt: 1 };
    const view = render(<BrowserToolEntry available selected effective={effective} onSetup={vi.fn()} />);
    expect(screen.getByText('已连接，可以让 Agent 操作网页。')).toBeVisible();
    view.rerender(<BrowserToolEntry available selected effective={effective} stale onSetup={vi.fn()} />);
    expect(screen.queryByText('已连接，可以让 Agent 操作网页。')).not.toBeInTheDocument();
    expect(screen.getByText('已选择；等待当前会话确认连接。')).toBeVisible();
  });
});

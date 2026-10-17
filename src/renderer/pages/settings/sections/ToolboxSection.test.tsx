import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';

import type { McpServerDefinition } from '@/config/types';
import type { BrowserResourceStatus } from '../../../../shared/browserTools';
import { MANAGED_BROWSER_MCP_ID } from '../../../../shared/browserTools';
import { ToolboxSection } from './ToolboxSection';

vi.mock('@/components/CliToolsSection', () => ({
  CliToolsSection: () => null,
}));

const browserServer: McpServerDefinition = {
  id: MANAGED_BROWSER_MCP_ID,
  name: '浏览器',
  description: 'MyAgents 托管的 Chromium',
  type: 'stdio',
  command: '__browser_host__',
  args: [],
  isBuiltin: true,
  isFree: true,
};

function status(state: BrowserResourceStatus['state'], overrides: Partial<BrowserResourceStatus> = {}): BrowserResourceStatus {
  return {
    requiredRevision: 'runtime-2',
    installedRevision: undefined,
    installAuthorized: false,
    state,
    retryable: state !== 'ready',
    automaticRetryCount: 0,
    statusRevision: 1,
    updatedAt: '2026-08-22T00:00:00Z',
    ...overrides,
  };
}

function renderToolbox(browserResourceStatus: BrowserResourceStatus, mcpEnabledIds: string[] = []) {
  const onToggleMcp = vi.fn();
  const onInstallBrowserResource = vi.fn();
  render(
    <ToolboxSection
      mcpServers={[browserServer]}
      mcpEnabledIds={mcpEnabledIds}
      mcpEnabling={{}}
      mcpNeedsConfig={{}}
      browserResourceStatus={browserResourceStatus}
      onAddMcp={vi.fn()}
      onEditMcp={vi.fn()}
      onEditBuiltinMcp={vi.fn()}
      onToggleMcp={onToggleMcp}
      onInstallBrowserResource={onInstallBrowserResource}
    />,
  );
  return { onToggleMcp, onInstallBrowserResource };
}

describe('ToolboxSection managed Browser resources', () => {
  it('does not offer installation on an unsupported platform', () => {
    renderToolbox(status('unsupported', { errorCode: 'BROWSER_RESOURCE_UNSUPPORTED' }));
    expect(screen.getByRole('switch')).toBeDisabled();
    expect(screen.queryByRole('button', { name: '安装资源' })).not.toBeInTheDocument();
    expect(screen.getByText('当前平台暂不支持')).toBeVisible();
  });

  it('offers a resource status retry instead of an endless loading state', async () => {
    const retry = vi.fn();
    render(<ToolboxSection mcpServers={[browserServer]} mcpEnabledIds={[]} mcpEnabling={{}} mcpNeedsConfig={{}}
      browserResourceReadFailed onRefreshBrowserResource={retry} onAddMcp={vi.fn()} onEditMcp={vi.fn()}
      onEditBuiltinMcp={vi.fn()} onToggleMcp={vi.fn()} />);
    expect(screen.getByText('无法读取浏览器资源状态，请重试检查。')).toBeVisible();
    await userEvent.click(screen.getByRole('button', { name: '重新检查' }));
    expect(retry).toHaveBeenCalledOnce();
  });
  it('requires an explicit resource install before the Browser can be enabled', async () => {
    const user = userEvent.setup();
    const callbacks = renderToolbox(status('never_installed', { totalBytes: 261 * 1024 * 1024 }));

    expect(screen.getByRole('switch')).toBeDisabled();
    expect(screen.queryByText(/261\.0 MiB/)).not.toBeInTheDocument();
    expect(screen.getByText(/需要安装 Chromium 资源后才能启用/)).toBeVisible();
    await user.click(screen.getByRole('button', { name: '安装资源' }));
    expect(callbacks.onInstallBrowserResource).toHaveBeenCalledOnce();
    expect(callbacks.onToggleMcp).not.toHaveBeenCalled();
    expect(screen.queryByRole('button', { name: /卸载/ })).not.toBeInTheDocument();
  });

  it('shows update progress without clearing the enabled intent', async () => {
    const user = userEvent.setup();
    const callbacks = renderToolbox(
      status('updating', {
        installAuthorized: true,
        installedRevision: 'runtime-1',
        progressPercent: 42,
        totalBytes: 200 * 1024 * 1024,
      }),
      [MANAGED_BROWSER_MCP_ID],
    );

    const toggle = screen.getByRole('switch');
    expect(toggle).toBeChecked();
    expect(toggle).not.toBeDisabled();
    expect(screen.getByRole('progressbar')).toHaveAttribute('aria-valuenow', '42');
    expect(screen.getByText('42%')).toBeInTheDocument();
    await user.click(toggle);
    expect(callbacks.onToggleMcp).toHaveBeenCalledWith(browserServer, false);
  });

  it('unlocks the toggle only for the exact ready revision', async () => {
    const user = userEvent.setup();
    const callbacks = renderToolbox(
      status('ready', {
        installAuthorized: true,
        installedRevision: 'runtime-2',
        retryable: false,
      }),
    );

    const toggle = screen.getByRole('switch');
    expect(toggle).not.toBeDisabled();
    await user.click(toggle);
    expect(callbacks.onToggleMcp).toHaveBeenCalledWith(browserServer, true);
  });
});

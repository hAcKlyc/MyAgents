import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { i18n } from '@/i18n';
import { TaskAdvancedConfigEditor } from './TaskAdvancedConfigEditor';

const config = { agents: [] };
const empty: never[] = [];
vi.mock('@/hooks/useConfig', () => ({ useConfig: () => ({ config, projects: empty, providers: empty, apiKeys: {}, providerVerifyStatus: {} }) }));
vi.mock('@/hooks/useAvailableProviders', () => ({ useAvailableProviders: () => empty }));
vi.mock('@/hooks/useBrowserResourceReady', () => ({ useBrowserResourceReady: () => false }));
vi.mock('@/components/Toast', () => ({ useToast: () => ({ error: vi.fn() }) }));
vi.mock('@/api/apiFetch', () => ({ apiGetJson: vi.fn().mockResolvedValue({ models: [] }) }));

describe('Task Codex permissions', () => {
  beforeEach(async () => { await i18n.changeLanguage('zh-CN'); });

  function renderSource(source: 'managed-provider' | 'system-cli', permissionMode = 'auto-edit') {
    const setPermissionMode = vi.fn();
    render(<TaskAdvancedConfigEditor runtime="codex" runtimeConfig={{ source }} permissionMode={permissionMode}
      setRuntime={vi.fn()} setProviderId={vi.fn()} setModel={vi.fn()} setRuntimeConfig={vi.fn()}
      setPermissionMode={setPermissionMode} setMcpEnabledServers={vi.fn()} />);
    return setPermissionMode;
  }

  function openPermissions() {
    const trigger = screen.getByRole('button', { name: i18n.t('task:advanced.permissionLabel') });
    fireEvent.click(trigger);
    return trigger;
  }

  it('retains all three managed product modes with their existing stored aliases', () => {
    const setPermissionMode = renderSource('managed-provider');
    openPermissions();
    const plan = screen.getByRole('button', { name: /^规划/ });
    expect(screen.getByRole('button', { name: /^请求批准/ })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /^完全自主/ })).toBeInTheDocument();
    fireEvent.click(plan);
    expect(setPermissionMode).toHaveBeenCalledWith('suggest');
  });

  it('focuses the flat CLI catalogue and returns to its trigger on Escape', async () => {
    renderSource('system-cli');
    const trigger = screen.getByRole('button', { name: '跟随 Agent 当前模型' });
    fireEvent.click(trigger);
    const follow = screen.getByRole('button', { current: true });
    await waitFor(() => expect(follow).toHaveFocus());
    expect(screen.queryByRole('button', { expanded: false, name: /Codex/ })).toBeNull();
    fireEvent.keyDown(follow, { key: 'Escape' });
    expect(trigger).toHaveFocus();
    expect(trigger).toHaveAttribute('aria-expanded', 'false');
  });

  it('offers only native presets for the external CLI', () => {
    const setPermissionMode = renderSource('system-cli');
    openPermissions();
    expect(screen.getByRole('button', { name: /^请求批准/ })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /^完全访问权限/ })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /^Suggest/ })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /^帮我批准/ }));
    expect(setPermissionMode).toHaveBeenCalledWith('full-auto');
  });

  it('displays historical read-only task truthfully without adding a fourth selectable preset', () => {
    renderSource('system-cli', 'suggest');
    const trigger = openPermissions();
    expect(trigger).toHaveTextContent('Suggest');
    expect(trigger).toHaveTextContent('只读');
    expect(trigger).not.toHaveTextContent('最大权限');
    expect(screen.queryByRole('button', { name: /^Suggest/ })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: /^请求批准/ })).toBeInTheDocument();
  });
});

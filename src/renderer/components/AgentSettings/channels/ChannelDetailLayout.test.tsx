import { fireEvent, render, screen, within, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AgentConfig, ChannelConfig } from '../../../../shared/types/agent';
import ChannelDetailView from './ChannelDetailView';
import BindCodePanel from '../../ImSettings/components/BindCodePanel';
import BindQrPanel from '../../ImSettings/components/BindQrPanel';

const mocks = vi.hoisted(() => ({ tauri: false, invoke: vi.fn(), mutate: vi.fn() }));
vi.mock('@tauri-apps/api/core', async original => ({ ...await original<typeof import('@tauri-apps/api/core')>(), invoke: mocks.invoke }));
vi.mock('@/utils/tauriListen', () => ({ listenWithCleanup: vi.fn() }));
vi.mock('@/config/services/agentConfigService', async original => ({ ...await original<typeof import('@/config/services/agentConfigService')>(), mutateChannelAccess: mocks.mutate }));
vi.mock('@/analytics', () => ({ track: vi.fn() }));
vi.mock('@/utils/browserMock', () => ({ isTauriEnvironment: () => mocks.tauri }));
vi.mock('@/components/Toast', () => ({ useToast: () => ({ success: vi.fn(), error: vi.fn() }) }));
vi.mock('@/hooks/useConfig', () => ({ useConfig: () => ({ config: { agents: [] }, refreshConfig: vi.fn() }) }));

afterEach(() => { Reflect.deleteProperty(window, '__TAURI_INTERNALS__'); });

beforeEach(() => { mocks.tauri = false; mocks.mutate.mockReset().mockResolvedValue(undefined); mocks.invoke.mockReset().mockResolvedValue(null); });

function show(type: ChannelConfig['type'] = 'openclaw:wecom', accessMode?: ChannelConfig['accessMode'], groupPermissions?: ChannelConfig['groupPermissions']) {
  const agent: AgentConfig = { id: 'a', name: 'Agent', enabled: false, permissionMode: 'auto', channels: [{ id: 'c', type, accessMode, groupPermissions, enabled: false, allowedUsers: ['u'], userDisplayNames: { u: 'Alice' } }] };
  return render(<ChannelDetailView agent={agent} channelId="c" onBack={vi.fn()} onChanged={vi.fn()} />);
}

function expectBefore(first: Element, second: Element) {
  expect(first.compareDocumentPosition(second) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
}

describe('Channel detail layout', () => {
  it('shows a reply delivery warning while the transport remains online', async () => {
    mocks.tauri = true;
    mocks.invoke.mockImplementation(async command => command === 'cmd_agent_channel_status' ? {
      channelId: 'c', channelType: 'openclaw:wecom', status: 'online', uptimeSeconds: 1,
      activeSessions: [], restartCount: 0, bufferedMessages: 0,
      errorMessage: '有 1 条回复投递暂未完成，正在自动恢复。',
    } : null);
    show();
    expect(await screen.findByRole('alert')).toHaveTextContent('有 1 条回复投递暂未完成，正在自动恢复。');
    expect(screen.getByText('运行中')).toBeInTheDocument();
  });

  it('separates permission mode, expands user management and orders the management blocks', () => {
    show();
    const permission = screen.getByRole('region', { name: '权限模式' });
    expect(within(permission).queryByText('Alice（u）')).not.toBeInTheDocument();
    const users = screen.getByRole('button', { name: '用户管理' });
    expect(users).toHaveAttribute('aria-expanded', 'true');
    const userBody = document.getElementById(users.getAttribute('aria-controls')!)!;
    expect(within(userBody).getByText('Alice（u）')).toBeInTheDocument();
    expect(within(userBody).queryByRole('checkbox')).not.toBeInTheDocument();
    expect(within(userBody).queryByRole('textbox')).not.toBeInTheDocument();
    expectBefore(permission, users);
    expect(screen.queryByText(/下一轮生效/)).not.toBeInTheDocument();
    expectBefore(screen.getByText('启动渠道后可绑定。'), screen.getByRole('region', { name: '私聊用户' }));
    expectBefore(screen.getByRole('region', { name: '私聊用户' }), screen.getByRole('button', { name: '群聊管理' }));
    expectBefore(screen.getByRole('button', { name: '群聊管理' }), screen.getByRole('heading', { name: '消息发送方式' }));
    fireEvent.click(users);
    expect(users).toHaveAttribute('aria-expanded', 'false');
    expect(screen.getByText('Alice（u）')).not.toBeVisible();
    fireEvent.click(users);
    expect(screen.getByText('Alice（u）')).toBeInTheDocument();
  });

  it('retains pending row actions and errors across collapse and reopen', async () => {
    let reject!: (reason: Error) => void;
    mocks.mutate.mockImplementation(() => new Promise((_resolve, failure) => { reject = failure; }));
    show();
    fireEvent.click(screen.getByRole('button', { name: '拉黑' }));
    const users = screen.getByRole('button', { name: '用户管理' });
    fireEvent.click(users);
    fireEvent.click(users);
    expect(screen.getByRole('button', { name: '拉黑' })).toBeDisabled();
    reject(new Error('保存失败'));
    expect(await screen.findByRole('alert')).toHaveTextContent('保存失败');
    expect(screen.getByRole('button', { name: '拉黑' })).toBeEnabled();
    expect(mocks.mutate).toHaveBeenCalledOnce();
  });

  it('retains an in-flight group removal across fold and reopen', async () => {
    mocks.tauri = true;
    Object.defineProperty(window, '__TAURI_INTERNALS__', { configurable: true, value: { invoke: mocks.invoke } });
    let reject!: (reason: Error) => void;
    mocks.invoke.mockImplementation(command => command === 'cmd_remove_group' ? new Promise((_resolve, failure) => { reject = failure; }) : Promise.resolve(null));
    show('openclaw:wecom', 'review', [{ groupId: 'g', groupName: 'Team', platform: 'openclaw:wecom', status: 'approved', discoveredAt: '' }]);
    const row = screen.getByText('Team（g）').parentElement!;
    fireEvent.click(within(row).getByRole('button', { name: '移除' }));
    await waitFor(() => expect(mocks.invoke.mock.calls.some(([command, args]) => command === 'cmd_remove_group' && args.botId === 'c' && args.groupId === 'g')).toBe(true));
    const groups = screen.getByRole('button', { name: '群聊管理' });
    fireEvent.click(groups);
    fireEvent.click(groups);
    expect(within(row).getByRole('button', { name: '移除' })).toBeDisabled();
    reject(new Error('remove failed'));
    expect(await screen.findByRole('alert')).toHaveTextContent('remove failed');
    expect(within(row).getByRole('button', { name: '移除' })).toBeEnabled();
  });

  it('embeds a running QR-login entry before the user list without another card', async () => {
    mocks.tauri = true;
    mocks.invoke.mockImplementation(async command => command === 'cmd_agent_channel_status' ? {
      channelId: 'c', channelType: 'openclaw:openclaw-weixin', status: 'online', uptimeSeconds: 0,
      activeSessions: [], restartCount: 0, bufferedMessages: 0,
    } : null);
    show('openclaw:openclaw-weixin');
    const login = await screen.findByRole('button', { name: '扫码登录' });
    const userBody = document.getElementById(screen.getByRole('button', { name: '用户管理' }).getAttribute('aria-controls')!)!;
    expect(userBody).toContainElement(login);
    expect(screen.queryByRole('region', { name: '私聊用户' })).not.toBeInTheDocument();
    expect(login.closest('.border-dashed')).toBeNull();
    await waitFor(() => expect(screen.queryByText('启动渠道后可绑定。')).not.toBeInTheDocument());
  });

  it.each(['telegram', 'dingtalk'] as const)('puts %s sending options inside the final delivery block', type => {
    show(type);
    const delivery = screen.getByRole('heading', { name: '消息发送方式' }).closest('section')!;
    expectBefore(screen.getByRole('button', { name: '群聊管理' }), delivery);
    expect(within(delivery).getByText(type === 'telegram' ? 'Draft 流式模式' : 'AI Card 流式回复')).toBeInTheDocument();
    expectBefore(delivery, screen.getByRole('button', { name: /删除/ }));
  });

  it.each(['openclaw:openclaw-weixin', 'openclaw:weixin'] as const)('keeps %s free of multi-user permission and group controls', type => {
    show(type, 'review');
    expect(screen.queryByRole('region', { name: '权限模式' })).not.toBeInTheDocument();
    expect(screen.queryByRole('region', { name: '私聊用户' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: '群聊管理' })).not.toBeInTheDocument();
  });

  it.each(['openclaw:wecom', 'openclaw:wecom-openclaw-plugin', 'feishu', 'openclaw:openclaw-lark'] as const)('retains both modes for %s', type => {
    show(type, 'review');
    expect(screen.getByRole('button', { name: '白名单模式' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '自由模式' })).toBeInTheDocument();
    expect(screen.getByRole('region', { name: '私聊用户' })).toBeInTheDocument();
  });

  it('hides unnecessary binding content in open mode but retains users', () => {
    show('openclaw:wecom', 'open');
    expect(screen.getByText('无需绑定，直接使用。')).toBeInTheDocument();
    expect(screen.queryByText('口令绑定')).not.toBeInTheDocument();
    expect(screen.queryByText('启动渠道后可绑定。')).not.toBeInTheDocument();
    expect(screen.getByRole('region', { name: '私聊用户' })).toBeInTheDocument();
  });

  it('embeds binding content without changing default wizard card presentation', () => {
    const { container, rerender } = render(<BindCodePanel bindCode="BIND_FIXTURE" hasWhitelistUsers embedded />);
    expect(container.firstElementChild).not.toHaveClass('border');
    expect(screen.getByText('口令绑定')).toBeInTheDocument();
    expect(screen.getByTitle('复制口令')).toBeInTheDocument();
    expect(screen.getByText('发送上方口令（点击复制按钮）')).toBeInTheDocument();
    expect(screen.getByText('绑定成功后即可开始对话')).toBeInTheDocument();
    expect(screen.getByText(/私聊 Bot 发送以下口令/)).toBeInTheDocument();
    rerender(<BindCodePanel bindCode="BIND_FIXTURE" hasWhitelistUsers />);
    expect(container.firstElementChild).toHaveClass('border');
    rerender(<BindQrPanel bindUrl="https://t.me/fixture?start=BIND_fixture" hasWhitelistUsers embedded />);
    expect(container.firstElementChild).not.toHaveClass('border');
    rerender(<BindQrPanel bindUrl="https://t.me/fixture?start=BIND_fixture" hasWhitelistUsers />);
    expect(container.firstElementChild).toHaveClass('border');
  });
});

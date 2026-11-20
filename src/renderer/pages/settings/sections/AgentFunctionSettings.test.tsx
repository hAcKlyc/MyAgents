import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { invoke } from '@tauri-apps/api/core';
import AgentFunctionSettings from './AgentFunctionSettings';

vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn() }));

describe('Agent function settings', () => {
  beforeEach(() => {
    vi.mocked(invoke).mockResolvedValue({
      builtin: { installed: true }, dsh: { installed: true },
      antigravity: { installed: true },
      'claude-code': { installed: true }, codex: { installed: true },
    });
  });

  it('groups default environment before queue mode and offers only the two Integrated runtimes', async () => {
    const user = userEvent.setup();
    const updateConfig = vi.fn().mockResolvedValue(undefined);
    render(<AgentFunctionSettings config={{}} updateConfig={updateConfig} />);
    expect(screen.getByText('Agent 功能设置')).toBeInTheDocument();
    expect(screen.getByText('默认 Agent 运行环境').compareDocumentPosition(screen.getByText('队列响应模式')))
      .toBe(Node.DOCUMENT_POSITION_FOLLOWING);
    expect(screen.getByText('修改后默认以此运行环境运行，可在 Agent 设置中单独修改')).toBeInTheDocument();
    await waitFor(() => expect(invoke).toHaveBeenCalledWith('cmd_detect_runtimes'));
    expect(updateConfig).not.toHaveBeenCalled();
    await user.click(screen.getByRole('button', { name: 'MyAgents (Claude Agent SDK)' }));
    expect(screen.queryByText('Codex CLI')).not.toBeInTheDocument();
    expect(screen.queryByText('Claude Code CLI')).not.toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: /MyAgents \(DeepSeek Harness\)/ }));
    expect(updateConfig).toHaveBeenCalledExactlyOnceWith({ defaultIntegratedRuntime: 'dsh' });
  });

  it('keeps the queue control independent of the default runtime', async () => {
    const user = userEvent.setup();
    const updateConfig = vi.fn().mockResolvedValue(undefined);
    render(<AgentFunctionSettings config={{ defaultIntegratedRuntime: 'dsh', chatQueueResponseMode: 'realtime' }} updateConfig={updateConfig} />);
    expect(screen.getByRole('button', { name: 'MyAgents (DeepSeek Harness)' })).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: '轮次响应' }));
    expect(updateConfig).toHaveBeenCalledExactlyOnceWith({ chatQueueResponseMode: 'turn' });
  });
});

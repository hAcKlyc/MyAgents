import { fireEvent, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { i18n } from '@/i18n';
import type { ContextUsage } from '../../shared/types/context-usage';
import ContextUsageIndicator from './ContextUsageIndicator';

const mocks = vi.hoisted(() => ({
  tabState: {
    isLoading: false,
    contextUsage: {
      contextTokens: 128_000,
      contextWindow: 258_000,
      usedPercent: 49.6,
      source: 'codex' as const,
      windowSource: 'runtime' as const,
    } as ContextUsage,
  },
}));

vi.mock('@/context/TabContext', () => ({
  useTabState: () => mocks.tabState,
}));

describe('ContextUsageIndicator', () => {
  beforeEach(async () => {
    await i18n.changeLanguage('zh-CN');
    mocks.tabState.isLoading = false;
    mocks.tabState.contextUsage.windowSource = 'runtime';
    mocks.tabState.contextUsage.declaredContextWindow = undefined;
  });

  it('shows the injected compact action for Managed Codex context usage', async () => {
    const user = userEvent.setup();
    const onCompact = vi.fn();
    render(<ContextUsageIndicator onCompact={onCompact} />);

    fireEvent.mouseEnter(screen.getByLabelText('上下文已使用 50%'));
    const compact = await screen.findByRole('button', { name: '智能压缩' });
    await user.click(compact);

    expect(onCompact).toHaveBeenCalledOnce();
  });

  it('keeps the compact action hidden when the owning runtime does not inject it', () => {
    render(<ContextUsageIndicator />);

    fireEvent.mouseEnter(screen.getByLabelText('上下文已使用 50%'));
    expect(screen.queryByRole('button', { name: '智能压缩' })).not.toBeInTheDocument();
  });
  it('labels an operational budget separately from declared model capacity', async () => {
    mocks.tabState.contextUsage.windowSource = 'safety-budget';
    mocks.tabState.contextUsage.declaredContextWindow = 1_000_000;
    render(<ContextUsageIndicator />);
    fireEvent.mouseEnter(screen.getByLabelText('上下文已使用 50%'));
    expect(await screen.findByText('按压缩预算计算；模型标称容量 1M tokens')).toBeInTheDocument();
  });

});

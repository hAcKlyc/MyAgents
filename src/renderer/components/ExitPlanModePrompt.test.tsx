import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { ExitPlanModePrompt } from './ExitPlanModePrompt';

vi.mock('@/components/Markdown', () => ({ default: ({ children }: { children: string }) => <div>{children}</div> }));

describe('plan review content', () => {
  it.each([undefined, '', '   \n  '])('prevents approval of missing content %j and allows feedback/rejection', plan => {
    const onApprove = vi.fn();
    const onReject = vi.fn();
    render(<ExitPlanModePrompt request={{ requestId: 'empty', plan }} onApprove={onApprove} onReject={onReject} />);
    expect(screen.getByRole('alert')).toHaveTextContent('方案正文未能加载');
    const approve = screen.getByRole('button', { name: '批准执行' });
    expect(approve).toBeDisabled();
    fireEvent.click(approve);
    expect(onApprove).not.toHaveBeenCalled();
    fireEvent.change(screen.getByRole('textbox'), { target: { value: '请补充完整方案后重新提交' } });
    fireEvent.click(screen.getByRole('button', { name: '提交修改意见' }));
    expect(onReject).toHaveBeenCalledWith('请补充完整方案后重新提交');
  });

  it('shows the complete plan and retains it after approval', () => {
    const onApprove = vi.fn();
    const plan = '# Test plan\nStep 1\nStep 2\nAcceptance and rollback';
    const props = { onApprove, onReject: vi.fn() };
    const { rerender } = render(<ExitPlanModePrompt {...props} request={{ requestId: 'ready', plan }} />);
    expect(screen.getByText(/Acceptance and rollback/)).toBeVisible();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: '批准执行' }));
    expect(onApprove).toHaveBeenCalledOnce();
    rerender(<ExitPlanModePrompt {...props} request={{ requestId: 'ready', plan, resolved: 'approved' }} />);
    expect(screen.getByText(/Acceptance and rollback/)).toBeVisible();
    expect(screen.getByText('已批准')).toBeVisible();
  });

  it('allows rejecting an empty legacy card without granting execution', () => {
    const onReject = vi.fn();
    render(<ExitPlanModePrompt request={{ requestId: 'legacy' }} onApprove={vi.fn()} onReject={onReject} />);
    fireEvent.click(screen.getByRole('button', { name: '拒绝方案' }));
    expect(onReject).toHaveBeenCalledWith(undefined);
  });
});

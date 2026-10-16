import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import ExecutionQuality from './ExecutionQuality';
import type { Message } from '@/types/chat';

describe('execution quality reference', () => {
  it('stays collapsed and distinguishes evidence from unassessed answer quality', () => {
    const message: Message = { id: 'quality', role: 'assistant', timestamp: new Date(), usage: { inputTokens: 100, outputTokens: 40, model: 'fixture-model' }, content: [{ type: 'tool_use', tool: { id: 'test', name: 'Bash', input: {}, parsedInput: { command: 'npm test' }, streamIndex: 0, result: 'failed', resultMeta: { exitCode: 1 } } }] };
    const { container } = render(<ExecutionQuality message={message} />);
    expect(container.querySelector('details')).not.toHaveAttribute('open');
    expect(screen.getByText('0 项成功返回 · 1 项失败')).toBeTruthy();
    expect(screen.getByText('未评估')).toBeTruthy();
    expect(screen.getByText('输入 100 · 输出 40')).toBeTruthy();
    expect(container).not.toHaveTextContent(/评分|重试|tokens\/s/);
  });
});

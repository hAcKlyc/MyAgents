import { fireEvent, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { renderWithTheme as render } from '@/test/renderWithTheme';
import type { ToolUseSimple } from '@/types/chat';

import ToolUse from './ToolUse';

describe('ToolUse specialized result ownership', () => {
  it('leaves duration to the result row while retaining the command exit evidence', () => {
    const { container } = render(<ToolUse resultOnly tool={{ id: 'duration-once', name: 'Bash', input: {}, streamIndex: 0,
      result: 'Tests 24 passed', resultMeta: { exitCode: 0, durationMs: 2340 } }} />);
    expect(container).toHaveTextContent('Tests 24 passed');
    expect(container).toHaveTextContent('exit 0');
    expect(container).not.toHaveTextContent('耗时');
  });
  it('keeps result-only output bounded and never exposes unknown tool input or method names', () => {
    const { container } = render(<ToolUse resultOnly tool={{ id: 'large-result-only', name: 'InternalMethodName', input: {}, inputJson: 'PRIVATE_METHOD_ARGUMENT', streamIndex: 0, result: 'x'.repeat(100_000) }} />);
    expect(container.textContent!.length).toBeLessThan(51_000);
    expect(container).toHaveTextContent('结果过长');
    expect(container).not.toHaveTextContent('InternalMethodName');
    expect(container).not.toHaveTextContent('PRIVATE_METHOD_ARGUMENT');
  });

  it('preserves rich search results while result-only commands omit their invocation', () => {
    const search = render(<ToolUse resultOnly tool={{ id: 'search-result-only', name: 'WebSearch', input: { query: 'release' }, parsedInput: { query: 'release' }, streamIndex: 0, result: JSON.stringify({ results: [{ title: 'Release', url: 'https://example.com/release' }] }) }} />);
    expect(search.container).toHaveTextContent('Release');
    search.unmount();
    const command = render(<ToolUse resultOnly tool={{ id: 'command-result-only', name: 'Bash', input: { command: 'PRIVATE_COMMAND_ARGUMENT' }, streamIndex: 0, result: JSON.stringify({stdout: 'Tests 24 passed', stderr: 'stderr-evidence', interrupted: false}), resultMeta: {exitCode: 0} }} />);
    expect(command.container).toHaveTextContent('Tests 24 passed');
    expect(command.container).toHaveTextContent('stderr-evidence');
    expect(command.container).not.toHaveTextContent('PRIVATE_COMMAND_ARGUMENT');
    expect(command.container.querySelector('[data-bash-command-source]')).toBeNull();
  });
  it('renders DSH file and web tool names through the existing cards without changing their result', () => {
    const edit = render(<ToolUse tool={{
      id: 'dsh-edit', name: 'edit', streamIndex: 0,
      input: { file_path: '/workspace/native.txt', old_string: 'before', new_string: 'after' },
      result: 'Successfully edited /workspace/native.txt',
    }} />);
    expect(edit.container).toHaveTextContent('native.txt');
    expect(edit.container).toHaveTextContent('after');
    edit.unmount();

    const search = render(<ToolUse tool={{
      id: 'dsh-search', name: 'web_search', streamIndex: 0,
      input: { queries: ['latest release'] },
      parsedInput: { queries: ['latest release'] },
      result: 'Sources:\n- [Release](https://example.com/release)',
    }} />);
    expect(search.container).toHaveTextContent('Sources:');
    search.unmount();
  });

  it('passes a large Bash result intact to the terminal transcript budget', () => {
    const result = Array.from(
      { length: 5_001 },
      (_, index) => `line-${index}-${'x'.repeat(20)}`,
    ).join('\n');
    expect(result.length).toBeGreaterThan(50_000);
    const tool: ToolUseSimple = {
      id: 'large-bash',
      name: 'Bash',
      input: { command: 'generate-output' },
      streamIndex: 0,
      result,
      resultMeta: { status: 'completed', exitCode: 0 },
    };
    const { container } = render(<ToolUse tool={tool} />);

    expect(container).not.toHaveTextContent('结果过长，已截断');
    expect(screen.getByRole('button', { name: '展示全部' })).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: '展示全部' }));

    expect(container).toHaveTextContent('line-4998');
    expect(container).not.toHaveTextContent('line-5000');
    expect(screen.getByRole('status')).toHaveTextContent('终端内容过长');
  });

  it('does not corrupt a large SDK wrapper before Bash separates stderr', () => {
    const result = JSON.stringify({
      stdout: 'x'.repeat(210_000),
      stderr: 'warning from stderr',
      interrupted: false,
    });
    expect(result.length).toBeGreaterThan(200_000);
    const { container } = render(<ToolUse tool={{
      id: 'large-sdk-bash',
      name: 'Bash',
      input: { command: 'generate-output' },
      streamIndex: 0,
      result,
      resultMeta: { status: 'completed', exitCode: 0 },
    }} />);

    expect(container.querySelector('[data-bash-stream="stdout"]')).toBeInTheDocument();
    expect(container.querySelector('[data-bash-stream="stderr"]')).toHaveTextContent('warning from stderr');
    expect(container.querySelector('[data-bash-stream="combined"]')).not.toBeInTheDocument();
  });

  it('lets Edit parse a >200KB completion instead of showing the stale proposal', () => {
    const result = JSON.stringify({
      filePath: '/tmp/large-edit.ts',
      oldString: 'proposal-old',
      newString: 'applied-result',
      originalFile: 'x'.repeat(210_000),
      structuredPatch: [{
        oldStart: 1,
        oldLines: 1,
        newStart: 1,
        newLines: 1,
        lines: ['-proposal-old', '+applied-result'],
      }],
      userModified: true,
      replaceAll: false,
    });
    expect(result.length).toBeGreaterThan(200_000);

    const { container } = render(<ToolUse tool={{
      id: 'large-sdk-edit',
      name: 'Edit',
      input: {
        file_path: '/tmp/large-edit.ts',
        old_string: 'proposal-old',
        new_string: 'stale-proposal',
      },
      streamIndex: 0,
      result,
    }} />);

    expect(container).toHaveTextContent('applied-result');
    expect(container).not.toHaveTextContent('stale-proposal');
    expect(container).toHaveTextContent('结果已在审批时调整');
    expect(container).not.toHaveTextContent('结果过长，已截断');
  });

  it('does not fall back to stale Edit input when the authoritative result was spilled', () => {
    const preview = '{"filePath":"/tmp/spilled-edit.ts","originalFile":"' + 'x'.repeat(8_000);
    const { container } = render(<ToolUse tool={{
      id: 'spilled-sdk-edit',
      name: 'Edit',
      input: {
        file_path: '/tmp/spilled-edit.ts',
        old_string: 'proposal-old',
        new_string: 'stale-proposal',
      },
      streamIndex: 0,
      result: preview,
      resultMeta: {
        status: 'completed',
        largeValueRef: {
          kind: 'ref',
          id: 'abcdef1234',
          sizeBytes: 307_436,
          mimetype: 'text/plain; charset=utf-8',
          preview,
          expiresAt: Date.now() + 60_000,
        },
      },
    }} />);

    expect(container).toHaveTextContent('/tmp/spilled-edit.ts');
    expect(container).not.toHaveTextContent('stale-proposal');
    expect(container).toHaveTextContent('变更过大，仅展示有界预览');
  });
});

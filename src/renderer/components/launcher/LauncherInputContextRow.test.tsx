import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import LauncherInputContextRow from './LauncherInputContextRow';

vi.mock('./WorkspaceSelector', () => ({
  default: () => <button type="button">Workspace</button>,
}));

vi.mock('@/components/RuntimeSelector', () => ({
  default: () => <button type="button">Runtime</button>,
}));

describe('LauncherInputContextRow', () => {
  it('uses the composer surface at a lower elevation and aligns with its toolbar gutter', () => {
    const { container } = render(
      <LauncherInputContextRow
        projects={[]}
        selectedProject={null}
        onSelectWorkspace={vi.fn()}
        onAddFolder={vi.fn()}
        showRuntime={false}
      />,
    );

    const row = container.firstElementChild;
    const workspaceChip = screen.getByRole('button', { name: 'Workspace' }).parentElement;

    expect(row).toHaveClass('pl-3');
    expect(workspaceChip).toHaveClass(
      'border',
      'border-[var(--line)]',
      'bg-[var(--paper-elevated)]',
      'shadow-xs',
      'hover:bg-[var(--hover-bg)]',
      'hover:shadow-sm',
      'focus-within:bg-[var(--paper-inset)]',
    );
    expect(workspaceChip).not.toHaveClass('bg-[var(--hover-bg)]', 'shadow-md');
  });

  it('gives the two bordered launcher chips the same outer height', () => {
    render(
      <LauncherInputContextRow
        projects={[]}
        selectedProject={null}
        onSelectWorkspace={vi.fn()}
        onAddFolder={vi.fn()}
        showRuntime
        runtime="builtin"
        runtimeDetections={{
          builtin: { installed: true },
          dsh: { installed: false },
          antigravity: { installed: false },
          'claude-code': { installed: false },
          codex: { installed: false },
        }}
        onRuntimeChange={vi.fn()}
      />,
    );

    const workspaceChip = screen.getByRole('button', { name: 'Workspace' }).parentElement;
    const runtimeChip = screen.getByRole('button', { name: 'Runtime' }).parentElement;
    expect(workspaceChip).toHaveClass('h-[34px]');
    expect(runtimeChip).toHaveClass('h-[34px]');
    expect(runtimeChip?.className).toBe(workspaceChip?.className);
  });
});

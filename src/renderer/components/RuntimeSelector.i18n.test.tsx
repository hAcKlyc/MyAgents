import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { i18n } from '@/i18n';
import type { RuntimeDetections } from '@/../shared/types/runtime';
import RuntimeSelector from './RuntimeSelector';

const detections: RuntimeDetections = {
  antigravity: { installed: true },
  builtin: { installed: true },
  dsh: { installed: true, version: '0.0.0' },
  'claude-code': { installed: true, version: '1.0.0' },
  codex: { installed: true, version: '1.0.0' },
};

describe('RuntimeSelector i18n', () => {
  beforeEach(async () => {
    await i18n.changeLanguage('en-US');
  });

  it('renders launcher menu chrome in English', async () => {
    const user = userEvent.setup();
    render(
      <RuntimeSelector
        value="codex"
        detections={{ ...detections, dsh: { installed: false } }}
        onChange={vi.fn()}
        onOpenSettings={vi.fn()}
      />,
    );

    await user.click(screen.getByTitle('Runtime: Codex CLI'));

    expect(screen.getByText('Runtime')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Settings/ })).toBeInTheDocument();
    expect(screen.getByText('Not installed')).toBeInTheDocument();
  });

  it.each(['launcher', 'panel'] as const)('groups DeepSeek Harness in the %s menu without an experimental badge', async (variant) => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(
      <RuntimeSelector
        value="builtin"
        detections={{
          ...detections,
          dsh: { installed: true, version: '0.0.0', readiness: 'unverified-dev-runtime' },
        }}
        onChange={onChange}
        variant={variant}
      />,
    );

    await user.click(variant === 'launcher'
      ? screen.getByTitle('Runtime: MyAgents (Claude Agent SDK)')
      : screen.getByRole('button', { name: 'MyAgents (Claude Agent SDK)' }));
    expect(screen.getByText('Built-in Agent runtimes')).toBeInTheDocument();
    expect(screen.getByText('External CLI')).toBeInTheDocument();
    expect(screen.getAllByText('MyAgents (DeepSeek Harness)').length).toBeGreaterThan(0);
    expect(screen.queryByText('Experimental')).not.toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: /MyAgents \(DeepSeek Harness\)/ }));
    expect(onChange).toHaveBeenCalledWith('dsh');
  });

  it.each(['launcher', 'panel'] as const)('explains both runtime groups in the %s menu', async (variant) => {
    const user = userEvent.setup();
    render(
      <RuntimeSelector
        value="builtin"
        detections={detections}
        onChange={vi.fn()}
        variant={variant}
      />,
    );

    await user.click(variant === 'launcher'
      ? screen.getByTitle('Runtime: MyAgents (Claude Agent SDK)')
      : screen.getByRole('button', { name: 'MyAgents (Claude Agent SDK)' }));

    const integratedHelp = screen.getByRole('button', { name: /Built-in Agent runtimes: Built-in Agent runtimes/ });
    const externalHelp = screen.getByRole('button', { name: /External CLI: Other Agent runtimes/ });
    await user.hover(integratedHelp);
    expect(screen.getByRole('tooltip')).toHaveTextContent('You can manage all their settings in MyAgents.');
    await user.unhover(integratedHelp);
    await user.hover(externalHelp);
    expect(screen.getByRole('tooltip')).toHaveTextContent('Manage their settings and updates in the corresponding app.');
  });

  it('distinguishes Antigravity detection progress and allows re-detection after a failure', async () => {
    const user = userEvent.setup();
    const retry = vi.fn();
    const missing = { ...detections, antigravity: { installed: false } };
    const view = render(<RuntimeSelector value="builtin" detections={missing} onChange={vi.fn()} detecting onDetectAgain={retry} />);
    await user.click(screen.getByTitle('Runtime: MyAgents (Claude Agent SDK)'));
    expect(screen.getByTitle('Antigravity CLI')).toBeDisabled();
    expect(screen.getByTitle('Antigravity CLI')).toHaveTextContent('Detecting…');
    expect(screen.queryByText('Install agy')).not.toBeInTheDocument();
    view.rerender(<RuntimeSelector value="builtin" detections={missing} onChange={vi.fn()} detectionFailed onDetectAgain={retry} />);
    expect(screen.getByTitle('Antigravity CLI')).toBeDisabled();
    expect(screen.getByTitle('Antigravity CLI')).toHaveTextContent('Detection failed');
    await user.click(screen.getByRole('button', { name: 'Detect again' }));
    expect(retry).toHaveBeenCalledOnce();
  });

  it('does not expose Runtimes excluded by a custom distribution', async () => {
    const user = userEvent.setup();
    render(
      <RuntimeSelector
        value="dsh"
        detections={detections}
        onChange={vi.fn()}
        distributionPolicy={{
          schemaVersion: 1,
          allowedIntegratedRuntimes: ['dsh'],
          allowedExternalRuntimes: [],
          defaultIntegratedRuntime: 'dsh',
          selectorAvailability: 'always',
        }}
      />,
    );

    await user.click(screen.getByTitle('Runtime: MyAgents (DeepSeek Harness)'));
    expect(screen.getAllByRole('button', { name: /MyAgents \(DeepSeek Harness\)/ })).toHaveLength(2);
    expect(screen.getByText('Built-in Agent runtimes')).toBeInTheDocument();
    expect(screen.queryByText('MyAgents (Claude Agent SDK)')).not.toBeInTheDocument();
    expect(screen.queryByText('Codex CLI')).not.toBeInTheDocument();
  });

  it('records an explicit choice even when it matches the displayed default', async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(<RuntimeSelector value="builtin" detections={detections} onChange={onChange} variant="panel" />);
    await user.click(screen.getByRole('button', { name: 'MyAgents (Claude Agent SDK)' }));
    await user.click(screen.getAllByRole('button', { name: 'MyAgents (Claude Agent SDK)' })[1]!);
    expect(onChange).toHaveBeenCalledExactlyOnceWith('builtin');
  });
});

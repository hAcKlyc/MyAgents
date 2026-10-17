import { afterEach, describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';

afterEach(() => {
  vi.unstubAllGlobals();
  vi.resetModules();
});

describe('application profile wordmark', () => {
  it.each([
    ['myagents', 'MyAgents'],
    ['moxbot', 'MoXBots'],
  ] as const)('shows the %s brand name', async (profile, displayName) => {
    vi.stubGlobal('__MYAGENTS_BUILD_PROFILE__', profile);
    vi.resetModules();
    const { MyAgentsLogotype } = await import('./MyAgentsLogotype');

    const { container } = render(<MyAgentsLogotype title={displayName} />);

    if (profile === 'moxbot') {
      expect(screen.getByText('MoXBots')).toHaveAttribute('aria-label', 'MoXBots');
      expect(container.querySelector('[data-myagents-logotype]')).toBeNull();
    } else {
      expect(container.querySelector('[data-myagents-logotype]')).toHaveAttribute('aria-label', 'MyAgents');
      expect(screen.queryByText('MyAgents')).toBeNull();
    }
  });
});

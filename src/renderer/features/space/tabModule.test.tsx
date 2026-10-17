import { render, screen } from '@testing-library/react';
import { beforeEach, expect, it, vi } from 'vitest';
const profile = vi.hoisted(() => ({ value: 'moxbot' }));
vi.mock('@/../shared/appProfile', () => ({ get APP_BUILD_PROFILE() { return profile.value; }, APP_DISPLAY_NAME: 'Test' }));
vi.mock('@/features/community/CommunityContainer', () => ({ default: () => <div>Owned community</div> }));
vi.mock('@/pages/Space', () => ({ default: () => <div>Upstream space</div> }));
import { spaceTabModule } from './tabModule';
const tab = { id: 'space-1', view: 'space' as const, title: 'Space' };
const props = { tab, isActive: true, isDeferred: false, binding: { onRouteConsumed: vi.fn() } };
beforeEach(() => { profile.value = 'moxbot'; });
it('uses the owned community and title in MoXBots independently of upstream Space', async () => {
  const Render = spaceTabModule.render;
  render(<Render {...props} />);
  expect(await screen.findByText('Owned community')).toBeInTheDocument();
  expect(screen.queryByText('Upstream space')).not.toBeInTheDocument();
  const t = vi.fn((key: string) => key);
  expect(spaceTabModule.chrome(tab, { t } as never).title).toBe('globalSidebar.community');
});
it('keeps the upstream page and title for other editions', async () => {
  profile.value = 'myagents';
  const Render = spaceTabModule.render;
  render(<Render {...props} />);
  expect(await screen.findByText('Upstream space')).toBeInTheDocument();
  expect(screen.queryByText('Owned community')).not.toBeInTheDocument();
  const t = vi.fn((key: string) => key);
  expect(spaceTabModule.chrome(tab, { t } as never).title).toBe('tabs.team');
});

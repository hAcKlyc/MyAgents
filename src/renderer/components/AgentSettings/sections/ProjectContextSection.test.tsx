import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import ProjectContextSection from './ProjectContextSection';

const mocks = vi.hoisted(() => ({ patchProject: vi.fn(), refreshConfig: vi.fn(), error: vi.fn() }));
vi.mock('@/hooks/useConfig', () => ({ useConfig: () => mocks }));
vi.mock('@/components/Toast', () => ({ useToast: () => ({ error: mocks.error }) }));
const project = { id: 'p', name: 'P', path: '/p', providerId: null, permissionMode: null };
beforeEach(() => { vi.clearAllMocks(); mocks.patchProject.mockResolvedValue(undefined); mocks.refreshConfig.mockResolvedValue(undefined); });
afterEach(() => vi.restoreAllMocks());

it('defaults on and persists only this project preference, independently of proactive mode', async () => {
  const { rerender } = render(<ProjectContextSection project={project} />);
  const toggle = screen.getByRole('switch');
  expect(toggle).toHaveAttribute('aria-checked', 'true');
  fireEvent.click(toggle);
  await waitFor(() => expect(mocks.patchProject).toHaveBeenCalledWith('p', { projectContextEnabled: false }));
  expect(mocks.refreshConfig).toHaveBeenCalled();
  rerender(<ProjectContextSection project={{ ...project, projectContextEnabled: false }} />);
  expect(screen.getByRole('switch')).toHaveAttribute('aria-checked', 'false');
});

it('disables duplicate submissions until persistence settles and re-reads authority on failure', async () => {
  let reject!: (error: Error) => void;
  mocks.patchProject.mockReturnValue(new Promise((_, no) => { reject = no; }));
  render(<ProjectContextSection project={project} />);
  fireEvent.click(screen.getByRole('switch'));
  expect(screen.getByRole('switch')).toBeDisabled();
  fireEvent.click(screen.getByRole('switch'));
  expect(mocks.patchProject).toHaveBeenCalledTimes(1);
  reject(new Error('disk unavailable'));
  await waitFor(() => expect(mocks.error).toHaveBeenCalled());
  expect(mocks.refreshConfig).toHaveBeenCalled();
  expect(screen.getByRole('switch')).toHaveAttribute('aria-checked', 'true');
  expect(screen.getByRole('switch')).not.toBeDisabled();
});

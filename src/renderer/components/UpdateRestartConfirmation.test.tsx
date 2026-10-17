import { fireEvent, render, screen } from '@testing-library/react';
import { expect, it, vi } from 'vitest';
import UpdateRestartConfirmation from './UpdateRestartConfirmation';
import strings from '../i18n/locales/zh-CN/app.json';

vi.mock('react-i18next', () => ({ useTranslation: () => ({
  t: (key: string, options?: { version: string }) => {
    const value = strings.appChrome[key.replace('appChrome.', '') as keyof typeof strings.appChrome];
    return value?.replace('{{version}}', options?.version ?? '') ?? key;
  },
}) }));
vi.mock('@/hooks/useCloseLayer', () => ({ useCloseLayer: vi.fn() }));

it('offers a non-interrupting restart, preserves cancel, and requires an explicit click', () => {
  const onConfirm = vi.fn(), onCancel = vi.fn();
  const view = render(<UpdateRestartConfirmation version="0.5.6" onConfirm={onConfirm} onCancel={onCancel} />);
  expect(screen.getByText(/更新将暂停，不会中断它们/)).toBeVisible();
  fireEvent.keyDown(document, { key: 'Enter' });
  expect(onConfirm).not.toHaveBeenCalled();
  fireEvent.keyDown(document, { key: 'Escape' });
  expect(onCancel).toHaveBeenCalledOnce();
  expect(onConfirm).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole('button', { name: '重启更新' }));
  expect(onConfirm).toHaveBeenCalledExactlyOnceWith(false);
  view.unmount();
});

it('only the explicitly labelled stop action grants interruption', () => {
  const onConfirm = vi.fn();
  const view = render(<UpdateRestartConfirmation version="0.5.8" onConfirm={onConfirm} onCancel={vi.fn()} />);
  fireEvent.keyDown(document, { key: 'Enter', isComposing: true });
  fireEvent.keyDown(document, { key: 'Enter' });
  expect(onConfirm).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole('button', { name: '停止任务并重启更新' }));
  expect(onConfirm).toHaveBeenCalledExactlyOnceWith(true);
  view.unmount();
});

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

it('explains interruption, preserves work on cancel and requires an explicit button click', () => {
  const onConfirm = vi.fn(), onCancel = vi.fn();
  const view = render(<UpdateRestartConfirmation version="0.5.6" onConfirm={onConfirm} onCancel={onCancel} />);
  expect(screen.getByText(/会话记录和输入草稿将先保存/)).toBeVisible();
  fireEvent.keyDown(document, { key: 'Enter' });
  expect(onConfirm).not.toHaveBeenCalled();
  fireEvent.keyDown(document, { key: 'Escape' });
  expect(onCancel).toHaveBeenCalledOnce();
  expect(onConfirm).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole('button', { name: '停止任务并重启更新' }));
  expect(onConfirm).toHaveBeenCalledOnce();
  view.unmount();
});

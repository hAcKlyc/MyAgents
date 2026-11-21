import { fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { i18n } from '@/i18n';
import { OverlayOwnerActiveContext } from '@/context/OverlayOwnerActiveContext';
import ConfirmDialog from './ConfirmDialog';

describe('ConfirmDialog i18n', () => {
  beforeEach(async () => {
    await i18n.changeLanguage('en-US');
  });

  it('leaves Enter and Escape to the visible tab while a confirmation is hidden', () => {
    const confirm = vi.fn();
    const cancel = vi.fn();
    const dialog = (active: boolean) => (
      <OverlayOwnerActiveContext.Provider value={active}>
        <ConfirmDialog title="Delete tool" message="Delete?" onConfirm={confirm} onCancel={cancel} />
      </OverlayOwnerActiveContext.Provider>
    );
    const view = render(dialog(true));
    view.rerender(dialog(false));
    fireEvent.keyDown(document, { key: 'Enter' });
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(confirm).not.toHaveBeenCalled();
    expect(cancel).not.toHaveBeenCalled();
    view.rerender(dialog(true));
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(cancel).toHaveBeenCalledOnce();
  });

  it('uses translated default action labels', () => {
    render(
      <ConfirmDialog
        title="Delete item"
        message="This cannot be undone."
        onConfirm={vi.fn()}
        onCancel={vi.fn()}
      />,
    );

    expect(screen.getByRole('button', { name: 'Cancel' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Confirm' })).toBeInTheDocument();
  });
});

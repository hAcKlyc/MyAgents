import { useState } from 'react';
import { fireEvent, render, screen, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { i18n } from '@/i18n';
import { applyProviderEnablementAndOrder, PRESET_PROVIDERS } from '@/config/types';
import ProviderEnableOrderDialog from './ProviderEnableOrderDialog';

const providers = ['tokendance', 'deepseek', 'moonshot'].map(id => PRESET_PROVIDERS.find(p => p.id === id)!);
function Harness({ save = vi.fn() }: { save?: (order: string[], disabled: string[]) => void }) {
  const [order, setOrder] = useState(['deepseek', 'tokendance', 'moonshot']);
  const [disabled, setDisabled] = useState<string[]>([]);
  return <ProviderEnableOrderDialog providers={providers} providerOrderDraft={order}
    disabledProviderDraft={disabled} onProviderOrderDraftChange={setOrder}
    onDisabledProviderDraftChange={setDisabled} onClose={() => {}}
    onSave={() => save(order, disabled)} />;
}
const row = (id: string) => document.querySelector<HTMLElement>(`[data-provider-order-row="${id}"]`)!;
const order = () => [...document.querySelectorAll('[data-provider-order-row]')].map(el => el.getAttribute('data-provider-order-row'));

describe('fixed Token Dance position in provider ordering', () => {
  beforeEach(async () => { await i18n.changeLanguage('en-US'); });

  it('removes pinned reorder controls and moves other providers only after it', () => {
    const save = vi.fn();
    render(<Harness save={save} />);
    expect(order()).toEqual(['tokendance', 'deepseek', 'moonshot']);
    expect(within(row('tokendance')).getByText('Pinned first')).toBeInTheDocument();
    expect(within(row('tokendance')).queryByTitle('Move up')).toBeNull();
    expect(within(row('tokendance')).queryByTitle('Move down')).toBeNull();
    expect(within(row('tokendance')).queryByRole('button')).toBeNull();
    expect(within(row('deepseek')).getByTitle('Move up')).toBeDisabled();
    fireEvent.click(within(row('moonshot')).getByTitle('Move up'));
    expect(order()).toEqual(['tokendance', 'moonshot', 'deepseek']);
    expect(within(row('moonshot')).getByTitle('Move up')).toBeDisabled();
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    expect(save).toHaveBeenCalledWith(['tokendance', 'moonshot', 'deepseek'], []);
  });

  it('keeps enablement separate from the fixed position, including disabling all', () => {
    const save = vi.fn();
    render(<Harness save={save} />);
    fireEvent.click(within(row('tokendance')).getByRole('switch'));
    expect(within(row('tokendance')).getByRole('switch')).toHaveAttribute('aria-checked', 'false');
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    const [savedOrder, disabled] = save.mock.calls[0];
    const projected = applyProviderEnablementAndOrder(providers, { providerOrder: savedOrder, disabledProviderIds: disabled });
    expect(projected[0]).toMatchObject({ id: 'tokendance', enabled: false });
    expect(projected.filter(p => p.enabled !== false).map(p => p.id)).toEqual(['deepseek', 'moonshot']);
    fireEvent.click(within(row('tokendance')).getByRole('switch'));
    expect(order()[0]).toBe('tokendance');
    fireEvent.click(screen.getByRole('button', { name: 'Clear all' }));
    expect(screen.getAllByRole('switch').every(el => el.getAttribute('aria-checked') === 'false')).toBe(true);
  });
});

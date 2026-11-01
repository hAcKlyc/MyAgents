import { fireEvent, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { Provider } from '@/config/types';
import { i18n } from '@/i18n';
import ProxyScopeDialog from './ProxyScopeDialog';
import { preserveHiddenProviderSettings } from '@/config/platformProviderSettings';
import { DEFAULT_CONFIG, PROXY_DEFAULTS, type AppConfig } from '@/config/types';

const providers = [
  {
    id: 'anthropic-sub',
    name: 'Anthropic',
    vendor: 'Anthropic',
    cloudProvider: 'Official',
    type: 'subscription',
    primaryModel: 'claude-sonnet',
    isBuiltin: true,
    config: {},
    models: [],
  },
  {
    id: 'deepseek',
    name: 'DeepSeek',
    vendor: 'DeepSeek',
    cloudProvider: 'Official',
    type: 'api',
    primaryModel: 'deepseek-chat',
    isBuiltin: true,
    config: {},
    models: [],
  },
] as Provider[];

describe('ProxyScopeDialog', () => {
  beforeEach(async () => {
    await i18n.changeLanguage('en-US');
  });

  it('renders general requests before providers and saves both dimensions', async () => {
    const user = userEvent.setup();
    const onSave = vi.fn();
    render(
      <ProxyScopeDialog
        providers={providers}
        initialScope={{ mode: 'custom', generalRequests: true, providerIds: ['anthropic-sub'] }}
        onClose={vi.fn()}
        onSave={onSave}
      />,
    );

    const choices = screen.getAllByRole('checkbox');
    expect(choices).toHaveLength(3);
    expect(choices[0]).toHaveAccessibleName(/General network requests/);
    expect(choices[0]).toHaveAttribute('aria-checked', 'true');
    expect(choices[1]).toHaveAccessibleName(/Anthropic/);
    expect(choices[2]).toHaveAccessibleName(/DeepSeek/);
    expect(screen.getByText('2 selected')).toBeInTheDocument();

    await user.click(choices[0]);
    await user.click(choices[2]);
    await user.click(screen.getByRole('button', { name: 'Save' }));

    expect(onSave).toHaveBeenCalledWith({
      mode: 'custom', generalRequests: false,
      providerIds: ['anthropic-sub', 'deepseek'],
    }, ['anthropic-sub', 'deepseek']);
  });

  it('select all includes general requests and zero selection remains saveable', async () => {
    const user = userEvent.setup();
    const onSave = vi.fn();
    render(
      <ProxyScopeDialog
        providers={providers}
        initialScope={{ mode: 'custom', generalRequests: false, providerIds: [] }}
        onClose={vi.fn()}
        onSave={onSave}
      />,
    );

    const save = screen.getByRole('button', { name: 'Save' });
    expect(save).toBeEnabled();
    await user.click(screen.getByRole('button', { name: 'Select all' }));
    expect(screen.getAllByRole('checkbox').every(choice => choice.getAttribute('aria-checked') === 'true'))
      .toBe(true);
    await user.click(screen.getByRole('button', { name: 'Deselect all' }));
    expect(screen.getByText('0 selected')).toBeInTheDocument();
    await user.click(save);

    expect(onSave).toHaveBeenCalledWith({ mode: 'custom', generalRequests: false, providerIds: [] }, ['anthropic-sub', 'deepseek']);
  });

  it('retains selections outside the displayed catalog when saving and toggling all visible items', () => {
    const onSave = vi.fn();
    render(<ProxyScopeDialog providers={providers}
      initialScope={{ mode: 'custom', generalRequests: false, providerIds: ['antigravity-sub', 'anthropic-sub'] }}
      onClose={vi.fn()} onSave={onSave} />);

    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    expect(onSave).toHaveBeenLastCalledWith({ mode: 'custom', generalRequests: false,
      providerIds: ['antigravity-sub', 'anthropic-sub'] }, ['anthropic-sub', 'deepseek']);
    fireEvent.click(screen.getByRole('button', { name: 'Select all' }));
    expect(screen.getAllByRole('checkbox').every(choice => choice.getAttribute('aria-checked') === 'true')).toBe(true);
    fireEvent.click(screen.getByRole('button', { name: 'Deselect all' }));
    expect(screen.getByText('0 selected')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    expect(onSave).toHaveBeenLastCalledWith({ mode: 'custom', generalRequests: false, providerIds: ['antigravity-sub'] }, ['anthropic-sub', 'deepseek']);
  });

  it('keeps its displayed catalog stable while background configuration shrinks and expands', () => {
    const onSave = vi.fn();
    const view = render(<ProxyScopeDialog providers={providers}
      initialScope={{ mode: 'custom', generalRequests: true, providerIds: ['anthropic-sub', 'deepseek'] }} onClose={vi.fn()} onSave={onSave} />);
    view.rerender(<ProxyScopeDialog providers={providers.slice(0, 1)}
      initialScope={{ mode: 'custom', generalRequests: true, providerIds: ['anthropic-sub', 'deepseek'] }} onClose={vi.fn()} onSave={onSave} />);
    expect(screen.getByRole('checkbox', { name: /DeepSeek/ })).toHaveAttribute('aria-checked', 'true');
    fireEvent.click(screen.getByRole('checkbox', { name: /Anthropic/ }));
    view.rerender(<ProxyScopeDialog providers={providers}
      initialScope={{ mode: 'custom', generalRequests: true, providerIds: ['anthropic-sub', 'deepseek'] }} onClose={vi.fn()} onSave={onSave} />);
    expect(screen.getByRole('checkbox', { name: /DeepSeek/ })).toHaveAttribute('aria-checked', 'true');
    expect(screen.getByRole('checkbox', { name: /Anthropic/ })).toHaveAttribute('aria-checked', 'false');
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    expect(onSave).toHaveBeenCalledWith({ mode: 'custom', generalRequests: true, providerIds: ['deepseek'] }, ['anthropic-sub', 'deepseek']);
  });
  it('keeps All implicit and picks up new catalog entries on the next open', () => {
    const onSave = vi.fn();
    const view = render(<ProxyScopeDialog providers={providers.slice(0, 1)} initialScope={{ mode: 'all' }}
      onClose={vi.fn()} onSave={onSave} />);
    view.rerender(<ProxyScopeDialog providers={providers} initialScope={{ mode: 'all' }}
      onClose={vi.fn()} onSave={onSave} />);
    expect(screen.getAllByRole('checkbox').every(choice => choice.getAttribute('aria-checked') === 'true')).toBe(true);
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    expect(onSave).toHaveBeenLastCalledWith({ mode: 'all' }, ['anthropic-sub']);
    view.unmount();
    render(<ProxyScopeDialog providers={providers} initialScope={{ mode: 'all' }}
      onClose={vi.fn()} onSave={onSave} />);
    expect(screen.getByRole('checkbox', { name: /DeepSeek/ })).toHaveAttribute('aria-checked', 'true');
    fireEvent.click(screen.getByRole('checkbox', { name: /DeepSeek/ }));
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    expect(onSave).toHaveBeenLastCalledWith({ mode: 'custom', generalRequests: true,
      providerIds: ['anthropic-sub'] }, ['anthropic-sub', 'deepseek']);
  });

  it('commits an explicit deselection even if background config hides that provider before save', () => {
    let disk: AppConfig = { ...DEFAULT_CONFIG, proxySettings: { ...PROXY_DEFAULTS, enabled: true,
      scope: { mode: 'custom', generalRequests: false, providerIds: ['deepseek'] } } };
    const onSave = vi.fn((scope, editable: string[]) => {
      disk = { ...disk, ...preserveHiddenProviderSettings(disk, {
        proxySettings: { ...disk.proxySettings!, scope },
      }, [], editable) };
    });
    const view = render(<ProxyScopeDialog providers={providers} initialScope={disk.proxySettings!.scope!}
      onClose={vi.fn()} onSave={onSave} />);
    fireEvent.click(screen.getByRole('checkbox', { name: /DeepSeek/ }));
    view.rerender(<ProxyScopeDialog providers={providers.slice(0, 1)} initialScope={disk.proxySettings!.scope!}
      onClose={vi.fn()} onSave={onSave} />);
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    expect(disk.proxySettings?.scope).toEqual({ mode: 'custom', generalRequests: false, providerIds: [] });
  });

  it.each([false, true])('retains an All member when its background catalog shrinks (custom provider: %s)', custom => {
    const catalog = custom ? [providers[0], { ...providers[1], id: 'custom-b', isBuiltin: false }] : providers;
    let disk: AppConfig = { ...DEFAULT_CONFIG, proxySettings: { ...PROXY_DEFAULTS, enabled: true, scope: { mode: 'all' } } };
    const onSave = vi.fn((scope, editable: string[]) => {
      disk = { ...disk, ...preserveHiddenProviderSettings(disk, {
        proxySettings: { ...disk.proxySettings!, scope },
      }, [], editable) };
    });
    const view = render(<ProxyScopeDialog providers={catalog} initialScope={{ mode: 'all' }}
      onClose={vi.fn()} onSave={onSave} />);
    view.rerender(<ProxyScopeDialog providers={catalog.slice(0, 1)} initialScope={{ mode: 'all' }}
      onClose={vi.fn()} onSave={onSave} />);
    fireEvent.click(screen.getByRole('checkbox', { name: /General network requests/ }));
    expect(screen.getByRole('checkbox', { name: /DeepSeek/ })).toHaveAttribute('aria-checked', 'true');
    // Save before recovery: the original custom identity must already survive.
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    expect(disk.proxySettings?.scope?.providerIds).toContain(catalog[1].id);
    expect(disk.proxySettings?.scope?.generalRequests).toBe(false);
    view.rerender(<ProxyScopeDialog providers={catalog} initialScope={disk.proxySettings!.scope!}
      onClose={vi.fn()} onSave={onSave} />);
    expect(screen.getByRole('checkbox', { name: /DeepSeek/ })).toHaveAttribute('aria-checked', 'true');
  });

});

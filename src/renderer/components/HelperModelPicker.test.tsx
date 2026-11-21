import { useState } from 'react';
import { fireEvent, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import BugReportOverlay from './BugReportOverlay';
import SettingsHelperInbox from './SettingsHelperInbox';
import { ImagePreviewProvider } from '@/context/ImagePreviewContext';
import { dispatchHelperRequest } from '@/utils/dispatchHelperRequest';
import type { Provider } from '@/config/types';
import { describe, expect, it, vi } from 'vitest';
import { MANAGED_CODEX_PROVIDER } from '@/config/types';
import { resolveInitialHelperModel } from './HelperModelPicker';

describe('helper managed model selection', () => {
    const provider = { ...MANAGED_CODEX_PROVIDER, runtimeReady: true };

    it('preserves the saved managed model when discovery is unavailable', () => {
        const saved = { providerId: provider.id, model: 'saved-native-model' };
        expect(resolveInitialHelperModel([provider], {}, {}, saved)).toEqual(saved);
    });

    it('does not create a new selection without a concrete model', () => {
        expect(resolveInitialHelperModel([provider], {}, {})).toEqual({ providerId: '', model: '' });
    });
});

vi.mock('@/config/useConfigData', () => ({ useConfigData: () => ({ projects: [], config: {} }) }));
vi.mock('@/config/useConfigActions', () => ({ useConfigActions: () => ({}) }));
vi.mock('@/utils/dispatchHelperRequest', () => ({ dispatchHelperRequest: vi.fn() }));

it.each(['feedback', 'settings'])('retains the draft and sends the chosen provider from %s', async surface => {
    const user = userEvent.setup();
    const changed = vi.fn();
    const close = vi.fn();
    const providers: Provider[] = ['First', 'Second'].map(id => ({
        id, name: id, vendor: id, cloudProvider: id, type: 'api', config: {}, isBuiltin: false,
        primaryModel: 'shared', models: [{ model: 'shared', modelName: 'Shared', modelSeries: 'test' }],
    }));
    function Helper() {
        const [provider, setProvider] = useState('First');
        const props = { providers, providerVerifyStatus: {}, appVersion: 'test',
            apiKeys: { First: 'test', Second: 'test' }, initialProviderId: provider, initialModel: 'shared',
            onModelChange: (id: string, model: string) => { changed(id, model); setProvider(id); } };
        return surface === 'feedback'
            ? <BugReportOverlay {...props} onClose={close} onNavigateToProviders={vi.fn()} />
            : <SettingsHelperInbox {...props} />;
    }
    render(<ImagePreviewProvider><Helper /></ImagePreviewProvider>);
    const input = screen.getByRole('textbox');
    await user.type(input, 'draft');
    const trigger = screen.getByRole('button', { name: 'Shared' });
    await user.click(trigger);
    await user.click(screen.getByRole('button', { name: 'Second' }));
    if (surface === 'feedback') {
        fireEvent.mouseDown(input.closest('[data-overlay-backdrop]')!);
        expect(screen.queryByRole('button', { expanded: true })).toBeNull();
        await user.click(trigger);
    }
    await user.keyboard('{Escape}');
    expect(changed).not.toHaveBeenCalled();
    expect(close).not.toHaveBeenCalled();
    expect(input).toHaveValue('draft');
    await user.click(trigger);
    expect(screen.getByRole('button', { expanded: true })).toHaveTextContent('First');
    await user.click(screen.getByRole('button', { name: 'Second' }));
    await user.click(screen.getByTitle('Shared'));
    expect(changed).toHaveBeenCalledExactlyOnceWith('Second', 'shared');
    await user.click(input);
    await user.keyboard('{Enter}');
    expect(dispatchHelperRequest).toHaveBeenLastCalledWith(expect.objectContaining({
        description: 'draft', providerId: 'Second', model: 'shared',
    }));
});

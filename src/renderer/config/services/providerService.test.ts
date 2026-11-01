import { describe, expect, it } from 'vitest';

import {
    CODEX_SUBSCRIPTION_PROVIDER_ID,
    DEFAULT_CONFIG,
    MANAGED_CODEX_PROVIDER,
    SUBSCRIPTION_PROVIDER_ID,
    applyProviderEnablementAndOrder,
    type Provider,
} from '../types';
import {
    getFirstAvailableProvider,
    isImageUnderstandingSelectionAvailable,
    isProviderAvailable,
    resolveBuiltinSelection,
    resolveProvider,
    shouldInvalidateProviderAfterVerification,
} from './providerService';

const makeProvider = (id: string, primaryModel = `${id}-model`): Provider => ({
    id,
    name: id,
    vendor: 'Test',
    cloudProvider: 'Test',
    type: 'api',
    primaryModel,
    isBuiltin: false,
    authType: 'api_key',
    config: { baseUrl: `https://${id}.example/v1` },
    models: [{ model: primaryModel, modelName: `${id} Model`, modelSeries: 'test' }],
});

describe('provider availability with enablement', () => {
    it('treats disabled providers as unavailable even when they have credentials', () => {
        const providers = applyProviderEnablementAndOrder(
            [makeProvider('alpha'), makeProvider('beta')],
            { disabledProviderIds: ['alpha'] },
        );
        const alpha = providers.find(provider => provider.id === 'alpha');

        expect(alpha).toBeDefined();
        expect(isProviderAvailable(alpha!, { alpha: 'configured-key' }, {})).toBe(false);
    });

    it('first available provider follows user ordering and skips disabled providers', () => {
        const providers = applyProviderEnablementAndOrder(
            [makeProvider('alpha'), makeProvider('beta'), makeProvider('gamma')],
            {
                providerOrder: ['gamma', 'alpha', 'beta'],
                disabledProviderIds: ['alpha'],
            },
        );

        expect(getFirstAvailableProvider(providers, {
            alpha: 'alpha-key',
            beta: 'beta-key',
            gamma: 'gamma-key',
        }, {})?.id).toBe('gamma');
    });

    it('builtin selection falls through from a disabled default provider', () => {
        const providers = applyProviderEnablementAndOrder(
            [makeProvider('alpha'), makeProvider('beta', 'beta-primary')],
            {
                providerOrder: ['alpha', 'beta'],
                disabledProviderIds: ['alpha'],
            },
        );
        const selection = resolveBuiltinSelection(
            {},
            { ...DEFAULT_CONFIG, defaultProviderId: 'alpha' },
            providers,
            {
                alpha: 'alpha-key',
                beta: 'beta-key',
            },
            {},
        );

        expect(selection?.provider.id).toBe('beta');
        expect(selection?.model).toBe('beta-primary');
    });

    it('uses runtime readiness independently of model catalogue discovery', () => {
        expect(isProviderAvailable(
            MANAGED_CODEX_PROVIDER,
            {},
            { [CODEX_SUBSCRIPTION_PROVIDER_ID]: { status: 'valid', verifiedAt: '2026-06-26T00:00:00.000Z' } },
        )).toBe(false);

        expect(isProviderAvailable(
            { ...MANAGED_CODEX_PROVIDER, runtimeReady: true },
            {},
            {},
        )).toBe(true);

        expect(isProviderAvailable(
            {
                ...MANAGED_CODEX_PROVIDER,
                runtimeReady: true,
                primaryModel: 'gpt-5',
                models: [{ model: 'gpt-5', modelName: 'GPT-5', modelSeries: 'codex' }],
            },
            {},
            {},
        )).toBe(true);

        expect(isProviderAvailable(
            {
                ...MANAGED_CODEX_PROVIDER,
                enabled: false,
                runtimeReady: true,
                primaryModel: 'gpt-5',
                models: [{ model: 'gpt-5', modelName: 'GPT-5', modelSeries: 'codex' }],
            },
            {},
            {},
        )).toBe(false);
    });

    it('preserves a managed workspace model without a catalogue and never invents an empty model', () => {
        const provider = { ...MANAGED_CODEX_PROVIDER, runtimeReady: true };
        const config = { ...DEFAULT_CONFIG, defaultProviderId: provider.id };
        const workspace = { id: 'workspace', name: 'Workspace', path: '/workspace', permissionMode: 'auto' as const,
            providerId: provider.id, model: 'saved-native-model' };
        expect(resolveBuiltinSelection({ workspace }, config, [provider], {}, {}))
            .toEqual({ provider, model: 'saved-native-model' });
        expect(resolveBuiltinSelection({}, config, [provider], {}, {})).toBeUndefined();
        expect(resolveBuiltinSelection({ workspace: { ...workspace, providerId: 'another-provider' } },
            config, [provider], {}, {})).toBeUndefined();
    });

    it('treats auth-required subscription verify status as unavailable', () => {
        const provider: Provider = {
            id: SUBSCRIPTION_PROVIDER_ID,
            name: 'Anthropic (订阅)',
            vendor: 'Anthropic',
            cloudProvider: '官方',
            type: 'subscription',
            primaryModel: 'claude-sonnet-4-6',
            isBuiltin: true,
            config: {},
            models: [{ model: 'claude-sonnet-4-6', modelName: 'Claude Sonnet 4.6', modelSeries: 'claude' }],
        };

        expect(isProviderAvailable(provider, {}, {
            [SUBSCRIPTION_PROVIDER_ID]: {
                status: 'invalid',
                verifiedAt: '2026-07-02T00:00:00.000Z',
                invalidReason: 'auth_required',
            },
        })).toBe(false);
    });

    it('does not fallback from an unavailable runtime-backed provider to an API provider', () => {
        const providers = [
            { ...MANAGED_CODEX_PROVIDER, enabled: false },
            makeProvider('deepseek'),
        ];

        expect(resolveProvider(
            CODEX_SUBSCRIPTION_PROVIDER_ID,
            providers,
            { deepseek: 'deepseek-key' },
            {},
        )).toBeUndefined();
    });
});

describe('provider verification persistence policy', () => {
    it('does not invalidate an existing credential fact for a retryable attempt', () => {
        expect(shouldInvalidateProviderAfterVerification({ success: false, retryable: true })).toBe(false);
    });

    it('still persists determinate verification failures', () => {
        expect(shouldInvalidateProviderAfterVerification({ success: false })).toBe(true);
        expect(shouldInvalidateProviderAfterVerification({ success: false, retryable: false })).toBe(true);
    });

    it('never invalidates a successful verification', () => {
        expect(shouldInvalidateProviderAfterVerification({ success: true })).toBe(false);
    });
});

describe('image-understanding selection availability', () => {
    it('keeps a configured model selectable when input modalities are unknown', () => {
        const provider = makeProvider('custom-vision');

        expect(isImageUnderstandingSelectionAvailable(
            [provider],
            { 'custom-vision': 'configured-key' },
            {},
            { imageUnderstanding: { providerId: 'custom-vision', model: 'custom-vision-model' } },
        )).toBe(true);
    });

    it('rejects only an explicit text-only model declaration', () => {
        const provider: Provider = {
            ...makeProvider('custom-text'),
            models: [{
                model: 'custom-text-model',
                modelName: 'Custom Text Model',
                modelSeries: 'test',
                inputModalities: ['text'],
            }],
        };

        expect(isImageUnderstandingSelectionAvailable(
            [provider],
            { 'custom-text': 'configured-key' },
            {},
            { imageUnderstanding: { providerId: 'custom-text', model: 'custom-text-model' } },
        )).toBe(false);
    });

    it('rejects missing model rows and unavailable providers', () => {
        const provider = makeProvider('custom-vision');
        expect(isImageUnderstandingSelectionAvailable(
            [provider],
            { 'custom-vision': 'configured-key' },
            {},
            { imageUnderstanding: { providerId: 'custom-vision', model: 'missing-model' } },
        )).toBe(false);
        expect(isImageUnderstandingSelectionAvailable(
            [provider],
            {},
            {},
            { imageUnderstanding: { providerId: 'custom-vision', model: 'custom-vision-model' } },
        )).toBe(false);
    });
});

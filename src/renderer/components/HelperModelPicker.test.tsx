import { describe, expect, it } from 'vitest';
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

import { beforeEach, describe, expect, it, vi } from 'vitest';

import { invoke } from '@tauri-apps/api/core';

import {
    inferPetSpecies,
    setTravelMateEnabled,
    updateTravelMateAttention,
} from './travelMate';
import type { PetPack } from './petAtlas';

vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn() }));

function pack(overrides: Partial<PetPack> = {}): PetPack {
    return {
        id: 'mino',
        displayName: 'Mino',
        description: 'A curious cat companion',
        spritesheetUrl: 'asset://mino.png',
        atlas: {} as PetPack['atlas'],
        ...overrides,
    };
}

describe('travelMate adapter', () => {
    beforeEach(() => {
        vi.mocked(invoke).mockReset();
    });

    it('infers a bounded pet species without exposing pack assets', () => {
        expect(inferPetSpecies(pack())).toBe('cat');
        expect(inferPetSpecies(pack({ id: 'buddy', displayName: 'Buddy', description: '忠诚的小狗' }))).toBe('dog');
        expect(inferPetSpecies(pack({ id: 'robot', displayName: 'Bot', description: 'Pixel robot' }))).toBe('other');
    });

    it('sends only allowlisted pet identity when enabling', async () => {
        vi.mocked(invoke).mockResolvedValue({ version: 1, enabled: true, phase: { kind: 'homeScheduled', departureAtMs: 1 } });

        await setTravelMateEnabled(true, pack());

        expect(invoke).toHaveBeenCalledWith('cmd_travel_mate_set_enabled', {
            enabled: true,
            pet: { id: 'mino', displayName: 'Mino', species: 'cat' },
        });
    });

    it('maps pending, blocked and error state into the departure guard', async () => {
        vi.mocked(invoke).mockResolvedValue({ version: 1, enabled: true, phase: { kind: 'homeScheduled', departureAtMs: 1 } });

        await updateTravelMateAttention({
            state: 'blocked',
            pendingKind: 'permission',
            hasError: true,
            pet: pack(),
        });

        expect(invoke).toHaveBeenCalledWith('cmd_travel_mate_update_attention', {
            attention: {
                hasPendingInteraction: true,
                isBlocked: true,
                hasError: true,
            },
            pet: { id: 'mino', displayName: 'Mino', species: 'cat' },
        });
    });
});

import { invoke } from '@tauri-apps/api/core';

import type { PetPack } from './petAtlas';
import type { FbBallState, FbPendingKind } from './petStateMapper';

export type TravelMatePetSpecies = 'cat' | 'dog' | 'other';

export interface TravelMatePetIdentity {
    id: string;
    displayName: string;
    species: TravelMatePetSpecies;
}

export interface TravelMatePostcard {
    tripId: string;
    destination: string;
    headline: string;
    story: string;
    signature: string;
    motif: {
        kind: 'line-art';
        symbol: string;
        palette: [string, string, string];
    };
}

export type TravelMatePhase =
    | { kind: 'disabled' }
    | { kind: 'homeScheduled'; departureAtMs: number }
    | {
        kind: 'away';
        tripId: string;
        departedAtMs: number;
        returnAtMs: number;
        postcardSeed: number;
        pet: TravelMatePetIdentity;
    }
    | {
        kind: 'returnedPendingPostcard';
        tripId: string;
        postcard: TravelMatePostcard;
        returnedAtMs: number;
    };

export interface TravelMateSnapshot {
    version: 1;
    enabled: boolean;
    phase: TravelMatePhase;
}

function normalizedPetText(pack: PetPack): string {
    return `${pack.id} ${pack.displayName} ${pack.description ?? ''}`.toLocaleLowerCase();
}

export function inferPetSpecies(pack: PetPack): TravelMatePetSpecies {
    const text = normalizedPetText(pack);
    if (/(^|[\s_-])(cat|kitten|kitty)([\s_-]|$)|猫|咪/.test(text)) return 'cat';
    if (/(^|[\s_-])(dog|puppy|pup)([\s_-]|$)|狗|犬/.test(text)) return 'dog';
    return 'other';
}

export function toTravelMatePetIdentity(pack: PetPack): TravelMatePetIdentity {
    return {
        id: pack.id.trim().slice(0, 64) || 'pet',
        displayName: pack.displayName.trim().slice(0, 64) || 'Desktop Pet',
        species: inferPetSpecies(pack),
    };
}

export function getTravelMateSnapshot(): Promise<TravelMateSnapshot> {
    return invoke<TravelMateSnapshot>('cmd_travel_mate_snapshot');
}

export function setTravelMateEnabled(
    enabled: boolean,
    pack: PetPack,
): Promise<TravelMateSnapshot> {
    return invoke<TravelMateSnapshot>('cmd_travel_mate_set_enabled', {
        enabled,
        pet: toTravelMatePetIdentity(pack),
    });
}

export function updateTravelMateAttention(input: {
    state: FbBallState;
    pendingKind: FbPendingKind | null;
    hasError: boolean;
    pet: PetPack;
}): Promise<TravelMateSnapshot> {
    return invoke<TravelMateSnapshot>('cmd_travel_mate_update_attention', {
        attention: {
            hasPendingInteraction: input.pendingKind !== null,
            isBlocked: input.state === 'blocked',
            hasError: input.hasError,
        },
        pet: toTravelMatePetIdentity(input.pet),
    });
}

export function dismissTravelMatePostcard(): Promise<TravelMateSnapshot> {
    return invoke<TravelMateSnapshot>('cmd_travel_mate_dismiss_postcard');
}

export function demoTravelMateDeparture(): Promise<TravelMateSnapshot> {
    return invoke<TravelMateSnapshot>('cmd_travel_mate_demo_depart');
}

export function demoTravelMateReturn(): Promise<TravelMateSnapshot> {
    return invoke<TravelMateSnapshot>('cmd_travel_mate_demo_return');
}

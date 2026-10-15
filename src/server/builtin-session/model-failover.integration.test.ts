import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ProviderEnv } from '../provider-types';

const fixture = vi.hoisted(() => ({ config: {} as Record<string, unknown>,
  providers: {} as Record<string, unknown>, envs: {} as Record<string, unknown> }));
vi.mock('../utils/admin-config', () => ({
  loadConfig: () => fixture.config,
  findEffectiveProvider: (id: string) => fixture.providers[id],
  materializeProviderRouteEnv: (route: { providerId: string }) => fixture.envs[route.providerId],
}));
import { createSessionModelFailover, sessionApiFailoverEligible } from './model-failover';

describe('Session API failover authority', () => {
  const primary: ProviderEnv = { providerId: 'primary', apiKey: 'fixture-main', baseUrl: 'http://primary.test' };
  beforeEach(() => {
    fixture.config = { modelFailover: { enabled: true, backup: { providerId: 'backup', modelId: 'b' } } };
    fixture.providers = {
      primary: { id: 'primary', type: 'api', models: [{ model: 'a' }] },
      backup: { id: 'backup', type: 'api', models: [{ model: 'b' }] },
    };
    fixture.envs = { backup: { providerId: 'backup', baseUrl: 'http://backup.test', apiKey: 'fixture-backup' } };
  });
  const request = () => new Request('http://127.0.0.1/bridge/test/v1/messages', { method: 'POST' });
  it('uses current backup credentials, keeps the root scope across steering, and restores primary next turn', async () => {
    let source = 'root';
    const switched = vi.fn();
    const controller = createSessionModelFailover({ current: () => ({ env: primary, model: 'a', turnId: source }),
      isLive: () => true, onSwitch: switched });
    const keys: string[] = [];
    const execute = vi.fn(async (target) => { keys.push(target.apiKey); return new Response('{}', { status: target.providerId === 'primary' ? 503 : 200 }); });
    const upstream = { providerId: 'primary', baseUrl: primary.baseUrl!, apiKey: primary.apiKey!, model: 'a' };
    expect((await controller.run(request(), upstream, execute)).status).toBe(200);
    expect(keys).toEqual(['fixture-main', 'fixture-main', 'fixture-backup']);
    source = 'steering-input';
    fixture.envs.backup = { ...fixture.envs.backup as object, apiKey: 'rotated-fixture' };
    await controller.run(request(), upstream, execute);
    expect(keys.at(-1)).toBe('rotated-fixture');
    expect(switched).toHaveBeenCalledTimes(1);
    controller.endTurn();
    source = 'next-root';
    await controller.run(request(), upstream, execute);
    expect(keys.slice(-3)).toEqual(['fixture-main', 'fixture-main', 'rotated-fixture']);
    expect(switched).toHaveBeenCalledTimes(2);
    expect(fixture.config).toEqual({ modelFailover: { enabled: true, backup: { providerId: 'backup', modelId: 'b' } } });
  });
  it.each(['disabled', 'subscription', 'deleted-model', 'missing-key', 'same-pair', 'history-family', 'inactive'])('does not borrow credentials or switch for %s', async reason => {
    const settings = fixture.config.modelFailover as { enabled: boolean; backup: { providerId: string; modelId: string } };
    if (reason === 'disabled') settings.enabled = false;
    if (reason === 'subscription') fixture.providers.backup = { id: 'backup', type: 'subscription' };
    if (reason === 'deleted-model') fixture.providers.backup = { id: 'backup', type: 'api', models: [] };
    if (reason === 'missing-key') fixture.envs.backup = { providerId: 'backup', baseUrl: 'http://backup.test' };
    if (reason === 'same-pair') settings.backup = { providerId: 'primary', modelId: 'a' };
    if (reason === 'history-family') fixture.envs.backup = { providerId: 'backup', baseUrl: 'https://api.anthropic.com', apiKey: 'other' };
    const switched = vi.fn();
    const controller = createSessionModelFailover({ current: () => ({ env: primary, model: 'a', turnId: 'root' }),
      isLive: () => reason !== 'inactive', onSwitch: switched });
    const execute = vi.fn(async () => new Response('{}', { status: 503 }));
    expect((await controller.run(request(), { providerId: 'primary', baseUrl: primary.baseUrl! }, execute)).status).toBe(503);
    expect(execute).toHaveBeenCalledTimes(1);
    expect(switched).not.toHaveBeenCalled();
  });
  it('rejects managed or scoped credentials even when a matching API catalog entry exists', () => {
    expect(sessionApiFailoverEligible({ ...primary, credentialSource: { kind: 'managed-oauth', providerId: 'xai-sub' } })).toBe(false);
    expect(sessionApiFailoverEligible({ ...primary, providerId: 'cloud-session:private' })).toBe(false);
  });
  it.each(['disable', 'delete', 'key-revoked', 'replace-backup'])('does not fall back to primary after a pinned backup loses eligibility: %s', async reason => {
    const switched = vi.fn();
    const controller = createSessionModelFailover({ current: () => ({ env: primary, model: 'a', turnId: 'root' }),
      isLive: () => true, onSwitch: switched });
    const execute = vi.fn(async target => new Response('{}', { status: target.providerId === 'primary' ? 503 : 200 }));
    const upstream = { providerId: 'primary', baseUrl: primary.baseUrl! };
    await controller.run(request(), upstream, execute, 'first');
    expect(execute).toHaveBeenCalledTimes(3);
    if (reason === 'disable') fixture.config.modelFailover = { enabled: false };
    if (reason === 'delete') delete fixture.providers.backup;
    if (reason === 'key-revoked') delete fixture.envs.backup;
    if (reason === 'replace-backup') fixture.config.modelFailover = { enabled: true, backup: { providerId: 'primary', modelId: 'a' } };
    expect((await controller.run(request(), upstream, execute, 'next-inference')).status).toBe(499);
    expect(execute).toHaveBeenCalledTimes(3);
    expect(switched).toHaveBeenCalledTimes(1);
  });
  it('keeps the replay guard after settings are disabled mid-root', async () => {
    const controller = createSessionModelFailover({ current: () => ({ env: primary, model: 'a', turnId: 'root' }),
      isLive: () => true, onSwitch: vi.fn() });
    const execute = vi.fn(async () => new Response('{}'));
    const upstream = { providerId: 'primary', baseUrl: primary.baseUrl! };
    await controller.run(request(), upstream, execute, 'already-delivered');
    fixture.config.modelFailover = { enabled: false };
    expect((await controller.run(request(), upstream, execute, 'already-delivered')).status).toBe(409);
    expect(execute).toHaveBeenCalledTimes(1);
  });
  it('does not start a new failover when background ownership becomes ambiguous', async () => {
    let canSwitch = true;
    const controller = createSessionModelFailover({ current: () => ({ env: primary, model: 'a', turnId: 'root' }),
      isLive: () => true, canSwitch: () => canSwitch, onSwitch: vi.fn() });
    const execute = vi.fn(async () => { canSwitch = false; return new Response('{}', { status: 503 }); });
    const upstream = { providerId: 'primary', baseUrl: primary.baseUrl! };
    expect((await controller.run(request(), upstream, execute, 'first')).status).toBe(503);
    expect((await controller.run(request(), upstream, execute, 'first')).status).toBe(409);
    expect(execute).toHaveBeenCalledTimes(1);
  });
});

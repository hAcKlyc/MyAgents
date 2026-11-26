import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  __resetRuntimeModelSingleFlightForTest,
  queryRuntimeModelsSingleFlight,
} from './runtime-model-singleflight';

describe('runtime model query single-flight', () => {
  beforeEach(() => {
    __resetRuntimeModelSingleFlightForTest();
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.useRealTimers();
  });

  it('reuses only successful Global Sidecar catalogs and expires them independently of Session discovery', async () => {
    vi.useFakeTimers();
    vi.stubEnv('MYAGENTS_SIDECAR_ROLE', 'global');
    const models = [{ value: 'gemini-fixture' }];
    const queryer = vi.fn<() => Promise<unknown[]>>()
      .mockResolvedValue(models)
      .mockResolvedValueOnce([]);
    await expect(queryRuntimeModelsSingleFlight('antigravity', queryer)).resolves.toEqual([]);
    await expect(queryRuntimeModelsSingleFlight('antigravity', queryer)).resolves.toEqual(models);
    await expect(queryRuntimeModelsSingleFlight('antigravity', queryer)).resolves.toEqual(models);
    expect(queryer).toHaveBeenCalledTimes(2);

    vi.stubEnv('MYAGENTS_SIDECAR_ROLE', 'session');
    await queryRuntimeModelsSingleFlight('antigravity', queryer);
    expect(queryer).toHaveBeenCalledTimes(3);

    vi.stubEnv('MYAGENTS_SIDECAR_ROLE', 'global');
    await vi.advanceTimersByTimeAsync(60_000);
    await queryRuntimeModelsSingleFlight('antigravity', queryer);
    expect(queryer).toHaveBeenCalledTimes(4);
  });

  it('deduplicates concurrent queries for the same runtime', async () => {
    let release!: (value: unknown[]) => void;
    const queryer = vi.fn(() => new Promise<unknown[]>((resolve) => { release = resolve; }));

    const a = queryRuntimeModelsSingleFlight('codex', queryer);
    const b = queryRuntimeModelsSingleFlight('codex', queryer);

    release([{ value: 'gpt', displayName: 'GPT' }]);

    await expect(Promise.all([a, b])).resolves.toEqual([
      [{ value: 'gpt', displayName: 'GPT' }],
      [{ value: 'gpt', displayName: 'GPT' }],
    ]);
    expect(queryer).toHaveBeenCalledTimes(1);
  });

  it('keeps system-cli and managed-provider model queries independent', async () => {
    let releaseSystem!: (value: unknown[]) => void;
    let releaseManaged!: (value: unknown[]) => void;
    const systemQueryer = vi.fn(() => new Promise<unknown[]>((resolve) => { releaseSystem = resolve; }));
    const managedQueryer = vi.fn(() => new Promise<unknown[]>((resolve) => { releaseManaged = resolve; }));

    const system = queryRuntimeModelsSingleFlight('codex', systemQueryer, 'system-cli');
    const managed = queryRuntimeModelsSingleFlight('codex', managedQueryer, 'managed-provider');

    releaseSystem([{ value: 'system-gpt' }]);
    releaseManaged([{ value: 'managed-gpt' }]);

    await expect(Promise.all([system, managed])).resolves.toEqual([
      [{ value: 'system-gpt' }],
      [{ value: 'managed-gpt' }],
    ]);
    expect(systemQueryer).toHaveBeenCalledTimes(1);
    expect(managedQueryer).toHaveBeenCalledTimes(1);
  });

  it('clears in-flight state after rejection', async () => {
    const queryer = vi.fn<() => Promise<unknown[]>>()
      .mockRejectedValueOnce(new Error('boom'))
      .mockResolvedValueOnce([{ value: 'ok' }]);

    await expect(queryRuntimeModelsSingleFlight('claude-code', queryer)).rejects.toThrow('boom');
    await expect(queryRuntimeModelsSingleFlight('claude-code', queryer)).resolves.toEqual([{ value: 'ok' }]);
    expect(queryer).toHaveBeenCalledTimes(2);
  });

  it('does not single-flight builtin runtime', async () => {
    const queryer = vi.fn(async () => [{ value: 'should-not-run' }]);

    await expect(queryRuntimeModelsSingleFlight('builtin', queryer)).resolves.toEqual([]);
    expect(queryer).not.toHaveBeenCalled();
  });

  it('aborts the owned query only after every subscriber has cancelled', async () => {
    const first = new AbortController();
    const second = new AbortController();
    let ownerSignal!: AbortSignal;
    const queryer = vi.fn((signal: AbortSignal) => new Promise<unknown[]>((_, reject) => {
      ownerSignal = signal;
      signal.addEventListener('abort', () => reject(signal.reason), { once: true });
    }));

    const a = queryRuntimeModelsSingleFlight('claude-code', queryer, undefined, first.signal);
    const b = queryRuntimeModelsSingleFlight('claude-code', queryer, undefined, second.signal);
    first.abort(new Error('first cancelled'));

    await expect(a).rejects.toThrow('first cancelled');
    expect(ownerSignal.aborted).toBe(false);

    second.abort(new Error('second cancelled'));
    await expect(b).rejects.toThrow('second cancelled');
    expect(ownerSignal.aborted).toBe(true);
    expect(queryer).toHaveBeenCalledTimes(1);
  });
});

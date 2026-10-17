/**
 * Bot-scoped runtime admission primitives.
 *
 * No runtime is registered here. Until a production adapter supplies an
 * immutable Bot snapshot and a concrete, scoped run entry, callers get an
 * explicit unsupported result. In particular, registry metadata alone never
 * makes a Bot runnable.
 */

export type BotRuntime = 'builtin' | 'codex';

export interface BotRuntimeConfig {
  name: string;
  description: string;
  runtime: BotRuntime;
  model_ref: string | null;
  system_prompt: string;
  daily_tokens: number;
}

export interface BotRunIdentity {
  bot_id: string;
  agent_id: string;
  binding_generation: number;
  run_generation: string;
  session_id: string;
  snapshot_hash: string;
  runtime: BotRuntime;
}

export interface ImmutableBotSnapshot {
  bot_id: string;
  agent_id: string;
  binding_generation: number;
  revision: number;
  runtime: BotRuntime;
  snapshot_hash: string;
  config: Readonly<BotRuntimeConfig>;
}

export interface BotRunEntry {
  /** Stable adapter-owned entry; never a filesystem path from a request. */
  id: string;
  runtime: BotRuntime;
  snapshot_hash: string;
  /** Host supervisor preallocates these canonical identities before start. */
  session_id: string;
  run_generation: string;
}

export type BotRuntimeResult<T> =
  | { status: 'ready'; data: T }
  | { status: 'unsupported'; code: 'BOT_RUNTIME_UNSUPPORTED'; message: string }
  | { status: 'busy'; code: 'HOST_BUSY'; active_bot_id?: string }
  | { status: 'conflict'; code: 'BOT_RUN_BINDING_MISMATCH' }
  | { status: 'unknown'; code: 'BOT_RUN_OUTCOME_UNKNOWN' };

export interface BotRuntimeInspection {
  status: 'running' | 'stopped' | 'unknown';
  identity: BotRunIdentity;
}

/**
 * Implementations are supplied only by a real Host/runtime integration.
 * They receive a Bot-local frozen snapshot and exact Bot/run identity; they
 * are never handed global Host settings, arbitrary credentials, or paths.
 */
export interface BotRuntimeAdapter {
  readonly runtime: BotRuntime;
  /** Creates an idle Bot-local Session after the mutation is durably prepared; no paid turn is started. */
  prepare(snapshot: ImmutableBotSnapshot): Promise<BotRunEntry>;
  start(input: {
    readonly entry: BotRunEntry;
    readonly snapshot: ImmutableBotSnapshot;
    readonly identity: BotRunIdentity;
  }): Promise<{ status: 'running'; identity: BotRunIdentity } | { status: 'unknown' }>;
  stop(input: {
    readonly entry: BotRunEntry;
    readonly identity: BotRunIdentity;
    readonly policy: 'cancel';
  }): Promise<{ status: 'stopped'; identity: BotRunIdentity } | { status: 'unknown' }>;
  /** Reads authoritative supervisor state for exactly one Bot/run identity. */
  inspect(input: { readonly identity: BotRunIdentity }): Promise<BotRuntimeInspection>;
}

// Match execution-core's canonical lowercase UUID shape exactly.
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const opaqueAgentId = (value: unknown): value is string => typeof value === 'string' &&
  value.length > 0 && value.length <= 256 && value.trim() === value &&
  [...value].every(character => character.charCodeAt(0) >= 0x20 && character.charCodeAt(0) !== 0x7f);

const unsupported = (): BotRuntimeResult<never> => ({
  status: 'unsupported',
  code: 'BOT_RUNTIME_UNSUPPORTED',
  message: 'No supported Bot-local runtime adapter is connected on this Host.',
});

function sameIdentity(a: BotRunIdentity, b: BotRunIdentity): boolean {
  return a.bot_id === b.bot_id && a.agent_id === b.agent_id &&
    a.binding_generation === b.binding_generation && a.run_generation === b.run_generation &&
    a.session_id === b.session_id && a.snapshot_hash === b.snapshot_hash && a.runtime === b.runtime;
}

function validIdentity(value: BotRunIdentity): boolean {
  return !!value && UUID.test(value.bot_id) && opaqueAgentId(value.agent_id) &&
    Number.isSafeInteger(value.binding_generation) && value.binding_generation > 0 &&
    UUID.test(value.run_generation) && UUID.test(value.session_id) &&
    /^[a-f0-9]{64}$/.test(value.snapshot_hash) &&
    (value.runtime === 'builtin' || value.runtime === 'codex');
}

function freezeSnapshot(snapshot: ImmutableBotSnapshot): ImmutableBotSnapshot {
  const config = snapshot?.config as BotRuntimeConfig | undefined;
  if (!snapshot || typeof snapshot !== 'object' ||
      !UUID.test(snapshot.bot_id) || !opaqueAgentId(snapshot.agent_id) ||
      !Number.isSafeInteger(snapshot.binding_generation) || snapshot.binding_generation < 1 ||
      !Number.isSafeInteger(snapshot.revision) || snapshot.revision < 0 ||
      !/^[a-f0-9]{64}$/.test(snapshot.snapshot_hash) ||
      (snapshot.runtime !== 'builtin' && snapshot.runtime !== 'codex') ||
      !config || typeof config !== 'object' || Array.isArray(config) ||
      Object.keys(config).some(key => !['name','description','runtime','model_ref','system_prompt','daily_tokens'].includes(key)) ||
      typeof config.name !== 'string' || !config.name.trim() || [...config.name.trim()].length > 60 ||
      Buffer.byteLength(config.name, 'utf8') > 240 || config.name.includes('\0') ||
      typeof config.description !== 'string' || Buffer.byteLength(config.description, 'utf8') > 4096 || config.description.includes('\0') ||
      config.runtime !== snapshot.runtime ||
      (config.model_ref !== null && (typeof config.model_ref !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(config.model_ref))) ||
      typeof config.system_prompt !== 'string' || Buffer.byteLength(config.system_prompt, 'utf8') > 16384 || config.system_prompt.includes('\0') ||
      !Number.isSafeInteger(config.daily_tokens) || config.daily_tokens < 1) {
    throw new Error('BOT_SNAPSHOT_INVALID');
  }
  const configCopy = structuredClone(config);
  return Object.freeze({ ...snapshot, config: deepFreeze(configCopy) });
}

function deepFreeze<T>(value: T): T {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child);
  }
  return value;
}

/**
 * One active runtime lane per Host owner. The lane is intentionally in-memory
 * and is not a durable execution claim. A caller must reconcile it with the
 * real Host Session owner before reporting activity after restart.
 */
export function createBotRuntimeLane(adapter?: BotRuntimeAdapter) {
  let active: { identity: BotRunIdentity; entry: BotRunEntry; phase: 'starting' | 'running' | 'stopping' | 'unknown' } | undefined;
  let transitionInFlight = false;

  return {
    available(): boolean { return adapter !== undefined; },
    async prepare(raw: ImmutableBotSnapshot): Promise<BotRuntimeResult<BotRunEntry>> {
      if (!adapter) return unsupported();
      const snapshot = freezeSnapshot(raw);
      if (snapshot.runtime !== adapter.runtime) return unsupported();
      let entry: BotRunEntry;
      try { entry = await adapter.prepare(snapshot); } catch (error) {
        if (error instanceof Error && error.message === 'HOST_BUSY') return { status: 'busy', code: 'HOST_BUSY' };
        return unsupported();
      }
      if (!entry || typeof entry.id !== 'string' || !entry.id || entry.runtime !== snapshot.runtime ||
          entry.snapshot_hash !== snapshot.snapshot_hash || !UUID.test(entry.session_id) || !UUID.test(entry.run_generation)) return unsupported();
      return { status: 'ready', data: Object.freeze({ ...entry }) };
    },

    async start(
      rawSnapshot: ImmutableBotSnapshot,
      entry: BotRunEntry,
      identity: BotRunIdentity,
    ): Promise<BotRuntimeResult<BotRunIdentity>> {
      if (!adapter) return unsupported();
      const snapshot = freezeSnapshot(rawSnapshot);
      if (!validIdentity(identity) || snapshot.runtime !== adapter.runtime ||
          identity.bot_id !== snapshot.bot_id || identity.agent_id !== snapshot.agent_id ||
          identity.binding_generation !== snapshot.binding_generation ||
          identity.snapshot_hash !== snapshot.snapshot_hash || identity.runtime !== snapshot.runtime ||
          entry.runtime !== snapshot.runtime || entry.snapshot_hash !== snapshot.snapshot_hash || !entry.id ||
          entry.session_id!==identity.session_id || entry.run_generation!==identity.run_generation) {
        return { status: 'conflict', code: 'BOT_RUN_BINDING_MISMATCH' };
      }
      if (active && !sameIdentity(active.identity, identity)) {
        return { status: 'busy', code: 'HOST_BUSY', active_bot_id: active.identity.bot_id };
      }
      if (active && transitionInFlight) return { status: 'unknown', code: 'BOT_RUN_OUTCOME_UNKNOWN' };
      if (active) return active.phase === 'running'
        ? { status: 'ready', data: { ...identity } }
        : { status: 'unknown', code: 'BOT_RUN_OUTCOME_UNKNOWN' };
      // Reserve the sole lane before awaiting runtime I/O. If the outcome is
      // unknown, keep the reservation so another Bot cannot be started over
      // an unconfirmed process.
      active = { identity: { ...identity }, entry: { ...entry }, phase: 'starting' };
      transitionInFlight = true;
      let result: Awaited<ReturnType<BotRuntimeAdapter['start']>>;
      try {
        result = await adapter.start({ entry, snapshot, identity });
        if (result.status !== 'running' || !sameIdentity(result.identity, identity)) {
          active.phase = 'unknown';
          return { status: 'unknown', code: 'BOT_RUN_OUTCOME_UNKNOWN' };
        }
        active.phase = 'running';
        return { status: 'ready', data: { ...identity } };
      } catch {
        if (active) active.phase = 'unknown';
        return { status: 'unknown', code: 'BOT_RUN_OUTCOME_UNKNOWN' };
      } finally { transitionInFlight = false; }
    },

    async stop(identity: BotRunIdentity): Promise<BotRuntimeResult<BotRunIdentity>> {
      if (!adapter) return unsupported();
      if (!validIdentity(identity) || !active || !sameIdentity(active.identity, identity)) {
        return { status: 'conflict', code: 'BOT_RUN_BINDING_MISMATCH' };
      }
      if (transitionInFlight) return { status: 'unknown', code: 'BOT_RUN_OUTCOME_UNKNOWN' };
      active.phase = 'stopping';
      transitionInFlight = true;
      let result: Awaited<ReturnType<BotRuntimeAdapter['stop']>>;
      try {
        result = await adapter.stop({ entry: active.entry, identity: { ...active.identity }, policy: 'cancel' });
        if (result.status !== 'stopped' || !sameIdentity(result.identity, identity)) {
          active.phase = 'unknown';
          return { status: 'unknown', code: 'BOT_RUN_OUTCOME_UNKNOWN' };
        }
        active = undefined;
        return { status: 'ready', data: { ...identity } };
      } catch {
        if (active) active.phase = 'unknown';
        return { status: 'unknown', code: 'BOT_RUN_OUTCOME_UNKNOWN' };
      } finally { transitionInFlight = false; }
    },

    async inspect(identity: BotRunIdentity, entry: BotRunEntry): Promise<BotRuntimeInspection> {
      const unknown = (): BotRuntimeInspection => ({ status: 'unknown', identity: { ...identity } });
      if (!validIdentity(identity) || !entry || entry.runtime !== identity.runtime ||
          entry.session_id !== identity.session_id || entry.run_generation !== identity.run_generation ||
          entry.snapshot_hash !== identity.snapshot_hash || !entry.id) return unknown();
      if (!adapter) {
        if (!active) active = { identity: { ...identity }, entry: { ...entry }, phase: 'unknown' };
        return unknown();
      }
      if (active && !sameIdentity(active.identity, identity)) return unknown();
      if (transitionInFlight) return unknown();

      // Reserve this exact run while the authoritative supervisor lookup is in flight.
      if (!active) active = { identity: { ...identity }, entry: { ...entry }, phase: 'unknown' };
      transitionInFlight = true;
      try {
        const result = await adapter.inspect({ identity: { ...identity } });
        if (!result || !['running', 'stopped', 'unknown'].includes(result.status) ||
            !result.identity || !validIdentity(result.identity) || !sameIdentity(result.identity, identity)) {
          if (active && sameIdentity(active.identity, identity)) active.phase = 'unknown';
          return unknown();
        }
        if (result.status === 'stopped') {
          if (active && sameIdentity(active.identity, identity)) active = undefined;
          return { status: 'stopped', identity: { ...identity } };
        }
        if (result.status === 'running') {
          active = { identity: { ...identity }, entry: { ...entry }, phase: 'running' };
          return { status: 'running', identity: { ...identity } };
        }
        if (active && sameIdentity(active.identity, identity)) active.phase = 'unknown';
        return unknown();
      } catch {
        if (active && sameIdentity(active.identity, identity)) active.phase = 'unknown';
        return unknown();
      } finally { transitionInFlight = false; }
    },

    activeRun(): BotRunIdentity | undefined {
      return active ? { ...active.identity } : undefined;
    },
  };
}

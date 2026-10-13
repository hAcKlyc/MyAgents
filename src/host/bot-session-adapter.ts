/** The Host supervisor remains the sole process/Session owner. */
import { randomUUID } from 'node:crypto';
import { parseHostBotBootstrap, type HostBotBootstrap } from './bot-session-bootstrap';
import type { BotRunEntry, BotRunIdentity, BotRuntimeAdapter, ImmutableBotSnapshot } from './bot-runtime';

export interface BotSessionSupervisor {
  resolve(snapshot: ImmutableBotSnapshot): Promise<{workspace: string; provider_id: string; model: string}>;
  prepare(bootstrap: HostBotBootstrap): Promise<{session_id: string; run_generation: string}>;
  inspect(identity: BotRunIdentity): Promise<{status: 'running'|'stopped'|'unknown'; identity: BotRunIdentity}>;
  stop(identity: BotRunIdentity): Promise<{status: 'stopped'|'unknown'; identity: BotRunIdentity}>;
}
const equal = (a: BotRunIdentity, b: BotRunIdentity) =>
  a.bot_id===b.bot_id && a.agent_id===b.agent_id && a.binding_generation===b.binding_generation &&
  a.run_generation===b.run_generation && a.session_id===b.session_id &&
  a.snapshot_hash===b.snapshot_hash && a.runtime===b.runtime;

export function createBotSessionAdapter(owner: BotSessionSupervisor): BotRuntimeAdapter {
  const prepared = new Map<string,{entry: BotRunEntry; identity: BotRunIdentity}>();
  return {
    runtime: 'builtin',
    async prepare(snapshot) {
      if (prepared.size >= 256) throw new Error('BOT_RUNTIME_UNSUPPORTED');
      const route = await owner.resolve(snapshot);
      const bootstrap = parseHostBotBootstrap({version:1,snapshot,...route,run_generation:randomUUID()});
      const actual = await owner.prepare(bootstrap);
      if (actual.run_generation !== bootstrap.run_generation) throw new Error('BOT_RUN_BINDING_MISMATCH');
      const entry: BotRunEntry = {id:randomUUID(),runtime:'builtin',snapshot_hash:snapshot.snapshot_hash,
        session_id:actual.session_id,run_generation:actual.run_generation};
      const identity: BotRunIdentity = {bot_id:snapshot.bot_id,agent_id:snapshot.agent_id,
        binding_generation:snapshot.binding_generation,run_generation:entry.run_generation,session_id:entry.session_id,
        snapshot_hash:entry.snapshot_hash,runtime:'builtin'};
      prepared.set(entry.id,{entry:Object.freeze(entry),identity:Object.freeze(identity)});
      return entry;
    },
    async start({entry,identity}) {
      const saved=prepared.get(entry.id);
      if (!saved || !equal(saved.identity,identity) || entry.session_id!==saved.entry.session_id ||
          entry.run_generation!==saved.entry.run_generation || entry.snapshot_hash!==saved.entry.snapshot_hash) return {status:'unknown'};
      const current = await owner.inspect(identity);
      return current.status==='running' && equal(current.identity,identity) ? {status:'running',identity} : {status:'unknown'};
    },
    async inspect({identity}) {
      const saved=[...prepared.values()].find(value=>equal(value.identity,identity));
      if (!saved) return {status:'unknown',identity};
      const current = await owner.inspect(identity);
      return equal(current.identity,identity) ? current : {status:'unknown',identity};
    },
    async stop({entry,identity}) {
      const saved=prepared.get(entry.id);
      if (!saved || !equal(saved.identity,identity)) return {status:'unknown'};
      const result=await owner.stop(identity);
      if (result.status==='stopped' && equal(result.identity,identity)) {prepared.delete(entry.id);return {status:'stopped',identity};}
      return {status:'unknown'};
    },
  };
}

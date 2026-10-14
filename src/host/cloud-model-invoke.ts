/** Internal exact-owner turn admission. This does not add an HTTP/IPC command or a lifecycle capability. */
import { assertCloudModelAdmission, type CloudModelLease, type CloudModelPolicy } from './cloud-model';
import type { BotRunEntry, BotRunIdentity, ImmutableBotSnapshot } from './bot-runtime';

export interface ActiveCloudModelRun {
  identity: BotRunIdentity;
  snapshot: ImmutableBotSnapshot;
  lease: CloudModelLease;
  closing: boolean;
  processAlive: boolean;
}
export function sameCloudModelRun(a: BotRunIdentity, b: BotRunIdentity): boolean {
  return a.bot_id === b.bot_id && a.agent_id === b.agent_id && a.binding_generation === b.binding_generation &&
    a.run_generation === b.run_generation && a.session_id === b.session_id && a.snapshot_hash === b.snapshot_hash && a.runtime === b.runtime;
}
/** The supervisor supplies all authority; an entry or caller identity is never a grant. */
export function createCloudModelInvoker(owner: {
  current(): ActiveCloudModelRun | undefined;
  policy(): CloudModelPolicy | undefined;
  assertAuthority(): Promise<void>;
  dispatch(identity: BotRunIdentity, text: string): Promise<unknown>;
}): (entry: BotRunEntry, identity: BotRunIdentity, text: string) => Promise<unknown> {
  function check(entry: BotRunEntry, identity: BotRunIdentity): ActiveCloudModelRun {
    const run = owner.current();
    if (!run || run.closing || !run.processAlive || !sameCloudModelRun(run.identity,identity) ||
      run.snapshot.runtime !== 'builtin' || run.snapshot.config.runtime !== 'builtin' || entry.runtime !== 'builtin' || identity.runtime !== 'builtin' || entry.session_id !== identity.session_id ||
      entry.run_generation !== identity.run_generation || entry.snapshot_hash !== identity.snapshot_hash ||
      run.snapshot.bot_id !== identity.bot_id || run.snapshot.agent_id !== identity.agent_id ||
      run.snapshot.binding_generation !== identity.binding_generation || run.snapshot.snapshot_hash !== identity.snapshot_hash ||
      run.snapshot.config.model_ref !== run.lease.model_ref || run.lease.expires_at <= Date.now()/1000) throw new Error('BOT_MODEL_NOT_AUTHORIZED');
    const policy = assertCloudModelAdmission(owner.policy(),identity.bot_id,run.lease.model_ref,run.snapshot.config.daily_tokens);
    if (run.lease.expires_at > policy.expires_at || run.lease.max_output_tokens > policy.max_output_tokens ||
      run.lease.max_total_tokens > run.snapshot.config.daily_tokens) throw new Error('BOT_MODEL_NOT_AUTHORIZED');
    return run;
  }
  return async (entry, identity, text) => {
    if (typeof text !== 'string' || !text.trim() || text.length > 100_000) throw new Error('BOT_MODEL_INPUT_INVALID');
    check(entry,identity);
    await owner.assertAuthority();
    // Authority IO may yield across stop/replacement. Re-read the active owner
    // immediately before the one dispatch; never retry an uncertain outcome.
    check(entry,identity);
    return owner.dispatch(identity,text);
  };
}

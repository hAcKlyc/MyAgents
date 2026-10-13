import { describe, expect, it, vi } from 'vitest';
import { createBotRuntimeLane, type BotRunIdentity, type BotRuntimeAdapter, type ImmutableBotSnapshot } from '../host/bot-runtime';

const hash = 'a'.repeat(64);
const botA = '30000000-0000-4000-8000-000000000001';
const botB = '30000000-0000-4000-8000-000000000002';
const sessionA = '40000000-0000-4000-8000-000000000001';
const sessionB = '40000000-0000-4000-8000-000000000002';
const runA = '50000000-0000-4000-8000-000000000001';
const runB = '50000000-0000-4000-8000-000000000002';
function snapshot(bot = botA, name = bot): ImmutableBotSnapshot {
  return { bot_id: bot, agent_id: `agent-${bot}`, binding_generation: 1, revision: 2,
    runtime: 'builtin', snapshot_hash: hash, config: { name, description: '', runtime: 'builtin', model_ref: null,
      system_prompt: 'private prompt', daily_tokens: 1000 } };
}
function identity(bot = botA, session = sessionA): BotRunIdentity {
  return { bot_id: bot, agent_id: `agent-${bot}`, binding_generation: 1,
    run_generation: bot===botA?runA:runB, session_id: session, snapshot_hash: hash, runtime: 'builtin' };
}
function adapter(overrides: Partial<BotRuntimeAdapter> = {}): BotRuntimeAdapter {
  return {
    runtime: 'builtin',
    prepare: vi.fn(async () => ({ id: 'entry-a', runtime: 'builtin' as const, snapshot_hash: hash, session_id:sessionA, run_generation:runA })),
    start: vi.fn(async input => ({ status: 'running' as const, identity: input.identity })),
    stop: vi.fn(async input => ({ status: 'stopped' as const, identity: input.identity })),
    inspect: vi.fn(async input => ({ status: 'running' as const, identity: input.identity })),
    ...overrides,
  };
}

describe('Bot runtime lane (unit contract only; no production Host adapter is connected)', () => {
  it('counts Bot name length in Unicode scalar values at the 60-character boundary', async () => {
    const runtime=adapter(); const lane=createBotRuntimeLane(runtime);
    const sixtyScalars='😀'.repeat(60);
    await expect(lane.prepare(snapshot(botA,sixtyScalars))).resolves.toMatchObject({status:'ready'});
    expect((runtime.prepare as ReturnType<typeof vi.fn>).mock.calls[0][0].config.name).toBe(sixtyScalars);
    await expect(lane.prepare(snapshot(botA,'😀'.repeat(61)))).rejects.toThrow('BOT_SNAPSHOT_INVALID');
    expect(runtime.prepare).toHaveBeenCalledTimes(1);
  });

  it('fails closed without a runtime adapter and never infers runnable from registry config', async () => {
    const lane = createBotRuntimeLane();
    await expect(lane.prepare(snapshot())).resolves.toMatchObject({status:'unsupported',code:'BOT_RUNTIME_UNSUPPORTED'});
    await expect(lane.start(snapshot(), {id:'entry',runtime:'builtin',snapshot_hash:hash,session_id:sessionA,run_generation:runA}, identity()))
      .resolves.toMatchObject({status:'unsupported',code:'BOT_RUNTIME_UNSUPPORTED'});
    expect(lane.activeRun()).toBeUndefined();
  });

  it('preserves the explicit Host-busy result from adapter preparation', async () => {
    const lane=createBotRuntimeLane(adapter({prepare:vi.fn(async()=>{throw new Error('HOST_BUSY');})}));
    await expect(lane.prepare(snapshot())).resolves.toEqual({status:'busy',code:'HOST_BUSY'});
  });

  it('passes a cloned immutable snapshot to adapter and accepts only a matching entry/start receipt', async () => {
    const runtime = adapter(); const lane = createBotRuntimeLane(runtime);
    const original = snapshot();
    const prepared = await lane.prepare(original);
    expect(prepared).toMatchObject({status:'ready',data:{runtime:'builtin',snapshot_hash:hash}});
    const passed = (runtime.prepare as ReturnType<typeof vi.fn>).mock.calls[0][0] as ImmutableBotSnapshot;
    expect(Object.isFrozen(passed)).toBe(true);
    expect(Object.isFrozen(passed.config)).toBe(true);
    expect(passed.config).not.toBe(original.config);
    expect(original.config.system_prompt).toBe('private prompt');
    await expect(lane.start(original, prepared.status === 'ready' ? prepared.data : {id:'',runtime:'builtin',snapshot_hash:'',session_id:'',run_generation:''}, identity()))
      .resolves.toMatchObject({status:'ready'});
  });

  it('keeps the single active lane and refuses to stop another Bot or a different Session', async () => {
    const runtime = adapter(); const lane = createBotRuntimeLane(runtime);
    const entry = {id:'entry-a',runtime:'builtin' as const,snapshot_hash:hash,session_id:sessionA,run_generation:runA};
    await expect(lane.start(snapshot(), entry, identity())).resolves.toMatchObject({status:'ready'});
    await expect(lane.start(snapshot(botB), {...entry,id:'entry-b',session_id:sessionB,run_generation:runB}, identity(botB,sessionB)))
      .resolves.toMatchObject({status:'busy',code:'HOST_BUSY',active_bot_id:botA});
    for(const stale of [
      identity(botA,'60000000-0000-4000-8000-000000000001'),
      {...identity(),run_generation:runB},
      {...identity(),snapshot_hash:'b'.repeat(64)},
    ]) await expect(lane.stop(stale)).resolves.toMatchObject({status:'conflict',code:'BOT_RUN_BINDING_MISMATCH'});
    expect(runtime.stop).not.toHaveBeenCalled();
    expect(lane.activeRun()).toEqual(identity());
  });

  it('retains a possibly active run when stop is unknown and clears it only after exact stopped confirmation', async () => {
    const runtime = adapter({stop: vi.fn(async () => ({status:'unknown' as const}))});
    const lane = createBotRuntimeLane(runtime); const entry = {id:'entry-a',runtime:'builtin' as const,snapshot_hash:hash,session_id:sessionA,run_generation:runA};
    await lane.start(snapshot(), entry, identity());
    await expect(lane.stop(identity())).resolves.toMatchObject({status:'unknown',code:'BOT_RUN_OUTCOME_UNKNOWN'});
    expect(lane.activeRun()).toEqual(identity());
  });

  it('reconciles only an exact authoritative identity and clears the lane only on exact stopped', async () => {
    let inspected: 'running'|'stopped'|'unknown'='unknown';
    const runtime=adapter({inspect:vi.fn(async input=>({status:inspected,identity:input.identity}))});
    const lane=createBotRuntimeLane(runtime); const entry={id:'entry-a',runtime:'builtin' as const,snapshot_hash:hash,session_id:sessionA,run_generation:runA};
    await lane.start(snapshot(),entry,identity());
    await expect(lane.inspect(identity(),entry)).resolves.toMatchObject({status:'unknown',identity:identity()});
    expect(lane.activeRun()).toEqual(identity());
    inspected='running';
    await expect(lane.inspect(identity(),entry)).resolves.toMatchObject({status:'running',identity:identity()});
    inspected='stopped';
    await expect(lane.inspect(identity(),entry)).resolves.toMatchObject({status:'stopped',identity:identity()});
    expect(lane.activeRun()).toBeUndefined();
  });

  it('does not clear a lane when inspection returns a different Bot/run identity', async () => {
    const runtime=adapter({inspect:vi.fn(async()=>({status:'stopped' as const,identity:identity(botB,sessionB)}))});
    const lane=createBotRuntimeLane(runtime); const entry={id:'entry-a',runtime:'builtin' as const,snapshot_hash:hash,session_id:sessionA,run_generation:runA};
    await lane.start(snapshot(),entry,identity());
    await expect(lane.inspect(identity(),entry)).resolves.toMatchObject({status:'unknown',identity:identity()});
    expect(lane.activeRun()).toEqual(identity());
    expect(runtime.stop).not.toHaveBeenCalled();
  });

  it('returns unknown during a start transition without overlapping supervisor inspection', async () => {
    let release!: (value: {status:'running';identity:BotRunIdentity})=>void;
    let entered!: ()=>void;
    const started=new Promise<void>(resolve=>{entered=resolve;});
    const pending=new Promise<{status:'running';identity:BotRunIdentity}>(resolve=>{release=resolve;});
    const runtime=adapter({start:vi.fn(async _input=>{entered();return pending;} )});
    const lane=createBotRuntimeLane(runtime); const entry={id:'entry-a',runtime:'builtin' as const,snapshot_hash:hash,session_id:sessionA,run_generation:runA};
    const start=lane.start(snapshot(),entry,identity()); await started;
    await expect(lane.inspect(identity(),entry)).resolves.toMatchObject({status:'unknown'});
    expect(runtime.inspect).not.toHaveBeenCalled();
    expect(lane.activeRun()).toEqual(identity());
    release({status:'running',identity:identity()});
    await expect(start).resolves.toMatchObject({status:'ready'});
  });

  it('treats mismatched adapter identities as unknown and does not claim running', async () => {
    const runtime = adapter({start: vi.fn(async () => ({status:'running' as const,identity:identity(botB,sessionB)}))});
    const lane = createBotRuntimeLane(runtime); const entry = {id:'entry-a',runtime:'builtin' as const,snapshot_hash:hash,session_id:sessionA,run_generation:runA};
    await expect(lane.start(snapshot(), entry, identity())).resolves.toMatchObject({status:'unknown',code:'BOT_RUN_OUTCOME_UNKNOWN'});
    expect(lane.activeRun()).toEqual(identity());
  });

  it('reserves the Host lane before awaiting start and keeps an unknown run fenced', async () => {
    let release!: (value: {status:'unknown'}) => void;
    let entered!: () => void;
    const started = new Promise<void>(resolve => { entered = resolve; });
    const pending = new Promise<{status:'unknown'}>(resolve => { release = resolve; });
    const runtime = adapter({start: vi.fn(async () => { entered(); return pending; })});
    const lane = createBotRuntimeLane(runtime); const entry = {id:'entry-a',runtime:'builtin' as const,snapshot_hash:hash,session_id:sessionA,run_generation:runA};
    const first = lane.start(snapshot(), entry, identity());
    await started;
    await expect(lane.start(snapshot(botB), {...entry,id:'entry-b',session_id:sessionB,run_generation:runB}, identity(botB,sessionB)))
      .resolves.toMatchObject({status:'busy',code:'HOST_BUSY',active_bot_id:botA});
    release({status:'unknown'});
    await expect(first).resolves.toMatchObject({status:'unknown',code:'BOT_RUN_OUTCOME_UNKNOWN'});
    await expect(lane.start(snapshot(), entry, identity())).resolves.toMatchObject({status:'unknown',code:'BOT_RUN_OUTCOME_UNKNOWN'});
    expect(runtime.start).toHaveBeenCalledTimes(1);
  });

  it('rejects arbitrary configuration keys so credentials and global Host settings cannot enter the snapshot', async () => {
    const lane = createBotRuntimeLane(adapter());
    const unsafe = {...snapshot(), config: {...snapshot().config, api_key:'secret'}} as unknown as ImmutableBotSnapshot;
    await expect(lane.prepare(unsafe)).rejects.toThrow('BOT_SNAPSHOT_INVALID');
  });

  it('rejects non-UUID Bot/session/run identities, invalid Agent IDs and mismatched snapshot hashes', async () => {
    const runtime=adapter(); const lane=createBotRuntimeLane(runtime);
    const entry={id:'entry-a',runtime:'builtin' as const,snapshot_hash:hash,session_id:sessionA,run_generation:runA};
    for(const invalid of [
      {...identity(),bot_id:'bot-a'},
      {...identity(),agent_id:'x'.repeat(257)},
      {...identity(),session_id:'private-session'},
      {...identity(),run_generation:1 as unknown as string},
      {...identity(),snapshot_hash:'b'.repeat(64)},
    ]) await expect(lane.start(snapshot(),entry,invalid)).resolves.toMatchObject({status:'conflict',code:'BOT_RUN_BINDING_MISMATCH'});
    expect(runtime.start).not.toHaveBeenCalled();
  });
});

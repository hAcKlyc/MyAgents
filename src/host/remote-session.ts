import { remoteSessionRequestSchema, remoteSessionResultSchema, type RemoteSessionRequest, type RemoteSessionResult, type RemoteSnapshot } from '../shared/remoteSession';
import { RemoteSessionError } from '../server/remote-session/receipts';

export type HostRemoteReceipt = Extract<RemoteSessionResult, {kind:'receipt'}>;
export type HostRemoteTarget = {sessionId:string;generation:string};
export type HostRemoteAgent = {workspacePath:string;runtime:string};
type Mutation = Extract<RemoteSessionRequest, {kind:'start'|'send'|'respond'|'stop'}>;
export interface HostRemotePorts {
  resolveAgent(agentId:string):Promise<HostRemoteAgent>;
  validateSession(sessionId:string,workspacePath:string):Promise<void>;
  list(request:Extract<RemoteSessionRequest,{kind:'list'}>,agent:HostRemoteAgent):Promise<Extract<RemoteSessionResult,{kind:'list'}>>;
  snapshot(request:Extract<RemoteSessionRequest,{kind:'get'}>):Promise<RemoteSnapshot>;
  ensure(workspacePath:string,sessionId?:string):Promise<HostRemoteTarget>;
  active():HostRemoteTarget|null;
  execute(request:Exclude<Mutation,{kind:'start'}>,target:HostRemoteTarget):Promise<unknown>;
  receipts:{
    begin(request:Mutation,sessionId:string|null):Promise<{fresh:boolean;receipt:HostRemoteReceipt}>;
    read(agentId:string,operationId:string):Promise<HostRemoteReceipt>;
    update(request:Mutation,status:HostRemoteReceipt['status'],sessionId:string|null,code:string|null):Promise<HostRemoteReceipt>;
  };
}
export class HostRemoteError extends Error { constructor(readonly code:string) {super(code);} }
const knownCode = (error:unknown) => error instanceof HostRemoteError || error instanceof RemoteSessionError ? error.code : 'REMOTE_SESSION_OWNER_UNAVAILABLE';

/** A delegated Bot's registered workspace belongs to its exact finite owner,
 * including after exit/restart. Ordinary remote chat cannot adopt that owner. */
export function assertOrdinaryRemoteAgent(agentId:string,ledger:unknown):void {
  if (ledger===undefined) return;
  if (!ledger || typeof ledger!=='object' || !Array.isArray((ledger as {bots?:unknown}).bots)) throw new HostRemoteError('REMOTE_SESSION_PRIVATE_OWNER_UNAVAILABLE');
  for(const item of (ledger as {bots:unknown[]}).bots){
    if (!item || typeof item!=='object' || !(item as {snapshot?:unknown}).snapshot || typeof (item as {snapshot?:unknown}).snapshot!=='object') throw new HostRemoteError('REMOTE_SESSION_PRIVATE_OWNER_UNAVAILABLE');
    if ((item as {snapshot:{agent_id?:unknown}}).snapshot.agent_id===agentId) throw new HostRemoteError('REMOTE_SESSION_PRIVATE');
  }
}

/** The existing supervisor owns lifecycle and receipts. Dispatch runs outside
 * the management reply, leaving human responses reachable during admission. */
export function createHostRemoteSessionService(ports:HostRemotePorts) {
  const jobs = new Set<Promise<void>>();
  let pendingAdmissions=0;
  async function perform(request:Mutation,agent:HostRemoteAgent) {
    let sessionId = 'sessionId' in request ? request.sessionId : null;
    let handedOff = false;
    try {
      const current = await ports.resolveAgent(request.agentId);
      if (current.workspacePath !== agent.workspacePath || current.runtime !== agent.runtime) throw new HostRemoteError('REMOTE_SESSION_AGENT_CHANGED');
      let target:HostRemoteTarget;
      if (request.kind === 'respond' || request.kind === 'stop') {
        const active = ports.active();
        if (!active || active.sessionId !== request.sessionId || active.generation !== request.generation) throw new HostRemoteError('REMOTE_SESSION_INTERACTION_EXPIRED');
        target = active;
      } else target = await ports.ensure(agent.workspacePath,sessionId ?? undefined);
      sessionId = target.sessionId;
      await ports.validateSession(sessionId,agent.workspacePath);
      await ports.receipts.update(request,'processing',sessionId,null);
      // Recheck after cold preparation and durable receipt I/O, immediately
      // before the original Session worker's final execution handoff.
      const latest = await ports.resolveAgent(request.agentId);
      if (latest.workspacePath !== agent.workspacePath || latest.runtime !== agent.runtime) throw new HostRemoteError('REMOTE_SESSION_AGENT_CHANGED');
      const call:Exclude<Mutation,{kind:'start'}> = request.kind === 'start'
        ? {kind:'send',agentId:request.agentId,sessionId,operationId:request.operationId,text:request.text}:request;
      handedOff = true;
      await ports.execute(call,target);
      await ports.receipts.update(request,'accepted',sessionId,null);
    } catch (error) {
      const code = handedOff && !(error instanceof HostRemoteError) ? 'REMOTE_SESSION_OPERATION_UNCONFIRMED':knownCode(error);
      // Any loss after IPC handoff is uncertain. Engine rejection codes are
      // not guessed from arbitrary upstream exception messages.
      await ports.receipts.update(request,error instanceof HostRemoteError ? 'rejected':'unconfirmed',sessionId,code).catch(()=>{});
    }
  }
  return {
    async request(value:unknown):Promise<RemoteSessionResult> {
      const parsed=remoteSessionRequestSchema.safeParse(value);
      if (!parsed.success) return {kind:'error',code:'REMOTE_SESSION_REQUEST_INVALID'};
      const request=parsed.data;
      try {
        const agent=await ports.resolveAgent(request.agentId);
        if (agent.runtime !== 'builtin') throw new HostRemoteError('REMOTE_SESSION_RUNTIME_UNSUPPORTED');
        if ('sessionId' in request) await ports.validateSession(request.sessionId,agent.workspacePath);
        if (request.kind === 'capabilities') return {kind:'capabilities',version:1,agentId:request.agentId,runtime:agent.runtime,maxActiveSessions:1,liveUpdates:'snapshot'};
        if (request.kind === 'list') return remoteSessionResultSchema.parse(await ports.list(request,agent));
        if (request.kind === 'get') return remoteSessionResultSchema.parse(await ports.snapshot(request));
        if (request.kind === 'receipt') return ports.receipts.read(request.agentId,request.operationId);
        // Keep four control slots available when model sends await admission.
        const capacity=request.kind==='respond'||request.kind==='stop' ? 20:16;
        if (jobs.size+pendingAdmissions>=capacity) throw new HostRemoteError('REMOTE_SESSION_CAPACITY');
        pendingAdmissions++;
        try {
          const begun=await ports.receipts.begin(request,'sessionId' in request ? request.sessionId:null);
          if (begun.fresh) {
            const job=perform(request,agent).finally(()=>jobs.delete(job));
            jobs.add(job);
          }
          return begun.receipt;
        } finally {
          pendingAdmissions--;
        }
      } catch (error) {return {kind:'error',code:knownCode(error)};}
    },
    async drain() {await Promise.allSettled(jobs);},
  };
}

import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { REMOTE_SESSION_BYTES, remoteSessionRequestSchema, remoteSessionResultSchema, type RemoteSessionRequest, type RemoteSessionResult } from '../../shared/remoteSession';
import { workspacePathsEqual } from '../../shared/workspacePath';
import { isProjectArchived, isProjectVisibleToUser } from '../../shared/config-types';
import type { AgentConfig } from '../../shared/types/agent';
import type { RuntimeSource, RuntimeType } from '../../shared/types/runtime';
import { resolvePersistedAgentWorkspaceRegistry } from '../utils/agent-workspace-identity';
import { createMaterializedSessionMetadata } from '../utils/session-materialization';
import { resolveWorkspaceConfig } from '../utils/admin-config';
import { isManagedCodexProviderReady } from '../utils/managed-codex-readiness';
import { handleAgentShow } from '../admin-api';
import { claimPreparedSessionForTurnAdmission, getSessionMetadata, getSessionsByAgentDir, isHistoryVisibleSession, saveSessionMetadata, publishSessionForHandoff } from '../SessionStore';
import { getSessionEngine, stopActiveTurn, runProcessUpdateAdmission } from '../session-engine';
import { buildRemoteSnapshot, projectRemoteInteractions } from './projection';
import { createRemoteReceiptOwner, RemoteSessionError } from './receipts';

const receipts = createRemoteReceiptOwner('desktop');
const envelope = z.object({request:remoteSessionRequestSchema,generation:z.string().min(1).max(256),preparedSessionId:z.string().uuid().optional()}).strict();
const jobs = new Set<Promise<void>>();
function failure(error:unknown): {success:false;code:string} {
  return {success:false,code:error instanceof RemoteSessionError ? error.code : 'REMOTE_SESSION_OPERATION_UNCONFIRMED'};
}
async function target(agentId:string,sessionId?:string,preparedOperation?:string) {
  const registry=await resolvePersistedAgentWorkspaceRegistry();
  const identity=registry.agentProjections.find(p=>p.agentId===agentId);
  if(registry.diagnostics.some(d=>d.agentIds.includes(agentId))||!identity||identity.agent.enabled!==true||!identity.project||!isProjectVisibleToUser(identity.project)||isProjectArchived(identity.project)) throw new RemoteSessionError('REMOTE_AGENT_UNAVAILABLE');
  if(sessionId){
    const meta=getSessionMetadata(sessionId);
    const prepared=preparedOperation && meta?.materializationState==='prepared' && meta.materializationSourceSessionId===preparedOperation;
    if(!meta||(!isHistoryVisibleSession(meta)&&!prepared)||!workspacePathsEqual(meta.agentDir,identity.workspacePath))throw new RemoteSessionError('REMOTE_SESSION_NOT_FOUND');
  }
  return {identity,config:registry.config};
}
/** Global owner freezes a hidden birth before Rust creates the original Session
 * Sidecar. The network never supplies a path or runtime configuration. */
export async function prepareDesktopRemoteSession(value:unknown) {
  try { return await runProcessUpdateAdmission(() => prepareDesktopRemoteSessionOwned(value)); }
  catch (error) { return failure(error); }
}
async function prepareDesktopRemoteSessionOwned(value:unknown) {
  try {
    const input=z.object({request:remoteSessionRequestSchema}).strict().parse(value);
    const request=input.request;
    if(request.kind!=='start')throw new RemoteSessionError('REMOTE_START_REQUIRED');
    const {identity,config}=await target(request.agentId);
    const begun=await receipts.begin(request,null);
    if(!begun.fresh)return {success:true,data:{receipt:begun.receipt}};
    try {
      const shown=await handleAgentShow({agentId:request.agentId});
      if(!shown.success)throw new RemoteSessionError('REMOTE_AGENT_UNAVAILABLE');
      const defaults=(shown.data as {effectiveDefaults:{runtime:RuntimeType;runtimeSource?:RuntimeSource}}).effectiveDefaults;
      if(defaults.runtimeSource==='managed-provider'&&!isManagedCodexProviderReady(config))throw new RemoteSessionError('REMOTE_RUNTIME_NOT_READY');
      const sessionId=randomUUID();
      const metadata=createMaterializedSessionMetadata({agentDir:identity.workspacePath,sessionId,scenario:'desktop',agent:identity.agent as AgentConfig,runtimeOverride:defaults.runtime,runtimeSourceOverride:defaults.runtimeSource,managedCodexProviderReady:isManagedCodexProviderReady(config),title:request.text.trim().slice(0,40)||'New Chat'});
      metadata.materializationState='prepared';metadata.materializationSourceSessionId=request.operationId;
      await saveSessionMetadata(metadata);
      if(metadata.transcriptFormat===2&&!(await publishSessionForHandoff(sessionId)))throw new RemoteSessionError('REMOTE_BIRTH_PUBLICATION_FAILED');
      await receipts.finish(request,'processing',sessionId);
      return {success:true,data:{agentId:request.agentId,sessionId,workspacePath:identity.workspacePath}};
    }catch(error){await receipts.finish(request,'rejected',null,failure(error).code);throw error}
  }catch(error){return failure(error)}
}
type Mutation=Extract<RemoteSessionRequest,{kind:'start'|'send'|'respond'|'stop'}>;
async function perform(request:Mutation,sessionId:string,generation:string) {
  return runProcessUpdateAdmission(() => performOwned(request,sessionId,generation));
}
async function performOwned(request:Mutation,sessionId:string,generation:string) {
  let handedOff=false;
  try {
    const {identity}=await target(request.agentId,sessionId,request.kind==='start'?request.operationId:undefined);
    const engine=getSessionEngine(),ctx=engine.getCurrentSessionContext();
    if(ctx.sessionId!==sessionId||!ctx.workspacePath||!workspacePathsEqual(ctx.workspacePath,identity.workspacePath)||generation!==process.env.MYAGENTS_SIDECAR_GENERATION)throw new RemoteSessionError('REMOTE_SESSION_OWNER_CHANGED');
    if(request.kind==='start'||request.kind==='send'){
      const metadata=getSessionMetadata(sessionId)!;
      const config=resolveWorkspaceConfig(identity.workspacePath,metadata);
      if(config.mcpServers){const changed=await engine.updateMcpServers(config.mcpServers);if(!changed.success)throw new RemoteSessionError('REMOTE_RUNTIME_CONFIGURATION_FAILED')}
      const beforeDispatch=request.kind==='start'?async()=>{
        await target(request.agentId,sessionId,request.operationId);
        const claim=await claimPreparedSessionForTurnAdmission(sessionId,request.operationId,{title:metadata.title,lastMessagePreview:request.text.slice(0,200)});
        return claim.status==='claimed'||claim.status==='already-committed'?{accepted:true as const}:{accepted:false as const,error:'REMOTE_PREPARED_ADMISSION_FAILED'};
      }:async()=>{await target(request.agentId,sessionId);return {accepted:true as const}};
      handedOff=true;
      const admitted=await engine.sendDesktopMessage({text:request.text,clientRequestId:request.operationId,sessionId,workspacePath:identity.workspacePath,scenario:{type:'desktop'},turnBoundaryOnly:true,model:config.model,permissionMode:config.permissionMode,providerRoute:config.providerRoute,providerEnv:config.providerEnv,reasoningEffort:config.reasoningEffort,beforeDispatch});
      if(!admitted.success||admitted.error)throw new RemoteSessionError('REMOTE_SESSION_ADMISSION_REJECTED');
      if(request.kind==='send'&&admitted.queued&&admitted.queueId){
        // The original queue has accepted this existing Session message. Its
        // promotion can wait on a human response to the currently running turn.
        // Returning processing until promotion would disable that response UI.
        void admitted.dispatchAcceptance?.catch(()=>{});
      }else{
        const acceptance=await admitted.dispatchAcceptance;
        if(acceptance&&!acceptance.accepted)throw new RemoteSessionError('REMOTE_SESSION_ADMISSION_REJECTED');
      }
    }else{
      if(request.generation!==generation||engine.getExecutionTurnId()!==request.turnId)throw new RemoteSessionError('REMOTE_SESSION_INTERACTION_EXPIRED');
      if(request.kind==='stop'){
        handedOff=true;
        if(!(await stopActiveTurn()).success)throw new RemoteSessionError('REMOTE_STOP_FAILED');
      }else{
        const pending=projectRemoteInteractions(engine.getStreamReplaySnapshot().pendingInteractiveRequests,generation,request.turnId).find(p=>p.requestId===request.requestId&&p.interaction===request.interaction);
        if(!pending)throw new RemoteSessionError('REMOTE_SESSION_INTERACTION_EXPIRED');
        if(request.approved&&!pending.actionable)throw new RemoteSessionError('REMOTE_INTERACTION_REQUIRES_TARGET_UI');
        if(request.interaction==='question'&&request.approved&&(!request.answers||pending.questions.some(q=>typeof request.answers?.[q.answerKey]!=='string'||!request.answers[q.answerKey].trim())||Object.keys(request.answers).some(k=>!pending.questions.some(q=>q.answerKey===k))))throw new RemoteSessionError('REMOTE_ANSWERS_INVALID');
        handedOff=true;
        const ok=request.interaction==='permission'?await engine.respondPermission(request.requestId,request.approved?'allow_once':'deny'):request.interaction==='plan'?await engine.respondPlanApproval(request.requestId,request.approved):await engine.respondAskUserQuestion(request.requestId,request.approved?request.answers!:null);
        if(!ok)throw new RemoteSessionError('REMOTE_SESSION_INTERACTION_EXPIRED');
      }
    }
    await receipts.finish(request,'accepted',sessionId);
  }catch(error){await receipts.finish(request,handedOff&&!(error instanceof RemoteSessionError)?'unconfirmed':'rejected',sessionId,failure(error).code).catch(()=>{})}
}
/** Returns a durable processing receipt without waiting for a queued turn, so
 * permission replies and stop remain available on the same encrypted channel. */
export async function handleDesktopRemoteSession(value:unknown,role:'global'|'session'|'standalone') {
  try { return await runProcessUpdateAdmission(() => handleDesktopRemoteSessionOwned(value,role)); }
  catch (error) { return failure(error); }
}
async function handleDesktopRemoteSessionOwned(value:unknown,role:'global'|'session'|'standalone') {
  try {
    const {request,generation,preparedSessionId}=envelope.parse(value);
    if(generation!==process.env.MYAGENTS_SIDECAR_GENERATION)throw new RemoteSessionError('REMOTE_SESSION_OWNER_CHANGED');
    const sessionId=request.kind==='start'?preparedSessionId:'sessionId' in request?request.sessionId:undefined;
    const {identity}=await target(request.agentId,sessionId,request.kind==='start'?request.operationId:undefined);
    let data:RemoteSessionResult;
    if(request.kind==='receipt')data=await receipts.read(request.agentId,request.operationId);
    else if(request.kind==='capabilities'){
      const shown=await handleAgentShow({agentId:request.agentId});if(!shown.success)throw new RemoteSessionError('REMOTE_AGENT_UNAVAILABLE');
      data={kind:'capabilities',version:1,agentId:request.agentId,runtime:(shown.data as {effectiveDefaults:{runtime:string}}).effectiveDefaults.runtime,maxActiveSessions:100,liveUpdates:'snapshot'};
    }else if(request.kind==='list'){
      const all=getSessionsByAgentDir(identity.workspacePath).filter(isHistoryVisibleSession).sort((a,b)=>b.lastActiveAt.localeCompare(a.lastActiveAt)||b.id.localeCompare(a.id));
      const anchor=request.before?all.findIndex(m=>m.id===request.before):-1;
      if(request.before&&anchor<0)throw new RemoteSessionError('REMOTE_HISTORY_ANCHOR_CHANGED');
      const start=anchor+1,items=all.slice(start,start+request.limit);const hasMore=start+items.length<all.length;
      data={kind:'list',agentId:request.agentId,items:items.map(m=>({sessionId:m.id,title:(m.title||'会话').slice(0,256),updatedAt:m.lastActiveAt,preview:(m.lastMessagePreview||'').slice(0,512),runtime:m.runtime||'builtin'})),hasMore,nextBefore:hasMore?items.at(-1)!.id:null};
      while(Buffer.byteLength(JSON.stringify(data))>REMOTE_SESSION_BYTES-1024&&data.items.length>1){data.items.pop();data.hasMore=true;data.nextBefore=data.items.at(-1)!.sessionId}
    }else if(request.kind==='get')data=await buildRemoteSnapshot(request.agentId,request.sessionId,role==='global'?null:generation,request.limit,request.before);
    else {
      if(role==='global'||!sessionId)throw new RemoteSessionError('REMOTE_SESSION_OWNER_REQUIRED');
      const ctx=getSessionEngine().getCurrentSessionContext();
      if(ctx.sessionId!==sessionId||!ctx.workspacePath||!workspacePathsEqual(ctx.workspacePath,identity.workspacePath))throw new RemoteSessionError('REMOTE_SESSION_OWNER_CHANGED');
      let fresh:boolean;
      if(request.kind==='start'){
        const existing=await receipts.read(request.agentId,request.operationId);
        if(existing.sessionId!==sessionId||existing.status==='accepted'||existing.status==='rejected')return {success:true,data:existing};
        // Only the original prepared source is admitted; no duplicate process can
        // revive a previous execution. SessionEngine owns final dispatch CAS.
        fresh=await receipts.adoptPrepared(request,sessionId);data=await receipts.read(request.agentId,request.operationId);
      }else{const begun=await receipts.begin(request,sessionId);fresh=begun.fresh;data=begun.receipt}
      if(fresh){const job=perform(request,sessionId,generation).finally(()=>jobs.delete(job));jobs.add(job)}
    }
    return {success:true,data:remoteSessionResultSchema.parse(data)};
  }catch(error){return failure(error)}
}

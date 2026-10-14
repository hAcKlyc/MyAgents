import {afterEach,beforeEach,expect,it,vi} from 'vitest';
import {randomUUID} from 'node:crypto';
const f=vi.hoisted(()=>({
  admission:vi.fn(),registry:vi.fn(),metadata:vi.fn(),list:vi.fn(),save:vi.fn(),publish:vi.fn(),claim:vi.fn(),snapshot:vi.fn(),begin:vi.fn(),read:vi.fn(),finish:vi.fn(),adopt:vi.fn(),stop:vi.fn(),send:vi.fn(),permission:vi.fn(),question:vi.fn(),plan:vi.fn(),ctx:vi.fn(),turn:vi.fn(),pending:vi.fn(),mcp:vi.fn(),shown:vi.fn(),materialize:vi.fn(),config:vi.fn(),visible:vi.fn(),ready:vi.fn(),interactions:vi.fn(),
}));
vi.mock('../utils/agent-workspace-identity',()=>({resolvePersistedAgentWorkspaceRegistry:f.registry}));
vi.mock('../utils/session-materialization',()=>({createMaterializedSessionMetadata:f.materialize}));
vi.mock('../utils/admin-config',()=>({resolveWorkspaceConfig:f.config}));
vi.mock('../utils/managed-codex-readiness',()=>({isManagedCodexProviderReady:f.ready}));
vi.mock('../admin-api',()=>({handleAgentShow:f.shown}));
vi.mock('../SessionStore',()=>({getSessionMetadata:f.metadata,getSessionsByAgentDir:f.list,isHistoryVisibleSession:f.visible,saveSessionMetadata:f.save,publishSessionForHandoff:f.publish,claimPreparedSessionForTurnAdmission:f.claim}));
vi.mock('../session-engine',()=>({runProcessUpdateAdmission:f.admission,stopActiveTurn:f.stop,getSessionEngine:()=>({getCurrentSessionContext:f.ctx,getExecutionTurnId:f.turn,getStreamReplaySnapshot:f.pending,sendDesktopMessage:f.send,respondPermission:f.permission,respondAskUserQuestion:f.question,respondPlanApproval:f.plan,updateMcpServers:f.mcp})}));
vi.mock('./projection',()=>({buildRemoteSnapshot:f.snapshot,projectRemoteInteractions:f.interactions}));
vi.mock('./receipts',async()=>{
  const actual=await vi.importActual<typeof import('./receipts')>('./receipts');
  return {...actual,createRemoteReceiptOwner:()=>({begin:f.begin,read:f.read,finish:f.finish,adoptPrepared:f.adopt})};
});
import {handleDesktopRemoteSession,prepareDesktopRemoteSession} from './desktop';
const agent={agentId:'agent',workspacePath:'/workspace',agent:{id:'agent',enabled:true,name:'Agent'},project:{id:'p',path:'/workspace'}};
const mutation=()=>({kind:'send' as const,agentId:'agent',sessionId:'session',operationId:randomUUID(),text:'hi'});
function receipt(request:ReturnType<typeof mutation>,status='processing'){return {kind:'receipt',agentId:request.agentId,operationId:request.operationId,sessionId:request.sessionId,status,code:null}}
beforeEach(()=>{
  vi.resetAllMocks();f.admission.mockImplementation(async operation=>operation());vi.stubEnv('MYAGENTS_SIDECAR_GENERATION','gen');
  f.registry.mockResolvedValue({agentProjections:[agent],diagnostics:[],config:{}});
  f.metadata.mockReturnValue({id:'session',agentDir:'/workspace',title:'session'});f.visible.mockReturnValue(true);
  f.ctx.mockReturnValue({sessionId:'session',workspacePath:'/workspace'});f.turn.mockReturnValue('turn');
  f.config.mockReturnValue({mcpServers:[],permissionMode:'auto',model:'model'});f.mcp.mockResolvedValue({success:true});
  f.begin.mockImplementation(async request=>({fresh:true,receipt:receipt(request)}));f.finish.mockResolvedValue({});
  f.send.mockResolvedValue({success:true,dispatchAcceptance:Promise.resolve({accepted:true})});
  f.pending.mockReturnValue({pendingInteractiveRequests:[]});f.interactions.mockReturnValue([]);
  f.publish.mockResolvedValue(true);
});
afterEach(()=>vi.unstubAllEnvs());
async function settle(){await vi.waitFor(()=>expect(f.finish).toHaveBeenCalled())}
it('refuses disabled Agent, cross-workspace session and obsolete envelope generation before admission',async()=>{
  const request=mutation();
  f.registry.mockResolvedValueOnce({agentProjections:[{...agent,agent:{...agent.agent,enabled:false}}],diagnostics:[],config:{}});
  expect(await handleDesktopRemoteSession({request,generation:'gen'},'session')).toMatchObject({code:'REMOTE_AGENT_UNAVAILABLE'});
  f.metadata.mockReturnValueOnce({id:'session',agentDir:'/other'});
  expect(await handleDesktopRemoteSession({request,generation:'gen'},'session')).toMatchObject({code:'REMOTE_SESSION_NOT_FOUND'});
  expect(await handleDesktopRemoteSession({request,generation:'old'},'session')).toMatchObject({code:'REMOTE_SESSION_OWNER_CHANGED'});
  expect(f.send).not.toHaveBeenCalled();expect(f.begin).not.toHaveBeenCalled();
});
it('returns processing before actual dispatch acceptance and does not repeat accepted requests',async()=>{
  const request=mutation();let complete!:(v:{accepted:boolean})=>void;
  f.send.mockResolvedValue({success:true,dispatchAcceptance:new Promise(resolve=>{complete=resolve})});
  expect(await handleDesktopRemoteSession({request,generation:'gen'},'session')).toMatchObject({success:true,data:{status:'processing'}});
  await vi.waitFor(()=>expect(f.send).toHaveBeenCalledTimes(1));expect(f.finish).not.toHaveBeenCalled();
  f.begin.mockResolvedValueOnce({fresh:false,receipt:receipt(request,'accepted')});
  expect(await handleDesktopRemoteSession({request,generation:'gen'},'session')).toMatchObject({data:{status:'accepted'}});expect(f.send).toHaveBeenCalledTimes(1);
  complete({accepted:true});await settle();expect(f.finish).toHaveBeenCalledWith(request,'accepted','session');
});
it.each(['respond','stop'] as const)('rejects obsolete request generation for %s even with valid current envelope and turn',async kind=>{
  const request={...mutation(),kind,generation:'old',turnId:'turn',...(kind==='respond'?{requestId:'permission',interaction:'permission',approved:true}:{})};
  delete (request as {text?:string}).text;
  await handleDesktopRemoteSession({request,generation:'gen'},'session');await settle();
  expect(f.finish).toHaveBeenCalledWith(request,'rejected','session','REMOTE_SESSION_INTERACTION_EXPIRED');
  expect(f.stop).not.toHaveBeenCalled();expect(f.permission).not.toHaveBeenCalled();
});
it('acknowledges an existing Session queued send so the current turn can still receive approvals',async()=>{
  const request=mutation();f.send.mockResolvedValue({success:true,queued:true,queueId:'queue-1',dispatchAcceptance:new Promise(()=>{})});
  expect(await handleDesktopRemoteSession({request,generation:'gen'},'session')).toMatchObject({data:{status:'processing'}});
  await settle();expect(f.finish).toHaveBeenCalledWith(request,'accepted','session');
});
it('requires actual complete pending approval; cannot invent permanent permissions',async()=>{
  const request={kind:'respond' as const,agentId:'agent',sessionId:'session',operationId:randomUUID(),generation:'gen',turnId:'turn',requestId:'r',interaction:'permission' as const,approved:true};
  f.interactions.mockReturnValue([{requestId:'r',interaction:'permission',actionable:false,questions:[]}]);
  await handleDesktopRemoteSession({request,generation:'gen'},'session');await settle();
  expect(f.finish).toHaveBeenCalledWith(request,'rejected','session','REMOTE_INTERACTION_REQUIRES_TARGET_UI');expect(f.permission).not.toHaveBeenCalled();
});
it('prepares a frozen original Session before creation and repeated start returns receipt without new metadata',async()=>{
  const request={kind:'start' as const,agentId:'agent',operationId:randomUUID(),text:'hello'};
  f.shown.mockResolvedValue({success:true,data:{effectiveDefaults:{runtime:'codex',runtimeSource:'system-cli'}}});f.materialize.mockReturnValue({id:'new',agentDir:'/workspace',title:'hello',transcriptFormat:2});f.ready.mockReturnValue(false);
  const result=await prepareDesktopRemoteSession({request});expect(result).toMatchObject({success:true,data:{agentId:'agent',workspacePath:'/workspace'}});
  expect(f.materialize).toHaveBeenCalledWith(expect.objectContaining({runtimeOverride:'codex',runtimeSourceOverride:'system-cli',agent:agent.agent}));
  expect(f.save).toHaveBeenCalledWith(expect.objectContaining({materializationState:'prepared',materializationSourceSessionId:request.operationId}));
  expect(f.publish).toHaveBeenCalledTimes(1);
  f.begin.mockResolvedValueOnce({fresh:false,receipt:{kind:'receipt',agentId:'agent',operationId:request.operationId,sessionId:'new',status:'unconfirmed',code:null}});
  expect(await prepareDesktopRemoteSession({request})).toMatchObject({data:{receipt:{status:'unconfirmed'}}});expect(f.save).toHaveBeenCalledTimes(1);
});
it('bounds UTF8 list payloads and continues pagination at the last item actually returned',async()=>{
  f.list.mockReturnValue(Array.from({length:30},(_,i)=>({id:`session-${i}`,lastActiveAt:'2026-10-15',title:'中'.repeat(256),lastMessagePreview:'中'.repeat(512)})));
  const result=await handleDesktopRemoteSession({request:{kind:'list',agentId:'agent',limit:30},generation:'gen'},'global');
  expect(result.success).toBe(true);
  if(result.success&&'data' in result&&result.data.kind==='list'){
    expect(Buffer.byteLength(JSON.stringify(result))).toBeLessThan(48*1024);
    expect(result.data.items.length).toBeLessThan(30);expect(result.data.hasMore).toBe(true);
    expect(result.data.nextBefore).toBe(result.data.items.at(-1)!.sessionId);
  }
});

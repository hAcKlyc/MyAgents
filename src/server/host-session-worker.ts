import { createServer, type Server } from 'node:http';
import { Readable } from 'node:stream';
import { isHostProviderId } from '../shared/hostProviderConfig';
import { randomUUID } from 'node:crypto';
import { isAbsolute, resolve } from 'node:path';
import { format } from 'node:util';
import { bootstrapFromEnvironment } from '../host/bot-session-bootstrap';
import { rejectCloudModelRetry } from '../host/cloud-model';
import { remoteSessionRequestSchema } from '../shared/remoteSession';
import { isProjectArchived, isProjectVisibleToUser } from '../shared/config-types';
import { assertOrdinaryRemoteAgent } from '../host/remote-session';
import { settleHostSessionAdmission } from '../host/remote-admission';
import { isHostSessionRequest, type HostSessionMessage, type HostSessionRequest } from './host-session-protocol';
import { installHostSessionCredential, installHostCloudModelCredential, resolveHostCloudModelProvider } from './utils/host-credentials';

// The supervisor is the only process owner. This entry owns exactly one existing
// Product Session binding, and never implements a second SDK or transcript store.
let initializationStage: 'admission' | 'credential' | 'modules' | 'session' | 'route' | 'restore' = 'admission';
async function main(): Promise<void> {
  const bot = bootstrapFromEnvironment();
  const generation = process.env.MYAGENTS_HOST_GENERATION;
  const workspace = process.env.MYAGENTS_HOST_WORKSPACE;
  if (!generation || !workspace || !isAbsolute(workspace) || !process.send) {
    throw new Error('Host worker requires IPC, generation and an absolute workspace');
  }
  if (bot && (resolve(bot.workspace) !== resolve(workspace) || process.env.MYAGENTS_HOST_SESSION_ID)) throw new Error('BOT_BOOTSTRAP_INVALID');
  let birthCredential: string | undefined;
  if (process.env.MYAGENTS_HOST_CREDENTIAL_SOURCE === 'supervisor-ipc') {
    initializationStage = 'credential';
    birthCredential = await new Promise<string | undefined>((resolveCredential, reject) => {
      const timer = setTimeout(() => { cleanup(); reject(new Error('Host credential initialization timed out')); }, 10_000);
      const onMessage = (raw: unknown) => {
        if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return;
        const value = raw as Record<string, unknown>;
        if (value.type !== 'host-provider-snapshot') return;
        cleanup();
        if (Object.keys(value).length !== 4 || value.generation !== generation
          || !(bot?.cloud_model ? value.providerId === bot.provider_id : isHostProviderId(value.providerId)) || value.providerId !== process.env.MYAGENTS_HOST_PROVIDER_ID
          || !(value.credential === null || (typeof value.credential === 'string'
            && value.credential.trim().length > 0 && Buffer.byteLength(value.credential, 'utf8') <= 16 * 1024
            && !/[\r\n\0]/.test(value.credential)))) {
          reject(new Error('Host credential initialization is invalid')); return;
        }
        resolveCredential(value.credential === null ? undefined : value.credential as string);
      };
      const onDisconnect = () => { cleanup(); reject(new Error('Host supervisor disconnected')); };
      function cleanup() { clearTimeout(timer); process.off('message', onMessage); process.off('disconnect', onDisconnect); }
      process.on('message', onMessage); process.once('disconnect', onDisconnect);
      process.send?.({ type: 'credential-needed', generation }, undefined, undefined, (error: Error | null) => {
        if (error) { cleanup(); reject(new Error('Host credential initialization transport failed')); }
      });
    });
    if(bot?.cloud_model){
      if(!birthCredential)throw new Error('BOT_MODEL_CREDENTIAL_INVALID');
      installHostCloudModelCredential(bot.cloud_model,birthCredential);
    }else installHostSessionCredential(birthCredential, process.env.MYAGENTS_HOST_PROVIDER_ID);
  }
  const credentials = new Set<string>([process.env.ANTHROPIC_API_KEY, process.env.ANTHROPIC_AUTH_TOKEN, process.env.CLAUDE_CODE_OAUTH_TOKEN].filter((value): value is string => Boolean(value)));
  if (birthCredential) credentials.add(birthCredential);
  birthCredential = undefined;
  const redactText = (text: string) => {
    for (const credential of credentials) text = text.split(credential).join('[redacted]');
    return text;
  };
  const redact = (value: unknown): unknown => {
    if (typeof value === 'string') return redactText(value);
    if (Array.isArray(value)) return value.map(redact);
    if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, item]) =>
      [key, /^(apiKey|apiKeys|providerApiKeys|providerEnvJson|accessToken|access_token|refreshToken|authorization)$/i.test(key) ? '[redacted]' : redact(item)]));
    return value;
  };
  // stdout is not a protocol channel; keep all upstream diagnostics on stderr.
  for (const name of ['log', 'info', 'warn', 'error', 'debug'] as const) {
    console[name] = (...values: unknown[]) => { process.stderr.write(`${redactText(format(...values.map(redact)))}\n`); };
  }
  process.env.MYAGENTS_SIDECAR_ROLE = 'session';
  process.env.MYAGENTS_HOST_MODE = '1';
  process.env.MYAGENTS_RUNTIME = 'builtin';
  initializationStage = 'modules';
  const [{ getSessionEngine }, agent, store, config, routes] = await Promise.all([
    import('./session-engine'), import('./agent-session'), import('./SessionStore'),
    import('./utils/admin-config'), import('../shared/providerRoute'),
  ]);
  const engine = getSessionEngine();
  const existingId = process.env.MYAGENTS_HOST_SESSION_ID?.trim();
  const existing = existingId ? store.getSessionMetadata(existingId) : null;
  if (existingId && !existing) throw new Error('Host Session does not exist');
  if (existing && (existing.runtimeBindingCompatibility || (existing.runtime && existing.runtime !== 'builtin')
    || (existing.runtimeBinding && (existing.runtimeBinding.family !== 'integrated' || existing.runtimeBinding.id !== 'claude-agent-sdk')))) {
    throw new Error('Host worker only supports compatible builtin Sessions');
  }
  if (existing && resolve(existing.agentDir) !== resolve(workspace)) throw new Error('Session workspace does not match Host workspace');
  initializationStage = 'session';
  await agent.initializeAgent(workspace, undefined, existingId, { preWarmDisabled: true });
  if (engine.kind !== 'builtin') throw new Error('Host worker only supports builtin Sessions');
  if (!existing) {
    initializationStage = 'route';
    const model = bot?.model ?? process.env.MYAGENTS_HOST_MODEL?.trim();
    const providerId = bot?.provider_id ?? process.env.MYAGENTS_HOST_PROVIDER_ID?.trim();
    if (!model || !providerId) throw new Error('New Host Session requires an explicit Provider/model route');
    const remoteBirth = process.env.MYAGENTS_HOST_REMOTE_AGENT_BIRTH === '1' ? config.resolveWorkspaceConfig(workspace):undefined;
    const route = remoteBirth?.providerRoute ?? routes.createConcreteProviderRoute(providerId, model);
    if (!routes.isConcreteProviderRoute(route) || route.providerId !== providerId || route.model !== model) throw new Error('Host Agent birth provider identity changed');
    const prepared = await engine.materializePendingDesktopSession({
      workspacePath: workspace, phase: 'prepare',
      ...(bot ? {birthSnapshot:{hostBotBinding:{botId:bot.snapshot.bot_id,runGeneration:bot.run_generation}}}:{}),
      snapshotPatch: { providerRoute: route, providerId, model, permissionMode: remoteBirth?.permissionMode ?? 'custom',
        mcpEnabledServers: remoteBirth?.mcpServers.map(item=>item.id) ?? [], ...(remoteBirth ? {}:{enabledPluginIds:[]}), enabledOfficialToolIds: remoteBirth?.enabledOfficialToolIds ?? [],
        ...(remoteBirth?.reasoningEffort ? {reasoningEffort:remoteBirth.reasoningEffort}:{}) },
    });
    if (!prepared.success || !prepared.sessionId) throw new Error('Host Session preparation failed');
    const committed = await engine.materializePendingDesktopSession({
      workspacePath: workspace, phase: 'commit', preparedSessionId: prepared.sessionId,
    });
    if (!committed.success) throw new Error('Host Session commit failed');
  }
  const boundSessionId = engine.getCurrentSessionContext().sessionId;
  if (!boundSessionId) throw new Error('Host Session binding is unavailable');
  const sessionId: string = boundSessionId;
  const workspacePath: string = workspace;
  if (bot) {
    const ownedMetadata=store.getSessionMetadata(sessionId);
    if (!ownedMetadata || !routes.isConcreteProviderRoute(ownedMetadata.providerRoute) || ownedMetadata.providerRoute.providerId!==bot.provider_id || ownedMetadata.providerRoute.model!==bot.model || resolve(ownedMetadata.agentDir)!==resolve(workspace)) throw new Error('BOT_RUN_BINDING_MISMATCH');
    if (ownedMetadata.hostBotBinding && (ownedMetadata.hostBotBinding.botId!==bot.snapshot.bot_id || ownedMetadata.hostBotBinding.runGeneration!==bot.run_generation)) throw new Error('BOT_RUN_BINDING_MISMATCH');
    // An old exact-owner birth may lack this marker; stamp only after checking
    // the protected bootstrap, actual engine binding, workspace and route.
    if (!ownedMetadata.hostBotBinding) await store.saveSessionMetadata({...ownedMetadata,hostBotBinding:{botId:bot.snapshot.bot_id,runGeneration:bot.run_generation}});
  }
  const transcript = store.getActiveSessionTranscript(sessionId);
  if (transcript && !await transcript.writer.flush()) throw new Error('Host Session birth could not be durably saved');
  // --no-pre-warm deliberately skips startup discovery. Recover configuration
  // from the owning snapshot, without replacing it with supervisor defaults.
  const metadata = store.getSessionMetadata(sessionId);
  initializationStage = 'restore';
  const restored = config.resolveWorkspaceConfig(workspace, metadata, { includeMcp: !bot });
  if (restored.providerEnv?.apiKey) credentials.add(restored.providerEnv.apiKey);
  if ((existing || bot) && metadata) await agent.restoreBuiltinConfigFromOwnedMetadata(metadata);
  // Restore the recorded permission mode for state inspection. A send below
  // still requires custom; a stronger recorded mode is never silently widened.
  await engine.updateMcpServers(bot ? [] : restored.mcpServers);
  await engine.updateEnabledPluginIds(bot ? [] : metadata?.enabledPluginIds ?? []);
  await engine.updateOfficialToolIds(bot ? [] : metadata?.enabledOfficialToolIds ?? []);
  if (restored.reasoningEffort) await engine.updateReasoningEffort(restored.reasoningEffort);
  const send = (message: HostSessionMessage) => { if (process.connected) process.send?.(redact(message)); };
  let loopbackBridge: Server | undefined;
  let cloudModelOutcomeUnknown=false;
  async function ensureLoopbackBridge() {
    if (loopbackBridge) return;
    const [{createBridgeHandler},{lookupBridge,hasBridge},{registerBridgeSeedFn}]=await Promise.all([import('./openai-bridge'),import('./openai-bridge/bridge-registry'),import('./bridge-cache')]);
    const handler=createBridgeHandler({workspacePath:workspace,logger:null,getUpstreamConfig:async request=> {
      const token=new URL(request.url).pathname.match(/^\/bridge\/([^/]+)\/v1\/messages(?:\/count_tokens)?$/)?.[1];
      const cfg=token ? await lookupBridge(token,request) : undefined;
      if (!cfg) throw new Error('Host bridge token is unavailable');
      const aliases=cfg.modelAliases;
      const modelMapping=aliases ? (model:string)=> {
        if (!model.startsWith('claude')) return undefined;
        if (model.includes('fable')) return aliases.fable ?? cfg.model;
        if (model.includes('sonnet')) return aliases.sonnet ?? cfg.model;
        if (model.includes('opus')) return aliases.opus ?? cfg.model;
        if (model.includes('haiku')) return aliases.haiku ?? cfg.model;
        return cfg.model;
      } : undefined;
      return {...cfg,modelMapping};
    }});
    registerBridgeSeedFn(entries=>handler.seedThoughtSignatures(entries));
    const server=createServer(async (incoming,outgoing)=> {
      const abort=new AbortController();outgoing.once('close',()=>abort.abort());
      try {
        if (incoming.method !== 'POST' || !/^\/bridge\/[^/]+\/v1\/messages(?:\/count_tokens)?$/.test(new URL(incoming.url ?? '/', 'http://127.0.0.1').pathname)) {outgoing.writeHead(404).end();return;}
        if (bot?.cloud_model && (cloudModelOutcomeUnknown || rejectCloudModelRetry(bot.provider_id,incoming.headers['x-stainless-retry-count']))) {
          outgoing.writeHead(409,{'content-type':'application/json'}).end(JSON.stringify({type:'error',error:{type:'invalid_request_error',message:'BOT_MODEL_RETRY_REJECTED'}}));return;
        }
        const buffers:Buffer[]=[];let length=0;
        for await (const chunk of incoming) {const bytes=Buffer.from(chunk);length+=bytes.length;if (length>16*1024*1024) {outgoing.writeHead(413).end();return;}buffers.push(bytes);}
        const headers=new Headers();for (const [key,value] of Object.entries(incoming.headers)) if (value !== undefined) headers.set(key,Array.isArray(value)?value.join(','):value);
        const request=new Request(`http://127.0.0.1${incoming.url}`,{method:'POST',headers,body:Buffer.concat(buffers),signal:abort.signal});
        const countMatch=new URL(request.url).pathname.match(/^\/bridge\/([^/]+)\/v1\/messages\/count_tokens$/);
        if(countMatch){
          // Match the original sidecar count_tokens owner: OpenAI has no
          // equivalent endpoint, so this is a local estimate, never a turn.
          if(!hasBridge(countMatch[1])){outgoing.writeHead(400).end();return;}
          let estimate=1024;
          try{const value=await request.json() as {messages?:unknown[];system?:unknown;tools?:unknown[]};
            estimate=Math.max(1,Math.ceil((JSON.stringify(value.messages??[]).length+JSON.stringify(value.system??'').length+JSON.stringify(value.tools??[]).length)/4));
          }catch{/* The original owner uses a conservative estimate on malformed count input. */}
          outgoing.writeHead(200,{'content-type':'application/json'}).end(JSON.stringify({input_tokens:estimate}));return;
        }

        // Native SDK has an outer retry loop which may reset the HTTP retry
        // count. Once a sent cloud request has an uncertain outcome, close
        // this generation's model admission rather than charging it again.
        let response:Response;
        try{response=await handler(request);}catch{if(bot?.cloud_model)cloudModelOutcomeUnknown=true;throw new Error('Host bridge outcome is unconfirmed');}
        if(bot?.cloud_model&&response.status>=500)cloudModelOutcomeUnknown=true;
        outgoing.writeHead(response.status,Object.fromEntries(response.headers));
        if (response.body) {
          const body=Readable.fromWeb(response.body as Parameters<typeof Readable.fromWeb>[0]);
          body.once('error',()=>{if(bot?.cloud_model)cloudModelOutcomeUnknown=true;outgoing.destroy();});
          outgoing.once('close',()=>{if(bot?.cloud_model&&!outgoing.writableEnded)cloudModelOutcomeUnknown=true;});
          body.pipe(outgoing);
        }else outgoing.end();
      } catch {if (!outgoing.headersSent) outgoing.writeHead(502);outgoing.end();}
    });
    await new Promise<void>((yes,no)=> {server.once('error',no);server.listen(0,'127.0.0.1',()=>{server.off('error',no);yes();});});
    const address=server.address();if (!address || typeof address === 'string') {server.close();throw new Error('Host loopback bridge is unavailable');}
    loopbackBridge=server;agent.setSidecarPort(address.port);
  }
  let closing = false;
  let serial = Promise.resolve();
  const shutdown = async () => {
    if (closing) return;
    closing = true;
    await engine.stopTurn();
    await store.drainSessionTranscripts();
    loopbackBridge?.closeAllConnections();
    if (loopbackBridge) await new Promise<void>(resolveClose=>loopbackBridge!.close(()=>resolveClose()));
  };
  async function operate(request: HostSessionRequest): Promise<unknown> {
    const args = request.args ?? {};
    switch (request.operation) {
      case 'remote': {
        if (bot) throw new Error('REMOTE_SESSION_PRIVATE');
        const remote = remoteSessionRequestSchema.parse(args.remoteSession);
        if (!('sessionId' in remote) || remote.sessionId !== sessionId) throw new Error('REMOTE_SESSION_TARGET_CHANGED');
        if (remote.kind === 'get') {
          const { buildRemoteSnapshot } = await import('./remote-session/projection');
          return buildRemoteSnapshot(remote.agentId, sessionId, generation!, remote.limit, remote.before);
        }
        if (remote.kind === 'send') {
          if (process.env.MYAGENTS_HOST_EXECUTION_AUTHORIZED !== '1') throw new Error('REMOTE_SESSION_EXECUTION_NOT_AUTHORIZED');
          validateRemoteAgent(remote.agentId);
          return operate({ ...request, operation: 'send', args: {text: remote.text, clientRequestId: remote.operationId,remote:true,remoteAgentId:remote.agentId} });
        }
        if (remote.kind === 'respond' || remote.kind === 'stop') {
          if (remote.generation !== generation || remote.turnId !== engine.getExecutionTurnId()) throw new Error('REMOTE_SESSION_INTERACTION_EXPIRED');
          validateRemoteAgent(remote.agentId);
          if (remote.kind === 'stop') return operate({...request,operation:'stop',args:{queueId:remote.turnId}});
          const { buildRemoteSnapshot } = await import('./remote-session/projection');
          const snapshot = await buildRemoteSnapshot(remote.agentId, sessionId, generation!, 1);
          const interaction=snapshot.interactions.find(item => item.requestId === remote.requestId && item.interaction === remote.interaction && item.generation === remote.generation && item.turnId === remote.turnId);
          if (!interaction || (remote.approved && !interaction.actionable)) throw new Error('REMOTE_SESSION_INTERACTION_EXPIRED');
          if (remote.interaction === 'question' && remote.approved && (!remote.answers || interaction.questions.some(question=>!remote.answers?.[question.answerKey]?.trim()) || Object.keys(remote.answers).some(key=>!interaction.questions.some(question=>question.answerKey===key)))) throw new Error('REMOTE_SESSION_ANSWERS_INVALID');
          return operate({...request,operation:'permission',args:{requestId:remote.requestId,kind:remote.interaction,
            approved:remote.approved,decision:remote.approved ? 'allow_once':'deny',answers:remote.approved ? remote.answers ?? {} : null}});
        }
        throw new Error('REMOTE_SESSION_OPERATION_UNSUPPORTED');
      }
      case 'describe': return { sessionId, workspacePath: workspace, runtime: 'builtin',
        executionAuthorized: bot?.cloud_model ? bot.cloud_model.expires_at > Date.now()/1000 : process.env.MYAGENTS_HOST_EXECUTION_AUTHORIZED === '1',
        supportedProviderProtocols: ['anthropic','openai'], unsupportedCapabilities: ['agent-network', 'task', 'goal', 'browser-host', 'cross-session-inbox'],
        config: engine.getSessionConfigSnapshot() };
      case 'state': return { sessionId, ...engine.getLiveSessionState(),
        queueId: engine.getExecutionTurnId(), replay: engine.getStreamReplaySnapshot(), terminal: engine.getSessionCompletionTerminal() };
      case 'result': return { ...await engine.getLatestAssistantResult(), terminal: engine.getSessionCompletionTerminal() };
      case 'send': {
        if (bot && !bot.cloud_model) throw new Error('Delegated Bot v1 supports lifecycle only; model invocation is not authorized');
        if (!bot?.cloud_model && process.env.MYAGENTS_HOST_EXECUTION_AUTHORIZED !== '1') throw new Error('Model execution requires explicit Host execution authorization');
        if (typeof args.text !== 'string' || !args.text.trim() || args.text.length > 100_000) throw new Error('A bounded non-empty text is required');
        if(bot?.cloud_model)resolveHostCloudModelProvider(bot.provider_id,bot.model);
        const snapshot = store.getSessionMetadata(sessionId);
        if (!routes.isConcreteProviderRoute(snapshot?.providerRoute)) throw new Error('Session Provider/model route is unavailable');
        const provider = config.materializeProviderRouteEnv(snapshot.providerRoute);
        if (provider?.apiKey) credentials.add(provider.apiKey);
        if (provider?.apiProtocol === 'openai') await ensureLoopbackBridge();
        if (snapshot.providerRoute.kind === 'provider' && !provider) throw new Error('Session Provider credential is unavailable');
        const result = await engine.sendDesktopMessage({
          text: args.text, sessionId, workspacePath, scenario: { type: 'desktop' },
          providerRoute: snapshot.providerRoute, permissionMode: args.remote === true ? snapshot.permissionMode ?? 'custom':'custom',
          clientRequestId: typeof args.clientRequestId === 'string' ? args.clientRequestId : randomUUID(), turnBoundaryOnly: true,
          beforeDispatch: async () => {
            if (typeof args.remoteAgentId==='string') {
              try {validateRemoteAgent(args.remoteAgentId);} catch {return {accepted:false,error:'REMOTE_SESSION_AGENT_UNAVAILABLE'};}
            }
            return { accepted: !closing, ...(closing ? { error: 'Host worker is shutting down' } : {}) };
          },
          onTerminal: outcome => { send({ type: 'terminal', generation: generation!, sessionId, outcome }); },
        });
        return settleHostSessionAdmission(args.remote===true,result);
      }
      case 'permission': {
        if (typeof args.requestId !== 'string') throw new Error('Permission requestId is required');
        let accepted: boolean;
        if (args.kind === 'question') {
          if (args.answers !== null && (typeof args.answers !== 'object' || Array.isArray(args.answers))) throw new Error('Question answers are required');
          accepted = await engine.respondAskUserQuestion(args.requestId, args.answers as Parameters<typeof engine.respondAskUserQuestion>[1]);
        } else if (args.kind === 'plan') {
          if (typeof args.approved !== 'boolean') throw new Error('Plan approval must be explicit');
          accepted = await engine.respondPlanApproval(args.requestId, args.approved, typeof args.feedback === 'string' ? args.feedback : undefined);
        } else {
          if (args.decision !== 'deny' && args.decision !== 'allow_once') throw new Error('Permission decision must be deny or allow_once');
          accepted = await engine.respondPermission(args.requestId, args.decision);
        }
        if (!accepted) throw new Error('Interactive request is no longer pending');
        return { accepted };
      }
      case 'stop': {
        if (args.queueId !== undefined && args.queueId !== engine.getExecutionTurnId()) throw new Error('Session stop target is no longer active');
        return engine.stopTurn();
      }
      case 'shutdown': await shutdown(); return { stopped: true };
    }
  }
  function validateRemoteAgent(agentId:string):void {
    assertOrdinaryRemoteAgent(agentId,config.loadConfig({strict:true}).hostBotDelegationsV1);
    const registered=config.findProjectAgentByWorkspacePath(workspace!);
    const project=config.loadProjects({strict:true}).find(item=>item.agentId===agentId);
    if (!registered || registered.id!==agentId || !registered.enabled || !project || !isProjectVisibleToUser(project) || isProjectArchived(project) || resolve(project.path)!==resolve(workspace!)) throw new Error('REMOTE_SESSION_AGENT_UNAVAILABLE');
  }
  process.on('message', (value: unknown) => {
    if (!isHostSessionRequest(value)) return;
    if (value.generation !== generation) {
      send({ type: 'reply', generation: generation!, id: value.id, ok: false, error: 'Stale Host generation' });
      return;
    }
    const handle = async () => {
      if (closing) { send({ type: 'reply', generation: generation!, id: value.id, ok: false, error: 'Host worker is shutting down' }); return; }
      try {
        const data = await operate(value);
        send({ type: 'reply', generation: generation!, id: value.id, ok: true, data });
        if (value.operation === 'shutdown') setImmediate(() => process.exit(0));
      } catch (error) {
        // Only this entry's fixed validation messages may cross IPC. Provider
        // and SDK errors may carry bearer material and remain server diagnostics.
        const message = error instanceof Error ? error.message : '';
        const safe = /^(REMOTE_SESSION_[A-Z_]+$|BOT_MODEL_NOT_AUTHORIZED$|Delegated Bot v1|Model execution requires|A bounded|Session Provider|OpenAI protocol requires|Session message admission|Session dispatch|Permission |Question |Plan |Interactive )/.test(message);
        send({ type: 'reply', generation: generation!, id: value.id, ok: false, error: safe ? message : 'Host Session operation failed; inspect worker diagnostics' });
      }
    };
    // Human responses and Stop must remain reachable while a send is waiting
    // for dispatch admission; serializing them behind that promise deadlocks.
    if (value.operation === 'send' || (value.operation === 'remote' && (value.args?.remoteSession as {kind?:unknown}|undefined)?.kind === 'send')) serial = serial.then(handle);
    else void handle();
  });
  for (const signal of ['SIGTERM', 'SIGINT'] as const) process.on(signal, () => { void shutdown().finally(() => process.exit(0)); });
  process.on('disconnect', () => { void shutdown().finally(() => process.exit(0)); });
  send({ type: 'ready', generation, sessionId, ...(bot ? {bot: {bot_id: bot.snapshot.bot_id, agent_id: bot.snapshot.agent_id, binding_generation: bot.snapshot.binding_generation, session_id: sessionId, run_generation: bot.run_generation, snapshot_hash: bot.snapshot.snapshot_hash, runtime: 'builtin' as const}} : {}) });
}

void main().catch(() => { process.stderr.write(`Host Session worker initialization failed (${initializationStage})\n`); process.exit(1); });

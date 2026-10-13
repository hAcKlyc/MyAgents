import { randomUUID } from 'node:crypto';
import { isAbsolute, resolve } from 'node:path';
import { format } from 'node:util';
import { isHostSessionRequest, type HostSessionMessage, type HostSessionRequest } from './host-session-protocol';
import { installHostSessionCredential } from './utils/host-credentials';

// The supervisor is the only process owner. This entry owns exactly one existing
// Product Session binding, and never implements a second SDK or transcript store.
let initializationStage: 'admission' | 'credential' | 'modules' | 'session' | 'route' | 'restore' = 'admission';
async function main(): Promise<void> {
  const generation = process.env.MYAGENTS_HOST_GENERATION;
  const workspace = process.env.MYAGENTS_HOST_WORKSPACE;
  if (!generation || !workspace || !isAbsolute(workspace) || !process.send) {
    throw new Error('Host worker requires IPC, generation and an absolute workspace');
  }
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
          || value.providerId !== 'moonshot-coding'
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
    installHostSessionCredential(birthCredential);
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
      [key, /^(apiKey|apiKeys|providerApiKeys|providerEnvJson|accessToken|refreshToken|authorization)$/i.test(key) ? '[redacted]' : redact(item)]));
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
    const model = process.env.MYAGENTS_HOST_MODEL?.trim();
    const providerId = process.env.MYAGENTS_HOST_PROVIDER_ID?.trim();
    if (!model || !providerId) throw new Error('New Host Session requires an explicit Provider/model route');
    const route = routes.createConcreteProviderRoute(providerId, model);
    const prepared = await engine.materializePendingDesktopSession({
      workspacePath: workspace, phase: 'prepare',
      snapshotPatch: { providerRoute: route, providerId, model, permissionMode: 'custom',
        mcpEnabledServers: [], enabledPluginIds: [], enabledOfficialToolIds: [] },
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
  const transcript = store.getActiveSessionTranscript(sessionId);
  if (transcript && !await transcript.writer.flush()) throw new Error('Host Session birth could not be durably saved');
  // --no-pre-warm deliberately skips startup discovery. Recover configuration
  // from the owning snapshot, without replacing it with supervisor defaults.
  const metadata = store.getSessionMetadata(sessionId);
  initializationStage = 'restore';
  const restored = config.resolveWorkspaceConfig(workspace, metadata, { includeMcp: true });
  if (restored.providerEnv?.apiKey) credentials.add(restored.providerEnv.apiKey);
  if (existing && metadata) await agent.restoreBuiltinConfigFromOwnedMetadata(metadata);
  // Restore the recorded permission mode for state inspection. A send below
  // still requires custom; a stronger recorded mode is never silently widened.
  await engine.updateMcpServers(restored.mcpServers);
  await engine.updateEnabledPluginIds(metadata?.enabledPluginIds ?? []);
  await engine.updateOfficialToolIds(metadata?.enabledOfficialToolIds ?? []);
  if (restored.reasoningEffort) await engine.updateReasoningEffort(restored.reasoningEffort);
  const send = (message: HostSessionMessage) => { if (process.connected) process.send?.(redact(message)); };
  let closing = false;
  let serial = Promise.resolve();
  const shutdown = async () => {
    if (closing) return;
    closing = true;
    await engine.stopTurn();
    await store.drainSessionTranscripts();
  };
  async function operate(request: HostSessionRequest): Promise<unknown> {
    const args = request.args ?? {};
    switch (request.operation) {
      case 'describe': return { sessionId, workspacePath: workspace, runtime: 'builtin',
        executionAuthorized: process.env.MYAGENTS_HOST_EXECUTION_AUTHORIZED === '1',
        supportedProviderProtocols: ['anthropic'], unsupportedCapabilities: ['agent-network', 'task', 'goal', 'browser-host', 'cross-session-inbox'],
        config: engine.getSessionConfigSnapshot() };
      case 'state': return { sessionId, ...engine.getLiveSessionState(),
        queueId: engine.getExecutionTurnId(), replay: engine.getStreamReplaySnapshot(), terminal: engine.getSessionCompletionTerminal() };
      case 'result': return { ...await engine.getLatestAssistantResult(), terminal: engine.getSessionCompletionTerminal() };
      case 'send': {
        if (process.env.MYAGENTS_HOST_EXECUTION_AUTHORIZED !== '1') throw new Error('Model execution requires explicit Host execution authorization');
        if (typeof args.text !== 'string' || !args.text.trim() || args.text.length > 100_000) throw new Error('A bounded non-empty text is required');
        const snapshot = store.getSessionMetadata(sessionId);
        if (!routes.isConcreteProviderRoute(snapshot?.providerRoute)) throw new Error('Session Provider/model route is unavailable');
        const provider = config.materializeProviderRouteEnv(snapshot.providerRoute);
        if (provider?.apiKey) credentials.add(provider.apiKey);
        if (provider?.apiProtocol === 'openai') throw new Error('OpenAI protocol requires a Host loopback bridge; this worker supports Anthropic protocol only');
        if (snapshot.providerRoute.kind === 'provider' && !provider) throw new Error('Session Provider credential is unavailable');
        const result = await engine.sendDesktopMessage({
          text: args.text, sessionId, workspacePath, scenario: { type: 'desktop' },
          providerRoute: snapshot.providerRoute, permissionMode: 'custom',
          clientRequestId: randomUUID(), turnBoundaryOnly: true,
          beforeDispatch: async () => ({ accepted: !closing, ...(closing ? { error: 'Host worker is shutting down' } : {}) }),
          onTerminal: outcome => { send({ type: 'terminal', generation: generation!, sessionId, outcome }); },
        });
        if (!result.success) throw new Error('Session message admission failed');
        const accepted = result.dispatchAcceptance ? await result.dispatchAcceptance : undefined;
        if (accepted && !accepted.accepted) throw new Error('Session dispatch was rejected');
        return { accepted: true, queued: result.queued, queueId: result.queueId };
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
        const safe = /^(Model execution requires|A bounded|Session Provider|OpenAI protocol requires|Session message admission|Session dispatch|Permission |Question |Plan |Interactive )/.test(message);
        send({ type: 'reply', generation: generation!, id: value.id, ok: false, error: safe ? message : 'Host Session operation failed; inspect worker diagnostics' });
      }
    };
    // Human responses and Stop must remain reachable while a send is waiting
    // for dispatch admission; serializing them behind that promise deadlocks.
    if (value.operation === 'send') serial = serial.then(handle);
    else void handle();
  });
  for (const signal of ['SIGTERM', 'SIGINT'] as const) process.on(signal, () => { void shutdown().finally(() => process.exit(0)); });
  process.on('disconnect', () => { void shutdown().finally(() => process.exit(0)); });
  send({ type: 'ready', generation, sessionId });
}

void main().catch(() => { process.stderr.write(`Host Session worker initialization failed (${initializationStage})\n`); process.exit(1); });

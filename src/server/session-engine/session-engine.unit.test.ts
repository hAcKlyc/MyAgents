import { TASK_ALIGNMENT_SKILL_REQUIREMENT } from "../../shared/systemSkills";
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => {
  const state = {
    useExternal: false,
    externalActive: false,
    externalBusy: false,
    externalConversationMutation: false,
    externalProcessAlive: false,
    builtinTurnIdentity: null as { queueId: string; owner: { kind: 'goal' | 'task'; id: string } } | null,
    builtinDispatchedQueueId: null as string | null,
    externalTurnIdentity: null as { queueId: string; owner: { kind: 'goal' | 'task'; id: string } } | null,
    externalCurrentQueueId: null as string | null,
    builtinImContext: null as { senderId: string } | null,
    externalImContext: null as { senderId: string } | null,
    pendingExternalAsk: false,
    pendingExternalPlan: false,
    providerDisabled: false,
    sessionMetadata: new Map<string, Record<string, unknown>>(),
  };

  return {
    state,
    broadcast: vi.fn(),
    applyMcpOverrideAndAwaitReady: vi.fn(async () => undefined),
    cancelBuiltinImRequest: vi.fn(async () => ({ aborted: false, mode: 'unknown' as const })),
    cancelQueueItem: vi.fn<() => Promise<
      | { status: 'cancelled'; cancelledText: string }
      | { status: 'not_found' | 'not_cancelled' | 'unavailable' | 'error' }
    >>(async () => ({ status: 'not_found' as const })),
    cancelQueuedTurnsByOwner: vi.fn(async () => 0),
    enqueueUserMessage: vi.fn<(...args: unknown[]) => Promise<{
      queued: boolean;
      queueId?: string;
      isInFlight?: boolean;
      deliveryMode?: 'queue' | 'realtime' | 'turn';
      error?: string;
      dispatchAcceptance?: Promise<{ accepted: boolean; error?: string }>;
    }>>(async (...args: unknown[]) => {
      const options = args[11] as {
        queueId?: string;
        beforeUserPersistence?: () => Promise<{ accepted: boolean; error?: string }>;
        beforeDispatch?: () => Promise<{
          accepted: boolean;
          error?: string;
          validateAtCommit?: () => { accepted: boolean; error?: string };
        }>;
        onTerminal?: (outcome: {
          status: 'complete' | 'stopped';
          assistantMessagePresent: boolean;
          text: string;
          error?: string;
        }) => void;
      } | undefined;
      const persistenceAcceptance = await options?.beforeUserPersistence?.();
      if (persistenceAcceptance && !persistenceAcceptance.accepted) {
        return {
          queued: false,
          queueId: options?.queueId ?? 'q1',
          error: persistenceAcceptance.error,
        };
      }
      const dispatchAcceptance: Promise<{ accepted: boolean; error?: string }> = options?.beforeDispatch
        ? options.beforeDispatch().then(result => (
          result.accepted && result.validateAtCommit
            ? result.validateAtCommit()
            : result
        ))
        : Promise.resolve({ accepted: true });
      queueMicrotask(() => {
        void (async () => {
          const acceptance = await dispatchAcceptance;
          if (acceptance && !acceptance.accepted) {
            options?.onTerminal?.({
              status: 'stopped',
              assistantMessagePresent: false,
              text: '',
              error: acceptance.error,
            });
            return;
          }
          options?.onTerminal?.({
            status: 'complete',
            assistantMessagePresent: true,
            text: 'builtin answer',
          });
        })();
      });
      return {
        queued: true,
        queueId: options?.queueId ?? 'q1',
        isInFlight: false,
        deliveryMode: 'queue' as const,
        dispatchAcceptance,
      };
    }),
    forceExecuteQueueItem: vi.fn(async () => true),
    getAndClearLastAgentError: vi.fn<() => string | null>(() => null),
    getCurrentTurnIdentity: vi.fn(() => state.builtinTurnIdentity),
    getCurrentImBridgeTurnContext: vi.fn(() => state.builtinImContext),
    isBuiltinWaitingForUser: () => false,
  getDispatchedTurnIdentity: vi.fn(() => (
      state.builtinDispatchedQueueId
        ? { queueId: state.builtinDispatchedQueueId }
        : state.builtinTurnIdentity
    )),
    getAgentState: vi.fn<() => Record<string, unknown>>(() => ({ sessionState: 'idle', agentDir: '/workspace' })),
    getBuiltinLiveSessionSnapshot: vi.fn<() => Record<string, unknown> | null>(() => null),
    getBuiltinMcpEffectiveSnapshot: vi.fn(() => null),
    getCurrentMcpServers: vi.fn(() => [{ id: 'fs' }]),
    getAgents: vi.fn(() => ({ helper: { name: 'helper' } })),
    getLastBuiltinAssistantText: vi.fn(() => 'builtin latest'),
    getMcpServers: vi.fn(() => [{ id: 'fs' }]),
    getMessages: vi.fn<() => Array<{ id: string; role: 'user' | 'assistant'; content: string | unknown[]; timestamp: string }>>(() => []),
    getPendingInteractiveRequests: vi.fn<() => Array<{ type: string; data: unknown }>>(() => []),
    getQueueStatus: vi.fn(() => [{ id: 'q1', messagePreview: 'hello' }]),
    getSessionId: vi.fn(() => 'builtin-session'),
    getSessionModel: vi.fn(() => 'claude-sonnet'),
    getSessionPermissionMode: vi.fn(() => 'auto'),
    getSessionEnabledOfficialToolIds: vi.fn(() => ['image-understanding']),
    getSessionProviderEnv: vi.fn(() => undefined),
    getSessionProviderId: vi.fn(() => 'sensenova'),
    getSessionReasoningEffort: vi.fn(() => 'default'),
    getStreamingAssistantId: vi.fn<() => string | null>(() => null),
    getSystemInitInfo: vi.fn<() => unknown>(() => null),
    handleAskUserQuestionResponse: vi.fn(() => true),
    handleExitPlanModeResponse: vi.fn(() => true),
    handlePermissionResponse: vi.fn(() => true),
    interruptCurrentResponse: vi.fn(async () => false),
    isSessionBusy: vi.fn(() => false),
    forkSession: vi.fn(async () => ({ success: true, newSessionId: 'forked' })),
    freezeCurrentSessionMetadataForImDetach: vi.fn(async () => ({ success: true, sessionId: 'old-im-session' })),
    materializeCurrentSessionMetadataForPublishedReset: vi.fn(async () => undefined),
    materializePendingDesktopSession: vi.fn(async () => ({ success: true, sessionId: 'builtin-session' })),
    resetSession: vi.fn(async () => undefined),
    resetInteractionScenario: vi.fn(),
    requireCurrentBuiltinSkill: vi.fn(async () => undefined),
    rewindSession: vi.fn(async () => ({ success: true, content: 'rewound' })),
    setAgents: vi.fn(),
    forceReloadActiveSession: vi.fn(),
    setBackgroundAgentPermissionMode: vi.fn(),
    setInteractionScenario: vi.fn(),
    setMcpServers: vi.fn(),
    setSessionModel: vi.fn(),
    applySessionModelSelection: vi.fn(async () => ({ success: true, status: 'applied' })),
    setSessionPermissionMode: vi.fn(),
    setSessionEnabledOfficialToolIds: vi.fn(),
    setSessionProviderEnv: vi.fn(),
    setSessionReasoningEffort: vi.fn(),
    stripPlaywrightResults: vi.fn((message: string) => message),
    switchToSession: vi.fn(async () => true),
    waitForSessionIdle: vi.fn(async () => true),
    awaitExternalSessionStarting: vi.fn(async () => undefined),
    cancelExternalImRequest: vi.fn(async () => ({ aborted: false, mode: 'unknown' as const })),
    cancelExternalQueueItem: vi.fn<(queueId: string) => {
      cancelledText: string;
      promotion?: { settled: Promise<{ status: 'not-dispatched' | 'dispatched' | 'terminated' | 'termination-unconfirmed' }> };
    } | null>(() => null),
    cancelExternalQueuedTurnsByOwner: vi.fn<() => {
      count: number;
      promotion?: { settled: Promise<{ status: 'not-dispatched' | 'dispatched' | 'terminated' | 'termination-unconfirmed' }> };
    }>(() => ({ count: 0 })),
    clearExternalTurnBinding: vi.fn((queueId: string) => {
      if (state.externalCurrentQueueId === queueId) state.externalCurrentQueueId = null;
    }),
    compactExternalContext: vi.fn(async () => ({ success: true })),
    didLastTurnSucceed: vi.fn(() => true),
    enqueueExternalSendForDesktop: vi.fn(() => ({
      queued: true,
      queueId: 'xq1',
      dispatch: Promise.resolve({ queued: true }),
    })),
    enqueueExternalSendForIm: vi.fn<(...args: unknown[]) => {
      queued: boolean;
      queueId?: string;
      dispatch: Promise<{
        queued: boolean;
        error?: string;
        terminationUnconfirmed?: boolean;
      }>;
    }>(() => ({
      queued: true,
      dispatch: Promise.resolve({ queued: true }),
    })),
    forceExecuteExternalQueueItem: vi.fn(async () => true),
    getActiveRuntimeSource: vi.fn<() => 'integrated' | 'system-cli' | 'managed-provider'>(() => 'system-cli'),
    getExternalMcpEffectiveSnapshot: vi.fn(() => null),
    getActiveRuntimeType: vi.fn(() => 'codex'),
    getCurrentBoundSessionId: vi.fn<() => string | null>(() => null),
    getExternalLiveAssistantMessage: vi.fn<() => { id: string; role: 'user' | 'assistant'; content: string; timestamp: string } | null>(() => null),
    getExternalLiveSessionSnapshot: vi.fn<(targetSessionId: string) => Record<string, unknown> | null>(() => null),
    getExternalCurrentTurnIdentity: vi.fn(() => state.externalTurnIdentity),
    getExternalQueueStatus: vi.fn(() => [{ id: 'xq1', messagePreview: 'hello' }]),
    getExternalPendingInteractiveRequests: vi.fn<() => Array<{ type: string; data: Record<string, unknown> }>>(() => []),
    getExternalSessionId: vi.fn(() => 'external-session'),
    getExternalNativeSessionId: vi.fn(() => 'runtime-thread-id'),
    getExternalSessionModel: vi.fn(() => 'gpt-5'),
    getExternalSessionPermissionMode: vi.fn(() => 'no-restrictions'),
    getExternalSessionReasoningEffort: vi.fn(() => 'medium'),
    getExternalSessionState: vi.fn(() => 'idle'),
    getExternalSessionWorkspacePath: vi.fn(() => '/workspace'),
    getExternalSystemInitPayload: vi.fn(() => null),
    getLastExternalAssistantText: vi.fn(() => 'external answer'),
    hasExternalRuntimeProcess: vi.fn(() => state.externalProcessAlive || state.externalActive),
    hasPendingExternalAskUserQuestion: vi.fn((requestId: string) => Boolean(requestId) && state.pendingExternalAsk),
    hasPendingExternalPlanApproval: vi.fn((requestId: string) => Boolean(requestId) && state.pendingExternalPlan),
    isExternalSessionActive: vi.fn(() => state.externalActive),
    isExternalSessionBusy: vi.fn(() => state.externalBusy),
    tryAcquireExternalSessionMutationLease: vi.fn(() => {
      if (state.externalConversationMutation) return null;
      state.externalConversationMutation = true;
      return { release: () => { state.externalConversationMutation = false; } };
    }),
    isExternalSessionStateRestoredFor: vi.fn(() => true),
    isExternalTurnCurrent: vi.fn((queueId: string) => state.externalCurrentQueueId === queueId),
    popLastUserMessageForRetry: vi.fn(async () => ({ success: true, content: 'retry' })),
    retryLastExternalUserMessage: vi.fn(async () => ({ success: true, content: 'dsh-retry' })),
    prewarmExternalSession: vi.fn(async () => ({ prewarmed: true })),
    respondExternalAskUserQuestion: vi.fn(async () => true),
    respondExternalPlanApproval: vi.fn(async () => true),
    respondExternalPermission: vi.fn(async () => true),
    restoreExternalSessionState: vi.fn(async (): Promise<{ success: boolean; error?: string }> => ({ success: true })),
    enqueueExternalTurnBoundaryOperation: vi.fn<(...args: unknown[]) => { queued: boolean; dispatch: Promise<{ queued: boolean; error?: string }> }>(() => ({ queued: true, dispatch: Promise.resolve({ queued: true }) })),
    enqueueExternalSendForInbox: vi.fn<(...args: unknown[]) => { queued: boolean; dispatch: Promise<{ queued: boolean; error?: string }> }>(() => ({ queued: true, dispatch: Promise.resolve({ queued: true }) })),
    sendExternalMessage: vi.fn<(...args: unknown[]) => Promise<{
      queued: boolean;
      error?: string;
      terminationUnconfirmed?: boolean;
    }>>(async (...args: unknown[]) => {
      const context = args[4] as {
        queueId?: string;
        turnOwner?: { kind: 'goal' | 'task'; id: string };
        onTerminal?: (outcome: { status: 'complete'; assistantMessagePresent: boolean; text: string }) => void;
      } | undefined;
      state.externalCurrentQueueId = context?.queueId ?? null;
      state.externalTurnIdentity = context?.queueId && context.turnOwner
        ? { queueId: context.queueId, owner: context.turnOwner }
        : null;
      queueMicrotask(() => {
        context?.onTerminal?.({
          status: 'complete',
          assistantMessagePresent: true,
          text: 'external answer',
        });
        state.externalCurrentQueueId = null;
        state.externalTurnIdentity = null;
      });
      return { queued: true };
    }),
    setExternalModel: vi.fn(async () => ({ success: true })),
    setExternalPermissionMode: vi.fn(async () => ({ success: true })),
    setExternalReasoningEffort: vi.fn(async () => ({ success: true })),
    shouldUseExternalRuntime: vi.fn(() => state.useExternal),
    stopExternalSession: vi.fn(async () => true),
    handleExternalOfficialToolIdsChange: vi.fn(async () => ({ success: true })),
    handleExternalAgentsChange: vi.fn(async () => ({
      success: true,
      extensionStatus: { desiredRevision: 'desired', effectiveRevision: 'desired', state: 'applied', components: [] },
    })),
    handleExternalDesktopInteractionScenarioChange: vi.fn(async () => ({
      success: true,
      extensionStatus: { desiredRevision: 'desired', effectiveRevision: 'desired', state: 'applied', components: [] },
    })),
    handleExternalMcpServersChange: vi.fn(async (servers: Array<{ id: string }>) => ({
      success: true,
      servers: servers.map(server => server.id),
      extensionStatus: { desiredRevision: 'desired', effectiveRevision: 'desired', state: 'applied', components: [] },
    })),
    handleExternalSessionEnabledPluginsChange: vi.fn(async () => ({
      success: true,
      extensionStatus: { desiredRevision: 'desired', effectiveRevision: 'desired', state: 'applied', components: [] },
    })),
    getProductExtensionConfigSnapshot: vi.fn(() => ({
      mcpServerIds: null,
      agentNames: null,
      enabledPluginIds: null,
    })),
    getActiveExternalImBridgeTurnContext: vi.fn(() => state.externalImContext),
    updateExternalRuntimeConfig: vi.fn(async () => ({
      success: true,
      runtime: 'codex' as const,
      status: 'applied' as 'applied' | 'queued',
      warnings: [] as string[],
    })),
    waitForExternalSessionIdle: vi.fn(async () => true),
    waitExternalTurnFinalization: vi.fn(async () => true),
    getSessionData: vi.fn((sessionId: string) => ({
      id: sessionId,
      agentDir: '/workspace',
      title: 'Test',
      createdAt: '2026-01-01T00:00:00.000Z',
      lastActiveAt: '2026-01-01T00:00:00.000Z',
      enabledOfficialToolIds: ['image-understanding'],
      messages: [],
    })),
    getSessionMetadata: vi.fn((sessionId: string) => state.sessionMetadata.get(sessionId)),
    saveSessionMetadata: vi.fn(async (metadata: Record<string, unknown>) => {
      state.sessionMetadata.set(String(metadata.id), { ...metadata });
    }),
    deleteSession: vi.fn(async (sessionId: string) => {
      const deleted = state.sessionMetadata.delete(sessionId);
      return deleted ? { deleted: true as const } : { deleted: false as const, reason: 'not-found' as const };
    }),
    updateSessionMetadata: vi.fn(async (
      sessionId: string,
      updates: Record<string, unknown>,
      predicate?: (current: Record<string, unknown>) => boolean,
    ) => {
      const current = state.sessionMetadata.get(sessionId);
      if (predicate && (!current || !predicate(current))) return null;
      const updated = {
        id: sessionId,
        agentDir: '/workspace',
        title: 'Test',
        createdAt: '2026-01-01T00:00:00.000Z',
        lastActiveAt: '2026-01-01T00:00:00.000Z',
        ...(current ?? {}),
        ...updates,
      };
      state.sessionMetadata.set(sessionId, updated);
      return updated;
    }),
    getEffectiveOfficialToolIdsForSession: vi.fn((_workspacePath: string, sessionMeta?: { enabledOfficialToolIds?: string[] } | null, overrideIds?: readonly string[] | null) => (
      overrideIds !== null && overrideIds !== undefined
        ? [...overrideIds]
        : (sessionMeta?.enabledOfficialToolIds ? [...sessionMeta.enabledOfficialToolIds] : [])
    )),
    getAllMcpServers: vi.fn(() => [{ id: 'fs' }, { id: 'browser' }]),
    getEffectiveMcpServers: vi.fn(() => [{ id: 'fs' }]),
    getEnabledMcpServerIds: vi.fn(() => ['fs', 'browser']),
    findProvider: vi.fn((providerId: string) => ({ id: providerId, type: 'api_key' })),
    isProviderDisabled: vi.fn(() => state.providerDisabled),
    materializeProviderRouteEnv: vi.fn<() => unknown>(() => undefined),
    resolveProviderEnv: vi.fn((providerId: string) => ({
      providerId,
      baseUrl: 'https://provider.example/v1',
      apiKey: 'test-key',
      apiProtocol: 'anthropic',
    })),
    managementApi: vi.fn<(...args: unknown[]) => Promise<Record<string, unknown>>>(
      async () => ({ ok: true }),
    ),
    resolveSubscriptionAuthKind: vi.fn((providerId: string) => (
      providerId === 'xai-sub' ? 'host-managed-oauth' : 'sdk-native'
    )),
    loadConfig: vi.fn(() => ({ chatQueueResponseMode: 'realtime' })),
    resolveWorkspaceConfig: vi.fn(() => ({ mcpServers: [{ id: 'snapshot-mcp' }] })),
    findProjectAgentByWorkspacePath: vi.fn<() => { id: string } | undefined>(() => undefined),
  };
});

vi.mock('../agent-session', () => ({
  applyMcpOverrideAndAwaitReady: mocks.applyMcpOverrideAndAwaitReady,
  cancelImRequest: mocks.cancelBuiltinImRequest,
  cancelQueueItem: mocks.cancelQueueItem,
  cancelQueuedTurnsByOwner: mocks.cancelQueuedTurnsByOwner,
  enqueueUserMessage: mocks.enqueueUserMessage,
  forceExecuteQueueItem: mocks.forceExecuteQueueItem,
  getAndClearLastAgentError: mocks.getAndClearLastAgentError,
  getCurrentTurnIdentity: mocks.getCurrentTurnIdentity,
  getCurrentImBridgeTurnContext: mocks.getCurrentImBridgeTurnContext,
  getDispatchedTurnIdentity: mocks.getDispatchedTurnIdentity,
  getAgentState: mocks.getAgentState,
  getBuiltinLiveSessionSnapshot: mocks.getBuiltinLiveSessionSnapshot,
  getBuiltinMcpEffectiveSnapshot: mocks.getBuiltinMcpEffectiveSnapshot,
  getCurrentMcpServers: mocks.getCurrentMcpServers,
  getAgents: mocks.getAgents,
  getLastBuiltinAssistantText: mocks.getLastBuiltinAssistantText,
  getMcpServers: mocks.getMcpServers,
  getMessages: mocks.getMessages,
  getPendingInteractiveRequests: mocks.getPendingInteractiveRequests,
  getQueueStatus: mocks.getQueueStatus,
  getSessionId: mocks.getSessionId,
  getSessionModel: mocks.getSessionModel,
  getSessionPermissionMode: mocks.getSessionPermissionMode,
  getSessionEnabledOfficialToolIds: mocks.getSessionEnabledOfficialToolIds,
  getSessionProviderEnv: mocks.getSessionProviderEnv,
  getSessionProviderId: mocks.getSessionProviderId,
  getSessionReasoningEffort: mocks.getSessionReasoningEffort,
  getStreamingAssistantId: mocks.getStreamingAssistantId,
  getSystemInitInfo: mocks.getSystemInitInfo,
  handleAskUserQuestionResponse: mocks.handleAskUserQuestionResponse,
  handleExitPlanModeResponse: mocks.handleExitPlanModeResponse,
  handlePermissionResponse: mocks.handlePermissionResponse,
  interruptCurrentResponse: mocks.interruptCurrentResponse,
  isSessionBusy: mocks.isSessionBusy,
  forkSession: mocks.forkSession,
  freezeCurrentSessionMetadataForImDetach: mocks.freezeCurrentSessionMetadataForImDetach,
  materializeCurrentSessionMetadataForPublishedReset: mocks.materializeCurrentSessionMetadataForPublishedReset,
  materializePendingDesktopSession: mocks.materializePendingDesktopSession,
  resetSession: mocks.resetSession,
  resetInteractionScenario: mocks.resetInteractionScenario,
  requireCurrentBuiltinSkill: mocks.requireCurrentBuiltinSkill,
  rewindSession: mocks.rewindSession,
  setAgents: mocks.setAgents,
  forceReloadActiveSession: mocks.forceReloadActiveSession,
  setBackgroundAgentPermissionMode: mocks.setBackgroundAgentPermissionMode,
  setInteractionScenario: mocks.setInteractionScenario,
  setMcpServers: mocks.setMcpServers,
  setSessionModel: mocks.setSessionModel,
  applySessionModelSelection: mocks.applySessionModelSelection,
  setSessionPermissionMode: mocks.setSessionPermissionMode,
  setSessionEnabledOfficialToolIds: mocks.setSessionEnabledOfficialToolIds,
  setSessionProviderEnv: mocks.setSessionProviderEnv,
  setSessionReasoningEffort: mocks.setSessionReasoningEffort,
  stripPlaywrightResults: mocks.stripPlaywrightResults,
  switchToSession: mocks.switchToSession,
  waitForSessionIdle: mocks.waitForSessionIdle,
}));

vi.mock('../runtimes/external-session', () => ({
  inspectExternalRuntime: vi.fn(async () => null),
  awaitExternalSessionStarting: mocks.awaitExternalSessionStarting,
  cancelExternalImRequest: mocks.cancelExternalImRequest,
  cancelExternalQueueItem: mocks.cancelExternalQueueItem,
  cancelExternalQueuedTurnsByOwner: mocks.cancelExternalQueuedTurnsByOwner,
  clearExternalTurnBinding: mocks.clearExternalTurnBinding,
  compactExternalContext: mocks.compactExternalContext,
  didLastTurnSucceed: mocks.didLastTurnSucceed,
  enqueueExternalSendForDesktop: mocks.enqueueExternalSendForDesktop,
  enqueueExternalSendForIm: mocks.enqueueExternalSendForIm,
  forceExecuteExternalQueueItem: mocks.forceExecuteExternalQueueItem,
  getActiveRuntimeSource: mocks.getActiveRuntimeSource,
  getActiveRuntimeType: mocks.getActiveRuntimeType,
  getActiveExternalImBridgeTurnContext: mocks.getActiveExternalImBridgeTurnContext,
  getCurrentBoundSessionId: mocks.getCurrentBoundSessionId,
  getExternalCurrentTurnIdentity: mocks.getExternalCurrentTurnIdentity,
  getExternalLiveAssistantMessage: mocks.getExternalLiveAssistantMessage,
  getExternalLiveSessionSnapshot: mocks.getExternalLiveSessionSnapshot,
  getExternalMcpEffectiveSnapshot: mocks.getExternalMcpEffectiveSnapshot,
  getExternalPendingInteractiveRequests: mocks.getExternalPendingInteractiveRequests,
  getExternalQueueStatus: mocks.getExternalQueueStatus,
  getExternalSessionId: mocks.getExternalSessionId,
  getExternalNativeSessionId: mocks.getExternalNativeSessionId,
  getExternalSessionModel: mocks.getExternalSessionModel,
  getExternalSessionPermissionMode: mocks.getExternalSessionPermissionMode,
  getExternalSessionReasoningEffort: mocks.getExternalSessionReasoningEffort,
  getExternalSessionState: mocks.getExternalSessionState,
  getExternalSessionWorkspacePath: mocks.getExternalSessionWorkspacePath,
  getExternalSystemInitPayload: mocks.getExternalSystemInitPayload,
  getLastExternalAssistantText: mocks.getLastExternalAssistantText,
  handleExternalOfficialToolIdsChange: mocks.handleExternalOfficialToolIdsChange,
  handleExternalAgentsChange: mocks.handleExternalAgentsChange,
  handleExternalDesktopInteractionScenarioChange: mocks.handleExternalDesktopInteractionScenarioChange,
  handleExternalMcpServersChange: mocks.handleExternalMcpServersChange,
  handleExternalSessionEnabledPluginsChange: mocks.handleExternalSessionEnabledPluginsChange,
  getProductExtensionConfigSnapshot: mocks.getProductExtensionConfigSnapshot,
  hasExternalRuntimeProcess: mocks.hasExternalRuntimeProcess,
  hasPendingExternalAskUserQuestion: mocks.hasPendingExternalAskUserQuestion,
  hasPendingExternalPlanApproval: mocks.hasPendingExternalPlanApproval,
  isExternalSessionActive: mocks.isExternalSessionActive,
  isExternalSessionBusy: mocks.isExternalSessionBusy,
  tryAcquireExternalSessionMutationLease: mocks.tryAcquireExternalSessionMutationLease,
  isExternalSessionStateRestoredFor: mocks.isExternalSessionStateRestoredFor,
  isExternalTurnCurrent: mocks.isExternalTurnCurrent,
  popLastUserMessageForRetry: mocks.popLastUserMessageForRetry,
  retryLastExternalUserMessage: mocks.retryLastExternalUserMessage,
  prewarmExternalSession: mocks.prewarmExternalSession,
  respondExternalAskUserQuestion: mocks.respondExternalAskUserQuestion,
  respondExternalPlanApproval: mocks.respondExternalPlanApproval,
  respondExternalPermission: mocks.respondExternalPermission,
  restoreExternalSessionState: mocks.restoreExternalSessionState,
  sendExternalMessage: mocks.sendExternalMessage,
  enqueueExternalTurnBoundaryOperation: mocks.enqueueExternalTurnBoundaryOperation,
  enqueueExternalSendForInbox: mocks.enqueueExternalSendForInbox,
  getExternalExecutionTurnId: () => mocks.state.externalCurrentQueueId,
  setExternalModel: mocks.setExternalModel,
  setExternalPermissionMode: mocks.setExternalPermissionMode,
  setExternalReasoningEffort: mocks.setExternalReasoningEffort,
  shouldUseExternalRuntime: mocks.shouldUseExternalRuntime,
  stopExternalSession: mocks.stopExternalSession,
  updateExternalRuntimeConfig: mocks.updateExternalRuntimeConfig,
  waitForExternalSessionIdle: mocks.waitForExternalSessionIdle,
  waitExternalTurnFinalization: mocks.waitExternalTurnFinalization,
}));

vi.mock('../utils/admin-config', () => ({
  findProjectAgentByWorkspacePath: mocks.findProjectAgentByWorkspacePath,
  getAllMcpServers: mocks.getAllMcpServers,
  getEffectiveMcpServers: mocks.getEffectiveMcpServers,
  getEnabledMcpServerIds: mocks.getEnabledMcpServerIds,
  getEffectiveOfficialToolIdsForSession: mocks.getEffectiveOfficialToolIdsForSession,
  findProvider: mocks.findProvider,
  isProviderDisabled: mocks.isProviderDisabled,
  loadConfig: mocks.loadConfig,
  materializeProviderRouteEnv: mocks.materializeProviderRouteEnv,
  resolveProviderEnv: mocks.resolveProviderEnv,
  resolveSubscriptionAuthKind: mocks.resolveSubscriptionAuthKind,
  resolveWorkspaceConfig: mocks.resolveWorkspaceConfig,
}));

vi.mock('../utils/management-api-client', () => ({
  managementApi: mocks.managementApi,
}));

vi.mock('../SessionStore', () => ({
  assertSessionTranscriptsDurableForUpdate: vi.fn(),
  releaseSessionTranscriptForBinding: vi.fn(async () => undefined),
  getActiveSessionTranscript: vi.fn(() => undefined),
  deleteSession: mocks.deleteSession,
  getSessionData: mocks.getSessionData,
  getSessionMetadata: mocks.getSessionMetadata,
  saveSessionMetadata: mocks.saveSessionMetadata,
  updateSessionMetadata: mocks.updateSessionMetadata,
  updateSessionMetadataForBinding: mocks.updateSessionMetadata,
}));

vi.mock('../sse', () => ({
  broadcast: mocks.broadcast,
}));

import {
  freezeSessionAdmissionsForUpdate,
  releaseSessionAdmissionsForUpdate,
  getAskUserQuestionResponseEngine,
  getPermissionResponseEngine,
  getPlanApprovalResponseEngine,
  getSessionEngine,
  prewarmExternalRuntimeAtSelector,
  restoreInitialExternalSessionAtSelector,
  retryLastExternalUserMessageAtSelector,
  stopActiveTurn,
  stopOwnedTurn,
  stopOwnedTurnByQueueId,
  updateExternalRuntimeConfigAtSelector,
} from './selector';
import type { InjectedTurnRequest, SessionEngine } from './types';
import {
  getCurrentProductSessionId,
  resetProductSessionBinding,
} from './product-session-binding';

const desktopScenario = { type: 'desktop' } as const;

type TestInjectedTurnRequest = Omit<InjectedTurnRequest, 'assistantChannelDelivery'>
  & Partial<Pick<InjectedTurnRequest, 'assistantChannelDelivery'>>;

function runInjectedTurn(request: TestInjectedTurnRequest) {
  return getSessionEngine().runInjectedTurn({
    assistantChannelDelivery: 'none',
    ...request,
  });
}

describe('session-engine selector and adapters', () => {
  beforeEach(async () => {
    vi.clearAllMocks();
    mocks.state.useExternal = false;
    mocks.state.externalActive = false;
    mocks.state.externalBusy = false;
    mocks.state.externalConversationMutation = false;
    mocks.state.externalProcessAlive = false;
    mocks.state.builtinTurnIdentity = null;
    mocks.state.builtinDispatchedQueueId = null;
    mocks.state.externalTurnIdentity = null;
    mocks.state.externalCurrentQueueId = null;
    mocks.state.builtinImContext = null;
    mocks.state.externalImContext = null;
    mocks.state.pendingExternalAsk = false;
    mocks.state.pendingExternalPlan = false;
    mocks.state.providerDisabled = false;
    mocks.state.sessionMetadata.clear();
    await resetProductSessionBinding({ sessionId: 'external-session', workspacePath: '/workspace' });
    mocks.state.sessionMetadata.set('external-session', {
      id: 'external-session',
      agentDir: '/workspace',
      title: 'Test',
      createdAt: '2026-01-01T00:00:00.000Z',
      lastActiveAt: '2026-01-01T00:00:00.000Z',
    });
    mocks.isExternalSessionStateRestoredFor.mockReturnValue(true);
    mocks.getActiveRuntimeSource.mockReturnValue('system-cli');
    mocks.getActiveRuntimeType.mockReturnValue('codex');
    mocks.updateExternalRuntimeConfig.mockResolvedValue({
      success: true,
      runtime: 'codex',
      status: 'applied',
      warnings: [],
    });
    mocks.prewarmExternalSession.mockResolvedValue({ prewarmed: true });
    mocks.popLastUserMessageForRetry.mockResolvedValue({ success: true, content: 'retry' });
    mocks.getBuiltinLiveSessionSnapshot.mockReturnValue(null);
    mocks.getExternalLiveSessionSnapshot.mockReturnValue(null);
  });

  it('forces SDK agent reload only when explicitly requested by the builtin adapter', async () => {
    const engine = getSessionEngine();
    const agents = { helper: { description: 'Helper', prompt: 'Assist' } };

    await engine.updateAgents(agents);
    expect(mocks.setAgents).toHaveBeenCalledWith(agents);
    expect(mocks.forceReloadActiveSession).not.toHaveBeenCalled();

    await engine.updateAgents(agents, { forceReload: true });
    expect(mocks.forceReloadActiveSession).toHaveBeenCalledExactlyOnceWith('agents');
  });

  it('resolves IM Bridge caller identity through the selected Runtime adapter', () => {
    mocks.state.builtinImContext = { senderId: 'builtin-sender' };
    expect(getSessionEngine().getActiveImBridgeTurnContext()).toEqual({ senderId: 'builtin-sender' });

    mocks.state.useExternal = true;
    mocks.state.externalImContext = { senderId: 'external-sender' };
    expect(getSessionEngine().getActiveImBridgeTurnContext()).toEqual({ senderId: 'external-sender' });
  });

  it('routes desktop sends through builtin while preserving desktop metadata', async () => {
    const result = await getSessionEngine().sendDesktopMessage({
      text: 'hello',
      images: [],
      permissionMode: 'auto',
      model: 'claude-sonnet',
      providerEnv: undefined,
      reasoningEffort: 'medium',
      sessionId: 'sid',
      workspacePath: '/workspace',
      scenario: desktopScenario,
      analyticsSource: 'floating_ball',
      analyticsOrigin: { kind: 'desktop', surface: 'floating_ball' },
      birthOrigin: { kind: 'desktop', surface: 'launcher_input' },
    });

    expect(result).toMatchObject({
      success: true,
      queued: true,
      queueId: 'q1',
      isInFlight: false,
      deliveryMode: 'queue',
    });
    expect(mocks.setInteractionScenario).toHaveBeenCalledWith(desktopScenario);
    expect(mocks.enqueueUserMessage).toHaveBeenCalledWith(
      'hello',
      [],
      'auto',
      'claude-sonnet',
      undefined,
      'medium',
      { source: 'desktop' },
      undefined,
      undefined,
      'floating_ball',
      { kind: 'desktop', surface: 'floating_ball' },
      {
        fromDesktopChatSend: true,
        sessionBirthOrigin: { kind: 'desktop', surface: 'launcher_input' },
        queueId: undefined,
        turnOwner: undefined,
        beforeDispatch: undefined,
        onTerminal: undefined,
        channelDelivery: {
          user: 'session-binding',
          assistant: 'session-binding',
        },
      },
    );
  });


  it('projects root-blocking interactions without treating child approvals as Session suspension', () => {
    mocks.state.useExternal = true;
    mocks.state.externalBusy = true;
    mocks.getExternalPendingInteractiveRequests.mockReturnValue([{ type: 'permission:request', data: { blocksRoot: false, rootToolUseId: 'parent', toolUseId: 'child' } }]);
    expect(getSessionEngine().getLiveSessionState().waitingForUser).toBe(false);
    mocks.getExternalPendingInteractiveRequests.mockReturnValue([{ type: 'permission:request', data: { blocksRoot: true, rootToolUseId: 'parent', toolUseId: 'nested-root-call' } }]);
    expect(getSessionEngine().getLiveSessionState().waitingForUser).toBe(true);
    mocks.getExternalPendingInteractiveRequests.mockReturnValue([{ type: 'permission:request', data: { toolUseId: 'unknown' } }]);
    expect(getSessionEngine().getLiveSessionState().waitingForUser).toBe(false);
    for (const type of ['permission:request','plan:approval','ask-user:question']) {
      mocks.getExternalPendingInteractiveRequests.mockReturnValue([{ type, data: { blocksRoot: true } }]);
      expect(getSessionEngine().getLiveSessionState().waitingForUser).toBe(true);
    }
    mocks.getExternalPendingInteractiveRequests.mockReturnValue([]);
  });
  it('preserves exact Registered Agent birth origin through builtin and external inbox adapters', async () => {
    const birthOrigin = {
      kind: 'registered-agent',
      surface: 'space_issue_delivery',
      context: { spaceId: 'space_1', registeredAgentId: 'rag_1' },
    } as const;
    const request = {
      text: '<system-reminder>delivery</system-reminder>',
      sessionId: 'delivery-session',
      workspacePath: '/workspace',
      scenario: {
        type: 'registeredAgent',
        platform: 'space',
        spaceId: 'space_1',
        registeredAgentId: 'rag_1',
        sourceType: 'issue-delivery',
      } as const,
      allowLazySessionMaterialization: true,
      analyticsOrigin: birthOrigin,
      birthOrigin,
    };

    await getSessionEngine().enqueueInboxMessage(request);
    expect(mocks.enqueueUserMessage).toHaveBeenLastCalledWith(
      request.text,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      birthOrigin,
      {
        allowLazySessionMaterialization: true,
        sessionBirthOrigin: birthOrigin,
        queueResponseModeOverride: 'realtime',
        inputSource: 'inbox',
        channelDelivery: {
          user: 'none',
          assistant: 'session-binding',
        },
      },
    );

    mocks.state.useExternal = true;
    await getSessionEngine().enqueueInboxMessage(request);
    expect(mocks.enqueueExternalSendForInbox).toHaveBeenLastCalledWith(
      request.text,
      expect.objectContaining({
        sessionId: 'delivery-session',
        workspacePath: '/workspace',
        analyticsOrigin: birthOrigin,
        birthOrigin,
        metadataBirthPending: true,
        channelDelivery: {
          user: 'none',
          assistant: 'session-binding',
        },
      }),
    );
  });

  it('exposes fresh inbox dispatch acceptance through builtin and external adapters', async () => {
    const builtinGuard = vi.fn(async () => ({ accepted: true as const }));
    const builtinResult = await getSessionEngine().enqueueInboxMessage({
      text: 'fresh builtin work',
      sessionId: 'fresh-builtin',
      workspacePath: '/workspace',
      queueId: 'request-builtin',
      beforeDispatch: builtinGuard,
    });

    expect(mocks.enqueueUserMessage.mock.calls.at(-1)?.[11]).toMatchObject({
      queueId: 'request-builtin',
      queueResponseModeOverride: 'realtime',
      inputSource: 'inbox',
      beforeDispatch: builtinGuard,
    });
    await expect(builtinResult.dispatchAcceptance).resolves.toEqual({ accepted: true });

    mocks.state.useExternal = true;
    const externalGuard = vi.fn(async () => ({ accepted: true as const }));
    const externalResult = await getSessionEngine().enqueueInboxMessage({
      text: 'fresh external work',
      sessionId: 'fresh-external',
      workspacePath: '/workspace',
      queueId: 'request-external',
      beforeDispatch: externalGuard,
    });

    expect(mocks.enqueueExternalSendForInbox.mock.calls.at(-1)?.[1]).toMatchObject({
      queueId: 'request-external',
      beforeDispatch: externalGuard,
    });
    await expect(externalResult.dispatchAcceptance).resolves.toMatchObject({ accepted: true });

    let completeDispatch!: (value: { queued: boolean; error?: string }) => void;
    mocks.enqueueExternalSendForInbox.mockReturnValueOnce({ queued: true,
      dispatch: new Promise(resolve => { completeDispatch = resolve; }),
    });
    const busyResult = await getSessionEngine().enqueueInboxMessage({
      text: 'busy target work', sessionId: 'fresh-external', workspacePath: '/workspace',
      beforeDispatch: externalGuard,
    });
    expect(busyResult.queued).toBe(true);
    expect(externalGuard).not.toHaveBeenCalled();
    let dispatchSettled = false;
    void busyResult.dispatchAcceptance?.then(() => { dispatchSettled = true; });
    await Promise.resolve();
    expect(dispatchSettled).toBe(false);
    completeDispatch({ queued: false, error: 'guard rejected before dispatch' });
    await expect(busyResult.dispatchAcceptance).resolves.toMatchObject({ accepted: false, error: 'guard rejected before dispatch' });
  });

  it('materializes Grok subscription routes as managed builtin ProviderEnv', async () => {
    const managedEnv = {
      providerId: 'xai-sub',
      baseUrl: 'https://api.x.ai/v1',
      apiProtocol: 'openai' as const,
      upstreamFormat: 'responses' as const,
      credentialSource: { kind: 'managed-oauth' as const, providerId: 'xai-sub' as const },
    };
    mocks.materializeProviderRouteEnv.mockReturnValueOnce(managedEnv);

    const result = await getSessionEngine().sendDesktopMessage({
      text: 'hello Grok',
      model: 'grok-4.5',
      providerRoute: { kind: 'subscription', providerId: 'xai-sub', model: 'grok-4.5' },
      sessionId: 'sid',
      workspacePath: '/workspace',
      scenario: desktopScenario,
    });

    expect(result.success).toBe(true);
    expect(mocks.enqueueUserMessage.mock.calls.at(-1)?.[4]).toEqual(managedEnv);
  });

  it('keeps Anthropic subscription routes on the native subscription sentinel', async () => {
    await getSessionEngine().sendDesktopMessage({
      text: 'hello Claude',
      clientRequestId: 'desktop-request-1',
      model: 'claude-sonnet-5',
      providerRoute: {
        kind: 'subscription',
        providerId: 'anthropic-sub',
        model: 'claude-sonnet-5',
      },
      sessionId: 'sid',
      workspacePath: '/workspace',
      scenario: desktopScenario,
    });

    expect(mocks.enqueueUserMessage.mock.calls.at(-1)?.[4]).toBe('subscription');
    expect(mocks.enqueueUserMessage.mock.calls.at(-1)?.[6]).toEqual({ source: 'desktop', clientRequestId: 'desktop-request-1' });
  });

  it('passes Goal dispatch guards into builtin queue ownership and exposes its acknowledgement', async () => {
    const beforeDispatch = vi.fn(async () => ({ accepted: true }));
    const dispatchAcceptance = Promise.resolve({ accepted: true });
    mocks.enqueueUserMessage.mockResolvedValueOnce({
      queued: true,
      queueId: 'q-goal',
      dispatchAcceptance,
    });

    const result = await getSessionEngine().sendDesktopMessage({
      text: 'guarded Goal turn',
      sessionId: 'sid',
      workspacePath: '/workspace',
      scenario: desktopScenario,
      beforeDispatch,
    });

    expect(mocks.enqueueUserMessage.mock.calls[0]?.[11]).toMatchObject({ beforeDispatch });
    expect(result.dispatchAcceptance).toBe(dispatchAcceptance);
  });

  it('exposes builtin read and config surfaces without route-level helpers', async () => {
    mocks.getSessionId.mockReturnValueOnce('builtin-live');
    mocks.getLastBuiltinAssistantText.mockReturnValueOnce('builtin answer');
    mocks.getMessages.mockReturnValueOnce([
      { id: 'u1', role: 'user', content: 'hello', timestamp: '2026-01-01T00:00:00.000Z' },
      { id: 'a1', role: 'assistant', content: [{ type: 'text', text: 'saved answer' }], timestamp: '2026-01-01T00:00:01.000Z' },
      { id: 'a-stream', role: 'assistant', content: 'streaming', timestamp: '2026-01-01T00:00:02.000Z' },
    ]);
    mocks.getStreamingAssistantId.mockReturnValueOnce('a-stream');
    mocks.getSystemInitInfo.mockReturnValueOnce({ model: 'claude-sonnet' });
    mocks.getPendingInteractiveRequests.mockReturnValueOnce([{ type: 'chat:permission-request', data: { requestId: 'p1' } }]);

    const engine = getSessionEngine();

    expect(engine.getRuntimeIdentity()).toEqual({
      kind: 'builtin',
      runtime: 'builtin',
      sessionId: 'builtin-live',
    });
    expect((await engine.getLatestAssistantResult())).toEqual({
      sessionId: 'builtin-session',
      latestResult: 'builtin answer',
    });
    expect(engine.getStreamReplaySnapshot()).toMatchObject({
      sessionId: 'builtin-session',
      replayMessages: [
        { id: 'u1', content: 'hello' },
        { id: 'a1', content: [{ type: 'text', text: 'saved answer' }] },
      ],
      systemInitPayload: { info: { model: 'claude-sonnet' } },
      pendingInteractiveRequests: [{ type: 'chat:permission-request', data: { requestId: 'p1' } }],
    });
    expect(engine.getSessionConfigSnapshot()).toEqual({
      success: true,
      runtime: 'builtin',
      model: 'claude-sonnet',
      mcpServerIds: ['fs'],
      agentNames: ['helper'],
      enabledOfficialToolIds: ['image-understanding'],
      permissionMode: 'auto',
      providerId: 'sensenova',
      providerRoute: { kind: 'provider', providerId: 'sensenova', model: 'claude-sonnet' },
      reasoningEffort: 'default',
    });
    expect(engine.getHeldImConfigSnapshot()).toEqual({
      model: 'claude-sonnet',
      permissionMode: 'auto',
      providerEnv: undefined,
      reasoningEffort: 'default',
    });

    mocks.getBuiltinLiveSessionSnapshot.mockReturnValueOnce({
      snapshotRevision: 7,
      inMemoryMessages: [{ id: 'u-live', role: 'user', content: 'accepted', timestamp: '2026-01-01T00:00:03.000Z' }],
      liveStreamingMessage: { id: 'a-live', role: 'assistant', content: 'typing', timestamp: '2026-01-01T00:00:04.000Z' },
      liveSessionState: 'running',
      pendingInteractiveRequests: [],
    });
    expect(engine.getLiveSessionOverlay('builtin-session')).toEqual({
      isActive: true,
      runtime: 'builtin',
      snapshotRevision: 7,
      queuedMessages: [{ id: 'q1', messagePreview: 'hello' }],
      inMemoryMessages: [{
        id: 'u-live',
        role: 'user',
        content: 'accepted',
        timestamp: '2026-01-01T00:00:03.000Z',
      }],
      liveStreamingMessage: { id: 'a-live', role: 'assistant', content: 'typing', timestamp: '2026-01-01T00:00:04.000Z' },
      liveSessionState: 'running',
      pendingInteractiveRequests: [],
    });

    mocks.getBuiltinLiveSessionSnapshot.mockReturnValueOnce({
      snapshotRevision: 8,
      inMemoryMessages: [
        { id: 'a-final', role: 'assistant', content: 'finished', timestamp: '2026-01-01T00:00:05.000Z' },
        { id: 'u-admitted', role: 'user', content: 'waiting for first chunk', timestamp: '2026-01-01T00:00:06.000Z' },
      ],
      liveStreamingMessage: null,
      liveSessionState: 'running',
      pendingInteractiveRequests: [],
    });
    expect(engine.getLiveSessionOverlay('builtin-session')).toMatchObject({
      inMemoryMessages: [
        expect.objectContaining({ id: 'a-final', content: 'finished' }),
        expect.objectContaining({ id: 'u-admitted', content: 'waiting for first chunk' }),
      ],
      liveStreamingMessage: null,
      liveSessionState: 'running',
    });
  });

  it('exposes external read, config, and restore surfaces behind the external adapter', async () => {
    mocks.state.sessionMetadata.set('external-session', { ...mocks.getSessionData('external-session') });
    mocks.state.useExternal = true;
    mocks.state.externalBusy = true;
    mocks.getCurrentBoundSessionId
      .mockReturnValueOnce('bound-session')
      .mockReturnValueOnce('bound-session');
    mocks.getExternalLiveSessionSnapshot.mockImplementation((targetSessionId: string) => {
      expect(targetSessionId).toBe('bound-session');
      return {
      snapshotRevision: 3,
      inMemoryMessages: [{
        id: 'external-user',
        role: 'user',
        content: 'accepted before reconnect',
        timestamp: '2026-01-01T00:00:00.000Z',
      }],
      liveStreamingMessage: {
        id: 'live',
        role: 'assistant',
        content: 'typing',
        timestamp: '2026-01-01T00:00:00.000Z',
      },
      liveSessionState: 'idle',
      pendingInteractiveRequests: [],
      };
    });

    const engine = getSessionEngine();

    expect(engine.isBusy()).toBe(true);
    expect(engine.getLiveSessionState()).toEqual({
      sessionState: 'idle',
      isBusy: true,
      waitingForUser: false,
    });

    expect(engine.getRuntimeIdentity()).toEqual({
      kind: 'external',
      runtime: 'codex',
      runtimeSource: 'system-cli',
      sessionId: 'external-session',
      boundSessionId: 'bound-session',
    });
    expect(engine.getStreamReplaySnapshot()).toMatchObject({
      sessionId: 'bound-session',
      replayMessages: [{
        id: 'external-user',
        role: 'user',
        content: 'accepted before reconnect',
      }],
      liveStreamingMessage: {
        id: 'live',
        role: 'assistant',
        content: 'typing',
      },
    });
    expect(engine.getSessionConfigSnapshot()).toEqual({
      success: true,
      runtime: 'codex',
      runtimeSource: 'system-cli',
      model: 'gpt-5',
      mcpServerIds: null,
      agentNames: null,
      enabledPluginIds: null,
      enabledOfficialToolIds: ['image-understanding'],
      permissionMode: 'no-restrictions',
      providerId: null,
      providerRoute: null,
      providerExecutionIdentity: null,
      reasoningEffort: 'medium',
    });
    expect(engine.getHeldImConfigSnapshot()).toEqual({
      model: 'gpt-5',
      permissionMode: 'no-restrictions',
      reasoningEffort: 'medium',
    });
    expect(engine.getLiveSessionOverlay('bound-session')).toMatchObject({
      isActive: true,
      runtime: 'codex',
      liveStreamingMessage: { id: 'live', content: 'typing' },
      liveSessionState: 'idle',
    });

    await expect(restoreInitialExternalSessionAtSelector('sid-restored', '/workspace')).resolves.toBe(true);
    expect(mocks.restoreExternalSessionState).toHaveBeenCalledWith('sid-restored', '/workspace', { type: 'desktop' });
  });

  it('matches external live overlay by current bound session during prewarm/start', () => {
    mocks.state.useExternal = true;
    mocks.getExternalLiveSessionSnapshot.mockReturnValueOnce({
      snapshotRevision: 1,
      inMemoryMessages: [],
      liveStreamingMessage: null,
      liveSessionState: 'idle',
      pendingInteractiveRequests: [],
    });

    expect(getSessionEngine().getLiveSessionOverlay('starting-session')).toMatchObject({
      isActive: true,
      runtime: 'codex',
      liveSessionState: 'idle',
    });
  });

  it('rejects external-only operations at the selector seam for builtin sessions', async () => {
    await expect(updateExternalRuntimeConfigAtSelector({
      runtime: 'codex',
      runtimeConfig: { model: 'gpt-5' },
    })).resolves.toEqual({
      httpStatus: 400,
      body: { success: false, error: 'Runtime config endpoint is only for external runtimes' },
    });
    await expect(prewarmExternalRuntimeAtSelector({
      sessionId: 'sid',
      workspacePath: '/workspace',
    })).resolves.toEqual({
      httpStatus: 400,
      body: { success: false, error: 'Pre-warm is only for external runtimes' },
    });
    await expect(retryLastExternalUserMessageAtSelector('user-1')).resolves.toEqual({
      success: false,
      status: 400,
      error: 'external-retry is only for external runtimes; builtin uses /chat/rewind',
    });
    await expect(restoreInitialExternalSessionAtSelector('sid', '/workspace')).resolves.toBe(false);
    expect(mocks.updateExternalRuntimeConfig).not.toHaveBeenCalled();
    expect(mocks.prewarmExternalSession).not.toHaveBeenCalled();
    expect(mocks.popLastUserMessageForRetry).not.toHaveBeenCalled();
  });

  it('validates and delegates external-only operations through their native owner', async () => {
    mocks.state.useExternal = true;
    mocks.getActiveRuntimeSource.mockReturnValue('managed-provider');

    await expect(updateExternalRuntimeConfigAtSelector({
      runtime: 'claude-code',
      runtimeConfig: { model: 'sonnet' },
    })).resolves.toEqual({
      httpStatus: 400,
      body: { success: false, error: 'Runtime mismatch: sidecar=codex, payload=claude-code' },
    });
    await expect(updateExternalRuntimeConfigAtSelector({
      runtime: 'codex',
      runtimeConfig: { permissionMode: 'full-auto' },
    })).resolves.toEqual({
      httpStatus: 400,
      body: { success: false, error: "Invalid permissionMode 'full-auto' for managed-provider" },
    });
    expect(mocks.updateExternalRuntimeConfig).not.toHaveBeenCalled();

    mocks.getActiveRuntimeSource.mockReturnValue('system-cli');
    await expect(updateExternalRuntimeConfigAtSelector({
      runtime: 'codex',
      runtimeConfig: {
        model: 'gpt-5',
        permissionMode: null,
        reasoningEffort: 'high',
      },
      source: 'im-sync',
    })).resolves.toEqual({
      httpStatus: 200,
      body: { success: true, runtime: 'codex', status: 'applied', warnings: [] },
    });
    expect(mocks.updateExternalRuntimeConfig).toHaveBeenCalledWith(
      { model: 'gpt-5', permissionMode: '', reasoningEffort: 'high' },
      { source: 'im-sync' },
    );

    await expect(prewarmExternalRuntimeAtSelector({
      sessionId: 'sid',
      workspacePath: '/workspace',
      model: 'gpt-5',
    })).resolves.toEqual({
      httpStatus: 200,
      body: { success: true, prewarmed: true },
    });
    expect(mocks.prewarmExternalSession).toHaveBeenCalledWith({
      sessionId: 'sid',
      workspacePath: '/workspace',
      scenario: { type: 'desktop' },
      model: 'gpt-5',
    });
    await expect(retryLastExternalUserMessageAtSelector('user-1')).resolves.toEqual({
      success: true,
      content: 'retry',
    });
    expect(mocks.popLastUserMessageForRetry).toHaveBeenCalledWith('user-1');
  });

  it('routes DSH retry through the admission-aware mutation owner', async () => {
    mocks.state.useExternal = true;
    mocks.getActiveRuntimeType.mockReturnValue('dsh');
    const previousRuntime = process.env.MYAGENTS_RUNTIME;
    process.env.MYAGENTS_RUNTIME = 'dsh';

    try {
      await expect(retryLastExternalUserMessageAtSelector('user-dsh-1')).resolves.toEqual({
        success: true,
        content: 'dsh-retry',
      });
    } finally {
      if (previousRuntime === undefined) delete process.env.MYAGENTS_RUNTIME;
      else process.env.MYAGENTS_RUNTIME = previousRuntime;
    }
    expect(mocks.retryLastExternalUserMessage).toHaveBeenCalledWith('user-dsh-1');
    expect(mocks.popLastUserMessageForRetry).not.toHaveBeenCalled();
  });

  it('returns external desktop acceptance before dispatch finishes and broadcasts dispatch failures', async () => {
    mocks.state.useExternal = true;
    let resolveDispatch!: (result: { queued: boolean; error?: string }) => void;
    const dispatch = new Promise<{ queued: boolean; error?: string }>((resolve) => {
      resolveDispatch = resolve;
    });
    mocks.enqueueExternalSendForDesktop.mockReturnValueOnce({
      queued: true,
      queueId: 'xq-runtime',
      dispatch,
    });

    const result = await getSessionEngine().sendDesktopMessage({
      text: 'hello external',
      images: [],
      permissionMode: 'full-auto',
      model: 'gpt-5',
      sessionId: 'sid',
      workspacePath: '/workspace',
      scenario: desktopScenario,
    });

    expect(result).toMatchObject({ success: true, queued: true, queueId: 'xq-runtime' });
    expect(result.dispatchAcceptance).toBeInstanceOf(Promise);
    expect(mocks.enqueueExternalSendForDesktop).toHaveBeenCalledWith(
      'hello external',
      [],
      'full-auto',
      'gpt-5',
      {
        sessionId: 'sid',
        workspacePath: '/workspace',
        scenario: desktopScenario,
        analyticsSource: undefined,
        analyticsOrigin: undefined,
        birthOrigin: undefined,
        permissionMode: 'full-auto',
        model: 'gpt-5',
        reasoningEffort: undefined,
        turnBoundaryOnly: undefined,
        queueId: undefined,
        turnOwner: undefined,
        onTerminal: undefined,
        beforeDispatch: undefined,
        channelDelivery: {
          user: 'session-binding',
          assistant: 'session-binding',
        },
      },
    );
    expect(mocks.broadcast).not.toHaveBeenCalled();

    resolveDispatch({ queued: false, error: 'runtime failed' });
    await dispatch;
    await Promise.resolve();

    expect(mocks.broadcast).toHaveBeenCalledWith('chat:agent-error', { message: 'runtime failed' });
  });

  it('exposes external dispatch acceptance without delaying desktop response', async () => {
    mocks.state.useExternal = true;
    let resolveDispatch!: (result: { queued: boolean; error?: string }) => void;
    const dispatch = new Promise<{ queued: boolean; error?: string }>((resolve) => {
      resolveDispatch = resolve;
    });
    mocks.enqueueExternalSendForDesktop.mockReturnValueOnce({
      queued: true,
      queueId: 'xq-goal',
      dispatch,
    });

    const result = await getSessionEngine().sendDesktopMessage({
      text: 'continue Goal',
      sessionId: 'sid',
      workspacePath: '/workspace',
      scenario: desktopScenario,
    });

    expect(result).toMatchObject({ success: true, queued: true, queueId: 'xq-goal' });
    expect(result.dispatchAcceptance).toBeInstanceOf(Promise);

    resolveDispatch({ queued: false, error: 'runtime rejected Goal turn' });
    await expect(result.dispatchAcceptance).resolves.toEqual({
      accepted: false,
      error: 'runtime rejected Goal turn',
    });
    expect(mocks.broadcast).toHaveBeenCalledWith('chat:agent-error', {
      message: 'runtime rejected Goal turn',
    });
  });

  it('keeps stop fallback on builtin when external runtime is selected but inactive', async () => {
    mocks.state.useExternal = true;
    mocks.state.externalActive = false;

    const result = await stopActiveTurn();

    expect(result).toEqual({ success: true, alreadyStopped: true });
    expect(mocks.stopExternalSession).not.toHaveBeenCalled();
    expect(mocks.interruptCurrentResponse).toHaveBeenCalledTimes(1);
  });

  it('never falls back to builtin stop for an inactive DSH Session', async () => {
    mocks.state.useExternal = true;
    mocks.state.externalActive = false;
    mocks.getActiveRuntimeType.mockReturnValue('dsh');
    const previousRuntime = process.env.MYAGENTS_RUNTIME;
    process.env.MYAGENTS_RUNTIME = 'dsh';

    try {
      await expect(stopActiveTurn()).resolves.toEqual({ success: true, alreadyStopped: true });
      await expect(stopOwnedTurn({ kind: 'task', id: 'task-1' })).resolves.toEqual({
        success: true,
        alreadyStopped: true,
      });
    } finally {
      if (previousRuntime === undefined) delete process.env.MYAGENTS_RUNTIME;
      else process.env.MYAGENTS_RUNTIME = previousRuntime;
    }

    expect(mocks.interruptCurrentResponse).not.toHaveBeenCalled();
    expect(mocks.cancelQueuedTurnsByOwner).not.toHaveBeenCalled();
  });

  it('reports a failed external process stop instead of clearing it as stopped', async () => {
    mocks.state.useExternal = true;
    mocks.state.externalActive = true;
    mocks.stopExternalSession.mockResolvedValueOnce(false);

    await expect(stopActiveTurn()).resolves.toEqual({
      success: false,
      error: 'External runtime process did not stop',
    });
    expect(mocks.interruptCurrentResponse).not.toHaveBeenCalled();
  });

  it('persists Goal pause before stopping the active builtin Goal turn', async () => {
    mocks.state.builtinTurnIdentity = {
      queueId: 'goal-turn-1',
      owner: { kind: 'goal', id: 'goal-1' },
    };
    mocks.interruptCurrentResponse.mockResolvedValueOnce(true);

    await expect(stopActiveTurn()).resolves.toEqual({ success: true });

    expect(mocks.managementApi).toHaveBeenCalledWith('/api/goal/turn/pause', 'POST', {
      sessionId: 'builtin-session',
      workspacePath: '/workspace',
      goalId: 'goal-1',
      queueId: 'goal-turn-1',
    });
    expect(mocks.managementApi).toHaveBeenCalledWith('/api/goal/turn/abort', 'POST', {
      sessionId: 'builtin-session',
      workspacePath: '/workspace',
      goalId: 'goal-1',
      queueId: 'goal-turn-1',
    });
    expect(mocks.interruptCurrentResponse).toHaveBeenCalledOnce();
    expect(mocks.managementApi.mock.invocationCallOrder[0])
      .toBeLessThan(mocks.interruptCurrentResponse.mock.invocationCallOrder[0]);
    expect(mocks.interruptCurrentResponse.mock.invocationCallOrder[0])
      .toBeLessThan(mocks.managementApi.mock.invocationCallOrder[1]);
  });

  it('does not stop a Goal turn when its durable pause is rejected', async () => {
    mocks.state.builtinTurnIdentity = {
      queueId: 'goal-turn-1',
      owner: { kind: 'goal', id: 'goal-1' },
    };
    mocks.managementApi.mockResolvedValueOnce({ ok: false, error: 'stale turn' });

    await expect(stopActiveTurn()).resolves.toEqual({
      success: false,
      error: 'stale turn',
    });

    expect(mocks.interruptCurrentResponse).not.toHaveBeenCalled();
  });

  it.each(['complete', 'blocked'] as const)(
    'does not interrupt a Model-winning %s Goal turn',
    async (status) => {
      mocks.state.builtinTurnIdentity = {
        queueId: 'goal-turn-1',
        owner: { kind: 'goal', id: 'goal-1' },
      };
      mocks.managementApi.mockResolvedValueOnce({ ok: true, goal: { status } });

      await expect(stopActiveTurn()).resolves.toEqual({
        success: true,
        alreadyStopped: true,
      });

      expect(mocks.cancelQueueItem).not.toHaveBeenCalled();
      expect(mocks.interruptCurrentResponse).not.toHaveBeenCalled();
      expect(mocks.managementApi).toHaveBeenCalledTimes(1);
    },
  );

  it('keeps paused Goal authority when the exact runtime stop is not confirmed', async () => {
    mocks.state.builtinTurnIdentity = {
      queueId: 'goal-turn-1',
      owner: { kind: 'goal', id: 'goal-1' },
    };
    mocks.interruptCurrentResponse.mockResolvedValueOnce(false);

    await expect(stopActiveTurn()).resolves.toMatchObject({
      success: false,
      error: expect.stringContaining('Exact turn stop was not confirmed'),
    });

    expect(mocks.managementApi).toHaveBeenCalledTimes(1);
    expect(mocks.managementApi).not.toHaveBeenCalledWith(
      '/api/goal/turn/abort',
      expect.anything(),
      expect.anything(),
    );
  });

  it('cancels an external pre-claim Goal promotion without stopping the busy turn ahead of it', async () => {
    mocks.state.useExternal = true;
    mocks.state.externalActive = true;
    mocks.state.externalTurnIdentity = {
      queueId: 'goal-promotion',
      owner: { kind: 'goal', id: 'goal-1' },
    };
    mocks.cancelExternalQueueItem.mockReturnValueOnce({
      cancelledText: '',
      promotion: { settled: Promise.resolve({ status: 'not-dispatched' }) },
    });

    await expect(stopActiveTurn()).resolves.toEqual({ success: true });

    expect(mocks.cancelExternalQueueItem).toHaveBeenCalledWith('goal-promotion');
    expect(mocks.stopExternalSession).not.toHaveBeenCalled();
    expect(mocks.managementApi).toHaveBeenLastCalledWith('/api/goal/turn/abort', 'POST', {
      sessionId: 'external-session',
      workspacePath: '/workspace',
      goalId: 'goal-1',
      queueId: 'goal-promotion',
    });
  });

  it('keeps a shared pre-warmed process when owner cancellation settles before dispatch', async () => {
    mocks.state.useExternal = true;
    mocks.state.externalActive = true;
    mocks.state.externalTurnIdentity = {
      queueId: 'goal-prewarm-promotion',
      owner: { kind: 'goal', id: 'goal-1' },
    };
    mocks.cancelExternalQueuedTurnsByOwner.mockReturnValueOnce({
      count: 1,
      promotion: { settled: Promise.resolve({ status: 'not-dispatched' }) },
    });

    await expect(stopOwnedTurn({ kind: 'goal', id: 'goal-1' })).resolves.toEqual({
      success: true,
      alreadyStopped: false,
    });

    expect(mocks.stopExternalSession).not.toHaveBeenCalled();
  });

  it('stops only the exact Goal queue item during objective replacement', async () => {
    mocks.state.builtinTurnIdentity = {
      queueId: 'goal-old-turn',
      owner: { kind: 'goal', id: 'goal-1' },
    };
    mocks.cancelQueueItem.mockResolvedValueOnce({ status: 'not_found' });
    mocks.interruptCurrentResponse.mockResolvedValueOnce(true);

    await expect(stopOwnedTurnByQueueId(
      { kind: 'goal', id: 'goal-1' },
      'goal-old-turn',
    )).resolves.toEqual({ success: true });

    expect(mocks.cancelQueueItem).toHaveBeenCalledWith('goal-old-turn');
    expect(mocks.interruptCurrentResponse).toHaveBeenCalledOnce();
    expect(mocks.cancelQueuedTurnsByOwner).not.toHaveBeenCalled();
  });

  it('does not let a stale Task stop interrupt a newer queue generation', async () => {
    mocks.state.builtinTurnIdentity = {
      queueId: 'task-new-turn',
      owner: { kind: 'task', id: 'task-1' },
    };
    mocks.cancelQueueItem.mockResolvedValueOnce({ status: 'not_found' });

    await expect(stopOwnedTurnByQueueId(
      { kind: 'task', id: 'task-1' },
      'task-old-turn',
    )).resolves.toEqual({ success: true, alreadyStopped: true });

    expect(mocks.cancelQueueItem).toHaveBeenCalledWith('task-old-turn');
    expect(mocks.interruptCurrentResponse).not.toHaveBeenCalled();
    expect(mocks.cancelQueuedTurnsByOwner).not.toHaveBeenCalled();
  });

  it('preserves later external queue work when stopping the exact current Task turn', async () => {
    mocks.state.useExternal = true;
    mocks.state.externalActive = true;
    mocks.state.externalTurnIdentity = {
      queueId: 'task-current-turn',
      owner: { kind: 'task', id: 'task-1' },
    };
    mocks.cancelExternalQueueItem.mockReturnValueOnce(null);
    mocks.stopExternalSession.mockResolvedValueOnce(true);

    await expect(stopOwnedTurnByQueueId(
      { kind: 'task', id: 'task-1' },
      'task-current-turn',
    )).resolves.toEqual({ success: true, alreadyStopped: false });

    expect(mocks.stopExternalSession).toHaveBeenCalledWith({ preserveQueue: true });
  });

  it.each(['not_cancelled', 'unavailable', 'error'] as const)(
    'does not confirm a queued Task stop when cancellation returns %s',
    async (status) => {
      mocks.state.builtinTurnIdentity = null;
      mocks.cancelQueueItem.mockResolvedValueOnce({ status });

      await expect(stopOwnedTurnByQueueId(
        { kind: 'task', id: 'task-1' },
        'task-in-flight-to-sdk',
      )).resolves.toMatchObject({
        success: false,
        error: expect.stringContaining('Exact turn stop was not confirmed'),
      });

      expect(mocks.cancelQueueItem).toHaveBeenCalledWith('task-in-flight-to-sdk');
      expect(mocks.interruptCurrentResponse).not.toHaveBeenCalled();
    },
  );

  it('cancels a queued builtin injected turn when the synchronous wait times out', async () => {
    mocks.enqueueUserMessage.mockResolvedValueOnce({
      queued: true,
      queueId: 'q-timeout',
      isInFlight: false,
      deliveryMode: 'queue',
      dispatchAcceptance: Promise.resolve({ accepted: true }),
    });
    mocks.cancelQueueItem.mockResolvedValueOnce({
      status: 'cancelled',
      cancelledText: 'run cron',
    });
    const result = await runInjectedTurn({
      prompt: 'run cron',
      sessionId: 'sid',
      workspacePath: '/workspace',
      scenario: { type: 'cron', taskId: 'task-1', intervalMinutes: 15, aiCanExit: false },
      permissionMode: 'fullAgency',
      timeoutMs: 20,
      pollMs: 1,
      queueId: 'q-timeout',
    });

    expect(result).toMatchObject({
      success: false,
      enqueued: true,
      status: 408,
      error: 'Execution timed out',
    });
    expect(mocks.cancelQueueItem).toHaveBeenCalledWith('q-timeout');
    expect(mocks.interruptCurrentResponse).not.toHaveBeenCalled();
  });

  it('reports a product skill rejection after HTTP queue admission without treating it as execution success', async () => {
    mocks.requireCurrentBuiltinSkill.mockRejectedValueOnce(new Error('alignment inventory stale'));
    const result = await getSessionEngine().sendDesktopMessage({ text: 'original requirement', sessionId: 'sid', workspacePath: '/workspace', scenario: desktopScenario, requiredSystemSkill: TASK_ALIGNMENT_SKILL_REQUIREMENT });
    expect(result).toMatchObject({ success: true, queued: true });
    await expect(result.dispatchAcceptance).resolves.toMatchObject({ accepted: false, error: 'alignment inventory stale' });
    expect(mocks.requireCurrentBuiltinSkill).toHaveBeenCalledWith(TASK_ALIGNMENT_SKILL_REQUIREMENT);
    expect(mocks.broadcast).toHaveBeenCalledWith('chat:agent-error', { message: 'alignment inventory stale' });
  });

  it('checks an injected turn Required Skill inside the builtin adapter', async () => {
    mocks.requireCurrentBuiltinSkill.mockRejectedValueOnce(new Error('required Skill missing'));

    const result = await runInjectedTurn({
      prompt: 'update memory',
      sessionId: 'sid',
      workspacePath: '/workspace',
      scenario: desktopScenario,
      permissionMode: 'fullAgency',
      timeoutMs: 1_000,
      requiredSystemSkill: 'myagents-memory-update',
    });

    expect(result).toMatchObject({
      success: false,
      enqueued: false,
      status: 409,
      error: 'required Skill missing',
    });
    expect(mocks.requireCurrentBuiltinSkill).toHaveBeenCalledWith('myagents-memory-update');
  });

  it('waits for an in-flight domain claim and durable abort before publishing dispatch-timeout rejection', async () => {
    let releaseClaim!: () => void;
    let releaseAbort!: () => void;
    let markClaimStarted!: () => void;
    let markAbortStarted!: () => void;
    const claimStarted = new Promise<void>((resolve) => { markClaimStarted = resolve; });
    const abortStarted = new Promise<void>((resolve) => { markAbortStarted = resolve; });
    const claim = new Promise<void>((resolve) => { releaseClaim = resolve; });
    const abortAcknowledged = new Promise<void>((resolve) => { releaseAbort = resolve; });
    const domainGuard = Object.assign(
      vi.fn(async () => {
        markClaimStarted();
        await claim;
        return { accepted: true };
      }),
      {
        cancel: vi.fn(async () => {
          await claim;
          markAbortStarted();
          await abortAcknowledged;
        }),
      },
    );
    let runtimeGuard!: {
      cancel?: () => void | Promise<void>;
    };
    mocks.enqueueUserMessage.mockImplementationOnce(async (...args: unknown[]) => {
      const options = args[11] as {
        queueId: string;
        beforeDispatch: (() => Promise<{ accepted: boolean }>) & {
          cancel?: () => void | Promise<void>;
        };
      };
      runtimeGuard = options.beforeDispatch;
      return {
        queued: true,
        queueId: options.queueId,
        dispatchAcceptance: options.beforeDispatch(),
      };
    });
    mocks.cancelQueueItem.mockImplementationOnce(async () => {
      await runtimeGuard.cancel?.();
      return {
        status: 'cancelled',
        cancelledText: 'continue goal',
      };
    });

    let resultSettled = false;
    const pendingResult = runInjectedTurn({
      prompt: 'continue goal',
      sessionId: 'sid',
      workspacePath: '/workspace',
      scenario: { type: 'desktop' },
      permissionMode: 'fullAgency',
      timeoutMs: 20,
      queueId: 'goal-claim-timeout',
      beforeDispatch: domainGuard,
    }).then((result) => {
      resultSettled = true;
      return result;
    });

    await claimStarted;
    await vi.waitFor(() => expect(domainGuard.cancel).toHaveBeenCalled());
    expect(resultSettled).toBe(false);

    releaseClaim();
    await abortStarted;
    expect(resultSettled).toBe(false);

    releaseAbort();
    await expect(pendingResult).resolves.toMatchObject({
      success: false,
      enqueued: false,
      status: 408,
      error: 'Builtin injected turn timed out before dispatch',
    });
    expect(domainGuard.cancel).toHaveBeenCalledOnce();
    expect(mocks.cancelQueueItem).toHaveBeenCalledWith('goal-claim-timeout');
  });

  it('interrupts an active builtin injected turn when its deadline expires', async () => {
    mocks.enqueueUserMessage.mockResolvedValueOnce({
      queued: false,
      queueId: 'q-active',
      isInFlight: true,
      deliveryMode: 'realtime',
      dispatchAcceptance: Promise.resolve({ accepted: true }),
    });
    mocks.state.builtinTurnIdentity = {
      queueId: 'q-active',
      owner: { kind: 'goal', id: 'goal-1' },
    };
    mocks.interruptCurrentResponse.mockResolvedValueOnce(true);

    const result = await runInjectedTurn({
      prompt: 'continue goal',
      sessionId: 'sid',
      workspacePath: '/workspace',
      scenario: { type: 'desktop' },
      permissionMode: 'fullAgency',
      timeoutMs: 20,
      pollMs: 1,
      queueId: 'q-active',
      turnOwner: { kind: 'goal', id: 'goal-1' },
    });

    expect(result).toMatchObject({
      success: false,
      enqueued: true,
      status: 408,
      error: 'Execution timed out',
    });
    expect(mocks.interruptCurrentResponse).toHaveBeenCalledWith('timeout');
  });

  it('interrupts an ownerless Heartbeat/Memory turn after active admission', async () => {
    mocks.enqueueUserMessage.mockResolvedValueOnce({
      queued: false,
      queueId: 'q-ownerless-active',
      isInFlight: false,
      deliveryMode: 'turn',
      dispatchAcceptance: Promise.resolve({ accepted: true }),
    });
    mocks.state.builtinDispatchedQueueId = 'q-ownerless-active';
    mocks.interruptCurrentResponse.mockResolvedValueOnce(true);

    const result = await runInjectedTurn({
      prompt: 'heartbeat maintenance',
      sessionId: 'sid',
      workspacePath: '/workspace',
      scenario: { type: 'desktop' },
      permissionMode: 'fullAgency',
      timeoutMs: 20,
      pollMs: 1,
      queueId: 'q-ownerless-active',
    });

    expect(result).toMatchObject({
      success: false,
      enqueued: true,
      status: 408,
    });
    expect(mocks.interruptCurrentResponse).toHaveBeenCalledWith('timeout');
  });

  it('reports an unconfirmed builtin termination when the exact turn cannot be interrupted', async () => {
    mocks.enqueueUserMessage.mockResolvedValueOnce({
      queued: false,
      queueId: 'q-orphan',
      isInFlight: true,
      deliveryMode: 'realtime',
      dispatchAcceptance: Promise.resolve({ accepted: true }),
    });
    mocks.state.builtinTurnIdentity = {
      queueId: 'q-orphan',
      owner: { kind: 'task', id: 'task-1' },
    };
    mocks.interruptCurrentResponse.mockResolvedValueOnce(false);

    const result = await runInjectedTurn({
      prompt: 'scheduled turn',
      sessionId: 'sid',
      workspacePath: '/workspace',
      scenario: { type: 'desktop' },
      permissionMode: 'fullAgency',
      timeoutMs: 20,
      pollMs: 1,
      queueId: 'q-orphan',
      turnOwner: { kind: 'task', id: 'task-1' },
    });

    expect(result).toMatchObject({
      success: false,
      status: 408,
      terminationUnconfirmed: true,
    });
    expect(mocks.interruptCurrentResponse).toHaveBeenCalledWith('timeout');
  });

  it('does not interrupt an unrelated builtin turn after the injected turn loses the idle race', async () => {
    mocks.enqueueUserMessage.mockResolvedValueOnce({
      queued: false,
      queueId: 'q-finished',
      isInFlight: true,
      deliveryMode: 'realtime',
      dispatchAcceptance: Promise.resolve({ accepted: true }),
    });
    mocks.cancelQueueItem.mockResolvedValueOnce({ status: 'not_found' });

    const result = await runInjectedTurn({
      prompt: 'scheduled turn',
      sessionId: 'sid',
      workspacePath: '/workspace',
      scenario: { type: 'desktop' },
      permissionMode: 'fullAgency',
      timeoutMs: 1,
      pollMs: 1,
      queueId: 'q-finished',
    });

    expect(result).toMatchObject({ success: false, status: 408 });
    expect(mocks.cancelQueueItem).toHaveBeenCalledWith('q-finished');
    expect(mocks.interruptCurrentResponse).not.toHaveBeenCalled();
  });

  it('clears stale builtin agent errors before starting an injected turn', async () => {
    mocks.getAndClearLastAgentError.mockReturnValueOnce('stale previous error');

    const result = await runInjectedTurn({
      prompt: 'heartbeat',
      sessionId: 'sid',
      workspacePath: '/workspace',
      scenario: { type: 'desktop' },
      permissionMode: 'fullAgency',
      timeoutMs: 1000,
      pollMs: 50,
    });

    expect(result).toMatchObject({ success: true, text: 'builtin answer' });
    expect(mocks.getAndClearLastAgentError).toHaveBeenCalledTimes(1);
    expect(mocks.getAndClearLastAgentError.mock.invocationCallOrder[0])
      .toBeLessThan(mocks.enqueueUserMessage.mock.invocationCallOrder[0]);
  });

  it('does not install an injected-turn-specific MCP admission gate', async () => {
    const result = await runInjectedTurn({
      prompt: 'heartbeat',
      sessionId: 'sid',
      workspacePath: '/workspace',
      scenario: { type: 'desktop' },
      permissionMode: 'fullAgency',
      timeoutMs: 1_000,
    });

    expect(result).toMatchObject({ success: true, enqueued: true });
    expect(mocks.enqueueUserMessage.mock.calls[0]?.[11]).not.toHaveProperty('beforeUserPersistence');
    expect(mocks.enqueueUserMessage.mock.calls[0]?.[11]).toMatchObject({
      beforeDispatch: expect.any(Function),
    });
  });

  it('preserves the domain dispatch guard as the only injected-turn guard', async () => {
    const domainGuard = Object.assign(vi.fn(async () => ({ accepted: true })), {
      cancel: vi.fn(),
    });

    const result = await runInjectedTurn({
      prompt: 'run cron',
      sessionId: 'sid',
      workspacePath: '/workspace',
      scenario: { type: 'cron', taskId: 'task-1', intervalMinutes: 15, aiCanExit: false },
      permissionMode: 'fullAgency',
      timeoutMs: 1_000,
      beforeDispatch: domainGuard,
    });

    expect(result).toMatchObject({ success: true, enqueued: true });
    expect(mocks.enqueueUserMessage).toHaveBeenCalledTimes(1);
    expect(mocks.enqueueUserMessage.mock.calls[0]?.[11]).not.toHaveProperty('beforeUserPersistence');
    expect(mocks.enqueueUserMessage.mock.calls[0]?.[11]).toEqual(expect.objectContaining({
      beforeDispatch: domainGuard,
    }));
    expect(domainGuard).toHaveBeenCalledOnce();
  });

  it('leaves external injected turns outside the builtin MCP readiness gate', async () => {
    mocks.state.useExternal = true;

    await runInjectedTurn({
      prompt: 'heartbeat',
      sessionId: 'sid',
      workspacePath: '/workspace',
      scenario: { type: 'desktop' },
      permissionMode: 'no-restrictions',
      timeoutMs: 1_000,
    });

    expect(mocks.enqueueUserMessage).not.toHaveBeenCalled();
    expect(mocks.sendExternalMessage).toHaveBeenCalled();
  });

  it.each([
    { metadataBirthPending: true, expected: true },
    { metadataBirthPending: undefined, expected: false },
  ])(
    'maps builtin injected-turn birth authority to lazy materialization: $expected',
    async ({ metadataBirthPending, expected }) => {
      await runInjectedTurn({
        prompt: 'heartbeat',
        sessionId: 'sid',
        workspacePath: '/workspace',
        scenario: { type: 'agent-channel', platform: 'feishu', sourceType: 'private' },
        metadataBirthPending,
        permissionMode: 'fullAgency',
        timeoutMs: 1000,
      });

      expect(mocks.enqueueUserMessage.mock.calls[0][11]).toMatchObject({
        allowLazySessionMaterialization: expected,
      });
    },
  );

  it('uses the queue item terminal observer instead of global message history', async () => {
    mocks.enqueueUserMessage.mockImplementationOnce(async (...args: unknown[]) => {
      const options = args[11] as {
        queueId: string;
        beforeDispatch?: () => Promise<{
          accepted: boolean;
          validateAtCommit?: () => { accepted: boolean; error?: string };
        }>;
        onTerminal: (outcome: { status: 'complete'; assistantMessagePresent: boolean; text: string }) => void;
      };
      const dispatchAcceptance = options.beforeDispatch
        ? options.beforeDispatch().then(result => (
          result.accepted && result.validateAtCommit ? result.validateAtCommit() : result
        ))
        : Promise.resolve({ accepted: true });
      queueMicrotask(() => {
        void dispatchAcceptance.then(acceptance => {
          if (!acceptance.accepted) return;
          options.onTerminal({
            status: 'complete',
            assistantMessagePresent: true,
            text: '',
          });
        });
      });
      return { queued: true, queueId: options.queueId, dispatchAcceptance };
    });
    const result = await runInjectedTurn({
      prompt: 'memory update',
      sessionId: 'sid',
      workspacePath: '/workspace',
      scenario: { type: 'desktop' },
      permissionMode: 'fullAgency',
      timeoutMs: 1000,
      pollMs: 50,
    });

    expect(result).toMatchObject({
      success: true,
      enqueued: true,
      assistantMessagePresent: true,
      text: '',
    });
    expect(mocks.enqueueUserMessage.mock.calls[0][11]).toMatchObject({
      queueId: expect.any(String),
      onTerminal: expect.any(Function),
    });
  });

  it('forces every synchronous injected turn onto a turn boundary', async () => {
    const result = await runInjectedTurn({
      prompt: 'continue goal',
      sessionId: 'sid',
      workspacePath: '/workspace',
      scenario: { type: 'desktop' },
      permissionMode: 'fullAgency',
      timeoutMs: 1000,
      pollMs: 1,
      queueId: 'goal-queue',
      turnOwner: { kind: 'goal', id: 'goal-1' },
    });

    expect(result.success).toBe(true);
    expect(mocks.enqueueUserMessage.mock.calls[0][11]).toMatchObject({
      queueId: 'goal-queue',
      turnOwner: { kind: 'goal', id: 'goal-1' },
      onTerminal: expect.any(Function),
      queueResponseModeOverride: 'turn',
    });
  });

  it('restores Goal MCP from the session snapshot only when the active set is uninitialized', async () => {
    mocks.getMcpServers.mockReturnValueOnce(null as never);

    const result = await getSessionEngine().prepareScheduledTurn({
      sessionId: 'builtin-session',
      workspacePath: '/workspace',
      scenario: { type: 'desktop' },
      operation: { kind: 'goal', permissionMode: 'fullAgency' },
    });

    expect(result).toMatchObject({
      success: true,
      sessionId: 'builtin-session',
      permissionMode: 'fullAgency',
    });
    expect(mocks.resolveWorkspaceConfig).toHaveBeenCalledWith(
      '/workspace',
      expect.objectContaining({ id: 'builtin-session' }),
      { includeMcp: true },
    );
    expect(mocks.applyMcpOverrideAndAwaitReady).toHaveBeenCalledWith([{ id: 'snapshot-mcp' }]);
  });

  it('preserves an initialized empty Goal MCP set', async () => {
    mocks.getMcpServers.mockReturnValueOnce([]);

    const result = await getSessionEngine().prepareScheduledTurn({
      sessionId: 'builtin-session',
      workspacePath: '/workspace',
      scenario: { type: 'desktop' },
      operation: { kind: 'goal', permissionMode: 'fullAgency' },
    });

    expect(result).toMatchObject({ success: true, sessionId: 'builtin-session' });
    expect(mocks.resolveWorkspaceConfig).not.toHaveBeenCalled();
    expect(mocks.applyMcpOverrideAndAwaitReady).not.toHaveBeenCalled();
  });

  it('prepares an existing builtin Task without route-level runtime branching', async () => {
    const beforeDispatch = vi.fn(async () => ({ accepted: true }));
    const result = await getSessionEngine().prepareScheduledTurn({
      sessionId: 'builtin-session',
      workspacePath: '/workspace',
      scenario: {
        type: 'cron',
        taskId: 'task-1',
        intervalMinutes: 15,
        aiCanExit: false,
      },
      operation: {
        kind: 'task',
        initializeSession: false,
        model: 'claude-sonnet',
        permissionMode: 'fullAgency',
        beforeDispatch,
      },
    });

    expect(result).toMatchObject({
      success: true,
      sessionId: 'builtin-session',
      permissionMode: 'fullAgency',
      model: 'claude-sonnet',
      beforeDispatch,
    });
    expect(mocks.switchToSession).not.toHaveBeenCalled();
    expect(mocks.setInteractionScenario).toHaveBeenCalledWith(expect.objectContaining({
      type: 'cron',
      taskId: 'task-1',
    }));
  });

  it.each([
    [
      'Task override',
      true,
      'provider-task',
      undefined,
      "Task 'task-route-owner'",
    ],
    [
      'Agent default',
      true,
      undefined,
      { id: 'agent-route-owner' },
      "Agent 'agent-route-owner'",
    ],
    [
      'Session snapshot',
      false,
      undefined,
      { id: 'agent-route-owner' },
      "Session 'builtin-session'",
    ],
  ])('attributes a disabled provider inherited from %s to the real owner', async (
    _label,
    initializeSession,
    operationProviderId,
    agent,
    expectedOwner,
  ) => {
    mocks.state.providerDisabled = true;
    mocks.findProjectAgentByWorkspacePath.mockReturnValue(agent);
    mocks.state.sessionMetadata.set('builtin-session', {
      id: 'builtin-session',
      providerId: operationProviderId ?? 'provider-inherited',
      model: 'model-1',
      providerRoute: {
        kind: 'provider',
        providerId: operationProviderId ?? 'provider-inherited',
        model: 'model-1',
      },
    });

    const result = await getSessionEngine().prepareScheduledTurn({
      sessionId: 'builtin-session',
      workspacePath: '/workspace',
      scenario: {
        type: 'cron',
        taskId: 'task-route-owner',
        intervalMinutes: 15,
        aiCanExit: false,
      },
      operation: {
        kind: 'task',
        initializeSession,
        ...(operationProviderId
          ? { providerId: operationProviderId, model: 'model-1' }
          : {}),
        beforeDispatch: vi.fn(async () => ({ accepted: true })),
      },
    });

    expect(result).toMatchObject({
      success: false,
      code: 'configuration_failed',
      status: 400,
    });
    expect(result.error).toContain(expectedOwner);
  });

  it('retains owner recovery when a provider becomes unavailable at final dispatch', async () => {
    const scenario = {
      type: 'cron' as const,
      taskId: 'task-route-race',
      intervalMinutes: 15,
      aiCanExit: false,
    };
    const prepared = await getSessionEngine().prepareScheduledTurn({
      sessionId: 'builtin-session',
      workspacePath: '/workspace',
      scenario,
      operation: {
        kind: 'task',
        initializeSession: true,
        providerId: 'provider-race',
        model: 'model-1',
        beforeDispatch: vi.fn(async () => ({ accepted: true })),
      },
    });

    expect(prepared).toMatchObject({
      success: true,
      providerRoutingRecovery: expect.stringContaining("Task 'task-route-race'"),
    });

    const result = await runInjectedTurn({
      prompt: 'run task',
      sessionId: 'builtin-session',
      workspacePath: '/workspace',
      scenario,
      model: prepared.model,
      providerEnv: prepared.providerEnv,
      providerRoute: prepared.providerRoute,
      providerRoutingRecovery: prepared.providerRoutingRecovery,
      timeoutMs: 1_000,
    });

    expect(result).toMatchObject({ success: false, enqueued: false, status: 409 });
    expect(result.error).toContain("Task 'task-route-race'");
    await prepared.release?.();
  });

  it('reconciles a new builtin Task Session to its exact MCP override before dispatch', async () => {
    const beforeDispatch = vi.fn(async () => ({ accepted: true }));
    const result = await getSessionEngine().prepareScheduledTurn({
      sessionId: 'builtin-session',
      workspacePath: '/workspace',
      scenario: {
        type: 'cron',
        taskId: 'task-new',
        intervalMinutes: 15,
        aiCanExit: false,
      },
      operation: {
        kind: 'task',
        initializeSession: true,
        mcpEnabledServers: [],
        beforeDispatch,
      },
    });

    expect(result.success).toBe(true);
    expect(mocks.applyMcpOverrideAndAwaitReady).toHaveBeenCalledWith([]);
  });

  it('preserves the Task MCP preparation failure as HTTP 500 semantics', async () => {
    mocks.applyMcpOverrideAndAwaitReady.mockRejectedValueOnce(new Error('MCP restart failed'));

    const result = await getSessionEngine().prepareScheduledTurn({
      sessionId: 'builtin-session',
      workspacePath: '/workspace',
      scenario: {
        type: 'cron',
        taskId: 'task-mcp-failure',
        intervalMinutes: 15,
        aiCanExit: false,
      },
      operation: {
        kind: 'task',
        initializeSession: true,
        mcpEnabledServers: [],
        beforeDispatch: vi.fn(async () => ({ accepted: true })),
      },
    });

    expect(result).toEqual({
      success: false,
      code: 'configuration_failed',
      status: 500,
      error: 'MCP restart failed',
    });
    expect(mocks.resetInteractionScenario).toHaveBeenCalledOnce();
  });

  it('binds and prepares an external Task with runtime-native config', async () => {
    mocks.state.useExternal = true;
    mocks.isExternalSessionStateRestoredFor.mockReturnValue(false);
    const beforeDispatch = vi.fn(async () => ({ accepted: true }));
    const result = await getSessionEngine().prepareScheduledTurn({
      sessionId: 'external-session',
      workspacePath: '/workspace',
      scenario: {
        type: 'cron',
        taskId: 'task-1',
        intervalMinutes: 15,
        aiCanExit: false,
      },
      operation: {
        kind: 'task',
        initializeSession: false,
        permissionMode: 'no-restrictions',
        runtimeConfig: { model: 'gpt-5', permissionMode: 'no-restrictions' },
        beforeDispatch,
      },
    });

    expect(result).toMatchObject({
      success: true,
      sessionId: 'external-session',
      permissionMode: 'no-restrictions',
      model: 'gpt-5',
      beforeDispatch,
    });
    expect(mocks.restoreExternalSessionState).toHaveBeenCalledWith(
      'external-session',
      '/workspace',
      expect.objectContaining({ type: 'cron', taskId: 'task-1' }),
    );
  });

  it('does not overwrite a coherently bound external Session before a scheduled turn', async () => {
    mocks.state.useExternal = true;
    mocks.getCurrentBoundSessionId.mockReturnValue('external-session');
    mocks.isExternalSessionStateRestoredFor.mockReturnValue(true);

    const result = await getSessionEngine().prepareScheduledTurn({
      sessionId: 'external-session',
      workspacePath: '/workspace',
      scenario: {
        type: 'cron',
        taskId: 'task-live',
        intervalMinutes: 15,
        aiCanExit: false,
      },
      operation: {
        kind: 'task',
        initializeSession: false,
        beforeDispatch: vi.fn(async () => ({ accepted: true })),
      },
    });

    expect(result.success).toBe(true);
    expect(mocks.stopExternalSession).not.toHaveBeenCalled();
    expect(mocks.restoreExternalSessionState).not.toHaveBeenCalled();
  });

  it('repairs only the product binding when the external runtime already owns the target Session', async () => {
    mocks.state.useExternal = true;
    mocks.getCurrentBoundSessionId.mockReturnValue('external-session');
    mocks.isExternalSessionStateRestoredFor.mockReturnValue(true);
    await resetProductSessionBinding({ sessionId: 'stale-product-session', workspacePath: '/workspace' });

    const result = await getSessionEngine().prepareScheduledTurn({
      sessionId: 'external-session',
      workspacePath: '/workspace',
      scenario: {
        type: 'cron',
        taskId: 'task-binding',
        intervalMinutes: 15,
        aiCanExit: false,
      },
      operation: {
        kind: 'task',
        initializeSession: false,
        beforeDispatch: vi.fn(async () => ({ accepted: true })),
      },
    });

    expect(result.success).toBe(true);
    expect(getCurrentProductSessionId()).toBe('external-session');
    expect(mocks.stopExternalSession).not.toHaveBeenCalled();
    expect(mocks.restoreExternalSessionState).not.toHaveBeenCalled();
  });

  it('fails closed before rebinding when an external scheduled Session is missing', async () => {
    mocks.state.useExternal = true;
    mocks.state.sessionMetadata.delete('missing-external-session');

    const result = await getSessionEngine().prepareScheduledTurn({
      sessionId: 'missing-external-session',
      workspacePath: '/workspace',
      scenario: {
        type: 'cron',
        taskId: 'task-missing',
        intervalMinutes: 15,
        aiCanExit: false,
      },
      operation: {
        kind: 'task',
        initializeSession: false,
        beforeDispatch: vi.fn(async () => ({ accepted: true })),
      },
    });

    expect(result).toEqual({
      success: false,
      code: 'session_bind_failed',
      status: 409,
    });
    expect(mocks.stopExternalSession).not.toHaveBeenCalled();
    expect(mocks.restoreExternalSessionState).not.toHaveBeenCalled();
  });

  it('propagates a builtin queue item terminal error without reading stale history', async () => {
    mocks.enqueueUserMessage.mockImplementationOnce(async (...args: unknown[]) => {
      const options = args[11] as {
        queueId: string;
        beforeDispatch?: () => Promise<{
          accepted: boolean;
          validateAtCommit?: () => { accepted: boolean; error?: string };
        }>;
        onTerminal: (outcome: { status: 'error'; assistantMessagePresent: false; text: string; error: string }) => void;
      };
      const dispatchAcceptance = options.beforeDispatch
        ? options.beforeDispatch().then(result => (
          result.accepted && result.validateAtCommit ? result.validateAtCommit() : result
        ))
        : Promise.resolve({ accepted: true });
      queueMicrotask(() => {
        void dispatchAcceptance.then(acceptance => {
          if (!acceptance.accepted) return;
          options.onTerminal({
            status: 'error',
            assistantMessagePresent: false,
            text: '',
            error: 'turn failed',
          });
        });
      });
      return { queued: true, queueId: options.queueId, dispatchAcceptance };
    });
    const result = await runInjectedTurn({
      prompt: 'memory update',
      sessionId: 'sid',
      workspacePath: '/workspace',
      scenario: { type: 'desktop' },
      permissionMode: 'fullAgency',
      timeoutMs: 1000,
      pollMs: 50,
    });

    expect(result).toMatchObject({
      success: false,
      enqueued: true,
      status: 503,
      error: 'turn failed',
    });
  });

  it('gates external injected turns on their turn-local outcome', async () => {
    mocks.state.useExternal = true;
    mocks.sendExternalMessage.mockImplementationOnce(async (...args: unknown[]) => {
      const context = args[4] as {
        onTerminal: (outcome: { status: 'error'; assistantMessagePresent: false; text: string; error: string }) => void;
      };
      queueMicrotask(() => context.onTerminal({
        status: 'error',
        assistantMessagePresent: false,
        text: '',
        error: 'target turn failed',
      }));
      return { queued: true };
    });

    const result = await runInjectedTurn({
      prompt: 'update memory',
      sessionId: 'sid',
      workspacePath: '/workspace',
      scenario: { type: 'desktop' },
      permissionMode: 'no-restrictions',
      timeoutMs: 1000,
      pollMs: 50,
    });

    expect(result).toMatchObject({
      success: false,
      enqueued: true,
      status: 503,
      error: 'target turn failed',
    });
    expect(mocks.getLastExternalAssistantText).not.toHaveBeenCalled();
    expect(mocks.didLastTurnSucceed).not.toHaveBeenCalled();
  });

  it('does not attribute a subsequent external global snapshot to the queue turn', async () => {
    mocks.state.useExternal = true;
    mocks.didLastTurnSucceed.mockReturnValueOnce(false);
    mocks.getLastExternalAssistantText.mockReturnValueOnce('later user turn answer');

    const result = await runInjectedTurn({
      prompt: 'update memory',
      sessionId: 'sid',
      workspacePath: '/workspace',
      scenario: { type: 'desktop' },
      permissionMode: 'no-restrictions',
      timeoutMs: 1000,
      pollMs: 1,
    });

    expect(result).toMatchObject({
      success: true,
      enqueued: true,
      text: 'external answer',
    });
    expect(mocks.didLastTurnSucceed).not.toHaveBeenCalled();
    expect(mocks.getLastExternalAssistantText).not.toHaveBeenCalled();
  });

  it('forwards model sync source options to the external engine', async () => {
    mocks.state.useExternal = true;

    const result = await getSessionEngine().updateModel('channel-model', { imConfigSync: true });

    expect(result).toEqual({ success: true });
    expect(mocks.setExternalModel).toHaveBeenCalledWith('channel-model', { imConfigSync: true });
  });
  it('applies an explicit model pair through the builtin Session owner', async () => {
    mocks.state.useExternal = false;
    const input = { model: 'model-two', reasoningEffort: 'high' };
    expect(await getSessionEngine().applyModelSelection(input)).toEqual({ success: true, status: 'applied' });
    expect(mocks.applySessionModelSelection).toHaveBeenCalledWith(input);
  });

  it('queues a busy external model edit using snapshot authority without permission changes', async () => {
    mocks.state.useExternal = true;
    mocks.updateExternalRuntimeConfig.mockResolvedValue({ success: true, runtime: 'codex', status: 'queued', warnings: [] });
    expect(await getSessionEngine().applyModelSelection({ model: 'model-two', reasoningEffort: 'high' }))
      .toMatchObject({ success: true, status: 'pending-next-turn' });
    expect(mocks.updateExternalRuntimeConfig).toHaveBeenCalledWith(
      { model: 'model-two', reasoningEffort: 'high' }, { source: 'message-snapshot' });
  });

  it('passes metadataBirthPending into external IM admission', async () => {
    mocks.state.useExternal = true;

    await getSessionEngine().enqueueImMessage({
      message: 'hello from im',
      requestId: 'req-1',
      sessionId: 'sid',
      workspacePath: '/workspace',
      scenario: { type: 'agent-channel', platform: 'feishu', sourceType: 'private' },
      metadataBirthPending: true,
    });

    expect(mocks.enqueueExternalSendForIm).toHaveBeenCalledWith(
      'hello from im',
      undefined,
      expect.objectContaining({
        sessionId: 'sid',
        workspacePath: '/workspace',
        requestId: 'req-1',
        metadataBirthPending: true,
        channelDelivery: {
          user: 'none',
          assistant: 'reply-router',
        },
      }),
    );
  });

  it('accepts a busy external IM turn without waiting for its queued dispatch', async () => {
    mocks.state.useExternal = true;
    let resolveDispatch!: (result: { queued: boolean; error?: string }) => void;
    const dispatch = new Promise<{ queued: boolean; error?: string }>((resolve) => {
      resolveDispatch = resolve;
    });
    mocks.enqueueExternalSendForIm.mockReturnValueOnce({
      queued: true,
      queueId: 'xq-im-follow-up',
      dispatch,
    });

    const result = await getSessionEngine().enqueueImMessage({
      message: 'follow-up while running',
      requestId: 'req-follow-up',
      sessionId: 'sid',
      workspacePath: '/workspace',
      scenario: { type: 'agent-channel', platform: 'feishu', sourceType: 'private' },
    });

    expect(result).toMatchObject({ success: true, queued: true });
    expect(result.dispatchAcceptance).toBeInstanceOf(Promise);

    let acceptanceSettled = false;
    void result.dispatchAcceptance?.then(() => { acceptanceSettled = true; });
    await Promise.resolve();
    expect(acceptanceSettled).toBe(false);

    resolveDispatch({ queued: true });
    await expect(result.dispatchAcceptance).resolves.toEqual({ accepted: true });
  });

  it.each([
    { metadataBirthPending: true, expected: true },
    { metadataBirthPending: undefined, expected: false },
  ])(
    'maps external injected-turn birth authority to runtime materialization: $expected',
    async ({ metadataBirthPending, expected }) => {
      mocks.state.useExternal = true;

      await runInjectedTurn({
        prompt: 'heartbeat',
        assistantChannelDelivery: 'caller-owned',
        sessionId: 'sid',
        workspacePath: '/workspace',
        scenario: { type: 'agent-channel', platform: 'feishu', sourceType: 'private' },
        metadataBirthPending,
        permissionMode: 'no-restrictions',
        timeoutMs: 1000,
      });

      expect(mocks.sendExternalMessage).toHaveBeenCalledWith(
        'heartbeat',
        undefined,
        undefined,
        undefined,
        expect.objectContaining({
          sessionId: 'sid',
          workspacePath: '/workspace',
          metadataBirthPending: expected,
          channelDelivery: {
            user: 'none',
            assistant: 'caller-owned',
          },
        }),
      );
    },
  );

  it('updates official tool ids through the builtin engine owner', async () => {
    const result = await getSessionEngine().updateOfficialToolIds(['image-understanding']);

    expect(result).toEqual({ success: true });
    expect(mocks.setSessionEnabledOfficialToolIds).toHaveBeenCalledWith(['image-understanding']);
    expect(mocks.updateSessionMetadata).not.toHaveBeenCalled();
  });

  it('updates official tool ids through the external engine owner', async () => {
    mocks.state.useExternal = true;

    const result = await getSessionEngine().updateOfficialToolIds([]);

    expect(result).toEqual({ success: true });
    expect(mocks.updateSessionMetadata).not.toHaveBeenCalled();
    expect(mocks.handleExternalOfficialToolIdsChange).toHaveBeenCalledWith([]);
  });

  it('stops an idle live external runtime process before committing desktop materialization', async () => {
    mocks.state.useExternal = true;
    await resetProductSessionBinding({ sessionId: 'pending-external-session' });
    mocks.state.sessionMetadata.clear();
    mocks.getExternalQueueStatus.mockReturnValueOnce([]);
    const prepared = await getSessionEngine().materializePendingDesktopSession({
      workspacePath: '/workspace',
      phase: 'prepare',
    });
    expect(prepared).toMatchObject({ success: true, sessionId: expect.any(String) });

    mocks.state.externalProcessAlive = true;

    const result = await getSessionEngine().materializePendingDesktopSession({
      workspacePath: '/workspace',
      phase: 'commit',
      preparedSessionId: prepared.sessionId,
    });

    expect(result).toMatchObject({ success: true, sessionId: prepared.sessionId });
    expect(mocks.stopExternalSession).toHaveBeenCalledTimes(1);
    expect(mocks.stopExternalSession.mock.invocationCallOrder[0])
      .toBeLessThan(mocks.updateSessionMetadata.mock.invocationCallOrder[0]);
    expect(mocks.updateSessionMetadata).toHaveBeenCalledWith(prepared.sessionId, { runtimeSessionId: 'runtime-thread-id' });
    expect(mocks.restoreExternalSessionState).toHaveBeenCalledWith(prepared.sessionId, '/workspace', { type: 'desktop' });
  });

  it('does not carry a provisional DSH native Session across Product materialization', async () => {
    mocks.state.useExternal = true;
    mocks.getActiveRuntimeType.mockReturnValue('dsh');
    mocks.getActiveRuntimeSource.mockReturnValue('integrated');
    await resetProductSessionBinding({ sessionId: 'pending-dsh-session' });
    mocks.state.sessionMetadata.clear();
    mocks.getExternalQueueStatus.mockReturnValueOnce([]);
    const prepared = await getSessionEngine().materializePendingDesktopSession({
      workspacePath: '/workspace',
      phase: 'prepare',
    });
    expect(prepared).toMatchObject({ success: true, sessionId: expect.any(String) });

    mocks.state.externalProcessAlive = true;

    const result = await getSessionEngine().materializePendingDesktopSession({
      workspacePath: '/workspace',
      phase: 'commit',
      preparedSessionId: prepared.sessionId,
    });

    expect(result).toMatchObject({ success: true, sessionId: prepared.sessionId });
    expect(mocks.stopExternalSession).toHaveBeenCalledTimes(1);
    expect(mocks.updateSessionMetadata).not.toHaveBeenCalledWith(
      prepared.sessionId,
      expect.objectContaining({ runtimeSessionId: expect.any(String) }),
    );
    expect(mocks.restoreExternalSessionState).toHaveBeenCalledWith(
      prepared.sessionId,
      '/workspace',
      { type: 'desktop' },
    );
  });

  it('stops the external runtime when an injected turn times out', async () => {
    mocks.state.useExternal = true;
    mocks.sendExternalMessage.mockImplementationOnce(async (...args: unknown[]) => {
      const onDispatchAccepted = args[6] as (() => void) | undefined;
      onDispatchAccepted?.();
      return { queued: true };
    });

    const result = await runInjectedTurn({
      prompt: 'heartbeat',
      sessionId: 'sid',
      workspacePath: '/workspace',
      scenario: { type: 'desktop' },
      permissionMode: 'no-restrictions',
      timeoutMs: 20,
      pollMs: 1,
    });

    expect(result).toMatchObject({
      success: false,
      enqueued: true,
      status: 408,
      error: 'Execution timed out',
    });
    expect(mocks.stopExternalSession).toHaveBeenCalledTimes(1);
    expect(mocks.didLastTurnSucceed).not.toHaveBeenCalled();
  });

  it('cancels an external Goal guard without stopping an unrelated turn when setup times out', async () => {
    mocks.state.useExternal = true;
    mocks.state.externalActive = true;
    mocks.sendExternalMessage.mockImplementationOnce(
      () => new Promise(() => undefined),
    );
    const beforeDispatch = Object.assign(vi.fn(), { cancel: vi.fn() });

    const result = await runInjectedTurn({
      prompt: 'goal continuation',
      sessionId: 'sid',
      workspacePath: '/workspace',
      scenario: {
        type: 'cron',
        taskId: 'goal-1',
        intervalMinutes: 0,
        aiCanExit: true,
      },
      permissionMode: 'no-restrictions',
      timeoutMs: 1,
      pollMs: 1,
      beforeDispatch,
    });

    expect(result).toMatchObject({
      success: false,
      enqueued: false,
      status: 408,
      error: 'External runtime turn timed out before dispatch',
    });
    expect(beforeDispatch.cancel).toHaveBeenCalledTimes(1);
    expect(mocks.stopExternalSession).not.toHaveBeenCalled();
  });

  it.each([
    { phase: 'dispatch acceptance', stallSend: true },
    { phase: 'terminal outcome', stallSend: false },
  ])('keeps the exact external Task binding when $phase times out and stop is unconfirmed', async ({ stallSend }) => {
    mocks.state.useExternal = true;
    mocks.state.externalActive = true;
    mocks.stopExternalSession
      .mockResolvedValueOnce(false)
      .mockResolvedValueOnce(true);
    mocks.sendExternalMessage.mockImplementationOnce((...args: unknown[]) => {
      const context = args[4] as {
        queueId: string;
        turnOwner: { kind: 'task'; id: string };
      };
      mocks.state.externalCurrentQueueId = context.queueId;
      mocks.state.externalTurnIdentity = {
        queueId: context.queueId,
        owner: context.turnOwner,
      };
      return stallSend
        ? new Promise(() => undefined)
        : Promise.resolve({ queued: true });
    });

    const result = await runInjectedTurn({
      prompt: 'memory update',
      sessionId: 'sid',
      workspacePath: '/workspace',
      scenario: { type: 'desktop' },
      permissionMode: 'no-restrictions',
      timeoutMs: 1,
      pollMs: 1,
      queueId: 'task-orphan-turn',
      turnOwner: { kind: 'task', id: 'task-1' },
    });

    expect(result).toMatchObject({
      success: false,
      enqueued: true,
      status: 408,
      terminationUnconfirmed: true,
      error: 'External runtime turn timed out and its process did not stop',
    });
    expect(mocks.clearExternalTurnBinding).not.toHaveBeenCalled();

    await expect(stopOwnedTurnByQueueId(
      { kind: 'task', id: 'task-1' },
      'task-orphan-turn',
    )).resolves.toEqual({ success: true, alreadyStopped: false });
    expect(mocks.stopExternalSession).toHaveBeenNthCalledWith(1, { preserveQueue: true });
    expect(mocks.stopExternalSession).toHaveBeenNthCalledWith(2, { preserveQueue: true });
  });

  it('keeps the exact external Task binding when dispatch acknowledgement is lost and stop is unconfirmed', async () => {
    mocks.state.useExternal = true;
    mocks.state.externalActive = true;
    mocks.sendExternalMessage.mockImplementationOnce(async (...args: unknown[]) => {
      const context = args[4] as {
        queueId: string;
        turnOwner: { kind: 'task'; id: string };
      };
      mocks.state.externalCurrentQueueId = context.queueId;
      mocks.state.externalTurnIdentity = {
        queueId: context.queueId,
        owner: context.turnOwner,
      };
      return {
        queued: false,
        error: 'dispatch acknowledgement lost; process termination unconfirmed',
        terminationUnconfirmed: true,
      };
    });

    const result = await runInjectedTurn({
      prompt: 'task turn',
      sessionId: 'sid',
      workspacePath: '/workspace',
      scenario: { type: 'desktop' },
      permissionMode: 'no-restrictions',
      timeoutMs: 100,
      pollMs: 1,
      queueId: 'task-dispatch-ambiguous',
      turnOwner: { kind: 'task', id: 'task-1' },
    });

    expect(result).toMatchObject({
      success: false,
      enqueued: true,
      terminationUnconfirmed: true,
      status: 503,
    });
    expect(mocks.clearExternalTurnBinding).not.toHaveBeenCalled();

    await expect(stopOwnedTurnByQueueId(
      { kind: 'task', id: 'task-1' },
      'task-dispatch-ambiguous',
    )).resolves.toEqual({ success: true, alreadyStopped: false });
    expect(mocks.stopExternalSession).toHaveBeenCalledWith({ preserveQueue: true });
  });

  it('conservatively accepts an external Goal IM turn whose dispatch may already be running', async () => {
    mocks.state.useExternal = true;
    mocks.enqueueExternalSendForIm.mockReturnValueOnce({
      queued: true,
      dispatch: Promise.resolve({
        queued: false,
        error: 'dispatch acknowledgement lost; process termination unconfirmed',
        terminationUnconfirmed: true,
      }),
    });

    const result = await getSessionEngine().enqueueImMessage({
      message: 'goal user turn',
      requestId: 'req-ambiguous',
      sessionId: 'sid',
      workspacePath: '/workspace',
      scenario: { type: 'agent-channel', platform: 'feishu', sourceType: 'private' },
      queueId: 'goal-dispatch-ambiguous',
      turnOwner: { kind: 'goal', id: 'goal-1' },
    });

    expect(result).toEqual({ success: true, queued: true });
    expect(mocks.clearExternalTurnBinding).not.toHaveBeenCalled();
  });

  it('publishes builtin desktop reset metadata before reporting success', async () => {
    await expect(getSessionEngine().resetForNewDesktopSession('/workspace')).resolves.toEqual({ success: true, sessionId: 'builtin-session' });
    expect(mocks.materializeCurrentSessionMetadataForPublishedReset).toHaveBeenCalledWith('desktop');
    expect(mocks.resetSession.mock.invocationCallOrder[0]).toBeLessThan(mocks.materializeCurrentSessionMetadataForPublishedReset.mock.invocationCallOrder[0]);
  });

  it.each([true, false])('external reset awaits shared durable publication (success=%s)', async succeeds => {
    mocks.state.useExternal = true;
    let release!: (value: boolean) => void;
    const flushForMutation = vi.fn(() => new Promise<boolean>(resolve => { release = resolve; }));
    const storage = await import('../SessionStore');
    const active = vi.spyOn(storage, 'getActiveSessionTranscript').mockReturnValue({ writer: { flushForMutation } } as unknown as ReturnType<typeof storage.getActiveSessionTranscript>);
    try {
      let settled = false;
      const reset = getSessionEngine().resetForNewDesktopSession('/workspace').finally(() => { settled = true; });
      await vi.waitFor(() => expect(flushForMutation).toHaveBeenCalledOnce());
      expect(settled).toBe(false);
      release(succeeds);
      if (succeeds) await expect(reset).resolves.toMatchObject({ success: true });
      else await expect(reset).rejects.toThrow('could not be published');
    } finally { active.mockRestore(); }
  });

  it('serializes external desktop reset against an in-flight runtime start', async () => {
    mocks.state.useExternal = true;
    mocks.state.externalActive = true;

    const result = await getSessionEngine().resetForNewDesktopSession('/workspace');

    expect(result).toMatchObject({ success: true, sessionId: expect.any(String) });
    expect(mocks.state.sessionMetadata.get(result.sessionId!)).toMatchObject({ id: result.sessionId, configSnapshotAt: expect.any(String), model: mocks.getExternalSessionModel() });
    expect(mocks.awaitExternalSessionStarting).toHaveBeenCalledTimes(1);
    expect(mocks.stopExternalSession).toHaveBeenCalledTimes(1);
    expect(mocks.resetSession).not.toHaveBeenCalled();
    expect(mocks.awaitExternalSessionStarting.mock.invocationCallOrder[0])
      .toBeLessThan(mocks.stopExternalSession.mock.invocationCallOrder[0]);
    expect(mocks.restoreExternalSessionState).toHaveBeenCalledWith(result.sessionId, '/workspace', { type: 'desktop' });
  });

  it('stops an idle live external runtime process before desktop reset mints a new session', async () => {
    mocks.state.useExternal = true;
    mocks.state.externalProcessAlive = true;

    const result = await getSessionEngine().resetForNewDesktopSession('/workspace');

    expect(result).toMatchObject({ success: true, sessionId: expect.any(String) });
    expect(mocks.awaitExternalSessionStarting).toHaveBeenCalledTimes(1);
    expect(mocks.stopExternalSession).toHaveBeenCalledTimes(1);
    expect(mocks.resetSession).not.toHaveBeenCalled();
    expect(mocks.restoreExternalSessionState).toHaveBeenCalledWith(result.sessionId, '/workspace', { type: 'desktop' });
  });

  it('rejects external desktop reset while a conversation mutation owns the Session', async () => {
    mocks.state.useExternal = true;
    mocks.state.externalConversationMutation = true;

    await expect(getSessionEngine().resetForNewDesktopSession('/workspace')).resolves.toEqual({
      success: false,
      error: 'Wait for the current Session operation to finish',
    });
    expect(mocks.stopExternalSession).not.toHaveBeenCalled();
    expect(mocks.restoreExternalSessionState).not.toHaveBeenCalled();
  });

  it('freezes the current builtin Session before migrating the bound surface', async () => {
    const targetSessionId = '6d57334a-44d8-4fe1-a4f2-cd57fc8beb85';
    const result = await getSessionEngine().migrateBoundSurfaceSession('/workspace', {
      targetSessionId,
    });

    expect(result).toEqual({ success: true, sessionId: targetSessionId });
    expect(mocks.freezeCurrentSessionMetadataForImDetach).toHaveBeenCalledTimes(1);
    expect(mocks.freezeCurrentSessionMetadataForImDetach).toHaveBeenCalledWith(undefined, {
      allowMissingMetadata: false,
    });
    expect(mocks.resetSession).toHaveBeenCalledWith({ sessionId: targetSessionId });
    expect(mocks.materializeCurrentSessionMetadataForPublishedReset).toHaveBeenCalledTimes(1);
    expect(mocks.freezeCurrentSessionMetadataForImDetach.mock.invocationCallOrder[0])
      .toBeLessThan(mocks.resetSession.mock.invocationCallOrder[0]);
    expect(mocks.resetSession.mock.invocationCallOrder[0])
      .toBeLessThan(mocks.materializeCurrentSessionMetadataForPublishedReset.mock.invocationCallOrder[0]);
  });

  it('freezes the current external Session before migrating to the proven target', async () => {
    mocks.state.useExternal = true;
    mocks.state.externalActive = true;
    mocks.getActiveRuntimeType.mockReturnValueOnce('codex');
    mocks.getExternalSessionModel.mockReturnValueOnce('gpt-5');
    mocks.getExternalSessionPermissionMode.mockReturnValueOnce('no-restrictions');
    mocks.getExternalSessionReasoningEffort.mockReturnValueOnce('medium');

    const targetSessionId = 'e8c1e529-8458-4361-a24a-02f5c278203e';
    const result = await getSessionEngine().migrateBoundSurfaceSession('/workspace', {
      targetSessionId,
    });

    expect(result).toEqual({ success: true, sessionId: targetSessionId });
    expect(mocks.awaitExternalSessionStarting).toHaveBeenCalledTimes(1);
    expect(mocks.updateSessionMetadata).toHaveBeenCalledWith(
      'external-session',
      expect.objectContaining({
        runtime: 'codex',
        runtimeSource: 'system-cli',
        model: 'gpt-5',
        permissionMode: 'no-restrictions',
        reasoningEffort: 'medium',
        configSnapshotAt: expect.any(String),
      }),
    );
    expect(mocks.updateSessionMetadata.mock.invocationCallOrder[0])
      .toBeLessThan(mocks.stopExternalSession.mock.invocationCallOrder[0]);
    expect(mocks.resetSession).not.toHaveBeenCalled();
    expect(mocks.restoreExternalSessionState).toHaveBeenCalledWith(targetSessionId, '/workspace', { type: 'desktop' });
  });

  it('keeps a builtin surface migration committed when metadata publication fails', async () => {
    mocks.materializeCurrentSessionMetadataForPublishedReset.mockRejectedValueOnce(
      new Error('metadata unavailable'),
    );
    const targetSessionId = 'e7a596bc-61d8-4adc-96af-02ee892c15ca';

    await expect(getSessionEngine().migrateBoundSurfaceSession('/workspace', {
      targetSessionId,
    })).resolves.toEqual({ success: true, sessionId: targetSessionId });

    expect(mocks.resetSession).toHaveBeenCalledWith({ sessionId: targetSessionId });
  });

  it('stops an idle live external runtime process before surface migration', async () => {
    mocks.state.useExternal = true;
    mocks.state.externalProcessAlive = true;

    const targetSessionId = 'af131598-00c6-4b7b-b4fb-c039cb0f0496';
    const result = await getSessionEngine().migrateBoundSurfaceSession('/workspace', {
      targetSessionId,
    });

    expect(result).toEqual({ success: true, sessionId: targetSessionId });
    expect(mocks.stopExternalSession).toHaveBeenCalledTimes(1);
    expect(mocks.resetSession).not.toHaveBeenCalled();
    expect(mocks.restoreExternalSessionState).toHaveBeenCalledWith(targetSessionId, '/workspace', { type: 'desktop' });
  });

  it('rejects external surface migration when the old runtime process remains alive', async () => {
    mocks.state.useExternal = true;
    mocks.state.externalProcessAlive = true;
    mocks.stopExternalSession.mockResolvedValueOnce(false);

    const targetSessionId = 'e64e373e-76c7-4be0-a537-0134949a1e18';
    const result = await getSessionEngine().migrateBoundSurfaceSession('/workspace', {
      targetSessionId,
    });

    expect(result).toEqual({
      success: false,
      error: 'External runtime process did not stop',
    });
    expect(getCurrentProductSessionId()).toBe('external-session');
    expect(mocks.restoreExternalSessionState).not.toHaveBeenCalled();
  });

  it('keeps an external surface migration committed when optional pre-warm fails', async () => {
    mocks.state.useExternal = true;
    mocks.restoreExternalSessionState.mockResolvedValueOnce({
      success: false,
      error: 'pre-warm unavailable',
    });
    const targetSessionId = 'f7cd3447-b444-46a6-94bb-d549bfdcd9bd';

    await expect(getSessionEngine().migrateBoundSurfaceSession('/workspace', {
      targetSessionId,
    })).resolves.toEqual({ success: true, sessionId: targetSessionId });

    expect(getCurrentProductSessionId()).toBe(targetSessionId);
  });

  it('rejects external surface migration before freezing while another mutation owns the Session', async () => {
    mocks.state.useExternal = true;
    mocks.state.externalConversationMutation = true;

    await expect(getSessionEngine().migrateBoundSurfaceSession('/workspace', {
      targetSessionId: 'f7cd3447-b444-46a6-94bb-d549bfdcd9bd',
    })).resolves.toEqual({
      success: false,
      error: 'Wait for the current Session operation to finish',
    });
    expect(mocks.updateSessionMetadata).not.toHaveBeenCalled();
    expect(mocks.stopExternalSession).not.toHaveBeenCalled();
    expect(mocks.restoreExternalSessionState).not.toHaveBeenCalled();
  });

  it('freezes the current external IM session through the engine facade', async () => {
    mocks.state.useExternal = true;
    mocks.getActiveRuntimeSource.mockReturnValueOnce('managed-provider');

    const result = await getSessionEngine().freezeCurrentSessionForImDetach({
      metadataBirthPending: true,
    });

    expect(result).toEqual(expect.objectContaining({ success: true, sessionId: 'external-session' }));
    expect(mocks.updateSessionMetadata).toHaveBeenCalledWith(
      'external-session',
      expect.objectContaining({
        runtime: 'codex',
        runtimeSource: 'managed-provider',
        model: 'gpt-5',
        permissionMode: 'no-restrictions',
        reasoningEffort: 'medium',
        providerExecutionIdentity: {
          kind: 'runtime-backed-provider',
          providerId: 'codex-sub',
          runtime: 'codex',
          runtimeSource: 'managed-provider',
          model: 'gpt-5',
        },
        configSnapshotAt: expect.any(String),
      }),
    );
  });

  it('allows freezing explicit unindexed IM sessions with missing metadata', async () => {
    const result = await getSessionEngine().freezeCurrentSessionForImDetach({
      metadataBirthPending: false,
      metadataIndexed: false,
    });

    expect(result).toEqual({ success: true, sessionId: 'old-im-session' });
    expect(mocks.freezeCurrentSessionMetadataForImDetach).toHaveBeenCalledWith(undefined, {
      allowMissingMetadata: true,
    });
  });

  it('routes permission responses by external liveness compatibility', () => {
    mocks.state.useExternal = true;

    mocks.state.externalActive = false;
    expect(getPermissionResponseEngine().kind).toBe('builtin');

    mocks.state.externalActive = true;
    expect(getPermissionResponseEngine().kind).toBe('external');
  });

  it('routes AskUserQuestion responses by pending external request ownership', () => {
    mocks.state.useExternal = true;

    mocks.state.pendingExternalAsk = false;
    expect(getAskUserQuestionResponseEngine('ask-1').kind).toBe('builtin');

    mocks.state.pendingExternalAsk = true;
    expect(getAskUserQuestionResponseEngine('ask-1').kind).toBe('external');
  });

  it('routes plan approval responses by pending external request ownership', () => {
    mocks.state.useExternal = true;

    mocks.state.pendingExternalPlan = false;
    expect(getPlanApprovalResponseEngine('plan-1').kind).toBe('builtin');

    mocks.state.pendingExternalPlan = true;
    expect(getPlanApprovalResponseEngine('plan-1').kind).toBe('external');
  });

  it('keeps DSH interaction responses on the integrated owner after process loss', () => {
    mocks.state.useExternal = true;
    mocks.state.externalActive = false;
    mocks.state.pendingExternalAsk = false;
    const previousRuntime = process.env.MYAGENTS_RUNTIME;
    process.env.MYAGENTS_RUNTIME = 'dsh';

    try {
      expect(getPermissionResponseEngine().kind).toBe('integrated');
      expect(getAskUserQuestionResponseEngine('stale-ask').kind).toBe('integrated');
      expect(getPlanApprovalResponseEngine('stale-plan').kind).toBe('integrated');
    } finally {
      if (previousRuntime === undefined) delete process.env.MYAGENTS_RUNTIME;
      else process.env.MYAGENTS_RUNTIME = previousRuntime;
    }
  });
});


describe('user-confirmed updater admission through the SessionEngine owner', () => {
  const token = '00000000-0000-4000-8000-000000000001';
  const other = '00000000-0000-4000-8000-000000000002';
  function idleOwnerFixture() {
    const engine = getSessionEngine();
    vi.spyOn(engine, 'isBusy').mockReturnValue(false);
    vi.spyOn(engine, 'getLiveSessionState').mockReturnValue({ sessionState: 'idle', isBusy: false, waitingForUser: false });
    vi.spyOn(engine, 'getQueueStatus').mockReturnValue([]);
    vi.spyOn(engine, 'getStreamReplaySnapshot').mockReturnValue({ pendingInteractiveRequests: [] } as never);
    return engine;
  }
  beforeEach(() => {
    vi.clearAllMocks();
    releaseSessionAdmissionsForUpdate(token);
    releaseSessionAdmissionsForUpdate(other);
    mocks.state.useExternal = false;
    mocks.state.externalBusy = false;
    mocks.isSessionBusy.mockReturnValue(false);
    mocks.getQueueStatus.mockReturnValue([]);
    mocks.getPendingInteractiveRequests.mockReturnValue([]);
    mocks.getAgentState.mockReturnValue({ sessionState: 'idle', agentDir: '/workspace' });
    mocks.getActiveRuntimeType.mockReturnValue('codex');
    idleOwnerFixture();
  });
  afterEach(() => {
    releaseSessionAdmissionsForUpdate(token);
    releaseSessionAdmissionsForUpdate(other);
    vi.restoreAllMocks();
  });

  it('refuses running/queued/approval owners without invoking stop or cancellation', async () => {
    vi.mocked(getSessionEngine().isBusy).mockReturnValue(true);
    await expect(freezeSessionAdmissionsForUpdate(token)).rejects.toThrow('UPDATE_BUSY');
    vi.mocked(getSessionEngine().isBusy).mockReturnValue(false);
    vi.mocked(getSessionEngine().getQueueStatus).mockReturnValue([{ id: 'queued-work', messagePreview: 'keep me' }]);
    await expect(freezeSessionAdmissionsForUpdate(token)).rejects.toThrow('UPDATE_BUSY');
    vi.mocked(getSessionEngine().getQueueStatus).mockReturnValue([]);
    vi.mocked(getSessionEngine().getStreamReplaySnapshot).mockReturnValue({ pendingInteractiveRequests: [{ type: 'chat:permission-request', data: { requestId: 'approval' } }] } as never);
    await expect(freezeSessionAdmissionsForUpdate(token)).rejects.toThrow('UPDATE_BUSY');
    expect(mocks.interruptCurrentResponse).not.toHaveBeenCalled();
    expect(mocks.cancelBuiltinImRequest).not.toHaveBeenCalled();
  });

  it('refuses an admitted compaction even before the adapter publishes busy, then lets it finish', async () => {
    mocks.state.useExternal = true;
    idleOwnerFixture();
    let finish!: (result: { success: boolean }) => void;
    mocks.compactExternalContext.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
    const compact = getSessionEngine().compactContext();
    await expect(freezeSessionAdmissionsForUpdate(token)).rejects.toThrow('UPDATE_BUSY');
    finish({ success: true });
    await expect(compact).resolves.toEqual({ success: true });
    await freezeSessionAdmissionsForUpdate(token);
    await expect(getSessionEngine().compactContext()).rejects.toThrow('UPDATE_BUSY');
  });

  it('closes all existing turn admission paths and restores them only for the exact transaction', async () => {
    await freezeSessionAdmissionsForUpdate(token);
    const engine = getSessionEngine();
    for (const request of [
      engine.sendDesktopMessage({} as never), engine.enqueueImMessage({} as never),
      engine.enqueueBackgroundMessage({} as never), engine.enqueueInboxMessage({} as never),
      engine.prepareScheduledTurn({} as never), engine.runInjectedTurn({} as never),
      engine.compactContext(), engine.retryUserMessage('user'), engine.forceQueuedMessage('queue'),
    ]) await expect(request).rejects.toThrow('UPDATE_BUSY');
    releaseSessionAdmissionsForUpdate(other);
    await expect(engine.sendDesktopMessage({} as never)).rejects.toThrow('UPDATE_BUSY');
    releaseSessionAdmissionsForUpdate(token);
    await freezeSessionAdmissionsForUpdate(other);
    releaseSessionAdmissionsForUpdate(token);
    await expect(engine.sendDesktopMessage({} as never)).rejects.toThrow('UPDATE_BUSY');
  });

  it('closes the direct external selectors and runtime creation capabilities as well', async () => {
    await freezeSessionAdmissionsForUpdate(token);
    const engine = getSessionEngine();
    await expect(prewarmExternalRuntimeAtSelector({ sessionId: 'idle', workspacePath: '/workspace' })).rejects.toThrow('UPDATE_BUSY');
    await expect(restoreInitialExternalSessionAtSelector('idle', '/workspace')).rejects.toThrow('UPDATE_BUSY');
    await expect(retryLastExternalUserMessageAtSelector('user')).rejects.toThrow('UPDATE_BUSY');
    await expect(updateExternalRuntimeConfigAtSelector({ runtimeConfig: {} })).rejects.toThrow('UPDATE_BUSY');
    await expect(engine.resetForNewDesktopSession('/workspace')).rejects.toThrow('UPDATE_BUSY');
    await expect(engine.retryMcpServer('server')).rejects.toThrow('UPDATE_BUSY');
    expect(mocks.prewarmExternalSession).not.toHaveBeenCalled();
  });

  it('rejects mutable runtime and conversation operations after idle is frozen', async () => {
    await freezeSessionAdmissionsForUpdate(token);
    const engine = getSessionEngine();
    for (const request of [
      engine.updateProxyConfig(null), engine.updateOfficialToolIds(null),
      engine.updateDesktopInteractionScenario({ type: 'desktop' } as never),
      engine.rewindToUserMessage('user'), engine.forkAtAssistantMessage('assistant'),
      engine.stopTurn(), engine.cancelQueuedMessage('queue'),
      engine.respondAskUserQuestion('request', null), engine.respondPermission('request', 'allow_once'),
    ]) await expect(request).rejects.toThrow('UPDATE_BUSY');
    expect(mocks.interruptCurrentResponse).not.toHaveBeenCalled();
  });

  it('preserves a previously scheduled builtin warm-up instead of freezing across its delayed launch', async () => {
    const lifecycle = await import('../builtin-session/lifecycle');
    const timer = setTimeout(() => undefined, 10000);
    lifecycle.setPreWarmTimer(timer);
    try {
      await expect(freezeSessionAdmissionsForUpdate(token)).rejects.toThrow('UPDATE_BUSY');
      expect(lifecycle.lifecycleState.preWarmTimer).toBe(timer);
      expect(lifecycle.isUpdateRestartFrozen()).toBe(false);
    } finally { lifecycle.clearPreWarmTimer(); }
    await freezeSessionAdmissionsForUpdate(token);
    expect(lifecycle.isUpdateRestartFrozen()).toBe(true);
    releaseSessionAdmissionsForUpdate(other);
    expect(lifecycle.isUpdateRestartFrozen()).toBe(true);
    releaseSessionAdmissionsForUpdate(token);
    expect(lifecycle.isUpdateRestartFrozen()).toBe(false);
  });

  it('reports observation errors as unknown and does not leave a freeze behind', async () => {
    vi.mocked(getSessionEngine().getLiveSessionState).mockImplementationOnce(() => { throw new Error('adapter unavailable'); });
    await expect(freezeSessionAdmissionsForUpdate(token)).rejects.toThrow('UPDATE_ACTIVITY_UNKNOWN');
    await freezeSessionAdmissionsForUpdate(other);
  });

  it('preserves an SDK background task after its root has become idle', async () => {
    const lifecycle = await import('../builtin-session/lifecycle');
    const query = {} as never;
    lifecycle.setQuerySession(query);
    lifecycle.recordQueryBackgroundTask(query, 'background-owner', { runId: 'run-updater' });
    try {
      await expect(freezeSessionAdmissionsForUpdate(token)).rejects.toThrow('UPDATE_BUSY');
      expect(lifecycle.hasQueryBackgroundTasks(query)).toBe(true);
    } finally {
      lifecycle.takeQueryBackgroundTasks(query);
      lifecycle.setQuerySession(null);
    }
  });

  it('refuses native DSH child activity while its root is idle', async () => {
    mocks.state.useExternal = true;
    mocks.getActiveRuntimeType.mockReturnValue('dsh');
    const engine = idleOwnerFixture();
    vi.spyOn(engine, 'getRuntimeIdentity').mockReturnValue({ runtime: 'dsh' } as never);
    vi.spyOn(engine as Required<SessionEngine>, 'listAgentWork').mockResolvedValue({ items: [{ status: 'running' }] } as never);
    await expect(freezeSessionAdmissionsForUpdate(token)).rejects.toThrow('UPDATE_BUSY');
    expect(mocks.interruptCurrentResponse).not.toHaveBeenCalled();
  });

  it('does not re-freeze after a timed-out native observation was released', async () => {
    mocks.state.useExternal = true;
    mocks.getActiveRuntimeType.mockReturnValue('dsh');
    const engine = idleOwnerFixture();
    vi.spyOn(engine, 'getRuntimeIdentity').mockReturnValue({ runtime: 'dsh' } as never);
    let finish!: (result: never) => void;
    vi.spyOn(engine as Required<SessionEngine>, 'listAgentWork').mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
    const pending = freezeSessionAdmissionsForUpdate(token);
    await expect(engine.compactContext()).rejects.toThrow('UPDATE_BUSY');
    releaseSessionAdmissionsForUpdate(token);
    finish({ items: [] } as never);
    await expect(pending).rejects.toThrow('UPDATE_ACTIVITY_UNKNOWN');
    await expect(engine.compactContext()).resolves.toMatchObject({ success: true });
  });
});

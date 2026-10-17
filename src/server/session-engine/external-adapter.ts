import { updateExternalRuntimeConfig } from '../runtimes/external-session';
import { retryDesktopRequest } from './retry';
import { prepareDesktopQuery } from './query-reminder';
import { randomUUID } from 'node:crypto';
import { broadcast } from '../sse';
import {
  addExternalPermissionRule,
  runExternalTextUtility,
  publishExternalTranscriptSaveStatus,
  cancelExternalQueueItem,
  cancelExternalQueuedTurnsByOwner,
  cancelExternalImRequest,
  clearExternalTurnBinding,
  compactExternalContext,
  retryExternalMcpServer,
  awaitExternalSessionStarting,
  enqueueExternalSendForDesktop,
  enqueueExternalSendForInbox,
  enqueueExternalSendForIm,
  forceExecuteExternalQueueItem,
  getActiveRuntimeSource,
  getActiveRuntimeType,
  getActiveExternalImBridgeTurnContext,
  getCurrentBoundSessionId,
  getExternalLiveSessionSnapshot,
  validateExternalAsyncQuestionReply,
  getExternalNativeSessionId,
  getExternalSessionCompletionTerminal,
  getExternalExecutionTurnId,
  getExternalPendingInteractiveRequests,
  getExternalQueueStatus,
  getExternalSessionId,
  getExternalSessionModel,
  getExternalSessionPermissionMode,
  getExternalSessionReasoningEffort,
  getExternalSessionState,
  getExternalExecutionStartedAt,
  getExternalWorkProgressSnapshot,
  getExternalSessionWorkspacePath,
  getExternalSystemInitPayload,
  getExternalMcpEffectiveSnapshot,
  getExternalCurrentTurnIdentity,
  getProductExtensionConfigSnapshot,
  getLastExternalAssistantText,
  handleExternalOfficialToolIdsChange,
  handleExternalProxyConfigChange,
  handleExternalAgentsChange,
  handleExternalDesktopInteractionScenarioChange,
  handleExternalMcpServersChange,
  handleExternalSessionEnabledPluginsChange,
  hasExternalQueuedTurnByOwner,
  hasExternalRuntimeProcess,
  isExternalSessionActive,
  isExternalSessionBusy,
  tryAcquireExternalSessionMutationLease,
  isExternalSessionStateRestoredFor,
  isExternalTurnCurrent,
  listExternalPermissionRules,
  listExternalAgentWork,
  inspectExternalRuntime,
  controlExternalAgentWork,
  respondExternalAskUserQuestion,
  respondExternalPermission,
  respondExternalPlanApproval,
  revokeExternalPermissionRule,
  restoreExternalSessionState,
  rewindExternalConversation,
  retryDshConversation,
  forkExternalConversation,
  sendExternalMessage,
  setExternalModel,
  setExternalPermissionMode,
  setExternalReasoningEffort,
  stopExternalSession,
  waitForExternalSessionIdle,
} from '../runtimes/external-session';
import type {
  DesktopAdmissionResult,
  DesktopMessageRequest,
  ImAdmissionResult,
  ImMessageRequest,
  InjectedTurnRequest,
  InjectedTurnResult,
  ScheduledTurnPreparationResult,
  SessionEngine,
  SessionEngineReplayMessage,
} from './types';
import { decideExternalInjectedTurnResult } from '../session-core/turn-result-policy';
import type { TurnTerminalOutcome } from '../session-core/turn-queue';
import {
  findProjectAgentByWorkspacePath,
  getEffectiveOfficialToolIdsForSession,
  loadConfig as loadAdminConfig,
  resolveWorkspaceConfig,
} from '../utils/admin-config';
import {
  ensureRegisteredAgentSessionOrigin,
  getPersistedSessionOrigin,
  getSessionData,
  getSessionMetadata,
  updateSessionMetadata,
} from '../SessionStore';
import { getLatestAssistantResultFromMessages, NO_TEXT_RESPONSE } from '../inbox/latest-result';
import { CODEX_SUBSCRIPTION_PROVIDER_ID } from '../../shared/config-types';
import {
  getProcessProxyEnvKey,
  getProviderProxyScopeKey,
  setProcessProxyConfig,
} from '../proxy-state';
import {
  isPermissionModeForRuntimeIdentity,
  type RuntimeBackedProviderIdentity,
} from '../../shared/providerExecution';
import type { SessionMessage, SessionMetadata } from '../types/session';
import { shrinkReplayContentForClient } from '../utils/session-message-preview';
import {
  DESKTOP_CHANNEL_DELIVERY,
  IM_CHANNEL_DELIVERY,
  SESSION_BOUND_CHANNEL_DELIVERY,
  injectedTurnChannelDelivery,
} from '../session-core/channel-delivery';
import type { AgentConfig } from '../../shared/types/agent';
import { createMaterializedSessionMetadata, isLiveFollowScenario } from '../utils/session-materialization';
import { isManagedCodexProviderReady } from '../utils/managed-codex-readiness';
import { managedCodexNotReadyMessage } from '../utils/managed-codex-readiness';
import {
  commitPendingProductSession,
  freezeCurrentProductSessionMetadata,
  getCurrentProductSessionId,
  getCurrentProductSessionContext,
  preparePendingProductSession,
  publishCurrentProductSessionMetadata,
  resetProductSessionBinding,
  rollbackPendingProductSession,
} from './product-session-binding';
import { resolveSessionConfig } from '../utils/resolve-session-config';
import { resolveScheduledTurnPermissionMode } from '../../shared/types/runtime';
import { runtimeConfigModel, runtimeConfigSource } from './scheduled-turn-preparation';

function waitForDeadline<T>(promise: Promise<T>, timeoutMs: number): Promise<T | null> {
  if (timeoutMs <= 0) return Promise.resolve(null);
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => resolve(null), timeoutMs);
    promise.then(
      value => {
        clearTimeout(timer);
        resolve(value);
      },
      error => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

function observeExternalDispatch(
  dispatch: Promise<{ queued: boolean; error?: string; terminationUnconfirmed?: boolean }>,
  queueId?: string,
  userMessageId?: string,
): Promise<{ accepted: boolean; error?: string }> {
  return dispatch
    .then((result) => {
      if (!result.queued) {
        if (queueId && !result.terminationUnconfirmed) {
          clearExternalTurnBinding(queueId);
        }
        if (result.error) {
          console.error(`[chat] external send failed: ${result.error}`);
          broadcast('chat:agent-error', { message: result.error, userMessageId });
        }
        return result.terminationUnconfirmed
          ? { accepted: true }
          : { accepted: false, ...(result.error ? { error: result.error } : {}) };
      }
      return { accepted: true };
    })
    .catch((error) => {
      if (queueId) clearExternalTurnBinding(queueId);
      const message = error instanceof Error ? error.message : String(error);
      console.error(`[chat] external send threw: ${message}`);
      broadcast('chat:agent-error', { message, userMessageId });
      return { accepted: false, error: message };
    });
}

async function stopExternalTarget(): Promise<boolean> {
  const stopped = await stopExternalSession({ preserveQueue: true });
  return stopped || (!hasExternalRuntimeProcess() && !isExternalSessionActive());
}

function getRuntimeSessionId(): string {
  return getExternalSessionId() || getCurrentBoundSessionId() || getCurrentProductSessionId();
}

function sessionMessageToReplayMessage(message: SessionMessage): SessionEngineReplayMessage {
  return {
    ...message,
    content: shrinkReplayContentForClient(message.content),
  };
}

function getRuntimeWorkspacePath(): string {
  return getExternalSessionWorkspacePath() || getCurrentProductSessionContext().workspacePath;
}

async function getLatestExternalResult(): Promise<string> {
  const runtimeSessionId = getRuntimeSessionId();
  let latestResult = getLastExternalAssistantText();
  if (runtimeSessionId && getSessionMetadata(runtimeSessionId)?.transcriptFormat === 2) {
    return latestResult.trim() || NO_TEXT_RESPONSE;
  }
  if (!latestResult.trim()) {
    const data = runtimeSessionId ? (await getSessionData(runtimeSessionId)) : null;
    latestResult = data
      ? getLatestAssistantResultFromMessages(data.messages)
      : NO_TEXT_RESPONSE;
  }
  return latestResult.trim() || NO_TEXT_RESPONSE;
}

type ExternalFreezeSnapshotPatch = Partial<SessionMetadata> & Pick<SessionMetadata, 'configSnapshotAt'>;

function buildExternalFreezeSnapshotPatch(): ExternalFreezeSnapshotPatch {
  const runtime = getActiveRuntimeType();
  const runtimeSource = getActiveRuntimeSource();
  const model = getExternalSessionModel() ?? undefined;
  const permissionMode = getExternalSessionPermissionMode() ?? undefined;
  const reasoningEffort = getExternalSessionReasoningEffort() ?? undefined;
  const patch: ExternalFreezeSnapshotPatch = {
    runtime,
    configSnapshotAt: new Date().toISOString(),
  };
  if (runtime !== 'builtin' && runtimeSource) patch.runtimeSource = runtimeSource;
  if (model) patch.model = model;
  if (permissionMode) patch.permissionMode = permissionMode;
  if (reasoningEffort) patch.reasoningEffort = reasoningEffort;
  const extensions = getProductExtensionConfigSnapshot();
  if (extensions.enabledPluginIds) patch.enabledPluginIds = extensions.enabledPluginIds;
  if (extensions.mcpServerIds) patch.mcpEnabledServers = extensions.mcpServerIds;
  if (runtime === 'codex' && runtimeSource === 'managed-provider' && model) {
    patch.providerExecutionIdentity = {
      kind: 'runtime-backed-provider',
      providerId: CODEX_SUBSCRIPTION_PROVIDER_ID as RuntimeBackedProviderIdentity['providerId'],
      runtime: 'codex',
      runtimeSource: 'managed-provider',
      model,
    };
  }
  return patch;
}

function createExternalProductSessionMetadata(
  sessionId: string,
  workspacePath: string,
  scenario: 'desktop' | 'agent-channel',
  origin?: import('../../shared/session-origin').SessionOrigin,
): { metadata: SessionMetadata; snapshotKind: string } {
  const agent = findProjectAgentByWorkspacePath(workspacePath) as AgentConfig | undefined;
  const runtime = getActiveRuntimeType();
  const runtimeSource = getActiveRuntimeSource();
  const metadata = createMaterializedSessionMetadata({
    agentDir: workspacePath,
    sessionId,
    scenario,
    agent,
    runtimeOverride: runtime,
    runtimeSourceOverride: runtimeSource,
    managedCodexProviderReady: isManagedCodexProviderReady(loadAdminConfig()),
    fallbackRuntime: runtime,
    title: 'New Chat',
    origin,
  });
  return {
    metadata,
    snapshotKind: agent
      ? (isLiveFollowScenario(scenario) ? 'live-follow' : 'owned')
      : `runtime:${runtime}`,
  };
}

export function createExternalSessionEngine(): SessionEngine {
  return {
    kind: 'external',

    isBusy() {
      return isExternalSessionBusy();
    },

    getRuntimeIdentity() {
      const boundSessionId = getCurrentBoundSessionId();
      return {
        kind: 'external',
        runtime: getActiveRuntimeType(),
        runtimeSource: getActiveRuntimeSource(),
        sessionId: getRuntimeSessionId(),
        ...(boundSessionId ? { boundSessionId } : {}),
      };
    },

    publishTranscriptSaveStatus(status) { publishExternalTranscriptSaveStatus(status); },
    getWorkProgressSnapshot() { return getExternalWorkProgressSnapshot(); },
    getLiveSessionState() {
      const executionStartedAt = getExternalExecutionStartedAt();
      return {
        ...(executionStartedAt ? { executionStartedAt } : {}),
        sessionState: getExternalSessionState(),
        isBusy: isExternalSessionBusy(),
        waitingForUser: getExternalPendingInteractiveRequests().some(request => {
          const data = request.data as { blocksRoot?: boolean } | null;
          return data?.blocksRoot === true;
        }),
      };
    },

    async getLatestAssistantResult() {
      return {
        sessionId: getRuntimeSessionId(),
        latestResult: await getLatestExternalResult(),
      };
    },

    getStreamReplaySnapshot() {
      // The bound identity is promoted before the lifecycle id during startup.
      // Stream replay must follow the accepted Session, not the lagging runtime
      // lifecycle, or pending→real reconnects query an empty snapshot.
      const sessionId = getCurrentBoundSessionId() || getRuntimeSessionId();
      const liveSnapshot = getExternalLiveSessionSnapshot(sessionId);
      const systemInitPayload = getExternalSystemInitPayload();
      const productContext = getCurrentProductSessionContext();
      return {
        sessionId,
        initState: {
          agentDir: productContext.workspacePath,
          sessionState: getExternalSessionState(),
          hasInitialPrompt: productContext.hasInitialPrompt,
          queuedMessages: liveSnapshot?.queuedMessages ?? [],
        },
        replayMessages: liveSnapshot?.inMemoryMessages.map(sessionMessageToReplayMessage) ?? [],
        liveStreamingMessage: liveSnapshot?.liveStreamingMessage
          ? sessionMessageToReplayMessage(liveSnapshot.liveStreamingMessage)
          : null,
        systemInitPayload: systemInitPayload ?? undefined,
        mcpEffectiveSnapshot: getExternalMcpEffectiveSnapshot(),
        pendingInteractiveRequests: liveSnapshot?.pendingInteractiveRequests
          ?? getExternalPendingInteractiveRequests(),
      };
    },

    inspectRuntime: inspectExternalRuntime,

    getSessionConfigSnapshot() {
      const runtimeSessionId = getRuntimeSessionId();
      const session = runtimeSessionId ? getSessionMetadata(runtimeSessionId) : null;
      const workspacePath = getRuntimeWorkspacePath();
      const extensions = getProductExtensionConfigSnapshot();
      const providerRoute = getActiveRuntimeType() === 'dsh' && workspacePath
        ? resolveWorkspaceConfig(workspacePath, session, { includeMcp: false }).providerRoute
        : undefined;
      return {
        success: true,
        runtime: getActiveRuntimeType(),
        runtimeSource: getActiveRuntimeSource(),
        model: getExternalSessionModel(),
        mcpServerIds: extensions.mcpServerIds,
        agentNames: extensions.agentNames,
        enabledPluginIds: extensions.enabledPluginIds,
        ...(extensions.extensionStatus ? { extensionStatus: extensions.extensionStatus } : {}),
        ...(extensions.permissionStatus ? { permissionStatus: extensions.permissionStatus } : {}),
        enabledOfficialToolIds: workspacePath
          ? getEffectiveOfficialToolIdsForSession(workspacePath, session)
          : [],
        permissionMode: getExternalSessionPermissionMode(),
        providerId: providerRoute && providerRoute.kind !== 'unknown-legacy'
          ? providerRoute.providerId
          : session?.providerExecutionIdentity?.providerId ?? null,
        providerRoute: providerRoute ?? null,
        providerExecutionIdentity: session?.providerExecutionIdentity ?? null,
        reasoningEffort: getExternalSessionReasoningEffort() ?? 'default',
      };
    },

    async runTextUtility(task) {
      return runExternalTextUtility({
        ...task, runtime: getActiveRuntimeType(), runtimeSource: getActiveRuntimeSource(),
        model: getExternalSessionModel() ?? '',
        workspacePath: getRuntimeWorkspacePath() || undefined,
      });
    },

    getCurrentSessionContext() {
      const sessionId = getRuntimeSessionId();
      return {
        runtime: getActiveRuntimeType(),
        sessionId: sessionId || null,
        workspacePath: getRuntimeWorkspacePath() || null,
        sessionMeta: sessionId ? getSessionMetadata(sessionId) : null,
      };
    },

    getSessionOrigin(sessionId) {
      return getPersistedSessionOrigin(sessionId);
    },

    ensureRegisteredAgentSessionOrigin(sessionId, expected) {
      return ensureRegisteredAgentSessionOrigin(sessionId, expected);
    },

    getHeldImConfigSnapshot() {
      return {
        model: getExternalSessionModel() ?? undefined,
        permissionMode: getExternalSessionPermissionMode() ?? undefined,
        reasoningEffort: getExternalSessionReasoningEffort() ?? undefined,
      };
    },

    getLiveSessionOverlay(sessionId: string) {
      const snapshot = getExternalLiveSessionSnapshot(sessionId);
      if (!snapshot) {
        return { isActive: false };
      }
      return {
        isActive: true,
        runtime: getActiveRuntimeType(),
        ...snapshot,
      };
    },

    getCurrentTurnIdentity() {
      return getExternalCurrentTurnIdentity();
    },

    getExecutionTurnId() { return getExternalExecutionTurnId(); },

    getActiveImBridgeTurnContext() {
      return getActiveExternalImBridgeTurnContext();
    },

    getSessionCompletionTerminal() {
      return getExternalSessionCompletionTerminal();
    },

    hasQueuedTurnOwnedBy(owner) {
      return hasExternalQueuedTurnByOwner(owner);
    },

    async sendDesktopMessage(request: DesktopMessageRequest): Promise<DesktopAdmissionResult> {
      if (request.permissionMode !== undefined && !isPermissionModeForRuntimeIdentity(
        request.permissionMode,
        getActiveRuntimeType(),
        getActiveRuntimeSource(),
      )) {
        return {
          success: false,
          status: 400,
          error: `Invalid permissionMode '${request.permissionMode}' for ${getActiveRuntimeSource() ?? getActiveRuntimeType()}`,
        };
      }
      if (request.asyncQuestionReply) {
        const error = await validateExternalAsyncQuestionReply(request.sessionId, request.asyncQuestionReply);
        if (error) return { success: false, status: 409, error };
      }
      const sent = enqueueExternalSendForDesktop(
        request.text,
        request.images,
        request.permissionMode,
        request.model,
        {
          sessionId: request.sessionId,
          clientRequestId: request.clientRequestId,
          asyncQuestionReply: request.asyncQuestionReply,
          desktopQuery: request.desktopQuery,
          workspacePath: request.workspacePath,
          scenario: request.scenario,
          analyticsSource: request.analyticsSource,
          analyticsOrigin: request.analyticsOrigin,
          birthOrigin: request.birthOrigin,
          permissionMode: request.permissionMode,
          model: request.model,
          providerRoute: getActiveRuntimeType() === 'dsh' ? request.providerRoute : undefined,
          reasoningEffort: request.reasoningEffort,
          turnBoundaryOnly: request.turnBoundaryOnly,
          queueId: request.queueId,
          turnOwner: request.turnOwner,
          onTerminal: request.onTerminal,
          beforeDispatch: request.beforeDispatch,
          requiredSystemSkill: request.requiredSystemSkill,
          channelDelivery: DESKTOP_CHANNEL_DELIVERY,
        },
      );
      const dispatchAcceptance = observeExternalDispatch(
        sent.dispatch,
        request.queueId,
        sent.userMessageId,
      );
      return {
        success: true,
        queued: sent.queued,
        queueId: sent.queueId,
        isInFlight: sent.isInFlight,
        deliveryMode: sent.deliveryMode,
        canCancel: sent.canCancel,
        canForceExecute: sent.canForceExecute,
        dispatchAcceptance,
      };
    },

    compactContext() {
      return compactExternalContext();
    },

    async enqueueImMessage(request: ImMessageRequest): Promise<ImAdmissionResult> {
      const sent = enqueueExternalSendForIm(
        request.message,
        request.images,
        {
          sessionId: request.sessionId,
          workspacePath: request.workspacePath,
          scenario: request.scenario,
          permissionMode: request.permissionMode,
          model: request.model,
          reasoningEffort: request.reasoningEffort,
          requestId: request.requestId,
          metadataBirthPending: request.metadataBirthPending === true,
          analyticsOrigin: request.analyticsOrigin,
          queueId: request.queueId,
          turnOwner: request.turnOwner,
          onTerminal: request.onTerminal,
          beforeDispatch: request.beforeDispatch,
          channelDelivery: IM_CHANNEL_DELIVERY,
        },
      );
      const dispatchAcceptance = observeExternalDispatch(
        sent.dispatch,
        sent.queueId ?? request.queueId,
        sent.userMessageId,
      );

      // A queueId means the existing external turn-boundary queue has taken
      // ownership. Return admission immediately; the request-scoped terminal
      // and Goal lifecycle stay attached to the queued operation until drain.
      if (sent.queueId) {
        return {
          success: true,
          queued: true,
          dispatchAcceptance,
        };
      }

      // Idle sends retain the adapter's existing admission result instead of
      // being reported as queue-owned. This preserves fail-loud startup/config
      // errors where the runtime reports them, without reintroducing the busy
      // wait that blocked Lark's same-chat ingress queue.
      const accepted = await dispatchAcceptance;
      if (!accepted.accepted) {
        return {
          success: false,
          error: accepted.error ?? 'Failed to send via external runtime',
          status: 503,
        };
      }
      return { success: true, queued: true };
    },

    cancelImRequest(requestId, reason) {
      return cancelExternalImRequest(requestId, reason);
    },

    async enqueueBackgroundMessage(request) {
      const result = await sendExternalMessage(
        request.text,
        request.images,
        undefined,
        undefined,
        {
          sessionId: request.sessionId,
          workspacePath: request.workspacePath,
          scenario: request.scenario,
          permissionMode: request.permissionMode,
          model: request.model,
          reasoningEffort: request.reasoningEffort,
          analyticsOrigin: request.analyticsOrigin,
          queueId: request.queueId,
          turnOwner: request.turnOwner,
          onTerminal: request.onTerminal,
          ...(request.beforeDispatch ? { beforeDispatch: request.beforeDispatch } : {}),
          channelDelivery: SESSION_BOUND_CHANNEL_DELIVERY,
        },
      );
      if (!result.queued) {
        if (result.terminationUnconfirmed) {
          return { success: true, queued: true };
        }
        if (request.queueId) clearExternalTurnBinding(request.queueId);
        return {
          success: false,
          error: result.error ?? 'Failed to send via external runtime',
          status: 503,
        };
      }
      return { success: true, queued: result.queued };
    },

    async enqueueInboxMessage(request) {
      // Fresh Inbox metadata is born after Sidecar bootstrap. Capture its owned
      // config at admission instead of the still-empty bootstrap desired state.
      // Existing snapshots remain authoritative; legacy/live-follow Sessions
      // retain their already-hydrated config and the queue's realtime semantics.
      const metadata = getSessionMetadata(request.sessionId);
      const config = metadata?.configSnapshotAt
        ? resolveWorkspaceConfig(request.workspacePath, metadata, { includeMcp: false })
        : undefined;
      // The operation queue owns admission. Runtime dispatch can wait for the
      // preceding turn and must not hold the caller's Inbox HTTP/lifecycle lease.
      const result = enqueueExternalSendForInbox(
        request.text,
        {
          sessionId: request.sessionId,
          workspacePath: request.workspacePath,
          scenario: request.scenario ?? { type: 'desktop' },
          ...(config ? {
            model: config.model,
            permissionMode: config.permissionMode,
            reasoningEffort: config.reasoningEffort ?? 'default',
          } : {}),
          inboxMeta: request.inboxMeta,
          metadataBirthPending: request.allowLazySessionMaterialization === true,
          analyticsOrigin: request.analyticsOrigin,
          birthOrigin: request.birthOrigin,
          queueId: request.queueId,
          beforeDispatch: request.beforeDispatch,
          channelDelivery: SESSION_BOUND_CHANNEL_DELIVERY,
        },
      );
      const dispatchAcceptance = result.dispatch.then(
        dispatched => ({ accepted: dispatched.queued && !dispatched.error, error: dispatched.error }),
        () => ({ accepted: false, error: 'external runtime dispatch failed' }),
      );
      return {
        queued: result.queued,
        ...(!result.queued ? { error: 'external operation queue rejected inbox message' } : {}),
        dispatchAcceptance,
      };
    },

    async prepareScheduledTurn(request): Promise<ScheduledTurnPreparationResult> {
      await awaitExternalSessionStarting();
      const metadata = getSessionMetadata(request.sessionId);
      if (!metadata) {
        return { success: false, code: 'session_bind_failed', status: 409 };
      }
      const currentSessionId = getCurrentBoundSessionId() || getExternalSessionId();
      if (currentSessionId !== request.sessionId) {
        if (hasExternalRuntimeProcess() && !await stopExternalSession()) {
          return {
            success: false,
            code: 'session_bind_failed',
            status: 503,
            error: 'External runtime process did not stop',
          };
        }
        await resetProductSessionBinding({
          sessionId: request.sessionId,
          workspacePath: request.workspacePath,
          hasInitialPrompt: true,
          allowLazySessionMaterialization: false,
        });
      } else if (getCurrentProductSessionId() !== request.sessionId) {
        // Runtime lifecycle and product identity are separate owners. Repair
        // the product binding without restarting an already-correct native
        // Session when only the former projection is stale.
        await resetProductSessionBinding({
          sessionId: request.sessionId,
          workspacePath: request.workspacePath,
          hasInitialPrompt: true,
          allowLazySessionMaterialization: false,
        });
      }
      // Do not reload persisted transcript/config over a coherently bound live
      // Session. A scheduled turn may queue behind an in-flight desktop turn;
      // restoring here would replace that turn's unpersisted in-memory tail.
      // The runtime owner already exposes the exact restored-state predicate,
      // so only stale/new bindings need disk rehydration.
      if (!await isExternalSessionStateRestoredFor(request.sessionId)) {
        const restored = await restoreExternalSessionState(request.sessionId, request.workspacePath, request.scenario);
        if (!restored.success) {
          return { success: false, code: 'session_bind_failed', status: 500, error: restored.error };
        }
      }

      const runtime = getActiveRuntimeType();
      if (request.operation.kind === 'goal') {
        return {
          success: true,
          sessionId: request.sessionId,
          permissionMode: resolveScheduledTurnPermissionMode(
            'goal',
            request.operation.permissionMode,
            undefined,
            runtime,
          ),
        };
      }

      const operation = request.operation;
      const managedCodexReady = isManagedCodexProviderReady(loadAdminConfig());
      const agent = findProjectAgentByWorkspacePath(request.workspacePath) as AgentConfig | undefined;
      let runtimeConfig = operation.runtimeConfig;
      if (metadata) {
        const resolved = resolveSessionConfig(metadata, agent, undefined, 'owned', {
          managedCodexProviderReady: managedCodexReady,
        });
        runtimeConfig = {
          ...(operation.runtimeConfig ?? {}),
          source: operation.runtimeConfig?.source ?? resolved.runtimeSource ?? runtimeConfig?.source,
          model: operation.runtimeConfig?.model ?? resolved.model,
          permissionMode: operation.runtimeConfig?.permissionMode
            ?? operation.permissionMode
            ?? resolved.permissionMode,
        };
      }
      if (operation.permissionMode) {
        runtimeConfig = { ...(runtimeConfig ?? {}), permissionMode: operation.permissionMode };
      }
      if (runtimeConfigSource(runtimeConfig) === 'managed-provider' && !managedCodexReady) {
        return {
          success: false,
          code: 'configuration_failed',
          status: 400,
          error: managedCodexNotReadyMessage('cron task execution'),
        };
      }

      return {
        success: true,
        sessionId: request.sessionId,
        permissionMode: resolveScheduledTurnPermissionMode(
          'cron',
          operation.permissionMode,
          runtimeConfig?.permissionMode,
          runtime,
        ),
        model: runtimeConfigModel(runtimeConfig, runtime),
        runtimeConfig: runtimeConfig ?? null,
        beforeDispatch: operation.beforeDispatch,
        requiredSystemSkill: operation.requiredSystemSkill,
      };
    },

    async runInjectedTurn(request: InjectedTurnRequest): Promise<InjectedTurnResult> {
      const deadline = Date.now() + request.timeoutMs;
      const queueId = request.queueId ?? `xq-${randomUUID()}`;
      let observedOutcome: TurnTerminalOutcome | undefined;
      let resolveTerminal!: (outcome: TurnTerminalOutcome) => void;
      const terminal = new Promise<TurnTerminalOutcome>((resolve) => {
        resolveTerminal = resolve;
      });
      const sendPromise = sendExternalMessage(
        request.prompt,
        undefined,
        undefined,
        undefined,
        {
          sessionId: request.sessionId,
          workspacePath: request.workspacePath,
          scenario: request.scenario,
          permissionMode: request.permissionMode,
          model: request.model,
          reasoningEffort: request.reasoningEffort,
          metadataBirthPending: request.metadataBirthPending === true,
          analyticsOrigin: request.analyticsOrigin,
          queueId,
          turnOwner: request.turnOwner,
          onTerminal: async (outcome) => {
            observedOutcome = outcome;
            try {
              await request.onTerminal?.(outcome);
            } finally {
              resolveTerminal(outcome);
            }
          },
          beforeDispatch: request.beforeDispatch,
          requiredSystemSkill: request.requiredSystemSkill,
          channelDelivery: injectedTurnChannelDelivery(request.assistantChannelDelivery),
        },
      );
      const result = await waitForDeadline(sendPromise, deadline - Date.now());
      if (!result) {
        request.beforeDispatch?.cancel?.();
        void sendPromise.catch(() => undefined);
        const dispatchAccepted = isExternalTurnCurrent(queueId);
        const stopped = !dispatchAccepted || await stopExternalTarget();
        if (stopped) clearExternalTurnBinding(queueId);
        return {
          success: false,
          enqueued: dispatchAccepted,
          ...(!stopped ? { terminationUnconfirmed: true } : {}),
          error: !dispatchAccepted
            ? 'External runtime turn timed out before dispatch'
            : stopped
              ? 'External runtime turn timed out during dispatch'
              : 'External runtime turn timed out and its process did not stop',
          status: 408,
        };
      }
      if (!result.queued) {
        if (result.terminationUnconfirmed) {
          return {
            success: false,
            enqueued: true,
            terminationUnconfirmed: true,
            error: result.error ?? 'External runtime dispatch acknowledgement failed and its process did not stop',
            status: 503,
          };
        }
        clearExternalTurnBinding(queueId);
        return {
          success: false,
          enqueued: false,
          error: result.error ?? 'Failed to start external runtime turn',
          status: 503,
        };
      }
      try {
        await request.onDispatched?.(queueId, request.sessionId);
      } catch (error) {
        console.warn('[session-engine] external onDispatched callback failed; terminal compensation remains available:', error);
      }
      const outcome = await waitForDeadline(terminal, deadline - Date.now());
      if (!outcome) {
        request.beforeDispatch?.cancel?.();
        if (observedOutcome) {
          const settledOutcome = await terminal;
          const decision = decideExternalInjectedTurnResult({
            idleCompleted: true,
            turnSucceeded: settledOutcome.status === 'complete',
            text: settledOutcome.status === 'complete' ? settledOutcome.text : undefined,
            error: settledOutcome.error,
          });
          return { ...decision, enqueued: true };
        }
        const stopped = await stopExternalTarget();
        if (stopped) clearExternalTurnBinding(queueId);
        return {
          ...decideExternalInjectedTurnResult({ idleCompleted: false }),
          enqueued: true,
          ...(!stopped ? { terminationUnconfirmed: true } : {}),
          ...(!stopped
            ? { error: 'External runtime turn timed out and its process did not stop' }
            : {}),
        };
      }
      const decision = decideExternalInjectedTurnResult({
        idleCompleted: true,
        turnSucceeded: outcome.status === 'complete',
        text: outcome.status === 'complete' ? outcome.text : undefined,
        error: outcome.error,
      });
      return { ...decision, enqueued: true };
    },

    async stopTurn(options) {
      if (!isExternalSessionActive() && !(options?.wholeSession && (hasExternalRuntimeProcess() || isExternalSessionBusy()))) {
        return { success: true, alreadyStopped: true };
      }
      const stopped = options?.preserveQueue
        ? await stopExternalTarget()
        : await stopExternalSession();
      return stopped
        ? { success: true, alreadyStopped: false }
        : { success: false, error: 'External runtime process did not stop' };
    },

    async stopOwnedTurn(owner) {
      const admitted = getExternalCurrentTurnIdentity();
      if (
        admitted
        && admitted.owner.kind === owner.kind
        && admitted.owner.id === owner.id
        && isExternalTurnCurrent(admitted.queueId)
      ) {
        const stopped = await stopExternalTarget();
        return stopped
          ? { success: true, alreadyStopped: false }
          : { success: false, error: 'External runtime process did not stop' };
      }
      const canceled = cancelExternalQueuedTurnsByOwner(owner);
      const promotionSettlement = await canceled.promotion?.settled;
      if (promotionSettlement?.status === 'termination-unconfirmed') {
        return { success: false, error: 'External runtime process did not stop' };
      }
      if (
        promotionSettlement?.status === 'not-dispatched'
        || promotionSettlement?.status === 'terminated'
      ) {
        return { success: true, alreadyStopped: false };
      }
      const current = getExternalCurrentTurnIdentity();
      if (!current || current.owner.kind !== owner.kind || current.owner.id !== owner.id) {
        return { success: true, alreadyStopped: canceled.count === 0 };
      }
      const stopped = await stopExternalTarget();
      return stopped
        ? { success: true, alreadyStopped: false }
        : { success: false, error: 'External runtime process did not stop' };
    },

    async cancelQueuedMessage(queueId) {
      const cancellation = await cancelExternalQueueItem(queueId);
      if (!cancellation) return { status: 'not_found' as const };
      const settlement = await cancellation.promotion?.settled;
      if (
        settlement
        && (settlement.status === 'termination-unconfirmed' || settlement.status === 'dispatched')
        && isExternalTurnCurrent(queueId)
      ) {
        return { status: 'not_cancelled' as const };
      }
      return { status: 'cancelled' as const, cancelledText: cancellation.cancelledText };
    },

    forceQueuedMessage(queueId) {
      return forceExecuteExternalQueueItem(queueId);
    },

    getQueueStatus: getExternalQueueStatus,

    waitIdle(timeoutMs, pollMs) {
      return waitForExternalSessionIdle(timeoutMs, pollMs);
    },

    async applyModelSelection(input) {
      const result = await updateExternalRuntimeConfig({ model: input.model, reasoningEffort: input.reasoningEffort }, { source: 'message-snapshot' });
      return { success: result.success, status: result.status === 'queued' ? 'pending-next-turn' : result.status, error: result.error };
    },

    updateModel(model, opts) {
      return setExternalModel(model, opts);
    },

    updatePermissionMode(mode) {
      return setExternalPermissionMode(mode);
    },

    listAgentWork(tasksFor) { return listExternalAgentWork(tasksFor); },
    controlAgentWork(input) { return controlExternalAgentWork(input); },

    listPermissionRules() {
      return listExternalPermissionRules();
    },

    addPermissionRule(input) {
      return addExternalPermissionRule(input);
    },

    revokePermissionRule(input) {
      return revokeExternalPermissionRule(input);
    },

    updateReasoningEffort(effort) {
      return setExternalReasoningEffort(effort);
    },

    updateOfficialToolIds(ids) {
      return handleExternalOfficialToolIdsChange(ids);
    },

    async updateProxyConfig(proxySettings) {
      const oldManagedProviderKey = getProviderProxyScopeKey(CODEX_SUBSCRIPTION_PROVIDER_ID);
      const oldProcessEnvKey = getProcessProxyEnvKey();
      await setProcessProxyConfig(proxySettings);
      const newManagedProviderKey = getProviderProxyScopeKey(CODEX_SUBSCRIPTION_PROVIDER_ID);
      const newProcessEnvKey = getProcessProxyEnvKey();
      return handleExternalProxyConfigChange({
        oldManagedProviderKey,
        newManagedProviderKey,
        oldProcessEnvKey,
        newProcessEnvKey,
      });
    },

    async materializePendingDesktopSession(request) {
      const phase = request.phase ?? 'commit';
      if (phase === 'rollback') {
        return rollbackPendingProductSession(request.preparedSessionId);
      }
      if (phase === 'prepare') {
        return preparePendingProductSession(
          { snapshotPatch: request.snapshotPatch, origin: request.origin },
          {
            hasActiveWork: isExternalSessionBusy() || getExternalQueueStatus().length > 0,
            createPreparedMetadata() {
              const targetSessionId = randomUUID();
              const created = createExternalProductSessionMetadata(
                targetSessionId,
                request.workspacePath,
                'desktop',
                request.origin,
              );
              Object.assign(created.metadata, request.birthSnapshot);
              return {
                targetSessionId,
                reusingNativeSession: false,
                snapshotKind: created.snapshotKind,
                metadata: created.metadata,
              };
            },
          },
        );
      }
      if (phase !== 'commit') {
        return { success: false, error: `Unsupported materialize phase: ${phase}`, status: 400 };
      }

      await awaitExternalSessionStarting();
      // DSH persistence is scoped by Product Session identity. A native Session
      // created under a provisional Product id cannot be resumed after the id
      // changes, so pending materialization never carries that native id across.
      // Codex native stores are independent of the Product id and retain
      // their existing handoff behavior.
      const nativeSessionId = getActiveRuntimeType() === 'dsh'
        ? undefined
        : getExternalNativeSessionId() || undefined;
      return commitPendingProductSession({
        preparedSessionId: request.preparedSessionId,
        async beforeBind() {
          if (hasExternalRuntimeProcess()) await stopExternalSession();
        },
        async afterBind(_prepared, metadata) {
          if (nativeSessionId && metadata.runtimeSessionId !== nativeSessionId) {
            const updated = await updateSessionMetadata(metadata.id, { runtimeSessionId: nativeSessionId });
            if (!updated) {
              console.warn(`[session-engine] external materialize: failed to preserve runtimeSessionId for ${metadata.id}`);
            }
          }
          const restored = await restoreExternalSessionState(metadata.id, request.workspacePath, { type: 'desktop' });
          if (!restored.success) throw new Error(restored.error ?? 'External Session restore failed');
        },
      });
    },

    freezeCurrentSessionForImDetach(options) {
      return freezeCurrentProductSessionMetadata({
        workspacePath: getRuntimeWorkspacePath(),
        snapshotPatch: buildExternalFreezeSnapshotPatch(),
        allowMissingMetadata: options?.metadataBirthPending === true || options?.metadataIndexed === false,
      });
    },

    async respondPermission(requestId, decision, reason) {
      return respondExternalPermission(requestId, decision, reason);
    },

    respondAskUserQuestion(requestId, answers) {
      return respondExternalAskUserQuestion(requestId, answers);
    },

    respondPlanApproval(requestId, approved, feedback) {
      return respondExternalPlanApproval(requestId, approved, feedback);
    },

    rewindToUserMessage(userMessageId) {
      return rewindExternalConversation(userMessageId);
    },

    async retryUserMessage(userMessageId, options) {
      const context = this.getCurrentSessionContext();
      const replay = async (rewound: Awaited<ReturnType<typeof rewindExternalConversation>>) => {
        if (rewound.errorCode === 'restore_failed') {
          return { ...rewound, success: false, conversationCommitted: true, retryQueued: false };
        }
        try {
          const prepared = await prepareDesktopQuery(retryDesktopRequest(context, rewound, options));
          const sent = await this.sendDesktopMessage(prepared.request);
          if (sent.success && sent.queueId) await forceExecuteExternalQueueItem(sent.queueId);
          return { ...rewound, success: sent.success, conversationCommitted: true, retryQueued: sent.success, error: sent.error };
        } catch (error) {
          return { ...rewound, success: false, conversationCommitted: true, retryQueued: false, error: String(error) };
        }
      };
      if (getActiveRuntimeType() === 'dsh') {
        return retryDshConversation(userMessageId, replay);
      }
      return rewindExternalConversation(userMessageId, replay);
    },

    forkAtAssistantMessage(messageId, options) {
      return forkExternalConversation(messageId, options?.targetSessionId);
    },

    async updateProviderEnv() {
      return { success: true, skipped: 'external-runtime' };
    },

    async updateMcpServers(servers) {
      return handleExternalMcpServersChange(servers);
    },

    retryMcpServer(serverId) {
      return retryExternalMcpServer(serverId);
    },

    async updateAgents() {
      return handleExternalAgentsChange();
    },

    async updateEnabledPluginIds(ids) {
      const result = await handleExternalSessionEnabledPluginsChange(ids);
      return { ...result, enabledIds: ids };
    },

    async updateDesktopInteractionScenario(scenario) {
      return handleExternalDesktopInteractionScenarioChange(scenario);
    },

    async resetForNewDesktopSession(workspacePath) {
      await awaitExternalSessionStarting();
      const lease = tryAcquireExternalSessionMutationLease();
      if (!lease) {
        return { success: false, error: 'Wait for the current Session operation to finish' };
      }
      try {
        if (hasExternalRuntimeProcess()) {
          await stopExternalSession();
        }
        const newSessionId = await resetProductSessionBinding({ workspacePath, hasInitialPrompt: false });
        await publishCurrentProductSessionMetadata(sessionId => {
          const created = createExternalProductSessionMetadata(sessionId, workspacePath, 'desktop');
          Object.assign(created.metadata, buildExternalFreezeSnapshotPatch());
          return created;
        });
        broadcast('chat:init', { agentDir: workspacePath, sessionState: 'idle', hasInitialPrompt: false });
        const restored = await restoreExternalSessionState(newSessionId, workspacePath, { type: 'desktop' });
        if (!restored.success) return { success: false, error: restored.error };
        return { success: true, sessionId: newSessionId };
      } finally {
        lease.release();
      }
    },

    async migrateBoundSurfaceSession(workspacePath, options) {
      await awaitExternalSessionStarting();
      const lease = tryAcquireExternalSessionMutationLease();
      if (!lease) {
        return { success: false, error: 'Wait for the current Session operation to finish' };
      }
      try {
        const freeze = await freezeCurrentProductSessionMetadata({
          workspacePath,
          snapshotPatch: buildExternalFreezeSnapshotPatch(),
          allowMissingMetadata: options?.metadataBirthPending === true || options?.metadataIndexed === false,
        });
        if (!freeze.success) {
          return { success: false, error: freeze.error ?? 'Failed to freeze current Session before surface migration' };
        }
        if (hasExternalRuntimeProcess()) {
          const stopped = await stopExternalSession();
          if (!stopped && hasExternalRuntimeProcess()) {
            return { success: false, error: 'External runtime process did not stop' };
          }
        }
        await resetProductSessionBinding({
          sessionId: options.targetSessionId,
          workspacePath,
          hasInitialPrompt: false,
          allowLazySessionMaterialization: true,
        });

        // The target binding is committed above. Metadata publication and
        // pre-warm are recoverable preparation, not transaction admission;
        // reporting a failure after identity changed would make Rust roll back
        // a migration that Node already accepted.
        try {
          await publishCurrentProductSessionMetadata(sessionId =>
            createExternalProductSessionMetadata(sessionId, workspacePath, 'agent-channel'));
          broadcast('chat:init', { agentDir: workspacePath, sessionState: 'idle', hasInitialPrompt: false });
          const restored = await restoreExternalSessionState(options.targetSessionId, workspacePath, { type: 'desktop' });
          if (!restored.success) {
            console.warn('[session-engine] Surface migration pre-warm deferred:', restored.error);
          }
        } catch (error) {
          console.warn('[session-engine] Surface migration post-commit preparation deferred:', error);
        }
        return { success: true, sessionId: options.targetSessionId };
      } finally {
        lease.release();
      }
    },
  };
}

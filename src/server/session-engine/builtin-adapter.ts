import { randomUUID } from 'node:crypto';
import {
  cancelQueueItem,
  cancelQueuedTurnsByOwner,
  cancelImRequest as cancelBuiltinImRequest,
  applyMcpOverrideAndAwaitReady,
  enqueueUserMessage,
  forkSession,
  forceExecuteQueueItem,
  getAndClearLastAgentError,
  getAgents,
  getAgentState,
  getBuiltinLiveSessionSnapshot,
  getBuiltinSessionCompletionTerminal,
  getCurrentMcpServers,
  getBuiltinMcpEffectiveSnapshot,
  getLastBuiltinAssistantText,
  getMcpServers,
  getMessages,
  getPendingInteractiveRequests,
  getQueueStatus,
  getCurrentTurnIdentity as getBuiltinCurrentTurnIdentity,
  getCurrentImBridgeTurnContext,
  getDispatchedTurnIdentity as getBuiltinDispatchedTurnIdentity,
  hasQueuedTurnByOwner as hasBuiltinQueuedTurnByOwner,
  getSessionId,
  getSessionModel,
  getSessionPermissionMode,
  getSessionEnabledOfficialToolIds,
  getSessionProviderEnv,
  getSessionProviderId,
  getSessionReasoningEffort,
  getStreamingAssistantId,
  getSystemInitInfo,
  handleAskUserQuestionResponse,
  handlePermissionResponse,
  interruptCurrentResponse,
  isSessionBusy,
  freezeCurrentSessionMetadataForImDetach,
  materializeCurrentSessionMetadataForPublishedReset,
  materializePendingDesktopSession as materializeBuiltinPendingDesktopSession,
  resetSession,
  resetInteractionScenario,
  requireCurrentBuiltinSkill,
  rewindSession,
  setAgents,
  setBackgroundAgentPermissionMode,
  setInteractionScenario,
  setMcpServers,
  setSessionModel,
  setSessionPermissionMode,
  setSessionEnabledOfficialToolIds,
  setSessionEnabledPluginIds,
  setSessionProviderEnv,
  setProxyConfig,
  setSessionReasoningEffort,
  stripPlaywrightResults,
  switchToSession,
  waitForSessionIdle,
} from '../agent-session';
import type { MessageWire, PermissionMode } from '../agent-session';
import type { ProviderEnv } from '../provider-types';
import type { AgentDefinition } from '@anthropic-ai/claude-agent-sdk';
import type { CancelReason } from '../utils/cancellation';
import { createConcreteProviderRoute, isConcreteProviderRoute, type ProviderRoute } from '../../shared/providerRoute';
import {
  decodeProviderEnvSnapshot,
  findProjectAgentByWorkspacePath,
  getAllMcpServers,
  getEffectiveMcpServers,
  getEffectiveOfficialToolIdsForSession,
  getEnabledMcpServerIds,
  isProviderDisabled,
  loadConfig,
  materializeProviderRouteEnv,
  resolveSubscriptionAuthKind,
  resolveWorkspaceConfig,
} from '../utils/admin-config';
import type {
  DesktopAdmissionResult,
  DesktopMessageRequest,
  ImAdmissionResult,
  ImMessageRequest,
  InjectedTurnRequest,
  InjectedTurnResult,
  SessionEngineReplayMessage,
  SessionEngine,
  ScheduledTurnPreparationResult,
} from './types';
import { decideBuiltinInjectedTurnResult } from '../session-core/turn-result-policy';
import type { DispatchGuard, TurnTerminalOutcome } from '../session-core/turn-queue';
import {
  ensureRegisteredAgentSessionOrigin,
  getPersistedSessionOrigin,
  getSessionData,
  getSessionMetadata,
} from '../SessionStore';
import type { SessionMessage } from '../types/session';
import { getLatestAssistantResultFromMessages, NO_TEXT_RESPONSE } from '../inbox/latest-result';
import { shrinkReplayContentForClient } from '../utils/session-message-preview';
import {
  DESKTOP_CHANNEL_DELIVERY,
  IM_CHANNEL_DELIVERY,
  SESSION_BOUND_CHANNEL_DELIVERY,
  injectedTurnChannelDelivery,
} from '../session-core/channel-delivery';
import type { AgentConfig } from '../../shared/types/agent';
import { resolveSessionConfig } from '../utils/resolve-session-config';
import { isManagedCodexProviderReady, managedCodexNotReadyMessage } from '../utils/managed-codex-readiness';
import {
  resolveTaskProviderRouting,
  taskProviderRoutingRecovery,
  type TaskProviderRoutingOwner,
} from '../utils/task-provider-routing';
import { resolveScheduledTurnPermissionMode } from '../../shared/types/runtime';
import {
  createScheduledDispatchGuard,
  runtimeConfigSource,
} from './scheduled-turn-preparation';

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

function taskProviderRoutingOwner(
  request: Parameters<SessionEngine['prepareScheduledTurn']>[0],
  hasTaskProviderOverride: boolean,
  agent: AgentConfig | undefined,
): TaskProviderRoutingOwner {
  if (hasTaskProviderOverride && request.scenario.type === 'cron') {
    return { kind: 'task', taskId: request.scenario.taskId };
  }
  if (request.operation.kind === 'task' && request.operation.initializeSession && agent) {
    return { kind: 'agent', agentId: agent.id };
  }
  return { kind: 'session', sessionId: request.sessionId };
}

// runInjectedTurn requires an explicit promotion acknowledgement even when no
// domain guard is present. MCP readiness is intentionally not part of it.
const acceptInjectedTurnDispatch: DispatchGuard = async () => ({ accepted: true });

function providerEnvForRouteRequest(request: {
  providerRoute?: ProviderRoute;
  providerEnv?: ProviderEnv | 'subscription';
  providerRoutingRecovery?: string;
  model?: string;
}): { providerEnv: ProviderEnv | 'subscription' | undefined; model?: string; error?: string; status?: number } {
  if (!request.providerRoute) {
    return { providerEnv: request.providerEnv, model: request.model };
  }
  if (!isConcreteProviderRoute(request.providerRoute)) {
    return {
      providerEnv: undefined,
      error: 'Provider/model selection is incomplete. Select a provider-model pair before sending.',
      status: 409,
    };
  }
  if (request.model && request.model !== request.providerRoute.model) {
    return {
      providerEnv: undefined,
      error: `ProviderRoute/model mismatch: route model "${request.providerRoute.model}" does not match request model "${request.model}".`,
      status: 409,
    };
  }
  if (request.providerRoute.kind === 'subscription') {
    const authKind = resolveSubscriptionAuthKind(request.providerRoute.providerId);
    if (authKind === 'sdk-native') {
      return { providerEnv: 'subscription', model: request.providerRoute.model };
    }
    if (authKind !== 'host-managed-oauth') {
      return {
        providerEnv: undefined,
        error: `Subscription provider '${request.providerRoute.providerId}' cannot execute in builtin runtime`,
        status: 409,
      };
    }
  }
  const providerEnv = materializeProviderRouteEnv(request.providerRoute);
  if (!providerEnv) {
    const recovery = request.providerRoutingRecovery?.trim();
    return {
      providerEnv: undefined,
      error: `Provider "${request.providerRoute.providerId}" is unavailable or missing an API key.${recovery ? ` ${recovery}` : ''}`,
      status: 409,
    };
  }
  return { providerEnv, model: request.providerRoute.model };
}

function getLatestBuiltinResult(): string {
  let latestResult = getLastBuiltinAssistantText();
  if (!latestResult.trim()) {
    const data = getSessionData(getSessionId());
    latestResult = data
      ? getLatestAssistantResultFromMessages(data.messages)
      : NO_TEXT_RESPONSE;
  }
  return latestResult.trim() || NO_TEXT_RESPONSE;
}

function asBuiltinPermissionMode(mode: string | undefined): PermissionMode | undefined {
  return mode === 'auto' || mode === 'plan' || mode === 'fullAgency' || mode === 'custom'
    ? mode
    : undefined;
}

function getBuiltinWorkspacePath(): string | null {
  const state = getAgentState();
  return typeof state.agentDir === 'string' && state.agentDir.length > 0
    ? state.agentDir
    : null;
}

function messageWireToReplayMessage(message: MessageWire | SessionMessage): SessionEngineReplayMessage {
  const strippedContent = typeof message.content !== 'string'
    ? stripPlaywrightResults(message.content)
    : message.content;
  const content = shrinkReplayContentForClient(strippedContent);
  return {
    id: message.id,
    role: message.role,
    content,
    timestamp: message.timestamp,
    sdkUuid: message.sdkUuid,
    attachments: message.attachments,
    metadata: message.metadata,
    usage: message.usage,
    toolCount: message.toolCount,
    durationMs: message.durationMs,
  };
}

export function createBuiltinSessionEngine(): SessionEngine {
  return {
    kind: 'builtin',

    isBusy() {
      return isSessionBusy();
    },

    getRuntimeIdentity() {
      return {
        kind: 'builtin',
        runtime: 'builtin',
        sessionId: getSessionId(),
      };
    },

    getLiveSessionState() {
      return {
        sessionState: getAgentState().sessionState,
        isBusy: isSessionBusy(),
      };
    },

    getLatestAssistantResult() {
      return {
        sessionId: getSessionId(),
        latestResult: getLatestBuiltinResult(),
      };
    },

    getStreamReplaySnapshot() {
      const sessionId = getSessionId();
      const liveSnapshot = getBuiltinLiveSessionSnapshot(sessionId);
      const streamingId = getStreamingAssistantId();
      const replayMessages = getMessages()
        .filter(message => !(streamingId && message.id === streamingId))
        .map(messageWireToReplayMessage);
      const systemInitInfo = getSystemInitInfo();
      return {
        sessionId,
        initState: getAgentState(),
        replayMessages,
        liveStreamingMessage: liveSnapshot?.liveStreamingMessage
          ? messageWireToReplayMessage(liveSnapshot.liveStreamingMessage)
          : null,
        systemInitPayload: systemInitInfo ? { info: systemInitInfo } : undefined,
        mcpEffectiveSnapshot: getBuiltinMcpEffectiveSnapshot(),
        pendingInteractiveRequests: getPendingInteractiveRequests(),
      };
    },

    getSessionConfigSnapshot() {
      const model = getSessionModel();
      const providerId = getSessionProviderId();
      const mcpServers = getMcpServers();
      const agents = getAgents();
      const sessionId = getSessionId();
      const session = getSessionData(sessionId);
      const workspacePath = getBuiltinWorkspacePath();
      const enabledOfficialToolIds = workspacePath
        ? getEffectiveOfficialToolIdsForSession(
          workspacePath,
          session,
          getSessionEnabledOfficialToolIds(),
        )
        : [];
      return {
        success: true,
        runtime: 'builtin',
        model: model ?? null,
        mcpServerIds: mcpServers?.map(s => s.id) ?? null,
        agentNames: agents ? Object.keys(agents) : null,
        enabledOfficialToolIds,
        permissionMode: getSessionPermissionMode(),
        providerId,
        providerRoute: model && providerId ? createConcreteProviderRoute(providerId, model) : null,
        reasoningEffort: getSessionReasoningEffort() ?? 'default',
      };
    },

    getCurrentSessionContext() {
      const sessionId = getSessionId();
      return {
        runtime: 'builtin',
        sessionId: sessionId || null,
        workspacePath: getBuiltinWorkspacePath(),
        sessionMeta: sessionId ? getSessionData(sessionId) : null,
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
        model: getSessionModel() ?? undefined,
        permissionMode: getSessionPermissionMode(),
        providerEnv: getSessionProviderEnv(),
        reasoningEffort: getSessionReasoningEffort(),
      };
    },

    getLiveSessionOverlay(sessionId: string) {
      const snapshot = getBuiltinLiveSessionSnapshot(sessionId);
      if (!snapshot) {
        return { isActive: false };
      }
      return {
        isActive: true,
        runtime: 'builtin',
        ...snapshot,
      };
    },

    getCurrentTurnIdentity() {
      return getBuiltinCurrentTurnIdentity();
    },

    getActiveImBridgeTurnContext() {
      return getCurrentImBridgeTurnContext();
    },

    getSessionCompletionTerminal() {
      return getBuiltinSessionCompletionTerminal();
    },

    hasQueuedTurnOwnedBy(owner) {
      return hasBuiltinQueuedTurnByOwner(owner);
    },

    async sendDesktopMessage(request: DesktopMessageRequest): Promise<DesktopAdmissionResult> {
      const permissionMode = asBuiltinPermissionMode(request.permissionMode);
      if (request.permissionMode !== undefined && permissionMode === undefined) {
        return { success: false, error: `Invalid builtin permission mode: ${request.permissionMode}`, status: 400 };
      }
      await setInteractionScenario(request.scenario);
      if (request.backgroundAgentPermissionMode) {
        setBackgroundAgentPermissionMode(request.backgroundAgentPermissionMode);
      }
      const routed = providerEnvForRouteRequest(request);
      if (routed.error) {
        return { success: false, error: routed.error, status: routed.status };
      }
      const beforeDispatch = request.requiredSystemSkill
        ? createScheduledDispatchGuard({
            preceding: request.beforeDispatch ?? acceptInjectedTurnDispatch,
            requiredSystemSkill: request.requiredSystemSkill,
            requireNativeSystemSkill: skill => requireCurrentBuiltinSkill(skill),
          })
        : request.beforeDispatch;
      const result = await enqueueUserMessage(
        request.text,
        request.images,
        permissionMode,
        routed.model,
        routed.providerEnv,
        request.reasoningEffort,
        { source: 'desktop' },
        undefined,
        undefined,
        request.analyticsSource,
        request.analyticsOrigin,
        {
          fromDesktopChatSend: true,
          sessionBirthOrigin: request.birthOrigin,
          queueId: request.queueId,
          turnOwner: request.turnOwner,
          onTerminal: request.onTerminal,
          ...(request.turnBoundaryOnly ? { queueResponseModeOverride: 'turn' as const } : {}),
          beforeDispatch,
          channelDelivery: DESKTOP_CHANNEL_DELIVERY,
        },
      );
      if (result.error) {
        return { success: false, error: result.error, status: 429 };
      }
      return {
        success: true,
        queued: result.queued,
        queueId: result.queueId,
        isInFlight: result.isInFlight,
        deliveryMode: result.deliveryMode,
        dispatchAcceptance: result.dispatchAcceptance,
      };
    },

    async compactContext() {
      return {
        success: false,
        status: 409,
        error: 'Native context compaction is only available for Managed Codex',
      };
    },

    async enqueueImMessage(request: ImMessageRequest): Promise<ImAdmissionResult> {
      await setInteractionScenario(request.scenario);
      const routed = providerEnvForRouteRequest(request);
      if (routed.error) {
        return { success: false, error: routed.error, status: routed.status };
      }
      const result = await enqueueUserMessage(
        request.message,
        request.images,
        request.permissionMode as PermissionMode | undefined,
        routed.model,
        routed.providerEnv,
        request.reasoningEffort,
        request.metadata,
        request.requestId,
        undefined,
        undefined,
        request.analyticsOrigin,
        {
          allowLazySessionMaterialization: request.metadataBirthPending === true,
          queueId: request.queueId,
          turnOwner: request.turnOwner,
          onTerminal: request.onTerminal,
          ...(request.turnBoundaryOnly ? { queueResponseModeOverride: 'turn' as const } : {}),
          beforeDispatch: request.beforeDispatch,
          channelDelivery: IM_CHANNEL_DELIVERY,
        },
      );
      if (result.error) {
        return { success: false, error: result.error, status: 503 };
      }
      return { success: true, queued: result.queued, dispatchAcceptance: result.dispatchAcceptance };
    },

    cancelImRequest(requestId, reason) {
      return cancelBuiltinImRequest(requestId, reason as CancelReason | undefined);
    },

    async enqueueBackgroundMessage(request) {
      await setInteractionScenario(request.scenario);
      const routed = providerEnvForRouteRequest(request);
      if (routed.error) {
        return { success: false, error: routed.error, status: routed.status };
      }
      const result = await enqueueUserMessage(
        request.text,
        request.images,
        request.permissionMode as PermissionMode | undefined,
        routed.model,
        routed.providerEnv,
        request.reasoningEffort,
        request.metadata,
        undefined,
        undefined,
        undefined,
        request.analyticsOrigin,
        {
          ...(request.turnBoundaryOnly ? { queueResponseModeOverride: 'turn' as const } : {}),
          queueId: request.queueId,
          turnOwner: request.turnOwner,
          onTerminal: request.onTerminal,
          beforeDispatch: request.beforeDispatch,
          channelDelivery: SESSION_BOUND_CHANNEL_DELIVERY,
        },
      );
      if (result.error) {
        return { success: false, error: result.error, status: 503 };
      }
      return { success: true, queued: result.queued, dispatchAcceptance: result.dispatchAcceptance };
    },

    async enqueueInboxMessage(request) {
      const scenario = request.scenario ?? { type: 'desktop' as const };
      await setInteractionScenario(scenario);
      return enqueueUserMessage(
        request.text,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        request.inboxMeta,
        undefined,
        request.analyticsOrigin,
        {
          allowLazySessionMaterialization: request.allowLazySessionMaterialization === true,
          sessionBirthOrigin: request.birthOrigin,
          queueId: request.queueId,
          beforeDispatch: request.beforeDispatch,
          channelDelivery: SESSION_BOUND_CHANNEL_DELIVERY,
        },
      );
    },

    async prepareScheduledTurn(request): Promise<ScheduledTurnPreparationResult> {
      if (getSessionId() !== request.sessionId) {
        const switched = await switchToSession(request.sessionId);
        if (!switched || getSessionId() !== request.sessionId) {
          return { success: false, code: 'session_bind_failed', status: 409 };
        }
      }

      try {
        await setInteractionScenario(request.scenario);
      } catch (error) {
        return {
          success: false,
          code: 'scenario_failed',
          status: 500,
          error: `System prompt error: ${error}`,
        };
      }

      const release = () => resetInteractionScenario();
      if (request.operation.kind === 'goal') {
        try {
          if (getMcpServers() === null) {
            const resolved = resolveWorkspaceConfig(
              request.workspacePath,
              getSessionData(request.sessionId),
              { includeMcp: true },
            );
            await applyMcpOverrideAndAwaitReady(resolved.mcpServers);
          }
          return {
            success: true,
            sessionId: request.sessionId,
            permissionMode: resolveScheduledTurnPermissionMode(
              'goal',
              request.operation.permissionMode,
              undefined,
              'builtin',
            ),
            release,
          };
        } catch (error) {
          release();
          return {
            success: false,
            code: 'configuration_failed',
            status: 503,
            error: error instanceof Error ? error.message : String(error),
          };
        }
      }

      const operation = request.operation;
      try {
        const managedCodexReady = isManagedCodexProviderReady(loadConfig());
        const metadata = getSessionMetadata(request.sessionId);
        const agent = findProjectAgentByWorkspacePath(request.workspacePath) as AgentConfig | undefined;
        let model = operation.model;
        let providerEnv: ProviderEnv | 'subscription' | undefined;
        let providerRoute: ProviderRoute | undefined;
        let runtimeConfig = operation.runtimeConfig;
        const routingOwner = taskProviderRoutingOwner(request, Boolean(operation.providerId), agent);
        const providerRoutingRecovery = taskProviderRoutingRecovery(routingOwner);

        if (operation.providerId) {
          providerEnv = resolveTaskProviderRouting(operation.providerId, routingOwner, operation.model);
          if (operation.model) {
            providerRoute = createConcreteProviderRoute(operation.providerId, operation.model);
          }
        } else if (metadata) {
          const resolved = resolveSessionConfig(metadata, agent, undefined, 'owned', {
            managedCodexProviderReady: managedCodexReady,
          });
          model = resolved.model;
          if (isConcreteProviderRoute(resolved.providerRoute)) {
            providerRoute = resolved.providerRoute;
            model = resolved.providerRoute.model;
            providerEnv = resolveTaskProviderRouting(resolved.providerRoute.providerId, routingOwner, model);
          } else if (resolved.providerEnvJson) {
            const decoded = decodeProviderEnvSnapshot(resolved.providerEnvJson, resolved.providerId);
            if (!decoded) {
              const reason = resolved.providerId && isProviderDisabled(resolved.providerId)
                ? `Provider '${resolved.providerId}' is disabled`
                : 'Session provider snapshot is invalid';
              throw new Error(
                `${reason}. ${providerRoutingRecovery}`,
              );
            }
            providerEnv = decoded as ProviderEnv;
          } else if (resolved.providerId) {
            providerEnv = resolveTaskProviderRouting(resolved.providerId, routingOwner, model);
            if (model) providerRoute = createConcreteProviderRoute(resolved.providerId, model);
          }
          if (resolved.runtime !== 'builtin') {
            runtimeConfig = {
              ...(operation.runtimeConfig ?? {}),
              source: operation.runtimeConfig?.source ?? resolved.runtimeSource ?? runtimeConfig?.source,
              model: operation.runtimeConfig?.model ?? resolved.model,
              permissionMode: operation.runtimeConfig?.permissionMode
                ?? operation.permissionMode
                ?? resolved.permissionMode,
            };
          }
        }
        if (operation.permissionMode) {
          runtimeConfig = { ...(runtimeConfig ?? {}), permissionMode: operation.permissionMode };
        }
        if (runtimeConfigSource(runtimeConfig) === 'managed-provider' && !managedCodexReady) {
          throw new Error(managedCodexNotReadyMessage('cron task execution'));
        }

        if (operation.initializeSession) {
          try {
            let target;
            if (operation.mcpEnabledServers !== undefined) {
              const enabled = new Set(getEnabledMcpServerIds());
              const requested = new Set(operation.mcpEnabledServers.filter(id => enabled.has(id)));
              const current = (getCurrentMcpServers() ?? []).filter(server => requested.has(server.id));
              target = current.length === requested.size
                ? current
                : getAllMcpServers().filter(server => requested.has(server.id));
            } else {
              target = getEffectiveMcpServers(request.workspacePath);
            }
            await applyMcpOverrideAndAwaitReady([...target]);
          } catch (error) {
            release();
            return {
              success: false,
              code: 'configuration_failed',
              status: 500,
              error: error instanceof Error ? error.message : String(error),
            };
          }
        }

        return {
          success: true,
          sessionId: request.sessionId,
          permissionMode: resolveScheduledTurnPermissionMode(
            'cron',
            operation.permissionMode,
            runtimeConfig?.permissionMode,
            'builtin',
          ),
          model,
          providerEnv,
          providerRoute,
          providerRoutingRecovery,
          runtimeConfig: runtimeConfig ?? null,
          beforeDispatch: operation.beforeDispatch,
          requiredSystemSkill: operation.requiredSystemSkill,
          release,
        };
      } catch (error) {
        release();
        return {
          success: false,
          code: 'configuration_failed',
          status: 400,
          error: error instanceof Error ? error.message : String(error),
        };
      }
    },

    async runInjectedTurn(request: InjectedTurnRequest): Promise<InjectedTurnResult> {
      const deadline = Date.now() + request.timeoutMs;
      await setInteractionScenario(request.scenario);
      getAndClearLastAgentError();
      const queueId = request.queueId ?? randomUUID();
      let observedOutcome: TurnTerminalOutcome | undefined;
      let resolveTerminal!: (outcome: TurnTerminalOutcome) => void;
      const terminal = new Promise<TurnTerminalOutcome>((resolve) => {
        resolveTerminal = resolve;
      });
      const routed = providerEnvForRouteRequest(request);
      if (routed.error) {
        return { success: false, enqueued: false, error: routed.error, status: routed.status };
      }
      const beforeDispatch = createScheduledDispatchGuard({
        preceding: request.beforeDispatch ?? acceptInjectedTurnDispatch,
        requiredSystemSkill: request.requiredSystemSkill,
        requireNativeSystemSkill: skill => requireCurrentBuiltinSkill(skill),
      });
      const enqueueAttempt = enqueueUserMessage(
        request.prompt,
        [],
        request.permissionMode as PermissionMode | undefined,
        routed.model,
        routed.providerEnv,
        request.reasoningEffort,
        request.metadata,
        undefined,
        undefined,
        undefined,
        request.analyticsOrigin,
        {
          allowLazySessionMaterialization: request.metadataBirthPending === true,
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
          queueResponseModeOverride: 'turn',
          beforeDispatch,
          channelDelivery: injectedTurnChannelDelivery(request.assistantChannelDelivery),
        },
      );
      const enqueueResult = await waitForDeadline(
        enqueueAttempt,
        Math.max(0, deadline - Date.now()),
      );
      if (!enqueueResult) {
        await cancelQueueItem(queueId);
        return {
          success: false,
          enqueued: false,
          error: 'Builtin injected turn timed out before enqueue admission',
          status: 408,
        };
      }
      if (enqueueResult.error) {
        beforeDispatch.cancel?.();
        return { success: false, enqueued: false, error: enqueueResult.error, status: 503 };
      }
      const dispatchAcceptance = enqueueResult.dispatchAcceptance
        ? await waitForDeadline(enqueueResult.dispatchAcceptance, Math.max(0, deadline - Date.now()))
        : null;
      if (!dispatchAcceptance) {
        // Queue cancellation owns the exact guard rollback and does not return
        // until the domain owner acknowledges it.
        const cancelResult = await cancelQueueItem(queueId);
        const dispatchAccepted = getBuiltinDispatchedTurnIdentity()?.queueId === queueId;
        const terminationUnconfirmed = dispatchAccepted
          && cancelResult.status !== 'cancelled'
          && !await interruptCurrentResponse('timeout');
        return {
          success: false,
          enqueued: dispatchAccepted,
          ...(terminationUnconfirmed ? { terminationUnconfirmed: true } : {}),
          error: dispatchAccepted
            ? 'Builtin injected turn timed out during dispatch admission'
            : 'Builtin injected turn timed out before dispatch',
          status: 408,
        };
      }
      if (!dispatchAcceptance.accepted) {
        return {
          success: false,
          enqueued: false,
          error: dispatchAcceptance.error ?? 'Injected turn was rejected before dispatch',
          status: 409,
        };
      }
      try {
        await request.onDispatched?.(queueId, request.sessionId);
      } catch (error) {
        console.warn('[session-engine] builtin onDispatched callback failed; terminal compensation remains available:', error);
      }
      const outcome = await waitForDeadline(terminal, Math.max(0, deadline - Date.now()));
      if (!outcome) {
        const cancelResult = await cancelQueueItem(queueId);
        if (observedOutcome) {
          const settledOutcome = await terminal;
          return {
            ...decideBuiltinInjectedTurnResult({ idleCompleted: true, outcome: settledOutcome }),
            enqueued: true,
          };
        }
        let terminationUnconfirmed = false;
        if (cancelResult.status !== 'cancelled') {
          if (getBuiltinDispatchedTurnIdentity()?.queueId === queueId) {
            terminationUnconfirmed = !await interruptCurrentResponse('timeout');
          } else if (cancelResult.status !== 'not_found') {
            terminationUnconfirmed = true;
          }
        }
        return {
          ...decideBuiltinInjectedTurnResult({ idleCompleted: false }),
          enqueued: true,
          ...(terminationUnconfirmed ? { terminationUnconfirmed: true } : {}),
        };
      }
      return { ...decideBuiltinInjectedTurnResult({ idleCompleted: true, outcome }), enqueued: true };
    },

    async stopTurn() {
      const stopped = await interruptCurrentResponse();
      return stopped ? { success: true } : { success: true, alreadyStopped: true };
    },

    async stopOwnedTurn(owner) {
      const canceled = await cancelQueuedTurnsByOwner(owner);
      const current = getBuiltinCurrentTurnIdentity();
      if (!current || current.owner.kind !== owner.kind || current.owner.id !== owner.id) {
        return { success: true, alreadyStopped: canceled === 0 };
      }
      const stopped = await interruptCurrentResponse();
      return stopped ? { success: true } : { success: true, alreadyStopped: true };
    },

    cancelQueuedMessage(queueId) {
      return cancelQueueItem(queueId);
    },

    forceQueuedMessage(queueId) {
      return forceExecuteQueueItem(queueId);
    },

    getQueueStatus,

    waitIdle(timeoutMs, pollMs) {
      return waitForSessionIdle(timeoutMs, pollMs);
    },

    async updateModel(model, opts) {
      await setSessionModel(model, opts);
      return { success: true };
    },

    async updatePermissionMode(mode) {
      setSessionPermissionMode(mode as PermissionMode);
      return { success: true };
    },

    async updateReasoningEffort(effort) {
      setSessionReasoningEffort(effort);
      return { success: true };
    },

    async updateOfficialToolIds(ids) {
      setSessionEnabledOfficialToolIds(ids);
      return { success: true };
    },

    async updateProxyConfig(proxySettings) {
      await setProxyConfig(proxySettings);
      return { success: true };
    },

    materializePendingDesktopSession(request) {
      return materializeBuiltinPendingDesktopSession({
        phase: request.phase,
        preparedSessionId: request.preparedSessionId,
        snapshotPatch: request.snapshotPatch,
        origin: request.origin,
      });
    },

    freezeCurrentSessionForImDetach(options) {
      return freezeCurrentSessionMetadataForImDetach(undefined, {
        allowMissingMetadata: options?.metadataBirthPending === true || options?.metadataIndexed === false,
      });
    },

    async respondPermission(requestId, decision) {
      return handlePermissionResponse(requestId, decision);
    },

    async respondAskUserQuestion(requestId, answers) {
      return handleAskUserQuestionResponse(requestId, answers);
    },

    rewindToUserMessage(userMessageId) {
      return rewindSession(userMessageId);
    },

    forkAtAssistantMessage(messageId) {
      return forkSession(messageId);
    },

    async updateProviderEnv(providerEnv) {
      await setSessionProviderEnv(providerEnv);
      return { success: true };
    },

    async updateMcpServers(servers) {
      setMcpServers(servers);
      return { success: true, servers: servers.map(s => s.id) };
    },

    async updateAgents(agents) {
      setAgents(agents as Record<string, AgentDefinition>);
      return { success: true };
    },

    async updateEnabledPluginIds(ids) {
      setSessionEnabledPluginIds(ids);
      return { success: true, enabledIds: ids };
    },

    async updateDesktopInteractionScenario(scenario) {
      await setInteractionScenario(scenario);
      return { success: true };
    },

    async resetForNewDesktopSession() {
      await resetSession();
      return { success: true, sessionId: getSessionId() };
    },

    async migrateBoundSurfaceSession(_workspacePath, options) {
      const freeze = await freezeCurrentSessionMetadataForImDetach(undefined, {
        allowMissingMetadata: options?.metadataBirthPending === true || options?.metadataIndexed === false,
      });
      if (!freeze.success) {
        return { success: false, error: freeze.error ?? 'Failed to freeze current Session before surface migration' };
      }
      await resetSession({ sessionId: options.targetSessionId });
      // resetSession() is the identity commit point. Metadata publication is
      // recoverable preparation; surfacing a failure after the commit would
      // make Rust roll Router/manager back to A while this Runtime remains B.
      try {
        await materializeCurrentSessionMetadataForPublishedReset();
      } catch (error) {
        console.warn('[session-engine] Surface migration post-commit metadata publication deferred:', error);
      }
      return { success: true, sessionId: options.targetSessionId };
    },
  };
}

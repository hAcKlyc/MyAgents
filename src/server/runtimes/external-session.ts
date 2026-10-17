import { deriveSessionWorkProgress } from '../../shared/sessionWorkProgress';
import { desktopContextOf } from '../../shared/agentMentions';
import { runtimeProviderAnalytics } from '../session-core/turn-analytics';
import type { AskUserQuestionAnswers } from '../../shared/types/askUserQuestion';
import type { RuntimeAgentWorkControl } from '../../shared/types/subagent-lifecycle';
import {
  asyncQuestionSetsInContent,
  sameAsyncQuestionReply,
  type AsyncQuestionSet,
  type AsyncQuestionReply,
} from '../../shared/asyncUserQuestions';
import { getExternalPendingMessageOperations } from './external-session/operation-queue';
// External Runtime Session Handler (v0.1.59)
//
// Manages the lifecycle of an external CLI runtime session (Claude Code, Codex).
// This module parallels agent-session.ts but is drastically simpler because
// the external CLI handles all SDK interaction, tool execution, and session persistence.
// We only need to: spawn process, relay events, and handle permission delegation.

import { createHash } from 'node:crypto';
import { isConcreteProviderRoute } from '../../shared/providerRoute';

import {
  broadcast as broadcastSse,
  broadcastLive,
  flushPendingLiveEvents,
} from '../sse';
import { participatesInLiveRestore } from '../../shared/liveRevision';
import { prepareToolPresentationEvent } from '../session-transcript/tool-transport';
import { toClientTranscriptOperation } from '../session-transcript/client';
import { killWithEscalation } from './utils/kill-with-escalation';
import { InactivityWatchdog } from '../utils/inactivity-watchdog';
import {
  buildDshSystemContext,
  buildSystemPromptAppend,
} from '../system-prompt';
import type { InteractionScenario } from '../system-prompt';
import {
  getChannelInteractionDisallowedTools,
  shouldDisallowAskUserQuestion,
  shouldUseNonBypassForNativeAskUserQuestion,
  supportsAskUserQuestionNativeCard,
} from '../host-interaction';
import type {
  AgentRuntime,
  ExternalRuntimeConfigPatch,
  ExternalRuntimeConfigSnapshot,
  RuntimeConfigApplyMode,
  RuntimeConfigCapabilities,
  RuntimeInitialTurn,
  RuntimeProcess,
  UnifiedEvent,
  ImagePayload,
  ResolvedImagePayload,
} from './types';
import {
  isRuntimeSteerUnavailableError,
  RuntimeConversationBranchError,
  StaleRuntimeSessionError,
} from './types';
import {
  awaitInFlightSaves,
  rebuildAttachmentRegistryFromBlocks,
  trackInFlightSave,
} from './tool-attachments';
import {
  messageAttachmentsFromImagePayloads,
  resolveImagePayloads,
} from './image-payload';
import { maybeSpill } from '../utils/large-value-store';
import {
  formatTextPreviewForLog,
  summarizeSensitiveValueForLog,
} from '../utils/log-summary';
import type {
  AskUserQuestion,
} from '../../shared/types/askUserQuestion';
import {
  normalizeAskUserQuestionInput,
  withQuestionTextAnswerKeys,
  questionAnswersAsText,
} from '../../shared/types/askUserQuestion';
import {
  getExternalRuntime,
  getCurrentRuntimeSource,
  getCurrentRuntimeType,
  isDshRuntime,
  isExternalRuntime,
} from './factory';
import {
  resolveCodexWorkspaceInstructions,
  resolveDshWorkspaceSupplement,
} from './workspace-instructions';
import {
  runtimeSupportsPrewarm,
  type RuntimeEnvPolicy,
  type RuntimeExtensionDiagnostics,
  type RuntimePermissionDiagnostics,
  type RuntimeSource,
  type RuntimeType,
} from '../../shared/types/runtime';
import { deriveSessionTitle } from '../../shared/sessionTitle';
import {
  runtimeSourceForBinding,
  runtimeTypeForBinding,
} from '../../shared/integrated-runtimes/identity';
import { createLiveUserMessageReplay } from '../../shared/chatMessageReplay';
import {
  withSessionCompletionTerminal,
  type SessionCompletionTerminal,
} from '../../shared/sessionCompletion';
import { isPendingSessionId } from '../../shared/constants';
import {
  resolveChatQueueResponseMode,
  type TurnOwner,
  type TurnTerminalObserver,
} from '../session-core/turn-queue';
import {
  shouldRecordAdmissionActivity,
  shouldRecordTerminalActivity,
  type SessionActivityTurnFacts,
} from '../session-core/session-activity-policy';
import {
  commitPreparedSessionForFirstUserTurn,
  commitCodexConversationRewind,
  abortDshForkProduct,
  beginDshForkMutation,
  beginDshInput,
  beginDshRewindMutation,
  commitDshForkProduct,
  commitDshRewindProduct,
  recordPreparedDshFork,
  recordPreparedDshRewind,
  requestDshForkAbort,
  resolvePendingConversationMutation,
  saveSessionMetadata,
  settleDshRootOperation,
  settleDshInput,
  stageDshForkProduct,
  publishForkSession,
  updateSessionMetadata,
  getSessionMetadata,
  getSessionData,
  loadSessionTranscript,
  activateSessionTranscript,
  getActiveSessionTranscript,
  prepareSessionTranscriptMutation,
} from '../SessionStore';
import { firePostTurnTitleHook } from '../turn-hooks';
import {
  createMaterializedSessionMetadata,
  type SessionMaterializationScenario,
} from '../utils/session-materialization';
import { isManagedCodexProviderReady } from '../utils/managed-codex-readiness';
import {
  findProjectAgentByWorkspacePath,
  getEffectiveOfficialToolIdsForSession,
  isCliToolRegistryEnabled,
  loadConfig as loadAdminConfig,
  resolveWorkspaceConfig,
} from '../utils/admin-config';
import type { AgentConfig } from '../../shared/types/agent';
import { resolveEffectiveProjectCapabilities } from '../project-capabilities';
import {
  assertProductSystemSkillCandidate,
  type EffectiveProjectCapabilitySnapshot,
} from '../../shared/projectCapabilities';
import {
  assertKnownProductSystemSkillRequirement,
  isProductSystemSkillRequirement,
  type SystemSkillAdmissionRequirement,
} from '../../shared/systemSkills';
import {
  createGlobalSkillInventorySnapshot,
  type GlobalSkillInventorySnapshot,
} from '../global-skill-inventory';
import { trySyncProjectUserConfigFiles } from '../utils/project-user-config-sync';
import type {
  MessageUsage,
  SessionMetadata,
  SessionMessage,
  TurnAnalyticsSource,
} from '../types/session';
import { createSessionMetadata } from '../types/session';
import {
  assertDshResolvedImagesMatch,
  replayDshProductInput,
} from '../session-engine/dsh-root-operation';
import type { SystemInitInfo } from '../../shared/types/system';
import {
  finalizeResidualSubagentCall,
  type SubagentLifecycle,
} from '../../shared/types/subagent-lifecycle';
import { trackServer } from '../analytics';
import {
  addUsageTotals,
  diffUsageTotals,
  getPrimaryModel,
  normalizeUsage,
  restoreRuntimeUsageTotals,
} from './usage-utils';
import {
  EXTERNAL_WATCHDOG_DEFAULT_TIMEOUT_MS,
  externalRuntimeWatchdogTimeoutMs,
  estimatedContextTokensFromMessages,
} from './external-watchdog-policy';
import { observedContextTokens } from '../utils/context-occupancy';
import { computeContextUsage } from '../../shared/contextUsage';
import {
  snapshotForForkedSession,
  snapshotForOwnedSession,
} from '../utils/session-snapshot';
import { lookupModelContextLength } from '../utils/model-capabilities';
import {
  filterRuntimeConfigPatchForSnapshot,
  getDefaultExternalConfigCapabilities,
  runtimeConfigPatchKeys as externalConfigPatchKeys,
  shouldApplySnapshotConfigUpdate,
  shouldDeferExternalConfigOperation,
} from '../session-core/runtime-config-policy';
import {
  NO_CHANNEL_DELIVERY,
  type TurnChannelDelivery,
} from '../session-core/channel-delivery';

export {
  filterRuntimeConfigPatchForSnapshot,
  getDefaultExternalConfigCapabilities,
  isExternalModelConfigNoop,
  mergeRuntimeConfigPatches as mergeExternalRuntimeConfigPatches,
  shouldDeferExternalConfigOperation,
} from '../session-core/runtime-config-policy';
import { elapsedMs, emitPerfTrace, nowMs } from '../utils/perf-trace';
import {
  mirrorIfChannelBound,
  resolvedImagesToMirrorImages,
  visibleDesktopMirrorText,
  type MirrorImage,
} from '../utils/im-mirror';
import { queryRuntimeModelsSingleFlight } from './runtime-model-singleflight';
import {
  applyDesiredExternalRuntimeConfigPatch,
  coerceExternalRuntimeModel,
  coerceExternalRuntimePermissionMode,
  coerceExternalRuntimeReasoningEffort,
  getExternalRuntimeDesiredModel,
  getExternalRuntimeDesiredPermissionMode,
  getExternalRuntimeDesiredReasoningEffort,
  getExternalRuntimeDisplayModel,
  getExternalRuntimeDisplayPermissionMode,
  getExternalRuntimeDisplayReasoningEffort,
  getExternalRuntimeLiveReportedModel,
  isCurrentExternalSessionSnapshotted,
  isExternalRuntimeConfigPatchNoopAgainstDesired,
  normalizeExternalRuntimeConfigPatch,
  resetExternalRuntimeConfigState,
  restoreExternalRuntimeConfigFromMetadata,
  setExternalRuntimeLiveReportedModel,
} from './external-session/runtime-config';
import {
  projectRuntimeDiagnosticsExtensionChange,
  projectRuntimeDiagnosticLogEntries,
  projectRuntimeExtensionDiagnosticLogEntry,
  type RuntimeDiagnosticLogEntry,
} from './external-session/runtime-diagnostics';
import {
  compileManagedCodexCommand,
  compileManagedCodexExtensionSnapshot,
} from './managed-codex/extensions/compiler';
import { compileProductExtensionSnapshot } from './product-extensions/compiler';
import type {
  ManagedCodexExtensionSnapshot,
  ManagedCodexExtensionUpdateResult,
} from './managed-codex/extensions/contracts';
import { attachProductHostTools } from './product-extensions/host-dispatcher';
import {
  getManagedCodexDesiredSnapshot,
  getManagedCodexExtensionStatus,
  getProductExtensionSessionEnabledPluginIds,
  getProductExtensionSessionMcpServers,
  getManagedCodexRuntimeDiagnostics,
  isManagedCodexExtensionRestartPending,
  markManagedCodexExtensionEffective,
  markManagedCodexExtensionFailed,
  releaseManagedCodexExtensionGeneration,
  resolveProductExtensionMcpSelection,
  resetManagedCodexExtensionState,
  setManagedCodexDesiredSnapshot,
  setManagedCodexExtensionRestartPending,
  setProductExtensionSessionEnabledPluginIds,
  setProductExtensionSessionMcpServers,
  setManagedCodexRuntimeDiagnostics,
} from './external-session/extensions';
import {
  canDrainExternalOperations,
  cancelExternalQueuedMessageByRequestId,
  cancelExternalQueuedMessageOperation,
  chainExternalSend,
  clearExternalQueueOperationsWithCancellation,
  cancelExternalQueuedMessageOperationsByOwner,
  consumeLeadingExternalConfigOps,
  createExternalMessageOperation,
  enqueueExternalConfigOperation,
  enqueueExistingExternalMessageOperation,
  enqueueExternalMessageOperation,
  getExternalOperationGeneration,
  getExternalOperationQueueLength,
  getExternalPendingUserMessageProjections,
  getExternalQueueStatusSnapshot,
  getExternalReservedMessageByRequestId,
  hasExternalSendInFlight,
  hasExternalQueuedMessageByOwner,
  hasExternalQueuedOperations,
  hasQueuedExternalConfigOperation,
  isCurrentExternalOperationGeneration,
  isExternalOperationDrainInFlight,
  isExternalQueueGenerationStaleError,
  markExternalUserMessageInTranscript,
  markExternalUserMessagePersisted,
  markExternalUserMessageRetracted,
  markExternalUserMessageSurfaced,
  moveExternalQueuedMessageToFront,
  nextExternalQueueId,
  nextExternalUserMessageId,
  releaseExternalDrainReservation,
  reserveExternalOperationForDrain,
  settleExternalMessageOperation,
  setExternalOperationDrainInFlight,
  shouldQueueExternalOperation,
  unshiftExternalOperation,
  withExternalMessageOperation,
} from './external-session/operation-queue';
import {
  awaitExternalLifecycleStarting,
  beginExternalLifecycleStart,
  bindExternalSessionContext as bindExternalLifecycleSessionContext,
  buildExternalSystemInitPayload,
  clearExternalActiveRuntimeProcess,
  clearExternalPrewarmingSession,
  clearExternalRuntimeSessionId,
  getCurrentExternalBoundSessionId,
  getExternalActivePair,
  getExternalActiveOfficialToolIds,
  getExternalActiveCapabilityRevision,
  getExternalActiveProcess,
  getExternalActiveRuntime,
  getExternalLifecycleAnalyticsOrigin,
  getExternalLifecycleAnalyticsSource,
  getExternalLifecycleScenario,
  getExternalLifecycleSessionId,
  getExternalLifecycleState,
  getExternalLifecycleWorkspacePath,
  getExternalRuntimeSessionId,
  getExternalSystemInitPayloadSnapshot,
  getExternalUserRequestedStop,
  getExternalLiveRevision,
  getExternalRuntimeGeneration,
  isExternalLifecycleRunning,
  isExternalLifecycleStarting,
  markExternalUserRequestedStop,
  nextExternalLiveRevision,
  resetExternalUserRequestedStop,
  resetExternalLifecycleState,
  getExternalAgentPlan,
  setExternalAgentPlan,
  setExternalActiveProcess,
  setExternalActiveRuntime,
  setExternalLifecycleAnalyticsOrigin,
  setExternalLifecycleAnalyticsSource,
  setExternalLifecycleRunning,
  setExternalLifecycleScenario,
  setExternalLifecycleState,
  setExternalPrewarmingSession,
  setExternalMcpEffectiveSnapshot,
  getExternalMcpEffectiveSnapshot,
  invalidateExternalMcpEffectiveSnapshot,
  setExternalRuntimeSessionId,
  setExternalSystemInitPayload,
  updateExternalLifecycleStartingSessionId,
} from './external-session/lifecycle';
export { getExternalMcpEffectiveSnapshot } from './external-session/lifecycle';
import type { McpRetryResult } from '../../shared/mcpFailure';
import {
  originAnalyticsFields,
  originFromTurnAttribution,
} from '../../shared/session-origin';
import type { SessionOrigin } from '../../shared/session-origin';
import type { OfficialToolId } from '../../shared/official-tools';
import {
  buildImCancelledPayload,
  buildImCompletePayload,
  buildImErrorPayload,
  formatImResumeFailure,
} from '../utils/im-terminal-payload';
import {
  beginExternalTurnPromotion,
  admitExternalRealtimeChannelDelivery,
  admitExternalTurnChannelDelivery,
  cancelExternalTurnPromotion,
  cancelExternalTurnPromotionByOwner,
  cancelExternalTurnPromotionByQueueId,
  clearExternalTurnBinding,
  clearExternalTurnStartTime,
  clearExternalTurnActivityFacts,
  captureExternalAssistantChannelDelivery,
  commitExternalAssistantChannelDelivery,
  discardExternalAssistantChannelDelivery,
  didExternalLastTurnSucceed,
  stageExternalAssistantChannelDelivery,
  finishExternalTurnPromotion,
  bindExternalTurn,
  getExternalTurnTerminalGeneration,
  getExternalCurrentTurnContextUsage,
  getExternalCurrentTurnEstimatedInputTokens,
  getExternalCurrentTurnUsage,
  getExternalTurnStartTime,
  getExternalTurnActivityFacts,
  getExternalRuntimeTurnAnchor,
  isExternalTurnCompleted,
  isExternalTurnFinalizationInFlight,
  isExternalTurnGenerationCurrent,
  isExternalTurnCurrent,
  isExternalTurnPromotionCurrent,
  isExternalTurnPromotionInFlight,
  markExternalSessionComplete,
  getExternalExecutionTurnId,
  markExternalTurnComplete,
  markExternalTurnStarted,
  notifyExternalTurnOutcome,
  notifyExternalTurnStopped,
  recordExternalSessionCompletionTerminal,
  resetExternalTurnAccumulators,
  resetExternalTurnLifecycleState,
  setExternalCurrentTurnContextUsage,
  setExternalCurrentTurnEstimatedInputTokens,
  setExternalCurrentTurnUsage,
  setExternalLastTurnSucceeded,
  setExternalTurnCompleted,
  setExternalTurnActivityFacts,
  setExternalRuntimeTurnAnchor,
  trackExternalTurnFinalization,
  updateExternalCurrentTurnUsageModel,
  waitForExternalTurnTerminalObserver,
  waitExternalTurnFinalization,
  type ExternalTurnPromotionToken,
  type ExternalUserChannelAdmission,
} from './external-session/turn-lifecycle';
export {
  clearExternalTurnBinding,
  getExternalCurrentTurnIdentity,
  getExternalExecutionTurnId,
  getExternalSessionCompletionTerminal,
  getExternalTurnTerminalGeneration,
  isExternalTurnCurrent,
  waitExternalTurnFinalization,
} from './external-session/turn-lifecycle';
import {
  appendExternalAssistantText,
  appendExternalSubagentTraceDelta as appendExternalSubagentTraceDeltaToContent,
  appendExternalPendingText,
  appendExternalPendingThinkingText,
  appendExternalToolResultDeltaToContent,
  appendExternalToolInputDelta,
  applyExternalProviderToolResult,
  applyExternalReplayedToolResultToContent,
  applyExternalSubagentLifecycle,
  mergeSubagentLifecycle,
  applyExternalSubagentAttachmentUpdate,
  applyExternalSubagentToolResult as applyExternalSubagentToolResultToContent,
  applyExternalToolAttachmentUpdate,
  applyExternalToolResultToContent,
  buildCurrentExternalAssistantSnapshotContent,
  captureExternalTurnContentSnapshot,
  completeExternalSubagentTrace as completeExternalSubagentTraceContent,
  finalizeExternalSubagentToolInput as finalizeExternalSubagentToolInputContent,
  finalizeExternalSubagentLifecyclesForTurn,
  finalizeExternalToolUseInput,
  flushExternalPendingTextBlock,
  flushExternalPendingThinkingBlock,
  flushExternalPendingToolInputsForTurn,
  finalizeExternalProviderToolsForTurn,
  getExternalAssistantText,
  getExternalChildToolParent,
  getExternalContentBlockCount,
  getExternalContentBlockText,
  getExternalPendingTextBuffer,
  getExternalPendingThinkingIndex,
  getExternalSubagentAttachmentParent,
  getExternalTurnContentSnapshotPersistedContent,
  getExternalTurnContentSnapshotText,
  getExternalTurnContentSnapshotToolCount,
  isExternalTurnContentSnapshotCurrent,
  isExternalPendingThinkingActive,
  replaceExternalToolUseInput,
  resetExternalContentState,
  resetExternalPendingThinking,
  startExternalSubagentToolUse,
  startExternalSubagentTraceTool,
  startExternalProviderToolUse,
  startExternalToolUseInput,
} from './external-session/content-blocks';
import {
  appendAndPersistExternalAssistantTurn,
  clearExternalSessionMessages,
  forEachExternalSessionMessage,
  getLastExternalAssistantTextFromTranscript,
  getExternalSessionMessageCount,
  getExternalSessionMessagesSnapshot,
  getExternalTranscriptSessionId,
  getExternalProductContent,
  getLastPersistedRuntimeUsageTotals,
  persistExternalUserMessageAppend,
  pushExternalSessionMessage,
  removeAndPersistExternalSessionMessage,
  resetExternalTranscriptState,
  setExternalSessionMessages,
  setLastPersistedRuntimeUsageTotals,
  retryUnadmittedDshTranscript,
} from './external-session/transcript-persistence';
import { TranscriptPresentation } from '../session-transcript/presentation';
import {
  toStoredTranscriptMessage,
  type TranscriptObject,
} from '../../shared/sessionTranscript';
import {
  addExternalTurnAttachmentHint,
  clearExternalInboxMetaOnRejection,
  clearExternalPermissionSuggestions,
  consumeExternalPermissionSuggestions,
  deleteExternalAskUserQuestion,
  deleteExternalInteractiveRequest,
  deliverExternalWatchError,
  finalizeExternalActiveRequest,
  finalizeExternalQueuedImRequest,
  fireExternalImCallback,
  getExternalActiveRequestId,
  getExternalImBridgeTurnContext,
  getExternalAskUserQuestion,
  getExternalInteractiveRequest,
  getExternalInteractiveRequestEntries,
  getExternalInteractiveRequestsSnapshot,
  getExternalPermissionSuggestions,
  getExternalTurnInboxMeta,
  hasExternalAskUserQuestion,
  hasExternalInteractiveRequests,
  resetExternalInteractiveState,
  resetExternalTurnAttachmentHints,
  setExternalActiveRequestId,
  setExternalAskUserQuestion,
  setExternalInteractiveRequest,
  setExternalPermissionSuggestions,
  setExternalTurnInboxMeta,
  appendExternalTurnInboxMeta,
  snapshotExternalTurnReplyState,
} from './external-session/interactive';
import type {
  ExternalConfigApplyResult,
  ExternalConfigSource,
  ExternalConfigUpdateResult,
  ExternalMetadataTurnPath,
  ExternalMessageOperation,
  ExternalPendingInteractiveRequest,
  ExternalQueuedMessageOperation,
  ExternalSendContext,
  ExternalSendResult,
  ExternalSessionState,
  ExternalTurnUsage,
  PendingExternalSessionBirth,
} from './external-session/types';
export type {
  ExternalAssistantSnapshotState,
  ExternalConfigApplyResult,
  ExternalConfigSource,
  ExternalConfigUpdateResult,
  ExternalMetadataTurnPath,
  ExternalMessageOperation,
  ExternalPendingInteractiveRequest,
  ExternalQueuedConfigOperation,
  ExternalQueuedMessageOperation,
  ExternalSendContext,
  ExternalSendResult,
  ExternalSessionState,
  ExternalTurnOperation,
  ExternalTurnUsage,
  PendingExternalSessionBirth,
  PersistContentBlock,
  PersistSubagentCall,
} from './external-session/types';

type ExternalTurnBindingInput = {
  queueId: string;
  owner?: TurnOwner;
  onTerminal?: TurnTerminalObserver;
};

export { buildExternalAssistantSnapshotContent } from './external-session/content-blocks';
export {
  classifyExternalTurnFailureCleanup,
  isSuccessfulExternalTurnCompletion,
} from './external-session/turn-lifecycle';

export function summarizeExternalRuntimeMessageForLog(value: unknown): string {
  const message = value instanceof Error ? value.message : String(value ?? '');
  return JSON.stringify(summarizeSensitiveValueForLog(message));
}

// ─── Module state ───
// #307: set true while stopExternalSession() is tearing down the process (user
// pressed Stop / config-change restart / session takeover). When the killed
// subprocess then emits its terminal session_complete (subtype='error' from the
// non-zero exit, or an error_during_execution result), the session_complete
// handler consults this flag to SUPPRESS the chat:agent-error / chat:message-error
// banner — an abort we initiated is not a real failure. Mirrors the builtin path's
// isAbortedTerminalReason()/isInterruptingResponse gate. terminal_reason alone is
// insufficient here: CC `-p` has no mid-turn interrupt, so Stop = SIGTERM kill,
// whose synthetic session_complete carries no terminal_reason. Consumed (reset to
// false) the first time the handler reads it, with a backstop reset at session start.
let watchdogTimer: ReturnType<typeof setInterval> | null = null; // Hung process detection (suspension-aware interval)

let externalTurnSeq = 0;
let currentTurnTraceId = '';
let currentTurnTraceSessionId = '';
let currentTurnAnalyticsSource: TurnAnalyticsSource | null = null;
let currentTurnAnalyticsOrigin: SessionOrigin | null = null;
let externalSessionMutationInFlight = false;
/** Queue item whose force-send owns the current intentional turn interruption. */
let externalForceTransferQueueId: string | null = null;
let queuedDshRootRecovery: Readonly<{
  sessionId: string;
  promise: Promise<void>;
}> | null = null;

function getBoundDshMetadata() {
  if (getCurrentRuntimeType() !== 'dsh') return null;
  const sessionId = getExternalLifecycleSessionId();
  return sessionId ? getSessionMetadata(sessionId) : null;
}

function hasPendingDshMutation(): boolean {
  return Boolean(getBoundDshMetadata()?.pendingDshMutation);
}

function getPendingDshRootOperation() {
  return getBoundDshMetadata()?.pendingDshRootOperation;
}

let pendingDshProductEvents = 0;
function hasPendingDshNativeWork(): boolean {
  if (getCurrentRuntimeType() !== 'dsh') return false;
  const active = getExternalActivePair();
  return (
    hasPendingDshMutation() ||
    Boolean(getPendingDshRootOperation()) ||
    pendingDshProductEvents > 0 ||
    (getBoundDshMetadata()?.pendingDshInputs?.length ?? 0) > 0 ||
    Boolean(active?.runtime.getActiveRootOperation?.(active.process))
  );
}
let currentTurnTraceRequestId: string | undefined;
let currentTurnTraceRuntime = '';
let currentTurnTraceStartMs = 0;
let firstDeltaTraceEmitted = false;
let firstThinkingDeltaTraceEmitted = false;
let firstTextDeltaTraceEmitted = false;
const activeToolTraceStarts = new Map<string, number>();
let activeExternalEnvPolicy: RuntimeEnvPolicy | undefined;
let pendingExternalProxyRestart = false;
let pendingExternalProxyRestartOriginalKey: string | null = null;
let pendingExternalOfficialToolsRestart = false;
let pendingExternalCapabilityRestart = false;
let externalProcessConfigInvalidationInFlight: Promise<void> | null = null;
let dshDesiredExtensionSnapshot: ManagedCodexExtensionSnapshot | null = null;
let dshExtensionStatus: RuntimeExtensionDiagnostics | null = null;
let dshPermissionStatus: RuntimePermissionDiagnostics | null = null;
let dshDesiredInteractionScenario: InteractionScenario | null = null;
function clearPendingExternalProcessConfigRestarts(): void {
  pendingExternalProxyRestart = false;
  pendingExternalProxyRestartOriginalKey = null;
  pendingExternalOfficialToolsRestart = false;
  pendingExternalCapabilityRestart = false;
  setManagedCodexExtensionRestartPending(false);
}

function pendingExternalProcessConfigRestartReasons(): string[] {
  return [
    ...(pendingExternalProxyRestart ? ['proxy'] : []),
    ...(pendingExternalOfficialToolsRestart ? ['official-tools'] : []),
    ...(pendingExternalCapabilityRestart ? ['capabilities'] : []),
    ...(isManagedCodexExtensionRestartPending()
      ? ['managed-codex-extensions']
      : []),
  ];
}

function invalidateExternalMcpProjection(): void {
  const snapshot = invalidateExternalMcpEffectiveSnapshot();
  if (snapshot) broadcast('chat:mcp-effective-snapshot', snapshot);
}

function applyPendingExternalProcessConfigInvalidation(
  preservePromotion?: ExternalTurnPromotionToken | null,
): Promise<void> {
  if (externalProcessConfigInvalidationInFlight) {
    return externalProcessConfigInvalidationInFlight;
  }

  const reasons = pendingExternalProcessConfigRestartReasons();
  if (reasons.length === 0) return Promise.resolve();
  const proxyOriginalKey = pendingExternalProxyRestartOriginalKey;

  const operation = (async () => {
    // Clear before stopping so the process-exit notification cannot re-enter
    // this boundary. The in-flight promise remains observable to every send;
    // if termination cannot be confirmed, restore the latch before rejecting.
    clearPendingExternalProcessConfigRestarts();
    const promoteManagedCodexScenario = (): void => {
      if (!reasons.includes('managed-codex-extensions')) return;
      const desired = getManagedCodexDesiredSnapshot();
      if (desired) setExternalLifecycleScenario(desired.scenario);
    };
    if (!hasExternalRuntimeProcess()) {
      invalidateExternalMcpProjection();
      promoteManagedCodexScenario();
      console.log(
        `[external-session] External runtime config invalidation already satisfied by process exit: ${reasons.join(',')}`,
      );
      return;
    }

    console.log(
      `[external-session] Applying external runtime config restart at idle boundary: ${reasons.join(',')}`,
    );
    try {
      const stopped = await stopExternalSession({
        reason: 'config-restart',
        preserveQueue: true,
        preservePromotion,
      });
      if (!stopped && hasExternalRuntimeProcess()) {
        throw new Error(
          `External runtime process did not stop for config change: ${reasons.join(',')}`,
        );
      }
      invalidateExternalMcpProjection();
      promoteManagedCodexScenario();
    } catch (error) {
      if (!hasExternalRuntimeProcess()) {
        invalidateExternalMcpProjection();
        promoteManagedCodexScenario();
        return;
      }
      if (reasons.includes('proxy')) {
        pendingExternalProxyRestart = true;
        pendingExternalProxyRestartOriginalKey ??= proxyOriginalKey;
      }
      if (reasons.includes('official-tools')) {
        pendingExternalOfficialToolsRestart = true;
      }
      if (reasons.includes('capabilities')) {
        pendingExternalCapabilityRestart = true;
      }
      if (reasons.includes('managed-codex-extensions')) {
        setManagedCodexExtensionRestartPending(true);
        markManagedCodexExtensionFailed(
          error instanceof Error ? error.message : String(error),
        );
      }
      throw error;
    }
  })();

  externalProcessConfigInvalidationInFlight = operation;
  void operation.then(
    () => {
      if (externalProcessConfigInvalidationInFlight === operation) {
        externalProcessConfigInvalidationInFlight = null;
      }
    },
    () => {
      if (externalProcessConfigInvalidationInFlight === operation) {
        externalProcessConfigInvalidationInFlight = null;
      }
    },
  );
  return operation;
}

function scheduleManagedCodexAdmissionReplacementPrewarm(): void {
  const sessionId = getExternalLifecycleSessionId();
  const workspacePath = getExternalLifecycleWorkspacePath();
  const scenario = getExternalLifecycleScenario();
  if (!isManagedCodexProductRuntime() || !sessionId || !workspacePath) return;
  const timer = setTimeout(() => {
    if (
      !isManagedCodexProductRuntime() ||
      getExternalLifecycleSessionId() !== sessionId ||
      getExternalLifecycleWorkspacePath() !== workspacePath ||
      isExternalSessionBusy() ||
      hasExternalRuntimeProcess()
    )
      return;
    void prewarmExternalSession({ sessionId, workspacePath, scenario }).catch(
      (error) => {
        console.warn(
          '[external-session] MCP admission replacement prewarm failed:',
          summarizeExternalRuntimeMessageForLog(error),
        );
      },
    );
  }, 0);
  timer.unref?.();
}

async function reconcileDshExtensionsAtTurnBoundary(): Promise<void> {
  const active = getExternalActivePair();
  if (
    !isDshProductRuntime() ||
    !active ||
    active.process.exited ||
    !active.runtime.reconcileDshExtensions
  )
    return;
  const status = await active.runtime.reconcileDshExtensions(active.process);
  if (
    status &&
    (status.state === 'applied' || status.state === 'unchanged') &&
    dshDesiredInteractionScenario
  ) {
    setExternalLifecycleScenario(dshDesiredInteractionScenario);
    dshDesiredInteractionScenario = null;
  }
}

function scheduleExternalQueueDrainAfterTurnBoundary(): void {
  if (isExternalTurnFinalizationInFlight()) {
    void waitExternalTurnFinalization(60_000).then((settled) => {
      if (settled) {
        scheduleExternalQueueDrainAfterTurnBoundary();
        return;
      }
      const message =
        'External turn finalization did not settle before queued admission';
      console.error(`[external-session] ${message}`);
      broadcast('chat:agent-error', { message });
      clearExternalQueueWithCancellation('failed', message);
    });
    return;
  }
  const dshReconciliation = isDshProductRuntime()
    ? (async () => {
        await reconcileDshExtensionsAtTurnBoundary();
        const active = getExternalActivePair();
        if (
          active &&
          !active.process.exited &&
          getPendingDshRootOperation() &&
          !active.runtime.getActiveRootOperation?.(active.process)
        )
          await resumePendingDshRootOperation(active.runtime, active.process);
        const sessionId = getExternalLifecycleSessionId();
        const workspacePath = getExternalLifecycleWorkspacePath();
        if (active && !active.process.exited && sessionId && workspacePath)
          await resumePendingDshInputs(active.runtime, active.process, {
            sessionId,
            workspacePath,
            scenario: getExternalLifecycleScenario(),
            channelDelivery: NO_CHANNEL_DELIVERY,
          });
      })()
    : null;
  if (
    !dshReconciliation &&
    pendingExternalProcessConfigRestartReasons().length === 0
  ) {
    setTimeout(() => drainExternalQueueAfterTurn(), 0);
    clearExternalTurnTrace();
    return;
  }

  const finalization = Promise.resolve(dshReconciliation)
    .catch((error) => {
      console.warn(
        '[external-session] DSH extension boundary reconciliation failed:',
        summarizeExternalRuntimeMessageForLog(error),
      );
      return null;
    })
    .then(() =>
      pendingExternalProcessConfigRestartReasons().length > 0
        ? applyPendingExternalProcessConfigInvalidation()
        : undefined,
    )
    .then(() => {
      scheduleManagedCodexAdmissionReplacementPrewarm();
      setTimeout(() => drainExternalQueueAfterTurn(), 0);
    })
    .catch((error) => {
      const message = error instanceof Error ? error.message : String(error);
      console.error(
        `[external-session] Deferred runtime config restart failed: ${message}`,
      );
      broadcast('chat:agent-error', { message });
      clearExternalQueueWithCancellation('failed', message);
    })
    .finally(() => {
      clearExternalTurnTrace();
    });
  trackExternalTurnFinalization(finalization);
}

function scheduleExternalQueueDrainAfterDirectAdmission(): void {
  if (!hasExternalQueuedOperations()) return;
  if (getExternalLifecycleState() === 'idle') scheduleExternalQueueDrainAfterTurnBoundary();
  else setTimeout(drainExternalQueueAfterTurn, 0);
}

interface PendingRealtimeSteeredUserMessage {
  queueId: string;
  sessionId: string;
  operation: ExternalMessageOperation;
  text: string;
  activityFacts: SessionActivityTurnFacts;
  channelDelivery: TurnChannelDelivery;
  userChannelProjection: ExternalUserChannelProjection;
  admission?: Promise<void>;
  steerAcknowledged: boolean;
  executionTurnId?: string;
}

const pendingRealtimeSteeredUserMessages: PendingRealtimeSteeredUserMessage[] =
  [];

function sessionMessageAttachmentsFromImages(
  sessionId: string | undefined,
  images: ImagePayload[] | undefined,
): SessionMessage['attachments'] | undefined {
  if (!sessionId || !images || images.length === 0) return undefined;
  try {
    const attachments = messageAttachmentsFromImagePayloads(
      sessionId,
      images,
    ).map((att) => ({
      id: att.id,
      name: att.name,
      mimeType: att.mimeType,
      path: att.relativePath,
    }));
    return attachments.length > 0 ? attachments : undefined;
  } catch (err) {
    console.error(
      '[external-session] failed to prepare user image attachments:',
      err,
    );
    return undefined;
  }
}

function createExternalUserMessage(
  text: string,
  images: ImagePayload[] | undefined,
  sessionId: string | undefined,
): SessionMessage {
  return {
    id: nextExternalUserMessageId(),
    role: 'user',
    content: text,
    timestamp: new Date().toISOString(),
    attachments: sessionMessageAttachmentsFromImages(sessionId, images),
  };
}

function surfaceExternalUserMessageAsReplay(
  operation: ExternalMessageOperation,
  sessionId: string,
): void {
  if (
    operation.userProjection.surfaceMode !== 'chat-replay' ||
    operation.userProjection.surfaced
  ) {
    return;
  }
  markExternalUserMessageSurfaced(operation);
  broadcast(
    'chat:message-replay',
    createLiveUserMessageReplay(sessionId, operation.userProjection.message),
  );
}

function notifyExternalMessageDispatchAccepted(
  operation: ExternalMessageOperation,
  sessionId: string,
  onDispatchAccepted: (() => void) | undefined,
): void {
  surfaceExternalUserMessageAsReplay(operation, sessionId);
  // Native dispatch is irreversible. Later runtime/persistence failures are
  // terminal outcomes, and cannot revoke this operation's admission receipt.
  operation.settleDispatchAcceptance({ queued: true });
  if (
    operation.userProjection.surfaceMode === 'queue-started' &&
    onDispatchAccepted
  ) {
    markExternalUserMessageSurfaced(operation);
  }
  onDispatchAccepted?.();
}

async function admitExternalAsyncQuestionReply(
  operation: ExternalMessageOperation,
  generation: number,
  onDispatchAccepted: (() => void) | undefined,
  persist: () => Promise<void>,
): Promise<void> {
  if (
    !isCurrentExternalOperationGeneration(generation) ||
    operation.context.sessionId !== getExternalLifecycleSessionId() ||
    operation.userProjection.retracted
  )
    return;
  pushExternalSessionMessage(operation.userProjection.message);
  markExternalUserMessageInTranscript(operation);
  notifyExternalMessageDispatchAccepted(
    operation,
    operation.context.sessionId,
    onDispatchAccepted,
  );
  try {
    await persist();
  } catch (error) {
    // Native admission already succeeded. Keep the accepted live projection;
    // the existing transcript append path can persist its tail at turn end.
    console.error(
      '[external-session] Failed to persist accepted async question answer:',
      error,
    );
  }
}

async function retractRejectedExternalUserMessage(
  operation: ExternalMessageOperation,
): Promise<void> {
  const projection = operation.userProjection;
  if (projection.persisted || projection.retracted) return;

  markExternalUserMessageRetracted(operation);
  if (projection.surfaced) {
    broadcast('chat:messages-retracted', {
      messageIds: [projection.message.id],
      retractedStreamingTail: false,
    });
  }
  if (!projection.inTranscript) return;

  try {
    await removeAndPersistExternalSessionMessage(
      operation.context.sessionId,
      projection.message.id,
      '[external-session] Failed to persist rejected user-message retraction',
    );
    projection.inTranscript = false;
  } catch (error) {
    console.error(
      '[external-session] failed to persist rejected user-message retraction:',
      error,
    );
  }
}

/**
 * Clear all queued desktop messages and broadcast queue:cancelled per item (so the renderer
 * removes the pills). MUST be called wherever the session is torn down or switched — a stale
 * queued item would otherwise (a) orphan its pill forever and (b) be drained into the NEW
 * session at its next turn end, injecting old text + old context (cross-session contamination).
 * Mirrors the builtin drainQueueWithCancellation (agent-session.ts).
 */
function finalizeRejectedExternalOperation(
  item: ExternalQueuedMessageOperation,
  terminal: 'cancelled' | 'failed',
  reason: string,
): void {
  const inboxMeta = item.context.inboxMeta;
  if (inboxMeta?.replyBack) {
    item.context.inboxMeta = undefined;
    void import('../inbox/reply-deliver').then(({ deliverInboxReply }) =>
      deliverInboxReply(item.context.sessionId, inboxMeta, {
        text: '', error: { code: terminal === 'cancelled' ? 'session_aborted' : 'input_not_consumed', message: reason },
      }),
    ).catch(error => console.error('[inbox] rejected input reply failed:', error));
  }
  if (item.context.requestId) {
    finalizeExternalQueuedImRequest(
      item.context.requestId,
      terminal,
      terminal === 'cancelled'
        ? buildImCancelledPayload()
        : buildImErrorPayload(reason),
    );
  }
  if (item.context.onTerminal) {
    const outcome =
      terminal === 'cancelled'
        ? {
            status: 'stopped' as const,
            text: '',
            assistantMessagePresent: false,
            error: reason,
          }
        : {
            status: 'error' as const,
            text: '',
            assistantMessagePresent: false,
            error: reason,
          };
    void Promise.resolve(item.context.onTerminal(outcome)).catch((error) => {
      console.error(
        '[external-session] queued turn terminal observer failed:',
        error,
      );
    });
  }
}

function clearExternalQueueWithCancellation(
  terminal: 'cancelled' | 'failed' = 'cancelled',
  reason = 'External queued turn was cancelled',
): void {
  for (const item of clearExternalQueueOperationsWithCancellation()) {
    broadcast('queue:cancelled', { queueId: item.queueId });
    finalizeRejectedExternalOperation(item, terminal, reason);
  }
  clearPendingRealtimeSteeredUserMessagesWithCancellation();
}

function clearPendingRealtimeSteeredUserMessagesWithCancellation(): void {
  while (pendingRealtimeSteeredUserMessages.length > 0) {
    const pending = pendingRealtimeSteeredUserMessages.shift();
    if (pending) {
      if (
        getSessionMetadata(pending.sessionId)?.pendingDshInputs?.some(
          (input) =>
            input.clientUserMessageId ===
            pending.operation.userProjection.message.id,
        )
      )
        continue;
      markExternalUserMessageRetracted(pending.operation);
      broadcast('queue:cancelled', { queueId: pending.queueId });
      finalizeRejectedExternalOperation(pending.operation, 'cancelled', 'Session stopped before input consumption was confirmed');
    }
  }
}

function registerPendingRealtimeSteeredUserMessage(
  entry: PendingRealtimeSteeredUserMessage,
): void {
  pendingRealtimeSteeredUserMessages.push(entry);
}

function forgetPendingRealtimeSteeredUserMessage(userMessageId: string): void {
  const index = pendingRealtimeSteeredUserMessages.findIndex(
    (entry) => entry.operation.userProjection.message.id === userMessageId,
  );
  if (index !== -1) pendingRealtimeSteeredUserMessages.splice(index, 1);
}

function acknowledgePendingRealtimeSteeredUserMessage(
  userMessageId: string,
): boolean {
  const entry = pendingRealtimeSteeredUserMessages.find(
    (pending) => pending.operation.userProjection.message.id === userMessageId,
  );
  if (!entry) return false;
  entry.steerAcknowledged = true;
  return true;
}

function takePendingRealtimeSteeredUserMessage(
  clientUserMessageId?: string,
): PendingRealtimeSteeredUserMessage | undefined {
  if (clientUserMessageId) {
    const index = pendingRealtimeSteeredUserMessages.findIndex(
      (entry) =>
        entry.operation.userProjection.message.id === clientUserMessageId,
    );
    if (index !== -1) {
      const [entry] = pendingRealtimeSteeredUserMessages.splice(index, 1);
      return entry;
    }
    return undefined;
  }
  return pendingRealtimeSteeredUserMessages.shift();
}

function surfaceRealtimeSteeredUserMessage(
  entry: PendingRealtimeSteeredUserMessage,
): Promise<boolean> {
  if (entry.operation.inputSource === 'inbox' && (isExternalTurnCompleted()
    || entry.executionTurnId !== getExternalExecutionTurnId())) {
    // A receipt arriving after its turn retired cannot lend that request to a successor.
    markExternalUserMessageRetracted(entry.operation);
    broadcast('queue:cancelled', { queueId: entry.queueId });
    finalizeRejectedExternalOperation(entry.operation, 'failed', 'Input consumption was confirmed after its turn retired');
    return Promise.resolve(false);
  }
  const userMsg = entry.operation.userProjection.message;
  setExternalTurnActivityFacts(entry.activityFacts);
  appendExternalTurnInboxMeta(entry.operation.context.inboxMeta);
  entry.operation.context.inboxMeta = undefined;
  // Native consumption transfers reply/projection authority from queue to turn,
  // even if the steer RPC is still waiting for its transport response.
  releaseExternalDrainReservation(entry.operation);
  settleExternalMessageOperation(entry.operation, { queued: true });
  const admissionActivityAt = shouldRecordAdmissionActivity(entry.activityFacts)
    ? new Date().toISOString()
    : undefined;
  pushExternalSessionMessage(userMsg);
  markExternalUserMessageInTranscript(entry.operation);
  const persistence = persistExternalUserMessageAppend(
    entry.sessionId,
    userMsg.id,
    '[external-session] Failed to persist accepted realtime steered user message',
    admissionActivityAt,
  )
    .then(async () => {
      const anchor = userMsg.runtimeOperationAnchor;
      if (anchor?.runtime === 'dsh') {
        const settled = await settleDshInput({
          sessionId: entry.sessionId,
          clientOperationId: anchor.clientOperationId,
          clientUserMessageId: userMsg.id,
          state: 'projected',
        });
        if (!settled.success) throw new Error(settled.error);
      }
      markExternalUserMessagePersisted(entry.operation);
      return true;
    })
    .catch((err) => {
      console.error(
        '[external-session] failed to persist accepted realtime steered user message:',
        err,
      );
      return false;
    });
  const userProjection = entry.userChannelProjection;
  admitExternalRealtimeChannelDelivery(
    entry.channelDelivery,
    userProjection.kind === 'deliver-session-bound-user'
      ? {
          kind: 'deliver-session-bound-user',
          waitForPersistence: persistence,
          deliverUser: () =>
            deliverExternalSessionBoundUser(entry.sessionId, userProjection),
        }
      : { kind: 'skip' },
  );
  if (userProjection.kind === 'skip') void persistence;
  markExternalUserMessageSurfaced(entry.operation);
  broadcast('queue:started', {
    queueId: entry.queueId,
    sessionId: entry.sessionId,
    midTurnBreak: true,
    userMessage: {
      id: userMsg.id,
      role: userMsg.role,
      content: entry.text,
      timestamp: userMsg.timestamp,
      attachments: userMsg.attachments,
      asyncQuestionReply: userMsg.asyncQuestionReply,
    },
  });
  return persistence;
}

function surfaceAcceptedRealtimeSteeredUserMessage(
  clientUserMessageId?: string,
): Promise<boolean> | null {
  const entry = takePendingRealtimeSteeredUserMessage(clientUserMessageId);
  if (!entry) return null;
  return surfaceRealtimeSteeredUserMessage(entry);
}

function finalizeUnconfirmedRealtimeSteeredUserMessage(
  entry: PendingRealtimeSteeredUserMessage,
): Promise<boolean> {
  if (entry.operation.context.asyncQuestionReply || entry.operation.inputSource === 'inbox') {
    // A steer RPC ack says transport succeeded, not that this answer was consumed.
    markExternalUserMessageRetracted(entry.operation);
    broadcast('queue:cancelled', { queueId: entry.queueId });
    finalizeRejectedExternalOperation(entry.operation, 'failed', 'Runtime did not confirm input consumption');
    broadcast('chat:agent-error', {
      message: entry.operation.inputSource === 'inbox'
        ? 'The runtime did not confirm consumption of the Inbox message.'
        : 'The runtime did not confirm the answer. Please try again.',
    });
    return Promise.resolve(false);
  } else {
    // Preserve the existing compatibility fallback for ordinary messages.
    return surfaceRealtimeSteeredUserMessage(entry);
  }
}

function surfaceAcknowledgedPendingRealtimeSteeredUserMessages(): void {
  for (let index = 0; index < pendingRealtimeSteeredUserMessages.length; ) {
    const entry = pendingRealtimeSteeredUserMessages[index];
    if (!entry.steerAcknowledged) {
      index += 1;
      continue;
    }
    pendingRealtimeSteeredUserMessages.splice(index, 1);
    void finalizeUnconfirmedRealtimeSteeredUserMessage(entry);
  }
}

function captureExternalRuntimeConfigSnapshot(
  model: string | undefined,
  permissionMode: string | undefined,
  context: ExternalSendContext,
): ExternalRuntimeConfigSnapshot {
  const runtime = getCurrentRuntimeType();
  const providerRoute = runtime === 'dsh'
    ? context.providerRoute ?? resolveWorkspaceConfig(
        context.workspacePath, getExternalSessionMetadata(context.sessionId), { includeMcp: false },
      ).providerRoute
    : undefined;
  return {
    ...(isConcreteProviderRoute(providerRoute)
      ? { providerRoute: { ...providerRoute } }
      : {}),
    model: coerceExternalRuntimeModel(
      model ?? context.model ?? getExternalRuntimeDesiredModel(),
      runtime,
      'message-capture',
      context.sessionId,
    ),
    permissionMode: coerceExternalRuntimePermissionMode(
      permissionMode ??
        context.permissionMode ??
        getExternalRuntimeDesiredPermissionMode(),
      runtime,
      'message-capture',
      context.sessionId,
    ),
    reasoningEffort:
      coerceExternalRuntimeReasoningEffort(
        resolveTurnReasoningEffort(context),
        runtime,
        'message-capture',
        context.sessionId,
      ) ?? '',
  };
}

function applySnapshotToExternalSendContext(
  context: ExternalSendContext,
  snapshot: ExternalRuntimeConfigSnapshot,
): ExternalSendContext {
  return {
    ...context,
    providerRoute: snapshot.providerRoute,
    model: snapshot.model,
    permissionMode: snapshot.permissionMode,
    reasoningEffort:
      snapshot.reasoningEffort === '' ? 'default' : snapshot.reasoningEffort,
  };
}
// Pre-warm can create a runtime thread before MyAgents has a durable
// sessions.json entry. Keep that narrow "birth" state explicit so the first
// real user turn may materialize metadata, while missing metadata for ordinary
// resume/delete races still fails closed.
let pendingExternalSessionBirth: PendingExternalSessionBirth | null = null;
function setExternalSessionState(state: ExternalSessionState): void {
  setExternalLifecycleState(state);
  broadcast('chat:status', { sessionState: state });
}

function bindExternalSessionContext(
  input: Parameters<typeof bindExternalLifecycleSessionContext>[0],
): void {
  if (getExternalLifecycleSessionId() !== input.sessionId) {
    flushPendingLiveEvents();
  }
  bindExternalLifecycleSessionContext(input);
}

let transcriptPresentation: TranscriptPresentation | undefined;

function getTranscriptPresentation(): TranscriptPresentation | undefined {
  const content = getExternalProductContent();
  if (!content) return undefined;
  if (transcriptPresentation?.content !== content) {
    transcriptPresentation = new TranscriptPresentation(
      content,
      (operation) => {
        const projected = toClientTranscriptOperation(operation);
        if (projected)
          broadcast('chat:transcript-operation', {
            sessionId: content.writer.status.sessionId,
            generation: content.writer.status.generation,
            instanceId: content.writer.status.instanceId,
            operation: projected,
          });
      },
      (target) => {
        const sessionId = content.writer.status.sessionId;
        // Eligibility belongs to the channel owner at this block's completion.
        // Resolve its text only when the terminal owner releases delivery, so
        // complete-frame corrections/retractions cannot send the stale partial.
        stageExternalAssistantChannelDelivery(async () => {
          const text = content.readBlock(target)?.text;
          if (typeof text === 'string' && text)
            await mirrorIfChannelBound({ sessionId, role: 'assistant', text });
        });
      },
    );
  }
  return transcriptPresentation;
}

function broadcast(event: string, data: unknown): void {
  // Results are recorded from the full native content before asynchronous spill;
  // the SSE preview must never replace that canonical value.
  if (!/^chat:(?:subagent-)?tool-result-(?:start|complete)$/.test(event)) {
    getTranscriptPresentation()?.record(event, data);
  }
  if (
    getExternalProductContent() &&
    /^chat:(?:(?:subagent-)?tool-|server-tool-|content-block-stop)/.test(
      event,
    ) &&
    data &&
    typeof data === 'object'
  ) {
    publishExternalToolPresentation(event, data as Record<string, unknown>);
  } else publishExternalUiEvent(event, data);
}

function publishExternalUiEvent(event: string, data: unknown): void {
  const payloadSessionId =
    data &&
    typeof data === 'object' &&
    typeof (data as { sessionId?: unknown }).sessionId === 'string'
      ? (data as { sessionId: string }).sessionId
      : '';
  const sessionId = payloadSessionId || getExternalLifecycleSessionId();
  if (sessionId && participatesInLiveRestore(event, data)) {
    broadcastLive(event, data, {
      sessionId,
      nextRevision: nextExternalLiveRevision,
    });
    return;
  }
  broadcastSse(event, data);
}

function publishExternalToolPresentation(
  event: string,
  data: Record<string, unknown>,
): void {
  const product = getExternalProductContent();
  const session = getExternalLifecycleSessionId();
  const events = prepareToolPresentationEvent(event, data, session);
  const deliver = (items: typeof events.immediate) => {
    if (
      product &&
      getActiveSessionTranscript(session)?.writer !== product.writer
    )
      return;
    for (const item of items) publishExternalUiEvent(item.event, item.data);
  };
  deliver(events.immediate);
  void events.deferred?.then(deliver);
}

export function getExternalExecutionStartedAt(): string | undefined {
  return getExternalProductContent()?.executionStartedAt;
}

export function publishExternalTranscriptSaveStatus(
  status: import('../../shared/sessionTranscript').TranscriptSaveStatus,
): void {
  const active = getExternalProductContent();
  if (active?.writer.status.instanceId === status.instanceId)
    broadcast('chat:transcript-save-status', status);
}

function emitRuntimeDiagnosticLogEntry(entry: RuntimeDiagnosticLogEntry): void {
  broadcast('chat:log', {
    source: 'bun',
    level: entry.level,
    message: entry.message,
    timestamp: new Date().toISOString(),
    runtime: getCurrentRuntimeType(),
  });
}

function broadcastManagedCodexExtensionDiagnostics(
  emitExtensionLog = false,
): void {
  if (!isManagedCodexProductRuntime()) return;
  const runtimeDiagnostics = getManagedCodexRuntimeDiagnostics();
  if (!runtimeDiagnostics) return;
  const diagnostics = projectRuntimeDiagnosticsExtensionChange(
    runtimeDiagnostics,
    getManagedCodexExtensionStatus(),
  );
  if (!diagnostics) return;
  if (emitExtensionLog) {
    const entry = projectRuntimeExtensionDiagnosticLogEntry(
      diagnostics.extensions,
    );
    if (entry) emitRuntimeDiagnosticLogEntry(entry);
  }
  setManagedCodexRuntimeDiagnostics(diagnostics);
  broadcast('chat:runtime-diagnostics', diagnostics);
}

type ExternalActivePair = NonNullable<ReturnType<typeof getExternalActivePair>>;
type SteerCapableActivePair = {
  runtime: ExternalActivePair['runtime'] & {
    canSteerMessage: NonNullable<
      ExternalActivePair['runtime']['canSteerMessage']
    >;
    steerMessage: NonNullable<ExternalActivePair['runtime']['steerMessage']>;
  };
  process: ExternalActivePair['process'];
};

function getExternalActiveSteerPair(): SteerCapableActivePair | null {
  const active = getExternalActivePair();
  if (
    !active ||
    active.process.exited ||
    !active.runtime.steerMessage ||
    !active.runtime.canSteerMessage?.(active.process)
  )
    return null;
  if (getExternalLifecycleState() !== 'running') return null;
  if (isExternalTurnCompleted() || getExternalTurnStartTime() === 0)
    return null;
  if (active.runtime.type === 'dsh') {
    const root =
      active.runtime.getActiveRootOperation?.(active.process) ?? null;
    const pending = getPendingDshRootOperation();
    if (root?.origin === 'collaboration' && root.realtimeSteerEligible)
      return active as SteerCapableActivePair;
    if (
      !root?.realtimeSteerEligible ||
      !pending ||
      pending.clientOperationId !== root.clientOperationId ||
      pending.clientUserMessageId !== root.clientUserMessageId ||
      pending.sourceRuntimeSessionId !== getExternalRuntimeSessionId()
    )
      return null;
  }
  return active as SteerCapableActivePair;
}

/** Reset all module-level state for a clean session transition.
 *  Prevents cross-session contamination when Sidecar is reused (Handover scenario 4). */
function resetModuleState(): void {
  resetExternalLifecycleState();
  resetExternalTurnLifecycleState();
  externalForceTransferQueueId = null;
  queuedDshRootRecovery = null;
  if (watchdogTimer) {
    clearInterval(watchdogTimer);
    watchdogTimer = null;
  }
  currentWatchdogTimeoutMs = EXTERNAL_WATCHDOG_DEFAULT_TIMEOUT_MS;
  externalWatchdog.setTimeoutMs(EXTERNAL_WATCHDOG_DEFAULT_TIMEOUT_MS);
  resetExternalRuntimeConfigState();
  resetExternalTranscriptState();
  resetExternalContentState();
  pendingExternalToolInputTransports.clear();
  activeExternalEnvPolicy = undefined;
  clearPendingExternalProcessConfigRestarts();
  resetManagedCodexExtensionState();
  dshDesiredExtensionSnapshot = null;
  dshExtensionStatus = null;
  dshPermissionStatus = null;
  dshDesiredInteractionScenario = null;
  currentTurnAnalyticsSource = null;
  currentTurnAnalyticsOrigin = null;
  clearExternalPermissionSuggestions();
  drainPendingInteractiveRequestsAsExpired('reset');
  resetExternalInteractiveState();
  pendingExternalSessionBirth = null;
  // Issue #289-followup — a queued desktop message MUST NOT survive a session switch/reset:
  // it would otherwise drain into the new session with the old session's text + context.
  clearExternalQueueWithCancellation();
}

type CommitCodexConversationRewind = typeof commitCodexConversationRewind;
let commitCodexConversationRewindForTests: CommitCodexConversationRewind | null =
  null;

export function __resetExternalSessionForTests(): void {
  if (process.env.NODE_ENV !== 'test' && process.env.VITEST !== 'true') {
    throw new Error(
      '__resetExternalSessionForTests is only available in tests',
    );
  }
  resetModuleState();
  externalSessionMutationInFlight = false;
  commitCodexConversationRewindForTests = null;
}

export function __isExternalWatchdogArmedForTests(): boolean {
  if (process.env.NODE_ENV !== 'test' && process.env.VITEST !== 'true') {
    throw new Error(
      '__isExternalWatchdogArmedForTests is only available in tests',
    );
  }
  return watchdogTimer !== null;
}

export function __setCodexConversationRewindCommitForTests(
  implementation: CommitCodexConversationRewind,
): void {
  if (process.env.NODE_ENV !== 'test' && process.env.VITEST !== 'true') {
    throw new Error(
      '__setCodexConversationRewindCommitForTests is only available in tests',
    );
  }
  commitCodexConversationRewindForTests = implementation;
}

/**
 * PRD #131 (Codex review #4) — drain pending interactive requests by
 * broadcasting `*:expired` so the frontend modal clears before we wipe the
 * map. Mirrors the builtin handlers' lifecycle (handleAskUserQuestion's
 * timer/onAbort paths in agent-session.ts). Without this, an external
 * runtime stop / crash / watchdog kill leaves the AskUserQuestion card
 * visible; the user's late submit then routes to the builtin handler as
 * "Unknown request".
 *
 * `reason` is included in the SSE payload so the frontend (and a future
 * automated test) can distinguish stop-driven vs error-driven expiry.
 * Currently the frontend just clears the modal regardless, but keeping
 * the channel typed lets us add user-visible messaging later without a
 * second round-trip.
 */
function broadcastExternalInteractiveExpired(
  requestId: string,
  entry: ExternalPendingInteractiveRequest | undefined,
  reason: 'stop' | 'error' | 'reset' | 'resolved',
  status?: 'applied' | 'already_settled' | 'expired' | 'cancelled',
): void {
  if (!entry) return;
  const sessionId =
    entry.data.sessionId || getCurrentBoundSessionId() || undefined;
  if (entry.type === 'ask-user-question:request') {
    try {
      broadcast('ask-user-question:expired', {
        requestId,
        ...(sessionId ? { sessionId } : {}),
        reason,
      });
    } catch (e) {
      console.warn(
        `[external-session] broadcast ask-user-question:expired for ${requestId} failed:`,
        e,
      );
    }
    if (supportsAskUserQuestionNativeCard(getExternalLifecycleScenario())) {
      fireExternalImCallback(
        'ask-user-question-expired',
        JSON.stringify({ requestId, reason }),
      );
    }
    return;
  }
  if (entry.type === 'permission:request') {
    try {
      broadcast('permission:expired', {
        requestId,
        ...(sessionId ? { sessionId } : {}),
        reason,
        status: status ?? (reason === 'resolved' ? 'applied' : 'cancelled'),
      });
    } catch (e) {
      console.warn(
        `[external-session] broadcast permission:expired for ${requestId} failed:`,
        e,
      );
    }
    return;
  }
  if (entry.type === 'exit-plan-mode:request') {
    try {
      broadcast('exit-plan-mode:expired', {
        requestId,
        ...(sessionId ? { sessionId } : {}),
        reason,
      });
    } catch (e) {
      console.warn(
        `[external-session] broadcast exit-plan-mode:expired for ${requestId} failed:`,
        e,
      );
    }
  }
}

function drainPendingInteractiveRequestsAsExpired(
  reason: 'stop' | 'error' | 'reset',
): void {
  // External runtimes may hold structured questions, permissions, or plan
  // approval requests. Filtering by entry.type keeps expiry on the matching
  // product channel while a stopped runtime drains every pending interaction.
  for (const [requestId, entry] of getExternalInteractiveRequestEntries()) {
    deleteExternalAskUserQuestion(requestId);
    deleteExternalInteractiveRequest(requestId);
    consumeExternalPermissionSuggestions(requestId);
    broadcastExternalInteractiveExpired(requestId, entry, reason);
  }
}

// ─── Sub-agent (Codex collab-agent) tool routing (PRD 0.2.27) ───
// Mirrors the builtin SDK's chat:subagent-* path. A tool stamped with
// event.subAgent nests under its parent spawn card instead of the flat
// transcript. Reuses the existing subagent SSE events + frontend nesting +
// TaskTool render — no new SSE events, no new components.

/**
 * Nest a sub-agent tool under its parent spawn card. The routing is LATCHED here:
 * childToolToParent is set on start, and all later input/stop/result events route
 * purely off that map — so a tool can never flat-then-nest flip mid-stream.
 */
function handleSubagentToolUseStart(
  parentToolUseId: string,
  event: Extract<UnifiedEvent, { kind: 'tool_use_start' }>,
): void {
  if (!getExternalProductContent())
  startExternalSubagentToolUse({
    parentToolUseId,
    toolUseId: event.toolUseId,
    toolName: event.toolName,
    toolInput: event.input,
  });
  broadcast('chat:subagent-tool-use', {
    parentToolUseId,
    tool: {
      id: event.toolUseId,
      name: event.toolName,
      input: event.input ?? {},
      // streamIndex is informational for nested calls; the frontend keys by id.
      streamIndex: 0,
    },
  });
  recordRuntimeActivity();
}

function finalizeSubagentToolInput(
  parentToolUseId: string,
  toolUseId: string,
): void {
  finalizeExternalSubagentToolInputContent(parentToolUseId, toolUseId);
}

function applySubagentToolResult(
  parentToolUseId: string,
  event: Extract<UnifiedEvent, { kind: 'tool_result' }>,
): void {
  applyExternalSubagentToolResultToContent({
    parentToolUseId,
    toolUseId: event.toolUseId,
    content: event.content,
    isError: event.isError,
    metadata: event.metadata,
    attachments: event.attachments,
  });
  // External runtimes deliver tool results as a single event (no streaming),
  // so go straight to *-complete (the frontend's -start/-complete both update
  // the same call; -complete also clears the loading spinner).
  broadcast('chat:subagent-tool-result-complete', {
    parentToolUseId,
    toolUseId: event.toolUseId,
    content: event.content,
    isError: event.isError ?? false,
    metadata: event.metadata,
    attachments: event.attachments,
  });
  recordRuntimeActivity();
}

function broadcastExternalSubagentLifecycle(
  parentToolUseId: string,
  lifecycle: SubagentLifecycle,
): void {
  broadcast('chat:subagent-status', { parentToolUseId, lifecycle });
  recordRuntimeActivity();
}

function finalizeExternalSubagentLifecycleProjection(
  status: 'failed' | 'interrupted',
): void {
  const observedAt = Date.now();
  for (const update of finalizeExternalSubagentLifecyclesForTurn({
    status,
    observedAt,
  })) {
    broadcastExternalSubagentLifecycle(
      update.parentToolUseId,
      update.lifecycle,
    );
  }
  const product = getExternalProductContent();
  if (!product?.currentTurn) return;
  for (const message of product.writer.projection.messages.values()) {
    if (
      message.turnId !== product.currentTurn.id ||
      !Array.isArray(message.content)
    )
      continue;
    for (const block of message.content) {
      const tool = block.tool as TranscriptObject | undefined;
      if (!tool?.subagentLifecycle) continue;
      const lifecycle = tool.subagentLifecycle as unknown as SubagentLifecycle;
      if (lifecycle.status === 'running' && typeof tool.id === 'string')
        broadcastExternalSubagentLifecycle(
          tool.id,
          mergeSubagentLifecycle(lifecycle, status, observedAt),
        );
      if (!Array.isArray(tool.subagentCalls)) continue;
      for (const value of tool.subagentCalls) {
        if (!value || typeof value !== 'object' || Array.isArray(value))
          continue;
        if (typeof value.id !== 'string' || value.isLoading !== true) continue;
        const target = product.tool(value.id);
        if (target)
          product.updateTool(
            target,
            finalizeResidualSubagentCall(
              {
                isLoading: true,
                ...(typeof value.result === 'string'
                  ? { result: value.result }
                  : {}),
              },
              status,
            ),
          );
      }
    }
  }
}

type SubagentTraceName = 'AgentMessage' | 'Thinking';

function subagentTraceToolUseId(
  parentToolUseId: string,
  traceId: string,
  name: SubagentTraceName,
): string {
  return `${name}::${traceId}::${parentToolUseId}`;
}

function ensureSubagentTraceCall(
  parentToolUseId: string,
  toolUseId: string,
  name: SubagentTraceName,
): void {
  const product = getExternalProductContent();
  if (
    product
      ? Boolean(product.tool(toolUseId))
      : !startExternalSubagentTraceTool({
      parentToolUseId,
      toolUseId,
      toolName: name,
    })
  )
    return;
  broadcast('chat:subagent-tool-use', {
    parentToolUseId,
    tool: {
      id: toolUseId,
      name,
      input: {},
      streamIndex: 0,
    },
  });
  recordRuntimeActivity();
}

function appendSubagentTraceDelta(
  event: Extract<UnifiedEvent, { kind: 'text_delta' | 'thinking_delta' }>,
  name: SubagentTraceName,
): boolean {
  if (!event.subAgent || !event.traceId) return false;
  const parentToolUseId = event.subAgent.parentToolUseId;
  const toolUseId = subagentTraceToolUseId(
    parentToolUseId,
    event.traceId,
    name,
  );
  ensureSubagentTraceCall(parentToolUseId, toolUseId, name);
  if (!getExternalProductContent())
  appendExternalSubagentTraceDeltaToContent({
    parentToolUseId,
    toolUseId,
    delta: event.text,
  });

  broadcast('chat:subagent-tool-result-delta', {
    parentToolUseId,
    toolUseId,
    delta: event.text,
  });
  recordRuntimeActivity();
  return true;
}

function startSubagentTrace(
  event: Extract<UnifiedEvent, { kind: 'thinking_start' }>,
  name: SubagentTraceName,
): boolean {
  if (!event.subAgent || !event.traceId) return false;
  const parentToolUseId = event.subAgent.parentToolUseId;
  const toolUseId = subagentTraceToolUseId(
    parentToolUseId,
    event.traceId,
    name,
  );
  ensureSubagentTraceCall(parentToolUseId, toolUseId, name);
  return true;
}

function completeSubagentTrace(
  event: Extract<UnifiedEvent, { kind: 'text_stop' | 'thinking_stop' }>,
  name: SubagentTraceName,
): boolean {
  if (!event.subAgent || !event.traceId) return false;
  const parentToolUseId = event.subAgent.parentToolUseId;
  const toolUseId = subagentTraceToolUseId(
    parentToolUseId,
    event.traceId,
    name,
  );
  const product = getExternalProductContent();
  const target = product?.tool(toolUseId);
  const tool = target ? product!.readTool(target) : undefined;
  const completed = product
    ? tool
      ? {
          latchedParentToolUseId: parentToolUseId,
          content: typeof tool.result === 'string' ? tool.result : '',
        }
      : null
    : completeExternalSubagentTraceContent({ parentToolUseId, toolUseId });
  if (!completed) return true; // scoped stop with no emitted content; swallow it

  if (target) {
    product!.updateTool(target, { isLoading: false }, true);
  }

  if (product) {
    publishExternalToolPresentation('chat:subagent-tool-result-complete', {
      parentToolUseId,
      toolUseId,
      content: completed.content,
    });
    return true;
  }
  applySubagentToolResult(completed.latchedParentToolUseId, {
    kind: 'tool_result',
    toolUseId,
    content: completed.content,
  });
  return true;
}

type ExternalUserChannelProjection =
  | { kind: 'skip' }
  | {
      kind: 'deliver-session-bound-user';
      text: string;
      images?: MirrorImage[];
    };

function projectExternalUserChannelAdmission(
  channelDelivery: TurnChannelDelivery,
  content: string,
  resolvedImages: ResolvedImagePayload[] | undefined,
): ExternalUserChannelProjection {
  if (channelDelivery.user !== 'session-binding') return { kind: 'skip' };
  const text = visibleDesktopMirrorText(content);
  const images = resolvedImagesToMirrorImages(resolvedImages);
  return text || images
    ? { kind: 'deliver-session-bound-user', text, images }
    : { kind: 'skip' };
}

function deliverExternalSessionBoundUser(
  sessionId: string,
  projection: Extract<
    ExternalUserChannelProjection,
    { kind: 'deliver-session-bound-user' }
  >,
): Promise<void> {
  return mirrorIfChannelBound({
    sessionId,
    role: 'user',
    text: projection.text,
    images: projection.images,
  });
}

type ExternalTextMirrorDisposition =
  | 'mirror-completed-block'
  | 'skip-incomplete-block';

/** Flush accumulated text into a text content block. Only completed blocks
 * enter the turn owner's ordered mirror delivery tail. */
function flushPendingText(
  disposition: ExternalTextMirrorDisposition,
  asyncQuestions?: AsyncQuestionSet,
): void {
  const presentation = getTranscriptPresentation();
  if (presentation) {
    presentation.closeText(
      asyncQuestions
        ? { asyncQuestions: asyncQuestions as unknown as TranscriptObject }
        : {},
    );
    return;
  }
  const completedText = getExternalPendingTextBuffer();
  if (!flushExternalPendingTextBlock(asyncQuestions)) return;
  if (disposition === 'skip-incomplete-block' || !completedText) return;
  const sessionId = getExternalLifecycleSessionId();
  stageExternalAssistantChannelDelivery(() =>
    mirrorIfChannelBound({
      sessionId,
      role: 'assistant',
      text: completedText,
    }),
  );
}

export function shouldCreateMissingExternalMetadataForRealUserTurn(
  turnPath: ExternalMetadataTurnPath,
  hasPendingBirth: boolean,
): boolean {
  void turnPath;
  return hasPendingBirth;
}

export function shouldTrackPendingExternalSessionBirth(params: {
  hasInitialMessage: boolean;
  hasResumeSessionId: boolean;
  hasMetadata: boolean;
}): boolean {
  return (
    !params.hasInitialMessage &&
    !params.hasResumeSessionId &&
    !params.hasMetadata
  );
}

function materializationScenarioFromInteraction(
  scenario: InteractionScenario,
): SessionMaterializationScenario {
  return scenario.type;
}

function pendingBirthForSession(
  sessionId: string,
): PendingExternalSessionBirth | null {
  return pendingExternalSessionBirth?.sessionId === sessionId
    ? pendingExternalSessionBirth
    : null;
}

/** The pre-warm owner has already confirmed a missing product birth. Ordinary
 * resume and generic allow-missing requests still require their cold identity. */
function getExternalSessionMetadata(sessionId: string): SessionMetadata | null {
  const active = getActiveSessionTranscript(sessionId);
  if (active) return active.metadata;
  return pendingBirthForSession(sessionId)
    ? null
    : getSessionMetadata(sessionId);
}

function clearPendingExternalSessionBirth(sessionId: string): void {
  if (pendingExternalSessionBirth?.sessionId === sessionId) {
    pendingExternalSessionBirth = null;
  }
}

async function persistExternalUserMessageAdmission(params: {
  sessionId: string;
  workspacePath: string;
  messageText: string;
  origin: string;
  scenario: InteractionScenario;
  turnPath: ExternalMetadataTurnPath;
  metadataBirthPending?: boolean;
  birthOrigin?: SessionOrigin;
  operation: ExternalMessageOperation;
  failureContext: string;
  lastActiveAt?: string;
  channelDelivery: TurnChannelDelivery;
  userChannelProjection: ExternalUserChannelProjection;
  runtimeImages?: readonly ResolvedImagePayload[];
}): Promise<void> {
  const userMsg = params.operation.userProjection.message;
  let dshRootOperation:
    | {
        clientOperationId: string;
        runtimeSessionId: string;
        productImageSha256: readonly string[];
      }
    | undefined;
  if (getCurrentRuntimeType() === 'dsh') {
    const runtimeSessionId = getExternalRuntimeSessionId();
    if (!runtimeSessionId) {
      throw new Error(
        'DSH Product admission has no persisted Runtime Session owner',
      );
    }
    params.operation.dshClientOperationId ??= `turn-${crypto.randomUUID()}`;
    dshRootOperation = {
      clientOperationId: params.operation.dshClientOperationId,
      runtimeSessionId,
      productImageSha256: (params.runtimeImages ?? []).map((image) =>
        createHash('sha256')
          .update(Buffer.from(image.data, 'base64'))
          .digest('hex'),
      ),
    };
    userMsg.runtimeOperationAnchor = {
      runtime: 'dsh',
      clientOperationId: dshRootOperation.clientOperationId,
      runtimeSessionId,
    };
  }
  const metadataResult = await ensureExternalSessionMetadataForRealUserTurn({
    sessionId: params.sessionId,
    workspacePath: params.workspacePath,
    messageText: params.messageText,
    origin: params.origin,
    scenario: params.scenario,
    turnPath: params.turnPath,
    metadataBirthPending: params.metadataBirthPending,
    birthOrigin: params.birthOrigin,
    runtimeConfig: params.operation.runtimeConfig,
  });
  const { lastMessagePreview } = await persistExternalUserMessageAppend(
    params.sessionId,
    userMsg.id,
    params.failureContext,
    metadataResult.preparedExisting ? undefined : params.lastActiveAt,
    metadataResult.preparedExisting ? 'skip' : 'update',
    dshRootOperation,
  );
  markExternalUserMessagePersisted(params.operation);

  if (metadataResult.preparedExisting) {
    try {
      const updated = await commitPreparedSessionForFirstUserTurn(
        params.sessionId,
        {
          messageText: params.messageText,
          runtimeSessionId: metadataResult.runtimeSessionId,
          origin: params.birthOrigin,
          lastActiveAt: params.lastActiveAt,
          lastMessagePreview,
        },
      );
      if (!updated) {
        console.warn(
          `[external-session] prepared metadata commit skipped for ${params.sessionId}: metadata disappeared after user message persist`,
        );
      }
    } catch (err) {
      console.warn(
        '[external-session] prepared metadata commit after user message persist failed:',
        err,
      );
    }
  }
  const userProjection = params.userChannelProjection;
  const userAdmission: ExternalUserChannelAdmission =
    userProjection.kind === 'skip'
      ? userProjection
      : {
          kind: 'deliver-session-bound-user',
          waitForPersistence: Promise.resolve(true),
          deliverUser: () =>
            deliverExternalSessionBoundUser(params.sessionId, userProjection),
        };
  admitExternalTurnChannelDelivery(params.channelDelivery, userAdmission);
}

async function resumePendingDshRootOperation(
  runtime: AgentRuntime,
  process: RuntimeProcess,
): Promise<boolean> {
  if (runtime.type !== 'dsh') return false;
  const sessionId = getExternalLifecycleSessionId();
  if (!sessionId) throw new Error('DSH recovery has no Product Session owner');
  const pending = getSessionMetadata(sessionId)?.pendingDshRootOperation;
  const runtimeSessionId = getExternalRuntimeSessionId();
  const active = runtime.getActiveRootOperation?.(process) ?? null;
  if (active) {
    if (active.origin === 'collaboration') return true;
    if (
      pending &&
      (pending.clientOperationId !== active.clientOperationId ||
        pending.clientUserMessageId !== active.clientUserMessageId ||
        pending.sourceRuntimeSessionId !== runtimeSessionId)
    ) {
      throw new Error(
        'The active DSH operation differs from the Product admission journal',
      );
    }
    return true;
  }
  if (!pending) return false;
  if (pending.sourceRuntimeSessionId !== runtimeSessionId) {
    throw new Error(
      'The pending DSH operation changed Runtime Session authority',
    );
  }

  const transcript = await loadSessionTranscript(sessionId);
  const users = transcript.messages.filter(
    (message) =>
      message.role === 'user' && message.id === pending.clientUserMessageId,
  );
  if (users.length !== 1) {
    throw new Error('The pending DSH operation lacks one exact Product user');
  }
  const replay = replayDshProductInput(pending, users[0]!);
  setExternalSessionMessages(sessionId, transcript.messages, transcript.cursor);
  const images = resolveImagePayloads(sessionId, replay.images);
  assertDshResolvedImagesMatch(pending, images);

  clearExternalPrewarmingSession();
  setExternalTurnCompleted(false);
  setExternalLastTurnSucceeded(false);
  resetTurnAccumulators();
  seedTurnWatchdogEstimate();
  resetWatchdog();
  markExternalTurnStarted();
  beginExternalTurnTrace('dsh_recovered_product_admission', sessionId);
  setExternalSessionState('running');
  await runtime.sendMessage(process, replay.message, images, {
    clientUserMessageId: pending.clientUserMessageId,
    clientOperationId: pending.clientOperationId,
    allowRealtimeSteer: false,
  });
  return true;
}

async function resumePendingDshInputs(
  runtime: AgentRuntime,
  process: RuntimeProcess,
  context: ExternalSendContext,
): Promise<void> {
  if (runtime.type !== 'dsh') return;
  const inputs = getSessionMetadata(context.sessionId)?.pendingDshInputs ?? [];
  if (inputs.length > 32)
    throw new Error('The DSH input journal exceeds its recovery bound');
  if (!inputs.length) return;
  if (!runtime.steerMessage || !runtime.cancelSteeredMessage)
    throw new Error('DSH input recovery ports are unavailable');
  const recoveries = inputs.map((input) => {
    if (input.sourceRuntimeSessionId !== getExternalRuntimeSessionId())
      throw new Error('DSH input recovery changed Runtime Session authority');
    const replay = replayDshProductInput(input, input.userMessage);
    const images = resolveImagePayloads(context.sessionId, replay.images);
    assertDshResolvedImagesMatch(input, images);
    const admission = Promise.withResolvers<void>();
    void admission.promise.catch(() => undefined);
    if (
      !pendingRealtimeSteeredUserMessages.some(
        (entry) =>
          entry.operation.userProjection.message.id ===
          input.clientUserMessageId,
      )
    ) {
      const recoveredContext: ExternalSendContext = {
        ...context,
        desktopQuery: input.userMessage.desktopQuery,
        asyncQuestionReply: input.userMessage.asyncQuestionReply,
      };
      const operation = createExternalMessageOperation({
        text: replay.message,
        images: replay.images,
        context: recoveredContext,
        runtimeConfig: captureExternalRuntimeConfigSnapshot(
          undefined,
          undefined,
          recoveredContext,
        ),
        userMessage: structuredClone(input.userMessage),
        surfaceMode: 'queue-started',
        queueId: input.queueId,
      });
      registerPendingRealtimeSteeredUserMessage({
        queueId: input.queueId,
        sessionId: context.sessionId,
        operation,
        text: replay.message,
        activityFacts: { inputText: replay.message },
        channelDelivery: NO_CHANNEL_DELIVERY,
        userChannelProjection: { kind: 'skip' },
        admission: admission.promise,
        steerAcknowledged: false,
      });
    }
    return { input, replay, images, admission };
  });
  for (const { input, replay, images, admission } of recoveries) {
    try {
      if (input.state === 'cancel_requested') {
        await runtime.cancelSteeredMessage(process, {
          clientOperationId: input.clientOperationId,
          clientUserMessageId: input.clientUserMessageId,
        });
      } else {
        await runtime.steerMessage(process, replay.message, images, {
          clientOperationId: input.clientOperationId,
          clientUserMessageId: input.clientUserMessageId,
        });
      }
      admission.resolve();
    } catch (error) {
      admission.reject(error);
      throw error;
    }
  }
}

/** Register a new session in SessionStore on the first real user message.
 *  Idempotent: no-op if metadata already exists. Used by the initial-message
 *  path and the post-pre-warm active-process path so snapshot policy cannot
 *  drift. Missing metadata is only materialized for true fresh starts or for
 *  an explicit pre-warm birth state; ordinary resume/delete races fail closed.
 */
async function ensureExternalSessionMetadataForRealUserTurn(params: {
  sessionId: string;
  workspacePath: string;
  messageText: string;
  origin: string;
  scenario: InteractionScenario;
  turnPath: ExternalMetadataTurnPath;
  metadataBirthPending?: boolean;
  birthOrigin?: SessionOrigin;
  runtimeConfig: ExternalRuntimeConfigSnapshot;
}): Promise<{ preparedExisting: boolean; runtimeSessionId?: string }> {
  const { sessionId, workspacePath, messageText, origin, scenario, turnPath } =
    params;
  if (!sessionId) {
    throw new Error(
      `[external-session] Cannot persist ${origin}: missing sessionId`,
    );
  }

  const pendingBirth = pendingBirthForSession(sessionId);
  const existing = getExternalSessionMetadata(sessionId);
  if (existing) {
    const runtimeSessionId = pendingBirth?.runtimeSessionId;
    if (existing.materializationState === 'prepared') {
      clearPendingExternalSessionBirth(sessionId);
      return { preparedExisting: true, runtimeSessionId };
    } else if (
      runtimeSessionId &&
      existing.runtimeSessionId !== runtimeSessionId
    ) {
      try {
        const updated = await updateSessionMetadata(sessionId, {
          runtimeSessionId,
        });
        if (!updated) {
          console.warn(
            `[external-session] runtimeSessionId patch skipped for ${sessionId}: metadata disappeared during ${origin}`,
          );
        }
      } catch (err) {
        console.warn('[external-session] runtimeSessionId patch failed:', err);
      }
    }
    clearPendingExternalSessionBirth(sessionId);
    return { preparedExisting: false };
  }

  const hasOwnedFreshStartAuthority =
    turnPath === 'fresh-start' &&
    scenario.type !== 'im' &&
    scenario.type !== 'agent-channel' &&
    scenario.type !== 'registeredAgent';
  const hasMaterializationBirth =
    Boolean(pendingBirth) ||
    params.metadataBirthPending === true ||
    hasOwnedFreshStartAuthority;
  if (
    !shouldCreateMissingExternalMetadataForRealUserTurn(
      turnPath,
      hasMaterializationBirth,
    )
  ) {
    throw new Error(
      `[external-session] Refusing to create missing metadata for ${sessionId} during ${origin}; ` +
        'no pending pre-warm birth exists, so this may be a deleted or invalid resume session.',
    );
  }

  if (
    pendingBirth &&
    (pendingBirth.workspacePath !== workspacePath ||
      pendingBirth.scenario.type !== scenario.type)
  ) {
    console.warn(
      `[external-session] pending birth context changed for ${sessionId}: ` +
        `birth=${pendingBirth.workspacePath}/${pendingBirth.scenario.type}, ` +
        `turn=${workspacePath}/${scenario.type}`,
    );
  }

  const agent = findProjectAgentByWorkspacePath(workspacePath) as
    | AgentConfig
    | undefined;
  const title = deriveSessionTitle(messageText.trim(), 40) || 'New Chat';
  const meta = createMaterializedSessionMetadata({
    agentDir: workspacePath,
    sessionId,
    scenario: materializationScenarioFromInteraction(scenario),
    agent,
    runtimeOverride: getCurrentRuntimeType(),
    runtimeSourceOverride: getCurrentRuntimeSource(),
    managedCodexProviderReady: isManagedCodexProviderReady(loadAdminConfig()),
    fallbackRuntime: getCurrentRuntimeType(),
    title,
    origin: params.birthOrigin,
  });
  const birthRoute = params.runtimeConfig.providerRoute;
  if (getCurrentRuntimeType() === 'dsh' && isConcreteProviderRoute(birthRoute)) {
    meta.providerRoute = { ...birthRoute };
    meta.providerId = birthRoute.providerId;
    meta.model = birthRoute.model;
    meta.permissionMode = params.runtimeConfig.permissionMode;
    meta.reasoningEffort = params.runtimeConfig.reasoningEffort || 'default';
    meta.configSnapshotAt = new Date().toISOString();
    delete meta.providerEnvJson;
  }
  if (pendingBirth?.runtimeSessionId) {
    meta.runtimeSessionId = pendingBirth.runtimeSessionId;
  }

  await saveSessionMetadata(meta);
  if (!getSessionMetadata(sessionId)) {
    throw new Error(
      `[external-session] Failed to materialize session metadata for ${sessionId} during ${origin}`,
    );
  }
  clearPendingExternalSessionBirth(sessionId);
  console.log(
    `[external-session] session ${sessionId} persisted to SessionStore (${origin})`,
  );
  return { preparedExisting: false };
}

function flushPendingThinking(forceComplete: boolean): void {
  const presentation = getTranscriptPresentation();
  if (presentation) {
    presentation.closeThinking();
    resetExternalPendingThinking();
  } else flushExternalPendingThinkingBlock(forceComplete);
}

function closePendingThinkingProjection(): void {
  if (!isExternalPendingThinkingActive()) return;
  const index = getExternalPendingThinkingIndex();
  flushPendingThinking(true);
  broadcast('chat:content-block-stop', { index, type: 'thinking' });
}

function openPendingThinkingProjection(index: number): void {
  flushPendingText('mirror-completed-block');
  closePendingThinkingProjection();
  resetExternalPendingThinking({ index, active: true, startedAt: Date.now() });
  broadcast('chat:thinking-start', { index });
  fireExternalImCallback('activity', '');
}

/** Flush any incomplete blocks (thinking/tool) at turn boundary — handles interrupts */
function flushAllPending(
  textMirrorDisposition: ExternalTextMirrorDisposition,
): void {
  flushPendingText(textMirrorDisposition);
  closePendingThinkingProjection();
  if (getExternalProductContent()) return;
  for (const interrupted of flushExternalPendingToolInputsForTurn()) {
    applySubagentToolResult(interrupted.parentToolUseId, {
      kind: 'tool_result',
      toolUseId: interrupted.toolUseId,
      content: interrupted.content,
      isError: interrupted.isError,
    });
  }
  finalizeExternalProviderToolsForTurn();
}

// ─── Watchdog timer (10 min inactivity → kill hung process) ───
//
// Suspension-aware: an interval drives the check and credits process-suspension
// gaps (macOS sleep / App Nap) so they are not counted as inactivity — same
// fix as the builtin watchdog. See utils/inactivity-watchdog.ts. (Previously a
// reset-on-activity setTimeout, which fired on resume because its deadline
// elapsed in wall-clock during sleep — a turn the runtime never actually hung.)
const WATCHDOG_INTERVAL_MS = 30 * 1000;
const MANAGED_CODEX_STRUCTURED_USER_INPUT_DISABLED_PROMPT = `<myagents-managed-codex-interaction-limits>
This session is running on Managed Codex. The structured user-input tools are intentionally disabled here.

Do not call request_user_input, AskUserQuestion, or MCP elicitation/form tools to ask the IM user a question.
If you need clarification or a choice from the user, ask it as normal chat text and wait for the user's next message.
</myagents-managed-codex-interaction-limits>`;

function isManagedCodexStructuredUserInputDisabled(
  runtimeType: RuntimeType,
  runtimeSource: RuntimeSource | undefined,
): boolean {
  return runtimeType === 'codex' && runtimeSource === 'managed-provider';
}

function isChannelScenario(scenario: InteractionScenario): boolean {
  return scenario.type === 'im' || scenario.type === 'agent-channel';
}

function getRuntimeAwareChannelInteractionDisallowedTools(
  runtimeType: RuntimeType,
  runtimeSource: RuntimeSource | undefined,
  scenario: InteractionScenario,
): string[] {
  const tools = getChannelInteractionDisallowedTools(scenario);
  if (
    isChannelScenario(scenario) &&
    isManagedCodexStructuredUserInputDisabled(runtimeType, runtimeSource) &&
    !tools.includes('AskUserQuestion')
  ) {
    return ['AskUserQuestion', ...tools];
  }
  return tools;
}

function appendManagedCodexInteractionLimitPrompt(
  prompt: string,
  runtimeType: RuntimeType,
  runtimeSource: RuntimeSource | undefined,
  scenario: InteractionScenario,
): string {
  if (!isChannelScenario(scenario)) return prompt;
  if (!isManagedCodexStructuredUserInputDisabled(runtimeType, runtimeSource))
    return prompt;
  return prompt
    ? `${prompt}\n\n${MANAGED_CODEX_STRUCTURED_USER_INPUT_DISABLED_PROMPT}`
    : MANAGED_CODEX_STRUCTURED_USER_INPUT_DISABLED_PROMPT;
}

const externalWatchdog = new InactivityWatchdog({
  timeoutMs: EXTERNAL_WATCHDOG_DEFAULT_TIMEOUT_MS,
  intervalMs: WATCHDOG_INTERVAL_MS,
});
let currentWatchdogTimeoutMs = EXTERNAL_WATCHDOG_DEFAULT_TIMEOUT_MS;

function usageForWatchdogBudget(): MessageUsage | null {
  const estimatedInputTokens = getExternalCurrentTurnEstimatedInputTokens();
  const usage =
    getExternalCurrentTurnUsage() ?? getLastPersistedRuntimeUsageTotals();
  if (estimatedInputTokens <= 0) return usage;

  const observed = observedContextTokens(usage);
  if (observed >= estimatedInputTokens) return usage;

  return {
    ...(usage ?? { outputTokens: 0 }),
    inputTokens: Math.max(usage?.inputTokens ?? 0, estimatedInputTokens),
    outputTokens: usage?.outputTokens ?? 0,
    model:
      (usage?.model ?? getExternalRuntimeLiveReportedModel()) ||
      getExternalRuntimeDesiredModel() ||
      undefined,
  };
}

function refreshWatchdogTimeout(): void {
  const runtimeType =
    getExternalActiveRuntime()?.type ?? getCurrentRuntimeType();
  const usageForBudget = usageForWatchdogBudget();
  const nextTimeoutMs = externalRuntimeWatchdogTimeoutMs(
    runtimeType,
    usageForBudget,
  );
  if (nextTimeoutMs === currentWatchdogTimeoutMs) return;

  currentWatchdogTimeoutMs = nextTimeoutMs;
  externalWatchdog.setTimeoutMs(nextTimeoutMs);

  const minutes = Math.round(nextTimeoutMs / 60_000);
  const tokens = observedContextTokens(usageForBudget);
  console.log(
    `[external-session] Watchdog: timeout adjusted to ${minutes} minutes for ${runtimeType} contextTokens=${tokens}`,
  );
}

/** Record runtime activity (and start the interval on the first call of a turn). */
function resetWatchdog(): void {
  refreshWatchdogTimeout();
  externalWatchdog.markActivity();
  if (watchdogTimer) return; // already armed — markActivity above is the reset
  externalWatchdog.reset();
  watchdogTimer = setInterval(() => {
    const { fire, suspendedMs } = externalWatchdog.evaluateTick();
    if (suspendedMs > 0) {
      console.log(
        `[external-session] Watchdog: credited ${Math.round(suspendedMs / 1000)}s process suspension (sleep/App Nap) — not counted as inactivity`,
      );
    }
    // Paused on a human: pendingExternalInteractiveRequests holds the open
    // permission card / AskUserQuestion. The user's think time is not runtime
    // inactivity — re-baseline the idle clock so the post-answer budget is fresh
    // and skip the kill. evaluateTick already advanced lastTickAt, so the wait
    // ending produces no spurious suspension credit. (High-2, cross-review.)
    if (hasExternalInteractiveRequests()) {
      externalWatchdog.markActivity();
      return;
    }
    if (!fire) return;
    clearWatchdog();
    const minutes = Math.round(currentWatchdogTimeoutMs / 60_000);
    console.error(
      `[external-session] Watchdog: no runtime activity for ${minutes} minutes of active time, killing process`,
    );
    broadcast('chat:agent-error', {
      message: `External runtime timed out (no activity for ${minutes} minutes)`,
    });
    broadcast('chat:message-error', 'External runtime timed out');
    fireExternalImCallback(
      'error',
      buildImErrorPayload('External runtime timed out'),
    );
    void stopExternalSession({ reason: 'failure' });
  }, WATCHDOG_INTERVAL_MS);
  watchdogTimer.unref?.();
}

function clearWatchdog(): void {
  if (watchdogTimer) {
    clearInterval(watchdogTimer);
    watchdogTimer = null;
  }
}

function recordRuntimeActivity(): void {
  if (
    getExternalTurnStartTime() === 0 ||
    isExternalTurnCompleted() ||
    getExternalUserRequestedStop()
  )
    return;
  resetWatchdog();
}

function beginExternalTurnTrace(
  source: string,
  sessionId = getExternalLifecycleSessionId(),
  requestId: string | undefined = getExternalActiveRequestId() || undefined,
  runtime = getCurrentRuntimeType(),
): void {
  externalTurnSeq += 1;
  currentTurnTraceId = `external-${Date.now()}-${externalTurnSeq}`;
  currentTurnTraceSessionId = sessionId;
  currentTurnTraceRequestId = requestId;
  currentTurnTraceRuntime = runtime;
  currentTurnTraceStartMs = nowMs();
  firstDeltaTraceEmitted = false;
  firstThinkingDeltaTraceEmitted = false;
  firstTextDeltaTraceEmitted = false;
  activeToolTraceStarts.clear();
  emitPerfTrace({
    trace: 'turn',
    phase: 'turn_start',
    sessionId:
      currentTurnTraceSessionId || getExternalLifecycleSessionId() || undefined,
    requestId: currentTurnTraceRequestId,
    turnId: currentTurnTraceId,
    runtime: currentTurnTraceRuntime,
    status: 'ok',
    detail: { source },
  });

  // NEW: Notify continuous watch subscribers of turn start
  const lifecycleSessionId = getExternalLifecycleSessionId();
  if (lifecycleSessionId && currentTurnTraceId) {
    void import('../inbox/watch-stream')
      .then(({ watchStreamManager }) => {
        const stream = watchStreamManager.getStream(lifecycleSessionId);
        // TODO: track turn index properly
        return stream.notifyTurnStarted(currentTurnTraceId, 0);
      })
      .catch(err => {
        console.error('[watch-stream] failed to notify turn start:', err);
      });
  }
}

function emitExternalTurnTrace(
  phase: string,
  options: {
    status?: 'ok' | 'error' | 'timeout' | 'skipped';
    durationMs?: number;
    sizeBytes?: number;
    count?: number;
    detail?: Record<string, string | number | boolean | null | undefined>;
  } = {},
): void {
  if (!currentTurnTraceId) return;
  emitPerfTrace({
    trace: 'turn',
    phase,
    durationMs:
      options.durationMs ??
      (currentTurnTraceStartMs
        ? elapsedMs(currentTurnTraceStartMs)
        : undefined),
    sessionId:
      currentTurnTraceSessionId || getExternalLifecycleSessionId() || undefined,
    requestId: currentTurnTraceRequestId,
    turnId: currentTurnTraceId,
    runtime: currentTurnTraceRuntime || getCurrentRuntimeType(),
    status: options.status ?? 'ok',
    sizeBytes: options.sizeBytes,
    count: options.count,
    detail: options.detail,
  });
}

function emitExternalDeltaTrace(
  kind: 'thinking' | 'text',
  delta: string,
): void {
  if (!currentTurnTraceId) return;
  const sizeBytes = Buffer.byteLength(delta, 'utf8');
  if (!firstDeltaTraceEmitted) {
    firstDeltaTraceEmitted = true;
    emitExternalTurnTrace('first_delta', { sizeBytes, detail: { kind } });
  }
  if (kind === 'thinking' && !firstThinkingDeltaTraceEmitted) {
    firstThinkingDeltaTraceEmitted = true;
    emitExternalTurnTrace('first_thinking_delta', { sizeBytes });
  }
  if (kind === 'text' && !firstTextDeltaTraceEmitted) {
    firstTextDeltaTraceEmitted = true;
    emitExternalTurnTrace('first_text_delta', { sizeBytes });
  }
}

function emitExternalToolStartTrace(
  toolUseId: string,
  toolName: string,
  isSubAgent = false,
): void {
  if (!currentTurnTraceId) return;
  activeToolTraceStarts.set(toolUseId, nowMs());
  emitExternalTurnTrace('tool_start', {
    detail: { toolUseId, toolName, subAgent: isSubAgent },
  });
}

function emitExternalToolEndTrace(toolUseId: string, isError?: boolean): void {
  if (!currentTurnTraceId) return;
  const started = activeToolTraceStarts.get(toolUseId);
  activeToolTraceStarts.delete(toolUseId);
  emitExternalTurnTrace('tool_end', {
    status: isError ? 'error' : 'ok',
    durationMs: started ? elapsedMs(started) : undefined,
    detail: { toolUseId },
  });
}

function clearExternalTurnTrace(): void {
  currentTurnTraceId = '';
  currentTurnTraceSessionId = '';
  currentTurnTraceRequestId = undefined;
  currentTurnTraceRuntime = '';
  currentTurnTraceStartMs = 0;
  firstDeltaTraceEmitted = false;
  firstThinkingDeltaTraceEmitted = false;
  firstTextDeltaTraceEmitted = false;
  activeToolTraceStarts.clear();
}

// ─── Turn outcome tracking (stale text protection for cron/heartbeat) ───
function seedTurnWatchdogEstimate(extraText = ''): void {
  const runtimeType =
    getExternalActiveRuntime()?.type ?? getCurrentRuntimeType();
  setExternalCurrentTurnEstimatedInputTokens(
    runtimeType === 'codex'
      ? estimatedContextTokensFromMessages(
          getExternalSessionMessagesSnapshot(),
          extraText,
        )
      : 0,
  );
}

/** Reset all per-turn accumulators */
function resetTurnAccumulators(): void {
  resetExternalContentState();
  resetExternalTurnAccumulators();
}

function rollbackReservedExternalTurnAfterDrainFailure(): void {
  resetTurnAccumulators();
  clearExternalTurnStartTime();
  setExternalTurnCompleted(true);
  setExternalSessionState('idle');
  if (hasExternalQueuedOperations()) {
    setTimeout(drainExternalQueueAfterTurn, 0);
  }
}

function consumeExternalTurnUsage(): MessageUsage | undefined {
  const currentTurnUsage = getExternalCurrentTurnUsage();
  const fallbackModel =
    currentTurnUsage?.model ||
    getExternalRuntimeLiveReportedModel() ||
    getExternalRuntimeDesiredModel() ||
    getPrimaryModel(currentTurnUsage?.modelUsage);

  if (!currentTurnUsage) {
    if (!fallbackModel) return undefined;
    return {
      inputTokens: 0,
      outputTokens: 0,
      model: fallbackModel,
    };
  }

  const normalizedCurrent = normalizeUsage({
    ...currentTurnUsage,
    model: fallbackModel,
  });
  if (!normalizedCurrent) return undefined;

  if (currentTurnUsage.semantics === 'running_total') {
    const delta = normalizeUsage(
      diffUsageTotals(getLastPersistedRuntimeUsageTotals(), normalizedCurrent),
    );
    setLastPersistedRuntimeUsageTotals(normalizedCurrent);
    return (
      delta ?? {
        inputTokens: 0,
        outputTokens: 0,
        model: fallbackModel,
      }
    );
  }

  setLastPersistedRuntimeUsageTotals(
    addUsageTotals(getLastPersistedRuntimeUsageTotals(), normalizedCurrent),
  );
  return normalizedCurrent;
}

function currentExternalTurnTextSnapshot(): string {
  if (getExternalProductContent())
    return getLastExternalAssistantTextFromTranscript();
  const blockText = getExternalContentBlockText();
  return blockText || getExternalAssistantText().trim();
}

function consumeExternalTurnMetrics(): {
  durationMs?: number;
  usage?: MessageUsage;
} {
  const turnStartTime = getExternalTurnStartTime();
  const durationMs = turnStartTime
    ? Math.max(0, Date.now() - turnStartTime)
    : undefined;
  const usage = consumeExternalTurnUsage();
  return {
    ...(durationMs !== undefined ? { durationMs } : {}),
    ...(usage ? { usage } : {}),
  };
}

function recordExternalCompletionTerminal(
  status: 'complete' | 'stopped' | 'error',
): SessionCompletionTerminal | null {
  return recordExternalSessionCompletionTerminal({
    sessionId: getExternalLifecycleSessionId(),
    workspacePath: getExternalLifecycleWorkspacePath(),
    status,
  });
}

function notifyFailedExternalTurn(
  terminalGeneration: number,
  text: string,
  error: string,
): SessionCompletionTerminal | null {
  const metrics = consumeExternalTurnMetrics();
  const product = getExternalProductContent();
  if (product) {
    getTranscriptPresentation()?.closeText();
    getTranscriptPresentation()?.closeThinking();
    product.finishTurn('error', { ...metrics, completionState: 'partial', terminalStatus: 'error', runtimeTurnAnchor: getExternalRuntimeTurnAnchor() ?? undefined });
  }
  const completionTerminal = recordExternalCompletionTerminal('error');
  const activityFacts = getExternalTurnActivityFacts();
  const finalization = persistExternalTerminalActivity(
    activityFacts,
    text,
  ).finally(() => clearExternalTurnActivityFacts(activityFacts));
  trackExternalTurnFinalization(finalization);
  notifyExternalTurnOutcome(
    terminalGeneration,
    {
      success: false,
      text,
      error,
      durationMs: metrics.durationMs,
      ...(metrics.usage
        ? {
            usage: {
              inputTokens: metrics.usage.inputTokens,
              outputTokens: metrics.usage.outputTokens,
            },
          }
        : {}),
    },
    finalization,
  );
  return completionTerminal;
}

function finalizeAcceptedExternalFailure(message: string): void {
  const terminalGenerationBefore = getExternalTurnTerminalGeneration();
  markExternalTurnComplete(
    { kind: 'turn_complete', status: 'failed', error: message },
    { intentionalStopInProgress: false },
  );
  const terminalGeneration = getExternalTurnTerminalGeneration();
  if (terminalGeneration > terminalGenerationBefore) {
    notifyFailedExternalTurn(
      terminalGeneration,
      currentExternalTurnTextSnapshot(),
      message,
    );
  }
}

function persistExternalTerminalActivity(
  activityFacts: SessionActivityTurnFacts | null,
  text: string,
): Promise<void> {
  const sessionId = getExternalLifecycleSessionId();
  const lastActiveAt =
    activityFacts && shouldRecordTerminalActivity(activityFacts, { text })
      ? new Date().toISOString()
      : undefined;
  if (!sessionId || !lastActiveAt) return Promise.resolve();
  return updateSessionMetadata(sessionId, { lastActiveAt })
    .then(() => undefined)
    .catch((error) => {
      console.error(
        '[external-session] failed to persist terminal activity:',
        error,
      );
    });
}

function finalizeStoppedExternalTurn(
  text: string,
  metrics: ReturnType<typeof consumeExternalTurnMetrics>,
  publishCompletion = true,
): SessionCompletionTerminal | null {
  const product = getExternalProductContent();
  if (product) {
    getTranscriptPresentation()?.closeText();
    getTranscriptPresentation()?.closeThinking();
    product.finishTurn('stopped', { ...metrics, completionState: 'partial', terminalStatus: 'stopped', runtimeTurnAnchor: getExternalRuntimeTurnAnchor() ?? undefined });
  }
  const completionTerminal = publishCompletion
    ? recordExternalCompletionTerminal('stopped')
    : null;
  const activityFacts = getExternalTurnActivityFacts();
  const finalization = persistExternalTerminalActivity(
    activityFacts,
    text,
  ).finally(() => clearExternalTurnActivityFacts(activityFacts));
  trackExternalTurnFinalization(finalization);
  notifyExternalTurnStopped(
    text,
    {
      durationMs: metrics.durationMs,
      ...(metrics.usage
        ? {
            usage: {
              inputTokens: metrics.usage.inputTokens,
              outputTokens: metrics.usage.outputTokens,
            },
          }
        : {}),
    },
    finalization,
  );
  return completionTerminal;
}

/**
 * Set the runtime's session ID (CC: from hook/system.init; Codex: from thread/start).
 * Used for session resume in multi-turn conversations.
 */
export function setRuntimeSessionId(id: string): void {
  setExternalRuntimeSessionId(id);
  console.log(
    `[external-session] Runtime session ID set: ${JSON.stringify(summarizeSensitiveValueForLog(id))}`,
  );
}

/**
 * Restore module-level state after Sidecar restart (session resume).
 * Called from index.ts when an external runtime session is reopened from history.
 * Sets lastRuntimeSessionId so sendExternalMessage uses resume instead of new session.
 */
export async function restoreExternalSessionState(
  sessionId: string,
  workspacePath: string,
  scenario: InteractionScenario,
): Promise<{ success: boolean; error?: string }> {
  if (getSessionMetadata(sessionId)?.pendingConversationMutation) {
    const resolvedMutation =
      await resolvePendingConversationMutation(sessionId);
    if (!resolvedMutation.success) {
      return { success: false, error: resolvedMutation.error };
    }
  }
  // If switching to a different session, reset all accumulated state to prevent contamination
  if (sessionId !== getExternalLifecycleSessionId()) {
    resetModuleState();
  }
  bindExternalSessionContext({
    sessionId,
    workspacePath,
    scenario,
    analyticsSource: scenario.type,
  });

  // Restore the runtime's own session ID from persisted metadata.
  // Four cases:
  // 0. Cross-runtime mismatch (session created by different external runtime) → fresh start
  // 1. Codex session with runtimeSessionId persisted → use it (threadId)
  // 2. CC session (no runtimeSessionId, but has runtime + messages) → sessionId (CC uses our ID)
  // 3. Brand new session (no messages, or no metadata) → empty string → sendExternalMessage hits Case 1 (fresh start)
  const meta = getSessionMetadata(sessionId);
  await activateSessionTranscript(sessionId);
  const transcript = await loadSessionTranscript(sessionId);
  const hasExistingMessages = transcript.messages.length > 0;
  const currentRuntimeType = getCurrentRuntimeType();

  // Cross-runtime guard: session created by a different runtime (e.g., Codex session in CC Sidecar).
  // The other runtime's session ID / threadId is meaningless here — must start fresh.
  const persistedRuntimeType = meta?.runtimeBinding
    ? runtimeTypeForBinding(meta.runtimeBinding)
    : meta?.runtime;
  const isCrossRuntime =
    persistedRuntimeType !== undefined &&
    persistedRuntimeType !== currentRuntimeType;

  if (
    !isCrossRuntime &&
    currentRuntimeType === 'dsh' &&
    meta?.runtimeSessionId &&
    !hasExistingMessages &&
    !meta.pendingDshRootOperation
  ) {
    const cleared = await updateSessionMetadata(sessionId, {
      runtimeSessionId: '',
    });
    if (!cleared) {
      return {
        success: false,
        error: 'Failed to clear a pre-turn DSH Runtime Session binding',
      };
    }
    clearExternalRuntimeSessionId();
    console.log(
      `[external-session] Cleared pre-turn DSH Runtime Session binding for ${sessionId}`,
    );
  } else if (isCrossRuntime) {
    clearExternalRuntimeSessionId(); // Different runtime — cannot resume
    console.log(
      `[external-session] Cross-runtime session: persisted=${persistedRuntimeType}, current=${currentRuntimeType}, will start fresh`,
    );
  } else if (meta?.runtimeSessionId) {
    setExternalRuntimeSessionId(meta.runtimeSessionId);
  } else if (meta?.runtime === 'claude-code' && hasExistingMessages) {
    setExternalRuntimeSessionId(sessionId); // CC: session ID === runtime session ID
  } else {
    clearExternalRuntimeSessionId(); // New session: nothing to resume
  }

  // Load existing messages for correct incremental save (or clear stale in-memory state)
  setExternalSessionMessages(sessionId, transcript.messages, transcript.cursor);

  // PRD 0.2.15 Review F2 — repopulate the external-path attachment registry
  // from persisted ContentBlock[] so /api/attachment/tool/... can still resolve
  // Codex savedPath attachments after a sidecar restart / Handover. Without
  // this rebuild, history replay shows broken images for any savedPath that
  // didn't land in our trusted root.
  if (hasExistingMessages) {
    forEachExternalSessionMessage((msg) => {
      if (msg.role !== 'assistant' || typeof msg.content !== 'string') return;
      try {
        const blocks = JSON.parse(msg.content);
        if (Array.isArray(blocks)) {
          rebuildAttachmentRegistryFromBlocks(sessionId, blocks, msg.id);
        }
      } catch {
        // Plain-text assistant messages have no blocks — fine.
      }
    });
  }
  const sessionMessagesSnapshot = getExternalSessionMessagesSnapshot();
  setLastPersistedRuntimeUsageTotals(
    restoreRuntimeUsageTotals(
      currentRuntimeType,
      sessionMessagesSnapshot,
      meta?.runtimeUsageTotals,
    ),
  );
  const restoredRuntimeReportedModel =
    meta?.runtimeUsageTotals?.model ||
    sessionMessagesSnapshot
      .slice()
      .reverse()
      .find((msg) => msg.role === 'assistant' && msg.usage?.model)?.usage
      ?.model ||
    '';
  // Rehydrate model/permission from session snapshot so a restored external
  // Sidecar can expose the session's last known config via /api/session/config.
  // Without this, starting an existing session with no runtime process leaves
  // runtime-config desired state empty and adoption silently no-ops.
  restoreExternalRuntimeConfigFromMetadata({
    model: meta?.model,
    permissionMode: meta?.permissionMode,
    reasoningEffort: meta?.reasoningEffort,
    runtimeReportedModel: restoredRuntimeReportedModel,
    runtime: currentRuntimeType,
    sessionId,
  });
  console.log(
    `[external-session] Restored state for session ${sessionId}, runtimeSessionId=${JSON.stringify(summarizeSensitiveValueForLog(getExternalRuntimeSessionId()))} (${getExternalSessionMessageCount()} messages), permissionMode=${getExternalRuntimeDesiredPermissionMode() || '(default)'}, model=${getExternalRuntimeDesiredModel() || '(default)'}, effort=${getExternalRuntimeDesiredReasoningEffort() || '(default)'}`,
  );
  if (currentRuntimeType === 'dsh' && meta?.pendingDshRootOperation) {
    try {
      await prewarmExternalSession({ sessionId, workspacePath, scenario });
    } catch (error) {
      return {
        success: false,
        error: `DSH root operation recovery failed: ${error instanceof Error ? error.message : String(error)}`,
      };
    }
  }
  return { success: true };
}

// Pattern B — `setExternalImStreamCallback` removed. The /api/im/chat handler
// in index.ts subscribes to `imEventBus` directly and filters by requestId.
// This deletes the duplicate single-callback infrastructure that mirrored
// agent-session.ts; both builtin and external runtimes now share the same bus.

// ─── Config change handlers ───

export function isExternalModelFallbackRestartNeeded(
  nextModel: string,
  prevConfiguredModel: string,
  liveReportedModel: string,
): boolean {
  if (nextModel === prevConfiguredModel) return false;
  if (liveReportedModel && nextModel === liveReportedModel) return false;
  return true;
}

function getActiveRuntimeConfigCapabilities(): RuntimeConfigCapabilities {
  const runtime = getExternalActiveRuntime();
  return (
    runtime?.getConfigCapabilities?.() ??
    getDefaultExternalConfigCapabilities(
      runtime?.type ?? getCurrentRuntimeType(),
    )
  );
}

async function applyRuntimeConfigFieldAtBoundary(
  key: keyof ExternalRuntimeConfigPatch,
  value: string | undefined,
  mode: RuntimeConfigApplyMode,
  warnings: string[],
): Promise<string | undefined> {
  const active = getExternalActivePair();
  if (!active || active.process.exited) return undefined;

  const run = async (
    setter:
      | ((process: RuntimeProcess, value: string | undefined) => Promise<void>)
      | undefined,
  ) => {
    if (!setter) return;
    await setter.call(active.runtime, active.process, value || undefined);
  };

  try {
    switch (mode) {
      case 'next_turn_state':
        if (key === 'model') await run(active.runtime.setModel);
        if (key === 'permissionMode')
          await run(active.runtime.setPermissionMode);
        if (key === 'reasoningEffort')
          await run(active.runtime.setReasoningEffort);
        return undefined;
      case 'live_session_rpc':
        if (key === 'model') await run(active.runtime.setModel);
        if (key === 'permissionMode')
          await run(active.runtime.setPermissionMode);
        if (key === 'reasoningEffort')
          await run(active.runtime.setReasoningEffort);
        return undefined;
      case 'restart_when_idle':
        warnings.push(
          `${key} requires an idle restart for ${active.runtime.type}; restart is deferred until the runtime process exits`,
        );
        console.warn(
          `[external-session] external-config restart_when_idle: field=${key} runtime=${active.runtime.type} sessionId=${getExternalLifecycleSessionId() || '(none)'}`,
        );
        return undefined;
      case 'unsupported':
        warnings.push(`${key} is not supported by ${active.runtime.type}`);
        console.warn(
          `[external-session] external-config unsupported: field=${key} runtime=${active.runtime.type} sessionId=${getExternalLifecycleSessionId() || '(none)'}`,
        );
        return undefined;
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.warn(
      `[external-session] external-config ${mode} failed: field=${key} runtime=${active.runtime.type ?? getCurrentRuntimeType()} sessionId=${getExternalLifecycleSessionId() || '(none)'} error=${message}`,
    );
    // Both native RPC and next-turn setters can reject unsupported policy.
    // Never dispatch under the previous (possibly broader) permissions.
    if (key === 'model' || key === 'permissionMode') {
      return `${key} ${mode} failed: ${message}`;
    }
    warnings.push(`${key} ${mode} failed: ${message}`);
  }
  return undefined;
}

async function applyExternalRuntimeConfigToActiveProcess(
  patch: ExternalRuntimeConfigPatch,
  source: ExternalConfigSource,
): Promise<ExternalConfigApplyResult> {
  const warnings: string[] = [];
  const capabilities = getActiveRuntimeConfigCapabilities();
  const keys = externalConfigPatchKeys(patch);

  for (const key of keys) {
    const error = await applyRuntimeConfigFieldAtBoundary(
      key,
      patch[key],
      capabilities[key],
      warnings,
    );
    if (error) return { warnings, error };
  }

  console.log(
    `[external-session] external-config applied: sessionId=${getExternalLifecycleSessionId() || '(none)'} runtime=${getCurrentRuntimeType()} source=${source} keys=${keys.join(',') || '(none)'} modes=${keys.map((key) => `${key}:${capabilities[key]}`).join(',') || '(none)'}`,
  );
  return { warnings };
}

async function applyExternalRuntimeConfigAtBoundary(
  patch: ExternalRuntimeConfigPatch,
  source: ExternalConfigSource,
): Promise<ExternalConfigApplyResult> {
  applyDesiredExternalRuntimeConfigPatch(patch);
  return applyExternalRuntimeConfigToActiveProcess(patch, source);
}

export async function updateExternalRuntimeConfig(
  patch: ExternalRuntimeConfigPatch,
  opts: { source?: ExternalConfigSource } = {},
): Promise<ExternalConfigUpdateResult> {
  await awaitExternalLifecycleStarting();

  const source = opts.source ?? 'runtime-config';
  const runtime = getCurrentRuntimeType();
  const lifecycleSessionId = getExternalLifecycleSessionId();
  const configSessionId = lifecycleSessionId || getCurrentBoundSessionId();
  const normalizedInput = normalizeExternalRuntimeConfigPatch(
    patch,
    source,
    runtime,
    configSessionId,
  );
  const snapshotFiltered = filterRuntimeConfigPatchForSnapshot({
    patch: normalizedInput,
    source,
    isSnapshotted: isCurrentExternalSessionSnapshotted(configSessionId),
  });
  const normalized = snapshotFiltered.patch;
  const keys = externalConfigPatchKeys(normalized);
  const skippedWarnings =
    snapshotFiltered.skippedKeys.length > 0
      ? [
          `snapshot-authoritative fields skipped: ${snapshotFiltered.skippedKeys.join(',')}`,
        ]
      : [];
  if (snapshotFiltered.skippedKeys.length > 0) {
    console.warn(
      `[external-session] external-config skipped snapshot-owned fields: sessionId=${lifecycleSessionId || getCurrentBoundSessionId() || '(none)'} runtime=${runtime} source=${source} keys=${snapshotFiltered.skippedKeys.join(',')}`,
    );
  }
  if (keys.length === 0) {
    console.log(
      `[external-session] external-config noop: sessionId=${lifecycleSessionId || '(none)'} runtime=${runtime} source=${source} keys=(none)`,
    );
    return {
      success: true,
      runtime,
      status: 'noop',
      warnings: skippedWarnings,
    };
  }

  const shouldDefer =
    shouldDeferExternalConfigOperation(
      getExternalLifecycleState(),
      getExternalOperationQueueLength(),
      isExternalOperationDrainInFlight(),
      isExternalTurnFinalizationInFlight(),
    ) ||
    externalSessionMutationInFlight ||
    hasPendingDshNativeWork();
  const noop = isExternalRuntimeConfigPatchNoopAgainstDesired(normalized, {
    allowLiveReportedModel: !shouldDefer,
  });
  applyDesiredExternalRuntimeConfigPatch(normalized);
  if (noop) {
    console.log(
      `[external-session] external-config noop: sessionId=${lifecycleSessionId || '(none)'} runtime=${runtime} source=${source} keys=${keys.join(',')}`,
    );
    return {
      success: true,
      runtime,
      status: 'noop',
      warnings: skippedWarnings,
    };
  }

  if (shouldDefer) {
    const position = enqueueExternalConfigOperation(normalized, source);
    console.log(
      `[external-session] external-config queued: sessionId=${lifecycleSessionId || '(none)'} runtime=${runtime} source=${source} keys=${keys.join(',')} queuePosition=${position}`,
    );
    if (
      getExternalLifecycleState() !== 'running' &&
      isExternalTurnFinalizationInFlight()
    ) {
      void waitExternalTurnFinalization(60_000).then(() =>
        drainExternalQueueAfterTurn(),
      );
    }
    return {
      success: true,
      runtime,
      status: 'queued',
      warnings: skippedWarnings,
    };
  }

  const result = await applyExternalRuntimeConfigAtBoundary(normalized, source);
  if (result.error) {
    return {
      success: false,
      runtime,
      status: 'applied',
      warnings: [...skippedWarnings, ...result.warnings],
      error: result.error,
    };
  }
  return {
    success: true,
    runtime,
    status: 'applied',
    warnings: [...skippedWarnings, ...result.warnings],
  };
}

export async function setExternalModel(
  model: string,
  opts?: { imConfigSync?: boolean },
): Promise<ExternalConfigUpdateResult> {
  const source: ExternalConfigSource = opts?.imConfigSync
    ? 'im-sync'
    : 'desktop';
  const lifecycleSessionId = getExternalLifecycleSessionId();
  if (
    !shouldApplySnapshotConfigUpdate({
      field: 'model',
      source,
      isSnapshotted: isCurrentExternalSessionSnapshotted(
        lifecycleSessionId || getCurrentBoundSessionId(),
      ),
    })
  ) {
    console.warn(
      `[external-session] IM config sync model '${model}' ignored — session ${lifecycleSessionId || getCurrentBoundSessionId() || '(none)'} is snapshotted (snapshot wins)`,
    );
    return {
      success: true,
      runtime: getCurrentRuntimeType(),
      status: 'noop',
      warnings: [],
    };
  }
  return updateExternalRuntimeConfig({ model }, { source });
}

export async function setExternalPermissionMode(
  mode: string,
): Promise<ExternalConfigUpdateResult> {
  const lifecycleSessionId = getExternalLifecycleSessionId();
  if (
    !shouldApplySnapshotConfigUpdate({
      field: 'permissionMode',
      source: 'legacy-permission-mode-set',
      isSnapshotted: isCurrentExternalSessionSnapshotted(
        lifecycleSessionId || getCurrentBoundSessionId(),
      ),
    })
  ) {
    console.warn(
      `[external-session] config sync permissionMode '${mode}' ignored — session ${lifecycleSessionId || getCurrentBoundSessionId() || '(none)'} is snapshotted (snapshot wins; legacy endpoint is Rust-IM-router-only by contract)`,
    );
    return {
      success: true,
      runtime: getCurrentRuntimeType(),
      status: 'noop',
      warnings: [],
    };
  }
  return updateExternalRuntimeConfig(
    { permissionMode: mode },
    { source: 'legacy-permission-mode-set' },
  );
}

export async function setExternalReasoningEffort(
  setting: string,
): Promise<ExternalConfigUpdateResult> {
  return updateExternalRuntimeConfig(
    { reasoningEffort: setting },
    { source: 'desktop' },
  );
}

/** #324 — current normalized reasoning effort level, undefined = default. */
export function getExternalSessionReasoningEffort(): string | undefined {
  return getExternalRuntimeDisplayReasoningEffort();
}

// ─── Public API ───

/**
 * Check if we should use an external runtime for this sidecar
 */
export function shouldUseExternalRuntime(): boolean {
  const runtime = getCurrentRuntimeType();
  return isExternalRuntime(runtime) || isDshRuntime(runtime);
}

/**
 * Wait for any in-flight startExternalSession (notably pre-warm) to finish.
 * Used by reset and materialization callers that touch module state which the
 * spawn path will write to. updateExternalRuntimeConfig uses the same pattern
 * internally; this exported helper is for callers without direct access to
 * `startingPromise`.
 */
export async function awaitExternalSessionStarting(): Promise<void> {
  await awaitExternalLifecycleStarting();
}

export function getExternalSessionState(): ExternalSessionState {
  return getExternalLifecycleState();
}

export function getExternalSystemInitPayload(): {
  info: SystemInitInfo;
  sessionId: string;
  prewarm?: boolean;
  runtime: RuntimeType;
  runtimeSource?: import('../../shared/types/runtime').RuntimeSource;
} | null {
  return getExternalSystemInitPayloadSnapshot();
}

export function getExternalPendingInteractiveRequests(): ExternalPendingInteractiveRequest[] {
  return getExternalInteractiveRequestsSnapshot();
}

export function getExternalSessionId(): string {
  return getExternalLifecycleSessionId();
}

export function getExternalNativeSessionId(): string {
  return getExternalRuntimeSessionId();
}

export async function isExternalSessionStateRestoredFor(
  sessionId: string,
): Promise<boolean> {
  if (getExternalLifecycleSessionId() !== sessionId) return false;
  if (getExternalTranscriptSessionId() !== sessionId) return false;
  if (getActiveSessionTranscript(sessionId)) return true;
  const diskMessages = (await getSessionData(sessionId))?.messages ?? [];
  const memoryMessages = getExternalSessionMessagesSnapshot();
  if (memoryMessages.length < diskMessages.length) return false;
  const diskMatchesMemoryPrefix = diskMessages.every(
    (message, index) => memoryMessages[index]?.id === message.id,
  );
  if (!diskMatchesMemoryPrefix) return false;
  if (memoryMessages.length === diskMessages.length) return true;

  // A longer in-memory transcript is valid only while the target session owns an
  // active/finalizing turn whose tail has not landed in SessionStore yet. Idle
  // tails are stale cross-session residue and must force restore instead.
  return (
    getExternalLifecycleState() === 'running' ||
    isExternalTurnFinalizationInFlight()
  );
}

export function getExternalSessionWorkspacePath(): string {
  return getExternalLifecycleWorkspacePath();
}

/** The session this Sidecar is bound to right now — either already committed
 *  (lastSessionId, set by restoreExternalSessionState at boot or by a completed
 *  start) or about to be committed by an in-flight prewarm/start (startingSessionId). */
export function getCurrentBoundSessionId(): string {
  return getCurrentExternalBoundSessionId();
}

export function getExternalSessionModel(): string | null {
  return getExternalRuntimeDisplayModel();
}

export function getExternalSessionPermissionMode(): string | null {
  return getExternalRuntimeDisplayPermissionMode();
}

function buildCurrentAssistantSnapshotContent(): string | null {
  return buildCurrentExternalAssistantSnapshotContent();
}

export function getExternalLiveAssistantMessage(): SessionMessage | null {
  const lifecycleSessionId = getExternalLifecycleSessionId();
  if (!lifecycleSessionId || getExternalLifecycleState() !== 'running') {
    return null;
  }
  const product = getExternalProductContent();
  if (product) {
    const message = product.currentAssistantId
      ? product.writer.projection.messages.get(product.currentAssistantId)
      : undefined;
    return message?.transcriptState === 'streaming'
      ? toStoredTranscriptMessage(message)
      : null;
  }
  const content = buildCurrentAssistantSnapshotContent();
  if (!content) {
    return null;
  }
  const turnStartTime = getExternalTurnStartTime() || Date.now();
  return {
    id: `external-live-${lifecycleSessionId}-${turnStartTime}`,
    role: 'assistant',
    content,
    timestamp: new Date(turnStartTime).toISOString(),
  };
}

function persistExternalPartialAssistantProjection(
  terminalStatus: 'stopped' | 'error',
): Promise<void> {
  const content = buildCurrentAssistantSnapshotContent();
  if (!content && !getExternalProductContent()) return Promise.resolve();
  const turnStartTime = getExternalTurnStartTime();
  const persistence = appendAndPersistExternalAssistantTurn({
    sessionId: getExternalLifecycleSessionId(),
    content,
    durationMs: turnStartTime
      ? Math.max(0, Date.now() - turnStartTime)
      : undefined,
    usage: null,
    toolCount: 0,
    contextUsage: null,
    runtimeTurnAnchor:
      getCurrentRuntimeType() === 'codex' || getCurrentRuntimeType() === 'dsh'
        ? (getExternalRuntimeTurnAnchor() ?? undefined)
        : undefined,
    completionState: 'partial',
    terminalStatus,
  }).then((result) => {
    if (!result.ok) {
      throw new Error(
        result.failureReason ||
          'Failed to persist partial assistant projection',
      );
    }
  });
  trackExternalTurnFinalization(persistence);
  return persistence;
}

export function getExternalWorkProgressSnapshot() {
  const messages = getExternalTranscriptSessionId() === getCurrentExternalBoundSessionId() ? getExternalSessionMessagesSnapshot() : [];
  const streaming = getExternalLiveAssistantMessage();
  return deriveSessionWorkProgress(streaming ? [...messages.filter(message => message.id !== streaming.id), streaming] : messages,
    { live: true, runtimePlan: getExternalAgentPlan() });
}

export function getExternalLiveSessionSnapshot(targetSessionId: string): {
  snapshotRevision: number;
  inMemoryMessages: SessionMessage[];
  liveStreamingMessage: SessionMessage | null;
  liveSessionState: ExternalSessionState;
  queuedMessages: ReturnType<typeof getExternalQueueStatus>;
  pendingInteractiveRequests: ExternalPendingInteractiveRequest[];
} | null {
  if (targetSessionId !== getCurrentExternalBoundSessionId()) return null;
  flushPendingLiveEvents();
  const liveStreamingMessage = getExternalLiveAssistantMessage();
  let inMemoryMessages =
    getExternalTranscriptSessionId() === targetSessionId
      ? getExternalSessionMessagesSnapshot()
      : [];
  if (getActiveSessionTranscript(targetSessionId) && liveStreamingMessage) {
    inMemoryMessages = inMemoryMessages.filter(
      (message) => message.id !== liveStreamingMessage.id,
    );
  }
  for (const pending of getExternalPendingUserMessageProjections(
    targetSessionId,
  )) {
    if (!inMemoryMessages.some((message) => message.id === pending.id)) {
      inMemoryMessages.push(pending);
    }
  }
  return structuredClone({
    snapshotRevision: getExternalLiveRevision(),
    inMemoryMessages,
    liveStreamingMessage,
    liveSessionState: getExternalLifecycleState(),
    queuedMessages: getExternalQueueStatus(),
    pendingInteractiveRequests: getExternalInteractiveRequestsSnapshot(),
  });
}

/**
 * Get the current external runtime type, or null if builtin
 */
export function getActiveRuntimeType(): RuntimeType {
  return getCurrentRuntimeType();
}

export function getActiveRuntimeSource(): ReturnType<
  typeof getCurrentRuntimeSource
> {
  return getCurrentRuntimeSource();
}

export function getActiveExternalImBridgeTurnContext(): ReturnType<
  typeof getExternalImBridgeTurnContext
> {
  return getExternalImBridgeTurnContext();
}

function isExternalTurnBusy(): boolean {
  return (
    getExternalLifecycleState() === 'running' ||
    isExternalTurnPromotionInFlight()
  );
}

function isManagedCodexProductRuntime(): boolean {
  return (
    getCurrentRuntimeType() === 'codex' &&
    getCurrentRuntimeSource() === 'managed-provider'
  );
}

function isDshProductRuntime(): boolean {
  return (
    getCurrentRuntimeType() === 'dsh' &&
    getCurrentRuntimeSource() === 'integrated'
  );
}

type ExternalSkillAdmission = {
  globalSkillInventory: GlobalSkillInventorySnapshot;
  capabilitySnapshot: EffectiveProjectCapabilitySnapshot;
  unavailableSkillNames: string[];
  revision: string;
};

function buildCurrentExternalSkillAdmission(
  workspacePath: string,
): ExternalSkillAdmission {
  const globalSkillInventory = createGlobalSkillInventorySnapshot();
  const capabilitySnapshot = resolveEffectiveProjectCapabilities(
    workspacePath,
    { globalSkillInventory },
  );
  const projection = trySyncProjectUserConfigFiles(
    workspacePath,
    {
      globalSkillInventory,
      capabilitySnapshot,
    },
    'external-skill-sync',
  );
  const revision = JSON.stringify([
    capabilitySnapshot.revision,
    projection.unavailableSkillNames,
  ]);
  const activeRevision = getExternalActiveCapabilityRevision();
  if (
    activeRevision !== null &&
    activeRevision !== revision &&
    !isDshProductRuntime()
  ) {
    pendingExternalCapabilityRestart = true;
  }
  return {
    globalSkillInventory,
    capabilitySnapshot,
    unavailableSkillNames: projection.unavailableSkillNames,
    revision,
  };
}

function buildCurrentManagedCodexExtensionSnapshot(input?: {
  workspacePath?: string;
  scenario?: InteractionScenario;
  mcpServers?: readonly import('../../shared/config-types').McpServerDefinition[];
  skillAdmission?: ExternalSkillAdmission;
}): ManagedCodexExtensionSnapshot {
  const workspacePath =
    input?.workspacePath ?? getExternalLifecycleWorkspacePath();
  if (!workspacePath) {
    throw new Error('Product extension configuration has no workspace owner');
  }
  const sessionId = getExternalLifecycleSessionId();
  const metadata = sessionId ? getExternalSessionMetadata(sessionId) : null;
  const sessionMcpServers = input?.mcpServers
    ? [...input.mcpServers]
    : getProductExtensionSessionMcpServers();
  const mcpServers =
    sessionMcpServers ??
    resolveWorkspaceConfig(workspacePath, metadata, { includeMcp: true })
      .mcpServers;
  const skillAdmission =
    input?.skillAdmission ?? buildCurrentExternalSkillAdmission(workspacePath);
  const compile = isDshProductRuntime()
    ? compileProductExtensionSnapshot
    : compileManagedCodexExtensionSnapshot;
  return compile({
    workspacePath,
    scenario:
      input?.scenario ??
      (isDshProductRuntime() ? dshDesiredInteractionScenario : null) ??
      getExternalLifecycleScenario(),
    enabledPluginIds:
      getProductExtensionSessionEnabledPluginIds() ??
      metadata?.enabledPluginIds ??
      null,
    mcpServers,
    capabilitySnapshot: skillAdmission.capabilitySnapshot,
    globalSkillInventory: skillAdmission.globalSkillInventory,
    unavailableSkillNames: skillAdmission.unavailableSkillNames,
    agentRoleTarget: isDshProductRuntime() ? 'dsh' : 'managed-codex',
  });
}

function notApplicableProductExtensionResult(
  componentName: import('./managed-codex/extensions/contracts').ManagedCodexExtensionComponentKind,
): ManagedCodexExtensionUpdateResult {
  return {
    success: true,
    extensionStatus: {
      desiredRevision: '',
      effectiveRevision: null,
      state: 'not_applicable',
      components: [
        {
          component: componentName,
          state: 'not_applicable',
          code: 'not_product_extension_runtime',
        },
      ],
    },
  };
}

type ProductExtensionUpdateResult = Readonly<{
  success: boolean;
  extensionStatus: RuntimeExtensionDiagnostics;
  error?: string;
}>;

function pendingProductExtensionOwnerResult(
  componentName: import('./managed-codex/extensions/contracts').ManagedCodexExtensionComponentKind,
): ProductExtensionUpdateResult {
  console.log(
    `[external-session] Product extension ${componentName} sync queued until the Session owner is bound`,
  );
  return {
    success: true,
    extensionStatus: {
      desiredRevision: '',
      effectiveRevision: null,
      state: 'pending_next_start',
      components: [
        {
          component: componentName,
          state: 'pending_next_start',
          code: 'awaiting_product_session_owner',
        },
      ],
    },
  };
}

async function reconcileManagedCodexExtensionSnapshot(
  componentName: import('./managed-codex/extensions/contracts').ManagedCodexExtensionComponentKind,
  build: () => ManagedCodexExtensionSnapshot = buildCurrentManagedCodexExtensionSnapshot,
  preservePromotion?: ExternalTurnPromotionToken | null,
): Promise<ManagedCodexExtensionUpdateResult> {
  await awaitExternalLifecycleStarting();
  if (!isManagedCodexProductRuntime()) {
    return notApplicableProductExtensionResult(componentName);
  }

  let snapshot: ManagedCodexExtensionSnapshot;
  try {
    snapshot = build();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const extensionStatus = markManagedCodexExtensionFailed(message);
    broadcastManagedCodexExtensionDiagnostics(true);
    return {
      success: false,
      error: message,
      extensionStatus,
    };
  }

  const process = getExternalActiveProcess();
  const hasLiveProcess = Boolean(process && !process.exited);
  const admissionOwnsPromotion = Boolean(
    preservePromotion && isExternalTurnPromotionCurrent(preservePromotion),
  );
  const hasBusyTurn =
    getExternalLifecycleState() === 'running' ||
    (isExternalTurnPromotionInFlight() && !admissionOwnsPromotion);
  const status = setManagedCodexDesiredSnapshot(
    snapshot,
    !hasLiveProcess
      ? 'no-live-process'
      : hasBusyTurn
        ? 'busy-process'
        : 'idle-process',
  );
  broadcastManagedCodexExtensionDiagnostics(true);
  if (
    status.effectiveRevision === snapshot.revision &&
    (status.state === 'applied' || status.state === 'unchanged')
  ) {
    setManagedCodexExtensionRestartPending(false);
    return { success: true, extensionStatus: status };
  }
  if (!hasLiveProcess) {
    setManagedCodexExtensionRestartPending(false);
    return { success: true, extensionStatus: status };
  }

  setManagedCodexExtensionRestartPending(true);
  if (hasBusyTurn) {
    console.log(
      '[external-session] Managed Codex extension change deferred until the active turn completes',
    );
    return { success: true, extensionStatus: status };
  }
  try {
    await applyPendingExternalProcessConfigInvalidation(preservePromotion);
    return { success: true, extensionStatus: getManagedCodexExtensionStatus() };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const extensionStatus = markManagedCodexExtensionFailed(message);
    broadcastManagedCodexExtensionDiagnostics(true);
    return {
      success: false,
      error: message,
      extensionStatus,
    };
  }
}

function pendingDshExtensionStatus(
  snapshot: ManagedCodexExtensionSnapshot,
): RuntimeExtensionDiagnostics {
  return {
    desiredRevision: `myagents-dsh-v2:${snapshot.revision}`,
    effectiveRevision: null,
    state: 'pending_next_start',
    components: snapshot.components.map((component) =>
      component.state === 'applied'
        ? { ...component, state: 'pending_next_start' as const }
        : { ...component },
    ),
  };
}

function failedDshExtensionResult(
  componentName: import('./managed-codex/extensions/contracts').ManagedCodexExtensionComponentKind,
  message: string,
  snapshot?: ManagedCodexExtensionSnapshot,
): ProductExtensionUpdateResult {
  const extensionStatus: RuntimeExtensionDiagnostics = {
    desiredRevision: snapshot ? `myagents-dsh-v2:${snapshot.revision}` : '',
    effectiveRevision: dshExtensionStatus?.effectiveRevision ?? null,
    state: 'failed',
    components: [
      ...(snapshot?.components ?? []),
      {
        component: componentName,
        state: 'failed',
        code: 'dsh_extension_reconcile_failed',
        message,
      },
    ],
  };
  dshExtensionStatus = extensionStatus;
  return {
    success: false,
    error: message,
    extensionStatus,
  };
}

async function reconcileDshExtensionSnapshot(
  componentName: import('./managed-codex/extensions/contracts').ManagedCodexExtensionComponentKind,
  build: () => ManagedCodexExtensionSnapshot = buildCurrentManagedCodexExtensionSnapshot,
): Promise<ProductExtensionUpdateResult> {
  await awaitExternalLifecycleStarting();
  if (!isDshProductRuntime())
    return notApplicableProductExtensionResult(componentName);

  let snapshot: ManagedCodexExtensionSnapshot;
  try {
    snapshot = build();
    dshDesiredExtensionSnapshot = snapshot;
  } catch (error) {
    return failedDshExtensionResult(
      componentName,
      error instanceof Error ? error.message : String(error),
    );
  }
  const pair = getExternalActivePair();
  if (!pair || pair.process.exited) {
    const extensionStatus = pendingDshExtensionStatus(snapshot);
    dshExtensionStatus = extensionStatus;
    return { success: true, extensionStatus };
  }
  if (!pair.runtime.replaceDshExtensions) {
    return failedDshExtensionResult(
      componentName,
      'Integrated DSH adapter does not expose live Product extension replacement',
      snapshot,
    );
  }
  const sessionId = getExternalLifecycleSessionId();
  const workspacePath = getExternalLifecycleWorkspacePath();
  if (!sessionId || !workspacePath) {
    return failedDshExtensionResult(
      componentName,
      'Integrated DSH extension replacement has no Product Session owner',
      snapshot,
    );
  }
  try {
    const attached = await attachProductHostTools({
      snapshot,
      sessionId,
      workspacePath,
    });
    const extensionStatus = await pair.runtime.replaceDshExtensions(
      pair.process,
      attached,
    );
    dshDesiredExtensionSnapshot = attached;
    dshExtensionStatus = extensionStatus;
    return {
      success: extensionStatus.state !== 'failed',
      ...(extensionStatus.state === 'failed'
        ? { error: 'DSH rejected the desired Product extension generation' }
        : {}),
      extensionStatus,
    };
  } catch (error) {
    // Once handed to the adapter, an ambiguously delivered candidate remains
    // adapter-owned so generation-fenced reverse calls cannot lose their Host
    // dispatcher while DSH reconciles or terminates.
    return failedDshExtensionResult(
      componentName,
      error instanceof Error ? error.message : String(error),
      snapshot,
    );
  }
}

async function reconcileProductExtensionSnapshot(
  componentName: import('./managed-codex/extensions/contracts').ManagedCodexExtensionComponentKind,
  build: () => ManagedCodexExtensionSnapshot = buildCurrentManagedCodexExtensionSnapshot,
  preservePromotion?: ExternalTurnPromotionToken | null,
): Promise<ProductExtensionUpdateResult> {
  await awaitExternalLifecycleStarting();
  if (
    (isDshProductRuntime() || isManagedCodexProductRuntime()) &&
    !getExternalLifecycleWorkspacePath()
  ) {
    // The renderer may publish its durable Agent/MCP intent immediately after
    // Sidecar connection, before the first Product Session has bound the
    // workspace owner. Session birth compiles those authoritative sources; the
    // live projection is therefore queued, not a configuration failure.
    return pendingProductExtensionOwnerResult(componentName);
  }
  return isDshProductRuntime()
    ? reconcileDshExtensionSnapshot(componentName, build)
    : reconcileManagedCodexExtensionSnapshot(
        componentName,
        build,
        preservePromotion,
      );
}

export async function handleExternalMcpServersChange(
  servers: readonly import('../../shared/config-types').McpServerDefinition[],
): Promise<ProductExtensionUpdateResult & { servers?: string[] }> {
  if (!isManagedCodexProductRuntime() && !isDshProductRuntime()) {
    const result = notApplicableProductExtensionResult('mcp');
    return { ...result, servers: servers.map((server) => server.id) };
  }
  const requestedIds = [...new Set(servers.map((server) => server.id))];
  await awaitExternalLifecycleStarting();
  const workspacePath = getExternalLifecycleWorkspacePath();
  const sessionId = getExternalLifecycleSessionId();
  if (!workspacePath) {
    return {
      ...pendingProductExtensionOwnerResult('mcp'),
      servers: requestedIds,
    };
  }
  try {
    if (!workspacePath)
      throw new Error('Managed Codex MCP configuration has no workspace owner');
    const metadata = sessionId ? getExternalSessionMetadata(sessionId) : null;
    const authoritative = resolveWorkspaceConfig(workspacePath, metadata, {
      includeMcp: true,
    }).mcpServers;
    const resolvedServers = resolveProductExtensionMcpSelection(
      requestedIds,
      authoritative,
    );
    setProductExtensionSessionMcpServers(resolvedServers);
    const result = await reconcileProductExtensionSnapshot('mcp', () =>
      buildCurrentManagedCodexExtensionSnapshot({
        mcpServers: resolvedServers,
      }),
    );
    return { ...result, servers: requestedIds };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (isDshProductRuntime()) {
      return {
        ...failedDshExtensionResult('mcp', message),
        servers: requestedIds,
      };
    }
    const current = getManagedCodexExtensionStatus();
    const extensionStatus = {
      ...current,
      components: [
        ...current.components,
        {
          component: 'mcp' as const,
          state: 'failed' as const,
          code: 'mcp_selection_rejected',
          message,
        },
      ],
    };
    return {
      success: false,
      error: message,
      extensionStatus,
      servers: requestedIds,
    };
  }
}

export async function handleExternalAgentsChange(): Promise<ProductExtensionUpdateResult> {
  return reconcileProductExtensionSnapshot('agents');
}

export async function handleExternalDesktopInteractionScenarioChange(
  scenario: Extract<InteractionScenario, { type: 'desktop' }>,
): Promise<ProductExtensionUpdateResult> {
  if (!isManagedCodexProductRuntime() && !isDshProductRuntime()) {
    return notApplicableProductExtensionResult('scenario');
  }
  const wasBusy = isExternalTurnBusy();
  const result = await reconcileProductExtensionSnapshot('scenario', () =>
    buildCurrentManagedCodexExtensionSnapshot({ scenario }),
  );
  if (result.success) {
    if (isDshProductRuntime() && wasBusy) {
      dshDesiredInteractionScenario = scenario;
      if (
        (result.extensionStatus.state === 'applied' ||
          result.extensionStatus.state === 'unchanged') &&
        !isExternalTurnBusy()
      ) {
        setExternalLifecycleScenario(scenario);
        dshDesiredInteractionScenario = null;
      }
    } else if (!wasBusy) {
      setExternalLifecycleScenario(scenario);
      dshDesiredInteractionScenario = null;
    }
  }
  return result;
}

export async function handleExternalSessionEnabledPluginsChange(
  enabledIds: readonly string[] | null,
): Promise<ProductExtensionUpdateResult> {
  if (!isManagedCodexProductRuntime() && !isDshProductRuntime()) {
    return notApplicableProductExtensionResult('plugins');
  }
  setProductExtensionSessionEnabledPluginIds(enabledIds);
  return reconcileProductExtensionSnapshot('plugins');
}

export function getProductExtensionConfigSnapshot(): {
  mcpServerIds: string[] | null;
  agentNames: string[] | null;
  enabledPluginIds: string[] | null;
  extensionStatus?: RuntimeExtensionDiagnostics;
  permissionStatus?: RuntimePermissionDiagnostics;
} {
  if (isDshProductRuntime()) {
    const snapshot = dshDesiredExtensionSnapshot;
    return {
      mcpServerIds:
        snapshot?.mcpServers.map((server) => server.id) ??
        getProductExtensionSessionMcpServers()?.map((server) => server.id) ??
        [],
      agentNames: snapshot?.agents.map((agent) => agent.name) ?? [],
      enabledPluginIds:
        snapshot?.enabledPluginIds ??
        getProductExtensionSessionEnabledPluginIds() ??
        [],
      ...(dshExtensionStatus ? { extensionStatus: dshExtensionStatus } : {}),
      ...(dshPermissionStatus ? { permissionStatus: dshPermissionStatus } : {}),
    };
  }
  if (!isManagedCodexProductRuntime()) {
    return {
      mcpServerIds: null,
      agentNames: null,
      enabledPluginIds: null,
    };
  }
  const snapshot = getManagedCodexDesiredSnapshot();
  return {
    mcpServerIds: snapshot?.mcpServers.map((server) => server.id) ?? [],
    agentNames: snapshot?.agents.map((agent) => agent.name) ?? [],
    enabledPluginIds:
      snapshot?.enabledPluginIds ??
      getProductExtensionSessionEnabledPluginIds() ??
      [],
    extensionStatus: getManagedCodexExtensionStatus(),
  };
}

class ExternalRequiredSkillUnavailableError extends Error {
  constructor(skillName: string) {
    super(`External Runtime did not admit required system skill ${skillName}`);
    this.name = 'ExternalRequiredSkillUnavailableError';
  }
}

/** Reject only a dependent Managed Codex operation when native read-back omitted its Skill. */
export async function requireCurrentExternalSkill(
  requirement: SystemSkillAdmissionRequirement,
  admission?: ExternalSkillAdmission,
): Promise<void> {
  const skillName = isProductSystemSkillRequirement(requirement)
    ? assertKnownProductSystemSkillRequirement(requirement).name
    : requirement;
  if (isProductSystemSkillRequirement(requirement)) {
    const admitted =
      admission ??
      buildCurrentExternalSkillAdmission(
        getExternalLifecycleWorkspacePath() ?? '',
      );
    if (admitted.unavailableSkillNames.includes(skillName)) {
      throw new ExternalRequiredSkillUnavailableError(skillName);
    }
    assertProductSystemSkillCandidate(admitted.capabilitySnapshot, requirement);
    if (
      admitted.capabilitySnapshot.integrityRevision !==
      admitted.globalSkillInventory.integrityRevision
    ) {
      throw new Error(
        `external Runtime product Skill ${skillName} inventory is inconsistent`,
      );
    }
    if (getExternalActiveCapabilityRevision() !== admitted.revision) {
      throw new Error(
        `external Runtime inventory changed before product Skill ${skillName} dispatch`,
      );
    }
  }
  // Native loaded-Skill read-back is currently available only for managed
  // Codex. Every external Runtime still passes the product-owned candidate,
  // integrity, and revision admission above before a dependent turn starts.
  if (!isManagedCodexProductRuntime()) return;
  const process = getExternalActiveProcess();
  if (!process?.loadedSkillNames?.includes(skillName)) {
    throw new ExternalRequiredSkillUnavailableError(skillName);
  }
}

export async function handleExternalProxyConfigChange(input: {
  oldManagedProviderKey: string;
  newManagedProviderKey: string;
  oldProcessEnvKey: string;
  newProcessEnvKey: string;
}): Promise<{ success: boolean; error?: string; skipped?: string }> {
  const runtimeSource = getCurrentRuntimeSource();
  const runtimeType = getCurrentRuntimeType();
  const usesManagedProviderProxy =
    runtimeType === 'codex' && runtimeSource === 'managed-provider';
  const usesProcessProxyEnv =
    // Integrated DSH Shell always consumes the general owner. The terminal
    // envPolicy belongs only to external CLI runtimes.
    runtimeType === 'dsh' ||
    (runtimeSource !== 'managed-provider' &&
      (activeExternalEnvPolicy?.proxy ?? 'myagents') === 'myagents');
  const oldKey = usesManagedProviderProxy
    ? input.oldManagedProviderKey
    : input.oldProcessEnvKey;
  const newKey = usesManagedProviderProxy
    ? input.newManagedProviderKey
    : input.newProcessEnvKey;

  if (!usesManagedProviderProxy && !usesProcessProxyEnv) {
    return { success: true, skipped: 'proxy-not-owned-by-myagents' };
  }
  if (oldKey === newKey) {
    return { success: true, skipped: 'unchanged' };
  }
  if (isExternalTurnBusy()) {
    if (!pendingExternalProxyRestart) {
      pendingExternalProxyRestartOriginalKey = oldKey;
    }
    if (newKey === pendingExternalProxyRestartOriginalKey) {
      pendingExternalProxyRestart = false;
      pendingExternalProxyRestartOriginalKey = null;
      console.log(
        '[external-session] External runtime proxy changed back to in-flight value; deferred runtime restart cancelled',
      );
      return { success: true, skipped: 'unchanged-after-defer' };
    }
    pendingExternalProxyRestart = true;
    console.log(
      '[external-session] External runtime proxy changed; deferring runtime restart until current turn completes',
    );
    return { success: true };
  }
  if (hasExternalRuntimeProcess()) {
    if (!pendingExternalProxyRestart) {
      pendingExternalProxyRestartOriginalKey = oldKey;
    }
    pendingExternalProxyRestart = true;
    try {
      await applyPendingExternalProcessConfigInvalidation();
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }
  return { success: true };
}

function officialToolIdSetsEqual(
  left: readonly OfficialToolId[],
  right: readonly OfficialToolId[],
): boolean {
  if (left.length !== right.length) return false;
  const rightSet = new Set(right);
  return left.every((id) => rightSet.has(id));
}

/**
 * Reconcile prompt-affecting official tools against the configuration that
 * actually created the live external process. Replayed renderer hydration is
 * a no-op; a real change restarts only at an idle turn boundary.
 */
export async function handleExternalOfficialToolIdsChange(
  ids: readonly OfficialToolId[] | null,
): Promise<{ success: boolean; error?: string; skipped?: string }> {
  await awaitExternalLifecycleStarting();

  const activeProcess = getExternalActiveProcess();
  if (!activeProcess || activeProcess.exited) {
    pendingExternalOfficialToolsRestart = false;
    return { success: true, skipped: 'no-live-process' };
  }

  const sessionId = getExternalLifecycleSessionId();
  const workspacePath = getExternalLifecycleWorkspacePath();
  const requestedIds = getEffectiveOfficialToolIdsForSession(
    workspacePath,
    sessionId ? getExternalSessionMetadata(sessionId) : null,
    ids,
  );
  const appliedIds = getExternalActiveOfficialToolIds() ?? [];
  if (officialToolIdSetsEqual(appliedIds, requestedIds)) {
    pendingExternalOfficialToolsRestart = false;
    return { success: true, skipped: 'unchanged' };
  }

  if (isExternalTurnBusy()) {
    pendingExternalOfficialToolsRestart = true;
    console.log(
      '[external-session] Official tool prompt changed; deferring runtime restart until current turn completes',
    );
    return { success: true };
  }

  // The prompt belongs to the process that was born with it. Route idle
  // invalidation through the same owner as terminal-boundary invalidation so
  // an unconfirmed stop restores the latch and no later turn can reuse the
  // stale process.
  pendingExternalOfficialToolsRestart = true;
  try {
    await applyPendingExternalProcessConfigInvalidation();
    return { success: true };
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

function normalizeRuntimeSourceForRuntime(
  runtime: RuntimeType,
  runtimeSource: RuntimeSource | undefined,
): RuntimeSource | undefined {
  if (runtime === 'builtin') return undefined;
  return runtimeSource ?? 'system-cli';
}

/**
 * Wait for external session to become idle.
 * Turn idleness is independent from process liveness. Persistent runtimes keep
 * a process alive while pre-warmed or between turns; those states are idle as
 * long as no real turn is in flight. A terminal turn still waits for its
 * transcript finalization before becoming observable as idle.
 * Returns true if completed within timeout, false otherwise.
 */
export async function waitForExternalSessionIdle(
  timeoutMs: number,
  pollMs = 500,
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  // Cross-review 0.2.32 (Codex Critical 1): "idle" for our callers means "the
  // last assistant message is readable" (cron execute-sync, IM heartbeat and
  // memory-update all call getLastExternalAssistantText right after this
  // returns). The flags below only say the runtime EMITTED its terminal event;
  // the assistant push happens inside the fire-and-forget persistTurnResult.
  // So every idle exit additionally waits for finalization to settle, within
  // the caller's remaining deadline (a hung persist → not idle → the caller's
  // existing timeout handling applies, same as a hung turn).
  const finalized = () =>
    waitExternalTurnFinalization(Math.max(1, deadline - Date.now()));
  // A known warm/running process with no turn is immediately idle. When there
  // is no lifecycle evidence at all, retain a brief grace period for callers
  // racing a fire-and-forget startExternalSession invocation before its
  // startingPromise has been installed.
  if (!isExternalLifecycleStarting() && !isExternalTurnBusy()) {
    if (isExternalLifecycleRunning() || getExternalActiveProcess()) {
      return finalized();
    }
    const graceMs = Math.min(200, Math.max(0, deadline - Date.now()));
    if (graceMs > 0) await new Promise((r) => setTimeout(r, graceMs));
    if (!isExternalLifecycleStarting() && !isExternalTurnBusy())
      return finalized();
  }
  while (Date.now() < deadline) {
    const activeProcess = getExternalActiveProcess();
    if (!isExternalLifecycleStarting() && !isExternalTurnBusy())
      return finalized();
    if (!isExternalTurnPromotionInFlight()) {
      if (!isExternalLifecycleRunning() && !activeProcess) return finalized();
      if (activeProcess?.exited) return finalized();
    }
    await new Promise((r) => setTimeout(r, pollMs));
  }
  return false;
}

/**
 * Check if the last external turn completed successfully.
 * Used by cron/heartbeat to avoid reading stale assistant text after a crash.
 */
export function didLastTurnSucceed(): boolean {
  return didExternalLastTurnSucceed();
}

/**
 * Get the last assistant message text from the current session.
 * Used by Cron handler and IM heartbeat to extract response text.
 * Handles both JSON ContentBlock[] and plain text formats.
 */
export function getLastExternalAssistantText(): string {
  return getLastExternalAssistantTextFromTranscript();
}

/**
 * Resolve the agent's envPolicy from disk. Thin wrapper over the shared
 * helper in `env-utils.ts` — kept as a local re-export so existing call
 * sites in this file stay 1-line. See `env-utils.resolveAgentEnvPolicy` for
 * validation contract.
 */
async function resolveAgentEnvPolicy(
  workspacePath: string,
): Promise<import('../../shared/types/runtime').RuntimeEnvPolicy | undefined> {
  const { resolveAgentEnvPolicy: shared } = await import('./env-utils');
  return shared(workspacePath);
}

/**
 * Start an external runtime session.
 * Called instead of the builtin startStreamingSession() when runtime is external.
 */
export async function startExternalSession(options: {
  sessionId: string;
  workspacePath: string;
  initialMessage?: string;
  /** Runtime-facing expansion; transcript/persistence always use initialMessage. */
  initialRuntimeMessage?: string;
  initialImages?: ResolvedImagePayload[];
  model?: string;
  permissionMode?: string;
  /** #324 — NORMALIZED effort level, OR '' = explicit reset to the runtime
   *  default (records over a stale module value); absent = keep module state. */
  reasoningEffort?: string;
  scenario: InteractionScenario;
  analyticsSource?: TurnAnalyticsSource;
  analyticsOrigin?: SessionOrigin;
  birthOrigin?: SessionOrigin;
  resumeSessionId?: string;
  /** Issue #194 — per-agent env policy (proxy: myagents/terminal/direct). */
  envPolicy?: import('../../shared/types/runtime').RuntimeEnvPolicy;
  /** IM-router birth marker; allows first-turn metadata materialization. */
  metadataBirthPending?: boolean;
  /** Internal: false when a per-message snapshot should not overwrite desired last* state. */
  recordConfigState?: boolean;
  dispatchPromotion?: ExternalTurnPromotionToken;
  activityFacts?: SessionActivityTurnFacts;
  turnBinding?: ExternalTurnBindingInput;
  channelDelivery?: TurnChannelDelivery;
  onDispatchAccepted?: () => void;
  messageOperation?: ExternalMessageOperation;
  /** Reuse the exact admission already built at this message boundary. */
  skillAdmission?: ExternalSkillAdmission;
  requiredSystemSkill?: SystemSkillAdmissionRequirement;
}): Promise<void> {
  // Concurrency guard — wait for any in-flight start to finish
  await awaitExternalLifecycleStarting();
  if (isExternalLifecycleRunning()) {
    console.warn(
      '[external-session] Session already running, ignoring start request',
    );
    return;
  }

  // Wrap the body so concurrent callers serialize via startingPromise.
  // startingSessionId is set BEFORE _doStartExternalSession runs so ownership
  // and configuration callers can observe the target while spawn is mid-flight
  // (lastSessionId is written at the session-context-bind step).
  const releaseStarting = beginExternalLifecycleStart(options.sessionId);

  try {
    await _doStartExternalSession(options);
  } finally {
    releaseStarting();
  }
}

/** Internal start implementation — called through concurrency guard above */
async function _doStartExternalSession(options: {
  sessionId: string;
  workspacePath: string;
  initialMessage?: string;
  initialRuntimeMessage?: string;
  initialImages?: ResolvedImagePayload[];
  model?: string;
  permissionMode?: string;
  reasoningEffort?: string;
  scenario: InteractionScenario;
  analyticsSource?: TurnAnalyticsSource;
  analyticsOrigin?: SessionOrigin;
  birthOrigin?: SessionOrigin;
  resumeSessionId?: string;
  envPolicy?: import('../../shared/types/runtime').RuntimeEnvPolicy;
  metadataBirthPending?: boolean;
  recordConfigState?: boolean;
  dispatchPromotion?: ExternalTurnPromotionToken;
  activityFacts?: SessionActivityTurnFacts;
  turnBinding?: ExternalTurnBindingInput;
  channelDelivery?: TurnChannelDelivery;
  onDispatchAccepted?: () => void;
  messageOperation?: ExternalMessageOperation;
  skillAdmission?: ExternalSkillAdmission;
  requiredSystemSkill?: SystemSkillAdmissionRequirement;
}): Promise<void> {
  const runtimeType = getCurrentRuntimeType();
  const runtimeSource = getCurrentRuntimeSource();
  const runtime = getExternalRuntime(runtimeType);
  setExternalActiveRuntime(runtime);
  resetExternalUserRequestedStop();

  // Issue #194 — resolve agent envPolicy from disk if caller didn't pass it
  // explicitly. Most call sites (sendExternalMessage, prewarm) don't have
  // access to the agent config, so doing it here avoids N copies of the lookup.
  const resolvedEnvPolicy =
    options.envPolicy ?? (await resolveAgentEnvPolicy(options.workspacePath));
  activeExternalEnvPolicy = resolvedEnvPolicy;

  // Build system prompt using MyAgents' three-layer architecture.
  // Pass the current runtime so L1 identity text reports the correct CLI
  // (e.g. "OpenAI Codex CLI" instead of the builtin default).
  //
  // cliToolsEnabled: true — teach the AI about `myagents cron …` / `myagents
  // im send-media` / `myagents im wake|channels` via a progressive-disclosure
  // appendix. v0.2.11+ also enables this on the builtin path (agent-session.ts)
  // because the corresponding in-process MCP servers (`cron-tools`, `im-cron`,
  // `im-media`) were retired in favour of the CLI surface — single source of
  // truth across builtin + external runtimes. See
  // prd_0.1.67_external_runtime_cli_skill.md for the original design.
  //
  // Generative-UI widget guidance is universal (no MCP equivalent) and is
  // injected unconditionally for desktop scenarios via buildWidgetSection().
  const existingMetadataAtStart = getExternalSessionMetadata(options.sessionId);
  const enabledOfficialToolIds = getEffectiveOfficialToolIdsForSession(
    options.workspacePath,
    existingMetadataAtStart,
  );
  const systemPromptOptions = {
    runtime: runtimeType,
    cliToolsEnabled: true,
    userCliToolsEnabled: isCliToolRegistryEnabled(),
    enabledOfficialToolIds,
  } as const;
  const baseSystemPrompt =
    runtimeType === 'dsh'
      ? ''
      : buildSystemPromptAppend(options.scenario, systemPromptOptions);
  const dshSystemContext =
    runtimeType === 'dsh'
      ? buildDshSystemContext(
          options.scenario,
          systemPromptOptions,
          resolveDshWorkspaceSupplement(options.workspacePath),
        )
      : undefined;

  // Cross-runtime workspace protocol: append workspace instruction files
  // so external runtimes receive the same project context as the builtin SDK.
  //   - Codex: only .claude/rules/*.md (CLAUDE.md is loaded natively via -c flag)
  //   - Claude Code: no injection needed (reads CLAUDE.md natively)
  const workspaceInstructions =
    runtimeType === 'codex'
      ? resolveCodexWorkspaceInstructions(options.workspacePath)
      : ''; // Claude Code reads workspace guidance natively
  if (workspaceInstructions) {
    console.log(
      `[external-session] Injecting workspace instructions for ${runtimeType} (${workspaceInstructions.length} bytes)`,
    );
  }
  let systemPromptAppend = workspaceInstructions
    ? baseSystemPrompt + '\n\n' + workspaceInstructions
    : baseSystemPrompt;
  systemPromptAppend = appendManagedCodexInteractionLimitPrompt(
    systemPromptAppend,
    runtimeType,
    runtimeSource,
    options.scenario,
  );

  // External runtimes don't go through the SDK's session creation flow, so the
  // "pending-{tabId}" placeholder that the frontend assigns never gets upgraded
  // to a real UUID. A pending-prefixed ID in SessionStore breaks history reload
  // because the frontend's loadSession guard skips any session whose ID starts
  // with "pending-". Fix: mint a real UUID here on the first start (not resume).
  const originalSessionId = options.sessionId;
  if (isPendingSessionId(options.sessionId) && !options.resumeSessionId) {
    const realId = crypto.randomUUID();
    console.log(
      `[external-session] Upgrading pending session ID: ${options.sessionId} → ${realId}`,
    );
    options.sessionId = realId;
    if (options.messageOperation) {
      options.messageOperation.context.sessionId = realId;
    }
    updateExternalLifecycleStartingSessionId(originalSessionId, realId);
  }
  const startModel = coerceExternalRuntimeModel(
    options.model,
    runtimeType,
    options.resumeSessionId ? 'resume-start-options' : 'start-options',
    options.sessionId,
  );
  const startPermissionMode = coerceExternalRuntimePermissionMode(
    options.permissionMode,
    runtimeType,
    options.resumeSessionId ? 'resume-start-options' : 'start-options',
    options.sessionId,
  );
  const startReasoningEffort = coerceExternalRuntimeReasoningEffort(
    options.reasoningEffort,
    runtimeType,
    options.resumeSessionId ? 'resume-start-options' : 'start-options',
    options.sessionId,
  );
  const runtimePermissionMode = shouldUseNonBypassForNativeAskUserQuestion(
    startPermissionMode,
    options.scenario,
  )
    ? runtimeType === 'claude-code'
      ? 'acceptEdits'
      : 'auto'
    : startPermissionMode;

  const managedCodexMcpServers =
    runtimeType === 'codex' && runtimeSource === 'managed-provider'
      ? (getProductExtensionSessionMcpServers() ??
        resolveWorkspaceConfig(options.workspacePath, existingMetadataAtStart, {
          includeMcp: true,
        }).mcpServers)
      : undefined;
  const dshMcpServers =
    runtimeType === 'dsh'
      ? (getProductExtensionSessionMcpServers() ??
        resolveWorkspaceConfig(options.workspacePath, existingMetadataAtStart, {
          includeMcp: true,
        }).mcpServers)
      : undefined;
  const externalSkillAdmission =
    options.skillAdmission ??
    buildCurrentExternalSkillAdmission(options.workspacePath);
  let managedCodexExtensionSnapshot =
    runtimeType === 'codex' && runtimeSource === 'managed-provider'
      ? buildCurrentManagedCodexExtensionSnapshot({
          workspacePath: options.workspacePath,
          scenario: options.scenario,
          mcpServers: managedCodexMcpServers ?? [],
          skillAdmission: externalSkillAdmission,
        })
      : undefined;
  if (managedCodexExtensionSnapshot) {
    managedCodexExtensionSnapshot = await attachProductHostTools({
      snapshot: managedCodexExtensionSnapshot,
      sessionId: options.sessionId,
      workspacePath: options.workspacePath,
    });
    // Codex fixes a dynamic-tool catalog at native thread birth. A resumed
    // Product Session keeps that visibility, but always receives the current
    // dispatcher: stable tools continue to work, while removed or
    // schema-invalid tools fail only their individual call. Newly added tools
    // become visible when a new native thread is created.
    setManagedCodexDesiredSnapshot(
      managedCodexExtensionSnapshot,
      'no-live-process',
    );
  }
  const dshExtensionSnapshot =
    runtimeType === 'dsh'
      ? await attachProductHostTools({
          snapshot: buildCurrentManagedCodexExtensionSnapshot({
            workspacePath: options.workspacePath,
            scenario: options.scenario,
            mcpServers: dshMcpServers ?? [],
            skillAdmission: externalSkillAdmission,
          }),
          sessionId: options.sessionId,
          workspacePath: options.workspacePath,
        })
      : undefined;
  if (dshExtensionSnapshot) dshDesiredExtensionSnapshot = dshExtensionSnapshot;
  if (
    shouldTrackPendingExternalSessionBirth({
      // DSH deliberately starts protocol/session authority before Product root
      // admission, so even an initial-message birth must retain the native id.
      hasInitialMessage: Boolean(
        options.initialMessage && runtimeType !== 'dsh',
      ),
      hasResumeSessionId: Boolean(options.resumeSessionId),
      hasMetadata: Boolean(existingMetadataAtStart),
    })
  ) {
    pendingExternalSessionBirth = {
      sessionId: options.sessionId,
      workspacePath: options.workspacePath,
      scenario: options.scenario,
      runtimeSessionId: pendingBirthForSession(options.sessionId)
        ?.runtimeSessionId,
    };
  } else if (existingMetadataAtStart) {
    clearPendingExternalSessionBirth(options.sessionId);
  }

  console.log(
    `[external-session] Starting ${runtimeType} session for ${options.sessionId}, model=${startModel || '(default)'}, permissionMode=${startPermissionMode || '(default)'}${runtimePermissionMode !== startPermissionMode ? ` -> runtime:${runtimePermissionMode}` : ''}, scenario=${options.scenario.type}, resume=${options.resumeSessionId || 'none'}`,
  );
  // Detect pre-warm: prewarmExternalSession calls us with initialMessage=undefined.
  // Stamp this onto the session_init broadcast so the frontend doesn't enter the
  // "loading" state for a process that hasn't started processing any turn yet.
  setExternalPrewarmingSession(!options.initialMessage);
  setExternalTurnCompleted(false);
  setExternalLastTurnSucceeded(false); // Reset — success only set after turn_complete
  resetTurnAccumulators();
  // Watchdog is per-turn, not per-process. Pre-warm (no initialMessage) leaves
  // the process idle awaiting a user message — starting a timer here would fire
  // a bogus "timed out" toast if the user takes >10 min to type. The real
  // watchdog is armed when the first turn begins (Case 3 in sendExternalMessage,
  // or the initialMessage block below).
  clearExternalTurnStartTime();
  // Track latest desired config for resume. Per-message snapshots (queued
  // message A followed by config B) deliberately opt out so the older message's
  // start options do not overwrite the newer desired state.
  if (options.recordConfigState !== false) {
    applyDesiredExternalRuntimeConfigPatch({
      ...(options.model !== undefined ? { model: startModel ?? '' } : {}),
      ...(options.permissionMode !== undefined
        ? { permissionMode: startPermissionMode ?? '' }
        : {}),
      ...(options.reasoningEffort !== undefined
        ? { reasoningEffort: startReasoningEffort ?? '' }
        : {}),
    });
  }
  // Only clear message history for new sessions, not resumes
  if (!options.resumeSessionId) {
    clearExternalSessionMessages(options.sessionId);
  }

  let turnAdmissionActivated = false;
  const initialOperationGeneration = getExternalOperationGeneration();
  let persistInitialQuestionReply: (() => Promise<void>) | undefined;
  const admitInitialMessage = async (): Promise<string | undefined> => {
    if (!options.initialMessage || turnAdmissionActivated) return;
    const messageOperation = options.messageOperation;
    if (!messageOperation) {
      throw new Error(
        'Initial external message is missing its operation owner',
      );
    }
    assertExternalTurnPromotionCurrent(options.dispatchPromotion ?? null);
    const turnAnalyticsSource =
      options.analyticsSource ?? options.scenario.type;
    const turnAnalyticsOrigin =
      options.analyticsOrigin ??
      originFromTurnAttribution({
        source: turnAnalyticsSource,
        scenarioType: options.scenario.type,
        desktopSurface:
          options.scenario.type === 'desktop'
            ? options.scenario.surface
            : undefined,
      });
    const channelDelivery = options.channelDelivery ?? NO_CHANNEL_DELIVERY;
    const userChannelProjection = projectExternalUserChannelAdmission(
      channelDelivery,
      options.initialMessage,
      options.initialImages,
    );
    const activityFacts = options.activityFacts ?? {
      origin: turnAnalyticsOrigin,
      inputText: options.initialMessage,
      systemMaintenanceKind: getExternalSessionMetadata(options.sessionId)
        ?.systemMaintenanceKind,
    };
    setExternalTurnActivityFacts(activityFacts);
    const admissionActivityAt = shouldRecordAdmissionActivity(activityFacts)
      ? new Date().toISOString()
      : undefined;
    const userMsg = messageOperation.userProjection.message;
    if (!messageOperation.context.asyncQuestionReply) {
    pushExternalSessionMessage(userMsg);
    markExternalUserMessageInTranscript(messageOperation);
    }
    resetTurnAccumulators();
    seedTurnWatchdogEstimate();
    resetWatchdog();
    markExternalTurnStarted();
    beginExternalTurnTrace('external_start_initial_message', options.sessionId);
    if (options.turnBinding) {
      bindExternalTurn(
        options.turnBinding.queueId,
        options.turnBinding.owner,
        options.turnBinding.onTerminal,
      );
    }
    if (!messageOperation.context.asyncQuestionReply) {
    notifyExternalMessageDispatchAccepted(
      messageOperation,
      options.sessionId,
      options.onDispatchAccepted,
    );
    }
    turnAdmissionActivated = true;
    currentTurnAnalyticsSource = turnAnalyticsSource;
    currentTurnAnalyticsOrigin = turnAnalyticsOrigin;
    setExternalSessionState('running');

    // Register session in history index BEFORE the first message persist
    // (mirrors agent-session.ts enqueueUserMessage and the Case-3 pre-warm path).
    // SessionStore enforces the index⟺data invariant (issue #336): a JSONL is
    // never CREATED for a session without a sessions.json entry — persisting
    // first would get the write refused and drop the user's first message.
    const persistInitialMessage = () =>
      persistExternalUserMessageAdmission({
      sessionId: options.sessionId,
      workspacePath: options.workspacePath,
        messageText: messageOperation.text,
      origin: 'initial message',
      scenario: options.scenario,
      turnPath: options.resumeSessionId ? 'resume-start' : 'fresh-start',
      metadataBirthPending: options.metadataBirthPending,
      birthOrigin: options.birthOrigin,
      operation: messageOperation,
      failureContext:
        '[external-session] Failed to persist initial user message',
      lastActiveAt: admissionActivityAt,
      channelDelivery,
      userChannelProjection,
      runtimeImages: options.initialImages,
    });
    if (messageOperation.context.asyncQuestionReply) {
      persistInitialQuestionReply = persistInitialMessage;
    } else {
      await persistInitialMessage();
    }
    assertExternalTurnPromotionCurrent(options.dispatchPromotion ?? null);
    return messageOperation.userProjection.message.id;
  };

  // Set session context BEFORE startSession so that events fired during startup
  // (e.g., Codex's synchronous session_init) can reference lastSessionId for persistence.
  bindExternalSessionContext({
    sessionId: options.sessionId,
    workspacePath: options.workspacePath,
    scenario: options.scenario,
    analyticsSource: options.analyticsSource ?? options.scenario.type,
    analyticsOrigin: options.analyticsOrigin ?? null,
  });
  if (!options.initialMessage) {
    currentTurnAnalyticsSource = null;
    currentTurnAnalyticsOrigin = null;
  }

  // Set isRunning BEFORE spawning — prevents waitForExternalSessionIdle from
  // seeing the pre-start state and returning true prematurely. Reset in catch.
  setExternalLifecycleRunning(true);
  const disallowedTools = getRuntimeAwareChannelInteractionDisallowedTools(
    runtimeType,
    runtimeSource,
    options.scenario,
  );

  let runtimeInitialTurn: RuntimeInitialTurn | undefined;
  let dshProductTail = Promise.resolve();
  let dshProductProjectionFailed = false;
  let dshProductQueuedCount = 0;
  let dshProductQueuedBytes = 0;
  const failDshProductProjection = (error: unknown): void => {
    if (dshProductProjectionFailed) return;
    dshProductProjectionFailed = true;
    console.error(
      '[external-session] DSH Product event projection failed:',
      error,
    );
    startedProcess?.kill();
    setExternalSessionState('error');
    broadcast('chat:agent-error', {
      message: 'Failed to restore DSH collaboration state',
    });
  };
  const receiveRuntimeEvent = (event: UnifiedEvent): void => {
    if (runtimeType !== 'dsh') {
      handleUnifiedEvent(event);
      return;
    }
    if (dshProductProjectionFailed) return;
    const eventBytes = Buffer.byteLength(JSON.stringify(event), 'utf8');
    if (
      dshProductQueuedCount >= 2_048 ||
      dshProductQueuedBytes + eventBytes > 8 * 1024 * 1024
    ) {
      failDshProductProjection(
        new Error('DSH Product event projection exceeded its bounded queue'),
      );
      return;
    }
    dshProductQueuedCount++;
    dshProductQueuedBytes += eventBytes;
    pendingDshProductEvents++;
    dshProductTail = dshProductTail
      .then(async () => {
        if (
          dshProductProjectionFailed ||
          getExternalLifecycleSessionId() !== options.sessionId ||
          (startedProcess &&
            getExternalActivePair()?.process &&
            getExternalActivePair()?.process !== startedProcess)
        )
          return;
        if (
          event.kind === 'root_turn_admitted' &&
          event.origin === 'collaboration'
        ) {
          if (!(await waitExternalTurnFinalization(30_000)))
            throw new Error(
              'DSH collaboration is waiting for the previous Product turn persistence',
            );
        }
        if (event.kind === 'user_message_cancelled') {
          const pending = getSessionMetadata(
            options.sessionId,
          )?.pendingDshInputs?.find(
            (input) => input.clientUserMessageId === event.clientUserMessageId,
          );
          if (pending) {
            const result = await settleDshInput({
              sessionId: options.sessionId,
              clientOperationId: pending.clientOperationId,
              clientUserMessageId: pending.clientUserMessageId,
              state: 'cancelled',
            });
            if (!result.success) throw new Error(result.error);
          }
        }
        handleUnifiedEvent(event);
      })
      .catch(failDshProductProjection)
      .finally(() => {
        pendingDshProductEvents--;
        dshProductQueuedCount--;
        dshProductQueuedBytes -= eventBytes;
      });
  };
  let currentEventReceiver: ((event: UnifiedEvent) => void) | undefined;
  const nativeGeneration = getExternalRuntimeGeneration();
  const startOnce = (resumeId: string | undefined): Promise<RuntimeProcess> => {
    let writer = getActiveSessionTranscript(options.sessionId)?.writer;
    const receive = (event: UnifiedEvent): void => {
      writer ??= getActiveSessionTranscript(options.sessionId)?.writer;
      if (getExternalLifecycleSessionId() !== options.sessionId) return;
      if (
        writer &&
        getActiveSessionTranscript(options.sessionId)?.writer !== writer
      )
        return;
      // An accepted attachment job can finish after the native process exits.
      // Its captured product owner still authorizes an update to that old tool.
      const productAttachment =
        event.kind === 'tool_attachment_update' && writer;
      if (
        !productAttachment &&
        (currentEventReceiver !== receive ||
          getExternalRuntimeGeneration() !== nativeGeneration)
      )
        return;
      receiveRuntimeEvent(event);
    };
    currentEventReceiver = receive;
    return runtime.startSession(
      {
        sessionId: options.sessionId,
        workspacePath: options.workspacePath,
        // Guarded turns split process startup from prompt transport. This lets
        // Stop invalidate the promotion while initialize/resume is still
        // awaiting and before any runtime can consume the prompt.
        initialTurn: runtimeInitialTurn,
        systemPromptAppend,
        ...(dshSystemContext === undefined
          ? {}
          : { systemContext: dshSystemContext }),
        model: startModel,
        providerRoute: runtimeType === 'dsh'
          ? options.messageOperation?.runtimeConfig.providerRoute
          : undefined,
        permissionMode: runtimePermissionMode,
        reasoningEffort: startReasoningEffort,
        scenario: options.scenario,
        resumeSessionId: resumeId,
        disallowedTools,
        envPolicy: resolvedEnvPolicy,
        runtimeSource,
        mcpServers: managedCodexMcpServers,
        managedCodexExtensions: managedCodexExtensionSnapshot,
        dshExtensions: dshExtensionSnapshot,
      },
      receive,
    );
  };

  let startedProcess: RuntimeProcess | null = null;
  let terminalSettledByStop = false;
  try {
    const deferRequiredAdmission = Boolean(
      options.initialMessage &&
        options.dispatchPromotion &&
        options.requiredSystemSkill,
    );
    const deferDshStartupRecoveryAdmission = Boolean(
      options.initialMessage && runtimeType === 'dsh',
    );
    const deferInitialAdmission =
      deferRequiredAdmission || deferDshStartupRecoveryAdmission;
    if (options.initialMessage && !deferInitialAdmission) {
      const clientUserMessageId = await admitInitialMessage();
      if (!options.dispatchPromotion) {
        if (!clientUserMessageId) {
          throw new Error(
            'Initial external message is missing its operation owner',
          );
        }
        runtimeInitialTurn = {
          message: options.initialRuntimeMessage ?? options.initialMessage,
          clientUserMessageId,
          clientOperationId: options.messageOperation?.dshClientOperationId,
          images: options.initialImages,
        };
      }
    }
    let process: RuntimeProcess;
    try {
      assertExternalTurnPromotionCurrent(options.dispatchPromotion ?? null);
      process = await startOnce(options.resumeSessionId);
    } catch (err) {
      // Stale resume recovery (issue #105): the runtime reports our persisted
      // runtimeSessionId is dead (for example, Codex rollout GC or a CLI
      // upgrade). Invalidate both the in-memory pointer and
      // the on-disk metadata, then retry fresh once so the user's message
      // still lands instead of looping on the stale id forever. If the fresh
      // retry also fails, fall through to the normal error surface.
      if (err instanceof StaleRuntimeSessionError && options.resumeSessionId) {
        console.warn(
          `[external-session] ${runtimeType} resume rejected as stale (id=${JSON.stringify(summarizeSensitiveValueForLog(err.runtimeSessionId))}); invalidating and retrying fresh`,
        );
        clearExternalRuntimeSessionId();
        if (options.sessionId) {
          try {
            await updateSessionMetadata(options.sessionId, {
              runtimeSessionId: '',
            });
          } catch (metaErr) {
            console.warn(
              '[external-session] Failed to clear stale runtimeSessionId on disk:',
              metaErr,
            );
          }
        }
        // Also drop any pre-warm birth runtime pointer that belongs to a
        // now-dead resume — letting it survive would re-patch the stale id
        // onto the next metadata registration.
        if (
          pendingExternalSessionBirth?.sessionId === options.sessionId &&
          pendingExternalSessionBirth.runtimeSessionId === err.runtimeSessionId
        ) {
          pendingExternalSessionBirth = {
            ...pendingExternalSessionBirth,
            runtimeSessionId: undefined,
          };
        }
        if (runtimeType === 'codex' && runtimeSource === 'managed-provider') {
          managedCodexExtensionSnapshot = await attachProductHostTools({
            snapshot: buildCurrentManagedCodexExtensionSnapshot({
              workspacePath: options.workspacePath,
              scenario: options.scenario,
              mcpServers: managedCodexMcpServers ?? [],
            }),
            sessionId: options.sessionId,
            workspacePath: options.workspacePath,
          });
          setManagedCodexDesiredSnapshot(
            managedCodexExtensionSnapshot,
            'no-live-process',
          );
        }
        assertExternalTurnPromotionCurrent(options.dispatchPromotion ?? null);
        process = await startOnce(undefined);
        console.log(
          `[external-session] ${runtimeType} recovered via fresh start after stale resume`,
        );
      } else {
        throw err;
      }
    }

    if (process.exited) {
      throw new Error(`${runtimeType} process exited before startup completed`);
    }
    if (process.productTranscriptChangedAtStartup) {
      const recoveredTranscript = await loadSessionTranscript(
        options.sessionId,
      );
      setExternalSessionMessages(
        options.sessionId,
        recoveredTranscript.messages,
        recoveredTranscript.cursor,
      );
      setLastPersistedRuntimeUsageTotals(
        restoreRuntimeUsageTotals(
          runtimeType,
          recoveredTranscript.messages,
          getSessionMetadata(options.sessionId)?.runtimeUsageTotals,
        ),
      );
    }
    startedProcess = process;
    if (dshProductProjectionFailed) {
      process.kill();
      throw new Error('DSH Product event projection failed during startup');
    }
    setExternalActiveProcess(
      process,
      enabledOfficialToolIds,
      externalSkillAdmission.revision,
    );
    if (managedCodexExtensionSnapshot) {
      markManagedCodexExtensionEffective(
        managedCodexExtensionSnapshot,
        process.runtimeGeneration ?? `${runtimeType}:${process.pid}`,
      );
      broadcastManagedCodexExtensionDiagnostics();
    }
    if (
      options.dispatchPromotion &&
      !isExternalTurnPromotionCurrent(options.dispatchPromotion)
    ) {
      throw new ExternalTurnPromotionCanceledError();
    }
    if (options.requiredSystemSkill) {
      await requireCurrentExternalSkill(
        options.requiredSystemSkill,
        externalSkillAdmission,
      );
    }
    let recoveredDshRootInFlight = false;
    if (runtimeType === 'dsh') {
      await waitExternalTurnFinalization(60_000);
      recoveredDshRootInFlight = await resumePendingDshRootOperation(
        runtime,
        process,
      );
      await resumePendingDshInputs(runtime, process, {
        sessionId: options.sessionId,
        workspacePath: options.workspacePath,
        scenario: options.scenario,
        channelDelivery: NO_CHANNEL_DELIVERY,
      });
      await dshProductTail;
    }
    let deferredInitialDispatched = false;
    if (deferInitialAdmission) {
      if (recoveredDshRootInFlight) {
        if (!options.messageOperation) {
          throw new Error(
            'Deferred DSH input is missing its Product operation owner',
          );
        }
        if (options.dispatchPromotion)
          finishExternalTurnPromotion(options.dispatchPromotion);
        enqueueExistingExternalMessageOperation({
          ...options.messageOperation,
          context: {
            ...options.messageOperation.context,
            beforeDispatch: undefined,
          },
          deferredDispatchAccepted: options.onDispatchAccepted,
        });
        setExternalSessionState('running');
        deferredInitialDispatched = true;
      } else {
        const clientUserMessageId = await admitInitialMessage();
        if (!clientUserMessageId) {
          throw new Error(
            'Deferred DSH input is missing its Product user identity',
          );
        }
        if (options.dispatchPromotion) {
          assertExternalTurnPromotionCurrent(options.dispatchPromotion);
          finishExternalTurnPromotion(options.dispatchPromotion, {
            status: 'dispatched',
          });
        }
        await runtime.sendMessage(
          process,
          options.initialRuntimeMessage ?? options.initialMessage!,
          options.initialImages,
          {
            clientUserMessageId,
            clientOperationId: options.messageOperation?.dshClientOperationId,
          },
        );
        deferredInitialDispatched = true;
      }
    }
    if (
      options.dispatchPromotion &&
      options.initialMessage &&
      !deferredInitialDispatched
    ) {
      assertExternalTurnPromotionCurrent(options.dispatchPromotion);
      if (process.exited || getExternalActiveProcess() !== process) return;
      finishExternalTurnPromotion(options.dispatchPromotion, {
        status: 'dispatched',
      });
      await runtime.sendMessage(
        process,
        options.initialRuntimeMessage ?? options.initialMessage,
        options.initialImages,
        {
          clientUserMessageId:
            options.messageOperation?.userProjection.message.id,
          clientOperationId: options.messageOperation?.dshClientOperationId,
        },
      );
      if (options.messageOperation && persistInitialQuestionReply) {
        await admitExternalAsyncQuestionReply(
          options.messageOperation,
          initialOperationGeneration,
          options.onDispatchAccepted,
          persistInitialQuestionReply,
        );
      }
    }
    console.log(
      `[external-session] ${runtimeType} process started, pid=${process.pid}`,
    );
  } catch (err) {
    const failure =
      options.dispatchPromotion?.signal.aborted &&
      !(err instanceof ExternalTurnPromotionCanceledError)
        ? new ExternalTurnPromotionCanceledError()
        : err;
    if (failure instanceof ExternalRequiredSkillUnavailableError) {
      if (options.dispatchPromotion) {
        finishExternalTurnPromotion(options.dispatchPromotion, {
          status: 'not-dispatched',
        });
      }
      clearWatchdog();
      clearExternalTurnStartTime();
      resetTurnAccumulators();
      clearExternalTurnTrace();
      setExternalTurnCompleted(true);
      setExternalSessionState('idle');
      throw failure;
    }
    if (
      startedProcess &&
      !startedProcess.exited &&
      getExternalActiveProcess() === startedProcess
    ) {
      const stopped = await stopExternalSession({
        reason: failure instanceof ExternalTurnPromotionCanceledError ? 'user' : 'failure',
        preserveQueue:
          failure instanceof ExternalTurnPromotionCanceledError
            ? options.dispatchPromotion?.preserveQueueOnCancel === true
            : true,
      });
      terminalSettledByStop = stopped;
      if (!stopped && hasExternalRuntimeProcess()) {
        console.error(
          `[external-session] Failed to confirm ${runtimeType} termination after guarded start failure`,
        );
        if (options.turnBinding) {
          bindExternalTurn(
            options.turnBinding.queueId,
            options.turnBinding.owner,
            options.turnBinding.onTerminal,
          );
        }
        if (options.dispatchPromotion) {
          finishExternalTurnPromotion(options.dispatchPromotion, {
            status: 'termination-unconfirmed',
          });
        }
        throw new ExternalDispatchTerminationUnconfirmedError(failure);
      }
    }
    const activeAfterFailure = getExternalActiveProcess();
    if (!activeAfterFailure || activeAfterFailure.exited) {
      clearExternalActiveRuntimeProcess();
      activeExternalEnvPolicy = undefined;
      clearWatchdog();
    }
    if (options.dispatchPromotion && !turnAdmissionActivated) {
      finishExternalTurnPromotion(options.dispatchPromotion, {
        status: startedProcess ? 'terminated' : 'not-dispatched',
      });
    }
    const settledByConcurrentTerminal =
      turnAdmissionActivated &&
      !terminalSettledByStop &&
      (getExternalUserRequestedStop() ||
        isExternalTurnGenerationCurrent(getExternalTurnTerminalGeneration()) ||
        (options.turnBinding !== undefined &&
          !isExternalTurnCurrent(options.turnBinding.queueId)));
    if (settledByConcurrentTerminal) {
      if (options.dispatchPromotion) {
        finishExternalTurnPromotion(options.dispatchPromotion, {
          status: startedProcess ? 'terminated' : 'not-dispatched',
        });
      }
      return;
    }
    const resumeGuidance = runtimeType === 'dsh' && options.resumeSessionId
      && (options.scenario.type === 'im' || options.scenario.type === 'agent-channel')
      && options.scenario.sourceType === 'private' && !(failure instanceof ExternalTurnPromotionCanceledError);
    const rawMessage = failure instanceof Error ? failure.message : String(failure);
    const message = resumeGuidance ? formatImResumeFailure(rawMessage) : rawMessage;
    if (managedCodexExtensionSnapshot) {
      markManagedCodexExtensionFailed(message);
      broadcastManagedCodexExtensionDiagnostics(true);
    }
    if (!(failure instanceof ExternalTurnPromotionCanceledError)) {
      console.error(
        `[external-session] Failed to start ${runtimeType}:`,
        message,
      );
    }
    // Pre-warm failures are silent — the user didn't ask for this optimization
    // and shouldn't see an error toast for it. The next real user message will
    // retry via the normal send path; if that also fails, the error surfaces
    // there with full context (which runtime, which sessionId, etc).
    if (
      turnAdmissionActivated &&
      !(failure instanceof ExternalTurnPromotionCanceledError) &&
      !terminalSettledByStop
    ) {
      finalizeAcceptedExternalFailure(message);
      clearWatchdog();
      clearExternalTurnStartTime();
      resetTurnAccumulators();
      clearExternalTurnTrace();
      setExternalSessionState('error');
      broadcast('chat:agent-error', {
        message: `Failed to start ${runtimeType}: ${message}`,
      });
    }
    if (options.dispatchPromotion && turnAdmissionActivated) {
      finishExternalTurnPromotion(options.dispatchPromotion, {
        status: startedProcess ? 'terminated' : 'not-dispatched',
      });
    }
    // Re-throw so the HTTP handler returns an error response
    throw resumeGuidance ? new Error(message, { cause: failure }) : failure;
  }
}

/**
 * Send a user message via external runtime.
 * Handles three cases:
 * 1. No previous session → start a new one (first message)
 * 2. Previous process exited → resume with --resume (CC -p mode multi-turn)
 * 3. Process still running → send via stdin (shouldn't happen in -p mode)
 *
 * Modality scope (V1): the model-input-modality filter (see
 * `agent-session.ts::enqueueUserMessage` + `model-capabilities.ts::modelSupportsModality`)
 * lives only on the builtin Claude Agent SDK path. External runtimes (Claude
 * Code CLI / Codex) pass `images` through unfiltered here.
 * Rationale:
 *   - Each external runtime has its own modality contract (Codex blocks
 *     images, CC CLI accepts images).
 *   - External runtime models aren't in MyAgents' PRESET_PROVIDERS registry,
 *     so `lookupModelCapability` would return undefined → optimistic
 *     default-allow → effectively no filter, just runtime overhead.
 *   - The frontend toast in `SimpleChatInput` is gated behind
 *     `!isExternalRuntime` to keep UX honest (no false "will be filtered"
 *     promises on runtimes that pass images through).
 * If you ever wire modality lookups for external-runtime models, add the
 * filter here and lift the frontend gate.
 */
/**
 * #324 — resolve the effort to pass into startExternalSession for this turn.
 * Context-present = authoritative (raw setting; 'default' normalizes to ''
 * which startExternalSession records as "explicit default" and runtimes
 * treat as "omit the knob"). Context-absent = desktop / unmanaged → module
 * state (set by /api/reasoning-effort/set or snapshot restore).
 */
function resolveTurnReasoningEffort(
  context: ExternalSendContext | undefined,
): string | undefined {
  if (context?.reasoningEffort !== undefined) {
    return (
      coerceExternalRuntimeReasoningEffort(
        context.reasoningEffort,
        getCurrentRuntimeType(),
        'turn-context',
        context.sessionId,
      ) ?? ''
    );
  }
  return getExternalRuntimeDesiredReasoningEffort() || undefined;
}

async function evaluateExternalDispatchGuard(
  guard: ExternalSendContext['beforeDispatch'],
): Promise<{ accepted: true } | { accepted: false; error: string }> {
  if (!guard) return { accepted: true };
  try {
    const result = await guard();
    return result.accepted
      ? { accepted: true }
      : {
          accepted: false,
          error: result.error ?? result.code ?? 'Goal admission is stale',
        };
  } catch (error) {
    return {
      accepted: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

class ExternalTurnPromotionCanceledError extends Error {
  constructor() {
    super('External turn promotion was canceled before runtime dispatch');
    this.name = 'ExternalTurnPromotionCanceledError';
  }
}

class ExternalDispatchTerminationUnconfirmedError extends Error {
  constructor(error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    super(
      `${message}; external runtime process termination could not be confirmed`,
    );
    this.name = 'ExternalDispatchTerminationUnconfirmedError';
  }
}

function assertExternalTurnPromotionCurrent(
  token: ExternalTurnPromotionToken | null,
): void {
  if (token && !isExternalTurnPromotionCurrent(token)) {
    throw new ExternalTurnPromotionCanceledError();
  }
}

async function awaitDuringExternalTurnPromotion<T>(
  promise: Promise<T>,
  token: ExternalTurnPromotionToken | null,
): Promise<{ canceled: true } | { canceled: false; value: T }> {
  if (!token) return { canceled: false, value: await promise };
  if (token.signal.aborted) return { canceled: true };

  let onAbort!: () => void;
  const canceled = new Promise<{ canceled: true }>((resolve) => {
    onAbort = () => resolve({ canceled: true });
    token.signal.addEventListener('abort', onAbort, { once: true });
  });
  try {
    return await Promise.race([
      promise.then((value) => ({ canceled: false as const, value })),
      canceled,
    ]);
  } finally {
    token.signal.removeEventListener('abort', onAbort);
  }
}

async function runExternalMessageOperation(
  text: string,
  images: ImagePayload[] | undefined,
  permissionMode: string | undefined,
  model: string | undefined,
  context: ExternalSendContext | undefined,
  operation: ExternalMessageOperation,
  onDispatchAccepted: (() => void) | undefined,
  generation?: number,
): Promise<ExternalSendResult> {
  return withExternalMessageOperation(operation, async () => {
    try {
      const dispatch = () =>
        dispatchExternalMessageOperation(
          text,
          images,
          permissionMode,
          model,
          context,
          operation,
          onDispatchAccepted,
        );
      const result = await (generation === undefined
        ? dispatch()
        : chainExternalSend(dispatch, generation));
      if (!result.queued && !result.terminationUnconfirmed) {
        await retractRejectedExternalUserMessage(operation);
      }
      return result;
    } catch (error) {
      await retractRejectedExternalUserMessage(operation);
      throw error;
    }
  }).then(
    (result) => {
      settleExternalMessageOperation(operation, result);
      return result;
    },
    (error) => {
      settleExternalMessageOperation(operation, {
        queued: false,
        error: error instanceof Error ? error.message : String(error),
  });
      throw error;
    },
  );
}

export async function sendExternalMessage(
  text: string,
  images?: ImagePayload[],
  permissionMode?: string,
  model?: string,
  context?: ExternalSendContext,
  operation?: ExternalMessageOperation,
  onDispatchAccepted?: () => void,
): Promise<ExternalSendResult> {
  const operationContext = context ?? {
    sessionId: getExternalLifecycleSessionId(),
    workspacePath: getExternalLifecycleWorkspacePath(),
    scenario: getExternalLifecycleScenario(),
    channelDelivery: NO_CHANNEL_DELIVERY,
  };
  const messageOperation =
    operation ??
    createExternalMessageOperation({
      text,
      images,
      context: operationContext,
      runtimeConfig: context
        ? captureExternalRuntimeConfigSnapshot(model, permissionMode, context)
        : {
            model,
            permissionMode,
            reasoningEffort: resolveTurnReasoningEffort(undefined),
          },
      userMessage: createExternalUserMessage(
        text,
        images,
        operationContext.sessionId,
      ),
    });
  return runExternalMessageOperation(
    text,
    images,
    permissionMode,
    model,
    context,
    messageOperation,
    onDispatchAccepted,
    getExternalOperationGeneration(),
  );
}

async function dispatchExternalMessageOperation(
  text: string,
  images: ImagePayload[] | undefined,
  _permissionMode: string | undefined,
  _model: string | undefined,
  context: ExternalSendContext | undefined,
  operation: ExternalMessageOperation,
  onDispatchAccepted: (() => void) | undefined,
): Promise<ExternalSendResult> {
  const hasInputImages = images && images.length > 0;
  if (hasInputImages && !context?.sessionId) {
    return { queued: false, error: '图片附件缺少会话上下文，无法发送' };
  }
  let resolvedImages: ResolvedImagePayload[] | undefined;
  try {
    resolvedImages = context?.sessionId
      ? resolveImagePayloads(context.sessionId, images)
      : undefined;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(
      '[external-session] failed to resolve image attachments:',
      err,
    );
    return { queued: false, error: message };
  }
  const hasImages = resolvedImages && resolvedImages.length > 0;
  const turnAnalyticsSource =
    context?.analyticsSource ??
    context?.scenario.type ??
    getExternalLifecycleAnalyticsSource();
  const turnAnalyticsOrigin =
    context?.analyticsOrigin ??
    originFromTurnAttribution({
      source: turnAnalyticsSource,
      scenarioType:
        context?.scenario.type ?? getExternalLifecycleScenario().type,
      desktopSurface:
        context?.scenario.type === 'desktop'
          ? context.scenario.surface
          : undefined,
      inboxMeta: context?.inboxMeta,
    });
  const userAttachments =
    operation.userProjection.message.attachments ??
    sessionMessageAttachmentsFromImages(context?.sessionId, images);
  if (userAttachments && !operation.userProjection.message.attachments) {
    operation.userProjection.message.attachments = userAttachments;
  }

  // Show ordinary user messages immediately. Guarded Goal messages stay local
  // until their final admission check succeeds, so a stale scheduler/user turn
  // cannot leak into UI or history while waiting for a turn boundary.
  // The message appears in the chat as soon as the user presses send, giving
  // responsive feedback even when the runtime takes 10-15s to cold-start.
  // The operation is the request-scoped projection owner. Idle desktop sends
  // may already have surfaced it synchronously; other unguarded ingress paths
  // surface here, while guarded turns wait until final admission.
  const preBroadcasted = operation.userProjection.surfaced;
  if (!context?.beforeDispatch) {
    surfaceExternalUserMessageAsReplay(
      operation,
      context?.sessionId ?? getExternalLifecycleSessionId(),
    );
  }

  // The promotion is the pre-dispatch identity for guarded Task/Goal turns.
  // Bind it before any lifecycle/busy wait so an exact queueId stop can cancel
  // this pending send without stopping the unrelated turn currently running.
  let dispatchPromotion = context?.beforeDispatch
    ? beginExternalTurnPromotion({
        queueId: context.queueId,
        owner: context.turnOwner,
        cancelDispatch: context.beforeDispatch.cancel,
      })
    : null;
  if (context?.beforeDispatch && !dispatchPromotion) {
    return {
      queued: false,
      error: 'external_busy: another turn is being promoted',
    };
  }
  const canceledBeforeDispatch = (): { queued: false } => {
    if (dispatchPromotion) finishExternalTurnPromotion(dispatchPromotion);
    return { queued: false };
  };
  const ensureInitialDispatchPromotion = (): boolean => {
    if (dispatchPromotion) return true;
    dispatchPromotion = beginExternalTurnPromotion({
      queueId: context?.queueId,
      owner: context?.turnOwner,
    });
    return dispatchPromotion !== null;
  };

  // If a pre-warm (or other concurrent start) is still bringing the process
  // up, wait for it to finish before deciding which case to take. Without
  // this await, a user-send racing an in-flight pre-warm would see
  // `isRunning=true` but `activeProcess=null` — falling into Case 2's resume
  // path, which calls startExternalSession again, which then hits the
  // `if (isRunning) return` early-exit and silently drops the user's message.
  const lifecycleReady = await awaitDuringExternalTurnPromotion(
    awaitExternalLifecycleStarting(),
    dispatchPromotion,
  );
  if (lifecycleReady.canceled) return canceledBeforeDispatch();

  // Serialize against any in-flight turn. Persistent-process runtimes (Codex
  // app-server) accept one turn at a time — dispatching a
  // second user message while the first is still running can cause silent
  // drops or interleaved output. `turnCompleted=false && currentTurnStartTime
  // !== 0` means a previous user turn kicked off and hasn't finished. On
  // crash, session_complete resets currentTurnStartTime via
  // resetTurnAccumulators(), so this gate doesn't spuriously trip.
  //
  // Issue #188 — if the busy turn doesn't settle within the cap, do NOT fall
  // through to Case 3 and dispatch into a still-running runtime. That used to
  // silently drop the message (or interleave with the active turn). Return a
  // queue-style error so the caller can surface it to the user.
  const busyProcess = getExternalActiveProcess();
  if (
    !isExternalTurnCompleted() &&
    getExternalTurnStartTime() !== 0 &&
    busyProcess &&
    !busyProcess.exited
  ) {
    const idleWait = await awaitDuringExternalTurnPromotion(
      waitForExternalSessionIdle(5 * 60 * 1000, 100),
      dispatchPromotion,
    );
    if (idleWait.canceled) return canceledBeforeDispatch();
    const settled = idleWait.value;
    if (!settled) {
      if (dispatchPromotion) finishExternalTurnPromotion(dispatchPromotion);
      // PRD 0.2.18 — busy reject BEFORE binding meta, so no leak risk here.
      // Caller (if inbox) gets a single signal via queued:false → drain handler
      // surfaces the error code; no need to also push a reply (cross-review CC:
      // double-signal causes duplicate / contradictory caller feedback).
      return {
        queued: false,
        error:
          'external_busy: 上一个回合超过 5 分钟未完成，消息未发送，请稍后重试。',
      };
    }
  }

  // Cross-review 0.2.32 (Codex Critical 2): the busy gate above is SKIPPED the
  // moment turnCompleted flips true — but the previous turn's fire-and-forget
  // persistTurnResult may still be inside its await window. Proceeding now
  // would push this turn's user message ahead of the previous assistant
  // message (history order inversion) and run resetTurnAccumulators() under
  // the persist's feet, wiping the content blocks it still has to read — the
  // previous assistant reply would vanish from history/disk. Wait (bounded)
  // for finalization; on a pathological hang, proceed degraded rather than
  // blocking the user's send forever — persistTurnResult snapshots EVERY
  // turn-scoped field (inbox meta, hints, context usage, content blocks,
  // assistant text) before its first await and only resets accumulators it
  // still owns, so the worst case is a stale-ordering write, not message
  // loss (cross-review 0.2.33, Codex W1 closed the content-blocks gap).
  if (isExternalTurnFinalizationInFlight()) {
    const finalizationWait = await awaitDuringExternalTurnPromotion(
      waitExternalTurnFinalization(60_000),
      dispatchPromotion,
    );
    if (finalizationWait.canceled) return canceledBeforeDispatch();
    const settled = finalizationWait.value;
    if (!settled) {
      console.warn(
        '[external-session] previous turn finalization still in flight after 60s — proceeding with send (degraded ordering)',
      );
    }
  }

  const terminalObserverWait = await awaitDuringExternalTurnPromotion(
    waitForExternalTurnTerminalObserver(),
    dispatchPromotion,
  );
  if (terminalObserverWait.canceled) return canceledBeforeDispatch();

  const guardWait = await awaitDuringExternalTurnPromotion(
    evaluateExternalDispatchGuard(context?.beforeDispatch),
    dispatchPromotion,
  );
  if (guardWait.canceled) return canceledBeforeDispatch();
  const guarded = guardWait.value;
  if (!guarded.accepted) {
    if (dispatchPromotion) finishExternalTurnPromotion(dispatchPromotion);
    return { queued: false, error: guarded.error };
  }
  if (dispatchPromotion && !isExternalTurnPromotionCurrent(dispatchPromotion)) {
    return canceledBeforeDispatch();
  }

  let runtimeText = text;
  let skillAdmission: ExternalSkillAdmission;
  try {
    const workspacePath =
      context?.workspacePath ??
      operation.context.workspacePath ??
      getExternalLifecycleWorkspacePath();
    if (!workspacePath)
      throw new Error(
        'External Runtime Skill admission has no workspace owner',
      );
    skillAdmission = buildCurrentExternalSkillAdmission(workspacePath);
  } catch (error) {
    if (dispatchPromotion) finishExternalTurnPromotion(dispatchPromotion);
    return {
      queued: false,
      error: `Workspace capabilities are unavailable: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
  if (isManagedCodexProductRuntime()) {
    const extensionResult = await reconcileManagedCodexExtensionSnapshot(
      'commands',
      () =>
        buildCurrentManagedCodexExtensionSnapshot({
          scenario: context?.scenario ?? getExternalLifecycleScenario(),
          skillAdmission,
        }),
      dispatchPromotion,
    );
    if (!extensionResult.success) {
      if (dispatchPromotion) finishExternalTurnPromotion(dispatchPromotion);
      return {
        queued: false,
        error:
          extensionResult.error ??
          'Managed Codex extension reconciliation failed',
      };
    }
    const snapshot = getManagedCodexDesiredSnapshot();
    if (!snapshot) {
      if (dispatchPromotion) finishExternalTurnPromotion(dispatchPromotion);
      return {
        queued: false,
        error: 'Managed Codex extension snapshot is unavailable',
      };
    }
    try {
      runtimeText =
        compileManagedCodexCommand(text, snapshot)?.runtimeText ?? text;
    } catch (error) {
      if (dispatchPromotion) finishExternalTurnPromotion(dispatchPromotion);
      return {
        queued: false,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }

  // A previous config change may have reached a terminal boundary while the
  // old process could not be stopped. Never let a later send silently reuse
  // that invalid prompt/env owner: retry invalidation before selecting Case 3.
  if (
    externalProcessConfigInvalidationInFlight ||
    pendingExternalProcessConfigRestartReasons().length > 0
  ) {
    try {
      await applyPendingExternalProcessConfigInvalidation();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (dispatchPromotion) finishExternalTurnPromotion(dispatchPromotion);
      return {
        queued: false,
        error: `${message}; stale external runtime was not reused`,
      };
    }
    if (
      dispatchPromotion &&
      !isExternalTurnPromotionCurrent(dispatchPromotion)
    ) {
      return canceledBeforeDispatch();
    }
  }
  // Transfer ownership atomically from config invalidation to this turn before
  // the next await. A config update that starts first is awaited above; one
  // that starts after this claim observes a busy promotion and is deferred to
  // the turn boundary. Case 3 hands the claim to lifecycle state='running'
  // synchronously before its first persistence await.
  if (!ensureInitialDispatchPromotion()) {
    return {
      queued: false,
      error: 'external_busy: another turn is being promoted',
    };
  }
  const admittedProcess = getExternalActiveProcess();
  if (
    context?.requiredSystemSkill &&
    admittedProcess &&
    !admittedProcess.exited
  ) {
    try {
      await requireCurrentExternalSkill(
        context.requiredSystemSkill,
        skillAdmission,
      );
    } catch (error) {
      if (dispatchPromotion) finishExternalTurnPromotion(dispatchPromotion);
      return {
        queued: false,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }
  const activitySessionId =
    context?.sessionId ?? getExternalLifecycleSessionId();
  const activityFacts: SessionActivityTurnFacts = {
    origin: turnAnalyticsOrigin,
    inputText: text,
    systemMaintenanceKind:
      getExternalSessionMetadata(activitySessionId)?.systemMaintenanceKind,
  };

  // PRD 0.2.18 Session Inbox — bind per-turn inbox meta + reset attachment hints
  // accumulator now that we know this turn is going to run. (After the busy
  // check, before kicking the runtime.) Cleared at persistTurnResult finally
  // OR via clearExternalInboxMetaOnRejection() below when sendExternalMessage rejects
  // before persistTurnResult ever runs.
  setExternalTurnInboxMeta(context?.inboxMeta ?? null);
  resetExternalTurnAttachmentHints();

  // Pattern B — set the active IM trace ID *after* the previous turn has
  // settled. Setting it earlier (pre-fix) caused tail deltas/complete events
  // from the running turn A to be tagged with turn B's requestId during the
  // wait window, mis-routing them to the wrong IM subscriber and breaking
  // cancellation attribution. session-end (session_complete /
  // stopExternalSession) clears it again. No-op when context.requestId is
  // undefined (desktop / cron paths).
  if (context?.requestId) {
    setExternalActiveRequestId(context.requestId);
  }
  emitPerfTrace({
    trace: 'turn',
    phase: 'enqueue',
    sessionId:
      context?.sessionId || getExternalLifecycleSessionId() || undefined,
    requestId: context?.requestId || getExternalActiveRequestId() || undefined,
    runtime: getCurrentRuntimeType(),
    status: 'ok',
    sizeBytes: Buffer.byteLength(text, 'utf8'),
    count: hasImages ? images?.length : 0,
    detail: {
      source: turnAnalyticsSource,
      hasImages: Boolean(hasInputImages),
      preBroadcasted: Boolean(preBroadcasted),
    },
  });

  // Case 1: No previous session — start fresh
  if (!getExternalRuntimeSessionId() && !isExternalLifecycleRunning()) {
    if (!context) {
      if (dispatchPromotion) finishExternalTurnPromotion(dispatchPromotion);
      clearExternalInboxMetaOnRejection({
        sessionId: getExternalLifecycleSessionId(),
        errorCode: 'no_context',
        errorMessage: 'No session context for first message',
      });
      return { queued: false, error: 'No session context for first message' };
    }
    if (!ensureInitialDispatchPromotion()) {
      clearExternalInboxMetaOnRejection({
        sessionId: context.sessionId,
        errorCode: 'external_busy',
        errorMessage: 'Another external turn is being promoted',
      });
      return {
        queued: false,
        error: 'external_busy: another turn is being promoted',
      };
    }
    try {
      await startExternalSession({
        sessionId: context.sessionId,
        workspacePath: context.workspacePath,
        initialMessage: text,
        initialRuntimeMessage: runtimeText,
        initialImages: hasImages ? resolvedImages : undefined,
        model: context.model ?? getExternalRuntimeDesiredModel(),
        permissionMode:
          context.permissionMode ?? getExternalRuntimeDesiredPermissionMode(),
        reasoningEffort: resolveTurnReasoningEffort(context),
        scenario: context.scenario,
        analyticsSource: turnAnalyticsSource,
        analyticsOrigin: turnAnalyticsOrigin,
        birthOrigin: context.birthOrigin,
        metadataBirthPending: context.metadataBirthPending,
        recordConfigState: !hasQueuedExternalConfigOperation(),
        dispatchPromotion: dispatchPromotion ?? undefined,
        activityFacts,
        turnBinding: context.queueId
          ? {
              queueId: context.queueId,
              owner: context.turnOwner,
              onTerminal: context.onTerminal,
            }
          : undefined,
        channelDelivery: context.channelDelivery,
        onDispatchAccepted,
        messageOperation: operation,
        skillAdmission,
        requiredSystemSkill: context.requiredSystemSkill,
      });
      return {
        queued:
          !operation.context.asyncQuestionReply ||
          operation.userProjection.surfaced,
      };
    } catch (err) {
      if (dispatchPromotion) finishExternalTurnPromotion(dispatchPromotion);
      if (err instanceof ExternalTurnPromotionCanceledError)
        return { queued: false };
      if (err instanceof ExternalDispatchTerminationUnconfirmedError) {
        return {
          queued: false,
          error: err.message,
          terminationUnconfirmed: true,
        };
      }
      const msg = err instanceof Error ? err.message : String(err);
      clearExternalInboxMetaOnRejection({
        sessionId: getExternalLifecycleSessionId(),
        errorCode: 'start_failed',
        errorMessage: msg,
      });
      return { queued: false, error: msg };
    }
  }

  // Case 2: Previous process exited — resume (CC -p mode multi-turn)
  const activeProcess = getExternalActiveProcess();
  if (!activeProcess || activeProcess.exited) {
    // CC supports custom session IDs (--session-id) — resume with our MyAgents session ID.
    // Codex doesn't support custom IDs — resume with Codex's own threadId (lastRuntimeSessionId).
    const runtimeType = getCurrentRuntimeType();
    const lifecycleSessionId = getExternalLifecycleSessionId();
    const resumeId =
      runtimeType === 'claude-code'
        ? lifecycleSessionId
        : getExternalRuntimeSessionId();
    const nextScenario = context?.scenario ?? getExternalLifecycleScenario();
    const nextModel = context?.model ?? getExternalRuntimeDesiredModel();
    const nextPermissionMode =
      context?.permissionMode ?? getExternalRuntimeDesiredPermissionMode();
    console.log(
      `[external-session] Previous process exited, resuming ${runtimeType} session ${JSON.stringify(summarizeSensitiveValueForLog(resumeId))}`,
    );
    if (!ensureInitialDispatchPromotion()) {
      clearExternalInboxMetaOnRejection({
        sessionId: lifecycleSessionId,
        errorCode: 'external_busy',
        errorMessage: 'Another external turn is being promoted',
      });
      return {
        queued: false,
        error: 'external_busy: another turn is being promoted',
      };
    }
    try {
      await startExternalSession({
        sessionId: lifecycleSessionId,
        workspacePath: getExternalLifecycleWorkspacePath(),
        initialMessage: text,
        initialRuntimeMessage: runtimeText,
        initialImages: hasImages ? resolvedImages : undefined,
        model: nextModel,
        permissionMode: nextPermissionMode,
        reasoningEffort: resolveTurnReasoningEffort(context), // #324
        scenario: nextScenario,
        analyticsSource: turnAnalyticsSource,
        analyticsOrigin: turnAnalyticsOrigin,
        birthOrigin: context?.birthOrigin,
        resumeSessionId: resumeId, // CC: --resume <myagents-session-id>; Codex: --resume <threadId>
        metadataBirthPending: context?.metadataBirthPending,
        recordConfigState: !hasQueuedExternalConfigOperation(),
        dispatchPromotion: dispatchPromotion ?? undefined,
        activityFacts,
        turnBinding: context?.queueId
          ? {
              queueId: context.queueId,
              owner: context.turnOwner,
              onTerminal: context.onTerminal,
            }
          : undefined,
        channelDelivery: context?.channelDelivery,
        onDispatchAccepted,
        messageOperation: operation,
        skillAdmission,
        requiredSystemSkill: context?.requiredSystemSkill,
      });
      return {
        queued:
          !operation.context.asyncQuestionReply ||
          operation.userProjection.surfaced,
      };
    } catch (err) {
      if (dispatchPromotion) finishExternalTurnPromotion(dispatchPromotion);
      if (err instanceof ExternalTurnPromotionCanceledError)
        return { queued: false };
      if (err instanceof ExternalDispatchTerminationUnconfirmedError) {
        return {
          queued: false,
          error: err.message,
          terminationUnconfirmed: true,
        };
      }
      const msg = err instanceof Error ? err.message : String(err);
      clearExternalInboxMetaOnRejection({
        sessionId: getExternalLifecycleSessionId(),
        errorCode: 'resume_failed',
        errorMessage: msg,
      });
      return { queued: false, error: msg };
    }
  }

  // Case 3: Process still running — send via runtime.sendMessage
  // This is the normal path for persistent-process runtimes like Codex app-server.
  const activeRuntime = getExternalActiveRuntime();
  if (!activeRuntime) {
    if (dispatchPromotion) finishExternalTurnPromotion(dispatchPromotion);
    clearExternalInboxMetaOnRejection({
      sessionId: getExternalLifecycleSessionId(),
      errorCode: 'no_runtime',
      errorMessage: 'No active runtime',
    });
    if (dispatchPromotion) setExternalSessionState('idle');
    return { queued: false, error: 'No active runtime' };
  }
  let runtimeDispatchStarted = false;
  let turnAdmissionActivated = false;
  const operationGeneration = getExternalOperationGeneration();
  try {
    assertExternalTurnPromotionCurrent(dispatchPromotion);
    const applyResult = await applyExternalRuntimeConfigToActiveProcess(
      normalizeExternalRuntimeConfigPatch(
        {
          model: _model ?? context?.model ?? getExternalRuntimeDesiredModel(),
          permissionMode:
            _permissionMode ??
            context?.permissionMode ??
            getExternalRuntimeDesiredPermissionMode(),
          reasoningEffort: resolveTurnReasoningEffort(context),
        },
        'message-snapshot',
        getCurrentRuntimeType(),
        getExternalLifecycleSessionId() || context?.sessionId || '',
      ),
      'message-snapshot',
    );
    if (applyResult.error) {
      if (dispatchPromotion) finishExternalTurnPromotion(dispatchPromotion);
      clearExternalInboxMetaOnRejection({
        sessionId: getExternalLifecycleSessionId(),
        errorCode: 'config_apply_failed',
        errorMessage: applyResult.error,
      });
      setExternalSessionState('idle');
      return { queued: false, error: applyResult.error };
    }
    assertExternalTurnPromotionCurrent(dispatchPromotion);
    const userMsg = operation.userProjection.message;
    setExternalTurnActivityFacts(activityFacts);
    const admissionActivityAt = shouldRecordAdmissionActivity(activityFacts)
      ? new Date().toISOString()
      : undefined;
    if (!operation.context.asyncQuestionReply) {
    pushExternalSessionMessage(userMsg);
    markExternalUserMessageInTranscript(operation);
    }
    setExternalTurnCompleted(false);
    setExternalLastTurnSucceeded(false); // Reset for this turn (prevents stale text on failure)
    resetTurnAccumulators();
    const channelDelivery = context?.channelDelivery ?? NO_CHANNEL_DELIVERY;
    const userChannelProjection = projectExternalUserChannelAdmission(
      channelDelivery,
      text,
      resolvedImages,
    );
    currentTurnAnalyticsSource = turnAnalyticsSource;
    currentTurnAnalyticsOrigin = turnAnalyticsOrigin;
    setExternalLifecycleAnalyticsSource(turnAnalyticsSource);
    setExternalLifecycleAnalyticsOrigin(turnAnalyticsOrigin);
    seedTurnWatchdogEstimate();
    resetWatchdog(); // Start watchdog for this turn (Case 3 bypasses startExternalSession)
    markExternalTurnStarted();
    beginExternalTurnTrace(
      'external_send_message',
      getExternalLifecycleSessionId(),
    );
    if (context?.queueId) {
      bindExternalTurn(context.queueId, context.turnOwner, context.onTerminal);
    }
    if (dispatchPromotion) {
      finishExternalTurnPromotion(dispatchPromotion, { status: 'dispatched' });
    }
    if (!operation.context.asyncQuestionReply) {
    notifyExternalMessageDispatchAccepted(
      operation,
      getExternalLifecycleSessionId(),
      onDispatchAccepted,
    );
    }
    turnAdmissionActivated = true;
    setExternalSessionState('running');

    // First real user turn clears the pre-warm marker. Also strip it from the
    // cached system_init payload so SSE reconnect replay reflects the current
    // "actually processing a turn" state, not the stale "alive but idle" hint.
    clearExternalPrewarmingSession();

    // Register session metadata on first real message of a pre-warmed session.
    // Normally this happens inside startExternalSession's initialMessage block,
    // but pre-warm calls startExternalSession WITHOUT an initialMessage, so we
    // have to register here when the first actual message arrives via Case 3.
    const persistUserMessage = () =>
      persistExternalUserMessageAdmission({
        sessionId: operation.context.sessionId,
      workspacePath: getExternalLifecycleWorkspacePath(),
      messageText: text,
      origin: 'first message after pre-warm',
      scenario: getExternalLifecycleScenario(),
      turnPath: 'active-process',
      metadataBirthPending: context?.metadataBirthPending,
      birthOrigin: context?.birthOrigin,
      operation,
      failureContext:
        '[external-session] Failed to persist active-process user message',
      lastActiveAt: admissionActivityAt,
      channelDelivery,
      userChannelProjection,
      runtimeImages: resolvedImages,
    });
    if (!operation.context.asyncQuestionReply) await persistUserMessage();
    if (activeProcess.exited || getExternalActiveProcess() !== activeProcess) {
      return { queued: !operation.context.asyncQuestionReply };
    }
    runtimeDispatchStarted = true;
    await activeRuntime.sendMessage(
      activeProcess,
      runtimeText,
      hasImages ? resolvedImages : undefined,
      {
        clientUserMessageId: userMsg.id,
        clientOperationId: operation.dshClientOperationId,
      },
    );
    if (operation.context.asyncQuestionReply) {
      await admitExternalAsyncQuestionReply(
        operation,
        operationGeneration,
        onDispatchAccepted,
        persistUserMessage,
      );
    }
    return {
      queued:
        !operation.context.asyncQuestionReply ||
        operation.userProjection.surfaced,
    };
  } catch (err) {
    if (
      !runtimeDispatchStarted &&
      turnAdmissionActivated &&
      (getExternalUserRequestedStop() ||
        getExternalActiveProcess() !== activeProcess)
    ) {
      return {
        queued:
          !operation.context.asyncQuestionReply ||
          operation.userProjection.surfaced,
      };
    }
    if (err instanceof ExternalTurnPromotionCanceledError) {
      if (dispatchPromotion) finishExternalTurnPromotion(dispatchPromotion);
      return { queued: false };
    }
    const msg = err instanceof Error ? err.message : String(err);
    if (runtimeDispatchStarted) {
      const stopped = await stopExternalSession({ reason: 'failure', preserveQueue: true });
      if (!stopped && hasExternalRuntimeProcess()) {
        if (dispatchPromotion) {
          finishExternalTurnPromotion(dispatchPromotion, {
            status: 'termination-unconfirmed',
          });
        }
        return {
          queued: false,
          error: `${msg}; external runtime process termination could not be confirmed`,
          terminationUnconfirmed: true,
        };
      }
      if (dispatchPromotion) {
        finishExternalTurnPromotion(dispatchPromotion, {
          status: 'terminated',
        });
      }
    } else if (turnAdmissionActivated) {
      finalizeAcceptedExternalFailure(msg);
      clearWatchdog();
      clearExternalTurnStartTime();
      resetTurnAccumulators();
      clearExternalTurnTrace();
      setExternalSessionState('error');
    } else if (dispatchPromotion) {
      finishExternalTurnPromotion(dispatchPromotion);
      clearExternalTurnActivityFacts(activityFacts);
    } else if (!runtimeDispatchStarted) {
      if (context?.queueId) clearExternalTurnBinding(context.queueId);
      clearExternalTurnActivityFacts(activityFacts);
    }
    clearExternalInboxMetaOnRejection({
      sessionId: getExternalLifecycleSessionId(),
      errorCode: 'send_failed',
      errorMessage: msg,
    });
    return { queued: false, error: msg };
  }
}

type ExternalRealtimeSteerDispatch = {
  result: ExternalSendResult;
  deferredDispatchAcceptance?: Promise<ExternalSendResult>;
};

async function steerExternalMessage(input: {
  queueId: string;
  text: string;
  images?: ImagePayload[];
  context: ExternalSendContext;
  operation: ExternalMessageOperation;
  generation: number;
}): Promise<ExternalRealtimeSteerDispatch> {
  const userMsg = input.operation.userProjection.message;
  const active = getExternalActiveSteerPair();
  if (!active) {
    return deferRealtimeOperationToTurnBoundary(input);
  }

  let resolvedImages: ResolvedImagePayload[] | undefined;
  try {
    resolvedImages = resolveImagePayloads(
      input.context.sessionId,
      input.images,
    );
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(
      '[external-session] failed to resolve realtime steer image attachments:',
      err,
    );
    broadcast('queue:cancelled', { queueId: input.queueId });
    return { result: { queued: false, error: message } };
  }

  const guarded = await evaluateExternalDispatchGuard(
    input.context.beforeDispatch,
  );
  if (!guarded.accepted) {
    broadcast('queue:cancelled', { queueId: input.queueId });
    return { result: { queued: false, error: guarded.error } };
  }

  const steerOrigin =
    input.context.analyticsOrigin ??
    originFromTurnAttribution({
      source: input.context.analyticsSource ?? input.context.scenario.type,
      scenarioType: input.context.scenario.type,
      desktopSurface:
        input.context.scenario.type === 'desktop'
          ? input.context.scenario.surface
          : undefined,
      inboxMeta: input.context.inboxMeta,
    });
  if (getCurrentRuntimeType() === 'dsh') {
    const owner = active.runtime.getActiveRootOperation?.(active.process);
    const runtimeSessionId = getSessionMetadata(
      input.context.sessionId,
    )?.runtimeSessionId;
    if (!owner || !runtimeSessionId)
      return {
        result: {
          queued: false,
          error: 'DSH realtime input lost its native operation owner',
        },
      };
    userMsg.runtimeOperationAnchor = {
      runtime: 'dsh',
      runtimeSessionId,
      clientOperationId: owner.clientOperationId,
    };
  }
  const admission = Promise.withResolvers<void>();
  let dshIntentPersisted = false;
  void admission.promise.catch(() => undefined);
  registerPendingRealtimeSteeredUserMessage({
    queueId: input.queueId,
    sessionId: input.context.sessionId,
    operation: input.operation,
    text: input.text,
    activityFacts: {
      origin: steerOrigin,
      inputText: input.text,
      systemMaintenanceKind: getSessionMetadata(input.context.sessionId)
        ?.systemMaintenanceKind,
    },
    channelDelivery: input.context.channelDelivery,
    userChannelProjection: projectExternalUserChannelAdmission(
      input.context.channelDelivery,
      input.text,
      resolvedImages,
    ),
    admission: admission.promise,
    steerAcknowledged: false,
    executionTurnId: getExternalExecutionTurnId() ?? undefined,
  });
  try {
    await active.runtime.steerMessage(
      active.process,
      input.text,
      resolvedImages && resolvedImages.length > 0 ? resolvedImages : undefined,
      {
        clientUserMessageId: userMsg.id,
        ...(userMsg.runtimeOperationAnchor?.runtime === 'dsh'
          ? {
              clientOperationId:
                userMsg.runtimeOperationAnchor.clientOperationId,
              beforeDispatch: async (identity: {
                clientOperationId: string;
                inputFingerprint: string;
              }) => {
                const anchor = userMsg.runtimeOperationAnchor!;
                if (identity.clientOperationId !== anchor.clientOperationId)
                  throw new Error(
                    'DSH realtime input changed its Product operation owner',
                  );
                const intent = await beginDshInput({
                  sessionId: input.context.sessionId,
                  runtimeSessionId: anchor.runtimeSessionId,
                  clientOperationId: anchor.clientOperationId,
                  queueId: input.queueId,
                  userMessage: userMsg,
                  productImageSha256: (resolvedImages ?? []).map((image) =>
                    createHash('sha256')
                      .update(Buffer.from(image.data, 'base64'))
                      .digest('hex'),
                  ),
                  runtimeInputFingerprint: identity.inputFingerprint,
                });
                if (!intent.success) throw new Error(intent.error);
                dshIntentPersisted = true;
              },
            }
          : {}),
      },
    );
    admission.resolve();
    if (
      getCurrentRuntimeType() !== 'dsh' &&
      acknowledgePendingRealtimeSteeredUserMessage(userMsg.id) &&
      isExternalTurnCompleted()
    ) {
      await waitExternalTurnFinalization(60_000);
      const unconfirmed = takePendingRealtimeSteeredUserMessage(userMsg.id);
      if (unconfirmed)
        await finalizeUnconfirmedRealtimeSteeredUserMessage(unconfirmed);
    }
    return { result: { queued: true } };
  } catch (err) {
    admission.reject(err);
    if (input.operation.userProjection.inTranscript) return { result: { queued: true } };
    if (isRuntimeSteerUnavailableError(err)) {
      if (dshIntentPersisted) {
        const anchor = userMsg.runtimeOperationAnchor!;
        const settled = await settleDshInput({ sessionId: input.context.sessionId,
          clientOperationId: anchor.clientOperationId, clientUserMessageId: userMsg.id, state: 'cancelled' });
        if (!settled.success) {
          console.warn('[external-session] definite DSH rejection awaits intent settlement:', settled.error);
          return { result: { queued: true } };
        }
      }
      forgetPendingRealtimeSteeredUserMessage(userMsg.id);
      return deferRealtimeOperationToTurnBoundary(input);
    }
    const message = err instanceof Error ? err.message : String(err);
    if (dshIntentPersisted) {
      console.warn(
        '[external-session] DSH realtime input awaits native receipt reconciliation',
      );
      broadcast('chat:agent-error', {
        message:
          '消息已保存，正在等待 Runtime 确认；重新连接后会核对原消息状态。',
      });
      return { result: { queued: true } };
    }
    console.warn(
      `[external-session] realtime steer failed, retracting user message ${userMsg.id}: ${message}`,
    );
    forgetPendingRealtimeSteeredUserMessage(userMsg.id);
    markExternalUserMessageRetracted(input.operation);
    broadcast('queue:cancelled', { queueId: input.queueId });
    return { result: { queued: false, error: message } };
  }
}

function deferRealtimeOperationToTurnBoundary(input: {
  queueId: string;
  text: string;
  operation: ExternalMessageOperation;
  generation: number;
}): ExternalRealtimeSteerDispatch {
  input.operation.deliveryMode = 'turn';
  const queued = enqueueExistingExternalMessageOperation(
    input.operation,
    input.generation,
  );
  broadcast('queue:added', {
    queueId: input.queueId,
    messageText: visibleDesktopMirrorText(input.text).slice(0, 100),
    agentMentions: input.operation.context.desktopQuery?.agentMentions, primaryContext: desktopContextOf(input.operation.context.desktopQuery?.primaryContext),
    asyncQuestionReply: input.operation.context.asyncQuestionReply,
    isInFlight: false,
    deliveryMode: 'turn',
    canCancel: true,
    canForceExecute: true,
  });
  return {
    result: { queued: true },
    deferredDispatchAcceptance: queued.dispatchAcceptance,
  };
}

/**
 * Desktop /chat/send entry — fire-and-forget dispatch with proper serialization.
 *
 * Issue #188:
 *   sendExternalMessage internally awaits waitForExternalSessionIdle(5*60s)
 *   to serialize against an in-flight turn. The Rust SSE proxy's overall HTTP
 *   timeout is 120s, so directly awaiting sendExternalMessage from the HTTP
 *   handler made the request die with the proxy's generic "操作超时" error,
 *   which the renderer surfaced as "AI 调用失败：网络错误". This helper
 *   decouples the HTTP response from runtime dispatch:
 *
 *   1. Return a queue id synchronously so the renderer can show/reconcile a
 *      queue pill while dispatch happens outside the HTTP request lifetime.
 *   2. Chain the actual sendExternalMessage onto a module-level promise tail
 *      so concurrent desktop sends serialize against each other. Without this
 *      tail, multiple sends would all wake from the same turnCompleted gate
 *      simultaneously and double-write to the persistent-runtime stdin.
 *   3. Realtime Codex steering still promotes the pill only after Codex emits
 *      its native userMessage echo; turn/steer RPC success is transport ack,
 *      not runtime-consumption ack.
 *   4. Return the dispatch promise. Callers should fire-and-forget and
 *      surface failures via chat:agent-error since the HTTP response is
 *      already on its way back to the renderer.
 */
export function enqueueExternalTurnBoundaryOperation(
  text: string,
  images: ImagePayload[] | undefined,
  permissionMode: string | undefined,
  model: string | undefined,
  context: ExternalSendContext,
): ReturnType<typeof enqueueExternalQueuedMessage> {
  return enqueueExternalQueuedMessage(text, images, permissionMode, model, context);
}

function enqueueExternalQueuedMessage(
  text: string,
  images: ImagePayload[] | undefined,
  permissionMode: string | undefined,
  model: string | undefined,
  context: ExternalSendContext,
  deliveryMode: 'realtime' | 'turn' = 'turn',
  inputSource?: 'desktop' | 'inbox',
): {
  queued: boolean;
  queueId?: string;
  userMessageId: string;
  dispatch: Promise<ExternalSendResult>;
} {
  const runtimeConfig = captureExternalRuntimeConfigSnapshot(
    model,
    permissionMode,
    context,
  );
  let cancelled = false;
  const precedingGuard = context.beforeDispatch;
  const queueDispatchGuard = Object.assign(
    async () => {
      if (cancelled) {
        return {
          accepted: false,
          error: 'external_queue_cancelled_before_dispatch',
        };
      }
      const result = precedingGuard
        ? await precedingGuard()
        : { accepted: true as const };
      return cancelled
        ? { accepted: false, error: 'external_queue_cancelled_before_dispatch' }
        : result;
    },
    {
      cancel: () => {
        cancelled = true;
        return precedingGuard?.cancel?.();
      },
    },
  );
  const userMessage = createExternalUserMessage(
    text,
    images,
    context.sessionId,
  );
  const queued = enqueueExternalMessageOperation({
    text,
    images,
    context: applySnapshotToExternalSendContext(
      {
        ...context,
        beforeDispatch: queueDispatchGuard,
      },
      runtimeConfig,
    ),
    runtimeConfig,
    userMessage,
    surfaceMode: 'queue-started',
    deliveryMode,
    inputSource,
    queueId: context.queueId,
  });
  if (!queued.queued) {
    return {
      queued: false,
      userMessageId: userMessage.id,
      dispatch: Promise.resolve({ queued: false, error: queued.error }),
    };
  }
  broadcast('queue:added', {
    queueId: queued.queueId,
    messageText: visibleDesktopMirrorText(text).slice(0, 100),
    agentMentions: context.desktopQuery?.agentMentions, primaryContext: desktopContextOf(context.desktopQuery?.primaryContext),
    asyncQuestionReply: context.asyncQuestionReply,
    isInFlight: false,
    deliveryMode,
    canCancel: true,
    canForceExecute: true,
  });
  void ensureQueuedDshRootRecovery().catch(() => undefined);
  scheduleExternalQueueDrainAfterDirectAdmission();
  return {
    queued: true,
    queueId: queued.queueId,
    userMessageId: userMessage.id,
    dispatch: queued.dispatchAcceptance,
  };
}

function pendingQueuedDshRootRecoveryContext(): Readonly<{
  sessionId: string;
  workspacePath: string;
  scenario: InteractionScenario;
}> | null {
  if (getCurrentRuntimeType() !== 'dsh' || hasExternalRuntimeProcess())
    return null;
  const sessionId = getExternalLifecycleSessionId();
  const workspacePath = getExternalLifecycleWorkspacePath();
  if (!sessionId || !workspacePath) return null;
  const metadata = getSessionMetadata(sessionId);
  if (!metadata?.pendingDshRootOperation && !metadata?.pendingDshInputs?.length)
    return null;
  return { sessionId, workspacePath, scenario: getExternalLifecycleScenario() };
}

function ensureQueuedDshRootRecovery(): Promise<void> {
  // Startup can expose the process before the recovered operation is restored.
  // Join its owner before interpreting process presence as recovery completion.
  if (queuedDshRootRecovery?.sessionId === getExternalLifecycleSessionId()) {
    return queuedDshRootRecovery.promise;
  }
  const context = pendingQueuedDshRootRecoveryContext();
  if (!context) return Promise.resolve();

  const generation = getExternalOperationGeneration();
  const recovery = (async () => {
    await awaitExternalLifecycleStarting();
    const current = pendingQueuedDshRootRecoveryContext();
    if (!current || current.sessionId !== context.sessionId) {
      scheduleExternalQueueDrainAfterTurnBoundary();
      return;
    }
    const result = await prewarmExternalSession(current);
    if (
      !result.prewarmed &&
      pendingQueuedDshRootRecoveryContext()?.sessionId === context.sessionId
    ) {
      throw new Error(result.reason ?? 'DSH recovery did not start');
    }
    if (
      getExternalLifecycleSessionId() === context.sessionId &&
      isCurrentExternalOperationGeneration(generation)
    ) {
      scheduleExternalQueueDrainAfterTurnBoundary();
    }
  })()
    .catch((error) => {
      const message =
        'DSH root operation recovery failed before queued dispatch';
      console.error(
        `[external-session] ${message}:`,
        summarizeExternalRuntimeMessageForLog(error),
      );
      if (
        getExternalLifecycleSessionId() === context.sessionId &&
        isCurrentExternalOperationGeneration(generation)
      ) {
        broadcast('chat:agent-error', { message });
        clearExternalQueueWithCancellation('failed', message);
        setExternalSessionState('idle');
      }
      throw new Error(message, { cause: error });
    })
    .finally(() => {
      if (queuedDshRootRecovery?.promise === recovery) {
        queuedDshRootRecovery = null;
      }
    });
  queuedDshRootRecovery = Object.freeze({
    sessionId: context.sessionId,
    promise: recovery,
  });
  return recovery;
}

/** Validate at ingress and again at the existing dispatch gate after queue waits. */
export async function validateExternalAsyncQuestionReply(
  sessionId: string,
  reply: AsyncQuestionReply,
  ownQueueId?: string,
): Promise<string | undefined> {
  const generation = getExternalOperationGeneration();
  const persisted = await loadSessionTranscript(sessionId);
  if (generation !== getExternalOperationGeneration())
    return 'The question session has changed.';
  const live = getExternalLiveSessionSnapshot(sessionId);
  const messages = [...persisted.messages, ...(live?.inMemoryMessages ?? [])];
  const contents = [
    ...messages
      .filter((message) => message.role === 'assistant')
      .map((message) => message.content),
    live?.liveStreamingMessage?.content,
  ];
  const question = contents
    .flatMap(asyncQuestionSetsInContent)
    .find((set) => set.id === reply.questionId)?.questions[reply.questionIndex];
  if (!question) return 'This question is no longer available in this session.';
  if (
    messages.some(
      (message) =>
        message.role === 'user' &&
        sameAsyncQuestionReply(message.asyncQuestionReply, reply),
    )
  ) {
    return 'This question has already been answered.';
  }
  const pending = [
    ...getExternalPendingMessageOperations(),
    ...pendingRealtimeSteeredUserMessages.map((entry) => entry.operation),
  ];
  const ownOrder = pending.find(
    (operation) => operation.queueId === ownQueueId,
  )?.admissionOrder;
  if (
    pending.some(
      (operation) =>
        (ownOrder === undefined || operation.admissionOrder < ownOrder) &&
        operation.queueId !== ownQueueId &&
        operation.context.sessionId === sessionId &&
        !operation.userProjection.retracted &&
        sameAsyncQuestionReply(operation.context.asyncQuestionReply, reply),
    )
  ) {
    return 'An answer to this question is already waiting to be sent.';
  }
}

/** Inbox timing is independent of desktop settings; the original queue owns admission. */
export function enqueueExternalSendForInbox(
  text: string, context: ExternalSendContext,
): ReturnType<typeof enqueueExternalQueuedMessage> {
  return enqueueExternalQueuedMessage(text, undefined, undefined, undefined, context, 'realtime', 'inbox');
}

export function enqueueExternalSendForDesktop(
  text: string,
  images: ImagePayload[] | undefined,
  permissionMode: string | undefined,
  model: string | undefined,
  context: ExternalSendContext,
): {
  queued: boolean;
  queueId?: string;
  isInFlight?: boolean;
  deliveryMode?: 'realtime' | 'turn';
  canCancel?: boolean;
  canForceExecute?: boolean;
  userMessageId: string;
  dispatch: Promise<ExternalSendResult>;
} {
  if (context.asyncQuestionReply) {
    const reply = context.asyncQuestionReply;
    const sessionId = context.sessionId;
    const queueId = context.queueId ?? nextExternalQueueId();
    const preceding = context.beforeDispatch;
    const guard = Object.assign(
      async () => {
        const prior = preceding
          ? await preceding()
          : { accepted: true as const };
        if (!prior.accepted) return prior;
        const error = await validateExternalAsyncQuestionReply(
          sessionId,
          reply,
          queueId,
        );
        return error ? { accepted: false, error } : { accepted: true as const };
      },
      { cancel: () => preceding?.cancel?.() },
    );
    context = { ...context, queueId, beforeDispatch: guard };
  }
  const queueResponseMode = context.turnBoundaryOnly
    ? 'turn'
    : resolveChatQueueResponseMode(
        loadAdminConfig().chatQueueResponseMode,
        true,
      );
  const lifecycleState = getExternalLifecycleState();
  const canSteerActiveTurn = getExternalActiveSteerPair() !== null;
  const pendingDshRootBlocksAdmission =
    Boolean(getPendingDshRootOperation()) && !canSteerActiveTurn;
  // Mid-turn defer: turn-level external runtimes hold this as a queue pill
  // instead of starting a 2nd turn. Codex app-server can append to the active
  // turn via turn/steer, but only in realtime mode and only when no earlier
  // queued work would be jumped. An idle lifecycle does not override an older
  // direct admission that is still resolving; later Desktop input queues just
  // like IM so it cannot overtake that owner.
  // Return the queueId SYNCHRONOUSLY so /chat/send can hand it back to the renderer, which
  // reconciles its optimistic `opt-` pill with this real queueId (exactly like the builtin
  // path) — without it the optimistic pill would orphan + a stray bubble would appear.
  if (
    externalSessionMutationInFlight ||
    hasPendingDshMutation() ||
    pendingDshRootBlocksAdmission ||
    (context.asyncQuestionReply && lifecycleState === 'idle') ||
    (lifecycleState === 'idle' && hasExternalSendInFlight()) ||
    shouldQueueExternalOperation(lifecycleState, {
      responseMode: queueResponseMode,
      canSteerActiveTurn,
    })
  ) {
    const queued = enqueueExternalQueuedMessage(
      text,
      images,
      permissionMode,
      model,
      context,
    );
    if (!queued.queued || !queued.queueId) return queued;
    scheduleExternalQueueDrainAfterDirectAdmission();
    return {
      queued: true,
      queueId: queued.queueId,
      deliveryMode: 'turn',
      canCancel: true,
      canForceExecute: true,
      userMessageId: queued.userMessageId,
      dispatch: queued.dispatch,
    };
  }

  if (queueResponseMode === 'realtime' && canSteerActiveTurn) {
    const queueId = context.queueId ?? nextExternalQueueId();
    const runtimeConfig = captureExternalRuntimeConfigSnapshot(
      model,
      permissionMode,
      context,
    );
    const sendContext = applySnapshotToExternalSendContext(
      { ...context, queueId },
      runtimeConfig,
    );
    const operation = createExternalMessageOperation({
      text,
      images,
      context: sendContext,
      runtimeConfig,
      userMessage: createExternalUserMessage(text, images, context.sessionId),
      surfaceMode: 'queue-started',
      deliveryMode: 'realtime',
      inputSource: 'desktop',
      queueId,
    });
    broadcast('queue:added', {
      queueId,
      messageText: visibleDesktopMirrorText(text).slice(0, 100),
    agentMentions: context.desktopQuery?.agentMentions, primaryContext: desktopContextOf(context.desktopQuery?.primaryContext),
      asyncQuestionReply: context.asyncQuestionReply,
      isInFlight: true,
      deliveryMode: 'realtime',
      canCancel: false,
      canForceExecute: false,
    });
    const generation = getExternalOperationGeneration();
    const dispatch = withExternalMessageOperation(operation, () =>
      chainExternalSend(
      () =>
        steerExternalMessage({
          queueId,
          text,
          images,
          context: sendContext,
          operation,
          generation,
        }),
      generation,
      ),
    )
      .then(
        ({ result, deferredDispatchAcceptance }) => {
          scheduleExternalQueueDrainAfterDirectAdmission();
          return deferredDispatchAcceptance ?? result;
        },
        (error) => {
          scheduleExternalQueueDrainAfterDirectAdmission();
          throw error;
        },
      )
      .catch((err) => {
        markExternalUserMessageRetracted(operation);
        if (isExternalQueueGenerationStaleError(err)) {
          return { queued: false };
        }
        throw err;
      });
    return {
      queued: true,
      queueId,
      isInFlight: true,
      deliveryMode: 'realtime',
      canCancel: false,
      canForceExecute: false,
      userMessageId: operation.userProjection.message.id,
      dispatch,
    };
  }

  // Idle path: surface + send immediately (unchanged behavior). No queueId — this becomes a
  // bubble, not a pill (the renderer only created an optimistic pill while streaming).
  const runtimeConfig = captureExternalRuntimeConfigSnapshot(
    model,
    permissionMode,
    context,
  );
  const sendContext = applySnapshotToExternalSendContext(
    { ...context, queueId: context.queueId ?? nextExternalQueueId() },
    runtimeConfig,
  );
  const operation = createExternalMessageOperation({
    text,
    images,
    context: sendContext,
    runtimeConfig,
    userMessage: createExternalUserMessage(text, images, context.sessionId),
    surfaceMode: context.asyncQuestionReply ? 'queue-started' : 'chat-replay',
  });
  if (context.asyncQuestionReply) {
    broadcast('queue:added', { queueId: operation.queueId, messageText: visibleDesktopMirrorText(text).slice(0, 100),
    agentMentions: context.desktopQuery?.agentMentions, primaryContext: desktopContextOf(context.desktopQuery?.primaryContext),
      asyncQuestionReply: context.asyncQuestionReply, isInFlight: true, deliveryMode: 'turn', canCancel: false, canForceExecute: false });
  }
  const generation = getExternalOperationGeneration();
  const dispatch = runExternalMessageOperation(
    text,
    images,
    runtimeConfig.permissionMode,
    runtimeConfig.model,
    sendContext,
    operation,
    context.asyncQuestionReply
      ? () =>
          broadcast('queue:started', {
            queueId: operation.queueId,
            sessionId: context.sessionId,
            userMessage: operation.userProjection.message,
          })
      : undefined,
    generation,
  )
    .then((result) => {
      if (!result.queued && context.asyncQuestionReply)
        broadcast('queue:cancelled', { queueId: operation.queueId });
      return result;
    })
    .catch((err) => {
      if (context.asyncQuestionReply)
        broadcast('queue:cancelled', { queueId: operation.queueId });
      if (isExternalQueueGenerationStaleError(err)) {
        return { queued: false };
      }
      throw err;
    })
    .finally(scheduleExternalQueueDrainAfterDirectAdmission);
  if (!context.beforeDispatch) {
    surfaceExternalUserMessageAsReplay(operation, context.sessionId);
  }
  return {
    queued: true,
    userMessageId: operation.userProjection.message.id,
    dispatch,
    ...(context.asyncQuestionReply
      ? {
          queueId: operation.queueId,
          isInFlight: true,
          deliveryMode: 'turn' as const,
          canCancel: false,
          canForceExecute: false,
        }
      : {}),
  };
}

/**
 * External IM admission follows the same turn-boundary queue as Desktop, but
 * never steers into the active turn. A busy request returns as soon as this
 * owner has accepted the operation; its request-scoped terminal remains bound
 * to the queued context until the drain starts or rejects it.
 */
export function enqueueExternalSendForIm(
  text: string,
  images: ImagePayload[] | undefined,
  context: ExternalSendContext,
): {
  queued: boolean;
  queueId?: string;
  userMessageId: string;
  dispatch: Promise<ExternalSendResult>;
} {
  if (
    externalSessionMutationInFlight ||
    hasPendingDshNativeWork() ||
    hasExternalSendInFlight() ||
    shouldQueueExternalOperation(getExternalLifecycleState(), {
      responseMode: 'turn',
      canSteerActiveTurn: false,
    })
  ) {
    return enqueueExternalTurnBoundaryOperation(
      text,
      images,
      context.permissionMode,
      context.model,
      context,
    );
  }

  const runtimeConfig = captureExternalRuntimeConfigSnapshot(
    context.model,
    context.permissionMode,
    context,
  );
  const sendContext = applySnapshotToExternalSendContext(
    { ...context, queueId: context.queueId ?? nextExternalQueueId() },
    runtimeConfig,
  );
  const operation = createExternalMessageOperation({
    text,
    images,
    context: sendContext,
    runtimeConfig,
    userMessage: createExternalUserMessage(text, images, context.sessionId),
  });
  const generation = getExternalOperationGeneration();
  const dispatch = runExternalMessageOperation(
    text,
    images,
    runtimeConfig.permissionMode,
    runtimeConfig.model,
    sendContext,
    operation,
    undefined,
    generation,
  )
    .catch((error) => {
      if (isExternalQueueGenerationStaleError(error)) return { queued: false };
      throw error;
    })
    .finally(scheduleExternalQueueDrainAfterDirectAdmission);
  return {
    queued: true,
    userMessageId: operation.userProjection.message.id,
    dispatch,
  };
}

/**
 * Turn-end drain (one item) — surface the next queued message as a bubble (queue:started) and
 * send it (a fresh turn). Guarded by canDrainExternalQueue so it only fires when idle with a
 * pending item. Called via setTimeout(0) right after the turn-end idle so it never races
 * chat:message-complete on the SSE wire (see persistTurnResult idle-ordering notes).
 */
function drainExternalQueueAfterTurn(): void {
  if (
    externalSessionMutationInFlight || hasPendingDshMutation() ||
    (hasPendingDshNativeWork() && getExternalActiveSteerPair() === null) ||
    !canDrainExternalOperations(getExternalLifecycleState(), getExternalActiveSteerPair() !== null)
  )
    return;
  void drainExternalOperationsAfterTurn();
}

async function drainExternalOperationsAfterTurn(): Promise<void> {
  if (
    externalSessionMutationInFlight || hasPendingDshMutation() ||
    (hasPendingDshNativeWork() && getExternalActiveSteerPair() === null) ||
    !canDrainExternalOperations(getExternalLifecycleState(), getExternalActiveSteerPair() !== null)
  )
    return;
  const realtimeOnly = getExternalLifecycleState() === 'running';
  const drainGeneration = getExternalOperationGeneration();
  setExternalOperationDrainInFlight(true);
  let reservedItem:
    | ReturnType<typeof reserveExternalOperationForDrain>
    | undefined;
  try {
    const leadingConfig = realtimeOnly ? null : consumeLeadingExternalConfigOps();
    if (leadingConfig) {
      const applyResult = await applyExternalRuntimeConfigAtBoundary(
        leadingConfig.patch,
        leadingConfig.source,
      );
      if (!isCurrentExternalOperationGeneration(drainGeneration)) {
        return;
      }
      if (applyResult.error) {
        const message = `External runtime config apply failed: ${applyResult.error}`;
        console.error(`[external-session] ${message}`);
        broadcast('chat:agent-error', { message });
        clearExternalQueueWithCancellation('failed', message);
        setExternalSessionState('idle');
        return;
      }
    }

    const item = reserveExternalOperationForDrain(realtimeOnly);
    reservedItem = item;
    if (!item) return;
    if (!isCurrentExternalOperationGeneration(drainGeneration)) {
      return;
    }
    if (item.kind === 'config') {
      releaseExternalDrainReservation(item);
      reservedItem = undefined;
      unshiftExternalOperation(item);
      setTimeout(drainExternalQueueAfterTurn, 0);
      return;
    }

    if (realtimeOnly) {
      try {
        const dispatched = await withExternalMessageOperation(item, () => chainExternalSend(
          () => steerExternalMessage({ queueId: item.queueId, text: item.text, images: item.images,
            context: item.context, operation: item, generation: drainGeneration }), drainGeneration));
        // A definite native rejection requeues the same intent; its dispatch
        // promise remains pending until that later boundary actually dispatches.
        if (!dispatched.deferredDispatchAcceptance) {
          settleExternalMessageOperation(item, dispatched.result);
          if (!dispatched.result.queued) finalizeRejectedExternalOperation(item, 'failed', dispatched.result.error ?? 'Inbox dispatch rejected');
        }
      } catch (error) {
        const result = { queued: false, error: error instanceof Error ? error.message : String(error) };
        settleExternalMessageOperation(item, result);
        if (isCurrentExternalOperationGeneration(drainGeneration)) {
          broadcast('queue:cancelled', { queueId: item.queueId });
          finalizeRejectedExternalOperation(item, 'failed', result.error);
        }
      }
      return;
    }

    const userMsg = item.userProjection.message;
    userMsg.timestamp = new Date().toISOString();
    try {
      const result = await runExternalMessageOperation(
        item.text,
        item.images,
        item.runtimeConfig.permissionMode,
        item.runtimeConfig.model,
        item.context,
        item,
        () => {
          item.deferredDispatchAccepted?.();
          item.deferredDispatchAccepted = undefined;
          setExternalSessionState('running');
          setExternalOperationDrainInFlight(false);
          broadcast('queue:started', {
            queueId: item.queueId,
            sessionId: item.context.sessionId,
            userMessage: {
              id: userMsg.id,
              role: 'user',
              content: item.text,
              timestamp: userMsg.timestamp,
              attachments: userMsg.attachments,
              asyncQuestionReply: userMsg.asyncQuestionReply,
            },
          });
        },
        drainGeneration,
      );
      if (!isCurrentExternalOperationGeneration(drainGeneration)) return;
      const cancelledBeforeDispatch =
        result?.error === 'external_queue_cancelled_before_dispatch';
      settleExternalMessageOperation(
        item,
        cancelledBeforeDispatch
          ? { queued: false }
          : (result ?? { queued: false }),
      );
      if (result && !result.queued && !result.terminationUnconfirmed) {
        rollbackReservedExternalTurnAfterDrainFailure();
        broadcast('queue:cancelled', { queueId: item.queueId });
        finalizeRejectedExternalOperation(
          item,
          cancelledBeforeDispatch || !result.error ? 'cancelled' : 'failed',
          cancelledBeforeDispatch || !result.error
            ? 'External queued turn was cancelled before dispatch'
            : result.error,
        );
      }
    } catch (err) {
      if (isExternalQueueGenerationStaleError(err)) {
        settleExternalMessageOperation(item, { queued: false });
      } else {
        const message = err instanceof Error ? err.message : String(err);
        settleExternalMessageOperation(item, { queued: false, error: message });
        rollbackReservedExternalTurnAfterDrainFailure();
        broadcast('queue:cancelled', { queueId: item.queueId });
        finalizeRejectedExternalOperation(item, 'failed', message);
      }
    }
    releaseExternalDrainReservation(item);
    reservedItem = undefined;
  } finally {
    releaseExternalDrainReservation(reservedItem);
    if (isCurrentExternalOperationGeneration(drainGeneration)) {
      setExternalOperationDrainInFlight(false);
      scheduleExternalQueueDrainAfterDirectAdmission();
    }
  }
}

/**
 * Force-execute a queued external item ("立即发送"): move it to the FRONT, then run it ASAP.
 * Three cases:
 *   - running + runtime CAN interrupt a turn (Codex `interruptTurn`): interrupt now → the
 *     resulting turn/completed → turn_complete → persistTurnResult → idle → drain runs it
 *     immediately (true force). Process stays alive.
 *   - running + runtime CANNOT interrupt mid-turn (Claude Code `-p`):
 *     DEGRADE to move-to-front — the item is now
 *     first, so the NATURAL turn-end drain runs it next (not truly "immediate", but it does
 *     run, ahead of everything else). drainExternalQueueAfterTurn() is a no-op here (state is
 *     'running'); the turn-end hook handles it.
 *   - idle (no turn in flight): drain directly now.
 * Mirrors the builtin forceExecuteQueueItem (move-to-front + interrupt; turn-end drain surfaces).
 */
export async function forceExecuteExternalQueueItem(
  queueId: string,
): Promise<boolean> {
  if (!moveExternalQueuedMessageToFront(queueId)) return false;
  const active = getExternalActivePair();
  if (
    getExternalLifecycleState() === 'running' &&
    active &&
    active.runtime.interruptTurn
  ) {
    externalForceTransferQueueId = queueId;
    try {
      await active.runtime.interruptTurn(active.process);
    } catch (error) {
      externalForceTransferQueueId = null;
      throw error;
    }
  } else {
    // Idle DSH work can still be blocked by a durable root-operation journal
    // after process loss. Join the exact recovery owner before acknowledging
    // force; ordinary queue:started remains the dispatch/surface authority.
    await ensureQueuedDshRootRecovery();
    drainExternalQueueAfterTurn();
  }
  return true;
}

export type ExternalQueueCancellation = {
  cancelledText: string;
  promotion?: ExternalTurnPromotionToken;
};

/** Cancel a queued external item (the pill ✕). Returns its settlement when startup is in flight. */
export async function cancelExternalQueueItem(
  queueId: string,
): Promise<ExternalQueueCancellation | null> {
  let pending = pendingRealtimeSteeredUserMessages.find(
    (entry) => entry.queueId === queueId,
  );
  if (!pending) {
    const sessionId = getExternalLifecycleSessionId();
    const saved = getBoundDshMetadata()?.pendingDshInputs?.find(
      (input) => input.queueId === queueId,
    );
    if (sessionId && saved) {
      const intent = await settleDshInput({
        sessionId,
        clientOperationId: saved.clientOperationId,
        clientUserMessageId: saved.clientUserMessageId,
        state: 'cancel_requested',
      });
      if (!intent.success) throw new Error(intent.error);
      await ensureQueuedDshRootRecovery();
      const active = getExternalActivePair();
      const workspacePath = getExternalLifecycleWorkspacePath();
      if (active && !active.process.exited && workspacePath)
        await resumePendingDshInputs(active.runtime, active.process, {
          sessionId,
          workspacePath,
          scenario: getExternalLifecycleScenario(),
          channelDelivery: NO_CHANNEL_DELIVERY,
        });
      pending = pendingRealtimeSteeredUserMessages.find(
        (entry) => entry.queueId === queueId,
      );
      if (!pending) {
        if (
          getSessionMetadata(sessionId)?.pendingDshInputs?.some(
            (input) => input.clientUserMessageId === saved.clientUserMessageId,
          )
        ) {
          throw new Error(
            'DSH input cancellation is still waiting for Runtime recovery',
          );
        }
        return (await getSessionData(sessionId))?.messages.some(
          (message) => message.id === saved.clientUserMessageId,
        )
          ? null
          : { cancelledText: visibleDesktopMirrorText(saved.userMessage.content) };
      }
    }
  }
  const anchor =
    pending?.operation.userProjection.message.runtimeOperationAnchor;
  if (pending && anchor?.runtime === 'dsh') {
    const active = getExternalActivePair();
    if (
      !active ||
      active.process.exited ||
      !active.runtime.cancelSteeredMessage ||
      pending.sessionId !== getExternalLifecycleSessionId()
    )
      return null;
    // Input preparation may still be publishing its native identity. Cancel
    // only after that admission resolves, keeping the pill on transport failure.
    const intent = await settleDshInput({
      sessionId: pending.sessionId,
      clientOperationId: anchor.clientOperationId,
      clientUserMessageId: pending.operation.userProjection.message.id,
      state: 'cancel_requested',
    });
    if (!intent.success) throw new Error(intent.error);
    await pending.admission?.catch(() => undefined);
    const state = await active.runtime.cancelSteeredMessage(active.process, {
      clientOperationId: anchor.clientOperationId,
      clientUserMessageId: pending.operation.userProjection.message.id,
    });
    if (state !== 'cancelled') return null;
    const settled = await settleDshInput({
      sessionId: pending.sessionId,
      clientOperationId: anchor.clientOperationId,
      clientUserMessageId: pending.operation.userProjection.message.id,
      state: 'cancelled',
    });
    if (!settled.success) throw new Error(settled.error);
    const entry = takePendingRealtimeSteeredUserMessage(
      pending.operation.userProjection.message.id,
    );
    if (entry) {
      markExternalUserMessageRetracted(entry.operation);
      broadcast('queue:cancelled', { queueId });
    }
    return { cancelledText: visibleDesktopMirrorText(pending.text) };
  }
  if (isExternalTurnCurrent(queueId)) return null;
  const item = cancelExternalQueuedMessageOperation(queueId);
  if (!item) {
    const promotion = cancelExternalTurnPromotionByQueueId(queueId, {
      preserveQueue: true,
    });
    if (!promotion) return null;
    broadcast('queue:cancelled', { queueId });
    return { cancelledText: '', promotion };
  }
  broadcast('queue:cancelled', { queueId });
  finalizeRejectedExternalOperation(
    item,
    'cancelled',
    'External queued turn was cancelled',
  );
  return { cancelledText: item.text };
}

export function cancelExternalQueuedTurnsByOwner(
  owner: import('../session-core/turn-queue').TurnOwner,
): { count: number; promotion?: ExternalTurnPromotionToken } {
  const items = cancelExternalQueuedMessageOperationsByOwner(owner);
  const promotion = cancelExternalTurnPromotionByOwner(owner, {
    preserveQueue: true,
  });
  for (const item of items) {
    broadcast('queue:cancelled', { queueId: item.queueId });
    finalizeRejectedExternalOperation(
      item,
      'cancelled',
      'External queued turn owner was cancelled',
    );
  }
  return {
    count: items.length + (promotion ? 1 : 0),
    ...(promotion ? { promotion } : {}),
  };
}

export function hasExternalQueuedTurnByOwner(
  owner: import('../session-core/turn-queue').TurnOwner,
): boolean {
  return hasExternalQueuedMessageByOwner(owner);
}

/** Current external queue (for /chat/queue/status). Mirrors builtin getQueueStatus shape. */
export function getExternalQueueStatus(): Array<{ id: string; messagePreview: string; asyncQuestionReply?: AsyncQuestionReply; agentMentions?: import("../../shared/agentMentions").AgentMentionSnapshot[]; primaryContext?: import("../../shared/agentMentions").DesktopPrimaryContext; canCancel?: boolean; canForceExecute?: boolean }> {
  const queued = getExternalQueueStatusSnapshot();
  const waiting = [
    ...getExternalPendingMessageOperations(),
    ...pendingRealtimeSteeredUserMessages.map((entry) => entry.operation),
  ];
  for (const operation of waiting) {
    if (!operation.context.asyncQuestionReply || operation.userProjection.surfaced || operation.userProjection.retracted) continue;
    if (queued.some(item => item.id === operation.queueId)) continue;
    queued.push({ id: operation.queueId, messagePreview: visibleDesktopMirrorText(operation.text).slice(0, 100), agentMentions: operation.context.desktopQuery?.agentMentions, primaryContext: desktopContextOf(operation.context.desktopQuery?.primaryContext), asyncQuestionReply: operation.context.asyncQuestionReply, canCancel: false, canForceExecute: false });
  }
  if (getCurrentRuntimeType() !== 'dsh') return queued;
  const ids = new Set(queued.map((item) => item.id));
  const result = [
    ...queued,
    ...pendingRealtimeSteeredUserMessages
      .filter((entry) => !ids.has(entry.queueId))
      .map((entry) => ({
        id: entry.queueId,
        messagePreview: visibleDesktopMirrorText(entry.text).slice(0, 120),
        agentMentions: entry.operation.context.desktopQuery?.agentMentions,
        primaryContext: desktopContextOf(entry.operation.context.desktopQuery?.primaryContext),
      })),
  ];
  const displayed = new Set(result.map((item) => item.id));
  return [
    ...result,
    ...(getBoundDshMetadata()?.pendingDshInputs ?? [])
      .filter((input) => !displayed.has(input.queueId))
      .map((input) => ({
        id: input.queueId,
        messagePreview: visibleDesktopMirrorText(input.userMessage.content).slice(0, 120),
        agentMentions: input.userMessage.desktopQuery?.agentMentions,
        primaryContext: desktopContextOf(input.userMessage.desktopQuery?.primaryContext),
      })),
  ];
}

/**
 * Respond to a permission request from the external runtime.
 * @param decision - 'deny' | 'allow_once' | 'always_allow'
 *   For CC: always_allow includes updatedPermissions from the original permission_suggestions
 *   so CC persists the rule and won't re-prompt for the same tool.
 */
export async function respondExternalPermission(
  requestId: string,
  decision: 'deny' | 'allow_once' | 'always_allow',
  reason?: string,
): Promise<boolean> {
  const active = getExternalActivePair();
  if (!active) {
    console.warn(
      '[external-session] No active process for permission response',
    );
    return false;
  }
  const pending = getExternalInteractiveRequest(requestId);
  if (pending?.type !== 'permission:request') {
    console.warn(
      `[external-session] Unknown permission requestId: ${requestId}`,
    );
    return false;
  }
  // Peek first; consume/delete only after runtime delivery succeeds so a transient
  // stdin/process write failure does not make the approval impossible to retry.
  const suggestions = getExternalPermissionSuggestions(requestId);
  console.log(
    `[external-session] Permission response: ${decision} for requestId=${requestId}${suggestions?.length ? `, with ${suggestions.length} suggestion(s)` : ''}`,
  );
  await active.runtime.respondPermission(
    active.process,
    requestId,
    decision,
    reason,
    suggestions,
  );
  // Integrated runtimes may synchronously emit interactive_request_resolved while
  // the response call is awaiting its authoritative effect. Do not settle twice.
  if (!getExternalInteractiveRequest(requestId)) return true;
  consumeExternalPermissionSuggestions(requestId);
  deleteExternalInteractiveRequest(requestId);
  broadcastExternalInteractiveExpired(requestId, pending, 'resolved');
  return true;
}

/** Settle a Runtime-owned Plan review through the same interaction reverse port. */
export async function respondExternalPlanApproval(
  requestId: string,
  approved: boolean,
  feedback?: string,
): Promise<boolean> {
  const active = getExternalActivePair();
  const pending = getExternalInteractiveRequest(requestId);
  if (!active || pending?.type !== 'exit-plan-mode:request') return false;
  await active.runtime.respondPermission(
    active.process,
    requestId,
    approved ? 'allow_once' : 'deny',
    feedback,
    undefined,
    { approved, ...(feedback?.trim() ? { feedback: feedback.trim() } : {}) },
  );
  if (!getExternalInteractiveRequest(requestId)) return true;
  deleteExternalInteractiveRequest(requestId);
  broadcastExternalInteractiveExpired(requestId, pending, 'resolved');
  return true;
}

function getExternalPermissionRulePair() {
  const active = getExternalActivePair();
  if (!active || active.process.exited) {
    throw new Error('No live Runtime process owns permission rules');
  }
  if (
    getActiveRuntimeType() !== 'dsh' ||
    getActiveRuntimeSource() !== 'integrated'
  ) {
    throw new Error(
      'The active Runtime does not expose authoritative permission rules',
    );
  }
  return active;
}

export async function inspectExternalRuntime(runtime: RuntimeType) {
  const active = getExternalActivePair();
  if (
    !active ||
    active.runtime.type !== runtime ||
    !active.runtime.inspectRuntime
  )
    return null;
  return active.runtime.inspectRuntime(active.process);
}

export async function listExternalAgentWork(tasksFor?: string) {
  const active = getExternalActivePair();
  if (!active?.runtime.listAgentWork)
    throw new Error('Active Runtime does not expose Agent work');
  return active.runtime.listAgentWork(active.process, tasksFor);
}
export async function controlExternalAgentWork(input: RuntimeAgentWorkControl) {
  const active = getExternalActivePair();
  if (!active?.runtime.controlAgentWork)
    throw new Error('Active Runtime does not expose Agent controls');
  return active.runtime.controlAgentWork(active.process, input);
}

export async function listExternalPermissionRules() {
  const active = getExternalPermissionRulePair();
  if (!active.runtime.listPermissionRules) {
    throw new Error(
      'The active Runtime does not support permission rule inspection',
    );
  }
  return active.runtime.listPermissionRules(active.process);
}

export async function addExternalPermissionRule(
  input: Readonly<{
    expectedRevision: string;
    tool: string;
    permissionClass: string;
    target: string;
  }>,
) {
  const active = getExternalPermissionRulePair();
  if (!active.runtime.addPermissionRule) {
    throw new Error(
      'The active Runtime does not support permission rule grants',
    );
  }
  return active.runtime.addPermissionRule(active.process, input);
}

export async function revokeExternalPermissionRule(
  input: Readonly<{
    expectedRevision: string;
    ruleId: string;
  }>,
) {
  const active = getExternalPermissionRulePair();
  if (!active.runtime.revokePermissionRule) {
    throw new Error(
      'The active Runtime does not support permission rule revocation',
    );
  }
  return active.runtime.revokePermissionRule(active.process, input);
}

/**
 * Whether an outstanding external AskUserQuestion request is tracked for this requestId.
 * Used by the HTTP layer to route /api/ask-user-question/respond to the external runtime
 * when the request originated from CC (rather than the builtin SDK handler).
 */
export function hasPendingExternalAskUserQuestion(requestId: string): boolean {
  return hasExternalAskUserQuestion(requestId);
}

/** Whether an outstanding Runtime-owned plan review is tracked for this request. */
export function hasPendingExternalPlanApproval(requestId: string): boolean {
  return (
    getExternalInteractiveRequest(requestId)?.type === 'exit-plan-mode:request'
  );
}

/**
 * Deliver the user's AskUserQuestion answers (or a cancellation) back to the external runtime.
 * For CC: allow the tool call with `updatedInput = { ...original, answers }`, or deny on cancel.
 */
export async function respondExternalAskUserQuestion(
  requestId: string,
  answers: AskUserQuestionAnswers | null,
): Promise<boolean> {
  const pending = getExternalAskUserQuestion(requestId);
  if (!pending) {
    console.warn(
      `[external-session] Unknown AskUserQuestion requestId: ${requestId}`,
    );
    return false;
  }
  // Check process liveness BEFORE consuming the pending entry (cross-review C4):
  // previously we deleted up front, so a transient "process gone" state silently
  // discarded the answer and left the user with no affordance to retry. Keeping
  // the entry when we can't deliver lets the caller observe the failure and the
  // routing layer keep sending it to the external handler, not the builtin one.
  const active = getExternalActivePair();
  if (!active) {
    console.warn(
      `[external-session] No active process for AskUserQuestion response requestId=${requestId} — session likely stopped before user answered`,
    );
    return false;
  }

  try {
    if (active.runtime.respondAskUserQuestion) {
      await active.runtime.respondAskUserQuestion(
        active.process,
        requestId,
        answers,
      );
    } else if (answers === null) {
      console.log(
        `[external-session] AskUserQuestion cancelled for requestId=${requestId}`,
      );
      // PRD #131 — `interrupt: true` so AskUserQuestion cancel terminates
      // the whole assistant turn rather than only this single tool call.
      // Without it, CC keeps the turn alive and the model just calls
      // another tool, defeating the user's "I'm stopping this" intent.
      // Mirrors the builtin canUseTool path in agent-session.ts.
      await active.runtime.respondPermission(
        active.process,
        requestId,
        'deny',
        '用户取消了问答',
        undefined,
        undefined,
        true,
      );
    } else {
      console.log(
        `[external-session] AskUserQuestion answered for requestId=${requestId}`,
      );
      // CC is the same SDK 0.3.158 binary as builtin: it looks answers up by
      // question TEXT, so alias the renderer's index-keyed answers (see
      // withQuestionTextAnswerKeys). The superset keeps the original id/index
      // keys intact, so Codex's own response builder (codex.ts) is unaffected.
      const askQuestions = (pending.input as { questions?: AskUserQuestion[] })
        .questions;
      const updatedInput = {
        ...pending.input,
        answers: withQuestionTextAnswerKeys(
          askQuestions,
          questionAnswersAsText(answers),
        ),
      };
      await active.runtime.respondPermission(
        active.process,
        requestId,
        'allow_once',
        undefined,
        undefined,
        updatedInput,
      );
    }
    // Delete only after successful delivery — if respondPermission throws
    // (e.g. stdin closed mid-write) the caller can retry.
    const interactiveRequest = getExternalInteractiveRequest(requestId);
    deleteExternalAskUserQuestion(requestId);
    deleteExternalInteractiveRequest(requestId);
    broadcastExternalInteractiveExpired(
      requestId,
      interactiveRequest,
      'resolved',
    );
    return true;
  } catch (err) {
    console.error(
      `[external-session] respondPermission failed for requestId=${requestId}:`,
      err,
    );
    return false;
  }
}

/**
 * Pattern D — IM trace-id-targeted cancellation for external runtimes.
 * For CC/Codex we don't have a per-request granularity (the runtime
 * processes turns sequentially), so cancellation degenerates to "stop the
 * active session if `requestId` matches `activeRequestId`". Returns
 * { aborted, mode } same shape as the builtin `cancelImRequest`.
 */
export async function cancelExternalImRequest(
  requestId: string,
  _reason: string = 'user',
): Promise<{ aborted: boolean; mode: 'running' | 'queued' | 'unknown' }> {
  if (getExternalActiveRequestId() === requestId && isExternalSessionActive()) {
    console.log(
      `[external-session] cancelExternalImRequest requestId=${requestId} mode=running`,
    );
    const stopped = await stopExternalSession({ preserveQueue: true });
    return { aborted: stopped, mode: stopped ? 'running' : 'unknown' };
  }
  const queued = cancelExternalQueuedMessageByRequestId(requestId);
  if (queued) {
    console.log(
      `[external-session] cancelExternalImRequest requestId=${requestId} mode=queued`,
    );
    broadcast('queue:cancelled', { queueId: queued.queueId });
    finalizeRejectedExternalOperation(
      queued,
      'cancelled',
      'External queued IM turn was cancelled',
    );
    return { aborted: true, mode: 'queued' };
  }
  const reserved = getExternalReservedMessageByRequestId(requestId);
  if (reserved) {
    console.log(
      `[external-session] cancelExternalImRequest requestId=${requestId} mode=queued-reserved`,
    );
    reserved.context.beforeDispatch?.cancel?.();
    cancelExternalTurnPromotionByQueueId(reserved.queueId, {
      preserveQueue: true,
    });
    // The drain remains the sole terminal owner for a reserved operation. Its
    // acceptance settles only after the promotion/guard has stopped dispatch,
    // so /api/im/cancel cannot emit a competing terminal first.
    await reserved.dispatchAcceptance;
    return { aborted: true, mode: 'queued' };
  }
  return { aborted: false, mode: 'unknown' };
}

type ExternalStopReason = 'user' | 'config-restart' | 'conversation-mutation' | 'failure';

/**
 * Stop the active external session.
 */
export async function stopExternalSession(options?: {
  reason?: ExternalStopReason;
  preserveQueue?: boolean;
  /** Config restart may stop an idle process while the next admitted turn owns this token. */
  preservePromotion?: ExternalTurnPromotionToken | null;
}): Promise<boolean> {
  const stoppedExecutionTurnId = getExternalExecutionTurnId() ?? undefined;
  clearWatchdog();
  const preserveQueue = options?.preserveQueue === true;
  const preserveCurrentPromotion = Boolean(
    options?.preservePromotion &&
      isExternalTurnPromotionCurrent(options.preservePromotion),
  );
  const canceledPromotion = preserveCurrentPromotion
    ? null
    : cancelExternalTurnPromotion({ preserveQueue });
  const active = getExternalActivePair();
  const reason = options?.reason ?? 'user';
  const isConfigRestart = reason === 'config-restart' || reason === 'conversation-mutation';
  if (!active) {
    if (!canceledPromotion) {
      clearPendingExternalProcessConfigRestarts();
      return false;
    }
    const settlement = await canceledPromotion.settled;
    if (settlement.status === 'termination-unconfirmed') return false;
    if (settlement.status === 'terminated') return true;
    if (settlement.status === 'dispatched') {
      return getExternalActivePair() ? stopExternalSession(options) : true;
    }
    clearExternalActiveRuntimeProcess();
    activeExternalEnvPolicy = undefined;
    clearExternalTurnStartTime();
    setExternalTurnCompleted(true);
    resetTurnAccumulators();
    clearExternalInboxMetaOnRejection({
      turnId: stoppedExecutionTurnId,
      sessionId: getExternalLifecycleSessionId(),
      errorCode: 'session_aborted',
      errorMessage:
        'external runtime turn promotion was stopped before dispatch',
    });
    finalizeExternalActiveRequest('failed');
    if (!preserveQueue) {
      clearExternalQueueWithCancellation();
    } else {
      clearPendingRealtimeSteeredUserMessagesWithCancellation();
    }
    setExternalSessionState('idle');
    const completionTerminal = finalizeStoppedExternalTurn(
      '',
      {},
      !isConfigRestart,
    );
    if (!isConfigRestart) {
      broadcast(
        'chat:message-stopped',
        withSessionCompletionTerminal(null, completionTerminal),
      );
    }
    if (preserveQueue && !isConfigRestart) {
      setTimeout(drainExternalQueueAfterTurn, 0);
    }
    clearPendingExternalProcessConfigRestarts();
    return true;
  }
  const stopStarted = nowMs();
  const runtimeType = active.runtime.type;
  const pid = active.process.pid;
  emitPerfTrace({
    trace: 'runtime',
    phase: 'stop_start',
    runtime: runtimeType,
    sessionId: getExternalLifecycleSessionId() || undefined,
    status: 'ok',
    detail: { pid },
  });
  // #307: mark this teardown as intentional BEFORE killing the process, so the
  // session_complete the kill triggers is recognized as an abort (not a failure)
  // and its error banner is suppressed. Set before the await — the exit handler
  // can fire its session_complete during stopSession().
  markExternalUserRequestedStop();
  let gracefulError: unknown;
  try {
    await active.runtime.stopSession(active.process, reason === 'failure' ? 'failure' : 'stop');
  } catch (err) {
    gracefulError = err;
    console.error(
      '[external-session] Error stopping session:',
      summarizeExternalRuntimeMessageForLog(err),
    );
    emitPerfTrace({
      trace: 'runtime',
      phase: 'stop_escalated',
      durationMs: elapsedMs(stopStarted),
      runtime: runtimeType,
      sessionId: getExternalLifecycleSessionId() || undefined,
      status: 'error',
      detail: { pid, error: summarizeExternalRuntimeMessageForLog(err) },
    });
  }

  let confirmedStopped = active.process.exited;
  if (!confirmedStopped) {
    // Runtime stop either failed or returned before the process exited. Bound
    // the fallback via killWithEscalation: 2s graceful -> 1s hard -> orphan.
    const proc = active.process;
    const killResult = await killWithEscalation(
      {
        pid: proc.pid,
        exited: proc.exited,
        kill: (signal) => {
          // RuntimeProcess.kill accepts number; map signal names to SIGTERM/SIGKILL ints.
          const num =
            typeof signal === 'string'
              ? signal === 'SIGKILL'
                ? 9
                : 15
              : (signal ?? 15);
          proc.kill(num);
        },
        waitForExit: () => proc.waitForExit(),
      },
      {
        gracefulMs: 2000,
        hardMs: 1000,
        killTree: true,
        onStep: (step, info) => {
          if (step === 'orphan')
            console.warn(
              `[external-session] catch fallback orphan pid=${info.pid}`,
            );
        },
      },
    );
    emitPerfTrace({
      trace: 'runtime',
      phase: 'stop_fallback_done',
      durationMs: elapsedMs(stopStarted),
      runtime: runtimeType,
      sessionId: getExternalLifecycleSessionId() || undefined,
      status: killResult.exited ? 'ok' : 'error',
      detail: {
        pid,
        exited: killResult.exited,
        signalUsed: killResult.signalUsed ?? null,
        orphanRisk: killResult.orphanRisk,
        killElapsedMs: killResult.elapsedMs,
      },
    });
    confirmedStopped = killResult.exited;
  }

  if (!confirmedStopped) {
    console.error(
      `[external-session] Runtime process ${pid} is still alive after stop escalation`,
      gracefulError,
    );
    resetExternalUserRequestedStop();
    resetWatchdog();
    return false;
  }

  // Runtime events can arrive while stopSession/kill escalation is settling.
  // The stop marker prevents those events from re-arming the interval; clear
  // once more at confirmed process terminal to close the watchdog owner.
  clearWatchdog();

  emitPerfTrace({
    trace: 'runtime',
    phase: 'stop_done',
    durationMs: elapsedMs(stopStarted),
    runtime: runtimeType,
    sessionId: getExternalLifecycleSessionId() || undefined,
    status: 'ok',
    detail: { pid },
  });
  const completionTerminal = finalizeStoppedExternalTurn(
    currentExternalTurnTextSnapshot(),
    consumeExternalTurnMetrics(),
    !isConfigRestart,
  );
  await persistExternalPartialAssistantProjection('stopped').catch((error) => {
    console.error(
      '[external-session] failed to persist stopped assistant projection:',
      error,
    );
  });
  resetTurnAccumulators();
  releaseManagedCodexExtensionGeneration(active.process.runtimeGeneration);
  clearExternalActiveRuntimeProcess();
  clearPendingExternalProcessConfigRestarts();
  activeExternalEnvPolicy = undefined;
  // Any pre-warm that raced with a stop is no longer relevant. Keeping the
  // flag around would leak 'prewarm' into a subsequent session's session_init.
  clearExternalPrewarmingSession();
  clearExternalPermissionSuggestions();
  drainPendingInteractiveRequestsAsExpired('stop');
  setExternalSystemInitPayload(null);
  if (!isConfigRestart) {
    fireExternalImCallback('cancelled', buildImCancelledPayload());
    finalizeExternalActiveRequest('failed');
    deliverExternalWatchError({
      turnId: stoppedExecutionTurnId,
      sessionId: getExternalLifecycleSessionId(),
      text: currentExternalTurnTextSnapshot(),
      errorCode: 'session_aborted',
      errorMessage:
        'external runtime session was stopped before turn completed',
    });
    clearExternalInboxMetaOnRejection({
      turnId: stoppedExecutionTurnId,
      sessionId: getExternalLifecycleSessionId(),
      errorCode: 'session_aborted',
      errorMessage:
        'external runtime session was stopped before turn completed',
    });
  }
  if (!preserveQueue) {
    clearExternalQueueWithCancellation();
  } else {
    clearPendingRealtimeSteeredUserMessagesWithCancellation();
  }
  setExternalSessionState('idle');
  if (!isConfigRestart) {
    broadcast(
      'chat:message-stopped',
      withSessionCompletionTerminal(null, completionTerminal),
    );
  }
  if (preserveQueue && !isConfigRestart) {
    setTimeout(drainExternalQueueAfterTurn, 0);
  }
  emitExternalTurnTrace('final', {
    status: isConfigRestart ? 'ok' : 'error',
    detail: { source: 'stop_external_session', reason },
  });
  clearExternalTurnTrace();
  return true;
}

/** True only while a real external-runtime turn is in flight. */
export function isExternalSessionActive(): boolean {
  return isExternalTurnBusy();
}

/** External turn admission includes work accepted into the serialized queue. */
export function isExternalSessionBusy(): boolean {
  return (
    externalSessionMutationInFlight ||
    hasPendingDshNativeWork() ||
    isExternalTurnBusy() ||
    hasExternalSendInFlight() ||
    hasExternalQueuedOperations() ||
    isExternalOperationDrainInFlight()
  );
}

/** Retry through the Session's existing idle replacement and startup admission. */
export async function retryExternalMcpServer(
  serverId: string,
): Promise<McpRetryResult> {
  if (!isManagedCodexProductRuntime()) {
    return { success: false, status: 400, errorCode: 'unsupported_runtime' };
  }
  if (
    isExternalSessionBusy() ||
    isExternalLifecycleStarting() ||
    externalProcessConfigInvalidationInFlight
  ) {
    return { success: false, status: 409, errorCode: 'session_busy' };
  }
  const previousSnapshot = getExternalMcpEffectiveSnapshot();
  const failed = previousSnapshot?.servers.find(
    (server) => server.id === serverId,
  );
  const desired = getManagedCodexDesiredSnapshot();
  if (
    !failed?.desired ||
    (failed.state !== 'failed' && failed.state !== 'stopped') ||
    !desired?.mcpServers.some((server) => server.id === serverId)
  ) {
    return { success: false, status: 409, errorCode: 'server_not_failed' };
  }
  const sessionId = getExternalLifecycleSessionId();
  const workspacePath = getExternalLifecycleWorkspacePath();
  const scenario = getExternalLifecycleScenario();
  const lease = tryAcquireExternalSessionMutationLease();
  if (!lease) return { success: false, status: 409, errorCode: 'session_busy' };
  const retryFailed = (): McpRetryResult => {
    const current = getExternalMcpEffectiveSnapshot();
    // Process startup can fail before the adapter publishes any MCP state.
    // The Session's recovery owner must still settle its unavailable surface.
    if (!hasExternalRuntimeProcess() && !isExternalLifecycleStarting()
      && !current?.servers.length && previousSnapshot
      && getExternalLifecycleSessionId() === sessionId) {
      const currentDesired = getManagedCodexDesiredSnapshot();
      const now = Date.now();
      const snapshot = setExternalMcpEffectiveSnapshot({
        configGeneration: previousSnapshot.configGeneration,
        configFingerprint: currentDesired?.revision ?? previousSnapshot.configFingerprint,
        catalogGeneration: (current?.catalogGeneration ?? 0) + 1,
        observedAt: now,
        observationStale: false,
        dispatch: { state: 'released', releaseReason: 'terminal_status' },
        servers: (currentDesired?.mcpServers ?? []).map(server => ({
          id: server.id, desired: true, state: 'failed', errorCode: 'MCP_STARTUP_FAILED', toolCount: 0,
          attemptGeneration: (previousSnapshot.servers.find(previous => previous.id === server.id)?.attemptGeneration ?? 0) + 1,
          updatedAt: now,
        })),
        tools: [],
      }, 'codex', 'managed-provider');
      broadcast('chat:mcp-effective-snapshot', snapshot);
    }
    return { success: false, status: 502, errorCode: 'retry_failed' };
  };
  try {
    pendingExternalCapabilityRestart = true;
    await applyPendingExternalProcessConfigInvalidation();
    const result = await prewarmExternalSession({
      sessionId,
      workspacePath,
      scenario,
    });
    return result.prewarmed
      ? { success: true }
      : retryFailed();
  } catch {
    return retryFailed();
  } finally {
    lease.release();
    scheduleExternalQueueDrainAfterTurnBoundary();
  }
}

/**
 * Run Managed Codex's native compact control turn. The Session owns admission
 * and status projection; the runtime adapter owns the app-server protocol.
 * No user or assistant message is created for this operation.
 */
export async function compactExternalContext(): Promise<{
  success: boolean;
  status?: number;
  error?: string;
}> {
  await awaitExternalLifecycleStarting();
  if (!isManagedCodexProductRuntime() && !isDshProductRuntime()) {
    return {
      success: false,
      status: 409,
      error: 'Native context compaction is unavailable for this Runtime',
    };
  }
  if (isExternalSessionBusy()) {
    return {
      success: false,
      status: 409,
      error: 'Wait for the current Session operation to finish',
    };
  }

  const lease = tryAcquireExternalSessionMutationLease();
  if (!lease) {
    return {
      success: false,
      status: 409,
      error: 'Wait for the current Session operation to finish',
    };
  }

  let started = false;
  try {
    const active = await getCodexConversationBranchPair();
    if (!active || active.process.exited || !active.runtime.compactContext) {
      return {
        success: false,
        status: 409,
        error: 'The active Runtime Session is not ready for context compaction',
      };
    }

    started = true;
    setExternalSessionState('running');
    broadcast('chat:system-status', { status: 'compacting' });
    await active.runtime.compactContext(active.process);
    const contextUsage = getExternalCurrentTurnContextUsage();
    const sessionId = getExternalLifecycleSessionId();
    if (contextUsage && sessionId) {
      try {
        await updateSessionMetadata(sessionId, {
          lastContextUsage: contextUsage,
        });
      } catch (error) {
        console.warn(
          '[external-session] Failed to persist post-compact context usage:',
          error instanceof Error ? error.message : String(error),
        );
      }
    }
    broadcast('chat:system-status', { status: null, compactResult: 'success' });
    return { success: true };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(
      `[external-session] Runtime context compaction failed: ${message}`,
    );
    if (started) {
      broadcast('chat:system-status', {
        status: null,
        compactResult: 'failed',
        compactError: message,
      });
    }
    return { success: false, status: 500, error: message };
  } finally {
    setExternalCurrentTurnContextUsage(null);
    if (started) setExternalSessionState('idle');
    lease.release();
    scheduleExternalQueueDrainAfterTurnBoundary();
  }
}

/** Single atomic owner for reset, rewind, and fork Session-boundary mutations. */
export function tryAcquireExternalSessionMutationLease(): {
  release: () => void;
} | null {
  if (externalSessionMutationInFlight) return null;
  externalSessionMutationInFlight = true;
  return {
    release: () => {
      externalSessionMutationInFlight = false;
    },
  };
}

/**
 * True when an external runtime process is still alive, even if no turn is
 * currently running. Persistent runtimes such as Codex app-server keep an idle
 * process around after a turn completes; session-boundary operations must stop
 * that process too, not only `isExternalSessionActive()` running turns.
 */
export function hasExternalRuntimeProcess(): boolean {
  const process = getExternalActiveProcess();
  return Boolean(process && !process.exited);
}

export type ExternalConversationOperationResult = {
  conversationCommitted?: boolean;
  retryQueued?: boolean;
  success: boolean;
  status?: number;
  error?: string;
  errorCode?:
    | 'unsupported_runtime'
    | 'codex_update_required'
    | 'session_busy'
    | 'anchor_unavailable'
    | 'native_fork_failed'
    | 'native_mutation_failed'
    | 'persistence_failed'
    | 'storage_consistency_error'
    | 'restore_failed';
  content?: string;
  attachments?: SessionMessage['attachments'];
  rewindScope?: 'conversation-only';
  fileRewindStatus?: 'complete' | 'partial' | 'failed' | 'not_attempted';
  newSessionId?: string;
  agentDir?: string;
  title?: string;
};

function externalConversationBranchFailure(
  error: unknown,
): ExternalConversationOperationResult {
  if (error instanceof RuntimeConversationBranchError) {
    if (error.code === 'capability_unavailable') {
      return {
        success: false,
        status: 400,
        errorCode: 'codex_update_required',
        error: error.message,
      };
    }
    if (error.code === 'anchor_unavailable') {
      return {
        success: false,
        status: 409,
        errorCode: 'anchor_unavailable',
        error: error.message,
      };
    }
  }
  return {
    success: false,
    status: 502,
    errorCode: 'native_fork_failed',
    error:
      error instanceof Error
        ? error.message
        : 'Codex conversation branch failed',
  };
}

function logCodexConversationOrphan(
  sessionId: string,
  runtimeSessionId: string,
  reason: 'rewind_persistence_failed' | 'fork_persistence_failed',
): void {
  console.error(
    `[external-session] Codex conversation branch orphan sessionId=${sessionId}` +
      ` runtimeSource=${getCurrentRuntimeSource()} reason=${reason} orphan=true` +
      ` nativeThread=${JSON.stringify(summarizeSensitiveValueForLog(runtimeSessionId))}`,
  );
}

async function withExternalConversationMutation(
  operation: () => Promise<ExternalConversationOperationResult>,
  afterCommit?: (result: ExternalConversationOperationResult) => Promise<ExternalConversationOperationResult>,
): Promise<ExternalConversationOperationResult> {
  await awaitExternalLifecycleStarting();
  if (isExternalSessionBusy()) {
    return {
      success: false,
      status: 409,
      errorCode: 'session_busy',
      error: 'Wait for the current Session operation to finish',
    };
  }
  const lease = tryAcquireExternalSessionMutationLease();
  if (!lease) {
    return {
      success: false,
      status: 409,
      errorCode: 'session_busy',
      error: 'Wait for the current Session operation to finish',
    };
  }
  try {
    const result = await operation();
    return result.success && afterCommit ? await afterCommit(result) : result;
  } finally {
    lease.release();
    await recoverPendingDshConversationMutationAfterLease();
    setTimeout(drainExternalQueueAfterTurn, 0);
  }
}

async function recoverPendingDshConversationMutationAfterLease(): Promise<void> {
  if (!hasPendingDshNativeWork()) return;
  const sessionId = getExternalLifecycleSessionId();
  const workspacePath = getExternalLifecycleWorkspacePath();
  if (!sessionId || !workspacePath) {
    restartSidecarForConversationMutation('storage-inconsistent');
    return;
  }
  const scenario = getExternalLifecycleScenario();
  const stopped =
    !hasExternalRuntimeProcess() ||
    (await stopExternalSession({
      preserveQueue: true,
      reason: 'conversation-mutation',
    }));
  if (!stopped) {
    restartSidecarForConversationMutation('source-stop-unconfirmed');
    return;
  }
  const recovery = await prewarmExternalSession({
    sessionId,
    workspacePath,
    scenario,
  }).catch(() => ({ prewarmed: false }));
  if (
    !recovery.prewarmed &&
    getSessionMetadata(sessionId)?.pendingDshMutation
  ) {
    restartSidecarForConversationMutation('storage-inconsistent');
  }
}

async function getCodexConversationBranchPair(): Promise<
  ReturnType<typeof getExternalActivePair>
> {
  let active = getExternalActivePair();
  if (active && !active.process.exited) return active;
  const sessionId = getExternalLifecycleSessionId();
  const workspacePath = getExternalLifecycleWorkspacePath();
  if (!sessionId || !workspacePath) return null;
  const prewarm = await prewarmExternalSession({
    sessionId,
    workspacePath,
    scenario: getExternalLifecycleScenario(),
  });
  if (!prewarm.prewarmed && !hasExternalRuntimeProcess()) return null;
  active = getExternalActivePair();
  return active && !active.process.exited ? active : null;
}

async function getDshConversationMutationPair(): Promise<
  ReturnType<typeof getExternalActivePair>
> {
  let active = getExternalActivePair();
  if (active && !active.process.exited) return active;
  const sessionId = getExternalLifecycleSessionId();
  const workspacePath = getExternalLifecycleWorkspacePath();
  if (!sessionId || !workspacePath) return null;
  const prewarm = await prewarmExternalSession({
    sessionId,
    workspacePath,
    scenario: getExternalLifecycleScenario(),
  });
  if (!prewarm.prewarmed && !hasExternalRuntimeProcess()) return null;
  active = getExternalActivePair();
  return active && !active.process.exited ? active : null;
}

function dshMutationFailureResult(
  error: unknown,
  errorCode:
    | 'native_fork_failed'
    | 'native_mutation_failed'
    | 'persistence_failed' = 'native_mutation_failed',
): ExternalConversationOperationResult {
  return {
    success: false,
    status: errorCode === 'persistence_failed' ? 500 : 502,
    errorCode,
    error:
      error instanceof Error
        ? error.message
        : 'DSH conversation mutation failed',
  };
}

function dshStoreFailureResult(result: {
  success: false;
  reason: string;
  error: string;
}): ExternalConversationOperationResult {
  return {
    success: false,
    status: result.reason === 'precondition_failed' ? 409 : 500,
    errorCode:
      result.reason === 'storage_consistency_error'
        ? 'storage_consistency_error'
        : result.reason === 'precondition_failed'
          ? 'anchor_unavailable'
          : 'persistence_failed',
    error: result.error,
  };
}

async function forkDshConversation(
  assistantMessageId: string,
  requestedTargetSessionId?: string,
): Promise<ExternalConversationOperationResult> {
  return withExternalConversationMutation(async () => {
    const sessionId = getExternalLifecycleSessionId();
    if (requestedTargetSessionId) {
      const prior = getSessionMetadata(requestedTargetSessionId);
      if (prior) {
        if (prior.forkOrigin?.sessionId !== sessionId || prior.forkOrigin.messageId !== assistantMessageId) {
          return { success: false, status: 409, error: 'Fork target belongs to another operation' };
        }
        if (prior.materializationState) return { success: false, status: 409, error: 'Fork publication is still in progress' };
        return { success: true, newSessionId: prior.id, agentDir: prior.agentDir, title: prior.title };
      }
    }
    const source = sessionId ? getSessionMetadata(sessionId) : null;
    if (!source?.runtimeSessionId) {
      return {
        success: false,
        status: 409,
        errorCode: 'anchor_unavailable',
        error: 'The DSH Session binding is unavailable',
      };
    }
    const active = await getDshConversationMutationPair();
    if (!active) {
      return {
        success: false,
        status: 502,
        errorCode: 'native_mutation_failed',
        error: 'The DSH Runtime is unavailable',
      };
    }
    const { createDshForkTargetFacts, getDshConversationMutationContext } =
      await import('../integrated-runtimes/dsh/runtime');
    let context;
    try {
      context = getDshConversationMutationContext(active.process);
    } catch (error) {
      return dshMutationFailureResult(error, 'native_fork_failed');
    }
    if (context.runtimeSessionId !== source.runtimeSessionId) {
      return {
        success: false,
        status: 409,
        errorCode: 'anchor_unavailable',
        error: 'The active DSH Runtime owns a different Session',
      };
    }

    const forked = createSessionMetadata(
      source.agentDir,
      snapshotForForkedSession(source),
    );
    if (requestedTargetSessionId) forked.id = requestedTargetSessionId;
    forked.forkOrigin = { sessionId: sessionId!, messageId: assistantMessageId };
    forked.runtimeSessionId = `dsh-${crypto.randomUUID()}`;
    forked.title = `🌿 ${source.title || 'Chat'}`;
    forked.titleSource = 'auto';
    forked.origin = { kind: 'desktop', surface: 'session_fork' };
    forked.materializationState = 'prepared';
    forked.materializationSourceSessionId = sessionId;
    const targetFacts = await createDshForkTargetFacts(forked.id);
    const clientMutationId = `dsh-fork-${crypto.randomUUID()}`;
    const begun = await beginDshForkMutation({
      sourceSessionId: sessionId,
      sourceAssistantMessageId: assistantMessageId,
      clientMutationId,
      targetProductSessionId: forked.id,
      targetRuntimeSessionId: forked.runtimeSessionId,
      targetRuntimeHome: targetFacts.runtimeHome,
      targetPersistenceRef: targetFacts.persistenceRef,
      targetWorkspaceIdentity: context.workspaceIdentity,
    });
    if (!begun.success) return dshStoreFailureResult(begun);

    let prepared;
    try {
      prepared = await context.controller.prepareFork({
        clientMutationId,
        sourceRuntimeTurnId: begun.value.intent.sourceRuntimeTurnId,
        targetRuntimeHome: targetFacts.runtimeHome,
        targetPersistenceRef: targetFacts.persistenceRef,
        targetWorkspaceIdentity: context.workspaceIdentity,
        targetRuntimeSessionId: forked.runtimeSessionId,
      });
    } catch (error) {
      // Runtime prepare can commit before a transport failure. The journal is
      // intentionally retained so restart can replay this exact mutation ID.
      return dshMutationFailureResult(error, 'native_fork_failed');
    }
    const recorded = await recordPreparedDshFork({
      sourceSessionId: sessionId,
      clientMutationId,
      token: prepared.mutation.token,
      sourceStableBoundaryId: prepared.boundary.stableBoundaryId,
    });
    if (!recorded.success) return dshStoreFailureResult(recorded);

    const staged = await stageDshForkProduct({
      sourceSessionId: sessionId,
      clientMutationId,
      targetMetadata: forked,
      targetMessages: begun.value.targetMessages,
    });
    if (!staged.success) {
      const abortIntent = await requestDshForkAbort({
        sourceSessionId: sessionId,
        clientMutationId,
        token: prepared.mutation.token,
      });
      if (!abortIntent.success) return dshStoreFailureResult(abortIntent);
      try {
        const aborted = await context.controller.abortFork(
          clientMutationId,
          prepared.mutation.token,
        );
        if (aborted.state === 'aborted') {
          await abortDshForkProduct({
            sourceSessionId: sessionId,
            clientMutationId,
          });
        }
      } catch {
        // Both durable journals remain available for restart recovery.
      }
      return dshStoreFailureResult(staged);
    }
    let committed = prepared.mutation;
    if (committed.state !== 'committed') {
      try {
        committed = await context.controller.commitFork(
          clientMutationId,
          committed.token,
        );
      } catch (error) {
        return dshMutationFailureResult(error, 'native_fork_failed');
      }
    }
    if (committed.state !== 'committed') {
      return dshMutationFailureResult(
        new Error(`DSH fork settled as ${committed.state}`),
        'native_fork_failed',
      );
    }
    const product = await commitDshForkProduct({
      sourceSessionId: sessionId,
      clientMutationId,
      token: committed.token,
    });
    if (!product.success) return dshStoreFailureResult(product);
    return {
      success: true,
      newSessionId: product.value.id,
      agentDir: product.value.agentDir,
      title: product.value.title,
    };
  });
}

async function rewindDshConversation(
  userMessageId: string,
  afterCommit?: (result: ExternalConversationOperationResult) => Promise<ExternalConversationOperationResult>,
  allowUnadmittedRetry = false,
): Promise<ExternalConversationOperationResult> {
  let restart:
    | {
        sessionId: string;
        workspacePath: string;
        scenario: InteractionScenario;
      }
    | undefined;
  const result = await withExternalConversationMutation(async () => {
    const sessionId = getExternalLifecycleSessionId();
    const metadata = sessionId ? getSessionMetadata(sessionId) : null;
    if (!metadata?.runtimeSessionId) {
      return {
        success: false,
        status: 409,
        errorCode: 'anchor_unavailable',
        error: 'The DSH Session binding is unavailable',
      };
    }
    const active = await getDshConversationMutationPair();
    if (!active) {
      return {
        success: false,
        status: 502,
        errorCode: 'native_mutation_failed',
        error: 'The DSH Runtime is unavailable',
      };
    }
    const { getDshConversationMutationContext } = await import(
      '../integrated-runtimes/dsh/runtime'
    );
    let context;
    try {
      context = getDshConversationMutationContext(active.process);
    } catch (error) {
      return dshMutationFailureResult(error);
    }
    if (context.runtimeSessionId !== metadata.runtimeSessionId) {
      return {
        success: false,
        status: 409,
        errorCode: 'anchor_unavailable',
        error: 'The active DSH Runtime owns a different Session',
      };
    }
    if (allowUnadmittedRetry) {
      const target = getExternalSessionMessagesSnapshot().find(
        message => message.id === userMessageId && message.role === 'user',
      );
      const anchor = target?.runtimeOperationAnchor;
      if (!target || anchor?.runtime !== 'dsh' || anchor.runtimeSessionId !== context.runtimeSessionId) {
        return { success: false, status: 409, errorCode: 'anchor_unavailable', error: 'The DSH retry target has no durable operation identity' };
      }
      try {
        const lookup = await context.controller.getTurn(anchor.clientOperationId);
        if (!lookup.admission) return retryUnadmittedDshTranscript(sessionId, userMessageId);
      } catch (error) {
        return dshMutationFailureResult(error);
      }
    }
    const clientMutationId = `dsh-rewind-${crypto.randomUUID()}`;
    const begun = await beginDshRewindMutation({
      sessionId,
      targetUserMessageId: userMessageId,
      clientMutationId,
    });
    if (!begun.success) return dshStoreFailureResult(begun);

    let prepared;
    try {
      const history = await context.controller.readHistory();
      const { rewindBoundaryBeforeRuntimeTurn } = await import(
        '../integrated-runtimes/dsh/mutations'
      );
      const boundary = rewindBoundaryBeforeRuntimeTurn(
        history,
        begun.value.intent.targetRuntimeTurnId,
      );
      const mutation = await context.controller.prepareRewind({
        clientMutationId,
        target: boundary,
        sourceTranscriptPostcondition: history.transcriptPostcondition,
      });
      prepared = { mutation, boundary, history };
    } catch (error) {
      return dshMutationFailureResult(error);
    }
    const recorded = await recordPreparedDshRewind({
      sessionId,
      clientMutationId,
      token: prepared.mutation.token,
      targetStableBoundaryId: prepared.boundary.stableBoundaryId,
      sourceTranscriptPostcondition: prepared.history.transcriptPostcondition,
      targetTranscriptPostcondition: prepared.boundary.transcriptPostcondition,
    });
    if (!recorded.success) return dshStoreFailureResult(recorded);
    let committed = prepared.mutation;
    if (committed.state !== 'committed') {
      try {
        committed = await context.controller.commitRewind(
          clientMutationId,
          committed.token,
        );
      } catch (error) {
        return dshMutationFailureResult(error);
      }
    }
    if (committed.state !== 'committed') {
      return dshMutationFailureResult(
        new Error(`DSH rewind settled as ${committed.state}`),
      );
    }
    const product = await commitDshRewindProduct({
      sessionId,
      clientMutationId,
      token: committed.token,
    });
    if (!product.success) return dshStoreFailureResult(product);
    const transcript = await loadSessionTranscript(sessionId);
    setExternalSessionMessages(
      sessionId,
      transcript.messages,
      transcript.cursor,
    );
    const stopped =
      !hasExternalRuntimeProcess() ||
      (await stopExternalSession({ reason: 'conversation-mutation', preserveQueue: Boolean(afterCommit) }));
    if (!stopped) {
      restartSidecarForConversationMutation('source-stop-unconfirmed');
      return {
        success: true,
        content: begun.value.targetUserMessage.content,
        desktopQuery: begun.value.targetUserMessage.desktopQuery,
        attachments: begun.value.targetUserMessage.attachments,
        fileRewindStatus: 'complete',
        errorCode: 'restore_failed',
        error: 'The conversation was rewound and the DSH Sidecar is restarting',
      };
    }
    restart = {
      sessionId,
      workspacePath: metadata.agentDir,
      scenario: getExternalLifecycleScenario(),
    };
    return {
      success: true,
      content: begun.value.targetUserMessage.content,
      desktopQuery: begun.value.targetUserMessage.desktopQuery,
      attachments: begun.value.targetUserMessage.attachments,
      fileRewindStatus: 'complete',
    };
  }, afterCommit);
  if (restart) {
    void prewarmExternalSession({
      sessionId: restart.sessionId,
      workspacePath: restart.workspacePath,
      scenario: restart.scenario,
    }).catch(() => undefined);
  }
  return result;
}

function restartSidecarForConversationMutation(
  reason: 'storage-inconsistent' | 'source-stop-unconfirmed',
): void {
  console.error(
    `[external-session] Conversation mutation requires a clean Sidecar restart reason=${reason}`,
  );
  const timer = setTimeout(() => process.kill(process.pid, 'SIGTERM'), 0);
  timer.unref();
}

function startCodexReplacementPrewarm(options: {
  sessionId: string;
  workspacePath: string;
  scenario: InteractionScenario;
  replacementRuntimeSessionId: string;
}): void {
  const metadata = getSessionMetadata(options.sessionId);
  if (
    getExternalLifecycleSessionId() !== options.sessionId ||
    metadata?.runtimeSessionId !== options.replacementRuntimeSessionId
  )
    return;
  void prewarmExternalSession({
    sessionId: options.sessionId,
    workspacePath: options.workspacePath,
    scenario: options.scenario,
  }).catch(() => {
    console.warn(
      `[external-session] Codex replacement prewarm failed sessionId=${options.sessionId}` +
        ` runtimeSource=${getCurrentRuntimeSource()} reason=runtime_start_failed`,
    );
  });
}

export async function rewindExternalConversation(
  userMessageId: string,
  afterCommit?: (result: ExternalConversationOperationResult) => Promise<ExternalConversationOperationResult>,
): Promise<ExternalConversationOperationResult> {
  if (getCurrentRuntimeType() === 'dsh') {
    return rewindDshConversation(userMessageId, afterCommit);
  }
  if (getCurrentRuntimeType() !== 'codex') {
    return { success: false, status: 400, errorCode: 'unsupported_runtime', error: 'Conversation rewind is only supported by Codex' };
  }
  let replacementPrewarm: Parameters<typeof startCodexReplacementPrewarm>[0] | undefined;
  const result = await withExternalConversationMutation(async () => {
    const sessionId = getExternalLifecycleSessionId();
    const metadata = sessionId ? getSessionMetadata(sessionId) : null;
    const data = sessionId ? (await getSessionData(sessionId)) : null;
    if (!metadata || !data || !metadata.runtimeSessionId) {
      return { success: false, status: 409, errorCode: 'anchor_unavailable', error: 'The Codex conversation binding is unavailable' };
    }
    const targetUserIndex = data.messages.findIndex(message => message.id === userMessageId && message.role === 'user');
    const anchoredAssistants = data.messages.filter(message => (
      message.role === 'assistant'
      && message.runtimeTurnAnchor?.rootUserMessageId === userMessageId
    ));
    if (targetUserIndex < 0 || anchoredAssistants.length > 1) {
      return { success: false, status: 409, errorCode: 'anchor_unavailable', error: 'This message has no exact Codex turn anchor' };
    }
    const targetUser = data.messages[targetUserIndex]!;
    const targetAssistant = anchoredAssistants[0]!;
    if (targetAssistant && (data.messages.indexOf(targetAssistant) <= targetUserIndex || !targetAssistant.runtimeTurnAnchor)) {
      return { success: false, status: 409, errorCode: 'anchor_unavailable', error: 'The Codex turn anchor does not match this user message' };
    }

    const sourceFailure = await prepareSessionTranscriptMutation(sessionId);
    if (sourceFailure) return { success: false, status: 409, errorCode: 'persistence_failed', error: sourceFailure.error };

    const active = await getCodexConversationBranchPair();
    if (!active?.runtime.branchConversation) {
      return { success: false, status: 400, errorCode: 'codex_update_required', error: 'This Codex runtime cannot branch conversations' };
    }
    let branch;
    try {
      if (targetAssistant?.runtimeTurnAnchor) {
        branch = await active.runtime.branchConversation(active.process, {
          kind: 'before-turn', runtimeTurnId: targetAssistant.runtimeTurnAnchor.turnId,
        });
      } else if (targetUserIndex === 0) {
        // A failed first turn has no retained context, regardless of native partial output.
        branch = { kind: 'fresh-thread' as const };
      } else {
        const preceding = data.messages[targetUserIndex - 1];
        if (preceding?.role !== 'assistant' || !preceding.runtimeTurnAnchor) {
          return { success: false, status: 409, errorCode: 'anchor_unavailable', error: 'The retained prefix has no exact Codex boundary' };
        }
        branch = await active.runtime.branchConversation(active.process, {
          kind: 'through-turn', runtimeTurnId: preceding.runtimeTurnAnchor.turnId,
        });
      }
    } catch (error) {
      return externalConversationBranchFailure(error);
    }

    const targetMessages = data.messages.slice(0, targetUserIndex);
    const commitRewind = commitCodexConversationRewindForTests ?? commitCodexConversationRewind;
    const committed = await commitRewind({
      sessionId,
      sourceRuntimeSessionId: metadata.runtimeSessionId,
      replacementRuntimeSessionId: branch.kind === 'native-thread' ? branch.runtimeSessionId : null,
      sourceMessages: data.messages,
      targetMessages,
    });
    if (!committed.success) {
      if (branch.kind === 'native-thread') {
        logCodexConversationOrphan(sessionId, branch.runtimeSessionId, 'rewind_persistence_failed');
      }
      if (committed.reason === 'storage_consistency_error') {
        // The durable intent is deliberately retained as recovery evidence.
        // Restart before releasing live admission so startup resolution is the
        // only path that may bind a runtime or accept another send.
        restartSidecarForConversationMutation('storage-inconsistent');
      }
      return {
        success: false,
        status: committed.reason === 'precondition_failed' ? 409 : 500,
        errorCode: committed.reason === 'storage_consistency_error'
          ? 'storage_consistency_error'
          : 'persistence_failed',
        error: committed.error,
      };
    }

    if (!getActiveSessionTranscript(sessionId)) {
      broadcast('chat:messages-retracted', {
        messageIds: data.messages.slice(targetUserIndex).map(message => message.id),
        retractedStreamingTail: true,
      });
    }
    try {
      const transcript = await loadSessionTranscript(sessionId);
      setExternalSessionMessages(sessionId, transcript.messages, transcript.cursor);
      const stopped = !hasExternalRuntimeProcess()
        || await stopExternalSession({ reason: 'conversation-mutation', preserveQueue: true });
      if (!stopped) {
        restartSidecarForConversationMutation('source-stop-unconfirmed');
        return {
          success: true,
          content: targetUser.content, desktopQuery: targetUser.desktopQuery,
          attachments: targetUser.attachments,
          rewindScope: 'conversation-only',
          errorCode: 'restore_failed',
          error: 'The conversation was rewound and the Codex Sidecar is restarting',
        };
      }
      const restoreScenario = getExternalLifecycleScenario();
      const restored = await restoreExternalSessionState(
        sessionId,
        metadata.agentDir,
        restoreScenario,
      );
      if (restored.success && branch.kind === 'native-thread') {
        replacementPrewarm = {
          sessionId,
          workspacePath: metadata.agentDir,
          scenario: restoreScenario,
          replacementRuntimeSessionId: branch.runtimeSessionId,
        };
      }
      return {
        success: true,
        content: targetUser.content, desktopQuery: targetUser.desktopQuery,
        attachments: targetUser.attachments,
        rewindScope: 'conversation-only',
        ...(!restored.success ? {
          errorCode: 'restore_failed' as const,
          error: restored.error ?? 'The conversation was rewound, but Codex must be restarted',
        } : {}),
      };
    } catch (error) {
      return { success: true, conversationCommitted: true, content: targetUser.content, desktopQuery: targetUser.desktopQuery, attachments: targetUser.attachments,
        rewindScope: 'conversation-only', errorCode: 'restore_failed', error: String(error) };
    }
  }, afterCommit);
  // withExternalConversationMutation has released the mutation lease here.
  // Prewarm is best-effort and owns runtime start through the existing path.
  if (replacementPrewarm) startCodexReplacementPrewarm(replacementPrewarm);
  return result;
}

export function retryDshConversation(
  userMessageId: string,
  afterCommit: (result: ExternalConversationOperationResult) => Promise<ExternalConversationOperationResult>,
): Promise<ExternalConversationOperationResult> {
  return rewindDshConversation(userMessageId, afterCommit, true);
}

export async function forkExternalConversation(
  assistantMessageId: string,
  requestedTargetSessionId?: string,
): Promise<ExternalConversationOperationResult> {
  if (getCurrentRuntimeType() === 'dsh') {
    return forkDshConversation(assistantMessageId, requestedTargetSessionId);
  }
  if (getCurrentRuntimeType() !== 'codex') {
    return {
      success: false,
      status: 400,
      errorCode: 'unsupported_runtime',
      error: 'Conversation fork is only supported by Codex',
    };
  }
  return withExternalConversationMutation(async () => {
    const sessionId = getExternalLifecycleSessionId();
    if (requestedTargetSessionId) {
      const prior = getSessionMetadata(requestedTargetSessionId);
      if (prior) {
        if (prior.forkOrigin?.sessionId !== sessionId || prior.forkOrigin.messageId !== assistantMessageId) {
          return { success: false, status: 409, error: 'Fork target belongs to another operation' };
        }
        if (prior.materializationState) return { success: false, status: 409, error: 'Fork publication is still in progress' };
        return { success: true, newSessionId: prior.id, agentDir: prior.agentDir, title: prior.title };
      }
    }
    const source = sessionId ? await getSessionData(sessionId) : null;
    if (source?.transcriptRecovery) {
      return {
        success: false,
        status: 409,
        errorCode: 'anchor_unavailable',
        error: 'Cannot fork an incompletely restored conversation',
      };
    }
    if (!source?.runtimeSessionId) {
      return {
        success: false,
        status: 409,
        errorCode: 'anchor_unavailable',
        error: 'The Codex conversation binding is unavailable',
      };
    }
    const targetIndex = source.messages.findIndex(
      (message) =>
        message.id === assistantMessageId && message.role === 'assistant',
    );
    const target = targetIndex >= 0 ? source.messages[targetIndex] : undefined;
    if (!target?.runtimeTurnAnchor) {
      return {
        success: false,
        status: 409,
        errorCode: 'anchor_unavailable',
        error: 'This message has no exact Codex turn anchor',
      };
    }
    const active = await getCodexConversationBranchPair();
    if (!active?.runtime.branchConversation) {
      return {
        success: false,
        status: 400,
        errorCode: 'codex_update_required',
        error: 'This Codex runtime cannot branch conversations',
      };
    }
    let branch;
    try {
      branch = await active.runtime.branchConversation(active.process, {
        kind: 'through-turn',
        runtimeTurnId: target.runtimeTurnAnchor.turnId,
      });
    } catch (error) {
      return externalConversationBranchFailure(error);
    }
    if (branch.kind !== 'native-thread') {
      return {
        success: false,
        status: 502,
        errorCode: 'native_fork_failed',
        error: 'Codex returned an invalid fork result',
      };
    }

    const legacyAgent = source.configSnapshotAt
      ? undefined
      : (findProjectAgentByWorkspacePath(source.agentDir) as
          | AgentConfig
          | undefined);
    const legacyFallback = legacyAgent
      ? snapshotForOwnedSession(legacyAgent, {
          runtimeOverride: 'codex',
          runtimeSourceOverride: getCurrentRuntimeSource(),
          managedCodexProviderReady:
            isManagedCodexProviderReady(loadAdminConfig()),
        })
      : {
          runtime: 'codex' as const,
          runtimeSource: getCurrentRuntimeSource(),
          model: getExternalRuntimeDesiredModel() || undefined,
          reasoningEffort:
            getExternalRuntimeDesiredReasoningEffort() || undefined,
          permissionMode:
            getExternalRuntimeDesiredPermissionMode() || undefined,
          configSnapshotAt: new Date().toISOString(),
        };
    const forked = createSessionMetadata(
      source.agentDir,
      snapshotForForkedSession(source, legacyFallback),
    );
    if (requestedTargetSessionId) forked.id = requestedTargetSessionId;
    forked.forkOrigin = { sessionId: sessionId!, messageId: assistantMessageId };
    forked.runtimeSessionId = branch.runtimeSessionId;
    forked.title = `🌿 ${source.title || 'Chat'}`;
    forked.titleSource = 'auto';
    forked.origin = { kind: 'desktop', surface: 'session_fork' };
    const forkedMessages = source.messages.slice(0, targetIndex + 1);
    try {
      await publishForkSession(forked, forkedMessages, sessionId!);
    } catch (error) {
      logCodexConversationOrphan(
        sessionId,
        branch.runtimeSessionId,
        'fork_persistence_failed',
      );
      return {
        success: false,
        status: 500,
        errorCode: 'persistence_failed',
        error:
          error instanceof Error ? error.message : 'Fork persistence failed',
      };
    }
    return {
      success: true,
      newSessionId: forked.id,
      agentDir: forked.agentDir,
      title: forked.title,
    };
  });
}

/**
 * Truncate `allSessionMessages` at the given user message id and persist the
 * truncation. Returns the popped user message's content + attachments so the
 * caller can re-send.
 *
 * External-runtime equivalent of builtin `rewindSession()`. Used by the
 * retry button when the previous turn failed (e.g. model capacity). This
 * remains separate from Codex conversation rewind: a failed tail has no
 * successful native Turn anchor to branch from. A "drop the failed user turn
 * + resend" semantic is still sound because the failed turn never produced an assistant
 * message (persistTurnResult only fires on subtype=success), so the local
 * history just has a dangling user message at the tail.
 *
 * Caller is responsible for invoking sendExternalMessage with the returned
 * content. We don't do the resend here so the existing send path's
 * MCP/agents/model wiring stays the single source of truth.
 *
 * Refuses if a turn is currently in flight — the user must abort first.
 */
export async function popLastUserMessageForRetry(
  userMessageId: string,
): Promise<{
  success: boolean;
  error?: string;
  content?: string;
  attachments?: SessionMessage['attachments'];
}> {
  const lifecycleSessionId = getExternalLifecycleSessionId();
  if (!lifecycleSessionId) {
    return { success: false, error: 'No active external session' };
  }
  if (isExternalSessionActive()) {
    return {
      success: false,
      error: 'Cannot retry while a turn is in progress',
    };
  }
  return rewindExternalConversation(userMessageId);
}

export async function retryLastExternalUserMessage(
  userMessageId: string,
): Promise<ExternalConversationOperationResult> {
  const lifecycleSessionId = getExternalLifecycleSessionId();
  if (!lifecycleSessionId)
    return { success: false, error: 'No active external session' };
  if (isExternalSessionActive()) {
    return {
      success: false,
      error: 'Cannot retry while a turn is in progress',
    };
  }
  if (getCurrentRuntimeType() !== 'dsh') {
    return rewindExternalConversation(userMessageId);
  }

  const target = getExternalSessionMessagesSnapshot().find(
    (message) => message.id === userMessageId && message.role === 'user',
  );
  const anchor = target?.runtimeOperationAnchor;
  if (!target || anchor?.runtime !== 'dsh') {
    return {
      success: false,
      error: 'The DSH retry target has no durable operation identity',
    };
  }
  const active = await getDshConversationMutationPair();
  if (!active)
    return { success: false, error: 'The DSH Runtime is unavailable' };
  const { getDshConversationMutationContext } = await import(
    '../integrated-runtimes/dsh/runtime'
  );
  let context;
  try {
    context = getDshConversationMutationContext(active.process);
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }
  if (context.runtimeSessionId !== anchor.runtimeSessionId) {
    return {
      success: false,
      error: 'The DSH retry target belongs to a different Runtime Session',
    };
  }
  try {
    const lookup = await context.controller.getTurn(anchor.clientOperationId);
    if (!lookup.admission) {
      return retryUnadmittedDshTranscript(
        lifecycleSessionId,
        userMessageId,
      );
    }
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }
  return rewindDshConversation(userMessageId);
}

/**
 * Pre-warm an external runtime process so the first user message skips the
 * cold-start cost (spawn + `initialize` + native Session open/resume +
 * prompt-file write). Integrated DSH is intentionally resume-only here: a fresh DSH
 * native Session is born with the first admitted Product turn, after Product
 * Session identity is stable.
 *
 * Called from the `/api/runtime/prewarm` HTTP endpoint when the frontend opens
 * a Chat tab backed by a persistent protocol runtime (Integrated DSH or Codex).
 * Claude Code's `-p` mode exits after every turn, so pre-warming it is wasted
 * work — the endpoint gates that out before reaching this path.
 *
 * Flow:
 *   1. Bail out if a session is already active (pre-warm is idempotent).
 *   2. Call startExternalSession with NO initialMessage — the runtime spawns
 *      the CLI, does its handshake, opens or resumes a session, and then sits
 *      idle. Fresh DSH Sessions skip this path.
 *   3. First real user message hits sendExternalMessage Case 3 (process alive)
 *      and writes directly to stdin via activeRuntime.sendMessage — no cold
 *      boot.
 *
 * The startExternalSession `startingPromise` guard serializes pre-warm against
 * any concurrent send, so a user who sends a message before pre-warm finishes
 * spawning is safely queued behind it.
 */
export function resolvePrewarmModel(
  metaModel: string | undefined,
  callerModel: string | undefined,
): string | undefined {
  return metaModel ?? callerModel;
}

export async function prewarmExternalSession(options: {
  sessionId: string;
  workspacePath: string;
  scenario: InteractionScenario;
  model?: string;
}): Promise<{ prewarmed: boolean; reason?: string }> {
  const runtimeType = getCurrentRuntimeType();
  const start = nowMs();
  emitPerfTrace({
    trace: 'runtime',
    phase: 'prewarm_start',
    runtime: runtimeType,
    sessionId: options.sessionId,
  });
  // Persistent protocol runtimes can initialize before their first turn.
  // CC's `-p` mode exits after every turn, so pre-warming it is wasted.
  if (!runtimeSupportsPrewarm(runtimeType)) {
    emitPerfTrace({
      trace: 'runtime',
      phase: 'prewarm_skipped',
      runtime: runtimeType,
      sessionId: options.sessionId,
      durationMs: elapsedMs(start),
      status: 'skipped',
      detail: { reason: 'not_persistent' },
    });
    return {
      prewarmed: false,
      reason: `Pre-warm not applicable for runtime=${runtimeType}`,
    };
  }
  // Already running/starting a turn — pre-warm is advisory and must not interrupt it.
  if (
    isExternalSessionActive() ||
    isExternalLifecycleRunning() ||
    isExternalLifecycleStarting()
  ) {
    emitPerfTrace({
      trace: 'runtime',
      phase: 'prewarm_skipped',
      runtime: runtimeType,
      sessionId: options.sessionId,
      durationMs: elapsedMs(start),
      status: 'skipped',
      detail: { reason: 'already_active_or_starting' },
    });
    return { prewarmed: false, reason: 'Session already active or starting' };
  }
  // Cross-runtime guard — refuse to warm a session whose persisted metadata
  // names a different runtime. Frontend Chat.tsx also guards this, but the
  // frontend's sessionRuntime is populated async via loadSession, so the
  // effect may fire before that state settles. Backend check uses the
  // authoritative source (SessionStore) and closes the race-window hole.
  const meta = getExternalSessionMetadata(options.sessionId);
  const persistedRuntimeType = meta?.runtimeBinding
    ? runtimeTypeForBinding(meta.runtimeBinding)
    : meta?.runtime;
  if (persistedRuntimeType && persistedRuntimeType !== runtimeType) {
    emitPerfTrace({
      trace: 'runtime',
      phase: 'prewarm_skipped',
      runtime: runtimeType,
      sessionId: options.sessionId,
      durationMs: elapsedMs(start),
      status: 'skipped',
      detail: { reason: 'runtime_mismatch' },
    });
    return {
      prewarmed: false,
      reason: `Session runtime mismatch: persisted=${persistedRuntimeType}, current=${runtimeType}`,
    };
  }
  if (persistedRuntimeType) {
    const persistedRuntimeSource = meta?.runtimeBinding
      ? runtimeSourceForBinding(meta.runtimeBinding)
      : normalizeRuntimeSourceForRuntime(
          persistedRuntimeType,
          meta?.runtimeSource,
        );
    const currentRuntimeSource = normalizeRuntimeSourceForRuntime(
      runtimeType,
      getCurrentRuntimeSource(),
    );
    if (persistedRuntimeSource !== currentRuntimeSource) {
      emitPerfTrace({
        trace: 'runtime',
        phase: 'prewarm_skipped',
        runtime: runtimeType,
        sessionId: options.sessionId,
        durationMs: elapsedMs(start),
        status: 'skipped',
        detail: { reason: 'runtime_source_mismatch' },
      });
      return {
        prewarmed: false,
        reason: `Session runtime source mismatch: persisted=${persistedRuntimeSource ?? 'none'}, current=${currentRuntimeSource ?? 'none'}`,
      };
    }
  }

  const activeProcess = getExternalActiveProcess();
  if (activeProcess && !activeProcess.exited) {
    if (await isExternalSessionStateRestoredFor(options.sessionId)) {
      emitPerfTrace({
        trace: 'runtime',
        phase: 'prewarm_skipped',
        runtime: runtimeType,
        sessionId: options.sessionId,
        durationMs: elapsedMs(start),
        status: 'skipped',
        detail: { reason: 'already_warm' },
      });
      return { prewarmed: false, reason: 'Session already warm' };
    }
    await stopExternalSession();
  }

  // Pick resume ID if restoreExternalSessionState populated one — but only if
  // it actually belongs to this session. lastRuntimeSessionId is module-level
  // state that can carry over from a previous session in Handover scenario 4,
  // or simply be stale if restoreExternalSessionState hasn't run yet for this
  // sessionId. Using a mismatched resume ID would produce "No conversation
  // found" from the CLI and wipe user intent.
  const resumeSessionId =
    getExternalLifecycleSessionId() === options.sessionId &&
    getExternalRuntimeSessionId()
      ? getExternalRuntimeSessionId()
      : undefined;

  if (runtimeType === 'dsh' && !resumeSessionId) {
    emitPerfTrace({
      trace: 'runtime',
      phase: 'prewarm_skipped',
      runtime: runtimeType,
      sessionId: options.sessionId,
      durationMs: elapsedMs(start),
      status: 'skipped',
      detail: { reason: 'awaiting_first_turn' },
    });
    return {
      prewarmed: false,
      reason: 'Fresh DSH Session starts with the first Product turn',
    };
  }

  // Permission always comes from the persisted Session/Agent authority. A Tab
  // reopen may prewarm before renderer state has hydrated; accepting a caller
  // mode here is exactly the race that downgraded managed fullAgency.
  const effectivePermissionMode = resolveWorkspaceConfig(
    options.workspacePath,
    meta,
    { includeMcp: false },
  ).permissionMode;
  const effectiveModel = resolvePrewarmModel(meta?.model, options.model);

  console.log(
    `[external-session] Pre-warming ${runtimeType} for session ${options.sessionId}${resumeSessionId ? ` (resume=${resumeSessionId})` : ' (fresh)'} permissionMode=${effectivePermissionMode}`,
  );

  try {
    await startExternalSession({
      sessionId: options.sessionId,
      workspacePath: options.workspacePath,
      // initialMessage intentionally omitted — this is the pre-warm signal
      model: effectiveModel,
      permissionMode: effectivePermissionMode,
      scenario: options.scenario,
      resumeSessionId,
    });
  } catch (error) {
    emitPerfTrace({
      trace: 'runtime',
      phase: 'prewarm_done',
      runtime: runtimeType,
      sessionId: options.sessionId,
      durationMs: elapsedMs(start),
      status: 'error',
    });
    throw error;
  }

  emitPerfTrace({
    trace: 'runtime',
    phase: 'prewarm_done',
    runtime: runtimeType,
    sessionId: options.sessionId,
    durationMs: elapsedMs(start),
    status: 'ok',
  });

  return { prewarmed: true };
}

/**
 * Query models for a given runtime type
 */
export async function queryRuntimeModels(
  runtimeType: RuntimeType,
  options: {
    runtimeSource?: import('../../shared/types/runtime').RuntimeSource;
    signal?: AbortSignal;
    throwOnError?: boolean;
  } = {},
): Promise<unknown[]> {
  if (runtimeType === 'builtin') return [];
  const runtimeSource =
    runtimeType === 'codex' ? options.runtimeSource ?? 'system-cli' : undefined;
  const codex = runtimeType === 'codex';
  try {
    if (codex && getCurrentRuntimeType() === runtimeType && getCurrentRuntimeSource() === runtimeSource) {
      await awaitExternalLifecycleStarting();
    }
    const runtime = codex ? getExternalActiveRuntime() : null;
    const process = runtime?.type === runtimeType && runtimeSource === getCurrentRuntimeSource()
      ? getExternalActiveProcess()
      : null;
    const models =
      runtime?.type === runtimeType &&
      runtimeSource === getCurrentRuntimeSource() &&
      process &&
      !process.exited
        ? await runtime.queryModels({
            runtimeSource,
            process,
            signal: options.signal,
          })
        : await queryRuntimeModelsSingleFlight(
            runtimeType,
            async (ownerSignal) => {
              return await getExternalRuntime(runtimeType).queryModels({
                runtimeSource,
                signal: ownerSignal,
              });
            },
            runtimeSource,
            options.signal,
          );
    // The lifecycle owner arbitrates late discovery, including a temporary
    // query begun just before prewarm published the Session's actual process.
    const currentProcess = getExternalActiveRuntime()?.type === runtimeType && runtimeSource === getCurrentRuntimeSource()
      ? getExternalActiveProcess()
      : null;
    if (codex && currentProcess !== process) {
      throw new Error('Codex Session changed during model discovery');
    }
    return models;
  } catch (err) {
    console.error(
      `[external-session] Failed to query models for ${runtimeType}:`,
      err,
    );
    if (options.throwOnError) throw err;
    return [];
  }
}

/**
 * Get permission modes for a given runtime type
 */
export function getRuntimePermissionModes(runtimeType: RuntimeType): unknown[] {
  if (runtimeType === 'builtin') return [];
  try {
    const runtime = getExternalRuntime(runtimeType);
    return runtime.getPermissionModes();
  } catch {
    return [];
  }
}

// ─── Private: shared turn finalization (used by both turn_complete and session_complete) ───

/** Flush accumulated content blocks, persist to SessionStore, and broadcast completion.
 * Called by both turn_complete (Codex) and session_complete (CC) to avoid duplication. */
async function persistTurnResult(
  terminalGeneration: number,
  clientOperationId?: string,
): Promise<void> {
  const resultTurnId = getExternalExecutionTurnId() ?? undefined;
  // Defense-in-depth: the `session_complete` handler reads `persistInFlight`
  // to decide whether to fire `setExternalSessionState('idle')` synchronously.
  // When persistInFlight=true, idle is deferred to this function. If we throw
  // BEFORE reaching the explicit setExternalSessionState('idle') below
  // (e.g. JSON.stringify on a circular currentContentBlocks, or
  // flushAllPending throws sync), the renderer would be stuck in `running`
  // forever for that session. Outer try/finally guarantees idle ALWAYS fires.
  // Caller still gets the error via the fire-and-forget `.catch` for logging.
  // v0.2.14 cross-bugfix follow-up.

  // PRD 0.2.18 Session Inbox — snapshot meta + hints SYNCHRONOUSLY at entry
  // and immediately clear the module slots, so a concurrent sendExternalMessage
  // arriving during the await chain below cannot overwrite them. Without this,
  // turn_complete sets turnCompleted=true and fires persistTurnResult
  // fire-and-forget; the busy gate at L1249 stops blocking; the next
  // sendExternalMessage runs L1265 (`currentTurnInboxMeta = next ?? null`)
  // before this turn's finally reads the meta — replying to the wrong caller
  // or losing the reply entirely (cross-review CC BLOCKER #1 + Codex Critical
  // #1 / Scenario 1+11).
  const { inboxMetas: turnInboxMetas, attachmentHints: turnAttachmentHints } =
    snapshotExternalTurnReplyState();
  const turnSucceededAtTerminal = didExternalLastTurnSucceed();
  const turnActivityFacts = getExternalTurnActivityFacts();
  const terminalActivityAt =
    turnActivityFacts &&
    shouldRecordTerminalActivity(turnActivityFacts, {
      text: currentExternalTurnTextSnapshot(),
    })
      ? new Date().toISOString()
      : undefined;
  // Terminal usage belongs to this turn. Consume it before the first await so
  // a degraded next-turn admission cannot reset or replace the mutable slot.
  const settledTurnUsage = consumeExternalTurnUsage();
  // PRD 0.2.32 — snapshot THIS turn's context usage at the SAME synchronous entry
  // as turnInboxMeta above, NOT after the `await awaitInFlightSaves()` further down.
  // turn_complete fires persistTurnResult fire-and-forget and flips turnCompleted;
  // the busy gate stops blocking, so a back-to-back sendExternalMessage can run
  // resetTurnAccumulators() (which nulls currentTurnContextUsage) inside this turn's
  // await window. Capturing here — before any await — makes it race-free, mirroring
  // the inbox-meta discipline. Null = no usage event this turn → persist must OMIT
  // the field (never write undefined, which would erase the prior persisted value).
  const turnContextUsage = getExternalCurrentTurnContextUsage();
  const runtimeType = getCurrentRuntimeType();
  const runtimeSource = getCurrentRuntimeSource();
  const lifecycleSessionId = getExternalLifecycleSessionId();
  const turnModel = settledTurnUsage?.model
    || getExternalRuntimeLiveReportedModel() || getExternalRuntimeDesiredModel() || null;
  let providerAnalytics = runtimeProviderAnalytics(runtimeType);
  const activeRuntime = getExternalActiveRuntime();
  const activeProcess = getExternalActiveProcess();
  if (activeRuntime?.getTurnProviderAnalytics && activeProcess) {
    try {
      providerAnalytics = { ...activeRuntime.getTurnProviderAnalytics(activeProcess) };
    } catch {
      // Optional attribution must not change execution or terminal settlement.
    }
  }
  const runtimeTurnAnchor = getExternalRuntimeTurnAnchor();
  const turnAnalyticsSource =
    currentTurnAnalyticsSource ?? getExternalLifecycleAnalyticsSource();
  const lifecycleScenarioForOrigin = getExternalLifecycleScenario();
  const turnAnalyticsOrigin =
    currentTurnAnalyticsOrigin ??
    getExternalLifecycleAnalyticsOrigin() ??
    originFromTurnAttribution({
      source: turnAnalyticsSource,
      scenarioType: lifecycleScenarioForOrigin.type,
      desktopSurface:
        lifecycleScenarioForOrigin.type === 'desktop'
          ? lifecycleScenarioForOrigin.surface
          : undefined,
      inboxMeta: turnInboxMetas[0],
    });
  const persistTraceStarted = nowMs();
  let persistFailed = false;
  let persistFailureReason: string | undefined;
  let settledTurnDurationMs: number | undefined;
  let activityOwnedByTranscriptPersist = false;
  let assistantChannelDeliveryBatch: ReturnType<
    typeof captureExternalAssistantChannelDelivery
  > | null = null;

  // PRD 0.2.18 Session Inbox — capture turn text BEFORE resetTurnAccumulators()
  // wipes it (cross-review CC + Architecture: the original impl read
  // `currentAssistantText` in the finally block AFTER reset → always empty for
  // structured-blocks turns, which is the common Codex/CC case). Build the
  // reply body from currentContentBlocks (preferred — captures all text blocks
  // even if streamed via deltas) with currentAssistantText as fallback.
  let capturedReplyText = '';
  try {
    const turnStartTime = getExternalTurnStartTime();
    const turnDurationMs = turnStartTime
      ? Date.now() - turnStartTime
      : undefined;
    settledTurnDurationMs = turnDurationMs;
    flushAllPending(
      turnSucceededAtTerminal
        ? 'mirror-completed-block'
        : 'skip-incomplete-block',
    );
    assistantChannelDeliveryBatch = captureExternalAssistantChannelDelivery();

    // Cross-review 0.2.33 (Codex W1) — snapshot THIS turn's content blocks and
    // assistant text at the same synchronous discipline as the entry snapshots
    // above (here = after flushAllPending, still before the first await). A
    // degraded send (turnFinalization.settled timeout in sendExternalMessage)
    // runs resetTurnAccumulators() during the await below; these were the LAST
    // un-snapshotted fields, so the worst case was silent loss of the previous
    // assistant message, not just stale ordering. The array is captured by
    // REFERENCE on purpose: reset reassigns (`currentContentBlocks = []`), so
    // the snapshot survives it, while in-place attachment patches during
    // awaitInFlightSaves() still land in the captured blocks.
    const turnContentSnapshot = captureExternalTurnContentSnapshot();
    const productTranscript = getExternalProductContent();
    capturedReplyText = productTranscript
      ? getLastExternalAssistantTextFromTranscript()
      : getExternalTurnContentSnapshotText(turnContentSnapshot);

    // PRD 0.2.15 Review A4 fix — drain in-flight attachment saves so the
    // placeholder attachments embedded in the turn's content blocks get patched
    // BEFORE we snapshot to disk. Without this await, large/slow saves land
    // their `tool_attachment_update` after `currentContentBlocks = []` reset
    // and the disk JSON keeps the "生成中" placeholder forever.
    const usageData = settledTurnUsage;
    const turnToolCount = productTranscript
      ? [...productTranscript.writer.projection.messages.values()]
          .filter(
            (message) =>
              message.role === 'assistant' &&
              message.turnId === productTranscript.currentTurn?.id,
          )
          .reduce(
            (count, message) =>
              count +
              (Array.isArray(message.content)
                ? message.content.filter(
                    (block) =>
                      block.type === 'tool_use' ||
                      block.type === 'server_tool_use',
                  ).length
                : 0),
            0,
          )
      : getExternalTurnContentSnapshotToolCount(turnContentSnapshot);

    if (!productTranscript) await awaitInFlightSaves();
    else {
      getTranscriptPresentation()?.closeText();
      getTranscriptPresentation()?.closeThinking();
    }

    // turnContextUsage was snapshotted at the synchronous function entry (above) to
    // survive a concurrent turn's resetTurnAccumulators() during the await window.

    // PRD 0.2.18 / 0.2.37 — capture turn text BEFORE resetTurnAccumulators
    // clears the source. Inbox send.result and session watch.completed both
    // read this in finally.
    // Reset only what we still own: if a degraded concurrent send already ran
    // resetTurnAccumulators(), the module global points at the NEW turn's
    // array — resetting again would wipe that turn's accumulating state.
    const resetIfStillOurs = () => {
      if (isExternalTurnContentSnapshotCurrent(turnContentSnapshot))
        resetTurnAccumulators();
    };

    const persistedContent = productTranscript
      ? null
      : getExternalTurnContentSnapshotPersistedContent(turnContentSnapshot);
    activityOwnedByTranscriptPersist = true;
    const persistResult = await appendAndPersistExternalAssistantTurn({
      sessionId: lifecycleSessionId,
      content: persistedContent,
      durationMs: turnDurationMs,
      usage: usageData,
      toolCount: turnToolCount,
      // PRD 0.2.32 — persist this turn's context snapshot only when the runtime
      // reported one. Null omits the metadata key, preserving the previous value.
      contextUsage: turnContextUsage,
      lastActiveAt: terminalActivityAt,
      runtimeTurnAnchor:
        getCurrentRuntimeType() === 'codex' || getCurrentRuntimeType() === 'dsh'
          ? (runtimeTurnAnchor ?? undefined)
          : undefined,
      terminalStatus: turnSucceededAtTerminal ? 'complete' : 'error',
    });
    if (persistResult.appendedAssistant) {
      resetIfStillOurs();
    }
    if (!persistResult.ok) {
      persistFailed = true;
      persistFailureReason = persistResult.failureReason;
      console.error(
        `[external-session] Failed to save session messages: ${persistFailureReason ?? 'unknown error'}`,
      );
    }
    if (
      runtimeType === 'dsh' &&
      persistResult.ok &&
      runtimeTurnAnchor?.origin !== 'collaboration'
    ) {
      if (!clientOperationId) {
        throw new Error(
          'DSH terminal persistence lacks its exact operation identity',
        );
      }
      const settlement = await settleDshRootOperation({
        sessionId: lifecycleSessionId,
        clientOperationId,
      });
      if (!settlement.success) {
        throw new Error(
          `Failed to settle DSH Product operation journal: ${settlement.error}`,
        );
      }
    }
    if (
      turnSucceededAtTerminal &&
      persistResult.ok &&
      assistantChannelDeliveryBatch
    ) {
      commitExternalAssistantChannelDelivery(assistantChannelDeliveryBatch);
    }
    emitExternalTurnTrace('persist_done', {
      durationMs: elapsedMs(persistTraceStarted),
      status: persistFailed ? 'error' : 'ok',
      count: persistResult.messageCount,
      detail: {
        toolCount: turnToolCount,
        ...(persistFailureReason ? { reason: persistFailureReason } : {}),
      },
    });

    const completionStatus =
      turnSucceededAtTerminal && !persistFailed ? 'complete' : 'error';
    const completionTerminal =
      recordExternalCompletionTerminal(completionStatus);
    if (persistFailed) {
      if (isExternalTurnGenerationCurrent(terminalGeneration)) {
        setExternalLastTurnSucceeded(false);
      }
      const message = persistFailureReason
        ? `Failed to persist external runtime turn: ${persistFailureReason}`
        : 'Failed to persist external runtime turn';
      broadcast('chat:agent-error', { message });
      broadcast(
        'chat:message-error',
        withSessionCompletionTerminal(message, completionTerminal),
      );
    } else {
      if (capturedReplyText.trim()) {
        console.log(
          `[assistant-output] runtime=${runtimeType} status=${completionTerminal?.status ?? completionStatus} ` +
            formatTextPreviewForLog(capturedReplyText),
        );
      }
      broadcast(
        'chat:message-complete',
        withSessionCompletionTerminal(
          {
            ...(persistResult.assistantMessageId
              ? { assistant_message_id: persistResult.assistantMessageId }
              : {}),
            ...(usageData
              ? {
                  model: usageData.model,
                  input_tokens: usageData.inputTokens,
                  output_tokens: usageData.outputTokens,
                  cache_read_tokens: usageData.cacheReadTokens,
                  cache_creation_tokens: usageData.cacheCreationTokens,
                }
              : {}),
            ...(turnToolCount > 0 ? { tool_count: turnToolCount } : {}),
            ...(turnDurationMs ? { duration_ms: turnDurationMs } : {}),
            ...(runtimeTurnAnchor
              ? { runtime_turn_anchor: runtimeTurnAnchor }
              : {}),
          },
          completionTerminal,
        ),
      );
    }
    // PRD 0.2.19 — session_id joins back to renderer session_new for full funnel.
    // `lastSessionId` is typed `string` and bootstrap-initialized to `''`, so we
    // coerce empty to null here. Analytics tolerates null and groups those as
    // "pre-session" (negligible volume — only first turn before any id lands).
    const analyticsScenario = lifecycleScenarioForOrigin;
    if (turnSucceededAtTerminal && !persistFailed) {
      trackServer('ai_turn_complete', {
        source: turnAnalyticsSource,
        ...originAnalyticsFields(turnAnalyticsOrigin),
        session_id: lifecycleSessionId || null,
        platform:
          analyticsScenario.type === 'im' ? analyticsScenario.platform : null,
        runtime: runtimeType,
        runtime_source: runtimeSource ?? null,
        model: turnModel,
        ...providerAnalytics,
        input_tokens: usageData?.inputTokens,
        output_tokens: usageData?.outputTokens,
        cache_read_tokens: usageData?.cacheReadTokens,
        cache_creation_tokens: usageData?.cacheCreationTokens,
        tool_count: turnToolCount,
        duration_ms: turnDurationMs,
      });
    }

    // #296 — backend-owned auto session titling for external runtimes. Gate on a
    // real successful turn (`lastTurnSucceeded`), not just "persistTurnResult ran".
    // Fired through the `turn-hooks` leaf slot (dependency inversion) — see
    // turn-hooks.ts. Non-blocking + best-effort. External runtimes use CLI-owned
    // auth, so no providerEnv is passed.
    if (turnSucceededAtTerminal && !persistFailed && lifecycleSessionId) {
      firePostTurnTitleHook(
        lifecycleSessionId,
        runtimeType,
        getExternalRuntimeDesiredModel() || undefined,
        undefined,
      );
    }
  } catch (error) {
    persistFailed = true;
    persistFailureReason =
      error instanceof Error ? error.message : String(error);
    if (isExternalTurnGenerationCurrent(terminalGeneration)) {
      setExternalLastTurnSucceeded(false);
    }
    throw error;
  } finally {
    if (assistantChannelDeliveryBatch) {
      // Idempotent after commit; on every failure path this releases the
      // ordering reservation without exposing incomplete assistant output.
      discardExternalAssistantChannelDelivery(assistantChannelDeliveryBatch);
    }
    if (terminalActivityAt && !activityOwnedByTranscriptPersist) {
      try {
        const sessionId = getExternalLifecycleSessionId();
        if (sessionId)
          await updateSessionMetadata(sessionId, {
            lastActiveAt: terminalActivityAt,
          });
      } catch (error) {
        console.error(
          '[external-session] failed to persist terminal activity after finalization error:',
          error,
        );
      }
    }
    const finalizedTurnSucceeded = turnSucceededAtTerminal && !persistFailed;
    // PRD 0.2.18 Session Inbox — reply pushback for external runtime.
    // Use the meta/hints snapshotted at entry (NOT module-level slots, which
    // may have been overwritten by a concurrent sendExternalMessage during
    // the await chain above).
    const lifecycleSessionId = getExternalLifecycleSessionId();
    if (lifecycleSessionId) {
      const watchText = capturedReplyText || getExternalAssistantText().trim();
      const watchError = finalizedTurnSucceeded
        ? undefined
        : {
            code: 'turn_failed',
            message:
              persistFailureReason ??
              'external runtime turn did not complete successfully',
          };
      void import('../inbox/watch-deliver')
        .then(({ deliverSessionWatchEvents }) =>
          deliverSessionWatchEvents(lifecycleSessionId, {
            text: watchText,
            turnId: resultTurnId, terminalStatus: finalizedTurnSucceeded ? 'complete' : 'error',
            requestEventIds: turnInboxMetas.map(meta => meta.originalMessageId),
            error: watchError,
            attachmentHints:
              turnAttachmentHints.length > 0 ? turnAttachmentHints : undefined,
          }, turnInboxMetas),
        )
        .catch((err) =>
          console.error(
            '[session-watch] external turn-end watch push failed:',
            err,
          ),
        );
    }

    notifyExternalTurnOutcome(terminalGeneration, {
      success: finalizedTurnSucceeded,
      text: capturedReplyText || getExternalAssistantText().trim(),
      ...(settledTurnDurationMs !== undefined
        ? { durationMs: settledTurnDurationMs }
        : {}),
      ...(settledTurnUsage
        ? {
            usage: {
              inputTokens: settledTurnUsage.inputTokens,
              outputTokens: settledTurnUsage.outputTokens,
            },
          }
        : {}),
      ...(persistFailureReason ? { error: persistFailureReason } : {}),
    });
    clearExternalTurnActivityFacts(turnActivityFacts);

    // Always reach idle, even if the body above threw. The
    // session_complete handler counts on us to drain the deferred idle.
    setExternalSessionState('idle');
    if (finalizedTurnSucceeded) {
      fireExternalImCallback(
        'complete',
        buildImCompletePayload(
          capturedReplyText || getExternalAssistantText().trim(),
        ),
      );
    } else {
      fireExternalImCallback(
        'error',
        buildImErrorPayload(
          persistFailureReason ??
            'external runtime turn did not complete successfully',
        ),
      );
    }
    // Pattern B/C: turn complete — clear active trace ID + unregister from registry.
    finalizeExternalActiveRequest(
      finalizedTurnSucceeded ? 'completed' : 'failed',
    );
    try {
      await reconcileDshExtensionsAtTurnBoundary();
    } catch (error) {
      console.warn(
        '[external-session] DSH extension boundary reconciliation failed:',
        summarizeExternalRuntimeMessageForLog(error),
      );
    }
    await applyPendingExternalProcessConfigInvalidation();
    // Mid-turn queue drain: a turn just ended (completed OR interrupted via force) → surface +
    // send the next queued desktop message. Deferred to the next macrotask so queue:started
    // never races chat:message-complete / chat:status idle on the SSE wire.
    setTimeout(() => drainExternalQueueAfterTurn(), 0);
    clearExternalTurnTrace();
  }
}

// ─── Private: UnifiedEvent → SSE broadcast ───

async function normalizeExternalToolResultForSse(
  event: Extract<UnifiedEvent, { kind: 'tool_result' }>,
  sessionId = getExternalLifecycleSessionId(),
): Promise<Extract<UnifiedEvent, { kind: 'tool_result' }>> {
  const spilled = await maybeSpill(event.content, {
    mimetype: 'text/plain; charset=utf-8',
    sessionId: sessionId || undefined,
  });
  if ('inline' in spilled) {
    return event;
  }
  return {
    ...event,
    content: spilled.preview,
    metadata: {
      ...(event.metadata ?? {}),
      largeValueRef: spilled,
    },
  };
}

const EXTERNAL_TOOL_INPUT_INLINE_MAX_BYTES = 192 * 1024;
const pendingExternalToolInputTransports = new Map<string, Promise<void>>();

function broadcastExternalToolUseStop(
  event: Extract<UnifiedEvent, { kind: 'tool_use_stop' }>,
  parentToolUseId: string | undefined,
  toolName: string | null,
): void {
  const product = getExternalProductContent();
  const sourceSessionId = getExternalLifecycleSessionId();
  const broadcastStop = (payload: {
    input?: Record<string, unknown>;
    inputRef?: unknown;
  }): void => {
    if (
      product &&
      getActiveSessionTranscript(sourceSessionId)?.writer !== product.writer
    )
      return;
    if (getExternalLifecycleSessionId() !== sourceSessionId) return;
    if (parentToolUseId && toolName) {
      (product ? publishExternalToolPresentation : broadcast)(
        'chat:subagent-tool-use',
        {
        parentToolUseId,
        tool: {
          id: event.toolUseId,
          name: toolName,
          input: payload.input ?? {},
          streamIndex: 0,
        },
        ...(payload.inputRef ? { inputRef: payload.inputRef } : {}),
        finalInput: true,
        },
      );
      return;
    }
    if (!parentToolUseId) {
      (product ? publishExternalToolPresentation : broadcast)(
        'chat:content-block-stop',
        {
        type: 'tool_use',
        toolId: event.toolUseId,
        ...payload,
        },
      );
    }
  };

  if (product) {
    // V2 uses the common immediate preview/ref transport; product IO cannot
    // delay either the input stop or the following result presentation.
    broadcastStop({ input: event.input });
    return;
  }

  if (!event.input) {
    broadcastStop({});
    return;
  }

  const serialized = JSON.stringify(event.input);
  if (
    Buffer.byteLength(serialized, 'utf-8') <=
    EXTERNAL_TOOL_INPUT_INLINE_MAX_BYTES
  ) {
    broadcastStop({ input: event.input });
    return;
  }

  const transport = maybeSpill(serialized, {
    inlineMaxBytes: EXTERNAL_TOOL_INPUT_INLINE_MAX_BYTES,
    previewBytes: 0,
    mimetype: 'application/json; charset=utf-8',
    sessionId: getExternalLifecycleSessionId() || undefined,
  })
    .then((spilled) => {
      if ('inline' in spilled) {
        broadcastStop({ input: event.input });
        return;
      }
      broadcastStop({ inputRef: spilled });
    })
    .catch((err) => {
      console.error('[external-session] tool input spill failed:', err);
      // The full input is already persisted server-side. Complete the live
      // block without re-introducing an oversized SSE payload; history restore
      // remains authoritative if the local ref could not be written.
      broadcastStop({});
    });
  const tracked = transport.finally(() => {
    if (pendingExternalToolInputTransports.get(event.toolUseId) === tracked) {
      pendingExternalToolInputTransports.delete(event.toolUseId);
    }
  });
  pendingExternalToolInputTransports.set(event.toolUseId, tracked);
  trackInFlightSave(tracked);
}

function applyExternalToolResult(
  event: Extract<UnifiedEvent, { kind: 'tool_result' }>,
): void {
  // Update the matching tool_use block's result + attachments (PRD 0.2.15)
  applyExternalToolResultToContent({
    toolUseId: event.toolUseId,
    content: event.content,
    isError: event.isError,
    metadata: event.metadata,
    attachments: event.attachments,
  });
  broadcast('chat:tool-result-start', {
    toolUseId: event.toolUseId,
    content: event.content,
    isError: event.isError ?? false,
    metadata: event.metadata,
    attachments: event.attachments,
  });
  // Emit complete immediately — external runtimes deliver tool results as a single event
  // (no streaming delta). Frontend needs this to clear tool loading spinner + trigger file refresh.
  broadcast('chat:tool-result-complete', {
    toolUseId: event.toolUseId,
    content: event.content,
    isError: event.isError ?? false,
    metadata: event.metadata,
    attachments: event.attachments,
  });
  // PRD 0.2.18 — accumulate attachment hints for inbox reply pushback
  // (only when this turn has inbox binding to avoid memory accumulation
  // for non-inbox turns).
  if (
    getExternalTurnInboxMeta() &&
    event.attachments &&
    event.attachments.length > 0
  ) {
    for (const a of event.attachments) {
      const hint =
        (a as { name?: string; path?: string; pendingId?: string }).name ??
        (a as { path?: string }).path ??
        '<attachment>';
      addExternalTurnAttachmentHint(hint);
    }
  }
  recordRuntimeActivity();
}

function dispatchExternalToolResult(
  event: Extract<UnifiedEvent, { kind: 'tool_result' }>,
  after?: Promise<void>,
): Promise<void> {
  emitExternalToolEndTrace(event.toolUseId, event.isError);
  const product = getExternalProductContent();
  const target = product?.tool(event.toolUseId);
  const sourceSessionId = getExternalLifecycleSessionId();
  const deliver = (
    normalized: Extract<UnifiedEvent, { kind: 'tool_result' }>,
  ) => {
    if (product) {
      if (
        !target ||
        getActiveSessionTranscript(sourceSessionId)?.writer !== product.writer
      )
        return;
      const parentId = target.subagentToolId
        ? (product.readBlock(target)?.tool as TranscriptObject | undefined)?.id
        : undefined;
      const tool = product.readTool(target);
      if (!tool) return;
      const payload = {
        sessionId: sourceSessionId,
        ...(parentId ? { parentToolUseId: parentId } : {}),
        toolUseId: normalized.toolUseId,
        content: normalized.content,
        isError: normalized.isError ?? false,
        metadata: normalized.metadata,
        attachments: tool.attachments,
      };
      if (!parentId) broadcast('chat:tool-result-start', payload);
      broadcast(
        parentId
          ? 'chat:subagent-tool-result-complete'
          : 'chat:tool-result-complete',
        payload,
      );
      return;
    }
      const subParent = getExternalChildToolParent(normalized.toolUseId);
      if (subParent) applySubagentToolResult(subParent, normalized);
      else applyExternalToolResult(normalized);
  };
  if (product) {
    deliver(event);
    return Promise.resolve();
  }
  const normalized = normalizeExternalToolResultForSse(
    event,
    sourceSessionId,
  ).catch((err) => {
      console.error('[external-session] tool_result spill failed:', err);
      const fallback: Extract<UnifiedEvent, { kind: 'tool_result' }> = {
        ...event,
        content: event.content.slice(0, 8 * 1024),
        metadata: {
          ...(event.metadata ?? {}),
          status: event.metadata?.status ?? 'large-result-spill-failed',
        },
      };
    return fallback;
    });
  return Promise.all([normalized, after]).then(([result]) => deliver(result));
}

function autoDenyNonInteractiveRequest(
  event: Extract<UnifiedEvent, { kind: 'permission_request' }>,
): boolean {
  const scenario = getExternalLifecycleScenario();
  if (scenario.type === 'desktop') return false;
  if (event.toolName !== 'AskUserQuestion') return false;
  const runtimeType =
    getExternalActiveRuntime()?.type ?? getCurrentRuntimeType();
  const runtimeSource =
    runtimeType === 'codex' ? getCurrentRuntimeSource() : undefined;
  const managedCodexDisabled = isManagedCodexStructuredUserInputDisabled(
    runtimeType,
    runtimeSource,
  );
  if (!managedCodexDisabled && !shouldDisallowAskUserQuestion(scenario))
    return false;
  const reason = managedCodexDisabled
    ? `External runtime AskUserQuestion request was denied because Managed Codex structured user input is disabled.`
    : `External runtime AskUserQuestion request was denied because this ${scenario.type} host does not support native-card interaction.`;
  console.warn(`[external-session] ${reason} requestId=${event.requestId}`);
  fireExternalImCallback('error', buildImErrorPayload(reason));
  const active = getExternalActivePair();
  if (active) {
    void active.runtime
      .respondPermission(
        active.process,
        event.requestId,
        'deny',
        reason,
        undefined,
        undefined,
        true,
      )
      .catch((err) =>
        console.error(
          `[external-session] auto-deny failed for requestId=${event.requestId}:`,
          err,
        ),
      );
  }
  return true;
}

function autoAllowFullAgencyNativeCardRequest(
  event: Extract<UnifiedEvent, { kind: 'permission_request' }>,
): boolean {
  if (event.interactionKind && event.interactionKind !== 'permission')
    return false;
  if (event.toolName === 'AskUserQuestion') return false;
  const scenario = getExternalLifecycleScenario();
  if (
    !shouldUseNonBypassForNativeAskUserQuestion(
      getExternalRuntimeDesiredPermissionMode(),
      scenario,
    )
  ) {
    return false;
  }
  const active = getExternalActivePair();
  if (!active) return false;
  console.log(
    `[external-session] native-card fullAgency fast-path: auto-approved ${event.toolName} requestId=${event.requestId}`,
  );
  void active.runtime
    .respondPermission(active.process, event.requestId, 'allow_once')
    .catch((err) =>
      console.error(
        `[external-session] fullAgency auto-allow failed for requestId=${event.requestId}:`,
        err,
      ),
    );
  return true;
}

function handleUnifiedEvent(event: UnifiedEvent): void {
  if (
    event.kind !== 'subagent_lifecycle' ||
    event.affectsRootActivity !== false
  ) {
    recordRuntimeActivity();
  }
  const isV2Content =
    Boolean(getExternalProductContent()) &&
    (Boolean(event.nativeSource) ||
      [
        'text_delta',
        'text_stop',
        'thinking_start',
        'thinking_delta',
        'thinking_stop',
        'tool_use_start',
        'tool_input_delta',
        'tool_use_stop',
        'tool_result_delta',
        'tool_result',
        'provider_tool_use_start',
        'provider_tool_result',
        'subagent_lifecycle',
        'tool_attachment_update',
        'message_replay',
        'native_retraction',
      ].includes(event.kind));
  if (
    isV2Content ||
    event.kind === 'turn_complete' ||
    event.kind === 'session_complete'
  ) {
    // Native terminal notifications can precede the turn/start response. Keep
    // accepted user -> assistant content ordered using the queue owner's native
    // admission promise. This never waits for product persistence. Early native
    // output cannot be assigned to the preceding user while the answer's actual
    // admission is still being resolved.
    const pending = getExternalPendingMessageOperations().find((operation) =>
      Boolean(
        operation.context.asyncQuestionReply &&
          isExternalTurnCurrent(operation.queueId) &&
          !operation.userProjection.retracted,
      ),
    );
    if (pending) {
      const generation = getExternalOperationGeneration();
      void pending.dispatchAcceptance.then((result) => {
        if (
          result.queued &&
          pending.userProjection.surfaced &&
          isCurrentExternalOperationGeneration(generation) &&
          isExternalTurnCurrent(pending.queueId)
        )
          applyUnifiedEvent(event);
      });
      return;
    }
  }
  applyUnifiedEvent(event);
}

function applyUnifiedEvent(event: UnifiedEvent): void {
  const eventExecutionTurnId = getExternalExecutionTurnId() ?? undefined;
  const presentation = getTranscriptPresentation();
  const source =
    event.nativeSource ??
    (presentation &&
    (event.kind === 'text_delta' || event.kind === 'text_stop') &&
    event.traceId
      ? {
          messageId: event.traceId,
          blockIndex: 0,
          parentToolUseId: event.subAgent?.parentToolUseId,
          ...(!presentation.hasNativeBlock(event.traceId, 0)
            ? { blockStart: { type: 'text', text: '' } }
            : {}),
        }
      : undefined);
  if (presentation && event.kind === 'native_retraction') {
    presentation.retractNativeContent(
      event.messageIds,
      event.parentToolUseId ? true : event.scope !== 'local',
      event.parentToolUseId,
    );
    return;
  }

  if (
    source &&
    presentation &&
    source.parentToolUseId &&
    event.kind !== 'message_replay'
  ) {
    const parentToolUseId = source.parentToolUseId;
    presentation.beginNativeMessage(source.messageId, parentToolUseId);
    if (source.blockStart && source.blockIndex !== undefined) {
      presentation.beginNativeBlock(
        source.blockIndex,
        source.blockStart as TranscriptObject,
        parentToolUseId,
      );
      const entry = presentation.childNativeBlock(
        parentToolUseId,
        source.blockIndex,
      );
      const tool = entry && presentation.content.readTool(entry.target);
      if (tool && (entry.type === 'text' || entry.type === 'thinking'))
        publishExternalUiEvent('chat:subagent-tool-use', {
          parentToolUseId,
          tool: {
            id: tool.id,
            name: tool.name,
            input: {},
            streamIndex: source.blockIndex,
          },
        });
    }
    if (
      (event.kind === 'text_delta' || event.kind === 'thinking_delta') &&
      source.blockIndex !== undefined
    ) {
      const target = presentation.appendChildNativeText(
        parentToolUseId,
        source.blockIndex,
        event.text,
      );
      if (target)
        publishExternalToolPresentation('chat:subagent-tool-result-delta', {
          parentToolUseId,
          toolUseId: target.subagentToolId,
          delta: event.text,
        });
      return;
    }
    if (
      (event.kind === 'text_stop' || event.kind === 'thinking_stop') &&
      source.blockIndex !== undefined
    ) {
      if (event.kind === 'text_stop' && event.nativeText !== undefined)
        presentation.confirmNativeBlocks(
          source.messageId,
          source.messageId,
          [{ type: 'text', text: event.nativeText }],
          parentToolUseId,
          'native',
        );
      const entry = presentation.childNativeBlock(
        parentToolUseId,
        source.blockIndex,
      );
      presentation.endNativeBlock(source.blockIndex, parentToolUseId);
      if (entry)
        publishExternalToolPresentation('chat:subagent-tool-result-complete', {
          parentToolUseId,
          toolUseId: entry.target.subagentToolId,
          content: presentation.content.readTool(entry.target)?.result ?? '',
        });
      return;
    }
    if (
      event.kind === 'tool_use_start' ||
      event.kind === 'tool_input_delta' ||
      event.kind === 'tool_use_stop'
    )
      event = { ...event, subAgent: { parentToolUseId } };
    else if (
      event.kind === 'raw' ||
      event.kind === 'status_change' ||
      event.kind === 'thinking_start'
    )
      return;
  }
  if (
    source &&
    presentation &&
    !source.parentToolUseId &&
    event.kind !== 'message_replay'
  ) {
    if (presentation.currentNativeMessageId !== source.messageId)
      presentation.beginNativeMessage(source.messageId);
    if (source.blockStart && source.blockIndex !== undefined)
      presentation.beginNativeBlock(
        source.blockIndex,
        source.blockStart as TranscriptObject,
      );
    if (event.kind === 'text_stop' && event.nativeText !== undefined)
      presentation.confirmNativeBlocks(
        source.messageId,
        source.messageId,
        [{ type: 'text', text: event.nativeText }],
        undefined,
        'native',
      );
    if (
      (event.kind === 'text_stop' ||
        event.kind === 'thinking_stop' ||
        event.kind === 'tool_use_stop') &&
      source.blockIndex !== undefined
    )
      presentation.endNativeBlock(source.blockIndex);
  }
  switch (event.kind) {
    case 'root_turn_admitted':
      getExternalProductContent()?.adoptRuntimeTurn(event.runtimeTurnId, event.clientUserMessageId);
      if (
        getCurrentRuntimeType() === 'codex' ||
        getCurrentRuntimeType() === 'dsh'
      ) {
        if (event.origin === 'collaboration') {
          clearExternalPrewarmingSession();
          setExternalTurnCompleted(false);
          setExternalLastTurnSucceeded(false);
          resetTurnAccumulators();
          seedTurnWatchdogEstimate();
          resetWatchdog();
          markExternalTurnStarted();
          beginExternalTurnTrace(
            'dsh_collaboration_turn_started',
            getExternalLifecycleSessionId(),
          );
          setExternalSessionState('running');
          setExternalRuntimeTurnAnchor({
            turnId: event.runtimeTurnId,
            origin: 'collaboration',
            clientOperationId: event.clientOperationId,
          });
        } else {
          setExternalRuntimeTurnAnchor({
            turnId: event.runtimeTurnId,
            rootUserMessageId: event.clientUserMessageId,
          });
        }
      }
      break;

    case 'turn_started':
      if (!isExternalTurnCompleted() && getExternalTurnStartTime() === 0) {
        clearExternalPrewarmingSession();
        markExternalTurnStarted();
        beginExternalTurnTrace(
          'external_runtime_turn_started',
          getExternalLifecycleSessionId(),
        );
        setExternalSessionState('running');
      }
      break;

    case 'text_delta':
      if (appendSubagentTraceDelta(event, 'AgentMessage')) {
        break;
      }
      closePendingThinkingProjection();
      emitExternalDeltaTrace('text', event.text);
      if (!presentation) {
      appendExternalAssistantText(event.text);
      appendExternalPendingText(event.text);
      }
      broadcast('chat:message-chunk', event.text);
      fireExternalImCallback('delta', event.text);
      break;

    case 'text_stop':
      if (completeSubagentTrace(event, 'AgentMessage')) {
        break;
      }
      // Text block ended — flush accumulated text into a content block
      console.log(
        `[external-session] text_stop: accumulated ${getExternalAssistantText().length} chars`,
      );
      flushPendingText('mirror-completed-block', event.asyncQuestions);
      // Mirror builtin: tell the renderer the trailing text block closed so it clears
      // `streamingTextActive` and the tail-fade stops (same bug class, sibling runtime
      // path). type:'text' is the discriminator; index is unused for the text case.
      broadcast('chat:content-block-stop', {
        index: -1,
        type: 'text',
        ...(event.asyncQuestions
          ? { asyncQuestions: event.asyncQuestions }
          : {}),
      });
      fireExternalImCallback('block-end', '');
      break;

    case 'thinking_start':
      if (startSubagentTrace(event, 'Thinking')) {
        break;
      }
      openPendingThinkingProjection(event.index);
      break;

    case 'thinking_delta':
      if (appendSubagentTraceDelta(event, 'Thinking')) {
        break;
      }
      if (
        !isExternalPendingThinkingActive() ||
        getExternalPendingThinkingIndex() !== event.index
      ) {
        // DSH exposes thinking deltas without separate block lifecycle events.
        // Synthesize the Product start before the first chunk so Renderer state
        // is ready to accept it.
        openPendingThinkingProjection(event.index);
      }
      emitExternalDeltaTrace('thinking', event.text);
      if (!presentation) appendExternalPendingThinkingText(event.text);
      // Frontend expects { index, delta } — match builtin SSE shape
      broadcast('chat:thinking-chunk', {
        index: event.index,
        delta: event.text,
      });
      recordRuntimeActivity();
      break;

    case 'thinking_stop':
      if (completeSubagentTrace(event, 'Thinking')) {
        break;
      }
      closePendingThinkingProjection();
      break;

    case 'tool_use_start':
      emitExternalToolStartTrace(
        event.toolUseId,
        event.toolName,
        !!event.subAgent,
      );
      // PRD 0.2.27 — sub-agent tool nests under its spawn card. If the parent
      // card is still streaming, the call is cached and attached when the parent
      // tool_use block is finalized; known sub-agent events never render flat.
      if (event.subAgent) {
        handleSubagentToolUseStart(event.subAgent.parentToolUseId, event);
        break;
      }
      closePendingThinkingProjection();
      flushPendingText('mirror-completed-block'); // Close any open text block before tool use
      if (!presentation)
      startExternalToolUseInput({
        toolUseId: event.toolUseId,
        toolName: event.toolName,
        toolInput: event.input,
      });
      broadcast('chat:tool-use-start', {
        id: event.toolUseId,
        name: event.toolName,
        input: event.input ?? {},
      });
      fireExternalImCallback('activity', '');
      break;

    case 'tool_input_delta': {
      // Route by the LATCHED map (set when the start nested), not by event.subAgent,
      // so all events for one tool stay on the same rendering path.
      const product = presentation?.content;
      const target = product?.tool(event.toolUseId);
      const parentForInput = product
        ? target?.subagentToolId
          ? ((product.readBlock(target)?.tool as TranscriptObject | undefined)
              ?.id as string | undefined)
          : undefined
        : appendExternalToolInputDelta(event.toolUseId, event.delta)
            .parentToolUseId;
      if (parentForInput) {
        broadcast('chat:subagent-tool-input-delta', {
          parentToolUseId: parentForInput,
          toolId: event.toolUseId,
          delta: event.delta,
        });
        recordRuntimeActivity();
        break;
      }
      broadcast('chat:tool-input-delta', {
        toolId: event.toolUseId,
        delta: event.delta,
      });
      recordRuntimeActivity(); // Tool streaming is activity — prevent killing long-running tools
      break;
    }

    case 'tool_use_stop': {
      if (presentation) {
        const product = presentation.content;
        const target = product.tool(event.toolUseId);
        if (!target) break;
        let input = event.input;
        const tool = product.readTool(target)!;
        if (!input && typeof tool.inputJson === 'string') {
          try {
            input = JSON.parse(tool.inputJson) as Record<string, unknown>;
          } catch {
            /* Preserve incomplete native input. */
          }
        }
        if (input) product.confirmInput(target, input as TranscriptObject);
        const parentId = target.subagentToolId
          ? ((product.readBlock(target)?.tool as TranscriptObject | undefined)
              ?.id as string | undefined)
          : undefined;
        broadcastExternalToolUseStop(
          { ...event, input },
          parentId,
          typeof tool.name === 'string' ? tool.name : null,
        );
        break;
      }
      if (event.input) {
        const product = getExternalProductContent();
        const target = product?.tool(event.toolUseId);
        if (target)
          product!.confirmInput(target, event.input as TranscriptObject);
      }
      const finalToolName = event.input
        ? replaceExternalToolUseInput(event.toolUseId, event.input)
        : null;
      // PRD 0.2.27 — sub-agent tool: finalize its nested input, no flat block / stop.
      // Routed by the latched map (consistent with how the start was rendered).
      const parentForStop = getExternalChildToolParent(event.toolUseId);
      if (parentForStop) {
        finalizeSubagentToolInput(parentForStop, event.toolUseId);
        broadcastExternalToolUseStop(event, parentForStop, finalToolName);
        break;
      }
      // Finalize tool use block from accumulated input
      finalizeExternalToolUseInput(event.toolUseId);
      broadcastExternalToolUseStop(event, undefined, finalToolName);
      break;
    }

    case 'tool_result_delta': {
      const product = presentation?.content;
      const target = product?.tool(event.toolUseId);
      const parentForResultDelta = product
        ? target?.subagentToolId
          ? ((product.readBlock(target)?.tool as TranscriptObject | undefined)
              ?.id as string | undefined)
          : undefined
        : getExternalChildToolParent(event.toolUseId);
      if (!product)
      appendExternalToolResultDeltaToContent(event.toolUseId, event.delta);
      if (parentForResultDelta) {
        broadcast('chat:subagent-tool-result-delta', {
          parentToolUseId: parentForResultDelta,
          toolUseId: event.toolUseId,
          delta: event.delta,
        });
        recordRuntimeActivity();
        break;
      }
      broadcast('chat:tool-result-delta', {
        toolUseId: event.toolUseId,
        delta: event.delta,
      });
      recordRuntimeActivity();
      break;
    }

    case 'tool_result': {
      const product = getExternalProductContent();
      const target = product?.tool(event.toolUseId);
      if (target) {
        product!.confirmText(target, 'result', event.content);
        product!.updateTool(
          target,
          {
            isLoading: false,
            isError: event.isError ?? false,
            ...(event.metadata
              ? { resultMeta: event.metadata as TranscriptObject }
              : {}),
          },
          true,
        );
        if (event.attachments)
          product!.confirmAttachments(
            target,
            event.attachments as unknown as TranscriptObject[],
          );
      }
      // Keep the stop→result order when a completion-owned tool input had to
      // spill before crossing SSE.
      const pendingInput = pendingExternalToolInputTransports.get(
        event.toolUseId,
      );
      const dispatched = product
        ? dispatchExternalToolResult(event, pendingInput)
        : pendingInput
        ? pendingInput.then(() => dispatchExternalToolResult(event))
        : dispatchExternalToolResult(event);
      trackInFlightSave(dispatched);
      break;
    }

    case 'provider_tool_use_start':
      closePendingThinkingProjection();
      flushPendingText('mirror-completed-block');
      if (!presentation) {
        startExternalProviderToolUse({
          toolUseId: event.toolUseId,
          toolName: event.toolName,
          providerRouteId: event.providerRouteId,
          providerBlockType: event.providerBlockType,
          toolInput: event.input,
        });
      }
      broadcast('chat:server-tool-use-start', {
        id: event.toolUseId,
        name: event.toolName,
        input: event.input,
        providerRouteId: event.providerRouteId,
        providerBlockType: event.providerBlockType,
      });
      broadcast('chat:content-block-stop', {
        index: -1,
        toolId: event.toolUseId,
        type: 'server_tool_use',
        input: event.input,
      });
      break;

    case 'provider_tool_result': {
      const product = getExternalProductContent();
      const target = product?.tool(event.toolUseId);
      const block = target ? product!.readBlock(target) : undefined;
      const correlated = product
        ? block?.type === 'server_tool_use' && block.providerRouteId === event.providerRouteId
        : applyExternalProviderToolResult({
            toolUseId: event.toolUseId,
            providerRouteId: event.providerRouteId,
            providerBlockType: event.providerBlockType,
            content: event.content,
            isError: event.isError,
            attachments: event.attachments,
          });
      if (!correlated) {
        console.warn(
          `[external-session] Ignoring uncorrelated Provider tool result ${event.toolUseId}`,
        );
        break;
      }
      if (product && target) {
        product.confirmText(target, 'result', event.content);
        product.updateBlock(target, { resultProviderBlockType: event.providerBlockType });
        product.updateTool(target, { isLoading: false, isError: event.isError }, true);
        if (event.attachments) product.confirmAttachments(target, event.attachments as unknown as TranscriptObject[]);
      }
      broadcast('chat:tool-result-complete', {
        toolUseId: event.toolUseId,
        content: event.content,
        isError: event.isError,
        providerRouteId: event.providerRouteId,
        providerBlockType: event.providerBlockType,
        ...(event.attachments ? { attachments: event.attachments } : {}),
      });
      break;
    }

    case 'subagent_lifecycle': {
      const product = presentation?.content;
      const target = product?.tool(event.parentToolUseId);
      const lifecycle = product
        ? mergeSubagentLifecycle(
            target
              ? (product.readTool(target)?.subagentLifecycle as unknown as
                  | SubagentLifecycle
                  | undefined)
              : undefined,
            event.status,
            event.observedAt,
          )
        : applyExternalSubagentLifecycle(event);
      broadcastExternalSubagentLifecycle(event.parentToolUseId, lifecycle);
      if (event.affectsRootActivity !== false) recordRuntimeActivity();
      break;
    }

    case 'tool_attachment_update': {
      const product = getExternalProductContent();
      if (product) {
        const target = product.tool(event.toolUseId);
        if (target) {
          const applied = product.updateAttachment(
            target,
            event.pendingId,
            event.attachment as unknown as TranscriptObject,
          );
          if (!applied) break;
          const parentId = target.subagentToolId
            ? (product.readBlock(target)?.tool as TranscriptObject | undefined)
                ?.id
            : undefined;
          broadcast(
            parentId
              ? 'chat:subagent-tool-attachment-update'
              : 'chat:tool-attachment-update',
            {
              sessionId: product.writer.status.sessionId,
              ...(parentId ? { parentToolUseId: parentId } : {}),
              toolUseId: event.toolUseId,
              pendingId: event.pendingId,
              attachment: event.attachment,
            },
          );
        }
        break;
      }
      // Async fulfillment of a placeholder attachment (PRD 0.2.15 §4.7.1).
      // Cross-review (#0.2.29) — a sub-agent tool's attachment lives on a nested
      // SubagentToolCall, not a top-level block, so the scan below can't see it.
      // Route it to the owning sub-agent call (content owner checks both the
      // persisted parent block and the pending map) + a subagent-scoped broadcast.
      const subAttParent = getExternalSubagentAttachmentParent(event.toolUseId);
      if (subAttParent) {
        const outcome = applyExternalSubagentAttachmentUpdate({
          parentToolUseId: subAttParent,
          toolUseId: event.toolUseId,
          pendingId: event.pendingId,
          attachment: event.attachment,
        });
        if (outcome === 'deferred') {
          // tool_result normalization has not established its placeholder yet.
          // The content owner applies this update atomically when that result lands.
          break;
        }
        if (outcome === 'missing') {
          console.warn(
            `[external-session] Ignoring unmatched sub-agent attachment update toolUseId=${event.toolUseId}`,
          );
          break;
        }
        broadcast('chat:subagent-tool-attachment-update', {
          parentToolUseId: subAttParent,
          toolUseId: event.toolUseId,
          pendingId: event.pendingId,
          attachment: event.attachment,
        });
        recordRuntimeActivity();
        break;
      }
      // Find the persisted tool block and replace the matching placeholder in-place,
      // then broadcast the same shape so the frontend can patch the rendered gallery.
      const outcome = applyExternalToolAttachmentUpdate({
        toolUseId: event.toolUseId,
        pendingId: event.pendingId,
        attachment: event.attachment,
      });
      if (outcome === 'deferred') {
        // A top-level tool result may still be queued behind input spilling.
        // Its placeholder/result event will carry the atomically patched array.
        break;
      }
      if (outcome === 'missing') {
        // A late async update without a live top-level placeholder has no
        // transcript owner. This includes an uncorrelated foreign child whose
        // causal buffer was discarded at the turn boundary: fail closed rather
        // than manufacturing a top-level attachment event in the renderer.
        console.warn(
          `[external-session] Ignoring unowned tool attachment update toolUseId=${event.toolUseId}`,
        );
        break;
      }
      broadcast('chat:tool-attachment-update', {
        toolUseId: event.toolUseId,
        pendingId: event.pendingId,
        attachment: event.attachment,
      });
      recordRuntimeActivity();
      break;
    }

    case 'permission_request': {
      if (autoDenyNonInteractiveRequest(event)) break;
      if (autoAllowFullAgencyNativeCardRequest(event)) break;
      const blocksRoot = event.affectsRootActivity ?? (event.review?.actor
        ? event.review.actor.origin === 'root'
        : !event.rootToolUseId || event.rootToolUseId === event.toolUseId);
      if (event.interactionKind === 'plan_approval') {
        const questions = Array.isArray(event.input.questions)
          ? event.input.questions
          : [];
        const question =
          questions[0] &&
          typeof questions[0] === 'object' &&
          !Array.isArray(questions[0])
            ? (questions[0] as Record<string, unknown>)
            : {};
        const requestPayload = {
          requestId: event.requestId,
          sessionId: getCurrentBoundSessionId() || undefined,
          blocksRoot,
          ...(typeof question.detail === 'string'
            ? { plan: question.detail }
            : {}),
          allowedPrompts: [] as [],
        };
        setExternalInteractiveRequest(event.requestId, {
          type: 'exit-plan-mode:request',
          data: requestPayload,
        });
        broadcast('exit-plan-mode:request', requestPayload);
        break;
      }
      // AskUserQuestion carries a structured payload (questions/options/previews) and
      // needs the dedicated wizard UI, not the generic allow/deny card. Route it through
      // the ask-user-question:request channel so the frontend mounts AskUserQuestionPrompt
      // and the user's answers flow back as CC `updatedInput.answers`.
      if (event.toolName === 'AskUserQuestion') {
        const validation = normalizeAskUserQuestionInput(event.input);
        if (!validation.ok) {
          // A question cannot be answered by allow/deny. Return an actionable
          // input error to its caller without pretending the user cancelled.
          const active = getExternalActivePair();
          if (active) {
            void active.runtime.respondPermission(active.process, event.requestId, 'deny', validation.error)
              .catch(error => console.error('[external-session] Invalid question response failed:', error));
          }
          break;
        }
        setExternalAskUserQuestion(event.requestId, {
          input: validation.input as unknown as Record<string, unknown>,
        });
        const questions = validation.input.questions;
        const previewFormat: 'html' | 'markdown' = 'html';
        const requestPayload = {
          requestId: event.requestId,
          sessionId: getCurrentBoundSessionId() || undefined,
          blocksRoot,
          questions,
          previewFormat,
        };
        setExternalInteractiveRequest(event.requestId, {
          type: 'ask-user-question:request',
          data: requestPayload,
        });
        broadcast('ask-user-question:request', requestPayload);
        if (supportsAskUserQuestionNativeCard(getExternalLifecycleScenario())) {
          fireExternalImCallback(
            'ask-user-question-request',
            JSON.stringify(requestPayload),
          );
        }
        break;
      }

      // Store suggestions so respondExternalPermission can echo them back for "always_allow"
      setExternalPermissionSuggestions(event.requestId, event.suggestions);
      const requestPayload = {
        requestId: event.requestId,
        sessionId: getCurrentBoundSessionId() || undefined,
        blocksRoot,
        toolName: event.toolName,
        toolUseId: event.toolUseId,
        input:
          event.review || event.reviewRef
            ? ''
            : typeof event.input === 'object'
              ? JSON.stringify(event.input).slice(0, 500)
              : String(event.input ?? '').slice(0, 500),
        ...(event.review === undefined ? {} : { review: event.review }),
        ...(event.reviewRef === undefined
          ? {}
          : { reviewRef: event.reviewRef }),
        ...(event.rootToolUseId === undefined
          ? {}
          : { rootToolUseId: event.rootToolUseId }),
        ...(event.display === undefined ? {} : { display: event.display }),
        ...(event.defaultToNo === undefined ? {} : { defaultToNo: event.defaultToNo }),
        ...(event.suppressAlwaysAllowRule === undefined ? {} : { suppressAlwaysAllowRule: event.suppressAlwaysAllowRule }),
      };
      setExternalInteractiveRequest(event.requestId, {
        type: 'permission:request',
        data: requestPayload,
      });
      broadcast('permission:request', requestPayload);
      fireExternalImCallback(
        'permission-request',
        JSON.stringify({
          requestId: event.requestId,
          toolName: event.toolName,
          input: event.input,
          ...(event.review === undefined ? {} : { review: event.review }),
          ...(event.reviewRef === undefined
            ? {}
            : { reviewRef: event.reviewRef }),
        }),
      );
      break;
    }

    case 'interactive_request_resolved': {
      const pending = getExternalInteractiveRequest(event.requestId);
      deleteExternalAskUserQuestion(event.requestId);
      deleteExternalInteractiveRequest(event.requestId);
      consumeExternalPermissionSuggestions(event.requestId);
      broadcastExternalInteractiveExpired(
        event.requestId,
        pending,
        'resolved',
        event.status,
      );
      recordRuntimeActivity();
      break;
    }

    case 'session_init': {
      // Capture runtime's session ID for multi-turn resume
      // CC: session_id from hook; Codex: threadId from thread/start response
      if (event.sessionId) {
        setExternalRuntimeSessionId(event.sessionId);
        // Persist to SessionMetadata for cross-restart resume.
        // Before product birth, retain the ID in the admitted pre-warm record.
        // The first real user turn freezes metadata with this native identity.
        const lifecycleSessionId = getExternalLifecycleSessionId();
        if (lifecycleSessionId && event.sessionId !== lifecycleSessionId) {
          const targetSessionId = lifecycleSessionId;
          const targetRuntimeId = event.sessionId;
          if (pendingExternalSessionBirth?.sessionId === targetSessionId) {
            pendingExternalSessionBirth = {
              ...pendingExternalSessionBirth,
              runtimeSessionId: targetRuntimeId,
            };
          }
          if (
            !pendingBirthForSession(targetSessionId) ||
            getActiveSessionTranscript(targetSessionId)
          ) {
          void updateSessionMetadata(targetSessionId, {
            runtime: getCurrentRuntimeType(),
            runtimeSource: getCurrentRuntimeSource(),
            runtimeSessionId: targetRuntimeId,
          })
            .then((updated) => {
              if (
                updated &&
                pendingExternalSessionBirth?.sessionId === targetSessionId &&
                  pendingExternalSessionBirth.runtimeSessionId ===
                    targetRuntimeId
              ) {
                pendingExternalSessionBirth = null;
              }
            })
            .catch((err) =>
              console.warn(
                '[external-session] runtimeSessionId persist failed:',
                err,
              ),
            );
        }
      }
      }
      const info: SystemInitInfo = {
        timestamp: new Date().toISOString(),
        session_id: event.sessionId,
        model: event.model,
        tools: event.tools,
      };
      if (event.model) {
        setExternalRuntimeLiveReportedModel(event.model);
      }
      // Match builtin broadcast shape: { info: {...}, sessionId } — top-level sessionId
      // is read by frontend for session ID sync (TabProvider).
      // `prewarm` preserves whether this initialization happened before a user
      // turn for runtime metadata/diagnostics. Renderer activity is owned by
      // chat:status and REST liveSessionState, never inferred from system-init.
      const systemInitPayload = buildExternalSystemInitPayload({
        info,
        runtime: getCurrentRuntimeType(),
        runtimeSource: getCurrentRuntimeSource(),
      });
      setExternalSystemInitPayload(systemInitPayload);
      broadcast('chat:system-init', systemInitPayload);
      break;
    }

    case 'runtime_tool_catalog': {
      const tools = [...event.tools];
      const systemInitPayload = getExternalSystemInitPayloadSnapshot();
      if (systemInitPayload) {
        setExternalSystemInitPayload({
          ...systemInitPayload,
          info: { ...systemInitPayload.info, tools },
        });
      }
      broadcast('chat:runtime-tool-catalog', {
        sessionId: getExternalLifecycleSessionId(),
        tools,
      });
      break;
    }

    case 'mcp_effective_update': {
      const { kind: _kind, ...runtimeSnapshot } = event;
      const snapshot = setExternalMcpEffectiveSnapshot(
        {
          ...runtimeSnapshot,
          observedAt: Date.now(),
        },
        getCurrentRuntimeType(),
        getCurrentRuntimeSource(),
      );
      broadcast('chat:mcp-effective-snapshot', snapshot);
      break;
    }

    case 'mcp_startup_admission_ready': {
      if (!isManagedCodexProductRuntime()) break;
      setManagedCodexExtensionRestartPending(true);
      broadcastManagedCodexExtensionDiagnostics(true);
      if (!isExternalSessionBusy()) {
        void applyPendingExternalProcessConfigInvalidation()
          .then(() => scheduleManagedCodexAdmissionReplacementPrewarm())
          .catch((error) => {
            console.warn(
              '[external-session] MCP admission idle replacement failed:',
              summarizeExternalRuntimeMessageForLog(error),
            );
          });
      }
      break;
    }

    case 'mcp_runtime_replacement_required': {
      if (!isManagedCodexProductRuntime()) break;
      pendingExternalCapabilityRestart = true;
      console.log(
        `[external-session] ${event.serverId} transport is ready for idle-boundary replacement`,
      );
      if (!isExternalSessionBusy()) {
        void applyPendingExternalProcessConfigInvalidation()
          .then(() => scheduleManagedCodexAdmissionReplacementPrewarm())
          .catch((error) => {
            console.warn(
              '[external-session] MCP transport idle replacement failed:',
              summarizeExternalRuntimeMessageForLog(error),
            );
          });
      }
      break;
    }

    case 'model_update':
      if (event.model) {
        setExternalRuntimeLiveReportedModel(event.model);
        updateExternalCurrentTurnUsageModel(event.model);
      }
      break;

    case 'runtime_diagnostics': {
      // Issue #194: runtime's self-report (auth, features, MCP, apps, effective env).
      // Sidecar log keeps a snapshot for unified-log triage; renderer renders the
      // diagnostic strip / details panel.
      const diagnostics = isManagedCodexProductRuntime()
        ? { ...event.diagnostics, extensions: getManagedCodexExtensionStatus() }
        : event.diagnostics;
      if (isDshProductRuntime() && diagnostics.extensions) {
        dshExtensionStatus = diagnostics.extensions;
      }
      if (isDshProductRuntime() && diagnostics.permissions) {
        dshPermissionStatus = diagnostics.permissions;
      }
      if (isManagedCodexProductRuntime())
        setManagedCodexRuntimeDiagnostics(diagnostics);
      console.log(
        `[external-session] runtime_diagnostics: runtime=${diagnostics.runtime} features=${diagnostics.features?.length ?? 0} mcp=${diagnostics.mcpServers?.length ?? 0} apps=${diagnostics.apps?.length ?? 0} auth=${diagnostics.auth?.authMethod ?? 'none'}`,
      );
      broadcast('chat:runtime-diagnostics', diagnostics);

      // The header only owns blocking failures. Optional degradation belongs
      // to the Logs panel; project one bounded summary here instead of making
      // the Renderer infer severity from raw extension component states.
      for (const entry of projectRuntimeDiagnosticLogEntries(diagnostics)) {
        emitRuntimeDiagnosticLogEntry(entry);
      }
      break;
    }

    case 'agent_plan_update': {
      setExternalAgentPlan(event.todos);
      broadcast('chat:agent-plan-update', {
        sessionId: getExternalLifecycleSessionId() || null,
        todos: event.todos,
      });
      break;
    }

    case 'user_message_cancelled': {
      const entry = takePendingRealtimeSteeredUserMessage(
        event.clientUserMessageId,
      );
      if (entry) {
        markExternalUserMessageRetracted(entry.operation);
        broadcast('queue:cancelled', { queueId: entry.queueId });
        finalizeRejectedExternalOperation(entry.operation, 'cancelled', 'Runtime cancelled queued input before consumption');
      }
      break;
    }

    case 'user_message_accepted': {
      void surfaceAcceptedRealtimeSteeredUserMessage(event.clientUserMessageId);
      break;
    }

    case 'status_change': {
      // Map runtime states to frontend session states (match builtin runtime behavior)
      const stateMap: Record<string, string> = {
        running: 'running',
        error: 'error',
        waiting_permission: 'running',
      };
      setExternalSessionState(
        (stateMap[event.state ?? ''] ?? 'idle') as ExternalSessionState,
      );
      break;
    }

    case 'turn_complete': {
      // Mark turn complete — session_complete will follow for CC -p mode
      clearWatchdog();
      // Defensive fallback: Codex should emit item/started userMessage for
      // accepted turn/steer input. If an older app-server does not, promote an
      // RPC-acknowledged pill at the turn boundary. An unresolved RPC is not
      // acceptance: it may still return the exact no-active rejection and must
      // remain available for turn-boundary demotion without transcript writes.
      if (getCurrentRuntimeType() !== 'dsh')
        surfaceAcknowledgedPendingRealtimeSteeredUserMessages();
      finalizeExternalSubagentLifecycleProjection(
        getExternalUserRequestedStop() ? 'interrupted' : 'failed',
      );
      const terminalGenerationBefore = getExternalTurnTerminalGeneration();
      const forceTransferInProgress = externalForceTransferQueueId !== null;
      const turnPlan = markExternalTurnComplete(event, {
        intentionalStopInProgress: getExternalUserRequestedStop(),
        forceTransferInProgress,
      });
      if (forceTransferInProgress) externalForceTransferQueueId = null;
      const terminalGeneration = getExternalTurnTerminalGeneration();

      if (turnPlan.kind !== 'persist-success') {
        const message = turnPlan.message;
        let dshTerminalSettlement: Promise<void> | null = null;
        if (
          getCurrentRuntimeType() === 'dsh' &&
          getExternalRuntimeTurnAnchor()?.origin !== 'collaboration'
        ) {
          dshTerminalSettlement = event.clientOperationId
            ? settleDshRootOperation({
                sessionId: getExternalLifecycleSessionId(),
                clientOperationId: event.clientOperationId,
              }).then((result) => {
                if (!result.success) throw new Error(result.error);
              })
            : Promise.reject(
                new Error(
                  'DSH non-success terminal lacks its exact operation identity',
                ),
              );
          dshTerminalSettlement = dshTerminalSettlement.catch((error) => {
            console.error(
              '[external-session] failed to settle DSH terminal journal:',
              error,
            );
            throw error;
          });
          trackExternalTurnFinalization(dshTerminalSettlement);
        }
        let completionTerminal: SessionCompletionTerminal | null = null;
        if (
          terminalGeneration > terminalGenerationBefore &&
          turnPlan.kind === 'failure'
        ) {
          const terminalText = currentExternalTurnTextSnapshot();
          if (turnPlan.cleanup === 'stopped') {
            completionTerminal = finalizeStoppedExternalTurn(
              terminalText,
              consumeExternalTurnMetrics(),
            );
          } else {
            completionTerminal = notifyFailedExternalTurn(
              terminalGeneration,
              terminalText,
              message,
            );
          }
        }
        console.warn(
          `[external-session] turn_complete: non-success status=${event.status ?? 'unknown'}, elapsed=${getExternalTurnStartTime() ? Date.now() - getExternalTurnStartTime() : 0}ms, message=${summarizeExternalRuntimeMessageForLog(message)}`,
        );
        if (turnPlan.kind === 'defer-to-stop') {
          console.log(
            '[external-session] turn_complete arrived during intentional stop; deferring idle/drain cleanup to stopExternalSession',
          );
          clearExternalPermissionSuggestions();
          drainPendingInteractiveRequestsAsExpired('stop');
          if (dshTerminalSettlement) {
            void dshTerminalSettlement.finally(() =>
              setTimeout(drainExternalQueueAfterTurn, 0),
            );
          }
          break;
        }

        const cleanup = turnPlan.cleanup;
        emitExternalTurnTrace('final', {
          status: 'error',
          detail: {
            source: 'turn_complete',
            turnStatus: event.status ?? 'unknown',
            error: summarizeExternalRuntimeMessageForLog(message),
          },
        });
        if (cleanup !== 'stopped') {
          broadcast('chat:agent-error', {
            message,
            userMessageId: getExternalRuntimeTurnAnchor()?.rootUserMessageId,
          });
          broadcast(
            'chat:message-error',
            withSessionCompletionTerminal(message, completionTerminal),
          );
        }
        fireExternalImCallback('error', buildImErrorPayload(message));
        finalizeExternalActiveRequest('failed');
        deliverExternalWatchError({
            turnId: eventExecutionTurnId,
          sessionId: getExternalLifecycleSessionId(),
          text: currentExternalTurnTextSnapshot(),
          errorCode: cleanup === 'stopped' ? 'session_aborted' : 'turn_failed',
          errorMessage: message,
        });
        clearExternalInboxMetaOnRejection({
          turnId: eventExecutionTurnId,
          sessionId: getExternalLifecycleSessionId(),
          errorCode: 'turn_failed',
          errorMessage: message,
        });
        const partialPersistence = persistExternalPartialAssistantProjection(
          cleanup === 'stopped' ? 'stopped' : 'error',
        ).catch((error) => {
          console.error(
            '[external-session] failed to persist partial assistant projection:',
            error,
          );
          throw error;
        });
        resetTurnAccumulators();
        clearExternalPermissionSuggestions();
        drainPendingInteractiveRequestsAsExpired('error');
        setExternalSessionState('idle');
        if (cleanup === 'stopped') {
          broadcast(
            'chat:message-stopped',
            withSessionCompletionTerminal(null, completionTerminal),
          );
        }
        const boundary = dshTerminalSettlement
          ? Promise.all([dshTerminalSettlement, partialPersistence])
          : partialPersistence;
        void boundary
          .then(scheduleExternalQueueDrainAfterTurnBoundary)
          .catch((error) => {
            const failure =
              error instanceof Error ? error.message : String(error);
            console.error(
              '[external-session] non-success turn boundary failed:',
              failure,
            );
            broadcast('chat:agent-error', { message: failure });
            clearExternalQueueWithCancellation('failed', failure);
          });
        break;
      }

      emitExternalTurnTrace('final', {
        status: 'ok',
        detail: {
          textChars: getExternalAssistantText().length,
          blocks: getExternalContentBlockCount(),
        },
      });
      console.log(
        `[external-session] turn_complete: text=${getExternalAssistantText().length}chars, blocks=${getExternalContentBlockCount()}, elapsed=${getExternalTurnStartTime() ? Date.now() - getExternalTurnStartTime() : 0}ms`,
      );
      // Fire-and-forget: handleUnifiedEvent is a sync stream callback; persistTurnResult is async.
      // Tracked by turnFinalization so idle-waiters / the next turn wait for the flush.
      trackExternalTurnFinalization(
        persistTurnResult(terminalGeneration, event.clientOperationId).catch(
          (err) =>
            console.error(
              '[external-session] persistTurnResult (turn_complete) failed:',
              err,
            ),
        ),
      );
      break;
    }

    case 'session_complete': {
      clearWatchdog();
      finalizeExternalSubagentLifecycleProjection(
        getExternalUserRequestedStop() ? 'interrupted' : 'failed',
      );
      console.log(
        `[external-session] session_complete: subtype=${event.subtype}, result=${(event.result || '').length > 0 ? `${(event.result || '').length}chars` : 'empty'}, turnCompleted=${isExternalTurnCompleted()}, assistantText=${getExternalAssistantText().length}chars`,
      );
      // Track whether persistTurnResult is in-flight (or was already fired by
      // turn_complete). When true, persistTurnResult will broadcast
      // chat:message-complete + setExternalSessionState('idle') itself, in
      // that order. We MUST NOT fire idle synchronously below, because
      // persistTurnResult is async (awaits disk writes) and the synchronous
      // idle would race ahead of message-complete on the SSE wire — the
      // renderer's chat:status idle handler clears isStreamingRef, and the
      // subsequent flushPendingChunks at message-complete bails its updater,
      // dropping every chunk that hadn't yet RAF-flushed. v0.2.14 cross-bugfix.
      //
      // Use the actual finalization gate rather than `turnCompleted`: a
      // non-success turn (Codex interrupted/cancelled) also reaches
      // turn_complete, but intentionally does not persist an assistant message.
      // Set this BEFORE the if/else so the error branch also honours the
      // in-flight contract.
      let persistInFlight = isExternalTurnFinalizationInFlight();
      const terminalGenerationBefore = getExternalTurnTerminalGeneration();
      const forceTransferInProgress = externalForceTransferQueueId !== null;
      const presentedAssistantText = currentExternalTurnTextSnapshot();
      const sessionPlan = markExternalSessionComplete(event, {
        hasAssistantText: !!presentedAssistantText.trim(),
        isUserRequestedStop: () => getExternalUserRequestedStop() || forceTransferInProgress,
      });
      const terminalGeneration = getExternalTurnTerminalGeneration();
      if (sessionPlan.kind === 'ignore-prewarm-exit') {
        console.log(
          `[external-session] Ignoring pre-warm exit (subtype=${event.subtype}) — no user turn was in flight; next send will start fresh`,
        );
      } else if (sessionPlan.kind === 'success') {
        // CC slash commands (e.g. /context, /cost) return output directly in `result`
        // without streaming text_delta events. V2 text is owned by the product
        // transcript; the legacy assistantText accumulator stays empty there.
        if (event.result && sessionPlan.shouldFinalize && !presentedAssistantText.trim()) {
          appendExternalAssistantText(event.result);
          appendExternalPendingText(event.result);
          broadcast('chat:message-chunk', event.result);
        }
        // Only finalize if turn_complete didn't already (Codex emits turn_complete; CC uses session_complete only)
        if (sessionPlan.shouldFinalize) {
          emitExternalTurnTrace('final', {
            status: 'ok',
            detail: {
              textChars: getExternalAssistantText().length,
              blocks: getExternalContentBlockCount(),
              source: 'session_complete',
            },
          });
          // Fire-and-forget: handleUnifiedEvent is a sync stream callback; persistTurnResult is async.
          // Tracked by turnFinalization so idle-waiters / the next turn wait for the flush.
          trackExternalTurnFinalization(
            persistTurnResult(terminalGeneration).catch((err) =>
              console.error(
                '[external-session] persistTurnResult (session_complete) failed:',
                err,
              ),
            ),
          );
          persistInFlight = true;
        }
        // else: turn_complete already fired persistTurnResult — persistInFlight
        // was already initialized from the turnFinalization gate. The async
        // broadcast it emits after chat:message-complete is the authoritative
        // idle.
      } else {
        const errorMessage = sessionPlan.message;
        let completionTerminal: SessionCompletionTerminal | null = null;
        if (
          terminalGeneration > terminalGenerationBefore &&
          !persistInFlight &&
          sessionPlan.kind === 'failure'
        ) {
          completionTerminal = notifyFailedExternalTurn(
            terminalGeneration,
            currentExternalTurnTextSnapshot(),
            errorMessage,
          );
        }
        if (sessionPlan.kind === 'ignore-idle') {
          console.log(
            `[external-session] Ignoring idle-exit ${summarizeExternalRuntimeMessageForLog(errorMessage)} — process was between turns; next message will auto-resume`,
          );
        } else if (sessionPlan.kind === 'suppress-user-stop') {
          emitExternalTurnTrace('final', {
            status: 'error',
            detail: {
              source: 'user_stop',
              error: summarizeExternalRuntimeMessageForLog(errorMessage),
            },
          });
          console.log(
            `[external-session] Suppressing error banner for intentional interruption (was: ${summarizeExternalRuntimeMessageForLog(errorMessage)})`,
          );
          deliverExternalWatchError({
            turnId: eventExecutionTurnId,
            sessionId: getExternalLifecycleSessionId(),
            text: currentExternalTurnTextSnapshot(),
            errorCode: 'session_aborted',
            errorMessage:
              'external runtime session was stopped before turn completed',
          });
          if (forceTransferInProgress && !getExternalUserRequestedStop()) {
            const partialPersistence =
              persistExternalPartialAssistantProjection('stopped');
            persistInFlight = true;
            externalForceTransferQueueId = null;
            void partialPersistence
              .then(() => {
                resetTurnAccumulators();
                setExternalSessionState('idle');
                scheduleExternalQueueDrainAfterTurnBoundary();
              })
              .catch((error) => {
                const failure =
                  error instanceof Error ? error.message : String(error);
                console.error(
                  '[external-session] force-transfer partial persistence failed:',
                  failure,
                );
                resetTurnAccumulators();
                setExternalSessionState('idle');
                broadcast('chat:agent-error', { message: failure });
                clearExternalQueueWithCancellation('failed', failure);
              });
          }
          // stopExternalSession owns ordinary user-stop snapshots. Keep their
          // partial text/usage intact until it consumes them after process exit.
        } else {
          emitExternalTurnTrace('final', {
            status: 'error',
            detail: {
              source: 'session_complete',
              error: summarizeExternalRuntimeMessageForLog(errorMessage),
            },
          });
          if (!isExternalTurnCompleted()) {
            void persistExternalPartialAssistantProjection('error').catch(
              (error) => {
                console.error(
                  '[external-session] failed to persist partial assistant projection:',
                  error,
                );
              },
            );
          }
          broadcast('chat:agent-error', {
            message: errorMessage,
            userMessageId: getExternalRuntimeTurnAnchor()?.rootUserMessageId,
          });
          broadcast(
            'chat:message-error',
            withSessionCompletionTerminal(errorMessage, completionTerminal),
          );
          fireExternalImCallback('error', buildImErrorPayload(errorMessage));
          deliverExternalWatchError({
            turnId: eventExecutionTurnId,
            sessionId: getExternalLifecycleSessionId(),
            text: currentExternalTurnTextSnapshot(),
            errorCode: 'turn_failed',
            errorMessage,
          });
          // Same finalization-ownership rule as the suppress branch above.
          resetTurnAccumulators(); // Partial content was snapshotted before reset.
        }
      }
      clearExternalPermissionSuggestions();
      drainPendingInteractiveRequestsAsExpired('error'); // PRD #131 — runtime crash/watchdog kill: clear stale modals
      setExternalSystemInitPayload(null);
      // Only set idle synchronously when persistTurnResult is NOT going to
      // do it itself. Otherwise we'd race chat:status idle ahead of
      // chat:message-complete (see persistInFlight comment above).
      if (!persistInFlight) {
        setExternalSessionState('idle');
        // Drain queued desktop messages on a failed turn too, so pills don't stick (the next
        // item resumes a fresh process via sendExternalMessage Case 2 if needed).
        if (getExternalUserRequestedStop()) {
          setTimeout(() => drainExternalQueueAfterTurn(), 0);
          clearExternalTurnTrace();
        } else {
          scheduleExternalQueueDrainAfterTurnBoundary();
        }
      }
      // Clean up module state — prevents stuck sessions on CC crash
      releaseManagedCodexExtensionGeneration(
        getExternalActiveProcess()?.runtimeGeneration,
      );
      clearExternalActiveRuntimeProcess();
      break;
    }

    case 'usage': {
      // Store latest token usage.
      // Codex emits running totals, while other runtimes may emit per-turn deltas.
      const previousUsage = getExternalCurrentTurnUsage();
      const nextUsage: ExternalTurnUsage = {
        inputTokens: event.inputTokens,
        outputTokens: event.outputTokens,
        cacheReadTokens: event.cacheReadTokens,
        cacheCreationTokens: event.cacheCreationTokens,
        model:
          event.model ||
          previousUsage?.model ||
          getExternalRuntimeLiveReportedModel() ||
          undefined,
        modelUsage: event.modelUsage,
        semantics: event.semantics,
      };
      setExternalCurrentTurnUsage(nextUsage);
      recordRuntimeActivity();

      // PRD 0.2.32 — 并发 context 用量快照。Codex 的 tokenUsage 通知在 turn 中流式到达
      // → 亚轮实时刷新；CC 每轮一次。
      //
      // 占用**只用各 adapter 显式给出的 `contextOccupiedTokens`**（= 最近一次调用的 input 系
      // token），不从 `event.inputTokens` 推算——因为 `inputTokens` 的语义随 runtime 不同：
      // Codex 是 running_total（累计，watchdog 用），CC 的 result.usage 是整 turn 累计。
      // 任一用作占用都会高估、让圆环钉死在 ~100%。所以 adapter
      // 各自设 `contextOccupiedTokens`（codex=last.inputTokens /
      // cc=最近一条主轮 assistant message 的 input+cache），缺失时**不发**（宁可不显示也不显错）。
      const ctxOccupied = event.contextOccupiedTokens;
      const ctxRuntime =
        getExternalActiveRuntime()?.type ?? getCurrentRuntimeType();
      if (
        typeof ctxOccupied === 'number' &&
        ctxOccupied > 0 &&
        ctxRuntime !== 'builtin'
      ) {
        const ctxUsage = computeContextUsage({
          occupiedTokens: ctxOccupied,
          runtimeWindow: event.runtimeContextWindow ?? null,
          source: ctxRuntime,
          model: nextUsage.model,
          lookupWindow: lookupModelContextLength,
        });
        const ctxSessionId =
          currentTurnTraceSessionId ||
          getExternalLifecycleSessionId() ||
          undefined;
        broadcast(
          'chat:context-usage',
          ctxSessionId ? { ...ctxUsage, sessionId: ctxSessionId } : ctxUsage,
        );
        // PRD 0.2.32 — 留住本轮最新快照；Codex 亚轮会多次进这里，不每次写盘，turn 末
        // persistTurnResult 快照后写一次（单一数据源，供重开 seed）。
        setExternalCurrentTurnContextUsage(ctxUsage);
      }
      break;
    }

    case 'context_update': {
      const contextUsage = computeContextUsage({
        occupiedTokens: event.contextOccupiedTokens,
        runtimeWindow: event.runtimeContextWindow,
        source: getExternalActiveRuntime()?.type ?? getCurrentRuntimeType(),
        model: getExternalRuntimeDisplayModel() ?? undefined,
        lookupWindow: lookupModelContextLength,
      });
      const sessionId =
        currentTurnTraceSessionId ||
        getExternalLifecycleSessionId() ||
        undefined;
      broadcast(
        'chat:context-usage',
        sessionId ? { ...contextUsage, sessionId } : contextUsage,
      );
      setExternalCurrentTurnContextUsage(contextUsage);
      break;
    }

    case 'log':
      if (event.level === 'error') {
        console.error(`[external-runtime] ${event.message}`);
      } else if (event.level === 'warn') {
        console.warn(`[external-runtime] ${event.message}`);
      } else {
        console.log(`[external-runtime] ${event.message}`);
      }
      // Issue #194: surface warn/error to the renderer so the user sees them
      // in the chat log panel rather than only the unified log. Info-level is
      // log-only — it's high-volume runtime noise (turn/tool lifecycle).
      // Shape MUST match LogEntry (src/shared/types/log.ts) — the shared
      // `chat:log` handler discriminates on `source in data` and drops anything
      // without it. `source: 'bun'` is correct: the sidecar is the writer.
      if (event.level === 'warn' || event.level === 'error') {
        broadcast('chat:log', {
          source: 'bun',
          level: event.level,
          message: event.message,
          timestamp: new Date().toISOString(),
          runtime: getCurrentRuntimeType(),
        });
      }
      break;

    case 'message_replay': {
      // CC's --include-partial-messages outputs complete message objects alongside streaming.
      // Three categories:
      //   1. role=assistant — partial snapshots (SKIP: stream_event deltas already delivered content)
      //   2. role=user, content=string — real user message echo (SKIP if duplicate, REPLAY for resume)
      //   3. role=user, content=array — CC tool_result containers (SKIP as user msg, EXTRACT tool results)
      const replayRole = event.message.role;
      const replayContent = event.message.content;

      if (replayRole === 'user' && Array.isArray(replayContent)) {
        // CC sends tool results as type='user' messages with content=[{type:'tool_result',...}].
        // Don't broadcast as user message (creates ghost empty bubbles).
        // Instead, extract tool_result blocks and emit proper tool-result-complete events
        // so the frontend can close tool loading indicators.
        for (const block of replayContent as Array<Record<string, unknown>>) {
          if (block.type === 'tool_result' && block.tool_use_id) {
            const resultText =
              typeof block.content === 'string'
                ? block.content
                : Array.isArray(block.content)
                  ? (block.content as Array<Record<string, unknown>>)
                      .map((b) => (b.text as string) || '')
                      .join('\n')
                  : block.content != null
                    ? JSON.stringify(block.content)
                    : '';
            const product = getExternalProductContent();
            const target = product?.tool(String(block.tool_use_id));
            if (target) {
              product!.confirmText(target, 'result', resultText);
              product!.updateTool(
                target,
                { isLoading: false, isError: block.is_error === true },
                true,
              );
            }
            const parentToolUseId = target?.subagentToolId
              ? (
                  product?.readBlock(target)?.tool as
                    | TranscriptObject
                    | undefined
                )?.id
              : undefined;
            broadcast(
              parentToolUseId
                ? 'chat:subagent-tool-result-complete'
                : 'chat:tool-result-complete',
              {
                ...(parentToolUseId ? { parentToolUseId } : {}),
              toolUseId: block.tool_use_id,
              content: resultText.slice(0, 2000), // Truncate for SSE
              isError: block.is_error === true,
              },
            );
            // Update the already-persisted tool_use block with its result.
            // tool_use_stop already consumed pendingToolInputs and pushed to currentContentBlocks,
            // so we find the existing block and add the result (same pattern as tool_result handler).
            if (!product)
            applyExternalReplayedToolResultToContent({
              toolUseId: String(block.tool_use_id),
              content: resultText,
              isError: block.is_error === true,
            });
            recordRuntimeActivity();
          }
        }
        break;
      }

      if (replayRole === 'user') {
        // Real user message replay (for session resume scenarios).
        // Skip during active streaming — we already broadcast user message from sendExternalMessage.
        if (
          isExternalLifecycleRunning() &&
          getExternalSessionMessageCount() > 0
        ) {
          break;
        }
        // Ensure timestamp exists for frontend rendering
        const replayMsg = event.message.timestamp
          ? event.message
          : { ...event.message, timestamp: new Date().toISOString() };
        // This is RESUME history replay (not a live send echo — those come from
        // sendExternalMessage above). Tag it cold-history so a REST-restored
        // session suppresses it (REST owns ordered history) without suppressing
        // the live user echo (#0608).
        broadcast('chat:message-replay', {
          message: replayMsg,
          replayKind: 'cold-history',
        });
      }
      // Assistant replay: normally dropped because stream_event deltas already delivered
      // the content. But if stream deltas were missing (short response, rate limiting,
      // API truncation), the replay is the only source of truth. Use it as fallback.
      if (replayRole === 'assistant' && presentation && source) {
        const blocks =
          typeof replayContent === 'string'
            ? [{ type: 'text', text: replayContent }]
            : Array.isArray(replayContent)
              ? (replayContent as TranscriptObject[])
              : [];
        const unseenTools = new Set(
          blocks
            .filter(
              (block) =>
                typeof block.id === 'string' &&
                !presentation.content.tool(block.id),
            )
            .map((block) => block.id),
        );
        const changes = presentation.confirmNativeBlocks(
          source.messageId,
          event.message.id,
          blocks,
          source.parentToolUseId,
        );
        for (const { textDelta } of changes)
          if (textDelta && !source.parentToolUseId) {
            fireExternalImCallback('delta', textDelta);
          }
        const product = presentation.content;
        const publish = publishExternalToolPresentation;
        if (source.parentToolUseId) {
          for (const { target } of changes) {
            const tool = product.readTool(target);
            if (!tool) continue;
            const input =
              tool.inputComplete && typeof tool.inputJson === 'string'
                ? JSON.parse(tool.inputJson)
                : {};
            publish('chat:subagent-tool-use', {
              parentToolUseId: source.parentToolUseId,
              tool: { id: tool.id, name: tool.name, input, streamIndex: 0 },
              finalInput: true,
            });
            if (typeof tool.result === 'string')
              publish('chat:subagent-tool-result-complete', {
                parentToolUseId: source.parentToolUseId,
                toolUseId: tool.id,
                content: tool.result,
              });
          }
          break;
        }
        for (const block of blocks) {
          if (
            (block.type !== 'tool_use' && block.type !== 'server_tool_use') ||
            typeof block.id !== 'string'
          )
            continue;
          if (unseenTools.has(block.id))
            publish('chat:tool-use-start', {
              id: block.id,
              name: block.name,
              input: {},
              streamIndex: 0,
            });
          if (block.input)
            publish('chat:content-block-stop', {
              toolId: block.id,
              type: block.type,
              input: block.input,
            });
        }
        recordRuntimeActivity();
        break;
      }
      if (replayRole === 'assistant' && !getExternalAssistantText().trim()) {
        const content = replayContent;
        let text = '';
        if (typeof content === 'string') {
          text = content;
        } else if (Array.isArray(content)) {
          text = (content as Array<Record<string, unknown>>)
            .filter((b) => b.type === 'text')
            .map((b) => (b.text as string) || '')
            .join('');
        }
        if (text.trim()) {
          console.log(
            `[external-session] Assistant message_replay fallback: stream had no text, using replay (${text.length} chars)`,
          );
          broadcast('chat:message-chunk', text);
          appendExternalAssistantText(text);
          appendExternalPendingText(text);
          recordRuntimeActivity();
        }
      }
      break;
    }

    case 'native_retraction': // V1 keeps its existing replay behavior.
    case 'raw':
      // Unrecognized event — ignore
      break;
  }
}

/** Preserve the active generation's frozen proxy/env policy for auxiliary inference. */
export async function runExternalTextUtility(input: import('./types').RuntimeTextUtilityTask & {
  runtime: RuntimeType; runtimeSource?: import('../../shared/types/runtime').RuntimeSource;
  model: string; workspacePath?: string;
}): Promise<string | null> {
  const { runExternalTextUtility: run } = await import('./external-session/text-utility');
  return run({ ...input, envPolicy: activeExternalEnvPolicy });
}

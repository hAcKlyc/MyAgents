import { randomUUID } from 'crypto';
import { existsSync, readFileSync, writeFileSync } from 'fs';
import { join, resolve } from 'path';
import { createRequire } from 'module';
import { query, getSessionMessages as sdkGetSessionMessages, forkSession as sdkForkSession, deleteSession as sdkDeleteSession, type Query, type SDKUserMessage, type AgentDefinition, type HookInput, type HookJSONOutput, type PreToolUseHookInput, type PostToolUseHookInput, type PermissionRequestHookInput, type SlashCommand as SdkSlashCommand } from '@anthropic-ai/claude-agent-sdk';
import { SDK_BUILTIN_TOOLS } from './sdk-builtin-tools';
import {
  decideBackgroundAgentPermission,
  isBackgroundAgentToolRequest,
  backgroundAgentDenyMessage,
  type BackgroundAgentPermissionMode,
} from './utils/background-agent-permission';
import { registerBridge as registerBridgeInRegistry, unregisterBridge as unregisterBridgeInRegistry, type UpstreamBridgeConfig } from './openai-bridge/bridge-registry';
import { getScriptDir } from './utils/runtime';
import { resolveNpxMcpInvocation } from './utils/mcp-command';
import { resolveRemoteMcpTransportConfig } from './session-core/mcp-template-resolution';
import { getCrossPlatformEnv } from './utils/platform';
import { ensureDirSync } from './utils/fs-utils';
import { getMyAgentsNpmGlobalBinDir, getMyAgentsNpmGlobalPrefix, scrubMyAgentsNpmPrefixEnv } from './utils/npm-prefix-env';
import { buildSessionExecutablePath } from './utils/session-executable-path';
import {
  applyContextWindowSuffixForContextLength,
  applyProviderContextWindowSuffix,
  lookupSnapshotModelContextLength,
  lookupProviderModelContextLength,
  modelSupportsModality,
  snapshotProviderModelContextLengths,
  type ModelContextLengthSnapshot,
} from './utils/model-capabilities';
import { modelAliasEnvChangesForModel, resolveSessionModelAliases } from './utils/model-aliases';
import { resolveEffectiveResumeAt } from './utils/rewind-anchor';
import { attemptFileRewind, type FileRewindStatus } from './utils/rewind-file-result';
import { summarizeSensitiveSdkMessage } from './utils/sdk-log-summary';
import { buildForkUuidRemap, remapStoredSdkUuids } from './utils/fork-remap';
import {
  decideInFlightCancelSettlement,
  reconcileInterruptReceipt,
  terminalEventMatchesInFlight,
  type InFlightAsyncCancelResult,
} from './utils/inflight-terminal';
import { shouldBlockToolInPlanMode, planModeDenyMessage, isPlanModeInEffect, PLAN_MODE_READONLY_TOOLS, PLAN_MODE_HOST_INTERACTION_TOOLS, applyPermissionModeSelection, computePlanExitState, computeRestoredPlanState } from './utils/plan-mode-gate';
import { planRetraction } from './utils/message-retraction';
import type { TransientProviderTextRetryDecision } from './session-core/turn-result-policy';
import {
  buildResumeAnchorReplayItem,
  extractSdkMissingResumeMessageUuid,
  isSdkMissingResumeMessageError,
  shouldSuppressRecoveredResumeAnchorError,
  type InvalidResumeAnchorKind,
} from './session-core/resume-error-recovery';
import { diagnoseSdkSubprocessFailure } from './utils/sdk-subprocess-diagnostics';
import { createGuardedSdkQuery } from './utils/sdk-child-launch-guard';
import { InactivityWatchdog } from './utils/inactivity-watchdog';
import {
  SESSION_PLANS_GITIGNORE_PATTERN,
  clearSessionPlanMarkdown,
  getSessionPlansDirectoryPath,
  getSessionPlansDirectorySetting,
  readLatestPlanMarkdownWithRetry,
} from './utils/plan-files';
import { WATCHDOG_RESUME_REMINDER, planWatchdogAutoResume, shouldAdoptPendingContinueIntoScheduledAutoResume, shouldConsumePendingContinueAfterAbort, shouldDeferPendingContinueToScheduledAutoResume, shouldPrependWatchdogAutoResume } from './utils/watchdog-auto-resume';
import { processImage, resizeToolImageContent, classifyImageError } from './utils/imageResize';
import { writeBase64FilesToAgentDir } from './utils/workspace-files';
import { ensureGitignorePattern } from './utils/gitignore';
// Context helpers only — tool server singletons are no longer exported from
// these modules. The actual SDK server objects are created on-demand via
// `getBuiltinMcpInstance()` in buildSdkMcpServers() below. See
// ./tools/builtin-mcp-meta.ts for META registrations.
import { clearCronTaskContext } from './tools/cron-tools';
import { getImCronContext, setSessionCronContext, clearSessionCronContext } from './tools/im-cron-tool';
import {
  clearImBridgeToolsContext,
  getImBridgeToolPrewarmWindow,
  getImBridgeToolServer,
  getImBridgeToolSurface,
  imBridgeToolSurfaceIdentity,
} from './tools/im-bridge-tools';
import { getBuiltinMcpInstance } from './tools/builtin-mcp-registry';
// Side-effect import — registers META (ids + lazy factories) at cold start.
// Cheap: just function-ref storage, no SDK/zod eval, no tool module loaded.
import './tools/builtin-mcp-meta';
import {
  applyProviderProxyPolicyToEnv,
  getProviderProxyScopeKey,
  initializeProxyStateFromCurrentSettings,
  setProcessProxyConfig,
} from './proxy-state';
import { buildMcpSubprocessEnv } from './session-core/mcp-env-policy';
import { resolveManagedOAuthCredential, type ManagedOAuthPurpose } from './utils/management-api-client';
import {
  acquireBrowserCapability,
  adoptBrowserProductSession,
} from './browser-host/capability-client';
import {
  mcpStartupExecutableIdentity,
  settleMcpStartupLease,
  startMcpStartupDemand,
  type McpStartupDemand,
  type McpStartupLease,
} from './session-core/mcp-startup-admission-client';
// Phase E (PRD 0.2.7): the sidecar file watcher (`file-watcher.ts` →
// SSE `workspace:files-changed`) is removed. The renderer subscribes to
// the Rust workspace_files watcher (Tauri event
// `workspace:files-changed:<eventKey>`) instead.
import { onOAuthCredentialChange, resolveAuthHeaders } from './mcp-oauth';
// Side-effect imports: each registers itself in the builtin MCP registry
// gemini-image / edge-tts registered in builtin-mcp-meta.ts.

import type { ToolInput } from '../shared/types/tool-input';
import {
  buildFilePatchDisplayDescriptor,
} from '../shared/toolDisplay/filePatch';
import { parsePartialJson } from '../shared/parsePartialJson';
import { deriveSessionTitle } from '../shared/sessionTitle';
import { createLiveUserMessageReplay } from '../shared/chatMessageReplay';
import { isPendingSessionId } from '../shared/constants';
import { MANAGED_BROWSER_MCP_ID } from '../shared/browserTools';
import { workspacePathsEqual } from '../shared/workspacePath';
import { normalizeReasoningEffort, isSdkEffortLevel } from '../shared/reasoningEffort';
import { BUILTIN_AUTO_COMPACT_PERCENT, computeContextUsage } from '../shared/contextUsage';
import {
  chooseBuiltinContextUsageModel,
  inferContextWindowFromSdkModelTag,
  resolveContextOccupancyFromSdkBreakdown,
  resolveContextOccupancyTokens,
  resolveContextWindowFromSdkBreakdown,
} from './utils/context-occupancy';
import type { SystemInitInfo } from '../shared/types/system';
import type { SlashCommand as UiSlashCommand } from '../shared/slashCommands';
import {
  assertProductSystemSkillCandidate,
  type EffectiveProjectCapabilitySnapshot,
} from '../shared/projectCapabilities';
import {
  assertKnownProductSystemSkillRequirement,
  isProductSystemSkillRequirement,
  type SystemSkillAdmissionRequirement,
} from '../shared/systemSkills';
import type { OfficialToolId } from '../shared/official-tools';
import { claimPreparedSessionForTurnAdmission, commitPreparedSessionForFirstUserTurn, migratePendingSessionIdentity, resolvePendingConversationMutation, saveSessionMetadata, updateSessionTitleFromMessage, updateSessionMetadata, getSessionMetadata, getSessionData, loadSessionTranscript } from './SessionStore';
import { firePostTurnTitleHook } from './turn-hooks';
import { createSessionMetadata, type SessionMetadata, type SessionMessage, type MessageAttachment, type SessionSource, type TurnAnalyticsSource } from './types/session';
import { originFromTurnAttribution } from '../shared/session-origin';
import type { SessionOrigin } from '../shared/session-origin';
import {
  shouldRecordAdmissionActivity,
  type SessionActivityTurnFacts,
} from './session-core/session-activity-policy';
import { extractAssistantTextFromStoredContent } from './inbox/latest-result';
import { resolveVisibleUserTurnText } from './utils/session-message-preview';
import {
  createMaterializedSessionMetadata,
  isLiveFollowScenario,
  type SessionMaterializationScenario,
} from './utils/session-materialization';
import { isManagedCodexProviderReady } from './utils/managed-codex-readiness';
import { canonicalizeManagedProviderEnv, findProjectAgentByWorkspacePath, getDefaultEnabledOfficialToolIdsForWorkspace, getEffectiveMcpServers, getEffectiveOfficialToolIdsForSession, isCliToolRegistryEnabled, loadConfig as loadAdminConfig, resolveWorkspaceConfig } from './utils/admin-config';
import type { AgentConfig } from '../shared/types/agent';
import type {
  McpEffectiveServerSnapshot,
  McpEffectiveSnapshot,
} from '../shared/mcpEffectiveState';
import { broadcast as broadcastSse, broadcastLive, flushPendingLiveEvents } from './sse';
import { participatesInLiveRestore } from '../shared/liveRevision';
import {
  getEnabledPluginSdkConfigs,
  getDefaultEnabledPluginIdsForWorkspace,
} from './plugins/store';
import { listPluginQualifiedSkillNames } from './plugins/manifest';
import {
  buildBuiltinSkillAllowlist,
  filterSlashCommandsForCapabilities,
  findDisabledCapabilityForSlashInput,
  sanitizeSdkSkillAllowlist,
} from './builtin-session/capabilities';
import { initLogger, appendLog, getLogLines as getLogLinesFromLogger } from './AgentLogger';
import { setAmbientLogContext, clearAmbientLogContextField } from './logger-context';
import { beginTurn as beginTurnAbort, endTurn as endTurnAbort, abortTurn as abortTurnAbort } from './utils/turn-abort';
import type { CancelReason } from './utils/cancellation';
import { localTimestamp } from '../shared/logTime';
import { trackServer } from './analytics';
import { getCurrentRuntimeType, isExternalRuntime } from './runtimes/factory';
import { decideBuiltinSessionResume } from './utils/builtin-session-resume';
import { resolveBuiltinSdkSessionId } from './utils/session-runtime-identity';
import {
  commitPendingProductSession,
  currentProductSessionId as sessionId,
  freezeCurrentProductSessionMetadata,
  getCurrentProductSessionId,
  getPendingProductSessionMaterialization as getPendingDesktopMaterialization,
  isLazySessionMaterializationAllowed,
  preparePendingProductSession,
  publishCurrentProductSessionMetadata,
  resetProductSessionMaterializationState as resetSessionMaterializationState,
  rollbackPendingProductSession,
  setCurrentProductSessionId,
  setCurrentProductSessionContext,
  setLazySessionMaterializationAllowed,
  type ProductSessionSnapshotPatch,
} from './session-engine/product-session-binding';
import {
  decideQueueAdmission,
  decideRealtimeHandoff,
  findQueueLocation,
  resolveChatQueueResponseMode,
  shouldClearAdmissionTicketOnAbort,
  shouldStartTurnBoundaryItem,
  type DesktopDeliveryMode,
  type DispatchGuardResult,
  type QueueAdmissionAction,
  type QueueCancelResult,
  type TurnIdentity,
  type TurnOwner,
  type TurnTerminalObserver,
} from './session-core/turn-queue';
import {
  getMcpAuthorityForScenario,
  mcpConfigFingerprint,
  shouldDeferLiveMcpMutation,
} from './session-core/mcp-sync-policy';
import { elapsedMs, emitPerfTrace, nowMs } from './utils/perf-trace';
import type { ImagePayload, ResolvedImagePayload } from './runtimes/types';
import { messageAttachmentsFromImagePayloads, resolveImagePayloads } from './runtimes/image-payload';
import { buildBuiltinMediaAttachments, saveExtractedToolResultAttachments } from './runtimes/builtin-media-attachments';
import {
  trySyncProjectUserConfigFiles,
  type ProjectUserConfigSyncOptions,
} from './utils/project-user-config-sync';
import { resolveEffectiveProjectCapabilities } from './project-capabilities';
import { createGlobalSkillInventorySnapshot } from './global-skill-inventory';
import {
  appendOmittedImageNote,
  classifyToolAttachmentPresentation,
  extractToolResultRenderParts,
  extractSdkToolResultRenderParts,
  type ExtractedToolResultAttachment,
} from './utils/tool-result-attachments';
import type { ToolAttachment } from '../shared/types/tool-attachment';
import { imEventBus, type ImEventType } from './utils/im-event-bus';
import { imRequestRegistry } from './utils/im-request-registry';
import { buildImCancelledPayload, buildImErrorPayload } from './utils/im-terminal-payload';
import {
  mirrorIfChannelBound,
  resolvedImagesToMirrorImages,
  visibleDesktopMirrorText,
  type MirrorImage,
} from './utils/im-mirror';
import {
  SESSION_BOUND_CHANNEL_DELIVERY,
  type TurnChannelDelivery,
} from './session-core/channel-delivery';
import { normalizeClaudeTranscriptCleanupPeriodDays, SUBSCRIPTION_PROVIDER_ID, type ProxySettings } from '../shared/config-types';
import {
  LOCAL_COMMAND_OUTPUT_TAG,
  SYSTEM_REMINDER_CLOSE,
  SYSTEM_REMINDER_OPEN,
} from '../shared/systemReminder';
import { createConcreteProviderRoute, isConcreteProviderRoute } from '../shared/providerRoute';
import type {
  ContentBlock,
  MessageWire,
  PermissionMode,
  ToolUseState,
} from './builtin-session/types';
export type {
  ContentBlock,
  MessageWire,
  PermissionMode,
} from './builtin-session/types';
import type { ProviderEnv } from './provider-types';
export { stripPlaywrightResults } from './builtin-session/transcript-persistence';
import {
  clearQueryMcpPrewarmOwner,
  completeQueryBackgroundTask,
  getQueryBackgroundTask,
  getQueryMcpPrewarmOwner,
  hasQueryBackgroundTask,
  hasQueryBackgroundTasks,
  readQueryMcpStatuses,
  awaitSessionTermination as awaitBuiltinSessionTermination,
  clearAbortFlag,
  clearGeneratorResolver,
  clearPreWarmTimer,
  claimQueryMcpMutation,
  forceWakeGeneratorWithNull,
  getQueryMcpMutation,
  incrementPreWarmFailCount,
  getBuiltinLiveRevision,
  getCurrentQueryAuthority,
  getSessionMutationBarrier,
  getSystemInitAuthority,
  isCurrentQueryAuthority,
  lifecycleState,
  nextBuiltinLiveRevision,
  requestAbort,
  registerSessionAbortCleanup,
  recordQueryBackgroundTask,
  resetPreWarmFailCount,
  resetBuiltinLiveRevision,
  runSerializedSessionMutation,
  setPreWarmInProgress,
  setPreWarmTimer,
  setPreWarmDisabled,
  setQuerySession,
  setQuerySessionWithAuthority,
  setQueryMcpPrewarmOwner,
  settleQueryMcpPrewarmOwner,
  setSdkControlReady,
  setSessionProcessing,
  setSessionTerminationPromise,
  setSystemInitInfo,
  takeQueryBackgroundTasks,
  wakeGenerator as lifecycleWakeGenerator,
  waitForQueryExit,
  waitForMessage as lifecycleWaitForMessage,
  type QueryMcpMutationResult,
  type BuiltinQueryAuthority,
} from './builtin-session/lifecycle';
import {
  MCP_PREWARM_GRACE_MS,
  awaitMcpPrewarm,
  formatMcpPrewarmServers,
  type McpPrewarmOutcome,
  type McpPrewarmOwner,
} from './session-core/mcp-prewarm-policy';
import {
  beginPromotedItem,
  cancelDetachedAdmissionTicket,
  cancelTurnAdmissionTicket,
  cancelPromotedItemWithSettlement,
  clearPromotedItem,
  clearInFlightSlot as queueClearInFlightSlot,
  clearPendingMidTurn,
  dequeueMessage,
  drainQueuedItems,
  getForceTurnBoundaryQueueId,
  getCommittingTurnAdmissionQueueId,
  getInFlightMetadata,
  getInFlightQueueId,
  getInterruptingInFlightQueueId,
  isPromotedItemCanceled,
  getMessageQueue,
  getPendingMidTurnQueue,
  getPromotedItemCancellation,
  getPromotedTurnIdentity,
  getQueueStatus as queueGetQueueStatus,
  getTurnAdmissionTicket,
  getTurnAdmissionIdentity,
  getTurnBoundaryQueue,
  hasQueuedTurnByOwner as queueHasQueuedTurnByOwner,
  hasQueuedOrInFlightWork as queueHasQueuedOrInFlightWork,
  moveQueuedItemToFront,
  pushMessage,
  pushPendingMidTurn,
  pushTurnBoundary,
  queueState,
  queuedWorkCount as queueQueuedWorkCount,
  releaseDetachedAdmissionTicket,
  requeuePromotedItemBeforeSdkDispatch,
  releaseTurnAdmissionTicket as queueReleaseTurnAdmissionTicket,
  removeQueuedItemByQueueId,
  removeQueuedItemByRequestId,
  rescuePendingMidTurnToMessageFront,
  setAwaitingAssistantStartAckQueueId,
  setCommittingTurnAdmissionQueueId,
  setForceSurfaceInFlightId,
  setForceTurnBoundaryQueueId,
  setInFlightQueueItem,
  setInterruptingInFlightQueueId,
  setTurnAdmissionTicket,
  shiftPendingMidTurn,
  spliceTurnBoundary,
  unshiftMessage,
} from './builtin-session/queue';
import {
  accumulateCurrentTurnUsage,
  appendCurrentTurnTextBlock,
  clearCurrentTurnTextBlocks,
  clearPendingOutputOwners as turnClearPendingOutputOwners,
  getCurrentTurnIdentity as getBuiltinCurrentTurnIdentity,
  getCurrentTurnQueueId as getBuiltinCurrentTurnQueueId,
  getLastSessionCompletionTerminal,
  getCurrentTurnSourceItem,
  getCurrentTurnInboxMeta,
  getPendingImRequestIds,
  hasPendingOutputOwnerByQueueId,
  peekPendingOutputOwner,
  incrementCurrentTurnToolCount,
  isAssistantMessagePresent,
  markAssistantMessageError,
  markCurrentTurnHasOutput,
  notifyQueuedTurnStopped,
  popPendingOutputOwner as turnPopPendingOutputOwner,
  admitPendingOutputOwnerForYield as turnAdmitPendingOutputOwnerForYield,
  removePendingOutputOwnerByQueueId as turnRemovePendingOutputOwnerByQueueId,
  resetTurnUsage as resetBuiltinTurnUsage,
  setAssistantMessagePresent,
  setCurrentPlanFileMinMtimeMs,
  setCurrentTurnAnalyticsOrigin,
  setCurrentTurnAnalyticsSource,
  setCurrentTurnCompactResult,
  setCurrentTurnInboxMeta,
  setCurrentTurnImTerminalEmitted,
  setCurrentTurnProviderAnalytics,
  stageCurrentOutputOwnerAssistantChannelBlock,
  clearCurrentOutputOwnerAssistantChannelBlocks,
  type PendingOutputOwner,
  setCurrentTurnSourceItem,
  setCurrentTurnStartTime,
  setLatestMainAssistantUsage,
  setSawCompactBoundary,
  setSubstantiveActivity,
  terminalCleanup,
  turnState,
  waitForCurrentTurnTerminalObserver,
} from './builtin-session/turn';
import {
  withSessionCompletionTerminal,
  type SessionCompletionTerminal,
} from '../shared/sessionCompletion';
import {
  applyAgentDefinitionsUpdate as configApplyAgentDefinitionsUpdate,
  applyMcpServersUpdate as configApplyMcpServersUpdate,
  applyModelUpdate as configApplyModelUpdate,
  applyProviderEnvUpdate as configApplyProviderEnvUpdate,
  applyReasoningEffortUpdate as configApplyReasoningEffortUpdate,
  canResumeAcrossBuiltinProviderHistory,
  clearDeferredRestart as configClearDeferredRestart,
  drainDeferredRestart as configDrainDeferredRestart,
  providerEnvEqual as configProviderEnvEqual,
  setBackgroundAgentPermissionMode as configSetBackgroundAgentPermissionMode,
  setCurrentMcpServers,
  setFrozenSdkMcpFingerprint,
  hasDeferredRestart as configHasDeferredRestart,
  setModel as configSetModel,
  setPendingProviderHistoryBoundaryReset,
  setPermissionPlanState,
  setProviderEnv as configSetProviderEnv,
  setReasoningEffort as configSetReasoningEffort,
  scheduleDeferredRestart as configScheduleDeferredRestart,
  setSessionEnabledOfficialToolIds as configSetSessionEnabledOfficialToolIds,
  setSessionEnabledPluginIds as configSetSessionEnabledPluginIds,
  shouldApplyConfigUpdate,
  configState,
} from './builtin-session/config';
import {
  addCurrentSessionUuid,
  addLiveSessionUuid,
  allocateMessageId,
  appendMessage,
  bindSdkUuidToLatestUnboundUserMessage,
  bindSdkUuidToMessage,
  clearCurrentSessionUuids,
  clearLiveSessionUuids,
  clearMessages,
  deleteCurrentSessionUuid,
  deleteLiveSessionUuid,
  getLastAssistantMessageId,
  setMessageSequence,
  setPendingReloadAnchor,
  truncateMessages,
  transcriptState,
} from './builtin-session/transcript';
import {
  PLAYWRIGHT_RESULT_SENTINEL,
  applyTranscriptRetractionToPersistence,
  loadTranscriptFromSessionMessages,
  messageWireToSessionMessage,
  resetTranscriptPersistenceForSession,
  saveForkTranscript,
  scheduleTranscriptPersist,
  sessionMessageToMessageWire,
  truncateTranscriptPersistenceForRewind,
} from './builtin-session/transcript-persistence';
import { createBuiltinTurnLifecycle, type BuiltinSdkResultMessage } from './builtin-session/turn-lifecycle';
import type {
  BuiltinRestartReason as RestartReason,
  DeferredUserSurface,
  InFlightMetadata,
  MessageQueueItem,
  TurnBoundaryQueueItem,
  TurnProviderAnalytics,
} from './builtin-session/types';

/**
 * Builtin session public facade.
 *
 * Route-facing callers and SessionEngine adapters continue importing this file.
 * Mutable builtin SDK session state is owned by `src/server/builtin-session/*`:
 * - lifecycle.ts: SDK Query process, abort flag, termination promise, generator wakeup, pre-warm readiness.
 * - queue.ts: realtime queue, mid-turn buffer, turn-boundary queue, in-flight slot, admission ticket.
 * - turn.ts: current turn usage/output/error state, SDK output-owner FIFO, injected turn outcomes.
 * - config.ts: MCP/agents/plugins/model/permission/provider state plus deferred restart latch.
 * - transcript.ts: live messages, sequence, SessionStore transcript cursor, SDK UUID freshness sets.
 *
 * Keep HTTP/SSE wire contracts and SessionEngine imports pointed at this facade;
 * new internal mutations should go through the owner state above, not new
 * module-level globals here.
 */

// Module-level debug mode check (avoids repeated environment variable access)
const isDebugMode = process.env.DEBUG === '1' || process.env.NODE_ENV === 'development';

/**
 * Pattern 3 §3.2.5 — per-token `stream_event` log suppression.
 *
 * The SDK emits one `stream_event` per token (chunk_start / token_delta / etc).
 * The legacy code path was: every event → `logStringify` → `appendLogLine` →
 *   - `appendLog()` writes a line into the per-session log file
 *   - `broadcast('chat:log', ...)` queues an SSE event to every viewer
 *
 * For a 10k-token response this fans out 10k disk writes + 10k SSE frames per
 * subscribed renderer, while the actual token text is already streamed via
 * `chat:message-chunk`. The cost is purely diagnostic noise.
 *
 * When `SUPPRESS_PER_TOKEN_LOG_BROADCAST = true` (default):
 *   - the per-event `appendLogLine(...)` call is skipped for `stream_event`
 *   - no `chat:log` is broadcast for `stream_event`
 *   - on `result` (turn-end) we emit one summary line:
 *       `[agent][sdk] stream_event_summary turn=<msgCount> deltas=<n>`
 *     and one aggregate `chat:log` so consumers can still see "this turn
 *     happened"
 *
 * Set to `false` only when you specifically need the per-token transcript
 * for debugging (rare). The other branch (debug mode) of `isDebugMode` already
 * keeps the data path live for assistant / system / result events; this flag
 * only governs `stream_event` (the noisy path).
 */
const SUPPRESS_PER_TOKEN_LOG_BROADCAST = true;

/**
 * Claude Agent SDK reserved MCP server names — using these causes the SDK to
 * crash with exit code 1: "Invalid MCP configuration: X is a reserved MCP name."
 * Source: claude-code/src/main.tsx (isClaudeInChromeMCPServer, isComputerUseMCPServer)
 */
export const SDK_RESERVED_MCP_NAMES = ['claude-in-chrome', 'computer-use'];

/**
 * MyAgents-reserved MCP server ids — names used by context-injected builtins
 * that are managed by the sidecar, not user-toggleable. User MCPs configured
 * with these ids are silently dropped at SDK build time so they cannot
 * (a) overwrite the legitimate builtin in `result[server.id]`, or
 * (b) inherit the auto-trust granted to these names by `canUseTool`.
 *
 * MUST stay in sync with `getActiveContextInjectedBuiltinIds()` and Pattern 1
 * of `buildSdkMcpServers()`. If a new context-injected builtin lands, register
 * its id here too. See issue #148 for the original drift.
 *
 * v0.2.11 — `cron-tools`, `im-cron`, and `im-media` were retired in favour of
 * `myagents` CLI commands + system prompt guidance (single CLI surface usable
 * across builtin / Codex / Gemini / Claude Code runtimes). Only `im-bridge-tools`
 * remains a context-injected MCP because its tool surface is a runtime-dynamic
 * passthrough of OpenClaw plugin tools — no fixed schema to teach via prompt.
 */
export const MYAGENTS_CONTEXT_INJECTED_MCP_IDS = [
  'im-bridge-tools',
] as const;

// ===== OAuth credential revision listener =====
// The Session process observes persisted, non-secret revisions. The Global
// Sidecar owns proactive refresh; this handler only rebuilds MCP connections
// that are enabled in this Session.
onOAuthCredentialChange(({ serverId, status, tokenRevision }) => {
  if (!configState.currentMcpServers?.some(s => s.id === serverId)) return;

  console.log(
    `[agent] OAuth credential revision=${tokenRevision} status=${status} for MCP ${serverId}, rebuilding connection`,
  );
  if (lifecycleState.query) scheduleDeferredRestart('oauth');
  resetPreWarmFailCount();
  if (!lifecycleState.processing || lifecycleState.preWarming) {
    schedulePreWarm();
  }

  if (status === 'expired' || status === 'missing') {
    broadcast('mcp:oauth-expired', { serverId });
  }
});

// Max length for individual string values in SDK message logs.
// Base64 images can be several MB; truncate to keep logs readable.
const LOG_STRING_MAX_LEN = 500;

/** JSON.stringify with long string truncation (e.g. base64 image data) for logging. */
function logStringify(obj: unknown, maxLen = LOG_STRING_MAX_LEN): string {
  try {
    return JSON.stringify(obj, (_key, value) => {
      if (typeof value === 'string' && value.length > maxLen) {
        return value.slice(0, maxLen) + `...(${value.length} chars)`;
      }
      return value;
    });
  } catch {
    return '[unserializable]';
  }
}

// Decorative text filter thresholds (for third-party API wrappers like 智谱 GLM-4.7)
// Decorative blocks are typically 100-2000 chars; we use wider range for safety margin
const DECORATIVE_TEXT_MIN_LENGTH = 50;
const DECORATIVE_TEXT_MAX_LENGTH = 5000;

/**
 * Sync user-level skills and commands into a project's .claude/ as symlinks.
 *
 * This is a runtime-neutral compatibility inventory. Project-level selection
 * is enforced separately at Runtime admission from AgentConfig; changing one
 * Session must not rewrite shared links observed by other runtimes/Sidecars.
 *
 * This avoids setting CLAUDE_CONFIG_DIR (which would break Keychain credential lookup).
 *
 * Skills (directories):
 * - Creates symlinks for globally enabled skills: <project>/.claude/skills/<name> → ~/.myagents/skills/<name>
 * - Removes links disabled by the global skills-config (not project selection)
 * - Does NOT touch real (non-symlink) skill directories in the project
 *
 * Commands (.md files):
 * - Creates symlinks for all commands: <project>/.claude/commands/<name>.md → ~/.myagents/commands/<name>.md
 * - Does NOT touch real (non-symlink) command files in the project
 *
 * Called at session startup (startStreamingSession) and after skill/command CRUD operations.
 */
export function syncProjectUserConfig(
  projectDir: string,
  options: ProjectUserConfigSyncOptions = {},
): void {
  let capabilitySnapshot = options.capabilitySnapshot;
  if (!capabilitySnapshot) {
    try {
      capabilitySnapshot = resolveEffectiveProjectCapabilities(projectDir);
    } catch (error) {
      console.warn('[skill-sync] Project capability scan failed; reconciling only the global inventory:', error);
    }
  }
  trySyncProjectUserConfigFiles(
    projectDir,
    { ...options, capabilitySnapshot },
    'skill-sync',
  );
  // A live Query owns the allowlist captured at birth. Capability changes use
  // the existing deferred-restart boundary; reloadSkills() alone cannot update
  // Options.skills. The shared inventory itself remains runtime-neutral.
  if (lifecycleState.query && agentDir && workspacePathsEqual(projectDir, agentDir)) {
    scheduleDeferredRestart('capabilities');
    return;
  }
}

/**
 * Reload the live builtin SDK skill registry and prove that a product-owned
 * workflow contract is actually available to this Session. Cold-start guards
 * await the Query's existing initialization promise before reading the native
 * registry; this rejects only the dependent turn, never Session startup.
 */
export async function requireCurrentBuiltinSkill(
  requirement: SystemSkillAdmissionRequirement,
): Promise<void> {
  const skillName = isProductSystemSkillRequirement(requirement)
    ? assertKnownProductSystemSkillRequirement(requirement).name
    : requirement;
  const query = lifecycleState.query;
  if (!query) throw new Error(`builtin Runtime is unavailable for required system skill ${skillName}`);
  if (!lifecycleState.sdkControlReady) {
    await query.initializationResult();
    if (lifecycleState.query !== query) {
      throw new Error(`builtin Runtime changed before loading required system skill ${skillName}`);
    }
  }

  if (isProductSystemSkillRequirement(requirement)) {
    const admitted = configState.currentCapabilitySnapshot;
    if (!admitted) {
      throw new Error(`builtin Runtime has no capability admission for product Skill ${skillName}`);
    }
    assertProductSystemSkillCandidate(admitted, requirement);
    const currentInventory = createGlobalSkillInventorySnapshot();
    if (currentInventory.integrityRevision !== admitted.integrityRevision) {
      throw new Error(`builtin Runtime inventory changed before product Skill ${skillName} dispatch`);
    }
  }

  const refreshed = await query.reloadSkills();
  if (!refreshed.skills.some(skill => skill.name === skillName)) {
    throw new Error(`builtin Runtime did not load required system skill ${skillName}`);
  }
}

// (issue #174) `starting` separates "subprocess launched, awaiting system_init"
// from "AI actively processing a turn". Without it, the 60s→600s adaptive
// startup-timeout window looks identical to a normal busy turn in the UI:
// user can't tell if the SDK is stuck in MCP handshake / first-time workspace
// init or doing real work, and after up to 10 minutes the only signal is the
// timeout-error toast. `starting` → `running` when system_init arrives.
type SessionState = 'idle' | 'starting' | 'running' | 'error';

// Map UI permission mode to SDK permission mode
function mapToSdkPermissionMode(mode: PermissionMode): 'acceptEdits' | 'plan' | 'bypassPermissions' | 'default' {
  switch (mode) {
    case 'auto':
      return 'acceptEdits';
    case 'plan':
      return 'plan';
    case 'fullAgency':
      return 'bypassPermissions';
    case 'custom':
    default:
      return 'default';
  }
}

function mapToEffectiveSdkPermissionMode(
  mode: PermissionMode,
  scenario: InteractionScenario,
): 'acceptEdits' | 'plan' | 'bypassPermissions' | 'default' {
  if (shouldUseNonBypassForNativeAskUserQuestion(mode, scenario)) {
    return 'acceptEdits';
  }
  return mapToSdkPermissionMode(mode);
}

const requireModule = createRequire(import.meta.url);

/**
 * Strip image content blocks from a queued user message when the resolved
 * model has lost `image` modality support since enqueue time. Defensive
 * second pass — `enqueueUserMessage` is the primary filter (ran against the
 * model at the time of enqueue); this re-checks against the model active at
 * yield time so a mid-turn model switch can't leak baked image blocks into
 * a text-only model's request.
 *
 * Returns the input untouched in the common case (no drift). Only allocates
 * when re-stripping is required.
 */
function stripUnsupportedModalityBlocks(
  message: SDKUserMessage['message'],
  modelAtYield: string | undefined,
): SDKUserMessage['message'] {
  const content = message.content;
  if (!Array.isArray(content)) return message;
  // Fast-path: no image block → nothing to strip.
  let hasImageBlock = false;
  for (const block of content) {
    if (block && typeof block === 'object' && (block as { type?: string }).type === 'image') {
      hasImageBlock = true;
      break;
    }
  }
  if (!hasImageBlock) return message;
  if (modelSupportsModality(modelAtYield, 'image')) return message;

  // Drift detected: filter out image blocks; if nothing usable remains,
  // append a synthetic placeholder so the SDK still receives a non-empty
  // user turn. Mirrors the synthetic-note path in enqueueUserMessage.
  const kept = content.filter(b => !(b && typeof b === 'object' && (b as { type?: string }).type === 'image'));
  const droppedCount = content.length - kept.length;
  if (kept.length === 0) {
    kept.push({ type: 'text', text: `[${droppedCount} image attachment(s) omitted — current model does not support image input]` });
  }
  console.log(`[agent] modality re-strip at dequeue: dropped ${droppedCount} image block(s) for model=${modelAtYield ?? '(unknown)'} (model changed since enqueue)`);
  broadcast('chat:attachments-filtered', {
    reason: 'modality',
    kind: 'image',
    count: droppedCount,
    model: modelAtYield ?? null,
    phase: 'dequeue',
  });
  return { ...message, content: kept };
}

let agentDir = '';
let hasInitialPrompt = false;
let sessionState: SessionState = 'idle';

// Deferred config restart: config changes during an active turn / pre-warm
// stage set a reason in this set instead of aborting immediately. Two consumers
// drain it, both reading-and-clearing as a unit:
// 1. schedulePreWarm() timer — batches rapid-fire changes (e.g. React state sync
//    firing 7× /api/mcp/set in 4s) into a single abort+restart.
// 2. Turn-complete handler — when config changed during an active user turn,
//    the restart is deferred until the turn finishes to avoid killing mid-response.
//
// Invariant: the set is cleared whenever `clearMessageState()` runs (fresh
// session) and whenever a drain-point consumes it. Error paths in
// startStreamingSession also clear it to prevent stuck flags across failed
// starts (see `finally` block on session errors).
/** Schedule a deferred restart for the given reason. Multiple reasons within
 *  one turn collapse into a single restart at the next drain point. */
function scheduleDeferredRestart(reason: RestartReason): void {
  configScheduleDeferredRestart(reason);
}

/**
 * v0.1.69 T14: Return true if the current session is locked — its config was
 * captured as a snapshot at creation (see types/session.ts). Callers that
 * react to AgentConfig change events should consult this before scheduling a
 * restart: a snapshotted session owns MCP selection IDs plus
 * agents/provider/model/permissionMode and does NOT follow later Agent
 * defaults. MCP definition bodies and the global enable security lever remain
 * disk-owned and are resolved separately in setMcpServers().
 *
 * IM sessions intentionally leave `configSnapshotAt` undefined (D4
 * live-follow), so this returns false and the legacy restart path runs.
 */
function isCurrentSessionSnapshotted(): boolean {
  if (!sessionId) return false;
  const meta = getSessionMetadata(sessionId);
  return Boolean(meta?.configSnapshotAt);
}

/** True when at least one reason is pending. */
function hasDeferredRestart(): boolean {
  return configHasDeferredRestart();
}

/** Drain-and-clear: returns the pending reasons (as a comma-joined string for
 *  logging) and empties the set. Always call this at the point a restart is
 *  actually applied — callers must not peek without draining. */
function drainDeferredRestart(): string {
  return configDrainDeferredRestart();
}

/**
 * Await lifecycleState.termination with a timeout.
 * On timeout, force-clean session state so the caller is never permanently blocked.
 */
async function awaitSessionTermination(timeoutMs = 10_000, label = ''): Promise<void> {
  await awaitBuiltinSessionTermination({
    timeoutMs,
    label,
    onTimeoutForceCleanup: () => {
      // Force-clean state so the caller can proceed — mirrors the finally block
      // of startStreamingSession. Lifecycle owner clears SDK process flags and
      // generator resolver; the facade still owns renderer-facing stream flags.
      isStreamingMessage = false;
      setSessionState('idle');
    },
  });
}

let isInterruptingResponse = false;
let isStreamingMessage = false;
// Every `system` subtype defined in SDK 0.3.261 (sdk.d.ts) — handled here or
// deliberately untouched. A subtype outside this set means a NEWER SDK started
// emitting a message kind we have never seen; the loop logs it once per
// process instead of letting it vanish silently. Update this set when bumping
// the SDK (grep sdk.d.ts for `type: 'system'` blocks).
const KNOWN_SYSTEM_SUBTYPES = new Set([
  'api_retry', 'background_tasks_changed', 'commands_changed', 'compact_boundary',
  'control_request_progress', 'elicitation_complete',
  'files_persisted', 'hook_progress', 'hook_response', 'hook_started',
  'informational', 'init', 'local_command_output', 'memory_recall',
  'mirror_error', 'model_refusal_fallback', 'model_refusal_no_fallback',
  'notification', 'permission_denied',
  'plugin_install', 'session_state_changed', 'status', 'task_notification',
  'task_progress', 'task_started', 'task_updated', 'thinking_tokens',
  'worker_shutting_down',
]);
const warnedUnknownSystemSubtypes = new Set<string>();
// Top-level half of the same sentinel: every `type` value an SDKMessage union
// member carries in 0.3.261. Verified 1:1 against sdk.d.ts at upgrade time
// (the system-typed members are covered by KNOWN_SYSTEM_SUBTYPES above).
const KNOWN_MESSAGE_TYPES = new Set([
  'assistant', 'user', 'result', 'system', 'stream_event', 'rate_limit_event',
  'auth_status', 'tool_progress', 'tool_use_summary', 'prompt_suggestion',
  'conversation_reset',
]);
const warnedUnknownMessageTypes = new Set<string>();
type PostInterruptTurnEndOutcome = 'result-claimed' | 'session-ended';
// Durable one-shot handoff between the SDK result owner and the interrupt
// caller. The outcome is stored even when result arrives before interrupt()
// installs its waiter, closing the former resolve-before-listen race.
let postInterruptTurnEndOutcome: PostInterruptTurnEndOutcome | null = null;
let postInterruptTurnEndResolve: ((outcome: PostInterruptTurnEndOutcome) => void) | null = null;
// Public SDK interrupt receipt for the current cooperative interrupt only.
// `null` means the CLI did not advertise/return a receipt. Queue ids are the
// same UUIDs stamped by messageGenerator, so no parallel identity map exists.
let interruptSurvivingQueueIds: ReadonlySet<string> | null = null;

function settlePostInterruptTurnEnd(outcome: PostInterruptTurnEndOutcome): void {
  if (!isInterruptingResponse) return;
  const settled = postInterruptTurnEndOutcome ?? outcome;
  postInterruptTurnEndOutcome = settled;
  if (postInterruptTurnEndResolve) {
    const resolve = postInterruptTurnEndResolve;
    postInterruptTurnEndResolve = null;
    resolve(settled);
  }
}

function didInFlightSurviveInterrupt(queueId: string): boolean | null {
  return interruptSurvivingQueueIds?.has(queueId) ?? null;
}
// Count of MCP tool_use blocks emitted by the model in the current turn that
// haven't seen their matching tool_result yet. Read by the post-interrupt
// force-close path to disambiguate diagnostics: >0 strongly suggests a hung
// MCP tool (the SDK subprocess is blocked on client.callTool()), 0 suggests
// the model is still generating output (thinking / text). Updated by the
// stream-event handlers in startStreamingSession; reset to 0 on each new
// turn (and on session restart) so values never leak across turns.
let inFlightToolCount = 0;
let watchdogFired = false;
// (v0.2.11 cross-bugfix #142 review-fix-2 #1) True from the moment
// promotePendingMidTurnItem shifts an item out of queueState.pendingMidTurnQueue
// until the generator's `item.resolve()` after yield. Plugs the gap
// where queueState.pendingMidTurnQueue is empty + isStreamingMessage hasn't yet
// flipped to true (await persistMessagesToStorage in turn-start setup) —
// without this, isSessionBusy returns false in the gap and a fresh
// enqueue would take the direct-send path, opening a new ordering bug.
// (v0.2.34 / v0.2.12 mid-turn injection restore) UUID of the queue item currently
// yielded to the SDK CLI subprocess but not yet drained by AI. Set when
// generator yields a queued mid-turn message; cleared when CLI emits
// SDKUserMessageReplay (isReplay=true) confirming AI's next API call
// will include the queued_command attachment, when a later assistant-turn
// signal proves the boundary drain happened without replay, or when SDK
// cancel_async_message successfully retracts it before dequeue.
//
// While queueState.inFlightToCliId !== null, additional mid-turn enqueues buffer
// in queueState.pendingMidTurnQueue. The in-flight item is conditionally cancellable:
// once it has crossed into CLI's commandQueue, cancellation must go through
// SDK cancel_async_message and succeeds only while the item is still pending.
// The "lockstep yield" pattern (one in-flight at a time) keeps subsequent
// queue items local until they are promoted.
// Issue #289 — when set to the in-flight queueId, a force-send ("立即发送") is in progress
// for that item: it interrupts the current turn precisely so the SDK drains + processes the
// queued command, so the graceful-interrupt `result` MUST SURFACE the item (queue:started)
// instead of dropping it (queue:cancelled). Distinct from `isInterruptingResponse` (which is
// also true for a plain stop). Cleared whenever the in-flight slot is cleared.
// Natural `result` is not a consumption ack. When it leaves an in-flight
// queue item waiting, only the next assistant-start for that exact queueId may
// confirm the SDK boundary drain. This prevents unrelated replacement
// assistant transcriptState.messages (e.g. refusal fallback rewrites) from falsely ACKing it.
// Captured when interruptCurrentResponse starts. If the current in-flight
// queue item changes before the interrupt result/stop handler runs (for
// example replay(A) promotes B), the terminal event belongs to A and must not
// drop or surface B.

const SUBSCRIPTION_PROVIDER_ANALYTICS: TurnProviderAnalytics = {
  provider_id: 'anthropic-sub',
  provider_name: 'Anthropic (订阅)',
  api_protocol: 'anthropic',
  provider_base_url: 'https://api.anthropic.com',
  provider_api_protocol: 'anthropic',
};

function buildTurnProviderAnalytics(providerEnv: ProviderEnv | undefined): TurnProviderAnalytics {
  if (!providerEnv) return SUBSCRIPTION_PROVIDER_ANALYTICS;
  const protocol = providerEnv.apiProtocol ?? 'anthropic';
  return {
    provider_id: providerEnv.providerId ?? null,
    provider_name: providerEnv.providerName ?? providerEnv.providerId ?? null,
    api_protocol: protocol,
    provider_base_url: providerEnv.baseUrl ?? 'https://api.anthropic.com',
    provider_api_protocol: protocol,
  };
}

/**
 * Clear the in-flight queued-command slot. Keeps the three coupled fields in lockstep so a
 * future clear site can't forget the #289 force flag (which, if left stale, would be checked
 * against a later in-flight item in handleMessageComplete). Callers that need the prior value
 * (e.g. the queueId / metadata / forced-ness) MUST capture it before calling.
 */
function clearInFlightSlot(): void {
  queueClearInFlightSlot();
}

type QueryWithAsyncMessageCancel = Query & {
  cancelAsyncMessage?: (messageUuid: string) => Promise<boolean>;
};

const SDK_ASYNC_MESSAGE_CANCEL_TIMEOUT_MS = 5000;

async function cancelSdkAsyncMessage(queueId: string): Promise<InFlightAsyncCancelResult> {
  const session = lifecycleState.query as QueryWithAsyncMessageCancel | null;
  if (!session || typeof session.cancelAsyncMessage !== 'function') {
    console.warn(`[agent] Queue item ${queueId} SDK async cancel unavailable — no live cancelAsyncMessage()`);
    return 'unavailable';
  }
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    const cancelled = await Promise.race([
      session.cancelAsyncMessage(queueId),
      new Promise<never>((_, reject) => {
        timeout = setTimeout(
          () => reject(new Error(`cancelAsyncMessage timeout after ${SDK_ASYNC_MESSAGE_CANCEL_TIMEOUT_MS}ms`)),
          SDK_ASYNC_MESSAGE_CANCEL_TIMEOUT_MS,
        );
      }),
    ]);
    return cancelled ? 'cancelled' : 'not-cancelled';
  } catch (error) {
    console.warn(`[agent] Queue item ${queueId} SDK async cancel failed:`, error);
    return 'error';
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}

// ===== Session-bound channel delivery =====
// User ingress projection and assistant egress ownership are deliberately
// independent. Assistant ownership and completed blocks live on the existing
// per-yield output-owner FIFO; this local state only serializes transport calls.
let channelDeliveryTail: Promise<void> = Promise.resolve();
const pendingTextBlockTexts: Map<number, string> = new Map();

function clearChannelDeliveryState(): void {
  // Completed blocks are held by the output-owner FIFO and are discarded when
  // that owner is popped on error/stop. Only an open stream block lives here.
  pendingTextBlockTexts.clear();
}

function appendChannelDelivery(label: string, deliver: () => Promise<void>): void {
  channelDeliveryTail = channelDeliveryTail
    .then(deliver)
    .catch((error) => {
      console.warn(`[agent] ${label} channel delivery failed:`, error);
    });
}

function maybeAccumulateChannelDeliveryChunk(index: number, chunk: string): void {
  if (peekPendingOutputOwner()?.assistantChannelDelivery !== 'session-binding') return;
  const prev = pendingTextBlockTexts.get(index) ?? '';
  pendingTextBlockTexts.set(index, prev + chunk);
}

function deliverSessionBoundDesktopUser(content: string, images: MirrorImage[] | undefined): void {
  // Only fire if there's a chance an IM channel is bound. Rust silently
  // no-ops if not, but skipping the round-trip when content is trivially
  // empty avoids needless network chatter.
  const visibleContent = visibleDesktopMirrorText(content);
  if (!visibleContent && (!images || images.length === 0)) return;
  const deliverySessionId = sessionId;
  appendChannelDelivery('user', () => mirrorIfChannelBound({
    sessionId: deliverySessionId,
    role: 'user',
    text: visibleContent,
    images,
  }));
}

async function surfaceBuiltinUserMessage(
  surface: DeferredUserSurface,
  phase: 'pre-admission' | 'admission',
  lastActiveAt?: string,
): Promise<boolean> {
  appendMessage(surface.message);
  if (surface.event === 'message-replay') {
    broadcast('chat:message-replay', createLiveUserMessageReplay(sessionId, surface.message));
  } else {
    broadcast('queue:started', {
      queueId: surface.queueId,
      sessionId,
      ...(surface.midTurnBreak ? { midTurnBreak: true } : {}),
      userMessage: {
        id: surface.message.id,
        role: surface.message.role,
        content: surface.message.content,
        timestamp: surface.message.timestamp,
        attachments: surface.message.attachments,
      },
    });
  }

  const messageText = typeof surface.message.content === 'string' ? surface.message.content : '';
  const activityMerged = await persistMessagesToStorageAndCommitPreparedFirstUserTurn(
    messageText,
    surface.sessionBirthOrigin,
    transcriptState.messages.length,
    phase,
    lastActiveAt,
  );
  if (surface.channelDelivery.user === 'session-binding') {
    deliverSessionBoundDesktopUser(messageText, surface.mirrorImages);
  }
  return activityMerged;
}

async function rollbackFailedBuiltinUserSurface(messageId: string): Promise<void> {
  try {
    await applyTranscriptRetractionToPersistence(
      sessionId,
      new Set([messageId]),
      { kind: 'builtin-admission-rollback' },
    );
    broadcast('chat:messages-retracted', {
      messageIds: [messageId],
      retractedStreamingTail: false,
    });
  } catch (rollbackError) {
    console.error('[agent][admission-persist] action=rollback_persist_failed', rollbackError);
  }
}

type SurfaceInFlightOptions = {
  sdkUuid?: string;
  midTurnBreak?: boolean;
  reason: string;
  /** Replay can await durability before SSE; synchronous assistant-start cannot. */
  awaitPersist?: boolean;
  /** Persist only the user row added by this helper without blocking stream assembly. */
  schedulePersist?: boolean;
};

async function surfaceInFlightQueueItem(
  queueId: string,
  meta: InFlightMetadata | null,
  options: SurfaceInFlightOptions,
): Promise<void> {
  await prepareSessionPlansForUserTurn({ clearStale: false });

  const userMessage: MessageWire = {
    id: allocateMessageId(),
    role: 'user',
    content: meta?.messageText ?? '',
    timestamp: new Date().toISOString(),
    attachments: meta?.attachments,
    sdkUuid: options.sdkUuid,
    metadata: meta?.source ? { source: meta.source } : undefined,
  };
  appendMessage(userMessage);
  if (options.sdkUuid) {
    addCurrentSessionUuid(options.sdkUuid);
    addLiveSessionUuid(options.sdkUuid);
  }

  if (options.awaitPersist) {
    await persistMessagesToStorageAndCommitPreparedFirstUserTurn(userMessage.content as string);
  } else if (options.schedulePersist) {
    void persistMessagesToStorageAndCommitPreparedFirstUserTurn(userMessage.content as string)
      .catch(err => console.error('[agent] persistMessagesToStorage failed:', err));
  }

  if (meta?.channelDelivery.user === 'session-binding') {
    deliverSessionBoundDesktopUser(userMessage.content as string, meta?.mirrorImages);
  }

  console.log(`[agent] In-flight queue item ${queueId} surfaced via queue:started (${options.reason})`);
  broadcast('queue:started', {
    queueId,
    sessionId,
    ...(options.midTurnBreak ? { midTurnBreak: true } : {}),
    userMessage: {
      id: userMessage.id,
      role: userMessage.role,
      content: userMessage.content,
      timestamp: userMessage.timestamp,
      attachments: userMessage.attachments,
    },
  });

  clearInFlightSlot();
  applyDeferredRestartIfNeeded();
  promoteNextFromPending();
}

function terminalEventAppliesToCurrentInFlight(): boolean {
  return terminalEventMatchesInFlight({
    currentQueueId: getInFlightQueueId(),
    isInterrupting: isInterruptingResponse,
    interruptTargetQueueId: queueState.interruptingInFlightQueueId,
  });
}

function dropInFlightQueueItem(
  reason: string,
  imTerminal: 'cancelled' | 'failed' = 'cancelled',
): string | null {
  const queueId = getInFlightQueueId();
  if (!queueId) return null;
  const requestId = getInFlightMetadata()?.requestId;
  removePendingOutputOwnerByQueueId(queueId);
  if (requestId) {
    if (imTerminal === 'failed') {
      imEventBus.emit(requestId, 'error', buildImErrorPayload(reason));
      imRequestRegistry.setStatus(requestId, 'failed');
    } else {
      imEventBus.emit(requestId, 'cancelled', buildImCancelledPayload());
      imRequestRegistry.setStatus(requestId, 'cancelled');
    }
    imRequestRegistry.unregister(requestId);
  }
  clearInFlightSlot();
  broadcast('queue:cancelled', { queueId });
  console.log(`[agent] In-flight queue item ${queueId} dropped (${reason}) — broadcast queue:cancelled`);
  return queueId;
}

function preserveInFlightAfterTerminalBoundary(reason: string): void {
  const queueId = getInFlightQueueId();
  if (!queueId) return;
  setAwaitingAssistantStartAckQueueId(queueId);
  console.log(`[agent] In-flight queue item ${queueId} preserved after terminal boundary — awaiting SDK replay or assistant-start confirmation (${reason})`);
}

/** Stage one completed top-level assistant text block on the current yield. */
function stageSessionBoundAssistantBlock(text: string): void {
  stageCurrentOutputOwnerAssistantChannelBlock(text);
}

let isApiRetrying = false;  // Track api_retry state to clear when streaming resumes
let transientProviderRetryTimer: ReturnType<typeof setTimeout> | null = null;

type TransientProviderTextRetry =
  Extract<TransientProviderTextRetryDecision, { retry: true }>;

function clearApiRetryStatus(): void {
  if (!isApiRetrying) return;
  isApiRetrying = false;
  broadcast('chat:api-retry', null);
}

function clearTransientProviderRetryTimer(reason: string): void {
  if (!transientProviderRetryTimer) return;
  clearTimeout(transientProviderRetryTimer);
  transientProviderRetryTimer = null;
  clearApiRetryStatus();
  console.log(`[agent][transient-provider-text] cleared pending retry timer (${reason})`);
}

function normalizeAssistantRetryText(text: string): string {
  return text.trim().replace(/\s+/g, ' ');
}

function assistantTextForTransientRetryRetraction(message: MessageWire): string | null {
  if (typeof message.content === 'string') return message.content;
  const parts: string[] = [];
  for (const block of message.content) {
    if (block.type !== 'text') return null;
    parts.push(block.text ?? '');
  }
  return parts.join('');
}

async function retractTransientProviderTextOutput(resultText: string): Promise<void> {
  // The retry resumes the same logical SDK yield. Any text staged for the
  // retracted provider error belongs to that attempt and must not survive,
  // whether its content block already closed or is still open.
  const expected = normalizeAssistantRetryText(resultText);
  if (!expected) {
    clearCurrentOutputOwnerAssistantChannelBlocks();
    pendingTextBlockTexts.clear();
    return;
  }
  const tail = transcriptState.messages[transcriptState.messages.length - 1];
  if (!tail || tail.role !== 'assistant') {
    clearCurrentOutputOwnerAssistantChannelBlocks();
    pendingTextBlockTexts.clear();
    clearCurrentTurnTextBlocks();
    return;
  }
  const tailText = assistantTextForTransientRetryRetraction(tail);
  if (!tailText || normalizeAssistantRetryText(tailText) !== expected) {
    clearCurrentOutputOwnerAssistantChannelBlocks();
    pendingTextBlockTexts.clear();
    clearCurrentTurnTextBlocks();
    return;
  }

  await applyTranscriptRetractionToPersistence(
    sessionId,
    new Set([tail.id]),
    { kind: 'builtin-transient-retry' },
  );
  clearCurrentOutputOwnerAssistantChannelBlocks();
  pendingTextBlockTexts.clear();
  isStreamingMessage = false;
  clearCurrentTurnTextBlocks();
  broadcast('chat:messages-retracted', {
    messageIds: [tail.id],
    retractedStreamingTail: true,
  });
  console.log(`[agent][transient-provider-text] retracted assistant error bubble ${tail.id}`);
}

function scheduleTransientProviderRetry(decision: TransientProviderTextRetry): boolean {
  const source = getCurrentTurnSourceItem();
  if (!source || source.wasQueued) {
    return false;
  }

  clearTransientProviderRetryTimer('reschedule');
  isApiRetrying = true;
  setSessionState('running');
  isStreamingMessage = true;

  const retryItem: MessageQueueItem = {
    ...source,
    id: randomUUID(),
    wasQueued: false,
    resolve: () => {},
    requestId: undefined,
    transientProviderRetry: {
      rootQueueId: source.transientProviderRetry?.rootQueueId ?? source.id,
      attempt: decision.attempt,
    },
  };
  const scheduledSessionId = sessionId;
  transientProviderRetryTimer = setTimeout(() => {
    transientProviderRetryTimer = null;
    if (sessionId !== scheduledSessionId || lifecycleState.abortRequested) {
      clearApiRetryStatus();
      console.log('[agent][transient-provider-text] skipped retry after session changed or aborted');
      return;
    }
    console.log(
      `[agent][transient-provider-text] retrying hidden user turn ` +
      `${decision.attempt}/${decision.maxRetries} root=${retryItem.transientProviderRetry?.rootQueueId}`,
    );
    wakeGenerator(retryItem);
  }, decision.delayMs);
  broadcast('chat:api-retry', {
    attempt: decision.attempt,
    maxRetries: decision.maxRetries,
    delayMs: decision.delayMs,
  });
  return true;
}
// SessionStore's branded transcript cursor owns the durable count. Runtime
// persistence maps only the new tail; reset/switch invalidates the capability
// and reloads it instead of guessing a new count.
const streamIndexToToolId: Map<number, string> = new Map();
const streamIndexToBlockType: Map<number, string> = new Map(); // Positive block type tracking for subagent content_block_stop
const toolResultIndexToId: Map<number, string> = new Map();

// IM Pipeline v2 — Pattern B + G: per-request attribution via FIFO queue.
//
// `turnState.pendingOutputOwners` holds one output-owner slot for every user
// message YIELDED to SDK stdin but not yet finalized (no `result` boundary
// observed). IM slots carry requestId; non-IM slots are null. The HEAD is the
// turn currently owning SDK output; SDK events tagged with an IM head get
// published to ImEventBus where /api/im/events subscribers filter by id.
//
// Why a queue, not a single `activeRequestId` (Codex C4 / Pattern G fix):
// mid-turn injection lets us yield message B while SDK is still processing
// A. The legacy "single `activeRequestId` overwritten on each yield" model
// misattributed A's continuation events to B. Pattern G fix: advance the
// queue only on SDK `result` boundary (handleMessageComplete / Stopped /
// Error), not on yield. So head stays "A" until A's turn ends, then "B".
//
// Replaces the legacy `imStreamCallback` singleton + `imCallbackNulledDuringTurn`
// flag (Pattern B already removed those). Cross-event leakage is structurally
// impossible — old events carry the old requestId, new subscribers filter.
/** Emit a per-request IM event tagged with the queue head. No-op when the
 *  queue head is non-IM or empty. System-level events
 *  (e.g. session-init in Pattern C) call `imEventBus.emit(null, ...)` directly. */
function emitImEvent(type: ImEventType, data?: unknown): void {
  const requestId = peekPendingOutputOwner()?.requestId;
  if (requestId) {
    imEventBus.emit(requestId, type, data);
  }
}

/** Push one output-owner slot for every message yielded to SDK stdin. */
function pushPendingOutputOwner(item: MessageQueueItem): void {
  turnAdmitPendingOutputOwnerForYield({
    queueId: item.id,
    requestId: item.requestId,
    assistantChannelDelivery: item.channelDelivery.assistant,
    channelSessionId: sessionId,
  }, item.transientProviderRetry !== undefined);
}

function removePendingOutputOwnerByQueueId(queueId: string | null | undefined): boolean {
  return turnRemovePendingOutputOwnerByQueueId(queueId);
}

function takeCurrentOutputOwner(): PendingOutputOwner | null {
  return turnPopPendingOutputOwner();
}

function finalizeOutputOwnerRequest(
  owner: PendingOutputOwner | null,
  type: 'complete' | 'cancelled' | 'error',
  status: 'completed' | 'cancelled' | 'failed',
  data?: unknown,
  markCurrentTurn = false,
): void {
  finalizeImRequest(owner?.requestId, type, status, data, markCurrentTurn);
}

function finalizeImRequest(
  requestId: string | null | undefined,
  type: 'complete' | 'cancelled' | 'error',
  status: 'completed' | 'cancelled' | 'failed',
  data?: unknown,
  markCurrentTurn = false,
): void {
  if (!requestId) return;
  imEventBus.emit(requestId, type, data);
  imRequestRegistry.setStatus(requestId, status);
  imRequestRegistry.unregister(requestId);
  if (markCurrentTurn) setCurrentTurnImTerminalEmitted(true);
}

function completeOutputOwnerAfterPersistence(
  owner: PendingOutputOwner | null,
  data: unknown,
  persistence: Promise<unknown>,
  deliverSessionBoundAssistant: boolean,
): void {
  if (!owner) return;
  const durableSuccess = persistence.then(
    () => deliverSessionBoundAssistant,
    () => false,
  );
  if (owner.assistantChannelDelivery === 'session-binding') {
    // Reserve each block on the session-wide transport tail at the SDK result
    // boundary. The work waits for durability without leaving this owner at
    // the FIFO head where a later realtime yield could inherit it.
    for (const text of owner.assistantChannelTextBlocks) {
      appendChannelDelivery('assistant', async () => {
        if (!await durableSuccess) return;
        await mirrorIfChannelBound({
          sessionId: owner.channelSessionId,
          role: 'assistant',
          text,
        });
      });
    }
  }
  void persistence.then(
    () => finalizeOutputOwnerRequest(owner, 'complete', 'completed', data),
    (error) => finalizeOutputOwnerRequest(
      owner,
      'error',
      'failed',
      buildImErrorPayload(error instanceof Error ? error.message : String(error)),
    ),
  );
}

function failOutputOwner(owner: PendingOutputOwner | null, data?: unknown): void {
  finalizeOutputOwnerRequest(owner, 'error', 'failed', data);
}

function cancelCurrentImRequest(data?: unknown): void {
  finalizeOutputOwnerRequest(takeCurrentOutputOwner(), 'cancelled', 'cancelled', data, true);
}

function failCurrentImRequest(data?: unknown): void {
  finalizeOutputOwnerRequest(takeCurrentOutputOwner(), 'error', 'failed', data, true);
}

/** Clear the entire queue — called from abortPersistentSession /
 *  clearMessageState (whole-session abort or reset). Returns drained ids. */
function clearPendingRequests(): string[] {
  return turnClearPendingOutputOwners();
}
// Group chat tool deny list (v0.1.28): set per IM message, cleared on next non-group request
let currentGroupToolsDeny: string[] = [];
// Track text block indices for detecting text-type content_block_stop
const imTextBlockIndices = new Set<number>();

const childToolToParent: Map<string, string> = new Map();
function setCurrentSessionId(next: string): void {
  if (getCurrentProductSessionId() !== next) {
    flushPendingLiveEvents();
    resetBuiltinLiveRevision();
  }
  setCurrentProductSessionId(next);
}

function broadcast(event: string, data: unknown): void {
  if (sessionId && participatesInLiveRestore(event, data)) {
    broadcastLive(event, data, {
      sessionId,
      nextRevision: nextBuiltinLiveRevision,
    });
    return;
  }
  broadcastSse(event, data);
}


// Pre-warm: start SDK subprocess + MCP servers before user sends first message
const PRE_WARM_MAX_RETRIES = 3;
// Global Sidecar sets this to true via --no-pre-warm CLI flag to skip futile pre-warm attempts
// (SDK CLI needs first stdin message before system_init, which never comes for Global Sidecar)
// `lifecycleState.sdkControlReady` is the "subprocess control plane ready" signal — separate from
// `system_init`. The SDK CLI's `system/init` is yielded LATE in QueryEngine.submitMessage
// (after fetchSystemPromptParts → processUserInput → recordTranscript → loadAllPlugins),
// so it's per-turn metadata, NOT a "boot complete" handshake. By contrast,
// `Query.initializationResult()` resolves as soon as the subprocess processes the
// `subtype: "initialize"` control_request — typically <1s after spawn (Codex repro:
// resolved at +337ms). We track that separately so the UI can distinguish:
//   subprocess still booting       → 'AI 启动中'   (lifecycleState.sdkControlReady=false)
//   subprocess ready, turn running → '思考中…'    (lifecycleState.sdkControlReady=true)
// Reset to false on any session restart (abort / switchToSession / config-change reload),
// re-set to true when the next pre-warm's initializationResult resolves.
function releaseTurnAdmissionTicket(queueId?: string): void {
  queueReleaseTurnAdmissionTicket(queueId);
}

function queuedWorkCount(): number {
  return queueQueuedWorkCount();
}

function hasQueuedOrInFlightWork(excludeAdmissionTicketId?: string): boolean {
  return queueHasQueuedOrInFlightWork(excludeAdmissionTicketId);
}
// Pending attachments to persist with user transcriptState.messages
const _pendingAttachments: MessageAttachment[] = [];
// OpenAI Bridge: sidecar port for loopback. Per-token bridge state lives
// in `./openai-bridge/bridge-registry`; this module owns its session's
// token (`activeSessionBridgeToken` below) and the resolver that updates
// when `configState.currentProviderEnv` / `configState.currentModel` change.
let sidecarPort: number = 0;

/** Set the sidecar port (called once from index.ts on startup).
 *
 *  Side effect: exports `MYAGENTS_PORT` to `process.env` so every subprocess
 *  spawned later via `augmentedProcessEnv()` (external runtimes: gemini / claude-code /
 *  codex) inherits it automatically — the AI's shell tool can then invoke
 *  `myagents` CLI without the CLI bailing with `MYAGENTS_PORT not set`. This is
 *  the pit-of-success alternative to editing three runtime `spawn()` call sites
 *  individually: a new runtime added tomorrow gets the same guarantee for free.
 *
 *  The builtin SDK path still sets `env.MYAGENTS_PORT` explicitly in
 *  `buildClaudeSessionEnv()` (idempotent) because pre-warm can spawn before
 *  this function is called and the process.env write would arrive too late. */
export function setSidecarPort(port: number): void {
  sidecarPort = port;
  if (port > 0) {
    process.env.MYAGENTS_PORT = String(port);
  }
}

/** Get the current sidecar port (used by admin-api for self-loopback) */
export function getSidecarPort(): number {
  return sidecarPort;
}

// ── Active session bridge token (PRD #124) ────────────────────────────────
//
// The active session's bridge state used to live in a process-global
// `currentOpenAiBridgeConfig` mutated as a side effect of
// `buildClaudeSessionEnv`. That global was shared with every other SDK
// subprocess (verify, title-gen, sub-agents) — so a one-shot caller
// could silently hijack the active session's routing. The fix moves
// every bridge to a per-subprocess token in `bridge-registry`. The
// active session owns one such token (or none, if its provider is
// non-OpenAI subscription / Anthropic-protocol third-party).
//
// Lifecycle:
//   - registered in `startStreamingSession` when configState.currentProviderEnv is
//     OpenAI-protocol
//   - resolver reads `configState.currentProviderEnv` + `configState.currentModel` live, so
//     mid-flight `setSessionModel` updates take effect immediately
//   - unregistered when the SDK subprocess terminates (session reset,
//     provider switch, abort) — handled in the same paths that clear
//     `configState.currentProviderEnv`

let activeSessionBridgeToken: string | null = null;

/**
 * Build the upstream config that the bridge handler will see for the
 * active session, derived live from `configState.currentProviderEnv` + `configState.currentModel`.
 * Called per-request by the bridge registry resolver — keep it cheap.
 */
async function resolveActiveSessionUpstreamConfig(request?: Request): Promise<UpstreamBridgeConfig> {
  // configState.currentProviderEnv may be undefined (subscription / Anthropic-direct)
  // when the session bridge is registered; that's a registration error
  // upstream of us. Defensive: empty-string baseUrl + no model → bridge
  // handler will fail the upstream call with a clear error.
  const activeProviderEnv = configState.currentProviderEnv
    ? canonicalizeManagedProviderEnv(configState.currentProviderEnv)
    : undefined;
  const aliases = resolveSessionModelAliases(activeProviderEnv?.modelAliases, configState.currentModel);
  const credentialSource = activeProviderEnv?.credentialSource;
  const managedCredential = credentialSource
    ? await resolveManagedOAuthCredential(
        credentialSource.providerId,
        { reason: 'request' },
        request?.signal,
      )
    : undefined;
  return {
    providerId: activeProviderEnv?.providerId ?? SUBSCRIPTION_PROVIDER_ID,
    baseUrl: activeProviderEnv?.baseUrl ?? '',
    apiKey: managedCredential?.accessToken ?? activeProviderEnv?.apiKey ?? '',
    credentialVersion: managedCredential?.credentialVersion,
    recoverAuth: credentialSource
      ? async (rejectedCredentialVersion) => {
          const recovered = await resolveManagedOAuthCredential(
            credentialSource.providerId,
            { reason: 'auth_recovery', rejectedCredentialVersion },
            request?.signal,
          );
          if (!recovered) throw new Error('Managed OAuth recovery returned no credential');
          return { apiKey: recovered.accessToken, credentialVersion: recovered.credentialVersion };
        }
      : undefined,
    rejectCredential: credentialSource
      ? async (credentialVersion) => {
          await resolveManagedOAuthCredential(
            credentialSource.providerId,
            { reason: 'reject', rejectedCredentialVersion: credentialVersion },
            request?.signal,
          );
        }
      : undefined,
    reportOutcome: credentialSource
      ? async (credentialVersion, httpStatus) => {
          await resolveManagedOAuthCredential(
            credentialSource.providerId,
            { reason: 'report', rejectedCredentialVersion: credentialVersion, httpStatus },
            request?.signal,
          );
        }
      : undefined,
    // When aliases exist, don't set model as blanket override — sub-agents
    // need distinct models routed via modelMapping. Without aliases, force
    // ALL request models to configState.currentModel (the historical behavior).
    model: aliases ? undefined : (configState.currentModel || undefined),
    modelAliases: aliases,
    maxOutputTokens: activeProviderEnv?.maxOutputTokens,
    maxOutputTokensParamName: activeProviderEnv?.maxOutputTokensParamName,
    upstreamFormat: activeProviderEnv?.upstreamFormat,
    // #324 — read live so a mid-session effort change applies to the very
    // next upstream request without any subprocess restart.
    reasoningEffort: configState.currentReasoningEffort,
    cacheAffinity: configState.currentProviderEnv?.apiProtocol === 'openai'
      ? { sessionId, promptCacheKeyMode: 'session' }
      : undefined,
  };
}

/**
 * Ensure the active session has a registered bridge token IFF its provider
 * is OpenAI-protocol. Caller MUST pass `freshToken: true` when starting a
 * NEW SDK subprocess (so any in-flight late requests from an old subprocess
 * find their stale token expired) and `freshToken: false` for in-place
 * mid-flight re-syncs (provider switches before the abort fires).
 *
 * The resolver reads `configState.currentProviderEnv` / `configState.currentModel` live, so an
 * existing token automatically reflects mid-session config changes. The
 * fresh-token version is only needed when we're about to spawn a new
 * subprocess that will see a (possibly different) URL.
 */
function ensureActiveSessionBridgeRegistered(opts?: { freshToken?: boolean }): void {
  if (configState.currentProviderEnv?.apiProtocol !== 'openai') {
    // Provider is not OpenAI-protocol — no bridge needed. If a stale token
    // is registered (e.g., from a previous OpenAI provider before a switch),
    // tear it down here so subsequent SDK launches don't route through it.
    if (activeSessionBridgeToken) {
      unregisterBridgeInRegistry(activeSessionBridgeToken);
      activeSessionBridgeToken = null;
    }
    return;
  }
  if (opts?.freshToken && activeSessionBridgeToken) {
    // Caller is about to spawn a new subprocess. Retire the old token so
    // late requests from the dying subprocess get rejected (400 unknown
    // token) instead of resolving to the new subprocess's config — that's
    // the cross-pollination class.
    unregisterBridgeInRegistry(activeSessionBridgeToken);
    activeSessionBridgeToken = null;
  }
  if (!activeSessionBridgeToken) {
    activeSessionBridgeToken = randomUUID();
  }
  registerBridgeInRegistry(
    activeSessionBridgeToken,
    resolveActiveSessionUpstreamConfig,
    `session:${sessionId}`,
  );
}

/**
 * Tear down the active session's bridge token. Called from the session
 * `finally` path when the SDK subprocess exits, so the registry doesn't
 * accumulate stale entries even when subprocesses don't restart cleanly.
 */
function unregisterActiveSessionBridge(): void {
  if (!activeSessionBridgeToken) return;
  unregisterBridgeInRegistry(activeSessionBridgeToken);
  activeSessionBridgeToken = null;
}

/** Returns true if the active session has a registered OpenAI bridge token. */
export function hasActiveBridge(): boolean {
  return activeSessionBridgeToken !== null;
}

/**
 * One-shot bridge: register a per-call token whose resolver returns a
 * static snapshot of the provider config. Used by `provider-verify`,
 * `title-generator`, and `fetchSdkSupportedModels` — code paths that
 * spawn a single SDK subprocess against a specific provider for a
 * bounded operation.
 *
 * Returns the URL-safe token to feed into `buildClaudeSessionEnv`'s
 * `bridgeToken` option. The caller MUST call the returned `release()`
 * function in a `finally` block to unregister; the orphan watchdog
 * is the last-line safety net, not the contract.
 */
export function startOneShotBridge(
  providerEnv: ProviderEnv,
  modelOverride: string | undefined,
  description: string,
  managedPurpose: ManagedOAuthPurpose = { purpose: 'execution' },
): { token: string; release: () => void } {
  if (providerEnv.apiProtocol !== 'openai') {
    throw new Error('startOneShotBridge called with non-OpenAI provider — caller should not need a bridge');
  }
  providerEnv = canonicalizeManagedProviderEnv(providerEnv);
  const token = randomUUID();
  const aliases = resolveSessionModelAliases(providerEnv.modelAliases, modelOverride);
  const snapshot: Omit<UpstreamBridgeConfig, 'apiKey' | 'credentialVersion' | 'recoverAuth' | 'rejectCredential' | 'reportOutcome'> = {
    providerId: providerEnv.providerId ?? '',
    baseUrl: providerEnv.baseUrl ?? '',
    model: aliases ? undefined : (modelOverride || undefined),
    modelAliases: aliases,
    maxOutputTokens: providerEnv.maxOutputTokens,
    maxOutputTokensParamName: providerEnv.maxOutputTokensParamName,
    upstreamFormat: providerEnv.upstreamFormat,
  };
  // Static routing snapshot; managed bearer resolution remains request-scoped.
  registerBridgeInRegistry(token, async (request) => {
    const credentialSource = providerEnv.credentialSource;
    if (!credentialSource) {
      return { ...snapshot, apiKey: providerEnv.apiKey ?? '' };
    }
    const credential = await resolveManagedOAuthCredential(
      credentialSource.providerId,
      { reason: 'request' },
      request?.signal,
      managedPurpose,
    );
    if (!credential) throw new Error('Managed OAuth resolver returned no credential');
    return {
      ...snapshot,
      apiKey: credential.accessToken,
      credentialVersion: credential.credentialVersion,
      recoverAuth: async (rejectedCredentialVersion) => {
        const recovered = await resolveManagedOAuthCredential(
          credentialSource.providerId,
          { reason: 'auth_recovery', rejectedCredentialVersion },
          request?.signal,
          managedPurpose,
        );
        if (!recovered) throw new Error('Managed OAuth recovery returned no credential');
        return { apiKey: recovered.accessToken, credentialVersion: recovered.credentialVersion };
      },
      rejectCredential: async (credentialVersion) => {
        await resolveManagedOAuthCredential(
          credentialSource.providerId,
          { reason: 'reject', rejectedCredentialVersion: credentialVersion },
          request?.signal,
        );
      },
      reportOutcome: async (credentialVersion, httpStatus) => {
        await resolveManagedOAuthCredential(
          credentialSource.providerId,
          { reason: 'report', rejectedCredentialVersion: credentialVersion, httpStatus },
          request?.signal,
        );
      },
    };
  }, description);
  return {
    token,
    release: () => unregisterBridgeInRegistry(token),
  };
}
// SDK 是否已注册当前 sessionId。true 时后续 query 必须用 resume。
// 仅由非 pre-warm 的 system_init 设为 true，仅由 sessionId 变更设为 false。
// Pre-warm 永不修改此标志 — 从结构上消除超时/重试导致的状态错误。
let sessionRegistered = false;

// 时间回溯：对话截断后，下次 query 需携带 resumeSessionAt 截断 SDK 对话历史
let pendingResumeSessionAt: string | undefined;
// PRD 0.2.27 — cold-reload window-B anchor. Captured at LOAD time (loadMessagesFromStorage)
// from the DURABLE persisted tail, NOT re-derived at query time: a direct-send pushes the
// new user row into transcriptState.messages[] (agent-session.ts ~6866) before startStreamingSession runs,
// which would flip the tail to a user message and defeat the tail-is-assistant gate exactly
// in the "rewind → reopen → ask" flow. Capturing at load freezes the truncated tail before
// any new send. Lifecycle mirrors pendingResumeSessionAt: set on load, consumed on
// system_init, cleared on reject / session switch / reset.
// 时间回溯进行中 — 阻止 enqueueUserMessage 并发写入
let rewindPromise: Promise<unknown> | null = null;

// 当前 SDK session 的 UUID 集合（包含磁盘加载 + 运行时 SDK 输出）。
// 用途：rewindFiles 前置校验 + resumeSessionAt 有效性判断（与 transcriptState.liveSessionUuids OR 联合）。
// 过期防护（两层）：
//   1. session 重建（!sessionRegistered）时在 startSession 清空
//   2. SDK 拒绝 UUID（"No message found"）时逐条驱逐（见 error recovery）
// 仅由当前 SDK subprocess stdout 事件填充的 UUID 集合。
// 注意：resume 场景下 SDK 不重新输出旧历史 UUID，因此此集合是运行时子集而非完整集合。
// resumeSessionAt 校验采用 OR 逻辑（transcriptState.liveSessionUuids || transcriptState.currentSessionUuids），
// 不以任一集合为排他权威。
// ===== 持久 Session 门控 =====
// 消息交付：事件驱动替代轮询，generator 阻塞在 waitForMessage 直到新消息到达

/** 唤醒 generator — 投递消息或 null（退出信号） */
function wakeGenerator(item: MessageQueueItem | null): void {
  if (lifecycleState.messageResolver) {
    lifecycleWakeGenerator(item);
  } else if (item) {
    pushMessage(item);
  }
}

/** generator 等待下一条消息（事件驱动，无轮询） */
function waitForMessage(): Promise<MessageQueueItem | null> {
  return lifecycleWaitForMessage(dequeueMessage);
}

/** 当前回合是否仍在进行中 */
export function isTurnInFlight(): boolean {
  return isStreamingMessage;
}

/** 当前正在流式传输的 assistant 消息 ID（未在流式传输时返回 null） */
export function getStreamingAssistantId(): string | null {
  if (!isStreamingMessage || !isAssistantMessagePresent()) return null;
  return getLastAssistantMessageId();
}

// Mid-turn deferred yield buffer (v0.2.11 cross-bugfix #142):
//
// Holds queued transcriptState.messages that arrived while a prior turn was still streaming.
// The generator BUFFERS them here instead of yielding them to SDK — yield is
// deferred until handleMessageComplete/Stopped/Error promotes them via
// promotePendingMidTurnItem(). This is what makes mid-turn cancel actually
// cancel: SDK has not received the message, so removing the entry truly
// suppresses delivery.
//
// Earlier design ("yield-and-ready") yielded immediately and used this queue
// as a UI-side buffer for delayed `transcriptState.messages[]` push and `queue:started`
// broadcast at content block boundaries. That made local splice cancellation
// ineffective once the JSON line had already been written to subprocess stdin.
// v0.2.34 restores a real in-flight cancel boundary through SDK
// cancel_async_message, while keeping later items local here until promotion.
/**
 * Is the session currently busy (any signal of work in flight)?
 *
 * Used by **auto-injection endpoints** (memory-update, future heartbeat
 * variants) to refuse injecting `<system-reminder>` content while the user
 * is actively engaging — those injections trip the SDK's mid-turn
 * `queued_command` mechanism and the prompt design directs the AI to drop
 * its current turn and process the injected request, which is exactly the
 * complaint in issue #190 ("memory update interrupts long-running tasks").
 *
 * Returns true when ANY of:
 *   - `sessionState !== 'idle'` (running / starting / error — turn or
 *     subprocess transitioning)
 *   - `isStreamingMessage` (defensive — assistant text/tool stream live)
 *   - `queueState.messageQueue.length > 0` (user direct-send waiting to start a turn)
 *   - `queueState.inFlightToCliId !== null` (mid-turn item yielded to SDK, awaiting replay/cancel)
 *   - `queueState.pendingMidTurnQueue.length > 0` (mid-turn item buffered for replay)
 *   - `queueState.turnBoundaryQueue.length > 0` (desktop turn-mode item waiting for a clean turn boundary)
 *   - `queueState.turnAdmissionTicket !== null` (turn-mode direct send admitted but not yet visible as busy)
 *   - `queueState.promotedItemInFlight` (item has left the local queue and the generator
 *      is transitioning it into the SDK yield)
 *
 * Pre-warm exception: `lifecycleState.preWarming=true` is **not** treated as busy.
 * Pre-warm sessions are cold/idle (sessionState stays 'idle' for the
 * pre-warm path) and accepting an auto-injection during pre-warm just
 * means the first message the live session processes is the injection —
 * that is the ideal time to update memory, not a regression.
 *
 * Single source of truth for "is this session safe to auto-inject":
 * called from `/api/memory/update` (and may be reused by future injection
 * endpoints) so the gate is evaluated by the process that actually owns
 * the state, not via stale disk-timestamp proxies (see `lastActiveAt`
 * gate in `memory_update.rs::run_batch` — it only updates on turn
 * boundaries, so a single multi-minute turn ages past the 15-min cooldown
 * even though the session is plainly mid-work; that's how #190 slipped
 * through every existing gate).
 */
export function isSessionBusy(): boolean {
  return sessionState !== 'idle'
    || isStreamingMessage
    || hasQueuedOrInFlightWork()
    || queueState.promotedItemInFlight;
}

/**
 * Rescue pending mid-turn items back to queueState.messageQueue front when the SDK subprocess
 * is about to die (abortPersistentSession or interruptCurrentResponse hard-kill).
 *
 * (v0.2.11) With deferred-yield design, pending items have NOT been yielded to
 * SDK — they live entirely in this Node process. So rescue is no longer a
 * "subprocess death recovery" measure but simply a queue-merge: pending items
 * become the front of queueState.messageQueue so the recovery session re-delivers them
 * (no deduplication needed because SDK never saw them).
 *
 * Safe to call regardless of whether SDK stays alive — the deduplication
 * concern from the old design (double-delivery via stdin buffer + queueState.messageQueue)
 * no longer exists.
 */
// (v0.2.12) The cancelledInflightIds checkpoint set used by the deferred-yield
// design (ce747cd2) is gone. With lockstep mid-turn injection, items are
// either in queueState.messageQueue / queueState.pendingMidTurnQueue (cancellable by splice) or
// in CLI's commandQueue (cancellable only through SDK cancel_async_message
// while still pending). The old "promoted but not yet yielded" race window
// still has no separate UI surface.

function rescuePendingToQueue(): void {
  const pendingCount = getPendingMidTurnQueue().length;
  if (pendingCount === 0) return;
  console.log(`[agent] Rescuing ${pendingCount} pending mid-turn message(s) → queueState.messageQueue front`);
  rescuePendingMidTurnToMessageFront();
}

/**
 * (v0.2.12) Lockstep yield: promote the next queueState.pendingMidTurnQueue item into
 * CLI's commandQueue. Called from:
 *   - handleQueuedCommandReplay (CLI confirmed AI saw the in-flight item
 *     mid-turn): the in-flight slot just opened, hand the next over.
 *   - successful SDK cancel of the in-flight item or a confirmed assistant
 *     boundary, which frees the slot and lets the next item be handed to SDK.
 *
 * Idempotent: bails when queueState.inFlightToCliId !== null (the slot is occupied)
 * or queueState.pendingMidTurnQueue is empty.
 */
function promoteNextFromPending(): void {
  if (getInFlightQueueId() !== null) return;
  const pendingCount = getPendingMidTurnQueue().length;
  if (pendingCount === 0) return;
  if (lifecycleState.abortRequested) {
    console.log(`[agent] Promote skipped — session aborting (${pendingCount} pending will be rescued)`);
    return;
  }
  if (!lifecycleState.messageResolver) {
    console.log('[agent] Promote skipped — generator not parked; pending stays for recovery generator');
    return;
  }
  const pending = shiftPendingMidTurn()!;
  const promotedText = typeof pending.userMessage.content === 'string'
    ? pending.userMessage.content
    : '';
  setInFlightQueueItem(pending.queueId, {
    messageText: promotedText,
    attachments: pending.userMessage.attachments,
    requestId: pending.sourceItem.requestId,
    analyticsSource: pending.sourceItem.analyticsSource,
    analyticsOrigin: pending.sourceItem.analyticsOrigin,
    channelDelivery: pending.sourceItem.channelDelivery,
  });
  console.log(`[agent] Promoting next pending mid-turn message: queueId=${pending.queueId} (pending remaining=${getPendingMidTurnQueue().length})`);
  // Re-emit queue:added with isInFlight=true. Frontend's queue:added handler
  // de-dups by queueId and updates the isInFlight flag in place — no separate
  // event needed. Reusing the existing event keeps ALL_EVENTS count stable
  // (SseConnection cleanup-invariant tests are sensitive to listener count
  // shifts in the cancel-after-start-sse_proxy race).
  broadcast('queue:added', {
    queueId: pending.queueId,
    messageText: promotedText.slice(0, 100),
    isInFlight: true,
    deliveryMode: pending.sourceItem.deliveryMode,
  });
  wakeGenerator(pending.sourceItem);
}

function startNextTurnQueuedItem(
  reason: 'complete' | 'stopped' | 'error' | 'recovery',
  options?: { forceQueueId?: string; allowRealtimePending?: boolean },
): boolean {
  const turnBoundaryQueue = getTurnBoundaryQueue();
  if (turnBoundaryQueue.length === 0) return false;
  const requestedQueueId = options?.forceQueueId ?? getForceTurnBoundaryQueueId();
  const queueIndex = requestedQueueId
    ? turnBoundaryQueue.findIndex(item => item.queueId === requestedQueueId)
    : 0;
  if (queueIndex < 0) {
    if (requestedQueueId === getForceTurnBoundaryQueueId()) {
      setForceTurnBoundaryQueueId(null);
    }
    return false;
  }
  const queuedItem = turnBoundaryQueue[queueIndex];
  if (!queuedItem?.ready || !queuedItem.sourceItem) {
    return false;
  }
  if (!shouldStartTurnBoundaryItem({
    hasTurnInFlight: isTurnInFlight(),
    hasCompetingAdmissionTicket: getTurnAdmissionTicket() !== null
      && getTurnAdmissionTicket()?.queueId !== queuedItem.queueId,
    hasInFlightToCli: getInFlightQueueId() !== null,
    hasPendingMidTurn: getPendingMidTurnQueue().length > 0,
    allowRealtimePending: options?.allowRealtimePending,
    hasMessageQueue: getMessageQueue().length > 0,
    promotedItemInFlight: queueState.promotedItemInFlight,
    shouldAbortSession: lifecycleState.abortRequested,
    reason,
    hasQuerySession: lifecycleState.query !== null,
    hasResetInProgress: getSessionMutationBarrier() !== null,
    hasRewindInProgress: Boolean(rewindPromise),
  })) {
    return false;
  }

  const [item] = spliceTurnBoundary(queueIndex, 1);
  if (!item.sourceItem) return false;
  const sourceItem = item.sourceItem;
  if (item.queueId === getForceTurnBoundaryQueueId()) {
    setForceTurnBoundaryQueueId(null);
  }
  const userMessage: MessageWire = {
    id: allocateMessageId(),
    role: 'user',
    content: item.messageText,
    timestamp: new Date().toISOString(),
    attachments: item.attachments,
    metadata: item.source ? { source: item.source } : undefined,
  };
  const surface: DeferredUserSurface = {
    event: 'queue-started',
    queueId: item.queueId,
    message: userMessage,
    mirrorImages: item.mirrorImages,
    channelDelivery: sourceItem.channelDelivery,
  };
  // Turn-boundary messages are not runtime-visible yet. Keep their user
  // surface attached to the queue owner so admission can persist it before
  // yielding to the SDK. A failed write must terminate this turn, never race a
  // fire-and-forget persistence promise against runtime dispatch.
  sourceItem.deferredUserSurface = surface;

  console.log(`[agent] Starting turn-boundary queued message: queueId=${item.queueId} reason=${reason} remaining=${getTurnBoundaryQueue().length}`);
  if (!sourceItem.deferVisibleAdmission) {
    setSessionState((lifecycleState.systemInitInfo || lifecycleState.sdkControlReady) ? 'running' : 'starting');
  }

  if (!lifecycleState.query) {
    resetPreWarmFailCount();
    if (reason === 'recovery') {
      resetAbortFlag();
    }
    pushMessage(sourceItem);
    setTimeout(() => {
      startStreamingSession(sourceItem.deferVisibleAdmission).catch((error) => {
        console.error('[agent] failed to start session for turn-boundary queue', error);
      });
    }, 0);
  } else {
    wakeGenerator(sourceItem);
  }
  return true;
}

function schedulePostTerminalQueueDrain(reason: 'complete' | 'stopped' | 'error' | 'recovery'): void {
  setTimeout(() => {
    if (
      getForceTurnBoundaryQueueId()
      && startNextTurnQueuedItem(reason, {
        forceQueueId: getForceTurnBoundaryQueueId() ?? undefined,
        allowRealtimePending: true,
      })
    ) {
      return;
    }
    promoteNextFromPending();
    startNextTurnQueuedItem(reason);
  }, 0);
}

/**
 * (v0.2.12) Handle SDKUserMessageReplay for our in-flight queued_command.
 *
 * CLI emits this event when it drains a queued_command attachment from
 * its commandQueue mid-turn (claude-code/src/QueryEngine.ts:880). The
 * event carries `attachment.source_uuid` (which we set as the SDKUserMessage
 * uuid on yield) so we can match the replay back to queueState.inFlightToCliId.
 *
 * Receiving this means AI's NEXT API call will include the queued_command
 * as a user-role attachment in its context — i.e. the message has crossed
 * the confirmed-consumption boundary. Time to:
 *   1. Push it into transcriptState.messages[] (now visible in chat history)
 *   2. Persist + broadcast queue:started so frontend renders the bubble
 *      inline with the streaming assistant content (midTurnBreak split)
 *   3. Clear queueState.inFlightToCliId and promote the next pending item, which
 *      yields it to CLI for the next mid-turn drain
 */
async function handleQueuedCommandReplay(
  sdkMessage: { uuid?: string }
): Promise<void> {
  const queueId = getInFlightQueueId();
  if (!queueId) return; // defensive — caller already matched
  const meta = getInFlightMetadata();
  if (!meta) {
    console.warn(`[agent] queued_command replay arrived but queueState.inFlightMetadata is null, queueId=${queueId}`);
  }
  console.log(`[agent] queued_command replay consumed by AI: queueId=${queueId}`);
  await surfaceInFlightQueueItem(queueId, meta, {
    sdkUuid: sdkMessage.uuid,
    midTurnBreak: true,
    reason: 'SDKUserMessageReplay consumed by AI',
    awaitPersist: true,
  });
}

function maybeSurfaceInFlightAtAssistantTurnStart(reason: string): void {
  if (isStreamingMessage) return;
  const queueId = getInFlightQueueId();
  if (!queueId) return;
  if (queueState.awaitingAssistantStartAckQueueId !== queueId) return;
  const meta = getInFlightMetadata();
  void surfaceInFlightQueueItem(queueId, meta, {
    sdkUuid: queueId,
    reason,
    awaitPersist: false,
    schedulePersist: true,
  }).catch((error) => {
    console.error(`[agent] Failed to surface in-flight queue item ${queueId} at assistant turn start:`, error);
  });
}

/** 中止持久 session：唤醒所有被阻塞的 Promise */
function abortPersistentSession(options: { notifyPendingRequests?: boolean } = {}): void {
  const notifyPendingRequests = options.notifyPendingRequests ?? true;
  clearTransientProviderRetryTimer('abort');
  // This is the only abort-request write path. The lifecycle owner flips the
  // flag; this facade performs the cross-owner cleanup chain below.
  requestAbort();
  // Unconfirmed in-flight items belong to the SDK subprocess that is about
  // to die. Do not silently clear them (leaves UI pills behind) and do not
  // requeue them (could duplicate a message the SDK already consumed but
  // never replayed before abort). Terminate the UI honestly.
  dropInFlightQueueItem('session aborted before SDK consumption confirmation', 'failed');
  if (shouldClearAdmissionTicketOnAbort({
    ticketQueueId: getTurnAdmissionTicket()?.queueId,
    committingQueueId: getCommittingTurnAdmissionQueueId(),
  })) {
    releaseTurnAdmissionTicket();
  }
  const promotedCancellation = cancelPromotedItemWithSettlement();
  if (promotedCancellation) {
    registerSessionAbortCleanup(
      promotedCancellation.settlement.then(async () => {
        await notifyQueuedTurnStopped(
          promotedCancellation.item,
          'Session aborted before queue dispatch',
        );
      }).finally(() => {
        clearPromotedItem(promotedCancellation.item.id);
      }),
    );
  }
  // Subprocess is about to die — rescue pending items so the recovery session
  // re-delivers them instead of losing them with the dead stdin buffer.
  rescuePendingToQueue();
  // Pattern B/C/G: notify IM bus subscribers + tear down ALL pending registry
  // entries (whole-session abort affects every in-flight request, not just head).
  // Emit an 'error' for each requestId so each subscriber's reply slot closes —
  // emitImEvent only tags head, so iterate manually. Internal self-healing
  // restarts may suppress this notification when the turn lifecycle will own
  // terminal cleanup and no user-visible abort should be emitted.
  if (notifyPendingRequests) {
    for (const reqId of getPendingImRequestIds()) {
      imEventBus.emit(reqId, 'error', buildImErrorPayload('会话已中断，请重新发送'));
      imRequestRegistry.setStatus(reqId, 'failed');
      imRequestRegistry.unregister(reqId);
    }
  }
  clearPendingRequests();
  // PRD 0.2.18 Session Inbox — if abort happens while an inbox-message turn is
  // in flight, push a session_aborted reply back to the caller so it doesn't
  // wait forever. Fire-and-forget. Read + clear immediately to avoid the
  // recovery session inheriting this binding.
  const { inboxMeta: replyMeta, replyText: abortedReplyText } = terminalCleanup();
  if (notifyPendingRequests && replyMeta) {
    const abortedSessionId = sessionId;
    void import('./inbox/reply-deliver').then(({ deliverInboxReply }) =>
      deliverInboxReply(abortedSessionId, replyMeta, {
        text: abortedReplyText,
        error: {
          code: 'session_aborted',
          message: 'target session was aborted before the turn completed',
        },
      }),
    ).catch((err) =>
      console.error('[inbox] abort-path reply pushback failed:', err),
    );
  }
  if (notifyPendingRequests) {
    void import('./inbox/watch-deliver').then(({ deliverSessionWatchEvents }) =>
      deliverSessionWatchEvents(sessionId, {
        text: abortedReplyText,
        error: {
          code: 'session_aborted',
          message: 'target session was aborted before the turn completed',
        },
      }),
    ).catch((err) =>
      console.error('[session-watch] abort-path watch push failed:', err),
    );
  }
  // 唤醒被阻塞的 generator（waitForMessage）
  forceWakeGeneratorWithNull();
  // 强制 subprocess 产出消息/错误，解除 for-await 阻塞
  lifecycleState.query?.interrupt().catch(() => {});
}

// ===== Interaction Scenario (unified system prompt) =====
import { buildSystemPromptAppend, type InteractionScenario } from './system-prompt';
import {
  channelInteractionDenyReason,
  getChannelInteractionDisallowedTools,
  shouldDisallowAskUserQuestion,
  shouldHardDenyChannelInteractionTool,
  shouldUseNonBypassForNativeAskUserQuestion,
  supportsAskUserQuestionNativeCard,
} from './host-interaction';

let currentScenario: InteractionScenario = { type: 'desktop' };

/**
 * Set the interaction scenario for the current session.
 * This determines the system prompt layers (identity + channel + scenario instructions).
 */
export async function setInteractionScenario(scenario: InteractionScenario): Promise<void> {
  currentScenario = scenario;
  if (shouldUseNonBypassForNativeAskUserQuestion(configState.currentPermissionMode, scenario)) {
    await lifecycleState.query?.setPermissionMode('acceptEdits').catch(err => {
      console.warn('[agent] failed to switch native-card channel session out of bypassPermissions:', err);
    });
  }
  if (isDebugMode) {
    console.log(`[agent] Interaction scenario: ${scenario.type}`);
  }
}

/**
 * Reset interaction scenario to default (desktop).
 */
export function resetInteractionScenario(): void {
  currentScenario = { type: 'desktop' };
  if (isDebugMode) {
    console.log('[agent] Interaction scenario reset to desktop');
  }
}
// SDK ready signal - prevents messageGenerator from yielding before SDK's ProcessTransport is ready
let _sdkReadyResolve: (() => void) | null = null;
let _sdkReadyPromise: Promise<void> | null = null;

// ===== Turn-level Usage Tracking =====
// Token usage for the current turn, extracted from SDK result message
// PRD 0.2.32 — 当前 context 占用必须取「最近一次调用」而非 turn 聚合（带工具的一轮发多次
// API、每次重发上下文，求和会严重高估）。捕获最近一条主轮 assistant message 的 usage，
// 在 turn 末算占用并 broadcast chat:context-usage。turnState.currentTurnUsage 是聚合值，不能复用。
// Timestamp when current assistant response started
// Tool count for current turn
let builtinTurnTraceId = '';
let builtinTurnTraceStartMs = 0;
let builtinTurnTraceSessionId = '';
let builtinTurnTraceRequestId: string | undefined;
let builtinFirstDeltaTraceEmitted = false;
const builtinToolTraceStarts = new Map<string, number>();
// Whether the current turn produced any visible assistant text output
// SDK assistant transcriptState.messages can carry a provisional .error even when the final
// SDK result later succeeds. Keep it turn-local until the authoritative result.
// Whether the current turn observed any non-init SDK frame (assistant /
// user / tool_result / stream_event / result / rate_limit_event etc.).
// Cheaper signal than turnState.currentTurnHasOutput — flips on the FIRST substantive
// SDK frame, before the assistant message is fully assembled. Used by the
// inactivity watchdog to decide whether to set pendingContinueAfterAbort
// (replaces the previous `messageCount > 3` heuristic, which was both
// cumulative across turns and brittle against SDK init-framing changes).
// PRD 0.2.18 Session Inbox — per-turn binding of inbox metadata.
//
// Bound when the message generator yields a queued item that carries inboxMeta
// (i.e. the message came in via /api/inbox/drain from a `myagents session send`
// caller). Read at SDK result event handler: if replyBack=true, the turn's text
// output is collected and pushed back to the caller via deliverInboxReply().
//
// CRITICAL — per-turn semantics, NOT session-level singleton:
//   - Bound on dequeue (generator yield), not on enqueue (PRD §5.5)
//   - Read at result handler, then immediately cleared
//   - Abort path: cleared too, optionally sends a session_aborted reply first
//   - Multiple consecutive inbox transcriptState.messages each get their own binding via the
//     same per-turn dequeue path (the next yield overwrites — correct because
//     SDK persistent session is single-threaded turn execution)

// Accumulator for assistant text blocks within the current turn. Session send
// only reads it when an inbox binding exists, while session watch reads it for
// ordinary user/cron/IM turns too. Reset at turn start.

// ─── Watchdog Auto Resume (watchdog-driven session resume) ────────────────
//
// When the inactivity watchdog (`apiWatchdogId` setInterval below the
// SDK for-await loop) aborts a turn that produced real output, the
// SessionMetadata gets `pendingContinueAfterAbort=true` and the sidecar
// schedules one automatic system-reminder turn after the old SDK process
// finishes tearing down. The disk flag remains the crash/restart fallback:
// the next `enqueueUserMessage` call against this session can still consume
// it if the auto task never got to run or released ownership without success.
//
// Both paths synchronously test-and-set the per-session guard, accept a single
// system-reminder turn, mark the per-process cap, then best-effort clear the
// disk flag.
//
// `consumingPendingContinueSessions` is a per-session synchronous lock
// preventing two concurrent enqueueUserMessage callers against the SAME
// session from each injecting a reminder. Per-session (not global) so
// two different sessions consuming their own flags in parallel don't
// block each other — cross-review caught the global lock as a real
// correctness issue (second session would silently skip consume).
const consumingPendingContinueSessions = new Set<string>();

// In-process ownership marker for the automatic post-watchdog task. While this
// is set, the disk flag is not available to next-enqueue fallback consumers;
// manual transcriptState.messages that arrive during abort teardown must queue behind the
// scheduled auto-resume reminder instead of stealing the flag.
const scheduledWatchdogAutoResumeSessions = new Set<string>();

// Cap auto-Continue at exactly ONE injection per sessionId per sidecar
// process lifetime. Without this cap, the chain
//   watchdog abort → consume + inject reminder → reminder turn produces 1 byte
//   then itself watchdog-aborts → flag re-set → user's next message consumes
//   again → reminder again → ...
// would loop. The empty-turn skip in the watchdog catches "the API is dead"
// turns, but a reminder turn that gets *some* output before stalling would
// otherwise re-arm the flag. Capping per-session here is the structural
// guarantee that the user's "避免循环重试" requirement holds even under
// the partial-output-then-hang scenario.
//
// The Set is added after a successful reminder enqueue (post-await,
// post-session-switch-verification). If the reminder rejects (queue full)
// or a switchToSession races, neither the disk flag nor this Set is updated.
// If clearing the disk flag fails after accept, this Set still blocks duplicate
// reminder injection for the rest of this sidecar process.
//
// New sidecar process = new Set = one fresh auto-Continue allowed (e.g.,
// user opens an aborted-cron session hours later in chat). That's
// intentional, matching the spec.
const autoResumeInjectedSessions = new Set<string>();

function resetTurnUsage(): void {
  resetBuiltinTurnUsage();
  // Note: turnState.currentTurnInboxMeta is NOT reset here — it's bound on dequeue
  // (generator yield) and cleared at result handler / abort path.
}

/**
 * PRD 0.2.32 — broadcast 归一化的 context 用量快照（builtin runtime）。
 *
 * 两条占用源（按代价递增）：
 *  1. 快路径：最近一条**主轮** assistant message 的 per-call `usage.input + cacheRead + cacheCreation`。
 *     Anthropic 直连和大部分填 `BetaMessage.usage` 的兼容供应商命中此路，零额外 SDK 往返。
 *  2. 回落（#343）：当 #1 缺失（火山方舟 MiniMax M3 等 Anthropic-compat 第三方供应商只回
 *     `result.modelUsage` 聚合、不填 streamed assistant frame 的 `message.usage`，且 `/compact`
 *     控制轮无主轮 assistant message），改向 SDK 控制面 `lifecycleState.query.getContextUsage()` 取数——
 *     这是 `/context` 斜杠命令同源，**SDK 自身追踪的当前窗口占用** (`totalTokens`)，与提供商
 *     wire 是否回传 per-message usage 无关。
 *
 * 为什么 SDK 源能同时安然处理 #323 `/compact` 场景：`totalTokens` 是 SDK 当前窗口占用估算
 * （categories + apiUsage），不是 turn 聚合 cache-read 求和。`/compact` 落地后这个数等于压缩
 * **后**的新（小）窗口——正是圆环该显示的值。#323 的 4.55M / 20.40M 灾难只来自盲目用
 * `turnState.currentTurnUsage.cacheReadTokens`（N 次工具调用求和），此源无该坑。
 *
 * 窗口：优先 `lookupModelContextLength`（与注入的 `CLAUDE_CODE_AUTO_COMPACT_WINDOW` 同源）。
 * registry 无法识别版本化 / 用户手填 `[1m]` 模型时，才回落 SDK 控制面的 maxTokens 或 `[1m]`
 * 标签语义；缺省 SDK 200K。**不**用 `ModelUsage.contextWindow` 覆盖 registry 命中的模型
 * （对 bridge 的第三方 builtin 模型只回 200K 默认，与 auto-compact 实际窗口失配）。
 */
async function broadcastBuiltinContextUsage(): Promise<void> {
  // **同步捕获** turn-末 state，再进入可能 await 的回落分支。`broadcastBuiltinContextUsage()`
  // 现在以 `void` 形式从 result 处理器 fire-and-forget；如果不抓快照，await 期间下一轮的
  // `resetTurnUsage()` 可能把 `turnState.currentTurnUsage.model`/`sessionId` 改掉，给本轮的 broadcast/
  // 持久化盖错头。`turnState.latestMainAssistantUsage` 在函数入口同步读，已经天然是快照。
  const occupiedFromPerCall = resolveContextOccupancyTokens(turnState.latestMainAssistantUsage);
  const currentProviderId = getSessionProviderId() ?? SUBSCRIPTION_PROVIDER_ID;
  const providerScopedLookup = (model?: string | null) =>
    lookupProviderModelContextLength(model, currentProviderId);
  const snapshotModel = chooseBuiltinContextUsageModel({
    sdkResultModel: turnState.currentTurnUsage.model,
    configuredModel: configState.currentModel,
    lookupWindow: providerScopedLookup,
  });
  const snapshotSessionId = sessionId;
  const snapshotQuerySession = lifecycleState.query;
  const registryWindow = providerScopedLookup(snapshotModel);
  let runtimeWindow: number | null = registryWindow ? null : inferContextWindowFromSdkModelTag(snapshotModel);

  let occupied = occupiedFromPerCall;

  // 快路径 miss → 问 SDK 自己的 context-usage 源（`/context` 命令同源）。这条修复了：
  //   (a) #343：火山方舟等兼容供应商不填 per-message usage 时圆环一直空（`chat:context-usage`
  //       永不广播），即便 `/context` 命令在终端能正常显示 122.8k/512k；
  //   (b) #323 的善后：`/compact` 后改为显示真实的压缩**后**占用，而不是「跳过、等下条消息自愈」。
  // SDK 控制请求 reject 的话静默回落到老的「跳过」语义；不引入新失败模式。
  if (occupied === null && snapshotQuerySession) {
    try {
      const ctx = await snapshotQuerySession.getContextUsage();
      occupied = resolveContextOccupancyFromSdkBreakdown(ctx);
      if (!registryWindow) {
        runtimeWindow = resolveContextWindowFromSdkBreakdown(ctx) ?? runtimeWindow;
      }
    } catch (err) {
      console.debug('[agent] getContextUsage fallback failed (will skip context-usage broadcast):', err);
    }
  }

  if (occupied === null) return; // 两源都拿不到 — 不广播假占用，前端保留上次可信值

  const usage = computeContextUsage({
    occupiedTokens: occupied,
    runtimeWindow,
    source: 'builtin',
    model: snapshotModel,
    lookupWindow: providerScopedLookup,
  });
  broadcast('chat:context-usage', { ...usage, sessionId: snapshotSessionId });
  // PRD 0.2.32 — 持久化**同一个**快照到 session 记录（单一数据源）。每轮末一次写盘，
  // 重开会话时前端从 session metadata seed → 环立即显示且与会话期间一致。fire-and-forget。
  void updateSessionMetadata(snapshotSessionId, { lastContextUsage: usage }).catch((err) =>
    console.warn('[agent] persist lastContextUsage failed:', err),
  );
}

type BuiltinTurnTraceSnapshot = {
  turnId: string;
  startMs: number;
  sessionId: string;
  requestId?: string;
};

function snapshotBuiltinTurnTrace(): BuiltinTurnTraceSnapshot | null {
  if (!builtinTurnTraceId || !builtinTurnTraceStartMs) return null;
  return {
    turnId: builtinTurnTraceId,
    startMs: builtinTurnTraceStartMs,
    sessionId: builtinTurnTraceSessionId || sessionId,
    requestId: builtinTurnTraceRequestId,
  };
}

function beginBuiltinTurnTrace(source: string, turnId: string, requestId?: string): void {
  builtinTurnTraceId = turnId;
  builtinTurnTraceStartMs = nowMs();
  builtinTurnTraceSessionId = sessionId;
  builtinTurnTraceRequestId = requestId;
  builtinFirstDeltaTraceEmitted = false;
  builtinToolTraceStarts.clear();
  emitBuiltinTurnTrace('turn_start', {
    status: 'ok',
    detail: { source },
  });
}

function emitBuiltinTurnTrace(
  phase: string,
  options: {
    status?: 'ok' | 'error' | 'timeout' | 'skipped';
    durationMs?: number;
    sizeBytes?: number;
    count?: number;
    detail?: Record<string, string | number | boolean | null | undefined>;
  } = {},
  snapshot: BuiltinTurnTraceSnapshot | null = snapshotBuiltinTurnTrace(),
): void {
  if (!snapshot) return;
  emitPerfTrace({
    trace: 'turn',
    phase,
    durationMs: options.durationMs ?? elapsedMs(snapshot.startMs),
    sessionId: snapshot.sessionId || undefined,
    requestId: snapshot.requestId,
    turnId: snapshot.turnId,
    runtime: 'builtin',
    status: options.status ?? 'ok',
    sizeBytes: options.sizeBytes,
    count: options.count,
    detail: options.detail,
  });
}

function reportBuiltinAdmissionPersistenceFailure(
  queueId: string,
  requestId: string | undefined,
  error: unknown,
): string {
  const admissionError = error instanceof Error ? error.message : String(error);
  emitPerfTrace({
    trace: 'turn',
    phase: 'admission_persist',
    status: 'error',
    runtime: 'builtin',
    sessionId,
    requestId,
    turnId: queueId,
    detail: {
      action: 'dispatch_blocked',
      queueId,
      error: admissionError,
    },
  });
  console.error(
    `[agent] admission_persist action=dispatch_blocked runtime=builtin sessionId=${sessionId} queueId=${queueId} requestId=${requestId ?? '-'} error=${admissionError}`,
  );
  return admissionError;
}

function emitBuiltinFirstDeltaTrace(delta: string): void {
  if (builtinFirstDeltaTraceEmitted || !builtinTurnTraceId) return;
  builtinFirstDeltaTraceEmitted = true;
  emitBuiltinTurnTrace('first_delta', {
    sizeBytes: Buffer.byteLength(delta, 'utf8'),
  });
}

function emitBuiltinToolStartTrace(toolUseId: string, toolName: string, isSubAgent = false): void {
  if (!builtinTurnTraceId) return;
  builtinToolTraceStarts.set(toolUseId, nowMs());
  emitBuiltinTurnTrace('tool_start', {
    detail: { toolUseId, toolName, subAgent: isSubAgent },
  });
}

function emitBuiltinToolEndTrace(toolUseId: string, isError?: boolean): void {
  if (!builtinTurnTraceId) return;
  const started = builtinToolTraceStarts.get(toolUseId);
  builtinToolTraceStarts.delete(toolUseId);
  emitBuiltinTurnTrace('tool_end', {
    status: isError ? 'error' : 'ok',
    durationMs: started ? elapsedMs(started) : undefined,
    detail: { toolUseId },
  });
}

function clearBuiltinTurnTrace(snapshot: BuiltinTurnTraceSnapshot | null = snapshotBuiltinTurnTrace()): void {
  if (snapshot && snapshot.turnId !== builtinTurnTraceId) return;
  builtinTurnTraceId = '';
  builtinTurnTraceStartMs = 0;
  builtinTurnTraceSessionId = '';
  builtinTurnTraceRequestId = undefined;
  builtinFirstDeltaTraceEmitted = false;
  builtinToolTraceStarts.clear();
}

// ===== MCP Configuration =====
import type { McpServerDefinition } from '../shared/config-types';
// SDK's in-process server instance type — what createSdkMcpServer() returns.
// Imported as a type (no runtime cost) so we can annotate the buildSdkMcpServers
// result map without relying on a module-level singleton.
import type { McpSdkServerConfigWithInstance } from '@anthropic-ai/claude-agent-sdk';

// SDK MCP server config type (subset of what SDK accepts — external transports only)
type SdkMcpServerConfig = {
  type?: 'stdio';
  command: string;
  args?: string[];
  env?: Record<string, string>;
} | {
  type: 'sse' | 'http';
  url: string;
  headers?: Record<string, string>;
};

// Union type for buildSdkMcpServers result — each slot is either an external
// transport spec (SDK spawns subprocess / hits URL) or an in-process SDK
// server object (tool handlers run in this Node process).
type McpServerEntry = SdkMcpServerConfig | McpSdkServerConfigWithInstance;
let builtBrowserHostGeneration = 0;
let builtBrowserCapabilityToken = '';
let builtBrowserCapabilityRevision = 0;
let builtinBrowserHostRecovery: Promise<void> | null = null;
let builtinMcpEffectiveSnapshot: McpEffectiveSnapshot | null = null;
let builtinMcpEffectiveRevision = 0;
let builtinMcpCatalogGeneration = 0;
let builtinMcpObserverAbort: AbortController | null = null;
let builtinMcpLastStatuses: Awaited<ReturnType<Query['mcpServerStatus']>> = [];

function observeBuiltinBrowserCapability(capability: {
  hostGeneration: number;
  token: string;
}): boolean {
  const changed = capability.hostGeneration !== builtBrowserHostGeneration
    || capability.token !== builtBrowserCapabilityToken;
  builtBrowserHostGeneration = capability.hostGeneration;
  if (capability.token !== builtBrowserCapabilityToken) {
    builtBrowserCapabilityToken = capability.token;
    builtBrowserCapabilityRevision += 1;
  }
  return changed;
}
type StagedBuiltinStdio = {
  id: string;
  config: SdkMcpServerConfig;
  command: string;
  args: string[];
};
type BuiltinMcpAdmissionOwner = {
  runtimeGeneration: number;
  configGeneration: number;
  desiredKey: string;
  serverIds: string[];
  startedAt: number;
  demand: McpStartupDemand;
  lease: McpStartupLease | null;
  state: 'queued' | 'granted' | 'settled' | 'unmanaged';
};
let builtinMcpStartupRuntimeGeneration = 0;
let builtinMcpStartupConfigGeneration = 0;
let builtinMcpAdmissionOwner: BuiltinMcpAdmissionOwner | null = null;

function releaseBuiltinMcpAdmissionOwner(): void {
  const owner = builtinMcpAdmissionOwner;
  builtinMcpAdmissionOwner = null;
  owner?.demand.cancel();
  if (owner?.lease) void settleMcpStartupLease(owner.lease, 'released');
}

function beginBuiltinMcpStartupGeneration(): void {
  releaseBuiltinMcpAdmissionOwner();
  builtinMcpStartupRuntimeGeneration += 1;
  builtinMcpStartupConfigGeneration = 0;
}

function scheduleGrantedBuiltinMcpInstall(owner: BuiltinMcpAdmissionOwner): void {
  const attempt = async () => {
    while (true) {
      if (
        builtinMcpAdmissionOwner !== owner
        || (owner.state !== 'granted' && owner.state !== 'unmanaged')
      ) return;
      if (lifecycleState.query && !lifecycleState.abortRequested) {
        await ensureSdkMcpInSync();
        return;
      }
      await new Promise<void>(resolve => {
        const timer = setTimeout(resolve, 100);
        timer.unref?.();
      });
    }
  };
  void attempt().catch(() => {});
}

async function shouldInstallBuiltinStdioWave(staged: readonly StagedBuiltinStdio[]): Promise<boolean> {
  if (staged.length === 0) {
    releaseBuiltinMcpAdmissionOwner();
    return true;
  }
  const executableIdentity = mcpStartupExecutableIdentity(
    staged.map(entry => ({ command: entry.command, args: entry.args })),
  );
  const desiredKey = `${executableIdentity}:${staged.map(entry => entry.id).sort().join(',')}`;
  let owner = builtinMcpAdmissionOwner;
  if (!owner || owner.desiredKey !== desiredKey) {
    releaseBuiltinMcpAdmissionOwner();
    builtinMcpStartupConfigGeneration += 1;
    const demand = startMcpStartupDemand({
      executables: staged.map(entry => ({ command: entry.command, args: entry.args })),
      runtimeGeneration: Math.max(1, builtinMcpStartupRuntimeGeneration),
      configGeneration: builtinMcpStartupConfigGeneration,
      priority: lifecycleState.preWarming ? 'background' : 'interactive',
    });
    const createdOwner: BuiltinMcpAdmissionOwner = {
      runtimeGeneration: Math.max(1, builtinMcpStartupRuntimeGeneration),
      configGeneration: builtinMcpStartupConfigGeneration,
      desiredKey,
      serverIds: staged.map(entry => entry.id).sort(),
      startedAt: Date.now(),
      demand,
      lease: null,
      state: 'queued',
    };
    owner = createdOwner;
    builtinMcpAdmissionOwner = createdOwner;
    void demand.ready.then(lease => {
      if (builtinMcpAdmissionOwner !== createdOwner) {
        if (lease) void settleMcpStartupLease(lease, 'released');
        return;
      }
      if (!lease) {
        createdOwner.state = 'unmanaged';
        scheduleGrantedBuiltinMcpInstall(createdOwner);
        return;
      }
      createdOwner.lease = lease;
      createdOwner.state = 'granted';
      publishBuiltinMcpEffectiveSnapshot();
      scheduleGrantedBuiltinMcpInstall(createdOwner);
    });
  }
  if (owner.state === 'granted' || owner.state === 'settled' || owner.state === 'unmanaged') {
    return true;
  }
  const remainingMs = owner.startedAt + MCP_PREWARM_GRACE_MS - Date.now();
  if (remainingMs <= 0) return false;
  let timeout: ReturnType<typeof setTimeout> | undefined;
  await Promise.race([
    owner.demand.ready,
    new Promise<void>(resolve => {
      timeout = setTimeout(resolve, remainingMs);
      timeout.unref?.();
    }),
  ]);
  if (timeout) clearTimeout(timeout);
  const current = builtinMcpAdmissionOwner;
  return current === owner
    && (current.state === 'granted' || current.state === 'settled' || current.state === 'unmanaged');
}

function maybeSettleBuiltinMcpStartup(statuses: Awaited<ReturnType<Query['mcpServerStatus']>>): void {
  const owner = builtinMcpAdmissionOwner;
  if (!owner?.lease || owner.state !== 'granted') return;
  const byName = new Map(statuses.map(status => [status.name, status.status]));
  if (!owner.serverIds.every(id => {
    const status = byName.get(id);
    return status === 'connected' || status === 'failed' || status === 'needs-auth' || status === 'disabled';
  })) return;
  const ready = owner.serverIds.every(id => byName.get(id) === 'connected');
  const lease = owner.lease;
  owner.lease = null;
  owner.state = 'settled';
  void settleMcpStartupLease(lease, ready ? 'ready' : 'failed');
}

export function getBuiltinMcpEffectiveSnapshot(): McpEffectiveSnapshot | null {
  return builtinMcpEffectiveSnapshot
    ? {
        ...builtinMcpEffectiveSnapshot,
        dispatch: { ...builtinMcpEffectiveSnapshot.dispatch },
        servers: builtinMcpEffectiveSnapshot.servers.map(server => ({ ...server })),
        tools: [...builtinMcpEffectiveSnapshot.tools],
      }
    : null;
}

function sdkMcpToolName(serverId: string, toolName: string): string {
  return toolName.startsWith('mcp__') ? toolName : `mcp__${serverId}__${toolName}`;
}

function builtinDispatchProjection(owner: NonNullable<ReturnType<typeof getQueryMcpPrewarmOwner>>):
McpEffectiveSnapshot['dispatch'] {
  if (!owner.outcome) return { state: 'waiting' };
  if (owner.outcome.state === 'ready') return { state: 'settled', releaseReason: 'ready' };
  if (owner.outcome.state === 'degraded') {
    return { state: 'released', releaseReason: owner.outcome.reason };
  }
  return { state: 'released', releaseReason: 'cancelled' };
}

function projectBuiltinMcpStatuses(
  owner: NonNullable<ReturnType<typeof getQueryMcpPrewarmOwner>>,
  statuses: Awaited<ReturnType<Query['mcpServerStatus']>>,
): { servers: McpEffectiveServerSnapshot[]; tools: string[] } {
  const byName = new Map(statuses.map(status => [status.name, status]));
  const tools: string[] = [];
  const now = Date.now();
  const servers = owner.requiredServerIds.map((id): McpEffectiveServerSnapshot => {
    const status = byName.get(id);
    const admissionOwnsServer = builtinMcpAdmissionOwner?.serverIds.includes(id) === true;
    const serverTools = status?.status === 'connected'
      ? (status.tools ?? []).map(tool => sdkMcpToolName(id, tool.name))
      : [];
    tools.push(...serverTools);
    const state: McpEffectiveServerSnapshot['state'] = status?.status === 'connected'
      ? 'ready'
      : status?.status === 'needs-auth'
        ? 'needs_auth'
        : status?.status === 'failed'
          ? 'failed'
          : status?.status === 'disabled'
            ? 'disabled'
            : admissionOwnsServer && builtinMcpAdmissionOwner?.state === 'queued'
              ? 'queued'
              : 'starting';
    return {
      id,
      desired: true,
      state,
      toolCount: serverTools.length,
      ...(state === 'failed' ? { errorCode: 'MCP_STARTUP_FAILED' } : {}),
      ...(state === 'needs_auth' ? { errorCode: 'MCP_NEEDS_AUTH' } : {}),
      attemptGeneration: owner.revision,
      updatedAt: now,
    };
  });
  return { servers, tools: [...new Set(tools)].sort() };
}

function publishBuiltinMcpEffectiveSnapshot(options: { observationStale?: boolean } = {}): void {
  const owner = getQueryMcpPrewarmOwner();
  if (!owner) return;
  const projected = projectBuiltinMcpStatuses(owner, builtinMcpLastStatuses);
  const previousTools = builtinMcpEffectiveSnapshot?.tools ?? [];
  const ownerChanged = !builtinMcpEffectiveSnapshot
    || builtinMcpEffectiveSnapshot.runtimeGeneration !== owner.generation
    || builtinMcpEffectiveSnapshot.configGeneration !== owner.revision
    || builtinMcpEffectiveSnapshot.configFingerprint !== owner.fingerprint;
  if (
    ownerChanged
    || projected.tools.length !== previousTools.length
    || projected.tools.some((tool, index) => tool !== previousTools[index])
  ) {
    builtinMcpCatalogGeneration += 1;
  }
  builtinMcpEffectiveRevision += 1;
  const authority = getCurrentQueryAuthority();
  const snapshot: McpEffectiveSnapshot = {
    sessionId: authority?.productSessionId || getCurrentProductSessionId(),
    runtime: 'builtin',
    runtimeGeneration: owner.generation,
    configGeneration: owner.revision,
    configFingerprint: owner.fingerprint,
    catalogGeneration: builtinMcpCatalogGeneration,
    revision: builtinMcpEffectiveRevision,
    observedAt: Date.now(),
    ...(builtBrowserHostGeneration > 0 ? { browserHostGeneration: builtBrowserHostGeneration } : {}),
    dispatch: builtinDispatchProjection(owner),
    servers: projected.servers,
    tools: projected.tools,
    ...(options.observationStale ? { observationStale: true } : {}),
  };
  builtinMcpEffectiveSnapshot = snapshot;
  broadcast('chat:mcp-effective-snapshot', snapshot);
}

function waitForBuiltinMcpObservation(ms: number, signal: AbortSignal): Promise<boolean> {
  if (signal.aborted) return Promise.resolve(false);
  return new Promise(resolve => {
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort);
      resolve(true);
    }, ms);
    timer.unref?.();
    const onAbort = () => {
      clearTimeout(timer);
      resolve(false);
    };
    signal.addEventListener('abort', onAbort, { once: true });
  });
}

function installQueryMcpOwner(params: Parameters<typeof setQueryMcpPrewarmOwner>[0]): boolean {
  const installed = setQueryMcpPrewarmOwner(params);
  if (!installed) return false;
  builtinMcpObserverAbort?.abort();
  const owner = getQueryMcpPrewarmOwner();
  if (!owner) return false;
  const controller = new AbortController();
  builtinMcpObserverAbort = controller;
  builtinMcpLastStatuses = [];
  publishBuiltinMcpEffectiveSnapshot();

  void (async () => {
    while (!controller.signal.aborted) {
      const current = getQueryMcpPrewarmOwner();
      if (
        !current
        || current.query !== owner.query
        || current.generation !== owner.generation
        || current.revision !== owner.revision
      ) return;
      let timeout: ReturnType<typeof setTimeout> | undefined;
      try {
        const result = await Promise.race([
          readQueryMcpStatuses(owner.query).then(statuses => ({ kind: 'statuses' as const, statuses })),
          new Promise<{ kind: 'timeout' }>(resolve => {
            timeout = setTimeout(() => resolve({ kind: 'timeout' }), 2_000);
            timeout.unref?.();
          }),
        ]);
        if (result.kind === 'statuses') {
          builtinMcpLastStatuses = [...result.statuses];
          maybeSettleBuiltinMcpStartup(builtinMcpLastStatuses);
          publishBuiltinMcpEffectiveSnapshot();
          const playwrightStatus = builtinMcpLastStatuses.find(status => status.name === MANAGED_BROWSER_MCP_ID);
          const playwrightDesired = configState.currentMcpServers?.some(
            server => server.id === MANAGED_BROWSER_MCP_ID && server.command === '__browser_host__',
          ) === true;
          const playwrightNeedsTransport = playwrightDesired
            && (!playwrightStatus || playwrightStatus.status === 'failed');
          if (playwrightNeedsTransport && !builtinBrowserHostRecovery) {
            builtinBrowserHostRecovery = (async () => {
              const capability = await acquireBrowserCapability();
              const previousHostGeneration = builtBrowserHostGeneration;
              if (!observeBuiltinBrowserCapability(capability)) return;
              console.warn(
                `[agent] Browser Host transport refreshed generation=${previousHostGeneration}->${capability.hostGeneration}`,
              );
              await ensureSdkMcpInSync();
            })().catch(error => {
              console.warn(
                `[agent] Browser Host recovery deferred: ${error instanceof Error ? error.message : String(error)}`,
              );
            }).finally(() => {
              builtinBrowserHostRecovery = null;
            });
          }
        } else {
          publishBuiltinMcpEffectiveSnapshot({ observationStale: true });
        }
      } catch {
        publishBuiltinMcpEffectiveSnapshot({ observationStale: true });
      } finally {
        if (timeout) clearTimeout(timeout);
      }
      const hasStarting = builtinMcpEffectiveSnapshot?.servers.some(server => server.state === 'starting') === true;
      const delayMs = hasStarting ? 1_000 : 15_000;
      if (!await waitForBuiltinMcpObservation(delayMs, controller.signal)) return;
    }
  })();
  return true;
}

function clearBuiltinQueryMcpOwner(query?: Query): void {
  builtinMcpObserverAbort?.abort();
  builtinMcpObserverAbort = null;
  builtinMcpLastStatuses = [];
  clearQueryMcpPrewarmOwner(query);
}

/**
 * Read-only accessor for `configState.currentMcpServers`. Used by `/cron/execute-sync` to
 * reuse the frontend-set MCP shapes (from `/api/mcp/set`) instead of
 * recomputing via the sidecar's `getAllMcpServers()` — the two compute paths
 * produce slightly different env/args field structures, and feeding the
 * sidecar-shaped definitions into `applyMcpOverrideAndAwaitReady` triggers a
 * fingerprint mismatch → abort+restart that wastes ~5s on every launcher
 * cron handoff. The same fingerprint-mismatch hazard is documented at
 * `agent-session.ts::initializeAgent` (line ~4972) where the Tab path
 * deliberately skips self-resolve for the same reason.
 *
 * Returns `null` when no `/api/mcp/set` has happened yet (Tab not opened
 * before cron firing — pure-cron / IM bot paths). Callers fall back to
 * `getAllMcpServers()` in that case.
 */
export function getCurrentMcpServers(): readonly McpServerDefinition[] | null {
  return configState.currentMcpServers;
}

// Fingerprint of the MCP key set the SDK was last known to have (sorted server-id list).
// Captured when query() starts and after each successful lifecycleState.query.setMcpServers(),
// so ensureSdkMcpInSync() can detect when the desired MCP set has drifted from the SDK's
// live set (typically after IM context-injected MCPs become available post pre-warm).
// PRD 0.2.17 — Claude plugin enabled IDs for this session/sidecar.
//   - `null` (initial) → resolve via getDefaultEnabledPluginIdsForWorkspace(agentDir)
//     on every options-build call. Lets Agent / Project config edits take
//     effect on the next pre-warm without needing the renderer to push.
//   - `string[]`       → explicit per-Tab override (renderer pushed via
//     setSessionEnabledPluginIds). Bypasses the Agent default; clearing
//     back to null restores Agent-tracking behaviour.
//
// Mirrors `configState.currentMcpServers` / `configState.currentAgentDefinitions` per-sidecar state.
/**
 * Per-Tab UI override entry point. Renderer calls this when the user toggles
 * a plugin in the chat input "插件" submenu — sets the override + schedules
 * a deferred restart so the next session pre-warm picks up the new options.
 *
 * Pass `null` to clear the override and fall back to Agent default tracking.
 */
export function setSessionEnabledPluginIds(ids: string[] | null): void {
  // Same-set short-circuit — avoids gratuitous restart when renderer
  // re-emits the same list (e.g. after a settings refresh).
  const current = configState.currentEnabledPluginIds;
  if (current === null && ids === null) return;
  if (
    current !== null &&
    ids !== null &&
    current.length === ids.length &&
    current.every((id, i) => id === ids[i])
  ) {
    return;
  }
  configSetSessionEnabledPluginIds(ids);
  forceReloadActiveSession('plugins');
}

export function getSessionEnabledPluginIds(): readonly string[] | null {
  return configState.currentEnabledPluginIds;
}

/**
 * Per-Tab override for MyAgents official CLI tools. This only changes the
 * next session/pre-warm system prompt; the current SDK subprocess cannot have
 * its system prompt mutated in place.
 */
export function setSessionEnabledOfficialToolIds(ids: OfficialToolId[] | null): void {
  const current = configState.currentEnabledOfficialToolIds;
  if (current === null && ids === null) return;
  if (
    current !== null &&
    ids !== null &&
    current.length === ids.length &&
    current.every((id, i) => id === ids[i])
  ) {
    return;
  }
  configSetSessionEnabledOfficialToolIds(ids);
  forceReloadActiveSession('official-tools');
}

export function getSessionEnabledOfficialToolIds(): readonly OfficialToolId[] | null {
  return configState.currentEnabledOfficialToolIds;
}

/**
 * Hot-reload proxy configuration into the current process environment and
 * restart the builtin SDK only when the current provider's effective MyAgents
 * proxy state changed. Scope-only edits can matter even when the proxy URL is
 * unchanged; unrelated provider scope edits should not churn this session.
 */
export async function setProxyConfig(proxySettings: ProxySettings | null): Promise<void> {
  const providerId = getSessionProviderId() ?? SUBSCRIPTION_PROVIDER_ID;
  const oldKey = getProviderProxyScopeKey(providerId);
  await setProcessProxyConfig(proxySettings);
  const newKey = getProviderProxyScopeKey(providerId);
  if (oldKey === newKey) {
    if (isDebugMode) console.log(`[agent] Proxy config unchanged for provider=${providerId}, skipping session restart`);
    return;
  }
  console.log(`[agent] Proxy effective state changed for provider=${providerId}: ${oldKey} -> ${newKey}`);
  triggerProxyRestart();
}

/** Restart session after proxy change.
 * Attempts immediate abort when idle; during active turns falls back to
 * pendingConfigRestart (same deferred mechanism as setMcpServers/setAgents).
 * Differs from MCP/agents in that it doesn't go through schedulePreWarm's
 * 500ms debounce — proxy changes are discrete user actions from Settings. */
function triggerProxyRestart(): void {
  if (lifecycleState.query) {
    if (lifecycleState.processing && !lifecycleState.preWarming) {
      console.log('[agent] Proxy changed, deferring restart (active turn)');
      scheduleDeferredRestart('proxy');
    } else {
      if (isDebugMode) console.log('[agent] Proxy changed, restarting session with resume');
      abortPersistentSession();
    }
  }
  resetPreWarmFailCount();
  if (!lifecycleState.processing || lifecycleState.preWarming) {
    schedulePreWarm();
  }
}

/** Initialize general + provider proxy baselines before the first pre-warm. */
export async function initSocksBridgeFromEnv(): Promise<void> {
  await initializeProxyStateFromCurrentSettings();
}

/**
 * Apply an MCP set synchronously and ensure a fresh SDK session is live —
 * used inside the SessionEngine scheduled-turn lock when a scheduled path needs to switch
 * MCP for this task (or reconcile back to workspace defaults from a prior
 * task's override).
 *
 * Why a dedicated helper instead of `setMcpServers`:
 *   1. `setMcpServers`'s restart path is debounced 500ms via the pre-warm
 *      timer so rapid `/api/mcp/set` calls (React state-sync) don't thrash
 *      the subprocess. Cron has the OPPOSITE need — the very next
 *      `enqueueUserMessage` MUST run against the new MCP set with no race
 *      window. This helper bypasses the debounce.
 *   2. `setMcpServers` skips restart entirely when the current session is
 *      snapshotted (session metadata claims authority over MCP). For cron
 *      we ARE the authority — the task override IS the new "session list" —
 *      so the snapshot guard would silently no-op us. This helper bypasses
 *      that guard by triggering the restart itself rather than relying on
 *      the deferred-restart machinery.
 *
 * Behaviour:
 *   - Updates `configState.currentMcpServers` directly because cron owns the override.
 *   - If the MCP fingerprint changed AND a session is live: cancels the
 *     pre-warm timer, drains the deferred-restart reasons, aborts the
 *     persistent session, awaits termination, kicks off a fresh
 *     `startStreamingSession(true)`, and polls until the new session
 *     handle is assigned (`lifecycleState.query !== null` and
 *     `lifecycleState.abortRequested === false`).
 *   - No-op when fingerprint is unchanged.
 *   - When no session was running, leaves the stored config in place and
 *     lets the next `enqueueUserMessage` start a session as usual.
 *
 * Caller MUST hold the SessionEngine scheduled-turn lock — this helper does not
 * serialise itself; concurrent calls would race on `lifecycleState.query`.
 */
export async function applyMcpOverrideAndAwaitReady(servers: McpServerDefinition[]): Promise<void> {
  const before = mcpConfigFingerprint(configState.currentMcpServers ?? []);
  const after = mcpConfigFingerprint(servers);
  setCurrentMcpServers(servers);
  if (before === after) return;
  if (!lifecycleState.query) return; // no live session — next enqueueUserMessage starts one with the current fingerprint
  // Live session with a different MCP fingerprint — force restart.
  if (lifecycleState.preWarmTimer) {
    clearTimeout(lifecycleState.preWarmTimer);
    setPreWarmTimer(null);
  }
  drainDeferredRestart(); // clear any leftover reasons; we drive restart
  console.log('[agent] applyMcpOverrideAndAwaitReady: forcing immediate session restart for MCP change');
  abortPersistentSession();
  await awaitSessionTermination(10_000, 'applyMcpOverrideAndAwaitReady');

  // After termination `lifecycleState.abortRequested` is still true and there is no
  // live SDK process. If `enqueueUserMessage` ran now, it would treat
  // `lifecycleState.abortRequested` as busy and queue — and `waitForSessionIdle`
  // would return prematurely (sessionState === 'idle' immediately) before
  // the queued message ran. Force a fresh subprocess and poll until the
  // SDK session handle is assigned.
  void startStreamingSession(true).catch((error) => {
    console.error('[agent] applyMcpOverrideAndAwaitReady: post-abort restart failed:', error);
  });
  const restartDeadline = Date.now() + 10_000;
  while (Date.now() < restartDeadline) {
    if (lifecycleState.query && !lifecycleState.abortRequested) break;
    await new Promise((r) => setTimeout(r, 50));
  }
  if (!lifecycleState.query || lifecycleState.abortRequested) {
    console.warn('[agent] applyMcpOverrideAndAwaitReady: timed out waiting for new session');
  }
}

/**
 * Set the MCP servers to use for subsequent queries
 * Called from renderer when user toggles MCP in workspace
 * If MCP config changed and a session is running, it will be restarted with resume
 */
export function setMcpServers(servers: McpServerDefinition[]): void {
  // Owned Sessions freeze MCP selection IDs in metadata, while config.json
  // owns definition bodies and the global enable security lever. Resolve that
  // canonical projection before comparing fingerprints so an incoming
  // workspace-default list cannot replace the snapshot, and a global disable
  // or same-ID definition change cannot be rejected as one opaque delta.
  const meta = sessionId ? getSessionMetadata(sessionId) : null;
  const effectiveServers = meta?.configSnapshotAt
    ? resolveWorkspaceConfig(agentDir ?? '', meta, { includeMcp: true }).mcpServers
    : servers;
  const mcpDecision = configApplyMcpServersUpdate(effectiveServers, {
    hasQuerySession: Boolean(lifecycleState.query),
  });

  if (isDebugMode) {
    console.log(`[agent] MCP servers set: ${effectiveServers.map(s => s.id).join(', ') || 'none'}`);
    for (const s of effectiveServers) {
      if (s.env && Object.keys(s.env).length > 0) {
        console.log(`[agent] MCP ${s.id}: Has custom env vars: ${Object.keys(s.env).join(', ')}`);
      }
    }
  }

  // If MCP changed, defer restart to the debounced pre-warm timer.
  // DO NOT abort immediately — rapid-fire /api/mcp/set calls from React state sync
  // (e.g. 7 calls in 4s when toggling one server in Settings) would kill the SDK
  // subprocess + all stdio MCP servers repeatedly, destroying in-process state.
  // The timer in schedulePreWarm() batches these into a single abort+restart.
  if (mcpDecision.changed && lifecycleState.query) {
    if (mcpDecision.shouldRestart) {
      const ids = effectiveServers.map(s => s.id).join(', ') || 'none';
      console.log(`[agent] MCP config changed → [${ids}], deferring restart to pre-warm debounce`);
      scheduleDeferredRestart('mcp');
    }
  }

  // Pre-warm: start/restart subprocess + MCP servers ahead of user's first message
  resetPreWarmFailCount(); // Config changed — reset retry tracking
  if (!lifecycleState.processing || lifecycleState.preWarming) {
    schedulePreWarm();
  }
}

function refreshMcpConfigForNewSession(): void {
  if (configState.currentMcpServers === null || !agentDir) return;
  const refreshed = getEffectiveMcpServers(agentDir);
  setCurrentMcpServers(refreshed);
  console.log(
    `[agent] resetSession: refreshed ${refreshed.length} effective MCP definition(s) from config.json`,
  );
}

/**
 * Get current MCP servers
 * Returns null if never set (workspace not initialized), or array (possibly empty)
 */
export function getMcpServers(): McpServerDefinition[] | null {
  return configState.currentMcpServers;
}

/**
 * Set the sub-agent definitions for subsequent queries
 * If agents changed and a session is running, it will be restarted with resume
 */
export function setAgents(agents: Record<string, AgentDefinition>): void {
  const newNames = Object.keys(agents).sort().join(',');
  const agentsDecision = configApplyAgentDefinitionsUpdate(agents, {
    hasQuerySession: Boolean(lifecycleState.query),
    isSnapshotted: isCurrentSessionSnapshotted(),
  });

  if (isDebugMode) {
    console.log(`[agent] Sub-agents set: ${newNames || 'none'}`);
  }

  // Defer restart to pre-warm debounce (same as setMcpServers — see comment there).
  if (agentsDecision.changed && lifecycleState.query) {
    if (agentsDecision.reason === 'snapshot-authoritative') {
      // v0.1.69 T14: Locked session owns its sub-agents — skip restart (same rationale as MCP).
      console.log(`[agent] Sub-agents changed but session ${sessionId} is snapshotted — skip restart`);
    } else if (agentsDecision.shouldRestart) {
      console.log(`[agent] Sub-agents content changed (${newNames || 'none'}), deferring restart to pre-warm debounce`);
      scheduleDeferredRestart('agents');
    }
  }

  // Pre-warm: start/restart subprocess + MCP servers ahead of user's first message
  resetPreWarmFailCount(); // Config changed — reset retry tracking
  if (!lifecycleState.processing || lifecycleState.preWarming) {
    schedulePreWarm();
  }
}

/**
 * Set the default model for subsequent queries.
 * Called during tab initialization so the backend has a real default model
 * before pre-warm starts. This ensures:
 * 1. Pre-warm uses the correct model (no undefined → SDK guesses)
 * 2. Gateway clients (Telegram, API) can omit model and get a proper default
 * 3. First user message doesn't trigger a blocking setModel() call
 *
 * Unlike MCP/agents, model changes don't require session restart —
 * so this does NOT trigger schedulePreWarm(). The debounced pre-warm
 * from MCP/agents sync will pick up the model automatically.
 */
export function getSessionModel(): string | undefined {
  return configState.currentModel;
}

export function getSessionPermissionMode(): PermissionMode {
  return configState.currentPermissionMode;
}

/** Set permission mode (called by the Rust IM router via /api/session/permission-mode).
 *  NOTE: desktop permission changes do NOT reach here — they ride the chat-send
 *  payload (enqueueUserMessage's inline applySessionConfig). This endpoint is
 *  Rust-IM-router-only. */
export function setSessionPermissionMode(mode: PermissionMode): void {
  if (mode === configState.currentPermissionMode) return;

  // #327 — snapshot authority (see setSessionModel). Rust-IM-router-only caller;
  // for a snapshotted owned session the channel's permission override must not
  // change the live mode. This is security-relevant: an IM channel on fullAgency
  // must NOT silently downgrade a desktop session's plan-mode hard gate. Pure IM
  // sessions (not snapshotted) fall through and live-follow the channel mode.
  if (!shouldApplyConfigUpdate({
    field: 'permissionMode',
    source: 'im-sync',
    isSnapshotted: isCurrentSessionSnapshotted(),
  })) {
    // warn, not log: this guard is UNCONDITIONAL (no imConfigSync flag) because a
    // caller audit proved only the Rust IM router hits this endpoint. If a future
    // desktop/renderer caller ever lands here, its change is swallowed — make
    // that loudly visible instead of silently dropping a user action.
    console.warn(`[agent] config sync permissionMode '${mode}' ignored — session ${sessionId} is snapshotted (snapshot wins; endpoint is Rust-IM-router-only by contract)`);
    return;
  }

  const oldMode = configState.currentPermissionMode;
  const oldPrePlan = configState.prePlanPermissionMode;
  // Route through the shared transition so the UI toggle keeps the plan
  // capture/restore invariant: switching INTO plan captures the prior mode so a
  // later ExitPlanMode has something to restore. Before this, the UI toggle set
  // configState.currentPermissionMode='plan' WITHOUT touching configState.prePlanPermissionMode, so
  // ExitPlanMode approval was a no-op and the hard gate stayed engaged — the
  // session was stuck in plan until the user hand-switched to fullAgency.
  const next = applyPermissionModeSelection(configState.currentPermissionMode, configState.prePlanPermissionMode, mode);
  setPermissionPlanState(next);
  console.log(`[agent] session permission mode set: ${oldMode} -> ${configState.currentPermissionMode} (prePlan=${configState.prePlanPermissionMode ?? 'none'})`);

  // Apply permission mode change to SDK subprocess immediately (same as setSessionModel).
  // Without this, the SDK subprocess stays in the old mode until the next message
  // triggers applySessionConfig(). Critical for plan mode: user switches to plan in UI
  // but SDK keeps auto → canUseTool may be skipped → tools execute unchecked.
  if (lifecycleState.query) {
    const sdkMode = mapToEffectiveSdkPermissionMode(configState.currentPermissionMode, currentScenario);
    lifecycleState.query.setPermissionMode(sdkMode).catch(err => {
      console.error('[agent] failed to apply permission mode to running session:', err);
      // Rollback: restore old mode + capture and notify frontend to undo
      setPermissionPlanState({ permissionMode: oldMode, prePlanPermissionMode: oldPrePlan });
      broadcast('chat:permission-mode-changed', { permissionMode: oldMode });
    });
  }

  // Notify frontend of the mode change so UI stays in sync
  broadcast('chat:permission-mode-changed', { permissionMode: configState.currentPermissionMode });
}

/**
 * Background-agent permission policy (issue #264). Controls what a
 * `run_in_background` sub-agent may do when it hits a tool that the SDK can't
 * auto-resolve. The SDK never calls our `canUseTool` for background sub-agents
 * — it routes those decisions to the `PermissionRequest` hook (registered in
 * startStreamingSession), which consults this value. Default 'inherit' (only
 * already-granted tools run in the background; nothing wider).
 *
 * Pushed per-session by the frontend alongside the chat-send payload (mirrors
 * `configState.currentPermissionMode`). Never inferred from the model's run_in_background
 * choice — only from this explicit user setting.
 */

export function getBackgroundAgentPermissionMode(): BackgroundAgentPermissionMode {
  return configState.currentBackgroundAgentPermissionMode;
}

/**
 * Set the background-agent permission policy. Takes effect for the next
 * background sub-agent permission decision — no SDK restart needed (the hook
 * reads this module-level value live). Idempotent.
 */
export function setBackgroundAgentPermissionMode(mode: BackgroundAgentPermissionMode): void {
  if (mode === configState.currentBackgroundAgentPermissionMode) return;
  console.log(`[agent] background-agent permission mode: ${configState.currentBackgroundAgentPermissionMode} -> ${mode}`);
  configSetBackgroundAgentPermissionMode(mode);
}

/**
 * In-flight `lifecycleState.query.setModel()` promise — set by every SDK-side model
 * dispatch (`setSessionModel`'s fire-and-forget path AND `applySessionConfig`'s
 * awaited path), cleared when the promise settles.
 *
 * Why this exists (Codex adversarial review 2026-05-07):
 *
 * The race had three actors that update `configState.currentModel` and call SDK setModel:
 *
 *   1. `setSessionModel(M2)` — UI model picker. Sync update of `configState.currentModel`,
 *      fire-and-forget `lifecycleState.query.setModel(M2[1m]).catch(...)`. Returns
 *      before the SDK subprocess has actually swapped.
 *
 *   2. `applySessionConfig({ model: M2 })` — runs on every send. Short-circuits
 *      at `newModel === configState.currentModel`, skipping its own setModel call.
 *
 *   3. `enqueueUserMessage` — yields the user's message to the SDK subprocess.
 *
 * Without coordination, the user-visible flow "click M2, immediately click
 * Send" is: (1) sync-updates configState.currentModel + dispatches setModel async →
 * (2) sees newModel === configState.currentModel and short-circuits → (3) yields the
 * message — all before the SDK subprocess has processed (1)'s setModel IPC.
 * The first turn runs on the OLD model.
 *
 * Fix: every SDK-side dispatch goes through `dispatchSetModelToSdk()` which
 * registers the promise here. `applySessionConfig` awaits this promise at
 * its very top — even when it's about to short-circuit — so by the time
 * we yield the user's message the SDK is guaranteed to be on the requested
 * model. The promise self-clears on settle (only if not overwritten by a
 * newer dispatch in between).
 */
let pendingSetModelPromise: Promise<void> | null = null;

/**
 * Send a model change to the live SDK subprocess and register the in-flight
 * promise on `pendingSetModelPromise`. Idempotent against `lifecycleState.query`
 * being null (returns a resolved promise — fresh subprocess will read
 * `configState.currentModel` at spawn).
 *
 * Caller is responsible for updating `configState.currentModel` itself; this helper
 * only handles the SDK-IPC side. The split is deliberate: `setSessionModel`
 * needs to update `configState.currentModel` synchronously (so any concurrent reader
 * sees the new value), but the IPC is fire-and-forget; `applySessionConfig`
 * needs to await before updating `configState.currentModel` (so a failed setModel
 * doesn't leave configState.currentModel ahead of SDK reality).
 */
function dispatchSetModelToSdk(model: string): Promise<void> {
  if (!lifecycleState.query) return Promise.resolve();
  const session = lifecycleState.query;
  const providerId = getSessionProviderId() ?? SUBSCRIPTION_PROVIDER_ID;
  const wrapped = applyProviderContextWindowSuffix(model, providerId);
  const promise = session.setModel(wrapped).catch(err => {
    console.error('[agent] failed to apply model to running session:', err);
  });
  pendingSetModelPromise = promise;
  // Self-clear on settle. Guard against a newer dispatch having already
  // overwritten us — that newer dispatch's own settle will do its own clear.
  promise.finally(() => {
    if (pendingSetModelPromise === promise) {
      pendingSetModelPromise = null;
    }
  });
  return promise;
}

export async function setSessionModel(model: string, opts?: { imConfigSync?: boolean }): Promise<void> {
  // #327 — snapshot authority. An owned (snapshotted) desktop session's model is
  // frozen at the snapshot, and the per-turn /api/im/enqueue resolver already
  // applies "snapshot wins" (index.ts). But the Rust IM router ALSO pushes the
  // channel's model override straight here, via sync_ai_config → /api/model/set,
  // when it (re)warms a sidecar that is SHARED with the desktop session (the
  // desktop↔IM handover binds the IM peer to the desktop session_id). For a
  // snapshotted session that push must be ignored — applying it clobbers the
  // process-global `configState.currentModel`, which is read live by buildClaudeSessionEnv /
  // broadcastBuiltinContextUsage. With an unregistered override (e.g.
  // astron-code-latest) lookupModelContextLength returns undefined → the desktop
  // tab's `chat:context-usage` window collapses to the SDK 200K default (100%),
  // and it opens a window where the live provider/model desync into a real
  // upstream mismatch → 500 (#327 comment). Desktop's own model push (Chat.tsx,
  // no `imConfigSync`) stays authoritative — it updates the snapshot itself.
  // Pure IM / cron / live-follow sessions have no snapshot, so this is a no-op
  // for them (isCurrentSessionSnapshotted() === false) and the override applies.
  const modelUpdate = configApplyModelUpdate(model, {
    source: opts?.imConfigSync ? 'im-sync' : 'desktop',
    isSnapshotted: isCurrentSessionSnapshotted(),
  });
  if (!modelUpdate.applied) {
    if (modelUpdate.reason === 'unchanged') return;
    console.log(`[agent] IM config sync model '${model}' ignored — session ${sessionId} is snapshotted (snapshot wins)`);
    return;
  }

  const oldModel = modelUpdate.oldModel;
  const aliasEnvChanged = modelUpdate.aliasEnvChanged;
  const crossesProviderHistoryBoundary = modelUpdate.crossesProviderHistoryBoundary;
  console.log(`[agent] session model set: ${oldModel ?? 'undefined'} -> ${model}`);

  if (crossesProviderHistoryBoundary) {
    if (lifecycleState.processing && !lifecycleState.preWarming) {
      setPendingProviderHistoryBoundaryReset(true);
      console.log('[agent] model switch crosses provider-history boundary during active turn -> deferred fresh SDK session');
      if (lifecycleState.query) scheduleDeferredRestart('provider-history');
    } else {
      try {
        await resetForProviderHistoryBoundary();
      } catch (error) {
        if (configState.currentModel === model) configSetModel(oldModel);
        throw error;
      }
      console.log('[agent] model switch crosses provider-history boundary -> created fresh SDK session id');
      if (lifecycleState.query) {
        abortPersistentSession();
        schedulePreWarm();
      }
    }
    return;
  }

  // Apply model change to SDK subprocess immediately (including during pre-warm).
  // Without this, changing model during pre-warm creates a desync:
  //   configState.currentModel is updated but SDK subprocess keeps the old model,
  //   and applySessionConfig() on first message sees no diff → skips the SDK call.
  // setModel() on the live SDK subprocess updates `userSpecifiedModel` which
  // feeds into getContextWindowForModel() on every following turn — so the
  // [1m] tag MUST be applied here too, otherwise switching to a 1M model
  // mid-session keeps the live SDK on the 200K path until the deferred restart
  // below respawns the subprocess.
  //
  // Fire-and-forget at this seam (UI-driven, no await available), but
  // `dispatchSetModelToSdk` registers `pendingSetModelPromise` so the next
  // `applySessionConfig` awaits before yielding the user's message.
  void dispatchSetModelToSdk(model);

  // CLAUDE_CODE_AUTO_COMPACT_WINDOW is baked into the subprocess env at spawn
  // time and cannot be updated on a live process — `lifecycleState.query.setModel()`
  // above only switches the model ID the SDK sends to the provider. So if the
  // old and new models have different `contextLength`, the autocompact
  // threshold stays frozen at the old model's cap until the next subprocess
  // respawn. Schedule a deferred restart so the fresh env reflects the new
  // model's real window. Same rationale as the `provider` reason in
  // `setSessionProviderEnv` — env-baked knobs need a respawn.
  const providerId = getSessionProviderId() ?? SUBSCRIPTION_PROVIDER_ID;
  const oldCtx = lookupProviderModelContextLength(oldModel, providerId);
  const newCtx = lookupProviderModelContextLength(model, providerId);
  if (oldCtx !== newCtx) {
    if (lifecycleState.query) {
      console.log(`[agent] model window changed (${oldCtx ?? 'SDK-default'} → ${newCtx ?? 'SDK-default'}) → schedule deferred restart to reinject CLAUDE_CODE_AUTO_COMPACT_WINDOW`);
      scheduleDeferredRestart('model-window');
    }
  }

  // ANTHROPIC_DEFAULT_*_MODEL is also baked into the SDK subprocess env.
  // lifecycleState.query.setModel() updates the parent model only; SDK built-in
  // subagents such as Explore keep resolving their own model aliases from
  // those env vars until the subprocess is respawned.
  if (aliasEnvChanged && lifecycleState.query) {
    if (isTurnInFlight()) {
      console.log('[agent] model aliases changed during active turn -> schedule deferred restart to reinject ANTHROPIC_DEFAULT_*_MODEL');
      scheduleDeferredRestart('model-aliases');
    } else {
      console.log('[agent] model aliases changed while idle/pre-warming -> aborting session to reinject ANTHROPIC_DEFAULT_*_MODEL');
      abortPersistentSession();
      schedulePreWarm();
    }
  }
}

/**
 * #324 — set the session's reasoning effort. `value` is the UI/persisted
 * setting ('default' | level); stored normalized (undefined = default).
 *
 * Application strategy mirrors setSessionModel's env-baked branch:
 *  - OpenAI-protocol provider: nothing to do beyond the state write — the
 *    bridge resolver (resolveActiveSessionUpstreamConfig) reads
 *    `configState.currentReasoningEffort` live per upstream request.
 *  - Anthropic protocol (official + third-party): `effort` is a query()-spawn
 *    option with no live SDK setter (sdk.d.ts has setModel/setMaxThinkingTokens
 *    only), so a live subprocess needs a respawn. Mid-turn → deferred restart
 *    (drains at turn end); idle/pre-warm → abort + re-warm now so the user's
 *    next message doesn't pay the restart latency.
 *
 * Desktop-picker only (no IM router caller), so no #327 imConfigSync guard —
 * the desktop push is authoritative and updates the snapshot itself, same as
 * the model picker.
 */
export function setSessionReasoningEffort(value: string | null | undefined): void {
  const normalized = normalizeReasoningEffort(value);
  const effortUpdate = configApplyReasoningEffortUpdate(normalized);
  if (!effortUpdate.changed) return;

  const old = effortUpdate.oldValue;
  console.log(`[agent] session reasoning effort set: ${old ?? 'default'} -> ${normalized ?? 'default'}`);

  if (effortUpdate.providerApiProtocol === 'openai') {
    // Live bridge resolver picks it up on the next request — no respawn.
    return;
  }

  if (lifecycleState.query) {
    if (isTurnInFlight()) {
      console.log('[agent] reasoning effort changed during active turn -> schedule deferred restart to reapply query() effort');
      scheduleDeferredRestart('reasoning-effort');
    } else {
      console.log('[agent] reasoning effort changed while idle/pre-warming -> aborting session to reapply query() effort');
      abortPersistentSession();
      schedulePreWarm();
    }
  }
}

/** #324 — current normalized reasoning effort (undefined = default). */
export function getSessionReasoningEffort(): string | undefined {
  return configState.currentReasoningEffort;
}

/** Get current provider env (used by heartbeat/memory-update to preserve provider across internal calls). */
export function getSessionProviderEnv(): ProviderEnv | undefined {
  return configState.currentProviderEnv;
}

export function getSessionProviderId(): string | null {
  return configState.currentProviderEnv?.providerId ?? SUBSCRIPTION_PROVIDER_ID;
}

async function resetForProviderHistoryBoundary(): Promise<void> {
  return runSerializedSessionMutation(async () => {
    const productSessionId = sessionId;
    const metadata = getSessionMetadata(productSessionId);
    if (metadata) {
      const sourceSdkSessionId = resolveBuiltinSdkSessionId(metadata);
      const replacementSdkSessionId = randomUUID();
      const updated = await updateSessionMetadata(productSessionId, {
        sdkSessionId: replacementSdkSessionId,
        unifiedSession: false,
        forkFrom: undefined,
        runtimeUsageTotals: undefined,
        lastContextUsage: undefined,
      }, (current) => (
        (current.runtime ?? 'builtin') === 'builtin'
        && resolveBuiltinSdkSessionId(current) === sourceSdkSessionId
        && !current.pendingConversationMutation
      ));
      if (!updated) {
        throw new Error(`[agent] provider history boundary reset lost Session authority for ${productSessionId}`);
      }
    } else if (transcriptState.messages.length > 0) {
      throw new Error(`[agent] provider history boundary reset refused unindexed Session ${productSessionId}`);
    }

    setPendingProviderHistoryBoundaryReset(false);
    sessionRegistered = false;
    clearCurrentSessionUuids();
    clearLiveSessionUuids();
    pendingResumeSessionAt = undefined;
    setPendingReloadAnchor(undefined);
    setSystemInitInfo(null);
    setSdkControlReady(false);
  });
}

/** Set provider env (called by Rust IM router via /api/provider/set on sidecar creation or config hot-reload).
 *
 * Provider env is baked into SDK subprocess environment variables at spawn time
 * and CANNOT be updated on a running process. If a session is already running
 * with stale env (e.g., pre-warm started before sync_ai_config arrived),
 * we must restart it. Attempts immediate abort when idle; during active turns
 * falls back to pendingConfigRestart. Differs from MCP/agents in that it doesn't
 * go through schedulePreWarm's 500ms debounce — provider changes are discrete
 * Rust-layer calls, not rapid-fire React state sync.
 */
export async function setSessionProviderEnv(providerEnv: ProviderEnv | undefined): Promise<void> {
  const oldLabel = configState.currentProviderEnv?.baseUrl ?? 'anthropic';
  const newLabel = providerEnv?.baseUrl ?? 'anthropic';
  // Full equality check — all ProviderEnv fields affect subprocess env (authType, apiProtocol, etc.)
  const providerUpdate = configApplyProviderEnvUpdate(providerEnv, {
    source: 'im-sync',
    isSnapshotted: isCurrentSessionSnapshotted(),
  });
  if (!providerUpdate.applied) {
    if (providerUpdate.reason === 'unchanged') return;
    // warn, not log: same rationale as the permissionMode guard — unconditional
    // by caller audit (Rust-IM-router-only); a future non-IM caller's change
    // would be swallowed here and must be loud.
    console.warn(`[agent] config sync provider '${newLabel}' ignored — session ${sessionId} is snapshotted (snapshot wins; endpoint is Rust-IM-router-only by contract)`);
    return;
  }

  // Config owner has already applied the snapshot guard and computed provider-history
  // compatibility before mutating currentProviderEnv. The facade only performs the
  // subprocess restart / bridge side effects that follow from that decision.
  const crossesProviderHistoryBoundary = providerUpdate.crossesProviderHistoryBoundary;
  if (crossesProviderHistoryBoundary) {
    if (lifecycleState.processing && !lifecycleState.preWarming) {
      setPendingProviderHistoryBoundaryReset(true);
      console.log('[agent] provider switch crosses history boundary during active turn — fresh SDK session will be created after restart');
    } else {
      try {
        await resetForProviderHistoryBoundary();
      } catch (error) {
        if (configState.currentProviderEnv === providerEnv) configSetProviderEnv(providerUpdate.oldProviderEnv);
        throw error;
      }
      console.log('[agent] provider switch crosses history boundary — created fresh SDK session id');
    }
  }

  console.log(`[agent] session provider env set: ${oldLabel} → ${newLabel}`);
  // PRD #124: keep the active session's bridge registration in sync with the
  // new provider. Function is idempotent and handles all transitions
  // (Anthropic→OpenAI, OpenAI→Anthropic, OpenAI→OpenAI) — registers, updates,
  // or unregisters as appropriate.
  ensureActiveSessionBridgeRegistered();

  // If a session is running, its subprocess has the OLD provider env.
  // Restart so the next session picks up the updated environment.
  // (Snapshotted/owned sessions already returned above — only live-follow IM /
  // cron sessions reach here, and they DO own provider changes via this path.)
  if (lifecycleState.query) {
    if (lifecycleState.processing && !lifecycleState.preWarming) {
      // Active user turn in progress — defer restart to avoid killing mid-response.
      // The restart will fire after the current turn completes (pendingConfigRestart).
      console.log('[agent] provider changed during active turn → deferring restart');
      scheduleDeferredRestart('provider');
    } else {
      console.log(`[agent] provider changed (${oldLabel} → ${newLabel}) → aborting session (preWarm=${lifecycleState.preWarming})`);
      abortPersistentSession();
    }
  } else if (lifecycleState.processing) {
    // startStreamingSession() is in progress but lifecycleState.query hasn't been assigned yet.
    // buildClaudeSessionEnv() may have already read the stale configState.currentProviderEnv.
    // Schedule a deferred restart so it fires after the first turn completes.
    console.log('[agent] provider changed while session starting → will restart after first turn');
    scheduleDeferredRestart('provider');
  }

  // Reset retry counter and re-warm (same tail as setMcpServers/triggerProxyRestart)
  resetPreWarmFailCount();
  if (!lifecycleState.processing || lifecycleState.preWarming) {
    schedulePreWarm();
  }
}

/**
 * Schedule a pre-warm of the SDK subprocess and MCP servers.
 * Uses debounce to batch rapid config changes during tab initialization.
 * The pre-warmed session is invisible to the frontend until the first user message.
 */
/**
 * Force a session restart triggered by an explicit `myagents reload`.
 *
 * Unlike `setMcpServers` / `setAgents` / provider / proxy paths, this bypasses
 * the `isCurrentSessionSnapshotted()` guard. The snapshot guard exists to
 * protect owned sessions (Tab / Cron / Background) from noise — e.g. React
 * state sync firing `/api/mcp/set` 7× in 4s shouldn't thrash the SDK.
 *
 * Reload is the opposite: a deliberate, user-/AI-initiated request to re-read
 * the config from disk and apply it to the running session. If we don't
 * restart here, the user's edited `.md` frontmatter (new model, new tools)
 * sits in memory but the running subprocess keeps delegating to the old
 * definitions — forcing an app restart (#98).
 *
 * Callers MUST have already updated in-memory state (`setMcpServers` +
 * `setAgents`) before invoking this. Active turns are respected via the same
 * deferred-restart mechanism; idle sessions abort immediately.
 */
/**
 * PRD 0.2.17 — public entrypoint for the plugins admin API. Called after
 * any install / uninstall / toggle write so the next SDK session picks up
 * the refreshed plugin list. Composes with the existing deferred-restart
 * pipeline (no new abort path) and respects the external-runtime guard
 * inside schedulePreWarm. We intentionally do NOT short-circuit no-op
 * toggles via a fingerprint comparison: the restart cost on an idle
 * sidecar is ~1s and the comparison's own cost (lstat + isPluginRootDir
 * walk on every enabled plugin) is not negligible. See review notes
 * (Codex AI-specific findings) for the analysis.
 */
export function schedulePluginDeferredRestart(): void {
  forceReloadActiveSession('plugins');
}

export function forceReloadActiveSession(reason: RestartReason = 'mcp'): void {
  if (lifecycleState.query) {
    if (lifecycleState.processing && !lifecycleState.preWarming) {
      console.log(`[agent] reload requested during active turn → deferring restart (reason=${reason})`);
      scheduleDeferredRestart(reason);
    } else {
      console.log(`[agent] reload requested → aborting session (reason=${reason}, preWarm=${lifecycleState.preWarming})`);
      abortPersistentSession();
    }
  } else if (lifecycleState.processing) {
    // Startup window: startStreamingSession() is in progress but lifecycleState.query
    // hasn't been assigned yet. buildClaudeSessionEnv() may have already read
    // the pre-reload state. Defer the restart so it fires after the first turn
    // completes — mirrors the provider-change path (search for the same
    // comment in setSessionProviderEnv).
    console.log(`[agent] reload requested during session startup → deferring restart (reason=${reason})`);
    scheduleDeferredRestart(reason);
  }
  resetPreWarmFailCount();
  if (!lifecycleState.processing || lifecycleState.preWarming) {
    schedulePreWarm();
  }
}

function schedulePreWarm(delayMs = 500): void {
  if (lifecycleState.preWarmTimer) clearTimeout(lifecycleState.preWarmTimer);
  if (!agentDir) return;
  if (lifecycleState.preWarmDisabled) return;
  // External runtimes (CC/Codex) manage their own subprocess — skip builtin SDK pre-warm
  if (isExternalRuntime(getCurrentRuntimeType())) return;

  // Stop retrying after consecutive failures to avoid infinite loop
  if (lifecycleState.preWarmFailCount >= PRE_WARM_MAX_RETRIES) {
    console.warn(`[agent] pre-warm skipped: ${lifecycleState.preWarmFailCount} consecutive failures, giving up`);
    return;
  }

  setPreWarmTimer(setTimeout(() => {
    setPreWarmTimer(null);
    if (!agentDir) return;

    // Drain deferred config restart: abort the stale session so the next
    // startStreamingSession() picks up the latest MCP/agents/provider/proxy config.
    // Batched exit point for rapid-fire config changes (setMcpServers, setAgents,
    // OAuth) and active-turn fallbacks from provider/proxy immediate-abort paths.
    if (hasDeferredRestart() && lifecycleState.query) {
      if (shouldDeferLiveMcpMutation({
        promotedItemInFlight: queueState.promotedItemInFlight,
        turnInFlight: isTurnInFlight(),
        sdkCommandInFlight: getInFlightQueueId() !== null,
        backgroundTasksActive: hasQueryBackgroundTasks(lifecycleState.query),
      })) {
        // The terminal path owns this drain. Never let a previously armed
        // pre-warm timer abort an item between promotion and SDK yield.
        console.log('[agent] pre-warm: deferred config restart remains latched until turn admission/execution is quiescent');
        return;
      }
      const reasons = drainDeferredRestart();
      console.log(`[agent] pre-warm: applying batched config restart (reasons=${reasons})`);
      abortPersistentSession();
      // Session is now terminating — retry after cleanup finishes
      schedulePreWarm();
      return;
    }

    if (isSessionActive()) {
      // Session still cleaning up OR a fresh `startStreamingSession()` is mid-spawn
      // (`lifecycleState.processing=true` but `lifecycleState.query` not yet assigned). RETRY instead of
      // calling startStreamingSession() — that would become a "stale awaiter" on
      // lifecycleState.termination and wake later for an unrelated reason. Don't drain
      // pendingConfigRestart here either: a setter that ran during the spawn window
      // (e.g. `setSessionProviderEnv` at the `lifecycleState.processing && !lifecycleState.query` branch)
      // may have legitimately latched a reason that needs to apply against the
      // spawning subprocess once `lifecycleState.query` is set on the next timer fire.
      schedulePreWarm();
      return;
    }
    // Truly idle — no session and not spawning. Clear any leftover reasons (e.g.
    // scheduled during a failed startup where the session never came up) so the
    // fresh pre-warm doesn't carry stale ghosts.
    drainDeferredRestart();
    console.log('[agent] pre-warming SDK subprocess + MCP servers');
    startStreamingSession(true).catch((error) => {
      console.error('[agent] pre-warm failed:', error);
    });
  }, Math.max(0, delayMs)));
}

/**
 * Get current sub-agent definitions
 */
export function getAgents(): Record<string, AgentDefinition> | null {
  return configState.currentAgentDefinitions;
}

/**
 * Predicate for each MyAgents-reserved context-injected builtin MCP id.
 * Returns true when the corresponding sidecar context is set, mirroring the
 * inclusion conditions in `buildSdkMcpServers()` Pattern 1.
 *
 * The `Record<typeof MYAGENTS_CONTEXT_INJECTED_MCP_IDS[number], …>` shape
 * makes TypeScript enforce 1:1 alignment between the reserved id list and
 * the predicates: adding a new reserved id without a predicate (or vice
 * versa) is a compile error. This is the pit-of-success against the drift
 * that caused issue #148.
 *
 * Background: builtin MCPs are injected into the SDK based on sidecar context
 * (IM bot / cron task / bridge plugin), but `checkMcpToolPermission()` used to
 * compare tool names against `configState.currentMcpServers` only — which never contains
 * context-injected MCPs. Result: SDK said "tool ready", permission gate said
 * "未启用". The fix routes the permission gate through this single map.
 */
const CONTEXT_INJECTED_BUILTIN_PREDICATES: Record<
  typeof MYAGENTS_CONTEXT_INJECTED_MCP_IDS[number],
  () => boolean
> = {
  // Permission follows the map installed on the live Query, not a newer
  // desired Bridge surface waiting for the turn-boundary restart.
  'im-bridge-tools': () => configState.frozenSdkMcpFingerprint
    .split('|', 1)[0]
    .split(',')
    .includes('im-bridge-tools'),
};

/** Resolve Bridge caller identity from the request currently owning SDK output. */
export function getCurrentImBridgeTurnContext(): import('./session-core/im-bridge-types').ImBridgeTurnContext | null {
  const requestId = peekPendingOutputOwner()?.requestId;
  return requestId ? imRequestRegistry.get(requestId)?.imBridgeTurnContext ?? null : null;
}

function getActiveContextInjectedBuiltinIds(): Set<string> {
  const ids = new Set<string>();
  for (const id of MYAGENTS_CONTEXT_INJECTED_MCP_IDS) {
    if (CONTEXT_INJECTED_BUILTIN_PREDICATES[id]()) ids.add(id);
  }
  return ids;
}

/**
 * Check if an MCP tool is allowed based on user's MCP settings
 *
 * MCP tool naming convention: mcp__<server-id>__<tool-name>
 * e.g., mcp__playwright__browser_navigate
 *
 * @returns 'allow' if tool is permitted, 'deny' with reason otherwise
 */
function checkMcpToolPermission(toolName: string): { allowed: true } | { allowed: false; reason: string } {
  // Not an MCP tool - let other permission logic handle it
  if (!toolName.startsWith('mcp__')) {
    return { allowed: true };
  }

  // Extract server ID from tool name: mcp__<server-id>__<tool-name>
  const parts = toolName.split('__');
  if (parts.length < 3) {
    return { allowed: false, reason: '无效的 MCP 工具名称' };
  }
  const serverId = parts[1];

  // Context-injected builtin MCPs (currently only `im-bridge-tools`) are not
  // in `configState.currentMcpServers` — they're injected by sidecar context, not user
  // toggles. Allow them when the corresponding context is active. Mirrors
  // buildSdkMcpServers() Pattern 1.
  const activeBuiltins = getActiveContextInjectedBuiltinIds();
  if (activeBuiltins.has(serverId)) {
    return { allowed: true };
  }
  // For ids in MYAGENTS_CONTEXT_INJECTED_MCP_IDS but NOT currently active,
  // reject with a context-specific message instead of the generic "未启用".
  // Driven by the reserved-id list so it can never drift from Pattern 1.
  // Retired MCP names (`cron-tools` / `im-cron` / `im-media`) intentionally
  // fall through to the regular user-MCP check below — they were dropped
  // from the reserved list in v0.2.11, so user MCPs may now legitimately
  // claim those names.
  if (serverId === 'im-bridge-tools') {
    return { allowed: false, reason: 'IM Bridge 工具仅在 IM Bridge 插件会话中可用' };
  }

  // Case 1: MCP not set (null) - allow all (backward compatible)
  if (configState.currentMcpServers === null) {
    return { allowed: true };
  }

  // Case 2: User disabled all MCP
  if (configState.currentMcpServers.length === 0) {
    return { allowed: false, reason: 'MCP 工具已被禁用' };
  }

  // Case 3: User enabled specific MCP - check if this tool's server is enabled
  // The SDK sanitizes server names in tool prefixes: replace non-[a-zA-Z0-9_-] with '_'.
  // Config IDs are usually already clean, but compare sanitized forms for robustness.
  // Example: config id "my.server" → SDK tool prefix uses "my_server".
  const sanitize = (name: string) => name.replace(/[^a-zA-Z0-9_-]/g, '_');
  const sanitizedServerId = sanitize(serverId);
  const isEnabled = configState.currentMcpServers.some(s => sanitize(s.id) === sanitizedServerId);
  if (isEnabled) {
    return { allowed: true };
  }

  return { allowed: false, reason: `MCP 服务「${serverId}」未启用` };
}

/**
 * Build SDK settingSources
 *
 * settingSources controls where SDK reads settings from:
 * - 'user': reads from CLAUDE_CONFIG_DIR (default ~/.claude/)
 * - 'project': <cwd>/.claude/ (project-level config)
 *
 * We use 'project' only:
 * - Enabled MyAgents global Skills are projected into <cwd>/.claude/skills/ at Query birth
 * - Avoids setting CLAUDE_CONFIG_DIR which would break Keychain credential lookup
 * - Project-level: SDK reads project's .claude/skills/, .claude/commands/, CLAUDE.md
 *
 * We exclude 'user' because:
 * - 'user' reads from ~/.claude/ (Claude CLI's directory, not ours)
 * - Our product uses ~/.myagents/ for user-level config
 * - Setting CLAUDE_CONFIG_DIR to redirect would break Anthropic subscription OAuth
 *   (SDK derives Keychain service names from CLAUDE_CONFIG_DIR path hash)
 */
function buildSettingSources(): ('user' | 'project')[] {
  return ['project'];
}

/**
 * Convert McpServerDefinition to SDK mcpServers format.
 *
 * Three MCP injection patterns:
 * 1. Context-injected (im-bridge-tools) — always present based on sidecar
 *    context, invisible in Settings UI, not user-toggled. Used for the
 *    OpenClaw plugin bridge which exposes a runtime-dynamic tool surface.
 *    Other historical context-injected MCPs (`cron-tools`, `im-cron`,
 *    `im-media`) were retired in v0.2.11 — the AI now reaches those
 *    capabilities through the `myagents` CLI + system prompt guidance,
 *    so the same surface is available across builtin / Codex / Gemini /
 *    Claude Code runtimes.
 * 2. Builtin registry (command='__builtin__') — in-process servers, user-toggled via Settings,
 *    registered as META in `./tools/builtin-mcp-meta.ts`. Adding a new one:
 *      (a) add `registerBuiltinMcpMeta({ id, load })` block in builtin-mcp-meta.ts, and
 *      (b) write the tool file with `createXxxServer()` async factory whose SDK + zod imports
 *          live INSIDE the factory via `await import()` — never at the tool module's top level,
 *          or the lazy-load win is defeated (see CLAUDE.md 禁止事项 and builtin-mcp-registry.ts).
 * 3. External (stdio/sse/http) — subprocess or remote servers, user-configured.
 *
 * Execution strategy for external stdio:
 * - For npx commands: system npx → bundled Node.js npx → bun x
 * - For other commands: Uses user-specified command directly (node/python etc.)
 * - Inherits proxy env + injects NO_PROXY to protect localhost (mirrors Rust proxy_config)
 */
async function buildSdkMcpServers(
  browserProductSessionIdOverride?: string,
): Promise<Record<string, McpServerEntry>> {
  // null = MCP not yet configured (e.g. Global sidecar, or Tab pre-warm before /api/mcp/set)
  // [] = explicitly no MCP (user has none enabled)
  // [...]= user's enabled MCP servers
  // Never fall back to config file — the frontend's /api/mcp/set is the single source of truth.
  // Global sidecar never receives /api/mcp/set and correctly gets no MCP.
  // Filter out SDK reserved names to prevent fatal crash:
  // "Invalid MCP configuration: X is a reserved MCP name." → exit code 1
  const allServers: McpServerDefinition[] = configState.currentMcpServers ?? [];
  const servers = allServers.filter(s => {
    const normalized = s.id.replace(/[^a-zA-Z0-9_-]/g, '_');
    if (SDK_RESERVED_MCP_NAMES.includes(normalized)) {
      console.warn(`[agent] MCP "${s.id}" skipped: conflicts with SDK reserved name. Rename to avoid this.`);
      return false;
    }
    // Reserve MyAgents context-injected builtin ids: a user MCP with the same id
    // would otherwise overwrite the builtin in result[id] and inherit its
    // auto-trust in canUseTool — see issue #148.
    if ((MYAGENTS_CONTEXT_INJECTED_MCP_IDS as readonly string[]).includes(normalized)) {
      console.warn(`[agent] MCP "${s.id}" skipped: id is reserved by MyAgents (context-injected builtin). Rename to avoid this.`);
      return false;
    }
    return true;
  });
  if (isDebugMode) console.log(`[agent] MCP servers: ${servers.map(s => s.id).join(', ') || 'none'}`);

  const result: Record<string, McpServerEntry> = {};
  const stagedStdio: StagedBuiltinStdio[] = [];

  // --- Pattern 1: Context-injected MCPs (always present based on sidecar context) ---
  // Add Bridge tools if we're in an IM context with a plugin bridge that has tools.
  // Dynamic server is created from actual plugin tool definitions — transparent
  // passthrough. This is the only remaining Pattern 1 MCP after the v0.2.11 cron
  // / im-cron / im-media → CLI migration: bridge plugins expose runtime-dynamic
  // tool surfaces that can't be expressed as a static prompt + CLI.
  const bridgeToolSurface = getImBridgeToolSurface();
  const bridgeServer = getImBridgeToolServer();
  if (bridgeToolSurface && bridgeServer) {
    result['im-bridge-tools'] = bridgeServer;
    console.log(`[agent] Added im-bridge-tools MCP server for plugin ${bridgeToolSurface.pluginId}`);
  }

  // --- Pattern 2: Builtin registry MCPs (in-process, user-toggled) ---
  for (const server of servers) {
    if (server.command !== '__builtin__') continue;
    const entryPromise = getBuiltinMcpInstance(server.id);
    if (!entryPromise) {
      console.warn(`[agent] Builtin MCP '${server.id}' not registered — skipping`);
      continue;
    }
    const entry = await entryPromise;
    entry.configure?.(server.env || {}, { sessionId: sessionId || 'default', workspace: agentDir });
    result[server.id] = entry.server as McpSdkServerConfigWithInstance;
    console.log(`[agent] Added builtin MCP: ${server.id}`);
  }

  // --- Pattern 3: External MCPs (stdio/sse/http subprocess or remote) ---
  const externalServers = servers.filter(s => s.command !== '__builtin__');

  // Return early if no user MCP servers (but may have cron-tools)
  if (externalServers.length === 0) {
    await shouldInstallBuiltinStdioWave([]);
    if (Object.keys(result).length > 0) {
      console.log(`[agent] Built SDK MCP servers: ${Object.keys(result).join(', ')}`);
    }
    return result;
  }

  for (const server of externalServers) {
    try {
    // Log server env for debugging
    if (isDebugMode && server.env && Object.keys(server.env).length > 0) {
      console.log(`[agent] MCP ${server.id}: Custom env vars: ${Object.keys(server.env).join(', ')}`);
    }

    if (server.id === MANAGED_BROWSER_MCP_ID && server.command === '__browser_host__') {
      const productSessionId = browserProductSessionIdOverride
        || sessionId
        || process.env.MYAGENTS_SIDECAR_ID?.trim();
      if (!productSessionId || !agentDir) {
        throw new Error('Browser Host requires Product Session and workspace identity');
      }
      if (browserProductSessionIdOverride) {
        await adoptBrowserProductSession(browserProductSessionIdOverride);
      }
      const capability = await acquireBrowserCapability();
      observeBuiltinBrowserCapability(capability);
      result[server.id] = {
        type: 'http',
        url: capability.url,
        headers: { Authorization: `Bearer ${capability.token}` },
      };
      console.log(
        `[agent] MCP ${MANAGED_BROWSER_MCP_ID}: application Browser Host generation=${capability.hostGeneration}`,
      );
      continue;
    }

    if (server.type === 'stdio' && server.command) {
      let command = server.command;
      // Defensive: args may be non-array (e.g. boolean `true`) due to CLI parsing bugs or manual config edits
      let args = [...(Array.isArray(server.args) ? server.args : [])];

      // Sentinel: bundled cuse (computer-use) binary — resolve to the
      // platform-specific path shipped in the app bundle. If the binary is
      // missing (unsupported platform, or a dev build without the binary
      // downloaded yet), skip the MCP with a warning rather than crashing
      // the session.
      if (command === '__bundled_cuse__') {
        const { getBundledCusePath } = await import('./utils/runtime');
        const cusePath = getBundledCusePath();
        if (!cusePath) {
          console.warn(`[agent] MCP ${server.id}: bundled cuse binary not found (platform=${process.platform}); skipping. Run scripts/download_cuse.sh to install.`);
          continue;
        }
        command = cusePath;
        console.log(`[agent] MCP ${server.id}: resolved to bundled cuse at ${cusePath}`);
      }

      // For npx commands: prefer system npx → bundled Node.js npx → bun x
      // System Node.js is maintained by the user's package manager, more reliable than our bundled npm.
      // Bundled Node.js serves as fallback for users who don't have Node.js installed.
      if (command === 'npx') {
        const invocation = resolveNpxMcpInvocation(args, {
          pinPresetPackages: server.isBuiltin === true,
        });
        command = invocation.command;
        args = invocation.args;
        console.log(`[agent] MCP ${server.id}: resolved npx via ${invocation.source} (${command})`);
      }

      // Build MCP config with proxy env inherited from parent Sidecar.
      // MCP subprocesses need outbound proxy inheritance, while localhost still
      // needs NO_PROXY protection. Per-server env has final authority so users
      // can work around downstream proxy parser bugs for a specific MCP.
      const mcpEnv = buildMcpSubprocessEnv(process.env, server.env);

      console.log(`[agent] MCP ${server.id}: transport=stdio argvCount=${args.length}`);

      const mcpConfig: SdkMcpServerConfig = {
        command,
        args,
        env: mcpEnv,  // Always set: proxy inherited + NO_PROXY enforced
      };

      stagedStdio.push({ id: server.id, config: mcpConfig, command, args });
    } else if ((server.type === 'sse' || server.type === 'http') && server.url) {
      const remote = resolveRemoteMcpTransportConfig(server);

      // Inject OAuth token as Authorization header (auto-refreshes if needed)
      // Respect user-supplied Authorization — don't overwrite if already present
      const headers = { ...remote.headers };
      if (!headers['Authorization'] && !headers['authorization']) {
        const oauthHeaders = await resolveAuthHeaders(server.id);
        if (oauthHeaders['Authorization']) {
          Object.assign(headers, oauthHeaders);
          console.log(`[agent] MCP ${server.id}: OAuth token injected`);
        }
      }

      result[server.id] = {
        type: server.type,
        url: remote.url,
        headers,
      };
      // Log URL with API key masked for security
      const maskedUrl = remote.url.replace(/([?&]\w*[Kk]ey=)[^&]+/g, '$1***');
      console.log(`[agent] MCP ${server.id}: ${server.type} → ${maskedUrl}`);
    } else if (server.type === 'sse' || server.type === 'http') {
      console.warn(`[agent] MCP ${server.id}: Missing url for ${server.type} server, skipping`);
    }
    } catch (err) {
      // Isolate individual MCP errors — one bad config must not take down all MCPs
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`[agent] MCP ${server.id}: initialization failed, skipping: ${msg}`);
    }
  }

  if (await shouldInstallBuiltinStdioWave(stagedStdio)) {
    for (const entry of stagedStdio) result[entry.id] = entry.config;
  } else if (stagedStdio.length > 0) {
    console.log(
      `[agent] MCP startup admission queued generation=${builtinMcpAdmissionOwner?.runtimeGeneration ?? 0}`
        + ` configGeneration=${builtinMcpAdmissionOwner?.configGeneration ?? 0}`
        + ` servers=${stagedStdio.length}`,
    );
  }

  console.log(`[agent] Built SDK MCP servers: ${Object.keys(result).join(', ') || 'none'}`);
  // Always return result (even if empty) to prevent SDK from using default config
  return result;
}

/**
 * Runtime identity of the installed SDK MCP map. User-configured transport
 * changes already trigger the dedicated config mutation path; the dynamic IM
 * Bridge server additionally needs its stable surface identity because its
 * SDK key remains `im-bridge-tools` across a real port/plugin/group change.
 */
function sdkMcpMapFingerprint(servers: Record<string, unknown>): string {
  const keys = Object.keys(servers).sort().join(',');
  const surface = getImBridgeToolSurface();
  const browserHost = Object.hasOwn(servers, MANAGED_BROWSER_MCP_ID)
    ? `|browserHost=${builtBrowserHostGeneration}:${builtBrowserCapabilityRevision}`
    : '';
  return `${keys}${surface ? `|bridge=${imBridgeToolSurfaceIdentity(surface)}` : ''}${browserHost}`;
}

/** True only when the live Query already owns the current stable Bridge surface. */
export function isCurrentImBridgeToolSurfaceInstalled(): boolean {
  if (!lifecycleState.query || lifecycleState.abortRequested) return false;
  const surface = getImBridgeToolSurface();
  if (!surface) return false;
  return configState.frozenSdkMcpFingerprint.includes(
    `|bridge=${imBridgeToolSurfaceIdentity(surface)}`,
  );
}

/** Bridge discovery and SDK installation consume one surface-owned deadline. */
function getMcpPrewarmWindowForMap(
  servers: Record<string, unknown>,
): { startedAt: number; deadlineAt: number } | null {
  if (builtinMcpAdmissionOwner) {
    return {
      startedAt: builtinMcpAdmissionOwner.startedAt,
      deadlineAt: builtinMcpAdmissionOwner.startedAt + MCP_PREWARM_GRACE_MS,
    };
  }
  if (!Object.hasOwn(servers, 'im-bridge-tools')) return null;
  return getImBridgeToolPrewarmWindow();
}

function getDesiredMcpServerIdsForMap(servers: Record<string, unknown>): string[] {
  return [...new Set([
    ...Object.keys(servers),
    ...(builtinMcpAdmissionOwner?.serverIds ?? []),
  ])].sort();
}

/**
 * Sync the SDK's live MCP set to match what `buildSdkMcpServers()` would produce now.
 *
 * Why this exists:
 *   Context-injected MCPs (im-media, im-bridge-tools) become available only when
 *   `/api/im/enqueue` installs the stable IM Bridge tool surface.
 *   But for IM Bot Sidecars the SDK is pre-warmed by heartbeat long before the first
 *   message — at that point those contexts are null, so `buildSdkMcpServers()` doesn't
 *   include them, and the SDK subprocess freezes its mcpServers config without them.
 *   When the user message later arrives via wakeGenerator(), the SDK's tool list
 *   still excludes those MCPs and the AI reports them as "disconnected".
 *
 *   This function uses the SDK's runtime `setMcpServers()` to dynamically inject the
 *   missing servers without restarting the subprocess (which would add cold-start latency
 *   to the user's first message). On failure, it falls back to scheduling a restart.
 *
 * Idempotent: if the fingerprint hasn't changed since query() startup or the last
 * successful sync, this is a no-op (cheap key-set diff).
 *
 * Caller contract: invoke AFTER all `setXxxContext()` calls that affect
 * `buildSdkMcpServers()` and BEFORE the next `enqueueUserMessage()` so the SDK
 * picks up the new tool list before processing the message.
 */
const SDK_MCP_MUTATION_TIMEOUT_MS = 30_000;

function latchMcpMutationRecovery(targetQuery: Query): void {
  if (lifecycleState.query !== targetQuery) return;
  setFrozenSdkMcpFingerprint('');
  clearBuiltinQueryMcpOwner(targetQuery);
  scheduleDeferredRestart('mcp');
  // A generator that promoted while the mutation was in flight owns recovery:
  // it requeues that exact item before draining the restart latch. With no
  // promotion/turn, abort now so an ensure caller cannot enqueue onto the
  // transport whose control request failed or timed out.
  if (!shouldDeferLiveMcpMutation({
    promotedItemInFlight: queueState.promotedItemInFlight,
    turnInFlight: isTurnInFlight(),
    sdkCommandInFlight: getInFlightQueueId() !== null,
  })) {
    applyDeferredRestartIfNeeded();
  }
}

async function mutateSdkMcpForQuery(targetQuery: Query): Promise<QueryMcpMutationResult> {
  let newServers: Record<string, McpServerEntry>;
  try {
    newServers = await buildSdkMcpServers();
  } catch (error) {
    if (lifecycleState.query !== targetQuery) {
      return {
        ok: false,
        reason: 'query_replaced',
        error: 'Query was replaced while building the MCP transport map',
      };
    }
    const message = error instanceof Error ? error.message : String(error);
    console.error(`[agent] Building SDK MCP servers failed (${message}); rebuilding the Query`);
    latchMcpMutationRecovery(targetQuery);
    return { ok: false, reason: 'failed', error: message };
  }
  if (lifecycleState.query !== targetQuery || lifecycleState.abortRequested) {
    return {
      ok: false,
      reason: 'query_replaced',
      error: 'Query was replaced before MCP transport mutation',
    };
  }
  const newFingerprint = sdkMcpMapFingerprint(newServers);
  if (newFingerprint === configState.frozenSdkMcpFingerprint) return { ok: true };

  console.log(`[agent] SDK MCP set drift detected, syncing live session: was=[${configState.frozenSdkMcpFingerprint || '(empty)'}] now=[${newFingerprint || '(empty)'}]`);

  // The mutation owner was claimed before buildSdkMcpServers() started. A
  // generator promoted during that build waits for this operation. If work
  // already owned the Query, preserve it and rebuild from current context at
  // the terminal boundary rather than mutating transports underneath it.
  const dispatchOwnership = {
    promotedItemInFlight: queueState.promotedItemInFlight,
    turnInFlight: isTurnInFlight(),
    sdkCommandInFlight: getInFlightQueueId() !== null,
  };
  if (shouldDeferLiveMcpMutation(dispatchOwnership)) {
    console.log('[agent] SDK MCP drift detected during turn admission/execution; deferring Query rebuild until quiescent');
    if (dispatchOwnership.promotedItemInFlight) {
      // A generator can promote after the mutation owner is synchronously
      // claimed but before the desired map finishes building. Returning ok
      // here would let that exact item continue on the old installed map.
      // Revoke readiness and make the waiting generator requeue the item;
      // once promotion releases, it drains the restart latch and retries on
      // the replacement Query. An already active/SDK-owned turn may finish,
      // but no not-yet-dispatched item crosses this config boundary.
      latchMcpMutationRecovery(targetQuery);
      return {
        ok: false,
        reason: 'deferred',
        error: 'MCP transport replacement deferred until the promoted item is requeued',
      };
    }
    scheduleDeferredRestart('mcp');
    return { ok: true, deferred: true };
  }

  // Never publish the previous connected snapshot while the SDK transport map
  // is changing. Injected turns will observe owner=null; ordinary turns fence
  // on the Query-generation mutation promise at generator promotion.
  clearBuiltinQueryMcpOwner(targetQuery);
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    const outcome = await Promise.race([
      targetQuery.setMcpServers(newServers).then(result => ({ kind: 'result' as const, result })),
      new Promise<{ kind: 'timeout' }>((resolve) => {
        timeout = setTimeout(() => resolve({ kind: 'timeout' }), SDK_MCP_MUTATION_TIMEOUT_MS);
      }),
    ]);
    if (outcome.kind === 'timeout') {
      const error = `SDK setMcpServers timed out after ${SDK_MCP_MUTATION_TIMEOUT_MS}ms`;
      console.error(`[agent] ${error}; rebuilding the Query before any waiting turn dispatches`);
      latchMcpMutationRecovery(targetQuery);
      return { ok: false, reason: 'timeout', error };
    }
    if (lifecycleState.query !== targetQuery || lifecycleState.abortRequested) {
      return {
        ok: false,
        reason: 'query_replaced',
        error: 'Query was replaced during MCP transport mutation',
      };
    }
    const errKeys = Object.keys(outcome.result.errors ?? {});
    if (errKeys.length > 0) {
      const error = `SDK setMcpServers reported errors for [${errKeys.join(',')}]: ${JSON.stringify(outcome.result.errors)}`;
      console.warn(`[agent] ${error}; rebuilding the Query`);
      latchMcpMutationRecovery(targetQuery);
      return { ok: false, reason: 'failed', error };
    }
    setFrozenSdkMcpFingerprint(newFingerprint);
    const prewarmWindow = getMcpPrewarmWindowForMap(newServers);
    installQueryMcpOwner({
      query: targetQuery,
      fingerprint: newFingerprint,
      requiredServerIds: getDesiredMcpServerIdsForMap(newServers),
      ...(prewarmWindow ?? {}),
    });
    console.log(`[agent] SDK setMcpServers ok: added=[${outcome.result.added.join(',')}] removed=[${outcome.result.removed.join(',')}]`);
    return { ok: true };
  } catch (err) {
    if (lifecycleState.query !== targetQuery) {
      return {
        ok: false,
        reason: 'query_replaced',
        error: 'Query was replaced during MCP transport mutation',
      };
    }
    const error = err instanceof Error ? err.message : String(err);
    console.error(`[agent] SDK setMcpServers threw (${error}); rebuilding the Query`);
    latchMcpMutationRecovery(targetQuery);
    return { ok: false, reason: 'failed', error };
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}

export async function ensureSdkMcpInSync(): Promise<boolean> {
  // Callers that overlap an existing sync must recompute after it settles:
  // the later IM request may have changed bridge context while the first
  // build/mutation was in flight. Returning the shared promise directly would
  // silently lose that later desired set.
  while (true) {
    const targetQuery = lifecycleState.query;
    if (!targetQuery || lifecycleState.abortRequested) return false;
    // Promotion and live transport mutation are mutually exclusive owners.
    // This check and the mutation claim below are synchronous in one event-loop
    // turn: if promotion won first, rebuild after that turn; if this claim wins
    // first, the generator observes the published mutation promise and fences.
    // Never start an async MCP-map build and discover promotion only afterward.
    if (shouldDeferLiveMcpMutation({
      promotedItemInFlight: queueState.promotedItemInFlight,
      turnInFlight: isTurnInFlight(),
      sdkCommandInFlight: getInFlightQueueId() !== null,
    })) {
      scheduleDeferredRestart('mcp');
      return false;
    }
    const mutation = claimQueryMcpMutation(
      targetQuery,
      () => mutateSdkMcpForQuery(targetQuery),
    );
    const result = await mutation.promise;
    if (mutation.claimed || !result.ok) return result.ok && !result.deferred;
  }
}

/** Return the MCP pre-warm owner installed on the exact persistent Query. */
function getCurrentQueryMcpPrewarmOwner(): McpPrewarmOwner | null {
  if (lifecycleState.abortRequested) return null;
  const owner = getQueryMcpPrewarmOwner();
  if (!owner) return null;
  return {
    identity: owner.query,
    generation: owner.generation,
    revision: owner.revision,
    fingerprint: owner.fingerprint,
    requiredServerIds: owner.requiredServerIds,
    startedAt: owner.startedAt,
    deadlineAt: owner.deadlineAt,
    readStatuses: () => readQueryMcpStatuses(owner.query),
  };
}

/**
 * Consume a Query/map generation's owner-created grace at the common SDK
 * dispatch seam. The settled outcome is stored on that owner, so every later
 * Desktop, IM, or injected turn is a zero-control-RPC fast path.
 */
async function observeCurrentQueryMcpPrewarm(
  options: { signal?: AbortSignal } = {},
): Promise<McpPrewarmOutcome | null> {
  const lifecycleOwner = getQueryMcpPrewarmOwner();
  if (!lifecycleOwner) return null;
  if (lifecycleOwner.outcome) return lifecycleOwner.outcome;

  const owner = getCurrentQueryMcpPrewarmOwner();
  if (!owner) return {
    state: 'owner_replaced',
    servers: lifecycleOwner.requiredServerIds.map(id => ({ id })),
    elapsedMs: Math.max(0, Date.now() - lifecycleOwner.startedAt),
  };
  const outcome = await awaitMcpPrewarm({
    owner,
    getOwner: getCurrentQueryMcpPrewarmOwner,
    signal: options.signal,
  });
  if (outcome.state === 'owner_replaced') return outcome;

  const firstSettlement = settleQueryMcpPrewarmOwner({
    query: lifecycleOwner.query,
    generation: lifecycleOwner.generation,
    revision: lifecycleOwner.revision,
    outcome,
  });
  if (firstSettlement) {
    const servers = outcome.state === 'degraded'
      ? formatMcpPrewarmServers(outcome.servers)
      : lifecycleOwner.requiredServerIds.join(',') || '(none)';
    console.log(
      `[agent] MCP dispatch outcome=${outcome.state}${outcome.state === 'degraded' ? ` releaseReason=${outcome.reason}` : ''}`
      + ` generation=${lifecycleOwner.generation} revision=${lifecycleOwner.revision}`
      + ` elapsedMs=${outcome.elapsedMs} budgetMs=${MCP_PREWARM_GRACE_MS} servers=[${servers}]`,
    );
    publishBuiltinMcpEffectiveSnapshot();
  }
  return outcome;
}

/**
 * Permission rules for each mode
 */
interface PermissionRules {
  allowedTools: string[];    // Auto-approved tools (glob patterns supported)
  deniedTools: string[];     // Always denied tools
  // Tools not in either list will prompt user for confirmation
}

/**
 * Get permission rules based on current permission mode
 */
function getPermissionRules(mode: PermissionMode): PermissionRules {
  switch (mode) {
    case 'auto':
      return {
        allowedTools: [
          'Read', 'Glob', 'Grep', 'LS',           // Read operations
          'Edit', 'Write', 'MultiEdit',           // Write operations (acceptEdits)
          'NotebookEdit', 'TodoRead', 'TodoWrite', // Notebook/Todo operations
          // SDK 0.3.142+ Task tools replaced TodoWrite — same bookkeeping nature,
          // no host side effects, so auto-approve like TodoWrite did.
          'TaskCreate', 'TaskUpdate', 'TaskGet', 'TaskList',
          'Skill'                                  // Skills - auto-approve skill invocations
        ],
        deniedTools: [],
        // Bash, Task (sub-agent launcher), WebFetch, WebSearch, mcp__* → need confirmation
      };
    case 'plan':
      return {
        // Read-only allowlist — shared with the plan-mode PreToolUse gate
        // (plan-mode-gate.ts) so canUseTool and the hard hook can't drift. #295
        allowedTools: [...PLAN_MODE_READONLY_TOOLS],
        deniedTools: ['*'], // Everything else denied in plan mode
      };
    case 'fullAgency':
      return {
        allowedTools: ['*'], // Everything auto-approved
        deniedTools: [],
      };
    case 'custom':
    default:
      return {
        allowedTools: ['Read', 'Glob', 'Grep', 'LS', 'Skill'], // Read-only + Skills auto-approved
        deniedTools: [],
        // Everything else needs confirmation
      };
  }
}

/**
 * Session-scoped permission state
 * Tracks tools that user has granted "always allow" for this session
 */
const sessionAlwaysAllowed = new Set<string>();

// Pending permission requests waiting for user response
//
// No wall-clock timeout — matches Claude Code (the CLI reference) which never
// times out user-facing prompts. The user's mental model is "AI is waiting for
// me," so the modal must survive arbitrary AFK time. Cleanup happens on the
// real boundaries: SDK abort signal (onAbort handler), session reset/switch/
// fork (clearSessionPermissions), or sidecar process exit. The 10-minute
// hard timeout was removed in v0.2.14 — its only original purpose (PRD #131
// "Unknown request" desync) is already covered by the abort-driven `:expired`
// broadcast.
const pendingPermissions = new Map<string, {
  resolve: (decision: 'allow' | 'deny') => void;
  toolName: string;
  input: unknown;
}>();

// AskUserQuestion types - import from shared
import type { AskUserQuestionInput, AskUserQuestion } from '../shared/types/askUserQuestion';
import { withQuestionTextAnswerKeys } from '../shared/types/askUserQuestion';
export type { AskUserQuestionInput, AskUserQuestion, AskUserQuestionOption } from '../shared/types/askUserQuestion';

// PlanMode types - import from shared
import type { ExitPlanModeAllowedPrompt } from '../shared/types/planMode';
export type { ExitPlanModeRequest, EnterPlanModeRequest, ExitPlanModeAllowedPrompt } from '../shared/types/planMode';

// Pending AskUserQuestion requests waiting for user response.
// See pendingPermissions comment — no wall-clock timeout (v0.2.14).
const pendingAskUserQuestions = new Map<string, {
  resolve: (answers: Record<string, string> | null) => void;
  input: AskUserQuestionInput;
}>();

// Pending ExitPlanMode requests waiting for user approval.
// See pendingPermissions comment — no wall-clock timeout (v0.2.14).
// `feedback` carries the user's optional 「修改意见」 — when present on a
// rejection, canUseTool sends it back to the model via deny.message so the
// AI can revise the plan in the same turn (issue #182).
type ExitPlanModeResolution = { approved: boolean; feedback?: string };
const pendingExitPlanMode = new Map<string, {
  resolve: (result: ExitPlanModeResolution) => void;
  plan?: string;
  allowedPrompts?: ExitPlanModeAllowedPrompt[];
}>();

// Pending EnterPlanMode requests waiting for user approval.
// See pendingPermissions comment — no wall-clock timeout (v0.2.14).
const pendingEnterPlanMode = new Map<string, {
  resolve: (approved: boolean) => void;
}>();

async function prepareSessionPlansForUserTurn(options: { clearStale: boolean }): Promise<void> {
  if (options.clearStale && agentDir) {
    try {
      await clearSessionPlanMarkdown(getSessionPlansDirectoryPath(agentDir, sessionId), { expectedRoot: agentDir });
    } catch (error) {
      console.warn('[ExitPlanMode] Failed to clear stale session plan markdown:', error);
    }
  }
  setCurrentPlanFileMinMtimeMs(Date.now());
}

/**
 * True while the turn is blocked on a HUMAN response — a permission prompt,
 * AskUserQuestion, or plan-mode approval. The inactivity watchdog treats this
 * as a PAUSED state, not a hung turn: the user's think time is not turn
 * inactivity, and the SDK emits no events while it awaits the canUseTool
 * resolver. Without this, a >10-minute deliberation (e.g. the user steps away
 * mid-permission-prompt) false-fires the watchdog and aborts the turn right as,
 * or before, they answer — despite the comment claiming no wall-clock timeout.
 * (High-2, cross-review. The wake-lock added alongside the suspension-aware
 * watchdog only stops the machine SLEEPING during interactive turns; it does
 * not stop the inactivity clock from counting the human wait.)
 */
function hasPendingInteractiveRequest(): boolean {
  return pendingPermissions.size > 0
    || pendingAskUserQuestions.size > 0
    || pendingExitPlanMode.size > 0
    || pendingEnterPlanMode.size > 0;
}

function interactiveEventScope(): { sessionId: string } {
  return { sessionId };
}

/**
 * Validate AskUserQuestion input structure
 */
function isValidAskUserQuestionInput(input: unknown): input is AskUserQuestionInput {
  if (!input || typeof input !== 'object') return false;
  const obj = input as Record<string, unknown>;
  if (!Array.isArray(obj.questions) || obj.questions.length === 0) return false;

  // Validate each question has required fields
  return obj.questions.every((q: unknown) => {
    if (!q || typeof q !== 'object') return false;
    const question = q as Record<string, unknown>;
    return (
      typeof question.question === 'string' &&
      typeof question.header === 'string' &&
      Array.isArray(question.options) &&
      typeof question.multiSelect === 'boolean' &&
      (question.id === undefined || typeof question.id === 'string') &&
      (question.required === undefined || typeof question.required === 'boolean') &&
      (question.isSecret === undefined || typeof question.isSecret === 'boolean')
    );
  });
}

/**
 * Handle AskUserQuestion tool - prompts user for structured answers
 * Returns the input with answers filled in, or null if denied/aborted
 */
async function handleAskUserQuestion(
  input: unknown,
  signal?: AbortSignal
): Promise<Record<string, string> | null> {
  console.log('[AskUserQuestion] Requesting user input');

  // Validate input structure
  if (!isValidAskUserQuestionInput(input)) {
    console.error('[AskUserQuestion] Invalid input structure:', input);
    return null;
  }

  const requestId = `ask_${Date.now()}_${Math.random().toString(36).slice(2)}`;
  const questionInput = input;

  // Broadcast AskUserQuestion request to frontend
  // Short-circuit if already aborted (addEventListener won't fire for past events)
  if (signal?.aborted) {
    throw new DOMException('Aborted', 'AbortError');
  }

  const requestPayload = {
    ...interactiveEventScope(),
    requestId,
    questions: questionInput.questions,
    // SDK v0.2.69+: options may contain `preview` field (HTML or Markdown)
    // Our toolConfig sets previewFormat: 'html', so previews are HTML fragments
    previewFormat: 'html',
  };
  // Wait for user response or abort. No wall-clock timeout — see the
  // pendingAskUserQuestions Map declaration for why.
  const response = new Promise<Record<string, string> | null>((resolve, reject) => {
    const cleanup = () => {
      pendingAskUserQuestions.delete(requestId);
      signal?.removeEventListener('abort', onAbort);
    };

    const onAbort = () => {
      console.debug('[AskUserQuestion] Aborted by SDK signal');
      // PRD #131 — guard the broadcast: the abort listener is left
      // registered after handleAskUserQuestionResponse returns (no
      // removeEventListener on the response path), and SDK's deny+interrupt
      // fires the same canUseTool signal AFTER the user already
      // responded. Without the guard the resulting `:expired` broadcast
      // would clear a card the frontend was still rendering with the
      // "submitted" state. Only broadcast when the entry is still pending.
      const wasPending = pendingAskUserQuestions.has(requestId);
      cleanup();
      if (wasPending) {
        broadcast('ask-user-question:expired', { ...interactiveEventScope(), requestId, reason: 'aborted' });
        if (supportsAskUserQuestionNativeCard(currentScenario)) {
          emitImEvent('ask-user-question-expired', JSON.stringify({ requestId, reason: 'aborted' }));
        }
      }
      // Reject with AbortError so SDK's own abort handling creates the single tool_result.
      // Previously resolve(null) caused canUseTool to return deny → duplicate tool_result
      // (one from our deny, one from SDK's internal abort) → "tool_use ids must be unique" on resume.
      reject(new DOMException('Aborted', 'AbortError'));
    };

    // Listen for SDK abort signal
    signal?.addEventListener('abort', onAbort);

    pendingAskUserQuestions.set(requestId, { resolve, input: questionInput });
  });
  broadcast('ask-user-question:request', requestPayload);
  if (supportsAskUserQuestionNativeCard(currentScenario)) {
    emitImEvent('ask-user-question-request', JSON.stringify(requestPayload));
  }
  return response;
}

/**
 * Handle user's AskUserQuestion response from frontend
 */
export function handleAskUserQuestionResponse(
  requestId: string,
  answers: Record<string, string> | null
): boolean {
  console.debug(`[AskUserQuestion] handleResponse: requestId=${requestId}, answerKeys=${answers ? Object.keys(answers).join(',') : '(cancelled)'}`);

  const pending = pendingAskUserQuestions.get(requestId);
  if (!pending) {
    console.warn(`[AskUserQuestion] Unknown request: ${requestId}`);
    return false;
  }

  pendingAskUserQuestions.delete(requestId);

  if (answers === null) {
    console.log('[AskUserQuestion] User cancelled');
    pending.resolve(null);
  } else {
    console.log('[AskUserQuestion] User answered');
    pending.resolve(answers);
  }

  return true;
}

/**
 * Handle ExitPlanMode tool - AI submits a plan for user review.
 * Returns {approved, feedback?}: feedback is the user's optional rejection
 * comment, used by canUseTool to construct a deny message routed back to
 * the model so it can revise the plan in the same turn (issue #182).
 */
async function handleExitPlanMode(
  input: unknown,
  signal?: AbortSignal
): Promise<ExitPlanModeResolution> {
  console.log('[ExitPlanMode] Requesting user approval');

  const obj = (input && typeof input === 'object' ? input : {}) as Record<string, unknown>;
  const explicitPlan = typeof obj.plan === 'string' ? obj.plan : undefined;
  const allowedPrompts = Array.isArray(obj.allowedPrompts)
    ? (obj.allowedPrompts as ExitPlanModeAllowedPrompt[])
    : undefined;

  const requestId = `exitplan_${Date.now()}_${Math.random().toString(36).slice(2)}`;

  // Short-circuit if already aborted (addEventListener won't fire for past events)
  if (signal?.aborted) {
    throw new DOMException('Aborted', 'AbortError');
  }

  let plan = explicitPlan;
  if (!plan && agentDir) {
    try {
      const latest = await readLatestPlanMarkdownWithRetry(
        getSessionPlansDirectoryPath(agentDir, sessionId),
        { minMtimeMs: turnState.currentPlanFileMinMtimeMs ?? turnState.currentTurnStartTime ?? undefined, expectedRoot: agentDir, signal },
      );
      if (latest) {
        plan = latest.content;
        console.log(`[ExitPlanMode] Loaded plan from ${latest.path}${latest.truncated ? ' (truncated)' : ''}`);
      } else {
        console.warn('[ExitPlanMode] No session plan markdown found for current turn');
      }
    } catch (error) {
      console.warn('[ExitPlanMode] Failed to load session plan markdown:', error);
    }
  }

  if (signal?.aborted) {
    throw new DOMException('Aborted', 'AbortError');
  }

  // No wall-clock timeout — see pendingExitPlanMode Map declaration.
  const response = new Promise<ExitPlanModeResolution>((resolve, reject) => {
    const cleanup = () => {
      pendingExitPlanMode.delete(requestId);
      signal?.removeEventListener('abort', onAbort);
    };

    const onAbort = () => {
      console.debug('[ExitPlanMode] Aborted by SDK signal');
      // Guard same as handleAskUserQuestion — see that comment.
      const wasPending = pendingExitPlanMode.has(requestId);
      cleanup();
      if (wasPending) {
        broadcast('exit-plan-mode:expired', { ...interactiveEventScope(), requestId, reason: 'aborted' });
      }
      reject(new DOMException('Aborted', 'AbortError'));
    };

    signal?.addEventListener('abort', onAbort);
    pendingExitPlanMode.set(requestId, { resolve, plan, allowedPrompts });
  });
  broadcast('exit-plan-mode:request', { ...interactiveEventScope(), requestId, plan, allowedPrompts });
  return response;
}

/**
 * Handle user's ExitPlanMode response from frontend.
 * `feedback` is forwarded only on rejection (issue #182): when set, the
 * model receives it as the deny message and continues the same turn to
 * revise the plan; when empty, behavior matches the legacy reject path.
 */
export function handleExitPlanModeResponse(
  requestId: string,
  approved: boolean,
  feedback?: string,
): boolean {
  console.debug(`[ExitPlanMode] handleResponse: requestId=${requestId}, approved=${approved}, hasFeedback=${!!feedback}`);
  const pending = pendingExitPlanMode.get(requestId);
  if (!pending) {
    console.warn(`[ExitPlanMode] Unknown request: ${requestId}`);
    return false;
  }
  pendingExitPlanMode.delete(requestId);
  // Restore configState.currentPermissionMode so the hard gate + applySessionConfig stop
  // treating the session as plan. Runs on ANY approval (no longer gated on
  // configState.prePlanPermissionMode): computePlanExitState falls back to a concrete
  // non-plan mode when nothing was captured, so exiting plan can never be a
  // no-op — that no-op was the deadlock when plan was entered via the UI toggle
  // (or restored from disk) without a captured prior mode.
  if (approved) {
    const next = computePlanExitState(configState.prePlanPermissionMode);
    setPermissionPlanState(next);
    console.debug(`[ExitPlanMode] Restored configState.currentPermissionMode to: ${configState.currentPermissionMode}`);
    // Notify frontend that mode changed (plan → auto/fullAgency)
    broadcast('chat:permission-mode-changed', { permissionMode: configState.currentPermissionMode });
  }
  const trimmed = feedback?.trim();
  pending.resolve({ approved, feedback: !approved && trimmed ? trimmed : undefined });
  return true;
}

/**
 * Handle EnterPlanMode tool - AI requests to enter plan mode
 */
async function handleEnterPlanMode(
  _input: unknown,
  signal?: AbortSignal
): Promise<boolean> {
  console.log('[EnterPlanMode] Requesting user approval');

  const requestId = `enterplan_${Date.now()}_${Math.random().toString(36).slice(2)}`;

  // Short-circuit if already aborted (addEventListener won't fire for past events)
  if (signal?.aborted) {
    throw new DOMException('Aborted', 'AbortError');
  }

  // No wall-clock timeout — see pendingEnterPlanMode Map declaration.
  const response = new Promise<boolean>((resolve, reject) => {
    const cleanup = () => {
      pendingEnterPlanMode.delete(requestId);
      signal?.removeEventListener('abort', onAbort);
    };

    const onAbort = () => {
      console.debug('[EnterPlanMode] Aborted by SDK signal');
      // Guard same as handleAskUserQuestion — see that comment.
      const wasPending = pendingEnterPlanMode.has(requestId);
      cleanup();
      if (wasPending) {
        broadcast('enter-plan-mode:expired', { ...interactiveEventScope(), requestId, reason: 'aborted' });
      }
      reject(new DOMException('Aborted', 'AbortError'));
    };

    signal?.addEventListener('abort', onAbort);
    pendingEnterPlanMode.set(requestId, { resolve });
  });
  broadcast('enter-plan-mode:request', { ...interactiveEventScope(), requestId });
  return response;
}

/**
 * Handle user's EnterPlanMode response from frontend
 */
export function handleEnterPlanModeResponse(requestId: string, approved: boolean): boolean {
  console.debug(`[EnterPlanMode] handleResponse: requestId=${requestId}, approved=${approved}`);
  const pending = pendingEnterPlanMode.get(requestId);
  if (!pending) {
    console.warn(`[EnterPlanMode] Unknown request: ${requestId}`);
    return false;
  }
  pendingEnterPlanMode.delete(requestId);
  // Sync configState.currentPermissionMode so applySessionConfig won't override SDK's plan mode.
  // Route through the shared transition: it captures the prior mode, but if we're
  // ALREADY in plan it preserves the existing capture instead of overwriting it
  // with 'plan' (re-entering plan to "fix" a stuck state must not poison the
  // restore target — that previously made the deadlock permanent).
  if (approved) {
    const next = applyPermissionModeSelection(configState.currentPermissionMode, configState.prePlanPermissionMode, 'plan');
    setPermissionPlanState(next);
    console.debug(`[EnterPlanMode] Saved configState.prePlanPermissionMode=${configState.prePlanPermissionMode}, switched to plan`);
    broadcast('chat:permission-mode-changed', { permissionMode: 'plan' });
  }
  pending.resolve(approved);
  return true;
}

/**
 * Check if a glob pattern matches a tool name
 */
function matchesPattern(pattern: string, toolName: string): boolean {
  if (pattern === '*') return true;
  if (pattern === toolName) return true;
  // Simple glob: mcp__playwright__* matches mcp__playwright__browser_tabs
  if (pattern.endsWith('*')) {
    const prefix = pattern.slice(0, -1);
    return toolName.startsWith(prefix);
  }
  return false;
}

/**
 * Check if tool is in a list (supports glob patterns)
 */
function isToolInList(toolName: string, list: string[]): boolean {
  return list.some(pattern => matchesPattern(pattern, toolName));
}

/**
 * Check tool permission - returns immediately for allowed/denied tools,
 * or waits for user response for unknown tools
 */
async function checkToolPermission(
  toolName: string,
  input: unknown,
  mode: PermissionMode,
  signal?: AbortSignal
): Promise<'allow' | 'deny'> {
  const rules = getPermissionRules(mode);

  // 1. Check if tool is always allowed for this mode
  if (isToolInList(toolName, rules.allowedTools)) {
    console.debug(`[permission] ${toolName}: auto-allowed by mode rules`);
    return 'allow';
  }

  // 1.5. Auto-allow Task tool when sub-agents are configured (needed for delegation)
  if (toolName === 'Task' && configState.currentAgentDefinitions && Object.keys(configState.currentAgentDefinitions).length > 0) {
    console.debug(`[permission] ${toolName}: auto-allowed for sub-agent delegation`);
    return 'allow';
  }

  // 2. Check if tool is denied for this mode
  if (isToolInList(toolName, rules.deniedTools)) {
    console.debug(`[permission] ${toolName}: denied by mode rules`);
    return 'deny';
  }

  // 3. Check if user already granted "always allow" in this session
  if (sessionAlwaysAllowed.has(toolName)) {
    console.debug(`[permission] ${toolName}: allowed by session grant`);
    return 'allow';
  }

  // 4. Check if already aborted — throw so SDK's own abort handling creates a single tool_result
  if (signal?.aborted) {
    console.debug(`[permission] ${toolName}: already aborted`);
    throw new DOMException('Aborted', 'AbortError');
  }

  // 5. Request user confirmation via frontend
  console.log(`[permission] ${toolName}: requesting user confirmation (mode=${mode})`);  // Keep as info - user action needed

  const requestId = `perm_${Date.now()}_${Math.random().toString(36).slice(2)}`;

  const inputPreview = typeof input === 'object' ? JSON.stringify(input).slice(0, 500) : String(input).slice(0, 500);

  // Wait for user response or abort. No wall-clock timeout — see the
  // pendingPermissions Map declaration for why.
  const response = new Promise<'allow' | 'deny'>((resolve, reject) => {
    const cleanup = () => {
      pendingPermissions.delete(requestId);
      signal?.removeEventListener('abort', onAbort);
    };

    const onAbort = () => {
      console.debug(`[permission] ${toolName}: aborted by SDK signal`);
      const wasPending = pendingPermissions.has(requestId);
      cleanup();
      if (wasPending) {
        try { broadcast('permission:expired', { ...interactiveEventScope(), requestId, reason: 'aborted' }); } catch { /* swallow — abort cleanup must not throw */ }
      }
      // Reject with AbortError so SDK's own abort handling creates the single tool_result.
      // Previously resolve('deny') caused a duplicate tool_result on abort.
      reject(new DOMException('Aborted', 'AbortError'));
    };

    // Listen for SDK abort signal
    signal?.addEventListener('abort', onAbort);

    pendingPermissions.set(requestId, { resolve, toolName, input });
  });
  broadcast('permission:request', {
    ...interactiveEventScope(),
    requestId,
    toolName,
    input: inputPreview,
  });
  emitImEvent('permission-request', JSON.stringify({ requestId, toolName, input: inputPreview }));
  return response;
}

/**
 * Handle user's permission response from frontend
 */
export function handlePermissionResponse(
  requestId: string,
  decision: 'deny' | 'allow_once' | 'always_allow'
): boolean {
  console.debug(`[permission] handlePermissionResponse: requestId=${requestId}, decision=${decision}`);

  const pending = pendingPermissions.get(requestId);
  if (!pending) {
    console.warn(`[permission] Unknown permission request: ${requestId}`);
    return false;
  }

  pendingPermissions.delete(requestId);
  try { broadcast('permission:expired', { ...interactiveEventScope(), requestId, reason: 'resolved' }); } catch { /* swallow — response path must not fail on SSE */ }

  if (decision === 'deny') {
    console.log(`[permission] ${pending.toolName}: user denied`);
    pending.resolve('deny');
  } else if (decision === 'allow_once' || decision === 'always_allow') {
    if (decision === 'always_allow') {
      console.log(`[permission] ${pending.toolName}: user granted session permission`);
      sessionAlwaysAllowed.add(pending.toolName);
    } else {
      console.log(`[permission] ${pending.toolName}: user allowed once`);
    }
    pending.resolve('allow');

    // Cascade: auto-approve all other pending requests for the same tool.
    // The frontend only shows one permission card at a time. When multiple requests
    // for the same tool arrive in parallel (e.g., 3 WebSearch calls), the others
    // are invisible to the user and would be stuck until the 10-minute timeout.
    // Since the user already approved this tool (once or always), approve them all.
    for (const [otherId, otherPending] of pendingPermissions) {
      if (otherPending.toolName === pending.toolName) {
        console.log(`[permission] ${otherPending.toolName}: cascade auto-approved (requestId=${otherId})`);
        pendingPermissions.delete(otherId);
        try { broadcast('permission:expired', { ...interactiveEventScope(), requestId: otherId, reason: 'resolved' }); } catch { /* swallow — cascade must not fail on SSE */ }
        otherPending.resolve('allow');
      }
    }
  }

  return true;
}

/**
 * Drain every pending interactive request map.
 *
 * Why this exists (v0.2.14 — Codex review): once the per-entry 10-minute
 * timeout was removed, only two paths cleaned up pending entries — the
 * SDK abort signal (`onAbort` in each handler, broadcasts `:expired` and
 * rejects) and `clearSessionPermissions`. The SDK abort path covers
 * "session was cleanly torn down by interrupt()", but it does NOT cover:
 *   1. SDK subprocess crash / error before `signal.abort` fires
 *      (the runStreamingSession `finally` block runs this drain).
 *   2. UI-triggered `resetSession` that clears via `clearSessionPermissions`
 *      while the renderer still has history visible — `chat:init`'s
 *      `clearInteractiveState` is gated on `historyMessages.length === 0`
 *      (TabProvider.tsx:973), so a non-empty history would leave the modal
 *      painted with no backend entry to respond to → "Unknown request"
 *      desync (PRD #131).
 *
 * Mirrors `external-session.ts::drainPendingInteractiveRequestsAsExpired`.
 * We broadcast the matching `:expired` event so the frontend modal clears
 * even when the chat:init guard skips the unconditional clear.
 *
 * `reason` is forwarded into the `:expired` payload so future telemetry /
 * UX messaging can distinguish reset-driven vs crash-driven expiry. The
 * frontend currently ignores it.
 */
function drainPendingInteractiveRequests(reason: 'reset' | 'session-end'): void {
  // Permission: resolve with 'deny' so any awaiting tool call surfaces as
  // denied.
  for (const [requestId, p] of pendingPermissions) {
    pendingPermissions.delete(requestId);
    try { broadcast('permission:expired', { ...interactiveEventScope(), requestId, reason }); } catch { /* swallow */ }
    try { p.resolve('deny'); } catch { /* swallow — never propagate from cleanup */ }
  }

  // Ask-user-question: remove from the owner snapshot before broadcasting expiry.
  for (const [requestId, q] of pendingAskUserQuestions) {
    pendingAskUserQuestions.delete(requestId);
    try { broadcast('ask-user-question:expired', { ...interactiveEventScope(), requestId, reason }); } catch { /* swallow */ }
    try {
      if (supportsAskUserQuestionNativeCard(currentScenario)) {
        emitImEvent('ask-user-question-expired', JSON.stringify({ requestId, reason }));
      }
    } catch { /* swallow */ }
    try { q.resolve(null); } catch { /* swallow */ }
  }

  // Plan-mode entries resolve with `{approved: false}` (request was not approved).
  for (const [requestId, p] of pendingExitPlanMode) {
    pendingExitPlanMode.delete(requestId);
    try { broadcast('exit-plan-mode:expired', { ...interactiveEventScope(), requestId, reason }); } catch { /* swallow */ }
    try { p.resolve({ approved: false }); } catch { /* swallow */ }
  }

  for (const [requestId, p] of pendingEnterPlanMode) {
    pendingEnterPlanMode.delete(requestId);
    try { broadcast('enter-plan-mode:expired', { ...interactiveEventScope(), requestId, reason }); } catch { /* swallow */ }
    try { p.resolve(false); } catch { /* swallow */ }
  }
}

/**
 * Clear session permission state on user-initiated session reset.
 *
 * Only call site: `resetSession()` (this file, ~L5298). Fork / switch /
 * rewind paths rely on `abortPersistentSession()` → SDK `interrupt()` →
 * canUseTool `signal.abort` → per-handler `onAbort` cleanup, which is the
 * canonical SDK-driven teardown path. (CC review noted the prior JSDoc's
 * "switch/fork/rewind" claim was untrue.)
 */
export function clearSessionPermissions(): void {
  drainPendingInteractiveRequests('reset');
  sessionAlwaysAllowed.clear();
  setPermissionPlanState({ permissionMode: configState.currentPermissionMode, prePlanPermissionMode: null });
}

/**
 * Get pending interactive requests (permission + ask-user-question).
 * Used to replay these to newly connected SSE clients (e.g., Tab joining shared session).
 */
export function getPendingInteractiveRequests(): Array<{
  type: 'permission:request' | 'ask-user-question:request' | 'exit-plan-mode:request' | 'enter-plan-mode:request';
  data: unknown;
}> {
  const result: Array<{ type: 'permission:request' | 'ask-user-question:request' | 'exit-plan-mode:request' | 'enter-plan-mode:request'; data: unknown }> = [];
  for (const [requestId, p] of pendingPermissions) {
    result.push({
      type: 'permission:request',
      data: {
        ...interactiveEventScope(),
        requestId,
        toolName: p.toolName,
        input: typeof p.input === 'object' ? JSON.stringify(p.input).slice(0, 500) : String(p.input).slice(0, 500),
      },
    });
  }
  for (const [requestId, q] of pendingAskUserQuestions) {
    result.push({
      type: 'ask-user-question:request',
      data: { ...interactiveEventScope(), requestId, questions: q.input.questions, previewFormat: 'html' },
    });
  }
  for (const [requestId, p] of pendingExitPlanMode) {
    result.push({
      type: 'exit-plan-mode:request',
      data: { ...interactiveEventScope(), requestId, plan: p.plan, allowedPrompts: p.allowedPrompts },
    });
  }
  for (const [requestId] of pendingEnterPlanMode) {
    result.push({
      type: 'enter-plan-mode:request',
      data: { ...interactiveEventScope(), requestId },
    });
  }
  return result;
}

async function persistMessagesToStorage(
  targetMessageCount = transcriptState.messages.length,
  lastActiveAt?: string,
  metadataDisposition: 'update' | 'skip' = 'update',
): Promise<void> {
  return scheduleTranscriptPersist({
    sessionId,
    getCurrentSessionId: () => sessionId,
    targetMessageCount,
    lastActiveAt,
    metadataDisposition,
  });
}

async function commitPreparedSessionAfterUserMessagePersist(
  messageText: string,
  origin?: SessionOrigin,
  lastActiveAt?: string,
  lastMessagePreview?: string,
): Promise<void> {
  const meta = getSessionMetadata(sessionId);
  if (meta?.materializationState !== 'prepared') return;
  const title = deriveSessionTitle(messageText, 40) || (messageText ? 'New Chat' : '图片消息');
  const updated = await commitPreparedSessionForFirstUserTurn(sessionId, {
    messageText,
    title,
    origin,
    lastActiveAt,
    lastMessagePreview,
  });
  if (!updated) {
    console.warn(`[agent] prepared metadata commit skipped for ${sessionId}: metadata disappeared after user message persist`);
  }
}

/**
 * Linearization point between prepared rollback and irreversible turn
 * admission. Both this commit and rollback compare the same durable
 * materialization marker under the SessionStore lock: whichever wins makes
 * the other fail before the turn is published as accepted.
 */
export async function claimPreparedMaterializationForTurnAdmission(
  messageText: string,
  origin?: SessionOrigin,
): Promise<boolean> {
  const pendingMaterialization = getPendingDesktopMaterialization();
  const targetSessionId = pendingMaterialization?.targetSessionId ?? sessionId;
  const visibleText = resolveVisibleUserTurnText(messageText)?.trim();
  const title = deriveSessionTitle(messageText, 40) || (messageText ? 'New Chat' : '图片消息');
  const claim = await claimPreparedSessionForTurnAdmission(
    targetSessionId,
    pendingMaterialization?.priorSessionId,
    {
      messageText,
      title,
      origin,
      lastMessagePreview: visibleText ? visibleText.slice(0, 60) : undefined,
    },
  );

  if (claim.status === 'claimed' || claim.status === 'already-committed') {
    return true;
  }
  // A genuinely lazy pending session has no metadata until the first admitted
  // user turn. That is distinct from a renderer-prepared target disappearing:
  // the latter still has an in-process transaction and must fail closed.
  if (claim.status === 'not-found' && !pendingMaterialization) {
    return true;
  }
  console.warn(
    `[agent] prepared turn-admission claim refused target=${targetSessionId} source=${pendingMaterialization?.priorSessionId ?? '-'} status=${claim.status}`,
  );
  return false;
}

async function persistMessagesToStorageAndCommitPreparedFirstUserTurn(
  messageText: string,
  origin?: SessionOrigin,
  targetMessageCount = transcriptState.messages.length,
  phase: 'pre-admission' | 'admission' = 'pre-admission',
  lastActiveAt?: string,
): Promise<boolean> {
  const isPrepared = getSessionMetadata(sessionId)?.materializationState === 'prepared';
  await persistMessagesToStorage(
    targetMessageCount,
    isPrepared ? undefined : lastActiveAt,
    isPrepared ? 'skip' : 'update',
  );
  if (!isPrepared || phase === 'pre-admission') {
    return !isPrepared && lastActiveAt !== undefined;
  }
  try {
    const visibleText = resolveVisibleUserTurnText(messageText)?.trim();
    await commitPreparedSessionAfterUserMessagePersist(
      messageText,
      origin,
      lastActiveAt,
      visibleText ? visibleText.slice(0, 60) : undefined,
    );
  } catch (error) {
    console.warn('[agent] prepared metadata commit after user message persist failed:', error);
  }
  return lastActiveAt !== undefined;
}

export function getSessionId(): string {
  return sessionId;
}

function createMetadataForSessionId(
  targetSessionId: string,
  title: string,
  scenario: SessionMaterializationScenario,
  origin?: SessionOrigin,
) {
  const agent = findProjectAgentByWorkspacePath(agentDir) as AgentConfig | undefined;
  const meta = createMaterializedSessionMetadata({
    agentDir,
    sessionId: targetSessionId,
    scenario,
    agent,
    runtimeOverride: getCurrentRuntimeType(),
    managedCodexProviderReady: isManagedCodexProviderReady(loadAdminConfig()),
    fallbackRuntime: getCurrentRuntimeType(),
    title,
    origin,
  });
  return {
    meta,
    snapshotKind: agent ? (isLiveFollowScenario(scenario) ? 'live-follow' : 'owned') : `runtime:${meta.runtime ?? 'none'}`,
  };
}

async function persistSessionMetadataForAdmittedMessage(
  messageText: string,
  params: {
    scenario: SessionMaterializationScenario;
    origin?: SessionOrigin;
    allowLazyMaterialization: boolean;
  },
): Promise<void> {
  if (!hasInitialPrompt) {
    hasInitialPrompt = true;
    const existingMeta = getSessionMetadata(sessionId);
    if (existingMeta) {
      const title = deriveSessionTitle(messageText, 40) || (messageText ? 'New Chat' : '图片消息');
      if (existingMeta.materializationState !== 'prepared') {
        try {
          await commitPreparedSessionForFirstUserTurn(sessionId, {
            messageText,
            title,
            origin: params.origin,
          });
        } catch (error) {
          hasInitialPrompt = false;
          throw error;
        }
      }
      console.log(`[agent] session ${sessionId} already exists in SessionStore, preserving stats`);
      return;
    }
    if (!params.allowLazyMaterialization) {
      hasInitialPrompt = false;
      throw new Error(`[agent] refusing first message for unindexed existing session ${sessionId}; session metadata disappeared before first user turn`);
    }

    const title = deriveSessionTitle(messageText, 40) || (messageText ? 'New Chat' : '图片消息');
    const { meta: sessionMeta, snapshotKind } = createMetadataForSessionId(
      sessionId,
      title,
      params.scenario,
      params.origin,
    );
    if (!isLiveFollowScenario(params.scenario)) {
      Object.assign(sessionMeta, buildOwnedFreezeSnapshotPatch());
    }
    try {
      await saveSessionMetadata(sessionMeta);
    } catch (error) {
      hasInitialPrompt = false;
      throw error;
    }
    setLazySessionMaterializationAllowed(false);
    console.log(`[agent] session ${sessionId} persisted to SessionStore (lazy, scenario=${params.scenario}, snapshot=${snapshotKind})`);
    return;
  }

  if (messageText && transcriptState.messages.length === 0) {
    await updateSessionTitleFromMessage(sessionId, messageText);
  }
}

export async function ensureSessionMetadataForSdkSystemInit(
  nextSystemInit: SystemInitInfo,
  authority: BuiltinQueryAuthority | null = getCurrentQueryAuthority(),
): Promise<string> {
  const sdkSessionId = nextSystemInit.session_id;
  if (!isCurrentQueryAuthority(authority)) {
    throw new Error('[agent] refusing SDK system_init from a revoked or replaced Query');
  }
  if (!sdkSessionId || sdkSessionId !== authority.expectedSdkSessionId) {
    throw new Error(
      `[agent] refusing SDK system_init identity ${sdkSessionId ?? 'missing'}; expected ${authority.expectedSdkSessionId}`,
    );
  }
  const previousSessionId = sessionId;
  if (
    previousSessionId !== authority.productSessionId
    && previousSessionId !== authority.expectedSdkSessionId
  ) {
    throw new Error(
      `[agent] refusing SDK system_init after Product Session changed from ${authority.productSessionId} to ${previousSessionId}`,
    );
  }
  const shouldMigratePendingIdentity = previousSessionId === authority.productSessionId
    && isPendingSessionId(previousSessionId);
  const targetSessionId = shouldMigratePendingIdentity ? sdkSessionId : previousSessionId;
  const previousMeta = getSessionMetadata(previousSessionId);
  const targetMeta = getSessionMetadata(targetSessionId);

  if (shouldMigratePendingIdentity) {
    const migration = await migratePendingSessionIdentity(previousSessionId, targetSessionId, {
      sdkSessionId,
      unifiedSession: sdkSessionId === targetSessionId,
    }, () => (
      isCurrentQueryAuthority(authority)
      && sessionId === authority.productSessionId
    ));
    if (!migration.migrated) {
      throw new Error(`[agent] failed pending session identity migration ${previousSessionId} -> ${targetSessionId}: ${migration.reason}`);
    }
    loadTranscriptFromSessionMessages(migration.transcript.messages, migration.transcript.cursor);
    console.log(`[agent] session ${targetSessionId} persisted to SessionStore (atomic pending identity migration, from=${previousSessionId}, scenario=${currentScenario.type})`);
  } else if (targetMeta) {
    const updated = await updateSessionMetadata(targetSessionId, {
      sdkSessionId,
      unifiedSession: sdkSessionId === targetSessionId,
    }, (current) => {
      const currentSdkSessionId = resolveBuiltinSdkSessionId(current);
      return isCurrentQueryAuthority(authority)
        && sessionId === authority.productSessionId
        && !current.pendingConversationMutation
        && (currentSdkSessionId === undefined || currentSdkSessionId === sdkSessionId);
    });
    if (!updated) {
      throw new Error(`[agent] failed to update session metadata for SDK system_init session ${targetSessionId}`);
    }
  } else {
    const mayMaterializeBirth =
      isLazySessionMaterializationAllowed()
      || isPendingSessionId(previousSessionId);
    if (!mayMaterializeBirth) {
      throw new Error(`[agent] refusing SDK system_init for unindexed existing session ${targetSessionId}; session metadata must exist before messages`);
    }

    const metadata = previousMeta
      ? {
          ...previousMeta,
          id: targetSessionId,
          sdkSessionId,
          unifiedSession: sdkSessionId === targetSessionId,
        }
      : createMetadataForSessionId(
          targetSessionId,
          'New Chat',
          currentScenario.type,
        ).meta;
    if (!previousMeta && !isLiveFollowScenario(currentScenario.type)) {
      Object.assign(metadata, buildOwnedFreezeSnapshotPatch());
    }
    metadata.sdkSessionId = sdkSessionId;
    metadata.unifiedSession = sdkSessionId === targetSessionId;

    await saveSessionMetadata(metadata);
    if (!getSessionMetadata(targetSessionId)) {
      throw new Error(`[agent] failed to materialize session metadata for SDK system_init session ${targetSessionId}`);
    }
    console.log(`[agent] session ${targetSessionId} persisted to SessionStore (sdk system_init birth, from=${previousSessionId}, scenario=${currentScenario.type})`);
  }

  if (targetSessionId !== previousSessionId) {
    setCurrentSessionId(targetSessionId);
    initLogger(targetSessionId);
    console.log(`[agent] SDK system_init migrated session identity ${previousSessionId} -> ${targetSessionId}`);
  }

  setLazySessionMaterializationAllowed(false);
  return targetSessionId;
}

async function materializeInitialPromptSessionMetadata(initialPromptText: string): Promise<void> {
  const existing = getSessionMetadata(sessionId);
  if (existing) {
    setLazySessionMaterializationAllowed(false);
    return;
  }
  const title = deriveSessionTitle(initialPromptText, 40) || 'New Chat';
  const { meta, snapshotKind } = createMetadataForSessionId(
    sessionId,
    title,
    currentScenario.type,
  );
  await saveSessionMetadata(meta);
  if (!getSessionMetadata(sessionId)) {
    throw new Error(`[agent] failed to materialize session metadata for initial prompt session ${sessionId}`);
  }
  setLazySessionMaterializationAllowed(false);
  console.log(`[agent] session ${sessionId} persisted to SessionStore (initialPrompt, scenario=${currentScenario.type}, snapshot=${snapshotKind})`);
}

type OwnedFreezeSnapshotPatch = Partial<Pick<
  SessionMetadata,
  'runtime' | 'runtimeSource' | 'providerExecutionIdentity' | 'origin' | keyof ProductSessionSnapshotPatch
>>;

async function restoreBuiltinConfigFromOwnedMetadata(meta: SessionMetadata): Promise<void> {
  if (!agentDir || isExternalRuntime(getCurrentRuntimeType())) return;
  const { resolveWorkspaceConfig } = await import('./utils/admin-config');
  const resolved = resolveWorkspaceConfig(agentDir, meta, { includeMcp: false });
  await repairOwnedProviderRouteIfNeeded(meta, resolved.providerRoute);
  configSetModel(resolved.model);
  configSetProviderEnv(resolved.providerEnv);
  configSetReasoningEffort(normalizeReasoningEffort(resolved.reasoningEffort));
  configSetSessionEnabledPluginIds(meta.enabledPluginIds ? [...meta.enabledPluginIds] : []);
  configSetSessionEnabledOfficialToolIds(meta.enabledOfficialToolIds ? [...meta.enabledOfficialToolIds] : []);
  if (resolved.permissionMode) {
    const restored = computeRestoredPlanState(resolved.permissionMode as PermissionMode);
    setPermissionPlanState(restored);
  }
  console.log(`[agent] restored owned metadata config: model=${resolved.model ?? 'default'}, provider=${resolved.providerEnv?.baseUrl ?? 'subscription/none'}, effort=${configState.currentReasoningEffort ?? 'default'}, permission=${resolved.permissionMode ?? 'default'}`);
}

async function repairOwnedProviderRouteIfNeeded(
  observedMeta: SessionMetadata,
  providerRoute: SessionMetadata['providerRoute'] | undefined,
): Promise<void> {
  if (!observedMeta.configSnapshotAt || observedMeta.providerRoute || !isConcreteProviderRoute(providerRoute)) return;
  const observed = {
    runtime: observedMeta.runtime,
    model: observedMeta.model,
    providerId: observedMeta.providerId,
    providerEnvJson: observedMeta.providerEnvJson,
    configSnapshotAt: observedMeta.configSnapshotAt,
  };
  await updateSessionMetadata(
    observedMeta.id,
    {
      providerRoute,
      providerId: providerRoute.providerId,
      model: providerRoute.model,
      providerEnvJson: undefined,
      providerRouteRepairedAt: new Date().toISOString(),
    },
    current =>
      !current.providerRoute
      && current.runtime === observed.runtime
      && current.model === observed.model
      && current.providerId === observed.providerId
      && current.providerEnvJson === observed.providerEnvJson
      && current.configSnapshotAt === observed.configSnapshotAt,
  );
}

function buildOwnedFreezeSnapshotPatch(overrides?: OwnedFreezeSnapshotPatch): OwnedFreezeSnapshotPatch & Pick<SessionMetadata, 'configSnapshotAt'> {
  const currentMcpServers = configState.currentMcpServers;
  const currentProviderEnv = configState.currentProviderEnv;
  const currentProviderId = currentProviderEnv?.providerId ?? (configState.currentModel ? SUBSCRIPTION_PROVIDER_ID : undefined);
  const currentProviderRoute = currentProviderId && configState.currentModel
    ? createConcreteProviderRoute(currentProviderId, configState.currentModel)
    : undefined;
  const patch: OwnedFreezeSnapshotPatch & Pick<SessionMetadata, 'configSnapshotAt'> = {
    runtime: getCurrentRuntimeType(),
    ...(configState.currentModel ? { model: configState.currentModel } : {}),
    ...(configState.currentReasoningEffort !== undefined ? { reasoningEffort: configState.currentReasoningEffort } : {}),
    ...(configState.currentPermissionMode ? { permissionMode: configState.currentPermissionMode } : {}),
    ...(currentMcpServers !== null ? { mcpEnabledServers: currentMcpServers.map(server => server.id) } : {}),
    ...(configState.currentEnabledPluginIds !== null ? { enabledPluginIds: [...configState.currentEnabledPluginIds] } : {}),
    ...(configState.currentEnabledOfficialToolIds !== null ? { enabledOfficialToolIds: [...configState.currentEnabledOfficialToolIds] } : {}),
    ...(currentProviderId ? { providerId: currentProviderId } : {}),
    ...(currentProviderRoute ? { providerRoute: currentProviderRoute } : {}),
    ...overrides,
    configSnapshotAt: new Date().toISOString(),
  };
  if (patch.runtime && isExternalRuntime(patch.runtime)) {
    if (patch.providerExecutionIdentity) {
      patch.providerId = patch.providerExecutionIdentity.providerId;
      patch.model = patch.providerExecutionIdentity.model;
    } else {
      delete patch.providerId;
    }
    delete patch.providerRoute;
    delete patch.providerEnvJson;
    delete patch.enabledPluginIds;
  } else if (patch.enabledPluginIds === undefined) {
    patch.enabledPluginIds = getDefaultEnabledPluginIdsForWorkspace(agentDir ?? '');
  }
  if (patch.enabledOfficialToolIds === undefined) {
    patch.enabledOfficialToolIds = getDefaultEnabledOfficialToolIdsForWorkspace(agentDir ?? '');
  }
  return patch;
}

export async function freezeCurrentSessionMetadataForImDetach(
  overrides?: OwnedFreezeSnapshotPatch,
  options?: { allowMissingMetadata?: boolean },
): Promise<{ success: boolean; sessionId?: string; metadata?: SessionMetadata; error?: string }> {
  const existing = getSessionMetadata(sessionId);
  const result = await freezeCurrentProductSessionMetadata({
    workspacePath: agentDir,
    snapshotPatch: buildOwnedFreezeSnapshotPatch(overrides),
    allowMissingMetadata: options?.allowMissingMetadata,
  });
  if (result.success) {
    console.log(
      existing
        ? `[agent] froze IM-bound session ${result.sessionId} as owned before binding transfer`
        : `[agent] materialized and froze unindexed IM-bound session ${result.sessionId} as owned before binding transfer`,
    );
  }
  return result;
}

export async function materializePendingDesktopSession(
  request: {
    phase?: 'prepare' | 'commit' | 'rollback';
    preparedSessionId?: string;
    snapshotPatch?: Partial<{
      [K in keyof ProductSessionSnapshotPatch]: ProductSessionSnapshotPatch[K] | null;
    }>;
    origin?: SessionOrigin;
  } = {},
): Promise<{ success: boolean; sessionId?: string; metadata?: SessionMetadata; error?: string; status?: number }> {
  const phase = request.phase ?? 'commit';
  if (phase === 'rollback') {
    return rollbackPendingProductSession(request.preparedSessionId);
  }
  if (phase === 'prepare') {
    const result = await preparePendingProductSession(
      {
        snapshotPatch: request.snapshotPatch,
        origin: request.origin,
      },
      {
        hasActiveWork: transcriptState.messages.length > 0 || queueHasQueuedOrInFlightWork(),
        createPreparedMetadata(priorSessionId) {
          const liveSdkSessionId = lifecycleState.systemInitInfo?.session_id;
          const targetSessionId = liveSdkSessionId && !isPendingSessionId(liveSdkSessionId)
            ? liveSdkSessionId
            : randomUUID();
          const reusingNativeSession = liveSdkSessionId === targetSessionId;
          const { meta, snapshotKind } = createMetadataForSessionId(
            targetSessionId,
            'New Chat',
            'desktop',
            request.origin,
          );
          console.log(`[agent] prepared pending desktop materialization ${priorSessionId} → ${targetSessionId} (snapshot=${snapshotKind}, reusedLiveSdk=${reusingNativeSession})`);
          return {
            targetSessionId,
            reusingNativeSession,
            snapshotKind,
            metadata: meta,
          };
        },
      },
    );
    return result;
  }
  if (phase !== 'commit') {
    return { success: false, error: `Unsupported materialize phase: ${phase}`, status: 400 };
  }

  return commitPendingProductSession({
    preparedSessionId: request.preparedSessionId,
    async beforeBind(prepared) {
      if (!prepared.reusingNativeSession && lifecycleState.preWarmTimer) {
        clearTimeout(lifecycleState.preWarmTimer);
        setPreWarmTimer(null);
      }
      if (
        !prepared.reusingNativeSession
        && (lifecycleState.processing || lifecycleState.query || lifecycleState.termination)
      ) {
        abortPersistentSession();
        await awaitSessionTermination(10_000, 'materializePendingDesktopSession/commit');
        setQuerySession(null);
      }
    },
    bindSession: setCurrentSessionId,
    async afterBind(prepared, metadata) {
      hasInitialPrompt = false;
      sessionRegistered = prepared.reusingNativeSession;
      pendingResumeSessionAt = undefined;
      setPendingReloadAnchor(undefined);
      if (!prepared.reusingNativeSession) {
        setSystemInitInfo(null);
        setSdkControlReady(false);
        _sdkReadyResolve = null;
        _sdkReadyPromise = null;
        setPreWarmInProgress(false);
        resetPreWarmFailCount();
        resetAbortFlag();
        setSessionProcessing(false);
        setSessionState('idle');
      }
      clearMessageState();
      clearSessionPermissions();
      initLogger(sessionId);

      try {
        await restoreBuiltinConfigFromOwnedMetadata(metadata);
      } catch (error) {
        console.warn('[agent] materializePendingDesktopSession commit: config self-resolution failed:', error);
      }
      if (!prepared.reusingNativeSession) schedulePreWarm();
      console.log(`[agent] committed pending desktop materialization ${prepared.priorSessionId} → ${prepared.targetSessionId} (snapshot=${prepared.snapshotKind}, reusedLiveSdk=${prepared.reusingNativeSession})`);
    },
  });
}

export async function materializeCurrentSessionMetadataForPublishedReset(): Promise<void> {
  const result = await publishCurrentProductSessionMetadata((targetSessionId) => {
    const { meta, snapshotKind } = createMetadataForSessionId(
      targetSessionId,
      'New Chat',
      'agent-channel',
    );
    return { metadata: meta, snapshotKind };
  });
  console.log(`[agent] session ${result.sessionId} persisted to SessionStore (published reset, snapshot=${result.snapshotKind})`);
}

/** Localize SDK/system error transcriptState.messages for IM end-users */
function localizeImError(rawError: string): string {
  if (!rawError) return '模型处理消息时出错';

  const sdkSubprocessDiagnostic = diagnoseSdkSubprocessFailure({ errorMessage: rawError });
  if (sdkSubprocessDiagnostic) {
    return sdkSubprocessDiagnostic.imMessage;
  }

  // Image content not supported by model
  if (rawError.includes('unknown variant') && rawError.includes('image')) {
    return '当前模型不支持图片，请发送文字消息';
  }
  // Model validation error (SDK rejects unknown model for the configured provider)
  if (rawError.includes('issue with the selected model')) {
    return '所选模型不可用，请检查 IM Bot 的模型和供应商配置';
  }
  // SDK subprocess crashed (Windows: anti-virus, OOM, etc.)
  if (rawError.includes('process exited with code') || rawError.includes('process terminated')) {
    return 'AI 引擎异常退出，正在自动恢复，请稍后重试';
  }
  // API authentication errors
  if (rawError.includes('authentication') || rawError.includes('unauthorized') || rawError.includes('401')) {
    return 'API 认证失败，请检查 API Key 配置';
  }
  // Billing / quota errors (check BEFORE rate_limit — quota transcriptState.messages may contain "429")
  if (rawError.includes('billing') || rawError.includes('insufficient_quota')
    || rawError.includes('quota_exceeded') || rawError.includes('quota exceeded')
    || rawError.includes('exceeded your current quota') || rawError.includes('payment required')) {
    return 'API 余额不足，请充值后重试';
  }
  // Rate limiting (transient — safe to retry)
  if (rawError.includes('rate_limit') || rawError.includes('429')) {
    return 'API 请求频率超限，请稍后重试';
  }
  // Server overloaded
  if (rawError.includes('overloaded') || rawError.includes('503')) {
    return 'AI 服务繁忙，请稍后重试';
  }
  // Stale session (SDK conversation data lost after Sidecar restart)
  if (rawError.includes('No conversation found')) {
    return '会话已过期，已自动重置。请重新发送消息';
  }
  // Callback replaced
  if (rawError.includes('Replaced by a newer') || rawError.includes('消息处理被新请求取代')) {
    return '消息处理被新请求取代，请重新发送';
  }
  // Default: truncate long API errors for readability
  if (rawError.length > 100) {
    return rawError.substring(0, 100) + '...';
  }
  return rawError;
}

/** Set group tool deny list for current IM request (v0.1.28) */
export function setGroupToolsDeny(tools: string[]): void {
  currentGroupToolsDeny = tools;
}

// Pattern B — `setImStreamCallback` removed. Callers in /api/im/chat now
// `imEventBus.subscribe(currentSeq, cb)` directly and filter by requestId.
// Pattern C will replace the entire /api/im/chat protocol with /api/im/enqueue
// + /api/im/events long-poll, at which point even the subscription site moves
// out of agent-session.ts.

function resetAbortFlag(): void {
  clearAbortFlag();
}

/**
 * Resolve the Claude Code native binary spawned by the SDK subprocess.
 *
 * SDK 0.2.113+ distributes a single-file `claude` binary (bun build --compile)
 * via per-platform optional packages, replacing the bundled `cli.js` model.
 * The binary self-executes (no external JS runtime required).
 *
 * Resolution order:
 *   1. App bundle: `<resources>/claude-agent-sdk/claude[.exe]`
 *      (build scripts copy from node_modules/@anthropic-ai/claude-agent-sdk-{triple}/claude)
 *   2. node_modules: per-platform optional package installed by npm
 *      (`@anthropic-ai/claude-agent-sdk-<triple>/claude[.exe]`)
 */
export function resolveClaudeCodeCli(): string {
  const t0 = Date.now();
  const ext = process.platform === 'win32' ? '.exe' : '';
  const triple = getPlatformTriple();

  // 1. Production: bundled native binary under resources/claude-agent-sdk/
  //    (Legacy directory name preserved from cli.js era; only contents changed.)
  const cwd = process.cwd();
  const bundledNative = join(cwd, 'claude-agent-sdk', `claude${ext}`);
  if (existsSync(bundledNative)) {
    console.log(`[sdk] Claude native binary resolved via bundled path in ${Date.now() - t0}ms: ${bundledNative}`);
    return bundledNative;
  }

  // 2. Development / fallback: locate per-platform optional package in node_modules
  try {
    const platformPkg = `@anthropic-ai/claude-agent-sdk-${triple}`;
    const candidate = requireModule.resolve(`${platformPkg}/claude${ext}`);
    if (existsSync(candidate)) {
      console.log(`[sdk] Claude native binary resolved via node_modules in ${Date.now() - t0}ms: ${candidate}`);
      return candidate;
    }
    throw new Error(`Binary missing at ${candidate} (package resolved but claude executable is absent)`);
  } catch (error) {
    console.error(
      `[sdk] Claude native binary resolve FAILED in ${Date.now() - t0}ms. ` +
        `Bundled: ${bundledNative}, triple: ${triple}. ` +
        `Run \`npm install\` to restore optional platform package.`,
      error,
    );
    throw error;
  }
}

/**
 * Compute the SDK platform triple matching `@anthropic-ai/claude-agent-sdk-<triple>` package names.
 * On Linux, distinguishes glibc (default) from musl (Alpine et al.) via process.report.
 */
function getPlatformTriple(): string {
  const { platform, arch } = process;
  if (platform === 'darwin') return arch === 'arm64' ? 'darwin-arm64' : 'darwin-x64';
  if (platform === 'win32') return arch === 'arm64' ? 'win32-arm64' : 'win32-x64';
  if (platform === 'linux') {
    const report = process.report?.getReport?.() as { header?: { glibcVersionRuntime?: string } } | undefined;
    const isMusl = !report?.header?.glibcVersionRuntime;
    const base = arch === 'arm64' ? 'linux-arm64' : 'linux-x64';
    return isMusl ? `${base}-musl` : base;
  }
  throw new Error(`Unsupported platform for Claude Agent SDK: ${platform}-${arch}`);
}

/**
 * Build environment for Claude session
 * @param providerEnv - Optional provider environment override (for verification or external calls)
 */
/**
 * Auth env vars that the Claude Code CLI / SDK native binary reads at startup.
 * Any one of these left unset (after `{...process.env}` spread + our provider
 * branches) becomes a hole that the SDK's "fall back to whatever I find" path
 * can fill from a stale source — typically a `.env.example`-style placeholder
 * `ANTHROPIC_API_KEY=sk-ant-your-anthropic-key-here` that an AI helpfully
 * copied into the workspace. The polluted value reaches the SDK auth layer
 * and surfaces as "Not logged in · Please run /login".
 *
 * Fix: after all provider branches run, any var in this list that's still
 * absent gets sealed to an empty string. Verified by reading claude-code
 * source (utils/auth.ts, utils/authFileDescriptor.ts, services/api/filesApi.ts)
 * — every check is a JS truthy test (`if (process.env.X)` or
 * `process.env.X || fallback`), so empty string is semantically identical to
 * unset for the SDK's purposes: OAuth keychain fallback, apiKeyHelper, and
 * Bedrock/Vertex paths all continue to work.
 *
 * v0.2.0 status: under bundled Node + native-binary SDK we no longer have a
 * runtime that auto-loads `.env` from cwd, so the active pollution vector is
 * gone. The seal stays as defense-in-depth: cheap (a handful of `in` checks),
 * documents the auth-env contract, and protects against future SDK runtimes
 * (or shell wrappers) that might re-introduce auto-dotenv behavior.
 *
 * NOT included: CLAUDE_CONFIG_DIR — claude-code/src/utils/envUtils.ts:10 reads
 * it with `??` (nullish coalescing), so an empty string would fall through as
 * "" (not as the homedir fallback) and break the keychain service-name hash.
 */
const CC_AUTH_ENV_VARS_TO_SEAL = [
  'ANTHROPIC_API_KEY',
  'ANTHROPIC_AUTH_TOKEN',
  'ANTHROPIC_BASE_URL',
  'CLAUDE_CODE_OAUTH_TOKEN',
  'CLAUDE_CODE_OAUTH_TOKEN_FILE_DESCRIPTOR',
] as const;

/**
 * Seal SDK auth env vars against environment-pollution sources (legacy Bun
 * auto-dotenv, future shell wrappers, anything that might fill an absent var
 * with a stale value). Only fills empty strings for vars currently ABSENT
 * from env — preserves any real value we or the parent shell explicitly
 * set. See `CC_AUTH_ENV_VARS_TO_SEAL` above for the full rationale.
 */
function sealCcAuthEnv(env: NodeJS.ProcessEnv): void {
  for (const key of CC_AUTH_ENV_VARS_TO_SEAL) {
    if (!(key in env)) {
      env[key] = '';
    }
  }
}

const WINDOWS_UTF8_BASH_ENV_SENTINEL = 'MYAGENTS_WINDOWS_UTF8';
const WINDOWS_UTF8_BASH_ENV_FILENAME = 'windows-utf8-bash-env.sh';
const WINDOWS_UTF8_BASH_ENV_CONTENT = [
  '# MyAgents-managed Bash prelude for Windows SDK tool output.',
  `if [ -n "\${MYAGENTS_ORIGINAL_BASH_ENV:-}" ] && [ "\${MYAGENTS_ORIGINAL_BASH_ENV}" != "\${BASH_ENV:-}" ] && [ -r "\${MYAGENTS_ORIGINAL_BASH_ENV}" ]; then`,
  '  . "${MYAGENTS_ORIGINAL_BASH_ENV}"',
  'fi',
  `export ${WINDOWS_UTF8_BASH_ENV_SENTINEL}=1`,
  'export LANG=C.UTF-8',
  'export LC_ALL=C.UTF-8',
  'export PYTHONUTF8=1',
  'export PYTHONIOENCODING=utf-8',
  'export LESSCHARSET=utf-8',
  'chcp.com 65001 >/dev/null 2>&1 || true',
  '',
].join('\n');

function ensureWindowsUtf8BashEnvScript(home: string): string | undefined {
  if (!home) return undefined;
  const scriptDir = resolve(home, '.myagents', 'runtime');
  const scriptPath = resolve(scriptDir, WINDOWS_UTF8_BASH_ENV_FILENAME);
  try {
    ensureDirSync(scriptDir);
    if (!existsSync(scriptPath) || readFileSync(scriptPath, 'utf-8') !== WINDOWS_UTF8_BASH_ENV_CONTENT) {
      writeFileSync(scriptPath, WINDOWS_UTF8_BASH_ENV_CONTENT, 'utf-8');
    }
    return scriptPath;
  } catch (err) {
    console.warn(`[env] Failed to prepare Windows UTF-8 Bash prelude at ${scriptPath}: ${err instanceof Error ? err.message : String(err)}`);
    return undefined;
  }
}

function toGitBashEnvPath(path: string): string {
  return path.replace(/\\/g, '/');
}

export function applyWindowsUtf8SubprocessEnv(
  env: NodeJS.ProcessEnv,
  options: { platform?: NodeJS.Platform; useBashEnvPrelude?: boolean; home?: string } = {},
): void {
  const platform = options.platform ?? process.platform;
  if (platform !== 'win32') return;

  // The SDK serializes tool output as UTF-8 strings. On Windows, many child
  // tools choose the system ANSI/OEM code page unless the process environment
  // says otherwise, so force UTF-8 before bytes reach the SDK transport.
  env.LANG = 'C.UTF-8';
  env.LC_ALL = 'C.UTF-8';
  env.PYTHONUTF8 = '1';
  env.PYTHONIOENCODING = 'utf-8';
  env.LESSCHARSET = 'utf-8';

  if (!options.useBashEnvPrelude) return;

  const bashEnvScript = ensureWindowsUtf8BashEnvScript(options.home ?? '');
  if (!bashEnvScript) return;

  const bashEnvScriptForShell = toGitBashEnvPath(bashEnvScript);
  const existingBashEnv = env.BASH_ENV;
  const existingBashEnvForShell = existingBashEnv ? toGitBashEnvPath(existingBashEnv) : undefined;
  if (existingBashEnvForShell && existingBashEnvForShell !== bashEnvScriptForShell) {
    env.MYAGENTS_ORIGINAL_BASH_ENV = existingBashEnvForShell;
  }
  env.BASH_ENV = bashEnvScriptForShell;
}

/**
 * Build the env map passed to the Claude Agent SDK subprocess.
 *
 * @param providerEnv  Override the active session's provider. Used by
 *   one-shot callers (provider-verify, title-generator) that spawn an SDK
 *   subprocess against a DIFFERENT provider than the Tab's active session.
 * @param modelOverride  Override `configState.currentModel` for the autocompact-window
 *   lookup. MUST be provided whenever `providerEnv` overrides the session
 *   provider; otherwise `configState.currentModel` (which reflects the Tab's active
 *   session, not the one we're building env for) would inject the wrong
 *   cap into the verify/title subprocess. Safe to omit when this is a
 *   regular session spawn where `configState.currentModel` is already correct.
 * @param opts.bridgeToken  PRD #124: bridge registry token for this
 *   subprocess. When the resolved provider is OpenAI-protocol, the
 *   subprocess's `ANTHROPIC_BASE_URL` includes this token in the path
 *   (`/bridge/<token>`) so the bridge handler routes to ITS upstream and
 *   not the active session's. Caller MUST register the token in
 *   `bridge-registry` before invoking this, and unregister on
 *   subprocess exit. For the active-session path, this is handled in
 *   `startStreamingSession`; for one-shot calls, use `startOneShotBridge`.
 *   When omitted and the provider is OpenAI-protocol, this is a logic
 *   error — the function throws.
 */
export function buildClaudeSessionEnv(
  providerEnv?: ProviderEnv,
  modelOverride?: string,
  opts?: {
    bridgeToken?: string;
    providerId?: string;
    contextWindowSnapshot?: ModelContextLengthSnapshot;
  },
): NodeJS.ProcessEnv {
  // Ensure essential paths are always present, even when launched from Finder
  // (Finder launches via launchd which doesn't inherit shell environment variables)
  const { home } = getCrossPlatformEnv();
  const isDebug = process.env.DEBUG === '1' || process.env.NODE_ENV === 'development';
  const isWindows = process.platform === 'win32';
  const executablePath = buildSessionExecutablePath();
  const myAgentsNpmGlobalPrefix = getMyAgentsNpmGlobalPrefix(home);
  const myAgentsNpmGlobalBinDir = getMyAgentsNpmGlobalBinDir(home);

  // Windows directory env vars — hoisted for reuse across essentialPaths + git-bash detection
  const winProgramFiles = isWindows ? (process.env.PROGRAMFILES || 'C:\\Program Files') : '';
  const winProgramFilesX86 = isWindows ? (process.env['PROGRAMFILES(X86)'] || 'C:\\Program Files (x86)') : '';
  const winLocalAppData = isWindows ? (process.env.LOCALAPPDATA || '') : '';

  if (isDebug) {
    console.log('[env] Script directory:', getScriptDir());
    console.log(`[env] Bundled Node.js: ${executablePath.bundledNodeDir || 'NOT FOUND'}`);
    const originalPath = process.env[executablePath.key] || process.env.PATH || '';
    console.log('[env] Original PATH:', originalPath.substring(0, 200) + (originalPath.length > 200 ? '...' : ''));
    console.log('[env] Final PATH (first 5 entries):', executablePath.entries.slice(0, 5).join(isWindows ? ';' : ':'));
  }

  // Build base environment
  // Spread then explicitly set PATH to avoid duplicate PATH/Path keys on Windows
  // (spreading process.env into a plain object loses case-insensitivity)
  const env: NodeJS.ProcessEnv = { ...process.env };
  delete env.PATH;
  delete env.Path;
  env[executablePath.key] = executablePath.value;

  // Keep builtin sessions away from the provider's hard context boundary.
  // Claude Code 2.1.220 otherwise derives a late fixed-token threshold
  // (effective window - 13K), which is 967K for a 1M model and can exceed a
  // provider's safe input limit once its completion budget is included (#508).
  // Pinning the value also prevents a shell/project launch environment from
  // silently changing MyAgents' session policy.
  env.CLAUDE_AUTOCOMPACT_PCT_OVERRIDE = String(BUILTIN_AUTO_COMPACT_PERCENT);

  // Expose the managed npm prefix for command-local use only. Do NOT set
  // npm_config_prefix / NPM_CONFIG_PREFIX / PREFIX on the whole SDK env:
  // interactive shells with nvm treat those vars as incompatible and print a
  // warning before every Bash/zsh tool run. Skills that need a predictable
  // global install target should use:
  //   npm_config_prefix="$MYAGENTS_NPM_GLOBAL_PREFIX" npm install -g <pkg>
  if (myAgentsNpmGlobalPrefix) {
    env.MYAGENTS_NPM_GLOBAL_PREFIX = myAgentsNpmGlobalPrefix;
    if (myAgentsNpmGlobalBinDir) {
      env.MYAGENTS_NPM_GLOBAL_BIN = myAgentsNpmGlobalBinDir;
    }
    scrubMyAgentsNpmPrefixEnv(env, myAgentsNpmGlobalPrefix);
  }
  // Disable SDK nonessential traffic (Statsig telemetry, Sentry error reporting, surveys).
  // MyAgents manages its own telemetry; these external connections add startup latency
  // and can timeout in restricted network environments (e.g. China).
  env.CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC = '1';
  // Disable SDK built-in cron tools (CronCreate/CronDelete/CronList).
  // MyAgents has its own persistent scheduled Task system (im-cron compatibility
  // tool → Rust TaskStore/TaskSchedulerController) with IM delivery and wall-clock scheduling.
  // The SDK's cron is session-scoped/in-memory, would conflict and confuse users.
  env.CLAUDE_CODE_DISABLE_CRON = '1';
  // Disable SDK auto-loading of claude.ai proxy MCP servers.
  // MyAgents manages MCP servers through its own UI (buildSdkMcpServers).
  // SDK auto-loaded servers use "claude.ai <DisplayName>" format (sanitized to "claude_ai_<Name>"),
  // which mismatches our config IDs → checkMcpToolPermission blocks the tools.
  // See: https://github.com/hAcKlyc/MyAgents/issues/73
  env.ENABLE_CLAUDEAI_MCP_SERVERS = 'false';
  // SDK 0.2.83+: Emit session_state_changed events (idle/running/requires_action).
  // Currently used for diagnostic logging only (parallel data collection).
  // Future: may replace self-built sessionState tracking for more accurate turn boundary detection.
  env.CLAUDE_CODE_EMIT_SESSION_STATE_EVENTS = '1';

  // Resolve provider identity before setting provider-management env vars:
  // Claude Code 2.1.x treats CLAUDE_CODE_PROVIDER_MANAGED_BY_HOST as
  // "host owns auth", which blocks fallback to the local Claude Code
  // subscription store. Anthropic-sub must leave this unset so CC owns OAuth.
  const effectiveProviderEnv = providerEnv ?? configState.currentProviderEnv;
  const effectiveProviderId = opts?.providerId
    ?? effectiveProviderEnv?.providerId
    ?? (providerEnv === undefined
      ? getSessionProviderId() ?? SUBSCRIPTION_PROVIDER_ID
      : (!effectiveProviderEnv?.baseUrl && !effectiveProviderEnv?.apiKey ? SUBSCRIPTION_PROVIDER_ID : ''));

  // Declare MyAgents as the inference-routing host for non-subscription
  // providers. This tells CC's `managedEnv` layer (see claude-code
  // src/utils/managedEnv.ts withoutHostManagedProviderVars) to strip the
  // provider-routing vars (ANTHROPIC_BASE_URL / ANTHROPIC_API_KEY /
  // ANTHROPIC_AUTH_TOKEN / ANTHROPIC_DEFAULT_*_MODEL / CLAUDE_CODE_USE_BEDROCK
  // etc.) out of settings-sourced env before they're applied.
  //
  // Effect: external tools like cc-switch / Claude Code Router that write those
  // vars into user settings cannot silently redirect MyAgents requests to a
  // third-party endpoint. `settingSources: ['project']` already excludes
  // settings.json from the merged-settings path, but getGlobalConfig().env
  // (~/.claude.json) is merged unconditionally — this flag closes that hole.
  //
  // Anthropic subscription experiment: omit the flag so native Claude Code owns
  // its normal OAuth discovery/refresh path and can reuse `claude` CLI login.
  if (effectiveProviderId === SUBSCRIPTION_PROVIDER_ID) {
    delete env.CLAUDE_CODE_PROVIDER_MANAGED_BY_HOST;
    console.log('[env] CLAUDE_CODE_PROVIDER_MANAGED_BY_HOST skipped for Anthropic subscription');
  } else {
    env.CLAUDE_CODE_PROVIDER_MANAGED_BY_HOST = '1';
  }
  // DO NOT set CLAUDE_CONFIG_DIR here — it would change the Keychain service name
  // and break Anthropic subscription OAuth. Enabled global Skills are instead
  // projected into project .claude/skills/ at Query birth.

  // Self-Config CLI: expose sidecar port so the `myagents` CLI can call back
  if (sidecarPort > 0) {
    env.MYAGENTS_PORT = String(sidecarPort);
  }
  env.MYAGENTS_SESSION_ID = sessionId;

  // Windows: Set CLAUDE_CODE_GIT_BASH_PATH so SDK finds git-bash directly
  // without relying on which("git") in PATH (which may be stale after NSIS install).
  //
  // Validate any inherited value: a non-empty CLAUDE_CODE_GIT_BASH_PATH from
  // process.env may be a stale path from a prior Git install location persisted
  // in HKCU\Environment (or set by another tool). If we trusted it blindly the
  // SDK would try to spawn a non-existent bash.exe and the user would see
  // "未安装 Git for Windows" even when Git is correctly installed.
  //
  // SDK 0.2.111+ overlays the subprocess env as `{...process.env, ...env}`,
  // so a `delete env.X` would NOT unset the parent's stale inherited value
  // in the subprocess (same shape as the proxy-var sealing pattern below).
  // Always write the resolved path OR empty string — empty is treated as
  // "not set" and lets the SDK fall back to PATH lookup.
  if (isWindows) {
    // Own local tool availability instead of depending on the SDK's rollout,
    // which our nonessential-traffic policy disables. Git Bash remains available.
    env.CLAUDE_CODE_USE_POWERSHELL_TOOL = '1';
    const inheritedGitBash = process.env.CLAUDE_CODE_GIT_BASH_PATH;
    let resolvedGitBash = '';
    if (inheritedGitBash && existsSync(inheritedGitBash)) {
      resolvedGitBash = inheritedGitBash;
    } else {
      if (inheritedGitBash) {
        console.warn(
          `[env] Inherited CLAUDE_CODE_GIT_BASH_PATH points to a non-existent file (${inheritedGitBash}); ignoring and auto-detecting Git Bash.`,
        );
      }
      const gitBashCandidates = [
        resolve(winProgramFiles, 'Git', 'bin', 'bash.exe'),
        resolve(winProgramFilesX86, 'Git', 'bin', 'bash.exe'),
        ...(winLocalAppData ? [resolve(winLocalAppData, 'Programs', 'Git', 'bin', 'bash.exe')] : []),
      ];
      for (const candidate of gitBashCandidates) {
        if (existsSync(candidate)) {
          resolvedGitBash = candidate;
          break;
        }
      }
    }
    env.CLAUDE_CODE_GIT_BASH_PATH = resolvedGitBash;
  }

  applyWindowsUtf8SubprocessEnv(env, {
    platform: process.platform,
    useBashEnvPrelude: isWindows,
    home,
  });

  if (!effectiveProviderId) {
    console.warn('[env] Provider-owned SDK env missing providerId; MyAgents proxy will not be injected for this subprocess');
  }
  applyProviderProxyPolicyToEnv(env, effectiveProviderId);

  // ── Model alias mapping for sub-agents (applies to ALL protocol paths) ──
  // SDK sub-agents use aliases like "fable"/"sonnet"/"opus"/"haiku" which resolve to claude-* model IDs.
  // For third-party providers, set ANTHROPIC_DEFAULT_*_MODEL so the SDK resolves aliases
  // to provider-specific model IDs (e.g., "sonnet" → "deepseek-chat" instead of "claude-sonnet-4-6").
  // Hoisted above the OpenAI early return so both protocol paths benefit.
  const resolvedModel = modelOverride ?? configState.currentModel;
  const aliases = resolveSessionModelAliases(effectiveProviderEnv?.modelAliases, resolvedModel);
  const resolveContextLength = (model: string | undefined): number | undefined => (
    opts?.contextWindowSnapshot
      ? lookupSnapshotModelContextLength(opts.contextWindowSnapshot, model)
      : lookupProviderModelContextLength(model, effectiveProviderId)
  );
  if (aliases) {
    // _MODEL is what SDK feeds into getContextWindowForModel(); for 1M-window
    // alias targets we MUST tag it with [1m] so the SDK takes the 1M path.
    // _MODEL_NAME stays clean — it's used as a display-label fallback in the
    // SDK /model picker (modelOptions.ts:85) and would surface the suffix to
    // users. SDK strips [1m] before the wire (normalizeModelStringForAPI),
    // so the upstream API never sees it.
    const fableWrapped = applyContextWindowSuffixForContextLength(aliases.fable, resolveContextLength(aliases.fable));
    const sonnetWrapped = applyContextWindowSuffixForContextLength(aliases.sonnet, resolveContextLength(aliases.sonnet));
    const opusWrapped = applyContextWindowSuffixForContextLength(aliases.opus, resolveContextLength(aliases.opus));
    const haikuWrapped = applyContextWindowSuffixForContextLength(aliases.haiku, resolveContextLength(aliases.haiku));
    if (aliases.fable) {
      env.ANTHROPIC_DEFAULT_FABLE_MODEL = fableWrapped!;
      env.ANTHROPIC_DEFAULT_FABLE_MODEL_NAME = aliases.fable;
    }
    if (aliases.sonnet) {
      env.ANTHROPIC_DEFAULT_SONNET_MODEL = sonnetWrapped!;
      env.ANTHROPIC_DEFAULT_SONNET_MODEL_NAME = aliases.sonnet;
    }
    if (aliases.opus) {
      env.ANTHROPIC_DEFAULT_OPUS_MODEL = opusWrapped!;
      env.ANTHROPIC_DEFAULT_OPUS_MODEL_NAME = aliases.opus;
    }
    if (aliases.haiku) {
      env.ANTHROPIC_DEFAULT_HAIKU_MODEL = haikuWrapped!;
      env.ANTHROPIC_DEFAULT_HAIKU_MODEL_NAME = aliases.haiku;
    }
    console.log(`[env] Model aliases set: fable=${fableWrapped ?? '(none)'}, sonnet=${sonnetWrapped ?? '(none)'}, opus=${opusWrapped ?? '(none)'}, haiku=${haikuWrapped ?? '(none)'}`);
  }

  // ── Auto-compact effective window ──
  // Claude Agent SDK's `getContextWindowForModel()` returns 200_000 as fallback
  // for any non-Anthropic model (MODEL_CONTEXT_WINDOW_DEFAULT; see
  // claude-code/src/utils/context.ts:97). For third-party models with smaller
  // native windows (DeepSeek-chat 128K, GLM-4.5-Air 128K, …) this puts the
  // autoCompactThreshold (~effectiveWindow − 13K) above the model's real limit
  // → upstream API errors with "context_length_exceeded" before SDK fires
  // compaction. SDK exposes `CLAUDE_CODE_AUTO_COMPACT_WINDOW` env which caps
  // the window via `Math.min(contextWindow, envCap)` (autoCompact.ts:40-46).
  //
  // We look the resolved model up in the active provider's model registry
  // first, then fall back to the flat custom+discovered+preset registry
  // (see utils/model-capabilities.ts). The resolution order prefers
  // `modelOverride` (one-shot callers that spawn against a different
  // provider/model) over `configState.currentModel` (active Tab session state) — see the
  // function JSDoc for the rationale.
  //
  // `env` starts from `{ ...process.env }`, so any CLAUDE_CODE_AUTO_COMPACT_WINDOW
  // inherited from the user's shell / launch environment is already there. We
  // MUST either override it with our computed value OR explicitly delete it;
  // leaving the inherited value in place would silently cap subprocesses by
  // whatever the user had in their shell rc, with no visibility.
  //
  // Scope: the cap is subprocess-env-wide, so sub-agents invoked via the
  // model-alias map (`sonnet`/`opus`/`haiku` → different provider IDs) share
  // the same cap as the primary model. Acceptable for V1 since the failing
  // case (primary model hits its own 128K ceiling) is what this fixes;
  // sub-agents on a smaller window would be further over-capped, not
  // under-capped.
  const modelContextLength = resolveContextLength(resolvedModel);
  if (modelContextLength && modelContextLength > 0) {
    env.CLAUDE_CODE_AUTO_COMPACT_WINDOW = String(modelContextLength);
    console.log(`[env] CLAUDE_CODE_AUTO_COMPACT_WINDOW=${modelContextLength} (model=${resolvedModel ?? '(unknown)'})`);
  } else {
    // Unknown / custom / missing-contextLength: clear any inherited value so
    // SDK's built-in default (MODEL_CONTEXT_WINDOW_DEFAULT=200K) applies,
    // exactly per product requirement #4. Logging only when a model is
    // actually set — empty configState.currentModel at pre-warm is a normal startup state.
    delete env.CLAUDE_CODE_AUTO_COMPACT_WINDOW;
    if (resolvedModel) {
      console.log(`[env] No contextLength found for model=${resolvedModel} — SDK default 200K applies`);
    }
  }

  // OpenAI Bridge: if provider uses OpenAI protocol, loopback to sidecar
  // PRD #124: per-subprocess token in URL path. Each SDK subprocess
  // (active session, verify, title-gen, sub-agent) registers under a
  // unique token in `bridge-registry`; the URL path lets the route
  // handler look up that subprocess's specific upstream without any
  // shared global state. No more `currentOpenAiBridgeConfig` mutation.
  if (effectiveProviderEnv?.apiProtocol === 'openai' && sidecarPort > 0) {
    const bridgeToken = opts?.bridgeToken;
    if (!bridgeToken) {
      // This is a programming error: caller built env for an OpenAI-protocol
      // provider without first registering a bridge token. The SDK subprocess
      // would send /v1/messages to a path with no /bridge/<token> prefix and
      // get 404. Fail loud here so the bug is obvious at the right call site.
      throw new Error(
        'buildClaudeSessionEnv: OpenAI-protocol provider requires a bridgeToken. ' +
        'Use startOneShotBridge() (one-shot) or rely on startStreamingSession ' +
        'to register the active session token before calling this.'
      );
    }
    // SDK requests go to sidecar's /bridge/<token>/v1/messages route, which
    // translates to OpenAI format and forwards to the per-token upstream.
    env.ANTHROPIC_BASE_URL = `http://127.0.0.1:${sidecarPort}/bridge/${bridgeToken}`;
    env.ANTHROPIC_API_KEY = effectiveProviderEnv.credentialSource
      ? 'myagents-managed-oauth'
      : (effectiveProviderEnv.apiKey ?? '');
    delete env.ANTHROPIC_AUTH_TOKEN;
    // CRITICAL: Strip proxy env vars from subprocess environment.
    // The Claude Code CLI's MA6() unconditionally sets fetchOptions.proxy for the Anthropic
    // SDK client when any proxy env var is present, WITHOUT checking no_proxy. This causes
    // the loopback request to http://127.0.0.1:{port} to be routed through the system proxy,
    // resulting in timeout/502 errors. The subprocess only needs to talk to our local bridge;
    // the bridge handler itself handles upstream proxy if needed (via process.env).
    //
    // NOTE: SDK env semantics — verified against installed sdk-0.2.119 sdk.mjs
    // (kK function): `k6 = o6 ? {...o6} : {...process.env}`, i.e. REPLACE, not
    // overlay. So in principle `delete env[proxyVar]` already prevents the var
    // from reaching the subprocess. We still convert deletes into explicit
    // empty strings as defense-in-depth: the CLI's proxy-from-env lookup
    // (`process.env[k] || ""`) treats empty string as "not set", and any
    // future SDK that flips back to overlay semantics keeps working without
    // a rev here. Same sealing pattern as sealCcAuthEnv() above.
    for (const proxyVar of [
      'http_proxy', 'HTTP_PROXY', 'https_proxy', 'HTTPS_PROXY',
      'ALL_PROXY', 'all_proxy', 'no_proxy', 'NO_PROXY',
    ]) {
      env[proxyVar] = '';
    }
    console.log(`[env] OpenAI bridge: ANTHROPIC_BASE_URL → loopback :${sidecarPort}/bridge/${bridgeToken.slice(0, 8)}…, upstream → ${effectiveProviderEnv.baseUrl}, proxy vars stripped`);
    // Seal any auth var not explicitly set above (e.g. ANTHROPIC_AUTH_TOKEN
    // was deleted, CLAUDE_CODE_OAUTH_TOKEN was never touched) to an empty
    // string. Defense-in-depth against stale `.env` placeholders surfacing
    // as "Not logged in · Please run /login" — see CC_AUTH_ENV_VARS_TO_SEAL
    // above for full rationale.
    sealCcAuthEnv(env);
    return env;
  }

  // Handle provider-specific environment variables
  // IMPORTANT: Must explicitly delete these when switching back to Anthropic subscription
  // to avoid using stale third-party provider settings
  if (effectiveProviderEnv?.baseUrl) {
    env.ANTHROPIC_BASE_URL = effectiveProviderEnv.baseUrl;
    console.log(`[env] ANTHROPIC_BASE_URL set to: ${effectiveProviderEnv.baseUrl}`);
  } else {
    // Clear any previously set third-party baseUrl
    delete env.ANTHROPIC_BASE_URL;
    console.log('[env] ANTHROPIC_BASE_URL cleared (using Anthropic default)');
  }

  if (effectiveProviderEnv?.apiKey) {
    // Set auth based on authType setting
    const authType = effectiveProviderEnv.authType ?? 'both'; // Default to 'both' for backward compatibility

    switch (authType) {
      case 'auth_token':
        // Set AUTH_TOKEN for Authorization: Bearer header.
        // MUST also set API_KEY to the SAME value to block the SDK CLI's internal
        // key resolution chain (KH function) from falling back to keychain/config.
        // Without this, if the user ever saved an unrelated key via `claude auth set-key`,
        // the CLI would find that stale key and send it as x-api-key, causing 403.
        env.ANTHROPIC_AUTH_TOKEN = effectiveProviderEnv.apiKey;
        env.ANTHROPIC_API_KEY = effectiveProviderEnv.apiKey;
        console.log('[env] ANTHROPIC_AUTH_TOKEN + ANTHROPIC_API_KEY set (authType: auth_token)');
        break;
      case 'api_key':
        // Only set API_KEY, delete AUTH_TOKEN
        delete env.ANTHROPIC_AUTH_TOKEN;
        env.ANTHROPIC_API_KEY = effectiveProviderEnv.apiKey;
        console.log('[env] ANTHROPIC_API_KEY set (authType: api_key)');
        break;
      case 'auth_token_clear_api_key':
        // OpenRouter requires AUTH_TOKEN and API_KEY set to empty string.
        // The empty API_KEY tells the Anthropic SDK not to send x-api-key header,
        // while AUTH_TOKEN provides the actual credential via Authorization: Bearer.
        // NOTE: empty string is falsy so the CLI's KH() will still fall back to keychain.
        // This is acceptable for OpenRouter since it only checks the Bearer header.
        env.ANTHROPIC_AUTH_TOKEN = effectiveProviderEnv.apiKey;
        env.ANTHROPIC_API_KEY = '';
        console.log('[env] ANTHROPIC_AUTH_TOKEN set, ANTHROPIC_API_KEY cleared (authType: auth_token_clear_api_key)');
        break;
      case 'both':
      default:
        // Set both variants for compatibility with different SDK versions
        env.ANTHROPIC_AUTH_TOKEN = effectiveProviderEnv.apiKey;
        env.ANTHROPIC_API_KEY = effectiveProviderEnv.apiKey;
        console.log('[env] ANTHROPIC_AUTH_TOKEN and ANTHROPIC_API_KEY both set (authType: both)');
        break;
    }
  } else {
    // Subscription mode: clear any previously inherited third-party apiKey so
    // the SDK falls through to keychain OAuth. `sealCcAuthEnv(env)` below
    // converts the deletes into explicit empty strings — defense-in-depth
    // against any spawning runtime that auto-loads `.env` from cwd and would
    // otherwise refill the keys from a placeholder template.
    delete env.ANTHROPIC_AUTH_TOKEN;
    delete env.ANTHROPIC_API_KEY;
    console.log('[env] ANTHROPIC_AUTH_TOKEN cleared (using default auth)');
  }

  // Seal CC auth env vars before handing the env off to the SDK subprocess
  // (defense-in-depth against `.env`-style pollution). Last-line-of-defense
  // for anything the branches above either deleted (subscription mode) or
  // never set at all (CLAUDE_CODE_OAUTH_TOKEN{,_FILE_DESCRIPTOR}). See
  // CC_AUTH_ENV_VARS_TO_SEAL above for the full rationale — the triggering
  // symptom was "Not logged in · Please run /login" after a user (or an AI
  // helping them) filled out a project's .env.example with placeholder
  // Anthropic credentials.
  sealCcAuthEnv(env);
  return env;
}

function asString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

function safeStringify(value: unknown): string {
  if (typeof value === 'string') {
    return value;
  }
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function asStringArray(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) {
    return undefined;
  }
  return value.map((item) => safeStringify(item));
}

function parseSystemInitInfo(message: unknown): SystemInitInfo | null {
  if (!message || typeof message !== 'object') {
    return null;
  }
  const record = message as Record<string, unknown>;
  if (record.type !== 'system' || record.subtype !== 'init') {
    return null;
  }

  return {
    timestamp: new Date().toISOString(),
    type: asString(record.type),
    subtype: asString(record.subtype),
    cwd: asString(record.cwd),
    session_id: asString(record.session_id),
    tools: asStringArray(record.tools),
    mcp_servers: asStringArray(record.mcp_servers),
    model: asString(record.model),
    permissionMode: asString(record.permissionMode),
    slash_commands: asStringArray(record.slash_commands),
    apiKeySource: asString(record.apiKeySource),
    claude_code_version: asString(record.claude_code_version),
    output_style: asString(record.output_style),
    agents: asStringArray(record.agents),
    skills: asStringArray(record.skills),
    plugins: asStringArray(record.plugins),
    uuid: asString(record.uuid)
  };
}

function normalizeSdkSlashCommand(command: unknown): UiSlashCommand | null {
  if (!command || typeof command !== 'object') {
    return null;
  }
  const record = command as Partial<SdkSlashCommand> & Record<string, unknown>;
  const rawName = typeof record.name === 'string' ? record.name.trim() : '';
  const name = rawName.replace(/^\/+/, '');
  if (!name) {
    return null;
  }

  const aliases = Array.isArray(record.aliases)
    ? record.aliases
        .filter((alias): alias is string => typeof alias === 'string' && alias.trim().length > 0)
        .map((alias) => alias.trim().replace(/^\/+/, ''))
    : undefined;
  const argumentHint = typeof record.argumentHint === 'string' && record.argumentHint.trim().length > 0
    ? record.argumentHint.trim()
    : undefined;

  return {
    name,
    description: typeof record.description === 'string' ? record.description : '',
    source: 'sdk',
    ...(argumentHint ? { argumentHint } : {}),
    ...(aliases && aliases.length > 0 ? { aliases } : {}),
  };
}

function normalizeSdkSlashCommands(commands: unknown): UiSlashCommand[] | null {
  if (!Array.isArray(commands)) {
    return null;
  }

  const normalized: UiSlashCommand[] = [];
  const seen = new Set<string>();
  for (const command of commands) {
    const item = normalizeSdkSlashCommand(command);
    if (!item) continue;
    const key = item.name.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    normalized.push(item);
  }
  return normalized;
}

function parseSdkCommandsChanged(message: unknown): UiSlashCommand[] | null {
  if (!message || typeof message !== 'object') {
    return null;
  }
  const record = message as Record<string, unknown>;
  if (record.type !== 'system' || record.subtype !== 'commands_changed') {
    return null;
  }
  return normalizeSdkSlashCommands(record.commands);
}

function broadcastSdkSlashCommands(commands: UiSlashCommand[], source: 'initialize' | 'commands_changed'): void {
  broadcast('chat:slash-commands', {
    commands,
    sessionId,
    runtime: 'builtin',
    source,
  });
}

/**
 * Parse SDK status message (e.g., compacting)
 * Returns { isStatusMessage, status } to distinguish between:
 * - Not a status message at all (isStatusMessage: false)
 * - A status message with status: null (clearing the status)
 * - A status message with status: 'compacting' etc.
 */
function parseSystemStatus(message: unknown): {
  isStatusMessage: boolean;
  status: string | null;
  permissionMode: string | null;
  compactResult: 'success' | 'failed' | null;
  compactError: string | null;
} {
  if (!message || typeof message !== 'object') {
    return { isStatusMessage: false, status: null, permissionMode: null, compactResult: null, compactError: null };
  }
  const record = message as Record<string, unknown>;
  if (record.type !== 'system' || record.subtype !== 'status') {
    return { isStatusMessage: false, status: null, permissionMode: null, compactResult: null, compactError: null };
  }
  // SDK 0.2.108+: emits status:'requesting' before every API request when includePartialMessages is on.
  // Treat as transient/no-op — we already surface thinking/streaming via partial message events,
  // and propagating it would flash the send button into a disabled state on every tool-call round trip.
  const statusValue = typeof record.status === 'string' ? record.status : null;
  if (statusValue === 'requesting') {
    return { isStatusMessage: false, status: null, permissionMode: null, compactResult: null, compactError: null };
  }
  const compactResult =
    record.compact_result === 'success' || record.compact_result === 'failed'
      ? record.compact_result
      : null;
  // This IS a status message, status can be 'compacting' or null, permissionMode can be 'plan'/'acceptEdits'/etc.
  return {
    isStatusMessage: true,
    status: statusValue,
    permissionMode: typeof record.permissionMode === 'string' ? record.permissionMode : null,
    compactResult,
    compactError: typeof record.compact_error === 'string' ? record.compact_error : null,
  };
}

function setSessionState(nextState: SessionState): void {
  if (sessionState === nextState) {
    return;
  }
  sessionState = nextState;
  broadcast('chat:status', { sessionState });
}

function ensureAssistantMessage(): MessageWire {
  // If SDK drains a queued async message at a turn boundary without emitting
  // SDKUserMessageReplay, the first assistant content of the new turn is the
  // next reliable boundary signal. Surface the user bubble before creating
  // that assistant so UI ordering stays honest.
  maybeSurfaceInFlightAtAssistantTurnStart('assistant turn started after SDK boundary drain');
  setAssistantMessagePresent(true);
  const lastMessage = transcriptState.messages[transcriptState.messages.length - 1];
  if (lastMessage && lastMessage.role === 'assistant' && isStreamingMessage) {
    return lastMessage;
  }
  // (v0.2.11 cross-bugfix) The previous `flushPendingMidTurnQueue()` call here
  // was a safety net that pushed pending user transcriptState.messages onto transcriptState.messages[] when
  // a new assistant block started mid-turn. With deferred yielding, the SDK
  // never sees pending mid-turn transcriptState.messages until the prior turn ends, so this
  // safety net would push a user message that the SDK isn't actually about
  // to respond to — which is exactly the misleading UI behaviour we removed.
  const assistant: MessageWire = {
    id: allocateMessageId(),
    role: 'assistant',
    content: '',
    timestamp: new Date().toISOString()
  };
  appendMessage(assistant);
  isStreamingMessage = true;
  return assistant;
}

/**
 * Apply an SDK retraction (refusal-fallback protocol, SDK 0.3.162+) to the
 * in-memory session state and notify the frontend. Idempotent — both
 * channels (`model_refusal_fallback.retracted_message_uuids` and the
 * replacement assistant's `supersedes`) may name the same uuids.
 *
 * Must run BEFORE the replacement leg's content is appended: when the refused
 * streaming bubble is evicted, isStreamingMessage resets so the retry starts a
 * fresh bubble instead of concatenating refused + replacement content.
 */
async function applyMessageRetraction(retractedUuids: readonly string[] | undefined, source: string): Promise<void> {
  if (!retractedUuids || retractedUuids.length === 0) return;
  // fallbackToStreamingTail: a refusal cuts the stream possibly BEFORE any
  // final assistant frame — the refused bubble then has no (or a stale)
  // sdkUuid and uuid matching alone misses it. The open stream at retraction
  // time IS the refused leg by protocol, so evict the tail too. Passing the
  // live flag also keeps the double-channel replay idempotent: the first
  // channel resets isStreamingMessage, so the second sees fallback=false and
  // already-evicted uuids → empty plan → no second broadcast.
  const plan = planRetraction(transcriptState.messages, retractedUuids, { fallbackToStreamingTail: isStreamingMessage });
  if (plan.removedMessageIds.length > 0) {
    const removed = new Set(plan.removedMessageIds);
    const streamingTailMessageId = plan.removedStreamingTail
      ? transcriptState.messages[transcriptState.messages.length - 1]?.id
      : undefined;
    await applyTranscriptRetractionToPersistence(sessionId, removed, {
      kind: 'sdk-retraction',
      sdkUuids: retractedUuids,
      ...(streamingTailMessageId ? { streamingTailMessageId } : {}),
    });
    if (plan.removedStreamingTail) {
      isStreamingMessage = false;
    }
    // Live frontend streaming bubbles use client-generated ids that never
    // match server transcriptState.messageSequence ids mid-turn (see the message-complete
    // assistant_message_id piggyback) — the id list below only evicts
    // RESTORED-history bubbles. The live refused bubble is evicted via
    // retractedStreamingTail, which the renderer honors unconditionally.
    broadcast('chat:messages-retracted', {
      messageIds: plan.removedMessageIds,
      retractedStreamingTail: plan.removedStreamingTail,
    });
  } else if (retractedUuids.length > 0 && source === 'model_refusal_fallback') {
    // Retraction named uuids but nothing matched and no stream was open —
    // surface it: this is the observable signal for a protocol/mapping gap.
    console.warn(`[agent] ${source}: retraction matched nothing (${retractedUuids.length} uuid(s) named)`);
  }
  // Retracted uuids no longer exist in the SDK transcript — drop them from the
  // rewind/fork anchor sets so resumeSessionAt/fork never target a dead uuid.
  for (const uuid of retractedUuids) {
    deleteCurrentSessionUuid(uuid);
    deleteLiveSessionUuid(uuid);
  }
  console.log(`[agent] ${source}: retracted ${plan.removedMessageIds.length} message(s) / ${retractedUuids.length} uuid(s)`);
}

function ensureContentArray(message: MessageWire): ContentBlock[] {
  if (typeof message.content === 'string') {
    const contentArray: ContentBlock[] = [];
    if (message.content) {
      contentArray.push({ type: 'text', text: message.content });
    }
    message.content = contentArray;
    return contentArray;
  }
  return message.content;
}

/**
 * Check if text is a decorative wrapper from third-party APIs (e.g., 智谱 GLM-4.7)
 * These APIs wrap server_tool_use with decorative text blocks that shouldn't be displayed
 *
 * IMPORTANT: This function must be very precise to avoid filtering legitimate content.
 * We require MULTIPLE specific markers to be present before filtering.
 *
 * @returns { filtered: boolean, reason?: string } - reason is for debugging
 */
function checkDecorativeToolText(text: string): { filtered: boolean; reason?: string } {
  // Safety: never filter very short or very long text
  if (!text || text.length < DECORATIVE_TEXT_MIN_LENGTH || text.length > DECORATIVE_TEXT_MAX_LENGTH) {
    return { filtered: false };
  }

  const trimmed = text.trim();

  // Pattern 1: 智谱 GLM-4.7 tool invocation wrapper
  // Must have ALL of these markers (very specific combination):
  // - "🌐 Z.ai Built-in Tool:" or "Z.ai Built-in Tool:"
  // - "**Input:**" (markdown bold)
  // - Either "```json" or "Executing on server"
  const hasZaiToolMarker = trimmed.includes('Z.ai Built-in Tool:');
  const hasInputMarker = trimmed.includes('**Input:**');
  const hasJsonBlock = trimmed.includes('```json') || trimmed.includes('Executing on server');

  if (hasZaiToolMarker && hasInputMarker && hasJsonBlock) {
    return { filtered: true, reason: 'zhipu-tool-invocation-wrapper' };
  }

  // Pattern 2: 智谱 GLM-4.7 tool output wrapper
  // Must have ALL of these markers:
  // - Starts with "**Output:**"
  // - Contains "_result_summary:" (specific to Zhipu's format)
  // - Contains JSON-like content (starts with "[" or "{")
  if (trimmed.startsWith('**Output:**') && trimmed.includes('_result_summary:')) {
    // Additional check: should contain JSON-like structure
    const hasJsonContent = trimmed.includes('[{') || trimmed.includes('{"');
    if (hasJsonContent) {
      return { filtered: true, reason: 'zhipu-tool-output-wrapper' };
    }
  }

  return { filtered: false };
}

function appendTextChunk(chunk: string): boolean {
  // Filter out decorative text from third-party APIs (e.g., 智谱 GLM-4.7)
  const decorativeCheck = checkDecorativeToolText(chunk);
  if (decorativeCheck.filtered) {
    console.log(`[agent] Filtered decorative text (${decorativeCheck.reason}), length=${chunk.length}`);
    return false;
  }

  // PRD 0.2.37 Session Events — accumulate text for the current turn before
  // message append, using the same post-filter text that the model emitted.
  appendCurrentTurnTextBlock(chunk);

  const message = ensureAssistantMessage();
  if (typeof message.content === 'string') {
    message.content += chunk;
    return true;
  }
  const contentArray = message.content;
  const lastBlock = contentArray[contentArray.length - 1];
  if (lastBlock?.type === 'text') {
    lastBlock.text = `${lastBlock.text ?? ''}${chunk}`;
  } else {
    contentArray.push({ type: 'text', text: chunk });
  }
  return true;
}

function handleThinkingStart(index: number): void {
  // No mid-turn flush here: deferred-yield design means pending mid-turn
  // transcriptState.messages haven't been sent to SDK yet, so a thinking block starting now
  // is the prior turn's content — not a response to a queued message.
  const message = ensureAssistantMessage();
  const contentArray = ensureContentArray(message);
  contentArray.push({
    type: 'thinking',
    thinking: '',
    thinkingStreamIndex: index,
    thinkingStartedAt: Date.now()
  });
}

function handleThinkingChunk(index: number, delta: string): void {
  const message = ensureAssistantMessage();
  const contentArray = ensureContentArray(message);
  const thinkingBlock = contentArray.find(
    (block) => block.type === 'thinking' && block.thinkingStreamIndex === index && !block.isComplete
  );
  if (thinkingBlock && thinkingBlock.type === 'thinking') {
    thinkingBlock.thinking = `${thinkingBlock.thinking ?? ''}${delta}`;
  }
}

function handleToolUseStart(tool: {
  id: string;
  name: string;
  input: Record<string, unknown>;
  streamIndex: number;
  thought_signature?: string;
}): void {
  emitBuiltinToolStartTrace(tool.id, tool.name);
  // No mid-turn flush: see handleThinkingStart for rationale.
  const message = ensureAssistantMessage();
  const contentArray = ensureContentArray(message);
  contentArray.push({
    type: 'tool_use',
    tool: {
      ...tool,
      inputJson: ''
    }
  });
  // Increment tool count for this turn
  incrementCurrentTurnToolCount();

}

/**
 * Handle server_tool_use content block start
 * server_tool_use is a tool executed by the API provider (e.g., 智谱 GLM-4.7's webReader)
 * Unlike tool_use (client-side MCP tools), these run on the server and results come back in the stream
 */
function handleServerToolUseStart(tool: {
  id: string;
  name: string;
  input: Record<string, unknown>;
  streamIndex: number;
}): void {
  emitBuiltinToolStartTrace(tool.id, tool.name);
  // No mid-turn flush: see handleThinkingStart for rationale.
  const message = ensureAssistantMessage();
  const contentArray = ensureContentArray(message);
  contentArray.push({
    type: 'server_tool_use',
    tool: {
      ...tool,
      inputJson: JSON.stringify(tool.input, null, 2), // Server tools come with complete input
      parsedInput: tool.input as unknown as ToolInput
    }
  });
  // Server tools also count towards tool usage
  incrementCurrentTurnToolCount();
}

function handleSubagentToolUseStart(
  parentToolUseId: string,
  tool: {
    id: string;
    name: string;
    input: Record<string, unknown>;
    streamIndex?: number;
    thought_signature?: string;
  }
): void {
  emitBuiltinToolStartTrace(tool.id, tool.name, true);
  const parentTool = findToolBlockById(parentToolUseId);
  if (!parentTool) {
    return;
  }
  childToolToParent.set(tool.id, parentToolUseId);
  if (!parentTool.tool.subagentCalls) {
    parentTool.tool.subagentCalls = [];
  }
  const existing = parentTool.tool.subagentCalls.find((call) => call.id === tool.id);
  if (existing) {
    existing.name = tool.name;
    existing.input = tool.input;
    existing.streamIndex = tool.streamIndex;
    return;
  }
  parentTool.tool.subagentCalls.push({
    id: tool.id,
    name: tool.name,
    input: tool.input,
    streamIndex: tool.streamIndex,
    inputJson: JSON.stringify(tool.input, null, 2),
    isLoading: true
  });
}

function ensureSubagentToolPlaceholder(parentToolUseId: string, toolUseId: string): void {
  const parentTool = findToolBlockById(parentToolUseId);
  if (!parentTool) {
    return;
  }
  if (!parentTool.tool.subagentCalls) {
    parentTool.tool.subagentCalls = [];
  }
  const existing = parentTool.tool.subagentCalls.find((call) => call.id === toolUseId);
  if (existing) {
    return;
  }
  childToolToParent.set(toolUseId, parentToolUseId);
  parentTool.tool.subagentCalls.push({
    id: toolUseId,
    name: 'Tool',
    input: {},
    inputJson: '{}',
    isLoading: true
  });
}

// Pattern 3 §3.2 / §D.3 — parsePartialJson throttle.
//
// `parsePartialJson` walks the entire accumulated string each call. For large
// Edit/Write tool args (multi-MB `new_string`) the legacy "parse on every
// delta" behaviour is O(n²). We now keep a per-tool cursor of the buffer size
// at the last successful parse, and only re-parse when the buffer has grown
// by `PARSE_PARTIAL_JSON_REPARSE_BYTES` or a content-block-stop forces a
// final parse (see `handleContentBlockStop` below — it always calls
// `parsePartialJson` / `JSON.parse` on the final accumulated string).
const PARSE_PARTIAL_JSON_REPARSE_BYTES = 16 * 1024; // 16 KiB
const lastParsedBytesByToolId = new Map<string, number>();
const lastParsedBytesBySubagentToolId = new Map<string, number>();

function handleToolInputDelta(_index: number, toolId: string, delta: string): void {
  const message = ensureAssistantMessage();
  const contentArray = ensureContentArray(message);
  const toolBlock = contentArray.find(
    (block) => block.type === 'tool_use' && block.tool?.id === toolId
  );
  if (!toolBlock || toolBlock.type !== 'tool_use' || !toolBlock.tool) {
    return;
  }
  const newInputJson = `${toolBlock.tool.inputJson ?? ''}${delta}`;
  toolBlock.tool.inputJson = newInputJson;
  // Throttle: only attempt parse when buffer has grown ≥16 KiB since last parse.
  const lastParsed = lastParsedBytesByToolId.get(toolId) ?? 0;
  if (newInputJson.length - lastParsed < PARSE_PARTIAL_JSON_REPARSE_BYTES) {
    return; // keep previous `parsedInput`; consumer sees the last successful value
  }
  const parsedInput = parsePartialJson<ToolInput>(newInputJson);
  if (parsedInput) {
    toolBlock.tool.parsedInput = parsedInput;
  }
  lastParsedBytesByToolId.set(toolId, newInputJson.length);
}

function handleSubagentToolInputDelta(
  parentToolUseId: string,
  toolId: string,
  delta: string
): void {
  const parentTool = findToolBlockById(parentToolUseId);
  if (!parentTool?.tool.subagentCalls) {
    return;
  }
  const subCall = parentTool.tool.subagentCalls.find((call) => call.id === toolId);
  if (!subCall) {
    return;
  }
  const newInputJson = `${subCall.inputJson ?? ''}${delta}`;
  subCall.inputJson = newInputJson;
  const lastParsed = lastParsedBytesBySubagentToolId.get(toolId) ?? 0;
  if (newInputJson.length - lastParsed < PARSE_PARTIAL_JSON_REPARSE_BYTES) {
    return;
  }
  const parsedInput = parsePartialJson<ToolInput>(newInputJson);
  if (parsedInput) {
    subCall.parsedInput = parsedInput;
  }
  lastParsedBytesBySubagentToolId.set(toolId, newInputJson.length);
}

function finalizeSubagentToolInput(parentToolUseId: string, toolId: string): void {
  const parentTool = findToolBlockById(parentToolUseId);
  if (!parentTool?.tool.subagentCalls) {
    return;
  }
  const subCall = parentTool.tool.subagentCalls.find((call) => call.id === toolId);
  if (!subCall?.inputJson) {
    return;
  }
  try {
    subCall.parsedInput = JSON.parse(subCall.inputJson) as ToolInput;
  } catch {
    const parsed = parsePartialJson<ToolInput>(subCall.inputJson);
    if (parsed) {
      subCall.parsedInput = parsed;
    }
  }
  // Pattern 3 §D.3 — terminal state; drop throttle cursor.
  lastParsedBytesBySubagentToolId.delete(toolId);
}

function handleContentBlockStop(index: number, toolId?: string): void {
  const message = ensureAssistantMessage();
  const contentArray = ensureContentArray(message);
  const thinkingBlock = contentArray.find(
    (block) => block.type === 'thinking' && block.thinkingStreamIndex === index && !block.isComplete
  );
  if (thinkingBlock && thinkingBlock.type === 'thinking') {
    thinkingBlock.isComplete = true;
    thinkingBlock.thinkingDurationMs =
      thinkingBlock.thinkingStartedAt ? Date.now() - thinkingBlock.thinkingStartedAt : undefined;
    return;
  }

  const toolBlock =
    toolId ?
      contentArray.find((block) => block.type === 'tool_use' && block.tool?.id === toolId)
      : contentArray.find((block) => block.type === 'tool_use' && block.tool?.streamIndex === index);

  if (toolBlock && toolBlock.type === 'tool_use' && toolBlock.tool?.inputJson) {
    try {
      toolBlock.tool.parsedInput = JSON.parse(toolBlock.tool.inputJson) as ToolInput;
    } catch {
      const parsed = parsePartialJson<ToolInput>(toolBlock.tool.inputJson);
      if (parsed) {
        toolBlock.tool.parsedInput = parsed;
      }
    }
    const display = buildFilePatchDisplayDescriptor(toolBlock.tool);
    if (display) {
      toolBlock.tool.display = display;
    }
    // Pattern 3 §D.3 — block has reached terminal state, drop the throttle
    // cursor so a future tool with a recycled id starts fresh.
    if (toolId) lastParsedBytesByToolId.delete(toolId);
  }
}

function handleToolResultStart(toolUseId: string, content: string, isError: boolean): void {
  if (handleSubagentToolResultStart(toolUseId, content, isError)) {
    return;
  }
  setToolResult(toolUseId, content, isError);
}

function handleToolResultComplete(toolUseId: string, content: string, isError?: boolean): void {
  emitBuiltinToolEndTrace(toolUseId, isError);
  if (handleSubagentToolResultComplete(toolUseId, content, isError)) {
    return;
  }
  setToolResult(toolUseId, content, isError);
}

const builtinTurnLifecycle = createBuiltinTurnLifecycle({
  getSessionId: () => sessionId,
  getWorkspacePath: () => agentDir,
  getCurrentScenario: () => currentScenario,
  getProviderEnv: () => configState.currentProviderEnv,
  getCurrentModel: () => configState.currentModel,
  getIsInterruptingResponse: () => isInterruptingResponse,
  didInFlightSurviveInterrupt,
  setStreamingMessage: (value) => { isStreamingMessage = value; },
  resetInFlightToolCount: () => { inFlightToolCount = 0; },
  resetWatchdogFired: () => { watchdogFired = false; },
  claimPostInterruptResultTerminal: () => settlePostInterruptTurnEnd('result-claimed'),
  terminalEventAppliesToCurrentInFlight,
  dropInFlightQueueItem,
  preserveInFlightAfterTerminalBoundary,
  surfaceInFlightQueueItem,
  schedulePostTerminalQueueDrain,
  endTurnAbort,
  abortTurnAbort,
  clearAmbientTurnId: (sid) => clearAmbientLogContextField(sid, 'turnId'),
  takeCurrentOutputOwner,
  completeOutputOwnerAfterPersistence,
  failOutputOwner,
  cancelCurrentImRequest,
  failCurrentImRequest,
  clearMirrorState: clearChannelDeliveryState,
  clearStreamTurnMaps: () => {
    streamIndexToToolId.clear();
    streamIndexToBlockType.clear();
    toolResultIndexToId.clear();
    childToolToParent.clear();
    imTextBlockIndices.clear();
  },
  clearCronTaskContext,
  hasQueuedOrInFlightWork,
  setSessionState,
  persistTranscript: persistMessagesToStorage,
  snapshotTrace: snapshotBuiltinTurnTrace,
  emitTrace: emitBuiltinTurnTrace,
  emitFirstDeltaTrace: emitBuiltinFirstDeltaTrace,
  clearTrace: clearBuiltinTurnTrace,
  nowMs,
  elapsedMs,
  broadcast,
  broadcastBuiltinContextUsage,
  getCurrentTransientProviderRetryAttempt: () =>
    getCurrentTurnSourceItem()?.transientProviderRetry?.attempt ?? 0,
  scheduleTransientProviderRetry,
  retractTransientProviderTextOutput,
  clearApiRetryStatus,
  trackServer,
  firePostTurnTitleHook,
  appendTextChunk,
  stageAssistantChannelBlock: stageSessionBoundAssistantBlock,
  localizeImError,
  setLastAgentError: (error) => { lastAgentError = error; },
  buildTurnProviderAnalytics,
  probeForkPersistenceIfReady,
  recoverInvalidResumeAnchorError,
  handleTerminalRecovery,
  applyDeferredRestartIfNeeded,
});

function handleMessageStopped(): SessionCompletionTerminal | null {
  return builtinTurnLifecycle.stopTurn();
}

function handleMessageError(error: string, localizedError?: string): SessionCompletionTerminal | null {
  return builtinTurnLifecycle.failTurn(error, localizedError);
}

function probeForkPersistenceIfReady(resultMessage: BuiltinSdkResultMessage): void {
  if (resultMessage.is_error) return;
  const meta = getSessionMetadata(sessionId);
  const sdkSid = meta?.sdkSessionId;
  const probeDir = agentDir;
  if (!meta?.forkFrom || !sdkSid) return;
  sdkGetSessionMessages(sdkSid, { dir: probeDir, limit: 1 })
    .then(found => {
      if (found.length === 0) return;
      const fresh = getSessionMetadata(sessionId);
      if (!fresh?.forkFrom) return;
      console.log(`[agent] fork session ${sessionId} persisted in SDK store — clearing forkFrom`);
      delete fresh.forkFrom;
      saveSessionMetadata(fresh).catch(e =>
        console.warn('[agent] forkFrom clear failed (non-fatal, will retry on next turn):', e),
      );
    })
    .catch(e => {
      console.log(`[agent] forkFrom persistence probe inconclusive, keeping flag: ${(e as Error)?.message ?? e}`);
    });
}

function recoverInvalidResumeAnchorError(rawError: string): boolean {
  if (!isSdkMissingResumeMessageError(rawError)) return false;

  const rejectedUuid = extractSdkMissingResumeMessageUuid(rawError);
  const recoveredAnchors: InvalidResumeAnchorKind[] = [];

  if (pendingResumeSessionAt && (!rejectedUuid || pendingResumeSessionAt === rejectedUuid)) {
    console.warn(`[agent] SDK result rejected rewind resumeSessionAt ${pendingResumeSessionAt} — clearing anchor`);
    deleteCurrentSessionUuid(pendingResumeSessionAt);
    pendingResumeSessionAt = undefined;
    recoveredAnchors.push('rewind');
  }

  if (transcriptState.pendingReloadAnchor && (!rejectedUuid || transcriptState.pendingReloadAnchor === rejectedUuid)) {
    console.warn(`[agent] SDK result rejected reloadAnchor ${transcriptState.pendingReloadAnchor} — clearing anchor`);
    deleteCurrentSessionUuid(transcriptState.pendingReloadAnchor);
    setPendingReloadAnchor(undefined);
    recoveredAnchors.push('reload');
  } else if (rejectedUuid && transcriptState.currentSessionUuids.has(rejectedUuid)) {
    // Result-shaped SDK errors can arrive after system_init already consumed
    // pendingReloadAnchor. The rejected UUID is still unsafe as a future anchor.
    console.warn(`[agent] SDK result rejected known session uuid ${rejectedUuid} — evicting from resume anchor cache`);
    deleteCurrentSessionUuid(rejectedUuid);
    recoveredAnchors.push('reload');
  }

  const failedForkMeta = getSessionMetadata(sessionId);
  if (failedForkMeta?.forkFrom?.messageUuid && (!rejectedUuid || failedForkMeta.forkFrom.messageUuid === rejectedUuid)) {
    const rejectedForkUuid = failedForkMeta.forkFrom.messageUuid;
    console.warn(`[agent] SDK result rejected fork anchor ${rejectedForkUuid} — clearing persisted fork anchor`);
    delete failedForkMeta.forkFrom.messageUuid;
    saveSessionMetadata(failedForkMeta).catch(e =>
      console.warn('[agent] forkFrom.messageUuid clear failed after SDK result error:', e),
    );
    deleteCurrentSessionUuid(rejectedForkUuid);
    recoveredAnchors.push('fork');
  }

  if (!shouldSuppressRecoveredResumeAnchorError({ errorMessage: rawError, recoveredAnchors })) {
    return false;
  }

  const replayItem = buildResumeAnchorReplayItem(getCurrentTurnSourceItem());
  abortPersistentSession({ notifyPendingRequests: false });
  if (replayItem) {
    unshiftMessage(replayItem);
    console.log(`[agent] Requeued current turn ${replayItem.id} after SDK resumeSessionAt result recovery`);
  } else {
    console.warn('[agent] SDK resumeSessionAt result recovery had no current turn source to requeue');
  }
  schedulePreWarm();
  console.log(`[agent] Recovering from SDK resumeSessionAt result error after clearing ${recoveredAnchors.join(',')} anchor(s)`);
  return true;
}

function handleTerminalRecovery(reason: 'image' | 'stale' | undefined): void {
  if (!reason) return;
  const isDesktop = currentScenario.type === 'desktop';
  if (isDesktop && reason === 'image') {
    console.warn('[agent] Desktop image error — skipping auto-reset, frontend will offer rewind');
  } else if (isDesktop && reason === 'stale') {
    console.warn('[agent] Desktop stale session — recovering in place, sessionId + history preserved');
    recoverFromStaleSession().catch(e => console.error('[agent] Stale recovery failed:', e));
  } else {
    console.warn('[agent] Auto-resetting session due to unrecoverable conversation error');
    resetSession().catch(e => console.error('[agent] Auto-reset failed:', e));
  }
}

function applyDeferredRestartIfNeeded(): void {
  if (!hasDeferredRestart()) return;
  if (shouldDeferLiveMcpMutation({
    promotedItemInFlight: queueState.promotedItemInFlight,
    turnInFlight: isTurnInFlight(),
    sdkCommandInFlight: getInFlightQueueId() !== null,
    backgroundTasksActive: hasQueryBackgroundTasks(lifecycleState.query),
  })) {
    return;
  }
  const reasons = drainDeferredRestart();
  console.log(`[agent] Turn complete, applying deferred config restart (reasons=${reasons})`);
  abortPersistentSession();
  schedulePreWarm();
}

function findToolBlockById(toolUseId: string): { tool: ToolUseState } | null {
  for (let i = transcriptState.messages.length - 1; i >= 0; i -= 1) {
    const message = transcriptState.messages[i];
    if (message.role !== 'assistant') {
      continue;
    }
    if (typeof message.content === 'string') {
      continue;
    }
    const toolBlock = message.content.find(
      (block) => block.type === 'tool_use' && block.tool?.id === toolUseId
    );
    if (toolBlock && toolBlock.type === 'tool_use' && toolBlock.tool) {
      return { tool: toolBlock.tool };
    }
  }
  return null;
}

/** Set of tool_use IDs whose results are stripped from frontend broadcast in the current turn */
const strippedToolResultIds = new Set<string>();

function isPlaywrightTool(toolUseId: string): boolean {
  const toolBlock = findToolBlockById(toolUseId);
  return toolBlock?.tool.name.startsWith('mcp__playwright__') ?? false;
}

function appendToolResultDelta(toolUseId: string, delta: string): void {
  if (appendSubagentToolResultDelta(toolUseId, delta)) {
    return;
  }
  const toolBlock = findToolBlockById(toolUseId);
  if (!toolBlock) {
    return;
  }
  toolBlock.tool.result = `${toolBlock.tool.result ?? ''}${delta}`;
}

function handleSubagentToolResultStart(
  toolUseId: string,
  content: string,
  isError: boolean
): boolean {
  const parentToolUseId = childToolToParent.get(toolUseId);
  if (!parentToolUseId) {
    return false;
  }
  const parentTool = findToolBlockById(parentToolUseId);
  if (!parentTool?.tool.subagentCalls) {
    return false;
  }
  const subCall = parentTool.tool.subagentCalls.find((call) => call.id === toolUseId);
  if (!subCall) {
    return false;
  }
  subCall.result = content;
  subCall.isError = isError;
  subCall.isLoading = true;
  return true;
}

function handleSubagentToolResultComplete(
  toolUseId: string,
  content: string,
  isError?: boolean
): boolean {
  const parentToolUseId = childToolToParent.get(toolUseId);
  if (!parentToolUseId) {
    return false;
  }
  const parentTool = findToolBlockById(parentToolUseId);
  if (!parentTool?.tool.subagentCalls) {
    return false;
  }
  const subCall = parentTool.tool.subagentCalls.find((call) => call.id === toolUseId);
  if (!subCall) {
    return false;
  }
  subCall.result = content;
  if (typeof isError === 'boolean') {
    subCall.isError = isError;
  }
  subCall.isLoading = false;
  return true;
}

function appendSubagentToolResultDelta(toolUseId: string, delta: string): boolean {
  const parentToolUseId = childToolToParent.get(toolUseId);
  if (!parentToolUseId) {
    return false;
  }
  const parentTool = findToolBlockById(parentToolUseId);
  if (!parentTool?.tool.subagentCalls) {
    return false;
  }
  const subCall = parentTool.tool.subagentCalls.find((call) => call.id === toolUseId);
  if (!subCall) {
    return false;
  }
  subCall.result = `${subCall.result ?? ''}${delta}`;
  subCall.isLoading = true;
  return true;
}

function finalizeSubagentToolResult(toolUseId: string): boolean {
  const parentToolUseId = childToolToParent.get(toolUseId);
  if (!parentToolUseId) {
    return false;
  }
  const parentTool = findToolBlockById(parentToolUseId);
  if (!parentTool?.tool.subagentCalls) {
    return false;
  }
  const subCall = parentTool.tool.subagentCalls.find((call) => call.id === toolUseId);
  if (!subCall) {
    return false;
  }
  subCall.isLoading = false;
  return true;
}

function getSubagentToolResult(toolUseId: string): string | undefined {
  const parentToolUseId = childToolToParent.get(toolUseId);
  if (!parentToolUseId) {
    return undefined;
  }
  const parentTool = findToolBlockById(parentToolUseId);
  if (!parentTool?.tool.subagentCalls) {
    return undefined;
  }
  return parentTool.tool.subagentCalls.find((call) => call.id === toolUseId)?.result;
}

function setToolResult(toolUseId: string, content: string, isError?: boolean): void {
  const toolBlock = findToolBlockById(toolUseId);
  if (!toolBlock) {
    return;
  }
  toolBlock.tool.result = content;
  if (typeof isError === 'boolean') {
    toolBlock.tool.isError = isError;
  }
  const display = buildFilePatchDisplayDescriptor(toolBlock.tool);
  if (display) {
    toolBlock.tool.display = display;
  }
}

function getToolResult(toolUseId: string): string | undefined {
  const toolBlock = findToolBlockById(toolUseId);
  return toolBlock?.tool.result;
}

function appendToolResultContent(toolUseId: string, content: string, isError?: boolean): string {
  const existing = getToolResult(toolUseId);
  const next = existing ? `${existing}\n${content}` : content;
  setToolResult(toolUseId, next, isError);
  return next;
}

/**
 * PRD 0.2.30 + #293 — unified builtin tool-result media entry. Normalizes the
 * just-completed tool result into `ToolAttachment[]`, sets them on the
 * persisted tool block, and returns them so the caller can include them in
 * the `chat:tool-result-complete` broadcast. Two source families, one entry:
 *   1. file-path media in result TEXT (edge-tts audio / gemini-image image —
 *      PRD 0.2.30, `buildBuiltinMediaAttachments`);
 *   2. image blocks in result CONTENT (generic MCP `ImageContent` base64 /
 *      data-URL / file ref / remote url — #293, pre-extracted by the caller
 *      via `extractToolResultRenderParts`, saved by
 *      `saveExtractedToolResultAttachments`).
 * Every produced attachment is stamped with the tool's presentation class:
 * 'process' (Playwright / computer-use screenshots → rendered inside the
 * folded tool row) vs default artifact (in-flow card, field omitted).
 *
 * No-op (returns undefined) when nothing media-like is present. Idempotent —
 * if the block already carries attachments (e.g. the result surfaced via a
 * second delivery path), the existing set is reused without re-saving.
 *
 * Synchronous save is fine here: base64 round-trips and small file copies are
 * ms-level; non-media tools stay on the zero-cost path (both extractors
 * return [] without touching disk).
 */
async function attachBuiltinMediaIfAny(
  toolUseId: string,
  contentStr: string,
  extracted?: ExtractedToolResultAttachment[],
): Promise<ToolAttachment[] | undefined> {
  const toolBlock = findToolBlockById(toolUseId);
  if (!toolBlock) return undefined;
  if (toolBlock.tool.attachments && toolBlock.tool.attachments.length > 0) {
    return toolBlock.tool.attachments;
  }
  try {
    // workspace = agentDir → extracted images land in the unified
    // `<workspace>/myagents_files/<tool-name>/` location (#293-followup).
    const ctx = { sessionId, toolUseId, workspace: agentDir };
    const attachments = [
      ...await buildBuiltinMediaAttachments(toolBlock.tool.name, contentStr, ctx),
      ...await saveExtractedToolResultAttachments(extracted ?? [], toolBlock.tool.name, ctx),
    ];
    if (attachments.length === 0) return undefined;
    const presentation = classifyToolAttachmentPresentation(toolBlock.tool.name);
    const stamped = presentation === 'process'
      ? attachments.map((a) => ({ ...a, presentation }))
      : attachments; // artifact = omitted field (renderer default; old data stays valid)
    toolBlock.tool.attachments = stamped;
    return stamped;
  } catch (err) {
    console.warn('[agent] builtin media attachment failed:', err instanceof Error ? err.message : String(err));
    return undefined;
  }
}

function formatAssistantContent(content: unknown): string {
  if (!content) {
    return '';
  }
  if (typeof content === 'string') {
    return content;
  }
  if (!Array.isArray(content)) {
    return '';
  }
  const parts: string[] = [];
  for (const block of content) {
    if (typeof block === 'string') {
      parts.push(block);
      continue;
    }
    if (!block || typeof block !== 'object') {
      continue;
    }
    if ('type' in block && block.type === 'text' && 'text' in block) {
      parts.push(String(block.text ?? ''));
      continue;
    }
    if ('type' in block && block.type === 'thinking' && 'thinking' in block) {
      const text = String(block.thinking ?? '').trim();
      if (text) {
        parts.push(`Thinking:\n${text}`);
      }
      continue;
    }
    if ('text' in block && typeof block.text === 'string') {
      parts.push(block.text);
    }
  }
  return parts
    .map((part) => part.trim())
    .filter(Boolean)
    .join('\n\n');
}

/**
 * Append log line and broadcast to frontend
 */
function appendLogLine(line: string): void {
  appendLog(line);
  broadcast('chat:log', line);
}

function extractAgentError(sdkMessage: unknown): string | null {
  if (!sdkMessage || typeof sdkMessage !== 'object') {
    return null;
  }
  // Only check the SDK-level .error field — this is set when the SDK itself encounters
  // an error (auth failure, network error, etc.). Do NOT scan assistant message content
  // for error-like keywords, because the AI may legitimately discuss errors in its analysis
  // (e.g. "Feishu API error code 99991672") which would cause false-positive agent-error banners.
  const candidate = (sdkMessage as { error?: unknown }).error;
  if (candidate) {
    let errorStr: string;
    if (typeof candidate === 'string') {
      errorStr = candidate;
    } else {
      try {
        errorStr = JSON.stringify(candidate);
      } catch {
        errorStr = String(candidate);
      }
    }

    // Try to get a more descriptive message from assistant content or result field
    let detail: string | null = null;
    if ('message' in sdkMessage) {
      const assistantMessage = (sdkMessage as { message?: { content?: unknown } }).message;
      const contentText = formatAssistantContent(assistantMessage?.content);
      if (contentText) {
        detail = contentText;
      }
    }
    if (!detail && 'result' in sdkMessage) {
      const result = (sdkMessage as { result?: unknown }).result;
      if (typeof result === 'string' && result.length > 0) {
        detail = result;
      }
    }

    if (detail) {
      return `${errorStr}: ${detail}`;
    }
    return errorStr;
  }

  return null;
}

export function getAgentState(): {
  agentDir: string;
  sessionState: SessionState;
  hasInitialPrompt: boolean;
} {
  return { agentDir, sessionState, hasInitialPrompt };
}

export function getLastBuiltinAssistantText(): string {
  for (let i = transcriptState.messages.length - 1; i >= 0; i -= 1) {
    const msg = transcriptState.messages[i];
    if (msg?.role !== 'assistant') continue;
    const content = msg.content;
    const text = typeof content === 'string'
      ? extractAssistantTextFromStoredContent(content).trim()
      : content
          .filter((block) => block.type === 'text' && typeof block.text === 'string')
          .map((block) => block.text)
          .join('')
          .trim();
    if (text) return text;
  }
  return '';
}

export function getCurrentTurnIdentity(): TurnIdentity | null {
  return getBuiltinCurrentTurnIdentity()
    ?? getPromotedTurnIdentity()
    ?? getTurnAdmissionIdentity();
}

/**
 * Turn ownership that has crossed the last cancellable boundary.
 *
 * The prepared-session CAS is durable admission: once it starts, callers can
 * no longer truthfully report that the request was never dispatched. The
 * active runtime owner replaces this temporary identity synchronously after
 * the CAS settles.
 */
export function getDispatchedTurnIdentity(): { queueId: string } | null {
  const queueId = getBuiltinCurrentTurnQueueId()
    ?? getCommittingTurnAdmissionQueueId();
  return queueId ? { queueId } : null;
}

export function getBuiltinSessionCompletionTerminal(): SessionCompletionTerminal | null {
  return getLastSessionCompletionTerminal();
}

export function hasQueuedTurnByOwner(owner: TurnOwner): boolean {
  return queueHasQueuedTurnByOwner(owner);
}

export function getSystemInitInfo(): SystemInitInfo | null {
  return lifecycleState.systemInitInfo;
}

export function getLogLines(): string[] {
  return getLogLinesFromLogger();
}

export function getMessages(): MessageWire[] {
  return transcriptState.messages;
}

export function getBuiltinLiveSessionSnapshot(targetSessionId: string): {
  snapshotRevision: number;
  inMemoryMessages: SessionMessage[];
  liveStreamingMessage: SessionMessage | null;
  liveSessionState: SessionState;
  pendingInteractiveRequests: ReturnType<typeof getPendingInteractiveRequests>;
} | null {
  if (targetSessionId !== sessionId) return null;
  flushPendingLiveEvents();
  const streamingAssistantId = getStreamingAssistantId();
  const messages = transcriptState.messages.map(messageWireToSessionMessage);
  const liveStreamingMessage = streamingAssistantId
    ? messages.find(message => message.id === streamingAssistantId) ?? null
    : null;
  return structuredClone({
    snapshotRevision: getBuiltinLiveRevision(),
    inMemoryMessages: messages.filter(message => message.id !== streamingAssistantId),
    liveStreamingMessage,
    liveSessionState: sessionState,
    pendingInteractiveRequests: getPendingInteractiveRequests(),
  });
}

// Last agent error — captured from SDK error events for heartbeat error reporting.
// Set by the SDK message handler, consumed (cleared) by the heartbeat endpoint.
let lastAgentError: string | null = null;

export function getAndClearLastAgentError(): string | null {
  const err = lastAgentError;
  lastAgentError = null;
  return err;
}

/**
 * Internal: Clear all message-related state
 * Used by both resetSession() and initializeAgent()
 */
function clearMessageState(): void {
  clearMessages();
  resetTranscriptPersistenceForSession(sessionId);
  // Pattern 3 §D.3 — drop parsePartialJson throttle cursors so a recycled
  // toolId in a fresh session is not confused with the old buffer length.
  lastParsedBytesByToolId.clear();
  lastParsedBytesBySubagentToolId.clear();
  // Queue clearing is always explicit (broadcast queue:cancelled to the frontend).
  // Defensive: in practice, resetSession / switchToSession drain earlier (before
  // awaitSessionTermination); initializeAgent is typically called on an empty queue.
  drainQueueWithCancellation();
  // PRD 0.2.18 — same treatment as drainQueueWithCancellation: if any
  // queueState.pendingMidTurnQueue items carry inboxMeta.replyBack=true, push a reply
  // before drop. In normal flow rescuePendingToQueue (called by
  // abortPersistentSession) has already moved these into queueState.messageQueue and
  // drainQueueWithCancellation handled them — so this is a defensive cleanup
  // for paths that hit clearMessageState without going through abort first.
  const pendingItems = [...getPendingMidTurnQueue()];
  for (const pending of pendingItems) {
    pushInboxAbortReplyForQueuedItem(pending.sourceItem, 'message_dropped_on_clear');
    pending.sourceItem.settleDispatchAcceptance?.({ accepted: false, error: 'Queue item was cancelled' });
    void notifyQueuedTurnStopped(pending.sourceItem, 'Session state was cleared before queue dispatch');
    pending.sourceItem.resolve();
    broadcast('queue:cancelled', { queueId: pending.queueId });
  }
  clearPendingMidTurn();
  streamIndexToToolId.clear();
  streamIndexToBlockType.clear();
  toolResultIndexToId.clear();
  childToolToParent.clear();
  imTextBlockIndices.clear();

  strippedToolResultIds.clear();
  setAssistantMessagePresent(false);
  clearCurrentSessionUuids();
  clearLiveSessionUuids();
  isStreamingMessage = false;
  setMessageSequence(0);
  configClearDeferredRestart();
  // Pattern B/G: drain the output-owner queue — any in-flight IM bus
  // subscribers for the old session belong to closed SSE streams; new SDK
  // output for a new session should not be tagged with old trace IDs.
  clearPendingRequests();
  imEventBus.clear();
  // Pattern C: drop all registry entries (aborts in-flight controllers via clear()).
  imRequestRegistry.clear();
}

/**
 * 排空消息队列，逐条广播 queue:cancelled。**清 queueState.messageQueue 的唯一正路**。
 *
 * 设计契约（architectural invariant）：
 *   - 任何想清空 queueState.messageQueue 的地方都 MUST 走这个函数，禁止裸 `queueState.messageQueue.length = 0`
 *     或逐项 splice。裸清是前端 pills 残留的来源。
 *   - 频繁调用是幂等的（空队列 early-return），不必担心"多调一次"。
 *
 * 调用者：
 *   - interruptCurrentResponse（停止按钮 / 无活跃 turn 的孤儿清理）
 *   - resetSession / switchToSession / recoverFromStaleSession / rewindSession
 *     （session 重置路径）
 *   - enqueueUserMessage 的 Provider 切换分支（避免 phantom pills）
 *   - clearMessageState（防御：initializeAgent 等路径通常队列为空 → no-op）
 *   - startStreamingSession 的 finally safety net，仅当 lifecycleState.preWarmDisabled 时
 *     （正常模式下队列跨 session 存活，由 schedulePreWarm 接管）
 *
 * 不调用者：
 *   - 正常 turn-complete 路径（队列由 generator 自然 drain）
 *   - abortPersistentSession（只转移 pending，不清 queueState.messageQueue；
 *     队列的清除由 abort 的上游调用者决定）
 */
function drainQueueWithCancellation(): void {
  const queuedMessages = getMessageQueue();
  const queuedTurnBoundary = getTurnBoundaryQueue();
  if (queuedMessages.length === 0 && queuedTurnBoundary.length === 0) return;
  console.log(`[agent] Draining ${queuedMessages.length + queuedTurnBoundary.length} queued transcriptState.messages (explicit cancel)`);
  // PRD 0.2.18 — items carrying inboxMeta.replyBack=true are inbox transcriptState.messages
  // queued but never yielded. Drop them without telling the caller and they
  // hang forever (cross-review CC HIGH #3). Push a session_aborted reply
  // before resolving (fire-and-forget; we don't block teardown).
  const drained = drainQueuedItems();
  for (const item of drained.messages) {
    pushInboxAbortReplyForQueuedItem(item, 'message_dropped_on_reset');
    releaseTurnAdmissionTicket(item.id);
    item.settleDispatchAcceptance?.({ accepted: false, error: 'Queue item was cancelled' });
    void notifyQueuedTurnStopped(item, 'Session reset before queue dispatch');
    item.resolve();
    if (!item.deferVisibleAdmission) {
      broadcast('queue:cancelled', { queueId: item.id });
    }
  }
  for (const item of drained.turnBoundary) {
    const invisibleAdmission = item.admissionTicket?.beforeUserPersistence !== undefined
      || item.sourceItem?.deferVisibleAdmission === true;
    if (item.admissionTicket) {
      cancelDetachedAdmissionTicket(item.admissionTicket);
      item.admissionTicket.settleDispatchAcceptance?.({
        accepted: false,
        error: 'Queue item was cancelled',
      });
      void notifyQueuedTurnStopped(item.admissionTicket, 'Session reset before queue dispatch');
    }
    if (item.sourceItem) {
      pushInboxAbortReplyForQueuedItem(item.sourceItem, 'message_dropped_on_reset');
      item.sourceItem.settleDispatchAcceptance?.({ accepted: false, error: 'Queue item was cancelled' });
      void notifyQueuedTurnStopped(item.sourceItem, 'Session reset before queue dispatch');
      item.sourceItem.resolve();
    }
    if (item.queueId === getForceTurnBoundaryQueueId()) {
      setForceTurnBoundaryQueueId(null);
    }
    releaseTurnAdmissionTicket(item.queueId);
    if (!invisibleAdmission) {
      broadcast('queue:cancelled', { queueId: item.queueId });
    }
  }
  releaseTurnAdmissionTicket();
}

/** Push a session_aborted-style inbox reply for a queued item that will be
 *  dropped without ever running. Safe no-op when the item carries no inboxMeta
 *  or replyBack=false. */
function pushInboxAbortReplyForQueuedItem(
  item: { inboxMeta?: import('./inbox/types').InboxTurnMeta },
  code: 'message_dropped_on_reset' | 'message_dropped_on_clear',
): void {
  const meta = item.inboxMeta;
  if (!meta || !meta.replyBack) return;
  const sid = sessionId;
  void import('./inbox/reply-deliver').then(({ deliverInboxReply }) =>
    deliverInboxReply(sid, meta, {
      text: '',
      error: {
        code,
        message:
          code === 'message_dropped_on_reset'
            ? 'target session was reset before the message ran'
            : 'target session state was cleared before the message ran',
      },
    }),
  ).catch((err) =>
    console.error('[inbox] queued-drop reply pushback failed:', err),
  );
}

/**
 * Load persisted transcriptState.messages from SessionMessage[] into in-memory transcriptState.messages[].
 * Sets transcriptState.messageSequence to continue from the last stored message ID.
 * Used by initializeAgent (resume) and switchToSession to restore conversation state.
 */
/**
 * Reset the current session for "new conversation" functionality
 * This FULLY terminates the SDK session and clears all state
 * Call this from frontend when user clicks "新对话"
 *
 * IMPORTANT: Must properly terminate SDK session to prevent context leakage.
 * Simply interrupting is not enough - we must wait for the session to fully end.
 */
export async function resetSession(options?: { sessionId?: string }): Promise<void> {
  return runSerializedSessionMutation(async () => {
  console.log('[agent] resetSession: starting new conversation');
  // 1. Properly terminate the SDK session (same pattern as switchToSession)
  // Must abort persistent session so the generator exits and subprocess terminates
  if (lifecycleState.query || lifecycleState.termination) {
    console.log('[agent] resetSession: terminating existing SDK session');
    abortPersistentSession();
    // Explicit cancel — broadcasts queue:cancelled so frontend clears pills immediately.
    drainQueueWithCancellation();

    await awaitSessionTermination(10_000, 'resetSession');
    console.log('[agent] resetSession: SDK session terminated (or timed out)');
    setQuerySession(null);
  }

  // 1b. Persist in-memory transcriptState.messages from the old session before clearing.
  // If streaming was aborted mid-turn, handleMessageComplete was never called,
  // so these transcriptState.messages exist only in memory. Persist them to prevent data loss
  // in the old session (user may revisit it from history).
  // sessionId still points to the OLD session here (updated in step 3).
  if (transcriptState.messages.length > 0) {
    console.log(`[agent] resetSession: persisting ${transcriptState.messages.length} in-memory transcriptState.messages before clearing`);
    await persistMessagesToStorage();
  }

  // 1c. Pattern 2 §2.3.1 — release any spilled large-value refs tagged with
  // the old sessionId. Best-effort; fired-and-forget so resetSession isn't
  // delayed by ref I/O. The periodic GC also catches anything left behind.
  if (sessionId) {
    void import('./utils/large-value-store').then(({ clearSessionRefs }) =>
      clearSessionRefs(sessionId)
    ).catch(() => { /* swallow — best-effort cleanup */ });
  }

  // 2. Clear all message state (shared with initializeAgent)
  clearMessageState();
  clearImBridgeToolsContext();

  // 3. Bind the caller-proven target identity, or mint one for ordinary
  // desktop reset. Surface migration passes its Rust-generated target so
  // Router, SidecarManager, Runtime, and renderer adopt one exact identity.
  setCurrentSessionId(options?.sessionId ?? randomUUID());
  hasInitialPrompt = false; // Reset so first message creates a new session in SessionStore
  resetSessionMaterializationState({ allowLazySessionMaterialization: true });

  // A new conversation inherits current Project/global MCP selection and
  // current config.json definitions. Do not pre-warm from the outgoing
  // Session's retained launch objects.
  refreshMcpConfigForNewSession();

  // 4. Clear SDK resume state - CRITICAL: prevents SDK from resuming old context!
  sessionRegistered = false;
  pendingResumeSessionAt = undefined; // Prevent leaking rewind state to new session
  setPendingReloadAnchor(undefined);   // PRD 0.2.27 — symmetric reset (don't leak reload anchor across sessions)
  clearGeneratorResolver();
  setSystemInitInfo(null); // Clear old system info so new session gets fresh init
  setSdkControlReady(false); // Subprocess gone — must re-confirm via initializationResult on next pre-warm

  // 4b. Keep configState.currentAgentDefinitions — agents are workspace-level config, not session state.
  // Clearing them here causes a race: pre-warm fires before frontend re-syncs agents,
  // so referenced global agents (only available via programmatic injection) are lost.
  // See: https://github.com/hAcKlyc/MyAgents/issues/13

  // 5. Clear SDK ready signal state (same as switchToSession)
  _sdkReadyResolve = null;
  _sdkReadyPromise = null;

  // 6. Clear pre-warm state
  setPreWarmInProgress(false);
  resetPreWarmFailCount();
  if (lifecycleState.preWarmTimer) { clearTimeout(lifecycleState.preWarmTimer); setPreWarmTimer(null); }

  // 7. Reset processing state
  resetAbortFlag();
  setSessionProcessing(false);
  setSessionState('idle');

  // 8. Clear session-scoped permissions
  clearSessionPermissions();

  // 9. Broadcast empty state to frontend
  broadcast('chat:init', { agentDir, sessionState: 'idle', hasInitialPrompt: false });

  console.log('[agent] resetSession: complete, new sessionId=' + sessionId);

  // Pre-warm with fresh session so next message is fast
  schedulePreWarm();
  });
}

/**
 * Recover from a stale SDK session without wiping the user's view.
 *
 * Trigger: SDK returned `is_error` with "No conversation found" while trying
 * to `--resume` a session that exists in SessionStore. The conversation data
 * on the SDK side is gone (external claude binary, old build, user ran
 * `claude /clear`, or the project file was never there for sessions created
 * by a different tool), but our SessionStore JSONL is intact and the user
 * is already looking at the loaded history.
 *
 * The default recovery path (`resetSession`) is too aggressive for this
 * scenario — it generates a fresh sessionId and broadcasts `chat:init`,
 * which on the frontend wipes the visible message list and effectively
 * "loses" the session the user just opened. This recovery keeps sessionId
 * and the in-memory / on-disk message history intact, tears down the
 * failed SDK subprocess, and pre-warms a new one that will reuse the same
 * sessionId without `--resume` on its next query. User-visible effect:
 * the 28 loaded transcriptState.messages stay on screen, next user message starts a brand
 * new conversation inside the same session timeline. AI won't remember the
 * earlier turns — accepted trade-off vs. silently destroying the view.
 *
 * Subset of resetSession's cleanup: subprocess teardown, resume disarm,
 * pre-warm reset, pre-warm reschedule. NO sessionId change, NO chat:init
 * broadcast, NO clearMessageState, NO permission reset.
 */
async function recoverFromStaleSession(): Promise<void> {
  return runSerializedSessionMutation(async () => {
    // 1. Terminate the failed SDK subprocess (same pattern as resetSession).
    //    Without this, the next user message would reuse the same broken
    //    subprocess and hit the same "No conversation found" on its next
    //    internal SDK turn.
    if (lifecycleState.query || lifecycleState.termination) {
      console.log('[agent] recoverFromStaleSession: terminating failed SDK subprocess');
      abortPersistentSession();
      // Explicit cancel — this recovery path preserves visible message history but
      // the queue is discarded. Without broadcast, queued pills would linger forever
      // (no chat:init follows this path — that's the whole point of stale recovery).
      drainQueueWithCancellation();
      await awaitSessionTermination(10_000, 'recoverFromStaleSession');
      setQuerySession(null);
    }

    // 2. Disarm resume so the pre-warm / next query starts a fresh SDK
    //    conversation. effectiveSdkSessionId still resolves to the current
    //    sessionId (see startStreamingSession UUID path), so the session
    //    identity is preserved end-to-end.
    sessionRegistered = false;
    pendingResumeSessionAt = undefined;
    setPendingReloadAnchor(undefined); // PRD 0.2.27 — symmetric reset

    // 3. Reset SDK ready signal + pre-warm bookkeeping (mirrors resetSession
    //    steps 5-7 but does NOT clear transcriptState.messages/permissions/sessionId).
    _sdkReadyResolve = null;
    _sdkReadyPromise = null;
    setPreWarmInProgress(false);
    resetPreWarmFailCount();
    if (lifecycleState.preWarmTimer) { clearTimeout(lifecycleState.preWarmTimer); setPreWarmTimer(null); }
    resetAbortFlag();
    setSessionProcessing(false);
    setSessionState('idle');

    // 4. Pre-warm a fresh SDK session with the same sessionId, no --resume.
    schedulePreWarm();

    console.log(`[agent] recoverFromStaleSession: complete, sessionId=${sessionId} preserved`);
  });
}

/**
 * Initialize agent with a new working directory
 * Called when switching to a different project/workspace
 */
export async function initializeAgent(
  nextAgentDir: string,
  initialPrompt?: string | null,
  initialSessionId?: string,
  options?: { preWarmDisabled?: boolean },
): Promise<void> {
  if (options?.preWarmDisabled) {
    setPreWarmDisabled(true);
    console.log('[agent] pre-warm disabled via --no-pre-warm');
  }
  agentDir = nextAgentDir;
  hasInitialPrompt = Boolean(initialPrompt && initialPrompt.trim());
  setCurrentProductSessionContext({ workspacePath: nextAgentDir, hasInitialPrompt });
  setSystemInitInfo(null);
  setSdkControlReady(false);

  // Memoize session metadata for the whole initialization pass. Previously this
  // function called getSessionMetadata(initialSessionId) three times (at resume
  // decision, message load, and MCP self-resolve); each call scans sessions.json
  // and a large JSONL can cost ~30-100ms. Read once, reuse.
  let initMeta = initialSessionId ? getSessionMetadata(initialSessionId) : null;
  if (initialSessionId && initMeta?.pendingConversationMutation) {
    const resolved = await resolvePendingConversationMutation(initialSessionId);
    if (!resolved.success) {
      throw new Error(
        `[agent] refused to initialize ${initialSessionId}: pending conversation mutation could not recover: ${resolved.error}`,
      );
    }
    initMeta = resolved.metadata;
  }
  resetSessionMaterializationState({ allowLazySessionMaterialization: !initialSessionId });

  if (initialSessionId) {
    // Use caller-specified session_id (IM / Tab opening existing session / CronTask)
    setCurrentSessionId(initialSessionId);

    // Metadata alone is not enough to resume the Claude Agent SDK. POST /sessions
    // creates MyAgents metadata before the SDK has ever persisted a transcript,
    // so `query({ resume })` would fail with "No conversation found". If
    // sdkSessionId is missing, only recover the rare crash-before-metadata-update
    // case when the SDK transcript probe finds real persisted transcriptState.messages.
    const meta = initMeta;
    if (meta) {
      const currentRuntimeType = getCurrentRuntimeType();
      const resumeDecision = await decideBuiltinSessionResume({
        meta,
        currentRuntime: currentRuntimeType,
        agentDir: nextAgentDir,
        probeSdkTranscript: sdkGetSessionMessages,
      });
      if (resumeDecision.shouldResume) {
        sessionRegistered = true;
        console.log(`[agent] initializeAgent: will resume session ${resumeDecision.resumeSessionId} (reason=${resumeDecision.reason}, sdkSessionId=${meta.sdkSessionId ?? 'unknown'})`);
      } else {
        sessionRegistered = false;
        if (resumeDecision.reason === 'runtime-mismatch') {
          console.log(`[agent] initializeAgent: cross-runtime session ${initialSessionId} (created by ${meta.runtime}, current=${currentRuntimeType}), will NOT resume`);
        } else if (resumeDecision.reason === 'external-runtime') {
          console.log(`[agent] initializeAgent: external runtime ${currentRuntimeType}, builtin SDK resume disabled for ${initialSessionId}`);
        } else if (resumeDecision.reason === 'probe-error') {
          const msg = resumeDecision.error instanceof Error ? resumeDecision.error.message : String(resumeDecision.error);
          throw new Error(`[agent] SDK transcript probe failed for ${initialSessionId}; refusing to replace its bound SDK identity: ${msg}`);
        } else {
          console.log(`[agent] initializeAgent: will create fresh SDK session ${initialSessionId} (resume skipped: ${resumeDecision.reason})`);
        }
      }
    } else {
      sessionRegistered = false;
      console.log(`[agent] initializeAgent: will create new session ${initialSessionId}`);
    }
  } else {
    // No specified ID → auto-generate (standard Tab new conversation flow)
    setCurrentSessionId(randomUUID());
    sessionRegistered = false; // Fresh session, no SDK data to resume
  }

  // Clear message state (shared with resetSession)
  clearMessageState();

  // For resume sessions: load existing transcriptState.messages from disk into memory.
  // This is critical for shared Sidecar (IM + Desktop Tab):
  // 1. SSE replay (chat:message-replay) includes old transcriptState.messages when Tab connects
  // 2. transcriptState.messageSequence continues from last ID (prevents ID collision with disk transcriptState.messages)
  // 3. SessionStore issues the exact append cursor for the loaded transcript
  // Same pattern as switchToSession's message loading.
  // Also load for cross-runtime sessions (sessionRegistered=false but transcriptState.messages exist for display).
  //
  // Note on the "two-sidecar ID collision" scenario (originally called Bug B):
  // that scenario would require a concurrent writer's disk flush to lag behind
  // its metadata stats. SessionStore transcript append writes the
  // JSONL via appendFileSync BEFORE it updates `stats.messageCount` under the
  // sessions-lock, so `diskCount === 0 && stats.messageCount > 0` is unreachable
  // through normal mutations. Bug A's rotate-per-tick fix additionally removes
  // the cron pathway that could have produced two concurrent sidecars for the
  // same session. A prior version of this file carried a defensive seed based
  // on `stats.messageCount`, but `messageCount` only counts user transcriptState.messages
  // (SessionStore.ts calculateSessionStats), whereas transcriptState.messageSequence indexes
  // every persisted message — so the seed would under-count and still collide.
  // Removed rather than fixed: the disk-first write order is the real guard.
  if (initialSessionId && initMeta) {
    const transcript = await loadSessionTranscript(initialSessionId);
    loadTranscriptFromSessionMessages(transcript.messages, transcript.cursor);
    if (transcript.messages.length > 0) {
      console.log(`[agent] initializeAgent: loaded ${transcript.messages.length} existing transcriptState.messages, transcriptState.messageSequence=${transcriptState.messageSequence}`);
    }
  }

  // Initialize logger for new session (lazy file creation)
  initLogger(sessionId);
  console.log(`[agent] init dir=${agentDir} initialPrompt=${hasInitialPrompt ? 'yes' : 'no'} sessionId=${sessionId} resume=${sessionRegistered}`);

  // Phase E (PRD 0.2.7): file-watcher → SSE removed; renderer uses the Rust
  // workspace_files watcher via Tauri events (`workspace:files-changed:*`).

  // Self-resolve workspace config from disk (MCP/provider/model).
  // Eliminates dependency on pre-serialized snapshots (providerEnvJson, mcpServersJson)
  // that can fail to save or go stale. IM Bot sessions work correctly without the
  // frontend having been opened first. For desktop Tabs, the frontend's /api/mcp/set
  // and per-message providerEnv will override these values.
  // Skip for Global Sidecar (no workspace-specific config).
  if (!lifecycleState.preWarmDisabled) {
    try {
      const mcpAuthority = getMcpAuthorityForScenario(currentScenario.type);
      const shouldSelfResolveMcp = mcpAuthority === 'self-resolve' && hasInitialPrompt;
      // v0.1.69: pass session metadata so the sidecar prefers session snapshot
      // (`meta.model`, `meta.providerId/EnvJson`, `meta.mcpEnabledServers`) over the
      // agent's current values. For IM sessions (which deliberately don't snapshot
      // these fields), this is a no-op — the agent fallback handles them.
      //
      // Pass `includeMcp: shouldSelfResolveMcp` — Tab sessions deliberately
      // skip MCP self-resolve because the frontend's /api/mcp/set is
      // authoritative, so asking resolveWorkspaceConfig to compute an MCP list
      // that will be discarded is pure waste. Cuts the expensive
      // getAllMcpServers/getEffectiveMcpServers disk walk out of the Tab-open
      // critical path.
      const resolved = resolveWorkspaceConfig(agentDir, initMeta, {
        includeMcp: shouldSelfResolveMcp,
      });
      if (initMeta) {
        await repairOwnedProviderRouteIfNeeded(initMeta, resolved.providerRoute);
      }
      const restoreOwnedBuiltinConfig = Boolean(initMeta?.configSnapshotAt) && !isExternalRuntime(getCurrentRuntimeType());
      // Only self-resolve MCP for background authorities (IM/Task/agent-channel)
      // with an initial prompt. Tab sessions must NOT self-resolve: the
      // frontend's /api/mcp/set is authoritative, and self-resolve produces
      // slightly different field structures (env/args) that trigger a fingerprint
      // mismatch → abort → 30s delay.
      if (shouldSelfResolveMcp && configState.currentMcpServers === null && resolved.mcpServers.length > 0) {
        setCurrentMcpServers(resolved.mcpServers);
        console.log(`[agent] self-resolved ${resolved.mcpServers.length} MCP server(s): ${resolved.mcpServers.map((s: { id: string }) => s.id).join(', ')}`);
      }
      if (restoreOwnedBuiltinConfig) {
        // Owned desktop/Task sessions carry a frozen snapshot. Restore must
        // replace the previous session's in-memory config, not fill only empty
        // slots; otherwise a resumed session can inherit another session's
        // provider/model/effort until the renderer pushes config.
        configSetProviderEnv(resolved.providerEnv);
        configSetModel(resolved.model);
        configSetReasoningEffort(normalizeReasoningEffort(resolved.reasoningEffort));
        console.log(`[agent] restored owned session config: model=${resolved.model ?? 'default'}, provider=${resolved.providerEnv?.baseUrl ?? 'subscription/none'}, effort=${configState.currentReasoningEffort ?? 'default'}`);
        if (resolved.providerEnv) ensureActiveSessionBridgeRegistered();
      } else if (!configState.currentProviderEnv && resolved.providerEnv) {
        configSetProviderEnv(resolved.providerEnv);
        console.log(`[agent] self-resolved provider: ${resolved.providerEnv.baseUrl ?? 'anthropic'}`);
        // PRD #124: keep bridge registration in sync after self-resolve.
        ensureActiveSessionBridgeRegistered();
      }
      // Only self-resolve model for builtin runtime. External runtimes (CC/Codex) should use
      // their own model (set via /api/model/set from frontend runtimeModel effect).
      // agent.model is the builtin model (e.g. "glm-5.1") and must NOT be sent to CC/Codex. See: #71
      if (!restoreOwnedBuiltinConfig && !configState.currentModel && resolved.model && !isExternalRuntime(getCurrentRuntimeType())) {
        configSetModel(resolved.model);
        console.log(`[agent] self-resolved model: ${resolved.model}`);
      }
      // #324 — same builtin-only gate as model: headless builtin sessions
      // (IM bot / cron new-session / crash-restarted sidecar) have no desktop
      // push effect, so this self-resolve is their ONLY effort source. External
      // runtimes resolve effort from runtimeConfig in their own start paths.
      if (!restoreOwnedBuiltinConfig && !configState.currentReasoningEffort && resolved.reasoningEffort && !isExternalRuntime(getCurrentRuntimeType())) {
        configSetReasoningEffort(normalizeReasoningEffort(resolved.reasoningEffort));
        if (configState.currentReasoningEffort) {
          console.log(`[agent] self-resolved reasoning effort: ${configState.currentReasoningEffort}`);
        }
      }
      if (resolved.permissionMode && !isExternalRuntime(getCurrentRuntimeType())) {
        if (resolved.permissionMode !== configState.currentPermissionMode) {
          console.log(`[agent] self-resolved permissionMode: ${resolved.permissionMode}`);
        }
        // Restored mode is authoritative session state; drop any configState.prePlanPermissionMode
        // carried from a prior session/context so a later ExitPlanMode / SDK-status exit
        // can't "restore" the wrong session's mode (codex review). See computeRestoredPlanState.
        const restored = computeRestoredPlanState(resolved.permissionMode as PermissionMode);
        setPermissionPlanState(restored);
      }
    } catch (error) {
      // Self-resolution failure is non-fatal — fall back to external sync (Rust sync_ai_config)
      console.warn('[agent] self-resolution failed, falling back to external sync:', error);
    }
  }

  if (hasInitialPrompt) {
    const trimmedInitialPrompt = initialPrompt!.trim();
    if (!isLazySessionMaterializationAllowed() && !getSessionMetadata(sessionId)) {
      throw new Error(`[agent] refusing initial prompt for unindexed existing session ${sessionId}; session metadata must exist before starting a sidecar with --session-id`);
    }
    await materializeInitialPromptSessionMetadata(trimmedInitialPrompt);
    void enqueueUserMessage(
      trimmedInitialPrompt,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      { channelDelivery: SESSION_BOUND_CHANNEL_DELIVERY },
    );
  } else {
    // Pre-warm subprocess + MCP so first message is fast.
    // Only start immediately if MCP is already resolved (IM Bot sessions that
    // self-resolved from disk). For Tab sessions, the frontend will call
    // /api/mcp/set shortly after connecting, which triggers schedulePreWarm()
    // with the authoritative config. This avoids the race where self-resolve
    // and frontend produce slightly different MCP fingerprints, causing an
    // unnecessary abort + 30s restart loop.
    if (configState.currentMcpServers !== null) {
      schedulePreWarm();
    }
  }
}

/**
 * Switch to an existing session for resume functionality
 * This terminates the current session and prepares to resume from the target session
 * 
 * Key behavior:
 * - Preserves target sessionId so transcriptState.messages are saved to the same session
 * - Sets sessionRegistered only when the SDK can resume the target transcript
 * - Metadata-only sessions start fresh but keep the same session ID
 */
export async function switchToSession(targetSessionId: string): Promise<boolean> {
  return runSerializedSessionMutation(async () => {
  console.log(`[agent] switchToSession: ${targetSessionId}`);

  // Skip if already on the target session — prevents aborting an active streaming task
  // when frontend calls loadSession on the same session (e.g., after cron timeout)
  if (targetSessionId === sessionId) {
    console.log(`[agent] switchToSession: already on session ${targetSessionId}, skipping`);
    return true;
  }

  // Get the target session metadata to find SDK session_id
  let sessionMeta = getSessionMetadata(targetSessionId);
  if (!sessionMeta) {
    console.error(`[agent] switchToSession: session ${targetSessionId} not found`);
    return false;
  }
  if (sessionMeta.pendingConversationMutation) {
    const resolved = await resolvePendingConversationMutation(targetSessionId);
    if (!resolved.success) {
      throw new Error(
        `[agent] refused to switch to ${targetSessionId}: pending conversation mutation could not recover: ${resolved.error}`,
      );
    }
    sessionMeta = resolved.metadata;
  }
  const targetAgentDir = sessionMeta.agentDir || agentDir;
  const resumeDecision = await decideBuiltinSessionResume({
    meta: sessionMeta,
    currentRuntime: getCurrentRuntimeType(),
    agentDir: targetAgentDir,
    probeSdkTranscript: sdkGetSessionMessages,
  });
  if (!resumeDecision.shouldResume && resumeDecision.reason === 'probe-error') {
    const msg = resumeDecision.error instanceof Error ? resumeDecision.error.message : String(resumeDecision.error);
    throw new Error(`[agent] SDK transcript probe failed for ${targetSessionId}; refusing to replace its bound SDK identity: ${msg}`);
  }

  // Properly terminate the old session if one is running
  // Must abort persistent session so the generator exits and subprocess terminates
  // Otherwise the old session continues processing transcriptState.messages with stale settings
  if (lifecycleState.query || lifecycleState.termination) {
    console.log('[agent] switchToSession: aborting current session');
    abortPersistentSession();
    // Explicit cancel — broadcasts queue:cancelled so frontend clears pills immediately
    // (chat:init follows but that's seconds later, after awaitSessionTermination).
    drainQueueWithCancellation();
    await awaitSessionTermination(10_000, 'switchToSession');
    setQuerySession(null);
  }

  // Persist current in-memory transcriptState.messages before clearing to prevent data loss
  // (e.g., if an active streaming session accumulated transcriptState.messages not yet saved to disk)
  if (transcriptState.messages.length > 0) {
    console.log(`[agent] switchToSession: persisting ${transcriptState.messages.length} in-memory transcriptState.messages before clearing`);
    await persistMessagesToStorage();
  }

  // Reset message/queue/streaming state (shared with initializeAgent, resetSession)
  clearMessageState();
  clearImBridgeToolsContext();

  // Reset session-level runtime state
  resetAbortFlag();
  setSessionProcessing(false);
  sessionRegistered = false; // Will re-set from sessionMeta below
  pendingResumeSessionAt = undefined; // Prevent leaking rewind state to different session
  setPendingReloadAnchor(undefined);   // PRD 0.2.27 — symmetric reset
  clearGeneratorResolver();
  setSessionState('idle');
  setSystemInitInfo(null);
  setSdkControlReady(false);

  // Clear SDK ready signal state
  _sdkReadyResolve = null;
  _sdkReadyPromise = null;

  // Clear pre-warm state from old session
  setPreWarmInProgress(false);
  resetPreWarmFailCount();
  if (lifecycleState.preWarmTimer) { clearTimeout(lifecycleState.preWarmTimer); setPreWarmTimer(null); }

  // Preserve target sessionId so new transcriptState.messages are saved to the same session
  setCurrentSessionId(targetSessionId);
  resetSessionMaterializationState({ allowLazySessionMaterialization: false });

  // Load existing transcriptState.messages from storage into memory
  // This is critical for cursor-based incremental append
    const transcript = await loadSessionTranscript(targetSessionId);
    loadTranscriptFromSessionMessages(transcript.messages, transcript.cursor);
    if (transcript.messages.length > 0) {
      console.log(`[agent] switchToSession: loaded ${transcript.messages.length} existing transcriptState.messages`);
    }

  // Set sessionRegistered based on whether the SDK can actually resume this
  // session. Metadata-only sessions must start fresh with the same sessionId.
  if (resumeDecision.shouldResume) {
    sessionRegistered = true;
    console.log(`[agent] switchToSession: will resume session ${resumeDecision.resumeSessionId} (reason=${resumeDecision.reason})`);
  } else if (resumeDecision.reason === 'external-runtime') {
    // External runtimes (codex/gemini/CC) don't use builtin SDK resume state.
    // Their resume is driven by runtimeSessionId in external-session.ts.
    sessionRegistered = false;
  } else {
    // 从未 query 过的 session，用 sessionId 创建
    sessionRegistered = false;
    console.warn(`[agent] switchToSession: will start fresh (resume skipped: ${resumeDecision.reason})`);
  }

  // Update agentDir from session
  if (sessionMeta.agentDir) {
    agentDir = sessionMeta.agentDir;
  }

  if (agentDir && !isExternalRuntime(getCurrentRuntimeType())) {
    try {
      const { resolveWorkspaceConfig } = await import('./utils/admin-config');
      const resolved = resolveWorkspaceConfig(agentDir, sessionMeta, { includeMcp: false });
      if (resolved.permissionMode) {
        if (resolved.permissionMode !== configState.currentPermissionMode) {
          console.log(`[agent] switchToSession: restored permissionMode=${resolved.permissionMode}`);
        }
        // configState.prePlanPermissionMode belonged to the PREVIOUS session — reset on switch so a
        // later ExitPlanMode / SDK-status exit restores THIS session's fallback, not the
        // prior session's mode (codex review). Safe: switchToSession early-returns when
        // targetSessionId === sessionId, so this never drops the current session's capture.
        const restored = computeRestoredPlanState(resolved.permissionMode as PermissionMode);
        setPermissionPlanState(restored);
      }
      // #300: also restore model + provider env from the TARGET session's snapshot.
      // Previously only permissionMode was restored, so the pre-warm scheduled below
      // spawned the switched-to session's subprocess carrying the PREVIOUS session's
      // configState.currentModel / configState.currentProviderEnv (e.g. a deepseek session's env bleeding into
      // a skywork session). Replace unconditionally so the prior session's values
      // never leak. Fail closed on the env: when the pinned providerId no longer
      // resolves, `resolved.providerEnv` is undefined and we clear it rather than keep
      // the prior session's credentials. The renderer's per-message providerEnv + model
      // push still override on send for desktop Tabs; this fixes the headless/pre-warm
      // window and any non-renderer caller.
      configSetModel(resolved.model);
      configSetProviderEnv(resolved.providerEnv);
      // #324: restore reasoning effort with the same unconditional-replace
      // rationale as model/env — otherwise the prior session's effort leaks
      // into this session's next query() spawn.
      configSetReasoningEffort(normalizeReasoningEffort(resolved.reasoningEffort));
      console.log(`[agent] switchToSession: restored model=${resolved.model ?? 'default'}, provider=${resolved.providerEnv?.baseUrl ?? 'subscription/none'}, effort=${configState.currentReasoningEffort ?? 'default'}`);
    } catch (error) {
      console.warn('[agent] switchToSession: config self-resolution failed:', error);
    }
  }

  // Initialize logger for the target session (lazy file creation)
  initLogger(sessionId);

  // Session already exists, skip first-message session creation logic
  hasInitialPrompt = true;

  console.log(`[agent] switchToSession: ready, agentDir=${agentDir}, sessionRegistered=${sessionRegistered}`);

  // Pre-warm with resumed session so subprocess + MCP are ready before user types
  schedulePreWarm();
  return true;
  });
}

/**
 * Apply runtime configuration changes to the active session.
 * Calls SDK setModel/setPermissionMode if config has changed.
 */
async function applySessionConfig(newModel?: string, newPermissionMode?: PermissionMode, newReasoningEffort?: string): Promise<void> {
  if (!lifecycleState.query) {
    return;
  }

  // Apply permission mode change if different
  if (newPermissionMode && newPermissionMode !== configState.currentPermissionMode) {
    const sdkMode = mapToEffectiveSdkPermissionMode(newPermissionMode, currentScenario);
    try {
      await lifecycleState.query.setPermissionMode(sdkMode);
      // Route through the shared transition so a config-driven switch keeps the
      // plan capture/restore invariant: switching INTO plan captures the prior
      // mode (so ExitPlanMode can restore it), switching to a non-plan mode
      // clears the capture. Previously this set configState.currentPermissionMode directly
      // and only refreshed configState.prePlanPermissionMode when it was already set — so a
      // config path that entered plan from a non-plan mode never captured one
      // (same deadlock class as the UI toggle).
      const next = applyPermissionModeSelection(configState.currentPermissionMode, configState.prePlanPermissionMode, newPermissionMode);
      setPermissionPlanState(next);
      console.log(`[agent] runtime permission mode switched to: ${configState.currentPermissionMode} (SDK: ${sdkMode}, prePlan=${configState.prePlanPermissionMode ?? 'none'})`);
    } catch (error) {
      console.error('[agent] failed to set permission mode:', error);
    }
  }

  // Drain any in-flight setModel from a prior `setSessionModel(...)` BEFORE
  // we look at the short-circuit. Without this, the "click M2 in the model
  // picker, immediately click Send" sequence races: setSessionModel updated
  // `configState.currentModel` synchronously and fired setModel without awaiting, so the
  // short-circuit `newModel === configState.currentModel` returns true before the SDK
  // subprocess has swapped — the next SDK turn runs on the OLD model. Awaiting
  // the registered promise gives the SDK time to ack. (Codex review 2026-05-07.)
  if (pendingSetModelPromise) {
    try {
      await pendingSetModelPromise;
    } catch {
      // dispatchSetModelToSdk already logged; we still want to proceed —
      // a stale setModel failure doesn't block the rest of config sync.
    }
  }

  // #324 — apply reasoning-effort change from the send payload (the desktop
  // /api/reasoning-effort/set push normally lands first; this is the
  // send-time safety net, mirroring the model parameter below). `undefined`
  // means "not provided" (cron/IM callers) → leave the current value alone.
  // OpenAI-protocol: state write only, the bridge resolver reads it live.
  // Anthropic protocol: query()-spawn option → restart with resume (same
  // shape as the aliasEnvChanged branch below; sessionRegistered makes the
  // next spawn resume, so no context loss).
  if (newReasoningEffort !== undefined) {
    const normalizedEffort = normalizeReasoningEffort(newReasoningEffort);
    if (normalizedEffort !== configState.currentReasoningEffort) {
      configSetReasoningEffort(normalizedEffort);
      if (configState.currentProviderEnv?.apiProtocol !== 'openai') {
        // Carry a simultaneous model change along — the restarted subprocess
        // spawns from configState.currentModel, so updating it here covers both knobs in
        // one respawn.
        if (newModel && newModel !== configState.currentModel) {
          configSetModel(newModel);
        }
        console.log(`[agent] reasoning effort changed at send (${normalizedEffort ?? 'default'}) -> restarting session to reapply query() effort`);
        abortPersistentSession();
        await awaitSessionTermination(10_000, 'applySessionConfig/reasoningEffortChange');
        setQuerySession(null);
        setSessionProcessing(false);
        setSessionState('idle');
        resetAbortFlag();
        return;
      }
      console.log(`[agent] reasoning effort changed at send (${normalizedEffort ?? 'default'}) -> live bridge update (openai protocol)`);
    }
  }

  // Apply model change if different. Same wrap rationale as setSessionModel():
  // setModel() on the live SDK subprocess updates the model fed into
  // getContextWindowForModel() on subsequent turns, so 1M-window models need
  // the [1m] tag here too. Routed through dispatchSetModelToSdk so any later
  // applySessionConfig invocation that runs concurrently also drains via
  // pendingSetModelPromise.
  if (newModel && newModel !== configState.currentModel) {
    const aliasEnvChanged = modelAliasEnvChangesForModel(configState.currentProviderEnv?.modelAliases, configState.currentModel, newModel);
    try {
      if (aliasEnvChanged) {
        const oldModel = configState.currentModel;
        configSetModel(newModel);
        console.log(`[agent] runtime model aliases changed (${oldModel ?? 'undefined'} -> ${newModel}) -> restarting session to reinject ANTHROPIC_DEFAULT_*_MODEL`);
        abortPersistentSession();
        await awaitSessionTermination(10_000, 'applySessionConfig/modelAliasChange');
        setQuerySession(null);
        setSessionProcessing(false);
        setSessionState('idle');
        resetAbortFlag();
        return;
      }
      await dispatchSetModelToSdk(newModel);
      configSetModel(newModel);
      console.log(`[agent] runtime model switched to: ${newModel}`);
    } catch (error) {
      console.error('[agent] failed to set model:', error);
    }
  }
}

export type EnqueueResult = {
  queued: boolean;   // true if message was queued (not immediately processed)
  queueId?: string;  // stable queue/turn ID when the message was accepted
  /**
   * (v0.2.12) When queued=true, indicates whether this item became the
   * in-flight one (yielded immediately to CLI subprocess) or stayed in
   * queueState.pendingMidTurnQueue (still cancellable). Frontend uses this to set
   * the initial `isInFlight` flag on the optimistic queue pill so the
   * UI can label it as already handed to SDK from the very first paint,
   * before the SSE `queue:added` round-trip completes.
   */
  isInFlight?: boolean;
  deliveryMode?: DesktopDeliveryMode;
  error?: string;    // present when queue is full or other rejection
  dispatchAcceptance?: Promise<{ accepted: boolean; error?: string }>;
};

async function enqueueWatchdogResumeReminderAtQueueFront(
  sessionIdSnapshot: string,
): Promise<EnqueueResult> {
  const trimmed = WATCHDOG_RESUME_REMINDER;
  resetTurnUsage();
  setCurrentTurnStartTime(Date.now());

  const userMessage: MessageWire = {
    id: allocateMessageId(),
    role: 'user',
    content: trimmed,
    timestamp: new Date().toISOString(),
  };
  appendMessage(userMessage);
  broadcast('chat:message-replay', createLiveUserMessageReplay(sessionId, userMessage));
  await persistMessagesToStorage();

  // Cross-review (#0.2.29) — a `switchToSession` can land inside the await
  // above (it runs `clearMessageState()` + reassigns module-level `sessionId`).
  // If it did, unshifting this reminder into `queueState.messageQueue` and starting a
  // stream now would inject the ORIGINAL session's reminder into the NEW
  // session and start streaming on it. Bail with an error BEFORE any queue
  // mutation so the caller (`consumePendingContinueAfterAbort`) preserves the
  // original session's pendingContinueAfterAbort flag for retry — same rationale
  // as the post-await sessionId guard the caller already applies to the
  // recursive enqueue path.
  if (sessionId !== sessionIdSnapshot) {
    console.error(`[agent] Watchdog auto-resume reminder raced session switch ${sessionIdSnapshot} -> ${sessionId}; aborting reminder injection, flag preserved for retry`);
    return { queued: false, error: 'session switched during watchdog reminder persist' };
  }

  clearChannelDeliveryState();

  const queueItem: MessageQueueItem = {
    id: randomUUID(),
    message: { role: 'user', content: [{ type: 'text', text: trimmed }] },
    messageText: trimmed,
    wasQueued: false,
    resolve: () => {},
    providerAnalytics: buildTurnProviderAnalytics(configState.currentProviderEnv),
    channelDelivery: SESSION_BOUND_CHANNEL_DELIVERY,
  };

  console.log('[agent] Watchdog auto-resume inserted reminder at recovery queue front');
  resetPreWarmFailCount();
  unshiftMessage(queueItem);
  setSessionState((lifecycleState.systemInitInfo || lifecycleState.sdkControlReady) ? 'running' : 'starting');
  setTimeout(() => {
    startStreamingSession().catch((error) => {
      console.error('[agent] failed to start watchdog auto-resume session', error);
    });
  }, 0);

  return { queued: false };
}

async function consumePendingContinueAfterAbort(
  sessionIdSnapshot: string,
  permissionMode: PermissionMode | undefined,
  model: string | undefined,
  providerEnv: ProviderEnv | 'subscription' | undefined,
  reasoningEffort: string | undefined,
  trigger: 'next-enqueue' | 'watchdog-auto',
  allowMissingPendingFlag = false,
): Promise<boolean> {
  const meta = getSessionMetadata(sessionIdSnapshot);
  const hasPendingContinue = Boolean(meta?.pendingContinueAfterAbort || allowMissingPendingFlag);
  const alreadyConsuming = consumingPendingContinueSessions.has(sessionIdSnapshot);
  const alreadyAutoResumed = autoResumeInjectedSessions.has(sessionIdSnapshot);
  const scheduledAutoResume = scheduledWatchdogAutoResumeSessions.has(sessionIdSnapshot);
  if (shouldAdoptPendingContinueIntoScheduledAutoResume({
    trigger,
    pendingContinueAfterAbort: hasPendingContinue,
    sessionTerminating: lifecycleState.abortRequested,
    consuming: alreadyConsuming,
    alreadyAutoResumed,
    scheduledAutoResume,
  })) {
    console.log(`[agent] ${trigger}: adopting pendingContinueAfterAbort into scheduled watchdog auto-resume for terminating session ${sessionIdSnapshot}`);
    scheduleWatchdogAutoResumeAfterAbort(sessionIdSnapshot, {
      allowMissingPendingFlag,
    });
    return false;
  }

  const deferToScheduledAutoResume = shouldDeferPendingContinueToScheduledAutoResume({
    trigger,
    scheduledAutoResume,
  });
  if (!shouldConsumePendingContinueAfterAbort({
    pendingContinueAfterAbort: hasPendingContinue,
    consuming: alreadyConsuming,
    alreadyAutoResumed,
    deferToScheduledAutoResume,
  })) {
    if (deferToScheduledAutoResume) {
      console.log(`[agent] ${trigger}: pendingContinueAfterAbort deferred to scheduled watchdog auto-resume for session ${sessionIdSnapshot}`);
    }
    return false;
  }

  consumingPendingContinueSessions.add(sessionIdSnapshot); // sync test-and-set
  try {
    console.log(`[agent] ${trigger}: consuming pendingContinueAfterAbort for session ${sessionIdSnapshot}, injecting reminder turn`);
    const reminderResult = shouldPrependWatchdogAutoResume({
      sessionActive: isSessionActive(),
      sessionTerminating: lifecycleState.abortRequested,
    })
      ? await enqueueWatchdogResumeReminderAtQueueFront(sessionIdSnapshot)
      : await enqueueUserMessage(
          WATCHDOG_RESUME_REMINDER,
          undefined,        // images
          permissionMode,   // inherit caller/current permission mode
          model,            // inherit caller/current model
          providerEnv,      // inherit caller/current provider env
          reasoningEffort,  // inherit caller/current reasoning effort
          undefined,        // metadata - synthetic, no source attribution
          undefined,        // requestId - synthetic, no IM trace
          undefined,        // inboxMeta - synthetic, no inbox pushback
          undefined,        // analyticsSource - keep current attribution
          undefined,        // analyticsOrigin - keep current attribution
          { channelDelivery: SESSION_BOUND_CHANNEL_DELIVERY },
        );

    if (sessionId !== sessionIdSnapshot) {
      // switchToSession raced between our call and the recursive enqueue's
      // session-mutation barrier wait — reminder went to the new session. Preserve the
      // original session's flag for retry; do NOT clear it or mark the
      // per-process cap.
      console.error(`[agent] Reminder enqueue raced session switch ${sessionIdSnapshot} -> ${sessionId}; flag for ${sessionIdSnapshot} preserved for retry`);
      return false;
    }

    if (reminderResult.error) {
      // Queue rejection — preserve flag for retry, same rationale.
      console.error(`[agent] Reminder enqueue rejected (${reminderResult.error}); flag for ${sessionIdSnapshot} preserved for retry`);
      return false;
    }

    // Success path — reminder is in the right session's queue. The same-process
    // cap is authoritative after accept; clearing the disk crash-fallback flag
    // is best-effort, because a write failure must not allow duplicate reminder
    // injection in this process.
    autoResumeInjectedSessions.add(sessionIdSnapshot);
    try {
      const updated = await updateSessionMetadata(sessionIdSnapshot, { pendingContinueAfterAbort: false });
      if (!updated || updated.pendingContinueAfterAbort) {
        console.error(`[agent] Failed to clear pendingContinueAfterAbort for session ${sessionIdSnapshot}; same-process cap remains active`);
      }
    } catch (e) {
      console.error(`[agent] Failed to clear pendingContinueAfterAbort for session ${sessionIdSnapshot}; same-process cap remains active`, e);
    }
    return true;
  } catch (e) {
    console.error('[agent] Failed to inject Continue reminder turn:', e);
    return false;
  } finally {
    consumingPendingContinueSessions.delete(sessionIdSnapshot);
  }
}

function scheduleWatchdogAutoResumeAfterAbort(
  sessionIdSnapshot: string,
  opts: { allowMissingPendingFlag?: boolean } = {},
): void {
  scheduledWatchdogAutoResumeSessions.add(sessionIdSnapshot);
  console.log(`[agent] Watchdog: scheduling auto-resume for session ${sessionIdSnapshot} after abort`);
  void (async () => {
    try {
      await awaitSessionTermination(10_000, 'watchdogAutoResume');
      if (sessionId !== sessionIdSnapshot) {
        console.warn(`[agent] Watchdog auto-resume skipped: session switched ${sessionIdSnapshot} -> ${sessionId}`);
        return;
      }

      // The abort flag belongs to the SDK subprocess that just terminated.
      // Clear it before the synthetic turn enters enqueueUserMessage, otherwise
      // the reminder is treated as a mid-abort queued item and waits for an
      // unrelated future recovery trigger.
      resetAbortFlag();

      const consumed = await consumePendingContinueAfterAbort(
        sessionIdSnapshot,
        configState.currentPermissionMode,
        configState.currentModel,
        undefined, // undefined means "keep current provider env"
        undefined, // undefined means "keep current reasoning effort"
        'watchdog-auto',
        opts.allowMissingPendingFlag === true,
      );
      if (!consumed) {
        console.log(`[agent] Watchdog auto-resume skipped: no consumable pending flag for session ${sessionIdSnapshot}`);
      }
    } catch (e) {
      console.error('[agent] Watchdog auto-resume failed:', e);
    } finally {
      scheduledWatchdogAutoResumeSessions.delete(sessionIdSnapshot);
    }
  })();
}

/** Recover or reject the exact persisted builtin rewind intent before Runtime use. */
async function resolvePendingBuiltinConversationMutationForActiveSession(): Promise<void> {
  const productSessionId = sessionId;
  const metadata = getSessionMetadata(productSessionId);
  const intent = metadata?.pendingConversationMutation;
  if (!intent) return;
  if (intent.kind !== 'builtin-rewind') {
    throw new Error(`[agent] refusing builtin Runtime for ${productSessionId}: incompatible pending conversation mutation`);
  }

  const resolved = await resolvePendingConversationMutation(productSessionId);
  if (!resolved.success) {
    throw new Error(
      `[agent] refusing builtin Runtime for ${productSessionId}: pending conversation mutation could not recover: ${resolved.error}`,
    );
  }
  if (sessionId !== productSessionId) {
    throw new Error(
      `[agent] refusing recovered conversation mutation after Product Session changed from ${productSessionId} to ${sessionId}`,
    );
  }

  clearCurrentSessionUuids();
  clearLiveSessionUuids();
  loadTranscriptFromSessionMessages(resolved.messages, resolved.cursor);
  if (resolved.metadata.sdkSessionId === intent.replacementSdkSessionId) {
    sessionRegistered = false;
    pendingResumeSessionAt = undefined;
    setPendingReloadAnchor(undefined);
  }
}

export async function enqueueUserMessage(
  text: string,
  images?: ImagePayload[],
  permissionMode?: PermissionMode,
  model?: string,
  providerEnv?: ProviderEnv | 'subscription',
  // #324 — reasoning effort setting ('default' | level). undefined = caller
  // doesn't manage effort (cron/IM/heartbeat) → current session value stays.
  reasoningEffort?: string,
  metadata?: { source: SessionSource; sourceId?: string; senderName?: string },
  // Pattern A — IM trace ID. Forwarded from /api/im/chat (Rust generates at edge).
  // Desktop / cron / heartbeat callers omit this — those paths get no IM identity.
  requestId?: string,
  // PRD 0.2.18 Session Inbox — inbox metadata for cross-session transcriptState.messages.
  // Present when message came in via /api/inbox/drain (caller sent through
  // `myagents session send`). Carries reply-back instruction + caller identity;
  // bound per-turn at generator yield, read at result handler for reply pushback.
  inboxMeta?: import('./inbox/types').InboxTurnMeta,
  analyticsSource?: TurnAnalyticsSource,
  analyticsOrigin?: SessionOrigin,
  options?: {
    fromDesktopChatSend?: boolean;
    queueId?: string;
    turnOwner?: TurnOwner;
    onTerminal?: TurnTerminalObserver;
    allowLazySessionMaterialization?: boolean;
    sessionBirthOrigin?: SessionOrigin;
    queueResponseModeOverride?: 'realtime' | 'turn';
    /** Infrastructure-only gate after Query-changing config, before user/session persistence. */
    beforeUserPersistence?: import('./session-core/turn-queue').DispatchGuard;
    beforeDispatch?: import('./session-core/turn-queue').DispatchGuard;
    channelDelivery: TurnChannelDelivery;
  },
): Promise<EnqueueResult> {
  const trimmed = text.trim();
  const hasImages = images && images.length > 0;

  if (!trimmed && !hasImages) {
    return { queued: false };
  }

  const canLazyMaterializeForThisMessage = () =>
    isLazySessionMaterializationAllowed() || options?.allowLazySessionMaterialization === true;
  if (!options?.channelDelivery) {
    return { queued: false, error: 'Missing explicit channel delivery ownership' };
  }
  const channelDelivery = options.channelDelivery;

  try {
    const globalSkillInventory = createGlobalSkillInventorySnapshot();
    const desiredCapabilities = resolveEffectiveProjectCapabilities(agentDir, { globalSkillInventory });
    const disabledCapability = findDisabledCapabilityForSlashInput(trimmed, desiredCapabilities);
    if (disabledCapability) {
      return {
        queued: false,
        error: `/${disabledCapability.canonicalName} is disabled for this workspace`,
      };
    }
    const currentCapabilities = configState.currentCapabilitySnapshot;
    let projectionChanged = false;
    if (
      lifecycleState.query
      && currentCapabilities
      && !isTurnInFlight()
      && (currentCapabilities.revision !== desiredCapabilities.revision
        || currentCapabilities.integrityRevision !== desiredCapabilities.integrityRevision)
    ) {
      projectionChanged = trySyncProjectUserConfigFiles(agentDir, {
        globalSkillInventory,
        capabilitySnapshot: desiredCapabilities,
      }, 'skill-sync').changed;
      if (currentCapabilities.revision === desiredCapabilities.revision && !projectionChanged) {
        configState.currentCapabilitySnapshot = desiredCapabilities;
      }
    }
    if (
      lifecycleState.query
      && (currentCapabilities?.revision !== desiredCapabilities.revision || projectionChanged)
    ) {
      scheduleDeferredRestart('capabilities');
      // Quiescent/pre-warmed Queries are replaced immediately. During a turn,
      // the latch is drained by the terminal owner and the queued message is
      // dispatched only by the replacement Query.
      applyDeferredRestartIfNeeded();
    }
  } catch (error) {
    return {
      queued: false,
      error: `Workspace capabilities are unavailable: ${error instanceof Error ? error.message : String(error)}`,
    };
  }

  const queueId = options?.queueId ?? randomUUID();
  const deferVisibleAdmission = options?.beforeUserPersistence !== undefined;
  let settleDispatchAcceptance: ((result: { accepted: boolean; error?: string }) => void) | undefined;
  const dispatchAcceptance = options?.beforeDispatch
    ? new Promise<{ accepted: boolean; error?: string }>((resolve) => {
        settleDispatchAcceptance = resolve;
      })
    : undefined;
  const effectiveQueueSource = metadata?.source ?? currentScenario.type;
  const queueResponseMode = options?.queueResponseModeOverride ?? resolveChatQueueResponseMode(
    loadAdminConfig().chatQueueResponseMode,
    options?.fromDesktopChatSend,
  );
  const providerRetryPending = transientProviderRetryTimer !== null;
  const MAX_QUEUE_SIZE = 10;
  const initialAdmissionBusy = isTurnInFlight()
    || lifecycleState.abortRequested
    || isInterruptingResponse
    || providerRetryPending
    || hasQueuedOrInFlightWork()
    || queueState.promotedItemInFlight;
  let keepTurnAdmissionTicketUntilGenerator = false;
  let reservedTurnBoundaryItem: TurnBoundaryQueueItem | null = null;
  let reservedAdmissionAction: QueueAdmissionAction | null = null;
  let admissionTicket: import('./builtin-session/types').TurnAdmissionTicket | null = null;
  const infrastructureTransitionReservation = options?.beforeUserPersistence
    && (getSessionMutationBarrier() !== null || rewindPromise !== null)
    && getTurnAdmissionTicket() === null;
  if (
    queueResponseMode === 'turn'
    && (!initialAdmissionBusy || infrastructureTransitionReservation || deferVisibleAdmission)
  ) {
    if (deferVisibleAdmission && initialAdmissionBusy && !infrastructureTransitionReservation) {
      if (queuedWorkCount() >= MAX_QUEUE_SIZE) {
        return { queued: false, error: `Queue full (max ${MAX_QUEUE_SIZE})` };
      }
    }
    admissionTicket = {
      queueId,
      requestId,
      createdAt: Date.now(),
      messageText: trimmed,
      turnOwner: options?.turnOwner,
      onTerminal: options?.onTerminal,
      beforeUserPersistence: options?.beforeUserPersistence,
      beforeDispatch: options?.beforeDispatch,
      settleDispatchAcceptance,
      canceled: false,
    };
    if (deferVisibleAdmission && initialAdmissionBusy && !infrastructureTransitionReservation) {
      reservedAdmissionAction = 'turn-boundary';
      reservedTurnBoundaryItem = {
        queueId,
        ready: false,
        admissionTicket,
        messageText: trimmed,
        requestId,
      };
      pushTurnBoundary(reservedTurnBoundaryItem);
    } else {
      setTurnAdmissionTicket(admissionTicket);
    }
  }

  try {
  // Register the turn admission ticket above before waiting on reset/rewind.
  // Goal/Task cancellation can therefore abort both MCP fences while the
  // session transition is still in progress, before any metadata can change.
  const sessionMutationBarrier = getSessionMutationBarrier();
  if (sessionMutationBarrier) {
    console.log('[agent] enqueueUserMessage: waiting for session reset to complete...');
    await sessionMutationBarrier;
    console.log('[agent] enqueueUserMessage: session reset completed, proceeding');
  }

  if (rewindPromise) {
    await rewindPromise;
  }
  await resolvePendingBuiltinConversationMutationForActiveSession();
  if (admissionTicket?.canceled) {
    return { queued: false, error: 'Queue item was cancelled before dispatch' };
  }
  if (!hasInitialPrompt && !canLazyMaterializeForThisMessage() && !getSessionMetadata(sessionId)) {
    throw new Error(`[agent] refusing first message for unindexed existing session ${sessionId}; session metadata disappeared before first user turn`);
  }

  // ─── DELAYED CONTINUE (consume flag) ──────────────────────────────────
  // If the previous turn on this session was aborted by the inactivity
  // watchdog *and* produced real model output, the SessionMetadata
  // carries `pendingContinueAfterAbort=true`. Inject one system-reminder
  // user-turn *before* the caller's actual message on crash/retry fallback.
  // When the same-process scheduled auto-resume owns the flag, this path
  // intentionally defers so the post-teardown task can prepend the reminder
  // ahead of any rescued manual transcriptState.messages.
  //
  // Invariants (cross-review hardened):
  //
  //  1. `sessionIdSnapshot` captures module-level sessionId SYNCHRONOUSLY
  //     before any await. Without this, a concurrent `switchToSession`
  //     could mutate sessionId across the await in updateSessionMetadata
  //     or the recursive enqueue — clearing the flag and/or sending the
  //     reminder against the wrong session.
  //
  //  2. `consumingPendingContinueSessions` is a PER-SESSION lock, not
  //     global. Two different sessions consuming their own flags
  //     concurrently must not block each other.
  //
  //  3. Accept-on-SUCCESS — per-process cap is marked after the reminder
  //     enqueue succeeds AND we verify no session switch raced through. The
  //     disk flag is then cleared best-effort; if that write fails, the cap
  //     still prevents same-process duplicate reminders. If the enqueue rejects
  //     (queue full) or `sessionId !== sessionIdSnapshot` post-await, leave the
  //     flag set so the next legit enqueue on the original session re-attempts.
  //
  //  4. The recursive `enqueueUserMessage` itself awaits the session-mutation barrier,
  //     so a switchToSession running between this call and the recursive
  //     entry is serialized. But it would then route the reminder to
  //     the NEW session — which is wrong. The post-await sessionId
  //     check catches that case; we can't un-enqueue the reminder but
  //     we MUST preserve the original session's flag for retry.
  const sessionIdSnapshot = sessionId;
  // Infrastructure-owned injected turns have their own prompt and admission
  // transaction. They must never consume the prior foreground turn's delayed
  // continue flag: doing so recursively persisted/broadcast an unfenced
  // reminder before the injected turn's MCP preflight. Leave the flag for the
  // next ordinary user enqueue, which is the owner the watchdog intended.
  if (!options?.beforeUserPersistence) {
    await consumePendingContinueAfterAbort(
      sessionIdSnapshot,
      permissionMode,
      model,
      providerEnv,
      reasoningEffort,
      'next-enqueue',
    );
  }
  if (admissionTicket?.canceled) {
    return { queued: false, error: 'Queue item was cancelled before dispatch' };
  }
  const holdForWatchdogRecovery = scheduledWatchdogAutoResumeSessions.has(sessionIdSnapshot)
    || getMessageQueue().some(item => item.messageText === WATCHDOG_RESUME_REMINDER);

  // Session is "busy" if AI is streaming OR there are pending transcriptState.messages in
  // any of the three queues. This prevents config changes and turn-usage
  // resets during the brief gap between turns.
  //
  // MUST include queueState.pendingMidTurnQueue (v0.2.11 cross-bugfix #142 review-fix #2):
  // when a turn ends and handleMessageComplete is preparing to promote the next
  // pending item, there's a window where isTurnInFlight() is false and
  // queueState.messageQueue is empty, but queueState.pendingMidTurnQueue still holds items. Without
  // this guard a new enqueue would slip into the direct-send path and break
  // the user's expected ordering (queued items run first).
  //
  // Isolation note: realtime mode intentionally preserves the existing
  // "fastest SDK consumption" admission semantics. Turn mode gets a tiny
  // synchronous admission ticket above, so a rapid second desktop send sees
  // the first admitted direct turn as busy even before generator yield.
  const isSessionBusy = isTurnInFlight()
    || lifecycleState.abortRequested
    || isInterruptingResponse
    || providerRetryPending
    || hasQueuedOrInFlightWork(queueId)
    || queueState.promotedItemInFlight;
  emitPerfTrace({
    trace: 'turn',
    phase: 'enqueue',
    sessionId: sessionId || undefined,
    requestId,
    runtime: 'builtin',
    status: 'ok',
    sizeBytes: Buffer.byteLength(trimmed, 'utf8'),
    detail: {
      busy: isSessionBusy,
      source: effectiveQueueSource,
      queueResponseMode,
      hasImages: !!hasImages,
    },
  });

  // Reset turn usage tracking — only for direct (non-queued) transcriptState.messages.
  // For queued transcriptState.messages, this is done in messageGenerator when the item is yielded,
  // to avoid corrupting the in-flight turn's usage counters.
  if (!isSessionBusy) {
    resetTurnUsage();
    setCurrentTurnStartTime(Date.now());
  }

  // Provider env semantics (pit-of-success pattern — safe default for all callers):
  //   undefined        → "no change, keep current provider" (IM/Task/Heartbeat/internal callers)
  //   'subscription'   → "switch to Anthropic subscription" (only from desktop)
  //   ProviderEnv obj  → "use this specific provider" (desktop or Rust with explicit provider)
  // This prevents IM/Task callers from accidentally triggering subscription switch
  // when they simply don't have provider info to forward (the original "Not logged in" bug).
  const effectiveProviderEnv: ProviderEnv | undefined = providerEnv === undefined
    ? configState.currentProviderEnv                                         // undefined → keep current (safe default)
    : (providerEnv === 'subscription' ? undefined : providerEnv); // 'subscription' → clear, object → use it
  const turnProviderAnalytics = buildTurnProviderAnalytics(
    isSessionBusy ? configState.currentProviderEnv : effectiveProviderEnv,
  );

  // Check if provider has changed (requires session restart since environment vars can't be updated)
  // SKIP for queued transcriptState.messages: provider/model changes during streaming would cause a session
  // restart that wipes the queue and races with the active stream. Queued transcriptState.messages inherit
  // the current session's provider/model configuration.
  const providerChanged = !isSessionBusy && (
    providerEnv === 'subscription'
      ? configState.currentProviderEnv !== undefined
      : providerEnv !== undefined && !configProviderEnvEqual(configState.currentProviderEnv, effectiveProviderEnv)
  );
  const nextModel = model ?? configState.currentModel;
  const modelChanged = !isSessionBusy && model !== undefined && model !== configState.currentModel;
  const crossesProviderHistoryBoundary = !isSessionBusy
    && (providerChanged || modelChanged)
    && !canResumeAcrossBuiltinProviderHistory({
      currentProviderEnv: configState.currentProviderEnv,
      currentModel: configState.currentModel,
      nextProviderEnv: effectiveProviderEnv,
      nextModel,
    });

  if ((providerChanged || crossesProviderHistoryBoundary) && lifecycleState.query) {
    const fromLabel = configState.currentProviderEnv?.baseUrl ?? 'anthropic';
    const toLabel = effectiveProviderEnv?.baseUrl ?? 'anthropic';
    if (isDebugMode) console.log(`[agent] provider/history changed from ${fromLabel} to ${toLabel}, restarting session`);

    if (providerChanged) {
      // Update provider env BEFORE terminating so the new session picks it up
      configSetProviderEnv(effectiveProviderEnv); // undefined for subscription, object for API
      // PRD #124: keep bridge registration in sync (handles all provider transitions).
      ensureActiveSessionBridgeRegistered();
    }
    // Terminate current session - it will restart automatically when processing the message
    abortPersistentSession();
    // Wait for the current session to fully terminate before proceeding
    // This prevents race conditions where old session continues processing
    await awaitSessionTermination(10_000, 'enqueueUserMessage/providerChange');
    setQuerySession(null);
    setSessionProcessing(false);
    setSessionState('idle');
    // CRITICAL (v0.2.14 dogfood): the abort above set lifecycleState.abortRequested=true
    // to terminate the OLD pre-warmed session. Once awaitSessionTermination
    // confirms the old session is gone, the flag has done its job — but
    // leaving it set leaks across the next message. The user's freshly
    // enqueued message (added below) gets scheduled into startStreamingSession
    // via setTimeout(0); that function's pre-launch abort guard
    // (`lifecycleState.abortRequested && !preWarm`) then fires "aborted pre-launch by
    // stop during starting" and drains the just-enqueued message — exactly
    // the silent-fail manifest in the dogfood log when the user changed
    // their model from a third-party provider to Anthropic and sent a
    // message in the same beat. Reset here, NOT after the message-enqueue
    // below, so the guard sees a clean slate.
    resetAbortFlag();
    // Explicit cancel — broadcasts queue:cancelled so frontend clears stale pills
    // before the new message (added below) fires queue:added. Without this, the UI
    // would show old pills as phantoms alongside the new one.
    //
    // Turn-mode direct admission is different: no queued work existed when
    // the ticket was created, and any queueState.turnBoundaryQueue item that appears
    // during awaitSessionTermination is a legitimate rapid second send behind
    // this ticket. Do not drain that new work as if it belonged to the dead
    // provider session.
    if (getTurnAdmissionTicket()?.queueId === queueId) {
      console.log('[agent] provider/history restart preserving turn-mode admission queue');
    } else {
      drainQueueWithCancellation();
    }
    // Clear stream state mappings (will be rebuilt by new session)
    streamIndexToToolId.clear();
    toolResultIndexToId.clear();
    imTextBlockIndices.clear();

    if (crossesProviderHistoryBoundary) {
      await resetForProviderHistoryBoundary();
      console.log('[agent] Fresh session: provider history boundary changed');
    }

    if (isDebugMode) console.log(`[agent] session terminated for provider switch`);
  } else if (providerChanged || crossesProviderHistoryBoundary) {
    if (crossesProviderHistoryBoundary) {
      await resetForProviderHistoryBoundary();
      console.log('[agent] Fresh session: provider history boundary changed');
    }
    if (providerChanged) {
      configSetProviderEnv(effectiveProviderEnv);
      ensureActiveSessionBridgeRegistered();
      if (isDebugMode) console.log(`[agent] provider env changed without active query: baseUrl=${effectiveProviderEnv?.baseUrl ?? 'anthropic'}`);
    }
  } else if (effectiveProviderEnv) {
    // Provider not changed (or first message with API provider), just update tracking
    configSetProviderEnv(effectiveProviderEnv);
    if (isDebugMode) console.log(`[agent] provider env set: baseUrl=${effectiveProviderEnv.baseUrl ?? 'anthropic'}`);
  } else if (!effectiveProviderEnv && !configState.currentProviderEnv) {
    // Both undefined — subscription mode, no change needed
    if (isDebugMode) console.log('[agent] subscription mode, no provider env');
  }

  // Apply runtime config changes if session is active (model/permission changes don't require restart)
  // Skip for queued transcriptState.messages — config is locked to the current session while streaming
  if (!isSessionBusy) {
    await applySessionConfig(model, permissionMode, reasoningEffort);

    // Update local tracking even if SDK call is skipped (e.g., first message before pre-warm).
    // Same shared transition as applySessionConfig so a first-message payload of
    // 'plan' captures the prior mode instead of leaving the restore target empty.
    if (permissionMode && permissionMode !== configState.currentPermissionMode) {
      const next = applyPermissionModeSelection(configState.currentPermissionMode, configState.prePlanPermissionMode, permissionMode);
      setPermissionPlanState(next);
      if (isDebugMode) console.log(`[agent] permission mode set to: ${configState.currentPermissionMode} (prePlan=${configState.prePlanPermissionMode ?? 'none'})`);
    }
    if (model && model !== configState.currentModel) {
      configSetModel(model);
      if (isDebugMode) console.log(`[agent] model set to: ${model}`);
    }
    if (reasoningEffort !== undefined) {
      const normalizedEffort = normalizeReasoningEffort(reasoningEffort);
      if (normalizedEffort !== configState.currentReasoningEffort) {
        configSetReasoningEffort(normalizedEffort);
        if (isDebugMode) console.log(`[agent] reasoning effort set to: ${normalizedEffort ?? 'default'}`);
      }
    }
  } else if (lifecycleState.abortRequested) {
    // Session is being restarted (abort for MCP/agents config change). Stage permission/model
    // for the next session start. Without this, user's permission mode is lost during restart
    // and the next pre-warm uses the stale default (e.g., 'auto' instead of 'fullAgency').
    // Only update during abort — NOT during normal streaming or queued transcriptState.messages, to maintain
    // the "config locked while streaming" contract. canUseTool() reads configState.currentPermissionMode
    // live (line ~4081), so updating it mid-turn would change permission behavior unexpectedly.
    if (permissionMode && permissionMode !== configState.currentPermissionMode) {
      const next = applyPermissionModeSelection(configState.currentPermissionMode, configState.prePlanPermissionMode, permissionMode);
      setPermissionPlanState(next);
      if (isDebugMode) console.log(`[agent] permission mode staged for restart: ${configState.currentPermissionMode} (prePlan=${configState.prePlanPermissionMode ?? 'none'})`);
    }
    if (model && model !== configState.currentModel) {
      configSetModel(model);
      if (isDebugMode) console.log(`[agent] model staged for restart: ${model}`);
    }
    if (reasoningEffort !== undefined) {
      const normalizedEffort = normalizeReasoningEffort(reasoningEffort);
      if (normalizedEffort !== configState.currentReasoningEffort) {
        configSetReasoningEffort(normalizedEffort);
        if (isDebugMode) console.log(`[agent] reasoning effort staged for restart: ${normalizedEffort ?? 'default'}`);
      }
    }
  }

  if (admissionTicket?.canceled) {
    return { queued: false, error: 'Queue item was cancelled before dispatch' };
  }

  if (options?.beforeUserPersistence) {
    let persistenceGate: DispatchGuardResult;
    try {
      persistenceGate = await options.beforeUserPersistence();
    } catch (error) {
      persistenceGate = {
        accepted: false,
        error: error instanceof Error ? error.message : String(error),
      };
    }
    if (admissionTicket?.canceled) {
      return { queued: false, error: 'Queue item was cancelled before dispatch' };
    }
    if (!persistenceGate.accepted) {
      return {
        queued: false,
        error: persistenceGate.error ?? 'User message was rejected before persistence',
      };
    }
  }

  const deferredSessionMetadata = options?.beforeDispatch
    ? {
        scenario: currentScenario.type,
        origin: options.sessionBirthOrigin,
        allowLazyMaterialization: canLazyMaterializeForThisMessage(),
      }
    : undefined;
  if (!deferredSessionMetadata) {
    await persistSessionMetadataForAdmittedMessage(trimmed, {
      scenario: currentScenario.type,
      origin: options?.sessionBirthOrigin,
      allowLazyMaterialization: canLazyMaterializeForThisMessage(),
    });
  }

  if (admissionTicket?.canceled) {
    return { queued: false, error: 'Queue item was cancelled before dispatch' };
  }

  console.log(`[agent] enqueue user message len=${trimmed.length} images=${images?.length ?? 0} mode=${configState.currentPermissionMode}`);

  // Transition from pre-warm to active session.
  // CRITICAL: Only transition when the session is NOT being aborted. If lifecycleState.abortRequested
  // is true, the session is dying — mutating lifecycleState.preWarming here would "steal" the flag from
  // the startStreamingSession finally block, causing wasPreWarming to be false and both
  // recovery branches to miss. The message will be queued (isSessionBusy path below) and
  // processed by the next session after the finally block's schedulePreWarm fires.
  if (lifecycleState.preWarming && !lifecycleState.abortRequested && !options?.beforeDispatch) {
    setPreWarmInProgress(false);
    // Pre-warm 已收到 system_init → SDK 已注册此 session，后续必须用 resume
    if (lifecycleState.systemInitInfo) {
      await ensureSessionMetadataForSdkSystemInit(
        lifecycleState.systemInitInfo,
        getSystemInitAuthority(),
      );
      sessionRegistered = true;
    }
    console.log(`[agent] pre-warm → active, first user message, sessionRegistered=${sessionRegistered}`);
    // Replay buffered system_init so frontend gets tools/session info
    if (lifecycleState.systemInitInfo) {
      broadcast('chat:system-init', { info: lifecycleState.systemInitInfo, sessionId, runtime: 'builtin' });
    }
  }
  // Cancel any pending pre-warm timer (user is sending a message now).
  // BUT: when lifecycleState.abortRequested is true, the timer is the ONLY recovery mechanism
  // for restarting the session — don't cancel it. Messages will queue via isSessionBusy
  // path and be processed when the timer fires a new session.
  if (lifecycleState.preWarmTimer && !lifecycleState.abortRequested && !options?.beforeDispatch) {
    clearTimeout(lifecycleState.preWarmTimer);
    setPreWarmTimer(null);
  }
  if (admissionTicket?.canceled) {
    return { queued: false, error: 'Queue item was cancelled before dispatch' };
  }
  // (issue #174 — refined per cross-bugfix 2026-05-10)
  //
  // 'starting' = SDK subprocess still booting → UI shows "AI 启动中（首次启动
  //              可能较慢）" with the cold-start timer.
  // 'running'  = subprocess ready, turn executing → UI shows "思考中…".
  //
  // Original judge `lifecycleState.systemInitInfo ? 'running' : 'starting'` mislabels turns:
  // streamed `system_init` is per-turn metadata (QueryEngine yields it AFTER
  // processUserInput / skill loading), so a fully pre-warmed session running
  // a slow first turn (notably /context, 14 internal turns of local
  // computation, observed at 44s) sat in 'starting' for the entire turn.
  // The pre-warm path already drove `Query.initializationResult()` to set
  // `lifecycleState.sdkControlReady` once the SDK control plane finished its initialize
  // handshake, so use that as the actual subprocess-ready signal. Keep
  // `lifecycleState.systemInitInfo` as a fallback: if a session somehow received system_init
  // without lifecycleState.sdkControlReady having flipped (e.g., recovery paths that bypass
  // pre-warm), the per-turn metadata still proves the subprocess is alive.
  const takeAdmissionCallbacks = () => {
    const callbacks = {
      onTerminal: admissionTicket?.onTerminal ?? options?.onTerminal,
      settleDispatchAcceptance: admissionTicket?.settleDispatchAcceptance
        ?? settleDispatchAcceptance,
    };
    if (admissionTicket) {
      admissionTicket.onTerminal = undefined;
      admissionTicket.settleDispatchAcceptance = undefined;
    }
    return callbacks;
  };
  if (isSessionBusy && !holdForWatchdogRecovery) {
    if (!deferVisibleAdmission) {
      setSessionState((lifecycleState.systemInitInfo || lifecycleState.sdkControlReady) ? 'running' : 'starting');
    }
    if (!reservedTurnBoundaryItem && queuedWorkCount() >= MAX_QUEUE_SIZE) {
      return { queued: false, error: `Queue full (max ${MAX_QUEUE_SIZE})` };
    }
    const reservationAdmissionAction = reservedAdmissionAction ?? decideQueueAdmission({
      mode: queueResponseMode,
      busy: true,
      hasInFlight: queueState.inFlightToCliId !== null,
      hasScopedTurnBoundaryQueued: options?.fromDesktopChatSend === true
        && (getTurnBoundaryQueue().length > 0 || getTurnAdmissionTicket() !== null),
    });
    if (reservationAdmissionAction === 'turn-boundary' && !reservedTurnBoundaryItem) {
      reservedAdmissionAction = reservationAdmissionAction;
      reservedTurnBoundaryItem = {
        queueId,
        ready: false,
        messageText: trimmed,
        requestId,
      };
      pushTurnBoundary(reservedTurnBoundaryItem);
      console.log(`[agent] Reserved turn-boundary queue slot: queueId=${queueId} requestId=${requestId ?? '-'} text="${trimmed.slice(0, 50)}"`);
      if (!deferVisibleAdmission) {
        broadcast('queue:added', { queueId, messageText: trimmed.slice(0, 100), isInFlight: false, deliveryMode: 'turn' });
      }
    }
  }

  // Persist/adopt user image attachment records, then resolve refs at the
  // Sidecar runtime boundary. Renderer path drops send attachment refs, not
  // large base64 request bodies; legacy no-path File/paste fallback may still
  // arrive as inline base64 and is saved here.
  let resolvedImages: ResolvedImagePayload[] | undefined;
  let savedAttachments: MessageWire['attachments'] = [];
  if (hasImages) {
    try {
      savedAttachments = messageAttachmentsFromImagePayloads(sessionId, images);
      resolvedImages = resolveImagePayloads(sessionId, images);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error('[agent] Failed to resolve image attachments:', error);
      broadcast('chat:message-error', `图片处理失败：${message}`);
      return { queued: false, error: message };
    }
  }

  // Build multimodal content array for Claude API
  // Images are sent as base64-encoded source blocks.
  // media_type is narrowed to the Anthropic SDK literal union (exposed as
  // real types since claude-agent-sdk 0.2.86 added @anthropic-ai/sdk as a
  // direct dependency — prior versions erased it to `string`).
  type ImageMediaType = 'image/jpeg' | 'image/png' | 'image/gif' | 'image/webp';
  const contentBlocks: Array<
    | { type: 'text'; text: string }
    | { type: 'image'; source: { type: 'base64'; media_type: ImageMediaType; data: string } }
  > = [];

  // Modality gate. The full image array is still saved to disk above
  // (`savedAttachments`) so the UI message bubble shows what the user sent.
  // What we drop here is just the SDK content blocks for unsupported
  // modalities — the model never sees them. Defaults to allow when the model
  // is unknown (custom provider with no `inputModalities` set), per spec.
  // This is the authoritative filter point: IM Bot / Cron / Agent Channel
  // also flow through `enqueueUserMessage`, so frontend toasts are an
  // ergonomic enhancement, not the security boundary.
  //
  // We resolve against the message's intended model: caller-provided `model`
  // if any (this is the model that will actually run the turn — applied via
  // `applySessionConfig` further down on the non-busy path; on the queued/
  // busy path it's intentionally inherited rather than applied per existing
  // provider-env semantics, and `stripUnsupportedModalityBlocks` re-checks
  // at dequeue to catch any drift), otherwise the session's current model.
  const modelForFilter = model ?? configState.currentModel;
  const imagesAllowed = modelSupportsModality(modelForFilter, 'image');
  const filteredImageCount = hasImages && !imagesAllowed ? resolvedImages!.length : 0;

  // Mutable text payload — modality fallback (below) appends `@<path>`
  // references for images that can't go in as image content blocks. Title /
  // log / persistence continue to use the original `trimmed`.
  let effectiveText = trimmed;

  // Add images first so Claude can see them before the text query
  // Images are resized/sliced server-side to stay within API limits (≤1568px, long images → 1:2 tiles)
  if (hasImages && imagesAllowed) {
    for (const img of resolvedImages!) {
      let tiles: Awaited<ReturnType<typeof processImage>>;
      try {
        tiles = await processImage(img);
      } catch (err) {
        // Image too large or processing failed — notify user and inform Claude
        const friendly = classifyImageError(err);
        const raw = err instanceof Error ? err.message : String(err);
        console.warn(`[agent] processImage error for ${img.name}: ${raw}`);
        broadcast('chat:message-error', `图片 "${img.name}" 处理失败：${friendly}`);
        contentBlocks.push({ type: 'text', text: `[Image "${img.name}" omitted: ${friendly}]` });
        continue;
      }
      if (tiles.length > 1) {
        contentBlocks.push({
          type: 'text',
          text: `[The following ${tiles.length} images are consecutive tiles of the same long screenshot "${img.name}", arranged in reading order with slight overlap between adjacent tiles]`,
        });
      }
      for (const tile of tiles) {
        contentBlocks.push({
          type: 'image',
          source: {
            type: 'base64',
            // processImage() resizes into one of these 4 formats; upstream uploaders
            // also filter by the same set. Cast is safe because ImagePayload.mimeType
            // is declared as generic string at the utility layer.
            media_type: tile.mimeType as ImageMediaType,
            data: tile.data,
          },
        });
      }
    }
  } else if (hasImages && filteredImageCount > 0) {
    // Modality fallback (PRD prd_0.2.3_image_modality_file_fallback.md):
    // model lacks image support → write the images into `<agentDir>/myagents_files/`
    // and append `@<relative path>` to the user text so the model can choose
    // to Read them (or hand them to other tools). Mirrors the behaviour of
    // pasting non-image files in the Tab UI input. IM Bot path inherits this
    // automatically via the same enqueueUserMessage entry point.
    //
    // Failure path (disk full, agent not yet bound, etc.) reverts to the
    // legacy "synthetic text + chat:attachments-filtered" route so the SDK
    // still sees a non-empty user turn and the message isn't silently lost.
    let fallbackPaths: string[] = [];
    if (agentDir) {
      const targetDir = join(agentDir, 'myagents_files');
      try {
        const written = await writeBase64FilesToAgentDir(
          resolvedImages!.map((img) => ({ name: img.name, content: img.data })),
          targetDir,
          agentDir,
        );
        fallbackPaths = written.map((w) => w.relativePath);
      } catch (err) {
        const raw = err instanceof Error ? err.message : String(err);
        console.warn(`[agent] modality fallback: failed to write ${filteredImageCount} image(s) to ${targetDir}, reverting to synthetic text. error=${raw}`);
      }
    }

    if (fallbackPaths.length > 0) {
      // Mirror the frontend non-image paste path (SimpleChatInput.tsx
      // /api/files/add-gitignore call): keep workspace-internal artifacts
      // out of git by default. PRD §6.4 explicitly calls for parity here.
      ensureGitignorePattern(agentDir, 'myagents_files/');

      const refs = fallbackPaths.map((p) => `@${p}`).join(' ');
      effectiveText = effectiveText ? `${effectiveText}\n\n${refs}` : refs;
      console.log(`[agent] modality fallback: ${fallbackPaths.length} image(s) → myagents_files/ (model=${modelForFilter ?? '(unknown)'})`);
      broadcast('chat:attachments-fallback', {
        kind: 'image',
        count: fallbackPaths.length,
        paths: fallbackPaths,
        model: modelForFilter ?? null,
      });
    } else {
      // Fallback unavailable (no agent dir or write failure): preserve the
      // pre-PRD behaviour so we never drop the user turn entirely.
      console.log(`[agent] modality filter: dropping ${filteredImageCount} image(s) for model=${modelForFilter ?? '(unknown)'} (text-only, fallback unavailable)`);
      contentBlocks.push({
        type: 'text',
        text: `[${filteredImageCount} image attachment(s) omitted — current model does not support image input]`,
      });
      broadcast('chat:attachments-filtered', {
        // 'fallback-failed' lets the frontend distinguish "model has no image
        // modality, fallback worked" (no event) from "fallback was attempted
        // but failed" (this branch). The pre-PRD path used 'modality'; we
        // keep that as the legacy/no-agent-dir reason.
        reason: agentDir ? 'fallback-failed' : 'modality',
        kind: 'image',
        count: filteredImageCount,
        model: modelForFilter ?? null,
      });
    }
  }

  // Add text content if present (may include @reference suffix from fallback)
  if (effectiveText) {
    contentBlocks.push({ type: 'text', text: effectiveText });
  }

  // Queue if session is busy: either AI is streaming or there are pending transcriptState.messages
  // in the queue waiting to be processed.
  // IMPORTANT: Do NOT push to transcriptState.messages[] or broadcast here — queued transcriptState.messages
  // are rendered in the frontend only when they start executing (see messageGenerator).
  // Mid-turn injection: deliver via wakeGenerator so the generator can yield
  // the message to SDK stdin immediately (subprocess reads at breakpoints).
  if (isSessionBusy) {
    // Backend queue limit (defense-in-depth — frontend also enforces limit)
    // Count queueState.messageQueue + queueState.pendingMidTurnQueue + queueState.turnBoundaryQueue + the in-flight slot.
    if (!reservedTurnBoundaryItem && queuedWorkCount() >= MAX_QUEUE_SIZE) {
      return { queued: false, error: `Queue full (max ${MAX_QUEUE_SIZE})` };
    }
    const admissionAction = reservedAdmissionAction ?? (providerRetryPending ? 'turn-boundary' : decideQueueAdmission({
        mode: queueResponseMode,
        busy: true,
        hasInFlight: getInFlightQueueId() !== null,
        hasScopedTurnBoundaryQueued: options?.fromDesktopChatSend === true
          && (getTurnBoundaryQueue().length > 0 || getTurnAdmissionTicket() !== null),
    }));
    const queueDeliveryMode: DesktopDeliveryMode = admissionAction === 'turn-boundary' ? 'turn' : 'realtime';
    if (admissionTicket?.canceled) {
      return { queued: false, error: 'Queue item was cancelled before dispatch' };
    }
    const admissionCallbacks = takeAdmissionCallbacks();
    const queueItem: MessageQueueItem = {
      id: queueId,
      message: { role: 'user', content: contentBlocks },
      messageText: trimmed,
      wasQueued: holdForWatchdogRecovery ? true : admissionAction !== 'turn-boundary',
      deliveryMode: queueDeliveryMode,
      resolve: () => {},  // No-op: no one is awaiting
      attachments: savedAttachments.length > 0 ? savedAttachments : undefined,
      requestId,
      analyticsSource: analyticsSource ?? currentScenario.type,
      analyticsOrigin,
      providerAnalytics: turnProviderAnalytics,
      inboxMeta,
      turnOwner: options?.turnOwner,
      onTerminal: admissionCallbacks.onTerminal,
      beforeDispatch: options?.beforeDispatch,
      channelDelivery,
      deferredSessionMetadata,
      deferVisibleAdmission,
      settleDispatchAcceptance: admissionCallbacks.settleDispatchAcceptance,
    };

    // (v0.2.12 mid-turn injection) Lockstep yield. Only one queued message
    // lives in CLI's commandQueue at a time so subsequent items stay
    // cancellable in queueState.pendingMidTurnQueue until this one is consumed
    // (signalled by SDKUserMessageReplay) and we promote the next.
    if (holdForWatchdogRecovery) {
      pushMessage(queueItem);
      console.log(`[agent] Message queued behind watchdog recovery reminder: queueId=${queueId} requestId=${requestId ?? '-'} text="${trimmed.slice(0, 50)}"`);
      if (!deferVisibleAdmission) {
        broadcast('queue:added', { queueId, messageText: trimmed.slice(0, 100), isInFlight: false, deliveryMode: queueDeliveryMode });
      }
    } else if (admissionAction === 'turn-boundary') {
      const turnItem = reservedTurnBoundaryItem;
      if (turnItem && !getTurnBoundaryQueue().includes(turnItem)) {
        console.log(`[agent] Turn-boundary queue item ${queueId} was cancelled before preparation completed`);
        settleDispatchAcceptance?.({ accepted: false, error: 'Queue item was cancelled before dispatch' });
        return { queued: false, error: 'Queue item was cancelled before dispatch' };
      }
      const readyTurnItem = turnItem ?? {
        queueId,
        ready: false,
        messageText: trimmed,
        requestId,
      };
      readyTurnItem.ready = true;
      readyTurnItem.sourceItem = queueItem;
      readyTurnItem.attachments = savedAttachments.length > 0 ? savedAttachments : undefined;
      readyTurnItem.source = effectiveQueueSource === 'desktop' ? 'desktop' : metadata?.source;
      readyTurnItem.analyticsSource = analyticsSource ?? currentScenario.type;
      readyTurnItem.analyticsOrigin = analyticsOrigin;
      readyTurnItem.mirrorImages = resolvedImagesToMirrorImages(resolvedImages);
      if (readyTurnItem.admissionTicket) {
        releaseDetachedAdmissionTicket(readyTurnItem.admissionTicket);
        readyTurnItem.admissionTicket = undefined;
      }
      if (!turnItem) {
        pushTurnBoundary(readyTurnItem);
        if (!deferVisibleAdmission) {
          broadcast('queue:added', { queueId, messageText: trimmed.slice(0, 100), isInFlight: false, deliveryMode: 'turn' });
        }
      }
      console.log(`[agent] Message queued for next turn boundary: queueId=${queueId} requestId=${requestId ?? '-'} text="${trimmed.slice(0, 50)}"`);
      startNextTurnQueuedItem('recovery');
    } else if (admissionAction === 'realtime-inflight') {
      // No in-flight queue item — this becomes the in-flight one. Yield
      // immediately so CLI receives it and the next mid-turn drain
      // (query.ts:1570 at any tool break) attaches it to the model's
      // context. Claim queueState.inFlightToCliId only when the generator has
      // a live resolver; otherwise ownership remains in messageQueue until a
      // later real handoff. When claimed, mark BEFORE wakeGenerator so any
      // concurrent enqueue arriving in the same micro-task takes the buffer path.
      if (decideRealtimeHandoff(lifecycleState.messageResolver !== null) === 'sdk-inflight') {
        setInFlightQueueItem(queueId, {
          messageText: trimmed,
          attachments: savedAttachments.length > 0 ? savedAttachments : undefined,
          requestId,
          source: metadata?.source,
          analyticsSource: analyticsSource ?? currentScenario.type,
          analyticsOrigin,
          mirrorImages: resolvedImagesToMirrorImages(resolvedImages),
          channelDelivery,
        });
        wakeGenerator(queueItem);
        console.log(`[agent] Message queued mid-turn (in-flight to CLI): queueId=${queueId} requestId=${requestId ?? '-'} text="${trimmed.slice(0, 50)}"`);
        if (!deferVisibleAdmission) {
          broadcast('queue:added', { queueId, messageText: trimmed.slice(0, 100), isInFlight: true, deliveryMode: 'realtime' });
        }
      } else {
        // The generator is still owned by a promoted/active turn. Labeling
        // this item SDK-inflight would be false: wakeGenerator can only put it
        // in the local message queue, and teardown would then cancel the slot
        // while leaving the same item queued for replay. Keep one honest local
        // owner; dequeue promotes it when a handoff is real.
        pushMessage(queueItem);
        console.log(`[agent] Message queued mid-turn (local until generator handoff): queueId=${queueId} requestId=${requestId ?? '-'} text="${trimmed.slice(0, 50)}"`);
        if (!deferVisibleAdmission) {
          broadcast('queue:added', { queueId, messageText: trimmed.slice(0, 100), isInFlight: false, deliveryMode: 'realtime' });
        }
      }
    } else {
      // Another item is in-flight to CLI. Buffer this one. It stays
      // fully cancellable (splice from queueState.pendingMidTurnQueue) until promoted
      // by handleQueuedCommandReplay, SDK cancel of the in-flight slot, or
      // a confirmed assistant-start boundary.
      const userMessage: MessageWire = {
        id: allocateMessageId(),
        role: 'user',
        content: trimmed,
        timestamp: new Date().toISOString(),
        attachments: savedAttachments.length > 0 ? savedAttachments : undefined,
      };
      pushPendingMidTurn({
        queueId,
        userMessage: {
          id: userMessage.id,
          role: userMessage.role,
          content: userMessage.content,
          timestamp: userMessage.timestamp,
          attachments: userMessage.attachments,
        },
        sourceItem: queueItem,
      });
      console.log(`[agent] Message queued mid-turn (pending — in-flight slot busy): queueId=${queueId} requestId=${requestId ?? '-'} (pending=${getPendingMidTurnQueue().length})`);
      if (!deferVisibleAdmission) {
        broadcast('queue:added', { queueId, messageText: trimmed.slice(0, 100), isInFlight: false, deliveryMode: 'realtime' });
      }
    }

    // Safety net: if message was queued because lifecycleState.abortRequested is true but no session
    // or pre-warm timer exists to process it, schedule recovery. This prevents orphaned
    // transcriptState.messages when a deferred config restart races with session cleanup.
    if (lifecycleState.abortRequested && !lifecycleState.preWarmTimer && !lifecycleState.messageResolver) {
      console.warn('[agent] Safety net: queued message during abort with no pending recovery, scheduling pre-warm');
      schedulePreWarm();
    }
    // (v0.2.12) queueState.inFlightToCliId === queueId only when this enqueue took the
    // immediate-yield path. Frontend uses this to set the optimistic pill's
    // isInFlight flag from the very first paint, before the SSE round-trip.
    return {
      queued: true,
      queueId,
      isInFlight: getInFlightQueueId() === queueId,
      deliveryMode: queueDeliveryMode,
      dispatchAcceptance,
    };
  }

  // Direct send path. Guarded Goal turns hold every user history/UI side effect
  // until the admission claim succeeds in the generator; ordinary messages keep
  // the immediate bubble path.
  // NOTE (issue #173): surfaceBuiltinUserMessage is the sole writer for this
  // direct-send message. It runs here for ordinary turns or once after the
  // generator accepts a guarded turn; never do both.
  const userMessage: MessageWire = {
    id: allocateMessageId(),
    role: 'user',
    content: trimmed,
    timestamp: new Date().toISOString(),
    attachments: savedAttachments.length > 0 ? savedAttachments : undefined,
    metadata,
  };
  const directUserSurface: DeferredUserSurface = {
    event: 'message-replay',
    message: userMessage,
    sessionBirthOrigin: options?.sessionBirthOrigin,
    mirrorImages: resolvedImagesToMirrorImages(resolvedImages),
    channelDelivery,
  };
  if (!options?.beforeDispatch) {
    try {
      await surfaceBuiltinUserMessage(directUserSurface, 'pre-admission');
    } catch (error) {
      await rollbackFailedBuiltinUserSurface(userMessage.id);
      reportBuiltinAdmissionPersistenceFailure(queueId, requestId, error);
      throw error;
    }
  }
  if (!deferVisibleAdmission) {
    setSessionState((lifecycleState.systemInitInfo || lifecycleState.sdkControlReady) ? 'running' : 'starting');
  }

  if (admissionTicket?.canceled) {
    return { queued: false, error: 'Queue item was cancelled before dispatch' };
  }
  const admissionCallbacks = takeAdmissionCallbacks();
  const queueItem: MessageQueueItem = {
    id: queueId,
    message: { role: 'user', content: contentBlocks },
    messageText: trimmed,
    wasQueued: false,
    deliveryMode: queueResponseMode,
    resolve: () => {},  // No-op: no one is awaiting
    attachments: savedAttachments.length > 0 ? savedAttachments : undefined,
    requestId,
    analyticsSource: analyticsSource ?? currentScenario.type,
    analyticsOrigin,
    sessionBirthOrigin: options?.sessionBirthOrigin,
    providerAnalytics: turnProviderAnalytics,
    inboxMeta,
    turnOwner: options?.turnOwner,
    onTerminal: admissionCallbacks.onTerminal,
    beforeDispatch: options?.beforeDispatch,
    channelDelivery,
    deferredSessionMetadata,
    deferredUserSurface: options?.beforeDispatch ? directUserSurface : undefined,
    deferVisibleAdmission,
    settleDispatchAcceptance: admissionCallbacks.settleDispatchAcceptance,
  };

  if (!isSessionActive()) {
    // 无活跃 session（pre-warm 失败或首次启动）→ 先入队再启动 session
    console.log('[agent] starting session (idle -> running)');
    resetPreWarmFailCount(); // 用户主动操作重置重试计数
    pushMessage(queueItem);
    // CRITICAL: Defer to next event loop tick via setTimeout(0).
    // SDK query() can block the event loop for minutes during session resume
    // (subprocess spawn + MCP server initialization). If called synchronously,
    // the /api/im/chat handler can't return its SSE Response, causing Rust's
    // read_timeout to fire. setTimeout(0) lets the handler return first.
    setTimeout(() => {
      startStreamingSession(deferVisibleAdmission).catch((error) => {
        console.error('[agent] failed to start session', error);
      });
    }, 0);
  } else {
    // Session 已在运行（generator 在 waitForMessage 中等待）→ 直接投递
    keepTurnAdmissionTicketUntilGenerator = getTurnAdmissionTicket()?.queueId === queueId;
    wakeGenerator(queueItem);
  }

  return { queued: false, queueId, dispatchAcceptance };
  } finally {
    if (reservedTurnBoundaryItem && !reservedTurnBoundaryItem.ready) {
      const reservationIdx = getTurnBoundaryQueue().indexOf(reservedTurnBoundaryItem);
      if (reservationIdx >= 0) {
        spliceTurnBoundary(reservationIdx, 1);
        if (reservedTurnBoundaryItem.admissionTicket) {
          cancelDetachedAdmissionTicket(reservedTurnBoundaryItem.admissionTicket);
          reservedTurnBoundaryItem.admissionTicket.settleDispatchAcceptance?.({
            accepted: false,
            error: 'Queue item was rejected before dispatch',
          });
        }
        if (reservedTurnBoundaryItem.queueId === getForceTurnBoundaryQueueId()) {
          setForceTurnBoundaryQueueId(null);
        }
        if (!deferVisibleAdmission) {
          broadcast('queue:cancelled', { queueId: reservedTurnBoundaryItem.queueId });
        }
        startNextTurnQueuedItem('recovery');
      }
    }
    const releasedAdmissionTicket = !keepTurnAdmissionTicketUntilGenerator
      && getTurnAdmissionTicket()?.queueId === queueId;
    if (releasedAdmissionTicket) {
      releaseTurnAdmissionTicket(queueId);
      startNextTurnQueuedItem('recovery');
    }
  }
}

export function isSessionActive(): boolean {
  return lifecycleState.processing || lifecycleState.query !== null;
}

/**
 * Read historical session transcriptState.messages from SDK's persisted session files.
 * Works without an active Sidecar — reads directly from .claude/ session files.
 *
 * @param sdkSessionId - The SDK session ID (from session metadata's sdkSessionId)
 * @param dir - Optional project directory to search in
 * @param limit - Maximum number of transcriptState.messages to return
 * @param offset - Number of transcriptState.messages to skip from the start
 */
export async function getHistoricalSessionMessages(
  sdkSessionId: string,
  dir?: string,
  limit?: number,
  offset?: number,
): Promise<Array<{ type: string; uuid: string; session_id: string; message: unknown }>> {
  const historicalMessages = await sdkGetSessionMessages(sdkSessionId, {
    ...(dir ? { dir } : {}),
    ...(limit !== undefined ? { limit } : {}),
    ...(offset !== undefined ? { offset } : {}),
  });
  return historicalMessages;
}

/**
 * Wait for the current session to become idle
 * Returns true if idle, false if timeout
 * @param timeoutMs Maximum time to wait in milliseconds (default: 10 minutes)
 * @param pollIntervalMs How often to check status (default: 500ms)
 */
// Helper function to check if session is idle (avoids TypeScript type narrowing issues)
function isSessionIdle(): boolean {
  return sessionState === 'idle';
}

export async function waitForSessionIdle(
  timeoutMs: number = 600000,
  pollIntervalMs: number = 500
): Promise<boolean> {
  const startTime = Date.now();
  console.log(`[agent] waitForSessionIdle: starting, sessionState=${sessionState}`);

  // Brief wait to allow async operations to start (prevents false early return)
  // Note: Only check sessionState === 'idle' because lifecycleState.processing and lifecycleState.query
  // remain set until the entire session ends (for await loop in startStreamingSession).
  // The sessionState is set to 'idle' by handleMessageComplete() after each message,
  // which correctly indicates "no message is being processed" for cron sync execution.
  if (isSessionIdle()) {
    await new Promise(resolve => setTimeout(resolve, 100));
    if (isSessionIdle()) {
      console.log('[agent] waitForSessionIdle: already idle, returning true');
      return true;
    }
  }

  while (Date.now() - startTime < timeoutMs) {
    if (isSessionIdle()) {
      console.log(`[agent] waitForSessionIdle: became idle after ${Date.now() - startTime}ms`);
      return true;
    }
    await new Promise(resolve => setTimeout(resolve, pollIntervalMs));
  }

  console.warn('[agent] waitForSessionIdle: timeout reached');
  return false;
}

export async function interruptCurrentResponse(reason: CancelReason = 'user'): Promise<boolean> {
  if (transientProviderRetryTimer) {
    clearTransientProviderRetryTimer(`interrupt:${reason}`);
    const completionTerminal = handleMessageStopped();
    broadcast('chat:message-stopped', withSessionCompletionTerminal(null, completionTerminal));
    return true;
  }

  if (!isTurnInFlight()) {
    // A durable admission CAS has crossed the queue-cancellation boundary but
    // has not yet transferred to `isStreamingMessage`. Reuse the canonical
    // session abort: it marks the promoted item cancelled and sets
    // abortRequested, so the generator exits immediately after the CAS instead
    // of executing a turn that its deadline caller already stopped.
    if (getCommittingTurnAdmissionQueueId() !== null) {
      abortPersistentSession();
      return true;
    }
    // (issue #174) Stop pressed during 'starting': the SDK subprocess is
    // alive but system_init hasn't arrived (the for-await loop sees no
    // assistant content yet, so isTurnInFlight is false). Without this
    // branch the user's Stop button is a no-op for the up-to-10-minute
    // startup-timeout window. Tear the subprocess down via the canonical
    // abort path — same teardown the startup-timeout firer uses.
    if (sessionState === 'starting') {
      console.log(`[agent] Stop pressed during startup (reason=${reason}) — aborting persistent session`);
      // Drain BEFORE abort so the cold-start path's queued first-message
      // (enqueued by enqueueUserMessage just before the deferred
      // startStreamingSession scheduled via setTimeout(0)) doesn't survive
      // into a recovery session and silently re-execute. abortPersistentSession
      // calls rescuePendingToQueue which only moves queueState.pendingMidTurnQueue items
      // (empty during startup) — it doesn't touch queueState.messageQueue. Order
      // matters: drain here, then abort sets lifecycleState.abortRequested so the
      // pre-launch guard inside startStreamingSession bails out cleanly.
      drainQueueWithCancellation();
      abortPersistentSession();
      // Cold-start race: if the deferred startStreamingSession setTimeout(0)
      // hasn't fired yet, lifecycleState.query is null and lifecycleState.processing is false,
      // so the for-await finally block — the only path that flips
      // sessionState back to 'idle' — will never run. Force the transition
      // here so the UI returns to a sendable state immediately. (When a
      // subprocess IS alive, abortPersistentSession's interrupt() drives
      // the for-await loop to terminate and the existing finally block
      // handles the idle transition; we'd be racing it, so skip.)
      if (!lifecycleState.query && !lifecycleState.processing) {
        setSessionState('idle');
      }
      return true;
    }
    // No active turn, but there might be orphaned queued transcriptState.messages.
    // Drain them and notify the frontend so the UI can recover.
    if (getMessageQueue().length > 0 || getTurnBoundaryQueue().length > 0) {
      console.warn(`[agent] No active turn but ${getMessageQueue().length + getTurnBoundaryQueue().length} orphaned message(s) in queue, draining`);
      drainQueueWithCancellation();
    }
    return false;
  }

  if (isInterruptingResponse) {
    return true;
  }

  // Pattern 1 follow-up: abort the turn-scoped controller FIRST so any
  // in-flight tool fetches / streams in our Node process see the cancel
  // immediately, in parallel with the cooperative SDK interrupt below.
  // Both are fire-and-forget; we don't await this — withAbortSignal /
  // cancellableFetch wake their op via the AbortSignal listener.
  if (sessionId) abortTurnAbort(sessionId, reason);

  if (!lifecycleState.query) {
    console.log('[agent] No lifecycleState.query but turn is still marked active, resetting state');
    const completionTerminal = handleMessageStopped();
    broadcast('chat:message-stopped', withSessionCompletionTerminal(null, completionTerminal));
    return true;
  }

  setInterruptingInFlightQueueId(getInFlightQueueId());
  const interruptTargetQueueId = getInterruptingInFlightQueueId();
  isInterruptingResponse = true;
  interruptSurvivingQueueIds = null;
  postInterruptTurnEndOutcome = null;
  postInterruptTurnEndResolve = null;
  try {
    // Step 1: Try graceful interrupt (5 seconds).
    // interrupt() is cooperative — the SDK subprocess must be responsive to process it.
    // If a MCP tool is hung (e.g., Playwright screenshot on heavy page), the subprocess
    // may be blocked on I/O and unable to handle the interrupt signal.
    const interruptQuery = lifecycleState.query;
    const interruptPromise = reconcileInterruptReceipt({
      requestReceipt: () => interruptQuery.interrupt(),
      // A timed-out request can still resolve after this interrupt owner has
      // finished or the Query has been replaced. Ignore that stale receipt.
      isCurrentOwner: () => isInterruptingResponse && lifecycleState.query === interruptQuery,
      getPostInterruptOutcome: () => postInterruptTurnEndOutcome,
      interruptTargetQueueId,
      getCurrentQueueId: getInFlightQueueId,
      onReceipt: (stillQueued) => {
        interruptSurvivingQueueIds = stillQueued;
        console.log(`[agent] Interrupt receipt: stillQueued=${stillQueued.size}`);
      },
      onUnavailable: () => {
        console.log('[agent] Interrupt receipt unavailable (older CLI capability)');
      },
      dropExactInFlight: () => {
        dropInFlightQueueItem(
          'late interrupt receipt confirms queued item was cancelled',
          'cancelled',
        );
      },
      scheduleDrain: () => schedulePostTerminalQueueDrain('stopped'),
    });
    const timeoutPromise = new Promise<void>((_, reject) => {
      setTimeout(() => reject(new Error('Interrupt timeout')), 5000);
    });

    let interrupted = false;
    try {
      await Promise.race([interruptPromise, timeoutPromise]);
      interrupted = true;
    } catch (error) {
      console.error('[agent] Interrupt failed or timed out (5s):', error);
    }

    // Step 2: If interrupt failed, force-close immediately.
    // close() is the SDK's nuclear option: kills subprocess + MCP transports synchronously.
    // Session history is preserved (JSONL persisted), next message triggers fresh subprocess
    // with resumeSessionId (no data loss, no amnesia). (#60)
    if (!interrupted && lifecycleState.query) {
      console.warn('[agent] Force-closing SDK session (interrupt unresponsive)');
      // Rescue pending items BEFORE close: SDK stdin buffer dies with the subprocess.
      // Must run before close() so the recovery session re-delivers them.
      rescuePendingToQueue();
      const session = lifecycleState.query;
      setQuerySession(null);
      try { session.close(); } catch { /* already dead */ }
    }

    // Step 3: If interrupt "succeeded" (SDK ACKed), verify the turn actually completed.
    // interrupt() resolving only means the SDK received the signal — it does NOT guarantee
    // the subprocess stopped processing. If an MCP tool is hung (e.g., cuse Read on a large
    // screenshot), the SDK subprocess remains blocked on client.callTool() with a ~28-hour
    // timeout. The for-await loop gets no more events, stdin transcriptState.messages are swallowed, and
    // the user sees "no response" until the 10-minute watchdog fires.
    //
    // Fix: wait up to 3 seconds for the for-await loop to receive a `result` message
    // (turn completion). If it doesn't arrive, force-close. The diagnostic message
    // distinguishes two phases the model could be in when the user pressed Stop:
    //   - inFlightToolCount > 0  → an MCP tool_use is awaiting tool_result, very
    //     likely the SDK subprocess is blocked on client.callTool() (hung tool).
    //   - inFlightToolCount === 0 → no tool in flight; the model is mid-generation
    //     (thinking / text streaming) and 3s wasn't enough for the SDK to wind
    //     down. NOT a hung tool — calling it one in the log misleads anyone
    //     grepping for tool issues. This was the misdiagnosis observed on
    //     2026-05-07 when stop was pressed during a thinking block.
    if (interrupted && lifecycleState.query && !postInterruptTurnEndOutcome) {
      const turnEnded = new Promise<PostInterruptTurnEndOutcome>(resolve => {
        postInterruptTurnEndResolve = resolve;
      });
      const postInterruptTimeout = new Promise<PostInterruptTurnEndOutcome>((_, reject) =>
        setTimeout(() => reject(new Error('Post-interrupt turn completion timeout')), 3000)
      );
      try {
        postInterruptTurnEndOutcome = await Promise.race([turnEnded, postInterruptTimeout]);
      } catch {
        postInterruptTurnEndResolve = null;
        if (lifecycleState.query) {
          const phase = inFlightToolCount > 0
            ? `hung MCP tool likely (${inFlightToolCount} tool_use awaiting result)`
            : 'model still generating (no tool in flight)';
          console.warn(`[agent] Force-closing: turn did not complete 3s after interrupt — ${phase}`);
          // Rescue pending items BEFORE close: see rescuePendingToQueue() doc.
          rescuePendingToQueue();
          const session = lifecycleState.query;
          setQuerySession(null);
          try { session.close(); } catch { /* already dead */ }
        }
      }
    }

    // A graceful SDK result synchronously claims and consumes the current
    // output owner. Only the no-result/session-ended path may claim stopped
    // here; calling both terminalizers would pop the following IM request.
    if (postInterruptTurnEndOutcome !== 'result-claimed') {
      const completionTerminal = handleMessageStopped();
      broadcast('chat:message-stopped', withSessionCompletionTerminal(null, completionTerminal));
    }
    return true;
  } finally {
    isInterruptingResponse = false;
    interruptSurvivingQueueIds = null;
    setInterruptingInFlightQueueId(null);
    postInterruptTurnEndResolve = null;
    postInterruptTurnEndOutcome = null;
  }
}

/**
 * Pattern D — IM trace-id-targeted cancellation. Resolves whether the request
 * is currently running or queued, then takes the appropriate action:
 *   - queued (in queueState.messageQueue / queueState.pendingMidTurnQueue) → splice out, broadcast
 *     queue:cancelled, no SDK interrupt needed
 *   - running (activeRequestId matches + turn in flight) → interruptCurrentResponse
 *     which already wires `abortTurnAbort` → cancellableFetch unblock + SDK interrupt
 *   - unknown → no-op (caller can still emit a 'cancelled' event for UI)
 *
 * Returns the resolved mode so the caller (`/api/im/cancel`) can shape the response.
 */
export async function cancelImRequest(
  requestId: string,
  reason: CancelReason = 'user',
): Promise<{ aborted: boolean; mode: 'running' | 'queued' | 'unknown' }> {
  const removed = removeQueuedItemByRequestId(requestId);
  if (removed.location === 'message' && removed.item) {
    removed.item.settleDispatchAcceptance?.({ accepted: false, error: 'Queue item was cancelled' });
    await notifyQueuedTurnStopped(removed.item);
    removed.item.resolve();
    broadcast('queue:cancelled', { queueId: removed.item.id });
    console.log(`[agent] cancelImRequest requestId=${requestId} mode=queued`);
    return { aborted: true, mode: 'queued' };
  }
  if (removed.location === 'pending-mid-turn' && removed.pending) {
    removed.pending.sourceItem.settleDispatchAcceptance?.({ accepted: false, error: 'Queue item was cancelled' });
    await notifyQueuedTurnStopped(removed.pending.sourceItem);
    removed.pending.sourceItem.resolve();
    broadcast('queue:cancelled', { queueId: removed.pending.queueId });
    console.log(`[agent] cancelImRequest requestId=${requestId} mode=pending-mid-turn (never yielded to CLI)`);
    return { aborted: true, mode: 'queued' };
  }
  if (removed.location === 'turn-boundary' && removed.turnBoundary) {
    removed.turnBoundary.sourceItem?.settleDispatchAcceptance?.({ accepted: false, error: 'Queue item was cancelled' });
    if (removed.turnBoundary.sourceItem) await notifyQueuedTurnStopped(removed.turnBoundary.sourceItem);
    removed.turnBoundary.sourceItem?.resolve();
    if (removed.turnBoundary.queueId === getForceTurnBoundaryQueueId()) {
      setForceTurnBoundaryQueueId(null);
    }
    broadcast('queue:cancelled', { queueId: removed.turnBoundary.queueId });
    console.log(`[agent] cancelImRequest requestId=${requestId} mode=turn-boundary (never yielded to CLI)`);
    return { aborted: true, mode: 'queued' };
  }
  // Admission has already transferred to the active turn before its user row
  // is durably persisted, but the output-owner FIFO is created only at the SDK
  // yield. Cancellation in that narrow window must terminalize the exact IM
  // request instead of looking only at the (not-yet-created) FIFO head.
  const activeSource = getCurrentTurnSourceItem();
  if (
    activeSource?.requestId === requestId
    && !hasPendingOutputOwnerByQueueId(activeSource.id)
    && isTurnInFlight()
  ) {
    if (imRequestRegistry.get(requestId)) {
      finalizeImRequest(
        requestId,
        'cancelled',
        'cancelled',
        buildImCancelledPayload(),
        true,
      );
    }
    console.log(`[agent] cancelImRequest requestId=${requestId} mode=running phase=admission-persist`);
    await interruptCurrentResponse(reason);
    return { aborted: true, mode: 'running' };
  }
  // Active turn? (queue head matches)
  if (peekPendingOutputOwner()?.requestId === requestId && isTurnInFlight()) {
    console.log(`[agent] cancelImRequest requestId=${requestId} mode=running`);
    await interruptCurrentResponse(reason);
    return { aborted: true, mode: 'running' };
  }
  // (v0.2.34) In-flight to CLI is conditionally cancellable through SDK
  // cancel_async_message while it is still pending in commandQueue.
  if (getInFlightMetadata()?.requestId === requestId && getInFlightQueueId() !== null) {
    const queueId = getInFlightQueueId()!;
    const cancelResult = await cancelSdkAsyncMessage(queueId);
    const settlement = decideInFlightCancelSettlement(cancelResult);
    if (settlement.cancelled) {
      const sourceItem = getCurrentTurnSourceItem();
      if (sourceItem?.id === queueId) await notifyQueuedTurnStopped(sourceItem);
      if (settlement.removePendingRequest) removePendingOutputOwnerByQueueId(queueId);
      if (settlement.clearSlot) {
        clearInFlightSlot();
        applyDeferredRestartIfNeeded();
      }
      if (settlement.broadcastCancelled) broadcast('queue:cancelled', { queueId });
      console.log(`[agent] cancelImRequest requestId=${requestId} mode=in-flight-sdk-queue`);
      if (settlement.promoteNext) schedulePostTerminalQueueDrain('stopped');
      if (!hasQueuedOrInFlightWork() && !isTurnInFlight()) {
        setSessionState('idle');
      }
      return { aborted: true, mode: 'queued' };
    }
    console.log(`[agent] cancelImRequest requestId=${requestId} in-flight SDK cancel rejected result=${cancelResult}`);
  }
  // Either the requestId was already consumed by SDK or it doesn't exist on
  // this side. Surface as 'unknown' so the IM client can show "cancel failed"
  // honestly rather than a false success.
  return { aborted: false, mode: 'unknown' };
}

/**
 * Cancel a queued message by its queueId.
 * Returns the original message text on success (for restoring to input box)
 * or a structured failure reason when cancellation is no longer possible.
 *
 * (v0.2.37) Four queue locations to check:
 *   - queueState.messageQueue: not yet consumed by generator (no active turn). Splice → done.
 *   - queueState.pendingMidTurnQueue: buffered while another item is in-flight to CLI.
 *     Splice → done. Still cancellable because it never crossed the process
 *     boundary into CLI's commandQueue.
 *   - queueState.turnBoundaryQueue: desktop turn-mode item waiting for a clean turn boundary.
 *     Splice → done. It never crossed the process boundary.
 *   - queueState.inFlightToCliId match: the item is in SDK's commandQueue. Try
 *     cancel_async_message; it succeeds only before SDK dequeues execution.
 */
export async function cancelQueueItem(queueId: string): Promise<QueueCancelResult> {
  // The durable prepared-session claim is the final admission CAS. Once it
  // starts, cancellation can no longer truthfully report a pre-dispatch win:
  // either rollback wins the same lock and this item is rejected, or admission
  // wins and synchronously transfers ownership to the active turn. Returning
  // not_cancelled keeps the caller on the active-turn stop path.
  if (getCommittingTurnAdmissionQueueId() === queueId) {
    return { status: 'not_cancelled' };
  }
  const admissionCancellation = cancelTurnAdmissionTicket(queueId);
  const admission = admissionCancellation?.ticket ?? null;
  const removed = removeQueuedItemByQueueId(queueId);

  switch (removed.location) {
    case 'message': {
      const item = removed.item!;
      await admissionCancellation?.settlement;
      item.settleDispatchAcceptance?.({ accepted: false, error: 'Queue item was cancelled' });
      await notifyQueuedTurnStopped(item);
      item.resolve();
      if (!item.deferVisibleAdmission) broadcast('queue:cancelled', { queueId });
      console.log(`[agent] Queue item ${queueId} cancelled from queueState.messageQueue (wasQueued=${item.wasQueued})`);
      return { status: 'cancelled', cancelledText: item.messageText };
    }
    case 'pending-mid-turn': {
      const pending = removed.pending!;
      await admissionCancellation?.settlement;
      pending.sourceItem.settleDispatchAcceptance?.({ accepted: false, error: 'Queue item was cancelled' });
      await notifyQueuedTurnStopped(pending.sourceItem);
      pending.sourceItem.resolve();
      broadcast('queue:cancelled', { queueId });
      console.log(`[agent] Queue item ${queueId} cancelled from queueState.pendingMidTurnQueue (never yielded to CLI)`);
      if (!hasQueuedOrInFlightWork() && !isTurnInFlight()) {
        setSessionState('idle');
      }
      return {
        status: 'cancelled',
        cancelledText: typeof pending.userMessage.content === 'string' ? pending.userMessage.content : '',
      };
    }
    case 'turn-boundary': {
      const turnBoundary = removed.turnBoundary!;
      const invisibleAdmission = turnBoundary.admissionTicket?.beforeUserPersistence !== undefined
        || turnBoundary.sourceItem?.deferVisibleAdmission === true;
      const detachedAdmissionSettlement = turnBoundary.admissionTicket
        ? cancelDetachedAdmissionTicket(turnBoundary.admissionTicket)
        : Promise.resolve();
      const sourceGuardSettlement = Promise.resolve(
        turnBoundary.sourceItem?.beforeDispatch?.cancel?.(),
      );
      await Promise.all([
        admissionCancellation?.settlement,
        detachedAdmissionSettlement,
        sourceGuardSettlement,
      ]);
      turnBoundary.admissionTicket?.settleDispatchAcceptance?.({
        accepted: false,
        error: 'Queue item was cancelled',
      });
      turnBoundary.sourceItem?.settleDispatchAcceptance?.({ accepted: false, error: 'Queue item was cancelled' });
      const stoppedOwner = turnBoundary.sourceItem ?? turnBoundary.admissionTicket;
      if (stoppedOwner) await notifyQueuedTurnStopped(stoppedOwner);
      turnBoundary.sourceItem?.resolve();
      if (turnBoundary.queueId === getForceTurnBoundaryQueueId()) {
        setForceTurnBoundaryQueueId(null);
      }
      if (!invisibleAdmission) broadcast('queue:cancelled', { queueId });
      console.log(`[agent] Queue item ${queueId} cancelled from queueState.turnBoundaryQueue`);
      if (!hasQueuedOrInFlightWork() && !isTurnInFlight()) {
        setSessionState('idle');
      }
      return { status: 'cancelled', cancelledText: turnBoundary.messageText };
    }
    case 'in-flight': {
      const meta = getInFlightMetadata();
      const cancelResult = await cancelSdkAsyncMessage(queueId);
      const settlement = decideInFlightCancelSettlement(cancelResult);
      if (settlement.cancelled) {
        const cancelledText = meta?.messageText ?? '';
        const sourceItem = getCurrentTurnSourceItem();
        if (sourceItem?.id === queueId) await notifyQueuedTurnStopped(sourceItem);
        if (settlement.removePendingRequest) removePendingOutputOwnerByQueueId(queueId);
        if (settlement.clearSlot) {
          clearInFlightSlot();
          applyDeferredRestartIfNeeded();
        }
        if (settlement.broadcastCancelled) broadcast('queue:cancelled', { queueId });
        console.log(`[agent] Queue item ${queueId} cancelled from SDK commandQueue via cancel_async_message`);
        if (settlement.promoteNext) schedulePostTerminalQueueDrain('stopped');
        if (!hasQueuedOrInFlightWork() && !isTurnInFlight()) {
          setSessionState('idle');
        }
        return { status: 'cancelled', cancelledText };
      }
      console.log(`[agent] Queue item ${queueId} cancel rejected — SDK async cancel result=${cancelResult}`);
      if (cancelResult === 'not-cancelled') return { status: 'not_cancelled' };
      return { status: cancelResult === 'unavailable' ? 'unavailable' : 'error' };
    }
  }

  if (admission) {
    // Direct turn admission and generator promotion overlap until the commit
    // seam. Cancel both owners: otherwise the admission branch returns while
    // a generator waiting on the MCP-mutation fence never observes cancel.
    const promotedCancellation = cancelPromotedItemWithSettlement(queueId);
    await Promise.all([
      admissionCancellation?.settlement,
      promotedCancellation?.settlement,
    ]);
    admission.settleDispatchAcceptance?.({
      accepted: false,
      error: 'Queue item was cancelled',
    });
    promotedCancellation?.item.settleDispatchAcceptance?.({
      accepted: false,
      error: 'Queue item was cancelled',
    });
    await notifyQueuedTurnStopped(promotedCancellation?.item ?? admission);
    if (!admission.beforeUserPersistence) broadcast('queue:cancelled', { queueId });
    console.log(`[agent] Queue item ${queueId} cancelled during builtin turn admission`);
    return { status: 'cancelled', cancelledText: admission.messageText };
  }

  const promotedCancellation = cancelPromotedItemWithSettlement(queueId);
  if (promotedCancellation !== null) {
    await promotedCancellation.settlement;
    promotedCancellation.item.settleDispatchAcceptance?.({
      accepted: false,
      error: 'Queue item was cancelled',
    });
    await notifyQueuedTurnStopped(promotedCancellation.item);
    console.log(`[agent] Queue item ${queueId} cancellation requested during runtime promotion`);
    return { status: 'cancelled', cancelledText: promotedCancellation.item.messageText };
  }

  console.log(`[agent] Queue item ${queueId} not found — already consumed or never existed`);
  return { status: 'not_found' };
}

export async function cancelQueuedTurnsByOwner(owner: TurnOwner): Promise<number> {
  const matches = (candidate: TurnOwner | undefined) =>
    candidate?.kind === owner.kind && candidate.id === owner.id;
  const queueIds = new Set<string>();
  for (const item of getMessageQueue()) {
    if (matches(item.turnOwner)) queueIds.add(item.id);
  }
  for (const item of getPendingMidTurnQueue()) {
    if (matches(item.sourceItem.turnOwner)) queueIds.add(item.queueId);
  }
  for (const item of getTurnBoundaryQueue()) {
    if (matches(item.sourceItem?.turnOwner) || matches(item.admissionTicket?.turnOwner)) {
      queueIds.add(item.queueId);
    }
  }
  const promoted = getPromotedTurnIdentity();
  if (promoted && matches(promoted.owner)) queueIds.add(promoted.queueId);
  const admission = getTurnAdmissionIdentity();
  if (admission && matches(admission.owner)) queueIds.add(admission.queueId);

  let canceled = 0;
  for (const queueId of queueIds) {
    if ((await cancelQueueItem(queueId)).status === 'cancelled') canceled += 1;
  }
  return canceled;
}

/**
 * Force-execute a queued message: move it to front of its queue and
 * interrupt the current turn so it runs immediately when the turn winds
 * down.
 *
 * Queue locations to handle:
 *   - queueState.messageQueue: not yet consumed by generator. Move to queueState.messageQueue[0].
 *   - queueState.pendingMidTurnQueue: deferred-yield buffer (NOT yielded to SDK).
 *     Move to queueState.pendingMidTurnQueue[0] so the next promote picks it up.
 *   - queueState.turnBoundaryQueue: desktop turn-mode buffer. Move to
 *     queueState.turnBoundaryQueue[0] so the next clean turn boundary starts it.
 *
 * Either way, interruptCurrentResponse fires the prior turn's wind-down →
 * handleMessageComplete/Stopped → promotePendingMidTurnItem (or
 * generator's next waitForMessage drain of queueState.messageQueue) wakes the
 * generator with our target as the next message.
 */
export async function forceExecuteQueueItem(queueId: string): Promise<boolean> {
  const location = findQueueLocation({
    messageIndex: getMessageQueue().findIndex(item => item.id === queueId),
    pendingMidTurnIndex: getPendingMidTurnQueue().findIndex(p => p.queueId === queueId),
    turnBoundaryIndex: getTurnBoundaryQueue().findIndex(item => item.queueId === queueId),
    inFlight: getInFlightQueueId() === queueId,
  });
  // (v0.2.12 Codex review fix #3) The in-flight item still shows the ▷
  // play button in the UI ("已发送但还没被 AI 看见 — 我想立刻处理"). It
  // doesn't live in either queue any more (already yielded to CLI), so
  // the legacy "move to front of queue + interrupt" path returns 404
  // for it. Instead, just force the current turn to wind down so CLI's
  // post-abort drainCommandQueue immediately processes whatever's
  // in commandQueue (including our in-flight item).
  const isInFlight = location?.location === 'in-flight';

  if (!location) return false;

  // Move target to front of its queue so it's first when the turn ends.
  moveQueuedItemToFront(queueId);

  if (location.location === 'turn-boundary' && !isTurnInFlight()) {
    return startNextTurnQueuedItem('recovery', {
      forceQueueId: queueId,
      allowRealtimePending: true,
    });
  }

  if (isSessionActive()) {
    // Issue #289: if the target is already in-flight to the CLI, mark it so the
    // graceful-interrupt `result` SURFACES it (it's about to be drained + processed
    // by the SDK) instead of dropping it from the UI like a plain stop would.
    if (isInFlight) {
      setForceSurfaceInFlightId(queueId);
    } else if (location.location === 'turn-boundary') {
      setForceTurnBoundaryQueueId(queueId);
    }
    await interruptCurrentResponse();
  } else {
    // Session 已死：generator 不存在，无人消费队列。
    // 启动新 session 来处理队列中的消息。
    if (location.location === 'turn-boundary') {
      return startNextTurnQueuedItem('recovery', {
        forceQueueId: queueId,
        allowRealtimePending: true,
      });
    }
    console.log('[agent] forceExecuteQueueItem: session dead, starting new session');
    resetPreWarmFailCount();
    // Defer to next tick (same reason as enqueueUserMessage: prevent event loop blocking)
    setTimeout(() => {
      startStreamingSession().catch((error) => {
        console.error('[agent] forceExecuteQueueItem: failed to start session', error);
      });
    }, 0);
  }
  return true;
}

/**
 * Get current queue status — list of queued items with their IDs and preview text.
 */
export function getQueueStatus(): Array<{ id: string; messagePreview: string }> {
  return queueGetQueueStatus();
}

/**
 * 时间回溯：截断对话历史 + 即时回退文件状态。
 * 持久 session 下 subprocess 存活，可直接调用 rewindFiles（无需临时 session）。
 */
export async function rewindSession(userMessageId: string): Promise<{
  success: boolean;
  error?: string;
  content?: string;
  attachments?: MessageWire['attachments'];
  skippedLinks?: number;
  fileRewindStatus?: FileRewindStatus;
}> {
  const doRewind = async () => {
    const productSessionId = sessionId;
    // 1. 找到目标 user message
    const targetIndex = transcriptState.messages.findIndex(m => m.id === userMessageId && m.role === 'user');
    if (targetIndex < 0) return { success: false as const, error: 'Message not found' };
    const targetMessage = transcriptState.messages[targetIndex];

    // 2. 两个 UUID 分离：
    //    - lastAssistantUuid → 用于 resumeSessionAt（截断 SDK 会话历史到目标前的 assistant）
    //    - targetMessage.sdkUuid → 用于 rewindFiles（文件检查点按 user message 打点）
    //    SDK 文档：rewindFiles(userMessageUuid) — 检查点关联用户消息，非 assistant 消息
    let lastAssistantUuid: string | undefined;
    for (let i = targetIndex - 1; i >= 0; i--) {
      if (transcriptState.messages[i].role === 'assistant' && transcriptState.messages[i].sdkUuid) {
        lastAssistantUuid = transcriptState.messages[i].sdkUuid;
        break;
      }
    }

    // 3. 在活跃 session 上执行 rewindFiles（文件检查点关联 user message UUID）
    //    跳过已被 force-abort 的 session：subprocess 正在死亡，发 IPC 会阻塞到超时（~100s）。
    //    跳过不属于当前 session 的 UUID：SDK 不认识，调用必定失败且日志噪声。
    //    跳过无 sdkUuid 的用户消息：旧存储加载或 SDK 尚未回传 UUID。
    const targetUserUuid = targetMessage.sdkUuid;
    const fileRewind = await attemptFileRewind({
      query: lifecycleState.query,
      targetUserUuid,
      abortRequested: lifecycleState.abortRequested,
      isCurrentSessionUuid: Boolean(targetUserUuid && transcriptState.currentSessionUuids.has(targetUserUuid)),
    });
    const { skippedLinks, fileRewindStatus } = fileRewind;
    if (fileRewind.diagnostics) {
      console.log(
        '[agent] rewindFiles result:'
        + ` canRewind=${fileRewind.diagnostics.canRewind}`
        + ` filesChanged=${fileRewind.diagnostics.filesChanged}`
        + ` insertions=${fileRewind.diagnostics.insertions}`
        + ` deletions=${fileRewind.diagnostics.deletions}`
        + ` skippedLinks=${skippedLinks}`,
      );
    }
    if (fileRewindStatus === 'partial') {
      console.warn(`[agent] rewindFiles partially restored files: skippedLinks=${skippedLinks}`);
    } else if (fileRewindStatus === 'failed') {
      console.error('[agent] rewindFiles failed or was refused (details withheld from logs)');
    } else if (!targetUserUuid) {
      console.log('[agent] rewind: target user message has no sdkUuid, skipping rewindFiles');
    }

    // 4. 中止当前 session（需要新 session 用 resumeSessionAt 截断 SDK 历史）
    abortPersistentSession();
    // Explicit cancel — broadcasts queue:cancelled so frontend clears pills.
    drainQueueWithCancellation();
    await awaitSessionTermination(10_000, 'rewind');
    resetAbortFlag();

    // 5. 收集被删消息内容（恢复到输入框）
    const removedContent = typeof targetMessage.content === 'string' ? targetMessage.content : '';
    const removedAttachments = targetMessage.attachments;

    // 6. Decide whether the existing SDK transcript can remain the execution
    // identity. This decision is made before persistence so a fresh branch can
    // commit the transcript truncation and SDK binding replacement together.
    //    UUID 有效性校验（OR 逻辑）：
    //    - transcriptState.liveSessionUuids: SDK subprocess stdout 确认过的 UUID（权威但不完整 — resume 后
    //      SDK 不会重新输出旧历史的 UUID）
    //    - transcriptState.currentSessionUuids: 包含磁盘种子 + 运行时 UUID（覆盖 resume 前的历史）
    //
    //    分支：
    //      A. uuidIsLive=true        → 设 anchor，传给 SDK 截断
    //      B. 锚点 stale 但 session 仍活跃 → 仅清 anchor，**保留 session id** (#189 修复)
    //      C. 没有锚点 / session 未注册 → Product Session 不变，仅换 fresh SDK identity
    //
    //    **注意**：这两个集合只是 MyAgents 自己的视角，**不是 SDK 持久化状态的权威 proxy**。
    //    MyAgents 的 JSONL 与 SDK 的 JSONL (~/.claude/projects/.../*.jsonl) 是双份存储、
    //    异步独立写入（CLAUDE.md「双重存储」节）。SDK subprocess 在 flush 完成前被
    //    interrupt，会留下 MyAgents 有 / SDK 没有 的 UUID。所以"UUID 不在本地集合"
    //    **不能**推出"SDK session 已被重建"。
    //
    //    issue #189 修复（v0.2.15）：anchor stale 时走分支 B —— 保留 session id，仅清掉
    //    截断锚点。下次 pre-warm 走 `resume: sessionId` 加载 SDK 全量历史。Trade-off：
    //    AI 看到的历史可能比 UI 截断后更多（短期分歧），但绝对优于上下文全失忆。
    //    这一行为与 catch-block 的 "No message found" recovery (~line 9219) 对齐 —
    //    SDK 真正拒绝 anchor 时也走同样语义。
    const uuidIsLive = sessionRegistered && lastAssistantUuid
      && (transcriptState.liveSessionUuids.has(lastAssistantUuid) || transcriptState.currentSessionUuids.has(lastAssistantUuid));
    const requiresFreshSdkIdentity = !uuidIsLive && !(lastAssistantUuid && sessionRegistered);
    let freshSdkIdentity: {
      sourceSdkSessionId: string | null;
      replacementSdkSessionId: string;
    } | undefined;
    if (requiresFreshSdkIdentity) {
      const metadata = getSessionMetadata(productSessionId);
      freshSdkIdentity = {
        sourceSdkSessionId: metadata ? (resolveBuiltinSdkSessionId(metadata) ?? null) : null,
        replacementSdkSessionId: randomUUID(),
      };
    }

    // SessionStore validates and commits the durable truncation before the
    // live/UI projection changes. When SDK history cannot be reused, the same
    // bounded intent also replaces only A's SDK binding (S1 -> S2).
    await truncateTranscriptPersistenceForRewind(
      productSessionId,
      targetMessage.id,
      targetIndex,
      freshSdkIdentity,
    );
    truncateMessages(targetIndex);

    // 7. 设置下次 query 的对话截断点 — 三分支决策树
    if (uuidIsLive) {
      pendingResumeSessionAt = lastAssistantUuid;
    } else if (lastAssistantUuid && sessionRegistered) {
      // Anchor 不在本地集合，但 session 仍然有效（SDK 已注册过此 session）。
      // 不要重建 session — 仅放弃 resumeSessionAt 截断。
      console.warn(`[agent] rewind: skipping resumeSessionAt — UUID ${lastAssistantUuid} not in live(${transcriptState.liveSessionUuids.size}) or current(${transcriptState.currentSessionUuids.size}) session (stale/rebuilt). Preserving session id (#189); SDK will resume with full history.`);
      pendingResumeSessionAt = undefined;
      // Symmetric eviction with catch-block recovery (line ~9227): drop the stale
      // UUID so subsequent rewinds don't pass the uuidIsLive OR-check and re-enter
      // a path that would just be rejected by the SDK again. (No-op if absent.)
      deleteCurrentSessionUuid(lastAssistantUuid);
      // 关键：**不**修改 sessionId / sessionRegistered / hasInitialPrompt。
      // 下次 startStreamingSession 会用 resume: sessionId 加载 SDK 全量历史。
    } else {
      // 两种合法的"fresh SDK start"场景：
      //   (a) lastAssistantUuid 为 undefined：rewind 到第一条 user message 之前 / 无 SDK
      //       tracked assistant —— 没有 SDK 上下文可保留
      //   (b) sessionRegistered=false：SDK 从未注册过这个 session（首次 pre-warm 失败等）
      pendingResumeSessionAt = undefined;
      sessionRegistered = false;
      setPendingReloadAnchor(undefined);
      clearCurrentSessionUuids();
      clearLiveSessionUuids();
      // Product Session A, its transcript cursor, title, config and Sidecar
      // ownership remain unchanged. Only the persisted SDK identity is fresh.
    }

    // 8. 预热下次 session
    schedulePreWarm();

    return {
      success: true as const,
      content: removedContent,
      attachments: removedAttachments,
      fileRewindStatus,
      ...(skippedLinks > 0 ? { skippedLinks } : {}),
    };
  };

  const promise = runSerializedSessionMutation(doRewind);
  rewindPromise = promise;
  try {
    return await promise;
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    if (detail.includes('stale-cursor')) {
      return { success: false, error: 'Conversation history changed during rewind; reopen the session before trying again.' };
    }
    if (detail.includes('malformed-transcript')) {
      return { success: false, error: 'Conversation history contains data that cannot be safely rewound.' };
    }
    return { success: false, error: `Failed to persist rewind: ${detail}` };
  } finally {
    rewindPromise = null;
  }
}

/**
 * Fork session: create a new independent session branching from a specific assistant message.
 * Non-destructive — the current session remains untouched.
 * The new session uses SDK's forkSession option on first startup.
 */
/**
 * PRD 0.2.27 — eager fork via the standalone SDK `forkSession()` function (gated by
 * AppConfig.eagerFork, a developer toggle in Settings→About, DEFAULT ON; off → lazy forkFrom
 * path). Creates the fork's SDK transcript up front, rebuilds the old→new sdkUuid map at SDK granularity,
 * and re-stamps our copied rows so the forked session resumes as a plain session (no forkFrom
 * state machine, no fork-at-tail degradation). Returns `ok:false` — caller falls back to the
 * lazy path — on a turn-in-flight / not-yet-flushed anchor / SDK error / ANY structural
 * mismatch, and cleans up the orphan SDK session on a post-fork failure. See
 * specs/prd/prd_0.2.27_fork_standalone_migration.md.
 */
async function tryEagerFork(opts: {
  sourceSdkSid: string;
  anchorUuid: string;
  dir: string;
  forkedMessages: SessionMessage[];
}): Promise<{ ok: true; newSid: string; remapped: SessionMessage[] } | { ok: false; reason: string }> {
  const { sourceSdkSid, anchorUuid, dir, forkedMessages } = opts;
  const errMsg = (e: unknown) => (e instanceof Error ? e.message : String(e));

  // Flush gate ①: never eager-fork while the source session is BUSY (turn in flight /
  // streaming / queued / mid-turn buffered) — its tail may be mid-write. Use isSessionBusy()
  // (the single source of truth for "safe to mutate"), NOT lifecycleState.processing: lifecycleState.processing is true
  // for an alive persistent subprocess even when idle, so gating on it would make the eager
  // path unreachable in the normal (idle) fork flow — it would always fall back to lazy.
  if (isSessionBusy()) return { ok: false, reason: 'source session is busy' };

  // Flush gate ②: the anchor must already be flushed into the source SDK transcript; reuse
  // that transcript (sliced to the anchor) as the LHS of the remap.
  let srcSdk: Awaited<ReturnType<typeof sdkGetSessionMessages>>;
  try {
    srcSdk = await sdkGetSessionMessages(sourceSdkSid, { dir });
  } catch (e) {
    return { ok: false, reason: `source getSessionMessages failed: ${errMsg(e)}` };
  }
  const anchorIdx = srcSdk.findIndex(m => m.uuid === anchorUuid);
  if (anchorIdx < 0) return { ok: false, reason: 'anchor not yet flushed to source SDK transcript' };
  const srcSliced = srcSdk.slice(0, anchorIdx + 1);

  // Re-check right before the SDK fork: a turn may have started during the getSessionMessages
  // await (gate ① is not an atomic admission lock). This narrows the window; a concurrent
  // append AFTER the anchor is additionally self-defending — the slice/remap is over the
  // immutable up-to-anchor prefix, so any structural change makes buildForkUuidRemap return
  // ok:false → clean fallback. (A full fork-admission lock is a pre-default-ON follow-up.)
  if (isSessionBusy()) return { ok: false, reason: 'source became busy during fork prep' };

  // Eager SDK fork (copies + remaps uuids into a new session file under `dir`).
  let newSid: string;
  try {
    const res = await sdkForkSession(sourceSdkSid, { upToMessageId: anchorUuid, dir });
    newSid = res.sessionId;
  } catch (e) {
    return { ok: false, reason: `sdkForkSession failed: ${errMsg(e)}` };
  }

  // From here the SDK fork file exists — clean it up on any failure before falling back.
  // Guard `newSid !== sourceSdkSid` so cleanup can NEVER touch the source (defensive).
  const fail = async (reason: string): Promise<{ ok: false; reason: string }> => {
    if (newSid !== sourceSdkSid) {
      try { await sdkDeleteSession(newSid, { dir }); } catch { /* orphan cleanup is best-effort */ }
    }
    return { ok: false, reason };
  };

  // Defensive: the SDK returns a fresh UUID, but never adopt an id that already names a
  // MyAgents session (corrupt sessions.json / hypothetical SDK reuse) — clean up + fall back.
  if (getSessionMetadata(newSid)) {
    return fail(`fork id collides with an existing MyAgents session: ${newSid}`);
  }

  let forkSdk: Awaited<ReturnType<typeof sdkGetSessionMessages>>;
  try {
    forkSdk = await sdkGetSessionMessages(newSid, { dir });
  } catch (e) {
    return fail(`fork getSessionMessages failed: ${errMsg(e)}`);
  }

  const remap = buildForkUuidRemap(srcSliced, forkSdk);
  if (!remap.ok) return fail(`uuid remap failed: ${remap.reason}`);

  const applied = remapStoredSdkUuids(forkedMessages.map(m => m.sdkUuid), remap.map);
  if (!applied.ok) return fail(`stored uuid re-stamp failed: ${applied.reason}`);
  const remapped = forkedMessages.map((m, i) => ({ ...m, sdkUuid: applied.remapped[i] }));

  return { ok: true, newSid, remapped };
}

export async function forkSession(assistantMessageId: string): Promise<{
  success: boolean;
  newSessionId?: string;
  agentDir?: string;
  title?: string;
  error?: string;
}> {
  // 1. Find target assistant message in memory first, then fall back to persistent storage.
  // The in-memory `transcriptState.messages[]` may be empty after session switch/reset (clearMessageState),
  // while the frontend still shows the fork button because it has the message from loaded state.
  console.log(`[agent] forkSession: looking for assistantMessageId=${assistantMessageId}, in-memory transcriptState.messages.length=${transcriptState.messages.length}, sessionId=${sessionId}`);
  console.log(`[agent] forkSession: in-memory message IDs (last 20): ${transcriptState.messages.slice(-20).map(m => `${m.role}:${m.id}`).join(', ')}`);
  let targetIndex = transcriptState.messages.findIndex(m => m.id === assistantMessageId && m.role === 'assistant');
  let messageSource = transcriptState.messages;

  if (targetIndex < 0) {
    // Fallback: load from persistent storage — covers race between clearMessageState
    // and loadMessagesFromStorage during session switch/pre-warm.
	    const stored = getSessionData(sessionId);
	    if (stored?.messages) {
	      const storedIdx = stored.messages.findIndex(m => m.id === assistantMessageId && m.role === 'assistant');
	      if (storedIdx >= 0) {
        console.log(`[agent] forkSession: message ${assistantMessageId} not in memory, found in storage`);
        // Use stored transcriptState.messages directly for fork (they already have sdkUuid persisted)
        targetIndex = storedIdx;
	        messageSource = stored.messages.map(sessionMessageToMessageWire);
      }
    }
  }

  if (targetIndex < 0) {
    console.error(`[agent] forkSession: Assistant message NOT FOUND. assistantMessageId=${assistantMessageId}, in-memory count=${transcriptState.messages.length}, sessionId=${sessionId}`);
    return { success: false, error: 'Assistant message not found' };
  }
  const targetMsg = messageSource[targetIndex];
  if (!targetMsg.sdkUuid) return { success: false, error: 'Message has no SDK UUID (cannot fork)' };

  // UUID validity check: only enforce for STORAGE-loaded transcriptState.messages (messageSource !== transcriptState.messages).
  // In-memory transcriptState.messages are trusted — their UUIDs were assigned during this process's lifetime.
  // After rewind, transcriptState.currentSessionUuids is cleared (new SDK session), but pre-rewind transcriptState.messages
  // remain in memory with valid UUIDs (SDK's resumeSessionAt preserves earlier history).
  // Storage-loaded transcriptState.messages may come from a different SDK session, so enforce UUID freshness.
  const isFromStorage = messageSource !== transcriptState.messages;
  if (isFromStorage && transcriptState.currentSessionUuids.size > 0 && !transcriptState.currentSessionUuids.has(targetMsg.sdkUuid)) {
    return { success: false, error: 'SDK UUID 已过期（当前 SDK session 不包含此消息），请重新发送后再 fork' };
  }

  // 2. Get current session info for the fork source
  const sourceSessionId = sessionId; // unifiedSession: id === SDK session ID
  const currentAgentDir = agentDir;
  const sourceMeta = getSessionMetadata(sourceSessionId);
  const sourceTitle = sourceMeta?.title || 'Chat';

  try {
    // Common: inherited config snapshot + the copied message slice (both fork paths use them).
    // v0.1.69: Inherit the source session's snapshot (model/permission/mcp/provider/runtime).
    // Forking from a "locked" Desktop session yields a locked clone with the same config —
    // Branching off a conversation should not silently change AI behavior. The user can
    // still PATCH the forked session afterward to detach it.
    const inheritedSnapshot: Partial<typeof sourceMeta> = sourceMeta ? {
      runtime: sourceMeta.runtime,
      model: sourceMeta.model,
      permissionMode: sourceMeta.permissionMode,
      mcpEnabledServers: sourceMeta.mcpEnabledServers ? [...sourceMeta.mcpEnabledServers] : undefined,
      providerId: sourceMeta.providerId,
      providerEnvJson: sourceMeta.providerEnvJson,
      configSnapshotAt: sourceMeta.configSnapshotAt,
    } : {};

    // Copy transcriptState.messages up to and including the fork point (sdkUuid preserved here; the EAGER
    // path re-stamps them to the fork's new uuids before persisting).
    const forkedMessages: SessionMessage[] = messageSource
      .slice(0, targetIndex + 1)
      .map(messageWireToSessionMessage);

    // PRD 0.2.27 — EAGER fork (AppConfig.eagerFork, developer toggle in Settings→About, DEFAULT
    // ON; flip off → lazy path). Create the SDK fork up front + re-stamp our rows' sdkUuids, so
    // the fork resumes as a plain session with NO forkFrom state machine (#134/#135) and NO
    // fork-at-tail degradation (#220). Any decline (source busy / anchor not flushed / structural
    // mismatch) cleanly falls back below. Read disk-first (config.json is authoritative; fork is
    // a rare user action so a sync read is fine). Missing field ⇒ on.
    if (loadAdminConfig().eagerFork !== false) {
      const eager = await tryEagerFork({
        sourceSdkSid: sourceMeta?.sdkSessionId ?? sourceSessionId,
        anchorUuid: targetMsg.sdkUuid,
        dir: currentAgentDir,
        forkedMessages,
      });
      if (eager.ok) {
        // Unified session: use the SDK's returned fork id as OUR session id AND sdkSessionId,
        // so switchToSession (`sessionMeta.sdkSessionId` → sessionRegistered=true) resumes the
        // already-created SDK fork file on first start instead of trying to create it (which
        // would collide). No forkFrom. (Codex review #5.)
        const newSession = createSessionMetadata(currentAgentDir, inheritedSnapshot);
        newSession.id = eager.newSid;
        newSession.sdkSessionId = eager.newSid;
        newSession.unifiedSession = true;
        newSession.title = `🌿 ${sourceTitle}`;
        newSession.titleSource = 'auto';
        newSession.origin = { kind: 'desktop', surface: 'session_fork' };
        try {
          await saveSessionMetadata(newSession);
          await saveForkTranscript(newSession.id, eager.remapped);
        } catch (persistErr) {
          // Persist threw AFTER the SDK fork file was created — clean up the orphan SDK
          // transcript so we don't leak it, then let the outer catch surface the failure.
          try { await sdkDeleteSession(eager.newSid, { dir: currentAgentDir }); } catch { /* best-effort */ }
          throw persistErr;
        }
        console.log(`[agent] forked session (EAGER) ${sourceSessionId} → ${newSession.id} at ${assistantMessageId}, ${eager.remapped.length} transcriptState.messages, sdkUuids remapped`);
        return { success: true, newSessionId: newSession.id, agentDir: currentAgentDir, title: newSession.title };
      }
      console.warn(`[agent] eager fork declined (${eager.reason}) — falling back to lazy forkFrom path`);
    }

    // Default: lazy fork — write forkFrom + copied rows (old uuids); the SDK fork is
    // materialized at the forked session's first startup via query({ forkSession: true }).
    const newSession = createSessionMetadata(currentAgentDir, inheritedSnapshot);
    newSession.title = `🌿 ${sourceTitle}`;
    newSession.titleSource = 'auto';
    newSession.origin = { kind: 'desktop', surface: 'session_fork' };
    newSession.forkFrom = {
      sourceSessionId,
      messageUuid: targetMsg.sdkUuid,
    };
    await saveSessionMetadata(newSession);
    await saveForkTranscript(newSession.id, forkedMessages);

    console.log(`[agent] forked session ${sourceSessionId} → ${newSession.id} at message ${assistantMessageId} (sdkUuid: ${targetMsg.sdkUuid}), ${forkedMessages.length} transcriptState.messages copied`);

    return {
      success: true,
      newSessionId: newSession.id,
      agentDir: currentAgentDir,
      title: newSession.title,
    };
  } catch (err) {
    console.error('[agent] forkSession failed:', err);
    return { success: false, error: err instanceof Error ? err.message : 'Fork failed' };
  }
}

/**
 * Exact MyAgents Record CLI forms that may bypass a second desktop approval.
 * This stays Record-specific: it is a safety policy for one bounded product
 * surface, not a general shell parser or command allowlist framework.
 */
export function isAutoAllowedRecordCliCommand(command: string): boolean {
  const cmd = command.trim();
  return (
    /^myagents[ \t]+record[ \t]+list(?:[ \t]+(?:--kind[ \t]+(?:text|audio)|--tag[ \t]+[a-z0-9][a-z0-9-]{0,31}|--limit[ \t]+\d{1,4}|--json))*[ \t]*$/.test(cmd)
    || /^myagents[ \t]+thought[ \t]+list(?:[ \t]+(?:--tag[ \t]+[a-z0-9][a-z0-9-]{0,31}|--limit[ \t]+\d{1,4}|--json))*[ \t]*$/.test(cmd)
    || /^myagents[ \t]+(?:record|thought)[ \t]+create[ \t]+(?:--content[ \t]+)?'[^']*'[ \t]*$/.test(cmd)
    || /^myagents[ \t]+(?:record|thought)[ \t]+create[ \t]+--content-file[ \t]+[^ \t\n\r;|&<>$`'"]+[ \t]*$/.test(cmd)
  );
}

async function startStreamingSession(preWarm = false): Promise<void> {
  const sessionMutationBarrier = getSessionMutationBarrier();
  if (sessionMutationBarrier) await sessionMutationBarrier;
  await resolvePendingBuiltinConversationMutationForActiveSession();
  await awaitSessionTermination(10_000, 'startStreamingSession');

  // (issue #174) Cold-start abort race: enqueueUserMessage schedules this
  // function via setTimeout(0) after pushing to queueState.messageQueue. If the user
  // presses Stop before the timer fires, interruptCurrentResponse's
  // 'starting' branch sets lifecycleState.abortRequested=true and drains queueState.messageQueue —
  // but the unconditional `lifecycleState.abortRequested = false` reset further down
  // in this function would silently re-arm the launch. Bail out here
  // instead. Pre-warm doesn't enter this race (it's not user-driven) so
  // the guard is gated on !preWarm.
  if (lifecycleState.abortRequested && !preWarm) {
    // Defense-in-depth (v0.2.14 dogfood): differentiate the two paths that
    // can arrive here:
    //   * User-Stop path — interruptCurrentResponse('starting') drains
    //     queueState.messageQueue BEFORE setting the abort flag, so the queue is
    //     empty when we get here. No agent-error needed (the user pressed
    //     Stop themselves; surfacing an error banner would be misleading).
    //   * Stale-flag path — some upstream code path set lifecycleState.abortRequested=true
    //     and forgot to reset before enqueuing the next user message
    //     (the original v0.2.14 dogfood was the third-party→Anthropic
    //     provider switch in enqueueUserMessage; that specific leak is now
    //     fixed at the source, but this defense catches any future leaks).
    //     Queue holds the user's just-enqueued message → without an
    //     explicit error broadcast, the renderer sees the message-replay,
    //     the queue:cancelled, and chat:status idle, but NO chat:agent-error
    //     → the #183 retry banner doesn't fire and the user is left
    //     wondering why their message vanished without a trace.
    const droppedCount = getMessageQueue().length;
    console.log(
      `[agent] startStreamingSession: aborted pre-launch by stop during starting (droppedQueued=${droppedCount})`,
    );
    resetAbortFlag();
    drainQueueWithCancellation();
    if (droppedCount > 0) {
      const errorMessage = '消息发送被中断，请重新发送';
      lastAgentError = errorMessage;
      broadcast('chat:agent-error', { message: errorMessage });
    }
    if (sessionState === 'starting') {
      setSessionState('idle');
    }
    return;
  }

  if (lifecycleState.processing || lifecycleState.query) {
    return;
  }

  // The fresh subprocess about to spawn reads the latest configState.currentModel /
  // configState.currentMcpServers / configState.currentAgentDefinitions / configState.currentProviderEnv via
  // `buildClaudeSessionEnv()` + `buildSdkMcpServers()` below — every entry in
  // `pendingConfigRestart` is satisfied at spawn by definition. Drain the latch
  // (and cancel any orphaned lifecycleState.preWarmTimer scheduled by a predecessor's finally
  // block) so a stale timer firing ~500ms later doesn't apply a "batched config
  // restart" against *this* freshly-configured subprocess and silently kill an
  // in-flight direct user message. Mirrors `forceRestartActiveSessionForMcp`
  // (search "we drive restart"): when *this* call is the legitimate restart,
  // any latched reason is by construction redundant. Reasons added AFTER this
  // point (e.g. config edits during spawn / first turn) latch normally and
  // drain at the next pre-warm timer or turn-complete handler.
  if (hasDeferredRestart()) {
    const reasons = drainDeferredRestart();
    console.log(`[agent] ${preWarm ? 'pre-warm' : 'start'} session: dropping satisfied deferred reasons (${reasons})`);
  }
  if (lifecycleState.preWarmTimer) {
    clearPreWarmTimer();
  }

  setPreWarmInProgress(preWarm);
  if (configState.pendingProviderHistoryBoundaryReset) {
    console.log('[agent] applying deferred provider history boundary reset before SDK start');
    await resetForProviderHistoryBoundary();
  }
  const adminConfigForSession = loadAdminConfig();
  const cliToolRegistryEnabled = isCliToolRegistryEnabled(adminConfigForSession);
  // One resolver owns UI and Runtime admission. The same inventory and
  // project-winner snapshot also drive the compatibility projection before
  // launch, so every Runtime observes one canonical result.
  let launchCapabilitySnapshot: EffectiveProjectCapabilitySnapshot;
  let unavailableBuiltinSkillNames: string[] = [];
  try {
    const globalSkillInventory = createGlobalSkillInventorySnapshot({ cliToolRegistryEnabled });
    launchCapabilitySnapshot = resolveEffectiveProjectCapabilities(agentDir, { globalSkillInventory });
    unavailableBuiltinSkillNames = trySyncProjectUserConfigFiles(agentDir, {
      cliToolRegistryEnabled,
      globalSkillInventory,
      capabilitySnapshot: launchCapabilitySnapshot,
    }).unavailableSkillNames;
  } catch (error) {
    const message = `Workspace capability admission failed: ${error instanceof Error ? error.message : String(error)}`;
    console.error(`[agent] ${message}`);
    lastAgentError = message;
    const hadQueuedInput = getMessageQueue().length > 0;
    if (!preWarm || hadQueuedInput) {
      drainQueueWithCancellation();
      broadcast('chat:agent-error', { message });
    }
    // Capability projection happens before the ordinary Query try/finally.
    // Release the pre-warm owner here so a failed replacement cannot strand
    // its requeued user message behind a permanently "pre-warming" Session.
    setPreWarmInProgress(false);
    setSessionState('idle');
    return;
  }
  ensureGitignorePattern(agentDir, SESSION_PLANS_GITIGNORE_PATTERN);
  // PRD #124: register a FRESH bridge token for this SDK subprocess.
  // `freshToken: true` retires the previous token (if any) so any late
  // requests from the dying old subprocess get rejected with a 400
  // "unknown bridge token" instead of resolving to the new subprocess's
  // config (the cross-pollination class we're eliminating).
  ensureActiveSessionBridgeRegistered({ freshToken: true });
  const launchProviderId = getSessionProviderId() ?? SUBSCRIPTION_PROVIDER_ID;
  const launchAgentDefinitionsSource = configState.currentAgentDefinitions;
  const launchContextWindowSnapshot = snapshotProviderModelContextLengths([
    configState.currentModel,
    ...Object.values(configState.currentProviderEnv?.modelAliases ?? {}),
    ...Object.values(launchAgentDefinitionsSource ?? {}).map(agent => agent.model),
  ], launchProviderId);
  const env = buildClaudeSessionEnv(undefined, undefined, {
    bridgeToken: activeSessionBridgeToken ?? undefined,
    providerId: launchProviderId,
    contextWindowSnapshot: launchContextWindowSnapshot,
  });
  const launchModel = applyContextWindowSuffixForContextLength(
    configState.currentModel,
    lookupSnapshotModelContextLength(launchContextWindowSnapshot, configState.currentModel),
  );
  const launchAgentDefinitions = launchAgentDefinitionsSource
    ? Object.fromEntries(
        Object.entries(launchAgentDefinitionsSource).map(([name, agent]) => [
          name,
          agent.model
            ? {
                ...agent,
                model: applyContextWindowSuffixForContextLength(
                  agent.model,
                  lookupSnapshotModelContextLength(launchContextWindowSnapshot, agent.model),
                ),
              }
            : agent,
        ]),
      )
    : null;
  console.log(`[agent] ${preWarm ? 'pre-warm' : 'start'} session cwd=${agentDir}`);
  resetAbortFlag();
  resetAbortFlag();
  setSessionProcessing(true);
  // Only clear UUID tracking for brand-new sessions.
  // For resume sessions (sessionRegistered=true), loadMessagesFromStorage has already
  // seeded transcriptState.currentSessionUuids from disk — clearing them here would break rewind
  // during the pre-warm window (before SDK system_init re-populates via stdout events).
  if (!sessionRegistered) {
    clearCurrentSessionUuids();
  }
  // transcriptState.liveSessionUuids 始终清除 — 新的 subprocess 尚未输出任何消息，
  // 直到 SDK stdout 事件重新填充后才能作为 resumeSessionAt 的权威来源。
  clearLiveSessionUuids();
  let preWarmStartedOk = false; // Tracks whether pre-warm received system_init
  let abortedByTimeout = false; // Distinguishes timeout abort from config-change abort
  let detectedAlreadyInUse = false; // stderr reported "Session ID already in use"
  let sdkLaunchRetryDelayMs: number | undefined;
  const recentSdkStderr: string[] = [];
  streamIndexToToolId.clear();
  streamIndexToBlockType.clear();
  imTextBlockIndices.clear();

  // (issue #174) Broadcast 'starting' (not 'running') here: the SDK subprocess
  // has just been launched and system_init hasn't arrived yet. The for-await
  // loop below transitions to 'running' once system_init lands. Pre-warm stays
  // 'idle' as before — pre-warmed sessions are invisible to the UI until the
  // first user message lifts them into the active path.
  if (!preWarm) {
    setSessionState('starting');
  }

  let resolveTermination: () => void;
  setSessionTerminationPromise(new Promise((resolve) => {
    resolveTermination = resolve;
  }));

  // Declared outside try so finally can clean up
  let startupTimeoutId: ReturnType<typeof setTimeout> | undefined;
  let apiWatchdogId: ReturnType<typeof setInterval> | undefined;
  // PRD 0.2.27 — query-scoped copy of the reloadAnchor this start actually sent. Local
  // (not module) so a late catch from THIS invocation evicts the right uuid even if a
  // newer session has since re-armed the module-level transcriptState.pendingReloadAnchor.
  let sentReloadAnchor: string | undefined;

  // The exact SDK Query owns background-task liveness in lifecycle.ts so
  // deferred restart policy can see it. Whatever remains when this Query tears
  // down is transferred back to this finalizer and flushed as `stopped`.
  //
  // WHY: terminal events (task_notification / task_updated) are best-effort. When
  // the owning subprocess dies first — abort, deferred config restart, watchdog
  // kill, transport error — an in-flight background sub-agent emits NO terminal
  // event ever (the process that would emit it is gone). The renderer's Agent
  // Status Panel then shows it "后台运行中" permanently (all three of its
  // clear-defenses require a terminal event). Observed in production: ~7% of
  // background sub-agents (16/218 local_agent) stuck this way. The stored
  // toolUseId also backfills the task_updated terminal channel (its patch carries
  // none) so the renderer's persisted history fallback survives a reload.
  // Declared outside try so hooks, iterator events and finally share the exact
  // Query identity without falling back to mutable lifecycleState.query.
  let activeQuery: Query | null = null;
  let activeQueryAuthority: BuiltinQueryAuthority | null = null;
  const queryProductSessionId = sessionId;

  try {
    const sdkPermissionMode = mapToEffectiveSdkPermissionMode(
      configState.currentPermissionMode,
      currentScenario,
    );

    // Resolve SDK-compatible session ID for resume/create.
    // SDK requires valid UUID format for --resume (and --session-id).
    // Our internal sessionId may have a prefix (e.g., old cron-im-{uuid} format).
    const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
    let resumeFrom: string | undefined;
    let effectiveSdkSessionId: string;

    if (sessionRegistered) {
      // Prefer sdkSessionId from metadata (the actual ID the SDK knows)
      const meta = getSessionMetadata(sessionId);
      const sdkSid = meta?.sdkSessionId;

      if (sdkSid && UUID_RE.test(sdkSid)) {
        resumeFrom = sdkSid;
        effectiveSdkSessionId = sdkSid;
      } else if (UUID_RE.test(sessionId)) {
        resumeFrom = sessionId;
        effectiveSdkSessionId = sessionId;
      } else {
        // Non-UUID session ID (e.g., old cron-im-{uuid}) — cannot resume, start fresh
        console.warn(`[agent] Session ${sessionId} has non-UUID ID (sdkSid=${sdkSid}), cannot resume — starting fresh`);
        resumeFrom = undefined;
        effectiveSdkSessionId = randomUUID();
      }
    } else {
      resumeFrom = undefined;
      // A fresh launch may still have an explicitly persisted SDK identity
      // (for example, builtin Rewind replaced only the execution identity).
      // Create that exact candidate; do not mint a third identity.
      const meta = getSessionMetadata(sessionId);
      const sdkSid = meta && (meta.runtime ?? 'builtin') === 'builtin'
        ? resolveBuiltinSdkSessionId(meta)
        : undefined;
      effectiveSdkSessionId = sdkSid && UUID_RE.test(sdkSid)
        ? sdkSid
        : UUID_RE.test(sessionId)
          ? sessionId
          : randomUUID();
    }
    // sessionRegistered 不在此处修改 — 等待 system_init 确认

    // 读取 rewind 设置的对话截断点（不立即消费 — 等 system_init 确认后再清除）
    // 持久 session 模式下，pre-warm 即最终 session（用户消息通过 wakeGenerator 投递），
    // 必须在 pre-warm 时就传 resumeSessionAt，否则 SDK 会加载完整历史不截断
    // 延迟消费原因：如果 query 因 UUID 无效而启动失败，重试时仍需要 anchor；
    // catch block 的 "No message found" 恢复会主动清除无效 anchor 防止无限重试。
    const rewindResumeAt = pendingResumeSessionAt;

    // Fork detection: if this session was created via fork, override resume/sessionId
    // to use SDK's forkSession option (load source history + branch to new session).
    //
    // PRD #134/#135 — `forkFrom` is retained across restarts until the SDK
    // has demonstrably persisted the forked conversation to its on-disk
    // store (`~/.claude/projects/.../<sessionId>.jsonl`). The persistence
    // probe (`sdkGetSessionMessages(sdkSid)` after first non-error result —
    // see the result-message handler below) is what clears `forkFrom`,
    // *not* this start path.
    //
    // The original code deleted `forkFrom` HERE on the very first start,
    // before any SDK interaction. Two failure windows opened up:
    //  (a) User idle after fork → model switch → restart with no message
    //      ever sent → SDK never persisted → resume fails.
    //  (b) User sends message + switches model → first turn runs but
    //      SDK's JSONL flush is async; `setSessionModel`'s deferred
    //      restart fires on the same `result` message and races with
    //      the flush. Subprocess B's resume fails with "No conversation
    //      found" → `recoverFromStaleSession()` silently spawns a fresh
    //      SDK conversation → all forked context lost (#135 reports 40+
    //      failed turns in a single day before this fix).
    //
    // Keeping `forkFrom` lets every pre-flush restart re-run fork mode.
    // Re-forking is idempotent: SDK reloads the source history and writes
    // to the same new sessionId. Cost = a few hundred ms of source-history
    // reload per pre-flush restart. Acceptable vs. silent context loss.
    let forkMode = false;
    let forkResumeAt: string | undefined;
    const forkMeta = getSessionMetadata(sessionId);
    if (forkMeta?.forkFrom) {
      // PRD #134/#135 sync guard — before re-engaging fork mode, probe the
      // SDK's own store for `sessionId`. If the JSONL already exists with
      // ≥1 message, SDK has fully persisted: re-running fork mode here
      // would make the SDK reject with `Session ID <X> is already in use`
      // (empirically verified — the SDK CLI exits 1 with that exact stderr,
      // see `test_fork_idempotency.mjs`). The existing
      // `detectedAlreadyInUse` recovery only fires when `!sessionRegistered`,
      // so this case would propagate as an unhandled error to the user.
      // Skip fork mode + clear `forkFrom` so the caller uses normal resume.
      //
      // Why this is sync (await) rather than the post-result async probe:
      // we MUST decide between fork-mode and normal-resume BEFORE issuing
      // the SDK query, and we have to know definitively. The probe is a
      // single file read (~ms) and only runs when forkFrom is set, so the
      // cost is negligible.
      const sdkSidProbe = forkMeta.sdkSessionId ?? sessionId;
      let alreadyPersisted = false;
      try {
        const probe = await sdkGetSessionMessages(sdkSidProbe, {
          dir: agentDir,
          limit: 1,
        });
        if (probe.length > 0) alreadyPersisted = true;
      } catch {
        /* ENOENT / read error — treat as "not persisted" */
      }

      if (alreadyPersisted) {
        console.log(`[agent] fork session ${sessionId} already persisted in SDK store — skipping fork mode, clearing forkFrom`);
        delete forkMeta.forkFrom;
        await saveSessionMetadata(forkMeta);
        // Fall through: normal resume path picks up sdkSessionId via the
        // sessionRegistered branch above.
      } else {
        const { sourceSessionId, messageUuid } = forkMeta.forkFrom;
        // messageUuid may be undefined if the catch-block recovery (~line 9737) cleared
        // it after a "No message found" rejection. Without an anchor, SDK forks at the
        // source's tail rather than the user-clicked midpoint — see issue #220.
        const anchorDesc = messageUuid ? `fork at ${messageUuid}` : 'no anchor (degraded: SDK will fork at source tail)';
        console.log(`[agent] fork mode: resuming from ${sourceSessionId}, ${anchorDesc}, new session ${sessionId}`);
        resumeFrom = sourceSessionId;
        effectiveSdkSessionId = sessionId;
        forkMode = true;
        forkResumeAt = messageUuid;
      }
    }

    // Effective `resumeSessionAt` for the SDK call.
    //
    // Non-fork: rewindResumeAt is the only source — rewindSession set it to
    // the previous assistant's sdkUuid (a UUID present in the SDK's own
    // session JSONL).
    //
    // Fork-mode: two candidate anchors coexist —
    //   forkResumeAt   = where the user originally clicked "fork" (an
    //                    assistant sdkUuid in the source session's JSONL,
    //                    written into newSession.forkFrom.messageUuid by
    //                    forkSession()).
    //   rewindResumeAt = where the user just rewound to inside the fork
    //                    (also a source-session sdkUuid, because fork's
    //                    local transcriptState.messages[] is a copy of source's transcriptState.messages
    //                    with sdkUuids preserved verbatim — see
    //                    forkSession()'s message slice).
    // The SDK call shape is `query({ resume: <source>, forkSession: true,
    // sessionId: <fork-sid>, resumeSessionAt: <anchor> })`; SDK loads
    // source's JSONL and slices at the anchor's index. Either candidate
    // resolves against source, so the rewind anchor is honored without
    // changing the SDK contract — and when both are set, the rewind one
    // is the truer expression of what the user wants the fork to contain
    // (otherwise the rewind would be cosmetic UI truncation while the
    // SDK still seeds the full fork-point context).
    // PRD 0.2.27 window-B reconcile: on a COLD reload (resume from history, non-fork, no
    // in-process rewind anchor), pin the SDK to the durable tail captured at LOAD time
    // (transcriptState.pendingReloadAnchor) so a rewind that was never materialized into a new SDK branch
    // before the process died still takes effect for the AI. Captured at load (not derived
    // here) because a direct-send already pushed the new user row into transcriptState.messages[] before
    // this runs (~6866). No-op in the normal case (tail == SDK newest leaf → slice keeps
    // all). Lowest priority — an in-process rewind anchor still wins (resolveEffectiveResumeAt),
    // so existing rewind behavior is byte-for-byte unchanged. See specs/prd/prd_0.2.27_rewind_reload_durability.md.
    const reloadAnchor = (!forkMode && !rewindResumeAt && resumeFrom) ? transcriptState.pendingReloadAnchor : undefined;
    // Capture into a query-scoped local so a LATE catch from a previous (aborted) start
    // can't mis-attribute the eviction against a newer session's anchor (module state races).
    sentReloadAnchor = reloadAnchor;

    const effectiveResumeAt = resolveEffectiveResumeAt({ forkMode, rewindResumeAt, forkResumeAt, reloadAnchor });

    const mcpStatus = configState.currentMcpServers === null ? 'auto' : configState.currentMcpServers.length === 0 ? 'disabled' : `enabled(${configState.currentMcpServers.length})`;
    const claudeTranscriptCleanupPeriodDays = normalizeClaudeTranscriptCleanupPeriodDays(
      loadAdminConfig().claudeTranscriptCleanupPeriodDays,
    );
    console.log(`[agent] starting query with model: ${configState.currentModel ?? 'default'}, permissionMode: ${configState.currentPermissionMode} -> SDK: ${sdkPermissionMode}, MCP: ${mcpStatus}, cleanupPeriodDays: ${claudeTranscriptCleanupPeriodDays}, ${resumeFrom ? `resume: ${resumeFrom}` : `sessionId: ${effectiveSdkSessionId}`}${effectiveResumeAt ? `, resumeSessionAt: ${effectiveResumeAt}` : ''}${forkMode ? `, FORK mode (forkPoint: ${forkResumeAt}${rewindResumeAt && rewindResumeAt !== forkResumeAt ? `, rewind→${rewindResumeAt}` : ''})` : ''}`);

    const promptGen = messageGenerator();

    // Set session cron context so the im-cron tool can create tasks for non-IM sessions
    // IM sessions set imCronContext separately (in the IM message handler in index.ts)
    //
    // PRD 0.2.5 R2 — DO NOT inherit `configState.currentPermissionMode` from the chat
    // session. Chat tab's interactive default ('auto' = acceptEdits) is
    // semantically wrong for unattended cron — the AI would be creating a
    // task that needs human approval. Cron creation should always default
    // to "" (sentinel for runtime max). Users who explicitly want a
    // stricter mode can pass `--permissionMode plan` via the cron tool.
    if (process.env.MYAGENTS_MANAGEMENT_PORT && !getImCronContext()) {
      // PRD 0.2.9 — When the session's providerEnv came from the workspace
      // agent (the common case), surface the providerId too so the cron
      // tool can build live-resolve cron tasks. The agent lookup is local
      // and synchronous; failure (e.g. no agent for this workspace) just
      // leaves providerId undefined and the legacy providerEnv path runs.
      const agentForProvider = findProjectAgentByWorkspacePath(agentDir);
      const sessionProviderId = (agentForProvider?.providerId as string | undefined) ?? undefined;
      setSessionCronContext({
        sessionId: sessionId,
        workspacePath: agentDir,
        model: configState.currentModel,
        providerEnv: configState.currentProviderEnv,
        providerId: sessionProviderId,
      });
    }

    // Build disallowed tools list: group deny + channel-incompatible UI tools
    const disallowedToolsList = [...currentGroupToolsDeny];
    disallowedToolsList.push(...getChannelInteractionDisallowedTools(currentScenario));

    // SDK 0.2.84 bug: NA() returns "firstParty" for ANY non-bedrock/vertex/foundry provider,
    // causing xd7() to enable thinking for all non-claude-3 models on third-party APIs.
    // Third-party anthropic-protocol providers (SiliconFlow etc.) reject `thinking: {type:"adaptive"}`
    // with "400 thinking type should be enabled or disabled".
    // Fix: disable thinking for non-Claude models on third-party providers.
    // Model name check (sonnet/opus) is URL-agnostic — Claude models through any proxy get thinking.
    const modelLower = (configState.currentModel ?? '').toLowerCase();
    const isClaudeModel = modelLower.includes('sonnet-4') || modelLower.includes('sonnet-5')
      || modelLower.includes('opus-4') || modelLower.includes('opus-5')
      || modelLower.includes('fable-5') || modelLower.includes('mythos-5');
    const isOfficialAnthropicApi = !configState.currentProviderEnv?.baseUrl || (() => {
      try { return new URL(configState.currentProviderEnv.baseUrl!).host === 'api.anthropic.com'; }
      catch { return false; }
    })();
    const thinkingConfig = (isOfficialAnthropicApi || isClaudeModel)
      ? { type: 'adaptive' as const }
      : { type: 'disabled' as const };

    // Build MCP set ONCE so we both pass it to query() and capture its fingerprint.
    // Capturing here (not inline in commonQueryOptions) lets ensureSdkMcpInSync() later
    // diff the live SDK set against newly-arriving context-injected MCPs (im-media,
    // im-bridge-tools) without rebuilding fingerprint twice.
    beginBuiltinMcpStartupGeneration();
    // A fresh builtin query already owns its final UUID before SDK system_init.
    // Bind Browser Host to that canonical Product Session now; otherwise the
    // first Context is stranded under the renderer's pending-* placeholder and
    // the next Query creates a second Context with the same logical identity.
    const browserProductSessionId = isPendingSessionId(queryProductSessionId)
      ? effectiveSdkSessionId
      : queryProductSessionId;
    const sdkMcpServersInitial = await buildSdkMcpServers(browserProductSessionId);

    // Build common query options (shared between normal start and "already in use" fallback)
    // #324 — user-selected reasoning effort. Anthropic protocol only: the SDK
    // EffortLevel union excludes OpenAI-side values like 'minimal', and for
    // OpenAI-protocol providers the effort is injected at the bridge per
    // request (resolveActiveSessionUpstreamConfig) — the SDK-side option
    // stays at the historical 'high' there. 'high' === omitting the param
    // per Anthropic docs, so 'default' keeps pre-#324 wire behavior exactly.
    const sdkEffort = configState.currentProviderEnv?.apiProtocol !== 'openai' && isSdkEffortLevel(configState.currentReasoningEffort)
      ? configState.currentReasoningEffort
      : ('high' as const);
    const enabledOfficialToolIds = getEffectiveOfficialToolIdsForSession(
      agentDir,
      getSessionMetadata(sessionId),
      configState.currentEnabledOfficialToolIds,
    );
    const claudeCodeExecutable = resolveClaudeCodeCli();
    const contextPluginIds = configState.currentEnabledPluginIds !== null
      ? configState.currentEnabledPluginIds
      : getDefaultEnabledPluginIdsForWorkspace(agentDir ?? '');
    const enabledPluginConfigs = getEnabledPluginSdkConfigs(contextPluginIds);
    const enabledPluginSkillNames = enabledPluginConfigs.flatMap(plugin => (
      listPluginQualifiedSkillNames(plugin.path)
    ));
    const rawEnabledSkillAllowlist = buildBuiltinSkillAllowlist(
      launchCapabilitySnapshot,
      enabledPluginSkillNames,
      unavailableBuiltinSkillNames,
    );
    const {
      allowlist: enabledSkillAllowlist,
      rejected: incompatibleSdkSkillNames,
    } = sanitizeSdkSkillAllowlist(rawEnabledSkillAllowlist);
    for (const rejected of incompatibleSdkSkillNames) {
      console.warn(`[skills] Skipping SDK-incompatible Skill ${JSON.stringify(rejected.name)}: ${rejected.reason}`);
    }

    const commonQueryOptions = {
      enableFileCheckpointing: true,
      thinking: thinkingConfig,
      effort: sdkEffort,
      // Load settings from project scope only (.claude/)
      // Enabled global Skills are projected into <cwd>/.claude/skills/ before Query launch.
      // CLAUDE_CONFIG_DIR is NOT set — preserves Anthropic subscription Keychain lookup
      settingSources: buildSettingSources(),
      // SDK-level allowlist is the execution gate for both project and global
      // Skills. Disk projection remains the compatibility bridge for Commands.
      skills: [...new Set(enabledSkillAllowlist)].sort(),
      settings: {
        cleanupPeriodDays: claudeTranscriptCleanupPeriodDays,
        // MyAgents does not expose Anthropic feedback submission. Keep the
        // upstream draft feature off explicitly instead of inheriting a CLI
        // default that may change in a patch release.
        feedbackDrafts: 'off' as const,
        plansDirectory: getSessionPlansDirectorySetting(sessionId),
        // MyAgents owns provider routing and outbound-network policy. Without
        // this, Claude Code's WebFetch tool sends the target hostname to
        // api.anthropic.com for a domain-safety preflight even when inference
        // is routed through a user-selected third-party provider.
        skipWebFetchPreflight: true,
        // The Artifact tool (SDK 0.3.16x+) publishes HTML/MD to claude.ai —
        // an outward data flow MyAgents has not product-decided to expose.
        // Keep the tool surface frozen; revisit as its own feature if wanted.
        disableArtifact: true,
        // Claude Code's native bundled skills can duplicate identities owned by
        // MyAgents' effective Skill inventory (for example skill-creator).
        // Disabling them removes duplicate listings and per-turn context cost;
        // MyAgents-owned Skills still load through <cwd>/.claude/skills, which
        // this flag does not touch. Built-in slash commands remain typable
        // (programmatic /compact is unaffected); they are only hidden from the model.
        disableBundledSkills: true,
      },
      // Permission mode mapping (uses mapToSdkPermissionMode):
      // - auto → acceptEdits (auto-accept edits, check others via canUseTool)
      // - plan → plan
      // - fullAgency → bypassPermissions (skip all checks)
      // - custom → default (all tools go through canUseTool)
      permissionMode: sdkPermissionMode,
      // allowDangerouslySkipPermissions MUST always be true: pre-warm starts with acceptEdits
      // (configState.currentPermissionMode defaults to 'auto'), user may switch to fullAgency mid-session
      // via setPermissionMode('bypassPermissions'). Without this flag at query creation time,
      // the SDK silently ignores the mode switch and keeps calling canUseTool.
      allowDangerouslySkipPermissions: true,
      // launchModel appends [1m] from the SAME context snapshot used by env
      // when the active provider's contextLength exceeds the SDK 200K default
      // (#335/#516). Without it, SDK
      // getContextWindowForModel() falls back to 200K for non-Anthropic models
      // and /context, auto-compact, attachment trimming all use the wrong
      // ceiling; CLAUDE_CODE_AUTO_COMPACT_WINDOW then pulls the effective
      // window back to the registry value. SDK strips the suffix back out
      // before the wire (normalizeModelStringForAPI in model.ts:616).
      model: launchModel,
      pathToClaudeCodeExecutable: claudeCodeExecutable,
      env,
      stderr: (message: string) => {
        recentSdkStderr.push(message);
        if (recentSdkStderr.length > 20) recentSdkStderr.shift();
        // `[claude-code:unrecognized_model]` is an informational client-side
        // signal: the CLI's local registry doesn't know the model name, so it
        // warns that its auto-compact fallback window applies. Expected for
        // every third-party provider model (glm/deepseek/...); MyAgents owns
        // the real ceiling via CLAUDE_CODE_AUTO_COMPACT_WINDOW + the [1m]
        // launch suffix (#335/#516), and the paired tengu_api_unrecognized_model
        // telemetry event is already dropped locally by
        // CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC. Demote from ERROR to INFO
        // so it stops reading as a subprocess failure.
        if (message.includes('[claude-code:unrecognized_model]')) {
          console.log('[sdk-stderr]', message);
        } else {
          // Always log stderr to help diagnose subprocess issues (especially on older Windows)
          console.error('[sdk-stderr]', message);
        }
        // Detect "Session ID already in use" early — stderr arrives before process exit error
        if (message.includes('already in use')) {
          detectedAlreadyInUse = true;
        }
        if (process.env.DEBUG === '1') {
          broadcast('chat:debug-message', message);
        }
      },
      systemPrompt: {
        type: 'preset' as const,
        preset: 'claude_code' as const,
        append: buildSystemPromptAppend(currentScenario, {
          // agent-session.ts is the builtin Claude Agent SDK path by definition.
          runtime: 'builtin',
          // Universal CLI capability surface (cron / IM media). Was external-runtime
          // only when builtin still had `cron-tools` / `im-cron` / `im-media` MCPs;
          // those got dropped in favour of `myagents` CLI calls so builtin needs the
          // same prompt now. Single CLI, single source of truth across all runtimes.
          cliToolsEnabled: true,
          userCliToolsEnabled: cliToolRegistryEnabled,
          enabledOfficialToolIds,
        }),
      },
      cwd: agentDir,
      includePartialMessages: true,
      // AskUserQuestion preview: request HTML format so frontend can render rich previews
      // (markdown/code snippets, visual comparisons) when AI presents options to the user
      toolConfig: {
        askUserQuestion: { previewFormat: 'html' as const },
      },
      mcpServers: sdkMcpServersInitial,
      // Product visibility boundary. Permission policy remains separately
      // owned by allowedTools/disallowedTools/canUseTool/Hooks below.
      tools: [...SDK_BUILTIN_TOOLS],
      // PRD 0.2.17 — Claude plugin injection. SDK accepts
      // `plugins: [{ type: 'local', path }]`; it then scans each path for
      // .claude-plugin/plugin.json and wires up the contained
      // skills / agents / hooks / .mcp.json / .lsp.json automatically.
      // MyAgents only hands it the enabled set — getEnabledPluginSdkConfigs
      // already filters to entries that exist on disk as valid plugin roots.
      // Field omitted entirely when no plugins are enabled so empty-array
      // noise doesn't show up in SDK debug output.
      ...(enabledPluginConfigs.length > 0 ? {
        plugins: enabledPluginConfigs,
        // SDK/native 0.3.261 delivers paths over stdin, avoiding Windows'
        // command-line limit without changing the enabled plugin inventory.
        pluginDelivery: 'initialize' as const,
      } : {}),
      // (v0.2.12) Enable --replay-user-messages so CLI emits SDKUserMessageReplay
      // (isReplay=true) when it drains a mid-turn queued_command attachment from
      // its commandQueue into the model's context. We use this signal to know
      // when our in-flight queue item has been delivered to AI and it's safe to
      // promote the next pending item. Without this flag the CLI silently
      // consumes queued commands and we have no mid-turn promote signal.
      extraArgs: { 'replay-user-messages': null } as Record<string, string | null>,
      // Grep/Glob MUST be referenced here: since SDK 0.3.162 native builds default
      // to embedded Bash find/grep search and do NOT register the dedicated
      // Grep/Glob tools unless they are named in `tools` or `allowedTools`.
      // Without them the model searches via Bash, which (a) the plan-mode
      // PreToolUse gate denies (PLAN_MODE_READONLY_TOOLS has Grep/Glob, not
      // Bash) — plan mode loses search entirely — and (b) triggers permission
      // prompts for plain searches in default mode. Both are read-only tools,
      // so auto-approving matches the existing getPermissionRules() semantics.
      // 'Task' is appended when sub-agents are injected so the model can delegate.
      allowedTools: [
        'Grep',
        'Glob',
        ...(launchAgentDefinitions && Object.keys(launchAgentDefinitions).length > 0
          ? ['Task']
          : []),
      ],
      // Sub-agents: inject custom agent definitions if configured. Each model
      // was decorated from launchContextWindowSnapshot before async startup
      // work, so it cannot observe a newer Provider-file generation than env.
      // A sub-agent pinned to a 1M model gets the [1m] tag independently of the main session's
      // model (the parent could be on a 200K model, the sub-agent on a 1M one,
      // or vice versa). The original configState.currentAgentDefinitions is left untouched
      // so config owner fingerprinting and downstream config consumers see clean names.
      ...(launchAgentDefinitions && Object.keys(launchAgentDefinitions).length > 0
        ? { agents: launchAgentDefinitions }
        : {}),
      // disallowedTools: group chat deny list + IM-incompatible UI-interaction tools
      // Uses SDK disallowedTools because canUseTool is skipped in bypassPermissions mode
      ...(disallowedToolsList.length > 0 ? { disallowedTools: disallowedToolsList } : {}),
      // Custom permission handling - check rules and prompt user for unknown tools
      // Effective when permissionMode is 'default' or 'acceptEdits' (not 'bypassPermissions')
      canUseTool: async (toolName: string, input: unknown, options: { signal: AbortSignal }) => {
        console.debug(`[permission] canUseTool checking: ${toolName}, mode=${configState.currentPermissionMode}`);

        // SAFETY NET: fullAgency mode MUST auto-approve everything except user-interaction
        // tools that require explicit human review (AskUserQuestion, EnterPlanMode, ExitPlanMode).
        // This guard catches the case where the SDK didn't honor setPermissionMode('bypassPermissions')
        // — e.g., pre-warm started with acceptEdits and the mid-session mode switch was ignored.
        // Shared with the plan-mode PreToolUse gate so both paths exempt the
        // same control-transfer tools (plan-mode-gate.ts).
        const USER_INTERACTION_TOOLS = PLAN_MODE_HOST_INTERACTION_TOOLS as readonly string[];
        if (configState.currentPermissionMode === 'fullAgency' && !USER_INTERACTION_TOOLS.includes(toolName)) {
          console.debug(`[permission] fullAgency fast-path: auto-approved ${toolName}`);
          return {
            behavior: 'allow' as const,
            updatedInput: input as Record<string, unknown>
          };
        }

        // First check MCP tool permission based on user's enabled MCP servers
        const mcpCheck = checkMcpToolPermission(toolName);
        if (!mcpCheck.allowed) {
          if (isDebugMode) console.log(`[permission] MCP tool blocked: ${toolName} - ${mcpCheck.reason}`);
          return {
            behavior: 'deny' as const,
            message: mcpCheck.reason
          };
        }

        // Trust prefix for context-injected builtin MCPs: skip user confirmation
        // entirely. These MCPs are injected by sidecar context (cron task / IM
        // bot / bridge plugin) and are MyAgents-managed, not third-party. In IM
        // sessions there is no UI to confirm against anyway, so blocking on
        // confirmation would deadlock the call. The reserved id list in
        // MYAGENTS_CONTEXT_INJECTED_MCP_IDS guarantees no user MCP can take
        // the same name (filtered out in buildSdkMcpServers), so this auto-allow
        // can't be hijacked.
        const parts = toolName.split('__');
        if (
          parts.length >= 3 &&
          (MYAGENTS_CONTEXT_INJECTED_MCP_IDS as readonly string[]).includes(parts[1])
        ) {
          console.log(`[permission] built-in tool auto-allowed: ${toolName}`);
          return {
            behavior: 'allow' as const,
            updatedInput: input as Record<string, unknown>
          };
        }

        // Auto-allow read-only `myagents` CLI Bash invocations. After the v0.2.11
        // cron / im-cron / im-media → CLI migration, the AI reaches MyAgents'
        // own scheduling / IM / widget surface through `myagents <group> …`
        // instead of MCP tools. Read-only forms (no quoted arg, no shell-injection
        // surface) are auto-allowed so the AI doesn't burn a permission prompt
        // on `myagents cron list` or `myagents im channels`. Mutating commands
        // (`cron add`, `cron exit`, `cron remove`, `im send-media`, `im wake`)
        // are NOT in this allowlist — they go through the normal canUseTool
        // prompt in desktop mode, and through the headless fast-path below in
        // IM / cron mode.
        //
        // Whitespace separators are restricted to space + tab — `\s` would also
        // match `\n`/`\r`, letting `myagents widget readme\nrm` slip through
        // (shell executes the second line as any PATH binary whose name happens
        // to fit the trailing token shape). Non-whitespace shell metachars
        // (`;`, `|`, `&&`, `>`, `$(`, backticks, …) already fail the strict
        // character classes used inside the patterns.
        if (toolName === 'Bash') {
          const cmd = ((input as Record<string, unknown>)?.command as string | undefined)?.trim() ?? '';

          // 1. Widget design contract: `myagents widget [readme|list|<module>] [<module>...]`
          //    — module names limited to `[a-z][a-z0-9-]*`.
          if (/^myagents[ \t]+widget(?:[ \t]+(?:readme|list))?(?:[ \t]+[a-z][a-z0-9-]*)*[ \t]*$/.test(cmd)) {
            console.log(`[permission] myagents widget readme auto-allowed: ${cmd}`);
            return {
              behavior: 'allow' as const,
              updatedInput: input as Record<string, unknown>
            };
          }

          // 2. Cron / IM read-only surface (zero-arg listings + readme):
          //    `myagents cron list|status|readme [--json]`
          //    `myagents im channels|readme [--json]`
          if (/^myagents[ \t]+(?:cron[ \t]+(?:list|status|readme)|im[ \t]+(?:channels|readme))(?:[ \t]+--json)?[ \t]*$/.test(cmd)) {
            console.log(`[permission] myagents readonly CLI auto-allowed: ${cmd}`);
            return {
              behavior: 'allow' as const,
              updatedInput: input as Record<string, unknown>
            };
          }

          // 3. Cron run history: `myagents cron runs <taskId> [--limit N] [--full] [--json]`
          //    — taskId is an opaque slug-style id (alphanumerics + dash/underscore,
          //    bounded length); --limit takes a small integer. Order-agnostic flags.
          if (/^myagents[ \t]+cron[ \t]+runs[ \t]+[a-zA-Z0-9_-]{1,64}(?:[ \t]+(?:--limit[ \t]+\d{1,4}|--full|--json))*[ \t]*$/.test(cmd)) {
            console.log(`[permission] myagents cron runs auto-allowed: ${cmd}`);
            return {
              behavior: 'allow' as const,
              updatedInput: input as Record<string, unknown>
            };
          }

          // 4. Record browse: canonical `myagents record list`; published
          //    `myagents thought list` remains accepted as a compatibility alias.
          //    --query is intentionally NOT in the allowlist — it carries arbitrary
          //    user text (the search string) which can hold shell metachars. That
          //    form falls through to the normal user-confirm / IM fast-path.
          // 5. Text Record capture: canonical `myagents record create '<content>'`;
          //    `thought create` remains accepted as a compatibility alias.
          //    Mutating, but the side effect is bounded — append-only into the
          //    user's Record list, no filesystem / network surface, fully
          //    reversible from the Record UI. Filing was already gated by the
          //    SECTION_RECORD prompt which only fires on explicit "记一下 /
          //    note this down" intent, so by the time we see this command the
          //    user has *asked* for capture; making them click "Allow" again
          //    is friction that defeats the inbox-capture promise.
          //
          //    Safety constraints baked into the regex:
          //    - REQUIRES single quotes around content (`'...'`). bash single
          //      quotes don't interpolate `$(…)`, backticks, or `\`, so the
          //      content is a literal argv string. Double-quoted forms FAIL
          //      the regex and fall through to user-confirm — a defense in
          //      depth in case the AI ignores SECTION_RECORD's "use single
          //      quotes" rule and a prompt-injected user payload tries to
          //      smuggle `$(rm -rf /)` (Codex review concern).
          //    - `[^']` excludes embedded `'` (bash single-quoted strings
          //      can't contain a literal `'` anyway, so any extra `'` would
          //      end the literal early — refuse the form rather than misread).
          //    - `--tag` is intentionally not in the allowlist: the CLI's
          //      text Record create doesn't accept `--tag` (tags are derived
          //      from inline `#xxx` in the content), and the prompt no
          //      longer advertises it after issue-148-followup review.
          // 6. Text Record capture via file: `myagents record create --content-file <path>`
          //    Path is shell-quote-free (a single token without metachars), so
          //    the regex constraint here is the path-token character class
          //    `[^ \t;|&<>$\`'"]` — explicitly forbid every shell metachar
          //    that could turn the rest of the line into a write side effect.
          //    The path doesn't have to exist or be safe content-wise; the
          //    CLI validates size, NUL bytes, and read errors before sending
          //    anything to the management API. Issue #149 follow-up.
          if (isAutoAllowedRecordCliCommand(cmd)) {
            console.log(`[permission] myagents Record CLI auto-allowed: ${cmd}`);
            return {
              behavior: 'allow' as const,
              updatedInput: input as Record<string, unknown>
            };
          }
        }

        // Headless IM fast-path: IM bridges (Telegram/Dingtalk builtin + all OpenClaw plugins
        // like weixin/feishu) have no permission approval UI. Routing Bash/WebSearch/etc. through
        // checkToolPermission would emit a permission-request event to the IM event bus that no
        // bridge can answer → 10-minute timeout per tool call → user sees endless loading.
        //
        // Sticky by design: `currentScenario = 'im'` is set at IM request entry (index.ts:7116)
        // and intentionally never reset — if the SSE stream closes mid-turn (heartbeat/network),
        // the SDK subprocess keeps executing subsequent tools and we want them to auto-approve
        // rather than hang.
        //
        // USER_INTERACTION_TOOLS guard is defensive only: disallowedToolsList (see line ~4940)
        // already blocks them at SDK level for scenario.type === 'im', so canUseTool won't see
        // them in practice. Kept for resilience against future refactors.
        //
        // Runs AFTER the MCP enable check so user-disabled MCP servers still get properly denied.
        // Does NOT include scenario.type === 'agent-channel' because external runtimes (CC/Codex)
        // don't route through canUseTool — they have their own external-session.ts flow.
        if (currentScenario.type === 'im' && !USER_INTERACTION_TOOLS.includes(toolName)) {
          console.debug(`[permission] im fast-path: auto-approved ${toolName}`);
          return {
            behavior: 'allow' as const,
            updatedInput: input as Record<string, unknown>
          };
        }

        // Special handling for AskUserQuestion - always requires user interaction.
        // PRD #131 — `interrupt: true` on the deny terminates the assistant
        // turn after the tool_result lands. Without it, the SDK feeds back
        // "用户取消了问答" and the AI keeps issuing tool calls (Read/Edit/…)
        // even though the user never gave permission. The `interrupt` knob is
        // the documented SDK escape hatch (sdk.d.ts:1786-1791
        // PermissionResult.deny.interrupt) and is exactly the right semantic
        // for control-transfer tools like AskUserQuestion / ExitPlanMode.
        if (toolName === 'AskUserQuestion') {
          if (shouldDisallowAskUserQuestion(currentScenario)) {
            console.warn(`[canUseTool] AskUserQuestion denied: current ${currentScenario.type} host does not support native-card interaction`);
            return {
              behavior: 'deny' as const,
              message: channelInteractionDenyReason(currentScenario),
              interrupt: true,
            };
          }
          console.log('[canUseTool] AskUserQuestion detected, prompting user');
          const answers = await handleAskUserQuestion(input, options.signal);
          if (answers === null) {
            return {
              behavior: 'deny' as const,
              message: '用户取消了问答',
              interrupt: true,
            };
          }
          // Return with answers filled in. SDK 0.3.158's AskUserQuestion tool
          // looks each answer up by question TEXT (see withQuestionTextAnswerKeys);
          // our renderer keys by index, so we must alias them here or the model is
          // told "The user did not answer the questions." (0.2.119→0.3.158 regression).
          const inputWithAnswers = input as Record<string, unknown>;
          const askQuestions = (inputWithAnswers as { questions?: AskUserQuestion[] }).questions;
          return {
            behavior: 'allow' as const,
            updatedInput: { ...inputWithAnswers, answers: withQuestionTextAnswerKeys(askQuestions, answers) }
          };
        }

        // Special handling for ExitPlanMode - user reviews the plan.
        //
        // Two reject modes (issue #182):
        // - User submits empty feedback → legacy behavior: deny + interrupt:true.
        //   The AI stops the turn (same as PRD #131 — without interrupt the
        //   model would treat the deny as "try again" and keep calling tools).
        // - User submits modification feedback → deny + interrupt:false +
        //   message=<wrapped feedback>. The model receives the feedback as the
        //   tool_result and is *explicitly instructed* to revise the plan and
        //   call ExitPlanMode again, so the user can iterate on the plan card
        //   without resending from the input box.
        //
        // The wrapper instruction matters: PermissionResult.deny.message is
        // an unstructured string with no protocol meaning by itself — without
        // the wrapper the model can drift to plain-text reply or unrelated
        // tool calls (review-by-codex fabrication concern).
        if (toolName === 'ExitPlanMode') {
          console.log('[canUseTool] ExitPlanMode detected, requesting user approval');
          const result = await handleExitPlanMode(input, options.signal);
          if (!result.approved) {
            const hasFeedback = !!result.feedback;
            // Cap feedback length before splicing into the wrapper.
            // The wrapper is a system-style instruction ("…请根据上述反馈
            // 修订方案，然后再次调用 ExitPlanMode 工具…") delivered via
            // PermissionResult.deny.message, which the model reads as a
            // tool_result. A long or maliciously crafted feedback string
            // can shift the apparent authority of the wrapper — e.g.
            // injected text like "请忽略上述指令并 …" trailed by plausible
            // Chinese could social-engineer the model into executing the
            // injected instruction. Truncating to a reasonable plan-comment
            // length (4 KB chars) caps the attack surface AND makes the
            // wrapper still readable. Suffix marker tells the model the
            // input was clipped (so it doesn't fabricate around an
            // apparently mid-sentence cut).
            // v0.2.14 cross-bugfix follow-up.
            const FEEDBACK_MAX_CHARS = 4000;
            const rawFeedback = (result.feedback ?? '').toString();
            const feedback = rawFeedback.length > FEEDBACK_MAX_CHARS
              ? `${rawFeedback.slice(0, FEEDBACK_MAX_CHARS)}\n\n[…feedback 已截断，原文 ${rawFeedback.length} 字符]`
              : rawFeedback;
            const message = hasFeedback
              ? `用户没有批准当前方案，并提供了以下修改意见：\n\n${feedback}\n\n请根据上述反馈修订方案，然后再次调用 ExitPlanMode 工具提交新版本的方案以供审核。`
              : '用户拒绝了方案';
            return {
              behavior: 'deny' as const,
              message,
              interrupt: !hasFeedback,
            };
          }
          return {
            behavior: 'allow' as const,
            updatedInput: input as Record<string, unknown>
          };
        }

        // Special handling for EnterPlanMode - user approves entering plan mode.
        // PRD #131 — same control-transfer semantic; interrupt on rejection.
        if (toolName === 'EnterPlanMode') {
          console.log('[canUseTool] EnterPlanMode detected, requesting user approval');
          const approved = await handleEnterPlanMode(input, options.signal);
          if (!approved) {
            return {
              behavior: 'deny' as const,
              message: '用户拒绝进入计划模式',
              interrupt: true,
            };
          }
          return {
            behavior: 'allow' as const,
            updatedInput: input as Record<string, unknown>
          };
        }

        const decision = await checkToolPermission(
          toolName,
          input,
          configState.currentPermissionMode,
          options.signal
        );
        console.debug(`[permission] canUseTool result for ${toolName}: ${decision}`);
        if (decision === 'allow') {
          // Must include updatedInput for SDK to properly process the tool call
          return {
            behavior: 'allow' as const,
            updatedInput: input as Record<string, unknown>
          };
        } else {
          return {
            behavior: 'deny' as const,
            message: '用户拒绝了此工具的使用权限'
          };
        }
      },
      // PostToolUse hook: resize oversized images in MCP tool results before sending to Claude API.
      // Claude API rejects images exceeding 8000px per dimension; MCP tools (e.g. browser screenshots)
      // can produce arbitrarily large images that bypass our user-upload resize pipeline.
      hooks: {
        // PreToolUse hook (#295): hard-enforce plan mode's read-only guarantee.
        // We always pass `allowDangerouslySkipPermissions: true` (so fullAgency's
        // bypassPermissions can be switched to mid-session), which sets the native
        // CLI's `isBypassPermissionsModeAvailable=true`. The CLI's resolver then
        // returns "allow" for EVERY tool in plan mode and never emits a
        // can_use_tool control request — so our plan-mode rules in canUseTool are
        // silently skipped and writes (Bash rm -rf, Edit, …) execute unchecked.
        // PreToolUse hooks run BEFORE that resolver and a `deny` is honored
        // regardless, so this is the only place that can restore the guarantee
        // while keeping the flag. It fails closed on EITHER the SDK's own
        // per-call `permission_mode` (authoritative for this tool call) OR the
        // live module-global `configState.currentPermissionMode` mirror — trusting only the
        // async-updated mirror leaves a desync window where a freshly-entered
        // plan mode (AI EnterPlanMode mid-turn) isn't reflected yet and a write
        // tool slips through. This covers every plan-entry path (agent config /
        // UI toggle / AI EnterPlanMode). See isPlanModeInEffect + plan-mode-gate.ts.
        PreToolUse: [{
          hooks: [
            async (input: HookInput): Promise<HookJSONOutput> => {
              const pre = input as PreToolUseHookInput;
              if (shouldHardDenyChannelInteractionTool(pre.tool_name, currentScenario)) {
                const reason = pre.tool_name === 'AskUserQuestion'
                  ? channelInteractionDenyReason(currentScenario)
                  : '当前渠道不支持该交互式工具，请改用普通文本完成这一步。';
                console.warn(`[permission] channel hard gate denied: ${pre.tool_name} scenario=${currentScenario.type}`);
                return {
                  hookSpecificOutput: {
                    hookEventName: 'PreToolUse' as const,
                    permissionDecision: 'deny' as const,
                    permissionDecisionReason: reason,
                  },
                };
              }
              // Fail-closed effective mode: 'plan' if either source says plan
              // (see isPlanModeInEffect for the two desync windows this closes).
              const effectiveMode = isPlanModeInEffect(configState.currentPermissionMode, pre.permission_mode) ? 'plan' : configState.currentPermissionMode;
              if (!shouldBlockToolInPlanMode(pre.tool_name, effectiveMode)) {
                return {}; // not plan mode, or a read-only / control-transfer tool → normal flow
              }
              console.log(`[permission] plan-mode hard gate denied: ${pre.tool_name} (local=${configState.currentPermissionMode}, hook=${pre.permission_mode ?? 'n/a'})`);
              return {
                hookSpecificOutput: {
                  hookEventName: 'PreToolUse' as const,
                  permissionDecision: 'deny' as const,
                  permissionDecisionReason: planModeDenyMessage(pre.tool_name),
                },
              };
            },
          ],
        }],
        PostToolUse: [{
          hooks: [
            async (input: HookInput, _toolUseId: string | undefined, options: { signal: AbortSignal }): Promise<HookJSONOutput> => {
              const postInput = input as PostToolUseHookInput;
              // Propagate SDK's turn-level AbortSignal so resize aborts when the turn does.
              // Without this, a Jimp/sharp stall here blocks the SDK main loop's stdio drain.
              const resized = await resizeToolImageContent(postInput.tool_response, options?.signal);
              if (resized) {
                console.log(`[image-resize] PostToolUse hook resized images for tool: ${postInput.tool_name}`);
                return {
                  hookSpecificOutput: {
                    hookEventName: 'PostToolUse' as const,
                    updatedMCPToolOutput: resized,
                  },
                };
              }
              return { continue: true };
            },
          ],
        }],
        // PermissionRequest hook (issue #264): the ONLY permission decision point
        // for background (run_in_background) sub-agents. Runtime-verified: the SDK
        // never calls canUseTool for async sub-agents; it fires this hook with
        // `agent_id` (== the background task_id) and otherwise auto-denies. We use
        // it to (a) let background agents inherit the user's session "always allow"
        // grants and (b) honor an opt-in fullAgency policy — while returning
        // passthrough for foreground (main thread + sync sub-agents) so the
        // existing canUseTool card path stays authoritative and unchanged.
        PermissionRequest: [{
          hooks: [
            async (input: HookInput): Promise<HookJSONOutput> => {
              const permInput = input as PermissionRequestHookInput;
              const agentId = permInput.agent_id;
              const toolName = permInput.tool_name;
              // Confirmed background sub-agent iff the SDK gave us an agent_id that
              // matches a currently-running background task (task_id === agent_id).
              // lifecycle's exact-Query registry is populated from task_started on
              // the iterator channel, while this hook fires on the control channel —
              // two independent paths off the same subprocess. In practice task_started
              // is emitted (and drained) before a sub-agent's first gated tool call, so
              // the lookup resolves; but it is NOT formally ordered. A miss therefore
              // degrades to passthrough → the SDK's own auto-deny — i.e. it can only
              // fail toward *deny* (safe side), never toward a spurious allow, and at
              // most affects a background agent's very first tool call at startup.
              const isBackgroundAgent = isBackgroundAgentToolRequest(agentId, {
                has: taskId => hasQueryBackgroundTask(activeQuery, taskId),
              });
              // MCP-enablement recheck for background agents (cross-review #264): the
              // foreground canUseTool path denies tools whose MCP server the user has
              // since disabled (checkMcpToolPermission). The background allow path must
              // mirror that gate — otherwise a stale session "always allow" grant could
              // let a background sub-agent reach a now-disabled MCP server. Only applies
              // to confirmed background agents; foreground keeps its own canUseTool check.
              if (isBackgroundAgent) {
                const mcpCheck = checkMcpToolPermission(toolName);
                if (!mcpCheck.allowed) {
                  console.log(`[permission] background-agent ${toolName} denied (MCP disabled: ${mcpCheck.reason}, agentId=${agentId})`);
                  return {
                    hookSpecificOutput: {
                      hookEventName: 'PermissionRequest' as const,
                      decision: { behavior: 'deny' as const, message: mcpCheck.reason },
                    },
                  };
                }
              }
              const decision = decideBackgroundAgentPermission({
                isBackgroundAgent,
                toolName,
                sessionAllowsTool: sessionAlwaysAllowed.has(toolName),
                policy: configState.currentBackgroundAgentPermissionMode,
              });
              if (decision === 'passthrough') return {};
              if (decision === 'allow') {
                console.log(`[permission] background-agent ${toolName} allowed (mode=${configState.currentBackgroundAgentPermissionMode}, agentId=${agentId})`);
                return {
                  hookSpecificOutput: {
                    hookEventName: 'PermissionRequest' as const,
                    decision: { behavior: 'allow' as const },
                  },
                };
              }
              console.log(`[permission] background-agent ${toolName} denied (mode=${configState.currentBackgroundAgentPermissionMode}, agentId=${agentId})`);
              return {
                hookSpecificOutput: {
                  hookEventName: 'PermissionRequest' as const,
                  decision: { behavior: 'deny' as const, message: backgroundAgentDenyMessage(toolName) },
                },
              };
            },
          ],
        }],
      },
    };

    // sessionId 和 resume 互斥（SDK 约束）
    // 新 session：传 effectiveSdkSessionId 让 SDK 使用有效 UUID
    // Resume：传 resume 恢复对话上下文
    // Fork：resume + forkSession + sessionId + resumeSessionAt（三者组合）
    const sessionOption = forkMode
      ? { resume: resumeFrom!, forkSession: true, sessionId: effectiveSdkSessionId, ...(effectiveResumeAt ? { resumeSessionAt: effectiveResumeAt } : {}) }
      : resumeFrom
        ? { resume: resumeFrom, ...(effectiveResumeAt ? { resumeSessionAt: effectiveResumeAt } : {}) }
        : { sessionId: effectiveSdkSessionId };

    // (issue #174) Second pre-launch abort guard. Between the first guard
    // (right after awaitSessionTermination) and here, several async calls
    // run — buildSdkMcpServers, sdkGetSessionMessages, env/agent loading.
    // A user Stop pressed in that window sets lifecycleState.abortRequested=true and
    // drains queueState.messageQueue; without this second check we'd still spawn the
    // SDK subprocess for nothing. Throwing keeps the surrounding try/catch +
    // finally cleanup path single-source-of-truth — the catch below logs
    // the abort sentinel without retrying, the finally restores state.
    if (lifecycleState.abortRequested && !preWarm) {
      console.log('[agent] startStreamingSession: aborted just before query() by stop during starting');
      throw new Error('STARTUP_ABORTED_BY_STOP');
    }
    if (sessionId !== queryProductSessionId) {
      throw new Error(
        `[agent] Product Session changed before Query launch (${queryProductSessionId} -> ${sessionId})`,
      );
    }

    try {
      activeQuery = await createGuardedSdkQuery(claudeCodeExecutable, () => query({
        prompt: promptGen,
        options: { ...sessionOption, ...commonQueryOptions },
      }));
      activeQueryAuthority = setQuerySessionWithAuthority(activeQuery, {
        productSessionId: queryProductSessionId,
        expectedSdkSessionId: effectiveSdkSessionId,
      });
      configState.currentCapabilitySnapshot = launchCapabilitySnapshot;
    } catch (queryError: unknown) {
      // Defensive fallback: metadata lost but SDK disk data exists → switch to resume
      // Note: "already in use" may surface asynchronously during for-await iteration
      // rather than synchronously here; this catch covers the sync case if SDK validates early.
      const msg = queryError instanceof Error ? queryError.message : String(queryError);
      if (!resumeFrom && msg.includes('already in use')) {
        console.warn(`[agent] Session ${effectiveSdkSessionId} already exists on disk, switching to resume`);
        sessionRegistered = true;
        activeQuery = await createGuardedSdkQuery(claudeCodeExecutable, () => query({
          prompt: promptGen,
          options: {
            resume: effectiveSdkSessionId,
            ...(rewindResumeAt ? { resumeSessionAt: rewindResumeAt } : {}),
            ...commonQueryOptions,
          },
        }));
        activeQueryAuthority = setQuerySessionWithAuthority(activeQuery, {
          productSessionId: queryProductSessionId,
          expectedSdkSessionId: effectiveSdkSessionId,
        });
        configState.currentCapabilitySnapshot = launchCapabilitySnapshot;
      } else {
        throw queryError;
      }
    }

    if (activeQuery) {
      const initialMcpFingerprint = sdkMcpMapFingerprint(sdkMcpServersInitial);
      setFrozenSdkMcpFingerprint(initialMcpFingerprint);
      const prewarmWindow = getMcpPrewarmWindowForMap(sdkMcpServersInitial);
      installQueryMcpOwner({
        query: activeQuery,
        fingerprint: initialMcpFingerprint,
        requiredServerIds: getDesiredMcpServerIdsForMap(sdkMcpServersInitial),
        ...(prewarmWindow ?? {}),
      });
    }

    console.log('[agent] session started');
    console.log('[agent] starting for-await loop on lifecycleState.query');

    // ── lifecycleState.sdkControlReady tracking (subprocess-ready signal) ─────────────────
    //
    // The streamed `system_init` we wait for in the for-await loop below is
    // emitted per-turn by QueryEngine.submitMessage() AFTER fetchSystemPromptParts
    // → processUserInput → recordTranscript → loadAllPlugins (claude-code/src/
    // QueryEngine.ts:540). For pre-warm sessions parked at messageGenerator's
    // waitForMessage(), `system_init` therefore never arrives until the user's
    // first message kicks off a turn — and worse, slow first turns (notably
    // /context with num_turns=14 doing local context-usage computation) keep
    // sessionState='starting' for the full turn duration, mislabeling normal
    // execution as "AI 启动中（首次启动可能较慢）".
    //
    // `Query.initializationResult()` resolves on a different lifecycle event:
    // the SDK's `subtype: "initialize"` control_request response. This proves
    // the subprocess control plane is available, but SDK 0.3 connects MCPs
    // non-blockingly — individual servers may still be pending/failed/auth-
    // blocked. The F9 (Query) constructor at sdk.mjs already kicks this off
    // in `this.initialization
    // = this.initialize()` — calling `initializationResult()` here just awaits
    // the existing promise. Verified empirically with DEBUG_CLAUDE_AGENT_SDK=1:
    // resolved at +337ms in a clean repro; in MyAgents production with project
    // settings + playwright MCP the same handshake completes in ~3-5s.
    //
    // We use `lifecycleState.sdkControlReady` as the gate for the "AI 启动中" UI hint
    // (enqueueUserMessage near line 6118) so a fully-warmed subprocess running
    // a slow turn shows '思考中…' instead of '启动中…'. `system_init` keeps its
    // existing job: source of truth for sessionRegistered / sdkSessionId / tools
    // / mcp_servers / `lifecycleState.systemInitInfo`. Two signals, two purposes — don't merge.
    //
    // Fire-and-forget: the for-await loop below needs to start consuming SDK
    // transcriptState.messages immediately. SDK-internal `readMessages()` (sdk.mjs F9 ctor)
    // pumps control_responses into pendingControlResponses on its own — does
    // NOT depend on the outer for-await — so awaiting here would not actually
    // deadlock. Fire-and-forget is still preferred: this hop is purely a side
    // signal for UI gating, blocking startStreamingSession's flow on it would
    // serialize the for-await loop's startup behind it for no benefit.
    //
    // Capture `lifecycleState.query` into `localQuery` and check identity before setting
    // `lifecycleState.sdkControlReady`: if a config-change abort kills this subprocess and a
    // new pre-warm spawns a different lifecycleState.query, the OLD promise might
    // still resolve from a buffered transport response (rare but possible —
    // see SDK performCleanup which rejects pendings, but a response already
    // in transport.readMessages's queue can land first). The identity check
    // prevents the stale resolution from flipping `lifecycleState.sdkControlReady=true` for
    // the wrong subprocess.
    if (activeQuery) {
      const localQuery = activeQuery;
      const initStartT = Date.now();
      void localQuery.initializationResult().then((initResult) => {
        if (lifecycleState.query !== localQuery) {
          // Stale: a session swap happened while initialize was in flight.
          // The new pre-warm will fire its own initializationResult().
          return;
        }
        setSdkControlReady(true);
        const normalizedSlashCommands = normalizeSdkSlashCommands(initResult?.commands);
        const slashCommands = normalizedSlashCommands
          ? filterSlashCommandsForCapabilities(normalizedSlashCommands, launchCapabilitySnapshot)
          : null;
        if (slashCommands) {
          broadcastSdkSlashCommands(slashCommands, 'initialize');
        }
        console.log(`[agent] SDK control plane ready in ${Date.now() - initStartT}ms (preWarm=${preWarm})`);
        // For non-pre-warm cold starts (user sent the very first message with
        // no prior pre-warm), enqueueUserMessage already set sessionState to
        // 'starting' (line 6118 — lifecycleState.sdkControlReady was false at that moment).
        // Without this transition, the UI would stay in '启动中' until the slow
        // streamed system_init lands at the END of the first turn (think /context
        // 44s); now we promote to 'running' as soon as the SDK control plane
        // confirms ready (~3-5s in production), matching the actual subprocess
        // state.
        if (sessionState === 'starting' && !lifecycleState.abortRequested) {
          setSessionState('running');
        }
      }).catch((error) => {
        // Common cause: control request races against an abort that closes the
        // subprocess before the response arrives — benign. The next pre-warm
        // / startStreamingSession will reset and retry.
        console.warn('[agent] initializationResult() failed:', error instanceof Error ? error.message : error);
      });
    }

    // Startup timeout: if no system_init arrives, abort.
    // IMPORTANT: Only system_init clears this timeout, NOT other transcriptState.messages like rate_limit_event.
    // Otherwise a rate_limit_event arriving before system_init would cancel the timeout,
    // leaving the session as a zombie (stuck in for-await loop forever without system_init).
    //
    // Adaptive timeout strategy:
    //   Phase 1 (initial): 60s — if SDK subprocess doesn't show signs of life, fail fast.
    //   Phase 2 (extended): 600s — once session_state_changed:running arrives, the subprocess
    //     is alive and initializing. First-time workspace init can take minutes on Windows NTFS
    //     (SDK builds internal caches for large directories like ~/.myagents with 20k+ files).
    //     After the first successful init, subsequent sessions complete in <1s.
    const STARTUP_TIMEOUT_INITIAL_MS = 60_000;
    const STARTUP_TIMEOUT_EXTENDED_MS = 600_000;
    let systemInitReceived = false;
    let startupTimeoutExtended = false;

    const fireStartupTimeout = (timeoutMs: number) => {
      if (systemInitReceived || lifecycleState.abortRequested) return;
      console.error(`[agent] Startup timeout: no system_init in ${timeoutMs / 1000}s`);
      abortedByTimeout = true;
      broadcast('chat:agent-error', {
        message: 'Agent 启动超时，请重试。如果持续出现，请检查网络连接和 API 配置。'
      });
      broadcast('chat:message-error', 'Agent 启动超时');
      abortPersistentSession();
    };

    // Pre-warm sessions skip startup timeout because SDK CLI needs the first stdin message
    // before sending system_init. During pre-warm, messageGenerator() blocks at waitForMessage()
    // with no message to yield — system_init will only arrive when user sends a message
    // (triggering pre-warm → active transition). If the subprocess crashes during pre-warm,
    // the for-await loop exits naturally and the finally block handles retry.
    if (!preWarm) {
      startupTimeoutId = setTimeout(() => fireStartupTimeout(STARTUP_TIMEOUT_INITIAL_MS), STARTUP_TIMEOUT_INITIAL_MS);
    }

    let messageCount = 0;
    // Pattern 3 §3.2.5 — count stream_event deltas seen during this turn so we
    // can emit a single aggregate `chat:log` at turn-end instead of one per token.
    let streamEventDeltaCount = 0;
    let streamEventTokenTotal = 0;
    // Same aggregation for `system subtype=thinking_tokens` (SDK 0.3.220+):
    // a live estimate frame per streamed thinking chunk (SDKThinkingTokensMessage,
    // meant for spinner UIs — MyAgents renders thinking via chat:thinking-chunk
    // from stream_event instead, so these frames have no functional consumer).
    // Unsynchronized they were ~37k unified-log lines/day + one full-JSON
    // appendLogLine (session file + chat:log SSE) per frame.
    let thinkingTokensFrameCount = 0;
    let thinkingTokensMaxEstimate = 0;

    // #227 — track which background-task ids have already produced a terminal
    // `chat:task-notification` broadcast in THIS SDK session, AND whether that
    // broadcast already carried a RICH (non-empty summary / output_file) payload.
    // Value = true once a rich terminal broadcast has gone out for the id.
    //
    // The SDK exposes two independent terminal channels for the same logical
    // event (task_updated / task_notification — see the lifecycle handler block
    // below, ~L8763). We forward whichever arrives FIRST so the user sees the
    // completion promptly. But the first-to-arrive channel is usually
    // task_updated, whose patch carries only an error string (empty on success)
    // — NOT the rich summary / output_file the later task_notification delivers.
    // So a plain first-wins suppression would drop the real summary on the
    // common happy path. Instead we let a LATER terminal event ENRICH an
    // already-broadcast card when it brings a non-empty summary/output_file the
    // first broadcast lacked. The renderer upserts the
    // `task-notification-<taskId>` history row by id, so the enrich re-broadcast
    // updates the bubble in place rather than duplicating it. Once rich, further
    // events for the id (and events that add nothing new) are suppressed.
    //
    // Lifetime = one for-await loop = one SDK session = one task registry.
    // Tasks can't cross SDK-session boundaries (the registry is in-process to
    // the CLI subprocess), so resetting per-session is correct. No bounded-cap
    // logic needed: the renderer's backgroundTaskStatus.ts has its own LRU,
    // and a single session is realistically bounded to << 1000 background
    // sub-agents.
    const terminalBroadcastedTaskIds = new Map<string, boolean>();

    // ── API response watchdog ──────────────────────────────────────────
    // Detects hung API connections AND hung MCP tool calls.
    // Heartbeat (15s ping) keeps the SSE alive, so Rust's 60s read_timeout
    // never fires. Without this watchdog, the session hangs indefinitely.
    // Unified 10-minute timeout for both API hang and MCP tool hang.
    //
    // `inFlightToolCount` is module-level so the post-interrupt force-close
    // path can read it. Reset here so a new turn starts at 0 even if a
    // prior turn ended via abort/restart without clearing it.
    inFlightToolCount = 0;
    const API_WATCHDOG_INTERVAL_MS = 30_000;
    const WATCHDOG_TIMEOUT_MS = 10 * 60 * 1000; // 10 minutes — unified for API and MCP tools
    // Suspension-aware: only counts time the process was actually running, so
    // macOS sleep / App Nap doesn't get mistaken for a hung turn. See
    // utils/inactivity-watchdog.ts. markActivity() is called per SDK event
    // below; the gate (`!isStreamingMessage`) means evaluateTick only runs
    // during an active turn — the credited tick-gap on the first post-idle tick
    // naturally absorbs inter-turn idle.
    const watchdog = new InactivityWatchdog({ timeoutMs: WATCHDOG_TIMEOUT_MS, intervalMs: API_WATCHDOG_INTERVAL_MS });
    watchdogFired = false;
    apiWatchdogId = setInterval(async () => {
      // Only check during active turns (not pre-warm, not idle between turns)
      if (!isStreamingMessage || lifecycleState.preWarming) return;
      if (watchdogFired) return;
      const { fire: noRecentSdkEvents, suspendedMs } = watchdog.evaluateTick();
      if (suspendedMs > 0) {
        console.log(`[agent] Watchdog: credited ${Math.round(suspendedMs / 1000)}s process suspension (sleep/App Nap) — not counted as inactivity`);
      }

      // Paused on a human (permission prompt / AskUserQuestion / plan approval):
      // their think time is not turn inactivity. Re-baseline the idle clock so
      // the post-answer budget is fresh, and skip the kill. evaluateTick already
      // advanced lastTickAt this tick, so the wait ending produces no spurious
      // suspension credit. (High-2, cross-review.)
      if (hasPendingInteractiveRequest()) {
        watchdog.markActivity();
        return;
      }

      if (noRecentSdkEvents) {
        watchdogFired = true;
        const toolInfo = inFlightToolCount > 0 ? `（${inFlightToolCount} 个工具执行中）` : '';
        console.error(`[agent] Watchdog: no SDK event for ${WATCHDOG_TIMEOUT_MS / 1000}s of active time${toolInfo} — aborting`);

        // ─── DELAYED CONTINUE (set flag) ─────────────────────────────────
        // This is the ONE AND ONLY site that sets `pendingContinueAfterAbort`.
        // `abortPersistentSession()` has multiple other callers (user ESC,
        // config switch, provider switch, deferred restart, error fallbacks)
        // — none of them touch this flag. Putting the set logic here, not
        // inside `abortPersistentSession()`, is what guarantees only
        // watchdog-driven aborts trigger the delayed Continue.
        //
        // Empty-turn skip uses the semantic `turnState.turnHadSubstantiveActivity`
        // flag (set on first non-init SDK frame in the for-await loop;
        // reset by `resetTurnUsage()` at turn start). This replaced the
        // earlier `messageCount > 3` heuristic, which had two problems:
        // (1) messageCount is cumulative across turns in a persistent
        // session, so turn N>1 that aborted with zero activity still
        // satisfied >3 from earlier turns; (2) the "3 init frames"
        // assumption is brittle against SDK init-framing changes.
        // `turnState.currentTurnTextBlocks` was also rejected — gated by
        // `turnState.currentTurnInboxMeta`, never populated on cron / desktop /
        // IM-bot non-inbox sessions. (Caught in cross-review.)
        //
        // `sessionId` is module-level and could mutate during the
        // `await updateSessionMetadata` below if `switchToSession` runs
        // concurrently. Snapshot synchronously so the flag is persisted
        // against the session that actually aborted, not whichever session
        // happens to be current at await-resume time.
        //
        // Persist BEFORE `abortPersistentSession()` to maximize the window
        // for the file write to complete before the sidecar tears down
        // (cron sidecars in particular shut down ~1s after abort).
        const watchdogSessionId = sessionId;
        const autoResumePlan = planWatchdogAutoResume({
          turnHadSubstantiveActivity: turnState.turnHadSubstantiveActivity,
          alreadyAutoResumed: autoResumeInjectedSessions.has(watchdogSessionId),
        });
        if (autoResumePlan.scheduleAutoResume) {
          scheduledWatchdogAutoResumeSessions.add(watchdogSessionId);
        }
        let pendingContinuePersisted = false;
        if (autoResumePlan.persistPendingContinue) {
          try {
            const updated = await updateSessionMetadata(watchdogSessionId, { pendingContinueAfterAbort: true });
            pendingContinuePersisted = updated?.pendingContinueAfterAbort === true;
            if (pendingContinuePersisted) {
              console.log(`[agent] Watchdog: marked session ${watchdogSessionId} pendingContinueAfterAbort=true (turnState.turnHadSubstantiveActivity=true)`);
            } else {
              console.error(`[agent] Watchdog: failed to persist pendingContinueAfterAbort for session ${watchdogSessionId}`);
            }
          } catch (e) {
            console.error('[agent] Watchdog: failed to persist pendingContinueAfterAbort:', e);
          }
        } else if (autoResumeInjectedSessions.has(watchdogSessionId)) {
          console.log(`[agent] Watchdog: auto-resume already injected for session ${watchdogSessionId} - skipping pendingContinueAfterAbort`);
        } else {
          console.log(`[agent] Watchdog: turn had no substantive SDK activity — skipping pendingContinueAfterAbort`);
        }

        broadcast('chat:agent-error', {
          message: `响应超时（10 分钟无活动${toolInfo}），已自动终止。请重试。`
        });
        broadcast('chat:message-error', '响应超时');
        abortPersistentSession();
        if (autoResumePlan.scheduleAutoResume) {
          scheduleWatchdogAutoResumeAfterAbort(watchdogSessionId, {
            allowMissingPendingFlag: !pendingContinuePersisted,
          });
        }
      }
    }, API_WATCHDOG_INTERVAL_MS);

    if (!activeQuery) throw new Error('SDK query session was not initialized');
    let warnedRevokedQueryEvent = false;
    for await (const sdkMessage of activeQuery) {
      if (!isCurrentQueryAuthority(activeQueryAuthority)) {
        if (!warnedRevokedQueryEvent) {
          console.warn('[agent] dropping SDK events from a revoked or replaced Query');
          warnedRevokedQueryEvent = true;
        }
        continue;
      }
      messageCount++;
      watchdog.markActivity();
      // Flip turn-scoped substantive-activity flag on first non-init frame.
      // `system/init` is the boilerplate startup frame and must not count
      // as "this turn produced output" for the watchdog auto-resume decision.
      // Everything else (assistant / user / tool_result / stream_event /
      // result / rate_limit_event / system non-init) is real activity.
      if (!turnState.turnHadSubstantiveActivity) {
        const isBoilerplateInit =
          sdkMessage.type === 'system' &&
          (sdkMessage as { subtype?: string }).subtype === 'init';
        if (!isBoilerplateInit) {
          setSubstantiveActivity(true);
        }
      }
      // stream_event is high-frequency (per token delta) — skip logging entirely.
      // `system subtype=thinking_tokens` frames are the same order of magnitude
      // (one per streamed thinking chunk) and are aggregated below likewise.
      // All other types are low-frequency and logged with type-specific detail:
      //   system/init  — redacted counts/model summary (no workspace/plugin paths)
      //   result       — redacted terminal/usage summary (no assistant/error content)
      //   rate_limit   — key fields (was previously silenced)
      //   others       — compact one-line summary
      const isHighFrequencySdkMessage =
        sdkMessage.type === 'stream_event' ||
        (sdkMessage.type === 'system' &&
          (sdkMessage as { subtype?: string }).subtype === 'thinking_tokens');
      if (!isHighFrequencySdkMessage) {
        const msg = sdkMessage as Record<string, unknown>;
        const safeSdkLogMessage = summarizeSensitiveSdkMessage(sdkMessage);

        if (sdkMessage.type === 'system' && msg.subtype === 'init') {
          console.log(`[agent][sdk] system_init: ${logStringify(safeSdkLogMessage)}`);
        } else if (sdkMessage.type === 'result') {
          console.log(`[agent][sdk] result: ${logStringify(safeSdkLogMessage)}`);
        } else if (sdkMessage.type === 'rate_limit_event') {
          const rli = msg.rate_limit_info as Record<string, unknown> | undefined;
          if (rli) {
            const pct = typeof rli.utilization === 'number' ? Math.round(rli.utilization * 100) : '?';
            const resets = typeof rli.resetsAt === 'number'
              ? new Date((rli.resetsAt as number) * 1000).toISOString()
              : 'n/a';
            console.log(`[agent][sdk] rate_limit: status=${rli.status} utilization=${pct}% type=${rli.rateLimitType} overage=${rli.isUsingOverage} threshold=${rli.surpassedThreshold} resets=${resets}`);
          }
        } else {
          // Compact summary for other types (assistant, user, system/session_state_changed, etc.)
          const model = (msg.message as Record<string, unknown>)?.model ?? '';
          const stopReason = (msg.message as Record<string, unknown>)?.stop_reason ?? '';
          const subtype = msg.subtype ?? '';
          const extra = subtype ? ` subtype=${subtype}` : model ? ` model=${model}` : '';
          const stop = stopReason ? ` stop=${stopReason}` : '';
          console.log(`[agent][sdk] message #${messageCount} type=${sdkMessage.type}${extra}${stop}`);
        }
      }
      // Pattern 3 §3.2.5 — for stream_event (and the equally high-frequency
      // thinking_tokens estimate frames), default-suppress the per-event
      // disk write + SSE broadcast. The token text itself is delivered via
      // chat:message-chunk on a separate code path; the legacy logStringify
      // here was diagnostic only. Track counts so we can emit one aggregate
      // log line per turn (see `result` branch below).
      if (isHighFrequencySdkMessage && SUPPRESS_PER_TOKEN_LOG_BROADCAST) {
        if (sdkMessage.type === 'stream_event') {
          streamEventDeltaCount++;
          const ev = (sdkMessage as { event?: { delta?: unknown; usage?: { output_tokens?: number } } }).event;
          const outTok = ev?.usage?.output_tokens;
          if (typeof outTok === 'number' && outTok > streamEventTokenTotal) {
            streamEventTokenTotal = outTok;
          }
        } else {
          thinkingTokensFrameCount++;
          const est = (sdkMessage as { estimated_tokens?: number }).estimated_tokens;
          if (typeof est === 'number' && est > thinkingTokensMaxEstimate) {
            thinkingTokensMaxEstimate = est;
          }
        }
      } else {
        try {
          const line = `${localTimestamp()} ${logStringify(summarizeSensitiveSdkMessage(sdkMessage))}`;
          appendLogLine(line);
        } catch (error) {
          console.log('[agent][sdk] (unserializable)', error);
        }
        // On turn-end (`result`), emit the high-frequency aggregate so log
        // consumers see "this turn streamed N deltas / M thinking frames"
        // without the per-token spam. Reset counters for the next turn.
        if (sdkMessage.type === 'result' && (streamEventDeltaCount > 0 || thinkingTokensFrameCount > 0)) {
          const thinkingPart = thinkingTokensFrameCount > 0
            ? ` thinking_frames=${thinkingTokensFrameCount} thinking_est_tokens=${thinkingTokensMaxEstimate}`
            : '';
          const summary = `${localTimestamp()} [stream_event_summary] deltas=${streamEventDeltaCount} output_tokens=${streamEventTokenTotal}${thinkingPart}`;
          try { appendLogLine(summary); } catch { /* logger errors are non-fatal */ }
          streamEventDeltaCount = 0;
          streamEventTokenTotal = 0;
          thinkingTokensFrameCount = 0;
          thinkingTokensMaxEstimate = 0;
        }
      }
      const nextSystemInit = parseSystemInitInfo(sdkMessage);
      if (nextSystemInit) {
        // system_init received — clear startup timeout
        if (!systemInitReceived) {
          systemInitReceived = true;
          clearTimeout(startupTimeoutId);
        }
        const canonicalSessionId = !lifecycleState.preWarming
          ? await ensureSessionMetadataForSdkSystemInit(nextSystemInit, activeQueryAuthority)
          : sessionId;
        setSystemInitInfo(nextSystemInit);
        // Buffer system_init during pre-warm; replay when first user message arrives
        if (!lifecycleState.preWarming) {
          sessionRegistered = true;  // SDK 确认注册，后续必须 resume
          // (issue #174) Subprocess is now ready — graduate 'starting' to
          // 'running' so the UI swaps the "AI 启动中" hint for the normal
          // thinking indicator. Skip on pre-warm (state is 'idle' anyway).
          if (sessionState === 'starting') {
            setSessionState('running');
          }
          broadcast('chat:system-init', { info: lifecycleState.systemInitInfo, sessionId: canonicalSessionId, runtime: 'builtin' });
        } else {
          // Pre-warm 不设 sessionRegistered — 这是核心设计约束
          // Pre-warm 的 system_init 只意味着 subprocess 准备好了，
          // 但 SDK 不会在没有用户消息的情况下持久化 session
          preWarmStartedOk = true;
          resetPreWarmFailCount();
          console.log('[agent] pre-warm: system_init buffered (will replay on first message)');
        }

        // system_init confirms SDK session started — consume the rewind anchor.
        // This is the success signal: the UUID was accepted (or wasn't needed).
        // If the UUID had been invalid, the SDK would have exited with error BEFORE system_init.
        if (pendingResumeSessionAt) {
          console.log(`[agent] system_init received — rewind anchor consumed: ${pendingResumeSessionAt}`);
          pendingResumeSessionAt = undefined;
        }
        // PRD 0.2.27 — system_init means the load-captured reloadAnchor (if any) was
        // accepted by the SDK and the session is now truncated correctly; consume it so a
        // later restart/turn doesn't re-apply a now-stale truncation point.
        setPendingReloadAnchor(undefined);

        // Save SDK session_id and verify unified session status
        if (nextSystemInit.session_id) {
          const isUnified = nextSystemInit.session_id === canonicalSessionId;
          if (isUnified) {
            console.log(`[agent] SDK session_id confirmed unified: ${nextSystemInit.session_id}`);
          } else {
            console.log(`[agent] SDK session_id saved (pre-unified): ${nextSystemInit.session_id} (our: ${canonicalSessionId})`);
          }
        }

      }

      const normalizedChangedSlashCommands = parseSdkCommandsChanged(sdkMessage);
      const changedSlashCommands = normalizedChangedSlashCommands
        ? filterSlashCommandsForCapabilities(normalizedChangedSlashCommands, launchCapabilitySnapshot)
        : null;
      if (changedSlashCommands) {
        broadcastSdkSlashCommands(changedSlashCommands, 'commands_changed');
      }

      // Handle system status (e.g., compacting, plan mode changes)
      const statusResult = parseSystemStatus(sdkMessage);
      if (statusResult.isStatusMessage) {
        if (statusResult.status === 'compacting') {
          setCurrentTurnCompactResult(null);
        }
        if (statusResult.compactResult) {
          setCurrentTurnCompactResult(statusResult.compactResult);
        }
        console.log(`[agent] System status: ${statusResult.status}` +
          (statusResult.compactResult ? ` compact_result=${statusResult.compactResult}` : ''));
        broadcast('chat:system-status', {
          status: statusResult.status,
          compactResult: statusResult.compactResult ?? undefined,
          compactError: statusResult.compactError ?? undefined,
        });

        // Detect SDK-initiated plan mode changes (EnterPlanMode is auto-allowed by SDK).
        // Both branches go through the shared transition so the configState.prePlanPermissionMode
        // capture/restore invariant matches the UI-toggle / ExitPlanMode paths.
        if (statusResult.permissionMode === 'plan' && configState.currentPermissionMode !== 'plan') {
          const next = applyPermissionModeSelection(configState.currentPermissionMode, configState.prePlanPermissionMode, 'plan');
          setPermissionPlanState(next);
          broadcast('enter-plan-mode:request', { ...interactiveEventScope(), requestId: `sdk_auto_${Date.now()}`, autoApproved: true });
          broadcast('chat:permission-mode-changed', { permissionMode: 'plan' });
          console.log(`[agent] SDK auto-entered plan mode, saved configState.prePlanPermissionMode=${configState.prePlanPermissionMode}`);
        } else if (statusResult.permissionMode && statusResult.permissionMode !== 'plan' && configState.prePlanPermissionMode) {
          // SDK exited plan mode (e.g. after ExitPlanMode approval). Gate stays on
          // configState.prePlanPermissionMode (truthy) to avoid acting during the optimistic
          // setPermissionMode window; computePlanExitState never restores to 'plan'.
          const next = computePlanExitState(configState.prePlanPermissionMode);
          setPermissionPlanState(next);
          broadcast('chat:permission-mode-changed', { permissionMode: configState.currentPermissionMode });
          console.log(`[agent] SDK exited plan mode, restored configState.currentPermissionMode=${configState.currentPermissionMode}`);
        }
      }

      if (sdkMessage.type === 'system' && (sdkMessage as { subtype?: string }).subtype === 'compact_boundary') {
        setSawCompactBoundary(true);
        if (!turnState.currentTurnCompactResult) {
          setCurrentTurnCompactResult('success');
        }
      }

      // SDK 0.2.83+: session_state_changed — authoritative turn boundary signal.
      // Currently logged for diagnostic comparison with self-built sessionState.
      if (sdkMessage.type === 'system' && (sdkMessage as { subtype?: string }).subtype === 'session_state_changed') {
        const state = (sdkMessage as { state?: string }).state;
        console.log(`[agent] SDK session_state_changed: ${state} (our sessionState: ${sessionState})`);

        // Adaptive startup timeout: extend when subprocess proves alive.
        // SDK emits session_state_changed:running early (before MCP handshake + system_init).
        // First-time workspace initialization on Windows can take minutes (SDK builds caches
        // for large directories). Extend the timeout so it doesn't kill a healthy subprocess.
        if (state === 'running' && !systemInitReceived && !startupTimeoutExtended && startupTimeoutId) {
          startupTimeoutExtended = true;
          clearTimeout(startupTimeoutId);
          startupTimeoutId = setTimeout(() => fireStartupTimeout(STARTUP_TIMEOUT_EXTENDED_MS), STARTUP_TIMEOUT_EXTENDED_MS);
          console.log(`[agent] Startup timeout extended to ${STARTUP_TIMEOUT_EXTENDED_MS / 1000}s (subprocess alive, awaiting system_init)`);
        }
      }

      // Handle background task lifecycle (SDK Task tool with run_in_background)
      // Gated behind type === 'system' to avoid unnecessary property access on high-frequency stream_events
      //
      // #227 — SDK exposes TWO independent channels for the same logical
      // "task is done" event:
      //   1. `task_notification` (user/parent-prompt channel, statuses
      //      'completed' | 'failed' | 'stopped'). NOT guaranteed for every
      //      terminal path — it's emitted from the CLI's internal
      //      `mode:'task-notification'` queue, which can fail to fire when
      //      e.g. the parent session ends before the queue is drained, or
      //      when the task is killed via task_updated without an explicit
      //      `TaskStop` tool call.
      //   2. `task_updated` (state-machine patch channel, terminal statuses
      //      'completed' | 'failed' | 'killed'). Reliably emitted for every
      //      state transition — this is the authoritative "task is done"
      //      signal per the SDK contract. Killed→stopped normalization
      //      matches what the CLI itself does when synthesizing
      //      task_notification (see CLI `f9=A8(Fq)?Fq==='killed'?'stopped':Fq`).
      //
      // We forward whichever arrives first, deduped per task_id via
      // `terminalBroadcastedTaskIds`. The renderer's TabProvider appends a
      // `task-notification-<taskId>` history message on each event — without
      // sidecar-side dedup, the happy path (both events fire) would create
      // duplicate history rows with the same id. Dual investigation: Claude
      // root-traced via session JSONL evidence + binary string surface;
      // Codex independently confirmed the channel separation in the SDK
      // type contract.
      if (sdkMessage.type === 'system') {
        const taskMsg = sdkMessage as { subtype?: string; task_id?: string;
          tool_use_id?: string; description?: string; task_type?: string;
          status?: string; summary?: string; output_file?: string;
          patch?: { status?: string; error?: string; description?: string } };
        if (taskMsg.subtype === 'task_started' && taskMsg.task_id) {
          console.log(`[agent] Background task started: ${taskMsg.task_id} — ${taskMsg.description}`);
          // Record against this exact Query so deferred maintenance cannot
          // confuse foreground result with whole-Query quiescence.
          const recorded = recordQueryBackgroundTask(activeQuery, taskMsg.task_id, {
            toolUseId: taskMsg.tool_use_id,
            description: taskMsg.description,
          });
          if (recorded) {
            broadcast('chat:task-started', {
              sessionId,
              taskId: taskMsg.task_id,
              toolUseId: taskMsg.tool_use_id,
              description: taskMsg.description,
              taskType: taskMsg.task_type,
            });
          } else {
            console.warn(`[agent] Ignoring task_started from superseded Query: ${taskMsg.task_id}`);
          }
        } else if (taskMsg.subtype === 'task_notification' && taskMsg.task_id) {
          // Rich iff it carries a real summary or an output_file (the
          // notification channel is the one that delivers these).
          const isRich = Boolean((taskMsg.summary && taskMsg.summary.trim()) || taskMsg.output_file);
          const priorRich = terminalBroadcastedTaskIds.get(taskMsg.task_id);
          if (priorRich !== undefined && (priorRich || !isRich)) {
            // Already broadcast for this task, and either that broadcast was
            // already rich OR this one adds nothing new — suppress the
            // duplicate. (Happy path that DOES enrich: task_updated{completed}
            // fired first with an empty summary [priorRich=false], so a rich
            // notification here [isRich=true] falls through to re-broadcast.)
            console.log(`[agent] Background task notification ${taskMsg.status} suppressed (no new info; priorRich=${priorRich}): ${taskMsg.task_id}`);
          } else {
            const enriching = priorRich !== undefined;
            terminalBroadcastedTaskIds.set(taskMsg.task_id, isRich);
            console.log(`[agent] Background task ${taskMsg.status}${enriching ? ' (enriching prior broadcast)' : ''}: ${taskMsg.task_id} — ${taskMsg.summary}`);
            broadcast('chat:task-notification', {
              sessionId,
              taskId: taskMsg.task_id,
              toolUseId: taskMsg.tool_use_id,
              status: taskMsg.status,
              summary: taskMsg.summary,
              outputFile: taskMsg.output_file,
            });
            // Reached terminal — release the exact Query task owner. If the
            // foreground result already latched a config restart, the last
            // background task is the missing drain trigger.
            const completion = completeQueryBackgroundTask(activeQuery, taskMsg.task_id);
            if (completion.becameQuiescent && lifecycleState.query === activeQuery) {
              applyDeferredRestartIfNeeded();
            }
          }
        } else if (taskMsg.subtype === 'task_updated' && taskMsg.task_id) {
          const patchStatus = taskMsg.patch?.status;
          // Only terminal patches are actionable for the renderer's "task
          // done" signal. Non-terminal patches (pending/running) leave the
          // UI in its current state.
          if (patchStatus === 'completed' || patchStatus === 'failed' || patchStatus === 'killed') {
            const errorSummary = taskMsg.patch?.error ?? '';
            const backgroundTaskInfo = getQueryBackgroundTask(activeQuery, taskMsg.task_id);
            // task_updated only carries an error string as its summary (empty on
            // success) and never an output_file, so it is "rich" only when that
            // error is non-empty.
            const isRich = Boolean(errorSummary.trim());
            const priorRich = terminalBroadcastedTaskIds.get(taskMsg.task_id);
            if (priorRich !== undefined && (priorRich || !isRich)) {
              console.log(`[agent] Background task patch ${patchStatus} suppressed (no new info; priorRich=${priorRich}): ${taskMsg.task_id}`);
            } else {
              const enriching = priorRich !== undefined;
              terminalBroadcastedTaskIds.set(taskMsg.task_id, isRich);
              // Map 'killed' → 'stopped': the renderer's
              // `backgroundTaskStatus.ts::TERMINAL` set is
              // {completed, error, failed, stopped} and knows nothing about
              // 'killed'. Aligning with the SDK CLI's own normalization
              // keeps the renderer vocab stable.
              const normalized = patchStatus === 'killed' ? 'stopped' : patchStatus;
              console.log(`[agent] Background task ${normalized} (via task_updated)${enriching ? ' (enriching prior broadcast)' : ''}: ${taskMsg.task_id} — patch.status=${patchStatus}${errorSummary ? ` error=${errorSummary}` : ''}`);
              broadcast('chat:task-notification', {
                sessionId,
                taskId: taskMsg.task_id,
                // task_updated.patch doesn't carry tool_use_id, so resolve it
                // from the task_started record. The renderer can also bridge
                // taskId→toolUseId at runtime (registerBackgroundTask), but the
                // PERSISTED `task-notification-<taskId>` history message stores
                // this field verbatim — sending undefined there breaks the
                // panel's history fallback after a reload (it keys on toolUseId).
                // Falls back to undefined (orphan-pool reconciliation) if the
                // start was never observed in this session.
                toolUseId: backgroundTaskInfo?.toolUseId,
                status: normalized,
                summary: errorSummary,
                outputFile: '',
              });
              // Reached terminal — release the exact Query task owner.
              const completion = completeQueryBackgroundTask(activeQuery, taskMsg.task_id);
              if (completion.becameQuiescent && lifecycleState.query === activeQuery) {
                applyDeferredRestartIfNeeded();
              }
            }
          }
        }

        // Handle API retry events (v0.2.77+) — show retry status to user
        // SDK emits these when the Anthropic API returns rate_limit or transient errors
        // and the SDK is automatically retrying. Without handling, user sees "stuck" behavior.
        // Field names match SDKAPIRetryMessage type: attempt, max_retries, retry_delay_ms
        const retryMsg = sdkMessage as { subtype?: string; attempt?: number; max_retries?: number; retry_delay_ms?: number; error?: unknown; error_status?: number | null };
        if (retryMsg.subtype === 'api_retry') {
          isApiRetrying = true;
          const errorStr = typeof retryMsg.error === 'string' ? retryMsg.error : JSON.stringify(retryMsg.error ?? null);
          console.log(`[agent] API retry: attempt=${retryMsg.attempt}/${retryMsg.max_retries}, delay=${retryMsg.retry_delay_ms}ms, error=${errorStr}, status=${retryMsg.error_status ?? 'null'}`);
          broadcast('chat:api-retry', {
            attempt: retryMsg.attempt,
            maxRetries: retryMsg.max_retries,
            delayMs: retryMsg.retry_delay_ms,
          });
        }

        // Refusal-fallback retraction (SDK 0.3.162+): the primary model ended
        // the stream with stop_reason "refusal"; the SDK retries the turn once
        // on a fallback model and names the refused leg's transcriptState.messages for
        // eviction. Without this, the refused partial stays painted AND the
        // retry's content concatenates onto the same streaming bubble.
        // retracted_message_uuids is the complete audit record; the
        // replacement assistant's `supersedes` (handled in the assistant
        // branch) overlaps it — both paths are idempotent by design.
        if (retryMsg.subtype === 'model_refusal_fallback') {
          const rf = sdkMessage as {
            original_model?: string;
            fallback_model?: string;
            api_refusal_category?: string | null;
            retracted_message_uuids?: string[];
          };
          console.warn(`[agent] model refusal fallback: ${rf.original_model} → ${rf.fallback_model}` +
            (rf.api_refusal_category ? ` (category=${rf.api_refusal_category})` : ''));
          await applyMessageRetraction(rf.retracted_message_uuids, 'model_refusal_fallback');
        }

        if (retryMsg.subtype === 'model_refusal_no_fallback') {
          const rf = sdkMessage as {
            original_model?: string;
            api_refusal_category?: string | null;
            api_refusal_explanation?: string | null;
            content?: string;
          };
          const refusalDetail = rf.content || rf.api_refusal_explanation || '模型拒绝响应，且当前没有可用的 fallback 模型。';
          const categorySuffix = rf.api_refusal_category ? ` (category=${rf.api_refusal_category})` : '';
          console.warn(`[agent] model refusal without fallback: ${rf.original_model ?? 'unknown'}${categorySuffix}: ${refusalDetail}`);
          lastAgentError = refusalDetail;
          broadcast('chat:agent-error', { message: refusalDetail });
          broadcast('chat:message-error', refusalDetail);
        }

        // Sentinel for system message kinds added by FUTURE SDK versions.
        // The set below enumerates every system subtype in SDK 0.3.220
        // (handled or deliberately untouched) — a subtype outside it means the
        // SDK started emitting something we have never seen. Without this log
        // line, new message kinds vanish silently (the pre-0.3.173 default,
        // which is how commands_changed/model_refusal_fallback would have been
        // missed). Warn once per subtype per process to stay grep-able without
        // spamming every turn.
        const sysSubtype = retryMsg.subtype;
        if (sysSubtype && !KNOWN_SYSTEM_SUBTYPES.has(sysSubtype) && !warnedUnknownSystemSubtypes.has(sysSubtype)) {
          warnedUnknownSystemSubtypes.add(sysSubtype);
          console.warn(`[agent][sdk] unknown system message subtype '${sysSubtype}' (new SDK message kind?) — ignored. Check sdk.d.ts for its contract.`);
        }
      }

      // Skip error extraction for api_retry — its .error field describes why the SDK
      // is retrying (e.g. "unknown", "overloaded"), NOT an agent-level error.
      // api_retry is already handled by the dedicated handler above (chat:api-retry).
      const isApiRetry = sdkMessage.type === 'system' &&
        (sdkMessage as { subtype?: string }).subtype === 'api_retry';
      if (!isApiRetry) {
        const agentError = extractAgentError(sdkMessage);
        if (agentError) {
          if (sdkMessage.type === 'assistant') {
            markAssistantMessageError(agentError);
            console.warn('[agent] SDK assistant message reported provisional error; waiting for result frame:', agentError);
          } else {
            lastAgentError = agentError;
            broadcast('chat:agent-error', { message: agentError });
          }
        }
      }
      if (lifecycleState.abortRequested) {
        break;
      }

      if (sdkMessage.type === 'stream_event') {
        // Clear api_retry status when streaming resumes after a successful retry
        if (isApiRetrying) {
          isApiRetrying = false;
          broadcast('chat:api-retry', null);
        }
        const streamEvent = sdkMessage.event;
        if (streamEvent.type === 'content_block_delta') {
          if (streamEvent.delta.type === 'text_delta') {
            if (sdkMessage.parent_tool_use_id) {
              const parentToolUseId = childToolToParent.get(sdkMessage.parent_tool_use_id) ?? null;
              appendToolResultDelta(sdkMessage.parent_tool_use_id, streamEvent.delta.text);
              if (parentToolUseId) {
                broadcast('chat:subagent-tool-result-delta', {
                  parentToolUseId,
                  toolUseId: sdkMessage.parent_tool_use_id,
                  delta: streamEvent.delta.text
                });
              } else {
                // Skip broadcasting delta for stripped Playwright tools (keep in-memory data intact)
                if (!strippedToolResultIds.has(sdkMessage.parent_tool_use_id)) {
                  broadcast('chat:tool-result-delta', {
                    toolUseId: sdkMessage.parent_tool_use_id,
                    delta: streamEvent.delta.text
                  });
                }
              }
            } else {
              // Skip empty chunks (null, undefined, '')
              if (!streamEvent.delta.text) {
                console.log('[agent] Skipping empty chunk');
              } else {
                // Filter out decorative text from third-party APIs before broadcasting
                const decorativeCheck = checkDecorativeToolText(streamEvent.delta.text);
                if (!decorativeCheck.filtered) {
                  emitBuiltinFirstDeltaTrace(streamEvent.delta.text);
                  // Handler first: appendTextChunk → ensureAssistantMessage() may flush
                  // queueState.pendingMidTurnQueue. Broadcast after so frontend splits before new content.
                  if (appendTextChunk(streamEvent.delta.text)) {
                    broadcast('chat:message-chunk', streamEvent.delta.text);
                    markCurrentTurnHasOutput();
                    // IM stream: forward non-subagent text delta to event bus (Pattern B)
                    emitImEvent('delta', streamEvent.delta.text);
                    // Accumulate complete assistant blocks only when the Session
                    // binding owns this turn's assistant delivery.
                    maybeAccumulateChannelDeliveryChunk(streamEvent.index, streamEvent.delta.text);
                  }
                } else {
                  console.log(`[agent] Filtered decorative text from stream (${decorativeCheck.reason})`);
                }
              }
            }
          } else if (streamEvent.delta.type === 'thinking_delta') {
            handleThinkingChunk(streamEvent.index, streamEvent.delta.thinking);
            broadcast('chat:thinking-chunk', {
              index: streamEvent.index,
              delta: streamEvent.delta.thinking
            });
          } else if (streamEvent.delta.type === 'input_json_delta') {
            const toolId = streamIndexToToolId.get(streamEvent.index) ?? '';
            if (sdkMessage.parent_tool_use_id) {
              handleSubagentToolInputDelta(
                sdkMessage.parent_tool_use_id,
                toolId,
                streamEvent.delta.partial_json
              );
              broadcast('chat:subagent-tool-input-delta', {
                parentToolUseId: sdkMessage.parent_tool_use_id,
                toolId,
                delta: streamEvent.delta.partial_json
              });
            } else {
              handleToolInputDelta(streamEvent.index, toolId, streamEvent.delta.partial_json);
              broadcast('chat:tool-input-delta', {
                index: streamEvent.index,
                toolId,
                delta: streamEvent.delta.partial_json
              });
            }
          }
        } else if (streamEvent.type === 'content_block_start') {
          // Implicit thinking close: when a non-thinking content block starts (text, tool_use),
          // force-close any unclosed thinking blocks in backend state.
          // Frontend does its own implicit close, so this keeps backend state consistent.
          if (streamEvent.content_block.type !== 'thinking') {
            const lastAssistant = transcriptState.messages.length > 0 ? transcriptState.messages[transcriptState.messages.length - 1] : null;
            if (lastAssistant?.role === 'assistant' && typeof lastAssistant.content !== 'string') {
              for (const block of lastAssistant.content) {
                if (block.type === 'thinking' && !block.isComplete) {
                  block.isComplete = true;
                  block.thinkingDurationMs = block.thinkingStartedAt ? Date.now() - block.thinkingStartedAt : undefined;
                  console.log('[agent] Implicitly closed orphaned thinking block on new content_block_start');
                }
              }
            }
          }
          // (v0.2.11 cross-bugfix) Removed mid-turn flush here. With deferred
          // yield, pending mid-turn transcriptState.messages aren't sent to SDK until after
          // the prior turn ends, so a text content_block_start is part of
          // the prior turn's output, not a response to a queued follow-up.
          // Pattern B: forward non-subagent block-start activity to event bus.
          if (!sdkMessage.parent_tool_use_id) {
            if (streamEvent.content_block.type === 'text') {
              imTextBlockIndices.add(streamEvent.index);
            } else {
              // Notify non-text block activity (thinking, tool_use) so IM can show placeholder
              emitImEvent('activity', streamEvent.content_block.type);
            }
          }
          // Track block type by stream index for precise subagent content_block_stop handling
          streamIndexToBlockType.set(streamEvent.index, streamEvent.content_block.type);
          if (streamEvent.content_block.type === 'thinking') {
            // Handler first: ensureAssistantMessage() may flush queueState.pendingMidTurnQueue
            // (broadcasting queue:started). The thinking-start broadcast must come AFTER
            // so the frontend splits streaming before adding new content.
            handleThinkingStart(streamEvent.index);
            broadcast('chat:thinking-start', { index: streamEvent.index });
          } else if (streamEvent.content_block.type === 'tool_use') {
            streamIndexToToolId.set(streamEvent.index, streamEvent.content_block.id);
            // Note: thought_signature is no longer extracted here. The bridge strips it from
            // Anthropic-format events to prevent SDK transcript pollution (see #68). The bridge
            // handler caches thought_signatures separately and re-injects on outgoing requests.
            const contentBlock = streamEvent.content_block as { id: string; name: string; input?: Record<string, unknown> };
            const toolPayload = {
              id: contentBlock.id,
              name: contentBlock.name,
              input: contentBlock.input || {},
              streamIndex: streamEvent.index,
            };
            if (sdkMessage.parent_tool_use_id) {
              handleSubagentToolUseStart(sdkMessage.parent_tool_use_id, toolPayload);
              broadcast('chat:subagent-tool-use', {
                parentToolUseId: sdkMessage.parent_tool_use_id,
                tool: toolPayload
              });
            } else {
              // Handler first: ensureAssistantMessage() may flush queueState.pendingMidTurnQueue
              // (broadcasting queue:started). The tool-use-start broadcast must come AFTER
              // so the frontend splits streaming before adding new content.
              handleToolUseStart(toolPayload);
              broadcast('chat:tool-use-start', toolPayload);
              inFlightToolCount++;
            }
          } else if (streamEvent.content_block.type === 'server_tool_use') {
            // Server-side tool use (e.g., 智谱 GLM-4.7's webReader, analyze_image)
            // These are executed by the API provider, not locally
            const serverToolBlock = streamEvent.content_block as {
              type: 'server_tool_use';
              id: string;
              name: string;
              input: Record<string, unknown> | string; // Some APIs return input as JSON string
            };
            streamIndexToToolId.set(streamEvent.index, serverToolBlock.id);

            // Parse input if it's a JSON string (智谱 GLM-4.7 returns input as string)
            let parsedInput: Record<string, unknown> = {};
            if (typeof serverToolBlock.input === 'string') {
              try {
                parsedInput = JSON.parse(serverToolBlock.input);
              } catch {
                // If parsing fails, wrap the string as-is
                parsedInput = { raw: serverToolBlock.input };
              }
            } else {
              parsedInput = serverToolBlock.input || {};
            }

            const toolPayload = {
              id: serverToolBlock.id,
              name: serverToolBlock.name,
              input: parsedInput,
              streamIndex: streamEvent.index
            };
            // Handler first: ensureAssistantMessage() may flush queueState.pendingMidTurnQueue.
            handleServerToolUseStart(toolPayload);
            broadcast('chat:server-tool-use-start', toolPayload);
          } else if (
            // 'tool_result' was removed from the SDK's content_block.type union when
            // claude-agent-sdk 0.2.86 added @anthropic-ai/sdk as a direct dependency
            // (previously the union erased to `string` so the comparison type-checked).
            // Runtime-wise this branch has always been dead for plain 'tool_result' —
            // regular tool results arrive via user-turn content blocks, not stream events.
            (streamEvent.content_block.type === 'web_search_tool_result' ||
              streamEvent.content_block.type === 'web_fetch_tool_result' ||
              streamEvent.content_block.type === 'code_execution_tool_result' ||
              streamEvent.content_block.type === 'bash_code_execution_tool_result' ||
              streamEvent.content_block.type === 'text_editor_code_execution_tool_result' ||
              streamEvent.content_block.type === 'mcp_tool_result') &&
            'tool_use_id' in streamEvent.content_block
          ) {
            const toolResultBlock = streamEvent.content_block as {
              tool_use_id: string;
              content?: string | unknown;
              is_error?: boolean;
            };

            // #293 — never let image-block / data-URL base64 through to SSE / tool
            // state on the start event either; attachments are produced once on the
            // COMPLETE path (user-turn tool_result), this transient preview only
            // needs the redacted text. renderParts.text passes plain strings through.
            const contentStr = extractToolResultRenderParts(toolResultBlock.content).text;

            toolResultIndexToId.set(streamEvent.index, toolResultBlock.tool_use_id);
            if (contentStr) {
              const parentToolUseId =
                childToolToParent.get(toolResultBlock.tool_use_id) ?? sdkMessage.parent_tool_use_id;
              if (parentToolUseId) {
                if (!childToolToParent.has(toolResultBlock.tool_use_id)) {
                  ensureSubagentToolPlaceholder(parentToolUseId, toolResultBlock.tool_use_id);
                }
                handleToolResultStart(
                  toolResultBlock.tool_use_id,
                  contentStr,
                  toolResultBlock.is_error || false
                );
                broadcast('chat:subagent-tool-result-start', {
                  parentToolUseId,
                  toolUseId: toolResultBlock.tool_use_id,
                  content: contentStr,
                  isError: toolResultBlock.is_error || false
                });
              } else {
                // Strip Playwright tool results from frontend broadcast
                const shouldStripResult = isPlaywrightTool(toolResultBlock.tool_use_id);
                if (shouldStripResult) {
                  strippedToolResultIds.add(toolResultBlock.tool_use_id);
                }
                handleToolResultStart(
                  toolResultBlock.tool_use_id,
                  contentStr,
                  toolResultBlock.is_error || false
                );
                broadcast('chat:tool-result-start', {
                  toolUseId: toolResultBlock.tool_use_id,
                  content: shouldStripResult ? PLAYWRIGHT_RESULT_SENTINEL : contentStr,
                  isError: toolResultBlock.is_error || false
                });
              }
            }
          }
        } else if (streamEvent.type === 'content_block_stop') {
          const toolId = streamIndexToToolId.get(streamEvent.index);
          if (sdkMessage.parent_tool_use_id) {
            // Subagent thinking/text blocks: broadcast content-block-stop so frontend can close
            // the thinking timer. Without this, subagent thinking blocks stay "incomplete"
            // and the timer runs for the entire remaining duration of the parent tool call.
            const blockType = streamIndexToBlockType.get(streamEvent.index);
            if (blockType === 'thinking' || blockType === 'text') {
              handleContentBlockStop(streamEvent.index, undefined);
              broadcast('chat:content-block-stop', {
                index: streamEvent.index,
              });
            }
            if (toolId) {
              finalizeSubagentToolInput(sdkMessage.parent_tool_use_id, toolId);
            }
            const toolResultId = toolResultIndexToId.get(streamEvent.index);
            if (toolResultId) {
              toolResultIndexToId.delete(streamEvent.index);
              if (finalizeSubagentToolResult(toolResultId)) {
                const result = getSubagentToolResult(toolResultId) ?? '';
                const parentToolUseId = childToolToParent.get(toolResultId);
                if (parentToolUseId) {
                  broadcast('chat:subagent-tool-result-complete', {
                    parentToolUseId,
                    toolUseId: toolResultId,
                    content: result
                  });
                }
              }
            }
          } else {
            handleContentBlockStop(streamEvent.index, toolId || undefined);
            broadcast('chat:content-block-stop', {
              index: streamEvent.index,
              toolId: toolId || undefined,
              // Block type lets the renderer mark a *text* block complete on stop, so
              // the streaming tail-fade (Markdown rehypeStreamTail) clears once the
              // model finishes the text — even when the turn keeps running (next tool /
              // thinking). Without this the fade lingers on the last chars indefinitely.
              type: streamIndexToBlockType.get(streamEvent.index),
            });
            // IM stream: signal text block end via event bus (Pattern B)
            if (imTextBlockIndices.has(streamEvent.index)) {
              emitImEvent('block-end', '');
              imTextBlockIndices.delete(streamEvent.index);
            }
            // One bound-channel delivery per completed top-level text block.
            const mirroredBlockText = pendingTextBlockTexts.get(streamEvent.index);
            if (mirroredBlockText !== undefined) {
              pendingTextBlockTexts.delete(streamEvent.index);
              stageSessionBoundAssistantBlock(mirroredBlockText);
            }
          }
        }
      } else if (sdkMessage.type === 'user') {
        // (v0.2.12 mid-turn injection) SDKUserMessageReplay handling.
        //
        // CLI subprocess emits a user message with isReplay=true when it
        // drains a queued_command attachment from its commandQueue
        // mid-turn (claude-code/src/QueryEngine.ts:880). The replay's
        // uuid carries our queueItem.id (we stamped it on yield), so a
        // match against queueState.inFlightToCliId means our in-flight item just
        // crossed into the model's context — time to surface it visually
        // and promote the next pending item.
        const isReplay = (sdkMessage as { isReplay?: boolean }).isReplay === true;
        if (isReplay && sdkMessage.uuid && sdkMessage.uuid === queueState.inFlightToCliId) {
          await handleQueuedCommandReplay(sdkMessage);
          continue;
        }
        if (isReplay) {
          // (v0.2.12 Codex review fix #4) Other replay flavours
          // (initial-message ack, batched-message ack, local-command echo).
          // These don't represent new conversation turns, but the replay's
          // uuid is the canonical SDK uuid for our previously-pushed user
          // message. We MUST run the same sdkUuid-assignment loop the
          // non-replay branch uses, otherwise rewindFiles / fork / forkSession
          // checkpoint anchors break for those transcriptState.messages — `transcriptState.currentSessionUuids`
          // alone is insufficient because rewindSession matches by
          // `transcriptState.messages[i].sdkUuid`.
          if (sdkMessage.uuid) {
            addCurrentSessionUuid(sdkMessage.uuid);
            addLiveSessionUuid(sdkMessage.uuid);
            const boundMessageId = bindSdkUuidToLatestUnboundUserMessage(sdkMessage.uuid);
            if (boundMessageId) {
              broadcast('chat:message-sdk-uuid', { messageId: boundMessageId, sdkUuid: sdkMessage.uuid });
            }
          }
          continue;
        }
        // (#228) Suppress SDK-synthetic transcript material from the user-visible
        // channel. The SDK emits "synthetic" user transcriptState.messages for several internal
        // purposes that must never reach the chat UI nor be persisted to
        // SessionStore, because they have no user-visible semantics and their
        // uuids belong to post-compact sessions (rewind anchors break):
        //   - `isCompactSummary: true` — the post-`compact_boundary` continuation
        //     prompt carrying the prior-conversation summary. In long
        //     conversations the summary text often embeds historical
        //     `<local-command-stdout>` substrings from prior /cost or /compact
        //     echoes, which previously slipped past the local-command branch
        //     below and materialized as a phantom user bubble.
        //   - `isMeta: true` — meta transcriptState.messages (e.g. tool-trigger prompts CLI emits).
        //   - `isSynthetic: true` — generic SDK-synthetic marker (also used
        //     for some queued-command pseudo-replays below; covered for
        //     defense-in-depth).
        //   - `isVisibleInTranscriptOnly: true` — explicit SDK marker for
        //     "show in transcript file only, never user-visible" (semantic
        //     superset of the above).
        // These flags are runtime properties of the live SDK stream events
        // (verified against on-disk transcript JSONL); the public
        // `SDKUserMessage` type only declares `isSynthetic?`. UUID tracking
        // is still skipped (matches the prior `!isSynthetic` guard).
        const syntheticFlags = sdkMessage as {
          isCompactSummary?: boolean;
          isMeta?: boolean;
          isSynthetic?: boolean;
          isVisibleInTranscriptOnly?: boolean;
        };
        if (
          syntheticFlags.isCompactSummary ||
          syntheticFlags.isMeta ||
          syntheticFlags.isSynthetic ||
          syntheticFlags.isVisibleInTranscriptOnly
        ) {
          continue;
        }
        // Track SDK user UUID — only for non-synthetic transcriptState.messages
        if (sdkMessage.uuid) {
          addCurrentSessionUuid(sdkMessage.uuid);
          addLiveSessionUuid(sdkMessage.uuid);
          const boundMessageId = bindSdkUuidToLatestUnboundUserMessage(sdkMessage.uuid);
          if (boundMessageId) {
            broadcast('chat:message-sdk-uuid', { messageId: boundMessageId, sdkUuid: sdkMessage.uuid });
          }
        }
        // Process tool_result blocks from user transcriptState.messages
        // This handles both subagent results (parent_tool_use_id set) and top-level tool results (parent_tool_use_id null)
        if (sdkMessage.message?.content) {
          const messageContent = sdkMessage.message.content;

          // Handle local command output (e.g., /cost, /context commands).
          // SDK sends these as user transcriptState.messages with string content wrapped in
          // <local-command-stdout> tags. (#228) Match `startsWith` (after
          // whitespace trim), not `includes` — real CLI echoes always begin
          // with the tag, but arbitrary text bodies (e.g. compact summaries
          // that quote prior conversation verbatim) may embed the tag as a
          // substring and used to false-positive into the user-visible
          // channel. The synthetic guard above is the primary defense; this
          // tightening is belt-and-suspenders.
          if (typeof messageContent === 'string' && messageContent.trimStart().startsWith('<local-command-stdout>')) {
            const localCommandMessage: MessageWire = {
              id: allocateMessageId(),
              role: 'user',
              content: [
                SYSTEM_REMINDER_OPEN,
                `<${LOCAL_COMMAND_OUTPUT_TAG}>`,
                'Runtime-generated local command output; the visible output follows this reminder.',
                `</${LOCAL_COMMAND_OUTPUT_TAG}>`,
                SYSTEM_REMINDER_CLOSE,
                messageContent,
              ].join('\n'),
              timestamp: new Date().toISOString(),
            };
            appendMessage(localCommandMessage);
            broadcast('chat:message-replay', createLiveUserMessageReplay(sessionId, localCommandMessage));
            await persistMessagesToStorage();
          }

          // Check for structured tool_use_result data (e.g., WebSearch results)
          const toolUseResultData = (sdkMessage as { tool_use_result?: unknown }).tool_use_result;

          // Only iterate if content is an array (tool_result blocks)
          if (Array.isArray(messageContent)) {
            for (const block of messageContent) {
            if (
              typeof block === 'object' &&
              block !== null &&
              'type' in block &&
              block.type === 'tool_result' &&
              'tool_use_id' in block
            ) {
              const toolResultBlock = block as {
                tool_use_id: string;
                content: string | unknown;
              };

              // #293 — split image-bearing blocks out of the raw content BEFORE any
              // stringification: extracted sources become disk-backed ToolAttachments
              // below; the remaining text has every base64-ish payload redacted to
              // `[N bytes omitted]`. Session JSONL / SSE only ever carry path refs —
              // the SDK's own transcript (what the model sees) is untouched.
              const renderParts = extractSdkToolResultRenderParts(toolResultBlock.content, toolUseResultData);
              const contentStr = renderParts.text;

              const parentToolUseId =
                childToolToParent.get(toolResultBlock.tool_use_id) ?? sdkMessage.parent_tool_use_id;
              if (parentToolUseId) {
                if (!childToolToParent.has(toolResultBlock.tool_use_id)) {
                  ensureSubagentToolPlaceholder(parentToolUseId, toolResultBlock.tool_use_id);
                }
                handleToolResultComplete(toolResultBlock.tool_use_id, contentStr);
                broadcast('chat:subagent-tool-result-complete', {
                  parentToolUseId,
                  toolUseId: toolResultBlock.tool_use_id,
                  // Subagent media is not yet attached (pipeline doc §10 residual) —
                  // leave an honest text trace instead of silently dropping the image.
                  content: appendOmittedImageNote(contentStr, renderParts.attachments.length)
                });
              } else {
                // Top-level tool result (e.g., WebSearch without parent)
                const stripped = strippedToolResultIds.has(toolResultBlock.tool_use_id) || isPlaywrightTool(toolResultBlock.tool_use_id);
                // PRD 0.2.30 + #293 — unified media entry: file-path media (edge-tts /
                // gemini-image) AND extracted image blocks (Playwright screenshots,
                // generic MCP ImageContent) → first-class disk-backed attachments.
                const attachments = await attachBuiltinMediaIfAny(
                  toolResultBlock.tool_use_id,
                  contentStr,
                  renderParts.attachments,
                );
                handleToolResultComplete(toolResultBlock.tool_use_id, contentStr);
                broadcast('chat:tool-result-complete', {
                  toolUseId: toolResultBlock.tool_use_id,
                  content: stripped ? PLAYWRIGHT_RESULT_SENTINEL : contentStr,
                  ...(attachments ? { attachments } : {}),
                });
                inFlightToolCount = Math.max(0, inFlightToolCount - 1);
              }
            }
          }
          }
        }
      } else if (sdkMessage.type === 'assistant') {
        // Refusal-fallback supersede (SDK 0.3.162+): this assistant message is
        // the canonical replacement for previously-delivered transcriptState.messages of a
        // refused leg. Evict them BEFORE ensureAssistantMessage() — eviction
        // resets isStreamingMessage when it removes the refused streaming
        // bubble, so the replacement starts a fresh bubble instead of
        // concatenating onto refused content. Idempotent with the
        // model_refusal_fallback notice that usually precedes this message.
        const supersedes = (sdkMessage as { supersedes?: string[] }).supersedes;
        if (supersedes && supersedes.length > 0) {
          await applyMessageRetraction(supersedes, 'assistant.supersedes');
        }
        // Track SDK assistant UUID for resumeSessionAt / rewindFiles
        const currentAssistant = ensureAssistantMessage();
        // 始终更新为最新的 UUID — SDK 一个回合可能输出多条 assistant 消息
        // （thinking → text），resumeSessionAt 需要最后一条的 UUID 才能保留完整回答
        if (sdkMessage.uuid) {
          addCurrentSessionUuid(sdkMessage.uuid);
          addLiveSessionUuid(sdkMessage.uuid);
          const boundMessageId = bindSdkUuidToMessage(currentAssistant, sdkMessage.uuid);
          // Broadcast to frontend so fork button appears during streaming
          // (user transcriptState.messages already broadcast this; assistant transcriptState.messages were missing it)
          broadcast('chat:message-sdk-uuid', { messageId: boundMessageId, sdkUuid: sdkMessage.uuid });
        }
        const assistantMessage = sdkMessage.message;
        // The result message remains the canonical turn total. Accumulate assistant
        // frames as a best-available fallback for hard stop/error paths where no
        // result arrives; include subagent frames because their usage is part of the turn.
        const rawUsage = (assistantMessage as {
          usage?: {
            input_tokens?: number;
            output_tokens?: number;
            prompt_tokens?: number;
            completion_tokens?: number;
            cache_read_input_tokens?: number;
            cache_creation_input_tokens?: number;
          };
        }).usage;
        const assistantUsage = rawUsage ? {
          inputTokens: rawUsage.input_tokens ?? rawUsage.prompt_tokens ?? 0,
          outputTokens: rawUsage.output_tokens ?? rawUsage.completion_tokens ?? 0,
          cacheReadTokens: rawUsage.cache_read_input_tokens ?? 0,
          cacheCreationTokens: rawUsage.cache_creation_input_tokens ?? 0,
        } : undefined;
        if (assistantUsage) accumulateCurrentTurnUsage(assistantUsage);
        const subagentUsage = assistantUsage ? {
          input_tokens: assistantUsage.inputTokens,
          output_tokens: assistantUsage.outputTokens,
        } : undefined;

        // PRD 0.2.32 — context 占用：记录最近一条**主轮**（非子 Agent）assistant message 的 usage。
        // 每次重发整段上下文，所以「最近一条的 input+cache」即「此刻窗口装了多少」。子 Agent
        // 消息（parent_tool_use_id 存在）有独立上下文，不能算进主会话占用。
        if (!sdkMessage.parent_tool_use_id && assistantUsage) {
          setLatestMainAssistantUsage(assistantUsage);
        }

        if (sdkMessage.parent_tool_use_id && assistantMessage.content) {
          for (const block of assistantMessage.content) {
            if (
              typeof block === 'object' &&
              block !== null &&
              'type' in block &&
              block.type === 'tool_use' &&
              'id' in block &&
              'name' in block
            ) {
              const toolBlock = block as {
                id: string;
                name: string;
                input?: Record<string, unknown>;
              };
              const payload = {
                id: toolBlock.id,
                name: toolBlock.name,
                input: toolBlock.input || {}
              };
              handleSubagentToolUseStart(sdkMessage.parent_tool_use_id, payload);
              broadcast('chat:subagent-tool-use', {
                parentToolUseId: sdkMessage.parent_tool_use_id,
                tool: payload,
                usage: subagentUsage
              });
            }
          }
        }
        if (sdkMessage.parent_tool_use_id) {
          const text = formatAssistantContent(assistantMessage.content);
          if (text) {
            const next = appendToolResultContent(sdkMessage.parent_tool_use_id, text);
            const stripped = strippedToolResultIds.has(sdkMessage.parent_tool_use_id) || isPlaywrightTool(sdkMessage.parent_tool_use_id);
            broadcast('chat:tool-result-complete', {
              toolUseId: sdkMessage.parent_tool_use_id,
              content: stripped ? PLAYWRIGHT_RESULT_SENTINEL : next
            });
          }
        }
        if (assistantMessage.content) {
          for (const block of assistantMessage.content) {
            if (
              typeof block === 'object' &&
              block !== null &&
              'tool_use_id' in block &&
              'content' in block
            ) {
              const toolResultBlock = block as {
                tool_use_id: string;
                content: string | unknown[] | unknown;
                is_error?: boolean;
              };

              // #293 — Site B mirrors Site A (cross-review finding 1): extract image
              // blocks BEFORE stringification so this sibling delivery path can't
              // re-introduce base64 into SSE / JSONL. Non-string content collapses to
              // the redacted joined text (single text block → its inner text — same
              // shape the old hand-rolled mapper produced for the common case).
              const renderParts = extractToolResultRenderParts(toolResultBlock.content);
              // renderParts.text passes plain strings through verbatim and yields ''
              // for a bare data-URL string whose bytes were extracted (finding 2).
              const contentStr = renderParts.text;

              const parentToolUseId =
                childToolToParent.get(toolResultBlock.tool_use_id) ?? sdkMessage.parent_tool_use_id;
              if (parentToolUseId) {
                if (!childToolToParent.has(toolResultBlock.tool_use_id)) {
                  ensureSubagentToolPlaceholder(parentToolUseId, toolResultBlock.tool_use_id);
                }
                handleToolResultComplete(
                  toolResultBlock.tool_use_id,
                  contentStr,
                  toolResultBlock.is_error || false
                );
                broadcast('chat:subagent-tool-result-complete', {
                  parentToolUseId,
                  toolUseId: toolResultBlock.tool_use_id,
                  // Subagent media is not yet attached (pipeline doc §10 residual) —
                  // leave an honest text trace instead of silently dropping the image.
                  content: appendOmittedImageNote(contentStr, renderParts.attachments.length),
                  isError: toolResultBlock.is_error || false
                });
              } else {
                const stripped = strippedToolResultIds.has(toolResultBlock.tool_use_id) || isPlaywrightTool(toolResultBlock.tool_use_id);
                // PRD 0.2.30 + #293 — unified media entry (file-path media + extracted
                // image blocks). Idempotent with Site A; only one delivery path fires
                // per tool result.
                const attachments = toolResultBlock.is_error
                  ? undefined
                  : await attachBuiltinMediaIfAny(toolResultBlock.tool_use_id, contentStr, renderParts.attachments);
                handleToolResultComplete(
                  toolResultBlock.tool_use_id,
                  contentStr,
                  toolResultBlock.is_error || false
                );
                broadcast('chat:tool-result-complete', {
                  toolUseId: toolResultBlock.tool_use_id,
                  content: stripped ? PLAYWRIGHT_RESULT_SENTINEL : contentStr,
                  isError: toolResultBlock.is_error || false,
                  ...(attachments ? { attachments } : {}),
                });
                inFlightToolCount = Math.max(0, inFlightToolCount - 1);
              }
            }
          }
        }

        // Handle non-streamed text content from assistant transcriptState.messages.
        // Some providers (OpenAI-compatible, third-party Anthropic proxies) return responses
        // without streaming content_block_delta text events — the text only appears in the
        // final assistant message. Without this, turnState.currentTurnHasOutput stays false and the
        // result handler erroneously shows normal responses as agent-error banners.
        // Skip error-wrapped transcriptState.messages (SDK sets "error" field on synthetic error responses)
        // — these should be surfaced via the result handler's agent-error banner instead.
        const isErrorWrapped = !!(sdkMessage as Record<string, unknown>).error;
        if (!sdkMessage.parent_tool_use_id && !turnState.currentTurnHasOutput && !isErrorWrapped && assistantMessage.content) {
          const nonStreamedParts: string[] = [];
          for (const block of assistantMessage.content) {
            if (
              typeof block === 'object' &&
              block !== null &&
              'type' in block &&
              block.type === 'text' &&
              'text' in block
            ) {
              const text = String((block as { text: string }).text || '');
              if (text) nonStreamedParts.push(text);
            }
          }
          const nonStreamedText = nonStreamedParts.join('');
          if (nonStreamedText) {
            console.log(`[agent] Non-streamed assistant text detected (${nonStreamedText.length} chars), broadcasting as message-chunk`);
            // Handler first: appendTextChunk → ensureAssistantMessage() may flush
            // queueState.pendingMidTurnQueue. Broadcast after so frontend splits before new content.
            if (appendTextChunk(nonStreamedText)) {
              broadcast('chat:message-chunk', nonStreamedText);
              markCurrentTurnHasOutput();
              emitImEvent('delta', nonStreamedText);
              stageSessionBoundAssistantBlock(nonStreamedText);
            }
          }
        }
      } else if (sdkMessage.type === 'result') {
        await builtinTurnLifecycle.handleSdkResult(sdkMessage as BuiltinSdkResultMessage);
      } else if (!KNOWN_MESSAGE_TYPES.has(sdkMessage.type) && !warnedUnknownMessageTypes.has(sdkMessage.type)) {
        // Top-level half of the unknown-message sentinel (the system-subtype
        // half lives in the system block above): a type outside the 0.3.220
        // union means a NEWER SDK started emitting a message kind this loop
        // has never seen — log once instead of letting it vanish silently.
        warnedUnknownMessageTypes.add(sdkMessage.type);
        console.warn(`[agent][sdk] unknown SDK message type '${sdkMessage.type}' (new SDK message kind?) — ignored. Check sdk.d.ts for its contract.`);
      }
    }
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : 'Unknown error occurred';
    // (issue #174) Pre-launch abort sentinel — clean exit, not a real error.
    // Skip the loud session-error log + the all-recovery branches below;
    // jump straight to finally for state cleanup. lifecycleState.abortRequested is
    // already true (set by interruptCurrentResponse), and the finally block
    // will run setSessionState('idle') / unregister bridge / resolve
    // lifecycleState.termination. Without this short-circuit the message
    // would reach console.error and look like a real failure.
    if (errorMessage === 'STARTUP_ABORTED_BY_STOP') {
      console.log('[agent] session start aborted pre-launch by user stop');
      return;
    }
    const errorStack = error instanceof Error ? error.stack : String(error);
    console.error('[agent] session error:', errorMessage);
    console.error('[agent] session error stack:', errorStack);
    const recoveredInvalidResumeAnchors: InvalidResumeAnchorKind[] = [];

    // "Session ID already in use" recovery: SDK session dir exists on disk but our
    // in-memory metadata was lost (fresh Bun process after crash/restart).
    // Fix: switch to resume mode. Pre-warm retry (finally block) will use resume.
    // For non-pre-warm: schedule pre-warm to establish resumed session; user's message
    // is lost for this attempt, but the next message will work correctly.
    if (detectedAlreadyInUse && !sessionRegistered) {
      console.warn(`[agent] Session ${sessionId} exists on disk but metadata lost, switching to resume for retry`);
      sessionRegistered = true;
      if (!lifecycleState.preWarming) {
        schedulePreWarm(); // Establish resumed session so next user message works
      }
      return; // Skip error broadcast, let finally handle cleanup + pre-warm retry
    }

    // "No message found with message.uuid" recovery: resumeSessionAt pointed to a UUID
    // that doesn't exist in the SDK's session JSONL. This happens when:
    //   - Session was rebuilt (No conversation found → new session, old UUIDs stale)
    //   - SDK's async JSONL save didn't flush before subprocess was interrupted
    //   - transcriptState.currentSessionUuids (seeded from disk) included UUIDs from a previous SDK session
    // Fix: clear the invalid rewind anchor so retry resumes with full history intact.
    // Keep sessionRegistered=true — the session itself exists, only the UUID is wrong.
    // The retry will use `resume: sessionId` without resumeSessionAt, loading all transcriptState.messages.
    // Two durable anchors can be the rejected UUID:
    //   1. pendingResumeSessionAt (in-memory) — set by rewindSession()
    //   2. SessionMetadata.forkFrom.messageUuid (disk-persisted) — set by forkSession()
    // effectiveResumeAt prefers rewindResumeAt ?? forkResumeAt (see line ~7776), so
    // when both are set the rewind UUID is the one actually sent to the SDK. Capture
    // that here so the fork branch below can avoid clearing an innocent fork anchor.
    const rewindAnchorWasSent = isSdkMissingResumeMessageError(errorMessage)
      && pendingResumeSessionAt !== undefined;

    // Rewind-mode "No message found" recovery (issue #189). Fires when the session
    // is registered, OR whenever there is a stale in-memory rewind anchor to clear —
    // even on an unregistered (fresh) fork. A fresh fork can carry a rewind anchor:
    // rewindSession() sets pendingResumeSessionAt for any UUID in transcriptState.currentSessionUuids
    // (disk-seeded from the copied transcriptState.messages), regardless of sessionRegistered. If that
    // anchor is then rejected by the SDK while sessionRegistered=false, gating purely on
    // sessionRegistered would skip this branch AND the fork branch below (rewindAnchorWasSent
    // is true) — neither anchor clears and every retry resends the same UUID (the #220
    // loop class, fresh-fork sub-case). Clearing an in-memory anchor is safe in any
    // registration state, so allow it whenever pendingResumeSessionAt is set.
    if (isSdkMissingResumeMessageError(errorMessage)
      && (sessionRegistered || pendingResumeSessionAt !== undefined)) {
      const rejectedUuid = pendingResumeSessionAt;
      pendingResumeSessionAt = undefined;
      // Evict the rejected UUID from transcriptState.currentSessionUuids so subsequent rewinds don't
      // re-accept it via the OR logic. Without this, the stale UUID stays in the cache
      // and a future rewind to the same point would re-trigger the same SDK error.
      // Only log/evict when there was an ACTUAL rewind anchor: on a reloadAnchor rejection
      // this branch still enters (sessionRegistered=true) with rejectedUuid===undefined —
      // the reloadAnchor branch below owns + logs that case, so stay quiet here (no
      // misleading "clearing rewind anchor" line on the high-stakes cold-reload path).
      if (rejectedUuid) {
        console.warn(`[agent] resumeSessionAt UUID rejected by SDK — clearing rewind anchor, retry will resume with full history`);
        deleteCurrentSessionUuid(rejectedUuid);
        recoveredInvalidResumeAnchors.push('rewind');
      }
      // Don't modify sessionRegistered — session exists, just the UUID is invalid.
      // Don't return — let pre-warm retry (finally block) handle recovery.
      // For non-pre-warm (user message triggered): fall through to error broadcast.
    }

    // PRD 0.2.27 reloadAnchor "No message found" recovery (decision 6). The cold-reload
    // anchor (transcriptState.pendingReloadAnchor, captured at LOAD) can be stale if compact/snip removed
    // that uuid from the SDK transcript. The pre-warm retry does NOT reload, so it would
    // reuse the same transcriptState.pendingReloadAnchor → SDK rejects again. Break the loop like the rewind
    // branch: evict the uuid from transcriptState.currentSessionUuids (so a future re-load's
    // deriveReloadResumeAnchor `.has()` gate also fails) AND clear the captured anchor
    // (generation-guarded — only if a newer start hasn't replaced it). Uses the query-scoped
    // `sentReloadAnchor`, not the module var, so a late catch from an aborted start can't
    // evict against a newer session. Retry resumes with full history (window-B reconcile
    // skipped this round; self-heals once the user continues and a newer leaf is written).
    if (isSdkMissingResumeMessageError(errorMessage) && sentReloadAnchor) {
      console.warn(`[agent] reloadAnchor UUID ${sentReloadAnchor} rejected by SDK — evicting from transcriptState.currentSessionUuids so retry resumes with full history (no re-derive loop)`);
      deleteCurrentSessionUuid(sentReloadAnchor);
      // Clear the load-captured anchor only if it's still THIS query's — a newer load/start
      // may have already replaced it; don't wipe a newer session's pending anchor.
      if (transcriptState.pendingReloadAnchor === sentReloadAnchor) setPendingReloadAnchor(undefined);
      recoveredInvalidResumeAnchors.push('reload');
    }

    // Fork-mode "No message found" recovery (issue #220). The durable anchor here lives
    // in `SessionMetadata.forkFrom.messageUuid` (disk-persisted), not in-memory, so we
    // must mutate + persist the metadata or every retry rereads the stale UUID.
    //
    // NOT gated on `sessionRegistered`: a fresh fork session has sessionRegistered=false
    // until SDK's first non-error result lands, but that's exactly when this error fires.
    //
    // Skip when the rewind branch above was the actual culprit — clearing both anchors
    // on every "No message found" would over-degrade a still-good fork anchor. If the
    // fork anchor is also stale, the next retry's effectiveResumeAt will fall through to
    // it, SDK will reject again, and this branch will fire on that pass.
    //
    // Trade-off: dropping the fork anchor degrades semantics — SDK forks at source's
    // *tail*, not the user-clicked midpoint. AI then sees more source context than the
    // UI shows (UI has the N copied transcriptState.messages; SDK has all source transcriptState.messages). Same
    // degradation philosophy as the rewind branch's "resume with full history". Better
    // than a fail-loop or losing the fork entirely.
    if (isSdkMissingResumeMessageError(errorMessage) && !rewindAnchorWasSent) {
      const failedForkMeta = getSessionMetadata(sessionId);
      if (failedForkMeta?.forkFrom?.messageUuid) {
        const rejectedForkUuid = failedForkMeta.forkFrom.messageUuid;
        console.warn(`[agent] forkSession anchor UUID ${rejectedForkUuid} rejected by SDK (source store no longer contains it) — clearing anchor; retry will fork at source tail`);
        delete failedForkMeta.forkFrom.messageUuid;
        try {
          await saveSessionMetadata(failedForkMeta);
        } catch (saveErr) {
          // Persist failure → disk still has the stale UUID. The next retry reads
          // it back and SDK rejects again → this branch fires again → save retries.
          // Eventually converges or the underlying I/O issue surfaces. Don't bail.
          console.warn(`[agent] forkFrom.messageUuid clear: disk persist failed (next retry will re-read stale UUID and re-enter this recovery): ${(saveErr as Error)?.message ?? saveErr}`);
        }
        deleteCurrentSessionUuid(rejectedForkUuid);
        recoveredInvalidResumeAnchors.push('fork');
      }
    }
    const suppressRecoveredResumeAnchorError = shouldSuppressRecoveredResumeAnchorError({
      errorMessage,
      recoveredAnchors: recoveredInvalidResumeAnchors,
    });

    // "No conversation found" recovery: our metadata has sessionRegistered=true but
    // the SDK session directory is gone (e.g., IM Bot restart after previous Sidecar
    // failed to start — proxy leak, network error — so the session was persisted to
    // im_state.json but the SDK conversation was never actually created).
    // Fix: switch to create mode. Don't return — let the error flow through to notify
    // IM/Desktop user. Pre-warm (scheduled here or in finally) will create a fresh session.
    if (errorMessage.includes('No conversation found') && sessionRegistered) {
      console.warn(`[agent] Session ${sessionId} not found by SDK, resetting sessionRegistered for fresh start`);
      sessionRegistered = false;
      if (!lifecycleState.preWarming) {
        schedulePreWarm(); // Establish fresh session so next user message works
      }
      // Fall through to error handling so IM SSE stream closes properly
    }

    // Cross-platform SDK subprocess diagnostics. Deterministic executable
    // denials also carry the Rust circuit's next legal probe delay.
    let userFacingError = errorMessage;
    const sdkSubprocessDiagnostic = diagnoseSdkSubprocessFailure({
      error,
      errorMessage,
      stderr: recentSdkStderr,
    });
    if (sdkSubprocessDiagnostic) {
      sdkLaunchRetryDelayMs = sdkSubprocessDiagnostic.automaticRetryDelayMs;
      console.error(
        `[agent] SDK subprocess failure classified: kind=${sdkSubprocessDiagnostic.kind} ` +
        `code=${sdkSubprocessDiagnostic.errorCode ?? sdkSubprocessDiagnostic.exitCodeHex ?? 'unknown'} ` +
        `platform=${process.platform}`,
      );
      userFacingError = sdkSubprocessDiagnostic.userMessage;
    }

    // Don't broadcast errors to frontend during pre-warm.
    // Failure counting is handled uniformly in the finally block via preWarmStartedOk flag,
    // so we don't increment lifecycleState.preWarmFailCount here — avoids double-counting when both
    // catch and finally execute for the same failed pre-warm.
    //
    // Also skip when `lifecycleState.abortRequested` is set: that flag means WE asked
    // the SDK subprocess to die (resetSession, rewind, config-change restart,
    // user deleting the current session, etc.). If the abort lands mid-turn
    // while a tool call is in flight, the CLI's stdout gets truncated and
    // the SDK's `readMessages` parser throws
    //   "Claude Code returned an error result: [ede_diagnostic]
    //    result_type=user last_content_type=n/a stop_reason=tool_use"
    // That's an expected side-effect of the abort, not a real failure — the
    // user already saw the reset/delete go through and shouldn't then get a
    // red "message-error" banner about it. Pit-of-success: any SDK error
    // during an active abort is by definition our doing, not a provider/infra
    // issue to surface. Error is still logged above (line 6611–6612) for
    // debugging, just not broadcast.
    if (suppressRecoveredResumeAnchorError) {
      console.log(`[agent] Suppressing recoverable SDK resumeSessionAt error after clearing ${recoveredInvalidResumeAnchors.join(',')} anchor(s); recovery pre-warm will retry with bare resume`);
    } else if (!lifecycleState.preWarming && !lifecycleState.abortRequested) {
      const completionTerminal = handleMessageError(errorMessage, sdkSubprocessDiagnostic?.imMessage);
      setSessionState('error');
      broadcast(
        'chat:message-error',
        withSessionCompletionTerminal(userFacingError, completionTerminal),
      );
    } else if (lifecycleState.abortRequested) {
      console.log(`[agent] Suppressing SDK error surfaced during abort (expected): ${errorMessage}`);
    }
  } finally {
    clearTimeout(startupTimeoutId);
    clearInterval(apiWatchdogId);
    const wasPreWarming = lifecycleState.preWarming;
    setPreWarmInProgress(false);
    setSessionProcessing(false);
    clearTransientProviderRetryTimer('session-finally');

    // Resolve any pending post-interrupt wait (session ended without a result,
    // so the interrupt caller remains the terminal claimant).
    settlePostInterruptTurnEnd('session-ended');

    // 确保 generator 退出（防止 streamInput 永远阻塞）
    if (lifecycleState.messageResolver) {
      const resolve = lifecycleState.messageResolver;
      clearGeneratorResolver();
      resolve(null);
    }

    // 防御：确保 isStreamingMessage 在 session 退出时被重置。
    // 正常路径由 handleMessageComplete/Stopped/Error 处理，但 subprocess
    // 崩溃可能导致这些 handler 未执行，标志孤立为 true。
    // 孤立的 true 会让所有新消息走 queue 路径（line 3350）且无人消费。
    if (isStreamingMessage) {
      console.warn('[agent] isStreamingMessage orphaned after session exit, resetting');
      isStreamingMessage = false;
    }

    // (v0.2.12 latent bug fix — Codex finding) Rescue any pending mid-turn
    // items into queueState.messageQueue so the recovery generator picks them up.
    // Without this, an unexpected SDK exit (subprocess crash, error
    // surfaced after handleMessageError but BEFORE abortPersistentSession's
    // own rescue) leaves queueState.pendingMidTurnQueue items orphaned: the new
    // generator only consumes from queueState.messageQueue, the items would never be
    // delivered. abortPersistentSession's rescue covers the explicit-abort
    // path; this finally-block rescue is the catch-all for every other
    // exit shape (catch block didn't run abortPersistentSession, for-await
    // throws on transport error, etc.). Also terminate any unconfirmed
    // in-flight CLI tracking honestly — the CLI subprocess is gone, those
    // uuids can no longer produce replay/assistant-start confirmation.
    const pendingMidTurnCount = getPendingMidTurnQueue().length;
    if (pendingMidTurnCount > 0) {
      console.log(`[agent] finally: rescuing ${pendingMidTurnCount} pending mid-turn item(s) into queueState.messageQueue`);
      rescuePendingToQueue();
    }
    dropInFlightQueueItem('session exited before SDK consumption confirmation', 'failed');

    // Queue lifecycle invariant: queueState.messageQueue survives session restarts by default.
    // Any drain decision belongs to the caller that triggered the exit, not here:
    //   - interruptCurrentResponse (stop button): drains only when called with no
    //     active turn (orphaned queue). When a turn is in flight, stop cancels
    //     THAT turn; queued transcriptState.messages naturally flow into the recovery session.
    //   - forceExecuteQueueItem: the force-executed item MUST survive a hard-kill
    //     escalation into the recovery session. Both queueState.messageQueue items and items
    //     already in queueState.pendingMidTurnQueue are covered — the latter via rescuePending
    //     ToQueue() called inside interruptCurrentResponse's close() paths.
    //   - abortPersistentSession callers (config changes, provider switch): preserve
    //     queue so the restarted session picks up pending work. The abort also
    //     rescues pending mid-turn items back into queueState.messageQueue.
    //   - resetSession / switchToSession / recoverFromStaleSession / rewindSession:
    //     explicitly call drainQueueWithCancellation (broadcasts queue:cancelled).
    //   - Subprocess crash without explicit abort: preserve queue — the safety net
    //     below reschedules pre-warm so the new session drains it.

    // 安全关闭 SDK session
    const session = lifecycleState.query as Query | null;
    setQuerySession(null);
    clearBuiltinQueryMcpOwner(session ?? undefined);
    releaseBuiltinMcpAdmissionOwner();
    configState.currentCapabilitySnapshot = null;
    try { session?.close(); } catch { /* subprocess 可能已退出 */ }

    // PRD #124: unregister the bridge token now that the SDK subprocess
    // has exited. If the session restarts, `startStreamingSession` mints
    // a fresh token (freshToken: true) so late requests from this dying
    // subprocess find their old token gone and get rejected cleanly.
    unregisterActiveSessionBridge();

    // (v0.2.14 — Codex review) Drain pending interactive requests on every
    // SDK exit shape. The per-handler `onAbort` covers the canonical
    // SDK-driven `interrupt()` path, but unexpected exits (subprocess
    // crash, transport error in `for await`, abortPersistentSession races
    // where signal.abort doesn't propagate before close) would otherwise
    // leak Map entries — `getPendingInteractiveRequests` then replays
    // ghost cards to newly connecting SSE clients. Pre-warm sessions can't
    // hold pending entries (they never serve a turn), but draining is
    // idempotent so the wasPreWarming branch is harmless.
    drainPendingInteractiveRequests('session-end');

    // Flush a synthetic terminal `stopped` for every background sub-agent that
    // started in this session but never reached terminal (still in the pending
    // map — terminal branches delete on broadcast). The owning SDK subprocess is
    // now gone (this finally runs on EVERY for-await exit: abort, deferred config
    // restart, watchdog kill, transport error), so the real terminal event can
    // never arrive — the process that would emit it just died. Without this, the
    // renderer's Agent Status Panel shows these sub-agents "后台运行中" forever
    // (all its clear-defenses require a terminal event). A late real terminal
    // after this flush is deduped renderer-side by taskId. Empty for pre-warm
    // sessions (no tasks started).
    for (const [taskId, info] of takeQueryBackgroundTasks(activeQuery)) {
      console.log(`[agent] Background task orphaned by session teardown → flushing stopped: ${taskId} — ${info.description ?? ''}`);
      broadcast('chat:task-notification', {
        sessionId,
        taskId,
        toolUseId: info.toolUseId,
        status: 'stopped',
        summary: '',
        outputFile: '',
      });
    }
    // sessionRegistered 已在 system_init handler 中设置，无需重复

    // Don't broadcast state changes from pre-warm sessions
    if (!wasPreWarming) {
      if (sessionState !== 'error') {
        setSessionState('idle');
      }
    }

    clearCronTaskContext();
    clearSessionCronContext();
    // NOTE: Do NOT clear im-media / im-bridge-tools here.
    // These are Sidecar-scoped contexts (set by Rust IM router via /api/im/chat),
    // not session-scoped. Clearing them on session end (including /new resets)
    // causes pre-warm to rebuild MCP servers without bridge tools, leaving the
    // AI with no feishu/plugin capabilities until the next IM message arrives.
    // They are cleared when the Sidecar Owner is fully released (IM Bot stops).
    resolveTermination!();

    if (wasPreWarming) {
      // sessionRegistered 不修改 — pre-warm 永不触碰此标志

      if (!preWarmStartedOk) {
        if (sdkLaunchRetryDelayMs !== undefined) {
          resetPreWarmFailCount();
          console.warn(
            `[agent] pre-warm SDK launch blocked; next application probe in ${sdkLaunchRetryDelayMs}ms`,
          );
        } else if (!lifecycleState.abortRequested || abortedByTimeout) {
          const failCount = incrementPreWarmFailCount();
          console.warn(`[agent] pre-warm failed, failCount=${failCount}${abortedByTimeout ? ' (timeout)' : ''}`);
        } else {
          console.log('[agent] pre-warm aborted by config change');
        }
      }

      if (!preWarmStartedOk || lifecycleState.abortRequested) {
        schedulePreWarm(sdkLaunchRetryDelayMs);
      }
    } else if (!lifecycleState.abortRequested && sessionRegistered) {
      // 非主动中止的意外退出（subprocess crash / error）→ 安排恢复。
      // 包含 sessionState === 'error' 的情况 — session 刚死，必须恢复，
      // 否则用户再发消息时无可用 subprocess。
      // Error 已通过 catch block 广播给前端（line 4702），用户已知出错。
      console.log(
        `[agent] Unexpected session exit, scheduling recovery pre-warm`
        + (sdkLaunchRetryDelayMs !== undefined ? ` in ${sdkLaunchRetryDelayMs}ms` : ''),
      );
      resetPreWarmFailCount(); // 新的故障上下文，重置重试计数
      schedulePreWarm(sdkLaunchRetryDelayMs);
    }

    // Safety net: detect orphaned transcriptState.messages left in queue with no session or timer to process them.
    // Race condition: enqueueUserMessage arrives between abortPersistentSession() and this finally
    // block — it cancels the pre-warm timer and steals lifecycleState.preWarming flag, causing BOTH branches
    // above to miss. Without this, transcriptState.messages sit in queue indefinitely until a window refocus
    // or other external event triggers a re-sync.
    //
    // lifecycleState.preWarmDisabled fallback: in --no-pre-warm mode (CLI flag for dev/test), schedulePreWarm
    // is a no-op, so no recovery is coming. Drain the queue explicitly so the frontend clears
    // its pills and the user knows to resend. Without this, queue preservation + disabled
    // pre-warm = orphaned-forever.
    const messageQueueLength = getMessageQueue().length;
    const turnBoundaryQueueLength = getTurnBoundaryQueue().length;
    if ((messageQueueLength > 0 || turnBoundaryQueueLength > 0) && !lifecycleState.processing && lifecycleState.query === null) {
      const hasOnlyTurnBoundaryQueue = messageQueueLength === 0 && turnBoundaryQueueLength > 0;
      if (lifecycleState.preWarmDisabled) {
        console.warn(`[agent] Safety net: ${messageQueueLength + turnBoundaryQueueLength} orphaned message(s), pre-warm disabled → draining`);
        drainQueueWithCancellation();
      } else if (hasOnlyTurnBoundaryQueue) {
        if (lifecycleState.preWarmTimer) {
          clearPreWarmTimer();
        }
        resetPreWarmFailCount();
        if (sdkLaunchRetryDelayMs !== undefined) {
          console.warn(`[agent] Safety net: ${turnBoundaryQueueLength} turn-boundary message(s), waiting for SDK launch probe`);
          schedulePreWarm(sdkLaunchRetryDelayMs);
        } else {
          console.warn(`[agent] Safety net: ${turnBoundaryQueueLength} turn-boundary message(s), starting recovery turn`);
          if (!startNextTurnQueuedItem('recovery')) {
            schedulePreWarm();
          }
        }
      } else if (!lifecycleState.preWarmTimer) {
        console.warn(`[agent] Safety net: ${messageQueueLength + turnBoundaryQueueLength} orphaned message(s) in queue, scheduling recovery`);
        resetPreWarmFailCount();
        schedulePreWarm(sdkLaunchRetryDelayMs);
      }
    }
  }
}

async function rejectPromotedMessageBeforeDispatch(
  item: MessageQueueItem,
  result: DispatchGuardResult,
): Promise<void> {
  if (getCommittingTurnAdmissionQueueId() === item.id) {
    setCommittingTurnAdmissionQueueId(null);
  }
  if (result.rollbackBeforeReject) {
    try {
      await result.rollbackBeforeReject;
    } catch (error) {
      console.error('[agent] pre-dispatch durable rollback failed:', error);
    }
  }
  releaseTurnAdmissionTicket(item.id);
  if (getInFlightQueueId() === item.id) clearInFlightSlot();
  clearPromotedItem(item.id);
  item.settleDispatchAcceptance?.({ accepted: false, error: result.error });
  await notifyQueuedTurnStopped(item, result.error ?? 'Queue item was rejected before dispatch');
  item.resolve();
  if (!item.deferVisibleAdmission) {
    broadcast('queue:cancelled', { queueId: item.id });
  }
  console.warn(`[goal] pre-dispatch gate rejected builtin queue item ${item.id}: ${result.error ?? result.code ?? 'stale admission'}`);
  if (!hasQueuedOrInFlightWork() && !isTurnInFlight()) {
    setSessionState('idle');
  }
  // A mutation may have latched a restart while this item owned promotion.
  // Rejection made the Query quiescent; successful items drain at terminal.
  applyDeferredRestartIfNeeded();
  schedulePostTerminalQueueDrain('recovery');
}

async function* messageGenerator(): AsyncGenerator<SDKUserMessage> {
  // (v0.2.12) Mid-turn injection restored.
  //
  // Yield queued transcriptState.messages immediately so the CLI subprocess receives them
  // and its mid-turn drain (claude-code/src/query.ts:1570 —
  // getCommandsByMaxPriority('next') at every tool break) can attach them
  // as queued_command attachments to the model's next API call. AI sees
  // mid-turn user input and can change direction.
  //
  // Cancel safety is handled with two layers: local pending items are
  // spliced from queueState.pendingMidTurnQueue, while the single in-flight item uses
  // SDK cancel_async_message and succeeds only before SDK dequeues it.
  // Fresh queue items stay buffered while queueState.inFlightToCliId !== null and are
  // yielded after replay, confirmed assistant-start, or successful cancel.
  //
  // Each yielded SDKUserMessage carries `uuid: item.id`, which CLI
  // surfaces as `attachment.source_uuid` in the replay event so we can
  // match the replay back to our queue item and promote the next
  // pending one.
  //
  // Exit signal: waitForMessage() returns null (via abortPersistentSession).
  console.log('[messageGenerator] Started (persistent mode, mid-turn injection enabled)');

  while (true) {
    // A domain-owned turn is not finished until its durable terminal observer
    // has settled. Keep the next queue item in the queue until that boundary.
    await waitForCurrentTurnTerminalObserver();
    // 等待队列中的消息（事件驱动，无轮询）
    const item = await waitForMessage();
    if (!item) {
      console.log('[messageGenerator] Received null — exiting (abort or session end)');
      return; // generator return → SDK endInput() → stdin EOF → subprocess 退出
    }
    beginPromotedItem(item);
    const promotedQuery = lifecycleState.query;
    let desiredCapabilities: EffectiveProjectCapabilitySnapshot;
    try {
      const globalSkillInventory = createGlobalSkillInventorySnapshot();
      desiredCapabilities = resolveEffectiveProjectCapabilities(agentDir, { globalSkillInventory });
      const currentCapabilities = configState.currentCapabilitySnapshot;
      let projectionChanged = false;
      if (
        currentCapabilities
        && (currentCapabilities.revision !== desiredCapabilities.revision
          || currentCapabilities.integrityRevision !== desiredCapabilities.integrityRevision)
      ) {
        projectionChanged = trySyncProjectUserConfigFiles(agentDir, {
          globalSkillInventory,
          capabilitySnapshot: desiredCapabilities,
        }, 'skill-sync').changed;
        if (currentCapabilities.revision === desiredCapabilities.revision && !projectionChanged) {
          configState.currentCapabilitySnapshot = desiredCapabilities;
        }
      }
      if (projectionChanged) {
        requeuePromotedItemBeforeSdkDispatch(item);
        scheduleDeferredRestart('capabilities');
        applyDeferredRestartIfNeeded();
        if (promotedQuery) await waitForQueryExit(promotedQuery);
        return;
      }
    } catch (error) {
      await rejectPromotedMessageBeforeDispatch(item, {
        accepted: false,
        error: `Workspace capabilities are unavailable: ${error instanceof Error ? error.message : String(error)}`,
        rollbackBeforeReject: Promise.resolve(item.beforeDispatch?.cancel?.()),
      });
      continue;
    }
    const disabledCapability = findDisabledCapabilityForSlashInput(item.messageText, desiredCapabilities);
    if (disabledCapability) {
      await rejectPromotedMessageBeforeDispatch(item, {
        accepted: false,
        error: `/${disabledCapability.canonicalName} is disabled for this workspace`,
        rollbackBeforeReject: Promise.resolve(item.beforeDispatch?.cancel?.()),
      });
      continue;
    }
    if (configState.currentCapabilitySnapshot?.revision !== desiredCapabilities.revision) {
      // Files/config may change after enqueue but before promotion. Return the
      // exact item to the local queue and replace the Query before it crosses
      // the SDK boundary; the replacement generator will retry it.
      requeuePromotedItemBeforeSdkDispatch(item);
      scheduleDeferredRestart('capabilities');
      applyDeferredRestartIfNeeded();
      if (promotedQuery) await waitForQueryExit(promotedQuery);
      return;
    }
    const activeMcpMutation = getQueryMcpMutation();
    if (activeMcpMutation) {
      const cancellation = getPromotedItemCancellation(item.id);
      const mutationOutcome = await Promise.race([
        activeMcpMutation.promise.then(result => ({ kind: 'mutation' as const, result })),
        ...(cancellation
          ? [cancellation.then(() => ({ kind: 'cancelled' as const }))]
          : []),
      ]);
      if (mutationOutcome.kind === 'cancelled') {
        await rejectPromotedMessageBeforeDispatch(item, {
          accepted: false,
          code: 'dispatch_canceled',
          error: 'Queue item was cancelled',
          rollbackBeforeReject: Promise.resolve(item.beforeDispatch?.cancel?.()),
        });
        continue;
      }
      if (!mutationOutcome.result.ok) {
        // The SDK transport map is indeterminate. Keep the exact user item
        // locally owned, rebuild the Query, and let the replacement generator
        // retry it. Never dispatch onto the timed-out/failed transport owner.
        // Realtime enqueue may have provisionally reserved the single SDK
        // in-flight slot before generator yield. The mutation fence rejected
        // before that process boundary, so release the provisional slot now;
        // otherwise restart quiescence waits forever for a replay that the SDK
        // can never emit.
        requeuePromotedItemBeforeSdkDispatch(item);
        console.warn(`[agent] Requeued ${item.id} after MCP mutation ${mutationOutcome.result.reason}: ${mutationOutcome.result.error}`);
        if (mutationOutcome.result.reason !== 'query_replaced') {
          scheduleDeferredRestart('mcp');
          applyDeferredRestartIfNeeded();
          // The restart can remain deferred while an older queued command is
          // still owned by the SDK. Do not loop back into waitForMessage here:
          // the mutation owner has already settled, so this generator would
          // otherwise dequeue the requeued item (or any ordinary message) and
          // dispatch it on the stale transport map. Only Query abort/replacement
          // releases this generation; the replacement generator retries it.
          if (promotedQuery) await waitForQueryExit(promotedQuery);
        } else {
          schedulePreWarm();
        }
        // This generator belongs to the indeterminate/replaced Query. It must
        // never dequeue again; the replacement generator owns the retry.
        return;
      }
    }
    if (isPromotedItemCanceled(item.id)) {
      await rejectPromotedMessageBeforeDispatch(item, {
        accepted: false,
        code: 'dispatch_canceled',
        error: 'Queue item was cancelled',
        rollbackBeforeReject: Promise.resolve(item.beforeDispatch?.cancel?.()),
      });
      continue;
    }

    // Every builtin entrypoint converges here. Consume only the remaining
    // absolute grace owned by this Query/map generation; ready and degraded
    // outcomes are both dispatchable and become a one-shot fast path.
    const prewarmController = new AbortController();
    const promotionCancellation = getPromotedItemCancellation(item.id);
    let prewarmObservation:
      | { kind: 'outcome'; outcome: McpPrewarmOutcome | null }
      | { kind: 'cancelled' };
    try {
      const observation = observeCurrentQueryMcpPrewarm({ signal: prewarmController.signal })
        .then(outcome => ({ kind: 'outcome' as const, outcome }));
      prewarmObservation = promotionCancellation
        ? await Promise.race([
          observation,
          promotionCancellation.then(() => {
            prewarmController.abort();
            return { kind: 'cancelled' as const };
          }),
        ])
        : await observation;
    } catch (error) {
      if (isPromotedItemCanceled(item.id)) {
        prewarmObservation = { kind: 'cancelled' };
      } else {
        // A control-plane observer must never become an AI-turn failure.
        console.warn('[agent] MCP pre-warm observation degraded:', error instanceof Error ? error.message : error);
        prewarmObservation = { kind: 'outcome', outcome: null };
      }
    }
    if (prewarmObservation.kind === 'cancelled') {
      await rejectPromotedMessageBeforeDispatch(item, {
        accepted: false,
        code: 'dispatch_canceled',
        error: 'Queue item was cancelled',
        rollbackBeforeReject: Promise.resolve(item.beforeDispatch?.cancel?.()),
      });
      continue;
    }
    if (prewarmObservation.outcome?.state === 'owner_replaced') {
      requeuePromotedItemBeforeSdkDispatch(item);
      console.log(`[agent] Requeued ${item.id}: MCP pre-warm owner was replaced before SDK dispatch`);
      return;
    }

    let guardResult: DispatchGuardResult | undefined;
    if (item.beforeDispatch) {
      try {
        guardResult = await item.beforeDispatch();
      } catch (error) {
        guardResult = {
          accepted: false,
          error: error instanceof Error ? error.message : String(error),
        };
      }
      if (!guardResult.accepted) {
        await rejectPromotedMessageBeforeDispatch(item, guardResult);
        continue;
      }
      if (isPromotedItemCanceled(item.id)) {
        await rejectPromotedMessageBeforeDispatch(item, {
          accepted: false,
          code: 'dispatch_canceled',
          error: 'Queue item was cancelled',
          rollbackBeforeReject: Promise.resolve(item.beforeDispatch?.cancel?.()),
        });
        continue;
      }
    }
    const turnOrigin = item.analyticsOrigin ?? originFromTurnAttribution({
      source: item.analyticsSource,
      scenarioType: currentScenario.type,
      desktopSurface: currentScenario.type === 'desktop' ? currentScenario.surface : undefined,
      inboxMeta: item.inboxMeta,
    });
    const deferredSystemInit = lifecycleState.preWarming
      ? lifecycleState.systemInitInfo
      : null;

    // Finish every asynchronous setup step while the item is still
    // cancellable. The prepared-session claim below is the final awaited
    // transition; after it wins, ownership transfers synchronously to the
    // active turn with no cancellation seam in between.
    try {
      if (!item.wasQueued) {
        await prepareSessionPlansForUserTurn({ clearStale: true });
      }
      if (deferredSystemInit) {
        await ensureSessionMetadataForSdkSystemInit(
          deferredSystemInit,
          getSystemInitAuthority(),
        );
        sessionRegistered = true;
      }
      if (item.deferredSessionMetadata) {
        await persistSessionMetadataForAdmittedMessage(
          item.messageText,
          item.deferredSessionMetadata,
        );
        item.deferredSessionMetadata = undefined;
      }
    } catch (error) {
      const admissionError = error instanceof Error ? error.message : String(error);
      console.error('[agent] turn setup failed before admission:', error);
      await rejectPromotedMessageBeforeDispatch(item, {
        accepted: false,
        error: admissionError,
        rollbackBeforeReject: Promise.resolve(item.beforeDispatch?.cancel?.()),
      });
      continue;
    }

    if (isPromotedItemCanceled(item.id)) {
      await rejectPromotedMessageBeforeDispatch(item, {
        accepted: false,
        code: 'dispatch_canceled',
        error: 'Queue item was cancelled',
        rollbackBeforeReject: Promise.resolve(item.beforeDispatch?.cancel?.()),
      });
      continue;
    }
    if (guardResult?.validateAtCommit) {
      let commitResult: DispatchGuardResult;
      try {
        commitResult = guardResult.validateAtCommit();
      } catch (error) {
        commitResult = {
          accepted: false,
          error: error instanceof Error ? error.message : String(error),
        };
      }
      if (!commitResult.accepted) {
        await rejectPromotedMessageBeforeDispatch(item, commitResult);
        continue;
      }
    }

    setCommittingTurnAdmissionQueueId(item.id);
    if (!await claimPreparedMaterializationForTurnAdmission(item.messageText, item.sessionBirthOrigin)) {
      setCommittingTurnAdmissionQueueId(null);
      await rejectPromotedMessageBeforeDispatch(item, {
        accepted: false,
        code: 'dispatch_canceled',
        error: 'Session materialization was rolled back before turn admission.',
      });
      continue;
    }

    // Direct-send items (wasQueued=false): enqueueUserMessage already surfaced
    // the ordinary user message; guarded items were surfaced once immediately
    // after the accepted gate above. Generator MUST NOT push again — doing so allocates
    // a second `transcriptState.messageSequence++` id and writes a second SessionStore entry
    // (issue #173). Generator's job here is purely turn-scoped state setup so
    // the upcoming yield's response is properly tracked.
    //
    // queue:started is intentionally NOT broadcast for direct-send: the
    // message never went through the queue UI from the user's perspective,
    // and the chat bubble is already visible from chat:message-replay. Re-
    // broadcasting would cause the frontend's seenIdsRef dedup to fail when
    // generator's local id differs from the one already in history.
    //
    // wasQueued=true items take a different path: their transcriptState.messages[] push +
    // queue:started broadcast happens later in handleQueuedCommandReplay()
    // or when the next assistant turn starts, proving a boundary drain. Until
    // then they live as an "in-flight" pill in the frontend queue panel.
    let traceTurnId = item.id;
    const traceSource = item.wasQueued ? 'queued' : 'direct';
    if (!item.wasQueued) {
      resetTurnUsage();
      setCurrentTurnStartTime(Date.now());
      if (sessionId) beginTurnAbort(sessionId);
      const turnId = randomUUID().replace(/-/g, '').slice(0, 8);
      traceTurnId = turnId;
      setAmbientLogContext(sessionId, { turnId, sessionId });
    } else if (getInFlightQueueId() === null) {
      // (v0.2.12 Codex review fix #1) wasQueued item arrived without an
      // existing in-flight tracker. Two paths reach here:
      //   - Recovery: finally-block rescue moved a queueState.pendingMidTurnQueue item
      //     into queueState.messageQueue front; the new generator pulls it but
      //     enqueueUserMessage's lockstep tracker (queueState.inFlightToCliId) was
      //     reset on the prior session's exit.
      //   - Direct push to queueState.messageQueue with wasQueued=true (defensive —
      //     no current call site does this, but the type allows it).
      // Either way we must register this item as in-flight so the
      // SDKUserMessageReplay handler can match it back, and the UI can
      // be eventually resolved via replay, assistant-start confirmation, or
      // SDK async-message cancellation.
      setInFlightQueueItem(item.id, {
        messageText: item.messageText,
        attachments: item.attachments,
        requestId: item.requestId,
        analyticsSource: item.analyticsSource,
        analyticsOrigin: item.analyticsOrigin,
        channelDelivery: item.channelDelivery,
      });
      // Re-emit queue:added with isInFlight=true so the frontend pill's
      // UI marks it as handed to SDK; cancellation now goes through
      // cancel_async_message while it remains pending in SDK commandQueue.
      broadcast('queue:added', {
        queueId: item.id,
        messageText: item.messageText.slice(0, 100),
        isInFlight: true,
        deliveryMode: item.deliveryMode,
      });
      console.log(`[messageGenerator] Recovery path: wasQueued item ${item.id} adopted as in-flight (rescue or queueState.messageQueue push)`);
    }
    beginBuiltinTurnTrace(traceSource, traceTurnId, item.requestId);
    setCurrentTurnAnalyticsSource(item.analyticsSource ?? currentScenario.type);
    setCurrentTurnAnalyticsOrigin(turnOrigin);
    setCurrentTurnProviderAnalytics(item.providerAnalytics ?? buildTurnProviderAnalytics(configState.currentProviderEnv));
    setAssistantMessagePresent(false);
    setCurrentTurnSourceItem(item);

    // Irreversible admission commit. The final lease/domain validation above
    // and this owner transfer are one synchronous event-loop transaction: no
    // MCP mutation or cancellation can interleave. From here the item is an
    // accepted active turn (even while its metadata is being persisted), so a
    // caller deadline/cancel must report and stop that exact active owner
    // rather than claiming the turn was never enqueued.
    clearPromotedItem(item.id);
    isStreamingMessage = true;
    if (lifecycleState.preWarming) {
      setPreWarmInProgress(false);
      if (lifecycleState.preWarmTimer) {
        clearTimeout(lifecycleState.preWarmTimer);
        setPreWarmTimer(null);
      }
    }
    releaseTurnAdmissionTicket(item.id);
    if (item.deferVisibleAdmission) {
      setSessionState((lifecycleState.systemInitInfo || lifecycleState.sdkControlReady) ? 'running' : 'starting');
      item.deferVisibleAdmission = false;
    }
    item.settleDispatchAcceptance?.({ accepted: true });
    setCommittingTurnAdmissionQueueId(null);

    if (deferredSystemInit) {
      broadcast('chat:system-init', { info: deferredSystemInit, sessionId, runtime: 'builtin' });
      console.log(`[agent] pre-warm → active (at admission), sessionRegistered=${sessionRegistered}`);
    }
    if (
      lifecycleState.abortRequested
      || isInterruptingResponse
      || !isStreamingMessage
      || getCurrentTurnSourceItem() !== item
    ) {
      item.resolve();
      return;
    }

    const activityFacts: SessionActivityTurnFacts = {
      origin: turnOrigin,
      inputText: item.messageText,
      systemMaintenanceKind: getSessionMetadata(sessionId)?.systemMaintenanceKind,
    };
    item.activityFacts = activityFacts;
    const admissionActivityAt = shouldRecordAdmissionActivity(activityFacts)
      ? new Date().toISOString()
      : undefined;
    let admissionActivityMerged = false;
    if (item.deferredUserSurface) {
      try {
        admissionActivityMerged = await surfaceBuiltinUserMessage(
          item.deferredUserSurface,
          'admission',
          admissionActivityAt,
        );
      } catch (error) {
        const failedSurface = item.deferredUserSurface;
        item.deferredUserSurface = undefined;
        await rollbackFailedBuiltinUserSurface(failedSurface.message.id);
        if (
          lifecycleState.abortRequested
          || isInterruptingResponse
          || !isStreamingMessage
          || getCurrentTurnSourceItem() !== item
        ) {
          item.resolve();
          return;
        }
        const admissionError = reportBuiltinAdmissionPersistenceFailure(
          item.id,
          item.requestId,
          error,
        );
        const terminalError = `Failed to persist user message before runtime dispatch: ${admissionError}`;
        if (!item.requestId || imRequestRegistry.get(item.requestId)) {
          finalizeImRequest(
            item.requestId,
            'error',
            'failed',
            buildImErrorPayload(terminalError),
            true,
          );
        }
        builtinTurnLifecycle.failAdmittedTurnSetup(terminalError);
        item.resolve();
        continue;
      }
      item.deferredUserSurface = undefined;
    } else if (getSessionMetadata(sessionId)?.materializationState === 'prepared') {
      const visibleText = resolveVisibleUserTurnText(item.messageText)?.trim();
      try {
        await commitPreparedSessionAfterUserMessagePersist(
          item.messageText,
          item.sessionBirthOrigin,
          admissionActivityAt,
          visibleText ? visibleText.slice(0, 60) : undefined,
        );
      } catch (error) {
        console.warn('[agent] prepared metadata commit at admission failed:', error);
      }
      admissionActivityMerged = admissionActivityAt !== undefined;
    }
    if (admissionActivityAt && !admissionActivityMerged) {
      try {
        await persistMessagesToStorage(transcriptState.messages.length, admissionActivityAt);
      } catch (error) {
        console.error('[agent] admission activity metadata update failed:', error);
      }
    }
    if (
      lifecycleState.abortRequested
      || isInterruptingResponse
      || !isStreamingMessage
      || getCurrentTurnSourceItem() !== item
    ) {
      item.resolve();
      return;
    }

    // Pattern B+G: every logical SDK yield gets one output-owner FIFO slot.
    // A transient provider-text retry re-yields the same logical turn and
    // therefore reuses the owner retained when the retry was selected.
    pushPendingOutputOwner(item);

    // PRD 0.2.18 Session Inbox — per-turn binding (read at result handler /
    // abort path). Bound here at generator yield (NOT at enqueue), so the
    // mutable always reflects the turn that's actually about to execute.
    // Cleared at result handler / abort path; if a subsequent yield happens
    // before clear, the new binding overwrites — that's correct because SDK
    // persistent session yields one turn at a time.
    setCurrentTurnInboxMeta(item.inboxMeta);
    const currentTurnInboxMeta = getCurrentTurnInboxMeta();
    if (currentTurnInboxMeta) {
      console.log(
        `[inbox] Bound turn inboxMeta from=${currentTurnInboxMeta.fromSessionId} replyBack=${currentTurnInboxMeta.replyBack} msgId=${currentTurnInboxMeta.originalMessageId}`,
      );
    }

    // Modality re-check at dequeue (see prior comment in pre-fix file).
    const yieldedMessage = stripUnsupportedModalityBlocks(item.message, configState.currentModel);

    console.log(`[messageGenerator] Yielding message, wasQueued=${item.wasQueued}, queueId=${item.id}, requestId=${item.requestId ?? '-'} summary=${JSON.stringify(summarizeSensitiveSdkMessage({ type: 'user', message: yieldedMessage }))}`);
    yield {
      type: 'user' as const,
      message: yieldedMessage,
      parent_tool_use_id: null,
      session_id: getSessionId(),
      // (v0.2.12) Stamp the queue item id as the SDK message uuid. CLI
      // forwards this through to attachment.source_uuid in queued_command
      // replay events, so handleQueuedCommandReplay can match the replay
      // back to our pending state and promote the next item.
      uuid: item.id as `${string}-${string}-${string}-${string}-${string}`,
    };
    item.resolve();
    clearPromotedItem(item.id);
  }
}

import { assertSessionTranscriptsDurableForUpdate } from '../SessionStore';
import { isUpdaterQaBuild } from '../../shared/updaterQa';
import {
  interruptCurrentResponse,
  hasBuiltinActivityForUpdate,
  setUpdateRestartFrozen,
} from "../agent-session";
import {
  getActiveRuntimeSource,
  getActiveRuntimeType,
  hasPendingExternalAskUserQuestion,
  hasPendingExternalPlanApproval,
  isExternalSessionActive,
  popLastUserMessageForRetry,
  retryLastExternalUserMessage,
  prewarmExternalSession,
  restoreExternalSessionState,
  shouldUseExternalRuntime,
  updateExternalRuntimeConfig,
} from "../runtimes/external-session";
import { prepareDesktopQuery } from "./query-reminder";
import { createBuiltinSessionEngine } from "./builtin-adapter";
import { createExternalSessionEngine } from "./external-adapter";
import { createDshSessionEngine } from "../integrated-runtimes/dsh/adapter";
import { getCurrentRuntimeType, isDshRuntime } from "../runtimes/factory";
import type { ExternalRuntimeConfigPatch } from "../runtimes/types";
import type {
  ExternalConfigSource,
  ExternalConfigUpdateResult,
} from "../runtimes/external-session";
import { isPermissionModeForRuntimeIdentity } from "../../shared/providerExecution";
import type {
  CapabilityOperationResult,
  SessionEngine,
  SessionEngineKind,
} from "./types";
import type { TurnOwner } from "../session-core/turn-queue";
import { managementApi } from "../utils/management-api-client";
import { cancelTaskSessionBirth } from "./task-session-birth";

// This is the existing process-local SessionEngine admission owner. The
// updater closes it synchronously with its adapter observation, so a prompt
// cannot race an idle read while an earlier admission is still awaiting IO.
let updateRestartToken: string | null = null;
let activeUpdateAdmissions = 0;

async function withUpdateAdmission<T>(operation: () => Promise<T>): Promise<T> {
  if (updateRestartToken !== null) throw new Error("UPDATE_BUSY");
  activeUpdateAdmissions += 1;
  try {
    return await operation();
  } finally {
    activeUpdateAdmissions -= 1;
  }
}

async function withExecutionAdmission<T>(operation: () => Promise<T>): Promise<T> {
  if (isUpdaterQaBuild()) throw new Error('UPDATER_QA_EXECUTION_DISABLED');
  return withUpdateAdmission(operation);
}

function queryFacade(engine: SessionEngine): SessionEngine {
  return {
    ...engine,
    sendDesktopMessage: (request) =>
      withExecutionAdmission(async () => {
        const prepared = await prepareDesktopQuery(request);
        const result = await engine.sendDesktopMessage(prepared.request);
        return {
          ...result,
          ...(prepared.needsReselect
            ? { agentMentionsNeedReselect: true }
            : {}),
        };
      }),
    enqueueImMessage: (request) =>
      withExecutionAdmission(() => engine.enqueueImMessage(request)),
    enqueueBackgroundMessage: (request) =>
      withExecutionAdmission(() => engine.enqueueBackgroundMessage(request)),
    enqueueInboxMessage: (request) =>
      withExecutionAdmission(() => engine.enqueueInboxMessage(request)),
    prepareScheduledTurn: (request) =>
      withExecutionAdmission(() => engine.prepareScheduledTurn(request)),
    runInjectedTurn: (request) =>
      withExecutionAdmission(() => engine.runInjectedTurn(request)),
    compactContext: () => withExecutionAdmission(() => engine.compactContext()),
    retryUserMessage: (id, options) =>
      withExecutionAdmission(() => engine.retryUserMessage(id, options)),
    forceQueuedMessage: (id) =>
      withExecutionAdmission(() => engine.forceQueuedMessage(id)),
    retryMcpServer: (id) =>
      withUpdateAdmission(() => engine.retryMcpServer(id)),
    applyModelSelection: (input) =>
      withUpdateAdmission(() => engine.applyModelSelection(input)),
    updateModel: (model, options) =>
      withUpdateAdmission(() => engine.updateModel(model, options)),
    updatePermissionMode: (mode) =>
      withUpdateAdmission(() => engine.updatePermissionMode(mode)),
    updateReasoningEffort: (effort) =>
      withUpdateAdmission(() => engine.updateReasoningEffort(effort)),
    updateProviderEnv: (env) =>
      withUpdateAdmission(() => engine.updateProviderEnv(env)),
    updateMcpServers: (servers) =>
      withUpdateAdmission(() => engine.updateMcpServers(servers)),
    updateAgents: (agents, options) =>
      withUpdateAdmission(() => engine.updateAgents(agents, options)),
    updateEnabledPluginIds: (ids) =>
      withUpdateAdmission(() => engine.updateEnabledPluginIds(ids)),
    resetForNewDesktopSession: (path) =>
      withUpdateAdmission(() => engine.resetForNewDesktopSession(path)),
    materializePendingDesktopSession: (request) =>
      withUpdateAdmission(() =>
        engine.materializePendingDesktopSession(request),
      ),
    migrateBoundSurfaceSession: (path, options) =>
      withUpdateAdmission(() =>
        engine.migrateBoundSurfaceSession(path, options),
      ),
    cancelImRequest: (...args: Parameters<SessionEngine["cancelImRequest"]>) =>
      withUpdateAdmission(() => engine.cancelImRequest(...args)),
    stopTurn: (...args: Parameters<SessionEngine["stopTurn"]>) =>
      withUpdateAdmission(() => engine.stopTurn(...args)),
    stopOwnedTurn: (...args: Parameters<SessionEngine["stopOwnedTurn"]>) =>
      withUpdateAdmission(() => engine.stopOwnedTurn(...args)),
    cancelQueuedMessage: (
      ...args: Parameters<SessionEngine["cancelQueuedMessage"]>
    ) => withUpdateAdmission(() => engine.cancelQueuedMessage(...args)),
    updateOfficialToolIds: (
      ...args: Parameters<SessionEngine["updateOfficialToolIds"]>
    ) => withUpdateAdmission(() => engine.updateOfficialToolIds(...args)),
    updateProxyConfig: (
      ...args: Parameters<SessionEngine["updateProxyConfig"]>
    ) => withUpdateAdmission(() => engine.updateProxyConfig(...args)),
    updateDesktopInteractionScenario: (
      ...args: Parameters<SessionEngine["updateDesktopInteractionScenario"]>
    ) =>
      withUpdateAdmission(() =>
        engine.updateDesktopInteractionScenario(...args),
      ),
    respondPermission: (
      ...args: Parameters<SessionEngine["respondPermission"]>
    ) => withUpdateAdmission(() => engine.respondPermission(...args)),
    respondAskUserQuestion: (
      ...args: Parameters<SessionEngine["respondAskUserQuestion"]>
    ) => withUpdateAdmission(() => engine.respondAskUserQuestion(...args)),
    respondPlanApproval: (
      ...args: Parameters<SessionEngine["respondPlanApproval"]>
    ) => withUpdateAdmission(() => engine.respondPlanApproval(...args)),
    rewindToUserMessage: (
      ...args: Parameters<SessionEngine["rewindToUserMessage"]>
    ) => withUpdateAdmission(() => engine.rewindToUserMessage(...args)),
    forkAtAssistantMessage: (
      ...args: Parameters<SessionEngine["forkAtAssistantMessage"]>
    ) => withUpdateAdmission(() => engine.forkAtAssistantMessage(...args)),
    ensureRegisteredAgentSessionOrigin: (
      ...args: Parameters<SessionEngine["ensureRegisteredAgentSessionOrigin"]>
    ) =>
      withUpdateAdmission(() =>
        engine.ensureRegisteredAgentSessionOrigin(...args),
      ),
    freezeCurrentSessionForImDetach: (
      ...args: Parameters<SessionEngine["freezeCurrentSessionForImDetach"]>
    ) =>
      withUpdateAdmission(() =>
        engine.freezeCurrentSessionForImDetach(...args),
      ),
    ...(engine.addPermissionRule
      ? {
          addPermissionRule: (
            ...args: Parameters<NonNullable<SessionEngine["addPermissionRule"]>>
          ) => withUpdateAdmission(() => engine.addPermissionRule!(...args)),
        }
      : {}),
    ...(engine.revokePermissionRule
      ? {
          revokePermissionRule: (
            ...args: Parameters<
              NonNullable<SessionEngine["revokePermissionRule"]>
            >
          ) => withUpdateAdmission(() => engine.revokePermissionRule!(...args)),
        }
      : {}),
    ...(engine.controlAgentWork
      ? {
          controlAgentWork: (
            input: Parameters<
              NonNullable<SessionEngine["controlAgentWork"]>
            >[0],
          ) => withUpdateAdmission(() => engine.controlAgentWork!(input)),
        }
      : {}),
  };
}
const builtinEngine = queryFacade(createBuiltinSessionEngine());
const dshEngine = queryFacade(createDshSessionEngine());
const externalEngine = queryFacade(createExternalSessionEngine());

function selectedNonBuiltinEngine(): SessionEngine {
  return isDshRuntime(getCurrentRuntimeType()) ? dshEngine : externalEngine;
}

const EXTERNAL_CONFIG_SOURCES = new Set<ExternalConfigSource>([
  "runtime-config",
  "message-snapshot",
  "desktop",
  "im-sync",
  "cron-sync",
  "adopt-sync",
]);

function parseExternalConfigSource(value: unknown): ExternalConfigSource {
  return typeof value === "string" &&
    EXTERNAL_CONFIG_SOURCES.has(value as ExternalConfigSource)
    ? (value as ExternalConfigSource)
    : "runtime-config";
}

type ExternalRuntimeConfigBody = {
  model?: string | null;
  permissionMode?: unknown;
  reasoningEffort?: string | null;
};

export const updateExternalRuntimeConfigAtSelector: typeof updateExternalRuntimeConfigAtSelectorOwner =
  (...args) =>
    withUpdateAdmission(() =>
      updateExternalRuntimeConfigAtSelectorOwner(...args),
    );

async function updateExternalRuntimeConfigAtSelectorOwner(request: {
  runtime?: unknown;
  runtimeConfig: ExternalRuntimeConfigBody;
  source?: unknown;
}): Promise<{
  httpStatus: number;
  body: ExternalConfigUpdateResult | { success: false; error: string };
}> {
  if (!shouldUseExternalRuntime()) {
    return {
      httpStatus: 400,
      body: {
        success: false,
        error: "Runtime config endpoint is only for external runtimes",
      },
    };
  }

  const activeRuntime = getActiveRuntimeType();
  if (request.runtime && request.runtime !== activeRuntime) {
    return {
      httpStatus: 400,
      body: {
        success: false,
        error: `Runtime mismatch: sidecar=${activeRuntime}, payload=${request.runtime}`,
      },
    };
  }

  const requestedPermissionMode = request.runtimeConfig.permissionMode;
  if (
    requestedPermissionMode !== undefined &&
    requestedPermissionMode !== null &&
    typeof requestedPermissionMode !== "string"
  ) {
    return {
      httpStatus: 400,
      body: {
        success: false,
        error: "permissionMode must be a string or null",
      },
    };
  }
  if (
    typeof requestedPermissionMode === "string" &&
    requestedPermissionMode.trim()
  ) {
    const runtimeSource = getActiveRuntimeSource();
    if (
      !isPermissionModeForRuntimeIdentity(
        requestedPermissionMode,
        activeRuntime,
        runtimeSource,
      )
    ) {
      return {
        httpStatus: 400,
        body: {
          success: false,
          error: `Invalid permissionMode '${requestedPermissionMode}' for ${runtimeSource ?? activeRuntime}`,
        },
      };
    }
  }

  const patch: ExternalRuntimeConfigPatch = {
    ...("model" in request.runtimeConfig
      ? { model: request.runtimeConfig.model ?? "" }
      : {}),
    ...("permissionMode" in request.runtimeConfig
      ? {
          permissionMode:
            (request.runtimeConfig.permissionMode as string | null) ?? "",
        }
      : {}),
    ...("reasoningEffort" in request.runtimeConfig
      ? { reasoningEffort: request.runtimeConfig.reasoningEffort ?? "" }
      : {}),
  };
  const result = await updateExternalRuntimeConfig(patch, {
    source: parseExternalConfigSource(request.source),
  });
  return { httpStatus: result.success ? 200 : 500, body: result };
}

export const prewarmExternalRuntimeAtSelector: typeof prewarmExternalRuntimeAtSelectorOwner =
  (...args) =>
    withExecutionAdmission(() => prewarmExternalRuntimeAtSelectorOwner(...args));

async function prewarmExternalRuntimeAtSelectorOwner(options: {
  sessionId: string;
  workspacePath: string;
  model?: string;
}): Promise<{ httpStatus: number; body: Record<string, unknown> }> {
  if (!shouldUseExternalRuntime()) {
    return {
      httpStatus: 400,
      body: { success: false, error: "Pre-warm is only for external runtimes" },
    };
  }
  if (!options.sessionId) {
    return {
      httpStatus: 400,
      body: { success: false, error: "No sessionId available" },
    };
  }
  const result = await prewarmExternalSession({
    sessionId: options.sessionId,
    workspacePath: options.workspacePath,
    scenario: { type: "desktop" },
    model: options.model,
  });
  return { httpStatus: 200, body: { success: true, ...result } };
}

export const restoreInitialExternalSessionAtSelector: typeof restoreInitialExternalSessionAtSelectorOwner =
  (...args) =>
    withUpdateAdmission(() =>
      restoreInitialExternalSessionAtSelectorOwner(...args),
    );

async function restoreInitialExternalSessionAtSelectorOwner(
  sessionId: string,
  workspacePath: string,
): Promise<boolean> {
  if (!shouldUseExternalRuntime()) return false;
  if (isUpdaterQaBuild()) throw new Error('UPDATER_QA_EXECUTION_DISABLED');
  const restored = await restoreExternalSessionState(sessionId, workspacePath, {
    type: "desktop",
  });
  if (!restored.success)
    throw new Error(restored.error ?? "External Session restore failed");
  return true;
}

export const retryLastExternalUserMessageAtSelector: typeof retryLastExternalUserMessageAtSelectorOwner =
  (...args) =>
    withExecutionAdmission(() =>
      retryLastExternalUserMessageAtSelectorOwner(...args),
    );

function retryLastExternalUserMessageAtSelectorOwner(
  userMessageId: string,
): Promise<CapabilityOperationResult> {
  if (!shouldUseExternalRuntime()) {
    return Promise.resolve({
      success: false,
      status: 400,
      error:
        "external-retry is only for external runtimes; builtin uses /chat/rewind",
    });
  }
  return getCurrentRuntimeType() === "dsh"
    ? retryLastExternalUserMessage(userMessageId)
    : popLastUserMessageForRetry(userMessageId);
}

export function getSessionEngine(): SessionEngine {
  return shouldUseExternalRuntime()
    ? selectedNonBuiltinEngine()
    : builtinEngine;
}

/** Called only by Rust's authenticated exact-generation lifecycle endpoint.
 * Never waits for or stops work. Rejection preserves every existing owner. */
export async function freezeSessionAdmissionsForUpdate(
  token: string,
): Promise<void> {
  if (updateRestartToken !== null && updateRestartToken !== token)
    throw new Error("UPDATE_BUSY");
  if (activeUpdateAdmissions > 0) throw new Error("UPDATE_BUSY");
  try {
    updateRestartToken = token;
    assertSessionTranscriptsDurableForUpdate();
    setUpdateRestartFrozen(true);
    const engine = getSessionEngine();
    const live = engine.getLiveSessionState();
    if (
      engine.isBusy() ||
      live.isBusy ||
      live.waitingForUser ||
      live.sessionState === "running" ||
      live.sessionState === "starting" ||
      engine.getQueueStatus().length > 0 ||
      engine.getStreamReplaySnapshot().pendingInteractiveRequests.length > 0 ||
      hasBuiltinActivityForUpdate()
    )
      throw new Error("UPDATE_BUSY");
    updateRestartToken = token;
    // DSH child handles can continue after the root turn is idle. Read their
    // native owner while admission is closed, rather than trusting root/UI idle.
    if (engine.getRuntimeIdentity().runtime === "dsh") {
      if (!engine.listAgentWork) throw new Error("UPDATE_ACTIVITY_UNKNOWN");
      const work = await engine.listAgentWork();
      if (
        work.items.some(
          (item) =>
            item.status === "running" ||
            item.native?.activity === "running" ||
            (item.activation &&
              [
                "queued",
                "running",
                "waiting_interaction",
                "waiting_child",
                "waiting_delivery",
              ].includes(item.activation.state)),
        )
      ) {
        throw new Error("UPDATE_BUSY");
      }
    }

    if (updateRestartToken !== token)
      throw new Error("UPDATE_ACTIVITY_UNKNOWN");
    assertSessionTranscriptsDurableForUpdate();
  } catch (error) {
    if (updateRestartToken === token) {
      updateRestartToken = null;
      setUpdateRestartFrozen(false);
    }
    if (error instanceof Error && error.message === "UPDATE_BUSY") throw error;
    throw new Error("UPDATE_ACTIVITY_UNKNOWN");
  }
}

export function releaseSessionAdmissionsForUpdate(token: string): void {
  // Late cleanup cannot reopen a newer install's admission lease.
  if (updateRestartToken === token) {
    updateRestartToken = null;
    setUpdateRestartFrozen(false);
  }
}

export function getSessionEngineKind(): SessionEngineKind {
  return shouldUseExternalRuntime()
    ? selectedNonBuiltinEngine().kind
    : "builtin";
}

export function getSessionRuntimeType(): ReturnType<
  typeof getActiveRuntimeType
> {
  return getActiveRuntimeType();
}

/**
 * Historical stop behavior: when a legacy external runtime is selected but
 * no external session is active yet, /chat/stop falls back to the builtin
 * interrupt path. DSH Sessions never cross that ownership boundary.
 */
export async function stopActiveTurn(): Promise<{
  success: boolean;
  alreadyStopped?: boolean;
  error?: string;
}> {
  const engine = getSessionEngine();
  const turn = engine.getCurrentTurnIdentity();
  if (turn?.owner.kind === "goal") {
    const context = engine.getCurrentSessionContext();
    if (!context.sessionId || !context.workspacePath) {
      return {
        success: false,
        error: "Active Goal turn has no Session context",
      };
    }
    const paused = await managementApi("/api/goal/turn/pause", "POST", {
      sessionId: context.sessionId,
      workspacePath: context.workspacePath,
      goalId: turn.owner.id,
      queueId: turn.queueId,
    });
    if (paused.ok !== true) {
      return {
        success: false,
        error: String(paused.error ?? "Failed to pause active Goal"),
      };
    }
    const pausedGoalStatus =
      paused.goal && typeof paused.goal === "object"
        ? (paused.goal as { status?: unknown }).status
        : undefined;
    if (pausedGoalStatus === "complete" || pausedGoalStatus === "blocked") {
      return { success: true, alreadyStopped: true };
    }
    const stopped = await stopOwnedTurnByQueueId(turn.owner, turn.queueId);
    if (!stopped.success) return stopped;
    const settled = await managementApi("/api/goal/turn/abort", "POST", {
      sessionId: context.sessionId,
      workspacePath: context.workspacePath,
      goalId: turn.owner.id,
      queueId: turn.queueId,
    });
    return settled.ok === true
      ? stopped
      : {
          success: false,
          error: String(settled.error ?? "Failed to settle paused Goal turn"),
        };
  }
  if (shouldUseExternalRuntime()) {
    const dshSelected = isDshRuntime(getCurrentRuntimeType());
    const externalResult = await selectedNonBuiltinEngine().stopTurn();
    if (
      dshSelected ||
      !externalResult.success ||
      !externalResult.alreadyStopped
    )
      return externalResult;
    const stopped = await interruptCurrentResponse();
    return stopped
      ? { success: true }
      : { success: true, alreadyStopped: true };
  }
  return builtinEngine.stopTurn();
}

export async function stopOwnedTurn(
  owner: TurnOwner,
): Promise<{ success: boolean; alreadyStopped?: boolean; error?: string }> {
  if (shouldUseExternalRuntime()) {
    const dshSelected = isDshRuntime(getCurrentRuntimeType());
    const externalResult =
      await selectedNonBuiltinEngine().stopOwnedTurn(owner);
    if (
      dshSelected ||
      !externalResult.success ||
      !externalResult.alreadyStopped
    )
      return externalResult;
  }
  return builtinEngine.stopOwnedTurn(owner);
}

export async function stopOwnedTurnByQueueId(
  owner: TurnOwner,
  queueId: string,
): Promise<{ success: boolean; alreadyStopped?: boolean; error?: string }> {
  // A Task stop must also settle a `/cron/execute-sync` request that reached
  // Node but has not published Session metadata or registered a runtime queue
  // item yet. `not_found` is authoritative only after this barrier.
  const sessionBirthSettlement =
    owner.kind === "task" ? cancelTaskSessionBirth(owner.id, queueId) : null;
  const engine = getSessionEngine();
  const canceled = await engine.cancelQueuedMessage(queueId);
  let result: { success: boolean; alreadyStopped?: boolean; error?: string };
  if (canceled.status === "cancelled") {
    result = { success: true };
  } else {
    const current = engine.getCurrentTurnIdentity();
    if (
      current?.queueId === queueId &&
      current.owner.kind === owner.kind &&
      current.owner.id === owner.id
    ) {
      const stopped = await engine.stopTurn({ preserveQueue: true });
      result =
        stopped.success && stopped.alreadyStopped
          ? {
              success: false,
              error:
                "Exact turn stop was not confirmed: the current runtime turn did not stop",
            }
          : stopped;
    } else if (canceled.status === "not_found") {
      result = { success: true, alreadyStopped: true };
    } else {
      const reason =
        canceled.status === "not_cancelled"
          ? "the runtime already accepted the queued turn and did not cancel it"
          : canceled.status === "unavailable"
            ? "queue cancellation is unavailable for this session"
            : "queue cancellation failed";
      result = {
        success: false,
        error: `Exact turn stop was not confirmed: ${reason}`,
      };
    }
  }
  await sessionBirthSettlement;
  return result;
}

/**
 * Legacy External permission prompts route by process liveness. A DSH-bound
 * Session keeps DSH ownership even after process loss so a stale response
 * cannot settle an unrelated Builtin request.
 */
export function getPermissionResponseEngine(): SessionEngine {
  if (!shouldUseExternalRuntime()) return builtinEngine;
  if (isDshRuntime(getCurrentRuntimeType())) return dshEngine;
  return isExternalSessionActive() ? externalEngine : builtinEngine;
}

/**
 * AskUserQuestion ownership is tracked per request id. If an external request
 * is still pending, route back to that owner even if the process has just gone
 * away; the external handler preserves the pending entry and returns false so
 * the UI can surface retry/failure instead of silently losing the answer.
 */
export function getAskUserQuestionResponseEngine(
  requestId: string,
): SessionEngine {
  if (!shouldUseExternalRuntime()) return builtinEngine;
  if (isDshRuntime(getCurrentRuntimeType())) return dshEngine;
  return hasPendingExternalAskUserQuestion(requestId)
    ? externalEngine
    : builtinEngine;
}

/** Plan review responses follow the pending request owner, like AskUserQuestion. */
export function getPlanApprovalResponseEngine(
  requestId: string,
): SessionEngine {
  if (!shouldUseExternalRuntime()) return builtinEngine;
  if (isDshRuntime(getCurrentRuntimeType())) return dshEngine;
  return hasPendingExternalPlanApproval(requestId)
    ? externalEngine
    : builtinEngine;
}

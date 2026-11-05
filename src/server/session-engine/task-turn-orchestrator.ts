import { CODEX_SUBSCRIPTION_PROVIDER_ID } from '../../shared/config-types';
import type { RuntimeBackedProviderIdentity } from '../../shared/providerExecution';
import { createConcreteProviderRoute } from '../../shared/providerRoute';
import type { SessionOrigin } from '../../shared/session-origin';
import type { RuntimeConfig, RuntimeSource, RuntimeType } from '../../shared/types/runtime';
import type { RequiredSystemSkill } from '../../shared/systemSkills';
import type { AgentConfig } from '../../shared/types/agent';
import {
  createSession,
  getSessionMetadata,
  updateSessionMetadata,
} from '../SessionStore';
import type { SessionMetadata } from '../types/session';
import type { DispatchGuard } from '../session-core/turn-queue';
import {
  clearCronTaskContext,
  consumeCronTaskExitRequest,
  CRON_TASK_COMPLETE_PATTERN,
  CRON_TASK_EXIT_REASON_PATTERN,
  CRON_TASK_EXIT_TEXT,
  setCronTaskContext,
} from '../tools/cron-tools';
import { findProjectAgentByWorkspacePath, loadConfig } from '../utils/admin-config';
import { isManagedCodexProviderReady } from '../utils/managed-codex-readiness';
import { managementApi } from '../utils/management-api-client';
import {
  buildCronTaskReminder,
  type CronScheduleKind,
  type TaskActivationPayload,
} from '../utils/cron-reminder';
import { bindOwnedSnapshotToRuntimeIdentity } from '../utils/session-materialization';
import { snapshotForOwnedSession } from '../utils/session-snapshot';
import { normalizeSystemMaintenanceKind } from '../../shared/managedScheduledJob';
import {
  beginTaskSessionBirth,
  runTaskSessionBirthAdmission,
} from './task-session-birth';
import { withScheduledTurnDispatchLock } from './scheduled-turn-lock';
import type { SessionEngine } from './types';

export type TaskExecutePayload = {
  taskId: string;
  queueId: string;
  prompt: string;
  managedKind?: string;
  initializeSession?: boolean;
  sessionId: string;
  aiCanExit?: boolean;
  permissionMode?: string;
  runtime?: RuntimeType;
  runtimeConfig?: RuntimeConfig;
  model?: string;
  providerId?: string;
  mcpEnabledServers?: string[];
  runMode?: 'single_session' | 'new_session';
  intervalMinutes?: number;
  executionNumber?: number;
  scheduleKind?: CronScheduleKind;
  activationEvent?: TaskActivationPayload;
};

export type TaskScheduledTurnResult = {
  success: boolean;
  /** True only after the Runtime adapter accepted this exact queue id. */
  turnDispatched?: boolean;
  aiRequestedExit?: boolean;
  exitReason?: string;
  outputText?: string;
  sessionId?: string;
  terminationUnconfirmed?: boolean;
  error?: string;
  code?: string;
  status?: number;
};

export function createTaskDispatchGuard(
  taskId: string,
  queueId: string,
  sessionId: string,
): DispatchGuard {
  let canceled = false;
  const guard: DispatchGuard = async () => {
    if (canceled) {
      return { accepted: false, code: 'task_dispatch_canceled', error: 'Task execution was canceled before dispatch' };
    }
    const response = await managementApi('/api/task/turn/authorize', 'POST', {
      taskId,
      queueId,
      sessionId,
    });
    if (canceled) {
      return { accepted: false, code: 'task_dispatch_canceled', error: 'Task execution was canceled before dispatch' };
    }
    return response.ok === true
      ? { accepted: true }
      : {
          accepted: false,
          code: typeof response.code === 'string' ? response.code : 'task_dispatch_rejected',
          error: String(response.error ?? 'Task execution is no longer authorized'),
        };
  };
  guard.cancel = () => {
    canceled = true;
  };
  return guard;
}

function requiredMemorySystemSkill(managedKind: string | undefined): RequiredSystemSkill | undefined {
  switch (managedKind) {
    case 'memory_auto_update_batch': return 'myagents-memory-update';
    case 'memory_gardener': return 'myagents-memory-gardener';
    case 'memory_molt': return 'myagents-memory-molt';
    default: return undefined;
  }
}

function runtimeBackedProviderIdentity(
  runtime: RuntimeType,
  runtimeSource: RuntimeSource | undefined,
  modelValue: string | null | undefined,
): RuntimeBackedProviderIdentity | undefined {
  const model = modelValue?.trim();
  if (runtime !== 'codex' || runtimeSource !== 'managed-provider' || !model) return undefined;
  return {
    kind: 'runtime-backed-provider',
    providerId: CODEX_SUBSCRIPTION_PROVIDER_ID,
    runtime: 'codex',
    runtimeSource: 'managed-provider',
    model,
  };
}

async function initializeTaskSession(
  engine: SessionEngine,
  payload: TaskExecutePayload,
  workspacePath: string,
  origin: SessionOrigin,
  guard: DispatchGuard,
  lease: NonNullable<ReturnType<typeof beginTaskSessionBirth>>,
): Promise<{ accepted: true; sessionId: string } | { accepted: false; error: string; code?: string }> {
  const agent = findProjectAgentByWorkspacePath(workspacePath) as AgentConfig | undefined;
  const runtimeIdentity = engine.getRuntimeIdentity();
  const liveConfig = engine.getSessionConfigSnapshot();
  const runtime = runtimeIdentity.runtime;
  const runtimeSource = runtime === 'builtin'
    ? undefined
    : (runtimeIdentity.runtimeSource ?? 'system-cli');
  const agentSnapshot: Partial<SessionMetadata> = agent
    ? snapshotForOwnedSession(agent, {
        runtimeOverride: runtime,
        ...(runtimeSource ? { runtimeSourceOverride: runtimeSource } : {}),
        managedCodexProviderReady: runtimeSource === 'managed-provider'
          ? true
          : isManagedCodexProviderReady(loadConfig()),
      })
    : {};
  const taskSnapshot = bindOwnedSnapshotToRuntimeIdentity(agentSnapshot, runtimeIdentity);
  taskSnapshot.id = payload.sessionId;
  taskSnapshot.origin = origin;
  taskSnapshot.cronTaskId = payload.taskId;
  const maintenanceKind = normalizeSystemMaintenanceKind(payload.managedKind);
  if (maintenanceKind) taskSnapshot.systemMaintenanceKind = maintenanceKind;

  const runtimeIdentitySnapshot = runtimeBackedProviderIdentity(
    runtime,
    runtimeSource,
    payload.runtimeConfig?.model ?? liveConfig.model,
  );
  if (runtimeIdentitySnapshot) {
    taskSnapshot.providerExecutionIdentity = runtimeIdentitySnapshot;
    taskSnapshot.providerId = runtimeIdentitySnapshot.providerId;
    taskSnapshot.providerRoute = undefined;
    taskSnapshot.providerEnvJson = undefined;
    taskSnapshot.model = runtimeIdentitySnapshot.model;
  }
  if (payload.providerId && !runtimeIdentitySnapshot) {
    taskSnapshot.providerId = payload.providerId;
    taskSnapshot.providerEnvJson = undefined;
    if (payload.model) {
      taskSnapshot.model = payload.model;
      taskSnapshot.providerRoute = createConcreteProviderRoute(payload.providerId, payload.model);
    } else {
      taskSnapshot.model = undefined;
      taskSnapshot.providerRoute = undefined;
    }
  } else if (payload.model && !runtimeIdentitySnapshot) {
    taskSnapshot.model = payload.model;
    if (taskSnapshot.providerId) {
      taskSnapshot.providerRoute = createConcreteProviderRoute(taskSnapshot.providerId, payload.model);
    }
  }
  if (payload.mcpEnabledServers !== undefined) {
    taskSnapshot.mcpEnabledServers = payload.mcpEnabledServers;
  }

  const admission = await runTaskSessionBirthAdmission(
    lease,
    guard,
    () => createSession(workspacePath, taskSnapshot),
  );
  return admission.accepted
    ? { accepted: true, sessionId: admission.value.id }
    : { accepted: false, error: admission.error, code: admission.code };
}

export function createTaskTurnOrchestrator() {
  return {
    async runScheduledTurn(
      engine: SessionEngine,
      payload: TaskExecutePayload,
      workspacePath: string,
    ): Promise<TaskScheduledTurnResult> {
      const origin: SessionOrigin = { kind: 'automation', surface: 'task_run' };
      const dispatchGuard = createTaskDispatchGuard(payload.taskId, payload.queueId, payload.sessionId);
      const birthLease = payload.initializeSession
        ? beginTaskSessionBirth(
            payload.taskId,
            payload.queueId,
            () => { void dispatchGuard.cancel?.(); },
          )
        : null;
      if (payload.initializeSession && !birthLease) {
        return {
          success: false,
          error: `Task Session creation is already registered for queue ${payload.queueId}`,
          status: 409,
        };
      }

      try {
        return await withScheduledTurnDispatchLock(async () => {
          clearCronTaskContext();
          let effectiveSessionId = payload.sessionId;
          if (payload.initializeSession) {
            const initialized = await initializeTaskSession(
              engine,
              payload,
              workspacePath,
              origin,
              dispatchGuard,
              birthLease!,
            );
            if (!initialized.accepted) {
              return {
                success: false,
                error: initialized.error,
                ...(initialized.code ? { code: initialized.code } : {}),
                status: 409,
              };
            }
            effectiveSessionId = initialized.sessionId;
          } else {
            const existing = getSessionMetadata(effectiveSessionId);
            await updateSessionMetadata(effectiveSessionId, {
              ...(existing?.origin ? {} : { origin }),
              cronTaskId: payload.taskId,
            });
          }

          const scenario = {
            type: 'cron' as const,
            taskId: payload.taskId,
            intervalMinutes: payload.intervalMinutes ?? 15,
            aiCanExit: payload.aiCanExit ?? false,
          };
          const prepared = await engine.prepareScheduledTurn({
            sessionId: effectiveSessionId,
            workspacePath,
            scenario,
            operation: {
              kind: 'task',
              initializeSession: payload.initializeSession === true,
              model: payload.model,
              providerId: payload.providerId,
              permissionMode: payload.permissionMode,
              runtimeConfig: payload.runtimeConfig,
              mcpEnabledServers: payload.mcpEnabledServers,
              requiredSystemSkill: requiredMemorySystemSkill(payload.managedKind),
              beforeDispatch: dispatchGuard,
            },
          });
          if (!prepared.success) {
            clearCronTaskContext(effectiveSessionId);
            if (prepared.code === 'session_bind_failed') {
              return payload.initializeSession
                ? {
                    success: false,
                    error: 'Failed to create new session for execution.',
                    code: prepared.code,
                    status: 500,
                  }
                : {
                    success: false,
                    error: `Failed to switch to required Task session ${effectiveSessionId}`,
                    code: prepared.code,
                    status: 409,
                  };
            }
            return {
              success: false,
              error: prepared.error ?? 'Failed to prepare Task session',
              code: prepared.code,
              status: prepared.status ?? 500,
            };
          }

          setCronTaskContext(payload.taskId, payload.aiCanExit ?? false, effectiveSessionId);
          let admissionAttempted = false;
          try {
            const wrappedPrompt = buildCronTaskReminder({
              prompt: payload.prompt,
              taskId: payload.taskId,
              aiCanExit: payload.aiCanExit ?? false,
              scheduleKind: payload.scheduleKind,
              runMode: payload.runMode ?? 'single_session',
              intervalMinutes: payload.intervalMinutes ?? 15,
              executionNumber: payload.executionNumber,
              activationEvent: payload.activationEvent,
              includeTaskCollaboration: payload.managedKind === undefined,
            });
            admissionAttempted = true;
            const turnResult = await engine.runInjectedTurn({
              prompt: wrappedPrompt,
              sessionId: prepared.sessionId ?? effectiveSessionId,
              workspacePath,
              scenario,
              permissionMode: prepared.permissionMode,
              model: prepared.model,
              providerRoute: prepared.providerRoute,
              providerEnv: prepared.providerEnv,
              providerRoutingRecovery: prepared.providerRoutingRecovery,
              runtimeConfig: prepared.runtimeConfig ?? null,
              analyticsOrigin: origin,
              assistantChannelDelivery: 'caller-owned',
              // Ordinary Tasks are bounded by their owner cancellation and Runtime
              // liveness, not elapsed productive work. Maintenance keeps its budget.
              timeoutMs: payload.managedKind ? 3_600_000 : null,
              pollMs: 1_000,
              queueId: payload.queueId,
              turnOwner: { kind: 'task', id: payload.taskId },
              beforeDispatch: prepared.beforeDispatch ?? dispatchGuard,
              requiredSystemSkill: prepared.requiredSystemSkill,
              onDispatched: async (acceptedQueueId, acceptedSessionId) => {
                const admitted = await managementApi('/api/task/turn/admitted', 'POST', {
                  taskId: payload.taskId,
                  queueId: acceptedQueueId,
                  sessionId: acceptedSessionId,
                });
                if (admitted.ok !== true) {
                  throw new Error(String(admitted.error ?? 'Task admission receipt was rejected'));
                }
              },
            });
            if (!turnResult.success) {
              return {
                success: false,
                turnDispatched: turnResult.enqueued === true,
                error: turnResult.error ?? 'Execution failed',
                ...(turnResult.code ? { code: turnResult.code } : {}),
                ...(turnResult.terminationUnconfirmed ? { terminationUnconfirmed: true } : {}),
                status: turnResult.status ?? 503,
              };
            }

            const text = turnResult.text ?? '';
            let aiRequestedExit = false;
            let exitReason: string | undefined;
            const completionMatch = text.match(CRON_TASK_COMPLETE_PATTERN);
            if (completionMatch) {
              aiRequestedExit = true;
              exitReason = completionMatch[1].trim();
            }
            if (text.includes(CRON_TASK_EXIT_TEXT)) {
              aiRequestedExit = true;
              const reasonMatch = text.match(CRON_TASK_EXIT_REASON_PATTERN);
              if (reasonMatch) exitReason = reasonMatch[1].trim();
            }
            const exitRequest = consumeCronTaskExitRequest(effectiveSessionId);
            if (exitRequest) {
              aiRequestedExit = true;
              exitReason = exitRequest.reason;
            }
            return {
              success: true,
              turnDispatched: true,
              aiRequestedExit,
              exitReason,
              outputText: text || undefined,
              sessionId: effectiveSessionId,
            };
          } catch (error) {
            return {
              success: false,
              turnDispatched: false,
              ...(admissionAttempted ? { terminationUnconfirmed: true } : {}),
              error: error instanceof Error ? error.message : 'Unknown error',
              status: 500,
            };
          } finally {
            clearCronTaskContext(effectiveSessionId);
            await prepared.release?.();
          }
        });
      } finally {
        birthLease?.settle();
      }
    },
  };
}

export const taskTurnOrchestrator = createTaskTurnOrchestrator();

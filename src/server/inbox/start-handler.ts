import type { AgentConfig } from '../../shared/types/agent';
import type { RuntimeSource, RuntimeType } from '../../shared/types/runtime';
import {
  resolveSessionStartPermissionMode,
  type SessionBirthOverrides,
} from '../../shared/sessionPermissionCeiling';
import { deriveSessionTitle } from '../../shared/sessionTitle';
import type {
  AdminAppConfig,
  AgentConfigSlim,
  ProjectSlim,
} from '../utils/admin-config';
import {
  claimPreparedSessionForTurnAdmission,
  deleteSession,
  getSessionMetadata,
  saveSessionMetadata,
} from '../SessionStore';
import { createMaterializedSessionMetadata } from '../utils/session-materialization';
import type { InboxAdmissionResult } from '../session-engine/types';
import type { DispatchGuard } from '../session-core/turn-queue';
import { buildSessionEventPrompt, buildTurnMeta } from './drain-handler';
import { resolveTargetAgentDefaults } from './start-admin-handler';
import type { PendingInboxMessage } from './types';

export interface FreshSessionStartContext {
  sessionId: string;
  workspacePath: string;
  agent: AgentConfig;
  project?: ProjectSlim;
  config?: AdminAppConfig;
  runtime: RuntimeType;
  runtimeSource?: RuntimeSource;
  managedCodexProviderReady?: boolean;
  birthOverrides?: SessionBirthOverrides;
}

export type FreshSessionInjector = (
  text: string,
  options: {
    inboxMeta: ReturnType<typeof buildTurnMeta>;
    queueId: string;
    beforeDispatch: DispatchGuard;
  },
) => Promise<InboxAdmissionResult>;

export interface FreshSessionStartResponse {
  accepted: boolean | null;
  unconfirmed?: boolean;
  reason?: string;
}

async function rollbackPreparedSession(sessionId: string, messageId: string): Promise<string | undefined> {
  const rollback = await deleteSession(sessionId, {
    kind: 'prepared-materialization-rollback',
    sourceSessionId: messageId,
  });
  if (rollback.deleted || rollback.reason === 'not-found') return undefined;
  return `prepared rollback refused: ${rollback.reason}`;
}

/**
 * Materialize a hidden owned Session and linearize success at Runtime dispatch
 * acceptance. It never waits for terminal output.
 */
export async function handleFreshSessionStart(
  message: PendingInboxMessage,
  context: FreshSessionStartContext,
  inject: FreshSessionInjector,
): Promise<FreshSessionStartResponse> {
  if (
    message.kind !== 'request'
    || !message.messageId
    || ((message.sourceKind ?? 'internal-session') === 'internal-session' && !message.fromSessionId)
    || !message.toSessionId
    || !message.text
  ) {
    return { accepted: false, reason: 'invalid fresh-session request envelope' };
  }
  if (message.toSessionId !== context.sessionId) {
    return { accepted: false, reason: 'target Session identity does not match this Sidecar' };
  }
  if (getSessionMetadata(context.sessionId)) {
    return { accepted: false, reason: 'target Session metadata already exists' };
  }

  // Re-validate birthOverrides permissionMode against the target Sidecar's
  // freshly loaded persisted Agent/Project/Config before writing metadata so a
  // concurrent `agent set` lowering the Agent's ceiling during Sidecar cold-start
  // cannot be bypassed (TOCTOU defense-in-depth).
  if (context.birthOverrides?.permissionMode && context.config) {
    const freshDefaults = resolveTargetAgentDefaults(
      context.agent as unknown as AgentConfigSlim,
      context.project,
      context.config,
    );
    const permCheck = resolveSessionStartPermissionMode({
      targetRuntime: freshDefaults.runtime,
      targetRuntimeSource: freshDefaults.runtimeSource,
      targetEffectivePermissionMode: freshDefaults.permissionMode,
      requestedRuntime: context.runtime,
      requestedRuntimeSource: context.runtimeSource,
      requestedPermissionMode: context.birthOverrides.permissionMode,
    });
    if (!permCheck.ok) {
      return { accepted: false, reason: permCheck.message };
    }
  }

  const origin = { kind: 'session-inbox', surface: 'session_send' } as const;
  const metadata = createMaterializedSessionMetadata({
    agentDir: context.workspacePath,
    sessionId: context.sessionId,
    scenario: 'desktop',
    agent: context.agent,
    runtimePolicy:
      context.config?.defaultIntegratedRuntime !== undefined
        ? { defaultIntegratedRuntime: context.config.defaultIntegratedRuntime }
        : undefined,
    runtimeOverride: context.runtime,
    runtimeSourceOverride: context.runtimeSource,
    managedCodexProviderReady: context.managedCodexProviderReady,
    birthOverrides: context.birthOverrides,
    title: deriveSessionTitle(message.text, 40) || 'New Chat',
    origin,
  });
  metadata.materializationState = 'prepared';
  metadata.materializationSourceSessionId = message.messageId;
  await saveSessionMetadata(metadata);

  const beforeDispatch = Object.assign(
    async () => {
      const claim = await claimPreparedSessionForTurnAdmission(
        context.sessionId,
        message.messageId,
        {
          title: metadata.title,
          origin,
          // Session Event requests intentionally keep the existing preview
          // policy; no new preview is synthesized for this feature.
          lastMessagePreview: undefined,
        },
      );
      if (claim.status === 'claimed') return { accepted: true as const };
      if (claim.status === 'already-committed') {
        return { accepted: true as const };
      }
      return { accepted: false as const, error: `prepared admission ${claim.status}` };
    },
    {
      cancel: async () => {
        const rollbackError = await rollbackPreparedSession(context.sessionId, message.messageId);
        if (rollbackError) console.warn(`[inbox/start] ${rollbackError}`);
      },
    },
  );

  try {
    const result = await inject(buildSessionEventPrompt(message), {
      inboxMeta: buildTurnMeta(message),
      queueId: message.messageId,
      beforeDispatch,
    });
    if (!result.dispatchAcceptance) {
      const rollbackError = await rollbackPreparedSession(context.sessionId, message.messageId);
      return {
        accepted: false,
        reason: rollbackError
          ? `Runtime did not expose dispatch acceptance; ${rollbackError}`
          : 'Runtime did not expose dispatch acceptance',
      };
    }
    const acceptance = await result.dispatchAcceptance;
    // Dispatch acceptance is the sole irreversible boundary. Adapter work may
    // still return an error after it has surfaced/persisted the accepted turn;
    // that is a terminal result for this Session, never a creation rejection.
    if (acceptance.accepted) return { accepted: true };
    if (result.terminationUnconfirmed) {
      return {
        accepted: null,
        unconfirmed: true,
        reason: result.error ?? acceptance.error ?? 'Runtime dispatch could not be confirmed',
      };
    }
    const rollbackError = await rollbackPreparedSession(context.sessionId, message.messageId);
    return {
      accepted: false,
      reason: rollbackError
        ? `${acceptance.error ?? result.error ?? 'runtime rejected dispatch'}; ${rollbackError}`
        : acceptance.error ?? result.error ?? 'runtime rejected dispatch',
    };
  } catch (error) {
    const committed = getSessionMetadata(context.sessionId);
    if (committed && committed.materializationState !== 'prepared') {
      return { accepted: true };
    }
    const reason = error instanceof Error ? error.message : String(error);
    const rollbackError = await rollbackPreparedSession(context.sessionId, message.messageId);
    return {
      accepted: false,
      reason: rollbackError ? `${reason}; ${rollbackError}` : reason,
    };
  }
}

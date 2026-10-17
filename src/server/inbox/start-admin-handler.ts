import { APP_CLI_NAME } from '../../shared/appProfile';
import { isProjectArchived, isProjectVisibleToUser } from '../../shared/config-types';
import { cancellableFetch } from '../utils/cancellation';
import { managementRequestHeaders } from '../utils/management-api-client';
import {
  agentWorkspaceIdentityFailure,
  resolvePersistedAgentWorkspaceRegistry,
} from '../utils/agent-workspace-identity';
import { getSessionMetadata } from '../SessionStore';
import { deriveCallerInboxLabel } from './admin-handler';

export interface AdminSessionStartRequest extends Record<string, unknown> {
  agentId?: unknown;
  prompt?: unknown;
  replyBack?: unknown;
}

export interface AdminSessionStartResponse extends Record<string, unknown> {
  accepted: boolean | null;
  asynchronous?: boolean;
  agentId?: string;
  sessionId?: string;
  messageId?: string;
  replyBack?: boolean;
  resultDelivery?: 'send.result';
  unconfirmed?: boolean;
  error?: { code: string; message: string };
}

interface RustFreshStartOutcome {
  status: 'accepted' | 'rejected' | 'unconfirmed' | 'delivery_failed';
  agentId: string;
  sessionId: string;
  messageId: string;
  replyBack: boolean;
  reason?: string;
}

function isFreshStartOutcome(value: unknown): value is RustFreshStartOutcome {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const outcome = value as Record<string, unknown>;
  return (
    ['accepted', 'rejected', 'unconfirmed', 'delivery_failed'].includes(String(outcome.status))
    && typeof outcome.agentId === 'string'
    && typeof outcome.sessionId === 'string'
    && typeof outcome.messageId === 'string'
    && typeof outcome.replyBack === 'boolean'
  );
}

const FORBIDDEN_OVERRIDE_FIELDS = [
  'runtime',
  'runtimeSource',
  'model',
  'permissionMode',
  'providerId',
  'runtimeConfig',
  'mcpEnabledServers',
  'enabledPluginIds',
  'enabledOfficialToolIds',
] as const;

export async function handleAdminSessionStart(
  callerSessionId: string,
  body: AdminSessionStartRequest,
  sourceKind: 'internal-session' | 'external-cli',
): Promise<{ status: number; response: AdminSessionStartResponse }> {
  const agentId = typeof body.agentId === 'string' ? body.agentId.trim() : '';
  const prompt = typeof body.prompt === 'string' ? body.prompt : '';
  if (sourceKind === 'internal-session' && !callerSessionId) {
    return {
      status: 400,
      response: {
        accepted: false,
        error: {
          code: 'caller_session_required',
          message: 'session start must run from an initialized MyAgents Session',
        },
      },
    };
  }
  if (!agentId || !prompt) {
    return {
      status: 400,
      response: {
        accepted: false,
        error: { code: 'invalid_args', message: 'agentId and prompt are required' },
      },
    };
  }
  const forbidden = FORBIDDEN_OVERRIDE_FIELDS.find(field => body[field] !== undefined);
  if (forbidden) {
    return {
      status: 400,
      response: {
        accepted: false,
        error: {
          code: 'target_config_override_forbidden',
          message: `session start does not accept caller override '${forbidden}'; the target Agent owns Session configuration`,
        },
      },
    };
  }

  let registry: Awaited<ReturnType<typeof resolvePersistedAgentWorkspaceRegistry>>;
  try {
    registry = await resolvePersistedAgentWorkspaceRegistry();
  } catch (error) {
    const failure = agentWorkspaceIdentityFailure(error);
    return {
      status: 409,
      response: {
        accepted: false,
        error: { code: failure.code ?? 'agent_identity_conflict', message: failure.error },
      },
    };
  }
  const diagnostic = registry.diagnostics.find(item => item.agentIds.includes(agentId));
  if (diagnostic) {
    return {
      status: 409,
      response: {
        accepted: false,
        agentId,
        error: { code: diagnostic.code, message: diagnostic.message },
      },
    };
  }
  const identity = registry.agentProjections.find(item => item.agentId === agentId);
  if (!identity || (identity.project && !isProjectVisibleToUser(identity.project))) {
    return {
      status: 404,
      response: {
        accepted: false,
        agentId,
        error: { code: 'agent_not_found', message: `Agent '${agentId}' not found` },
      },
    };
  }
  if (identity.project && isProjectArchived(identity.project)) {
    return {
      status: 409,
      response: {
        accepted: false,
        agentId,
        error: { code: 'agent_archived', message: `Agent '${agentId}' belongs to an archived workspace` },
      },
    };
  }

  const managementPort = process.env.MYAGENTS_MANAGEMENT_PORT;
  if (!managementPort) {
    return {
      status: 502,
      response: {
        accepted: false,
        agentId,
        error: { code: 'delivery_failed', message: 'MYAGENTS_MANAGEMENT_PORT not set' },
      },
    };
  }

  const replyBack =
    sourceKind === 'external-cli' ? false : body.replyBack !== false;
  let response: Response;
  try {
    response = await cancellableFetch(
      `http://127.0.0.1:${managementPort}/api/inbox/start-session`,
      {
        method: 'POST',
        headers: managementRequestHeaders(),
        body: JSON.stringify({
          agentId,
          workspacePath: identity.workspacePath,
          sourceKind,
          ...(sourceKind === 'internal-session'
            ? {
                fromSessionId: callerSessionId,
                fromLabel: await deriveCallerInboxLabel(
                  callerSessionId,
                  getSessionMetadata(callerSessionId) ?? null,
                ),
              }
            : { fromLabel: 'External CLI' }),
          prompt,
          replyBack,
        }),
      },
      // Rust owns Sidecar startup plus target dispatch acknowledgement. Keep
      // this outer budget above those bounded inner phases so the source does
      // not abandon a still-running Rust operation before it can return IDs.
      { timeoutMs: 180_000 },
    );
  } catch (error) {
    return {
      status: 502,
      response: {
        accepted: null,
        unconfirmed: true,
        agentId,
        error: {
          code: 'admission_unconfirmed',
          message: `admission acknowledgement was not confirmed: ${error instanceof Error ? error.message : String(error)}`,
        },
      },
    };
  }

  const json = (await response.json().catch(() => null)) as {
    ok?: boolean;
    outcome?: RustFreshStartOutcome;
    error?: string;
  } | null;
  if (!response.ok || !json?.ok || !isFreshStartOutcome(json.outcome)) {
    return {
      status: 502,
      response: {
        accepted: null,
        unconfirmed: true,
        agentId,
        error: {
          code: 'admission_unconfirmed',
          message: json?.error ?? `admission acknowledgement was not confirmed (management API ${response.status})`,
        },
      },
    };
  }

  const outcome = json.outcome;
  const receipt = {
    agentId: outcome.agentId,
    sessionId: outcome.sessionId,
    messageId: outcome.messageId,
    replyBack: outcome.replyBack,
  };
  if (outcome.status === 'accepted') {
    return {
      status: 200,
      response: {
        accepted: true,
        asynchronous: true,
        ...receipt,
        ...(outcome.replyBack ? { resultDelivery: 'send.result' as const } : {}),
      },
    };
  }
  if (outcome.status === 'unconfirmed') {
    return {
      status: 502,
      response: {
        accepted: null,
        unconfirmed: true,
        ...receipt,
        error: {
          code: 'admission_unconfirmed',
          message: outcome.reason ?? 'admission acknowledgement was not confirmed',
        },
        recoveryHint: {
          recoveryCommand: `${APP_CLI_NAME} session list --agent ${agentId}`,
          message: 'Check whether the new Session materialized; do not automatically resend.',
        },
      },
    };
  }
  return {
    status: outcome.status === 'rejected' ? 409 : 502,
    response: {
      accepted: false,
      ...receipt,
      error: {
        code: outcome.status === 'rejected' ? 'rejected' : 'delivery_failed',
        message: outcome.reason ?? 'fresh Session admission failed',
      },
    },
  };
}

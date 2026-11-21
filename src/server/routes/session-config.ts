import type { RuntimeAgentWorkControl } from '../../shared/types/subagent-lifecycle';
import type { McpServerDefinition } from '../../shared/config-types';
import { normalizeOfficialToolIds } from '../../shared/official-tools';
import { getSessionEngine } from '../session-engine';
import type { ProviderEnv } from '../provider-types';
import type { SessionEngineSnapshotMaterializePatch } from '../session-engine/types';
import type { InteractionScenario } from '../system-prompt';
import { isPermissionModeForRuntimeIdentity } from '../../shared/providerExecution';

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

function redactSessionMetadata<T>(metadata: T): T {
  if (!metadata || typeof metadata !== 'object') return metadata;
  const meta = metadata as T & { providerEnvJson?: unknown };
  if (meta.providerEnvJson === undefined) return metadata;
  return { ...meta, providerEnvJson: '[redacted]' };
}

function parseDesktopInteractionScenario(value: unknown): Extract<InteractionScenario, { type: 'desktop' }> | null {
  if (!value || typeof value !== 'object') return null;
  const scenario = value as { type?: unknown; surface?: unknown };
  if (scenario.type !== 'desktop') return null;
  if (scenario.surface === undefined) return { type: 'desktop' };
  if (scenario.surface === 'chat' || scenario.surface === 'floating-ball') {
    return { type: 'desktop', surface: scenario.surface };
  }
  return null;
}

function permissionIdentifier(value: unknown): string | null {
  const hasControlCharacter = typeof value === 'string'
    && [...value].some(character => {
      const code = character.charCodeAt(0);
      return code <= 31 || code === 127;
    });
  return typeof value === 'string'
    && value.length > 0
    && value.length <= 256
    && !hasControlCharacter
    ? value
    : null;
}

function permissionTarget(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 && value.length <= 8_192
    ? value
    : null;
}

function permissionRuleCapabilityError(): Response {
  return jsonResponse({
    success: false,
    error: 'The active Session Runtime does not expose authoritative permission rules.',
  }, 409);
}

function permissionMutationErrorStatus(error: unknown): number {
  const code = error && typeof error === 'object' && 'code' in error
    ? String((error as { code?: unknown }).code)
    : '';
  const message = error instanceof Error ? error.message : '';
  return code === 'permission_revision_stale'
    || code === 'permission_mutation_busy'
    || message.includes('permission_revision_stale')
    || message.includes('only while the root turn is idle')
    ? 409
    : 500;
}

export async function handleSessionConfigRoute(
  pathname: string,
  request: Request,
): Promise<Response | null> {
  if (pathname === '/api/interaction-scenario/set' && request.method === 'POST') {
    try {
      const payload = await request.json() as { scenario?: unknown };
      const scenario = parseDesktopInteractionScenario(payload?.scenario);
      if (!scenario) {
        return jsonResponse({ success: false, error: 'Invalid desktop interaction scenario.' }, 400);
      }
      const result = await getSessionEngine().updateDesktopInteractionScenario(scenario);
      return jsonResponse(result, result.success ? 200 : 500);
    } catch (error) {
      console.error('[api/interaction-scenario/set] Error:', error);
      return jsonResponse(
        { success: false, error: error instanceof Error ? error.message : 'Failed to set interaction scenario' },
        500,
      );
    }
  }

  if (pathname === '/api/mcp/set' && request.method === 'POST') {
    try {
      const payload = await request.json() as { servers?: McpServerDefinition[]; selectedIds?: unknown };
      const servers = payload?.servers ?? [];
      const selectedIds = payload?.selectedIds;
      if (selectedIds !== undefined && (!Array.isArray(selectedIds) || !selectedIds.every(id => typeof id === 'string'))) {
        return jsonResponse({ success: false, error: 'selectedIds must be a list of MCP IDs' }, 400);
      }
      const engine = getSessionEngine();
      const result = selectedIds === undefined ? await engine.updateMcpServers(servers) : await engine.updateMcpServers(servers, selectedIds);
      return jsonResponse(result, result.success ? 200 : 500);
    } catch (error) {
      console.error('[api/mcp/set] Error:', error);
      return jsonResponse(
        { success: false, error: error instanceof Error ? error.message : 'Failed to set MCP servers' },
        500,
      );
    }
  }

  if (pathname === '/api/official-tools/session-enable' && request.method === 'POST') {
    try {
      const payload = await request.json() as { enabledIds?: unknown };
      const ids = payload.enabledIds === null
        ? null
        : normalizeOfficialToolIds(payload.enabledIds);
      const result = await getSessionEngine().updateOfficialToolIds(ids);
      return jsonResponse({ ...result, enabledIds: ids }, result.success ? 200 : 500);
    } catch (error) {
      console.error('[api/official-tools/session-enable] Error:', error);
      return jsonResponse(
        { success: false, error: error instanceof Error ? error.message : 'Failed to set official tools' },
        500,
      );
    }
  }

  if (pathname === '/api/cc-plugin/session-enable' && request.method === 'POST') {
    try {
      const payload = await request.json() as { enabledIds?: unknown };
      if (payload.enabledIds !== null && payload.enabledIds !== undefined && !Array.isArray(payload.enabledIds)) {
        return jsonResponse({ success: false, error: 'enabledIds must be string[] or null' }, 400);
      }
      const ids = payload.enabledIds === null || payload.enabledIds === undefined
        ? null
        : payload.enabledIds.filter((entry): entry is string => typeof entry === 'string');
      const result = await getSessionEngine().updateEnabledPluginIds(ids);
      return jsonResponse({ ...result, enabledIds: ids }, result.success ? 200 : 500);
    } catch (error) {
      console.error('[api/cc-plugin/session-enable] Error:', error);
      return jsonResponse(
        { success: false, error: error instanceof Error ? error.message : 'Failed to set Session plugins' },
        500,
      );
    }
  }

  if (pathname === '/api/agents/set' && request.method === 'POST') {
    try {
      const payload = await request.json() as { agents: Record<string, unknown> };
      const result = await getSessionEngine().updateAgents(payload.agents);
      return jsonResponse(result, result.success ? 200 : 500);
    } catch (error) {
      console.error('[api/agents/set] Error:', error);
      return jsonResponse({ success: false, error: error instanceof Error ? error.message : 'Failed to set agents' }, 500);
    }
  }

  if (pathname === '/api/provider/set' && request.method === 'POST') {
    try {
      const payload = await request.json() as { providerEnv?: Record<string, unknown> | null };
      const providerEnv = (payload?.providerEnv ?? undefined) as ProviderEnv | undefined;
      const result = await getSessionEngine().updateProviderEnv(providerEnv);
      return jsonResponse(result.success ? { success: true } : result, result.success ? 200 : 500);
    } catch (error) {
      console.error('[api/provider/set] Error:', error);
      return jsonResponse({ success: false, error: error instanceof Error ? error.message : 'Failed to set provider' }, 500);
    }
  }

  if (pathname === '/api/session/permission-mode' && request.method === 'POST') {
    try {
      const payload = await request.json() as { permissionMode?: string };
      if (!payload?.permissionMode) {
        return jsonResponse({ success: false, error: 'permissionMode is required' }, 400);
      }
      const engine = getSessionEngine();
      const identity = engine.getRuntimeIdentity();
      const valid = isPermissionModeForRuntimeIdentity(
        payload.permissionMode,
        identity.runtime,
        identity.runtimeSource,
      );
      if (!valid) {
        return jsonResponse({ success: false, error: `Invalid permissionMode '${payload.permissionMode}' for ${identity.runtimeSource ?? identity.runtime}` }, 400);
      }
      const result = await engine.updatePermissionMode(payload.permissionMode);
      return jsonResponse(result, result.success ? 200 : 500);
    } catch (error) {
      console.error('[api/session/permission-mode] Error:', error);
      return jsonResponse({ success: false, error: error instanceof Error ? error.message : 'Failed to set permission mode' }, 500);
    }
  }

  if (pathname === '/api/session/agent-work' && request.method === 'GET') {
    const engine = getSessionEngine();
    if (!engine.listAgentWork) return jsonResponse({ success: false, error: 'Agent work is unavailable' }, 409);
    const tasksFor = new URL(request.url).searchParams.get('tasksFor') ?? undefined;
    if (tasksFor !== undefined && (tasksFor.length < 1 || tasksFor.length > 256)) return jsonResponse({ success: false, error: 'Invalid Agent identity' }, 400);
    try { return jsonResponse({ success: true, ...await engine.listAgentWork(tasksFor) }); }
    catch (error) { return jsonResponse({ success: false, error: error instanceof Error ? error.message : 'Agent work read failed' }, 409); }
  }
  if (pathname === '/api/session/agent-work' && request.method === 'POST') {
    const engine = getSessionEngine();
    if (!engine.controlAgentWork) return jsonResponse({ success: false, error: 'Agent controls are unavailable' }, 409);
    try {
      const value: unknown = await request.json();
      if (!value || typeof value !== 'object' || Array.isArray(value)) return jsonResponse({ success: false, error: 'Invalid Agent action' }, 400);
      const input = value as Record<string, unknown>;
      const identifier = (value: unknown): value is string => typeof value === 'string' && value.length > 0 && value.length <= 256;
      const kind = input.kind;
      if (!identifier(input.agentId) || !['resume', 'stop', 'message'].includes(String(kind))
        || (kind === 'message' ? !identifier(input.clientMessageId) || typeof input.message !== 'string' || input.message.length < 1 || input.message.length > 12000
          : !Number.isSafeInteger(input.expectedHandleRevision) || Number(input.expectedHandleRevision) < 0)
        || (kind === 'resume' && !identifier(input.clientRequestId))) return jsonResponse({ success: false, error: 'Invalid Agent action' }, 400);
      const allowed = kind === 'message' ? ['kind', 'agentId', 'clientMessageId', 'message']
        : kind === 'resume' ? ['kind', 'agentId', 'expectedHandleRevision', 'clientRequestId'] : ['kind', 'agentId', 'expectedHandleRevision'];
      if (Object.keys(input).some(key => !allowed.includes(key))) return jsonResponse({ success: false, error: 'Unknown Agent action field' }, 400);
      await engine.controlAgentWork(input as RuntimeAgentWorkControl);
      return jsonResponse({ success: true });
    } catch (error) { return jsonResponse({ success: false, error: error instanceof Error ? error.message : 'Agent action failed' }, 409); }
  }

  if (pathname === '/api/session/permission-rules' && request.method === 'GET') {
    const engine = getSessionEngine();
    const identity = engine.getRuntimeIdentity();
    if (
      identity.runtime !== 'dsh'
      || identity.runtimeSource !== 'integrated'
      || !engine.listPermissionRules
    ) {
      return permissionRuleCapabilityError();
    }
    try {
      return jsonResponse({ success: true, ...(await engine.listPermissionRules()) });
    } catch (error) {
      console.error('[api/session/permission-rules] Error:', error);
      return jsonResponse({
        success: false,
        error: error instanceof Error ? error.message : 'Failed to inspect permission rules',
      }, 500);
    }
  }

  if (pathname === '/api/session/permission-rules' && request.method === 'POST') {
    const engine = getSessionEngine();
    const identity = engine.getRuntimeIdentity();
    if (
      identity.runtime !== 'dsh'
      || identity.runtimeSource !== 'integrated'
      || !engine.addPermissionRule
    ) {
      return permissionRuleCapabilityError();
    }
    try {
      const payload = await request.json() as Record<string, unknown>;
      const expectedRevision = permissionIdentifier(payload.expectedRevision);
      const tool = permissionIdentifier(payload.tool);
      const permissionClass = permissionIdentifier(payload.permissionClass);
      const target = permissionTarget(payload.target);
      if (!expectedRevision || !tool || !permissionClass || !target) {
        return jsonResponse({ success: false, error: 'Invalid exact permission rule.' }, 400);
      }
      const mutation = await engine.addPermissionRule({
        expectedRevision,
        tool,
        permissionClass,
        target,
      });
      return jsonResponse({ success: true, mutation });
    } catch (error) {
      console.error('[api/session/permission-rules] Add error:', error);
      return jsonResponse({
        success: false,
        error: error instanceof Error ? error.message : 'Failed to add permission rule',
      }, permissionMutationErrorStatus(error));
    }
  }

  if (pathname === '/api/session/permission-rules' && request.method === 'DELETE') {
    const engine = getSessionEngine();
    const identity = engine.getRuntimeIdentity();
    if (
      identity.runtime !== 'dsh'
      || identity.runtimeSource !== 'integrated'
      || !engine.revokePermissionRule
    ) {
      return permissionRuleCapabilityError();
    }
    try {
      const url = new URL(request.url);
      const expectedRevision = permissionIdentifier(url.searchParams.get('expectedRevision'));
      const ruleId = permissionIdentifier(url.searchParams.get('ruleId'));
      if (!expectedRevision || !ruleId) {
        return jsonResponse({ success: false, error: 'Invalid permission rule revocation.' }, 400);
      }
      const mutation = await engine.revokePermissionRule({ expectedRevision, ruleId });
      return jsonResponse({ success: true, mutation });
    } catch (error) {
      console.error('[api/session/permission-rules] Revoke error:', error);
      return jsonResponse({
        success: false,
        error: error instanceof Error ? error.message : 'Failed to revoke permission rule',
      }, permissionMutationErrorStatus(error));
    }
  }

  if (pathname === '/api/session/materialize' && request.method === 'POST') {
    try {
      const payload = await request.json() as {
        workspacePath?: string;
        phase?: 'prepare' | 'commit' | 'rollback';
        preparedSessionId?: string;
        snapshotPatch?: SessionEngineSnapshotMaterializePatch;
      };
      if (!payload?.workspacePath || typeof payload.workspacePath !== 'string') {
        return jsonResponse({ success: false, error: 'workspacePath is required' }, 400);
      }
      const requestedPermissionMode = payload.snapshotPatch?.permissionMode;
      if (requestedPermissionMode !== undefined && requestedPermissionMode !== null
          && typeof requestedPermissionMode !== 'string') {
        return jsonResponse({ success: false, error: 'permissionMode must be a string or null' }, 400);
      }
      if (typeof requestedPermissionMode === 'string' && requestedPermissionMode.trim()) {
        const identity = getSessionEngine().getRuntimeIdentity();
        const valid = isPermissionModeForRuntimeIdentity(
          requestedPermissionMode,
          identity.runtime,
          identity.runtimeSource,
        );
        if (!valid) {
          return jsonResponse({ success: false, error: `Invalid permissionMode '${requestedPermissionMode}' for ${identity.runtimeSource ?? identity.runtime}` }, 400);
        }
      }
      const result = await getSessionEngine().materializePendingDesktopSession({
        workspacePath: payload.workspacePath,
        phase: payload.phase,
        preparedSessionId: payload.preparedSessionId,
        snapshotPatch: payload.snapshotPatch,
      });
      return jsonResponse(
        result.metadata ? { ...result, metadata: redactSessionMetadata(result.metadata) } : result,
        result.success ? 200 : (result.status ?? 500),
      );
    } catch (error) {
      console.error('[api/session/materialize] Error:', error);
      return jsonResponse({ success: false, error: error instanceof Error ? error.message : 'Failed to materialize session' }, 500);
    }
  }

  if (pathname === '/api/session/config' && request.method === 'GET') {
    try {
      return jsonResponse(getSessionEngine().getSessionConfigSnapshot());
    } catch (error) {
      console.error('[api/session/config] Error:', error);
      return jsonResponse({ success: false, error: error instanceof Error ? error.message : 'Failed to get session config' }, 500);
    }
  }

  return null;
}

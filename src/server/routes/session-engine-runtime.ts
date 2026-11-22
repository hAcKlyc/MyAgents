import {
  getPermissionResponseEngine,
  prewarmExternalRuntimeAtSelector,
  updateExternalRuntimeConfigAtSelector,
} from '../session-engine';

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

export type SessionEngineRuntimeRouteDeps = {
  workspacePath: string;
  resolvePrewarmSessionId(requestedSessionId: string | undefined): string;
};

export async function handleSessionEngineRuntimeRoute(
  pathname: string,
  request: Request,
  deps: SessionEngineRuntimeRouteDeps,
): Promise<Response | null> {
  if (pathname === '/api/runtime/config' && request.method === 'POST') {
    const body = (await request.json().catch(() => ({}))) as {
      runtime?: string;
      runtimeConfig?: {
        model?: string | null;
        permissionMode?: string | null;
        reasoningEffort?: string | null;
      } | null;
      source?: unknown;
    };
    const runtimeConfig = body.runtimeConfig ?? {};
    const result = await updateExternalRuntimeConfigAtSelector({
      runtime: body.runtime,
      runtimeConfig,
      source: body.source,
    });
    return jsonResponse(result.body, result.httpStatus);
  }

  if (pathname === '/api/runtime/prewarm' && request.method === 'POST') {
    const body = (await request.json().catch(() => ({}))) as {
      sessionId?: string;
      model?: string;
    };
    const sessionId = deps.resolvePrewarmSessionId(body.sessionId);
    try {
      const result = await prewarmExternalRuntimeAtSelector({
        sessionId,
        workspacePath: deps.workspacePath,
        model: body.model,
      });
      return jsonResponse(result.body, result.httpStatus);
    } catch (error) {
      return jsonResponse(
        { success: false, error: error instanceof Error ? error.message : 'Unknown error' },
        500,
      );
    }
  }

  if (pathname === '/api/runtime/permission-response' && request.method === 'POST') {
    const body = (await request.json().catch(() => ({}))) as Record<string, unknown>;
    const requestId = body.requestId as string;
    const decision: 'deny' | 'allow_once' | 'always_allow' = (body.decision as string) === 'deny' ? 'deny'
      : (body.decision as string) === 'always_allow' ? 'always_allow'
      : (body.decision as string) === 'allow_once' ? 'allow_once'
      : (body.approved === true) ? 'allow_once' : 'deny';
    const reason = body.reason as string | undefined;
    if (!requestId) return jsonResponse({ error: 'Missing requestId' }, 400);
    try {
      const engine = getPermissionResponseEngine();
      const optionId = body.optionId;
      if (optionId !== undefined && typeof optionId !== 'string') {
        return jsonResponse({ error: 'Invalid permission optionId' }, 400);
      }
      const success = optionId === undefined
        ? await engine.respondPermission(requestId, decision, reason)
        : await engine.respondPermission(requestId, decision, reason, optionId);
      return jsonResponse({ success });
    } catch (error) {
      return jsonResponse({ error: error instanceof Error ? error.message : 'Unknown error' }, 500);
    }
  }

  return null;
}

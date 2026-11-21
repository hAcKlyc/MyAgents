import { emitPerfTrace, nowMs, elapsedMs } from '../utils/perf-trace';
import { messagePageRequest, projectMessagePage, selectMessagePage } from '../session-transcript/message-page';
import type { SessionEngineLiveOverlay } from '../session-engine/types';
import { deriveSessionLabel } from '../inbox/derive-label';
import { getSessionEngine } from '../session-engine';
import { withSessionReadSource, getSessionMetadata, isHistoryVisibleSession } from '../SessionStore';
import { pendingSessionWatchCount, registerPendingSessionWatch, removeNetworkSessionWatch, manageLocalSessionWatches } from '../inbox/watch-registry';
import { parseNetworkReturnReference } from '../../shared/agentNetworkReturn';
import { hasValidInternalCliCredential } from '../external-cli-admission';
import {
  shrinkSessionMessageForClient,
  shrinkSessionMessagesForClient,
} from '../utils/session-message-preview';
import { toClientSessionMetadata } from '../utils/session-metadata-wire';
import type { SessionMessage, SessionMetadata } from '../types/session';
import { projectSessionActivity } from '../session-engine/observation';

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

function mergeActiveOverlayMessages(
  diskMessages: SessionMessage[],
  inMemoryMessages: SessionMessage[] | undefined,
): SessionMessage[] {
  if (!inMemoryMessages?.length) return diskMessages;
  const memoryById = new Map(inMemoryMessages.map(message => [message.id, message]));
  const diskIds = new Set(diskMessages.map(message => message.id));
  const merged = diskMessages.map(message => memoryById.get(message.id) ?? message);
  for (const message of inMemoryMessages) {
    if (!diskIds.has(message.id)) merged.push(message);
  }
  return merged;
}

function paginateMessages(
  messages: SessionMessage[],
  url: URL,
  transcriptFormat?: number,
): { messages: SessionMessage[]; totalCount: number; hasMoreBefore: boolean } {
  const request = messagePageRequest(url);
  return selectMessagePage(messages, { ...request, from: transcriptFormat === 2 ? request.from : null }, row => row.id);
}

async function handleSessionWatchRegister(request: Request): Promise<Response> {
  const body = (await request.json().catch(() => null)) as {
    watchId?: string;
    watcherSessionId?: string;
    watcherResumeWorkspacePath?: string;
    targetSessionId?: string;
    targetLabel?: string;
    observedSidecarState?: string;
    networkReturn?: unknown;
    observerScope?: string;
  } | null;
  if (!body?.watchId || !body.watcherSessionId || !body.targetSessionId) {
    return jsonResponse({ accepted: false, reason: 'invalid body' }, 400);
  }
  const networkReturn = body.networkReturn == null ? undefined : parseNetworkReturnReference(body.networkReturn);
  if (networkReturn === null || networkReturn && (!body.observerScope || !hasValidInternalCliCredential(request))) {
    return jsonResponse({ accepted: false, reason: 'invalid network return context' }, 401);
  }

  const engine = getSessionEngine();
  const runtimeIdentity = engine.getRuntimeIdentity();
  if (body.targetSessionId !== runtimeIdentity.sessionId) {
    return jsonResponse({ accepted: false, reason: 'target session mismatch' }, 409);
  }

  const targetSessionState = projectSessionActivity(engine.getLiveSessionState());
  if (targetSessionState === 'idle') {
    const terminal = engine.getSessionCompletionTerminal();
    const latestResult = (await engine.getLatestAssistantResult()).latestResult;
    return jsonResponse({
      accepted: false,
      delivery: 'already_idle',
      reason: 'already_idle',
      targetStateAtRegistration: targetSessionState,
      finalState: 'idle',
      terminalReason: 'already_idle',
      latestResult,
      ...(terminal ? { turnId: terminal.turnId, terminalStatus: terminal.status } : {}),
    });
  }
  const turnId = engine.getExecutionTurnId();
  if (!turnId) return jsonResponse({ accepted: false, delivery: 'error',
    reason: 'SESSION_TURN_UNAVAILABLE', targetStateAtRegistration: targetSessionState });
  // No await between observing the execution owner and registering its turn.
  const watch = registerPendingSessionWatch({
    watchId: body.watchId,
    watcherSessionId: body.watcherSessionId,
    watcherResumeWorkspacePath: body.watcherResumeWorkspacePath,
    targetSessionId: body.targetSessionId,
    targetLabel: deriveSessionLabel(getSessionMetadata(body.targetSessionId) ?? null),
    targetStateAtRegistration: targetSessionState,
    registeredAt: new Date().toISOString(),
    turnId,
    observerScope: networkReturn ? body.observerScope : undefined,
    ...(networkReturn ? { networkReturn } : {}),
  });
  return jsonResponse({
    accepted: true,
    watchId: watch.watchId,
    turnId,
    coalesced: watch.watchId !== body.watchId,
    delivery: 'registered',
    targetStateAtRegistration: targetSessionState,
    pending: pendingSessionWatchCount(),
  });
}

async function handleSessionDetails(sessionId: string, url: URL): Promise<Response> {
  const engine = getSessionEngine();
  const start = nowMs();
  const trace = url.searchParams.get('historyTrace');
  const request = messagePageRequest(url);
  const ranged = Boolean(request.limit || request.from);
  // Keep the decoded projection until the live owner has flushed its events.
  // Only the selected authority converts its page to wire rows.
  return withSessionReadSource(sessionId, (format, snapshot) => {
    const readMs = elapsedMs(start);
    const overlay: SessionEngineLiveOverlay = format === 2 && ranged
      ? engine.getLiveSessionOverlay(sessionId, request)
      : engine.getLiveSessionOverlay(sessionId);
    const source = snapshot();
    const session = source?.metadata;

    if (!source || !session) {
      if (overlay.isActive) {
        const { messages, totalCount, hasMoreBefore } = paginateMessages(
          overlay.inMemoryMessages ?? [],
          url,
        );
        return jsonResponse({
          success: true,
          session: {
            id: sessionId,
            runtime: overlay.runtime ?? engine.getRuntimeIdentity().runtime,
            messages: shrinkSessionMessagesForClient(messages),
            snapshotRevision: overlay.snapshotRevision ?? 0,
            liveStreamingMessage: overlay.liveStreamingMessage
              ? shrinkSessionMessageForClient(overlay.liveStreamingMessage)
              : null,
            liveSessionState: overlay.liveSessionState,
            pendingInteractiveRequests: overlay.pendingInteractiveRequests ?? [],
            queuedMessages: overlay.queuedMessages ?? [],
            totalCount,
            hasMoreBefore,
          },
        });
      }
      return jsonResponse({ success: false, error: 'Session not found.' }, 404);
    }
    const isActivePreparedSession =
      overlay.isActive && session.materializationState === 'prepared';
    if (!isHistoryVisibleSession(session) && !isActivePreparedSession) {
      return jsonResponse({ success: false, error: 'Session not found.' }, 404);
    }

    const storedRows = source.rows;
    let page;
    if (session.transcriptFormat === 2 && overlay.isActive) {
      const rows = overlay.inMemoryMessages ?? [];
      page = overlay.page ? { ...overlay.page, messages: rows } :
        paginateMessages(rows.filter(row => row.id !== overlay.liveStreamingMessage?.id), url, 2);
    } else if ('projection' in storedRows) {
      page = projectMessagePage(storedRows.projection, request);
    } else {
      page = paginateMessages(mergeActiveOverlayMessages(storedRows.messages, overlay.inMemoryMessages), url, session.transcriptFormat);
    }
    const { messages, totalCount, hasMoreBefore } = page;
    const liveStreamingMessage = overlay.liveStreamingMessage
      ? shrinkSessionMessageForClient(overlay.liveStreamingMessage)
      : null;

    const sessionWithPreview = {
      ...toClientSessionMetadata(session as SessionMetadata),
      liveStreamingMessage,
      snapshotRevision: overlay.snapshotRevision ?? 0,
      liveSessionState: overlay.liveSessionState,
      pendingInteractiveRequests: overlay.pendingInteractiveRequests ?? [],
      queuedMessages: overlay.queuedMessages ?? [],
      messages: shrinkSessionMessagesForClient(messages),
      totalCount,
      hasMoreBefore,
    };

    const response = jsonResponse({ success: true, session: sessionWithPreview });
    if (trace) emitPerfTrace({ trace: 'storage_io', phase: 'history_page_encoded', requestId: trace, sessionId,
      durationMs: elapsedMs(start), count: messages.length, detail: { readMs, totalCount, validatedBytes: 'projection' in storedRows ? storedRows.validBytes : undefined } });
    return response;
  });
}

export async function handleSessionReadRoute(
  pathname: string,
  request: Request,
  url: URL,
): Promise<Response | null> {
  if (pathname === '/api/session-state' && request.method === 'GET') {
    const engine = getSessionEngine();
    const liveState = engine.getLiveSessionState();
    return jsonResponse({
      sessionId: engine.getRuntimeIdentity().sessionId,
      sessionState: liveState.sessionState,
      isBusy: liveState.isBusy,
      completionTerminal: engine.getSessionCompletionTerminal(),
    });
  }

  if (pathname === '/api/session-latest-result' && request.method === 'GET') {
    return jsonResponse(await getSessionEngine().getLatestAssistantResult());
  }

  if (pathname === '/api/session-watch/manage' && request.method === 'POST') {
    if (!hasValidInternalCliCredential(request)) return jsonResponse({ success: false }, 401);
    const body = await request.json() as { watcherSessionId?: string; cancel?: string; all?: boolean };
    if (!body.watcherSessionId || body.all && body.cancel) return jsonResponse({ success: false }, 400);
    return jsonResponse({ watches: manageLocalSessionWatches(body.watcherSessionId, body.cancel, body.all) });
  }
  if (pathname === '/api/session-watch/register'  && request.method === 'POST') {
    return handleSessionWatchRegister(request);
  }
  if (pathname === '/api/session-watch/network-remove' && request.method === 'POST') {
    if (!hasValidInternalCliCredential(request)) return jsonResponse({ accepted: false }, 401);
    const body = await request.json().catch(() => null) as { watchId?: unknown; targetSessionId?: unknown; networkReturn?: unknown } | null;
    const reference = parseNetworkReturnReference(body?.networkReturn);
    if (!reference || typeof body?.watchId !== 'string'
      || body.targetSessionId !== getSessionEngine().getRuntimeIdentity().sessionId) return jsonResponse({ accepted: false }, 400);
    return jsonResponse({ accepted: true, removed: removeNetworkSessionWatch(body.watchId, reference) });
  }

  const sessionPathMatch = pathname.match(/^\/sessions\/([^/]+)$/);
  if (sessionPathMatch && request.method === 'GET') {
    const sessionId = sessionPathMatch[1];
    if (!sessionId) {
      return jsonResponse({ success: false, error: 'Session ID required.' }, 400);
    }
    return handleSessionDetails(sessionId, url);
  }

  return null;
}

import { deriveSessionLabel } from '../inbox/derive-label';
import { getSessionEngine } from '../session-engine';
import { getSessionData, getSessionMetadata, isHistoryVisibleSession } from '../SessionStore';
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
import { watchStreamManager } from '../inbox/watch-stream';
import type { WatchSubscriber } from '../../shared/session-watch-protocol';

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
  const rawLimit = parseInt(url.searchParams.get('limit') ?? '0', 10);
  const limit = Number.isFinite(rawLimit) && rawLimit > 0 ? Math.min(rawLimit, 500) : 0;
  const before = url.searchParams.get('before');

  const totalCount = messages.length;
  const from = transcriptFormat === 2 ? url.searchParams.get('from') : null;
  if (from) {
    const index = messages.findIndex(message => message.id === from);
    if (index >= 0) return { messages: messages.slice(index), totalCount, hasMoreBefore: index > 0 };
    // A mutation removed the retained anchor; return a fresh tail instead of
    // preserving rows whose source is no longer present in the transcript.
  }
  let paginatedMessages = messages;
  let hasMoreBefore = false;

  if (limit > 0) {
    if (before) {
      const beforeIdx = messages.findIndex(message => message.id === before);
      if (beforeIdx < 0) {
        paginatedMessages = [];
      } else {
        const start = Math.max(0, beforeIdx - limit);
        paginatedMessages = messages.slice(start, beforeIdx);
        hasMoreBefore = start > 0;
      }
    } else {
      const start = Math.max(0, totalCount - limit);
      paginatedMessages = messages.slice(start);
      hasMoreBefore = start > 0;
    }
  }

  return { messages: paginatedMessages, totalCount, hasMoreBefore };
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
    mode?: 'continuous' | 'single-turn'; // NEW: subscription mode
    turnId?: string; // Required for single-turn mode
  } | null;
  if (!body?.watchId || !body.watcherSessionId || !body.targetSessionId) {
    return jsonResponse({ accepted: false, reason: 'invalid body' }, 400);
  }

  // Existing CLI/network callers omit mode and retain one-turn settlement.
  // Continuous clients opt in explicitly, including useContinuousWatch.
  const mode = body.mode ?? 'single-turn';

  // Validate mode-specific requirements
  if (body.mode === 'single-turn' && !body.turnId) {
    return jsonResponse({ accepted: false, reason: 'turnId required for single-turn mode' }, 400);
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

  // For continuous mode, don't reject if already idle - they might want future events
  if (mode === 'single-turn' && targetSessionState === 'idle') {
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

  const currentTurnId = engine.getExecutionTurnId();

  if (mode === 'continuous') {
    // NEW: Continuous subscription mode
    const stream = watchStreamManager.getStream(body.targetSessionId);
    const managementPort = process.env.MYAGENTS_MANAGEMENT_PORT;

    if (!managementPort && !networkReturn) {
      return jsonResponse({
        accepted: false,
        reason: 'MYAGENTS_MANAGEMENT_PORT not set',
        mode: 'continuous',
      }, 500);
    }

    const subscriber: WatchSubscriber = {
      watchId: body.watchId,
      sessionId: body.targetSessionId,
      mode: 'continuous',
      createdAt: new Date(),
      lastHeartbeat: new Date(),
      notify: async (event) => {
        const eventWithWatchId = { ...event, watchId: body.watchId };

        if (networkReturn) {
          // TODO: implement network return delivery
          console.log('[session-watch] network return delivery not yet implemented for continuous mode');
          return;
        }

        // Deliver to local management API
        try {
          const resp = await fetch(
            `http://127.0.0.1:${managementPort}/api/inbox/deliver`,
            {
              method: 'POST',
              headers: {
                'Content-Type': 'application/json',
                'X-MyAgents-Internal-Token': process.env.MYAGENTS_INTERNAL_TOKEN || '',
              },
              body: JSON.stringify({
                message: {
                  messageId: event.eventId,
                  fromSessionId: body.targetSessionId,
                  fromLabel: body.targetLabel || 'watched session',
                  toSessionId: body.watcherSessionId,
                  text: JSON.stringify(eventWithWatchId, null, 2),
                  replyBack: false,
                  timestampMs: Date.now(),
                  kind: 'event',
                  inReplyTo: null,
                  sessionEvent: eventWithWatchId,
                },
                resumeWorkspacePath: body.watcherResumeWorkspacePath,
              }),
            }
          );

          if (!resp.ok) {
            console.warn(`[session-watch] failed to deliver event ${event.eventId}: ${resp.status}`);
          }
        } catch (err) {
          console.error('[session-watch] delivery error:', err);
        }
      },
    };

    stream.subscribe(subscriber);

    return jsonResponse({
      accepted: true,
      watchId: body.watchId,
      mode: 'continuous',
      targetStateAtRegistration: targetSessionState,
      currentTurnId,
    });
  } else {
    // LEGACY: Single-turn mode (backward compatibility)
    if (!currentTurnId) {
      return jsonResponse({
        accepted: false,
        delivery: 'error',
        reason: 'SESSION_TURN_UNAVAILABLE',
        targetStateAtRegistration: targetSessionState,
        mode: 'single-turn',
      });
    }

    const watch = registerPendingSessionWatch({
      watchId: body.watchId,
      watcherSessionId: body.watcherSessionId,
      watcherResumeWorkspacePath: body.watcherResumeWorkspacePath,
      targetSessionId: body.targetSessionId,
      targetLabel: deriveSessionLabel(getSessionMetadata(body.targetSessionId) ?? null),
      targetStateAtRegistration: targetSessionState,
      registeredAt: new Date().toISOString(),
      turnId: body.turnId || currentTurnId,
      observerScope: networkReturn ? body.observerScope : undefined,
      ...(networkReturn ? { networkReturn } : {}),
    });

    return jsonResponse({
      accepted: true,
      watchId: watch.watchId,
      turnId: body.turnId || currentTurnId,
      coalesced: watch.watchId !== body.watchId,
      delivery: 'registered',
      mode: 'single-turn',
      targetStateAtRegistration: targetSessionState,
      pending: pendingSessionWatchCount(),
    });
  }
}

async function handleSessionWatchUnsubscribe(request: Request): Promise<Response> {
  const body = (await request.json().catch(() => null)) as {
    watchId?: string;
    targetSessionId?: string;
  } | null;

  if (!body?.watchId || !body.targetSessionId) {
    return jsonResponse({ accepted: false, reason: 'invalid body' }, 400);
  }

  const engine = getSessionEngine();
  const runtimeIdentity = engine.getRuntimeIdentity();
  if (body.targetSessionId !== runtimeIdentity.sessionId) {
    return jsonResponse({ accepted: false, reason: 'target session mismatch' }, 409);
  }

  const stream = watchStreamManager.getStream(body.targetSessionId);
  const removed = stream.unsubscribe(body.watchId);

  return jsonResponse({
    accepted: true,
    removed,
    watchId: body.watchId,
  });
}

async function handleSessionDetails(sessionId: string, url: URL): Promise<Response> {
  const engine = getSessionEngine();
  const session = (await getSessionData(sessionId));
  const overlay = engine.getLiveSessionOverlay(sessionId);

  if (!session) {
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

  const mergedMessages = session.transcriptFormat === 2
    ? (overlay.isActive ? overlay.inMemoryMessages ?? [] : session.messages)
      .filter(message => message.id !== overlay.liveStreamingMessage?.id)
    : mergeActiveOverlayMessages(session.messages, overlay.inMemoryMessages);
  const { messages, totalCount, hasMoreBefore } = paginateMessages(mergedMessages, url, session.transcriptFormat);
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

  return jsonResponse({ success: true, session: sessionWithPreview });
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
  if (pathname === '/api/session-watch/unsubscribe' && request.method === 'POST') {
    return handleSessionWatchUnsubscribe(request);
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

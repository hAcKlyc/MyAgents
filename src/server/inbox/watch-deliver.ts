import { randomUUID } from 'crypto';

import { cancellableFetch } from '../utils/cancellation';
import { managementRequestHeaders } from '../utils/management-api-client';
import { buildReplyBody, deliverInboxReply, type ReplyPayload } from './reply-deliver';
import { ackPendingSessionWatch, listPendingSessionWatches } from './watch-registry';
import type { PendingInboxMessage, DeliverOutcome, InboxTurnMeta } from './types';
import { deliverNetworkReturn } from '../agent-network/return';
import { watchStreamManager } from './watch-stream';

export async function deliverSessionWatchEvents(
  currentSessionId: string,
  payload: ReplyPayload,
  inboxMetas: readonly InboxTurnMeta[] = [],
): Promise<void> {
  // NEW: Notify continuous subscribers via watch stream
  const stream = watchStreamManager.getStream(currentSessionId);
  const isError = !!payload.error;
  const latestResult = buildReplyBody(payload);

  if (payload.turnId) {
    if (isError) {
      await stream.notifyTurnError(
        payload.turnId,
        payload.error?.code ?? 'unknown',
        payload.error?.message ?? 'Turn execution failed',
        false // TODO: determine if recoverable from error type
      );
    } else {
      await stream.notifyTurnCompleted(
        payload.turnId,
        latestResult,
        payload.terminalStatus === 'complete' ? 'success' : 'partial'
      );
    }
  }

  // LEGACY: Handle single-turn watches
  const watches = listPendingSessionWatches();
  // The turn owner coordinates one local notification before either delivery
  // can yield. Each network route keeps its own source-owned settlement.
  const replies = inboxMetas.filter(meta => meta.replyBack).map(meta => ({
    meta, delivery: deliverInboxReply(currentSessionId, meta, payload),
  }));
  const reply = Promise.all(replies.map(item => item.delivery));
  if (watches.length === 0) { await reply; return; }

  const managementPort = process.env.MYAGENTS_MANAGEMENT_PORT;
  if (!managementPort && watches.some(watch => !watch.networkReturn)) {
    for (const watch of watches) if (watch.networkReturn) ackPendingSessionWatch(watch.watchId);
    console.error('[session-watch] MYAGENTS_MANAGEMENT_PORT not set — cannot push watch events');
    await reply;
    return;
  }

  await Promise.all([reply, ...watches.map(async watch => {
    // A later queued turn cannot settle an observation of an earlier turn.
    if (watch.turnId && watch.turnId !== payload.turnId) return;
    if (watch.targetSessionId !== currentSessionId) {
      console.warn(
        `[session-watch] dropping watch ${watch.watchId}: target mismatch current=${currentSessionId} watch=${watch.targetSessionId}`,
      );
      ackPendingSessionWatch(watch.watchId);
      return;
    }

    const matchingReplies = replies.filter(item => !item.meta.networkReturn && !watch.networkReturn
      && payload.turnId && watch.turnId === payload.turnId && watch.watcherSessionId === item.meta.fromSessionId);
    if (matchingReplies.length > 0) {
      if ((await Promise.all(matchingReplies.map(item => item.delivery))).some(Boolean)) ackPendingSessionWatch(watch.watchId);
      return;
    }

    const eventId = randomUUID();
    const message: PendingInboxMessage = {
      messageId: eventId,
      fromSessionId: currentSessionId,
      fromLabel: watch.targetLabel,
      toSessionId: watch.watcherSessionId,
      text: latestResult,
      replyBack: false,
      timestampMs: Date.now(),
      kind: 'event',
      inReplyTo: null,
      sessionEvent: {
        version: 1,
        type: isError ? 'watch.error' : 'watch.completed',
        eventId,
        watchId: watch.watchId,
        sourceSessionId: currentSessionId,
        sourceLabel: watch.targetLabel,
        targetSessionId: watch.watcherSessionId,
        targetStateAtRegistration: watch.targetStateAtRegistration,
        finalState: isError ? 'error' : 'idle',
        terminalReason: payload.error?.code ?? 'completed',
        createdAt: new Date().toISOString(),
        latestResult,
        ...(payload.turnId ? { turnId: payload.turnId } : {}),
        ...(payload.terminalStatus ? { terminalStatus: payload.terminalStatus } : {}),
        resultSource: 'live',
        ...(payload.requestEventIds ? { requestEventIds: payload.requestEventIds } : {}),
      },
    };

    if (watch.networkReturn) {
      // Remote watches are one-shot even when the original source disappears.
      // Keeping them pending would replay a result after a later reconnection.
      try { await deliverNetworkReturn(watch.networkReturn, message.sessionEvent!); }
      finally { ackPendingSessionWatch(watch.watchId); }
      return;
    }

    try {
      const resp = await cancellableFetch(
        `http://127.0.0.1:${managementPort}/api/inbox/deliver`,
        {
          method: 'POST',
          headers: managementRequestHeaders(),
          body: JSON.stringify({
            message,
            resumeWorkspacePath: watch.watcherResumeWorkspacePath,
          }),
        },
        { timeoutMs: 30_000 },
      );
      if (!resp.ok) {
        const text = await resp.text().catch(() => '');
        console.warn(
          `[session-watch] management API ${resp.status} when pushing watch ${watch.watchId}: ${text.slice(0, 200)}`,
        );
        return;
      }
      const json = (await resp.json().catch(() => null)) as
        | { ok: boolean; outcome?: DeliverOutcome }
        | null;
      if (!json?.ok || json.outcome?.status !== 'delivered') {
        console.warn(
          `[session-watch] watch ${watch.watchId} not delivered: ${JSON.stringify(json?.outcome)}`,
        );
        return;
      }
      ackPendingSessionWatch(watch.watchId);
    } catch (err) {
      console.error('[session-watch] HTTP failure pushing watch event:', err);
    }
  })]);
}

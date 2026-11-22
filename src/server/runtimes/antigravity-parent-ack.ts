import {
  decodeAntigravityPlannerText,
  decodeAntigravityPlannerToolCalls,
  decodeAntigravitySystemMessage,
  openAntigravityConversation,
} from './antigravity-native-result';

interface ParentAcknowledgements {
  plannerStep: number;
  matchedReplies: number;
  acknowledgedReportIds: Set<string>;
}

export function readAntigravityParentTailStep(brainDirectory: string, nativeSessionId: string): number {
  const database = openAntigravityConversation(brainDirectory, nativeSessionId);
  if (!database) return -1;
  try {
    const idx = database.prepare('SELECT MAX(idx) AS idx FROM steps').get()?.idx;
    return typeof idx === 'number' ? idx : -1;
  } catch {
    return -1;
  } finally {
    database.close();
  }
}

/**
 * The inbox receipt can precede incorporation into the parent context. Match
 * settled ACP replies in native planner order and acknowledge the exact
 * messages the parent consumed before the matched reply.
 */
export function readAntigravityParentAcknowledgements(
  brainDirectory: string,
  nativeSessionId: string,
  settledReplies: readonly string[],
  reportIds: ReadonlySet<string>,
  previousPlannerStep = -1,
): ParentAcknowledgements {
  const previous: ParentAcknowledgements = {
    plannerStep: previousPlannerStep,
    matchedReplies: 0,
    acknowledgedReportIds: new Set(),
  };
  if (settledReplies.length === 0 && (previousPlannerStep < 0 || reportIds.size === 0)) return previous;

  const database = openAntigravityConversation(brainDirectory, nativeSessionId);
  if (!database) return previous;

  try {
    let plannerStep = previousPlannerStep;
    let matchedReplies = 0;
    if (settledReplies.length > 0) {
      const planner = database.prepare(`
        SELECT idx, step_payload FROM steps
        WHERE idx > ? AND step_type = 15 AND status = 3 ORDER BY idx
      `);
      for (const row of planner.iterate(previousPlannerStep)) {
        if (typeof row.idx !== 'number' || !(row.step_payload instanceof Uint8Array)) continue;
        const text = decodeAntigravityPlannerText(row.step_payload).text;
        if (!text) continue;
        // The live ACP stream adds one blank-line separator to unsolicited replies.
        const framedText = `\n\n${text}`;
        const replyIndex = settledReplies.findIndex((reply, index) =>
          index >= matchedReplies && (reply === text || reply === framedText));
        if (replyIndex < 0 || decodeAntigravityPlannerToolCalls(row.step_payload).length > 0) continue;
        plannerStep = row.idx;
        matchedReplies = replyIndex + 1;
        if (matchedReplies === settledReplies.length) break;
      }
    }

    const acknowledgedReportIds = new Set<string>();
    if (plannerStep >= 0 && reportIds.size > 0) {
      const messages = database.prepare(`
        SELECT step_payload FROM steps WHERE idx <= ? AND step_type = 101 AND status = 3
      `);
      for (const { step_payload: payload } of messages.iterate(plannerStep)) {
        if (!(payload instanceof Uint8Array)) continue;
        const message = decodeAntigravitySystemMessage(payload);
        if (message?.recipient === nativeSessionId && reportIds.has(message.id)) {
          acknowledgedReportIds.add(message.id);
          if (acknowledgedReportIds.size === reportIds.size) break;
        }
      }
    }
    return { plannerStep, matchedReplies, acknowledgedReportIds };
  } catch {
    // Retry on the next observation if the runtime is writing or its format changed.
    return previous;
  } finally {
    database.close();
  }
}

import { isLikelyErrorTitle } from './titleFilters';
import {
  FLOATING_BALL_CONTEXT_TAG,
  GOAL_CONTEXT_TAG,
  GOAL_CONTINUATION_TAG,
  parseLeadingSystemReminder,
} from './systemReminder';

/**
 * Canonical session-title derivation, shared by the sidecar (storage layer,
 * agent-session.ts / external-session.ts) and the renderer (display layer,
 * sessionDisplay.ts).
 *
 * WHY THIS IS SHARED (the bug it fixes):
 * The storage layer used to set a session's title to `rawMessage.slice(0, 40)`.
 * For a cron / heartbeat / system turn the first message is wrapped, e.g.
 *   `<system-reminder>\n<CRON_TASK>\n执行任务：请你帮 Ethan 查收今天的邮件…\n</CRON_TASK>\n</system-reminder>`
 * The wrapper alone (`<system-reminder>` + `<CRON_TASK>` + `执行任务：`) is ~35
 * chars, so a blind 40-char slice stored `…执行任务：请你帮 E...` — the real task
 * text was destroyed BEFORE it could be unwrapped. The renderer's stripper then
 * could only recover the scrap "请你帮 E...". Fix: strip the wrapper FIRST, then
 * truncate — and use the SAME stripper on both sides so they can't drift.
 */

/**
 * Remove MyAgents system wrappers from a raw message and recover the meaningful
 * title text. Handles `<system-reminder>` envelopes (even when truncated before
 * the closing tag), strips `<CRON_TASK>` / `<HEARTBEAT>` / `<MEMORY_UPDATE>`
 * markers, collapses whitespace, and extracts the `执行任务：<name>` task title
 * when present. Returns '' if nothing meaningful remains.
 */
export function stripSystemWrapper(raw: string): string {
  let text = (raw ?? '').trim();
  if (!text) return '';

  const reminder = parseLeadingSystemReminder(text);
  const isCronReminder = reminder.hasReminder && reminder.kind === 'CRON_TASK';
  if (reminder.hasReminder) {
    const isPureGoalReminder = !reminder.visibleText && (
      reminder.kind === GOAL_CONTINUATION_TAG
      || reminder.kind === GOAL_CONTEXT_TAG
    );
    if (isPureGoalReminder) return '';
    if (!reminder.visibleText && reminder.kind === FLOATING_BALL_CONTEXT_TAG) return '';
    text = reminder.visibleText || reminder.body;
  }

  // The `执行任务：<name>` extraction is a CRON-specific convention. Gate it on an
  // actual <CRON_TASK> marker so a normal user message that merely contains
  // "执行任务：" (e.g. "请解释这段日志：执行任务：#123 …") is NOT silently rewritten
  // to the regex capture. Mixed cron reminders keep <CRON_TASK> hidden in the
  // parsed reminder body and expose the task prompt as visibleText, so preserve
  // the reminder kind before replacing `text`. Run the regex on the PRE-collapse
  // text so the `\n` boundary in the char-class is honored (a multiline cron
  // prompt stops at the first line instead of bleeding the body into the title).
  if (isCronReminder || /<CRON_TASK>/.test(text)) {
    const taskTitle = text.match(/执行任务[:：]\s*#?\s*([^。；;\n]+)/);
    if (taskTitle?.[1]?.trim()) {
      return taskTitle[1].trim();
    }
  }

  return text
    .replace(/<\/?(?:CRON_TASK|HEARTBEAT|MEMORY_UPDATE)>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Truncate to `maxLen` CODE POINTS (not UTF-16 units), appending '...' only when
 * actually shortened. Spreading to code points means the cut never splits a
 * surrogate pair (an emoji straddling the cap would otherwise leave a lone
 * surrogate that renders as "�"). Shared by the storage cap (deriveSessionTitle)
 * and the renderer display cap so both are surrogate-safe. [adversarial-review #2]
 */
export function capWithEllipsis(str: string, maxLen: number): string {
  const codePoints = [...str];
  return codePoints.length > maxLen ? `${codePoints.slice(0, maxLen).join('')}...` : str;
}

/**
 * Derive a clean, length-capped session title from a raw first message.
 * Strips the system wrapper BEFORE truncating, so the cap applies to real
 * content. Returns '' when the message has no meaningful text (caller supplies
 * its own fallback, e.g. '图片消息' / 'New Chat').
 *
 * @param maxLen storage cap (default 40). The renderer applies its own (smaller)
 *               display cap on top, so this only bounds what we persist.
 */
export function deriveSessionTitle(rawMessage: string | null | undefined, maxLen = 40): string {
  const stripped = stripSystemWrapper(rawMessage ?? '');
  if (!stripped) return '';
  return capWithEllipsis(stripped, maxLen);
}

// ─────────────────────────────────────────────────────────────────────────────
// Auto-title generation: pure policy + round reconstruction (#296)
//
// These power the backend-owned Title Service (session-title-service.ts). They
// live in shared/ so they can be unit-tested as pure functions and so the
// renderer and sidecar can't drift on what counts as a titleable round.
// ─────────────────────────────────────────────────────────────────────────────

/** Minimum number of completed, titleable QA rounds before auto-title fires. */
export const AUTO_TITLE_MIN_ROUNDS = 1;

/**
 * Upper bound on a session's user-message count past which we stop *attempting*
 * auto-title. A session that has accrued this many user turns without ever
 * reaching {@link AUTO_TITLE_MIN_ROUNDS} titleable rounds is almost certainly
 * system-driven (IM/cron/heartbeat noise) — continuing to read its (growing)
 * transcript from disk every turn is wasted work. Cheap `stats.messageCount`
 * pre-filter; bounds the expensive disk read to a session's opening window.
 */
export const TITLE_GEN_MESSAGE_LIMIT = 20;

/**
 * Bounded retries: stop after this many *generation* attempts for one session.
 * Keep this above the historical 0.2.49 cap (5) so sessions that exhausted the
 * old, too-fragile title path get a post-upgrade retry window.
 */
export const MAX_TITLE_GEN_ATTEMPTS = 10;

export interface TitleRound {
  user: string;
  assistant: string;
}

/** Minimal message shape needed to reconstruct rounds — matches both the disk
 *  `SessionMessage` (content always string) and the renderer's in-memory form. */
export interface TitleRoundMessage {
  role: 'user' | 'assistant';
  content: string;
}

/** Keep enough of a long requirement to summarize its task, including a request
 * at the end of pasted context. Both reconstruction and generation use this
 * same bound so the generator cannot silently reduce it to a short prefix. */
export function boundTitleContext(text: string, maxChars = 2000): string {
  const chars = [...text];
  if (chars.length <= maxChars) return text;
  const marker = '\n[…]\n';
  const available = maxChars - marker.length;
  const head = Math.floor(available * 0.75);
  return chars.slice(0, head).join('') + marker + chars.slice(-(available - head)).join('');
}

/**
 * Extract the plain text of a persisted message. Disk assistant content may be a
 * JSON-stringified `ContentBlock[]` (see agent-session.ts persistence mapping) —
 * pull the `text` blocks out of it. User content (and plain-text assistant turns)
 * is stored as a raw string and passes through untouched. A user message that
 * merely *starts* with `[` (e.g. "[引用回复] …") is not valid JSON, so JSON.parse
 * throws and we fall back to the raw string.
 */
function extractMessageText(content: string): string {
  if (typeof content !== 'string') return '';
  const trimmed = content.trim();
  if (trimmed.startsWith('[') || trimmed.startsWith('{')) {
    try {
      const parsed = JSON.parse(trimmed) as unknown;
      if (Array.isArray(parsed)) {
        return parsed
          .filter((b): b is { type: string; text: string } =>
            !!b && typeof b === 'object' && (b as { type?: unknown }).type === 'text'
            && typeof (b as { text?: unknown }).text === 'string')
          .map(b => b.text)
          .join('');
      }
    } catch {
      // Not JSON — fall through to the raw string.
    }
  }
  return content;
}

/**
 * Reconstruct completed QA rounds (user → assistant pairs) from an ordered
 * message list, dropping the rounds that must never seed a title:
 *   - pure system-injected user turns (`<HEARTBEAT>` / `<MEMORY_UPDATE>` /
 *     `<system-reminder>` without a user-visible tail) — pure noise, not a
 *     user's real ask. Mixed reminder + user-query turns keep the query tail.
 *   - error-shaped assistant turns (`isLikelyErrorTitle`) — an upstream 4xx/5xx
 *     surfaced as assistant text would otherwise name the session after the error.
 *
 * This is the backend mirror of the renderer's loaded-history reconstruction.
 * It cannot use `shouldRecordTurnForTitle` (that needs the live SDK
 * `terminal_reason`, which is not persisted) — the error-text pattern match is
 * the disk-side equivalent gate.
 */
export function buildTitleRoundsFromMessages(
  messages: readonly TitleRoundMessage[],
  options?: { isUserTitleable?: (messageIndex: number) => boolean },
): TitleRound[] {
  const rounds: TitleRound[] = [];
  for (let i = 0; i < messages.length - 1; i++) {
    const msg = messages[i];
    const next = messages[i + 1];
    if (msg.role !== 'user' || next.role !== 'assistant') continue;
    if (options?.isUserTitleable && !options.isUserTitleable(i)) {
      i++;
      continue;
    }

    const rawUserText = extractMessageText(msg.content);
    const reminder = parseLeadingSystemReminder(rawUserText);
    const userText = reminder.hasReminder ? reminder.visibleText : rawUserText;
    if (rawUserText.includes('<HEARTBEAT>')
      || rawUserText.includes('<MEMORY_UPDATE>')
      || (reminder.hasReminder && !reminder.visibleText)) {
      i++; // consume the paired assistant turn too
      continue;
    }
    const assistantText = extractMessageText(next.content);
    if (isLikelyErrorTitle(assistantText)) {
      i++;
      continue;
    }
    rounds.push({
      user: boundTitleContext(userText),
      assistant: boundTitleContext(assistantText, 500),
    });
    i++; // skip the assistant message we just paired
  }
  return rounds;
}

/**
 * Pure policy: should we attempt auto-title generation for a session right now?
 * Cheap signals only (no disk read) so the caller can short-circuit before
 * loading the transcript. The expensive round count is checked separately, after
 * this passes.
 */
export function shouldAttemptAutoTitle(input: {
  titleSource?: 'default' | 'auto' | 'user';
  titleGenAttempts?: number;
  userMessageCount: number;
}): boolean {
  // 'auto' = already AI-titled; 'user' = manually renamed — both are final.
  if (input.titleSource === 'auto' || input.titleSource === 'user') return false;
  if ((input.titleGenAttempts ?? 0) >= MAX_TITLE_GEN_ATTEMPTS) return false;
  // messageCount counts ALL user turns (incl. system) ≥ titleable rounds, so it's
  // a valid cheap lower bound; the upper bound caps wasted disk reads.
  if (input.userMessageCount < AUTO_TITLE_MIN_ROUNDS) return false;
  if (input.userMessageCount > TITLE_GEN_MESSAGE_LIMIT) return false;
  return true;
}

/**
 * Cap a generated title to `maxLen` code points, but back off a mid-word cut.
 * Pure code-point slice (`capWithEllipsis` without the ellipsis) severs Latin
 * words ("…SSE 流式调" → "…SSE 流") and reads as broken. When the cut would land
 * inside a run of ASCII word characters, retreat to the last whitespace — as long
 * as that keeps at least a third of the budget (so a clean word boundary wins, but
 * a single over-long word with no usable whitespace just hard-cuts rather than
 * shrinking to almost nothing). Pure CJK (no whitespace) is cut as-is since each
 * glyph is its own word. No ellipsis: a title is a label, not a snippet.
 */
export function capTitleAtBoundary(str: string, maxLen: number): string {
  const cp = [...str];
  if (cp.length <= maxLen) return str;
  let end = maxLen;
  const cutsMidWord = /\w/.test(cp[maxLen - 1] ?? '') && /\w/.test(cp[maxLen] ?? '');
  if (cutsMidWord) {
    let i = maxLen - 1;
    while (i > 0 && !/\s/.test(cp[i])) i--;
    if (i >= Math.ceil(maxLen / 3)) end = i;
  }
  return cp.slice(0, end).join('').trimEnd();
}

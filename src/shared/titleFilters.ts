/**
 * titleFilters — error-shaped text patterns to reject as session titles.
 *
 * Defense-in-depth backstop for #245. The primary fix is the renderer-side
 * `shouldRecordTurnForTitle` gate (terminalReason.ts) which discards rounds
 * where the SDK reported a non-completed terminal_reason. That handles the
 * reported flow. This module covers two adjacent leaks:
 *
 *   1. Title-gen LLM echoes the input verbatim when fed garbage rounds (e.g.
 *      a max_turns turn whose only assistant content was an error message).
 *   2. The title-gen call itself hits the same upstream 4xx/5xx — SDK
 *      surfaces the error string as the title-gen assistant response and
 *      cleanTitle accepts it.
 *
 * Patterns are anchored at start-of-trimmed-string and case-insensitive.
 * Keep this list tight — false positives turn legitimate user titles into
 * "新对话". Each entry MUST trace back to a real production-observed surface
 * (see comments alongside).
 */

const ERROR_TITLE_PATTERNS: readonly RegExp[] = [
  /^API Error:/i,                          // SDK 4xx/5xx surface (#245 reporter logs)
  /^\[Error\]:/i,                          // openai-bridge stream-responses.ts:195
  /^Claude Code returned an error/i,       // CC native CLI surface seen in title outputs
  /^No message found with message\.uuid/i, // SDK rewind/fork no-such-message error
  /^Not logged in\s*[·:—-]?\s*Please run\s+\/login/i, // CLI OAuth surface observed in TITLE-001 real utility smoke
];

export function isLikelyErrorTitle(text: string): boolean {
  if (typeof text !== 'string') return false;
  const trimmed = text.trim();
  if (!trimmed) return false;
  return ERROR_TITLE_PATTERNS.some(rx => rx.test(trimmed));
}

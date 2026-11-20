/**
 * AskUserQuestion types - shared between frontend and backend
 * Based on SDK's AskUserQuestionInput structure
 */

export interface AskUserQuestionOption {
  label: string;
  description: string;
  /** Optional preview content rendered when this option is focused (HTML or Markdown) */
  preview?: string;
}

export interface AskUserQuestion {
  /** Runtime-native question id. Omitted by older builtin callers, present for Codex app-server. */
  id?: string;
  question: string;
  header: string;
  options: AskUserQuestionOption[];
  multiSelect: boolean;
  /** False for closed native enums. Older question producers accept free text. */
  allowCustom?: boolean;
  /** Optional fields can be skipped by the user. Omitted means required for legacy callers. */
  required?: boolean;
  /** Render custom text input as password/secret input. */
  isSecret?: boolean;
}

export interface AskUserQuestionInput {
  questions: AskUserQuestion[];
  answers?: Record<string, string>;
  metadata?: { source?: string };
}

/** Desktop answers preserve option labels and free text separately. Strings remain accepted from legacy/CLI callers. */
export interface AskUserQuestionAnswer {
  selected: string[];
  custom?: string;
}
export type AskUserQuestionAnswers = Record<string, string | AskUserQuestionAnswer>;

/** Projection for runtimes whose question tool accepts only display text. */
export function questionAnswersAsText(answers: AskUserQuestionAnswers): Record<string, string> {
  return Object.fromEntries(Object.entries(answers).map(([id, answer]) => [id,
    typeof answer === 'string' ? answer : [...answer.selected, ...(answer.custom ? [answer.custom] : [])].join(','),
  ]));
}

/**
 * Re-key AskUserQuestion answers by question text for the SDK-binary contract.
 *
 * SDK 0.3.158's builtin `AskUserQuestion` tool — and the Claude Code CLI, which
 * is the same native binary — builds its tool_result by looking each answer up
 * under the question's TEXT:
 *
 *     questions.map(({ question }) => answers[question])   // answers[question.text]
 *
 * A missing key makes that question read back as unanswered, and when none
 * match the model is told "The user did not answer the questions." Our renderer
 * (AskUserQuestionPrompt) keys answers by `question.id ?? String(idx)` — the
 * neutral wire format the Codex runtime (codex.ts) consumes by id/index. So a
 * builtin/CC question (which has no id) arrives keyed by "0","1",… and never
 * matches the text lookup.
 *
 * This returns a SUPERSET: the original keys, plus a question-text alias for
 * every answered question. The SDK binary finds the text alias; Codex still
 * finds its id/index keys (it reads `answers[id] ?? answers[String(idx)]`), so
 * the one payload satisfies both contracts and Codex is left untouched.
 *
 * Regression context: the 0.2.119→0.3.158 upgrade switched the builtin tool's
 * lookup from numeric index to question text, so every index-keyed answer
 * silently became "did not answer".
 */
export function withQuestionTextAnswerKeys(
  questions: AskUserQuestion[] | undefined,
  answers: Record<string, string>,
): Record<string, string> {
  if (!Array.isArray(questions)) return answers;
  const merged: Record<string, string> = { ...answers };
  questions.forEach((q, idx) => {
    const text = q?.question;
    if (typeof text !== 'string' || text.length === 0) return;
    // Already keyed by text (renderer change / idempotent re-run) — keep as-is.
    if (text in merged) return;
    const value = answers[q?.id ?? String(idx)]
      ?? answers[String(idx)]
      ?? (q?.id != null ? answers[q.id] : undefined);
    if (value !== undefined) merged[text] = value;
  });
  return merged;
}

/**
 * Request sent to frontend for user interaction
 */
export interface AskUserQuestionRequest {
  requestId: string;
  /** Owning MyAgents session id; absent only for legacy/replayed payloads. */
  sessionId?: string | null;
  questions: AskUserQuestion[];
  /** Content format for option previews: 'html' or 'markdown' */
  previewFormat?: 'html' | 'markdown';
}

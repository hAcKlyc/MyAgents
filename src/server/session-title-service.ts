/**
 * session-title-service.ts — backend-owned auto session titling (#296).
 *
 * This is the SINGLE authority that decides when a session gets an AI-generated
 * title and applies it. It replaces the former frontend-driven trigger in
 * TabProvider, which only covered open Chat tabs and was lost on tab close /
 * refresh. Living in the sidecar, it fires for every owner uniformly (Chat / IM
 * / Cron / background) off the post-turn-success hook in both runtime paths
 * (agent-session.ts builtin, external-session.ts external).
 *
 * Contract (red-lines from the #296 design baseline):
 *   - Title generation MUST NOT block the turn — callers invoke
 *     `maybeGenerateTitleAfterTurn` fire-and-forget (`void import(...).then(...)`).
 *   - A failure MUST NOT affect the main session — every path here swallows its
 *     own errors and degrades to "no title" (the on-disk default truncation stays).
 *   - It MUST NOT overwrite a user-renamed title (`titleSource === 'user'`), checked
 *     both before generation and again right before the write (TOCTOU).
 *
 * The decision policy and round reconstruction are pure functions in
 * `shared/sessionTitle.ts` (unit-tested); this module is the imperative shell:
 * read metadata/transcript, resolve runtime/model, call the generator, persist,
 * broadcast.
 */

import type { RuntimeType } from '../shared/types/runtime';
import type { ProviderEnv } from './provider-types';
import { getSessionData, getSessionMetadata, updateSessionMetadata } from './SessionStore';
import { broadcast } from './sse';
import { setPostTurnTitleHook } from './turn-hooks';
import {
  buildTitleRoundsFromMessages,
  shouldAttemptAutoTitle,
  AUTO_TITLE_MIN_ROUNDS,
  type TitleRound,
} from '../shared/sessionTitle';
import { isHumanUserMessage } from './utils/session-message-preview';

/** Cap the rounds fed to title-gen — keep the prompt small + bounded cost. The
 *  most RECENT rounds carry the conversation's settled topic, so take the tail. */
const MAX_TITLE_ROUNDS = 10;

/** In-process guard: a session is titled only on its own (1:1) sidecar, and turns
 *  are serial, but the trigger is async/fire-and-forget — so turn N's generation
 *  can still be in flight when turn N+1 completes. This prevents a concurrent
 *  second generation for the same session (double cost + racey writes). */
const inFlight = new Set<string>();

/**
 * Generate a title for `rounds` using the session's runtime, then persist +
 * broadcast it. Shared by the auto path ({@link maybeGenerateTitleAfterTurn})
 * and the manual `/api/generate-session-title` endpoint. Returns the applied
 * title, or null on any failure / skip (silent — caller keeps the default title).
 */
export async function generateAndApplyTitle(
  sessionId: string,
  rounds: TitleRound[],
  runtime: RuntimeType,
  model: string | undefined,
  providerEnv: ProviderEnv | undefined,
  agentDir: string,
): Promise<string | null> {
  // ACP supplies the title of the actual conversation. Never start a second
  // tool-capable conversation to title the first one.
  if (runtime === 'antigravity') return getSessionMetadata(sessionId)?.title ?? null;
  const { generateTitle, generateTitleExternal } = await import('./title-generator');
  let title: string | null;
  if (runtime === 'builtin') {
    // builtin needs providerEnv (third-party / OpenAI-bridge auth); generateTitle
    // applies applyContextWindowSuffix itself, so `model` must be the RAW id.
    title = await generateTitle(rounds, model || '', providerEnv, sessionId);
  } else {
    // External runtimes own their auth. Preserve the Session's persisted
    // runtimeSource so a Managed Codex conversation cannot silently fall back
    // to the user's system CLI (and inherit ~/.codex MCP/config) for titling.
    const runtimeSource = getSessionMetadata(sessionId)?.runtimeSource;
    title = await generateTitleExternal(rounds, runtime, model || '', agentDir, runtimeSource);
  }
  if (!title) return null;
  return applyRuntimeTitle(sessionId, title);
}

export async function applyRuntimeTitle(sessionId: string, title: string): Promise<string | null> {
  if (!title.trim()) return null;

  // TOCTOU close (review #3): a user rename may have landed during the
  // (multi-second) LLM call. A plain read-then-write still races — the rename
  // could land between this read and the write acquiring the lock — so the
  // titleSource check is ALSO enforced inside updateSessionMetadata's lock via
  // the precondition. The cheap read here just skips a doomed write early.
  const fresh = getSessionMetadata(sessionId);
  if (!fresh || fresh.titleSource === 'user') return null;

  const applied = await updateSessionMetadata(
    sessionId,
    { title, titleSource: 'auto' },
    (current) => current.titleSource !== 'user',
  );
  if (!applied) return null; // user renamed inside the window — leave it.
  // Renderer consumes this to update the tab header + refresh session-list
  // surfaces. Scoped naturally: the broadcast reaches only this session's
  // sidecar SSE connection (Tab-scoped isolation).
  broadcast('chat:session-title-changed', { sessionId, title, titleSource: 'auto' });
  return title;
}

/**
 * Post-turn-success hook. Called fire-and-forget from both runtime paths after a
 * turn the runtime reported as successful. Decides (pure policy) whether to
 * title this session now, reconstructs rounds from the persisted transcript, and
 * — if there are enough — generates + applies the title. All failures swallowed.
 *
 * @param sessionId   session whose turn just completed
 * @param runtime     runtime that ran the turn ('builtin' | 'claude-code' | …)
 * @param model       RAW (un-suffixed) model id the turn used, or undefined
 * @param providerEnv live provider env (builtin only; external uses CLI auth)
 */
export async function maybeGenerateTitleAfterTurn(
  sessionId: string,
  runtime: RuntimeType,
  model: string | undefined,
  providerEnv?: ProviderEnv,
): Promise<void> {
  if (runtime === 'antigravity' || !sessionId || inFlight.has(sessionId)) return;
  inFlight.add(sessionId);
  try {
    const meta = getSessionMetadata(sessionId);
    if (!meta) return;

    // Cheap pre-filter (no disk read): titleSource final? attempts exhausted?
    // user-message count inside the [min, max] window?
    if (!shouldAttemptAutoTitle({
      titleSource: meta.titleSource,
      titleGenAttempts: meta.titleGenAttempts,
      userMessageCount: meta.stats?.messageCount ?? 0,
    })) return;

    // Expensive step, now justified: read the transcript and reconstruct rounds.
    const data = (await getSessionData(sessionId));
    if (!data) return;
    const rounds = buildTitleRoundsFromMessages(data.messages, {
      isUserTitleable: index => isHumanUserMessage(data.messages[index], meta.origin),
    });
    if (rounds.length < AUTO_TITLE_MIN_ROUNDS) return; // self-heals on a later turn

    // Record the attempt BEFORE generating: a crash / restart mid-call must not
    // let this session retry forever. The bounded counter caps total tries.
    await updateSessionMetadata(sessionId, { titleGenAttempts: (meta.titleGenAttempts ?? 0) + 1 });

    await generateAndApplyTitle(
      sessionId,
      rounds.slice(-MAX_TITLE_ROUNDS),
      runtime,
      model,
      providerEnv,
      meta.agentDir,
    );
  } catch (err) {
    console.warn(`[title] post-turn title generation failed for ${sessionId}:`, err);
  } finally {
    inFlight.delete(sessionId);
  }
}

/**
 * Install the auto-title trigger into the `turn-hooks` slot. Called once at
 * sidecar boot (index.ts) so both runtime paths can fire titling without
 * importing this module (dependency inversion — see turn-hooks.ts). The hook
 * itself is fire-and-forget; `maybeGenerateTitleAfterTurn` owns all error
 * handling, so the runtime path never awaits or sees a rejection.
 */
export function installAutoTitleHook(): void {
  setPostTurnTitleHook((sessionId, runtime, model, providerEnv) => {
    void maybeGenerateTitleAfterTurn(sessionId, runtime, model, providerEnv);
  });
}

/**
 * Pure resolvers for "which option value do we actually use" decisions that
 * are otherwise buried in giant components (Chat.tsx / Launcher.tsx). Extracted
 * as a Functional Core so the precedence rules can be unit-tested without
 * standing up React.
 */
import type { PermissionMode } from '@/config/types';

/**
 * #244 — permission mode for a builtin-runtime send/display.
 *
 * The `permissionMode` React state is seeded by a useState initializer that
 * runs while useConfig() is still loading (currentAgent/currentProject
 * undefined → 'auto' fallback). The one-time project-sync effect that corrects
 * it fires only AFTER first paint, so on a fresh tab a user can send before it
 * runs and ship the stale 'auto' instead of the workspace's configured mode.
 *
 * Until that sync has happened (`projectSynced=false`), resolve from config
 * directly: agent → project → global default. Once synced (or the user has
 * toggled the control, which also flips the flag), `statePermissionMode` is
 * authoritative — it already folds in user toggles and session snapshots.
 */
export function resolveBuiltinPermissionMode(args: {
  projectSynced: boolean;
  statePermissionMode: PermissionMode;
  agentPermissionMode?: string | null;
  projectPermissionMode?: string | null;
  defaultPermissionMode?: string | null;
}): PermissionMode {
  if (args.projectSynced) return args.statePermissionMode;
  return (
    (args.agentPermissionMode as PermissionMode | undefined) ??
    (args.projectPermissionMode as PermissionMode | undefined) ??
    (args.defaultPermissionMode as PermissionMode | undefined) ??
    args.statePermissionMode
  );
}

/**
 * #234 — provider/model the launcher should use for a NEW session.
 *
 * `launcherLastUsed` is a global, workspace-agnostic snapshot of the last
 * provider/model the user explicitly picked from the launcher. The launcher
 * restored it verbatim on mount, so after the user changed an Agent's default
 * provider in Settings (e.g. MiniMax → DeepSeek) the launcher kept opening
 * sessions on the stale MiniMax provider → request timeouts.
 *
 * Rule: `launcherLastUsed` is only trustworthy when it is consistent with the
 * selected agent/workspace's current default provider. If the agent has a
 * configured provider and it differs from the cached one, the agent default
 * wins (and the stale model is dropped with it — a model from another provider
 * is meaningless). When they agree, the cached model is kept (lets the user's
 * explicit model choice survive). Falls back through workspace → global.
 */
export function resolveLauncherProvider(args: {
  lastUsedProviderId?: string | null;
  lastUsedModel?: string | null;
  agentProviderId?: string | null;
  agentModel?: string | null;
  workspaceProviderId?: string | null;
  workspaceModel?: string | null;
  defaultProviderId?: string | null;
}): { providerId: string | undefined; model: string | undefined } {
  const agentProvider = args.agentProviderId ?? undefined;
  const cachedProvider = args.lastUsedProviderId ?? undefined;

  // The cached provider is honored only when it still matches the agent's
  // current default (or the agent has no explicit provider). Otherwise the
  // Settings change is newer than the cache → agent default wins.
  const cacheConsistent =
    !!cachedProvider && (!agentProvider || cachedProvider === agentProvider);

  if (cacheConsistent) {
    return {
      providerId: cachedProvider,
      model: args.lastUsedModel ?? args.agentModel ?? args.workspaceModel ?? undefined,
    };
  }

  const providerId =
    agentProvider ??
    args.workspaceProviderId ??
    cachedProvider ??
    args.defaultProviderId ??
    undefined;

  // Keep the cached model only if it belonged to the provider we're now using.
  const model =
    providerId === cachedProvider
      ? args.lastUsedModel ?? undefined
      : args.agentModel ?? args.workspaceModel ?? undefined;

  return { providerId: providerId ?? undefined, model };
}

/**
 * #235 — should the degraded-load fallback actually fire when its timer
 * elapses? The tab's SSE never (re)attached within the grace window, so we
 * want to load the session over HTTP — but only if the world hasn't moved on
 * while we waited. Pure so the bail conditions are unit-testable; the timer
 * plumbing stays in TabProvider.
 */
export function shouldDegradedLoad(args: {
  mounted: boolean;
  currentSessionId: string | null;
  target: string;
  connectedSseSessionId: string | null;
  alreadyLoaded: boolean;
  prevSessionId: string | null | undefined;
  /**
   * Session is mid-turn (system-init seen or chunks streaming). Mirrors the
   * unified session-load effect's "Do NOT call loadSession while AI is
   * responding" guard — refetching would clobber the live history (the
   * backend turn itself survives, since loadSession is read-only and a
   * same-session switch short-circuits, but the UI would flash). Keep the
   * invariant in one place rather than relying on that server-side mercy.
   */
  sessionActiveOrStreaming: boolean;
  /**
   * Explicit history switches are allowed to load even when the previous
   * session left a stale "active" ref behind. Without this, the fallback can
   * preserve the same split-brain as the primary load gate: the tab points at
   * the target session but visible/server state still belongs to the old one.
   */
  allowWhileActive?: boolean;
}): boolean {
  if (!args.mounted) return false;
  if (args.currentSessionId !== args.target) return false; // session switched away
  if (args.connectedSseSessionId === args.target) return false; // SSE attached after all
  if (args.alreadyLoaded && args.prevSessionId === args.target) return false; // already loaded
  if (args.sessionActiveOrStreaming && !args.allowWhileActive) return false; // don't reload mid-turn
  return true;
}

/**
 * True only for the backend-minted session that belongs to an explicit "new
 * chat" reset/adoption. This remains true even after sendMessage clears
 * `isNewSessionRef` before the backend emits system-init, so the first live
 * turn after reset is still treated as a birth rather than a history switch.
 */
export function isResetSessionBirth(args: {
  resetBirthSessionId: string | null;
  sessionId: string | null | undefined;
}): boolean {
  return Boolean(args.sessionId && args.resetBirthSessionId === args.sessionId);
}

/**
 * A real persisted-session switch must run loadSession, even if the renderer
 * still thinks the previous session is active. Pending->real and reset-birth
 * transitions are the live sidecar becoming durable; persisted real->real is a
 * user/history switch and needs /sessions/switch to rebind the sidecar state.
 */
export function isExistingSessionSwitch(args: {
  sessionChanged: boolean;
  wasPendingSession: boolean;
  isPendingSession: boolean;
  isResetSessionBirth: boolean;
}): boolean {
  return args.sessionChanged
    && !args.wasPendingSession
    && !args.isPendingSession
    && !args.isResetSessionBirth;
}

/**
 * #294 — rapid history clicks can leave several async handleSwitchSession
 * flows in flight for the same tab. Only the latest requested target may
 * commit tab state; older completions must be ignored.
 */
export function shouldCommitSessionSwitch(args: {
  requestedToken: number;
  latestToken: number | undefined;
  requestedSessionId: string;
  latestSessionId: string | undefined;
  tabStillPresent: boolean;
}): boolean {
  return args.tabStillPresent
    && args.latestToken === args.requestedToken
    && args.latestSessionId === args.requestedSessionId;
}

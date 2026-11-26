// Shared environment utilities for external runtime subprocesses (v0.1.60)

import { accessSync, constants, statSync } from 'node:fs';
import { delimiter, resolve } from 'node:path';

import type { ExternalRuntimeId } from '../../shared/integrated-runtimes/identity';
import { PROXY_ENV_KEYS } from '../../shared/proxyScope';
import { getRuntimeProxyEnvironment } from '../proxy-state';
import type { RuntimeEnvPolicy } from '../../shared/types/runtime';
import { getShellEnv, getDetectedTerminalProxyEnv } from '../utils/shell';

/**
 * Lightweight PATH-based command lookup, used by external-runtime adapters.
 *
 * On Windows, honours PATHEXT (.EXE, .CMD, .BAT, etc.) so .cmd shims from
 * npm-global installs are found. Absolute paths bypass PATH and are verified
 * via `statSync` directly.
 */
function which(command: string, pathStr: string): string | null {
  if (!pathStr) return null;
  const exts = process.platform === 'win32'
    ? (process.env.PATHEXT ?? '.EXE;.CMD;.BAT;.COM').split(';').map((e) => e.toLowerCase())
    : [''];
  // Absolute path bypass: if caller passed an absolute executable, just verify it.
  if (command.includes('/') || (process.platform === 'win32' && command.includes('\\'))) {
    try {
      if (statSync(command).isFile()) {
        if (process.platform !== 'win32') accessSync(command, constants.X_OK);
        return command;
      }
    } catch { /* not found */ }
    return null;
  }
  for (const dir of pathStr.split(delimiter)) {
    if (!dir) continue;
    for (const ext of exts) {
      const candidate = resolve(dir, command + ext);
      try {
        if (statSync(candidate).isFile()) {
          if (process.platform !== 'win32') accessSync(candidate, constants.X_OK);
          return candidate;
        }
      } catch { /* skip */ }
    }
  }
  return null;
}



/**
 * Build an augmented env for spawning external CLI runtimes (claude, codex).
 *
 * Delegates to getShellEnv() which already handles:
 * - Windows: system PATH + npm global (%APPDATA%\npm), Git, Bun, Node.js
 * - macOS: shell -l PATH detection + homebrew, NVM, pnpm, Bun
 * - PATH key normalization (Windows Path vs Unix PATH)
 *
 * Previously this function had its own hardcoded Unix-only PATH augmentation,
 * which missed Windows paths like %APPDATA%\npm → "Executable not found". See: #70
 *
 * Workspace proxy policy:
 *  - `myagents` (default): apply this system CLI's proxy scope to its environment.
 *  - `terminal`: replace the inherited proxy vars with whatever the user's
 *    interactive shell exports (detected during shell.ts warmup). If warmup
 *    found nothing, all proxy vars are stripped — that's terminal parity for
 *    users who don't export proxies in their rc, which also serves the
 *    Clash-TUN / VPN case (system-level routing handles networking, no
 *    application proxy needed).
 *
 * 0.2.16 dev briefly shipped a third `'direct'` literal that unconditionally
 * stripped all proxy vars. Removed before release — `terminal` covers the
 * same TUN/VPN case for users whose shell has no proxy set. Existing disk
 * `'direct'` values fall through validation and default to `'myagents'`.
 */
export function augmentedProcessEnv(
  runtime: ExternalRuntimeId,
  policy?: RuntimeEnvPolicy,
): Record<string, string | undefined> {
  const env = getShellEnv();

  if (policy?.proxy !== 'terminal') return getRuntimeProxyEnvironment(runtime, env);

  for (const key of PROXY_ENV_KEYS) delete env[key];
  delete env.MYAGENTS_PROXY_INJECTED;

  const detected = getDetectedTerminalProxyEnv();
  if (detected) {
    for (const [k, v] of Object.entries(detected)) {
      // Skip empty values — those mean "user has the var unset". The strip
      // above already removed inherited values, so leaving them out is the
      // correct terminal-parity outcome (and also serves Clash-TUN / VPN
      // users whose shell typically has no proxy set).
      if (v && v.length > 0) {
        env[k] = v;
      }
    }
  }
  // External-runtime entry points await ensureShellPath before building env,
  // including the first model query before startup warmup has finished.

  return env;
}

/**
 * Read `agent.runtimeConfig.envPolicy` from disk for a workspace, validate the
 * `proxy` literal against the explicit allowlist, and return a clean
 * `RuntimeEnvPolicy` (or `undefined` when nothing is set).
 *
 * Validation is mandatory at every entry point that reaches `augmentedProcessEnv`
 * via this disk source — without it, a malformed `proxy: 'inherit'` typo would
 * propagate to the diagnostic surface as if it were valid, and the user has no
 * way to discover the misconfiguration. `augmentedProcessEnv` itself does
 * defense-in-depth (unknown → `myagents`), so behaviour stays safe, but the
 * visible mismatch is confusing.
 *
 * Best-effort: any error reading config is swallowed and returns `undefined`,
 * so the caller path can't break on a malformed `agent.json`.
 *
 * Used by `external-session.ts` (live session start) and `admin-api.ts`
 * (CLI `runtime diagnose` handler) — keep them in lockstep by funnelling
 * through this one helper.
 */
export async function resolveAgentEnvPolicy(
  workspacePath: string,
): Promise<RuntimeEnvPolicy | undefined> {
  try {
    const { findProjectAgentByWorkspacePath } = await import('../utils/admin-config');
    const agent = findProjectAgentByWorkspacePath(workspacePath);
    const raw = (agent?.runtimeConfig as Record<string, unknown> | undefined)?.envPolicy;
    if (!raw || typeof raw !== 'object') return undefined;
    const policyObj = raw as Record<string, unknown>;
    const proxyRaw = policyObj.proxy;
    const proxy: 'myagents' | 'terminal' | undefined =
      proxyRaw === 'myagents' || proxyRaw === 'terminal'
        ? proxyRaw
        : undefined;
    if (proxyRaw !== undefined && proxy === undefined) {
      // Covers legacy `'direct'` from 0.2.16 dev (removed before release) and
      // any other malformed value (`'inherit'` typo, `true` from wrong UI
      // wire). Silent fallback to the safe default — UI will re-render
      // showing `'MyAgents 代理'` selected and user can pick `'terminal'` if
      // they previously relied on stripping proxy.
      console.warn(
        `[env-utils] Ignoring unsupported envPolicy.proxy=${JSON.stringify(proxyRaw)} for ${workspacePath} — defaulting to 'myagents'`,
      );
    }
    return { proxy };
  } catch (err) {
    console.warn(
      `[env-utils] resolveAgentEnvPolicy(${workspacePath}) failed:`,
      err instanceof Error ? err.message : String(err),
    );
    return undefined;
  }
}

/**
 * Resolve an external CLI command to its full executable path.
 *
 * Callers pass the same environment they will give to spawn, after awaiting
 * ensureShellPath. Detection and execution therefore select the same CLI.
 *
 * Why this is needed everywhere (not just Windows):
 * - Windows: npm global installs create `.cmd` wrappers; `spawn()` via libuv
 *   doesn't resolve PATH extensions (.CMD/.BAT) → ENOENT. See: #70
 * - macOS/Linux: `spawn()` uses posix_spawnp which searches the CALLER's PATH,
 *   not the env passed to the child. GUI apps (Tauri/Finder) have minimal PATH
 *   that lacks NVM/fnm/volta/asdf paths. Even though augmentedProcessEnv() builds
 *   a correct PATH, the bare command name won't be found by posix_spawnp.
 *   Pre-resolving to a full path bypasses PATH lookup entirely.
 */
export function resolveCommand(command: string, env: Record<string, string | undefined>): string {
  const path = process.platform === 'win32' ? env.Path ?? env.PATH ?? '' : env.PATH ?? '';
  const resolved = which(command, path);
  if (resolved) return resolved;
  // Fallback: return as-is and let spawn fail with a clear error
  return command;
}

// eslint-disable-next-line no-control-regex -- Intentional ANSI escape code stripping for log output
const ANSI_RE = /\x1b\[[0-9;]*m/g;

/**
 * Strip ANSI terminal escape codes (color/style) from a string.
 * External CLI tools (codex, claude) emit colored stderr — raw ANSI codes
 * appear as garbage like `[2m`, `[31m` in unified log files.
 */
export function stripAnsi(text: string): string {
  return text.replace(ANSI_RE, '');
}

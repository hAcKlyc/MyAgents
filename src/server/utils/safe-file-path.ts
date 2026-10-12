import { APP_DATA_DIR_NAME } from '../../shared/appProfile';
/**
 * Safe file path guard for capabilities that forward AI-supplied paths to
 * filesystem readers (e.g. IM media sending, PDF ingestion, etc.).
 *
 * Why this exists
 * ---------------
 * `im send-media` and friends read a file off disk and ship it to a remote
 * destination (an IM chat). If the `filePath` argument is taken directly from
 * AI output, a prompt-injected AI can be steered into reading arbitrary
 * absolute paths — `~/.ssh/id_rsa`, `~/.aws/credentials`, other users' session
 * history — and exfiltrating them. v0.1.67 widened this surface by exposing
 * the same capability through a plain shell CLI that any external runtime's
 * shell tool can invoke, so we harden all call sites at once instead of only
 * the new entry point.
 *
 * What is allowed
 * ---------------
 * An allowlist of roots, each independently resolved and canonicalised:
 *   - current workspace (AI's own workspace directory)
 *   - `~/.myagents/tmp` (scratch space, where AI writes intermediate files)
 *   - platform temp dir (/tmp on Unix, %TEMP% on Windows)
 *
 * A path is accepted iff, after `fs.realpathSync` resolution (dereferencing
 * symlinks), it sits under one of the allowlist roots. Symlinks pointing
 * outside the allowlist are rejected — that's the whole point of realpath.
 *
 * Callers receive either the canonicalised absolute path (safe to hand off)
 * or an `Error` describing why the path was rejected. Never a silent pass.
 */

import { realpathSync, existsSync } from 'fs';
import { resolve, sep } from 'path';
import { tmpdir } from 'os';
import { getHomeDirOrNull } from './platform';

export interface SafeFilePathOptions {
  /** Workspace directory — AI's own project root. Required. */
  workspacePath: string;
  /**
   * Additional allowed roots. Defaults to `~/.myagents/tmp` and the platform
   * temp dir. Pass `[]` to restrict strictly to the workspace.
   */
  extraRoots?: string[];
}

/**
 * Validate that `filePath` points at a real file under one of the allowed
 * roots. Returns the canonicalised absolute path on success, throws on reject.
 *
 * The returned path is safe to feed into downstream readers: it has been
 * resolved against symlinks and verified to stay inside the allowlist.
 */
export function assertSafeFilePath(filePath: string, options: SafeFilePathOptions): string {
  if (!filePath || typeof filePath !== 'string') {
    throw new Error('filePath is required');
  }

  // Expand ~ before anything else — realpathSync won't do it for us.
  const home = getHomeDirOrNull();
  let expanded = filePath;
  if (home && (expanded === '~' || expanded.startsWith('~/') || expanded.startsWith('~\\'))) {
    expanded = home + expanded.slice(1);
  }

  const absolute = resolve(expanded);
  if (!existsSync(absolute)) {
    throw new Error(`file not found: ${filePath}`);
  }

  // realpathSync dereferences symlinks, so we see where the path *actually*
  // resolves to. Without this, `~/.myagents/tmp/link → /etc/shadow` slips
  // through a naive startsWith check.
  let realPath: string;
  try {
    realPath = realpathSync(absolute);
  } catch (err) {
    throw new Error(`failed to resolve path: ${err instanceof Error ? err.message : String(err)}`);
  }

  // Build allowlist — each root also goes through realpathSync so that e.g.
  // /tmp → /private/tmp symlinks on macOS don't cause false rejections.
  const roots: string[] = [];
  try { roots.push(realpathSync(resolve(options.workspacePath))); }
  catch { /* workspace root must exist; if not, we'll reject below */ }

  const extra = options.extraRoots ?? defaultExtraRoots(home);
  for (const r of extra) {
    try { if (existsSync(r)) roots.push(realpathSync(r)); }
    catch { /* skip unresolvable roots — they simply aren't allowed */ }
  }

  if (roots.length === 0) {
    throw new Error('no valid allowlist root configured');
  }

  const allowed = roots.some(root => isUnder(realPath, root));
  if (!allowed) {
    throw new Error(
      `path "${filePath}" is outside the allowed roots. Only files under the current workspace, ~/${APP_DATA_DIR_NAME}/tmp, or the system temp directory can be read for this operation.`
    );
  }

  return realPath;
}

function defaultExtraRoots(home: string | null): string[] {
  const roots = [tmpdir()];
  if (home) {
    roots.push(resolve(home, APP_DATA_DIR_NAME, 'tmp'));
  }
  return roots;
}

/**
 * Is `child` inside `parent` (or equal to it), using proper path-segment
 * comparison that doesn't fall for the classic `/foo` vs `/foobar` trap
 * that a naive `startsWith` check would miss.
 */
function isUnder(child: string, parent: string): boolean {
  if (child === parent) return true;
  const parentWithSep = parent.endsWith(sep) ? parent : parent + sep;
  return child.startsWith(parentWithSep);
}

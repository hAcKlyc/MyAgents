// Cross-Runtime Workspace Instructions
//
// Reads Claude-protocol workspace files for Codex and DSH supplements.
//
// Format is replicated from Claude Code's getClaudeMds() in utils/claudemd.ts:
//   "Contents of {absolutePath} (project instructions, checked into the codebase):\n\n{content}"
//
// Design:
//   - Codex: CLAUDE.md discovered natively via `-c project_doc_fallback_filenames=["CLAUDE.md"]`;
//            only .claude/rules/*.md injected through developerInstructions
//   - Zero external config file modification
//
// Security hardening (v0.1.68+):
//   - Symlinks rejected: companion files and directory entries use lstat semantics.
//     Prevents a repo-local symlink from exfiltrating files outside the workspace
//     (e.g. `.claude/rules/x.md -> ~/.ssh/id_rsa`) into the model prompt.
//   - Recursion depth bounded (MAX_DEPTH) to defuse symlink loops on directories.
//   - File count / per-file size / total size caps to prevent prompt inflation attacks
//     and excessive context usage.

import { existsSync, lstatSync, readFileSync, readdirSync, statSync, type Dirent } from 'fs';
import { join, extname, relative } from 'path';

// ─── Constants (replicated from Claude Code utils/claudemd.ts) ───

const MEMORY_INSTRUCTION_PROMPT =
  'Codebase and user instructions are shown below. Be sure to adhere to these instructions. ' +
  'IMPORTANT: These instructions OVERRIDE any default behavior and you MUST follow them exactly as written.';

const PROJECT_DESCRIPTION = '(project instructions, checked into the codebase)';

// ─── Resource limits (security hardening) ───
//
// These bounds are intentionally generous — a well-maintained project's
// CLAUDE.md + rules is typically under 50KB. Bounds are here to defuse
// pathological / malicious inputs, not to constrain normal use.

const MAX_DEPTH = 8;                       // rules/ recursion depth
const MAX_FILES = 64;                      // max rule files injected
const MAX_BYTES_PER_FILE = 256 * 1024;     // 256KB per file
const MAX_TOTAL_BYTES = 1 * 1024 * 1024;   // 1MB aggregate

// ─── Types ───

interface WorkspaceInstruction {
  path: string;     // absolute path
  content: string;  // trimmed content
}

interface CollectBudget {
  totalBytes: number;
  truncated: boolean;
}

// ─── File reading helpers ───

/** Read a single regular file if it exists, non-symlink, and within size cap. */
function isInstructionDirectory(path: string): boolean {
  try { return lstatSync(path).isDirectory(); } catch { return false; }
}

function readIfExists(filePath: string): WorkspaceInstruction | null {
  try {
    if (!existsSync(filePath)) return null;
    // lstat — we reject symlinks at the file level, just like for directory entries.
    // A repo-level `CLAUDE.md -> /etc/passwd` should not get injected.
    const st = lstatSync(filePath);
    if (!st.isFile()) return null;
    if (st.size > MAX_BYTES_PER_FILE) {
      console.warn(`[workspace-instructions] Skipping oversized file (${st.size} bytes > ${MAX_BYTES_PER_FILE}): ${filePath}`);
      return null;
    }
    const content = readFileSync(filePath, 'utf-8').trim();
    if (!content) return null;
    return { path: filePath, content };
  } catch {
    return null;
  }
}

/**
 * Recursively collect .md files from a rules directory.
 *
 * Safety:
 *   - Symlinks (file and directory) are skipped — Dirent.isSymbolicLink() on
 *     readdirSync({ withFileTypes: true }) uses lstat semantics.
 *   - Depth bounded by MAX_DEPTH to defuse symlink loops that escape the isSymbolicLink
 *     check on bizarre filesystems.
 *   - File count bounded by MAX_FILES.
 *   - Per-file and total byte budgets enforced.
 *
 * Sort-by-name kept for determinism (mirrors Claude Code's processMdRules()).
 */
function collectRuleFiles(
  dir: string,
  out: WorkspaceInstruction[],
  budget: CollectBudget,
  depth = 0,
  maxTotalBytes = MAX_TOTAL_BYTES,
): void {
  if (depth > MAX_DEPTH) {
    if (!budget.truncated) {
      console.warn(`[workspace-instructions] rules/ recursion depth exceeded (${MAX_DEPTH}) at ${dir}`);
      budget.truncated = true;
    }
    return;
  }
  if (out.length >= MAX_FILES) return;

  let entries: Dirent[];
  try {
    if (!isInstructionDirectory(dir)) return;
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return; // ENOENT / EACCES — silently skip
  }
  entries.sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0);

  for (const ent of entries) {
    if (out.length >= MAX_FILES) {
      if (!budget.truncated) {
        console.warn(`[workspace-instructions] rule file count cap reached (${MAX_FILES})`);
        budget.truncated = true;
      }
      return;
    }

    // Reject symlinks at both the file and directory level.
    // Dirent from readdirSync({ withFileTypes: true }) uses lstat — symlinks
    // surface as isSymbolicLink() rather than their target type.
    if (ent.isSymbolicLink()) continue;

    const full = join(dir, ent.name);

    if (ent.isDirectory()) {
      collectRuleFiles(full, out, budget, depth + 1, maxTotalBytes);
      continue;
    }

    if (!ent.isFile() || extname(ent.name).toLowerCase() !== '.md') continue;

    // Size caps (per-file + aggregate) checked via lstat — Dirent doesn't carry size.
    let size: number;
    try {
      size = statSync(full).size;
    } catch {
      continue;
    }
    if (size > MAX_BYTES_PER_FILE) {
      console.warn(`[workspace-instructions] Skipping oversized rule file (${size} bytes): ${full}`);
      continue;
    }
    if (budget.totalBytes + size > maxTotalBytes) {
      if (!budget.truncated) {
        console.warn(`[workspace-instructions] Total rules size cap reached (${maxTotalBytes} bytes) at ${full}`);
        budget.truncated = true;
      }
      return;
    }

    try {
      const content = readFileSync(full, 'utf-8').trim();
      if (!content) continue;
      out.push({ path: full, content });
      budget.totalBytes += size;
    } catch {
      // skip unreadable entries
    }
  }
}

// ─── Core read functions ───

/**
 * Read only .claude/rules/*.md (for Codex — CLAUDE.md itself is loaded natively via -c flag).
 */
function readClaudeRulesOnly(workspacePath: string): WorkspaceInstruction[] {
  const rules: WorkspaceInstruction[] = [];
  if (!isInstructionDirectory(join(workspacePath, '.claude'))) return rules;
  const budget: CollectBudget = { totalBytes: 0, truncated: false };
  collectRuleFiles(join(workspacePath, '.claude', 'rules'), rules, budget);
  return rules;
}

// ─── Formatting (replicates Claude Code getClaudeMds() output) ───

/**
 * Format instruction files into the Claude Code getClaudeMds() text format.
 *
 * Output:
 *   Codebase and user instructions are shown below. ...
 *
 *   Contents of /abs/path/CLAUDE.md (project instructions, checked into the codebase):
 *
 *   <file content>
 *
 *   Contents of /abs/path/.claude/rules/foo.md (project instructions, checked into the codebase):
 *
 *   <file content>
 */
function formatInstructions(instructions: WorkspaceInstruction[]): string {
  if (instructions.length === 0) return '';

  const blocks = instructions.map(
    ({ path, content }) => `Contents of ${path} ${PROJECT_DESCRIPTION}:\n\n${content}`,
  );

  return `${MEMORY_INSTRUCTION_PROMPT}\n\n${blocks.join('\n\n')}`;
}

// ─── Runtime-specific resolvers ───

/**
 * Codex: resolve .claude/rules/*.md for developerInstructions injection.
 * CLAUDE.md itself is handled by Codex's native file discovery via
 * `-c 'project_doc_fallback_filenames=["CLAUDE.md"]'` CLI arg.
 */
export function resolveAntigravityWorkspaceInstructions(workspacePath: string): string {
  const names = isInstructionDirectory(join(workspacePath, '.claude')) ? ['CLAUDE.md', '.claude/CLAUDE.md'] : ['CLAUDE.md'];
  const instructions = names
    .map(name => readIfExists(join(workspacePath, name)))
    .filter((entry): entry is WorkspaceInstruction => entry !== null);
  return formatInstructions([...instructions, ...readClaudeRulesOnly(workspacePath)]);
}

export function resolveCodexWorkspaceInstructions(workspacePath: string): string {
  const rules = readClaudeRulesOnly(workspacePath);
  return formatInstructions(rules);
}

/**
 * DSH owns primary CLAUDE.md / AGENTS.md discovery. This Host snapshot carries
 * only Claude companion sources that the DSH instruction plugin does not read.
 */
export function resolveDshWorkspaceSupplement(workspacePath: string): string {
  const maxBytes = 512 * 1024;
  const instructions: WorkspaceInstruction[] = [];
  const budget: CollectBudget = { totalBytes: 0, truncated: false };
  if (!isInstructionDirectory(join(workspacePath, '.claude'))) return '';
  const companion = readIfExists(join(workspacePath, '.claude', 'CLAUDE.md'));
  if (companion) {
    const bytes = Buffer.byteLength(companion.content, 'utf8');
    if (bytes <= maxBytes) {
      instructions.push(companion);
      budget.totalBytes = bytes;
    }
  }
  collectRuleFiles(
    join(workspacePath, '.claude', 'rules'),
    instructions,
    budget,
    0,
    maxBytes,
  );
  if (instructions.length === 0) return '';
  const body = instructions.map(({ path, content }) => {
    const displayPath = relative(workspacePath, path).replaceAll('\\', '/');
    return `## ${displayPath}\n${content}`;
  }).join('\n\n');
  return [
    'Current workspace instructions follow. They are user/project guidance for this workspace. Follow them where applicable. They do not grant tool permissions or override Runtime policy.',
    '',
    body,
  ].join('\n');
}

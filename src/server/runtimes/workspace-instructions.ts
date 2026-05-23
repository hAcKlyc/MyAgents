// Cross-Runtime Workspace Instructions (v0.1.68)
//
// Reads Claude-protocol workspace files (CLAUDE.md, .claude/rules/*.md, AGENTS.md)
// and formats them for injection into external runtimes (Codex, Gemini).
//
// Format is replicated from Claude Code's getClaudeMds() in utils/claudemd.ts:
//   "Contents of {absolutePath} (project instructions, checked into the codebase):\n\n{content}"
//
// Design:
//   - Codex: CLAUDE.md discovered natively via `-c project_doc_fallback_filenames=["CLAUDE.md"]`;
//            only .claude/rules/*.md injected through developerInstructions
//   - Gemini: chain fallback (GEMINI.md present → skip; else CLAUDE.md + rules; else AGENTS.md)
//            injected through GEMINI_SYSTEM_MD merge
//   - Zero external config file modification
//
// Security hardening (v0.1.68+):
//   - Symlinks rejected: both root-level files (CLAUDE.md, AGENTS.md, GEMINI.md) and
//     directory entries use lstat semantics (readdirSync withFileTypes / lstatSync).
//     Prevents a repo-local symlink from exfiltrating files outside the workspace
//     (e.g. `.claude/rules/x.md -> ~/.ssh/id_rsa`) into the model prompt.
//   - Recursion depth bounded (MAX_DEPTH) to defuse symlink loops on directories.
//   - File count / per-file size / total size caps to prevent prompt inflation attacks
//     and excessive context usage.

import { existsSync, lstatSync, readFileSync, readdirSync, statSync, type Dirent } from 'fs';
import { join, extname } from 'path';

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
 * Check if a candidate root-level sentinel file exists, is a regular file, and is
 * not a symlink. Used for GEMINI.md presence check — we only treat a repo as
 * having GEMINI.md when it's a real file committed to the repo, not a dangling
 * or adversarial symlink.
 */
function isRegularFile(filePath: string): boolean {
  try {
    if (!existsSync(filePath)) return false;
    const st = lstatSync(filePath);
    return st.isFile();
  } catch {
    return false;
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
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return; // ENOENT / EACCES — silently skip
  }
  entries.sort((a, b) => a.name.localeCompare(b.name));

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
      collectRuleFiles(full, out, budget, depth + 1);
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
    if (budget.totalBytes + size > MAX_TOTAL_BYTES) {
      if (!budget.truncated) {
        console.warn(`[workspace-instructions] Total rules size cap reached (${MAX_TOTAL_BYTES} bytes) at ${full}`);
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
 * Read 00-CORE.md (lightweight core memory) if present, otherwise fall back to
 * CLAUDE.md + .claude/CLAUDE.md + .claude/rules/*.md.
 *
 * 00-CORE.md is a user-maintained ~200-token distillation of the full ruleset.
 * When it exists we skip the heavy files to cut per-request fixed overhead.
 */
function readClaudeWorkspaceInstructions(workspacePath: string): WorkspaceInstruction[] {
  const instructions: WorkspaceInstruction[] = [];
  const budget: CollectBudget = { totalBytes: 0, truncated: false };

  const consume = (inst: WorkspaceInstruction | null): void => {
    if (!inst) return;
    const size = Buffer.byteLength(inst.content, 'utf-8');
    if (budget.totalBytes + size > MAX_TOTAL_BYTES) {
      budget.truncated = true;
      return;
    }
    instructions.push(inst);
    budget.totalBytes += size;
  };

  // Phase-1 optimization: prefer 00-CORE.md (lightweight core memory)
  const coreMemory = readIfExists(join(workspacePath, '.claude', 'rules', '00-CORE.md'));
  if (coreMemory) {
    consume(coreMemory);
    return instructions; // skip heavy rules when core memory is present
  }

  // Fallback: load full rule set (legacy behaviour)
  // CLAUDE.md at project root
  consume(readIfExists(join(workspacePath, 'CLAUDE.md')));

  // .claude/CLAUDE.md (Claude Code also checks this location)
  consume(readIfExists(join(workspacePath, '.claude', 'CLAUDE.md')));

  // .claude/rules/*.md (recursive)
  if (!budget.truncated && instructions.length < MAX_FILES) {
    collectRuleFiles(join(workspacePath, '.claude', 'rules'), instructions, budget);
  }

  return instructions;
}

/**
 * Read only .claude/rules/*.md (for Codex — CLAUDE.md itself is loaded natively via -c flag).
 */
function readClaudeRulesOnly(workspacePath: string): WorkspaceInstruction[] {
  const rules: WorkspaceInstruction[] = [];
  const budget: CollectBudget = { totalBytes: 0, truncated: false };
  collectRuleFiles(join(workspacePath, '.claude', 'rules'), rules, budget);
  return rules;
}

/**
 * Read AGENTS.md from a workspace root.
 */
function readAgentsMd(workspacePath: string): WorkspaceInstruction[] {
  const agentsMd = readIfExists(join(workspacePath, 'AGENTS.md'));
  return agentsMd ? [agentsMd] : [];
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
export function resolveCodexWorkspaceInstructions(workspacePath: string): string {
  const rules = readClaudeRulesOnly(workspacePath);
  return formatInstructions(rules);
}

/**
 * Gemini: chain fallback for GEMINI_SYSTEM_MD injection.
 *
 * Priority:
 *   1. GEMINI.md exists (regular file, not symlink) → return '' (Gemini loads it natively)
 *   2. CLAUDE.md exists → inject CLAUDE.md + .claude/CLAUDE.md + .claude/rules/*.md
 *   3. AGENTS.md exists → inject AGENTS.md
 *   4. None found → return ''
 */
export function resolveGeminiWorkspaceInstructions(workspacePath: string): string {
  // 1. GEMINI.md present as a regular (non-symlink) file → Gemini native, skip
  if (isRegularFile(join(workspacePath, 'GEMINI.md'))) {
    return '';
  }

  // 2. CLAUDE.md present → full Claude protocol
  const claudeInstructions = readClaudeWorkspaceInstructions(workspacePath);
  if (claudeInstructions.length > 0) {
    return formatInstructions(claudeInstructions);
  }

  // 3. AGENTS.md present → Codex protocol
  const agentsInstructions = readAgentsMd(workspacePath);
  if (agentsInstructions.length > 0) {
    return formatInstructions(agentsInstructions);
  }

  // 4. Nothing found
  return '';
}

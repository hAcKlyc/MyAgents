// Antigravity CLI Skill Supplement (Progressive Disclosure)
//
// Antigravity CLI (agy 1.5.14) natively discovers workspace skills under
// `.agents/skills/` (and `.agent/`, `_agents/`, `_agent/`) and skips symlinks
// whose resolved targets point outside the workspace/repo root.
//
// MyAgents projects enabled global/system skills (`~/.myagents/skills/*`) via
// symlinks into `<workspace>/.claude/skills/<name>`. Without a session-scoped
// supplement, Antigravity misses both `.claude/skills/` (Wall 1) and symlinked
// global/system skills pointing outside the workspace (Wall 2).
//
// This module builds a zero-repo-pollution progressive-disclosure catalog for
// `_meta.antigravity.systemPrompt.append`, strictly deduplicating against
// skills that Antigravity already natively loads so no skill is injected twice.

import { lstatSync, readFileSync, readdirSync, realpathSync, statSync, type Dirent } from 'node:fs';
import { dirname, isAbsolute, join, relative, sep } from 'node:path';

import type {
  EffectiveProjectCapabilitySnapshot,
  ProjectCapabilityCandidate,
} from '../../shared/projectCapabilities';
import { parseSkillFrontmatter } from '../../shared/slashCommands';

const NATIVE_CUSTOMIZATION_DIRS = ['.agents', '.agent', '_agents', '_agent'] as const;
const MAX_ANCESTOR_WALK_DEPTH = 16;
const MAX_SKILL_FILE_BYTES = 1024 * 1024;
const MAX_DESCRIPTION_CHARS = 600;
const MAX_CATALOG_BYTES = 64 * 1024;

function isWithinRoot(rootRealPath: string, candidateRealPath: string): boolean {
  const rel = relative(rootRealPath, candidateRealPath);
  return rel === '' || (!rel.startsWith(`..${sep}`) && rel !== '..' && !isAbsolute(rel));
}

function normalizePathKey(filePath: string): string {
  return process.platform === 'win32' ? filePath.toLowerCase() : filePath;
}

function tryRealpath(targetPath: string): string | null {
  try {
    return realpathSync(targetPath);
  } catch {
    return null;
  }
}

function hasGitMarker(dirPath: string): boolean {
  try {
    lstatSync(join(dirPath, '.git'));
    return true;
  } catch {
    return false;
  }
}

/**
 * Mirror agy's ancestor walk from cwd up to the nearest `.git` root.
 * When no `.git` ancestor exists within the walk cap, only `workspaceRealPath`
 * itself is inspected so unrelated parent directories are never scanned.
 */
function resolveNativeDiscoveryScope(workspaceRealPath: string): {
  searchDirs: string[];
  containmentRoot: string;
} {
  const walked: string[] = [];
  let current = workspaceRealPath;
  for (let depth = 0; depth <= MAX_ANCESTOR_WALK_DEPTH; depth += 1) {
    walked.push(current);
    if (hasGitMarker(current)) {
      return { searchDirs: walked, containmentRoot: current };
    }
    const parent = dirname(current);
    if (parent === current) break;
    current = parent;
  }
  return { searchDirs: [workspaceRealPath], containmentRoot: workspaceRealPath };
}

/**
 * Collect the canonical `SKILL.md` paths and lowercase names that `agy`
 * natively discovers inside the workspace/repository boundary.
 *
 * Symlinks whose resolved targets escape `containmentRoot` (e.g. symlinks to
 * `~/.myagents/skills/*`) are intentionally excluded here because `agy 1.5.14`
 * skips out-of-workspace symlinks during native skill discovery.
 */
export function collectAntigravityNativeSkills(workspacePath: string): {
  paths: Set<string>;
  names: Set<string>;
} {
  const paths = new Set<string>();
  const names = new Set<string>();
  const workspaceRealPath = tryRealpath(workspacePath);
  if (!workspaceRealPath) return { paths, names };

  const { searchDirs, containmentRoot } = resolveNativeDiscoveryScope(workspaceRealPath);
  const visitedSkillRoots = new Set<string>();

  for (const dir of searchDirs) {
    for (const customDir of NATIVE_CUSTOMIZATION_DIRS) {
      const skillsRootCandidate = join(dir, customDir, 'skills');
      const resolvedSkillsRoot = tryRealpath(skillsRootCandidate);
      if (!resolvedSkillsRoot || !isWithinRoot(containmentRoot, resolvedSkillsRoot)) continue;

      const rootKey = normalizePathKey(resolvedSkillsRoot);
      if (visitedSkillRoots.has(rootKey)) continue;
      visitedSkillRoots.add(rootKey);

      let entries: Dirent[];
      try {
        if (!statSync(resolvedSkillsRoot).isDirectory()) continue;
        entries = readdirSync(resolvedSkillsRoot, { withFileTypes: true });
      } catch {
        continue;
      }

      for (const entry of entries) {
        if (entry.name.startsWith('.')) continue;
        const entryRealPath = tryRealpath(join(resolvedSkillsRoot, entry.name));
        if (!entryRealPath || !isWithinRoot(containmentRoot, entryRealPath)) continue;

        let entryStat;
        try {
          entryStat = statSync(entryRealPath);
        } catch {
          continue;
        }
        if (!entryStat.isDirectory()) continue;

        const skillFileRealPath = tryRealpath(join(entryRealPath, 'SKILL.md'));
        if (!skillFileRealPath || !isWithinRoot(entryRealPath, skillFileRealPath)) continue;

        try {
          const fileStat = statSync(skillFileRealPath);
          if (!fileStat.isFile() || fileStat.size > MAX_SKILL_FILE_BYTES) continue;
          const content = readFileSync(skillFileRealPath, 'utf8');
          const frontmatter = parseSkillFrontmatter(content);
          const skillName = frontmatter.name?.trim() || entry.name;
          paths.add(normalizePathKey(skillFileRealPath));
          if (skillName) names.add(skillName.toLowerCase());
        } catch {
          // Skip unreadable SKILL.md entries
        }
      }
    }
  }

  return { paths, names };
}

function sanitizeSingleLine(value: string, maxChars: number): string {
  const collapsed = value
    .replace(/<\/?myagents-skills>/gi, '')
    .replace(/\s+/g, ' ')
    .trim();
  if (collapsed.length <= maxChars) return collapsed;
  return `${collapsed.slice(0, maxChars - 1).trimEnd()}…`;
}

function formatSkillCatalogEntry(skill: ProjectCapabilityCandidate): string {
  const resolvedPath = tryRealpath(skill.path) ?? skill.path;
  const safeName = sanitizeSingleLine(skill.canonicalName || skill.name, 120);
  const safeDescription = sanitizeSingleLine(skill.description || '', MAX_DESCRIPTION_CHARS);
  return safeDescription
    ? `- ${safeName} (${resolvedPath}): ${safeDescription}`
    : `- ${safeName} (${resolvedPath})`;
}

/**
 * Build the progressive-disclosure `<myagents-skills>` system prompt supplement
 * for Antigravity CLI, excluding any skill already natively loaded by `agy`.
 */
export function resolveAntigravitySkillSupplement(
  workspacePath: string,
  capabilitySnapshot: Pick<EffectiveProjectCapabilitySnapshot, 'enabledSkills'>,
): string {
  if (!capabilitySnapshot.enabledSkills.length) return '';

  const native = collectAntigravityNativeSkills(workspacePath);
  const projected = capabilitySnapshot.enabledSkills.filter((skill) => {
    const canonicalPath = tryRealpath(skill.path) ?? skill.path;
    if (native.paths.has(normalizePathKey(canonicalPath))) return false;
    if (native.names.has(skill.canonicalName.toLowerCase())) return false;
    return true;
  });

  if (projected.length === 0) return '';

  const header = [
    '<myagents-skills>',
    'Additional workspace and global skills enabled in MyAgents (not already listed in the native skills section above).',
    'When a skill is relevant to the current task, you MUST read its SKILL.md file at the exact path below before following its instructions.',
    '',
  ].join('\n');
  const footer = '\n</myagents-skills>';

  const formatted = projected.map((skill) => {
    const line = formatSkillCatalogEntry(skill);
    return {
      skill,
      line,
      bytes: Buffer.byteLength(`${line}\n`, 'utf8'),
    };
  });

  const selected = new Set<ProjectCapabilityCandidate>();
  let totalBytes = Buffer.byteLength(header + footer, 'utf8');
  // Reserve catalog capacity for required system skills first so a large set of
  // alphabetically earlier optional skills can never silently evict them.
  for (const entry of formatted) {
    if (!entry.skill.required) continue;
    if (totalBytes + entry.bytes > MAX_CATALOG_BYTES) continue;
    selected.add(entry.skill);
    totalBytes += entry.bytes;
  }
  for (const entry of formatted) {
    if (entry.skill.required) continue;
    if (totalBytes + entry.bytes > MAX_CATALOG_BYTES) break;
    selected.add(entry.skill);
    totalBytes += entry.bytes;
  }

  const lines = formatted
    .filter((entry) => selected.has(entry.skill))
    .map((entry) => entry.line);

  if (lines.length === 0) return '';
  return `${header}${lines.join('\n')}${footer}`;
}

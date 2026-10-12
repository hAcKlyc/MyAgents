import { APP_DATA_DIR_NAME } from '../shared/appProfile';
import { createHash } from 'node:crypto';
import {
  existsSync,
  lstatSync,
  readFileSync,
  readdirSync,
  type Dirent,
  type Stats,
} from 'node:fs';
import { join, resolve } from 'node:path';

import {
  classifySkillIntegrity,
  collisionDirectoryBase,
  RESERVED_SKILL_ENTRY_RE,
  skillIntegrityIdentityEquals,
  type SkillIntegrityIssue,
} from '../shared/skillIntegrity';
import { parseFullSkillContent, parseSkillFrontmatter } from '../shared/slashCommands';
import { isRequiredSystemSkill, REQUIRED_SYSTEM_SKILLS } from '../shared/systemSkills';
import { isCliToolRegistryEnabled, loadConfig } from './utils/admin-config';
import { getCrossPlatformEnv } from './utils/platform';

const MAX_SKILL_FILE_BYTES = 1024 * 1024;

export interface GlobalSkillInventoryEntry {
  folderName: string;
  skillPath: string;
  content: string;
  name: string;
  description: string;
  author?: string;
  required: boolean;
  enabledForProjection: boolean;
}

export interface GlobalSkillInventorySnapshot {
  rootPath: string;
  complete: true;
  entries: readonly GlobalSkillInventoryEntry[];
  projectableEntries: readonly GlobalSkillInventoryEntry[];
  integrityIssues: readonly SkillIntegrityIssue[];
  integrityRevision: string;
}

export interface GlobalSkillInventoryOptions {
  rootPath?: string;
  disabledSkillNames?: ReadonlySet<string>;
  cliToolRegistryEnabled?: boolean;
  /** Deterministic filesystem-race injection; never set by production callers. */
  testHooks?: {
    afterRootEnumeration?: () => void;
    beforeSlotRecheck?: (folderName: string) => void;
  };
}

function defaultSkillsRoot(): string {
  const { home, temp } = getCrossPlatformEnv();
  return resolve(home || temp, APP_DATA_DIR_NAME, 'skills');
}

function stableValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stableValue);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, entry]) => [key, stableValue(entry)]),
  );
}

function stableStringify(value: unknown): string {
  return JSON.stringify(stableValue(value));
}

function statIdentity(stat: Stats | null): string {
  if (!stat) return 'missing';
  return [stat.dev, stat.ino, stat.mode, stat.size, stat.mtimeMs].join(':');
}

function lstatIfPresent(path: string): Stats | null {
  try {
    return lstatSync(path);
  } catch {
    return null;
  }
}

function pathKey(path: string): string {
  return process.platform === 'win32' ? path.toLocaleLowerCase('en-US') : path;
}

export function readDisabledGlobalSkillNames(rootPath = defaultSkillsRoot()): Set<string> {
  const configPath = join(rootPath, '..', 'skills-config.json');
  if (!existsSync(configPath)) return new Set();
  try {
    const parsed = JSON.parse(readFileSync(configPath, 'utf8')) as { disabled?: unknown };
    if (parsed.disabled === undefined) return new Set();
    if (!Array.isArray(parsed.disabled) || parsed.disabled.some(entry => typeof entry !== 'string')) {
      console.warn('[skill-integrity] Ignoring malformed skills-config.json disabled list');
      return new Set();
    }
    return new Set(parsed.disabled.filter((name): name is string => (
      typeof name === 'string' && !isRequiredSystemSkill(name)
    )));
  } catch (error) {
    console.warn(
      '[skill-integrity] Ignoring unreadable skills-config.json:',
      error instanceof Error ? error.message : String(error),
    );
    return new Set();
  }
}

function makeIssue(input: {
  reason: SkillIntegrityIssue['reason'];
  severity: SkillIntegrityIssue['severity'];
  folderName: string;
  canonicalPresent: boolean;
  revealPath: string;
  required: boolean;
}): SkillIntegrityIssue {
  return Object.freeze(input);
}

/**
 * Build one complete, immutable view of the global Skill root. Callers pass
 * this same snapshot to capability resolution and workspace projection inside
 * a single admission boundary; there is intentionally no process-wide cache.
 */
export function createGlobalSkillInventorySnapshot(
  options: GlobalSkillInventoryOptions = {},
): GlobalSkillInventorySnapshot {
  const rootPath = resolve(options.rootPath ?? defaultSkillsRoot());
  const disabledSkillNames = options.disabledSkillNames ?? readDisabledGlobalSkillNames(rootPath);
  const cliToolRegistryEnabled = options.cliToolRegistryEnabled
    ?? isCliToolRegistryEnabled(loadConfig());

  let rootEntries: Dirent[] = [];
  const rootBefore = lstatIfPresent(rootPath);
  if (rootBefore) {
    if (!rootBefore.isDirectory() || rootBefore.isSymbolicLink()) {
      console.warn(`[skill-integrity] Ignoring unreadable global Skill root: ${rootPath}`);
    } else {
      try {
        rootEntries = readdirSync(rootPath, { withFileTypes: true });
        options.testHooks?.afterRootEnumeration?.();
      } catch (error) {
        console.warn(
          '[skill-integrity] Ignoring unreadable global Skill root:',
          error instanceof Error ? error.message : String(error),
        );
      }
    }
  }

  const sortedEntries = rootEntries
    .filter(entry => !entry.name.startsWith('.'))
    .sort((left, right) => left.name.localeCompare(right.name));
  const slotMetadata = new Map<string, Stats>();
  const observedNames = new Set<string>();
  for (const rootEntry of sortedEntries) {
    const metadata = lstatIfPresent(join(rootPath, rootEntry.name));
    if (!metadata || (!metadata.isDirectory() && !metadata.isSymbolicLink())) continue;
    slotMetadata.set(rootEntry.name, metadata);
    observedNames.add(pathKey(rootEntry.name));
  }
  const entries: GlobalSkillInventoryEntry[] = [];
  const integrityIssues: SkillIntegrityIssue[] = [];

  for (const rootEntry of sortedEntries) {
    const folderName = rootEntry.name;
    const folderPath = join(rootPath, folderName);
    const folderBefore = slotMetadata.get(folderName) ?? null;
    if (!folderBefore) continue;

    const skillPath = join(folderPath, 'SKILL.md');
    const canonicalBefore = lstatIfPresent(skillPath);
    const canonicalPresent = !!canonicalBefore?.isFile();
    let canonicalReadable = false;
    let content = '';
    if (
      canonicalPresent
      && !canonicalBefore?.isSymbolicLink()
      && (canonicalBefore?.size ?? Number.POSITIVE_INFINITY) <= MAX_SKILL_FILE_BYTES
    ) {
      try {
        content = readFileSync(skillPath, 'utf8');
        canonicalReadable = true;
      } catch {
        canonicalReadable = false;
      }
    }

    let reservedEntrySiblingPresent = false;
    let childScanStable = true;
    if (folderBefore?.isDirectory() && !folderBefore.isSymbolicLink()) {
      try {
        reservedEntrySiblingPresent = readdirSync(folderPath, { withFileTypes: true })
          .some(entry => RESERVED_SKILL_ENTRY_RE.test(entry.name));
      } catch {
        childScanStable = false;
      }
    }

    const parsed = canonicalReadable ? parseFullSkillContent(content) : null;
    const declaredName = canonicalReadable
      ? parseSkillFrontmatter(content).name?.trim() || undefined
      : undefined;
    const collisionBase = collisionDirectoryBase(folderName);
    const unsuffixedSiblingPresent = collisionBase
      ? observedNames.has(pathKey(collisionBase))
      : false;
    options.testHooks?.beforeSlotRecheck?.(folderName);
    const folderAfter = lstatIfPresent(folderPath);
    const canonicalAfter = lstatIfPresent(skillPath);
    const stable = childScanStable
      && statIdentity(folderBefore) === statIdentity(folderAfter)
      && statIdentity(canonicalBefore) === statIdentity(canonicalAfter);
    const trustedSource = !!folderBefore?.isDirectory()
      && !folderBefore.isSymbolicLink()
      && !canonicalBefore?.isSymbolicLink();
    let classification = classifySkillIntegrity({
      folderName,
      declaredName,
      identityCaseInsensitive: process.platform === 'win32',
      canonicalPresent,
      canonicalReadable,
      trustedSource,
      unsuffixedSiblingPresent,
      reservedEntrySiblingPresent,
      stable,
    });

    // Required identities are bound to their official top-level slot. An
    // optional folder may not impersonate one, and an official slot may not
    // silently declare a different identity.
    if (
      classification.disposition !== 'blocked'
      && ((declaredName
        && isRequiredSystemSkill(declaredName)
        && !skillIntegrityIdentityEquals(declaredName, folderName, process.platform === 'win32'))
        || (isRequiredSystemSkill(folderName)
          && declaredName
          && !skillIntegrityIdentityEquals(declaredName, folderName, process.platform === 'win32')))
    ) {
      classification = { disposition: 'blocked', reasons: ['untrusted_global_source'] };
    }

    const required = isRequiredSystemSkill(folderName)
      || (!!declaredName && isRequiredSystemSkill(declaredName));
    for (const reason of classification.reasons) {
      integrityIssues.push(makeIssue({
        reason,
        severity: classification.disposition === 'blocked' ? 'blocked' : 'warning',
        folderName,
        canonicalPresent,
        revealPath: folderPath,
        required,
      }));
    }
    if (classification.disposition === 'blocked' || !parsed) continue;

    const name = parsed.frontmatter.name?.trim() || folderName;
    entries.push(Object.freeze({
      folderName,
      skillPath,
      content,
      name,
      description: parsed.frontmatter.description?.trim() || '',
      ...(parsed.frontmatter.author ? { author: parsed.frontmatter.author } : {}),
      required: isRequiredSystemSkill(folderName),
      enabledForProjection: (
        (isRequiredSystemSkill(folderName) || !disabledSkillNames.has(folderName))
        && (cliToolRegistryEnabled || folderName !== 'tool-creator')
      ),
    }));
  }

  for (const requiredName of REQUIRED_SYSTEM_SKILLS) {
    if (observedNames.has(pathKey(requiredName))) continue;
    integrityIssues.push(makeIssue({
      reason: 'missing_required_skill',
      severity: 'blocked',
      folderName: requiredName,
      canonicalPresent: false,
      revealPath: rootPath,
      required: true,
    }));
  }

  integrityIssues.sort((left, right) => (
    left.folderName.localeCompare(right.folderName) || left.reason.localeCompare(right.reason)
  ));
  entries.sort((left, right) => left.folderName.localeCompare(right.folderName));
  const rootAfter = lstatIfPresent(rootPath);
  if (statIdentity(rootBefore) !== statIdentity(rootAfter)) {
    console.warn('[skill-integrity] Global Skill root changed during inventory scan; next admission will rescan');
  }
  const projectableEntries = entries.filter(entry => entry.enabledForProjection);
  const integrityRevision = createHash('sha256')
    .update(stableStringify({
      issues: integrityIssues,
      projection: projectableEntries.map(entry => ({
        folderName: entry.folderName,
        skillPath: entry.skillPath,
      })),
    }))
    .digest('hex');
  for (const issue of integrityIssues) {
    const summary = `[skill-integrity] disposition=${issue.severity} reason=${issue.reason} folder=${issue.folderName} revision=${integrityRevision.slice(0, 12)}`;
    if (issue.severity === 'blocked') console.warn(summary);
    else console.info(summary);
  }
  return Object.freeze({
    rootPath,
    complete: true as const,
    entries: Object.freeze(entries),
    projectableEntries: Object.freeze(projectableEntries),
    integrityIssues: Object.freeze(integrityIssues),
    integrityRevision,
  });
}

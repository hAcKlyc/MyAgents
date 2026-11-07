import { isRequiredSystemSkill } from './systemSkills';
import type { ProductSystemSkillRequirement } from './systemSkills';
import type { SkillIntegrityIssue } from './skillIntegrity';

export const PROJECT_CAPABILITY_SELECTION_VERSION = 1 as const;

/**
 * Ordered workspace Skill roots owned by the Host product profile.
 *
 * `.claude/skills` remains first to preserve existing MyAgents behavior;
 * `.agents/skills` adds the cross-harness Agent Skills convention. Runtime
 * adapters may pass an ordered subset when their native loader has a narrower
 * compatibility surface.
 */
export const DEFAULT_PROJECT_SKILL_DIRECTORIES = Object.freeze([
  '.claude/skills',
  '.agents/skills',
] as const);

export type ProjectSkillDirectory = (typeof DEFAULT_PROJECT_SKILL_DIRECTORIES)[number];

export type ProjectCapabilityKind = 'skill' | 'command';
export type ProjectCapabilitySource = 'project' | 'global';

export interface ProjectCapabilitySelectionV1 {
  version: typeof PROJECT_CAPABILITY_SELECTION_VERSION;
  disabled: {
    skills: string[];
    commands: string[];
  };
}

export interface ProjectCapabilityCandidate {
  id: string;
  kind: ProjectCapabilityKind;
  source: ProjectCapabilitySource;
  sourceLocalId: string;
  canonicalName: string;
  name: string;
  description: string;
  path: string;
  author?: string;
  required: boolean;
  systemOwned: boolean;
  enabled: boolean;
  /** SHA-256 of UTF-8 text with CRLF normalized to LF; not a resource byte hash. */
  contentSha256: string;
}

export interface EffectiveProjectCapabilitySnapshot {
  workspacePath: string;
  agentId: string;
  revision: string;
  integrityRevision: string;
  integrityIssues: SkillIntegrityIssue[];
  candidates: ProjectCapabilityCandidate[];
  enabledSkills: ProjectCapabilityCandidate[];
  enabledCommands: ProjectCapabilityCandidate[];
}

/**
 * Prove that the effective winner is the exact app-owned Skill requested by a
 * product workflow. A project Skill with the same name remains valid for
 * ordinary conversations, but cannot impersonate this admission contract.
 */
export function assertProductSystemSkillCandidate(
  snapshot: EffectiveProjectCapabilitySnapshot,
  requirement: ProductSystemSkillRequirement,
): ProjectCapabilityCandidate {
  const winner = snapshot.enabledSkills.find(
    candidate => candidate.canonicalName === requirement.name,
  );
  if (!winner) {
    throw new Error(`required product Skill ${requirement.name} is unavailable`);
  }
  if (
    winner.source !== 'global'
    || winner.sourceLocalId !== requirement.sourceLocalId
    || !winner.systemOwned
  ) {
    throw new Error(`required product Skill ${requirement.name} is not the app-owned global winner`);
  }
  if (winner.contentSha256 !== requirement.contentSha256) {
    throw new Error(`required product Skill ${requirement.name} does not match the app bundle`);
  }
  if (!snapshot.revision || !snapshot.integrityRevision) {
    throw new Error(`required product Skill ${requirement.name} has no admitted inventory revision`);
  }
  return winner;
}

function hasControlCharacter(value: string): boolean {
  return [...value].some(character => {
    const code = character.charCodeAt(0);
    return code <= 0x1f || code === 0x7f;
  });
}

export function emptyProjectCapabilitySelection(): ProjectCapabilitySelectionV1 {
  return {
    version: PROJECT_CAPABILITY_SELECTION_VERSION,
    disabled: { skills: [], commands: [] },
  };
}

export function normalizeCapabilitySourceLocalId(
  value: string,
  kind: ProjectCapabilityKind,
): string {
  const normalized = value.trim().replaceAll('\\', '/').replace(/^\/+|\/+$/g, '');
  if (!normalized || hasControlCharacter(normalized)) {
    throw new Error(`Invalid ${kind} capability source id`);
  }
  const segments = normalized.split('/');
  if (kind === 'skill' && segments.length !== 1) {
    throw new Error('Skill capability source id must be one folder name');
  }
  for (const segment of segments) {
    if (!segment || segment === '.' || segment === '..') {
      throw new Error(`Invalid ${kind} capability source id`);
    }
  }
  return segments.join('/');
}

export function projectCapabilityId(
  source: ProjectCapabilitySource,
  kind: ProjectCapabilityKind,
  sourceLocalId: string,
): string {
  return `${source}:${kind}:${normalizeCapabilitySourceLocalId(sourceLocalId, kind)}`;
}

export function parseProjectCapabilityId(value: string): {
  source: ProjectCapabilitySource;
  kind: ProjectCapabilityKind;
  sourceLocalId: string;
} {
  const match = /^(project|global):(skill|command):(.+)$/.exec(value.trim());
  if (!match) throw new Error('Invalid project capability identity');
  const source = match[1] as ProjectCapabilitySource;
  const kind = match[2] as ProjectCapabilityKind;
  const sourceLocalId = normalizeCapabilitySourceLocalId(match[3]!, kind);
  const canonical = projectCapabilityId(source, kind, sourceLocalId);
  if (canonical !== value.trim().replaceAll('\\', '/')) {
    throw new Error('Project capability identity is not canonical');
  }
  return { source, kind, sourceLocalId };
}

function normalizeDisabledList(value: unknown, kind: ProjectCapabilityKind): string[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) {
    throw new Error(`capabilitySelection.disabled.${kind}s must be string[]`);
  }
  const normalized = new Set<string>();
  for (const entry of value) {
    if (typeof entry !== 'string') {
      throw new Error(`capabilitySelection.disabled.${kind}s must contain only strings`);
    }
    const parsed = parseProjectCapabilityId(entry);
    if (parsed.kind !== kind) {
      throw new Error(`Capability identity kind does not match disabled.${kind}s`);
    }
    // Required skills are a product invariant, even when config.json was
    // edited by an older build or by hand.
    if (
      kind === 'skill'
      && parsed.source === 'global'
      && isRequiredSystemSkill(parsed.sourceLocalId)
    ) continue;
    normalized.add(projectCapabilityId(parsed.source, parsed.kind, parsed.sourceLocalId));
  }
  return [...normalized].sort();
}

export function normalizeProjectCapabilitySelection(value: unknown): ProjectCapabilitySelectionV1 {
  if (value === undefined || value === null) return emptyProjectCapabilitySelection();
  if (typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('capabilitySelection must be an object');
  }
  const record = value as Record<string, unknown>;
  if (record.version !== PROJECT_CAPABILITY_SELECTION_VERSION) {
    throw new Error(`Unsupported capabilitySelection version: ${String(record.version)}`);
  }
  const disabled = record.disabled;
  if (disabled !== undefined && (typeof disabled !== 'object' || disabled === null || Array.isArray(disabled))) {
    throw new Error('capabilitySelection.disabled must be an object');
  }
  const disabledRecord = (disabled ?? {}) as Record<string, unknown>;
  return {
    version: PROJECT_CAPABILITY_SELECTION_VERSION,
    disabled: {
      skills: normalizeDisabledList(disabledRecord.skills, 'skill'),
      commands: normalizeDisabledList(disabledRecord.commands, 'command'),
    },
  };
}

export function isCapabilityDisabled(
  selection: ProjectCapabilitySelectionV1,
  kind: ProjectCapabilityKind,
  id: string,
): boolean {
  return (kind === 'skill' ? selection.disabled.skills : selection.disabled.commands).includes(id);
}

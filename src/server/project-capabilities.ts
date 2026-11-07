import { createHash } from 'node:crypto';
import {
  existsSync,
  lstatSync,
  readFileSync,
  readlinkSync,
  readdirSync,
  realpathSync,
  statSync,
} from 'node:fs';
import { extname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import type { Dirent } from 'node:fs';

import {
  emptyProjectCapabilitySelection,
  isCapabilityDisabled,
  normalizeCapabilitySourceLocalId,
  normalizeProjectCapabilitySelection,
  projectCapabilityId,
  DEFAULT_PROJECT_SKILL_DIRECTORIES,
  type EffectiveProjectCapabilitySnapshot,
  type ProjectCapabilityCandidate,
  type ProjectCapabilityKind,
  type ProjectCapabilitySelectionV1,
  type ProjectCapabilitySource,
  type ProjectSkillDirectory,
} from '../shared/projectCapabilities';
import {
  isReservedSlashCommandName,
  parseFullCommandContent,
  parseFullSkillContent,
  slashCommandNameFromSourceLocalId,
} from '../shared/slashCommands';
import { isRequiredSystemSkill } from '../shared/systemSkills';
import { workspacePathsEqual } from '../shared/workspacePath';
import {
  createGlobalSkillInventorySnapshot,
  readDisabledGlobalSkillNames,
  type GlobalSkillInventorySnapshot,
} from './global-skill-inventory';
import {
  atomicModifyConfig,
  isCliToolRegistryEnabled,
  loadConfig,
  loadProjects,
  withAgentConfigIntentLock,
} from './utils/admin-config';
import { getMyAgentsUserDir } from './utils/project-user-config-sync';

const MAX_CAPABILITY_FILE_BYTES = 1024 * 1024;
const MAX_COMMAND_SCAN_DEPTH = 8;
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

function isWithin(root: string, candidate: string): boolean {
  const rel = relative(root, candidate);
  return rel === '' || (!rel.startsWith(`..${sep}`) && rel !== '..' && !isAbsolute(rel));
}

function symlinkTargetIsWithin(linkPath: string, trustedRoot: string): boolean {
  try {
    const target = readlinkSync(linkPath);
    return isWithin(resolve(trustedRoot), resolve(join(linkPath, '..'), target));
  } catch {
    return false;
  }
}

function canonicalDirectory(path: string, allowSymlink: boolean): string | null {
  try {
    const lst = lstatSync(path);
    if ((!lst.isDirectory() && !lst.isSymbolicLink()) || (!allowSymlink && lst.isSymbolicLink())) return null;
    const canonical = realpathSync(path);
    return statSync(canonical).isDirectory() ? canonical : null;
  } catch {
    return null;
  }
}

function canonicalFile(path: string, allowSymlink: boolean): string | null {
  try {
    const lst = lstatSync(path);
    if ((!lst.isFile() && !lst.isSymbolicLink()) || (!allowSymlink && lst.isSymbolicLink())) return null;
    const canonical = realpathSync(path);
    const stat = statSync(canonical);
    return stat.isFile() && stat.size <= MAX_CAPABILITY_FILE_BYTES ? canonical : null;
  } catch {
    return null;
  }
}

function contentSha256(content: string): string {
  // Product content identity ignores checkout line endings; Runtime resource
  // hashes remain byte-exact in product-extensions/compiler.ts.
  return createHash('sha256').update(content.replace(/\r\n/g, '\n')).digest('hex');
}

function candidate(params: {
  kind: ProjectCapabilityKind;
  source: ProjectCapabilitySource;
  sourceLocalId: string;
  canonicalName: string;
  name: string;
  description: string;
  path: string;
  content: string;
  author?: string;
}): Omit<ProjectCapabilityCandidate, 'enabled'> {
  const sourceLocalId = normalizeCapabilitySourceLocalId(params.sourceLocalId, params.kind);
  // Required is a runtime-name policy, not a provenance/authenticity check.
  // A real project Skill may legitimately override a global Skill with the
  // same canonical name; the ordinary winner remains required (and therefore
  // enabled) without turning that supported collision into a workspace error.
  const required = params.kind === 'skill' && isRequiredSystemSkill(params.canonicalName);
  return {
    id: projectCapabilityId(params.source, params.kind, sourceLocalId),
    kind: params.kind,
    source: params.source,
    sourceLocalId,
    canonicalName: params.canonicalName,
    name: params.name,
    description: params.description,
    path: params.path,
    ...(params.author ? { author: params.author } : {}),
    required,
    systemOwned: params.source === 'global' && required,
    contentSha256: contentSha256(params.content),
  };
}

function scanSkills(params: {
  rootPath: string;
  globalSkillsRoot: string;
  projectSlots?: Set<string>;
  projectWinnerSlots?: Set<string>;
}): Array<Omit<ProjectCapabilityCandidate, 'enabled'>> {
  if (!existsSync(params.rootPath)) return [];
  const root = canonicalDirectory(params.rootPath, false);
  if (!root) {
    console.warn(`[project-capabilities] Ignoring unreadable project Skill root: ${params.rootPath}`);
    return [];
  }
  let entries: Dirent[];
  try {
    entries = readdirSync(root, { withFileTypes: true });
  } catch (error) {
    console.warn('[project-capabilities] Ignoring unreadable project Skill root:', error);
    return [];
  }
  const result: Array<Omit<ProjectCapabilityCandidate, 'enabled'>> = [];
  for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
    if (entry.name.startsWith('.')) continue;
    const projectSlot = `skill:${entry.name}`;
    if (params.projectWinnerSlots?.has(projectSlot)) continue;
    const diskFolder = join(root, entry.name);
    const lst = (() => {
      try { return lstatSync(diskFolder); } catch { return null; }
    })();
    if (!lst) continue;
    if (lst.isSymbolicLink()) {
      if (symlinkTargetIsWithin(diskFolder, params.globalSkillsRoot)) continue;
    }
    params.projectSlots?.add(projectSlot);
    // A symlink under the project Skill root is itself a project-owned
    // declaration. Follow it just like Claude/Codex do; only MyAgents' own
    // global projection links are excluded above so they retain global
    // provenance.
    const folder = canonicalDirectory(diskFolder, true);
    if (!folder || (!lst.isSymbolicLink() && !isWithin(root, folder))) continue;
    const skillPath = canonicalFile(join(folder, 'SKILL.md'), false);
    if (!skillPath || !isWithin(folder, skillPath)) continue;
    try {
      const content = readFileSync(skillPath, 'utf8');
      const parsed = parseFullSkillContent(content);
      const canonicalName = parsed.frontmatter.name?.trim() || entry.name;
      const description = parsed.frontmatter.description?.trim() || '';
      if (!canonicalName) continue;
      result.push(candidate({
        kind: 'skill',
        source: 'project',
        sourceLocalId: entry.name,
        canonicalName,
        name: canonicalName,
        description,
        path: skillPath,
        content,
        author: parsed.frontmatter.author,
      }));
      params.projectWinnerSlots?.add(projectSlot);
    } catch (error) {
      console.warn(`[project-capabilities] Ignoring unreadable project Skill ${entry.name}:`, error);
    }
  }
  return result;
}

function walkCommands(params: {
  root: string;
  current: string;
  source: ProjectCapabilitySource;
  globalCommandsRoot: string;
  depth?: number;
  visited?: Set<string>;
  projectSlots?: Set<string>;
}): Array<Omit<ProjectCapabilityCandidate, 'enabled'>> {
  const depth = params.depth ?? 0;
  if (depth > MAX_COMMAND_SCAN_DEPTH) return [];
  const visited = params.visited ?? new Set<string>();
  const canonicalCurrent = canonicalDirectory(params.current, false);
  if (!canonicalCurrent || !isWithin(params.root, canonicalCurrent) || visited.has(canonicalCurrent)) return [];
  visited.add(canonicalCurrent);
  let entries: Dirent[];
  try {
    entries = readdirSync(canonicalCurrent, { withFileTypes: true });
  } catch (error) {
    console.warn('[project-capabilities] Ignoring unreadable project Command directory:', error);
    return [];
  }
  const result: Array<Omit<ProjectCapabilityCandidate, 'enabled'>> = [];
  for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
    if (entry.name.startsWith('.')) continue;
    const diskPath = join(canonicalCurrent, entry.name);
    const lst = (() => {
      try { return lstatSync(diskPath); } catch { return null; }
    })();
    if (!lst) continue;
    if (params.source === 'project' && lst.isSymbolicLink()) {
      if (symlinkTargetIsWithin(diskPath, params.globalCommandsRoot)) continue;
      const rel = relative(params.root, diskPath).split(sep).join('/');
      if (extname(entry.name).toLowerCase() === '.md') {
        params.projectSlots?.add(`command:${rel.slice(0, -extname(rel).length)}`);
      }
      console.warn(`[project-capabilities] Ignoring foreign project Command symlink: ${entry.name}`);
      continue;
    }
    const rel = relative(params.root, diskPath).split(sep).join('/');
    if (params.source === 'project' && extname(entry.name).toLowerCase() === '.md') {
      params.projectSlots?.add(`command:${rel.slice(0, -extname(rel).length)}`);
    }
    if (entry.isDirectory()) {
      result.push(...walkCommands({ ...params, current: diskPath, depth: depth + 1, visited }));
      continue;
    }
    if (extname(entry.name).toLowerCase() !== '.md') continue;
    const commandPath = canonicalFile(diskPath, false);
    if (!commandPath || !isWithin(params.root, commandPath)) continue;
    try {
      const content = readFileSync(commandPath, 'utf8');
      const parsed = parseFullCommandContent(content);
      if (!parsed.body.trim()) continue;
      // Identity is the lexical location under the source root, never the
      // canonical target of an allowed global symlink.
      const sourceLocalId = rel.slice(0, -extname(rel).length);
      const canonicalName = slashCommandNameFromSourceLocalId(sourceLocalId);
      if (!canonicalName || isReservedSlashCommandName(canonicalName)) continue;
      result.push(candidate({
        kind: 'command',
        source: params.source,
        sourceLocalId,
        canonicalName,
        name: parsed.frontmatter.name?.trim() || canonicalName,
        description: parsed.frontmatter.description?.trim() || '',
        path: commandPath,
        content,
        author: parsed.frontmatter.author,
      }));
    } catch (error) {
      console.warn(`[project-capabilities] Ignoring unreadable project Command ${rel}:`, error);
    }
  }
  return result;
}

function scanCommands(params: {
  rootPath: string;
  source: ProjectCapabilitySource;
  globalCommandsRoot: string;
  projectSlots?: Set<string>;
}): Array<Omit<ProjectCapabilityCandidate, 'enabled'>> {
  if (!existsSync(params.rootPath)) return [];
  const root = canonicalDirectory(params.rootPath, false);
  if (!root) {
    console.warn(`[project-capabilities] Ignoring unreadable Command root: ${params.rootPath}`);
    return [];
  }
  return walkCommands({
    root,
    current: root,
    source: params.source,
    globalCommandsRoot: params.globalCommandsRoot,
    projectSlots: params.projectSlots,
  });
}

function resolveSelection(
  workspacePath: string,
  config: ReturnType<typeof loadConfig>,
): {
  agentId: string;
  selection: ProjectCapabilitySelectionV1;
} {
  const projects = loadProjects();
  const matchingProjects = projects.filter(project => workspacePathsEqual(project.path, workspacePath));
  if (matchingProjects.length !== 1) {
    throw new Error('Workspace has no unique Project owner');
  }
  const project = matchingProjects[0]!;
  if (!project.agentId) throw new Error('Workspace Project has no AgentConfig owner');
  if (projects.filter(candidate => candidate.agentId === project.agentId).length !== 1) {
    throw new Error('Workspace AgentConfig is claimed by multiple Projects');
  }
  const matchingAgents = (config.agents ?? []).filter(candidate => candidate.id === project.agentId);
  if (matchingAgents.length !== 1) {
    throw new Error('Workspace Project has no unique AgentConfig owner');
  }
  const agent = matchingAgents[0]!;
  return {
    agentId: agent.id,
    selection: normalizeProjectCapabilitySelection(agent.capabilitySelection),
  };
}

export function resolveEffectiveProjectCapabilities(
  workspacePath: string,
  options: {
    globalSkillInventory?: GlobalSkillInventorySnapshot;
    projectSkillDirectories?: readonly ProjectSkillDirectory[];
  } = {},
): EffectiveProjectCapabilitySnapshot {
  const resolvedWorkspace = resolve(workspacePath);
  const userRoot = getMyAgentsUserDir();
  const globalSkillsRoot = resolve(userRoot, 'skills');
  const globalCommandsRoot = resolve(userRoot, 'commands');
  const config = loadConfig();
  const cliToolRegistryEnabled = isCliToolRegistryEnabled(config);
  const globalSkillInventory = options.globalSkillInventory
    ?? createGlobalSkillInventorySnapshot({
      rootPath: globalSkillsRoot,
      disabledSkillNames: readDisabledGlobalSkillNames(globalSkillsRoot),
      cliToolRegistryEnabled,
    });
  let agentId = '';
  let selection = emptyProjectCapabilitySelection();
  try {
    ({ agentId, selection } = resolveSelection(resolvedWorkspace, config));
  } catch (error) {
    console.warn(
      '[project-capabilities] No writable selection owner; using the default enabled set:',
      error instanceof Error ? error.message : String(error),
    );
  }

  const projectSlots = new Set<string>();
  const projectWinnerSlots = new Set<string>();
  const projectSkills = (options.projectSkillDirectories ?? DEFAULT_PROJECT_SKILL_DIRECTORIES)
    .flatMap(directory => scanSkills({
      rootPath: join(resolvedWorkspace, ...directory.split('/')),
      globalSkillsRoot,
      projectSlots,
      projectWinnerSlots,
    }));
  const projectCommands = scanCommands({
    rootPath: join(resolvedWorkspace, '.claude', 'commands'),
    source: 'project',
    globalCommandsRoot,
    projectSlots,
  });
  const ranked = [
    ...projectSkills,
    ...globalSkillInventory.projectableEntries
      .flatMap(item => {
        try {
          return [candidate({
            kind: 'skill',
            source: 'global',
            sourceLocalId: item.folderName,
            canonicalName: item.name,
            name: item.name,
            description: item.description,
            path: item.skillPath,
            content: item.content,
            author: item.author,
          })];
        } catch (error) {
          console.warn(
            `[project-capabilities] Ignoring global Skill with invalid capability identity ${item.folderName}:`,
            error instanceof Error ? error.message : String(error),
          );
          return [];
        }
      })
      .filter(item => !projectSlots.has(`skill:${item.sourceLocalId}`)),
    ...projectCommands,
    ...scanCommands({
      rootPath: globalCommandsRoot,
      source: 'global',
      globalCommandsRoot,
    }).filter(item => !projectSlots.has(`command:${item.sourceLocalId}`)),
  ];

  // Source arrays are ranked project before global. Resolve the winner first;
  // disabled winners still occupy the canonical name and never reveal a
  // shadowed global implementation.
  const winnerByKindAndName = new Map<string, Omit<ProjectCapabilityCandidate, 'enabled'>>();
  for (const item of ranked) {
    const key = `${item.kind}:${item.canonicalName}`;
    if (!winnerByKindAndName.has(key)) winnerByKindAndName.set(key, item);
  }
  const candidates = [...winnerByKindAndName.values()]
    .map((item): ProjectCapabilityCandidate => ({
      ...item,
      enabled: item.required || !isCapabilityDisabled(selection, item.kind, item.id),
    }))
    .sort((left, right) => (
      left.kind.localeCompare(right.kind)
      || left.canonicalName.localeCompare(right.canonicalName)
      || left.id.localeCompare(right.id)
    ));

  const revisionProjection = candidates.map(item => ({
    id: item.id,
    kind: item.kind,
    source: item.source,
    sourceLocalId: item.sourceLocalId,
    canonicalName: item.canonicalName,
    enabled: item.enabled,
    required: item.required,
    contentSha256: item.contentSha256,
    path: item.path,
  }));
  const revision = createHash('sha256').update(stableStringify(revisionProjection)).digest('hex');
  return {
    workspacePath: resolvedWorkspace,
    agentId,
    revision,
    integrityRevision: globalSkillInventory.integrityRevision,
    integrityIssues: [...globalSkillInventory.integrityIssues],
    candidates,
    enabledSkills: candidates.filter(item => item.kind === 'skill' && item.enabled),
    enabledCommands: candidates.filter(item => item.kind === 'command' && item.enabled),
  };
}

export async function setProjectCapabilityEnabled(input: {
  workspacePath: string;
  capabilityId: string;
  enabled: boolean;
}): Promise<EffectiveProjectCapabilitySnapshot> {
  return withAgentConfigIntentLock(async () => {
    const owner = resolveSelection(resolve(input.workspacePath), loadConfig());
    const before = resolveEffectiveProjectCapabilities(input.workspacePath);
    if (before.agentId !== owner.agentId) throw new Error('Workspace capability owner changed before save');
    const target = before.candidates.find(item => item.id === input.capabilityId);
    if (!target) throw new Error('Project capability is unavailable or shadowed');
    if (target.required && !input.enabled) throw new Error('Required system Skill cannot be disabled');

    await atomicModifyConfig(config => {
      const agents = [...(config.agents ?? [])];
      const index = agents.findIndex(agent => agent.id === before.agentId);
      if (index < 0) throw new Error('Workspace AgentConfig disappeared before save');
      const selection = normalizeProjectCapabilitySelection(agents[index]!.capabilitySelection);
      const field = target.kind === 'skill' ? 'skills' : 'commands';
      const disabled = new Set(selection.disabled[field]);
      if (input.enabled || target.required) disabled.delete(target.id);
      else disabled.add(target.id);
      agents[index] = {
        ...agents[index]!,
        capabilitySelection: {
          version: 1,
          disabled: {
            ...selection.disabled,
            [field]: [...disabled].sort(),
          },
        },
      };
      return { ...config, agents };
    });
    return resolveEffectiveProjectCapabilities(input.workspacePath);
  });
}

export function projectCapabilitySnapshotForWire(snapshot: EffectiveProjectCapabilitySnapshot) {
  const toSkill = (item: ProjectCapabilityCandidate) => ({
    name: item.name,
    description: item.description,
    scope: item.source === 'global' ? 'user' as const : 'project' as const,
    path: item.path,
    folderName: item.sourceLocalId,
    ...(item.author ? { author: item.author } : {}),
    systemOwned: item.systemOwned,
    required: item.required,
    enabled: item.enabled,
    capabilityId: item.id,
    origin: item.source,
  });
  const toCommand = (item: ProjectCapabilityCandidate) => ({
    name: item.name,
    invocationName: item.canonicalName,
    fileName: item.sourceLocalId,
    description: item.description,
    scope: item.source === 'global' ? 'user' as const : 'project' as const,
    path: item.path,
    ...(item.author ? { author: item.author } : {}),
    enabled: item.enabled,
    required: item.required,
    capabilityId: item.id,
    origin: item.source,
  });
  return {
    success: true,
    revision: snapshot.revision,
    integrityRevision: snapshot.integrityRevision,
    integrityIssues: snapshot.integrityIssues,
    agentId: snapshot.agentId,
    skills: snapshot.candidates.filter(item => item.kind === 'skill').map(toSkill),
    commands: snapshot.candidates.filter(item => item.kind === 'command').map(toCommand),
  };
}

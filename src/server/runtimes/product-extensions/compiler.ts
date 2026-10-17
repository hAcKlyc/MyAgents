import { APP_DATA_DIR_NAME } from '../../../shared/appProfile';
import type { ProductAgentRoleSpec, ProductCommandSpec, ProductSkillSpec } from './contracts';
import { createHash } from 'node:crypto';
import {
  existsSync,
  lstatSync,
  readFileSync,
  readdirSync,
  realpathSync,
  statSync,
} from 'node:fs';
import { basename, extname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import type { Dirent } from 'node:fs';
import type { McpServerDefinition } from '../../../shared/config-types';
import { parseFullAgentContent } from '../../../shared/agentCommands';
import type { AgentWorkspaceConfig } from '../../../shared/agentTypes';
import {
  isReservedSlashCommandName,
  isValidSlashCommandName,
  parseFullCommandContent,
  parseFullSkillContent,
  slashCommandNameFromSourceLocalId,
} from '../../../shared/slashCommands';
import type { InteractionScenario } from '../../system-prompt';
import type {
  GlobalSkillInventoryEntry,
  GlobalSkillInventorySnapshot,
} from '../../global-skill-inventory';
import { isRequiredSystemSkill } from '../../../shared/systemSkills';
import {
  DEFAULT_PROJECT_SKILL_DIRECTORIES,
  type EffectiveProjectCapabilitySnapshot,
  type ProjectCapabilityKind,
  type ProjectSkillDirectory,
} from '../../../shared/projectCapabilities';
import {
  getDefaultEnabledPluginIdsForWorkspace,
  getEnabledPluginSdkConfigs,
  listInstalledPlugins,
} from '../../plugins/store';
import { getHomeDirOrNull } from '../../utils/platform';
import type {
  ProductCommandExpansion,
  ProductExtensionComponentResult,
  ProductExtensionSnapshot,
} from './contracts';
import { projectManagedCodexMcpLaunchConfig } from '../managed-codex/extensions/mcp-launch-projection';

const LEGACY_PLUGIN_SLASH_COMMAND_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9:_-]{0,127}$/;
const MAX_EXTENSION_FILE_BYTES = 1024 * 1024;
const MAX_SCAN_DEPTH = 8;
const AGENT_ROLE_NAME_RE = /^[A-Za-z][A-Za-z0-9_-]{0,63}$/;
const CLAUDE_MODEL_ALIASES = new Set(['sonnet', 'opus', 'haiku']);

type ExtensionScope = 'project' | 'user' | 'plugin';

type TrustedPlugin = {
  id: string;
  root: string;
  manifest: Record<string, unknown>;
};

export interface CompileProductExtensionSnapshotInput {
  workspacePath: string;
  scenario: InteractionScenario;
  enabledPluginIds?: readonly string[] | null;
  mcpServers: readonly McpServerDefinition[];
  /** Test-only/home-independent override. Production uses ~/.myagents. */
  userConfigRoot?: string | null;
  /** Exact project/global winner selection resolved by the shared owner. */
  capabilitySnapshot?: EffectiveProjectCapabilitySnapshot;
  /** Exact global bytes admitted by the shared inventory owner. */
  globalSkillInventory: GlobalSkillInventorySnapshot;
  /** Canonical Skills isolated after compatibility projection failures. */
  unavailableSkillNames?: readonly string[];
  /** DSH supports per-role tool narrowing; managed Codex does not project these fields yet. */
  agentRoleTarget?: 'managed-codex' | 'dsh';
  /** Runtime admission follows complete discovery; omitted admits declarations unchanged. */
  admitSkill?: (skill: ProductSkillSpec, reports: ProductExtensionComponentResult[]) => boolean;
  /** Ordered Host-owned workspace Skill roots. */
  projectSkillDirectories?: readonly ProjectSkillDirectory[];
}

function component(
  componentName: ProductExtensionComponentResult['component'],
  state: ProductExtensionComponentResult['state'],
  code: string,
  id?: string,
  message?: string,
): ProductExtensionComponentResult {
  return {
    component: componentName,
    ...(id ? { id } : {}),
    state,
    code,
    ...(message ? { message } : {}),
  };
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

function secretSafeMcpProjection(server: McpServerDefinition): unknown {
  return {
    id: server.id,
    type: server.type,
    command: server.command,
    args: server.args,
    url: server.url,
    env: Object.fromEntries(Object.keys(server.env ?? {}).sort().map(key => [key, true])),
    headers: Object.fromEntries(Object.entries(server.headers ?? {}).sort(([a], [b]) => a.localeCompare(b)).map(
      ([key, value]) => [key, /\{\{[A-Za-z_][A-Za-z0-9_]*\}\}/.test(value) ? value : '<present>'],
    )),
  };
}

function revisionOf(
  snapshot: Omit<ProductExtensionSnapshot, 'revision' | 'hostToolDispatcher'>,
  capabilityRevision?: string,
): string {
  const projection = {
    capabilityRevision,
    workspacePath: snapshot.workspacePath,
    scenario: snapshot.scenario,
    enabledPluginIds: snapshot.enabledPluginIds,
    skills: snapshot.skills.map(({ path: _path, ...skill }) => skill),
    commands: snapshot.commands.map(({ body, ...command }) => ({
      ...command,
      bodySha256: createHash('sha256').update(body).digest('hex'),
    })),
    agents: snapshot.agents.map(agent => ({
      ...agent,
      promptSha256: createHash('sha256').update(agent.prompt).digest('hex'),
    })),
    mcpServers: snapshot.mcpServers.map(secretSafeMcpProjection),
    dynamicTools: snapshot.dynamicTools,
    components: snapshot.components,
  };
  return createHash('sha256').update(stableStringify(projection)).digest('hex');
}

function isWithin(root: string, candidate: string): boolean {
  const rel = relative(root, candidate);
  return rel === '' || (!rel.startsWith(`..${sep}`) && rel !== '..' && !isAbsolute(rel));
}

function trustedDirectory(path: string): string | null {
  try {
    const lst = lstatSync(path);
    if (!lst.isDirectory() || lst.isSymbolicLink()) return null;
    const canonical = realpathSync(path);
    return statSync(canonical).isDirectory() ? canonical : null;
  } catch {
    return null;
  }
}

function projectSkillDirectory(path: string): string | null {
  try {
    const lst = lstatSync(path);
    if (!lst.isDirectory() && !lst.isSymbolicLink()) return null;
    const canonical = realpathSync(path);
    return statSync(canonical).isDirectory() ? canonical : null;
  } catch {
    return null;
  }
}

function trustedFile(root: string, path: string): string | null {
  try {
    const lst = lstatSync(path);
    if (!lst.isFile() || lst.isSymbolicLink() || lst.size > MAX_EXTENSION_FILE_BYTES) return null;
    const canonical = realpathSync(path);
    if (!isWithin(root, canonical)) return null;
    const stat = statSync(canonical);
    return stat.isFile() && stat.size <= MAX_EXTENSION_FILE_BYTES ? canonical : null;
  } catch {
    return null;
  }
}

function walkMarkdown(root: string, depth = 0, visited = new Set<string>()): string[] {
  if (depth > MAX_SCAN_DEPTH) return [];
  let canonicalRoot: string;
  try {
    canonicalRoot = realpathSync(root);
  } catch {
    return [];
  }
  if (visited.has(canonicalRoot)) return [];
  visited.add(canonicalRoot);
  let entries: Dirent[];
  try {
    entries = readdirSync(canonicalRoot, { withFileTypes: true });
  } catch {
    return [];
  }
  const files: string[] = [];
  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    if (entry.name.startsWith('.')) continue;
    const path = join(canonicalRoot, entry.name);
    if (entry.isDirectory()) {
      files.push(...walkMarkdown(path, depth + 1, visited));
      continue;
    }
    if (!entry.isFile() || extname(entry.name).toLowerCase() !== '.md') continue;
    const safe = trustedFile(canonicalRoot, path);
    if (safe) files.push(safe);
  }
  return files;
}

function resolveTrustedPlugins(enabledPluginIds: readonly string[]): TrustedPlugin[] {
  if (enabledPluginIds.length === 0) return [];
  const trustedRoots = new Set(getEnabledPluginSdkConfigs(enabledPluginIds).map(item => item.path));
  return listInstalledPlugins()
    .filter(item => enabledPluginIds.includes(item.id) && item.enabled && trustedRoots.has(item.installPath))
    .flatMap(item => {
      try {
        const root = realpathSync(item.installPath);
        const manifestPath = trustedFile(root, join(root, '.claude-plugin', 'plugin.json'));
        if (!manifestPath) return [];
        const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as unknown;
        return manifest && typeof manifest === 'object' && !Array.isArray(manifest)
          ? [{ id: item.id, root, manifest: manifest as Record<string, unknown> }]
          : [];
      } catch {
        return [];
      }
    })
    .sort((left, right) => left.id.localeCompare(right.id));
}

function resolvePluginManifestPaths(
  plugin: TrustedPlugin,
  field: 'skills' | 'commands' | 'agents',
  reports: ProductExtensionComponentResult[],
): string[] | null {
  const value = plugin.manifest[field];
  if (value === undefined) return null;
  const paths = typeof value === 'string'
    ? [value]
    : Array.isArray(value) && value.every(entry => typeof entry === 'string')
      ? value as string[]
      : null;
  if (!paths) {
    reports.push(component('plugins', 'failed', `plugin_${field}_manifest_invalid`, plugin.id));
    return [];
  }
  const resolvedPaths: string[] = [];
  for (const relativePath of paths) {
    if (!relativePath.startsWith('./')) {
      reports.push(component('plugins', 'failed', `plugin_${field}_path_invalid`, `${plugin.id}:${relativePath}`));
      continue;
    }
    const candidate = resolve(plugin.root, relativePath);
    const trusted = trustedDirectory(candidate) ?? trustedFile(plugin.root, candidate);
    if (!trusted || !isWithin(plugin.root, trusted)) {
      reports.push(component('plugins', 'failed', `plugin_${field}_path_untrusted`, `${plugin.id}:${relativePath}`));
      continue;
    }
    resolvedPaths.push(trusted);
  }
  return [...new Set(resolvedPaths)].sort();
}

function readSkillFolder(
  root: string,
  folder: string,
  fallbackName: string,
  scope: ExtensionScope,
  sourceId: string,
  reports: ProductExtensionComponentResult[],
): ProductSkillSpec | null {
  const skillPath = trustedFile(root, join(folder, 'SKILL.md'));
  if (!skillPath) return null;
  try {
    const content = readFileSync(skillPath, 'utf8');
    const parsed = parseFullSkillContent(content);
    const name = parsed.frontmatter.name?.trim() || fallbackName;
    const description = parsed.frontmatter.description?.trim() || '';
    if (!name || !description) {
      reports.push(component('skills', 'failed', 'skill_invalid_frontmatter', `${sourceId}:${fallbackName}`, 'Skill requires name and description.'));
      return null;
    }
    reports.push(component('skills', 'applied', 'skill_compiled', `${sourceId}:${name}`));
    return {
      name,
      description,
      frontmatter: parsed.frontmatter,
      contentSha256: createHash('sha256').update(content).digest('hex'),
      path: skillPath,
      scope,
      sourceId,
      sourceLocalId: fallbackName,
    };
  } catch {
    reports.push(component('skills', 'failed', 'skill_read_failed', `${sourceId}:${fallbackName}`));
    return null;
  }
}

function scanSkillsAtRoot(
  rootPath: string,
  scope: ExtensionScope,
  sourceId: string,
  reports: ProductExtensionComponentResult[],
  excludedFolderNames: ReadonlySet<string> = new Set(),
  projectSlots?: Set<string>,
): ProductSkillSpec[] {
  const root = trustedDirectory(rootPath);
  if (!root) return [];
  let entries: Dirent[];
  try {
    entries = readdirSync(root, { withFileTypes: true });
  } catch {
    reports.push(component('skills', 'failed', 'skill_root_read_failed', sourceId));
    return [];
  }
  const skills: ProductSkillSpec[] = [];
  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    if (entry.name.startsWith('.')) continue;
    if (projectSlots?.has(entry.name)) continue;
    if (excludedFolderNames.has(entry.name) && !isRequiredSystemSkill(entry.name)) {
      reports.push(component('skills', 'not_applicable', 'skill_disabled', `${sourceId}:${entry.name}`));
      continue;
    }
    const folder = scope === 'project'
      ? projectSkillDirectory(join(root, entry.name))
      : trustedDirectory(join(root, entry.name));
    if (!folder || (scope !== 'project' && !isWithin(root, folder))) continue;
    const skill = readSkillFolder(scope === 'project' ? folder : root, folder, entry.name, scope, sourceId, reports);
    if (skill) {
      skills.push(skill);
      projectSlots?.add(entry.name);
    }
  }
  return skills;
}

function compileInventorySkill(
  entry: GlobalSkillInventoryEntry,
  reports: ProductExtensionComponentResult[],
): ProductSkillSpec | null {
  const parsed = parseFullSkillContent(entry.content);
  const name = parsed.frontmatter.name?.trim() || entry.name;
  const description = parsed.frontmatter.description?.trim() || '';
  if (!name || !description) {
    reports.push(component(
      'skills',
      'failed',
      'skill_invalid_frontmatter',
      `global:${entry.folderName}`,
      'Skill requires name and description.',
    ));
    return null;
  }
  reports.push(component('skills', 'applied', 'skill_compiled', `global:${name}`));
  return {
    name,
    description,
    frontmatter: parsed.frontmatter,
    contentSha256: createHash('sha256').update(entry.content).digest('hex'),
    path: entry.skillPath,
    scope: 'user',
    sourceId: 'global',
    sourceLocalId: entry.folderName,
  };
}

function scanPluginSkills(
  plugin: TrustedPlugin,
  reports: ProductExtensionComponentResult[],
): ProductSkillSpec[] {
  const skills = scanSkillsAtRoot(join(plugin.root, 'skills'), 'plugin', plugin.id, reports);
  const customPaths = resolvePluginManifestPaths(plugin, 'skills', reports) ?? [];
  for (const path of customPaths) {
    const root = trustedDirectory(path);
    if (!root) {
      reports.push(component('plugins', 'failed', 'plugin_skills_path_not_directory', `${plugin.id}:${path}`));
      continue;
    }
    const direct = readSkillFolder(root, root, basename(root), 'plugin', plugin.id, reports);
    if (direct) {
      skills.push(direct);
    } else {
      skills.push(...scanSkillsAtRoot(root, 'plugin', plugin.id, reports));
    }
  }
  return skills;
}

function mergeSkills(
  groups: Array<{ rank: number; skills: ProductSkillSpec[] }>,
  reports: ProductExtensionComponentResult[],
): ProductSkillSpec[] {
  const byName = new Map<string, { rank: number; skill: ProductSkillSpec }>();
  for (const group of groups.sort((a, b) => b.rank - a.rank)) {
    for (const skill of group.skills) {
      const existing = byName.get(skill.name);
      if (!existing) {
        byName.set(skill.name, { rank: group.rank, skill });
        continue;
      }
      reports.push(component('skills', 'not_applicable', 'skill_shadowed', `${skill.sourceId}:${skill.name}`, `Shadowed by ${existing.skill.sourceId}.`));
    }
  }
  return [...byName.values()].map(entry => entry.skill).sort((a, b) => a.name.localeCompare(b.name));
}

function readCommandFile(
  root: string,
  path: string,
  scope: ExtensionScope,
  sourceId: string,
  reports: ProductExtensionComponentResult[],
): ProductCommandSpec | null {
  const safePath = trustedFile(root, path);
  if (!safePath || extname(safePath).toLowerCase() !== '.md') return null;
  const fallbackName = basename(safePath, extname(safePath));
  try {
    const content = readFileSync(safePath, 'utf8');
    const parsed = parseFullCommandContent(content);
    const sourceLocalId = relative(root, safePath).split(sep).join('/').replace(/\.md$/i, '');
    // Plugin manifests keep their own command naming contract. Product
    // project/global Commands share the capability owner's path-derived token.
    const name = scope === 'plugin'
      ? parsed.frontmatter.name?.trim() || fallbackName
      : slashCommandNameFromSourceLocalId(sourceLocalId);
    const validName = scope === 'plugin'
      ? LEGACY_PLUGIN_SLASH_COMMAND_NAME_RE.test(name ?? '')
      : Boolean(name && isValidSlashCommandName(name));
    if (!name || !validName) {
      reports.push(component('commands', 'failed', 'command_invalid_name', `${sourceId}:${fallbackName}`));
      return null;
    }
    if (isReservedSlashCommandName(name)) {
      reports.push(component('commands', 'unsupported', 'command_reserved_name', `${sourceId}:${name}`));
      return null;
    }
    if (!parsed.body.trim()) {
      reports.push(component('commands', 'failed', 'command_empty_body', `${sourceId}:${name}`));
      return null;
    }
    return {
      name,
      description: parsed.frontmatter.description?.trim() || '',
      body: parsed.body.trim(),
      scope,
      sourceId,
      sourceLocalId,
    };
  } catch {
    reports.push(component('commands', 'failed', 'command_read_failed', `${sourceId}:${fallbackName}`));
    return null;
  }
}

function scanCommandsAtRoot(
  rootPath: string,
  scope: ExtensionScope,
  sourceId: string,
  reports: ProductExtensionComponentResult[],
): ProductCommandSpec[] {
  const root = trustedDirectory(rootPath);
  if (!root) return [];
  const commands: ProductCommandSpec[] = [];
  for (const path of walkMarkdown(root)) {
    const command = readCommandFile(root, path, scope, sourceId, reports);
    if (command) commands.push(command);
  }
  return commands;
}

function scanPluginCommands(
  plugin: TrustedPlugin,
  reports: ProductExtensionComponentResult[],
): ProductCommandSpec[] {
  const configured = resolvePluginManifestPaths(plugin, 'commands', reports);
  if (configured === null) {
    return scanCommandsAtRoot(join(plugin.root, 'commands'), 'plugin', plugin.id, reports);
  }
  const commands: ProductCommandSpec[] = [];
  for (const path of configured) {
    const root = trustedDirectory(path);
    if (root) {
      commands.push(...scanCommandsAtRoot(root, 'plugin', plugin.id, reports));
      continue;
    }
    const command = readCommandFile(plugin.root, path, 'plugin', plugin.id, reports);
    if (command) commands.push(command);
  }
  return commands;
}

function mergeCommands(
  groups: Array<{ rank: number; commands: ProductCommandSpec[] }>,
  reports: ProductExtensionComponentResult[],
): ProductCommandSpec[] {
  const selected = new Map<string, { rank: number; command: ProductCommandSpec }>();
  const conflicted = new Set<string>();
  for (const group of groups.sort((a, b) => b.rank - a.rank)) {
    const withinGroup = new Map<string, ProductCommandSpec[]>();
    for (const command of group.commands) {
      const entries = withinGroup.get(command.name) ?? [];
      entries.push(command);
      withinGroup.set(command.name, entries);
    }
    for (const [name, entries] of withinGroup) {
      const existing = selected.get(name);
      if (existing) {
        for (const entry of entries) {
          reports.push(component('commands', 'not_applicable', 'command_shadowed', `${entry.sourceId}:${name}`, `Shadowed by ${existing.command.sourceId}.`));
        }
        continue;
      }
      if (entries.length > 1) {
        conflicted.add(name);
        for (const entry of entries) {
          reports.push(component('commands', 'failed', 'command_name_conflict', `${entry.sourceId}:${name}`));
        }
        continue;
      }
      if (!conflicted.has(name)) selected.set(name, { rank: group.rank, command: entries[0]! });
    }
  }
  for (const entry of selected.values()) {
    reports.push(component('commands', 'applied', 'command_compiled', `${entry.command.sourceId}:${entry.command.name}`));
  }
  return [...selected.values()].map(entry => entry.command).sort((a, b) => a.name.localeCompare(b.name));
}

type LooseAgentDefinition = {
  description?: unknown;
  prompt?: unknown;
  tools?: unknown;
  disallowedTools?: unknown;
  model?: unknown;
  skills?: unknown;
  maxTurns?: unknown;
  permissionMode?: unknown;
  memory?: unknown;
  hooks?: unknown;
  scope?: unknown;
  folderName?: unknown;
};

function readTrustedWorkspaceAgentConfig(
  projectAgentsRoot: string,
  reports: ProductExtensionComponentResult[],
): AgentWorkspaceConfig {
  const fallback: AgentWorkspaceConfig = { local: {}, global_refs: {} };
  const root = trustedDirectory(projectAgentsRoot);
  if (!root) return fallback;
  const configPath = join(root, '_workspace.json');
  if (!existsSync(configPath)) return fallback;
  const safePath = trustedFile(root, configPath);
  if (!safePath) {
    reports.push(component('agents', 'failed', 'agent_workspace_config_untrusted', 'workspace-config'));
    return fallback;
  }
  try {
    const parsed = JSON.parse(readFileSync(safePath, 'utf8')) as unknown;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('invalid config');
    const normalizeEntries = (value: unknown): Record<string, { enabled: boolean }> => {
      if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
      return Object.fromEntries(Object.entries(value).flatMap(([key, entry]) => {
        if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return [];
        const enabled = (entry as { enabled?: unknown }).enabled;
        return typeof enabled === 'boolean' ? [[key, { enabled }]] : [];
      }));
    };
    const value = parsed as { local?: unknown; global_refs?: unknown };
    return {
      local: normalizeEntries(value.local),
      global_refs: normalizeEntries(value.global_refs),
    };
  } catch {
    reports.push(component('agents', 'failed', 'agent_workspace_config_invalid', 'workspace-config'));
    return fallback;
  }
}

function loadTrustedEnabledAgentDefinitions(
  projectAgentsRoot: string,
  userAgentsRoot: string,
  reports: ProductExtensionComponentResult[],
): {
  project: Record<string, LooseAgentDefinition>;
  user: Record<string, LooseAgentDefinition>;
} {
  const workspaceConfig = readTrustedWorkspaceAgentConfig(projectAgentsRoot, reports);
  const result = {
    project: {} as Record<string, LooseAgentDefinition>,
    user: {} as Record<string, LooseAgentDefinition>,
  };
  for (const [rootPath, scope] of [
    [projectAgentsRoot, 'project'],
    [userAgentsRoot, 'user'],
  ] as const) {
    const root = trustedDirectory(rootPath);
    if (!root) continue;
    const byFolder = new Map<string, { rank: number; path: string }>();
    for (const path of walkMarkdown(root)) {
      const relativeStem = relative(root, path).split(sep).join('/').replace(/\.md$/i, '');
      const parts = relativeStem.split('/');
      const stem = parts.at(-1) ?? relativeStem;
      const isFolderLayout = parts.length > 1 && parts.at(-2) === stem;
      const folderName = isFolderLayout ? parts.slice(0, -1).join('/') : relativeStem;
      const rank = isFolderLayout ? 3 : parts.length === 1 ? 2 : 1;
      const existing = byFolder.get(folderName);
      if (!existing || rank > existing.rank) byFolder.set(folderName, { rank, path });
    }
    const byName = new Map<string, LooseAgentDefinition[]>();
    for (const [folderName, candidate] of [...byFolder].sort(([a], [b]) => a.localeCompare(b))) {
      const enabled = scope === 'project'
        ? workspaceConfig.local[folderName]?.enabled !== false
        : workspaceConfig.global_refs[folderName]?.enabled !== false;
      if (!enabled) continue;
      try {
        const { frontmatter, body } = parseFullAgentContent(readFileSync(candidate.path, 'utf8'));
        const name = frontmatter.name?.trim() || folderName;
        const entries = byName.get(name) ?? [];
        entries.push({
          description: frontmatter.description,
          prompt: body.trim(),
          tools: frontmatter.tools?.split(',').map(tool => tool.trim()).filter(Boolean),
          disallowedTools: frontmatter.disallowedTools?.split(',').map(tool => tool.trim()).filter(Boolean),
          model: frontmatter.model,
          skills: frontmatter.skills,
          maxTurns: frontmatter.maxTurns,
          permissionMode: frontmatter.permissionMode,
          memory: frontmatter.memory,
          hooks: frontmatter.hooks,
          scope,
          folderName,
        });
        byName.set(name, entries);
      } catch {
        reports.push(component('agents', 'failed', 'agent_read_failed', `${scope}:${folderName}`));
      }
    }
    for (const [name, definitions] of byName) {
      if (definitions.length > 1) {
        reports.push(component('agents', 'failed', 'agent_name_conflict', `${scope}:${name}`));
        continue;
      }
      result[scope][name] = definitions[0]!;
    }
  }
  return result;
}

function compileAgentDefinitions(
  source: Record<string, LooseAgentDefinition>,
  scope: 'project' | 'user',
  sourcePrefix: string,
  skills: readonly ProductSkillSpec[],
  reports: ProductExtensionComponentResult[],
  agentRoleTarget: 'managed-codex' | 'dsh',
): ProductAgentRoleSpec[] {
  const bySkill = new Map(skills.map(skill => [skill.name, skill]));
  const roles: ProductAgentRoleSpec[] = [];
  for (const [name, definition] of Object.entries(source).sort(([a], [b]) => a.localeCompare(b))) {
    if ((definition.scope === 'project' ? 'project' : 'user') !== scope) continue;
    const sourceId = `${sourcePrefix}:${name}`;
    if (!AGENT_ROLE_NAME_RE.test(name)) {
      reports.push(component('agents', 'failed', 'agent_invalid_role_name', sourceId));
      continue;
    }
    const unsupported = [
      agentRoleTarget === 'managed-codex' && Array.isArray(definition.tools) && definition.tools.length > 0 ? 'tools' : null,
      agentRoleTarget === 'managed-codex' && Array.isArray(definition.disallowedTools) && definition.disallowedTools.length > 0 ? 'disallowedTools' : null,
      agentRoleTarget === 'managed-codex' && definition.maxTurns !== undefined ? 'maxTurns' : null,
      typeof definition.model === 'string' && CLAUDE_MODEL_ALIASES.has(definition.model) ? 'model' : null,
      definition.permissionMode !== undefined ? 'permissionMode' : null,
      definition.memory !== undefined ? 'memory' : null,
      definition.hooks !== undefined ? 'hooks' : null,
    ].filter((field): field is string => Boolean(field));
    if (unsupported.length > 0) {
      reports.push(component('agents', 'unsupported', 'agent_unsupported_fields', sourceId, `Unsupported fields: ${unsupported.join(', ')}`));
      continue;
    }
    if (typeof definition.description !== 'string' || !definition.description.trim()
      || typeof definition.prompt !== 'string' || !definition.prompt.trim()) {
      reports.push(component('agents', 'failed', 'agent_invalid_definition', sourceId, 'Agent requires description and prompt.'));
      continue;
    }
    const tools = Array.isArray(definition.tools)
      ? definition.tools.filter((entry): entry is string => typeof entry === 'string' && Boolean(entry.trim())).map(entry => entry.trim())
      : undefined;
    const disallowedTools = Array.isArray(definition.disallowedTools)
      ? definition.disallowedTools.filter((entry): entry is string => typeof entry === 'string' && Boolean(entry.trim())).map(entry => entry.trim())
      : undefined;
    const maxTurns = Number.isSafeInteger(definition.maxTurns) && (definition.maxTurns as number) >= 1
      && (definition.maxTurns as number) <= 10_000
      ? definition.maxTurns as number
      : undefined;
    if (agentRoleTarget === 'dsh' && (
      (definition.tools !== undefined && !Array.isArray(definition.tools))
      || (definition.disallowedTools !== undefined && !Array.isArray(definition.disallowedTools))
      || (definition.maxTurns !== undefined && maxTurns === undefined)
    )) {
      reports.push(component('agents', 'failed', 'agent_invalid_definition', sourceId, 'Agent tool policy is invalid.'));
      continue;
    }
    const requestedSkills = Array.isArray(definition.skills)
      ? definition.skills.filter((entry): entry is string => typeof entry === 'string')
      : [];
    const missing = requestedSkills.filter(skill => !bySkill.has(skill));
    if (missing.length > 0) {
      reports.push(component('agents', 'unsupported', 'agent_missing_skill', sourceId, `Missing Skills: ${missing.join(', ')}`));
      continue;
    }
    const model = typeof definition.model === 'string' && definition.model !== 'inherit'
      ? definition.model
      : undefined;
    roles.push({
      name,
      description: definition.description.trim(),
      prompt: definition.prompt.trim(),
      ...(model ? { model } : {}),
      ...(tools === undefined ? {} : { tools }),
      ...(disallowedTools === undefined ? {} : { disallowedTools }),
      ...(maxTurns === undefined ? {} : { maxTurns }),
      skills: requestedSkills.map(skill => ({ name: skill, path: bySkill.get(skill)!.path })),
      scope,
      sourceId,
    });
    reports.push(component('agents', 'applied', 'agent_compiled', sourceId));
  }
  return roles;
}

function scanPluginAgents(
  plugins: readonly TrustedPlugin[],
  skills: readonly ProductSkillSpec[],
  reports: ProductExtensionComponentResult[],
  agentRoleTarget: 'managed-codex' | 'dsh',
): ProductAgentRoleSpec[] {
  const bySkill = new Map(skills.map(skill => [skill.name, skill]));
  const roles: ProductAgentRoleSpec[] = [];
  for (const plugin of plugins) {
    const configured = resolvePluginManifestPaths(plugin, 'agents', reports);
    const paths = configured === null
      ? walkMarkdown(join(plugin.root, 'agents'))
      : configured.flatMap(path => trustedDirectory(path) ? walkMarkdown(path) : [path]);
    for (const path of paths) {
      if (!trustedFile(plugin.root, path) || extname(path).toLowerCase() !== '.md') {
        reports.push(component('plugins', 'failed', 'plugin_agents_path_not_markdown', `${plugin.id}:${path}`));
        continue;
      }
      const fallbackName = basename(path, extname(path));
      const sourceId = `${plugin.id}:${fallbackName}`;
      try {
        const parsed = parseFullAgentContent(readFileSync(path, 'utf8'));
        const name = parsed.frontmatter.name?.trim() || fallbackName;
        if (!AGENT_ROLE_NAME_RE.test(name) || !parsed.frontmatter.description?.trim() || !parsed.body.trim()) {
          reports.push(component('agents', 'failed', 'agent_invalid_definition', sourceId));
          continue;
        }
        const unsupported = [
          agentRoleTarget === 'managed-codex' && parsed.frontmatter.tools ? 'tools' : null,
          agentRoleTarget === 'managed-codex' && parsed.frontmatter.disallowedTools ? 'disallowedTools' : null,
          agentRoleTarget === 'managed-codex' && parsed.frontmatter.maxTurns !== undefined ? 'maxTurns' : null,
          parsed.frontmatter.model && CLAUDE_MODEL_ALIASES.has(parsed.frontmatter.model) ? 'model' : null,
          parsed.frontmatter.permissionMode !== undefined ? 'permissionMode' : null,
          parsed.frontmatter.memory !== undefined ? 'memory' : null,
          parsed.frontmatter.hooks !== undefined ? 'hooks' : null,
        ].filter((field): field is string => Boolean(field));
        if (unsupported.length > 0) {
          reports.push(component('agents', 'unsupported', 'agent_unsupported_fields', sourceId, `Unsupported fields: ${unsupported.join(', ')}`));
          continue;
        }
        const requestedSkills = parsed.frontmatter.skills ?? [];
        const missing = requestedSkills.filter(skill => !bySkill.has(skill));
        if (missing.length > 0) {
          reports.push(component('agents', 'unsupported', 'agent_missing_skill', sourceId, `Missing Skills: ${missing.join(', ')}`));
          continue;
        }
        roles.push({
          name,
          description: parsed.frontmatter.description.trim(),
          prompt: parsed.body.trim(),
          ...(parsed.frontmatter.model && parsed.frontmatter.model !== 'inherit'
            ? { model: parsed.frontmatter.model }
            : {}),
          ...(parsed.frontmatter.tools
            ? { tools: parsed.frontmatter.tools.split(',').map(tool => tool.trim()).filter(Boolean) }
            : {}),
          ...(parsed.frontmatter.disallowedTools
            ? { disallowedTools: parsed.frontmatter.disallowedTools.split(',').map(tool => tool.trim()).filter(Boolean) }
            : {}),
          ...(parsed.frontmatter.maxTurns === undefined ? {} : { maxTurns: parsed.frontmatter.maxTurns }),
          skills: requestedSkills.map(skill => ({ name: skill, path: bySkill.get(skill)!.path })),
          scope: 'plugin',
          sourceId: plugin.id,
        });
        reports.push(component('agents', 'applied', 'agent_compiled', `${plugin.id}:${name}`));
      } catch {
        reports.push(component('agents', 'failed', 'agent_read_failed', sourceId));
      }
    }
  }
  return roles;
}

function mergeAgents(
  groups: Array<{ rank: number; agents: ProductAgentRoleSpec[] }>,
  reports: ProductExtensionComponentResult[],
): ProductAgentRoleSpec[] {
  const selected = new Map<string, ProductAgentRoleSpec>();
  for (const group of groups.sort((a, b) => b.rank - a.rank)) {
    for (const agent of group.agents) {
      const existing = selected.get(agent.name);
      if (existing) {
        reports.push(component('agents', 'not_applicable', 'agent_shadowed', `${agent.sourceId}:${agent.name}`, `Shadowed by ${existing.sourceId}.`));
        continue;
      }
      selected.set(agent.name, agent);
    }
  }
  return [...selected.values()].sort((a, b) => a.name.localeCompare(b.name));
}

function reportUnsupportedPluginComponents(
  plugins: readonly TrustedPlugin[],
  reports: ProductExtensionComponentResult[],
): void {
  const fileComponents = [
    ['hooks/hooks.json', 'plugin_hooks_unsupported'],
    ['.lsp.json', 'plugin_lsp_unsupported'],
    ['monitors/monitors.json', 'plugin_monitors_unsupported'],
  ] as const;
  for (const plugin of plugins) {
    const reportedCodes = new Set<string>();
    for (const [field, code] of [
      ['hooks', 'plugin_hooks_unsupported'],
      ['lspServers', 'plugin_lsp_unsupported'],
      ['monitors', 'plugin_monitors_unsupported'],
    ] as const) {
      if (plugin.manifest[field] !== undefined) {
        reports.push(component('plugins', 'unsupported', code, plugin.id));
        reportedCodes.add(code);
      }
    }
    for (const [relativePath, code] of fileComponents) {
      if (!reportedCodes.has(code) && trustedFile(plugin.root, join(plugin.root, relativePath))) {
        reports.push(component('plugins', 'unsupported', code, plugin.id));
      }
    }
    const binRoot = trustedDirectory(join(plugin.root, 'bin'));
    if (binRoot) {
      try {
        if (readdirSync(binRoot).length > 0) {
          reports.push(component('plugins', 'unsupported', 'plugin_bin_unsupported', plugin.id));
        }
      } catch {
        reports.push(component('plugins', 'failed', 'plugin_bin_read_failed', plugin.id));
      }
    }
  }
}

function pluginMcpServers(
  plugins: readonly TrustedPlugin[],
  reports: ProductExtensionComponentResult[],
): McpServerDefinition[] {
  const servers: McpServerDefinition[] = [];
  for (const plugin of plugins) {
    const sources: unknown[] = [];
    const defaultPath = trustedFile(plugin.root, join(plugin.root, '.mcp.json'));
    if (defaultPath) sources.push(`./${relative(plugin.root, defaultPath).split(sep).join('/')}`);
    const manifestMcp = plugin.manifest.mcpServers;
    if (manifestMcp !== undefined) {
      if (Array.isArray(manifestMcp)) sources.push(...manifestMcp);
      else sources.push(manifestMcp);
    }
    const definitions = new Map<string, Record<string, unknown>>();
    for (const source of sources) {
      let rawDefinitions: unknown = source;
      if (typeof source === 'string') {
        if (!source.startsWith('./')) {
          reports.push(component('mcp', 'unsupported', 'plugin_mcp_source_unsupported', `${plugin.id}:${source}`));
          continue;
        }
        const mcpPath = trustedFile(plugin.root, resolve(plugin.root, source));
        if (!mcpPath || extname(mcpPath).toLowerCase() !== '.json') {
          reports.push(component('mcp', 'failed', 'plugin_mcp_path_untrusted', `${plugin.id}:${source}`));
          continue;
        }
        try {
          const parsed = JSON.parse(readFileSync(mcpPath, 'utf8')) as unknown;
          rawDefinitions = parsed && typeof parsed === 'object' && !Array.isArray(parsed)
            ? (parsed as { mcpServers?: unknown }).mcpServers ?? parsed
            : null;
        } catch {
          reports.push(component('mcp', 'failed', 'plugin_mcp_read_failed', `${plugin.id}:${source}`));
          continue;
        }
      }
      if (!rawDefinitions || typeof rawDefinitions !== 'object' || Array.isArray(rawDefinitions)) {
        reports.push(component('mcp', 'failed', 'plugin_mcp_invalid', plugin.id));
        continue;
      }
      for (const [name, raw] of Object.entries(rawDefinitions as Record<string, unknown>)) {
        if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
          reports.push(component('mcp', 'failed', 'plugin_mcp_invalid', `${plugin.id}:${name}`));
          continue;
        }
        if (definitions.has(name)) {
          reports.push(component('mcp', 'failed', 'plugin_mcp_name_conflict', `${plugin.id}:${name}`));
          continue;
        }
        definitions.set(name, raw as Record<string, unknown>);
      }
    }
    for (const [name, raw] of [...definitions].sort(([a], [b]) => a.localeCompare(b))) {
      try {
        const id = `plugin__${plugin.id.replace(/[^A-Za-z0-9_-]/g, '_')}__${name}`;
        if (typeof raw.command === 'string') {
          const replaceRoot = (value: string): string => value.replaceAll('${CLAUDE_PLUGIN_ROOT}', plugin.root);
          servers.push({
            id,
            name: `${plugin.id}: ${name}`,
            type: 'stdio',
            command: replaceRoot(raw.command),
            args: Array.isArray(raw.args) ? raw.args.filter((entry): entry is string => typeof entry === 'string').map(replaceRoot) : [],
            env: raw.env && typeof raw.env === 'object' && !Array.isArray(raw.env)
              ? Object.fromEntries(Object.entries(raw.env).filter((entry): entry is [string, string] => typeof entry[1] === 'string').map(([key, value]) => [key, replaceRoot(value)]))
              : undefined,
            isBuiltin: false,
          });
          continue;
        }
        const url = typeof raw.url === 'string' ? raw.url : undefined;
        if (url) {
          if (raw.type === 'sse') {
            reports.push(component('mcp', 'unsupported', 'plugin_mcp_sse_unsupported', `${plugin.id}:${name}`));
            continue;
          }
          const replaceRoot = (value: string): string => value.replaceAll('${CLAUDE_PLUGIN_ROOT}', plugin.root);
          servers.push({
            id,
            name: `${plugin.id}: ${name}`,
            type: 'http',
            url: replaceRoot(url),
            env: raw.env && typeof raw.env === 'object' && !Array.isArray(raw.env)
              ? Object.fromEntries(Object.entries(raw.env).filter((entry): entry is [string, string] => typeof entry[1] === 'string').map(([key, value]) => [key, replaceRoot(value)]))
              : undefined,
            headers: raw.headers && typeof raw.headers === 'object' && !Array.isArray(raw.headers)
              ? Object.fromEntries(Object.entries(raw.headers).filter((entry): entry is [string, string] => typeof entry[1] === 'string').map(([key, value]) => [key, replaceRoot(value)]))
              : undefined,
            isBuiltin: false,
          });
          continue;
        }
        reports.push(component('mcp', 'unsupported', 'plugin_mcp_transport_unsupported', `${plugin.id}:${name}`));
      } catch {
        reports.push(component('mcp', 'failed', 'plugin_mcp_invalid', `${plugin.id}:${name}`));
      }
    }
  }
  return servers;
}

function mergeMcpServers(
  base: readonly McpServerDefinition[],
  plugin: readonly McpServerDefinition[],
  reports: ProductExtensionComponentResult[],
): McpServerDefinition[] {
  const selected = new Map<string, McpServerDefinition>();
  for (const server of base) {
    selected.set(server.id, { ...server });
  }
  for (const server of plugin) {
    if (selected.has(server.id)) {
      reports.push(component('mcp', 'failed', 'mcp_id_conflict', server.id));
      continue;
    }
    selected.set(server.id, server);
  }
  const candidates = [...selected.values()].sort((a, b) => a.id.localeCompare(b.id));
  // The same adapter-owned compiler is used at config admission and process
  // launch. This makes deterministic argv/env rejection a component result
  // before Session birth instead of a fatal exception after user dispatch.
  const projection = projectManagedCodexMcpLaunchConfig(candidates, {});
  const acceptedIds = new Set(projection.acceptedServerIds);
  const failures = new Map(projection.failures.map(failure => [failure.serverId, failure]));
  for (const server of candidates) {
    const failure = failures.get(server.id);
    if (failure) {
      reports.push(component(
        'mcp',
        failure.state,
        failure.code,
        server.id,
        failure.message,
      ));
      continue;
    }
    if (acceptedIds.has(server.id)) {
      reports.push(component(
        'mcp',
        'applied',
        server.id.startsWith('plugin__') ? 'plugin_mcp_compiled' : 'mcp_compiled',
        server.id,
      ));
    }
  }
  return candidates.filter(server => acceptedIds.has(server.id));
}

export function compileProductExtensionSnapshot(
  input: CompileProductExtensionSnapshotInput,
): ProductExtensionSnapshot {
  const reports: ProductExtensionComponentResult[] = [
    component('scenario', 'applied', 'scenario_compiled'),
  ];
  const userConfigRoot = input.userConfigRoot === undefined
    ? (getHomeDirOrNull() ? join(getHomeDirOrNull()!, APP_DATA_DIR_NAME) : null)
    : input.userConfigRoot;
  const enabledPluginIds = [...new Set(
    input.enabledPluginIds == null
      ? getDefaultEnabledPluginIdsForWorkspace(input.workspacePath)
      : input.enabledPluginIds,
  )].sort();
  const plugins = resolveTrustedPlugins(enabledPluginIds);
  const unavailablePluginIds = enabledPluginIds.filter(id => !plugins.some(plugin => plugin.id === id));
  for (const id of unavailablePluginIds) {
    reports.push(component('plugins', 'failed', 'plugin_unavailable', id));
  }
  for (const plugin of plugins) {
    reports.push(component('plugins', 'applied', 'plugin_enabled', plugin.id));
  }
  reportUnsupportedPluginComponents(plugins, reports);

  const filterSelected = <T extends { scope: ExtensionScope; sourceId: string; sourceLocalId?: string; name: string }>(
    items: T[],
    kind: ProjectCapabilityKind,
  ): T[] => {
    if (!input.capabilitySnapshot) return items;
    const enabledCandidates = kind === 'skill'
      ? input.capabilitySnapshot.enabledSkills
      : input.capabilitySnapshot.enabledCommands;
    return items.filter(item => {
      if (item.scope === 'plugin') return true;
      if (!item.sourceLocalId) return false;
      const source = item.scope === 'project' ? 'project' : 'global';
      const enabled = enabledCandidates.some(candidate => (
        candidate.source === source
        && candidate.sourceLocalId === item.sourceLocalId
        && candidate.canonicalName === item.name
      ));
      if (!enabled) {
        reports.push(component(
          kind === 'skill' ? 'skills' : 'commands',
          'not_applicable',
          kind === 'skill' ? 'skill_project_disabled' : 'command_project_disabled',
          `${item.sourceId}:${item.name}`,
        ));
      }
      return enabled;
    });
  };

  const projectSkillSlots = new Set<string>();
  const projectSkills = filterSelected(
    (input.projectSkillDirectories ?? DEFAULT_PROJECT_SKILL_DIRECTORIES)
      .flatMap(directory => scanSkillsAtRoot(
        join(input.workspacePath, ...directory.split('/')),
        'project',
        'workspace',
        reports,
        new Set(),
        projectSkillSlots,
      )),
    'skill',
  );
  const userSkills = filterSelected(
    input.globalSkillInventory.entries.flatMap(entry => {
      if (!entry.enabledForProjection) {
        reports.push(component(
          'skills',
          'not_applicable',
          'skill_disabled',
          `global:${entry.name}`,
        ));
        return [];
      }
      const skill = compileInventorySkill(entry, reports);
      return skill ? [skill] : [];
    }),
    'skill',
  );
  const pluginSkillGroups = plugins.map(plugin => ({
    rank: 1,
    skills: scanPluginSkills(plugin, reports),
  }));
  const unavailableSkillNames = new Set(input.unavailableSkillNames ?? []);
  const admit = (items: ProductSkillSpec[]) => items.filter(skill => input.admitSkill?.(skill, reports) ?? true);
  const skills = mergeSkills([
    { rank: 3, skills: admit(projectSkills) },
    { rank: 2, skills: admit(userSkills) },
    ...pluginSkillGroups.map(group => ({ ...group, skills: admit(group.skills) })),
  ], reports).filter(skill => {
    if (!unavailableSkillNames.has(skill.name)) return true;
    reports.push(component(
      'skills',
      'failed',
      'skill_projection_unavailable',
      `${skill.sourceId}:${skill.name}`,
    ));
    return false;
  });

  const projectCommands = filterSelected(
    scanCommandsAtRoot(join(input.workspacePath, '.claude', 'commands'), 'project', 'workspace', reports),
    'command',
  );
  const userCommands = userConfigRoot
    ? filterSelected(
        scanCommandsAtRoot(join(userConfigRoot, 'commands'), 'user', 'global', reports),
        'command',
      )
    : [];
  const pluginCommandGroups = plugins.map(plugin => ({
    rank: 1,
    commands: scanPluginCommands(plugin, reports),
  }));
  const commands = mergeCommands([
    { rank: 3, commands: projectCommands },
    { rank: 2, commands: userCommands },
    ...pluginCommandGroups,
  ], reports);

  const userAgentsRoot = userConfigRoot ? join(userConfigRoot, 'agents') : '';
  const projectAgentsRoot = join(input.workspacePath, '.claude', 'agents');
  const enabledAgents = loadTrustedEnabledAgentDefinitions(
    projectAgentsRoot,
    userAgentsRoot,
    reports,
  );
  const agentRoleTarget = input.agentRoleTarget ?? 'managed-codex';
  const projectAgents = compileAgentDefinitions(enabledAgents.project, 'project', 'workspace', skills, reports, agentRoleTarget);
  const userAgents = compileAgentDefinitions(enabledAgents.user, 'user', 'global', skills, reports, agentRoleTarget);
  const pluginAgents = scanPluginAgents(plugins, skills, reports, agentRoleTarget);
  const agents = mergeAgents([
    { rank: 3, agents: projectAgents },
    { rank: 2, agents: userAgents },
    { rank: 1, agents: pluginAgents },
  ], reports);
  const mcpServers = mergeMcpServers(input.mcpServers, pluginMcpServers(plugins, reports), reports);

  const snapshotWithoutRevision: Omit<ProductExtensionSnapshot, 'revision' | 'hostToolDispatcher'> = {
    workspacePath: resolve(input.workspacePath),
    scenario: input.scenario,
    enabledPluginIds,
    skills,
    commands,
    agents,
    mcpServers,
    dynamicTools: [],
    components: reports,
  };
  return {
    ...snapshotWithoutRevision,
    revision: revisionOf(snapshotWithoutRevision, input.capabilitySnapshot?.revision),
  };
}

export function compileProductCommand(
  rawText: string,
  snapshot: Pick<ProductExtensionSnapshot, 'revision' | 'commands'>,
): ProductCommandExpansion | null {
  const match = /^\/([^\s]+)(?:\s+([\s\S]*))?$/.exec(rawText);
  if (!match) return null;
  const commandName = match[1]!;
  if (isReservedSlashCommandName(commandName)) return null;
  const command = snapshot.commands.find(candidate => candidate.name === commandName);
  if (!command) return null;
  const args = match[2]?.trim() ?? '';
  const hasArgumentsPlaceholder = command.body.includes('$ARGUMENTS');
  const expanded = command.body.replaceAll('$ARGUMENTS', args);
  return {
    commandName,
    rawText,
    runtimeText: args && !hasArgumentsPlaceholder
      ? `${expanded}\n\nArguments:\n${args}`
      : expanded,
    revision: snapshot.revision,
  };
}

export function __revisionForManagedCodexExtensionTests(value: unknown): string {
  return createHash('sha256').update(stableStringify(value)).digest('hex');
}

import { parseFullSkillContent } from '../../../shared/slashCommands';
import { createHash, createHmac, randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { basename, dirname, isAbsolute, relative, resolve, sep } from 'node:path';

import type { McpServerDefinition } from '../../../shared/config-types';
import type { RuntimeExtensionComponentStatus } from '../../../shared/types/runtime';
import type {
  ProductAgentRoleSpec,
  ProductCommandSpec,
  ProductSkillSpec,
} from '../../runtimes/product-extensions/contracts';
import type {
  ProductDynamicToolSpec,
  ProductHostToolDispatcher,
} from '../../runtimes/product-extensions/contracts';
import { buildMcpSubprocessEnv } from '../../session-core/mcp-env-policy';
import { resolveStdioMcpLaunch } from '../../runtimes/managed-codex/extensions/mcp-launch-projection';
import type { DshRpcObject, MethodParams } from './protocol-types';

const MAX_RESOURCE_CHARACTERS = 1_000_000;
const DECLARATIVE_REFERENCE = /^[A-Za-z][A-Za-z0-9._:-]*$/u;
const DSH_COMMAND_NAME = /^[a-z][a-z0-9_-]{0,255}$/u;
// The accepted Runtime compiler is narrower than protocol declarativeReference:
// server, remote, and rendered public tool identities must all fit this bound.
const HOST_TOOL_NAME = /^[A-Za-z0-9_-]{1,64}$/u;
const MCP_NAME = HOST_TOOL_NAME;
const MAX_DSH_SKILL_SOURCE_ROOTS = 128;
const MAX_DSH_MCP_LAUNCH_PROFILES = 128;
const PROPERTY_NAME = /^[A-Za-z_][A-Za-z0-9_.-]{0,127}$/u;
const SCHEMA_TYPES = new Set(['object', 'array', 'string', 'number', 'integer', 'boolean', 'null']);
const MCP_ENV_REVISION_KEY = randomBytes(32);

export type DshExtensionSnapshot = Extract<MethodParams<'extension/replace'>, { formatVersion: 1 }>;
type DshComponent = DshExtensionSnapshot['components'][number];
type DshResource = DshExtensionSnapshot['resources'][number];
type DshSkillRoot = DshExtensionSnapshot['skillSourcePolicy']['roots'][number];
type DshMcpLaunchProfile = NonNullable<DshExtensionSnapshot['mcpLaunchPolicy']>['profiles'][number];

export type DshProductExtensionSource = Readonly<{
  revision: string;
  workspacePath?: string;
  skills: readonly ProductSkillSpec[];
  commands: readonly ProductCommandSpec[];
  agents: readonly ProductAgentRoleSpec[];
  mcpServers: readonly McpServerDefinition[];
  dynamicTools: readonly ProductDynamicToolSpec[];
  hostToolDispatcher?: ProductHostToolDispatcher;
  components?: readonly RuntimeExtensionComponentStatus[];
}>;

export type DshMcpCredentialBinding = Readonly<{
  componentId: string;
  credentialRef: string;
  credentialRevision: string;
  materialSlot: 'env' | 'header';
  material: Readonly<Record<string, string>>;
}>;

export type DshHostToolBinding = Readonly<{
  publicToolName: string;
  dispatcherToolName: string;
}>;

export type DshCompiledExtensionPlane = Readonly<{
  snapshot: DshExtensionSnapshot;
  credentialBindings: readonly DshMcpCredentialBinding[];
  hostToolBindings: readonly DshHostToolBinding[];
  hostToolDispatcher?: ProductHostToolDispatcher;
  expectedSkillNames: readonly string[];
  diagnostics: readonly RuntimeExtensionComponentStatus[];
}>;

export function dshExtensionGenerationId(plane: DshCompiledExtensionPlane): string {
  return `${plane.snapshot.revision}:${plane.snapshot.digest}`;
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    const record = value as Readonly<Record<string, unknown>>;
    return `{${Object.keys(record)
      .sort()
      .map(key => `${JSON.stringify(key)}:${stableJson(record[key])}`)
      .join(',')}}`;
  }
  return JSON.stringify(value);
}

function deepFreeze<T>(value: T): T {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value;
  for (const entry of Object.values(value as Record<string, unknown>)) deepFreeze(entry);
  return Object.freeze(value);
}

function digest(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function safeReference(prefix: string, identity: string): string {
  return `${prefix}-${digest(identity)}`;
}

function boundedText(value: string, maximum: number, label: string, allowEmpty = false): string {
  if ((!allowEmpty && value.length === 0) || value.length > maximum) {
    throw new Error(`${label} is outside the DSH protocol bound`);
  }
  return value;
}

function componentStatus(
  component: string,
  id: string,
  state: RuntimeExtensionComponentStatus['state'],
  code: string,
  message?: string,
): RuntimeExtensionComponentStatus {
  return Object.freeze({ component, id, state, code, ...(message ? { message } : {}) });
}

function assertPlainRecord(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    throw new Error(`${label} must be plain data`);
  }
  return value as Record<string, unknown>;
}

function normalizeSchemaNode(
  value: unknown,
  label: string,
  root: boolean,
  seen: Set<object>,
): DshRpcObject {
  const record = assertPlainRecord(value, label);
  if (seen.has(record)) throw new Error(`${label} is cyclic`);
  seen.add(record);
  try {
    const allowed = new Set([
      // This is deliberately the intersection of protocol 2.0.0's closed
      // schema and the narrower assertObjectJsonSchema implementation in the
      // exact accepted Runtime artifact. Constraints outside the intersection
      // fail the individual Host tool instead of being silently discarded.
      'type', 'properties', 'required', 'additionalProperties', 'items', 'enum',
      'title', 'description',
    ]);
    if (Object.keys(record).some(key => !allowed.has(key))) {
      throw new Error(`${label} uses unsupported JSON Schema keywords`);
    }
    if (typeof record.type !== 'string' || !SCHEMA_TYPES.has(record.type)) {
      throw new Error(`${label} has an unsupported JSON Schema type`);
    }
    if (root && record.type !== 'object') throw new Error('DSH Host tool input schema root must be object');

    const normalized: Record<string, unknown> = { type: record.type };
    if (record.title !== undefined) {
      if (typeof record.title !== 'string') throw new Error(`${label} title is invalid`);
      normalized.title = boundedText(record.title, 512, `${label} title`, true);
    }
    if (record.description !== undefined) {
      if (typeof record.description !== 'string') throw new Error(`${label} description is invalid`);
      normalized.description = boundedText(record.description, 8_192, `${label} description`, true);
    }
    if (record.enum !== undefined) {
      if (!Array.isArray(record.enum) || record.enum.length < 1 || record.enum.length > 256) {
        throw new Error(`${label} enum is invalid`);
      }
      const values = record.enum.map((entry) => {
        if (entry !== null && typeof entry !== 'string' && typeof entry !== 'number' && typeof entry !== 'boolean') {
          throw new Error(`${label} enum contains a non-scalar value`);
        }
        if (typeof entry === 'number' && !Number.isFinite(entry)) throw new Error(`${label} enum number is invalid`);
        if (typeof entry === 'string') boundedText(entry, 65_536, `${label} enum value`, true);
        return entry;
      });
      if (new Set(values.map(entry => stableJson(entry))).size !== values.length) {
        throw new Error(`${label} enum contains duplicates`);
      }
      normalized.enum = values;
    }

    if (record.type === 'object') {
      if (record.additionalProperties !== undefined && record.additionalProperties !== false) {
        throw new Error(`${label} must reject additional properties`);
      }
      normalized.additionalProperties = false;
      const properties = record.properties === undefined
        ? {}
        : assertPlainRecord(record.properties, `${label} properties`);
      const entries = Object.entries(properties);
      if (entries.length > 256 || entries.some(([name]) => !PROPERTY_NAME.test(name))) {
        throw new Error(`${label} properties are invalid`);
      }
      normalized.properties = Object.fromEntries(entries
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([name, schema]) => [name, normalizeSchemaNode(schema, `${label}.${name}`, false, seen)]));
      if (record.required !== undefined) {
        if (!Array.isArray(record.required)
          || record.required.length > 256
          || record.required.some(name => typeof name !== 'string' || !Object.hasOwn(properties, name))
          || new Set(record.required).size !== record.required.length) {
          throw new Error(`${label} required properties are invalid`);
        }
        normalized.required = [...record.required].sort();
      }
    } else if (record.properties !== undefined || record.required !== undefined || record.additionalProperties !== undefined) {
      throw new Error(`${label} object keywords require type object`);
    }

    if (record.type === 'array') {
      if (record.items === undefined) throw new Error(`${label} array items are required`);
      normalized.items = normalizeSchemaNode(record.items, `${label} items`, false, seen);
    } else if (record.items !== undefined) {
      throw new Error(`${label} array keywords require type array`);
    }
    return normalized as DshRpcObject;
  } finally {
    seen.delete(record);
  }
}

export function normalizeDshHostToolInputSchema(value: unknown): Extract<DshComponent, { kind: 'host_tool' }>['descriptor']['inputSchema'] {
  // The recursive normalizer admits the canonical declarative subset and fixes the root type to object.
  return normalizeSchemaNode(value, 'DSH Host tool input schema', true, new Set()) as Extract<DshComponent, { kind: 'host_tool' }>['descriptor']['inputSchema'];
}

function createSnapshot(authority: Omit<DshExtensionSnapshot, 'digest'>): DshExtensionSnapshot {
  const digestValue = digest(stableJson(authority));
  return deepFreeze({ ...authority, digest: digestValue });
}

export function compileDshExtensionSnapshot(input?: {
  revision?: string;
  components?: readonly DshComponent[];
  resources?: readonly DshResource[];
  skillRoots?: readonly DshSkillRoot[];
  mcpLaunchProfiles?: readonly DshMcpLaunchProfile[];
}): DshExtensionSnapshot {
  const revision = input?.revision ?? 'myagents-dsh-extensions-v1:empty';
  return createSnapshot({
    formatVersion: 1,
    revision,
    components: structuredClone(input?.components ?? []),
    resources: structuredClone(input?.resources ?? []),
    skillSourcePolicy: {
      revision: `${revision}:skill-policy`,
      roots: structuredClone(input?.skillRoots ?? []),
    },
    mcpLaunchPolicy: {
      revision: `${revision}:mcp-launch-policy`,
      profiles: structuredClone(input?.mcpLaunchProfiles ?? []),
    },
  });
}

function exactSkillContent(skill: ProductSkillSpec): string {
  const content = readFileSync(skill.path, 'utf8');
  if (content.length < 1 || content.length > MAX_RESOURCE_CHARACTERS || digest(content) !== skill.contentSha256) {
    throw new Error(`DSH Skill ${skill.name} changed after Product capability admission`);
  }
  return content;
}

function workspaceSkillRoot(
  source: DshProductExtensionSource,
  skill: ProductSkillSpec,
): DshSkillRoot | undefined {
  if (skill.scope !== 'project' || !source.workspacePath || basename(skill.path) !== 'SKILL.md') {
    return undefined;
  }
  const workspace = resolve(source.workspacePath);
  const root = resolve(dirname(skill.path));
  const rel = relative(workspace, root);
  if (rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) return undefined;
  return {
    sourceId: skill.name,
    root,
    enabledPaths: ['SKILL.md'],
  };
}

function opaqueMcpEnvironmentRevision(
  material: Readonly<Record<string, string>>,
  runtimeConfigRevision: string | undefined,
): string {
  return `mcp-env-${createHmac('sha256', MCP_ENV_REVISION_KEY)
    .update(stableJson({ material, runtimeConfigRevision: runtimeConfigRevision ?? null }))
    .digest('hex')}`;
}

function stdioMcpComponent(
  source: DshProductExtensionSource,
  server: McpServerDefinition,
  diagnostics: RuntimeExtensionComponentStatus[],
  credentialBindings: DshMcpCredentialBinding[],
): Readonly<{ component: Extract<DshComponent, { kind: 'mcp' }>; launchProfile: DshMcpLaunchProfile }> | null {
  if (!MCP_NAME.test(server.id)) {
    diagnostics.push(componentStatus('mcp', server.id, 'failed', 'dsh_mcp_name_invalid'));
    return null;
  }
  if (!source.workspacePath) {
    diagnostics.push(componentStatus('mcp', server.id, 'failed', 'dsh_stdio_workspace_missing'));
    return null;
  }
  if (server.command === '__builtin__') return null;
  try {
    const launch = resolveStdioMcpLaunch(server);
    const cwd = resolve(source.workspacePath);
    const launchProfileRef = safeReference(
      'mcp-launch',
      stableJson({ id: server.id, argv: [launch.command, ...launch.args], cwd }),
    );
    const material = Object.freeze(buildMcpSubprocessEnv(process.env, server.env));
    const credentialRevision = opaqueMcpEnvironmentRevision(material, server.runtimeConfigRevision);
    // The native credential owner requires a POSIX environment-variable name.
    const credentialRef = `mcp_env_${digest(server.id)}`;
    credentialBindings.push(Object.freeze({
      componentId: server.id,
      credentialRef,
      credentialRevision,
      materialSlot: 'env',
      material,
    }));
    diagnostics.push(componentStatus('mcp', server.id, 'applied', 'dsh_stdio_mcp_compiled'));
    return Object.freeze({
      component: {
        id: server.id,
        enabled: true,
        kind: 'mcp',
        descriptor: {
          transport: 'stdio',
          launchProfileRef,
          credential: {
            credentialRef,
            credentialRevision,
            materialSlot: 'env',
          },
        },
        ...(server.name || server.description
          ? { metadata: { displayName: boundedText(server.name || server.id, 256, 'DSH MCP display name'), ...(server.description ? { description: boundedText(server.description, 8_192, 'DSH MCP description', true) } : {}) } }
          : {}),
      },
      launchProfile: {
        ref: launchProfileRef,
        argv: [launch.command, ...launch.args],
        cwd,
      },
    });
  } catch (error) {
    diagnostics.push(componentStatus(
      'mcp',
      server.id,
      'failed',
      'dsh_stdio_launch_invalid',
      error instanceof Error ? error.message : String(error),
    ));
    return null;
  }
}

function remoteMcpComponent(
  server: McpServerDefinition,
  diagnostics: RuntimeExtensionComponentStatus[],
  credentialBindings: DshMcpCredentialBinding[],
): Extract<DshComponent, { kind: 'mcp' }> | null {
  if (!MCP_NAME.test(server.id)) {
    diagnostics.push(componentStatus('mcp', server.id, 'failed', 'dsh_mcp_name_invalid'));
    return null;
  }
  if (!server.url) {
    diagnostics.push(componentStatus('mcp', server.id, 'failed', 'dsh_remote_mcp_url_missing'));
    return null;
  }
  let endpoint: URL;
  try {
    endpoint = new URL(server.url);
  } catch {
    diagnostics.push(componentStatus('mcp', server.id, 'failed', 'dsh_remote_mcp_url_invalid'));
    return null;
  }
  if (
    (endpoint.protocol !== 'http:' && endpoint.protocol !== 'https:')
    || endpoint.username
    || endpoint.password
    || endpoint.hash
    || endpoint.toString().length > 2_048
    || endpoint.toString().includes('@')
  ) {
    diagnostics.push(componentStatus('mcp', server.id, 'failed', 'dsh_remote_mcp_url_unsafe'));
    return null;
  }
  if (server.env && Object.keys(server.env).length > 0) {
    diagnostics.push(componentStatus('mcp', server.id, 'unsupported', 'dsh_remote_mcp_env_unsupported'));
    return null;
  }
  const headers = server.headers ?? {};
  if (server.type !== 'http' && server.type !== 'sse') return null;
  let descriptor: Extract<Extract<DshComponent, { kind: 'mcp' }>['descriptor'], { transport: 'http' | 'sse' }> = {
    transport: server.type,
    url: endpoint.toString(),
  };
  if (Object.keys(headers).length > 0) {
    if (!server.runtimeConfigRevision || server.runtimeConfigRevision.length > 256) {
      diagnostics.push(componentStatus(
        'mcp',
        server.id,
        'unsupported',
        'dsh_mcp_credential_revision_missing',
        'Credential-bearing MCP requires an opaque Product runtimeConfigRevision.',
      ));
      return null;
    }
    if (Object.entries(headers).some(([name, value]) => (
      name.length < 1 || name.length > 128 || typeof value !== 'string' || value.length > 65_536
    ))) {
      diagnostics.push(componentStatus('mcp', server.id, 'failed', 'dsh_mcp_headers_invalid'));
      return null;
    }
    const credentialRef = `mcp_credential_${digest(server.id)}`;
    descriptor = { ...descriptor, credential: {
      credentialRef,
      credentialRevision: server.runtimeConfigRevision,
      materialSlot: 'header',
    } };
    credentialBindings.push(Object.freeze({
      componentId: server.id,
      credentialRef,
      credentialRevision: server.runtimeConfigRevision,
      materialSlot: 'header',
      material: Object.freeze({ ...headers }),
    }));
  }
  diagnostics.push(componentStatus('mcp', server.id, 'applied', 'dsh_remote_mcp_compiled'));
  return {
    id: server.id,
    enabled: true,
    kind: 'mcp',
    descriptor,
    ...(server.name || server.description
      ? { metadata: { displayName: boundedText(server.name || server.id, 256, 'DSH MCP display name'), ...(server.description ? { description: boundedText(server.description, 8_192, 'DSH MCP description', true) } : {}) } }
      : {}),
  };
}

/** Legacy MyAgents/Claude Agent selectors name the terminal capability; Runtime visibility selects its platform Shell. */
const dshAgentToolSelectors = (tools: readonly string[]): string[] => [...new Set(tools.flatMap(tool =>
  tool === 'Bash' ? ['bash', 'pwsh'] : tool === 'PowerShell' ? ['pwsh'] : [tool],
))];

export function compileDshProductExtensionPlane(
  source: DshProductExtensionSource,
): DshCompiledExtensionPlane {
  if (!source.revision || source.revision.length > 220) {
    throw new Error('Product extension revision is outside the DSH protocol bound');
  }
  const components: DshComponent[] = [];
  const resources: DshResource[] = [];
  const skillRoots: DshSkillRoot[] = [];
  const mcpLaunchProfiles: DshMcpLaunchProfile[] = [];
  const credentialBindings: DshMcpCredentialBinding[] = [];
  const hostToolBindings: DshHostToolBinding[] = [];
  const diagnostics: RuntimeExtensionComponentStatus[] = [...(source.components ?? [])];
  const admittedSkillNames = new Set<string>();

  for (const skill of [...source.skills].sort((left, right) => left.name.localeCompare(right.name))) {
    if (!isDshDeclarativeReference(skill.name)) {
      diagnostics.push(componentStatus('skills', skill.name, 'failed', 'dsh_skill_name_invalid'));
      continue;
    }
    try {
      const content = exactSkillContent(skill);
      const { frontmatter } = parseFullSkillContent(content);
      const unsupported = (['context', 'agent'] as const).filter(field => Boolean(frontmatter[field]));
      if (unsupported.length) {
        diagnostics.push(componentStatus('skills', skill.name, 'unsupported', 'dsh_skill_execution_context_unsupported',
          `This Skill requests ${unsupported.join(', ')}; this Runtime cannot execute that context. Other Skills remain available.`));
        continue;
      }
      if (frontmatter['allowed-tools']) {
        diagnostics.push(componentStatus('skills', skill.name, 'applied', 'dsh_skill_tool_guidance',
          'Tool guidance is retained in the Skill. Every tool still requires the current catalog and permission policy; no permission grant is created.'));
      }
      const resourceId = safeReference('skill-document', `${skill.sourceId}:${skill.name}:${skill.contentSha256}`);
      const resource: DshResource = {
        id: resourceId,
        kind: 'skill_document',
        sha256: skill.contentSha256,
        mediaType: 'text/markdown',
        content,
      };
      const component: DshComponent = {
        id: skill.name,
        enabled: true,
        kind: 'skill',
        descriptor: {
          resourceId,
          description: boundedText(skill.description, 4_096, `DSH Skill ${skill.name} description`),
          invocation: {
            modelInvocable: frontmatter['disable-model-invocation'] !== true,
            userInvocable: frontmatter['user-invocable'] !== false,
          },
          rank: skill.scope === 'project' ? 300 : skill.scope === 'user' ? 200 : 100,
        },
        metadata: { displayName: boundedText(skill.name, 256, 'DSH Skill name') },
      };
      const skillRoot = workspaceSkillRoot(source, skill);
      if (skillRoot && skillRoots.length >= MAX_DSH_SKILL_SOURCE_ROOTS) {
        diagnostics.push(componentStatus(
          'skills',
          skill.name,
          'unsupported',
          'dsh_skill_source_root_limit',
          'The DSH extension generation already contains 128 workspace Skill package roots.',
        ));
        continue;
      }
      resources.push(resource);
      components.push(component);
      if (skillRoot) {
        skillRoots.push(skillRoot);
      } else if (skill.scope === 'project') {
        diagnostics.push(componentStatus(
          'skills',
          skill.name,
          'applied',
          'dsh_skill_body_only_no_workspace_package_root',
          'The project Skill body is available, but its canonical package directory is outside the admitted workspace.',
        ));
      }
      admittedSkillNames.add(skill.name);
    } catch (error) {
      diagnostics.push(componentStatus(
        'skills',
        skill.name,
        'failed',
        'dsh_skill_descriptor_invalid',
        error instanceof Error ? error.message : String(error),
      ));
    }
  }

  for (const command of [...source.commands].sort((left, right) => left.name.localeCompare(right.name))) {
    if (!DSH_COMMAND_NAME.test(command.name)) {
      diagnostics.push(componentStatus('commands', command.name, 'unsupported', 'dsh_command_name_unsupported',
        'The installed name is preserved. To enable this command in DSH, give it a unique lowercase name beginning with a letter, using letters, digits, underscores or hyphens; names are never silently lowercased.'));
      continue;
    }
    try {
      const body = boundedText(command.body, MAX_RESOURCE_CHARACTERS, `DSH command ${command.name}`);
      const resourceId = safeReference('command-template', `${command.sourceId}:${command.name}:${digest(body)}`);
      const resource: DshResource = {
        id: resourceId,
        kind: 'command_template',
        sha256: digest(body),
        mediaType: 'text/markdown',
        content: body,
      };
      const component: DshComponent = {
        id: command.name,
        enabled: true,
        kind: 'command',
        descriptor: {
          description: boundedText(command.description, 4_096, `DSH command ${command.name} description`, true),
          resourceId,
        },
        metadata: { displayName: boundedText(command.name, 256, 'DSH command name') },
      };
      resources.push(resource);
      components.push(component);
    } catch (error) {
      diagnostics.push(componentStatus(
        'commands',
        command.name,
        'failed',
        'dsh_command_descriptor_invalid',
        error instanceof Error ? error.message : String(error),
      ));
    }
  }

  for (const agent of [...source.agents].sort((left, right) => left.name.localeCompare(right.name))) {
    if (!isDshDeclarativeReference(agent.name)) {
      diagnostics.push(componentStatus('agents', agent.name, 'failed', 'dsh_agent_name_invalid'));
      continue;
    }
    const requiredSkills = agent.skills.map(skill => skill.name);
    if (requiredSkills.some(skill => !admittedSkillNames.has(skill))) {
      diagnostics.push(componentStatus('agents', agent.name, 'failed', 'dsh_agent_skill_missing'));
      continue;
    }
    try {
      components.push({
        id: agent.name,
        enabled: true,
        kind: 'agent',
        descriptor: {
          description: boundedText(agent.description, 8_192, `DSH agent ${agent.name} description`),
          prompt: boundedText(agent.prompt, MAX_RESOURCE_CHARACTERS, `DSH agent ${agent.name} prompt`),
          ...(agent.tools === undefined ? {} : { tools: dshAgentToolSelectors(agent.tools) }),
          ...(agent.disallowedTools === undefined ? {} : { disallowedTools: dshAgentToolSelectors(agent.disallowedTools) }),
          ...(agent.maxTurns === undefined ? {} : { maxTurns: agent.maxTurns }),
          ...(requiredSkills.length > 0 ? { skills: requiredSkills } : {}),
        },
        metadata: { displayName: boundedText(agent.name, 256, 'DSH agent name') },
      });
    } catch (error) {
      diagnostics.push(componentStatus(
        'agents',
        agent.name,
        'failed',
        'dsh_agent_descriptor_invalid',
        error instanceof Error ? error.message : String(error),
      ));
    }
  }

  for (const server of [...source.mcpServers].sort((left, right) => left.id.localeCompare(right.id))) {
    if (server.type === 'stdio') {
      if (mcpLaunchProfiles.length >= MAX_DSH_MCP_LAUNCH_PROFILES) {
        diagnostics.push(componentStatus(
          'mcp',
          server.id,
          'unsupported',
          'dsh_mcp_launch_profile_limit',
          'The DSH extension generation already contains 128 stdio MCP launch profiles.',
        ));
        continue;
      }
      const compiled = stdioMcpComponent(source, server, diagnostics, credentialBindings);
      if (compiled) {
        components.push(compiled.component);
        mcpLaunchProfiles.push(compiled.launchProfile);
      }
      continue;
    }
    const component = remoteMcpComponent(server, diagnostics, credentialBindings);
    if (component) components.push(component);
  }

  for (const tool of [...source.dynamicTools].sort((left, right) => left.name.localeCompare(right.name))) {
    if (!source.hostToolDispatcher) {
      diagnostics.push(componentStatus('host_tools', tool.name, 'failed', 'dsh_host_tool_dispatcher_missing'));
      continue;
    }
    const serverId = 'myagents_host';
    const publicToolName = `mcp__${serverId}__${tool.name}`;
    if (!HOST_TOOL_NAME.test(tool.name) || !HOST_TOOL_NAME.test(publicToolName)) {
      diagnostics.push(componentStatus('host_tools', tool.name, 'failed', 'dsh_host_tool_name_invalid'));
      continue;
    }
    try {
      components.push({
        id: publicToolName,
        enabled: true,
        kind: 'host_tool',
        descriptor: {
          serverId,
          toolName: tool.name,
          description: boundedText(tool.description, 8_192, `DSH Host tool ${tool.name} description`, true),
          inputSchema: normalizeDshHostToolInputSchema(tool.inputSchema),
        },
      });
      hostToolBindings.push(Object.freeze({ publicToolName, dispatcherToolName: tool.name }));
      diagnostics.push(componentStatus('host_tools', tool.name, 'applied', 'dsh_host_tool_compiled'));
    } catch (error) {
      diagnostics.push(componentStatus(
        'host_tools',
        tool.name,
        'failed',
        'dsh_host_tool_schema_invalid',
        error instanceof Error ? error.message : String(error),
      ));
    }
  }

  if (components.length > 1_024 || resources.length > 1_024) {
    throw new Error('Product extension inventory exceeds the DSH protocol bound');
  }
  const componentKeys = components.map(component => `${String(component.kind)}:${String(component.id)}`);
  if (new Set(componentKeys).size !== componentKeys.length) {
    throw new Error('Product extension inventory has conflicting DSH component identities');
  }
  const revision = `myagents-dsh-v3:${source.revision}`;
  const snapshot = compileDshExtensionSnapshot({
    revision,
    components,
    resources,
    skillRoots,
    mcpLaunchProfiles,
  });
  return Object.freeze({
    snapshot,
    credentialBindings: Object.freeze([...credentialBindings]),
    hostToolBindings: Object.freeze([...hostToolBindings]),
    ...(source.hostToolDispatcher ? { hostToolDispatcher: source.hostToolDispatcher } : {}),
    expectedSkillNames: Object.freeze([...admittedSkillNames].sort()),
    diagnostics: Object.freeze(diagnostics.map(entry => Object.freeze({ ...entry }))),
  });
}

export function findDshMcpCredentialBinding(
  plane: DshCompiledExtensionPlane,
  input: {
    componentId: string;
    credentialRef: string;
    credentialRevision: string;
    materialSlot: string;
  },
): DshMcpCredentialBinding | undefined {
  return plane.credentialBindings.find(binding => (
    binding.componentId === input.componentId
    && binding.credentialRef === input.credentialRef
    && binding.credentialRevision === input.credentialRevision
    && binding.materialSlot === input.materialSlot
  ));
}

export function findDshHostToolBinding(
  plane: DshCompiledExtensionPlane,
  publicToolName: string,
): DshHostToolBinding | undefined {
  return plane.hostToolBindings.find(binding => binding.publicToolName === publicToolName);
}

export function isDshDeclarativeReference(value: string): boolean {
  return value.length <= 256 && DECLARATIVE_REFERENCE.test(value);
}

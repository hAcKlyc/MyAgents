import { APP_DATA_DIR_NAME } from '../../shared/appProfile';
import { parseAsyncQuestionSet } from '../../shared/asyncUserQuestions';
// CodexRuntime — drives the Codex CLI as a subprocess via app-server (v0.1.60)
//
// Communication: JSON-RPC 2.0 over stdio (codex app-server)
// Process lifecycle: persistent across turns (unlike CC's -p mode)
// Permission: Server-initiated Requests with RPC Responses
// System prompt: thread/start → developerInstructions
// Session: thread/start (new) / thread/resume (continuing)

import { randomUUID } from 'node:crypto';
import { readCodexModels, resolveManagedCodexEffort } from './codex-models';
import { tmpdir } from 'node:os';
import { spawn, type Subprocess, type SubprocessStdin } from '../utils/subprocess';
import { writeFileSync, existsSync, mkdtempSync, readdirSync, realpathSync, rmSync, symlinkSync, unlinkSync, statSync } from 'fs';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'path';
import type {
  RuntimeDetection, RuntimeModelInfo, RuntimePermissionMode, RuntimeType,
  RuntimeAuthStatus, RuntimeFeatureFlag, RuntimeMcpServerInfo, RuntimeAppInfo,
  RuntimeDiagnostics, RuntimeDiagnosticsStatus, RuntimeEffectiveEnv,
  RuntimeProxyPolicy, RuntimeDiagnosticIssue,
  RuntimeSource,
} from '../../shared/types/runtime';
import type { McpServerDefinition } from '../../shared/config-types';
import { MANAGED_BROWSER_MCP_ID } from '../../shared/browserTools';
import {
  acquireBrowserCapability,
  adoptBrowserProductSession,
} from '../browser-host/capability-client';
import {
  mcpStartupExecutableIdentity,
  settleMcpStartupLease,
  startMcpStartupDemand,
  type McpStartupDemand,
  type McpStartupLease,
} from '../session-core/mcp-startup-admission-client';
import { CODEX_PERMISSION_MODES } from '../../shared/types/runtime';
import { coerceFileChanges, formatFileChangeForResult } from '../../shared/fileChange';
import type { AgentPlanTodo, AgentRuntime, ConversationBranchBoundary, ConversationBranchResult, RuntimeConfigCapabilities, RuntimeProcess, SessionStartOptions, UnifiedEvent, UnifiedEventCallback, ResolvedImagePayload, SubAgentScope } from './types';
import {
  RuntimeConversationBranchError,
  RuntimeSteerUnavailableError,
  StaleRuntimeSessionError,
} from './types';
import type { InteractionScenario } from '../system-prompt';
import { shouldDisallowAskUserQuestion } from '../host-interaction';
import {
  addCodexExactResponseUsage,
  mapCodexTokenUsage,
  type CodexExactUsageTotals,
  type CodexThreadTokenUsage,
} from './codex-token-usage';
import { stripAnsi } from './env-utils';
import { resolveCodexCommandContext, type CodexCommandContext } from './codex-command-context';
import { ensureDirSync } from '../utils/fs-utils';
import { killWithEscalation } from './utils/kill-with-escalation';
import { withLogContext } from '../logger-context';
import {
  saveToolAttachment,
  makePlaceholderAttachment,
  makeErrorAttachment,
  trackInFlightSave,
  type AttachmentSource,
  type SaveContext,
} from './tool-attachments';
import type { ToolAttachment } from '../../shared/types/tool-attachment';
import type { SubagentLifecycleStatus } from '../../shared/types/subagent-lifecycle';
import { MCP_PREWARM_GRACE_MS } from '../session-core/mcp-prewarm-policy';
import { classifyMcpFailure, type McpFailureCode } from '../../shared/mcpFailure';
import { MYAGENTS_TOOL_CALL_TIMEOUT_MS } from '../session-core/tool-call-policy';
import { summarizeSensitiveValueForLog } from '../utils/log-summary';
import { supportsCodexConversationBranch } from '../../shared/codex-conversation-capability';
import type {
  ManagedCodexAgentRoleSpec,
  ManagedCodexExtensionSnapshot,
  ManagedCodexHostToolCall,
  ManagedCodexHostToolResult,
  ManagedCodexSkillSpec,
} from './managed-codex/extensions/contracts';
import {
  projectManagedCodexMcpLaunchConfig,
} from './managed-codex/extensions/mcp-launch-projection';
import { AjvJsonSchemaValidator } from '@modelcontextprotocol/sdk/validation/ajv';

type CodexDecision = 'deny' | 'allow_once' | 'always_allow';
type ManagedCodexMcpAdmissionOwner = {
  key: string;
  startedAt: number;
  runtimeGeneration: number;
  configGeneration: number;
  serverIds: string[];
  demand: McpStartupDemand;
  lease: McpStartupLease | null;
  state: 'queued' | 'granted' | 'settled' | 'unmanaged';
};
let managedCodexMcpAdmissionOwner: ManagedCodexMcpAdmissionOwner | null = null;
let managedCodexMcpAdmissionGeneration = 0;

function releaseManagedCodexMcpAdmission(): void {
  const owner = managedCodexMcpAdmissionOwner;
  managedCodexMcpAdmissionOwner = null;
  owner?.demand.cancel();
  if (owner?.lease) void settleMcpStartupLease(owner.lease, 'released');
}

async function prepareManagedCodexMcpAdmission(
  servers: readonly McpServerDefinition[],
  priority: 'interactive' | 'background',
  acceptedAt: number,
): Promise<{ includeLocal: boolean; owner: ManagedCodexMcpAdmissionOwner | null }> {
  const local = servers.filter(server => server.type === 'stdio' && Boolean(server.command));
  if (local.length === 0) {
    releaseManagedCodexMcpAdmission();
    return { includeLocal: true, owner: null };
  }
  const executableIdentity = mcpStartupExecutableIdentity(
    local.map(server => ({ command: server.command!, args: server.args ?? [] })),
  );
  const key = `${executableIdentity}:${local.map(server => server.id).sort().join(',')}`;
  let owner = managedCodexMcpAdmissionOwner;
  if (!owner || owner.key !== key || owner.state === 'settled') {
    releaseManagedCodexMcpAdmission();
    managedCodexMcpAdmissionGeneration += 1;
    const demand = startMcpStartupDemand({
      executables: local.map(server => ({ command: server.command!, args: server.args ?? [] })),
      runtimeGeneration: managedCodexMcpAdmissionGeneration,
      configGeneration: 1,
      priority,
    });
    const created: ManagedCodexMcpAdmissionOwner = {
      key,
      startedAt: acceptedAt,
      runtimeGeneration: managedCodexMcpAdmissionGeneration,
      configGeneration: 1,
      serverIds: local.map(server => server.id).sort(),
      demand,
      lease: null,
      state: 'queued',
    };
    owner = created;
    managedCodexMcpAdmissionOwner = created;
    void demand.ready.then(lease => {
      if (managedCodexMcpAdmissionOwner !== created) {
        if (lease) void settleMcpStartupLease(lease, 'released');
        return;
      }
      if (!lease) {
        created.state = 'unmanaged';
        return;
      }
      created.lease = lease;
      created.state = 'granted';
    });
  }
  if (owner.state === 'granted' || owner.state === 'settled' || owner.state === 'unmanaged') {
    return { includeLocal: true, owner };
  }
  const remainingMs = owner.startedAt + MCP_PREWARM_GRACE_MS - Date.now();
  if (remainingMs > 0) {
    let timeout: ReturnType<typeof setTimeout> | undefined;
    await Promise.race([
      owner.demand.ready,
      new Promise<void>(resolve => {
        timeout = setTimeout(resolve, remainingMs);
        timeout.unref?.();
      }),
    ]);
    if (timeout) clearTimeout(timeout);
  }
  const current = managedCodexMcpAdmissionOwner;
  return {
    includeLocal: current === owner
      && (current.state === 'granted' || current.state === 'settled' || current.state === 'unmanaged'),
    owner,
  };
}
type CodexDynamicToolCallResult = {
  success: boolean;
  contentItems: Array<
    | { type: 'inputText'; text: string }
    | { type: 'inputImage'; imageUrl: string }
    | { type: 'inputAudio'; audioUrl: string }
  >;
};

const managedCodexHostInputValidator = new AjvJsonSchemaValidator();
const CODEX_COMPACT_TIMEOUT_MS = 120_000;

function toCodexDynamicToolCallResult(result: ManagedCodexHostToolResult): CodexDynamicToolCallResult {
  return {
    success: result.success,
    contentItems: result.contentItems.map(item => {
      if (item.type === 'text') return { type: 'inputText' as const, text: item.text };
      if (item.type === 'image') return { type: 'inputImage' as const, imageUrl: item.dataUrl };
      return { type: 'inputAudio' as const, audioUrl: item.dataUrl };
    }),
  };
}

function codexHostToolFailure(message: string): CodexDynamicToolCallResult {
  return { success: false, contentItems: [{ type: 'inputText', text: message }] };
}
type CodexSandboxMode = 'read-only' | 'workspace-write' | 'danger-full-access';
type CodexApprovalsReviewer = 'user' | 'auto_review';
type CodexApprovalPolicy =
  | 'untrusted'
  | 'on-failure'
  | 'on-request'
  | 'never'
  | { granular: Record<string, boolean> };
type CodexSandboxPolicy =
  | { type: 'dangerFullAccess' }
  | { type: 'readOnly'; networkAccess: boolean }
  | {
    type: 'workspaceWrite';
    writableRoots: string[];
    networkAccess: boolean;
    excludeTmpdirEnvVar: boolean;
    excludeSlashTmp: boolean;
  };
type CodexWorkspacePolicy = Extract<CodexSandboxPolicy, { type: 'workspaceWrite' }>;
interface CodexThreadPermissionResult {
  thread: { id: string };
  model?: string;
  approvalsReviewer?: string;
  sandbox?: CodexSandboxPolicy;
}

/** Native config/read already resolves user and trusted project configuration.
 * Keep this generation's workspace policy even while Full Access is selected:
 * a prewarmed thread cannot be resumed until it has a persisted rollout. */
export function codexWorkspacePolicyFromConfig(result: {
  config?: { sandbox_workspace_write?: {
    writable_roots?: string[];
    network_access?: boolean;
    exclude_tmpdir_env_var?: boolean;
    exclude_slash_tmp?: boolean;
  } | null };
}): CodexWorkspacePolicy {
  const config = result.config?.sandbox_workspace_write;
  return {
    type: 'workspaceWrite',
    writableRoots: config?.writable_roots ?? [],
    networkAccess: config?.network_access ?? false,
    excludeTmpdirEnvVar: config?.exclude_tmpdir_env_var ?? false,
    excludeSlashTmp: config?.exclude_slash_tmp ?? false,
  };
}

function adoptCodexThreadPermissions(proc: CodexProcess, result: CodexThreadPermissionResult): void {
  proc.supportsApprovalsReviewer = typeof result.approvalsReviewer === 'string';
  if (proc.approvalsReviewer === 'auto_review' && result.approvalsReviewer !== 'auto_review') {
    throw new Error('This Codex CLI did not enable Approve for me. Update Codex or select Ask for approval / Full Access.');
  }
  if (result.sandbox?.type === 'workspaceWrite') proc.workspacePolicy = result.sandbox;
}

export const CODEX_INITIALIZE_CAPABILITIES = Object.freeze({
  experimentalApi: false,
  requestAttestation: false,
  optOutNotificationMethods: [
    'remoteControl/status/changed',
    'thread/goal/cleared',
  ],
});

export function buildCodexInitializeParams(experimentalApi = false): Record<string, unknown> {
  return {
    clientInfo: { name: 'MyAgents', title: null, version: process.env.MYAGENTS_VERSION || '0.1.60' },
    capabilities: experimentalApi
      ? { ...CODEX_INITIALIZE_CAPABILITIES, experimentalApi: true }
      : CODEX_INITIALIZE_CAPABILITIES,
  };
}

export function summarizeCodexThreadParamsForLog(
  params: Record<string, unknown>,
): Record<string, unknown> {
  const dynamicTools = Array.isArray(params.dynamicTools) ? params.dynamicTools.length : 0;
  return {
    ...(typeof params.cwd === 'string'
      ? { cwd: summarizeSensitiveValueForLog(params.cwd) }
      : {}),
    ...(typeof params.threadId === 'string'
      ? { threadId: summarizeSensitiveValueForLog(params.threadId) }
      : {}),
    ...(typeof params.model === 'string' || params.model === null ? { model: params.model } : {}),
    ...(typeof params.modelProvider === 'string' ? { modelProvider: params.modelProvider } : {}),
    ...(typeof params.approvalPolicy === 'string' ? { approvalPolicy: params.approvalPolicy } : {}),
    ...(typeof params.sandbox === 'string' ? { sandbox: params.sandbox } : {}),
    ...(typeof params.ephemeral === 'boolean' ? { ephemeral: params.ephemeral } : {}),
    ...(typeof params.experimentalRawEvents === 'boolean'
      ? { experimentalRawEvents: params.experimentalRawEvents }
      : {}),
    ...(dynamicTools > 0 ? { dynamicToolCount: dynamicTools } : {}),
    developerInstructions: summarizeSensitiveValueForLog(
      typeof params.developerInstructions === 'string' ? params.developerInstructions : null,
    ),
  };
}

function summarizeCodexErrorForLog(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error ?? '');
  return JSON.stringify(summarizeSensitiveValueForLog(message));
}

const CODEX_PROJECT_DOC_FALLBACK_CONFIG = 'project_doc_fallback_filenames=["CLAUDE.md"]';
const CODEX_FILE_AUTH_CONFIG = 'cli_auth_credentials_store="file"';
const MANAGED_CODEX_HTTP_PROVIDER_ID = 'myagents_managed_http';
export type CodexMcpStartupState = 'starting' | 'ready' | 'failed' | 'cancelled';

export interface CodexMcpStartupStatusNotification {
  threadId: string | null;
  name: string;
  status: CodexMcpStartupState;
  error: string | null;
  failureReason: string | null;
}

export interface CodexMcpServerStatus {
  name: string;
  tools: Record<string, { name?: string } | undefined>;
  resources?: unknown[];
  authStatus: unknown;
}

function codexMcpAuthStatusText(value: unknown): string | undefined {
  if (typeof value === 'string') return value;
  if (!value || typeof value !== 'object') return undefined;
  const status = value as Record<string, unknown>;
  return typeof status.status === 'string'
    ? status.status
    : typeof status.kind === 'string'
      ? status.kind
      : undefined;
}

function isCodexMcpAuthUnavailable(value: unknown): boolean {
  const status = codexMcpAuthStatusText(value)?.toLowerCase().replace(/[^a-z]/g, '') ?? '';
  return status === 'notloggedin'
    || status.includes('unauthenticated')
    || status.includes('failed')
    || status.includes('error')
    || status.includes('needs')
    || status.includes('required');
}

/** Build the UI-facing catalog from tools Codex reports on explicitly ready servers. */
export function buildCodexMcpToolCatalog(
  servers: readonly CodexMcpServerStatus[],
  readyServerNames: ReadonlySet<string>,
): string[] {
  const catalog = new Set<string>();
  for (const server of servers) {
    if (!readyServerNames.has(server.name) || isCodexMcpAuthUnavailable(server.authStatus)) continue;
    for (const [key, tool] of Object.entries(server.tools ?? {})) {
      const toolName = typeof tool?.name === 'string' && tool.name ? tool.name : key;
      if (server.name && toolName) catalog.add(`mcp__${server.name}__${toolName}`);
    }
  }
  return [...catalog].sort();
}

type CodexMcpServerStatusPage = {
  data: CodexMcpServerStatus[];
  nextCursor?: string | null;
};

/** Read the complete tool catalog for the active Codex thread. */
export async function listCodexMcpServerStatuses(
  rpc: Pick<JsonRpcClient, 'call'>,
  threadId: string,
): Promise<CodexMcpServerStatus[]> {
  const servers: CodexMcpServerStatus[] = [];
  let cursor: string | null = null;
  do {
    const page = await rpc.call('mcpServerStatus/list', {
      threadId,
      detail: 'toolsAndAuthOnly',
      ...(cursor ? { cursor } : {}),
    }, 5_000) as CodexMcpServerStatusPage;
    servers.push(...(page.data ?? []));
    cursor = page.nextCursor ?? null;
  } while (cursor);
  return servers;
}

export interface CodexMcpStartupResult {
  outcome: 'ready' | 'degraded';
  reason?: 'terminal_status' | 'timeout';
  states: Record<string, CodexMcpStartupState>;
  pendingNames: string[];
  elapsedMs: number;
}

/**
 * Runtime-native startup barrier for the MCP servers MyAgents injected into a
 * managed Codex process. Unknown Codex-owned servers are intentionally ignored:
 * this owner can only wait on configuration it owns.
 */
export function createCodexMcpStartupBarrier(expectedNames: readonly string[]): {
  observe(notification: CodexMcpStartupStatusNotification): void;
  arm(startedAt?: number): void;
  fail(error: Error): void;
  wait(): Promise<CodexMcpStartupResult>;
} {
  let startedAt: number | null = null;
  let deadlineAt: number | null = null;
  const expected = new Set(expectedNames);
  const states = new Map<string, CodexMcpStartupState>();
  let failure: Error | null = null;
  let resolveComplete!: () => void;
  const complete = new Promise<void>((resolve) => {
    resolveComplete = resolve;
  });
  let completed = expected.size === 0;
  if (completed) resolveComplete();

  const snapshot = (timedOut: boolean): CodexMcpStartupResult => {
    const pending = pendingNames();
    const stateSnapshot = Object.fromEntries(
      [...states.entries()].filter(([name]) => expected.has(name)),
    );
    const unhealthy = Object.values(stateSnapshot)
      .some(state => state === 'failed');
    const degraded = timedOut || pending.length > 0 || unhealthy;
    return {
      outcome: degraded ? 'degraded' : 'ready',
      ...(degraded ? { reason: timedOut || pending.length > 0 ? 'timeout' as const : 'terminal_status' as const } : {}),
      states: stateSnapshot,
      pendingNames: pending,
      elapsedMs: startedAt === null ? 0 : Math.max(0, Date.now() - startedAt),
    };
  };

  const pendingNames = (): string[] => [...expected].filter((name) => {
    const state = states.get(name);
    return state === undefined || state === 'starting' || state === 'cancelled';
  });

  return {
    observe(notification) {
      if (!expected.has(notification.name) || completed) return;
      const previous = states.get(notification.name);
      if (previous === 'ready' || previous === 'failed') return;
      states.set(notification.name, notification.status);
      const allTerminal = [...expected].every((name) => {
        const state = states.get(name);
        return state === 'ready' || state === 'failed';
      });
      if (allTerminal) {
        completed = true;
        resolveComplete();
      }
    },
    arm(startedAtOverride) {
      if (startedAt !== null) return;
      startedAt = startedAtOverride ?? Date.now();
      deadlineAt = startedAt + MCP_PREWARM_GRACE_MS;
    },
    fail(error) {
      if (completed) return;
      failure = error;
      completed = true;
      resolveComplete();
    },
    async wait() {
      if (expected.size > 0 && deadlineAt === null) {
        throw new Error('Managed Codex MCP startup barrier was not armed at thread startup');
      }
      let timedOut = false;
      if (!completed) {
        const remainingMs = deadlineAt! - Date.now();
        if (remainingMs <= 0) {
          timedOut = true;
        } else {
          const settled = await new Promise<boolean>((resolve) => {
            const timer = setTimeout(() => resolve(false), remainingMs);
            void complete.then(() => {
              clearTimeout(timer);
              resolve(true);
            });
          });
          timedOut = !settled;
        }
      }
      if (failure) throw failure;
      return snapshot(timedOut);
    },
  };
}

function tomlString(value: string): string {
  return JSON.stringify(value);
}

function pushCodexConfigArg(target: string[], key: string, valueToml: string): void {
  target.push('-c', `${key}=${valueToml}`);
}

type ManagedCodexExtensionMaterialization = {
  configArgs: string[];
  skillRoots: string[];
  skills: ManagedCodexSkillSpec[];
  cleanup(): void;
};

export function buildManagedCodexAgentRoleConfig(role: ManagedCodexAgentRoleSpec): string {
  const lines = [
    `developer_instructions = ${tomlString(role.prompt)}`,
    ...(role.model ? [`model = ${tomlString(role.model)}`] : []),
  ];
  for (const skill of role.skills) {
    lines.push('', '[[skills.config]]', `path = ${tomlString(skill.path)}`, 'enabled = true');
  }
  return `${lines.join('\n')}\n`;
}

function nativeProjectSkillPaths(workspacePath: string): string[] {
  const workspace = resolve(workspacePath);
  let projectRoot = workspace;
  for (let current = workspace; ; current = dirname(current)) {
    if (existsSync(join(current, '.git'))) {
      projectRoot = current;
      break;
    }
    const parent = dirname(current);
    if (parent === current) break;
  }
  const directories: string[] = [];
  for (let current = workspace; ; current = dirname(current)) {
    directories.push(current);
    if (current === projectRoot) break;
  }
  return directories.flatMap(directory => {
    const root = join(directory, '.agents', 'skills');
    try {
      return readdirSync(root, { withFileTypes: true })
        .filter(entry => !entry.name.startsWith('.'))
        .flatMap(entry => {
          const path = join(root, entry.name, 'SKILL.md');
          try {
            return statSync(path).isFile() ? [realpathSync(path)] : [];
          } catch {
            return [];
          }
        });
    } catch {
      return [];
    }
  }).sort();
}

function disabledNativeSkillConfigArg(
  workspacePath: string,
  selectedSkills: readonly ManagedCodexSkillSpec[],
): string[] {
  const selectedPaths = new Set(selectedSkills.flatMap(skill => {
    try {
      return [realpathSync(skill.path)];
    } catch {
      return [];
    }
  }));
  const paths = nativeProjectSkillPaths(workspacePath)
    .filter(path => !selectedPaths.has(path));
  if (paths.length === 0) return [];
  return [
    '-c',
    `skills.config=[${paths.map(path => `{path=${tomlString(path)},enabled=false}`).join(',')}]`,
  ];
}

export function materializeManagedCodexExtensions(
  snapshot: ManagedCodexExtensionSnapshot | undefined,
): ManagedCodexExtensionMaterialization {
  if (!snapshot) {
    return { configArgs: [], skillRoots: [], skills: [], cleanup() {} };
  }
  const configArgs = disabledNativeSkillConfigArg(snapshot.workspacePath, snapshot.skills);
  if (snapshot.agents.length === 0 && snapshot.skills.length === 0) {
    return { configArgs, skillRoots: [], skills: [], cleanup() {} };
  }
  let root: string;
  try {
    root = mkdtempSync(join(tmpdir(), 'myagents-codex-extensions-'));
  } catch (error) {
    console.warn(
      '[codex] managed extension materialization unavailable; continuing without projected Agents and Skills:',
      summarizeCodexErrorForLog(error),
    );
    return { configArgs, skillRoots: [], skills: [], cleanup() {} };
  }
  const skillRoots: string[] = [];
  const skills: ManagedCodexSkillSpec[] = [];
  let cleaned = false;
  if (snapshot.agents.length > 0) {
    try {
      const rolesRoot = join(root, 'agents');
      ensureDirSync(rolesRoot);
      for (const [index, role] of snapshot.agents.entries()) {
        const configPath = join(rolesRoot, `${String(index).padStart(3, '0')}.toml`);
        try {
          writeFileSync(configPath, buildManagedCodexAgentRoleConfig(role), { encoding: 'utf8', mode: 0o600 });
          pushCodexConfigArg(configArgs, `agents.${role.name}.description`, tomlString(role.description));
          pushCodexConfigArg(configArgs, `agents.${role.name}.config_file`, tomlString(configPath));
        } catch (error) {
          console.warn(
            `[codex] managed Agent materialization failed; continuing without ${role.name}:`,
            summarizeCodexErrorForLog(error),
          );
        }
      }
    } catch (error) {
      console.warn(
        '[codex] managed Agent materialization unavailable; continuing without projected Agents:',
        summarizeCodexErrorForLog(error),
      );
    }
  }
  if (snapshot.skills.length > 0) {
    try {
      const skillsRoot = join(root, 'skills');
      ensureDirSync(skillsRoot);
      for (const [index, skill] of snapshot.skills.entries()) {
        try {
          const folderName = String(index).padStart(3, '0');
          symlinkSync(dirname(skill.path), join(skillsRoot, folderName), process.platform === 'win32' ? 'junction' : 'dir');
          skills.push(skill);
        } catch (error) {
          console.warn(
            `[codex] managed Skill materialization failed; continuing without ${skill.name}:`,
            summarizeCodexErrorForLog(error),
          );
        }
      }
      if (skills.length > 0) skillRoots.push(skillsRoot);
    } catch (error) {
      console.warn(
        '[codex] managed Skill materialization unavailable; continuing without projected Skills:',
        summarizeCodexErrorForLog(error),
      );
    }
  }
  return {
    configArgs,
    skillRoots,
    skills,
    cleanup() {
      if (cleaned) return;
      cleaned = true;
      try {
        rmSync(root, { recursive: true, force: true });
      } catch (error) {
        console.warn(
          '[codex] failed to clean managed extension temp files:',
          summarizeCodexErrorForLog(error),
        );
      }
    },
  };
}

export function resolveCodexSkillExtraRoots(workspacePath: string): string[] {
  const projectSkillsDir = join(workspacePath, '.claude', 'skills');
  try {
    if (!existsSync(projectSkillsDir)) return [];
    if (!statSync(projectSkillsDir).isDirectory()) return [];
    return [projectSkillsDir];
  } catch {
    return [];
  }
}

export const CODEX_SKILL_EXTRA_ROOTS_SET_TIMEOUT_MS = 30_000;
export const CODEX_SKILL_LIST_TIMEOUT_MS = 30_000;

type CodexSkillListError = { path?: string; message?: string };
type CodexSkillListEntry = {
  skills?: Array<{ name?: string; enabled?: boolean; path?: string }>;
  errors?: CodexSkillListError[];
};

type ExpectedCodexSkill = Pick<ManagedCodexSkillSpec, 'name' | 'path'>;

export type CodexSkillProjectionResult = {
  extraRoots: string[];
  loadedSkillNames: string[];
};

function canonicalCodexSkillPath(path: string): string {
  try {
    return realpathSync.native(path);
  } catch {
    return resolve(path);
  }
}

function codexSkillIdentity(skill: { name: string; path: string }): string {
  return `${skill.name}\0${canonicalCodexSkillPath(skill.path)}`;
}

function isPathInside(root: string, candidate: string): boolean {
  const rel = relative(resolve(root), resolve(candidate));
  return rel === '' || (!isAbsolute(rel) && rel !== '..' && !rel.startsWith(`..${sep}`));
}

function summarizeCodexSkillErrorPath(
  path: string | undefined,
  workspacePath: string,
  extraRoots: readonly string[],
): string {
  if (!path) return '<unknown>';
  if (isPathInside(workspacePath, path)) {
    const rel = relative(resolve(workspacePath), resolve(path));
    return rel ? `<workspace>/${rel}` : '<workspace>';
  }
  for (const [index, root] of extraRoots.entries()) {
    if (!isPathInside(root, path)) continue;
    const rel = relative(resolve(root), resolve(path));
    return rel ? `<extra-root-${index + 1}>/${rel}` : `<extra-root-${index + 1}>`;
  }
  return `<external>/${basename(path) || 'unknown'}`;
}

export async function configureCodexSkillExtraRoots(
  rpc: Pick<JsonRpcClient, 'call'>,
  workspacePath: string,
  setTimeoutMs = CODEX_SKILL_EXTRA_ROOTS_SET_TIMEOUT_MS,
  requestedRoots?: readonly string[],
  expectedSkills: readonly ExpectedCodexSkill[] = [],
  listTimeoutMs = CODEX_SKILL_LIST_TIMEOUT_MS,
): Promise<CodexSkillProjectionResult> {
  const extraRoots = requestedRoots === undefined
    ? resolveCodexSkillExtraRoots(workspacePath)
    : [...new Set(requestedRoots)];
  if (extraRoots.length === 0) return { extraRoots: [], loadedSkillNames: [] };

  try {
    const setStartedAt = Date.now();
    try {
      await rpc.call('skills/extraRoots/set', { extraRoots }, setTimeoutMs);
      console.log(
        `[codex] skills/extraRoots/set completed: roots=${extraRoots.length}`
        + ` durationMs=${Date.now() - setStartedAt} timeoutMs=${setTimeoutMs}`,
      );
    } catch (error) {
      console.warn(
        `[codex] skills/extraRoots/set failed: roots=${extraRoots.length}`
        + ` durationMs=${Date.now() - setStartedAt} timeoutMs=${setTimeoutMs}`
        + ` reason=${summarizeCodexErrorForLog(error)}`,
      );
      throw error;
    }

    const listStartedAt = Date.now();
    let listed: { data?: CodexSkillListEntry[] };
    try {
      listed = await rpc.call('skills/list', {
        cwds: [workspacePath],
        forceReload: true,
      }, listTimeoutMs) as { data?: CodexSkillListEntry[] };
    } catch (error) {
      console.warn(
        `[codex] skills/list failed: roots=${extraRoots.length}`
        + ` expected=${expectedSkills.length}`
        + ` durationMs=${Date.now() - listStartedAt} timeoutMs=${listTimeoutMs}`
        + ` reason=${summarizeCodexErrorForLog(error)}`,
      );
      throw error;
    }
    const entries = listed.data ?? [];
    const listedSkills = entries.flatMap(entry => entry.skills ?? []);
    const listErrors = entries.flatMap(entry => entry.errors ?? []);
    console.log(
      `[codex] skills/list completed: roots=${extraRoots.length}`
      + ` expected=${expectedSkills.length} visible=${listedSkills.length}`
      + ` errors=${listErrors.length} durationMs=${Date.now() - listStartedAt}`
      + ` timeoutMs=${listTimeoutMs}`,
    );
    for (const error of listErrors) {
      console.warn(
        `[codex] skills/list parser warning: path=${JSON.stringify(summarizeCodexSkillErrorPath(error.path, workspacePath, extraRoots))}`
        + ` message=${JSON.stringify(summarizeSensitiveValueForLog(error.message))}`,
      );
    }
    const visible = new Set(
      listedSkills
        .filter((skill): skill is { name: string; path: string; enabled?: boolean } => (
          skill.enabled !== false
          && typeof skill.name === 'string'
          && typeof skill.path === 'string'
        ))
        .map(codexSkillIdentity),
    );
    const missing = expectedSkills.filter(skill => !visible.has(codexSkillIdentity(skill)));
    if (missing.length > 0) {
      console.warn(
        `[codex] skills/list omitted projected Skills; continuing without them: ${missing.map(skill => skill.name).join(', ')}`,
      );
    }
    console.log(
      `[codex] skills extra roots applied: roots=${extraRoots.length}`
      + ` visible=${expectedSkills.length - missing.length} missing=${missing.length}`,
    );
    const missingIdentities = new Set(missing.map(codexSkillIdentity));
    return {
      extraRoots,
      loadedSkillNames: expectedSkills
        .filter(skill => !missingIdentities.has(codexSkillIdentity(skill)))
        .map(skill => skill.name),
    };
  } catch (err) {
    console.warn(
      '[codex] skills extra roots injection failed; continuing without projected Skills:',
      summarizeCodexErrorForLog(err),
    );
    return { extraRoots: [], loadedSkillNames: [] };
  }
}

function buildManagedCodexMcpConfigArgs(
  servers: readonly McpServerDefinition[] | undefined,
  codexEnv: Record<string, string | undefined>,
): {
  args: string[];
  serverNames: string[];
} {
  const projection = projectManagedCodexMcpLaunchConfig(servers, codexEnv);
  Object.assign(codexEnv, projection.envPatch);
  if (projection.serverNames.length > 0 || projection.failures.length > 0) {
    console.log(
      `[codex] managed MCP startup config: injected=${projection.serverNames.length}`
      + ` degraded=${projection.failures.length}`,
    );
  }
  for (const failure of projection.failures) {
    console.warn(`[codex] managed MCP component degraded: ${failure.message}`);
  }
  return {
    args: projection.args,
    serverNames: projection.serverNames,
  };
}

export function buildCodexAppServerLaunchConfig(args: {
  commandPath: string;
  runtimeSource: RuntimeSource;
  codexEnv: Record<string, string | undefined>;
  mcpServers?: readonly McpServerDefinition[];
  extensionConfigArgs?: readonly string[];
}): {
  args: string[];
  mcpServerNames: string[];
  modelProvider?: string;
} {
  const codexArgs = [
    args.commandPath,
    '-c', CODEX_PROJECT_DOC_FALLBACK_CONFIG,
  ];
  let mcpServerNames: string[] = [];
  let modelProvider: string | undefined;
  if (args.runtimeSource === 'managed-provider') {
    codexArgs.push('-c', CODEX_FILE_AUTH_CONFIG);
    modelProvider = MANAGED_CODEX_HTTP_PROVIDER_ID;
    pushCodexConfigArg(codexArgs, 'model_provider', tomlString(modelProvider));
    pushCodexConfigArg(codexArgs, `model_providers.${modelProvider}.name`, tomlString('OpenAI'));
    pushCodexConfigArg(codexArgs, `model_providers.${modelProvider}.wire_api`, tomlString('responses'));
    pushCodexConfigArg(codexArgs, `model_providers.${modelProvider}.requires_openai_auth`, 'true');
    pushCodexConfigArg(codexArgs, `model_providers.${modelProvider}.supports_websockets`, 'false');
    const mcpConfig = buildManagedCodexMcpConfigArgs(args.mcpServers, args.codexEnv);
    codexArgs.push(...mcpConfig.args);
    mcpServerNames = mcpConfig.serverNames;
  }
  codexArgs.push(...(args.extensionConfigArgs ?? []));
  codexArgs.push('app-server');
  return { args: codexArgs, mcpServerNames, modelProvider };
}

export function resolveCodexThreadModelProvider(
  launchModelProvider: string | undefined,
  resumeSessionId: string | undefined,
  model: string | undefined,
): string | undefined {
  if (!launchModelProvider) return undefined;
  if (!resumeSessionId || model?.trim()) return launchModelProvider;

  // A legacy thread can carry a different persisted model/provider pair. When
  // MyAgents has no authoritative model snapshot, let Codex restore that pair
  // together instead of overriding only its provider and resetting the model.
  return undefined;
}

export function buildCodexAppServerArgs(args: {
  commandPath: string;
  runtimeSource: RuntimeSource;
  codexEnv: Record<string, string | undefined>;
  mcpServers?: readonly McpServerDefinition[];
}): string[] {
  return buildCodexAppServerLaunchConfig(args).args;
}

export const KNOWN_CODEX_SERVER_REQUEST_METHODS = Object.freeze([
  'item/commandExecution/requestApproval',
  'item/fileChange/requestApproval',
  'item/tool/requestUserInput',
  'mcpServer/elicitation/request',
  'item/permissions/requestApproval',
  'item/tool/call',
  'account/chatgptAuthTokens/refresh',
  'attestation/generate',
  'currentTime/read',
  'applyPatchApproval',
  'execCommandApproval',
] as const);

type KnownCodexServerRequestMethod = (typeof KNOWN_CODEX_SERVER_REQUEST_METHODS)[number];
type JsonRpcRequestId = number | string;

export type PendingCodexRequest =
  | { kind: 'command_approval'; rpcId: JsonRpcRequestId; method: KnownCodexServerRequestMethod; params: Record<string, unknown> }
  | { kind: 'file_approval'; rpcId: JsonRpcRequestId; method: KnownCodexServerRequestMethod; params: Record<string, unknown> }
  | { kind: 'tool_user_input'; rpcId: JsonRpcRequestId; method: KnownCodexServerRequestMethod; params: Record<string, unknown> }
  | { kind: 'mcp_elicitation'; rpcId: JsonRpcRequestId; method: KnownCodexServerRequestMethod; params: Record<string, unknown> }
  | { kind: 'permissions_approval'; rpcId: JsonRpcRequestId; method: KnownCodexServerRequestMethod; params: Record<string, unknown> }
  | { kind: 'host_tool_approval'; rpcId: JsonRpcRequestId; method: 'item/tool/call'; params: Record<string, unknown>; callId: string };

type PendingManagedCodexHostCall = {
  rpcId: JsonRpcRequestId;
  callId: string;
  threadId: string;
  turnId: string;
  params: Record<string, unknown>;
  controller: AbortController;
  settled: boolean;
  timeout?: ReturnType<typeof setTimeout>;
};

type CodexResponseAction =
  | { type: 'result'; result: unknown }
  | { type: 'error'; code: number; message: string };

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function stringValue(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

function arrayValue(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function objectValue(value: unknown): Record<string, unknown> {
  return isRecord(value) ? value : {};
}

function codexUserMessageClientId(item: Record<string, unknown>): string | undefined {
  return stringValue(item.clientId)
    ?? stringValue(item.client_id)
    ?? stringValue(item.clientUserMessageId)
    ?? stringValue(item.client_user_message_id);
}

function codexTraceId(params: Record<string, unknown>, fallbackItemId?: string, suffix?: string): string | undefined {
  const itemId = stringValue(params.itemId) ?? fallbackItemId;
  if (!itemId) return undefined;
  const threadId = stringValue(params.threadId);
  return [threadId, itemId, suffix].filter((part): part is string => !!part).join('::');
}

type CodexReasoningTraceState = {
  openedReasoningTracesByItem: Map<string, Map<string, number>>;
};

function codexReasoningItemKey(
  params: Record<string, unknown>,
  fallbackItemId?: string,
): string | undefined {
  const itemId = stringValue(params.itemId) ?? fallbackItemId;
  if (!itemId) return undefined;
  return [stringValue(params.threadId), itemId].filter(Boolean).join('::');
}

export function buildCodexReasoningDeltaEvents(
  state: CodexReasoningTraceState,
  params: Record<string, unknown>,
  input: { index: number; suffix: string; text: string },
): UnifiedEvent | UnifiedEvent[] {
  const traceId = codexTraceId(params, undefined, input.suffix);
  const delta: UnifiedEvent = {
    kind: 'thinking_delta',
    text: input.text,
    index: input.index,
    traceId,
  };
  const itemKey = codexReasoningItemKey(params);
  if (!traceId || !itemKey) return delta;
  let opened = state.openedReasoningTracesByItem.get(itemKey);
  if (!opened) {
    opened = new Map<string, number>();
    state.openedReasoningTracesByItem.set(itemKey, opened);
  }
  if (opened.has(traceId)) return delta;
  opened.set(traceId, input.index);
  return [
    { kind: 'thinking_start', index: input.index, traceId },
    delta,
  ];
}

export function takeCodexReasoningStopEvents(
  state: CodexReasoningTraceState,
  params: Record<string, unknown>,
  fallbackItemId: string,
): UnifiedEvent[] {
  const itemKey = codexReasoningItemKey(params, fallbackItemId);
  if (!itemKey) return [];
  const opened = state.openedReasoningTracesByItem.get(itemKey);
  state.openedReasoningTracesByItem.delete(itemKey);
  if (!opened) return [];
  return [...opened].map(([traceId, index]) => ({
    kind: 'thinking_stop' as const,
    index,
    traceId,
  }));
}

export function buildCodexFileChangeResultContent(changes: unknown): string {
  const normalized = coerceFileChanges(changes);
  return normalized.length > 0
    ? normalized.map(formatFileChangeForResult).join('\n\n')
    : 'File changed';
}

export function buildCodexStartedFileChangeInput(
  changes: unknown,
  cwd?: string,
): Record<string, unknown> | undefined {
  const firstChange = Array.isArray(changes) ? changes[0] : undefined;
  const firstPath = firstChange
    && typeof firstChange === 'object'
    && !Array.isArray(firstChange)
    && typeof (firstChange as { path?: unknown }).path === 'string'
    ? (firstChange as { path: string }).path
    : undefined;
  const input: Record<string, unknown> = {
    ...(firstPath ? { file_path: firstPath } : {}),
    ...(cwd ? { cwd } : {}),
  };
  return Object.keys(input).length > 0 ? input : undefined;
}

export function buildCodexCompletedFileChangeInput(
  changes: unknown,
  cwd?: string,
): Record<string, unknown> | undefined {
  if (!Array.isArray(changes) || changes.length === 0) return undefined;
  const normalized = coerceFileChanges(changes);
  if (
    normalized.length !== changes.length
    || normalized.some((change) => !change.path?.trim())
  ) return undefined;
  return {
    file_path: normalized[0].path,
    ...(cwd ? { cwd } : {}),
    changes: normalized,
  };
}

// ─── Temp image directory for Codex (which requires file paths, not base64) ───
const TEMP_IMG_DIR = join(
  process.env.HOME || process.env.USERPROFILE || '/tmp',
  APP_DATA_DIR_NAME, 'tmp', 'codex-images',
);

/**
 * Write base64 image to a temp file and return its path.
 * Codex CLI accepts `localImage` input with file paths.
 */
function writeImageToTempFile(img: ResolvedImagePayload): string {
  if (!existsSync(TEMP_IMG_DIR)) {
    ensureDirSync(TEMP_IMG_DIR);
  }
  const buf = Buffer.from(img.data, 'base64');
  if (buf.length === 0) throw new Error('Empty image data');
  const subtype = img.mimeType.split('/')[1]?.split('+')[0] || 'png';  // 'jpeg' from 'image/jpeg', 'svg' from 'image/svg+xml'
  const ext = subtype === 'jpeg' ? 'jpg' : subtype;
  const filename = `img-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.${ext}`;
  const filepath = join(TEMP_IMG_DIR, filename);
  writeFileSync(filepath, buf);
  return filepath;
}

/**
 * Clean up stale temp images older than 1 hour.
 * Called at session start to prevent unbounded directory growth.
 */
function cleanupStaleTempImages(): void {
  try {
    if (!existsSync(TEMP_IMG_DIR)) return;
    const cutoff = Date.now() - 60 * 60 * 1000; // 1 hour
    for (const file of readdirSync(TEMP_IMG_DIR)) {
      const filepath = join(TEMP_IMG_DIR, file);
      try {
        if (statSync(filepath).mtimeMs < cutoff) unlinkSync(filepath);
      } catch { /* ignore individual file errors */ }
    }
  } catch { /* ignore cleanup errors */ }
}

/**
 * Build Codex input array with optional images.
 * Images are written to temp files and referenced via `localImage` type.
 */
function buildCodexInput(text: string, images?: ResolvedImagePayload[]): unknown[] {
  const input: unknown[] = [];
  if (images && images.length > 0) {
    for (const img of images) {
      const filepath = writeImageToTempFile(img);
      input.push({ type: 'localImage', path: filepath });
    }
  }
  input.push({ type: 'text', text, text_elements: [] });
  return input;
}

export async function initializeCodexRpc(
  rpc: Pick<JsonRpcClient, 'call' | 'notify'>,
  timeoutMs = 10_000,
  experimentalApi = false,
): Promise<void> {
  await rpc.call('initialize', buildCodexInitializeParams(experimentalApi), timeoutMs);
  rpc.notify('initialized');
}

export function buildCodexSandboxPolicy(
  sandbox: CodexSandboxMode,
  workspacePath: string,
  workspacePolicy?: CodexWorkspacePolicy,
): CodexSandboxPolicy {
  switch (sandbox) {
    case 'read-only':
      return { type: 'readOnly', networkAccess: false };
    case 'workspace-write':
      return workspacePolicy ?? {
        type: 'workspaceWrite',
        writableRoots: [workspacePath],
        networkAccess: false,
        excludeTmpdirEnvVar: false,
        excludeSlashTmp: false,
      };
    case 'danger-full-access':
      return { type: 'dangerFullAccess' };
  }
}

export function buildCodexTurnStartParams(args: {
  threadId: string;
  input: unknown[];
  cwd: string;
  approvalPolicy: CodexApprovalPolicy;
  approvalsReviewer?: CodexApprovalsReviewer;
  sandbox: CodexSandboxMode;
  workspacePolicy?: CodexWorkspacePolicy;
  model?: string | null;
  /** #324 — reasoning effort level; falsy = omit (Codex default applies).
   *  Schema: TurnStartParams.effort "Override the reasoning effort for this
   *  turn and subsequent turns" (codex app-server v2). */
  reasoningEffort?: string | null;
  clientUserMessageId?: string | null;
}): Record<string, unknown> {
  return {
    threadId: args.threadId,
    input: args.input,
    cwd: args.cwd,
    approvalPolicy: args.approvalPolicy,
    approvalsReviewer: args.approvalsReviewer ?? 'user',
    sandboxPolicy: buildCodexSandboxPolicy(args.sandbox, args.cwd, args.workspacePolicy),
    model: args.model || null,
    summary: 'concise',
    // Omit when default — an explicit null is "no override" per schema, but
    // omitting is the conservative shape older codex builds also accept.
    ...(args.reasoningEffort ? { effort: args.reasoningEffort } : {}),
    ...(args.clientUserMessageId ? { clientUserMessageId: args.clientUserMessageId } : {}),
  };
}

export function resolveCodexConversationBranchPoint(
  turns: unknown,
  targetTurnId: string,
): { kind: 'fresh-thread' } | { kind: 'through-turn'; runtimeTurnId: string } {
  if (!Array.isArray(turns)) {
    throw new RuntimeConversationBranchError('anchor_unavailable', 'Codex did not return full turn history');
  }
  const matches = turns.filter((entry) => (
    entry && typeof entry === 'object' && (entry as { id?: unknown }).id === targetTurnId
  ));
  if (matches.length !== 1) {
    throw new RuntimeConversationBranchError('anchor_unavailable', 'The Codex turn anchor is unavailable');
  }
  const target = matches[0] as { status?: unknown };
  if (target.status !== 'completed') {
    throw new RuntimeConversationBranchError('anchor_unavailable', 'The Codex turn anchor is not completed');
  }
  const index = turns.indexOf(matches[0]);
  if (index === 0) return { kind: 'fresh-thread' };
  const previous = turns[index - 1] as { id?: unknown; status?: unknown } | undefined;
  if (!previous || typeof previous.id !== 'string' || previous.status !== 'completed') {
    throw new RuntimeConversationBranchError('anchor_unavailable', 'The previous Codex turn boundary is unavailable');
  }
  return { kind: 'through-turn', runtimeTurnId: previous.id };
}

function codexConversationRpcFailureCode(
  error: unknown,
  fallback: 'anchor_unavailable' | 'native_fork_failed',
): 'capability_unavailable' | 'anchor_unavailable' | 'native_fork_failed' {
  const detail = error instanceof Error ? error.message : String(error);
  if (/no rollout|(?:turn|anchor).*(?:not found|missing|unavailable)|unknown turn/i.test(detail)) {
    return 'anchor_unavailable';
  }
  if (/-3260[12]|method not found|invalid params|unknown field|schema/i.test(detail)) {
    return 'capability_unavailable';
  }
  return fallback;
}

export function buildCodexTurnSteerParams(args: {
  threadId: string;
  input: unknown[];
  expectedTurnId: string;
  clientUserMessageId?: string | null;
}): Record<string, unknown> {
  return {
    threadId: args.threadId,
    input: args.input,
    expectedTurnId: args.expectedTurnId,
    ...(args.clientUserMessageId ? { clientUserMessageId: args.clientUserMessageId } : {}),
  };
}

function isKnownCodexServerRequestMethod(method: string): method is KnownCodexServerRequestMethod {
  return (KNOWN_CODEX_SERVER_REQUEST_METHODS as readonly string[]).includes(method);
}

function splitAnswerString(value: unknown): string[] {
  if (Array.isArray(value)) return value.map(String).map(s => s.trim()).filter(Boolean);
  if (typeof value !== 'string') return [];
  return value.split(',').map(s => s.trim()).filter(Boolean);
}

function shouldDenyCodexStructuredUserInput(proc: {
  runtimeSource?: RuntimeSource;
  scenario: InteractionScenario;
}): boolean {
  return proc.runtimeSource === 'managed-provider' || shouldDisallowAskUserQuestion(proc.scenario);
}

function answerList(value: unknown, opts: { splitComma: boolean }): string[] {
  if (Array.isArray(value)) return value.map(String).map(s => s.trim()).filter(Boolean);
  if (typeof value !== 'string') return [];
  if (opts.splitComma) return splitAnswerString(value);
  const trimmed = value.trim();
  return trimmed ? [trimmed] : [];
}

function hasAnswerValue(value: unknown): boolean {
  if (Array.isArray(value)) return value.some((entry) => String(entry).trim().length > 0);
  if (typeof value === 'string') return value.trim().length > 0;
  return value != null;
}

function pickAnswer(
  answers: Record<string, unknown>,
  key: string,
  idx: number,
): { value: unknown; provided: boolean } {
  if (Object.prototype.hasOwnProperty.call(answers, key)) {
    return { value: answers[key], provided: hasAnswerValue(answers[key]) };
  }
  const legacyKey = String(idx);
  if (Object.prototype.hasOwnProperty.call(answers, legacyKey)) {
    return { value: answers[legacyKey], provided: hasAnswerValue(answers[legacyKey]) };
  }
  return { value: undefined, provided: false };
}

function getAnswersFromUpdatedInput(updatedInput?: Record<string, unknown>): Record<string, unknown> {
  return objectValue(updatedInput?.answers);
}

function commandDecisionForMethod(
  method: KnownCodexServerRequestMethod,
  decision: CodexDecision,
  interrupt = false,
): string {
  if (method === 'execCommandApproval' || method === 'applyPatchApproval') {
    if (decision === 'deny') return interrupt ? 'abort' : 'denied';
    return decision === 'always_allow' ? 'approved_for_session' : 'approved';
  }
  if (decision === 'deny') return interrupt ? 'cancel' : 'decline';
  return decision === 'always_allow' ? 'acceptForSession' : 'accept';
}

function buildToolUserInputResponse(
  pending: Extract<PendingCodexRequest, { kind: 'tool_user_input' }>,
  updatedInput?: Record<string, unknown>,
): Record<string, unknown> {
  const answers = getAnswersFromUpdatedInput(updatedInput);
  const questions = arrayValue(pending.params.questions);
  const answerMap: Record<string, { answers: string[] }> = {};
  questions.forEach((q, idx) => {
    const question = objectValue(q);
    const id = stringValue(question.id) || String(idx);
    answerMap[id] = {
      answers: answerList(answers[id] ?? answers[String(idx)], { splitComma: false }),
    };
  });
  return { answers: answerMap };
}

function enumOptions(schema: Record<string, unknown>): Array<{ value: string; label: string }> {
  if (Array.isArray(schema.enum)) {
    const names = Array.isArray(schema.enumNames) ? schema.enumNames : [];
    return schema.enum.map((v, idx) => ({
      value: String(v),
      label: String(names[idx] ?? v),
    }));
  }
  if (Array.isArray(schema.oneOf)) {
    return schema.oneOf
      .map((entry) => objectValue(entry))
      .filter((entry) => typeof entry.const === 'string')
      .map((entry) => ({
        value: String(entry.const),
        label: String(entry.title ?? entry.const),
      }));
  }
  const items = objectValue(schema.items);
  if (Array.isArray(items.enum)) {
    return items.enum.map((v) => ({ value: String(v), label: String(v) }));
  }
  if (Array.isArray(items.anyOf)) {
    return items.anyOf
      .map((entry) => objectValue(entry))
      .filter((entry) => typeof entry.const === 'string')
      .map((entry) => ({
        value: String(entry.const),
        label: String(entry.title ?? entry.const),
      }));
  }
  return [];
}

function answerLabelToEnumValue(schema: Record<string, unknown>, answer: string): string {
  const match = enumOptions(schema).find((opt) => opt.label === answer || opt.value === answer);
  return match?.value ?? answer;
}

function defaultForSchema(schema: Record<string, unknown>): unknown {
  if ('default' in schema) return schema.default;
  return undefined;
}

function coerceMcpAnswer(
  schema: Record<string, unknown>,
  answer: unknown,
): unknown {
  const schemaOptions = enumOptions(schema);
  const selected = schema.type === 'array'
    ? answerList(answer, { splitComma: true })
    : answerList(answer, { splitComma: false });
  if (selected.length === 0) return defaultForSchema(schema);
  switch (schema.type) {
    case 'boolean': {
      const v = selected[0]?.toLowerCase();
      return v === 'true' || v === 'yes' || v === '1' || v === '是';
    }
    case 'integer':
    case 'number': {
      const n = Number(selected[0]);
      return Number.isFinite(n) ? n : defaultForSchema(schema);
    }
    case 'array':
      return selected.map((v) => answerLabelToEnumValue(schema, v));
    default:
      return schemaOptions.length > 0
        ? answerLabelToEnumValue(schema, selected[0] ?? '')
        : selected[0] ?? defaultForSchema(schema);
  }
}

function buildMcpElicitationContent(
  params: Record<string, unknown>,
  updatedInput?: Record<string, unknown>,
): Record<string, unknown> | null {
  if (params.mode !== 'form' && params.mode !== 'openai/form') return null;
  const requestedSchema = objectValue(params.requestedSchema);
  const properties = objectValue(requestedSchema.properties);
  const required = new Set(arrayValue(requestedSchema.required).filter((v): v is string => typeof v === 'string'));
  const answers = getAnswersFromUpdatedInput(updatedInput);
  const content: Record<string, unknown> = {};
  Object.entries(properties).forEach(([key, schemaValue], idx) => {
    const schema = objectValue(schemaValue);
    const picked = pickAnswer(answers, key, idx);
    if (!picked.provided) {
      if ('default' in schema) {
        content[key] = schema.default;
      }
      return;
    }
    const value = coerceMcpAnswer(schema, picked.value);
    if (value !== undefined) {
      content[key] = value;
    }
  });
  for (const key of required) {
    if (!Object.prototype.hasOwnProperty.call(content, key)) return null;
  }
  return content;
}

function buildGrantedPermissionProfile(params: Record<string, unknown>): Record<string, unknown> {
  const requested = objectValue(params.permissions);
  const granted: Record<string, unknown> = {};
  if (requested.network != null) granted.network = requested.network;
  if (requested.fileSystem != null) granted.fileSystem = requested.fileSystem;
  return granted;
}

export function serializeCodexPermissionResponse(
  pending: PendingCodexRequest,
  decision: CodexDecision,
  updatedInput?: Record<string, unknown>,
  interrupt = false,
): CodexResponseAction {
  switch (pending.kind) {
    case 'command_approval':
    case 'file_approval':
      return {
        type: 'result',
        result: {
          decision: commandDecisionForMethod(pending.method, decision, interrupt),
        },
      };
    case 'tool_user_input':
      if (decision === 'deny') {
        return { type: 'result', result: { answers: {} } };
      }
      return {
        type: 'result',
        result: buildToolUserInputResponse(pending, updatedInput),
      };
    case 'mcp_elicitation': {
      if (decision === 'deny') {
        return {
          type: 'result',
          result: {
            action: interrupt ? 'cancel' : 'decline',
            content: null,
            _meta: null,
          },
        };
      }
      const content = buildMcpElicitationContent(pending.params, updatedInput);
      if ((pending.params.mode === 'form' || pending.params.mode === 'openai/form') && content === null) {
        return {
          type: 'error',
          code: -32000,
          message: 'Missing required MCP elicitation answers',
        };
      }
      return {
        type: 'result',
        result: {
          action: 'accept',
          content,
          _meta: null,
        },
      };
    }
    case 'permissions_approval':
      if (decision === 'deny') {
        return {
          type: 'error',
          code: -32000,
          message: 'User denied Codex permission request',
        };
      }
      return {
        type: 'result',
        result: {
          permissions: buildGrantedPermissionProfile(pending.params),
          scope: decision === 'always_allow' ? 'session' : 'turn',
        },
      };
    case 'host_tool_approval':
      return {
        type: 'result',
        result: {
          success: false,
          contentItems: [{
            type: 'inputText',
            text: decision === 'deny'
              ? 'User denied the Managed Codex Host tool request.'
              : 'Managed Codex Host tool approval was not dispatched.',
          }],
        } satisfies CodexDynamicToolCallResult,
      };
  }
}

function toolRequestUserInputToAskUserQuestion(params: Record<string, unknown>): Record<string, unknown> {
  const questions = arrayValue(params.questions).map((raw, idx) => {
    const q = objectValue(raw);
    const options = arrayValue(q.options).map((rawOpt) => {
      if (typeof rawOpt === 'string') {
        return { label: rawOpt, description: '' };
      }
      const opt = objectValue(rawOpt);
      return {
        label: String(opt.label ?? ''),
        description: String(opt.description ?? ''),
      };
    }).filter((opt) => opt.label || opt.description);
    return {
      id: stringValue(q.id) || String(idx),
      header: stringValue(q.header) || `Question ${idx + 1}`,
      question: stringValue(q.question) || '',
      options,
      multiSelect: q.multiSelect === true,
      required: q.required === false || q.optional === true ? false : true,
      isSecret: q.isSecret === true,
    };
  });
  return { questions, metadata: { source: 'codex_tool_request_user_input' } };
}

function mcpElicitationToAskUserQuestion(params: Record<string, unknown>): Record<string, unknown> {
  const schema = objectValue(params.requestedSchema);
  const properties = objectValue(schema.properties);
  const required = new Set(arrayValue(schema.required).filter((v): v is string => typeof v === 'string'));
  const questions = Object.entries(properties).map(([key, schemaValue]) => {
    const prop = objectValue(schemaValue);
    const options = prop.type === 'boolean'
      ? [
          { label: 'true', description: '是' },
          { label: 'false', description: '否' },
        ]
      : enumOptions(prop).map((opt) => ({ label: opt.label, description: opt.value }));
    return {
      id: key,
      header: stringValue(prop.title) || key,
      question: stringValue(prop.description) || stringValue(params.message) || key,
      options,
      multiSelect: prop.type === 'array',
      required: required.has(key),
      isSecret: prop.format === 'password' || prop.writeOnly === true,
    };
  });
  return {
    questions,
    metadata: { source: 'codex_mcp_elicitation', serverName: params.serverName },
  };
}

function isCodexMcpApprovalElicitation(params: Record<string, unknown>): boolean {
  const meta = objectValue(params._meta);
  return meta.codex_approval_kind === 'mcp_tool_call'
    || meta.codexApprovalKind === 'mcp_tool_call';
}

function resolvedServerRequestId(params: Record<string, unknown>): string | null {
  const candidates = [
    params.requestId,
    params.serverRequestId,
    params.rpcId,
    params.id,
    objectValue(params.request).id,
  ];
  for (const candidate of candidates) {
    if (typeof candidate === 'string' || typeof candidate === 'number') {
      return String(candidate);
    }
  }
  return null;
}

// ─── Sub-agent (collab-agent) thread correlation ───
//
// Codex sub-agents are SEPARATE threads multiplexed over the one app-server
// stdio connection; every item/started + item/completed notification carries a
// top-level `threadId`. Legacy Codex links spawnAgent via
// `collabAgentToolCall.receiverThreadIds`; multi-agent v2 uses the terminal
// `subAgentActivity` item. Both normalize into the same turn-local maps so a
// child's trace nests under a CollabAgent card — mirroring the builtin SDK's
// `parent_tool_use_id` → Task card contract.

/**
 * Resolve a Codex thread to the TOP-LEVEL `spawnAgent` card it should nest under.
 *
 * A sub-agent can itself spawn deeper sub-agents (`thread_spawn.depth > 0`). The
 * renderer nests ONE level only (a spawn card holds a flat list of descendant
 * tools), so every descendant tool is attributed to its first-level ancestor
 * spawn card. We walk the `parent_thread_id` chain to the root and return the
 * card of the highest ancestor thread that has one.
 *
 * @param threadId        the thread that emitted the item
 * @param threadToCard    child threadId → spawnAgent collabAgentToolCall id (from receiverThreadIds)
 * @param threadToParent  child threadId → its immediate parent thread id (from thread/started subagent source)
 * @returns the spawn card id to nest under, or null when threadId maps to no
 *          spawn card. The item router decides whether null means main-thread
 *          delivery or a foreign-thread event that must wait for correlation.
 */
export function resolveTopLevelSpawnCard(
  threadId: string,
  threadToCard: ReadonlyMap<string, string>,
  threadToParent: ReadonlyMap<string, string>,
): string | null {
  const visited = new Set<string>();
  let current: string | undefined = threadId;
  let topCard: string | null = null;
  while (current && !visited.has(current)) {
    visited.add(current);
    const card = threadToCard.get(current);
    if (card) topCard = card; // keep the highest-ancestor card seen so far
    current = threadToParent.get(current);
  }
  return topCard;
}

/**
 * Notification methods that drive the MAIN MyAgents session and carry a
 * top-level `threadId`. When such an event comes from a spawned sub-agent
 * thread it must be ignored (see the guard in parseNotification). Two reasons a
 * method belongs here:
 *   - LIFECYCLE (turn/*, thread/status|closed): a child's turn/completed would
 *     finalize the user's turn early + resetTurnAccumulators() mid-fan-out.
 *     A child's turn/plan/updated would also overwrite the main AgentStatusPanel
 *     todo snapshot.
 *   - USAGE (thread/tokenUsage/updated, rawResponse/completed): a child's token usage would otherwise
 *     flow through as a `usage` event and pollute the MAIN session's context
 *     indicator + persisted lastContextUsage (external-session attributes every
 *     `usage` event to the main turn). Codex sends { threadId, turnId, tokenUsage }.
 * Item notifications are deliberately excluded — those are the sub-agent tools we
 * want to surface/nest.
 */
const CHILD_GATED_METHODS: ReadonlySet<string> = new Set([
  'turn/started',
  'turn/completed',
  'turn/plan/updated',
  'thread/status/changed',
  'thread/closed',
  'thread/tokenUsage/updated',
  'rawResponse/completed',
]);
export function isChildThreadGatedMethod(method: string): boolean {
  return CHILD_GATED_METHODS.has(method);
}

/**
 * Extract `{ parentThreadId, nickname, role }` from a Codex Thread's `source`
 * when it is a sub-agent thread-spawn, else null. Best-effort: Codex 0.135.0
 * does NOT emit `thread/started` for spawned children on the app-server
 * connection (verified live), so this currently only fires on future/other
 * Codex versions that do — the authoritative links are the version-specific
 * spawn activity items handled below. Tolerant of BOTH the v2
 * app-server casing (`subagent`) and the legacy root-schema casing (`subAgent`),
 * plus the snake_case spawn fields (ts-rs emits Rust names verbatim).
 */
export function parseSubAgentThreadSource(thread: unknown): {
  parentThreadId: string;
  nickname?: string;
  role?: string;
} | null {
  if (!isRecord(thread)) return null;
  const source = thread.source;
  if (!isRecord(source)) return null;
  const subagent = isRecord(source.subagent) ? source.subagent : (isRecord(source.subAgent) ? source.subAgent : undefined);
  if (!isRecord(subagent)) return null;
  const spawn = subagent.thread_spawn;
  if (!isRecord(spawn)) return null;
  const parentThreadId = stringValue(spawn.parent_thread_id);
  if (!parentThreadId) return null;
  return {
    parentThreadId,
    // Prefer the spawn-source names; fall back to the Thread-level fields.
    nickname: stringValue(spawn.agent_nickname) ?? stringValue(thread.agentNickname),
    role: stringValue(spawn.agent_role) ?? stringValue(thread.agentRole),
  };
}

/**
 * Record `spawnAgent` child threads → this spawn card id. ONLY `spawnAgent`
 * creates the parent/child relationship; `wait`/`closeAgent`/`sendInput`
 * reference existing children and must NOT remap them (that would re-parent a
 * sub-agent's tools under the wait card). Idempotent.
 */
export function recordSpawnAgentChildThreads(
  proc: { subThreadToCard: Map<string, string> },
  tool: string | undefined,
  cardId: string,
  receiverThreadIds: string[] | undefined,
): void {
  if (tool !== 'spawnAgent' || !Array.isArray(receiverThreadIds)) return;
  for (const childId of receiverThreadIds) {
    if (typeof childId === 'string' && childId) {
      proc.subThreadToCard.set(childId, cardId);
    }
  }
}

/**
 * A v2 descendant may announce its own spawn before the ancestor's
 * `subAgentActivity(started)` reaches this multiplexed stream. In that window
 * the descendant has a local card id, but it cannot yet be resolved to the
 * renderer's one-level TOP-LEVEL container. Treat that chain as unresolved so
 * the adapter can defer it instead of attaching to an orphan nested card.
 *
 * Legacy Codex direct children do not expose a parent link; a thread with its
 * own card and no parent entry therefore remains a valid resolved legacy shape.
 */
function hasUnresolvedSubAgentAncestor(
  threadId: string,
  mainThreadId: string,
  threadToCard: ReadonlyMap<string, string>,
  threadToParent: ReadonlyMap<string, string>,
): boolean {
  const visited = new Set<string>();
  let current = threadId;
  while (!visited.has(current)) {
    visited.add(current);
    const parent = threadToParent.get(current);
    if (!parent) return false;
    if (parent === mainThreadId) return !threadToCard.has(current);
    if (!threadToCard.has(parent) && !threadToParent.has(parent)) return true;
    current = parent;
  }
  return true;
}

/**
 * Decide the sub-agent scope for an item notification from its `threadId`.
 * Returns null for main-thread or not-yet-correlated items; callers MUST use
 * `computeCodexItemEventRoute` to distinguish main delivery from defer.
 */
export function computeSubAgentScope(
  itemThreadId: string | undefined,
  mainThreadId: string,
  threadToCard: ReadonlyMap<string, string>,
  threadToParent: ReadonlyMap<string, string>,
  threadMeta: ReadonlyMap<string, { nickname?: string; role?: string }>,
): SubAgentScope | null {
  if (!itemThreadId || itemThreadId === mainThreadId) return null;
  if (hasUnresolvedSubAgentAncestor(itemThreadId, mainThreadId, threadToCard, threadToParent)) {
    return null;
  }
  const parentToolUseId = resolveTopLevelSpawnCard(itemThreadId, threadToCard, threadToParent);
  if (!parentToolUseId) return null;
  const meta = threadMeta.get(itemThreadId);
  return { parentToolUseId, nickname: meta?.nickname, role: meta?.role };
}

export type CodexItemEventRoute =
  | { kind: 'main' }
  | { kind: 'subagent'; scope: SubAgentScope }
  | { kind: 'defer' };

/**
 * Classify an item notification before it crosses the runtime boundary.
 * Foreign-thread events are never allowed to inherit the main transcript just
 * because their correlation signal has not arrived yet.
 */
export function computeCodexItemEventRoute(
  itemThreadId: string | undefined,
  mainThreadId: string,
  threadToCard: ReadonlyMap<string, string>,
  threadToParent: ReadonlyMap<string, string>,
  threadMeta: ReadonlyMap<string, { nickname?: string; role?: string }>,
): CodexItemEventRoute {
  if (!itemThreadId || itemThreadId === mainThreadId) return { kind: 'main' };
  const scope = computeSubAgentScope(
    itemThreadId,
    mainThreadId,
    threadToCard,
    threadToParent,
    threadMeta,
  );
  return scope ? { kind: 'subagent', scope } : { kind: 'defer' };
}

/**
 * Resolve non-spawn collab-agent control actions (`wait`, `sendInput`,
 * `closeAgent`, future control tools) to the spawn card(s) they operate on.
 *
 * These actions are emitted on the MAIN thread, so thread-based scoping returns
 * null. Their `receiverThreadIds` are references to already-spawned child
 * threads; use those references to nest the control action inside the existing
 * spawn trace instead of rendering a second top-level CollabAgent card.
 */
export function resolveCollabAgentControlParents(
  tool: string | undefined,
  receiverThreadIds: string[] | undefined,
  threadToCard: ReadonlyMap<string, string>,
  threadToParent: ReadonlyMap<string, string>,
): string[] {
  if (!tool || tool === 'spawnAgent' || !Array.isArray(receiverThreadIds)) return [];

  const parents: string[] = [];
  const seen = new Set<string>();
  for (const receiverThreadId of receiverThreadIds) {
    if (typeof receiverThreadId !== 'string' || !receiverThreadId) continue;
    const parentToolUseId = resolveTopLevelSpawnCard(receiverThreadId, threadToCard, threadToParent);
    if (!parentToolUseId || seen.has(parentToolUseId)) continue;
    seen.add(parentToolUseId);
    parents.push(parentToolUseId);
  }
  return parents;
}

export function subagentControlToolUseId(toolUseId: string, parentToolUseId: string): string {
  return `${toolUseId}::subagent-control::${parentToolUseId}`;
}

type CollabAgentItemLike = {
  id: string;
  tool?: string;
  status?: string;
  prompt?: string;
  model?: string;
  senderThreadId?: string;
  receiverThreadIds?: string[];
  activityKind?: 'started' | 'interacted' | 'interrupted';
  agentPath?: string;
};

function isCollabAgentError(item: CollabAgentItemLike): boolean {
  return item.status === 'failed';
}

function buildCollabAgentInput(item: CollabAgentItemLike): Record<string, unknown> | undefined {
  const input: Record<string, unknown> = {};
  if (item.tool) input.tool = item.tool;
  if (item.status) input.status = item.status;
  if (item.prompt) input.prompt = item.prompt;
  if (item.model) input.model = item.model;
  if (item.senderThreadId) input.senderThreadId = item.senderThreadId;
  if (Array.isArray(item.receiverThreadIds)) input.receiverThreadIds = item.receiverThreadIds;
  if (item.activityKind) input.activityKind = item.activityKind;
  if (item.agentPath) input.agentPath = item.agentPath;
  return Object.keys(input).length > 0 ? input : undefined;
}

function buildCollabAgentResultContent(item: CollabAgentItemLike): string {
  const parts: string[] = [];
  if (item.tool) parts.push(`Tool: ${item.tool}`);
  if (item.status) parts.push(`Status: ${item.status}`);
  if (item.prompt) parts.push(`Prompt: ${item.prompt}`);
  if (item.model) parts.push(`Model: ${item.model}`);
  if (item.senderThreadId) parts.push(`From: ${item.senderThreadId}`);
  if (Array.isArray(item.receiverThreadIds) && item.receiverThreadIds.length > 0) {
    parts.push(`To: ${item.receiverThreadIds.join(', ')}`);
  }
  if (item.activityKind) parts.push(`Activity: ${item.activityKind}`);
  if (item.agentPath) parts.push(`Agent: ${item.agentPath}`);
  return parts.join('\n') || 'Collab agent invoked';
}

type CodexSubAgentCorrelationState = {
  subThreadToCard: Map<string, string>;
  subThreadToParent: Map<string, string>;
  subThreadMeta: Map<string, { nickname?: string; role?: string }>;
};

type CodexSubAgentActivityKind = 'started' | 'interacted' | 'interrupted';

function subAgentActivityTool(kind: CodexSubAgentActivityKind): string {
  switch (kind) {
    case 'started': return 'spawnAgent';
    case 'interacted': return 'sendInput';
    case 'interrupted': return 'interruptAgent';
  }
}

function buildSubAgentActivityEvents(
  item: CollabAgentItemLike,
  subAgent?: SubAgentScope,
): UnifiedEvent[] {
  const scoped = subAgent ? { subAgent } : {};
  return [
    {
      kind: 'tool_use_start',
      toolUseId: item.id,
      toolName: 'CollabAgent',
      input: buildCollabAgentInput(item),
      ...scoped,
    },
    { kind: 'tool_use_stop', toolUseId: item.id, ...scoped },
    {
      kind: 'tool_result',
      toolUseId: item.id,
      content: buildCollabAgentResultContent(item),
      ...scoped,
    },
  ];
}

/**
 * Normalize Codex multi-agent v2's terminal `subAgentActivity` item into the
 * existing CollabAgent container contract and update turn-local correlation.
 *
 * `started` is the v2 spawn signal and its item id is the originating
 * `spawn_agent` call id. `interacted` can also be the first signal for a child
 * resumed in a later user turn; in that case the interaction card becomes the
 * new turn-local container. Child-originated activities stay within the
 * sender's already-resolved top-level card.
 */
export function applyCodexSubAgentActivity(
  state: CodexSubAgentCorrelationState,
  notificationThreadId: string | undefined,
  mainThreadId: string,
  rawItem: unknown,
  interactionDelivery?: 'queue-only' | 'trigger-turn',
): UnifiedEvent[] | null {
  if (!isRecord(rawItem) || rawItem.type !== 'subAgentActivity') return null;
  const id = stringValue(rawItem.id);
  const agentThreadId = stringValue(rawItem.agentThreadId);
  const agentPath = stringValue(rawItem.agentPath);
  const kind = rawItem.kind;
  if (
    !id
    || !agentThreadId
    || !agentPath
    || (kind !== 'started' && kind !== 'interacted' && kind !== 'interrupted')
  ) {
    return null;
  }

  const senderThreadId = notificationThreadId || mainThreadId;
  const senderRoute = computeCodexItemEventRoute(
    senderThreadId,
    mainThreadId,
    state.subThreadToCard,
    state.subThreadToParent,
    state.subThreadMeta,
  );
  const targetRoute = computeCodexItemEventRoute(
    agentThreadId,
    mainThreadId,
    state.subThreadToCard,
    state.subThreadToParent,
    state.subThreadMeta,
  );

  let scope = senderRoute.kind === 'subagent' ? senderRoute.scope : undefined;
  if (kind === 'started') {
    state.subThreadToCard.set(agentThreadId, id);
    if (senderThreadId !== agentThreadId) {
      state.subThreadToParent.set(agentThreadId, senderThreadId);
    }
  } else if (senderThreadId === mainThreadId) {
    // A raw-discriminated followup_task starts a new child turn, so this
    // current-turn activity card becomes its independent lifecycle owner even
    // when the same child already completed under a spawn card earlier in the
    // root turn. queue-only send_message remains nested under the current card.
    if (interactionDelivery === 'trigger-turn' && agentThreadId !== mainThreadId) {
      state.subThreadToCard.set(agentThreadId, id);
      state.subThreadToParent.set(agentThreadId, mainThreadId);
    } else if (targetRoute.kind === 'subagent') {
      scope = targetRoute.scope;
    } else if (agentThreadId !== mainThreadId) {
      state.subThreadToCard.set(agentThreadId, id);
      state.subThreadToParent.set(agentThreadId, mainThreadId);
    }
  } else if (agentThreadId !== mainThreadId && targetRoute.kind === 'defer') {
    // Record the edge even when the sender's own top-level spawn activity is
    // still in flight. Once that ancestor arrives, both the interaction and the
    // receiver's output resolve together under the same one-level UI card.
    state.subThreadToCard.set(agentThreadId, scope?.parentToolUseId ?? id);
    state.subThreadToParent.set(agentThreadId, senderThreadId);
  }

  const item: CollabAgentItemLike = {
    id,
    tool: subAgentActivityTool(kind),
    status: kind === 'interrupted' ? 'interrupted' : 'completed',
    senderThreadId,
    receiverThreadIds: [agentThreadId],
    activityKind: kind,
    agentPath,
  };
  return buildSubAgentActivityEvents(item, scope);
}

export function buildCollabAgentControlStartEvents(
  item: CollabAgentItemLike,
  parentToolUseIds: readonly string[],
): UnifiedEvent[] {
  if (item.tool === 'spawnAgent' || parentToolUseIds.length === 0) return [];
  const input = buildCollabAgentInput(item);
  return parentToolUseIds.map((parentToolUseId) => ({
    kind: 'tool_use_start' as const,
    toolUseId: subagentControlToolUseId(item.id, parentToolUseId),
    toolName: 'CollabAgent',
    input,
    subAgent: { parentToolUseId },
  }));
}

export function buildCollabAgentControlCompletedEvents(
  item: CollabAgentItemLike,
  parentToolUseIds: readonly string[],
  options: { includeStart?: boolean } = {},
): UnifiedEvent[] {
  const input = buildCollabAgentInput(item);
  const content = buildCollabAgentResultContent(item);
  const isError = isCollabAgentError(item) ? true : undefined;
  if (item.tool === 'spawnAgent' || parentToolUseIds.length === 0) {
    return [
      { kind: 'tool_use_start', toolUseId: item.id, toolName: 'CollabAgent', input },
      { kind: 'tool_use_stop', toolUseId: item.id },
      { kind: 'tool_result', toolUseId: item.id, content, isError },
    ];
  }

  const includeStart = options.includeStart ?? true;
  return parentToolUseIds.flatMap((parentToolUseId) => {
    const toolUseId = subagentControlToolUseId(item.id, parentToolUseId);
    const subAgent: SubAgentScope = { parentToolUseId };
    return [
      ...(includeStart ? [{ kind: 'tool_use_start' as const, toolUseId, toolName: 'CollabAgent', input, subAgent }] : []),
      { kind: 'tool_use_stop' as const, toolUseId, subAgent },
      { kind: 'tool_result' as const, toolUseId, content, subAgent, isError },
    ];
  });
}

export function resolveCollabControlCompletionRoute(
  latchedParents: readonly string[] | undefined,
  resolvedParents: readonly string[],
): { parentToolUseIds: string[]; includeStart: boolean } {
  if (latchedParents && latchedParents.length > 0) {
    return { parentToolUseIds: [...latchedParents], includeStart: false };
  }
  return { parentToolUseIds: [...resolvedParents], includeStart: true };
}

/** UnifiedEvent kinds eligible for sub-agent scoping. */
function isSubAgentScopedEvent(
  event: UnifiedEvent,
): event is Extract<UnifiedEvent, { subAgent?: SubAgentScope }> {
  return event.kind === 'text_delta'
    || event.kind === 'text_stop'
    || event.kind === 'thinking_start'
    || event.kind === 'thinking_delta'
    || event.kind === 'thinking_stop'
    || event.kind === 'tool_use_start'
    || event.kind === 'tool_input_delta'
    || event.kind === 'tool_use_stop'
    || event.kind === 'tool_result_delta'
    || event.kind === 'tool_result';
}

function emitScopedCodexItemEvent(
  event: UnifiedEvent,
  scope: SubAgentScope,
  emit: UnifiedEventCallback,
): void {
  if (isSubAgentScopedEvent(event)) {
    if (!event.subAgent) event.subAgent = scope;
    emit(event);
    return;
  }
  // Attachment completion is routed by the external-session's latched child
  // tool id, so it does not need SubAgentScope on the event itself.
  if (event.kind === 'tool_attachment_update') {
    emit(event);
    return;
  }
  console.warn(`[codex] Suppressed unsupported child item event kind=${event.kind}`);
}

type CodexSubAgentRoutingState = CodexSubAgentCorrelationState & {
  threadId: string;
  deferredSubAgentEvents: Map<string, UnifiedEvent[]>;
  subAgentThreadsAwaitingActivity: Set<string>;
};

type CodexLegacySpawnLifecycleState = CodexSubAgentCorrelationState & {
  threadId: string;
  activeSubAgentTurns: Map<string, string | null>;
  completedSubAgentTurnsBeforeActivity: Set<string>;
};

type CodexSubAgentLifecycleRecord = {
  startedAt: number;
  terminalStatus?: Exclude<SubagentLifecycleStatus, 'running'>;
  finishedAt?: number;
};

type CodexSubAgentLifecycleState = CodexSubAgentCorrelationState & {
  threadId: string;
  activeSubAgentTurns: ReadonlyMap<string, string | null>;
  subAgentLifecycleByThread: Map<string, CodexSubAgentLifecycleRecord>;
  emittedSubAgentLifecycleByCard: Map<string, SubagentLifecycleStatus>;
};

function observeCodexSubAgentTurnStarted(
  proc: CodexSubAgentLifecycleState,
  childThreadId: string,
  observedAt: number,
): void {
  const current = proc.subAgentLifecycleByThread.get(childThreadId);
  if (!current || current.terminalStatus) {
    proc.subAgentLifecycleByThread.set(childThreadId, { startedAt: observedAt });
  }
}

function observeCodexSubAgentTurnTerminal(
  proc: CodexSubAgentLifecycleState,
  childThreadId: string,
  status: Exclude<SubagentLifecycleStatus, 'running'>,
  observedAt: number,
): void {
  const current = proc.subAgentLifecycleByThread.get(childThreadId);
  if (current?.terminalStatus) return;
  const startedAt = current?.startedAt ?? observedAt;
  proc.subAgentLifecycleByThread.set(childThreadId, {
    startedAt,
    terminalStatus: status,
    finishedAt: Math.max(startedAt, observedAt),
  });
}

export function mapCodexChildTurnTerminalStatus(turn: unknown): Exclude<SubagentLifecycleStatus, 'running'> {
  const status = stringValue(objectValue(turn).status)?.toLowerCase();
  if (status === 'completed' || status === 'success' || status === 'succeeded') return 'completed';
  if (
    status === 'interrupted'
    || status === 'cancelled'
    || status === 'canceled'
    || status === 'stopped'
  ) return 'interrupted';
  return 'failed';
}

function topLevelCardForThread(
  proc: CodexSubAgentLifecycleState,
  childThreadId: string,
): string | null {
  return resolveTopLevelSpawnCard(
    childThreadId,
    proc.subThreadToCard,
    proc.subThreadToParent,
  );
}

/**
 * Project native child-turn observations onto the current turn's visible
 * CollabAgent owner. Records remain turn-local; correlation can arrive before
 * or after the native notification without creating another lifecycle owner.
 */
export function collectCodexSubAgentLifecycleEvents(
  proc: CodexSubAgentLifecycleState,
): UnifiedEvent[] {
  const recordsByCard = new Map<string, Array<{
    threadId: string;
    record: CodexSubAgentLifecycleRecord;
  }>>();
  for (const [threadId, record] of proc.subAgentLifecycleByThread) {
    const parentToolUseId = topLevelCardForThread(proc, threadId);
    if (!parentToolUseId) continue;
    const records = recordsByCard.get(parentToolUseId) ?? [];
    records.push({ threadId, record });
    recordsByCard.set(parentToolUseId, records);
  }

  const events: UnifiedEvent[] = [];
  for (const [parentToolUseId, records] of recordsByCard) {
    const emitted = proc.emittedSubAgentLifecycleByCard.get(parentToolUseId);
    if (!emitted) {
      const startedAt = Math.min(...records.map(({ record }) => record.startedAt));
      events.push({
        kind: 'subagent_lifecycle',
        parentToolUseId,
        status: 'running',
        observedAt: startedAt,
      });
      proc.emittedSubAgentLifecycleByCard.set(parentToolUseId, 'running');
    }
    if (proc.emittedSubAgentLifecycleByCard.get(parentToolUseId) !== 'running') continue;

    const hasActiveDescendant = [...proc.activeSubAgentTurns.keys()]
      .some((threadId) => topLevelCardForThread(proc, threadId) === parentToolUseId);
    if (hasActiveDescendant) continue;

    const ownerRecords = records.filter(({ threadId }) => {
      const parentThreadId = proc.subThreadToParent.get(threadId);
      return proc.subThreadToCard.get(threadId) === parentToolUseId
        && (!parentThreadId || parentThreadId === proc.threadId);
    });
    if (ownerRecords.length === 0 || ownerRecords.some(({ record }) => !record.terminalStatus)) continue;

    const terminalStatus = ownerRecords.some(({ record }) => record.terminalStatus === 'failed')
      ? 'failed'
      : ownerRecords.some(({ record }) => record.terminalStatus === 'interrupted')
        ? 'interrupted'
        : 'completed';
    const finishedAt = Math.max(...ownerRecords.map(({ record }) => (
      record.finishedAt ?? record.startedAt
    )));
    events.push({
      kind: 'subagent_lifecycle',
      parentToolUseId,
      status: terminalStatus,
      observedAt: finishedAt,
    });
    proc.emittedSubAgentLifecycleByCard.set(parentToolUseId, terminalStatus);
  }
  return events;
}

/** Observe the v1 spawn signal and reserve each newly correlated child once. */
function recordLegacySpawnAgentLifecycle(
  proc: CodexLegacySpawnLifecycleState,
  item: CollabAgentItemLike,
): void {
  const newlyCorrelatedChildren = item.tool === 'spawnAgent'
    && Array.isArray(item.receiverThreadIds)
    ? item.receiverThreadIds.filter((threadId) => !proc.subThreadToCard.has(threadId))
    : [];
  recordSpawnAgentChildThreads(proc, item.tool, item.id, item.receiverThreadIds);
  for (const childThreadId of newlyCorrelatedChildren) {
    const completedBeforeCorrelation = proc.completedSubAgentTurnsBeforeActivity
      .delete(childThreadId);
    if (
      childThreadId !== proc.threadId
      && !completedBeforeCorrelation
      && !proc.activeSubAgentTurns.has(childThreadId)
    ) {
      proc.activeSubAgentTurns.set(childThreadId, null);
    }
  }
}

type CodexV2InteractionDelivery = 'queue-only' | 'trigger-turn';

type CodexExactTurnUsageState = {
  responseIds: Set<string>;
  complete: boolean;
  usage: CodexExactUsageTotals;
};

function recordCodexExactResponseUsage(
  exactUsageByTurn: Map<string, CodexExactTurnUsageState>,
  params: Record<string, unknown>,
): void {
  const turnId = stringValue(params.turnId);
  const responseId = stringValue(params.responseId);
  if (!turnId || !responseId) return;

  const existing = exactUsageByTurn.get(turnId);
  if (existing?.responseIds.has(responseId)) return;

  const next: CodexExactTurnUsageState = existing ?? {
    responseIds: new Set<string>(),
    complete: true,
    usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0 },
  };
  next.responseIds.add(responseId);
  const nextUsage = addCodexExactResponseUsage(next.usage, params.usage);
  if (!nextUsage) {
    // One missing provider usage would make a partial sum look exact. Invalidate
    // the whole turn and let thread/tokenUsage/updated remain authoritative.
    next.complete = false;
  } else {
    next.usage = nextUsage;
  }
  exactUsageByTurn.set(turnId, next);
}

function takeCodexExactTurnUsage(
  exactUsageByTurn: Map<string, CodexExactTurnUsageState>,
  turnId: string | undefined,
): CodexExactUsageTotals | null {
  if (!turnId) return null;
  const exact = exactUsageByTurn.get(turnId);
  exactUsageByTurn.delete(turnId);
  return exact?.complete && exact.responseIds.size > 0 ? exact.usage : null;
}

function hasDeferredToolOwner(
  proc: CodexSubAgentRoutingState,
  toolUseId: string,
): boolean {
  for (const events of proc.deferredSubAgentEvents.values()) {
    if (events.some((event) => (
      'toolUseId' in event && event.toolUseId === toolUseId
    ))) return true;
  }
  return false;
}

export function dispatchCodexItemEvent(
  proc: CodexSubAgentRoutingState,
  itemThreadId: string | undefined,
  event: UnifiedEvent,
  emit: UnifiedEventCallback,
): void {
  // Attachment fulfillment is already owned downstream by the tool-id latch.
  // Keep it in this causal buffer only while its placeholder/tool events have
  // not crossed that boundary yet; afterwards it must survive turn-local
  // thread-map cleanup and route solely by toolUseId.
  if (
    event.kind === 'tool_attachment_update'
    && !hasDeferredToolOwner(proc, event.toolUseId)
  ) {
    emit(event);
    return;
  }

  const waitingForActivity = !!itemThreadId
    && proc.subAgentThreadsAwaitingActivity.has(itemThreadId);
  const route = computeCodexItemEventRoute(
    itemThreadId,
    proc.threadId,
    proc.subThreadToCard,
    proc.subThreadToParent,
    proc.subThreadMeta,
  );
  if (route.kind === 'main' && !waitingForActivity) {
    emit(event);
    return;
  }
  if (route.kind === 'subagent' && !waitingForActivity) {
    emitScopedCodexItemEvent(event, route.scope, emit);
    return;
  }

  if (!itemThreadId) return;
  let deferred = proc.deferredSubAgentEvents.get(itemThreadId);
  if (!deferred) {
    deferred = [];
    proc.deferredSubAgentEvents.set(itemThreadId, deferred);
    console.warn(`[codex] Deferring foreign-thread items until sub-agent correlation arrives thread=${JSON.stringify(summarizeSensitiveValueForLog(itemThreadId))}`);
  }
  deferred.push(event);
}

/** Release every backlog whose full ancestor chain now reaches a turn-local card. */
export function flushResolvableCodexSubAgentEvents(
  proc: CodexSubAgentRoutingState,
  emit: UnifiedEventCallback,
): void {
  const depthFromMain = (threadId: string): number => {
    const visited = new Set<string>();
    let current = threadId;
    let depth = 0;
    while (!visited.has(current)) {
      visited.add(current);
      const parent = proc.subThreadToParent.get(current);
      if (!parent) return depth + 1;
      depth += 1;
      if (parent === proc.threadId) return depth;
      current = parent;
    }
    return Number.MAX_SAFE_INTEGER;
  };

  const ready = [...proc.deferredSubAgentEvents.entries()]
    .map(([threadId, events]) => ({
      threadId,
      events,
      route: computeCodexItemEventRoute(
        threadId,
        proc.threadId,
        proc.subThreadToCard,
        proc.subThreadToParent,
        proc.subThreadMeta,
      ),
      depth: depthFromMain(threadId),
    }))
    .filter((entry): entry is typeof entry & { route: { kind: 'subagent'; scope: SubAgentScope } } => (
      entry.route.kind === 'subagent'
      && !proc.subAgentThreadsAwaitingActivity.has(entry.threadId)
    ))
    .sort((a, b) => a.depth - b.depth);

  for (const { threadId, events, route } of ready) {
    proc.deferredSubAgentEvents.delete(threadId);
    for (const event of events) emitScopedCodexItemEvent(event, route.scope, emit);
  }
}

// ─── Model cache ───

const modelCache = new Map<string, { models: RuntimeModelInfo[]; timestamp: number }>();
const MODEL_CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes

export function codexModelCacheKey(runtimeSource: RuntimeSource, context: CodexCommandContext): string {
  // Include the resolved target: version-manager symlinks can select a different
  // installation without changing the command spelling. Live sessions use RPC.
  let executable = context.commandPath;
  let revision = '';
  try {
    executable = realpathSync(executable);
    const stat = statSync(executable);
    revision = `${stat.size}:${stat.mtimeMs}`;
  } catch { /* unavailable executable will fail at spawn */ }
  return JSON.stringify([
    runtimeSource, executable, context.version, revision,
    context.codexHome ?? context.env.CODEX_HOME ?? context.env.HOME ?? context.env.USERPROFILE,
    context.env.Path ?? context.env.PATH,
  ]);
}

// ─── JSON-RPC 2.0 Client ───

class JsonRpcResponseError extends Error {
  constructor(
    readonly code: number,
    message: string,
    readonly data?: unknown,
  ) {
    super(message);
    this.name = 'JsonRpcResponseError';
  }
}

type CodexNoActiveTurnSteerRejection = Error & { code: -32600 };

export function isCodexNoActiveTurnSteerRejection(
  error: unknown,
): error is CodexNoActiveTurnSteerRejection {
  const message = typeof error === 'object' && error !== null
    ? (error as { message?: unknown }).message
    : undefined;
  return (
    typeof error === 'object'
    && error !== null
    && (error as { code?: unknown }).code === -32600
    && typeof message === 'string'
    && /no active turn to steer/i.test(message)
  );
}

/**
 * Lightweight JSON-RPC 2.0 client for Codex app-server.
 *
 * Handles three message types:
 * - Client → Server Requests (call): send request, await response by matching id
 * - Server → Client Notifications (no id): dispatched via onNotification callback
 * - Server → Client Requests (with id): dispatched via onServerRequest, client must respond
 */
export class JsonRpcClient {
  private nextId = 1;
  private pending = new Map<number, { resolve: (r: unknown) => void; reject: (e: Error) => void }>();
  private onNotification: ((method: string, params: unknown) => void) | null = null;
  private onServerRequest: ((id: JsonRpcRequestId, method: string, params: unknown) => void) | null = null;
  private encoder = new TextEncoder();
  private sink: SubprocessStdin;
  private reading = false;

  constructor(
    private proc: Subprocess,
  ) {
    const stdin = proc.stdin;
    if (!stdin) throw new Error('stdin not available');
    this.sink = stdin;
  }

  /** Register notification handler (server → client, no id) */
  setNotificationHandler(handler: (method: string, params: unknown) => void): void {
    this.onNotification = handler;
  }

  /** Register server-request handler (server → client, with id, expects response) */
  setServerRequestHandler(handler: (id: JsonRpcRequestId, method: string, params: unknown) => void): void {
    this.onServerRequest = handler;
  }

  /** Send a JSON-RPC request and wait for the matching response */
  async call(method: string, params: unknown, timeoutMs = 30_000): Promise<unknown> {
    const id = this.nextId++;
    const msg = { jsonrpc: '2.0', id, method, params };
    this.write(msg);

    return new Promise<unknown>((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      const timer = setTimeout(() => {
        if (this.pending.has(id)) {
          this.pending.delete(id);
          reject(new Error(`JSON-RPC call "${method}" timed out after ${timeoutMs}ms`));
        }
      }, timeoutMs);
      // Clear timeout on resolution
      const orig = this.pending.get(id)!;
      this.pending.set(id, {
        resolve: (r) => { clearTimeout(timer); orig.resolve(r); },
        reject: (e) => { clearTimeout(timer); orig.reject(e); },
      });
    });
  }

  /** Send a JSON-RPC notification (client → server, no id) */
  notify(method: string, params?: unknown): void {
    const msg = params === undefined
      ? { jsonrpc: '2.0', method }
      : { jsonrpc: '2.0', method, params };
    this.write(msg);
  }

  /** Send a JSON-RPC response (for server-initiated requests) */
  respond(id: JsonRpcRequestId, result: unknown): void {
    this.write({ jsonrpc: '2.0', id, result });
  }

  /** Send a JSON-RPC error response */
  respondError(id: JsonRpcRequestId, code: number, message: string): void {
    this.write({ jsonrpc: '2.0', id, error: { code, message } });
  }

  /** Start the background reader loop. Must be called once after construction. */
  async startReading(): Promise<void> {
    if (this.reading) return;
    this.reading = true;
    const stdout = this.proc.stdout;
    if (!stdout) return;

    const reader = (stdout as ReadableStream<Uint8Array>).getReader();
    const decoder = new TextDecoder();
    let buffer = '';

    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });

        let newlineIdx: number;
        while ((newlineIdx = buffer.indexOf('\n')) !== -1) {
          const line = buffer.slice(0, newlineIdx).trim();
          buffer = buffer.slice(newlineIdx + 1);
          if (!line) continue;
          this.handleLine(line);
        }
      }
    } catch (err) {
      // Stream closed or process exited
      if (String(err).includes('cancel') || String(err).includes('closed')) return;
      console.error('[codex-rpc] Reader error:', summarizeCodexErrorForLog(err));
    } finally {
      reader.releaseLock();
      // Reject all pending requests
      for (const [, { reject }] of this.pending) {
        reject(new Error('app-server process exited'));
      }
      this.pending.clear();
    }
  }

  private handleLine(line: string): void {
    let msg: Record<string, unknown>;
    try {
      msg = JSON.parse(line);
    } catch {
      return; // Non-JSON output, ignore
    }

    // Response to our request (has id + result/error, no method)
    if ('id' in msg && !('method' in msg)) {
      const id = msg.id as number;
      const handler = this.pending.get(id);
      if (handler) {
        this.pending.delete(id);
        if (msg.error) {
          const err = msg.error as { code: number; message: string; data?: { details?: string } };
          // Carry err.data.details into the message so downstream stale-session
          // detection (and humans reading logs) see the actionable diagnostic,
          // not just the generic JSON-RPC "Internal error" wrapper.
          const details = typeof err.data?.details === 'string' ? `: ${err.data.details}` : '';
          handler.reject(new JsonRpcResponseError(
            err.code,
            `RPC error ${err.code}: ${err.message}${details}`,
            err.data,
          ));
        } else {
          handler.resolve(msg.result);
        }
      }
      return;
    }

    // Server notification (has method, no id)
    if ('method' in msg && !('id' in msg)) {
      this.onNotification?.(msg.method as string, msg.params);
      return;
    }

    // Server-initiated request (has method AND id)
    if ('method' in msg && 'id' in msg) {
      this.onServerRequest?.(msg.id as JsonRpcRequestId, msg.method as string, msg.params);
      return;
    }
  }

  private write(msg: unknown): void {
    // Fire-and-forget. sink.write() returns a Promise; back-pressure is
    // absorbed by Node's internal buffer. Rejection (e.g. stdin closed)
    // is swallowed — JSON-RPC layer detects liveness via process exit.
    void this.sink.write(this.encoder.encode(JSON.stringify(msg) + '\n')).catch(() => { /* stdin may be closed */ });
  }

  /** Clean up: reject all pending requests */
  destroy(): void {
    for (const [, { reject }] of this.pending) {
      reject(new Error('Client destroyed'));
    }
    this.pending.clear();
  }
}

// ─── CodexProcess wrapper ───

type CodexCompactControl = {
  turnId: string;
  restartRequired: boolean;
  resolve: () => void;
  reject: (error: Error) => void;
};

class CodexProcess implements RuntimeProcess {
  readonly pid: number;
  readonly runtimeGeneration: string;
  exited = false;
  loadedSkillNames: readonly string[] = [];
  private proc: Subprocess;

  // Codex-specific state
  rpc: JsonRpcClient;
  threadId = '';
  /** Most recent root/control turn id retained for turn-local correlation. */
  currentTurnId = '';
  /** Root turn currently eligible for same-turn input; cleared at native terminal. */
  activeSteerTurnId = '';
  compactControl: CodexCompactControl | null = null;
  version = '';
  activeRootTurnAdmission: {
    clientUserMessageId: string;
    responseTurnId?: string;
    notificationTurnId?: string;
    nativeTerminalObserved?: boolean;
    deferredTerminalEvents?: UnifiedEvent[];
  } | null = null;
  rootEventHandler: UnifiedEventCallback | null = null;
  agentMessageTextById = new Map<string, string>();
  pendingRequests = new Map<string, PendingCodexRequest>();
  readonly processGeneration = randomUUID();
  extensionSnapshot: ManagedCodexExtensionSnapshot | null = null;
  pendingHostCalls = new Map<string, PendingManagedCodexHostCall>();
  settledHostCallIds = new Set<string>();
  cleanupExtensionResources: () => void = () => {};

  // ── Sub-agent (collab-agent) thread correlation ──
  // Child threadId → the spawnAgent collabAgentToolCall id that created it
  // (from `receiverThreadIds`). The card a sub-agent's tools nest under.
  subThreadToCard = new Map<string, string>();
  // Child threadId → its immediate parent thread id (from thread/started
  // subagent source). Used to walk depth>1 chains up to the top-level card.
  subThreadToParent = new Map<string, string>();
  // Child threadId → { nickname, role } (from thread/started). Decorative labels.
  subThreadMeta = new Map<string, { nickname?: string; role?: string }>();
  // Non-spawn collab control tool id → resolved parent spawn card ids. Started
  // notifications may have receiverThreadIds while completed notifications may
  // omit them (or vice versa), so latch the route for the item lifetime.
  collabControlToolParents = new Map<string, string[]>();
  // Foreign-thread item events whose spawn/interact correlation has not reached
  // this multiplexed stream yet. Codex v2 starts the child before emitting the
  // parent's subAgentActivity, so this is a real causal window, not a retry
  // mechanism. Entries are released as soon as an ancestor card resolves and
  // discarded at the main turn boundary rather than leaking into the transcript.
  deferredSubAgentEvents = new Map<string, UnifiedEvent[]>();
  // Child turns are multiplexed independently and may finish after the root
  // model has produced its own terminal. Hold the root terminal until
  // every observed/started child turn settles so the existing current-turn
  // content owner can persist the complete nested trace.
  activeSubAgentTurns = new Map<string, string | null>();
  // A child can settle before its parent-side v2 activity or v1 spawn item is
  // observed. The terminal proves that a later correlation signal must not
  // reserve the already-finished child again.
  completedSubAgentTurnsBeforeActivity = new Set<string>();
  // A foreign turn can start producing items before the parent-side
  // subAgentActivity that caused it is emitted. Even an already-known child
  // must hold those items until the new interaction card crosses the stream.
  subAgentThreadsAwaitingActivity = new Set<string>();
  // Multi-agent v1 and v2 share child turn lifecycle notifications, but only
  // v2 emits subAgentActivity. Gate the activity fence on a process-lifetime
  // observation so legacy collabAgentToolCall children never wait for an item
  // their protocol cannot produce.
  codexV2SubAgentActivityObserved = false;
  // app-server's typed `interacted` item intentionally merges send_message
  // (queue only) and followup_task (turn trigger). Managed Codex opts into the
  // official raw item stream so the originating function name can be latched
  // by call_id before the lossy terminal item arrives.
  codexV2InteractionDeliveryByCallId = new Map<string, CodexV2InteractionDelivery>();
  // Codex 0.146 rawResponse/completed reports provider-authored usage for one
  // Responses API completion. A turn can make several completions around tool
  // calls, so accumulate them by turn and dedupe response ids until the root
  // terminal hands one exact delta to external-session's existing usage owner.
  exactUsageByTurn = new Map<string, CodexExactTurnUsageState>();
  // `interacted` conflates queue-only send_message and turn-triggering
  // followup_task. Remember an activity that precedes turn/started so the
  // latter does not install a stale causal fence, but never infer execution
  // ownership from the ambiguous activity alone.
  subAgentActivitySeenBeforeTurnStart = new Set<string>();
  // Native child-turn observations waiting for / attached to a turn-local
  // CollabAgent card. Cleared with the existing correlation maps.
  subAgentLifecycleByThread = new Map<string, CodexSubAgentLifecycleRecord>();
  emittedSubAgentLifecycleByCard = new Map<string, SubagentLifecycleStatus>();
  // Reasoning summary/content streams open lazily on their first delta and
  // close by the exact same trace id at item completion.
  openedReasoningTracesByItem = new Map<string, Map<string, number>>();
  // Deduplicate force-send and root-failure interrupts targeting the same
  // concrete child turn. The key is threadId + turnId, not just threadId,
  // because persistent children may execute multiple turns in one session.
  subAgentInterruptsInFlight = new Map<string, Promise<void>>();
  pendingMainTurnCompletion: UnifiedEvent[] | null = null;
  interruptPendingSubAgentTurns = false;
  // The adapter is tearing down this app-server while the root terminal is
  // held (failed child interrupt or unresolved lossy interaction). The exit
  // callback releases the original terminal before closing the runtime owner.
  releaseHeldMainTurnOnExit = false;

  workspacePath = '';
  scenario: InteractionScenario = { type: 'desktop' };
  runtimeSource: RuntimeSource = 'system-cli';
  model = '';
  approvalPolicy: CodexApprovalPolicy = 'on-request';
  approvalsReviewer: CodexApprovalsReviewer = 'user';
  supportsApprovalsReviewer = false;
  workspacePolicy?: CodexWorkspacePolicy;
  sandbox: CodexSandboxMode = 'workspace-write';
  permissionMode = '';
  defaultPermissionMode = 'full-auto';
  /** #324 — NORMALIZED effort level ('' = Codex default). Carried on every
   *  turn/start (its `effort` overrides "this turn and subsequent turns"),
   *  which is also what makes setReasoningEffort an in-place update. */
  reasoningEffort = '';
  models: RuntimeModelInfo[] = [];

  /** MyAgents sessionId (from SessionStartOptions). Used as the attachment scope key
   *  so refPath /api/attachment/tool/<sessionId>/<turnId>/<file> stays consistent
   *  across runtime resumes within the same MyAgents session. */
  sessionId = '';
  // True when the startSession catch-handler killed the process itself (stale
  // resume, init failure, etc.). Suppresses the synthetic "Codex process
  // exited with code 143" session_complete emitted by proc.exited.then — the
  // caller already owns the error surface. Issue #105.
  intentionalKillDuringStartup = false;

  constructor(proc: Subprocess) {
    this.proc = proc;
    this.pid = proc.pid;
    this.runtimeGeneration = this.processGeneration;
    this.rpc = new JsonRpcClient(proc);
  }

  async writeLine(_line: string): Promise<void> {
    // For Codex, messages go through RPC, not raw stdin.
    // This is kept for interface compliance; actual messaging uses rpc.call().
    throw new Error('Codex uses JSON-RPC, not raw stdin. Use rpc.call() instead.');
  }

  kill(signal?: NodeJS.Signals | number): void {
    if (this.exited) return;
    try {
      this.proc.kill(signal ?? 15);
    } catch { /* already dead */ }
  }

  async waitForExit(): Promise<number> {
    const code = await this.proc.exited;
    this.exited = true;
    return code;
  }

  /** Close stdin to signal the process to finish (awaits EOF flush). */
  async closeStdin(): Promise<void> {
    const stdin = this.proc.stdin;
    if (!stdin) return;
    try {
      await stdin.end();
    } catch { /* already closed / EPIPE */ }
  }

  abortPendingHostCalls(reason: string, turnId?: string): void {
    for (const pending of [...this.pendingHostCalls.values()]) {
      if (turnId && pending.turnId !== turnId) continue;
      this.abortPendingHostCall(pending.callId, reason);
    }
  }

  abortPendingHostCall(callId: string, reason: string): void {
    const pending = this.pendingHostCalls.get(callId);
    if (!pending || pending.settled) return;
    pending.settled = true;
    if (pending.timeout) clearTimeout(pending.timeout);
    pending.controller.abort(new Error(reason));
    this.pendingHostCalls.delete(pending.callId);
    const resolvedRequestIds: string[] = [];
    for (const [requestId, request] of this.pendingRequests) {
      if (request.kind === 'host_tool_approval' && request.callId === callId) {
        this.pendingRequests.delete(requestId);
        resolvedRequestIds.push(requestId);
      }
    }
    for (const requestId of resolvedRequestIds) {
      try {
        this.rootEventHandler?.({ kind: 'interactive_request_resolved', requestId });
      } catch { /* UI expiry must not prevent the protocol response */ }
    }
    this.settledHostCallIds.add(pending.callId);
    this.rpc.respond(pending.rpcId, {
      ...codexHostToolFailure(reason),
    });
  }

  disposeExtensionResources(reason: string): void {
    this.abortPendingHostCalls(reason);
    this.extensionSnapshot?.hostToolDispatcher?.dispose(reason);
    this.cleanupExtensionResources();
    this.cleanupExtensionResources = () => {};
  }
}

// ─── Permission mode mapping ───

function mapPermissionMode(mode: string, source: RuntimeSource): {
  approval: CodexApprovalPolicy; sandbox: CodexSandboxMode; reviewer: CodexApprovalsReviewer;
} {
  switch (mode) {
    case 'suggest':
      return { approval: 'untrusted', sandbox: 'read-only', reviewer: 'user' };
    case 'auto-edit':
      return { approval: 'on-request', sandbox: 'workspace-write', reviewer: source === 'managed-provider' ? 'auto_review' : 'user' };
    case 'full-auto':
      return { approval: 'on-request', sandbox: 'workspace-write', reviewer: 'auto_review' };
    case 'no-restrictions':
      return { approval: 'never', sandbox: 'danger-full-access', reviewer: 'user' };
    default:
      return { approval: 'on-request', sandbox: 'workspace-write', reviewer: 'user' };
  }
}

// ─── Stderr error classification (issue #194) ───
//
// Conservative pattern matcher: forwards a small set of high-signal failures
// to the UnifiedEvent log stream so the renderer/IM bus can surface them.
// Anything not matching here is reduced to an irreversible stderr summary by
// the process reader and is not promoted into the user-facing log stream.
//
// Adding patterns: prefer specific phrases over broad terms. A false-positive
// log line in the renderer is annoying; a false-negative just means the user
// sees the unified log instead — same baseline as today.

interface StderrPattern {
  /** Regex tested against the stripped stderr line. */
  re: RegExp;
  /** Mapped severity in the UnifiedEvent. */
  level: 'warn' | 'error';
  /** Human-readable summary prefix shown to the user. */
  prefix: string;
}

const CODEX_STDERR_PATTERNS: StderrPattern[] = [
  // App / MCP discovery transport — direct repro of issue #194.
  { re: /rmcp::transport::worker.*worker quit/i, level: 'error', prefix: 'Codex MCP transport failed' },
  { re: /error sending request for url \(([^)]+)\)/i, level: 'error', prefix: 'Codex HTTP request failed' },
  // App-server lifecycle.
  { re: /app-server process exited/i, level: 'error', prefix: 'Codex app-server exited' },
  // Auth failures — these break tool access silently otherwise.
  { re: /not (signed in|logged in|authenticated)|authentication required|please sign in/i, level: 'error', prefix: 'Codex authentication required' },
  { re: /(401|403)\b.*?(unauthor|forbid)/i, level: 'error', prefix: 'Codex authorization rejected' },
  // Network / proxy diagnostics.
  { re: /proxyconnect tcp: dial tcp 127\.[0-9.]+:\d+: connect: operation not permitted/i, level: 'error', prefix: 'Codex sandbox blocks MyAgents proxy' },
  { re: /(connection (refused|reset)|tls handshake|dns (failure|resolve))/i, level: 'error', prefix: 'Codex network error' },
];

export function classifyAndForwardCodexStderr(text: string, onEvent: UnifiedEventCallback): void {
  // Many stderr writes are multi-line. Process each line independently — one
  // matching line should fire one event, not block the rest of the chunk.
  for (const line of text.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    for (const p of CODEX_STDERR_PATTERNS) {
      const m = trimmed.match(p.re);
      if (!m) continue;
      onEvent({
        kind: 'log',
        level: p.level,
        message: `[codex] ${p.prefix} detail=${summarizeCodexValueForLog(trimmed)}`,
      });
      break; // first match wins per line
    }
  }
}

export function mapCodexTurnCompletedNotification(
  turnValue: unknown,
): Extract<UnifiedEvent, { kind: 'turn_complete' }> {
  const turn = objectValue(turnValue);
  const status = stringValue(turn.status) ?? 'completed';
  const error = objectValue(turn.error);
  const errorMessage = stringValue(error.message);

  return {
    kind: 'turn_complete',
    status,
    ...(errorMessage ? { error: errorMessage, result: errorMessage } : {}),
    ...(status !== 'completed' && !errorMessage ? { result: `Turn ended with status ${status}` } : {}),
  };
}

function codexLogProtocolToken(value: unknown): string {
  const token = stringValue(value);
  return token && /^[A-Za-z][A-Za-z0-9_./:-]{0,95}$/.test(token) ? token : 'unknown';
}

function summarizeCodexValueForLog(value: unknown): string {
  if (typeof value === 'string') {
    return JSON.stringify(summarizeSensitiveValueForLog(value));
  }
  try {
    return JSON.stringify(summarizeSensitiveValueForLog(JSON.stringify(value) ?? null));
  } catch {
    return JSON.stringify(summarizeSensitiveValueForLog(null));
  }
}

/**
 * Project one Codex notification into bounded semantic diagnostics.
 * Notification payloads can contain commands, file paths, tool arguments,
 * provider error bodies, and user messages, so sensitive values are never
 * retained as plaintext prefixes.
 */
export function summarizeCodexNotificationForLog(method: string, params: unknown): string {
  const p = objectValue(params);
  if (method === 'item/started' || method === 'item/completed') {
    const item = objectValue(p.item);
    if (Object.keys(item).length === 0) return '';
    const itemType = codexLogProtocolToken(item.type);
    let detail = ` type=${itemType}`;
    if (typeof item.id === 'string') detail += ` id=${summarizeCodexValueForLog(item.id)}`;
    if (typeof p.threadId === 'string') detail += ` thread=${summarizeCodexValueForLog(p.threadId)}`;
    if (itemType === 'commandExecution' && item.command != null) {
      detail += ` command=${summarizeCodexValueForLog(item.command)}`;
    }
    if (itemType === 'fileChange' && Array.isArray(item.changes)) {
      const paths = coerceFileChanges(item.changes).map((change) => change.path).filter(Boolean);
      detail += ` files=${paths.length}`;
      if (paths.length > 0) detail += ` paths=${summarizeCodexValueForLog(paths.join('\n'))}`;
    }
    if ((itemType === 'mcpToolCall' || itemType === 'dynamicToolCall') && item.tool != null) {
      detail += ` tool=${summarizeCodexValueForLog(item.tool)}`;
    }
    if (itemType === 'agentMessage' && typeof item.text === 'string') {
      detail += ` textChars=${Array.from(item.text).length}`;
    }
    if (itemType === 'userMessage') {
      const clientId = codexUserMessageClientId(item) ?? codexUserMessageClientId(p);
      if (clientId) detail += ` client=${summarizeCodexValueForLog(clientId)}`;
    }
    if (method === 'item/completed') {
      if (typeof item.exitCode === 'number' && Number.isFinite(item.exitCode)) {
        detail += ` exit=${item.exitCode}`;
      }
      const errorMessage = stringValue(objectValue(item.error).message);
      if (errorMessage) detail += ` error=${summarizeCodexValueForLog(errorMessage)}`;
    }
    return detail;
  }
  if (method === 'turn/completed') {
    const turn = objectValue(p.turn);
    let detail = Object.keys(turn).length > 0 ? ` status=${codexLogProtocolToken(turn.status)}` : '';
    const errorMessage = stringValue(objectValue(turn.error).message);
    if (errorMessage) detail += ` error=${summarizeCodexValueForLog(errorMessage)}`;
    return detail;
  }
  if (method === 'thread/tokenUsage/updated') {
    const usage = objectValue(objectValue(p.tokenUsage).total);
    const inputTokens = typeof usage.inputTokens === 'number' ? usage.inputTokens : 'unknown';
    const outputTokens = typeof usage.outputTokens === 'number' ? usage.outputTokens : 'unknown';
    return Object.keys(usage).length > 0 ? ` in=${inputTokens} out=${outputTokens}` : '';
  }
  if (method === 'thread/status/changed') {
    const status = objectValue(p.status);
    return Object.keys(status).length > 0 ? ` type=${codexLogProtocolToken(status.type)}` : '';
  }
  if (method === 'thread/started') {
    const threadId = stringValue(objectValue(p.thread).id);
    return threadId ? ` threadId=${summarizeCodexValueForLog(threadId)}` : '';
  }
  if (method === 'mcpServer/startupStatus/updated') {
    return ` name=${summarizeCodexValueForLog(p.name)} status=${codexLogProtocolToken(p.status)}`
      + (p.status === 'failed' ? ` code=${classifyMcpFailure(p.error, p.failureReason)}` : '');
  }
  return '';
}

function normalizeCodexPlanStatus(status: unknown): AgentPlanTodo['status'] {
  switch (status) {
    case 'completed':
      return 'completed';
    case 'inProgress':
    case 'in_progress':
      return 'in_progress';
    case 'pending':
    default:
      return 'pending';
  }
}

export function mapCodexTurnPlanUpdatedNotification(
  params: unknown,
): Extract<UnifiedEvent, { kind: 'agent_plan_update' }> {
  const p = objectValue(params);
  const todos = arrayValue(p.plan)
    .map((raw, idx): AgentPlanTodo | null => {
      const step = objectValue(raw);
      const content = stringValue(step.step)?.trim();
      if (!content) return null;
      return {
        key: `codex-plan-${idx}`,
        content,
        activeForm: content,
        status: normalizeCodexPlanStatus(step.status),
      };
    })
    .filter((todo): todo is AgentPlanTodo => todo !== null);

  return { kind: 'agent_plan_update', todos };
}

// ─── Diagnostic helpers (issue #194) ───

/**
 * Mask credentials in a proxy URL before exposing to the renderer.
 * `http://user:pass@proxy:7890` → `http://***@proxy:7890`. Falls back to the
 * raw string if parsing fails (better to render an opaque blob than to leak
 * partially-decoded credentials).
 */
function sanitizeProxyUrl(url: string | undefined): string | undefined {
  if (!url) return undefined;
  try {
    const u = new URL(url);
    if (u.username || u.password) {
      u.username = '***';
      u.password = '';
    }
    return u.toString();
  } catch {
    return url.includes('@') ? '[masked-proxy]' : url;
  }
}

/**
 * Build the sanitized effective-env snapshot for the diagnostic payload.
 * NEVER include secret values — only sanitized URLs and presence-only booleans
 * for sensitive vars. See `RuntimeEffectiveEnv` doc comment for the contract.
 */
function buildEffectiveEnvSnapshot(
  env: Record<string, string | undefined>,
  cwd: string,
  proxyPolicy: RuntimeProxyPolicy = 'myagents',
): RuntimeEffectiveEnv {
  const path = env.PATH || env.Path || '';
  const pathHead = path.split(process.platform === 'win32' ? ';' : ':')
    .filter(Boolean)
    .slice(0, 5);
  return {
    cwd,
    proxy: {
      http: sanitizeProxyUrl(env.HTTP_PROXY || env.http_proxy),
      https: sanitizeProxyUrl(env.HTTPS_PROXY || env.https_proxy),
      all: sanitizeProxyUrl(env.ALL_PROXY || env.all_proxy),
      no: env.NO_PROXY || env.no_proxy || undefined,
    },
    // Reflects the agent's runtimeConfig.envPolicy.proxy resolved at session
    // start (issue #194). 'myagents' = MyAgents-configured proxy is injected;
    // 'terminal' = inherited from user's interactive shell.
    proxyPolicy,
    pathHead,
    myagentsProxyInjected: env.MYAGENTS_PROXY_INJECTED === '1',
    hasOpenaiApiKey: !!(env.OPENAI_API_KEY && env.OPENAI_API_KEY.length > 0),
    hasAnthropicApiKey: !!(env.ANTHROPIC_API_KEY && env.ANTHROPIC_API_KEY.length > 0),
    hasCodexHome: !!(env.CODEX_HOME && env.CODEX_HOME.length > 0),
    hasXdgConfigHome: !!(env.XDG_CONFIG_HOME && env.XDG_CONFIG_HOME.length > 0),
  };
}

function parseLoopbackProxyTarget(env: Record<string, string | undefined>): { displayUrl: string; host: string; port: number } | null {
  const raw = env.HTTPS_PROXY || env.https_proxy || env.HTTP_PROXY || env.http_proxy || env.ALL_PROXY || env.all_proxy;
  if (!raw) return null;
  try {
    const u = new URL(raw);
    const host = u.hostname.replace(/^\[|\]$/g, '');
    const isLoopback = host === 'localhost'
      || host === '127.0.0.1'
      || host === '::1'
      || host.startsWith('127.');
    if (!isLoopback) return null;
    const port = Number(u.port || (u.protocol === 'https:' ? 443 : 80));
    if (!Number.isFinite(port) || port <= 0) return null;
    return {
      displayUrl: sanitizeProxyUrl(raw) ?? raw,
      host,
      port,
    };
  } catch {
    return null;
  }
}

async function probeCodexLoopbackProxy(
  rpc: JsonRpcClient,
  env: Record<string, string | undefined>,
  cwd: string,
  sandboxPolicy?: CodexSandboxPolicy,
): Promise<RuntimeEffectiveEnv['codexSandbox'] | undefined> {
  const target = parseLoopbackProxyTarget(env);
  if (!target) return undefined;
  const script = `
const net = require('node:net');
const host = process.argv[1];
const port = Number(process.argv[2]);
const result = {
  detected: !!process.env.CODEX_SANDBOX,
  networkDisabled: process.env.CODEX_SANDBOX_NETWORK_DISABLED === '1',
  proxyProbe: { url: process.argv[3], reachable: false }
};
const sock = net.connect({ host, port, timeout: 800 }, () => {
  result.proxyProbe.reachable = true;
  console.log(JSON.stringify(result));
  sock.destroy();
});
sock.on('timeout', () => {
  result.proxyProbe.error = 'timeout';
  console.log(JSON.stringify(result));
  sock.destroy();
});
sock.on('error', (err) => {
  result.proxyProbe.error = err && err.message ? err.message : String(err);
  console.log(JSON.stringify(result));
});
`;
  try {
    const result = await rpc.call('command/exec', {
      command: [process.execPath, '-e', script, target.host, String(target.port), target.displayUrl],
      cwd,
      timeoutMs: 3_000,
      outputBytesCap: 4_096,
      ...(sandboxPolicy ? { sandboxPolicy } : {}),
    }, 5_000) as { exitCode?: number; stdout?: string; stderr?: string };
    const lines = String(result.stdout ?? '').trim().split('\n').filter(Boolean);
    const parsed = lines.length > 0 ? JSON.parse(lines[lines.length - 1]!) as RuntimeEffectiveEnv['codexSandbox'] : undefined;
    return parsed ?? {
      detected: false,
      proxyProbe: {
        url: target.displayUrl,
        reachable: false,
        error: result.stderr || `probe exited ${result.exitCode ?? 'unknown'}`,
      },
    };
  } catch (err) {
    return {
      detected: false,
      proxyProbe: {
        url: target.displayUrl,
        reachable: false,
        error: err instanceof Error ? err.message : String(err),
      },
    };
  }
}

/**
 * Best-effort RPC fan-out: collect Codex's view of auth / features / MCP
 * servers / apps. Each call has its own 5s timeout and is captured as either
 * `'ok'`, `'unsupported'` (RPC `-32601` Method not found), or `{ error }`.
 *
 * Why parallel + Promise.allSettled: we never block the user's first turn on
 * diagnostics — the call site is fire-and-forget after thread/start has
 * already returned. Each RPC failure is independent and degrades gracefully.
 */
export function codexProxyProbeIssue(
  probe: RuntimeEffectiveEnv['codexSandbox'],
  policy?: CodexSandboxPolicy,
): RuntimeDiagnosticIssue | undefined {
  const proxy = probe?.proxyProbe;
  if (!proxy || proxy.reachable || (!probe.detected && !probe.networkDisabled)) return undefined;
  // command/exec does not request escalation. A blocked probe under the
  // expected network sandbox says nothing about an approved agent command.
  const restricted = (policy && 'networkAccess' in policy && !policy.networkAccess)
    || (!policy && probe.networkDisabled);
  return restricted ? {
    code: 'codex_proxy_requires_network_approval',
    severity: 'info',
    title: 'Codex network access requires approval',
    message: 'The unapproved proxy probe was blocked by the network sandbox. Agent commands can request network approval.',
  } : {
    code: 'codex_sandbox_blocks_myagents_proxy',
    severity: 'error',
    title: 'Codex sandbox blocks the MyAgents proxy',
    message: `Codex could not connect to loopback proxy ${proxy.url}: ${proxy.error ?? 'unreachable'}`,
    hint: 'Check the proxy connection and the effective Codex network policy.',
  };
}

async function collectCodexDiagnostics(
  rpc: JsonRpcClient,
  env: Record<string, string | undefined>,
  cwd: string,
  /**
   * Codex thread id for `app/list` feature gating. `null` for the standalone
   * (CLI-driven) path where no thread has been started — Codex's schema
   * declares this nullable. Earlier code passed `''`, which serde could reject.
   */
  threadId: string | null,
  proxyPolicy: RuntimeProxyPolicy = 'myagents',
  sandboxPolicy?: CodexSandboxPolicy,
  runtimeSource: import('../../shared/types/runtime').RuntimeSource = 'system-cli',
): Promise<RuntimeDiagnostics> {
  const status: RuntimeDiagnosticsStatus = {};
  const issues: RuntimeDiagnosticIssue[] = [];

  // Helper: returns ['ok', value] | ['unsupported'] | ['error', reason]
  type CallResult<T> = ['ok', T] | ['unsupported'] | ['error', string];
  const tryCall = async <T>(method: string, params: unknown): Promise<CallResult<T>> => {
    try {
      const v = await rpc.call(method, params, 5_000) as T;
      return ['ok', v];
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      // RPC -32601: Method not found → unsupported on this Codex version.
      // We don't want to flag old Codex as broken just because it lacks the
      // newer experimentalFeature/list — render 'unsupported' instead.
      if (/(-32601|Method not (found|supported))/i.test(msg)) return ['unsupported'];
      return ['error', msg.slice(0, 200)];
    }
  };

  // Fire all four in parallel — they're independent.
  const [authR, featuresR, mcpR, appsR] = await Promise.all([
    tryCall<{ authMethod: string | null; authToken?: string | null; requiresOpenaiAuth?: boolean | null }>(
      'getAuthStatus', {}),
    tryCall<{ data: Array<{ name: string; stage: string; enabled: boolean; defaultEnabled: boolean }> }>(
      'experimentalFeature/list', {}),
    tryCall<{ data: CodexMcpServerStatus[] }>(
      'mcpServerStatus/list', {}),
    tryCall<{ data: Array<{ id: string; name?: string; description?: string | null; isAccessible: boolean; isEnabled: boolean; installUrl?: string | null }> }>(
      'app/list', { threadId }),
  ]);

  // Process auth.
  //
  // `requiresOpenaiAuth` is a **meta** flag — it means "this Codex product needs
  // OpenAI-backed auth to work" (true for all current Codex builds backed by
  // ChatGPT/OpenAI). It is NOT a per-user state. A logged-in user with a
  // working ChatGPT account also sees `requiresOpenaiAuth: true`.
  // Live probe of a healthy logged-in user returns:
  //   { authMethod: "chatgpt", authToken: null, requiresOpenaiAuth: true }
  // The user-state signal is `authMethod`: null ⇒ no credential of any kind
  // (apikey / chatgpt / chatgptAuthTokens / agentIdentity), so the user must
  // sign in. Earlier code derived requiresLogin from `requiresOpenaiAuth`
  // alone, which flagged every authed Codex user as needing login — surfacing
  // a false-positive "需要登录 Codex" banner in MyAgents (cross-bugfix #1).
  let auth: RuntimeAuthStatus | undefined;
  if (authR[0] === 'ok') {
    status.auth = 'ok';
    const hasAuth = !!authR[1].authMethod;
    auth = {
      authMethod: authR[1].authMethod,
      // Treat the meta flag as a gate: even if `authMethod` is null, login is
      // only "required" when the Codex build actually needs OpenAI auth.
      // (Defensive — Codex could ship a build mode where neither is required.)
      requiresLogin: !hasAuth && authR[1].requiresOpenaiAuth === true,
    };
    if (auth.requiresLogin) {
      issues.push({
        code: 'codex_auth_required',
        severity: 'error',
        title: 'Codex requires login',
        message: 'Codex reported no active auth method for this runtime session.',
        hint: runtimeSource === 'managed-provider'
          ? 'Open Settings → Model Providers → Codex (订阅), then log in again.'
          : 'Run `codex login` in a terminal, then retry from MyAgents.',
      });
    }
  } else if (authR[0] === 'unsupported') {
    status.auth = 'unsupported';
  } else {
    status.auth = { error: authR[1] };
    issues.push({
      code: 'codex_auth_status_failed',
      severity: 'warn',
      title: 'Codex auth status failed',
      message: authR[1],
    });
  }

  // Process features — keep only enabled OR user-toggled (defaultEnabled !== enabled).
  // Renderer doesn't need 80 disabled-by-default entries; the actionable signal
  // is "what's actually on right now" + "what the user explicitly chose".
  let features: RuntimeFeatureFlag[] | undefined;
  if (featuresR[0] === 'ok') {
    status.features = 'ok';
    features = featuresR[1].data
      .filter(f => f.enabled || f.defaultEnabled !== f.enabled)
      .map(f => ({
        name: f.name,
        enabled: f.enabled,
        defaultEnabled: f.defaultEnabled,
        stage: f.stage,
      }));
  } else if (featuresR[0] === 'unsupported') {
    status.features = 'unsupported';
  } else {
    status.features = { error: featuresR[1] };
    issues.push({
      code: 'codex_feature_status_failed',
      severity: 'warn',
      title: 'Codex feature status failed',
      message: featuresR[1],
    });
  }

  // Process MCP servers
  let mcpServers: RuntimeMcpServerInfo[] | undefined;
  if (mcpR[0] === 'ok') {
    status.mcpServers = 'ok';
    mcpServers = mcpR[1].data.map(s => {
      // authStatus shape varies — render the stringified status when it's a
      // known marker, otherwise just flag whether MCP is auth'd.
      const authStatusStr = codexMcpAuthStatusText(s.authStatus);
      // Derive `state` from authStatus so the diagnostic banner has a single
      // field to filter on (its existing `state === 'failed'` check would
      // never fire if we only populated authStatus). Known unhealthy markers
      // — explicit failure plus auth-required states the user must act on —
      // surface as 'failed' so the banner highlights them.
      return {
        name: s.name,
        toolCount: Object.keys(s.tools ?? {}).length,
        resourceCount: s.resources?.length ?? 0,
        state: isCodexMcpAuthUnavailable(s.authStatus) ? 'failed' : undefined,
        authStatus: authStatusStr,
      };
    });
  } else if (mcpR[0] === 'unsupported') {
    status.mcpServers = 'unsupported';
  } else {
    status.mcpServers = { error: mcpR[1] };
    issues.push({
      code: 'codex_mcp_status_failed',
      severity: 'warn',
      title: 'Codex MCP status failed',
      message: mcpR[1],
    });
  }

  // Process apps — this is the artifact-tool diagnostic signal.
  let apps: RuntimeAppInfo[] | undefined;
  if (appsR[0] === 'ok') {
    status.apps = 'ok';
    apps = appsR[1].data.map(a => ({
      id: a.id,
      name: a.name,
      description: a.description ?? undefined,
      isAccessible: a.isAccessible,
      isEnabled: a.isEnabled,
      installUrl: a.installUrl ?? null,
    }));
  } else if (appsR[0] === 'unsupported') {
    status.apps = 'unsupported';
  } else {
    status.apps = { error: appsR[1] };
    issues.push({
      code: 'codex_app_status_failed',
      severity: 'warn',
      title: 'Codex app discovery failed',
      message: appsR[1],
    });
  }

  if (mcpServers) {
    const failed = mcpServers.filter((s) => s.state === 'failed');
    if (failed.length > 0) {
      issues.push({
        code: 'codex_mcp_server_failed',
        severity: 'warn',
        title: 'Codex MCP server failed',
        message: `Failed MCP server(s): ${failed.map((s) => s.name).join(', ')}`,
      });
    }
  }

  if (apps) {
    const inaccessible = apps.filter((app) => app.isEnabled && !app.isAccessible);
    if (inaccessible.length > 0) {
      issues.push({
        code: 'codex_app_not_accessible',
        severity: 'warn',
        title: 'Codex app inaccessible',
        message: `Enabled but inaccessible app(s): ${inaccessible.map((app) => app.id).join(', ')}`,
      });
    }
  }

  const effectiveEnv = buildEffectiveEnvSnapshot(env, cwd, proxyPolicy);
  const sandboxProbe = await probeCodexLoopbackProxy(rpc, env, cwd, sandboxPolicy);
  if (sandboxProbe) {
    effectiveEnv.codexSandbox = sandboxProbe;
    const issue = codexProxyProbeIssue(sandboxProbe, sandboxPolicy);
    if (issue) issues.push(issue);
  }

  return {
    runtime: 'codex',
    runtimeSource,
    effectiveEnv,
    auth,
    features,
    mcpServers,
    apps,
    status,
    issues: issues.length > 0 ? issues : undefined,
    timestamp: new Date().toISOString(),
  };
}

// ─── CodexRuntime ───

export class CodexRuntime implements AgentRuntime {
  readonly type: RuntimeType = 'codex';

  async detect(): Promise<RuntimeDetection> {
    try {
      const context = await resolveCodexCommandContext({ source: 'system-cli' });
      const command = context.commandPath;
      const proc = spawn([command, '--version'], {
        stdout: 'pipe',
        stderr: 'pipe',
        stdin: 'ignore',
        env: context.env,
      });
      const text = await new Response(proc.stdout).text();
      const code = await proc.exited;
      if (code === 0) {
        return {
          installed: true,
          version: text.trim().replace(/^codex-cli\s*/i, ''),
          path: command,
        };
      }
    } catch { /* not installed */ }
    return { installed: false };
  }

  async queryModels(options: { runtimeSource?: RuntimeSource; process?: RuntimeProcess } = {}): Promise<RuntimeModelInfo[]> {
    const runtimeSource = options.runtimeSource ?? 'system-cli';
    if (options.process && !options.process.exited) {
      const process = options.process as CodexProcess;
      try {
        const models = await readCodexModels(process.rpc);
        if (process.exited) throw new Error('Codex process exited during model discovery');
        process.models = models;
        return models;
      } catch (error) {
        if (!process.exited && process.models.length) return process.models;
        throw error;
      }
    }
    let context: CodexCommandContext;
    try {
      context = await resolveCodexCommandContext({ source: runtimeSource });
    } catch (err) {
      console.error(
        `[codex] Failed to resolve model runtime for source=${runtimeSource}:`,
        summarizeCodexErrorForLog(err),
      );
      return [];
    }
    const cacheKey = codexModelCacheKey(runtimeSource, context);
    // Return cached if fresh
    const cached = modelCache.get(cacheKey);
    if (cached && Date.now() - cached.timestamp < MODEL_CACHE_TTL_MS) {
      return cached.models;
    }

    try {
      const models = await this.queryModelsViaAppServer(runtimeSource, context);
      modelCache.set(cacheKey, { models, timestamp: Date.now() });
      return models;
    } catch (err) {
      console.error(
        `[codex] Failed to query models for source=${runtimeSource}:`,
        summarizeCodexErrorForLog(err),
      );
      // Return cached even if stale, or empty
      return cached?.models ?? [];
    }
  }

  private async queryModelsViaAppServer(
    runtimeSource: RuntimeSource,
    context: CodexCommandContext,
  ): Promise<RuntimeModelInfo[]> {
    // Spawn a temporary app-server to query model/list
    const codexEnv = context.env;
    const proc = spawn(buildCodexAppServerArgs({
      commandPath: context.commandPath,
      runtimeSource,
      codexEnv,
    }), {
      stdout: 'pipe',
      stderr: 'pipe',
      stdin: 'pipe',
      env: codexEnv,
    });

    const rpc = new JsonRpcClient(proc);
    // Start reader in background (awaited in finally block below)
    const readerDone = rpc.startReading();

    try {
      await initializeCodexRpc(rpc, 10_000);

      return await readCodexModels(rpc);
    } finally {
      rpc.destroy();
      try { proc.kill(); } catch { /* ignore */ }
      await readerDone.catch(() => {});
    }
  }

  getPermissionModes(): RuntimePermissionMode[] {
    return CODEX_PERMISSION_MODES;
  }

  getConfigCapabilities(): RuntimeConfigCapabilities {
    return {
      model: 'next_turn_state',
      permissionMode: 'next_turn_state',
      reasoningEffort: 'next_turn_state',
    };
  }

  /**
   * Standalone diagnostic run (issue #194 — used by `myagents diagnose runtime
   * codex`). Spawns a short-lived `codex app-server`, runs initialize, fans
   * out the four diagnostic RPCs, and tears down. Does NOT start a thread —
   * the three core RPCs (`getAuthStatus`, `experimentalFeature/list`,
   * `mcpServerStatus/list`) don't need one, and `app/list` accepts
   * `threadId: null`. This makes the command cheap (no agent.md scan, no
   * sandbox spawn for tools).
   *
   * Uses the SAME spawn env / envPolicy / cwd as a real session so the
   * snapshot reflects what production Codex would see. Pass `envPolicy` from
   * the same `agent.runtimeConfig.envPolicy` that the real session would
   * resolve — otherwise the diagnostic would silently report the legacy
   * `myagents` proxy view even when the agent is set to `terminal`/`direct`
   * (Codex review #3 catch).
   */
  async runStandaloneDiagnostics(
    workspacePath?: string,
    envPolicy?: import('../../shared/types/runtime').RuntimeEnvPolicy,
  ): Promise<RuntimeDiagnostics> {
    const context = await resolveCodexCommandContext({ source: 'system-cli', envPolicy });
    const env = context.env;
    const cwd = workspacePath || env.HOME || process.cwd();

    const proc = spawn([context.commandPath, 'app-server'], {
      stdout: 'pipe',
      stderr: 'pipe',
      stdin: 'pipe',
      cwd,
      env,
      // Same detached/windowsHide treatment as the real session spawn —
      // diverging here would mean the diagnostic env didn't match production.
      detached: process.platform !== 'win32',
      windowsHide: true,
    });

    // Drain stderr to /dev/null so a verbose Codex doesn't block the pipe.
    // Errors land in unified log via the standard sidecar capture; the
    // diagnostic report's `status` covers actionable failures.
    if (proc.stderr) {
      void (async () => {
        const reader = (proc.stderr as ReadableStream<Uint8Array>).getReader();
        try { while (true) { const { done } = await reader.read(); if (done) break; } }
        catch { /* ignore */ }
        finally { reader.releaseLock(); }
      })();
    }

    const rpc = new JsonRpcClient(proc);
    const readerDone = rpc.startReading();

    try {
      await initializeCodexRpc(rpc, 10_000);

      // No thread for the standalone path. `app/list` accepts `threadId: null`
      // per Codex's TS schema (AppsListParams.threadId is optional/nullable).
      // The other three RPCs don't take a threadId at all. Pass null explicitly
      // — earlier draft passed '' here which Codex's serde could reject as
      // "not a valid thread id" instead of treating it as absent (Codex
      // review #4 catch).
      return await collectCodexDiagnostics(
        rpc,
        env,
        cwd,
        null,
        envPolicy?.proxy ?? 'myagents',
        // Without a thread, let command/exec inherit the native configuration.
        undefined,
        'system-cli',
      );
    } finally {
      rpc.destroy();
      try { proc.kill(); } catch { /* ignore */ }
      await readerDone.catch(() => {});
    }
  }

  async startSession(
    options: SessionStartOptions,
    onEvent: UnifiedEventCallback,
  ): Promise<RuntimeProcess> {
    // Clean up stale temp images from previous sessions
    cleanupStaleTempImages();
    const runtimeSource = options.runtimeSource ?? 'system-cli';

    // Cross-runtime workspace protocol: make Codex natively discover CLAUDE.md
    // when no AGENTS.md is present. The -c flag overrides config.toml at runtime
    // without modifying any external config files. Codex's search order becomes:
    // AGENTS.override.md → AGENTS.md → CLAUDE.md (per directory, first found wins).
    // Capture the env we hand to Codex so the diagnostic snapshot reflects what
    // the subprocess actually saw (issue #194). The env policy is resolved by
    // the session caller from the agent's runtimeConfig.envPolicy.
    const context = await resolveCodexCommandContext({
      source: runtimeSource,
      envPolicy: options.envPolicy,
    });
    const codexEnv = context.env;
    // Issue #194 — pin PWD to workspacePath so any Codex-internal tool that
    // consults `$PWD` (vs. the kernel-level cwd Rust's spawn passes) sees the
    // workspace, not the sidecar's launch directory. Codex review SM finding.
    codexEnv.PWD = options.workspacePath;
    codexEnv.MYAGENTS_SESSION_ID = options.sessionId;
    const extensionSnapshot = runtimeSource === 'managed-provider'
      ? options.managedCodexExtensions
      : undefined;
    const extensionMaterialization = materializeManagedCodexExtensions(extensionSnapshot);
    let runtimeMcpServers = extensionSnapshot?.mcpServers ?? options.mcpServers;
    const usesManagedBrowserHost = runtimeSource === 'managed-provider'
      && runtimeMcpServers?.some(
        server => server.id === MANAGED_BROWSER_MCP_ID && server.command === '__browser_host__',
      ) === true;
    // One absolute dispatch budget starts when this Runtime generation accepts
    // its desired MCP set. Capability projection, admission queueing, process
    // initialization and native status observation all consume this same 10s.
    const mcpDispatchAcceptedAt = runtimeSource === 'managed-provider'
      && (runtimeMcpServers?.length ?? 0) > 0
      ? Date.now()
      : undefined;
    let browserHostGeneration: number | undefined;
    let browserCapabilityToken: string | undefined;
    let browserCapabilityInitiallyUnavailable = false;
    if (usesManagedBrowserHost) {
      try {
        // Browser ownership is Product-Session scoped. Codex's native thread
        // id is a runtime execution identity and must never be projected into
        // this domain. For a desktop Sidecar that is still keyed by pending-*,
        // external-session has already minted the future Product Session id in
        // options.sessionId, so project that owner before issuing the token.
        await adoptBrowserProductSession(options.sessionId);
        const capability = await acquireBrowserCapability();
        browserHostGeneration = capability.hostGeneration;
        browserCapabilityToken = capability.token;
        runtimeMcpServers = (runtimeMcpServers ?? []).map(server => (
          server.id === MANAGED_BROWSER_MCP_ID && server.command === '__browser_host__'
            ? {
                ...server,
                type: 'http' as const,
                command: undefined,
                args: undefined,
                url: capability.url,
                headers: { Authorization: `Bearer ${capability.token}` },
              }
            : server
        ));
        console.log(
          `[codex] MCP ${MANAGED_BROWSER_MCP_ID}: application Browser Host generation=${capability.hostGeneration}`,
        );
      } catch (error) {
        browserCapabilityInitiallyUnavailable = true;
        runtimeMcpServers = (runtimeMcpServers ?? []).filter(
          server => !(server.id === MANAGED_BROWSER_MCP_ID && server.command === '__browser_host__'),
        );
        console.warn(
          '[codex] Browser Host is temporarily unavailable; starting the base Runtime:',
          summarizeCodexErrorForLog(error),
        );
      }
    }
    const desiredRuntimeMcpServers = runtimeMcpServers ?? [];
    if (runtimeSource !== 'managed-provider') releaseManagedCodexMcpAdmission();
    const mcpAdmission = runtimeSource === 'managed-provider'
      ? await prepareManagedCodexMcpAdmission(
          desiredRuntimeMcpServers,
          options.initialTurn && options.scenario.type === 'desktop' ? 'interactive' : 'background',
          mcpDispatchAcceptedAt ?? Date.now(),
        )
      : { includeLocal: true, owner: null };
    const admissionQueuedServerNames = new Set(
      mcpAdmission.includeLocal ? [] : (mcpAdmission.owner?.serverIds ?? []),
    );
    if (!mcpAdmission.includeLocal) {
      runtimeMcpServers = desiredRuntimeMcpServers.filter(
        server => !(server.type === 'stdio' && server.command),
      );
      console.log(
        `[codex] MCP startup admission queued generation=${mcpAdmission.owner?.runtimeGeneration ?? 0}`
          + ` servers=${admissionQueuedServerNames.size}`,
      );
    }
    const launchConfig = buildCodexAppServerLaunchConfig({
      commandPath: context.commandPath,
      runtimeSource,
      codexEnv,
      mcpServers: runtimeMcpServers,
      extensionConfigArgs: extensionMaterialization.configArgs,
    });
    const mcpStartup = createCodexMcpStartupBarrier(launchConfig.mcpServerNames);
    console.log(
      `[codex] spawn source=${runtimeSource} version=${context.version ?? 'system-cli'} ` +
      `platform=${context.platform ?? process.platform} codexHome=${context.codexHome ? '<managed>' : '<default>'}`,
    );
    let proc: Subprocess;
    try {
      proc = spawn(launchConfig.args, {
        stdout: 'pipe',
        stderr: 'pipe',
        stdin: 'pipe',
        cwd: options.workspacePath,
        env: codexEnv,
      // Detached → child becomes its own process-group leader on POSIX so
      // killWithEscalation({ killTree: true }) below can take down the entire
      // model/tool tree, not just the wrapper.
      //
      // Windows: `detached: true` + stdio:'pipe' breaks parent's stdout reads
      // — the JSON-RPC `initialize` call hangs forever (issue #170 #3). Windows
      // doesn't have process groups; tree-kill uses `taskkill /F /T /PID` which
      // works regardless of detached. `windowsHide: true` suppresses the console
      // window flash from cmd.exe wrapping the codex.cmd shim.
        detached: process.platform !== 'win32',
        windowsHide: true,
      });
    } catch (error) {
      extensionMaterialization.cleanup();
      throw error;
    }

    let browserRecoveryTimer: ReturnType<typeof setTimeout> | null = null;
    const codexProc = new CodexProcess(proc);
    codexProc.extensionSnapshot = extensionSnapshot
      ? { ...extensionSnapshot, skills: extensionMaterialization.skills }
      : null;
    codexProc.cleanupExtensionResources = () => {
      if (browserRecoveryTimer) clearTimeout(browserRecoveryTimer);
      browserRecoveryTimer = null;
      extensionMaterialization.cleanup();
    };
    codexProc.sessionId = options.sessionId;
    codexProc.workspacePath = options.workspacePath;
    codexProc.scenario = options.scenario;
    codexProc.runtimeSource = runtimeSource;
    codexProc.version = context.version ?? '';

    // Dedup guard: prevent double session_complete from notification + process exit
    let sessionCompleteEmitted = false;
    // Pattern 6: every event delivery is wrapped in an ALS frame stamped
    // with `runtime: 'codex'` so any nested console.* (in onEvent or its
    // downstream handlers) is correlated. Frames are short-lived (one per
    // event) which keeps ALS overhead bounded.
    const wrappedOnEvent: UnifiedEventCallback = (event) => {
      if (event.kind === 'session_complete') {
        if (sessionCompleteEmitted) return; // Already emitted, skip duplicate
        sessionCompleteEmitted = true;
      }
      withLogContext({ runtime: 'codex', runtimeSource }, () => onEvent(event));
    };
    codexProc.rootEventHandler = wrappedOnEvent;
    if (admissionQueuedServerNames.size > 0 && mcpAdmission.owner) {
      const queuedOwner = mcpAdmission.owner;
      void queuedOwner.demand.ready.then(() => {
        if (
          managedCodexMcpAdmissionOwner === queuedOwner
          && (queuedOwner.state === 'granted' || queuedOwner.state === 'unmanaged')
          && !codexProc.exited
        ) {
          wrappedOnEvent({ kind: 'mcp_startup_admission_ready' });
        }
      });
    }

    const effectiveMcpServerNames = [...new Set([
      ...launchConfig.mcpServerNames,
      ...admissionQueuedServerNames,
      ...(usesManagedBrowserHost ? [MANAGED_BROWSER_MCP_ID] : []),
    ])].sort();
    const readyMcpServerNames = new Set<string>();
    const liveMcpStates = new Map<string, CodexMcpStartupState>(
      effectiveMcpServerNames.map(name => [name, 'starting']),
    );
    const observedMcpToolCounts = new Map<string, number>();
    const mcpFailureCodes = new Map<string, McpFailureCode>();
    const authBlockedMcpServerNames = new Set<string>();
    let lastMcpToolCatalog: string[] = [];
    let lastNativeMcpToolCatalog: string[] = [];
    const extensionToolCatalog = extensionSnapshot?.dynamicTools.map(tool => tool.name) ?? [];
    let mcpCatalogRevision = 0;
    let mcpDispatch: import('../../shared/mcpEffectiveState').McpEffectiveSnapshot['dispatch'] = {
      state: browserCapabilityInitiallyUnavailable
        ? 'released'
        : admissionQueuedServerNames.size > 0
        ? 'released'
        : launchConfig.mcpServerNames.length > 0 ? 'waiting' : 'settled',
      ...(browserCapabilityInitiallyUnavailable
        ? { releaseReason: 'status_read_failed' as const }
        : admissionQueuedServerNames.size > 0
        ? { releaseReason: 'timeout' as const }
        : launchConfig.mcpServerNames.length === 0 ? { releaseReason: 'ready' as const } : {}),
    };
    let mcpCatalogRefreshTimer: ReturnType<typeof setTimeout> | null = null;
    let browserHostRecovery: Promise<void> | null = null;
    let browserRecoveryAttempt = 0;
    const scheduleInitialBrowserHostRecovery = (): void => {
      if (!browserCapabilityInitiallyUnavailable || codexProc.exited || browserRecoveryTimer) return;
      const delays = [1_000, 2_000, 5_000, 10_000, 30_000] as const;
      const delay = delays[Math.min(browserRecoveryAttempt, delays.length - 1)];
      browserRecoveryAttempt += 1;
      browserRecoveryTimer = setTimeout(() => {
        browserRecoveryTimer = null;
        if (codexProc.exited) return;
        void adoptBrowserProductSession(options.sessionId)
          .then(() => acquireBrowserCapability())
          .then(capability => {
            if (codexProc.exited) return;
            browserHostGeneration = capability.hostGeneration;
            browserCapabilityToken = capability.token;
            browserCapabilityInitiallyUnavailable = false;
            wrappedOnEvent({
              kind: 'mcp_runtime_replacement_required',
              serverId: MANAGED_BROWSER_MCP_ID,
            });
          })
          .catch(() => scheduleInitialBrowserHostRecovery());
      }, delay);
      browserRecoveryTimer.unref?.();
    };
    const settleManagedAdmissionIfTerminal = (): void => {
      const owner = mcpAdmission.owner;
      if (!mcpAdmission.includeLocal || !owner?.lease || owner.state !== 'granted') return;
      if (!owner.serverIds.every(name => {
        const state = liveMcpStates.get(name);
        return state === 'ready' || state === 'failed';
      })) return;
      const ready = owner.serverIds.every(name => liveMcpStates.get(name) === 'ready');
      const lease = owner.lease;
      owner.lease = null;
      owner.state = 'settled';
      void settleMcpStartupLease(lease, ready ? 'ready' : 'failed');
    };
    const publishMcpEffective = (observationStale = false): void => {
      const now = Date.now();
      wrappedOnEvent({
        kind: 'mcp_effective_update',
        configGeneration: 1,
        configFingerprint: extensionSnapshot?.revision
          ?? effectiveMcpServerNames.join('|'),
        catalogGeneration: mcpCatalogRevision,
        ...(browserHostGeneration !== undefined ? { browserHostGeneration } : {}),
        dispatch: mcpDispatch,
        servers: effectiveMcpServerNames.map(name => {
          const liveState = liveMcpStates.get(name) ?? 'starting';
          const catalogObserved = observedMcpToolCounts.has(name);
          const state = admissionQueuedServerNames.has(name)
            ? 'queued' as const
            : authBlockedMcpServerNames.has(name)
              ? 'needs_auth' as const
            : liveState === 'ready'
            ? (catalogObserved ? 'ready' as const : 'starting' as const)
            : liveState === 'failed'
              ? 'failed' as const
              : 'starting' as const;
          return {
            id: name,
            desired: true,
            state,
            toolCount: state === 'ready' ? (observedMcpToolCounts.get(name) ?? 0) : 0,
            ...(state === 'failed' ? { errorCode: mcpFailureCodes.get(name) ?? 'MCP_STARTUP_FAILED' } : {}),
            attemptGeneration: 1,
            updatedAt: now,
          };
        }),
        tools: [...lastNativeMcpToolCatalog],
        ...(observationStale ? { observationStale: true } : {}),
      });
    };
    const publishMcpToolCatalog = (tools: string[]): void => {
      lastNativeMcpToolCatalog = [...new Set(tools)].sort();
      const combinedTools = [...new Set([...tools, ...extensionToolCatalog])].sort();
      if (
        combinedTools.length === lastMcpToolCatalog.length
        && combinedTools.every((tool, index) => tool === lastMcpToolCatalog[index])
      ) return;
      lastMcpToolCatalog = combinedTools;
      wrappedOnEvent({ kind: 'runtime_tool_catalog', tools: combinedTools });
    };
    const emitMcpToolCatalog = (servers: readonly CodexMcpServerStatus[]): void => {
      observedMcpToolCounts.clear();
      authBlockedMcpServerNames.clear();
      for (const server of servers) {
        if (isCodexMcpAuthUnavailable(server.authStatus)) {
          authBlockedMcpServerNames.add(server.name);
          continue;
        }
        if (!readyMcpServerNames.has(server.name)) continue;
        observedMcpToolCounts.set(server.name, Object.keys(server.tools ?? {}).length);
      }
      publishMcpToolCatalog(buildCodexMcpToolCatalog(servers, readyMcpServerNames));
      publishMcpEffective();
    };
    const scheduleMcpToolCatalogRefresh = (): void => {
      if (!codexProc.threadId || codexProc.exited || mcpCatalogRefreshTimer) return;
      // Startup notifications arrive in a burst. One short coalescing window
      // avoids redundant list calls while keeping discovery off the first-turn path.
      mcpCatalogRefreshTimer = setTimeout(() => {
        mcpCatalogRefreshTimer = null;
        if (codexProc.exited) return;
        const revision = mcpCatalogRevision;
        void listCodexMcpServerStatuses(codexProc.rpc, codexProc.threadId)
          .then((servers) => {
            if (codexProc.exited || revision !== mcpCatalogRevision) return;
            emitMcpToolCatalog(servers);
          })
          .catch((err) => {
            console.warn('[codex] MCP tool catalog refresh failed:', summarizeCodexErrorForLog(err));
            publishMcpEffective(true);
          });
      }, 100);
    };
    publishMcpEffective();

    // Wire up notification handler to emit UnifiedEvents
    codexProc.rpc.setNotificationHandler((method, params) => {
      if (method === 'mcpServer/startupStatus/updated') {
        const status = params as CodexMcpStartupStatusNotification;
        const belongsToActiveThread = status.threadId === null
          || !codexProc.threadId
          || status.threadId === codexProc.threadId;
        if (belongsToActiveThread) {
          mcpStartup.observe(status);
          liveMcpStates.set(status.name, status.status);
          if (status.status === 'failed') {
            mcpFailureCodes.set(status.name, classifyMcpFailure(status.error, status.failureReason));
          } else {
            mcpFailureCodes.delete(status.name);
          }
          if (status.status === 'ready') {
            readyMcpServerNames.add(status.name);
          } else {
            readyMcpServerNames.delete(status.name);
            observedMcpToolCounts.delete(status.name);
            authBlockedMcpServerNames.delete(status.name);
            const prefix = `mcp__${status.name}__`;
            publishMcpToolCatalog(lastNativeMcpToolCatalog.filter(tool => !tool.startsWith(prefix)));
          }
          if (
            usesManagedBrowserHost
            && status.name === MANAGED_BROWSER_MCP_ID
            && status.status === 'failed'
            && !browserHostRecovery
          ) {
            browserHostRecovery = acquireBrowserCapability()
              .then(capability => {
                if (
                  (capability.hostGeneration === browserHostGeneration
                    && capability.token === browserCapabilityToken)
                  || codexProc.exited
                ) return;
                console.warn(
                  `[codex] Browser Host transport credential changed generation=${browserHostGeneration ?? 0}->${capability.hostGeneration}; restarting MCP transport`,
                );
                wrappedOnEvent({
                  kind: 'mcp_runtime_replacement_required',
                  serverId: MANAGED_BROWSER_MCP_ID,
                });
              })
              .catch(error => {
                console.warn(
                  '[codex] Browser Host recovery deferred:',
                  summarizeCodexErrorForLog(error),
                );
              })
              .finally(() => {
                browserHostRecovery = null;
              });
          }
          mcpCatalogRevision += 1;
          settleManagedAdmissionIfTerminal();
          publishMcpEffective();
          scheduleMcpToolCatalogRefresh();
        }
      }
      // Skip noisy notifications from logging: deltas, legacy duplicates, account events
      const isNoisy = method.startsWith('codex/event/') || method.startsWith('account/')
        || method === 'item/agentMessage/delta' || method === 'item/reasoning/summaryTextDelta'
        || method === 'item/commandExecution/outputDelta' || method === 'item/fileChange/outputDelta'
        || method === 'rawResponse/completed';
      if (!isNoisy) {
        const detail = summarizeCodexNotificationForLog(method, params);
        withLogContext({ runtime: 'codex', runtimeSource }, () => {
          console.log(`[codex] ${codexLogProtocolToken(method)}${detail}`);
        });
      }
      const notifParams = params as Record<string, unknown> | undefined;
      const itemThreadId = stringValue(notifParams?.threadId);
      const isItemNotification = method.startsWith('item/');
      // Async attachment completions must cross the same owner boundary as the
      // synchronous item that scheduled them. Capture this notification's
      // thread identity instead of bypassing sub-agent routing.
      const emitFromNotification: UnifiedEventCallback = isItemNotification
        ? (event) => dispatchCodexItemEvent(codexProc, itemThreadId, event, wrappedOnEvent)
        : wrappedOnEvent;
      const result = this.parseNotification(codexProc, method, params, emitFromNotification);
      if (result) {
        // parseNotification may return one event or an array (e.g., tool_use_stop + tool_result)
        const events = Array.isArray(result) ? result : [result];
        for (const event of events) emitFromNotification(event);
      }
      // A spawn/activity parsed above may have completed an ancestor chain.
      // Emit the parent card first, then release causally-earlier child events.
      if (isItemNotification && codexProc.deferredSubAgentEvents.size > 0) {
        flushResolvableCodexSubAgentEvents(codexProc, wrappedOnEvent);
      }
      for (const event of collectCodexSubAgentLifecycleEvents(codexProc)) {
        wrappedOnEvent(event);
      }
      // If a child settled before its parent activity arrived, the held root
      // may become releasable only after the activity and its buffered child
      // events have crossed the stream. Keep the terminal last.
      const readyMainTerminal = this.takeReadyPendingMainTurn(codexProc);
      if (readyMainTerminal) {
        for (const event of readyMainTerminal) wrappedOnEvent(event);
      }
    });

    // Wire up server-request handler for approval requests
    codexProc.rpc.setServerRequestHandler((id, method, params) => {
      this.handleServerRequest(codexProc, id, method, params, wrappedOnEvent);
    });

    // Start background reader (runs for lifetime of session)
    codexProc.rpc.startReading();

    // Track process exit — emit session_complete if not already emitted by protocol.
    // Skipped when the startup catch-handler killed the process itself (e.g. stale
    // `thread/resume`): the caller's error surface already names the real cause,
    // and emitting a synthetic "exited with code 143" here would layer a noisy
    // SIGTERM echo on top. See issue #105.
    proc.exited.then((code) => {
      codexProc.exited = true;
      this.rejectCompactControl(
        codexProc,
        new Error(`Codex process exited during context compaction with code ${code}`),
      );
      codexProc.disposeExtensionResources(`Codex process exited with code ${code}`);
      if (mcpCatalogRefreshTimer) {
        clearTimeout(mcpCatalogRefreshTimer);
        mcpCatalogRefreshTimer = null;
      }
      mcpStartup.fail(new Error(`Codex process exited during MCP startup with code ${code}`));
      for (const name of launchConfig.mcpServerNames) {
        liveMcpStates.set(name, 'failed');
        mcpFailureCodes.set(name, 'MCP_RUNTIME_EXITED');
      }
      readyMcpServerNames.clear();
      observedMcpToolCounts.clear();
      authBlockedMcpServerNames.clear();
      lastNativeMcpToolCatalog = [];
      mcpCatalogRevision += 1;
      settleManagedAdmissionIfTerminal();
      publishMcpEffective();
      if (codexProc.intentionalKillDuringStartup) return;
      const heldEvents = this.takeHeldMainTurnForProcessExit(codexProc);
      if (heldEvents) {
        for (const event of heldEvents) wrappedOnEvent(event);
      }
      wrappedOnEvent({
        kind: 'session_complete',
        result: code === 0 ? '' : `Codex process exited with code ${code}`,
        subtype: code === 0 ? 'success' : 'error',
      });
    });

    // Read stderr in background.
    //
    // Two concerns:
    //   1. Verbose unified-log capture (console.error) — every line, for triage.
    //   2. Issue #194 — classify a small set of "user-actionable" error patterns
    //      and re-emit them as UnifiedEvent log entries so the renderer/IM bus
    //      gets a one-line summary instead of the user having to grep
    //      unified-log. Pattern set is small + conservative — we only forward
    //      lines that name an actual failure mode, not Codex's noisy info
    //      messages.
    if (proc.stderr) {
      (async () => {
        const reader = (proc.stderr as ReadableStream<Uint8Array>).getReader();
        const decoder = new TextDecoder();
        try {
          while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            const raw = decoder.decode(value, { stream: true }).trim();
            if (!raw) continue;
            const text = stripAnsi(raw);
            withLogContext({ runtime: 'codex', runtimeSource }, () => {
              console.error(`[codex-stderr] ${summarizeCodexValueForLog(text)}`);
            });
            classifyAndForwardCodexStderr(text, wrappedOnEvent);
          }
        } catch { /* ignore */ } finally {
          reader.releaseLock();
        }
      })();
    }

    try {
      // 1. Initialize handshake
      // Managed runtime is pinned to a schema that supports the experimental
      // raw response-item stream on new threads. It restores semantic
      // information that typed v2 subAgentActivity omits. Resume has no raw-
      // events request field, and System CLI may be older, so both retain the
      // stable handshake surface.
      const enableManagedRawEvents = runtimeSource === 'managed-provider'
        && !options.resumeSessionId;
      await initializeCodexRpc(codexProc.rpc, 15_000, enableManagedRawEvents);
      const skillProjection = await configureCodexSkillExtraRoots(
        codexProc.rpc,
        options.workspacePath,
        CODEX_SKILL_EXTRA_ROOTS_SET_TIMEOUT_MS,
        extensionSnapshot ? extensionMaterialization.skillRoots : undefined,
        extensionSnapshot ? extensionMaterialization.skills : [],
        CODEX_SKILL_LIST_TIMEOUT_MS,
      );
      codexProc.loadedSkillNames = skillProjection.loadedSkillNames;
      if (runtimeSource === 'managed-provider') {
        try { codexProc.models = await readCodexModels(codexProc.rpc); }
        catch (error) { console.warn('[codex] Model capabilities unavailable:', summarizeCodexErrorForLog(error)); }
      }

      // 2. Determine permission mode
      const isHeadlessAutomation =
        options.scenario.type === 'im'
        || options.scenario.type === 'agent-channel'
        || options.scenario.type === 'cron'
        || options.scenario.type === 'registeredAgent';
      const defaultPermissionMode = isHeadlessAutomation ? 'no-restrictions' : 'full-auto';
      const permMode = options.permissionMode || defaultPermissionMode;
      const { approval, sandbox, reviewer } = mapPermissionMode(permMode, runtimeSource);
      codexProc.workspacePolicy = codexWorkspacePolicyFromConfig(
        await codexProc.rpc.call('config/read', { cwd: options.workspacePath, includeLayers: false }, 10_000) as Parameters<typeof codexWorkspacePolicyFromConfig>[0],
      );
      codexProc.approvalsReviewer = reviewer;
      const threadModelProvider = resolveCodexThreadModelProvider(
        launchConfig.modelProvider,
        options.resumeSessionId,
        options.model,
      );
      codexProc.defaultPermissionMode = defaultPermissionMode;
      codexProc.permissionMode = permMode;
      codexProc.approvalPolicy = approval;
      codexProc.sandbox = sandbox;
      codexProc.model = options.model || '';
      codexProc.reasoningEffort = options.reasoningEffort || '';

      // 3. Start or resume thread. The MCP window begins at this native
      // startup boundary, not at process spawn/initialize.
      if (launchConfig.mcpServerNames.length > 0) {
        mcpStartup.arm(mcpAdmission.owner?.startedAt ?? mcpDispatchAcceptedAt);
        publishMcpEffective();
      }
      if (options.resumeSessionId) {
        // Resume existing thread
        const resumeParams = {
          threadId: options.resumeSessionId,
          cwd: options.workspacePath,
          model: options.model || null,
          ...(threadModelProvider ? { modelProvider: threadModelProvider } : {}),
          approvalPolicy: approval,
          approvalsReviewer: reviewer,
          sandbox,
          developerInstructions: options.systemPromptAppend || null,
        };
        console.log(`[codex] RPC thread/resume: ${JSON.stringify(summarizeCodexThreadParamsForLog(resumeParams))}`);
        const result = await codexProc.rpc.call('thread/resume', resumeParams, 30_000) as CodexThreadPermissionResult;
        adoptCodexThreadPermissions(codexProc, result);
        codexProc.threadId = result.thread.id;
        if (!codexProc.model && result.model) codexProc.model = result.model;

        // Emit synthetic session_init — thread/resume doesn't trigger notifications
        // but external-session needs it for session ID sync and frontend needs
        // chat:system-init for model/tools info after Sidecar restart
        onEvent({
          kind: 'session_init',
          sessionId: result.thread.id,
          model: options.model || '',
          tools: [],
        });
        publishMcpToolCatalog([]);
        scheduleMcpToolCatalogRefresh();
      } else {
        // New thread
        const startParams = {
          cwd: options.workspacePath,
          model: options.model || null,
          ...(threadModelProvider ? { modelProvider: threadModelProvider } : {}),
          approvalPolicy: approval,
          approvalsReviewer: reviewer,
          sandbox,
          developerInstructions: options.systemPromptAppend || null,
          ephemeral: options.ephemeral ?? false,
          ...(extensionSnapshot?.dynamicTools.length
            ? { dynamicTools: extensionSnapshot.dynamicTools }
            : {}),
          ...(enableManagedRawEvents ? { experimentalRawEvents: true } : {}),
        };
        console.log(`[codex] RPC thread/start: ${JSON.stringify(summarizeCodexThreadParamsForLog(startParams))}`);
        const result = await codexProc.rpc.call('thread/start', startParams, 30_000) as CodexThreadPermissionResult;
        adoptCodexThreadPermissions(codexProc, result);
        codexProc.threadId = result.thread.id;
        if (!codexProc.model && result.model) codexProc.model = result.model;

        // Emit session_init so external-session.ts captures threadId
        onEvent({
          kind: 'session_init',
          sessionId: result.thread.id,
          model: result.model || '',
          tools: [],
        });
        publishMcpToolCatalog([]);
        scheduleMcpToolCatalogRefresh();
      }

      // MyAgents owns a 10s dispatch grace; Codex's native attempt remains
      // alive under its independent 60s bound so a late-ready server can be
      // observed and used without replaying this turn.
      if (launchConfig.mcpServerNames.length > 0) {
        const startup = await mcpStartup.wait();
        if (admissionQueuedServerNames.size === 0) {
          mcpDispatch = startup.outcome === 'ready'
            ? { state: 'settled', releaseReason: 'ready' }
            : { state: 'released', releaseReason: startup.reason ?? 'timeout' };
        }
        publishMcpEffective();
        const serverStates = launchConfig.mcpServerNames.map(name => (
          `${name}:${startup.states[name] ?? 'pending'}`
        ));
        console.log(
          `[codex] MCP dispatch outcome=${startup.outcome}`
          + `${startup.reason ? ` releaseReason=${startup.reason}` : ''}`
          + ` elapsedMs=${startup.elapsedMs} budgetMs=${MCP_PREWARM_GRACE_MS}`
          + ` servers=[${serverStates.join(',')}]`,
        );
      }
      if (codexProc.exited) {
        throw new Error('Codex process exited before startup completed');
      }

      // 4. Send initial turn if provided
      if (options.initialTurn) {
        const clientUserMessageId = options.initialTurn.clientUserMessageId;
        if (!clientUserMessageId) {
          throw new Error('Codex initial root turn is missing clientUserMessageId');
        }
        this.beginRootTurnAdmission(codexProc, clientUserMessageId);
        const input = buildCodexInput(options.initialTurn.message, options.initialTurn.images);
        const turnResult = await codexProc.rpc.call('turn/start', buildCodexTurnStartParams({
          threadId: codexProc.threadId,
          input,
          cwd: options.workspacePath,
          approvalPolicy: approval,
          approvalsReviewer: reviewer,
          sandbox,
          workspacePolicy: codexProc.workspacePolicy,
          model: options.model || null,
          reasoningEffort: codexProc.runtimeSource === 'managed-provider'
            ? resolveManagedCodexEffort(codexProc.models, codexProc.model, codexProc.reasoningEffort)
            : codexProc.reasoningEffort || null,
          clientUserMessageId,
        }), 15_000) as { turn: { id: string } };
        this.completeRootTurnAdmission(codexProc, turnResult.turn.id, wrappedOnEvent);
      }

      // 5. Fire-and-forget diagnostic fan-out (issue #194). Never block startup
      // or the user's first turn — even if all four RPCs hang they only
      // surface a missing diagnostic strip, not a failed session. Failures are
      // captured into the diagnostic `status` per-call.
      void (async () => {
        try {
          const diagnostics = await collectCodexDiagnostics(
            codexProc.rpc,
            codexEnv,
            options.workspacePath,
            codexProc.threadId,
            options.envPolicy?.proxy ?? 'myagents',
            buildCodexSandboxPolicy(sandbox, options.workspacePath, codexProc.workspacePolicy),
            runtimeSource,
          );
          // Session-life gate: tab close / runtime teardown can race against
          // the 5–10s diagnostic fan-out. Without this guard, a diagnostic
          // resolving after the user switched tabs would broadcast into the
          // already-torn-down session — TabProvider's setRuntimeDiagnostics(null)
          // on session switch protects the NEXT session, but the stale event
          // can still flash into the switched-away tab if SSE flushes faster
          // than React commit.
          if (codexProc.exited || codexProc.intentionalKillDuringStartup) {
            return;
          }
          wrappedOnEvent({ kind: 'runtime_diagnostics', diagnostics });
        } catch (err) {
          // collectCodexDiagnostics already degrades per-call; reaching here
          // means an unexpected error in the helper itself.
          console.warn('[codex] collectDiagnostics failed:', summarizeCodexErrorForLog(err));
        }
      })();
      scheduleInitialBrowserHostRecovery();
    } catch (err) {
      // Clean up on startup failure.
      if (mcpCatalogRefreshTimer) {
        clearTimeout(mcpCatalogRefreshTimer);
        mcpCatalogRefreshTimer = null;
      }
      // Flag must be set BEFORE proc.kill so proc.exited.then observes it.
      codexProc.intentionalKillDuringStartup = true;
      codexProc.disposeExtensionResources('Codex startup failed');
      try { proc.kill(); } catch { /* ignore */ }
      codexProc.exited = true;

      // Detect the specific "rollout was dropped" failure so the caller can
      // invalidate the stale threadId and retry fresh instead of looping on a
      // dead pointer forever. Codex worded this slightly differently across
      // CLI versions (observed on v0.122.0-alpha.1) — match loosely.
      const msg = err instanceof Error ? err.message : String(err);
      if (options.resumeSessionId && /no rollout found|thread not found|conversation not found/i.test(msg)) {
        throw new StaleRuntimeSessionError(options.resumeSessionId, msg);
      }
      throw err;
    }

    return codexProc;
  }

  async sendMessage(
    process: RuntimeProcess,
    message: string,
    images?: ResolvedImagePayload[],
    options?: { clientUserMessageId?: string },
  ): Promise<void> {
    const codexProc = process as CodexProcess;
    if (codexProc.exited) throw new Error('Codex process has exited');
    const clientUserMessageId = options?.clientUserMessageId;
    if (!clientUserMessageId) throw new Error('Codex root turn is missing clientUserMessageId');

    this.beginRootTurnAdmission(codexProc, clientUserMessageId);
    const input = buildCodexInput(message, images);
    try {
      const turnResult = await codexProc.rpc.call('turn/start', buildCodexTurnStartParams({
        threadId: codexProc.threadId,
        input,
        cwd: codexProc.workspacePath,
        approvalPolicy: codexProc.approvalPolicy,
        approvalsReviewer: codexProc.approvalsReviewer,
        sandbox: codexProc.sandbox,
        workspacePolicy: codexProc.workspacePolicy,
        model: codexProc.model || null,
        reasoningEffort: codexProc.runtimeSource === 'managed-provider'
            ? resolveManagedCodexEffort(codexProc.models, codexProc.model, codexProc.reasoningEffort)
            : codexProc.reasoningEffort || null,
        clientUserMessageId,
      }), 15_000) as { turn: { id: string } };
      this.completeRootTurnAdmission(codexProc, turnResult.turn.id, (event) => {
        withLogContext({ runtime: 'codex', runtimeSource: codexProc.runtimeSource }, () => {
          const handler = codexProc.rootEventHandler;
          if (handler) handler(event);
        });
      });
    } catch (error) {
      codexProc.activeRootTurnAdmission = null;
      throw error;
    }
  }

  /**
   * Managed Codex exposes compaction as a native control turn. Keep that turn
   * out of the UnifiedEvent transcript and wait for its authoritative
   * turn/completed terminal before resolving the Session operation.
   */
  async compactContext(process: RuntimeProcess): Promise<void> {
    const codexProc = process as CodexProcess;
    if (codexProc.exited) throw new Error('Codex process has exited');
    if (codexProc.runtimeSource !== 'managed-provider') {
      throw new Error('Native context compaction is only available for Managed Codex');
    }
    if (!codexProc.threadId) throw new Error('Managed Codex has no active thread to compact');
    if (codexProc.compactControl || codexProc.activeRootTurnAdmission) {
      throw new Error('Managed Codex is already running a Session operation');
    }

    let resolveTerminal!: () => void;
    let rejectTerminal!: (error: Error) => void;
    const terminal = new Promise<void>((resolve, reject) => {
      resolveTerminal = resolve;
      rejectTerminal = reject;
    });
    // Process-exit or protocol notifications may reject before rpc.call()
    // settles. Attach a handler immediately so Node never observes a transient
    // unhandled rejection; the awaited promise below still carries the error.
    void terminal.catch(() => undefined);
    const control: CodexCompactControl = {
      turnId: '',
      restartRequired: false,
      resolve: resolveTerminal,
      reject: rejectTerminal,
    };
    codexProc.compactControl = control;

    const timeout = setTimeout(() => {
      if (codexProc.compactControl === control) {
        control.reject(new Error('Managed Codex context compaction timed out'));
      }
    }, CODEX_COMPACT_TIMEOUT_MS);

    try {
      await codexProc.rpc.call('thread/compact/start', {
        threadId: codexProc.threadId,
      }, 15_000);
      await terminal;
    } catch (error) {
      // If the terminal handler already cleared ownership, the protocol gave
      // us a definitive failed terminal and the process remains reusable. An
      // RPC/timeout failure while we still own the control turn is ambiguous,
      // so restart the process boundary before another user turn can enter.
      if (codexProc.compactControl === control || control.restartRequired) {
        if (codexProc.compactControl === control) codexProc.compactControl = null;
        await this.stopSession(codexProc);
      }
      throw error;
    } finally {
      clearTimeout(timeout);
    }
  }

  async branchConversation(
    process: RuntimeProcess,
    boundary: ConversationBranchBoundary,
  ): Promise<ConversationBranchResult> {
    const codexProc = process as CodexProcess;
    if (codexProc.exited) {
      throw new RuntimeConversationBranchError('native_fork_failed', 'Codex process has exited');
    }
    const version = codexProc.runtimeSource === 'managed-provider'
      ? codexProc.version
      : (await this.detect()).version;
    if (!supportsCodexConversationBranch(codexProc.runtimeSource, version)) {
      throw new RuntimeConversationBranchError('capability_unavailable', 'Codex must be updated to support conversation branching');
    }

    let branchBoundary = boundary;
    if (boundary.kind === 'before-turn') {
      let readResult: { thread?: { id?: string; turns?: unknown } };
      try {
        readResult = await codexProc.rpc.call('thread/read', {
          threadId: codexProc.threadId,
          includeTurns: true,
        }, 15_000) as { thread?: { id?: string; turns?: unknown } };
      } catch (error) {
        throw new RuntimeConversationBranchError(
          codexConversationRpcFailureCode(error, 'anchor_unavailable'),
          'Unable to read the Codex turn history',
        );
      }
      if (readResult.thread?.id !== codexProc.threadId) {
        throw new RuntimeConversationBranchError('anchor_unavailable', 'Codex returned a different thread');
      }
      const resolved = resolveCodexConversationBranchPoint(readResult.thread.turns, boundary.runtimeTurnId);
      if (resolved.kind === 'fresh-thread') return resolved;
      branchBoundary = resolved;
    }

    let replacementId: string;
    try {
      const result = await codexProc.rpc.call('thread/fork', {
        threadId: codexProc.threadId,
        lastTurnId: branchBoundary.runtimeTurnId,
      }, 15_000) as { thread?: { id?: string } };
      replacementId = result.thread?.id ?? '';
      if (!replacementId || replacementId === codexProc.threadId) {
        throw new Error('Codex returned an invalid forked thread id');
      }
    } catch (error) {
      if (error instanceof RuntimeConversationBranchError) throw error;
      const code = codexConversationRpcFailureCode(error, 'native_fork_failed');
      throw new RuntimeConversationBranchError(code, 'Codex could not create the conversation branch');
    }

    // Unsubscribe only removes event delivery. Current app-server versions
    // retain the loaded fork (and its native writer) for an inactivity grace
    // period, so another Session process cannot resume it yet. Retire this
    // exact process before publishing the replacement identity. The source
    // keeps its threadId and resumes through the existing lifecycle on send.
    await this.stopSession(codexProc);
    if (!codexProc.exited) {
      throw new RuntimeConversationBranchError('unsubscribe_failed', 'Codex branch writer could not be released');
    }
    return { kind: 'native-thread', runtimeSessionId: replacementId };
  }

  async steerMessage(
    process: RuntimeProcess,
    message: string,
    images?: ResolvedImagePayload[],
    options?: { clientUserMessageId?: string },
  ): Promise<void> {
    const codexProc = process as CodexProcess;
    if (codexProc.exited) throw new Error('Codex process has exited');
    const activeTurnId = codexProc.activeSteerTurnId;
    if (!activeTurnId) {
      throw new RuntimeSteerUnavailableError('Codex has no active turn to steer');
    }

    const input = buildCodexInput(message, images);
    let result: { turnId?: string };
    try {
      result = await codexProc.rpc.call('turn/steer', buildCodexTurnSteerParams({
        threadId: codexProc.threadId,
        input,
        expectedTurnId: activeTurnId,
        clientUserMessageId: options?.clientUserMessageId,
      }), 15_000) as { turnId?: string };
    } catch (error) {
      if (isCodexNoActiveTurnSteerRejection(error)) {
        if (codexProc.activeSteerTurnId === activeTurnId) {
          codexProc.activeSteerTurnId = '';
        }
        throw new RuntimeSteerUnavailableError(error.message);
      }
      throw error;
    }
    if (result.turnId && result.turnId !== activeTurnId) {
      codexProc.currentTurnId = result.turnId;
      codexProc.activeSteerTurnId = result.turnId;
    }
  }

  canSteerMessage(process: RuntimeProcess): boolean {
    const codexProc = process as CodexProcess;
    return !codexProc.exited && Boolean(codexProc.activeSteerTurnId);
  }

  /**
   * Codex carries model on every turn/start. Updating process state at the
   * session layer's turn boundary is enough; the active turn has already
   * received its turn/start payload and is not affected.
   */
  async setModel(process: RuntimeProcess, model: string | undefined): Promise<void> {
    const codexProc = process as CodexProcess;
    if (codexProc.exited) throw new Error('Codex process has exited');
    codexProc.model = model ?? '';
  }

  /**
   * Codex permission mode is also a turn/start payload. Keep the original
   * human-readable mode for diagnostics and update the derived approval/sandbox
   * pair used by the next sendMessage().
   */
  async setPermissionMode(process: RuntimeProcess, mode: string | undefined): Promise<void> {
    const codexProc = process as CodexProcess;
    if (codexProc.exited) throw new Error('Codex process has exited');
    const nextMode = mode || codexProc.defaultPermissionMode;
    const { approval, sandbox, reviewer } = mapPermissionMode(nextMode, codexProc.runtimeSource);
    if (reviewer === 'auto_review' && !codexProc.supportsApprovalsReviewer) {
      throw new Error('This Codex CLI does not support Approve for me. Update Codex or select Ask for approval / Full Access.');
    }
    codexProc.approvalsReviewer = reviewer;
    codexProc.permissionMode = nextMode;
    codexProc.approvalPolicy = approval;
    codexProc.sandbox = sandbox;
  }

  /**
   * #324 — in-place reasoning-effort switch. turn/start.effort overrides
   * "this turn and subsequent turns", so recording the value on process
   * state is sufficient: the next sendMessage carries it. No RPC needed.
   */
  async setReasoningEffort(process: RuntimeProcess, effort: string | undefined): Promise<void> {
    const codexProc = process as CodexProcess;
    if (codexProc.exited) throw new Error('Codex process has exited');
    codexProc.reasoningEffort = effort ?? '';
  }

  /**
   * Interrupt the current turn WITHOUT closing stdin (process stays alive). The app-server
   * emits `turn/completed` (non-failed status) → unified `turn_complete` → the session goes
   * idle, so the queued message can run next. If the root terminal is already held for active
   * children, interrupt those exact child turns instead. Used by force-send.
   */
  async interruptTurn(process: RuntimeProcess): Promise<void> {
    const codexProc = process as CodexProcess;
    if (codexProc.exited) return;
    if (codexProc.pendingMainTurnCompletion) {
      await this.interruptActiveSubAgentTurns(codexProc);
      return;
    }
    if (!codexProc.activeSteerTurnId) return;
    await codexProc.rpc.call('turn/interrupt', {
      threadId: codexProc.threadId,
      turnId: codexProc.activeSteerTurnId,
    }, 3_000).catch(() => { /* turn may already be ending; the turn/completed event drives idle */ });
  }

  private clearTurnLocalSubAgentState(codexProc: CodexProcess): void {
    if (codexProc.deferredSubAgentEvents.size > 0) {
      const eventCount = [...codexProc.deferredSubAgentEvents.values()]
        .reduce((sum, events) => sum + events.length, 0);
      console.warn(
        `[codex] Discarding ${eventCount} uncorrelated foreign-thread item events at turn completion`,
      );
      codexProc.deferredSubAgentEvents.clear();
    }
    codexProc.subThreadToCard.clear();
    codexProc.subThreadToParent.clear();
    codexProc.subThreadMeta.clear();
    codexProc.collabControlToolParents.clear();
    codexProc.activeSubAgentTurns.clear();
    codexProc.completedSubAgentTurnsBeforeActivity.clear();
    codexProc.subAgentThreadsAwaitingActivity.clear();
    codexProc.subAgentActivitySeenBeforeTurnStart.clear();
    codexProc.subAgentLifecycleByThread.clear();
    codexProc.emittedSubAgentLifecycleByCard.clear();
    codexProc.openedReasoningTracesByItem.clear();
    codexProc.codexV2InteractionDeliveryByCallId.clear();
    codexProc.exactUsageByTurn.clear();
    codexProc.subAgentInterruptsInFlight.clear();
    codexProc.pendingMainTurnCompletion = null;
    codexProc.interruptPendingSubAgentTurns = false;
    codexProc.releaseHeldMainTurnOnExit = false;
  }

  private beginRootTurnAdmission(codexProc: CodexProcess, clientUserMessageId: string): void {
    if (codexProc.activeRootTurnAdmission) {
      throw new Error('Codex root turn admission already exists');
    }
    codexProc.activeRootTurnAdmission = { clientUserMessageId };
  }

  private completeRootTurnAdmission(
    codexProc: CodexProcess,
    runtimeTurnId: string,
    emit: UnifiedEventCallback,
  ): void {
    const admission = codexProc.activeRootTurnAdmission;
    if (!admission) throw new Error('Codex root turn response has no admission owner');
    if (admission.notificationTurnId && admission.notificationTurnId !== runtimeTurnId) {
      void this.stopSession(codexProc);
      throw new Error('Codex root turn id mismatch between response and notification');
    }
    admission.responseTurnId = runtimeTurnId;
    codexProc.currentTurnId = runtimeTurnId;
    if (!admission.nativeTerminalObserved) {
      codexProc.activeSteerTurnId = runtimeTurnId;
    }
    const admissionEvent = {
      runtimeTurnId,
      clientUserMessageId: admission.clientUserMessageId,
    };
    emit({ kind: 'root_turn_admitted', ...admissionEvent });
    if (admission.deferredTerminalEvents) {
      const terminalEvents = admission.deferredTerminalEvents;
      codexProc.activeRootTurnAdmission = null;
      for (const event of terminalEvents) emit(event);
    }
  }

  private observeRootTurnId(codexProc: CodexProcess, runtimeTurnId: string): boolean {
    const admission = codexProc.activeRootTurnAdmission;
    if (!admission) return true;
    if (
      (admission.notificationTurnId && admission.notificationTurnId !== runtimeTurnId)
      || (admission.responseTurnId && admission.responseTurnId !== runtimeTurnId)
    ) {
      codexProc.activeRootTurnAdmission = null;
      void this.stopSession(codexProc);
      return false;
    }
    admission.notificationTurnId = runtimeTurnId;
    return true;
  }

  private completeMainTurn(codexProc: CodexProcess, events: UnifiedEvent[]): UnifiedEvent[] {
    const lifecycleEvents = collectCodexSubAgentLifecycleEvents(codexProc);
    const terminalEvents = [...lifecycleEvents, ...events];
    this.clearTurnLocalSubAgentState(codexProc);
    const admission = codexProc.activeRootTurnAdmission;
    if (admission && !admission.responseTurnId) {
      admission.deferredTerminalEvents = terminalEvents;
      return [];
    }
    codexProc.activeRootTurnAdmission = null;
    return terminalEvents;
  }

  /**
   * If a root terminal arrives while child correlation is unresolved, the
   * process itself is the only exact isolation boundary. This covers both a
   * missing v2 activity and resumed/older schemas that merge queue-only
   * send_message with turn-triggering followup_task. Release the real root
   * terminal on exit, then let the existing resume path create a clean runtime.
   */
  private restartAfterUnresolvedSubAgentCorrelation(
    codexProc: CodexProcess,
    events: UnifiedEvent[],
  ): void {
    codexProc.pendingMainTurnCompletion = events;
    codexProc.releaseHeldMainTurnOnExit = true;
    console.warn('[codex] Restarting runtime after unresolved sub-agent correlation at root terminal');
    void this.stopSession(codexProc);
  }

  private takeReadyPendingMainTurn(codexProc: CodexProcess): UnifiedEvent[] | null {
    if (
      codexProc.releaseHeldMainTurnOnExit
      || !codexProc.pendingMainTurnCompletion
      || codexProc.activeSubAgentTurns.size > 0
    ) return null;
    return this.completeMainTurn(codexProc, codexProc.pendingMainTurnCompletion);
  }

  private takeHeldMainTurnForProcessExit(codexProc: CodexProcess): UnifiedEvent[] | null {
    if (!codexProc.releaseHeldMainTurnOnExit || !codexProc.pendingMainTurnCompletion) {
      return null;
    }
    return this.completeMainTurn(codexProc, codexProc.pendingMainTurnCompletion);
  }

  private interruptSubAgentTurn(
    codexProc: CodexProcess,
    threadId: string,
    turnId: string,
  ): Promise<void> {
    const key = `${threadId}\u0000${turnId}`;
    const existing = codexProc.subAgentInterruptsInFlight.get(key);
    if (existing) return existing;

    const interrupt = (async (): Promise<void> => {
      try {
        await codexProc.rpc.call('turn/interrupt', { threadId, turnId }, 3_000);
      } catch (err) {
        // The child may have settled while the RPC was in flight. Only a still-
        // owned child under a still-held root warrants the process fallback.
        if (
          codexProc.exited
          || !codexProc.pendingMainTurnCompletion
          || codexProc.activeSubAgentTurns.get(threadId) !== turnId
          || codexProc.releaseHeldMainTurnOnExit
        ) return;
        console.warn(
          `[codex] Child turn interrupt failed thread=${JSON.stringify(summarizeSensitiveValueForLog(threadId))}; restarting runtime to preserve the held root boundary: ${summarizeCodexErrorForLog(err)}`,
        );
        codexProc.releaseHeldMainTurnOnExit = true;
        await this.stopSession(codexProc);
      } finally {
        codexProc.subAgentInterruptsInFlight.delete(key);
      }
    })();
    codexProc.subAgentInterruptsInFlight.set(key, interrupt);
    return interrupt;
  }

  private async interruptActiveSubAgentTurns(codexProc: CodexProcess): Promise<void> {
    codexProc.interruptPendingSubAgentTurns = true;
    await Promise.all([...codexProc.activeSubAgentTurns.entries()].map(([threadId, turnId]) => {
      if (!turnId) return;
      return this.interruptSubAgentTurn(codexProc, threadId, turnId);
    }));
  }

  async respondPermission(
    process: RuntimeProcess,
    requestId: string,
    decision: 'deny' | 'allow_once' | 'always_allow',
    _reason?: string,
    _suggestions?: unknown[],
    updatedInput?: Record<string, unknown>,
    interrupt?: boolean,
  ): Promise<void> {
    const codexProc = process as CodexProcess;
    if (codexProc.exited) return;

    const pending = codexProc.pendingRequests.get(requestId);
    if (!pending) {
      console.error('[codex] Unknown approval requestId:', requestId);
      return;
    }
    codexProc.pendingRequests.delete(requestId);

    if (pending.kind === 'host_tool_approval') {
      if (decision === 'deny') {
        codexProc.abortPendingHostCall(
          pending.callId,
          _reason || 'User denied the Managed Codex Host tool request.',
        );
      } else {
        this.dispatchManagedCodexHostToolCall(codexProc, pending.callId);
      }
      return;
    }

    const action = serializeCodexPermissionResponse(pending, decision, updatedInput, interrupt);
    if (action.type === 'error') {
      codexProc.rpc.respondError(pending.rpcId, action.code, action.message);
      return;
    }
    codexProc.rpc.respond(pending.rpcId, action.result);
  }

  async stopSession(process: RuntimeProcess): Promise<void> {
    const codexProc = process as CodexProcess;
    if (codexProc.exited) return;
    this.rejectCompactControl(codexProc, new Error('Managed Codex context compaction was interrupted'));
    codexProc.abortPendingHostCalls('Managed Codex Host tool call interrupted because the Session stopped');

    try {
      // 1. Interrupt current turn if any
      if (codexProc.currentTurnId) {
        await codexProc.rpc.call('turn/interrupt', {
          threadId: codexProc.threadId,
          turnId: codexProc.currentTurnId,
        }, 3_000).catch(() => {});
      }
      // 2. Close stdin — signals app-server to shut down (like CC's closeStdin)
      await codexProc.closeStdin();
    } catch { /* ignore */ }

    try {
      await killWithEscalation(codexProc, {
        gracefulMs: 3_000,
        hardMs: 2_000,
        killTree: true,
        onStep: (step, info) => {
          if (step === 'orphan') {
            console.warn(`[codex] Process pid=${info.pid} did not exit after SIGKILL; continuing with orphan risk`);
          }
        },
      });
    } catch { /* ignore */ } finally {
      codexProc.pendingRequests.clear();
      codexProc.disposeExtensionResources('Managed Codex Session stopped');
      codexProc.rpc.destroy();
    }
  }

  // ─── Notification parsing (v2 typed notifications) ───

  /**
   * Schedule an async tool attachment save and broadcast a `tool_attachment_update`
   * UnifiedEvent when it resolves. Returns a placeholder attachment to embed in
   * the synchronous `tool_result` emit. PRD 0.2.15 §4.7.1.
   */
  private scheduleAttachmentSave(
    source: AttachmentSource,
    ctx: SaveContext,
    asyncEmit: UnifiedEventCallback,
  ): ToolAttachment {
    const { attachment, pendingId } = makePlaceholderAttachment(ctx);
    // Wrap in a tracked promise so `persistTurnResult` can await all in-flight
    // saves before snapshotting currentContentBlocks. The first await yields,
    // so the synchronous tool_result emit lands before this fulfills the
    // placeholder. Codex review SM1.
    const tracked = (async (): Promise<void> => {
      try {
        const real = await saveToolAttachment(source, ctx);
        asyncEmit({
          kind: 'tool_attachment_update',
          toolUseId: ctx.toolUseId,
          pendingId,
          attachment: real,
        });
      } catch (err) {
        // Verbose detail to server log; safe enum code travels over SSE.
        console.warn(
          `[codex] saveToolAttachment failed (toolUseId=${JSON.stringify(summarizeSensitiveValueForLog(ctx.toolUseId))}): ${summarizeCodexErrorForLog(err)}`,
        );
        asyncEmit({
          kind: 'tool_attachment_update',
          toolUseId: ctx.toolUseId,
          pendingId,
          attachment: makeErrorAttachment(ctx, err, pendingId),
        });
      }
    })();
    trackInFlightSave(tracked);
    return attachment;
  }

  private rejectCompactControl(codexProc: CodexProcess, error: Error): void {
    const control = codexProc.compactControl;
    if (!control) return;
    codexProc.compactControl = null;
    if (!control.turnId || codexProc.currentTurnId === control.turnId) {
      codexProc.currentTurnId = '';
    }
    control.reject(error);
  }

  /**
   * Consume the native compact turn before ordinary root-turn parsing can
   * create transcript events. Context usage notifications remain visible so
   * the ring refreshes as soon as Codex reports the post-compact window.
   */
  private handleCompactControlNotification(
    codexProc: CodexProcess,
    method: string,
    p: Record<string, unknown>,
  ): boolean {
    const control = codexProc.compactControl;
    if (!control) return false;
    const threadId = stringValue(p.threadId);
    if (threadId && codexProc.threadId && threadId !== codexProc.threadId) return false;

    if (method === 'turn/started') {
      const turnId = stringValue(p.turnId) ?? stringValue(objectValue(p.turn).id);
      if (!turnId) {
        control.restartRequired = true;
        this.rejectCompactControl(codexProc, new Error('Managed Codex compact turn has no id'));
        return true;
      }
      if (control.turnId && control.turnId !== turnId) {
        control.restartRequired = true;
        this.rejectCompactControl(codexProc, new Error('Managed Codex compact turn id changed unexpectedly'));
        return true;
      }
      control.turnId = turnId;
      codexProc.currentTurnId = turnId;
      return true;
    }

    if (method === 'turn/completed') {
      const turn = objectValue(p.turn);
      const turnId = stringValue(turn.id) ?? stringValue(p.turnId) ?? control.turnId;
      if (control.turnId && turnId && control.turnId !== turnId) {
        control.restartRequired = true;
        this.rejectCompactControl(codexProc, new Error('Managed Codex compact terminal does not match its turn'));
        return true;
      }
      control.turnId = turnId ?? control.turnId;
      takeCodexExactTurnUsage(codexProc.exactUsageByTurn, control.turnId);
      codexProc.compactControl = null;
      if (!control.turnId || codexProc.currentTurnId === control.turnId) {
        codexProc.currentTurnId = '';
      }
      const status = stringValue(turn.status) ?? 'completed';
      if (status === 'completed') {
        control.resolve();
      } else {
        const message = stringValue(objectValue(turn.error).message)
          ?? `Managed Codex context compaction ended with status ${status}`;
        control.reject(new Error(message));
      }
      return true;
    }

    if (method === 'thread/compacted') return true;
    if (method === 'thread/tokenUsage/updated') return false;

    // Compaction is not a conversational turn. Fail closed for any root-turn
    // content emitted by a future app-server schema while keeping unrelated
    // session/account/MCP notifications flowing normally.
    return method.startsWith('item/')
      || method.startsWith('command/')
      || method.startsWith('process/')
      || method.startsWith('rawResponse')
      || method === 'turn/diff/updated'
      || method === 'turn/plan/updated';
  }

  private parseNotification(
    codexProc: CodexProcess,
    method: string,
    params: unknown,
    asyncEmit: UnifiedEventCallback,
  ): UnifiedEvent | UnifiedEvent[] | null {
    const p = params as Record<string, unknown>;

    // PRD 0.2.27 — sub-agent threads run their OWN turns/lifecycle multiplexed
    // over this connection (verified live: a spawned child emits its own
    // turn/started + turn/completed with isMain=false, plus thread lifecycle).
    // Those MUST NOT drive the MAIN MyAgents session: a child's turn/completed
    // would otherwise finalize the user's turn early and resetTurnAccumulators()
    // mid-fan-out — wiping currentContentBlocks (the spawn card + its nested
    // calls) and breaking both turn integrity and the nesting itself.
    // PRD 0.2.32 — thread/tokenUsage/updated is gated here for the same reason:
    // a child's usage would otherwise become a `usage` event and pollute the
    // MAIN context indicator + persisted lastContextUsage (cross-review codex HIGH).
    // Child ITEM notifications (the tools we nest) are intentionally NOT gated here.
    if (isChildThreadGatedMethod(method)) {
      const evtThreadId = stringValue(p.threadId);
      if (evtThreadId && codexProc.threadId && evtThreadId !== codexProc.threadId) {
        if (method === 'turn/started') {
          observeCodexSubAgentTurnStarted(codexProc, evtThreadId, Date.now());
          const childTurnId = stringValue(p.turnId)
            ?? stringValue(objectValue(p.turn).id);
          const activityAlreadyArrived = (
            codexProc.activeSubAgentTurns.has(evtThreadId)
            && codexProc.activeSubAgentTurns.get(evtThreadId) === null
          ) || codexProc.subAgentActivitySeenBeforeTurnStart.delete(evtThreadId);
          codexProc.completedSubAgentTurnsBeforeActivity.delete(evtThreadId);
          codexProc.activeSubAgentTurns.set(evtThreadId, childTurnId ?? null);
          if (!activityAlreadyArrived && codexProc.codexV2SubAgentActivityObserved) {
            codexProc.subAgentThreadsAwaitingActivity.add(evtThreadId);
          }
          if (codexProc.interruptPendingSubAgentTurns && childTurnId) {
            void this.interruptSubAgentTurn(codexProc, evtThreadId, childTurnId);
          }
        } else if (
          method === 'turn/completed'
          || method === 'thread/closed'
          || (
            method === 'thread/status/changed'
            && objectValue(p.status).type === 'systemError'
          )
        ) {
          const terminalStatus = method === 'turn/completed'
            ? mapCodexChildTurnTerminalStatus(p.turn)
            : 'failed';
          observeCodexSubAgentTurnTerminal(codexProc, evtThreadId, terminalStatus, Date.now());
          codexProc.activeSubAgentTurns.delete(evtThreadId);
          if (
            codexProc.subAgentThreadsAwaitingActivity.has(evtThreadId)
            || !codexProc.subThreadToCard.has(evtThreadId)
          ) {
            codexProc.completedSubAgentTurnsBeforeActivity.add(evtThreadId);
          }
          return this.takeReadyPendingMainTurn(codexProc);
        }
        return null; // child lifecycle informs ownership but never drives it directly
      }
    }

    if (this.handleCompactControlNotification(codexProc, method, p)) return null;

    switch (method) {
      // ── Thread lifecycle ──
      case 'thread/started': {
        // Thread started — no UnifiedEvent needed (session_init already emitted).
        // SIDE EFFECT (best-effort): if a spawned sub-agent thread ever emits
        // thread/started here, record its parent link + nickname/role for richer
        // labels + depth>1 chains. NOTE: Codex 0.135.0 does NOT emit child
        // thread/started on the app-server connection (verified live) — so this
        // is not an authoritative link by itself. Legacy spawnAgent receivers
        // and v2 subAgentActivity items below own card correlation; this source
        // remains useful for ancestry and optional labels.
        const sub = parseSubAgentThreadSource(p.thread);
        const childId = stringValue(objectValue(p.thread).id);
        if (sub && childId) {
          codexProc.subThreadToParent.set(childId, sub.parentThreadId);
          if (sub.nickname || sub.role) {
            codexProc.subThreadMeta.set(childId, { nickname: sub.nickname, role: sub.role });
          }
        }
        return null;
      }

      case 'thread/status/changed': {
        const status = p.status as { type: string } | undefined;
        if (!status) return null;
        // Thread status describes the persistent Codex thread, not the user
        // turn. Resume can report `idle` after the turn owner accepted a query;
        // only the external turn lifecycle may drive running/idle.
        if (status.type === 'systemError') return { kind: 'status_change', state: 'error' };
        return null;
      }

      case 'thread/closed':
        return { kind: 'session_complete', result: '', subtype: 'success' };

      // ── Turn lifecycle ──
      case 'turn/started': {
        codexProc.completedSubAgentTurnsBeforeActivity.clear();
        codexProc.pendingMainTurnCompletion = null;
        const turnId = stringValue(p.turnId)
          ?? stringValue(objectValue(p.turn).id);
        if (turnId) {
          if (!this.observeRootTurnId(codexProc, turnId)) {
            return {
              kind: 'turn_complete',
              status: 'failed',
              error: 'Codex root turn id changed unexpectedly',
            };
          }
          codexProc.currentTurnId = turnId;
          codexProc.activeSteerTurnId = turnId;
        }
        return [
          { kind: 'turn_started' },
          { kind: 'status_change', state: 'running' },
          { kind: 'agent_plan_update', todos: [] },
        ];
      }

      case 'turn/completed': {
        const turn = p.turn;
        const completedTurnId = stringValue(objectValue(turn).id)
          ?? stringValue(p.turnId)
          ?? codexProc.currentTurnId;
        if (completedTurnId) {
          codexProc.abortPendingHostCalls?.(
            'Managed Codex Host tool call expired at the turn boundary',
            completedTurnId,
          );
        }
        if (completedTurnId && !this.observeRootTurnId(codexProc, completedTurnId)) {
          return {
            kind: 'turn_complete',
            status: 'failed',
            error: 'Codex root turn id changed unexpectedly',
          };
        }
        if (codexProc.activeRootTurnAdmission) {
          codexProc.activeRootTurnAdmission.nativeTerminalObserved = true;
        }
        if (completedTurnId && codexProc.activeSteerTurnId === completedTurnId) {
          codexProc.activeSteerTurnId = '';
        }
        const exactUsage = takeCodexExactTurnUsage(codexProc.exactUsageByTurn, completedTurnId);
        const events: UnifiedEvent[] = [
          ...(exactUsage ? [{
            kind: 'usage' as const,
            inputTokens: exactUsage.inputTokens,
            outputTokens: exactUsage.outputTokens,
            cacheReadTokens: exactUsage.cacheReadTokens || undefined,
            cacheCreationTokens: exactUsage.cacheCreationTokens || undefined,
            semantics: 'delta' as const,
          }] : []),
          mapCodexTurnCompletedNotification(turn),
          { kind: 'agent_plan_update', todos: [] },
        ];
        const status = stringValue(objectValue(turn).status);
        if (
          codexProc.subAgentThreadsAwaitingActivity.size > 0
          || codexProc.subAgentActivitySeenBeforeTurnStart.size > 0
        ) {
          this.restartAfterUnresolvedSubAgentCorrelation(codexProc, events);
          return null;
        }
        if (
          codexProc.activeSubAgentTurns.size > 0
        ) {
          codexProc.pendingMainTurnCompletion = events;
          if (status !== 'completed') {
            void this.interruptActiveSubAgentTurns(codexProc);
          }
          return null;
        }
        return this.completeMainTurn(codexProc, events);
      }

      // Managed Codex 0.144.1 raw protocol item. The typed terminal activity
      // intentionally omits whether `interacted` came from send_message or
      // followup_task; retain only that one semantic bit, keyed by the shared
      // call id, and keep the rest of the raw model payload out of MyAgents.
      case 'rawResponseItem/completed': {
        const item = objectValue(p.item);
        if (item.type !== 'function_call') return null;
        const callId = stringValue(item.call_id);
        const name = stringValue(item.name);
        if (!callId || !name) return null;
        if (
          name === 'spawn_agent'
          || name === 'send_message'
          || name === 'followup_task'
          || name === 'interrupt_agent'
        ) {
          codexProc.codexV2SubAgentActivityObserved = true;
        }
        if (name === 'send_message') {
          codexProc.codexV2InteractionDeliveryByCallId.set(callId, 'queue-only');
        } else if (name === 'followup_task') {
          codexProc.codexV2InteractionDeliveryByCallId.set(callId, 'trigger-turn');
        }
        return null;
      }

      // Codex 0.146 exact provider usage for one Responses API completion.
      // Keep the raw payload inside the adapter; the root terminal emits one
      // deduplicated turn delta through the existing UnifiedEvent usage owner.
      case 'rawResponse/completed':
        recordCodexExactResponseUsage(codexProc.exactUsageByTurn, p);
        return null;

      // ── Text streaming ──
      case 'item/agentMessage/delta': {
        const itemId = (p.itemId as string) || '';
        const text = (p.delta as string) || '';
        if (itemId && text) {
          codexProc.agentMessageTextById.set(itemId, (codexProc.agentMessageTextById.get(itemId) || '') + text);
        }
        return { kind: 'text_delta', text, traceId: codexTraceId(p, itemId) };
      }

      // ── Reasoning streaming ──
      case 'item/reasoning/summaryTextDelta':
        return buildCodexReasoningDeltaEvents(codexProc, p, {
          text: (p.delta as string) || '',
          index: (p.summaryIndex as number) || 0,
          suffix: `summary:${(p.summaryIndex as number) || 0}`,
        });

      case 'item/reasoning/textDelta':
        // Raw reasoning content — also map to thinking for display
        return buildCodexReasoningDeltaEvents(codexProc, p, {
          text: (p.delta as string) || '',
          index: (p.contentIndex as number) || 0,
          suffix: `content:${(p.contentIndex as number) || 0}`,
        });

      // ── Plan streaming ──
      case 'item/plan/delta':
        // Map plan to thinking display
        return {
          kind: 'thinking_delta',
          text: (p.delta as string) || '',
          index: 0,
          traceId: codexTraceId(p, undefined, 'plan'),
        };

      // ── Tool/item lifecycle ──
      // Tool name mapping: Codex item types → existing frontend badge names
      // (Bash, Edit, Grep, Read, Write, WebFetch, Glob, etc.)
      case 'item/started': {
        const item = p.item as {
          type: string; id: string;
          command?: string; cwd?: string; tool?: string; server?: string;
          text?: string; query?: string; arguments?: unknown;
          path?: string; revisedPrompt?: string; mcpAppResourceUri?: string;
          changes?: Array<{ path: string }>;
          commandActions?: unknown[];
          source?: string; namespace?: string | null;
          senderThreadId?: string; receiverThreadIds?: string[]; prompt?: string; model?: string; status?: string;
          clientUserMessageId?: string; client_user_message_id?: string; clientId?: string; client_id?: string;
        } | undefined;
        if (!item) return null;
        switch (item.type) {
          case 'commandExecution': {
            return {
              kind: 'tool_use_start',
              toolUseId: item.id,
              toolName: 'Bash',
              input: {
                command: item.command ?? '',
                ...(item.cwd ? { cwd: item.cwd } : {}),
                ...(item.source ? { source: item.source } : {}),
                ...(Array.isArray(item.commandActions) ? { commandActions: item.commandActions } : {}),
              },
            };
          }
          case 'fileChange': {
            return {
              kind: 'tool_use_start',
              toolUseId: item.id,
              toolName: 'Edit',
              input: buildCodexStartedFileChangeInput(item.changes, item.cwd),
            };
          }
          case 'mcpToolCall': {
            // Prefix with mcp__ to match frontend MCP tool badge patterns
            const toolName = item.server && item.tool ? `mcp__${item.server}__${item.tool}` : (item.tool || 'MCP Tool');
            const baseInput: Record<string, unknown> = (item.arguments && typeof item.arguments === 'object')
              ? { ...(item.arguments as Record<string, unknown>) }
              : {};
            if (item.mcpAppResourceUri) baseInput.mcpAppResourceUri = item.mcpAppResourceUri;
            return {
              kind: 'tool_use_start',
              toolUseId: item.id,
              toolName,
              input: Object.keys(baseInput).length > 0 ? baseInput : undefined,
            };
          }
          case 'dynamicToolCall': {
            const baseInput: Record<string, unknown> = (item.arguments && typeof item.arguments === 'object')
              ? { ...(item.arguments as Record<string, unknown>) }
              : {};
            if (item.namespace) baseInput.namespace = item.namespace;
            return {
              kind: 'tool_use_start',
              toolUseId: item.id,
              toolName: item.tool || 'Tool',
              input: Object.keys(baseInput).length > 0 ? baseInput : undefined,
            };
          }
          case 'collabAgentToolCall': {
            // PRD 0.2.15 — surface collab agent invocation as a tool card.
            // PRD 0.2.27 — record the spawn card↔child-thread link so the child's
            // tools nest under THIS card. receiverThreadIds is often empty at
            // started; item/completed is authoritative. Only `spawnAgent` creates
            // the relationship (wait/closeAgent/sendInput reference existing ones).
            recordLegacySpawnAgentLifecycle(codexProc, item);
            const controlParents = resolveCollabAgentControlParents(
              item.tool,
              item.receiverThreadIds,
              codexProc.subThreadToCard,
              codexProc.subThreadToParent,
            );
            if (controlParents.length > 0) {
              codexProc.collabControlToolParents.set(item.id, controlParents);
              return buildCollabAgentControlStartEvents(item, controlParents);
            }
            if (item.tool && item.tool !== 'spawnAgent') {
              // Defer unresolved control actions until item/completed. Completion
              // can either resolve and nest them, or emit one complete flat card
              // when Codex never reports receiverThreadIds.
              return null;
            }
            return {
              kind: 'tool_use_start',
              toolUseId: item.id,
              toolName: 'CollabAgent',
              input: buildCollabAgentInput(item),
            };
          }
          case 'subAgentActivity':
            // v2 emits a started notification before the terminal activity
            // item that carries the correlation payload. The completed side is
            // authoritative; this is an intentional no-op, not an unknown item.
            return null;
          case 'plan':
            // PRD 0.2.15 — `plan` items stream via item/plan/delta as thinking_delta.
            // We need a thinking_start so the frontend opens a thinking block.
            return { kind: 'thinking_start', index: 0, traceId: codexTraceId(p, item.id, 'plan') };
          case 'webSearch': {
            return {
              kind: 'tool_use_start',
              toolUseId: item.id,
              toolName: 'WebSearch',
              input: { query: item.query ?? '' },
            };
          }
          case 'imageView': {
            return {
              kind: 'tool_use_start',
              toolUseId: item.id,
              toolName: 'Read',
              input: item.path ? { file_path: item.path } : undefined,
            };
          }
          case 'imageGeneration':
            return { kind: 'tool_use_start', toolUseId: item.id, toolName: 'ImageGeneration' };
          case 'reasoning':
            return null;
          case 'agentMessage':
          case 'contextCompaction':
            return null;
          case 'userMessage':
            return {
              kind: 'user_message_accepted',
              clientUserMessageId: codexUserMessageClientId(item) ?? codexUserMessageClientId(p),
            };
          case 'enteredReviewMode':
          case 'exitedReviewMode':
          case 'hookPrompt':
            // Handled in item/completed (transition events, no started-side render).
            return null;
          default:
            // Codex review W4 — silent drop hides newly-added item types from
            // future Codex versions. Log so production triage has a breadcrumb.
            console.warn(`[codex] item/started: unhandled item.type=${(item as { type?: string }).type}`);
            return null;
        }
      }

      case 'item/completed': {
        const item = p.item as {
          type: string; id: string;
          command?: string; aggregatedOutput?: string; exitCode?: number; durationMs?: number; cwd?: string; processId?: string; status?: string;
          changes?: unknown;
          tool?: string; server?: string; mcpAppResourceUri?: string;
          arguments?: unknown; namespace?: string | null;
          result?: unknown; error?: { message: string };
          text?: string; summary?: string[];
          results?: unknown;
          query?: string; action?: { type: string; url?: string; queries?: string[]; pattern?: string };
          path?: string; revisedPrompt?: string; savedPath?: string;
          contentItems?: Array<{ type: string; text?: string; imageUrl?: string; audioUrl?: string }>;
          success?: boolean; review?: string; delivery?: unknown; questions?: unknown;
          senderThreadId?: string; receiverThreadIds?: string[];
          prompt?: string; model?: string;
        } | undefined;
        if (!item) return null;

        // Attachment save context — shared by image-producing case branches below.
        // turnId comes from Codex; if Codex never emitted one yet (shouldn't happen
        // at item/completed time) we fall back to the item id to preserve uniqueness.
        const attachCtx = (mimeType: string, caption?: string, producedBy?: string): SaveContext => ({
          sessionId: codexProc.sessionId || 'unknown-session',
          turnId: codexProc.currentTurnId || item.id,
          toolUseId: item.id,
          mimeType,
          caption,
          producedBy,
        });

        // For tool items, emit tool_use_stop + tool_result as a pair
        // (frontend expects stop before result, matching CC's content_block_stop → tool_result)
        switch (item.type) {
          case 'commandExecution':
            return [
              { kind: 'tool_use_stop', toolUseId: item.id },
              {
                kind: 'tool_result',
                toolUseId: item.id,
                content: item.aggregatedOutput || '',
                isError: item.exitCode != null && item.exitCode !== 0,
                metadata: {
                  exitCode: item.exitCode ?? null,
                  durationMs: item.durationMs ?? null,
                  cwd: item.cwd,
                  processId: item.processId ?? null,
                  status: item.status,
                },
              },
            ];
          case 'fileChange': {
            // Show file paths and diffs for each changed file, plus terminal status
            // (inProgress / completed / failed / declined) — `declined` matters
            // because user-rejected patches look identical to other states without it.
            const details = buildCodexFileChangeResultContent(item.changes);
            const isFailedPatch = item.status === 'failed' || item.status === 'declined';
            const statusPrefix = item.status && item.status !== 'completed'
              ? `[${item.status}]\n`
              : '';
            const finalInput = buildCodexCompletedFileChangeInput(item.changes, item.cwd);
            return [
              { kind: 'tool_use_stop', toolUseId: item.id, ...(finalInput ? { input: finalInput } : {}) },
              {
                kind: 'tool_result',
                toolUseId: item.id,
                content: statusPrefix + details,
                isError: isFailedPatch,
                metadata: { status: item.status },
              },
            ];
          }
          case 'mcpToolCall': {
            // Walk MCP ContentBlock[] per spec: text/image/audio/resource/resource_link.
            // Text joins into the human-readable content string; image/audio land as
            // ToolAttachment[] for unified rendering.
            const contentArr = ((item.result as { content?: Array<Record<string, unknown>> })?.content) || [];
            const texts: string[] = [];
            const attachments: ToolAttachment[] = [];
            for (const block of contentArr) {
              const ty = block.type as string | undefined;
              if (ty === 'text' && typeof block.text === 'string') {
                texts.push(block.text);
              } else if (ty === 'image' && typeof block.data === 'string') {
                const mime = (typeof block.mimeType === 'string' ? block.mimeType : 'image/png');
                const ctx = attachCtx(mime, undefined, `codex.mcp.${item.server ?? ''}.${item.tool ?? ''}`);
                attachments.push(this.scheduleAttachmentSave(
                  { kind: 'base64', data: block.data as string },
                  ctx,
                  asyncEmit,
                ));
              } else if (ty === 'audio' && typeof block.data === 'string') {
                const mime = (typeof block.mimeType === 'string' ? block.mimeType : 'audio/mpeg');
                const ctx = attachCtx(mime, undefined, `codex.mcp.${item.server ?? ''}.${item.tool ?? ''}`);
                attachments.push(this.scheduleAttachmentSave(
                  { kind: 'base64', data: block.data as string },
                  ctx,
                  asyncEmit,
                ));
              } else if (ty === 'resource_link' && typeof block.uri === 'string') {
                texts.push(`[resource] ${block.uri}`);
              }
            }
            const fallbackText = texts.length === 0 && attachments.length === 0
              ? JSON.stringify(item.result ?? '')
              : '';
            const content = item.error?.message || texts.join('\n') || fallbackText;
            return [
              { kind: 'tool_use_stop', toolUseId: item.id },
              {
                kind: 'tool_result',
                toolUseId: item.id,
                content,
                isError: !!item.error,
                attachments: attachments.length > 0 ? attachments : undefined,
              },
            ];
          }
          case 'dynamicToolCall': {
            const texts: string[] = [];
            const attachments: ToolAttachment[] = [];
            for (const ci of item.contentItems ?? []) {
              if (ci.type === 'inputText' && typeof ci.text === 'string') {
                texts.push(ci.text);
              } else if (ci.type === 'inputImage' && typeof ci.imageUrl === 'string') {
                // imageUrl is typically a data URL or https URL — saveToolAttachment
                // handles both branches (data: routes through base64).
                const ctx = attachCtx('image/png', undefined, `codex.dynamic.${item.namespace ?? ''}.${item.tool ?? ''}`);
                attachments.push(this.scheduleAttachmentSave(
                  { kind: 'url', url: ci.imageUrl },
                  ctx,
                  asyncEmit,
                ));
              } else if (ci.type === 'inputAudio' && typeof ci.audioUrl === 'string') {
                const ctx = attachCtx('audio/mpeg', undefined, `codex.dynamic.${item.namespace ?? ''}.${item.tool ?? ''}`);
                attachments.push(this.scheduleAttachmentSave(
                  { kind: 'url', url: ci.audioUrl },
                  ctx,
                  asyncEmit,
                ));
              }
            }
            const content = texts.length === 0 && attachments.length === 0
              ? JSON.stringify(item.result ?? '')
              : texts.join('\n');
            return [
              { kind: 'tool_use_stop', toolUseId: item.id },
              {
                kind: 'tool_result',
                toolUseId: item.id,
                content,
                isError: item.success === false,
                attachments: attachments.length > 0 ? attachments : undefined,
                metadata: { durationMs: item.durationMs ?? null },
              },
            ];
          }
          case 'webSearch': {
            const parts: string[] = [];
            if (item.query) parts.push(`Query: ${item.query}`);
            const action = item.action;
            if (action) {
              if (action.type === 'search' && Array.isArray(action.queries) && action.queries.length > 0) {
                parts.push(`Queries: ${action.queries.join(' | ')}`);
              } else if (action.type === 'openPage' && action.url) {
                parts.push(`URL: ${action.url}`);
              } else if (action.type === 'findInPage') {
                if (action.url) parts.push(`URL: ${action.url}`);
                if (action.pattern) parts.push(`Pattern: ${action.pattern}`);
              }
            }
            return [
              { kind: 'tool_use_stop', toolUseId: item.id },
              {
                kind: 'tool_result', toolUseId: item.id,
                // Preserve standalone ref_id/URL results in the existing product
                // tool payload; query/action summaries cannot resolve citations.
                content: Array.isArray(item.results)
                  ? JSON.stringify({ results: item.results, answer: parts.join('\n') })
                  : parts.join('\n') || 'Search completed',
              },
            ];
          }
          case 'imageView':
            return [
              { kind: 'tool_use_stop', toolUseId: item.id },
              { kind: 'tool_result', toolUseId: item.id, content: item.path || 'Image viewed' },
            ];
          case 'imageGeneration': {
            // PRD 0.2.15 — the core fix. Prior code only read revisedPrompt/status
            // and dropped the actual image bytes on the floor.
            //
            // Sources, in preference order:
            //   1. savedPath (Codex v0.117+ auto-saved file in its cache) → zero-copy reference
            //   2. result (base64 image bytes from OpenAI image_generation_call) → decode + write
            const attachments: ToolAttachment[] = [];
            const caption = typeof item.revisedPrompt === 'string' ? item.revisedPrompt : undefined;
            const mime = 'image/png';

            if (typeof item.savedPath === 'string' && item.savedPath) {
              attachments.push(this.scheduleAttachmentSave(
                { kind: 'externalPath', sourcePath: item.savedPath },
                attachCtx(mime, caption, 'codex.image_generation'),
                asyncEmit,
              ));
            } else if (typeof (item as Record<string, unknown>).result === 'string') {
              const b64 = (item as Record<string, unknown>).result as string;
              if (b64) {
                attachments.push(this.scheduleAttachmentSave(
                  { kind: 'base64', data: b64 },
                  attachCtx(mime, caption, 'codex.image_generation'),
                  asyncEmit,
                ));
              }
            }

            return [
              { kind: 'tool_use_stop', toolUseId: item.id },
              {
                kind: 'tool_result',
                toolUseId: item.id,
                content: caption || item.status || 'Image generated',
                attachments: attachments.length > 0 ? attachments : undefined,
              },
            ];
          }
          case 'plan': {
            // PRD 0.2.15 — Codex `plan` items were previously dropped (parsed as
            // null in the default branch). They mirror CC's thinking blocks, so
            // re-map: started → thinking_start (synthesized at parseNotification
            // started branch below), completed → thinking_stop here. Text comes
            // through item/plan/delta as thinking_delta already.
            return { kind: 'thinking_stop', index: 0, traceId: codexTraceId(p, item.id, 'plan') };
          }
          case 'subAgentActivity': {
            // Codex multi-agent v2 (0.144.1): spawn/message/interrupt tools are
            // represented solely by this terminal activity item. Its id is the
            // originating tool call id and agentThreadId is the correlation key.
            const activity = item as Record<string, unknown>;
            const interactionDelivery = activity.kind === 'interacted'
              ? codexProc.codexV2InteractionDeliveryByCallId.get(item.id)
              : undefined;
            const activityThreadId = stringValue(activity.agentThreadId);
            if (
              interactionDelivery === 'trigger-turn'
              && activityThreadId
              && activityThreadId !== codexProc.threadId
              && !codexProc.activeSubAgentTurns.has(activityThreadId)
              && !codexProc.completedSubAgentTurnsBeforeActivity.has(activityThreadId)
            ) {
              // The activity can arrive before the follow-up child turn. Drop
              // only the previous turn's terminal observation so rebinding the
              // thread cannot make the new card look running before the native
              // turn/started notification. If the new child turn already
              // started (or even completed) its observation remains authoritative.
              const previous = codexProc.subAgentLifecycleByThread.get(activityThreadId);
              if (previous?.terminalStatus) {
                codexProc.subAgentLifecycleByThread.delete(activityThreadId);
              }
            }
            const events = applyCodexSubAgentActivity(
              codexProc,
              stringValue(p.threadId),
              codexProc.threadId,
              item,
              interactionDelivery,
            );
            if (!events) {
              console.warn('[codex] item/completed: malformed subAgentActivity');
            } else {
              codexProc.codexV2SubAgentActivityObserved = true;
              codexProc.codexV2InteractionDeliveryByCallId.delete(item.id);
              if (
                (activity.kind === 'started' || activity.kind === 'interacted')
                && activityThreadId
              ) {
                const completedBeforeActivity = codexProc.completedSubAgentTurnsBeforeActivity
                  .delete(activityThreadId);
                codexProc.subAgentThreadsAwaitingActivity.delete(activityThreadId);
                if (
                  activityThreadId !== codexProc.threadId
                  && !completedBeforeActivity
                  && !codexProc.activeSubAgentTurns.has(activityThreadId)
                ) {
                  if (activity.kind === 'started') {
                    // spawn_agent always starts a child turn.
                    codexProc.activeSubAgentTurns.set(activityThreadId, null);
                  } else if (interactionDelivery === 'trigger-turn') {
                    // The raw function-call item is emitted before tool
                    // execution, so a known followup_task can reserve its
                    // child lifecycle even if root turn/completed wins the
                    // cross-thread notification race.
                    codexProc.activeSubAgentTurns.set(activityThreadId, null);
                  } else if (!interactionDelivery) {
                    // Resumed/older protocols may not provide the raw
                    // discriminator. Never reserve an ambiguous interaction:
                    // queue-only send_message must not hang the root. A later
                    // child turn still becomes the execution owner itself.
                    codexProc.subAgentActivitySeenBeforeTurnStart.add(activityThreadId);
                  }
                }
              }
            }
            return events;
          }
          case 'collabAgentToolCall': {
            // PRD 0.2.15 — multi-agent collab tool was completely dropped before.
            // PRD 0.2.27 — authoritative spawn card↔child-thread link (receiverThreadIds
            // is populated by completion time).
            recordLegacySpawnAgentLifecycle(codexProc, item);
            const resolvedParents = resolveCollabAgentControlParents(
              item.tool,
              item.receiverThreadIds,
              codexProc.subThreadToCard,
              codexProc.subThreadToParent,
            );
            const route = resolveCollabControlCompletionRoute(
              codexProc.collabControlToolParents.get(item.id),
              resolvedParents,
            );
            codexProc.collabControlToolParents.delete(item.id);

            if (item.tool && item.tool !== 'spawnAgent') {
              return buildCollabAgentControlCompletedEvents(item, route.parentToolUseIds, {
                includeStart: route.includeStart,
              });
            }

            return [
              { kind: 'tool_use_stop', toolUseId: item.id },
              {
                kind: 'tool_result',
                toolUseId: item.id,
                content: buildCollabAgentResultContent(item),
                isError: isCollabAgentError(item) ? true : undefined,
              },
            ];
          }
          case 'enteredReviewMode':
          case 'exitedReviewMode': {
            // PRD 0.2.15 — surface review-mode transitions as log events so the
            // user sees them in the chat log panel; no tool card needed.
            return {
              kind: 'log',
              level: 'info',
              message: `[codex] ${item.type === 'enteredReviewMode' ? 'Entered' : 'Exited'} review mode${item.review ? `: ${item.review}` : ''}`,
            };
          }
          case 'hookPrompt': {
            // Codex hooks inject prompt fragments at session boundaries. Surface
            // as a log line so the user knows extra context was injected.
            return { kind: 'log', level: 'info', message: '[codex] Hook prompt fragment injected' };
          }
          case 'reasoning':
            return takeCodexReasoningStopEvents(codexProc, p, item.id);
          case 'agentMessage': {
            const finalText = typeof item.text === 'string' ? item.text : '';
            const streamedText = codexProc.agentMessageTextById.get(item.id) || '';
            codexProc.agentMessageTextById.delete(item.id);

            const asyncQuestions = item.delivery === 'async'
              ? parseAsyncQuestionSet({ id: codexTraceId(p, item.id), questions: item.questions })
              : undefined;
            const stop: UnifiedEvent = { kind: 'text_stop', nativeText: finalText, traceId: codexTraceId(p, item.id), ...(asyncQuestions ? { asyncQuestions } : {}) };

            if (finalText) {
              if (!streamedText) {
                console.log(`[codex] agentMessage completed without delta; backfilling ${finalText.length} chars`);
                return [
                  { kind: 'text_delta', text: finalText, traceId: codexTraceId(p, item.id) },
                  stop,
                ];
              }

              if (finalText.startsWith(streamedText) && finalText.length > streamedText.length) {
                const tail = finalText.slice(streamedText.length);
                console.log(`[codex] agentMessage completed with missing tail; backfilling ${tail.length} chars`);
                return [
                  { kind: 'text_delta', text: tail, traceId: codexTraceId(p, item.id) },
                  stop,
                ];
              }
            }

            return stop;
          }
          case 'userMessage':
          case 'contextCompaction':
            // Mirror item/started: these are transition events that we
            // intentionally don't render. Without an explicit case they
            // fall through to the warning default and spam the unified log
            // ~20+ times per session (issue #192).
            return null;
          default:
            // Codex review W4 — log unknown item types so future Codex versions
            // are visible in production triage.
            console.warn(`[codex] item/completed: unhandled item.type=${(item as { type?: string }).type}`);
            return null;
        }
      }

      // ── Command execution output ──
      case 'item/commandExecution/outputDelta':
        return {
          kind: 'tool_result_delta',
          toolUseId: (p.itemId as string) || '',
          delta: (p.delta as string) || '',
        };

      // ── File change output ──
      case 'item/fileChange/outputDelta':
        return {
          kind: 'tool_result_delta',
          toolUseId: (p.itemId as string) || '',
          delta: (p.delta as string) || '',
        };

      // ── Token usage ──
      // PRD 0.2.32 — `inputTokens`/`semantics:'running_total'` 维持原样（external watchdog 依赖
      // 累计值）；新增 `contextOccupiedTokens`（= last.inputTokens，最近一次调用）+ runtime 窗口
      // 给 context 用量指示器。解析逻辑见纯函数 mapCodexTokenUsage（schema 随版本漂移，单独可测）。
      case 'thread/tokenUsage/updated': {
        const mapped = mapCodexTokenUsage(p.tokenUsage as CodexThreadTokenUsage | undefined);
        if (!mapped) return null;
        return {
          kind: 'usage',
          inputTokens: mapped.runningTotalInputTokens,
          outputTokens: mapped.runningTotalOutputTokens,
          semantics: 'running_total',
          contextOccupiedTokens: mapped.contextOccupiedTokens,
          runtimeContextWindow: mapped.runtimeContextWindow,
        };
      }

      // ── Errors ──
      case 'error': {
        const error = p.error as { message: string } | undefined;
        return {
          kind: 'log',
          level: 'error',
          message: `[codex] Runtime error detail=${summarizeCodexValueForLog(error?.message || 'Unknown error')}`,
        };
      }

      // ── Thread name / diff / plan updates ──
      case 'model/rerouted': {
        const model = typeof p.model === 'string'
          ? p.model
          : typeof p.routedModel === 'string'
            ? p.routedModel
            : typeof p.to === 'string'
              ? p.to
              : typeof p.newModel === 'string'
                ? p.newModel
                : '';
        return model ? { kind: 'model_update', model } : null;
      }

      case 'thread/name/updated':
      case 'turn/diff/updated':
      case 'remoteControl/status/changed':
      case 'thread/goal/cleared':
      case 'item/reasoning/summaryPartAdded':
      case 'item/commandExecution/terminalInteraction':
      case 'deprecationNotice':
      case 'configWarning':
      case 'skills/changed':
      case 'account/updated':
      case 'account/rateLimits/updated':
      case 'account/login/completed':
      case 'app/list/updated':
      case 'item/mcpToolCall/progress':
      case 'thread/compacted':
      case 'thread/archived':
      case 'thread/unarchived':
        // Not relevant to our event stream — ignore
        return null;

      case 'turn/plan/updated':
        return mapCodexTurnPlanUpdatedNotification(p);

      case 'serverRequest/resolved': {
        const requestId = resolvedServerRequestId(p);
        if (!requestId) return null;
        const pending = codexProc.pendingRequests.get(requestId);
        if (!pending) return null;
        codexProc.pendingRequests.delete(requestId);
        return { kind: 'interactive_request_resolved', requestId };
      }

      default: {
        // Legacy codex/event/* notifications — ignore (we use v2 typed notifications)
        if (method.startsWith('codex/event/')) return null;
        // Realtime/Windows — ignore
        if (method.startsWith('thread/realtime/') || method.startsWith('windows/')) return null;
        if (method.startsWith('mcpServer/') || method.startsWith('fuzzyFileSearch/')) return null;
        // Unknown notification
        console.log(`[codex] Unhandled notification: ${method}`);
        return null;
      }
    }
  }

  // ─── Server-initiated request handling (approval) ───

  private handleManagedCodexHostToolCall(
    codexProc: CodexProcess,
    rpcId: JsonRpcRequestId,
    params: Record<string, unknown>,
    onEvent: UnifiedEventCallback,
  ): void {
    const snapshot = codexProc.extensionSnapshot;
    const dispatcher = snapshot?.hostToolDispatcher;
    const threadId = stringValue(params.threadId);
    const turnId = stringValue(params.turnId);
    const callId = stringValue(params.callId);
    const tool = stringValue(params.tool);
    const reject = (message: string): void => {
      codexProc.rpc.respond(rpcId, codexHostToolFailure(message));
    };
    if (!snapshot || !dispatcher) {
      reject('Managed Codex Host tools are not enabled for this Session.');
      return;
    }
    if (!threadId || threadId !== codexProc.threadId || !turnId || turnId !== codexProc.currentTurnId) {
      reject('Stale Managed Codex Host tool request.');
      return;
    }
    if (!callId || !tool || codexProc.pendingHostCalls.has(callId) || codexProc.settledHostCallIds.has(callId)) {
      reject('Duplicate or invalid Managed Codex Host tool request.');
      return;
    }
    const descriptor = dispatcher.descriptors.find(candidate => candidate.name === tool);
    if (!descriptor) {
      reject(`Unknown Managed Codex Host tool: ${tool}`);
      return;
    }
    try {
      const validation = managedCodexHostInputValidator
        .getValidator(descriptor.inputSchema)(params.arguments);
      if (!validation.valid) {
        reject(`Invalid arguments for Managed Codex Host tool: ${tool}`);
        return;
      }
    } catch {
      reject(`Invalid schema for Managed Codex Host tool: ${tool}`);
      return;
    }

    const controller = new AbortController();
    const pending: PendingManagedCodexHostCall = {
      rpcId,
      callId,
      threadId,
      turnId,
      params,
      controller,
      settled: false,
    };
    codexProc.pendingHostCalls.set(callId, pending);
    if (codexProc.approvalPolicy !== 'never') {
      const requestId = String(rpcId);
      codexProc.pendingRequests.set(requestId, {
        kind: 'host_tool_approval',
        rpcId,
        method: 'item/tool/call',
        params,
        callId,
      });
      onEvent({
        kind: 'permission_request',
        requestId,
        toolName: tool,
        toolUseId: callId,
        input: objectValue(params.arguments),
      });
      return;
    }
    this.dispatchManagedCodexHostToolCall(codexProc, callId);
  }

  private dispatchManagedCodexHostToolCall(codexProc: CodexProcess, callId: string): void {
    const pending = codexProc.pendingHostCalls.get(callId);
    const snapshot = codexProc.extensionSnapshot;
    const dispatcher = snapshot?.hostToolDispatcher;
    if (!pending || pending.settled || !dispatcher) {
      codexProc.abortPendingHostCall(callId, 'Managed Codex Host tool generation is unavailable.');
      return;
    }
    const requestParams = pending.params;
    const tool = stringValue(requestParams.tool);
    if (!tool || !dispatcher.descriptors.some(candidate => candidate.name === tool)) {
      codexProc.abortPendingHostCall(callId, 'Managed Codex Host tool request payload is unavailable.');
      return;
    }
    pending.timeout = setTimeout(() => {
      codexProc.abortPendingHostCall(callId, `Managed Codex Host tool timed out: ${tool}`);
    }, MYAGENTS_TOOL_CALL_TIMEOUT_MS);
    const call: ManagedCodexHostToolCall = {
      processGeneration: codexProc.processGeneration,
      threadId: pending.threadId,
      turnId: pending.turnId,
      callId: pending.callId,
      tool,
      arguments: requestParams.arguments,
      signal: pending.controller.signal,
    };
    void dispatcher.dispatch(call).then(
      result => {
        const current = codexProc.pendingHostCalls.get(callId);
        if (current !== pending || pending.settled || pending.controller.signal.aborted) return;
        pending.settled = true;
        codexProc.pendingHostCalls.delete(callId);
        codexProc.settledHostCallIds.add(callId);
        codexProc.rpc.respond(pending.rpcId, toCodexDynamicToolCallResult(result));
      },
      error => {
        const current = codexProc.pendingHostCalls.get(callId);
        if (current !== pending || pending.settled || pending.controller.signal.aborted) return;
        pending.settled = true;
        codexProc.pendingHostCalls.delete(callId);
        codexProc.settledHostCallIds.add(callId);
        codexProc.rpc.respond(
          pending.rpcId,
          codexHostToolFailure(error instanceof Error ? error.message : String(error)),
        );
      },
    ).finally(() => {
      if (pending.timeout) clearTimeout(pending.timeout);
    });
  }

  private handleServerRequest(
    codexProc: CodexProcess,
    rpcId: JsonRpcRequestId,
    method: string,
    params: unknown,
    onEvent: UnifiedEventCallback,
  ): void {
    const p = params as Record<string, unknown>;
    if (!isKnownCodexServerRequestMethod(method)) {
      console.warn(`[codex] Unhandled future server request: ${method}`);
      codexProc.rpc.respondError(rpcId, -32601, `Method not supported: ${method}`);
      return;
    }
    const requestId = String(rpcId);
    const track = (pending: PendingCodexRequest): void => {
      codexProc.pendingRequests.set(requestId, pending);
    };

    switch (method) {
      case 'item/commandExecution/requestApproval': {
        track({ kind: 'command_approval', rpcId, method, params: p });
        onEvent({
          kind: 'permission_request',
          requestId,
          toolName: 'Shell',
          toolUseId: (p.itemId as string) || '',
          input: {
            command: (p.command as string) || '',
            cwd: (p.cwd as string) || '',
            reason: (p.reason as string) || undefined,
          },
        });
        break;
      }

      case 'item/fileChange/requestApproval': {
        track({ kind: 'file_approval', rpcId, method, params: p });
        onEvent({
          kind: 'permission_request',
          requestId,
          toolName: 'FileEdit',
          toolUseId: (p.itemId as string) || '',
          input: {
            reason: (p.reason as string) || '',
            grantRoot: (p.grantRoot as string) || undefined,
          },
        });
        break;
      }

      case 'item/tool/requestUserInput': {
        if (shouldDenyCodexStructuredUserInput(codexProc)) {
          const action = serializeCodexPermissionResponse(
            { kind: 'tool_user_input', rpcId, method, params: p },
            'deny',
            undefined,
            true,
          );
          codexProc.rpc.respond(rpcId, action.type === 'result' ? action.result : null);
          break;
        }
        track({ kind: 'tool_user_input', rpcId, method, params: p });
        onEvent({
          kind: 'permission_request',
          requestId,
          toolName: 'AskUserQuestion',
          toolUseId: (p.itemId as string) || '',
          input: toolRequestUserInputToAskUserQuestion(p),
        });
        break;
      }

      case 'mcpServer/elicitation/request': {
        const requestedSchema = objectValue(p.requestedSchema);
        const hasFormFields = Object.keys(objectValue(requestedSchema.properties)).length > 0;
        if ((p.mode === 'form' || p.mode === 'openai/form') && hasFormFields) {
          if (shouldDenyCodexStructuredUserInput(codexProc)) {
            const action = serializeCodexPermissionResponse(
              { kind: 'mcp_elicitation', rpcId, method, params: p },
              'deny',
              undefined,
              true,
            );
            if (action.type === 'error') {
              codexProc.rpc.respondError(rpcId, action.code, action.message);
            } else {
              codexProc.rpc.respond(rpcId, action.result);
            }
            break;
          }
          track({ kind: 'mcp_elicitation', rpcId, method, params: p });
          onEvent({
            kind: 'permission_request',
            requestId,
            toolName: 'AskUserQuestion',
            toolUseId: stringValue(p.turnId) || requestId,
            input: mcpElicitationToAskUserQuestion(p),
          });
          break;
        }
        track({ kind: 'mcp_elicitation', rpcId, method, params: p });
        const isToolApproval = isCodexMcpApprovalElicitation(p);
        onEvent({
          kind: 'permission_request',
          requestId,
          toolName: p.mode === 'url' ? 'MCP URL Approval' : isToolApproval ? 'MCP Tool Approval' : 'MCP Elicitation',
          toolUseId: stringValue(p.turnId) || requestId,
          input: {
            serverName: p.serverName,
            message: p.message,
            mode: p.mode,
            ...(p.mode === 'url' ? { url: p.url, elicitationId: p.elicitationId } : {}),
          },
        });
        break;
      }

      case 'item/permissions/requestApproval': {
        track({ kind: 'permissions_approval', rpcId, method, params: p });
        onEvent({
          kind: 'permission_request',
          requestId,
          toolName: 'Codex Permissions',
          toolUseId: stringValue(p.itemId) || requestId,
          input: {
            reason: p.reason,
            cwd: p.cwd,
            permissions: p.permissions,
          },
        });
        break;
      }

      case 'execCommandApproval':
      case 'applyPatchApproval': {
        track({ kind: method === 'execCommandApproval' ? 'command_approval' : 'file_approval', rpcId, method, params: p });
        onEvent({
          kind: 'permission_request',
          requestId,
          toolName: method === 'execCommandApproval' ? 'Shell' : 'FileEdit',
          toolUseId: stringValue(p.itemId) || stringValue(p.callId) || requestId,
          input: p,
        });
        break;
      }

      case 'item/tool/call':
        this.handleManagedCodexHostToolCall(codexProc, rpcId, p, onEvent);
        break;

      case 'account/chatgptAuthTokens/refresh':
        codexProc.rpc.respondError(rpcId, -32000, 'MyAgents does not refresh Codex ChatGPT tokens; run `codex login` in a terminal');
        break;

      case 'attestation/generate':
        codexProc.rpc.respondError(rpcId, -32000, 'MyAgents did not request Codex attestation');
        break;

      case 'currentTime/read':
        codexProc.rpc.respond(rpcId, { currentTimeAt: Math.floor(Date.now() / 1000) });
        break;

      default: {
        const _exhaustive: never = method;
        codexProc.rpc.respondError(rpcId, -32601, `Method not supported: ${_exhaustive}`);
        break;
      }
    }
  }
}

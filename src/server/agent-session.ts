import { randomUUID } from 'crypto';
import { existsSync, mkdirSync } from 'fs';
import { join, resolve } from 'path';
import { createRequire } from 'module';
import { query, type Query, type SDKUserMessage } from '@anthropic-ai/claude-agent-sdk';
import { getScriptDir, getBundledRuntimePath, isBunRuntime } from './utils/runtime';
import { getCrossPlatformEnv, buildCrossPlatformEnv } from './utils/platform';

import type { ToolInput } from '../renderer/types/chat';
import { parsePartialJson } from '../shared/parsePartialJson';
import type { SystemInitInfo } from '../shared/types/system';
import { saveSessionMetadata, updateSessionTitleFromMessage, saveSessionMessages, saveAttachment, updateSessionMetadata, getSessionMetadata, getSessionData } from './SessionStore';
import { createSessionMetadata, type SessionMessage, type MessageAttachment, type MessageUsage } from './types/session';
import { broadcast } from './sse';
import { initLogger, appendLog, getLogLines as getLogLinesFromLogger, cleanupOldLogs } from './AgentLogger';

// Module-level debug mode check (avoids repeated environment variable access)
const isDebugMode = process.env.DEBUG === '1' || process.env.NODE_ENV === 'development';

// Decorative text filter thresholds (for third-party API wrappers like 智谱 GLM-4.7)
// Decorative blocks are typically 100-2000 chars; we use wider range for safety margin
const DECORATIVE_TEXT_MIN_LENGTH = 50;
const DECORATIVE_TEXT_MAX_LENGTH = 5000;

// ===== Product Directory Configuration =====
// Our product (MyAgents) uses ~/.myagents/ for user configuration
// This is SEPARATE from Claude CLI's ~/.claude/ directory
// Only subscription-related features may access ~/.claude/ (handled by SDK internally)
const MYAGENTS_USER_DIR = '.myagents';

/**
 * Get the MyAgents user directory path
 * All user configs (MCP, providers, projects, etc.) are stored here
 */
export function getMyAgentsUserDir(): string {
  const { home } = getCrossPlatformEnv();
  // Fallback to /tmp only if home is not available (should be rare)
  const homeDir = home || '/tmp';
  return join(homeDir, MYAGENTS_USER_DIR);
}

type SessionState = 'idle' | 'running' | 'error';

// Permission mode types - UI values
export type PermissionMode = 'auto' | 'plan' | 'fullAgency' | 'custom';

// Map UI permission mode to SDK permission mode
function mapToSdkPermissionMode(mode: PermissionMode): 'acceptEdits' | 'plan' | 'bypassPermissions' | 'default' {
  switch (mode) {
    case 'auto':
      return 'acceptEdits';
    case 'plan':
      return 'plan';
    case 'fullAgency':
      return 'bypassPermissions';
    case 'custom':
    default:
      return 'default';
  }
}

type ToolUseState = {
  id: string;
  name: string;
  input: Record<string, unknown>;
  streamIndex: number;
  inputJson?: string;
  parsedInput?: ToolInput;
  result?: string;
  isLoading?: boolean;
  isError?: boolean;
  subagentCalls?: SubagentToolCall[];
};

type SubagentToolCall = {
  id: string;
  name: string;
  input: Record<string, unknown>;
  streamIndex?: number;
  inputJson?: string;
  parsedInput?: ToolInput;
  result?: string;
  isLoading?: boolean;
  isError?: boolean;
};

type ContentBlock = {
  type: 'text' | 'tool_use' | 'thinking' | 'server_tool_use';
  text?: string;
  tool?: ToolUseState;
  thinking?: string;
  thinkingStartedAt?: number;
  thinkingDurationMs?: number;
  thinkingStreamIndex?: number;
  isComplete?: boolean;
};

export type MessageWire = {
  id: string;
  role: 'user' | 'assistant';
  content: string | ContentBlock[];
  timestamp: string;
  attachments?: {
    id: string;
    name: string;
    size: number;
    mimeType: string;
    savedPath?: string;
    relativePath?: string;
    previewUrl?: string;
    isImage?: boolean;
  }[];
};

const requireModule = createRequire(import.meta.url);

let agentDir = '';
let hasInitialPrompt = false;
let sessionState: SessionState = 'idle';
let querySession: Query | null = null;
let isProcessing = false;
let shouldAbortSession = false;
let sessionTerminationPromise: Promise<void> | null = null;
let isInterruptingResponse = false;
let isStreamingMessage = false;
const messages: MessageWire[] = [];
const streamIndexToToolId: Map<number, string> = new Map();
const toolResultIndexToId: Map<number, string> = new Map();
const childToolToParent: Map<string, string> = new Map();
let messageSequence = 0;
let sessionId = randomUUID();
let systemInitInfo: SystemInitInfo | null = null;
type MessageQueueItem = {
  message: SDKUserMessage['message'];
  resolve: () => void;
};
const messageQueue: MessageQueueItem[] = [];
// Pending attachments to persist with user messages
const pendingAttachments: MessageAttachment[] = [];
// Current permission mode for the session (updates on each user message)
let currentPermissionMode: PermissionMode = 'auto';
// Current model for the session (updates on each user message if changed)
let currentModel: string | undefined = undefined;
// Provider environment config (baseUrl, apiKey, authType) for third-party providers
export type ProviderEnv = {
  baseUrl?: string;
  apiKey?: string;
  authType?: 'auth_token' | 'api_key' | 'both' | 'auth_token_clear_api_key';
};
let currentProviderEnv: ProviderEnv | undefined = undefined;
// SDK session ID to resume from (set by switchToSession)
let resumeSessionId: string | undefined = undefined;
// SDK ready signal - prevents messageGenerator from yielding before SDK's ProcessTransport is ready
let sdkReadyResolve: (() => void) | null = null;
let sdkReadyPromise: Promise<void> | null = null;

// ===== Turn-level Usage Tracking =====
// Accumulated usage for the current turn (reset when new user message starts)
let currentTurnUsage = {
  inputTokens: 0,
  outputTokens: 0,
  cacheReadTokens: 0,
  cacheCreationTokens: 0,
  model: undefined as string | undefined,
};
// Timestamp when current assistant response started
let currentTurnStartTime: number | null = null;
// Tool count for current turn
let currentTurnToolCount = 0;

function resetTurnUsage(): void {
  currentTurnUsage = {
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheCreationTokens: 0,
    model: undefined,
  };
  currentTurnStartTime = null;
  currentTurnToolCount = 0;
}

// ===== MCP Configuration =====
import type { McpServerDefinition } from '../renderer/config/types';

// SDK MCP server config type (subset of what SDK accepts)
type SdkMcpServerConfig = {
  type?: 'stdio';
  command: string;
  args?: string[];
  env?: Record<string, string>;
} | {
  type: 'sse' | 'http';
  url: string;
  headers?: Record<string, string>;
};

// Current MCP servers enabled for this workspace (set per-query)
// null = never set (use config file fallback), [] = explicitly set to none
let currentMcpServers: McpServerDefinition[] | null = null;

// Preset MCP servers (same as renderer/config/types.ts)
const PRESET_MCP_SERVERS: McpServerDefinition[] = [
  {
    id: 'playwright',
    name: 'Playwright 浏览器',
    description: '浏览器自动化能力，支持网页浏览、截图、表单填写等',
    type: 'stdio',
    command: 'npx',
    args: ['@playwright/mcp@latest'],
    env: {},
    isBuiltin: true,
  },
];

/**
 * Load MCP config from ~/.myagents/config.json
 * This provides a file-based approach that works across all sidecars
 */
function loadMcpServersFromConfig(): McpServerDefinition[] {
  if (isDebugMode) console.log('[agent] ==> loadMcpServersFromConfig() called');
  try {
    const configPath = join(getMyAgentsUserDir(), 'config.json');
    if (isDebugMode) console.log('[agent] Config path:', configPath);

    if (!existsSync(configPath)) {
      if (isDebugMode) console.log('[agent] No MCP config file found at:', configPath);
      return [];
    }

    const content = require('fs').readFileSync(configPath, 'utf-8');
    const config = JSON.parse(content);

    // Get globally enabled server IDs
    const globalEnabledIds: string[] = config.mcpEnabledServers ?? [];
    if (globalEnabledIds.length === 0) {
      if (isDebugMode) console.log('[agent] No MCP servers enabled globally');
      return [];
    }

    // Get custom servers from config + preset servers
    const customServers: McpServerDefinition[] = config.mcpServers ?? [];
    const allServers = [...PRESET_MCP_SERVERS, ...customServers];

    // Filter to only globally enabled servers
    const enabledServers = allServers.filter(s => globalEnabledIds.includes(s.id));

    // Also apply server-specific env overrides if any
    const serverEnvConfig: Record<string, Record<string, string>> = config.mcpServerEnv ?? {};

    return enabledServers.map(server => ({
      ...server,
      env: { ...server.env, ...(serverEnvConfig[server.id] ?? {}) }
    }));
  } catch (error) {
    console.error('[agent] Failed to load MCP config from file:', error);
    return [];
  }
}

/**
 * Set the MCP servers to use for subsequent queries
 * Called from renderer when user toggles MCP in workspace
 * If MCP config changed and a session is running, it will be restarted with resume
 */
export function setMcpServers(servers: McpServerDefinition[]): void {
  // Check if MCP config actually changed
  const currentIds = (currentMcpServers ?? []).map(s => s.id).sort().join(',');
  const newIds = servers.map(s => s.id).sort().join(',');
  const mcpChanged = currentIds !== newIds;

  currentMcpServers = servers;
  if (isDebugMode) {
    console.log(`[agent] MCP servers set: ${servers.map(s => s.id).join(', ') || 'none'}`);
    // Log servers with custom env vars for debugging
    for (const s of servers) {
      if (s.env && Object.keys(s.env).length > 0) {
        console.log(`[agent] MCP ${s.id}: Has custom env vars: ${Object.keys(s.env).join(', ')}`);
      }
    }
  }

  // If MCP changed and session is running, restart with resume to apply new config
  if (mcpChanged && querySession) {
    if (isDebugMode) console.log(`[agent] MCP config changed (${currentIds || 'none'} -> ${newIds || 'none'}), restarting session with resume`);
    // Save current SDK session_id for resume so conversation context is preserved
    if (systemInitInfo?.session_id) {
      resumeSessionId = systemInitInfo.session_id;
      if (isDebugMode) console.log(`[agent] Will resume from SDK session: ${resumeSessionId}`);
    }
    shouldAbortSession = true;
  }
}

/**
 * Get current MCP servers
 * Returns null if never set (workspace not initialized), or array (possibly empty)
 */
export function getMcpServers(): McpServerDefinition[] | null {
  return currentMcpServers;
}

/**
 * Check if an MCP tool is allowed based on user's MCP settings
 *
 * MCP tool naming convention: mcp__<server-id>__<tool-name>
 * e.g., mcp__playwright__browser_navigate
 *
 * @returns 'allow' if tool is permitted, 'deny' with reason otherwise
 */
function checkMcpToolPermission(toolName: string): { allowed: true } | { allowed: false; reason: string } {
  // Not an MCP tool - let other permission logic handle it
  if (!toolName.startsWith('mcp__')) {
    return { allowed: true };
  }

  // Case 1: MCP not set (null) - allow all (backward compatible)
  if (currentMcpServers === null) {
    return { allowed: true };
  }

  // Case 2: User disabled all MCP
  if (currentMcpServers.length === 0) {
    return { allowed: false, reason: 'MCP 工具已被禁用' };
  }

  // Case 3: User enabled specific MCP - check if this tool's server is enabled
  // Extract server ID from tool name: mcp__<server-id>__<tool-name>
  const parts = toolName.split('__');
  if (parts.length < 3) {
    return { allowed: false, reason: '无效的 MCP 工具名称' };
  }
  const serverId = parts[1];

  // Check if this server is in the enabled list
  const isEnabled = currentMcpServers.some(s => s.id === serverId);
  if (isEnabled) {
    return { allowed: true };
  }

  return { allowed: false, reason: `MCP 服务「${serverId}」未启用` };
}

/**
 * Build SDK settingSources
 *
 * settingSources controls where SDK reads settings from:
 * - 'user': ~/.claude/ (Claude CLI's user directory)
 * - 'project': <cwd>/.claude/ (project-level config)
 *
 * We use 'project' only:
 * - Enables SDK to read project's .claude/skills/, .claude/commands/, CLAUDE.md
 * - Project-level MCP in .claude/ will also be discovered (acceptable - it's project config)
 *
 * We exclude 'user' because:
 * - ~/.claude/ is Claude CLI's directory, not our product's directory
 * - Our product (MyAgents) uses ~/.myagents/ for user-level config
 * - We manage additional MCP explicitly via mcpServers option
 */
function buildSettingSources(): ('user' | 'project')[] {
  // Always use 'project' to enable SDK reading from <cwd>/.claude/
  // This is required for: skills, commands, CLAUDE.md, project settings
  // Note: Project-level MCP in .claude/ will also be discovered (acceptable)
  return ['project'];
}

/**
 * Convert McpServerDefinition to SDK mcpServers format
 * Now runs MCP from local install directory (~/.myagents/mcp/<serverId>/)
 * If not installed locally, falls back to npx (but this may cause stdout pollution)
 */
function buildSdkMcpServers(): Record<string, SdkMcpServerConfig> {
  // Use memory cache if set (even if empty - user explicitly disabled all MCP)
  // Only fall back to config file if never set (null)
  let servers: McpServerDefinition[];
  if (currentMcpServers === null) {
    servers = loadMcpServersFromConfig();
    console.log(`[agent] Loaded MCP from config file: ${servers.map(s => s.id).join(', ') || 'none'}`);
  } else {
    servers = currentMcpServers;
    if (isDebugMode) console.log(`[agent] Using workspace MCP: ${servers.map(s => s.id).join(', ') || 'none'}`);
  }

  if (servers.length === 0) {
    // Return empty object
    // SDK auto-discovery is controlled via buildSettingSources() - when MCP is explicitly
    // configured, settingSources excludes 'user' to prevent unwanted MCP discovery
    return {};
  }

  const { existsSync, readFileSync } = require('fs');
  const { join } = require('path');
  const mcpBaseDir = join(getMyAgentsUserDir(), 'mcp');

  const result: Record<string, SdkMcpServerConfig> = {};

  for (const server of servers) {
    // Log server env for debugging
    if (isDebugMode && server.env && Object.keys(server.env).length > 0) {
      console.log(`[agent] MCP ${server.id}: Custom env vars: ${Object.keys(server.env).join(', ')}`);
    }

    if (server.type === 'stdio' && server.command) {
      const serverDir = join(mcpBaseDir, server.id);
      const args = server.args || [];

      // Extract package name from args (e.g., "@playwright/mcp@latest" -> "@playwright/mcp")
      const packageName = args[0] || '';
      const packageNameClean = packageName.replace(/@(latest|[\d.]+)$/, '');

      // Check if package is installed locally
      const localNodeModules = join(serverDir, 'node_modules');
      const localPkgJson = join(localNodeModules, ...packageNameClean.split('/'), 'package.json');

      if (existsSync(localPkgJson)) {
        // Package is installed locally - find entry point and run with node
        try {
          const pkgInfo = JSON.parse(readFileSync(localPkgJson, 'utf-8'));
          let entryPoint = '';

          // Try bin first (for CLI tools)
          if (pkgInfo.bin) {
            const binPath = typeof pkgInfo.bin === 'string'
              ? pkgInfo.bin
              : Object.values(pkgInfo.bin)[0] as string;
            entryPoint = join(localNodeModules, ...packageNameClean.split('/'), binPath);
          } else if (pkgInfo.main) {
            entryPoint = join(localNodeModules, ...packageNameClean.split('/'), pkgInfo.main);
          }

          if (entryPoint && existsSync(entryPoint)) {
            // Use shared utility to get bundled bun or fallback runtime
            const runtimePath = getBundledRuntimePath();
            console.log(`[agent] MCP ${server.id}: Using local install at ${entryPoint} with runtime ${runtimePath}`);

            result[server.id] = {
              command: runtimePath,
              args: [entryPoint],
              env: buildCrossPlatformEnv(server.env),
            };
            continue;
          }
        } catch (e) {
          console.warn(`[agent] MCP ${server.id}: Failed to read local package:`, e);
        }
      }

      // Fallback: package not installed locally
      // Use bundled bun with bunx (bun's npx equivalent) - no Node.js required
      const runtimePath = getBundledRuntimePath();
      console.warn(`[agent] MCP ${server.id}: NOT installed locally, using fallback with ${runtimePath}`);

      // For bun, use "bun x" (bunx) to run packages without installing
      // For node fallback, this won't work but we log a clear error
      if (isBunRuntime(runtimePath)) {
        result[server.id] = {
          command: runtimePath,
          args: ['x', ...args],
          env: buildCrossPlatformEnv(server.env),
        };
      } else {
        // Node fallback - try npx but may fail if not installed
        console.error(`[agent] MCP ${server.id}: No bun available, npx fallback may fail without Node.js`);
        const argsWithY = args.includes('-y') ? args : ['-y', ...args];
        result[server.id] = {
          command: 'npx',
          args: argsWithY,
          env: buildCrossPlatformEnv({
            npm_config_loglevel: 'error',
            npm_config_update_notifier: 'false',
            ...server.env,
          }),
        };
      }
    } else if ((server.type === 'sse' || server.type === 'http') && server.url) {
      result[server.id] = {
        type: server.type,
        url: server.url,
        headers: server.headers,
      };
    }
  }

  console.log(`[agent] Built SDK MCP servers: ${Object.keys(result).join(', ') || 'none'}`);
  // Always return result (even if empty) to prevent SDK from using default config
  return result;
}

/**
 * Permission rules for each mode
 */
interface PermissionRules {
  allowedTools: string[];    // Auto-approved tools (glob patterns supported)
  deniedTools: string[];     // Always denied tools
  // Tools not in either list will prompt user for confirmation
}

/**
 * Get permission rules based on current permission mode
 */
function getPermissionRules(mode: PermissionMode): PermissionRules {
  switch (mode) {
    case 'auto':
      return {
        allowedTools: [
          'Read', 'Glob', 'Grep', 'LS',           // Read operations
          'Edit', 'Write', 'MultiEdit',           // Write operations (acceptEdits)
          'NotebookEdit', 'TodoRead', 'TodoWrite', // Notebook/Todo operations
          'Skill'                                  // Skills - auto-approve skill invocations
        ],
        deniedTools: [],
        // Bash, Task, WebFetch, WebSearch, mcp__* → need confirmation
      };
    case 'plan':
      return {
        allowedTools: ['Read', 'Glob', 'Grep', 'LS'], // Read-only
        deniedTools: ['*'], // Everything else denied in plan mode
      };
    case 'fullAgency':
      return {
        allowedTools: ['*'], // Everything auto-approved
        deniedTools: [],
      };
    case 'custom':
    default:
      return {
        allowedTools: ['Read', 'Glob', 'Grep', 'LS', 'Skill'], // Read-only + Skills auto-approved
        deniedTools: [],
        // Everything else needs confirmation
      };
  }
}

/**
 * Session-scoped permission state
 * Tracks tools that user has granted "always allow" for this session
 */
const sessionAlwaysAllowed = new Set<string>();

// Pending permission requests waiting for user response
const pendingPermissions = new Map<string, {
  resolve: (decision: 'allow' | 'deny') => void;
  toolName: string;
  input: unknown;
  timer: ReturnType<typeof setTimeout>;  // Timer reference for cleanup
}>();

// AskUserQuestion types - import from shared
import type { AskUserQuestionInput } from '../shared/types/askUserQuestion';
export type { AskUserQuestionInput, AskUserQuestion, AskUserQuestionOption } from '../shared/types/askUserQuestion';

// Pending AskUserQuestion requests waiting for user response
const pendingAskUserQuestions = new Map<string, {
  resolve: (answers: Record<string, string> | null) => void;
  input: AskUserQuestionInput;
  timer: ReturnType<typeof setTimeout>;
}>();

/**
 * Validate AskUserQuestion input structure
 */
function isValidAskUserQuestionInput(input: unknown): input is AskUserQuestionInput {
  if (!input || typeof input !== 'object') return false;
  const obj = input as Record<string, unknown>;
  if (!Array.isArray(obj.questions) || obj.questions.length === 0) return false;

  // Validate each question has required fields
  return obj.questions.every((q: unknown) => {
    if (!q || typeof q !== 'object') return false;
    const question = q as Record<string, unknown>;
    return (
      typeof question.question === 'string' &&
      typeof question.header === 'string' &&
      Array.isArray(question.options) &&
      question.options.length >= 2 &&
      typeof question.multiSelect === 'boolean'
    );
  });
}

/**
 * Handle AskUserQuestion tool - prompts user for structured answers
 * Returns the input with answers filled in, or null if denied/aborted
 */
async function handleAskUserQuestion(
  input: unknown,
  signal?: AbortSignal
): Promise<Record<string, string> | null> {
  console.log('[AskUserQuestion] Requesting user input');

  // Validate input structure
  if (!isValidAskUserQuestionInput(input)) {
    console.error('[AskUserQuestion] Invalid input structure:', input);
    return null;
  }

  const requestId = `ask_${Date.now()}_${Math.random().toString(36).slice(2)}`;
  const questionInput = input;

  // Broadcast AskUserQuestion request to frontend
  broadcast('ask-user-question:request', {
    requestId,
    questions: questionInput.questions,
  });

  // Wait for user response or abort
  return new Promise((resolve) => {
    let timer: ReturnType<typeof setTimeout>;

    const cleanup = () => {
      clearTimeout(timer);
      pendingAskUserQuestions.delete(requestId);
      signal?.removeEventListener('abort', onAbort);
    };

    const onAbort = () => {
      console.debug('[AskUserQuestion] Aborted by SDK signal');
      cleanup();
      resolve(null);
    };

    // Listen for SDK abort signal
    signal?.addEventListener('abort', onAbort);

    // Timeout after 10 minutes (user needs time to think)
    timer = setTimeout(() => {
      if (pendingAskUserQuestions.has(requestId)) {
        cleanup();
        console.warn('[AskUserQuestion] Timed out after 10 minutes');
        resolve(null);
      }
    }, 10 * 60 * 1000);

    pendingAskUserQuestions.set(requestId, { resolve, input: questionInput, timer });
  });
}

/**
 * Handle user's AskUserQuestion response from frontend
 */
export function handleAskUserQuestionResponse(
  requestId: string,
  answers: Record<string, string> | null
): boolean {
  console.debug(`[AskUserQuestion] handleResponse: requestId=${requestId}, answers=${JSON.stringify(answers)}`);

  const pending = pendingAskUserQuestions.get(requestId);
  if (!pending) {
    console.warn(`[AskUserQuestion] Unknown request: ${requestId}`);
    return false;
  }

  // Clear the timeout timer to prevent memory leak
  clearTimeout(pending.timer);
  pendingAskUserQuestions.delete(requestId);

  if (answers === null) {
    console.log('[AskUserQuestion] User cancelled');
    pending.resolve(null);
  } else {
    console.log('[AskUserQuestion] User answered');
    pending.resolve(answers);
  }

  return true;
}

/**
 * Check if a glob pattern matches a tool name
 */
function matchesPattern(pattern: string, toolName: string): boolean {
  if (pattern === '*') return true;
  if (pattern === toolName) return true;
  // Simple glob: mcp__playwright__* matches mcp__playwright__browser_tabs
  if (pattern.endsWith('*')) {
    const prefix = pattern.slice(0, -1);
    return toolName.startsWith(prefix);
  }
  return false;
}

/**
 * Check if tool is in a list (supports glob patterns)
 */
function isToolInList(toolName: string, list: string[]): boolean {
  return list.some(pattern => matchesPattern(pattern, toolName));
}

/**
 * Check tool permission - returns immediately for allowed/denied tools,
 * or waits for user response for unknown tools
 */
async function checkToolPermission(
  toolName: string,
  input: unknown,
  mode: PermissionMode,
  signal?: AbortSignal
): Promise<'allow' | 'deny'> {
  const rules = getPermissionRules(mode);

  // 1. Check if tool is always allowed for this mode
  if (isToolInList(toolName, rules.allowedTools)) {
    console.debug(`[permission] ${toolName}: auto-allowed by mode rules`);
    return 'allow';
  }

  // 2. Check if tool is denied for this mode
  if (isToolInList(toolName, rules.deniedTools)) {
    console.debug(`[permission] ${toolName}: denied by mode rules`);
    return 'deny';
  }

  // 3. Check if user already granted "always allow" in this session
  if (sessionAlwaysAllowed.has(toolName)) {
    console.debug(`[permission] ${toolName}: allowed by session grant`);
    return 'allow';
  }

  // 4. Check if already aborted
  if (signal?.aborted) {
    console.debug(`[permission] ${toolName}: already aborted, denying`);
    return 'deny';
  }

  // 5. Request user confirmation via frontend
  console.log(`[permission] ${toolName}: requesting user confirmation`);  // Keep as info - user action needed

  const requestId = `perm_${Date.now()}_${Math.random().toString(36).slice(2)}`;

  // Broadcast permission request to frontend
  broadcast('permission:request', {
    requestId,
    toolName,
    input: typeof input === 'object' ? JSON.stringify(input).slice(0, 500) : String(input).slice(0, 500),
  });

  // Wait for user response or abort
  return new Promise((resolve) => {
    const cleanup = () => {
      pendingPermissions.delete(requestId);
      signal?.removeEventListener('abort', onAbort);
    };

    const onAbort = () => {
      console.debug(`[permission] ${toolName}: aborted by SDK signal, denying`);
      cleanup();
      resolve('deny');
    };

    // Listen for SDK abort signal
    signal?.addEventListener('abort', onAbort);

    // Timeout after 5 minutes
    const timer = setTimeout(() => {
      if (pendingPermissions.has(requestId)) {
        cleanup();
        console.warn(`[permission] ${toolName}: timed out after 5 minutes, denying`);
        resolve('deny');
      }
    }, 5 * 60 * 1000);

    pendingPermissions.set(requestId, { resolve, toolName, input, timer });
  });
}

/**
 * Handle user's permission response from frontend
 */
export function handlePermissionResponse(
  requestId: string,
  decision: 'deny' | 'allow_once' | 'always_allow'
): boolean {
  console.debug(`[permission] handlePermissionResponse: requestId=${requestId}, decision=${decision}`);

  const pending = pendingPermissions.get(requestId);
  if (!pending) {
    console.warn(`[permission] Unknown permission request: ${requestId}`);
    return false;
  }

  // Clear the timeout timer to prevent memory leak
  clearTimeout(pending.timer);
  pendingPermissions.delete(requestId);

  if (decision === 'deny') {
    console.log(`[permission] ${pending.toolName}: user denied`);
    pending.resolve('deny');
  } else if (decision === 'allow_once') {
    console.log(`[permission] ${pending.toolName}: user allowed once`);
    pending.resolve('allow');
  } else if (decision === 'always_allow') {
    console.log(`[permission] ${pending.toolName}: user granted session permission`);
    sessionAlwaysAllowed.add(pending.toolName);
    pending.resolve('allow');
  }

  return true;
}

/**
 * Clear session permission state (call when session ends)
 */
export function clearSessionPermissions(): void {
  sessionAlwaysAllowed.clear();
  pendingPermissions.clear();
  pendingAskUserQuestions.clear();
}

/**
 * Persist messages to SessionStore for session recovery
 * @param lastAssistantUsage - Usage info for the last assistant message (on message complete)
 * @param lastAssistantToolCount - Tool count for the last assistant message
 * @param lastAssistantDurationMs - Duration for the last assistant response
 */
function persistMessagesToStorage(
  lastAssistantUsage?: MessageUsage,
  lastAssistantToolCount?: number,
  lastAssistantDurationMs?: number
): void {
  const sessionMessages: SessionMessage[] = messages.map((msg, index) => {
    const isLastAssistant = index === messages.length - 1 && msg.role === 'assistant';
    return {
      id: msg.id,
      role: msg.role,
      content: typeof msg.content === 'string' ? msg.content : JSON.stringify(msg.content),
      timestamp: msg.timestamp,
      attachments: msg.attachments?.map((att) => ({
        id: att.id,
        name: att.name,
        mimeType: att.mimeType,
        path: att.relativePath ?? '', // Map relativePath to path for storage
      })),
      // Attach usage info only to the last assistant message if provided
      usage: isLastAssistant && lastAssistantUsage ? lastAssistantUsage : undefined,
      toolCount: isLastAssistant && lastAssistantToolCount ? lastAssistantToolCount : undefined,
      durationMs: isLastAssistant && lastAssistantDurationMs ? lastAssistantDurationMs : undefined,
    };
  });
  saveSessionMessages(sessionId, sessionMessages);
  // Update lastActiveAt
  updateSessionMetadata(sessionId, { lastActiveAt: new Date().toISOString() });
}

function getSessionId(): string {
  return sessionId;
}

function resetAbortFlag(): void {
  shouldAbortSession = false;
}

export function resolveClaudeCodeCli(): string {
  try {
    const cliPath = requireModule.resolve('@anthropic-ai/claude-agent-sdk/cli.js');
    if (cliPath.includes('app.asar')) {
      const unpackedPath = cliPath.replace('app.asar', 'app.asar.unpacked');
      if (existsSync(unpackedPath)) {
        return unpackedPath;
      }
    }
    return cliPath;
  } catch (error) {
    // Fallback for bundled environment (Production)
    // We copy claude-agent-sdk to src-tauri/resources/claude-agent-sdk during build
    // process.cwd() is set to resources directory by sidecar.rs
    const bundledPath = join(process.cwd(), 'claude-agent-sdk', 'cli.js');
    if (existsSync(bundledPath)) {
      console.log(`[resolveClaudeCodeCli] Using bundled SDK at: ${bundledPath}`);
      return bundledPath;
    }
    console.error(`[resolveClaudeCodeCli] Failed to resolve SDK. Bundled path not found: ${bundledPath}`);
    throw error;
  }
}

/**
 * Build environment for Claude session
 * @param providerEnv - Optional provider environment override (for verification or external calls)
 */
export function buildClaudeSessionEnv(providerEnv?: ProviderEnv): NodeJS.ProcessEnv {
  // Ensure essential paths are always present, even when launched from Finder
  // (Finder launches via launchd which doesn't inherit shell environment variables)
  const { home } = getCrossPlatformEnv();
  const isDebug = process.env.DEBUG === '1' || process.env.NODE_ENV === 'development';

  // Cross-platform PATH separator
  const PATH_SEP = process.platform === 'win32' ? ';' : ':';
  const PATH_KEY = process.platform === 'win32' ? 'Path' : 'PATH';

  // Detect bundled bun path from app resources
  // When running in bundled app, this script is in Resources/server/
  // Tauri externalBin places binaries in Contents/MacOS/ (not Resources)
  // NOTE: Use getScriptDir() instead of __dirname because bun build hardcodes __dirname at compile time
  const scriptDir = getScriptDir();
  if (isDebug) console.log('[env] Script directory:', scriptDir);

  const potentialBundledBinaries = [
    // In bundled app: server-dist.js is in Resources/ (not Resources/server/)
    // scriptDir = .../MyAgents.app/Contents/Resources
    // MacOS dir = .../MyAgents.app/Contents/MacOS
    scriptDir.replace('/Resources', '/MacOS'),
    // Alternative: go up one level from Resources to Contents, then into MacOS
    // Use resolve() to normalize the path (avoid /a/b/../c style paths)
    resolve(scriptDir, '..', 'MacOS'),
  ];

  // Check which bundled paths actually exist
  const validBundledPaths = potentialBundledBinaries.filter(p => {
    const bunPath = `${p}/bun`;
    const exists = existsSync(bunPath);
    if (isDebug) console.log(`[env] Checking bundled bun: ${bunPath} -> ${exists ? 'EXISTS' : 'NOT FOUND'}`);
    return exists;
  });

  const essentialPaths = [
    // Bundled bun paths (highest priority)
    ...validBundledPaths,
    // System bun installations (fallback)
    `${home}/.bun/bin`,
    '/opt/homebrew/bin',
    '/usr/local/bin',
    '/usr/bin',
    '/bin',
  ];

  const existingPath = process.env[PATH_KEY] || process.env.PATH || '';
  if (isDebug) console.log('[env] Original PATH:', existingPath.substring(0, 200) + (existingPath.length > 200 ? '...' : ''));

  const pathParts = existingPath ? existingPath.split(PATH_SEP) : [];

  // Add essential paths if not already present (in reverse order so first in list ends up first in PATH)
  for (const p of [...essentialPaths].reverse()) {
    if (p && !pathParts.includes(p)) {
      pathParts.unshift(p);
    }
  }

  const finalPath = pathParts.join(PATH_SEP);
  if (isDebug) {
    console.log('[env] Final PATH (first 5 entries):', pathParts.slice(0, 5).join(PATH_SEP));
    console.log('[env] Bundled bun will be used:', validBundledPaths.length > 0 ? 'YES' : 'NO (using system bun)');
  }

  // Build base environment
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    [PATH_KEY]: finalPath,
  };

  // Use provided providerEnv or fall back to currentProviderEnv
  const effectiveProviderEnv = providerEnv ?? currentProviderEnv;

  // Handle provider-specific environment variables
  // IMPORTANT: Must explicitly delete these when switching back to Anthropic subscription
  // to avoid using stale third-party provider settings
  if (effectiveProviderEnv?.baseUrl) {
    env.ANTHROPIC_BASE_URL = effectiveProviderEnv.baseUrl;
    console.log(`[env] ANTHROPIC_BASE_URL set to: ${effectiveProviderEnv.baseUrl}`);
  } else {
    // Clear any previously set third-party baseUrl
    delete env.ANTHROPIC_BASE_URL;
    console.log('[env] ANTHROPIC_BASE_URL cleared (using Anthropic default)');
  }

  if (effectiveProviderEnv?.apiKey) {
    // Set auth based on authType setting
    const authType = effectiveProviderEnv.authType ?? 'both'; // Default to 'both' for backward compatibility

    switch (authType) {
      case 'auth_token':
        // Only set AUTH_TOKEN, delete API_KEY
        env.ANTHROPIC_AUTH_TOKEN = effectiveProviderEnv.apiKey;
        delete env.ANTHROPIC_API_KEY;
        console.log('[env] ANTHROPIC_AUTH_TOKEN set (authType: auth_token)');
        break;
      case 'api_key':
        // Only set API_KEY, delete AUTH_TOKEN
        delete env.ANTHROPIC_AUTH_TOKEN;
        env.ANTHROPIC_API_KEY = effectiveProviderEnv.apiKey;
        console.log('[env] ANTHROPIC_API_KEY set (authType: api_key)');
        break;
      case 'auth_token_clear_api_key':
        // Set AUTH_TOKEN and explicitly set API_KEY to empty string (required by OpenRouter)
        env.ANTHROPIC_AUTH_TOKEN = effectiveProviderEnv.apiKey;
        env.ANTHROPIC_API_KEY = '';
        console.log('[env] ANTHROPIC_AUTH_TOKEN set, ANTHROPIC_API_KEY cleared (authType: auth_token_clear_api_key)');
        break;
      case 'both':
      default:
        // Set both variants for compatibility with different SDK versions
        env.ANTHROPIC_AUTH_TOKEN = effectiveProviderEnv.apiKey;
        env.ANTHROPIC_API_KEY = effectiveProviderEnv.apiKey;
        console.log('[env] ANTHROPIC_AUTH_TOKEN and ANTHROPIC_API_KEY both set (authType: both)');
        break;
    }
  } else {
    // Clear any previously set third-party apiKey, let SDK use default auth
    delete env.ANTHROPIC_AUTH_TOKEN;
    delete env.ANTHROPIC_API_KEY;
    console.log('[env] ANTHROPIC_AUTH_TOKEN cleared (using default auth)');
  }

  return env;
}

function asString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

function safeStringify(value: unknown): string {
  if (typeof value === 'string') {
    return value;
  }
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function asStringArray(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) {
    return undefined;
  }
  return value.map((item) => safeStringify(item));
}

function parseSystemInitInfo(message: unknown): SystemInitInfo | null {
  if (!message || typeof message !== 'object') {
    return null;
  }
  const record = message as Record<string, unknown>;
  if (record.type !== 'system' || record.subtype !== 'init') {
    return null;
  }

  return {
    timestamp: new Date().toISOString(),
    type: asString(record.type),
    subtype: asString(record.subtype),
    cwd: asString(record.cwd),
    session_id: asString(record.session_id),
    tools: asStringArray(record.tools),
    mcp_servers: asStringArray(record.mcp_servers),
    model: asString(record.model),
    permissionMode: asString(record.permissionMode),
    slash_commands: asStringArray(record.slash_commands),
    apiKeySource: asString(record.apiKeySource),
    claude_code_version: asString(record.claude_code_version),
    output_style: asString(record.output_style),
    agents: asStringArray(record.agents),
    skills: asStringArray(record.skills),
    plugins: asStringArray(record.plugins),
    uuid: asString(record.uuid)
  };
}

/**
 * Parse SDK status message (e.g., compacting)
 * Returns { isStatusMessage, status } to distinguish between:
 * - Not a status message at all (isStatusMessage: false)
 * - A status message with status: null (clearing the status)
 * - A status message with status: 'compacting' etc.
 */
function parseSystemStatus(message: unknown): { isStatusMessage: boolean; status: string | null } {
  if (!message || typeof message !== 'object') {
    return { isStatusMessage: false, status: null };
  }
  const record = message as Record<string, unknown>;
  if (record.type !== 'system' || record.subtype !== 'status') {
    return { isStatusMessage: false, status: null };
  }
  // This IS a status message, status can be 'compacting' or null
  return {
    isStatusMessage: true,
    status: typeof record.status === 'string' ? record.status : null
  };
}

function setSessionState(nextState: SessionState): void {
  if (sessionState === nextState) {
    return;
  }
  sessionState = nextState;
  broadcast('chat:status', { sessionState });
}

function ensureAssistantMessage(): MessageWire {
  const lastMessage = messages[messages.length - 1];
  if (lastMessage && lastMessage.role === 'assistant' && isStreamingMessage) {
    return lastMessage;
  }
  const assistant: MessageWire = {
    id: String(messageSequence++),
    role: 'assistant',
    content: '',
    timestamp: new Date().toISOString()
  };
  messages.push(assistant);
  isStreamingMessage = true;
  return assistant;
}

function ensureContentArray(message: MessageWire): ContentBlock[] {
  if (typeof message.content === 'string') {
    const contentArray: ContentBlock[] = [];
    if (message.content) {
      contentArray.push({ type: 'text', text: message.content });
    }
    message.content = contentArray;
    return contentArray;
  }
  return message.content;
}

/**
 * Check if text is a decorative wrapper from third-party APIs (e.g., 智谱 GLM-4.7)
 * These APIs wrap server_tool_use with decorative text blocks that shouldn't be displayed
 *
 * IMPORTANT: This function must be very precise to avoid filtering legitimate content.
 * We require MULTIPLE specific markers to be present before filtering.
 *
 * @returns { filtered: boolean, reason?: string } - reason is for debugging
 */
function checkDecorativeToolText(text: string): { filtered: boolean; reason?: string } {
  // Safety: never filter very short or very long text
  if (!text || text.length < DECORATIVE_TEXT_MIN_LENGTH || text.length > DECORATIVE_TEXT_MAX_LENGTH) {
    return { filtered: false };
  }

  const trimmed = text.trim();

  // Pattern 1: 智谱 GLM-4.7 tool invocation wrapper
  // Must have ALL of these markers (very specific combination):
  // - "🌐 Z.ai Built-in Tool:" or "Z.ai Built-in Tool:"
  // - "**Input:**" (markdown bold)
  // - Either "```json" or "Executing on server"
  const hasZaiToolMarker = trimmed.includes('Z.ai Built-in Tool:');
  const hasInputMarker = trimmed.includes('**Input:**');
  const hasJsonBlock = trimmed.includes('```json') || trimmed.includes('Executing on server');

  if (hasZaiToolMarker && hasInputMarker && hasJsonBlock) {
    return { filtered: true, reason: 'zhipu-tool-invocation-wrapper' };
  }

  // Pattern 2: 智谱 GLM-4.7 tool output wrapper
  // Must have ALL of these markers:
  // - Starts with "**Output:**"
  // - Contains "_result_summary:" (specific to Zhipu's format)
  // - Contains JSON-like content (starts with "[" or "{")
  if (trimmed.startsWith('**Output:**') && trimmed.includes('_result_summary:')) {
    // Additional check: should contain JSON-like structure
    const hasJsonContent = trimmed.includes('[{') || trimmed.includes('{"');
    if (hasJsonContent) {
      return { filtered: true, reason: 'zhipu-tool-output-wrapper' };
    }
  }

  return { filtered: false };
}

function appendTextChunk(chunk: string): void {
  // Filter out decorative text from third-party APIs (e.g., 智谱 GLM-4.7)
  const decorativeCheck = checkDecorativeToolText(chunk);
  if (decorativeCheck.filtered) {
    console.log(`[agent] Filtered decorative text (${decorativeCheck.reason}), length=${chunk.length}`);
    return;
  }

  const message = ensureAssistantMessage();
  if (typeof message.content === 'string') {
    message.content += chunk;
    return;
  }
  const contentArray = message.content;
  const lastBlock = contentArray[contentArray.length - 1];
  if (lastBlock?.type === 'text') {
    lastBlock.text = `${lastBlock.text ?? ''}${chunk}`;
  } else {
    contentArray.push({ type: 'text', text: chunk });
  }
}

function handleThinkingStart(index: number): void {
  const message = ensureAssistantMessage();
  const contentArray = ensureContentArray(message);
  contentArray.push({
    type: 'thinking',
    thinking: '',
    thinkingStreamIndex: index,
    thinkingStartedAt: Date.now()
  });
}

function handleThinkingChunk(index: number, delta: string): void {
  const message = ensureAssistantMessage();
  const contentArray = ensureContentArray(message);
  const thinkingBlock = contentArray.find(
    (block) => block.type === 'thinking' && block.thinkingStreamIndex === index && !block.isComplete
  );
  if (thinkingBlock && thinkingBlock.type === 'thinking') {
    thinkingBlock.thinking = `${thinkingBlock.thinking ?? ''}${delta}`;
  }
}

function handleToolUseStart(tool: {
  id: string;
  name: string;
  input: Record<string, unknown>;
  streamIndex: number;
}): void {
  const message = ensureAssistantMessage();
  const contentArray = ensureContentArray(message);
  contentArray.push({
    type: 'tool_use',
    tool: {
      ...tool,
      inputJson: ''
    }
  });
  // Increment tool count for this turn
  currentTurnToolCount++;
}

/**
 * Handle server_tool_use content block start
 * server_tool_use is a tool executed by the API provider (e.g., 智谱 GLM-4.7's webReader)
 * Unlike tool_use (client-side MCP tools), these run on the server and results come back in the stream
 */
function handleServerToolUseStart(tool: {
  id: string;
  name: string;
  input: Record<string, unknown>;
  streamIndex: number;
}): void {
  const message = ensureAssistantMessage();
  const contentArray = ensureContentArray(message);
  contentArray.push({
    type: 'server_tool_use',
    tool: {
      ...tool,
      inputJson: JSON.stringify(tool.input, null, 2), // Server tools come with complete input
      parsedInput: tool.input as unknown as ToolInput
    }
  });
  // Server tools also count towards tool usage
  currentTurnToolCount++;
}

function handleSubagentToolUseStart(
  parentToolUseId: string,
  tool: {
    id: string;
    name: string;
    input: Record<string, unknown>;
    streamIndex?: number;
  }
): void {
  const parentTool = findToolBlockById(parentToolUseId);
  if (!parentTool) {
    return;
  }
  childToolToParent.set(tool.id, parentToolUseId);
  if (!parentTool.tool.subagentCalls) {
    parentTool.tool.subagentCalls = [];
  }
  const existing = parentTool.tool.subagentCalls.find((call) => call.id === tool.id);
  if (existing) {
    existing.name = tool.name;
    existing.input = tool.input;
    existing.streamIndex = tool.streamIndex;
    return;
  }
  parentTool.tool.subagentCalls.push({
    id: tool.id,
    name: tool.name,
    input: tool.input,
    streamIndex: tool.streamIndex,
    inputJson: JSON.stringify(tool.input, null, 2),
    isLoading: true
  });
}

function ensureSubagentToolPlaceholder(parentToolUseId: string, toolUseId: string): void {
  const parentTool = findToolBlockById(parentToolUseId);
  if (!parentTool) {
    return;
  }
  if (!parentTool.tool.subagentCalls) {
    parentTool.tool.subagentCalls = [];
  }
  const existing = parentTool.tool.subagentCalls.find((call) => call.id === toolUseId);
  if (existing) {
    return;
  }
  childToolToParent.set(toolUseId, parentToolUseId);
  parentTool.tool.subagentCalls.push({
    id: toolUseId,
    name: 'Tool',
    input: {},
    inputJson: '{}',
    isLoading: true
  });
}

function handleToolInputDelta(index: number, toolId: string, delta: string): void {
  const message = ensureAssistantMessage();
  const contentArray = ensureContentArray(message);
  const toolBlock = contentArray.find(
    (block) => block.type === 'tool_use' && block.tool?.id === toolId
  );
  if (!toolBlock || toolBlock.type !== 'tool_use' || !toolBlock.tool) {
    return;
  }
  const newInputJson = `${toolBlock.tool.inputJson ?? ''}${delta}`;
  toolBlock.tool.inputJson = newInputJson;
  const parsedInput = parsePartialJson<ToolInput>(newInputJson);
  if (parsedInput) {
    toolBlock.tool.parsedInput = parsedInput;
  }
}

function handleSubagentToolInputDelta(
  parentToolUseId: string,
  toolId: string,
  delta: string
): void {
  const parentTool = findToolBlockById(parentToolUseId);
  if (!parentTool?.tool.subagentCalls) {
    return;
  }
  const subCall = parentTool.tool.subagentCalls.find((call) => call.id === toolId);
  if (!subCall) {
    return;
  }
  const newInputJson = `${subCall.inputJson ?? ''}${delta}`;
  subCall.inputJson = newInputJson;
  const parsedInput = parsePartialJson<ToolInput>(newInputJson);
  if (parsedInput) {
    subCall.parsedInput = parsedInput;
  }
}

function finalizeSubagentToolInput(parentToolUseId: string, toolId: string): void {
  const parentTool = findToolBlockById(parentToolUseId);
  if (!parentTool?.tool.subagentCalls) {
    return;
  }
  const subCall = parentTool.tool.subagentCalls.find((call) => call.id === toolId);
  if (!subCall?.inputJson) {
    return;
  }
  try {
    subCall.parsedInput = JSON.parse(subCall.inputJson) as ToolInput;
  } catch {
    const parsed = parsePartialJson<ToolInput>(subCall.inputJson);
    if (parsed) {
      subCall.parsedInput = parsed;
    }
  }
}

function handleContentBlockStop(index: number, toolId?: string): void {
  const message = ensureAssistantMessage();
  const contentArray = ensureContentArray(message);
  const thinkingBlock = contentArray.find(
    (block) => block.type === 'thinking' && block.thinkingStreamIndex === index && !block.isComplete
  );
  if (thinkingBlock && thinkingBlock.type === 'thinking') {
    thinkingBlock.isComplete = true;
    thinkingBlock.thinkingDurationMs =
      thinkingBlock.thinkingStartedAt ? Date.now() - thinkingBlock.thinkingStartedAt : undefined;
    return;
  }

  const toolBlock =
    toolId ?
      contentArray.find((block) => block.type === 'tool_use' && block.tool?.id === toolId)
      : contentArray.find((block) => block.type === 'tool_use' && block.tool?.streamIndex === index);

  if (toolBlock && toolBlock.type === 'tool_use' && toolBlock.tool?.inputJson) {
    try {
      toolBlock.tool.parsedInput = JSON.parse(toolBlock.tool.inputJson) as ToolInput;
    } catch {
      const parsed = parsePartialJson<ToolInput>(toolBlock.tool.inputJson);
      if (parsed) {
        toolBlock.tool.parsedInput = parsed;
      }
    }
  }
}

function handleToolResultStart(toolUseId: string, content: string, isError: boolean): void {
  if (handleSubagentToolResultStart(toolUseId, content, isError)) {
    return;
  }
  setToolResult(toolUseId, content, isError);
}

function handleToolResultComplete(toolUseId: string, content: string, isError?: boolean): void {
  if (handleSubagentToolResultComplete(toolUseId, content, isError)) {
    return;
  }
  setToolResult(toolUseId, content, isError);
}

function handleMessageComplete(): void {
  isStreamingMessage = false;
  setSessionState('idle');

  // Calculate duration for this turn
  const durationMs = currentTurnStartTime ? Date.now() - currentTurnStartTime : undefined;

  // Persist messages with usage info after AI response completes
  persistMessagesToStorage({
    inputTokens: currentTurnUsage.inputTokens,
    outputTokens: currentTurnUsage.outputTokens,
    cacheReadTokens: currentTurnUsage.cacheReadTokens || undefined,
    cacheCreationTokens: currentTurnUsage.cacheCreationTokens || undefined,
    model: currentTurnUsage.model,
  }, currentTurnToolCount, durationMs);
}

function handleMessageStopped(): void {
  isStreamingMessage = false;
  setSessionState('idle');
  const lastMessage = messages[messages.length - 1];
  if (!lastMessage || lastMessage.role !== 'assistant' || typeof lastMessage.content === 'string') {
    // Persist even if no assistant message
    persistMessagesToStorage();
    return;
  }
  lastMessage.content = lastMessage.content.map((block) => {
    if (block.type === 'thinking' && !block.isComplete) {
      return {
        ...block,
        isComplete: true,
        thinkingDurationMs:
          block.thinkingStartedAt ? Date.now() - block.thinkingStartedAt : undefined
      };
    }
    return block;
  });
  // Persist after processing message
  persistMessagesToStorage();
}

function handleMessageError(error: string): void {
  isStreamingMessage = false;
  setSessionState('idle');

  // Don't persist expected termination signals as errors
  // These occur during normal session switching or app shutdown
  const isExpectedTermination =
    error.includes('SIGTERM') ||
    error.includes('SIGKILL') ||
    error.includes('SIGINT') ||
    error.includes('process terminated') ||
    error.includes('AbortError');

  if (isExpectedTermination) {
    console.log('[agent] Skipping error persistence for expected termination:', error);
    return;
  }

  messages.push({
    id: String(messageSequence++),
    role: 'assistant',
    content: `Error: ${error}`,
    timestamp: new Date().toISOString()
  });
  // Persist error message
  persistMessagesToStorage();
}

function findToolBlockById(toolUseId: string): { tool: ToolUseState } | null {
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const message = messages[i];
    if (message.role !== 'assistant') {
      continue;
    }
    if (typeof message.content === 'string') {
      continue;
    }
    const toolBlock = message.content.find(
      (block) => block.type === 'tool_use' && block.tool?.id === toolUseId
    );
    if (toolBlock && toolBlock.type === 'tool_use' && toolBlock.tool) {
      return { tool: toolBlock.tool };
    }
  }
  return null;
}

function appendToolResultDelta(toolUseId: string, delta: string): void {
  if (appendSubagentToolResultDelta(toolUseId, delta)) {
    return;
  }
  const toolBlock = findToolBlockById(toolUseId);
  if (!toolBlock) {
    return;
  }
  toolBlock.tool.result = `${toolBlock.tool.result ?? ''}${delta}`;
}

function handleSubagentToolResultStart(
  toolUseId: string,
  content: string,
  isError: boolean
): boolean {
  const parentToolUseId = childToolToParent.get(toolUseId);
  if (!parentToolUseId) {
    return false;
  }
  const parentTool = findToolBlockById(parentToolUseId);
  if (!parentTool?.tool.subagentCalls) {
    return false;
  }
  const subCall = parentTool.tool.subagentCalls.find((call) => call.id === toolUseId);
  if (!subCall) {
    return false;
  }
  subCall.result = content;
  subCall.isError = isError;
  subCall.isLoading = true;
  return true;
}

function handleSubagentToolResultComplete(
  toolUseId: string,
  content: string,
  isError?: boolean
): boolean {
  const parentToolUseId = childToolToParent.get(toolUseId);
  if (!parentToolUseId) {
    return false;
  }
  const parentTool = findToolBlockById(parentToolUseId);
  if (!parentTool?.tool.subagentCalls) {
    return false;
  }
  const subCall = parentTool.tool.subagentCalls.find((call) => call.id === toolUseId);
  if (!subCall) {
    return false;
  }
  subCall.result = content;
  if (typeof isError === 'boolean') {
    subCall.isError = isError;
  }
  subCall.isLoading = false;
  return true;
}

function appendSubagentToolResultDelta(toolUseId: string, delta: string): boolean {
  const parentToolUseId = childToolToParent.get(toolUseId);
  if (!parentToolUseId) {
    return false;
  }
  const parentTool = findToolBlockById(parentToolUseId);
  if (!parentTool?.tool.subagentCalls) {
    return false;
  }
  const subCall = parentTool.tool.subagentCalls.find((call) => call.id === toolUseId);
  if (!subCall) {
    return false;
  }
  subCall.result = `${subCall.result ?? ''}${delta}`;
  subCall.isLoading = true;
  return true;
}

function finalizeSubagentToolResult(toolUseId: string): boolean {
  const parentToolUseId = childToolToParent.get(toolUseId);
  if (!parentToolUseId) {
    return false;
  }
  const parentTool = findToolBlockById(parentToolUseId);
  if (!parentTool?.tool.subagentCalls) {
    return false;
  }
  const subCall = parentTool.tool.subagentCalls.find((call) => call.id === toolUseId);
  if (!subCall) {
    return false;
  }
  subCall.isLoading = false;
  return true;
}

function getSubagentToolResult(toolUseId: string): string | undefined {
  const parentToolUseId = childToolToParent.get(toolUseId);
  if (!parentToolUseId) {
    return undefined;
  }
  const parentTool = findToolBlockById(parentToolUseId);
  if (!parentTool?.tool.subagentCalls) {
    return undefined;
  }
  return parentTool.tool.subagentCalls.find((call) => call.id === toolUseId)?.result;
}

function setToolResult(toolUseId: string, content: string, isError?: boolean): void {
  const toolBlock = findToolBlockById(toolUseId);
  if (!toolBlock) {
    return;
  }
  toolBlock.tool.result = content;
  if (typeof isError === 'boolean') {
    toolBlock.tool.isError = isError;
  }
}

function getToolResult(toolUseId: string): string | undefined {
  const toolBlock = findToolBlockById(toolUseId);
  return toolBlock?.tool.result;
}

function appendToolResultContent(toolUseId: string, content: string, isError?: boolean): string {
  const existing = getToolResult(toolUseId);
  const next = existing ? `${existing}\n${content}` : content;
  setToolResult(toolUseId, next, isError);
  return next;
}

function formatAssistantContent(content: unknown): string {
  if (!content) {
    return '';
  }
  if (typeof content === 'string') {
    return content;
  }
  if (!Array.isArray(content)) {
    return '';
  }
  const parts: string[] = [];
  for (const block of content) {
    if (typeof block === 'string') {
      parts.push(block);
      continue;
    }
    if (!block || typeof block !== 'object') {
      continue;
    }
    if ('type' in block && block.type === 'text' && 'text' in block) {
      parts.push(String(block.text ?? ''));
      continue;
    }
    if ('type' in block && block.type === 'thinking' && 'thinking' in block) {
      const text = String(block.thinking ?? '').trim();
      if (text) {
        parts.push(`Thinking:\n${text}`);
      }
      continue;
    }
    if ('text' in block && typeof block.text === 'string') {
      parts.push(block.text);
    }
  }
  return parts
    .map((part) => part.trim())
    .filter(Boolean)
    .join('\n\n');
}

/**
 * Append log line and broadcast to frontend
 */
function appendLogLine(line: string): void {
  appendLog(line);
  broadcast('chat:log', line);
}

function extractAgentErrorFromContent(content: unknown): string | null {
  const text = formatAssistantContent(content);
  if (!text) {
    return null;
  }
  if (/api error|authentication_error|unauthorized|forbidden/i.test(text)) {
    return text;
  }
  return null;
}

function extractAgentError(sdkMessage: unknown): string | null {
  if (!sdkMessage || typeof sdkMessage !== 'object') {
    return null;
  }
  const candidate = (sdkMessage as { error?: unknown }).error;
  if (candidate) {
    if (typeof candidate === 'string') {
      return candidate;
    }
    try {
      return JSON.stringify(candidate);
    } catch {
      return String(candidate);
    }
  }

  if (
    'type' in sdkMessage &&
    (sdkMessage as { type?: string }).type === 'assistant' &&
    'message' in sdkMessage
  ) {
    const assistantMessage = (sdkMessage as { message?: { content?: unknown } }).message;
    return extractAgentErrorFromContent(assistantMessage?.content);
  }

  return null;
}

export function getAgentState(): {
  agentDir: string;
  sessionState: SessionState;
  hasInitialPrompt: boolean;
} {
  return { agentDir, sessionState, hasInitialPrompt };
}

export function getSystemInitInfo(): SystemInitInfo | null {
  return systemInitInfo;
}

export function getLogLines(): string[] {
  return getLogLinesFromLogger();
}

export function getMessages(): MessageWire[] {
  return messages;
}

/**
 * Internal: Clear all message-related state
 * Used by both resetSession() and initializeAgent()
 */
function clearMessageState(): void {
  messages.length = 0;
  messageQueue.length = 0;
  streamIndexToToolId.clear();
  toolResultIndexToId.clear();
  childToolToParent.clear();
  isStreamingMessage = false;
  messageSequence = 0;
}

/**
 * Reset the current session for "new conversation" functionality
 * This FULLY terminates the SDK session and clears all state
 * Call this from frontend when user clicks "新对话"
 *
 * IMPORTANT: Must properly terminate SDK session to prevent context leakage.
 * Simply interrupting is not enough - we must wait for the session to fully end.
 */
export async function resetSession(): Promise<void> {
  console.log('[agent] resetSession: starting new conversation');

  // 1. Properly terminate the SDK session (same pattern as switchToSession)
  // Must set shouldAbortSession so the messageGenerator exits its polling loop
  if (querySession || sessionTerminationPromise) {
    console.log('[agent] resetSession: terminating existing SDK session');
    shouldAbortSession = true;
    messageQueue.length = 0; // Clear queue so old session doesn't pick up stale messages

    // Wait for the session to fully terminate
    if (sessionTerminationPromise) {
      try {
        await sessionTerminationPromise;
        console.log('[agent] resetSession: SDK session terminated');
      } catch (error) {
        console.warn('[agent] resetSession: session termination error:', error);
      }
    }
    querySession = null;
  }

  // 2. Clear all message state (shared with initializeAgent)
  clearMessageState();

  // 3. Generate new session ID (don't persist yet - wait for first message)
  sessionId = randomUUID();
  hasInitialPrompt = false; // Reset so first message creates a new session in SessionStore

  // 4. Clear SDK resume state - CRITICAL: prevents SDK from resuming old context!
  resumeSessionId = undefined;
  systemInitInfo = null; // Clear old system info so new session gets fresh init

  // 5. Clear SDK ready signal state (same as switchToSession)
  sdkReadyResolve = null;
  sdkReadyPromise = null;

  // 7. Reset processing state
  shouldAbortSession = false;
  isProcessing = false;
  setSessionState('idle');

  // 8. Clear session-scoped permissions
  clearSessionPermissions();

  // 9. Broadcast empty state to frontend
  broadcast('chat:init', { agentDir, sessionState: 'idle', hasInitialPrompt: false });

  console.log('[agent] resetSession: complete, new sessionId=' + sessionId);
}

/**
 * Initialize agent with a new working directory
 * Called when switching to a different project/workspace
 */
export function initializeAgent(nextAgentDir: string, initialPrompt?: string | null): void {
  agentDir = nextAgentDir;
  hasInitialPrompt = Boolean(initialPrompt && initialPrompt.trim());
  systemInitInfo = null;
  sessionId = randomUUID();

  // Clear message state (shared with resetSession)
  clearMessageState();

  // Initialize logger for new session (lazy file creation)
  initLogger(sessionId);
  console.log(`[agent] init dir=${agentDir} initialPrompt=${hasInitialPrompt ? 'yes' : 'no'}`);
  if (hasInitialPrompt) {
    void enqueueUserMessage(initialPrompt!.trim());
  }
}

/**
 * Switch to an existing session for resume functionality
 * This terminates the current session and prepares to resume from the target session
 * 
 * Key behavior:
 * - Preserves target sessionId so messages are saved to the same session
 * - Sets resumeSessionId if available so SDK continues conversation context
 * - If no sdkSessionId exists (old session), starts fresh but keeps same session ID
 */
export async function switchToSession(targetSessionId: string): Promise<boolean> {
  console.log(`[agent] switchToSession: ${targetSessionId}`);

  // Get the target session metadata to find SDK session_id
  const sessionMeta = getSessionMetadata(targetSessionId);
  if (!sessionMeta) {
    console.error(`[agent] switchToSession: session ${targetSessionId} not found`);
    return false;
  }

  // Properly terminate the old session if one is running
  // Must set shouldAbortSession so the messageGenerator exits its polling loop
  // Otherwise the old session continues processing messages with stale settings
  if (querySession || sessionTerminationPromise) {
    console.log('[agent] switchToSession: aborting current session');
    shouldAbortSession = true;
    messageQueue.length = 0; // Clear queue before waiting so old session doesn't pick up stale messages
    if (sessionTerminationPromise) {
      await sessionTerminationPromise;
    }
    querySession = null;
  }

  // Reset all runtime state
  shouldAbortSession = false;
  isProcessing = false;
  setSessionState('idle');
  messages.length = 0;
  messageQueue.length = 0;
  streamIndexToToolId.clear();
  toolResultIndexToId.clear();
  childToolToParent.clear();
  systemInitInfo = null;

  // Clear SDK ready signal state
  sdkReadyResolve = null;
  sdkReadyPromise = null;

  // Preserve target sessionId so new messages are saved to the same session
  sessionId = targetSessionId as `${string}-${string}-${string}-${string}-${string}`;

  // Load existing messages from storage into memory
  // This is critical for incremental save logic in saveSessionMessages
  const sessionData = getSessionData(targetSessionId);
  if (sessionData?.messages) {
    for (const storedMsg of sessionData.messages) {
      // Convert SessionMessage to MessageWire format
      // Content may be JSON-stringified ContentBlock[] or plain text
      let parsedContent: string | ContentBlock[] = storedMsg.content;
      if (storedMsg.content.startsWith('[')) {
        try {
          const parsed = JSON.parse(storedMsg.content);
          if (Array.isArray(parsed)) {
            parsedContent = parsed as ContentBlock[];
          }
        } catch {
          // Keep as string if parse fails
        }
      }

      const msgWire: MessageWire = {
        id: storedMsg.id,
        role: storedMsg.role,
        content: parsedContent,
        timestamp: storedMsg.timestamp,
        attachments: storedMsg.attachments?.map((att) => ({
          id: att.id,
          name: att.name,
          size: 0,
          mimeType: att.mimeType,
          relativePath: att.path,
        })),
      };
      messages.push(msgWire);
    }
    // Update messageSequence to continue from the last message
    if (sessionData.messages.length > 0) {
      const lastMsgId = sessionData.messages[sessionData.messages.length - 1].id;
      const parsedId = parseInt(lastMsgId, 10);
      if (!isNaN(parsedId)) {
        messageSequence = parsedId + 1;
      }
    }
    console.log(`[agent] switchToSession: loaded ${sessionData.messages.length} existing messages`);
  }

  // Set SDK session ID for resume (if available)
  if (sessionMeta.sdkSessionId) {
    resumeSessionId = sessionMeta.sdkSessionId;
    console.log(`[agent] switchToSession: will resume SDK session ${resumeSessionId}`);
  } else {
    // No SDK session_id means this is an old session without resume support
    // The conversation will start fresh, but messages will be saved to the same session
    resumeSessionId = undefined;
    console.warn(`[agent] switchToSession: no SDK session_id available (old session), will start fresh conversation`);
  }

  // Update agentDir from session
  if (sessionMeta.agentDir) {
    agentDir = sessionMeta.agentDir;
  }

  // Initialize logger for the target session (lazy file creation)
  initLogger(sessionId);

  // Session already exists, skip first-message session creation logic
  hasInitialPrompt = true;

  console.log(`[agent] switchToSession: ready, agentDir=${agentDir}, hasResume=${!!resumeSessionId}`);
  return true;
}

type ImagePayload = {
  name: string;
  mimeType: string;
  data: string; // base64
};

/**
 * Apply runtime configuration changes to the active session.
 * Calls SDK setModel/setPermissionMode if config has changed.
 */
async function applySessionConfig(newModel?: string, newPermissionMode?: PermissionMode): Promise<void> {
  if (!querySession) {
    return;
  }

  // Apply permission mode change if different
  if (newPermissionMode && newPermissionMode !== currentPermissionMode) {
    const sdkMode = mapToSdkPermissionMode(newPermissionMode);
    try {
      await querySession.setPermissionMode(sdkMode);
      currentPermissionMode = newPermissionMode;
      console.log(`[agent] runtime permission mode switched to: ${newPermissionMode} (SDK: ${sdkMode})`);
    } catch (error) {
      console.error('[agent] failed to set permission mode:', error);
    }
  }

  // Apply model change if different
  if (newModel && newModel !== currentModel) {
    try {
      await querySession.setModel(newModel);
      currentModel = newModel;
      console.log(`[agent] runtime model switched to: ${newModel}`);
    } catch (error) {
      console.error('[agent] failed to set model:', error);
    }
  }
}

export async function enqueueUserMessage(
  text: string,
  images?: ImagePayload[],
  permissionMode?: PermissionMode,
  model?: string,
  providerEnv?: ProviderEnv
): Promise<void> {
  const trimmed = text.trim();
  const hasImages = images && images.length > 0;

  if (!trimmed && !hasImages) {
    return;
  }

  // Reset turn usage tracking for this new user message
  resetTurnUsage();
  currentTurnStartTime = Date.now();

  // Check if provider has changed (requires session restart since environment vars can't be updated)
  // Also detect switching TO subscription (providerEnv=undefined) FROM an API provider
  const switchingToSubscription = !providerEnv && currentProviderEnv;
  const baseUrlChanged = switchingToSubscription ||
    (providerEnv && providerEnv.baseUrl !== currentProviderEnv?.baseUrl);
  const providerChanged = baseUrlChanged || (providerEnv && (
    providerEnv.apiKey !== currentProviderEnv?.apiKey
  ));

  if (providerChanged && querySession) {
    const fromLabel = currentProviderEnv?.baseUrl ?? 'anthropic';
    const toLabel = providerEnv?.baseUrl ?? 'anthropic';
    if (isDebugMode) console.log(`[agent] provider changed from ${fromLabel} to ${toLabel}, restarting session`);

    // Resume logic: Anthropic official validates thinking block signatures, third-party providers don't.
    // Only skip resume when switching FROM third-party (has baseUrl) TO Anthropic official (no baseUrl).
    // All other transitions (official→third-party, third-party→third-party, official→official) can safely resume.
    const switchingFromThirdPartyToAnthropic = currentProviderEnv?.baseUrl && !providerEnv?.baseUrl;
    if (switchingFromThirdPartyToAnthropic || !systemInitInfo?.session_id) {
      resumeSessionId = undefined;
      console.log(`[agent] Starting fresh session (no resume): ${switchingFromThirdPartyToAnthropic ? 'third-party → Anthropic official (signature incompatible)' : 'no existing session to resume'}`);
    } else {
      resumeSessionId = systemInitInfo.session_id;
      if (isDebugMode) console.log(`[agent] Will resume from SDK session: ${resumeSessionId}`);
    }

    // Update provider env BEFORE terminating so the new session picks it up
    currentProviderEnv = providerEnv; // undefined for subscription, object for API
    // Terminate current session - it will restart automatically when processing the message
    shouldAbortSession = true;
    // Wait for the current session to fully terminate before proceeding
    // This prevents race conditions where old session continues processing
    if (sessionTerminationPromise) {
      await sessionTerminationPromise;
    }
    querySession = null;
    isProcessing = false;
    setSessionState('idle');
    // Clear message queue to avoid duplicate messages
    // The current message will be added to the queue below
    messageQueue.length = 0;
    // Clear stream state mappings (will be rebuilt by new session)
    streamIndexToToolId.clear();
    toolResultIndexToId.clear();
    if (isDebugMode) console.log(`[agent] session terminated for provider switch`);
  } else if (providerEnv) {
    // Provider not changed (or first message with API provider), just update tracking
    currentProviderEnv = providerEnv;
    if (isDebugMode) console.log(`[agent] provider env set: baseUrl=${providerEnv.baseUrl ?? 'anthropic'}`);
  } else if (!providerEnv && !currentProviderEnv) {
    // Both undefined — subscription mode, no change needed
    if (isDebugMode) console.log('[agent] subscription mode, no provider env');
  }

  // Apply runtime config changes if session is active (model/permission changes don't require restart)
  await applySessionConfig(model, permissionMode);

  // Update local tracking even if SDK call is skipped (first message)
  if (permissionMode && permissionMode !== currentPermissionMode) {
    currentPermissionMode = permissionMode;
    if (isDebugMode) console.log(`[agent] permission mode set to: ${permissionMode}`);
  }
  if (model && model !== currentModel) {
    currentModel = model;
    if (isDebugMode) console.log(`[agent] model set to: ${model}`);
  }

  // Persist session to SessionStore on first message
  const isFirstMessage = !hasInitialPrompt;
  if (!hasInitialPrompt) {
    hasInitialPrompt = true;
    // Create and save session metadata
    const sessionMeta = createSessionMetadata(agentDir);
    sessionMeta.id = sessionId; // Use existing sessionId
    sessionMeta.title = trimmed ? trimmed.slice(0, 40) : '图片消息';
    if (sessionMeta.title.length < trimmed.length) {
      sessionMeta.title += '...';
    }
    saveSessionMetadata(sessionMeta);
    console.log(`[agent] session ${sessionId} persisted to SessionStore`);
  } else {
    // Update session title from first real message if needed
    if (trimmed && messages.length === 0) {
      updateSessionTitleFromMessage(sessionId, trimmed);
    }
  }

  console.log(`[agent] enqueue user message len=${trimmed.length} images=${images?.length ?? 0} mode=${currentPermissionMode}`);
  setSessionState('running');

  // Save images to disk and create attachment records
  const savedAttachments: MessageWire['attachments'] = [];
  if (hasImages) {
    for (const img of images) {
      try {
        const attachmentId = randomUUID();
        const relativePath = saveAttachment(sessionId, attachmentId, img.name, img.data, img.mimeType);
        savedAttachments.push({
          id: attachmentId,
          name: img.name,
          size: img.data.length, // Approximate size from base64
          mimeType: img.mimeType,
          relativePath,
          isImage: true,
        });
      } catch (error) {
        console.error('[agent] Failed to save attachment:', error);
      }
    }
  }

  const userMessage: MessageWire = {
    id: String(messageSequence++),
    role: 'user',
    content: trimmed,
    timestamp: new Date().toISOString(),
    attachments: savedAttachments.length > 0 ? savedAttachments : undefined,
  };
  messages.push(userMessage);
  broadcast('chat:message-replay', { message: userMessage });

  // Persist messages to disk after adding user message
  persistMessagesToStorage();

  if (!isSessionActive()) {
    console.log('[agent] starting session (idle -> running)');
    startStreamingSession().catch((error) => {
      console.error('[agent] failed to start session', error);
    });
  }

  // Build multimodal content array for Claude API
  // Images are sent as base64-encoded source blocks
  const contentBlocks: Array<
    | { type: 'text'; text: string }
    | { type: 'image'; source: { type: 'base64'; media_type: string; data: string } }
  > = [];

  // Add images first so Claude can see them before the text query
  if (hasImages) {
    for (const img of images) {
      contentBlocks.push({
        type: 'image',
        source: {
          type: 'base64',
          media_type: img.mimeType,
          data: img.data,
        },
      });
    }
  }

  // Add text content if present
  if (trimmed) {
    contentBlocks.push({ type: 'text', text: trimmed });
  }

  // Push to message queue and WAIT for it to be processed
  // This await is CRITICAL - it ensures startStreamingSession() has time to 
  // complete SDK initialization before messageGenerator yields the message
  // Without this, the message gets yielded before ProcessTransport is ready
  await new Promise<void>((resolve) => {
    messageQueue.push({
      message: {
        role: 'user',
        content: contentBlocks
      },
      resolve  // Called by messageGenerator after yield
    });
  });
}

export function isSessionActive(): boolean {
  return isProcessing || querySession !== null;
}

export async function interruptCurrentResponse(): Promise<boolean> {
  if (!querySession) {
    // 即使没有 querySession，如果 isStreamingMessage 为 true，也需要重置状态
    if (isStreamingMessage) {
      console.log('[agent] No querySession but streaming flag set, resetting state');
      broadcast('chat:message-stopped', null);
      handleMessageStopped();
      return true;
    }
    return false;
  }

  if (isInterruptingResponse) {
    return true;
  }

  isInterruptingResponse = true;
  try {
    // 使用 Promise.race 添加 10 秒超时
    const interruptPromise = querySession.interrupt();
    const timeoutPromise = new Promise<void>((_, reject) => {
      setTimeout(() => reject(new Error('Interrupt timeout')), 10000);
    });

    try {
      await Promise.race([interruptPromise, timeoutPromise]);
    } catch (error) {
      console.error('[agent] Interrupt error or timeout:', error);
      // 超时或出错时也要清理状态，避免 UI 卡住
    }

    broadcast('chat:message-stopped', null);
    handleMessageStopped();
    return true;
  } finally {
    isInterruptingResponse = false;
  }
}

async function startStreamingSession(): Promise<void> {
  if (sessionTerminationPromise) {
    await sessionTerminationPromise;
  }

  if (isProcessing || querySession) {
    return;
  }

  const env = buildClaudeSessionEnv();
  console.log(`[agent] start session cwd=${agentDir}`);
  shouldAbortSession = false;
  resetAbortFlag();
  isProcessing = true;
  streamIndexToToolId.clear();
  setSessionState('running');

  let resolveTermination: () => void;
  sessionTerminationPromise = new Promise((resolve) => {
    resolveTermination = resolve;
  });

  try {
    const sdkPermissionMode = mapToSdkPermissionMode(currentPermissionMode);
    const resumeFrom = resumeSessionId;
    resumeSessionId = undefined; // Clear after use

    const mcpStatus = currentMcpServers === null ? 'auto' : currentMcpServers.length === 0 ? 'disabled' : `enabled(${currentMcpServers.length})`;
    console.log(`[agent] starting query with model: ${currentModel ?? 'default'}, permissionMode: ${currentPermissionMode} -> SDK: ${sdkPermissionMode}, MCP: ${mcpStatus}${resumeFrom ? `, resume: ${resumeFrom}` : ''}`);

    querySession = query({
      prompt: messageGenerator(),
      options: {
        resume: resumeFrom, // Resume from previous SDK session if set
        maxThinkingTokens: 32_000,
        // Only use project-level settings from .claude/ directory
        // We don't use 'user' (~/.claude/) because our config is in ~/.myagents/
        // MCP is explicitly configured via mcpServers, not SDK auto-discovery
        settingSources: buildSettingSources(),
        // Permission mode mapping:
        // - fullAgency → bypassPermissions (no confirmation needed)
        // - other modes → default (enables canUseTool callback for user confirmation)
        permissionMode: currentPermissionMode === 'fullAgency' ? 'bypassPermissions' : 'default',
        // Only needed when using bypassPermissions
        ...(currentPermissionMode === 'fullAgency' ? { allowDangerouslySkipPermissions: true } : {}),
        model: currentModel, // Use currently selected model
        pathToClaudeCodeExecutable: resolveClaudeCodeCli(),
        executable: 'bun',
        env,
        stderr: (message: string) => {
          if (process.env.DEBUG === '1') {
            broadcast('chat:debug-message', message);
          }
        },
        systemPrompt: {
          type: 'preset',
          preset: 'claude_code'
        },
        cwd: agentDir,
        includePartialMessages: true,
        mcpServers: buildSdkMcpServers(),
        // Custom permission handling - check rules and prompt user for unknown tools
        // Only effective when permissionMode is 'default'
        canUseTool: async (toolName, input, options) => {
          console.debug(`[permission] canUseTool checking: ${toolName}`);

          // First check MCP tool permission based on user's enabled MCP servers
          const mcpCheck = checkMcpToolPermission(toolName);
          if (!mcpCheck.allowed) {
            if (isDebugMode) console.log(`[permission] MCP tool blocked: ${toolName} - ${mcpCheck.reason}`);
            return {
              behavior: 'deny' as const,
              message: mcpCheck.reason
            };
          }

          // Special handling for AskUserQuestion - always requires user interaction
          if (toolName === 'AskUserQuestion') {
            console.log('[canUseTool] AskUserQuestion detected, prompting user');
            const answers = await handleAskUserQuestion(input, options.signal);
            if (answers === null) {
              return {
                behavior: 'deny' as const,
                message: '用户取消了问答'
              };
            }
            // Return with answers filled in
            const inputWithAnswers = input as Record<string, unknown>;
            return {
              behavior: 'allow' as const,
              updatedInput: { ...inputWithAnswers, answers }
            };
          }

          const decision = await checkToolPermission(
            toolName,
            input,
            currentPermissionMode,
            options.signal
          );
          console.debug(`[permission] canUseTool result for ${toolName}: ${decision}`);
          if (decision === 'allow') {
            // Must include updatedInput for SDK to properly process the tool call
            return {
              behavior: 'allow' as const,
              updatedInput: input as Record<string, unknown>
            };
          } else {
            return {
              behavior: 'deny' as const,
              message: '用户拒绝了此工具的使用权限'
            };
          }
        },
      }
    });

    console.log('[agent] session started');
    console.log('[agent] starting for-await loop on querySession');

    let messageCount = 0;

    for await (const sdkMessage of querySession) {
      messageCount++;
      console.log(`[agent][sdk] message #${messageCount} type=${sdkMessage.type}`);
      try {
        const line = `${new Date().toISOString()} ${JSON.stringify(sdkMessage)}`;
        console.log('[agent][sdk]', JSON.stringify(sdkMessage));
        appendLogLine(line);
      } catch (error) {
        console.log('[agent][sdk] (unserializable)', error);
      }
      const nextSystemInit = parseSystemInitInfo(sdkMessage);
      if (nextSystemInit) {
        systemInitInfo = nextSystemInit;
        broadcast('chat:system-init', { info: systemInitInfo });

        // Save SDK session_id for future resume functionality
        if (nextSystemInit.session_id) {
          updateSessionMetadata(sessionId, { sdkSessionId: nextSystemInit.session_id });
          console.log(`[agent] SDK session_id saved: ${nextSystemInit.session_id}`);
        }
      }

      // Handle system status (e.g., compacting)
      const statusResult = parseSystemStatus(sdkMessage);
      if (statusResult.isStatusMessage) {
        console.log(`[agent] System status: ${statusResult.status}`);
        broadcast('chat:system-status', { status: statusResult.status });
      }

      const agentError = extractAgentError(sdkMessage);
      if (agentError) {
        broadcast('chat:agent-error', { message: agentError });
      }
      if (shouldAbortSession) {
        break;
      }

      if (sdkMessage.type === 'stream_event') {
        const streamEvent = sdkMessage.event;
        if (streamEvent.type === 'content_block_delta') {
          if (streamEvent.delta.type === 'text_delta') {
            if (sdkMessage.parent_tool_use_id) {
              const parentToolUseId = childToolToParent.get(sdkMessage.parent_tool_use_id) ?? null;
              if (parentToolUseId) {
                broadcast('chat:subagent-tool-result-delta', {
                  parentToolUseId,
                  toolUseId: sdkMessage.parent_tool_use_id,
                  delta: streamEvent.delta.text
                });
              } else {
                broadcast('chat:tool-result-delta', {
                  toolUseId: sdkMessage.parent_tool_use_id,
                  delta: streamEvent.delta.text
                });
              }
              appendToolResultDelta(sdkMessage.parent_tool_use_id, streamEvent.delta.text);
            } else {
              // Skip empty chunks (null, undefined, '')
              if (!streamEvent.delta.text) {
                console.log('[agent] Skipping empty chunk');
              } else {
                // Filter out decorative text from third-party APIs before broadcasting
                const decorativeCheck = checkDecorativeToolText(streamEvent.delta.text);
                if (!decorativeCheck.filtered) {
                  broadcast('chat:message-chunk', streamEvent.delta.text);
                  appendTextChunk(streamEvent.delta.text);
                } else {
                  console.log(`[agent] Filtered decorative text from stream (${decorativeCheck.reason})`);
                }
              }
            }
          } else if (streamEvent.delta.type === 'thinking_delta') {
            broadcast('chat:thinking-chunk', {
              index: streamEvent.index,
              delta: streamEvent.delta.thinking
            });
            handleThinkingChunk(streamEvent.index, streamEvent.delta.thinking);
          } else if (streamEvent.delta.type === 'input_json_delta') {
            const toolId = streamIndexToToolId.get(streamEvent.index) ?? '';
            if (sdkMessage.parent_tool_use_id) {
              broadcast('chat:subagent-tool-input-delta', {
                parentToolUseId: sdkMessage.parent_tool_use_id,
                toolId,
                delta: streamEvent.delta.partial_json
              });
              handleSubagentToolInputDelta(
                sdkMessage.parent_tool_use_id,
                toolId,
                streamEvent.delta.partial_json
              );
            } else {
              broadcast('chat:tool-input-delta', {
                index: streamEvent.index,
                toolId,
                delta: streamEvent.delta.partial_json
              });
              handleToolInputDelta(streamEvent.index, toolId, streamEvent.delta.partial_json);
            }
          }
        } else if (streamEvent.type === 'content_block_start') {
          if (streamEvent.content_block.type === 'thinking') {
            broadcast('chat:thinking-start', { index: streamEvent.index });
            handleThinkingStart(streamEvent.index);
          } else if (streamEvent.content_block.type === 'tool_use') {
            streamIndexToToolId.set(streamEvent.index, streamEvent.content_block.id);
            const toolPayload = {
              id: streamEvent.content_block.id,
              name: streamEvent.content_block.name,
              input: streamEvent.content_block.input || {},
              streamIndex: streamEvent.index
            };
            if (sdkMessage.parent_tool_use_id) {
              broadcast('chat:subagent-tool-use', {
                parentToolUseId: sdkMessage.parent_tool_use_id,
                tool: toolPayload
              });
              handleSubagentToolUseStart(sdkMessage.parent_tool_use_id, toolPayload);
            } else {
              broadcast('chat:tool-use-start', toolPayload);
              handleToolUseStart(toolPayload);
            }
          } else if (streamEvent.content_block.type === 'server_tool_use') {
            // Server-side tool use (e.g., 智谱 GLM-4.7's webReader, analyze_image)
            // These are executed by the API provider, not locally
            const serverToolBlock = streamEvent.content_block as {
              type: 'server_tool_use';
              id: string;
              name: string;
              input: Record<string, unknown> | string; // Some APIs return input as JSON string
            };
            streamIndexToToolId.set(streamEvent.index, serverToolBlock.id);

            // Parse input if it's a JSON string (智谱 GLM-4.7 returns input as string)
            let parsedInput: Record<string, unknown> = {};
            if (typeof serverToolBlock.input === 'string') {
              try {
                parsedInput = JSON.parse(serverToolBlock.input);
              } catch {
                // If parsing fails, wrap the string as-is
                parsedInput = { raw: serverToolBlock.input };
              }
            } else {
              parsedInput = serverToolBlock.input || {};
            }

            const toolPayload = {
              id: serverToolBlock.id,
              name: serverToolBlock.name,
              input: parsedInput,
              streamIndex: streamEvent.index
            };
            // Server tools are always top-level (no subagent concept)
            broadcast('chat:server-tool-use-start', toolPayload);
            handleServerToolUseStart(toolPayload);
          } else if (
            (streamEvent.content_block.type === 'web_search_tool_result' ||
              streamEvent.content_block.type === 'web_fetch_tool_result' ||
              streamEvent.content_block.type === 'code_execution_tool_result' ||
              streamEvent.content_block.type === 'bash_code_execution_tool_result' ||
              streamEvent.content_block.type === 'text_editor_code_execution_tool_result' ||
              streamEvent.content_block.type === 'mcp_tool_result' ||
              streamEvent.content_block.type === 'tool_result') &&
            'tool_use_id' in streamEvent.content_block
          ) {
            const toolResultBlock = streamEvent.content_block as {
              tool_use_id: string;
              content?: string | unknown;
              is_error?: boolean;
            };

            let contentStr = '';
            if (typeof toolResultBlock.content === 'string') {
              contentStr = toolResultBlock.content;
            } else if (toolResultBlock.content !== null && toolResultBlock.content !== undefined) {
              contentStr = JSON.stringify(toolResultBlock.content, null, 2);
            }

            toolResultIndexToId.set(streamEvent.index, toolResultBlock.tool_use_id);
            if (contentStr) {
              const parentToolUseId =
                childToolToParent.get(toolResultBlock.tool_use_id) ?? sdkMessage.parent_tool_use_id;
              if (parentToolUseId) {
                if (!childToolToParent.has(toolResultBlock.tool_use_id)) {
                  ensureSubagentToolPlaceholder(parentToolUseId, toolResultBlock.tool_use_id);
                }
                broadcast('chat:subagent-tool-result-start', {
                  parentToolUseId,
                  toolUseId: toolResultBlock.tool_use_id,
                  content: contentStr,
                  isError: toolResultBlock.is_error || false
                });
              } else {
                broadcast('chat:tool-result-start', {
                  toolUseId: toolResultBlock.tool_use_id,
                  content: contentStr,
                  isError: toolResultBlock.is_error || false
                });
              }
              handleToolResultStart(
                toolResultBlock.tool_use_id,
                contentStr,
                toolResultBlock.is_error || false
              );
            }
          }
        } else if (streamEvent.type === 'content_block_stop') {
          const toolId = streamIndexToToolId.get(streamEvent.index);
          if (sdkMessage.parent_tool_use_id) {
            if (toolId) {
              finalizeSubagentToolInput(sdkMessage.parent_tool_use_id, toolId);
            }
            const toolResultId = toolResultIndexToId.get(streamEvent.index);
            if (toolResultId) {
              toolResultIndexToId.delete(streamEvent.index);
              if (finalizeSubagentToolResult(toolResultId)) {
                const result = getSubagentToolResult(toolResultId) ?? '';
                const parentToolUseId = childToolToParent.get(toolResultId);
                if (parentToolUseId) {
                  broadcast('chat:subagent-tool-result-complete', {
                    parentToolUseId,
                    toolUseId: toolResultId,
                    content: result
                  });
                }
              }
            }
          } else {
            broadcast('chat:content-block-stop', {
              index: streamEvent.index,
              toolId: toolId || undefined
            });
            handleContentBlockStop(streamEvent.index, toolId || undefined);
          }
        }
      } else if (sdkMessage.type === 'user') {
        // Process tool_result blocks from user messages
        // This handles both subagent results (parent_tool_use_id set) and top-level tool results (parent_tool_use_id null)
        if (sdkMessage.message?.content) {
          const messageContent = sdkMessage.message.content;

          // Handle local command output (e.g., /cost, /context commands)
          // SDK sends these as user messages with string content wrapped in <local-command-stdout> tags
          if (typeof messageContent === 'string' && messageContent.includes('<local-command-stdout>')) {
            const localCommandMessage: MessageWire = {
              id: String(messageSequence++),
              role: 'user',
              content: messageContent,
              timestamp: new Date().toISOString(),
            };
            messages.push(localCommandMessage);
            broadcast('chat:message-replay', { message: localCommandMessage });
            persistMessagesToStorage();
          }

          // Check for structured tool_use_result data (e.g., WebSearch results)
          const toolUseResultData = (sdkMessage as { tool_use_result?: unknown }).tool_use_result;

          // Only iterate if content is an array (tool_result blocks)
          if (Array.isArray(messageContent)) {
            for (const block of messageContent) {
            if (
              typeof block === 'object' &&
              block !== null &&
              'type' in block &&
              block.type === 'tool_result' &&
              'tool_use_id' in block
            ) {
              const toolResultBlock = block as {
                tool_use_id: string;
                content: string | unknown;
              };

              // For WebSearch/WebFetch, prefer structured tool_use_result data if available
              // This contains query, results array with titles/urls, etc.
              let contentStr: string;
              if (toolUseResultData && typeof toolUseResultData === 'object') {
                contentStr = JSON.stringify(toolUseResultData);
              } else if (typeof toolResultBlock.content === 'string') {
                contentStr = toolResultBlock.content;
              } else {
                contentStr = JSON.stringify(toolResultBlock.content ?? '', null, 2);
              }

              const parentToolUseId =
                childToolToParent.get(toolResultBlock.tool_use_id) ?? sdkMessage.parent_tool_use_id;
              if (parentToolUseId) {
                if (!childToolToParent.has(toolResultBlock.tool_use_id)) {
                  ensureSubagentToolPlaceholder(parentToolUseId, toolResultBlock.tool_use_id);
                }
                broadcast('chat:subagent-tool-result-complete', {
                  parentToolUseId,
                  toolUseId: toolResultBlock.tool_use_id,
                  content: contentStr
                });
              } else {
                // Top-level tool result (e.g., WebSearch without parent)
                broadcast('chat:tool-result-complete', {
                  toolUseId: toolResultBlock.tool_use_id,
                  content: contentStr
                });
              }
              handleToolResultComplete(toolResultBlock.tool_use_id, contentStr);
            }
          }
          }
        }
      } else if (sdkMessage.type === 'assistant') {
        const assistantMessage = sdkMessage.message;
        // Extract usage info for stats tracking
        const usage = (assistantMessage as {
          usage?: {
            input_tokens?: number;
            output_tokens?: number;
            cache_read_input_tokens?: number;
            cache_creation_input_tokens?: number;
          };
          model?: string;
        }).usage;
        const model = (assistantMessage as { model?: string }).model;

        // Accumulate usage for this turn (only for top-level assistant messages)
        if (usage && !sdkMessage.parent_tool_use_id) {
          currentTurnUsage.inputTokens += usage.input_tokens ?? 0;
          currentTurnUsage.outputTokens += usage.output_tokens ?? 0;
          currentTurnUsage.cacheReadTokens += usage.cache_read_input_tokens ?? 0;
          currentTurnUsage.cacheCreationTokens += usage.cache_creation_input_tokens ?? 0;
          if (model) {
            currentTurnUsage.model = model;
          }
        }
        if (sdkMessage.parent_tool_use_id && assistantMessage.content) {
          for (const block of assistantMessage.content) {
            if (
              typeof block === 'object' &&
              block !== null &&
              'type' in block &&
              block.type === 'tool_use' &&
              'id' in block &&
              'name' in block
            ) {
              const toolBlock = block as {
                id: string;
                name: string;
                input?: Record<string, unknown>;
              };
              const payload = {
                id: toolBlock.id,
                name: toolBlock.name,
                input: toolBlock.input || {}
              };
              broadcast('chat:subagent-tool-use', {
                parentToolUseId: sdkMessage.parent_tool_use_id,
                tool: payload,
                usage: usage ? { input_tokens: usage.input_tokens, output_tokens: usage.output_tokens } : undefined
              });
              handleSubagentToolUseStart(sdkMessage.parent_tool_use_id, payload);
            }
          }
        }
        if (sdkMessage.parent_tool_use_id) {
          const text = formatAssistantContent(assistantMessage.content);
          if (text) {
            const next = appendToolResultContent(sdkMessage.parent_tool_use_id, text);
            broadcast('chat:tool-result-complete', {
              toolUseId: sdkMessage.parent_tool_use_id,
              content: next
            });
          }
        }
        if (assistantMessage.content) {
          for (const block of assistantMessage.content) {
            if (
              typeof block === 'object' &&
              block !== null &&
              'tool_use_id' in block &&
              'content' in block
            ) {
              const toolResultBlock = block as {
                tool_use_id: string;
                content: string | unknown[] | unknown;
                is_error?: boolean;
              };

              let contentStr: string;
              if (typeof toolResultBlock.content === 'string') {
                contentStr = toolResultBlock.content;
              } else if (Array.isArray(toolResultBlock.content)) {
                contentStr = toolResultBlock.content
                  .map((c) => {
                    if (typeof c === 'string') {
                      return c;
                    }
                    if (typeof c === 'object' && c !== null) {
                      if ('text' in c && typeof c.text === 'string') {
                        return c.text;
                      }
                      if ('type' in c && c.type === 'text' && 'text' in c) {
                        return String(c.text);
                      }
                      return JSON.stringify(c, null, 2);
                    }
                    return String(c);
                  })
                  .join('\n');
              } else if (typeof toolResultBlock.content === 'object' && toolResultBlock.content) {
                contentStr = JSON.stringify(toolResultBlock.content, null, 2);
              } else {
                contentStr = String(toolResultBlock.content);
              }

              const parentToolUseId =
                childToolToParent.get(toolResultBlock.tool_use_id) ?? sdkMessage.parent_tool_use_id;
              if (parentToolUseId) {
                if (!childToolToParent.has(toolResultBlock.tool_use_id)) {
                  ensureSubagentToolPlaceholder(parentToolUseId, toolResultBlock.tool_use_id);
                }
                broadcast('chat:subagent-tool-result-complete', {
                  parentToolUseId,
                  toolUseId: toolResultBlock.tool_use_id,
                  content: contentStr,
                  isError: toolResultBlock.is_error || false
                });
              } else {
                broadcast('chat:tool-result-complete', {
                  toolUseId: toolResultBlock.tool_use_id,
                  content: contentStr,
                  isError: toolResultBlock.is_error || false
                });
              }
              handleToolResultComplete(
                toolResultBlock.tool_use_id,
                contentStr,
                toolResultBlock.is_error || false
              );
            }
          }
        }
      } else if (sdkMessage.type === 'result') {
        console.log('[agent][sdk] Broadcasting chat:message-complete');
        broadcast('chat:message-complete', null);
        handleMessageComplete();
      }
    }
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : 'Unknown error occurred';
    const errorStack = error instanceof Error ? error.stack : String(error);
    console.error('[agent] session error:', errorMessage);
    console.error('[agent] session error stack:', errorStack);
    broadcast('chat:message-error', errorMessage);
    handleMessageError(errorMessage);
    setSessionState('error');
  } finally {
    isProcessing = false;
    querySession = null;
    if (sessionState !== 'error') {
      setSessionState('idle');
    }
    resolveTermination!();
  }
}

async function* messageGenerator(): AsyncGenerator<SDKUserMessage> {
  console.log('[messageGenerator] Started');

  while (true) {
    if (shouldAbortSession) {
      console.log('[messageGenerator] Abort flag set, returning');
      return;
    }

    // Wait for message in queue
    await new Promise<void>((resolve) => {
      const checkQueue = () => {
        if (shouldAbortSession) {
          resolve();
          return;
        }

        if (messageQueue.length > 0) {
          resolve();
        } else {
          setTimeout(checkQueue, 100);
        }
      };
      checkQueue();
    });

    if (shouldAbortSession) {
      console.log('[messageGenerator] Abort flag set after wait, returning');
      return;
    }

    const item = messageQueue.shift();
    if (item) {
      yield {
        type: 'user' as const,
        message: item.message,
        parent_tool_use_id: null,
        session_id: getSessionId()
      };
      item.resolve();
    }
  }
}

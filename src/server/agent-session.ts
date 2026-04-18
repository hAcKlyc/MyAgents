import { randomUUID } from 'crypto';
import { existsSync, mkdirSync, readdirSync, symlinkSync, lstatSync, readFileSync, readlinkSync, rmSync } from 'fs';
import { dirname, join, resolve, sep } from 'path';
import { createRequire } from 'module';
import { query, getSessionMessages as sdkGetSessionMessages, type Query, type SDKUserMessage, type AgentDefinition, type HookInput, type HookJSONOutput, type PostToolUseHookInput } from '@anthropic-ai/claude-agent-sdk';
import { getScriptDir, getBundledBunDir, getBundledNodeDir, getAgentBrowserCliPath, getSystemNodeDirs } from './utils/runtime';
import { getCrossPlatformEnv, isSkillBlockedOnPlatform } from './utils/platform';
import { processImage, resizeToolImageContent } from './utils/imageResize';
import { cronToolsServer, getCronTaskContext, clearCronTaskContext } from './tools/cron-tools';
import { imCronToolServer, getImCronContext, setSessionCronContext, clearSessionCronContext } from './tools/im-cron-tool';
import { imMediaToolServer, getImMediaContext } from './tools/im-media-tool';
import { getImBridgeToolsContext, getImBridgeToolServer } from './tools/im-bridge-tools';
import { getBuiltinMcp } from './tools/builtin-mcp-registry';
import { startSocksBridge, stopSocksBridge, isSocksBridgeRunning } from './utils/socks-bridge';
import { startFileWatcher } from './file-watcher';
import { resolveAuthHeaders, onTokenChange, startTokenRefreshScheduler } from './mcp-oauth';
// Side-effect imports: each registers itself in the builtin MCP registry
import './tools/gemini-image-tool';
import './tools/edge-tts-tool';
import { generativeUiServer } from './tools/generative-ui-tool';

import type { ToolInput } from '../renderer/types/chat';
import { parsePartialJson } from '../shared/parsePartialJson';
import type { SystemInitInfo } from '../shared/types/system';
import { saveSessionMetadata, updateSessionTitleFromMessage, saveSessionMessages, saveAttachment, updateSessionMetadata, getSessionMetadata, getSessionData } from './SessionStore';
import { createSessionMetadata, type SessionMessage, type MessageAttachment, type MessageUsage, type SessionSource } from './types/session';
import { broadcast } from './sse';
import { seedBridgeThoughtSignatures } from './bridge-cache';
import { initLogger, appendLog, getLogLines as getLogLinesFromLogger } from './AgentLogger';
import { localTimestamp } from '../shared/logTime';
import { trackServer } from './analytics';
import { getCurrentRuntimeType, isExternalRuntime } from './runtimes/factory';
import type { ImagePayload } from './runtimes/types';

// Module-level debug mode check (avoids repeated environment variable access)
const isDebugMode = process.env.DEBUG === '1' || process.env.NODE_ENV === 'development';

// Shared NO_PROXY value — comprehensive list of localhost addresses to bypass proxy
const PROXY_NO_PROXY_VAL = 'localhost,localhost.localdomain,127.0.0.1,127.0.0.0/8,::1,[::1]';

/**
 * Claude Agent SDK reserved MCP server names — using these causes the SDK to
 * crash with exit code 1: "Invalid MCP configuration: X is a reserved MCP name."
 * Source: claude-code/src/main.tsx (isClaudeInChromeMCPServer, isComputerUseMCPServer)
 */
export const SDK_RESERVED_MCP_NAMES = ['claude-in-chrome', 'computer-use'];

// ===== Inherited Proxy Env Snapshot =====
// Capture system proxy state at sidecar startup (before any setProxyConfig call).
// When Rust spawns this sidecar WITHOUT explicit proxy config, the process inherits
// system proxy env vars (e.g., from Clash TUN/global proxy). We snapshot them so
// setProxyConfig(disabled) can restore the inherited state instead of force-clearing.
const PROXY_VARS_LIST = ['HTTP_PROXY', 'HTTPS_PROXY', 'http_proxy', 'https_proxy',
                         'ALL_PROXY', 'all_proxy', 'NO_PROXY', 'no_proxy'] as const;
const proxyWasInjectedByRust = process.env.MYAGENTS_PROXY_INJECTED === '1';
delete process.env.MYAGENTS_PROXY_INJECTED; // Don't leak to SDK subprocess

// Only capture system state when NOT explicitly injected by Rust
const inheritedProxySnapshot: Record<string, string | undefined> = {};
if (!proxyWasInjectedByRust) {
  for (const v of PROXY_VARS_LIST) {
    inheritedProxySnapshot[v] = process.env[v];
  }
}

// ===== OAuth Token Change Listener =====
// Register once at module load. Token changes trigger session restart
// so buildSdkMcpServers() picks up the new/refreshed Authorization headers.
onTokenChange((serverId, event) => {
  if (!currentMcpServers?.some(s => s.id === serverId)) return;

  if (event === 'acquired' || event === 'refreshed') {
    console.log(`[agent] OAuth token ${event} for MCP ${serverId}, deferring restart to pre-warm debounce`);
    if (querySession) scheduleDeferredRestart('oauth');
    preWarmFailCount = 0;
    if (!isProcessing || isPreWarming) {
      schedulePreWarm();
    }
  }

  if (event === 'expired' || event === 'revoked') {
    broadcast('mcp:oauth-expired', { serverId });
  }
});

// Start background token refresh scheduler (checks every 60s, proactive refresh)
startTokenRefreshScheduler();

// Max length for individual string values in SDK message logs.
// Base64 images can be several MB; truncate to keep logs readable.
const LOG_STRING_MAX_LEN = 500;

/** JSON.stringify with long string truncation (e.g. base64 image data) for logging. */
function logStringify(obj: unknown, maxLen = LOG_STRING_MAX_LEN): string {
  try {
    return JSON.stringify(obj, (_key, value) => {
      if (typeof value === 'string' && value.length > maxLen) {
        return value.slice(0, maxLen) + `...(${value.length} chars)`;
      }
      return value;
    });
  } catch {
    return '[unserializable]';
  }
}

// Decorative text filter thresholds (for third-party API wrappers like 智谱 GLM-4.7)
// Decorative blocks are typically 100-2000 chars; we use wider range for safety margin
const DECORATIVE_TEXT_MIN_LENGTH = 50;
const DECORATIVE_TEXT_MAX_LENGTH = 5000;

// ===== Product Directory Configuration =====
// Our product (MyAgents) uses ~/.myagents/ for user configuration
// This is SEPARATE from Claude CLI's ~/.claude/ directory
// Only subscription-related features may access ~/.claude/ (handled by SDK internally)
//
// IMPORTANT: Do NOT set CLAUDE_CONFIG_DIR in the SDK subprocess environment.
// The SDK derives Keychain service names from CLAUDE_CONFIG_DIR — setting it would
// break Anthropic subscription OAuth (Keychain entry "Claude Code-credentials" won't be found).
// Instead, user-level skills are synced as symlinks into each project's .claude/skills/.
const MYAGENTS_USER_DIR = '.myagents';

/**
 * Get the MyAgents user directory path
 * All user configs (MCP, providers, projects, etc.) are stored here
 */
export function getMyAgentsUserDir(): string {
  const { home, temp } = getCrossPlatformEnv();
  // Fallback to temp directory if home is not available (extremely rare)
  // temp is now guaranteed to have a valid platform-specific fallback
  const homeDir = home || temp;
  return join(homeDir, MYAGENTS_USER_DIR);
}

/**
 * Sync user-level skills and commands into a project's .claude/ as symlinks.
 *
 * The SDK has no API to filter skills/commands — it reads ALL entries from settingSources paths.
 * We use settingSources: ['project'] (reads from <cwd>/.claude/) and sync user-level
 * skills/commands as symlinks into the project's .claude/skills/ and .claude/commands/.
 *
 * This avoids setting CLAUDE_CONFIG_DIR (which would break Keychain credential lookup).
 *
 * Skills (directories):
 * - Creates symlinks for enabled skills: <project>/.claude/skills/<name> → ~/.myagents/skills/<name>
 * - Removes symlinks for disabled skills (only symlinks, never real project directories)
 * - Does NOT touch real (non-symlink) skill directories in the project
 *
 * Commands (.md files):
 * - Creates symlinks for all commands: <project>/.claude/commands/<name>.md → ~/.myagents/commands/<name>.md
 * - Does NOT touch real (non-symlink) command files in the project
 *
 * Called at session startup (startStreamingSession) and after skill/command CRUD operations.
 */
export function syncProjectUserConfig(projectDir: string): void {
  const myagentsDir = getMyAgentsUserDir();
  const isWin = process.platform === 'win32';

  // ===== SKILLS SYNC =====
  const userSkillsDir = join(myagentsDir, 'skills');
  const projectSkillsDir = join(projectDir, '.claude', 'skills');

  if (existsSync(userSkillsDir)) {
    try { mkdirSync(projectSkillsDir, { recursive: true }); } catch (e: any) { if (e?.code !== 'EEXIST') throw e; }

    // Read disabled list from skills-config.json
    let disabled: string[] = [];
    try {
      const configPath = join(myagentsDir, 'skills-config.json');
      if (existsSync(configPath)) {
        const raw = JSON.parse(readFileSync(configPath, 'utf-8'));
        disabled = Array.isArray(raw?.disabled) ? raw.disabled : [];
      }
    } catch {
      // Ignore read errors — treat all skills as enabled
    }

    // Track which skill names we manage (enabled or disabled) so we can detect dangling symlinks
    const managedSkillNames = new Set<string>();

    for (const entry of readdirSync(userSkillsDir, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      if (entry.name.startsWith('.')) continue;
      if (isSkillBlockedOnPlatform(entry.name)) continue;

      managedSkillNames.add(entry.name);
      const linkPath = join(projectSkillsDir, entry.name);
      const target = join(userSkillsDir, entry.name);

      if (disabled.includes(entry.name)) {
        // Disabled: remove symlink if we created one (never remove real dirs)
        try {
          if (existsSync(linkPath) && lstatSync(linkPath).isSymbolicLink()) {
            // recursive: true needed on Windows — junctions are directories, rmSync() alone throws EPERM
            rmSync(linkPath, { recursive: true });
          }
        } catch { /* ignore */ }
        continue;
      }

      // Skip if a real (non-symlink) directory exists — don't overwrite project skills
      try {
        if (existsSync(linkPath)) {
          if (!lstatSync(linkPath).isSymbolicLink()) continue; // real dir, skip
          rmSync(linkPath, { recursive: true }); // recursive for Windows junctions
        }
      } catch { /* doesn't exist, create it */ }

      try {
        symlinkSync(target, linkPath, isWin ? 'junction' : undefined);
      } catch (err) {
        console.warn(`[skill-sync] Failed to symlink skill ${entry.name}:`, err);
      }
    }

    // Cleanup: remove dangling symlinks left by deleted/renamed user skills
    // Only removes symlinks pointing into our userSkillsDir — never touches real project dirs
    try {
      for (const entry of readdirSync(projectSkillsDir, { withFileTypes: true })) {
        const linkPath = join(projectSkillsDir, entry.name);
        try {
          if (!lstatSync(linkPath).isSymbolicLink()) continue;
          const target = readlinkSync(linkPath);
          const resolvedTarget = resolve(projectSkillsDir, target);
          if (resolvedTarget.startsWith(userSkillsDir + sep) && !managedSkillNames.has(entry.name)) {
            rmSync(linkPath, { recursive: true });
          }
        } catch { /* ignore individual errors */ }
      }
    } catch { /* ignore — projectSkillsDir may have been removed externally */ }
  }

  // ===== COMMANDS SYNC =====
  const userCommandsDir = join(myagentsDir, 'commands');
  const projectCommandsDir = join(projectDir, '.claude', 'commands');

  if (existsSync(userCommandsDir)) {
    try { mkdirSync(projectCommandsDir, { recursive: true }); } catch (e: any) { if (e?.code !== 'EEXIST') throw e; }

    // Track managed command filenames for dangling symlink cleanup
    const managedCommandFiles = new Set<string>();

    for (const entry of readdirSync(userCommandsDir, { withFileTypes: true })) {
      if (!entry.isFile() || !entry.name.endsWith('.md')) continue;
      if (entry.name.startsWith('.')) continue;

      managedCommandFiles.add(entry.name);
      const linkPath = join(projectCommandsDir, entry.name);
      const target = join(userCommandsDir, entry.name);

      // Skip if a real (non-symlink) file exists — don't overwrite project commands
      try {
        if (existsSync(linkPath)) {
          if (!lstatSync(linkPath).isSymbolicLink()) continue; // real file, skip
          rmSync(linkPath, { recursive: true }); // stale symlink, recreate
        }
      } catch { /* doesn't exist, create it */ }

      try {
        // Note: file symlinks on Windows require Developer Mode (unlike junction for directories).
        // If this fails, the command won't be available in the project — logged as warning.
        symlinkSync(target, linkPath);
      } catch (err) {
        console.warn(`[command-sync] Failed to symlink command ${entry.name}:`, err);
      }
    }

    // Cleanup: remove dangling symlinks left by deleted/renamed user commands
    try {
      for (const entry of readdirSync(projectCommandsDir, { withFileTypes: true })) {
        const linkPath = join(projectCommandsDir, entry.name);
        try {
          if (!lstatSync(linkPath).isSymbolicLink()) continue;
          const target = readlinkSync(linkPath);
          const resolvedTarget = resolve(projectCommandsDir, target);
          if (resolvedTarget.startsWith(userCommandsDir + sep) && !managedCommandFiles.has(entry.name)) {
            rmSync(linkPath, { recursive: true });
          }
        } catch { /* ignore individual errors */ }
      }
    } catch { /* ignore */ }
  }
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
  /** Gemini thinking models: opaque signature that must be round-tripped on tool calls */
  thought_signature?: string;
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
  /** Gemini thinking models: opaque signature that must be round-tripped on tool calls */
  thought_signature?: string;
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
  sdkUuid?: string;  // SDK 分配的 UUID，用于 resumeSessionAt / rewindFiles
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
  metadata?: {
    source: SessionSource;
    sourceId?: string;
    senderName?: string;
  };
};

const requireModule = createRequire(import.meta.url);

let agentDir = '';
let hasInitialPrompt = false;
let sessionState: SessionState = 'idle';
let querySession: Query | null = null;
let isProcessing = false;
let shouldAbortSession = false;

/**
 * Reasons a deferred config restart can be scheduled. Used for observability
 * (so the drain-point log line tells operators which configs changed during
 * the turn) and for future extensibility (reasons can gain priorities).
 */
type RestartReason =
  | 'mcp'          // setMcpServers — MCP server list / env / args changed
  | 'agents'       // setAgents — sub-agent definitions changed
  | 'provider'     // setSessionProviderEnv — provider env (baseUrl, apiKey, etc.) changed
  | 'proxy'        // triggerProxyRestart — HTTP proxy changed via Settings
  | 'oauth';       // MCP OAuth token acquired/refreshed

// Deferred config restart: config changes during an active turn / pre-warm
// stage set a reason in this set instead of aborting immediately. Two consumers
// drain it, both reading-and-clearing as a unit:
// 1. schedulePreWarm() timer — batches rapid-fire changes (e.g. React state sync
//    firing 7× /api/mcp/set in 4s) into a single abort+restart.
// 2. Turn-complete handler — when config changed during an active user turn,
//    the restart is deferred until the turn finishes to avoid killing mid-response.
//
// Invariant: the set is cleared whenever `clearMessageState()` runs (fresh
// session) and whenever a drain-point consumes it. Error paths in
// startStreamingSession also clear it to prevent stuck flags across failed
// starts (see `finally` block on session errors).
const pendingConfigRestart = new Set<RestartReason>();

/** Schedule a deferred restart for the given reason. Multiple reasons within
 *  one turn collapse into a single restart at the next drain point. */
function scheduleDeferredRestart(reason: RestartReason): void {
  pendingConfigRestart.add(reason);
}

/** True when at least one reason is pending. */
function hasDeferredRestart(): boolean {
  return pendingConfigRestart.size > 0;
}

/** Drain-and-clear: returns the pending reasons (as a comma-joined string for
 *  logging) and empties the set. Always call this at the point a restart is
 *  actually applied — callers must not peek without draining. */
function drainDeferredRestart(): string {
  if (pendingConfigRestart.size === 0) return '';
  const reasons = [...pendingConfigRestart].join(',');
  pendingConfigRestart.clear();
  return reasons;
}

let sessionTerminationPromise: Promise<void> | null = null;

/**
 * Await sessionTerminationPromise with a timeout.
 * On timeout, force-clean session state so the caller is never permanently blocked.
 */
async function awaitSessionTermination(timeoutMs = 10_000, label = ''): Promise<void> {
  if (!sessionTerminationPromise) return;
  let timerId: ReturnType<typeof setTimeout>;
  try {
    await Promise.race([
      sessionTerminationPromise,
      new Promise<never>((_, reject) => {
        timerId = setTimeout(() => reject(new Error(`sessionTermination timeout (${label})`)), timeoutMs);
      }),
    ]);
  } catch (error) {
    const isTimeout = error instanceof Error && error.message.includes('timeout');
    console.warn(`[agent] ${label}: sessionTerminationPromise ${isTimeout ? 'timed out' : 'rejected'} after ${timeoutMs}ms, force-cleaning:`, error);
    // Force-clean state so the caller can proceed — mirrors the finally block of startStreamingSession.
    // Must cover ALL mutable state that the finally block would have reset, otherwise orphaned
    // flags (e.g. isStreamingMessage=true) cause secondary deadlocks.
    const session = querySession;
    querySession = null;
    isProcessing = false;
    isPreWarming = false;
    isStreamingMessage = false;
    // Don't null sessionTerminationPromise — the real finally block may still be running
    // and will call resolveTermination!(). Nulling it here creates a race where a subsequent
    // caller skips waiting while the old finally is still doing cleanup.
    // Wake any blocked messageGenerator so it doesn't hang forever
    if (messageResolver) {
      const resolve = messageResolver;
      messageResolver = null;
      resolve(null);
    }
    setSessionState('idle');
    try { void session?.close(); } catch { /* subprocess may already be dead */ }
  } finally {
    clearTimeout(timerId!);
  }
}

let isInterruptingResponse = false;
let isStreamingMessage = false;
// Post-interrupt turn-completion signal: resolves when for-await loop receives a `result` message.
// Used by interruptCurrentResponse() to verify the SDK subprocess actually stopped after interrupt().
let postInterruptTurnEndResolve: (() => void) | null = null;
let isApiRetrying = false;  // Track api_retry state to clear when streaming resumes
const messages: MessageWire[] = [];
const streamIndexToToolId: Map<number, string> = new Map();
const streamIndexToBlockType: Map<number, string> = new Map(); // Positive block type tracking for subagent content_block_stop
const toolResultIndexToId: Map<number, string> = new Map();

// IM Draft Stream: callback for streaming text to Telegram
type ImStreamCallback = (event: 'delta' | 'block-end' | 'complete' | 'error' | 'permission-request' | 'activity', data: string) => void;
let imStreamCallback: ImStreamCallback | null = null;
// Cross-turn guard: set to true when imStreamCallback is nulled (timeout/error) or replaced
// (defense-in-depth) during a turn. Reset to false by messageGenerator before each yield.
// handleMessageComplete/Stopped only fires 'complete' when flag is false, preventing
// a stale turn's completion from consuming a subsequent turn's SSE stream.
// Race-safe: unlike a generation counter snapshot (which can run before setImStreamCallback),
// this flag is set BY setImStreamCallback itself, so ordering is guaranteed.
let imCallbackNulledDuringTurn = false;
// Group chat tool deny list (v0.1.28): set per IM message, cleared on next non-group request
let currentGroupToolsDeny: string[] = [];
// Flag: auto-reset session after image content pollutes conversation history
let shouldResetSessionAfterError = false;
// Reason for the auto-reset (used to skip auto-reset for desktop image errors)
let shouldResetReason: 'image' | 'stale' | undefined;
// Track text block indices for detecting text-type content_block_stop
const imTextBlockIndices = new Set<number>();

const childToolToParent: Map<string, string> = new Map();
let messageSequence = 0;
let sessionId = randomUUID();

// Reset guard: prevents enqueueUserMessage from racing with async resetSession()/switchToSession()
// Single promise — non-null means a reset is in progress; enqueueUserMessage awaits it.
let resetPromise: Promise<void> | null = null;

/** Mark the start of an async reset. Returns a cleanup function for the finally block. */
function beginReset(): () => void {
  if (resetPromise) console.warn('[agent] beginReset: already resetting — possible reentrancy');
  let resolve: () => void;
  resetPromise = new Promise(r => { resolve = r; });
  return () => { resetPromise = null; resolve!(); };
}

// Pre-warm: start SDK subprocess + MCP servers before user sends first message
let isPreWarming = false;
let preWarmTimer: ReturnType<typeof setTimeout> | null = null;
let preWarmFailCount = 0;
const PRE_WARM_MAX_RETRIES = 3;
// Global Sidecar sets this to true via --no-pre-warm CLI flag to skip futile pre-warm attempts
// (SDK CLI needs first stdin message before system_init, which never comes for Global Sidecar)
let preWarmDisabled = false;
let systemInitInfo: SystemInitInfo | null = null;
type MessageQueueItem = {
  id: string;                     // Unique queue item ID
  message: SDKUserMessage['message'];
  messageText: string;            // Original text for cancel/restore
  wasQueued: boolean;             // true if added via non-blocking path (AI was busy)
  resolve: () => void;
  attachments?: MessageWire['attachments'];  // Saved attachments for deferred user message rendering
};
const messageQueue: MessageQueueItem[] = [];
// Pending attachments to persist with user messages
const _pendingAttachments: MessageAttachment[] = [];
// Current permission mode for the session (updates on each user message)
let currentPermissionMode: PermissionMode = 'auto';
// Permission mode before AI-triggered plan mode (for restore on ExitPlanMode)
let prePlanPermissionMode: PermissionMode | null = null;
// Current model for the session (updates on each user message if changed)
let currentModel: string | undefined = undefined;
// Provider environment config (baseUrl, apiKey, authType) for third-party providers
export type ModelAliases = {
  sonnet?: string;
  opus?: string;
  haiku?: string;
};

export type ProviderEnv = {
  baseUrl?: string;
  apiKey?: string;
  authType?: 'auth_token' | 'api_key' | 'both' | 'auth_token_clear_api_key';
  apiProtocol?: 'anthropic' | 'openai';
  maxOutputTokens?: number;
  maxOutputTokensParamName?: 'max_tokens' | 'max_completion_tokens' | 'max_output_tokens';
  upstreamFormat?: 'chat_completions' | 'responses';
  /** Model alias mapping: SDK sub-agents use "sonnet"/"opus"/"haiku" → actual provider model IDs */
  modelAliases?: ModelAliases;
};
let currentProviderEnv: ProviderEnv | undefined = undefined;

function normalizeProviderBaseUrl(baseUrl?: string): string | undefined {
  if (!baseUrl) return undefined;
  try {
    const url = new URL(baseUrl);
    const pathname = url.pathname.replace(/\/+$/, '');
    return `${url.origin}${pathname}`;
  } catch {
    return baseUrl.replace(/\/+$/, '');
  }
}

function requiresSignedSessionHistory(providerEnv?: ProviderEnv): boolean {
  if (!providerEnv) return true; // Anthropic subscription
  const normalizedBaseUrl = normalizeProviderBaseUrl(providerEnv.baseUrl);
  // Current behavior only covers official Anthropic providers. If future Claude suppliers
  // enforce the same signed-history constraint, extend this predicate in one place.
  return normalizedBaseUrl === 'https://api.anthropic.com';
}

// OpenAI Bridge: sidecar port for loopback, and active bridge config
let sidecarPort: number = 0;

export type OpenAiBridgeConfig = {
  baseUrl: string;
  apiKey: string;
  /** Target model name — bridge overrides ALL request models to this (only when no aliases) */
  model?: string;
  /** Max output tokens cap for upstream provider */
  maxOutputTokens?: number;
  /** Parameter name for token limit sent to upstream. Default 'max_tokens'. */
  maxOutputTokensParamName?: 'max_tokens' | 'max_completion_tokens' | 'max_output_tokens';
  /** Upstream API format: 'chat_completions' (default) or 'responses' */
  upstreamFormat?: 'chat_completions' | 'responses';
  /** Model aliases from provider config — used to build modelMapping for sub-agent model resolution */
  modelAliases?: ModelAliases;
} | null;

let currentOpenAiBridgeConfig: OpenAiBridgeConfig = null;

/** Set the sidecar port (called once from index.ts on startup).
 *
 *  Side effect: exports `MYAGENTS_PORT` to `process.env` so every subprocess
 *  spawned later via `augmentedProcessEnv()` (external runtimes: gemini / claude-code /
 *  codex) inherits it automatically — the AI's shell tool can then invoke
 *  `myagents` CLI without the CLI bailing with `MYAGENTS_PORT not set`. This is
 *  the pit-of-success alternative to editing three runtime `spawn()` call sites
 *  individually: a new runtime added tomorrow gets the same guarantee for free.
 *
 *  The builtin SDK path still sets `env.MYAGENTS_PORT` explicitly in
 *  `buildClaudeSessionEnv()` (idempotent) because pre-warm can spawn before
 *  this function is called and the process.env write would arrive too late. */
export function setSidecarPort(port: number): void {
  sidecarPort = port;
  if (port > 0) {
    process.env.MYAGENTS_PORT = String(port);
  }
}

/** Get the current sidecar port (used by admin-api for self-loopback) */
export function getSidecarPort(): number {
  return sidecarPort;
}

/** Get the current OpenAI bridge config (used by bridge handler in index.ts).
 *  Model is always derived from currentModel to avoid staleness after setSessionModel().
 *  When modelAliases exist, model override is suppressed — sub-agents need distinct models. */
export function getOpenAiBridgeConfig(): OpenAiBridgeConfig {
  if (!currentOpenAiBridgeConfig) return null;
  const aliases = currentOpenAiBridgeConfig.modelAliases;
  return {
    ...currentOpenAiBridgeConfig,
    // When aliases exist, don't set model as blanket override — let modelMapping handle it.
    // When no aliases, keep the old behavior (override all to currentModel).
    model: aliases ? undefined : (currentModel || undefined),
    modelAliases: aliases,
  };
}
// SDK 是否已注册当前 sessionId。true 时后续 query 必须用 resume。
// 仅由非 pre-warm 的 system_init 设为 true，仅由 sessionId 变更设为 false。
// Pre-warm 永不修改此标志 — 从结构上消除超时/重试导致的状态错误。
let sessionRegistered = false;

// 时间回溯：对话截断后，下次 query 需携带 resumeSessionAt 截断 SDK 对话历史
let pendingResumeSessionAt: string | undefined;
// 时间回溯进行中 — 阻止 enqueueUserMessage 并发写入
let rewindPromise: Promise<unknown> | null = null;

// 当前 SDK session 的 UUID 集合（包含磁盘加载 + 运行时 SDK 输出）。
// 用途：rewindFiles 前置校验 + resumeSessionAt 有效性判断（与 liveSessionUuids OR 联合）。
// 过期防护（两层）：
//   1. session 重建（!sessionRegistered）时在 startSession 清空
//   2. SDK 拒绝 UUID（"No message found"）时逐条驱逐（见 error recovery）
const currentSessionUuids = new Set<string>();

// 仅由当前 SDK subprocess stdout 事件填充的 UUID 集合。
// 注意：resume 场景下 SDK 不重新输出旧历史 UUID，因此此集合是运行时子集而非完整集合。
// resumeSessionAt 校验采用 OR 逻辑（liveSessionUuids || currentSessionUuids），
// 不以任一集合为排他权威。
const liveSessionUuids = new Set<string>();

// ===== 持久 Session 门控 =====
// 消息交付：事件驱动替代轮询，generator 阻塞在 waitForMessage 直到新消息到达
let messageResolver: ((item: MessageQueueItem | null) => void) | null = null;

/** 唤醒 generator — 投递消息或 null（退出信号） */
function wakeGenerator(item: MessageQueueItem | null): void {
  if (messageResolver) {
    const resolve = messageResolver;
    messageResolver = null;
    resolve(item);
  } else if (item) {
    messageQueue.push(item);
  }
}

/** generator 等待下一条消息（事件驱动，无轮询） */
function waitForMessage(): Promise<MessageQueueItem | null> {
  if (shouldAbortSession) return Promise.resolve(null);
  if (messageQueue.length > 0) return Promise.resolve(messageQueue.shift()!);
  return new Promise(resolve => { messageResolver = resolve; });
}

/** 当前回合是否仍在进行中 */
export function isTurnInFlight(): boolean {
  return isStreamingMessage;
}

/** 当前正在流式传输的 assistant 消息 ID（未在流式传输时返回 null） */
export function getStreamingAssistantId(): string | null {
  if (!isStreamingMessage) return null;
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i].role === 'assistant') return messages[i].id;
  }
  return null;
}

// Mid-turn injection: messages yielded to SDK but not yet consumed by the AI.
// queue:started is deferred until a content block boundary (thinking/tool_use/text start)
// signals the AI has processed the injected message. NOT flushed during text_delta/thinking_delta
// (continuous streaming within a block) to avoid splitting old content mid-stream.
const pendingMidTurnQueue: Array<{
  queueId: string;
  userMessage: Pick<MessageWire, 'id' | 'role' | 'content' | 'timestamp' | 'attachments'>;
}> = [];

/**
 * Flush deferred mid-turn user messages: push to messages[] and broadcast queue:started.
 * Called at content block boundaries (thinking/tool_use/text start) and turn end
 * (handleMessageComplete/handleMessageStopped). NOT called from text_delta/thinking_delta
 * to avoid splitting old text mid-stream.
 */
function flushPendingMidTurnQueue(): void {
  if (pendingMidTurnQueue.length === 0) return;
  for (const pending of pendingMidTurnQueue) {
    messages.push(pending.userMessage as MessageWire);
    broadcast('queue:started', {
      queueId: pending.queueId,
      userMessage: pending.userMessage,
      midTurnBreak: true,
    });
  }
  pendingMidTurnQueue.length = 0;
}

/** 中止持久 session：唤醒所有被阻塞的 Promise */
function abortPersistentSession(): void {
  // Log warning if browser was used but storage state wasn't saved
  // (The system prompt instructs the AI to save, but this is the fallback detection)
  if (sessionBrowserToolUsed && !sessionStorageStateSaved) {
    console.warn('[agent] Browser tools were used but storage state was not saved. Login state from this session may be lost.');
  }

  shouldAbortSession = true;
  // Discard pending mid-turn messages (session is being torn down)
  pendingMidTurnQueue.length = 0;
  // Notify IM stream callback before abort
  if (imStreamCallback) {
    imStreamCallback('error', '会话已中断，请重新发送');
    imStreamCallback = null;
  }
  // 唤醒被阻塞的 generator（waitForMessage）
  if (messageResolver) {
    const resolve = messageResolver;
    messageResolver = null;
    resolve(null);
  }
  // 强制 subprocess 产出消息/错误，解除 for-await 阻塞
  querySession?.interrupt().catch(() => {});
}

// ===== Interaction Scenario (unified system prompt) =====
import { buildSystemPromptAppend, type InteractionScenario } from './system-prompt';

let currentScenario: InteractionScenario = { type: 'desktop' };

/**
 * Set the interaction scenario for the current session.
 * This determines the system prompt layers (identity + channel + scenario instructions).
 */
export function setInteractionScenario(scenario: InteractionScenario): void {
  currentScenario = scenario;
  if (isDebugMode) {
    console.log(`[agent] Interaction scenario: ${scenario.type}`);
  }
}

/**
 * Reset interaction scenario to default (desktop).
 */
export function resetInteractionScenario(): void {
  currentScenario = { type: 'desktop' };
  if (isDebugMode) {
    console.log('[agent] Interaction scenario reset to desktop');
  }
}
// SDK ready signal - prevents messageGenerator from yielding before SDK's ProcessTransport is ready
let _sdkReadyResolve: (() => void) | null = null;
let _sdkReadyPromise: Promise<void> | null = null;

// ===== Turn-level Usage Tracking =====
// Token usage for the current turn, extracted from SDK result message
import type { ModelUsageEntry } from './types/session';

let currentTurnUsage = {
  inputTokens: 0,
  outputTokens: 0,
  cacheReadTokens: 0,
  cacheCreationTokens: 0,
  model: undefined as string | undefined,
  modelUsage: undefined as Record<string, ModelUsageEntry> | undefined,
};
// Timestamp when current assistant response started
let currentTurnStartTime: number | null = null;
// Tool count for current turn
let currentTurnToolCount = 0;
// Whether the current turn produced any visible assistant text output
let currentTurnHasOutput = false;
// Browser tool tracking for storage-state auto-save
// Tracks whether any browser_* MCP tools were used in the current session,
// and whether browser_storage_state was called (to avoid redundant save).
let sessionBrowserToolUsed = false;
let sessionStorageStateSaved = false;

function resetTurnUsage(): void {
  currentTurnUsage = {
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheCreationTokens: 0,
    model: undefined,
    modelUsage: undefined,
  };
  currentTurnStartTime = null;
  currentTurnToolCount = 0;
  currentTurnHasOutput = false;
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

// Current sub-agent definitions (set per-query via /api/agents/set)
// null = no agents configured, {} = explicitly set to none
let currentAgentDefinitions: Record<string, AgentDefinition> | null = null;

/**
 * Hot-reload proxy configuration into the current process environment.
 * Mutates process.env so that subsequent SDK subprocess spawns inherit the new proxy.
 * Triggers session restart (abort + resume + pre-warm) identical to MCP config changes,
 * but only when the effective proxy URL actually changed.
 *
 * SOCKS5 handling: Bun/Node.js `fetch()` doesn't support `socks5://` in HTTP_PROXY env vars.
 * When SOCKS5 is configured, we start a local HTTP-to-SOCKS5 bridge and set HTTP_PROXY to
 * the bridge's HTTP URL. The bridge transparently tunnels traffic through SOCKS5.
 */
let proxyConfigGeneration = 0; // Guards against stale async SOCKS5 callbacks

export function setProxyConfig(proxySettings: {
  enabled: boolean;
  protocol?: string;
  host?: string;
  port?: number;
} | null): void {
  const PROXY_VARS = [...PROXY_VARS_LIST];

  // Bump generation to invalidate in-flight SOCKS5 bridge callbacks
  const generation = ++proxyConfigGeneration;

  // Compute the new effective proxy URL for change detection
  const oldProxyUrl = process.env.HTTP_PROXY || '';
  const rawProxyUrl = proxySettings?.enabled
    ? `${proxySettings.protocol || 'http'}://${proxySettings.host || '127.0.0.1'}:${proxySettings.port || 7890}`
    : '';
  const isSocks5 = proxySettings?.protocol === 'socks5';

  if (proxySettings?.enabled) {
    if (isSocks5) {
      // SOCKS5: start bridge asynchronously, set env vars after bridge is ready
      const host = proxySettings.host || '127.0.0.1';
      const port = proxySettings.port || 7890;
      startSocksBridge(host, port).then((bridgePort) => {
        // Discard if a newer config change has occurred while bridge was starting
        if (generation !== proxyConfigGeneration) {
          console.log('[agent] SOCKS5 bridge callback discarded (superseded by newer config)');
          return;
        }
        const bridgeUrl = `http://127.0.0.1:${bridgePort}`;
        if (oldProxyUrl === bridgeUrl) {
          console.log('[agent] SOCKS5 bridge URL unchanged, skipping restart');
          return;
        }
        applyProxyEnvVars(bridgeUrl, PROXY_NO_PROXY_VAL);
        console.log(`[agent] SOCKS5 proxy hot-reloaded: ${rawProxyUrl} → bridge ${bridgeUrl}`);
        triggerProxyRestart();
      }).catch((err) => {
        if (generation !== proxyConfigGeneration) return;
        console.error(`[agent] Failed to start SOCKS5 bridge: ${err.message}. Falling back to direct socks5:// URL.`);
        applyProxyEnvVars(rawProxyUrl, PROXY_NO_PROXY_VAL);
        triggerProxyRestart();
      });
      // Return early — env vars will be set when bridge is ready
      return;
    }

    // HTTP/HTTPS: stop bridge if running, set env vars directly
    if (isSocksBridgeRunning()) {
      stopSocksBridge().catch(() => { /* ignore */ });
    }
    applyProxyEnvVars(rawProxyUrl, PROXY_NO_PROXY_VAL);
    console.log(`[agent] Proxy hot-reloaded: ${rawProxyUrl}`);
  } else {
    // Disabled: stop bridge, restore inherited system proxy state
    if (isSocksBridgeRunning()) {
      stopSocksBridge().catch(() => { /* ignore */ });
    }
    if (proxyWasInjectedByRust) {
      // Sidecar started with explicit proxy — can't restore unknown system state, just clear
      for (const v of PROXY_VARS) delete process.env[v];
      console.log('[agent] Proxy cleared (was explicitly injected, falling back to direct)');
    } else {
      // Sidecar started with inherited system env — restore snapshot
      for (const v of PROXY_VARS) {
        if (inheritedProxySnapshot[v] !== undefined) {
          process.env[v] = inheritedProxySnapshot[v]!;
        } else {
          delete process.env[v];
        }
      }
      const restoredProxy = inheritedProxySnapshot.HTTP_PROXY || inheritedProxySnapshot.http_proxy || '';
      console.log(`[agent] Proxy disabled, restored inherited system state${restoredProxy ? ` (${restoredProxy})` : ' (no system proxy)'}`);
    }
  }

  const newProxyUrl = process.env.HTTP_PROXY || '';
  if (oldProxyUrl === newProxyUrl) {
    if (isDebugMode) console.log('[agent] Proxy config unchanged, skipping session restart');
    return;
  }

  triggerProxyRestart();
}

/** Apply proxy env vars to process.env */
function applyProxyEnvVars(proxyUrl: string, noProxyVal: string): void {
  process.env.HTTP_PROXY = proxyUrl;
  process.env.HTTPS_PROXY = proxyUrl;
  process.env.http_proxy = proxyUrl;
  process.env.https_proxy = proxyUrl;
  process.env.NO_PROXY = noProxyVal;
  process.env.no_proxy = noProxyVal;
  delete process.env.ALL_PROXY;
  delete process.env.all_proxy;
}

/** Restart session after proxy change.
 * Attempts immediate abort when idle; during active turns falls back to
 * pendingConfigRestart (same deferred mechanism as setMcpServers/setAgents).
 * Differs from MCP/agents in that it doesn't go through schedulePreWarm's
 * 500ms debounce — proxy changes are discrete user actions from Settings. */
function triggerProxyRestart(): void {
  if (querySession) {
    if (isProcessing && !isPreWarming) {
      console.log('[agent] Proxy changed, deferring restart (active turn)');
      scheduleDeferredRestart('proxy');
    } else {
      if (isDebugMode) console.log('[agent] Proxy changed, restarting session with resume');
      abortPersistentSession();
    }
  }
  preWarmFailCount = 0;
  if (!isProcessing || isPreWarming) {
    schedulePreWarm();
  }
}

/**
 * Initialize SOCKS5 bridge from inherited environment variables at Sidecar startup.
 * Rust may have set HTTP_PROXY=socks5://... — detect and bridge it before first pre-warm.
 */
export async function initSocksBridgeFromEnv(): Promise<void> {
  const proxyUrl = process.env.HTTP_PROXY || process.env.HTTPS_PROXY || '';
  if (!proxyUrl.startsWith('socks5://')) return;

  try {
    const url = new URL(proxyUrl);
    const host = url.hostname || '127.0.0.1';
    const port = parseInt(url.port) || 1080;

    const bridgePort = await startSocksBridge(host, port);
    const bridgeUrl = `http://127.0.0.1:${bridgePort}`;
    applyProxyEnvVars(bridgeUrl, PROXY_NO_PROXY_VAL);
    console.log(`[agent] SOCKS5 bridge initialized at startup: ${proxyUrl} → ${bridgeUrl}`);
  } catch (err) {
    console.error(`[agent] Failed to initialize SOCKS5 bridge from env: ${err instanceof Error ? err.message : err}`);
    // Leave the original socks5:// URL in place — it will fail but at least error messages are clear
  }
}

/**
 * Set the MCP servers to use for subsequent queries
 * Called from renderer when user toggles MCP in workspace
 * If MCP config changed and a session is running, it will be restarted with resume
 */
export function setMcpServers(servers: McpServerDefinition[]): void {
  // Detect config changes: compare full config fingerprint (not just IDs)
  // so that env/args changes (e.g. API key update) also trigger session restart.
  const mcpChanged = mcpConfigFingerprint(currentMcpServers ?? []) !== mcpConfigFingerprint(servers);

  currentMcpServers = servers;
  if (isDebugMode) {
    console.log(`[agent] MCP servers set: ${servers.map(s => s.id).join(', ') || 'none'}`);
    for (const s of servers) {
      if (s.env && Object.keys(s.env).length > 0) {
        console.log(`[agent] MCP ${s.id}: Has custom env vars: ${Object.keys(s.env).join(', ')}`);
      }
    }
  }

  // If MCP changed, defer restart to the debounced pre-warm timer.
  // DO NOT abort immediately — rapid-fire /api/mcp/set calls from React state sync
  // (e.g. 7 calls in 4s when toggling one server in Settings) would kill the SDK
  // subprocess + all stdio MCP servers repeatedly, destroying in-process state.
  // The timer in schedulePreWarm() batches these into a single abort+restart.
  if (mcpChanged && querySession) {
    const ids = servers.map(s => s.id).join(', ') || 'none';
    console.log(`[agent] MCP config changed → [${ids}], deferring restart to pre-warm debounce`);
    scheduleDeferredRestart('mcp');
  }

  // Pre-warm: start/restart subprocess + MCP servers ahead of user's first message
  preWarmFailCount = 0; // Config changed — reset retry tracking
  if (!isProcessing || isPreWarming) {
    schedulePreWarm();
  }
}

/** Stable fingerprint of MCP config for change detection (covers id + command + args + env + url + headers) */
function mcpConfigFingerprint(servers: McpServerDefinition[]): string {
  return JSON.stringify(
    servers
      .slice()
      .sort((a, b) => a.id.localeCompare(b.id))
      .map(s => ({ id: s.id, type: s.type, command: s.command, args: s.args, url: s.url, env: s.env, headers: s.headers }))
  );
}


/**
 * Get current MCP servers
 * Returns null if never set (workspace not initialized), or array (possibly empty)
 */
export function getMcpServers(): McpServerDefinition[] | null {
  return currentMcpServers;
}

/**
 * Set the sub-agent definitions for subsequent queries
 * If agents changed and a session is running, it will be restarted with resume
 */
export function setAgents(agents: Record<string, AgentDefinition>): void {
  const currentNames = currentAgentDefinitions ? Object.keys(currentAgentDefinitions).sort().join(',') : '';
  const newNames = Object.keys(agents).sort().join(',');
  const agentsChanged = currentNames !== newNames;

  currentAgentDefinitions = agents;
  if (isDebugMode) {
    console.log(`[agent] Sub-agents set: ${newNames || 'none'}`);
  }

  // Defer restart to pre-warm debounce (same as setMcpServers — see comment there).
  if (agentsChanged && querySession) {
    console.log(`[agent] Sub-agents changed (${currentNames || 'none'} -> ${newNames || 'none'}), deferring restart to pre-warm debounce`);
    scheduleDeferredRestart('agents');
  }

  // Pre-warm: start/restart subprocess + MCP servers ahead of user's first message
  preWarmFailCount = 0; // Config changed — reset retry tracking
  if (!isProcessing || isPreWarming) {
    schedulePreWarm();
  }
}

/**
 * Set the default model for subsequent queries.
 * Called during tab initialization so the backend has a real default model
 * before pre-warm starts. This ensures:
 * 1. Pre-warm uses the correct model (no undefined → SDK guesses)
 * 2. Gateway clients (Telegram, API) can omit model and get a proper default
 * 3. First user message doesn't trigger a blocking setModel() call
 *
 * Unlike MCP/agents, model changes don't require session restart —
 * so this does NOT trigger schedulePreWarm(). The debounced pre-warm
 * from MCP/agents sync will pick up the model automatically.
 */
export function getSessionModel(): string | undefined {
  return currentModel;
}

export function getSessionPermissionMode(): PermissionMode {
  return currentPermissionMode;
}

/** Set permission mode (called from frontend via /api/session/permission-mode) */
export function setSessionPermissionMode(mode: PermissionMode): void {
  if (mode === currentPermissionMode) return;
  const oldMode = currentPermissionMode;
  currentPermissionMode = mode;
  console.log(`[agent] session permission mode set: ${oldMode} -> ${mode}`);

  // Apply permission mode change to SDK subprocess immediately (same as setSessionModel).
  // Without this, the SDK subprocess stays in the old mode until the next message
  // triggers applySessionConfig(). Critical for plan mode: user switches to plan in UI
  // but SDK keeps auto → canUseTool may be skipped → tools execute unchecked.
  if (querySession) {
    const sdkMode = mapToSdkPermissionMode(mode);
    querySession.setPermissionMode(sdkMode).catch(err => {
      console.error('[agent] failed to apply permission mode to running session:', err);
      // Rollback: restore old mode and notify frontend to undo
      currentPermissionMode = oldMode;
      broadcast('chat:permission-mode-changed', { permissionMode: oldMode });
    });
  }

  // Notify frontend of the mode change so UI stays in sync
  broadcast('chat:permission-mode-changed', { permissionMode: mode });
}

export function setSessionModel(model: string): void {
  if (model === currentModel) return;

  const oldModel = currentModel;
  currentModel = model;
  console.log(`[agent] session model set: ${oldModel ?? 'undefined'} -> ${model}`);

  // Apply model change to SDK subprocess immediately (including during pre-warm).
  // Without this, changing model during pre-warm creates a desync:
  //   currentModel is updated but SDK subprocess keeps the old model,
  //   and applySessionConfig() on first message sees no diff → skips the SDK call.
  if (querySession) {
    querySession.setModel(model).catch(err => {
      console.error('[agent] failed to apply model to running session:', err);
    });
  }
}

/** Get current provider env (used by heartbeat/memory-update to preserve provider across internal calls). */
export function getSessionProviderEnv(): ProviderEnv | undefined {
  return currentProviderEnv;
}

/** Set provider env (called by Rust IM router via /api/provider/set on sidecar creation or config hot-reload).
 *
 * Provider env is baked into SDK subprocess environment variables at spawn time
 * and CANNOT be updated on a running process. If a session is already running
 * with stale env (e.g., pre-warm started before sync_ai_config arrived),
 * we must restart it. Attempts immediate abort when idle; during active turns
 * falls back to pendingConfigRestart. Differs from MCP/agents in that it doesn't
 * go through schedulePreWarm's 500ms debounce — provider changes are discrete
 * Rust-layer calls, not rapid-fire React state sync.
 */
export function setSessionProviderEnv(providerEnv: ProviderEnv | undefined): void {
  const oldLabel = currentProviderEnv?.baseUrl ?? 'anthropic';
  const newLabel = providerEnv?.baseUrl ?? 'anthropic';
  // Full equality check — all ProviderEnv fields affect subprocess env (authType, apiProtocol, etc.)
  if (providerEnvEqual(currentProviderEnv, providerEnv)) return;

  // Resume safety: entering a provider that validates signed session history requires a fresh
  // session when the previous provider did not. Anthropic validates thinking block signatures
  // that third-party providers don't, so resuming with third-party messages causes errors.
  // Must check BEFORE updating currentProviderEnv.
  // Note: Desktop Chat also shows a ConfirmDialog for this case (see Chat.tsx), but this
  // backend guard is defense-in-depth for non-frontend callers (IM Bot, Cron, Agent Channel).
  const currentRequiresSignedHistory = requiresSignedSessionHistory(currentProviderEnv);
  const nextRequiresSignedHistory = requiresSignedSessionHistory(providerEnv);
  if (!currentRequiresSignedHistory && nextRequiresSignedHistory) {
    sessionRegistered = false;
    console.log('[agent] provider switch: third-party → Anthropic — will create fresh session (signature incompatible)');
  }

  currentProviderEnv = providerEnv;
  console.log(`[agent] session provider env set: ${oldLabel} → ${newLabel}`);

  // If a session is running, its subprocess has the OLD provider env.
  // Restart so the next session picks up the updated environment.
  if (querySession) {
    if (isProcessing && !isPreWarming) {
      // Active user turn in progress — defer restart to avoid killing mid-response.
      // The restart will fire after the current turn completes (pendingConfigRestart).
      console.log('[agent] provider changed during active turn → deferring restart');
      scheduleDeferredRestart('provider');
    } else {
      console.log(`[agent] provider changed (${oldLabel} → ${newLabel}) → aborting session (preWarm=${isPreWarming})`);
      abortPersistentSession();
    }
  } else if (isProcessing) {
    // startStreamingSession() is in progress but querySession hasn't been assigned yet.
    // buildClaudeSessionEnv() may have already read the stale currentProviderEnv.
    // Schedule a deferred restart so it fires after the first turn completes.
    console.log('[agent] provider changed while session starting → will restart after first turn');
    scheduleDeferredRestart('provider');
  }

  // Reset retry counter and re-warm (same tail as setMcpServers/triggerProxyRestart)
  preWarmFailCount = 0;
  if (!isProcessing || isPreWarming) {
    schedulePreWarm();
  }
}

/** Deep equality check for ProviderEnv — all fields affect subprocess environment. */
function providerEnvEqual(a: ProviderEnv | undefined, b: ProviderEnv | undefined): boolean {
  if (!a && !b) return true;
  if (!a || !b) return false;
  return a.baseUrl === b.baseUrl
    && a.apiKey === b.apiKey
    && a.authType === b.authType
    && a.apiProtocol === b.apiProtocol
    && a.maxOutputTokens === b.maxOutputTokens
    && a.maxOutputTokensParamName === b.maxOutputTokensParamName
    && a.upstreamFormat === b.upstreamFormat
    && a.modelAliases?.sonnet === b.modelAliases?.sonnet
    && a.modelAliases?.opus === b.modelAliases?.opus
    && a.modelAliases?.haiku === b.modelAliases?.haiku;
}

/**
 * Schedule a pre-warm of the SDK subprocess and MCP servers.
 * Uses debounce to batch rapid config changes during tab initialization.
 * The pre-warmed session is invisible to the frontend until the first user message.
 */
function schedulePreWarm(): void {
  if (preWarmTimer) clearTimeout(preWarmTimer);
  if (!agentDir) return;
  if (preWarmDisabled) return;
  // External runtimes (CC/Codex) manage their own subprocess — skip builtin SDK pre-warm
  if (isExternalRuntime(getCurrentRuntimeType())) return;

  // Stop retrying after consecutive failures to avoid infinite loop
  if (preWarmFailCount >= PRE_WARM_MAX_RETRIES) {
    console.warn(`[agent] pre-warm skipped: ${preWarmFailCount} consecutive failures, giving up`);
    return;
  }

  preWarmTimer = setTimeout(() => {
    preWarmTimer = null;
    if (!agentDir) return;

    // Drain deferred config restart: abort the stale session so the next
    // startStreamingSession() picks up the latest MCP/agents/provider/proxy config.
    // Batched exit point for rapid-fire config changes (setMcpServers, setAgents,
    // OAuth) and active-turn fallbacks from provider/proxy immediate-abort paths.
    if (hasDeferredRestart() && querySession) {
      const reasons = drainDeferredRestart();
      console.log(`[agent] pre-warm: applying batched config restart (reasons=${reasons})`);
      abortPersistentSession();
      // Session is now terminating — retry after cleanup finishes
      schedulePreWarm();
      return;
    }
    // No active session to restart — clear any leftover reasons (e.g. reason was
    // scheduled during a failed startup and the session never came up).
    drainDeferredRestart();

    if (isSessionActive()) {
      // Session still cleaning up — RETRY instead of calling startStreamingSession().
      // We must NOT call startStreamingSession() here because it would await
      // sessionTerminationPromise and become a "stale awaiter" — waking up minutes later
      // when the promise resolves for a completely different reason (rewind, provider change),
      // starting an unwanted session with stale config and corrupting shared state.
      // Retry ensures we only start when the session is truly idle.
      schedulePreWarm();
      return;
    }
    console.log('[agent] pre-warming SDK subprocess + MCP servers');
    startStreamingSession(true).catch((error) => {
      console.error('[agent] pre-warm failed:', error);
    });
  }, 500);
}

/**
 * Get current sub-agent definitions
 */
export function getAgents(): Record<string, AgentDefinition> | null {
  return currentAgentDefinitions;
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

  // Extract server ID from tool name: mcp__<server-id>__<tool-name>
  const parts = toolName.split('__');
  if (parts.length < 3) {
    return { allowed: false, reason: '无效的 MCP 工具名称' };
  }
  const serverId = parts[1];

  // Special case: cron-tools is a built-in MCP server for cron task management
  // Always allow when we're in a cron task context (regardless of user's MCP settings)
  if (serverId === 'cron-tools') {
    const cronContext = getCronTaskContext();
    if (cronContext.taskId) {
      return { allowed: true };
    }
    // Not in cron context - this tool shouldn't be available
    return { allowed: false, reason: '定时任务工具只能在定时任务执行期间使用' };
  }

  // Special case: im-cron is a built-in MCP server for scheduled tasks (all sessions)
  // Always allowed when management API is available (tool checks context internally)
  if (serverId === 'im-cron') {
    if (process.env.MYAGENTS_MANAGEMENT_PORT) {
      return { allowed: true };
    }
    return { allowed: false, reason: '定时任务管理 API 不可用' };
  }

  // Special case: generative-ui is a built-in MCP server for desktop sessions
  // Context-injected (not in user's MCP list), always allowed when injected
  if (serverId === 'generative-ui') {
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
  // The SDK sanitizes server names in tool prefixes: replace non-[a-zA-Z0-9_-] with '_'.
  // Config IDs are usually already clean, but compare sanitized forms for robustness.
  // Example: config id "my.server" → SDK tool prefix uses "my_server".
  const sanitize = (name: string) => name.replace(/[^a-zA-Z0-9_-]/g, '_');
  const sanitizedServerId = sanitize(serverId);
  const isEnabled = currentMcpServers.some(s => sanitize(s.id) === sanitizedServerId);
  if (isEnabled) {
    return { allowed: true };
  }

  return { allowed: false, reason: `MCP 服务「${serverId}」未启用` };
}

/**
 * Build SDK settingSources
 *
 * settingSources controls where SDK reads settings from:
 * - 'user': reads from CLAUDE_CONFIG_DIR (default ~/.claude/)
 * - 'project': <cwd>/.claude/ (project-level config)
 *
 * We use 'project' only:
 * - User-level skills are synced as symlinks into <cwd>/.claude/skills/ by syncProjectUserConfig()
 * - Avoids setting CLAUDE_CONFIG_DIR which would break Keychain credential lookup
 * - Project-level: SDK reads project's .claude/skills/, .claude/commands/, CLAUDE.md
 *
 * We exclude 'user' because:
 * - 'user' reads from ~/.claude/ (Claude CLI's directory, not ours)
 * - Our product uses ~/.myagents/ for user-level config
 * - Setting CLAUDE_CONFIG_DIR to redirect would break Anthropic subscription OAuth
 *   (SDK derives Keychain service names from CLAUDE_CONFIG_DIR path hash)
 */
function buildSettingSources(): ('user' | 'project')[] {
  return ['project'];
}

// Known MCP package versions — pin these to avoid npm registry lookups on every startup
// Update these when upgrading MCP server dependencies
const PINNED_MCP_VERSIONS: Record<string, string> = {
  '@playwright/mcp': '0.0.68',
};

/**
 * Replace @latest tags with pinned versions for known MCP packages.
 * This eliminates the npm registry network check that adds 2-5s latency per startup.
 * Unknown packages keep their original version specifiers.
 */
export function pinMcpPackageVersions(args: string[]): string[] {
  return args.map(arg => {
    // Match patterns like @playwright/mcp@latest or @scope/pkg@latest
    const latestMatch = arg.match(/^(@?[^@]+)@latest$/);
    if (latestMatch) {
      const pkgName = latestMatch[1];
      const pinned = PINNED_MCP_VERSIONS[pkgName];
      if (pinned) {
        console.log(`[agent] MCP version pinned: ${arg} → ${pkgName}@${pinned}`);
        return `${pkgName}@${pinned}`;
      }
    }
    return arg;
  });
}

/**
 * Convert McpServerDefinition to SDK mcpServers format.
 *
 * Three MCP injection patterns:
 * 1. Context-injected (cron-tools, im-cron, im-media) — always present based on sidecar context,
 *    invisible in Settings UI, not user-toggled.
 * 2. Builtin registry (command='__builtin__') — in-process servers, user-toggled via Settings,
 *    self-registered via builtin-mcp-registry.ts. Adding a new one = add registerBuiltinMcp()
 *    call in the tool file + side-effect import below.
 * 3. External (stdio/sse/http) — subprocess or remote servers, user-configured.
 *
 * Execution strategy for external stdio:
 * - For npx commands: system npx → bundled Node.js npx → bun x
 * - For other commands: Uses user-specified command directly (node/python etc.)
 * - Inherits proxy env + injects NO_PROXY to protect localhost (mirrors Rust proxy_config)
 */
async function buildSdkMcpServers(): Promise<Record<string, SdkMcpServerConfig | typeof cronToolsServer>> {
  // null = MCP not yet configured (e.g. Global sidecar, or Tab pre-warm before /api/mcp/set)
  // [] = explicitly no MCP (user has none enabled)
  // [...]= user's enabled MCP servers
  // Never fall back to config file — the frontend's /api/mcp/set is the single source of truth.
  // Global sidecar never receives /api/mcp/set and correctly gets no MCP.
  // Filter out SDK reserved names to prevent fatal crash:
  // "Invalid MCP configuration: X is a reserved MCP name." → exit code 1
  const allServers: McpServerDefinition[] = currentMcpServers ?? [];
  const servers = allServers.filter(s => {
    const normalized = s.id.replace(/[^a-zA-Z0-9_-]/g, '_');
    if (SDK_RESERVED_MCP_NAMES.includes(normalized)) {
      console.warn(`[agent] MCP "${s.id}" skipped: conflicts with SDK reserved name. Rename to avoid this.`);
      return false;
    }
    return true;
  });
  if (isDebugMode) console.log(`[agent] MCP servers: ${servers.map(s => s.id).join(', ') || 'none'}`);

  const result: Record<string, SdkMcpServerConfig | typeof cronToolsServer> = {};

  // --- Pattern 1: Context-injected MCPs (always present based on sidecar context) ---
  const cronContext = getCronTaskContext();
  if (cronContext.taskId) {
    result['cron-tools'] = cronToolsServer;
    console.log(`[agent] Added cron-tools MCP server for task ${cronContext.taskId}`);
  }

  // Add cron tool for ALL sessions when management API is available
  // IM sessions use imCronContext (with delivery), regular sessions use sessionCronContext
  if (process.env.MYAGENTS_MANAGEMENT_PORT) {
    result['im-cron'] = imCronToolServer;
    const imCronCtx = getImCronContext();
    console.log(`[agent] Added im-cron MCP server${imCronCtx ? ` for bot ${imCronCtx.botId}` : ' (session mode)'}`);
  }

  // Add IM media tool if we're in an IM context with management API available
  const imMediaCtx = getImMediaContext();
  if (imMediaCtx && process.env.MYAGENTS_MANAGEMENT_PORT) {
    result['im-media'] = imMediaToolServer;
    console.log(`[agent] Added im-media MCP server for bot ${imMediaCtx.botId}`);
  }

  // Add Bridge tools if we're in an IM context with a plugin bridge that has tools
  // Dynamic server is created from actual plugin tool definitions — transparent passthrough
  const bridgeToolsCtx = getImBridgeToolsContext();
  const bridgeServer = getImBridgeToolServer();
  if (bridgeToolsCtx && bridgeServer) {
    result['im-bridge-tools'] = bridgeServer;
    console.log(`[agent] Added im-bridge-tools MCP server for plugin ${bridgeToolsCtx.pluginId}`);
  }

  // Add Generative UI tool for desktop sessions (not IM/Cron — they can't render widgets)
  // Use currentScenario (consistent with system-prompt.ts generativeUiEnabled check)
  if (currentScenario.type === 'desktop') {
    result['generative-ui'] = generativeUiServer as typeof cronToolsServer;
    console.log('[agent] Added generative-ui MCP server');
  }

  // --- Pattern 2: Builtin registry MCPs (in-process, user-toggled) ---
  for (const server of servers) {
    if (server.command !== '__builtin__') continue;
    const entry = getBuiltinMcp(server.id);
    if (entry) {
      entry.configure(server.env || {}, { sessionId: sessionId || 'default', workspace: agentDir });
      result[server.id] = entry.server as typeof cronToolsServer;
      console.log(`[agent] Added builtin MCP: ${server.id}`);
    }
  }

  // --- Pattern 3: External MCPs (stdio/sse/http subprocess or remote) ---
  const externalServers = servers.filter(s => s.command !== '__builtin__');

  // Return early if no user MCP servers (but may have cron-tools)
  if (externalServers.length === 0) {
    if (Object.keys(result).length > 0) {
      console.log(`[agent] Built SDK MCP servers: ${Object.keys(result).join(', ')}`);
    }
    return result;
  }

  for (const server of externalServers) {
    try {
    // Log server env for debugging
    if (isDebugMode && server.env && Object.keys(server.env).length > 0) {
      console.log(`[agent] MCP ${server.id}: Custom env vars: ${Object.keys(server.env).join(', ')}`);
    }

    if (server.type === 'stdio' && server.command) {
      let command = server.command;
      // Defensive: args may be non-array (e.g. boolean `true`) due to CLI parsing bugs or manual config edits
      let args = [...(Array.isArray(server.args) ? server.args : [])];

      // Sentinel: bundled cuse (computer-use) binary — resolve to the
      // platform-specific path shipped in the app bundle. If the binary is
      // missing (unsupported platform, or a dev build without the binary
      // downloaded yet), skip the MCP with a warning rather than crashing
      // the session.
      if (command === '__bundled_cuse__') {
        const { getBundledCusePath } = await import('./utils/runtime');
        const cusePath = getBundledCusePath();
        if (!cusePath) {
          console.warn(`[agent] MCP ${server.id}: bundled cuse binary not found (platform=${process.platform}); skipping. Run scripts/download_cuse.sh to install.`);
          continue;
        }
        command = cusePath;
        console.log(`[agent] MCP ${server.id}: resolved to bundled cuse at ${cusePath}`);
      }

      // For npx commands: prefer system npx → bundled Node.js npx → bun x
      // System Node.js is maintained by the user's package manager, more reliable than our bundled npm.
      // Bundled Node.js serves as fallback for users who don't have Node.js installed.
      if (command === 'npx') {
        // Pin @latest to known versions for builtin MCPs only (avoids npm registry check on startup)
        if (server.isBuiltin) {
          args = pinMcpPackageVersions(args);
        }

        // Resolve npx to full path for ALL MCPs (builtin + custom).
        // Previously custom MCPs used bare 'npx' which relied on SDK's cross-spawn
        // to find npx.cmd via filtered PATH — failed on Windows when PATH was incomplete
        // or when the SDK's env whitelist (RK_) didn't propagate Node.js directories.
        // Resolving to full path eliminates this class of issues (pit-of-success pattern).
        // Priority: system npx → bundled Node.js npx → bun x
        // eslint-disable-next-line @typescript-eslint/no-require-imports
        const { getBundledNodeDir: getNodeDir, getBundledRuntimePath, isBunRuntime, getSystemNpxPaths, findExistingPath } = require('./utils/runtime');
        const systemNpx = findExistingPath(getSystemNpxPaths());

        if (systemNpx) {
          // 1. System npx available — most reliable, user-maintained
          command = systemNpx;
          if (!args.includes('-y')) args = ['-y', ...args];
          console.log(`[agent] MCP ${server.id}: Using system npx (${systemNpx})`);
        } else {
          // 2. Fallback to bundled Node.js npx (use absolute path for deterministic resolution)
          const nodeDir = getNodeDir();
          if (nodeDir) {
            // eslint-disable-next-line @typescript-eslint/no-require-imports
            const { join: pathJoin } = require('path');
            command = process.platform === 'win32' ? pathJoin(nodeDir, 'npx.cmd') : pathJoin(nodeDir, 'npx');
            if (!args.includes('-y')) args = ['-y', ...args];
            console.log(`[agent] MCP ${server.id}: System npx not found, using bundled Node.js npx (${command})`);
          } else {
            // 3. Last resort: bun x or derive npx from system node
            const runtime = getBundledRuntimePath();
            if (isBunRuntime(runtime)) {
              command = runtime;
              // bun x doesn't use -y flag — strip only the leading -y (npx auto-confirm)
              const bunArgs = args[0] === '-y' ? args.slice(1) : args;
              args = ['x', ...bunArgs];
              console.log(`[agent] MCP ${server.id}: No Node.js found (system or bundled), falling back to bun x`);
            } else {
              // getBundledRuntimePath found a system node — derive npx from same dir
              // eslint-disable-next-line @typescript-eslint/no-require-imports
              const { dirname: pathDirname, resolve: pathResolve } = require('path');
              const npxSibling = pathResolve(pathDirname(runtime), process.platform === 'win32' ? 'npx.cmd' : 'npx');
              command = npxSibling;
              if (!args.includes('-y')) args = ['-y', ...args];
              console.log(`[agent] MCP ${server.id}: Derived npx from system node: ${npxSibling}`);
            }
          }
        }
      }

      // Build MCP config with proxy env inherited from parent Sidecar.
      // MCP subprocesses (ddg-search, edge-tts, etc.) need outbound proxy to reach
      // external APIs when the user has VPN/proxy configured. Previous approach stripped
      // ALL proxy vars to protect Playwright's localhost WebSocket — but that broke every
      // MCP that needs internet access under proxy.
      //
      // New strategy (mirrors Rust proxy_config::apply_to_subprocess):
      // - Inherit parent's proxy vars (HTTP_PROXY, HTTPS_PROXY) so outbound works
      // - ALWAYS inject NO_PROXY to protect localhost (Playwright ws, Chrome DevTools)
      // - User-defined server.env has highest priority (can override proxy)
      const mcpEnv: Record<string, string> = {};

      // Inherit proxy env from parent sidecar (if set)
      for (const proxyVar of [
        'HTTP_PROXY', 'HTTPS_PROXY', 'http_proxy', 'https_proxy',
        'ALL_PROXY', 'all_proxy',
      ]) {
        const val = process.env[proxyVar];
        if (val) mcpEnv[proxyVar] = val;
      }
      // ALWAYS inject NO_PROXY to protect localhost — prevents proxy from intercepting
      // MCP localhost WebSocket connections (e.g., playwright-core ↔ Chrome DevTools)
      mcpEnv.NO_PROXY = PROXY_NO_PROXY_VAL;
      mcpEnv.no_proxy = PROXY_NO_PROXY_VAL;

      // Copy user-defined env vars for this server (can override outbound proxy vars)
      if (server.env && Object.keys(server.env).length > 0) {
        Object.assign(mcpEnv, server.env);
      }
      // Re-enforce NO_PROXY after user env merge — user env must NOT defeat localhost protection.
      // Outbound proxy (HTTP_PROXY) can be overridden by user, but NO_PROXY is non-negotiable.
      mcpEnv.NO_PROXY = PROXY_NO_PROXY_VAL;
      mcpEnv.no_proxy = PROXY_NO_PROXY_VAL;

      // Playwright MCP: two user-selectable modes (configured in Settings UI):
      // - Isolated (--isolated): concurrent browser sessions, storage-state for login
      // - Persistent (--user-data-dir): full profile, single-session only
      // Backend just respects the args and injects --storage-state when applicable.
      if (server.id === 'playwright') {
        const hasIsolated = args.includes('--isolated');

        // In isolated mode, inject --storage-state if file exists (for login state reuse)
        if (hasIsolated) {
          const storageStatePath = join(getMyAgentsUserDir(), 'browser-storage-state.json');
          if (existsSync(storageStatePath) && !args.some((a: string) => a.startsWith('--storage-state'))) {
            args.push(`--storage-state=${storageStatePath}`);
            console.log(`[agent] MCP playwright: injecting storage-state from ${storageStatePath}`);
          }
        }
      }

      // Log full command for debugging (after Playwright arg rewrite so logs show actual args)
      console.log(`[agent] MCP ${server.id}: ${command} ${args.join(' ')}`);

      const mcpConfig: SdkMcpServerConfig = {
        command,
        args,
        env: mcpEnv,  // Always set: proxy inherited + NO_PROXY enforced
      };

      result[server.id] = mcpConfig;
    } else if ((server.type === 'sse' || server.type === 'http') && server.url) {
      // Substitute {{ENV_VAR}} placeholders in URL with values from server.env
      let resolvedUrl = server.url;
      if (server.env) {
        resolvedUrl = resolvedUrl.replace(/\{\{(\w+)\}\}/g, (_, key) => server.env?.[key] ?? '');
      }

      // Inject OAuth token as Authorization header (auto-refreshes if needed)
      // Respect user-supplied Authorization — don't overwrite if already present
      const headers = { ...server.headers };
      if (!headers['Authorization'] && !headers['authorization']) {
        const oauthHeaders = await resolveAuthHeaders(server.id);
        if (oauthHeaders['Authorization']) {
          Object.assign(headers, oauthHeaders);
          console.log(`[agent] MCP ${server.id}: OAuth token injected`);
        }
      }

      result[server.id] = {
        type: server.type,
        url: resolvedUrl,
        headers,
      };
      // Log URL with API key masked for security
      const maskedUrl = resolvedUrl.replace(/([?&]\w*[Kk]ey=)[^&]+/g, '$1***');
      console.log(`[agent] MCP ${server.id}: ${server.type} → ${maskedUrl}`);
    } else if (server.type === 'sse' || server.type === 'http') {
      console.warn(`[agent] MCP ${server.id}: Missing url for ${server.type} server, skipping`);
    }
    } catch (err) {
      // Isolate individual MCP errors — one bad config must not take down all MCPs
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`[agent] MCP ${server.id}: initialization failed, skipping: ${msg}`);
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

// PlanMode types - import from shared
import type { ExitPlanModeAllowedPrompt } from '../shared/types/planMode';
export type { ExitPlanModeRequest, EnterPlanModeRequest, ExitPlanModeAllowedPrompt } from '../shared/types/planMode';

// Pending AskUserQuestion requests waiting for user response
const pendingAskUserQuestions = new Map<string, {
  resolve: (answers: Record<string, string> | null) => void;
  input: AskUserQuestionInput;
  timer: ReturnType<typeof setTimeout>;
}>();

// Pending ExitPlanMode requests waiting for user approval
const pendingExitPlanMode = new Map<string, {
  resolve: (approved: boolean) => void;
  plan?: string;
  allowedPrompts?: ExitPlanModeAllowedPrompt[];
  timer: ReturnType<typeof setTimeout>;
}>();

// Pending EnterPlanMode requests waiting for user approval
const pendingEnterPlanMode = new Map<string, {
  resolve: (approved: boolean) => void;
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
  // Short-circuit if already aborted (addEventListener won't fire for past events)
  if (signal?.aborted) {
    throw new DOMException('Aborted', 'AbortError');
  }

  broadcast('ask-user-question:request', {
    requestId,
    questions: questionInput.questions,
    // SDK v0.2.69+: options may contain `preview` field (HTML or Markdown)
    // Our toolConfig sets previewFormat: 'html', so previews are HTML fragments
    previewFormat: 'html',
  });

  // Wait for user response or abort
  return new Promise((resolve, reject) => {
    // Timeout after 10 minutes (user needs time to think)
    const timer = setTimeout(() => {
      if (pendingAskUserQuestions.has(requestId)) {
        cleanup();
        console.warn('[AskUserQuestion] Timed out after 10 minutes');
        resolve(null);
      }
    }, 10 * 60 * 1000);

    const cleanup = () => {
      clearTimeout(timer);
      pendingAskUserQuestions.delete(requestId);
      signal?.removeEventListener('abort', onAbort);
    };

    const onAbort = () => {
      console.debug('[AskUserQuestion] Aborted by SDK signal');
      cleanup();
      // Reject with AbortError so SDK's own abort handling creates the single tool_result.
      // Previously resolve(null) caused canUseTool to return deny → duplicate tool_result
      // (one from our deny, one from SDK's internal abort) → "tool_use ids must be unique" on resume.
      reject(new DOMException('Aborted', 'AbortError'));
    };

    // Listen for SDK abort signal
    signal?.addEventListener('abort', onAbort);

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
 * Handle ExitPlanMode tool - AI submits a plan for user review
 */
async function handleExitPlanMode(
  input: unknown,
  signal?: AbortSignal
): Promise<boolean> {
  console.log('[ExitPlanMode] Requesting user approval');

  const obj = (input && typeof input === 'object' ? input : {}) as Record<string, unknown>;
  const plan = typeof obj.plan === 'string' ? obj.plan : undefined;
  const allowedPrompts = Array.isArray(obj.allowedPrompts)
    ? (obj.allowedPrompts as ExitPlanModeAllowedPrompt[])
    : undefined;

  const requestId = `exitplan_${Date.now()}_${Math.random().toString(36).slice(2)}`;

  // Short-circuit if already aborted (addEventListener won't fire for past events)
  if (signal?.aborted) {
    throw new DOMException('Aborted', 'AbortError');
  }

  broadcast('exit-plan-mode:request', { requestId, plan, allowedPrompts });

  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      if (pendingExitPlanMode.has(requestId)) {
        cleanup();
        console.warn('[ExitPlanMode] Timed out after 10 minutes');
        resolve(false);
      }
    }, 10 * 60 * 1000);

    const cleanup = () => {
      clearTimeout(timer);
      pendingExitPlanMode.delete(requestId);
      signal?.removeEventListener('abort', onAbort);
    };

    const onAbort = () => {
      console.debug('[ExitPlanMode] Aborted by SDK signal');
      cleanup();
      reject(new DOMException('Aborted', 'AbortError'));
    };

    signal?.addEventListener('abort', onAbort);
    pendingExitPlanMode.set(requestId, { resolve, plan, allowedPrompts, timer });
  });
}

/**
 * Handle user's ExitPlanMode response from frontend
 */
export function handleExitPlanModeResponse(requestId: string, approved: boolean): boolean {
  console.debug(`[ExitPlanMode] handleResponse: requestId=${requestId}, approved=${approved}`);
  const pending = pendingExitPlanMode.get(requestId);
  if (!pending) {
    console.warn(`[ExitPlanMode] Unknown request: ${requestId}`);
    return false;
  }
  clearTimeout(pending.timer);
  pendingExitPlanMode.delete(requestId);
  // Restore currentPermissionMode so applySessionConfig won't override SDK's internal state
  if (approved && prePlanPermissionMode) {
    currentPermissionMode = prePlanPermissionMode;
    prePlanPermissionMode = null;
    console.debug(`[ExitPlanMode] Restored currentPermissionMode to: ${currentPermissionMode}`);
    // Notify frontend that mode changed (plan → auto/custom/etc.)
    broadcast('chat:permission-mode-changed', { permissionMode: currentPermissionMode });
  }
  pending.resolve(approved);
  return true;
}

/**
 * Handle EnterPlanMode tool - AI requests to enter plan mode
 */
async function handleEnterPlanMode(
  _input: unknown,
  signal?: AbortSignal
): Promise<boolean> {
  console.log('[EnterPlanMode] Requesting user approval');

  const requestId = `enterplan_${Date.now()}_${Math.random().toString(36).slice(2)}`;

  // Short-circuit if already aborted (addEventListener won't fire for past events)
  if (signal?.aborted) {
    throw new DOMException('Aborted', 'AbortError');
  }

  broadcast('enter-plan-mode:request', { requestId });

  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      if (pendingEnterPlanMode.has(requestId)) {
        cleanup();
        console.warn('[EnterPlanMode] Timed out after 10 minutes');
        resolve(false);
      }
    }, 10 * 60 * 1000);

    const cleanup = () => {
      clearTimeout(timer);
      pendingEnterPlanMode.delete(requestId);
      signal?.removeEventListener('abort', onAbort);
    };

    const onAbort = () => {
      console.debug('[EnterPlanMode] Aborted by SDK signal');
      cleanup();
      reject(new DOMException('Aborted', 'AbortError'));
    };

    signal?.addEventListener('abort', onAbort);
    pendingEnterPlanMode.set(requestId, { resolve, timer });
  });
}

/**
 * Handle user's EnterPlanMode response from frontend
 */
export function handleEnterPlanModeResponse(requestId: string, approved: boolean): boolean {
  console.debug(`[EnterPlanMode] handleResponse: requestId=${requestId}, approved=${approved}`);
  const pending = pendingEnterPlanMode.get(requestId);
  if (!pending) {
    console.warn(`[EnterPlanMode] Unknown request: ${requestId}`);
    return false;
  }
  clearTimeout(pending.timer);
  pendingEnterPlanMode.delete(requestId);
  // Sync currentPermissionMode so applySessionConfig won't override SDK's plan mode
  if (approved) {
    prePlanPermissionMode = currentPermissionMode;
    currentPermissionMode = 'plan';
    console.debug(`[EnterPlanMode] Saved prePlanPermissionMode=${prePlanPermissionMode}, switched to plan`);
    broadcast('chat:permission-mode-changed', { permissionMode: 'plan' });
  }
  pending.resolve(approved);
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

  // 1.5. Auto-allow Task tool when sub-agents are configured (needed for delegation)
  if (toolName === 'Task' && currentAgentDefinitions && Object.keys(currentAgentDefinitions).length > 0) {
    console.debug(`[permission] ${toolName}: auto-allowed for sub-agent delegation`);
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

  // 4. Check if already aborted — throw so SDK's own abort handling creates a single tool_result
  if (signal?.aborted) {
    console.debug(`[permission] ${toolName}: already aborted`);
    throw new DOMException('Aborted', 'AbortError');
  }

  // 5. Request user confirmation via frontend
  console.log(`[permission] ${toolName}: requesting user confirmation (mode=${mode})`);  // Keep as info - user action needed

  const requestId = `perm_${Date.now()}_${Math.random().toString(36).slice(2)}`;

  const inputPreview = typeof input === 'object' ? JSON.stringify(input).slice(0, 500) : String(input).slice(0, 500);

  // Broadcast permission request to frontend
  broadcast('permission:request', {
    requestId,
    toolName,
    input: inputPreview,
  });

  // Forward to IM stream if active (for interactive approval cards)
  if (imStreamCallback) {
    imStreamCallback('permission-request', JSON.stringify({ requestId, toolName, input: inputPreview }));
  }

  // Wait for user response or abort
  return new Promise((resolve, reject) => {
    // Timer is declared before cleanup (same pattern as handleAskUserQuestion) so cleanup can clear it
    const timer = setTimeout(() => {
      if (pendingPermissions.has(requestId)) {
        cleanup();
        console.warn(`[permission] ${toolName}: timed out after 10 minutes, denying`);
        resolve('deny');
      }
    }, 10 * 60 * 1000);

    const cleanup = () => {
      clearTimeout(timer);
      pendingPermissions.delete(requestId);
      signal?.removeEventListener('abort', onAbort);
    };

    const onAbort = () => {
      console.debug(`[permission] ${toolName}: aborted by SDK signal`);
      cleanup();
      // Reject with AbortError so SDK's own abort handling creates the single tool_result.
      // Previously resolve('deny') caused a duplicate tool_result on abort.
      reject(new DOMException('Aborted', 'AbortError'));
    };

    // Listen for SDK abort signal
    signal?.addEventListener('abort', onAbort);

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
  } else if (decision === 'allow_once' || decision === 'always_allow') {
    if (decision === 'always_allow') {
      console.log(`[permission] ${pending.toolName}: user granted session permission`);
      sessionAlwaysAllowed.add(pending.toolName);
    } else {
      console.log(`[permission] ${pending.toolName}: user allowed once`);
    }
    pending.resolve('allow');

    // Cascade: auto-approve all other pending requests for the same tool.
    // The frontend only shows one permission card at a time. When multiple requests
    // for the same tool arrive in parallel (e.g., 3 WebSearch calls), the others
    // are invisible to the user and would be stuck until the 10-minute timeout.
    // Since the user already approved this tool (once or always), approve them all.
    for (const [otherId, otherPending] of pendingPermissions) {
      if (otherPending.toolName === pending.toolName) {
        console.log(`[permission] ${otherPending.toolName}: cascade auto-approved (requestId=${otherId})`);
        clearTimeout(otherPending.timer);
        pendingPermissions.delete(otherId);
        otherPending.resolve('allow');
      }
    }
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
  pendingExitPlanMode.clear();
  pendingEnterPlanMode.clear();
  prePlanPermissionMode = null;
}

/**
 * Get pending interactive requests (permission + ask-user-question).
 * Used to replay these to newly connected SSE clients (e.g., Tab joining shared session).
 */
export function getPendingInteractiveRequests(): Array<{
  type: 'permission:request' | 'ask-user-question:request' | 'exit-plan-mode:request' | 'enter-plan-mode:request';
  data: unknown;
}> {
  const result: Array<{ type: 'permission:request' | 'ask-user-question:request' | 'exit-plan-mode:request' | 'enter-plan-mode:request'; data: unknown }> = [];
  for (const [requestId, p] of pendingPermissions) {
    result.push({
      type: 'permission:request',
      data: {
        requestId,
        toolName: p.toolName,
        input: typeof p.input === 'object' ? JSON.stringify(p.input).slice(0, 500) : String(p.input).slice(0, 500),
      },
    });
  }
  for (const [requestId, q] of pendingAskUserQuestions) {
    result.push({
      type: 'ask-user-question:request',
      data: { requestId, questions: q.input.questions, previewFormat: 'html' },
    });
  }
  for (const [requestId, p] of pendingExitPlanMode) {
    result.push({
      type: 'exit-plan-mode:request',
      data: { requestId, plan: p.plan, allowedPrompts: p.allowedPrompts },
    });
  }
  for (const [requestId] of pendingEnterPlanMode) {
    result.push({
      type: 'enter-plan-mode:request',
      data: { requestId },
    });
  }
  return result;
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
    // Strip Playwright tool results from disk persistence (keep in-memory data for SDK context)
    const contentForDisk = typeof msg.content === 'string'
      ? msg.content
      : JSON.stringify(stripPlaywrightResults(msg.content));
    return {
      id: msg.id,
      role: msg.role,
      content: contentForDisk,
      timestamp: msg.timestamp,
      sdkUuid: msg.sdkUuid,
      attachments: msg.attachments?.map((att) => ({
        id: att.id,
        name: att.name,
        mimeType: att.mimeType,
        path: att.relativePath ?? '', // Map relativePath to path for storage
      })),
      metadata: msg.metadata,
      // Attach usage info only to the last assistant message if provided
      usage: isLastAssistant && lastAssistantUsage ? lastAssistantUsage : undefined,
      toolCount: isLastAssistant && lastAssistantToolCount ? lastAssistantToolCount : undefined,
      durationMs: isLastAssistant && lastAssistantDurationMs ? lastAssistantDurationMs : undefined,
    };
  });
  saveSessionMessages(sessionId, sessionMessages);
  // Compute lastMessagePreview from last real user message
  // (skip system-injected messages like HEARTBEAT, MEMORY_UPDATE).
  // Also track whether we found a real user message to decide lastActiveAt update.
  let lastMessagePreview: string | undefined;
  let foundRealUserMessage = false;
  for (let i = sessionMessages.length - 1; i >= 0; i--) {
    if (sessionMessages[i].role === 'user') {
      const content = sessionMessages[i].content;
      const text = typeof content === 'string' ? content : '';
      if (text.includes('<HEARTBEAT>') || text.includes('<MEMORY_UPDATE>')) {
        continue;
      }
      // Skip pure system-reminder messages (heartbeat/cron injections where the
      // ENTIRE message is <system-reminder>...</system-reminder> with no user content).
      // Mixed messages (group chat: system-reminder prefix + actual user text) are
      // real user messages and MUST update lastMessagePreview/lastActiveAt.
      if (text.startsWith('<system-reminder>')) {
        const closeTag = '</system-reminder>';
        const closeIdx = text.indexOf(closeTag);
        // Pure: no content after closing tag → skip. Mixed: has content → keep.
        if (closeIdx >= 0 && text.slice(closeIdx + closeTag.length).trim() === '') continue;
        if (closeIdx < 0) continue; // malformed, treat as system
      }
      // For group messages with <system-reminder> prefix, extract the user-visible part for preview
      let previewText = text;
      if (previewText.startsWith('<system-reminder>')) {
        const closeTag = '</system-reminder>';
        const closeIdx = previewText.indexOf(closeTag);
        if (closeIdx >= 0) previewText = previewText.slice(closeIdx + closeTag.length).trim();
      }
      lastMessagePreview = previewText.slice(0, 60) || undefined;
      foundRealUserMessage = true;
      break;
    }
  }
  // Only update lastActiveAt if a real user message exists (not just system injections).
  // This prevents heartbeat/memory-update from making stale sessions appear "active".
  updateSessionMetadata(sessionId, {
    ...(foundRealUserMessage ? { lastActiveAt: new Date().toISOString() } : {}),
    lastMessagePreview,
  });
}

export function getSessionId(): string {
  return sessionId;
}

/** Localize SDK/system error messages for IM end-users */
function localizeImError(rawError: string): string {
  if (!rawError) return '模型处理消息时出错';

  // Image content not supported by model
  if (rawError.includes('unknown variant') && rawError.includes('image')) {
    return '当前模型不支持图片，请发送文字消息';
  }
  // Model validation error (SDK rejects unknown model for the configured provider)
  if (rawError.includes('issue with the selected model')) {
    return '所选模型不可用，请检查 IM Bot 的模型和供应商配置';
  }
  // SDK subprocess crashed (Windows: anti-virus, OOM, etc.)
  if (rawError.includes('process exited with code') || rawError.includes('process terminated')) {
    return 'AI 引擎异常退出，正在自动恢复，请稍后重试';
  }
  // API authentication errors
  if (rawError.includes('authentication') || rawError.includes('unauthorized') || rawError.includes('401')) {
    return 'API 认证失败，请检查 API Key 配置';
  }
  // Billing / quota errors (check BEFORE rate_limit — quota messages may contain "429")
  if (rawError.includes('billing') || rawError.includes('insufficient_quota')
    || rawError.includes('quota_exceeded') || rawError.includes('quota exceeded')
    || rawError.includes('exceeded your current quota') || rawError.includes('payment required')) {
    return 'API 余额不足，请充值后重试';
  }
  // Rate limiting (transient — safe to retry)
  if (rawError.includes('rate_limit') || rawError.includes('429')) {
    return 'API 请求频率超限，请稍后重试';
  }
  // Server overloaded
  if (rawError.includes('overloaded') || rawError.includes('503')) {
    return 'AI 服务繁忙，请稍后重试';
  }
  // Stale session (SDK conversation data lost after Sidecar restart)
  if (rawError.includes('No conversation found')) {
    return '会话已过期，已自动重置。请重新发送消息';
  }
  // Callback replaced
  if (rawError.includes('Replaced by a newer') || rawError.includes('消息处理被新请求取代')) {
    return '消息处理被新请求取代，请重新发送';
  }
  // Default: truncate long API errors for readability
  if (rawError.length > 100) {
    return rawError.substring(0, 100) + '...';
  }
  return rawError;
}

/** Set group tool deny list for current IM request (v0.1.28) */
export function setGroupToolsDeny(tools: string[]): void {
  currentGroupToolsDeny = tools;
}

export function setImStreamCallback(cb: ImStreamCallback | null): void {
  // Defense-in-depth: if there's already an active callback when setting a new one,
  // notify the old callback with an error so its SSE stream terminates cleanly.
  // This should not happen when peer_locks are properly used, but guards against
  // silent callback replacement that would leave the old SSE stream hanging.
  if (cb !== null && imStreamCallback !== null) {
    console.warn('[agent] setImStreamCallback: replacing active callback — notifying old stream');
    imCallbackNulledDuringTurn = true;
    try {
      imStreamCallback('error', '消息处理被新请求取代');
    } catch { /* old stream may already be closed */ }
  }
  // Mark callback as stale when it's being nulled (e.g., SSE safety timeout, closeStream).
  // handleMessageComplete/Stopped checks this flag to avoid sending 'complete' to a
  // replacement callback that belongs to a different turn.
  if (cb === null && imStreamCallback !== null) {
    imCallbackNulledDuringTurn = true;
  }
  imStreamCallback = cb;
}

function resetAbortFlag(): void {
  shouldAbortSession = false;
}

export function resolveClaudeCodeCli(): string {
  const t0 = Date.now();
  // Check bundled path FIRST to avoid bun's auto-install behavior.
  // In production builds, require.resolve() can't find the SDK in node_modules
  // (it doesn't exist in the app bundle). Bun then attempts to auto-install
  // the package from npm, which blocks the event loop for 10+ minutes.
  // By checking the bundled path first, we skip the costly require.resolve entirely.
  const cwd = process.cwd();
  const bundledPath = join(cwd, 'claude-agent-sdk', 'cli.js');
  if (existsSync(bundledPath)) {
    console.log(`[sdk] CLI resolved via bundled path in ${Date.now() - t0}ms: ${bundledPath}`);
    return bundledPath;
  }
  console.warn(`[sdk] Bundled SDK not found at ${bundledPath} (cwd=${cwd}), falling back to require.resolve`);

  // Development: resolve from node_modules
  // SDK 0.2.80+ has `exports` in package.json that does NOT export `./cli.js`,
  // so require.resolve('@anthropic-ai/claude-agent-sdk/cli.js') fails with
  // ERR_PACKAGE_PATH_NOT_EXPORTED. Instead, resolve the package root via the
  // main export, then derive cli.js from the package directory.
  try {
    const sdkMain = requireModule.resolve('@anthropic-ai/claude-agent-sdk');
    // dirname(sdkMain) gives us the package root — assumes main export is in root dir.
    // This is the standard Node.js ecosystem pattern for exports-locked packages.
    const sdkDir = dirname(sdkMain);
    const cliPath = join(sdkDir, 'cli.js');
    if (!existsSync(cliPath)) {
      throw new Error(`cli.js not found at ${cliPath} (resolved SDK root: ${sdkDir})`);
    }
    if (cliPath.includes('app.asar')) {
      const unpackedPath = cliPath.replace('app.asar', 'app.asar.unpacked');
      if (existsSync(unpackedPath)) {
        console.log(`[sdk] CLI resolved via asar.unpacked in ${Date.now() - t0}ms: ${unpackedPath}`);
        return unpackedPath;
      }
    }
    console.log(`[sdk] CLI resolved via require.resolve in ${Date.now() - t0}ms: ${cliPath}`);
    return cliPath;
  } catch (error) {
    console.error(`[sdk] CLI resolve FAILED in ${Date.now() - t0}ms. Bundled: ${bundledPath}, cwd: ${cwd}`, error);
    throw error;
  }
}

/**
 * Build environment for Claude session
 * @param providerEnv - Optional provider environment override (for verification or external calls)
 */
/**
 * Auth env vars that the Claude Code CLI reads at startup. Any one of these
 * left unset (after `{...process.env}` spread + our provider branches) becomes
 * a hole that Bun's auto-dotenv loader can fill from the project workspace's
 * `.env` — for example a `.env.example`-style placeholder
 * `ANTHROPIC_API_KEY=sk-ant-your-anthropic-key-here` that an AI helpfully
 * copied over. The polluted value then reaches cli.js and surfaces as
 * "Not logged in · Please run /login".
 *
 * Fix: after all provider branches run, any var in this list that's still
 * absent gets sealed to an empty string. Verified by reading claude-code
 * source (utils/auth.ts, utils/authFileDescriptor.ts, services/api/filesApi.ts)
 * — every check is a JS truthy test (`if (process.env.X)` or
 * `process.env.X || fallback`), so empty string is semantically identical to
 * unset: OAuth keychain fallback, apiKeyHelper, and Bedrock/Vertex paths all
 * continue to work. Empty strings block Bun's dotenv merge because Bun treats
 * "key explicitly present in spawn env" as parent-wins even when the value
 * happens to be "". Smoke-tested with Bun 1.3.6 (see PR discussion).
 *
 * NOT included: CLAUDE_CONFIG_DIR — claude-code/src/utils/envUtils.ts:10 reads
 * it with `??` (nullish coalescing), so an empty string would fall through as
 * "" (not as the homedir fallback) and break the keychain service-name hash.
 * `.env` pollution of CLAUDE_CONFIG_DIR is also essentially impossible — no
 * project template ever sets a CC-internal var like that.
 */
const CC_AUTH_ENV_VARS_TO_SEAL = [
  'ANTHROPIC_API_KEY',
  'ANTHROPIC_AUTH_TOKEN',
  'ANTHROPIC_BASE_URL',
  'CLAUDE_CODE_OAUTH_TOKEN',
  'CLAUDE_CODE_OAUTH_TOKEN_FILE_DESCRIPTOR',
] as const;

/**
 * Seal CC auth env vars against Bun dotenv auto-load pollution.
 * Only fills in empty strings for vars that are currently ABSENT from env —
 * preserves any real value we or the parent shell explicitly set. See
 * `CC_AUTH_ENV_VARS_TO_SEAL` above for the full rationale.
 */
function sealCcAuthEnv(env: NodeJS.ProcessEnv): void {
  for (const key of CC_AUTH_ENV_VARS_TO_SEAL) {
    if (!(key in env)) {
      env[key] = '';
    }
  }
}

export function buildClaudeSessionEnv(providerEnv?: ProviderEnv): NodeJS.ProcessEnv {
  // Ensure essential paths are always present, even when launched from Finder
  // (Finder launches via launchd which doesn't inherit shell environment variables)
  const { home } = getCrossPlatformEnv();
  const isDebug = process.env.DEBUG === '1' || process.env.NODE_ENV === 'development';

  // Cross-platform PATH separator
  const PATH_SEP = process.platform === 'win32' ? ';' : ':';
  const PATH_KEY = process.platform === 'win32' ? 'Path' : 'PATH';

  // Detect bundled runtime directories using shared utility from runtime.ts
  const isWindows = process.platform === 'win32';
  const bundledBunDir = getBundledBunDir();
  const bundledNodeDir = getBundledNodeDir();

  // Windows directory env vars — hoisted for reuse across essentialPaths + git-bash detection
  const winProgramFiles = isWindows ? (process.env.PROGRAMFILES || 'C:\\Program Files') : '';
  const winProgramFilesX86 = isWindows ? (process.env['PROGRAMFILES(X86)'] || 'C:\\Program Files (x86)') : '';
  const winLocalAppData = isWindows ? (process.env.LOCALAPPDATA || '') : '';

  if (isDebug) {
    console.log('[env] Script directory:', getScriptDir());
    console.log(`[env] Bundled bun: ${bundledBunDir || 'NOT FOUND'}`);
    console.log(`[env] Bundled Node.js: ${bundledNodeDir || 'NOT FOUND'}`);
  }

  // Build essential paths based on platform
  const essentialPaths: string[] = [];

  // Bundled bun directory (highest priority — Sidecar/agent-browser need it)
  if (bundledBunDir) {
    essentialPaths.push(bundledBunDir);
  }

  // System Node.js directories — preferred over bundled for MCP/npm ecosystem reliability.
  // User-maintained Node.js is less likely to have broken npm than our bundled version.
  // Only add directories that actually exist to avoid polluting PATH with ghost entries.
  for (const dir of getSystemNodeDirs()) {
    if (existsSync(dir)) {
      essentialPaths.push(dir);
    }
  }

  // Bundled Node.js directory — fallback for users without system Node.js
  if (bundledNodeDir) {
    essentialPaths.push(bundledNodeDir);
  }

  // MyAgents bin directory — user-facing commands (agent-browser wrapper etc.)
  // Safe for global PATH: runtime shims (node→bun) are in ~/.myagents/shims/
  // and scoped inside each wrapper script, not exposed here.
  if (home) {
    const myagentsBinDir = isWindows
      ? resolve(home, '.myagents', 'bin')
      : `${home}/.myagents/bin`;
    essentialPaths.push(myagentsBinDir);
  }

  // System bun/runtime installations (fallback)
  if (isWindows) {
    // Windows paths
    if (home) {
      essentialPaths.push(resolve(home, '.bun', 'bin'));
    }
    // Git for Windows — SDK requires git-bash, and PATH may not include Git yet
    // (e.g. NSIS just installed Git but current process tree has stale PATH)
    for (const gp of [
      resolve(winProgramFiles, 'Git', 'cmd'),
      resolve(winProgramFilesX86, 'Git', 'cmd'),
      ...(winLocalAppData ? [resolve(winLocalAppData, 'Programs', 'Git', 'cmd')] : []),
    ]) {
      essentialPaths.push(gp);
    }
  } else {
    // macOS/Linux paths
    if (home) {
      essentialPaths.push(`${home}/.bun/bin`);
    }
    essentialPaths.push('/opt/homebrew/bin');
    essentialPaths.push('/usr/local/bin');
    essentialPaths.push('/usr/bin');
    essentialPaths.push('/bin');
  }

  const existingPath = process.env[PATH_KEY] || process.env.PATH || '';
  if (isDebug) console.log('[env] Original PATH:', existingPath.substring(0, 200) + (existingPath.length > 200 ? '...' : ''));

  const pathParts = existingPath ? existingPath.split(PATH_SEP) : [];

  // Add essential paths if not already present (in reverse order so first in list ends up first in PATH)
  // Use case-insensitive comparison on Windows since paths are case-insensitive
  const pathIncludes = (parts: string[], path: string): boolean => {
    if (isWindows) {
      const lowerPath = path.toLowerCase();
      return parts.some(p => p.toLowerCase() === lowerPath);
    }
    return parts.includes(path);
  };

  for (const p of [...essentialPaths].reverse()) {
    if (p && !pathIncludes(pathParts, p)) {
      pathParts.unshift(p);
    }
  }

  const finalPath = pathParts.join(PATH_SEP);
  if (isDebug) {
    console.log('[env] Final PATH (first 5 entries):', pathParts.slice(0, 5).join(PATH_SEP));
    console.log('[env] Bundled bun will be used:', bundledBunDir ? 'YES' : 'NO (using system bun)');
  }

  // Build base environment
  // Spread then explicitly set PATH to avoid duplicate PATH/Path keys on Windows
  // (spreading process.env into a plain object loses case-insensitivity)
  const env: NodeJS.ProcessEnv = { ...process.env };
  delete env.PATH;
  delete env.Path;
  env[PATH_KEY] = finalPath;
  // Disable SDK nonessential traffic (Statsig telemetry, Sentry error reporting, surveys).
  // MyAgents manages its own telemetry; these external connections add startup latency
  // and can timeout in restricted network environments (e.g. China).
  env.CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC = '1';
  // Disable SDK built-in cron tools (CronCreate/CronDelete/CronList).
  // MyAgents has its own persistent cron system (im-cron MCP tool → Rust CronTaskManager)
  // that survives session restarts, supports IM delivery, and uses wall-clock scheduling.
  // The SDK's cron is session-scoped/in-memory, would conflict and confuse users.
  env.CLAUDE_CODE_DISABLE_CRON = '1';
  // Disable SDK auto-loading of claude.ai proxy MCP servers.
  // MyAgents manages MCP servers through its own UI (buildSdkMcpServers).
  // SDK auto-loaded servers use "claude.ai <DisplayName>" format (sanitized to "claude_ai_<Name>"),
  // which mismatches our config IDs → checkMcpToolPermission blocks the tools.
  // See: https://github.com/hAcKlyc/MyAgents/issues/73
  env.ENABLE_CLAUDEAI_MCP_SERVERS = 'false';
  // SDK 0.2.83+: Emit session_state_changed events (idle/running/requires_action).
  // Currently used for diagnostic logging only (parallel data collection).
  // Future: may replace self-built sessionState tracking for more accurate turn boundary detection.
  env.CLAUDE_CODE_EMIT_SESSION_STATE_EVENTS = '1';
  // DO NOT set CLAUDE_CONFIG_DIR here — it would change the Keychain service name
  // and break Anthropic subscription OAuth. User-level skills are synced as symlinks
  // into project .claude/skills/ by syncProjectUserConfig() instead.

  // agent-browser: config is at ~/.agent-browser/config.json (default path, no env var needed)

  // agent-browser: bypass Rust canonicalize() UNC path issue on Windows
  // https://github.com/vercel-labs/agent-browser/issues/393
  if (isWindows) {
    const abCliPath = getAgentBrowserCliPath();
    if (abCliPath) {
      // cliPath = .../agent-browser/bin/agent-browser.js → HOME = .../agent-browser/
      env.AGENT_BROWSER_HOME = resolve(abCliPath, '..', '..');
    }
  }

  // Self-Config CLI: expose sidecar port so the `myagents` CLI can call back
  if (sidecarPort > 0) {
    env.MYAGENTS_PORT = String(sidecarPort);
  }

  // Windows: Set CLAUDE_CODE_GIT_BASH_PATH so SDK finds git-bash directly
  // without relying on which("git") in PATH (which may be stale after NSIS install)
  if (isWindows && !process.env.CLAUDE_CODE_GIT_BASH_PATH) {
    const gitBashCandidates = [
      resolve(winProgramFiles, 'Git', 'bin', 'bash.exe'),
      resolve(winProgramFilesX86, 'Git', 'bin', 'bash.exe'),
      ...(winLocalAppData ? [resolve(winLocalAppData, 'Programs', 'Git', 'bin', 'bash.exe')] : []),
    ];
    for (const candidate of gitBashCandidates) {
      if (existsSync(candidate)) {
        env.CLAUDE_CODE_GIT_BASH_PATH = candidate;
        break;
      }
    }
  }

  // Use provided providerEnv or fall back to currentProviderEnv
  const effectiveProviderEnv = providerEnv ?? currentProviderEnv;

  // ── Model alias mapping for sub-agents (applies to ALL protocol paths) ──
  // SDK sub-agents use aliases like "sonnet"/"opus"/"haiku" which resolve to claude-* model IDs.
  // For third-party providers, set ANTHROPIC_DEFAULT_*_MODEL so the SDK resolves aliases
  // to provider-specific model IDs (e.g., "sonnet" → "deepseek-chat" instead of "claude-sonnet-4-6").
  // Hoisted above the OpenAI early return so both protocol paths benefit.
  const aliases = effectiveProviderEnv?.modelAliases;
  if (aliases) {
    if (aliases.sonnet) {
      env.ANTHROPIC_DEFAULT_SONNET_MODEL = aliases.sonnet;
      env.ANTHROPIC_DEFAULT_SONNET_MODEL_NAME = aliases.sonnet; // SDK 0.2.84: display name in supportedModels()
    }
    if (aliases.opus) {
      env.ANTHROPIC_DEFAULT_OPUS_MODEL = aliases.opus;
      env.ANTHROPIC_DEFAULT_OPUS_MODEL_NAME = aliases.opus;
    }
    if (aliases.haiku) {
      env.ANTHROPIC_DEFAULT_HAIKU_MODEL = aliases.haiku;
      env.ANTHROPIC_DEFAULT_HAIKU_MODEL_NAME = aliases.haiku;
    }
    console.log(`[env] Model aliases set: sonnet=${aliases.sonnet ?? '(none)'}, opus=${aliases.opus ?? '(none)'}, haiku=${aliases.haiku ?? '(none)'}`);
  }

  // OpenAI Bridge: if provider uses OpenAI protocol, loopback to sidecar
  if (effectiveProviderEnv?.apiProtocol === 'openai' && sidecarPort > 0) {
    // SDK requests go to sidecar's /v1/messages route, which translates to OpenAI format
    env.ANTHROPIC_BASE_URL = `http://127.0.0.1:${sidecarPort}`;
    env.ANTHROPIC_API_KEY = effectiveProviderEnv.apiKey ?? '';
    delete env.ANTHROPIC_AUTH_TOKEN;
    // CRITICAL: Strip proxy env vars from subprocess environment.
    // The Claude Code CLI's MA6() unconditionally sets fetchOptions.proxy for the Anthropic
    // SDK client when any proxy env var is present, WITHOUT checking no_proxy. This causes
    // the loopback request to http://127.0.0.1:{port} to be routed through the system proxy,
    // resulting in timeout/502 errors. The subprocess only needs to talk to our local bridge;
    // the bridge handler itself handles upstream proxy if needed (via process.env).
    //
    // NOTE: SDK 0.2.111+ changed env semantics from replace ({...$.env ?? process.env})
    // to overlay ({...process.env, ...$.env}) — so `delete env[proxyVar]` no longer removes
    // the parent's proxy vars from the subprocess env. Convert deletes into explicit empty
    // strings; the CLI's proxy-from-env lookup (Yf6) uses `process.env[k] || ""` which
    // treats empty string as "not set". Same sealing pattern as sealCcAuthEnv() above.
    for (const proxyVar of [
      'http_proxy', 'HTTP_PROXY', 'https_proxy', 'HTTPS_PROXY',
      'ALL_PROXY', 'all_proxy', 'no_proxy', 'NO_PROXY',
    ]) {
      env[proxyVar] = '';
    }
    // Store upstream config for bridge handler (includes proxy from process.env for upstream fetch)
    // Note: model is NOT stored here — getOpenAiBridgeConfig() derives it from currentModel
    // to stay in sync after setSessionModel() / applySessionConfig() model switches
    currentOpenAiBridgeConfig = {
      baseUrl: effectiveProviderEnv.baseUrl ?? '',
      apiKey: effectiveProviderEnv.apiKey ?? '',
      maxOutputTokens: effectiveProviderEnv.maxOutputTokens,
      maxOutputTokensParamName: effectiveProviderEnv.maxOutputTokensParamName,
      upstreamFormat: effectiveProviderEnv.upstreamFormat,
      modelAliases: effectiveProviderEnv.modelAliases,
    };
    console.log(`[env] OpenAI bridge: ANTHROPIC_BASE_URL → loopback :${sidecarPort}, upstream → ${effectiveProviderEnv.baseUrl}, proxy vars stripped`);
    // Seal any auth var not explicitly set above (e.g. ANTHROPIC_AUTH_TOKEN
    // was deleted, CLAUDE_CODE_OAUTH_TOKEN was never touched) to an empty
    // string so Bun's auto-dotenv loader can't backfill them from the
    // workspace's .env at subprocess spawn time. See CC_AUTH_ENV_VARS_TO_SEAL
    // above for full rationale — this is the "Not logged in · Please run
    // /login" bug that triggers when a user (or an AI helping them) fills
    // out a project's .env.example with placeholder Anthropic credentials.
    sealCcAuthEnv(env);
    return env;
  }

  // Clear bridge config when not using OpenAI protocol
  currentOpenAiBridgeConfig = null;

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
        // Set AUTH_TOKEN for Authorization: Bearer header.
        // MUST also set API_KEY to the SAME value to block the SDK CLI's internal
        // key resolution chain (KH function) from falling back to keychain/config.
        // Without this, if the user ever saved an unrelated key via `claude auth set-key`,
        // the CLI would find that stale key and send it as x-api-key, causing 403.
        env.ANTHROPIC_AUTH_TOKEN = effectiveProviderEnv.apiKey;
        env.ANTHROPIC_API_KEY = effectiveProviderEnv.apiKey;
        console.log('[env] ANTHROPIC_AUTH_TOKEN + ANTHROPIC_API_KEY set (authType: auth_token)');
        break;
      case 'api_key':
        // Only set API_KEY, delete AUTH_TOKEN
        delete env.ANTHROPIC_AUTH_TOKEN;
        env.ANTHROPIC_API_KEY = effectiveProviderEnv.apiKey;
        console.log('[env] ANTHROPIC_API_KEY set (authType: api_key)');
        break;
      case 'auth_token_clear_api_key':
        // OpenRouter requires AUTH_TOKEN and API_KEY set to empty string.
        // The empty API_KEY tells the Anthropic SDK not to send x-api-key header,
        // while AUTH_TOKEN provides the actual credential via Authorization: Bearer.
        // NOTE: empty string is falsy so the CLI's KH() will still fall back to keychain.
        // This is acceptable for OpenRouter since it only checks the Bearer header.
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
    // Subscription mode: clear any previously inherited third-party apiKey so
    // the SDK falls through to keychain OAuth. NOTE: `delete` alone is NOT
    // enough — when the SDK subprocess (bun cli.js) starts with cwd set to
    // the project workspace, Bun's auto-dotenv loader will happily refill
    // any deleted key from the project's .env. `sealCcAuthEnv(env)` below
    // plugs that hole by converting the deletes into explicit empty strings,
    // which Bun treats as "parent already set this, don't override".
    delete env.ANTHROPIC_AUTH_TOKEN;
    delete env.ANTHROPIC_API_KEY;
    console.log('[env] ANTHROPIC_AUTH_TOKEN cleared (using default auth)');
  }

  // Block Bun auto-dotenv pollution of CC auth env vars before handing the
  // env off to sdk.mjs. This is the last-line-of-defense for anything the
  // branches above either deleted (subscription mode) or never set at all
  // (CLAUDE_CODE_OAUTH_TOKEN{,_FILE_DESCRIPTOR}). See CC_AUTH_ENV_VARS_TO_SEAL
  // above for the full rationale — triggering symptom is "Not logged in"
  // after a user (or an AI) fills out a project's .env.example.
  sealCcAuthEnv(env);
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
function parseSystemStatus(message: unknown): { isStatusMessage: boolean; status: string | null; permissionMode: string | null } {
  if (!message || typeof message !== 'object') {
    return { isStatusMessage: false, status: null, permissionMode: null };
  }
  const record = message as Record<string, unknown>;
  if (record.type !== 'system' || record.subtype !== 'status') {
    return { isStatusMessage: false, status: null, permissionMode: null };
  }
  // SDK 0.2.108+: emits status:'requesting' before every API request when includePartialMessages is on.
  // Treat as transient/no-op — we already surface thinking/streaming via partial message events,
  // and propagating it would flash the send button into a disabled state on every tool-call round trip.
  const statusValue = typeof record.status === 'string' ? record.status : null;
  if (statusValue === 'requesting') {
    return { isStatusMessage: false, status: null, permissionMode: null };
  }
  // This IS a status message, status can be 'compacting' or null, permissionMode can be 'plan'/'acceptEdits'/etc.
  return {
    isStatusMessage: true,
    status: statusValue,
    permissionMode: typeof record.permissionMode === 'string' ? record.permissionMode : null,
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
  // Safety net: flush any remaining pending mid-turn messages before creating
  // a new assistant. Primary flush happens in start handlers and handleMessageComplete().
  flushPendingMidTurnQueue();
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
  flushPendingMidTurnQueue();
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
  thought_signature?: string;
}): void {
  flushPendingMidTurnQueue();
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

  // Track browser tool usage for storage-state auto-save
  // MCP tool names follow pattern: mcp__playwright__browser_*
  if (tool.name.startsWith('mcp__playwright__browser_')) {
    sessionBrowserToolUsed = true;
    if (tool.name === 'mcp__playwright__browser_storage_state') {
      sessionStorageStateSaved = true;
    }
  }
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
  flushPendingMidTurnQueue();
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
    thought_signature?: string;
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
  // Flush pending mid-turn messages BEFORE marking streaming as done.
  flushPendingMidTurnQueue();
  isStreamingMessage = false;
  // Notify IM stream: turn complete — only if callback was NOT nulled/replaced during this turn.
  // A nulled callback means the SSE stream timed out and a new one may have been set for a
  // subsequent queued message; firing 'complete' here would consume the wrong stream.
  if (imStreamCallback && !imCallbackNulledDuringTurn) {
    imStreamCallback('complete', '');
    imStreamCallback = null;
  }
  // 跨回合状态清理（持久 session 下多回合共享同一个 for-await 循环）
  // SDK 的 stream event index 是 per-message 的，不同回合的 index 可能冲突
  streamIndexToToolId.clear();
  streamIndexToBlockType.clear();
  toolResultIndexToId.clear();
  childToolToParent.clear();
  imTextBlockIndices.clear();

  clearCronTaskContext();
  // NOTE: Do NOT clearImMediaContext() here — im-media is per-Sidecar context (re-set on each
  // /api/im/chat call). Clearing it between turns causes im-media to be missing from
  // buildSdkMcpServers() if the session restarts (MCP change, error recovery, etc.).
  // It is still cleared on full session termination (see below).

  // Force-close any unclosed thinking blocks (parity with handleMessageStopped).
  // If content_block_stop was lost (transport issue, subagent edge case, or API error),
  // the thinking block stays incomplete and the frontend timer runs indefinitely.
  // This safety net ensures thinking state is always consistent at turn boundary.
  const lastMsg = messages[messages.length - 1];
  if (lastMsg?.role === 'assistant' && typeof lastMsg.content !== 'string') {
    let patched = false;
    lastMsg.content = lastMsg.content.map((block) => {
      if (block.type === 'thinking' && !block.isComplete) {
        patched = true;
        return {
          ...block,
          isComplete: true,
          thinkingDurationMs: block.thinkingStartedAt ? Date.now() - block.thinkingStartedAt : undefined
        };
      }
      return block;
    });
    if (patched) {
      console.warn('[agent] Force-closed orphaned thinking block(s) in handleMessageComplete');
    }
  }

  // Transition to idle only when no queued messages remain.
  // With mid-turn injection, the generator is always at waitForMessage() after yield
  // (no waitForTurnComplete gate). Queued messages are delivered via wakeGenerator()
  // at enqueue time, so the generator drains them naturally. No need to dequeue here.
  if (messageQueue.length === 0) {
    setSessionState('idle');
  }

  // Calculate duration for this turn
  const durationMs = currentTurnStartTime ? Date.now() - currentTurnStartTime : undefined;

  // Persist messages with usage info after AI response completes
  persistMessagesToStorage({
    inputTokens: currentTurnUsage.inputTokens,
    outputTokens: currentTurnUsage.outputTokens,
    cacheReadTokens: currentTurnUsage.cacheReadTokens || undefined,
    cacheCreationTokens: currentTurnUsage.cacheCreationTokens || undefined,
    model: currentTurnUsage.model,
    modelUsage: currentTurnUsage.modelUsage,
  }, currentTurnToolCount, durationMs);
}

function handleMessageStopped(): void {
  // Flush pending mid-turn messages before marking done (same as handleMessageComplete).
  flushPendingMidTurnQueue();
  isStreamingMessage = false;
  // Notify IM stream: turn complete (stopped) — cross-turn guard prevents misfire
  if (imStreamCallback && !imCallbackNulledDuringTurn) {
    imStreamCallback('complete', '');
    imStreamCallback = null;
  }
  // 跨回合状态清理（与 handleMessageComplete 保持一致）
  streamIndexToToolId.clear();
  streamIndexToBlockType.clear();
  toolResultIndexToId.clear();
  childToolToParent.clear();
  imTextBlockIndices.clear();
  clearCronTaskContext();


  // Only transition to idle if no queued messages waiting (same logic as handleMessageComplete)
  if (messageQueue.length === 0) {
    setSessionState('idle');
  }
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
  // Flush pending mid-turn messages before marking done (same as handleMessageComplete).
  flushPendingMidTurnQueue();
  isStreamingMessage = false;
  // Notify IM stream: localized error
  if (imStreamCallback) {
    imStreamCallback('error', localizeImError(error));
    imStreamCallback = null;
  }
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

/** Sentinel value for stripped Playwright tool results (truthy, so ProcessRow sees tool as complete) */
const PLAYWRIGHT_RESULT_SENTINEL = '[playwright_result_stripped]';

/** Set of tool_use IDs whose results are stripped from frontend broadcast in the current turn */
const strippedToolResultIds = new Set<string>();

function isPlaywrightTool(toolUseId: string): boolean {
  const toolBlock = findToolBlockById(toolUseId);
  return toolBlock?.tool.name.startsWith('mcp__playwright__') ?? false;
}

/**
 * Strip Playwright tool results from ContentBlock[] for frontend/persistence.
 * Replaces tool.result with a sentinel so ProcessRow still sees the tool as complete.
 * Keeps in-memory SDK data intact for conversation context.
 */
export function stripPlaywrightResults(content: ContentBlock[]): ContentBlock[] {
  return content.map(block => {
    if (
      block.type === 'tool_use' &&
      block.tool?.name.startsWith('mcp__playwright__') &&
      block.tool.result &&
      block.tool.result !== PLAYWRIGHT_RESULT_SENTINEL
    ) {
      return { ...block, tool: { ...block.tool, result: PLAYWRIGHT_RESULT_SENTINEL } };
    }
    return block;
  });
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

function extractAgentError(sdkMessage: unknown): string | null {
  if (!sdkMessage || typeof sdkMessage !== 'object') {
    return null;
  }
  // Only check the SDK-level .error field — this is set when the SDK itself encounters
  // an error (auth failure, network error, etc.). Do NOT scan assistant message content
  // for error-like keywords, because the AI may legitimately discuss errors in its analysis
  // (e.g. "Feishu API error code 99991672") which would cause false-positive agent-error banners.
  const candidate = (sdkMessage as { error?: unknown }).error;
  if (candidate) {
    let errorStr: string;
    if (typeof candidate === 'string') {
      errorStr = candidate;
    } else {
      try {
        errorStr = JSON.stringify(candidate);
      } catch {
        errorStr = String(candidate);
      }
    }

    // Try to get a more descriptive message from assistant content or result field
    let detail: string | null = null;
    if ('message' in sdkMessage) {
      const assistantMessage = (sdkMessage as { message?: { content?: unknown } }).message;
      const contentText = formatAssistantContent(assistantMessage?.content);
      if (contentText) {
        detail = contentText;
      }
    }
    if (!detail && 'result' in sdkMessage) {
      const result = (sdkMessage as { result?: unknown }).result;
      if (typeof result === 'string' && result.length > 0) {
        detail = result;
      }
    }

    if (detail) {
      return `${errorStr}: ${detail}`;
    }
    return errorStr;
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

// Last agent error — captured from SDK error events for heartbeat error reporting.
// Set by the SDK message handler, consumed (cleared) by the heartbeat endpoint.
let lastAgentError: string | null = null;

export function getAndClearLastAgentError(): string | null {
  const err = lastAgentError;
  lastAgentError = null;
  return err;
}

/**
 * Internal: Clear all message-related state
 * Used by both resetSession() and initializeAgent()
 */
function clearMessageState(): void {
  messages.length = 0;
  messageQueue.length = 0;
  pendingMidTurnQueue.length = 0;
  streamIndexToToolId.clear();
  streamIndexToBlockType.clear();
  toolResultIndexToId.clear();
  childToolToParent.clear();
  imTextBlockIndices.clear();

  strippedToolResultIds.clear();
  currentSessionUuids.clear();
  liveSessionUuids.clear();
  isStreamingMessage = false;
  messageSequence = 0;
  pendingConfigRestart.clear();
  // Reset browser tool tracking for new session
  sessionBrowserToolUsed = false;
  sessionStorageStateSaved = false;
}

/** 排空消息队列，逐条广播 queue:cancelled。用于 session 意外死亡时通知前端清除队列 UI。 */
function drainQueueWithCancellation(): void {
  if (messageQueue.length === 0) return;
  console.log(`[agent] Draining ${messageQueue.length} queued messages (session dead)`);
  for (const item of messageQueue) {
    item.resolve();
    broadcast('queue:cancelled', { queueId: item.id });
  }
  messageQueue.length = 0;
}

/**
 * Load persisted messages from SessionMessage[] into in-memory messages[].
 * Sets messageSequence to continue from the last stored message ID.
 * Used by initializeAgent (resume) and switchToSession to restore conversation state.
 */
function loadMessagesFromStorage(storedMessages: SessionMessage[]): void {
  for (const storedMsg of storedMessages) {
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
    messages.push({
      id: storedMsg.id,
      role: storedMsg.role,
      content: parsedContent,
      timestamp: storedMsg.timestamp,
      sdkUuid: storedMsg.sdkUuid,
      attachments: storedMsg.attachments?.map((att) => ({
        id: att.id,
        name: att.name,
        size: 0,
        mimeType: att.mimeType,
        relativePath: att.path,
      })),
      metadata: storedMsg.metadata,
    });
  }
  // Update messageSequence to continue from the last message
  if (storedMessages.length > 0) {
    const lastMsgId = storedMessages[storedMessages.length - 1].id;
    const parsedId = parseInt(lastMsgId, 10);
    if (!isNaN(parsedId)) {
      messageSequence = parsedId + 1;
    }
  }

  // Seed currentSessionUuids from disk messages so that rewind works immediately
  // after loading a resume session (before SDK system_init populates them at runtime).
  // Without this, rewinding during pre-warm window fails UUID validation → new session → context lost.
  // Safe because sessionRegistered=true means we're resuming the same session ID.
  for (const msg of messages) {
    if (msg.sdkUuid) {
      currentSessionUuids.add(msg.sdkUuid);
    }
  }

  // Seed Bridge thought_signature cache from persisted tool_use blocks
  // (Gemini thinking models require round-tripping this field; the cache is lost on sidecar restart)
  const thoughtSigEntries: Array<{ id: string; thought_signature: string }> = [];
  for (const msg of messages) {
    if (Array.isArray(msg.content)) {
      for (const block of msg.content) {
        if (block.type === 'tool_use' && block.tool?.thought_signature) {
          thoughtSigEntries.push({ id: block.tool.id, thought_signature: block.tool.thought_signature });
        }
      }
    }
  }
  if (thoughtSigEntries.length > 0) {
    seedBridgeThoughtSignatures(thoughtSigEntries);
  }
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

  const endReset = beginReset();
  try {
  // 1. Properly terminate the SDK session (same pattern as switchToSession)
  // Must abort persistent session so the generator exits and subprocess terminates
  if (querySession || sessionTerminationPromise) {
    console.log('[agent] resetSession: terminating existing SDK session');
    abortPersistentSession();
    messageQueue.length = 0; // Clear queue so old session doesn't pick up stale messages

    await awaitSessionTermination(10_000, 'resetSession');
    console.log('[agent] resetSession: SDK session terminated (or timed out)');
    querySession = null;
  }

  // 1b. Persist in-memory messages from the old session before clearing.
  // If streaming was aborted mid-turn, handleMessageComplete was never called,
  // so these messages exist only in memory. Persist them to prevent data loss
  // in the old session (user may revisit it from history).
  // sessionId still points to the OLD session here (updated in step 3).
  if (messages.length > 0) {
    console.log(`[agent] resetSession: persisting ${messages.length} in-memory messages before clearing`);
    persistMessagesToStorage();
  }

  // 2. Clear all message state (shared with initializeAgent)
  clearMessageState();

  // 3. Generate new session ID (don't persist yet - wait for first message)
  sessionId = randomUUID();
  hasInitialPrompt = false; // Reset so first message creates a new session in SessionStore

  // 4. Clear SDK resume state - CRITICAL: prevents SDK from resuming old context!
  sessionRegistered = false;
  pendingResumeSessionAt = undefined; // Prevent leaking rewind state to new session
  messageResolver = null;
  systemInitInfo = null; // Clear old system info so new session gets fresh init

  // 4b. Keep currentAgentDefinitions — agents are workspace-level config, not session state.
  // Clearing them here causes a race: pre-warm fires before frontend re-syncs agents,
  // so referenced global agents (only available via programmatic injection) are lost.
  // See: https://github.com/hAcKlyc/MyAgents/issues/13

  // 5. Clear SDK ready signal state (same as switchToSession)
  _sdkReadyResolve = null;
  _sdkReadyPromise = null;

  // 6. Clear pre-warm state
  isPreWarming = false;
  preWarmFailCount = 0;
  if (preWarmTimer) { clearTimeout(preWarmTimer); preWarmTimer = null; }

  // 7. Reset processing state
  shouldAbortSession = false;
  isProcessing = false;
  setSessionState('idle');

  // 8. Clear session-scoped permissions
  clearSessionPermissions();

  // 9. Broadcast empty state to frontend
  broadcast('chat:init', { agentDir, sessionState: 'idle', hasInitialPrompt: false });

  console.log('[agent] resetSession: complete, new sessionId=' + sessionId);

  // Pre-warm with fresh session so next message is fast
  schedulePreWarm();
  } finally {
    endReset();
  }
}

/**
 * Recover from a stale SDK session without wiping the user's view.
 *
 * Trigger: SDK returned `is_error` with "No conversation found" while trying
 * to `--resume` a session that exists in SessionStore. The conversation data
 * on the SDK side is gone (external claude binary, old build, user ran
 * `claude /clear`, or the project file was never there for sessions created
 * by a different tool), but our SessionStore JSONL is intact and the user
 * is already looking at the loaded history.
 *
 * The default recovery path (`resetSession`) is too aggressive for this
 * scenario — it generates a fresh sessionId and broadcasts `chat:init`,
 * which on the frontend wipes the visible message list and effectively
 * "loses" the session the user just opened. This recovery keeps sessionId
 * and the in-memory / on-disk message history intact, tears down the
 * failed SDK subprocess, and pre-warms a new one that will reuse the same
 * sessionId without `--resume` on its next query. User-visible effect:
 * the 28 loaded messages stay on screen, next user message starts a brand
 * new conversation inside the same session timeline. AI won't remember the
 * earlier turns — accepted trade-off vs. silently destroying the view.
 *
 * Subset of resetSession's cleanup: subprocess teardown, resume disarm,
 * pre-warm reset, pre-warm reschedule. NO sessionId change, NO chat:init
 * broadcast, NO clearMessageState, NO permission reset.
 */
async function recoverFromStaleSession(): Promise<void> {
  const endReset = beginReset();
  try {
    // 1. Terminate the failed SDK subprocess (same pattern as resetSession).
    //    Without this, the next user message would reuse the same broken
    //    subprocess and hit the same "No conversation found" on its next
    //    internal SDK turn.
    if (querySession || sessionTerminationPromise) {
      console.log('[agent] recoverFromStaleSession: terminating failed SDK subprocess');
      abortPersistentSession();
      messageQueue.length = 0;
      await awaitSessionTermination(10_000, 'recoverFromStaleSession');
      querySession = null;
    }

    // 2. Disarm resume so the pre-warm / next query starts a fresh SDK
    //    conversation. effectiveSdkSessionId still resolves to the current
    //    sessionId (see startStreamingSession UUID path), so the session
    //    identity is preserved end-to-end.
    sessionRegistered = false;
    pendingResumeSessionAt = undefined;

    // 3. Reset SDK ready signal + pre-warm bookkeeping (mirrors resetSession
    //    steps 5-7 but does NOT clear messages/permissions/sessionId).
    _sdkReadyResolve = null;
    _sdkReadyPromise = null;
    isPreWarming = false;
    preWarmFailCount = 0;
    if (preWarmTimer) { clearTimeout(preWarmTimer); preWarmTimer = null; }
    shouldAbortSession = false;
    isProcessing = false;
    setSessionState('idle');

    // 4. Pre-warm a fresh SDK session with the same sessionId, no --resume.
    schedulePreWarm();

    console.log(`[agent] recoverFromStaleSession: complete, sessionId=${sessionId} preserved`);
  } finally {
    endReset();
  }
}

/**
 * Initialize agent with a new working directory
 * Called when switching to a different project/workspace
 */
export async function initializeAgent(
  nextAgentDir: string,
  initialPrompt?: string | null,
  initialSessionId?: string,
  options?: { preWarmDisabled?: boolean },
): Promise<void> {
  if (options?.preWarmDisabled) {
    preWarmDisabled = true;
    console.log('[agent] pre-warm disabled via --no-pre-warm (Global Sidecar)');
  }
  agentDir = nextAgentDir;
  hasInitialPrompt = Boolean(initialPrompt && initialPrompt.trim());
  systemInitInfo = null;

  if (initialSessionId) {
    // Use caller-specified session_id (IM / Tab opening existing session / CronTask)
    sessionId = initialSessionId as typeof sessionId;

    // Check if this session has any prior metadata → decide resume vs create.
    // We check for metadata existence (not just sdkSessionId) because sdkSessionId
    // is only written after system_init succeeds. If the previous Bun process crashed
    // before system_init, metadata exists (with unifiedSession:true) but sdkSessionId
    // is absent — yet the SDK session directory already exists on disk.
    const meta = getSessionMetadata(initialSessionId);
    if (meta) {
      // Cross-runtime guard: if session was created by a DIFFERENT runtime than the current one,
      // attempting to resume would fail (SDK: "No conversation found", CC/Codex: unknown session ID).
      // Covers all mismatch combinations: builtin↔CC, builtin↔Codex, CC↔Codex.
      const currentRuntimeType = getCurrentRuntimeType();
      const isCrossRuntime = meta.runtime && meta.runtime !== currentRuntimeType;
      if (isCrossRuntime) {
        sessionRegistered = false;
        console.log(`[agent] initializeAgent: cross-runtime session ${initialSessionId} (created by ${meta.runtime}, current=${currentRuntimeType}), will NOT resume`);
      } else {
        sessionRegistered = true;
        console.log(`[agent] initializeAgent: will resume session ${initialSessionId} (sdkSessionId=${meta.sdkSessionId ?? 'unknown'})`);
      }
    } else {
      sessionRegistered = false;
      console.log(`[agent] initializeAgent: will create new session ${initialSessionId}`);
    }
  } else {
    // No specified ID → auto-generate (standard Tab new conversation flow)
    sessionId = randomUUID();
    sessionRegistered = false; // Fresh session, no SDK data to resume
  }

  // Clear message state (shared with resetSession)
  clearMessageState();

  // For resume sessions: load existing messages from disk into memory.
  // This is critical for shared Sidecar (IM + Desktop Tab):
  // 1. SSE replay (chat:message-replay) includes old messages when Tab connects
  // 2. messageSequence continues from last ID (prevents ID collision with disk messages)
  // 3. saveSessionMessages incremental append works correctly (messages.slice(existingCount))
  // Same pattern as switchToSession's message loading.
  // Also load for cross-runtime sessions (sessionRegistered=false but messages exist for display).
  if (initialSessionId && getSessionMetadata(initialSessionId)) {
    const sessionData = getSessionData(initialSessionId);
    if (sessionData?.messages?.length) {
      loadMessagesFromStorage(sessionData.messages);
      console.log(`[agent] initializeAgent: loaded ${sessionData.messages.length} existing messages, messageSequence=${messageSequence}`);
    }
  }

  // Initialize logger for new session (lazy file creation)
  initLogger(sessionId);
  console.log(`[agent] init dir=${agentDir} initialPrompt=${hasInitialPrompt ? 'yes' : 'no'} sessionId=${sessionId} resume=${sessionRegistered}`);

  // Start file watcher for workspace directory changes → SSE push to frontend.
  // Watcher is workspace-scoped (survives session restarts). startFileWatcher()
  // deduplicates if already watching the same path.
  startFileWatcher(agentDir);

  // Self-resolve workspace config from disk (MCP/provider/model).
  // Eliminates dependency on pre-serialized snapshots (providerEnvJson, mcpServersJson)
  // that can fail to save or go stale. IM Bot sessions work correctly without the
  // frontend having been opened first. For desktop Tabs, the frontend's /api/mcp/set
  // and per-message providerEnv will override these values.
  // Skip for Global Sidecar (no workspace-specific config).
  if (!preWarmDisabled) {
    try {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const { resolveWorkspaceConfig } = require('./utils/admin-config');
      const resolved = resolveWorkspaceConfig(agentDir);
      // Only self-resolve MCP for sessions with initialPrompt (IM/Cron).
      // Tab sessions must NOT self-resolve: the frontend's /api/mcp/set is the
      // authoritative source, and self-resolve produces slightly different field
      // structures (env/args) that trigger a fingerprint mismatch → abort → 30s delay.
      if (hasInitialPrompt && currentMcpServers === null && resolved.mcpServers.length > 0) {
        currentMcpServers = resolved.mcpServers;
        console.log(`[agent] self-resolved ${resolved.mcpServers.length} MCP server(s): ${resolved.mcpServers.map((s: { id: string }) => s.id).join(', ')}`);
      }
      if (!currentProviderEnv && resolved.providerEnv) {
        currentProviderEnv = resolved.providerEnv;
        console.log(`[agent] self-resolved provider: ${resolved.providerEnv.baseUrl ?? 'anthropic'}`);
      }
      // Only self-resolve model for builtin runtime. External runtimes (CC/Codex) should use
      // their own model (set via /api/model/set from frontend runtimeModel effect).
      // agent.model is the builtin model (e.g. "glm-5.1") and must NOT be sent to CC/Codex. See: #71
      if (!currentModel && resolved.model && !isExternalRuntime(getCurrentRuntimeType())) {
        currentModel = resolved.model;
        console.log(`[agent] self-resolved model: ${resolved.model}`);
      }
    } catch (error) {
      // Self-resolution failure is non-fatal — fall back to external sync (Rust sync_ai_config)
      console.warn('[agent] self-resolution failed, falling back to external sync:', error);
    }
  }

  if (hasInitialPrompt) {
    void enqueueUserMessage(initialPrompt!.trim());
  } else {
    // Pre-warm subprocess + MCP so first message is fast.
    // Only start immediately if MCP is already resolved (IM Bot sessions that
    // self-resolved from disk). For Tab sessions, the frontend will call
    // /api/mcp/set shortly after connecting, which triggers schedulePreWarm()
    // with the authoritative config. This avoids the race where self-resolve
    // and frontend produce slightly different MCP fingerprints, causing an
    // unnecessary abort + 30s restart loop.
    if (currentMcpServers !== null) {
      schedulePreWarm();
    }
  }
}

/**
 * Switch to an existing session for resume functionality
 * This terminates the current session and prepares to resume from the target session
 * 
 * Key behavior:
 * - Preserves target sessionId so messages are saved to the same session
 * - Sets sessionRegistered if sdkSessionId exists so SDK continues conversation context
 * - If no sdkSessionId exists (old session), starts fresh but keeps same session ID
 */
export async function switchToSession(targetSessionId: string): Promise<boolean> {
  console.log(`[agent] switchToSession: ${targetSessionId}`);

  // Skip if already on the target session — prevents aborting an active streaming task
  // when frontend calls loadSession on the same session (e.g., after cron timeout)
  if (targetSessionId === sessionId) {
    console.log(`[agent] switchToSession: already on session ${targetSessionId}, skipping`);
    return true;
  }

  // Get the target session metadata to find SDK session_id
  const sessionMeta = getSessionMetadata(targetSessionId);
  if (!sessionMeta) {
    console.error(`[agent] switchToSession: session ${targetSessionId} not found`);
    return false;
  }

  const endReset = beginReset();
  try {
  // Properly terminate the old session if one is running
  // Must abort persistent session so the generator exits and subprocess terminates
  // Otherwise the old session continues processing messages with stale settings
  if (querySession || sessionTerminationPromise) {
    console.log('[agent] switchToSession: aborting current session');
    abortPersistentSession();
    messageQueue.length = 0; // Clear queue before waiting so old session doesn't pick up stale messages
    await awaitSessionTermination(10_000, 'switchToSession');
    querySession = null;
  }

  // Persist current in-memory messages before clearing to prevent data loss
  // (e.g., if an active streaming session accumulated messages not yet saved to disk)
  if (messages.length > 0) {
    console.log(`[agent] switchToSession: persisting ${messages.length} in-memory messages before clearing`);
    persistMessagesToStorage();
  }

  // Reset message/queue/streaming state (shared with initializeAgent, resetSession)
  clearMessageState();

  // Reset session-level runtime state
  shouldAbortSession = false;
  isProcessing = false;
  sessionRegistered = false; // Will re-set from sessionMeta below
  pendingResumeSessionAt = undefined; // Prevent leaking rewind state to different session
  messageResolver = null;
  setSessionState('idle');
  systemInitInfo = null;

  // Clear SDK ready signal state
  _sdkReadyResolve = null;
  _sdkReadyPromise = null;

  // Clear pre-warm state from old session
  isPreWarming = false;
  preWarmFailCount = 0;
  if (preWarmTimer) { clearTimeout(preWarmTimer); preWarmTimer = null; }

  // Preserve target sessionId so new messages are saved to the same session
  sessionId = targetSessionId as `${string}-${string}-${string}-${string}-${string}`;

  // Load existing messages from storage into memory
  // This is critical for incremental save logic in saveSessionMessages
  const sessionData = getSessionData(targetSessionId);
  if (sessionData?.messages?.length) {
    loadMessagesFromStorage(sessionData.messages);
    console.log(`[agent] switchToSession: loaded ${sessionData.messages.length} existing messages`);
  }

  // Set sessionRegistered based on whether SDK has this session
  if (sessionMeta.sdkSessionId) {
    // SDK 已注册此 session，后续 query 必须用 resume
    sessionRegistered = true;
    console.log(`[agent] switchToSession: will resume session ${sessionId}`);
  } else {
    // 从未 query 过的 session，用 sessionId 创建
    sessionRegistered = false;
    console.warn(`[agent] switchToSession: no SDK session_id, will start fresh`);
  }

  // Update agentDir from session
  if (sessionMeta.agentDir) {
    agentDir = sessionMeta.agentDir;
  }

  // Initialize logger for the target session (lazy file creation)
  initLogger(sessionId);

  // Session already exists, skip first-message session creation logic
  hasInitialPrompt = true;

  console.log(`[agent] switchToSession: ready, agentDir=${agentDir}, sessionRegistered=${sessionRegistered}`);

  // Pre-warm with resumed session so subprocess + MCP are ready before user types
  schedulePreWarm();
  return true;
  } finally {
    endReset();
  }
}

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
      // If currently in plan mode (prePlanPermissionMode is set), update the saved mode
      // so that exiting plan mode restores the user's LATEST choice, not the stale one.
      if (prePlanPermissionMode) {
        prePlanPermissionMode = newPermissionMode;
        console.log(`[agent] updated prePlanPermissionMode to: ${newPermissionMode}`);
      }
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

export type EnqueueResult = {
  queued: boolean;   // true if message was queued (not immediately processed)
  queueId?: string;  // queue item ID, present when queued=true
  error?: string;    // present when queue is full or other rejection
};

export async function enqueueUserMessage(
  text: string,
  images?: ImagePayload[],
  permissionMode?: PermissionMode,
  model?: string,
  providerEnv?: ProviderEnv | 'subscription',
  metadata?: { source: SessionSource; sourceId?: string; senderName?: string },
): Promise<EnqueueResult> {
  // 等待进行中的 resetSession/switchToSession 完成，防止消息投递到已死的 generator
  // 这些函数是异步的（await sessionTerminationPromise 需要数秒），
  // 在此期间投递的消息会被随后的 clearMessageState() 清除导致消息丢失
  if (resetPromise) {
    console.log('[agent] enqueueUserMessage: waiting for session reset to complete...');
    await resetPromise;
    console.log('[agent] enqueueUserMessage: session reset completed, proceeding');
  }

  // 等待进行中的时间回溯完成，防止并发写入 messages/session 状态
  if (rewindPromise) {
    await rewindPromise;
  }

  const trimmed = text.trim();
  const hasImages = images && images.length > 0;

  if (!trimmed && !hasImages) {
    return { queued: false };
  }

  // Session is "busy" if AI is streaming OR there are pending messages in the queue.
  // This prevents config changes and turn-usage resets during the brief gap between turns.
  const isSessionBusy = isTurnInFlight() || shouldAbortSession || isInterruptingResponse || messageQueue.length > 0;

  // Reset turn usage tracking — only for direct (non-queued) messages.
  // For queued messages, this is done in messageGenerator when the item is yielded,
  // to avoid corrupting the in-flight turn's usage counters.
  if (!isSessionBusy) {
    resetTurnUsage();
    currentTurnStartTime = Date.now();
  }

  // Provider env semantics (pit-of-success pattern — safe default for all callers):
  //   undefined        → "no change, keep current provider" (IM/Cron/Heartbeat/internal callers)
  //   'subscription'   → "switch to Anthropic subscription" (only from desktop)
  //   ProviderEnv obj  → "use this specific provider" (desktop or Rust with explicit provider)
  // This prevents IM/Cron callers from accidentally triggering subscription switch
  // when they simply don't have provider info to forward (the original "Not logged in" bug).
  const effectiveProviderEnv: ProviderEnv | undefined = providerEnv === undefined
    ? currentProviderEnv                                         // undefined → keep current (safe default)
    : (providerEnv === 'subscription' ? undefined : providerEnv); // 'subscription' → clear, object → use it

  // Check if provider has changed (requires session restart since environment vars can't be updated)
  // SKIP for queued messages: provider/model changes during streaming would cause a session
  // restart that wipes the queue and races with the active stream. Queued messages inherit
  // the current session's provider/model configuration.
  const switchingToSubscription = !isSessionBusy && providerEnv === 'subscription' && currentProviderEnv;
  const baseUrlChanged = switchingToSubscription ||
    (!isSessionBusy && effectiveProviderEnv && effectiveProviderEnv.baseUrl !== currentProviderEnv?.baseUrl);
  const providerChanged = baseUrlChanged || (!isSessionBusy && effectiveProviderEnv && (
    effectiveProviderEnv.apiKey !== currentProviderEnv?.apiKey
  ));

  if (providerChanged && querySession) {
    const fromLabel = currentProviderEnv?.baseUrl ?? 'anthropic';
    const toLabel = effectiveProviderEnv?.baseUrl ?? 'anthropic';
    if (isDebugMode) console.log(`[agent] provider changed from ${fromLabel} to ${toLabel}, restarting session`);

    // Resume logic: entering a provider that validates signed session history from one that
    // doesn't requires a fresh session. All other transitions can safely resume.
    // Note: Desktop Chat also shows a ConfirmDialog for this case (see Chat.tsx), but this
    // backend guard is defense-in-depth for non-frontend callers (IM Bot, Cron, Agent Channel).
    const currentRequiresSignedHistory = requiresSignedSessionHistory(currentProviderEnv);
    const nextRequiresSignedHistory = requiresSignedSessionHistory(effectiveProviderEnv);
    if (!currentRequiresSignedHistory && nextRequiresSignedHistory) {
      sessionRegistered = false;
      sessionId = randomUUID();
      hasInitialPrompt = false;
      messages.length = 0;
      systemInitInfo = null;
      console.log('[agent] Fresh session: third-party → Anthropic (signature incompatible)');
    }

    // Update provider env BEFORE terminating so the new session picks it up
    currentProviderEnv = effectiveProviderEnv; // undefined for subscription, object for API
    // Terminate current session - it will restart automatically when processing the message
    abortPersistentSession();
    // Wait for the current session to fully terminate before proceeding
    // This prevents race conditions where old session continues processing
    await awaitSessionTermination(10_000, 'enqueueUserMessage/providerChange');
    querySession = null;
    isProcessing = false;
    setSessionState('idle');
    // Clear message queue to avoid duplicate messages
    // The current message will be added to the queue below
    messageQueue.length = 0;
    // Clear stream state mappings (will be rebuilt by new session)
    streamIndexToToolId.clear();
    toolResultIndexToId.clear();
    imTextBlockIndices.clear();

    if (isDebugMode) console.log(`[agent] session terminated for provider switch`);
  } else if (effectiveProviderEnv) {
    // Provider not changed (or first message with API provider), just update tracking
    currentProviderEnv = effectiveProviderEnv;
    if (isDebugMode) console.log(`[agent] provider env set: baseUrl=${effectiveProviderEnv.baseUrl ?? 'anthropic'}`);
  } else if (!effectiveProviderEnv && !currentProviderEnv) {
    // Both undefined — subscription mode, no change needed
    if (isDebugMode) console.log('[agent] subscription mode, no provider env');
  }

  // Apply runtime config changes if session is active (model/permission changes don't require restart)
  // Skip for queued messages — config is locked to the current session while streaming
  if (!isSessionBusy) {
    await applySessionConfig(model, permissionMode);

    // Update local tracking even if SDK call is skipped (e.g., first message before pre-warm)
    if (permissionMode && permissionMode !== currentPermissionMode) {
      currentPermissionMode = permissionMode;
      // Keep prePlanPermissionMode in sync (same as applySessionConfig)
      if (prePlanPermissionMode) prePlanPermissionMode = permissionMode;
      if (isDebugMode) console.log(`[agent] permission mode set to: ${permissionMode}`);
    }
    if (model && model !== currentModel) {
      currentModel = model;
      if (isDebugMode) console.log(`[agent] model set to: ${model}`);
    }
  } else if (shouldAbortSession) {
    // Session is being restarted (abort for MCP/agents config change). Stage permission/model
    // for the next session start. Without this, user's permission mode is lost during restart
    // and the next pre-warm uses the stale default (e.g., 'auto' instead of 'fullAgency').
    // Only update during abort — NOT during normal streaming or queued messages, to maintain
    // the "config locked while streaming" contract. canUseTool() reads currentPermissionMode
    // live (line ~4081), so updating it mid-turn would change permission behavior unexpectedly.
    if (permissionMode && permissionMode !== currentPermissionMode) {
      currentPermissionMode = permissionMode;
      // Keep prePlanPermissionMode in sync (same as !isSessionBusy branch)
      if (prePlanPermissionMode) prePlanPermissionMode = permissionMode;
      if (isDebugMode) console.log(`[agent] permission mode staged for restart: ${permissionMode}`);
    }
    if (model && model !== currentModel) {
      currentModel = model;
      if (isDebugMode) console.log(`[agent] model staged for restart: ${model}`);
    }
  }

  // Persist session to SessionStore on first message
  if (!hasInitialPrompt) {
    hasInitialPrompt = true;
    // Check if session metadata already exists (e.g., IM Bot session reloaded after Sidecar restart)
    const existingMeta = getSessionMetadata(sessionId);
    if (existingMeta) {
      // Session already in index — only update title if it's still default
      const title = trimmed ? trimmed.slice(0, 40) + (trimmed.length > 40 ? '...' : '') : '图片消息';
      if (existingMeta.title === 'New Chat') {
        updateSessionMetadata(sessionId, { title });
      }
      console.log(`[agent] session ${sessionId} already exists in SessionStore, preserving stats`);
    } else {
      // Brand new session — create metadata
      const sessionMeta = createSessionMetadata(agentDir);
      sessionMeta.id = sessionId;
      sessionMeta.title = trimmed ? trimmed.slice(0, 40) : '图片消息';
      if (sessionMeta.title.length < trimmed.length) {
        sessionMeta.title += '...';
      }
      saveSessionMetadata(sessionMeta);
      console.log(`[agent] session ${sessionId} persisted to SessionStore`);
    }
  } else {
    // Update session title from first real message if needed
    if (trimmed && messages.length === 0) {
      updateSessionTitleFromMessage(sessionId, trimmed);
    }
  }

  console.log(`[agent] enqueue user message len=${trimmed.length} images=${images?.length ?? 0} mode=${currentPermissionMode}`);

  // Transition from pre-warm to active session.
  // CRITICAL: Only transition when the session is NOT being aborted. If shouldAbortSession
  // is true, the session is dying — mutating isPreWarming here would "steal" the flag from
  // the startStreamingSession finally block, causing wasPreWarming to be false and both
  // recovery branches to miss. The message will be queued (isSessionBusy path below) and
  // processed by the next session after the finally block's schedulePreWarm fires.
  if (isPreWarming && !shouldAbortSession) {
    isPreWarming = false;
    // Pre-warm 已收到 system_init → SDK 已注册此 session，后续必须用 resume
    if (systemInitInfo) {
      sessionRegistered = true;
    }
    console.log(`[agent] pre-warm → active, first user message, sessionRegistered=${sessionRegistered}`);
    // Replay buffered system_init so frontend gets tools/session info
    if (systemInitInfo) {
      broadcast('chat:system-init', { info: systemInitInfo, sessionId });
    }
  }
  // Cancel any pending pre-warm timer (user is sending a message now).
  // BUT: when shouldAbortSession is true, the timer is the ONLY recovery mechanism
  // for restarting the session — don't cancel it. Messages will queue via isSessionBusy
  // path and be processed when the timer fires a new session.
  if (preWarmTimer && !shouldAbortSession) {
    clearTimeout(preWarmTimer);
    preWarmTimer = null;
  }
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

  // Build multimodal content array for Claude API
  // Images are sent as base64-encoded source blocks.
  // media_type is narrowed to the Anthropic SDK literal union (exposed as
  // real types since claude-agent-sdk 0.2.86 added @anthropic-ai/sdk as a
  // direct dependency — prior versions erased it to `string`).
  type ImageMediaType = 'image/jpeg' | 'image/png' | 'image/gif' | 'image/webp';
  const contentBlocks: Array<
    | { type: 'text'; text: string }
    | { type: 'image'; source: { type: 'base64'; media_type: ImageMediaType; data: string } }
  > = [];

  // Add images first so Claude can see them before the text query
  // Images are resized/sliced server-side to stay within API limits (≤1568px, long images → 1:2 tiles)
  if (hasImages) {
    for (const img of images) {
      let tiles: Awaited<ReturnType<typeof processImage>>;
      try {
        tiles = await processImage(img);
      } catch (err) {
        // Image too large or processing failed — notify user and inform Claude
        const errMsg = err instanceof Error ? err.message : 'Image processing failed';
        console.warn(`[agent] processImage error for ${img.name}: ${errMsg}`);
        broadcast('chat:message-error', `图片 "${img.name}" 处理失败：${errMsg}`);
        contentBlocks.push({ type: 'text', text: `[Image "${img.name}" omitted: ${errMsg}]` });
        continue;
      }
      if (tiles.length > 1) {
        contentBlocks.push({
          type: 'text',
          text: `[The following ${tiles.length} images are consecutive tiles of the same long screenshot "${img.name}", arranged in reading order with slight overlap between adjacent tiles]`,
        });
      }
      for (const tile of tiles) {
        contentBlocks.push({
          type: 'image',
          source: {
            type: 'base64',
            // processImage() resizes into one of these 4 formats; upstream uploaders
            // also filter by the same set. Cast is safe because ImagePayload.mimeType
            // is declared as generic string at the utility layer.
            media_type: tile.mimeType as ImageMediaType,
            data: tile.data,
          },
        });
      }
    }
  }

  // Add text content if present
  if (trimmed) {
    contentBlocks.push({ type: 'text', text: trimmed });
  }

  const queueId = randomUUID();

  // Queue if session is busy: either AI is streaming or there are pending messages
  // in the queue waiting to be processed.
  // IMPORTANT: Do NOT push to messages[] or broadcast here — queued messages
  // are rendered in the frontend only when they start executing (see messageGenerator).
  // Mid-turn injection: deliver via wakeGenerator so the generator can yield
  // the message to SDK stdin immediately (subprocess reads at breakpoints).
  if (isSessionBusy) {
    // Backend queue limit (defense-in-depth — frontend also enforces limit)
    // Count both messageQueue (waiting) and pendingMidTurnQueue (yielded but not yet flushed)
    const MAX_QUEUE_SIZE = 10;
    if (messageQueue.length + pendingMidTurnQueue.length >= MAX_QUEUE_SIZE) {
      return { queued: false, error: `Queue full (max ${MAX_QUEUE_SIZE})` };
    }
    const queueItem: MessageQueueItem = {
      id: queueId,
      message: { role: 'user', content: contentBlocks },
      messageText: trimmed,
      wasQueued: true,
      resolve: () => {},  // No-op: no one is awaiting
      attachments: savedAttachments.length > 0 ? savedAttachments : undefined,
    };
    // wakeGenerator delivers directly if generator is at waitForMessage (messageResolver set),
    // or buffers in messageQueue if generator is suspended at yield (SDK hasn't called next() yet).
    wakeGenerator(queueItem);
    console.log(`[agent] Message queued (mid-turn injection): queueId=${queueId} text="${trimmed.slice(0, 50)}"`);
    broadcast('queue:added', { queueId, messageText: trimmed.slice(0, 100) });

    // Safety net: if message was queued because shouldAbortSession is true but no session
    // or pre-warm timer exists to process it, schedule recovery. This prevents orphaned
    // messages when a deferred config restart races with session cleanup.
    if (shouldAbortSession && !preWarmTimer && !messageResolver) {
      console.warn('[agent] Safety net: queued message during abort with no pending recovery, scheduling pre-warm');
      schedulePreWarm();
    }
    return { queued: true, queueId };
  }

  // Direct send path: push user message to messages[] and broadcast immediately
  const userMessage: MessageWire = {
    id: String(messageSequence++),
    role: 'user',
    content: trimmed,
    timestamp: new Date().toISOString(),
    attachments: savedAttachments.length > 0 ? savedAttachments : undefined,
    metadata,
  };
  messages.push(userMessage);
  broadcast('chat:message-replay', { message: userMessage });

  // Persist messages to disk after adding user message
  persistMessagesToStorage();

  const queueItem: MessageQueueItem = {
    id: queueId,
    message: { role: 'user', content: contentBlocks },
    messageText: trimmed,
    wasQueued: false,
    resolve: () => {},  // No-op: no one is awaiting
  };

  if (!isSessionActive()) {
    // 无活跃 session（pre-warm 失败或首次启动）→ 先入队再启动 session
    console.log('[agent] starting session (idle -> running)');
    preWarmFailCount = 0; // 用户主动操作重置重试计数
    messageQueue.push(queueItem);
    // CRITICAL: Defer to next event loop tick via setTimeout(0).
    // SDK query() can block the event loop for minutes during session resume
    // (subprocess spawn + MCP server initialization). If called synchronously,
    // the /api/im/chat handler can't return its SSE Response, causing Rust's
    // read_timeout to fire. setTimeout(0) lets the handler return first.
    setTimeout(() => {
      startStreamingSession().catch((error) => {
        console.error('[agent] failed to start session', error);
      });
    }, 0);
  } else {
    // Session 已在运行（generator 在 waitForMessage 中等待）→ 直接投递
    wakeGenerator(queueItem);
  }

  return { queued: false };
}

export function isSessionActive(): boolean {
  return isProcessing || querySession !== null;
}

/**
 * Read historical session messages from SDK's persisted session files.
 * Works without an active Sidecar — reads directly from .claude/ session files.
 *
 * @param sdkSessionId - The SDK session ID (from session metadata's sdkSessionId)
 * @param dir - Optional project directory to search in
 * @param limit - Maximum number of messages to return
 * @param offset - Number of messages to skip from the start
 */
export async function getHistoricalSessionMessages(
  sdkSessionId: string,
  dir?: string,
  limit?: number,
  offset?: number,
): Promise<Array<{ type: string; uuid: string; session_id: string; message: unknown }>> {
  const messages = await sdkGetSessionMessages(sdkSessionId, {
    ...(dir ? { dir } : {}),
    ...(limit !== undefined ? { limit } : {}),
    ...(offset !== undefined ? { offset } : {}),
  });
  return messages;
}

/**
 * Wait for the current session to become idle
 * Returns true if idle, false if timeout
 * @param timeoutMs Maximum time to wait in milliseconds (default: 10 minutes)
 * @param pollIntervalMs How often to check status (default: 500ms)
 */
// Helper function to check if session is idle (avoids TypeScript type narrowing issues)
function isSessionIdle(): boolean {
  return sessionState === 'idle';
}

export async function waitForSessionIdle(
  timeoutMs: number = 600000,
  pollIntervalMs: number = 500
): Promise<boolean> {
  const startTime = Date.now();
  console.log(`[agent] waitForSessionIdle: starting, sessionState=${sessionState}`);

  // Brief wait to allow async operations to start (prevents false early return)
  // Note: Only check sessionState === 'idle' because isProcessing and querySession
  // remain set until the entire session ends (for await loop in startStreamingSession).
  // The sessionState is set to 'idle' by handleMessageComplete() after each message,
  // which correctly indicates "no message is being processed" for cron sync execution.
  if (isSessionIdle()) {
    await new Promise(resolve => setTimeout(resolve, 100));
    if (isSessionIdle()) {
      console.log('[agent] waitForSessionIdle: already idle, returning true');
      return true;
    }
  }

  while (Date.now() - startTime < timeoutMs) {
    if (isSessionIdle()) {
      console.log(`[agent] waitForSessionIdle: became idle after ${Date.now() - startTime}ms`);
      return true;
    }
    await new Promise(resolve => setTimeout(resolve, pollIntervalMs));
  }

  console.warn('[agent] waitForSessionIdle: timeout reached');
  return false;
}

export async function interruptCurrentResponse(): Promise<boolean> {
  if (!isTurnInFlight()) {
    // No active turn, but there might be orphaned queued messages.
    // Drain them and notify the frontend so the UI can recover.
    if (messageQueue.length > 0) {
      console.warn(`[agent] No active turn but ${messageQueue.length} orphaned message(s) in queue, draining`);
      drainQueueWithCancellation();
    }
    return false;
  }

  if (isInterruptingResponse) {
    return true;
  }

  if (!querySession) {
    console.log('[agent] No querySession but turn is still marked active, resetting state');
    broadcast('chat:message-stopped', null);
    handleMessageStopped();
    return true;
  }

  isInterruptingResponse = true;
  try {
    // Step 1: Try graceful interrupt (5 seconds).
    // interrupt() is cooperative — the SDK subprocess must be responsive to process it.
    // If a MCP tool is hung (e.g., Playwright screenshot on heavy page), the subprocess
    // may be blocked on I/O and unable to handle the interrupt signal.
    const interruptPromise = querySession.interrupt();
    const timeoutPromise = new Promise<void>((_, reject) => {
      setTimeout(() => reject(new Error('Interrupt timeout')), 5000);
    });

    let interrupted = false;
    try {
      await Promise.race([interruptPromise, timeoutPromise]);
      interrupted = true;
    } catch (error) {
      console.error('[agent] Interrupt failed or timed out (5s):', error);
    }

    // Step 2: If interrupt failed, force-close immediately.
    // close() is the SDK's nuclear option: kills subprocess + MCP transports synchronously.
    // Session history is preserved (JSONL persisted), next message triggers fresh subprocess
    // with resumeSessionId (no data loss, no amnesia). (#60)
    if (!interrupted && querySession) {
      console.warn('[agent] Force-closing SDK session (interrupt unresponsive)');
      const session = querySession;
      querySession = null;
      try { session.close(); } catch { /* already dead */ }
    }

    // Step 3: If interrupt "succeeded" (SDK ACKed), verify the turn actually completed.
    // interrupt() resolving only means the SDK received the signal — it does NOT guarantee
    // the subprocess stopped processing. If an MCP tool is hung (e.g., cuse Read on a large
    // screenshot), the SDK subprocess remains blocked on client.callTool() with a ~28-hour
    // timeout. The for-await loop gets no more events, stdin messages are swallowed, and
    // the user sees "no response" until the 10-minute watchdog fires.
    //
    // Fix: wait up to 3 seconds for the for-await loop to receive a `result` message
    // (turn completion). If it doesn't arrive, the MCP tool is likely hung — force-close.
    if (interrupted && querySession) {
      const turnEnded = new Promise<void>(resolve => {
        postInterruptTurnEndResolve = resolve;
      });
      const postInterruptTimeout = new Promise<void>((_, reject) =>
        setTimeout(() => reject(new Error('Post-interrupt turn completion timeout')), 3000)
      );
      try {
        await Promise.race([turnEnded, postInterruptTimeout]);
      } catch {
        // Turn didn't complete within 3s — MCP tool likely hung, force-close
        postInterruptTurnEndResolve = null;
        if (querySession) {
          console.warn('[agent] Force-closing: turn did not complete 3s after interrupt (hung MCP tool?)');
          const session = querySession;
          querySession = null;
          try { session.close(); } catch { /* already dead */ }
        }
      }
    }

    broadcast('chat:message-stopped', null);
    handleMessageStopped();
    return true;
  } finally {
    isInterruptingResponse = false;
  }
}

/**
 * Cancel a queued message by its queueId.
 * Returns the original message text (for restoring to input box) or null if not found.
 */
export function cancelQueueItem(queueId: string): string | null {
  const index = messageQueue.findIndex(item => item.id === queueId);
  if (index === -1) {
    // 消息可能已被 wakeGenerator 直接投递 → 在 pendingMidTurnQueue 中（已 yield 给 SDK stdin）。
    // SDK 已收到无法撤回，但从 pending 队列移除可防止 queue:started 触发和 messages[] 污染。
    const pmIdx = pendingMidTurnQueue.findIndex(p => p.queueId === queueId);
    if (pmIdx === -1) return null;
    const [removed] = pendingMidTurnQueue.splice(pmIdx, 1);
    broadcast('queue:cancelled', { queueId });
    console.log(`[agent] Queue item ${queueId} cancelled from pendingMidTurnQueue (already yielded to SDK, AI may still respond)`);
    return typeof removed.userMessage.content === 'string' ? removed.userMessage.content : '';
  }

  const [item] = messageQueue.splice(index, 1);
  // Only resolve if this was a non-blocking queued item (wasQueued: true has no-op resolve).
  // For blocking items (wasQueued: false), resolve would unblock enqueueUserMessage's await,
  // but the message was removed from the queue — messageGenerator won't find it, which is safe.
  item.resolve();
  broadcast('queue:cancelled', { queueId });
  console.log(`[agent] Queue item ${queueId} cancelled (wasQueued=${item.wasQueued})`);
  return item.messageText;
}

/**
 * Force-execute a queued message: move it to front of queue and interrupt current response.
 */
export async function forceExecuteQueueItem(queueId: string): Promise<boolean> {
  const index = messageQueue.findIndex(item => item.id === queueId);

  // 消息可能已被 wakeGenerator 直接投递给 generator（跳过 messageQueue），
  // 此时它在 pendingMidTurnQueue 中（已 yield 给 SDK stdin，等待 AI 消费）。
  // 这种情况下中断当前响应即可让 SDK 更快处理该消息。
  const inPendingMidTurn = index === -1 && pendingMidTurnQueue.some(p => p.queueId === queueId);

  if (index === -1 && !inPendingMidTurn) return false;

  // Move to front of queue (only if still in messageQueue)
  if (index > 0) {
    const [item] = messageQueue.splice(index, 1);
    messageQueue.unshift(item);
  }

  if (isSessionActive()) {
    // Session 存活：中断当前响应，generator 会自然消费队列头部
    // （或 pendingMidTurnQueue 中的消息在中断后被 SDK 立即处理）
    await interruptCurrentResponse();
  } else {
    // Session 已死：generator 不存在，无人消费队列。
    // 启动新 session 来处理队列中的消息。
    console.log('[agent] forceExecuteQueueItem: session dead, starting new session');
    preWarmFailCount = 0;
    // Defer to next tick (same reason as enqueueUserMessage: prevent event loop blocking)
    setTimeout(() => {
      startStreamingSession().catch((error) => {
        console.error('[agent] forceExecuteQueueItem: failed to start session', error);
      });
    }, 0);
  }
  return true;
}

/**
 * Get current queue status — list of queued items with their IDs and preview text.
 */
export function getQueueStatus(): Array<{ id: string; messagePreview: string }> {
  return messageQueue.map(item => ({
    id: item.id,
    messagePreview: item.messageText.slice(0, 100),
  }));
}

/**
 * 时间回溯：截断对话历史 + 即时回退文件状态。
 * 持久 session 下 subprocess 存活，可直接调用 rewindFiles（无需临时 session）。
 */
export async function rewindSession(userMessageId: string): Promise<{
  success: boolean;
  error?: string;
  content?: string;
  attachments?: MessageWire['attachments'];
}> {
  const doRewind = async () => {
    // 1. 找到目标 user message
    const targetIndex = messages.findIndex(m => m.id === userMessageId && m.role === 'user');
    if (targetIndex < 0) return { success: false as const, error: 'Message not found' };
    const targetMessage = messages[targetIndex];

    // 2. 两个 UUID 分离：
    //    - lastAssistantUuid → 用于 resumeSessionAt（截断 SDK 会话历史到目标前的 assistant）
    //    - targetMessage.sdkUuid → 用于 rewindFiles（文件检查点按 user message 打点）
    //    SDK 文档：rewindFiles(userMessageUuid) — 检查点关联用户消息，非 assistant 消息
    let lastAssistantUuid: string | undefined;
    for (let i = targetIndex - 1; i >= 0; i--) {
      if (messages[i].role === 'assistant' && messages[i].sdkUuid) {
        lastAssistantUuid = messages[i].sdkUuid;
        break;
      }
    }

    // 3. 在活跃 session 上执行 rewindFiles（文件检查点关联 user message UUID）
    //    跳过已被 force-abort 的 session：subprocess 正在死亡，发 IPC 会阻塞到超时（~100s）。
    //    跳过不属于当前 session 的 UUID：SDK 不认识，调用必定失败且日志噪声。
    //    跳过无 sdkUuid 的用户消息：旧存储加载或 SDK 尚未回传 UUID。
    const targetUserUuid = targetMessage.sdkUuid;
    if (querySession && targetUserUuid && !shouldAbortSession && currentSessionUuids.has(targetUserUuid)) {
      try {
        const REWIND_FILES_TIMEOUT_MS = 5_000;
        const result = await Promise.race([
          querySession.rewindFiles(targetUserUuid),
          new Promise<never>((_, reject) =>
            setTimeout(() => reject(new Error('rewindFiles timeout')), REWIND_FILES_TIMEOUT_MS)
          ),
        ]);
        console.log('[agent] rewindFiles result:', JSON.stringify(result));
        if (!result.canRewind) {
          console.warn('[agent] rewindFiles cannot rewind:', result.error);
        }
      } catch (err) {
        console.error('[agent] rewindFiles error:', err);
        // 文件回溯失败不阻断消息截断
      }
    } else if (!targetUserUuid) {
      console.log('[agent] rewind: target user message has no sdkUuid, skipping rewindFiles');
    }

    // 4. 中止当前 session（需要新 session 用 resumeSessionAt 截断 SDK 历史）
    abortPersistentSession();
    messageQueue.length = 0;
    await awaitSessionTermination(10_000, 'rewind');
    shouldAbortSession = false;

    // 5. 收集被删消息内容（恢复到输入框）
    const removedContent = typeof targetMessage.content === 'string' ? targetMessage.content : '';
    const removedAttachments = targetMessage.attachments;

    // 6. 截断消息
    messages.length = targetIndex;
    persistMessagesToStorage();

    // 7. 设置下次 query 的对话截断点
    //    UUID 有效性校验（OR 逻辑）：
    //    - liveSessionUuids: SDK subprocess stdout 确认过的 UUID（权威但不完整 — resume 后
    //      SDK 不会重新输出旧历史的 UUID）
    //    - currentSessionUuids: 包含磁盘种子 + 运行时 UUID（覆盖 resume 前的历史）
    //    - 任一集合包含即为有效。过期 UUID 安全性由 session 重建时清空
    //      currentSessionUuids（!sessionRegistered → clear）保证。
    //    - 两者都不包含 → session 被重建过，旧 UUID 无意义，创建新 session
    const uuidIsLive = lastAssistantUuid
      && (liveSessionUuids.has(lastAssistantUuid) || currentSessionUuids.has(lastAssistantUuid));
    if (uuidIsLive) {
      pendingResumeSessionAt = lastAssistantUuid;
    } else {
      if (lastAssistantUuid) {
        console.warn(`[agent] rewind: skipping resumeSessionAt — UUID ${lastAssistantUuid} not in live(${liveSessionUuids.size}) or current(${currentSessionUuids.size}) session (stale/rebuilt)`);
      }
      pendingResumeSessionAt = undefined;
      sessionRegistered = false;
      sessionId = randomUUID();
      hasInitialPrompt = false; // Reset so next message creates metadata for the new session
    }

    // 8. 预热下次 session
    schedulePreWarm();

    return { success: true as const, content: removedContent, attachments: removedAttachments };
  };

  const promise = doRewind();
  rewindPromise = promise;
  try {
    return await promise;
  } finally {
    rewindPromise = null;
  }
}

/**
 * Fork session: create a new independent session branching from a specific assistant message.
 * Non-destructive — the current session remains untouched.
 * The new session uses SDK's forkSession option on first startup.
 */
export function forkSession(assistantMessageId: string): {
  success: boolean;
  newSessionId?: string;
  agentDir?: string;
  title?: string;
  error?: string;
} {
  // 1. Find target assistant message in memory first, then fall back to persistent storage.
  // The in-memory `messages[]` may be empty after session switch/reset (clearMessageState),
  // while the frontend still shows the fork button because it has the message from loaded state.
  console.log(`[agent] forkSession: looking for assistantMessageId=${assistantMessageId}, in-memory messages.length=${messages.length}, sessionId=${sessionId}`);
  console.log(`[agent] forkSession: in-memory message IDs (last 20): ${messages.slice(-20).map(m => `${m.role}:${m.id}`).join(', ')}`);
  let targetIndex = messages.findIndex(m => m.id === assistantMessageId && m.role === 'assistant');
  let messageSource = messages;

  if (targetIndex < 0) {
    // Fallback: load from persistent storage — covers race between clearMessageState
    // and loadMessagesFromStorage during session switch/pre-warm.
    const stored = getSessionData(sessionId);
    if (stored?.messages) {
      const storedIdx = stored.messages.findIndex(m => m.id === assistantMessageId && m.role === 'assistant');
      if (storedIdx >= 0) {
        console.log(`[agent] forkSession: message ${assistantMessageId} not in memory, found in storage`);
        // Use stored messages directly for fork (they already have sdkUuid persisted)
        targetIndex = storedIdx;
        messageSource = stored.messages.map(m => ({
          id: m.id,
          role: m.role,
          content: m.content,
          timestamp: m.timestamp,
          sdkUuid: m.sdkUuid,
          attachments: m.attachments?.map(att => ({
            id: att.id,
            name: att.name,
            size: 0,
            mimeType: att.mimeType,
            relativePath: att.path,
          })),
          metadata: m.metadata,
        }));
      }
    }
  }

  if (targetIndex < 0) {
    console.error(`[agent] forkSession: Assistant message NOT FOUND. assistantMessageId=${assistantMessageId}, in-memory count=${messages.length}, sessionId=${sessionId}`);
    return { success: false, error: 'Assistant message not found' };
  }
  const targetMsg = messageSource[targetIndex];
  if (!targetMsg.sdkUuid) return { success: false, error: 'Message has no SDK UUID (cannot fork)' };

  // UUID validity check: only enforce for STORAGE-loaded messages (messageSource !== messages).
  // In-memory messages are trusted — their UUIDs were assigned during this process's lifetime.
  // After rewind, currentSessionUuids is cleared (new SDK session), but pre-rewind messages
  // remain in memory with valid UUIDs (SDK's resumeSessionAt preserves earlier history).
  // Storage-loaded messages may come from a different SDK session, so enforce UUID freshness.
  const isFromStorage = messageSource !== messages;
  if (isFromStorage && currentSessionUuids.size > 0 && !currentSessionUuids.has(targetMsg.sdkUuid)) {
    return { success: false, error: 'SDK UUID 已过期（当前 SDK session 不包含此消息），请重新发送后再 fork' };
  }

  // 2. Get current session info for the fork source
  const sourceSessionId = sessionId; // unifiedSession: id === SDK session ID
  const currentAgentDir = agentDir;
  const sourceMeta = getSessionMetadata(sourceSessionId);
  const sourceTitle = sourceMeta?.title || 'Chat';

  try {
    // 3. Create new session metadata with forkFrom
    const newSession = createSessionMetadata(currentAgentDir);
    newSession.title = `🌿 ${sourceTitle}`;
    newSession.titleSource = 'auto';
    newSession.forkFrom = {
      sourceSessionId,
      messageUuid: targetMsg.sdkUuid,
    };

    // 4. Copy messages up to and including the fork point
    const forkedMessages: SessionMessage[] = messageSource.slice(0, targetIndex + 1).map(m => ({
      id: m.id,
      role: m.role,
      content: typeof m.content === 'string' ? m.content : JSON.stringify(stripPlaywrightResults(m.content)),
      timestamp: m.timestamp,
      sdkUuid: m.sdkUuid,
      attachments: m.attachments?.map(att => ({
        id: att.id,
        name: att.name,
        mimeType: att.mimeType,
        path: ('relativePath' in att ? att.relativePath : (att as { path?: string }).path) ?? '',
      })),
      metadata: m.metadata,
    }));

    // 5. Persist new session
    saveSessionMetadata(newSession);
    saveSessionMessages(newSession.id, forkedMessages);

    console.log(`[agent] forked session ${sourceSessionId} → ${newSession.id} at message ${assistantMessageId} (sdkUuid: ${targetMsg.sdkUuid}), ${forkedMessages.length} messages copied`);

    return {
      success: true,
      newSessionId: newSession.id,
      agentDir: currentAgentDir,
      title: newSession.title,
    };
  } catch (err) {
    console.error('[agent] forkSession failed:', err);
    return { success: false, error: err instanceof Error ? err.message : 'Fork failed' };
  }
}

async function startStreamingSession(preWarm = false): Promise<void> {
  await awaitSessionTermination(10_000, 'startStreamingSession');

  if (isProcessing || querySession) {
    return;
  }

  isPreWarming = preWarm;
  // Sync enabled user-level skills as symlinks into project's .claude/skills/
  // Must happen before buildClaudeSessionEnv() so SDK sees them via settingSources: ['project']
  syncProjectUserConfig(agentDir);
  const env = buildClaudeSessionEnv();
  console.log(`[agent] ${preWarm ? 'pre-warm' : 'start'} session cwd=${agentDir}`);
  shouldAbortSession = false;
  resetAbortFlag();
  isProcessing = true;
  // Only clear UUID tracking for brand-new sessions.
  // For resume sessions (sessionRegistered=true), loadMessagesFromStorage has already
  // seeded currentSessionUuids from disk — clearing them here would break rewind
  // during the pre-warm window (before SDK system_init re-populates via stdout events).
  if (!sessionRegistered) {
    currentSessionUuids.clear();
  }
  // liveSessionUuids 始终清除 — 新的 subprocess 尚未输出任何消息，
  // 直到 SDK stdout 事件重新填充后才能作为 resumeSessionAt 的权威来源。
  liveSessionUuids.clear();
  let preWarmStartedOk = false; // Tracks whether pre-warm received system_init
  let abortedByTimeout = false; // Distinguishes timeout abort from config-change abort
  let detectedAlreadyInUse = false; // stderr reported "Session ID already in use"
  streamIndexToToolId.clear();
  streamIndexToBlockType.clear();
  imTextBlockIndices.clear();

  // Don't broadcast 'running' during pre-warm — session is invisible to frontend
  if (!preWarm) {
    setSessionState('running');
  }

  let resolveTermination: () => void;
  sessionTerminationPromise = new Promise((resolve) => {
    resolveTermination = resolve;
  });

  // Declared outside try so finally can clean up
  let startupTimeoutId: ReturnType<typeof setTimeout> | undefined;
  let apiWatchdogId: ReturnType<typeof setInterval> | undefined;

  try {
    const sdkPermissionMode = mapToSdkPermissionMode(currentPermissionMode);

    // Resolve SDK-compatible session ID for resume/create.
    // SDK requires valid UUID format for --resume (and --session-id).
    // Our internal sessionId may have a prefix (e.g., old cron-im-{uuid} format).
    const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
    let resumeFrom: string | undefined;
    let effectiveSdkSessionId: string;

    if (sessionRegistered) {
      // Prefer sdkSessionId from metadata (the actual ID the SDK knows)
      const meta = getSessionMetadata(sessionId);
      const sdkSid = meta?.sdkSessionId;

      if (sdkSid && UUID_RE.test(sdkSid)) {
        resumeFrom = sdkSid;
        effectiveSdkSessionId = sdkSid;
      } else if (UUID_RE.test(sessionId)) {
        resumeFrom = sessionId;
        effectiveSdkSessionId = sessionId;
      } else {
        // Non-UUID session ID (e.g., old cron-im-{uuid}) — cannot resume, start fresh
        console.warn(`[agent] Session ${sessionId} has non-UUID ID (sdkSid=${sdkSid}), cannot resume — starting fresh`);
        resumeFrom = undefined;
        effectiveSdkSessionId = randomUUID();
      }
    } else {
      resumeFrom = undefined;
      // For new sessions, ensure SDK gets a valid UUID
      effectiveSdkSessionId = UUID_RE.test(sessionId) ? sessionId : randomUUID();
    }
    // sessionRegistered 不在此处修改 — 等待 system_init 确认

    // 读取 rewind 设置的对话截断点（不立即消费 — 等 system_init 确认后再清除）
    // 持久 session 模式下，pre-warm 即最终 session（用户消息通过 wakeGenerator 投递），
    // 必须在 pre-warm 时就传 resumeSessionAt，否则 SDK 会加载完整历史不截断
    // 延迟消费原因：如果 query 因 UUID 无效而启动失败，重试时仍需要 anchor；
    // catch block 的 "No message found" 恢复会主动清除无效 anchor 防止无限重试。
    const rewindResumeAt = pendingResumeSessionAt;

    // Fork detection: if this session was created via fork, override resume/sessionId
    // to use SDK's forkSession option (load source history + branch to new session).
    // Consumed once — forkFrom is cleared from metadata after use.
    let forkMode = false;
    let forkResumeAt: string | undefined;
    const forkMeta = getSessionMetadata(sessionId);
    if (forkMeta?.forkFrom) {
      const { sourceSessionId, messageUuid } = forkMeta.forkFrom;
      console.log(`[agent] fork mode: resuming from ${sourceSessionId}, fork at ${messageUuid}, new session ${sessionId}`);
      resumeFrom = sourceSessionId;
      effectiveSdkSessionId = sessionId;
      forkMode = true;
      forkResumeAt = messageUuid;
      // Clear forkFrom so subsequent restarts resume normally
      delete forkMeta.forkFrom;
      saveSessionMetadata(forkMeta);
    }

    const mcpStatus = currentMcpServers === null ? 'auto' : currentMcpServers.length === 0 ? 'disabled' : `enabled(${currentMcpServers.length})`;
    console.log(`[agent] starting query with model: ${currentModel ?? 'default'}, permissionMode: ${currentPermissionMode} -> SDK: ${sdkPermissionMode}, MCP: ${mcpStatus}, ${resumeFrom ? `resume: ${resumeFrom}` : `sessionId: ${effectiveSdkSessionId}`}${rewindResumeAt ? `, resumeSessionAt: ${rewindResumeAt}` : ''}${forkMode ? `, FORK mode (resumeAt: ${forkResumeAt})` : ''}`);

    const promptGen = messageGenerator();

    // Set session cron context so the im-cron tool can create tasks for non-IM sessions
    // IM sessions set imCronContext separately (in the IM message handler in index.ts)
    if (process.env.MYAGENTS_MANAGEMENT_PORT && !getImCronContext()) {
      setSessionCronContext({
        sessionId: sessionId,
        workspacePath: agentDir,
        model: currentModel,
        permissionMode: currentPermissionMode,
        providerEnv: currentProviderEnv,
      });
    }

    // Build disallowed tools list: group deny + IM-incompatible UI tools
    const disallowedToolsList = [...currentGroupToolsDeny];
    if (currentScenario.type === 'im') {
      disallowedToolsList.push('AskUserQuestion', 'EnterPlanMode', 'ExitPlanMode');
    }

    // SDK 0.2.84 bug: NA() returns "firstParty" for ANY non-bedrock/vertex/foundry provider,
    // causing xd7() to enable thinking for all non-claude-3 models on third-party APIs.
    // Third-party anthropic-protocol providers (SiliconFlow etc.) reject `thinking: {type:"adaptive"}`
    // with "400 thinking type should be enabled or disabled".
    // Fix: disable thinking for non-Claude models on third-party providers.
    // Model name check (sonnet/opus) is URL-agnostic — Claude models through any proxy get thinking.
    const modelLower = (currentModel ?? '').toLowerCase();
    const isClaudeModel = modelLower.includes('sonnet-4') || modelLower.includes('sonnet-5')
      || modelLower.includes('opus-4') || modelLower.includes('opus-5');
    const isOfficialAnthropicApi = !currentProviderEnv?.baseUrl || (() => {
      try { return new URL(currentProviderEnv.baseUrl!).host === 'api.anthropic.com'; }
      catch { return false; }
    })();
    const thinkingConfig = (isOfficialAnthropicApi || isClaudeModel)
      ? { type: 'adaptive' as const }
      : { type: 'disabled' as const };

    // Build common query options (shared between normal start and "already in use" fallback)
    const commonQueryOptions = {
      enableFileCheckpointing: true,
      thinking: thinkingConfig,
      effort: 'high' as const,
      // Load settings from project scope only (.claude/)
      // User-level skills are synced as symlinks into <cwd>/.claude/skills/ by syncProjectUserConfig()
      // CLAUDE_CONFIG_DIR is NOT set — preserves Anthropic subscription Keychain lookup
      settingSources: buildSettingSources(),
      // Permission mode mapping (uses mapToSdkPermissionMode):
      // - auto → acceptEdits (auto-accept edits, check others via canUseTool)
      // - plan → plan
      // - fullAgency → bypassPermissions (skip all checks)
      // - custom → default (all tools go through canUseTool)
      permissionMode: sdkPermissionMode,
      // allowDangerouslySkipPermissions MUST always be true: pre-warm starts with acceptEdits
      // (currentPermissionMode defaults to 'auto'), user may switch to fullAgency mid-session
      // via setPermissionMode('bypassPermissions'). Without this flag at query creation time,
      // the SDK silently ignores the mode switch and keeps calling canUseTool.
      allowDangerouslySkipPermissions: true,
      model: currentModel, // Use currently selected model
      pathToClaudeCodeExecutable: resolveClaudeCodeCli(),
      executable: 'bun' as const,
      env,
      stderr: (message: string) => {
        // Always log stderr to help diagnose subprocess issues (especially on older Windows)
        console.error('[sdk-stderr]', message);
        // Detect "Session ID already in use" early — stderr arrives before process exit error
        if (message.includes('already in use')) {
          detectedAlreadyInUse = true;
        }
        if (process.env.DEBUG === '1') {
          broadcast('chat:debug-message', message);
        }
      },
      systemPrompt: {
        type: 'preset' as const,
        preset: 'claude_code' as const,
        append: buildSystemPromptAppend(currentScenario, {
          playwrightStorageEnabled: (currentMcpServers ?? []).some(
            s => s.id === 'playwright' && (s.args ?? []).some((a: string) => /^--caps=.*\bstorage\b/.test(a))
          ),
          generativeUiEnabled: currentScenario.type === 'desktop',
          // agent-session.ts is the builtin Claude Agent SDK path by definition.
          runtime: 'builtin',
        }),
      },
      cwd: agentDir,
      includePartialMessages: true,
      // AskUserQuestion preview: request HTML format so frontend can render rich previews
      // (markdown/code snippets, visual comparisons) when AI presents options to the user
      toolConfig: {
        askUserQuestion: { previewFormat: 'html' as const },
      },
      mcpServers: await buildSdkMcpServers(),
      // Sub-agents: inject custom agent definitions if configured
      // When agents are injected, ensure 'Task' tool is in allowedTools so the model can delegate
      ...(currentAgentDefinitions && Object.keys(currentAgentDefinitions).length > 0
        ? { agents: currentAgentDefinitions, allowedTools: ['Task'] } : {}),
      // disallowedTools: group chat deny list + IM-incompatible UI-interaction tools
      // Uses SDK disallowedTools because canUseTool is skipped in bypassPermissions mode
      ...(disallowedToolsList.length > 0 ? { disallowedTools: disallowedToolsList } : {}),
      // Custom permission handling - check rules and prompt user for unknown tools
      // Effective when permissionMode is 'default' or 'acceptEdits' (not 'bypassPermissions')
      canUseTool: async (toolName: string, input: unknown, options: { signal: AbortSignal }) => {
        console.debug(`[permission] canUseTool checking: ${toolName}, mode=${currentPermissionMode}`);

        // SAFETY NET: fullAgency mode MUST auto-approve everything except user-interaction
        // tools that require explicit human review (AskUserQuestion, EnterPlanMode, ExitPlanMode).
        // This guard catches the case where the SDK didn't honor setPermissionMode('bypassPermissions')
        // — e.g., pre-warm started with acceptEdits and the mid-session mode switch was ignored.
        const USER_INTERACTION_TOOLS = ['AskUserQuestion', 'EnterPlanMode', 'ExitPlanMode'];
        if (currentPermissionMode === 'fullAgency' && !USER_INTERACTION_TOOLS.includes(toolName)) {
          console.debug(`[permission] fullAgency fast-path: auto-approved ${toolName}`);
          return {
            behavior: 'allow' as const,
            updatedInput: input as Record<string, unknown>
          };
        }

        // First check MCP tool permission based on user's enabled MCP servers
        const mcpCheck = checkMcpToolPermission(toolName);
        if (!mcpCheck.allowed) {
          if (isDebugMode) console.log(`[permission] MCP tool blocked: ${toolName} - ${mcpCheck.reason}`);
          return {
            behavior: 'deny' as const,
            message: mcpCheck.reason
          };
        }

        // Special case: built-in trusted MCP servers (cron-tools, im-cron, generative-ui)
        // When allowed by checkMcpToolPermission, skip user confirmation entirely
        if (toolName.startsWith('mcp__cron-tools__') || toolName.startsWith('mcp__im-cron__') || toolName.startsWith('mcp__generative-ui__')) {
          console.log(`[permission] built-in tool auto-allowed: ${toolName}`);
          return {
            behavior: 'allow' as const,
            updatedInput: input as Record<string, unknown>
          };
        }

        // Headless IM fast-path: IM bridges (Telegram/Dingtalk builtin + all OpenClaw plugins
        // like weixin/feishu) have no permission approval UI. Routing Bash/WebSearch/etc. through
        // checkToolPermission would forward a permission-request to imStreamCallback that no
        // bridge can answer → 10-minute timeout per tool call → user sees endless loading.
        //
        // Sticky by design: `currentScenario = 'im'` is set at IM request entry (index.ts:7116)
        // and intentionally never reset — if the SSE stream closes mid-turn (heartbeat/network),
        // the SDK subprocess keeps executing subsequent tools and we want them to auto-approve
        // rather than hang.
        //
        // USER_INTERACTION_TOOLS guard is defensive only: disallowedToolsList (see line ~4940)
        // already blocks them at SDK level for scenario.type === 'im', so canUseTool won't see
        // them in practice. Kept for resilience against future refactors.
        //
        // Runs AFTER the MCP enable check so user-disabled MCP servers still get properly denied.
        // Does NOT include scenario.type === 'agent-channel' because external runtimes (CC/Codex)
        // don't route through canUseTool — they have their own external-session.ts flow.
        if (currentScenario.type === 'im' && !USER_INTERACTION_TOOLS.includes(toolName)) {
          console.debug(`[permission] im fast-path: auto-approved ${toolName}`);
          return {
            behavior: 'allow' as const,
            updatedInput: input as Record<string, unknown>
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

        // Special handling for ExitPlanMode - user reviews the plan
        if (toolName === 'ExitPlanMode') {
          console.log('[canUseTool] ExitPlanMode detected, requesting user approval');
          const approved = await handleExitPlanMode(input, options.signal);
          if (!approved) {
            return { behavior: 'deny' as const, message: '用户拒绝了方案' };
          }
          return {
            behavior: 'allow' as const,
            updatedInput: input as Record<string, unknown>
          };
        }

        // Special handling for EnterPlanMode - user approves entering plan mode
        if (toolName === 'EnterPlanMode') {
          console.log('[canUseTool] EnterPlanMode detected, requesting user approval');
          const approved = await handleEnterPlanMode(input, options.signal);
          if (!approved) {
            return { behavior: 'deny' as const, message: '用户拒绝进入计划模式' };
          }
          return {
            behavior: 'allow' as const,
            updatedInput: input as Record<string, unknown>
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
      // PostToolUse hook: resize oversized images in MCP tool results before sending to Claude API.
      // Claude API rejects images exceeding 8000px per dimension; MCP tools (e.g. browser screenshots)
      // can produce arbitrarily large images that bypass our user-upload resize pipeline.
      hooks: {
        PostToolUse: [{
          hooks: [
            async (input: HookInput, _toolUseId: string | undefined, _options: { signal: AbortSignal }): Promise<HookJSONOutput> => {
              const postInput = input as PostToolUseHookInput;
              const resized = await resizeToolImageContent(postInput.tool_response);
              if (resized) {
                console.log(`[image-resize] PostToolUse hook resized images for tool: ${postInput.tool_name}`);
                return {
                  hookSpecificOutput: {
                    hookEventName: 'PostToolUse' as const,
                    updatedMCPToolOutput: resized,
                  },
                };
              }
              return { continue: true };
            },
          ],
        }],
      },
    };

    // sessionId 和 resume 互斥（SDK 约束）
    // 新 session：传 effectiveSdkSessionId 让 SDK 使用有效 UUID
    // Resume：传 resume 恢复对话上下文
    // Fork：resume + forkSession + sessionId + resumeSessionAt（三者组合）
    const sessionOption = forkMode
      ? { resume: resumeFrom!, forkSession: true, sessionId: effectiveSdkSessionId, ...(forkResumeAt ? { resumeSessionAt: forkResumeAt } : {}) }
      : resumeFrom
        ? { resume: resumeFrom, ...(rewindResumeAt ? { resumeSessionAt: rewindResumeAt } : {}) }
        : { sessionId: effectiveSdkSessionId };

    try {
      querySession = query({
        prompt: promptGen,
        options: { ...sessionOption, ...commonQueryOptions },
      });
    } catch (queryError: unknown) {
      // Defensive fallback: metadata lost but SDK disk data exists → switch to resume
      // Note: "already in use" may surface asynchronously during for-await iteration
      // rather than synchronously here; this catch covers the sync case if SDK validates early.
      const msg = queryError instanceof Error ? queryError.message : String(queryError);
      if (!resumeFrom && msg.includes('already in use')) {
        console.warn(`[agent] Session ${effectiveSdkSessionId} already exists on disk, switching to resume`);
        sessionRegistered = true;
        querySession = query({
          prompt: promptGen,
          options: {
            resume: effectiveSdkSessionId,
            ...(rewindResumeAt ? { resumeSessionAt: rewindResumeAt } : {}),
            ...commonQueryOptions,
          },
        });
      } else {
        throw queryError;
      }
    }

    console.log('[agent] session started');
    console.log('[agent] starting for-await loop on querySession');

    // Startup timeout: if no system_init arrives, abort.
    // IMPORTANT: Only system_init clears this timeout, NOT other messages like rate_limit_event.
    // Otherwise a rate_limit_event arriving before system_init would cancel the timeout,
    // leaving the session as a zombie (stuck in for-await loop forever without system_init).
    //
    // Adaptive timeout strategy:
    //   Phase 1 (initial): 60s — if SDK subprocess doesn't show signs of life, fail fast.
    //   Phase 2 (extended): 600s — once session_state_changed:running arrives, the subprocess
    //     is alive and initializing. First-time workspace init can take minutes on Windows NTFS
    //     (SDK builds internal caches for large directories like ~/.myagents with 20k+ files).
    //     After the first successful init, subsequent sessions complete in <1s.
    const STARTUP_TIMEOUT_INITIAL_MS = 60_000;
    const STARTUP_TIMEOUT_EXTENDED_MS = 600_000;
    let systemInitReceived = false;
    let startupTimeoutExtended = false;

    const fireStartupTimeout = (timeoutMs: number) => {
      if (systemInitReceived || shouldAbortSession) return;
      console.error(`[agent] Startup timeout: no system_init in ${timeoutMs / 1000}s`);
      abortedByTimeout = true;
      broadcast('chat:agent-error', {
        message: 'Agent 启动超时，请重试。如果持续出现，请检查网络连接和 API 配置。'
      });
      broadcast('chat:message-error', 'Agent 启动超时');
      abortPersistentSession();
    };

    // Pre-warm sessions skip startup timeout because SDK CLI needs the first stdin message
    // before sending system_init. During pre-warm, messageGenerator() blocks at waitForMessage()
    // with no message to yield — system_init will only arrive when user sends a message
    // (triggering pre-warm → active transition). If the subprocess crashes during pre-warm,
    // the for-await loop exits naturally and the finally block handles retry.
    if (!preWarm) {
      startupTimeoutId = setTimeout(() => fireStartupTimeout(STARTUP_TIMEOUT_INITIAL_MS), STARTUP_TIMEOUT_INITIAL_MS);
    }

    let messageCount = 0;

    // ── API response watchdog ──────────────────────────────────────────
    // Detects hung API connections AND hung MCP tool calls.
    // Heartbeat (15s ping) keeps the SSE alive, so Rust's 60s read_timeout
    // never fires. Without this watchdog, the session hangs indefinitely.
    // Unified 10-minute timeout for both API hang and MCP tool hang.
    let pendingTools = 0;
    let lastSdkEventAt = Date.now();
    const API_WATCHDOG_INTERVAL_MS = 30_000;
    const WATCHDOG_TIMEOUT_MS = 10 * 60 * 1000; // 10 minutes — unified for API and MCP tools
    let watchdogFired = false;
    apiWatchdogId = setInterval(() => {
      // Only check during active turns (not pre-warm, not idle between turns)
      if (!isStreamingMessage || isPreWarming) return;
      if (watchdogFired) return;
      const now = Date.now();
      const noRecentSdkEvents = now - lastSdkEventAt > WATCHDOG_TIMEOUT_MS;

      if (noRecentSdkEvents) {
        watchdogFired = true;
        const toolInfo = pendingTools > 0 ? `（${pendingTools} 个工具执行中）` : '';
        console.error(`[agent] Watchdog: no SDK event for ${WATCHDOG_TIMEOUT_MS / 1000}s${toolInfo} — aborting`);
        broadcast('chat:agent-error', {
          message: `响应超时（10 分钟无活动${toolInfo}），已自动终止。请重试。`
        });
        broadcast('chat:message-error', '响应超时');
        abortPersistentSession();
      }
    }, API_WATCHDOG_INTERVAL_MS);

    for await (const sdkMessage of querySession) {
      messageCount++;
      lastSdkEventAt = Date.now();
      // stream_event is high-frequency (per token delta) — skip logging entirely.
      // All other types are low-frequency and logged with type-specific detail:
      //   system/init  — full JSON dump (once per session, all fields for diagnostics)
      //   result       — full JSON dump, long strings truncated to 100 chars
      //   rate_limit   — key fields (was previously silenced)
      //   others       — compact one-line summary
      if (sdkMessage.type !== 'stream_event') {
        const msg = sdkMessage as Record<string, unknown>;

        if (sdkMessage.type === 'system' && msg.subtype === 'init') {
          // Full system_init — all fields visible for diagnostics (MCP status, tools, model, etc.)
          console.log(`[agent][sdk] system_init: ${logStringify(sdkMessage)}`);
        } else if (sdkMessage.type === 'result') {
          // Full result — truncate long strings to 100 chars (e.g. result text)
          console.log(`[agent][sdk] result: ${logStringify(sdkMessage, 100)}`);
        } else if (sdkMessage.type === 'rate_limit_event') {
          const rli = msg.rate_limit_info as Record<string, unknown> | undefined;
          if (rli) {
            const pct = typeof rli.utilization === 'number' ? Math.round(rli.utilization * 100) : '?';
            const resets = typeof rli.resetsAt === 'number'
              ? new Date((rli.resetsAt as number) * 1000).toISOString()
              : 'n/a';
            console.log(`[agent][sdk] rate_limit: status=${rli.status} utilization=${pct}% type=${rli.rateLimitType} overage=${rli.isUsingOverage} threshold=${rli.surpassedThreshold} resets=${resets}`);
          }
        } else {
          // Compact summary for other types (assistant, user, system/session_state_changed, etc.)
          const model = (msg.message as Record<string, unknown>)?.model ?? '';
          const stopReason = (msg.message as Record<string, unknown>)?.stop_reason ?? '';
          const subtype = msg.subtype ?? '';
          const extra = subtype ? ` subtype=${subtype}` : model ? ` model=${model}` : '';
          const stop = stopReason ? ` stop=${stopReason}` : '';
          console.log(`[agent][sdk] message #${messageCount} type=${sdkMessage.type}${extra}${stop}`);
        }
      }
      try {
        const line = `${localTimestamp()} ${logStringify(sdkMessage)}`;
        appendLogLine(line);
      } catch (error) {
        console.log('[agent][sdk] (unserializable)', error);
      }
      const nextSystemInit = parseSystemInitInfo(sdkMessage);
      if (nextSystemInit) {
        // system_init received — clear startup timeout
        if (!systemInitReceived) {
          systemInitReceived = true;
          clearTimeout(startupTimeoutId);
        }
        systemInitInfo = nextSystemInit;
        // Buffer system_init during pre-warm; replay when first user message arrives
        if (!isPreWarming) {
          sessionRegistered = true;  // SDK 确认注册，后续必须 resume
          broadcast('chat:system-init', { info: systemInitInfo, sessionId });
        } else {
          // Pre-warm 不设 sessionRegistered — 这是核心设计约束
          // Pre-warm 的 system_init 只意味着 subprocess 准备好了，
          // 但 SDK 不会在没有用户消息的情况下持久化 session
          preWarmStartedOk = true;
          preWarmFailCount = 0;
          console.log('[agent] pre-warm: system_init buffered (will replay on first message)');
        }

        // system_init confirms SDK session started — consume the rewind anchor.
        // This is the success signal: the UUID was accepted (or wasn't needed).
        // If the UUID had been invalid, the SDK would have exited with error BEFORE system_init.
        if (pendingResumeSessionAt) {
          console.log(`[agent] system_init received — rewind anchor consumed: ${pendingResumeSessionAt}`);
          pendingResumeSessionAt = undefined;
        }

        // Save SDK session_id and verify unified session status
        if (nextSystemInit.session_id) {
          const isUnified = nextSystemInit.session_id === sessionId;
          updateSessionMetadata(sessionId, {
            sdkSessionId: nextSystemInit.session_id,
            unifiedSession: isUnified,
          });
          if (isUnified) {
            console.log(`[agent] SDK session_id confirmed unified: ${nextSystemInit.session_id}`);
          } else {
            console.log(`[agent] SDK session_id saved (pre-unified): ${nextSystemInit.session_id} (our: ${sessionId})`);
          }
        }

      }

      // Handle system status (e.g., compacting, plan mode changes)
      const statusResult = parseSystemStatus(sdkMessage);
      if (statusResult.isStatusMessage) {
        console.log(`[agent] System status: ${statusResult.status}`);
        broadcast('chat:system-status', { status: statusResult.status });

        // Detect SDK-initiated plan mode changes (EnterPlanMode is auto-allowed by SDK)
        if (statusResult.permissionMode === 'plan' && currentPermissionMode !== 'plan') {
          prePlanPermissionMode = currentPermissionMode;
          currentPermissionMode = 'plan';
          broadcast('enter-plan-mode:request', { requestId: `sdk_auto_${Date.now()}`, autoApproved: true });
          broadcast('chat:permission-mode-changed', { permissionMode: 'plan' });
          console.log(`[agent] SDK auto-entered plan mode, saved prePlanPermissionMode=${prePlanPermissionMode}`);
        } else if (statusResult.permissionMode && statusResult.permissionMode !== 'plan' && prePlanPermissionMode) {
          // SDK exited plan mode (e.g. after ExitPlanMode approval)
          currentPermissionMode = prePlanPermissionMode;
          prePlanPermissionMode = null;
          broadcast('chat:permission-mode-changed', { permissionMode: currentPermissionMode });
          console.log(`[agent] SDK exited plan mode, restored currentPermissionMode=${currentPermissionMode}`);
        }
      }

      // SDK 0.2.83+: session_state_changed — authoritative turn boundary signal.
      // Currently logged for diagnostic comparison with self-built sessionState.
      if (sdkMessage.type === 'system' && (sdkMessage as { subtype?: string }).subtype === 'session_state_changed') {
        const state = (sdkMessage as { state?: string }).state;
        console.log(`[agent] SDK session_state_changed: ${state} (our sessionState: ${sessionState})`);

        // Adaptive startup timeout: extend when subprocess proves alive.
        // SDK emits session_state_changed:running early (before MCP handshake + system_init).
        // First-time workspace initialization on Windows can take minutes (SDK builds caches
        // for large directories). Extend the timeout so it doesn't kill a healthy subprocess.
        if (state === 'running' && !systemInitReceived && !startupTimeoutExtended && startupTimeoutId) {
          startupTimeoutExtended = true;
          clearTimeout(startupTimeoutId);
          startupTimeoutId = setTimeout(() => fireStartupTimeout(STARTUP_TIMEOUT_EXTENDED_MS), STARTUP_TIMEOUT_EXTENDED_MS);
          console.log(`[agent] Startup timeout extended to ${STARTUP_TIMEOUT_EXTENDED_MS / 1000}s (subprocess alive, awaiting system_init)`);
        }
      }

      // Handle background task lifecycle (SDK Task tool with run_in_background)
      // Gated behind type === 'system' to avoid unnecessary property access on high-frequency stream_events
      if (sdkMessage.type === 'system') {
        const taskMsg = sdkMessage as { subtype?: string; task_id?: string;
          tool_use_id?: string; description?: string; task_type?: string;
          status?: string; summary?: string; output_file?: string };
        if (taskMsg.subtype === 'task_started' && taskMsg.task_id) {
          console.log(`[agent] Background task started: ${taskMsg.task_id} — ${taskMsg.description}`);
          broadcast('chat:task-started', {
            taskId: taskMsg.task_id,
            toolUseId: taskMsg.tool_use_id,
            description: taskMsg.description,
            taskType: taskMsg.task_type,
          });
        } else if (taskMsg.subtype === 'task_notification' && taskMsg.task_id) {
          console.log(`[agent] Background task ${taskMsg.status}: ${taskMsg.task_id} — ${taskMsg.summary}`);
          broadcast('chat:task-notification', {
            taskId: taskMsg.task_id,
            toolUseId: taskMsg.tool_use_id,
            status: taskMsg.status,
            summary: taskMsg.summary,
            outputFile: taskMsg.output_file,
          });
        }

        // Handle API retry events (v0.2.77+) — show retry status to user
        // SDK emits these when the Anthropic API returns rate_limit or transient errors
        // and the SDK is automatically retrying. Without handling, user sees "stuck" behavior.
        // Field names match SDKAPIRetryMessage type: attempt, max_retries, retry_delay_ms
        const retryMsg = sdkMessage as { subtype?: string; attempt?: number; max_retries?: number; retry_delay_ms?: number; error?: unknown; error_status?: number | null };
        if (retryMsg.subtype === 'api_retry') {
          isApiRetrying = true;
          const errorStr = typeof retryMsg.error === 'string' ? retryMsg.error : JSON.stringify(retryMsg.error ?? null);
          console.log(`[agent] API retry: attempt=${retryMsg.attempt}/${retryMsg.max_retries}, delay=${retryMsg.retry_delay_ms}ms, error=${errorStr}, status=${retryMsg.error_status ?? 'null'}`);
          broadcast('chat:api-retry', {
            attempt: retryMsg.attempt,
            maxRetries: retryMsg.max_retries,
            delayMs: retryMsg.retry_delay_ms,
          });
        }
      }

      // Skip error extraction for api_retry — its .error field describes why the SDK
      // is retrying (e.g. "unknown", "overloaded"), NOT an agent-level error.
      // api_retry is already handled by the dedicated handler above (chat:api-retry).
      const isApiRetry = sdkMessage.type === 'system' &&
        (sdkMessage as { subtype?: string }).subtype === 'api_retry';
      if (!isApiRetry) {
        const agentError = extractAgentError(sdkMessage);
        if (agentError) {
          lastAgentError = agentError;
          broadcast('chat:agent-error', { message: agentError });
        }
      }
      if (shouldAbortSession) {
        break;
      }

      if (sdkMessage.type === 'stream_event') {
        // Clear api_retry status when streaming resumes after a successful retry
        if (isApiRetrying) {
          isApiRetrying = false;
          broadcast('chat:api-retry', null);
        }
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
                // Skip broadcasting delta for stripped Playwright tools (keep in-memory data intact)
                if (!strippedToolResultIds.has(sdkMessage.parent_tool_use_id)) {
                  broadcast('chat:tool-result-delta', {
                    toolUseId: sdkMessage.parent_tool_use_id,
                    delta: streamEvent.delta.text
                  });
                }
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
                  // Handler first: appendTextChunk → ensureAssistantMessage() may flush
                  // pendingMidTurnQueue. Broadcast after so frontend splits before new content.
                  appendTextChunk(streamEvent.delta.text);
                  broadcast('chat:message-chunk', streamEvent.delta.text);
                  currentTurnHasOutput = true;
                  // IM stream: forward non-subagent text delta (cross-turn guard)
                  if (!imCallbackNulledDuringTurn) imStreamCallback?.('delta', streamEvent.delta.text);
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
          // Implicit thinking close: when a non-thinking content block starts (text, tool_use),
          // force-close any unclosed thinking blocks in backend state.
          // Frontend does its own implicit close, so this keeps backend state consistent.
          if (streamEvent.content_block.type !== 'thinking') {
            const lastAssistant = messages.length > 0 ? messages[messages.length - 1] : null;
            if (lastAssistant?.role === 'assistant' && typeof lastAssistant.content !== 'string') {
              for (const block of lastAssistant.content) {
                if (block.type === 'thinking' && !block.isComplete) {
                  block.isComplete = true;
                  block.thinkingDurationMs = block.thinkingStartedAt ? Date.now() - block.thinkingStartedAt : undefined;
                  console.log('[agent] Implicitly closed orphaned thinking block on new content_block_start');
                }
              }
            }
          }
          // IM stream: track text block indices (non-subagent only, cross-turn guard)
          // Flush pending mid-turn queue at non-subagent text content_block_start.
          // thinking/tool_use/server_tool_use are covered by their start handlers.
          // Subagent text blocks are skipped (they operate within a parent tool context).
          if (streamEvent.content_block.type === 'text' && !sdkMessage.parent_tool_use_id) {
            flushPendingMidTurnQueue();
          }
          if (imStreamCallback && !sdkMessage.parent_tool_use_id && !imCallbackNulledDuringTurn) {
            if (streamEvent.content_block.type === 'text') {
              imTextBlockIndices.add(streamEvent.index);
            } else {
              // Notify non-text block activity (thinking, tool_use) so IM can show placeholder
              imStreamCallback('activity', streamEvent.content_block.type);
            }
          }
          // Track block type by stream index for precise subagent content_block_stop handling
          streamIndexToBlockType.set(streamEvent.index, streamEvent.content_block.type);
          if (streamEvent.content_block.type === 'thinking') {
            // Handler first: ensureAssistantMessage() may flush pendingMidTurnQueue
            // (broadcasting queue:started). The thinking-start broadcast must come AFTER
            // so the frontend splits streaming before adding new content.
            handleThinkingStart(streamEvent.index);
            broadcast('chat:thinking-start', { index: streamEvent.index });
          } else if (streamEvent.content_block.type === 'tool_use') {
            streamIndexToToolId.set(streamEvent.index, streamEvent.content_block.id);
            // Note: thought_signature is no longer extracted here. The bridge strips it from
            // Anthropic-format events to prevent SDK transcript pollution (see #68). The bridge
            // handler caches thought_signatures separately and re-injects on outgoing requests.
            const contentBlock = streamEvent.content_block as { id: string; name: string; input?: Record<string, unknown> };
            const toolPayload = {
              id: contentBlock.id,
              name: contentBlock.name,
              input: contentBlock.input || {},
              streamIndex: streamEvent.index,
            };
            if (sdkMessage.parent_tool_use_id) {
              handleSubagentToolUseStart(sdkMessage.parent_tool_use_id, toolPayload);
              broadcast('chat:subagent-tool-use', {
                parentToolUseId: sdkMessage.parent_tool_use_id,
                tool: toolPayload
              });
            } else {
              // Handler first: ensureAssistantMessage() may flush pendingMidTurnQueue
              // (broadcasting queue:started). The tool-use-start broadcast must come AFTER
              // so the frontend splits streaming before adding new content.
              handleToolUseStart(toolPayload);
              broadcast('chat:tool-use-start', toolPayload);
              pendingTools++;
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
            // Handler first: ensureAssistantMessage() may flush pendingMidTurnQueue.
            handleServerToolUseStart(toolPayload);
            broadcast('chat:server-tool-use-start', toolPayload);
          } else if (
            // 'tool_result' was removed from the SDK's content_block.type union when
            // claude-agent-sdk 0.2.86 added @anthropic-ai/sdk as a direct dependency
            // (previously the union erased to `string` so the comparison type-checked).
            // Runtime-wise this branch has always been dead for plain 'tool_result' —
            // regular tool results arrive via user-turn content blocks, not stream events.
            (streamEvent.content_block.type === 'web_search_tool_result' ||
              streamEvent.content_block.type === 'web_fetch_tool_result' ||
              streamEvent.content_block.type === 'code_execution_tool_result' ||
              streamEvent.content_block.type === 'bash_code_execution_tool_result' ||
              streamEvent.content_block.type === 'text_editor_code_execution_tool_result' ||
              streamEvent.content_block.type === 'mcp_tool_result') &&
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
                // Strip Playwright tool results from frontend broadcast
                const shouldStripResult = isPlaywrightTool(toolResultBlock.tool_use_id);
                if (shouldStripResult) {
                  strippedToolResultIds.add(toolResultBlock.tool_use_id);
                }
                broadcast('chat:tool-result-start', {
                  toolUseId: toolResultBlock.tool_use_id,
                  content: shouldStripResult ? PLAYWRIGHT_RESULT_SENTINEL : contentStr,
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
            // Subagent thinking/text blocks: broadcast content-block-stop so frontend can close
            // the thinking timer. Without this, subagent thinking blocks stay "incomplete"
            // and the timer runs for the entire remaining duration of the parent tool call.
            const blockType = streamIndexToBlockType.get(streamEvent.index);
            if (blockType === 'thinking' || blockType === 'text') {
              broadcast('chat:content-block-stop', {
                index: streamEvent.index,
              });
              handleContentBlockStop(streamEvent.index, undefined);
            }
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
            // IM stream: signal text block end (cross-turn guard)
            if (imStreamCallback && !imCallbackNulledDuringTurn && imTextBlockIndices.has(streamEvent.index)) {
              imStreamCallback('block-end', '');
              imTextBlockIndices.delete(streamEvent.index);
            }
          }
        }
      } else if (sdkMessage.type === 'user') {
        // Track SDK user UUID — only for non-synthetic messages
        if (!(sdkMessage as { isSynthetic?: boolean }).isSynthetic && sdkMessage.uuid) {
          currentSessionUuids.add(sdkMessage.uuid);
          liveSessionUuids.add(sdkMessage.uuid);
          for (let i = messages.length - 1; i >= 0; i--) {
            if (messages[i].role === 'user' && !messages[i].sdkUuid) {
              messages[i].sdkUuid = sdkMessage.uuid;
              broadcast('chat:message-sdk-uuid', { messageId: messages[i].id, sdkUuid: sdkMessage.uuid });
              break;
            }
          }
        }
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
                const stripped = strippedToolResultIds.has(toolResultBlock.tool_use_id) || isPlaywrightTool(toolResultBlock.tool_use_id);
                broadcast('chat:tool-result-complete', {
                  toolUseId: toolResultBlock.tool_use_id,
                  content: stripped ? PLAYWRIGHT_RESULT_SENTINEL : contentStr
                });
                pendingTools = Math.max(0, pendingTools - 1);
              }
              handleToolResultComplete(toolResultBlock.tool_use_id, contentStr);
            }
          }
          }
        }
      } else if (sdkMessage.type === 'assistant') {
        // Track SDK assistant UUID for resumeSessionAt / rewindFiles
        const currentAssistant = ensureAssistantMessage();
        // 始终更新为最新的 UUID — SDK 一个回合可能输出多条 assistant 消息
        // （thinking → text），resumeSessionAt 需要最后一条的 UUID 才能保留完整回答
        if (sdkMessage.uuid) {
          currentSessionUuids.add(sdkMessage.uuid);
          liveSessionUuids.add(sdkMessage.uuid);
          currentAssistant.sdkUuid = sdkMessage.uuid;
          // Broadcast to frontend so fork button appears during streaming
          // (user messages already broadcast this; assistant messages were missing it)
          broadcast('chat:message-sdk-uuid', { messageId: currentAssistant.id, sdkUuid: sdkMessage.uuid });
        }
        const assistantMessage = sdkMessage.message;
        // Main turn token usage is extracted from result message (more reliable across providers)
        // Here we extract usage only for subagent tool broadcasts (Task tool runtime stats)
        const rawUsage = (assistantMessage as {
          usage?: {
            input_tokens?: number;
            output_tokens?: number;
            prompt_tokens?: number;
            completion_tokens?: number;
          };
        }).usage;
        const subagentUsage = rawUsage ? {
          input_tokens: rawUsage.input_tokens ?? rawUsage.prompt_tokens,
          output_tokens: rawUsage.output_tokens ?? rawUsage.completion_tokens,
        } : undefined;

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
                usage: subagentUsage
              });
              handleSubagentToolUseStart(sdkMessage.parent_tool_use_id, payload);
            }
          }
        }
        if (sdkMessage.parent_tool_use_id) {
          const text = formatAssistantContent(assistantMessage.content);
          if (text) {
            const next = appendToolResultContent(sdkMessage.parent_tool_use_id, text);
            const stripped = strippedToolResultIds.has(sdkMessage.parent_tool_use_id) || isPlaywrightTool(sdkMessage.parent_tool_use_id);
            broadcast('chat:tool-result-complete', {
              toolUseId: sdkMessage.parent_tool_use_id,
              content: stripped ? PLAYWRIGHT_RESULT_SENTINEL : next
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
                const stripped = strippedToolResultIds.has(toolResultBlock.tool_use_id) || isPlaywrightTool(toolResultBlock.tool_use_id);
                broadcast('chat:tool-result-complete', {
                  toolUseId: toolResultBlock.tool_use_id,
                  content: stripped ? PLAYWRIGHT_RESULT_SENTINEL : contentStr,
                  isError: toolResultBlock.is_error || false
                });
                pendingTools = Math.max(0, pendingTools - 1);
              }
              handleToolResultComplete(
                toolResultBlock.tool_use_id,
                contentStr,
                toolResultBlock.is_error || false
              );
            }
          }
        }

        // Handle non-streamed text content from assistant messages.
        // Some providers (OpenAI-compatible, third-party Anthropic proxies) return responses
        // without streaming content_block_delta text events — the text only appears in the
        // final assistant message. Without this, currentTurnHasOutput stays false and the
        // result handler erroneously shows normal responses as agent-error banners.
        // Skip error-wrapped messages (SDK sets "error" field on synthetic error responses)
        // — these should be surfaced via the result handler's agent-error banner instead.
        const isErrorWrapped = !!(sdkMessage as Record<string, unknown>).error;
        if (!sdkMessage.parent_tool_use_id && !currentTurnHasOutput && !isErrorWrapped && assistantMessage.content) {
          const nonStreamedParts: string[] = [];
          for (const block of assistantMessage.content) {
            if (
              typeof block === 'object' &&
              block !== null &&
              'type' in block &&
              block.type === 'text' &&
              'text' in block
            ) {
              const text = String((block as { text: string }).text || '');
              if (text) nonStreamedParts.push(text);
            }
          }
          const nonStreamedText = nonStreamedParts.join('');
          if (nonStreamedText) {
            console.log(`[agent] Non-streamed assistant text detected (${nonStreamedText.length} chars), broadcasting as message-chunk`);
            // Handler first: appendTextChunk → ensureAssistantMessage() may flush
            // pendingMidTurnQueue. Broadcast after so frontend splits before new content.
            appendTextChunk(nonStreamedText);
            broadcast('chat:message-chunk', nonStreamedText);
            currentTurnHasOutput = true;
            if (!imCallbackNulledDuringTurn) imStreamCallback?.('delta', nonStreamedText);
          }
        }
      } else if (sdkMessage.type === 'result') {
        // Turn complete — reset watchdog state for next turn
        pendingTools = 0;
        watchdogFired = false;
        // Signal post-interrupt verification (if waiting)
        if (postInterruptTurnEndResolve) {
          postInterruptTurnEndResolve();
          postInterruptTurnEndResolve = null;
        }
        // Extract token usage from result message
        // SDK result contains modelUsage (per-model stats) and/or usage (aggregate)
        // This is the authoritative source for token statistics
        const resultMessage = sdkMessage as {
          type: 'result';
          is_error?: boolean;
          result?: string;
          errors?: string[];
          // SDK 0.2.91+ 新增：标识 result 终止原因。字段缺失表示 loop 被 bypass
          // (本地 slash 命令) 或在 yield 之间被外部中断。使用 SDK 导出的 TerminalReason
          // 联合类型而非裸 string，确保 SDK 升级新增枚举值时 tsc 能捕获缺失处理。
          terminal_reason?: import('@anthropic-ai/claude-agent-sdk').TerminalReason;
          usage?: {
            input_tokens?: number;
            output_tokens?: number;
            cache_read_input_tokens?: number;
            cache_creation_input_tokens?: number;
          };
          modelUsage?: Record<string, {
            inputTokens?: number;
            outputTokens?: number;
            cacheReadInputTokens?: number;
            cacheCreationInputTokens?: number;
          }>;
        };

        // Forward SDK error results to IM callback (prevents "(No Response)")
        if (resultMessage.is_error) {
          const rawError = resultMessage.result || resultMessage.errors?.join('; ') || '';
          // Detect image content error — reset session to clear polluted history
          // (applies to both IM and desktop: prevents all subsequent messages from failing)
          // Pattern 1: malformed image block (e.g., wrong content type)
          // Pattern 2: oversized image (>8000px, from tools returning large screenshots)
          // Known API error: "...image.source.base64.data: At least one of the image dimensions exceed max allowed size: 8000 pixels"
          if (
            (rawError.includes('unknown variant') && rawError.includes('image')) ||
            (rawError.includes('image') && rawError.includes('exceed') && rawError.includes('max allowed size'))
          ) {
            shouldResetSessionAfterError = true;
            shouldResetReason = 'image';
          }
          // Detect stale session — SDK started (system_init received) but conversation
          // data is broken (e.g., IM Bot restart: old session_id restored from disk,
          // SDK directory exists but conversation context is unusable).
          // Without this, the persistent session loops: every message gets the same error
          // because sessionRegistered stays true and SDK keeps trying --resume.
          // The catch-block recovery (below) only covers Scenario A (SDK throws on startup);
          // this covers Scenario B (SDK starts, returns is_error in result message).
          if (rawError.includes('No conversation found')) {
            shouldResetSessionAfterError = true;
            shouldResetReason = 'stale';
          }
          if (imStreamCallback) {
            const errorText = localizeImError(rawError);
            console.warn('[agent] SDK result is_error, forwarding to IM:', errorText);
            imStreamCallback('error', errorText);
            imStreamCallback = null;
          }
        }

        // Surface SDK-level errors that produced no assistant output (e.g. "Unknown skill: xxx").
        // These results have non-empty result text but no visible assistant text was streamed.
        // Without this, the user sees nothing — the message just silently completes.
        // Only show agent-error for is_error results — non-error results from non-streaming
        // providers are handled in the assistant message handler above.
        const resultText = resultMessage.result || '';
        if (resultText && !currentTurnHasOutput && !currentTurnToolCount) {
          if (resultMessage.is_error) {
            console.warn('[agent] SDK error result with no streamed output, showing as agent-error:', resultText);
            broadcast('chat:agent-error', { message: resultText });
          } else {
            // Non-error result text that wasn't captured by streaming or assistant handler
            // (safety net — should rarely trigger after the assistant handler fix above)
            console.warn('[agent] SDK non-error result with no streamed output, showing as message:', resultText);
            // Handler first (same pattern as streamed text path)
            appendTextChunk(resultText);
            broadcast('chat:message-chunk', resultText);
          }
          // Forward to IM callback (prevents "(No Response)" for SDK failures)
          // Cross-turn guard: only forward if callback was not nulled/replaced
          if (imStreamCallback && !imCallbackNulledDuringTurn) {
            imStreamCallback('complete', resultText);
            imStreamCallback = null;
          }
        }

        // Prefer modelUsage (per-model breakdown), fallback to aggregate usage
        if (resultMessage.modelUsage) {
          let totalInput = 0;
          let totalOutput = 0;
          let totalCacheRead = 0;
          let totalCacheCreation = 0;
          let primaryModel: string | undefined;
          let maxModelTokens = 0;
          const modelUsageMap: Record<string, ModelUsageEntry> = {};

          for (const [model, stats] of Object.entries(resultMessage.modelUsage)) {
            const modelInput = stats.inputTokens ?? 0;
            const modelOutput = stats.outputTokens ?? 0;
            const modelCacheRead = stats.cacheReadInputTokens ?? 0;
            const modelCacheCreation = stats.cacheCreationInputTokens ?? 0;

            totalInput += modelInput;
            totalOutput += modelOutput;
            totalCacheRead += modelCacheRead;
            totalCacheCreation += modelCacheCreation;

            // Save per-model breakdown
            modelUsageMap[model] = {
              inputTokens: modelInput,
              outputTokens: modelOutput,
              cacheReadTokens: modelCacheRead || undefined,
              cacheCreationTokens: modelCacheCreation || undefined,
            };

            // Track primary model (highest token usage)
            const modelTotal = modelInput + modelOutput;
            if (modelTotal > maxModelTokens) {
              maxModelTokens = modelTotal;
              primaryModel = model;
            }
          }

          currentTurnUsage.inputTokens = totalInput;
          currentTurnUsage.outputTokens = totalOutput;
          currentTurnUsage.cacheReadTokens = totalCacheRead;
          currentTurnUsage.cacheCreationTokens = totalCacheCreation;
          currentTurnUsage.model = primaryModel;
          currentTurnUsage.modelUsage = modelUsageMap;

          if (isDebugMode) {
            console.log(`[agent] Token usage from result.modelUsage: input=${totalInput}, output=${totalOutput}, models=${Object.keys(modelUsageMap).join(', ')}`);
          }
        } else if (resultMessage.usage) {
          currentTurnUsage.inputTokens = resultMessage.usage.input_tokens ?? 0;
          currentTurnUsage.outputTokens = resultMessage.usage.output_tokens ?? 0;
          currentTurnUsage.cacheReadTokens = resultMessage.usage.cache_read_input_tokens ?? 0;
          currentTurnUsage.cacheCreationTokens = resultMessage.usage.cache_creation_input_tokens ?? 0;
          if (isDebugMode) {
            console.log(`[agent] Token usage from result.usage: input=${currentTurnUsage.inputTokens}, output=${currentTurnUsage.outputTokens}`);
          }
        } else {
          console.warn('[agent] Result message has no usage data, token statistics may be incomplete');
        }

        // Calculate duration for analytics
        const durationMs = currentTurnStartTime ? Date.now() - currentTurnStartTime : 0;

        // Find the last assistant message's sdkUuid to piggyback on message-complete.
        // This avoids the ID mismatch problem: frontend streaming messages use Date.now()
        // IDs while backend uses messageSequence IDs, so the separate chat:message-sdk-uuid
        // event can't match. Piggybacking on message-complete lets the frontend set sdkUuid
        // on the just-moved history message without needing ID matching.
        const lastAssistant = messages.length > 0 && messages[messages.length - 1].role === 'assistant'
          ? messages[messages.length - 1] : null;

        // Log non-completed terminal_reasons to unified logs for debugging.
        // Some reasons (e.g. aborted_streaming) suppress the UI banner entirely
        // (see src/shared/terminalReason.ts), so this is the ONLY surface left
        // for figuring out why a turn ended early. One line per non-trivial turn
        // — low frequency, keeps signal tight.
        if (resultMessage.terminal_reason && resultMessage.terminal_reason !== 'completed') {
          console.log(`[agent][terminal_reason] ${resultMessage.terminal_reason} scenario=${currentScenario.type} model=${currentTurnUsage.model ?? 'unknown'} duration_ms=${durationMs} tool_count=${currentTurnToolCount}`);
        }

        console.log('[agent][sdk] Broadcasting chat:message-complete');
        // Include usage data for frontend analytics tracking + assistant sdkUuid for fork button
        broadcast('chat:message-complete', {
          model: currentTurnUsage.model,
          input_tokens: currentTurnUsage.inputTokens,
          output_tokens: currentTurnUsage.outputTokens,
          cache_read_tokens: currentTurnUsage.cacheReadTokens,
          cache_creation_tokens: currentTurnUsage.cacheCreationTokens,
          tool_count: currentTurnToolCount,
          duration_ms: durationMs,
          // SDK 0.2.91+ terminal_reason — 前端映射为中文 banner/toast。
          // 未设置时前端按 `completed` 处理（不显示额外提示）。
          terminal_reason: resultMessage.terminal_reason,
          // Piggyback sdkUuid + real message ID so fork button works immediately after streaming.
          // Frontend streaming messages use Date.now() IDs that don't match backend messageSequence IDs.
          assistant_sdk_uuid: lastAssistant?.sdkUuid,
          assistant_message_id: lastAssistant?.id,
        });

        // Server-side unified analytics: covers all sources (desktop/cron/im)
        trackServer('ai_turn_complete', {
          source: currentScenario.type,
          platform: currentScenario.type === 'im' ? currentScenario.platform : null,
          runtime: 'builtin',
          model: currentTurnUsage.model ?? null,
          input_tokens: currentTurnUsage.inputTokens,
          output_tokens: currentTurnUsage.outputTokens,
          cache_read_tokens: currentTurnUsage.cacheReadTokens,
          cache_creation_tokens: currentTurnUsage.cacheCreationTokens,
          tool_count: currentTurnToolCount,
          duration_ms: durationMs,
        });

        handleMessageComplete();

        // Post-turn error recovery. Three policies based on scenario × reason:
        //
        // 1. desktop + 'image': skip reset. Frontend surfaces an error banner that
        //    guides the user to time-rewind (preserves conversation context).
        //
        // 2. desktop + 'stale' ("No conversation found"): SessionStore still has
        //    the history but SDK's project data was wiped (old build, external
        //    clear, etc.). Do NOT call resetSession — that generates a new
        //    sessionId, broadcasts chat:init, and wipes the frontend's loaded
        //    view. Instead, recover in place: tear down the failed SDK
        //    subprocess, disarm resume, and pre-warm a fresh SDK session reusing
        //    the same sessionId. The user keeps seeing their history, next
        //    message starts a brand-new conversation inside the same session
        //    timeline. Data/UX never appears to "vanish".
        //
        // 3. everything else (IM, cron, sub-agent, unknown reason): full
        //    resetSession. IM/cron has no UI to confirm against.
        if (shouldResetSessionAfterError) {
          shouldResetSessionAfterError = false;
          const reason = shouldResetReason;
          shouldResetReason = undefined;
          const isDesktop = currentScenario.type === 'desktop';

          if (isDesktop && reason === 'image') {
            console.warn('[agent] Desktop image error — skipping auto-reset, frontend will offer rewind');
          } else if (isDesktop && reason === 'stale') {
            console.warn('[agent] Desktop stale session — recovering in place, sessionId + history preserved');
            recoverFromStaleSession().catch(e => console.error('[agent] Stale recovery failed:', e));
          } else {
            console.warn('[agent] Auto-resetting session due to unrecoverable conversation error');
            resetSession().catch(e => console.error('[agent] Auto-reset failed:', e));
          }
        }

        // Deferred config restart: MCP/Agents changed during this turn but we didn't
        // abort mid-response. Now that the turn completed naturally, restart the session
        // so the new config takes effect. The generator will see shouldAbortSession and exit.
        // schedulePreWarm() ensures a new session starts after the abort completes.
        // The 500ms timer gives enough time for the finally block to run (isProcessing=false)
        // before the new startStreamingSession is called.
        // sessionRegistered is preserved, so the new session will use resume.
        if (hasDeferredRestart()) {
          const reasons = drainDeferredRestart();
          console.log(`[agent] Turn complete, applying deferred config restart (reasons=${reasons})`);
          abortPersistentSession();
          schedulePreWarm();
        }
      }
    }
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : 'Unknown error occurred';
    const errorStack = error instanceof Error ? error.stack : String(error);
    console.error('[agent] session error:', errorMessage);
    console.error('[agent] session error stack:', errorStack);

    // "Session ID already in use" recovery: SDK session dir exists on disk but our
    // in-memory metadata was lost (fresh Bun process after crash/restart).
    // Fix: switch to resume mode. Pre-warm retry (finally block) will use resume.
    // For non-pre-warm: schedule pre-warm to establish resumed session; user's message
    // is lost for this attempt, but the next message will work correctly.
    if (detectedAlreadyInUse && !sessionRegistered) {
      console.warn(`[agent] Session ${sessionId} exists on disk but metadata lost, switching to resume for retry`);
      sessionRegistered = true;
      if (!isPreWarming) {
        schedulePreWarm(); // Establish resumed session so next user message works
      }
      return; // Skip error broadcast, let finally handle cleanup + pre-warm retry
    }

    // "No message found with message.uuid" recovery: resumeSessionAt pointed to a UUID
    // that doesn't exist in the SDK's session JSONL. This happens when:
    //   - Session was rebuilt (No conversation found → new session, old UUIDs stale)
    //   - SDK's async JSONL save didn't flush before subprocess was interrupted
    //   - currentSessionUuids (seeded from disk) included UUIDs from a previous SDK session
    // Fix: clear the invalid rewind anchor so retry resumes with full history intact.
    // Keep sessionRegistered=true — the session itself exists, only the UUID is wrong.
    // The retry will use `resume: sessionId` without resumeSessionAt, loading all messages.
    if (errorMessage.includes('No message found with message.uuid') && sessionRegistered) {
      const rejectedUuid = pendingResumeSessionAt;
      console.warn(`[agent] resumeSessionAt UUID rejected by SDK — clearing rewind anchor, retry will resume with full history`);
      pendingResumeSessionAt = undefined;
      // Evict the rejected UUID from currentSessionUuids so subsequent rewinds don't
      // re-accept it via the OR logic. Without this, the stale UUID stays in the cache
      // and a future rewind to the same point would re-trigger the same SDK error.
      if (rejectedUuid) {
        currentSessionUuids.delete(rejectedUuid);
      }
      // Don't modify sessionRegistered — session exists, just the UUID is invalid.
      // Don't return — let pre-warm retry (finally block) handle recovery.
      // For non-pre-warm (user message triggered): fall through to error broadcast.
    }

    // "No conversation found" recovery: our metadata has sessionRegistered=true but
    // the SDK session directory is gone (e.g., IM Bot restart after previous Sidecar
    // failed to start — proxy leak, network error — so the session was persisted to
    // im_state.json but the SDK conversation was never actually created).
    // Fix: switch to create mode. Don't return — let the error flow through to notify
    // IM/Desktop user. Pre-warm (scheduled here or in finally) will create a fresh session.
    if (errorMessage.includes('No conversation found') && sessionRegistered) {
      console.warn(`[agent] Session ${sessionId} not found by SDK, resetting sessionRegistered for fresh start`);
      sessionRegistered = false;
      if (!isPreWarming) {
        schedulePreWarm(); // Establish fresh session so next user message works
      }
      // Fall through to error handling so IM SSE stream closes properly
    }

    // Enhanced error diagnostics for Windows subprocess failures
    let userFacingError = errorMessage;
    if (errorMessage.includes('process exited with code 1') && process.platform === 'win32') {
      console.error('[agent] Windows subprocess failure detected. Possible causes:');
      console.error('[agent] 1. Git for Windows not installed (most common)');
      console.error('[agent] 2. Git Bash not in PATH');
      console.error('[agent] 3. CLAUDE_CODE_GIT_BASH_PATH environment variable not set');
      console.error('[agent] Windows version:', process.env.OS || 'unknown');
      userFacingError = '子进程启动失败 (exit code 1)。最可能原因：未安装 Git for Windows。请安装 Git：https://git-scm.com/downloads/win';
    }

    // Don't broadcast errors to frontend during pre-warm.
    // Failure counting is handled uniformly in the finally block via preWarmStartedOk flag,
    // so we don't increment preWarmFailCount here — avoids double-counting when both
    // catch and finally execute for the same failed pre-warm.
    if (!isPreWarming) {
      broadcast('chat:message-error', userFacingError);
      handleMessageError(errorMessage);
      setSessionState('error');
    }
  } finally {
    clearTimeout(startupTimeoutId);
    clearInterval(apiWatchdogId);
    const wasPreWarming = isPreWarming;
    isPreWarming = false;
    isProcessing = false;

    // Resolve any pending post-interrupt wait (session ended, turn is implicitly done)
    if (postInterruptTurnEndResolve) {
      postInterruptTurnEndResolve();
      postInterruptTurnEndResolve = null;
    }

    // 确保 generator 退出（防止 streamInput 永远阻塞）
    if (messageResolver) {
      const resolve = messageResolver;
      messageResolver = null;
      resolve(null);
    }

    // 防御：确保 isStreamingMessage 在 session 退出时被重置。
    // 正常路径由 handleMessageComplete/Stopped/Error 处理，但 subprocess
    // 崩溃可能导致这些 handler 未执行，标志孤立为 true。
    // 孤立的 true 会让所有新消息走 queue 路径（line 3350）且无人消费。
    if (isStreamingMessage) {
      console.warn('[agent] isStreamingMessage orphaned after session exit, resetting');
      isStreamingMessage = false;
    }

    // Session 意外死亡时排空队列，通知前端清除 "排队中" UI。
    // 不在主动 abort 时排空 — 调用方（resetSession/switchToSession 等）有自己的清理流程。
    if (!wasPreWarming && !shouldAbortSession && messageQueue.length > 0) {
      drainQueueWithCancellation();
    }

    // 安全关闭 SDK session
    const session = querySession;
    querySession = null;
    try { session?.close(); } catch { /* subprocess 可能已退出 */ }

    // sessionRegistered 已在 system_init handler 中设置，无需重复

    // Don't broadcast state changes from pre-warm sessions
    if (!wasPreWarming) {
      if (sessionState !== 'error') {
        setSessionState('idle');
      }
    }

    clearCronTaskContext();
    clearSessionCronContext();
    // NOTE: Do NOT clear im-media / im-bridge-tools here.
    // These are Sidecar-scoped contexts (set by Rust IM router via /api/im/chat),
    // not session-scoped. Clearing them on session end (including /new resets)
    // causes pre-warm to rebuild MCP servers without bridge tools, leaving the
    // AI with no feishu/plugin capabilities until the next IM message arrives.
    // They are cleared when the Sidecar Owner is fully released (IM Bot stops).
    resolveTermination!();

    if (wasPreWarming) {
      // sessionRegistered 不修改 — pre-warm 永不触碰此标志

      if (!preWarmStartedOk) {
        if (!shouldAbortSession || abortedByTimeout) {
          preWarmFailCount++;
          console.warn(`[agent] pre-warm failed, failCount=${preWarmFailCount}${abortedByTimeout ? ' (timeout)' : ''}`);
        } else {
          console.log('[agent] pre-warm aborted by config change');
        }
      }

      if (!preWarmStartedOk || shouldAbortSession) {
        schedulePreWarm();
      }
    } else if (!shouldAbortSession && sessionRegistered) {
      // 非主动中止的意外退出（subprocess crash / error）→ 安排恢复。
      // 包含 sessionState === 'error' 的情况 — session 刚死，必须恢复，
      // 否则用户再发消息时无可用 subprocess。
      // Error 已通过 catch block 广播给前端（line 4702），用户已知出错。
      console.log('[agent] Unexpected session exit, scheduling recovery pre-warm');
      preWarmFailCount = 0; // 新的故障上下文，重置重试计数
      schedulePreWarm();
    }

    // Safety net: detect orphaned messages left in queue with no session or timer to process them.
    // Race condition: enqueueUserMessage arrives between abortPersistentSession() and this finally
    // block — it cancels the pre-warm timer and steals isPreWarming flag, causing BOTH branches
    // above to miss. Without this, messages sit in queue indefinitely until a window refocus
    // or other external event triggers a re-sync.
    if (messageQueue.length > 0 && !preWarmTimer && !isProcessing && querySession === null) {
      console.warn(`[agent] Safety net: ${messageQueue.length} orphaned message(s) in queue, scheduling recovery`);
      preWarmFailCount = 0;
      schedulePreWarm();
    }
  }
}

async function* messageGenerator(): AsyncGenerator<SDKUserMessage> {
  // Yield-and-ready 模式：generator yield 后立即回到 waitForMessage，有新消息即再次 yield。
  // SDK 的 for-await 立即写入 stdin pipe，subprocess 在 tool call / thinking 间隙读取。
  // 不再等待 turn 完成（waitForTurnComplete），实现 mid-turn 消息注入。
  // 唯一退出信号：waitForMessage() 返回 null（由 abortPersistentSession 触发）。
  console.log('[messageGenerator] Started (persistent mode, mid-turn injection enabled)');

  while (true) {
    // 等待队列中的消息（事件驱动，无轮询）
    const item = await waitForMessage();
    if (!item) {
      console.log('[messageGenerator] Received null — exiting (abort or session end)');
      return; // generator return → SDK endInput() → stdin EOF → subprocess 退出
    }

    // Transition from pre-warm to active when processing a queued message.
    // This handles a race: if enqueueUserMessage was called during session abort
    // (shouldAbortSession=true), the pre-warm→active transition was skipped there.
    // A new session then starts in pre-warm mode, and the messageGenerator picks up
    // the queued message — but nobody transitions isPreWarming to false. Setting it
    // false HERE ensures that when system_init arrives from the SDK (after this yield),
    // it goes through the direct-broadcast path (line ~4256) instead of being buffered.
    // Without this, the frontend never receives system_init, so currentSessionIdRef
    // stays as the pending placeholder and title generation sends the wrong sessionId → 404.
    if (isPreWarming) {
      isPreWarming = false;
      if (systemInitInfo) {
        sessionRegistered = true;
        broadcast('chat:system-init', { info: systemInitInfo, sessionId });
      }
      if (preWarmTimer) {
        clearTimeout(preWarmTimer);
        preWarmTimer = null;
      }
      console.log(`[agent] pre-warm → active (from queued message), sessionRegistered=${sessionRegistered}`);
    }

    // 排队消息的延迟渲染
    if (item.wasQueued) {
      const userMessage: MessageWire = {
        id: String(messageSequence++),
        role: 'user',
        content: item.messageText,
        timestamp: new Date().toISOString(),
        attachments: item.attachments,
      };

      const isMidTurn = isStreamingMessage;
      if (!isMidTurn) {
        // Normal turn start: push to messages, persist, broadcast immediately
        messages.push(userMessage);
        persistMessagesToStorage();
        resetTurnUsage();
        currentTurnStartTime = Date.now();
        broadcast('queue:started', {
          queueId: item.id,
          userMessage: {
            id: userMessage.id,
            role: userMessage.role,
            content: userMessage.content,
            timestamp: userMessage.timestamp,
            attachments: userMessage.attachments,
          },
        });
      } else {
        // Mid-turn injection: defer BOTH the messages[] push AND queue:started broadcast.
        // The user message must NOT be in messages[] while old content is still streaming,
        // because ensureAssistantMessage() checks the last message's role — a premature
        // user message at the end would cause it to create a new assistant and flush,
        // splitting the OLD text stream at the wrong point (text_delta from the current
        // response would trigger the flush, not a genuine new response from the AI).
        // The message is pushed to messages[] when the turn ends (handleMessageComplete/
        // handleMessageStopped flush).
        pendingMidTurnQueue.push({
          queueId: item.id,
          userMessage: {
            id: userMessage.id,
            role: userMessage.role,
            content: userMessage.content,
            timestamp: userMessage.timestamp,
            attachments: userMessage.attachments,
          },
        });
      }
    }

    // Yield 消息到 SDK stdin
    // Only reset cross-turn guards for NEW turns (not mid-turn injections).
    const isMidTurnInjection = isStreamingMessage;
    if (!isMidTurnInjection) {
      // Reset cross-turn guard: this turn starts fresh, no timeout/replacement yet.
      imCallbackNulledDuringTurn = false;
      isStreamingMessage = true;
    } else if (imStreamCallback) {
      // Mid-turn injection WITH an active IM callback: this is a new IM message that was
      // queued during session restart (e.g., MCP config change). The flag may have been set
      // to true during the restart. Reset it so delta/block-end events are forwarded.
      imCallbackNulledDuringTurn = false;
    }
    console.log(`[messageGenerator] Yielding message, wasQueued=${item.wasQueued}, midTurn=${isMidTurnInjection}`);
    yield {
      type: 'user' as const,
      message: item.message,
      parent_tool_use_id: null,
      session_id: getSessionId()
    };
    item.resolve();
    // Mid-turn injection: 不等 turn 完成，立即准备 yield 下一条。
    // SDK 的 for-await 会立即写入 stdin pipe，subprocess 在断点处读取。
  }
}

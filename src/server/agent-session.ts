import { randomUUID } from 'crypto';
import { existsSync, readdirSync, symlinkSync, lstatSync, readFileSync, readlinkSync, rmSync } from 'fs';
import { dirname, join, resolve, sep } from 'path';
import { createRequire } from 'module';
import { query, getSessionMessages as sdkGetSessionMessages, forkSession as sdkForkSession, deleteSession as sdkDeleteSession, type Query, type SDKUserMessage, type AgentDefinition, type HookInput, type HookJSONOutput, type PostToolUseHookInput, type PermissionRequestHookInput } from '@anthropic-ai/claude-agent-sdk';
import {
  decideBackgroundAgentPermission,
  isBackgroundAgentToolRequest,
  backgroundAgentDenyMessage,
  DEFAULT_BACKGROUND_AGENT_PERMISSION_MODE,
  type BackgroundAgentPermissionMode,
} from './utils/background-agent-permission';
import { registerBridge as registerBridgeInRegistry, unregisterBridge as unregisterBridgeInRegistry, type UpstreamBridgeConfig } from './openai-bridge/bridge-registry';
import { getScriptDir, getBundledNodeDir, getSystemNodeDirs, getBundledRuntimePath, getSystemNpxPaths, findExistingPath } from './utils/runtime';
import { getCrossPlatformEnv, isSkillBlockedOnPlatform } from './utils/platform';
import { ensureDirSync, isDirEntry } from './utils/fs-utils';
import { getMyAgentsNpmGlobalBinDir, getMyAgentsNpmGlobalPrefix, scrubMyAgentsNpmPrefixEnv } from './utils/npm-prefix-env';
import { applyContextWindowSuffix, lookupModelContextLength, modelSupportsModality } from './utils/model-capabilities';
import { modelAliasEnvChangesForModel, resolveSessionModelAliases, type ModelAliases } from './utils/model-aliases';
import { deriveReloadResumeAnchor, resolveEffectiveResumeAt } from './utils/rewind-anchor';
import { buildForkUuidRemap, remapStoredSdkUuids } from './utils/fork-remap';
import { decideInFlightActionOnResult } from './utils/inflight-terminal';
import { isEmptySuccessfulSdkResult, isRecoveredAssistantMessageError } from './utils/sdk-turn-outcome';
import { InactivityWatchdog } from './utils/inactivity-watchdog';
import { processImage, resizeToolImageContent, classifyImageError } from './utils/imageResize';
import { writeBase64FilesToAgentDir } from './utils/workspace-files';
import { ensureGitignorePattern } from './utils/gitignore';
import { extractToolResultRenderParts, type ExtractedToolResultAttachment } from './utils/tool-result-attachments';
// Context helpers only — tool server singletons are no longer exported from
// these modules. The actual SDK server objects are created on-demand via
// `getBuiltinMcpInstance()` in buildSdkMcpServers() below. See
// ./tools/builtin-mcp-meta.ts for META registrations.
import { clearCronTaskContext } from './tools/cron-tools';
import { getImCronContext, setSessionCronContext, clearSessionCronContext } from './tools/im-cron-tool';
import { getImBridgeToolsContext, getImBridgeToolServer } from './tools/im-bridge-tools';
import { getBuiltinMcpInstance } from './tools/builtin-mcp-registry';
// Side-effect import — registers META (ids + lazy factories) at cold start.
// Cheap: just function-ref storage, no SDK/zod eval, no tool module loaded.
import './tools/builtin-mcp-meta';
import { startSocksBridge, stopSocksBridge, isSocksBridgeRunning } from './utils/socks-bridge';
// Phase E (PRD 0.2.7): the sidecar file watcher (`file-watcher.ts` →
// SSE `workspace:files-changed`) is removed. The renderer subscribes to
// the Rust workspace_files watcher (Tauri event
// `workspace:files-changed:<eventKey>`) instead.
import { resolveAuthHeaders, onTokenChange, startTokenRefreshScheduler } from './mcp-oauth';
// Side-effect imports: each registers itself in the builtin MCP registry
// gemini-image / edge-tts registered in builtin-mcp-meta.ts.

import type { ToolInput } from '../renderer/types/chat';
import { parsePartialJson } from '../shared/parsePartialJson';
import { deriveSessionTitle } from '../shared/sessionTitle';
import type { SystemInitInfo } from '../shared/types/system';
import type { ToolAttachment } from '../shared/types/tool-attachment';
import { saveSessionMetadata, updateSessionTitleFromMessage, saveSessionMessages, saveAttachment, updateSessionMetadata, getSessionMetadata, getSessionData } from './SessionStore';
import { createSessionMetadata, type SessionMessage, type MessageAttachment, type MessageUsage, type SessionSource } from './types/session';
import {
  createMaterializedSessionMetadata,
  isLiveFollowScenario,
  type SessionMaterializationScenario,
} from './utils/session-materialization';
import { findAgentByWorkspacePath, loadConfig as loadAdminConfig } from './utils/admin-config';
import type { AgentConfig } from '../shared/types/agent';
import { broadcast } from './sse';
import {
  getEnabledPluginSdkConfigs,
  getDefaultEnabledPluginIdsForWorkspace,
} from './plugins/store';
import { seedBridgeThoughtSignatures } from './bridge-cache';
import { initLogger, appendLog, getLogLines as getLogLinesFromLogger } from './AgentLogger';
import { setAmbientLogContext, clearAmbientLogContextField } from './logger-context';
import { beginTurn as beginTurnAbort, endTurn as endTurnAbort, abortTurn as abortTurnAbort } from './utils/turn-abort';
import type { CancelReason } from './utils/cancellation';
import { localTimestamp } from '../shared/logTime';
import { trackServer } from './analytics';
import { getCurrentRuntimeType, isExternalRuntime } from './runtimes/factory';
import { resolveLastRealUserMessagePreview } from './utils/session-message-preview';
import type { ImagePayload } from './runtimes/types';
import {
  awaitInFlightSaves,
  makeErrorAttachment,
  makePlaceholderAttachment,
  saveToolAttachment,
  trackInFlightSave,
  type SaveContext,
} from './runtimes/tool-attachments';
import { imEventBus, type ImEventType } from './utils/im-event-bus';
import { imRequestRegistry } from './utils/im-request-registry';
import { mirrorIfChannelBound, type MirrorImage } from './utils/im-mirror';

// Module-level debug mode check (avoids repeated environment variable access)
const isDebugMode = process.env.DEBUG === '1' || process.env.NODE_ENV === 'development';

/**
 * Pattern 3 §3.2.5 — per-token `stream_event` log suppression.
 *
 * The SDK emits one `stream_event` per token (chunk_start / token_delta / etc).
 * The legacy code path was: every event → `logStringify` → `appendLogLine` →
 *   - `appendLog()` writes a line into the per-session log file
 *   - `broadcast('chat:log', ...)` queues an SSE event to every viewer
 *
 * For a 10k-token response this fans out 10k disk writes + 10k SSE frames per
 * subscribed renderer, while the actual token text is already streamed via
 * `chat:message-chunk`. The cost is purely diagnostic noise.
 *
 * When `SUPPRESS_PER_TOKEN_LOG_BROADCAST = true` (default):
 *   - the per-event `appendLogLine(...)` call is skipped for `stream_event`
 *   - no `chat:log` is broadcast for `stream_event`
 *   - on `result` (turn-end) we emit one summary line:
 *       `[agent][sdk] stream_event_summary turn=<msgCount> deltas=<n>`
 *     and one aggregate `chat:log` so consumers can still see "this turn
 *     happened"
 *
 * Set to `false` only when you specifically need the per-token transcript
 * for debugging (rare). The other branch (debug mode) of `isDebugMode` already
 * keeps the data path live for assistant / system / result events; this flag
 * only governs `stream_event` (the noisy path).
 */
const SUPPRESS_PER_TOKEN_LOG_BROADCAST = true;

// Shared NO_PROXY value — comprehensive list of localhost addresses to bypass proxy
const PROXY_NO_PROXY_VAL = 'localhost,localhost.localdomain,127.0.0.1,127.0.0.0/8,::1,[::1]';

/**
 * Claude Agent SDK reserved MCP server names — using these causes the SDK to
 * crash with exit code 1: "Invalid MCP configuration: X is a reserved MCP name."
 * Source: claude-code/src/main.tsx (isClaudeInChromeMCPServer, isComputerUseMCPServer)
 */
export const SDK_RESERVED_MCP_NAMES = ['claude-in-chrome', 'computer-use'];

/**
 * MyAgents-reserved MCP server ids — names used by context-injected builtins
 * that are managed by the sidecar, not user-toggleable. User MCPs configured
 * with these ids are silently dropped at SDK build time so they cannot
 * (a) overwrite the legitimate builtin in `result[server.id]`, or
 * (b) inherit the auto-trust granted to these names by `canUseTool`.
 *
 * MUST stay in sync with `getActiveContextInjectedBuiltinIds()` and Pattern 1
 * of `buildSdkMcpServers()`. If a new context-injected builtin lands, register
 * its id here too. See issue #148 for the original drift.
 *
 * v0.2.11 — `cron-tools`, `im-cron`, and `im-media` were retired in favour of
 * `myagents` CLI commands + system prompt guidance (single CLI surface usable
 * across builtin / Codex / Gemini / Claude Code runtimes). Only `im-bridge-tools`
 * remains a context-injected MCP because its tool surface is a runtime-dynamic
 * passthrough of OpenClaw plugin tools — no fixed schema to teach via prompt.
 */
export const MYAGENTS_CONTEXT_INJECTED_MCP_IDS = [
  'im-bridge-tools',
] as const;

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
    ensureDirSync(projectSkillsDir);

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
      // isDirEntry follows symlinks + Windows junctions (issue #104).
      // Without it, junction-mounted skills never reach the project symlink
      // bridge, so they're invisible to the SDK too (not just the UI).
      const target = join(userSkillsDir, entry.name);
      if (!isDirEntry(entry, target)) continue;
      if (entry.name.startsWith('.')) continue;
      if (isSkillBlockedOnPlatform(entry.name)) continue;
      // Require SKILL.md to match scanSkills/scanSkillsDir's definition of
      // a "valid skill". Without this guard, a junction pointing at an
      // arbitrary directory (or a plain empty dir under ~/.myagents/skills/)
      // would produce a project-level symlink that the SDK follows but the
      // UI scanners skip — inviting the "runtime vs UI" divergence we're
      // fixing.
      if (!existsSync(join(target, 'SKILL.md'))) continue;

      managedSkillNames.add(entry.name);
      const linkPath = join(projectSkillsDir, entry.name);

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
    ensureDirSync(projectCommandsDir);

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

// (issue #174) `starting` separates "subprocess launched, awaiting system_init"
// from "AI actively processing a turn". Without it, the 60s→600s adaptive
// startup-timeout window looks identical to a normal busy turn in the UI:
// user can't tell if the SDK is stuck in MCP handshake / first-time workspace
// init or doing real work, and after up to 10 minutes the only signal is the
// timeout-error toast. `starting` → `running` when system_init arrives.
type SessionState = 'idle' | 'starting' | 'running' | 'error';

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
  attachments?: ToolAttachment[];
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

/**
 * Strip image content blocks from a queued user message when the resolved
 * model has lost `image` modality support since enqueue time. Defensive
 * second pass — `enqueueUserMessage` is the primary filter (ran against the
 * model at the time of enqueue); this re-checks against the model active at
 * yield time so a mid-turn model switch can't leak baked image blocks into
 * a text-only model's request.
 *
 * Returns the input untouched in the common case (no drift). Only allocates
 * when re-stripping is required.
 */
function stripUnsupportedModalityBlocks(
  message: SDKUserMessage['message'],
  modelAtYield: string | undefined,
): SDKUserMessage['message'] {
  const content = message.content;
  if (!Array.isArray(content)) return message;
  // Fast-path: no image block → nothing to strip.
  let hasImageBlock = false;
  for (const block of content) {
    if (block && typeof block === 'object' && (block as { type?: string }).type === 'image') {
      hasImageBlock = true;
      break;
    }
  }
  if (!hasImageBlock) return message;
  if (modelSupportsModality(modelAtYield, 'image')) return message;

  // Drift detected: filter out image blocks; if nothing usable remains,
  // append a synthetic placeholder so the SDK still receives a non-empty
  // user turn. Mirrors the synthetic-note path in enqueueUserMessage.
  const kept = content.filter(b => !(b && typeof b === 'object' && (b as { type?: string }).type === 'image'));
  const droppedCount = content.length - kept.length;
  if (kept.length === 0) {
    kept.push({ type: 'text', text: `[${droppedCount} image attachment(s) omitted — current model does not support image input]` });
  }
  console.log(`[agent] modality re-strip at dequeue: dropped ${droppedCount} image block(s) for model=${modelAtYield ?? '(unknown)'} (model changed since enqueue)`);
  broadcast('chat:attachments-filtered', {
    reason: 'modality',
    kind: 'image',
    count: droppedCount,
    model: modelAtYield ?? null,
    phase: 'dequeue',
  });
  return { ...message, content: kept };
}

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
  | 'oauth'        // MCP OAuth token acquired/refreshed
  | 'model-window'  // setSessionModel — contextLength crossed a boundary, need to reinject CLAUDE_CODE_AUTO_COMPACT_WINDOW
  | 'model-aliases' // setSessionModel — collapsed provider aliases now target a different active model
  | 'plugins';     // PRD 0.2.17 — Claude plugin install / uninstall / toggle

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

/**
 * v0.1.69 T14: Return true if the current session is locked — its config was
 * captured as a snapshot at creation (see types/session.ts). Callers that
 * react to AgentConfig change events should consult this before scheduling a
 * restart: a snapshotted session owns MCP/agents/provider/model/permissionMode
 * and does NOT follow later agent changes, so restarting would be wasted work
 * (the frontend already passes the session-resolved list → fingerprint is
 * stable → no restart needed). If the frontend misbehaves and sends the
 * agent's raw list, this guard prevents the mis-call from thrashing the SDK.
 *
 * IM sessions intentionally leave `configSnapshotAt` undefined (D4
 * live-follow), so this returns false and the legacy restart path runs.
 */
function isCurrentSessionSnapshotted(): boolean {
  if (!sessionId) return false;
  const meta = getSessionMetadata(sessionId);
  return Boolean(meta?.configSnapshotAt);
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
// Issue #289 — set by handleMessageComplete when a force-send surfaced the in-flight item and
// the SDK is about to drain it into a NEW turn. interruptCurrentResponse() reads it to SKIP the
// redundant trailing handleMessageStopped() (handleMessageComplete is the full turn-end handler;
// the trailing call would undo the streaming re-arm + double-pop the IM request → the racy
// "idle gap" Codex flagged). One-shot: consumed by interruptCurrentResponse().
let forceDrainTurnStarting = false;
// Count of MCP tool_use blocks emitted by the model in the current turn that
// haven't seen their matching tool_result yet. Read by the post-interrupt
// force-close path to disambiguate diagnostics: >0 strongly suggests a hung
// MCP tool (the SDK subprocess is blocked on client.callTool()), 0 suggests
// the model is still generating output (thinking / text). Updated by the
// stream-event handlers in startStreamingSession; reset to 0 on each new
// turn (and on session restart) so values never leak across turns.
let inFlightToolCount = 0;
// (v0.2.11 cross-bugfix #142 review-fix-2 #1) True from the moment
// promotePendingMidTurnItem shifts an item out of pendingMidTurnQueue
// until the generator's `item.resolve()` after yield. Plugs the gap
// where pendingMidTurnQueue is empty + isStreamingMessage hasn't yet
// flipped to true (await persistMessagesToStorage in turn-start setup) —
// without this, isSessionBusy returns false in the gap and a fresh
// enqueue would take the direct-send path, opening a new ordering bug.
let promotedItemInFlight = false;
// (v0.2.12 mid-turn injection restore) UUID of the queue item currently
// yielded to the SDK CLI subprocess but not yet drained by AI. Set when
// generator yields a queued mid-turn message; cleared when CLI emits
// SDKUserMessageReplay (isReplay=true) confirming AI's next API call
// will include the queued_command attachment, OR at turn-end as fallback
// for turns that never hit a tool break (no replay opportunity).
//
// While inFlightToCliId !== null, additional mid-turn enqueues buffer
// in pendingMidTurnQueue (still cancellable). Frontend hides the X
// button on the in-flight item — its uuid has crossed the process
// boundary into the CLI's commandQueue and there is no SDK API to
// retract it. The "lockstep yield" pattern (one in-flight at a time)
// keeps subsequent queue items cancellable until they are promoted.
let inFlightToCliId: string | null = null;
// Issue #289 — when set to the in-flight queueId, a force-send ("立即发送") is in progress
// for that item: it interrupts the current turn precisely so the SDK drains + processes the
// queued command, so the graceful-interrupt `result` MUST SURFACE the item (queue:started)
// instead of dropping it (queue:cancelled). Distinct from `isInterruptingResponse` (which is
// also true for a plain stop). Cleared whenever the in-flight slot is cleared.
let forceSurfaceInFlightId: string | null = null;
// (v0.2.12) Metadata for the currently in-flight queue item. We stash
// messageText / attachments / requestId at yield time because the
// MessageQueueItem closes over the generator and we no longer have
// access to it when SDKUserMessageReplay arrives later. Used by
// handleQueuedCommandReplay to build the user MessageWire that gets
// pushed to messages[] and broadcast as queue:started.
type InFlightMetadata = {
  messageText: string;
  attachments?: MessageWire['attachments'];
  requestId?: string;
  /** PRD 0.2.14 — propagated from `enqueueUserMessage(metadata)` so the
   *  delayed-resolve push sites (queued_command replay / queue:started
   *  fallback) can decide whether this user message should mirror to a
   *  bound IM channel. Only `'desktop'` triggers mirror. */
  source?: SessionSource;
  /** PRD 0.2.14 — base64 image payloads forwarded for mirror purposes.
   *  Lives alongside `attachments` (which is on-disk paths) because the
   *  Sidecar→management-API mirror call needs raw bytes inline. PNG/JPG
   *  only at the call site; non-image payloads must not be queued here. */
  mirrorImages?: MirrorImage[];
};
let inFlightMetadata: InFlightMetadata | null = null;

/**
 * Clear the in-flight queued-command slot. Keeps the three coupled fields in lockstep so a
 * future clear site can't forget the #289 force flag (which, if left stale, would be checked
 * against a later in-flight item in handleMessageComplete). Callers that need the prior value
 * (e.g. the queueId / metadata / forced-ness) MUST capture it before calling.
 */
function clearInFlightSlot(): void {
  inFlightToCliId = null;
  inFlightMetadata = null;
  forceSurfaceInFlightId = null;
}

// ===== Desktop → IM mirror state (PRD 0.2.14 Phase C) =====
//
// `currentTurnMirrorEnabled` is set when a desktop user message is finalized
// (any of three push sites in this file) and cleared when the AI turn ends or
// is aborted. While it's true, `content_block_stop` for text blocks fires a
// mirror call with the accumulated block text.
//
// `pendingTextBlockTexts` accumulates `text_delta` per stream index so we
// can ship a complete block text at content_block_stop. Cleared with the
// flag at turn boundaries.
let currentTurnMirrorEnabled = false;
let currentTurnMirrorSessionId: string | null = null;
const pendingTextBlockTexts: Map<number, string> = new Map();

function clearMirrorState(): void {
  currentTurnMirrorEnabled = false;
  currentTurnMirrorSessionId = null;
  pendingTextBlockTexts.clear();
}

function maybeAccumulateMirrorChunk(index: number, chunk: string): void {
  if (!currentTurnMirrorEnabled) return;
  const prev = pendingTextBlockTexts.get(index) ?? '';
  pendingTextBlockTexts.set(index, prev + chunk);
}

/** Fire-and-forget user-side mirror. Caller decides whether to invoke based on
 *  metadata.source — this helper is the single source of formatting + transport. */
function fireDesktopUserMirror(content: string, images: MirrorImage[] | undefined): void {
  // Only fire if there's a chance an IM channel is bound. Rust silently
  // no-ops if not, but skipping the round-trip when content is trivially
  // empty avoids needless network chatter.
  if (!content && (!images || images.length === 0)) return;
  currentTurnMirrorEnabled = true;
  currentTurnMirrorSessionId = sessionId;
  void mirrorIfChannelBound({
    sessionId,
    role: 'user',
    text: content,
    images,
  });
}

/** Fire-and-forget assistant text-block mirror. Called from content_block_stop.
 *  The session id captured at user-message time guards against turn boundary
 *  drift (resetSession during a streaming turn). */
function fireDesktopAssistantBlockMirror(text: string): void {
  if (!text) return;
  if (!currentTurnMirrorEnabled) return;
  const sid = currentTurnMirrorSessionId ?? sessionId;
  void mirrorIfChannelBound({
    sessionId: sid,
    role: 'assistant',
    text,
  });
}

/** Convert ImagePayload[] to MirrorImage[] keeping only PNG/JPG (Q5 lockdown). */
// Pre-validation cap MUST stay in sync with Rust's
// `MIRROR_IMAGE_MAX_BYTES = 5MB` in management_api.rs (and its
// `MIRROR_IMAGE_MAX_BASE64_LEN` derivation). Base64 with padding inflates
// to `4 * ceil(bytes / 3)` chars — using a strict `Math.ceil(bytes/3)*4`
// formula matches Rust's exact bound, plus the same 64-char slack for any
// trailing whitespace/newlines. Without this alignment, the Node check is
// off by 1 char at the boundary and would reject a 5 MiB image that Rust
// would still accept (review-by-codex F4). Cap on the *encoded* length so
// the guard is O(1) without decoding.
const MIRROR_IMAGE_MAX_BYTES = 5 * 1024 * 1024;
const MIRROR_IMAGE_MAX_BASE64_CHARS = Math.ceil(MIRROR_IMAGE_MAX_BYTES / 3) * 4 + 64;

function toMirrorImages(images: ImagePayload[] | undefined): MirrorImage[] | undefined {
  if (!images || images.length === 0) return undefined;
  const out: MirrorImage[] = [];
  for (const img of images) {
    const mime = img.mimeType.toLowerCase();
    if (mime !== 'image/png' && mime !== 'image/jpeg' && mime !== 'image/jpg') continue;
    if (img.data.length > MIRROR_IMAGE_MAX_BASE64_CHARS) {
      console.warn(
        `[mirror] dropping oversize image: mime=${mime} base64Len=${img.data.length} cap=${MIRROR_IMAGE_MAX_BASE64_CHARS}`,
      );
      continue;
    }
    out.push({ mimeType: img.mimeType, dataBase64: img.data });
  }
  return out.length > 0 ? out : undefined;
}
let isApiRetrying = false;  // Track api_retry state to clear when streaming resumes
const messages: MessageWire[] = [];
// Pattern 3 §3.2.4 — incremental persistence cursor.
// `persistMessagesToStorage` previously remapped the entire `messages` array
// every turn (O(history) per turn, where history grows monotonically).
// Now we only map and append the new tail (`messages.slice(lastPersistedIndex)`)
// and bump the cursor on success. Reset to 0 in any path that recreates the
// session-scoped state (resetSession / new session / fork / rewind).
let lastPersistedIndex = 0;
const streamIndexToToolId: Map<number, string> = new Map();
const streamIndexToBlockType: Map<number, string> = new Map(); // Positive block type tracking for subagent content_block_stop
const toolResultIndexToId: Map<number, string> = new Map();

// IM Pipeline v2 — Pattern B + G: per-request attribution via FIFO queue.
//
// `pendingRequestIds` holds the requestIds of user messages YIELDED to SDK
// stdin but not yet finalized (no `result` boundary observed). The HEAD is
// the request currently owning SDK output; SDK events tagged with head get
// published to ImEventBus where /api/im/events subscribers filter by id.
//
// Why a queue, not a single `activeRequestId` (Codex C4 / Pattern G fix):
// mid-turn injection lets us yield message B while SDK is still processing
// A. The legacy "single `activeRequestId` overwritten on each yield" model
// misattributed A's continuation events to B. Pattern G fix: advance the
// queue only on SDK `result` boundary (handleMessageComplete / Stopped /
// Error), not on yield. So head stays "A" until A's turn ends, then "B".
//
// Replaces the legacy `imStreamCallback` singleton + `imCallbackNulledDuringTurn`
// flag (Pattern B already removed those). Cross-event leakage is structurally
// impossible — old events carry the old requestId, new subscribers filter.
const pendingRequestIds: string[] = [];

/** Emit a per-request IM event tagged with the queue head. No-op when the
 *  queue is empty (desktop / cron path, no IM trace). System-level events
 *  (e.g. session-init in Pattern C) call `imEventBus.emit(null, ...)` directly. */
function emitImEvent(type: ImEventType, data?: unknown): void {
  const head = pendingRequestIds[0];
  if (head !== undefined) {
    imEventBus.emit(head, type, data);
  }
}

/** Push a yielded user message's requestId onto the FIFO queue. Called from
 *  messageGenerator when yielding to SDK stdin. No-op for desktop / cron
 *  (no IM trace ID). */
function pushPendingRequest(requestId: string | null | undefined): void {
  if (requestId) pendingRequestIds.push(requestId);
}

/** Pop the queue head — called from handleMessageComplete / Stopped / Error
 *  on SDK `result` boundary (one yield → one result). Returns popped id. */
function popPendingRequest(): string | null {
  return pendingRequestIds.shift() ?? null;
}

/** Clear the entire queue — called from abortPersistentSession /
 *  clearMessageState (whole-session abort or reset). Returns drained ids. */
function clearPendingRequests(): string[] {
  const drained = pendingRequestIds.slice();
  pendingRequestIds.length = 0;
  return drained;
}
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
// `sdkControlReady` is the "subprocess fully ready" signal — separate from
// `system_init`. The SDK CLI's `system/init` is yielded LATE in QueryEngine.submitMessage
// (after fetchSystemPromptParts → processUserInput → recordTranscript → loadAllPlugins),
// so it's per-turn metadata, NOT a "boot complete" handshake. By contrast,
// `Query.initializationResult()` resolves as soon as the subprocess processes the
// `subtype: "initialize"` control_request — typically <1s after spawn (Codex repro:
// resolved at +337ms). We track that separately so the UI can distinguish:
//   subprocess still booting       → 'AI 启动中'   (sdkControlReady=false)
//   subprocess ready, turn running → '思考中…'    (sdkControlReady=true)
// Reset to false on any session restart (abort / switchToSession / config-change reload),
// re-set to true when the next pre-warm's initializationResult resolves.
let sdkControlReady = false;
type MessageQueueItem = {
  id: string;                     // Unique queue item ID
  message: SDKUserMessage['message'];
  messageText: string;            // Original text for cancel/restore
  wasQueued: boolean;             // true if added via non-blocking path (AI was busy)
  resolve: () => void;
  attachments?: MessageWire['attachments'];  // Saved attachments for deferred user message rendering
  // Pattern A — Per-Request Identity (IM Pipeline v2). Carries the trace ID assigned
  // at the IM edge (Rust mod.rs spawn entry → /api/im/chat payload).
  // Empty string for desktop / cron / heartbeat paths (no IM identity).
  requestId?: string;
  // PRD 0.2.18 Session Inbox — per-turn binding for reply pushback.
  // Bound on dequeue (generator yield), read at result handler. When present
  // and replyBack=true, turn-end pushes <inbox-reply> back to caller session.
  inboxMeta?: import('./inbox/types').InboxTurnMeta;
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

// OpenAI Bridge: sidecar port for loopback. Per-token bridge state lives
// in `./openai-bridge/bridge-registry`; this module owns its session's
// token (`activeSessionBridgeToken` below) and the resolver that updates
// when `currentProviderEnv` / `currentModel` change.
let sidecarPort: number = 0;

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

// ── Active session bridge token (PRD #124) ────────────────────────────────
//
// The active session's bridge state used to live in a process-global
// `currentOpenAiBridgeConfig` mutated as a side effect of
// `buildClaudeSessionEnv`. That global was shared with every other SDK
// subprocess (verify, title-gen, sub-agents) — so a one-shot caller
// could silently hijack the active session's routing. The fix moves
// every bridge to a per-subprocess token in `bridge-registry`. The
// active session owns one such token (or none, if its provider is
// non-OpenAI subscription / Anthropic-protocol third-party).
//
// Lifecycle:
//   - registered in `startStreamingSession` when currentProviderEnv is
//     OpenAI-protocol
//   - resolver reads `currentProviderEnv` + `currentModel` live, so
//     mid-flight `setSessionModel` updates take effect immediately
//   - unregistered when the SDK subprocess terminates (session reset,
//     provider switch, abort) — handled in the same paths that clear
//     `currentProviderEnv`

let activeSessionBridgeToken: string | null = null;

/**
 * Build the upstream config that the bridge handler will see for the
 * active session, derived live from `currentProviderEnv` + `currentModel`.
 * Called per-request by the bridge registry resolver — keep it cheap.
 */
function resolveActiveSessionUpstreamConfig(): UpstreamBridgeConfig {
  // currentProviderEnv may be undefined (subscription / Anthropic-direct)
  // when the session bridge is registered; that's a registration error
  // upstream of us. Defensive: empty-string baseUrl + no model → bridge
  // handler will fail the upstream call with a clear error.
  const aliases = resolveSessionModelAliases(currentProviderEnv?.modelAliases, currentModel);
  return {
    baseUrl: currentProviderEnv?.baseUrl ?? '',
    apiKey: currentProviderEnv?.apiKey ?? '',
    // When aliases exist, don't set model as blanket override — sub-agents
    // need distinct models routed via modelMapping. Without aliases, force
    // ALL request models to currentModel (the historical behavior).
    model: aliases ? undefined : (currentModel || undefined),
    modelAliases: aliases,
    maxOutputTokens: currentProviderEnv?.maxOutputTokens,
    maxOutputTokensParamName: currentProviderEnv?.maxOutputTokensParamName,
    upstreamFormat: currentProviderEnv?.upstreamFormat,
  };
}

/**
 * Ensure the active session has a registered bridge token IFF its provider
 * is OpenAI-protocol. Caller MUST pass `freshToken: true` when starting a
 * NEW SDK subprocess (so any in-flight late requests from an old subprocess
 * find their stale token expired) and `freshToken: false` for in-place
 * mid-flight re-syncs (provider switches before the abort fires).
 *
 * The resolver reads `currentProviderEnv` / `currentModel` live, so an
 * existing token automatically reflects mid-session config changes. The
 * fresh-token version is only needed when we're about to spawn a new
 * subprocess that will see a (possibly different) URL.
 */
function ensureActiveSessionBridgeRegistered(opts?: { freshToken?: boolean }): void {
  if (currentProviderEnv?.apiProtocol !== 'openai') {
    // Provider is not OpenAI-protocol — no bridge needed. If a stale token
    // is registered (e.g., from a previous OpenAI provider before a switch),
    // tear it down here so subsequent SDK launches don't route through it.
    if (activeSessionBridgeToken) {
      unregisterBridgeInRegistry(activeSessionBridgeToken);
      activeSessionBridgeToken = null;
    }
    return;
  }
  if (opts?.freshToken && activeSessionBridgeToken) {
    // Caller is about to spawn a new subprocess. Retire the old token so
    // late requests from the dying subprocess get rejected (400 unknown
    // token) instead of resolving to the new subprocess's config — that's
    // the cross-pollination class.
    unregisterBridgeInRegistry(activeSessionBridgeToken);
    activeSessionBridgeToken = null;
  }
  if (!activeSessionBridgeToken) {
    activeSessionBridgeToken = randomUUID();
  }
  registerBridgeInRegistry(
    activeSessionBridgeToken,
    resolveActiveSessionUpstreamConfig,
    `session:${sessionId}`,
  );
}

/**
 * Tear down the active session's bridge token. Called from the session
 * `finally` path when the SDK subprocess exits, so the registry doesn't
 * accumulate stale entries even when subprocesses don't restart cleanly.
 */
function unregisterActiveSessionBridge(): void {
  if (!activeSessionBridgeToken) return;
  unregisterBridgeInRegistry(activeSessionBridgeToken);
  activeSessionBridgeToken = null;
}

/** Returns true if the active session has a registered OpenAI bridge token. */
export function hasActiveBridge(): boolean {
  return activeSessionBridgeToken !== null;
}

/**
 * One-shot bridge: register a per-call token whose resolver returns a
 * static snapshot of the provider config. Used by `provider-verify`,
 * `title-generator`, and `fetchSdkSupportedModels` — code paths that
 * spawn a single SDK subprocess against a specific provider for a
 * bounded operation.
 *
 * Returns the URL-safe token to feed into `buildClaudeSessionEnv`'s
 * `bridgeToken` option. The caller MUST call the returned `release()`
 * function in a `finally` block to unregister; the orphan watchdog
 * is the last-line safety net, not the contract.
 */
export function startOneShotBridge(
  providerEnv: ProviderEnv,
  modelOverride: string | undefined,
  description: string,
): { token: string; release: () => void } {
  if (providerEnv.apiProtocol !== 'openai') {
    throw new Error('startOneShotBridge called with non-OpenAI provider — caller should not need a bridge');
  }
  const token = randomUUID();
  const aliases = resolveSessionModelAliases(providerEnv.modelAliases, modelOverride);
  const snapshot: UpstreamBridgeConfig = {
    baseUrl: providerEnv.baseUrl ?? '',
    apiKey: providerEnv.apiKey ?? '',
    model: aliases ? undefined : (modelOverride || undefined),
    modelAliases: aliases,
    maxOutputTokens: providerEnv.maxOutputTokens,
    maxOutputTokensParamName: providerEnv.maxOutputTokensParamName,
    upstreamFormat: providerEnv.upstreamFormat,
  };
  // Static resolver — one-shot config doesn't change over the call's
  // lifetime, so the closure captures the snapshot directly.
  registerBridgeInRegistry(token, () => snapshot, description);
  return {
    token,
    release: () => unregisterBridgeInRegistry(token),
  };
}
// SDK 是否已注册当前 sessionId。true 时后续 query 必须用 resume。
// 仅由非 pre-warm 的 system_init 设为 true，仅由 sessionId 变更设为 false。
// Pre-warm 永不修改此标志 — 从结构上消除超时/重试导致的状态错误。
let sessionRegistered = false;

// 时间回溯：对话截断后，下次 query 需携带 resumeSessionAt 截断 SDK 对话历史
let pendingResumeSessionAt: string | undefined;
// PRD 0.2.27 — cold-reload window-B anchor. Captured at LOAD time (loadMessagesFromStorage)
// from the DURABLE persisted tail, NOT re-derived at query time: a direct-send pushes the
// new user row into messages[] (agent-session.ts ~6866) before startStreamingSession runs,
// which would flip the tail to a user message and defeat the tail-is-assistant gate exactly
// in the "rewind → reopen → ask" flow. Capturing at load freezes the truncated tail before
// any new send. Lifecycle mirrors pendingResumeSessionAt: set on load, consumed on
// system_init, cleared on reject / session switch / reset.
let pendingReloadAnchor: string | undefined;
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

// Mid-turn deferred yield buffer (v0.2.11 cross-bugfix #142):
//
// Holds queued messages that arrived while a prior turn was still streaming.
// The generator BUFFERS them here instead of yielding them to SDK — yield is
// deferred until handleMessageComplete/Stopped/Error promotes them via
// promotePendingMidTurnItem(). This is what makes mid-turn cancel actually
// cancel: SDK has not received the message, so removing the entry truly
// suppresses delivery.
//
// Earlier design ("yield-and-ready") yielded immediately and used this queue
// as a UI-side buffer for delayed `messages[]` push and `queue:started`
// broadcast at content block boundaries. That left cancel as a no-op
// against SDK — the JSON line had already been written to subprocess stdin
// and there is no SDK API to "ignore" a queued user message. The 2026-05-07
// log evidence: yield happened within 1ms of enqueue, far less than any
// user could click ×.
const pendingMidTurnQueue: Array<{
  queueId: string;
  userMessage: Pick<MessageWire, 'id' | 'role' | 'content' | 'timestamp' | 'attachments'>;
  // Re-delivered to generator by promotePendingMidTurnItem() at turn-end,
  // OR rescued to messageQueue front by rescuePendingToQueue() if the SDK
  // subprocess is about to die. The latter is now a simple move (not a
  // deduplication concern) because SDK never received the message.
  sourceItem: MessageQueueItem;
}> = [];

/**
 * Is the session currently busy (any signal of work in flight)?
 *
 * Used by **auto-injection endpoints** (memory-update, future heartbeat
 * variants) to refuse injecting `<system-reminder>` content while the user
 * is actively engaging — those injections trip the SDK's mid-turn
 * `queued_command` mechanism and the prompt design directs the AI to drop
 * its current turn and process the injected request, which is exactly the
 * complaint in issue #190 ("memory update interrupts long-running tasks").
 *
 * Returns true when ANY of:
 *   - `sessionState !== 'idle'` (running / starting / error — turn or
 *     subprocess transitioning)
 *   - `isStreamingMessage` (defensive — assistant text/tool stream live)
 *   - `messageQueue.length > 0` (user direct-send waiting to start a turn)
 *   - `pendingMidTurnQueue.length > 0` (mid-turn item buffered for replay)
 *
 * Pre-warm exception: `isPreWarming=true` is **not** treated as busy.
 * Pre-warm sessions are cold/idle (sessionState stays 'idle' for the
 * pre-warm path) and accepting an auto-injection during pre-warm just
 * means the first message the live session processes is the injection —
 * that is the ideal time to update memory, not a regression.
 *
 * Single source of truth for "is this session safe to auto-inject":
 * called from `/api/memory/update` (and may be reused by future injection
 * endpoints) so the gate is evaluated by the process that actually owns
 * the state, not via stale disk-timestamp proxies (see `lastActiveAt`
 * gate in `memory_update.rs::run_batch` — it only updates on turn
 * boundaries, so a single multi-minute turn ages past the 15-min cooldown
 * even though the session is plainly mid-work; that's how #190 slipped
 * through every existing gate).
 */
export function isSessionBusy(): boolean {
  return sessionState !== 'idle'
    || isStreamingMessage
    || messageQueue.length > 0
    || pendingMidTurnQueue.length > 0;
}

/**
 * Rescue pending mid-turn items back to messageQueue front when the SDK subprocess
 * is about to die (abortPersistentSession or interruptCurrentResponse hard-kill).
 *
 * (v0.2.11) With deferred-yield design, pending items have NOT been yielded to
 * SDK — they live entirely in this Node process. So rescue is no longer a
 * "subprocess death recovery" measure but simply a queue-merge: pending items
 * become the front of messageQueue so the recovery session re-delivers them
 * (no deduplication needed because SDK never saw them).
 *
 * Safe to call regardless of whether SDK stays alive — the deduplication
 * concern from the old design (double-delivery via stdin buffer + messageQueue)
 * no longer exists.
 */
// (v0.2.12) The cancelledInflightIds checkpoint set used by the deferred-yield
// design (ce747cd2) is gone. With lockstep mid-turn injection, items are
// either in messageQueue / pendingMidTurnQueue (cancellable by splice) or
// already in CLI's commandQueue (uncancellable — frontend hides the X).
// The "promoted but not yet yielded" race window the checkpoint guarded
// against doesn't exist any more — promote and yield happen back-to-back
// inside the same micro-task and there is no externally visible
// cancellation surface in between.

function rescuePendingToQueue(): void {
  if (pendingMidTurnQueue.length === 0) return;
  console.log(`[agent] Rescuing ${pendingMidTurnQueue.length} pending mid-turn message(s) → messageQueue front`);
  // Preserve original order: reverse-iterate so the first pending becomes messageQueue[0].
  for (let i = pendingMidTurnQueue.length - 1; i >= 0; i--) {
    messageQueue.unshift(pendingMidTurnQueue[i].sourceItem);
  }
  pendingMidTurnQueue.length = 0;
}

/**
 * (v0.2.12) Lockstep yield: promote the next pendingMidTurnQueue item into
 * CLI's commandQueue. Called from:
 *   - handleQueuedCommandReplay (CLI confirmed AI saw the in-flight item
 *     mid-turn): the in-flight slot just opened, hand the next over.
 *   - handleMessageComplete/Stopped/Error (turn-end fallback for cases
 *     where CLI drained queued commands at the do-while turn boundary
 *     instead of mid-turn — no replay event fires there, but the
 *     in-flight slot is freed and we still need to promote our pending).
 *
 * Idempotent: bails when inFlightToCliId !== null (the slot is occupied)
 * or pendingMidTurnQueue is empty.
 */
function promoteNextFromPending(): void {
  if (inFlightToCliId !== null) return;
  if (pendingMidTurnQueue.length === 0) return;
  if (shouldAbortSession) {
    console.log(`[agent] Promote skipped — session aborting (${pendingMidTurnQueue.length} pending will be rescued)`);
    return;
  }
  if (!messageResolver) {
    console.log('[agent] Promote skipped — generator not parked; pending stays for recovery generator');
    return;
  }
  const pending = pendingMidTurnQueue.shift()!;
  const promotedText = typeof pending.userMessage.content === 'string'
    ? pending.userMessage.content
    : '';
  inFlightToCliId = pending.queueId;
  inFlightMetadata = {
    messageText: promotedText,
    attachments: pending.userMessage.attachments,
    requestId: pending.sourceItem.requestId,
  };
  console.log(`[agent] Promoting next pending mid-turn message: queueId=${pending.queueId} (pending remaining=${pendingMidTurnQueue.length})`);
  // Re-emit queue:added with isInFlight=true. Frontend's queue:added handler
  // de-dups by queueId and updates the isInFlight flag in place — no separate
  // event needed. Reusing the existing event keeps ALL_EVENTS count stable
  // (SseConnection cleanup-invariant tests are sensitive to listener count
  // shifts in the cancel-after-start-sse_proxy race).
  broadcast('queue:added', {
    queueId: pending.queueId,
    messageText: promotedText.slice(0, 100),
    isInFlight: true,
  });
  wakeGenerator(pending.sourceItem);
}

/**
 * (v0.2.12) Handle SDKUserMessageReplay for our in-flight queued_command.
 *
 * CLI emits this event when it drains a queued_command attachment from
 * its commandQueue mid-turn (claude-code/src/QueryEngine.ts:880). The
 * event carries `attachment.source_uuid` (which we set as the SDKUserMessage
 * uuid on yield) so we can match the replay back to inFlightToCliId.
 *
 * Receiving this means AI's NEXT API call will include the queued_command
 * as a user-role attachment in its context — i.e. the message has crossed
 * the "uncancellable" boundary. Time to:
 *   1. Push it into messages[] (now visible in chat history)
 *   2. Persist + broadcast queue:started so frontend renders the bubble
 *      inline with the streaming assistant content (midTurnBreak split)
 *   3. Clear inFlightToCliId and promote the next pending item, which
 *      yields it to CLI for the next mid-turn drain
 */
async function handleQueuedCommandReplay(
  sdkMessage: { uuid?: string }
): Promise<void> {
  const queueId = inFlightToCliId;
  if (!queueId) return; // defensive — caller already matched
  const meta = inFlightMetadata;
  if (!meta) {
    console.warn(`[agent] queued_command replay arrived but inFlightMetadata is null, queueId=${queueId}`);
  }

  const userMessage: MessageWire = {
    id: String(messageSequence++),
    role: 'user',
    content: meta?.messageText ?? '',
    timestamp: new Date().toISOString(),
    attachments: meta?.attachments,
    sdkUuid: sdkMessage.uuid,
    metadata: meta?.source ? { source: meta.source } : undefined,
  };
  messages.push(userMessage);
  if (sdkMessage.uuid) {
    currentSessionUuids.add(sdkMessage.uuid);
    liveSessionUuids.add(sdkMessage.uuid);
  }
  await persistMessagesToStorage();

  // PRD 0.2.14 — desktop → IM mirror (queued mid-turn replay path).
  if (meta?.source === 'desktop') {
    fireDesktopUserMirror(userMessage.content as string, meta.mirrorImages);
  }

  console.log(`[agent] queued_command replay consumed by AI: queueId=${queueId}`);
  broadcast('queue:started', {
    queueId,
    midTurnBreak: true,
    userMessage: {
      id: userMessage.id,
      role: userMessage.role,
      content: userMessage.content,
      timestamp: userMessage.timestamp,
      attachments: userMessage.attachments,
    },
  });

  clearInFlightSlot();
  promoteNextFromPending();
}

/** 中止持久 session：唤醒所有被阻塞的 Promise */
function abortPersistentSession(): void {
  // Log warning if browser was used but storage state wasn't saved
  // (The system prompt instructs the AI to save, but this is the fallback detection)
  if (sessionBrowserToolUsed && !sessionStorageStateSaved) {
    console.warn('[agent] Browser tools were used but storage state was not saved. Login state from this session may be lost.');
  }

  // This is the ONLY legitimate `shouldAbortSession = true` site — it is
  // the abort entry point and performs the full cleanup chain below
  // (rescue pending, IM bus notify, generator wake). The lint ban exists
  // so other code can't bypass this teardown by setting the flag directly.
  // eslint-disable-next-line no-restricted-syntax
  shouldAbortSession = true;
  // (v0.2.12) Clear in-flight CLI tracking — recovery session starts clean
  // and any rescued pending items will be re-yielded by the new generator.
  clearInFlightSlot();
  promotedItemInFlight = false;
  // Subprocess is about to die — rescue pending items so the recovery session
  // re-delivers them instead of losing them with the dead stdin buffer.
  rescuePendingToQueue();
  // Pattern B/C/G: notify IM bus subscribers + tear down ALL pending registry
  // entries (whole-session abort affects every in-flight request, not just head).
  // Emit an 'error' for each pending requestId so each subscriber's reply slot
  // closes — emitImEvent only tags head, so iterate manually.
  for (const reqId of pendingRequestIds) {
    imEventBus.emit(reqId, 'error', '会话已中断，请重新发送');
    imRequestRegistry.setStatus(reqId, 'failed');
    imRequestRegistry.unregister(reqId);
  }
  clearPendingRequests();
  // PRD 0.2.18 Session Inbox — if abort happens while an inbox-message turn is
  // in flight, push a session_aborted reply back to the caller so it doesn't
  // wait forever. Fire-and-forget. Read + clear immediately to avoid the
  // recovery session inheriting this binding.
  if (currentTurnInboxMeta) {
    const replyMeta = currentTurnInboxMeta;
    currentTurnInboxMeta = undefined;
    const replyText = currentTurnTextBlocks.join('').trim();
    currentTurnTextBlocks.length = 0;
    const abortedSessionId = sessionId;
    void import('./inbox/reply-deliver').then(({ deliverInboxReply }) =>
      deliverInboxReply(abortedSessionId, replyMeta, {
        text: replyText,
        error: {
          code: 'session_aborted',
          message: 'target session was aborted before the turn completed',
        },
      }),
    ).catch((err) =>
      console.error('[inbox] abort-path reply pushback failed:', err),
    );
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
// SDK assistant messages can carry a provisional .error even when the final
// SDK result later succeeds. Keep it turn-local until the authoritative result.
let currentTurnHadAssistantMessageError = false;
let currentTurnLastAssistantMessageError: string | null = null;
// Whether the current turn observed any non-init SDK frame (assistant /
// user / tool_result / stream_event / result / rate_limit_event etc.).
// Cheaper signal than currentTurnHasOutput — flips on the FIRST substantive
// SDK frame, before the assistant message is fully assembled. Used by the
// inactivity watchdog to decide whether to set pendingContinueAfterAbort
// (replaces the previous `messageCount > 3` heuristic, which was both
// cumulative across turns and brittle against SDK init-framing changes).
let turnHadSubstantiveActivity = false;
// Browser tool tracking for storage-state auto-save
// Tracks whether any browser_* MCP tools were used in the current session,
// and whether browser_storage_state was called (to avoid redundant save).
let sessionBrowserToolUsed = false;
let sessionStorageStateSaved = false;

// PRD 0.2.18 Session Inbox — per-turn binding of inbox metadata.
//
// Bound when the message generator yields a queued item that carries inboxMeta
// (i.e. the message came in via /api/inbox/drain from a `myagents session send`
// caller). Read at SDK result event handler: if replyBack=true, the turn's text
// output is collected and pushed back to the caller via deliverInboxReply().
//
// CRITICAL — per-turn semantics, NOT session-level singleton:
//   - Bound on dequeue (generator yield), not on enqueue (PRD §5.5)
//   - Read at result handler, then immediately cleared
//   - Abort path: cleared too, optionally sends a session_aborted reply first
//   - Multiple consecutive inbox messages each get their own binding via the
//     same per-turn dequeue path (the next yield overwrites — correct because
//     SDK persistent session is single-threaded turn execution)
let currentTurnInboxMeta: import('./inbox/types').InboxTurnMeta | undefined = undefined;

// Accumulator for assistant text blocks within the current turn — used by
// inbox reply pushback to assemble the reply body. Reset at turn start.
const currentTurnTextBlocks: string[] = [];

// ─── Delayed Continue (watchdog-driven session resume) ────────────────────
//
// When the inactivity watchdog (`apiWatchdogId` setInterval below the
// SDK for-await loop) aborts a turn that produced real output, the
// SessionMetadata gets `pendingContinueAfterAbort=true`. The next
// `enqueueUserMessage` call against this session reads the flag,
// synchronously test-and-sets the per-session guard, recursively
// enqueues a single system-reminder turn, then (on success) clears
// the disk flag and marks the per-process cap.
//
// `consumingPendingContinueSessions` is a per-session synchronous lock
// preventing two concurrent enqueueUserMessage callers against the SAME
// session from each injecting a reminder. Per-session (not global) so
// two different sessions consuming their own flags in parallel don't
// block each other — cross-review caught the global lock as a real
// correctness issue (second session would silently skip consume).
const consumingPendingContinueSessions = new Set<string>();

// Cap auto-Continue at exactly ONE injection per sessionId per sidecar
// process lifetime. Without this cap, the chain
//   watchdog abort → consume + inject reminder → reminder turn produces 1 byte
//   then itself watchdog-aborts → flag re-set → user's next message consumes
//   again → reminder again → ...
// would loop. The empty-turn skip in the watchdog catches "the API is dead"
// turns, but a reminder turn that gets *some* output before stalling would
// otherwise re-arm the flag. Capping per-session here is the structural
// guarantee that the user's "避免循环重试" requirement holds even under
// the partial-output-then-hang scenario.
//
// The Set is added to ONLY after a successful reminder enqueue (post-await,
// post-session-switch-verification). If the reminder rejects (queue full)
// or a switchToSession races, neither the disk flag nor this Set is
// updated — the next legit enqueue on the original session re-attempts.
//
// New sidecar process = new Set = one fresh auto-Continue allowed (e.g.,
// user opens an aborted-cron session hours later in chat). That's
// intentional, matching the spec.
const autoResumeInjectedSessions = new Set<string>();

// Synthetic user-turn content injected by the Delayed Continue path.
// Kept short and in English: the SDK's system-reminder convention
// expects compact, model-readable instructions, not verbose user-facing
// copy. Sent as a user turn (no special metadata) so it appears in
// session history exactly once and is durable across sidecar restarts.
const WATCHDOG_RESUME_REMINDER =
  '<system-reminder>The previous turn was aborted by the inactivity watchdog (10-minute timeout). Resume from existing context and complete the unfinished task.</system-reminder>';

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
  currentTurnHadAssistantMessageError = false;
  currentTurnLastAssistantMessageError = null;
  turnHadSubstantiveActivity = false;
  currentTurnTextBlocks.length = 0;
  // Note: currentTurnInboxMeta is NOT reset here — it's bound on dequeue
  // (generator yield) and cleared at result handler / abort path.
}

// ===== MCP Configuration =====
import type { McpServerDefinition } from '../shared/config-types';
// SDK's in-process server instance type — what createSdkMcpServer() returns.
// Imported as a type (no runtime cost) so we can annotate the buildSdkMcpServers
// result map without relying on a module-level singleton.
import type { McpSdkServerConfigWithInstance } from '@anthropic-ai/claude-agent-sdk';

// SDK MCP server config type (subset of what SDK accepts — external transports only)
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

// Union type for buildSdkMcpServers result — each slot is either an external
// transport spec (SDK spawns subprocess / hits URL) or an in-process SDK
// server object (tool handlers run in this Node process).
type McpServerEntry = SdkMcpServerConfig | McpSdkServerConfigWithInstance;

// Current MCP servers enabled for this workspace (set per-query)
// null = never set (use config file fallback), [] = explicitly set to none
let currentMcpServers: McpServerDefinition[] | null = null;

/**
 * Read-only accessor for `currentMcpServers`. Used by `/cron/execute-sync` to
 * reuse the frontend-set MCP shapes (from `/api/mcp/set`) instead of
 * recomputing via the sidecar's `getAllMcpServers()` — the two compute paths
 * produce slightly different env/args field structures, and feeding the
 * sidecar-shaped definitions into `applyMcpOverrideAndAwaitReady` triggers a
 * fingerprint mismatch → abort+restart that wastes ~5s on every launcher
 * cron handoff. The same fingerprint-mismatch hazard is documented at
 * `agent-session.ts::initializeAgent` (line ~4972) where the Tab path
 * deliberately skips self-resolve for the same reason.
 *
 * Returns `null` when no `/api/mcp/set` has happened yet (Tab not opened
 * before cron firing — pure-cron / IM bot paths). Callers fall back to
 * `getAllMcpServers()` in that case.
 */
export function getCurrentMcpServers(): readonly McpServerDefinition[] | null {
  return currentMcpServers;
}

// Fingerprint of the MCP key set the SDK was last known to have (sorted server-id list).
// Captured when query() starts and after each successful querySession.setMcpServers(),
// so ensureSdkMcpInSync() can detect when the desired MCP set has drifted from the SDK's
// live set (typically after IM context-injected MCPs become available post pre-warm).
let frozenSdkMcpFingerprint = '';

// PRD 0.2.17 — Claude plugin enabled IDs for this session/sidecar.
//   - `null` (initial) → resolve via getDefaultEnabledPluginIdsForWorkspace(agentDir)
//     on every options-build call. Lets Agent / Project config edits take
//     effect on the next pre-warm without needing the renderer to push.
//   - `string[]`       → explicit per-Tab override (renderer pushed via
//     setSessionEnabledPluginIds). Bypasses the Agent default; clearing
//     back to null restores Agent-tracking behaviour.
//
// Mirrors `currentMcpServers` / `currentAgentDefinitions` per-sidecar state.
let currentEnabledPluginIds: string[] | null = null;

/**
 * Per-Tab UI override entry point. Renderer calls this when the user toggles
 * a plugin in the chat input "插件" submenu — sets the override + schedules
 * a deferred restart so the next session pre-warm picks up the new options.
 *
 * Pass `null` to clear the override and fall back to Agent default tracking.
 */
export function setSessionEnabledPluginIds(ids: string[] | null): void {
  // Same-set short-circuit — avoids gratuitous restart when renderer
  // re-emits the same list (e.g. after a settings refresh).
  const current = currentEnabledPluginIds;
  if (current === null && ids === null) return;
  if (
    current !== null &&
    ids !== null &&
    current.length === ids.length &&
    current.every((id, i) => id === ids[i])
  ) {
    return;
  }
  currentEnabledPluginIds = ids === null ? null : [...ids];
  forceReloadActiveSession('plugins');
}

export function getSessionEnabledPluginIds(): readonly string[] | null {
  return currentEnabledPluginIds;
}

// Current sub-agent definitions (set per-query via /api/agents/set)
// null = no agents configured, {} = explicitly set to none
let currentAgentDefinitions: Record<string, AgentDefinition> | null = null;

/**
 * Hot-reload proxy configuration into the current process environment.
 * Mutates process.env so that subsequent SDK subprocess spawns inherit the new proxy.
 * Triggers session restart (abort + resume + pre-warm) identical to MCP config changes,
 * but only when the effective proxy URL actually changed.
 *
 * SOCKS5 handling: Node.js `fetch()` (undici) doesn't support `socks5://` in HTTP_PROXY env vars.
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
 * Critical-section mutex for cron task dispatch (PRD 0.2.4 §需求 4 — cross-
 * review B2 / B5 / B6 / B7). Wraps the ENTIRE cron handler body — session
 * switch, context setup, MCP apply, enqueue, wait-for-idle — so two
 * concurrent cron ticks within a single sidecar can't interleave on any
 * shared global state (currentMcpServers, sessionId, cronTaskContext,
 * interactionScenario). Each waiter chains onto the previous promise so
 * callers see a strictly serial execution order.
 */
let cronDispatchQueue: Promise<unknown> = Promise.resolve();

/**
 * Run `fn()` under the cron-dispatch mutex. Used by `/cron/execute-sync`
 * to atomically execute a cron tick — session switch, MCP reconcile,
 * prompt enqueue, idle wait — without interleaving with another tick.
 */
export async function withCronDispatchLock<T>(fn: () => Promise<T>): Promise<T> {
  const next = cronDispatchQueue.catch(() => undefined).then(() => fn());
  // Track the chain as `Promise<unknown>` so the queue type stays uniform
  // across heterogeneous T's; the typed result still flows back via `next`.
  // `.catch` on the stored chain prevents a rejected turn from poisoning
  // subsequent waiters.
  cronDispatchQueue = next.then(
    () => undefined,
    () => undefined,
  );
  return next;
}

/**
 * Apply an MCP set synchronously and ensure a fresh SDK session is live —
 * used inside `withCronDispatchLock` when the cron path needs to switch
 * MCP for this task (or reconcile back to workspace defaults from a prior
 * task's override).
 *
 * Why a dedicated helper instead of `setMcpServers`:
 *   1. `setMcpServers`'s restart path is debounced 500ms via the pre-warm
 *      timer so rapid `/api/mcp/set` calls (React state-sync) don't thrash
 *      the subprocess. Cron has the OPPOSITE need — the very next
 *      `enqueueUserMessage` MUST run against the new MCP set with no race
 *      window. This helper bypasses the debounce.
 *   2. `setMcpServers` skips restart entirely when the current session is
 *      snapshotted (session metadata claims authority over MCP). For cron
 *      we ARE the authority — the task override IS the new "session list" —
 *      so the snapshot guard would silently no-op us. This helper bypasses
 *      that guard by triggering the restart itself rather than relying on
 *      the deferred-restart machinery.
 *
 * Behaviour:
 *   - Calls `setMcpServers(servers)` to update `currentMcpServers`.
 *   - If the MCP fingerprint changed AND a session is live: cancels the
 *     pre-warm timer, drains the deferred-restart reasons, aborts the
 *     persistent session, awaits termination, kicks off a fresh
 *     `startStreamingSession(true)`, and polls until the new session
 *     handle is assigned (`querySession !== null` and
 *     `shouldAbortSession === false`).
 *   - No-op when fingerprint is unchanged.
 *   - When no session was running, leaves the stored config in place and
 *     lets the next `enqueueUserMessage` start a session as usual.
 *
 * Caller MUST hold `withCronDispatchLock` — this helper does not
 * serialise itself; concurrent calls would race on `querySession`.
 */
export async function applyMcpOverrideAndAwaitReady(servers: McpServerDefinition[]): Promise<void> {
  const before = mcpConfigFingerprint(currentMcpServers ?? []);
  const after = mcpConfigFingerprint(servers);
  setMcpServers(servers);
  if (before === after) return;
  if (!querySession) return; // no live session — next enqueueUserMessage starts one with the current fingerprint
  // Live session with a different MCP fingerprint — force restart.
  if (preWarmTimer) {
    clearTimeout(preWarmTimer);
    preWarmTimer = null;
  }
  drainDeferredRestart(); // clear any leftover reasons; we drive restart
  console.log('[agent] applyMcpOverrideAndAwaitReady: forcing immediate session restart for MCP change');
  abortPersistentSession();
  await awaitSessionTermination(10_000, 'applyMcpOverrideAndAwaitReady');

  // After termination `shouldAbortSession` is still true and there is no
  // live SDK process. If `enqueueUserMessage` ran now, it would treat
  // `shouldAbortSession` as busy and queue — and `waitForSessionIdle`
  // would return prematurely (sessionState === 'idle' immediately) before
  // the queued message ran. Force a fresh subprocess and poll until the
  // SDK session handle is assigned.
  void startStreamingSession(true).catch((error) => {
    console.error('[agent] applyMcpOverrideAndAwaitReady: post-abort restart failed:', error);
  });
  const restartDeadline = Date.now() + 10_000;
  while (Date.now() < restartDeadline) {
    if (querySession && !shouldAbortSession) break;
    await new Promise((r) => setTimeout(r, 50));
  }
  if (!querySession || shouldAbortSession) {
    console.warn('[agent] applyMcpOverrideAndAwaitReady: timed out waiting for new session');
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
    if (isCurrentSessionSnapshotted()) {
      // v0.1.69 T14: Locked session owns its MCP list — agent-level toggles don't apply here.
      // Expected frontend behavior is to pass the session-resolved list so mcpChanged is false;
      // if we got here, it means someone passed the agent's raw list. Log and skip restart.
      console.log(`[agent] MCP changed but session ${sessionId} is snapshotted — skip restart (snapshot is authoritative)`);
    } else {
      const ids = servers.map(s => s.id).join(', ') || 'none';
      console.log(`[agent] MCP config changed → [${ids}], deferring restart to pre-warm debounce`);
      scheduleDeferredRestart('mcp');
    }
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
 * Stable fingerprint of the sub-agent definition set.
 *
 * Covers the fields the SDK actually consumes per `AgentDefinition` — model,
 * tools, disallowedTools, description, prompt body, skills, maxTurns — so an
 * edit to `model:` in `<name>.md` frontmatter (a common reload case) gets
 * detected as a real change and triggers a deferred restart.
 *
 * The previous fingerprint hashed only `Object.keys(...).sort()`, which meant
 * "same agent names → no change" even when the payload differed. That was
 * the root cause of `myagents reload` silently ignoring frontmatter edits
 * (GitHub #98).
 */
function agentsFingerprint(agents: Record<string, AgentDefinition> | null): string {
  if (!agents) return '';
  return JSON.stringify(
    Object.keys(agents)
      .sort()
      .map(name => {
        const a = agents[name];
        return {
          name,
          description: a.description,
          prompt: a.prompt,
          tools: a.tools,
          disallowedTools: a.disallowedTools,
          model: a.model,
          skills: a.skills,
          maxTurns: a.maxTurns,
        };
      }),
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
  // Content fingerprint (not just names) — frontmatter-only edits (e.g. changing
  // `model:` on an existing sub-agent) MUST trigger a restart. Names-only diff
  // silently dropped these edits and forced users to restart the whole app (#98).
  const currentFingerprint = agentsFingerprint(currentAgentDefinitions);
  const nextFingerprint = agentsFingerprint(agents);
  const agentsChanged = currentFingerprint !== nextFingerprint;

  const newNames = Object.keys(agents).sort().join(',');

  currentAgentDefinitions = agents;
  if (isDebugMode) {
    console.log(`[agent] Sub-agents set: ${newNames || 'none'}`);
  }

  // Defer restart to pre-warm debounce (same as setMcpServers — see comment there).
  if (agentsChanged && querySession) {
    if (isCurrentSessionSnapshotted()) {
      // v0.1.69 T14: Locked session owns its sub-agents — skip restart (same rationale as MCP).
      console.log(`[agent] Sub-agents changed but session ${sessionId} is snapshotted — skip restart`);
    } else {
      console.log(`[agent] Sub-agents content changed (${newNames || 'none'}), deferring restart to pre-warm debounce`);
      scheduleDeferredRestart('agents');
    }
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

/**
 * Background-agent permission policy (issue #264). Controls what a
 * `run_in_background` sub-agent may do when it hits a tool that the SDK can't
 * auto-resolve. The SDK never calls our `canUseTool` for background sub-agents
 * — it routes those decisions to the `PermissionRequest` hook (registered in
 * startStreamingSession), which consults this value. Default 'inherit' (only
 * already-granted tools run in the background; nothing wider).
 *
 * Pushed per-session by the frontend alongside the chat-send payload (mirrors
 * `currentPermissionMode`). Never inferred from the model's run_in_background
 * choice — only from this explicit user setting.
 */
let currentBackgroundAgentPermissionMode: BackgroundAgentPermissionMode = DEFAULT_BACKGROUND_AGENT_PERMISSION_MODE;

export function getBackgroundAgentPermissionMode(): BackgroundAgentPermissionMode {
  return currentBackgroundAgentPermissionMode;
}

/**
 * Set the background-agent permission policy. Takes effect for the next
 * background sub-agent permission decision — no SDK restart needed (the hook
 * reads this module-level value live). Idempotent.
 */
export function setBackgroundAgentPermissionMode(mode: BackgroundAgentPermissionMode): void {
  if (mode === currentBackgroundAgentPermissionMode) return;
  console.log(`[agent] background-agent permission mode: ${currentBackgroundAgentPermissionMode} -> ${mode}`);
  currentBackgroundAgentPermissionMode = mode;
}

/**
 * In-flight `querySession.setModel()` promise — set by every SDK-side model
 * dispatch (`setSessionModel`'s fire-and-forget path AND `applySessionConfig`'s
 * awaited path), cleared when the promise settles.
 *
 * Why this exists (Codex adversarial review 2026-05-07):
 *
 * The race had three actors that update `currentModel` and call SDK setModel:
 *
 *   1. `setSessionModel(M2)` — UI model picker. Sync update of `currentModel`,
 *      fire-and-forget `querySession.setModel(M2[1m]).catch(...)`. Returns
 *      before the SDK subprocess has actually swapped.
 *
 *   2. `applySessionConfig({ model: M2 })` — runs on every send. Short-circuits
 *      at `newModel === currentModel`, skipping its own setModel call.
 *
 *   3. `enqueueUserMessage` — yields the user's message to the SDK subprocess.
 *
 * Without coordination, the user-visible flow "click M2, immediately click
 * Send" is: (1) sync-updates currentModel + dispatches setModel async →
 * (2) sees newModel === currentModel and short-circuits → (3) yields the
 * message — all before the SDK subprocess has processed (1)'s setModel IPC.
 * The first turn runs on the OLD model.
 *
 * Fix: every SDK-side dispatch goes through `dispatchSetModelToSdk()` which
 * registers the promise here. `applySessionConfig` awaits this promise at
 * its very top — even when it's about to short-circuit — so by the time
 * we yield the user's message the SDK is guaranteed to be on the requested
 * model. The promise self-clears on settle (only if not overwritten by a
 * newer dispatch in between).
 */
let pendingSetModelPromise: Promise<void> | null = null;

/**
 * Send a model change to the live SDK subprocess and register the in-flight
 * promise on `pendingSetModelPromise`. Idempotent against `querySession`
 * being null (returns a resolved promise — fresh subprocess will read
 * `currentModel` at spawn).
 *
 * Caller is responsible for updating `currentModel` itself; this helper
 * only handles the SDK-IPC side. The split is deliberate: `setSessionModel`
 * needs to update `currentModel` synchronously (so any concurrent reader
 * sees the new value), but the IPC is fire-and-forget; `applySessionConfig`
 * needs to await before updating `currentModel` (so a failed setModel
 * doesn't leave currentModel ahead of SDK reality).
 */
function dispatchSetModelToSdk(model: string): Promise<void> {
  if (!querySession) return Promise.resolve();
  const session = querySession;
  const wrapped = applyContextWindowSuffix(model);
  const promise = session.setModel(wrapped).catch(err => {
    console.error('[agent] failed to apply model to running session:', err);
  });
  pendingSetModelPromise = promise;
  // Self-clear on settle. Guard against a newer dispatch having already
  // overwritten us — that newer dispatch's own settle will do its own clear.
  promise.finally(() => {
    if (pendingSetModelPromise === promise) {
      pendingSetModelPromise = null;
    }
  });
  return promise;
}

export function setSessionModel(model: string): void {
  if (model === currentModel) return;

  const oldModel = currentModel;
  const aliasEnvChanged = modelAliasEnvChangesForModel(currentProviderEnv?.modelAliases, oldModel, model);
  currentModel = model;
  console.log(`[agent] session model set: ${oldModel ?? 'undefined'} -> ${model}`);

  // Apply model change to SDK subprocess immediately (including during pre-warm).
  // Without this, changing model during pre-warm creates a desync:
  //   currentModel is updated but SDK subprocess keeps the old model,
  //   and applySessionConfig() on first message sees no diff → skips the SDK call.
  // setModel() on the live SDK subprocess updates `userSpecifiedModel` which
  // feeds into getContextWindowForModel() on every following turn — so the
  // [1m] tag MUST be applied here too, otherwise switching to a 1M model
  // mid-session keeps the live SDK on the 200K path until the deferred restart
  // below respawns the subprocess.
  //
  // Fire-and-forget at this seam (UI-driven, no await available), but
  // `dispatchSetModelToSdk` registers `pendingSetModelPromise` so the next
  // `applySessionConfig` awaits before yielding the user's message.
  void dispatchSetModelToSdk(model);

  // CLAUDE_CODE_AUTO_COMPACT_WINDOW is baked into the subprocess env at spawn
  // time and cannot be updated on a live process — `querySession.setModel()`
  // above only switches the model ID the SDK sends to the provider. So if the
  // old and new models have different `contextLength`, the autocompact
  // threshold stays frozen at the old model's cap until the next subprocess
  // respawn. Schedule a deferred restart so the fresh env reflects the new
  // model's real window. Same rationale as the `provider` reason in
  // `setSessionProviderEnv` — env-baked knobs need a respawn.
  const oldCtx = lookupModelContextLength(oldModel);
  const newCtx = lookupModelContextLength(model);
  if (oldCtx !== newCtx) {
    if (querySession) {
      console.log(`[agent] model window changed (${oldCtx ?? 'SDK-default'} → ${newCtx ?? 'SDK-default'}) → schedule deferred restart to reinject CLAUDE_CODE_AUTO_COMPACT_WINDOW`);
      scheduleDeferredRestart('model-window');
    }
  }

  // ANTHROPIC_DEFAULT_*_MODEL is also baked into the SDK subprocess env.
  // querySession.setModel() updates the parent model only; SDK built-in
  // subagents such as Explore keep resolving their own model aliases from
  // those env vars until the subprocess is respawned.
  if (aliasEnvChanged && querySession) {
    if (isTurnInFlight()) {
      console.log('[agent] model aliases changed during active turn -> schedule deferred restart to reinject ANTHROPIC_DEFAULT_*_MODEL');
      scheduleDeferredRestart('model-aliases');
    } else {
      console.log('[agent] model aliases changed while idle/pre-warming -> aborting session to reinject ANTHROPIC_DEFAULT_*_MODEL');
      abortPersistentSession();
      schedulePreWarm();
    }
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
  // PRD #124: keep the active session's bridge registration in sync with the
  // new provider. Function is idempotent and handles all transitions
  // (Anthropic→OpenAI, OpenAI→Anthropic, OpenAI→OpenAI) — registers, updates,
  // or unregisters as appropriate.
  ensureActiveSessionBridgeRegistered();

  // If a session is running, its subprocess has the OLD provider env.
  // Restart so the next session picks up the updated environment.
  // v0.1.69 T14: Locked sessions own their provider — agent-level provider sync
  // should not abort them. The snapshot in the Sidecar's startup env is
  // authoritative; a later /api/provider/set from Rust reflecting an agent
  // config change must be ignored at the restart-scheduling layer.
  if (isCurrentSessionSnapshotted()) {
    console.log(`[agent] provider changed (${oldLabel} → ${newLabel}) but session ${sessionId} is snapshotted — skip abort/restart`);
  } else if (querySession) {
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
/**
 * Force a session restart triggered by an explicit `myagents reload`.
 *
 * Unlike `setMcpServers` / `setAgents` / provider / proxy paths, this bypasses
 * the `isCurrentSessionSnapshotted()` guard. The snapshot guard exists to
 * protect owned sessions (Tab / Cron / Background) from noise — e.g. React
 * state sync firing `/api/mcp/set` 7× in 4s shouldn't thrash the SDK.
 *
 * Reload is the opposite: a deliberate, user-/AI-initiated request to re-read
 * the config from disk and apply it to the running session. If we don't
 * restart here, the user's edited `.md` frontmatter (new model, new tools)
 * sits in memory but the running subprocess keeps delegating to the old
 * definitions — forcing an app restart (#98).
 *
 * Callers MUST have already updated in-memory state (`setMcpServers` +
 * `setAgents`) before invoking this. Active turns are respected via the same
 * deferred-restart mechanism; idle sessions abort immediately.
 */
/**
 * PRD 0.2.17 — public entrypoint for the plugins admin API. Called after
 * any install / uninstall / toggle write so the next SDK session picks up
 * the refreshed plugin list. Composes with the existing deferred-restart
 * pipeline (no new abort path) and respects the external-runtime guard
 * inside schedulePreWarm. We intentionally do NOT short-circuit no-op
 * toggles via a fingerprint comparison: the restart cost on an idle
 * sidecar is ~1s and the comparison's own cost (lstat + isPluginRootDir
 * walk on every enabled plugin) is not negligible. See review notes
 * (Codex AI-specific findings) for the analysis.
 */
export function schedulePluginDeferredRestart(): void {
  forceReloadActiveSession('plugins');
}

export function forceReloadActiveSession(reason: RestartReason = 'mcp'): void {
  if (querySession) {
    if (isProcessing && !isPreWarming) {
      console.log(`[agent] reload requested during active turn → deferring restart (reason=${reason})`);
      scheduleDeferredRestart(reason);
    } else {
      console.log(`[agent] reload requested → aborting session (reason=${reason}, preWarm=${isPreWarming})`);
      abortPersistentSession();
    }
  } else if (isProcessing) {
    // Startup window: startStreamingSession() is in progress but querySession
    // hasn't been assigned yet. buildClaudeSessionEnv() may have already read
    // the pre-reload state. Defer the restart so it fires after the first turn
    // completes — mirrors the provider-change path (search for the same
    // comment in setSessionProviderEnv).
    console.log(`[agent] reload requested during session startup → deferring restart (reason=${reason})`);
    scheduleDeferredRestart(reason);
  }
  preWarmFailCount = 0;
  if (!isProcessing || isPreWarming) {
    schedulePreWarm();
  }
}

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

    if (isSessionActive()) {
      // Session still cleaning up OR a fresh `startStreamingSession()` is mid-spawn
      // (`isProcessing=true` but `querySession` not yet assigned). RETRY instead of
      // calling startStreamingSession() — that would become a "stale awaiter" on
      // sessionTerminationPromise and wake later for an unrelated reason. Don't drain
      // pendingConfigRestart here either: a setter that ran during the spawn window
      // (e.g. `setSessionProviderEnv` at the `isProcessing && !querySession` branch)
      // may have legitimately latched a reason that needs to apply against the
      // spawning subprocess once `querySession` is set on the next timer fire.
      schedulePreWarm();
      return;
    }
    // Truly idle — no session and not spawning. Clear any leftover reasons (e.g.
    // scheduled during a failed startup where the session never came up) so the
    // fresh pre-warm doesn't carry stale ghosts.
    drainDeferredRestart();
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
 * Predicate for each MyAgents-reserved context-injected builtin MCP id.
 * Returns true when the corresponding sidecar context is set, mirroring the
 * inclusion conditions in `buildSdkMcpServers()` Pattern 1.
 *
 * The `Record<typeof MYAGENTS_CONTEXT_INJECTED_MCP_IDS[number], …>` shape
 * makes TypeScript enforce 1:1 alignment between the reserved id list and
 * the predicates: adding a new reserved id without a predicate (or vice
 * versa) is a compile error. This is the pit-of-success against the drift
 * that caused issue #148.
 *
 * Background: builtin MCPs are injected into the SDK based on sidecar context
 * (IM bot / cron task / bridge plugin), but `checkMcpToolPermission()` used to
 * compare tool names against `currentMcpServers` only — which never contains
 * context-injected MCPs. Result: SDK said "tool ready", permission gate said
 * "未启用". The fix routes the permission gate through this single map.
 */
const CONTEXT_INJECTED_BUILTIN_PREDICATES: Record<
  typeof MYAGENTS_CONTEXT_INJECTED_MCP_IDS[number],
  () => boolean
> = {
  'im-bridge-tools': () => Boolean(getImBridgeToolsContext()) && Boolean(getImBridgeToolServer()),
};

function getActiveContextInjectedBuiltinIds(): Set<string> {
  const ids = new Set<string>();
  for (const id of MYAGENTS_CONTEXT_INJECTED_MCP_IDS) {
    if (CONTEXT_INJECTED_BUILTIN_PREDICATES[id]()) ids.add(id);
  }
  return ids;
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

  // Context-injected builtin MCPs (currently only `im-bridge-tools`) are not
  // in `currentMcpServers` — they're injected by sidecar context, not user
  // toggles. Allow them when the corresponding context is active. Mirrors
  // buildSdkMcpServers() Pattern 1.
  const activeBuiltins = getActiveContextInjectedBuiltinIds();
  if (activeBuiltins.has(serverId)) {
    return { allowed: true };
  }
  // For ids in MYAGENTS_CONTEXT_INJECTED_MCP_IDS but NOT currently active,
  // reject with a context-specific message instead of the generic "未启用".
  // Driven by the reserved-id list so it can never drift from Pattern 1.
  // Retired MCP names (`cron-tools` / `im-cron` / `im-media`) intentionally
  // fall through to the regular user-MCP check below — they were dropped
  // from the reserved list in v0.2.11, so user MCPs may now legitimately
  // claim those names.
  if (serverId === 'im-bridge-tools') {
    return { allowed: false, reason: 'IM Bridge 工具仅在 IM Bridge 插件会话中可用' };
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
 * 1. Context-injected (im-bridge-tools) — always present based on sidecar
 *    context, invisible in Settings UI, not user-toggled. Used for the
 *    OpenClaw plugin bridge which exposes a runtime-dynamic tool surface.
 *    Other historical context-injected MCPs (`cron-tools`, `im-cron`,
 *    `im-media`) were retired in v0.2.11 — the AI now reaches those
 *    capabilities through the `myagents` CLI + system prompt guidance,
 *    so the same surface is available across builtin / Codex / Gemini /
 *    Claude Code runtimes.
 * 2. Builtin registry (command='__builtin__') — in-process servers, user-toggled via Settings,
 *    registered as META in `./tools/builtin-mcp-meta.ts`. Adding a new one:
 *      (a) add `registerBuiltinMcpMeta({ id, load })` block in builtin-mcp-meta.ts, and
 *      (b) write the tool file with `createXxxServer()` async factory whose SDK + zod imports
 *          live INSIDE the factory via `await import()` — never at the tool module's top level,
 *          or the lazy-load win is defeated (see CLAUDE.md 禁止事项 and builtin-mcp-registry.ts).
 * 3. External (stdio/sse/http) — subprocess or remote servers, user-configured.
 *
 * Execution strategy for external stdio:
 * - For npx commands: system npx → bundled Node.js npx → bun x
 * - For other commands: Uses user-specified command directly (node/python etc.)
 * - Inherits proxy env + injects NO_PROXY to protect localhost (mirrors Rust proxy_config)
 */
async function buildSdkMcpServers(): Promise<Record<string, McpServerEntry>> {
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
    // Reserve MyAgents context-injected builtin ids: a user MCP with the same id
    // would otherwise overwrite the builtin in result[id] and inherit its
    // auto-trust in canUseTool — see issue #148.
    if ((MYAGENTS_CONTEXT_INJECTED_MCP_IDS as readonly string[]).includes(normalized)) {
      console.warn(`[agent] MCP "${s.id}" skipped: id is reserved by MyAgents (context-injected builtin). Rename to avoid this.`);
      return false;
    }
    return true;
  });
  if (isDebugMode) console.log(`[agent] MCP servers: ${servers.map(s => s.id).join(', ') || 'none'}`);

  const result: Record<string, McpServerEntry> = {};

  // --- Pattern 1: Context-injected MCPs (always present based on sidecar context) ---
  // Add Bridge tools if we're in an IM context with a plugin bridge that has tools.
  // Dynamic server is created from actual plugin tool definitions — transparent
  // passthrough. This is the only remaining Pattern 1 MCP after the v0.2.11 cron
  // / im-cron / im-media → CLI migration: bridge plugins expose runtime-dynamic
  // tool surfaces that can't be expressed as a static prompt + CLI.
  const bridgeToolsCtx = getImBridgeToolsContext();
  const bridgeServer = getImBridgeToolServer();
  if (bridgeToolsCtx && bridgeServer) {
    result['im-bridge-tools'] = bridgeServer;
    console.log(`[agent] Added im-bridge-tools MCP server for plugin ${bridgeToolsCtx.pluginId}`);
  }

  // --- Pattern 2: Builtin registry MCPs (in-process, user-toggled) ---
  for (const server of servers) {
    if (server.command !== '__builtin__') continue;
    const entryPromise = getBuiltinMcpInstance(server.id);
    if (!entryPromise) {
      console.warn(`[agent] Builtin MCP '${server.id}' not registered — skipping`);
      continue;
    }
    const entry = await entryPromise;
    entry.configure?.(server.env || {}, { sessionId: sessionId || 'default', workspace: agentDir });
    result[server.id] = entry.server as McpSdkServerConfigWithInstance;
    console.log(`[agent] Added builtin MCP: ${server.id}`);
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
        // v0.2.0+ priority: system npx → bundled Node.js npx → npx derived from runtime path.
        // Bun fallback removed — MyAgents no longer bundles Bun, and "bun x" was an
        // emergency escape hatch for Linux boxes with neither Node nor bundled runtime,
        // which is no longer a supported config.
        const systemNpx = findExistingPath(getSystemNpxPaths());

        if (systemNpx) {
          // 1. System npx available — most reliable, user-maintained
          command = systemNpx;
          if (!args.includes('-y')) args = ['-y', ...args];
          console.log(`[agent] MCP ${server.id}: Using system npx (${systemNpx})`);
        } else {
          // 2. Fallback to bundled Node.js npx (use absolute path for deterministic resolution)
          const nodeDir = getBundledNodeDir();
          if (nodeDir) {
            command = process.platform === 'win32' ? join(nodeDir, 'npx.cmd') : join(nodeDir, 'npx');
            if (!args.includes('-y')) args = ['-y', ...args];
            console.log(`[agent] MCP ${server.id}: System npx not found, using bundled Node.js npx (${command})`);
          } else {
            // 3. Last resort: derive npx from the runtime path returned by
            //    getBundledRuntimePath() (always a Node binary in v0.2.0+).
            const runtime = getBundledRuntimePath();
            const npxSibling = resolve(dirname(runtime), process.platform === 'win32' ? 'npx.cmd' : 'npx');
            command = npxSibling;
            if (!args.includes('-y')) args = ['-y', ...args];
            console.log(`[agent] MCP ${server.id}: Derived npx from runtime path: ${npxSibling}`);
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
 * Sorted-key fingerprint of an MCP server map (id list).
 * Identity comparison only — env/args/url changes for user-configured MCPs
 * already trigger restart via mcpConfigFingerprint() + setMcpServers().
 * This is for context-injected MCPs (im-media, im-bridge-tools) whose
 * presence flips on/off as IM context becomes available.
 */
function mcpKeyFingerprint(servers: Record<string, unknown>): string {
  return Object.keys(servers).sort().join(',');
}

/**
 * Sync the SDK's live MCP set to match what `buildSdkMcpServers()` would produce now.
 *
 * Why this exists:
 *   Context-injected MCPs (im-media, im-bridge-tools) become available only when
 *   `/api/im/enqueue` arrives and calls `setImMediaContext()` / `setImBridgeToolsContext()`.
 *   But for IM Bot Sidecars the SDK is pre-warmed by heartbeat long before the first
 *   message — at that point those contexts are null, so `buildSdkMcpServers()` doesn't
 *   include them, and the SDK subprocess freezes its mcpServers config without them.
 *   When the user message later arrives via wakeGenerator(), the SDK's tool list
 *   still excludes those MCPs and the AI reports them as "disconnected".
 *
 *   This function uses the SDK's runtime `setMcpServers()` to dynamically inject the
 *   missing servers without restarting the subprocess (which would add cold-start latency
 *   to the user's first message). On failure, it falls back to scheduling a restart.
 *
 * Idempotent: if the fingerprint hasn't changed since query() startup or the last
 * successful sync, this is a no-op (cheap key-set diff).
 *
 * Caller contract: invoke AFTER all `setXxxContext()` calls that affect
 * `buildSdkMcpServers()` and BEFORE the next `enqueueUserMessage()` so the SDK
 * picks up the new tool list before processing the message.
 */
export async function ensureSdkMcpInSync(): Promise<void> {
  if (!querySession) return;

  const newServers = await buildSdkMcpServers();
  const newFingerprint = mcpKeyFingerprint(newServers);
  if (newFingerprint === frozenSdkMcpFingerprint) return;

  console.log(`[agent] SDK MCP set drift detected, syncing live session: was=[${frozenSdkMcpFingerprint || '(empty)'}] now=[${newFingerprint || '(empty)'}]`);

  try {
    const result = await querySession.setMcpServers(newServers);
    const errKeys = Object.keys(result.errors ?? {});
    if (errKeys.length > 0) {
      // SDK reported per-server connect errors. Don't trust the new fingerprint
      // — the AI would think those MCPs are connected when they aren't.
      // Fall through to the restart fallback so the next pre-warm rebuilds cleanly.
      console.warn(`[agent] SDK setMcpServers reported errors for [${errKeys.join(',')}]: ${JSON.stringify(result.errors)} — deferring restart`);
      frozenSdkMcpFingerprint = '';
      scheduleDeferredRestart('mcp');
      schedulePreWarm();
      return;
    }
    frozenSdkMcpFingerprint = newFingerprint;
    console.log(`[agent] SDK setMcpServers ok: added=[${result.added.join(',')}] removed=[${result.removed.join(',')}]`);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`[agent] SDK setMcpServers threw (${msg}); deferring restart so next pre-warm picks up new MCPs`);
    // Fallback path: an SDK restart will rebuild mcpServers from scratch.
    // Reset fingerprint so a future ensureSdkMcpInSync() retries the diff.
    frozenSdkMcpFingerprint = '';
    scheduleDeferredRestart('mcp');
    schedulePreWarm();
  }
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
          // SDK 0.3.142+ Task tools replaced TodoWrite — same bookkeeping nature,
          // no host side effects, so auto-approve like TodoWrite did.
          'TaskCreate', 'TaskUpdate', 'TaskGet', 'TaskList',
          'Skill'                                  // Skills - auto-approve skill invocations
        ],
        deniedTools: [],
        // Bash, Task (sub-agent launcher), WebFetch, WebSearch, mcp__* → need confirmation
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
//
// No wall-clock timeout — matches Claude Code (the CLI reference) which never
// times out user-facing prompts. The user's mental model is "AI is waiting for
// me," so the modal must survive arbitrary AFK time. Cleanup happens on the
// real boundaries: SDK abort signal (onAbort handler), session reset/switch/
// fork (clearSessionPermissions), or sidecar process exit. The 10-minute
// hard timeout was removed in v0.2.14 — its only original purpose (PRD #131
// "Unknown request" desync) is already covered by the abort-driven `:expired`
// broadcast.
const pendingPermissions = new Map<string, {
  resolve: (decision: 'allow' | 'deny') => void;
  toolName: string;
  input: unknown;
}>();

// AskUserQuestion types - import from shared
import type { AskUserQuestionInput, AskUserQuestion } from '../shared/types/askUserQuestion';
import { withQuestionTextAnswerKeys } from '../shared/types/askUserQuestion';
export type { AskUserQuestionInput, AskUserQuestion, AskUserQuestionOption } from '../shared/types/askUserQuestion';

// PlanMode types - import from shared
import type { ExitPlanModeAllowedPrompt } from '../shared/types/planMode';
export type { ExitPlanModeRequest, EnterPlanModeRequest, ExitPlanModeAllowedPrompt } from '../shared/types/planMode';

// Pending AskUserQuestion requests waiting for user response.
// See pendingPermissions comment — no wall-clock timeout (v0.2.14).
const pendingAskUserQuestions = new Map<string, {
  resolve: (answers: Record<string, string> | null) => void;
  input: AskUserQuestionInput;
}>();

// Pending ExitPlanMode requests waiting for user approval.
// See pendingPermissions comment — no wall-clock timeout (v0.2.14).
// `feedback` carries the user's optional 「修改意见」 — when present on a
// rejection, canUseTool sends it back to the model via deny.message so the
// AI can revise the plan in the same turn (issue #182).
type ExitPlanModeResolution = { approved: boolean; feedback?: string };
const pendingExitPlanMode = new Map<string, {
  resolve: (result: ExitPlanModeResolution) => void;
  plan?: string;
  allowedPrompts?: ExitPlanModeAllowedPrompt[];
}>();

// Pending EnterPlanMode requests waiting for user approval.
// See pendingPermissions comment — no wall-clock timeout (v0.2.14).
const pendingEnterPlanMode = new Map<string, {
  resolve: (approved: boolean) => void;
}>();

/**
 * True while the turn is blocked on a HUMAN response — a permission prompt,
 * AskUserQuestion, or plan-mode approval. The inactivity watchdog treats this
 * as a PAUSED state, not a hung turn: the user's think time is not turn
 * inactivity, and the SDK emits no events while it awaits the canUseTool
 * resolver. Without this, a >10-minute deliberation (e.g. the user steps away
 * mid-permission-prompt) false-fires the watchdog and aborts the turn right as,
 * or before, they answer — despite the comment claiming no wall-clock timeout.
 * (High-2, cross-review. The wake-lock added alongside the suspension-aware
 * watchdog only stops the machine SLEEPING during interactive turns; it does
 * not stop the inactivity clock from counting the human wait.)
 */
function hasPendingInteractiveRequest(): boolean {
  return pendingPermissions.size > 0
    || pendingAskUserQuestions.size > 0
    || pendingExitPlanMode.size > 0
    || pendingEnterPlanMode.size > 0;
}

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

  // Wait for user response or abort. No wall-clock timeout — see the
  // pendingAskUserQuestions Map declaration for why.
  return new Promise((resolve, reject) => {
    const cleanup = () => {
      pendingAskUserQuestions.delete(requestId);
      signal?.removeEventListener('abort', onAbort);
    };

    const onAbort = () => {
      console.debug('[AskUserQuestion] Aborted by SDK signal');
      // PRD #131 — guard the broadcast: the abort listener is left
      // registered after handleAskUserQuestionResponse returns (no
      // removeEventListener on the response path), and SDK's deny+interrupt
      // fires the same canUseTool signal AFTER the user already
      // responded. Without the guard the resulting `:expired` broadcast
      // would clear a card the frontend was still rendering with the
      // "submitted" state. Only broadcast when the entry is still pending.
      const wasPending = pendingAskUserQuestions.has(requestId);
      cleanup();
      if (wasPending) {
        broadcast('ask-user-question:expired', { requestId, reason: 'aborted' });
      }
      // Reject with AbortError so SDK's own abort handling creates the single tool_result.
      // Previously resolve(null) caused canUseTool to return deny → duplicate tool_result
      // (one from our deny, one from SDK's internal abort) → "tool_use ids must be unique" on resume.
      reject(new DOMException('Aborted', 'AbortError'));
    };

    // Listen for SDK abort signal
    signal?.addEventListener('abort', onAbort);

    pendingAskUserQuestions.set(requestId, { resolve, input: questionInput });
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
 * Handle ExitPlanMode tool - AI submits a plan for user review.
 * Returns {approved, feedback?}: feedback is the user's optional rejection
 * comment, used by canUseTool to construct a deny message routed back to
 * the model so it can revise the plan in the same turn (issue #182).
 */
async function handleExitPlanMode(
  input: unknown,
  signal?: AbortSignal
): Promise<ExitPlanModeResolution> {
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

  // No wall-clock timeout — see pendingExitPlanMode Map declaration.
  return new Promise((resolve, reject) => {
    const cleanup = () => {
      pendingExitPlanMode.delete(requestId);
      signal?.removeEventListener('abort', onAbort);
    };

    const onAbort = () => {
      console.debug('[ExitPlanMode] Aborted by SDK signal');
      // Guard same as handleAskUserQuestion — see that comment.
      const wasPending = pendingExitPlanMode.has(requestId);
      cleanup();
      if (wasPending) {
        broadcast('exit-plan-mode:expired', { requestId, reason: 'aborted' });
      }
      reject(new DOMException('Aborted', 'AbortError'));
    };

    signal?.addEventListener('abort', onAbort);
    pendingExitPlanMode.set(requestId, { resolve, plan, allowedPrompts });
  });
}

/**
 * Handle user's ExitPlanMode response from frontend.
 * `feedback` is forwarded only on rejection (issue #182): when set, the
 * model receives it as the deny message and continues the same turn to
 * revise the plan; when empty, behavior matches the legacy reject path.
 */
export function handleExitPlanModeResponse(
  requestId: string,
  approved: boolean,
  feedback?: string,
): boolean {
  console.debug(`[ExitPlanMode] handleResponse: requestId=${requestId}, approved=${approved}, hasFeedback=${!!feedback}`);
  const pending = pendingExitPlanMode.get(requestId);
  if (!pending) {
    console.warn(`[ExitPlanMode] Unknown request: ${requestId}`);
    return false;
  }
  pendingExitPlanMode.delete(requestId);
  // Restore currentPermissionMode so applySessionConfig won't override SDK's internal state
  if (approved && prePlanPermissionMode) {
    currentPermissionMode = prePlanPermissionMode;
    prePlanPermissionMode = null;
    console.debug(`[ExitPlanMode] Restored currentPermissionMode to: ${currentPermissionMode}`);
    // Notify frontend that mode changed (plan → auto/custom/etc.)
    broadcast('chat:permission-mode-changed', { permissionMode: currentPermissionMode });
  }
  const trimmed = feedback?.trim();
  pending.resolve({ approved, feedback: !approved && trimmed ? trimmed : undefined });
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

  // No wall-clock timeout — see pendingEnterPlanMode Map declaration.
  return new Promise((resolve, reject) => {
    const cleanup = () => {
      pendingEnterPlanMode.delete(requestId);
      signal?.removeEventListener('abort', onAbort);
    };

    const onAbort = () => {
      console.debug('[EnterPlanMode] Aborted by SDK signal');
      // Guard same as handleAskUserQuestion — see that comment.
      const wasPending = pendingEnterPlanMode.has(requestId);
      cleanup();
      if (wasPending) {
        broadcast('enter-plan-mode:expired', { requestId, reason: 'aborted' });
      }
      reject(new DOMException('Aborted', 'AbortError'));
    };

    signal?.addEventListener('abort', onAbort);
    pendingEnterPlanMode.set(requestId, { resolve });
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

  // Forward to IM event bus (subscribers route per-requestId for interactive approval cards)
  emitImEvent('permission-request', JSON.stringify({ requestId, toolName, input: inputPreview }));

  // Wait for user response or abort. No wall-clock timeout — see the
  // pendingPermissions Map declaration for why.
  return new Promise((resolve, reject) => {
    const cleanup = () => {
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

    pendingPermissions.set(requestId, { resolve, toolName, input });
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
        pendingPermissions.delete(otherId);
        otherPending.resolve('allow');
      }
    }
  }

  return true;
}

/**
 * Drain every pending interactive request map.
 *
 * Why this exists (v0.2.14 — Codex review): once the per-entry 10-minute
 * timeout was removed, only two paths cleaned up pending entries — the
 * SDK abort signal (`onAbort` in each handler, broadcasts `:expired` and
 * rejects) and `clearSessionPermissions`. The SDK abort path covers
 * "session was cleanly torn down by interrupt()", but it does NOT cover:
 *   1. SDK subprocess crash / error before `signal.abort` fires
 *      (the runStreamingSession `finally` block runs this drain).
 *   2. UI-triggered `resetSession` that clears via `clearSessionPermissions`
 *      while the renderer still has history visible — `chat:init`'s
 *      `clearInteractiveState` is gated on `historyMessages.length === 0`
 *      (TabProvider.tsx:973), so a non-empty history would leave the modal
 *      painted with no backend entry to respond to → "Unknown request"
 *      desync (PRD #131).
 *
 * Mirrors `external-session.ts::drainPendingInteractiveRequestsAsExpired`.
 * For Ask/ExitPlan/EnterPlan we broadcast the matching `:expired` event so
 * the frontend modal clears even when the chat:init guard skips the
 * unconditional clear. For permission requests we skip the broadcast —
 * there is no `permission:expired` channel; pendingPermission is cleared
 * via the chat:init / clearInteractiveState path on SSE reconnect, and
 * adding a new SSE event type just for cross-coverage is out of scope.
 *
 * `reason` is forwarded into the `:expired` payload so future telemetry /
 * UX messaging can distinguish reset-driven vs crash-driven expiry. The
 * frontend currently ignores it.
 */
function drainPendingInteractiveRequests(reason: 'reset' | 'session-end'): void {
  // Permission: resolve with 'deny' so any awaiting tool call surfaces as
  // denied. No `:expired` broadcast (see helper docstring).
  for (const [, p] of pendingPermissions) {
    try { p.resolve('deny'); } catch { /* swallow — never propagate from cleanup */ }
  }
  pendingPermissions.clear();

  // Ask-user-question: broadcast :expired then resolve(null). Order matters
  // only for tests — the tool turn is going away regardless.
  for (const [requestId, q] of pendingAskUserQuestions) {
    try { broadcast('ask-user-question:expired', { requestId, reason }); } catch { /* swallow */ }
    try { q.resolve(null); } catch { /* swallow */ }
  }
  pendingAskUserQuestions.clear();

  // Plan-mode entries resolve with `{approved: false}` (request was not approved).
  for (const [requestId, p] of pendingExitPlanMode) {
    try { broadcast('exit-plan-mode:expired', { requestId, reason }); } catch { /* swallow */ }
    try { p.resolve({ approved: false }); } catch { /* swallow */ }
  }
  pendingExitPlanMode.clear();

  for (const [requestId, p] of pendingEnterPlanMode) {
    try { broadcast('enter-plan-mode:expired', { requestId, reason }); } catch { /* swallow */ }
    try { p.resolve(false); } catch { /* swallow */ }
  }
  pendingEnterPlanMode.clear();
}

/**
 * Clear session permission state on user-initiated session reset.
 *
 * Only call site: `resetSession()` (this file, ~L5298). Fork / switch /
 * rewind paths rely on `abortPersistentSession()` → SDK `interrupt()` →
 * canUseTool `signal.abort` → per-handler `onAbort` cleanup, which is the
 * canonical SDK-driven teardown path. (CC review noted the prior JSDoc's
 * "switch/fork/rewind" claim was untrue.)
 */
export function clearSessionPermissions(): void {
  drainPendingInteractiveRequests('reset');
  sessionAlwaysAllowed.clear();
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
 * Persist messages to SessionStore for session recovery.
 *
 * Pattern 3 §3.2.4 — incremental contract. The legacy implementation mapped the
 * entire `messages` array on every turn (O(history) per turn). We now only map
 * the new tail: `messages.slice(lastPersistedIndex)`. SessionStore's
 * `saveSessionMessages` is given the *full* logical array shape it expects by
 * passing `[ ...alreadyPersisted (placeholders), ...newTail ]`? No — that would
 * defeat the purpose. Instead we leverage the contract that
 * `saveSessionMessages` already only appends the new tail (it slices internally
 * by file line count). So we map only the tail and pass it along with a
 * synthesised "head spacer" length — or, simpler, we pass the full array to
 * `saveSessionMessages` (so its rewind-detection still works), but build it as
 * a sparse mapping where the head is reused from a cache.
 *
 * Implementation choice: keep it simple — only map the tail; for the head we
 * skip rebuilding the SessionMessage objects entirely and rely on
 * `saveSessionMessages` slicing by `existingCount`. We pass `messages.length`
 * total objects but the head ones are *not* deeply remapped each turn — they
 * are cached in `persistedTailCache` and reused.
 *
 * Cursor advances on success. Rewind / fork / session-reset paths reset the
 * cursor to 0 so a full remap runs the next time.
 *
 * @param lastAssistantUsage - Usage info for the last assistant message (on message complete)
 * @param lastAssistantToolCount - Tool count for the last assistant message
 * @param lastAssistantDurationMs - Duration for the last assistant response
 */
const persistedSessionMessageCache: SessionMessage[] = [];

// Pattern 3 §3.2.4 — fix #2 (reentrance). The four fire-and-forget callsites
// in handleMessageComplete / handleMessageStopped / handleMessageError used to
// fire `void persistMessagesToStorage()` independently. Two overlapping
// invocations would each snapshot `lastPersistedIndex`, both await
// `saveSessionMessages` serially, and the second would write a stale cursor —
// double-counting head or losing tail. We serialize per-session via an
// in-flight chain map (keyed by sessionId at call time so that a forkSession
// or fresh-session swap doesn't replay onto the wrong key).
const persistChainBySession = new Map<string, Promise<void>>();

function schedulePersist(
  lastAssistantUsage?: MessageUsage,
  lastAssistantToolCount?: number,
  lastAssistantDurationMs?: number
): Promise<void> {
  const key = sessionId;
  const prev = persistChainBySession.get(key) ?? Promise.resolve();
  const next = prev.then(() => doPersistMessagesToStorage(
    lastAssistantUsage,
    lastAssistantToolCount,
    lastAssistantDurationMs,
  )).catch(err => {
    console.warn('[agent-session] persist failed:', err);
  });
  persistChainBySession.set(key, next);
  // Best-effort cleanup once the tail settles — only delete if we are still
  // the tail (another schedulePersist may have pushed onto the chain since).
  void next.then(() => {
    if (persistChainBySession.get(key) === next) {
      persistChainBySession.delete(key);
    }
  });
  return next;
}

async function persistMessagesToStorage(
  lastAssistantUsage?: MessageUsage,
  lastAssistantToolCount?: number,
  lastAssistantDurationMs?: number
): Promise<void> {
  // Top-level entry — go through the per-session serializer so concurrent
  // callers don't interleave their cursor writes.
  return schedulePersist(lastAssistantUsage, lastAssistantToolCount, lastAssistantDurationMs);
}

async function doPersistMessagesToStorage(
  lastAssistantUsage?: MessageUsage,
  lastAssistantToolCount?: number,
  lastAssistantDurationMs?: number
): Promise<void> {
  // Defensive: if the cursor is somehow > messages.length on entry (rewind
  // race, fork side-effect), log a warning and reset rather than silently
  // skipping the rest of the work.
  if (lastPersistedIndex > messages.length) {
    console.warn(`[agent-session] persist cursor (${lastPersistedIndex}) exceeds messages.length (${messages.length}); resetting`);
    lastPersistedIndex = 0;
    persistedSessionMessageCache.length = 0;
  }
  // Trim cache if it has grown past current message count (defensive).
  if (persistedSessionMessageCache.length > messages.length) {
    persistedSessionMessageCache.length = messages.length;
  }

  const tail = messages.slice(lastPersistedIndex);
  const tailMapped: SessionMessage[] = tail.map((msg, i) => {
    const absoluteIndex = lastPersistedIndex + i;
    const isLastAssistant = absoluteIndex === messages.length - 1 && msg.role === 'assistant';
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
        path: att.relativePath ?? '',
      })),
      metadata: msg.metadata,
      usage: isLastAssistant && lastAssistantUsage ? lastAssistantUsage : undefined,
      toolCount: isLastAssistant && lastAssistantToolCount ? lastAssistantToolCount : undefined,
      durationMs: isLastAssistant && lastAssistantDurationMs ? lastAssistantDurationMs : undefined,
    };
  });

  // Stitch cached head + freshly-mapped tail. Cache holds previously-persisted
  // SessionMessage objects so we don't pay map cost on them every turn.
  // Attach last-assistant usage info onto the cached entry too if the SDK
  // delivered usage on the trailing assistant of a *prior* turn (rare, but
  // defensive — saveSessionMessages reads only the tail anyway).
  const sessionMessages: SessionMessage[] = persistedSessionMessageCache
    .slice(0, lastPersistedIndex)
    .concat(tailMapped);

  await saveSessionMessages(sessionId, sessionMessages);

  // Commit the new tail into the cache and bump the cursor.
  persistedSessionMessageCache.length = lastPersistedIndex; // ensure size matches cursor
  for (const m of tailMapped) {
    persistedSessionMessageCache.push(m);
  }
  lastPersistedIndex = messages.length;
  const { found: foundRealUserMessage, preview: lastMessagePreview } =
    resolveLastRealUserMessagePreview(sessionMessages);
  // Only update lastActiveAt if a real user message exists (not just system injections).
  // This prevents heartbeat/memory-update from making stale sessions appear "active".
  await updateSessionMetadata(sessionId, {
    ...(foundRealUserMessage ? { lastActiveAt: new Date().toISOString() } : {}),
    lastMessagePreview,
  });
}

export function getSessionId(): string {
  return sessionId;
}

function createMetadataForSessionId(
  targetSessionId: string,
  title: string,
  scenario: SessionMaterializationScenario,
) {
  const agent = findAgentByWorkspacePath(agentDir) as AgentConfig | undefined;
  const meta = createMaterializedSessionMetadata({
    agentDir,
    sessionId: targetSessionId,
    scenario,
    agent,
    fallbackRuntime: getCurrentRuntimeType(),
    title,
  });
  return {
    meta,
    snapshotKind: agent ? (isLiveFollowScenario(scenario) ? 'im' : 'owned') : `runtime:${meta.runtime ?? 'none'}`,
  };
}

export async function materializeCurrentSessionMetadataForPublishedReset(): Promise<void> {
  const targetSessionId = sessionId;
  if (!targetSessionId || getSessionMetadata(targetSessionId)) {
    return;
  }
  const { meta, snapshotKind } = createMetadataForSessionId(
    targetSessionId,
    'New Chat',
    'agent-channel',
  );
  await saveSessionMetadata(meta);
  console.log(`[agent] session ${targetSessionId} persisted to SessionStore (published reset, snapshot=${snapshotKind})`);
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

// Pattern B — `setImStreamCallback` removed. Callers in /api/im/chat now
// `imEventBus.subscribe(currentSeq, cb)` directly and filter by requestId.
// Pattern C will replace the entire /api/im/chat protocol with /api/im/enqueue
// + /api/im/events long-poll, at which point even the subscription site moves
// out of agent-session.ts.

function resetAbortFlag(): void {
  shouldAbortSession = false;
}

/**
 * Resolve the Claude Code native binary spawned by the SDK subprocess.
 *
 * SDK 0.2.113+ distributes a single-file `claude` binary (bun build --compile)
 * via per-platform optional packages, replacing the bundled `cli.js` model.
 * The binary self-executes (no external JS runtime required).
 *
 * Resolution order:
 *   1. App bundle: `<resources>/claude-agent-sdk/claude[.exe]`
 *      (build scripts copy from node_modules/@anthropic-ai/claude-agent-sdk-{triple}/claude)
 *   2. node_modules: per-platform optional package installed by npm
 *      (`@anthropic-ai/claude-agent-sdk-<triple>/claude[.exe]`)
 */
export function resolveClaudeCodeCli(): string {
  const t0 = Date.now();
  const ext = process.platform === 'win32' ? '.exe' : '';
  const triple = getPlatformTriple();

  // 1. Production: bundled native binary under resources/claude-agent-sdk/
  //    (Legacy directory name preserved from cli.js era; only contents changed.)
  const cwd = process.cwd();
  const bundledNative = join(cwd, 'claude-agent-sdk', `claude${ext}`);
  if (existsSync(bundledNative)) {
    console.log(`[sdk] Claude native binary resolved via bundled path in ${Date.now() - t0}ms: ${bundledNative}`);
    return bundledNative;
  }

  // 2. Development / fallback: locate per-platform optional package in node_modules
  try {
    const platformPkg = `@anthropic-ai/claude-agent-sdk-${triple}`;
    const manifestPath = requireModule.resolve(`${platformPkg}/package.json`);
    const candidate = join(dirname(manifestPath), `claude${ext}`);
    if (existsSync(candidate)) {
      console.log(`[sdk] Claude native binary resolved via node_modules in ${Date.now() - t0}ms: ${candidate}`);
      return candidate;
    }
    throw new Error(`Binary missing at ${candidate} (package dir exists but claude executable is absent)`);
  } catch (error) {
    console.error(
      `[sdk] Claude native binary resolve FAILED in ${Date.now() - t0}ms. ` +
        `Bundled: ${bundledNative}, triple: ${triple}. ` +
        `Run \`npm install\` to restore optional platform package.`,
      error,
    );
    throw error;
  }
}

/**
 * Compute the SDK platform triple matching `@anthropic-ai/claude-agent-sdk-<triple>` package names.
 * On Linux, distinguishes glibc (default) from musl (Alpine et al.) via process.report.
 */
function getPlatformTriple(): string {
  const { platform, arch } = process;
  if (platform === 'darwin') return arch === 'arm64' ? 'darwin-arm64' : 'darwin-x64';
  if (platform === 'win32') return arch === 'arm64' ? 'win32-arm64' : 'win32-x64';
  if (platform === 'linux') {
    const report = process.report?.getReport?.() as { header?: { glibcVersionRuntime?: string } } | undefined;
    const isMusl = !report?.header?.glibcVersionRuntime;
    const base = arch === 'arm64' ? 'linux-arm64' : 'linux-x64';
    return isMusl ? `${base}-musl` : base;
  }
  throw new Error(`Unsupported platform for Claude Agent SDK: ${platform}-${arch}`);
}

/**
 * Build environment for Claude session
 * @param providerEnv - Optional provider environment override (for verification or external calls)
 */
/**
 * Auth env vars that the Claude Code CLI / SDK native binary reads at startup.
 * Any one of these left unset (after `{...process.env}` spread + our provider
 * branches) becomes a hole that the SDK's "fall back to whatever I find" path
 * can fill from a stale source — typically a `.env.example`-style placeholder
 * `ANTHROPIC_API_KEY=sk-ant-your-anthropic-key-here` that an AI helpfully
 * copied into the workspace. The polluted value reaches the SDK auth layer
 * and surfaces as "Not logged in · Please run /login".
 *
 * Fix: after all provider branches run, any var in this list that's still
 * absent gets sealed to an empty string. Verified by reading claude-code
 * source (utils/auth.ts, utils/authFileDescriptor.ts, services/api/filesApi.ts)
 * — every check is a JS truthy test (`if (process.env.X)` or
 * `process.env.X || fallback`), so empty string is semantically identical to
 * unset for the SDK's purposes: OAuth keychain fallback, apiKeyHelper, and
 * Bedrock/Vertex paths all continue to work.
 *
 * v0.2.0 status: under bundled Node + native-binary SDK we no longer have a
 * runtime that auto-loads `.env` from cwd, so the active pollution vector is
 * gone. The seal stays as defense-in-depth: cheap (a handful of `in` checks),
 * documents the auth-env contract, and protects against future SDK runtimes
 * (or shell wrappers) that might re-introduce auto-dotenv behavior.
 *
 * NOT included: CLAUDE_CONFIG_DIR — claude-code/src/utils/envUtils.ts:10 reads
 * it with `??` (nullish coalescing), so an empty string would fall through as
 * "" (not as the homedir fallback) and break the keychain service-name hash.
 */
const CC_AUTH_ENV_VARS_TO_SEAL = [
  'ANTHROPIC_API_KEY',
  'ANTHROPIC_AUTH_TOKEN',
  'ANTHROPIC_BASE_URL',
  'CLAUDE_CODE_OAUTH_TOKEN',
  'CLAUDE_CODE_OAUTH_TOKEN_FILE_DESCRIPTOR',
] as const;

/**
 * Seal SDK auth env vars against environment-pollution sources (legacy Bun
 * auto-dotenv, future shell wrappers, anything that might fill an absent var
 * with a stale value). Only fills empty strings for vars currently ABSENT
 * from env — preserves any real value we or the parent shell explicitly
 * set. See `CC_AUTH_ENV_VARS_TO_SEAL` above for the full rationale.
 */
function sealCcAuthEnv(env: NodeJS.ProcessEnv): void {
  for (const key of CC_AUTH_ENV_VARS_TO_SEAL) {
    if (!(key in env)) {
      env[key] = '';
    }
  }
}

/**
 * Build the env map passed to the Claude Agent SDK subprocess.
 *
 * @param providerEnv  Override the active session's provider. Used by
 *   one-shot callers (provider-verify, title-generator) that spawn an SDK
 *   subprocess against a DIFFERENT provider than the Tab's active session.
 * @param modelOverride  Override `currentModel` for the autocompact-window
 *   lookup. MUST be provided whenever `providerEnv` overrides the session
 *   provider; otherwise `currentModel` (which reflects the Tab's active
 *   session, not the one we're building env for) would inject the wrong
 *   cap into the verify/title subprocess. Safe to omit when this is a
 *   regular session spawn where `currentModel` is already correct.
 * @param opts.bridgeToken  PRD #124: bridge registry token for this
 *   subprocess. When the resolved provider is OpenAI-protocol, the
 *   subprocess's `ANTHROPIC_BASE_URL` includes this token in the path
 *   (`/bridge/<token>`) so the bridge handler routes to ITS upstream and
 *   not the active session's. Caller MUST register the token in
 *   `bridge-registry` before invoking this, and unregister on
 *   subprocess exit. For the active-session path, this is handled in
 *   `startStreamingSession`; for one-shot calls, use `startOneShotBridge`.
 *   When omitted and the provider is OpenAI-protocol, this is a logic
 *   error — the function throws.
 */
export function buildClaudeSessionEnv(
  providerEnv?: ProviderEnv,
  modelOverride?: string,
  opts?: { bridgeToken?: string },
): NodeJS.ProcessEnv {
  // Ensure essential paths are always present, even when launched from Finder
  // (Finder launches via launchd which doesn't inherit shell environment variables)
  const { home } = getCrossPlatformEnv();
  const isDebug = process.env.DEBUG === '1' || process.env.NODE_ENV === 'development';

  // Cross-platform PATH separator
  const PATH_SEP = process.platform === 'win32' ? ';' : ':';
  const PATH_KEY = process.platform === 'win32' ? 'Path' : 'PATH';

  // Detect bundled Node.js directory using shared utility from runtime.ts
  const isWindows = process.platform === 'win32';
  const bundledNodeDir = getBundledNodeDir();
  const myAgentsNpmGlobalPrefix = getMyAgentsNpmGlobalPrefix(home);
  const myAgentsNpmGlobalBinDir = getMyAgentsNpmGlobalBinDir(home);

  // Windows directory env vars — hoisted for reuse across essentialPaths + git-bash detection
  const winProgramFiles = isWindows ? (process.env.PROGRAMFILES || 'C:\\Program Files') : '';
  const winProgramFilesX86 = isWindows ? (process.env['PROGRAMFILES(X86)'] || 'C:\\Program Files (x86)') : '';
  const winLocalAppData = isWindows ? (process.env.LOCALAPPDATA || '') : '';

  if (isDebug) {
    console.log('[env] Script directory:', getScriptDir());
    console.log(`[env] Bundled Node.js: ${bundledNodeDir || 'NOT FOUND'}`);
  }

  // Build essential paths based on platform.
  // v0.2.0+: bundled Bun removed; bundled Node.js is the only app-local JS runtime.
  const essentialPaths: string[] = [];

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

  // MyAgents-managed npm global bin dir. It stays on PATH so tools installed
  // by MyAgents-localized npm commands (see MYAGENTS_NPM_GLOBAL_PREFIX below)
  // are immediately invocable. This dir comes BEFORE `~/.myagents/bin` in
  // essentialPaths so:
  //   1. AI-installed tools (e.g. agent-browser) shadow any legacy
  //      `~/.myagents/bin/<name>` wrapper from older app versions —
  //      legacy wrappers naturally fall idle without explicit cleanup.
  //   2. Existing installs made by older MyAgents versions remain discoverable
  //      after we stopped leaking npm_config_prefix globally.
  if (myAgentsNpmGlobalBinDir) {
    essentialPaths.push(myAgentsNpmGlobalBinDir);
  }

  // MyAgents bin directory — user-facing commands (the `myagents` CLI itself).
  // Legacy `agent-browser` wrappers from older app versions may still live
  // here; they're shadowed by `npm-global/bin` above so no cleanup needed.
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
    console.log('[env] Bundled Node.js dir:', bundledNodeDir ? bundledNodeDir : 'NOT FOUND (system Node will be used)');
  }

  // Build base environment
  // Spread then explicitly set PATH to avoid duplicate PATH/Path keys on Windows
  // (spreading process.env into a plain object loses case-insensitivity)
  const env: NodeJS.ProcessEnv = { ...process.env };
  delete env.PATH;
  delete env.Path;
  env[PATH_KEY] = finalPath;

  // Expose the managed npm prefix for command-local use only. Do NOT set
  // npm_config_prefix / NPM_CONFIG_PREFIX / PREFIX on the whole SDK env:
  // interactive shells with nvm treat those vars as incompatible and print a
  // warning before every Bash/zsh tool run. Skills that need a predictable
  // global install target should use:
  //   npm_config_prefix="$MYAGENTS_NPM_GLOBAL_PREFIX" npm install -g <pkg>
  if (myAgentsNpmGlobalPrefix) {
    env.MYAGENTS_NPM_GLOBAL_PREFIX = myAgentsNpmGlobalPrefix;
    if (myAgentsNpmGlobalBinDir) {
      env.MYAGENTS_NPM_GLOBAL_BIN = myAgentsNpmGlobalBinDir;
    }
    scrubMyAgentsNpmPrefixEnv(env, myAgentsNpmGlobalPrefix);
  }
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
  // Declare MyAgents as the inference-routing host. Tells CC's `managedEnv` layer
  // (see claude-code/src/utils/managedEnv.ts withoutHostManagedProviderVars) to
  // strip the 26 provider-routing vars (ANTHROPIC_BASE_URL / ANTHROPIC_API_KEY /
  // ANTHROPIC_AUTH_TOKEN / ANTHROPIC_DEFAULT_*_MODEL / CLAUDE_CODE_USE_BEDROCK
  // etc.) out of ALL settings-sourced env — both ~/.claude.json.env and
  // ~/.claude/settings.json.env — before they're `Object.assign`'d into the
  // subprocess's process.env during applyConfigEnvironmentVariables().
  //
  // Effect: external tools like cc-switch / Claude Code Router that write those
  // vars into user settings cannot silently redirect MyAgents requests to a
  // third-party endpoint. `settingSources: ['project']` already excludes
  // settings.json from the merged-settings path, but getGlobalConfig().env
  // (~/.claude.json) is merged unconditionally — this flag closes that hole.
  //
  // Does NOT affect: Keychain OAuth lookup (subscription auth), env vars we pass
  // directly via options.env, parent-shell env vars inherited from our process.
  // Only settings-file-sourced provider vars are stripped.
  env.CLAUDE_CODE_PROVIDER_MANAGED_BY_HOST = '1';
  // DO NOT set CLAUDE_CONFIG_DIR here — it would change the Keychain service name
  // and break Anthropic subscription OAuth. User-level skills are synced as symlinks
  // into project .claude/skills/ by syncProjectUserConfig() instead.

  // agent-browser: no env injection needed. The CLI ships its own config
  // discovery (~/.agent-browser/config.json default path) and is installed
  // by the AI via the agent-browser skill on first use, not bundled here.
  // Earlier versions set AGENT_BROWSER_HOME on Windows to bypass a Rust
  // canonicalize() UNC path issue (vercel-labs/agent-browser#393); that
  // workaround required the bundled CLI path to derive HOME, and is now
  // upstream's responsibility.

  // Self-Config CLI: expose sidecar port so the `myagents` CLI can call back
  if (sidecarPort > 0) {
    env.MYAGENTS_PORT = String(sidecarPort);
  }

  // Windows: Set CLAUDE_CODE_GIT_BASH_PATH so SDK finds git-bash directly
  // without relying on which("git") in PATH (which may be stale after NSIS install).
  //
  // Validate any inherited value: a non-empty CLAUDE_CODE_GIT_BASH_PATH from
  // process.env may be a stale path from a prior Git install location persisted
  // in HKCU\Environment (or set by another tool). If we trusted it blindly the
  // SDK would try to spawn a non-existent bash.exe and the user would see
  // "未安装 Git for Windows" even when Git is correctly installed.
  //
  // SDK 0.2.111+ overlays the subprocess env as `{...process.env, ...env}`,
  // so a `delete env.X` would NOT unset the parent's stale inherited value
  // in the subprocess (same shape as the proxy-var sealing pattern below).
  // Always write the resolved path OR empty string — empty is treated as
  // "not set" and lets the SDK fall back to PATH lookup.
  if (isWindows) {
    const inheritedGitBash = process.env.CLAUDE_CODE_GIT_BASH_PATH;
    let resolvedGitBash = '';
    if (inheritedGitBash && existsSync(inheritedGitBash)) {
      resolvedGitBash = inheritedGitBash;
    } else {
      if (inheritedGitBash) {
        console.warn(
          `[env] Inherited CLAUDE_CODE_GIT_BASH_PATH points to a non-existent file (${inheritedGitBash}); ignoring and auto-detecting Git Bash.`,
        );
      }
      const gitBashCandidates = [
        resolve(winProgramFiles, 'Git', 'bin', 'bash.exe'),
        resolve(winProgramFilesX86, 'Git', 'bin', 'bash.exe'),
        ...(winLocalAppData ? [resolve(winLocalAppData, 'Programs', 'Git', 'bin', 'bash.exe')] : []),
      ];
      for (const candidate of gitBashCandidates) {
        if (existsSync(candidate)) {
          resolvedGitBash = candidate;
          break;
        }
      }
    }
    env.CLAUDE_CODE_GIT_BASH_PATH = resolvedGitBash;
  }

  // Use provided providerEnv or fall back to currentProviderEnv
  const effectiveProviderEnv = providerEnv ?? currentProviderEnv;

  // ── Model alias mapping for sub-agents (applies to ALL protocol paths) ──
  // SDK sub-agents use aliases like "sonnet"/"opus"/"haiku" which resolve to claude-* model IDs.
  // For third-party providers, set ANTHROPIC_DEFAULT_*_MODEL so the SDK resolves aliases
  // to provider-specific model IDs (e.g., "sonnet" → "deepseek-chat" instead of "claude-sonnet-4-6").
  // Hoisted above the OpenAI early return so both protocol paths benefit.
  const resolvedModel = modelOverride ?? currentModel;
  const aliases = resolveSessionModelAliases(effectiveProviderEnv?.modelAliases, resolvedModel);
  if (aliases) {
    // _MODEL is what SDK feeds into getContextWindowForModel(); for 1M-window
    // alias targets we MUST tag it with [1m] so the SDK takes the 1M path.
    // _MODEL_NAME stays clean — it's used as a display-label fallback in the
    // SDK /model picker (modelOptions.ts:85) and would surface the suffix to
    // users. SDK strips [1m] before the wire (normalizeModelStringForAPI),
    // so the upstream API never sees it.
    const sonnetWrapped = applyContextWindowSuffix(aliases.sonnet);
    const opusWrapped = applyContextWindowSuffix(aliases.opus);
    const haikuWrapped = applyContextWindowSuffix(aliases.haiku);
    if (aliases.sonnet) {
      env.ANTHROPIC_DEFAULT_SONNET_MODEL = sonnetWrapped!;
      env.ANTHROPIC_DEFAULT_SONNET_MODEL_NAME = aliases.sonnet;
    }
    if (aliases.opus) {
      env.ANTHROPIC_DEFAULT_OPUS_MODEL = opusWrapped!;
      env.ANTHROPIC_DEFAULT_OPUS_MODEL_NAME = aliases.opus;
    }
    if (aliases.haiku) {
      env.ANTHROPIC_DEFAULT_HAIKU_MODEL = haikuWrapped!;
      env.ANTHROPIC_DEFAULT_HAIKU_MODEL_NAME = aliases.haiku;
    }
    console.log(`[env] Model aliases set: sonnet=${sonnetWrapped ?? '(none)'}, opus=${opusWrapped ?? '(none)'}, haiku=${haikuWrapped ?? '(none)'}`);
  }

  // ── Auto-compact effective window ──
  // Claude Agent SDK's `getContextWindowForModel()` returns 200_000 as fallback
  // for any non-Anthropic model (MODEL_CONTEXT_WINDOW_DEFAULT; see
  // claude-code/src/utils/context.ts:97). For third-party models with smaller
  // native windows (DeepSeek-chat 128K, GLM-4.5-Air 128K, …) this puts the
  // autoCompactThreshold (~effectiveWindow − 13K) above the model's real limit
  // → upstream API errors with "context_length_exceeded" before SDK fires
  // compaction. SDK exposes `CLAUDE_CODE_AUTO_COMPACT_WINDOW` env which caps
  // the window via `Math.min(contextWindow, envCap)` (autoCompact.ts:40-46).
  //
  // We look the resolved model up in the flat custom+discovered+preset
  // registry (see utils/model-capabilities.ts). The resolution order prefers
  // `modelOverride` (one-shot callers that spawn against a different
  // provider/model) over `currentModel` (active Tab session state) — see the
  // function JSDoc for the rationale.
  //
  // `env` starts from `{ ...process.env }`, so any CLAUDE_CODE_AUTO_COMPACT_WINDOW
  // inherited from the user's shell / launch environment is already there. We
  // MUST either override it with our computed value OR explicitly delete it;
  // leaving the inherited value in place would silently cap subprocesses by
  // whatever the user had in their shell rc, with no visibility.
  //
  // Scope: the cap is subprocess-env-wide, so sub-agents invoked via the
  // model-alias map (`sonnet`/`opus`/`haiku` → different provider IDs) share
  // the same cap as the primary model. Acceptable for V1 since the failing
  // case (primary model hits its own 128K ceiling) is what this fixes;
  // sub-agents on a smaller window would be further over-capped, not
  // under-capped.
  const modelContextLength = lookupModelContextLength(resolvedModel);
  if (modelContextLength && modelContextLength > 0) {
    env.CLAUDE_CODE_AUTO_COMPACT_WINDOW = String(modelContextLength);
    console.log(`[env] CLAUDE_CODE_AUTO_COMPACT_WINDOW=${modelContextLength} (model=${resolvedModel ?? '(unknown)'})`);
  } else {
    // Unknown / custom / missing-contextLength: clear any inherited value so
    // SDK's built-in default (MODEL_CONTEXT_WINDOW_DEFAULT=200K) applies,
    // exactly per product requirement #4. Logging only when a model is
    // actually set — empty currentModel at pre-warm is a normal startup state.
    delete env.CLAUDE_CODE_AUTO_COMPACT_WINDOW;
    if (resolvedModel) {
      console.log(`[env] No contextLength found for model=${resolvedModel} — SDK default 200K applies`);
    }
  }

  // OpenAI Bridge: if provider uses OpenAI protocol, loopback to sidecar
  // PRD #124: per-subprocess token in URL path. Each SDK subprocess
  // (active session, verify, title-gen, sub-agent) registers under a
  // unique token in `bridge-registry`; the URL path lets the route
  // handler look up that subprocess's specific upstream without any
  // shared global state. No more `currentOpenAiBridgeConfig` mutation.
  if (effectiveProviderEnv?.apiProtocol === 'openai' && sidecarPort > 0) {
    const bridgeToken = opts?.bridgeToken;
    if (!bridgeToken) {
      // This is a programming error: caller built env for an OpenAI-protocol
      // provider without first registering a bridge token. The SDK subprocess
      // would send /v1/messages to a path with no /bridge/<token> prefix and
      // get 404. Fail loud here so the bug is obvious at the right call site.
      throw new Error(
        'buildClaudeSessionEnv: OpenAI-protocol provider requires a bridgeToken. ' +
        'Use startOneShotBridge() (one-shot) or rely on startStreamingSession ' +
        'to register the active session token before calling this.'
      );
    }
    // SDK requests go to sidecar's /bridge/<token>/v1/messages route, which
    // translates to OpenAI format and forwards to the per-token upstream.
    env.ANTHROPIC_BASE_URL = `http://127.0.0.1:${sidecarPort}/bridge/${bridgeToken}`;
    env.ANTHROPIC_API_KEY = effectiveProviderEnv.apiKey ?? '';
    delete env.ANTHROPIC_AUTH_TOKEN;
    // CRITICAL: Strip proxy env vars from subprocess environment.
    // The Claude Code CLI's MA6() unconditionally sets fetchOptions.proxy for the Anthropic
    // SDK client when any proxy env var is present, WITHOUT checking no_proxy. This causes
    // the loopback request to http://127.0.0.1:{port} to be routed through the system proxy,
    // resulting in timeout/502 errors. The subprocess only needs to talk to our local bridge;
    // the bridge handler itself handles upstream proxy if needed (via process.env).
    //
    // NOTE: SDK env semantics — verified against installed sdk-0.2.119 sdk.mjs
    // (kK function): `k6 = o6 ? {...o6} : {...process.env}`, i.e. REPLACE, not
    // overlay. So in principle `delete env[proxyVar]` already prevents the var
    // from reaching the subprocess. We still convert deletes into explicit
    // empty strings as defense-in-depth: the CLI's proxy-from-env lookup
    // (`process.env[k] || ""`) treats empty string as "not set", and any
    // future SDK that flips back to overlay semantics keeps working without
    // a rev here. Same sealing pattern as sealCcAuthEnv() above.
    for (const proxyVar of [
      'http_proxy', 'HTTP_PROXY', 'https_proxy', 'HTTPS_PROXY',
      'ALL_PROXY', 'all_proxy', 'no_proxy', 'NO_PROXY',
    ]) {
      env[proxyVar] = '';
    }
    console.log(`[env] OpenAI bridge: ANTHROPIC_BASE_URL → loopback :${sidecarPort}/bridge/${bridgeToken.slice(0, 8)}…, upstream → ${effectiveProviderEnv.baseUrl}, proxy vars stripped`);
    // Seal any auth var not explicitly set above (e.g. ANTHROPIC_AUTH_TOKEN
    // was deleted, CLAUDE_CODE_OAUTH_TOKEN was never touched) to an empty
    // string. Defense-in-depth against stale `.env` placeholders surfacing
    // as "Not logged in · Please run /login" — see CC_AUTH_ENV_VARS_TO_SEAL
    // above for full rationale.
    sealCcAuthEnv(env);
    return env;
  }

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
    // the SDK falls through to keychain OAuth. `sealCcAuthEnv(env)` below
    // converts the deletes into explicit empty strings — defense-in-depth
    // against any spawning runtime that auto-loads `.env` from cwd and would
    // otherwise refill the keys from a placeholder template.
    delete env.ANTHROPIC_AUTH_TOKEN;
    delete env.ANTHROPIC_API_KEY;
    console.log('[env] ANTHROPIC_AUTH_TOKEN cleared (using default auth)');
  }

  // Seal CC auth env vars before handing the env off to the SDK subprocess
  // (defense-in-depth against `.env`-style pollution). Last-line-of-defense
  // for anything the branches above either deleted (subscription mode) or
  // never set at all (CLAUDE_CODE_OAUTH_TOKEN{,_FILE_DESCRIPTOR}). See
  // CC_AUTH_ENV_VARS_TO_SEAL above for the full rationale — the triggering
  // symptom was "Not logged in · Please run /login" after a user (or an AI
  // helping them) filled out a project's .env.example with placeholder
  // Anthropic credentials.
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
  // (v0.2.11 cross-bugfix) The previous `flushPendingMidTurnQueue()` call here
  // was a safety net that pushed pending user messages onto messages[] when
  // a new assistant block started mid-turn. With deferred yielding, the SDK
  // never sees pending mid-turn messages until the prior turn ends, so this
  // safety net would push a user message that the SDK isn't actually about
  // to respond to — which is exactly the misleading UI behaviour we removed.
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

  // PRD 0.2.18 Session Inbox — accumulate text for reply pushback if this turn
  // has an inbox binding. Capture before the message-append so we get the same
  // post-filter text that the model emitted.
  if (currentTurnInboxMeta) {
    currentTurnTextBlocks.push(chunk);
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
  // No mid-turn flush here: deferred-yield design means pending mid-turn
  // messages haven't been sent to SDK yet, so a thinking block starting now
  // is the prior turn's content — not a response to a queued message.
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
  // No mid-turn flush: see handleThinkingStart for rationale.
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
  // No mid-turn flush: see handleThinkingStart for rationale.
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

// Pattern 3 §3.2 / §D.3 — parsePartialJson throttle.
//
// `parsePartialJson` walks the entire accumulated string each call. For large
// Edit/Write tool args (multi-MB `new_string`) the legacy "parse on every
// delta" behaviour is O(n²). We now keep a per-tool cursor of the buffer size
// at the last successful parse, and only re-parse when the buffer has grown
// by `PARSE_PARTIAL_JSON_REPARSE_BYTES` or a content-block-stop forces a
// final parse (see `handleContentBlockStop` below — it always calls
// `parsePartialJson` / `JSON.parse` on the final accumulated string).
const PARSE_PARTIAL_JSON_REPARSE_BYTES = 16 * 1024; // 16 KiB
const lastParsedBytesByToolId = new Map<string, number>();
const lastParsedBytesBySubagentToolId = new Map<string, number>();

function handleToolInputDelta(_index: number, toolId: string, delta: string): void {
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
  // Throttle: only attempt parse when buffer has grown ≥16 KiB since last parse.
  const lastParsed = lastParsedBytesByToolId.get(toolId) ?? 0;
  if (newInputJson.length - lastParsed < PARSE_PARTIAL_JSON_REPARSE_BYTES) {
    return; // keep previous `parsedInput`; consumer sees the last successful value
  }
  const parsedInput = parsePartialJson<ToolInput>(newInputJson);
  if (parsedInput) {
    toolBlock.tool.parsedInput = parsedInput;
  }
  lastParsedBytesByToolId.set(toolId, newInputJson.length);
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
  const lastParsed = lastParsedBytesBySubagentToolId.get(toolId) ?? 0;
  if (newInputJson.length - lastParsed < PARSE_PARTIAL_JSON_REPARSE_BYTES) {
    return;
  }
  const parsedInput = parsePartialJson<ToolInput>(newInputJson);
  if (parsedInput) {
    subCall.parsedInput = parsedInput;
  }
  lastParsedBytesBySubagentToolId.set(toolId, newInputJson.length);
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
  // Pattern 3 §D.3 — terminal state; drop throttle cursor.
  lastParsedBytesBySubagentToolId.delete(toolId);
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
    // Pattern 3 §D.3 — block has reached terminal state, drop the throttle
    // cursor so a future tool with a recycled id starts fresh.
    if (toolId) lastParsedBytesByToolId.delete(toolId);
  }
}

function handleToolResultStart(
  toolUseId: string,
  content: string,
  isError: boolean,
  attachments?: ToolAttachment[],
): void {
  if (handleSubagentToolResultStart(toolUseId, content, isError)) {
    return;
  }
  setToolResult(toolUseId, content, isError, attachments);
}

function handleToolResultComplete(
  toolUseId: string,
  content: string,
  isError?: boolean,
  attachments?: ToolAttachment[],
): void {
  if (handleSubagentToolResultComplete(toolUseId, content, isError)) {
    return;
  }
  setToolResult(toolUseId, content, isError, attachments);
}

function handleMessageComplete(): void {
  isStreamingMessage = false;
  // Capture before fallback potentially re-arms it, so the post-teardown
  // re-arm at the end of this function knows whether to do so.
  let queuedFallbackKeepStreaming = false;
  // (v0.2.12) Turn-end fallback for the lockstep yield.
  //
  // Two regimes the same `result` event covers:
  //   (a) Natural completion: queue:started fallback so a UI pill that
  //       was waiting on a never-fired mid-turn replay gets surfaced as
  //       "AI saw it" right at turn boundary.
  //   (b) Graceful interrupt (user pressed stop): the SDK fires `result`
  //       with terminal_reason='aborted_streaming' which still routes
  //       through handleMessageComplete. In this regime AI may not have
  //       seen the in-flight item; treating it as queue:started would
  //       show an unanswered user bubble in chat history. Drop it via
  //       queue:cancelled instead — UI honesty matches handleMessageStopped.
  //   (Codex review fix #2 v2)
  if (inFlightToCliId !== null) {
    const stale = inFlightToCliId;
    const meta = inFlightMetadata;
    // Issue #289 — a force-send ("立即发送") of THIS item must SURFACE it (the SDK drains +
    // processes it post-abort), unlike a plain stop which drops it. Capture before clearing.
    const forced = forceSurfaceInFlightId === stale;
    clearInFlightSlot();
    const inFlightAction = decideInFlightActionOnResult({
      isInterrupting: isInterruptingResponse,
      forced,
      hasMeta: !!meta,
    });
    if (inFlightAction === 'drop') {
      broadcast('queue:cancelled', { queueId: stale });
      console.log(`[agent] In-flight queue item ${stale} dropped at graceful interrupt result — broadcast queue:cancelled`);
    } else if (inFlightAction === 'surface' && meta) {
      // Issue #289 — a FORCE surface means the SDK is draining this item into a NEW turn;
      // tell interruptCurrentResponse() to skip its redundant trailing handleMessageStopped()
      // (which would undo the streaming re-arm below + double-pop the IM request → idle gap).
      // The natural turn-end fallback does NOT go through interruptCurrentResponse, so only
      // set it for the forced case.
      if (forced) forceDrainTurnStarting = true;
      const userMessage: MessageWire = {
        id: String(messageSequence++),
        role: 'user',
        content: meta.messageText,
        timestamp: new Date().toISOString(),
        attachments: meta.attachments,
        metadata: meta.source ? { source: meta.source } : undefined,
      };
      messages.push(userMessage);
      // PRD 0.2.14 — desktop → IM mirror (queue:started fallback path).
      if (meta.source === 'desktop') {
        fireDesktopUserMirror(meta.messageText, meta.mirrorImages);
      }
      console.log(`[agent] In-flight queue item ${stale} surfaced via queue:started (${forced ? 'force-send #289' : 'turn-end fallback, no mid-turn replay'})`);
      broadcast('queue:started', {
        queueId: stale,
        userMessage: {
          id: userMessage.id,
          role: userMessage.role,
          content: userMessage.content,
          timestamp: userMessage.timestamp,
          attachments: userMessage.attachments,
        },
      });
      // (v0.2.12 Codex review fix v3 #2) The fallback represents a brand-
      // new SDK turn starting inside CLI via drainCommandQueue. Mark
      // for a post-teardown re-arm of isStreamingMessage so isSessionBusy()
      // still gates new direct-sends through the queue path during the
      // gap before the new turn's first event reaches MyAgents.
      queuedFallbackKeepStreaming = true;
      // pendingRequestIds: queued item's requestId was pushed at yield
      // time and remains in the FIFO behind msg1's; popPendingRequest()
      // below pops msg1, leaving msg2 as new head — popped on its own
      // result. No push needed.
    }
  }
  // (v0.2.12 Codex review fix v2 #1) DEFER promote to next macrotask.
  //
  // handleMessageComplete is called from inside the SDK result handler.
  // After it returns, the result handler can synchronously decide to
  // resetSession() / setSessionModel() / hasDeferredRestart() — any of
  // those calls abortPersistentSession() which flips shouldAbortSession
  // and resolves the generator with null. If we promote synchronously,
  // we resolve messageResolver with our pending item BEFORE the abort
  // fires, leaving the item in generator's closure (already-resumed but
  // not yet yielded). abortPersistentSession's rescue can't see it
  // (rescuePendingToQueue only sees pendingMidTurnQueue, not generator's
  // local item) and the item lands on a dying SDK subprocess.
  //
  // setTimeout(0) lets the result-handler tail run first, including any
  // abort decision. If abort fired, promoteNextFromPending observes
  // shouldAbortSession=true and skips — pending stays put OR has been
  // moved to messageQueue by rescuePendingToQueue. Either way preserved.
  setTimeout(() => promoteNextFromPending(), 0);
  // Pattern 1 follow-up: turn finished cleanly — drop the registration
  // without aborting. The next turn will register a fresh controller.
  if (sessionId) endTurnAbort(sessionId);
  // Pattern 6: turn finished — drop the ambient turnId so subsequent logs
  // (idle / pre-warm / next turn) don't inherit the stale id.
  // Cross-owner fix: scope by sessionId so we only clear OUR slot.
  clearAmbientLogContextField(sessionId, 'turnId');
  // Pattern B/C/G: turn complete → emit 'complete' for the head request, then
  // pop it. Subsequent turns (mid-turn injected) advance to the next head.
  emitImEvent('complete', '');
  const completedReq = popPendingRequest();
  if (completedReq) {
    imRequestRegistry.setStatus(completedReq, 'completed');
    imRequestRegistry.unregister(completedReq);
  }
  // PRD 0.2.14 — desktop turn ended; release mirror state so the next
  // (possibly IM-driven) turn doesn't accidentally mirror through here.
  clearMirrorState();
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
  // (v0.2.11 cross-bugfix #142 review-fix #4) Also gate on pendingMidTurnQueue.length
  // so waitForSessionIdle() doesn't claim idle while a deferred mid-turn message is
  // about to be promoted into the next turn.
  if (messageQueue.length === 0 && pendingMidTurnQueue.length === 0) {
    setSessionState('idle');
  }

  // Calculate duration for this turn
  const durationMs = currentTurnStartTime ? Date.now() - currentTurnStartTime : undefined;

  // Persist messages with usage info after AI response completes.
  // Fire-and-forget: persistMessagesToStorage is async (cooperative file lock),
  // but the enclosing handler is a sync stream-event callback. Errors are already
  // swallowed inside SessionStore writers; surfacing them here would be no-op.
  persistMessagesAfterInFlightAttachmentSaves({
    inputTokens: currentTurnUsage.inputTokens,
    outputTokens: currentTurnUsage.outputTokens,
    cacheReadTokens: currentTurnUsage.cacheReadTokens || undefined,
    cacheCreationTokens: currentTurnUsage.cacheCreationTokens || undefined,
    model: currentTurnUsage.model,
    modelUsage: currentTurnUsage.modelUsage,
  }, currentTurnToolCount, durationMs);

  // (v0.2.12 Codex review fix v3 #2 follow-up) Re-arm streaming flag for
  // the queued fallback case AFTER all teardown has run, so endTurnAbort
  // / clearAmbientLogContextField don't undo what we set up. The new
  // turn driven by CLI's drainCommandQueue will re-emit a `result` of
  // its own; isStreamingMessage will flip back to false there.
  if (queuedFallbackKeepStreaming) {
    isStreamingMessage = true;
  }
}

function handleMessageStopped(): void {
  isStreamingMessage = false;
  // (v0.2.12 Codex review fix #2) On interrupt/abort the in-flight queue
  // item is dropped — broadcast queue:cancelled so the frontend can
  // clear the pill. See handleMessageComplete for the matching
  // graceful-interrupt branch.
  if (inFlightToCliId !== null) {
    const droppedQueueId = inFlightToCliId;
    clearInFlightSlot();
    broadcast('queue:cancelled', { queueId: droppedQueueId });
    console.log(`[agent] In-flight queue item ${droppedQueueId} dropped on stop — broadcast queue:cancelled`);
  }
  // Defer promote to next macrotask — abortPersistentSession may follow.
  setTimeout(() => promoteNextFromPending(), 0);
  // Pattern 1 follow-up: turn ended (interrupted). Drop the registration.
  // If interruptCurrentResponse drove the stop it already abort()ed the
  // controller; this endTurn is the idempotent cleanup of the slot.
  if (sessionId) endTurnAbort(sessionId);
  // Pattern 6: clear turnId on stop (mirror of handleMessageComplete).
  // Cross-owner fix: scope by sessionId so we only clear OUR slot.
  clearAmbientLogContextField(sessionId, 'turnId');
  // Pattern B/C/G: turn stopped → emit 'complete' for head + pop queue.
  emitImEvent('complete', '');
  const stoppedReq = popPendingRequest();
  if (stoppedReq) {
    imRequestRegistry.setStatus(stoppedReq, 'completed');
    imRequestRegistry.unregister(stoppedReq);
  }
  // PRD 0.2.14 — desktop turn stopped; release mirror state.
  clearMirrorState();
  // 跨回合状态清理（与 handleMessageComplete 保持一致）
  streamIndexToToolId.clear();
  streamIndexToBlockType.clear();
  toolResultIndexToId.clear();
  childToolToParent.clear();
  imTextBlockIndices.clear();
  clearCronTaskContext();


  // Only transition to idle if no queued messages waiting (same logic as handleMessageComplete).
  // (v0.2.11 cross-bugfix #142 review-fix #4) Includes pendingMidTurnQueue.
  if (messageQueue.length === 0 && pendingMidTurnQueue.length === 0) {
    setSessionState('idle');
  }
  const lastMessage = messages[messages.length - 1];
  if (!lastMessage || lastMessage.role !== 'assistant' || typeof lastMessage.content === 'string') {
    // Persist even if no assistant message (fire-and-forget — async lock).
    persistMessagesAfterInFlightAttachmentSaves();
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
  // Persist after processing message (fire-and-forget — async lock).
  persistMessagesAfterInFlightAttachmentSaves();
}

function handleMessageError(error: string): void {
  isStreamingMessage = false;
  // (v0.2.12 Codex review fix #2) Drop the in-flight item on error and
  // surface queue:cancelled — see handleMessageStopped for rationale.
  if (inFlightToCliId !== null) {
    const droppedQueueId = inFlightToCliId;
    clearInFlightSlot();
    broadcast('queue:cancelled', { queueId: droppedQueueId });
    console.log(`[agent] In-flight queue item ${droppedQueueId} dropped on error — broadcast queue:cancelled`);
  }
  // Defer promote to next macrotask — abortPersistentSession may follow.
  setTimeout(() => promoteNextFromPending(), 0);
  // Pattern 1 follow-up: turn ended due to error. Abort the turn signal so
  // any in-flight tool fetches release immediately rather than waiting on
  // their own per-call timeouts. Ignored if no turn is registered.
  if (sessionId) abortTurnAbort(sessionId, 'error');
  // Pattern 6: clear turnId on error too — turn is over either way.
  // Cross-owner fix: scope by sessionId so we only clear OUR slot.
  clearAmbientLogContextField(sessionId, 'turnId');
  // Pattern B/C/G: error → emit 'error' for head + pop queue.
  emitImEvent('error', localizeImError(error));
  const failedReq = popPendingRequest();
  if (failedReq) {
    imRequestRegistry.setStatus(failedReq, 'failed');
    imRequestRegistry.unregister(failedReq);
  }
  // PRD 0.2.14 — desktop turn errored out; release mirror state.
  clearMirrorState();
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
  // Persist error message (fire-and-forget — async lock).
  void persistMessagesToStorage().catch(err => console.error('[agent] persistMessagesToStorage failed:', err));
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

/** Sentinel value for attachment-only tool results (truthy, so ProcessRow sees tool as complete) */
const TOOL_ATTACHMENT_RESULT_SENTINEL = '[tool_result_attachment]';

/** Set of tool_use IDs whose results are stripped from frontend broadcast in the current turn */
const strippedToolResultIds = new Set<string>();

function mergeToolAttachments(
  existing: ToolAttachment[] | undefined,
  incoming: ToolAttachment[],
): ToolAttachment[] {
  if (incoming.length === 0) {
    return existing ?? [];
  }
  const merged = [...(existing ?? [])];
  for (const attachment of incoming) {
    const idx = merged.findIndex((candidate) => {
      if (attachment.pendingId && candidate.pendingId === attachment.pendingId) {
        return true;
      }
      return !!attachment.refPath && candidate.refPath === attachment.refPath;
    });
    if (idx >= 0) {
      merged[idx] = { ...merged[idx], ...attachment };
    } else {
      merged.push(attachment);
    }
  }
  return merged;
}

function applyToolAttachmentUpdate(
  toolUseId: string,
  pendingId: string,
  attachment: ToolAttachment,
): void {
  const toolBlock = findToolBlockById(toolUseId);
  if (!toolBlock) {
    return;
  }
  toolBlock.tool.attachments = mergeToolAttachments(
    toolBlock.tool.attachments,
    [{ ...attachment, pendingId }],
  );
}

function createToolAttachmentSaveContext(
  toolUseId: string,
  input: ExtractedToolResultAttachment,
  caption?: string,
): SaveContext {
  const toolName = findToolBlockById(toolUseId)?.tool.name;
  return {
    sessionId,
    // Builtin SDK tool results do not expose a stable turn item id here.
    // toolUseId is unique per turn and keeps the attachment endpoint stable.
    turnId: toolUseId,
    toolUseId,
    mimeType: input.mimeType,
    kind: input.kind,
    caption,
    producedBy: toolName ? `builtin.${toolName}` : 'builtin.tool_result',
  };
}

function scheduleBuiltinToolAttachmentSave(
  toolUseId: string,
  input: ExtractedToolResultAttachment,
  caption?: string,
): ToolAttachment {
  const ctx = createToolAttachmentSaveContext(toolUseId, input, caption);
  const { attachment, pendingId } = makePlaceholderAttachment(ctx);
  const tracked = (async (): Promise<void> => {
    try {
      const real = await saveToolAttachment(input.source, ctx);
      applyToolAttachmentUpdate(toolUseId, pendingId, real);
      broadcast('chat:tool-attachment-update', {
        toolUseId,
        pendingId,
        attachment: real,
      });
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      console.warn(`[agent] saveToolAttachment failed (toolUseId=${toolUseId}): ${reason}`);
      const failed = makeErrorAttachment(ctx, err, pendingId);
      applyToolAttachmentUpdate(toolUseId, pendingId, failed);
      broadcast('chat:tool-attachment-update', {
        toolUseId,
        pendingId,
        attachment: failed,
      });
    }
  })();
  trackInFlightSave(tracked);
  return attachment;
}

function prepareBuiltinToolResultPayload(
  toolUseId: string,
  rawContent: unknown,
  fallbackText?: string,
): { content: string; attachments: ToolAttachment[] } {
  const parts = extractToolResultRenderParts(rawContent);
  const content = parts.text || fallbackText || (parts.attachments.length > 0 ? TOOL_ATTACHMENT_RESULT_SENTINEL : '');
  const caption = parts.text || undefined;
  const attachments = parts.attachments.map((input) =>
    scheduleBuiltinToolAttachmentSave(toolUseId, input, caption)
  );
  return { content, attachments };
}

function persistMessagesAfterInFlightAttachmentSaves(
  usage?: MessageUsage,
  toolCount?: number,
  durationMs?: number,
): void {
  void (async () => {
    await awaitInFlightSaves();
    await persistMessagesToStorage(usage, toolCount, durationMs);
  })().catch(err => console.error('[agent] persistMessagesToStorage failed:', err));
}

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

function setToolResult(
  toolUseId: string,
  content: string,
  isError?: boolean,
  attachments?: ToolAttachment[],
): void {
  const toolBlock = findToolBlockById(toolUseId);
  if (!toolBlock) {
    return;
  }
  toolBlock.tool.result = content;
  if (typeof isError === 'boolean') {
    toolBlock.tool.isError = isError;
  }
  if (attachments && attachments.length > 0) {
    toolBlock.tool.attachments = mergeToolAttachments(toolBlock.tool.attachments, attachments);
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
  // Pattern 3 §3.2.4 — `messages` was just emptied; reset the persistence
  // cursor so the next persist run sees `slice(0) === []` and does not
  // mistakenly believe N messages have already been persisted. Drop the
  // cached SessionMessage objects too — they belong to a different session.
  lastPersistedIndex = 0;
  persistedSessionMessageCache.length = 0;
  // Pattern 3 §3.2.4 — fix #2 (reentrance). Drop the per-session persist
  // chain so a fresh session starts with no in-flight tail awaiting writes
  // that no longer match the cleared in-memory state.
  persistChainBySession.delete(sessionId);
  // Pattern 3 §D.3 — drop parsePartialJson throttle cursors so a recycled
  // toolId in a fresh session is not confused with the old buffer length.
  lastParsedBytesByToolId.clear();
  lastParsedBytesBySubagentToolId.clear();
  // Queue clearing is always explicit (broadcast queue:cancelled to the frontend).
  // Defensive: in practice, resetSession / switchToSession drain earlier (before
  // awaitSessionTermination); initializeAgent is typically called on an empty queue.
  drainQueueWithCancellation();
  // PRD 0.2.18 — same treatment as drainQueueWithCancellation: if any
  // pendingMidTurnQueue items carry inboxMeta.replyBack=true, push a reply
  // before drop. In normal flow rescuePendingToQueue (called by
  // abortPersistentSession) has already moved these into messageQueue and
  // drainQueueWithCancellation handled them — so this is a defensive cleanup
  // for paths that hit clearMessageState without going through abort first.
  for (const pending of pendingMidTurnQueue) {
    pushInboxAbortReplyForQueuedItem(pending.sourceItem, 'message_dropped_on_clear');
  }
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
  // Pattern B/G: drain the pending requestId queue — any in-flight bus
  // subscribers for the old session belong to closed SSE streams; new SDK
  // output for a new session should not be tagged with old trace IDs.
  clearPendingRequests();
  imEventBus.clear();
  // Pattern C: drop all registry entries (aborts in-flight controllers via clear()).
  imRequestRegistry.clear();
}

/**
 * 排空消息队列，逐条广播 queue:cancelled。**清 messageQueue 的唯一正路**。
 *
 * 设计契约（architectural invariant）：
 *   - 任何想清空 messageQueue 的地方都 MUST 走这个函数，禁止裸 `messageQueue.length = 0`
 *     或逐项 splice。裸清是前端 pills 残留的来源。
 *   - 频繁调用是幂等的（空队列 early-return），不必担心"多调一次"。
 *
 * 调用者：
 *   - interruptCurrentResponse（停止按钮 / 无活跃 turn 的孤儿清理）
 *   - resetSession / switchToSession / recoverFromStaleSession / rewindSession
 *     （session 重置路径）
 *   - enqueueUserMessage 的 Provider 切换分支（避免 phantom pills）
 *   - clearMessageState（防御：initializeAgent 等路径通常队列为空 → no-op）
 *   - startStreamingSession 的 finally safety net，仅当 preWarmDisabled 时
 *     （正常模式下队列跨 session 存活，由 schedulePreWarm 接管）
 *
 * 不调用者：
 *   - 正常 turn-complete 路径（队列由 generator 自然 drain）
 *   - abortPersistentSession（只转移 pending，不清 messageQueue；
 *     队列的清除由 abort 的上游调用者决定）
 */
function drainQueueWithCancellation(): void {
  if (messageQueue.length === 0) return;
  console.log(`[agent] Draining ${messageQueue.length} queued messages (explicit cancel)`);
  // PRD 0.2.18 — items carrying inboxMeta.replyBack=true are inbox messages
  // queued but never yielded. Drop them without telling the caller and they
  // hang forever (cross-review CC HIGH #3). Push a session_aborted reply
  // before resolving (fire-and-forget; we don't block teardown).
  for (const item of messageQueue) {
    pushInboxAbortReplyForQueuedItem(item, 'message_dropped_on_reset');
    item.resolve();
    broadcast('queue:cancelled', { queueId: item.id });
  }
  messageQueue.length = 0;
}

/** Push a session_aborted-style inbox reply for a queued item that will be
 *  dropped without ever running. Safe no-op when the item carries no inboxMeta
 *  or replyBack=false. */
function pushInboxAbortReplyForQueuedItem(
  item: { inboxMeta?: import('./inbox/types').InboxTurnMeta },
  code: 'message_dropped_on_reset' | 'message_dropped_on_clear',
): void {
  const meta = item.inboxMeta;
  if (!meta || !meta.replyBack) return;
  const sid = sessionId;
  void import('./inbox/reply-deliver').then(({ deliverInboxReply }) =>
    deliverInboxReply(sid, meta, {
      text: '',
      error: {
        code,
        message:
          code === 'message_dropped_on_reset'
            ? 'target session was reset before the message ran'
            : 'target session state was cleared before the message ran',
      },
    }),
  ).catch((err) =>
    console.error('[inbox] queued-drop reply pushback failed:', err),
  );
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
  // Pattern 3 §3.2.4 — these messages are already on disk; seed the persist
  // cursor + cache so the next persist run only maps the new tail (messages
  // produced after this load), not the entire restored history.
  lastPersistedIndex = messages.length;
  persistedSessionMessageCache.length = 0;
  for (const sm of storedMessages) {
    persistedSessionMessageCache.push(sm);
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

  // PRD 0.2.27 — capture the cold-reload window-B anchor NOW, from the durable persisted
  // tail (before any new direct-send user row is appended). Always assigned (value or
  // undefined) so it never carries a stale value from a prior load. Consumed by the next
  // startStreamingSession. See deriveReloadResumeAnchor + the `pendingReloadAnchor` decl.
  pendingReloadAnchor = deriveReloadResumeAnchor(messages, currentSessionUuids);

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
    // Explicit cancel — broadcasts queue:cancelled so frontend clears pills immediately.
    drainQueueWithCancellation();

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
    await persistMessagesToStorage();
  }

  // 1c. Pattern 2 §2.3.1 — release any spilled large-value refs tagged with
  // the old sessionId. Best-effort; fired-and-forget so resetSession isn't
  // delayed by ref I/O. The periodic GC also catches anything left behind.
  if (sessionId) {
    void import('./utils/large-value-store').then(({ clearSessionRefs }) =>
      clearSessionRefs(sessionId)
    ).catch(() => { /* swallow — best-effort cleanup */ });
  }

  // 2. Clear all message state (shared with initializeAgent)
  clearMessageState();

  // 3. Generate new session ID (don't persist yet - wait for first message)
  sessionId = randomUUID();
  hasInitialPrompt = false; // Reset so first message creates a new session in SessionStore

  // 4. Clear SDK resume state - CRITICAL: prevents SDK from resuming old context!
  sessionRegistered = false;
  pendingResumeSessionAt = undefined; // Prevent leaking rewind state to new session
  pendingReloadAnchor = undefined;   // PRD 0.2.27 — symmetric reset (don't leak reload anchor across sessions)
  messageResolver = null;
  systemInitInfo = null; // Clear old system info so new session gets fresh init
  sdkControlReady = false; // Subprocess gone — must re-confirm via initializationResult on next pre-warm

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
      // Explicit cancel — this recovery path preserves visible message history but
      // the queue is discarded. Without broadcast, queued pills would linger forever
      // (no chat:init follows this path — that's the whole point of stale recovery).
      drainQueueWithCancellation();
      await awaitSessionTermination(10_000, 'recoverFromStaleSession');
      querySession = null;
    }

    // 2. Disarm resume so the pre-warm / next query starts a fresh SDK
    //    conversation. effectiveSdkSessionId still resolves to the current
    //    sessionId (see startStreamingSession UUID path), so the session
    //    identity is preserved end-to-end.
    sessionRegistered = false;
    pendingResumeSessionAt = undefined;
    pendingReloadAnchor = undefined; // PRD 0.2.27 — symmetric reset

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
  sdkControlReady = false;

  // Memoize session metadata for the whole initialization pass. Previously this
  // function called getSessionMetadata(initialSessionId) three times (at resume
  // decision, message load, and MCP self-resolve); each call scans sessions.json
  // and a large JSONL can cost ~30-100ms. Read once, reuse.
  const initMeta = initialSessionId ? getSessionMetadata(initialSessionId) : null;

  if (initialSessionId) {
    // Use caller-specified session_id (IM / Tab opening existing session / CronTask)
    sessionId = initialSessionId as typeof sessionId;

    // Check if this session has any prior metadata → decide resume vs create.
    // We check for metadata existence (not just sdkSessionId) because sdkSessionId
    // is only written after system_init succeeds. If the previous Bun process crashed
    // before system_init, metadata exists (with unifiedSession:true) but sdkSessionId
    // is absent — yet the SDK session directory already exists on disk.
    const meta = initMeta;
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
  //
  // Note on the "two-sidecar ID collision" scenario (originally called Bug B):
  // that scenario would require a concurrent writer's disk flush to lag behind
  // its metadata stats. `saveSessionMessages` in SessionStore.ts writes the
  // JSONL via appendFileSync BEFORE it updates `stats.messageCount` under the
  // sessions-lock, so `diskCount === 0 && stats.messageCount > 0` is unreachable
  // through normal mutations. Bug A's rotate-per-tick fix additionally removes
  // the cron pathway that could have produced two concurrent sidecars for the
  // same session. A prior version of this file carried a defensive seed based
  // on `stats.messageCount`, but `messageCount` only counts user messages
  // (SessionStore.ts calculateSessionStats), whereas messageSequence indexes
  // every persisted message — so the seed would under-count and still collide.
  // Removed rather than fixed: the disk-first write order is the real guard.
  if (initialSessionId && initMeta) {
    const sessionData = getSessionData(initialSessionId);
    if (sessionData?.messages?.length) {
      loadMessagesFromStorage(sessionData.messages);
      console.log(`[agent] initializeAgent: loaded ${sessionData.messages.length} existing messages, messageSequence=${messageSequence}`);
    }
  }

  // Initialize logger for new session (lazy file creation)
  initLogger(sessionId);
  console.log(`[agent] init dir=${agentDir} initialPrompt=${hasInitialPrompt ? 'yes' : 'no'} sessionId=${sessionId} resume=${sessionRegistered}`);

  // Phase E (PRD 0.2.7): file-watcher → SSE removed; renderer uses the Rust
  // workspace_files watcher via Tauri events (`workspace:files-changed:*`).

  // Self-resolve workspace config from disk (MCP/provider/model).
  // Eliminates dependency on pre-serialized snapshots (providerEnvJson, mcpServersJson)
  // that can fail to save or go stale. IM Bot sessions work correctly without the
  // frontend having been opened first. For desktop Tabs, the frontend's /api/mcp/set
  // and per-message providerEnv will override these values.
  // Skip for Global Sidecar (no workspace-specific config).
  if (!preWarmDisabled) {
    try {
      const { resolveWorkspaceConfig } = await import('./utils/admin-config');
      // v0.1.69: pass session metadata so the sidecar prefers session snapshot
      // (`meta.model`, `meta.providerId/EnvJson`, `meta.mcpEnabledServers`) over the
      // agent's current values. For IM sessions (which deliberately don't snapshot
      // these fields), this is a no-op — the agent fallback handles them.
      //
      // Pass `includeMcp: hasInitialPrompt` — Tab sessions (no initial prompt)
      // deliberately skip MCP self-resolve below anyway (the frontend's
      // /api/mcp/set is authoritative), so asking resolveWorkspaceConfig to
      // compute an MCP list that will be discarded is pure waste. Cuts the
      // expensive getAllMcpServers/getEffectiveMcpServers disk walk out of
      // the Tab-open critical path.
      const resolved = resolveWorkspaceConfig(agentDir, initMeta, {
        includeMcp: hasInitialPrompt,
      });
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
        // PRD #124: keep bridge registration in sync after self-resolve.
        ensureActiveSessionBridgeRegistered();
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
    // Explicit cancel — broadcasts queue:cancelled so frontend clears pills immediately
    // (chat:init follows but that's seconds later, after awaitSessionTermination).
    drainQueueWithCancellation();
    await awaitSessionTermination(10_000, 'switchToSession');
    querySession = null;
  }

  // Persist current in-memory messages before clearing to prevent data loss
  // (e.g., if an active streaming session accumulated messages not yet saved to disk)
  if (messages.length > 0) {
    console.log(`[agent] switchToSession: persisting ${messages.length} in-memory messages before clearing`);
    await persistMessagesToStorage();
  }

  // Reset message/queue/streaming state (shared with initializeAgent, resetSession)
  clearMessageState();

  // Reset session-level runtime state
  shouldAbortSession = false;
  isProcessing = false;
  sessionRegistered = false; // Will re-set from sessionMeta below
  pendingResumeSessionAt = undefined; // Prevent leaking rewind state to different session
  pendingReloadAnchor = undefined;   // PRD 0.2.27 — symmetric reset
  messageResolver = null;
  setSessionState('idle');
  systemInitInfo = null;
  sdkControlReady = false;

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
  } else if (isExternalRuntime(getCurrentRuntimeType())) {
    // External runtimes (codex/gemini/CC) don't use sdkSessionId — resume is
    // driven by runtimeSessionId in external-session.ts. Not a problem.
    sessionRegistered = false;
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

  // Drain any in-flight setModel from a prior `setSessionModel(...)` BEFORE
  // we look at the short-circuit. Without this, the "click M2 in the model
  // picker, immediately click Send" sequence races: setSessionModel updated
  // `currentModel` synchronously and fired setModel without awaiting, so the
  // short-circuit `newModel === currentModel` returns true before the SDK
  // subprocess has swapped — the next SDK turn runs on the OLD model. Awaiting
  // the registered promise gives the SDK time to ack. (Codex review 2026-05-07.)
  if (pendingSetModelPromise) {
    try {
      await pendingSetModelPromise;
    } catch {
      // dispatchSetModelToSdk already logged; we still want to proceed —
      // a stale setModel failure doesn't block the rest of config sync.
    }
  }

  // Apply model change if different. Same wrap rationale as setSessionModel():
  // setModel() on the live SDK subprocess updates the model fed into
  // getContextWindowForModel() on subsequent turns, so 1M-window models need
  // the [1m] tag here too. Routed through dispatchSetModelToSdk so any later
  // applySessionConfig invocation that runs concurrently also drains via
  // pendingSetModelPromise.
  if (newModel && newModel !== currentModel) {
    const aliasEnvChanged = modelAliasEnvChangesForModel(currentProviderEnv?.modelAliases, currentModel, newModel);
    try {
      if (aliasEnvChanged) {
        const oldModel = currentModel;
        currentModel = newModel;
        console.log(`[agent] runtime model aliases changed (${oldModel ?? 'undefined'} -> ${newModel}) -> restarting session to reinject ANTHROPIC_DEFAULT_*_MODEL`);
        abortPersistentSession();
        await awaitSessionTermination(10_000, 'applySessionConfig/modelAliasChange');
        querySession = null;
        isProcessing = false;
        setSessionState('idle');
        resetAbortFlag();
        return;
      }
      await dispatchSetModelToSdk(newModel);
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
  /**
   * (v0.2.12) When queued=true, indicates whether this item became the
   * in-flight one (yielded immediately to CLI subprocess) or stayed in
   * pendingMidTurnQueue (still cancellable). Frontend uses this to set
   * the initial `isInFlight` flag on the optimistic queue pill so the
   * X cancel button visibility matches the real backend state from the
   * very first paint, before the SSE `queue:added` round-trip completes.
   */
  isInFlight?: boolean;
  error?: string;    // present when queue is full or other rejection
};

export async function enqueueUserMessage(
  text: string,
  images?: ImagePayload[],
  permissionMode?: PermissionMode,
  model?: string,
  providerEnv?: ProviderEnv | 'subscription',
  metadata?: { source: SessionSource; sourceId?: string; senderName?: string },
  // Pattern A — IM trace ID. Forwarded from /api/im/chat (Rust generates at edge).
  // Desktop / cron / heartbeat callers omit this — those paths get no IM identity.
  requestId?: string,
  // PRD 0.2.18 Session Inbox — inbox metadata for cross-session messages.
  // Present when message came in via /api/inbox/drain (caller sent through
  // `myagents session send`). Carries reply-back instruction + caller identity;
  // bound per-turn at generator yield, read at result handler for reply pushback.
  inboxMeta?: import('./inbox/types').InboxTurnMeta,
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

  // ─── DELAYED CONTINUE (consume flag) ──────────────────────────────────
  // If the previous turn on this session was aborted by the inactivity
  // watchdog *and* produced real model output, the SessionMetadata
  // carries `pendingContinueAfterAbort=true`. Inject one system-reminder
  // user-turn *before* the caller's actual message so the model resumes
  // from existing context.
  //
  // Invariants (cross-review hardened):
  //
  //  1. `sessionIdSnapshot` captures module-level sessionId SYNCHRONOUSLY
  //     before any await. Without this, a concurrent `switchToSession`
  //     could mutate sessionId across the await in updateSessionMetadata
  //     or the recursive enqueue — clearing the flag and/or sending the
  //     reminder against the wrong session.
  //
  //  2. `consumingPendingContinueSessions` is a PER-SESSION lock, not
  //     global. Two different sessions consuming their own flags
  //     concurrently must not block each other.
  //
  //  3. Clear-on-SUCCESS — disk flag is cleared and per-process cap is
  //     marked ONLY after the recursive enqueue succeeds AND we verify
  //     no session switch raced through. If the recursive enqueue
  //     rejects (queue full) or `sessionId !== sessionIdSnapshot`
  //     post-await, leave the flag set so the next legit enqueue on
  //     the original session re-attempts.
  //
  //  4. The recursive `enqueueUserMessage` itself awaits resetPromise,
  //     so a switchToSession running between this call and the recursive
  //     entry is serialized. But it would then route the reminder to
  //     the NEW session — which is wrong. The post-await sessionId
  //     check catches that case; we can't un-enqueue the reminder but
  //     we MUST preserve the original session's flag for retry.
  const sessionIdSnapshot = sessionId;
  if (
    !consumingPendingContinueSessions.has(sessionIdSnapshot) &&
    !autoResumeInjectedSessions.has(sessionIdSnapshot)
  ) {
    const meta = getSessionMetadata(sessionIdSnapshot);
    if (meta?.pendingContinueAfterAbort) {
      consumingPendingContinueSessions.add(sessionIdSnapshot); // sync test-and-set
      try {
        console.log(`[agent] Consuming pendingContinueAfterAbort for session ${sessionIdSnapshot}, injecting reminder turn`);
        const reminderResult = await enqueueUserMessage(
          WATCHDOG_RESUME_REMINDER,
          undefined,        // images
          permissionMode,   // inherit caller's permission mode
          model,            // inherit caller's model
          providerEnv,      // inherit caller's provider env
          undefined,        // metadata — synthetic, no source attribution
          undefined,        // requestId — synthetic, no IM trace
          undefined,        // inboxMeta — synthetic, no inbox pushback
        );

        if (sessionId !== sessionIdSnapshot) {
          // switchToSession raced between our call and the recursive
          // enqueue's resetPromise wait — reminder went to the new
          // session. Preserve the original session's flag for retry;
          // do NOT clear it or mark the per-process cap.
          console.error(`[agent] Reminder enqueue raced session switch ${sessionIdSnapshot} → ${sessionId}; flag for ${sessionIdSnapshot} preserved for retry`);
        } else if (reminderResult.error) {
          // Queue rejection — preserve flag for retry, same rationale.
          console.error(`[agent] Reminder enqueue rejected (${reminderResult.error}); flag for ${sessionIdSnapshot} preserved for retry`);
        } else {
          // Success path — reminder is in the right session's queue.
          // Clear disk flag + mark per-process cap, both against the
          // snapshot (not module-level) so a switch race after this
          // point still targets the correct session.
          await updateSessionMetadata(sessionIdSnapshot, { pendingContinueAfterAbort: false });
          autoResumeInjectedSessions.add(sessionIdSnapshot);
        }
      } catch (e) {
        console.error('[agent] Failed to inject Continue reminder turn:', e);
      } finally {
        consumingPendingContinueSessions.delete(sessionIdSnapshot);
      }
    }
  }

  // Session is "busy" if AI is streaming OR there are pending messages in
  // any of the three queues. This prevents config changes and turn-usage
  // resets during the brief gap between turns.
  //
  // MUST include pendingMidTurnQueue (v0.2.11 cross-bugfix #142 review-fix #2):
  // when a turn ends and handleMessageComplete is preparing to promote the next
  // pending item, there's a window where isTurnInFlight() is false and
  // messageQueue is empty, but pendingMidTurnQueue still holds items. Without
  // this guard a new enqueue would slip into the direct-send path and break
  // the user's expected ordering (queued items run first).
  //
  // KNOWN GAP (tracked separately, not a regression of #173): this snapshot is
  // synchronous, but enqueueUserMessage proceeds through several awaits before
  // it actually pushes to messageQueue / wakeGenerator. Two rapid sends can
  // both pass this gate before either reaches the push, both broadcast
  // chat:message-replay, and both yield to the SDK without intervening AI
  // responses. The same race exists in v0.2.11 / v0.2.12 (verified by reading
  // both versions); fixing it requires a synchronous "admission ticket" that's
  // out of scope for the #173 dedup hotfix.
  const isSessionBusy = isTurnInFlight()
    || shouldAbortSession
    || isInterruptingResponse
    || messageQueue.length > 0
    || pendingMidTurnQueue.length > 0
    || promotedItemInFlight;

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
      // Pattern 3 §3.2.4 — fresh session means existing on-disk JSONL is
      // unrelated to this in-memory state; reset the cursor.
      lastPersistedIndex = 0;
      persistedSessionMessageCache.length = 0;
      systemInitInfo = null;
      sdkControlReady = false;
      console.log('[agent] Fresh session: third-party → Anthropic (signature incompatible)');
    }

    // Update provider env BEFORE terminating so the new session picks it up
    currentProviderEnv = effectiveProviderEnv; // undefined for subscription, object for API
    // PRD #124: keep bridge registration in sync (handles all provider transitions).
    ensureActiveSessionBridgeRegistered();
    // Terminate current session - it will restart automatically when processing the message
    abortPersistentSession();
    // Wait for the current session to fully terminate before proceeding
    // This prevents race conditions where old session continues processing
    await awaitSessionTermination(10_000, 'enqueueUserMessage/providerChange');
    querySession = null;
    isProcessing = false;
    setSessionState('idle');
    // CRITICAL (v0.2.14 dogfood): the abort above set shouldAbortSession=true
    // to terminate the OLD pre-warmed session. Once awaitSessionTermination
    // confirms the old session is gone, the flag has done its job — but
    // leaving it set leaks across the next message. The user's freshly
    // enqueued message (added below) gets scheduled into startStreamingSession
    // via setTimeout(0); that function's pre-launch abort guard
    // (`shouldAbortSession && !preWarm`) then fires "aborted pre-launch by
    // stop during starting" and drains the just-enqueued message — exactly
    // the silent-fail manifest in the dogfood log when the user changed
    // their model from a third-party provider to Anthropic and sent a
    // message in the same beat. Reset here, NOT after the message-enqueue
    // below, so the guard sees a clean slate.
    resetAbortFlag();
    // Explicit cancel — broadcasts queue:cancelled so frontend clears stale pills
    // before the new message (added below) fires queue:added. Without this, the UI
    // would show old pills as phantoms alongside the new one.
    drainQueueWithCancellation();
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
      // Session already in index — only update title if it's still default.
      // deriveSessionTitle strips the <system-reminder>/<CRON_TASK>/<HEARTBEAT>
      // wrapper BEFORE the 40-char cap so cron/heartbeat turns don't store a
      // wrapper-only scrap like "执行任务：请你帮 E..." (cron-title fix).
      // Fallback split (adversarial-review #4): a wrapper-only TEXT turn strips
      // to '' but is not an image message — only reserve '图片消息' for genuinely
      // text-less (image-only) input; otherwise 'New Chat'.
      const title = deriveSessionTitle(trimmed, 40) || (trimmed ? 'New Chat' : '图片消息');
      if (existingMeta.title === 'New Chat') {
        await updateSessionMetadata(sessionId, { title });
      }
      console.log(`[agent] session ${sessionId} already exists in SessionStore, preserving stats`);
    } else {
      // Brand new session — create metadata. v0.1.69: lazy creation covers two cases:
      //   (a) Desktop first-send with a pending session ID (App.tsx generates a
      //       `pending-<tabId>` placeholder and never calls POST /sessions; the real
      //       session is materialized here). → owned snapshot (self-contained).
      //   (b) IM Bot / agent-channel first message. → im snapshot (live-follow).
      // Dispatch on `currentScenario.type` set by the caller before enqueue:
      //   - 'desktop' / 'cron' → owned (config frozen into session)
      //   - 'im' / 'agent-channel' → live-follow (only runtime recorded)
      // If the agent lookup misses (workspace not registered), snapshot is `{}` and
      // `resolveSessionConfig`'s lazy fallback (meta ?? agent) covers it.
      // Strip the system wrapper before the 40-char cap (cron-title fix) —
      // otherwise a cron/heartbeat first message stores a wrapper-only scrap.
      // Fallback split (adversarial-review #4): '图片消息' only for text-less input.
      const title = deriveSessionTitle(trimmed, 40) || (trimmed ? 'New Chat' : '图片消息');
      const { meta: sessionMeta, snapshotKind } = createMetadataForSessionId(
        sessionId,
        title,
        currentScenario.type,
      );
      await saveSessionMetadata(sessionMeta);
      console.log(`[agent] session ${sessionId} persisted to SessionStore (lazy, scenario=${currentScenario.type}, snapshot=${snapshotKind})`);
    }
  } else {
    // Update session title from first real message if needed
    if (trimmed && messages.length === 0) {
      await updateSessionTitleFromMessage(sessionId, trimmed);
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
      broadcast('chat:system-init', { info: systemInitInfo, sessionId, runtime: 'builtin' });
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
  // (issue #174 — refined per cross-bugfix 2026-05-10)
  //
  // 'starting' = SDK subprocess still booting → UI shows "AI 启动中（首次启动
  //              可能较慢）" with the cold-start timer.
  // 'running'  = subprocess ready, turn executing → UI shows "思考中…".
  //
  // Original judge `systemInitInfo ? 'running' : 'starting'` mislabels turns:
  // streamed `system_init` is per-turn metadata (QueryEngine yields it AFTER
  // processUserInput / skill loading), so a fully pre-warmed session running
  // a slow first turn (notably /context, 14 internal turns of local
  // computation, observed at 44s) sat in 'starting' for the entire turn.
  // The pre-warm path already drove `Query.initializationResult()` to set
  // `sdkControlReady` once the SDK control plane finished its initialize
  // handshake, so use that as the actual subprocess-ready signal. Keep
  // `systemInitInfo` as a fallback: if a session somehow received system_init
  // without sdkControlReady having flipped (e.g., recovery paths that bypass
  // pre-warm), the per-turn metadata still proves the subprocess is alive.
  setSessionState((systemInitInfo || sdkControlReady) ? 'running' : 'starting');

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

  // Modality gate. The full image array is still saved to disk above
  // (`savedAttachments`) so the UI message bubble shows what the user sent.
  // What we drop here is just the SDK content blocks for unsupported
  // modalities — the model never sees them. Defaults to allow when the model
  // is unknown (custom provider with no `inputModalities` set), per spec.
  // This is the authoritative filter point: IM Bot / Cron / Agent Channel
  // also flow through `enqueueUserMessage`, so frontend toasts are an
  // ergonomic enhancement, not the security boundary.
  //
  // We resolve against the message's intended model: caller-provided `model`
  // if any (this is the model that will actually run the turn — applied via
  // `applySessionConfig` further down on the non-busy path; on the queued/
  // busy path it's intentionally inherited rather than applied per existing
  // provider-env semantics, and `stripUnsupportedModalityBlocks` re-checks
  // at dequeue to catch any drift), otherwise the session's current model.
  const modelForFilter = model ?? currentModel;
  const imagesAllowed = modelSupportsModality(modelForFilter, 'image');
  const filteredImageCount = hasImages && !imagesAllowed ? images!.length : 0;

  // Mutable text payload — modality fallback (below) appends `@<path>`
  // references for images that can't go in as image content blocks. Title /
  // log / persistence continue to use the original `trimmed`.
  let effectiveText = trimmed;

  // Add images first so Claude can see them before the text query
  // Images are resized/sliced server-side to stay within API limits (≤1568px, long images → 1:2 tiles)
  if (hasImages && imagesAllowed) {
    for (const img of images) {
      let tiles: Awaited<ReturnType<typeof processImage>>;
      try {
        tiles = await processImage(img);
      } catch (err) {
        // Image too large or processing failed — notify user and inform Claude
        const friendly = classifyImageError(err);
        const raw = err instanceof Error ? err.message : String(err);
        console.warn(`[agent] processImage error for ${img.name}: ${raw}`);
        broadcast('chat:message-error', `图片 "${img.name}" 处理失败：${friendly}`);
        contentBlocks.push({ type: 'text', text: `[Image "${img.name}" omitted: ${friendly}]` });
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
  } else if (hasImages && filteredImageCount > 0) {
    // Modality fallback (PRD prd_0.2.3_image_modality_file_fallback.md):
    // model lacks image support → write the images into `<agentDir>/myagents_files/`
    // and append `@<relative path>` to the user text so the model can choose
    // to Read them (or hand them to other tools). Mirrors the behaviour of
    // pasting non-image files in the Tab UI input. IM Bot path inherits this
    // automatically via the same enqueueUserMessage entry point.
    //
    // Failure path (disk full, agent not yet bound, etc.) reverts to the
    // legacy "synthetic text + chat:attachments-filtered" route so the SDK
    // still sees a non-empty user turn and the message isn't silently lost.
    let fallbackPaths: string[] = [];
    if (agentDir) {
      const targetDir = join(agentDir, 'myagents_files');
      try {
        const written = await writeBase64FilesToAgentDir(
          images!.map((img) => ({ name: img.name, content: img.data })),
          targetDir,
          agentDir,
        );
        fallbackPaths = written.map((w) => w.relativePath);
      } catch (err) {
        const raw = err instanceof Error ? err.message : String(err);
        console.warn(`[agent] modality fallback: failed to write ${filteredImageCount} image(s) to ${targetDir}, reverting to synthetic text. error=${raw}`);
      }
    }

    if (fallbackPaths.length > 0) {
      // Mirror the frontend non-image paste path (SimpleChatInput.tsx
      // /api/files/add-gitignore call): keep workspace-internal artifacts
      // out of git by default. PRD §6.4 explicitly calls for parity here.
      ensureGitignorePattern(agentDir, 'myagents_files/');

      const refs = fallbackPaths.map((p) => `@${p}`).join(' ');
      effectiveText = effectiveText ? `${effectiveText}\n\n${refs}` : refs;
      console.log(`[agent] modality fallback: ${fallbackPaths.length} image(s) → myagents_files/ (model=${modelForFilter ?? '(unknown)'})`);
      broadcast('chat:attachments-fallback', {
        kind: 'image',
        count: fallbackPaths.length,
        paths: fallbackPaths,
        model: modelForFilter ?? null,
      });
    } else {
      // Fallback unavailable (no agent dir or write failure): preserve the
      // pre-PRD behaviour so we never drop the user turn entirely.
      console.log(`[agent] modality filter: dropping ${filteredImageCount} image(s) for model=${modelForFilter ?? '(unknown)'} (text-only, fallback unavailable)`);
      contentBlocks.push({
        type: 'text',
        text: `[${filteredImageCount} image attachment(s) omitted — current model does not support image input]`,
      });
      broadcast('chat:attachments-filtered', {
        // 'fallback-failed' lets the frontend distinguish "model has no image
        // modality, fallback worked" (no event) from "fallback was attempted
        // but failed" (this branch). The pre-PRD path used 'modality'; we
        // keep that as the legacy/no-agent-dir reason.
        reason: agentDir ? 'fallback-failed' : 'modality',
        kind: 'image',
        count: filteredImageCount,
        model: modelForFilter ?? null,
      });
    }
  }

  // Add text content if present (may include @reference suffix from fallback)
  if (effectiveText) {
    contentBlocks.push({ type: 'text', text: effectiveText });
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
    // Count messageQueue + pendingMidTurnQueue + the in-flight slot.
    const MAX_QUEUE_SIZE = 10;
    const inFlightCount = inFlightToCliId !== null ? 1 : 0;
    if (messageQueue.length + pendingMidTurnQueue.length + inFlightCount >= MAX_QUEUE_SIZE) {
      return { queued: false, error: `Queue full (max ${MAX_QUEUE_SIZE})` };
    }
    const queueItem: MessageQueueItem = {
      id: queueId,
      message: { role: 'user', content: contentBlocks },
      messageText: trimmed,
      wasQueued: true,
      resolve: () => {},  // No-op: no one is awaiting
      attachments: savedAttachments.length > 0 ? savedAttachments : undefined,
      requestId,
      inboxMeta,
    };

    // (v0.2.12 mid-turn injection) Lockstep yield. Only one queued message
    // lives in CLI's commandQueue at a time so subsequent items stay
    // cancellable in pendingMidTurnQueue until this one is consumed
    // (signalled by SDKUserMessageReplay) and we promote the next.
    if (inFlightToCliId === null) {
      // No in-flight queue item — this becomes the in-flight one. Yield
      // immediately so CLI receives it and the next mid-turn drain
      // (query.ts:1570 at any tool break) attaches it to the model's
      // context. Mark inFlightToCliId BEFORE wakeGenerator so any
      // concurrent enqueue arriving in the same micro-task takes the
      // buffer path.
      inFlightToCliId = queueId;
      inFlightMetadata = {
        messageText: trimmed,
        attachments: savedAttachments.length > 0 ? savedAttachments : undefined,
        requestId,
        source: metadata?.source,
        mirrorImages: toMirrorImages(images),
      };
      wakeGenerator(queueItem);
      console.log(`[agent] Message queued mid-turn (in-flight to CLI): queueId=${queueId} requestId=${requestId ?? '-'} text="${trimmed.slice(0, 50)}"`);
      broadcast('queue:added', { queueId, messageText: trimmed.slice(0, 100), isInFlight: true });
    } else {
      // Another item is in-flight to CLI. Buffer this one. It stays
      // fully cancellable (splice from pendingMidTurnQueue) until promoted
      // by handleQueuedCommandReplay or a turn-end fallback.
      const userMessage: MessageWire = {
        id: String(messageSequence++),
        role: 'user',
        content: trimmed,
        timestamp: new Date().toISOString(),
        attachments: savedAttachments.length > 0 ? savedAttachments : undefined,
      };
      pendingMidTurnQueue.push({
        queueId,
        userMessage: {
          id: userMessage.id,
          role: userMessage.role,
          content: userMessage.content,
          timestamp: userMessage.timestamp,
          attachments: userMessage.attachments,
        },
        sourceItem: queueItem,
      });
      console.log(`[agent] Message queued mid-turn (pending — in-flight slot busy): queueId=${queueId} requestId=${requestId ?? '-'} (pending=${pendingMidTurnQueue.length})`);
      broadcast('queue:added', { queueId, messageText: trimmed.slice(0, 100), isInFlight: false });
    }

    // Safety net: if message was queued because shouldAbortSession is true but no session
    // or pre-warm timer exists to process it, schedule recovery. This prevents orphaned
    // messages when a deferred config restart races with session cleanup.
    if (shouldAbortSession && !preWarmTimer && !messageResolver) {
      console.warn('[agent] Safety net: queued message during abort with no pending recovery, scheduling pre-warm');
      schedulePreWarm();
    }
    // (v0.2.12) inFlightToCliId === queueId only when this enqueue took the
    // immediate-yield path. Frontend uses this to set the optimistic pill's
    // isInFlight flag from the very first paint, before the SSE round-trip.
    return { queued: true, queueId, isInFlight: inFlightToCliId === queueId };
  }

  // Direct send path: push user message to messages[] and broadcast immediately.
  // NOTE (issue #173): this is the SOLE writer to messages[] for direct-send.
  // The messageGenerator's `!item.wasQueued` branch intentionally does NOT
  // push again — see the matching comment block there. Re-introducing a push
  // anywhere downstream of this site duplicates the user bubble in the UI
  // (different messageSequence id breaks frontend dedup) and writes two
  // SessionStore entries.
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
  await persistMessagesToStorage();

  // PRD 0.2.14 — desktop → IM mirror (direct-send path, single push site).
  // Q1·C: mirror the full user text + PNG/JPG attachments. Rust silently
  // no-ops if no channel binding exists for this session.
  if (metadata?.source === 'desktop') {
    fireDesktopUserMirror(trimmed, toMirrorImages(images));
  } else {
    // New non-desktop turn — make sure stale mirror state from a prior
    // desktop turn doesn't bleed into this AI response.
    clearMirrorState();
  }

  const queueItem: MessageQueueItem = {
    id: queueId,
    message: { role: 'user', content: contentBlocks },
    messageText: trimmed,
    wasQueued: false,
    resolve: () => {},  // No-op: no one is awaiting
    requestId,
    inboxMeta,
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

export async function interruptCurrentResponse(reason: CancelReason = 'user'): Promise<boolean> {
  if (!isTurnInFlight()) {
    // (issue #174) Stop pressed during 'starting': the SDK subprocess is
    // alive but system_init hasn't arrived (the for-await loop sees no
    // assistant content yet, so isTurnInFlight is false). Without this
    // branch the user's Stop button is a no-op for the up-to-10-minute
    // startup-timeout window. Tear the subprocess down via the canonical
    // abort path — same teardown the startup-timeout firer uses.
    if (sessionState === 'starting') {
      console.log(`[agent] Stop pressed during startup (reason=${reason}) — aborting persistent session`);
      // Drain BEFORE abort so the cold-start path's queued first-message
      // (enqueued by enqueueUserMessage just before the deferred
      // startStreamingSession scheduled via setTimeout(0)) doesn't survive
      // into a recovery session and silently re-execute. abortPersistentSession
      // calls rescuePendingToQueue which only moves pendingMidTurnQueue items
      // (empty during startup) — it doesn't touch messageQueue. Order
      // matters: drain here, then abort sets shouldAbortSession so the
      // pre-launch guard inside startStreamingSession bails out cleanly.
      drainQueueWithCancellation();
      abortPersistentSession();
      // Cold-start race: if the deferred startStreamingSession setTimeout(0)
      // hasn't fired yet, querySession is null and isProcessing is false,
      // so the for-await finally block — the only path that flips
      // sessionState back to 'idle' — will never run. Force the transition
      // here so the UI returns to a sendable state immediately. (When a
      // subprocess IS alive, abortPersistentSession's interrupt() drives
      // the for-await loop to terminate and the existing finally block
      // handles the idle transition; we'd be racing it, so skip.)
      if (!querySession && !isProcessing) {
        setSessionState('idle');
      }
      return true;
    }
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

  // Pattern 1 follow-up: abort the turn-scoped controller FIRST so any
  // in-flight tool fetches / streams in our Node process see the cancel
  // immediately, in parallel with the cooperative SDK interrupt below.
  // Both are fire-and-forget; we don't await this — withAbortSignal /
  // cancellableFetch wake their op via the AbortSignal listener.
  if (sessionId) abortTurnAbort(sessionId, reason);

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
      // Rescue pending items BEFORE close: SDK stdin buffer dies with the subprocess.
      // Must run before close() so the recovery session re-delivers them.
      rescuePendingToQueue();
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
    // (turn completion). If it doesn't arrive, force-close. The diagnostic message
    // distinguishes two phases the model could be in when the user pressed Stop:
    //   - inFlightToolCount > 0  → an MCP tool_use is awaiting tool_result, very
    //     likely the SDK subprocess is blocked on client.callTool() (hung tool).
    //   - inFlightToolCount === 0 → no tool in flight; the model is mid-generation
    //     (thinking / text streaming) and 3s wasn't enough for the SDK to wind
    //     down. NOT a hung tool — calling it one in the log misleads anyone
    //     grepping for tool issues. This was the misdiagnosis observed on
    //     2026-05-07 when stop was pressed during a thinking block.
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
        postInterruptTurnEndResolve = null;
        if (querySession) {
          const phase = inFlightToolCount > 0
            ? `hung MCP tool likely (${inFlightToolCount} tool_use awaiting result)`
            : 'model still generating (no tool in flight)';
          console.warn(`[agent] Force-closing: turn did not complete 3s after interrupt — ${phase}`);
          // Rescue pending items BEFORE close: see rescuePendingToQueue() doc.
          rescuePendingToQueue();
          const session = querySession;
          querySession = null;
          try { session.close(); } catch { /* already dead */ }
        }
      }
    }

    // Issue #289 — if the graceful-interrupt `result` already ran handleMessageComplete and
    // it FORCE-surfaced the in-flight item, the turn-end is fully handled and the SDK is
    // draining that item into a new turn. Calling handleMessageStopped() here would undo the
    // streaming re-arm and double-pop the IM request (a racy idle window). Skip it; a plain
    // stop (flag unset) still tears down normally.
    if (forceDrainTurnStarting) {
      forceDrainTurnStarting = false;
    } else {
      broadcast('chat:message-stopped', null);
      handleMessageStopped();
    }
    return true;
  } finally {
    isInterruptingResponse = false;
    forceDrainTurnStarting = false; // defensive: never leak into a later interrupt
  }
}

/**
 * Pattern D — IM trace-id-targeted cancellation. Resolves whether the request
 * is currently running or queued, then takes the appropriate action:
 *   - queued (in messageQueue / pendingMidTurnQueue) → splice out, broadcast
 *     queue:cancelled, no SDK interrupt needed
 *   - running (activeRequestId matches + turn in flight) → interruptCurrentResponse
 *     which already wires `abortTurnAbort` → cancellableFetch unblock + SDK interrupt
 *   - unknown → no-op (caller can still emit a 'cancelled' event for UI)
 *
 * Returns the resolved mode so the caller (`/api/im/cancel`) can shape the response.
 */
export async function cancelImRequest(
  requestId: string,
  reason: CancelReason = 'user',
): Promise<{ aborted: boolean; mode: 'running' | 'queued' | 'unknown' }> {
  // Try messageQueue first
  const qIdx = messageQueue.findIndex(item => item.requestId === requestId);
  if (qIdx >= 0) {
    const [item] = messageQueue.splice(qIdx, 1);
    item.resolve();
    broadcast('queue:cancelled', { queueId: item.id });
    console.log(`[agent] cancelImRequest requestId=${requestId} mode=queued`);
    return { aborted: true, mode: 'queued' };
  }
  // (v0.2.12) Try pendingMidTurnQueue — buffered while another item is
  // in-flight to CLI. Never crossed the process boundary — splice = real cancel.
  const pmIdx = pendingMidTurnQueue.findIndex(p => p.sourceItem.requestId === requestId);
  if (pmIdx >= 0) {
    const [removed] = pendingMidTurnQueue.splice(pmIdx, 1);
    removed.sourceItem.resolve();
    broadcast('queue:cancelled', { queueId: removed.queueId });
    console.log(`[agent] cancelImRequest requestId=${requestId} mode=pending-mid-turn (never yielded to CLI)`);
    return { aborted: true, mode: 'queued' };
  }
  // Active turn? (queue head matches)
  if (pendingRequestIds[0] === requestId && isTurnInFlight()) {
    console.log(`[agent] cancelImRequest requestId=${requestId} mode=running`);
    await interruptCurrentResponse(reason);
    return { aborted: true, mode: 'running' };
  }
  // (v0.2.12) Either the requestId is in-flight to CLI (uncancellable —
  // its content already crossed into CLI's commandQueue), or the request
  // doesn't exist on this side. Both surface as 'unknown' so the IM
  // client can show "cancel failed" honestly rather than a false success.
  return { aborted: false, mode: 'unknown' };
}

/**
 * Cancel a queued message by its queueId.
 * Returns the original message text (for restoring to input box) or null if not found.
 *
 * (v0.2.12) Three queue locations to check:
 *   - messageQueue: not yet consumed by generator (no active turn). Splice → done.
 *   - pendingMidTurnQueue: buffered while another item is in-flight to CLI.
 *     Splice → done. Still cancellable because it never crossed the process
 *     boundary into CLI's commandQueue.
 *   - inFlightToCliId match: the item is already in CLI's commandQueue and
 *     potentially already drained into AI's context. SDK exposes no API to
 *     retract a queued_command. Frontend hides the X button on the in-flight
 *     pill so this branch is rarely reached; we return null to signal "no
 *     cancel". UI invariant: if the X is visible, cancellation succeeds.
 */
export function cancelQueueItem(queueId: string): string | null {
  // 1. messageQueue (no active turn — generator about to pull)
  const mqIdx = messageQueue.findIndex(item => item.id === queueId);
  if (mqIdx >= 0) {
    const [item] = messageQueue.splice(mqIdx, 1);
    item.resolve();
    broadcast('queue:cancelled', { queueId });
    console.log(`[agent] Queue item ${queueId} cancelled from messageQueue (wasQueued=${item.wasQueued})`);
    return item.messageText;
  }

  // 2. pendingMidTurnQueue (buffered, in-flight slot occupied by another item)
  const pmIdx = pendingMidTurnQueue.findIndex(p => p.queueId === queueId);
  if (pmIdx >= 0) {
    const [removed] = pendingMidTurnQueue.splice(pmIdx, 1);
    removed.sourceItem.resolve();
    broadcast('queue:cancelled', { queueId });
    console.log(`[agent] Queue item ${queueId} cancelled from pendingMidTurnQueue (never yielded to CLI)`);
    if (
      messageQueue.length === 0
      && pendingMidTurnQueue.length === 0
      && inFlightToCliId === null
      && !isTurnInFlight()
    ) {
      setSessionState('idle');
    }
    return typeof removed.userMessage.content === 'string' ? removed.userMessage.content : '';
  }

  // 3. In-flight to CLI — cannot cancel. Frontend should not have offered
  //    the X button for this item, but if it raced and asked anyway, we
  //    refuse the cancel honestly rather than fake a success.
  if (inFlightToCliId === queueId) {
    console.log(`[agent] Queue item ${queueId} cancel rejected — already in-flight to CLI (uncancellable)`);
    return null;
  }

  console.log(`[agent] Queue item ${queueId} not found — already consumed or never existed`);
  return null;
}

/**
 * Force-execute a queued message: move it to front of its queue and
 * interrupt the current turn so it runs immediately when the turn winds
 * down.
 *
 * (v0.2.11 cross-bugfix #142) Two queues to handle:
 *   - messageQueue: not yet consumed by generator. Move to messageQueue[0].
 *   - pendingMidTurnQueue: deferred-yield buffer (NOT yielded to SDK).
 *     Move to pendingMidTurnQueue[0] so the next promote picks it up.
 *
 * Either way, interruptCurrentResponse fires the prior turn's wind-down →
 * handleMessageComplete/Stopped → promotePendingMidTurnItem (or
 * generator's next waitForMessage drain of messageQueue) wakes the
 * generator with our target as the next message.
 */
export async function forceExecuteQueueItem(queueId: string): Promise<boolean> {
  const mqIdx = messageQueue.findIndex(item => item.id === queueId);
  const pmIdx = mqIdx === -1
    ? pendingMidTurnQueue.findIndex(p => p.queueId === queueId)
    : -1;
  // (v0.2.12 Codex review fix #3) The in-flight item still shows the ▷
  // play button in the UI ("已发送但还没被 AI 看见 — 我想立刻处理"). It
  // doesn't live in either queue any more (already yielded to CLI), so
  // the legacy "move to front of queue + interrupt" path returns 404
  // for it. Instead, just force the current turn to wind down so CLI's
  // post-abort drainCommandQueue immediately processes whatever's
  // in commandQueue (including our in-flight item).
  const isInFlight = mqIdx === -1 && pmIdx === -1 && inFlightToCliId === queueId;

  if (mqIdx === -1 && pmIdx === -1 && !isInFlight) return false;

  // Move target to front of its queue so it's first when the turn ends.
  if (mqIdx > 0) {
    const [item] = messageQueue.splice(mqIdx, 1);
    messageQueue.unshift(item);
  } else if (pmIdx > 0) {
    const [pending] = pendingMidTurnQueue.splice(pmIdx, 1);
    pendingMidTurnQueue.unshift(pending);
  }

  if (isSessionActive()) {
    // Issue #289: if the target is already in-flight to the CLI, mark it so the
    // graceful-interrupt `result` SURFACES it (it's about to be drained + processed
    // by the SDK) instead of dropping it from the UI like a plain stop would.
    if (isInFlight) {
      forceSurfaceInFlightId = queueId;
    }
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
    // Explicit cancel — broadcasts queue:cancelled so frontend clears pills.
    drainQueueWithCancellation();
    await awaitSessionTermination(10_000, 'rewind');
    shouldAbortSession = false;

    // 5. 收集被删消息内容（恢复到输入框）
    const removedContent = typeof targetMessage.content === 'string' ? targetMessage.content : '';
    const removedAttachments = targetMessage.attachments;

    // 6. 截断消息
    messages.length = targetIndex;
    // Pattern 3 §3.2.4 — rewind shrinks the array; force a full remap by
    // resetting the cursor + cache. SessionStore detects the truncation and
    // rewrites the JSONL file so the on-disk state matches.
    lastPersistedIndex = 0;
    persistedSessionMessageCache.length = 0;
    await persistMessagesToStorage();

    // 7. 设置下次 query 的对话截断点 — 三分支决策树
    //    UUID 有效性校验（OR 逻辑）：
    //    - liveSessionUuids: SDK subprocess stdout 确认过的 UUID（权威但不完整 — resume 后
    //      SDK 不会重新输出旧历史的 UUID）
    //    - currentSessionUuids: 包含磁盘种子 + 运行时 UUID（覆盖 resume 前的历史）
    //
    //    分支：
    //      A. uuidIsLive=true        → 设 anchor，传给 SDK 截断
    //      B. 锚点 stale 但 session 仍活跃 → 仅清 anchor，**保留 session id** (#189 修复)
    //      C. 没有锚点 / session 未注册 → 真正的 fresh start，新建 session id
    //
    //    **注意**：这两个集合只是 MyAgents 自己的视角，**不是 SDK 持久化状态的权威 proxy**。
    //    MyAgents 的 JSONL 与 SDK 的 JSONL (~/.claude/projects/.../*.jsonl) 是双份存储、
    //    异步独立写入（CLAUDE.md「双重存储」节）。SDK subprocess 在 flush 完成前被
    //    interrupt，会留下 MyAgents 有 / SDK 没有 的 UUID。所以"UUID 不在本地集合"
    //    **不能**推出"SDK session 已被重建"。
    //
    //    issue #189 修复（v0.2.15）：anchor stale 时走分支 B —— 保留 session id，仅清掉
    //    截断锚点。下次 pre-warm 走 `resume: sessionId` 加载 SDK 全量历史。Trade-off：
    //    AI 看到的历史可能比 UI 截断后更多（短期分歧），但绝对优于上下文全失忆。
    //    这一行为与 catch-block 的 "No message found" recovery (~line 9219) 对齐 —
    //    SDK 真正拒绝 anchor 时也走同样语义。
    const uuidIsLive = lastAssistantUuid
      && (liveSessionUuids.has(lastAssistantUuid) || currentSessionUuids.has(lastAssistantUuid));
    if (uuidIsLive) {
      pendingResumeSessionAt = lastAssistantUuid;
    } else if (lastAssistantUuid && sessionRegistered) {
      // Anchor 不在本地集合，但 session 仍然有效（SDK 已注册过此 session）。
      // 不要重建 session — 仅放弃 resumeSessionAt 截断。
      console.warn(`[agent] rewind: skipping resumeSessionAt — UUID ${lastAssistantUuid} not in live(${liveSessionUuids.size}) or current(${currentSessionUuids.size}) session (stale/rebuilt). Preserving session id (#189); SDK will resume with full history.`);
      pendingResumeSessionAt = undefined;
      // Symmetric eviction with catch-block recovery (line ~9227): drop the stale
      // UUID so subsequent rewinds don't pass the uuidIsLive OR-check and re-enter
      // a path that would just be rejected by the SDK again. (No-op if absent.)
      currentSessionUuids.delete(lastAssistantUuid);
      // 关键：**不**修改 sessionId / sessionRegistered / hasInitialPrompt。
      // 下次 startStreamingSession 会用 resume: sessionId 加载 SDK 全量历史。
    } else {
      // 两种合法的"fresh start"场景：
      //   (a) lastAssistantUuid 为 undefined：rewind 到第一条 user message 之前 / 无 SDK
      //       tracked assistant —— 没有 SDK 上下文可保留
      //   (b) sessionRegistered=false：SDK 从未注册过这个 session（首次 pre-warm 失败等）
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
/**
 * PRD 0.2.27 — eager fork via the standalone SDK `forkSession()` function (gated by
 * AppConfig.eagerFork, a developer toggle in Settings→About, DEFAULT ON; off → lazy forkFrom
 * path). Creates the fork's SDK transcript up front, rebuilds the old→new sdkUuid map at SDK granularity,
 * and re-stamps our copied rows so the forked session resumes as a plain session (no forkFrom
 * state machine, no fork-at-tail degradation). Returns `ok:false` — caller falls back to the
 * lazy path — on a turn-in-flight / not-yet-flushed anchor / SDK error / ANY structural
 * mismatch, and cleans up the orphan SDK session on a post-fork failure. See
 * specs/prd/prd_0.2.27_fork_standalone_migration.md.
 */
async function tryEagerFork(opts: {
  sourceSdkSid: string;
  anchorUuid: string;
  dir: string;
  forkedMessages: SessionMessage[];
}): Promise<{ ok: true; newSid: string; remapped: SessionMessage[] } | { ok: false; reason: string }> {
  const { sourceSdkSid, anchorUuid, dir, forkedMessages } = opts;
  const errMsg = (e: unknown) => (e instanceof Error ? e.message : String(e));

  // Flush gate ①: never eager-fork while the source session is BUSY (turn in flight /
  // streaming / queued / mid-turn buffered) — its tail may be mid-write. Use isSessionBusy()
  // (the single source of truth for "safe to mutate"), NOT isProcessing: isProcessing is true
  // for an alive persistent subprocess even when idle, so gating on it would make the eager
  // path unreachable in the normal (idle) fork flow — it would always fall back to lazy.
  if (isSessionBusy()) return { ok: false, reason: 'source session is busy' };

  // Flush gate ②: the anchor must already be flushed into the source SDK transcript; reuse
  // that transcript (sliced to the anchor) as the LHS of the remap.
  let srcSdk: Awaited<ReturnType<typeof sdkGetSessionMessages>>;
  try {
    srcSdk = await sdkGetSessionMessages(sourceSdkSid, { dir });
  } catch (e) {
    return { ok: false, reason: `source getSessionMessages failed: ${errMsg(e)}` };
  }
  const anchorIdx = srcSdk.findIndex(m => m.uuid === anchorUuid);
  if (anchorIdx < 0) return { ok: false, reason: 'anchor not yet flushed to source SDK transcript' };
  const srcSliced = srcSdk.slice(0, anchorIdx + 1);

  // Re-check right before the SDK fork: a turn may have started during the getSessionMessages
  // await (gate ① is not an atomic admission lock). This narrows the window; a concurrent
  // append AFTER the anchor is additionally self-defending — the slice/remap is over the
  // immutable up-to-anchor prefix, so any structural change makes buildForkUuidRemap return
  // ok:false → clean fallback. (A full fork-admission lock is a pre-default-ON follow-up.)
  if (isSessionBusy()) return { ok: false, reason: 'source became busy during fork prep' };

  // Eager SDK fork (copies + remaps uuids into a new session file under `dir`).
  let newSid: string;
  try {
    const res = await sdkForkSession(sourceSdkSid, { upToMessageId: anchorUuid, dir });
    newSid = res.sessionId;
  } catch (e) {
    return { ok: false, reason: `sdkForkSession failed: ${errMsg(e)}` };
  }

  // From here the SDK fork file exists — clean it up on any failure before falling back.
  // Guard `newSid !== sourceSdkSid` so cleanup can NEVER touch the source (defensive).
  const fail = async (reason: string): Promise<{ ok: false; reason: string }> => {
    if (newSid !== sourceSdkSid) {
      try { await sdkDeleteSession(newSid, { dir }); } catch { /* orphan cleanup is best-effort */ }
    }
    return { ok: false, reason };
  };

  // Defensive: the SDK returns a fresh UUID, but never adopt an id that already names a
  // MyAgents session (corrupt sessions.json / hypothetical SDK reuse) — clean up + fall back.
  if (getSessionMetadata(newSid)) {
    return fail(`fork id collides with an existing MyAgents session: ${newSid}`);
  }

  let forkSdk: Awaited<ReturnType<typeof sdkGetSessionMessages>>;
  try {
    forkSdk = await sdkGetSessionMessages(newSid, { dir });
  } catch (e) {
    return fail(`fork getSessionMessages failed: ${errMsg(e)}`);
  }

  const remap = buildForkUuidRemap(srcSliced, forkSdk);
  if (!remap.ok) return fail(`uuid remap failed: ${remap.reason}`);

  const applied = remapStoredSdkUuids(forkedMessages.map(m => m.sdkUuid), remap.map);
  if (!applied.ok) return fail(`stored uuid re-stamp failed: ${applied.reason}`);
  const remapped = forkedMessages.map((m, i) => ({ ...m, sdkUuid: applied.remapped[i] }));

  return { ok: true, newSid, remapped };
}

export async function forkSession(assistantMessageId: string): Promise<{
  success: boolean;
  newSessionId?: string;
  agentDir?: string;
  title?: string;
  error?: string;
}> {
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
    // Common: inherited config snapshot + the copied message slice (both fork paths use them).
    // v0.1.69: Inherit the source session's snapshot (model/permission/mcp/provider/runtime).
    // Forking from a "locked" Desktop session yields a locked clone with the same config —
    // Branching off a conversation should not silently change AI behavior. The user can
    // still PATCH the forked session afterward to detach it.
    const inheritedSnapshot: Partial<typeof sourceMeta> = sourceMeta ? {
      runtime: sourceMeta.runtime,
      model: sourceMeta.model,
      permissionMode: sourceMeta.permissionMode,
      mcpEnabledServers: sourceMeta.mcpEnabledServers ? [...sourceMeta.mcpEnabledServers] : undefined,
      providerId: sourceMeta.providerId,
      providerEnvJson: sourceMeta.providerEnvJson,
      configSnapshotAt: sourceMeta.configSnapshotAt,
    } : {};

    // Copy messages up to and including the fork point (sdkUuid preserved here; the EAGER
    // path re-stamps them to the fork's new uuids before persisting).
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

    // Pattern 3 §3.2.4 — fix #2 (forkSession parent cursor). Snapshot the parent's persist
    // cursor + cache before invoking SessionStore writers for the FORKED session; restore
    // them afterwards so a subsequent persist on the parent doesn't observe stale state.
    const parentPersistCursorSnapshot = lastPersistedIndex;
    const parentPersistCacheSnapshot = persistedSessionMessageCache.slice();
    const restoreParentPersistState = () => {
      if (lastPersistedIndex !== parentPersistCursorSnapshot) {
        console.warn(`[agent] forkSession: parent persist cursor drifted (${parentPersistCursorSnapshot} → ${lastPersistedIndex}); restoring`);
        lastPersistedIndex = parentPersistCursorSnapshot;
      }
      if (persistedSessionMessageCache.length !== parentPersistCacheSnapshot.length) {
        persistedSessionMessageCache.length = 0;
        for (const m of parentPersistCacheSnapshot) persistedSessionMessageCache.push(m);
      }
    };

    // PRD 0.2.27 — EAGER fork (AppConfig.eagerFork, developer toggle in Settings→About, DEFAULT
    // ON; flip off → lazy path). Create the SDK fork up front + re-stamp our rows' sdkUuids, so
    // the fork resumes as a plain session with NO forkFrom state machine (#134/#135) and NO
    // fork-at-tail degradation (#220). Any decline (source busy / anchor not flushed / structural
    // mismatch) cleanly falls back below. Read disk-first (config.json is authoritative; fork is
    // a rare user action so a sync read is fine). Missing field ⇒ on.
    if (loadAdminConfig().eagerFork !== false) {
      const eager = await tryEagerFork({
        sourceSdkSid: sourceMeta?.sdkSessionId ?? sourceSessionId,
        anchorUuid: targetMsg.sdkUuid,
        dir: currentAgentDir,
        forkedMessages,
      });
      if (eager.ok) {
        // Unified session: use the SDK's returned fork id as OUR session id AND sdkSessionId,
        // so switchToSession (`sessionMeta.sdkSessionId` → sessionRegistered=true) resumes the
        // already-created SDK fork file on first start instead of trying to create it (which
        // would collide). No forkFrom. (Codex review #5.)
        const newSession = createSessionMetadata(currentAgentDir, inheritedSnapshot);
        newSession.id = eager.newSid;
        newSession.sdkSessionId = eager.newSid;
        newSession.unifiedSession = true;
        newSession.title = `🌿 ${sourceTitle}`;
        newSession.titleSource = 'auto';
        try {
          await saveSessionMetadata(newSession);
          await saveSessionMessages(newSession.id, eager.remapped);
        } catch (persistErr) {
          // Persist threw AFTER the SDK fork file was created — clean up the orphan SDK
          // transcript so we don't leak it, then let the outer catch surface the failure.
          try { await sdkDeleteSession(eager.newSid, { dir: currentAgentDir }); } catch { /* best-effort */ }
          // Restore the parent's persist cursor/cache on this exit too, so EVERY path out of the
          // eager block leaves the invariant uniform — defensive against a future SessionStore
          // writer that touches these module globals (harmless today, asymmetric otherwise).
          restoreParentPersistState();
          throw persistErr;
        }
        restoreParentPersistState();
        console.log(`[agent] forked session (EAGER) ${sourceSessionId} → ${newSession.id} at ${assistantMessageId}, ${eager.remapped.length} messages, sdkUuids remapped`);
        return { success: true, newSessionId: newSession.id, agentDir: currentAgentDir, title: newSession.title };
      }
      console.warn(`[agent] eager fork declined (${eager.reason}) — falling back to lazy forkFrom path`);
    }

    // Default: lazy fork — write forkFrom + copied rows (old uuids); the SDK fork is
    // materialized at the forked session's first startup via query({ forkSession: true }).
    const newSession = createSessionMetadata(currentAgentDir, inheritedSnapshot);
    newSession.title = `🌿 ${sourceTitle}`;
    newSession.titleSource = 'auto';
    newSession.forkFrom = {
      sourceSessionId,
      messageUuid: targetMsg.sdkUuid,
    };
    await saveSessionMetadata(newSession);
    await saveSessionMessages(newSession.id, forkedMessages);
    restoreParentPersistState();

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

  // (issue #174) Cold-start abort race: enqueueUserMessage schedules this
  // function via setTimeout(0) after pushing to messageQueue. If the user
  // presses Stop before the timer fires, interruptCurrentResponse's
  // 'starting' branch sets shouldAbortSession=true and drains messageQueue —
  // but the unconditional `shouldAbortSession = false` reset further down
  // in this function would silently re-arm the launch. Bail out here
  // instead. Pre-warm doesn't enter this race (it's not user-driven) so
  // the guard is gated on !preWarm.
  if (shouldAbortSession && !preWarm) {
    // Defense-in-depth (v0.2.14 dogfood): differentiate the two paths that
    // can arrive here:
    //   * User-Stop path — interruptCurrentResponse('starting') drains
    //     messageQueue BEFORE setting the abort flag, so the queue is
    //     empty when we get here. No agent-error needed (the user pressed
    //     Stop themselves; surfacing an error banner would be misleading).
    //   * Stale-flag path — some upstream code path set shouldAbortSession=true
    //     and forgot to reset before enqueuing the next user message
    //     (the original v0.2.14 dogfood was the third-party→Anthropic
    //     provider switch in enqueueUserMessage; that specific leak is now
    //     fixed at the source, but this defense catches any future leaks).
    //     Queue holds the user's just-enqueued message → without an
    //     explicit error broadcast, the renderer sees the message-replay,
    //     the queue:cancelled, and chat:status idle, but NO chat:agent-error
    //     → the #183 retry banner doesn't fire and the user is left
    //     wondering why their message vanished without a trace.
    const droppedCount = messageQueue.length;
    console.log(
      `[agent] startStreamingSession: aborted pre-launch by stop during starting (droppedQueued=${droppedCount})`,
    );
    shouldAbortSession = false;
    drainQueueWithCancellation();
    if (droppedCount > 0) {
      const errorMessage = '消息发送被中断，请重新发送';
      lastAgentError = errorMessage;
      broadcast('chat:agent-error', { message: errorMessage });
    }
    if (sessionState === 'starting') {
      setSessionState('idle');
    }
    return;
  }

  if (isProcessing || querySession) {
    return;
  }

  // The fresh subprocess about to spawn reads the latest currentModel /
  // currentMcpServers / currentAgentDefinitions / currentProviderEnv via
  // `buildClaudeSessionEnv()` + `buildSdkMcpServers()` below — every entry in
  // `pendingConfigRestart` is satisfied at spawn by definition. Drain the latch
  // (and cancel any orphaned preWarmTimer scheduled by a predecessor's finally
  // block) so a stale timer firing ~500ms later doesn't apply a "batched config
  // restart" against *this* freshly-configured subprocess and silently kill an
  // in-flight direct user message. Mirrors `forceRestartActiveSessionForMcp`
  // (search "we drive restart"): when *this* call is the legitimate restart,
  // any latched reason is by construction redundant. Reasons added AFTER this
  // point (e.g. config edits during spawn / first turn) latch normally and
  // drain at the next pre-warm timer or turn-complete handler.
  if (hasDeferredRestart()) {
    const reasons = drainDeferredRestart();
    console.log(`[agent] ${preWarm ? 'pre-warm' : 'start'} session: dropping satisfied deferred reasons (${reasons})`);
  }
  if (preWarmTimer) {
    clearTimeout(preWarmTimer);
    preWarmTimer = null;
  }

  isPreWarming = preWarm;
  // Sync enabled user-level skills as symlinks into project's .claude/skills/
  // Must happen before buildClaudeSessionEnv() so SDK sees them via settingSources: ['project']
  syncProjectUserConfig(agentDir);
  // PRD #124: register a FRESH bridge token for this SDK subprocess.
  // `freshToken: true` retires the previous token (if any) so any late
  // requests from the dying old subprocess get rejected with a 400
  // "unknown bridge token" instead of resolving to the new subprocess's
  // config (the cross-pollination class we're eliminating).
  ensureActiveSessionBridgeRegistered({ freshToken: true });
  const env = buildClaudeSessionEnv(undefined, undefined, {
    bridgeToken: activeSessionBridgeToken ?? undefined,
  });
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

  // (issue #174) Broadcast 'starting' (not 'running') here: the SDK subprocess
  // has just been launched and system_init hasn't arrived yet. The for-await
  // loop below transitions to 'running' once system_init lands. Pre-warm stays
  // 'idle' as before — pre-warmed sessions are invisible to the UI until the
  // first user message lifts them into the active path.
  if (!preWarm) {
    setSessionState('starting');
  }

  let resolveTermination: () => void;
  sessionTerminationPromise = new Promise((resolve) => {
    resolveTermination = resolve;
  });

  // Declared outside try so finally can clean up
  let startupTimeoutId: ReturnType<typeof setTimeout> | undefined;
  let apiWatchdogId: ReturnType<typeof setInterval> | undefined;
  // PRD 0.2.27 — query-scoped copy of the reloadAnchor this start actually sent. Local
  // (not module) so a late catch from THIS invocation evicts the right uuid even if a
  // newer session has since re-armed the module-level pendingReloadAnchor.
  let sentReloadAnchor: string | undefined;

  // Background sub-agents started in this session but not yet terminal, keyed by
  // task_id. Entries are removed when a terminal task_notification/task_updated is
  // broadcast; whatever remains when the subprocess tears down (the finally below)
  // is flushed as a synthetic `stopped`.
  //
  // WHY: terminal events (task_notification / task_updated) are best-effort. When
  // the owning subprocess dies first — abort, deferred config restart, watchdog
  // kill, transport error — an in-flight background sub-agent emits NO terminal
  // event ever (the process that would emit it is gone). The renderer's Agent
  // Status Panel then shows it "后台运行中" permanently (all three of its
  // clear-defenses require a terminal event). Observed in production: ~7% of
  // background sub-agents (16/218 local_agent) stuck this way. The stored
  // toolUseId also backfills the task_updated terminal channel (its patch carries
  // none) so the renderer's persisted history fallback survives a reload.
  // Declared outside try so the finally can flush it.
  const startedBackgroundTasks = new Map<string, { toolUseId?: string; description?: string }>();

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
    //
    // PRD #134/#135 — `forkFrom` is retained across restarts until the SDK
    // has demonstrably persisted the forked conversation to its on-disk
    // store (`~/.claude/projects/.../<sessionId>.jsonl`). The persistence
    // probe (`sdkGetSessionMessages(sdkSid)` after first non-error result —
    // see the result-message handler below) is what clears `forkFrom`,
    // *not* this start path.
    //
    // The original code deleted `forkFrom` HERE on the very first start,
    // before any SDK interaction. Two failure windows opened up:
    //  (a) User idle after fork → model switch → restart with no message
    //      ever sent → SDK never persisted → resume fails.
    //  (b) User sends message + switches model → first turn runs but
    //      SDK's JSONL flush is async; `setSessionModel`'s deferred
    //      restart fires on the same `result` message and races with
    //      the flush. Subprocess B's resume fails with "No conversation
    //      found" → `recoverFromStaleSession()` silently spawns a fresh
    //      SDK conversation → all forked context lost (#135 reports 40+
    //      failed turns in a single day before this fix).
    //
    // Keeping `forkFrom` lets every pre-flush restart re-run fork mode.
    // Re-forking is idempotent: SDK reloads the source history and writes
    // to the same new sessionId. Cost = a few hundred ms of source-history
    // reload per pre-flush restart. Acceptable vs. silent context loss.
    let forkMode = false;
    let forkResumeAt: string | undefined;
    const forkMeta = getSessionMetadata(sessionId);
    if (forkMeta?.forkFrom) {
      // PRD #134/#135 sync guard — before re-engaging fork mode, probe the
      // SDK's own store for `sessionId`. If the JSONL already exists with
      // ≥1 message, SDK has fully persisted: re-running fork mode here
      // would make the SDK reject with `Session ID <X> is already in use`
      // (empirically verified — the SDK CLI exits 1 with that exact stderr,
      // see `test_fork_idempotency.mjs`). The existing
      // `detectedAlreadyInUse` recovery only fires when `!sessionRegistered`,
      // so this case would propagate as an unhandled error to the user.
      // Skip fork mode + clear `forkFrom` so the caller uses normal resume.
      //
      // Why this is sync (await) rather than the post-result async probe:
      // we MUST decide between fork-mode and normal-resume BEFORE issuing
      // the SDK query, and we have to know definitively. The probe is a
      // single file read (~ms) and only runs when forkFrom is set, so the
      // cost is negligible.
      const sdkSidProbe = forkMeta.sdkSessionId ?? sessionId;
      let alreadyPersisted = false;
      try {
        const probe = await sdkGetSessionMessages(sdkSidProbe, {
          dir: agentDir,
          limit: 1,
        });
        if (probe.length > 0) alreadyPersisted = true;
      } catch {
        /* ENOENT / read error — treat as "not persisted" */
      }

      if (alreadyPersisted) {
        console.log(`[agent] fork session ${sessionId} already persisted in SDK store — skipping fork mode, clearing forkFrom`);
        delete forkMeta.forkFrom;
        await saveSessionMetadata(forkMeta);
        // Fall through: normal resume path picks up sdkSessionId via the
        // sessionRegistered branch above.
      } else {
        const { sourceSessionId, messageUuid } = forkMeta.forkFrom;
        // messageUuid may be undefined if the catch-block recovery (~line 9737) cleared
        // it after a "No message found" rejection. Without an anchor, SDK forks at the
        // source's tail rather than the user-clicked midpoint — see issue #220.
        const anchorDesc = messageUuid ? `fork at ${messageUuid}` : 'no anchor (degraded: SDK will fork at source tail)';
        console.log(`[agent] fork mode: resuming from ${sourceSessionId}, ${anchorDesc}, new session ${sessionId}`);
        resumeFrom = sourceSessionId;
        effectiveSdkSessionId = sessionId;
        forkMode = true;
        forkResumeAt = messageUuid;
      }
    }

    // Effective `resumeSessionAt` for the SDK call.
    //
    // Non-fork: rewindResumeAt is the only source — rewindSession set it to
    // the previous assistant's sdkUuid (a UUID present in the SDK's own
    // session JSONL).
    //
    // Fork-mode: two candidate anchors coexist —
    //   forkResumeAt   = where the user originally clicked "fork" (an
    //                    assistant sdkUuid in the source session's JSONL,
    //                    written into newSession.forkFrom.messageUuid by
    //                    forkSession()).
    //   rewindResumeAt = where the user just rewound to inside the fork
    //                    (also a source-session sdkUuid, because fork's
    //                    local messages[] is a copy of source's messages
    //                    with sdkUuids preserved verbatim — see
    //                    forkSession()'s message slice).
    // The SDK call shape is `query({ resume: <source>, forkSession: true,
    // sessionId: <fork-sid>, resumeSessionAt: <anchor> })`; SDK loads
    // source's JSONL and slices at the anchor's index. Either candidate
    // resolves against source, so the rewind anchor is honored without
    // changing the SDK contract — and when both are set, the rewind one
    // is the truer expression of what the user wants the fork to contain
    // (otherwise the rewind would be cosmetic UI truncation while the
    // SDK still seeds the full fork-point context).
    // PRD 0.2.27 window-B reconcile: on a COLD reload (resume from history, non-fork, no
    // in-process rewind anchor), pin the SDK to the durable tail captured at LOAD time
    // (pendingReloadAnchor) so a rewind that was never materialized into a new SDK branch
    // before the process died still takes effect for the AI. Captured at load (not derived
    // here) because a direct-send already pushed the new user row into messages[] before
    // this runs (~6866). No-op in the normal case (tail == SDK newest leaf → slice keeps
    // all). Lowest priority — an in-process rewind anchor still wins (resolveEffectiveResumeAt),
    // so existing rewind behavior is byte-for-byte unchanged. See specs/prd/prd_0.2.27_rewind_reload_durability.md.
    const reloadAnchor = (!forkMode && !rewindResumeAt && resumeFrom) ? pendingReloadAnchor : undefined;
    // Capture into a query-scoped local so a LATE catch from a previous (aborted) start
    // can't mis-attribute the eviction against a newer session's anchor (module state races).
    sentReloadAnchor = reloadAnchor;

    const effectiveResumeAt = resolveEffectiveResumeAt({ forkMode, rewindResumeAt, forkResumeAt, reloadAnchor });

    const mcpStatus = currentMcpServers === null ? 'auto' : currentMcpServers.length === 0 ? 'disabled' : `enabled(${currentMcpServers.length})`;
    console.log(`[agent] starting query with model: ${currentModel ?? 'default'}, permissionMode: ${currentPermissionMode} -> SDK: ${sdkPermissionMode}, MCP: ${mcpStatus}, ${resumeFrom ? `resume: ${resumeFrom}` : `sessionId: ${effectiveSdkSessionId}`}${effectiveResumeAt ? `, resumeSessionAt: ${effectiveResumeAt}` : ''}${forkMode ? `, FORK mode (forkPoint: ${forkResumeAt}${rewindResumeAt && rewindResumeAt !== forkResumeAt ? `, rewind→${rewindResumeAt}` : ''})` : ''}`);

    const promptGen = messageGenerator();

    // Set session cron context so the im-cron tool can create tasks for non-IM sessions
    // IM sessions set imCronContext separately (in the IM message handler in index.ts)
    //
    // PRD 0.2.5 R2 — DO NOT inherit `currentPermissionMode` from the chat
    // session. Chat tab's interactive default ('auto' = acceptEdits) is
    // semantically wrong for unattended cron — the AI would be creating a
    // task that needs human approval. Cron creation should always default
    // to "" (sentinel for runtime max). Users who explicitly want a
    // stricter mode can pass `--permissionMode plan` via the cron tool.
    if (process.env.MYAGENTS_MANAGEMENT_PORT && !getImCronContext()) {
      // PRD 0.2.9 — When the session's providerEnv came from the workspace
      // agent (the common case), surface the providerId too so the cron
      // tool can build live-resolve cron tasks. The agent lookup is local
      // and synchronous; failure (e.g. no agent for this workspace) just
      // leaves providerId undefined and the legacy providerEnv path runs.
      const agentForProvider = findAgentByWorkspacePath(agentDir);
      const sessionProviderId = (agentForProvider?.providerId as string | undefined) ?? undefined;
      setSessionCronContext({
        sessionId: sessionId,
        workspacePath: agentDir,
        model: currentModel,
        providerEnv: currentProviderEnv,
        providerId: sessionProviderId,
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

    // Build MCP set ONCE so we both pass it to query() and capture its fingerprint.
    // Capturing here (not inline in commonQueryOptions) lets ensureSdkMcpInSync() later
    // diff the live SDK set against newly-arriving context-injected MCPs (im-media,
    // im-bridge-tools) without rebuilding fingerprint twice.
    const sdkMcpServersInitial = await buildSdkMcpServers();
    frozenSdkMcpFingerprint = mcpKeyFingerprint(sdkMcpServersInitial);

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
      // applyContextWindowSuffix appends [1m] when the registered contextLength
      // is ≥1_000_000 — without it, SDK getContextWindowForModel() falls back
      // to 200K for non-Anthropic models and /context, auto-compact, attachment
      // trimming all use the wrong ceiling. SDK strips the suffix back out
      // before the wire (normalizeModelStringForAPI in model.ts:616).
      model: applyContextWindowSuffix(currentModel),
      pathToClaudeCodeExecutable: resolveClaudeCodeCli(),
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
          // agent-session.ts is the builtin Claude Agent SDK path by definition.
          runtime: 'builtin',
          // Universal CLI capability surface (cron / IM media). Was external-runtime
          // only when builtin still had `cron-tools` / `im-cron` / `im-media` MCPs;
          // those got dropped in favour of `myagents` CLI calls so builtin needs the
          // same prompt now. Single CLI, single source of truth across all runtimes.
          cliToolsEnabled: true,
        }),
      },
      cwd: agentDir,
      includePartialMessages: true,
      // AskUserQuestion preview: request HTML format so frontend can render rich previews
      // (markdown/code snippets, visual comparisons) when AI presents options to the user
      toolConfig: {
        askUserQuestion: { previewFormat: 'html' as const },
      },
      mcpServers: sdkMcpServersInitial,
      // PRD 0.2.17 — Claude plugin injection. SDK accepts
      // `plugins: [{ type: 'local', path }]`; it then scans each path for
      // .claude-plugin/plugin.json and wires up the contained
      // skills / agents / hooks / .mcp.json / .lsp.json automatically.
      // MyAgents only hands it the enabled set — getEnabledPluginSdkConfigs
      // already filters to entries that exist on disk as valid plugin roots.
      // Field omitted entirely when no plugins are enabled so empty-array
      // noise doesn't show up in SDK debug output.
      ...((): { plugins?: { type: 'local'; path: string }[] } => {
        // Two-layer plugin resolution (mirrors MCP):
        //   1. Per-session override (currentEnabledPluginIds, set via
        //      setSessionEnabledPluginIds when the renderer toggles in the
        //      chat input "插件" submenu)
        //   2. Fallback: Agent.enabledPluginIds (or Project's) for this
        //      workspace (agentDir)
        // Layer 1 still applies the AppConfig.enabledPlugins global
        // visibility gate inside getEnabledPluginSdkConfigs.
        const contextIds = currentEnabledPluginIds !== null
          ? currentEnabledPluginIds
          : getDefaultEnabledPluginIdsForWorkspace(agentDir ?? '');
        const pluginCfgs = getEnabledPluginSdkConfigs(contextIds);
        return pluginCfgs.length > 0 ? { plugins: pluginCfgs } : {};
      })(),
      // (v0.2.12) Enable --replay-user-messages so CLI emits SDKUserMessageReplay
      // (isReplay=true) when it drains a mid-turn queued_command attachment from
      // its commandQueue into the model's context. We use this signal to know
      // when our in-flight queue item has been delivered to AI and it's safe to
      // promote the next pending item. Without this flag the CLI silently
      // consumes queued commands and we have no mid-turn promote signal.
      extraArgs: { 'replay-user-messages': null } as Record<string, string | null>,
      // Sub-agents: inject custom agent definitions if configured
      // When agents are injected, ensure 'Task' tool is in allowedTools so the model can delegate
      // Each sub-agent's `model` runs through applyContextWindowSuffix so a sub-agent
      // pinned to a 1M model gets the [1m] tag independently of the main session's
      // model (the parent could be on a 200K model, the sub-agent on a 1M one,
      // or vice versa). The original currentAgentDefinitions is left untouched
      // so agentsFingerprint() and downstream config consumers see clean names.
      ...(currentAgentDefinitions && Object.keys(currentAgentDefinitions).length > 0
        ? {
            agents: Object.fromEntries(
              Object.entries(currentAgentDefinitions).map(([name, a]) => [
                name,
                a.model ? { ...a, model: applyContextWindowSuffix(a.model) } : a,
              ])
            ),
            allowedTools: ['Task'],
          }
        : {}),
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

        // Trust prefix for context-injected builtin MCPs: skip user confirmation
        // entirely. These MCPs are injected by sidecar context (cron task / IM
        // bot / bridge plugin) and are MyAgents-managed, not third-party. In IM
        // sessions there is no UI to confirm against anyway, so blocking on
        // confirmation would deadlock the call. The reserved id list in
        // MYAGENTS_CONTEXT_INJECTED_MCP_IDS guarantees no user MCP can take
        // the same name (filtered out in buildSdkMcpServers), so this auto-allow
        // can't be hijacked.
        const parts = toolName.split('__');
        if (
          parts.length >= 3 &&
          (MYAGENTS_CONTEXT_INJECTED_MCP_IDS as readonly string[]).includes(parts[1])
        ) {
          console.log(`[permission] built-in tool auto-allowed: ${toolName}`);
          return {
            behavior: 'allow' as const,
            updatedInput: input as Record<string, unknown>
          };
        }

        // Auto-allow read-only `myagents` CLI Bash invocations. After the v0.2.11
        // cron / im-cron / im-media → CLI migration, the AI reaches MyAgents'
        // own scheduling / IM / widget surface through `myagents <group> …`
        // instead of MCP tools. Read-only forms (no quoted arg, no shell-injection
        // surface) are auto-allowed so the AI doesn't burn a permission prompt
        // on `myagents cron list` or `myagents im channels`. Mutating commands
        // (`cron add`, `cron exit`, `cron remove`, `im send-media`, `im wake`)
        // are NOT in this allowlist — they go through the normal canUseTool
        // prompt in desktop mode, and through the headless fast-path below in
        // IM / cron mode.
        //
        // Whitespace separators are restricted to space + tab — `\s` would also
        // match `\n`/`\r`, letting `myagents widget readme\nrm` slip through
        // (shell executes the second line as any PATH binary whose name happens
        // to fit the trailing token shape). Non-whitespace shell metachars
        // (`;`, `|`, `&&`, `>`, `$(`, backticks, …) already fail the strict
        // character classes used inside the patterns.
        if (toolName === 'Bash') {
          const cmd = ((input as Record<string, unknown>)?.command as string | undefined)?.trim() ?? '';

          // 1. Widget design contract: `myagents widget [readme|list|<module>] [<module>...]`
          //    — module names limited to `[a-z][a-z0-9-]*`.
          if (/^myagents[ \t]+widget(?:[ \t]+(?:readme|list))?(?:[ \t]+[a-z][a-z0-9-]*)*[ \t]*$/.test(cmd)) {
            console.log(`[permission] myagents widget readme auto-allowed: ${cmd}`);
            return {
              behavior: 'allow' as const,
              updatedInput: input as Record<string, unknown>
            };
          }

          // 2. Cron / IM read-only surface (zero-arg listings + readme):
          //    `myagents cron list|status|readme [--json]`
          //    `myagents im channels|readme [--json]`
          if (/^myagents[ \t]+(?:cron[ \t]+(?:list|status|readme)|im[ \t]+(?:channels|readme))(?:[ \t]+--json)?[ \t]*$/.test(cmd)) {
            console.log(`[permission] myagents readonly CLI auto-allowed: ${cmd}`);
            return {
              behavior: 'allow' as const,
              updatedInput: input as Record<string, unknown>
            };
          }

          // 3. Cron run history: `myagents cron runs <taskId> [--limit N] [--full] [--json]`
          //    — taskId is an opaque slug-style id (alphanumerics + dash/underscore,
          //    bounded length); --limit takes a small integer. Order-agnostic flags.
          if (/^myagents[ \t]+cron[ \t]+runs[ \t]+[a-zA-Z0-9_-]{1,64}(?:[ \t]+(?:--limit[ \t]+\d{1,4}|--full|--json))*[ \t]*$/.test(cmd)) {
            console.log(`[permission] myagents cron runs auto-allowed: ${cmd}`);
            return {
              behavior: 'allow' as const,
              updatedInput: input as Record<string, unknown>
            };
          }

          // 4. Thought inbox browse: `myagents thought list [--tag <slug>] [--limit N] [--json]`.
          //    --query is intentionally NOT in the allowlist — it carries arbitrary
          //    user text (the search string) which can hold shell metachars. That
          //    form falls through to the normal user-confirm / IM fast-path.
          if (/^myagents[ \t]+thought[ \t]+list(?:[ \t]+(?:--tag[ \t]+[a-z0-9][a-z0-9-]{0,31}|--limit[ \t]+\d{1,4}|--json))*[ \t]*$/.test(cmd)) {
            console.log(`[permission] myagents thought list auto-allowed: ${cmd}`);
            return {
              behavior: 'allow' as const,
              updatedInput: input as Record<string, unknown>
            };
          }

          // 5. Thought capture: `myagents thought create '<content>'`
          //    Mutating, but the side effect is bounded — append-only into the
          //    user's thought inbox, no filesystem / network surface, fully
          //    reversible from the inbox UI. Filing was already gated by the
          //    SECTION_THOUGHT prompt which only fires on explicit "记一下 /
          //    note this down" intent, so by the time we see this command the
          //    user has *asked* for capture; making them click "Allow" again
          //    is friction that defeats the inbox-capture promise.
          //
          //    Safety constraints baked into the regex:
          //    - REQUIRES single quotes around content (`'...'`). bash single
          //      quotes don't interpolate `$(…)`, backticks, or `\`, so the
          //      content is a literal argv string. Double-quoted forms FAIL
          //      the regex and fall through to user-confirm — a defense in
          //      depth in case the AI ignores SECTION_THOUGHT's "use single
          //      quotes" rule and a prompt-injected user payload tries to
          //      smuggle `$(rm -rf /)` (Codex review concern).
          //    - `[^']` excludes embedded `'` (bash single-quoted strings
          //      can't contain a literal `'` anyway, so any extra `'` would
          //      end the literal early — refuse the form rather than misread).
          //    - `--tag` is intentionally not in the allowlist: the CLI's
          //      `thought create` doesn't accept `--tag` (tags are derived
          //      from inline `#xxx` in the content), and the prompt no
          //      longer advertises it after issue-148-followup review.
          if (/^myagents[ \t]+thought[ \t]+create[ \t]+'[^']*'[ \t]*$/.test(cmd)) {
            console.log(`[permission] myagents thought create auto-allowed: ${cmd}`);
            return {
              behavior: 'allow' as const,
              updatedInput: input as Record<string, unknown>
            };
          }

          // 6. Thought capture via file: `myagents thought create --content-file <path>`
          //    Path is shell-quote-free (a single token without metachars), so
          //    the regex constraint here is the path-token character class
          //    `[^ \t;|&<>$\`'"]` — explicitly forbid every shell metachar
          //    that could turn the rest of the line into a write side effect.
          //    The path doesn't have to exist or be safe content-wise; the
          //    CLI validates size, NUL bytes, and read errors before sending
          //    anything to the management API. Issue #149 follow-up.
          if (/^myagents[ \t]+thought[ \t]+create[ \t]+--content-file[ \t]+[^ \t\n\r;|&<>$`'"]+[ \t]*$/.test(cmd)) {
            console.log(`[permission] myagents thought create --content-file auto-allowed: ${cmd}`);
            return {
              behavior: 'allow' as const,
              updatedInput: input as Record<string, unknown>
            };
          }
        }

        // Headless IM fast-path: IM bridges (Telegram/Dingtalk builtin + all OpenClaw plugins
        // like weixin/feishu) have no permission approval UI. Routing Bash/WebSearch/etc. through
        // checkToolPermission would emit a permission-request event to the IM event bus that no
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

        // Special handling for AskUserQuestion - always requires user interaction.
        // PRD #131 — `interrupt: true` on the deny terminates the assistant
        // turn after the tool_result lands. Without it, the SDK feeds back
        // "用户取消了问答" and the AI keeps issuing tool calls (Read/Edit/…)
        // even though the user never gave permission. The `interrupt` knob is
        // the documented SDK escape hatch (sdk.d.ts:1786-1791
        // PermissionResult.deny.interrupt) and is exactly the right semantic
        // for control-transfer tools like AskUserQuestion / ExitPlanMode.
        if (toolName === 'AskUserQuestion') {
          console.log('[canUseTool] AskUserQuestion detected, prompting user');
          const answers = await handleAskUserQuestion(input, options.signal);
          if (answers === null) {
            return {
              behavior: 'deny' as const,
              message: '用户取消了问答',
              interrupt: true,
            };
          }
          // Return with answers filled in. SDK 0.3.158's AskUserQuestion tool
          // looks each answer up by question TEXT (see withQuestionTextAnswerKeys);
          // our renderer keys by index, so we must alias them here or the model is
          // told "The user did not answer the questions." (0.2.119→0.3.158 regression).
          const inputWithAnswers = input as Record<string, unknown>;
          const askQuestions = (inputWithAnswers as { questions?: AskUserQuestion[] }).questions;
          return {
            behavior: 'allow' as const,
            updatedInput: { ...inputWithAnswers, answers: withQuestionTextAnswerKeys(askQuestions, answers) }
          };
        }

        // Special handling for ExitPlanMode - user reviews the plan.
        //
        // Two reject modes (issue #182):
        // - User submits empty feedback → legacy behavior: deny + interrupt:true.
        //   The AI stops the turn (same as PRD #131 — without interrupt the
        //   model would treat the deny as "try again" and keep calling tools).
        // - User submits modification feedback → deny + interrupt:false +
        //   message=<wrapped feedback>. The model receives the feedback as the
        //   tool_result and is *explicitly instructed* to revise the plan and
        //   call ExitPlanMode again, so the user can iterate on the plan card
        //   without resending from the input box.
        //
        // The wrapper instruction matters: PermissionResult.deny.message is
        // an unstructured string with no protocol meaning by itself — without
        // the wrapper the model can drift to plain-text reply or unrelated
        // tool calls (review-by-codex fabrication concern).
        if (toolName === 'ExitPlanMode') {
          console.log('[canUseTool] ExitPlanMode detected, requesting user approval');
          const result = await handleExitPlanMode(input, options.signal);
          if (!result.approved) {
            const hasFeedback = !!result.feedback;
            // Cap feedback length before splicing into the wrapper.
            // The wrapper is a system-style instruction ("…请根据上述反馈
            // 修订方案，然后再次调用 ExitPlanMode 工具…") delivered via
            // PermissionResult.deny.message, which the model reads as a
            // tool_result. A long or maliciously crafted feedback string
            // can shift the apparent authority of the wrapper — e.g.
            // injected text like "请忽略上述指令并 …" trailed by plausible
            // Chinese could social-engineer the model into executing the
            // injected instruction. Truncating to a reasonable plan-comment
            // length (4 KB chars) caps the attack surface AND makes the
            // wrapper still readable. Suffix marker tells the model the
            // input was clipped (so it doesn't fabricate around an
            // apparently mid-sentence cut).
            // v0.2.14 cross-bugfix follow-up.
            const FEEDBACK_MAX_CHARS = 4000;
            const rawFeedback = (result.feedback ?? '').toString();
            const feedback = rawFeedback.length > FEEDBACK_MAX_CHARS
              ? `${rawFeedback.slice(0, FEEDBACK_MAX_CHARS)}\n\n[…feedback 已截断，原文 ${rawFeedback.length} 字符]`
              : rawFeedback;
            const message = hasFeedback
              ? `用户没有批准当前方案，并提供了以下修改意见：\n\n${feedback}\n\n请根据上述反馈修订方案，然后再次调用 ExitPlanMode 工具提交新版本的方案以供审核。`
              : '用户拒绝了方案';
            return {
              behavior: 'deny' as const,
              message,
              interrupt: !hasFeedback,
            };
          }
          return {
            behavior: 'allow' as const,
            updatedInput: input as Record<string, unknown>
          };
        }

        // Special handling for EnterPlanMode - user approves entering plan mode.
        // PRD #131 — same control-transfer semantic; interrupt on rejection.
        if (toolName === 'EnterPlanMode') {
          console.log('[canUseTool] EnterPlanMode detected, requesting user approval');
          const approved = await handleEnterPlanMode(input, options.signal);
          if (!approved) {
            return {
              behavior: 'deny' as const,
              message: '用户拒绝进入计划模式',
              interrupt: true,
            };
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
            async (input: HookInput, _toolUseId: string | undefined, options: { signal: AbortSignal }): Promise<HookJSONOutput> => {
              const postInput = input as PostToolUseHookInput;
              // Propagate SDK's turn-level AbortSignal so resize aborts when the turn does.
              // Without this, a Jimp/sharp stall here blocks the SDK main loop's stdio drain.
              const resized = await resizeToolImageContent(postInput.tool_response, options?.signal);
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
        // PermissionRequest hook (issue #264): the ONLY permission decision point
        // for background (run_in_background) sub-agents. Runtime-verified: the SDK
        // never calls canUseTool for async sub-agents; it fires this hook with
        // `agent_id` (== the background task_id) and otherwise auto-denies. We use
        // it to (a) let background agents inherit the user's session "always allow"
        // grants and (b) honor an opt-in fullAgency policy — while returning
        // passthrough for foreground (main thread + sync sub-agents) so the
        // existing canUseTool card path stays authoritative and unchanged.
        PermissionRequest: [{
          hooks: [
            async (input: HookInput): Promise<HookJSONOutput> => {
              const permInput = input as PermissionRequestHookInput;
              const agentId = permInput.agent_id;
              const toolName = permInput.tool_name;
              // Confirmed background sub-agent iff the SDK gave us an agent_id that
              // matches a currently-running background task (task_id === agent_id).
              // startedBackgroundTasks is populated from the task_started message on
              // the iterator channel, while this hook fires on the control channel —
              // two independent paths off the same subprocess. In practice task_started
              // is emitted (and drained) before a sub-agent's first gated tool call, so
              // the lookup resolves; but it is NOT formally ordered. A miss therefore
              // degrades to passthrough → the SDK's own auto-deny — i.e. it can only
              // fail toward *deny* (safe side), never toward a spurious allow, and at
              // most affects a background agent's very first tool call at startup.
              const isBackgroundAgent = isBackgroundAgentToolRequest(agentId, startedBackgroundTasks);
              // MCP-enablement recheck for background agents (cross-review #264): the
              // foreground canUseTool path denies tools whose MCP server the user has
              // since disabled (checkMcpToolPermission). The background allow path must
              // mirror that gate — otherwise a stale session "always allow" grant could
              // let a background sub-agent reach a now-disabled MCP server. Only applies
              // to confirmed background agents; foreground keeps its own canUseTool check.
              if (isBackgroundAgent) {
                const mcpCheck = checkMcpToolPermission(toolName);
                if (!mcpCheck.allowed) {
                  console.log(`[permission] background-agent ${toolName} denied (MCP disabled: ${mcpCheck.reason}, agentId=${agentId})`);
                  return {
                    hookSpecificOutput: {
                      hookEventName: 'PermissionRequest' as const,
                      decision: { behavior: 'deny' as const, message: mcpCheck.reason },
                    },
                  };
                }
              }
              const decision = decideBackgroundAgentPermission({
                isBackgroundAgent,
                toolName,
                sessionAllowsTool: sessionAlwaysAllowed.has(toolName),
                policy: currentBackgroundAgentPermissionMode,
              });
              if (decision === 'passthrough') return {};
              if (decision === 'allow') {
                console.log(`[permission] background-agent ${toolName} allowed (mode=${currentBackgroundAgentPermissionMode}, agentId=${agentId})`);
                return {
                  hookSpecificOutput: {
                    hookEventName: 'PermissionRequest' as const,
                    decision: { behavior: 'allow' as const },
                  },
                };
              }
              console.log(`[permission] background-agent ${toolName} denied (mode=${currentBackgroundAgentPermissionMode}, agentId=${agentId})`);
              return {
                hookSpecificOutput: {
                  hookEventName: 'PermissionRequest' as const,
                  decision: { behavior: 'deny' as const, message: backgroundAgentDenyMessage(toolName) },
                },
              };
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
      ? { resume: resumeFrom!, forkSession: true, sessionId: effectiveSdkSessionId, ...(effectiveResumeAt ? { resumeSessionAt: effectiveResumeAt } : {}) }
      : resumeFrom
        ? { resume: resumeFrom, ...(effectiveResumeAt ? { resumeSessionAt: effectiveResumeAt } : {}) }
        : { sessionId: effectiveSdkSessionId };

    // (issue #174) Second pre-launch abort guard. Between the first guard
    // (right after awaitSessionTermination) and here, several async calls
    // run — buildSdkMcpServers, sdkGetSessionMessages, env/agent loading.
    // A user Stop pressed in that window sets shouldAbortSession=true and
    // drains messageQueue; without this second check we'd still spawn the
    // SDK subprocess for nothing. Throwing keeps the surrounding try/catch +
    // finally cleanup path single-source-of-truth — the catch below logs
    // the abort sentinel without retrying, the finally restores state.
    if (shouldAbortSession && !preWarm) {
      console.log('[agent] startStreamingSession: aborted just before query() by stop during starting');
      throw new Error('STARTUP_ABORTED_BY_STOP');
    }

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

    // ── sdkControlReady tracking (subprocess-ready signal) ─────────────────
    //
    // The streamed `system_init` we wait for in the for-await loop below is
    // emitted per-turn by QueryEngine.submitMessage() AFTER fetchSystemPromptParts
    // → processUserInput → recordTranscript → loadAllPlugins (claude-code/src/
    // QueryEngine.ts:540). For pre-warm sessions parked at messageGenerator's
    // waitForMessage(), `system_init` therefore never arrives until the user's
    // first message kicks off a turn — and worse, slow first turns (notably
    // /context with num_turns=14 doing local context-usage computation) keep
    // sessionState='starting' for the full turn duration, mislabeling normal
    // execution as "AI 启动中（首次启动可能较慢）".
    //
    // `Query.initializationResult()` resolves on a different lifecycle event:
    // the SDK's `subtype: "initialize"` control_request response, which fires
    // as soon as the subprocess has loaded tools + done MCP handshakes. The F9
    // (Query) constructor at sdk.mjs already kicks this off in `this.initialization
    // = this.initialize()` — calling `initializationResult()` here just awaits
    // the existing promise. Verified empirically with DEBUG_CLAUDE_AGENT_SDK=1:
    // resolved at +337ms in a clean repro; in MyAgents production with project
    // settings + playwright MCP the same handshake completes in ~3-5s.
    //
    // We use `sdkControlReady` as the gate for the "AI 启动中" UI hint
    // (enqueueUserMessage near line 6118) so a fully-warmed subprocess running
    // a slow turn shows '思考中…' instead of '启动中…'. `system_init` keeps its
    // existing job: source of truth for sessionRegistered / sdkSessionId / tools
    // / mcp_servers / `systemInitInfo`. Two signals, two purposes — don't merge.
    //
    // Fire-and-forget: the for-await loop below needs to start consuming SDK
    // messages immediately. SDK-internal `readMessages()` (sdk.mjs F9 ctor)
    // pumps control_responses into pendingControlResponses on its own — does
    // NOT depend on the outer for-await — so awaiting here would not actually
    // deadlock. Fire-and-forget is still preferred: this hop is purely a side
    // signal for UI gating, blocking startStreamingSession's flow on it would
    // serialize the for-await loop's startup behind it for no benefit.
    //
    // Capture `querySession` into `localQuery` and check identity before setting
    // `sdkControlReady`: if a config-change abort kills this subprocess and a
    // new pre-warm spawns a different querySession, the OLD promise might
    // still resolve from a buffered transport response (rare but possible —
    // see SDK performCleanup which rejects pendings, but a response already
    // in transport.readMessages's queue can land first). The identity check
    // prevents the stale resolution from flipping `sdkControlReady=true` for
    // the wrong subprocess.
    if (querySession) {
      const localQuery = querySession;
      const initStartT = Date.now();
      void localQuery.initializationResult().then(() => {
        if (querySession !== localQuery) {
          // Stale: a session swap happened while initialize was in flight.
          // The new pre-warm will fire its own initializationResult().
          return;
        }
        sdkControlReady = true;
        console.log(`[agent] SDK control plane ready in ${Date.now() - initStartT}ms (preWarm=${preWarm})`);
        // For non-pre-warm cold starts (user sent the very first message with
        // no prior pre-warm), enqueueUserMessage already set sessionState to
        // 'starting' (line 6118 — sdkControlReady was false at that moment).
        // Without this transition, the UI would stay in '启动中' until the slow
        // streamed system_init lands at the END of the first turn (think /context
        // 44s); now we promote to 'running' as soon as the SDK control plane
        // confirms ready (~3-5s in production), matching the actual subprocess
        // state.
        if (sessionState === 'starting' && !shouldAbortSession) {
          setSessionState('running');
        }
      }).catch((error) => {
        // Common cause: control request races against an abort that closes the
        // subprocess before the response arrives — benign. The next pre-warm
        // / startStreamingSession will reset and retry.
        console.warn('[agent] initializationResult() failed:', error instanceof Error ? error.message : error);
      });
    }

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
    // Pattern 3 §3.2.5 — count stream_event deltas seen during this turn so we
    // can emit a single aggregate `chat:log` at turn-end instead of one per token.
    let streamEventDeltaCount = 0;
    let streamEventTokenTotal = 0;

    // #227 — track which background-task ids have already produced a terminal
    // `chat:task-notification` broadcast in THIS SDK session, AND whether that
    // broadcast already carried a RICH (non-empty summary / output_file) payload.
    // Value = true once a rich terminal broadcast has gone out for the id.
    //
    // The SDK exposes two independent terminal channels for the same logical
    // event (task_updated / task_notification — see the lifecycle handler block
    // below, ~L8763). We forward whichever arrives FIRST so the user sees the
    // completion promptly. But the first-to-arrive channel is usually
    // task_updated, whose patch carries only an error string (empty on success)
    // — NOT the rich summary / output_file the later task_notification delivers.
    // So a plain first-wins suppression would drop the real summary on the
    // common happy path. Instead we let a LATER terminal event ENRICH an
    // already-broadcast card when it brings a non-empty summary/output_file the
    // first broadcast lacked. The renderer upserts the
    // `task-notification-<taskId>` history row by id, so the enrich re-broadcast
    // updates the bubble in place rather than duplicating it. Once rich, further
    // events for the id (and events that add nothing new) are suppressed.
    //
    // Lifetime = one for-await loop = one SDK session = one task registry.
    // Tasks can't cross SDK-session boundaries (the registry is in-process to
    // the CLI subprocess), so resetting per-session is correct. No bounded-cap
    // logic needed: the renderer's backgroundTaskStatus.ts has its own LRU,
    // and a single session is realistically bounded to << 1000 background
    // sub-agents.
    const terminalBroadcastedTaskIds = new Map<string, boolean>();

    // ── API response watchdog ──────────────────────────────────────────
    // Detects hung API connections AND hung MCP tool calls.
    // Heartbeat (15s ping) keeps the SSE alive, so Rust's 60s read_timeout
    // never fires. Without this watchdog, the session hangs indefinitely.
    // Unified 10-minute timeout for both API hang and MCP tool hang.
    //
    // `inFlightToolCount` is module-level so the post-interrupt force-close
    // path can read it. Reset here so a new turn starts at 0 even if a
    // prior turn ended via abort/restart without clearing it.
    inFlightToolCount = 0;
    const API_WATCHDOG_INTERVAL_MS = 30_000;
    const WATCHDOG_TIMEOUT_MS = 10 * 60 * 1000; // 10 minutes — unified for API and MCP tools
    // Suspension-aware: only counts time the process was actually running, so
    // macOS sleep / App Nap doesn't get mistaken for a hung turn. See
    // utils/inactivity-watchdog.ts. markActivity() is called per SDK event
    // below; the gate (`!isStreamingMessage`) means evaluateTick only runs
    // during an active turn — the credited tick-gap on the first post-idle tick
    // naturally absorbs inter-turn idle.
    const watchdog = new InactivityWatchdog({ timeoutMs: WATCHDOG_TIMEOUT_MS, intervalMs: API_WATCHDOG_INTERVAL_MS });
    let watchdogFired = false;
    apiWatchdogId = setInterval(async () => {
      // Only check during active turns (not pre-warm, not idle between turns)
      if (!isStreamingMessage || isPreWarming) return;
      if (watchdogFired) return;
      const { fire: noRecentSdkEvents, suspendedMs } = watchdog.evaluateTick();
      if (suspendedMs > 0) {
        console.log(`[agent] Watchdog: credited ${Math.round(suspendedMs / 1000)}s process suspension (sleep/App Nap) — not counted as inactivity`);
      }

      // Paused on a human (permission prompt / AskUserQuestion / plan approval):
      // their think time is not turn inactivity. Re-baseline the idle clock so
      // the post-answer budget is fresh, and skip the kill. evaluateTick already
      // advanced lastTickAt this tick, so the wait ending produces no spurious
      // suspension credit. (High-2, cross-review.)
      if (hasPendingInteractiveRequest()) {
        watchdog.markActivity();
        return;
      }

      if (noRecentSdkEvents) {
        watchdogFired = true;
        const toolInfo = inFlightToolCount > 0 ? `（${inFlightToolCount} 个工具执行中）` : '';
        console.error(`[agent] Watchdog: no SDK event for ${WATCHDOG_TIMEOUT_MS / 1000}s of active time${toolInfo} — aborting`);

        // ─── DELAYED CONTINUE (set flag) ─────────────────────────────────
        // This is the ONE AND ONLY site that sets `pendingContinueAfterAbort`.
        // `abortPersistentSession()` has multiple other callers (user ESC,
        // config switch, provider switch, deferred restart, error fallbacks)
        // — none of them touch this flag. Putting the set logic here, not
        // inside `abortPersistentSession()`, is what guarantees only
        // watchdog-driven aborts trigger the delayed Continue.
        //
        // Empty-turn skip uses the semantic `turnHadSubstantiveActivity`
        // flag (set on first non-init SDK frame in the for-await loop;
        // reset by `resetTurnUsage()` at turn start). This replaced the
        // earlier `messageCount > 3` heuristic, which had two problems:
        // (1) messageCount is cumulative across turns in a persistent
        // session, so turn N>1 that aborted with zero activity still
        // satisfied >3 from earlier turns; (2) the "3 init frames"
        // assumption is brittle against SDK init-framing changes.
        // `currentTurnTextBlocks` was also rejected — gated by
        // `currentTurnInboxMeta`, never populated on cron / desktop /
        // IM-bot non-inbox sessions. (Caught in cross-review.)
        //
        // `sessionId` is module-level and could mutate during the
        // `await updateSessionMetadata` below if `switchToSession` runs
        // concurrently. Snapshot synchronously so the flag is persisted
        // against the session that actually aborted, not whichever session
        // happens to be current at await-resume time.
        //
        // Persist BEFORE `abortPersistentSession()` to maximize the window
        // for the file write to complete before the sidecar tears down
        // (cron sidecars in particular shut down ~1s after abort).
        const watchdogSessionId = sessionId;
        if (turnHadSubstantiveActivity) {
          try {
            await updateSessionMetadata(watchdogSessionId, { pendingContinueAfterAbort: true });
            console.log(`[agent] Watchdog: marked session ${watchdogSessionId} pendingContinueAfterAbort=true (turnHadSubstantiveActivity=true)`);
          } catch (e) {
            console.error('[agent] Watchdog: failed to persist pendingContinueAfterAbort:', e);
          }
        } else {
          console.log(`[agent] Watchdog: turn had no substantive SDK activity — skipping pendingContinueAfterAbort`);
        }

        broadcast('chat:agent-error', {
          message: `响应超时（10 分钟无活动${toolInfo}），已自动终止。请重试。`
        });
        broadcast('chat:message-error', '响应超时');
        abortPersistentSession();
      }
    }, API_WATCHDOG_INTERVAL_MS);

    for await (const sdkMessage of querySession) {
      messageCount++;
      watchdog.markActivity();
      // Flip turn-scoped substantive-activity flag on first non-init frame.
      // `system/init` is the boilerplate startup frame and must not count
      // as "this turn produced output" for the watchdog auto-resume decision.
      // Everything else (assistant / user / tool_result / stream_event /
      // result / rate_limit_event / system non-init) is real activity.
      if (!turnHadSubstantiveActivity) {
        const isBoilerplateInit =
          sdkMessage.type === 'system' &&
          (sdkMessage as { subtype?: string }).subtype === 'init';
        if (!isBoilerplateInit) {
          turnHadSubstantiveActivity = true;
        }
      }
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
      // Pattern 3 §3.2.5 — for stream_event, default-suppress the per-event
      // disk write + SSE broadcast. The token text itself is delivered via
      // chat:message-chunk on a separate code path; the legacy logStringify
      // here was diagnostic only. Track counts so we can emit one aggregate
      // log line per turn (see `result` branch below).
      if (sdkMessage.type === 'stream_event' && SUPPRESS_PER_TOKEN_LOG_BROADCAST) {
        streamEventDeltaCount++;
        const ev = (sdkMessage as { event?: { delta?: unknown; usage?: { output_tokens?: number } } }).event;
        const outTok = ev?.usage?.output_tokens;
        if (typeof outTok === 'number' && outTok > streamEventTokenTotal) {
          streamEventTokenTotal = outTok;
        }
      } else {
        try {
          const line = `${localTimestamp()} ${logStringify(sdkMessage)}`;
          appendLogLine(line);
        } catch (error) {
          console.log('[agent][sdk] (unserializable)', error);
        }
        // On turn-end (`result`), emit the stream_event aggregate so log
        // consumers see "this turn streamed N deltas" without the per-token
        // spam. Reset counters for the next turn.
        if (sdkMessage.type === 'result' && streamEventDeltaCount > 0) {
          const summary = `${localTimestamp()} [stream_event_summary] deltas=${streamEventDeltaCount} output_tokens=${streamEventTokenTotal}`;
          try { appendLogLine(summary); } catch { /* logger errors are non-fatal */ }
          streamEventDeltaCount = 0;
          streamEventTokenTotal = 0;
        }
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
          // (issue #174) Subprocess is now ready — graduate 'starting' to
          // 'running' so the UI swaps the "AI 启动中" hint for the normal
          // thinking indicator. Skip on pre-warm (state is 'idle' anyway).
          if (sessionState === 'starting') {
            setSessionState('running');
          }
          broadcast('chat:system-init', { info: systemInitInfo, sessionId, runtime: 'builtin' });
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
        // PRD 0.2.27 — system_init means the load-captured reloadAnchor (if any) was
        // accepted by the SDK and the session is now truncated correctly; consume it so a
        // later restart/turn doesn't re-apply a now-stale truncation point.
        pendingReloadAnchor = undefined;

        // Save SDK session_id and verify unified session status
        if (nextSystemInit.session_id) {
          const isUnified = nextSystemInit.session_id === sessionId;
          await updateSessionMetadata(sessionId, {
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
      //
      // #227 — SDK exposes TWO independent channels for the same logical
      // "task is done" event:
      //   1. `task_notification` (user/parent-prompt channel, statuses
      //      'completed' | 'failed' | 'stopped'). NOT guaranteed for every
      //      terminal path — it's emitted from the CLI's internal
      //      `mode:'task-notification'` queue, which can fail to fire when
      //      e.g. the parent session ends before the queue is drained, or
      //      when the task is killed via task_updated without an explicit
      //      `TaskStop` tool call.
      //   2. `task_updated` (state-machine patch channel, terminal statuses
      //      'completed' | 'failed' | 'killed'). Reliably emitted for every
      //      state transition — this is the authoritative "task is done"
      //      signal per the SDK contract. Killed→stopped normalization
      //      matches what the CLI itself does when synthesizing
      //      task_notification (see CLI `f9=A8(Fq)?Fq==='killed'?'stopped':Fq`).
      //
      // We forward whichever arrives first, deduped per task_id via
      // `terminalBroadcastedTaskIds`. The renderer's TabProvider appends a
      // `task-notification-<taskId>` history message on each event — without
      // sidecar-side dedup, the happy path (both events fire) would create
      // duplicate history rows with the same id. Dual investigation: Claude
      // root-traced via session JSONL evidence + binary string surface;
      // Codex independently confirmed the channel separation in the SDK
      // type contract.
      if (sdkMessage.type === 'system') {
        const taskMsg = sdkMessage as { subtype?: string; task_id?: string;
          tool_use_id?: string; description?: string; task_type?: string;
          status?: string; summary?: string; output_file?: string;
          patch?: { status?: string; error?: string; description?: string } };
        if (taskMsg.subtype === 'task_started' && taskMsg.task_id) {
          console.log(`[agent] Background task started: ${taskMsg.task_id} — ${taskMsg.description}`);
          // Record so the teardown flush + task_updated channel can resolve the
          // tool_use_id later (see startedBackgroundTasks declaration).
          startedBackgroundTasks.set(taskMsg.task_id, {
            toolUseId: taskMsg.tool_use_id,
            description: taskMsg.description,
          });
          broadcast('chat:task-started', {
            taskId: taskMsg.task_id,
            toolUseId: taskMsg.tool_use_id,
            description: taskMsg.description,
            taskType: taskMsg.task_type,
          });
        } else if (taskMsg.subtype === 'task_notification' && taskMsg.task_id) {
          // Rich iff it carries a real summary or an output_file (the
          // notification channel is the one that delivers these).
          const isRich = Boolean((taskMsg.summary && taskMsg.summary.trim()) || taskMsg.output_file);
          const priorRich = terminalBroadcastedTaskIds.get(taskMsg.task_id);
          if (priorRich !== undefined && (priorRich || !isRich)) {
            // Already broadcast for this task, and either that broadcast was
            // already rich OR this one adds nothing new — suppress the
            // duplicate. (Happy path that DOES enrich: task_updated{completed}
            // fired first with an empty summary [priorRich=false], so a rich
            // notification here [isRich=true] falls through to re-broadcast.)
            console.log(`[agent] Background task notification ${taskMsg.status} suppressed (no new info; priorRich=${priorRich}): ${taskMsg.task_id}`);
          } else {
            const enriching = priorRich !== undefined;
            terminalBroadcastedTaskIds.set(taskMsg.task_id, isRich);
            console.log(`[agent] Background task ${taskMsg.status}${enriching ? ' (enriching prior broadcast)' : ''}: ${taskMsg.task_id} — ${taskMsg.summary}`);
            broadcast('chat:task-notification', {
              taskId: taskMsg.task_id,
              toolUseId: taskMsg.tool_use_id,
              status: taskMsg.status,
              summary: taskMsg.summary,
              outputFile: taskMsg.output_file,
            });
            // Reached terminal — drop from the pending set so the teardown flush skips it.
            startedBackgroundTasks.delete(taskMsg.task_id);
          }
        } else if (taskMsg.subtype === 'task_updated' && taskMsg.task_id) {
          const patchStatus = taskMsg.patch?.status;
          // Only terminal patches are actionable for the renderer's "task
          // done" signal. Non-terminal patches (pending/running) leave the
          // UI in its current state.
          if (patchStatus === 'completed' || patchStatus === 'failed' || patchStatus === 'killed') {
            const errorSummary = taskMsg.patch?.error ?? '';
            // task_updated only carries an error string as its summary (empty on
            // success) and never an output_file, so it is "rich" only when that
            // error is non-empty.
            const isRich = Boolean(errorSummary.trim());
            const priorRich = terminalBroadcastedTaskIds.get(taskMsg.task_id);
            if (priorRich !== undefined && (priorRich || !isRich)) {
              console.log(`[agent] Background task patch ${patchStatus} suppressed (no new info; priorRich=${priorRich}): ${taskMsg.task_id}`);
            } else {
              const enriching = priorRich !== undefined;
              terminalBroadcastedTaskIds.set(taskMsg.task_id, isRich);
              // Map 'killed' → 'stopped': the renderer's
              // `backgroundTaskStatus.ts::TERMINAL` set is
              // {completed, error, failed, stopped} and knows nothing about
              // 'killed'. Aligning with the SDK CLI's own normalization
              // keeps the renderer vocab stable.
              const normalized = patchStatus === 'killed' ? 'stopped' : patchStatus;
              console.log(`[agent] Background task ${normalized} (via task_updated)${enriching ? ' (enriching prior broadcast)' : ''}: ${taskMsg.task_id} — patch.status=${patchStatus}${errorSummary ? ` error=${errorSummary}` : ''}`);
              broadcast('chat:task-notification', {
                taskId: taskMsg.task_id,
                // task_updated.patch doesn't carry tool_use_id, so resolve it
                // from the task_started record. The renderer can also bridge
                // taskId→toolUseId at runtime (registerBackgroundTask), but the
                // PERSISTED `task-notification-<taskId>` history message stores
                // this field verbatim — sending undefined there breaks the
                // panel's history fallback after a reload (it keys on toolUseId).
                // Falls back to undefined (orphan-pool reconciliation) if the
                // start was never observed in this session.
                toolUseId: startedBackgroundTasks.get(taskMsg.task_id)?.toolUseId,
                status: normalized,
                summary: errorSummary,
                outputFile: '',
              });
              // Reached terminal — drop from the pending set so the teardown flush skips it.
              startedBackgroundTasks.delete(taskMsg.task_id);
            }
          }
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
          if (sdkMessage.type === 'assistant') {
            currentTurnHadAssistantMessageError = true;
            currentTurnLastAssistantMessageError = agentError;
            console.warn('[agent] SDK assistant message reported provisional error; waiting for result frame:', agentError);
          } else {
            lastAgentError = agentError;
            broadcast('chat:agent-error', { message: agentError });
          }
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
                  // IM stream: forward non-subagent text delta to event bus (Pattern B)
                  emitImEvent('delta', streamEvent.delta.text);
                  // PRD 0.2.14 — accumulate per-block text for desktop→IM mirror
                  // (no-op when current turn isn't desktop-driven).
                  maybeAccumulateMirrorChunk(streamEvent.index, streamEvent.delta.text);
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
          // (v0.2.11 cross-bugfix) Removed mid-turn flush here. With deferred
          // yield, pending mid-turn messages aren't sent to SDK until after
          // the prior turn ends, so a text content_block_start is part of
          // the prior turn's output, not a response to a queued follow-up.
          // Pattern B: forward non-subagent block-start activity to event bus.
          if (!sdkMessage.parent_tool_use_id) {
            if (streamEvent.content_block.type === 'text') {
              imTextBlockIndices.add(streamEvent.index);
            } else {
              // Notify non-text block activity (thinking, tool_use) so IM can show placeholder
              emitImEvent('activity', streamEvent.content_block.type);
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
              inFlightToolCount++;
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

            toolResultIndexToId.set(streamEvent.index, toolResultBlock.tool_use_id);
            const parentToolUseId =
              childToolToParent.get(toolResultBlock.tool_use_id) ?? sdkMessage.parent_tool_use_id;
            if (parentToolUseId) {
              const parts = extractToolResultRenderParts(toolResultBlock.content);
              const contentStr = parts.text || (parts.attachments.length > 0 ? TOOL_ATTACHMENT_RESULT_SENTINEL : '');
              if (contentStr) {
                if (!childToolToParent.has(toolResultBlock.tool_use_id)) {
                  ensureSubagentToolPlaceholder(parentToolUseId, toolResultBlock.tool_use_id);
                }
                broadcast('chat:subagent-tool-result-start', {
                  parentToolUseId,
                  toolUseId: toolResultBlock.tool_use_id,
                  content: contentStr,
                  isError: toolResultBlock.is_error || false
                });
                handleToolResultStart(
                  toolResultBlock.tool_use_id,
                  contentStr,
                  toolResultBlock.is_error || false
                );
              }
            } else {
              const prepared = prepareBuiltinToolResultPayload(
                toolResultBlock.tool_use_id,
                toolResultBlock.content,
              );
              if (prepared.content || prepared.attachments.length > 0) {
                // Strip Playwright tool results from frontend broadcast
                const shouldStripResult = isPlaywrightTool(toolResultBlock.tool_use_id);
                if (shouldStripResult) {
                  strippedToolResultIds.add(toolResultBlock.tool_use_id);
                }
                const content = shouldStripResult ? PLAYWRIGHT_RESULT_SENTINEL : prepared.content;
                broadcast('chat:tool-result-start', {
                  toolUseId: toolResultBlock.tool_use_id,
                  content,
                  isError: toolResultBlock.is_error || false,
                  attachments: prepared.attachments.length > 0 ? prepared.attachments : undefined,
                });
                handleToolResultStart(
                  toolResultBlock.tool_use_id,
                  content,
                  toolResultBlock.is_error || false,
                  prepared.attachments,
                );
              }
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
              toolId: toolId || undefined,
              // Block type lets the renderer mark a *text* block complete on stop, so
              // the streaming tail-fade (Markdown rehypeStreamTail) clears once the
              // model finishes the text — even when the turn keeps running (next tool /
              // thinking). Without this the fade lingers on the last chars indefinitely.
              type: streamIndexToBlockType.get(streamEvent.index),
            });
            handleContentBlockStop(streamEvent.index, toolId || undefined);
            // IM stream: signal text block end via event bus (Pattern B)
            if (imTextBlockIndices.has(streamEvent.index)) {
              emitImEvent('block-end', '');
              imTextBlockIndices.delete(streamEvent.index);
            }
            // PRD 0.2.14 — desktop turn AI text block done → mirror to bound channel.
            // Q1·C: one mirror call per text block, with accumulated body. No-op
            // when the turn isn't desktop-driven (currentTurnMirrorEnabled=false).
            const mirroredBlockText = pendingTextBlockTexts.get(streamEvent.index);
            if (mirroredBlockText !== undefined) {
              pendingTextBlockTexts.delete(streamEvent.index);
              fireDesktopAssistantBlockMirror(mirroredBlockText);
            }
          }
        }
      } else if (sdkMessage.type === 'user') {
        // (v0.2.12 mid-turn injection) SDKUserMessageReplay handling.
        //
        // CLI subprocess emits a user message with isReplay=true when it
        // drains a queued_command attachment from its commandQueue
        // mid-turn (claude-code/src/QueryEngine.ts:880). The replay's
        // uuid carries our queueItem.id (we stamped it on yield), so a
        // match against inFlightToCliId means our in-flight item just
        // crossed into the model's context — time to surface it visually
        // and promote the next pending item.
        const isReplay = (sdkMessage as { isReplay?: boolean }).isReplay === true;
        if (isReplay && sdkMessage.uuid && sdkMessage.uuid === inFlightToCliId) {
          await handleQueuedCommandReplay(sdkMessage);
          continue;
        }
        if (isReplay) {
          // (v0.2.12 Codex review fix #4) Other replay flavours
          // (initial-message ack, batched-message ack, local-command echo).
          // These don't represent new conversation turns, but the replay's
          // uuid is the canonical SDK uuid for our previously-pushed user
          // message. We MUST run the same sdkUuid-assignment loop the
          // non-replay branch uses, otherwise rewindFiles / fork / forkSession
          // checkpoint anchors break for those messages — `currentSessionUuids`
          // alone is insufficient because rewindSession matches by
          // `messages[i].sdkUuid`.
          if (sdkMessage.uuid) {
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
          continue;
        }
        // (#228) Suppress SDK-synthetic transcript material from the user-visible
        // channel. The SDK emits "synthetic" user messages for several internal
        // purposes that must never reach the chat UI nor be persisted to
        // SessionStore, because they have no user-visible semantics and their
        // uuids belong to post-compact sessions (rewind anchors break):
        //   - `isCompactSummary: true` — the post-`compact_boundary` continuation
        //     prompt carrying the prior-conversation summary. In long
        //     conversations the summary text often embeds historical
        //     `<local-command-stdout>` substrings from prior /cost or /compact
        //     echoes, which previously slipped past the local-command branch
        //     below and materialized as a phantom user bubble.
        //   - `isMeta: true` — meta messages (e.g. tool-trigger prompts CLI emits).
        //   - `isSynthetic: true` — generic SDK-synthetic marker (also used
        //     for some queued-command pseudo-replays below; covered for
        //     defense-in-depth).
        //   - `isVisibleInTranscriptOnly: true` — explicit SDK marker for
        //     "show in transcript file only, never user-visible" (semantic
        //     superset of the above).
        // These flags are runtime properties of the live SDK stream events
        // (verified against on-disk transcript JSONL); the public
        // `SDKUserMessage` type only declares `isSynthetic?`. UUID tracking
        // is still skipped (matches the prior `!isSynthetic` guard).
        const syntheticFlags = sdkMessage as {
          isCompactSummary?: boolean;
          isMeta?: boolean;
          isSynthetic?: boolean;
          isVisibleInTranscriptOnly?: boolean;
        };
        if (
          syntheticFlags.isCompactSummary ||
          syntheticFlags.isMeta ||
          syntheticFlags.isSynthetic ||
          syntheticFlags.isVisibleInTranscriptOnly
        ) {
          continue;
        }
        // Track SDK user UUID — only for non-synthetic messages
        if (sdkMessage.uuid) {
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

          // Handle local command output (e.g., /cost, /context commands).
          // SDK sends these as user messages with string content wrapped in
          // <local-command-stdout> tags. (#228) Match `startsWith` (after
          // whitespace trim), not `includes` — real CLI echoes always begin
          // with the tag, but arbitrary text bodies (e.g. compact summaries
          // that quote prior conversation verbatim) may embed the tag as a
          // substring and used to false-positive into the user-visible
          // channel. The synthetic guard above is the primary defense; this
          // tightening is belt-and-suspenders.
          if (typeof messageContent === 'string' && messageContent.trimStart().startsWith('<local-command-stdout>')) {
            const localCommandMessage: MessageWire = {
              id: String(messageSequence++),
              role: 'user',
              content: messageContent,
              timestamp: new Date().toISOString(),
            };
            messages.push(localCommandMessage);
            broadcast('chat:message-replay', { message: localCommandMessage });
            await persistMessagesToStorage();
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
              const structuredText =
                toolUseResultData && typeof toolUseResultData === 'object'
                  ? JSON.stringify(toolUseResultData)
                  : undefined;

              const parentToolUseId =
                childToolToParent.get(toolResultBlock.tool_use_id) ?? sdkMessage.parent_tool_use_id;
              if (parentToolUseId) {
                const parts = extractToolResultRenderParts(toolResultBlock.content);
                const contentStr =
                  structuredText ?? (parts.text || (parts.attachments.length > 0 ? TOOL_ATTACHMENT_RESULT_SENTINEL : ''));
                if (!childToolToParent.has(toolResultBlock.tool_use_id)) {
                  ensureSubagentToolPlaceholder(parentToolUseId, toolResultBlock.tool_use_id);
                }
                broadcast('chat:subagent-tool-result-complete', {
                  parentToolUseId,
                  toolUseId: toolResultBlock.tool_use_id,
                  content: contentStr
                });
                handleToolResultComplete(toolResultBlock.tool_use_id, contentStr);
              } else {
                const prepared = prepareBuiltinToolResultPayload(
                  toolResultBlock.tool_use_id,
                  toolResultBlock.content,
                  structuredText,
                );
                // Top-level tool result (e.g., WebSearch without parent)
                const stripped = strippedToolResultIds.has(toolResultBlock.tool_use_id) || isPlaywrightTool(toolResultBlock.tool_use_id);
                const contentStr = structuredText ?? prepared.content;
                const content = stripped ? PLAYWRIGHT_RESULT_SENTINEL : contentStr;
                broadcast('chat:tool-result-complete', {
                  toolUseId: toolResultBlock.tool_use_id,
                  content,
                  attachments: prepared.attachments.length > 0 ? prepared.attachments : undefined,
                });
                inFlightToolCount = Math.max(0, inFlightToolCount - 1);
                handleToolResultComplete(
                  toolResultBlock.tool_use_id,
                  content,
                  undefined,
                  prepared.attachments,
                );
                continue;
              }
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

              const parentToolUseId =
                childToolToParent.get(toolResultBlock.tool_use_id) ?? sdkMessage.parent_tool_use_id;
              if (parentToolUseId) {
                const parts = extractToolResultRenderParts(toolResultBlock.content);
                const contentStr = parts.text || (parts.attachments.length > 0 ? TOOL_ATTACHMENT_RESULT_SENTINEL : '');
                if (!childToolToParent.has(toolResultBlock.tool_use_id)) {
                  ensureSubagentToolPlaceholder(parentToolUseId, toolResultBlock.tool_use_id);
                }
                broadcast('chat:subagent-tool-result-complete', {
                  parentToolUseId,
                  toolUseId: toolResultBlock.tool_use_id,
                  content: contentStr,
                  isError: toolResultBlock.is_error || false
                });
                handleToolResultComplete(
                  toolResultBlock.tool_use_id,
                  contentStr,
                  toolResultBlock.is_error || false
                );
              } else {
                const prepared = prepareBuiltinToolResultPayload(
                  toolResultBlock.tool_use_id,
                  toolResultBlock.content,
                );
                const stripped = strippedToolResultIds.has(toolResultBlock.tool_use_id) || isPlaywrightTool(toolResultBlock.tool_use_id);
                const content = stripped ? PLAYWRIGHT_RESULT_SENTINEL : prepared.content;
                broadcast('chat:tool-result-complete', {
                  toolUseId: toolResultBlock.tool_use_id,
                  content,
                  isError: toolResultBlock.is_error || false,
                  attachments: prepared.attachments.length > 0 ? prepared.attachments : undefined,
                });
                inFlightToolCount = Math.max(0, inFlightToolCount - 1);
                handleToolResultComplete(
                  toolResultBlock.tool_use_id,
                  content,
                  toolResultBlock.is_error || false,
                  prepared.attachments,
                );
              }
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
            emitImEvent('delta', nonStreamedText);
          }
        }
      } else if (sdkMessage.type === 'result') {
        // Turn complete — reset watchdog state for next turn
        inFlightToolCount = 0;
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
        const resultText = resultMessage.result || '';

        // Forward SDK error results to IM callback (prevents "(No Response)")
        if (resultMessage.is_error) {
          const rawError = resultText || resultMessage.errors?.join('; ') || currentTurnLastAssistantMessageError || '';
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
          if (pendingRequestIds.length > 0) {
            const errorText = localizeImError(rawError);
            console.warn('[agent] SDK result is_error, forwarding to IM bus:', errorText);
            emitImEvent('error', errorText);
            // W2 fix: also unregister the registry entry that the legacy code skipped.
            const failedReq = popPendingRequest();
            if (failedReq) {
              imRequestRegistry.setStatus(failedReq, 'failed');
              imRequestRegistry.unregister(failedReq);
            }
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

        // Surface SDK-level errors that produced no assistant output (e.g. "Unknown skill: xxx").
        // These results have non-empty result text but no visible assistant text was streamed.
        // Without this, the user sees nothing — the message just silently completes.
        // Only show agent-error for is_error results — non-error results from non-streaming
        // providers are handled in the assistant message handler above.
        const hasResultText = resultText.trim().length > 0;
        const resultErrorText = (hasResultText ? resultText : '') || resultMessage.errors?.join('; ') || currentTurnLastAssistantMessageError || '';
        const noOutputResultText = resultMessage.is_error ? resultErrorText : (hasResultText ? resultText : '');
        if (noOutputResultText && !currentTurnHasOutput && !currentTurnToolCount) {
          if (resultMessage.is_error) {
            console.warn('[agent] SDK error result with no streamed output, showing as agent-error:', resultErrorText);
            lastAgentError = resultErrorText;
            broadcast('chat:agent-error', { message: resultErrorText });
          } else if (resultText) {
            // Non-error result text that wasn't captured by streaming or assistant handler
            // (safety net — should rarely trigger after the assistant handler fix above)
            console.warn('[agent] SDK non-error result with no streamed output, showing as message:', resultText);
            // Handler first (same pattern as streamed text path)
            appendTextChunk(resultText);
            broadcast('chat:message-chunk', resultText);
            currentTurnHasOutput = true;
          }
          // Forward to IM event bus (prevents "(No Response)" for SDK failures).
          // Pattern B+G: pop the head request — the upcoming handleMessageComplete
          // for this turn will find the head already cleared and skip duplicate
          // emission. Defensive against handleMessageComplete not running for
          // is_error / no-output results.
          emitImEvent('complete', noOutputResultText);
          const completedReq = popPendingRequest();
          if (completedReq) {
            imRequestRegistry.setStatus(completedReq, 'completed');
            imRequestRegistry.unregister(completedReq);
          }
        }

        const emptySuccessfulResult = isEmptySuccessfulSdkResult({
          isError: resultMessage.is_error,
          result: resultText,
          terminalReason: resultMessage.terminal_reason,
          hasVisibleOutput: currentTurnHasOutput,
          toolCount: currentTurnToolCount,
          outputTokens: currentTurnUsage.outputTokens,
        });
        const recoveredAssistantMessageError = isRecoveredAssistantMessageError({
          hadAssistantMessageError: currentTurnHadAssistantMessageError,
          isError: resultMessage.is_error,
          terminalReason: resultMessage.terminal_reason,
          emptySuccessfulResult,
        });

        if (recoveredAssistantMessageError && currentTurnLastAssistantMessageError) {
          console.log('[agent] SDK assistant message error recovered by successful result:', currentTurnLastAssistantMessageError);
        }

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

        if (emptySuccessfulResult) {
          const emptyResultError = 'AI 未返回任何内容，但 SDK 将本轮标记为完成。请在当前会话重试；如果使用第三方兼容供应商，建议切换模型、减少上下文或压缩后重试。';
          console.warn(`[agent][empty_result] model=${currentTurnUsage.model ?? 'unknown'} terminal_reason=${resultMessage.terminal_reason ?? 'none'} input=${currentTurnUsage.inputTokens} output=${currentTurnUsage.outputTokens} duration_ms=${durationMs} provisional_error=${currentTurnLastAssistantMessageError ?? 'none'}`);
          lastAgentError = emptyResultError;
          broadcast('chat:message-error', emptyResultError);
          handleMessageError(emptyResultError);
          if (currentTurnInboxMeta) {
            const replyMeta = currentTurnInboxMeta;
            currentTurnInboxMeta = undefined;
            const replyText = currentTurnTextBlocks.join('').trim();
            currentTurnTextBlocks.length = 0;
            void import('./inbox/reply-deliver').then(({ deliverInboxReply }) =>
              deliverInboxReply(sessionId, replyMeta, {
                text: replyText,
                error: {
                  code: 'turn_failed',
                  message: emptyResultError,
                },
              }),
            ).catch((err) =>
              console.error('[inbox] empty-result reply pushback failed:', err),
            );
          }
        } else {
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

          // Server-side unified analytics: covers all sources (desktop/cron/im).
          // PRD 0.2.19 — `session_id` lets analytics join this back to the renderer's
          // `session_new` event to reconstruct full per-session funnels (entry surface
          // → first message → token cost → tool usage → outcome).
          trackServer('ai_turn_complete', {
            source: currentScenario.type,
            session_id: sessionId,
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

          // PRD 0.2.18 Session Inbox — turn-end reply pushback.
          // If this turn was triggered by an inbox message with replyBack=true,
          // collect the turn's text + error and push back to caller session.
          // Fire-and-forget: don't await (network errors logged but not surfaced).
          if (currentTurnInboxMeta) {
            const replyMeta = currentTurnInboxMeta;
            // Clear immediately to prevent the next turn from inheriting (per-turn
            // semantics — multiple inbox messages each get their own binding).
            currentTurnInboxMeta = undefined;
            const replyText = currentTurnTextBlocks.join('').trim();
            currentTurnTextBlocks.length = 0;
            const replyError = resultMessage.is_error
              ? {
                  code: 'turn_failed',
                  message:
                    resultMessage.result ||
                    (resultMessage.errors?.join('; ') ?? 'turn ended with error'),
                }
              : undefined;
            void import('./inbox/reply-deliver').then(({ deliverInboxReply }) =>
              deliverInboxReply(sessionId, replyMeta, {
                text: replyText,
                error: replyError,
              }),
            ).catch((err) =>
              console.error('[inbox] result-handler reply pushback failed:', err),
            );
          }
        }

        // PRD #134 — clear `forkFrom` only once we've VERIFIED the SDK has
        // persisted the forked conversation to its on-disk store. "First
        // non-error result" is necessary but not sufficient: the SDK's
        // JSONL flush is async, and the deferred-restart abort triggered
        // by `setSessionModel` (model-window restart) can fire on the
        // same `result` message and race with the flush. If we cleared
        // `forkFrom` here speculatively, the next subprocess would
        // resume by sdkSessionId, fail with "No conversation found",
        // and `recoverFromStaleSession()` would silently spawn a fresh
        // SDK conversation — exactly the user-visible bug from #134/#135
        // (40+ failed turns reported in a single day).
        //
        // Probe via `sdkGetSessionMessages(sdkSid)` — reads the SDK's
        // own project JSONL. If it returns at least one message, the
        // conversation is durably persisted and any future restart can
        // resume normally. If it throws / returns empty, keep
        // `forkFrom` so the next `startStreamingSession` re-runs fork
        // mode (idempotent — SDK reloads source history and writes to
        // the same new sessionId). Async — the result handler doesn't
        // block on this.
        if (!resultMessage.is_error) {
          const meta = getSessionMetadata(sessionId);
          const sdkSid = meta?.sdkSessionId;
          const probeDir = agentDir;
          if (meta?.forkFrom && sdkSid) {
            sdkGetSessionMessages(sdkSid, { dir: probeDir, limit: 1 })
              .then(found => {
                if (found.length === 0) return; // not persisted yet — keep forkFrom
                // Re-fetch metadata in case anything changed since the
                // result handler captured it (e.g., restart already
                // re-issued fork mode in the gap).
                const fresh = getSessionMetadata(sessionId);
                if (!fresh?.forkFrom) return;
                console.log(`[agent] fork session ${sessionId} persisted in SDK store — clearing forkFrom`);
                delete fresh.forkFrom;
                saveSessionMetadata(fresh).catch(e =>
                  console.warn('[agent] forkFrom clear failed (non-fatal, will retry on next turn):', e),
                );
              })
              .catch(e => {
                // ENOENT / "No conversation found" / etc. — SDK hasn't
                // persisted yet. forkFrom stays; next start re-forks.
                console.log(`[agent] forkFrom persistence probe inconclusive, keeping flag: ${(e as Error)?.message ?? e}`);
              });
          }
        }

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
    // (issue #174) Pre-launch abort sentinel — clean exit, not a real error.
    // Skip the loud session-error log + the all-recovery branches below;
    // jump straight to finally for state cleanup. shouldAbortSession is
    // already true (set by interruptCurrentResponse), and the finally block
    // will run setSessionState('idle') / unregister bridge / resolve
    // sessionTerminationPromise. Without this short-circuit the message
    // would reach console.error and look like a real failure.
    if (errorMessage === 'STARTUP_ABORTED_BY_STOP') {
      console.log('[agent] session start aborted pre-launch by user stop');
      return;
    }
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
    // Two durable anchors can be the rejected UUID:
    //   1. pendingResumeSessionAt (in-memory) — set by rewindSession()
    //   2. SessionMetadata.forkFrom.messageUuid (disk-persisted) — set by forkSession()
    // effectiveResumeAt prefers rewindResumeAt ?? forkResumeAt (see line ~7776), so
    // when both are set the rewind UUID is the one actually sent to the SDK. Capture
    // that here so the fork branch below can avoid clearing an innocent fork anchor.
    const rewindAnchorWasSent = errorMessage.includes('No message found with message.uuid')
      && pendingResumeSessionAt !== undefined;

    // Rewind-mode "No message found" recovery (issue #189). Fires when the session
    // is registered, OR whenever there is a stale in-memory rewind anchor to clear —
    // even on an unregistered (fresh) fork. A fresh fork can carry a rewind anchor:
    // rewindSession() sets pendingResumeSessionAt for any UUID in currentSessionUuids
    // (disk-seeded from the copied messages), regardless of sessionRegistered. If that
    // anchor is then rejected by the SDK while sessionRegistered=false, gating purely on
    // sessionRegistered would skip this branch AND the fork branch below (rewindAnchorWasSent
    // is true) — neither anchor clears and every retry resends the same UUID (the #220
    // loop class, fresh-fork sub-case). Clearing an in-memory anchor is safe in any
    // registration state, so allow it whenever pendingResumeSessionAt is set.
    if (errorMessage.includes('No message found with message.uuid')
      && (sessionRegistered || pendingResumeSessionAt !== undefined)) {
      const rejectedUuid = pendingResumeSessionAt;
      pendingResumeSessionAt = undefined;
      // Evict the rejected UUID from currentSessionUuids so subsequent rewinds don't
      // re-accept it via the OR logic. Without this, the stale UUID stays in the cache
      // and a future rewind to the same point would re-trigger the same SDK error.
      // Only log/evict when there was an ACTUAL rewind anchor: on a reloadAnchor rejection
      // this branch still enters (sessionRegistered=true) with rejectedUuid===undefined —
      // the reloadAnchor branch below owns + logs that case, so stay quiet here (no
      // misleading "clearing rewind anchor" line on the high-stakes cold-reload path).
      if (rejectedUuid) {
        console.warn(`[agent] resumeSessionAt UUID rejected by SDK — clearing rewind anchor, retry will resume with full history`);
        currentSessionUuids.delete(rejectedUuid);
      }
      // Don't modify sessionRegistered — session exists, just the UUID is invalid.
      // Don't return — let pre-warm retry (finally block) handle recovery.
      // For non-pre-warm (user message triggered): fall through to error broadcast.
    }

    // PRD 0.2.27 reloadAnchor "No message found" recovery (decision 6). The cold-reload
    // anchor (pendingReloadAnchor, captured at LOAD) can be stale if compact/snip removed
    // that uuid from the SDK transcript. The pre-warm retry does NOT reload, so it would
    // reuse the same pendingReloadAnchor → SDK rejects again. Break the loop like the rewind
    // branch: evict the uuid from currentSessionUuids (so a future re-load's
    // deriveReloadResumeAnchor `.has()` gate also fails) AND clear the captured anchor
    // (generation-guarded — only if a newer start hasn't replaced it). Uses the query-scoped
    // `sentReloadAnchor`, not the module var, so a late catch from an aborted start can't
    // evict against a newer session. Retry resumes with full history (window-B reconcile
    // skipped this round; self-heals once the user continues and a newer leaf is written).
    if (errorMessage.includes('No message found with message.uuid') && sentReloadAnchor) {
      console.warn(`[agent] reloadAnchor UUID ${sentReloadAnchor} rejected by SDK — evicting from currentSessionUuids so retry resumes with full history (no re-derive loop)`);
      currentSessionUuids.delete(sentReloadAnchor);
      // Clear the load-captured anchor only if it's still THIS query's — a newer load/start
      // may have already replaced it; don't wipe a newer session's pending anchor.
      if (pendingReloadAnchor === sentReloadAnchor) pendingReloadAnchor = undefined;
    }

    // Fork-mode "No message found" recovery (issue #220). The durable anchor here lives
    // in `SessionMetadata.forkFrom.messageUuid` (disk-persisted), not in-memory, so we
    // must mutate + persist the metadata or every retry rereads the stale UUID.
    //
    // NOT gated on `sessionRegistered`: a fresh fork session has sessionRegistered=false
    // until SDK's first non-error result lands, but that's exactly when this error fires.
    //
    // Skip when the rewind branch above was the actual culprit — clearing both anchors
    // on every "No message found" would over-degrade a still-good fork anchor. If the
    // fork anchor is also stale, the next retry's effectiveResumeAt will fall through to
    // it, SDK will reject again, and this branch will fire on that pass.
    //
    // Trade-off: dropping the fork anchor degrades semantics — SDK forks at source's
    // *tail*, not the user-clicked midpoint. AI then sees more source context than the
    // UI shows (UI has the N copied messages; SDK has all source messages). Same
    // degradation philosophy as the rewind branch's "resume with full history". Better
    // than a fail-loop or losing the fork entirely.
    if (errorMessage.includes('No message found with message.uuid') && !rewindAnchorWasSent) {
      const failedForkMeta = getSessionMetadata(sessionId);
      if (failedForkMeta?.forkFrom?.messageUuid) {
        const rejectedForkUuid = failedForkMeta.forkFrom.messageUuid;
        console.warn(`[agent] forkSession anchor UUID ${rejectedForkUuid} rejected by SDK (source store no longer contains it) — clearing anchor; retry will fork at source tail`);
        delete failedForkMeta.forkFrom.messageUuid;
        try {
          await saveSessionMetadata(failedForkMeta);
        } catch (saveErr) {
          // Persist failure → disk still has the stale UUID. The next retry reads
          // it back and SDK rejects again → this branch fires again → save retries.
          // Eventually converges or the underlying I/O issue surfaces. Don't bail.
          console.warn(`[agent] forkFrom.messageUuid clear: disk persist failed (next retry will re-read stale UUID and re-enter this recovery): ${(saveErr as Error)?.message ?? saveErr}`);
        }
        currentSessionUuids.delete(rejectedForkUuid);
      }
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
    //
    // Also skip when `shouldAbortSession` is set: that flag means WE asked
    // the SDK subprocess to die (resetSession, rewind, config-change restart,
    // user deleting the current session, etc.). If the abort lands mid-turn
    // while a tool call is in flight, the CLI's stdout gets truncated and
    // the SDK's `readMessages` parser throws
    //   "Claude Code returned an error result: [ede_diagnostic]
    //    result_type=user last_content_type=n/a stop_reason=tool_use"
    // That's an expected side-effect of the abort, not a real failure — the
    // user already saw the reset/delete go through and shouldn't then get a
    // red "message-error" banner about it. Pit-of-success: any SDK error
    // during an active abort is by definition our doing, not a provider/infra
    // issue to surface. Error is still logged above (line 6611–6612) for
    // debugging, just not broadcast.
    if (!isPreWarming && !shouldAbortSession) {
      broadcast('chat:message-error', userFacingError);
      handleMessageError(errorMessage);
      setSessionState('error');
    } else if (shouldAbortSession) {
      console.log(`[agent] Suppressing SDK error surfaced during abort (expected): ${errorMessage}`);
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

    // (v0.2.12 latent bug fix — Codex finding) Rescue any pending mid-turn
    // items into messageQueue so the recovery generator picks them up.
    // Without this, an unexpected SDK exit (subprocess crash, error
    // surfaced after handleMessageError but BEFORE abortPersistentSession's
    // own rescue) leaves pendingMidTurnQueue items orphaned: the new
    // generator only consumes from messageQueue, the items would never be
    // delivered. abortPersistentSession's rescue covers the explicit-abort
    // path; this finally-block rescue is the catch-all for every other
    // exit shape (catch block didn't run abortPersistentSession, for-await
    // throws on transport error, etc.). Also clear in-flight CLI tracking —
    // the CLI subprocess is gone, those uuids are dead.
    if (pendingMidTurnQueue.length > 0) {
      console.log(`[agent] finally: rescuing ${pendingMidTurnQueue.length} pending mid-turn item(s) into messageQueue`);
      rescuePendingToQueue();
    }
    clearInFlightSlot();

    // Queue lifecycle invariant: messageQueue survives session restarts by default.
    // Any drain decision belongs to the caller that triggered the exit, not here:
    //   - interruptCurrentResponse (stop button): drains only when called with no
    //     active turn (orphaned queue). When a turn is in flight, stop cancels
    //     THAT turn; queued messages naturally flow into the recovery session.
    //   - forceExecuteQueueItem: the force-executed item MUST survive a hard-kill
    //     escalation into the recovery session. Both messageQueue items and items
    //     already in pendingMidTurnQueue are covered — the latter via rescuePending
    //     ToQueue() called inside interruptCurrentResponse's close() paths.
    //   - abortPersistentSession callers (config changes, provider switch): preserve
    //     queue so the restarted session picks up pending work. The abort also
    //     rescues pending mid-turn items back into messageQueue.
    //   - resetSession / switchToSession / recoverFromStaleSession / rewindSession:
    //     explicitly call drainQueueWithCancellation (broadcasts queue:cancelled).
    //   - Subprocess crash without explicit abort: preserve queue — the safety net
    //     below reschedules pre-warm so the new session drains it.

    // 安全关闭 SDK session
    const session = querySession;
    querySession = null;
    try { session?.close(); } catch { /* subprocess 可能已退出 */ }

    // PRD #124: unregister the bridge token now that the SDK subprocess
    // has exited. If the session restarts, `startStreamingSession` mints
    // a fresh token (freshToken: true) so late requests from this dying
    // subprocess find their old token gone and get rejected cleanly.
    unregisterActiveSessionBridge();

    // (v0.2.14 — Codex review) Drain pending interactive requests on every
    // SDK exit shape. The per-handler `onAbort` covers the canonical
    // SDK-driven `interrupt()` path, but unexpected exits (subprocess
    // crash, transport error in `for await`, abortPersistentSession races
    // where signal.abort doesn't propagate before close) would otherwise
    // leak Map entries — `getPendingInteractiveRequests` then replays
    // ghost cards to newly connecting SSE clients. Pre-warm sessions can't
    // hold pending entries (they never serve a turn), but draining is
    // idempotent so the wasPreWarming branch is harmless.
    drainPendingInteractiveRequests('session-end');

    // Flush a synthetic terminal `stopped` for every background sub-agent that
    // started in this session but never reached terminal (still in the pending
    // map — terminal branches delete on broadcast). The owning SDK subprocess is
    // now gone (this finally runs on EVERY for-await exit: abort, deferred config
    // restart, watchdog kill, transport error), so the real terminal event can
    // never arrive — the process that would emit it just died. Without this, the
    // renderer's Agent Status Panel shows these sub-agents "后台运行中" forever
    // (all its clear-defenses require a terminal event). A late real terminal
    // after this flush is deduped renderer-side by taskId. Empty for pre-warm
    // sessions (no tasks started).
    for (const [taskId, info] of startedBackgroundTasks) {
      console.log(`[agent] Background task orphaned by session teardown → flushing stopped: ${taskId} — ${info.description ?? ''}`);
      broadcast('chat:task-notification', {
        taskId,
        toolUseId: info.toolUseId,
        status: 'stopped',
        summary: '',
        outputFile: '',
      });
    }
    startedBackgroundTasks.clear();

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
    //
    // preWarmDisabled fallback: in --no-pre-warm mode (CLI flag for dev/test), schedulePreWarm
    // is a no-op, so no recovery is coming. Drain the queue explicitly so the frontend clears
    // its pills and the user knows to resend. Without this, queue preservation + disabled
    // pre-warm = orphaned-forever.
    if (messageQueue.length > 0 && !preWarmTimer && !isProcessing && querySession === null) {
      if (preWarmDisabled) {
        console.warn(`[agent] Safety net: ${messageQueue.length} orphaned message(s), pre-warm disabled → draining`);
        drainQueueWithCancellation();
      } else {
        console.warn(`[agent] Safety net: ${messageQueue.length} orphaned message(s) in queue, scheduling recovery`);
        preWarmFailCount = 0;
        schedulePreWarm();
      }
    }
  }
}

async function* messageGenerator(): AsyncGenerator<SDKUserMessage> {
  // (v0.2.12) Mid-turn injection restored.
  //
  // Yield queued messages immediately so the CLI subprocess receives them
  // and its mid-turn drain (claude-code/src/query.ts:1570 —
  // getCommandsByMaxPriority('next') at every tool break) can attach them
  // as queued_command attachments to the model's next API call. AI sees
  // mid-turn user input and can change direction.
  //
  // Cancel safety is handled at the enqueue layer, NOT by deferring the
  // yield. While inFlightToCliId !== null, fresh queue items are buffered
  // in pendingMidTurnQueue (cancellable, never crossed the process
  // boundary) and only yielded after the current in-flight item gets a
  // SDKUserMessageReplay (isReplay=true) confirming CLI consumption.
  // Frontend hides the X button on the in-flight item — its uuid has
  // already entered CLI's commandQueue and there is no SDK API to
  // retract it.
  //
  // Each yielded SDKUserMessage carries `uuid: item.id`, which CLI
  // surfaces as `attachment.source_uuid` in the replay event so we can
  // match the replay back to our queue item and promote the next
  // pending one.
  //
  // Exit signal: waitForMessage() returns null (via abortPersistentSession).
  console.log('[messageGenerator] Started (persistent mode, mid-turn injection enabled)');

  while (true) {
    // 等待队列中的消息（事件驱动，无轮询）
    const item = await waitForMessage();
    if (!item) {
      console.log('[messageGenerator] Received null — exiting (abort or session end)');
      return; // generator return → SDK endInput() → stdin EOF → subprocess 退出
    }

    // Transition from pre-warm to active when processing a queued message.
    // Same race-handling as before: if enqueueUserMessage was called during
    // session abort (shouldAbortSession=true), the pre-warm→active transition
    // was skipped there. Setting it false HERE ensures that when system_init
    // arrives from the SDK (after this yield), it goes through the direct-
    // broadcast path instead of being buffered.
    if (isPreWarming) {
      isPreWarming = false;
      if (systemInitInfo) {
        sessionRegistered = true;
        broadcast('chat:system-init', { info: systemInitInfo, sessionId, runtime: 'builtin' });
      }
      if (preWarmTimer) {
        clearTimeout(preWarmTimer);
        preWarmTimer = null;
      }
      console.log(`[agent] pre-warm → active (from queued message), sessionRegistered=${sessionRegistered}`);
    }

    // Direct-send items (wasQueued=false): enqueueUserMessage already pushed
    // the user message to messages[], persisted it, and broadcast
    // chat:message-replay. Generator MUST NOT push again — doing so allocates
    // a second `messageSequence++` id and writes a second SessionStore entry
    // (issue #173). Generator's job here is purely turn-scoped state setup so
    // the upcoming yield's response is properly tracked.
    //
    // queue:started is intentionally NOT broadcast for direct-send: the
    // message never went through the queue UI from the user's perspective,
    // and the chat bubble is already visible from chat:message-replay. Re-
    // broadcasting would cause the frontend's seenIdsRef dedup to fail when
    // generator's local id differs from the one already in history.
    //
    // wasQueued=true items take a different path: their messages[] push +
    // queue:started broadcast happens later in handleQueuedCommandReplay()
    // (or the turn-end fallback in handleMessageComplete) when the CLI
    // confirms AI saw the message. Until then they live as an "in-flight"
    // pill in the frontend queue panel.
    if (!item.wasQueued) {
      resetTurnUsage();
      currentTurnStartTime = Date.now();
      if (sessionId) beginTurnAbort(sessionId);
      const turnId = randomUUID().replace(/-/g, '').slice(0, 8);
      setAmbientLogContext(sessionId, { turnId, sessionId });
    } else if (inFlightToCliId === null) {
      // (v0.2.12 Codex review fix #1) wasQueued item arrived without an
      // existing in-flight tracker. Two paths reach here:
      //   - Recovery: finally-block rescue moved a pendingMidTurnQueue item
      //     into messageQueue front; the new generator pulls it but
      //     enqueueUserMessage's lockstep tracker (inFlightToCliId) was
      //     reset on the prior session's exit.
      //   - Direct push to messageQueue with wasQueued=true (defensive —
      //     no current call site does this, but the type allows it).
      // Either way we must register this item as in-flight so the
      // SDKUserMessageReplay handler can match it back, and the UI can
      // be eventually resolved via either replay or turn-end fallback.
      inFlightToCliId = item.id;
      inFlightMetadata = {
        messageText: item.messageText,
        attachments: item.attachments,
        requestId: item.requestId,
      };
      // Re-emit queue:added with isInFlight=true so the frontend pill's
      // X cancel button hides — recovery items are uncancellable just
      // like the normal in-flight ones (the new yield below crosses the
      // process boundary into CLI's commandQueue immediately).
      broadcast('queue:added', {
        queueId: item.id,
        messageText: item.messageText.slice(0, 100),
        isInFlight: true,
      });
      console.log(`[messageGenerator] Recovery path: wasQueued item ${item.id} adopted as in-flight (rescue or messageQueue push)`);
    }

    isStreamingMessage = true;
    // Pattern B+G: push this user message's requestId onto the FIFO queue.
    pushPendingRequest(item.requestId);

    // PRD 0.2.18 Session Inbox — per-turn binding (read at result handler /
    // abort path). Bound here at generator yield (NOT at enqueue), so the
    // mutable always reflects the turn that's actually about to execute.
    // Cleared at result handler / abort path; if a subsequent yield happens
    // before clear, the new binding overwrites — that's correct because SDK
    // persistent session yields one turn at a time.
    currentTurnInboxMeta = item.inboxMeta;
    if (currentTurnInboxMeta) {
      console.log(
        `[inbox] Bound turn inboxMeta from=${currentTurnInboxMeta.fromSessionId} replyBack=${currentTurnInboxMeta.replyBack} msgId=${currentTurnInboxMeta.originalMessageId}`,
      );
    }

    // Modality re-check at dequeue (see prior comment in pre-fix file).
    const yieldedMessage = stripUnsupportedModalityBlocks(item.message, currentModel);

    console.log(`[messageGenerator] Yielding message, wasQueued=${item.wasQueued}, queueId=${item.id}, requestId=${item.requestId ?? '-'}`);
    yield {
      type: 'user' as const,
      message: yieldedMessage,
      parent_tool_use_id: null,
      session_id: getSessionId(),
      // (v0.2.12) Stamp the queue item id as the SDK message uuid. CLI
      // forwards this through to attachment.source_uuid in queued_command
      // replay events, so handleQueuedCommandReplay can match the replay
      // back to our pending state and promote the next item.
      uuid: item.id as `${string}-${string}-${string}-${string}-${string}`,
    };
    item.resolve();
    promotedItemInFlight = false;
  }
}

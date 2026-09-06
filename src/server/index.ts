import { appendFileSync, cpSync, existsSync, lstatSync, readdirSync, readFileSync, statSync, unlinkSync, writeFileSync , rmSync, renameSync } from 'fs';
import { copyFile as copyFileAsync, readdir as readdirAsync, rm, stat } from 'fs/promises';
import { spawn as subprocessSpawn } from './utils/subprocess';
import { fileResponse, sniffMime } from './utils/file-response';
import { lookupExternalAttachment } from './runtimes/tool-attachments';
import { getToolAttachmentRoot, validateExternalReadPathNode } from './utils/path-safety';
import { serve as honoServe } from '@hono/node-server';
import { createWriteStream } from 'node:fs';
import { pipeline } from 'node:stream/promises';
import { Readable } from 'node:stream';

/**
 * Hard upper bound on a single multipart request body (aggregate of all files
 * + text fields). Sidecar lives on 127.0.0.1 so the threat model is mostly
 * local WebView / same-machine callers, but we still gate to prevent runaway
 * uploads from OOM-ing the Node.js heap. Node's standard `Request.formData()`
 * buffers the entire body before resolving — there is no streaming multipart
 * parser in the Web API — so this cap must be enforced via Content-Length
 * BEFORE calling `.formData()`.
 */
const MAX_UPLOAD_BYTES = 500 * 1024 * 1024; // 500 MB

/**
 * Check request Content-Length against MAX_UPLOAD_BYTES.
 * Returns a 413 Response to hand back, or null when within budget.
 * Missing Content-Length is treated as unknown — we still allow `.formData()`
 * to run, but callers should prefer Content-Length-aware clients.
 */
function rejectIfOversizedUpload(request: Request): Response | null {
  const lenHeader = request.headers.get('content-length');
  if (!lenHeader) return null;
  const len = Number(lenHeader);
  if (Number.isFinite(len) && len > MAX_UPLOAD_BYTES) {
    return jsonResponse(
      { error: `Upload too large (${len} bytes > ${MAX_UPLOAD_BYTES} limit).` },
      413,
    );
  }
  return null;
}

/**
 * Write an incoming Web `File` (multipart upload) to disk via streaming.
 *
 * NOTE: Node's `Request.formData()` already buffers the full body before
 * resolving the FormData — `file.stream()` here is reading from an
 * in-memory Blob, not from the live socket. The pipeline-to-disk still
 * helps by avoiding an extra `arrayBuffer() + Buffer.from()` copy, but
 * it does NOT bound memory during the parse itself. That bound is
 * enforced by `rejectIfOversizedUpload()` at the route edge.
 *
 * On error mid-pipeline, the partially-written destination is removed so
 * callers don't observe half-files on disk.
 */
async function streamUploadToFile(file: File, destination: string): Promise<void> {
  const webStream = file.stream() as unknown as ReadableStream<Uint8Array>;
  const nodeReadable = Readable.fromWeb(webStream as unknown as import('node:stream/web').ReadableStream<Uint8Array>);
  try {
    await pipeline(nodeReadable, createWriteStream(destination));
  } catch (err) {
    await rm(destination, { force: true }).catch(() => { /* best-effort cleanup */ });
    throw err;
  }
}
import { basename, dirname, isAbsolute, join, relative, resolve, extname, sep } from 'path';
import { homedir } from 'os';
import { randomUUID } from 'crypto';
import { elapsedMs, emitPerfTrace, nowMs } from './utils/perf-trace';
import { CrashDiagnostics } from './crash-diagnostics';
import { fetchWithGeneralProxy } from './utils/cancellation';
import { startOAuthMaintenanceForSidecarRole } from './mcp-oauth';
import {
  composeSidecarRequestHandler,
  resolveSidecarComposition,
  runSidecarBootstrap,
  type SidecarComposition,
} from './sidecar-composition';
import {
  aggregateGlobalUsageStats,
  buildSessionDetailedUsageStats,
} from './utils/usage-stats';
import { toClientSessionMetadata } from './utils/session-metadata-wire';
import { shouldBumpSessionRecency } from './session-core/session-metadata-patch-policy';
// adm-zip lazy-loaded at its one call site below (/api/skill/upload with zip
// content) — saves ~30ms of module-init cost when users never upload skills.
import {
  parseSkillFrontmatter,
  extractCommandName,
  parseFullSkillContent,
  parseFullCommandContent,
  serializeSkillContent,
  serializeCommandContent,
  type SkillFrontmatter,
  type CommandFrontmatter
} from '../shared/slashCommands';
import { sanitizeFolderName, isWindowsReservedName } from '../shared/utils';
import {
  assertKnownProductSystemSkillRequirement,
  isRequiredSystemSkill,
  type ProductSystemSkillRequirement,
  withoutRequiredSystemSkills,
} from '../shared/systemSkills';
import { resolveSkillUrl, type ResolvedSkillSource } from './skills/url-resolver';
import { fetchSkillZip, TarballFetchError } from './skills/tarball-fetcher';
import { loadSkillTree, SkillSourceLoadError } from './skills/source-loader';
import {
  analyseTree,
  buildInstallPayload,
  buildInstallPayloadForCandidate,
  pathEntryExistsNoFollow,
  publishSkillInstallPlan,
  SkillInstallError,
  skillTargetCollisionKey,
  type SkillCandidate,
} from './skills/installer';
import {
  installPlugin,
  uninstallPlugin,
  togglePlugin,
  listInstalledPlugins,
  getPluginDetail,
  PluginStoreError,
} from './plugins/store';
import { handleQrCodeAssetRoute } from './routes/qr-code-asset';
import { shouldLogHttpRequest } from './http-log-policy';

type SpaceSkillExportPackage = {
  tempId: string;
  filePath: string;
  suggestedFolderName: string;
  name: string;
  description: string;
  hasDangerousTools: boolean;
  rootPath: string;
  fileCount: number;
  packageSizeBytes: number;
  source: SpaceSkillSourceMeta;
};

type SpaceSkillSourceMeta = {
  type: 'github' | 'raw_zip' | 'url';
  url: string;
  resolvedUrl?: string | null;
  owner?: string | null;
  repo?: string | null;
  ref?: string | null;
  effectiveRef?: string | null;
  rootPath?: string | null;
  skillName?: string | null;
};

function encodeGithubPath(path: string): string {
  return path
    .split('/')
    .filter(Boolean)
    .map((segment) => encodeURIComponent(segment))
    .join('/');
}

function buildSkillSourceMeta(
  src: ResolvedSkillSource,
  tree: Awaited<ReturnType<typeof fetchSkillZip>>,
  cand: SkillCandidate,
): SpaceSkillSourceMeta {
  if (src.kind === 'github' && src.owner && src.repo) {
    const effectiveRef = tree.effectiveRef ?? src.ref ?? null;
    const rootPath = cand.rootPath || src.subPath || null;
    const baseUrl = `https://github.com/${encodeURIComponent(src.owner)}/${encodeURIComponent(src.repo)}`;
    const url = effectiveRef
      ? `${baseUrl}/tree/${encodeURIComponent(effectiveRef)}${rootPath ? `/${encodeGithubPath(rootPath)}` : ''}`
      : baseUrl;
    return {
      type: 'github',
      url,
      resolvedUrl: tree.sourceUrl,
      owner: src.owner,
      repo: src.repo,
      ref: src.ref ?? null,
      effectiveRef,
      rootPath,
      skillName: cand.suggestedFolderName,
    };
  }
  return {
    type: src.kind === 'raw-zip' ? 'raw_zip' : 'url',
    url: src.kind === 'raw-zip' ? src.rawZipUrl : tree.sourceUrl,
    resolvedUrl: tree.sourceUrl,
    rootPath: cand.rootPath || null,
    skillName: cand.suggestedFolderName,
  };
}

async function writeSpaceSkillExportPackages(
  tree: Awaited<ReturnType<typeof fetchSkillZip>>,
  source: ResolvedSkillSource,
  candidates: SkillCandidate[],
): Promise<SpaceSkillExportPackage[]> {
  const { default: AdmZip } = await import('adm-zip');
  const exportId = randomUUID();
  const exportDir = join(homedir(), '.myagents', 'tmp', 'skill-url-export', exportId);
  ensureDirSync(exportDir);

  const usedFileNames = new Map<string, number>();
  const packages: SpaceSkillExportPackage[] = [];

  for (const [index, cand] of candidates.entries()) {
    const files = buildInstallPayload(tree, [cand]).get(cand.suggestedFolderName);
    if (!files || files.size === 0) continue;

    const baseName = sanitizeFolderName(cand.suggestedFolderName);
    const count = usedFileNames.get(baseName) ?? 0;
    usedFileNames.set(baseName, count + 1);
    const fileStem = count === 0 ? baseName : `${baseName}-${count + 1}`;
    const filePath = join(exportDir, `${fileStem}.zip`);

    const zip = new AdmZip();
    for (const [relativePath, buf] of [...files.entries()].sort(([left], [right]) => left.localeCompare(right))) {
      zip.addFile(relativePath.replace(/\\/g, '/'), Buffer.from(buf));
    }
    zip.writeZip(filePath);

    packages.push({
      tempId: `${exportId}-${index}`,
      filePath,
      suggestedFolderName: baseName,
      name: cand.name,
      description: cand.description,
      hasDangerousTools: cand.hasDangerousTools,
      rootPath: cand.rootPath,
      fileCount: files.size,
      packageSizeBytes: statSync(filePath).size,
      source: buildSkillSourceMeta(source, tree, cand),
    });
  }

  return packages;
}

/**
 * Lazy bridge to agent-session.schedulePluginDeferredRestart — the latter
 * lives in a module index.ts cannot statically import (circular dep with
 * MCP / agent wiring). Dynamic import is cached after first call so the
 * cost is only paid once per process.
 */
async function schedulePluginRestartLazy(): Promise<void> {
  try {
    const mod = await import('./agent-session');
    mod.schedulePluginDeferredRestart();
  } catch (err) {
    console.warn('[plugins] schedulePluginRestartLazy failed (non-fatal):', err);
  }
}
import type { SessionSource, TurnAnalyticsSource } from './types/session';
import { isPendingSessionId } from '../shared/constants';
import { MANAGED_BROWSER_MCP_ID } from '../shared/browserTools';
import { parseAgentFrontmatter, parseFullAgentContent, serializeAgentContent } from '../shared/agentCommands';
import { scanAgents, readWorkspaceConfig, writeWorkspaceConfig, loadEnabledAgents, readAgentMeta, writeAgentMeta, findAgent } from './agents/agent-loader';
import type { AgentFrontmatter, AgentMeta, AgentWorkspaceConfig } from '../shared/agentTypes';
import {
  CODEX_SUBSCRIPTION_PROVIDER_ID,
  XAI_SUBSCRIPTION_PROVIDER_ID,
  isProjectArchived,
  isProjectVisibleToUser,
  type McpServerDefinition,
  type BackgroundAgentPermissionMode,
} from '../shared/config-types';
import { workspacePathsEqual } from '../shared/workspacePath';
import { ensureDirSync, ensureDir, isDirEntry } from './utils/fs-utils';
import {
  buildMemoryUpdateReminder,
  MEMORY_UPDATE_COMPLETION_MARKER,
} from './utils/memory-update-reminder';
import { setImCronContext } from './tools/im-cron-tool';
// admin-api module (~2900 lines, depends on zod + full config/session/cron surface)
// is lazy-loaded on first /api/admin/* hit to shave ~150ms off sidecar cold
// start. All handlers are only used inside routeAdminApi() below.
type AdminApiModule = typeof import('./admin-api');
let _adminApi: Promise<AdminApiModule> | null = null;
const getAdminApi = (): Promise<AdminApiModule> => (_adminApi ??= import('./admin-api'));
import { setImMediaContext } from './tools/im-media-tool';
import { ensureImBridgeToolSurface } from './tools/im-bridge-tools';
import { normalizeHostInteractionCapability, resolveImGroupToolsDeny } from './host-interaction';
import { getBuiltinMcpInstance } from './tools/builtin-mcp-registry';
// NOTE: builtin MCP META is auto-registered when agent-session.ts side-effect-imports
// './tools/builtin-mcp-meta'. No duplicate import needed here.

// ============= CRASH DIAGNOSTICS =============
// A crash artifact is now lazy: healthy STARTUP/EXIT/SIGTERM lifecycles stay
// in unified logging and never materialize a file under logs/crash/. The
// writer enforces its process-local file cap and rotation. The always-present
// Tauri process owns application-wide retention and upgrade backlog cleanup.
const crashDiagnostics = new CrashDiagnostics({
  getRecentLines: limit => getRecentLogLines(limit),
});

function crashLog(prefix: string, ...args: unknown[]): void {
  crashDiagnostics.record(prefix, ...args);
}

function dumpCrashContext(reason: string, error?: unknown): void {
  crashDiagnostics.recordContext(reason, error);
}

// Top-level beacon: fires BEFORE main(), proves JS module loading succeeded
try { process.stderr.write(`[startup] module loaded, pid=${process.pid}\n`); } catch { /* ignore */ }

// PRD #132 — silence stdio EPIPE before it can become an uncaughtException.
//
// When Tauri kills the sidecar's stdout/stderr pipe but the sidecar keeps
// running (orphaned via SIGKILL of parent, helper sidecar outliving owner,
// dev-server reload not killing children cleanly), the next write fails
// with EPIPE. Without an 'error' listener Node turns the unhandled stream
// error into uncaughtException, which our handler responded to by calling
// console.error → another EPIPE → another uncaughtException → a recursive
// loop that wrote 50–200 KB to the crash log per iteration at SSD-bound
// rate, growing a single file to 95–105 GB in minutes (issue #132).
//
// Installing 'error' listeners that swallow EPIPE/EBADF/ENOTCONN cuts the
// loop at the source: the failed write resolves to a no-op instead of
// fanning out into the fault handler. Other stdio errors keep their
// existing behavior so we still notice non-pipe-closure faults. Once the
// stdio sink is broken we mark `stdioBroken` and the wrapper console below
// stops attempting to write to it — defense in depth against any code path
// that bypasses our listener.
let stdioBroken = false;
const STDIO_BENIGN_CLOSE_CODES = new Set(['EPIPE', 'EBADF', 'ENOTCONN', 'ECONNRESET']);
function onStdioError(stream: 'stdout' | 'stderr') {
  return (err: NodeJS.ErrnoException) => {
    if (STDIO_BENIGN_CLOSE_CODES.has(err.code ?? '')) {
      if (!stdioBroken) {
        stdioBroken = true;
        // Best-effort note in crash log; this MUST NOT call console.* (which
        // would re-enter the same broken pipe and re-trigger the loop).
        try {
          crashLog('STDIO_CLOSED', `${stream} ${err.code ?? 'unknown'} — disabling future stdio writes for this sidecar`);
        } catch { /* ignore */ }
      }
      return; // swallow
    }
    // Non-pipe-closure error — record once, do not propagate.
    try { crashLog('STDIO_ERROR', `${stream} ${err.code ?? ''} ${err.message ?? ''}`); } catch { /* ignore */ }
  };
}
try { process.stdout.on('error', onStdioError('stdout')); } catch { /* ignore */ }
try { process.stderr.on('error', onStdioError('stderr')); } catch { /* ignore */ }
export function isStdioBroken(): boolean { return stdioBroken; }
export function markStdioBroken(): void { stdioBroken = true; }

// PRD #132 — uncaughtException re-entry guard + EPIPE-aware short circuit.
//
// Even with the stdio listeners above, an in-flight async write may still
// emit an EPIPE that becomes uncaughtException (timing window between the
// write call and the listener being invoked). Two defenses:
//   1. Re-entry guard: if the handler is already running (sync or
//      promise-resumed), drop subsequent fires until it returns. Prevents
//      a deep stack of nested handlers from forming.
//   2. EPIPE fast path: skip dumpCrashContext (the 200-line dump is what
//      grew the file by 50–200 KB per iteration) and skip the console.error
//      "feedback" line (the original recursion seed). Just record one
//      bare line so post-mortem still sees we hit it.
let inUncaughtHandler = false;
function isStdioPipeError(e: unknown): boolean {
  if (!e || typeof e !== 'object') return false;
  const code = (e as NodeJS.ErrnoException).code;
  if (code && STDIO_BENIGN_CLOSE_CODES.has(code)) return true;
  const msg = (e as Error).message ?? '';
  return /\bwrite\s+(EPIPE|EBADF|ENOTCONN)\b/i.test(msg);
}

process.on('uncaughtException', (err) => {
  if (inUncaughtHandler) {
    // Re-entry — drop. Recording even one line here would risk re-triggering.
    return;
  }
  inUncaughtHandler = true;
  try {
    if (isStdioPipeError(err)) {
      // Lightweight path: one line, no context dump, no console.error.
      // The stdio listeners above mark stdioBroken which makes the rest
      // of the process drop console writes anyway.
      crashLog('UNCAUGHT_EPIPE', err);
      stdioBroken = true;
      return;
    }
    crashLog('UNCAUGHT_EXCEPTION', err);
    dumpCrashContext('uncaughtException', err);
    if (!stdioBroken) {
      try { console.error('[process] uncaughtException:', err); } catch { /* ignore */ }
    }
  } finally {
    inUncaughtHandler = false;
  }
});

process.on('unhandledRejection', (reason) => {
  if (inUncaughtHandler) return;
  inUncaughtHandler = true;
  try {
    if (isStdioPipeError(reason)) {
      crashLog('UNHANDLED_REJECTION_EPIPE', reason);
      stdioBroken = true;
      return;
    }
    crashLog('UNHANDLED_REJECTION', reason);
    dumpCrashContext('unhandledRejection', reason);
    if (!stdioBroken) {
      try { console.error('[process] unhandledRejection:', reason); } catch { /* ignore */ }
    }
  } finally {
    inUncaughtHandler = false;
  }
});

let gracefulShutdownHook: (() => Promise<void>) | null = null;
let gracefulShutdownPromise: Promise<void> | null = null;
let processShutdownStarted = false;

async function shutdownOwnedResources(): Promise<void> {
  if (!gracefulShutdownPromise) {
    gracefulShutdownPromise = (async () => {
      if (!gracefulShutdownHook) return;
      let timeout: ReturnType<typeof setTimeout> | undefined;
      try {
        await Promise.race([
          gracefulShutdownHook(),
          new Promise<void>((_resolve, reject) => {
            timeout = setTimeout(
              () => reject(new Error('Owned resource shutdown timed out')),
              5_000,
            );
            timeout.unref?.();
          }),
        ]);
      } finally {
        if (timeout) clearTimeout(timeout);
      }
    })();
  }
  await gracefulShutdownPromise;
}

async function shutdownProcess(signal: 'SIGTERM' | 'SIGINT'): Promise<void> {
  if (processShutdownStarted) return;
  processShutdownStarted = true;
  if (!stdioBroken) {
    try { console.log(`[process] ${signal} received, shutting down...`); } catch { /* ignore */ }
  }
  try {
    await shutdownOwnedResources();
  } catch (error) {
    if (!stdioBroken) {
      try { console.error('[process] graceful resource shutdown failed:', error); } catch { /* ignore */ }
    }
  }
  process.exit(0);  // Trigger SDK's process.on('exit') handler → terminate CLI subprocess
}

process.on('SIGTERM', () => {
  void shutdownProcess('SIGTERM');
});

process.on('SIGINT', () => {
  void shutdownProcess('SIGINT');
});

// ============= END CRASH DIAGNOSTICS =============

import {
  getAgentState,
  getLogLines,
  getMessages,
  getSessionId,
  initializeAgent,
  getMcpServers,
  setGroupToolsDeny,
  setInteractionScenario,
  setSidecarPort,
  hasActiveBridge,
  getSessionModel,
  getSessionProviderEnv,
  syncProjectUserConfig,
  initSocksBridgeFromEnv,
  getHistoricalSessionMessages,
  ensureSdkMcpInSync,
  isCurrentImBridgeToolSurfaceInstalled,
  setBackgroundAgentPermissionMode,
} from './agent-session';
import type { ProviderEnv } from './provider-types';
import { getHomeDirOrNull } from './utils/platform';
import { getScriptDir } from './utils/runtime';
import {
  createSession,
  deleteSession,
  getAllSessionMetadata,
  getSessionData,
  getSessionDataFromMetadata,
  getSessionMetadata,
  getSessionsByAgentDir,
  isHistoryVisibleSession,
  listSessionUserTags,
  mutateGlobalSessionUserTag,
  mutateSessionUserTag,
  updateSessionMetadata,
  getAttachmentPath,
} from './SessionStore';
import { sessionUserTagFailureStatus } from './session-user-tag-http';
import { findProjectAgentByWorkspacePath, loadConfig, resolveImProviderRouting, resolveProviderEnv, resolveWorkspaceConfig } from './utils/admin-config';
import {
  projectCapabilitySnapshotForWire,
  resolveEffectiveProjectCapabilities,
  setProjectCapabilityEnabled,
} from './project-capabilities';
import { createGlobalSkillInventorySnapshot } from './global-skill-inventory';
import { isManagedSymlink } from './utils/project-user-config-sync';
import { managementApi } from './utils/management-api-client';
import { snapshotForOwnedSession } from './utils/session-snapshot';
import {
  isManagedCodexProviderReady,
  managedCodexNotReadyMessage,
} from './utils/managed-codex-readiness';
import { buildSessionSnapshotPatchUpdates } from './utils/session-snapshot-patch';
import {
  resolveLastVisibleTurnPreview,
  shrinkSessionMessagesForClient,
} from './utils/session-message-preview';
import type { AgentConfig } from '../shared/types/agent';
import type { SessionMetadata } from './types/session';
import { createConcreteProviderRoute, isConcreteProviderRoute, type ProviderRoute } from '../shared/providerRoute';
import { initLogger, getLoggerDiagnostics, withLogContext, setStdioBrokenProbe } from './logger';
// `isStdioBroken` / `markStdioBroken` are defined above (in the crash-
// diagnostics block) and consumed by `setStdioBrokenProbe` below to wire
// the logger's safe-write wrapper to the stdio-state bit.
import {
  buildGateResponseBody,
  buildReadyResponseBody,
  runDeferredInit,
  setDeferredInitPhase,
} from './readiness-state';
import { appendUnifiedLogBatch, getRecentLogLines, getActiveUnifiedLogPath } from './UnifiedLogger';
import { getActiveSessionLogPath } from './AgentLogger';
import { runLogRetentionSweep, startPeriodicSweep } from './log-retention';
import { broadcast, createSseClient, getClients } from './sse';
import { imEventBus } from './utils/im-event-bus';
import { buildImCancelledPayload } from './utils/im-terminal-payload';
import { imRequestRegistry } from './utils/im-request-registry';
import { raceWithAbortSignal } from './utils/cancellation';
import { checkAnthropicSubscription, verifyProviderViaSdk, verifySubscription } from './provider-verify';
import { cancelSubscriptionLogin, getSubscriptionLoginState, startSubscriptionLogin, submitSubscriptionLoginCode } from './subscription-auth';
// openai-bridge is lazy-loaded via ensureBridgeHandler() below — only users on
// OpenAI-protocol providers (DeepSeek/Moonshot/etc.) ever hit /v1/messages, so
// most sessions never need to pay the 2.6k-line module's init cost.
import type { BridgeHandler } from './openai-bridge/handler';
import { registerBridgeSeedFn } from './bridge-cache';
// title-generator is dynamically imported in the /api/title-generate handler
// below — it value-imports the Claude Agent SDK + claude-code/codex/gemini
// runtime classes, all of which are large. Pulling that into the Tier 0
// startup graph delayed `/health` bind on cold start (cf. v0.2.0 Tier 0
// goals) and crashed the sidecar before it could serve a 503 if the SDK
// native binary failed to load. The handler is in the post-bind path, so
// dynamic-import there is free.
import {
  queryRuntimeModels,
  getRuntimePermissionModes,
  getActiveRuntimeType,
} from './runtimes/external-session';
import {
  getAskUserQuestionResponseEngine,
  getPermissionResponseEngine,
  getSessionEngine,
  restoreInitialExternalSessionAtSelector,
  stopActiveTurn,
  stopOwnedTurn,
  stopOwnedTurnByQueueId,
} from './session-engine';
import { goalOrchestrator } from './session-engine';
import { createTaskDispatchGuard } from './session-engine/task-turn-orchestrator';
import { handleSessionEngineQueueRoute } from './routes/session-engine-queue';
import { handleSessionEngineRuntimeRoute } from './routes/session-engine-runtime';
import { handleSessionReadRoute } from './routes/session-read';
import { handleChatStreamRoute } from './routes/chat-stream';
import { handleSessionConfigRoute } from './routes/session-config';
import { handleSessionOperationRoute } from './routes/session-operations';
import {
  handleGoalExecuteSyncRoute,
  handleTaskExecuteSyncRoute,
} from './routes/scheduled-turns';
import { installAutoTitleHook } from './session-title-service';
import type { ImagePayload } from './runtimes/types';
import { rehomeImagePayloadsForSession } from './runtimes/image-payload';
import {
  VALID_RUNTIMES,
  coerceModelForRuntime,
  projectPermissionModeForRuntime,
  getMaxPermissionForRuntime,
} from '../shared/types/runtime';
import { coerceReasoningEffortForRuntime } from '../shared/reasoningEffort';
import {
  coerceRuntimeBirthReasoningEffort,
} from '../shared/runtimeBirthFields';
import type { RuntimeConfig, RuntimeSource, RuntimeType } from '../shared/types/runtime';
import {
  isPermissionModeForRuntimeIdentity,
  projectManagedCodexPermissionToRuntime,
  type RuntimeBackedProviderIdentity,
} from '../shared/providerExecution';
import { normalizeSessionOrigin, originFromTurnAttribution } from '../shared/session-origin';
import type { SessionOrigin } from '../shared/session-origin';
import {
  isSystemMaintenanceSession,
} from '../shared/managedScheduledJob';
import type { InteractionScenario } from './system-prompt';
import { buildCronEventRelayMessage, neutralizeSystemReminderStructuralTags } from './utils/cron-event-relay';
import { stripHeartbeatToken } from './utils/heartbeat-response';

type PermissionMode = 'auto' | 'plan' | 'fullAgency' | 'custom';

function getRuntimeSessionIdForRequest(): string {
  return getSessionEngine().getRuntimeIdentity().sessionId;
}

function resolveExternalPrewarmSessionId(requestedSessionId: string | undefined): string {
  if (requestedSessionId && !isPendingSessionId(requestedSessionId)) {
    return requestedSessionId;
  }
  return getRuntimeSessionIdForRequest();
}

/**
 * Runtime download URLs for common MCP commands
 */
const RUNTIME_DOWNLOAD_URLS: Record<string, { name: string; url: string }> = {
  'node': { name: 'Node.js', url: 'https://nodejs.org/' },
  'npx': { name: 'Node.js', url: 'https://nodejs.org/' },
  'npm': { name: 'Node.js', url: 'https://nodejs.org/' },
  'python': { name: 'Python', url: 'https://www.python.org/downloads/' },
  'python3': { name: 'Python', url: 'https://www.python.org/downloads/' },
  'deno': { name: 'Deno', url: 'https://deno.land/' },
  'uv': { name: 'uv (Python 包管理器)', url: 'https://docs.astral.sh/uv/' },
  'uvx': { name: 'uv (Python 包管理器)', url: 'https://docs.astral.sh/uv/' },
};

/**
 * Get download info for a command
 */
function getCommandDownloadInfo(command: string): { runtimeName?: string; downloadUrl?: string } {
  const info = RUNTIME_DOWNLOAD_URLS[command];
  if (info) {
    return { runtimeName: info.name, downloadUrl: info.url };
  }
  return {};
}

type SendMessagePayload = {
  text?: string;
  images?: ImagePayload[];
  sessionId?: string;
  permissionMode?: string;
  // Background-agent permission policy (#264). Global app-config value the
  // renderer echoes per-send (idempotent setter); controls the builtin
  // PermissionRequest hook for run_in_background sub-agents.
  backgroundAgentPermissionMode?: BackgroundAgentPermissionMode;
  runtimeConfig?: RuntimeConfig;
  model?: string;
  // #324 — reasoning effort setting ('default' | level). Omitted by IM/Task
  // callers (keep current session value); desktop sends its picker state.
  reasoningEffort?: string;
  providerRoute?: ProviderRoute;
  /** Per-turn analytics attribution; floating_ball also selects the desktop floating surface. */
  analyticsSource?: TurnAnalyticsSource;
  /** Stable session birth origin, present only when this desktop send creates/materializes a session. */
  birthOrigin?: unknown;
  /** Product workflow admission; validated against the compiled contract. */
  requiredSystemSkill?: unknown;
  // 'subscription' = explicit switch to Anthropic subscription (from desktop)
  // undefined/missing = "keep current provider" (safe default for IM/Task callers)
  // object = use this specific third-party provider
  providerEnv?: {
    providerId?: string;
    providerName?: string;
    baseUrl?: string;
    apiKey?: string;
    authType?: 'auth_token' | 'api_key' | 'both' | 'auth_token_clear_api_key';
    apiProtocol?: 'anthropic' | 'openai';
    maxOutputTokens?: number;
    maxOutputTokensParamName?: 'max_tokens' | 'max_completion_tokens' | 'max_output_tokens';
    upstreamFormat?: 'chat_completions' | 'responses';
    modelAliases?: { fable?: string; sonnet?: string; opus?: string; haiku?: string };
  } | 'subscription';
};

function desktopScenarioForAnalyticsSource(
  source: TurnAnalyticsSource | undefined,
): Extract<InteractionScenario, { type: 'desktop' }> {
  return source === 'floating_ball'
    ? { type: 'desktop', surface: 'floating-ball' }
    : { type: 'desktop' };
}

function getRuntimeConfigModel(
  runtimeConfig?: RuntimeConfig | null,
  runtime: RuntimeType = getActiveRuntimeType(),
): string | undefined {
  const model = runtimeConfig?.model?.trim();
  return model ? coerceModelForRuntime(model, runtime) : undefined;
}

/** #324 — RAW effort setting from runtimeConfig for ExternalSendContext.
 *  Always defined ('default' when unset): headless IM/cron callers resolve
 *  authoritatively from the agent each turn, and the context value must be
 *  able to express "explicitly back to default" — collapsing 'default' to
 *  undefined here would make external-session fall back to stale module
 *  state (a session bumped to xhigh would keep xhigh forever after the
 *  agent reverted to default; cross-review Critical). */
function getRuntimeConfigReasoningEffort(
  runtimeConfig?: RuntimeConfig | null,
  runtime: RuntimeType = getActiveRuntimeType(),
): string {
  const reasoningEffort = runtimeConfig?.reasoningEffort?.trim() || 'default';
  return coerceReasoningEffortForRuntime(reasoningEffort, runtime) ?? 'default';
}

function getRuntimeConfigPermissionMode(
  runtimeConfig?: RuntimeConfig | null,
  runtime: RuntimeType = getActiveRuntimeType(),
): string | undefined {
  const permissionMode = runtimeConfig?.permissionMode?.trim();
  return permissionMode ? projectPermissionModeForRuntime(permissionMode, runtime) : undefined;
}

function runtimeBackedProviderIdentityFromSnapshot(
  value: unknown,
): RuntimeBackedProviderIdentity | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const identity = value as Record<string, unknown>;
  const model = typeof identity.model === 'string' ? identity.model.trim() : '';
  if (
    identity.kind !== 'runtime-backed-provider'
    || identity.providerId !== CODEX_SUBSCRIPTION_PROVIDER_ID
    || identity.runtime !== 'codex'
    || identity.runtimeSource !== 'managed-provider'
    || !model
  ) {
    return undefined;
  }
  return {
    kind: 'runtime-backed-provider',
    providerId: CODEX_SUBSCRIPTION_PROVIDER_ID,
    runtime: 'codex',
    runtimeSource: 'managed-provider',
    model,
  };
}

function buildSnapshotRuntimeConfig(resolved: {
  model?: string;
  permissionMode?: string;
  reasoningEffort?: string;
}): RuntimeConfig {
  return {
    ...(resolved.model !== undefined ? { model: resolved.model } : {}),
    ...(resolved.permissionMode !== undefined ? { permissionMode: resolved.permissionMode } : {}),
    ...(resolved.reasoningEffort !== undefined ? { reasoningEffort: resolved.reasoningEffort } : {}),
  };
}

function cloneProviderEnvForImContext(env: ProviderEnv | undefined): ProviderEnv | undefined {
  return env ? {
    providerId: env.providerId,
    providerName: env.providerName,
    baseUrl: env.baseUrl,
    apiKey: env.apiKey,
    authType: env.authType,
    apiProtocol: env.apiProtocol,
    maxOutputTokens: env.maxOutputTokens,
    maxOutputTokensParamName: env.maxOutputTokensParamName,
    upstreamFormat: env.upstreamFormat,
    modelAliases: env.modelAliases,
  } : undefined;
}

/**
 * #264 — Self-resolve the background-agent permission policy from disk for the
 * IM / scheduled-Task lanes. Desktop sends carry it in the chat payload
 * (frontend is the authority), but background turns have no such payload, so
 * per CLAUDE.md's "Tab 由前端配, IM/Task self-resolve 从磁盘读" split they read `config.json`
 * directly. Idempotent; defaults to the conservative 'inherit' on any read
 * error so a missing/corrupt config never widens the background lane.
 */
function applyBackgroundAgentPermissionModeFromDisk(): void {
  try {
    const cfg = loadConfig();
    const mode = cfg.backgroundAgentPermissionMode === 'fullAgency' ? 'fullAgency' : 'inherit';
    setBackgroundAgentPermissionMode(mode);
  } catch {
    setBackgroundAgentPermissionMode('inherit');
  }
}

/**
 * PRD 0.2.9: live-resolve a per-task `providerId` into the value
 * `enqueueUserMessage` expects:
 *
 *   - api-type provider with apiKey      → ProviderEnv object
 *   - subscription-type provider         → `'subscription'` sentinel (clears
 *                                          the session's current providerEnv)
 *   - provider missing / api-type w/o key → throws (caller surfaces 400)
 *
 * The `'subscription'` sentinel is the documented contract of
 * `enqueueUserMessage` (agent-session.ts:5375-5383). Callers MUST forward
 * the literal string when switching to subscription, not `undefined` —
 * `undefined` means "keep current provider", which is the bug PRD 0.2.9 R1
 * was tracking.
 */
function parseArgs(argv: string[]): {
  agentDir: string;
  initialPrompt?: string;
  port: number;
  sessionId?: string;
  noPreWarm?: boolean;
  sidecarComposition: SidecarComposition;
} {
  const args = argv.slice(2);
  const getArgValue = (flag: string) => {
    const index = args.indexOf(flag);
    if (index === -1) {
      return null;
    }
    return args[index + 1] ?? null;
  };

  const agentDir = getArgValue('--agent-dir') ?? '';
  const initialPrompt = getArgValue('--prompt') ?? undefined;
  const port = Number(getArgValue('--port') ?? 3000);
  const sessionId = getArgValue('--session-id') ?? undefined;
  const noPreWarm = args.includes('--no-pre-warm');
  const sidecarComposition = resolveSidecarComposition(
    getArgValue('--sidecar-role'),
    args.includes('--dev-union'),
  );

  if (!agentDir) {
    throw new Error('Missing required argument: --agent-dir <path>');
  }

  return {
    agentDir,
    initialPrompt,
    port: Number.isNaN(port) ? 3000 : port,
    sessionId,
    noPreWarm,
    sidecarComposition,
  };
}

/**
 * Expand ~ to user's home directory
 */
function expandTilde(path: string): string {
  if (path.startsWith('~/') || path === '~') {
    const homeDir = getHomeDirOrNull() || '';
    return path.replace(/^~/, homeDir);
  }
  return path;
}

async function ensureAgentDir(dir: string): Promise<string> {
  const expanded = expandTilde(dir);
  const resolved = resolve(expanded);
  if (!existsSync(resolved)) {
    await ensureDir(resolved);
  }
  const info = await stat(resolved);
  if (!info.isDirectory()) {
    throw new Error(`Agent directory is not a directory: ${resolved}`);
  }
  return resolved;
}

// ============= SKILLS CONFIG & SEED =============

interface SkillsConfig {
  seeded: string[];
  disabled: string[];
  generation: number;  // Monotonic counter — incremented on every skill CRUD operation
}

function getSkillsConfigPath(): string {
  const homeDir = getHomeDirOrNull() || '';
  return join(homeDir, '.myagents', 'skills-config.json');
}

function readSkillsConfig(): SkillsConfig {
  const configPath = getSkillsConfigPath();
  const defaults: SkillsConfig = { seeded: [], disabled: [], generation: 0 };
  try {
    if (existsSync(configPath)) {
      const raw = JSON.parse(readFileSync(configPath, 'utf-8'));
      return {
        seeded: Array.isArray(raw?.seeded) ? raw.seeded : defaults.seeded,
        // Required product contracts remain exposed even if an older config
        // contains stale disabled entries. The toggle route rejects new
        // attempts and writes canonicalize the persisted list.
        disabled: Array.isArray(raw?.disabled)
          ? withoutRequiredSystemSkills(raw.disabled)
          : defaults.disabled,
        generation: typeof raw?.generation === 'number' ? raw.generation : 0,
      };
    }
  } catch (err) {
    console.warn('[skills-config] Error reading config:', err);
  }
  return defaults;
}

function writeSkillsConfig(config: SkillsConfig): void {
  const configPath = getSkillsConfigPath();
  try {
    const dir = dirname(configPath);
    ensureDirSync(dir);
    config.disabled = withoutRequiredSystemSkills(config.disabled);
    // Auto-increment generation on every write — signals Tab Sidecars to re-sync symlinks
    config.generation = (config.generation || 0) + 1;
    writeFileSync(configPath, JSON.stringify(config, null, 2), 'utf-8');
  } catch (err) {
    console.error('[skills-config] Error writing config:', err);
  }
}

/**
 * Bump skills generation counter without changing seeded/disabled lists.
 * Called after skill CRUD operations (create/update/delete/upload/import)
 * that don't go through writeSkillsConfig but DO change the available skill set.
 * Sessions observe the generation through their next capability resolution.
 */
function bumpSkillsGeneration(): void {
  const config = readSkillsConfig();
  writeSkillsConfig(config);
}

/**
 * Capability reads are side-effect free. Each Session reconciles the latest
 * AgentConfig selection at its next turn boundary; shared disk inventory is
 * maintained independently for runtime compatibility.
 */
// Phase E (PRD 0.2.7): the old generation-cached fast path remains removed.

/**
 * Resolve bundled-skills directory.
 * - Production (macOS): Contents/Resources/bundled-skills/
 * - Production (Windows): <install-dir>/bundled-skills/
 * - Development: <project-root>/bundled-skills/
 */
function resolveBundledSkillsDir(): string | null {
  const scriptDir = getScriptDir();

  // Production: bundled-skills is alongside server-dist.js in Resources
  const prodPath = resolve(scriptDir, 'bundled-skills');
  if (existsSync(prodPath)) return prodPath;

  // Development: bundled-skills is at project root
  // In dev, scriptDir is something like <project>/src/server/utils
  // Walk up to find bundled-skills at project root
  let dir = scriptDir;
  for (let i = 0; i < 5; i++) {
    const devPath = resolve(dir, 'bundled-skills');
    if (existsSync(devPath)) return devPath;
    dir = dirname(dir);
  }

  return null;
}

/**
 * System skills — owned by the app, version-gated by the Rust side
 * (`SYSTEM_SKILLS` + `SYSTEM_SKILLS_VERSION` in `src-tauri/src/commands.rs`).
 * These are skipped by `seedBundledSkills` below because their lifecycle
 * is "force-overwrite on every version bump", not "seed once then leave
 * alone". Keep this list in sync with the Rust constant — a mismatch
 * would either double-seed (harmless but confusing logs) or skip a
 * genuine user skill named identically.
 */
const SYSTEM_SKILLS: readonly string[] = [
  // Optional native desktop Skill; Rust owns complete bundle updates.
  'cuse',
  'myagents-task-alignment',
  // v10: ultra-research removed — not generic enough.
  'download-anything',
  // v9: myagents-cli — global skill that exposes the entire `myagents`
  // CLI surface (cron / task / mcp / model / agent / runtime / skill /
  // plugin / widget / im / config) to every AI session in the product.
  // Force-synced because SKILL.md must track CLI changes in lockstep.
  'myagents-cli',
  // v49: progressive instructions for the bundled offline document converter.
  'myagents-anydoc',
  // v54: progressive instructions for Session-scoped local attachment ASR.
  'myagents-speech-recognition',
  // v44: one Agent workflow for scheduled, future and conditional Task
  // automation; command Detector protocol is progressively disclosed inside.
  'myagents-task-automation',
  // v35: stable product-use knowledge and expected-behaviour contract for
  // every MyAgents session. Live operations remain in myagents-cli.
  'myagents-docs',
  // v18: tool-creator — meta-skill for the CLI tool registry (PRD 0.2.36).
  // Teaches AI to author standards-compliant Agent-CLI tools and register
  // them via `myagents tool add`. Force-synced because its contract (eight
  // rules / description cap / readme template) must track registry
  // validation in lockstep.
  'tool-creator',
  // v33: hidden memory-maintenance flows target these skills by exact name.
  // Force-sync so the injected prompt, managed tasks, and skill workflow stay
  // consistent across app upgrades.
  'myagents-memory-update',
  'myagents-memory-gardener',
  'myagents-memory-molt',
  // v50: skill-creator promoted from utility → system skill so its bundled
  // workflow and evaluation scripts update existing installations.
  'skill-creator',
  // v29: prompt-writer promoted from utility → system skill so content
  // improvements reach existing installs (seed-once never updates).
  'prompt-writer',
];

function isSystemSkillName(name: string): boolean {
  return SYSTEM_SKILLS.includes(name.toLowerCase());
}

/**
 * Seed bundled skills to ~/.myagents/skills/ on first launch.
 * Only copies skills that haven't been seeded before (tracked in skills-config.json).
 *
 * System skills (SYSTEM_SKILLS above) are owned by Rust's
 * `cmd_sync_system_skills` and are skipped here — they need the
 * version-gated force-overwrite path, not the seed-once-then-hands-off
 * path. If we seeded them here AND Rust overwrote them, the interaction
 * would be harmless (Rust always wins, ordering-wise) but we'd log a
 * "skipped existing folder" every boot, and the `config.seeded` array
 * would grow stale entries users don't recognise.
 */
function seedBundledSkills(): void {
  try {
    const bundledDir = resolveBundledSkillsDir();
    if (!bundledDir) {
      console.log('[seed] Bundled skills directory not found, skipping seed');
      return;
    }

    const config = readSkillsConfig();
    const homeDir = getHomeDirOrNull() || '';
    const userSkillsDir = join(homeDir, '.myagents', 'skills');

    ensureDirSync(userSkillsDir);

    const bundledFolders = readdirSync(bundledDir, { withFileTypes: true })
      .filter(d => d.isDirectory())
      .map(d => d.name);

    let changed = false;
    for (const folder of bundledFolders) {
      if (isSystemSkillName(folder)) {
        // Owned by Rust version gate — skip silently.
        continue;
      }
      const dst = join(userSkillsDir, folder);

      // Detect broken symlinks at dst BEFORE any operation that resolves the
      // path. Node v24's cpSync C++ implementation calls
      // `std::filesystem::equivalent(src, dst)` for src/dst equality
      // detection; on a broken symlink that throws an uncaught C++ exception
      // (`libc++abi: ... filesystem error: in equivalent: Operation not
      // supported`) which terminates the entire sidecar — JS try/catch
      // cannot intercept it. existsSync follows the link and returns false,
      // hiding the symlink from every guard below, so we must lstat first.
      // Repro: `node -e 'fs.cpSync("/tmp/src", "/tmp/dangling", {recursive:true})'`
      // where /tmp/dangling -> /nonexistent. Reported as user crash on v0.2.5
      // (~/.myagents/skills/docx pointed at a deleted target).
      let dstLstat: ReturnType<typeof lstatSync> | null = null;
      try {
        dstLstat = lstatSync(dst);
      } catch {
        // dst doesn't exist — fall through to seed path
      }
      const dstExists = existsSync(dst); // follows symlinks
      const isBrokenSymlink = dstLstat?.isSymbolicLink() && !dstExists;

      if (isBrokenSymlink) {
        try {
          unlinkSync(dst);
          console.warn(`[seed] Removed broken symlink at ${dst} so the bundled skill can seed`);
        } catch (err) {
          console.warn(`[seed] Failed to remove broken symlink ${dst}, skipping:`, err);
          continue;
        }
      }

      // Re-seed if marked as seeded but directory was deleted (or was a broken symlink we just cleared)
      if (config.seeded.includes(folder) && dstExists) continue;

      const src = join(bundledDir, folder);
      // Packaging guard (issue #321, mirrors Rust cmd_sync_system_skills):
      // only treat a bundled folder as a seedable skill if it carries a
      // SKILL.md. An empty / SKILL.md-less source dir is a packaging defect —
      // seeding it would copy an empty directory that every SKILL.md-gated
      // scanner (Settings panel, slash picker, SDK runtime) ignores, and
      // marking it `seeded` would freeze that broken state so a corrected
      // bundle never re-seeds. Skip without marking seeded → retries next launch.
      if (!existsSync(join(src, 'SKILL.md'))) {
        console.warn(`[seed] Bundled skill incomplete (no SKILL.md), skipping: ${folder}`);
        continue;
      }
      // Skip if destination already exists (don't overwrite user's custom content)
      if (dstExists) {
        config.seeded.push(folder);
        changed = true;
        console.log(`[seed] Skipped existing folder: ${folder}`);
        continue;
      }
      try {
        cpSync(src, dst, { recursive: true });
        console.log(`[seed] Seeded skill: ${folder}`);
      } catch (err) {
        console.warn(`[seed] Failed to seed skill ${folder}:`, err);
        continue;
      }

      config.seeded.push(folder);
      changed = true;
    }

    if (changed) {
      writeSkillsConfig(config);
    }
  } catch (err) {
    console.error('[seed] Error seeding bundled skills:', err);
  }
}

/**
 * Ensure the ~/.myagents/plugins/ directory tree exists for Claude Plugin
 * support (PRD 0.2.17). Unlike skills, plugins are never seeded by the app —
 * the user installs them via UI/CLI, and the directories below merely have
 * to exist so first-install doesn't have to MkDir-A-Path twice.
 *
 *   ~/.myagents/plugins/                  plugin install root
 *   ~/.myagents/plugins/data/             ${CLAUDE_PLUGIN_DATA} parent
 *
 * Idempotent. Called at sidecar startup alongside seedBundledSkills.
 */
function ensurePluginsDirs(): void {
  try {
    const homeDir = getHomeDirOrNull();
    if (!homeDir) {
      console.warn('[plugins] HOME not resolvable — skipping ensurePluginsDirs');
      return;
    }
    const root = join(homeDir, '.myagents', 'plugins');
    const dataRoot = join(root, 'data');
    ensureDirSync(root);
    ensureDirSync(dataRoot);
  } catch (err) {
    console.warn('[plugins] ensurePluginsDirs failed (non-fatal):', err);
  }
}

// ============= END SKILLS CONFIG & SEED =============

/**
 * Validate that the agent directory is safe to access.
 * Prevents directory traversal attacks and access to sensitive directories.
 */
function isValidAgentDir(dir: string): { valid: boolean; reason?: string } {
  const expanded = expandTilde(dir);
  const resolved = resolve(expanded);
  const homeDir = getHomeDirOrNull() || '';

  // Must be an absolute path (use isAbsolute for cross-platform correctness)
  if (!isAbsolute(resolved)) {
    return { valid: false, reason: 'Path must be absolute' };
  }

  // Forbidden system directories (deny-list approach)
  const forbiddenPaths = [
    // Unix system directories
    '/etc', '/var', '/usr', '/bin', '/sbin', '/boot', '/root', '/sys', '/proc', '/dev',
    // User sensitive directories
    join(homeDir, '.ssh'),
    join(homeDir, '.gnupg'),
    join(homeDir, '.config/op'),  // 1Password
    join(homeDir, 'Library/Keychains'),
    // Windows system directories
    'C:\\Windows',
    'C:\\Program Files',
    'C:\\Program Files (x86)',
  ];

  const normalizedResolved = resolved.replace(/\\/g, '/').toLowerCase();
  for (const forbidden of forbiddenPaths) {
    const normalizedForbidden = forbidden.replace(/\\/g, '/').toLowerCase();
    if (normalizedResolved === normalizedForbidden || normalizedResolved.startsWith(normalizedForbidden + '/')) {
      return { valid: false, reason: `Access to ${forbidden} is not allowed` };
    }
  }

  // Reject filesystem roots as workspace (too broad, not a real project)
  // Windows: "C:\", "D:\" etc.  Unix: "/"
  if (resolved === '/' || resolved.match(/^[A-Z]:\\?$/i)) {
    return { valid: false, reason: 'Cannot use filesystem root as workspace' };
  }

  return { valid: true };
}

function resolveAgentPath(root: string, relativePath: string): string | null {
  // Strip leading slashes (both / and \ for Windows compatibility)
  const normalized = relativePath.replace(/^[/\\]+/, '');
  const resolved = resolve(root, normalized);
  // Use root + sep to prevent prefix collision (e.g. /agent matching /agent-other)
  if (resolved !== root && !resolved.startsWith(root + sep)) {
    return null;
  }
  return resolved;
}

// Phase E (PRD 0.2.7): the legacy read-side helpers `isSafeReadPath`,
// `resolveReadPath`, `isPreviewableText` are removed. Their gates now live
// in Rust workspace_files (`path_safety::validate_workspace_root`,
// `resolve_existing_inside_workspace`, `read_preview::is_previewable`).

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' }
  });
}

async function handleGoalExecuteSync(request: Request): Promise<Response> {
  return handleGoalExecuteSyncRoute(request, {
    getEngine: getSessionEngine,
    getWorkspacePath: () => getAgentState().agentDir,
  });
}

function isGenericSessionTitle(title: string | undefined): boolean {
  const trimmed = (title ?? '').trim();
  return trimmed === '' || trimmed === 'New Chat' || trimmed === 'New Tab';
}

function normalizeSessionListPreview(meta: SessionMetadata): SessionMetadata {
  if (!isGenericSessionTitle(meta.title)) return meta;
  if (!meta.runtime || meta.runtime === 'builtin') return meta;

  const data = getSessionData(meta.id);
  const resolved = data
    ? resolveLastVisibleTurnPreview(data.messages)
    : { found: false as const };
  if (resolved.found) {
    return { ...meta, lastMessagePreview: resolved.preview };
  }

  // v0.2.22 external runtimes stored assistant text in lastMessagePreview.
  // For generic-title rows that have no real user preview, prefer "New Chat"
  // over carrying that stale assistant snippet into every list surface.
  if (meta.lastMessagePreview) {
    return { ...meta, lastMessagePreview: undefined };
  }

  return meta;
}

/**
 * Route /api/admin/* requests to the appropriate handler.
 * Keeps the route matching logic clean and separated from business logic (in admin-api.ts).
 */
async function routeAdminApi(
  pathname: string,
  payload: Record<string, unknown>,
  signal?: AbortSignal,
): Promise<Record<string, unknown>> {
  // Strip the prefix for matching
  const route = pathname.replace('/api/admin/', '');

  // Lazy-load admin-api (~150ms on first hit, cached thereafter)
  const api = await getAdminApi();

  // MCP commands
  if (route === 'mcp/list') return api.handleMcpList();
  if (route === 'mcp/show') return await api.handleMcpShow(payload as Parameters<typeof api.handleMcpShow>[0]);
  if (route === 'mcp/add') return api.handleMcpAdd(payload as Parameters<typeof api.handleMcpAdd>[0]);
  if (route === 'mcp/remove') return api.handleMcpRemove(payload as Parameters<typeof api.handleMcpRemove>[0]);
  if (route === 'mcp/enable') return api.handleMcpEnable(payload as Parameters<typeof api.handleMcpEnable>[0]);
  if (route === 'mcp/disable') return api.handleMcpDisable(payload as Parameters<typeof api.handleMcpDisable>[0]);
  if (route === 'mcp/env') return api.handleMcpEnv(payload as Parameters<typeof api.handleMcpEnv>[0]);
  if (route === 'mcp/test') return await api.handleMcpTest(payload as Parameters<typeof api.handleMcpTest>[0]);
  if (route === 'mcp/oauth/discover') return await api.handleMcpOAuthDiscover(payload as Parameters<typeof api.handleMcpOAuthDiscover>[0]);
  if (route === 'mcp/oauth/start') return await api.handleMcpOAuthStart(payload as Parameters<typeof api.handleMcpOAuthStart>[0]);
  if (route === 'mcp/oauth/status') return await api.handleMcpOAuthStatus(payload as Parameters<typeof api.handleMcpOAuthStatus>[0]);
  if (route === 'mcp/oauth/revoke') return await api.handleMcpOAuthRevoke(payload as Parameters<typeof api.handleMcpOAuthRevoke>[0]);

  // CLI tool registry commands (PRD 0.2.36)
  if (route === 'tool/list') return api.handleToolList();
  if (route === 'tool/info') return api.handleToolInfo(payload as Parameters<typeof api.handleToolInfo>[0]);
  if (route === 'tool/add') return await api.handleToolAdd(payload as Parameters<typeof api.handleToolAdd>[0]);
  if (route === 'tool/remove') return await api.handleToolRemove(payload as Parameters<typeof api.handleToolRemove>[0]);
  if (route === 'tool/enable') return await api.handleToolEnable(payload as Parameters<typeof api.handleToolEnable>[0]);
  if (route === 'tool/disable') return await api.handleToolDisable(payload as Parameters<typeof api.handleToolDisable>[0]);
  if (route === 'tool/readme') return await api.handleToolReadme(payload as Parameters<typeof api.handleToolReadme>[0]);
  if (route === 'tool/env') return await api.handleToolEnv(payload as Parameters<typeof api.handleToolEnv>[0]);

  // Official MyAgents CLI tools
  if (route === 'anydoc/convert') return await api.handleAnydocConvert(payload as Parameters<typeof api.handleAnydocConvert>[0]);
  if (route === 'anydoc/status') return await api.handleAnydocStatus(payload as Parameters<typeof api.handleAnydocStatus>[0]);
  if (route === 'anydoc/cancel') return await api.handleAnydocCancel(payload as Parameters<typeof api.handleAnydocCancel>[0]);
  if (route === 'anydoc/list') return await api.handleAnydocList(payload as Parameters<typeof api.handleAnydocList>[0]);
  if (route === 'speech/transcribe') return await api.handleSpeechTranscribe(payload as Parameters<typeof api.handleSpeechTranscribe>[0]);
  if (route === 'speech/status') return await api.handleSpeechStatus(payload as Parameters<typeof api.handleSpeechStatus>[0]);
  if (route === 'speech/cancel') return await api.handleSpeechCancel(payload as Parameters<typeof api.handleSpeechCancel>[0]);
  if (route === 'speech/list') return await api.handleSpeechList(payload as Parameters<typeof api.handleSpeechList>[0]);
  if (route === 'vision/readme') return await api.handleVisionReadme();
  if (route === 'vision/models') return api.handleVisionModels();
  if (route === 'vision/analyze') return await api.handleVisionAnalyze(payload as Parameters<typeof api.handleVisionAnalyze>[0]);

  // Model commands
  if (route === 'model/list') return api.handleModelList();
  if (route === 'model/add') return api.handleModelAdd(payload as Parameters<typeof api.handleModelAdd>[0]);
  if (route === 'model/remove') return api.handleModelRemove(payload as Parameters<typeof api.handleModelRemove>[0]);
  if (route === 'model/set-key') return api.handleModelSetKey(payload as Parameters<typeof api.handleModelSetKey>[0]);
  if (route === 'model/set-default') return api.handleModelSetDefault(payload as Parameters<typeof api.handleModelSetDefault>[0]);
  if (route === 'model/verify') return await api.handleModelVerify(payload as Parameters<typeof api.handleModelVerify>[0]);

  // Agent commands
  if (route === 'agent/list') return await api.handleAgentList(payload as Parameters<typeof api.handleAgentList>[0]);
  if (route === 'agent/current') return await api.handleAgentCurrent();
  if (route === 'agent/show') return await api.handleAgentShow(payload as Parameters<typeof api.handleAgentShow>[0]);
  if (route === 'agent/enable') return api.handleAgentEnable(payload as Parameters<typeof api.handleAgentEnable>[0]);
  if (route === 'agent/disable') return api.handleAgentDisable(payload as Parameters<typeof api.handleAgentDisable>[0]);
  if (route === 'agent/archive') return api.handleAgentArchive(payload as Parameters<typeof api.handleAgentArchive>[0]);
  if (route === 'agent/unarchive') return api.handleAgentUnarchive(payload as Parameters<typeof api.handleAgentUnarchive>[0]);
  if (route === 'agent/set') return api.handleAgentSet(payload as Parameters<typeof api.handleAgentSet>[0]);
  if (route === 'agent/channel/list') return api.handleAgentChannelList(payload as Parameters<typeof api.handleAgentChannelList>[0]);
  if (route === 'agent/channel/add') return api.handleAgentChannelAdd(payload as Parameters<typeof api.handleAgentChannelAdd>[0]);
  if (route === 'agent/channel/remove') return api.handleAgentChannelRemove(payload as Parameters<typeof api.handleAgentChannelRemove>[0]);
  if (route === 'runtime/list') return await api.handleRuntimeList();
  if (route === 'runtime/describe') return await api.handleRuntimeDescribe(payload as Parameters<typeof api.handleRuntimeDescribe>[0], signal);
  if (route === 'runtime/diagnose') return await api.handleRuntimeDiagnose(payload as Parameters<typeof api.handleRuntimeDiagnose>[0]);
  if (route === 'diagnose/runtime') return await api.handleRuntimeDiagnose(payload as Parameters<typeof api.handleRuntimeDiagnose>[0]);

  // Agent runtime status
  if (route === 'agent/runtime-status') return await api.handleAgentRuntimeStatus();

  // Cron task commands
  if (route === 'cron/list') return await api.handleCronList(payload as Parameters<typeof api.handleCronList>[0]);
  if (route === 'cron/add') return await api.handleCronCreate(payload);
  if (route === 'cron/start') return await api.handleCronStart(payload as Parameters<typeof api.handleCronStart>[0]);
  if (route === 'cron/run-now') return await api.handleCronRunNow(payload as Parameters<typeof api.handleCronRunNow>[0]);
  if (route === 'cron/stop') return await api.handleCronStop(payload as Parameters<typeof api.handleCronStop>[0]);
  if (route === 'cron/remove') return await api.handleCronDelete(payload as Parameters<typeof api.handleCronDelete>[0]);
  if (route === 'cron/update') return await api.handleCronUpdate(payload as Parameters<typeof api.handleCronUpdate>[0]);
  if (route === 'cron/runs') return await api.handleCronRuns(payload as Parameters<typeof api.handleCronRuns>[0]);
  if (route === 'cron/status') return await api.handleCronStatus(payload as Parameters<typeof api.handleCronStatus>[0]);
  if (route === 'cron/exit') return api.handleCronExit(payload as Parameters<typeof api.handleCronExit>[0]);

  // Goal Mode commands
  if (route === 'goal/get') return await api.handleGoalGet();
  if (route === 'goal/create') return await api.handleGoalCreate(payload as Parameters<typeof api.handleGoalCreate>[0]);
  if (route === 'goal/update') return await api.handleGoalUpdate(payload as Parameters<typeof api.handleGoalUpdate>[0]);

  // IM runtime commands. send-media + wake are session-scoped (require an
  // IM Bot / Agent Channel context — handlers reject otherwise). channels is
  // not session-scoped: it discovers all configured IM bots and works in any
  // session, including desktop, so the AI can reference targets when creating
  // cron tasks that deliver to IM.
  if (route === 'im/send-media') return await api.handleImSendMedia(payload as Parameters<typeof api.handleImSendMedia>[0]);
  if (route === 'im/wake') return await api.handleImWake(payload as Parameters<typeof api.handleImWake>[0]);
  if (route === 'im/channels') return await api.handleImChannels();

  // Tool readme — progressive-disclosure helpers for external runtimes
  if (route === 'readme/task' || route === 'readme/cron' || route === 'readme/im' || route === 'readme/widget' || route === 'readme/thought') {
    const topic = route.split('/')[1];
    return api.handleReadme({
      topic,
      modules: Array.isArray(payload.modules) ? (payload.modules as string[]) : undefined,
    });
  }

  // OpenClaw Channel Plugin commands (npm-packaged IM channel adapters)
  if (route === 'plugin/list') return await api.handlePluginList();
  if (route === 'plugin/install') return await api.handlePluginInstall(payload as Parameters<typeof api.handlePluginInstall>[0]);
  if (route === 'plugin/remove') return await api.handlePluginUninstall(payload as Parameters<typeof api.handlePluginUninstall>[0]);

  // Claude Plugin commands (PRD 0.2.17) — Anthropic-spec plugin directories
  // containing skills/agents/MCP/hooks. Different concept from the OpenClaw
  // channel plugins above; namespaced as `cc-plugin` to avoid collision.
  if (route === 'cc-plugin/list') return await api.handleCcPluginList();
  if (route === 'cc-plugin/show') return await api.handleCcPluginShow(payload as Parameters<typeof api.handleCcPluginShow>[0]);
  if (route === 'cc-plugin/install') return await api.handleCcPluginInstall(payload as Parameters<typeof api.handleCcPluginInstall>[0]);
  if (route === 'cc-plugin/uninstall') return await api.handleCcPluginUninstall(payload as Parameters<typeof api.handleCcPluginUninstall>[0]);
  if (route === 'cc-plugin/enable') return await api.handleCcPluginToggle({
    id: payload.id as string | undefined,
    name: payload.name as string | undefined,
    enabled: true,
  });
  if (route === 'cc-plugin/disable') return await api.handleCcPluginToggle({
    id: payload.id as string | undefined,
    name: payload.name as string | undefined,
    enabled: false,
  });

  // Skill commands
  if (route === 'skill/list') return await api.handleSkillList();
  if (route === 'skill/info') return await api.handleSkillInfo(payload as Parameters<typeof api.handleSkillInfo>[0]);
  if (route === 'skill/add') return await api.handleSkillAdd(payload as Parameters<typeof api.handleSkillAdd>[0]);
  if (route === 'skill/remove') return await api.handleSkillRemove(payload as Parameters<typeof api.handleSkillRemove>[0]);
  if (route === 'skill/enable') return await api.handleSkillToggle({ name: String(payload.name ?? ''), enabled: true });
  if (route === 'skill/disable') return await api.handleSkillToggle({ name: String(payload.name ?? ''), enabled: false });
  if (route === 'skill/sync') return await api.handleSkillSync();

  // Config commands
  if (route === 'config/get') return api.handleConfigGet(payload as Parameters<typeof api.handleConfigGet>[0]);
  if (route === 'config/set') return api.handleConfigSet(payload as Parameters<typeof api.handleConfigSet>[0]);

  // Task Center — thoughts + tasks (v0.1.69)
  if (route === 'task/list') return await api.handleTaskList(payload as Parameters<typeof api.handleTaskList>[0]);
  if (route === 'task/get') return await api.handleTaskGet(payload as Parameters<typeof api.handleTaskGet>[0]);
  if (route === 'task/comments') return await api.handleTaskComments(payload as Parameters<typeof api.handleTaskComments>[0]);
  if (route === 'task/comment') return await api.handleTaskComment(payload as Parameters<typeof api.handleTaskComment>[0]);
  if (route === 'task/create-direct') return await api.handleTaskCreateDirect(payload);
  if (route === 'task/create-attached') return await api.handleTaskCreateAttached(payload);
  if (route === 'task/run') return await api.handleTaskRun(payload as Parameters<typeof api.handleTaskRun>[0]);
  if (route === 'task/run-now') return await api.handleTaskRunNow(payload as Parameters<typeof api.handleTaskRunNow>[0]);
  if (route === 'task/rerun') return await api.handleTaskRerun(payload as Parameters<typeof api.handleTaskRerun>[0]);
  if (route === 'task/trigger/validate') return await api.handleTaskTriggerValidate(payload as Parameters<typeof api.handleTaskTriggerValidate>[0]);
  if (route === 'task/trigger/test') return await api.handleTaskTriggerTest(payload);
  if (route === 'task/check-now') return await api.handleTaskCheckNow(payload as Parameters<typeof api.handleTaskCheckNow>[0]);
  if (route === 'task/reset-checkpoint') return await api.handleTaskResetCheckpoint(payload as Parameters<typeof api.handleTaskResetCheckpoint>[0]);
  if (route === 'task/update') return await api.handleTaskUpdate(payload);
  if (route === 'task/update-status') return await api.handleTaskUpdateStatus(payload);
  if (route === 'task/append-session') return await api.handleTaskAppendSession(payload as Parameters<typeof api.handleTaskAppendSession>[0]);
  if (route === 'task/archive') return await api.handleTaskArchive(payload as Parameters<typeof api.handleTaskArchive>[0]);
  if (route === 'task/delete') return await api.handleTaskDelete(payload as Parameters<typeof api.handleTaskDelete>[0]);
  if (route === 'task/read-doc') return await api.handleTaskReadDoc(payload as Parameters<typeof api.handleTaskReadDoc>[0]);
  if (route === 'task/write-doc') return await api.handleTaskWriteDoc(payload as Parameters<typeof api.handleTaskWriteDoc>[0]);
  if (route === 'thought/list') return await api.handleThoughtList(payload as Parameters<typeof api.handleThoughtList>[0]);
  if (route === 'thought/create') return await api.handleThoughtCreate(payload as Parameters<typeof api.handleThoughtCreate>[0]);
  if (route === 'record/list') return await api.handleRecordList(payload as Parameters<typeof api.handleRecordList>[0]);
  if (route === 'record/create') return await api.handleRecordCreate(payload as Parameters<typeof api.handleRecordCreate>[0]);

  // MyAgents Cloud Space — Registered Agent CLI bridge.
  if (route === 'space/list') return await api.handleSpaceList();
  if (route === 'space/whoami') return await api.handleSpaceWhoami(payload as Parameters<typeof api.handleSpaceWhoami>[0]);
  if (route === 'space/assignee-list') return await api.handleSpaceAssigneeList(payload as Parameters<typeof api.handleSpaceAssigneeList>[0]);
  if (route === 'space/goal-list') return await api.handleSpaceGoalList(payload as Parameters<typeof api.handleSpaceGoalList>[0]);
  if (route === 'space/issue-create') return await api.handleSpaceIssueCreate(payload as Parameters<typeof api.handleSpaceIssueCreate>[0]);
  if (route === 'space/issue-update') return await api.handleSpaceIssueUpdate(payload as Parameters<typeof api.handleSpaceIssueUpdate>[0]);
  if (route === 'space/issue-list') return await api.handleSpaceIssueList(payload as Parameters<typeof api.handleSpaceIssueList>[0]);
  if (route === 'space/issue-get') return await api.handleSpaceIssueGet(payload as Parameters<typeof api.handleSpaceIssueGet>[0]);
  if (route === 'space/issue-comment') return await api.handleSpaceIssueComment(payload as Parameters<typeof api.handleSpaceIssueComment>[0]);
  if (route === 'space/issue-comments') return await api.handleSpaceIssueComments(payload as Parameters<typeof api.handleSpaceIssueComments>[0]);
  if (route === 'space/issue-comment-get') return await api.handleSpaceIssueCommentGet(payload as Parameters<typeof api.handleSpaceIssueCommentGet>[0]);
  if (route === 'space/issue-status') return await api.handleSpaceIssueStatus(payload as Parameters<typeof api.handleSpaceIssueStatus>[0]);
  if (route === 'space/issue-claim') return await api.handleSpaceIssueClaim(payload as Parameters<typeof api.handleSpaceIssueClaim>[0]);
  if (route === 'space/issue-close') return await api.handleSpaceIssueClose(payload as Parameters<typeof api.handleSpaceIssueClose>[0]);
  if (route === 'space/issue-complete') return await api.handleSpaceIssueComplete(payload as Parameters<typeof api.handleSpaceIssueComplete>[0]);
  if (route === 'space/issue-cancel-claim') return await api.handleSpaceIssueCancelClaim(payload as Parameters<typeof api.handleSpaceIssueCancelClaim>[0]);
  if (route === 'space/claim-local-task') return await api.handleSpaceClaimLocalTask(payload as Parameters<typeof api.handleSpaceClaimLocalTask>[0]);
  if (route === 'space/attachment-download') return await api.handleSpaceAttachmentDownload(payload as Parameters<typeof api.handleSpaceAttachmentDownload>[0]);
  if (route === 'space/attachment-add') return await api.handleSpaceAttachmentAdd(payload as Parameters<typeof api.handleSpaceAttachmentAdd>[0]);
  if (route === 'space/attachment-inspect') return await api.handleSpaceAttachmentInspect(payload as Parameters<typeof api.handleSpaceAttachmentInspect>[0]);

  // Session Inbox (PRD 0.2.18) — `myagents session send`
  if (route === 'session/list') {
    return await api.handleSessionList(payload as Parameters<typeof api.handleSessionList>[0]);
  }
  if (route === 'session/start') {
    const { handleAdminSessionStart } = await import('./inbox/start-admin-handler');
    const result = await handleAdminSessionStart(getRuntimeSessionIdForRequest(), payload);
    return result.status >= 200 && result.status < 300
      ? { success: true, ...(result.response as Record<string, unknown>) }
      : {
          ...(result.response as Record<string, unknown>),
          success: false,
          error: result.response.error?.message ?? 'fresh Session admission failed',
          code: result.response.error?.code,
        };
  }
  if (route === 'session/send') {
    const { handleAdminInbox } = await import('./inbox/admin-handler');
    const sessionRequest = {
      toSessionId: typeof payload.toSessionId === 'string' ? payload.toSessionId : '',
      prompt: typeof payload.prompt === 'string' ? payload.prompt : '',
      replyBack: payload.replyBack !== false,
    };
    const result = await handleAdminInbox(getRuntimeSessionIdForRequest(), sessionRequest);
    // PRD 0.2.18 cross-review CC HIGH #4 — the previous shape spread
    // `result.response` AFTER `error: string`, so the nested `error: { code,
    // message }` object overwrote the string. CLI printResult then rendered
    // `Error: [object Object]`. Put the spread first and let explicit fields
    // win; also surface `code` at top level so the granular exit-code branch
    // in cli/myagents.ts:1627-1633 can read it without destructuring the
    // nested error object.
    return result.status >= 200 && result.status < 300
      ? { success: true, ...(result.response as unknown as Record<string, unknown>) }
      : {
          ...(result.response as unknown as Record<string, unknown>),
          success: false,
          error: result.response.error?.message ?? 'delivery failed',
          code: result.response.error?.code,
        };
  }
  if (route === 'session/watch') {
    const { handleAdminSessionWatch } = await import('./inbox/watch-handler');
    const result = await handleAdminSessionWatch(getRuntimeSessionIdForRequest(), {
      targetSessionId: typeof payload.targetSessionId === 'string' ? payload.targetSessionId : '',
    });
    return result.status >= 200 && result.status < 300
      ? { success: true, ...(result.response as unknown as Record<string, unknown>) }
      : {
          ...(result.response as unknown as Record<string, unknown>),
          success: false,
          error: result.response.error?.message ?? 'watch failed',
          code: result.response.error?.code,
        };
  }

  // System commands
  if (route === 'status') return api.handleStatus();
  if (route === 'reload') return api.handleReload(payload.workspacePath as string | undefined);
  if (route === 'version') return api.handleVersion();
  if (route === 'help') return api.handleHelp(payload as Parameters<typeof api.handleHelp>[0]);

  return { success: false, error: `Unknown admin route: ${pathname}` };
}

/**
 * Strip YAML frontmatter from file content.
 * Frontmatter is delimited by --- at the start and a second --- line.
 */
function stripYamlFrontmatter(content: string): string {
  const trimmed = content.trim();
  if (!trimmed.startsWith('---')) return trimmed;
  const endIndex = trimmed.indexOf('---', 3);
  if (endIndex === -1) return trimmed;
  return trimmed.slice(endIndex + 3).trim();
}

/**
 * Recursively copy a directory using fs/promises.
 * Every filesystem call yields to the event loop — important for HTTP handlers
 * that bulk-copy multiple folders. A sync implementation would block Bun's
 * event loop long enough for the Rust health monitor (/health with 2 s timeout,
 * 15 s interval) to declare the sidecar unresponsive and respawn it on a fresh
 * port mid-copy — which was the root cause of the "sync-from-claude crashes
 * the sidecar" report in issue #96.
 *
 * Security: Skips symbolic links to prevent following links to sensitive locations.
 */
async function copyDirRecursive(src: string, dest: string, logPrefix = '[copyDir]'): Promise<void> {
  await ensureDir(dest);
  const entries = await readdirAsync(src, { withFileTypes: true });
  for (const entry of entries) {
    const srcPath = join(src, entry.name);
    const destPath = join(dest, entry.name);

    if (entry.isSymbolicLink()) {
      console.warn(`${logPrefix} Skipping symlink: ${srcPath}`);
      continue;
    }

    if (entry.isDirectory()) {
      await copyDirRecursive(srcPath, destPath, logPrefix);
    } else {
      await copyFileAsync(srcPath, destPath);
    }
  }
}

/**
 * Validate folder name for security (no path traversal)
 */
function isValidFolderName(name: string): boolean {
  return !name.includes('..') && !name.includes('/') && !name.includes('\\') && name.length > 0;
}

async function serveStatic(pathname: string): Promise<Response | null> {
  const distRoot = resolve(process.cwd(), 'dist');
  const resolvedPath = pathname === '/' ? 'index.html' : pathname.slice(1);
  const filePath = resolve(distRoot, resolvedPath);
  // Prevent path traversal: resolved path must stay within distRoot
  if (!filePath.startsWith(distRoot + sep)) {
    return null;
  }
  const fileResp = await fileResponse(filePath, { contentType: sniffMime(filePath) });
  if (fileResp) return fileResp;

  const indexPath = join(distRoot, 'index.html');
  const indexResp = await fileResponse(indexPath, { contentType: sniffMime(indexPath) });
  if (indexResp) return indexResp;

  return null;
}

interface SwitchPayload {
  agentDir: string;
  initialPrompt?: string;
}

// System event queue for heartbeat relay (cron completion, etc.)
// Capped to prevent unbounded memory growth if heartbeat consumer is absent
const SYSTEM_EVENT_QUEUE_MAX = 500;
const systemEventQueue: Array<{ event: string; content: string; timestamp: number; taskId?: string }> = [];

/** Push a system event, evicting oldest if at capacity */
function pushSystemEvent(event: { event: string; content: string; timestamp: number; taskId?: string }) {
  if (systemEventQueue.length >= SYSTEM_EVENT_QUEUE_MAX) {
    systemEventQueue.splice(0, systemEventQueue.length - SYSTEM_EVENT_QUEUE_MAX + 1);
  }
  systemEventQueue.push(event);
}

/** Drain all pending system events (used by heartbeat endpoint) */
export function drainSystemEvents(): Array<{ event: string; content: string; timestamp: number; taskId?: string }> {
  return systemEventQueue.splice(0);
}

/**
 * Write a startup beacon directly to unified log file (bypasses initLogger).
 * This is critical for diagnosing Windows startup hangs where initLogger
 * may not be reached yet and zero NODE logs appear.
 */
function startupBeacon(step: string): void {
  // Write to stderr — captured by Rust drain thread → unified log
  try { process.stderr.write(`[startup] ${step}\n`); } catch { /* ignore */ }
  // Also write directly to unified log file.
  // NOTE: 内联时间戳格式而非 import localTimestamp()，因为此函数在 initLogger() 之前运行，
  // 需保持零依赖以诊断 Windows 上 initLogger 未到达的 hang 问题。
  try {
    const now = new Date();
    const y = now.getFullYear();
    const m = String(now.getMonth() + 1).padStart(2, '0');
    const d = String(now.getDate()).padStart(2, '0');
    const logsDir = join(homedir(), '.myagents', 'logs');
    ensureDirSync(logsDir);
    const filePath = join(logsDir, `unified-${y}-${m}-${d}.log`);
    const h = String(now.getHours()).padStart(2, '0');
    const mi = String(now.getMinutes()).padStart(2, '0');
    const s = String(now.getSeconds()).padStart(2, '0');
    const ms = String(now.getMilliseconds()).padStart(3, '0');
    const ts = `${y}-${m}-${d} ${h}:${mi}:${s}.${ms}`;
    appendFileSync(filePath, `${ts} [NODE ] [INFO ] [startup] ${step}\n`);
  } catch { /* ignore */ }
}

async function main() {
  startupBeacon(`main() entered, pid=${process.pid}, platform=${process.platform}, argv=${process.argv.length} args`);

  const {
    agentDir,
    initialPrompt,
    port,
    sessionId: initialSessionId,
    noPreWarm,
    sidecarComposition,
  } = parseArgs(process.argv);
  const sidecarRole = sidecarComposition.role;
  const sidecarRoleLabel = sidecarComposition.mode === 'development-union'
    ? 'development-union'
    : sidecarRole;
  process.env.MYAGENTS_SIDECAR_ROLE = sidecarRoleLabel;
  const dirDisplay = agentDir.length > 50 ? agentDir.slice(0, 3) + '...' + agentDir.slice(-44) : agentDir;
  startupBeacon(`args parsed, port=${port}, role=${sidecarRoleLabel}, agentDir=${dirDisplay}`);

  let currentAgentDir = await ensureAgentDir(agentDir);
  startupBeacon('ensureAgentDir done');

  // Initialize unified logging system (intercepts console.log and sends to SSE)
  // PRD #132 — wire the stdio-broken probe + marker so the logger wrapper
  // stops calling originalConsole.* once a stdio EPIPE has marked the sink
  // dead, and so a sync write-throw can flip the bit immediately.
  setStdioBrokenProbe(isStdioBroken, markStdioBroken);
  initLogger(getClients);
  startupBeacon('initLogger done — switching to console.log');

  // Store sidecar port BEFORE initializeAgent() so that:
  //   1. pre-warm's buildClaudeSessionEnv() reads the correct sidecarPort
  //      (OpenAI bridge loopback URL + MYAGENTS_PORT injection both need it).
  //   2. setSidecarPort's process.env.MYAGENTS_PORT side effect is in place
  //      before any external runtime subprocess (or `myagents` CLI invocation
  //      from pre-warm bash tools) can spawn. This eliminates a subtle timing
  //      coincidence where the old ordering depended on pre-warm's 500ms
  //      debounce outlasting the few µs between these two calls.
  setSidecarPort(port);

  // ── Deferred init state ─────────────────────────────────────────────────
  // Everything heavy (skill seed, socks bridge, initializeAgent, external
  // runtime restore) moves to AFTER
  // honoServe() binds, so Rust's TCP health check unblocks in < 100ms
  // instead of waiting ~2s for this work to complete. Routes consult the
  // readiness state machine before entering handlers that need agent state.
  //
  // /health is exempt so the sidecar becomes "healthy" from Rust's
  // perspective the moment the HTTP server accepts TCP connections —
  // letting the frontend render the Tab UI while deferred init still runs.
  /**
   * Extract the bridge token from a `/bridge/<token>/v1/messages` URL.
   * Returns the token string or `null` for any URL that doesn't match
   * the expected shape. PRD #124.
   */
  function extractBridgeTokenFromUrl(rawUrl: string): string | null {
    try {
      const u = new URL(rawUrl);
      const m = u.pathname.match(/^\/bridge\/([^/]+)\/v1\/messages(?:\/count_tokens)?$/);
      return m ? m[1] : null;
    } catch {
      return null;
    }
  }

  // ── OpenAI bridge: lazy + per-token (PRD #124) ─────────────────────────
  // Only users on OpenAI-protocol providers hit `/bridge/<token>/v1/messages`.
  // Importing `./openai-bridge` (~2600 lines, includes translate/utils/types
  // subtrees) at startup costs ~120ms for zero benefit on Anthropic-native
  // setups, so the factory stays lazy.
  //
  // The handler is stateless across tokens: every request carries its
  // bridge token in the URL path; getUpstreamConfig parses the token and
  // looks it up in `bridge-registry`. Each SDK subprocess (active session,
  // verify, title-gen, sub-agent) registers under its own token, so they
  // route to their own upstream without cross-pollination. See
  // `bridge-registry.ts` for the lifecycle contract.
  let bridgeHandlerPromise: Promise<BridgeHandler> | null = null;
  const ensureBridgeHandler = (): Promise<BridgeHandler> => {
    if (bridgeHandlerPromise) return bridgeHandlerPromise;
    bridgeHandlerPromise = (async () => {
      const [{ createBridgeHandler }, {
        lookupBridge,
        arePromptCacheBreakpointsDisabled,
        disablePromptCacheBreakpoints,
        disablePromptCacheKey,
        isPromptCacheKeyDisabled,
      }] = await Promise.all([
        import('./openai-bridge'),
        import('./openai-bridge/bridge-registry'),
      ]);
      const handler = createBridgeHandler({
          workspacePath: agentDir || undefined,
          getUpstreamConfig: async (request) => {
            const token = extractBridgeTokenFromUrl(request.url);
            if (!token) {
              throw new Error('Bridge request missing token in URL path');
            }
            const cfg = await lookupBridge(token, request);
            if (!cfg) {
              throw new Error(`Unknown bridge token: ${token}`);
            }
            // Per-request modelMapping bound to THIS token's aliases —
            // ensures concurrent bridges with different sub-agent rules
            // don't cross-pollinate (the original #124 bug class).
            const aliases = cfg.modelAliases;
            const modelMapping = aliases
              ? (requestModel: string): string | undefined => {
                  if (requestModel.startsWith('claude') && requestModel.includes('sonnet') && aliases.sonnet) return aliases.sonnet;
                  if (requestModel.startsWith('claude') && requestModel.includes('opus') && aliases.opus) return aliases.opus;
                  if (requestModel.startsWith('claude') && requestModel.includes('haiku') && aliases.haiku) return aliases.haiku;
                  // Last-resort: claude-* with no specific alias → use the
                  // bridge's own active model (per-token, no global leakage).
                  if (requestModel.startsWith('claude-')) return cfg.model || undefined;
                  return undefined;
                }
              : undefined;
            return {
              providerId: cfg.providerId,
              baseUrl: cfg.baseUrl,
              apiKey: cfg.apiKey,
              credentialVersion: cfg.credentialVersion,
              recoverAuth: cfg.recoverAuth,
              rejectCredential: cfg.rejectCredential,
              reportOutcome: cfg.reportOutcome,
              model: cfg.model,
              maxOutputTokens: cfg.maxOutputTokens,
              maxOutputTokensParamName: cfg.maxOutputTokensParamName,
              upstreamFormat: cfg.upstreamFormat,
              modelMapping,
              // #324 — per-token live value (session bridges resolve it from
              // currentReasoningEffort on every request).
              reasoningEffort: cfg.reasoningEffort,
              cacheAffinity: cfg.cacheAffinity
                ? {
                    ...cfg.cacheAffinity,
                    promptCacheKeyDisabled: isPromptCacheKeyDisabled(token),
                    disablePromptCacheKey: () => disablePromptCacheKey(token),
                    promptCacheBreakpointsDisabled: arePromptCacheBreakpointsDisabled(token),
                    disablePromptCacheBreakpoints: () => disablePromptCacheBreakpoints(token),
                  }
                : undefined,
            };
          },
          logger: (msg) => console.log(msg),
        });
      // Register seed callback now that the handler exists. bridge-cache
      // flushes any entries buffered during pre-registration.
      registerBridgeSeedFn((entries) => handler.seedThoughtSignatures(entries));
      return handler;
    })();
    return bridgeHandlerPromise;
  };

  console.log(`[startup] HTTP server binding to 127.0.0.1:${port}...`);

  const dispatchRequest = composeSidecarRequestHandler(sidecarComposition, handleRequest);
  let browserHostPromise: Promise<import('./browser-host').PlaywrightBrowserHost> | null = null;
  const ensureBrowserHost = async (): Promise<import('./browser-host').PlaywrightBrowserHost> => {
    if (!browserHostPromise) {
      browserHostPromise = import('./browser-host').then(({ PlaywrightBrowserHost }) => (
        new PlaywrightBrowserHost(port)
      ));
    }
    return browserHostPromise;
  };
  gracefulShutdownHook = async () => {
    if (!browserHostPromise) return;
    const browserHost = await browserHostPromise;
    await browserHost.shutdown();
  };

  honoServe({
    // Explicit 127.0.0.1 for Rust proxy compatibility (IPv4).
    port,
    hostname: '127.0.0.1',
    fetch: async (request) => {
      // Pattern 6 (HTTP request boundary): each request runs inside an ALS
      // frame so any nested console.* call automatically gets correlation
      // fields injected. Renderer-side code (`tauriClient.ts`) attaches
      // X-MyAgents-Session-Id / X-MyAgents-Tab-Id; the server generates a
      // fresh requestId (or honours an inbound `X-MyAgents-Request-Id` from
      // the Rust proxy if it pre-populated one).
      const incomingRequestId = request.headers.get('x-myagents-request-id') ?? undefined;
      const requestId = incomingRequestId ?? randomUUIDv4Short();
      const sessionId = request.headers.get('x-myagents-session-id') ?? undefined;
      const tabId = request.headers.get('x-myagents-tab-id') ?? undefined;
      return withLogContext({ requestId, sessionId, tabId }, () => dispatchRequest(request));
    },
  } as Parameters<typeof honoServe>[0]);

  /**
   * Pattern 6 helper: short stable id for HTTP request correlation.
   * crypto.randomUUID is ~36 chars; we collapse to 8 hex for grep-ability.
   */
  function randomUUIDv4Short(): string {
    // randomUUID is imported above; we re-derive from the same 16-byte source.
    return randomUUID().replace(/-/g, '').slice(0, 8);
  }

  /**
   * `/chat/stream` SSE disconnect is intentionally NOT a turn-cancellation
   * authority. When the last SSE client closes, we do NOT interrupt the
   * in-flight SDK turn. This is load-bearing — do not "optimize" it back.
   *
   * WHY (architecture: "后端优先，前端辅助" — ARCHITECTURE.md): a turn's lifecycle
   * belongs to the Rust sidecar Owner model (Tab / Task / Goal /
   * BackgroundCompletion / Agent), not to whether a frontend tab is currently
   * watching. The product
   * contract is explicit: closing / navigating away from a tab while the AI is
   * running starts BackgroundCompletion and lets the turn FINISH ("AI 继续在后台
   * 完成任务"); abandoning a turn is done via the Stop button (→ 'user' interrupt),
   * not by closing the tab. So "no SSE consumer" must never mean "cancel".
   *
   * HISTORY: PRD 0.2.0 (structural refactors) specced an *owner-aware* check
   * here ("interrupt only if the owner set no longer has a Tab/Frontend owner,
   * but IM/Task/Goal/BackgroundCompletion may still keep it alive"). The shipped impl
   * (390d38ee) instead used a raw `getClients().length === 0` grace and assumed
   * "headless turns never have an SSE client" — false the moment a user opens a
   * tab to observe a task / session-send turn then closes it mid-turn. That
   * regressed BackgroundCompletion and delivered spurious `[ERROR turn_failed]
   * [ede_diagnostic]` back to Feishu/IM. Removing the interrupt restores the
   * owner-model boundary.
   *
   * What still governs turn lifecycle WITHOUT this interrupt:
   *   - Stop button → interruptCurrentResponse('user').
   *   - All owners released → Rust stops the sidecar → process exit ends the turn.
   *   - Hung / silent turn → the 10-min inactivity watchdog (agent-session.ts),
   *     which is SSE-independent.
   *   - Zero SSE clients is a normal, handled state: broadcast() to an empty
   *     client set is a no-op (cron/IM turns run headless this way constantly),
   *     so there is no "chunks nobody reads" leak.
   *
   * The one residual gap — a leaked `Tab` owner after an abnormal renderer/SSE
   * death keeping an event-emitting turn alive (watchdog won't fire) — is a
   * stale-owner / renderer-health problem to solve with owner leases or tab
   * cleanup, NOT by making SSE disconnect a cancellation signal.
   */

  /**
   * Original Hono fetch body, unchanged except for being moved into a named
   * function so the outer wrapper can run inside `withLogContext`.
   */
  async function handleRequest(request: Request): Promise<Response> {
    {
      const url = new URL(request.url);
      const pathname = url.pathname;

      // Polling/config reads only surface state changes or failures at their
      // semantic owner; a successful request line has no diagnostic value.
      if (shouldLogHttpRequest(request.method, pathname)) {
        console.debug(`[http] ${request.method} ${pathname}`);
      }

      // Handle CORS preflight requests (for browser dev mode via Vite proxy)
      if (request.method === 'OPTIONS') {
        return new Response(null, {
          status: 204,
          headers: {
            'Access-Control-Allow-Origin': '*',
            'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
            'Access-Control-Allow-Headers': 'Content-Type, Authorization',
          }
        });
      }

      // 🩺 Health check endpoints - used by Rust sidecar manager and renderer.
      //
      // Pattern 4 splits the historical "/health = healthy" signal into three:
      //   - /health         → liveness (TCP bind succeeded; legacy alias kept
      //                       so existing Rust watchdogs keep working)
      //   - /health/live    → same as /health, explicit name
      //   - /health/ready   → deferred init complete; structured 503 + phase
      //                       while pending or failed
      //   - /health/functional → core feature can serve (sidecar mirrors live;
      //                       Plugin Bridge implements the real check)
      //
      // All four bypass the deferred-init gate below — they MUST respond
      // immediately, otherwise probes can't distinguish "still warming up"
      // from "wedged".
      if ((pathname === '/health' || pathname === '/health/live') && request.method === 'GET') {
        return jsonResponse({ status: 'ok', timestamp: Date.now() });
      }
      if (pathname === '/health/ready' && request.method === 'GET') {
        const { status, body } = buildReadyResponseBody();
        return jsonResponse(body, status);
      }
      if (pathname === '/health/functional' && request.method === 'GET') {
        // Sidecar's "functional" mirrors readiness for now — once ready, the
        // Hono handler is serving requests. Plugin Bridge has a more
        // meaningful gateway-forwarding check.
        const { status, body } = buildReadyResponseBody();
        return jsonResponse(body, status);
      }
      // Rust owns process-tree retirement. This bounded handshake lets the
      // Global Sidecar checkpoint Browser identity before Windows closes its
      // Job Object; the generation header prevents a stale retirement from
      // shutting down a replacement process that reused the same port.
      if (pathname === '/api/process/graceful-shutdown' && request.method === 'POST') {
        const expectedGeneration = process.env.MYAGENTS_SIDECAR_GENERATION?.trim();
        const requestedGeneration = request.headers.get('x-myagents-sidecar-generation')?.trim();
        if (!expectedGeneration || requestedGeneration !== expectedGeneration) {
          return jsonResponse({ success: false, error: 'stale sidecar generation' }, 409);
        }
        try {
          await shutdownOwnedResources();
          return jsonResponse({ success: true });
        } catch (error) {
          return jsonResponse({
            success: false,
            error: error instanceof Error ? error.message : String(error),
          }, 500);
        }
      }
      if (pathname === '/api/browser/session/retire' && request.method === 'POST') {
        const expectedGeneration = process.env.MYAGENTS_SIDECAR_GENERATION?.trim();
        const requestedGeneration = request.headers.get('x-myagents-sidecar-generation')?.trim();
        if (!expectedGeneration || requestedGeneration !== expectedGeneration) {
          return jsonResponse({ success: false, error: 'stale sidecar generation' }, 409);
        }
        const body = await request.json().catch(() => null) as { productSessionId?: unknown } | null;
        if (typeof body?.productSessionId !== 'string' || !body.productSessionId.trim()) {
          return jsonResponse({ success: false, error: 'productSessionId is required' }, 400);
        }
        try {
          const browserHost = await ensureBrowserHost();
          await browserHost.retireProductSession(body.productSessionId.trim());
          return jsonResponse({ success: true });
        } catch (error) {
          return jsonResponse({
            success: false,
            error: error instanceof Error ? error.message : String(error),
          }, 500);
        }
      }
      // (removed) `POST /health/ready/retry` — pre-0.2.0 endpoint that reset
      // DeferredInitState to `pending` and returned 202 promising a re-run,
      // but no in-process re-runner exists (the deferred init block is a
      // single IIFE). The renderer never observed progress and was misled.
      // Retry today is a process restart; if/when an extracted re-callable
      // init lands we can reintroduce a real retry endpoint.

      // 📦 Pattern 2 §2.3.1 — Large-value ref retrieval. SSE / IPC payloads
      // over the spill threshold leave a `{kind:'ref', id, ...}` placeholder
      // here; consumers fetch the full body via this endpoint. Streamed via
      // createReadStream so multi-MB bodies don't get loaded into memory.
      // Bypasses the deferred-init gate — refs are independent of agent
      // state, and the /chat/* SSE consumer may be mid-replay during init.
      if (pathname.startsWith('/refs/') && request.method === 'GET') {
        const id = decodeURIComponent(pathname.slice('/refs/'.length));
        // Mirror the strict regex inside large-value-store.getRefStreamPath:
        // 8–32 lowercase hex (uuid-prefix shape). The route check used to be
        // looser (`/^[a-f0-9]+$/i`, no length cap, case-insensitive), which
        // meant attacker-style upper-case probes returned 404 from the inner
        // store after also satisfying the route — defense-in-depth without
        // observable behavior change for legitimate refs.
        if (!id || !/^[a-f0-9]{8,32}$/.test(id)) {
          return jsonResponse({ error: 'invalid ref id' }, 400);
        }
        const { getRefStreamPath } = await import('./utils/large-value-store');
        const refInfo = await getRefStreamPath(id);
        if (!refInfo) {
          return jsonResponse({ error: 'ref not found or expired' }, 404);
        }
        // Stream from disk so multi-MB bodies don't buffer into memory.
        //
        // `Access-Control-Allow-Origin: *` is the load-bearing header here
        // (issue #109 root cause). The renderer's proxyFetch pulls this URL
        // via WebKit's native `fetch()` (the spill path bypasses Tauri IPC
        // because the body is too large to ship through the invoke channel).
        // Without an explicit ACAO header, WebKit/WKWebView silently rejects
        // the response as opaque cross-origin and surfaces it to JS as the
        // notoriously diagnostic-free `TypeError: Load failed`. Other
        // sidecar paths skip CORS because they go through Tauri IPC, which
        // bypasses the browser's same-origin machinery entirely; this one
        // doesn't, so it must opt in. Use `*` (not the renderer's origin)
        // because the sidecar is bound to 127.0.0.1 and trusts everything
        // on loopback already.
        const fr = await fileResponse(refInfo.path, {
          contentType: refInfo.mimetype,
          headers: {
            'Access-Control-Allow-Origin': '*',
          },
        });
        if (!fr) {
          return jsonResponse({ error: 'ref body missing' }, 404);
        }
        return fr;
      }

      // Runtime-only Streamable HTTP MCP data plane. The role gate admits
      // this endpoint only on the Global Sidecar, and the Host validates a
      // Rust-issued Session capability before creating any MCP connection or
      // BrowserContext. It must be usable while Session runtimes are warming,
      // so it intentionally precedes the deferred agent-state gate.
      if (pathname === '/mcp/playwright') {
        const browserHost = await ensureBrowserHost();
        return browserHost.handleRequest(request);
      }
      // ── Deferred init gate ────────────────────────────────────────────────
      // All other routes depend on agent state (currentAgentDir, MCP servers,
      // session metadata, bridge handler). Pattern 4: instead of awaiting
      // the bare promise (which either blocks indefinitely or rethrows as a
      // 500 on failure), consult the state machine and return a structured
      // 503 if init is pending/phase/failed. Once `kind === 'ready'`, the
      // gate is a no-op (sub-µs) for steady-state requests.
      const gate = buildGateResponseBody();
      if (gate) {
        const headers: Record<string, string> = { 'Content-Type': 'application/json' };
        if (gate.body.state === 'pending' || gate.body.state === 'phase') {
          headers['Retry-After'] = '1';
        }
        return new Response(JSON.stringify(gate.body), { status: gate.status, headers });
      }

      // Tool attachment endpoint (PRD 0.2.15) — rich-media tool outputs (image/audio/pdf/file).
      // URL shape: GET /api/attachment/tool/<sessionId>/<turnId>/<filename>
      //
      // Resolution:
      //   1. Look up the external-path registry (Codex savedPath, dynamic URLs after fetch).
      //      Hit → serve that real path.
      //   2. Miss → fall back to the trusted attachment root <home>/.myagents/generated/
      //      tool-attachments/<s>/<t>/<f> (where base64 / URL downloads land).
      //
      // Security: the registry only holds paths registered by saveToolAttachment, which
      // pre-validated them via validateExternalReadPathNode (system/credential blacklist).
      // The trusted-root fallback is by construction inside the MyAgents-owned tree.
      if (pathname.startsWith('/api/attachment/tool/') && request.method === 'GET') {
        // Codex review EP1: decodeURIComponent throws URIError on malformed
        // %xx escapes — wrap explicitly so we return 400 (with CORS) instead
        // of crashing the request and leaving the renderer with an opaque error.
        let rest: string;
        try {
          rest = decodeURIComponent(pathname.slice('/api/attachment/tool/'.length));
        } catch {
          return new Response('Bad Request', {
            status: 400,
            headers: { 'Access-Control-Allow-Origin': '*' },
          });
        }
        const segs = rest.split('/').filter(Boolean);
        if (segs.length !== 3) {
          return new Response('Bad Request', {
            status: 400,
            headers: { 'Access-Control-Allow-Origin': '*' },
          });
        }
        const [sid, tid, fname] = segs;
        // Guard against `..` / `/` / `\` / control chars in any segment.
        const hasUnsafeChar = (s: string): boolean => {
          if (s.includes('..')) return true;
          for (let i = 0; i < s.length; i++) {
            const code = s.charCodeAt(i);
            if (code < 0x20) return true;
            if (s[i] === '/' || s[i] === '\\') return true;
          }
          return false;
        };
        if (segs.some(hasUnsafeChar)) {
          return new Response('Forbidden', {
            status: 403,
            headers: { 'Access-Control-Allow-Origin': '*' },
          });
        }
        let realPath = lookupExternalAttachment(sid, tid, fname);
        if (!realPath) {
          // Fall back to the trusted root for base64/URL-downloaded attachments.
          realPath = join(getToolAttachmentRoot(), sid, tid, fname);
        }
        // Defense-in-depth: blacklist check (paths in registry have already passed,
        // but if a session-resume rebuild ever fed in a bad path we'd refuse here).
        const check = validateExternalReadPathNode(realPath);
        if (!check.ok) {
          return new Response('Forbidden', {
            status: 403,
            headers: { 'Access-Control-Allow-Origin': '*' },
          });
        }
        const fileResp = await fileResponse(check.canonical, {
          contentType: sniffMime(check.canonical),
          headers: {
            'Cache-Control': 'public, max-age=31536000, immutable',
            'Access-Control-Allow-Origin': '*',
          },
        });
        return fileResp ?? new Response('Not Found', {
          status: 404,
          headers: { 'Access-Control-Allow-Origin': '*' },
        });
      }

      // Browser dev-mode fallback for attachment files.
      // Production uses the Tauri `myagents-resource://attachment/<path>` custom protocol
      // (`src-tauri/src/attachment_protocol.rs`) which serves bytes directly
      // through WebKit without round-tripping JSON. In dev (vite + browser) the
      // custom scheme isn't registered, so this route serves the same bytes
      // via a plain HTTP GET. fileResponse() streams via createReadStream to
      // avoid buffering large attachments.
      if (pathname.startsWith('/api/attachment/') && request.method === 'GET') {
        const rel = decodeURIComponent(pathname.replace('/api/attachment/', ''));
        // Reject path traversal: no `..` segments and no absolute paths.
        if (rel.includes('..') || rel.startsWith('/')) {
          return new Response('Forbidden', { status: 403 });
        }
        const absolute = getAttachmentPath(rel);
        const fileResp = await fileResponse(absolute, {
          contentType: sniffMime(absolute),
          headers: {
            'Cache-Control': 'public, max-age=31536000, immutable',
            'Access-Control-Allow-Origin': '*',
          },
        });
        return fileResp ?? new Response('Not Found', { status: 404 });
      }

      const sessionReadRouteResponse = await handleSessionReadRoute(pathname, request, url);
      if (sessionReadRouteResponse) {
        return sessionReadRouteResponse;
      }

      // Read historical session messages from SDK's persisted session files (v0.2.59+)
      // Works without an active Sidecar — reads directly from .claude/ session data
      if (pathname === '/api/session/messages' && request.method === 'GET') {
        const sdkSessionId = url.searchParams.get('sdkSessionId');
        if (!sdkSessionId) {
          return jsonResponse({ success: false, error: 'sdkSessionId is required' }, 400);
        }
        const dir = url.searchParams.get('dir') || undefined;
        const rawLimit = url.searchParams.get('limit');
        const rawOffset = url.searchParams.get('offset');
        const limit = rawLimit ? (Number.isFinite(+rawLimit) && +rawLimit >= 0 ? Math.floor(+rawLimit) : undefined) : undefined;
        const offset = rawOffset ? (Number.isFinite(+rawOffset) && +rawOffset >= 0 ? Math.floor(+rawOffset) : undefined) : undefined;
        try {
          const messages = await getHistoricalSessionMessages(sdkSessionId, dir, limit, offset);
          return jsonResponse({ success: true, messages });
        } catch (error) {
          return jsonResponse(
            { success: false, error: error instanceof Error ? error.message : 'Failed to read session messages' },
            500
          );
        }
      }

      // 🔍 Debug endpoint: Expose logger diagnostics via HTTP
      if (pathname === '/debug/logger' && request.method === 'GET') {
        const diagnostics = getLoggerDiagnostics();
        const clientsCount = getClients().length;
        return jsonResponse({
          ...diagnostics,
          currentClientsCount: clientsCount,
          timestamp: new Date().toISOString(),
        }, 200);
      }

      const chatStreamRouteResponse = await handleChatStreamRoute(pathname, request, {
        createSseClient,
        getLogLines,
      });
      if (chatStreamRouteResponse) {
        return chatStreamRouteResponse;
      }

      if (pathname === '/chat/send' && request.method === 'POST') {
        let payload: SendMessagePayload;
        try {
          payload = (await request.json()) as SendMessagePayload;
        } catch {
          return jsonResponse({ success: false, error: 'Invalid JSON payload.' }, 400);
        }
        const text = payload?.text?.trim() ?? '';
        let images = payload?.images ?? [];
        const clientSessionId = typeof payload?.sessionId === 'string' ? payload.sessionId : undefined;
        const runtimeSessionId = getRuntimeSessionIdForRequest();
        if (payload.permissionMode !== undefined && typeof payload.permissionMode !== 'string') {
          return jsonResponse({ success: false, error: 'permissionMode must be a string.' }, 400);
        }
        const requestedPermissionMode = payload.permissionMode?.trim();
        const permissionMeta = getSessionMetadata(runtimeSessionId);
        const engine = getSessionEngine();
        const resolvedPermissionMode = resolveWorkspaceConfig(
          agentDir,
          permissionMeta,
          { includeMcp: false },
        ).permissionMode;
        let permissionMode = resolvedPermissionMode;
        if (!permissionMeta && payload.permissionMode !== undefined) {
          const birthPermissionMode = payload.permissionMode.trim();
          const runtimeIdentity = engine.getRuntimeIdentity();
          if (!isPermissionModeForRuntimeIdentity(
            birthPermissionMode,
            runtimeIdentity.runtime,
            runtimeIdentity.runtimeSource,
          )) {
            return jsonResponse({
              success: false,
              error: `Invalid permissionMode '${payload.permissionMode}' for ${runtimeIdentity.runtimeSource ?? runtimeIdentity.runtime}.`,
            }, 400);
          }
          permissionMode = birthPermissionMode;
        }
        const model = payload?.model;
        const providerRoute = payload?.providerRoute;
        const providerEnv = payload?.providerEnv;
        const reasoningEffort = typeof payload?.reasoningEffort === 'string' ? payload.reasoningEffort : undefined;
        const analyticsSource: TurnAnalyticsSource | undefined =
          payload?.analyticsSource === 'floating_ball' ? 'floating_ball' : undefined;
        const interactionScenario = desktopScenarioForAnalyticsSource(analyticsSource);
        const birthOrigin = payload.birthOrigin === undefined
          ? undefined
          : normalizeSessionOrigin(payload.birthOrigin);
        if (payload.birthOrigin !== undefined && !birthOrigin) {
          return jsonResponse({ success: false, error: 'Invalid session birth origin.' }, 400);
        }
        const analyticsOrigin = birthOrigin ?? originFromTurnAttribution({
          source: analyticsSource ?? 'desktop',
          scenarioType: interactionScenario.type,
          desktopSurface: interactionScenario.surface,
        });
        let requiredSystemSkill: ProductSystemSkillRequirement | undefined;
        if (payload.requiredSystemSkill !== undefined) {
          try {
            requiredSystemSkill = assertKnownProductSystemSkillRequirement(
              payload.requiredSystemSkill,
            );
          } catch (error) {
            return jsonResponse({
              success: false,
              error: error instanceof Error ? error.message : String(error),
            }, 400);
          }
        }

        // Allow sending with just images or just text
        if (!text && images.length === 0) {
          return jsonResponse({ success: false, error: 'Message must have text or images.' }, 400);
        }
        try {
          images = rehomeImagePayloadsForSession(clientSessionId, runtimeSessionId, images) ?? images;
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          return jsonResponse({ success: false, error: message }, 400);
        }

        try {
          const providerLabel = typeof providerEnv === 'object' ? providerEnv?.baseUrl ?? 'anthropic' : (providerEnv ?? 'anthropic');
          const runtimeLabel = engine.kind === 'external' ? getActiveRuntimeType() : 'builtin';
          console.log(`[chat] send via ${runtimeLabel}: text="${text.slice(0, 200)}" images=${images.length} mode=${permissionMode}${permissionMode !== requestedPermissionMode ? ` (session authority; caller=${requestedPermissionMode})` : ''} model=${model ?? 'default'} baseUrl=${providerLabel}`);
          const result = await goalOrchestrator.sendDesktopMessage(engine, {
            text,
            images,
            permissionMode,
            backgroundAgentPermissionMode: payload?.backgroundAgentPermissionMode,
            model: model ?? undefined,
            providerRoute,
            providerEnv,
            reasoningEffort,
            sessionId: runtimeSessionId,
            workspacePath: agentDir,
            scenario: interactionScenario,
            analyticsSource,
            analyticsOrigin,
            birthOrigin,
            requiredSystemSkill,
          });
          if (result.error) {
            return jsonResponse({ success: false, error: result.error }, result.status ?? 500);
          }
          return jsonResponse({
            success: true,
            queued: result.queued,
            ...(result.queueId ? { queueId: result.queueId } : {}),
            ...(result.isInFlight !== undefined ? { isInFlight: result.isInFlight } : {}),
            ...(result.deliveryMode ? { deliveryMode: result.deliveryMode } : {}),
            ...(result.canCancel !== undefined ? { canCancel: result.canCancel } : {}),
            ...(result.canForceExecute !== undefined ? { canForceExecute: result.canForceExecute } : {}),
          });
        } catch (error) {
          return jsonResponse(
            { success: false, error: error instanceof Error ? error.message : 'Unknown error' },
            500
          );
        }
      }

      if (pathname === '/chat/stop' && request.method === 'POST') {
        try {
          console.log('[chat] stop');
          return jsonResponse(await stopActiveTurn());
        } catch (error) {
          return jsonResponse(
            { success: false, error: error instanceof Error ? error.message : 'Unknown error' },
            500
          );
        }
      }

      if (pathname === '/goal/stop' && request.method === 'POST') {
        try {
          const payload = (await request.json()) as { goalId?: string; queueId?: string };
          const goalId = payload.goalId?.trim() ?? '';
          const queueId = payload.queueId?.trim() ?? '';
          if (!goalId) {
            return jsonResponse({ success: false, error: 'goalId is required' }, 400);
          }
          const owner = { kind: 'goal' as const, id: goalId };
          // A claimed turn always carries queueId and must stop exactly.
          // Missing queueId is reserved for durable pre-claim cancellation:
          // cancel owner-scoped queue/promotion work without touching an
          // unrelated active turn in the shared Session.
          const result = queueId
            ? await stopOwnedTurnByQueueId(owner, queueId)
            : await stopOwnedTurn(owner);
          return jsonResponse(result, result.success ? 200 : 500);
        } catch (error) {
          return jsonResponse({
            success: false,
            error: error instanceof Error ? error.message : 'Failed to stop Goal turn',
          }, 500);
        }
      }

      if (pathname === '/task/stop' && request.method === 'POST') {
        try {
          const payload = (await request.json()) as { taskId?: string; queueId?: string };
          const taskId = payload.taskId?.trim() ?? '';
          const queueId = payload.queueId?.trim() ?? '';
          if (!taskId || !queueId) {
            return jsonResponse({ success: false, error: 'taskId and queueId are required' }, 400);
          }
          const result = await stopOwnedTurnByQueueId({ kind: 'task', id: taskId }, queueId);
          return jsonResponse(result, result.success ? 200 : 500);
        } catch (error) {
          return jsonResponse({
            success: false,
            error: error instanceof Error ? error.message : 'Failed to stop Task turn',
          }, 500);
        }
      }

      if (pathname === '/api/goal/objective' && request.method === 'POST') {
        try {
          const payload = (await request.json()) as { objective?: string; sessionId?: string };
          const objective = payload.objective?.trim() ?? '';
          if (!objective) {
            return jsonResponse({ success: false, error: 'Goal objective is required.' }, 400);
          }
          const runtimeSessionId = getRuntimeSessionIdForRequest();
          if (payload.sessionId && payload.sessionId !== runtimeSessionId) {
            return jsonResponse({ success: false, error: 'Goal session does not match the active Sidecar session.' }, 409);
          }
          const result = await goalOrchestrator.updateObjective(getSessionEngine(), {
            sessionId: runtimeSessionId,
            workspacePath: agentDir,
            objective,
          });
          return jsonResponse(result, result.success ? 200 : (result.status ?? 500));
        } catch (error) {
          return jsonResponse({
            success: false,
            error: error instanceof Error ? error.message : 'Failed to update Goal objective',
          }, 500);
        }
      }

      // ─── Runtime API endpoints (v0.1.59) ───

      if (pathname === '/api/runtime/type' && request.method === 'GET') {
        return jsonResponse({ runtime: getActiveRuntimeType() });
      }

      if (pathname === '/api/runtime/models' && request.method === 'GET') {
        const type = url.searchParams.get('type');
        if (!type) return jsonResponse({ error: 'Missing type parameter' }, 400);
        const sourceParam = url.searchParams.get('source');
        const runtimeSource: RuntimeSource | undefined =
          sourceParam === 'managed-provider' || sourceParam === 'system-cli'
            ? sourceParam
            : undefined;
        try {
          const models = await queryRuntimeModels(type as import('../shared/types/runtime').RuntimeType, {
            runtimeSource,
            signal: request.signal,
          });
          return jsonResponse({ models });
        } catch (error) {
          return jsonResponse({ error: error instanceof Error ? error.message : 'Unknown error' }, 500);
        }
      }

      if (pathname === '/api/runtime/permission-modes' && request.method === 'GET') {
        const type = url.searchParams.get('type');
        if (!type) return jsonResponse({ error: 'Missing type parameter' }, 400);
        const modes = getRuntimePermissionModes(type as import('../shared/types/runtime').RuntimeType);
        return jsonResponse({ modes });
      }

      const runtimeRouteResponse = await handleSessionEngineRuntimeRoute(pathname, request, {
        workspacePath: currentAgentDir,
        resolvePrewarmSessionId: resolveExternalPrewarmSessionId,
      });
      if (runtimeRouteResponse) {
        return runtimeRouteResponse;
      }

      const sessionOperationRouteResponse = await handleSessionOperationRoute(pathname, request, {
        workspacePath: currentAgentDir,
      });
      if (sessionOperationRouteResponse) {
        return sessionOperationRouteResponse;
      }

      // CC SessionStart hook receiver (v0.1.59)
      // CC fires this hook when a session starts/resumes/compacts.
      // The forwarder script (cc-session-hook-forwarder.cjs) POSTs the hook input here.
      if (pathname === '/hook/session-start' && request.method === 'POST') {
        try {
          const hookData = (await request.json()) as Record<string, unknown>;
          const ccSessionId = (hookData.session_id as string) || (hookData.sessionId as string) || '';
          if (ccSessionId) {
            console.log(`[hook] CC SessionStart: session_id=${ccSessionId}, source=${hookData.source}`);
            // Import and update the external session's CC session ID
            const { setRuntimeSessionId } = await import('./runtimes/external-session');
            setRuntimeSessionId(ccSessionId);
          }
          return jsonResponse({ ok: true });
        } catch {
          return jsonResponse({ ok: false }, 500);
        }
      }

      const sessionEngineQueueRoute = await handleSessionEngineQueueRoute(pathname, request);
      if (sessionEngineQueueRoute) {
        return sessionEngineQueueRoute;
      }

      // Poll background task output file for live stats
      if (pathname === '/api/task/poll-background' && request.method === 'POST') {
        try {
          const body = await request.json() as { outputFile?: string; offset?: number };
          const { outputFile, offset = 0 } = body;

          // Validate outputFile path: resolve to canonical path then verify it falls
          // under the user's home directory and matches expected suffix.
          // This prevents path traversal attacks (e.g., "/../../../etc/passwd.output").
          if (!outputFile || typeof outputFile !== 'string') {
            return jsonResponse({ success: false, error: 'Invalid outputFile path' }, 400);
          }
          const resolvedOutputFile = resolve(outputFile);
          const homeDir = getHomeDirOrNull() || '';
          const isUnderHome = homeDir && resolvedOutputFile.startsWith(homeDir + sep);
          if (!isUnderHome || !resolvedOutputFile.endsWith('.output')) {
            return jsonResponse({ success: false, error: 'Invalid outputFile path' }, 400);
          }

          // Check file existence
          if (!existsSync(resolvedOutputFile)) {
            return jsonResponse({ success: true, stats: null, newOffset: 0, isComplete: false });
          }

          const fileStat = statSync(resolvedOutputFile);
          const fileSize = fileStat.size;

          // No new data
          if (offset >= fileSize) {
            return jsonResponse({ success: true, stats: null, newOffset: offset, isComplete: false });
          }

          // Read incremental data (cap at 1MB)
          const MAX_READ = 1024 * 1024;
          const readEnd = Math.min(offset + MAX_READ, fileSize);
          const { open } = await import('node:fs/promises');
          const fh = await open(resolvedOutputFile, 'r');
          let text: string;
          try {
            const length = readEnd - offset;
            const buf = Buffer.alloc(length);
            await fh.read(buf, 0, length, offset);
            text = buf.toString('utf8');
          } finally {
            await fh.close();
          }

          // Parse JSONL lines
          let toolCount = 0;
          let assistantCount = 0;
          let userCount = 0;
          let progressCount = 0;
          let firstTimestamp = 0;
          let lastTimestamp = 0;
          let lastLineType = '';
          let lastLineHasToolUse = false;

          const lines = text.split('\n');
          for (const line of lines) {
            const trimmed = line.trim();
            if (!trimmed) continue;
            try {
              const parsed = JSON.parse(trimmed);
              const ts = parsed.timestamp ? new Date(parsed.timestamp).getTime() : 0;
              if (ts && !firstTimestamp) firstTimestamp = ts;
              if (ts) lastTimestamp = ts;

              if (parsed.type === 'assistant') {
                assistantCount++;
                lastLineType = 'assistant';
                lastLineHasToolUse = false;
                // Count tool_use blocks in content
                if (Array.isArray(parsed.message?.content)) {
                  for (const block of parsed.message.content) {
                    if (block.type === 'tool_use') {
                      toolCount++;
                      lastLineHasToolUse = true;
                    }
                  }
                }
              } else if (parsed.type === 'user') {
                userCount++;
                lastLineType = 'user';
                lastLineHasToolUse = false;
              } else if (parsed.type === 'progress') {
                progressCount++;
              }
            } catch {
              // Skip truncated/invalid lines
            }
          }

          const elapsed = firstTimestamp && lastTimestamp ? lastTimestamp - firstTimestamp : 0;

          // Detect completion: last line is assistant with only text (no tool_use)
          const isComplete = lastLineType === 'assistant' && !lastLineHasToolUse;

          return jsonResponse({
            success: true,
            stats: { toolCount, assistantCount, userCount, progressCount, elapsed },
            newOffset: readEnd,
            isComplete
          });
        } catch (error) {
          return jsonResponse(
            { success: false, error: error instanceof Error ? error.message : 'Unknown error' },
            500
          );
        }
      }

      // ============= CRON TASK API =============

      if (pathname === '/goal/execute-sync' && request.method === 'POST') {
        return handleGoalExecuteSync(request);
      }

      // POST /cron/execute-sync - Execute a scheduled task synchronously.
      if (pathname === '/cron/execute-sync' && request.method === 'POST') {
        return handleTaskExecuteSyncRoute(request, {
          getEngine: getSessionEngine,
          getWorkspacePath: () => getAgentState().agentDir,
        });
      }

      // ============= GLOBAL STATS API =============

      // GET /api/global-stats?range=7d|30d|60d - Aggregated token usage across all sessions
      if (pathname === '/api/global-stats' && request.method === 'GET') {
        try {
          const range = url.searchParams.get('range') || '30d';
          if (!['7d', '30d', '60d'].includes(range)) {
            return jsonResponse({ success: false, error: 'Invalid range. Use 7d, 30d, or 60d.' }, 400);
          }

          const allSessions = getAllSessionMetadata();

          const now = Date.now();
          const rangeDays = range === '7d' ? 7 : range === '30d' ? 30 : 60;
          const cutoff = now - rangeDays * 86400_000;
          const sessions = allSessions.flatMap((session) => {
            if (!isHistoryVisibleSession(session)) return [];
            return [getSessionDataFromMetadata(session)];
          });
          const stats = aggregateGlobalUsageStats(sessions, cutoff);

          return jsonResponse({
            success: true,
            stats,
          });
        } catch (error) {
          console.error('[global-stats] Error:', error);
          return jsonResponse({
            success: false,
            error: error instanceof Error ? error.message : 'Unknown error',
          }, 500);
        }
      }

      // ============= SESSION API =============

      // Global Session user Tag projection + intent mutations.
      if (pathname === '/api/session-tags' && request.method === 'GET') {
        return jsonResponse({ success: true, tags: listSessionUserTags() });
      }

      if (pathname === '/api/session-tags/assign' && request.method === 'POST') {
        let payload: { sessionId?: unknown; operation?: unknown; name?: unknown };
        try {
          payload = await request.json() as typeof payload;
        } catch {
          return jsonResponse({ success: false, reason: 'invalid-name', error: 'Invalid JSON payload.' }, 400);
        }
        if (typeof payload.sessionId !== 'string' || !/^[A-Za-z0-9-]{1,99}$/.test(payload.sessionId)) {
          return jsonResponse({ success: false, reason: 'session-not-found', error: 'Invalid Session ID.' }, 400);
        }
        if ((payload.operation !== 'add' && payload.operation !== 'remove') || typeof payload.name !== 'string') {
          return jsonResponse({ success: false, reason: 'invalid-name', error: 'Invalid Tag assignment operation.' }, 400);
        }
        const result = await mutateSessionUserTag(payload.sessionId, {
          kind: payload.operation,
          name: payload.name,
        });
        if (!result.ok) {
          const status = sessionUserTagFailureStatus(result.reason);
          return jsonResponse({ success: false, ...result }, status);
        }
        if (!result.session) {
          return jsonResponse({ success: false, reason: 'io-error', error: 'Tag mutation returned no Session.' }, 500);
        }
        return jsonResponse({
          success: true,
          ...result,
          session: toClientSessionMetadata(result.session),
        });
      }

      if (pathname === '/api/session-tags/manage' && request.method === 'POST') {
        let payload: {
          operation?: unknown;
          name?: unknown;
          newName?: unknown;
          merge?: unknown;
          focusSessionId?: unknown;
        };
        try {
          payload = await request.json() as typeof payload;
        } catch {
          return jsonResponse({ success: false, reason: 'invalid-name', error: 'Invalid JSON payload.' }, 400);
        }
        if ((payload.operation !== 'rename' && payload.operation !== 'delete') || typeof payload.name !== 'string') {
          return jsonResponse({ success: false, reason: 'invalid-name', error: 'Invalid global Tag operation.' }, 400);
        }
        if (payload.operation === 'rename' && typeof payload.newName !== 'string') {
          return jsonResponse({ success: false, reason: 'invalid-name', error: 'A new Tag name is required.' }, 400);
        }
        if (payload.focusSessionId !== undefined
          && (typeof payload.focusSessionId !== 'string' || !/^[A-Za-z0-9-]{1,99}$/.test(payload.focusSessionId))) {
          return jsonResponse({ success: false, reason: 'session-not-found', error: 'Invalid focus Session ID.' }, 400);
        }
        const result = await mutateGlobalSessionUserTag(
          payload.operation === 'rename'
            ? { kind: 'rename', name: payload.name, newName: payload.newName as string, merge: payload.merge === true }
            : { kind: 'delete', name: payload.name },
          payload.focusSessionId as string | undefined,
        );
        if (!result.ok) {
          const status = sessionUserTagFailureStatus(result.reason);
          return jsonResponse({ success: false, ...result }, status);
        }
        return jsonResponse({
          success: true,
          ...result,
          ...(result.session ? { session: toClientSessionMetadata(result.session) } : {}),
        });
      }

      // GET /sessions - List all sessions or filter by agentDir
      if (pathname === '/sessions' && request.method === 'GET') {
        try {
          const agentDirParam = url.searchParams.get('agentDir');
          const sessions = agentDirParam
            ? getSessionsByAgentDir(agentDirParam)
            : getAllSessionMetadata();
          // Apply the shared client projection (credential redaction + wire stats names).
          const safeSessions = sessions
            .filter(isHistoryVisibleSession)
            .map(normalizeSessionListPreview)
            .map(toClientSessionMetadata);
          return jsonResponse({ success: true, sessions: safeSessions });
        } catch (error) {
          console.error('[sessions] Error in GET /sessions:', error);
          return jsonResponse({
            success: false,
            error: error instanceof Error ? error.message : 'Unknown error in SessionStore'
          }, 500);
        }
      }

      // POST /sessions - Create a new session
      if (pathname === '/sessions' && request.method === 'POST') {
        type CreateSessionPayload = {
          agentDir: string;
          runtime?: string;
          runtimeSource?: RuntimeSource;
          seedMaxPermission?: boolean;
          providerExecutionIdentity?: RuntimeBackedProviderIdentity;
          providerId?: string;
          model?: string;
          permissionMode?: string;
          reasoningEffort?: string;
          mcpEnabledServers?: string[];
          enabledPluginIds?: string[];
          enabledOfficialToolIds?: import('../shared/official-tools').OfficialToolId[];
          origin?: unknown;
          prepareForFirstUserMessage?: boolean;
          materializationSourceSessionId?: string;
        };
        let payload: CreateSessionPayload;
        try {
          payload = (await request.json()) as CreateSessionPayload;
        } catch {
          return jsonResponse({ success: false, error: 'Invalid JSON payload.' }, 400);
        }

        const agentDirValue = payload?.agentDir?.trim();
        if (!agentDirValue) {
          return jsonResponse({ success: false, error: 'agentDir is required.' }, 400);
        }

        // Use the shared VALID_RUNTIMES constant — same list that drives
        // admin-api validation and HELP_TEXTS. A local literal here used to
        // silently drift when new runtimes landed.
        const runtimeValue = (VALID_RUNTIMES as readonly string[]).includes(payload?.runtime as string)
          ? (payload.runtime as import('../shared/types/runtime').RuntimeType)
          : undefined;
        const runtimeSourceValue: RuntimeSource | undefined =
          payload.runtimeSource === 'managed-provider' || payload.runtimeSource === 'system-cli'
            ? payload.runtimeSource
            : undefined;
        const payloadOrigin = payload.origin === undefined
          ? undefined
          : normalizeSessionOrigin(payload.origin);
        if (payload.origin !== undefined && !payloadOrigin) {
          return jsonResponse({ success: false, error: 'Invalid session origin.' }, 400);
        }
        const payloadProviderExecutionIdentity = payload.providerExecutionIdentity === undefined
          ? undefined
          : runtimeBackedProviderIdentityFromSnapshot(payload.providerExecutionIdentity);
        if (payload.providerExecutionIdentity !== undefined && !payloadProviderExecutionIdentity) {
          return jsonResponse({ success: false, error: 'Invalid providerExecutionIdentity.' }, 400);
        }
        const managedCodexReady = isManagedCodexProviderReady(loadConfig());
        if (
          runtimeSourceValue === 'managed-provider'
          || payloadProviderExecutionIdentity?.runtimeSource === 'managed-provider'
          || payload.providerId === CODEX_SUBSCRIPTION_PROVIDER_ID
        ) {
          if (!managedCodexReady) {
            return jsonResponse({
              success: false,
              error: managedCodexNotReadyMessage('session creation'),
            }, 400);
          }
          if (runtimeSourceValue === 'managed-provider' && !payloadProviderExecutionIdentity) {
            return jsonResponse({
              success: false,
              error: 'Managed Codex session creation requires providerExecutionIdentity.',
            }, 400);
          }
        }
        // v0.1.69 Desktop session = owned snapshot. Capture model/permission/mcp/provider
        // from AgentConfig so the session is self-contained from creation onward.
        // The frontend's runtime override (payload.runtime) wins over agent.runtime — Tab UI
        // can pin a session to a specific runtime independent of the Agent's default.
        const agent = findProjectAgentByWorkspacePath(agentDirValue) as AgentConfig | undefined;
        const baseSnapshot: Partial<SessionMetadata> = agent
          ? snapshotForOwnedSession(agent, {
              runtimeOverride: runtimeValue,
              managedCodexProviderReady: managedCodexReady,
            })
          : (runtimeValue ? { runtime: runtimeValue } : {});
        baseSnapshot.origin = payloadOrigin ?? { kind: 'desktop', surface: 'unknown' };
        // PRD 0.2.34 §14 D14/D15 — 桌面渠道（悬浮球）创建 owned session 时把权限
        // 种成该 runtime 的「最宽松」档（发完就走渠道默认无脑执行）。原子地在快照
        // 构造期种入（复用既有 getMaxPermissionForRuntime），而非"创建后再 PATCH"
        // ——后者 PATCH 失败会被吞、UI 与磁盘快照不一致（cross-review）。opt-in：
        // 只有悬浮球传 seedMaxPermission，Tab/其它 createSession 行为不变。
        if (payload?.seedMaxPermission === true) {
          baseSnapshot.permissionMode = getMaxPermissionForRuntime(
            (baseSnapshot.runtime ?? 'builtin') as RuntimeType,
          );
        }
        if (runtimeSourceValue && (baseSnapshot.runtime ?? runtimeValue) !== 'builtin') {
          baseSnapshot.runtimeSource = runtimeSourceValue;
        }
        if (payloadProviderExecutionIdentity) {
          baseSnapshot.runtime = payloadProviderExecutionIdentity.runtime;
          baseSnapshot.runtimeSource = payloadProviderExecutionIdentity.runtimeSource;
          baseSnapshot.providerExecutionIdentity = payloadProviderExecutionIdentity;
          baseSnapshot.providerId = payloadProviderExecutionIdentity.providerId;
          baseSnapshot.model = payloadProviderExecutionIdentity.model;
          baseSnapshot.providerRoute = undefined;
          baseSnapshot.providerEnvJson = undefined;
        } else {
          if (payload.providerId !== undefined || payload.model !== undefined) {
            baseSnapshot.providerExecutionIdentity = undefined;
            baseSnapshot.providerEnvJson = undefined;
          }
          if (payload.providerId !== undefined) {
            baseSnapshot.providerId = payload.providerId;
            baseSnapshot.providerRoute = undefined;
          }
          if (payload.model !== undefined) {
            baseSnapshot.model = payload.model;
          }
          if (
            (baseSnapshot.runtime ?? runtimeValue ?? 'builtin') === 'builtin'
            && baseSnapshot.providerId
            && baseSnapshot.model
          ) {
            baseSnapshot.providerRoute = createConcreteProviderRoute(
              baseSnapshot.providerId,
              baseSnapshot.model,
            );
          }
        }
        const snapshotRuntime = (baseSnapshot.runtime ?? runtimeValue ?? 'builtin') as RuntimeType;
        if (payload.permissionMode !== undefined) {
          if (typeof payload.permissionMode !== 'string') {
            return jsonResponse({ success: false, error: 'permissionMode must be a string.' }, 400);
          }
          const payloadPermissionMode = payload.permissionMode.trim();
          const snapshotRuntimeSource = baseSnapshot.runtimeSource
            ?? payloadProviderExecutionIdentity?.runtimeSource
            ?? runtimeSourceValue;
          if (!isPermissionModeForRuntimeIdentity(
            payloadPermissionMode,
            snapshotRuntime,
            snapshotRuntimeSource,
          )) {
            return jsonResponse({
              success: false,
              error: `Invalid permissionMode '${payload.permissionMode}' for ${snapshotRuntimeSource ?? snapshotRuntime}.`,
            }, 400);
          }
          baseSnapshot.permissionMode = payloadPermissionMode;
        }
        const payloadReasoningEffort = coerceRuntimeBirthReasoningEffort(
          payload.reasoningEffort,
          snapshotRuntime,
        );
        if (payloadReasoningEffort !== undefined) baseSnapshot.reasoningEffort = payloadReasoningEffort;
        if (payload.mcpEnabledServers !== undefined) baseSnapshot.mcpEnabledServers = payload.mcpEnabledServers;
        if (payload.enabledPluginIds !== undefined) baseSnapshot.enabledPluginIds = payload.enabledPluginIds;
        if (payload.enabledOfficialToolIds !== undefined) baseSnapshot.enabledOfficialToolIds = payload.enabledOfficialToolIds;
        if (payload.prepareForFirstUserMessage === true) {
          if (baseSnapshot.origin?.kind !== 'desktop') {
            return jsonResponse({
              success: false,
              error: 'Prepared session birth is only supported for desktop sessions.',
            }, 400);
          }
          if (!baseSnapshot.providerExecutionIdentity) {
            return jsonResponse({
              success: false,
              error: 'Prepared session birth requires providerExecutionIdentity.',
            }, 400);
          }
          baseSnapshot.materializationState = 'prepared';
          baseSnapshot.materializationSourceSessionId = typeof payload.materializationSourceSessionId === 'string'
            && payload.materializationSourceSessionId.trim()
            ? payload.materializationSourceSessionId.trim()
            : undefined;
        }
        const session = await createSession(agentDirValue, baseSnapshot);
        return jsonResponse({ success: true, session: toClientSessionMetadata(session) });
      }

      // GET /sessions/:id/since/:lastMessageId - Incremental tail fetch
      // Called by the cron:execution-complete handler to pull only the messages
      // appended by a background task, instead of reloading the whole session.
      // This is what keeps a foreground tab responsive after a background cron
      // task completes: the old full-reload path bundled P0+P1 penalties
      // (base64 attachments + Virtuoso remount) into a single freeze spike.
      // Must be BEFORE the generic /sessions/:id route.
      if (pathname.match(/^\/sessions\/[^/]+\/since\/[^/]+$/) && request.method === 'GET') {
        const match = pathname.match(/^\/sessions\/([^/]+)\/since\/([^/]+)$/);
        if (!match) {
          return jsonResponse({ success: false, error: 'Invalid path.' }, 400);
        }
        const sessionId = decodeURIComponent(match[1]);
        const lastMessageId = decodeURIComponent(match[2]);

        const session = getSessionData(sessionId);
        if (!session) {
          return jsonResponse({ success: false, error: 'Session not found.' }, 404);
        }
        if (!isHistoryVisibleSession(session)) {
          return jsonResponse({ success: false, error: 'Session not found.' }, 404);
        }

        const idx = session.messages.findIndex(m => m.id === lastMessageId);
        // idx === -1 signals "caller's baseline is gone" (session was rewound,
        // compacted, or otherwise rewritten). Caller falls back to full reload.
        if (idx === -1) {
          return jsonResponse({ success: true, fromIndex: -1, messages: [] });
        }

        const tail = shrinkSessionMessagesForClient(session.messages.slice(idx + 1));
        // Same metadata-only shape as GET /sessions/:id (P0) — previews are
        // resolved via the myagents:// custom protocol on the client.
        return jsonResponse({ success: true, fromIndex: idx, messages: tail });
      }

      // GET /sessions/:id/stats - Get detailed session statistics
      // The generic GET /sessions/:id handler lives in routes/session-read.ts and
      // only matches one path segment, so stats/since subroutes remain owned here.
      if (pathname.match(/^\/sessions\/[^/]+\/stats$/) && request.method === 'GET') {
        const sessionId = pathname.replace('/sessions/', '').replace('/stats', '');
        if (!sessionId) {
          return jsonResponse({ success: false, error: 'Session ID required.' }, 400);
        }

        const session = getSessionData(sessionId);
        if (!session) {
          return jsonResponse({ success: false, error: 'Session not found.' }, 404);
        }
        if (!isHistoryVisibleSession(session)) {
          return jsonResponse({ success: false, error: 'Session not found.' }, 404);
        }

        return jsonResponse({
          success: true,
          stats: buildSessionDetailedUsageStats(session),
        });
      }

      // DELETE /sessions/:id - Delete a session
      if (pathname.startsWith('/sessions/') && request.method === 'DELETE') {
        const sessionId = pathname.replace('/sessions/', '');
        if (!/^[A-Za-z0-9-]{1,99}$/.test(sessionId)) {
          return jsonResponse({ success: false, reason: 'invalid-session-id', error: 'Invalid session ID.' }, 400);
        }
        const expectedAuthority = process.env.MYAGENTS_SESSION_DELETE_AUTHORITY;
        const providedAuthority = request.headers.get('X-MyAgents-Session-Delete-Authority');
        if (!expectedAuthority || providedAuthority !== expectedAuthority) {
          return jsonResponse({ success: false, reason: 'missing-authority', error: 'Session deletion requires the Rust lifecycle authority.' }, 403);
        }

        const deletion = await deleteSession(sessionId, { kind: 'user-delete' });
        if (!deletion.deleted) {
          if (deletion.reason === 'protected-session') {
            return jsonResponse({ success: false, reason: deletion.reason, error: 'System maintenance session is not user-editable.' }, 403);
          }
          if (deletion.reason === 'io-error') {
            return jsonResponse({ success: false, reason: deletion.reason, error: 'Failed to delete session.' }, 500);
          }
          return jsonResponse({ success: false, reason: deletion.reason, error: 'Session not found.' }, 404);
        }

        return jsonResponse({ success: true });
      }

      // PATCH /sessions/:id - Update session metadata (incl. v0.1.69 config snapshot)
      if (pathname.startsWith('/sessions/') && request.method === 'PATCH') {
        const sessionId = pathname.replace('/sessions/', '');
        if (!sessionId) {
          return jsonResponse({ success: false, error: 'Session ID required.' }, 400);
        }

        // Snapshot fields (v0.1.69): send `null` to clear (revert to agent fallback);
        // omit a field to leave it unchanged.
        interface PatchPayload {
          title?: string;
          titleSource?: 'default' | 'auto' | 'user';
          /** Pin/unpin to the 收藏 filter view. Storage convention: only
           *  `true` is persisted; `false` is stored as `undefined` so a
           *  freshly toggled-off session matches "never favorited" exactly
           *  on disk. */
          favorite?: boolean;
          /** Pin/unpin inside the owning workspace's sidebar Session list. */
          pinned?: boolean;
          model?: string | null;
          /** #324 — reasoning effort snapshot ('default' | level); null clears. */
          reasoningEffort?: string | null;
          permissionMode?: string | null;
          mcpEnabledServers?: string[] | null;
          enabledPluginIds?: string[] | null;
          enabledOfficialToolIds?: import('../shared/official-tools').OfficialToolId[] | null;
          providerId?: string | null;
          providerRoute?: ProviderRoute | null;
          providerExecutionIdentity?: RuntimeBackedProviderIdentity | null;
          providerEnvJson?: string | null;
          origin?: SessionOrigin | null;
        }

        let payload: PatchPayload;
        try {
          payload = (await request.json()) as PatchPayload;
        } catch {
          return jsonResponse({ success: false, error: 'Invalid JSON payload.' }, 400);
        }
        if (payload.permissionMode !== undefined && payload.permissionMode !== null
            && typeof payload.permissionMode !== 'string') {
          return jsonResponse({ success: false, error: 'permissionMode must be a string or null.' }, 400);
        }
        if (payload.title !== undefined) {
          if (typeof payload.title !== 'string') {
            return jsonResponse({ success: false, error: 'title must be a string.' }, 400);
          }
          payload.title = payload.title.trim();
          if (!payload.title) {
            return jsonResponse({ success: false, error: 'title must not be empty.' }, 400);
          }
        }
        if (payload.pinned !== undefined && typeof payload.pinned !== 'boolean') {
          return jsonResponse({ success: false, error: 'pinned must be a boolean.' }, 400);
        }

        // `lastActiveAt` is the recency signal that drives history sort
        // order. Bumping it on EVERY PATCH means a pure-UI flag change
        // (favorite toggle) makes an old session jump to the top of the
        // dropdown — confusing UX (Codex round-4 caught). Only the fields
        // that genuinely represent "session was used" should refresh it. Title
        // edits and pinning are organizational actions, so neither affects recency.
        const touchedRecencyField = shouldBumpSessionRecency(payload);

        let updated: SessionMetadata | null = null;
        let sawExistingSession = false;
        let sawSnapshotCasChange = false;

        for (let attempt = 0; attempt < 2; attempt += 1) {
          const existingMeta = getSessionMetadata(sessionId);
          if (!existingMeta) {
            if (!sawExistingSession) {
              return jsonResponse({ success: false, error: 'Session not found.' }, 404);
            }
            break;
          }
          if (isSystemMaintenanceSession(existingMeta)) {
            return jsonResponse({ success: false, error: 'System maintenance session is not user-editable.' }, 403);
          }
          sawExistingSession = true;
          const nowIso = new Date().toISOString();

          const updates: Record<string, unknown> = touchedRecencyField
            ? { lastActiveAt: nowIso }
            : {};
          if (payload.title !== undefined) updates.title = payload.title.slice(0, 100);
          if (payload.titleSource !== undefined) updates.titleSource = payload.titleSource;
          if (payload.favorite !== undefined) {
            // Convert false → undefined so the on-disk shape stays minimal
            // (the JSON serializer drops undefined keys).
            updates.favorite = payload.favorite === true ? true : undefined;
          }
          if (payload.pinned !== undefined) updates.pinned = payload.pinned;
          if (payload.origin !== undefined) {
            if (payload.origin === null) {
              updates.origin = undefined;
            } else {
              const nextOrigin = normalizeSessionOrigin(payload.origin);
              if (!nextOrigin) {
                return jsonResponse({ success: false, error: 'Invalid session origin.' }, 400);
              }
              updates.origin = nextOrigin;
            }
          }

          // Snapshot fields: null → clear (undefined in stored JSON); value → set.
          //
          // v0.2.40: the first desktop snapshot write promotes a legacy/no-snapshot
          // session into a self-owned session. Promotion must freeze a complete
          // baseline before applying the explicit patch; otherwise a model-only
          // patch creates `model + configSnapshotAt` and silently drops permission
          // / provider ownership.
          const baseSnapshot = existingMeta.configSnapshotAt
            ? undefined
            : (() => {
              const agent = findProjectAgentByWorkspacePath(existingMeta.agentDir) as AgentConfig | undefined;
              return agent
                ? snapshotForOwnedSession(agent, {
                    runtimeOverride: existingMeta.runtime as RuntimeType | undefined,
                    managedCodexProviderReady: isManagedCodexProviderReady(loadConfig()),
                  })
                : undefined;
            })();
          if (typeof payload.permissionMode === 'string') {
            const requestedPermissionMode = payload.permissionMode.trim();
            const permissionRuntime = (existingMeta.runtime ?? baseSnapshot?.runtime ?? 'builtin') as RuntimeType;
            const permissionRuntimeSource = existingMeta.runtimeSource
              ?? existingMeta.providerExecutionIdentity?.runtimeSource
              ?? baseSnapshot?.runtimeSource;
            if (!isPermissionModeForRuntimeIdentity(
              requestedPermissionMode,
              permissionRuntime,
              permissionRuntimeSource,
            )) {
              return jsonResponse({
                success: false,
                error: `Invalid permissionMode '${payload.permissionMode}' for ${permissionRuntimeSource ?? permissionRuntime}.`,
              }, 400);
            }
            payload.permissionMode = requestedPermissionMode;
          }
          Object.assign(updates, buildSessionSnapshotPatchUpdates({
            existing: existingMeta,
            payload,
            baseSnapshot,
            nowIso,
          }));

          const expectedConfigSnapshotAt = existingMeta.configSnapshotAt;
          updated = await updateSessionMetadata(
            sessionId,
            updates,
            (current) => current.configSnapshotAt === expectedConfigSnapshotAt,
          );
          if (updated) break;

          const latest = getSessionMetadata(sessionId);
          if (!latest) break;
          sawSnapshotCasChange = latest.configSnapshotAt !== expectedConfigSnapshotAt;
          if (!sawSnapshotCasChange) break;
        }

        if (!updated) {
          if (!getSessionMetadata(sessionId)) {
            return jsonResponse({ success: false, error: 'Session not found.' }, 404);
          }
          return jsonResponse({
            success: false,
            error: sawSnapshotCasChange
              ? 'Session config changed while applying metadata patch; please retry.'
              : 'Failed to update session metadata.',
          }, sawSnapshotCasChange ? 409 : 500);
        }

        // Zero-trust: redact credential-bearing fields from the echo payload.
        // The client already owns what it sent; no need to round-trip secrets.
        return jsonResponse({ success: true, session: toClientSessionMetadata(updated) });
      }

      // POST /api/generate-session-title - AI-generate a short session title
      // Accepts `rounds` array (3+ QA rounds) for rich context.
      // Also accepts legacy `userMessage`/`assistantReply` for backward compatibility.
      if (pathname === '/api/generate-session-title' && request.method === 'POST') {
        let payload: {
          sessionId: string;
          rounds?: Array<{ user: string; assistant: string }>;
          // Legacy fields (single-round fallback)
          userMessage?: string;
          assistantReply?: string;
          model: string;
          providerEnv?: ProviderEnv;
        };
        try {
          payload = (await request.json()) as typeof payload;
        } catch {
          return jsonResponse({ success: false, error: 'Invalid JSON payload.' }, 400);
        }

        if (!payload.sessionId) {
          return jsonResponse({ success: false, error: 'sessionId is required.' }, 400);
        }

        // Build rounds from payload — prefer `rounds` array, fall back to legacy fields
        let rounds: Array<{ user: string; assistant: string }>;
        if (payload.rounds && Array.isArray(payload.rounds) && payload.rounds.length > 0) {
          // Cap to 10 rounds max, validate shape, enforce length limits
          rounds = payload.rounds.slice(0, 10)
            .filter((r: unknown): r is Record<string, unknown> => r !== null && typeof r === 'object')
            .map(r => ({
              user: (typeof r.user === 'string' ? r.user : '').slice(0, 500),
              assistant: (typeof r.assistant === 'string' ? r.assistant : '').slice(0, 500),
            }));
          if (rounds.length === 0) {
            return jsonResponse({ success: false, error: 'rounds must contain valid entries.' }, 400);
          }
        } else if (payload.userMessage) {
          // Legacy single-round format
          rounds = [{
            user: payload.userMessage.slice(0, 1000),
            assistant: (payload.assistantReply || '').slice(0, 1000),
          }];
        } else {
          return jsonResponse({ success: false, error: 'rounds or userMessage is required.' }, 400);
        }

        payload.model = (payload.model || '').slice(0, 200);

        // Skip if session not found or user has manually renamed
        const meta = getSessionMetadata(payload.sessionId);
        if (!meta) {
          return jsonResponse({ success: false, error: 'Session not found.' }, 404);
        }
        if (meta.titleSource === 'user') {
          return jsonResponse({ success: false, skipped: true });
        }

        // Manual / external trigger. Delegates to the backend Title Service core
        // (runtime-aware dispatch + TOCTOU re-check + persist + broadcast), the
        // SAME path the post-turn auto trigger uses — see session-title-service.ts.
        // Runtime is derived from session state; model/providerEnv from the request.
        // External runtimes ignore providerEnv (CLI-owned auth) and take agentDir
        // as workspace so Gemini/Codex inherit project context.
        const activeRuntime = getActiveRuntimeType();
        const { generateAndApplyTitle } = await import('./session-title-service');
        const title = await generateAndApplyTitle(
          payload.sessionId,
          rounds,
          activeRuntime,
          payload.model || '',
          payload.providerEnv,
          meta.agentDir,
        );
        return title ? jsonResponse({ success: true, title }) : jsonResponse({ success: false });
      }

      // ============= END SESSION API =============

      // Switch agent directory at runtime (for browser development mode)
      if (pathname === '/agent/switch' && request.method === 'POST') {
        let payload: SwitchPayload;
        try {
          payload = (await request.json()) as SwitchPayload;
        } catch {
          return jsonResponse({ success: false, error: 'Invalid JSON payload.' }, 400);
        }

        const newDir = payload?.agentDir?.trim();
        if (!newDir) {
          return jsonResponse({ success: false, error: 'agentDir is required.' }, 400);
        }

        // Security: validate the path before allowing access
        const validation = isValidAgentDir(newDir);
        if (!validation.valid) {
          console.warn(`[agent] blocked switch to "${newDir}": ${validation.reason}`);
          return jsonResponse({
            success: false,
            error: validation.reason || 'Invalid directory path'
          }, 403);
        }

        try {
          console.log(`[agent] switch to dir="${newDir}"`);
          currentAgentDir = await ensureAgentDir(newDir);
          await initializeAgent(currentAgentDir, payload.initialPrompt);
          return jsonResponse({
            success: true,
            agentDir: currentAgentDir
          });
        } catch (error) {
          return jsonResponse(
            { success: false, error: error instanceof Error ? error.message : 'Unknown error' },
            500
          );
        }
      }








      if (pathname === '/agent/upload' && request.method === 'POST') {
        const targetParam = url.searchParams.get('path') ?? '';
        const resolvedTarget =
          targetParam ? resolveAgentPath(currentAgentDir, targetParam) : currentAgentDir;
        if (!resolvedTarget) {
          return jsonResponse({ error: 'Invalid path.' }, 400);
        }
        try {
          const oversized = rejectIfOversizedUpload(request);
          if (oversized) return oversized;
          const formData = await request.formData();
          const files = Array.from(formData.values()).filter(
            (value) => typeof value !== 'string'
          ) as File[];
          if (files.length === 0) {
            return jsonResponse({ error: 'No files provided.' }, 400);
          }
          await ensureDir(resolvedTarget);
          const saved: string[] = [];
          for (const file of files) {
            const safeName = file.name.replace(/[<>:"/\\|?*]/g, '_');
            const destination = join(resolvedTarget, safeName);
            await streamUploadToFile(file, destination);
            saved.push(relative(currentAgentDir, destination));
          }
          return jsonResponse({ success: true, files: saved });
        } catch (error) {
          return jsonResponse(
            { error: error instanceof Error ? error.message : 'Unknown error' },
            500
          );
        }
      }










      // ============= FILE MANAGEMENT API =============





      // GET /api/image?path=... - Serve generated images (for browser dev mode)
      if (pathname === '/api/image' && request.method === 'GET') {
        try {
          const imagePath = url.searchParams.get('path');
          if (!imagePath) {
            return jsonResponse({ success: false, error: 'Missing path parameter' }, 400);
          }

          // Security: allow reading from workspace/myagents_files/{generated_images,temp}/ or legacy paths
          const resolvedPath = resolve(imagePath);
          const legacyDir = join(homedir(), '.myagents', 'generated');
          const legacyDirSep = legacyDir.endsWith(sep) ? legacyDir : legacyDir + sep;
          // New unified paths + backward compat with myagents-generated/images/
          const allowedDirs = currentAgentDir ? [
            join(currentAgentDir, 'myagents_files', 'generated_images'),
            join(currentAgentDir, 'myagents_files', 'temp'),
            join(currentAgentDir, 'myagents-generated', 'images'), // backward compat
          ] : [];
          const allowed = resolvedPath.startsWith(legacyDirSep)
            || allowedDirs.some(d => resolvedPath.startsWith(d.endsWith(sep) ? d : d + sep));
          if (!allowed) {
            return jsonResponse({ success: false, error: 'Access denied: path must be within generated directory' }, 403);
          }

          if (!existsSync(resolvedPath)) {
            return jsonResponse({ success: false, error: 'Image not found' }, 404);
          }

          const ext = resolvedPath.split('.').pop()?.toLowerCase();
          const mimeType = ext === 'jpg' || ext === 'jpeg' ? 'image/jpeg' : 'image/png';

          const resp = await fileResponse(resolvedPath, {
            contentType: mimeType,
            headers: { 'Cache-Control': 'public, max-age=86400' },
          });
          return resp ?? jsonResponse({ success: false, error: 'Image not found' }, 404);
        } catch (error) {
          console.error('[api/image] Error:', error);
          return jsonResponse(
            { success: false, error: error instanceof Error ? error.message : 'Failed to serve image' },
            500
          );
        }
      }

      // GET /api/audio?path=... - Serve generated audio (for browser dev mode)
      if (pathname === '/api/audio' && request.method === 'GET') {
        try {
          const audioPath = url.searchParams.get('path');
          if (!audioPath) {
            return jsonResponse({ success: false, error: 'Missing path parameter' }, 400);
          }

          // Security: allow reading from workspace/myagents_files/generated_audio/ or legacy paths
          const resolvedPath = resolve(audioPath);
          const legacyAudioDir = join(homedir(), '.myagents', 'generated_audio');
          const legacyAudioDirSep = legacyAudioDir.endsWith(sep) ? legacyAudioDir : legacyAudioDir + sep;
          // New unified path + backward compat with myagents-generated/audio/
          const allowedAudioDirs = currentAgentDir ? [
            join(currentAgentDir, 'myagents_files', 'generated_audio'),
            join(currentAgentDir, 'myagents-generated', 'audio'), // backward compat
          ] : [];
          const audioAllowed = resolvedPath.startsWith(legacyAudioDirSep)
            || allowedAudioDirs.some(d => resolvedPath.startsWith(d.endsWith(sep) ? d : d + sep));
          if (!audioAllowed) {
            return jsonResponse({ success: false, error: 'Access denied: path must be within generated_audio directory' }, 403);
          }

          if (!existsSync(resolvedPath)) {
            return jsonResponse({ success: false, error: 'Audio not found' }, 404);
          }

          const ext = resolvedPath.split('.').pop()?.toLowerCase();
          const mimeTypes: Record<string, string> = {
            mp3: 'audio/mpeg',
            wav: 'audio/wav',
            ogg: 'audio/ogg',
            webm: 'audio/webm',
            opus: 'audio/opus',
            aac: 'audio/aac',
            m4a: 'audio/mp4',
          };
          const mimeType = mimeTypes[ext || ''] || 'audio/mpeg';

          const resp = await fileResponse(resolvedPath, {
            contentType: mimeType,
            headers: { 'Cache-Control': 'public, max-age=86400' },
          });
          return resp ?? jsonResponse({ success: false, error: 'Audio not found' }, 404);
        } catch (error) {
          console.error('[api/audio] Error:', error);
          return jsonResponse(
            { success: false, error: error instanceof Error ? error.message : 'Failed to serve audio' },
            500
          );
        }
      }

      // POST /api/edge-tts/preview - Preview TTS from Settings (independent of MCP server state)
      if (pathname === '/api/edge-tts/preview' && request.method === 'POST') {
        try {
          const body = await request.json() as {
            text?: string;
            voice?: string;
            rate?: string;
            volume?: string;
            pitch?: string;
            outputFormat?: string;
          };

          if (!body.text?.trim()) {
            return jsonResponse({ success: false, error: 'Missing text parameter' }, 400);
          }

          // Apply same text length limit as the MCP tool
          if (body.text.length > 10000) {
            return jsonResponse({ success: false, error: `Text too long (${body.text.length} chars). Maximum is 10000.` }, 400);
          }

          const { synthesizePreview } = await import('./tools/edge-tts-tool');
          const result = await synthesizePreview({
            text: body.text,
            voice: body.voice || 'zh-CN-XiaoxiaoNeural',
            rate: body.rate || '0%',
            volume: body.volume || '0%',
            pitch: body.pitch || '+0Hz',
            outputFormat: body.outputFormat || 'audio-24khz-48kbitrate-mono-mp3',
          });

          return jsonResponse(result);
        } catch (error) {
          console.error('[api/edge-tts/preview] Error:', error);
          return jsonResponse(
            { success: false, error: error instanceof Error ? error.message : 'Preview failed' },
            500
          );
        }
      }

      // ============= END FILE MANAGEMENT API =============

      // ============= UNIFIED LOGGING API =============

      // POST /api/unified-log - Receive frontend logs for persistence
      if (pathname === '/api/unified-log' && request.method === 'POST') {
        try {
          const payload = await request.json() as {
            entries?: Array<{
              source: 'react' | 'bun' | 'rust';
              level: 'info' | 'warn' | 'error' | 'debug';
              message: string;
              timestamp: string;
            }>;
          };

          if (payload.entries && Array.isArray(payload.entries)) {
            appendUnifiedLogBatch(payload.entries);
          }

          return jsonResponse({ success: true });
        } catch (error) {
          return jsonResponse({
            success: false,
            error: error instanceof Error ? error.message : 'Failed to log'
          }, 500);
        }
      }

      // GET /api/logs/export - Export recent unified logs as zip
      if (pathname === '/api/logs/export' && request.method === 'GET') {
        try {
          const { readdirSync, statSync } = await import('fs');
          const { join: joinPath } = await import('path');
          const { homedir } = await import('os');
          const logsDir = joinPath(homedir(), '.myagents', 'logs');

          // Collect last 3 days of unified-*.log files
          const now = Date.now();
          const threeDaysMs = 3 * 24 * 60 * 60 * 1000;
          const files = readdirSync(logsDir)
            .filter(f => f.startsWith('unified-') && f.endsWith('.log'))
            .filter(f => {
              try {
                return now - statSync(joinPath(logsDir, f)).mtimeMs < threeDaysMs;
              } catch { return false; }
            })
            .sort();

          if (files.length === 0) {
            return jsonResponse({ success: false, error: '没有找到近3天的运行日志' }, 404);
          }

          // Output to Desktop
          const desktopDir = joinPath(homedir(), 'Desktop');
          const timestamp = new Date().toISOString().slice(0, 10);
          const zipName = `MyAgents-logs-${timestamp}.zip`;
          const zipPath = joinPath(desktopDir, zipName);

          // Create zip using platform-appropriate command
          const isWin = process.platform === 'win32';
          const filePaths = files.map(f => joinPath(logsDir, f));

          // stdout/stderr must be ignored — zip/Compress-Archive emit per-file progress
          // that can exceed the 64KB pipe buffer on large log sets and deadlock the
          // child waiting for us to read.
          if (isWin) {
            const { default: AdmZip } = await import('adm-zip');
            const zip = new AdmZip();
            for (const filePath of filePaths) {
              zip.addLocalFile(filePath);
            }
            zip.writeZip(zipPath);
          } else {
            // macOS/Linux: zip command
            const proc = subprocessSpawn(['zip', '-j', zipPath, ...filePaths], {
              stdout: 'ignore',
              stderr: 'ignore',
            });
            await proc.exited;
          }

          return jsonResponse({ success: true, path: zipPath });
        } catch (error) {
          return jsonResponse({
            success: false,
            error: error instanceof Error ? error.message : 'Failed to export logs'
          }, 500);
        }
      }

      // ============= PROVIDER VERIFICATION API =============

      // POST /api/provider/verify - Verify API key via SDK (same path as normal chat)
      if (pathname === '/api/provider/verify' && request.method === 'POST') {
        try {
          const payload = await request.json() as {
            providerId?: string;
            baseUrl?: string;
            apiKey?: string;
            model?: string;
            authType?: string;
            apiProtocol?: string;
            maxOutputTokens?: number;
            maxOutputTokensParamName?: string;
            upstreamFormat?: string;
          };

          const { providerId, baseUrl, apiKey, model, authType, apiProtocol, maxOutputTokens, maxOutputTokensParamName, upstreamFormat } = payload;

          if (!providerId || !baseUrl || !apiKey) {
            return jsonResponse({ success: false, error: 'providerId, baseUrl and apiKey are required.' }, 400);
          }

          console.log(`[api/provider/verify] =========================`);
          console.log(`[api/provider/verify] providerId: ${providerId}`);
          console.log(`[api/provider/verify] baseUrl: ${baseUrl}`);
          console.log(`[api/provider/verify] model: ${model ?? 'default'}`);
          console.log(`[api/provider/verify] authType: ${authType ?? 'both'}`);
          console.log(`[api/provider/verify] apiProtocol: ${apiProtocol ?? 'anthropic'}`);
          console.log(`[api/provider/verify] maxOutputTokens: ${maxOutputTokens ?? 'none'}`);

          // Unified SDK verification for all protocols (Anthropic + OpenAI)
          // For OpenAI protocol: SDK → CLI → bridge loopback → upstream (end-to-end)
          // For Anthropic protocol: SDK → CLI → upstream (same as before)
          const result = await verifyProviderViaSdk(
            providerId,
            baseUrl, apiKey, authType ?? 'both', model || undefined,
            apiProtocol === 'openai' ? 'openai' : undefined,
            maxOutputTokens,
            maxOutputTokensParamName as 'max_tokens' | 'max_completion_tokens' | 'max_output_tokens' | undefined,
            upstreamFormat === 'responses' ? 'responses' : undefined,
          );

          console.log(`[api/provider/verify] result:`, JSON.stringify(result));
          console.log(`[api/provider/verify] =========================`);

          return jsonResponse(result);
        } catch (error) {
          console.error('[api/provider/verify] Error:', error);
          return jsonResponse(
            { success: false, error: error instanceof Error ? error.message : 'Verification failed' },
            500
          );
        }
      }

      // POST /api/grok/verify — same one-shot SDK + Responses Bridge path as
      // normal chat, with a non-secret managed OAuth ProviderEnv.
      if (pathname === '/api/grok/verify' && request.method === 'POST') {
        try {
          const payload = await request.json() as { model?: string; verificationLineage?: string };
          const providerEnv = resolveProviderEnv(XAI_SUBSCRIPTION_PROVIDER_ID) as ProviderEnv | undefined;
          if (!providerEnv?.credentialSource || !providerEnv.baseUrl) {
            return jsonResponse({ success: false, error: 'Grok subscription provider is unavailable.' }, 409);
          }
          const model = payload.model?.trim() || 'grok-4.5';
          const verificationLineage = payload.verificationLineage?.trim();
          if (!verificationLineage) {
            return jsonResponse({ success: false, error: 'Grok verification lineage is required.' }, 400);
          }
          const result = await verifyProviderViaSdk(
            XAI_SUBSCRIPTION_PROVIDER_ID,
            providerEnv.baseUrl,
            '',
            providerEnv.authType ?? 'both',
            model,
            'openai',
            providerEnv.maxOutputTokens,
            providerEnv.maxOutputTokensParamName,
            'responses',
            providerEnv.credentialSource,
            { expectedLineage: verificationLineage },
          );
          return jsonResponse(result);
        } catch (error) {
          return jsonResponse({
            success: false,
            error: error instanceof Error ? error.message : 'Grok verification failed',
          }, 500);
        }
      }

      // GET /api/subscription/status - Check Anthropic local subscription status
      if (pathname === '/api/subscription/status' && request.method === 'GET') {
        try {
          const status = checkAnthropicSubscription();
          return jsonResponse(status);
        } catch (error) {
          console.error('[api/subscription/status] Error:', error);
          return jsonResponse(
            { available: false, error: error instanceof Error ? error.message : 'Check failed' },
            500
          );
        }
      }

      // POST /api/subscription/verify - Verify Anthropic subscription by sending test request via SDK
      if (pathname === '/api/subscription/verify' && request.method === 'POST') {
        try {
          console.log('[api/subscription/verify] Starting verification...');
          const result = await verifySubscription();
          console.log('[api/subscription/verify] Result:', JSON.stringify(result));
          return jsonResponse(result);
        } catch (error) {
          console.error('[api/subscription/verify] Error:', error);
          return jsonResponse(
            { success: false, error: error instanceof Error ? error.message : 'Verification failed' },
            500
          );
        }
      }

      // POST /api/subscription/login/start - Start Anthropic Claude OAuth login via AgentSDK
      if (pathname === '/api/subscription/login/start' && request.method === 'POST') {
        try {
          console.log('[api/subscription/login/start] Starting Claude OAuth login...');
          const state = await startSubscriptionLogin();
          return jsonResponse(state);
        } catch (error) {
          console.error('[api/subscription/login/start] Error:', error);
          return jsonResponse(
            { status: 'error', error: error instanceof Error ? error.message : 'Login failed' },
            500
          );
        }
      }

      // GET /api/subscription/login/status - Poll Anthropic Claude OAuth login state
      if (pathname === '/api/subscription/login/status' && request.method === 'GET') {
        try {
          return jsonResponse(getSubscriptionLoginState());
        } catch (error) {
          console.error('[api/subscription/login/status] Error:', error);
          return jsonResponse(
            { status: 'error', error: error instanceof Error ? error.message : 'Status check failed' },
            500
          );
        }
      }

      // POST /api/subscription/login/submit - Complete Anthropic Claude OAuth login with a pasted code/callback URL
      if (pathname === '/api/subscription/login/submit' && request.method === 'POST') {
        try {
          const payload = await request.json().catch(() => ({})) as { code?: unknown; codeOrUrl?: unknown };
          const codeOrUrl = typeof payload.codeOrUrl === 'string'
            ? payload.codeOrUrl
            : typeof payload.code === 'string'
              ? payload.code
              : '';
          const state = await submitSubscriptionLoginCode(codeOrUrl);
          return jsonResponse(state);
        } catch (error) {
          console.error('[api/subscription/login/submit] Error:', error);
          return jsonResponse(
            { status: 'error', error: error instanceof Error ? error.message : 'Submit failed' },
            500
          );
        }
      }

      // POST /api/subscription/login/cancel - Stop an active Anthropic Claude OAuth login attempt
      if (pathname === '/api/subscription/login/cancel' && request.method === 'POST') {
        try {
          const payload = await request.json().catch(() => ({})) as { startedAt?: string | null };
          const state = cancelSubscriptionLogin(payload.startedAt);
          return jsonResponse(state);
        } catch (error) {
          console.error('[api/subscription/login/cancel] Error:', error);
          return jsonResponse(
            { status: 'error', error: error instanceof Error ? error.message : 'Cancel failed' },
            500
          );
        }
      }


      const qrCodeAssetResponse = await handleQrCodeAssetRoute(pathname, request);
      if (qrCodeAssetResponse) return qrCodeAssetResponse;

      // ============= END PROVIDER VERIFICATION API =============

      const sessionConfigRouteResponse = await handleSessionConfigRoute(pathname, request);
      if (sessionConfigRouteResponse) {
        return sessionConfigRouteResponse;
      }

      // ============= PROXY API =============

      // POST /api/proxy/set - Hot-reload proxy config into this Sidecar process
      if (pathname === '/api/proxy/set' && request.method === 'POST') {
        try {
          const payload = await request.json();
          const result = await getSessionEngine().updateProxyConfig(payload);
          return jsonResponse(result);
        } catch (error) {
          console.error('[api/proxy/set] Error:', error);
          return jsonResponse(
            { success: false, error: error instanceof Error ? error.message : 'Failed to set proxy config' },
            500
          );
        }
      }

      // ============= MCP API =============

      // GET /api/mcp - Get current MCP servers
      if (pathname === '/api/mcp' && request.method === 'GET') {
        try {
          const servers = getMcpServers();
          return jsonResponse({ success: true, servers });
        } catch (error) {
          console.error('[api/mcp] Error:', error);
          return jsonResponse(
            { success: false, error: error instanceof Error ? error.message : 'Failed to get MCP servers' },
            500
          );
        }
      }

      // POST /api/mcp/enable - Validate and enable MCP server
      // For preset MCP (npx): warmup npm/npx cache (system npx → bundled npx → bun x)
      // For custom MCP: check if command exists
      if (pathname === '/api/mcp/enable' && request.method === 'POST') {
        try {
          const payload = await request.json() as {
            server: McpServerDefinition;
          };

          const server = payload.server;
          if (!server) {
            return jsonResponse({ success: false, error: 'Missing server' }, 400);
          }

          // Resolve sentinel commands to display names for logs, so
          // internal command markers never leak into unified logs or
          // user-facing error surfaces.
          const displayCommand = server.command === '__builtin__'
            ? '(builtin)'
            : server.command === '__browser_host__' ? '(browser-host)' : server.command;
          console.log(`[api/mcp/enable] Enabling MCP: ${server.id}, type: ${server.type}, command: ${displayCommand}`);

          // Built-in MCP (in-process) — delegate validation to registry.
          // getBuiltinMcpInstance() force-loads the tool module (SDK+zod) on
          // first hit; subsequent enables for the same id hit the cached entry.
          if (server.command === '__builtin__') {
            const entryPromise = getBuiltinMcpInstance(server.id);
            if (entryPromise) {
              const entry = await entryPromise;
              if (entry.validate) {
                const error = await entry.validate(server.env || {});
                if (error) {
                  return jsonResponse({ success: false, error });
                }
              }
            }
            console.log(`[api/mcp/enable] Built-in MCP: ${server.id} — enabled`);
            return jsonResponse({ success: true });
          }

          if (server.id === MANAGED_BROWSER_MCP_ID && server.command === '__browser_host__') {
            console.log('[api/mcp/enable] Browser uses the application Browser Host');
            return jsonResponse({ success: true });
          }

          // SSE/HTTP types: validate remote URL is reachable and protocol matches
          if (server.type === 'sse' || server.type === 'http') {
            if (!server.url) {
              return jsonResponse({
                success: false,
                error: { type: 'connection_failed', message: '缺少服务器 URL' }
              });
            }

            try {
              const { resolveRemoteMcpTransportConfig } = await import('./session-core/mcp-template-resolution');
              const remote = resolveRemoteMcpTransportConfig(server);
              const controller = new AbortController();
              const timeout = setTimeout(() => controller.abort(), 15000);

              const headers: Record<string, string> = {
                // Streamable HTTP 规范要求同时声明两种格式；SSE 只需 event-stream
                'Accept': server.type === 'sse' ? 'text/event-stream' : 'application/json, text/event-stream',
                // Request uncompressed response to avoid ZlibError.
                // Some servers (e.g., behind WAF/CDN like Huawei Cloud) return
                // content-encoding: gzip with a non-compressed body, causing Bun's
                // fetch() auto-decompression to crash. Validation doesn't need compression.
                'Accept-Encoding': 'identity',
                ...remote.headers,
              };

              let response: Response;

              if (server.type === 'http') {
                // Streamable HTTP: send MCP initialize JSON-RPC request
                response = await fetchWithGeneralProxy(remote.url, {
                  method: 'POST',
                  headers: { ...headers, 'Content-Type': 'application/json' },
                  body: JSON.stringify({
                    jsonrpc: '2.0',
                    id: 1,
                    method: 'initialize',
                    params: {
                      protocolVersion: '2025-03-26',
                      capabilities: {},
                      clientInfo: { name: 'MyAgents', version: '0.1.29' },
                    },
                  }),
                  signal: controller.signal,
                });
              } else {
                // SSE: send GET request to check if endpoint is reachable
                response = await fetchWithGeneralProxy(remote.url, {
                  method: 'GET',
                  headers,
                  signal: controller.signal,
                });
              }

              clearTimeout(timeout);

              // Helper: abort the underlying connection to prevent resource leaks
              // (especially important for SSE — the response is an infinite stream).
              const cleanup = () => { try { controller.abort(); } catch { /* ignore abort errors */ } };

              // Check HTTP status
              if (response.status === 401 || response.status === 403) {
                cleanup();
                return jsonResponse({
                  success: false,
                  error: {
                    type: 'connection_failed',
                    message: `认证失败 (HTTP ${response.status})，请检查 Headers 配置`,
                  }
                });
              }

              if (response.status === 404) {
                cleanup();
                return jsonResponse({
                  success: false,
                  error: {
                    type: 'connection_failed',
                    message: `端点不存在 (HTTP 404)，请检查 URL 是否正确`,
                  }
                });
              }

              if (response.status === 405) {
                // 405 Method Not Allowed: protocol mismatch
                cleanup();
                const hint = server.type === 'sse'
                  ? '。该端点不支持 GET，可能是 Streamable HTTP 端点，请尝试切换传输协议'
                  : '。该端点不支持 POST，可能是 SSE 端点，请尝试切换传输协议';
                return jsonResponse({
                  success: false,
                  error: {
                    type: 'connection_failed',
                    message: `请求方法不被允许 (HTTP 405)${hint}`,
                  }
                });
              }

              if (!response.ok) {
                // 尝试读取 response body 以获取更具体的错误信息
                let detail = '';
                try {
                  const body = await response.json() as Record<string, unknown>;
                  const raw = String(body.message || body.msg || body.error || '');
                  detail = raw.length > 200 ? raw.slice(0, 200) + '…' : raw;
                } catch { /* body 不是 JSON，忽略 */ }
                cleanup();
                return jsonResponse({
                  success: false,
                  error: {
                    type: 'connection_failed',
                    message: `服务器返回错误 (HTTP ${response.status})${detail ? '：' + detail : ''}`,
                  }
                });
              }

              // Protocol-specific validation
              const contentType = response.headers.get('content-type') || '';

              if (server.type === 'sse') {
                // SSE validation only needs headers — abort the infinite stream immediately
                cleanup();

                // SSE endpoint should return text/event-stream
                if (!contentType.includes('text/event-stream')) {
                  // If the URL returns JSON, it's likely a Streamable HTTP endpoint
                  const hint = contentType.includes('application/json') || contentType.includes('text/html')
                    ? '。该 URL 可能是 Streamable HTTP 端点，请尝试切换传输协议为 "Streamable HTTP"'
                    : '';
                  return jsonResponse({
                    success: false,
                    error: {
                      type: 'connection_failed',
                      message: `服务器返回的内容类型不是 SSE (${contentType || 'unknown'})${hint}`,
                    }
                  });
                }
              } else {
                // Streamable HTTP: server may respond with JSON or SSE (both valid per spec)
                // (response.ok is guaranteed here — non-ok statuses returned above)
                if (contentType.includes('text/event-stream')) {
                  // SSE response to POST — valid per MCP Streamable HTTP spec.
                  // Read enough to extract the first JSON-RPC message from SSE data lines.
                  try {
                    const text = await response.text();
                    cleanup();
                    const dataLine = text.split('\n').find(l => l.startsWith('data:'));
                    if (dataLine) {
                      const body = JSON.parse(dataLine.slice(5));
                      if (!body.jsonrpc && !body.result && !body.error) {
                        return jsonResponse({
                          success: false,
                          error: {
                            type: 'connection_failed',
                            message: '服务器 SSE 响应中的数据不是有效的 JSON-RPC 格式',
                          }
                        });
                      }
                    }
                    // SSE stream with valid data or empty (server might send events later) — accept
                  } catch {
                    cleanup();
                    return jsonResponse({
                      success: false,
                      error: {
                        type: 'connection_failed',
                        message: '无法解析服务器的 SSE 响应，请检查 URL 和传输协议',
                      }
                    });
                  }
                } else {
                  // JSON response — original path
                  try {
                    const body = await response.json();
                    cleanup();
                    if (!body.jsonrpc && !body.result && !body.error) {
                      return jsonResponse({
                        success: false,
                        error: {
                          type: 'connection_failed',
                          message: '服务器响应不是有效的 JSON-RPC 格式，请检查 URL 和传输协议',
                        }
                      });
                    }
                  } catch {
                    cleanup();
                    return jsonResponse({
                      success: false,
                      error: {
                        type: 'connection_failed',
                        message: `服务器响应不是有效的 JSON 格式 (${contentType || 'unknown'})`,
                      }
                    });
                  }
                }
              }

              console.log(`[api/mcp/enable] Remote MCP validated: ${server.id} (${server.type}) → ${server.url}`);
              return jsonResponse({ success: true });

            } catch (err: unknown) {
              const error = err instanceof Error ? err : new Error(String(err));
              console.error(`[api/mcp/enable] Remote MCP validation failed: ${server.id}`, error.message);

              let message: string;
              if (error.name === 'AbortError') {
                message = '连接超时（15秒），请检查 URL 是否正确或服务器是否可达';
              } else if (error.message.includes('ENOTFOUND') || error.message.includes('getaddrinfo')) {
                message = 'DNS 解析失败，请检查 URL 域名是否正确';
              } else if (error.message.includes('ECONNREFUSED')) {
                message = '连接被拒绝，请检查服务器是否在运行';
              } else if (error.message.includes('ECONNRESET')) {
                message = '连接被重置，请检查网络或服务器状态';
              } else if (error.message.includes('certificate') || error.message.includes('SSL') || error.message.includes('TLS')) {
                message = 'SSL/TLS 证书错误，请检查服务器证书配置';
              } else if (error.message.includes('Zlib') || error.message.includes('Decompression')) {
                // WAF/CDN may return content-encoding: gzip with non-compressed body.
                // Bun's fetch auto-decompression crashes. Skip validation and let SDK handle it.
                console.warn(`[api/mcp/enable] ZlibError during validation (WAF/CDN issue), allowing MCP: ${server.id}`);
                return jsonResponse({ success: true });
              } else {
                message = `连接失败: ${error.message}`;
              }

              return jsonResponse({
                success: false,
                error: { type: 'connection_failed', message }
              });
            }
          }

          // stdio type: validate command
          if (server.type === 'stdio' && server.command) {
            const command = server.command;

            // Preset MCP (isBuiltin: true) with npx → warmup to download and cache package
            if (server.isBuiltin && command === 'npx') {
              const { resolveNpxMcpInvocation } = await import('./utils/mcp-command');
              const invocation = resolveNpxMcpInvocation(server.args || [], {
                pinPresetPackages: true,
              });

              // Keep all Sidecar child processes on the shared spawn adapter.
              // The npx resolver already projects Windows to node.exe +
              // npx-cli.js because managed Codex owns its final native spawn;
              // the adapter remains the single stream/error lifecycle owner.
              const { spawn: wrappedSpawn } = await import('./utils/subprocess');
              const { getShellEnv } = await import('./utils/shell');
              const baseEnv = getShellEnv();

              const warmupCmd = invocation.command;
              const warmupArgs = [...invocation.args, '--help'];
              const npxDir = dirname(warmupCmd);
              const pathKey = process.platform === 'win32' ? 'Path' : 'PATH';
              const sep = process.platform === 'win32' ? ';' : ':';
              if (!(baseEnv[pathKey] || '').split(sep).includes(npxDir)) {
                baseEnv[pathKey] = npxDir + sep + (baseEnv[pathKey] || '');
              }
              console.log(`[api/mcp/enable] Warming up via ${invocation.source} npx: ${warmupArgs.join(' ')}`);

              const handle = wrappedSpawn([warmupCmd, ...warmupArgs], {
                env: baseEnv,
                stdin: 'ignore',
                stdout: 'pipe',
                stderr: 'pipe',
              });

              // Drain stderr — wrappedSpawn exposes it as a Web ReadableStream
              // (Bun.spawn-shape parity), not a Node Readable, so we read with
              // the Web reader API.
              let stderr = '';
              const stderrDone = (async () => {
                if (!handle.stderr) return;
                const reader = handle.stderr.getReader();
                const decoder = new TextDecoder();
                try {
                  while (true) {
                    const { done, value } = await reader.read();
                    if (done) break;
                    stderr += decoder.decode(value, { stream: true });
                  }
                } catch { /* ignore — process exit will settle handle.exited */ }
                finally {
                  reader.releaseLock();
                }
              })();

              // 2 min timeout (was the old `timeout` spawn option). If npx
              // hangs (e.g. tarball download stalled), kill the wrapper +
              // surface a warmup failure instead of leaving the request open.
              let timedOut = false;
              const timer = setTimeout(() => {
                timedOut = true;
                try { handle.kill('SIGTERM'); } catch { /* ignore */ }
              }, 120000);

              const code = await handle.exited;
              clearTimeout(timer);
              await stderrDone; // make sure all stderr bytes are captured before classifying

              // Spawn-failure path (ENOENT / bad arch / EINVAL): handle.error
              // is populated and code === -1.
              if (handle.error) {
                console.error('[api/mcp/enable] Warmup error:', handle.error);
                return jsonResponse({
                  success: false,
                  error: {
                    type: 'warmup_failed',
                    message: `预热失败: ${handle.error.message}`,
                  },
                });
              }

              if (timedOut) {
                console.warn('[api/mcp/enable] Warmup timed out after 120s');
                return jsonResponse({
                  success: false,
                  error: {
                    type: 'warmup_failed',
                    message: '预热超时（120s），请检查网络或代理设置',
                  },
                });
              }

              console.log(`[api/mcp/enable] Warmup exited with code ${code}`);
              // Code 0 or 1 is acceptable (--help may return 1 for some packages)
              // Check stderr for real errors (package not found, network issues, etc.)
              const stderrLower = stderr.toLowerCase();
              const networkKeywords = [
                'enotfound',     // DNS resolution failed
                'etimedout',     // Connection timeout
                'econnrefused',  // Connection refused
                'econnreset',    // Connection reset
                'proxy error',   // Proxy failures
                'proxy authentication', // Proxy auth required
                'bad gateway',   // Proxy 502
                'socket hang up',// Connection dropped
              ];
              const packageKeywords = [
                '404',                // HTTP 404 not found
                'package not found',  // npm/npx package resolution
                'module not found',   // Module resolution failure
                'err!',               // npm error indicator
              ];
              const isNetworkError = networkKeywords.some(kw => stderrLower.includes(kw));
              const isPackageError = packageKeywords.some(kw => stderrLower.includes(kw));

              if (isNetworkError) {
                return jsonResponse({
                  success: false,
                  error: {
                    type: 'warmup_failed',
                    message: '网络连接失败，请检查网络或代理设置',
                  },
                });
              }
              if (isPackageError) {
                return jsonResponse({
                  success: false,
                  error: {
                    type: 'package_not_found',
                    message: '包不存在或无法下载，请检查包名',
                  },
                });
              }
              if (code !== 0 && code !== 1) {
                return jsonResponse({
                  success: false,
                  error: {
                    type: 'warmup_failed',
                    message: `预热异常退出 (code ${code})`,
                  },
                });
              }
              return jsonResponse({ success: true });
            }

            // Custom MCP or non-npx command → check if command exists in user's shell PATH
            const { spawn } = await import('child_process');
            const { getShellEnv } = await import('./utils/shell');
            const checkCmd = process.platform === 'win32' ? 'where' : 'which';

            return new Promise<Response>((resolve) => {
              const proc = spawn(checkCmd, [command], { stdio: 'ignore', env: getShellEnv() });

              proc.on('error', () => {
                resolve(jsonResponse({
                  success: false,
                  error: {
                    type: 'command_not_found',
                    command,
                    message: `命令 "${command}" 未找到`,
                    ...getCommandDownloadInfo(command),
                  }
                }));
              });

              proc.on('close', (code) => {
                if (code === 0) {
                  resolve(jsonResponse({ success: true }));
                } else {
                  resolve(jsonResponse({
                    success: false,
                    error: {
                      type: 'command_not_found',
                      command,
                      message: `命令 "${command}" 未找到`,
                      ...getCommandDownloadInfo(command),
                    }
                  }));
                }
              });
            });
          }

          // Default: allow
          return jsonResponse({ success: true });
        } catch (error) {
          console.error('[api/mcp/enable] Error:', error);
          return jsonResponse({
            success: false,
            error: {
              type: 'unknown',
              message: error instanceof Error ? error.message : '启用失败',
            }
          }, 500);
        }
      }

      // POST /api/permission/respond - Handle user permission decision
      // Auto-routes to external runtime (CC/Codex) when active, otherwise uses builtin SDK handler.
      if (pathname === '/api/permission/respond' && request.method === 'POST') {
        try {
          const payload = await request.json() as {
            requestId: string;
            decision: 'deny' | 'allow_once' | 'always_allow';
          };

          const success = await getPermissionResponseEngine().respondPermission(payload.requestId, payload.decision);

          return jsonResponse({ success });
        } catch (error) {
          console.error('[api/permission] Error:', error);
          return jsonResponse({ success: false, error: String(error) }, 500);
        }
      }

      // POST /api/ask-user-question/respond - Handle user's answers to AskUserQuestion
      // Auto-routes to external runtime (CC) when the request was originated there, otherwise
      // uses builtin SDK handler. External-runtime tracking lives in external-session.ts.
      if (pathname === '/api/ask-user-question/respond' && request.method === 'POST') {
        try {
          const payload = await request.json() as {
            requestId: string;
            answers: Record<string, string> | null;  // null means user cancelled
          };

          // Route by pending-request ownership, NOT live session state
          // (cross-review C4): if we track this requestId as external, the
          // answer belongs to CC even if the process just died. Deferring to
          // the builtin handler would return "unknown request" and silently
          // lose the user's input. External handler returns false + logs on
          // process-gone, surfacing the failure to the UI.
          const success = await getAskUserQuestionResponseEngine(payload.requestId)
            .respondAskUserQuestion(payload.requestId, payload.answers);

          return jsonResponse({ success });
        } catch (error) {
          console.error('[api/ask-user-question] Error:', error);
          return jsonResponse({ success: false, error: String(error) }, 500);
        }
      }
      // POST /api/exit-plan-mode/respond - Handle user's approval/rejection of ExitPlanMode.
      // `feedback` (optional, issue #182): user's modification comment used as
      // deny.message when rejecting, so the AI revises the plan in the same turn.
      if (pathname === '/api/exit-plan-mode/respond' && request.method === 'POST') {
        try {
          const raw = await request.json() as Record<string, unknown>;
          // Runtime validation — typed `as ExitPlanModeResponse` cast accepts
          // truthy strings like `approved: "false"` which would silently
          // approve the plan (review-by-codex finding). Validate explicitly.
          if (typeof raw?.requestId !== 'string' || typeof raw?.approved !== 'boolean'
              || (raw.feedback !== undefined && typeof raw.feedback !== 'string')) {
            return jsonResponse({ success: false, error: 'invalid payload' }, 400);
          }
          const { handleExitPlanModeResponse } = await import('./agent-session');
          const success = handleExitPlanModeResponse(raw.requestId, raw.approved, raw.feedback as string | undefined);
          return jsonResponse({ success });
        } catch (error) {
          console.error('[api/exit-plan-mode] Error:', error);
          return jsonResponse({ success: false, error: String(error) }, 500);
        }
      }

      // POST /api/enter-plan-mode/respond - Handle user's approval/rejection of EnterPlanMode
      if (pathname === '/api/enter-plan-mode/respond' && request.method === 'POST') {
        try {
          const raw = await request.json() as Record<string, unknown>;
          // Runtime validation — match the exit-plan-mode endpoint's defense
          // (review-by-cc finding: parallel endpoint had unsafe cast). A
          // payload like `{requestId:"x", approved:"false"}` would otherwise
          // pass the cast and `approved` would be the truthy string,
          // silently entering plan mode against user intent.
          if (typeof raw?.requestId !== 'string' || typeof raw?.approved !== 'boolean') {
            return jsonResponse({ success: false, error: 'invalid payload' }, 400);
          }
          const { handleEnterPlanModeResponse } = await import('./agent-session');
          const success = handleEnterPlanModeResponse(raw.requestId, raw.approved);
          return jsonResponse({ success });
        } catch (error) {
          console.error('[api/enter-plan-mode] Error:', error);
          return jsonResponse({ success: false, error: String(error) }, 500);
        }
      }

      // ============= MCP OAuth API =============

      // POST /api/mcp/oauth/discover - Probe MCP server for OAuth requirements
      if (pathname === '/api/mcp/oauth/discover' && request.method === 'POST') {
        try {
          const payload = await request.json() as { serverId: string; mcpUrl: string; forceRefresh?: boolean };
          if (!payload.serverId || !payload.mcpUrl) {
            return jsonResponse({ success: false, error: 'Missing serverId or mcpUrl' }, 400);
          }
          const { probeOAuthRequirement } = await import('./mcp-oauth');
          const result = await probeOAuthRequirement(payload.serverId, payload.mcpUrl, payload.forceRefresh);
          return jsonResponse({ success: true, ...result });
        } catch (error) {
          console.error('[api/mcp/oauth/discover] Error:', error);
          return jsonResponse({ success: false, error: error instanceof Error ? error.message : 'Discovery failed' }, 500);
        }
      }

      // POST /api/mcp/oauth/start - Start OAuth flow (auto or manual mode)
      if (pathname === '/api/mcp/oauth/start' && request.method === 'POST') {
        try {
          const payload = await request.json() as {
            serverId: string;
            serverUrl: string;
            // Manual mode fields (all optional — omit for auto mode)
            clientId?: string;
            clientSecret?: string;
            scopes?: string[];
            callbackPort?: number;
            authorizationUrl?: string;
            tokenUrl?: string;
          };

          if (!payload.serverId || !payload.serverUrl) {
            return jsonResponse({ success: false, error: 'Missing serverId or serverUrl' }, 400);
          }

          const { authorizeServer } = await import('./mcp-oauth');
          const manualConfig = payload.clientId ? {
            clientId: payload.clientId,
            clientSecret: payload.clientSecret,
            scopes: payload.scopes,
            callbackPort: payload.callbackPort,
            authorizationUrl: payload.authorizationUrl,
            tokenUrl: payload.tokenUrl,
          } : undefined;

          const { authUrl, waitForCompletion } = await authorizeServer(
            payload.serverId,
            payload.serverUrl,
            manualConfig,
          );

          // Don't await completion — return the auth URL immediately
          waitForCompletion.then((success) => {
            if (success) {
              console.log(`[api/mcp/oauth] Authorization completed for ${payload.serverId}`);
            } else {
              console.warn(`[api/mcp/oauth] Authorization failed or cancelled for ${payload.serverId}`);
            }
          });

          return jsonResponse({ success: true, authUrl });
        } catch (error) {
          console.error('[api/mcp/oauth/start] Error:', error);
          return jsonResponse(
            { success: false, error: error instanceof Error ? error.message : 'Failed to start OAuth flow' },
            500
          );
        }
      }

      // GET /api/mcp/oauth/status/:serverId - Get OAuth status
      if (pathname.startsWith('/api/mcp/oauth/status/') && request.method === 'GET') {
        try {
          const serverId = decodeURIComponent(pathname.slice('/api/mcp/oauth/status/'.length));
          const { getOAuthStatus } = await import('./mcp-oauth');
          const result = getOAuthStatus(serverId);
          return jsonResponse({
            success: true,
            status: result.status,
            hasToken: result.status === 'connected' || result.status === 'expired',
            expiresAt: result.expiresAt,
            scope: result.scope,
          });
        } catch (error) {
          console.error('[api/mcp/oauth/status] Error:', error);
          return jsonResponse({ success: false, error: String(error) }, 500);
        }
      }

      // POST /api/mcp/oauth/refresh - Manually refresh OAuth token
      if (pathname === '/api/mcp/oauth/refresh' && request.method === 'POST') {
        try {
          const payload = await request.json() as { serverId: string };
          const { manualRefreshToken } = await import('./mcp-oauth');
          const refreshed = await manualRefreshToken(payload.serverId);
          return jsonResponse({ success: refreshed, refreshed });
        } catch (error) {
          console.error('[api/mcp/oauth/refresh] Error:', error);
          return jsonResponse({ success: false, error: String(error) }, 500);
        }
      }

      // DELETE /api/mcp/oauth/token - Revoke OAuth authorization
      if (pathname === '/api/mcp/oauth/token' && request.method === 'DELETE') {
        try {
          const payload = await request.json() as { serverId: string };
          const { revokeAuthorization } = await import('./mcp-oauth');
          await revokeAuthorization(payload.serverId);
          return jsonResponse({ success: true });
        } catch (error) {
          console.error('[api/mcp/oauth/token] Error:', error);
          return jsonResponse({ success: false, error: String(error) }, 500);
        }
      }

      // ============= END MCP OAuth API =============

      // ============= END MCP API =============

      // ============= ADMIN API (Self-Config CLI) =============
      if (pathname.startsWith('/api/admin/') && request.method === 'POST') {
        try {
          const payload = pathname === '/api/admin/status'
            ? {}
            : await request.json().catch(() => ({})) as Record<string, unknown>;

          const result = await routeAdminApi(pathname, payload, request.signal);
          return jsonResponse(result, result.success ? 200 : 400);
        } catch (error) {
          console.error(`[admin] ${pathname} error:`, error);
          return jsonResponse(
            { success: false, error: error instanceof Error ? error.message : 'Admin API error' },
            500
          );
        }
      }
      // ============= END ADMIN API =============

      // ============= SLASH COMMANDS API =============

      // ============= CLAUDE.md API =============


      // Security: Validate item names to prevent path traversal attacks
      // Supports Unicode (Chinese, Japanese, etc.) while maintaining security
      // Defined here (before Rules and Skills APIs) so all endpoints can use it
      const isValidItemName = (name: string): boolean => {
        // Reject empty names
        if (!name || name.trim().length === 0) {
          return false;
        }
        // Reject path separators and parent directory references (security)
        if (name.includes('/') || name.includes('\\') || name.includes('..')) {
          return false;
        }
        // Reject Windows reserved characters: < > : " | ? *
        // These cause issues on Windows file systems
        if (/[<>:"|?*]/.test(name)) {
          return false;
        }
        // Reject control characters (0x00-0x1F, 0x7F)
        // eslint-disable-next-line no-control-regex -- Intentional control character detection for filename validation
        if (/[\x00-\x1f\x7f]/.test(name)) {
          return false;
        }
        // Reject names that are only dots (., ..) or start/end with spaces
        if (/^\.+$/.test(name) || name !== name.trim()) {
          return false;
        }
        // Reject Windows reserved file names (CON, PRN, AUX, NUL, COM1-9, LPT1-9)
        if (isWindowsReservedName(name)) {
          return false;
        }
        // Allow Unicode letters, numbers, hyphens, underscores, spaces, and common punctuation
        return true;
      };

      // ============= RULES FILES API =============
      // Manage .claude/rules/*.md files (system prompt rules)

      // GET /api/rules - List all rule files
      if (pathname === '/api/rules' && request.method === 'GET') {
        try {
          const queryAgentDir = url.searchParams.get('agentDir');
          if (queryAgentDir && !isValidAgentDir(queryAgentDir).valid) {
            return jsonResponse({ success: false, error: 'Invalid agentDir' }, 400);
          }
          const targetDir = queryAgentDir || currentAgentDir;
          const rulesDir = join(targetDir, '.claude', 'rules');
          if (!existsSync(rulesDir)) {
            return jsonResponse({ success: true, files: [] });
          }
          const files = readdirSync(rulesDir)
            .filter(f => f.endsWith('.md'))
            .sort();
          return jsonResponse({ success: true, files });
        } catch (error) {
          console.error('[api/rules] Error listing:', error);
          return jsonResponse(
            { success: false, error: error instanceof Error ? error.message : 'Failed to list rules' },
            500
          );
        }
      }

      // POST /api/rules - Create a new rule file
      if (pathname === '/api/rules' && request.method === 'POST') {
        try {
          const payload = await request.json() as { name: string; content?: string };
          if (!payload.name || !payload.name.trim()) {
            return jsonResponse({ success: false, error: 'Name is required' }, 400);
          }
          // Ensure .md suffix
          let filename = payload.name.trim();
          if (!filename.endsWith('.md')) {
            filename = filename + '.md';
          }
          const nameWithoutExt = filename.replace(/\.md$/, '');
          if (!isValidItemName(nameWithoutExt)) {
            return jsonResponse({ success: false, error: 'Invalid file name' }, 400);
          }
          const queryAgentDir = url.searchParams.get('agentDir');
          if (queryAgentDir && !isValidAgentDir(queryAgentDir).valid) {
            return jsonResponse({ success: false, error: 'Invalid agentDir' }, 400);
          }
          const targetDir = queryAgentDir || currentAgentDir;
          const rulesDir = join(targetDir, '.claude', 'rules');
          ensureDirSync(rulesDir);
          const filePath = join(rulesDir, filename);
          if (existsSync(filePath)) {
            return jsonResponse({ success: false, error: 'File already exists' }, 409);
          }
          writeFileSync(filePath, payload.content || '', 'utf-8');
          return jsonResponse({ success: true, filename });
        } catch (error) {
          console.error('[api/rules] Error creating:', error);
          return jsonResponse(
            { success: false, error: error instanceof Error ? error.message : 'Failed to create rule file' },
            500
          );
        }
      }

      // PUT /api/rules/:filename/rename - Rename a rule file
      if (pathname.startsWith('/api/rules/') && pathname.endsWith('/rename') && request.method === 'PUT') {
        try {
          const filename = decodeURIComponent(pathname.slice('/api/rules/'.length, -'/rename'.length));
          if (!filename || !filename.endsWith('.md')) {
            return jsonResponse({ success: false, error: 'Invalid filename' }, 400);
          }
          const oldNameWithoutExt = filename.replace(/\.md$/, '');
          if (!isValidItemName(oldNameWithoutExt)) {
            return jsonResponse({ success: false, error: 'Invalid filename' }, 400);
          }
          const payload = await request.json() as { newName: string };
          if (!payload.newName || !payload.newName.trim()) {
            return jsonResponse({ success: false, error: 'New name is required' }, 400);
          }
          let newFilename = payload.newName.trim();
          if (!newFilename.endsWith('.md')) {
            newFilename = newFilename + '.md';
          }
          const newNameWithoutExt = newFilename.replace(/\.md$/, '');
          if (!isValidItemName(newNameWithoutExt)) {
            return jsonResponse({ success: false, error: 'Invalid new file name' }, 400);
          }
          const queryAgentDir = url.searchParams.get('agentDir');
          if (queryAgentDir && !isValidAgentDir(queryAgentDir).valid) {
            return jsonResponse({ success: false, error: 'Invalid agentDir' }, 400);
          }
          const targetDir = queryAgentDir || currentAgentDir;
          const rulesDir = join(targetDir, '.claude', 'rules');
          const oldPath = join(rulesDir, filename);
          const newPath = join(rulesDir, newFilename);
          if (!existsSync(oldPath)) {
            return jsonResponse({ success: false, error: 'File not found' }, 404);
          }
          if (existsSync(newPath)) {
            return jsonResponse({ success: false, error: 'Target filename already exists' }, 409);
          }
          renameSync(oldPath, newPath);
          return jsonResponse({ success: true, filename: newFilename });
        } catch (error) {
          console.error('[api/rules] Error renaming:', error);
          return jsonResponse(
            { success: false, error: error instanceof Error ? error.message : 'Failed to rename rule file' },
            500
          );
        }
      }

      // GET /api/rules/:filename - Read a rule file
      if (pathname.startsWith('/api/rules/') && request.method === 'GET') {
        try {
          const filename = decodeURIComponent(pathname.slice('/api/rules/'.length));
          if (!filename || !filename.endsWith('.md')) {
            return jsonResponse({ success: false, error: 'Invalid filename' }, 400);
          }
          const nameWithoutExt = filename.replace(/\.md$/, '');
          if (!isValidItemName(nameWithoutExt)) {
            return jsonResponse({ success: false, error: 'Invalid filename' }, 400);
          }
          const queryAgentDir = url.searchParams.get('agentDir');
          if (queryAgentDir && !isValidAgentDir(queryAgentDir).valid) {
            return jsonResponse({ success: false, error: 'Invalid agentDir' }, 400);
          }
          const targetDir = queryAgentDir || currentAgentDir;
          const rulesDir = join(targetDir, '.claude', 'rules');
          const filePath = join(rulesDir, filename);
          if (!existsSync(filePath)) {
            return jsonResponse({ success: true, exists: false, content: '' });
          }
          const content = readFileSync(filePath, 'utf-8');
          return jsonResponse({ success: true, exists: true, content });
        } catch (error) {
          console.error('[api/rules] Error reading:', error);
          return jsonResponse(
            { success: false, error: error instanceof Error ? error.message : 'Failed to read rule file' },
            500
          );
        }
      }

      // PUT /api/rules/:filename - Update a rule file
      if (pathname.startsWith('/api/rules/') && request.method === 'PUT') {
        try {
          const filename = decodeURIComponent(pathname.slice('/api/rules/'.length));
          if (!filename || !filename.endsWith('.md')) {
            return jsonResponse({ success: false, error: 'Invalid filename' }, 400);
          }
          const nameWithoutExt = filename.replace(/\.md$/, '');
          if (!isValidItemName(nameWithoutExt)) {
            return jsonResponse({ success: false, error: 'Invalid filename' }, 400);
          }
          const payload = await request.json() as { content: string };
          if (typeof payload.content !== 'string') {
            return jsonResponse({ success: false, error: 'Content must be a string' }, 400);
          }
          const queryAgentDir = url.searchParams.get('agentDir');
          if (queryAgentDir && !isValidAgentDir(queryAgentDir).valid) {
            return jsonResponse({ success: false, error: 'Invalid agentDir' }, 400);
          }
          const targetDir = queryAgentDir || currentAgentDir;
          const rulesDir = join(targetDir, '.claude', 'rules');
          ensureDirSync(rulesDir);
          const filePath = join(rulesDir, filename);
          writeFileSync(filePath, payload.content, 'utf-8');
          return jsonResponse({ success: true });
        } catch (error) {
          console.error('[api/rules] Error updating:', error);
          return jsonResponse(
            { success: false, error: error instanceof Error ? error.message : 'Failed to update rule file' },
            500
          );
        }
      }

      // DELETE /api/rules/:filename - Delete a rule file
      if (pathname.startsWith('/api/rules/') && request.method === 'DELETE') {
        try {
          const filename = decodeURIComponent(pathname.slice('/api/rules/'.length));
          if (!filename || !filename.endsWith('.md')) {
            return jsonResponse({ success: false, error: 'Invalid filename' }, 400);
          }
          const nameWithoutExt = filename.replace(/\.md$/, '');
          if (!isValidItemName(nameWithoutExt)) {
            return jsonResponse({ success: false, error: 'Invalid filename' }, 400);
          }
          const queryAgentDir = url.searchParams.get('agentDir');
          if (queryAgentDir && !isValidAgentDir(queryAgentDir).valid) {
            return jsonResponse({ success: false, error: 'Invalid agentDir' }, 400);
          }
          const targetDir = queryAgentDir || currentAgentDir;
          const rulesDir = join(targetDir, '.claude', 'rules');
          const filePath = join(rulesDir, filename);
          if (!existsSync(filePath)) {
            return jsonResponse({ success: false, error: 'File not found' }, 404);
          }
          unlinkSync(filePath);
          return jsonResponse({ success: true });
        } catch (error) {
          console.error('[api/rules] Error deleting:', error);
          return jsonResponse(
            { success: false, error: error instanceof Error ? error.message : 'Failed to delete rule file' },
            500
          );
        }
      }

      // ============= SKILLS MANAGEMENT API =============

      // Cross-platform home directory for user skills/commands
      const homeDir = getHomeDirOrNull() || '';
      const userSkillsBaseDir = join(homeDir, '.myagents', 'skills');
      const userCommandsBaseDir = join(homeDir, '.myagents', 'commands');

      // Helper: Get project base directories (supports explicit agentDir parameter)
      // Security: validates agentDir to prevent path traversal attacks
      const getProjectBaseDirs = (queryAgentDir: string | null) => {
        // If explicit agentDir provided, validate it first
        if (queryAgentDir && !isValidAgentDir(queryAgentDir).valid) {
          // Invalid agentDir, fall back to currentAgentDir
          console.warn(`[getProjectBaseDirs] Invalid agentDir rejected: ${queryAgentDir}`);
          queryAgentDir = null;
        }
        // Use validated agentDir if provided, otherwise fall back to currentAgentDir
        const effectiveAgentDir = queryAgentDir || currentAgentDir;
        const hasValidDir = effectiveAgentDir && existsSync(effectiveAgentDir);
        return {
          skillsDir: hasValidDir ? join(effectiveAgentDir, '.claude', 'skills') : '',
          commandsDir: hasValidDir ? join(effectiveAgentDir, '.claude', 'commands') : '',
        };
      };

      // Default project paths (using currentAgentDir)
      const hasValidAgentDir = currentAgentDir && existsSync(currentAgentDir);
      const projectSkillsBaseDir = hasValidAgentDir ? join(currentAgentDir, '.claude', 'skills') : '';
      const projectCommandsBaseDir = hasValidAgentDir ? join(currentAgentDir, '.claude', 'commands') : '';

      // GET /api/project-capabilities - authoritative candidate + effective set
      // for the current workspace. Unlike the legacy per-directory endpoints,
      // this resolves MyAgents-managed symlinks back to their global origin,
      // applies project-over-global winner semantics, and keeps disabled cards.
      if (pathname === '/api/project-capabilities' && request.method === 'GET') {
        try {
          const queryAgentDir = url.searchParams.get('agentDir');
          if (queryAgentDir && !isValidAgentDir(queryAgentDir).valid) {
            return jsonResponse({ success: false, error: 'Invalid workspace path' }, 400);
          }
          const workspacePath = queryAgentDir || currentAgentDir;
          if (!workspacePath) {
            return jsonResponse({ success: false, error: 'Workspace is unavailable' }, 409);
          }
          const globalSkillInventory = createGlobalSkillInventorySnapshot();
          return jsonResponse(projectCapabilitySnapshotForWire(
            resolveEffectiveProjectCapabilities(workspacePath, {
              globalSkillInventory,
            }),
          ));
        } catch (error) {
          console.error('[api/project-capabilities] Error:', error);
          return jsonResponse({
            success: false,
            error: error instanceof Error ? error.message : 'Failed to resolve project capabilities',
          }, 500);
        }
      }

      // POST /api/project-capability/toggle - persist one disabled override on
      // the exact AgentConfig selected by Project.agentId. Runtime replacement
      // intentionally waits for each Session's next turn.
      if (pathname === '/api/project-capability/toggle' && request.method === 'POST') {
        try {
          const body = await request.json() as {
            capabilityId?: unknown;
            enabled?: unknown;
            agentDir?: unknown;
          };
          if (typeof body.capabilityId !== 'string' || typeof body.enabled !== 'boolean') {
            return jsonResponse({ success: false, error: 'Invalid capability toggle request' }, 400);
          }
          const queryAgentDir = typeof body.agentDir === 'string' ? body.agentDir : null;
          if (queryAgentDir && !isValidAgentDir(queryAgentDir).valid) {
            return jsonResponse({ success: false, error: 'Invalid workspace path' }, 400);
          }
          const workspacePath = queryAgentDir || currentAgentDir;
          if (!workspacePath) {
            return jsonResponse({ success: false, error: 'Workspace is unavailable' }, 409);
          }
          const snapshot = await setProjectCapabilityEnabled({
            workspacePath,
            capabilityId: body.capabilityId,
            enabled: body.enabled,
          });
          broadcast('config:changed', {
            section: 'agent',
            action: 'project-capability-toggle',
            id: snapshot.agentId,
          });
          // App-wide invalidation is advisory here: every Session resolves the
          // disk authority again at its own turn admission, so a renderer fanout
          // outage must not turn a committed save into a false rollback.
          if (process.env.MYAGENTS_MANAGEMENT_PORT) {
            void managementApi('/api/app/config-changed', 'POST', {}, { timeoutMs: 2_000 })
              .catch(error => console.warn('[api/project-capability/toggle] app refresh failed:', error));
          }
          return jsonResponse(projectCapabilitySnapshotForWire(snapshot));
        } catch (error) {
          console.error('[api/project-capability/toggle] Error:', error);
          return jsonResponse({
            success: false,
            error: error instanceof Error ? error.message : 'Failed to save project capability',
          }, 500);
        }
      }

      // GET /api/skills - List all skills (with scope filter)
      // Supports ?agentDir= for listing skills from a specific workspace (e.g. from Launcher)
      if (pathname === '/api/skills' && request.method === 'GET') {
        try {
          const scope = url.searchParams.get('scope') || 'all';
          const queryAgentDir = url.searchParams.get('agentDir');
          const { skillsDir: effectiveSkillsDir } = getProjectBaseDirs(queryAgentDir);
          const skillsConfigForList = readSkillsConfig();
          const globalSkillInventory = (scope === 'all' || scope === 'user')
            ? createGlobalSkillInventorySnapshot({ rootPath: userSkillsBaseDir })
            : null;
          const skills: Array<{
            name: string;
            description: string;
            scope: 'user' | 'project';
            path: string;
            folderName: string;
            author?: string;
            systemOwned: boolean;
            required: boolean;
            enabled: boolean;
          }> = [];

          const scanSkills = (dir: string, scopeType: 'user' | 'project') => {
            if (!dir || !existsSync(dir)) return;
            try {
              const folders = readdirSync(dir, { withFileTypes: true });
              for (const folder of folders) {
                const folderPath = join(dir, folder.name);
                if (scopeType === 'project' && isManagedSymlink(folderPath, userSkillsBaseDir)) {
                  continue;
                }
                // isDirEntry follows symlinks + Windows junctions (issue #104).
                if (!isDirEntry(folder, folderPath)) continue;
                const skillMdPath = join(folderPath, 'SKILL.md');
                if (!existsSync(skillMdPath)) continue;

                const content = readFileSync(skillMdPath, 'utf-8');
                const { name, description, author } = parseSkillFrontmatter(content);
                const systemOwned = scopeType === 'user' && isSystemSkillName(folder.name);
                const required = scopeType === 'user' && isRequiredSystemSkill(folder.name);
                skills.push({
                  name: name || folder.name,
                  description: description || '',
                  scope: scopeType,
                  path: skillMdPath,
                  folderName: folder.name,
                  author,
                  systemOwned,
                  required,
                  enabled: scopeType === 'project'
                    || required
                    || !skillsConfigForList.disabled.includes(folder.name),
                });
              }
            } catch (scanError) {
              console.warn(`[api/skills] Error scanning ${scopeType} skills:`, scanError);
            }
          };

          const resolvedProjectSkillsDir = effectiveSkillsDir || projectSkillsBaseDir;
          if ((scope === 'all' || scope === 'project') && resolvedProjectSkillsDir) {
            scanSkills(resolvedProjectSkillsDir, 'project');
          }
          if (scope === 'all' || scope === 'user') {
            for (const entry of globalSkillInventory?.entries ?? []) {
              const systemOwned = isSystemSkillName(entry.folderName);
              skills.push({
                name: entry.name,
                description: entry.description,
                scope: 'user',
                path: entry.skillPath,
                folderName: entry.folderName,
                ...(entry.author ? { author: entry.author } : {}),
                systemOwned,
                required: entry.required,
                enabled: entry.enabledForProjection,
              });
            }
          }

          return jsonResponse({
            success: true,
            skills,
            ...(globalSkillInventory
              ? { integrityIssues: globalSkillInventory.integrityIssues }
              : {}),
          });
        } catch (error) {
          console.error('[api/skills] Error:', error);
          return jsonResponse(
            { success: false, error: error instanceof Error ? error.message : 'Failed to list skills' },
            500
          );
        }
      }

      // POST /api/skill/toggle-enable - Enable/disable a user-level skill
      // NOTE: This route MUST be before /api/skill/:name to avoid being captured by the wildcard
      if (pathname === '/api/skill/toggle-enable' && request.method === 'POST') {
        try {
          const { folderName, enabled } = await request.json() as { folderName: string; enabled: boolean };
          if (!folderName || typeof folderName !== 'string') {
            return jsonResponse({ success: false, error: 'Invalid folderName' }, 400);
          }
          if (typeof enabled !== 'boolean') {
            return jsonResponse({ success: false, error: 'Invalid enabled state' }, 400);
          }
          if (!enabled && isRequiredSystemSkill(folderName)) {
            return jsonResponse({
              success: false,
              error: `${folderName} is a required MyAgents system skill and cannot be disabled`,
            }, 409);
          }
          const config = readSkillsConfig();
          if (enabled) {
            config.disabled = config.disabled.filter(n => n !== folderName);
          } else {
            if (!config.disabled.includes(folderName)) config.disabled.push(folderName);
          }
          writeSkillsConfig(config);
          // Re-sync project skill symlinks if this sidecar has an agentDir
          // (Global Sidecar has no agentDir; Tab Sidecars will sync on next /api/commands or /api/skills)
          if (agentDir) { syncProjectUserConfig(agentDir); }
          return jsonResponse({ success: true });
        } catch (error) {
          console.error('[api/skill/toggle-enable] Error:', error);
          return jsonResponse(
            { success: false, error: error instanceof Error ? error.message : 'Failed to toggle skill' },
            500
          );
        }
      }

      // GET /api/skill/sync-check - Check if there are skills to sync from Claude Code
      // NOTE: This route MUST be before /api/skill/:name to avoid being captured by the wildcard
      if (pathname === '/api/skill/sync-check' && request.method === 'GET') {
        try {
          const claudeSkillsDir = join(homeDir, '.claude', 'skills');

          // Check if Claude Code skills directory exists
          if (!existsSync(claudeSkillsDir)) {
            return jsonResponse({ canSync: false, count: 0, folders: [] });
          }

          // Get folders in Claude Code skills directory (follow junctions — issue #104).
          // Users sometimes mount their skills hub into ~/.claude/skills/ via
          // junction too; bare `isDirectory()` would miss them asymmetrically
          // with the myagentsFolders side.
          const claudeFolders = readdirSync(claudeSkillsDir, { withFileTypes: true })
            .filter(entry => isDirEntry(entry, join(claudeSkillsDir, entry.name)))
            .map(entry => entry.name);

          if (claudeFolders.length === 0) {
            return jsonResponse({ canSync: false, count: 0, folders: [] });
          }

          // Get existing folders in MyAgents skills directory.
          // isDirEntry follows junctions (issue #104) so mounted skills count
          // as existing, preventing sync-from-claude from overwriting them.
          const myagentsFolders = new Set<string>();
          if (existsSync(userSkillsBaseDir)) {
            const entries = readdirSync(userSkillsBaseDir, { withFileTypes: true });
            for (const entry of entries) {
              if (isDirEntry(entry, join(userSkillsBaseDir, entry.name))) {
                myagentsFolders.add(entry.name);
              }
            }
          }

          // Find folders that can be synced (exist in Claude but not in MyAgents)
          const syncableFolders = claudeFolders.filter(folder => !myagentsFolders.has(folder));

          return jsonResponse({
            canSync: syncableFolders.length > 0,
            count: syncableFolders.length,
            folders: syncableFolders
          });
        } catch (error) {
          console.error('[api/skill/sync-check] Error:', error);
          return jsonResponse(
            { canSync: false, count: 0, folders: [], error: error instanceof Error ? error.message : 'Check failed' },
            500
          );
        }
      }

      // POST /api/skill/sync-from-claude - Sync skills from Claude Code to MyAgents
      // NOTE: This route MUST be before /api/skill/:name to avoid being captured by the wildcard
      if (pathname === '/api/skill/sync-from-claude' && request.method === 'POST') {
        try {
          const claudeSkillsDir = join(homeDir, '.claude', 'skills');

          // Check if Claude Code skills directory exists
          if (!existsSync(claudeSkillsDir)) {
            return jsonResponse({ success: false, synced: 0, failed: 0, error: 'Claude Code skills directory not found' }, 404);
          }

          // Get folders in Claude Code skills directory (follow junctions — issue #104)
          const claudeFolders = readdirSync(claudeSkillsDir, { withFileTypes: true })
            .filter(entry => isDirEntry(entry, join(claudeSkillsDir, entry.name)))
            .map(entry => entry.name);

          if (claudeFolders.length === 0) {
            return jsonResponse({ success: true, synced: 0, failed: 0, message: 'No skills to sync' });
          }

          // Ensure MyAgents skills directory exists
          if (!existsSync(userSkillsBaseDir)) {
            ensureDirSync(userSkillsBaseDir);
          }

          // Get existing folders in MyAgents skills directory (follow junctions — issue #104)
          const myagentsFolders = new Set<string>();
          const entries = readdirSync(userSkillsBaseDir, { withFileTypes: true });
          for (const entry of entries) {
            if (isDirEntry(entry, join(userSkillsBaseDir, entry.name))) {
              myagentsFolders.add(entry.name);
            }
          }

          // Find folders that can be synced (filter out invalid folder names for security)
          const syncableFolders = claudeFolders.filter(folder =>
            !myagentsFolders.has(folder) && isValidFolderName(folder)
          );

          if (syncableFolders.length === 0) {
            return jsonResponse({ success: true, synced: 0, failed: 0, message: 'All skills already exist' });
          }

          // Copy each syncable folder
          let synced = 0;
          let failed = 0;
          const errors: string[] = [];

          // Async copy — yields to the event loop so the Rust health monitor's
          // /health probe (2 s timeout, 15 s interval) keeps succeeding while the
          // bulk sync runs. Blocking here was the root cause of the "sidecar
          // respawns mid-sync, port jumps" symptom users saw on Windows.
          for (const folder of syncableFolders) {
            const srcDir = join(claudeSkillsDir, folder);
            const destDir = join(userSkillsBaseDir, folder);

            try {
              await copyDirRecursive(srcDir, destDir, '[api/skill/sync-from-claude]');

              // Ensure SKILL.md exists — Claude Code may use different file names
              const skillMdPath = join(destDir, 'SKILL.md');
              if (!existsSync(skillMdPath)) {
                // Sanitize folder name for YAML frontmatter (escape quotes and backslashes)
                const safeName = folder.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
                // Look for any .md file to use as the skill definition
                const mdFiles = readdirSync(destDir).filter(f => f.endsWith('.md') && f !== 'SKILL.md');
                if (mdFiles.length > 0) {
                  // Use the first .md file as SKILL.md source
                  const srcMd = join(destDir, mdFiles[0]);
                  const mdContent = readFileSync(srcMd, 'utf-8');
                  // Check if it already has frontmatter; if not, add minimal frontmatter
                  if (mdContent.startsWith('---')) {
                    writeFileSync(skillMdPath, mdContent, 'utf-8');
                  } else {
                    const skillContent = `---\nname: "${safeName}"\ndescription: "Imported from Claude Code"\n---\n\n${mdContent}`;
                    writeFileSync(skillMdPath, skillContent, 'utf-8');
                  }
                  console.log(`[api/skill/sync-from-claude] Created SKILL.md from ${mdFiles[0]} for "${folder}"`);
                } else {
                  // No .md files — create minimal SKILL.md
                  const minimalContent = `---\nname: "${safeName}"\ndescription: "Imported from Claude Code"\n---\n\nSkill imported from Claude Code.\n`;
                  writeFileSync(skillMdPath, minimalContent, 'utf-8');
                  console.log(`[api/skill/sync-from-claude] Created minimal SKILL.md for "${folder}"`);
                }
              }

              synced++;
              if (process.env.DEBUG === '1') {
                console.log(`[api/skill/sync-from-claude] Synced skill "${folder}"`);
              }
            } catch (copyError) {
              failed++;
              const errorMsg = copyError instanceof Error ? copyError.message : 'Unknown error';
              errors.push(`${folder}: ${errorMsg}`);
              console.error(`[api/skill/sync-from-claude] Failed to copy "${folder}":`, copyError);
            }
          }

          // Imported user skills — bump generation + sync symlinks into project
          if (synced > 0) {
            bumpSkillsGeneration();
            if (agentDir) { syncProjectUserConfig(agentDir); }
          }
          return jsonResponse({
            success: true,
            synced,
            failed,
            errors: errors.length > 0 ? errors : undefined
          });
        } catch (error) {
          console.error('[api/skill/sync-from-claude] Error:', error);
          return jsonResponse(
            { success: false, synced: 0, failed: 0, error: error instanceof Error ? error.message : 'Sync failed' },
            500
          );
        }
      }

      // GET /api/skill/:name - Get skill detail
      if (pathname.startsWith('/api/skill/') && request.method === 'GET') {
        try {
          const skillName = decodeURIComponent(pathname.replace('/api/skill/', ''));
          if (!isValidItemName(skillName)) {
            return jsonResponse({ success: false, error: 'Invalid skill name' }, 400);
          }
          const scope = url.searchParams.get('scope') || 'project';
          const queryAgentDir = url.searchParams.get('agentDir');

          // Use explicit agentDir if provided for project scope
          const { skillsDir } = getProjectBaseDirs(queryAgentDir);
          const baseDir = scope === 'user' ? userSkillsBaseDir : skillsDir;
          const skillPath = join(baseDir, skillName, 'SKILL.md');

          if (!existsSync(skillPath)) {
            return jsonResponse({ success: false, error: 'Skill not found' }, 404);
          }

          const content = readFileSync(skillPath, 'utf-8');
          const { frontmatter, body } = parseFullSkillContent(content);
          const systemOwned = scope === 'user' && isSystemSkillName(skillName);
          const required = scope === 'user' && isRequiredSystemSkill(skillName.toLowerCase());

          return jsonResponse({
            success: true,
            skill: {
              name: frontmatter.name || skillName,
              folderName: skillName,
              path: skillPath,
              scope,
              systemOwned,
              required,
              frontmatter,
              body,
            }
          });
        } catch (error) {
          console.error('[api/skill] Error:', error);
          return jsonResponse(
            { success: false, error: error instanceof Error ? error.message : 'Failed to get skill' },
            500
          );
        }
      }

      // PUT /api/skill/:name - Update skill (with optional folder rename)
      if (pathname.startsWith('/api/skill/') && request.method === 'PUT') {
        try {
          const skillName = decodeURIComponent(pathname.replace('/api/skill/', ''));
          if (!isValidItemName(skillName)) {
            return jsonResponse({ success: false, error: 'Invalid skill name' }, 400);
          }
          const payload = await request.json() as {
            scope: 'user' | 'project';
            frontmatter: Partial<SkillFrontmatter>;
            body: string;
            newFolderName?: string; // Optional: rename folder if provided
            agentDir?: string; // Optional: explicit project directory
          };

          // Use explicit agentDir if provided for project scope
          const { skillsDir } = getProjectBaseDirs(payload.agentDir || null);
          const baseDir = payload.scope === 'user' ? userSkillsBaseDir : skillsDir;
          let currentFolderName = skillName;
          let skillDir = join(baseDir, currentFolderName);
          let skillPath = join(skillDir, 'SKILL.md');

          if (payload.scope === 'user' && isSystemSkillName(skillName)) {
            return jsonResponse({
              success: false,
              code: 'SYSTEM_SKILL_READ_ONLY',
              error: 'System Skill is read-only',
            }, 409);
          }
          if (!existsSync(skillPath)) {
            return jsonResponse({ success: false, error: 'Skill not found' }, 404);
          }

          // Handle folder rename if newFolderName is provided and different
          if (payload.newFolderName && payload.newFolderName !== currentFolderName) {
            const newFolderName = payload.newFolderName;

            // Validate new folder name
            if (!isValidItemName(newFolderName)) {
              return jsonResponse({ success: false, error: 'Invalid new folder name' }, 400);
            }

            const newSkillDir = join(baseDir, newFolderName);

            // Check for conflict
            if (existsSync(newSkillDir)) {
              return jsonResponse({ success: false, error: `技能文件夹 "${newFolderName}" 已存在，请使用其他名称` }, 409);
            }

            // Atomic-like operation: prepare content first, then rename
            // If rename fails, nothing is lost. If write fails after rename, folder is renamed but content unchanged.
            const content = serializeSkillContent(payload.frontmatter, payload.body);

            // Rename the folder
            renameSync(skillDir, newSkillDir);
            skillDir = newSkillDir;
            skillPath = join(skillDir, 'SKILL.md');
            currentFolderName = newFolderName;

            // Write content to new location
            writeFileSync(skillPath, content, 'utf-8');

            // User skill renamed — bump generation + re-sync to fix old dangling symlink + create new one
            if (payload.scope === 'user') {
              bumpSkillsGeneration();
              if (agentDir) { syncProjectUserConfig(agentDir); }
            }
            return jsonResponse({
              success: true,
              path: skillPath,
              folderName: currentFolderName,
              fullPath: skillDir
            });
          }

          // No rename, just update content
          const content = serializeSkillContent(payload.frontmatter, payload.body);
          writeFileSync(skillPath, content, 'utf-8');

          return jsonResponse({
            success: true,
            path: skillPath,
            folderName: currentFolderName,
            fullPath: skillDir
          });
        } catch (error) {
          console.error('[api/skill] Error:', error);
          return jsonResponse(
            { success: false, error: error instanceof Error ? error.message : 'Failed to update skill' },
            500
          );
        }
      }

      // DELETE /api/skill/:name - Delete skill
      if (pathname.startsWith('/api/skill/') && request.method === 'DELETE') {
        try {
          const skillName = decodeURIComponent(pathname.replace('/api/skill/', ''));
          if (!isValidItemName(skillName)) {
            return jsonResponse({ success: false, error: 'Invalid skill name' }, 400);
          }
          const scope = url.searchParams.get('scope') || 'project';
          const queryAgentDir = url.searchParams.get('agentDir');

          // Use explicit agentDir if provided for project scope
          const { skillsDir } = getProjectBaseDirs(queryAgentDir);
          const baseDir = scope === 'user' ? userSkillsBaseDir : skillsDir;
          const skillDir = join(baseDir, skillName);

          if (scope === 'user' && isSystemSkillName(skillName)) {
            return jsonResponse({
              success: false,
              code: 'SYSTEM_SKILL_READ_ONLY',
              error: 'System Skill is read-only',
            }, 409);
          }
          if (!existsSync(skillDir)) {
            return jsonResponse({ success: false, error: 'Skill not found' }, 404);
          }

          rmSync(skillDir, { recursive: true, force: true });
          // User skill deleted — bump generation + re-sync to remove dangling symlinks
          if (scope === 'user') {
            bumpSkillsGeneration();
            if (agentDir) { syncProjectUserConfig(agentDir); }
          }
          return jsonResponse({ success: true });
        } catch (error) {
          console.error('[api/skill] Error:', error);
          return jsonResponse(
            { success: false, error: error instanceof Error ? error.message : 'Failed to delete skill' },
            500
          );
        }
      }

      // POST /api/skill/copy-to-global - Copy a project skill to global (~/.myagents/skills/)
      // NOTE: This route MUST be before /api/skill/:name to avoid being captured by the wildcard
      if (pathname === '/api/skill/copy-to-global' && request.method === 'POST') {
        try {
          const { folderName } = await request.json() as { folderName: string };
          if (!folderName || typeof folderName !== 'string' || !isValidItemName(folderName)) {
            return jsonResponse({ success: false, error: 'Invalid folderName' }, 400);
          }

          // Validate project skills directory
          if (!projectSkillsBaseDir) {
            return jsonResponse({ success: false, error: '当前没有项目工作目录' }, 400);
          }

          const srcDir = join(projectSkillsBaseDir, folderName);
          if (!existsSync(srcDir)) {
            return jsonResponse({ success: false, error: '项目技能不存在' }, 404);
          }

          // Check SKILL.md exists in source
          if (!existsSync(join(srcDir, 'SKILL.md'))) {
            return jsonResponse({ success: false, error: '项目技能缺少 SKILL.md' }, 400);
          }

          // Check if already exists in global
          const destDir = join(userSkillsBaseDir, folderName);
          if (existsSync(destDir)) {
            return jsonResponse({ success: false, error: '全局技能中已存在同名技能' }, 409);
          }

          // Ensure global skills directory exists
          ensureDirSync(userSkillsBaseDir);

          // Copy the skill folder — async variant so /health stays responsive
          // while large skills copy (see copyDirRecursive doc).
          await copyDirRecursive(srcDir, destDir, '[api/skill/copy-to-global]');

          // Bump generation + sync symlinks into project
          bumpSkillsGeneration();
          if (currentAgentDir) { syncProjectUserConfig(currentAgentDir); }

          return jsonResponse({ success: true, folderName });
        } catch (error) {
          console.error('[api/skill/copy-to-global] Error:', error);
          return jsonResponse(
            { success: false, error: error instanceof Error ? error.message : 'Failed to copy skill to global' },
            500
          );
        }
      }

      // POST /api/skill/create - Create new skill
      if (pathname === '/api/skill/create' && request.method === 'POST') {
        try {
          const payload = await request.json() as {
            name: string;
            scope: 'user' | 'project';
            description?: string;
            agentDir?: string; // Optional: explicit project directory
          };

          if (!payload.name) {
            return jsonResponse({ success: false, error: 'Name is required' }, 400);
          }

          // Sanitize name for folder (supports Unicode)
          const folderName = sanitizeFolderName(payload.name);
          // Use explicit agentDir if provided for project scope
          const { skillsDir } = getProjectBaseDirs(payload.agentDir || null);
          const baseDir = payload.scope === 'user' ? userSkillsBaseDir : skillsDir;
          const skillDir = join(baseDir, folderName);

          if (existsSync(skillDir)) {
            return jsonResponse({ success: false, error: 'Skill already exists' }, 409);
          }

          // Create directory structure
          ensureDirSync(skillDir);

          // Create SKILL.md with default content
          const frontmatter: Partial<SkillFrontmatter> = {
            name: payload.name,
            description: payload.description || `Description for ${payload.name}`,
          };
          const body = `# ${payload.name}\n\nDescribe your skill instructions here.`;
          const content = serializeSkillContent(frontmatter, body);

          const skillPath = join(skillDir, 'SKILL.md');
          writeFileSync(skillPath, content, 'utf-8');

          // New user skill — bump generation so Tab Sidecars re-sync symlinks
          if (payload.scope === 'user') {
            bumpSkillsGeneration();
            if (agentDir) { syncProjectUserConfig(agentDir); }
          }
          return jsonResponse({ success: true, path: skillPath, folderName });
        } catch (error) {
          console.error('[api/skill/create] Error:', error);
          return jsonResponse(
            { success: false, error: error instanceof Error ? error.message : 'Failed to create skill' },
            500
          );
        }
      }

      // POST /api/skill/upload - Upload skill from file (.zip, .skill, .md)
      if (pathname === '/api/skill/upload' && request.method === 'POST') {
        try {
          const payload = await request.json() as {
            filename: string;
            content: string; // Base64 encoded file content
            scope: 'user' | 'project';
            /**
             * Optional explicit folder name. Bypasses heuristic derivation from
             * filename / frontmatter. Required when uploading a bare `SKILL.md`
             * file — see `.md` branch below.
             */
            folderName?: string;
          };

          if (!payload.filename || !payload.content) {
            return jsonResponse({ success: false, error: 'Filename and content are required' }, 400);
          }

          const ext = extname(payload.filename).toLowerCase();
          const baseDir = payload.scope === 'user' ? userSkillsBaseDir : projectSkillsBaseDir;

          // Validate target directory is available
          if (!baseDir) {
            return jsonResponse({ success: false, error: '请先设置工作目录' }, 400);
          }

          // Decode base64 content to buffer
          const fileBuffer = Buffer.from(payload.content, 'base64');

          // Helper: Try to extract name from SKILL.md frontmatter only.
          // Scope: `.zip` / `.skill` branch. Archives already have stronger
          // fallbacks (top-level directory, then filename stem) — we don't want
          // a body `# heading` to silently override them.
          const extractFrontmatterName = (content: string): string | null => {
            try {
              const parsed = parseFullSkillContent(content);
              if (parsed.frontmatter.name) {
                return parsed.frontmatter.name;
              }
            } catch {
              // Ignore parse errors
            }
            return null;
          };

          // Helper used only by the `.md` branch. Adds the first `# heading`
          // fallback so bare SKILL.md uploads without frontmatter `name:` can
          // still yield a meaningful directory name instead of the reserved
          // "SKILL" filename stem.
          const extractNameForMdUpload = (content: string): string | null => {
            try {
              const { name } = parseSkillFrontmatter(content);
              return name ?? null;
            } catch {
              return null;
            }
          };

          // `SKILL.md` is the convention-reserved filename inside every skill
          // folder — it identifies the file's role, not the skill's identity.
          // Using its stem as a folder-name fallback collapses every distinct
          // upload onto the same directory (issue #96).
          const isReservedSkillStem = (stem: string): boolean => /^skill$/i.test(stem);

          if (ext === '.zip' || ext === '.skill') {
            // Handle zip/skill files - extract to skills directory
            try {
              const { default: AdmZip } = await import('adm-zip');
              const zip = new AdmZip(fileBuffer);
              const entries = zip.getEntries();

              // Find the root folder name from zip (or use filename without extension)
              let rootFolderName = basename(payload.filename, ext);

              // Check if zip has a single root directory
              const topLevelDirs = new Set<string>();
              for (const entry of entries) {
                const parts = entry.entryName.split('/');
                if (parts[0] && parts[0] !== '__MACOSX') {
                  topLevelDirs.add(parts[0]);
                }
              }

              // If zip has a single root folder, use that as default folder name
              if (topLevelDirs.size === 1) {
                rootFolderName = Array.from(topLevelDirs)[0];
              }

              // Try to find and parse SKILL.md to get the name from frontmatter
              for (const entry of entries) {
                const entryName = entry.entryName.toLowerCase();
                if (entryName.endsWith('skill.md') && !entry.isDirectory) {
                  const mdContent = entry.getData().toString('utf-8');
                  const nameFromContent = extractFrontmatterName(mdContent);
                  if (nameFromContent) {
                    rootFolderName = nameFromContent;
                    break;
                  }
                }
              }

              // Sanitize folder name (supports Unicode)
              const folderName = sanitizeFolderName(rootFolderName);
              const skillDir = join(baseDir, folderName);

              if (existsSync(skillDir)) {
                return jsonResponse({ success: false, error: `技能 "${folderName}" 已存在` }, 409);
              }

              // Create skill directory
              ensureDirSync(skillDir);

              // Extract files, handling nested structure
              for (const entry of entries) {
                // Skip __MACOSX folder and directory entries
                if (entry.entryName.startsWith('__MACOSX') || entry.isDirectory) continue;

                // Calculate target path - if zip has root folder, strip it
                let targetPath = entry.entryName;
                if (topLevelDirs.size === 1) {
                  const parts = targetPath.split('/');
                  parts.shift(); // Remove root folder
                  targetPath = parts.join('/');
                }

                if (!targetPath) continue;

                const fullPath = resolve(join(skillDir, targetPath));
                // Zip-Slip protection: resolved path must stay within skillDir
                if (!fullPath.startsWith(skillDir + sep) && fullPath !== skillDir) {
                  console.warn(`[api/skill/upload] Blocked Zip-Slip path: ${entry.entryName}`);
                  continue;
                }
                const dir = dirname(fullPath);

                // Create subdirectories if needed
                if (!existsSync(dir)) {
                  ensureDirSync(dir);
                }

                // Write file
                writeFileSync(fullPath, entry.getData());
              }

              if (payload.scope === 'user') {
                bumpSkillsGeneration();
                if (agentDir) { syncProjectUserConfig(agentDir); }
              }
              return jsonResponse({
                success: true,
                folderName,
                path: skillDir,
                message: `已成功导入技能 "${folderName}"`
              });

            } catch (zipError) {
              console.error('[api/skill/upload] Zip extraction error:', zipError);
              return jsonResponse(
                { success: false, error: '无法解压文件，请确保是有效的 zip 文件' },
                400
              );
            }

          } else if (ext === '.md') {
            // Handle .md files - parse content and create folder
            const mdContent = fileBuffer.toString('utf-8');
            const mdFilename = basename(payload.filename, '.md');

            // Folder-name priority: explicit payload.folderName → frontmatter.name
            // (or first `# heading`) → filename stem, but NEVER the reserved stem
            // "SKILL" (the convention filename for every skill's definition file).
            const nameFromContent = extractNameForMdUpload(mdContent);
            const fallbackFromFilename = isReservedSkillStem(mdFilename) ? null : mdFilename;
            const rawFolderName = payload.folderName || nameFromContent || fallbackFromFilename;

            if (!rawFolderName) {
              return jsonResponse(
                {
                  success: false,
                  error:
                    '无法确定技能目录名：上传文件名为 SKILL.md 且正文缺少可用标识。请任选其一：在 frontmatter 中添加 name 字段、在正文添加 `# <技能名>` 标题、或在请求中提供 folderName 参数。',
                },
                400,
              );
            }

            const folderName = sanitizeFolderName(rawFolderName);
            const skillDir = join(baseDir, folderName);

            if (existsSync(skillDir)) {
              return jsonResponse({ success: false, error: `技能 "${folderName}" 已存在` }, 409);
            }

            // Create skill directory
            ensureDirSync(skillDir);

            // Write the md file as SKILL.md
            const skillPath = join(skillDir, 'SKILL.md');
            writeFileSync(skillPath, fileBuffer);

            if (payload.scope === 'user') {
              bumpSkillsGeneration();
              if (agentDir) { syncProjectUserConfig(agentDir); }
            }
            return jsonResponse({
              success: true,
              folderName,
              path: skillPath,
              message: `已成功导入技能 "${folderName}"`
            });

          } else {
            return jsonResponse(
              { success: false, error: '不支持的文件类型，请上传 .zip、.skill 或 .md 文件' },
              400
            );
          }

        } catch (error) {
          console.error('[api/skill/upload] Error:', error);
          return jsonResponse(
            { success: false, error: error instanceof Error ? error.message : 'Failed to upload skill' },
            500
          );
        }
      }

      // POST /api/skill/import-folder - Import skill from a local folder path (Tauri only)
      if (pathname === '/api/skill/import-folder' && request.method === 'POST') {
        try {
          const payload = await request.json() as {
            folderPath: string;
            scope: 'user' | 'project';
          };

          if (!payload.folderPath) {
            return jsonResponse({ success: false, error: 'Folder path is required' }, 400);
          }

          const sourcePath = payload.folderPath;
          const baseDir = payload.scope === 'user' ? userSkillsBaseDir : projectSkillsBaseDir;

          // Validate target directory is available
          if (!baseDir) {
            return jsonResponse({ success: false, error: '请先设置工作目录' }, 400);
          }

          // Validate source folder exists
          if (!existsSync(sourcePath)) {
            return jsonResponse({ success: false, error: '指定的文件夹不存在' }, 400);
          }

          // Check if it's a directory
          try {
            const stats = statSync(sourcePath);
            if (!stats.isDirectory()) {
              return jsonResponse({ success: false, error: '指定的路径不是文件夹' }, 400);
            }
          } catch {
            return jsonResponse({ success: false, error: '无法读取文件夹信息' }, 400);
          }

          // Check for SKILL.md at root
          const skillMdPath = join(sourcePath, 'SKILL.md');
          if (!existsSync(skillMdPath)) {
            return jsonResponse({ success: false, error: '文件夹中未找到 SKILL.md 文件' }, 400);
          }

          // Read SKILL.md to get the skill name
          const skillMdContent = readFileSync(skillMdPath, 'utf-8');
          let folderName = basename(sourcePath);

          // Try to extract name from SKILL.md frontmatter
          try {
            const parsed = parseFullSkillContent(skillMdContent);
            if (parsed.frontmatter.name) {
              folderName = parsed.frontmatter.name;
            }
          } catch {
            // Use folder name as fallback
          }

          // Sanitize folder name
          folderName = sanitizeFolderName(folderName);
          const targetDir = join(baseDir, folderName);

          // Check if skill already exists
          if (existsSync(targetDir)) {
            return jsonResponse({ success: false, error: `技能 "${folderName}" 已存在` }, 409);
          }

          // Copy folder recursively — async so the sidecar's /health probe
          // stays responsive during large imports (see copyDirRecursive doc).
          // Keeps the hidden-file / __MACOSX filter that distinguishes this
          // path from the bulk-sync variant.
          const copyImportedSkillDir = async (src: string, dest: string): Promise<void> => {
            await ensureDir(dest);
            const entries = await readdirAsync(src, { withFileTypes: true });
            for (const entry of entries) {
              if (entry.name.startsWith('.') || entry.name === '__MACOSX') continue;
              if (entry.isSymbolicLink()) {
                console.warn(`[api/skill/import-folder] Skipping symlink: ${join(src, entry.name)}`);
                continue;
              }
              const srcPath = join(src, entry.name);
              const destPath = join(dest, entry.name);
              if (entry.isDirectory()) {
                await copyImportedSkillDir(srcPath, destPath);
              } else {
                await copyFileAsync(srcPath, destPath);
              }
            }
          };

          await copyImportedSkillDir(sourcePath, targetDir);

          if (payload.scope === 'user') {
            bumpSkillsGeneration();
            if (agentDir) { syncProjectUserConfig(agentDir); }
          }
          return jsonResponse({
            success: true,
            folderName,
            path: targetDir,
            message: `已成功导入技能 "${folderName}"`
          });

        } catch (error) {
          console.error('[api/skill/import-folder] Error:', error);
          return jsonResponse(
            { success: false, error: error instanceof Error ? error.message : 'Failed to import skill folder' },
            500
          );
        }
      }

      // POST /api/skill/export-from-url - Resolve a GitHub/raw/npx skill source
      // and stage one or more canonical zip packages for Space publishing.
      //
      // This deliberately does not write to ~/.myagents/skills or a workspace.
      // The renderer still hands the staged zip path to the Rust Space command,
      // so Space auth and cloud mutations remain owned by Tauri.
      if (pathname === '/api/skill/export-from-url' && request.method === 'POST') {
        try {
          const payload = await request.json() as {
            url: string;
            confirmedSelection?: {
              pluginName?: string;
              folderNames?: string[];
            };
          };

          if (!payload.url || typeof payload.url !== 'string') {
            return jsonResponse({ success: false, error: 'url 参数必填' }, 400);
          }

          let resolved;
          try {
            resolved = resolveSkillUrl(payload.url);
          } catch (err) {
            return jsonResponse(
              { success: false, error: err instanceof Error ? err.message : '链接解析失败' },
              400,
            );
          }

          let tree;
          if (resolved.kind === 'local') {
            return jsonResponse(
              { success: false, error: '本地 Skill 来源只支持安装，不能直接作为 Space 发布来源' },
              400,
            );
          }
          try {
            tree = await fetchSkillZip(resolved);
          } catch (err) {
            const statusCode = err instanceof TarballFetchError ? err.statusCode : 500;
            return jsonResponse(
              { success: false, error: err instanceof Error ? err.message : '下载失败' },
              statusCode,
            );
          }

          const analysis = analyseTree(tree, resolved);
          if (analysis.mode === 'empty') {
            return jsonResponse({ success: false, error: analysis.reason }, 422);
          }

          if (payload.confirmedSelection) {
            let chosen: SkillCandidate[];
            if (analysis.mode === 'marketplace') {
              const plugin = analysis.plugins.find(p => p.name === payload.confirmedSelection!.pluginName);
              if (!plugin) {
                return jsonResponse({ success: false, error: '指定的插件不存在' }, 400);
              }
              const wanted = new Set(
                (payload.confirmedSelection.folderNames ?? []).map(n => sanitizeFolderName(n)),
              );
              chosen = wanted.size > 0
                ? plugin.skills.filter(s => wanted.has(sanitizeFolderName(s.suggestedFolderName)))
                : plugin.skills;
            } else if (analysis.mode === 'multi') {
              const wanted = new Set(
                (payload.confirmedSelection.folderNames ?? []).map(n => sanitizeFolderName(n)),
              );
              chosen = analysis.candidates.filter(s => wanted.has(sanitizeFolderName(s.suggestedFolderName)));
            } else {
              chosen = [analysis.skill];
            }

            if (chosen.length === 0) {
              return jsonResponse({ success: false, error: '未选择任何 skill' }, 400);
            }

            const packages = await writeSpaceSkillExportPackages(tree, resolved, chosen);
            if (packages.length === 0) {
              return jsonResponse({ success: false, error: '未找到可发布的文件' }, 500);
            }

            return jsonResponse({
              success: true,
              mode: 'exported',
              packages,
              sourceUrl: tree.sourceUrl,
              effectiveRef: tree.effectiveRef,
            });
          }

          if (analysis.mode === 'marketplace') {
            return jsonResponse({
              success: true,
              mode: 'marketplace',
              preview: {
                marketplaceName: analysis.marketplaceName,
                marketplaceDescription: analysis.marketplaceDescription,
                plugins: analysis.plugins.map(p => ({
                  name: p.name,
                  description: p.description,
                  skills: p.skills.map(s => ({
                    suggestedFolderName: sanitizeFolderName(s.suggestedFolderName),
                    name: s.name,
                    description: s.description,
                    hasDangerousTools: s.hasDangerousTools,
                    rootPath: s.rootPath,
                  })),
                })),
              },
              sourceUrl: tree.sourceUrl,
              effectiveRef: tree.effectiveRef,
            });
          }

          if (analysis.mode === 'multi') {
            return jsonResponse({
              success: true,
              mode: 'multi',
              preview: {
                candidates: analysis.candidates.map(s => ({
                  suggestedFolderName: sanitizeFolderName(s.suggestedFolderName),
                  name: s.name,
                  description: s.description,
                  hasDangerousTools: s.hasDangerousTools,
                  rootPath: s.rootPath,
                })),
              },
              sourceUrl: tree.sourceUrl,
              effectiveRef: tree.effectiveRef,
            });
          }

          const packages = await writeSpaceSkillExportPackages(tree, resolved, [analysis.skill]);
          if (packages.length === 0) {
            return jsonResponse({ success: false, error: '未找到可发布的文件' }, 500);
          }

          return jsonResponse({
            success: true,
            mode: 'exported',
            packages,
            sourceUrl: tree.sourceUrl,
            effectiveRef: tree.effectiveRef,
          });
        } catch (error) {
          console.error('[api/skill/export-from-url] Error:', error);
          return jsonResponse(
            { success: false, error: error instanceof Error ? error.message : 'Export failed' },
            500,
          );
        }
      }

      // POST /api/skill/install-from-url - Install from GitHub, HTTPS zip, or a local source.
      // Two-step flow: first call analyses and may return a preview for the user to confirm;
      // second call (with confirmedSelection) re-fetches and writes the chosen skills.
      if (pathname === '/api/skill/install-from-url' && request.method === 'POST') {
        try {
          const payload = await request.json() as {
            url: string;
            scope: 'user' | 'project';
            /** Analyse only. Never publish even for an unambiguous single Skill. */
            previewOnly?: boolean;
            confirmedSelection?: {
              pluginName?: string;
              folderNames?: string[];
              overwrite?: string[];
              renames?: Record<string, string>;
            };
          };

          if (!payload.url || typeof payload.url !== 'string') {
            return jsonResponse({ success: false, error: 'url 参数必填' }, 400);
          }
          const scope = payload.scope === 'project' ? 'project' : 'user';
          const baseDir = scope === 'user' ? userSkillsBaseDir : projectSkillsBaseDir;
          if (!baseDir) {
            return jsonResponse({ success: false, error: '请先设置工作目录' }, 400);
          }

          // 1. Resolve URL
          let resolved;
          try {
            resolved = resolveSkillUrl(payload.url);
          } catch (err) {
            return jsonResponse(
              { success: false, error: err instanceof Error ? err.message : '链接解析失败' },
              400,
            );
          }

          // 2. Read/download + extract into the same immutable in-memory tree
          let tree;
          try {
            tree = await loadSkillTree(resolved);
          } catch (err) {
            const statusCode = err instanceof SkillSourceLoadError ? err.statusCode : 500;
            return jsonResponse(
              { success: false, error: err instanceof Error ? err.message : '读取 Skill 来源失败' },
              statusCode,
            );
          }

          // 3. Analyse
          const analysis = analyseTree(tree, resolved);

          if (analysis.mode === 'empty') {
            return jsonResponse({ success: false, error: analysis.reason }, 422);
          }

          if (payload.previewOnly && payload.confirmedSelection) {
            return jsonResponse(
              { success: false, error: 'previewOnly 不能与 confirmedSelection 同时使用' },
              400,
            );
          }

          // 4. Compute existing folder conflicts for a given candidate list
          const checkConflicts = (candidates: SkillCandidate[]) => {
            const conflicts: Array<{ suggestedFolderName: string; name: string }> = [];
            for (const cand of candidates) {
              const folder = sanitizeFolderName(cand.suggestedFolderName);
              if (pathEntryExistsNoFollow(join(baseDir, folder))) {
                conflicts.push({ suggestedFolderName: folder, name: cand.name });
              }
            }
            return conflicts;
          };

          // ---------- Step B: confirmedSelection provided — write to disk ----------
          if (payload.confirmedSelection) {
            const overwrite = new Set(
              (payload.confirmedSelection.overwrite ?? []).map(name => sanitizeFolderName(name)),
            );
            const renames = payload.confirmedSelection.renames ?? {};

            // Determine which candidates were chosen
            let chosen: SkillCandidate[];
            if (analysis.mode === 'marketplace') {
              const plugin = analysis.plugins.find(p => p.name === payload.confirmedSelection!.pluginName);
              if (!plugin) {
                return jsonResponse({ success: false, error: '指定的插件不存在' }, 400);
              }
              const wanted = new Set(
                (payload.confirmedSelection.folderNames ?? []).map(n => sanitizeFolderName(n)),
              );
              chosen = wanted.size > 0
                ? plugin.skills.filter(s => wanted.has(sanitizeFolderName(s.suggestedFolderName)))
                : plugin.skills;
            } else if (analysis.mode === 'multi') {
              const wanted = new Set(
                (payload.confirmedSelection.folderNames ?? []).map(n => sanitizeFolderName(n)),
              );
              chosen = analysis.candidates.filter(
                s => wanted.has(sanitizeFolderName(s.suggestedFolderName)),
              );
              if (chosen.length === 0) {
                return jsonResponse({ success: false, error: '未选择任何 skill' }, 400);
              }
            } else {
              chosen = [analysis.skill];
            }

            // ---------- Pre-validation before ANY disk writes ----------
            // Compute the final target folder name for every chosen skill,
            // honoring renames. Then check for:
            //   (1) duplicates within the chosen set (two skills collapsing to
            //       the same folder name — usually via frontmatter.name collision)
            //   (2) existing folders that aren't in overwrite
            //   (3) rename targets that collide with existing folders.
            // The publisher repeats conflict checks under the cross-process
            // lock; this pass exists for precise request-level diagnostics.
            const plan: Array<{ cand: SkillCandidate; folderName: string; overwrite: boolean }> = [];
            const seenTargets = new Set<string>();
            for (const cand of chosen) {
              const originalName = sanitizeFolderName(cand.suggestedFolderName);
              const renameTo = renames[originalName] ?? renames[cand.suggestedFolderName];
              const folderName = renameTo ? sanitizeFolderName(renameTo) : originalName;

              const collisionKey = skillTargetCollisionKey(folderName);
              if (seenTargets.has(collisionKey)) {
                return jsonResponse(
                  {
                    success: false,
                    error: `多个 skill 解析到同一个文件夹名 "${folderName}"，请使用 renames 指定不同名称`,
                    conflict: true,
                    conflictFolder: folderName,
                  },
                  409,
                );
              }
              seenTargets.add(collisionKey);

              // If renamed, the rename target must not already exist on disk
              // (the user's original `overwrite` set was keyed on the original
              // name, not the rename target).
              if (renameTo && pathEntryExistsNoFollow(join(baseDir, folderName))) {
                return jsonResponse(
                  {
                    success: false,
                    error: `重命名目标 "${folderName}" 已存在`,
                    conflict: true,
                    conflictFolder: folderName,
                  },
                  409,
                );
              }

              // Non-renamed conflict must be covered by `overwrite`
              if (
                !renameTo
                && pathEntryExistsNoFollow(join(baseDir, folderName))
                && !overwrite.has(folderName)
              ) {
                return jsonResponse(
                  {
                    success: false,
                    error: `技能 "${folderName}" 已存在`,
                    conflict: true,
                    conflictFolder: folderName,
                  },
                  409,
                );
              }

              plan.push({ cand, folderName, overwrite: !renameTo && overwrite.has(folderName) });
            }

            // ---------- Publish phase: stage complete dirs, then lock + rename ----------
            const installed = await publishSkillInstallPlan(
              baseDir,
              plan.map(({ cand, folderName, overwrite: shouldOverwrite }) => ({
                folderName,
                files: buildInstallPayloadForCandidate(tree, cand),
                name: cand.name,
                description: cand.description,
                overwrite: shouldOverwrite,
              })),
            );

            if (installed.length === 0) {
              return jsonResponse({ success: false, error: '没有任何 skill 被安装' }, 500);
            }

            if (scope === 'user') {
              bumpSkillsGeneration();
              if (agentDir) { syncProjectUserConfig(agentDir); }
            }

            return jsonResponse({
              success: true,
              mode: 'installed',
              installed,
              sourceUrl: tree.sourceUrl,
              effectiveRef: tree.effectiveRef,
            });
          }

          // ---------- Step A: no confirmedSelection — decide whether to auto-install or return preview ----------
          if (analysis.mode === 'marketplace') {
            return jsonResponse({
              success: true,
              mode: 'marketplace',
              preview: {
                marketplaceName: analysis.marketplaceName,
                marketplaceDescription: analysis.marketplaceDescription,
                plugins: analysis.plugins.map(p => ({
                  name: p.name,
                  description: p.description,
                  skills: p.skills.map(s => ({
                    suggestedFolderName: sanitizeFolderName(s.suggestedFolderName),
                    name: s.name,
                    description: s.description,
                    hasDangerousTools: s.hasDangerousTools,
                    conflict: pathEntryExistsNoFollow(join(baseDir, sanitizeFolderName(s.suggestedFolderName))),
                  })),
                })),
              },
              sourceUrl: tree.sourceUrl,
              effectiveRef: tree.effectiveRef,
            });
          }

          if (analysis.mode === 'multi') {
            return jsonResponse({
              success: true,
              mode: 'multi',
              preview: {
                candidates: analysis.candidates.map(s => ({
                  suggestedFolderName: sanitizeFolderName(s.suggestedFolderName),
                  name: s.name,
                  description: s.description,
                  hasDangerousTools: s.hasDangerousTools,
                  rootPath: s.rootPath,
                  conflict: pathEntryExistsNoFollow(join(baseDir, sanitizeFolderName(s.suggestedFolderName))),
                })),
              },
              sourceUrl: tree.sourceUrl,
              effectiveRef: tree.effectiveRef,
            });
          }

          // Single mode: check for conflict — if none, auto-install; if there is, return preview
          const cand = analysis.skill;
          const folderName = sanitizeFolderName(cand.suggestedFolderName);
          const conflicts = checkConflicts([cand]);

          if (conflicts.length > 0) {
            return jsonResponse({
              success: true,
              mode: 'single-conflict',
              preview: {
                skill: {
                  suggestedFolderName: folderName,
                  name: cand.name,
                  description: cand.description,
                  hasDangerousTools: cand.hasDangerousTools,
                  conflict: true,
                },
              },
              sourceUrl: tree.sourceUrl,
              effectiveRef: tree.effectiveRef,
            });
          }

          if (payload.previewOnly) {
            return jsonResponse({
              success: true,
              mode: 'single',
              preview: {
                skill: {
                  suggestedFolderName: folderName,
                  name: cand.name,
                  description: cand.description,
                  hasDangerousTools: cand.hasDangerousTools,
                  conflict: false,
                },
              },
              sourceUrl: tree.sourceUrl,
              effectiveRef: tree.effectiveRef,
            });
          }

          // Auto-install the single unambiguous skill
          const installed = await publishSkillInstallPlan(baseDir, [{
            folderName,
            files: buildInstallPayloadForCandidate(tree, cand),
            name: cand.name,
            description: cand.description,
            overwrite: false,
          }]);

          if (scope === 'user') {
            bumpSkillsGeneration();
            if (agentDir) { syncProjectUserConfig(agentDir); }
          }

          return jsonResponse({
            success: true,
            mode: 'installed',
            installed,
            sourceUrl: tree.sourceUrl,
            effectiveRef: tree.effectiveRef,
          });
        } catch (error) {
          console.error('[api/skill/install-from-url] Error:', error);
          return jsonResponse(
            { success: false, error: error instanceof Error ? error.message : 'Install failed' },
            error instanceof SkillInstallError ? error.statusCode : 500,
          );
        }
      }

      // ============= CLAUDE PLUGINS API (PRD 0.2.17) =============
      //
      // Plugin endpoints follow the "fixed names before wildcards" red-line
      // (CLAUDE.md): /list, /install, /uninstall, /toggle, /detail all
      // collapse to a single keyword segment so there's no `/:id` wildcard
      // collision. Detail-by-id intentionally uses a query parameter for the
      // same reason — keeps route matching unambiguous.

      // GET /api/plugin/list - list installed plugins with status
      if (pathname === '/api/cc-plugin/list' && request.method === 'GET') {
        try {
          const items = listInstalledPlugins();
          return jsonResponse({ success: true, plugins: items });
        } catch (error) {
          console.error('[api/plugin/list] Error:', error);
          return jsonResponse(
            { success: false, error: error instanceof Error ? error.message : 'List failed' },
            500,
          );
        }
      }

      // GET /api/plugin/detail?id=<plugin-id> - full manifest + component inventory
      if (pathname === '/api/cc-plugin/detail' && request.method === 'GET') {
        const id = url.searchParams.get('id');
        if (!id) return jsonResponse({ success: false, error: 'id 参数必填' }, 400);
        try {
          const item = getPluginDetail(id);
          if (!item) return jsonResponse({ success: false, error: '插件未安装' }, 404);
          return jsonResponse({ success: true, plugin: item });
        } catch (error) {
          console.error('[api/plugin/detail] Error:', error);
          return jsonResponse(
            { success: false, error: error instanceof Error ? error.message : 'Detail failed' },
            500,
          );
        }
      }

      // POST /api/cc-plugin/inspect - resolve + fetch + analyse WITHOUT
      // writing. Used by the install dialog to decide whether to show the
      // direct-install path or the multi-plugin picker (batch import).
      // Returns the analysis verbatim — multi-plugin mode carries per-
      // candidate manifest data so the picker can render name/version/desc.
      if (pathname === '/api/cc-plugin/inspect' && request.method === 'POST') {
        try {
          const body = (await request.json()) as { sourceUrl?: string };
          if (!body.sourceUrl || typeof body.sourceUrl !== 'string') {
            return jsonResponse({ success: false, error: 'sourceUrl 参数必填' }, 400);
          }
          const { inspectPluginSource } = await import('./plugins/store');
          const analysis = await inspectPluginSource(body.sourceUrl);
          return jsonResponse({ success: true, sourceUrl: body.sourceUrl, analysis });
        } catch (error) {
          const message = error instanceof Error ? error.message : 'Inspect failed';
          const status = error instanceof PluginStoreError ? error.statusCode : 500;
          if (status >= 500) {
            console.error('[api/cc-plugin/inspect] Error:', error);
          }
          return jsonResponse({ success: false, error: message }, status);
        }
      }

      // POST /api/cc-plugin/install - install from URL/path; broadcasts progress.
      // Optional `subPath` body param picks one candidate out of a
      // multi-plugin tree — used by the batch install loop in the picker UI.
      if (pathname === '/api/cc-plugin/install' && request.method === 'POST') {
        let installId: string | undefined;
        try {
          const body = (await request.json()) as {
            sourceUrl?: string;
            installId?: string;
            subPath?: string;
          };
          if (!body.sourceUrl || typeof body.sourceUrl !== 'string') {
            return jsonResponse({ success: false, error: 'sourceUrl 参数必填' }, 400);
          }
          installId = body.installId || crypto.randomUUID();
          const finalId = installId;
          broadcast('plugin:install-progress', {
            installId: finalId,
            phase: 'fetching',
            message: body.sourceUrl,
          });
          const { entry } = await installPlugin(body.sourceUrl, {
            onProgress: (phase, message) => {
              broadcast('plugin:install-progress', { installId: finalId, phase, message });
            },
            subPath: typeof body.subPath === 'string' && body.subPath ? body.subPath : undefined,
          });
          broadcast('plugin:install-progress', { installId: finalId, phase: 'done' });
          broadcast('plugins:changed', { reason: 'install' });
          await schedulePluginRestartLazy();
          return jsonResponse({ success: true, entry, installId: finalId });
        } catch (error) {
          const message = error instanceof Error ? error.message : 'Install failed';
          const status = error instanceof PluginStoreError ? error.statusCode : 500;
          if (installId) {
            broadcast('plugin:install-progress', { installId, phase: 'failed', error: message });
          }
          if (status >= 500) {
            console.error('[api/plugin/install] Error:', error);
          }
          return jsonResponse({ success: false, error: message }, status);
        }
      }

      // POST /api/plugin/uninstall - body { id, purgeData? }
      if (pathname === '/api/cc-plugin/uninstall' && request.method === 'POST') {
        try {
          const body = (await request.json()) as { id?: string; purgeData?: boolean };
          if (!body.id || typeof body.id !== 'string') {
            return jsonResponse({ success: false, error: 'id 参数必填' }, 400);
          }
          const { removed, warning } = await uninstallPlugin(body.id, { purgeData: !!body.purgeData });
          broadcast('plugins:changed', { reason: 'uninstall' });
          await schedulePluginRestartLazy();
          return jsonResponse({ success: true, removed, ...(warning ? { warning } : {}) });
        } catch (error) {
          const message = error instanceof Error ? error.message : 'Uninstall failed';
          const status = error instanceof PluginStoreError ? error.statusCode : 500;
          console.error('[api/plugin/uninstall] Error:', error);
          return jsonResponse({ success: false, error: message }, status);
        }
      }

      // POST /api/plugin/toggle - body { id, enabled }
      if (pathname === '/api/cc-plugin/toggle' && request.method === 'POST') {
        try {
          const body = (await request.json()) as { id?: string; enabled?: boolean };
          if (!body.id || typeof body.id !== 'string') {
            return jsonResponse({ success: false, error: 'id 参数必填' }, 400);
          }
          if (typeof body.enabled !== 'boolean') {
            return jsonResponse({ success: false, error: 'enabled 参数必填 (boolean)' }, 400);
          }
          // NOTE: this endpoint toggles the GLOBAL VISIBILITY gate
          // (AppConfig.enabledPlugins). It does NOT activate the plugin in
          // any workspace — per-workspace activation goes through
          // /api/cc-plugin/workspace-enable below. Settings panel uses
          // this; chat input / Agent settings use workspace-enable.
          const { entry, enabled } = await togglePlugin(body.id, body.enabled);
          broadcast('plugins:changed', { reason: 'toggle' });
          // Restart in case the toggle hid a plugin currently injected via
          // session override / Agent default — store filter skips it on
          // next options build.
          await schedulePluginRestartLazy();
          return jsonResponse({ success: true, entry, enabled });
        } catch (error) {
          const message = error instanceof Error ? error.message : 'Toggle failed';
          const status = error instanceof PluginStoreError ? error.statusCode : 500;
          if (status >= 500) {
            console.error('[api/cc-plugin/toggle] Error:', error);
          }
          return jsonResponse({ success: false, error: message }, status);
        }
      }

      // POST /api/cc-plugin/workspace-enable - body { workspacePath, enabledIds[] }
      // Sets the per-workspace plugin enable list (stored on Agent.enabledPluginIds).
      // Single source of truth shared by the Agent settings panel and the chat
      // input "插件" submenu — both UIs call this, then push to the active
      // sidecar via /api/cc-plugin/session-enable to take immediate effect.
      if (pathname === '/api/cc-plugin/workspace-enable' && request.method === 'POST') {
        try {
          const body = (await request.json()) as { workspacePath?: string; enabledIds?: string[] };
          if (!body.workspacePath || typeof body.workspacePath !== 'string') {
            return jsonResponse({ success: false, error: 'workspacePath 参数必填' }, 400);
          }
          if (!Array.isArray(body.enabledIds)) {
            return jsonResponse({ success: false, error: 'enabledIds 必须是 string[]' }, 400);
          }
          const ids = body.enabledIds.filter((s): s is string => typeof s === 'string');
          const { setWorkspaceEnabledPlugins } = await import('./plugins/store');
          const result = await setWorkspaceEnabledPlugins(body.workspacePath, ids);
          broadcast('plugins:changed', { reason: 'workspace-enable' });
          return jsonResponse({ success: true, ...result });
        } catch (error) {
          const message = error instanceof Error ? error.message : 'Workspace enable failed';
          const status = error instanceof PluginStoreError ? error.statusCode : 500;
          console.error('[api/cc-plugin/workspace-enable] Error:', error);
          return jsonResponse({ success: false, error: message }, status);
        }
      }

      // ============= COMMANDS MANAGEMENT API =============
      // GET /api/command-items - List all commands
      // Supports ?agentDir= for listing commands from a specific workspace (e.g. from Launcher)
      if (pathname === '/api/command-items' && request.method === 'GET') {
        try {
          const scope = url.searchParams.get('scope') || 'all';
          const queryAgentDir = url.searchParams.get('agentDir');
          const { commandsDir: effectiveCommandsDir } = getProjectBaseDirs(queryAgentDir);
          const commandItems: Array<{
            name: string;
            fileName: string;
            description: string;
            scope: 'user' | 'project';
            path: string;
            author?: string;
          }> = [];

          const scanCommands = (dir: string, scopeType: 'user' | 'project') => {
            if (!dir || !existsSync(dir)) return;
            try {
              const files = readdirSync(dir);
              for (const file of files) {
                if (!file.endsWith('.md')) continue;
                const filePath = join(dir, file);
                const content = readFileSync(filePath, 'utf-8');
                const { frontmatter } = parseFullCommandContent(content);
                const fileName = extractCommandName(file);
                commandItems.push({
                  name: frontmatter.name || fileName,  // Prefer frontmatter name
                  fileName,  // Always include actual file name for reference
                  description: frontmatter.description || '',
                  scope: scopeType,
                  path: filePath,
                  author: frontmatter.author,
                });
              }
            } catch (scanError) {
              console.warn(`[api/command-items] Error scanning ${scopeType} commands:`, scanError);
            }
          };

          const resolvedProjectCommandsDir = effectiveCommandsDir || projectCommandsBaseDir;
          if ((scope === 'all' || scope === 'project') && resolvedProjectCommandsDir) {
            scanCommands(resolvedProjectCommandsDir, 'project');
          }
          if (scope === 'all' || scope === 'user') {
            scanCommands(userCommandsBaseDir, 'user');
          }

          return jsonResponse({ success: true, commands: commandItems });
        } catch (error) {
          console.error('[api/command-items] Error:', error);
          return jsonResponse(
            { success: false, error: error instanceof Error ? error.message : 'Failed to list commands' },
            500
          );
        }
      }

      // GET /api/command-item/:name - Get command detail
      if (pathname.startsWith('/api/command-item/') && request.method === 'GET') {
        try {
          const cmdName = decodeURIComponent(pathname.replace('/api/command-item/', ''));
          if (!isValidItemName(cmdName)) {
            return jsonResponse({ success: false, error: 'Invalid command name' }, 400);
          }
          const scope = url.searchParams.get('scope') || 'project';
          const queryAgentDir = url.searchParams.get('agentDir');

          // Use explicit agentDir if provided for project scope
          const { commandsDir } = getProjectBaseDirs(queryAgentDir);
          const baseDir = scope === 'user' ? userCommandsBaseDir : commandsDir;
          const cmdPath = join(baseDir, `${cmdName}.md`);

          if (!existsSync(cmdPath)) {
            return jsonResponse({ success: false, error: 'Command not found' }, 404);
          }

          const content = readFileSync(cmdPath, 'utf-8');
          const { frontmatter, body } = parseFullCommandContent(content);

          return jsonResponse({
            success: true,
            command: {
              name: frontmatter.name || cmdName,  // Prefer frontmatter name over file name
              fileName: cmdName,  // Always return the actual file name for reference
              path: cmdPath,
              scope,
              frontmatter,
              body,
            }
          });
        } catch (error) {
          console.error('[api/command-item] Error:', error);
          return jsonResponse(
            { success: false, error: error instanceof Error ? error.message : 'Failed to get command' },
            500
          );
        }
      }

      // PUT /api/command-item/:name - Update command
      if (pathname.startsWith('/api/command-item/') && request.method === 'PUT') {
        try {
          const cmdName = decodeURIComponent(pathname.replace('/api/command-item/', ''));
          if (!isValidItemName(cmdName)) {
            return jsonResponse({ success: false, error: 'Invalid command name' }, 400);
          }
          const payload = await request.json() as {
            scope: 'user' | 'project';
            frontmatter: Partial<CommandFrontmatter>;
            body: string;
            agentDir?: string; // Optional: explicit project directory
            newFileName?: string; // Optional: rename file if provided
          };

          // Use explicit agentDir if provided for project scope
          const { commandsDir } = getProjectBaseDirs(payload.agentDir || null);
          const baseDir = payload.scope === 'user' ? userCommandsBaseDir : commandsDir;
          let currentFileName = cmdName;
          let cmdPath = join(baseDir, `${currentFileName}.md`);

          if (!existsSync(cmdPath)) {
            return jsonResponse({ success: false, error: 'Command not found' }, 404);
          }

          // Handle file rename if newFileName is provided and different
          if (payload.newFileName && payload.newFileName !== currentFileName) {
            const newFileName = payload.newFileName;

            // Validate new file name
            if (!isValidItemName(newFileName)) {
              return jsonResponse({ success: false, error: 'Invalid new file name' }, 400);
            }

            const newCmdPath = join(baseDir, `${newFileName}.md`);

            // Check for conflict
            if (existsSync(newCmdPath)) {
              return jsonResponse({ success: false, error: `指令文件 "${newFileName}.md" 已存在，请使用其他名称` }, 409);
            }

            // Atomic-like operation: prepare content first, then rename
            // If rename fails, nothing is lost. If write fails after rename, file is renamed but content unchanged.
            const content = serializeCommandContent(payload.frontmatter, payload.body);

            // Rename the file
            renameSync(cmdPath, newCmdPath);
            cmdPath = newCmdPath;
            currentFileName = newFileName;

            // Write content to new location
            writeFileSync(cmdPath, content, 'utf-8');

            // User command renamed — re-sync to fix old dangling symlink + create new one
            if (payload.scope === 'user' && agentDir) syncProjectUserConfig(agentDir);
            return jsonResponse({
              success: true,
              path: cmdPath,
              fileName: currentFileName
            });
          }

          // No rename, just update content
          const content = serializeCommandContent(payload.frontmatter, payload.body);
          writeFileSync(cmdPath, content, 'utf-8');

          return jsonResponse({
            success: true,
            path: cmdPath,
            fileName: currentFileName
          });
        } catch (error) {
          console.error('[api/command-item] Error:', error);
          return jsonResponse(
            { success: false, error: error instanceof Error ? error.message : 'Failed to update command' },
            500
          );
        }
      }

      // DELETE /api/command-item/:name - Delete command
      if (pathname.startsWith('/api/command-item/') && request.method === 'DELETE') {
        try {
          const cmdName = decodeURIComponent(pathname.replace('/api/command-item/', ''));
          if (!isValidItemName(cmdName)) {
            return jsonResponse({ success: false, error: 'Invalid command name' }, 400);
          }
          const scope = url.searchParams.get('scope') || 'project';
          const queryAgentDir = url.searchParams.get('agentDir');

          // Use explicit agentDir if provided for project scope
          const { commandsDir } = getProjectBaseDirs(queryAgentDir);
          const baseDir = scope === 'user' ? userCommandsBaseDir : commandsDir;
          const cmdPath = join(baseDir, `${cmdName}.md`);

          if (!existsSync(cmdPath)) {
            return jsonResponse({ success: false, error: 'Command not found' }, 404);
          }

          rmSync(cmdPath);
          // User command deleted — re-sync to remove dangling symlinks in project
          if (scope === 'user' && agentDir) syncProjectUserConfig(agentDir);
          return jsonResponse({ success: true });
        } catch (error) {
          console.error('[api/command-item] Error:', error);
          return jsonResponse(
            { success: false, error: error instanceof Error ? error.message : 'Failed to delete command' },
            500
          );
        }
      }

      // POST /api/command-item/create - Create new command
      if (pathname === '/api/command-item/create' && request.method === 'POST') {
        try {
          const payload = await request.json() as {
            name: string;
            scope: 'user' | 'project';
            description?: string;
          };

          if (!payload.name) {
            return jsonResponse({ success: false, error: 'Name is required' }, 400);
          }

          // Sanitize name for filename (supports Unicode characters like Chinese)
          const fileName = sanitizeFolderName(payload.name);
          const baseDir = payload.scope === 'user' ? userCommandsBaseDir : projectCommandsBaseDir;

          // Ensure directory exists
          if (!existsSync(baseDir)) {
            ensureDirSync(baseDir);
          }

          const cmdPath = join(baseDir, `${fileName}.md`);

          if (existsSync(cmdPath)) {
            return jsonResponse({ success: false, error: 'Command already exists' }, 409);
          }

          // Create command file with default content
          const frontmatter: Partial<CommandFrontmatter> = {
            name: payload.name,
            description: payload.description || '',
          };
          const body = `在这里编写指令的详细内容...`;
          const content = serializeCommandContent(frontmatter, body);

          writeFileSync(cmdPath, content, 'utf-8');

          // New user command — sync symlink into project so SDK can discover it
          if (payload.scope === 'user' && agentDir) syncProjectUserConfig(agentDir);
          return jsonResponse({ success: true, path: cmdPath, name: fileName });
        } catch (error) {
          console.error('[api/command-item/create] Error:', error);
          return jsonResponse(
            { success: false, error: error instanceof Error ? error.message : 'Failed to create command' },
            500
          );
        }
      }

      // ============= SUB-AGENTS API =============

      const userAgentsBaseDir = join(homeDir, '.myagents', 'agents');

      // Helper: Get project agents directory (supports explicit agentDir parameter)
      const getProjectAgentsDir = (queryAgentDir: string | null) => {
        if (queryAgentDir && !isValidAgentDir(queryAgentDir).valid) {
          queryAgentDir = null;
        }
        const effectiveAgentDir = queryAgentDir || currentAgentDir;
        const hasValidDir = effectiveAgentDir && existsSync(effectiveAgentDir);
        return hasValidDir ? join(effectiveAgentDir, '.claude', 'agents') : '';
      };

      // Validate an agent folderName accepted by GET/PUT/DELETE /api/agent/:name.
      //
      // Unlike `isValidItemName` (which rejects '/'), agents now use a
      // path-like identity for the 'nested' layout (e.g. `team/reviewer`).
      // Security rests on two things: each segment still flows through
      // `isValidItemName` (blocking '..', '\\', Windows reserved names,
      // control chars, reserved punctuation), and findAgent() only ever
      // returns real on-disk paths produced by scanAgents — the value we
      // receive is matched by string equality against scanned folderNames,
      // never concatenated into a path.
      const isValidAgentFolderName = (name: string): boolean => {
        if (!name || name.length > 512) return false;
        if (name.includes('\\')) return false;
        // eslint-disable-next-line no-control-regex -- explicit control-char ban for filename-like input
        if (/[\x00-\x1f\x7f]/.test(name)) return false;
        for (const seg of name.split('/')) {
          if (!seg || seg === '.' || seg === '..') return false;
          if (!isValidItemName(seg)) return false;
        }
        return true;
      };

      // GET /api/agents - List all agents (with scope filter)
      if (pathname === '/api/agents' && request.method === 'GET') {
        try {
          const scope = url.searchParams.get('scope') || 'all';
          const queryAgentDir = url.searchParams.get('agentDir');
          const projAgentsDir = getProjectAgentsDir(queryAgentDir);

          let agents: Array<{ name: string; description: string; scope: 'user' | 'project'; path: string; folderName: string }> = [];

          if ((scope === 'all' || scope === 'project') && projAgentsDir) {
            agents = agents.concat(scanAgents(projAgentsDir, 'project'));
          }
          if (scope === 'all' || scope === 'user') {
            agents = agents.concat(scanAgents(userAgentsBaseDir, 'user'));
          }

          return jsonResponse({ success: true, agents });
        } catch (error) {
          console.error('[api/agents] Error:', error);
          return jsonResponse(
            { success: false, error: error instanceof Error ? error.message : 'Failed to list agents' },
            500
          );
        }
      }

      // GET /api/agent/sync-check - Check if there are agents to sync from Claude Code
      // NOTE: Must be before /api/agent/:name to avoid wildcard capture
      //
      // Driven by `scanAgents()` so the three SDK-recognised layouts (folder /
      // flat / nested) are all counted — same rule the loader uses for runtime
      // discovery. Agents that Claude Code's SDK sees but that only have a
      // top-level `.md` file (flat) or a subdirectory path (nested) used to
      // silently disappear from the sync UI; now they're first-class.
      if (pathname === '/api/agent/sync-check' && request.method === 'GET') {
        try {
          const claudeAgentsDir = join(homeDir, '.claude', 'agents');
          if (!existsSync(claudeAgentsDir)) {
            return jsonResponse({ canSync: false, count: 0, folders: [] });
          }

          // scanAgents handles: junctions (via realpath), all 3 layouts,
          // frontmatter validation, dedup by folderName with layout priority.
          // Scope arg ('user') only affects the returned AgentItem.scope —
          // not the scan behavior.
          const claudeAgents = scanAgents(claudeAgentsDir, 'user');

          if (claudeAgents.length === 0) {
            return jsonResponse({ canSync: false, count: 0, folders: [] });
          }

          const myagentsAgents = scanAgents(userAgentsBaseDir, 'user');
          const myagentsSet = new Set(myagentsAgents.map(a => a.folderName));

          // folderName is the canonical agent identity (e.g. "code-reviewer"
          // for flat, "team/reviewer" for nested, "novels" for folder). The
          // client passes these back to sync-from-claude, and we re-validate
          // them against scanAgents output at that time — no raw filesystem
          // name is trusted across the request boundary.
          const allFolders = claudeAgents.map(a => a.folderName);
          const newFolders = claudeAgents.filter(a => !myagentsSet.has(a.folderName)).map(a => a.folderName);
          const conflictFolders = claudeAgents.filter(a => myagentsSet.has(a.folderName)).map(a => a.folderName);

          return jsonResponse({
            canSync: allFolders.length > 0,
            count: allFolders.length,
            folders: allFolders,
            newFolders,
            conflictFolders,
          });
        } catch (error) {
          console.error('[api/agent/sync-check] Error:', error);
          return jsonResponse({ canSync: false, count: 0, folders: [], error: error instanceof Error ? error.message : 'Check failed' }, 500);
        }
      }

      // POST /api/agent/sync-from-claude - Sync agents from Claude Code to MyAgents
      // NOTE: Must be before /api/agent/:name to avoid wildcard capture
      // Supports conflict handling: mode = 'skip' (default) | 'overwrite'
      //
      // Preserves the source agent's layout:
      //   folder  (.claude/agents/foo/foo.md)        → ~/.myagents/agents/foo/foo.md  + _meta.json
      //   flat    (.claude/agents/foo.md)            → ~/.myagents/agents/foo.md       (no _meta.json — flat has no home for it)
      //   nested  (.claude/agents/team/reviewer.md)  → ~/.myagents/agents/team/reviewer.md  (ditto)
      //
      // Why preserve instead of canonicalize to `folder`: `nested` folderNames
      // contain `/` (e.g. "team/reviewer"), which collapses ambiguously if
      // flattened — "team/reviewer" and just "reviewer" would collide. Keeping
      // the source layout is lossless + matches Claude Code's own storage
      // convention. `scanAgents()` (loader side) already reads all three.
      if (pathname === '/api/agent/sync-from-claude' && request.method === 'POST') {
        try {
          const payload = await request.json().catch(() => ({})) as { mode?: 'skip' | 'overwrite'; folders?: string[] };
          const conflictMode = payload.mode || 'skip';
          const selectedFolders = payload.folders; // Optional: sync only these specific folderNames

          const claudeAgentsDir = join(homeDir, '.claude', 'agents');
          if (!existsSync(claudeAgentsDir)) {
            return jsonResponse({ success: false, synced: 0, failed: 0, skipped: 0, overwritten: 0, error: 'Claude Code agents directory not found' }, 404);
          }

          // Enumerate via the same protocol-aligned scanner that sync-check uses.
          // Index by folderName so selectedFolders can only reach agents the
          // scanner actually saw — no raw-path injection across the boundary.
          const claudeAgents = scanAgents(claudeAgentsDir, 'user');
          const claudeByName = new Map(claudeAgents.map(a => [a.folderName, a]));

          const foldersToSync = selectedFolders
            ? selectedFolders.filter(f => claudeByName.has(f))
            : Array.from(claudeByName.keys());

          if (foldersToSync.length === 0) {
            return jsonResponse({ success: true, synced: 0, failed: 0, skipped: 0, overwritten: 0, message: 'No agents to sync' });
          }

          if (!existsSync(userAgentsBaseDir)) {
            ensureDirSync(userAgentsBaseDir);
          }

          let synced = 0;
          let failed = 0;
          let skipped = 0;
          let overwritten = 0;
          const errors: string[] = [];
          const conflicts: string[] = [];

          for (const folderName of foldersToSync) {
            const src = claudeByName.get(folderName);
            if (!src) continue;  // defensive, already filtered above

            try {
              // Conflict probe via the SAME scanner used for sync-check, so the
              // "conflict" decision is symmetric regardless of which layout the
              // existing agent lives in on our side (folder vs flat vs nested).
              const existing = findAgent(userAgentsBaseDir, 'user', folderName);
              if (existing) {
                if (conflictMode === 'skip') {
                  skipped++;
                  conflicts.push(folderName);
                  continue;
                }
                // Overwrite: delete the existing agent's own path, which may
                // be in a different layout than the source. `rm({ recursive,
                // force })` handles both file (flat/nested .md) and directory
                // (folder layout) targets. For folder layout we strip back to
                // the folder itself to avoid leaving a ghost _meta.json.
                const existingTarget = existing.layout === 'folder'
                  ? dirname(existing.path)  // the <folderName>/ directory
                  : existing.path;          // the .md file itself
                await rm(existingTarget, { recursive: true, force: true });
                overwritten++;
              }

              // Compute target path from the SOURCE's layout (preserve).
              // For folder layout, copy the whole source directory (may include
              // sibling resources like README.md, data files, etc.). For
              // flat/nested, it's a single-file copy.
              if (src.layout === 'folder') {
                const srcDir = dirname(src.path);
                const destDir = join(userAgentsBaseDir, folderName);
                await copyDirRecursive(srcDir, destDir, '[api/agent/sync-from-claude]');

                // Write _meta.json (only folder layout has a stable home for it).
                // Auto-generated from frontmatter.name so the UI shows a friendly
                // displayName and recognises the agent as synced via the
                // `claude-code-sync` author marker.
                const mdPath = join(destDir, `${folderName}.md`);
                const metaPath = join(destDir, '_meta.json');
                if (existsSync(mdPath) && !existsSync(metaPath)) {
                  try {
                    const content = readFileSync(mdPath, 'utf-8');
                    const { name: agentName } = parseAgentFrontmatter(content);
                    const meta = {
                      displayName: agentName || folderName,
                      author: 'claude-code-sync',
                      createdAt: new Date().toISOString(),
                      updatedAt: new Date().toISOString(),
                    };
                    writeFileSync(metaPath, JSON.stringify(meta, null, 2), 'utf-8');
                  } catch { /* _meta.json generation is optional */ }
                }
              } else {
                // flat or nested: single-file copy. For nested we need to
                // `ensureDir` the parent chain (e.g. "team/" for folderName
                // "team/reviewer"). For flat the parent is userAgentsBaseDir
                // which we already ensured above.
                //
                // folderName for flat is the stem ("foo" → "foo.md"); for
                // nested it's the POSIX stem path ("team/reviewer" →
                // "team/reviewer.md"). Joining with path.join naturally
                // produces the correct OS-specific path on Windows.
                const destPath = join(userAgentsBaseDir, `${folderName}.md`);
                await ensureDir(dirname(destPath));
                await copyFileAsync(src.path, destPath);
              }

              synced++;
            } catch (copyError) {
              failed++;
              errors.push(`${folderName}: ${copyError instanceof Error ? copyError.message : 'Unknown error'}`);
              console.error(`[api/agent/sync-from-claude] Failed to sync "${folderName}":`, copyError);
            }
          }

          return jsonResponse({
            success: true,
            synced,
            failed,
            skipped,
            overwritten,
            conflicts,
            errors: errors.length > 0 ? errors : undefined,
          });
        } catch (error) {
          console.error('[api/agent/sync-from-claude] Error:', error);
          return jsonResponse({ success: false, synced: 0, failed: 0, error: error instanceof Error ? error.message : 'Sync failed' }, 500);
        }
      }

      // POST /api/agent/create - Create new agent
      // NOTE: Must be before /api/agent/:name to avoid wildcard capture
      if (pathname === '/api/agent/create' && request.method === 'POST') {
        try {
          const payload = await request.json() as {
            name: string;
            scope: 'user' | 'project';
            description?: string;
            agentDir?: string;
          };

          if (!payload.name) {
            return jsonResponse({ success: false, error: 'Name is required' }, 400);
          }

          const folderName = sanitizeFolderName(payload.name);
          const agentsDir = getProjectAgentsDir(payload.agentDir || null);
          const baseDir = payload.scope === 'user' ? userAgentsBaseDir : agentsDir;

          if (!baseDir) {
            return jsonResponse({ success: false, error: '请先设置工作目录' }, 400);
          }

          const agentFolderDir = join(baseDir, folderName);
          if (existsSync(agentFolderDir)) {
            return jsonResponse({ success: false, error: 'Agent already exists' }, 409);
          }

          ensureDirSync(agentFolderDir);

          const frontmatter: Partial<AgentFrontmatter> = {
            name: payload.name,
            description: payload.description || `Description for ${payload.name}`,
          };
          const body = `# ${payload.name}\n\nDescribe your agent instructions here.`;
          const content = serializeAgentContent(frontmatter, body);

          const agentPath = join(agentFolderDir, `${folderName}.md`);
          writeFileSync(agentPath, content, 'utf-8');

          // Create default _meta.json
          writeAgentMeta(agentFolderDir, {
            displayName: payload.name,
            createdAt: new Date().toISOString(),
            updatedAt: new Date().toISOString(),
          });

          return jsonResponse({ success: true, path: agentPath, folderName });
        } catch (error) {
          console.error('[api/agent/create] Error:', error);
          return jsonResponse({ success: false, error: error instanceof Error ? error.message : 'Failed to create agent' }, 500);
        }
      }

      // GET /api/agents/workspace-config - Read workspace agent config
      if (pathname === '/api/agents/workspace-config' && request.method === 'GET') {
        try {
          const queryAgentDir = url.searchParams.get('agentDir');
          const effectiveDir = (queryAgentDir && isValidAgentDir(queryAgentDir).valid ? queryAgentDir : currentAgentDir) || '';
          if (!effectiveDir) {
            return jsonResponse({ success: true, config: { local: {}, global_refs: {} } });
          }
          const config = readWorkspaceConfig(effectiveDir);
          return jsonResponse({ success: true, config });
        } catch (error) {
          console.error('[api/agents/workspace-config] Error:', error);
          return jsonResponse({ success: false, error: error instanceof Error ? error.message : 'Failed to read config' }, 500);
        }
      }

      // PUT /api/agents/workspace-config - Update workspace agent config
      if (pathname === '/api/agents/workspace-config' && request.method === 'PUT') {
        try {
          const payload = await request.json() as { config: AgentWorkspaceConfig; agentDir?: string };
          const effectiveDir = (payload.agentDir && isValidAgentDir(payload.agentDir).valid ? payload.agentDir : currentAgentDir) || '';
          if (!effectiveDir) {
            return jsonResponse({ success: false, error: '请先设置工作目录' }, 400);
          }
          writeWorkspaceConfig(effectiveDir, payload.config);
          return jsonResponse({ success: true });
        } catch (error) {
          console.error('[api/agents/workspace-config] Error:', error);
          return jsonResponse({ success: false, error: error instanceof Error ? error.message : 'Failed to update config' }, 500);
        }
      }

      // GET /api/agents/enabled - Get enabled agents as SDK definitions
      if (pathname === '/api/agents/enabled' && request.method === 'GET') {
        try {
          const queryAgentDir = url.searchParams.get('agentDir');
          const effectiveDir = (queryAgentDir && isValidAgentDir(queryAgentDir).valid ? queryAgentDir : currentAgentDir) || '';
          const projAgentsDir = effectiveDir ? join(effectiveDir, '.claude', 'agents') : '';
          const agents = loadEnabledAgents(projAgentsDir, userAgentsBaseDir);
          return jsonResponse({ success: true, agents });
        } catch (error) {
          console.error('[api/agents/enabled] Error:', error);
          return jsonResponse({ success: false, error: error instanceof Error ? error.message : 'Failed to load agents' }, 500);
        }
      }

      // GET /api/supported-models - Get available models from SDK
      // Spawns a lightweight SDK subprocess (same pattern as provider verify)
      if (pathname === '/api/supported-models' && request.method === 'GET') {
        try {
          const { fetchSdkSupportedModels } = await import('./provider-verify');
          const models = await fetchSdkSupportedModels();
          return jsonResponse({ models });
        } catch (error) {
          console.error('[api/supported-models] Error:', error);
          return jsonResponse({ models: [], error: error instanceof Error ? error.message : 'Failed to get models' });
        }
      }

      // POST /api/model/set - Set default model for this session
      if (pathname === '/api/model/set' && request.method === 'POST') {
        try {
          // `imConfigSync` (#327): set by the Rust IM router's sync_ai_config, NOT
          // by the desktop model picker. It marks this as a channel/agent config
          // sync that must defer to a session snapshot (snapshot wins). Desktop
          // pushes omit it and stay authoritative. See setSessionModel.
          const payload = await request.json() as { model?: string; imConfigSync?: boolean };
          if (!payload?.model) {
            return jsonResponse({ success: false, error: 'model is required' }, 400);
          }
          const result = await getSessionEngine().updateModel(payload.model, { imConfigSync: payload.imConfigSync === true });
          return jsonResponse(result, result.success ? 200 : 500);
        } catch (error) {
          console.error('[api/model/set] Error:', error);
          return jsonResponse({ success: false, error: error instanceof Error ? error.message : 'Failed to set model' }, 500);
        }
      }

      // POST /api/reasoning-effort/set — #324 set reasoning effort for this
      // session. Desktop-picker only today (mirrors /api/model/set without the
      // Rust IM router caller, hence no imConfigSync flag). `effort` is the
      // setting string ('default' | level); 'default' restores pre-#324
      // behavior. Branches to the external-runtime handler per the
      // config-sync routing red line (CLAUDE.md Multi-Agent Runtime).
      if (pathname === '/api/reasoning-effort/set' && request.method === 'POST') {
        try {
          const payload = await request.json() as { effort?: string };
          if (typeof payload?.effort !== 'string' || !payload.effort.trim()) {
            return jsonResponse({ success: false, error: 'effort is required' }, 400);
          }
          const result = await getSessionEngine().updateReasoningEffort(payload.effort);
          return jsonResponse(result, result.success ? 200 : 500);
        } catch (error) {
          console.error('[api/reasoning-effort/set] Error:', error);
          return jsonResponse({ success: false, error: error instanceof Error ? error.message : 'Failed to set reasoning effort' }, 500);
        }
      }

      // POST /api/session/freeze - Stamp an OwnedSessionSnapshot onto the
      // session metadata, converting it from D4 live-follow to a frozen
      // historical session.
      //
      // Used by the Rust `cmd_update_agent_config` runtime-change orchestrator:
      // when an agent's runtime is about to change, every bot-bound session
      // (peer_session) is frozen FIRST with the agent's about-to-be-replaced
      // config, then its session_id is rotated. The old session detaches and
      // becomes a regular historical session that, on reopen, uses its captured
      // OLD runtime + config (matching the desktop session reopening path).
      //
      // Body: { sessionId, snapshot: OwnedSessionSnapshot } — Rust supplies
      // the field values it just read from the agent state on disk. Only
      // fields that are present and pass per-field type validation are
      // patched onto the session metadata; absent or wrong-typed fields are
      // skipped (NOT cleared) — keeps the HTTP path symmetric with the Rust
      // file-lock fallback writer in `runtime_change.rs::freeze_via_file_lock`,
      // which only inserts present keys. (review-by-codex F2: original
      // unconditionally spread `undefined` into present fields, so a missing
      // `model` would silently nuke the existing model on the session.)
      //
      // `configSnapshotAt` is ALWAYS stamped here at write time, not passed
      // through the wire — the marker reflects when the freeze committed,
      // not when Rust composed the payload.
      if (pathname === '/api/session/freeze' && request.method === 'POST') {
        try {
          const raw = await request.json() as Record<string, unknown>;
          if (typeof raw?.sessionId !== 'string' || !raw.sessionId) {
            return jsonResponse({ success: false, error: 'sessionId required' }, 400);
          }
          const snapshot = raw.snapshot as Record<string, unknown> | undefined;
          if (!snapshot || typeof snapshot !== 'object') {
            return jsonResponse({ success: false, error: 'snapshot required' }, 400);
          }

          // Build a typed patch with ONLY the fields that are present AND
          // pass per-field validation. Always stamp configSnapshotAt.
          const { updateSessionMetadata } = await import('./SessionStore');
          type FreezePatch = Parameters<typeof updateSessionMetadata>[1];
          const patch: FreezePatch = {
            configSnapshotAt: new Date().toISOString(),
          };
          if (typeof snapshot.runtime === 'string' && snapshot.runtime.length > 0) {
            patch.runtime = snapshot.runtime as FreezePatch['runtime'];
          }
          if (
            (snapshot.runtimeSource === 'managed-provider' || snapshot.runtimeSource === 'system-cli')
            && patch.runtime
            && patch.runtime !== 'builtin'
          ) {
            patch.runtimeSource = snapshot.runtimeSource;
          }
          if (typeof snapshot.model === 'string') {
            patch.model = snapshot.model;
          }
          // #324 — accepted for forward-compat; today's Rust freeze writer
          // never sends it (documented divergence, see session-snapshot.ts).
          if (typeof snapshot.reasoningEffort === 'string') {
            patch.reasoningEffort = snapshot.reasoningEffort;
          }
          if (typeof snapshot.permissionMode === 'string') {
            patch.permissionMode = snapshot.permissionMode;
          }
          if (Array.isArray(snapshot.mcpEnabledServers)) {
            const ids = snapshot.mcpEnabledServers.filter(
              (v): v is string => typeof v === 'string',
            );
            patch.mcpEnabledServers = ids;
          }
          if (Array.isArray(snapshot.enabledPluginIds)) {
            const ids = snapshot.enabledPluginIds.filter(
              (v): v is string => typeof v === 'string',
            );
            patch.enabledPluginIds = ids;
          }
          if (Array.isArray(snapshot.enabledOfficialToolIds)) {
            const { normalizeOfficialToolIds } = await import('../shared/official-tools');
            patch.enabledOfficialToolIds = normalizeOfficialToolIds(snapshot.enabledOfficialToolIds);
          }
          if (typeof snapshot.providerId === 'string') {
            patch.providerId = snapshot.providerId;
          }
          const route = snapshot.providerRoute;
          if (isConcreteProviderRoute(route as ProviderRoute | null | undefined)) {
            patch.providerRoute = route as ProviderRoute;
          }
          if (!patch.providerRoute && typeof snapshot.providerEnvJson === 'string') {
            patch.providerEnvJson = snapshot.providerEnvJson;
          }
          const identity = runtimeBackedProviderIdentityFromSnapshot(snapshot.providerExecutionIdentity);
          if (identity) {
            patch.providerExecutionIdentity = identity;
            patch.providerId = identity.providerId;
            patch.model = identity.model;
            patch.runtime = identity.runtime;
            patch.runtimeSource = identity.runtimeSource;
            patch.providerRoute = undefined;
            patch.providerEnvJson = undefined;
          }

          const updated = await updateSessionMetadata(raw.sessionId, patch);
          if (!updated) {
            return jsonResponse({ success: false, error: 'session not found' }, 404);
          }
          console.log(`[api/session/freeze] frozen sessionId=${raw.sessionId.slice(0, 8)} runtime=${updated.runtime ?? 'builtin'}`);
          return jsonResponse({ success: true });
        } catch (error) {
          console.error('[api/session/freeze] Error:', error);
          return jsonResponse({ success: false, error: error instanceof Error ? error.message : 'Failed to freeze session' }, 500);
        }
      }

      // POST /api/session/freeze-current - Freeze the current live sidecar's
      // effective config into its current SessionMetadata. Used by desktop
      // IM-bound provider/runtime forks before the channel binding moves to a
      // newly-created session: the old session must keep the held live config,
      // not the Agent defaults about to be updated for the target session.
      if (pathname === '/api/session/freeze-current' && request.method === 'POST') {
        try {
          const raw = (await request.json().catch(() => ({}))) as Record<string, unknown>;
          const freezeOptions: { metadataBirthPending: boolean; metadataIndexed?: boolean } = {
            metadataBirthPending: raw.metadataBirthPending === true,
          };
          if (typeof raw.metadataIndexed === 'boolean') {
            freezeOptions.metadataIndexed = raw.metadataIndexed;
          }
          const result = await getSessionEngine().freezeCurrentSessionForImDetach(freezeOptions);
          if (!result.success) {
            return jsonResponse(
              { success: false, error: result.error ?? 'Failed to freeze current session' },
              result.sessionId ? 500 : 400,
            );
          }
          return jsonResponse({
            success: true,
            sessionId: result.sessionId,
            metadata: result.metadata
              ? toClientSessionMetadata(result.metadata as SessionMetadata)
              : undefined,
          });
        } catch (error) {
          console.error('[api/session/freeze-current] Error:', error);
          return jsonResponse({ success: false, error: error instanceof Error ? error.message : 'Failed to freeze current session' }, 500);
        }
      }

      // GET /api/agent/:name - Get agent detail
      //
      // `folderName` is the UI-facing stable id (see agent-loader.ts for its
      // computation rules). We can't hard-assemble the path as
      // `<base>/<folderName>/<folderName>.md` anymore — flat/nested layouts
      // live elsewhere — so we scan and look up by folderName, reusing
      // `AgentItem.path` / `.layout` from there.
      if (pathname.startsWith('/api/agent/') && request.method === 'GET') {
        try {
          const agentName = decodeURIComponent(pathname.replace('/api/agent/', ''));
          if (!isValidAgentFolderName(agentName)) {
            return jsonResponse({ success: false, error: 'Invalid agent name' }, 400);
          }
          const scope = (url.searchParams.get('scope') || 'project') as 'user' | 'project';
          const queryAgentDir = url.searchParams.get('agentDir');
          const agentsDir = getProjectAgentsDir(queryAgentDir);
          const baseDir = scope === 'user' ? userAgentsBaseDir : agentsDir;

          const item = findAgent(baseDir, scope, agentName);
          if (!item) {
            return jsonResponse({ success: false, error: 'Agent not found' }, 404);
          }

          const content = readFileSync(item.path, 'utf-8');
          const { frontmatter, body } = parseFullAgentContent(content);

          return jsonResponse({
            success: true,
            agent: {
              name: frontmatter.name || item.folderName,
              folderName: item.folderName,
              path: item.path,
              scope,
              layout: item.layout,
              frontmatter,
              body,
              ...(item.meta ? { meta: item.meta } : {}),
            }
          });
        } catch (error) {
          console.error('[api/agent] Error:', error);
          return jsonResponse({ success: false, error: error instanceof Error ? error.message : 'Failed to get agent' }, 500);
        }
      }

      // PUT /api/agent/:name - Update agent (with optional folder rename for
      // 'folder' layout only)
      //
      // Lookup is by (folderName, scope) via findAgent(); we never reassemble
      // the path. Rename stays restricted to the canonical 'folder' layout:
      //   - flat agents live next to siblings and would collide on rename
      //   - nested agents belong to a user-managed directory tree (Claude
      //     Code plugin, synced-in content, etc.) — renaming would mutate
      //     their container out from under them
      // Callers can relocate such agents by hand; UI should hide the rename
      // affordance when `layout !== 'folder'`.
      if (pathname.startsWith('/api/agent/') && request.method === 'PUT') {
        try {
          const agentName = decodeURIComponent(pathname.replace('/api/agent/', ''));
          if (!isValidAgentFolderName(agentName)) {
            return jsonResponse({ success: false, error: 'Invalid agent name' }, 400);
          }
          const payload = await request.json() as {
            scope: 'user' | 'project';
            frontmatter: Partial<AgentFrontmatter>;
            body: string;
            newFolderName?: string;
            agentDir?: string;
            meta?: AgentMeta;
          };

          const agentsDir = getProjectAgentsDir(payload.agentDir || null);
          const baseDir = payload.scope === 'user' ? userAgentsBaseDir : agentsDir;

          const item = findAgent(baseDir, payload.scope, agentName);
          if (!item) {
            return jsonResponse({ success: false, error: 'Agent not found' }, 404);
          }

          let currentFolderName = item.folderName;
          let agentPath = item.path;
          let agentFolderDir = dirname(item.path);

          // Rename is only meaningful for the 'folder' layout
          if (payload.newFolderName && payload.newFolderName !== currentFolderName) {
            if (item.layout !== 'folder') {
              return jsonResponse({
                success: false,
                error: `当前 Agent 布局为 ${item.layout}，不支持重命名。请手动调整文件结构后再试。`,
              }, 400);
            }
            const newFolderName = payload.newFolderName;
            if (!isValidItemName(newFolderName)) {
              return jsonResponse({ success: false, error: 'Invalid new folder name' }, 400);
            }
            const newAgentDir = join(baseDir, newFolderName);
            if (existsSync(newAgentDir)) {
              return jsonResponse({ success: false, error: `Agent 文件夹 "${newFolderName}" 已存在，请使用其他名称` }, 409);
            }

            const content = serializeAgentContent(payload.frontmatter, payload.body);
            renameSync(agentFolderDir, newAgentDir);
            agentFolderDir = newAgentDir;
            currentFolderName = newFolderName;

            // Rename the .md file inside to match new folder name
            const oldMdPath = join(agentFolderDir, `${item.folderName}.md`);
            agentPath = join(agentFolderDir, `${newFolderName}.md`);
            if (existsSync(oldMdPath)) {
              renameSync(oldMdPath, agentPath);
            }

            writeFileSync(agentPath, content, 'utf-8');
            const existingMeta = readAgentMeta(agentFolderDir);
            const updatedMeta = { ...existingMeta, ...payload.meta, displayName: payload.frontmatter.name || newFolderName, updatedAt: new Date().toISOString() };
            writeAgentMeta(agentFolderDir, updatedMeta);
            return jsonResponse({ success: true, path: agentPath, folderName: currentFolderName });
          }

          // No rename — update content in place regardless of layout
          const content = serializeAgentContent(payload.frontmatter, payload.body);
          writeFileSync(agentPath, content, 'utf-8');

          // _meta.json only lives next to 'folder' layout agents. For flat /
          // nested, skip — there's no unambiguous place for it.
          if (item.layout === 'folder') {
            const existingMeta = readAgentMeta(agentFolderDir);
            if (payload.meta || (payload.frontmatter.name && payload.frontmatter.name !== existingMeta?.displayName)) {
              const updatedMeta = { ...existingMeta, ...payload.meta, updatedAt: new Date().toISOString() };
              if (payload.frontmatter.name) updatedMeta.displayName = payload.frontmatter.name;
              writeAgentMeta(agentFolderDir, updatedMeta);
            }
          }
          return jsonResponse({ success: true, path: agentPath, folderName: currentFolderName });
        } catch (error) {
          console.error('[api/agent] Error:', error);
          return jsonResponse({ success: false, error: error instanceof Error ? error.message : 'Failed to update agent' }, 500);
        }
      }

      // DELETE /api/agent/:name - Delete agent
      //
      // Deletion shape depends on layout:
      //   - folder: remove the whole <base>/<folderName>/ directory
      //   - flat:   remove the single <base>/<folderName>.md file
      //   - nested: remove only the .md file, leave the surrounding directory
      //             structure alone (it's user- or plugin-managed)
      if (pathname.startsWith('/api/agent/') && request.method === 'DELETE') {
        try {
          const agentName = decodeURIComponent(pathname.replace('/api/agent/', ''));
          if (!isValidAgentFolderName(agentName)) {
            return jsonResponse({ success: false, error: 'Invalid agent name' }, 400);
          }
          const scope = (url.searchParams.get('scope') || 'project') as 'user' | 'project';
          const queryAgentDir = url.searchParams.get('agentDir');
          const agentsDir = getProjectAgentsDir(queryAgentDir);
          const baseDir = scope === 'user' ? userAgentsBaseDir : agentsDir;

          const item = findAgent(baseDir, scope, agentName);
          if (!item) {
            return jsonResponse({ success: false, error: 'Agent not found' }, 404);
          }

          if (item.layout === 'folder') {
            rmSync(dirname(item.path), { recursive: true, force: true });
          } else {
            rmSync(item.path, { force: true });
          }
          return jsonResponse({ success: true });
        } catch (error) {
          console.error('[api/agent] Error:', error);
          return jsonResponse({ success: false, error: error instanceof Error ? error.message : 'Failed to delete agent' }, 500);
        }
      }

      // ============= END SLASH COMMANDS API =============

      // ============= IM BOT API =============
      // These endpoints are called by the Rust IM layer (SessionRouter)

      // ============= IM Pipeline v2 (Pattern C/D) =============
      // /api/im/enqueue   — sync ACK, no SSE; peer_lock on Rust side only
      //                     wraps this call (ms-level), enabling true mid-turn
      //                     concurrency for same-chat messages.
      // /api/im/events    — long-poll SSE; one connection per peer_session,
      //                     events tagged with requestId, supports `since=<seq>`
      //                     for crash-recovery resume.
      // /api/im/cancel    — abort an in-flight request by requestId; ties into
      //                     v0.2.0 `cancellableFetch` / AbortSignal semantics.

      // POST /api/im/enqueue — Pattern C: enqueue an IM message and return immediately.
      // Replaces /api/im/chat. Body shape identical, but no SSE response — events
      // flow over /api/im/events long-poll instead.
      if (pathname === '/api/im/enqueue' && request.method === 'POST') {
        try {
          const payload = (await request.json()) as {
            message: string;
            source: string;
            sourceId: string;
            senderName?: string;
            permissionMode?: string;
            providerEnv?: ProviderEnv;
            model?: string;
            runtime?: RuntimeType;
            runtimeConfig?: RuntimeConfig;
            images?: ImagePayload[];
            botId?: string;
            botName?: string;
            // Pattern A — Per-Request Identity. REQUIRED for /api/im/enqueue
            // (Rust generates at edge). The legacy /api/im/chat tolerated absence
            // because the SSE+callback model was 1:1; the new bus model needs the
            // ID to route events.
            requestId: string;
            sourceType?: 'group';
            groupName?: string;
            groupPlatform?: string;
            groupActivation?: 'mention' | 'always';
            isFirstGroupTurn?: boolean;
            pendingHistory?: string;
            groupToolsDeny?: string[];
            replyToBody?: string;
            groupSystemPrompt?: string;
	            isMention?: boolean;
	            messageCount?: number;
            metadataBirthPending?: boolean;
            configHeldByTab?: boolean;
            bridgePort?: number;
            bridgePluginId?: string;
            bridgeEnabledToolGroups?: string[];
            senderId?: string;
            senderIsOwner?: boolean;
            accountId?: string;
            hostInteraction?: unknown;
          };

          if (!payload.requestId) {
            return jsonResponse({ success: false, error: 'Missing requestId (Pattern C requires it)' }, 400);
          }
          const hasContent = payload.message?.trim() || (payload.images && payload.images.length > 0);
          if (!hasContent) {
            return jsonResponse({ success: false, error: 'Message or images required' }, 400);
          }

          // Register in registry up front so /api/im/cancel works even before
          // enqueueUserMessage returns. AbortController is paired here for
          // Pattern D wiring (cancellableFetch hooks below).
          const requestEntry = imRequestRegistry.register(
            payload.requestId,
            getSessionId() || null,
            payload.source,
          );
          const engine = getSessionEngine();
          const sidForConfigAuthority = getSessionId();
          const snapshotMetaForConfig = sidForConfigAuthority ? getSessionMetadata(sidForConfigAuthority) : null;
          const snapshotOwnsConfig = Boolean(snapshotMetaForConfig?.configSnapshotAt);
          const configHeldByTab = payload.configHeldByTab === true && !snapshotOwnsConfig;
          const heldImConfig = configHeldByTab ? engine.getHeldImConfigSnapshot() : null;
          const payloadRuntime = payload.runtime ?? getActiveRuntimeType();
          const payloadRuntimeConfig = payload.runtimeConfig ?? null;
          const snapshotResolvedConfig = snapshotOwnsConfig && snapshotMetaForConfig
            ? resolveWorkspaceConfig(agentDir, snapshotMetaForConfig, { includeMcp: false })
            : null;
          const snapshotRuntimeConfig = snapshotResolvedConfig
            ? buildSnapshotRuntimeConfig(snapshotResolvedConfig)
            : null;
          const effectiveRuntime = snapshotOwnsConfig
            && snapshotMetaForConfig?.runtime
            && (VALID_RUNTIMES as readonly string[]).includes(snapshotMetaForConfig.runtime)
            ? snapshotMetaForConfig.runtime as RuntimeType
            : payloadRuntime;
          const activeRuntime = getActiveRuntimeType();
          const activeRuntimeSource = engine.getRuntimeIdentity().runtimeSource;
          const payloadExternalPermissionMode = typeof payload.permissionMode === 'string'
            ? (activeRuntime === 'codex' && activeRuntimeSource === 'managed-provider'
              ? projectManagedCodexPermissionToRuntime(payload.permissionMode)
              : projectPermissionModeForRuntime(payload.permissionMode, activeRuntime))
            : undefined;
          if (snapshotOwnsConfig && effectiveRuntime !== activeRuntime) {
            imRequestRegistry.unregister(payload.requestId);
            return jsonResponse(
              {
                success: false,
                error: `Session runtime mismatch: snapshot=${effectiveRuntime}, sidecar=${activeRuntime}. Please reopen or rebind this channel session.`,
              },
              409,
            );
          }

          try {

          // Set IM cron context for the im-cron tool (parity with /api/im/chat)
          let bridgeSurfaceRequiresTurnBoundary = false;
          if (payload.botId && process.env.MYAGENTS_MANAGEMENT_PORT) {
            const imCronModel = snapshotResolvedConfig
              ? snapshotResolvedConfig.model
              : (effectiveRuntime === 'builtin'
                ? (heldImConfig?.model ?? payload.model ?? getSessionModel())
                : (heldImConfig?.model ?? getRuntimeConfigModel(payloadRuntimeConfig, effectiveRuntime)));
            // PRD 0.2.9 — Resolve providerId from the workspace agent so
            // the IM cron tool can create live-resolve crons. Only meaningful
            // for builtin runtime (external runtimes manage their own provider).
            const imAgentForProvider = effectiveRuntime === 'builtin' && !snapshotOwnsConfig
              ? findProjectAgentByWorkspacePath(agentDir)
              : null;
            const imProviderId = snapshotOwnsConfig
              ? (snapshotMetaForConfig?.providerId ?? snapshotResolvedConfig?.providerEnv?.providerId)
              : ((imAgentForProvider?.providerId as string | undefined) ?? undefined);
            setImCronContext({
              botId: payload.botId,
              chatId: payload.sourceId,
              platform: payload.source.split('_')[0],
              workspacePath: agentDir,
              model: imCronModel,
              permissionMode: snapshotResolvedConfig
                ? snapshotResolvedConfig.permissionMode
                : (effectiveRuntime === 'builtin'
                  ? (heldImConfig?.permissionMode ?? payload.permissionMode)
                  : (heldImConfig?.permissionMode
                    ?? payloadExternalPermissionMode
                    ?? getRuntimeConfigPermissionMode(payloadRuntimeConfig, effectiveRuntime)
                    ?? getMaxPermissionForRuntime(effectiveRuntime))),
              // Legacy frozen env (kept for back-compat); sidecar prefers
              // `providerId` when both are present.
              providerEnv: effectiveRuntime === 'builtin'
                ? cloneProviderEnvForImContext(
                    (snapshotResolvedConfig?.providerEnv as ProviderEnv | undefined)
                    ?? heldImConfig?.providerEnv
                    ?? payload.providerEnv,
                  )
                : undefined,
              providerId: imProviderId,
              runtime: effectiveRuntime,
              runtimeConfig: effectiveRuntime === 'builtin'
                ? undefined
                : (snapshotRuntimeConfig ?? payloadRuntimeConfig ?? undefined),
            });
            setImMediaContext({
              botId: payload.botId,
              chatId: payload.sourceId,
              platform: payload.source.split('_')[0],
              workspacePath: agentDir,
            });
            let bridgeSurfaceChanged = false;
            if (payload.bridgePort && payload.bridgePluginId) {
              const bridgeSourceType = payload.source?.split('_')[1] as string | undefined;
              const imBridgeTurnContext = {
                senderId: payload.senderId,
                chatId: payload.sourceId,
                isOwner: payload.senderIsOwner ?? false,
                accountId: payload.accountId,
                sourceType: bridgeSourceType,
                hostInteraction: normalizeHostInteractionCapability(payload.hostInteraction),
              };
              imRequestRegistry.setImBridgeTurnContext(payload.requestId, imBridgeTurnContext);
              let surface;
              try {
                surface = await raceWithAbortSignal(
                  ensureImBridgeToolSurface({
                    bridgePort: payload.bridgePort,
                    pluginId: payload.bridgePluginId,
                    enabledToolGroups: payload.bridgeEnabledToolGroups || [],
                  }, () => getSessionEngine().getActiveImBridgeTurnContext()),
                  requestEntry.abortController.signal,
                );
              } catch (error) {
                if (requestEntry.abortController.signal.aborted) {
                  imRequestRegistry.unregister(payload.requestId);
                  return jsonResponse({ success: false, error: 'IM request cancelled before dispatch' }, 409);
                }
                throw error;
              }
              bridgeSurfaceChanged = surface.changed;
            }

            // After IM context (which gates the `im-bridge-tools` MCP) is set,
            // sync the SDK's MCP list so it picks up the bridge server. Without
            // this, the pre-warmed SDK (started by heartbeat before any IM
            // message) keeps a stale mcpServers config and bridge plugin tools
            // appear "disconnected".
            //
            // (v0.2.11) `im-media` was retired here — `myagents im send-media`
            // CLI is the new path, no SDK sync needed for it. `im-bridge-tools`
            // is the only remaining context-injected MCP this re-sync targets.
            //
            // Position note: called BEFORE setInteractionScenario so the pre-warm's
            // current scenario (typically 'desktop' until the first IM message) is
            // preserved in the diff. Removing scenario-bound MCPs mid-session would
            // leave the SDK's frozen systemPrompt referencing tools that no longer
            // exist. This pass is purely additive for the IM-context tools the AI
            // is about to need; scenario alignment is a separate concern.
            //
            // Builtin runtime only — external runtimes (CC/Codex) manage their own MCP set.
            if (
              engine.kind === 'builtin'
              && (bridgeSurfaceChanged || !isCurrentImBridgeToolSurfaceInstalled())
            ) {
              bridgeSurfaceRequiresTurnBoundary = !(await ensureSdkMcpInSync());
            }
          }

          // Set IM interaction scenario (after MCP sync, see note above)
          const [imPlatform, imSourceType] = payload.source.split('_') as ['telegram' | 'feishu', 'private' | 'group'];
          const hostInteraction = normalizeHostInteractionCapability(payload.hostInteraction);
          const imScenario: Extract<InteractionScenario, { type: 'im' }> = {
            type: 'im',
            platform: imPlatform,
            sourceType: imSourceType,
            botName: payload.botName,
            hostInteraction,
          };
          const imTurnOrigin: SessionOrigin = { kind: 'agent-channel', surface: 'channel_message' };
          await setInteractionScenario(imScenario);

          // Build final message with group context (identical to /api/im/chat)
          let finalMessage = payload.message || '';
          if (payload.sourceType === 'group') {
            const parts: string[] = [];
            const isAlways = payload.groupActivation === 'always';
            const sanitize = (s: string) => s.replace(/[<>[\]]/g, '').replace(/\n/g, ' ').trim();
            const botName = sanitize(payload.botName ?? 'AI');
            const platformLabel = sanitize(payload.groupPlatform ?? '');
            const messageCount = payload.messageCount ?? 0;
            const shouldInjectFullRules = payload.isFirstGroupTurn || (messageCount > 0 && messageCount % 10 === 0);

            if (shouldInjectFullRules) {
              const safeGroupName = sanitize(payload.groupName ?? '未知群聊');
              let reminder = `<system-reminder>\n[群聊信息]\n你正在「${safeGroupName}」${platformLabel}群聊中。你的名字是「${botName}」。`;
              if (isAlways) {
                reminder += '\n激活模式：全部消息（你会收到群里所有消息，包括不是发给你的）。';
              } else {
                reminder += '\n激活模式：仅 @提及（只有被 @、被回复或使用 /ask 时才会收到消息）。';
              }
              reminder += '\n你的回复会自动发送到群里，直接回复即可。\n群内不同人的消息会以 [from: 名字 时间] 标注发送者。';
              if (isAlways) {
                const mentionExample = payload.botName ? `（即 @${botName}）` : '';
                reminder += `\n\n[回复规则]\n你必须非常克制，大多数消息不需要你回复。仅在以下情况回复：\n1. 消息明确 @你${mentionExample}（即使消息同时也 @了其他人，只要 @了你就必须回复）\n2. 消息回复了你之前的消息\n3. 有人直接向你提问或请求帮助\n4. 你确信能提供明确价值的信息\n\n以下情况必须保持沉默：\n- 消息没有 @你，只 @了其他人或其他机器人\n- 普通闲聊、与你无关的讨论\n- 你不确定是否该回复时\n\n判断是否 @了你：看 [本条消息 @了你] 标记，而不是看消息正文中的 @用户名。\n不需要回复时，只回复 <NO_REPLY>，不要添加任何其他内容。`;
              }
              if (payload.groupSystemPrompt) {
                reminder += `\n\n[群聊指令]\n${payload.groupSystemPrompt}`;
              }
              reminder += '\n</system-reminder>';
              parts.push(reminder);
            } else if (isAlways) {
              parts.push(`<system-reminder>\n你是「${botName}」，当前处于群聊的全部消息模式 — 你会收到群聊内的全部信息，你需要自主判断是否需要回复消息。与自己无关的消息不要回复，没有 @你、仅 @了其他人的消息不要回复。注意：[本条消息 @了你] 标记才是判断依据，消息正文中可能同时 @了多人。当你判断不需要回复消息时，只输出字符<NO_REPLY>\n</system-reminder>`);
            }
            if (payload.pendingHistory) parts.push(payload.pendingHistory);
            if (payload.replyToBody) parts.push(`[引用回复]\n> ${payload.replyToBody.split('\n').join('\n> ')}`);
            const now = new Date();
            const ts = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')} ${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}:${String(now.getSeconds()).padStart(2, '0')}`;
            let messageBlock = '';
            if (isAlways) {
              messageBlock += payload.isMention ? '[本条消息 @了你，你需要回复]\n' : '[本条消息未 @你]\n';
            }
            // Fall back to senderId when the plugin didn't provide a senderName
            // (WeCom's aibot_msg_callback only carries `from.userid`, no name —
            // unlike Feishu which enriches senderName via contacts API). The
            // Rust group_history writer (im/mod.rs:2393/2419) already does the
            // same fallback; without it here the live message has no [from:]
            // tag while history entries do, breaking the system-reminder's
            // promise that "群内不同人的消息会以 [from: 名字 时间] 标注".
            const displaySender = payload.senderName || payload.senderId;
            messageBlock += displaySender ? `[from: ${sanitize(displaySender)} ${ts}]\n` : '';
            messageBlock += finalMessage;
            parts.push(messageBlock);
            finalMessage = parts.join('\n\n');
          } else if (payload.replyToBody) {
            finalMessage = `[引用回复]\n> ${payload.replyToBody.split('\n').join('\n> ')}\n\n${finalMessage}`;
          }

          setGroupToolsDeny(resolveImGroupToolsDeny(payload.sourceType, payload.groupToolsDeny));

          const metadata = {
            source: payload.source as SessionSource,
            sourceId: payload.sourceId,
            senderName: payload.senderName,
          };

          if (requestEntry.abortController.signal.aborted) {
            imRequestRegistry.unregister(payload.requestId);
            return jsonResponse({ success: false, error: 'IM request cancelled before dispatch' }, 409);
          }

          // Dispatch to runtime through SessionEngine. The route keeps IM
          // payload shaping; the engine owns builtin/external admission.
          if (engine.kind === 'external') {
            const runtimeConfig = snapshotRuntimeConfig ?? payloadRuntimeConfig;
            if (payloadRuntime !== activeRuntime) {
              console.error(
                `[im/enqueue] Runtime mismatch (Rust drift detection failed to catch): sidecar=${activeRuntime} payload=${payloadRuntime}.`,
              );
            }
            const resolvedExternalPermissionMode = snapshotResolvedConfig?.permissionMode
              ?? heldImConfig?.permissionMode
              ?? payloadExternalPermissionMode
              ?? getRuntimeConfigPermissionMode(runtimeConfig, effectiveRuntime)
              ?? getMaxPermissionForRuntime(effectiveRuntime);
            const resolvedExternalModel = snapshotResolvedConfig
              ? snapshotResolvedConfig.model
              : (heldImConfig?.model ?? getRuntimeConfigModel(runtimeConfig, effectiveRuntime));
            const resolvedExternalReasoningEffort = snapshotResolvedConfig
              ? snapshotResolvedConfig.reasoningEffort
              : (heldImConfig?.reasoningEffort ?? getRuntimeConfigReasoningEffort(runtimeConfig, effectiveRuntime));
            const result = await goalOrchestrator.enqueueImMessage(engine, {
              message: finalMessage,
              images: payload.images ?? undefined,
              requestId: payload.requestId,
              sessionId: getRuntimeSessionIdForRequest(),
              workspacePath: agentDir,
              scenario: {
                type: 'agent-channel',
                platform: imPlatform,
                sourceType: imSourceType,
                botName: payload.botName,
                hostInteraction,
              },
              permissionMode: resolvedExternalPermissionMode,
              model: resolvedExternalModel,
              reasoningEffort: resolvedExternalReasoningEffort,
              runtimeConfig,
              metadataBirthPending: payload.metadataBirthPending === true,
              metadata,
              analyticsOrigin: imTurnOrigin,
            });
            if (!result.success) {
              imRequestRegistry.unregister(payload.requestId);
              return jsonResponse(
                { success: false, error: result.error ?? 'Failed to send via external runtime' },
                result.status ?? 503,
              );
            }
          } else {
            // PRD 0.2.14 Q4·A — handover-aware permission mode resolution.
            // After a desktop session is handed over to this channel, the
            // session carries a `configSnapshotAt` from its desktop creation.
            // In that case the user's intent is "the desktop session's mode
            // wins" (the desktop session is the authoritative state), so we
            // ignore the live Agent values that Rust passed in payload.
            // Pure IM-origin sessions never have a snapshot, so this branch
            // is a no-op for them and behavior matches v0.2.13.
            let resolvedPermissionMode: PermissionMode = (payload.permissionMode as PermissionMode) ?? 'fullAgency';
            let resolvedModel: string | undefined = payload.model ?? undefined;
            let resolvedReasoningEffort: string | undefined;
            let resolvedProviderRoute: ProviderRoute | undefined;
            // Pure IM-origin builtin sessions resolve ProviderRoute live from
            // disk. This keeps route identity canonical (providerId + model)
            // instead of trusting Rust's legacy providerEnv blob, and fails
            // loud for known provider/model/key errors. Legacy fallback is kept
            // only for unmatched historical bots where no Agent can be found.
            let resolvedProviderEnv: ProviderEnv | undefined = payload.providerEnv ?? undefined;
            if (!heldImConfig && !snapshotResolvedConfig) {
              const imRoutingConfig = loadConfig();
              const imProviderRouting = resolveImProviderRouting(agentDir, payload.botId, {
                config: imRoutingConfig,
                managedCodexProviderReady: isManagedCodexProviderReady(imRoutingConfig),
              });
              if (imProviderRouting.kind === 'provider-route') {
                resolvedProviderRoute = imProviderRouting.providerRoute;
                resolvedModel = imProviderRouting.model;
                resolvedProviderEnv = undefined;
              } else if (imProviderRouting.kind === 'external-runtime') {
                imRequestRegistry.unregister(payload.requestId);
                return jsonResponse(
                  {
                    success: false,
                    error: `IM channel now resolves to ${imProviderRouting.runtime}; current sidecar is builtin. Runtime drift recovery should create an external-runtime session before enqueue.`,
                  },
                  409,
                );
              } else if (imProviderRouting.kind === 'error') {
                imRequestRegistry.unregister(payload.requestId);
                return jsonResponse(
                  { success: false, error: imProviderRouting.message, reason: imProviderRouting.reason },
                  imProviderRouting.status,
                );
              }
            }
            if (heldImConfig) {
              resolvedPermissionMode = (heldImConfig.permissionMode as PermissionMode | undefined) ?? resolvedPermissionMode;
              resolvedModel = heldImConfig.model ?? resolvedModel;
              resolvedProviderRoute = undefined;
              resolvedProviderEnv = heldImConfig.providerEnv ?? resolvedProviderEnv;
              resolvedReasoningEffort = heldImConfig.reasoningEffort ?? resolvedReasoningEffort;
            }
            if (snapshotResolvedConfig) {
              // Desktop-handover snapshots own the full config. Missing fields
              // mean "use product/runtime default", not "fall back to live
              // Agent/channel config".
              resolvedPermissionMode = snapshotResolvedConfig.permissionMode as PermissionMode;
              resolvedModel = snapshotResolvedConfig.model;
              resolvedProviderRoute = isConcreteProviderRoute(snapshotResolvedConfig.providerRoute)
                ? snapshotResolvedConfig.providerRoute
                : undefined;
              resolvedProviderEnv = snapshotResolvedConfig.providerEnv as ProviderEnv | undefined;
              resolvedReasoningEffort = snapshotResolvedConfig.reasoningEffort;
            }

            applyBackgroundAgentPermissionModeFromDisk(); // #264 — IM/Task self-resolve
            const result = await goalOrchestrator.enqueueImMessage(engine, {
              message: finalMessage,
              images: payload.images,
              requestId: payload.requestId,
              sessionId: getRuntimeSessionIdForRequest(),
              workspacePath: agentDir,
              scenario: imScenario,
              permissionMode: resolvedPermissionMode,
              model: resolvedModel,
              providerRoute: resolvedProviderRoute,
              providerEnv: resolvedProviderRoute ? undefined : resolvedProviderEnv,
              reasoningEffort: resolvedReasoningEffort,
              metadataBirthPending: payload.metadataBirthPending === true,
              metadata,
              analyticsOrigin: imTurnOrigin,
              turnBoundaryOnly: bridgeSurfaceRequiresTurnBoundary,
            });
            if (!result.success) {
              imRequestRegistry.unregister(payload.requestId);
              return jsonResponse({ success: false, error: result.error }, result.status ?? 503);
            }
          }

          // Cancellation may land while runtime admission is awaiting its own
          // config/domain work. If the queue owner now exists, cancel it
          // precisely; if it never existed this remains a harmless no-op.
          if (requestEntry.abortController.signal.aborted) {
            await engine.cancelImRequest(payload.requestId, 'user');
            imRequestRegistry.unregister(payload.requestId);
            return jsonResponse({ success: false, error: 'IM request cancelled during dispatch' }, 409);
          }
          imRequestRegistry.transferCancellationToRuntime(payload.requestId);

          const currentSessionId = getSessionId();
          if (currentSessionId) {
            const sessionMeta = getSessionMetadata(currentSessionId);
            if (sessionMeta && !sessionMeta.source) {
              await updateSessionMetadata(currentSessionId, { source: payload.source as SessionSource });
            }
          }

          return jsonResponse({
            success: true,
            requestId: payload.requestId,
            accepted: true,
            sessionId: currentSessionId,
          });

          } catch (innerError) {
            // Before runtime admission the route still owns cleanup. After the
            // transfer, the output-owner terminal path owns this registry entry
            // and must retain Bridge caller identity until the SDK result.
            if (requestEntry.cancellationOwner === 'admission-route') {
              try { imRequestRegistry.unregister(payload.requestId); } catch { /* ignore */ }
            }
            throw innerError;
          }
        } catch (error) {
          console.error('[im/enqueue] Error:', error);
          return jsonResponse(
            { success: false, error: error instanceof Error ? error.message : 'IM enqueue error' },
            500,
          );
        }
      }

      // GET /api/im/events?since=<seq> — Pattern C: long-poll SSE.
      // One connection per peer_session, events fan-in from all in-flight requests
      // tagged with their requestId. Caller filters per requestId on the Rust
      // side (ReplyRouter). `since` enables crash-recovery resume — ImEventBus
      // replays ring-buffered events with seq > since before going live.
      if (pathname === '/api/im/events' && request.method === 'GET') {
        const sinceParam = url.searchParams.get('since');
        const sinceSeq = sinceParam ? parseInt(sinceParam, 10) : imEventBus.currentSeq();
        const safeSince = Number.isFinite(sinceSeq) && sinceSeq >= 0 ? sinceSeq : imEventBus.currentSeq();
        const replayRequestId = url.searchParams.get('replayRequestId') || undefined;

        const encoder = new TextEncoder();
        let heartbeatTimer: ReturnType<typeof setInterval> | null = null;
        let closed = false;
        let unsubscribe: (() => void) | null = null;

        const stream = new ReadableStream({
          start(controller) {
            controller.enqueue(encoder.encode(`: connected since=${safeSince}\n\n`));
            // 15s heartbeat keep-alive
            heartbeatTimer = setInterval(() => {
              try { if (!closed) controller.enqueue(encoder.encode(': ping\n\n')); }
              catch { /* stream closed */ }
            }, 15000);

            unsubscribe = imEventBus.subscribe(
              safeSince,
              (event) => {
                if (closed) return;
                try {
                  controller.enqueue(encoder.encode(`data: ${JSON.stringify(event)}\n\n`));
                } catch {
                  // Controller closed mid-emit — schedule cleanup
                  closed = true;
                  if (heartbeatTimer) { clearInterval(heartbeatTimer); heartbeatTimer = null; }
                  if (unsubscribe) { unsubscribe(); unsubscribe = null; }
                }
              },
              () => {
                // imEventBus.clear() force-cleared the subscription (session
                // reset). Close the SSE stream so the Rust event_consumer
                // sees end-of-stream and reconnects with `since=<lastSeq>` —
                // subscribe() will then synthesize the cross-generation gap
                // event so events from the new session aren't silently lost.
                if (closed) return;
                closed = true;
                if (heartbeatTimer) { clearInterval(heartbeatTimer); heartbeatTimer = null; }
                try { controller.close(); } catch { /* already closed */ }
                // No need to call unsubscribe() — clear() already removed us
                // from both the subscribers Set and the clearedCallbacks Map.
                unsubscribe = null;
              },
              replayRequestId,
            );
          },
          cancel() {
            closed = true;
            if (heartbeatTimer) { clearInterval(heartbeatTimer); heartbeatTimer = null; }
            if (unsubscribe) { unsubscribe(); unsubscribe = null; }
          }
        });

        return new Response(stream, {
          headers: {
            'Content-Type': 'text/event-stream; charset=utf-8',
            'Cache-Control': 'no-cache, no-transform',
            'Connection': 'keep-alive',
            'X-Accel-Buffering': 'no',
          },
        });
      }

      // POST /api/im/cancel — Pattern D: abort an in-flight IM request.
      // Body: { requestId, reason? }. Drives THREE cancellation paths:
      //   1. Registry AbortController.abort(reason) — stops route-owned Bridge
      //      discovery/admission waits before a runtime queue owner exists.
      //   2. cancelImRequest / cancelExternalImRequest — actual SDK-level cancel
      //      via interruptCurrentResponse (builtin) or stopExternalSession (external).
      //      This is what stops the SDK turn from burning tokens.
      //   3. imEventBus.emit('cancelled', ...) — Rust ReplyRouter sees this and
      //      closes the reply slot (UI feedback).
      if (pathname === '/api/im/cancel' && request.method === 'POST') {
        try {
          const body = (await request.json()) as { requestId: string; reason?: string };
          if (!body.requestId) {
            return jsonResponse({ success: false, error: 'Missing requestId' }, 400);
          }
          const reason = body.reason ?? 'user';
          const cancellationClaim = imRequestRegistry.claimCancellation(body.requestId, reason);
          if (!cancellationClaim) {
            return jsonResponse({ success: false, error: 'Unknown or already-aborted requestId' }, 404);
          }

          // The registry AbortController is the atomic cancellation claim.
          // Concurrent retries observe the first caller's claim and must not
          // re-enter the runtime or steal its eventual terminal event.
          if (cancellationClaim.outcome === 'already-claimed') {
            return jsonResponse({
              success: true,
              requestId: body.requestId,
              mode: cancellationClaim.owner === 'admission-route' ? 'admission' : 'running',
              alreadyCancelling: true,
            });
          }

          // Step 1: the successful claim already aborted the registry signal,
          // covering route-owned discovery/admission waits.
          const admissionRouteOwned = cancellationClaim.owner === 'admission-route';

          // Step 2: actual SDK / queue cancel.
          const cancelResult = await getSessionEngine().cancelImRequest(body.requestId, reason);

          // (v0.2.11 cross-bugfix #142 review-fix-3 medium #2)
          // Runtime `unknown` is safe only while this route still owns
          // admission: its abort signal guarantees the request cannot return
          // accepted or dispatch late. After ownership transfers to runtime,
          // unknown can be a promote-then-cancel race, so reporting success
          // would be dishonest while the SDK may continue processing.
          if (cancelResult.mode === 'unknown' && !admissionRouteOwned) {
            return jsonResponse(
              {
                success: false,
                requestId: body.requestId,
                mode: cancelResult.mode,
                error: 'Request not in a cancellable state — message may already be in flight',
              },
              409,
            );
          }

          // Step 3: the route owns terminal delivery only before runtime
          // admission or for an item removed from a runtime queue. A running
          // turn keeps terminal ownership even if its result/finalizer has not
          // unregistered the registry entry by the time Step 2 returns.
          const routeOwnsTerminal = admissionRouteOwned || cancelResult.mode === 'queued';
          if (routeOwnsTerminal && imRequestRegistry.get(body.requestId)) {
            imEventBus.emit(body.requestId, 'cancelled', buildImCancelledPayload());
            imRequestRegistry.unregister(body.requestId);
          }

          return jsonResponse({
            success: true,
            requestId: body.requestId,
            mode: cancelResult.mode === 'unknown' ? 'admission' : cancelResult.mode,
          });
        } catch (error) {
          console.error('[im/cancel] Error:', error);
          return jsonResponse(
            { success: false, error: error instanceof Error ? error.message : 'IM cancel error' },
            500,
          );
        }
      }

      // ============= END IM Pipeline v2 =============

      // POST /api/im/heartbeat — Execute a heartbeat check (synchronous JSON response, not SSE)
      if (pathname === '/api/im/heartbeat' && request.method === 'POST') {
        // Track drained events so they can be re-queued on pre-enqueue failures
        let drainedEvents: Array<{ event: string; content: string; timestamp: number; taskId?: string }> = [];
        // Cron events are tracked separately because they have stricter durability —
        // the destructive drain MUST be reverted unless the heartbeat actually produced
        // deliverable content. Lifted to outer scope so the catch block + the response
        // helper below can both reach it without re-deriving from drainedEvents.
        let cronEvents: Array<{ event: string; content: string; timestamp: number; taskId?: string }> = [];
        let messageEnqueued = false;

        // Cron events represent durable work that MUST reach Feishu/IM — anything
        // short of `status === 'content'` (silent / error / timeout / HEARTBEAT_OK
        // false-strip) means the AI didn't relay them, and the destructive drain
        // we did at the top of this handler would otherwise lose them forever.
        // Wrap every post-drain return through this helper so the failure paths
        // (timeout, no_response, empty text, AI error, stripHeartbeatToken silent)
        // automatically push the events back into the in-memory queue. The next
        // heartbeat (interval or wake) will retry. Sets cronEvents=[] after re-queue
        // so the catch block doesn't double-push if a later step throws.
        const respondAfterDrain = (
          resp: { status: string; text?: string; reason?: string },
          code?: number,
        ): Response => {
          if (cronEvents.length > 0 && resp.status !== 'content') {
            for (const e of cronEvents) pushSystemEvent(e);
            console.warn(
              `[im/heartbeat] Re-queued ${cronEvents.length} cron event(s) for retry (status=${resp.status}${resp.reason ? ` reason=${resp.reason}` : ''})`,
            );
            cronEvents = [];
          }
          return jsonResponse({ ...resp, messageEnqueued }, code);
        };

        try {
          const payload = await request.json() as {
            prompt: string;
            source: string;
            sourceId: string;
            ackMaxChars?: number;
            isHighPriority?: boolean;
            runtime?: RuntimeType;
            runtimeConfig?: RuntimeConfig;
            hostInteraction?: unknown;
            metadataBirthPending?: boolean;
            // v0.2.4: Rust-side authoritative cron events. When non-empty, this
            // payload is the truth source and REPLACES any cron events in the
            // sidecar's in-memory `systemEventQueue` (Rust survives sidecar
            // restarts; the queue does not). Non-cron events still flow through
            // the queue. Field is camelCase to match the Rust serde attr.
            pendingCronEvents?: Array<{
              event: string;
              taskId: string;
              content: string;
              timestamp: number;
              // PRD 0.2.18 Phase 3 — inbox envelope bridge fields (optional).
              // When present, buildCronEventRelayMessage wraps the cron content with
              // an `<inbox-message from="..." reply_back="false">` prefix so
              // the IM Bot AI can `myagents session send <fromSessionId>` to
              // follow up. Cron uses reply_back=false because the cron task
              // session is short-lived and doesn't await a reply.
              fromSessionId?: string;
              fromLabel?: string;
            }>;
          };

          if (!payload.prompt) {
            return respondAfterDrain({ status: 'silent', reason: 'empty' });
          }

          // --- Gate: Read HEARTBEAT.md from workspace root ---
          // The actual checklist lives in HEARTBEAT.md, not in config.
          // If the file body is empty/missing AND no system events → skip AI call.
          const heartbeatMdPath = join(currentAgentDir, 'HEARTBEAT.md');
          let heartbeatMdContent = '';
          try {
            const rawContent = readFileSync(heartbeatMdPath, 'utf-8');
            // Strip YAML frontmatter — only the body is used as prompt
            heartbeatMdContent = stripYamlFrontmatter(rawContent);
          } catch {
            // File doesn't exist — create with descriptive frontmatter
            try {
              const defaultHeartbeat = `---
description: >
  心跳清单 — Agent 按心跳间隔定时苏醒时会读取本文件的正文部分作为指令执行。
  正文为空时心跳会直接跳过，不请求 AI（节省 token）。
  你可以在正文中写入需要 Agent 定期检查的任务、监控项或提醒事项。
---
`;
              writeFileSync(heartbeatMdPath, defaultHeartbeat, 'utf-8');
              console.log(`[im/heartbeat] Created HEARTBEAT.md with frontmatter at ${heartbeatMdPath}`);
            } catch (writeErr) {
              console.warn(`[im/heartbeat] Failed to create HEARTBEAT.md: ${writeErr}`);
            }
          }

          // Drain pending system events from the in-memory queue. This is the
          // legacy transport buffer for non-cron events; cron events used to flow
          // here too but are now sourced from the request body (Rust truth).
          drainedEvents = drainSystemEvents();

          // Cron events come from two possible sources:
          //   - body.pendingCronEvents (Rust truth, v0.2.4+; durable across
          //     sidecar restarts, cleared from Rust on confirmed IM push)
          //   - systemEventQueue (legacy pre-v0.2.4 path; events that survived
          //     a partial migration or arrived via /api/im/system-event POSTs
          //     from older callers)
          //
          // We merge both sets, with body as the truth source for any taskId
          // that appears in both (Rust handles those — re-queuing the queue
          // copy would only duplicate the AI prompt). Queue cron events whose
          // taskId is NOT in the body are processed alongside as legacy work
          // and remain subject to the existing respondAfterDrain re-queue path
          // for at-least-once retry through the sidecar's own queue.
          const bodyCronEvents = (payload.pendingCronEvents ?? []).map(e => ({
            event: e.event,
            content: e.content,
            timestamp: e.timestamp,
            taskId: e.taskId,
            // PRD 0.2.18 Phase 3 — forward inbox envelope bridge fields
            fromSessionId: e.fromSessionId,
            fromLabel: e.fromLabel,
          }));
          const queueCronEventsAll = drainedEvents.filter(e => e.event === 'cron_complete');
          const otherEvents = drainedEvents.filter(e => e.event !== 'cron_complete');

          const bodyTaskIds = new Set(
            bodyCronEvents.map(e => e.taskId).filter((id): id is string => !!id),
          );
          const orphanQueueCron = queueCronEventsAll.filter(
            e => !e.taskId || !bodyTaskIds.has(e.taskId),
          );

          // CRITICAL: process AT MOST ONE cron event per heartbeat (across body
          // and queue combined). Reason: AI partial-relay defense — if we
          // batched N events into one prompt and the AI relayed only some, the
          // success path (Rust clears all body snapshot entries, sidecar drains
          // queue events) would silently drop the un-relayed ones. By forcing
          // exactly one event in the prompt, every "content" response
          // corresponds to exactly one ack-able delivery.
          //
          // Selection priority: body[0] > orphanQueueCron[0]. body events are
          // Rust-truth and will be re-shipped on subsequent heartbeats; orphan
          // queue events that lose this round are pushed back into the
          // sidecar queue immediately so the next heartbeat picks them up.
          let effectiveCronEvents: Array<{ event: string; content: string; timestamp: number; taskId?: string }> = [];

          if (bodyCronEvents.length > 0) {
            effectiveCronEvents = [bodyCronEvents[0]];
            // Any extra body events (Rust would only ship 1 in practice, but be
            // defensive in case the contract changes) go nowhere here — Rust
            // will resend them on the next heartbeat from its own pending vec.
            if (bodyCronEvents.length > 1) {
              console.log(
                `[im/heartbeat] Body shipped ${bodyCronEvents.length} cron events; processing first only (Rust resends rest)`,
              );
            }
            // Push orphan queue events back so they get a turn next heartbeat.
            // (We can't use the respondAfterDrain rollback path for them
            // because we're going to return 'content' — that's a "success" from
            // the queue's perspective, even though we didn't actually process
            // these orphan events this round.)
            for (const e of orphanQueueCron) pushSystemEvent(e);
            // No queue cron events left for the rollback helper to manage.
            cronEvents = [];
          } else if (orphanQueueCron.length > 0) {
            effectiveCronEvents = [orphanQueueCron[0]];
            // Push the rest back for next heartbeat.
            for (let i = 1; i < orphanQueueCron.length; i++) {
              pushSystemEvent(orphanQueueCron[i]);
            }
            // The one event we ARE processing must be visible to the
            // respondAfterDrain rollback path so silent/error responses re-queue
            // it (queue cron events are sidecar-owned and need this rollback to
            // survive; body cron events have Rust holding them already).
            cronEvents = [orphanQueueCron[0]];
          }
          // else: both empty → effectiveCronEvents stays [], cronEvents stays []

          // Skip AI call if HEARTBEAT.md is empty AND no system events of any kind.
          // Body-sourced cron events count too — Rust ships them when there's
          // pending work, so an empty HEARTBEAT.md plus zero events on both
          // sources means there is genuinely nothing to do.
          if (
            !heartbeatMdContent
            && drainedEvents.length === 0
            && bodyCronEvents.length === 0
          ) {
            console.log('[im/heartbeat] Skipped: HEARTBEAT.md is empty and no pending events');
            return respondAfterDrain({ status: 'silent', reason: 'empty_heartbeat_md' });
          }

          let enrichedPrompt: string;
          let alreadyWrappedSystemReminder = false;

          if (effectiveCronEvents.length > 0) {
            // Cron event prompt: completely replaces standard heartbeat prompt.
            // It already contains the hidden <system-reminder><HEARTBEAT> payload
            // plus a user-visible tail for the chat bubble.
            enrichedPrompt = buildCronEventRelayMessage(effectiveCronEvents);
            alreadyWrappedSystemReminder = true;
            // Push back non-cron events so they aren't lost — next heartbeat cycle will pick them up
            for (const e of otherEvents) {
              pushSystemEvent(e);
            }
          } else {
            // Standard heartbeat prompt (from Rust)
            enrichedPrompt = payload.prompt;
            if (otherEvents.length > 0) {
              const eventLines = otherEvents.map(
                e => `[System Event: ${neutralizeSystemReminderStructuralTags(e.event)}] ${neutralizeSystemReminderStructuralTags(e.content)}`
              ).join('\n');
              enrichedPrompt += `\n\n${eventLines}`;
            }
          }

          // Wrap ordinary heartbeat messages in <system-reminder><HEARTBEAT> tags.
          // Cron relay messages already carry that envelope and keep the visible
          // bubble text outside it.
          if (!alreadyWrappedSystemReminder) {
            enrichedPrompt = `<system-reminder>\n<HEARTBEAT>\n${enrichedPrompt}\n</HEARTBEAT>\n</system-reminder>`;
          }

          // Inject heartbeat prompt as user message. Ordinary heartbeat turns are
          // pure <system-reminder><HEARTBEAT> payloads; cron relay turns append a
          // short visible system notice after that hidden envelope.
          // System prompt is already permanently injected at IM session creation (/api/im/chat)
          // Heartbeat is unattended — bypass all permissions so tool use doesn't block.
          // Pass current model + providerEnv for consistency (undefined is also safe —
          // enqueueUserMessage treats it as "keep current provider" via pit-of-success semantics).
          let text = '';

          const engine = getSessionEngine();
          const runtimeConfig = payload.runtimeConfig ?? null;
          const activeRuntime = getActiveRuntimeType();
          const turnResult = await engine.runInjectedTurn({
            prompt: enrichedPrompt,
            sessionId: getRuntimeSessionIdForRequest(),
            workspacePath: agentDir,
            scenario: {
              type: 'agent-channel',
              platform: payload.source?.split('_')[0] ?? 'unknown',
              sourceType: payload.source?.includes('group') ? 'group' : 'private',
              hostInteraction: normalizeHostInteractionCapability(payload.hostInteraction),
            },
            metadataBirthPending: payload.metadataBirthPending === true,
            permissionMode: engine.kind === 'external'
              ? getRuntimeConfigPermissionMode(runtimeConfig, activeRuntime)
              : 'fullAgency',
            model: engine.kind === 'external'
              ? getRuntimeConfigModel(runtimeConfig, activeRuntime)
              : getSessionModel() ?? undefined,
            providerEnv: engine.kind === 'builtin' ? getSessionProviderEnv() : undefined,
            reasoningEffort: engine.kind === 'external'
              ? getRuntimeConfigReasoningEffort(runtimeConfig, activeRuntime)
              : undefined,
            runtimeConfig,
            metadata: {
              source: payload.source as SessionSource,
              sourceId: payload.sourceId,
            },
            analyticsOrigin: { kind: 'agent-channel', surface: 'channel_heartbeat' },
            assistantChannelDelivery: 'caller-owned',
            timeoutMs: 300000,
            pollMs: 500,
          });
          messageEnqueued = turnResult.enqueued === true;
          if (!turnResult.success) {
            return respondAfterDrain({
              status: 'error',
              text: turnResult.error
                ?? (turnResult.status === 408 ? 'Heartbeat timeout' : 'Heartbeat failed'),
            });
          }
          if (engine.kind === 'builtin' && turnResult.assistantMessagePresent === false) {
            return respondAfterDrain({ status: 'silent', reason: 'no_response' });
          }
          text = turnResult.text ?? '';

          // Guard: message was enqueued but assistant response is empty → AI failed to respond
          // (SDK wraps API errors as synthetic assistant messages with empty content in messages[])
          if (!text.trim()) {
            return respondAfterDrain({ status: 'error', text: 'AI did not respond' });
          }

          // Check HEARTBEAT_OK
          const ackMaxChars = payload.ackMaxChars ?? 300;
          const result = stripHeartbeatToken(text, ackMaxChars);

          // Note: when cron events were drained, a 'silent' result here means the AI
          // received the cron prompt but still replied with HEARTBEAT_OK (or empty
          // after strip). respondAfterDrain treats that as undelivered and re-queues
          // — the next heartbeat retries instead of silently dropping the daily report.
          return respondAfterDrain(result);
        } catch (error) {
          // Cron events represent durable work that MUST reach IM. On exception, even
          // if `messageEnqueued = true`, the AI relay didn't complete — re-queue them
          // unconditionally so the next heartbeat retries. The respondAfterDrain helper
          // clears `cronEvents` after handling its own re-queue path; if it ran first,
          // this no-ops.
          if (cronEvents.length > 0) {
            for (const e of cronEvents) pushSystemEvent(e);
            console.warn(`[im/heartbeat] Re-queued ${cronEvents.length} cron event(s) after exception`);
            cronEvents = [];
          }
          // Non-cron events: keep existing semantics — only re-queue if exception
          // happened before enqueueUserMessage (otherwise they're already in the AI's
          // prompt and re-queuing would duplicate).
          if (!messageEnqueued) {
            const others = drainedEvents.filter(e => e.event !== 'cron_complete');
            if (others.length > 0) {
              for (const e of others) pushSystemEvent(e);
              console.warn(`[im/heartbeat] Re-queued ${others.length} non-cron event(s) after pre-enqueue failure`);
            }
          }
          console.error('[im/heartbeat] Error:', error);
          return jsonResponse(
            {
              status: 'error',
              text: error instanceof Error ? error.message : 'Heartbeat error',
              messageEnqueued,
            },
            500,
          );
        }
      }

      // POST /api/memory/update — Trigger memory update in current session (v0.1.43)
      if (pathname === '/api/memory/update' && request.method === 'POST') {
        try {
          const payload = await request.json() as {
            source: 'auto' | 'manual';
            sessionId?: string;
            taskId?: string;
            queueId?: string;
          };
          const isAuto = payload.source === 'auto';
          const managementSessionId = payload.sessionId?.trim() ?? '';
          const taskId = payload.taskId?.trim() ?? '';
          const queueId = payload.queueId?.trim() ?? '';
          if (isAuto && (!managementSessionId || !taskId || !queueId)) {
            return jsonResponse(
              { status: 'error', reason: 'Auto memory update requires sessionId, taskId, and queueId' },
              400,
            );
          }

          // (issue #190 v0.2.15) Busy gate — refuse auto-injection when the
          // session is actively working. The Rust-side `lastActiveAt` cooldown
          // is only a disk-timestamp proxy and ages past its 15-min threshold
          // during a single long turn, so this check is the authoritative one.
          // Manual updates (user clicked the button) bypass — explicit user
          // intent is allowed to queue behind the active turn as expected.
          // Busy gate is runtime-aware: external (Codex/CC/Gemini) sessions track
          // in-flight work via isExternalSessionActive(); builtin via isSessionBusy().
          const engine = getSessionEngine();
          if (isAuto && engine.isBusy()) {
            console.log('[memory-update] Skipped: session busy (auto)');
            return jsonResponse({ status: 'skipped', reason: 'session_busy' });
          }

          // Read UPDATE_MEMORY.md from workspace root
          const updateMdPath = join(currentAgentDir, 'UPDATE_MEMORY.md');
          let rawContent = '';
          try {
            rawContent = readFileSync(updateMdPath, 'utf-8');
          } catch {
            return jsonResponse({ status: 'skipped', reason: 'file_not_found' });
          }

          // Strip YAML frontmatter
          const promptContent = stripYamlFrontmatter(rawContent);

          // Build the hidden official-workflow prompt. Empty UPDATE_MEMORY.md
          // body means there are no workspace-specific additions; it does not
          // disable the versioned myagents-memory-update system skill.
          const now = new Date().toLocaleString('en-US', {
            timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
            year: 'numeric', month: '2-digit', day: '2-digit',
            hour: '2-digit', minute: '2-digit', timeZoneName: 'short',
          });

          const completionMarker = MEMORY_UPDATE_COMPLETION_MARKER;
          const prompt = buildMemoryUpdateReminder({
            workspaceMemoryInstructions: promptContent,
            currentTime: now,
          });

          // Inject + run the <MEMORY_UPDATE> turn on the session's ACTUAL runtime.
          // Memory update is unattended, so it always runs at the runtime's max agency
          // (builtin 'fullAgency' / Codex 'no-restrictions' / CC 'bypassPermissions' /
          // Gemini 'yolo') so Bash/file tools (git commit, file writes) don't block on
          // approval.
          //
          // Routing is load-bearing: an external (Codex/CC/Gemini) session driven
          // through the builtin SDK path asks Claude Code to *resume* a session it never
          // created → "No conversation found with session ID" → 0 turns, no assistant
          // output, leaving an orphaned <MEMORY_UPDATE> user bubble and the memory
          // silently NOT updated. Runtime-specific injection now lives behind
          // SessionEngine, matching heartbeat, chat/send, and cron routing.
          //
          // 60 min timeout — memory update is slow for large sessions (loading 100K+
          // token context, reading log/topic files, writing updates, git commit+push).
          const MEMORY_UPDATE_TIMEOUT_MS = 3600000;
          const runtimeType = engine.kind === 'external' ? getActiveRuntimeType() : 'builtin';
          const runtimeSessionId = getRuntimeSessionIdForRequest();
          const taskDispatchGuard = isAuto
            ? createTaskDispatchGuard(taskId, queueId, managementSessionId)
            : undefined;
          const turnResult = await engine.runInjectedTurn({
            prompt,
            sessionId: runtimeSessionId,
            workspacePath: currentAgentDir,
            scenario: { type: 'desktop' },
            permissionMode: engine.kind === 'external'
              ? getMaxPermissionForRuntime(runtimeType)
              : 'fullAgency',
            model: engine.kind === 'builtin' ? getSessionModel() ?? undefined : undefined,
            providerEnv: engine.kind === 'builtin' ? getSessionProviderEnv() : undefined,
            analyticsOrigin: { kind: 'automation', surface: 'memory_update' },
            assistantChannelDelivery: 'none',
            timeoutMs: MEMORY_UPDATE_TIMEOUT_MS,
            pollMs: 1000,
            beforeDispatch: taskDispatchGuard,
            requiredSystemSkill: 'myagents-memory-update',
            ...(isAuto ? {
              queueId,
              turnOwner: { kind: 'task' as const, id: taskId },
            } : {}),
          });
          if (!turnResult.success && turnResult.status === 408) {
            console.warn('[memory-update] AI memory update timed out (60 min)');
            return jsonResponse({
              status: 'timeout',
              reason: turnResult.error ?? 'AI memory update timed out',
              ...(turnResult.terminationUnconfirmed ? { terminationUnconfirmed: true } : {}),
            });
          }
          if (!turnResult.success && !turnResult.enqueued) {
            console.warn(`[memory-update] ${engine.kind} enqueue rejected: ${turnResult.error}`);
            return jsonResponse({ status: 'error', reason: turnResult.error ?? `${engine.kind}_enqueue_failed` }, 500);
          }
          const turnOk = turnResult.success && turnResult.text?.trim() === completionMarker;

          // Gate `completed` on the turn actually succeeding. Previously this reported
          // success purely from waitForSessionIdle returning, so a turn that errored out
          // (the cross-runtime resume failure above, or any SDK/API error) still logged
          // false success — and Rust recorded "Session … updated successfully".
          if (turnOk) {
            console.log(`[memory-update] AI completed memory update (source=${payload.source}, runtime=${runtimeType})`);
            return jsonResponse({ status: 'completed' });
          }
          const failureReason = turnResult.success
            ? 'completion_marker_missing'
            : 'turn_failed';
          console.warn(`[memory-update] AI memory update turn failed (${failureReason})`);
          return jsonResponse({
            status: 'error',
            reason: failureReason,
            ...(turnResult.terminationUnconfirmed ? { terminationUnconfirmed: true } : {}),
          });
        } catch (error) {
          console.error('[memory-update] Error:', error);
          return jsonResponse(
            { status: 'error', reason: error instanceof Error ? error.message : 'Unknown error' },
            500,
          );
        }
      }

      // POST /api/im/system-event — Receive system events (e.g. cron task completion) for heartbeat relay
      if (pathname === '/api/im/system-event' && request.method === 'POST') {
        try {
          const { event, content, taskId } = (await request.json()) as {
            event: string;
            content: string;
            taskId?: string;
          };
          // Store in queue for next heartbeat to pick up
          pushSystemEvent({ event, content, timestamp: Date.now(), taskId });
          console.log(`[system-event] Queued: ${event} (queue size: ${systemEventQueue.length})`);
          return jsonResponse({ ok: true });
        } catch (_err) {
          return jsonResponse({ error: 'Invalid request' }, 400);
        }
      }

      // POST /api/im/permission-response — Handle IM user's permission decision (from approval card/button)
      // Auto-routes to external runtime when active (same pattern as /api/permission/respond).
      if (pathname === '/api/im/permission-response' && request.method === 'POST') {
        try {
          const payload = await request.json() as {
            requestId: string;
            decision: 'deny' | 'allow_once' | 'always_allow';
          };

          const success = await getPermissionResponseEngine().respondPermission(payload.requestId, payload.decision);

          return jsonResponse({ success });
        } catch (error) {
          console.error('[im/permission-response] Error:', error);
          return jsonResponse({ success: false, error: String(error) }, 500);
        }
      }

      // GET /api/im/session/:key/messages — Get messages for an IM session
      if (pathname.startsWith('/api/im/session/') && pathname.endsWith('/messages') && request.method === 'GET') {
        try {
          // Currently returns messages from the active session
          // In the future, could look up by session key
          const allMessages = getMessages();
          return jsonResponse({
            messages: allMessages.map(m => ({
              id: m.id,
              role: m.role,
              content: typeof m.content === 'string' ? m.content : m.content
                .filter((b: { type: string; text?: string }) => b.type === 'text')
                .map((b: { text?: string }) => b.text ?? '')
                .join('\n'),
              timestamp: m.timestamp,
              metadata: m.metadata,
            })),
          });
        } catch (error) {
          console.error('[im/session/messages] Error:', error);
          return jsonResponse(
            { success: false, error: error instanceof Error ? error.message : 'Messages error' },
            500,
          );
        }
      }

      // ============= END IM BOT API =============

      // ============= SESSION INBOX (PRD 0.2.18) =============
      //
      // Note: `myagents session send` CLI hits `/api/admin/session/send`
      // (handled by `routeAdminApi` → `handleAdminInbox`). The previous raw
      // route at `/api/session/inbox` was deleted (cross-review Architecture
      // flagged it as duplicate dead code — CLI never hit it).
      //
      // /api/inbox/drain remains as the internal sidecar-to-sidecar endpoint
      // that Rust `cmd_inbox_deliver` POSTs to.

      // POST /api/inbox/start — Fresh Session admission. Unlike ordinary
      // drain, this waits only for Runtime dispatch acceptance so prepared
      // metadata can commit/rollback atomically without waiting for terminal.
      if (pathname === '/api/inbox/start' && request.method === 'POST') {
        try {
          const body = (await request.json().catch(() => null)) as {
            agentId?: unknown;
            message?: unknown;
          } | null;
          const agentId = typeof body?.agentId === 'string' ? body.agentId : '';
          const message = body?.message as import('./inbox/types').PendingInboxMessage | undefined;
          if (!agentId || !message) {
            return jsonResponse({ accepted: false, reason: 'invalid body' }, 400);
          }

          // The target is the authority after Rust starts its Sidecar. Resolve
          // the Agent once here and verify this process owns that workspace.
          const { resolvePersistedAgentWorkspaceRegistry } = await import('./utils/agent-workspace-identity');
          const registry = await resolvePersistedAgentWorkspaceRegistry();
          const diagnostic = registry.diagnostics.find(item => item.agentIds.includes(agentId));
          const identity = registry.agentProjections.find(item => item.agentId === agentId);
          if (
            diagnostic
            || !identity
            || (identity.project && !isProjectVisibleToUser(identity.project))
            || (identity.project && isProjectArchived(identity.project))
          ) {
            return jsonResponse({ accepted: false, reason: 'target Agent is unavailable' }, 409);
          }
          const engine = getSessionEngine();
          const runtimeIdentity = engine.getRuntimeIdentity();
          const currentSessionContext = engine.getCurrentSessionContext();
          const currentWorkspacePath = currentSessionContext.workspacePath ?? currentAgentDir;
          if (
            currentSessionContext.sessionId !== message.toSessionId
            || !currentWorkspacePath
            || !workspacePathsEqual(currentWorkspacePath, identity.workspacePath)
          ) {
            return jsonResponse({ accepted: false, reason: 'target Sidecar identity mismatch' }, 409);
          }

          const { handleFreshSessionStart } = await import('./inbox/start-handler');
          const result = await handleFreshSessionStart(
            message,
            {
              sessionId: message.toSessionId,
              workspacePath: identity.workspacePath,
              agent: identity.agent as unknown as AgentConfig,
              runtime: runtimeIdentity.runtime,
              runtimeSource: runtimeIdentity.runtimeSource,
              managedCodexProviderReady: isManagedCodexProviderReady(registry.config),
            },
            (text, options) => engine.enqueueInboxMessage({
              text,
              sessionId: message.toSessionId,
              workspacePath: identity.workspacePath,
              scenario: { type: 'desktop' },
              inboxMeta: options.inboxMeta,
              analyticsOrigin: { kind: 'session-inbox', surface: 'session_send' },
              birthOrigin: { kind: 'session-inbox', surface: 'session_send' },
              queueId: options.queueId,
              beforeDispatch: options.beforeDispatch,
            }),
          );
          return jsonResponse(result, result.accepted === false ? 409 : 200);
        } catch (error) {
          console.error('[inbox/start] Error:', error);
          return jsonResponse(
            { accepted: false, reason: error instanceof Error ? error.message : String(error) },
            500,
          );
        }
      }

      // POST /api/inbox/drain — Internal endpoint: Rust pushes
      // PendingInboxMessage[] here after queuing in target sidecar's vec.
      // We unwrap, format the prompt, and enqueue via the appropriate runtime.
      if (pathname === '/api/inbox/drain' && request.method === 'POST') {
        try {
          const body = (await request.json().catch(() => null)) as {
            messages?: unknown[];
          } | null;
          if (!body || !Array.isArray(body.messages)) {
            return jsonResponse({ accepted: false, reason: 'invalid body' }, 400);
          }
          const { handleInboxDrain } = await import('./inbox/drain-handler');
          // PRD 0.2.18 cross-review fix (CC): workspacePath comes from THIS
          // sidecar's session metadata. process.cwd() is app bundle / `/`, and
          // MYAGENTS_AGENT_DIR env is not reliable for sidecar-to-sidecar inbox.
          const engine = getSessionEngine();
          const injector: import('./inbox/drain-handler').InboxInjector = async (text, inboxMeta, options) => {
            const sessionId = getRuntimeSessionIdForRequest();
            const sessionMeta = getSessionMetadata(sessionId);
            const inboxOrigin: SessionOrigin = options?.scenario?.type === 'registeredAgent'
              ? {
                  kind: 'registered-agent',
                  surface: 'space_issue_delivery',
                  context: {
                    spaceId: options.scenario.spaceId,
                    registeredAgentId: options.scenario.registeredAgentId,
                  },
                }
              : { kind: 'session-inbox', surface: 'session_send' };
            if (inboxOrigin.kind === 'registered-agent') {
              const originBinding = await engine.ensureRegisteredAgentSessionOrigin(sessionId, inboxOrigin);
              if (!originBinding.success) {
                return { queued: false, error: originBinding.error };
              }
            }
            return engine.enqueueInboxMessage({
              text,
              sessionId,
              workspacePath: sessionMeta?.agentDir ?? currentAgentDir ?? process.cwd(),
              scenario: options?.scenario,
              inboxMeta,
              allowLazySessionMaterialization: options?.allowLazySessionMaterialization,
              analyticsOrigin: inboxOrigin,
              birthOrigin: inboxOrigin,
            });
          };
          const result = await handleInboxDrain(
            body.messages as import('./inbox/types').PendingInboxMessage[],
            injector,
          );
          return jsonResponse(result, result.accepted ? 200 : 409);
        } catch (error) {
          console.error('[inbox/drain] Error:', error);
          return jsonResponse(
            { accepted: false, reason: error instanceof Error ? error.message : String(error) },
            500,
          );
        }
      }

      // ============= END SESSION INBOX =============

      // ============= OPENAI BRIDGE (Loopback, per-token) =============
      // PRD #124: each SDK subprocess registers under a unique token.
      // ANTHROPIC_BASE_URL = http://127.0.0.1:<port>/bridge/<token>, so the
      // CLI sends POSTs to /bridge/<token>/v1/messages. The handler resolves
      // the token via `bridge-registry` and routes to that subprocess's own
      // upstream — no shared global state, no cross-pollination between
      // concurrent SDK invocations.
      const bridgeMessagesMatch = pathname.match(/^\/bridge\/([^/]+)\/v1\/messages$/);
      if (bridgeMessagesMatch && request.method === 'POST') {
        const token = bridgeMessagesMatch[1];
        try {
          const handler = await ensureBridgeHandler();
          return await handler(request);
        } catch (error) {
          // The handler's getUpstreamConfig throws when the token is unknown
          // (subprocess unregistered, or routing was wrong) — surface as 400
          // so the SDK sees a clean error instead of a 500.
          const msg = error instanceof Error ? error.message : 'Bridge error';
          const isUnknownToken = msg.startsWith('Unknown bridge token');
          if (isUnknownToken) {
            console.warn(`[bridge] rejecting request with unknown token=${token}: ${msg}`);
            return jsonResponse(
              { type: 'error', error: { type: 'invalid_request_error', message: msg } },
              400,
            );
          }
          console.error('[bridge] Handler error:', error);
          return jsonResponse(
            { type: 'error', error: { type: 'api_error', message: msg } },
            500,
          );
        }
      }

      // POST /bridge/<token>/v1/messages/count_tokens — CLI sends this for
      // context window management. OpenAI-compatible APIs have no equivalent,
      // so we return an estimated token count without involving the upstream.
      // We still require a valid token so untokened callers can't probe.
      const bridgeCountMatch = pathname.match(/^\/bridge\/([^/]+)\/v1\/messages\/count_tokens$/);
      if (bridgeCountMatch && request.method === 'POST') {
        const { hasBridge } = await import('./openai-bridge/bridge-registry');
        const token = bridgeCountMatch[1];
        if (!hasBridge(token)) {
          return jsonResponse(
            { type: 'error', error: { type: 'invalid_request_error', message: `Unknown bridge token: ${token}` } },
            400,
          );
        }
        try {
          const body = await request.json() as { messages?: unknown[]; system?: unknown; tools?: unknown[] };
          const contentLength = JSON.stringify(body.messages ?? []).length
            + JSON.stringify(body.system ?? '').length
            + JSON.stringify(body.tools ?? []).length;
          const estimatedTokens = Math.max(1, Math.ceil(contentLength / 4));
          return jsonResponse({ input_tokens: estimatedTokens });
        } catch {
          return jsonResponse({ input_tokens: 1024 }); // Safe fallback
        }
      }

      const staticResponse = await serveStatic(pathname);
      if (staticResponse) {
        return staticResponse;
      }

      return new Response('Not Found', { status: 404 });
    }
  }

  // The same HTTP server serves both purposes — Tauri client proxies all
  // /api/* + /sessions/* + /chat/stream traffic here via Rust local_http;
  // browser dev mode (`start_dev.sh`) additionally hits the `serveStatic`
  // fallback to load the React `dist/` bundle. Naming reflects the
  // production primary role.
  console.log(`[startup] Sidecar HTTP server ready on http://127.0.0.1:${port}`);

  // Pattern 2 §2.3.1 — Start the periodic GC for spilled large-value refs.
  // Runs every 60s; reaps any ref past its TTL (default 1h). The timer is
  // unref'd inside startRefsGc, so it doesn't keep the event loop alive.
  void import('./utils/large-value-store').then(({ startRefsGc }) => {
    startRefsGc(60_000);
  }).catch((err) => {
    console.warn(`[refs] failed to start GC: ${err instanceof Error ? err.message : String(err)}`);
  });

  // ── Deferred heavy init ─────────────────────────────────────────────────
  // Runs AFTER honoServe has bound the port. Rust's TCP health check now
  // passes within ~50ms instead of waiting ~2s for all this work to finish.
  // Routes (except /health) consult DeferredInitState before running, so
  // anything that needs agent state (MCP, model, file watcher, bridge) is
  // admitted only after this block finishes.
  //
  // Order within this block still matters:
  //   1. migrations/cleanup — best-effort, can interleave
  //   2. socks bridge BEFORE initializeAgent (pre-warm spawns SDK which
  //      reads HTTP_PROXY env vars set by initSocksBridgeFromEnv)
  //   3. initializeAgent — the big one
  //   4. external runtime restore
  //   5. boot banner — prints with fully resolved state
  // Pattern 4: track which phase is running so /health/ready can report
  // {phase: 'migration' | 'skill-seed' | 'sdk-init' | ...} on failure.
  let currentInitPhase = 'startup';
  const deferredInitStarted = nowMs();
  let initPhaseStarted = deferredInitStarted;
  const emitDeferredPhaseDone = (phase: string) => {
    emitPerfTrace({
      trace: 'sidecar_boot',
      phase: 'deferred_init_phase_done',
      durationMs: elapsedMs(initPhaseStarted),
      status: 'ok',
      detail: { phase, port },
    });
  };
  emitPerfTrace({
    trace: 'sidecar_boot',
    phase: 'deferred_init_start',
    status: 'ok',
    detail: { port, sessionId: initialSessionId ?? 'new' },
  });
  void runDeferredInit(
    async () => {
      await runSidecarBootstrap(sidecarComposition, [
        {
          capability: 'global',
          run: async () => {
            currentInitPhase = 'cleanup';
            setDeferredInitPhase(currentInitPhase);
            initPhaseStarted = nowMs();
            // Retention and the one-time config scrub
            // are app-wide maintenance. Running them in every Session process
            // multiplied I/O and timers without adding authority.
            const collectActivePaths = (): ReadonlySet<string> => {
              const paths = new Set<string>();
              const u = getActiveUnifiedLogPath();
              if (u) paths.add(u);
              const s = getActiveSessionLogPath();
              if (s) paths.add(s);
              return paths;
            };
            runLogRetentionSweep({ activeFilePaths: collectActivePaths() });
            startPeriodicSweep(collectActivePaths);
            try {
              const { scrubStaleRuntimeConfig } = await import('./migrations/scrub-stale-runtime-config');
              const result = await scrubStaleRuntimeConfig();
              if (result.scannedAgents > 0) {
                console.log(`[migration] runtimeConfig scrub: scanned=${result.scannedAgents} scrubbed=${result.scrubbedAgents}`);
                for (const d of result.details) {
                  console.log(`[migration] runtimeConfig scrub: agent=${d.agentId} runtime=${d.runtime} dropped=${JSON.stringify(d.dropped)}`);
                }
              }
            } catch (err) {
              console.warn('[migration] runtimeConfig scrub failed (non-fatal):', err instanceof Error ? err.message : String(err));
            }
            emitDeferredPhaseDone('cleanup');
          },
        },
        {
          capability: 'common',
          run: () => {
            currentInitPhase = 'skill-seed';
            setDeferredInitPhase(currentInitPhase);
            initPhaseStarted = nowMs();
            // Keep seed/dir setup common: a Session may be the first process
            // after an app update and must see required bundled skills before
            // accepting a turn. These operations are idempotent initialization,
            // not recurring singleton maintenance.
            seedBundledSkills();
            console.log('[startup] seedBundledSkills done');
            ensurePluginsDirs();
            emitDeferredPhaseDone('skill-seed');
          },
        },
        {
          capability: 'common',
          run: async () => {
            currentInitPhase = 'socks-bridge';
            setDeferredInitPhase(currentInitPhase);
            initPhaseStarted = nowMs();
            await initSocksBridgeFromEnv();
            emitDeferredPhaseDone('socks-bridge');
          },
        },
        {
          capability: 'global',
          run: () => {
            startOAuthMaintenanceForSidecarRole('global');
          },
        },
        {
          capability: 'session',
          run: async () => {
            // Session processes observe app-global OAuth revisions but never
            // run the proactive singleton refresh scheduler.
            startOAuthMaintenanceForSidecarRole('session');

            // Install the title hook immediately before the only boot path
            // capable of completing a turn.
            installAutoTitleHook();

            currentInitPhase = 'sdk-init';
            setDeferredInitPhase(currentInitPhase);
            initPhaseStarted = nowMs();
            await initializeAgent(currentAgentDir, initialPrompt, initialSessionId, { preWarmDisabled: noPreWarm });
            console.log('[startup] initializeAgent done');
            emitDeferredPhaseDone('sdk-init');

            if (initialSessionId) {
              if (await restoreInitialExternalSessionAtSelector(initialSessionId, currentAgentDir)) {
                currentInitPhase = 'external-runtime-restore';
                setDeferredInitPhase(currentInitPhase);
                initPhaseStarted = nowMs();
                emitDeferredPhaseDone('external-runtime-restore');
              }
            }

            // ── Sidecar Boot Banner: single-line for AI grep ──
            const model = getSessionModel() || '?';
            const mcpList = getMcpServers();
            const mcpNames = mcpList ? Object.keys(mcpList).join(',') || 'none' : 'none';
            const bridge = hasActiveBridge() ? 'yes' : 'no';
            const { listBuiltinMcpIds } = await import('./tools/builtin-mcp-registry');
            const builtinMcpMeta = listBuiltinMcpIds().join(',') || 'none';
            console.log(`[boot] pid=${process.pid} port=${port} node=${process.versions.node} workspace=${currentAgentDir} session=${initialSessionId ?? 'new'} resume=${!!initialSessionId} model=${model} bridge=${bridge} mcp=${mcpNames} builtin-mcp-meta=${builtinMcpMeta}`);
          },
        },
      ]);

      emitPerfTrace({
        trace: 'sidecar_boot',
        phase: 'deferred_init_done',
        durationMs: elapsedMs(deferredInitStarted),
        status: 'ok',
        detail: { port, sessionId: initialSessionId ?? 'new' },
      });
    },
    () => currentInitPhase,
    (err) => {
      console.error('[startup] Deferred init failed:', err);
      console.warn(`[health-state] Deferred init failed in phase=${currentInitPhase}: ${err instanceof Error ? err.message : String(err)}`);
      emitPerfTrace({
        trace: 'sidecar_boot',
        phase: 'deferred_init_failed',
        durationMs: elapsedMs(deferredInitStarted),
        status: 'error',
        detail: {
          phase: currentInitPhase,
          port,
          error: err instanceof Error ? err.message : String(err),
        },
      });
    },
  );

  // Kick off interactive-shell PATH detection in the background.
  // `warmupShellPath()` uses async `execFile` so it never blocks the event loop
  // (unlike the old `execSync` path, which starved TCP accept for 3–5s while
  // zsh -i -l sourced a heavy .zshrc — Rust's sidecar health check would retry
  // 15× before finally connecting).
  //
  // Startup returns immediately; detected PATH is applied whenever the shell
  // finishes. `getShellEnv()` keeps returning the platform fallback PATH until
  // then — sufficient for common binary lookups (.myagents/bin, homebrew, nvm,
  // fnm, volta, pnpm, cargo all in fallback).
  import('./utils/shell').then(({ warmupShellPath, getShellPath }) => {
    warmupShellPath().then(() => {
      console.log('[server] Startup PATH:', getShellPath());
    });
  });
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});

import {
  ClientApp,
  ndJsonStream,
  RequestError,
  type ClientConnection,
  type CreateElicitationResponse,
  type ElicitationSchema,
  type NewSessionResponse,
  type ResumeSessionResponse,
  type PromptResponse,
  type McpServer,
  type RequestPermissionResponse,
  type SessionConfigOption,
  type SessionUpdate,
  type ToolCallUpdate,
} from "@agentclientprotocol/sdk/unstable";
import {
  antigravityBrainDirectory,
  readAntigravityChildren,
  type AntigravityChildSnapshot,
} from "./antigravity-children";
import { AntigravityChildTrace } from "./antigravity-child-trace";
import {
  extractAntigravityTaskUpdates,
  observeAntigravityBackgroundTasks,
  type AntigravityTaskLogSnapshot,
} from "./antigravity-tasks";
import { fingerprintSessionMcp } from "../session-core/mcp-sync-policy";
import { resolveRemoteMcpTransportConfig } from "../session-core/mcp-template-resolution";
import { buildMcpStdioLaunchConfig } from "../utils/mcp-command";
import { classifyToolAttachmentPresentation } from "../utils/tool-result-attachments";
import { MANAGED_BROWSER_MCP_ID } from "../../shared/browserTools";
import {
  acquireBrowserCapability,
  adoptBrowserProductSession,
} from "../browser-host/capability-client";
import { onOAuthCredentialChange, resolveAuthHeaders } from "../mcp-oauth";
import { supportsHostAskUserQuestion } from "../host-interaction";
import { classifyMcpFailure } from "../../shared/mcpFailure";
import type { McpEffectiveServerSnapshot } from "../../shared/mcpEffectiveState";
import { randomUUID } from "node:crypto";
import { homedir } from "node:os";
import { delimiter, join } from "node:path";
import type { McpServerDefinition } from "../../shared/config-types";
import { INTERNAL_CLI_TOKEN_ENV } from "../../shared/externalCliCapabilities";
import {
  ANTIGRAVITY_FULL_ACCESS,
  ANTIGRAVITY_PERMISSION_MODES,
  getDefaultRuntimePermissionMode,
  type RuntimeEnvPolicy,
  type RuntimeModelInfo,
} from "../../shared/types/runtime";
import {
  normalizeAntigravityFlatModels,
  splitAntigravityFlatModelId,
} from "../../shared/antigravityModelCatalog";
import type { AskUserQuestionAnswers } from "../../shared/types/askUserQuestion";
import { getSidecarPort } from "../session-core/sidecar-port";
import { ensureShellPath } from "../utils/shell";
import { maybeSpill, releaseLargeValueRef } from "../utils/large-value-store";
import { spawn, type SubprocessHandle } from "../utils/subprocess";
import { antigravityForm } from "./antigravity-form";
import { readAntigravityFileResult } from "./antigravity-native-result";
import { readAntigravityParentAcknowledgements, readAntigravityParentTailStep } from "./antigravity-parent-ack";
import { antigravityToolResult, presentAntigravityTool } from "./antigravity-tool";
import { augmentedProcessEnv, resolveCommand } from "./env-utils";
import { detectCliInstallation } from './cli-installation';
import {
  RuntimeSteerUnavailableError,
  type AgentRuntime,
  type ResolvedImagePayload,
  type RuntimeDetectionOptions,
  type RuntimeProcess,
  type RuntimeWatchdogState,
  type SessionStartOptions,
  type SubAgentScope,
  type UnifiedEvent,
  type UnifiedEventCallback,
} from "./types";
import {
  makeErrorAttachment,
  makePlaceholderAttachment,
  saveToolAttachment,
  trackInFlightSave,
} from "./tool-attachments";
import { killWithEscalation } from "./utils/kill-with-escalation";

const rpcDeadline = (ms = 30_000) => ({
  cancellationSignal: AbortSignal.timeout(ms),
  stopWaitingOnCancel: true,
});

async function executable(policy?: RuntimeEnvPolicy) {
  await ensureShellPath();
  const env = augmentedProcessEnv('antigravity', policy);
  return { env, path: resolveCommand("agy", env) };
}

function prependMyAgentsBinToPath(env: Record<string, string | undefined>): void {
  const isWindows = process.platform === "win32";
  const pathKey = isWindows ? "Path" : "PATH";
  const home = (isWindows ? env.USERPROFILE : env.HOME) || homedir();
  if (!home) return;
  const binDir = join(home, ".myagents", "bin");
  const currentPath = env[pathKey] ?? env.PATH ?? "";
  const existingEntries = currentPath.split(delimiter).filter(Boolean);
  const comparableBin = isWindows ? binDir.toLowerCase() : binDir;
  const filtered = existingEntries.filter(
    (entry) => (isWindows ? entry.toLowerCase() : entry) !== comparableBin,
  );
  delete env.PATH;
  delete env.Path;
  env[pathKey] = [binDir, ...filtered].join(delimiter);
}

function buildAntigravitySessionEnv(
  baseEnv: Record<string, string | undefined>,
  options: Pick<SessionStartOptions, "sessionId" | "workspacePath">,
): Record<string, string | undefined> {
  const sessionEnv: Record<string, string | undefined> = { ...baseEnv };
  prependMyAgentsBinToPath(sessionEnv);
  sessionEnv.PWD = options.workspacePath;
  sessionEnv.MYAGENTS_SESSION_ID = options.sessionId;
  const sidecarPort = getSidecarPort();
  if (sidecarPort > 0) {
    sessionEnv.MYAGENTS_PORT = String(sidecarPort);
  }
  const internalCliToken = process.env[INTERNAL_CLI_TOKEN_ENV]?.trim();
  if (internalCliToken) {
    sessionEnv[INTERNAL_CLI_TOKEN_ENV] = internalCliToken;
  }
  return sessionEnv;
}

async function queryCli(
  arg: string | string[],
  policy?: RuntimeEnvPolicy,
  signal?: AbortSignal,
) {
  const { path, env } = await executable(policy);
  const abort = AbortSignal.any([
    AbortSignal.timeout(arg === "models" ? 30_000 : 15_000),
    ...(signal ? [signal] : []),
  ]);
  abort.throwIfAborted();
  const args = Array.isArray(arg) ? arg : [arg];
  const help = args.includes("--help");
  const captureStderr = help || arg === "models";
  const child = spawn([path, ...args], {
    env,
    stdin: "ignore",
    stdout: "pipe",
    stderr: captureStderr ? "pipe" : "ignore",
  });
  const stop = () => child.kill("SIGKILL");
  abort.addEventListener("abort", stop, { once: true });
  try {
    const [code, output, stderr] = await Promise.all([
      child.exited,
      new Response(child.stdout).text(),
      captureStderr ? new Response(child.stderr).text() : Promise.resolve(""),
    ]);
    abort.throwIfAborted();
    if (code !== 0) {
      if (arg === "models" && /not authenticated|authentication required|not logged in|sign in|login required/i.test(stderr || output)) {
        throw new Error("请在终端运行 agy 并完成登录，然后重试");
      }
      throw new Error("无法执行 agy " + arg);
    }
    return { path, output: (output || (help ? stderr : "")).trim() };
  } finally {
    abort.removeEventListener("abort", stop);
  }
}

async function mcpServer(
  server: McpServerDefinition,
  http: boolean,
  sse: boolean,
  parentEnv: NodeJS.ProcessEnv,
): Promise<McpServer> {
  const pairs = (fields?: Record<string, string>) =>
    Object.entries(fields ?? {}).map(([name, value]) => ({ name, value }));
  if (
    server.type === "stdio" &&
    server.command &&
    !["__builtin__", "__browser_host__"].includes(server.command)
  ) {
    const launch = buildMcpStdioLaunchConfig(server, { parentEnv });
    return {
      name: server.id,
      command: launch.command,
      args: launch.args,
      env: pairs(launch.env),
    };
  }
  if (
    server.url &&
    ((server.type === "http" && http) || (server.type === "sse" && sse))
  ) {
    const transport = resolveRemoteMcpTransportConfig(server);
    if (
      !Object.keys(transport.headers).some(
        (key) => key.toLowerCase() === "authorization",
      )
    ) {
      Object.assign(transport.headers, await resolveAuthHeaders(server.id));
    }
    return {
      type: server.type,
      name: server.id,
      url: transport.url,
      headers: pairs(transport.headers),
    };
  }
  throw new Error("invalid configuration");
}

const ANTIGRAVITY_AUTH_RETRY_DELAYS_MS = [2_000, 5_000] as const;
const ANTIGRAVITY_MAX_TOTAL_AUTH_RETRIES_PER_TURN = 4;
const ANTIGRAVITY_AUTH_RETRY_PROMPT =
  "Continue from where you stopped. Use the conversation and tool results already in this session, and skip actions that are already complete.";
const ANTIGRAVITY_AUTH_EXHAUSTED_ERROR =
  "Antigravity 连续返回登录错误（HTTP 401），自动续跑未恢复。请检查 agy 登录状态后重试";

const ANTIGRAVITY_TRANSIENT_AUTH_WARNING_RE =
  /^⚠\s+UNAUTHENTICATED\s*\(code\s*401\):\s*Request had invalid authentication credentials\.\s*Expected OAuth 2 access token,\s*login cookie or other valid authentication credential\.(?:\s*See https:\/\/developers\.google\.com\/identity\/sign-in\/web\/devconsole-project\.)?$/i;

function isAntigravityTransientAuthWarning(text: string): boolean {
  // agy wraps this standalone warning in newlines. Preserve plain-text quotes.
  return text.startsWith("\n⚠ ") && text.endsWith("\n")
    && ANTIGRAVITY_TRANSIENT_AUTH_WARNING_RE.test(text.trim());
}

interface AntigravityTurnUsageTotals {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens?: number;
  cacheCreationTokens?: number;
}

export interface AntigravityRuntimeOptions {
  /** Override backoff delays (ms) for transient mid-turn HTTP 401 recovery (primarily for deterministic tests). */
  authRetryDelaysMs?: readonly number[];
}

type PermissionDecision = "allow_once" | "deny" | "always_allow";
type Pending = {
  cancel(): void;
  decide?(decision: PermissionDecision): void;
  choose?(optionId: string): void;
  answer?(answers: AskUserQuestionAnswers | null): void;
};
interface ModelState {
  currentModelId: string;
  availableModels: { modelId: string; name: string }[];
}
interface ModeState {
  currentModeId?: string;
  availableModes?: { id: string; name?: string }[];
}

function sanitizeNativeConfigMessage(message: string): string {
  const collapsed = message.replace(/\s+/g, " ").trim();
  return collapsed.length > 160 ? `${collapsed.slice(0, 157)}...` : collapsed;
}

function unsupportedConfigOptionError(
  configId: string,
  value: string,
  offered: readonly string[],
  detail?: string,
): Error {
  if (configId === "mode") {
    if (value === "auto") {
      return new Error(
        "当前环境的 Antigravity CLI 不支持「帮我批准（auto）」权限模式（Windows 需开启终端沙箱 / Windows 11 24H2+，或受账号/CLI 版本限制），请切换为「请求批准」或「完全访问权限」后重试",
      );
    }
    return new Error(
      offered.length > 0
        ? `当前 Antigravity CLI 不支持权限模式 "${value}"（当前可用：${offered.join("、")}），请切换权限模式后重试`
        : `当前 Antigravity CLI 不支持权限模式 "${value}"，请切换权限模式后重试`,
    );
  }
  if (configId === "thought_level") {
    return new Error(
      offered.length > 0
        ? `当前 Antigravity 模型不支持推理强度 "${value}"（当前可用：${offered.join("、")}）`
        : `当前 Antigravity 模型不支持设置推理强度 "${value}"`,
    );
  }
  return new Error(
    `Antigravity 不支持配置项 ${configId}="${value}"${detail ? `（${detail}）` : ""}`,
  );
}

type PromptSettlement =
  | { kind: "resolved"; result: PromptResponse }
  | { kind: "rejected"; error: unknown };
interface PromptRun {
  readonly settled: Promise<PromptSettlement>;
  readonly settle: (outcome: PromptSettlement) => void;
  readonly clientUserMessageId?: string;
  readonly steered: boolean;
  accepted: boolean;
  outcome?: PromptSettlement;
  supersededBy?: PromptRun;
  predecessorAwaitedAuth?: boolean;
}

class AntigravitySession implements RuntimeProcess {
  readonly connection: ClientConnection;
  sessionId = "";
  image = false;
  models?: ModelState;
  modes?: ModeState;
  config: SessionConfigOption[] = [];
  defaultModel?: string;
  selectedModel?: string;
  private readonly defaultThoughtLevels = new Map<string, string>();
  exited = false;
  initialized = false;
  earlyCommands?: {
    sessionId: string;
    update: Extract<
      SessionUpdate,
      { sessionUpdate: "available_commands_update" }
    >;
  };
  private turnKind: 'prompt' | 'continuation' | null = null;
  private activePrompt: PromptRun | null = null;
  private steering = false;
  private readonly pendingSteerUpdates: SessionUpdate[] = [];
  private canContinue = false;
  private readonly childLaunches = new Set<string>();
  private readonly childSnapshots = new Map<string, AntigravityChildSnapshot>();
  private readonly childTraces = new Map<string, AntigravityChildTrace>();
  private childPoll?: NodeJS.Timeout;
  private readonly activeBackgroundTasks = new Set<string>();
  private backgroundTaskLogSnapshots = new Map<string, AntigravityTaskLogSnapshot>();
  private lastTaskMessageTimestamp = 0;
  private backgroundTaskPoll?: NodeJS.Timeout;
  private taskFilesObservable = false;
  private lastAsyncProgressAt = 0;
  private lastReplyText = '';
  private parentPlannerStep = -1;
  private readonly settledParentReplies: string[] = [];
  private acknowledgedChildReports = new Set<string>();
  get active() {
    return this.turnKind !== null;
  }
  private dispatched?: { resolve(): void; reject(reason: unknown): void };
  private stream: "text" | "thinking" | null = null;
  private turnId = "";
  private thinkingIndex = 0;
  private promptCancellationRequested = false;
  private heldTransientAuthWarning: string | null = null;
  private authRetryTimer?: NodeJS.Timeout;
  private authRetryAbortCleanup?: () => void;
  private consecutiveAuthRetries = 0;
  private totalAuthRetries = 0;
  private turnUsage?: AntigravityTurnUsageTotals;
  private readonly tools = new Map<string, { snapshot: ToolCallUpdate; visibleOutput: string }>();
  private readonly pendingReadResults = new Map<string, Extract<UnifiedEvent, { kind: "tool_result" }>>();
  private readonly deniedTools = new Set<string>();
  readonly pending = new Map<string, Pending>();
  constructor(
    private readonly child: SubprocessHandle,
    readonly emit: UnifiedEventCallback,
    readonly sessionMcpFingerprint: string,
    readonly scenario: SessionStartOptions["scenario"],
    readonly productSessionId: string,
    readonly skipPermissions: boolean,
    private readonly brainDirectory: string,
    private readonly authRetryDelaysMs: readonly number[] = ANTIGRAVITY_AUTH_RETRY_DELAYS_MS,
  ) {
    const app = new ClientApp();
    app.onNotification("session/update", ({ params }) => {
      if (
        params.update.sessionUpdate === "available_commands_update" &&
        !this.initialized
      ) {
        this.earlyCommands = {
          sessionId: params.sessionId,
          update: params.update,
        };
        return;
      }
      if (params.sessionId !== this.sessionId) return;
      if (params.update.sessionUpdate === "available_commands_update") {
        this.publishCommands(params.update);
      } else if (
        params.update.sessionUpdate === "session_info_update" &&
        params.update.title
      ) {
        this.emit({ kind: "runtime_title", title: params.update.title });
      } else if (params.update.sessionUpdate === "config_option_update")
        this.config = params.update.configOptions;
      else if (
        params.update.sessionUpdate === "current_mode_update" &&
        this.modes
      )
        this.modes = { ...this.modes, currentModeId: params.update.currentModeId };
      else this.receiveUpdate(params.update);
    });
    app.onRequest("session/request_permission", ({ params, signal }) => {
      if (
        params.sessionId !== this.sessionId ||
        !["desktop", "im", "agent-channel"].includes(this.scenario.type) ||
        (!this.active && !this.startContinuation())
      )
        return { outcome: { outcome: "cancelled" } };
      return new Promise<RequestPermissionResponse>((resolve) => {
        const id = randomUUID();
        let inputRefId: string | undefined;
        const finish = (response: RequestPermissionResponse) => {
          this.pending.delete(id);
          signal.removeEventListener("abort", expired);
          if (inputRefId) void releaseLargeValueRef(inputRefId);
          resolve(response);
        };
        const cancel = () => finish({ outcome: { outcome: "cancelled" } });
        const permissionOptions = params.options.map(({ optionId, name, kind }) => ({
          optionId, name, kind,
        }));
        const choose = (optionId: string) => {
          const option = permissionOptions.find((candidate) => candidate.optionId === optionId);
          if (!option) throw new Error("Antigravity 审批选项与当前请求不匹配");
          if (option.kind === "reject_once" || option.kind === "reject_always")
            this.deniedTools.add(params.toolCall.toolCallId);
          finish({ outcome: { outcome: "selected", optionId } });
        };
        const decide = (decision: PermissionDecision) => {
          const kind = {
            allow_once: "allow_once",
            always_allow: "allow_always",
            deny: "reject_once",
          }[decision];
          const options = permissionOptions.filter((option) => option.kind === kind);
          if (options.length === 1) choose(options[0].optionId);
          else cancel();
        };
        const expired = () => {
          cancel();
          this.emit({
            kind: "interactive_request_resolved",
            requestId: id,
            status: "cancelled",
          });
        };
        this.pending.set(id, { cancel, decide, choose });
        signal.addEventListener("abort", expired, { once: true });
        this.confirmActiveSteeredPrompt();
        const tool = params.toolCall;
        const { toolName, input } = presentAntigravityTool(tool);
        void maybeSpill(JSON.stringify(input), {
          mimetype: "application/json",
          inlineMaxBytes: 65_536,
          previewBytes: 0,
          sessionId: this.productSessionId,
          ttlMs: Number.MAX_SAFE_INTEGER - Date.now(),
        }).then((payload) => {
          const inputRef = "inline" in payload ? undefined : payload;
          if (!this.pending.has(id)) {
            if (inputRef) void releaseLargeValueRef(inputRef.id);
            return;
          }
          inputRefId = inputRef?.id;
          this.emit({
            kind: "permission_request",
            requestId: id,
            toolUseId: tool.toolCallId,
            toolName,
            input,
            ...(inputRef ? { inputRef } : {}),
            permissionOptions,
            interactionKind: "permission",
            suppressAlwaysAllowRule: !permissionOptions.some(
              (option) => option.kind === "allow_always",
            ),
          });
        }, () => {
          if (!this.pending.has(id)) return;
          cancel();
          this.emit({
            kind: "log",
            level: "error",
            message: "无法加载 Antigravity 审批详情，已取消该审批",
          });
        });
      });
    });
    app.onRequest("elicitation/create", ({ params, signal }) => {
      if (
        !(
          this.scenario.type === "desktop" ||
          supportsHostAskUserQuestion(this.scenario)
        ) ||
        !("sessionId" in params) ||
        params.sessionId !== this.sessionId ||
        params.mode !== "form" ||
        (!this.active && !this.startContinuation())
      )
        return { action: "cancel" };
      const form = antigravityForm(
        params.requestedSchema as ElicitationSchema,
        params.message,
      );
      if (!form) {
        this.emit({
          kind: "log",
          level: "warn",
          message: "Antigravity 请求了当前问答卡不支持的表单格式",
        });
        return { action: "decline" };
      }
      return new Promise<CreateElicitationResponse>((resolve) => {
        const id = randomUUID();
        const finish = (response: CreateElicitationResponse) => {
          this.pending.delete(id);
          signal.removeEventListener("abort", expired);
          resolve(response);
        };
        const cancel = () => finish({ action: "cancel" });
        const expired = () => {
          cancel();
          this.emit({
            kind: "interactive_request_resolved",
            requestId: id,
            status: "cancelled",
          });
        };
        this.pending.set(id, {
          cancel,
          decide: () => finish({ action: "decline" }),
          answer: (answers) =>
            answers
              ? finish({ action: "accept", content: form.decode(answers) })
              : cancel(),
        });
        signal.addEventListener("abort", expired, { once: true });
        this.confirmActiveSteeredPrompt();
        this.emit({
          kind: "permission_request",
          requestId: id,
          toolUseId:
            typeof params.toolCallId === "string" ? params.toolCallId : id,
          toolName: "AskUserQuestion",
          input: { questions: form.questions },
          interactionKind: "ask_user",
          suppressAlwaysAllowRule: true,
        });
      });
    });
    const transport = ndJsonStream(
      new WritableStream({
        write: (chunk) => child.stdin!.write(chunk),
        close: () => child.stdin!.end(),
      }),
      child.stdout!,
    );
    const writer = transport.writable.getWriter();
    this.connection = app.connect({
      readable: transport.readable,
      writable: new WritableStream({
        write: async (frame) => {
          await writer.write(frame);
          if ("method" in frame && frame.method === "session/prompt")
            this.dispatched?.resolve();
        },
        close: () => writer.close(),
        abort: (reason) => writer.abort(reason),
      }),
    });
    void child.exited.then(() => {
      this.exited = true;
      if (!this.promptCancellationRequested) this.flushHeldTransientAuthWarning();
      this.clearAuthRetry();
      this.emitAccumulatedTurnUsage();
      this.pendingSteerUpdates.length = 0;
      this.cancelPendingSteers();
      this.activePrompt = null;
      this.finishBackgroundWork();
      this.connection.close();
      this.cancelPending();
      if (this.initialized)
        this.emit({
          kind: "session_complete",
          subtype: "error",
          result: "Antigravity CLI 已退出",
        });
    });
  }
  publishCommands(
    update: Extract<
      SessionUpdate,
      { sessionUpdate: "available_commands_update" }
    >,
  ) {
    this.emit({
      kind: "runtime_commands",
      commands: update.availableCommands.map((c) => ({
        name: c.name,
        description: c.description,
        ...(c.input?.hint ? { argumentHint: c.input.hint } : {}),
        source: "sdk",
      })),
    });
  }
  get pid() {
    return this.child.pid;
  }
  writeLine(line: string) {
    return this.child.stdin!.write(line + "\n");
  }
  kill(signal?: number) {
    this.child.kill(signal);
  }
  waitForExit() {
    return this.child.exited;
  }
  cancelPending() {
    for (const [id, item] of this.pending) {
      item.cancel();
      this.emit({
        kind: "interactive_request_resolved",
        requestId: id,
        status: "cancelled",
      });
    }
  }
  hasPendingBackgroundWork(): boolean {
    return [...this.childLaunches].some((id) => {
      const child = this.childSnapshots.get(id);
      return !child || child.status === "running" ||
        (child.deliveredAt !== undefined && (!child.reportId || !this.acknowledgedChildReports.has(child.reportId)));
    });
  }
  getWatchdogState(): RuntimeWatchdogState {
    const hasInFlightTool = [...this.tools.values()].some(
      ({ snapshot }) => snapshot.status !== "completed" && snapshot.status !== "failed",
    );
    return {
      activeAsyncWork:
        hasInFlightTool ||
        (this.taskFilesObservable && this.activeBackgroundTasks.size > 0) ||
        this.hasPendingBackgroundWork(),
      ...(this.lastAsyncProgressAt > 0
        ? { lastAsyncProgressAt: this.lastAsyncProgressAt }
        : {}),
    };
  }
  private observeBackgroundTasksFromTool(content: string) {
    if (!this.sessionId || !content) return;
    const { active, settled } = extractAntigravityTaskUpdates(this.sessionId, content);
    let changed = false;
    for (const slug of active) {
      if (!this.activeBackgroundTasks.has(slug)) {
        this.activeBackgroundTasks.add(slug);
        changed = true;
      }
    }
    for (const slug of settled) {
      if (this.activeBackgroundTasks.delete(slug)) {
        this.backgroundTaskLogSnapshots.delete(slug);
        changed = true;
      }
    }
    if (changed) {
      this.lastAsyncProgressAt = Date.now();
    }
    if (this.activeBackgroundTasks.size > 0) {
      this.scheduleBackgroundTaskObservation();
    } else if (this.backgroundTaskPoll) {
      clearTimeout(this.backgroundTaskPoll);
      this.backgroundTaskPoll = undefined;
    }
  }
  private scheduleBackgroundTaskObservation() {
    if (this.backgroundTaskPoll || this.exited || !this.active || this.activeBackgroundTasks.size === 0) {
      return;
    }
    const poll = setTimeout(async () => {
      try {
        const observation = await observeAntigravityBackgroundTasks(
          this.brainDirectory,
          this.sessionId,
          this.activeBackgroundTasks,
          this.backgroundTaskLogSnapshots,
          this.lastTaskMessageTimestamp,
        );
        if (this.backgroundTaskPoll !== poll || this.exited) return;
        this.taskFilesObservable = observation.filesObservable;
        this.backgroundTaskLogSnapshots = observation.nextLogSnapshots;
        this.lastTaskMessageTimestamp = observation.latestMessageTimestamp;
        for (const slug of observation.settledTaskIds) {
          this.activeBackgroundTasks.delete(slug);
        }
        if (observation.progressed) {
          this.lastAsyncProgressAt = Date.now();
        }
      } catch {
        if (this.backgroundTaskPoll === poll) this.taskFilesObservable = false;
      } finally {
        if (this.backgroundTaskPoll === poll) {
          this.backgroundTaskPoll = undefined;
          if (this.active && this.activeBackgroundTasks.size > 0 && !this.exited) {
            this.scheduleBackgroundTaskObservation();
          }
        }
      }
    }, 1_500);
    this.backgroundTaskPoll = poll;
    poll.unref();
  }
  private stopBackgroundTaskPoll() {
    if (this.backgroundTaskPoll) clearTimeout(this.backgroundTaskPoll);
    this.backgroundTaskPoll = undefined;
  }
  private clearBackgroundTasks() {
    this.stopBackgroundTaskPoll();
    this.activeBackgroundTasks.clear();
    this.taskFilesObservable = false;
    this.backgroundTaskLogSnapshots.clear();
  }
  private observeDelegation(toolUseId: string) {
    this.childLaunches.add(toolUseId);
    this.lastAsyncProgressAt = Date.now();
    this.scheduleChildObservation();
  }
  private scheduleChildObservation() {
    if (this.childPoll || this.exited) return;
    const poll = setTimeout(async () => {
      const wasPending = this.hasPendingBackgroundWork();
      try {
        const snapshots = await readAntigravityChildren(this.brainDirectory, this.sessionId, this.childLaunches);
        if (this.childPoll !== poll || this.exited) return;
        const reportIds = new Set(snapshots.flatMap(child => child.reportId ? [child.reportId] : []));
        if (this.settledParentReplies.length || reportIds.size) {
          const acknowledgement = readAntigravityParentAcknowledgements(
            this.brainDirectory, this.sessionId, this.settledParentReplies, reportIds, this.parentPlannerStep,
          );
          this.parentPlannerStep = acknowledgement.plannerStep;
          this.settledParentReplies.splice(0, acknowledgement.matchedReplies);
          for (const id of acknowledgement.acknowledgedReportIds) this.acknowledgedChildReports.add(id);
        }
        for (const child of snapshots) {
          if (!this.childLaunches.has(child.toolCallId)) continue;
          const previous = this.childSnapshots.get(child.toolCallId);
          this.childSnapshots.set(child.toolCallId, child);
          if (!previous || previous.status === "running") {
            let trace = this.childTraces.get(child.sessionId);
            if (!trace) {
              trace = new AntigravityChildTrace(child);
              this.childTraces.set(child.sessionId, trace);
            }
            trace.observe(this.brainDirectory, (event) => {
              this.lastAsyncProgressAt = Date.now();
              this.emit(event);
            });
          }
          if (previous?.status === child.status && previous?.deliveredAt === child.deliveredAt) continue;
          this.lastAsyncProgressAt = Date.now();
          this.emit({
            kind: "subagent_lifecycle", parentToolUseId: child.toolCallId, agentId: child.sessionId,
            status: child.status, startedAt: child.startedAt, observedAt: child.finishedAt ?? Date.now(),
            description: child.role, agentType: child.agentType, result: child.result,
            mode: "continuable", affectsRootActivity: false,
          });
        }
      } catch {
        this.emit({ kind: "log", level: "warn", message: "Antigravity 子 Agent 状态读取失败" });
      } finally {
        if (this.childPoll === poll) {
          this.childPoll = undefined;
          if (this.hasPendingBackgroundWork()) this.scheduleChildObservation();
          else if (wasPending) this.emit({ kind: "background_work_settled" });
        }
      }
    }, 400);
    this.childPoll = poll;
    poll.unref();
  }
  finishBackgroundWork() {
    if (this.childPoll) clearTimeout(this.childPoll);
    this.childPoll = undefined;
    this.clearBackgroundTasks();
    for (const child of this.childSnapshots.values()) {
      if (child.status !== "running") continue;
      this.emit({ kind: "subagent_lifecycle", parentToolUseId: child.toolCallId,
        status: "interrupted", observedAt: Date.now(), affectsRootActivity: false });
    }
    this.childLaunches.clear();
    this.childSnapshots.clear();
    this.childTraces.clear();
    this.acknowledgedChildReports.clear();
    this.settledParentReplies.length = 0;
  }
  private closeBlock() {
    if (this.stream === "text") this.emit({ kind: "text_stop" });
    if (this.stream === "thinking")
      this.emit({ kind: "thinking_stop", index: this.thinkingIndex });
    this.stream = null;
  }
  private receiveUpdate(update: SessionUpdate) {
    const kind = update.sessionUpdate;
    // Antigravity emits a final context snapshot after each unsolicited reply.
    // A standalone usage update changes the context indicator, never the transcript,
    // and cannot confirm consumption of a specific steered prompt.
    if (kind === "usage_update") {
      this.update(update);
      if (this.turnKind === "continuation" && ![...this.tools.values()].some(({ snapshot }) =>
        snapshot.status !== "completed" && snapshot.status !== "failed"
      )) this.finishTurn("completed");
      return;
    }
    if (
      this.activePrompt?.supersededBy &&
      this.activePrompt.supersededBy.outcome === undefined &&
      !(kind === "tool_call_update" && this.tools.has(update.toolCallId)) &&
      (kind === "agent_message_chunk" ||
        kind === "agent_thought_chunk" ||
        kind === "tool_call" ||
        kind === "tool_call_update" ||
        kind === "plan")
    ) {
      this.pendingSteerUpdates.push(update);
      return;
    }
    if (!this.active) {
      if (kind === "tool_call_update" && this.tools.has(update.toolCallId)) {
        this.update(update);
        return;
      }
      if (kind !== "agent_message_chunk" && kind !== "agent_thought_chunk" && kind !== "tool_call") return;
      if (!this.startContinuation()) return;
    }
    if (
      this.activePrompt?.steered &&
      !this.activePrompt.accepted &&
      !this.promptCancellationRequested &&
      !(kind === "agent_message_chunk" && update.content.type === "text" &&
        isAntigravityTransientAuthWarning(update.content.text)) &&
      !(kind === "tool_call_update" && this.tools.has(update.toolCallId)) &&
      (kind === "agent_message_chunk" ||
        kind === "agent_thought_chunk" ||
        kind === "tool_call" ||
        kind === "tool_call_update" ||
        kind === "plan")
    ) {
      this.confirmActiveSteeredPrompt();
    }
    this.update(update);
  }
  private flushPendingSteerUpdates() {
    if (!this.pendingSteerUpdates.length) return;
    const queued = this.pendingSteerUpdates.splice(0);
    for (const update of queued) {
      this.update(update);
    }
  }
  private startContinuation(): boolean {
    if (!this.initialized || !this.canContinue || this.exited) return false;
    this.beginTurn('continuation');
    this.emit({
      kind: "root_turn_admitted",
      origin: "collaboration",
      clientOperationId: this.turnId,
      runtimeTurnId: this.turnId,
    });
    return true;
  }
  isAwaitingAuthRetry(): boolean {
    return this.authRetryTimer !== undefined;
  }
  clearAuthRetry() {
    if (this.authRetryTimer) {
      clearTimeout(this.authRetryTimer);
      this.authRetryTimer = undefined;
    }
    this.authRetryAbortCleanup?.();
    this.authRetryAbortCleanup = undefined;
    this.heldTransientAuthWarning = null;
  }
  private accumulateTurnUsage(usage: PromptResponse["usage"] | undefined) {
    if (!usage) return;
    const outputTokens = usage.outputTokens + (usage.thoughtTokens ?? 0);
    if (!this.turnUsage) {
      this.turnUsage = {
        inputTokens: usage.inputTokens,
        outputTokens,
        cacheReadTokens: usage.cachedReadTokens ?? undefined,
        cacheCreationTokens: usage.cachedWriteTokens ?? undefined,
      };
      return;
    }
    this.turnUsage.inputTokens += usage.inputTokens;
    this.turnUsage.outputTokens += outputTokens;
    if (usage.cachedReadTokens !== undefined && usage.cachedReadTokens !== null) {
      this.turnUsage.cacheReadTokens =
        (this.turnUsage.cacheReadTokens ?? 0) + usage.cachedReadTokens;
    }
    if (usage.cachedWriteTokens !== undefined && usage.cachedWriteTokens !== null) {
      this.turnUsage.cacheCreationTokens =
        (this.turnUsage.cacheCreationTokens ?? 0) + usage.cachedWriteTokens;
    }
  }
  private emitAccumulatedTurnUsage() {
    if (!this.turnUsage) return;
    const usage = this.turnUsage;
    this.turnUsage = undefined;
    this.emit({
      kind: "usage",
      // agy reports this prompt's Gemini counters. Cached input
      // and thinking are reported separately from regular tokens.
      semantics: "delta",
      inputTokens: usage.inputTokens,
      outputTokens: usage.outputTokens,
      cacheReadTokens: usage.cacheReadTokens,
      cacheCreationTokens: usage.cacheCreationTokens,
    });
  }
  private emitTextChunk(text: string) {
    if (this.stream !== "text") {
      this.publishReadResults();
      this.closeBlock();
      this.stream = "text";
      this.lastReplyText = "";
    }
    if (this.childLaunches.size) this.lastReplyText += text;
    this.emit({ kind: "text_delta", text });
  }
  private flushHeldTransientAuthWarning() {
    if (this.heldTransientAuthWarning === null) return;
    const held = this.heldTransientAuthWarning;
    this.heldTransientAuthWarning = null;
    this.consecutiveAuthRetries = 0;
    this.emitTextChunk(held);
  }
  private beginTurn(kind: 'prompt' | 'continuation') {
    if (kind === 'prompt' && !this.hasPendingBackgroundWork()) {
      this.finishBackgroundWork();
      this.parentPlannerStep = readAntigravityParentTailStep(this.brainDirectory, this.sessionId);
    }
    this.clearAuthRetry();
    this.turnKind = kind;
    this.promptCancellationRequested = false;
    this.turnId = randomUUID();
    this.lastReplyText = '';
    this.consecutiveAuthRetries = 0;
    this.totalAuthRetries = 0;
    this.turnUsage = undefined;
    this.tools.clear();
    this.deniedTools.clear();
    if (this.activeBackgroundTasks.size > 0) {
      this.scheduleBackgroundTaskObservation();
    }
  }
  private finishTurn(status: string, error?: string) {
    if (!this.promptCancellationRequested) this.flushHeldTransientAuthWarning();
    this.clearAuthRetry();
    this.emitAccumulatedTurnUsage();
    this.pendingSteerUpdates.length = 0;
    this.publishReadResults(true);
    this.closeBlock();
    this.cancelPending();
    this.cancelPendingSteers();
    this.turnKind = null;
    if (status === "completed") {
      this.stopBackgroundTaskPoll();
    } else {
      this.clearBackgroundTasks();
    }
    this.activePrompt = null;
    this.canContinue = status === "completed";
    if (!this.canContinue) {
      this.finishBackgroundWork();
    } else if (this.childLaunches.size && this.lastReplyText.trim()) {
      this.settledParentReplies.push(this.lastReplyText);
    }
    this.emit({ kind: "turn_complete", status, error });
  }
  async cancelTurn() {
    if (!this.turnKind) return;
    if (this.isAwaitingAuthRetry()) {
      this.finishTurn("cancelled");
      return;
    }
    const turnId = this.turnId;
    // ACP cancel is a notification. Record intent before its write can race the prompt result.
    if (this.turnKind === "prompt") this.promptCancellationRequested = true;
    await this.connection.agent.notify("session/cancel", { sessionId: this.sessionId });
    if (this.turnId !== turnId || !this.active) return;
    if (this.turnKind === "continuation") this.finishTurn("cancelled");
    else this.cancelPending();
  }
  canSteer(): boolean {
    return (
      !this.exited &&
      !this.connection.signal.aborted &&
      this.turnKind === "prompt" &&
      this.activePrompt !== null &&
      !this.steering &&
      !this.promptCancellationRequested &&
      this.pending.size === 0 &&
      !this.hasPendingBackgroundWork()
    );
  }
  private publishReadResults(turnEnded = false) {
    for (const [id, result] of this.pendingReadResults) {
      const content = readAntigravityFileResult(this.brainDirectory, this.sessionId, id);
      if (content === undefined && !turnEnded) continue;
      this.pendingReadResults.delete(id);
      this.emit({ ...result, content: content ?? result.content });
    }
  }
  private updateTool(update: ToolCallUpdate, subAgent?: SubAgentScope) {
    const id = update.toolCallId;
    const prior = this.tools.get(id);
    if (prior?.snapshot.status === "completed" || prior?.snapshot.status === "failed") return;
    const tool = { ...prior?.snapshot, ...update, name: update.name ?? prior?.snapshot.name };
    const { toolName, input } = presentAntigravityTool(tool);
    const { result, metadata } = antigravityToolResult(tool, toolName);
    const state = { snapshot: tool, visibleOutput: prior?.visibleOutput ?? "" };
    this.tools.set(id, state);
    if (!prior) {
      if (!subAgent) this.closeBlock();
      this.emit({ kind: "tool_use_start", toolUseId: id, toolName, input, subAgent });
    }
    if (tool.status !== "completed" && tool.status !== "failed") {
      // ACP content arrays are replacement snapshots. Preserve that boundary even
      // when a tool rewrites or clears its output while it is still running.
      if (result !== state.visibleOutput || tool.status !== prior?.snapshot.status) {
        this.emit({ kind: "tool_result_update", toolUseId: id,
          content: result, status: tool.status ?? undefined, subAgent });
        state.visibleOutput = result;
      }
      return;
    }

    this.emit({ kind: "tool_use_stop", toolUseId: id, input, subAgent });
    if (toolName === "CollabAgent" && tool.status === "completed") this.observeDelegation(id);
    if (!subAgent && result) this.observeBackgroundTasksFromTool(result);
    const presentation = classifyToolAttachmentPresentation(tool.name ?? toolName);
    const attachments = tool.content?.flatMap((part) => {
      if (part.type !== "content") return [];
      const media = part.content;
      const payload = media.type === "image" || media.type === "audio"
        ? { data: media.data, mimeType: media.mimeType }
        : media.type === "resource" && "blob" in media.resource
          ? { data: media.resource.blob, mimeType: media.resource.mimeType ?? "application/octet-stream" }
          : null;
      if (!payload) return [];
      const ctx = {
        sessionId: this.productSessionId,
        turnId: this.turnId,
        toolUseId: id,
        mimeType: payload.mimeType,
        producedBy: "antigravity",
      };
      const { attachment, pendingId } = makePlaceholderAttachment(ctx);
      trackInFlightSave(
        saveToolAttachment({ kind: "base64", data: payload.data }, ctx)
          .catch((error) => makeErrorAttachment(ctx, error, pendingId))
          .then((saved) => this.emit({ kind: "tool_attachment_update",
            toolUseId: id, pendingId, attachment: presentation === "process" ? { ...saved, presentation } : saved })),
      );
      return [presentation === "process" ? { ...attachment, presentation } : attachment];
    });
    const declined = this.deniedTools.delete(id);
    const terminal: Extract<UnifiedEvent, { kind: "tool_result" }> = {
      kind: "tool_result", toolUseId: id, content: result,
      metadata: { ...metadata, ...(declined && tool.status === "failed" ? { status: "declined" } : {}) },
      attachments, subAgent,
      isError: tool.status === "failed" || (metadata.exitCode !== undefined && metadata.exitCode !== 0),
    };
    if (toolName === "Read" && !subAgent && !result && !attachments?.length && tool.status === "completed") {
      this.pendingReadResults.set(id, terminal);
      this.publishReadResults();
      return;
    }
    this.emit(terminal);
  }
  private update(update: SessionUpdate) {
    switch (update.sessionUpdate) {
      case "agent_message_chunk": {
        if (update.content.type !== "text") return;
        this.flushHeldTransientAuthWarning();
        if (
          this.turnKind === "prompt" &&
          !this.isAwaitingAuthRetry() &&
          isAntigravityTransientAuthWarning(update.content.text)
        ) {
          this.heldTransientAuthWarning = update.content.text;
          return;
        }
        this.consecutiveAuthRetries = 0;
        this.emitTextChunk(update.content.text);
        break;
      }
      case "agent_thought_chunk": {
        if (update.content.type !== "text") return;
        this.flushHeldTransientAuthWarning();
        if (this.stream !== "thinking") {
          this.publishReadResults();
          this.closeBlock();
          this.stream = "thinking";
          this.emit({ kind: "thinking_start", index: ++this.thinkingIndex });
        }
        this.emit({
          kind: "thinking_delta",
          text: update.content.text,
          index: this.thinkingIndex,
        });
        break;
      }
      case "tool_call":
      case "tool_call_update":
        this.flushHeldTransientAuthWarning();
        if (update.sessionUpdate === "tool_call") {
          this.consecutiveAuthRetries = 0;
        }
        this.updateTool(update);
        break;
      case "usage_update":
        this.emit({
          kind: "context_update",
          contextOccupiedTokens: update.used,
          runtimeContextWindow: update.size,
        });
        break;

      case "plan":
        this.emit({
          kind: "agent_plan_update",
          todos: update.entries.map((e, i) => ({
            key: String(i),
            content: e.content,
            activeForm: e.content,
            status: e.status,
          })),
        });
        break;
    }
  }
  private createPromptRun(options?: { clientUserMessageId?: string; steered?: boolean }): PromptRun {
    let settle!: (outcome: PromptSettlement) => void;
    const settled = new Promise<PromptSettlement>((resolve) => {
      settle = resolve;
    });
    return {
      settled,
      settle,
      clientUserMessageId: options?.clientUserMessageId,
      steered: options?.steered === true,
      accepted: options?.steered !== true,
    };
  }
  private buildPromptBlocks(message: string, images: ResolvedImagePayload[] = []) {
    return [
      { type: "text" as const, text: message },
      ...images.map((i) => ({
        type: "image" as const,
        mimeType: i.mimeType,
        data: i.data,
      })),
    ];
  }
  private finishPromptResult(result: PromptResponse) {
    switch (result.stopReason) {
      case "end_turn": this.finishTurn("completed"); break;
      case "cancelled": this.finishTurn("cancelled"); break;
      case "max_tokens": this.finishTurn("failed", "Antigravity 已达到此轮输出长度上限"); break;
      case "max_turn_requests": this.finishTurn("failed", "Antigravity 已达到此轮请求次数上限"); break;
      case "refusal": this.finishTurn("failed", "Antigravity 模型拒绝继续此轮请求"); break;
      default: this.finishTurn("failed", "Antigravity 返回了未知的结束状态");
    }
  }
  private confirmSteeredPrompt(run: PromptRun) {
    if (!run.steered || run.accepted) return;
    run.accepted = true;
    this.publishReadResults();
    this.closeBlock();
    this.emit({
      kind: "user_message_accepted",
      clientUserMessageId: run.clientUserMessageId,
    });
  }
  private confirmActiveSteeredPrompt() {
    if (this.activePrompt && !this.promptCancellationRequested) this.confirmSteeredPrompt(this.activePrompt);
  }
  private cancelUnconfirmedSteeredPrompt(run: PromptRun) {
    if (!run.steered || run.accepted || !run.clientUserMessageId) return;
    run.accepted = true;
    this.emit({
      kind: "user_message_cancelled",
      clientUserMessageId: run.clientUserMessageId,
    });
  }
  private cancelPendingSteers() {
    const run = this.activePrompt;
    if (!run) return;
    this.cancelUnconfirmedSteeredPrompt(run);
    if (run.supersededBy) this.cancelUnconfirmedSteeredPrompt(run.supersededBy);
  }
  private settleActivePrompt(run: PromptRun, outcome: PromptSettlement) {
    if (this.promptCancellationRequested) {
      this.finishTurn("cancelled");
      return;
    }
    if (outcome.kind === "resolved") {
      if (outcome.result.stopReason === "cancelled") {
        this.cancelUnconfirmedSteeredPrompt(run);
      } else {
        this.confirmSteeredPrompt(run);
      }
      if (outcome.result.stopReason === "end_turn" && this.heldTransientAuthWarning !== null) {
        this.retryAfterAuthWarning();
        return;
      }
      this.finishPromptResult(outcome.result);
      return;
    }
    const retryPredecessor = run.predecessorAwaitedAuth && !run.accepted;
    this.cancelUnconfirmedSteeredPrompt(run);
    if (retryPredecessor && !this.connection.signal.aborted && !this.exited) {
      this.retryAfterAuthWarning();
      return;
    }
    if (!this.exited) {
      this.finishTurn("failed", nativeError(outcome.error, "session/prompt").message);
    }
  }
  private handoffSteeredPrompt(next: PromptRun, yieldedCleanly: boolean) {
    // Before either response, ambiguous updates belong to the predecessor unless
    // the successor is first to settle. Later updates belong to the predecessor.
    if (!next.outcome) this.flushPendingSteerUpdates();
    if (yieldedCleanly && this.heldTransientAuthWarning !== null) {
      next.predecessorAwaitedAuth = true;
      this.heldTransientAuthWarning = null;
    } else if (!this.promptCancellationRequested) {
      this.flushHeldTransientAuthWarning();
    }
    this.activePrompt = next;
    if (next.outcome) {
      if (
        next.outcome.kind === "resolved" &&
        next.outcome.result.stopReason !== "cancelled" &&
        !this.promptCancellationRequested
      ) {
        this.confirmSteeredPrompt(next);
      }
      this.flushPendingSteerUpdates();
      this.settleActivePrompt(next, next.outcome);
      return;
    }
    // An unanswered permission/question that remains open across a clean
    // predecessor yield belongs to the successor prompt.
    if (yieldedCleanly && this.pending.size > 0 && !this.promptCancellationRequested) {
      this.confirmSteeredPrompt(next);
    }
  }
  private retryAfterAuthWarning() {
    this.heldTransientAuthWarning = null;
    if (
      this.consecutiveAuthRetries >= this.authRetryDelaysMs.length ||
      this.totalAuthRetries >= ANTIGRAVITY_MAX_TOTAL_AUTH_RETRIES_PER_TURN
    ) {
      this.finishTurn("failed", ANTIGRAVITY_AUTH_EXHAUSTED_ERROR);
      return;
    }
    const delayMs = this.authRetryDelaysMs[this.consecutiveAuthRetries]!;
    this.consecutiveAuthRetries += 1;
    this.totalAuthRetries += 1;
    this.publishReadResults();
    this.closeBlock();
    this.activePrompt = null;
    console.warn(
      `[antigravity] Transient HTTP 401 mid-turn (session=${this.productSessionId}); retrying silently (${this.consecutiveAuthRetries}/${this.authRetryDelaysMs.length}, total=${this.totalAuthRetries}/${ANTIGRAVITY_MAX_TOTAL_AUTH_RETRIES_PER_TURN}) in ${delayMs}ms`,
    );
    const turnId = this.turnId;
    const isCurrentTurn = () => !this.exited && this.turnKind === "prompt" && this.turnId === turnId;
    const failDisconnected = () => {
      if (isCurrentTurn()) {
        this.finishTurn(
          "failed",
          nativeError(new Error("ACP connection closed during auth retry"), "session/prompt").message,
        );
      }
    };
    if (this.connection.signal.aborted) {
      failDisconnected();
      return;
    }
    this.connection.signal.addEventListener("abort", failDisconnected, { once: true });
    this.authRetryAbortCleanup = () => {
      this.connection.signal.removeEventListener("abort", failDisconnected);
    };
    this.authRetryTimer = setTimeout(() => {
      this.authRetryTimer = undefined;
      this.authRetryAbortCleanup?.();
      this.authRetryAbortCleanup = undefined;
      if (!isCurrentTurn()) return;
      if (this.connection.signal.aborted) {
        failDisconnected();
        return;
      }
      const run = this.createPromptRun();
      this.activePrompt = run;
      this.sendPromptRpc(run, ANTIGRAVITY_AUTH_RETRY_PROMPT, []);
    }, delayMs);
  }
  private sendPromptRpc(
    run: PromptRun,
    message: string,
    images: ResolvedImagePayload[],
    options?: {
      parent?: PromptRun;
      dispatched?: { resolve(): void; reject(reason: unknown): void };
    },
  ) {
    void this.connection.agent
      .request<PromptResponse>("session/prompt", {
        sessionId: this.sessionId,
        prompt: this.buildPromptBlocks(message, images),
      })
      .then(
        (result) => {
          if (this.activePrompt === run || options?.parent?.supersededBy === run) {
            this.accumulateTurnUsage(result.usage);
          }
          const outcome: PromptSettlement = { kind: "resolved", result };
          run.outcome = outcome;
          if (this.activePrompt === run) {
            if (run.supersededBy) {
              const next = run.supersededBy;
              run.supersededBy = undefined;
              if (result.stopReason === "cancelled" || this.promptCancellationRequested) {
                this.cancelUnconfirmedSteeredPrompt(run);
              } else {
                this.confirmSteeredPrompt(run);
              }
              this.handoffSteeredPrompt(next, result.stopReason === "end_turn");
              run.settle(outcome);
              return;
            }
            run.settle(outcome);
            this.settleActivePrompt(run, outcome);
            return;
          }
          // `run` resolved before its predecessor settled. Keep `parent.supersededBy`
          // intact so `parent`'s settlement hands off and applies `run.outcome`.
          run.settle(outcome);
        },
        (e) => {
          const error = nativeError(e, "session/prompt");
          options?.dispatched?.reject(error);
          const outcome: PromptSettlement = { kind: "rejected", error: e };
          run.outcome = outcome;
          if (this.activePrompt === run) {
            if (run.supersededBy && !this.exited && !this.connection.signal.aborted) {
              const next = run.supersededBy;
              run.supersededBy = undefined;
              this.cancelUnconfirmedSteeredPrompt(run);
              this.handoffSteeredPrompt(next, false);
              run.settle(outcome);
              return;
            }
            run.settle(outcome);
            this.settleActivePrompt(run, outcome);
            return;
          }
          if (options?.parent?.supersededBy === run) {
            options.parent.supersededBy = undefined;
            this.flushPendingSteerUpdates();
          }
          run.settle(outcome);
        },
      );
  }
  async prompt(message: string, images: ResolvedImagePayload[] = []) {
    if (this.active || this.connection.signal.aborted)
      throw new Error("Antigravity 会话当前无法接收消息");
    if (images.length && !this.image)
      throw new Error("当前 Antigravity CLI 不支持图片输入");
    this.beginTurn('prompt');
    const run = this.createPromptRun();
    this.activePrompt = run;
    let dispatched!: { resolve(): void; reject(reason: unknown): void };
    const written = new Promise<void>((resolve, reject) => {
      dispatched = { resolve, reject };
      this.dispatched = dispatched;
    });
    this.sendPromptRpc(run, message, images, { dispatched });
    try {
      await written;
    } finally {
      if (this.dispatched === dispatched) this.dispatched = undefined;
    }
  }
  async steer(
    message: string,
    images: ResolvedImagePayload[] = [],
    clientUserMessageId?: string,
  ) {
    if (this.exited || this.connection.signal.aborted)
      throw new Error("Antigravity CLI 已退出");
    if (images.length && !this.image)
      throw new Error("当前 Antigravity CLI 不支持图片输入");
    if (!this.canSteer())
      throw new RuntimeSteerUnavailableError("Antigravity 当前轮次无法实时插入消息");
    const previous = this.activePrompt!;
    const next = this.createPromptRun({ clientUserMessageId, steered: true });
    previous.supersededBy = next;
    this.steering = true;
    this.sendPromptRpc(next, message, images, { parent: previous });
    try {
      const winner = await Promise.race([
        previous.settled.then((outcome) => ({ source: "previous" as const, outcome })),
        next.settled.then((outcome) => ({ source: "next" as const, outcome })),
      ]);
      if (winner.source === "next") {
        if (winner.outcome.kind === "rejected") {
          if (isAntigravitySteerUnavailableError(winner.outcome.error))
            throw new RuntimeSteerUnavailableError(
              winner.outcome.error instanceof Error
                ? winner.outcome.error.message
                : String(winner.outcome.error),
            );
          throw nativeError(winner.outcome.error, "session/prompt");
        }
        // `next` resolved before `previous` settled; wait for `previous` so
        // handoff applies `next`'s real terminal in chronological order.
        await previous.settled;
        return;
      }
      if (this.exited || this.connection.signal.aborted)
        throw new Error("Antigravity CLI 已退出");
      if (
        this.promptCancellationRequested &&
        this.activePrompt === next
      ) {
        await this.connection.agent
          .notify("session/cancel", { sessionId: this.sessionId })
          .catch(() => undefined);
      }
    } finally {
      this.steering = false;
    }
  }
  selectOptions(id: string) {
    const entry = this.config.find((o) => o.id === id);
    if (!entry || entry.type !== "select") return [];
    return entry.options.flatMap((group) =>
      "options" in group ? group.options : [group],
    );
  }
  hasConfigOption(id: string) {
    return this.config.some((entry) => entry.id === id);
  }
  selectedOption(id: string) {
    const option = this.config.find((entry) => entry.id === id);
    return option?.type === "select" ? option.currentValue : undefined;
  }
  offeredPermissionModes(): string[] {
    const fromConfig = this.selectOptions("mode").map((option) => option.value);
    if (fromConfig.length > 0) return fromConfig;
    return (this.modes?.availableModes ?? [])
      .map((mode) => mode.id)
      .filter((id): id is string => typeof id === "string" && id.length > 0);
  }
  selectedPermissionMode(): string | undefined {
    return this.selectedOption("mode") ?? this.modes?.currentModeId ?? undefined;
  }
  modelFamilies() {
    return this.selectOptions("model");
  }
  getCurrentModel() {
    return this.selectedOption("model") ?? this.selectedModel ?? this.models?.currentModelId;
  }
  captureDefaultThoughtLevel(model = this.getCurrentModel()) {
    // Keep the native starting value before the user overrides it. Selecting
    // the same model again can leave an existing thought-level override applied.
    const thoughtLevel = this.selectedOption("thought_level");
    if (model && thoughtLevel && !this.defaultThoughtLevels.has(model)) {
      this.defaultThoughtLevels.set(model, thoughtLevel);
    }
  }
  getDefaultThoughtLevel() {
    const model = this.getCurrentModel();
    return model ? this.defaultThoughtLevels.get(model) : undefined;
  }
  legacyFlatModelForFamily(familyId: string, effort?: string) {
    const models = (this.models?.availableModels ?? []).map((model) => ({
      value: model.modelId,
      displayName: model.name,
    }));
    const family = normalizeAntigravityFlatModels(models)
      .find((model) => model.value === familyId && model.supportedReasoningEfforts?.length);
    if (!family) return undefined;
    const targetEffort = effort ?? family.defaultReasoningEffort;
    return models.find(({ value }) => {
      const variant = splitAntigravityFlatModelId(value);
      return variant?.familyId === familyId && variant.effort === targetEffort;
    })?.value;
  }
  requiresPermissionModeRestart(mode: string | undefined) {
    return this.skipPermissions !== (mode === ANTIGRAVITY_FULL_ACCESS);
  }
  async setOption(configId: string, value: string) {
    const result = await this.connection.agent
      .request(
        "session/set_config_option",
        { sessionId: this.sessionId, configId, value },
        rpcDeadline(),
      )
      .catch((error) => {
        const offered =
          configId === "mode"
            ? this.offeredPermissionModes()
            : this.selectOptions(configId).map((option) => option.value);
        const code = error instanceof RequestError ? error.code : undefined;
        const detail =
          error instanceof RequestError
            ? sanitizeNativeConfigMessage(error.message)
            : undefined;
        console.warn(
          `[antigravity] session/set_config_option failed: configId=${configId} value=${value} offered=[${offered.join(",")}] code=${code ?? "unknown"}${detail ? ` detail=${JSON.stringify(detail)}` : ""}`,
        );
        if (error instanceof RequestError && error.code === -32602) {
          throw unsupportedConfigOptionError(configId, value, offered, detail);
        }
        throw nativeError(error, `session/set_config_option(${configId})`);
      });
    this.config = result.configOptions;
    if (this.selectedOption(configId) !== value)
      throw new Error("Antigravity 未应用 " + configId);
  }
}

function isAntigravitySteerUnavailableError(error: unknown): boolean {
  return (
    error instanceof RequestError &&
    /waiting for a permission or question answer/i.test(error.message)
  );
}
function nativeError(error: unknown, method: string) {
  if (error instanceof RequestError) {
    if (error.code === -32000 && /auth/i.test(error.message))
      return new Error("请在终端运行 agy 并完成登录，然后重试");
    if (/quota|capacity|resource.exhausted|rate.limit|429/i.test(error.message))
      return new Error("Antigravity 账号额度不足或请求过于频繁，请稍后重试");
    if (/network|unavailable|connection|timeout/i.test(error.message))
      return new Error("Antigravity 服务暂时无法连接，请检查网络后重试");
    if (method === "session/resume")
      return new Error(
        "Antigravity 未能恢复原生会话。聊天记录已保留，请检查登录账号后重试",
      );
    return new Error(
      "Antigravity " + method + " 失败（ACP " + error.code + "）",
    );
  }
  return new Error("Antigravity " + method + " 连接失败，请检查本机 agy CLI");
}
function session(process: RuntimeProcess) {
  if (!(process instanceof AntigravitySession))
    throw new Error("Invalid Antigravity process");
  return process;
}

export class AntigravityRuntime implements AgentRuntime {
  readonly type = "antigravity";
  private readonly authRetryDelaysMs: readonly number[];
  constructor(options?: AntigravityRuntimeOptions) {
    this.authRetryDelaysMs = options?.authRetryDelaysMs ?? ANTIGRAVITY_AUTH_RETRY_DELAYS_MS;
  }
  getPermissionModes() {
    return ANTIGRAVITY_PERMISSION_MODES;
  }
  getConfigCapabilities() {
    return {
      model: "live_session_rpc",
      permissionMode: "live_session_rpc",
      reasoningEffort: "live_session_rpc",
    } as const;
  }
  async detect(options?: RuntimeDetectionOptions) {
    const { path, env } = await executable();
    return detectCliInstallation(path, env, options);
  }
  async queryModels(
    options?: Parameters<AgentRuntime["queryModels"]>[0],
  ): Promise<RuntimeModelInfo[]> {
    if (options?.process) {
      const s = session(options.process);
      options.signal?.throwIfAborted();
      const currentModel = s.getCurrentModel();
      const currentReasoningEffort = s.selectedOption("thought_level");
      const liveReasoningEfforts = s.selectOptions("thought_level")
        .map((option) => ({ reasoningEffort: option.value, description: option.name }));
      const families = s.modelFamilies();
      const modelOptions = families.length
        ? families
        : (s.models?.availableModels ?? []).map((model) => ({
            value: model.modelId,
            name: model.name,
          }));
      const defaultReasoningEffort = s.getDefaultThoughtLevel();
      return modelOptions.map((model) => ({
        value: model.value,
        displayName: model.name,
        ...(model.value === s.defaultModel ? { isDefault: true } : {}),
        ...(model.value === currentModel ? {
          isCurrent: true,
          ...(liveReasoningEfforts.length ? { supportedReasoningEfforts: liveReasoningEfforts } : {}),
          ...(currentReasoningEffort !== undefined ? { currentReasoningEffort } : {}),
          ...(defaultReasoningEffort !== undefined ? { defaultReasoningEffort } : {}),
        } : {}),
      }));
    }
    const { output } = await queryCli(
      "models",
      options?.envPolicy,
      options?.signal,
    );
    const rawEntries = output.split(/\r?\n/).flatMap((line) => {
      const [value, displayName] = line.split("\t").map((part) => part.trim());
      return value && displayName ? [{ value, displayName }] : [];
    });
    return normalizeAntigravityFlatModels(rawEntries);
  }
  async startSession(options: SessionStartOptions, emit: UnifiedEventCallback) {
    const { path, env: resolvedEnv } = await executable(options.envPolicy);
    const env = buildAntigravitySessionEnv(resolvedEnv, options);
    const skipPermissions = options.permissionMode === ANTIGRAVITY_FULL_ACCESS;
    const args = [path, "acp", "--process-per-session"];
    if (skipPermissions) args.push("--dangerously-skip-permissions");
    const child = spawn(args, {
      env,
      cwd: options.workspacePath,
      stdin: "pipe",
      stdout: "pipe",
      stderr: "ignore",
      detached: process.platform !== "win32",
      windowsHide: true,
    });
    const s = new AntigravitySession(
      child,
      emit,
      fingerprintSessionMcp(options.mcpServers ?? []),
      options.scenario,
      options.sessionId,
      skipPermissions,
      antigravityBrainDirectory(env),
      this.authRetryDelaysMs,
    );
    const agent = s.connection.agent;
    let phase = "initialize";
    try {
      const hello = await agent.request(
        "initialize",
        {
          protocolVersion: 1,
          clientInfo: { name: "MyAgents", version: "1" },
          clientCapabilities:
            options.scenario.type === "desktop" ||
            supportsHostAskUserQuestion(options.scenario)
              ? { elicitation: { form: {} } }
              : {},
        },
        rpcDeadline(),
      );
      if (hello.protocolVersion !== 1)
        throw new Error("Antigravity 需要 ACP v1");
      const caps = hello.agentCapabilities ?? {};
      s.image = caps.promptCapabilities?.image === true;
      if (options.resumeSessionId && !caps.sessionCapabilities?.resume)
        throw new Error("当前 Antigravity CLI 不支持恢复会话");
      if (
        options.systemPromptAppend &&
        !(
          caps._meta?.antigravity as
            | { systemPrompt?: { append?: boolean } }
            | undefined
        )?.systemPrompt?.append
      )
        throw new Error("当前 Antigravity CLI 不支持 MyAgents 场景指令");
      const servers: McpServer[] = [];
      const projected: McpEffectiveServerSnapshot[] = [];
      for (const definition of options.mcpServers ?? []) {
        const status = {
          id: definition.id,
          desired: true,
          toolCount: 0,
          attemptGeneration: 1,
          updatedAt: Date.now(),
        };
        try {
          let server = definition;
          if (
            definition.id === MANAGED_BROWSER_MCP_ID &&
            definition.command === "__browser_host__"
          ) {
            await adoptBrowserProductSession(options.sessionId);
            const capability = await acquireBrowserCapability();
            server = {
              ...definition,
              type: "http",
              url: capability.url,
              headers: { Authorization: "Bearer " + capability.token },
            };
          }
          servers.push(
            await mcpServer(
              server,
              !!caps.mcpCapabilities?.http,
              !!caps.mcpCapabilities?.sse,
              env,
            ),
          );
          projected.push({ ...status, state: "unreported" });
        } catch (error) {
          const errorCode = classifyMcpFailure(error);
          projected.push({
            ...status,
            state: errorCode === "MCP_NEEDS_AUTH" ? "needs_auth" : "failed",
            errorCode,
          });
        }
      }
      const params = {
        cwd: options.workspacePath,
        mcpServers: servers,
        _meta: {
          antigravity: {
            systemPrompt: { append: options.systemPromptAppend ?? "" },
          },
        },
      };
      phase = options.resumeSessionId ? "session/resume" : "session/new";
      const opened = options.resumeSessionId
        ? await agent.request<ResumeSessionResponse>(
            "session/resume",
            { ...params, sessionId: options.resumeSessionId },
            rpcDeadline(60_000),
          )
        : await agent.request<NewSessionResponse>(
            "session/new",
            params,
            rpcDeadline(60_000),
          );
      s.sessionId =
        options.resumeSessionId ||
        ("sessionId" in opened && typeof opened.sessionId === "string"
          ? opened.sessionId
          : "");
      if (!s.sessionId) throw new Error("Antigravity 没有返回会话 ID");
      s.models = (opened as { models?: ModelState }).models;
      s.modes = (opened as { modes?: ModeState }).modes;
      s.config = opened.configOptions ?? [];
      s.defaultModel = s.getCurrentModel();
      s.captureDefaultThoughtLevel();
      phase = "session/config";
      if (options.model) await this.setModel(s, options.model);
      if (options.reasoningEffort) {
        const effort = options.reasoningEffort;
        if (!(await this.applyReasoningEffort(s, effort))) {
          const offered = s.selectOptions("thought_level").map((option) => option.value);
          if (options.requireReasoningEffort) {
            throw unsupportedConfigOptionError("thought_level", effort, offered);
          }
          console.warn(
            `[antigravity] Ignoring unsupported persisted reasoningEffort='${effort}' for model='${s.getCurrentModel() ?? "(unknown)"}'; offered=[${offered.join(",")}]`,
          );
        }
      }
      await this.setPermissionMode(s, options.permissionMode);
      emit({
        kind: "session_init",
        sessionId: s.sessionId,
        model: options.model ?? s.getCurrentModel() ?? "",
        tools: [],
        supportsImageInput: s.image,
      });
      s.initialized = true;
      if (s.earlyCommands?.sessionId === s.sessionId)
        s.publishCommands(s.earlyCommands.update);
      s.earlyCommands = undefined;
      const mcpDispatch =
        projected.length === 0
          ? ({ state: "settled", releaseReason: "ready" } as const)
          : projected.some((server) => server.state === "unreported")
            ? ({ state: "released", releaseReason: "status_unreported" } as const)
            : ({ state: "released", releaseReason: "terminal_status" } as const);
      emit({
        kind: "mcp_effective_update",
        configGeneration: 1,
        catalogGeneration: 1,
        configFingerprint: s.sessionMcpFingerprint,
        dispatch: mcpDispatch,
        servers: projected,
        tools: [],
      });
      const remote = new Set(
        options.mcpServers
          ?.filter(
            (server) =>
              server.type === "http" &&
              !Object.keys(server.headers ?? {}).some(
                (key) => key.toLowerCase() === "authorization",
              ),
          )
          .map((server) => server.id),
      );
      const unsubscribe = onOAuthCredentialChange(({ serverId }) => {
        if (remote.has(serverId) && !s.connection.signal.aborted)
          emit({ kind: "mcp_runtime_replacement_required", serverId });
      });
      void s.connection.closed.then(unsubscribe);
      if (options.initialTurn)
        await s.prompt(options.initialTurn.message, options.initialTurn.images);
      return s;
    } catch (error) {
      await this.stopSession(s);
      throw error instanceof RequestError ? nativeError(error, phase) : error;
    }
  }
  async setModel(process: RuntimeProcess, model?: string) {
    const s = session(process);
    const id = model || s.defaultModel;
    if (!id) throw new Error("Antigravity 没有报告默认模型");
    const families = s.modelFamilies();
    if (families.some((option) => option.value === id)) {
      if (id !== s.getCurrentModel()) {
        await s.setOption("model", id);
      }
      s.selectedModel = id;
      s.captureDefaultThoughtLevel(id);
      return;
    }
    const legacyFlat = splitAntigravityFlatModelId(id);
    if (legacyFlat && families.some((option) => option.value === legacyFlat.familyId)) {
      const currentModel = s.getCurrentModel();
      if (s.selectedModel === id && currentModel === legacyFlat.familyId) return;
      if (legacyFlat.familyId !== currentModel) {
        await s.setOption("model", legacyFlat.familyId);
      }
      // Capture the family's native default thought level before applying the
      // effort encoded in the legacy flat ID so resetting to `default` works.
      s.captureDefaultThoughtLevel(legacyFlat.familyId);
      if (
        s.selectOptions("thought_level").some((option) => option.value === legacyFlat.effort) &&
        legacyFlat.effort !== s.selectedOption("thought_level")
      ) {
        await s.setOption("thought_level", legacyFlat.effort);
      }
      s.selectedModel = id;
      return;
    }
    const legacyFamilyModel = families.length || s.models?.availableModels.some((model) => model.modelId === id)
      ? undefined
      : s.legacyFlatModelForFamily(id);
    const currentModel = s.getCurrentModel();
    // An old worker stores effort in the selected flat ID. Reapplying the
    // family at a turn boundary keeps its current native variant.
    if (legacyFamilyModel && splitAntigravityFlatModelId(currentModel)?.familyId === id) return;
    const nativeModel = legacyFamilyModel ?? id;
    if (nativeModel === currentModel) return;
    await s.connection.agent
      .request(
        "session/set_model",
        { sessionId: s.sessionId, modelId: nativeModel },
        rpcDeadline(),
      )
      .catch((error) => {
        throw nativeError(error, "session/set_model");
      });
    s.selectedModel = nativeModel;
    s.captureDefaultThoughtLevel(nativeModel);
  }
  private async applyReasoningEffort(s: AntigravitySession, effort: string): Promise<boolean> {
    if (!s.hasConfigOption("thought_level")) {
      if (s.modelFamilies().length) return false;
      const current = splitAntigravityFlatModelId(s.getCurrentModel());
      if (current?.effort === effort) return true;
      const variant = current && s.legacyFlatModelForFamily(current.familyId, effort);
      if (!variant) return false;
      await this.setModel(s, variant);
      return true;
    }
    const supported = s.selectOptions("thought_level").map((option) => option.value);
    if (supported.length > 0 && !supported.includes(effort)) return false;
    if (effort !== s.selectedOption("thought_level")) {
      await s.setOption("thought_level", effort);
    }
    return true;
  }
  async setReasoningEffort(process: RuntimeProcess, effort?: string) {
    const s = session(process);
    const thoughtLevel = effort ?? s.getDefaultThoughtLevel();
    if (thoughtLevel === undefined || await this.applyReasoningEffort(s, thoughtLevel)) return;
    if (effort !== undefined) {
      throw unsupportedConfigOptionError(
        "thought_level", thoughtLevel, s.selectOptions("thought_level").map((option) => option.value),
      );
    }
  }
  async setPermissionMode(process: RuntimeProcess, mode?: string) {
    const s = session(process);
    if (s.requiresPermissionModeRestart(mode))
      throw new Error("切换完全访问权限需要重新启动 Antigravity CLI");
    if (s.skipPermissions) return;
    const target = mode || getDefaultRuntimePermissionMode("antigravity");
    const offered = s.offeredPermissionModes();
    if (offered.length > 0 && !offered.includes(target)) {
      console.warn(
        `[antigravity] Permission mode '${target}' is not offered by this CLI session; offered=[${offered.join(",")}]`,
      );
      throw unsupportedConfigOptionError("mode", target, offered);
    }
    if (s.selectedPermissionMode() === target) return;
    await s.setOption("mode", target);
  }
  sendMessage(
    process: RuntimeProcess,
    message: string,
    images?: ResolvedImagePayload[],
  ) {
    return session(process).prompt(message, images);
  }
  canSteerMessage(process: RuntimeProcess): boolean {
    return session(process).canSteer();
  }
  steerMessage(
    process: RuntimeProcess,
    message: string,
    images?: ResolvedImagePayload[],
    options?: { clientUserMessageId?: string },
  ) {
    return session(process).steer(message, images, options?.clientUserMessageId);
  }
  async respondPermission(
    process: RuntimeProcess,
    id: string,
    decision: PermissionDecision,
  ) {
    const pending = session(process).pending.get(id);
    if (!pending?.decide) throw new Error("Antigravity 审批已结束");
    pending.decide(decision);
  }
  async respondPermissionOption(process: RuntimeProcess, id: string, optionId: string) {
    const pending = session(process).pending.get(id);
    if (!pending?.choose) throw new Error("Antigravity 审批已结束");
    pending.choose(optionId);
  }
  async respondAskUserQuestion(
    process: RuntimeProcess,
    id: string,
    answers: AskUserQuestionAnswers | null,
  ) {
    const pending = session(process).pending.get(id);
    if (!pending?.answer) throw new Error("Antigravity 问答已结束");
    pending.answer(answers);
  }
  async interruptTurn(process: RuntimeProcess) {
    await session(process).cancelTurn();
  }
  async stopSession(process: RuntimeProcess) {
    const s = session(process);
    try {
      await this.interruptTurn(s);
      if (s.sessionId && !s.connection.signal.aborted)
        await s.connection.agent.request(
          "session/close",
          { sessionId: s.sessionId },
          rpcDeadline(1500),
        );
    } catch {
      /* Continue through process-tree cleanup if ACP is unavailable. */
    }
    s.clearAuthRetry();
    s.finishBackgroundWork();
    s.connection.close();
    if (s.pid <= 0) return;
    const result = await killWithEscalation(s, {
      gracefulMs: 1000,
      hardMs: 1000,
      killTree: true,
    });
    if (!result.exited) throw new Error("Antigravity CLI 尚未退出");
  }
}

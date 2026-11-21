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
import { fingerprintSessionMcp } from "../session-core/mcp-sync-policy";
import { resolveRemoteMcpTransportConfig } from "../session-core/mcp-template-resolution";
import { buildMcpStdioLaunchConfig } from "../utils/mcp-command";
import { MANAGED_BROWSER_MCP_ID } from "../../shared/browserTools";
import {
  acquireBrowserCapability,
  adoptBrowserProductSession,
} from "../browser-host/capability-client";
import { onOAuthCredentialChange, resolveAuthHeaders } from "../mcp-oauth";
import { supportsHostAskUserQuestion } from "../host-interaction";
import type { McpEffectiveServerSnapshot } from "../../shared/mcpEffectiveState";
import { randomUUID } from "node:crypto";
import type { McpServerDefinition } from "../../shared/config-types";
import {
  ANTIGRAVITY_FULL_ACCESS,
  ANTIGRAVITY_PERMISSION_MODES,
  getDefaultRuntimePermissionMode,
  type RuntimeEnvPolicy,
  type RuntimeModelInfo,
} from "../../shared/types/runtime";
import type { AskUserQuestionAnswers } from "../../shared/types/askUserQuestion";
import { ensureShellPath } from "../utils/shell";
import { spawn, type SubprocessHandle } from "../utils/subprocess";
import { antigravityForm } from "./antigravity-form";
import { augmentedProcessEnv, resolveCommand } from "./env-utils";
import type {
  AgentRuntime,
  ResolvedImagePayload,
  RuntimeProcess,
  SessionStartOptions,
  UnifiedEventCallback,
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
  const child = spawn([path, ...args], {
    env,
    stdin: "ignore",
    stdout: "pipe",
    stderr: help ? "pipe" : "ignore",
  });
  const stop = () => child.kill("SIGKILL");
  abort.addEventListener("abort", stop, { once: true });
  try {
    const [code, output, helpText] = await Promise.all([
      child.exited,
      new Response(child.stdout).text(),
      help ? new Response(child.stderr).text() : Promise.resolve(""),
    ]);
    abort.throwIfAborted();
    if (code !== 0) throw new Error("无法执行 agy " + arg);
    return { path, output: (output || helpText).trim() };
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
  throw new Error("Antigravity 不支持当前 MCP 配置：" + server.id);
}

type PermissionDecision = "allow_once" | "deny" | "always_allow";
type Pending = {
  cancel(): void;
  decide?(decision: PermissionDecision): void;
  answer?(answers: AskUserQuestionAnswers | null): void;
};
interface ModelState {
  currentModelId: string;
  availableModels: { modelId: string; name: string }[];
}

class AntigravitySession implements RuntimeProcess {
  readonly connection: ClientConnection;
  sessionId = "";
  image = false;
  models?: ModelState;
  config: SessionConfigOption[] = [];
  defaultModel?: string;
  selectedModel?: string;
  selectedEffort?: string;
  exited = false;
  initialized = false;
  earlyCommands?: {
    sessionId: string;
    update: Extract<
      SessionUpdate,
      { sessionUpdate: "available_commands_update" }
    >;
  };
  active = false;
  private dispatched?: { resolve(): void; reject(reason: unknown): void };
  private stream: "text" | "thinking" | null = null;
  private turnId = "";
  private thinkingIndex = 0;
  private readonly tools = new Map<string, ToolCallUpdate>();
  readonly pending = new Map<string, Pending>();
  constructor(
    private readonly child: SubprocessHandle,
    readonly emit: UnifiedEventCallback,
    readonly sessionMcpFingerprint: string,
    readonly scenario: SessionStartOptions["scenario"],
    readonly productSessionId: string,
    readonly skipPermissions: boolean,
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
      else if (this.active) this.update(params.update);
    });
    app.onRequest("session/request_permission", ({ params, signal }) => {
      if (
        !this.active ||
        params.sessionId !== this.sessionId ||
        !["desktop", "im", "agent-channel"].includes(this.scenario.type)
      )
        return { outcome: { outcome: "cancelled" } };
      return new Promise<RequestPermissionResponse>((resolve) => {
        const id = randomUUID();
        const finish = (response: RequestPermissionResponse) => {
          this.pending.delete(id);
          signal.removeEventListener("abort", expired);
          resolve(response);
        };
        const cancel = () => finish({ outcome: { outcome: "cancelled" } });
        const decide = (decision: PermissionDecision) => {
          const kind = {
            allow_once: "allow_once",
            always_allow: "allow_always",
            deny: "reject_once",
          }[decision];
          const option = params.options.find((o) => o.kind === kind);
          if (option)
            finish({
              outcome: { outcome: "selected", optionId: option.optionId },
            });
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
        this.pending.set(id, { cancel, decide });
        signal.addEventListener("abort", expired, { once: true });
        const tool = params.toolCall;
        this.emit({
          kind: "permission_request",
          requestId: id,
          toolUseId: tool.toolCallId,
          toolName: tool.title || tool.kind || "Tool",
          input: toolInput(tool),
          interactionKind: "permission",
          suppressAlwaysAllowRule: !params.options.some(
            (o) => o.kind === "allow_always",
          ),
        });
      });
    });
    app.onRequest("elicitation/create", ({ params, signal }) => {
      if (
        !this.active ||
        !(
          this.scenario.type === "desktop" ||
          supportsHostAskUserQuestion(this.scenario)
        ) ||
        !("sessionId" in params) ||
        params.sessionId !== this.sessionId ||
        params.mode !== "form"
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
  private closeBlock() {
    if (this.stream === "text") this.emit({ kind: "text_stop" });
    if (this.stream === "thinking")
      this.emit({ kind: "thinking_stop", index: this.thinkingIndex });
    this.stream = null;
  }
  private update(update: SessionUpdate) {
    switch (update.sessionUpdate) {
      case "agent_message_chunk":
      case "agent_thought_chunk": {
        if (update.content.type !== "text") return;
        const stream =
          update.sessionUpdate === "agent_message_chunk" ? "text" : "thinking";
        if (this.stream !== stream) {
          this.closeBlock();
          this.stream = stream;
          if (stream === "thinking")
            this.emit({ kind: "thinking_start", index: ++this.thinkingIndex });
        }
        if (stream === "text")
          this.emit({ kind: "text_delta", text: update.content.text });
        else
          this.emit({
            kind: "thinking_delta",
            text: update.content.text,
            index: this.thinkingIndex,
          });
        break;
      }
      case "tool_call":
      case "tool_call_update": {
        this.closeBlock();
        const id = update.toolCallId;
        const prior = this.tools.get(id);
        if (prior?.status === "completed" || prior?.status === "failed") return;
        const tool = { ...prior, ...update };
        this.tools.set(id, tool);
        if (!prior)
          this.emit({
            kind: "tool_use_start",
            toolUseId: id,
            toolName: tool.title || tool.kind || "Tool",
            input: toolInput(tool),
          });
        if (tool.status === "completed" || tool.status === "failed") {
          this.emit({
            kind: "tool_use_stop",
            toolUseId: id,
            input: toolInput(tool),
          });
          const text = tool.content
            ?.map((c) =>
              c.type === "content" && c.content.type === "text"
                ? c.content.text
                : c.type === "diff"
                  ? JSON.stringify({
                      path: c.path,
                      oldText: c.oldText,
                      newText: c.newText,
                    })
                  : "",
            )
            .filter(Boolean)
            .join("\n");
          const attachments = tool.content?.flatMap((part) => {
            if (part.type !== "content" || part.content.type !== "image")
              return [];
            const ctx = {
              sessionId: this.productSessionId,
              turnId: this.turnId,
              toolUseId: id,
              mimeType: part.content.mimeType,
              producedBy: "antigravity",
            };
            const { attachment, pendingId } = makePlaceholderAttachment(ctx);
            trackInFlightSave(
              saveToolAttachment(
                { kind: "base64", data: part.content.data },
                ctx,
              )
                .catch((error) => makeErrorAttachment(ctx, error, pendingId))
                .then((saved) =>
                  this.emit({
                    kind: "tool_attachment_update",
                    toolUseId: id,
                    pendingId,
                    attachment: saved,
                  }),
                ),
            );
            return [attachment];
          });
          this.emit({
            kind: "tool_result",
            toolUseId: id,
            content:
              text ||
              (typeof tool.rawOutput === "string"
                ? tool.rawOutput
                : JSON.stringify(tool.rawOutput ?? "")),
            attachments,
            isError: tool.status === "failed",
          });
        }
        break;
      }
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
  async prompt(message: string, images: ResolvedImagePayload[] = []) {
    if (this.active || this.connection.signal.aborted)
      throw new Error("Antigravity 会话当前无法接收消息");
    if (images.length && !this.image)
      throw new Error("当前 Antigravity CLI 不支持图片输入");
    this.active = true;
    this.turnId = randomUUID();
    const complete = (status: string, error?: string) => {
      this.closeBlock();
      this.tools.clear();
      this.cancelPending();
      this.active = false;
      this.emit({ kind: "turn_complete", status, error });
    };
    const written = new Promise<void>((resolve, reject) => {
      this.dispatched = { resolve, reject };
    });
    void this.connection.agent
      .request<PromptResponse>("session/prompt", {
        sessionId: this.sessionId,
        prompt: [
          { type: "text", text: message },
          ...images.map((i) => ({
            type: "image" as const,
            mimeType: i.mimeType,
            data: i.data,
          })),
        ],
      })
      .then(
        (result) => {
          if (result.usage)
            this.emit({
              kind: "usage",
              inputTokens: result.usage.inputTokens,
              outputTokens: result.usage.outputTokens,
              cacheReadTokens: result.usage.cachedReadTokens ?? undefined,
              cacheCreationTokens: result.usage.cachedWriteTokens ?? undefined,
            });
          if (result.stopReason === "end_turn") complete("completed");
          else if (result.stopReason === "cancelled") complete("cancelled");
          else complete("failed", "Antigravity: " + result.stopReason);
        },
        (e) => {
          const error = nativeError(e, "session/prompt");
          this.dispatched?.reject(error);
          if (!this.exited) complete("failed", error.message);
        },
      );
    try {
      await written;
    } finally {
      this.dispatched = undefined;
    }
  }
  selectOptions(id: string) {
    const entry = this.config.find((o) => o.id === id);
    if (!entry || entry.type !== "select") return [];
    return entry.options.flatMap((group) =>
      "options" in group ? group.options : [group],
    );
  }
  modelFamilies() {
    return this.selectOptions("model");
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
        throw nativeError(error, "session/set_config_option");
      });
    this.config = result.configOptions;
    if (this.config.find((o) => o.id === configId)?.currentValue !== value)
      throw new Error("Antigravity 未应用 " + configId);
  }
}

function toolInput(tool: ToolCallUpdate): Record<string, unknown> {
  return tool.rawInput &&
    typeof tool.rawInput === "object" &&
    !Array.isArray(tool.rawInput)
    ? (tool.rawInput as Record<string, unknown>)
    : { title: tool.title, locations: tool.locations };
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
  async detect() {
    try {
      const { path, output } = await queryCli("--version");
      const help = await queryCli(["acp", "--help"]).catch(() => null);
      const compatible = help?.output.includes("--process-per-session");
      return {
        installed: true,
        path,
        version: output,
        ...(compatible
          ? {}
          : {
              readiness: "unavailable" as const,
              reason: "protocol-mismatch" as const,
            }),
      };
    } catch {
      return { installed: false };
    }
  }
  async queryModels(
    options?: Parameters<AgentRuntime["queryModels"]>[0],
  ): Promise<RuntimeModelInfo[]> {
    if (options?.process) {
      const s = session(options.process);
      const currentFamily = s.config.find(
        (o) => o.id === "model",
      )?.currentValue;
      const efforts = s
        .selectOptions("thought_level")
        .map((o) => ({ reasoningEffort: o.value, description: o.name }));
      const families = s.modelFamilies().map((o) => ({
        value: o.value,
        displayName: o.name,
        ...(o.value === currentFamily
          ? { supportedReasoningEfforts: efforts, isDefault: true }
          : {}),
      }));
      return families.length
        ? families
        : (s.models?.availableModels ?? []).map((m) => ({
            value: m.modelId,
            displayName: m.name,
          }));
    }
    const { output } = await queryCli(
      "models",
      options?.envPolicy,
      options?.signal,
    );
    return output.split(/\r?\n/).flatMap((line) => {
      const [value, displayName] = line.split("\t");
      return value && displayName ? [{ value, displayName }] : [];
    });
  }
  async startSession(options: SessionStartOptions, emit: UnifiedEventCallback) {
    const { path, env } = await executable(options.envPolicy);
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
    });
    const s = new AntigravitySession(
      child,
      emit,
      fingerprintSessionMcp(options.mcpServers ?? []),
      options.scenario,
      options.sessionId,
      skipPermissions,
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
        } catch {
          projected.push({
            ...status,
            state: "failed",
            errorCode: "mcp_projection_rejected",
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
      s.config = opened.configOptions ?? [];
      s.defaultModel = s.models?.currentModelId;
      phase = "session/config";
      if (options.model) await this.setModel(s, options.model);
      if (options.reasoningEffort)
        await this.setReasoningEffort(s, options.reasoningEffort);
      await this.setPermissionMode(s, options.permissionMode);
      emit({
        kind: "session_init",
        sessionId: s.sessionId,
        model: options.model ?? s.defaultModel ?? "",
        tools: [],
      });
      s.initialized = true;
      if (s.earlyCommands?.sessionId === s.sessionId)
        s.publishCommands(s.earlyCommands.update);
      s.earlyCommands = undefined;
      emit({
        kind: "mcp_effective_update",
        configGeneration: 1,
        catalogGeneration: 1,
        configFingerprint: s.sessionMcpFingerprint,
        dispatch: { state: "released", releaseReason: "status_read_failed" },
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
    if (s.modelFamilies().some((option) => option.value === id))
      await s.setOption("model", id);
    else
      await s.connection.agent
        .request(
          "session/set_model",
          { sessionId: s.sessionId, modelId: id },
          rpcDeadline(),
        )
        .catch((error) => {
          throw nativeError(error, "session/set_model");
        });
    s.selectedModel = id;
    if (s.selectedEffort) await s.setOption("thought_level", s.selectedEffort);
  }
  async setReasoningEffort(process: RuntimeProcess, effort?: string) {
    const s = session(process);
    if (effort) {
      await s.setOption("thought_level", effort);
      s.selectedEffort = effort;
    } else {
      const previous = s.selectedEffort;
      s.selectedEffort = undefined;
      try {
        await this.setModel(s, s.selectedModel ?? s.defaultModel);
      } catch (error) {
        s.selectedEffort = previous;
        throw error;
      }
    }
  }
  async setPermissionMode(process: RuntimeProcess, mode?: string) {
    const s = session(process);
    if (s.requiresPermissionModeRestart(mode)) throw new Error("切换完全访问权限需要重新启动 Antigravity CLI");
    if (!s.skipPermissions) await s.setOption("mode", mode || getDefaultRuntimePermissionMode("antigravity"));
  }
  sendMessage(
    process: RuntimeProcess,
    message: string,
    images?: ResolvedImagePayload[],
  ) {
    return session(process).prompt(message, images);
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
    const s = session(process);
    if (s.active) {
      await s.connection.agent.notify("session/cancel", {
        sessionId: s.sessionId,
      });
      s.cancelPending();
    }
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

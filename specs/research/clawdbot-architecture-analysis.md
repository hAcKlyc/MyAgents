# Clawdbot 项目架构分析

> 本文档分析 Clawdbot 项目的技术架构，旨在为实现类似的「本地 Agent + 多聊天平台 Bot」功能提供参考。

## 目录

1. [项目概述](#1-项目概述)
2. [整体架构](#2-整体架构)
3. [核心组件详解](#3-核心组件详解)
4. [消息流转机制](#4-消息流转机制)
5. [频道插件系统](#5-频道插件系统)
6. [Gateway 设计](#6-gateway-设计)
7. [Agent 管理](#7-agent-管理)
8. [路由与 Session 管理](#8-路由与-session-管理)
9. [安全设计](#9-安全设计)
10. [关键设计模式总结](#10-关键设计模式总结)
11. [针对 Tauri + React 项目的建议](#11-针对-tauri--react-项目的建议)

---

## 1. 项目概述

### 1.1 项目定位

Clawdbot 是一个**自托管（Self-hosted）的 AI Agent 网关**，核心功能是：
- 在本地运行 AI Agent
- 通过多种聊天平台（Telegram、Discord、Slack、Signal、iMessage、WhatsApp、LINE 等）与 Agent 交互
- 所有数据和 Agent 运行在用户本地，不依赖云端中转服务

### 1.2 技术栈

| 层级 | 技术 |
|------|------|
| 语言 | TypeScript (ESM) |
| 运行时 | Node.js 22+ / Bun |
| 构建 | tsc + Bun |
| 测试 | Vitest |
| 包管理 | pnpm (支持 Bun) |
| 桌面应用 | macOS 原生 (SwiftUI) |

### 1.3 项目结构

```
clawdbot/
├── src/
│   ├── cli/                 # CLI 入口和命令行处理
│   ├── commands/            # 具体命令实现
│   ├── gateway/             # Gateway 核心（消息中枢）
│   ├── agents/              # Agent 管理和执行
│   ├── channels/            # 频道基础设施
│   ├── routing/             # 消息路由引擎
│   ├── auto-reply/          # 自动回复引擎
│   ├── config/              # 配置管理
│   ├── plugins/             # 插件系统核心
│   ├── security/            # 安全审计
│   │
│   ├── telegram/            # Telegram 频道实现
│   ├── discord/             # Discord 频道实现
│   ├── slack/               # Slack 频道实现
│   ├── signal/              # Signal 频道实现
│   ├── imessage/            # iMessage 频道实现
│   ├── web/                 # WhatsApp Web 频道实现
│   └── line/                # LINE 频道实现
│
├── extensions/              # 扩展频道（插件形式）
│   ├── msteams/
│   ├── matrix/
│   ├── zalo/
│   └── ...
│
├── apps/
│   ├── macos/               # macOS 桌面应用
│   ├── ios/                 # iOS 应用
│   └── android/             # Android 应用
│
└── docs/                    # 文档
```

---

## 2. 整体架构

### 2.1 架构图

```
┌─────────────────────────────────────────────────────────────────────────┐
│                           用户本地机器                                    │
│                                                                         │
│  ┌───────────────────────────────────────────────────────────────────┐ │
│  │                        Gateway (端口 18789)                        │ │
│  │  ┌─────────────┐  ┌─────────────┐  ┌─────────────────────────────┐│ │
│  │  │ WebSocket   │  │ HTTP API    │  │ Channel Monitors            ││ │
│  │  │ Server      │  │ (OpenAI等)  │  │ (出站连接到各聊天平台)       ││ │
│  │  └──────┬──────┘  └──────┬──────┘  └──────────────┬──────────────┘│ │
│  │         │                │                        │               │ │
│  │         └────────────────┼────────────────────────┘               │ │
│  │                          ↓                                        │ │
│  │  ┌─────────────────────────────────────────────────────────────┐ │ │
│  │  │                    Router (路由引擎)                         │ │ │
│  │  │  - 根据频道/群组/用户路由到对应 Agent                        │ │ │
│  │  │  - Session 管理                                              │ │ │
│  │  └──────────────────────────┬──────────────────────────────────┘ │ │
│  │                             ↓                                    │ │
│  │  ┌─────────────────────────────────────────────────────────────┐ │ │
│  │  │                    Agent 执行器                              │ │ │
│  │  │  - 模型调用 (Anthropic/OpenAI/Ollama等)                      │ │ │
│  │  │  - 工具执行                                                  │ │ │
│  │  │  - 工作区管理                                                │ │ │
│  │  └─────────────────────────────────────────────────────────────┘ │ │
│  └───────────────────────────────────────────────────────────────────┘ │
│                                                                         │
│  ┌───────────────────┐  ┌───────────────────┐                          │
│  │ Agent 工作区       │  │ 配置和状态存储     │                          │
│  │ ~/.clawd-default/ │  │ ~/.clawdbot/      │                          │
│  └───────────────────┘  └───────────────────┘                          │
└─────────────────────────────────────────────────────────────────────────┘
                    ↕ 出站 API 调用（主动连接）
┌─────────────────────────────────────────────────────────────────────────┐
│                           外部服务                                       │
│  ┌─────────────────┐  ┌─────────────────┐  ┌─────────────────┐         │
│  │ LLM API         │  │ 聊天平台 API     │  │ 其他服务        │         │
│  │ (Anthropic等)   │  │ (Telegram等)    │  │                 │         │
│  └─────────────────┘  └─────────────────┘  └─────────────────┘         │
└─────────────────────────────────────────────────────────────────────────┘
```

### 2.2 核心设计理念

1. **纯本地运行** - 没有官方云端中转服务，所有逻辑在用户机器上执行
2. **出站连接为主** - 大多数聊天平台通过出站 WebSocket/HTTP 连接，无需公网 IP
3. **插件化频道** - 频道作为插件存在，易于扩展新平台
4. **统一消息格式** - 所有平台消息转换为统一的内部格式
5. **灵活路由** - 支持按频道/群组/用户路由到不同 Agent

---

## 3. 核心组件详解

### 3.1 Gateway（消息中枢）

Gateway 是整个系统的核心，负责：

**文件位置**: `src/gateway/server.impl.ts`

**主要职责**:
- 管理所有频道的连接和监听
- 处理 WebSocket/HTTP 请求
- 协调 Agent 调用
- 管理 Session 状态

**关键代码结构**:

```typescript
// src/gateway/server.impl.ts
export async function createGatewayServer(options: GatewayServerOptions) {
  // 1. 加载配置
  const cfg = loadConfig();

  // 2. 初始化 Agent 列表
  const defaultAgentId = resolveDefaultAgentId(cfg);
  const agentIds = listAgentIds(cfg);

  // 3. 加载插件（包括频道插件）
  const plugins = await loadGatewayPlugins();

  // 4. 创建频道管理器
  const channelManager = createChannelManager();

  // 5. 启动 HTTP/WebSocket 服务器
  const httpServer = createGatewayHttpServer({ ... });
  attachGatewayWsHandlers(server, { ... });

  // 6. 启动各频道的 Monitor
  await startChannelMonitors();

  // 7. 启动心跳和配置热重载
  startHeartbeatRunner();
  startGatewayConfigReloader();

  return { close };
}
```

**绑定模式** (`src/gateway/net.ts`):

```typescript
type GatewayBindMode = "auto" | "lan" | "loopback" | "custom" | "tailnet";

// loopback: 127.0.0.1 (默认，仅本机访问)
// lan: 0.0.0.0 (所有网卡，局域网可访问)
// tailnet: Tailscale 网络 IP
// custom: 自定义 IP
```

### 3.2 Channel Monitor（频道监听器）

每个聊天平台有对应的 Monitor，负责：
- 连接到平台 API
- 接收消息
- 转换为统一格式
- 发送回复

**连接方式对比**:

| 平台 | 连接方式 | 是否需要公网入口 | 关键文件 |
|------|---------|---------------|---------|
| Telegram | Long Polling / Webhook | Polling 不需要 | `src/telegram/monitor.ts` |
| Discord | Discord Gateway (WS) | 不需要 | `src/discord/monitor/` |
| Slack | Socket Mode (WS) | 不需要 | `src/slack/monitor/` |
| Signal | 本地 signal-cli | 不需要 | `src/signal/monitor/` |
| iMessage | macOS AppleScript | 不需要 | `src/imessage/` |
| WhatsApp | WhatsApp Web 协议 | 不需要 | `src/web/` |

**Telegram Long Polling 示例** (`src/telegram/monitor.ts`):

```typescript
// Long Polling 模式：本地主动拉取，不需要公网 IP
export async function startTelegramMonitor(opts: TelegramMonitorOpts) {
  const bot = createTelegramBot({ token: opts.token, ... });

  // 启动 long polling
  await bot.start({
    onStart: () => log("Telegram monitor started"),
    // 不断向 Telegram API 发起 getUpdates 请求
  });

  return { stop: () => bot.stop() };
}
```

**Telegram Webhook 示例** (`src/telegram/webhook.ts`):

```typescript
// Webhook 模式：需要公网 URL，Telegram 主动推送
export async function startTelegramWebhook(opts) {
  const server = createServer((req, res) => {
    // 处理 Telegram 推送的消息
    handler(req, res);
  });

  // 向 Telegram 注册 Webhook URL
  await bot.api.setWebhook(publicUrl, { ... });

  await server.listen(port, host); // 默认 0.0.0.0:8787
}
```

### 3.3 Agent 执行器

**文件位置**: `src/commands/agent.ts`

**执行流程**:

```typescript
export async function agentCommand(opts: AgentCommandOpts) {
  // 1. 解析 Session
  const sessionResolution = resolveSession({
    cfg,
    to: opts.to,
    sessionId: opts.sessionId,
    agentId: opts.agentId,
  });

  // 2. 加载/创建 Agent 工作区
  const workspace = await ensureAgentWorkspace({
    dir: workspaceDir,
    ensureBootstrapFiles: true,
  });

  // 3. 注册运行上下文
  registerAgentRunContext(runId, { sessionKey, agentId, ... });

  // 4. 调用 Agent（支持模型回退）
  const result = await runWithModelFallback({
    cfg,
    agentId,
    run: async (modelRef) => {
      // CLI 模式或嵌入式模式
      if (isCliProvider(modelRef)) {
        return await runCliAgent({ message, modelRef, workspace, ... });
      }
      return await runEmbeddedPiAgent({ message, modelRef, workspace, ... });
    }
  });

  // 5. 投递结果到原频道
  await deliverAgentCommandResult({ result, ... });

  // 6. 更新 Session 历史
  await updateSessionStoreAfterAgentRun({ ... });
}
```

---

## 4. 消息流转机制

### 4.1 完整消息流转链路

```
┌─────────────────────────────────────────────────────────────────┐
│ 1. 用户在聊天软件中发送消息                                       │
│    (Telegram, Discord, Slack, 飞书, 企业微信, QQ 等)             │
└──────────────────────────┬──────────────────────────────────────┘
                           ↓
┌─────────────────────────────────────────────────────────────────┐
│ 2. Channel Monitor 接收消息                                      │
│    - Telegram: bot.on("message", handler)                       │
│    - Discord: client.on("messageCreate", handler)               │
│    - 飞书/企微: Webhook 回调 或 WebSocket 长连接                  │
└──────────────────────────┬──────────────────────────────────────┘
                           ↓
┌─────────────────────────────────────────────────────────────────┐
│ 3. 消息规范化 (Normalization)                                    │
│    将平台特定格式转换为统一的 MsgContext                          │
│                                                                  │
│    interface MsgContext {                                        │
│      text: string;           // 消息文本                         │
│      channel: string;        // 频道标识 (telegram/discord/...)  │
│      senderId: string;       // 发送者 ID                        │
│      senderName?: string;    // 发送者名称                       │
│      peerId?: string;        // DM 对等方 ID                     │
│      groupId?: string;       // 群组 ID                          │
│      images?: ImageAttachment[];  // 图片附件                    │
│      timestamp?: number;                                         │
│    }                                                             │
└──────────────────────────┬──────────────────────────────────────┘
                           ↓
┌─────────────────────────────────────────────────────────────────┐
│ 4. 访问控制检查 (Access Control)                                 │
│    - 检查 allowlist（白名单）                                    │
│    - 检查 groupPolicy（群组策略）                                │
│    - 检查 dmPolicy（私聊策略）                                   │
└──────────────────────────┬──────────────────────────────────────┘
                           ↓
┌─────────────────────────────────────────────────────────────────┐
│ 5. 路由解析 (Route Resolution)                                   │
│    根据配置的绑定规则，决定消息路由到哪个 Agent                   │
│                                                                  │
│    优先级: Peer > Guild > Team > Account > Channel > Default     │
└──────────────────────────┬──────────────────────────────────────┘
                           ↓
┌─────────────────────────────────────────────────────────────────┐
│ 6. Session 解析                                                  │
│    - 加载或创建 Session                                          │
│    - 生成 Session Key (格式: {agentId}@{channel}@{peerId})       │
│    - 加载消息历史                                                │
└──────────────────────────┬──────────────────────────────────────┘
                           ↓
┌─────────────────────────────────────────────────────────────────┐
│ 7. Agent 执行                                                    │
│    - 构建 Prompt（系统提示 + 历史 + 用户消息）                   │
│    - 调用 LLM API                                                │
│    - 执行工具调用（如有）                                        │
│    - 流式返回结果                                                │
└──────────────────────────┬──────────────────────────────────────┘
                           ↓
┌─────────────────────────────────────────────────────────────────┐
│ 8. 回复投递 (Reply Delivery)                                     │
│    - 格式化回复文本                                              │
│    - 调用对应频道的 send() 方法                                  │
│    - 处理平台特定的限制（消息长度、格式等）                       │
└──────────────────────────┬──────────────────────────────────────┘
                           ↓
┌─────────────────────────────────────────────────────────────────┐
│ 9. Session 更新                                                  │
│    - 追加消息到历史（JSONL 格式）                                │
│    - 更新 Session 元数据                                         │
└─────────────────────────────────────────────────────────────────┘
```

### 4.2 消息上下文数据结构

**文件位置**: `src/channels/plugins/types.ts`

```typescript
// 统一的消息上下文接口
interface MsgContext {
  // 基本信息
  text: string;                    // 消息文本
  channel: ChannelId;              // 频道标识
  accountId?: string;              // Bot 账户 ID

  // 发送者信息
  senderId: string;                // 发送者唯一 ID
  senderName?: string;             // 发送者显示名称
  senderPhone?: string;            // 发送者电话 (E.164 格式)

  // 对话上下文
  peerId?: string;                 // DM 对等方 ID
  peerName?: string;               // DM 对等方名称
  groupId?: string;                // 群组 ID
  groupName?: string;              // 群组名称
  threadId?: string;               // 线程 ID (Slack 等)

  // 附件
  images?: Array<{
    type: "image";
    data: string;                  // base64 编码
    mimeType: string;
  }>;

  // 引用
  replyTo?: string;                // 引用的消息 ID

  // 元数据
  timestamp?: number;
  messageId?: string;
}
```

---

## 5. 频道插件系统

### 5.1 插件架构

Clawdbot 的频道通过**插件系统**实现，分为两类：
- **内置频道**: 在 `src/` 目录中，编译到主包
- **扩展频道**: 在 `extensions/` 目录中，独立的 npm 包

### 5.2 插件接口定义

**文件位置**: `src/channels/plugins/types.ts`

```typescript
// 频道插件接口
interface ChannelPlugin {
  id: ChannelId;                    // 频道唯一标识
  label: string;                    // 显示名称
  description?: string;             // 描述

  // 监听器（接收消息）
  monitor?: {
    start(opts: MonitorStartOpts): Promise<void>;
    stop(): Promise<void>;
  };

  // 发送器（发送消息）
  send?(ctx: SendContext): Promise<SendResult>;

  // 状态检查
  status?(): Promise<ChannelStatus>;

  // 配置 Schema
  configSchema?: ConfigSchema;
}

// 监听器启动选项
interface MonitorStartOpts {
  config: ClawdbotConfig;
  onMessage: (ctx: MsgContext) => Promise<void>;
  onError?: (err: Error) => void;
}

// 发送上下文
interface SendContext {
  channel: ChannelId;
  to: string;                       // 目标（用户 ID 或群组 ID）
  text: string;
  replyTo?: string;
  attachments?: Attachment[];
}
```

### 5.3 插件注册机制

**文件位置**: `src/channels/plugins/index.ts`

```typescript
// 频道插件注册表
export function listChannelPlugins(): ChannelPlugin[] {
  // 1. 获取内置频道
  const builtIn = getBuiltInChannels();

  // 2. 获取扩展频道（从 extensions/ 加载）
  const extensions = listPluginChannels();

  // 3. 去重并排序
  return dedupeChannels([...builtIn, ...extensions]);
}

export function getChannelPlugin(id: ChannelId): ChannelPlugin | undefined {
  return listChannelPlugins().find(p => p.id === id);
}
```

### 5.4 扩展频道示例

**文件位置**: `extensions/discord/index.ts`

```typescript
import type { ClawdbotPluginApi } from "clawdbot/plugin-sdk";
import { discordPlugin } from "./src/channel.js";

const plugin = {
  id: "discord",
  name: "Discord",
  description: "Discord channel plugin",

  register(api: ClawdbotPluginApi) {
    // 注册频道到系统
    api.registerChannel({ plugin: discordPlugin });
  },
};

export default plugin;
```

**频道实现** (`extensions/discord/src/channel.ts`):

```typescript
export const discordPlugin: ChannelPlugin = {
  id: "discord",
  label: "Discord",

  monitor: {
    async start(opts) {
      const client = new Client({ intents: [...] });

      client.on("messageCreate", async (message) => {
        // 转换为统一格式
        const ctx: MsgContext = {
          text: message.content,
          channel: "discord",
          senderId: message.author.id,
          senderName: message.author.username,
          groupId: message.guildId,
        };

        // 回调到主系统
        await opts.onMessage(ctx);
      });

      await client.login(token);
    },

    async stop() {
      await client.destroy();
    },
  },

  async send(ctx) {
    const channel = await client.channels.fetch(ctx.to);
    await channel.send(ctx.text);
    return { ok: true };
  },
};
```

### 5.5 频道元数据注册

**文件位置**: `src/channels/registry.ts`

```typescript
// 频道显示顺序
export const CHAT_CHANNEL_ORDER = [
  "telegram",
  "whatsapp",
  "discord",
  "googlechat",
  "slack",
  "signal",
  "imessage",
] as const;

// 频道元数据
const CHAT_CHANNEL_META: Record<ChatChannelId, ChannelMeta> = {
  telegram: {
    id: "telegram",
    label: "Telegram",
    docsPath: "/channels/telegram",
    configKey: "telegram",
  },
  discord: {
    id: "discord",
    label: "Discord",
    docsPath: "/channels/discord",
    configKey: "discord",
  },
  // ...
};
```

---

## 6. Gateway 设计

### 6.1 Gateway 配置类型

**文件位置**: `src/config/types.gateway.ts`

```typescript
type GatewayConfig = {
  // 端口（默认 18789）
  port?: number;

  // 运行模式
  mode?: "local" | "remote";

  // 绑定地址策略
  bind?: "loopback" | "lan" | "tailnet" | "auto" | "custom";
  customBindHost?: string;

  // 认证配置
  auth?: {
    mode?: "token" | "password";
    token?: string;
    password?: string;
    allowTailscale?: boolean;
  };

  // TLS 配置
  tls?: {
    enabled?: boolean;
    certPath?: string;
    keyPath?: string;
  };

  // Tailscale 集成
  tailscale?: {
    mode?: "off" | "serve" | "funnel";
  };

  // 远程 Gateway 配置（连接到另一台机器）
  remote?: {
    url?: string;
    transport?: "ssh" | "direct";
    token?: string;
  };

  // HTTP API 配置
  http?: {
    endpoints?: {
      chatCompletions?: { enabled?: boolean };
      responses?: { enabled?: boolean };
    };
  };
};
```

### 6.2 请求处理器架构

**文件位置**: `src/gateway/server-methods/`

```typescript
// 请求处理器注册
export const coreGatewayHandlers: GatewayRequestHandlers = {
  // Agent 相关
  "agent": agentHandlers.agent,
  "agent.cancel": agentHandlers["agent.cancel"],

  // 聊天相关
  "chat.send": chatHandlers["chat.send"],
  "chat.history": chatHandlers["chat.history"],

  // 频道相关
  "channels.status": channelHandlers["channels.status"],
  "channels.start": channelHandlers["channels.start"],
  "channels.stop": channelHandlers["channels.stop"],

  // 配置相关
  "config.get": configHandlers["config.get"],
  "config.patch": configHandlers["config.patch"],

  // Session 相关
  "sessions.list": sessionHandlers["sessions.list"],
  "sessions.get": sessionHandlers["sessions.get"],

  // 模型相关
  "models.list": modelHandlers["models.list"],
};
```

### 6.3 WebSocket 协议

**文件位置**: `src/gateway/protocol/`

```typescript
// 客户端认证
interface HelloMessage {
  type: "hello";
  clientName: string;
  clientVersion: string;
  token?: string;
  password?: string;
  minProtocol: number;
  maxProtocol: number;
}

// 服务端确认
interface HelloOkMessage {
  type: "hello_ok";
  protocol: number;
  gatewayId: string;
}

// 请求
interface RequestMessage {
  type: "request";
  id: string;
  method: string;
  params?: unknown;
}

// 响应（流式）
interface ResponseDeltaMessage {
  type: "response_delta";
  id: string;
  delta: unknown;
}

// 响应（最终）
interface ResponseFinalMessage {
  type: "response_final";
  id: string;
  result?: unknown;
  error?: { code: number; message: string };
}
```

### 6.4 Hooks API（外部触发）

**文件位置**: `src/gateway/hooks.ts`

Hooks API 允许外部系统通过 HTTP 触发 Agent：

```typescript
// 配置
hooks: {
  enabled: true,
  token: "your-secret-token",
  path: "/hooks",
}

// POST /hooks/agent
// Headers: Authorization: Bearer your-secret-token
// Body:
{
  "message": "用户消息",
  "sessionKey": "可选的会话标识",
  "channel": "last",  // 回复到哪个频道
  "to": "+1234567890", // 回复给谁
  "model": "claude-3-opus", // 可选的模型覆盖
  "deliver": true  // 是否投递回复
}

// POST /hooks/wake
// 唤醒 Agent（用于定时任务等）
{
  "text": "唤醒消息",
  "mode": "now"  // 或 "next-heartbeat"
}
```

---

## 7. Agent 管理

### 7.1 Agent 配置

**文件位置**: `src/agents/agent-scope.ts`

```typescript
// Agent 配置结构
interface AgentConfig {
  id: string;
  default?: boolean;           // 是否为默认 Agent

  // 模型配置
  model?: {
    provider: string;          // anthropic, openai, ollama...
    model: string;             // claude-3-opus, gpt-4...
    maxTokens?: number;
    temperature?: number;
  };

  // 工作区
  workspace?: string;          // 工作区目录路径

  // 沙盒配置
  sandbox?: {
    enabled?: boolean;
    policy?: SandboxPolicy;
  };

  // 工具配置
  tools?: {
    elevated?: { enabled?: boolean };
    browser?: { enabled?: boolean };
  };

  // 心跳配置（定时任务）
  heartbeat?: {
    enabled?: boolean;
    interval?: string;         // cron 表达式
    prompt?: string;
  };
}

// 解析 Agent 配置
export function resolveAgentConfig(
  cfg: ClawdbotConfig,
  agentId: string,
): ResolvedAgentConfig | undefined {
  const agents = cfg.agents?.list ?? [];
  return agents.find(a => normalizeAgentId(a.id) === normalizeAgentId(agentId));
}

// 获取默认 Agent
export function resolveDefaultAgentId(cfg: ClawdbotConfig): string {
  const agents = cfg.agents?.list ?? [];
  const defaultAgent = agents.find(a => a.default === true);
  return defaultAgent?.id ?? agents[0]?.id ?? "default";
}
```

### 7.2 工作区管理

**文件位置**: `src/agents/workspace.ts`

```typescript
// Agent 工作区结构
// ~/.clawd-default/
// ├── CLAUDE.md          # Agent 指令
// ├── tools/             # 自定义工具
// ├── scripts/           # 脚本
// └── ...

export async function ensureAgentWorkspace(opts: {
  dir: string;
  ensureBootstrapFiles?: boolean;
}): Promise<AgentWorkspace> {
  await fs.mkdir(opts.dir, { recursive: true });

  if (opts.ensureBootstrapFiles) {
    // 创建默认的 CLAUDE.md 等文件
    await ensureBootstrapFiles(opts.dir);
  }

  return {
    dir: opts.dir,
    claudeMdPath: path.join(opts.dir, "CLAUDE.md"),
  };
}
```

### 7.3 模型回退机制

**文件位置**: `src/agents/model-selection.ts`

```typescript
// 支持模型回退链
export async function runWithModelFallback<T>(opts: {
  cfg: ClawdbotConfig;
  agentId: string;
  run: (modelRef: ModelRef) => Promise<T>;
}): Promise<T> {
  const models = resolveModelFallbackChain(opts.cfg, opts.agentId);

  for (const modelRef of models) {
    try {
      return await opts.run(modelRef);
    } catch (err) {
      if (isRetryableError(err) && models.indexOf(modelRef) < models.length - 1) {
        log(`Model ${modelRef.model} failed, trying next...`);
        continue;
      }
      throw err;
    }
  }

  throw new Error("All models failed");
}
```

---

## 8. 路由与 Session 管理

### 8.1 路由规则

**文件位置**: `src/routing/resolve-route.ts`

```typescript
// 路由解析
export function resolveAgentRoute(input: ResolveAgentRouteInput): ResolvedAgentRoute {
  const { cfg, channel, accountId, peer, guildId, teamId } = input;

  // 获取所有绑定规则
  const bindings = listBindings(cfg).filter(binding => {
    if (!matchesChannel(binding.match, channel)) return false;
    if (!matchesAccountId(binding.match?.accountId, accountId)) return false;
    return true;
  });

  // 按优先级匹配
  // 1. Peer 级别（最高优先级）
  if (peer) {
    const match = bindings.find(b => matchesPeer(b.match, peer));
    if (match) return choose(match.agentId, "binding.peer");
  }

  // 2. Guild/Server 级别
  if (guildId) {
    const match = bindings.find(b => matchesGuild(b.match, guildId));
    if (match) return choose(match.agentId, "binding.guild");
  }

  // 3. Team 级别（Slack Workspace 等）
  if (teamId) {
    const match = bindings.find(b => matchesTeam(b.match, teamId));
    if (match) return choose(match.agentId, "binding.team");
  }

  // 4. Account 级别
  const accountMatch = bindings.find(b => b.match?.accountId === accountId);
  if (accountMatch) return choose(accountMatch.agentId, "binding.account");

  // 5. Channel 级别
  const channelMatch = bindings.find(b => b.match?.channel === channel);
  if (channelMatch) return choose(channelMatch.agentId, "binding.channel");

  // 6. 默认 Agent
  return choose(resolveDefaultAgentId(cfg), "default");
}

// 配置示例
// routing:
//   bindings:
//     - match:
//         channel: telegram
//         peer: "@alice"
//       agentId: personal-agent
//     - match:
//         channel: discord
//         guild: "123456789"
//       agentId: gaming-agent
//     - match:
//         channel: slack
//         team: "T0123456"
//       agentId: work-agent
```

### 8.2 Session 管理

**文件位置**: `src/config/sessions.ts`

```typescript
// Session 数据结构
interface SessionEntry {
  id: string;                      // 唯一 ID
  key: string;                     // 会话键 (格式见下)
  timestamp: number;               // 创建时间

  // 投递目标
  to?: string;                     // E.164 格式电话号码
  channel?: string;                // 频道标识

  // 配置覆盖
  modelOverride?: string;          // 模型覆盖

  // 状态
  agentId?: string;                // 关联的 Agent
  storePath?: string;              // 消息历史文件路径
}

// Session Key 格式
// {agentId}@{channel}@{peerId}
// 例如: default@telegram@123456789

// Session 存储
// ~/.clawdbot/sessions.json - 元数据
// ~/.clawdbot/agents/{agentId}/sessions/{sessionId}.jsonl - 消息历史
```

### 8.3 Session Key 生成

**文件位置**: `src/routing/session-key.ts`

```typescript
export function buildAgentSessionKey(opts: {
  agentId: string;
  channel: string;
  peerId?: string;
  groupId?: string;
  threadId?: string;
}): string {
  const parts = [
    normalizeAgentId(opts.agentId),
    opts.channel,
  ];

  if (opts.groupId) {
    parts.push(`g:${opts.groupId}`);
    if (opts.threadId) {
      parts.push(`t:${opts.threadId}`);
    }
  } else if (opts.peerId) {
    parts.push(`p:${opts.peerId}`);
  }

  return parts.join("@");
}

// 示例:
// DM: default@telegram@p:123456789
// 群组: default@discord@g:987654321
// 线程: default@slack@g:C01234567@t:1234567890.123456
```

---

## 9. 安全设计

### 9.1 访问控制

**文件位置**: `src/telegram/bot-access.ts`, `src/discord/monitor/allow-list.ts` 等

```typescript
// 群组策略
type GroupPolicy = "open" | "allowlist" | "mention" | "disabled";

// DM 策略
type DmPolicy = "open" | "allowlist" | "disabled";

// 配置示例
channels:
  telegram:
    groupPolicy: "allowlist"   # 只响应白名单群组
    dmPolicy: "allowlist"      # 只响应白名单用户
    allowFrom:
      - "@alice"
      - "@bob"
      - "-1001234567890"       # 群组 ID
```

### 9.2 Gateway 认证

**文件位置**: `src/gateway/auth.ts`

```typescript
// 认证模式
type GatewayAuthMode = "token" | "password" | "none";

// 强制规则：非 loopback 地址必须开启认证
if (!isLoopbackHost(bindHost) && authMode === "none") {
  throw new Error(
    `refusing to bind gateway to ${bindHost}:${port} without auth`
  );
}

// Tailscale Funnel 必须使用密码认证
if (tailscaleMode === "funnel" && authMode !== "password") {
  throw new Error(
    "tailscale funnel requires gateway auth mode=password"
  );
}
```

### 9.3 安全审计

**文件位置**: `src/security/audit.ts`

```typescript
// 安全审计检查项
const AUDIT_CHECKS = {
  // 文件系统权限
  "fs.state_dir.perms_world_writable": "critical",
  "fs.state_dir.perms_group_writable": "warn",
  "fs.config.perms_world_readable": "warn",

  // 同步文件夹风险
  "fs.synced_dir": "warn",

  // 配置中的密钥
  "config.secrets.gateway_password_in_config": "warn",
  "config.secrets.hooks_token_in_config": "info",

  // 频道安全
  "channel.dms_open": "critical",
  "channel.groups_open": "critical",

  // Gateway 暴露
  "gateway.exposed_without_auth": "critical",

  // 工具风险
  "tools.elevated_enabled": "info",
  "tools.browser_enabled": "info",
};

// 运行审计
export async function runSecurityAudit(opts: SecurityAuditOptions): Promise<SecurityAuditReport> {
  const findings: SecurityAuditFinding[] = [];

  // 收集各类检查结果
  findings.push(...collectFilesystemFindings(opts));
  findings.push(...collectSecretsInConfigFindings(opts.config));
  findings.push(...collectChannelSecurityFindings(opts));
  findings.push(...collectGatewaySecurityFindings(opts));

  return {
    ts: Date.now(),
    summary: countBySeverity(findings),
    findings,
  };
}
```

### 9.4 主要风险点

| 风险类别 | 严重度 | 缓解措施 |
|---------|--------|---------|
| Gateway 暴露 | 高 | 默认 loopback，非 loopback 强制认证 |
| 凭证存储 | 高 | 文件权限检测，同步文件夹警告 |
| Hooks 滥用 | 中 | Token 认证，长度检测 |
| Agent 权限 | 中 | 沙盒配置，工具策略 |
| 消息伪造 | 中 | 群组/DM 策略配置 |

---

## 10. 关键设计模式总结

### 10.1 统一消息格式 (Message Normalization)

**核心思想**: 所有平台的消息都转换为统一的 `MsgContext` 结构，后续逻辑只处理这一种格式。

**优点**:
- 新增平台只需实现转换逻辑
- 核心业务逻辑与平台解耦
- 便于测试和维护

```typescript
// 每个频道实现自己的转换函数
function telegramToMsgContext(update: TelegramUpdate): MsgContext { ... }
function discordToMsgContext(message: DiscordMessage): MsgContext { ... }
function feishuToMsgContext(event: FeishuEvent): MsgContext { ... }
```

### 10.2 插件化频道 (Channel as Plugin)

**核心思想**: 频道作为插件存在，实现统一接口，可热插拔。

**优点**:
- 易于扩展新平台
- 核心代码不需要了解平台细节
- 可以独立开发和测试频道

```typescript
interface ChannelPlugin {
  id: string;
  monitor?: { start, stop };
  send?: (ctx) => Promise<Result>;
  status?: () => Promise<Status>;
}
```

### 10.3 出站连接优先 (Outbound-First)

**核心思想**: 优先使用出站连接（Long Polling、WebSocket）而非入站 Webhook。

**优点**:
- 不需要公网 IP
- 不需要配置防火墙
- 更适合本地部署场景

**实现方式**:
- Telegram: Long Polling (`getUpdates`)
- Discord: Discord Gateway (WebSocket)
- Slack: Socket Mode
- 飞书/企微: WebSocket 长连接

### 10.4 灵活路由 (Flexible Routing)

**核心思想**: 支持按多个维度（频道、群组、用户）路由到不同 Agent。

**优点**:
- 同一用户在不同场景可使用不同 Agent
- 支持多租户场景
- 便于权限隔离

### 10.5 Session 隔离 (Session Isolation)

**核心思想**: 每个对话有独立的 Session，包含独立的消息历史。

**Session Key 设计**:
```
{agentId}@{channel}@{peerId|groupId}
```

**优点**:
- 对话上下文隔离
- 支持多 Agent 并发
- 便于数据管理和清理

---

## 11. 针对 Tauri + React 项目的建议

### 11.1 架构建议

对于一个 Tauri + Bun + React 的本地 Agent 客户端，要增加 Bot 模式支持飞书/企业微信/QQ，建议采用以下架构：

```
┌─────────────────────────────────────────────────────────────────┐
│                      Tauri 应用                                  │
│                                                                  │
│  ┌─────────────────────────────────────────────────────────┐   │
│  │                    React UI                              │   │
│  │  - 主对话界面                                            │   │
│  │  - Bot 配置界面                                          │   │
│  │  - 频道状态监控                                          │   │
│  └─────────────────────────┬───────────────────────────────┘   │
│                            │ IPC                               │
│  ┌─────────────────────────┴───────────────────────────────┐   │
│  │                   Tauri Rust Backend                     │   │
│  │  - 系统托盘                                              │   │
│  │  - 进程管理                                              │   │
│  │  - 文件系统访问                                          │   │
│  └─────────────────────────┬───────────────────────────────┘   │
│                            │ 启动/管理                         │
│  ┌─────────────────────────┴───────────────────────────────┐   │
│  │              Bot Gateway (Bun 进程)                      │   │
│  │  ┌─────────────┐  ┌─────────────┐  ┌─────────────┐     │   │
│  │  │ 飞书频道    │  │ 企微频道    │  │ QQ 频道     │     │   │
│  │  │ (WebSocket) │  │ (WebSocket) │  │ (协议适配)  │     │   │
│  │  └─────────────┘  └─────────────┘  └─────────────┘     │   │
│  │                          ↓                              │   │
│  │  ┌─────────────────────────────────────────────────┐   │   │
│  │  │              统一消息处理层                       │   │   │
│  │  │  - 消息规范化                                    │   │   │
│  │  │  - 路由分发                                      │   │   │
│  │  │  - Session 管理                                  │   │   │
│  │  └─────────────────────────────────────────────────┘   │   │
│  │                          ↓                              │   │
│  │  ┌─────────────────────────────────────────────────┐   │   │
│  │  │              Agent 执行层                        │   │   │
│  │  │  (复用现有的 Agent 逻辑)                         │   │   │
│  │  └─────────────────────────────────────────────────┘   │   │
│  └─────────────────────────────────────────────────────────┘   │
└─────────────────────────────────────────────────────────────────┘
```

### 11.2 核心模块设计

#### 11.2.1 消息上下文接口

```typescript
// types/message.ts
interface BotMessageContext {
  // 基本信息
  id: string;
  text: string;
  channel: "feishu" | "wecom" | "qq";
  timestamp: number;

  // 发送者
  sender: {
    id: string;
    name: string;
    avatar?: string;
  };

  // 对话上下文
  conversation: {
    type: "private" | "group";
    id: string;
    name?: string;
  };

  // 附件
  attachments?: Array<{
    type: "image" | "file" | "audio";
    url?: string;
    data?: string;
  }>;

  // 引用消息
  replyTo?: string;

  // 平台原始数据（用于回复时需要的特定信息）
  _raw?: unknown;
}
```

#### 11.2.2 频道插件接口

```typescript
// types/channel.ts
interface ChannelPlugin {
  id: string;
  name: string;

  // 初始化
  init(config: ChannelConfig): Promise<void>;

  // 连接控制
  connect(): Promise<void>;
  disconnect(): Promise<void>;

  // 消息处理
  onMessage(handler: (ctx: BotMessageContext) => Promise<void>): void;

  // 发送消息
  send(opts: {
    conversationId: string;
    text: string;
    replyTo?: string;
  }): Promise<void>;

  // 状态
  getStatus(): ChannelStatus;
}

type ChannelStatus = {
  connected: boolean;
  error?: string;
  lastMessageAt?: number;
};
```

#### 11.2.3 Bot Gateway 主类

```typescript
// gateway/bot-gateway.ts
class BotGateway {
  private channels: Map<string, ChannelPlugin> = new Map();
  private router: MessageRouter;
  private sessionManager: SessionManager;
  private agentExecutor: AgentExecutor;

  async registerChannel(plugin: ChannelPlugin): Promise<void> {
    await plugin.init(this.getChannelConfig(plugin.id));

    plugin.onMessage(async (ctx) => {
      await this.handleMessage(ctx);
    });

    this.channels.set(plugin.id, plugin);
  }

  private async handleMessage(ctx: BotMessageContext): Promise<void> {
    // 1. 访问控制
    if (!this.checkAccess(ctx)) {
      return;
    }

    // 2. 路由到 Agent
    const agentId = this.router.resolve(ctx);

    // 3. 获取/创建 Session
    const session = await this.sessionManager.getOrCreate({
      agentId,
      channel: ctx.channel,
      conversationId: ctx.conversation.id,
    });

    // 4. 执行 Agent
    const response = await this.agentExecutor.run({
      agentId,
      session,
      message: ctx.text,
      attachments: ctx.attachments,
    });

    // 5. 发送回复
    const channel = this.channels.get(ctx.channel);
    await channel?.send({
      conversationId: ctx.conversation.id,
      text: response.text,
      replyTo: ctx.id,
    });

    // 6. 更新 Session
    await this.sessionManager.appendMessage(session.id, {
      role: "user",
      content: ctx.text,
    }, {
      role: "assistant",
      content: response.text,
    });
  }

  async start(): Promise<void> {
    for (const [id, channel] of this.channels) {
      try {
        await channel.connect();
        console.log(`Channel ${id} connected`);
      } catch (err) {
        console.error(`Channel ${id} failed to connect:`, err);
      }
    }
  }

  async stop(): Promise<void> {
    for (const [id, channel] of this.channels) {
      await channel.disconnect();
    }
  }
}
```

### 11.3 飞书频道实现示例

```typescript
// channels/feishu/index.ts
import { Client } from "@larksuiteoapi/node-sdk";

export class FeishuChannel implements ChannelPlugin {
  id = "feishu";
  name = "飞书";

  private client: Client;
  private wsClient: any; // 飞书 WebSocket 客户端
  private messageHandler?: (ctx: BotMessageContext) => Promise<void>;

  async init(config: FeishuConfig): Promise<void> {
    this.client = new Client({
      appId: config.appId,
      appSecret: config.appSecret,
    });
  }

  async connect(): Promise<void> {
    // 飞书支持 WebSocket 长连接接收消息
    // 参考: https://open.feishu.cn/document/uAjLw4CM/ukTMukTMukTM/event-subscription-guide/long-connection-method

    this.wsClient = await this.client.ws.start({
      eventDispatcher: new EventDispatcher().register({
        "im.message.receive_v1": async (data) => {
          const ctx = this.normalizeMessage(data);
          await this.messageHandler?.(ctx);
        },
      }),
    });
  }

  async disconnect(): Promise<void> {
    await this.wsClient?.stop();
  }

  onMessage(handler: (ctx: BotMessageContext) => Promise<void>): void {
    this.messageHandler = handler;
  }

  async send(opts: SendOpts): Promise<void> {
    await this.client.im.message.create({
      receive_id_type: "chat_id",
      data: {
        receive_id: opts.conversationId,
        msg_type: "text",
        content: JSON.stringify({ text: opts.text }),
      },
    });
  }

  private normalizeMessage(data: FeishuMessageEvent): BotMessageContext {
    return {
      id: data.message.message_id,
      text: JSON.parse(data.message.content).text,
      channel: "feishu",
      timestamp: parseInt(data.message.create_time),
      sender: {
        id: data.sender.sender_id.user_id,
        name: data.sender.sender_id.name,
      },
      conversation: {
        type: data.message.chat_type === "p2p" ? "private" : "group",
        id: data.message.chat_id,
      },
      _raw: data,
    };
  }

  getStatus(): ChannelStatus {
    return {
      connected: this.wsClient?.isConnected ?? false,
    };
  }
}
```

### 11.4 企业微信频道实现示例

```typescript
// channels/wecom/index.ts
export class WecomChannel implements ChannelPlugin {
  id = "wecom";
  name = "企业微信";

  private config: WecomConfig;
  private callbackServer?: http.Server;
  private messageHandler?: (ctx: BotMessageContext) => Promise<void>;

  async init(config: WecomConfig): Promise<void> {
    this.config = config;
  }

  async connect(): Promise<void> {
    // 企业微信通常使用回调模式
    // 但也可以使用长轮询或第三方库实现 WebSocket

    // 方案 1: 回调服务器（需要公网 IP 或内网穿透）
    if (this.config.callbackUrl) {
      await this.startCallbackServer();
    }

    // 方案 2: 使用第三方库的长连接模式
    // 如 wechaty 等
  }

  private async startCallbackServer(): Promise<void> {
    this.callbackServer = http.createServer(async (req, res) => {
      // 验证签名
      if (!this.verifySignature(req)) {
        res.writeHead(403);
        res.end();
        return;
      }

      // 处理消息
      const body = await readBody(req);
      const decrypted = this.decryptMessage(body);
      const ctx = this.normalizeMessage(decrypted);

      await this.messageHandler?.(ctx);

      res.writeHead(200);
      res.end("success");
    });

    await new Promise<void>(resolve => {
      this.callbackServer!.listen(this.config.callbackPort, resolve);
    });
  }

  async send(opts: SendOpts): Promise<void> {
    await fetch(`https://qyapi.weixin.qq.com/cgi-bin/message/send?access_token=${this.accessToken}`, {
      method: "POST",
      body: JSON.stringify({
        touser: opts.userId,
        msgtype: "text",
        agentid: this.config.agentId,
        text: { content: opts.text },
      }),
    });
  }

  private normalizeMessage(data: WecomMessage): BotMessageContext {
    return {
      id: data.MsgId,
      text: data.Content,
      channel: "wecom",
      timestamp: data.CreateTime * 1000,
      sender: {
        id: data.FromUserName,
        name: data.FromUserName, // 需要额外 API 获取名称
      },
      conversation: {
        type: data.ChatType === "single" ? "private" : "group",
        id: data.ChatId || data.FromUserName,
      },
      _raw: data,
    };
  }

  // ...
}
```

### 11.5 与 Tauri 的集成

```typescript
// src-tauri/src/bot.rs
use tauri::Manager;
use std::process::{Child, Command};

pub struct BotManager {
    process: Option<Child>,
}

impl BotManager {
    pub fn new() -> Self {
        Self { process: None }
    }

    pub fn start(&mut self, config_path: &str) -> Result<(), String> {
        if self.process.is_some() {
            return Err("Bot already running".into());
        }

        let child = Command::new("bun")
            .arg("run")
            .arg("bot-gateway.ts")
            .arg("--config")
            .arg(config_path)
            .spawn()
            .map_err(|e| e.to_string())?;

        self.process = Some(child);
        Ok(())
    }

    pub fn stop(&mut self) -> Result<(), String> {
        if let Some(mut process) = self.process.take() {
            process.kill().map_err(|e| e.to_string())?;
        }
        Ok(())
    }

    pub fn is_running(&self) -> bool {
        self.process.is_some()
    }
}

// Tauri commands
#[tauri::command]
fn start_bot(state: tauri::State<BotManager>, config_path: String) -> Result<(), String> {
    state.inner().start(&config_path)
}

#[tauri::command]
fn stop_bot(state: tauri::State<BotManager>) -> Result<(), String> {
    state.inner().stop()
}

#[tauri::command]
fn get_bot_status(state: tauri::State<BotManager>) -> bool {
    state.inner().is_running()
}
```

### 11.6 React UI 配置界面

```tsx
// src/components/BotSettings.tsx
import { invoke } from "@tauri-apps/api/tauri";
import { useState, useEffect } from "react";

export function BotSettings() {
  const [config, setConfig] = useState<BotConfig>({
    enabled: false,
    channels: {
      feishu: { enabled: false, appId: "", appSecret: "" },
      wecom: { enabled: false, corpId: "", secret: "", agentId: "" },
      qq: { enabled: false },
    },
  });

  const [status, setStatus] = useState<Record<string, ChannelStatus>>({});

  const handleToggleBot = async () => {
    if (config.enabled) {
      await invoke("stop_bot");
    } else {
      await invoke("start_bot", { configPath: "~/.myapp/bot-config.json" });
    }
    setConfig(prev => ({ ...prev, enabled: !prev.enabled }));
  };

  return (
    <div className="bot-settings">
      <h2>Bot 模式设置</h2>

      <div className="master-switch">
        <label>
          <input
            type="checkbox"
            checked={config.enabled}
            onChange={handleToggleBot}
          />
          启用 Bot 模式
        </label>
      </div>

      {config.enabled && (
        <div className="channels">
          <FeishuConfig
            config={config.channels.feishu}
            status={status.feishu}
            onChange={(c) => updateChannelConfig("feishu", c)}
          />

          <WecomConfig
            config={config.channels.wecom}
            status={status.wecom}
            onChange={(c) => updateChannelConfig("wecom", c)}
          />

          <QQConfig
            config={config.channels.qq}
            status={status.qq}
            onChange={(c) => updateChannelConfig("qq", c)}
          />
        </div>
      )}
    </div>
  );
}
```

### 11.7 关键注意事项

1. **国内平台的连接方式**
   - 飞书: 支持 WebSocket 长连接 ✅
   - 企业微信: 主要是回调模式，需要公网 IP 或内网穿透
   - QQ: 官方 API 有限，可能需要使用第三方协议（如 go-cqhttp）

2. **回调模式的处理**
   - 如果必须使用回调模式，可以考虑:
     - 内网穿透（ngrok、frp）
     - 云函数转发
     - 配合 Tailscale Funnel

3. **安全考虑**
   - 凭证安全存储（使用系统 Keychain）
   - 访问控制（白名单机制）
   - 消息加密验证

4. **用户体验**
   - 提供清晰的配置引导
   - 显示各频道连接状态
   - 支持一键测试连接

---

## 附录

### A. 相关文件路径速查

| 功能 | 文件路径 |
|------|---------|
| Gateway 主入口 | `src/gateway/server.impl.ts` |
| 消息路由 | `src/routing/resolve-route.ts` |
| Session 管理 | `src/config/sessions.ts` |
| Agent 执行 | `src/commands/agent.ts` |
| 频道插件接口 | `src/channels/plugins/types.ts` |
| 频道注册表 | `src/channels/registry.ts` |
| Telegram 实现 | `src/telegram/` |
| Discord 实现 | `src/discord/` |
| 安全审计 | `src/security/audit.ts` |
| 配置类型 | `src/config/types.gateway.ts` |

### B. 参考链接

- [飞书开放平台 - WebSocket 订阅](https://open.feishu.cn/document/uAjLw4CM/ukTMukTMukTM/event-subscription-guide/long-connection-method)
- [企业微信开发文档](https://developer.work.weixin.qq.com/document/)
- [QQ 机器人开放平台](https://bot.q.qq.com/wiki/)
- [Tauri 文档](https://tauri.app/zh-cn/v1/guides/)

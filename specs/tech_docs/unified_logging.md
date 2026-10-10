# 统一日志系统 (Unified Logging)

## 概述

MyAgents 使用统一日志系统聚合来自三个来源的日志：
- **React** - 前端 `console.log/error/warn/debug`
- **NODE** - Node.js Sidecar 后端日志
- **Rust** - Tauri 原生层日志

TabProvider 聚合日志的 UI 投影，UnifiedLogsPanel 负责展示。Node 与 Rust 各自拥有日志持久化；React 日志经批量 API 交给 Node 写入。

## 架构

```
┌─────────────────────────────────────────────────────────────┐
│                      TabProvider                             │
│                                                              │
│  React logs ──► CustomEvent ──► appendUnifiedLog ──► UI     │
│                              └─► buffer ──► /api/unified-log│
│                                                              │
│  Node logs ───► SSE chat:log ──► appendUnifiedLog ──► UI    │
│                (server-side persistence via UnifiedLogger)   │
│                                                              │
│  Rust logs ───► Tauri event ──► appendUnifiedLog ──► UI     │
│                (Rust 侧直接写入文件，不经过前端 API)          │
└─────────────────────────────────────────────────────────────┘
```

### 持久化机制

| 来源 | 持久化方式 | 说明 |
|------|-----------|------|
| React | 前端 buffer → `/api/unified-log` | 批量发送，500ms debounce |
| NODE | 服务端 `UnifiedLogger.ts` queue + 100ms flusher | async/bounded writer，队列上限 1000，50MB rotation，overflow 计数告警 |
| Rust | `logger.rs` bounded mpsc + BufWriter | async/bounded writer，200ms flush，overflow 计数告警；Rust 侧仍直接写文件避免循环 |

Rust 日志直接在 Rust 侧写入文件，而不是通过前端 API，这样可以避免日志循环：
```
❌ Rust log → 前端 → POST /api/unified-log → Rust proxy 日志 → 新 Rust log → ...
✅ Rust log → logger.rs bounded writer → 直接写入文件 (无循环)
```

Node/Rust 日志都不是 per-call 同步写入：

- Node `UnifiedLogger.ts`：in-memory queue、100ms flusher、bounded queue、drop counter、50MB per-file rotation、exit drain。
- Rust `logger.rs`：bounded mpsc、single writer task、`BufWriter<File>`、200ms flush、drop counter、pre-init sync fallback。

同一条 Node 日志必须只有一个文件持久化 owner。Sidecar logger 初始化后，`console.log/warn/error/debug` 与 `sendLog()` 由 Node `UnifiedLogger.ts` 落盘；`console.info` 没有被该 logger 接管，不能用它记录需要排障留存的 Sidecar 诊断。Rust 只保留真实的原始 stderr（native/runtime crash 与 logger 初始化前输出），不得让已被 Node 落盘的 `console.warn/error` 再经 stderr 进入 `[bun-err]`。stdout 仅承担初始化握手，Rust 看到 `[Logger] Unified logging initialized` 后停止捕获。Plugin Bridge 不初始化 Node UnifiedLogger，因此它的 stdout/stderr 仍由 Rust Bridge owner 落盘。

Rust unit-test binary 不写用户真实的 `~/.myagents/logs/unified-*.log`；测试日志只进入测试 runner 的标准日志捕获。这样 synthetic failure 不会污染随后用于产品排障的本机日志。

统一日志已有 correlation fields，可直接用于性能 trace 和排障过滤：`sessionId / tabId / ownerId / requestId / turnId / runtime`。

Renderer HTTP 请求通过 `x-myagents-log-session-id` 传递日志关联 Session；Tab / Companion 提供各自关联值，通用请求入口仅在缺失时补当前界面关联。该字段不决定 Global / Session 路由，也不参与 CLI scope 准入。Node HTTP 日志入口优先读取它，CLI 请求则沿用 `x-myagents-session-id` 作为日志关联回退；后者仍由 CLI scope owner 独立校验执行身份，不能把界面关联写入该身份头。

## 日志类型

```typescript
// src/shared/types/log.ts
// The historical 'bun' source tag remains part of the persisted wire format.
// Renderer presentation maps it to the current Node label.
export type LogSource = 'bun' | 'rust' | 'react';
export type LogLevel = 'info' | 'warn' | 'error' | 'debug';

export interface LogEntry {
  source: LogSource;
  level: LogLevel;
  message: string;
  timestamp: string;  // ISO 8601
  meta?: Record<string, unknown>;
  sessionId?: string;
  tabId?: string;
  ownerId?: string;
  requestId?: string;
  turnId?: string;
  runtime?: string;
  runtimeSource?: string;
}
```

`src/shared/types/log.ts` 是 Renderer 与 Server 共用日志类型的唯一定义。`src/renderer/types/log.ts` 只做 type-only re-export，Server 不得反向依赖 Renderer 类型。

## 核心组件

### 1. frontendLogger.ts (React 日志拦截)

拦截前端 `console.log/error/warn/debug`，将这些日志分发到 UI 和持久化队列；`console.info` 不在此拦截范围内。

```typescript
// 初始化（在 main.tsx 调用一次）
import { initFrontendLogger } from '@/utils/frontendLogger';
initFrontendLogger();

// 之后所有 console.log 自动被拦截
console.log('[MyComponent] something happened');  // 自动分发
```

**关键特性**：
- 批量发送：500ms debounce，50 条强制刷新
- 防递归：过滤 `[FrontendLogger]` 前缀的消息
- Cleanup：`forceFlushLogs()` 在 App unmount 时调用

### 2. UnifiedLogger.ts (服务端持久化)

将日志写入每日文件 `~/.myagents/logs/unified-{YYYY-MM-DD}.log`。

```typescript
// 服务端使用
import { appendUnifiedLog, cleanupOldUnifiedLogs } from './UnifiedLogger';

// 启动时清理旧日志
cleanupOldUnifiedLogs();

// 写入日志
appendUnifiedLog({
  source: 'bun',
  level: 'info',
  message: 'Server started',
  timestamp: new Date().toISOString()
});
```

### 3. AgentLogger.ts (Agent 会话日志)

独立的 Agent 会话日志，与统一日志分开存储。

```typescript
// 文件命名：{YYYY-MM-DD}-{sessionId}.log
// 存储位置：~/.myagents/logs/
// 特性：懒加载创建（首次写入时才创建文件）
```

### 4. 异常 crash artifact（不属于 unified log）

`~/.myagents/logs/crash/*.log` 只记录 `uncaughtException`、`unhandledRejection`、异常 stdio 等真正异常事件；正常 STARTUP / EXIT / SIGTERM 只进入 unified log，健康生命周期不会创建 crash 目录或文件。

Node Sidecar 只拥有自己的懒写文件：文件名含 timestamp + PID + nonce，单文件硬上限 50MB，并按创建时间在 30 天边界轮转。共享目录清理归始终存在的 Tauri 应用进程单一持有，在应用启动立即执行并每小时复查，覆盖升级前 backlog 与没有 Global Sidecar 的 idle 场景：

- 最长 30 天；
- 最多 20 个 `.log`；
- 历史单文件超过 50MB 时删除；
- 目录总量最多 200MB，超限时从最旧文件开始删除。

排查磁盘增长时必须分别统计 unified/session log 与 crash artifact；后者的文件数量不再代表 Sidecar 生命周期次数。

### 5. logUtils.ts (共享常量)

```typescript
export const MYAGENTS_DIR = join(homedir(), '.myagents');
export const LOGS_DIR = join(MYAGENTS_DIR, 'logs');
export const LOG_RETENTION_DAYS = 30;
```

## API 端点

### POST /api/unified-log

接收前端日志批次并持久化。

```typescript
// Request
{
  entries: LogEntry[]
}

// Response
{ success: true }
```

## 最佳实践

### 1. 使用标准 console 方法

```typescript
// ✅ 直接使用，自动被拦截
console.log('[MyComponent] info');
console.warn('[MyComponent] warning');
console.error('[MyComponent] error');
console.debug('[MyComponent] debug');

// ❌ 不要直接调用 frontendLogger 内部方法
```

### 2. 日志前缀规范

```typescript
// ✅ 使用模块名前缀
console.log('[TabProvider] SSE connected');
console.log('[Chat] Message sent');

// ❌ 无前缀或不一致
console.log('connected');
console.log('Chat - sent');
```

Builtin 输入生命周期使用 `[builtin-input]` 前缀，记录 Query replacement、resolver park/wake/clear、consumer 请求下一项、terminal/provider/MCP/admission 等待、提交、SDK yield、输入退休以及 Stop/force 的快照。字段限于 generation、Product Session 关联、布尔状态与各输入队列数量，不记录消息正文、工作区路径、Provider 配置或回调对象。`inputGeneration` 属于该 generator，`currentGeneration` 属于当前 Query；Query factory 尚未登记 authority 时前者可为 null。resolver 的 installed/current generation 可识别旧消费者的迟到唤醒。

排查“上一轮已完成，下一条输入不消费”时保留同一 Sidecar 的原始日志顺序，对照最后一次 `consumer-next`、`terminal-ready`、`resolver-parked/received` 与 `sdk-yield`；这些日志定位产品侧交接边界，不能单凭 HTTP 健康、Query 存在或没有后续日志证明 SDK 内部消费健康。

### 3. 避免日志循环

```typescript
// ✅ 在日志相关代码中使用原始 console
import { getOriginalConsole } from '@/utils/frontendLogger';
const originalConsole = getOriginalConsole();
originalConsole.log('[FrontendLogger] internal message');

// ❌ 在日志代码中使用被拦截的 console
console.log('[FrontendLogger] ...');  // 会被过滤掉
```

### 4. Cleanup 时刷新日志

```typescript
// App.tsx
useEffect(() => {
  return () => {
    forceFlushLogs();  // 确保日志不丢失
    // Sidecar 应用生命周期由 Rust RunEvent::ExitRequested 统一清理；
    // React unmount 也可能来自 error recovery，不能在这里停止进程。
  };
}, []);
```

### 5. 批量发送日志

```typescript
// ✅ 使用 queueLogsForPersistence 批量入队
import { queueLogsForPersistence } from '@/utils/frontendLogger';
queueLogsForPersistence(entries);  // 自动批量发送

// ❌ 每条日志单独发送 HTTP 请求
for (const entry of entries) {
  await fetch('/api/unified-log', { body: JSON.stringify({ entries: [entry] }) });
}
```

### 6. 在 secret-bearing transport 边界投影错误

HTTP client 的错误文本通常携带完整请求 URL。若协议把凭据放在 URL 中
（例如 Telegram Bot API 的 `/bot{token}/...`），不得把 `reqwest::Error`、
`Request` 或完整 URL 直接格式化进产品错误和日志；transport owner 必须先投影为
`timeout / connection / request / body / decode` 等无 URL 的有界类别。状态码和
服务端返回的非敏感错误描述可按现有协议记录，但不能依赖事后日志正则来补救。

### 7. Record / Recording / Speech 隐私边界

录音与转录日志只能记录模块前缀、operation、Record/job 的受控 identity、generation、公开资源 bytes、固定 stage 和结构化错误码。严禁记录音频/PCM、transcript、笔记、Mark、speaker name、embedding、完整本地路径、模型下载原始响应或 Worker 原始 stderr。Worker stderr 只允许 `bytes + truncated` 等有界摘要；产品 analytics 继续走既有 typed event bridge，不得复制进 unified log。

推荐前缀固定为 `[record]`、`[recording]`、`[speech]`。面向用户的原始错误可以走既有产品返回契约，但写日志前必须投影为稳定 code/metadata，不能把路径或用户内容夹在 `format!("{error}")` 中。

## 文件结构

```
~/.myagents/
└── logs/
    ├── unified-2025-01-25.log      # 统一日志（React/NODE/Rust）
    ├── unified-2025-01-24.log
    ├── 2025-01-25-abc123.log       # Agent 会话日志
    ├── 2025-01-25-def456.log
    └── crash/                       # 仅异常事件；Tauri 应用级 retention owner
        └── 2025-01-25T10-30-45.000Z-12345-a1b2c3d4.log
```

## 日志格式

### 统一日志文件格式

```
2026-03-26 10:30:45.123 [REACT] [INFO ] [TabProvider] SSE connected
2026-03-26 10:30:45.234 [NODE ] [INFO ] Server started on port 31415
2026-03-26 10:30:45.345 [RUST ] [INFO ] Sidecar process spawned
```

> 持久化 wire format 仍接受 `[BUN  ]` source tag，UI 将它显示为 `[NODE ]`。已写日志的字面量保持不变，保证诊断搜索与旧文件读取兼容。

> **注意**：时间戳使用**本地时间** `YYYY-MM-DD HH:MM:SS.mmm`（非 UTC ISO 8601）。

### Agent 会话日志格式

```
2026-03-26 10:30:45.123 {"type":"user","message":{"role":"user","content":"Hello"},...}
2026-03-26 10:30:46.234 {"type":"assistant","message":{"role":"assistant","content":[...]},...}
```

## Boot Banner

应用启动时输出 Rust `[boot]` 自检；每个 Session Sidecar 完成 Runtime 初始化后输出 Node `[boot]` 自检。Global Sidecar 不创建 Session Runtime，因此没有第二行 Session 自检：

```
[boot] v=0.3.1 build=release os=macos-aarch64 provider=deepseek mcp=2 agents=3 channels=5 scheduled_tasks=12 proxy=false dir=/Users/xxx/.myagents
[boot] pid=12345 port=31415 node=24.14.0 workspace=/path session=abc-123 resume=true model=deepseek-chat bridge=yes mcp=playwright builtin-mcp-meta=gemini-image,edge-tts
```

**排查第一步**：`grep '[boot]' ./logs/unified-*.log`

### 主窗口启动阶段

白屏排查使用同一组稳定 `[boot] stage=...` 标签：

| 阶段 | Owner | 说明 |
|------|-------|------|
| `native-page-load-started/finished` | Rust `on_page_load` | WebView 导航是否开始/完成 |
| `native-init-script` | Tauri initialization script | HTML 模块执行前的最早 JS 证据 |
| `renderer-entry-evaluated` | renderer | `main.tsx` 已开始执行 |
| `theme-native-bootstrap-*` / `theme-renderer-bootstrap-*` | native bridge / ThemeRuntime | 首帧快照和 renderer prime 是否完成 |
| `react-root-created` / `react-commit` | renderer | React root 创建与真实 effect commit |
| `renderer-uncaught-error` / `renderer-unhandled-rejection` | initialization script | 模块加载或早期 promise 的有界错误 |

所有阶段都带 `window=<label>`，并进入同一个 `~/.myagents/logs/unified-*.log`：Rust page-load 直接走 `ulog_*!`；initialization script 与 `main.tsx` 在 App/Sidecar logger 尚未可用时调用受限 Tauri command `cmd_record_renderer_boot_event`，由 Rust unified logger 持久化。该 command 只接受白名单 stage、有界单行 detail 和合法 window label，不是第二个通用日志 API；禁止绕回 raw `plugin:log|log`，否则阶段链会分裂到 OS LogDir。

`tauri_plugin_log::Builder::default()` 已自带 `Stdout + LogDir`。应用自定义 target 时必须先 `clear_targets()` 再各注册一次；直接在 default builder 上追加同名 target 会让每条原生日志成倍输出。启动观测只能记录证据，不得据此自动 reload、retry 或切换 Theme。

## 日志降噪策略

日志过滤遵循“transport 不记、semantic boundary 只记有界摘要”的 owner 原则：

| 层 | 位置 | 过滤内容 |
|----|------|---------|
| L1 | `sse.ts` `SILENT_EVENTS` + `claude-code.ts` NDJSON reader | 所有 SSE text/thinking/tool/subagent chunk 或 delta、V2 `transcript-operation` 与 `transcript-save-status`，以及 MCP effective、runtime tool catalog/diagnostics、context usage、agent plan 的连续 UI 快照；Claude Code raw stream-json（启用 partial messages）同样静默。不得按每 N 条采样或聚合正文后重新落盘。非静默 SSE 也只能记录事件名与整个 payload 的 `{present, chars, hash}` 不可逆摘要（replay 的受控 message ID/role/scope 语义投影除外），不能递归预览字段；解析后的无正文 semantic summary 可记录 |
| L2 | `http-log-policy.ts` | `/health{,/live,/ready,/functional}`、`/api/unified-log`、`/api/session-state`、`/agent/dir`、`/sessions`、`/api/commands`、`/api/agents/enabled`、`/api/git/branch` 的成功轮询请求行 |
| L3 | `sidecar/stdio.rs` + `sidecar/session_lifecycle.rs` / `sidecar/instances.rs` node-out 去重 | Node.js logger 初始化后停止 stdout 捕获（检测 `[Logger] Unified logging initialized`） |
| L4 | `logger.ts` WARN/ERROR owner | patched `console.warn/error` 只由 Node logger 落盘，不再镜像到 stderr 形成 Rust 第二份副本 |
| L5 | `bridge.rs` + Plugin Bridge compat logger | 过滤 heartbeat，以及插件逐次 `onPartialReply` debug snapshot |
| L6 | `agent-session.ts` SDK message | 摘要替代完整 JSON（`type=assistant model=opus`） |

SSE 的传输优先级与日志策略相互独立：`transcript-operation` 和保存状态仍按 critical 完整投递，静默只跳过逐包日志序列化与打印，不修改 revision、缓存、顺序、背压或产品历史持久化。新增包装事件即使名称不含 chunk/delta，也要按实际频率和内容语义判断。最终总量复用 turn/content owner 的现有汇总，不在 SSE 层缓存正文、增加定时采样或另建汇总队列；保存故障由 `TranscriptWriter.fail` 按状态/原因变化告警，Runtime 的语义诊断、完成/停止/错误事件及连接/背压异常继续保留。

Builtin / external runtime 在 turn/content 完成边界输出 `[assistant-output]`；V1 保留持久化后的时机，V2 不等待 durable commit，该日志不代表保存成功，保存状态由 TranscriptWriter 单独报告。组合文本先归一化为单行，仅保留前 100 个 Unicode code point，并记录原始 `chars`。流式 delta 与 raw partial transport 永不进入统一日志；既有低频 SDK result 诊断仍可保留自身的有界字段摘要。Plugin Bridge 的 pending dispatch terminal 只记录 `canonical_final` 的 count/chars/hash，不再复制同一 IM 正文。Codex `thread/start|resume` 的 `developerInstructions`、`cwd`、thread ID 属于敏感启动参数，notification 中的 command、file path、tool value、provider error 和 stderr 也属于敏感 runtime payload；日志只允许计数、稳定协议枚举与 `{present, chars, hash}`，不得记录任何文本前缀，实际 RPC/事件参数保持原值。`external-session.ts` 的 terminal/log owner 同样只能把 Runtime error 投影成这组不可逆 metadata 后写 `console`/perf trace；面向 Chat/IM 的原始 terminal error 仍沿既有产品事件传递，不能为了日志脱敏破坏用户错误契约。

SDK user message 摘要通过 `contentKind`、`textLength`、`isEmptyContent` 区分字符串、内容块、空值与缺失，并保留 `isReplay`。`contentBlockCount=0` 只表示没有数组内容块，不表示字符串消息为空；仅图片的非空数组也不算空消息。generator yield 沿既有 `queueId` / `requestId` 关联这份摘要，不记录原始正文或改变投递队列。

**时间戳格式**：本地时间 `YYYY-MM-DD HH:MM:SS.mmm`（非 UTC ISO 8601）。

## 故障排查

先确认报告的机器、版本与时间窗口，并优先读取用户提供的日志或日志包。未指定来源时，读取本机 `~/.myagents/logs/unified-{YYYY-MM-DD}.log`，日期按故障发生地的本地时间选择；跨日问题读取相邻日期。不要用本机当天日志推断另一台机器或旧版本的行为。按 Session / Record / job 等关联字段缩小范围，避免整份日志无差别输出。

### 日志不显示

1. 检查 `initFrontendLogger()` 是否在 `main.tsx` 中调用
2. 检查 TabProvider 是否正确监听 `REACT_LOG_EVENT`
3. 检查 UnifiedLogsPanel 的 `sseLogs` prop

### 日志不持久化

1. React：检查发送 buffer、`logServerReady` 与 Global Sidecar 的 `/api/unified-log`；此路径不负责 Node/Rust 的落盘。
2. Node / Rust：分别检查 `UnifiedLogger.ts` / `logger.rs` 的队列、flush 与 drop 诊断。
3. 检查报告机器上日志目录的权限和磁盘空间。

### Rust 日志不显示

1. 确认在 Tauri 环境中运行（`isTauri()` 返回 true）
2. 检查 Rust 侧是否 emit `log:rust` 事件
3. 检查 TabProvider 中的 Tauri event listener

### 录音或转录失败

先按本地日期检索结构化模块与错误码：

```bash
grep -E '\[(record|recording|speech)\]|RECORDING_|SPEECH_' ~/.myagents/logs/unified-*.log | tail -80
```

- `RECORDING_*` 优先检查平台权限、设备 identity 与 PipeWire/WASAPI/ScreenCaptureKit；模型重装不能修复 capture 问题。
- `SPEECH_RESOURCE_*` / `SPEECH_MODEL_*` 检查 native manifest、共享 ORT、签名 manifest、pack hash 与最小加载。
- Agent 的 `SPEECH_JOB_NOT_FOUND` 先回到原发起 Session 执行 `myagents speech list`；不要要求暴露全局 job 列表。
- 音频 artifact 已存在但 transcript 为空时，确认该 Record 是否只需要用户手动点击“开始转录”；缺少自动 backfill 本身不一定是故障。

排查过程中不要把用户音频、转录全文或 `~/.myagents/records/` 打包进日志附件。

### 前端整页崩溃（「界面渲染出错」/ 白屏）

`AppErrorBoundary`（`src/renderer/components/AppErrorBoundary.tsx`）挂在 `main.tsx` 的 React 根、**所有 provider 之外，且没有 per-tab / per-message 子边界**——所以任意一个组件 render 抛错就会冒泡到它、把**整个界面**替换成「界面渲染出错」卡片（不是局部某块）。它的 `componentDidCatch` 把 `error` + `componentStack` 经 `console.error('[AppErrorBoundary] ...')` 写进统一日志。

排查：

```bash
grep -E '\[AppErrorBoundary\]|\[REACT\] \[ERROR\]' ~/.myagents/logs/unified-*.log | tail -30
```

- **`error.message`** 保真（运行时字符串，如 `Cannot read properties of undefined (reading 'trim')`）——主要定位线索；配合时间线看崩前发生了什么（常见诱因：**恢复旧 session**、渲染恢复态/流式数据时把可选字段当必有 string）。
- **`componentStack`** 只在 dev / 有 sourcemap 时能定位到组件；release 包被 minify 成 `at t` 这类乱码，别据此硬猜。
- 这类几乎都是真前端 Bug（信任 restored / partial 数据导致 render 抛错），不是用户配置能修的。小助理侧的 triage→报 Bug 流程见 helper `/support` §1.6。

## 相关文件

| 文件 | 说明 |
|------|------|
| `src/renderer/utils/frontendLogger.ts` | React console 拦截 |
| `src/renderer/context/TabProvider.tsx` | 日志状态管理 |
| `src/renderer/components/UnifiedLogsPanel.tsx` | 日志 UI 面板 |
| `src/shared/types/log.ts` | Renderer/Server 共用的日志 wire 类型定义 |
| `src/renderer/types/log.ts` | Renderer 本地的 type-only re-export |
| `src/server/logger.ts` | Node.js 日志拦截 |
| `src/server/UnifiedLogger.ts` | 统一日志持久化 |
| `src/server/AgentLogger.ts` | Agent 会话日志 |
| `src/server/logUtils.ts` | 共享常量 |
| `src-tauri/src/logger.rs` | Rust 日志模块 |

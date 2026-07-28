# MyAgents 架构总览

> 分层认知地图。先读“项目定位 / 全景架构图 / 核心抽象”，再按任务定位“模块地图”中的相关章节；不要默认把全文塞进上下文。Owner、进程边界与主数据流在这里，helper API、事故案例和操作步骤见 `tech_docs/`。

## 项目定位

MyAgents 是基于 Tauri v2 的桌面 AI Agent 客户端，提供 Claude Agent SDK 的图形界面。

支持：
- 多 Tab 对话
- Goal 模式（current-session 长程目标）
- IM Bot（Telegram / 钉钉 / OpenClaw 社区插件）
- 定时任务
- MCP 工具集成
- 多 Agent Runtime（Claude Code CLI / Codex CLI / Gemini CLI）
- 任务中心（想法速记 + 任务编辑 + 调度 + 状态机审计）

## 技术栈

| 层级 | 技术 |
|------|------|
| 前端 | React 19 + TypeScript + Vite + TailwindCSS |
| 桌面框架 | Tauri v2 (Rust) |
| 后端 | Node.js v24 + Claude Agent SDK 0.3.201（多实例 Sidecar 进程） |
| 通信 | Rust HTTP/SSE Proxy (reqwest via `local_http` 模块) |
| 拖拽 | @dnd-kit/sortable |

> **单一 runtime 原则**：所有 MyAgents 自己的代码（Sidecar / Bridge / CLI）跑在内置 Node.js v24 上。
> SDK native binary 子进程内部静态链接的 Bun 是 SDK 团队的实现细节，通过 stdio NDJSON 与我们通信，
> 不共享 MyAgents Node 进程内状态；但 builtin Anthropic 订阅会按 Claude Code native 默认规则读取本机官方 OAuth credential store。详见 `tech_docs/bundled_node.md`。

## 全景架构图

```
┌──────────────────────────────────────────────────────────────────────────────┐
│                            Tauri Desktop App                                 │
├──────────────────────────────────────────────────────────────────────────────┤
│                              React Frontend                                  │
│  ┌────────────────┐ ┌────────────────────────────────────────────────────┐  │
│  │ GlobalSidebar  │ │ Active Tab Workspace                               │  │
│  │ App Shell      │ │ Tab1 / Tab2 / Settings / Launcher / Capabilities   │  │
│  │ nav + resource │ │ TaskCenter / Space                                 │  │
│  │ projection     │ └───────────────────────┬────────────────────────────┘  │
│  └───────┬────────┘                         │                               │
│          │                 ┌────────────────┴───────────────────────────┐   │
│  App/config/task stores    │ Tab-scoped useTabState + Browser/Term     │   │
│  plan/focus existing Tabs  │ apiGet/apiPost/SSE + Tauri 子 Webview/PTY │   │
│                            └────────────────────────────────────────────┘   │
├──────────────────────────────────────────────────────────────────────────────┤
│                              Rust Layer                                      │
│  ┌────────────────┐ ┌──────────────────┐ ┌─────────────────────────────┐    │
│  │ SidecarManager │ │ ManagedAgents +  │ │ TaskStore + TaskScheduler   │    │
│  │ Session-1:1   │ │ ManagedImBots    │ │ SessionGoal / SearchEngine  │    │
│  │ Owner Model   │ │ (Channels)       │ │ (Tantivy + jieba)           │    │
│  └───────┬────────┘ └────────┬─────────┘ └─────────────────────────────┘    │
│          │                   │                                              │
│  ┌───────┴────────────────┐  ├─ Telegram (Bot API)                          │
│  │  HTTP/SSE Proxy        │  ├─ Dingtalk (Stream)                           │
│  │  (reqwest local_http)  │  └─ BridgeAdapter ───── Plugin Bridge (Node)    │
│  └───────┬────────────────┘                          ↕ HTTP                 │
│          │                                       OpenClaw 社区插件          │
│  ┌───────┴───────┐ ┌────────────────────┐ ┌──────────────────────────┐     │
│  │ Management API│ │  Tauri IPC         │ │  Embedded Terminal       │     │
│  │ (Node→Rust)   │ │  (cmd_*)           │ │  Embedded Browser        │     │
│  └───────────────┘ └────────────────────┘ └──────────────────────────┘     │
├──────────────────────────────────────────────────────────────────────────────┤
│                  Node.js Sidecar (per Session, 1:1)                         │
│  ┌─────────────────────────────────────────────────────────────────┐        │
│  │  Runtime Selector (config.multiAgentRuntime gate)              │        │
│  │  ┌─────────────┬───────────────┬──────────┬──────────────┐     │        │
│  │  │ builtin SDK │ Claude Code   │ Codex    │ Gemini       │     │        │
│  │  │ (in-proc)   │ CLI (NDJSON)  │ CLI(JSON │ CLI (ACP     │     │        │
│  │  │             │               │ -RPC2.0) │  JSON-RPC)   │     │        │
│  │  └─────────────┴───────────────┴──────────┴──────────────┘     │        │
│  │                                                                 │        │
│  │  In-process MCP:                                                │        │
│  │   META/INSTANCE registry: gemini-image / edge-tts               │        │
│  │   context-injected surface: im-bridge-tools                     │        │
│  │                                                                 │        │
│  │  External MCP via npx + 预置原生二进制 (cuse)                   │        │
│  │                                                                 │        │
│  │  OpenAI Bridge (DeepSeek/Gemini/Moonshot 协议翻译)              │        │
│  └─────────────────────────────────────────────────────────────────┘        │
└──────────────────────────────────────────────────────────────────────────────┘
```

每个 Sidecar 服务一个 Session。Tab / Task / Goal / BackgroundCompletion / Agent owner 共享同一 Sidecar，全部释放才停止进程。

---

## 核心抽象

理解以下抽象是改任何功能的前置认知。

### Sidecar Owner 模型

| 概念 | 说明 |
|------|------|
| **Sidecar = Agent 实例** | 一个 Sidecar 进程 = 一个 Claude Agent SDK 实例 |
| **Session : Sidecar = 1 : 1** | 每个 Session 最多一个 Sidecar，严格对应 |
| **后端优先，前端辅助** | Sidecar 可独立运行（定时任务、Agent Channel），无需前端 Tab |
| **Owner 模型** | Tab、Task、Goal、BackgroundCompletion、Agent 是 Sidecar 的使用者。所有 Owner 释放后 Sidecar 才停止 |

```rust
pub enum SidecarOwner {
    Tab(String),                   // Tab ID
    Task(String),                  // Task ID
    Goal(String),                  // Session Goal ID
    BackgroundCompletion(String),  // Session ID（AI 后台完成保活）
    Agent(String),                 // session_key（Agent Channel 消息处理）
}
```

### Tab-Scoped 隔离

每个 Chat Tab 拥有独立的 Node.js Sidecar 进程。

| 页面类型 | TabProvider | Sidecar 类型 | API 来源 |
|----------|-------------|--------------|----------|
| Chat | ✅ 包裹 | Session Sidecar | `useTabState()` |
| Settings | ❌ 不包裹 | Global Sidecar | `apiFetch.ts`（全局） |
| Capabilities（技能/插件/工具） | ❌ 不包裹 | Global Sidecar | 独立 Tab 页面状态；复用 Settings 能力模块与全局 API |
| Launcher | ❌ 不包裹 | Global Sidecar | `apiFetch.ts`（全局） |
| GlobalSidebar（App Shell） | ❌ 不包裹 | 不直接拥有 Sidecar | App/config/task stores 的投影；变更调用既有 authority，页面打开交回 `App` 规划或聚焦 Tab |
| IM Bot / Agent Channel | — (Rust 驱动) | Session Sidecar | Rust `ensure_session_sidecar()` |

不在 TabProvider 内的组件调用 `useTabStateOptional()` 返回 `null`，自动 fallback 到 Global API。

### 持久 Session

`messageGenerator()` 使用 `while(true)` 持续 yield，SDK subprocess 全程存活。

- 所有中止场景 MUST 使用 `abortPersistentSession()`（设置 abort 标志 + 唤醒 generator Promise 门控 + interrupt subprocess）
- 配置变更时 MUST 先设 `resumeSessionId` 再 abort，否则 AI "失忆"
- 所有 `await sessionTerminationPromise` 通过 `awaitSessionTermination(10_000, label)` 带 10 秒超时防护，防止死锁

**两种重启机制不要混淆：**

| 机制 | 行为 | 触发点 |
|------|------|--------|
| 直接 abort（`abortPersistentSession()`） | 立即中断 + interrupt subprocess | resetSession / switchToSession / rewindSession / recoverFromStaleSession / enqueueUserMessage provider change / provider proxy 凭证变化 / startup timeout / watchdog / end-of-turn drain / pre-warm drain |
| 延迟重启（`scheduleDeferredRestart('mcp' \| 'agents')`） | 合并防抖 + 下次 pre-warm 时柔性重启 | `setMcpServers` / `setAgents` |

### Pre-warm 机制

- MCP / Agents 同步触发 `schedulePreWarm()`（500ms 防抖），Model 同步**不**触发
- 持久 Session 中 pre-warm 就是最终 session，用户消息通过 `wakeGenerator()` 注入
- 任何 `!preWarm` 条件守卫都可能在持久模式下永远不执行
- 新增配置同步端点时，确保 `currentXxx` 变量在 pre-warm 前已设置

**MCP 配置权威来源分离：**
- Tab 会话的 MCP 由前端 `/api/mcp/set` 配置（`initializeAgent` 中 MUST NOT self-resolve MCP）
- IM 与尚未 materialize 的 backend-created Task Session 可从磁盘初始化；已有 Session 始终沿用自己的 MCP authority
- 混用会导致 fingerprint 差异 → abort → 30s 重启循环

### Goal 模式（Session 一等状态）

Goal 模式是当前 MyAgents session 的长程工作状态：用户通过 `/goal`，或 AI 在明确 User 要求后调用 `myagents goal create --objective-file ...`，都会让**同一个 current session** 进入 Goal Mode。Goal 不属于某个 React hook，也不属于普通 Cron surface；桌面、私聊 IM、私有 Agent Channel 打开同一 session 时应看到同一条 Goal 横条。

`SessionGoalManager` 是唯一业务 owner，持久化到 `~/.myagents/session_goals.json`，以 `sessionId` 查询当前 Goal。Goal 不创建 Task/CronTask，不持有 tab/model/provider/runtime/reasoning/MCP/delivery 快照；这些配置始终由 Session 拥有，只有 permission 是每轮执行 policy。创建前必须 materialize 真实 Session identity，Rust 拒绝 `pending-*`。

Goal concurrency 只保留三类真实 identity/fence：Runtime queue item 的 `queueId` 是 Turn 唯一身份；`sidecarGeneration` 阻止旧进程回写 replacement Sidecar；Goal `id` 阻止旧 incarnation 回写新 Goal。Node queue 拥有尚未 promotion 的消息，Rust 只在 Runtime promotion boundary 原子写一个 `currentTurn { queueId, kind, turnNumber, sidecarGeneration }`，不复制 pending admission queue，也不维护 Goal 专用 injected turn ID/Node authority map。

`revision` 对所有持久变化单调递增，供 UI/event 拒绝旧投影；`controlRevision` 只在 pause/resume/objective/terminal 等控制语义变化时递增，用于使 Stop 前准备的 continuation 失效。`src/server/session-engine/goal-orchestrator.ts` 在 builtin/external adapter 的实际 dispatch boundary claim，真实 terminal 后 finalize；Management 异常、stale revision/generation 或 claim reject 均 fail closed。

Renderer 发出的 Goal mutation 还必须通过 owner/projection fence 才能落回当前 UI：返回值的 `goalId + sessionId + normalize(workspacePath)` 必须仍匹配请求 owner，且当前 projection 仍是同一 Goal。切换 Session、同 Session 新建 Goal incarnation，或 cancel 后的迟到 pause/resume/cancel 响应都不得覆盖新投影。

自动 continuation 是 `goalId -> one-shot JoinHandle`，只在 active、无 current Turn、无待投递 outbox 时存在；paused/terminal Goal 不轮询。deadline 由同一个 `SessionGoalManager` 持有独立 one-shot stop handle，按 wall clock 复核后，在 session lifecycle 锁内持续复用既有 disk-first terminal + exact/owner-scoped stop 链，直到 authority 清除与 owner 释放确认，覆盖用户 Turn、自动 continuation 与 paused 状态。max executions 同时在 continuation 调度和原子 Turn claim 处裁决；输给结束条件的 claim 会保留该 queue authority，等既有 abort settlement 清除后才允许替换，不能在竞态中多抢一轮或泄漏旧 owner。实际发送统一走 `/goal/execute-sync` 和 SessionEngine facade。自动 continuation 在进入 Node dispatch 前先附着 `SidecarOwner::Goal(goalId)`，用户 query 最晚在 Turn claim 时附着；它只是现有 Sidecar 的 owner token，不创建独立进程。

桌面 Goal 先以 Paused 持久化并等待首条用户 turn；首条 claim 通过普通用户发送路径原子激活。`GOAL_CONTINUATION` hidden envelope 后保留原 objective visible tail，因此用户气泡、Goal badge 与实时 streaming 都存在；切换 Session 或发送失败不会产生 Active 空 Goal。后续自动 continuation 纯隐藏；Goal 运行中用户 query 使用 `GOAL_CONTEXT` + visible query，并由现有 Runtime queue 排序。所有 continuation 强制 turn boundary，不能 steer/merge 到正在运行的 Turn。

Pause/Cancel 先 disk-first 写 Goal 状态：已有 durable `currentTurn` 时用 owner + `queueId` 精确停止，普通 preclaim 则 owner-scoped 取消该 Goal 的 admission/promotion；若 transport failure 已知本次 queueId，即使 Rust 尚无 `currentTurn` 也走 exact stop。只有 stop 得到确认后才清 `currentTurn` / 释放 Goal owner；transport 或进程终止不确定时保留 authority/owner，供同一 queueId 重试。旧 queue/generation 的晚到结果无法恢复 Goal。Model 只能提交 complete/blocked，且 `aiCanExit=false` 在 Rust 终态事务中硬拒绝；User 只能 cancel，System 可按 end condition/连续失败终止。终态 first-writer-wins，先提交权威状态再做事件、通知和 owner 释放。

每个已结算 Goal Turn 复用 Runtime terminal 已有的 `durationMs` 与 input/output usage，经 `goal-orchestrator` 随同同一个 `queueId` finalize；`SessionGoalManager` 在清除 `currentTurn` 的原子提交里累加 `totalDurationMs` 与 `totalTokens`。这两个字段只用于终态横条汇总，口径分别是各 Turn 实际执行耗时之和与 input + output tokens 之和；不从 Session 历史反推，不包含暂停/通知等待，也不是 token/time budget 或独立 usage 账本。

IM/Agent Channel continuation 沿用 Session 原输出路由，不使用 Task/Cron delivery。仅 Agent Channel 结果进入 Goal 持久 outbox；稳定 delivery id + 单 replay worker 提供 at-least-once，push 成功到删除 outbox 之间崩溃仍可能重复。群聊 `NO_REPLY` 保持静默。

Goal 与 Task 相互独立，可以关联同一 Session：Task 负责定时投递一个 Turn，Goal 负责 Session 长程状态，实际顺序由同一 Runtime queue 决定。本期没有 Task->Goal 编排；需要组合时，Task prompt 可让 AI 在该 Session 调 `myagents goal create`。

### Rust 代理层

Renderer 与 Sidecar 的**控制面** HTTP / SSE 流量 MUST 通过 Rust 代理层（`invoke` → Rust → reqwest → Node.js Sidecar）。WebView 不得直连普通 API。仅大载荷**数据面**端点（当前为 `/refs/:id`、`/attachment/*`）允许原生 fetch，以避免二进制 / spill payload 再穿 IPC JSON；这些端点必须同时满足 CORS、CSP、大小限制与路径安全约束。该例外不得扩展成第二套控制面。

所有连接本地 Sidecar（`127.0.0.1`）的 reqwest 客户端 MUST 通过 `crate::local_http::*` 创建，内置 `.no_proxy()` 防止系统代理拦截 → 502。

详见 `tech_docs/pit_of_success.md` 的 `local_http` 节。

---

## 通信模式

### SSE 流式事件

Rust SSE Proxy (`src-tauri/src/sse_proxy.rs`) 多连接代理，按 Tab 隔离事件：

```
事件格式: sse:${tabId}:${eventName}
示例:     sse:tab-xxx:chat:message-chunk
```

```
Tab1 listen('sse:tab1:*') ◄── Rust emit(sse:tab1:event) ◄── reqwest stream ◄── Sidecar:31415
Tab2 listen('sse:tab2:*') ◄── Rust emit(sse:tab2:event) ◄── reqwest stream ◄── Sidecar:31416
```

Node.js SSE Server (`src/server/sse.ts`) 管理客户端连接、heartbeat、广播：
- `broadcast(event, data)` —— 向所有客户端广播
- **Last-Value Cache** —— 缓存 `chat:status` 最新值。新 SSE 客户端连接时自动 replay
- **日志降噪** —— 高频流式事件（chunk / delta）跳过 `console.log`

新增 SSE 事件 MUST 在 `SseConnection.ts::JSON_EVENTS` 注册白名单，否则前端静默丢弃。
会更新 Tab 会话快照的 SSE 事件（如 `chat:system-init`、权限/提问/plan-mode request 与 expired）还 MUST 带 `sessionId`，并在 `TabProvider` 通过 `sessionScopedEventGuards.ts` 按当前 SSE connection/session 过滤；否则历史切换或新会话 birth 时会把旧 sidecar 的弹窗/状态灌进当前 Tab。详见 `tech_docs/session_architecture.md`。

恢复 running/starting Session 时，REST `GET /sessions/:id` 是完整历史与 live snapshot 的唯一权威；需要与快照对齐的非幂等 live SSE 事件带 `{ sessionId, liveRevision, payload }`，REST 同时返回 `snapshotRevision`。Renderer 在 REST 期间 buffer，之后只顺序应用 revision 大于快照的连续事件；gap 或 SSE connection generation 变化就重新取快照。revision 只属于当前 Sidecar/session generation 的内存顺序，不持久化 checkpoint。详见 `tech_docs/session_architecture.md`。

普通 Session 的 complete/stopped/error 通知也不归 Tab：builtin/external terminal 产出同一份 turn identity/owner/origin descriptor，Rust SSE proxy 与 `BackgroundCompletion` 只是两个提交入口，`notification.rs` 以 `(sessionId, turnId)` 瞬时 claim 并统一决定 domain 抑制、focus、系统通知、badge 与 deep-link。Renderer 的 terminal handler 只维护消息/UI/unread，不再发送通用完成通知。

### HTTP API 调用

```
Tab1 apiPost() ──► getSessionPort(session_123) ──► Rust proxy ──► Sidecar:31415
Tab2 apiPost() ──► getSessionPort(session_456) ──► Rust proxy ──► Sidecar:31416
```

### Tauri IPC

用于不需要流式的 Rust ↔ 前端调用：
- 内嵌终端事件（`terminal:data:{id}`）
- 内嵌浏览器事件（`browser:url-changed:{tabId}`）
- 任务状态变更（`task:status-changed`）
- 工作区文件变更（`workspace:files-changed:{eventKey}`，`eventKey` 由 `watch_start` 返回）
- 工作区文件操作（`cmd_workspace_*`，所有 `src-tauri/src/workspace_files/` 命令）
- Sidecar 端口查询、Session 激活管理

不走 SSE Proxy。

### Management API（Node→Rust 反向通道）

`src-tauri/src/management_api.rs` 在 app 启动时监听 `127.0.0.1:${随机端口}`（axum），直接暴露 HTTP 路由给 Node 内部工具调用。端口通过 `MYAGENTS_MANAGEMENT_PORT` 注入到 Sidecar 进程。

| 前缀 | 职责 | 调用方 |
|------|------|--------|
| `/api/cron/*` | Scheduled Task 兼容 CRUD + 调度控制 | CLI、`im-cron-tool.ts` |
| `/api/task/*`（13 条） | Task Center 任务 CRUD + run/rerun + doc 读写 | CLI、`admin-api.ts` |
| `/api/mcp/remove-references` | Task 中删除 custom MCP identity 的持久引用 | `admin-api.ts` MCP remove cascade |
| `/api/app/config-changed` | 将 disk-first AppConfig 失效信号广播到所有 WebView（空 payload，不携带 secret） | `admin-api.ts` model mutation |
| `/api/thought/*`（2 条） | 想法 create / list | CLI、`admin-api.ts` |
| `/api/im/*` + `/api/im-bridge/*` | IM Bot 唤醒 + 媒体下发 + Plugin Bridge 回调 | Node.js / 社区插件 Bridge |
| `/api/plugin/*`（3 条） | OpenClaw 插件 CRUD | CLI |
| `/api/agent/runtime-status` | Agent 运行时状态查询 | Node.js / 前端 |

这是项目内**唯一**的"Node → Rust"反向 HTTP 通道，规避了"Renderer / Sidecar 控制面走 Rust proxy → Node"主流向对后端间通信的不适配。所有客户端 MUST 走 `crate::local_http::builder()`（loopback，仍复用 no_proxy 保护）。

---

## 模块地图

每个模块：一段简介 + 关键文件 + 跳转。

### 1. Sidecar Manager (`src-tauri/src/sidecar.rs` facade + `src-tauri/src/sidecar/*`)

Tauri State `ManagedSidecars` 管理 `HashMap<sessionId, SessionSidecar>`。Owner 释放规则保证生命周期收敛。

`src-tauri/src/sidecar.rs` 是兼容导出与少量共享常量的 facade。真实 owner 在 `src-tauri/src/sidecar/`：

| Owner module | 职责 |
|------|------|
| `manager.rs` / `types.rs` | `ManagedSidecarManager`、owner model、端口分配、runtime drift 判定 |
| `session_lifecycle.rs` | `ensure_session_sidecar` / release / upgrade / activation lifecycle |
| `instances.rs` | global/tab sidecar spawn、monitor、wake lock、terminal event forward |
| `spawn.rs` | Node/script 定位、`normalize_external_path`、spawn diagnostic、kill helper |
| `health.rs` | TCP health / readiness / reusable sidecar HTTP health check |
| `cleanup.rs` | startup stale-process cleanup barrier、global port file、child cleanup patterns |
| `cron_execute.rs` | Rust → Node Task `/cron/execute-sync` 与 Goal `/goal/execute-sync` bridge |
| `runtime_identity.rs` | session/agent runtime identity resolve 与 restore guard |
| `background.rs` | background completion lifecycle |
| `proxy.rs` / `commands.rs` / `legacy.rs` / `shutdown.rs` / `stdio.rs` | proxy propagation、IPC glue、legacy global sidecar、shutdown、stderr classification |

**IPC 命令：**

| 命令 | 用途 |
|------|------|
| `cmd_ensure_session_sidecar` | 确保 Session 有运行中的 Sidecar |
| `cmd_release_session_sidecar` | 释放 Owner 对 Sidecar 的使用 |
| `cmd_release_tab_session` | 在 scheduler/Sidecar owner 同一锁序下释放桌面 Tab owner 并归置 activation |
| `cmd_delete_session_if_unowned` | 用户删除的唯一 lifecycle authority：在同一 owner 锁边界内拒绝仍被 Sidecar 或持久 scheduler 拥有的 Session，并用每次 Global Sidecar 启动生成的 capability 调用从属 Node 存储端点；无 Rust authority 的 browser/dev HTTP 调用 fail-closed。检查 ownership/entry，不用 process liveness 代替 |
| `cmd_get_session_port` | 获取 Session 的 Sidecar 端口 |
| `cmd_activate_session` / `cmd_deactivate_session` | Session 激活管理 |
| `cmd_upgrade_session_id` | Session ID 升级（场景 4 handover）；old/new 任一 identity 被持久 owner 占用时拒绝 rename |
| `cmd_start_global_sidecar` | 启动 Global Sidecar |
| `cmd_stop_all_sidecars` | 应用退出清理 |

冷启动性能详见 `tech_docs/sidecar_cold_start.md`。

#### Sidecar process role 与 MCP OAuth credential owner

Rust 启动 Node Sidecar 时必须显式传 `--sidecar-role global|session`；`--no-pre-warm` 只控制启动行为，不能再被用来推断进程职责。两条 Session spawn path（Tab/global path 的非 global 分支与 `session_lifecycle.rs`）都传 `session`，应用级 Global Sidecar 传 `global`。Global 身份只由 canonical `GLOBAL_SIDECAR_ID` 定义：Global ID 必须没有 `agent_dir`，其它 ID 必须带 `agent_dir`；spawn 边界在产生任何副作用前拒绝两种错配，防止绕过 manager singleton 创建第二个 Global owner。

自定义 MCP 的 OAuth state 是应用级共享事实，持久化在 `~/.myagents/mcp_oauth_state.json`：

- Global Sidecar 是唯一 proactive refresh scheduler owner；使用现有 per-server refresh lock 与 state-store write lock，不能让每个 Session 各自启动 scheduler。
- credential 写入必须经 `setServerToken()` / `clearServerToken()`；refresh response 必须经同一 owner 的 `setServerTokenIfRevision()` 做锁内 CAS，防止网络请求期间发生的 revoke / reauthorize 被旧响应覆盖。token 与非敏感单调 `tokenRevision` 同一原子写入；写盘失败必须向上传播，不能报告 refresh 成功或继续使用未持久化的 rotating token。
- Session Sidecar 在 `initializeAgent()` 前 baseline 全 store，并用单个 unref observer 监听 `{tokenRevision, presence/status, expiresAt}`；config push 不拥有/推进这条 baseline。事件进入 `agent-session.ts` 后才按本 Session 启用的 MCP 过滤，并复用既有 deferred OAuth restart。
- Global scheduler 只有一个 deadline timer，并保留有界 store rescan，以发现其它 Session inline refresh/authorization 后写入的更早短 TTL credential；不为此新增 IPC、renderer 中转、第二 scheduler 或文件 watcher。
- Refresh outcome 必须区分 `refreshed_by_self`、`observed_after_lock` 与 `discarded_after_conflict`：分别表示本进程 POST 成功且提交、未发 POST 而复用其它进程结果、POST 成功但因并发 revoke/reauthorize 被 CAS 丢弃。日志必须同时记录非敏感 `http` / `commit` 维度，不得包含 access token、refresh token 或 Authorization header。

这套 owner 只适用于**自定义 MCP OAuth**。Anthropic/Grok subscription Provider 的 credential owner 规则仍分别由 `tech_docs/third_party_providers.md` 定义，不能混用。

当前边界不宣称 `authorizeServer()` 的 discovery / dynamic registration / manual config preparation 已成为完整事务：callback flow 的 exact identity 与 token durable commit 已闭环，但 pending authorization metadata 与 active credential context 的 mode/URL authority 仍缺少原子提交模型。并发 auto↔manual 或不同 URL preparation 属 PRD H6 HOLD；在定义 winner context 前禁止用零散 `clear manualConfig/registration` 补丁处理。

### 2. Multi-Tab 前端 (`src/renderer/context/`)

| 组件 | 职责 |
|------|------|
| `TabContext.tsx` | Context 定义，提供 Tab-scoped API |
| `TabProvider.tsx` | 状态容器，管理 messages / logs / SSE / Session |

Tab 内 MUST 用 `useTabState()` 的 `apiGet` / `apiPost`，禁止全局 `apiPostJson` / `apiGetJson`（会发到 Global Sidecar）。

#### App Shell 与 Tab authority

`GlobalSidebar` 挂在 `App` 的 Tab Workspace 之外，是应用级导航和资源投影，不是新的页面容器或 Session owner。顶部 Tab 仍是所有主内容页面的唯一 authority：active、关闭、恢复、拖拽、Sidecar owner token 与 pending-session birth 都继续由现有 Tab 状态机管理。

- 侧栏只从既有 `ConfigProvider`、任务中心 store、Session 索引与当前 Tab 派生工作区/Session 展示；active 高亮是 projection，不持久化第二份“当前页面”。该投影保持单一持久选中面：Launcher 选择工作区时高亮工作区行，Chat 已进入具体 Session 时只高亮 Session 行，父工作区仅保留层级上下文而不同时涂底或声明 `aria-current`。工作区配置和 Session mutation 分别调用现有 Config / Task Center authority，不在侧栏另存领域状态。
- 侧栏是独立的 App Shell material consumer：根面只读取完整 Theme 必需的 `--global-sidebar-bg`，该 Token 由每套 Theme 的 light/dark package 拥有，并依靠与右侧 `--paper` 的色差分区，不再叠加右侧竖分割线；侧栏内部主导航、Agent 工作区和底部入口同样只用既有组间 padding 分层，不绘制模块横分割线。页面根面与卡片/弹层继续使用既有 `--paper / --paper-elevated / --paper-inset` 语义；顶部 Tab 栏属于右侧 Workspace，根面使用纯 `--paper`，常规 leading inset 为 8px，手动 rail 的 52px 预留同时容纳固定 toggle 与其后 8px 留白。Tab active/hover 复用全局 `--hover-bg`，active 额外以 `--accent` 底线表达注意力。不能为制造左右差异而翻转通用 Paper 层级、在组件内混色或为 Tab Chrome 复制一套局部 palette。
- 侧栏展开/rail 切换的布局槽一次提交最终宽度，不能给 `width` / `flex-basis` 加逐帧 transition 让 Chat、Browser、Terminal 等 resize-sensitive surface 连续重排。可见边界由固定展开宽度的独立 paint-only 材质层通过 `clip-path` 横向揭示/收回；右侧 Tab 标题栏与内容用一次布局后的 compositor transform 保持旧视觉中心，再与边界同节奏归位。Chat 右侧工作区复用镜像模式：面板材质横移，对话区在最终 flex 布局上从旧中心归位；内容只做 opacity/translate/clip 编排，且必须提供 `prefers-reduced-motion` 立即切换路径。
- App Shell 使用 Task Center store 的 passive projection：只按需读取已展开工作区的 Session，每个规范化工作区 key 独立持有 loading/error/retry；只有用户打开全局搜索时才触发一次完整索引加载。passive 与完整 Task Center 读取共享 generation/latest-wins 交接，完整读取开始时使旧 passive 写入失效，完整 owner 卸载时显式把当前展开需求交还 passive。任务列表、轮询与 Tauri 监听仍由真正挂载的 Task Center 生命周期拥有，不能因侧栏常驻而前移到 App mount。
- 点击已有 Session 必须回到 `App` 的统一 open-target-session planner：优先聚焦已打开 Tab，否则按既有恢复/创建路径 materialize；并发点击复用同一 in-flight guard。新建既有 Session Tab 时用 `flushSync` 把 `sidecarConfigDisposition:'pending'` 的 Tab 加入并激活，立即挂载 Chat owner 子树并由其既有 `ChatBootOverlay` 承担加载反馈，再异步 ensure/activate；`setTabs` 必须保持 functional composition，不能把 `tabsRef` 提升为第二个可写 authority。ensure 的锁内 `isNew` 仍是 `push/adopt` 唯一裁决。失败时只撤销该临时 Tab 并恢复仍存在的前一 active Tab，成功后不得把加载期间主动切走的用户强制拉回。
- 点击工作区始终新建 Launcher Tab，再通过 Launcher 既有选择路径写入该 Tab 的待创建工作区；不得在侧栏提前创建 Session 或 Sidecar。
- Launcher 仅拥有“创建新工作”的输入和选项，不再拥有工作区卡片、历史列表或正式资源管理。全局侧栏是这些资源的唯一 UI owner，因此 Chat 不再提供把当前 Tab 原地改回 Launcher 的“返回”路径；用户通过关闭 Tab 或新建 Tab 结束/开启工作。
- “技能与工具”使用单实例 `capabilities` Tab，并与 Settings 分别在自己的 Tab slot 内持有页面状态；切到其它 Tab 不卸载草稿，两个功能 Tab 的导航和弹层也不互相串扰。两者复用 Settings 既有能力模块，但 app-global 配置传播（例如 proxy hot reload）归 `ConfigProvider` 唯一拥有，不能由任一页面 mount 次数决定。旧 Settings deep-link 只做意图重定向，不复制领域实现。
- Settings 的 `proxy` section 只是现有 `proxySettings` 配置面的独立路由 owner：供应商错误提示等入口统一 deep-link 到该 section，持久化仍走 disk-first `ConfigProvider`，运行中 Sidecar/Channel 的代理协调仍由既有配置传播链拥有。不得因从 General 拆页而复制代理状态、探测逻辑或建立 mount 驱动的 hot reload。
- 模型选择菜单是输入 chrome 的导航投影：当前项定位只修改菜单自有 scroll container；“自定义模型服务”复用 `OPEN_SETTINGS({section:'providers'})` 单实例设置动线。显示边界以 `projectInputChromeRuntime()` 的结果为准，因此 Managed Codex 投影为 builtin/AgentSDK 并显示入口，用户自管外部 CLI Runtime 不显示。
- 窄窗自动 rail 与用户手动展开偏好是两个正交状态。工作区 flyout 只是同一资源树的浮层呈现，不新增数据源、路由或选中 authority；关闭判定属于 flyout interaction owner，真实 pointer 离开、Escape 或导航成功可以关闭，但工作区树展开/折叠导致的 DOM 几何变化若指针仍在 flyout 边界内不得误判为离开。Session 导航后的关闭直接观察权威 active Tab identity 变化，同 Tab 成功则由当前 resource-surface interaction generation 关联的回调兜底；该 UI lifecycle generation 同时覆盖工作区 flyout 与搜索 overlay，不得另存单槽 pending Session 影子状态。激活前拒绝/异常保持资源面供重试；已经乐观激活后发生启动失败，由 App 回滚临时 Tab，但不自动复活已因导航关闭的旧资源面，也不得让工作区或 Session 的旧完成回调关闭用户后来重开的 flyout / 搜索 overlay。

Phase4 后，几个历史大型 UI 入口保留原路径作为兼容 facade，真实实现按 owner 目录维护：

| Facade | 当前 owner |
|------|------|
| `src/renderer/pages/Settings.tsx` | re-export `pages/settings/SettingsPage.tsx`；section/sidebar/navigation/provider form 拆到 `pages/settings/*` |
| `src/renderer/components/SimpleChatInput.tsx` | re-export `components/chat-input/SimpleChatInput.tsx`；附件处理、mention/thought row、常量/types 拆到 `components/chat-input/*` |
| `src/renderer/components/DirectoryPanel.tsx` | re-export `components/directory-panel/DirectoryPanel.tsx`；搜索 hook、path display、types 拆到 `components/directory-panel/*`，树 viewport 仍在 `components/workspace-tree/*` |

macOS 的 renderer 崩溃恢复由 Tauri `on_web_content_process_terminate` 回调拥有：只有 WebKit 明确报告 content process 已终止时才 reload 对应 WebView，并从持久 Session/REST/SSE 权威恢复页面。普通系统 wake/resume、窗口重新显示或应用激活不得 reload 健康 WebView，以免丢失未提交草稿和 renderer-local UI 状态；Sidecar/Session 生命周期独立于 WebView，content process 终止时继续存活并保持后端权威。

#### Desktop Pet Travel authority

桌宠旅行模式的 phase、wall-clock deadline、持久化和原生窗口显隐由
`src-tauri/src/travel_mate.rs` 单一拥有；`BallWindow` 只投影当前
pending/blocked/error attention guard 和宠物身份，`CompanionWindow` 只消费
`travel-mate://state-changed` 并展示归来明信片。旅行 store 必须经
`utils::file_lock` 且在 hide/show 前 durable commit；不得把 timer、第二份
phase 或用户内容放进 renderer。完整状态机、隐私白名单和恢复规则见
[`features/travel-mate.md`](./features/travel-mate.md)。

### 3. 系统提示词组装 (`src/server/system-prompt.ts`)

三层 Prompt 架构：

| 层 | 用途 | 何时包含 |
|----|------|---------|
| **L1** 基础身份 | 告诉 AI 运行在 MyAgents 产品中 | 始终 |
| **L2** 交互方式 | 桌面客户端 / IM Bot / Agent Channel | 互斥选一 |
| **L3** 场景指令 | Cron 定时任务上下文 / IM 心跳 / 浮球小窗 / Browser Storage | 按需叠加 |

```typescript
type InteractionScenario =
  | { type: 'desktop'; surface?: 'chat' | 'floating-ball' }
  | { type: 'im'; platform: 'telegram' | 'feishu'; sourceType: 'private' | 'group'; botName?: string }
  | { type: 'agent-channel'; platform: string; sourceType: 'private' | 'group'; botName?: string; agentName?: string }
  | { type: 'cron'; taskId: string; intervalMinutes: number; aiCanExit: boolean };
```

`desktop.surface` 区分同一桌面渠道下的入口形态：默认 Chat 不额外指定；浮球入口使用 `surface: 'floating-ball'`，系统提示词追加小窗交互约束，同时每条浮球消息自带 `system-reminder` 上下文，覆盖已预热 session 不能重组 systemPrompt 的情况。

### 4. 自配置 CLI (`src/cli/` + `src-tauri/src/cli.rs`)

内置命令行 `myagents`，让 AI 和用户都能通过 Bash 管理应用配置（MCP / Provider / Agent / Cron / Goal / Plugin），能力与 GUI 对等。

**两个使用场景：**

| 场景 | 调用方式 | 端口来源 |
|------|---------|---------|
| AI 内部调用（主要） | SDK Bash 工具 → `myagents mcp add ...` | `MYAGENTS_PORT` 环境变量 |
| 用户终端调用 | `MyAgents mcp list` | `~/.myagents/sidecar.port` 文件 |

为什么 CLI 放在 `~/.myagents/bin/` 而非 app bundle：SDK 子进程 PATH 不含 app bundle 内部路径；shebang 执行需要可执行权限和去掉 `.ts` 后缀；`~/.myagents/bin/` 是跨平台稳定的工具投放点。

详见 `tech_docs/cli_architecture.md`。

### 5. 定时任务系统

0.3.0 起，Task 是所有新定时自动化的唯一持久权威：

- `task.rs`：`tasks.jsonl`、状态机、schedule/runtime/notification schema 与原子 mutation。
- `task_scheduler.rs`：唯一 timer handle map + 瞬时 execution authority map（普通 queueId/cancel/session）；从 Running Task 重建，支持 wall-clock sleep、scheduled tick 与 manual `run-now`。
- `task_execution.rs`：Session 选择、`SidecarOwner::Task`、Task prompt 与同步执行 use case。
- `cron_task/*`：兼容 DTO、校验、delivery/run history 与旧文件只读 facade；没有 writer/scheduler/execution owner。
- `legacy_upgrade.rs`：在 Task scheduler 启动前把普通 At/Every/Cron、旧 Task projection 与 managed row 幂等迁移为 Task；Loop/开发期 Goal row 不迁移。

`Running` 表示 scheduler enabled，`currentlyExecuting` 来自瞬时 execution map。timer handle 与执行 Turn 分离；Stop 撤销精确 queue authority，SessionEngine stop 确认后才释放 Task owner；执行授权、TaskStore outcome、history、UI event、delivery 与 terminal side effect 共用同一 Task-control 临界区，旧 queue 不能越过新一轮 birth。`run-now` 可执行 Stopped Task但不启用 scheduler；`lastScheduledAt` 独立于 `lastExecutedAt`，手动执行不会移动 recurring timer。

**Node.js 层**：
- AI 统一通过 `myagents cron ...` CLI 使用定时任务能力；历史 `im-cron` MCP 已退役
- `src/server/tools/im-cron-tool.ts` 只保留 IM / Session cron context registry，不再创建 MCP server
- 用户可见命令名保持 Cron 兼容，但 CRUD/start/stop/run-now 全部落 TaskStore
- `/cron/execute-sync` 只是历史 wire name，domain owner 是 Task，并统一经过 SessionEngine selector

标准 Cron get/list/mutation facade 也只读 TaskStore；未迁移旧行仅由显式只读 Legacy 诊断命令提供给历史面板。deleted Task 是 legacy id tombstone，不会让旧行复活。

Legacy `CronTask` 字段若为读盘兼容新增仍 MUST 带 `#[serde(default)]`，但禁止新增写盘路径。完整边界见 `tech_docs/task_center.md` 与 `tech_docs/task_provider_routing.md`。

### 6. Agent 架构 (`src-tauri/src/im/`)

```
Project (工作区)
  = Basic Agent（被动型，用户在客户端主动交互）
  + 可选的「主动 Agent」模式 → AgentConfig（24h 感知与行动）
    └── Channels: Telegram / Dingtalk / OpenClaw Plugin（飞书/微信/QQ 等）
```

**模板默认能力**：工作区文件模板内容与产品级 Agent 默认策略分离。Mino 文件模板来自打包资源/外部模板仓库；MyAgents 在 `WorkspaceTemplate.agentDefaults` 声明产品默认能力。新建 Mino project 会记录 `templateId=mino` / `templateSource=builtin`，随后 `buildAgentForProject()` 生成默认开启的 Agent（heartbeat + memory update），但不自动创建 channel；Rust 仍只在 `agent.enabled && channel.enabled && credentials` 成立时启动 channel/Agent heartbeat。

Memory auto-update 的默认指令文件不属于 Mino 文件模板的硬依赖：`src-tauri/src/im/memory_update.rs` 在执行自动更新流程时会确保工作区根目录 `UPDATE_MEMORY.md` 存在，缺失则从 `src/shared/default-update-memory.md` 初始化；已有文件始终是用户内容权威。

**适配器：**

| 适配器 | 协议 | 说明 |
|--------|------|------|
| `TelegramAdapter` | Bot API 长轮询 | 内置，消息收发 / 白名单 / 碎片合并 |
| `DingtalkAdapter` | Stream 长连接 | 内置，消息收发 |
| `BridgeAdapter` | HTTP 双向转发 | OpenClaw 社区插件，Rust → 独立 Node.js Bridge 进程 |

详见 `tech_docs/im_integration_architecture.md`。

`src-tauri/src/im/mod.rs` 是 facade 与少量共享 helper。当前主要 owner：

| Owner module | 职责 |
|------|------|
| `agent_channel.rs` | channel lifecycle、消息入口、Sidecar ensure/enqueue 编排 |
| `enqueue.rs` | Rust → Node `/api/im/enqueue` 同步 ACK 请求 |
| `event_consumer.rs` / `reply_router.rs` | `/api/im/events` long-poll SSE consumer 与 requestId → draft/reply slot 路由 |
| `state.rs` | `ManagedAgents` / `ManagedImBots` / runtime config sync / channel state |
| `config_store.rs` | Agent/Bot config 读写、auto-start、missing config reporting |
| `commands.rs` | Tauri IM/Agent command glue |
| `adapter.rs` + `telegram.rs` / `dingtalk.rs` / `feishu.rs` / `bridge.rs` | 平台适配器 |
| `buffer.rs` / `group_history.rs` / `handover.rs` / `heartbeat.rs` / `memory_update.rs` / `runtime_change.rs` | 消息缓冲、群历史、session handover、heartbeat、记忆更新、runtime 切换 |

### 7. Plugin Bridge (`src/server/plugin-bridge/`)

独立 Node.js 进程加载 OpenClaw Channel Plugin。MUST 与 Sidecar 保持同等待遇（环境变量注入、日志宏、config 查询范围）。

**关键约束：**
- **入口解析协议**：按 OpenClaw 官方 `package.json["openclaw"].extensions[]` 读取，**不再**信任 `main` / `exports`
- **CJS+ESM 混用插件兼容**：通过 `module.registerHooks()` 同步 loader hook 拦截 `openclaw-plugins/*/node_modules/**` 下所有 `.js` 文件
- **始终注入 `--import tsx/esm`**（dev 和 prod 都要）
- **SDK Shim 全量覆盖**：手写 + 自动生成 stub。手写模块受 `_handwritten.json` 清单保护
- **Shim 修改 MUST bump 版本**：三处同步（`sdk-shim/package.json` / `compat-runtime.ts` / `bridge.rs::SHIM_COMPAT_VERSION`）

详见 `tech_docs/plugin_bridge_architecture.md`。

### 8. 三方供应商支持 (OpenAI Bridge)

`src/server/openai-bridge/`：当供应商使用 OpenAI 协议（DeepSeek / Gemini / Moonshot），SDK 的 Anthropic 请求 loopback 到 Sidecar 的 Bridge handler，翻译为 OpenAI 格式后转发：

```
SDK subprocess → ANTHROPIC_BASE_URL=127.0.0.1:${sidecarPort}
  → /v1/messages → Bridge handler → translateRequest → upstream OpenAI API
  → translateResponse → Anthropic 格式 → SDK
```

**模型别名映射：** 子 Agent 指定 `model: "sonnet"` / `"fable"` 时，SDK 通过 `ANTHROPIC_DEFAULT_SONNET_MODEL` / `ANTHROPIC_DEFAULT_FABLE_MODEL` 解析为供应商模型。四个别名变量：`ANTHROPIC_DEFAULT_{FABLE,SONNET,OPUS,HAIKU}_MODEL`。

**Context-window ingress：** 所有进入 Claude Agent SDK 的 model id 都要经过 `model-capabilities.ts` 的 suffix helper；调用点已知 provider 时必须用 `applyProviderContextWindowSuffix(model, providerId)`，只有 provider 不可知时才直接用 flat `applyContextWindowSuffix(model)`。Provider helper 对裸 model id 优先读取 active provider 的 registry row，该 provider 没有对应 row 时才 fallback flat registry；调用方显式传入的 `[1m]` 保持不变。bridge、cron、持久化与用户可见 surface 始终保留裸 model id。

**Provider Self-Resolve：** IM 与尚未 materialize 的 backend-created Task Session 可从磁盘初始化 Provider/Model，不依赖前端 `/api/provider/set`；已有 Task Session 保留自己的配置 authority。owned builtin session 的 canonical 身份是 `providerRoute`（providerId + model），请求时再从当前配置 materialize `ProviderEnv`；旧数据解析链兼容 `providerRoute → legacy providerId/model → providerEnvJson fallback → agent/default`，不得把 apiKey/baseUrl 作为新 snapshot 身份写回。

**受管订阅凭据：** `xai-sub` 仍属于 builtin + OpenAI Responses Bridge，不是外部 Runtime。其 `ProviderEnv` 只携带非 secret 的 `credentialSource:{kind:'managed-oauth',providerId:'xai-sub'}`；Rust 应用级 `GrokAuthManager` 是 rotating refresh token 的唯一 owner。Bridge 每个上游请求都通过带 Sidecar generation/session 校验的 localhost Management API 解析当前 bearer，且 Rust 区分 `execution`（必须已验证）与 lineage-bound `verification` 用途；401 最多强制 refresh 并重试原请求一次，403/429 不清登录态。renderer、AppConfig、session 与静态 ProviderEnv 都不得持有 bearer，受管 bearer 的目的地址必须由 server canonicalize 到官方 xAI Responses endpoint。

详见 `tech_docs/third_party_providers.md`。

### 9. Multi-Agent Runtime

除内置 Claude Agent SDK（builtin）外，支持 Claude Code CLI、OpenAI Codex CLI、Google Gemini CLI 作为外部 Runtime。功能门控：`config.multiAgentRuntime`（默认关闭，设置 → 关于 → 实验室）。

**抽象层**：

`src/server/session-engine/` 是 Sidecar HTTP route 面向“当前会话运行时”的门面层：

| 文件 | 职责 |
|------|------|
| `selector.ts` | `shouldUseExternalRuntime()` 的 route 分流 owner；选择 builtin/external `SessionEngine` |
| `builtin-adapter.ts` | 委托 `agent-session.ts`，保持内置 Claude Agent SDK 会话语义 |
| `external-adapter.ts` | 委托 `external-session.ts`，保持 Claude Code / Codex / Gemini 会话语义 |
| `types.ts` | `SessionEngine` 接口：desktop send、IM enqueue、injected turn、queue、runtime config、session read/config/operation 等 route-facing 能力 |
| `route-contracts.ts` | high-risk route → engine method 的可测试契约清单；route modules 只做 payload/response shaping |

`src/server/session-core/` 是 builtin / external 会话内核共享的 pure policy 层。它不拥有 SDK/CLI 进程、副作用或 SSE，只承载可单测的决策：turn result 判定、meaningful session activity/Heartbeat ack、显式 user/assistant channel-delivery owner、runtime config snapshot/source guard、desktop/turn-boundary queue admission、MCP authority/fingerprint/restart 决策，以及 MyAgents-owned MCP 的统一 soft pre-warm budget / status 分类。

`src/server/agent-session.ts` 仍是 builtin SDK 的 public facade，供 `session-engine/builtin-adapter.ts` 委托。Phase6 后，主要 mutable state 不再由 facade 顶层变量直接拥有；Phase7 后，最重的 turn terminal 与 transcript persistence 行为也有独立 owner。真实维护入口在 `src/server/builtin-session/`：

| Owner module | 职责 |
|------|------|
| `lifecycle.ts` | SDK `Query` 进程、abort flag、termination + pre-dispatch rollback barrier、generator wakeup、pre-warm control readiness、Query-scoped MCP pre-warm/mutation owner、exact Query background-task registry |
| `queue.ts` | realtime queue、mid-turn buffer、turn-boundary queue、in-flight slot、admission ticket |
| `turn.ts` | current turn usage/output/error state、SDK output-owner FIFO（每次 user-message yield 一槽，同时保存 requestId、assistant channel owner 与成功前暂存的完整文本 block）、injected turn outcome |
| `turn-lifecycle.ts` | SDK `result` / stopped / error terminal 解释、成功终态 channel-delivery commit、usage stamping、queue/IM/inbox/watch/analytics/title hook 顺序 |
| `config.ts` | MCP/agents/plugins/model/permission/provider state、deferred restart latch |
| `transcript.ts` | live messages、message sequence、persist cursor/cache、SDK UUID freshness sets |
| `transcript-persistence.ts` | SessionStore mapping、incremental persist chain、load seeding、cursor/cache reset、rewind/fork/retraction persistence consistency |
| `types.ts` | builtin owner 间共享的结构类型 |

约束：route modules 与 `session-engine/*` 不直接 import `builtin-session/*`；它们只看 `agent-session.ts` facade。`builtin-session/*` 也不 import route 或 SessionEngine。`session-core/*` 继续保持 pure policy，不引入 SDK/SSE/文件系统副作用。`runtime-boundary.unit.test.ts` 会目录级扫描这些边界，并拦截 `agent-session.ts` 对 owner state 的 direct write 回退，以及 turn terminal / transcript persistence 行为回流到 facade；新增写入或 terminal/persist 规则应先在对应 owner 中加命名 API。

**Builtin MCP soft pre-warm：** `Query.initializationResult()` 与 streamed `system_init` 都不代表 MCP 已连接。初始 Query 或成功安装新 MCP map 时，`lifecycle.ts` 以 Query identity + generation + 单调 installed-map revision + runtime fingerprint 建立一次性 owner，并在 owner 上记录 `startedAt + deadlineAt`；默认预算只由 `session-core/mcp-prewarm-policy.ts::MCP_PREWARM_GRACE_MS` 定义（当前 10 秒）。Desktop、IM 与 Cron / Goal / Heartbeat / Memory Update 等 injected turn 全部在 `messageGenerator()` promotion 后、live mutation fence 之后消费该 owner 的**剩余**预算。只有 `pending` 会继续等待；`failed`、`needs-auth`、`disabled`、missing、status read error 或 deadline 到期都把当前 generation 标为 degraded 并继续 AI turn。ready / degraded 都是 terminal one-shot，后续 turn 不再读 status、不开新 timer。用户取消仍立即取消 promotion；Query/map owner replacement 则 requeue 给 replacement generator，不能让旧 control response放行旧 Query。

`runInjectedTurn()` 不再拥有 MCP precheck、第二道 fence 或 408/503 MCP 映射，只保留 Goal/Task 等 domain `beforeDispatch` 与真实 turn timeout。Live MCP 更新仍由同一个 Query-generation mutation owner 串行化：mutation claim 与 promotion 通过同一事件循环内的同步 owner 顺序互斥；先 promotion 就推迟重建，先 claim 就由 promotion 等待同一 promise。真实 `setMcpServers()` 失败/30 秒 mutation timeout 仍表示 transport map 不确定，必须 requeue + replacement Query；这是配置切换正确性 fence，不属于 soft startup readiness。`mcpServerStatus()` 控制请求在一次 pre-warm observation 内单飞；status timeout 只结算当前 generation degraded，不再触发按 turn 重启循环。

SDK `task_started` 创建的后台 Agent/Bash 仍属于产生它的同一个 Query；foreground result 不代表整个 Query 已空闲。`lifecycle.ts` 按 Query object identity 保存 active task，现有 `applyDeferredRestartIfNeeded()` 与 pre-warm timer 在 registry 非空时保留 deferred reasons、不得 close Query；最后一个既有 terminal 事件再次触发 drain。显式 Stop/Reset/Switch 与真实 teardown 仍可立即终止，finalizer 从 exact registry `take` 残留项并合成 `stopped`。该契约不引入独立 Sidecar、等待 scheduler 或后台任务的第二份产品状态。

`src/server/runtimes/` 只表示外部 runtime adapter：

| 文件 | 职责 |
|------|------|
| `types.ts` | `AgentRuntime` 接口 + `UnifiedEvent` 联合类型 |
| `factory.ts` | Runtime 工厂，`getCurrentRuntimeType()` 读 `MYAGENTS_RUNTIME` 环境变量 |
| `claude-code.ts` | CC Runtime：NDJSON over stdio，`-p` 模式 |
| `codex.ts` | Codex Runtime：JSON-RPC 2.0 over stdio，`app-server` 持久进程 |
| `gemini.ts` | Gemini Runtime：ACP JSON-RPC 2.0 over stdio，`gemini --acp` |
| `external-session.ts` | 外部 runtime public facade：start/send/prewarm/stop、UnifiedEvent shell、SessionEngine-facing exports |
| `external-session/*` | 外部 runtime owner modules：lifecycle、runtime config、operation queue、turn lifecycle、content blocks、transcript persistence、interactive requests |

`external-session.ts` 不再是 external runtime 的 state owner。真实 mutable state 归 `src/server/runtimes/external-session/`：

| Owner module | 职责 |
|------|------|
| `lifecycle.ts` | active runtime/process、starting guard、session binding、prewarm/system-init、user-stop flag |
| `runtime-config.ts` | desired/live model、permission、reasoning effort state；snapshot/source guard integration |
| `operation-queue.ts` | turn-boundary message/config FIFO（Desktop + busy IM）、drain reservation、generation-based stale dispatch rejection、direct-send tail admission/reset、force/cancel/status bookkeeping |
| `turn-lifecycle.ts` | turn completed/success、finalization gate、turn start time、usage/context usage state；`turn_complete` / `session_complete` terminal plan 分类；显式 channel-delivery admission、成功终态 commit 与 user-before-assistant delivery tail |
| `content-blocks.ts` | streaming text/thinking/tool/subagent content state、tool result/attachment mutation、live/turn snapshot backing state |
| `transcript-persistence.ts` | in-memory session messages、persisted runtime usage totals、user/assistant append、retry truncate、last assistant read、SessionStore save + metadata preview/context update |
| `interactive.ts` | permission/AskUserQuestion pending state、active IM request id、IM registry cleanup、inbox/watch reply metadata与错误推送；permission response 成功 delivery 后才 consume pending state |

**门控链路：** Rust `sidecar/runtime_identity.rs` 读取 `config.multiAgentRuntime` + `agent.runtime`，`sidecar/session_lifecycle.rs` / `sidecar/instances.rs` 在 spawn Sidecar 时注入 `MYAGENTS_RUNTIME` 环境变量 → Node.js `factory.ts` 读取 → `session-engine/selector.ts` 通过 `shouldUseExternalRuntime()` 选择 builtin/external `SessionEngine`。前端 `Chat.tsx` 用同样门控决定 `currentRuntime`。

新增“config 同步 / 注入 user 消息 / 等待 turn 完成 / session read / session operation”的 Sidecar endpoint 时，MUST 走 `SessionEngine` facade；不要在 route handler 里直接手写 builtin/external 分流。Phase5 已迁移的代表路径包括 `/api/session-state`、`/api/session-latest-result`、`/chat/stream`、`GET /sessions/:id`、`/chat/rewind`、`/chat/external-retry`、`/sessions/fork`、`/sessions/switch`、`/api/im/session/new`、`/api/mcp/set`、`/api/agents/set`、`/api/provider/set`、`/api/session/config`。仅 external-only legacy/diagnostic endpoint 可直接调用 `external-session.ts`，并需在代码注释说明兼容原因。

**测试防线：** server 测试必须显式后缀分层：`*.unit.test.ts`（pure policy / parser / boundary）、`*.integration.test.ts`（credential-free stateful server 集成，singleFork）、`*.credentialed.test.ts`（真实 Provider / SDK / upstream smoke，显式本地跑）。`unit` / `integration` 都加载 `src/test/setup-no-egress.ts`，阻断 fetch / undici / http(s) / net / tls / dns 非 loopback 出站；`npm run test:classification` 用实际 Vitest project list 扫描并禁止裸 `src/server/**/*.test.ts`。External runtime 的回归主路径通过 `external-session-mock.integration.test.ts` 在测试层 mock `runtimes/factory.ts`，fake runtime 伪装为真实 `RuntimeType`（如 `codex`），穿过 `SessionEngine` 覆盖正常 turn、failed turn、queue、permission response，不在生产代码里增加 mock runtime 类型。

详见 `tech_docs/multi_agent_runtime.md`。

### 10. Session 切换与持久化

| 场景 | 描述 | 行为 |
|------|------|------|
| 1 | 新 Tab + 新 Session | 创建新 Sidecar |
| 2 | 新 Tab + 其他 Tab 正在用的 Session | 跳转到已有 Tab |
| 3 | 同 Tab 切换到后台 Task/Goal Session | 跳转 / 连接到现有 Session Sidecar |
| 4 | 同 Tab 切换到无人使用的 Session | **Handover**：Sidecar 资源复用 |

**编排收敛**（PRD 0.2.6）：所有切换入口（`handleSwitchSession` / `handleLaunchProject` / `OPEN_SESSION_IN_NEW_TAB`）MUST 通过纯函数 `src/renderer/utils/sessionOpenPlan.ts::planSessionOpen()` 拿到统一 plan 类型（`jump-to-tab` / `open-new-tab` / `attach-existing-sidecar` / `switch-current-tab`）再执行。已有后台 owner 的 attach 必须排在 runtime-mismatch 检查前，否则 Session 会被错误 fork 并丢失后台 activation。部分字段名仍保留 `cron` 作为 wire compatibility。

**Cross-runtime 检测**：比较**目标 session.runtime vs 当前 Tab 已加载 session.runtime**（agent template 仅在没有当前 session 时 fallback）。Agent.runtime 可从 Tab 已冻结的 session.runtime 漂移，旧实现以 agent 为基准会让漂移触发不必要的 fork。

**Loading 安全**：`TabProvider.loadSession()` MUST `await /sessions/switch` 成功后再替换 history；失败时保留可见 messages、回滚 `currentSessionIdRef`，让 UI 与后端始终一致。

**Live config 采纳**：Tab 加入活跃 IM/Task/Goal Sidecar 时，`/api/session/config` 返回 sidecar 的 runtime + external-runtime model + permissionMode，Tab 采纳 live config 而非 push 自己的；Chat 用 sticky `adoptedSessionRef` 防止 sessionMeta hydration 覆盖已采纳的值。

**分层 Config Snapshot：** Session 创建时按 Owner 类型选择 config 快照策略：

| Owner 类型 | Snapshot helper | 策略 |
|-----------|----------------|------|
| Tab / Cron / Background | `snapshotForOwnedSession(agent, { runtimeOverride?, runtimeSourceOverride? })` | 冻结 model / permission / MCP / provider / runtime identity；runtime 切换出生路径用 override 生成目标 runtime view |
| IM / Agent Channel | `snapshotForImSession(agent, { runtimeOverride?, runtimeSourceOverride? })` | 仅保存完整 runtime identity（`runtime` + `runtimeSource`）；其它每次消息 live resolve |

读侧通过 `resolveSessionConfig(sessionMeta, ownerKind)` 统一消费。详见 `tech_docs/pit_of_success.md` 的「Snapshot Helpers」节。

Runtime identity 必须按 `runtime` + `runtimeSource` 比较：`codex/system-cli`（用户外部 Codex CLI）与 `codex/managed-provider`（内置 Codex 订阅 Provider）不是同一种会话身份。IM / Agent Channel 的 session drift、Sidecar 唤醒、`/model` 命令和 heartbeat 都必须携带 source；只覆盖 `runtime:'codex'` 而不覆盖 `runtimeSource` 会被解释为 system CLI。

跨 Runtime Session 保护见模块 9 的「跨 Runtime Session 保护」节，详见 `tech_docs/multi_agent_runtime.md`。

### 11. 内嵌终端 (`src-tauri/src/terminal.rs` + `src/renderer/components/TerminalPanel.tsx`)

Chat 分屏右侧面板的交互式 PTY 终端，工作目录为当前工作区。

```
用户按键 → xterm.onData → invoke('cmd_terminal_write') → PTY master write
PTY master read → emit('terminal:data:{id}') → xterm.write → 屏幕渲染
```

**关键设计：**
- Rust `TerminalManager` 管理 `HashMap<String, TerminalSession>`，每个 session 持有 PTY pair（`portable-pty`）
- 不走 SSE Proxy，用 Tauri event
- 终端绑定 Tab 生命周期，面板关闭不杀进程
- 环境注入：内置 Node.js + `~/.myagents/bin` + `MYAGENTS_PORT` + `TERM=xterm-256color`
- Shell 以 login shell（`-l`）启动
- 视觉：从全局 `ResolvedTheme.adapters.xterm` 读取 palette / 字体 / 字号；scheme 变化只原位更新 xterm options，字体度量变化后复用现有 fit-and-resize owner 重算 cols/rows 并同步同一 PTY，不重建 PTY 或 buffer

PTY 进程由 `portable-pty` 管理，**不走** `process_cmd`。

### 12. 内嵌浏览器 (`src-tauri/src/browser.rs` + `src/renderer/components/BrowserPanel.tsx`)

Chat 分屏右侧面板的 URL 预览器（Tauri Multi-Webview）。AI Markdown 链接和 HTML 文件优先在此打开。

**关键设计：**
- 依赖 Tauri `"unstable"` feature（`Window::add_child()` 多 Webview API）
- **安全隔离**：`browser.json` Capability 零权限，Webview 无法访问 Tauri IPC；`on_navigation` 限制 http/https scheme
- **Overlay 协调**：原生 Webview 浮于 React DOM 之上，Overlay 出现时通过 `closeLayer.hasOverlayLayer()` 自动 hide
- **Cookie 持久化**：同 App 所有 Webview 共享，默认持久化磁盘
- **关闭即销毁**，不后台保活

### 13. 层级关闭系统 (`src/renderer/utils/closeLayer.ts`)

Cmd+W 层级关闭：Overlay → 分屏面板 → Tab，高 z-index 优先。

- 注册表：模块级 `layers[]` 数组，每个 Overlay/面板 mount 时 `registerCloseLayer(handler, zIndex)`，unmount 自动 deregister
- 优先级：以组件 CSS z-index 为排序依据（z-300 ConfirmDialog > z-200 WorkspaceConfigPanel > z-0 分屏面板）
- 同级 LIFO：相同 z-index 按注册顺序后进先出（最新 mount 的先关闭）
- Hook：`useCloseLayer(handler, zIndex)` —— 一行集成
- 浏览器联动：`hasOverlayLayer()` 当有 z-index > 0 注册层时自动隐藏原生 Webview

新增 overlay/可关闭面板 MUST 调用 `useCloseLayer`，否则 Cmd+W 会跳过该面板直接关 Tab。

### 14. 全文搜索引擎 (`src-tauri/src/search/`)

基于 Tantivy + tantivy-jieba 的 Rust 子系统。`SearchEngine` Tauri managed state 单例，为两类查询提供全文检索：Session 历史（跨工作区）与工作区文件内容。

**仅 Tauri 可用** —— 前端通过 `invoke('cmd_search_*')` 直接调 Rust，不经 Sidecar。浏览器开发模式不提供 fallback。

**关键设计：**
- Session 索引：单一全局索引 `~/.myagents/search_index/sessions/`
- Session watcher：`notify-debouncer-full` 5s 滑动去抖观察 `~/.myagents/sessions/`，**任何**写入者的变更都自动流入索引
- 读写并发：`Arc<SessionIndex>`（无外层 mutex）；正常读写共享 state 读锁，仅损坏恢复独占替换
- 中文分词：`tantivy-jieba`（~37 万词词典），字段 MUST 显式 `"chinese"` tokenizer
- Schema 版本门控：`SCHEMA_VERSION` + `.schema_version` 磁盘 marker，不一致时自动删除重建
- 工作区文件搜索结果导航：Rust 只返回 `FileSearchHit`；预览、命中行定位、右键菜单、回到文件树是 renderer-side 协议，复用 `DirectoryPanel` / `WorkspaceTreeViewport` / `useWorkspaceFileService`，不新增 Sidecar HTTP 或 Rust IPC

详见 `tech_docs/search_architecture.md`。

### 15. Skill URL 安装 (`src/server/skills/`)

支持从 GitHub 链接、`npx skills add` 命令或直连 zip 一键把社区 skill 装到 `~/.myagents/skills/`（或当前工作区 `.claude/skills/`）。

**三段流水线：**
```
url-resolver.ts      — 宽容解析 → ResolvedSkillSource
    ▼
tarball-fetcher.ts   — codeload.github.com 下载 zip → 内存解包 + 安全限额
    ▼
installer.ts         — 扫描 SKILL.md / marketplace.json → InstallAnalysis
```

**安全限额：** tarball ≤ 50MB、单文件 ≤ 5MB、文件总数 ≤ 2000、超时 60s、Zip-Slip 防御。直连压缩包必须使用 HTTPS；下载前后每个 redirect hop 都拒绝 loopback/RFC1918/link-local/IPv6 ULA，并把 fetch 钉死到已校验 DNS 结果，防 SSRF / DNS rebinding。

**MVP 明确不支持：** GitLab、私有仓库、git SSH URL、搜索集成、市场订阅持久化、`skill update`、跨 IDE symlink 同步、npm spec 形态。

详见 `guides/skill_marketplace.md`。

### 16. 任务中心 (`src-tauri/src/task.rs` + `src-tauri/src/thought.rs` + `src/renderer/components/task-center/`)

把"想法速记 → 对齐 → 派发 → 执行 → 验收 → 审计"的完整工作流一等公民化。

**两个持久化 Store：**
- `ThoughtStore` —— `~/.myagents/thoughts/<YYYY-MM>/<id>.md`
- `TaskStore` —— `~/.myagents/tasks.jsonl` + `~/.myagents/tasks/<id>/{task.md, verify.md, progress.md, alignment/}`

**关键设计：**
- Task 状态机 + 审计链（每次状态变更原子写入 `statusHistory`）
- TaskStore 是 schedule/status/config 唯一权威；TaskScheduler 直接触发并在每次 tick 动态读取 `task.md`
- Task/Session identity protection 由 per-Session lifecycle guard 串行化：任何 durable mutation（含 legacy migration）只要让 Task 进入受保护状态或新增受保护 Session binding，都与 Session 删除遵循 `lifecycle → TaskStore` 锁序；scheduler active execution 覆盖 Session id 已 claim、Sidecar `Task` owner 尚未附着的窗口，birth guard 只保留到权威 Session metadata 出现（不持满整轮），shared-session joiner 不得提前 adopt。metadata creator 由该 reservation 决定，不绑定 Sidecar `isNew`；被删除的 fixed Session 换新 UUID，不复活旧 identity
- 同一 Task 的 status、timer、execution claim 与 stop side effect 由 keyed Task-control lifecycle 串行化；stop 使用现有 `queueId` 精确停止当前 Turn。持久 `Running/Stopped` 只表达 scheduler intent，具体 Turn 以非持久 `running/stopping/stop_failed` 投影；stop 未确认时禁止 rerun。Attached Space Task 的终态不能 generic rerun，必须由新的 claim/reopen 创建新 Attached Task
- AI 讨论路径：想法卡 →「AI 讨论」打开新 Tab + 注入 `task-alignment` Skill → 完成后 `myagents task create-from-alignment`
- 状态变更广播 Tauri event `task:status-changed`（非 SSE），所有打开的任务中心 Tab 实时同步

详见 `tech_docs/task_center.md`。

---

### 17. 工作区文件 IO (`src-tauri/src/workspace_files/`)

把 "OS 文件操作" 从 "AI runtime 容器（Sidecar）" 里剥出来，走 Tauri invoke 而非 Sidecar HTTP。

**核心动机：**
- 启动页（Launcher）没有 Sidecar，但仍要能 @ 文件、列 / 命令、附图、新建/重命名 — 不能依赖 AI runtime 起来。
- 未来云端协作把 "客户端" 与 "AI runtime" 分进程 / 分主机时，文件操作天然留在客户端侧。

**模块结构（`src-tauri/src/workspace_files/`）：**

| 子模块 | 职责 | 暴露的 cmd |
|------|------|-----------|
| `path_safety` | 唯一路径解析/安全打开 chokepoint：lexical/canonical resolve、`read_workspace_file_no_follow`、`open_regular_file_no_follow`、文件名校验与 sanitize | — |
| `tree` | 工作区目录树初始化 + 懒展开 | `cmd_workspace_dir_tree` / `cmd_workspace_dir_expand` |
| `read_preview` | 文本文件预览（≤512KB，bounded read 防 TOCTOU 增长） | `cmd_workspace_read_preview` |
| `download` | 二进制下载（≤25MB，base64 IPC） | `cmd_workspace_download_file` |
| `crud` | new-file / new-folder / rename / move（symlink-safe `slot_occupied`） | 4 个 cmd |
| `delete` | 删除：默认进 OS 回收站（`trash` crate，Finder「放回原处」承担恢复），`permanent:true` 直删；symlink（含断链）一律直接 unlink 不入 trash | `cmd_workspace_delete` |
| `transfer` | 外部路径拷贝（drag-drop，源过 external-read 黑名单 + 存在时 canonical 复查）与工作区内部 copy/paste（源走 canonical 工作区解析，自动重名）；两者 per-file `errors[]` 上报，symlink-safe collision check | `cmd_workspace_copy_paths` / `cmd_workspace_copy_internal` |
| `files_b64` | drag-drop 字节侧（base64 IPC，import + read），拒 symlink + bounded read 防身份伪装 | `cmd_workspace_import_files_b64` / `cmd_workspace_read_files_b64` |
| `user_attachments` | 用户输入图片附件 staging：绝对路径图片由 Rust 读取并复制到 `~/.myagents/attachments/<session>/`，返回 session-owned `relativePath`；≤10MB 作为图片预览/vision ref，>10MB 交回 `transfer` 转 `@myagents_files/...` 文件引用 | `cmd_prepare_user_image_attachments` |
| `check_paths` | 200-batch existence 探针（与读侧 symlink-escape gate 一致，挡 chip 假阳性） | `cmd_workspace_check_paths` |
| `gitignore` | `.gitignore` append（`with_file_lock_blocking` 串行写） | `cmd_workspace_add_gitignore` |
| `slash` | / 命令扫描（builtin + 项目 + 用户 skills；`agent-browser` Windows 屏蔽） | `cmd_list_slash_commands` |
| `search` | 模糊文件名搜索（fuzzy_matcher，跳 node_modules / dotfiles） | `cmd_workspace_search_files_fuzzy` |
| `git_branch` | 当前 git 分支查询 | `cmd_workspace_git_branch` |
| `system_open` | 揭示在文件管理器 / 默认应用打开（`process_cmd::new` 防 Windows console flash） | `cmd_workspace_open_in_finder` / `cmd_workspace_open_with_default` / `cmd_open_path_external`（绝对路径，过 credential 黑名单） |
| `watcher` | 进程级 fs watcher 注册表（ref-counted，token-based handle） | `cmd_workspace_watch_start` / `cmd_workspace_watch_stop` |

**关键约束：**

- **路径解析**：写侧 lexical（路径可不存在），读侧 canonical（防 `evil_link → /etc/passwd` 符号链逃逸）。任意绝对路径还要 canonicalize 最近存在的 ancestor 后重跑系统/credential blacklist；Windows security identity 独立归一化 `\\?\UNC\server\share` 与 `\\?\C:`，不能复用面向 Node/cmd 的前缀剥离 helper。两套 workspace helper 命名带 "_existing_" 后缀区分。
- **symlink-safe 写**：`crud.rs::slot_occupied` / `transfer.rs::slot_occupied` 用 `fs::symlink_metadata` 不是 `Path::exists()`（断链 symlink 会被后者误报为空，CLAUDE.md v0.2.5 红线）。
- **bounded read**：所有读取大文件命令用 `File::open + take(MAX+1).read_to_end`（不是 `fs::read_to_string`），防 TOCTOU 文件增长被 OOM。
- **no-follow attachment read**：workspace upload 统一走 `read_workspace_file_no_follow`。Unix 相对 root fd 用 `openat(O_NOFOLLOW)`；Windows 从已验证目录 handle 用 `NtCreateFile(RootDirectory=parent, FILE_OPEN_REPARSE_POINT)` 逐级打开 child/leaf，namespace 被替换或原地 reparse 都不会改变 IO 锚点。显式本地文件 leaf 复用 `open_regular_file_no_follow`。
- **用户图片附件 owner**：视觉附件 ref 的第一段必须等于当前 session id（新会话用 `pending-<tabId>`），Sidecar 解析 `attachment_ref` 时再次校验 owner + 10MB 上限。Launcher 不创建 draft owner，直接使用 App 同一条 pending session id。
- **watcher token**：`watch_start` 返回 `{token, eventKey}` 而非按路径派生 key — 进程内 monotonic counter + per-process nonce，跨进程 token 不复用。锁顺序固定 REGISTRY → TOKENS（防未来死锁）。
- **CORS 不涉及**：所有命令走 Tauri invoke，不挂 HTTP 端口。

**前端入口：**

- `useWorkspaceFileService(workspacePath)` — 唯一对前端开放的 hook。返回 `useMemo` 稳定的服务对象，每方法 `useCallback` 包装。所有方法的 JSDoc 标注 `[requires workspace]` vs `[workspace-free]`，传 `null` 也能调 workspace-free 方法（`openPathExternal` / `readPathsAsBase64` / `prepareUserImageAttachments` / `watchStop`）。
- `persistInputOptionChange(...)` (`src/renderer/api/persistInputOption.ts`) — Chat 和 Launcher 共用的 "选项变更持久化" helper，分支条件（`isExternalRuntime` / `runtimeConfig` / MCP push）由它处理。新增字段只改这一个文件。

**Phase 状态：**

- Phase A-D（v0.2.7）：launcher 输入框 + DirectoryPanel 迁移。
- Phase D.5（v0.2.7）：FileActionContext / FilePreviewModal / Markdown / Skill·Command 详情面板的残余 sidecar HTTP 调用全部迁移；watcher 改 token API；读侧加 symlink-escape gate；`cmd_open_path_external` 套 credential 黑名单。
- Phase E（v0.2.7，已完成）：sidecar 端 18 个 workspace IO endpoint 全部删除（`/api/files/*`、`/api/commands`、`/api/git/branch`、`/api/claude-md`、`/agent/{dir,file,download,save-file,...}`）；`syncSkillsIfNeeded` wrapper + 生成号优化删除（Rust `cmd_list_slash_commands` 总是 sync，幂等）；`/agent/save-file` 与 `/api/claude-md` 加新 Rust cmd（`cmd_workspace_save_file` / `cmd_workspace_read_claude_md` / `cmd_workspace_write_claude_md`）。`file-watcher.ts` 与 `agent:files-changed` SSE 同步删除——renderer 走 Tauri event。ESLint `no-restricted-syntax` 规则封禁被删 endpoint 字面量复活。

---

### 18. Tool Attachment 一等公民管道 (v0.2.15)

AI 运行时（Codex / builtin / 未来 Gemini / CC）产出的富媒体（图片为主，预留音频/PDF）走同一条
`UnifiedEvent.tool_result.attachments[]` 通道，前端用单一 `ToolAttachmentGallery` 组件渲染。
v0.2.15 wire 上 Codex Runtime；v0.2.33（#293）wire 上 builtin（tool_result 内容块里的图片源经
`extractToolResultRenderParts` 提取 → `saveExtractedToolResultAttachments` 落盘到
`<workspace>/myagents_files/<tool>/` + trusted-root 服务副本，session 数据从此只存 path 引用，
图片字节不再进 JSONL/SSE）；Gemini / CC 待接入。

**关键设计：**

- **协议一等公民**：`UnifiedEvent.tool_result` 加 optional `attachments?: ToolAttachment[]`；新增
  `tool_attachment_update` event 用于异步 placeholder 填充。`PersistContentBlock.tool.attachments?`
  随之扩展，老 sessions 反序列化时该字段 undefined，向后兼容
- **三种落盘源**：base64（OpenAI `image_generation_call.result`）/ externalPath（Codex savedPath
  零拷贝引用）/ url（dynamicToolCall.imageUrl 经 undici fetch + `withAbortSignal` 拉取——**刻意不用**
  `cancellableFetch`，因 SSRF DNS 钉死要传 per-request dispatcher，豁免理由见
  `tech_docs/tool_attachment_pipeline.md`）
- **异步落盘不阻塞 SSE**：`scheduleAttachmentSave` fire-and-forget，先 emit placeholder + pendingId，
  落盘成功后 `tool_attachment_update` 第二轮 SSE patch；`persistTurnResult` 进入即
  `await awaitInFlightSaves()` 防 placeholder 飞越 turn 边界 stranded 在磁盘上
- **session resume 重 register**：`rebuildAttachmentRegistryFromBlocks` 在 `startExternalSession`
  载入历史时调用，把 Codex savedPath 重新注册进 in-process registry，解决 sidecar restart 后
  attachment 404
- **5 层路径校验**：blacklist + canonicalize symlinks（读侧 default true）+ 拒绝 symlink leaf +
  positive allow-list（仅 `~/.codex/` `~/.myagents/` `~/Documents/` 等）+ trusted root（写侧）
- **SSRF 防护**：URL 下载限定 `https:` + 拒绝 loopback / RFC1918 / 169.254/16 / IPv6 ULA +
  `redirect: 'error'` + DNS 解析后校验并把 fetch 钉死在已验证 IP（防 rebinding TOCTOU）+
  流式读取累计 25MB 上限（防无 Content-Length 的无界分配）
- **错误暴露面**：`makeErrorAttachment` 把 throw 映射到固定 enum（`too_large` / `rejected_path` /
  `not_found` / `fetch_failed` / `unsupported_url` / `decode_failed` / `unknown`）；raw error.message
  不进 SSE / 不写 SessionStore（防绝对路径泄漏）
- **前端归一化**：`ToolUse.tsx` 在 specialized tool body 之后外挂 `ToolAttachmentGallery`；
  `TOOLS_THAT_OWN_GALLERY_PREFIXES = ['mcp__gemini-image__']` 老组件兜底自渲染避免双重显示；
  `mergeAttachmentsByPendingId` 防 `tool-result-complete` 重发覆盖已 patched 的 entry

**多 Sidecar 边界**：attachment endpoint 注册在每个 Sidecar 的 HTTP server 上，Sidecar Owner 模型
决定 attachments 由 sessionOwner sidecar 持有；Handover scenario 4 切到目标 Sidecar 时通过
SessionStore 反查 attachments 重 register。跨 Sidecar fetch attachment **不支持**。

**HTTP endpoint**：`GET /api/attachment/tool/<sessionId>/<turnId>/<filename>`（CORS + Cache-Control
immutable）。第一轮查内存 `externalPathRegistry`（Codex savedPath 命中），miss 后 fallback 到
trusted root `~/.myagents/generated/tool-attachments/<sid>/<tid>/<file>`（base64/url 落盘命中）。

详见 `tech_docs/tool_attachment_pipeline.md`。

---

### 19. MyAgents Cloud Space（实验室，`src-tauri/src/space_cloud.rs` + `src/renderer/pages/Space.tsx`）

Cloud Space 把官方/团队空间接入桌面端。0.3.0 起作为实验室能力正式随客户端发布，用户需在「设置 → 关于 → 实验室」显式开启；它不是默认稳定入口，但应作为实验室功能写入 CHANGELOG 与 GitHub Release notes。

**架构真相分工与版本：** 本仓库只维护 Desktop 客户端 owner（Rust connector、本地身份/状态、UI、CLI 与 Task/Session 执行），详细状态见 `specs/tech_docs/space_cloud.md`；Cloud Worker 的 API、鉴权、领域模型、D1/R2、一致性、quota 与运营能力由同级 `hAcKlyc/MyAgents_space` 仓库的 `specs/ARCHITECTURE.md` 维护。本地平级 checkout 路径为 `../MyAgents_space/specs/ARCHITECTURE.md`。两仓独立版本，但 0.3.2 Registered Agent execution instance 属于一次协调交付：Cloud additive migration/Worker 与 v0/v1/v2 smoke 先通过，再发布 Desktop。0.3.2 源码实现不代表 Production 已上线；实时真相仍只以两端已发布版本和 Cloud `/health` 为准。若契约变化必须同步更新两边实现、测试、文档和兼容基线。

**核心边界：**

- Space 不是 AI Runtime / Session Sidecar。云端登录、HTTP 请求、附件/Skill IO、registered-agent IssueDelivery poll/process 都由 Rust Tauri command 拥有。
- Renderer 只通过 `src/renderer/api/spaceCloud.ts` 调 Tauri invoke，不直连 Space 服务，也不持有 session token。
- build-time capability 由 `src-tauri/build.rs` 注入 `MYAGENTS_SPACE_*`，`cmd_space_get_capability` 只裁决构建能力与当前 build-time origin；实验室入口还受 `config.teamSpaceEnabled` 默认关闭门控。debug 构建可烘焙 `MYAGENTS_SPACE_DEV_BASE_URL`，release profile 机制性丢弃 Dev origin。
- `config.spaceEnvironment` 只在烘焙的 `production` / `dev` origin 之间二选一，Renderer 不提供自由 URL 输入。旧配置值 `staging` 仅在 debug 构建包含 Dev origin 时读取为 `dev`；新写入永远使用 `dev`，release 构建一律回落 Production。
- 本地状态 production 在 `~/.myagents/space/{session.json,registered_agents.json,delivery_log.json}`，Dev 在 `~/.myagents/space/dev/{...}`；二者不进入 SessionStore，旧 `space/staging` 不自动迁移。全局 Skill 安装仍是 `~/.myagents/skills`，不随 Space 环境切换。
- Space renderer cache identity 包含服务 origin；切换 production/Dev 时即使 space slug 同为 `official` 也必须清缓存。
- 本地端点身份统一由 `~/.myagents/device_id` 表达，Rust owner 是 `src-tauri/src/device_identity.rs`。Analytics 的 `device_id` 与 Space 的 `deviceId` 消费同一个值，不再派生第二套云端 device id。
- 云端概念是 `user_devices(userId, deviceId)`，用于记录某个登录用户在某个本地端点上的设备名、平台、系统版本、客户端版本与 last seen。客户端登录/授权后会尝试 upsert；registered-agent 注册/编辑 payload 也携带这些字段供服务端落表。
- Registered Agent 是执行实例，归属于 `(ownerUserId, deviceId)`，并关联该设备上的本地 Agent 工作区；workspace 不是身份。同一 workspace 可登记多个实例，各自拥有 id/token、Instruction/revision、Subscription 集合与 Session binding。只有 `ownerUserId === current session user` 且 `deviceId === current local device_id` 的 Agent 才是当前设备可编辑/可执行的 local Agent。
- Registered Agent 执行端点使用 token-only capability：本地轮询时只带 registered-agent token，服务端由 token 映射到 user / space / device / agent 权限边界；MyAgents Desktop 只从“当前 Space user + 当前 device”的本地 token 集合中选择 token。
- Registered Agent delivery 处理由 Rust 长驻 connector 拥有：每个 agent 维护内存级 due time / empty streak，云端返回 transport-only v2 package 与 `poll` 提示，本地负责严格解析、Prompt 组装、clamp/jitter/错误退避、exact Session origin、inbox 注入、本地 receipt 与自动 ACK。Renderer 只能唤醒 connector，不自己 poll/process delivery，也不持有 registered-agent token。
- Space CLI 是三层薄壳：Node CLI 解析显式 slug/参数，Sidecar Admin API 补当前 project stable workspace id，Rust `SpaceCliContext` 单点拥有 membership 刷新、User/Registered Agent token 选择与 binding fail-closed。只有持久 Session origin 中 exact `spaceId + registeredAgentId`（或显式 legacy localAgentId）可选择 Agent；workspace path/id 只做 containment/binding 校验，绝不推断 actor。0.3.2 删除 Agent-facing Delivery ignore，no-op 不需要 CLI 动作；`space goal list`、`space issue --help` 与业务 leaf 继续复用既有路径。Space mutation 不实现伪 preview，出现 `--dry-run` 时由 CLI 在 HTTP 和文件 IO 前 fail closed。
- Issue 正文附件与评论附件共用 Cloud `issue_attachments`，以 nullable `comment_id` 决定归属。Renderer 文件选择只形成 Rust inspect 后的本地 metadata draft；创建/评论/完成在一次 JSON 或 multipart mutation 内提交。已发布 Issue 顶部“上传”仍是独立即时 mutation，并产生正常 update/delivery。
- Space 附件字节 IO 由 Rust owner：上传最多 5 个/单个 25MB、workspace CLI no-follow containment；Windows child/leaf/temp 全部相对已验证目录 handle 打开，最终覆盖也用 `RootDirectory` handle-relative rename，阻断目录替换与原地 reparse。下载流式累计 25MB且只在完整成功后提交。二进制不进入 Renderer state、Delivery 或 Session prompt。
- Cloud Worker 侧的容量与一致性策略属于 `MyAgents_space` 服务端：D1 访问走 bookmark-aware facade，delivery poll 是读路径，poll 数字由服务端策略 owner 返回，prune/rate limit/placement 由 Worker 配置与服务端代码承担。

详见 `tech_docs/space_cloud.md`；云端 counterpart 详见 `hAcKlyc/MyAgents_space/specs/ARCHITECTURE.md`。

---

### 20. UI 国际化 (`src/shared/i18n.ts` + `src/renderer/i18n/` + `src-tauri/src/i18n.rs`)

产品界面语言由 `AppConfig.uiLanguage` 持久化，取值为 `system` 或显式 supported locale。TypeScript shared 层定义 allow-list 与 normalize 规则；renderer 用 i18next 加载 namespace JSON；Rust 拥有 native chrome（托盘菜单）的语言 mirror。

`system` locale 在 Tauri 环境由 Rust `sys-locale` 解析并通过 `cmd_get_ui_language_state` / `ui-language-changed` 事件下发，避免主窗口、浮窗、托盘各自解析导致 split-brain。Settings 修改语言必须走 `ConfigProvider.updateConfig` → `cmd_set_ui_language`，Rust 在同一锁内完成写盘、托盘 relabel 与事件广播；Admin CLI 或其它外部写盘路径触发 `cmd_sync_ui_language_from_config` 重新同步 native mirror。

浮球 / 伴随窗口没有完整 `ConfigProvider`，由 `FloatingI18nBootstrap` 启动前读取 native 语言状态并等待 ready 后渲染。

详见 `tech_docs/i18n_architecture.md`。

---

### 21. Theme System (`src/shared/theme.ts` + `src/renderer/theme/`)

Theme 是 renderer 视觉语言的应用级唯一 owner；`AppearanceMode` 只是用户的明暗偏好，两者正交：

- `themeId`：当前生效的完整 Theme 身份；production registry 依次注册 `myagents-default`、`default-black`、
  Sage、Claude（稳定内部 ID `absolutely`）、Linear、Proof、Codex、Raycast；
- `themeSelectionExplicit`：用户是否明确选过 Theme；`false` 时跟随可独立演进的产品默认
  `DEFAULT_THEME_ID`（当前为 `default-black`），`true` 时永久尊重 `themeId`；
- `appearanceMode`：`system | light | dark`；
- `resolvedColorScheme`：每个 Webview 此刻解析出的 `light | dark`。

`ThemeRegistry` 校验一个 Theme 同时具备 light/dark、精确 Theme root / scheme root 下的 required CSS Token、Launcher Hero 和 xterm / Monaco / Mermaid / Prism / Widget adapters；canonical default 另允许受控的 `:root, <exact-theme-root>` 合并 globals 作为 unknown-ID/pre-React fallback，可选 Theme 不得泄漏全局 selector。Preset adapter 构造与 Registry 校验复用同一个 stylesheet contract parser，按 CSS selector/declaration 语义读取实际 `?inline` 产物，不依赖开发源码的引号或空白序列化。Token 解析 Theme 内 `var(...)` 后按实际消费属性校验，Widget 值必须是 iframe 可直接消费且属性语法有效的 literal，stylesheet 与 Hero 资源禁止远程 URL。无效可选包在注册边界被拒绝且不阻断 canonical Theme，未知 ID 整套回退 default，不做逐字段拼接。组件只能 import `@/theme` 公共入口，`.dependency-cruiser.cjs::theme-consumers-public-api-only` 禁止生产 consumer 直引 concrete Theme。

Theme CSS 只拥有运行时视觉值；Tailwind 入口 `src/renderer/index.css` 用无值
`@theme inline` 把 font/radius/shadow/duration utility 编译为对 `--theme-*` 与语义
Token 的运行时引用。禁止在动态 Theme package 中放 raw `@theme`；该 CSS 不会二次经过
Tailwind，否则 utility 会静默回退 framework default。`build:web` 后的 generated-CSS 契约校验
是这条编译边界的必备护栏。

配置读取边界由 `normalizeThemeConfigRecord()` 把旧 `theme` 无损迁移为 `appearanceMode`。缺失 Theme 选择或历史自动物化的 `myagents-default` 迁为 `default-black + themeSelectionExplicit:false`；历史非 canonical ID 视为用户已选择，继续保留。读取只做内存归一，下一次真实的 config-lock 写入清掉 legacy 字段。Settings 仍经 `ConfigProvider.updateConfig()` 分别写 `{ themeId, themeSelectionExplicit:true }` 或 `appearanceMode`，两者不得互相覆盖。`myagents-default` 继续只承担 canonical/unknown-ID fallback，产品默认与结构兜底不得重新合并成一个概念。

启动与窗口数据流：

```text
Rust 读取归一后的非敏感 disk appearance
  → 隐藏构建主窗口 + native canonical --paper 首帧投影
  → one-shot initialization script 对齐 versioned localStorage snapshot
    （Theme ID 只保留 renderer registry 已解析值；同进程 reload 不覆盖新快照）
  → index.html 在 React 前应用 html[data-theme-id][data-color-scheme] + .dark
  → durable AppConfig 加载后 ConfiguredThemeRuntime 校正并刷新 snapshot
  → ThemeRuntime 激活已校验的实际 stylesheet + ResolvedTheme Context + root CSS Token selector
    + 把当前 resolved --paper 投影到 main native Window background
  → CSS surface / Launcher / xterm / Monaco / Mermaid / Prism / Widget
  → Tauri theme:selection-changed → FloatingThemeRuntime 即时重解析
```

浮球 Webview 保持轻量 tree，不挂完整 `ConfigProvider`：先用 snapshot 保证首帧，随后先完成精简事件 listener 注册、再异步读 durable config；hydration 期间收到的 live event 具有更高 freshness，旧磁盘结果不能反向覆盖。`system` 由每个 Webview 的 `useSyncExternalStore(matchMedia)` 订阅；`.dark` 只是 Tailwind 兼容投影，不再是 React consumer 的反向状态源。

Space 与其它 renderer CSS surface 一样直接继承 `<html>` 上当前 Theme 的语义 Token；不维护局部 Theme ID、独立 palette 或 portal scope 传播。Space 的布局、业务状态机、三方 Logo、用户内容和纯 alpha 遮罩仍不属于 Theme 身份，但 paper、文字、字体、圆角、阴影、动作色和业务状态色必须随全局 Theme / scheme 原子切换。

详见 `tech_docs/theme_system.md`。

---

## Pit-of-Success

跨模块 helper 的完整 Problem / Surface / Invariants / Don't 由 `tech_docs/pit_of_success.md` 维护；可静态判断的边界由 ESLint、dependency-cruiser 与 Clippy 执行。本架构文档不镜像 helper 清单：只有 helper 改变了 owner、进程边界或主数据流时，才需要在对应架构章节更新。

---

## 资源管理

| 事件 | 操作 |
|------|------|
| 打开/切换 Session | `ensureSessionSidecar(sessionId, workspace, ownerType, ownerId)` |
| 关闭/切换桌面 Tab | `releaseTabSession(sessionId, tabId)`；Rust 在 scheduler + Sidecar owner 锁内同时释放 Tab owner 并保留或撤销 activation |
| 定时 Task 启动 | `run_task_by_id` 提交 Running 并 arm `TaskSchedulerController` |
| Task Turn 执行/结束 | lazy `SidecarOwner::Task(taskId)`；terminal/stop/delete 取消 Turn、移除 timer、对称释放 owner |
| Memory Auto-Update | 作为隐藏 managed Task 使用 `SidecarOwner::Task(taskId)`；复用 Ready Sidecar 也先 retain，只有执行完成或进程终止已确认才由 RAII 释放，`terminationUnconfirmed` 时保留给精确 Stop |
| Goal 自动续跑 | active Goal 使用一个 one-shot continuation handle；进入 Node dispatch 前附着 `SidecarOwner::Goal(goalId)`，用户 query 最晚在 Runtime claim 时附着 |
| Goal Pause/终态 | 先提交 SessionGoal 状态，再精确 stop queue Turn；确认后才清 authority / 释放 Goal owner并广播 `goal:changed`，不确定时保留 |
| IM 消息到达 | `ensureSessionSidecar(sessionId, workspace, 'agent', sessionKey)` |
| IM Session 空闲超时 | `releaseSessionSidecar(sessionId, 'agent', sessionKey)` |
| 终端打开 | `cmd_terminal_create(workspace, rows, cols, port, id)` |
| 终端关闭 / Tab 关闭 | `cmd_terminal_close(terminalId)` |
| 浏览器打开 | `cmd_browser_create(tabId, url, x, y, width, height)` |
| 浏览器关闭 / Tab 关闭 | `cmd_browser_close(tabId)` |
| 任务立即执行 / 重新派发 | `task::run` / `cron run-now` → 直接触发 Task execution use case；不创建 CronTask |
| Task 软删除 | `TaskStore::delete` → 写 `→ deleted` 伪状态 + 联动清理 thought |
| 应用退出 | `stopAllSidecars()` + `close_all_terminals()` + `close_all_browsers()` |

**Owner 释放规则：** 当一个 Session 的所有 Owner 都释放后，Sidecar 才停止。

---

## 安全设计

- **FS 权限：** Tauri scope 仅允许 `~/.myagents` 配置目录
- **Agent 目录验证：** 阻止访问系统敏感目录
- **Tauri Capabilities：** 最小权限原则
- **本地绑定：** Sidecar 仅监听 `127.0.0.1`
- **CSP：** `img-src` 允许 `https:`（支持 AI Markdown 图片预览），`connect-src` 严格锁定（管 fetch/XHR/WS；非标准的 `fetch-src` 已移除，引擎本就忽略它）
- **代理安全：** `local_http` 模块内置 `.no_proxy()` 防止系统代理拦截 localhost
- **浏览器沙箱：** 内嵌浏览器 Webview 通过 Capability 隔离（`browser.json` 零权限），无法访问 Tauri IPC；URL scheme 限制为 http/https

---

## 跨平台策略

### 平台差异

| 特性 | macOS | Windows | Linux |
|------|-------|---------|-------|
| 字体渲染 | 更平滑 | 更锐利 | 介于之间 |
| 窗口控制 | 左上红绿灯 | 右上三按钮 | 取决于桌面环境 |
| 滚动条 | 自动隐藏 | WebView2 经典滚动条（renderer 用活动态隐藏 thumb） | 取决于桌面环境 |
| Shell | zsh | PowerShell / cmd | bash |
| Console window 抑制 | — | `process_cmd::new()` 注入 `CREATE_NO_WINDOW` | — |
| 系统 PATH 查找 | `system_binary::find()`（Finder 启动 PATH 缺失） | — | — |

### 跨平台环境变量 (`src/server/utils/platform.ts`)

`buildCrossPlatformEnv()` 自动设置双平台变量：

| 用途 | macOS / Linux | Windows |
|------|--------------|---------|
| Home 目录 | `HOME` | `USERPROFILE` |
| 用户名 | `USER` | `USERNAME` |
| 临时目录 | `TMPDIR` | `TEMP` / `TMP` |

详见 `tech_docs/windows_platform.md` / `guides/linux_build_guide.md`。

---

## 单一运行时与预置二进制

### Node.js v24（唯一 MyAgents 自有 runtime）

| 用途 |
|------|
| Sidecar |
| Plugin Bridge |
| MCP Server (`npx`) |
| 社区 npm 包 |
| `myagents` CLI |
| AI Bash `node` / `npx` / `npm` |

打包位置：`src-tauri/resources/nodejs/`（构建 staging 目录；按架构缓存见 `tech_docs/bundled_node.md`）。

### SDK Native Binary（SDK 团队的实现细节）

`src-tauri/resources/claude-agent-sdk/claude[.exe]` —— SDK 0.2.113+ 用 `bun build --compile` 产物分发，内嵌 SDK team pin 的 Bun。独立进程，stdio NDJSON 与我们通信，**不共享 MyAgents Node 进程内状态**；但在 builtin `anthropic-sub` 路径下，它仍按 Claude Code native 默认规则读取本机官方 OAuth credential store（macOS Keychain / `~/.claude/.credentials.json`）。MyAgents 不设置 `CLAUDE_CONFIG_DIR`，也不接管这套 OAuth 生命周期。

`src/server/agent-session.ts::resolveClaudeCodeCli()` 按 platform triple 定位。

### 预置原生二进制 MCP

| 二进制 | 用途 | 来源 | 打包位置 |
|--------|------|------|---------|
| **cuse** | 预置 Computer-Use MCP（截图/点击/输入/滚动，仅 macOS/Windows） | Cloudflare R2: `https://download.myagents.io/cuse/...`（源头是私有 `hAcKlyc/MyAgents-Cuse` GH Release，由该仓库的 `publish_r2.sh` 镜像到 R2 供本开源 repo build 使用） | `src-tauri/binaries/cuse-*-<triple>[.exe]` |

新增同类二进制约定：
- 注册到 `PRESET_MCP_SERVERS` 时用 `command: '__bundled_xxx__'` 哨兵
- 平台差异通过 `McpServerDefinition.platforms` 字段
- `build_macos.sh` 通配 `src-tauri/binaries/*-apple-darwin` 自动继承应用签名

### Git for Windows

Windows 无自带 git/bash，NSIS 静默安装 Git for Windows（`src-tauri/nsis/Git-Installer.exe`），SDK 依赖。

### PATH 注入

`buildClaudeSessionEnv()` 优先级：`systemNodeDirs`（用户安装的 Node.js） → `bundledNodeDir` → `~/.myagents/npm-global/bin` → `~/.myagents/bin` → 系统路径。SDK shell env 不全局设置 `npm_config_prefix`；需要固定 npm 安装落点时使用命令级 env。

详见 `tech_docs/bundled_node.md`。

---

## 日志与排查

### Boot Banner

应用启动和每个 Sidecar 创建时输出 `[boot]` 单行自检信息：
```
[boot] v=0.3.1 build=release os=macos-aarch64 provider=deepseek mcp=2 agents=3 channels=5 scheduled_tasks=12 proxy=false dir=/Users/xxx/.myagents
[boot] pid=12345 port=31415 node=24.14.0 workspace=/path session=abc-123 resume=true model=deepseek-chat bridge=yes mcp=playwright builtin-mcp-meta=gemini-image,edge-tts
```

排查第一步：`grep '\[boot\]' ~/.myagents/logs/unified-*.log` 获取完整环境。

主窗口还输出稳定的阶段标签：`native-page-load-started/finished → native-init-script → renderer-entry-evaluated → theme-renderer-bootstrap-complete → react-root-created → react-commit`。`renderer-uncaught-error` / `renderer-unhandled-rejection` 由 initialization script 在模块加载前捕获，因此即使 React 尚未执行也能定位停点。pre-App JS 统一通过白名单 Tauri command `cmd_record_renderer_boot_event` 进入 Rust unified logger；每条阶段含 `window=<label>`，禁止直写 raw plugin-log 形成第二日志 sink。阶段观测只记录状态与有界错误，不触发 reload/retry，也不改变 Theme fallback。

### 统一日志格式

三个来源汇入 `~/.myagents/logs/unified-{YYYY-MM-DD}.log`（本地时间）：
- **[REACT]** 前端日志
- **[NODE]** Node.js Sidecar 日志（logger interceptor 直写）
- **[RUST]** Rust 层日志

日志 owner 与业务 owner 对齐：SSE text/thinking/tool/subagent delta 与 Claude Code raw partial NDJSON 是纯 transport，不落 unified log；Builtin / external turn terminal 记录有界 assistant 摘要（单行前 100 个 Unicode code point + 原始字符数），既有低频 SDK result 仅保留有界诊断；Plugin Bridge pending-dispatch terminal 只留 count/chars/hash，不重复同一 IM 正文。Codex `developerInstructions` 只记 presence/长度/短哈希。Sidecar logger 初始化后 Node 是 `console.*` 的唯一文件持久化 owner，Rust 只接真实 raw stderr；Rust unit tests 禁止写用户真实 unified log。高频成功轮询（含 `/api/session-state`）由 HTTP log policy 静音，异常仍由其语义 owner 记录。

详见 `tech_docs/unified_logging.md`。

---

## 开发、构建与发布入口

可执行命令以根目录 `package.json` 和平台脚本为准；环境、签名、产物与发布顺序见 `guides/` 下对应平台文档。这里不复制易随脚本变化的命令清单。

---

## 深度文档索引

按场景分组：

### 启动与运行时
- [Node.js 打包架构](./tech_docs/bundled_node.md) — 内置 Node.js v24 + SDK native binary 分发、PATH 注入
- [Sidecar 冷启动性能](./tech_docs/sidecar_cold_start.md) — listen 时序、Tier 2 懒加载、Tab fast-path
- [Pit-of-Success 模块完整规范](./tech_docs/pit_of_success.md) — Rust + Node 全部 helper
- [自动更新系统](./tech_docs/auto_update.md) — Chrome/VSCode 风格静默更新机制

### 通信与会话
- [Session 架构](./tech_docs/session_architecture.md) — ID 格式、JSONL 存储、SDK 双重存储、状态同步、Goal Mode session 状态
- [System Reminder 隐藏消息协议](./tech_docs/system_reminder_protocol.md) — 注入 user message 的 hidden payload、badge tag、visible tail 前端展示规则
- [代理配置](./tech_docs/proxy_config.md) — 系统代理 + SOCKS5 桥接
- [统一日志](./tech_docs/unified_logging.md) — 日志格式、来源、排查指南
- [三方供应商](./tech_docs/third_party_providers.md) — 环境变量、认证模式、Bridge 原理

### Multi-Agent Runtime / Agent / IM
- [Multi-Agent Runtime](./tech_docs/multi_agent_runtime.md) — CC / Codex / Gemini 协议、会话管理、门控链路
- [Tool Attachment 管道](./tech_docs/tool_attachment_pipeline.md) — 任意 runtime 产图归一化、落盘 helper、SSRF 防护、placeholder 异步落盘
- [IM 集成技术架构](./tech_docs/im_integration_architecture.md) — Agent / Channel 详细设计、适配器模型
- [Plugin Bridge 架构](./tech_docs/plugin_bridge_architecture.md) — OpenClaw 插件加载、SDK shim、CJS/ESM 混用插件 runtime 补丁
- [Claude Plugin 加载](./tech_docs/plugin_loading.md) — Anthropic Claude Plugin 协议接入（PRD 0.2.17）、SDK Options.plugins、安装管线、与 OpenClaw plugin 的命名隔离

### 任务中心 / 搜索
- [任务中心架构](./tech_docs/task_center.md) — TaskStore 权威、直接调度、Legacy Cron 迁移、CLI
- [Cloud Space 架构](./tech_docs/space_cloud.md) — 实验室 Space 登录、Issue/Skill、registered agent、IssueDelivery/claim 到 attached-session Task
- [全文搜索架构](./tech_docs/search_architecture.md) — Tantivy + jieba、session watcher、UTF-16 高亮

### SDK 集成
- [`canUseTool` 回调指南](./tech_docs/sdk_canUseTool_guide.md) — 人工干预工具权限的实现要点
- [自定义 Tools 指南](./tech_docs/sdk_custom_tools_guide.md) — `createSdkMcpServer` + `tool` 用法、当前 SDK 工具清单

### 平台与构建
- [Windows 编码约束](./tech_docs/windows_platform.md) — 路径前缀 / 进程 / 环境变量 / CSP（写代码时查）
- [Windows AI Review Traps](./tech_docs/windows_ai_review_traps.md) — macOS 开发时对抗性 review Windows 易错边界（真实事故模式 + owner/helper）
- [Linux 构建与分发](./guides/linux_build_guide.md) — AppImage / deb / 支持矩阵
- [构建问题排查](./guides/build_troubleshooting.md) — Windows 构建 / CSP / Resources 缓存 / 代理

### 前端
- [设计系统](./DESIGN.md) — Token / 组件 / 页面规范
- [Theme System](./tech_docs/theme_system.md) — Theme/Appearance 状态、注册契约、Token/adapter owner、bootstrap 与跨窗口同步
- [React 稳定性规范](./tech_docs/react_stability_rules.md) — Context / useEffect / memo 5 条规则
- [UI 国际化架构](./tech_docs/i18n_architecture.md) — `uiLanguage`、i18next resources、native tray language mirror、增加新语言流程

### CLI
- [CLI 架构](./tech_docs/cli_architecture.md) — 自配置 CLI 设计、版本门控、Admin API、PATH 注入

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
- 任务中心（任务编辑 + 调度 + 状态机审计）
- 统一 Record（文字速记、桌面录音、本地转录与说话人纠错）

## 技术栈

| 层级 | 技术 |
|------|------|
| 前端 | React 19 + TypeScript + Vite + TailwindCSS |
| 桌面框架 | Tauri v2 (Rust) |
| 后端 | Node.js v24 Sidecar（一个 Global + 每个 Session 一个）；Builtin Runtime 集成 Claude Agent SDK 0.3.233 |
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
│                             Node.js Sidecars                                │
│  ┌───────────────────────┐  ┌──────────────────────────────────────────┐   │
│  │ Global Sidecar        │  │ Session Sidecar（每个 Session 一个）    │   │
│  │ Settings / Store      │  │ Runtime Selector                        │   │
│  │ Provider / OAuth      │  │ builtin SDK / Claude Code / Codex       │   │
│  │ 应用级管理与维护      │  │ / Gemini；Session Runtime 与 turn API   │   │
│  └───────────────────────┘  └──────────────────────────────────────────┘   │
│  Shared: health / refs / Runtime 模型目录 / 历史 Session 读取              │
│  Session: In-process MCP / External MCP / OpenAI Bridge                    │
└──────────────────────────────────────────────────────────────────────────────┘
```

应用维护一个 Global Sidecar；每个 Session 最多对应一个 Session Sidecar。Tab / Companion / Task / Goal / BackgroundCompletion / Agent owner 可以共享同一个 Session Sidecar，全部释放后才停止该进程。

Sidecar 停止与 replacement 复用 per-generation `DispatchGate`：manager 锁内关闭 exact generation 的新请求准入并继续保留该 entry，已放行请求的排空在锁外完成，随后按 gate identity 回到 manager 内提交移除；进程对象释放仍在锁外。Session 与 Global 都遵守这一顺序。Global 首次启动先在唯一的 `instances[GLOBAL_SIDECAR_ID]` 槽位登记 process-less birth reservation，再持该 gate 的瞬时 lease 在锁外 spawn；replacement 同样由旧 gate 的瞬时 lease 覆盖锁外候选创建并原子替换原 entry。两者都不建立第二套候选 owner 或 restart mutex。standing intent 只表达应用是否仍需要该服务，generation 由 Global entry 自身持有，监控结果按 `(generation, port)` 拒绝过期工作。请求 lease 只覆盖 Sidecar HTTP 到响应体物化，不覆盖 Tauri / WebKit IPC 回传；端口探测、进程创建、资源清理及可能等待排空的工作都不能占用 manager 锁，阻塞型 command 必须通过 async + blocking worker，应用级批量停止还要先关闭 lifecycle birth admission。这样保留旧/新 generation 的非幂等隔离，又不会让一个 Session 的关闭冻结主线程或其它 Session。

Rust 在创建 Sidecar 和 Plugin Bridge 时同时建立后代进程树的精确控制句柄。正常停止和应用退出只使用这些句柄，不根据全机进程的命令行猜测归属；应用退出还会先禁止新的资源创建，并等待已获准的创建流程完成登记或释放。全机进程扫描只用于确认前一个应用实例已经退出后的启动恢复，以及更新器的残留进程检查。跨平台实现与退出顺序见 `tech_docs/pit_of_success.md` 的 `process_cmd` 小节，Windows 细节见 `tech_docs/windows_platform.md`。

Session 进程崩溃后，尚未结束的逻辑工作仍由 Rust `SidecarManager` 持有，不能依附于某一次候选进程。候选进程创建或就绪失败只结束该次 generation；owner、恢复轮次和有界重试会保留到新 generation 就绪、owner 全部释放或 Session 被删除。`BackgroundCompletion` 每次轮询都在请求前后核对当前 generation，旧 generation 的迟到结果不能提交终态或释放当前 owner。完整状态机见 `tech_docs/session_architecture.md`。

Global Sidecar 同样把“应用仍需要它运行”与“当前候选进程”分开。`SidecarManager` 用 `Stopped | DesiredRunning` 表示运行意图；候选进程创建或就绪失败不会清除该意图，monitor 会按有上限的退避继续恢复。只有显式停止 Global、`stop_all`、更新关闭或应用退出才清除运行意图。`~/.myagents/sidecar.port` 只记录当前健康 generation 的端口，不能用于判断 Global 是否应该运行。

---

## 核心抽象

理解以下抽象是改任何功能的前置认知。

### Sidecar Owner 模型

| 概念 | 说明 |
|------|------|
| **Sidecar 进程角色** | Global Sidecar 负责应用级能力；Session Sidecar 承载当前 Session 的 builtin 或 external Runtime |
| **Session : Sidecar = 1 : 1** | 每个 Session 最多一个 Sidecar，严格对应 |
| **后端优先，前端辅助** | Sidecar 可独立运行（定时任务、Agent Channel），无需前端 Tab |
| **Owner 模型** | Tab、Companion、Task、Goal、BackgroundCompletion、Agent 是 Sidecar 的使用者。所有 Owner 释放后 Sidecar 才停止 |
| **Global 运行意图** | Global 没有 Session owner 集；Rust manager 用 `Stopped | DesiredRunning` 独立表达应用常驻需求，候选失败不清除需求 |

```rust
pub enum SidecarOwner {
    Tab(String),                   // Tab ID
    Companion(String),             // Floating companion surface ID
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
| Record detail | ❌ 不包裹 | 不拥有 Sidecar | Tauri `cmd_record_*` / `cmd_recording_*`；语音 job 由 App-global manager 执行 |
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

共享 ref store 支持 Node 与 Rust 多写入者，但两者必须使用同一套不可覆盖的 body/meta 提交协议。Rust HTTP proxy 只允许 loopback 响应写入本地 ref；外部地址的响应必须在内存上限内返回，不能生成指向本地 `/refs` 的 URL。`ProxySpillManager` 只管理 Rust proxy 的在途写入和已知清理失败，不是附件或整个 ref store 的全局配额管理器。文件协议、响应上限和清理规则见 `tech_docs/pit_of_success.md` 的 `maybeSpill` 小节。

所有连接本地 Sidecar（`127.0.0.1`）的 reqwest 客户端 MUST 通过 `crate::local_http::*` 创建，内置 `.no_proxy()` 防止系统代理拦截 → 502。

详见 `tech_docs/pit_of_success.md` 的 `local_http` 节。

---

## 通信模式

### SSE 流式事件

Rust SSE Proxy (`src-tauri/src/sse_proxy.rs`) 按 renderer surface 维护长期订阅。`connectionKey` 只负责 Tauri event namespace；物理端口在每次 HTTP attempt 前由 `SidecarManager` 用 `sessionIdHint + SidecarOwner` 解析，因此 Sidecar crash/换端口不依赖 Renderer 重建 URL，也不另存 owner→port 副本。普通 Chat 使用既有 `Tab(tabId)` owner，Floating Ball 使用既有 `Companion("floating-ball")` owner。

```
事件格式: sse:${connectionKey}:${eventName}
示例:     sse:tab-xxx:chat:message-chunk
```

```
Tab1 listen('sse:tab1:*') ◄── Rust supervisor ◄── owner resolve ◄── Sidecar:31415 → replacement port
Tab2 listen('sse:tab2:*') ◄── Rust supervisor ◄── owner resolve ◄── Sidecar:31416
```

每个 subscription 有两个独立 generation：start replacement 的 `subscription generation` 防止旧 task emit/cleanup 新 entry，并在实际 Tauri emit 时再次验证当前 authority；每条成功 HTTP 200 stream 分配进程内全局单调的 `transport generation`。Rust 转发 payload 为 `{ transportGeneration, data }`；Renderer 小于已观察 generation 的事件 fail closed。更大的 transport generation 只表示物理流重连：已被 REST adopt / restore 的 Session 若第一条 `liveRevision` 连续就直接续投影，只有 gap / 无基线才建立 REST restore fence；Rust 单独发布的 `session-sidecar:restarted` 才表示进程 epoch 更换并强制重建基线。尚未被 REST adopt 的新 Session 继续走 SSE-native birth。`start_sse_proxy` command ack 只代表订阅已安装，不代表物理流 connected。connect error、非 2xx、body error、read timeout 与 EOF 都由同一个 Rust supervisor capped backoff；只有 stop/replacement 结束订阅。Browser development mode 仍使用原生 EventSource 自己重连。

subscription 跟随稳定的 renderer `connectionKey + SidecarOwner`，不是跟随可变的 Session key：pending→real materialization、桌面 reset 与已由 Rust 完成的 surface migration 都是在同一 Sidecar 内升级 Session identity。pending→real 可由 generic binding effect 识别；real→real 只能由实际 reset / migration owner 按 exact A→B 操作原子采用 business current 与 attachment，拒绝或异常时做 exact rollback，不能把长期 birth marker 当 transport authority。SSE status callback只报告 liveness，不得从 business current反向改写 attachment。普通历史导航通过 App new / jump / revive 目标 Tab，不在现有 subscription 上 hot-swap Session。带 `sessionId` 的业务事件以 payload 与当前 Session是否一致为 scope authority，并在 live-revision dispatch前拒绝 concrete mismatch；connection创建时的 `sessionIdHint` 只用于 Sidecar resolver / attachment，不能否决同一 Sidecar A→B handover中已经明确属于 B 的事件。

Node.js SSE Server (`src/server/sse.ts`) 管理客户端连接、heartbeat、广播：
- `broadcast(event, data)` —— 向所有客户端广播
- **Last-Value Cache** —— 缓存 `chat:status` 最新值。新 SSE 客户端连接时自动 replay
- **Scoped replay snapshot** —— `SessionEngineStreamReplaySnapshot` 同时返回当前 `sessionId`、replay messages与active assistant；external adapter在pending→real启动窗口优先使用已promoted的bound Session，并从既有 immutable live snapshot提供尚在内存的accepted turn。`/chat/stream` 在注册新client前同步取得snapshot，把scope与active assistant合入既有`chat:init`，再发送带scope的cold-history；Renderer原子采用assistant snapshot，只有后续真实`chat:message-chunk`按delta追加。Route不读取adapter internal、不从消息猜identity，也不新增恢复事件
- **日志降噪** —— 高频流式事件（chunk / delta）跳过 `console.log`

新增 SSE 事件 MUST 在 `SseConnection.ts::JSON_EVENTS` 注册白名单，否则前端静默丢弃。
会更新 Tab 会话快照的 SSE 事件（如 `chat:system-init`、权限/提问/plan-mode request 与 expired）还 MUST 带 `sessionId`，并在 `TabProvider` 通过 `sessionScopedEventGuards.ts` 按 payload/current Session 过滤；无 scope 的 legacy 事件在 identity transition 中 fail closed。否则历史导航 / target replacement 或新会话 birth 时会把旧 sidecar 的弹窗/状态灌进当前 Tab。详见 `tech_docs/session_architecture.md`。

恢复 running/starting Session 时，REST `GET /sessions/:id` 是完整历史与 live snapshot 的唯一权威；需要与快照对齐的非幂等 live SSE 事件带 `{ sessionId, liveRevision, payload }`，REST 同时返回 `snapshotRevision`。Renderer 在 REST 期间 buffer，之后只顺序应用 revision 大于快照的连续事件；只有 gap / 无基线或明确的 Sidecar replacement epoch 才重新取快照，transport generation 变化本身不触发恢复。live-recovery commit 只替换权威 recent tail 并保留已分页的 older prefix、滚动锚点与无关 UI state；无 overlap 才整体采用 snapshot。持续 gap 只自动补取一次；请求失败或补取后仍不连续就进入 `failed`，隔离后续普通 revision，等待用户显式重试或下一次 `session-sidecar:restarted`。revision 只属于当前 Sidecar/session process epoch 的内存顺序，不持久化 checkpoint。详见 `tech_docs/session_architecture.md`。

普通 Session 的 complete/stopped/error 通知也不归 Tab：builtin/external Runtime 产生统一的 turn identity、owner 和 origin 描述；Rust SSE proxy 与 `BackgroundCompletion` 只是两个提交入口。当前 Sidecar generation 负责发放一次性完成资格，`notification.rs` 再根据业务类型、窗口焦点和通知偏好统一处理系统通知、badge 与 deep-link。Renderer 的 terminal handler 只维护消息、UI 和未读状态。

Cloud 通知同样不归 Tab，但有独立的进程级 Owner：`space_cloud::notifications` 随 Tauri App 启动，通过一个 optional-auth Cloud feed 投影公开公告与当前账号的 Space Issue 评论；Renderer 只消费 normalized snapshot。通知 receipt 统一写入应用全局 `~/.myagents/notification-state.json`：本地 Task receipt 不跟随 Space 环境，Cloud 公告与 pending read 则先按规范化 base URL 的 hash、再按账号 hash 隔离；私有标题、评论摘要、actor、target 和 URL 永不落盘。登录、登出与 401 是同步清空私有内存的 identity boundary；1 / 5 分钟前后台节奏、wake、退避、分页、baseline 与 toast 去重都由同一个 sync gate/loop 裁决，不由 Window、Tab 或 Space 页面另建 interval。

通知 target 进入 shared typed `AppRoute`，当前 wire 包括 `myagents://open/v1/spaces/:spaceId/issues/:issueId` 与 `myagents://open/v1/tasks/:taskId/comments/:commentId`。OS deep link 先在 Rust 严格解析并进入 latest-wins queue，App Shell 再按 route 类型创建或聚焦唯一目标 Tab 并下发 generation intent：`space.issue` 进入 Space Tab 的准确 Issue 详情，`task.comment` 进入 Task Center 的准确 Task 与评论。应用导航 scheme 与 WebView 二进制资源 scheme 分离：新资源只生成 `myagents-resource://`（Windows 为对应 localhost projection），旧 `myagents://attachment` 只在历史内容读取边界兼容，不能进入 AppRoute。

### HTTP API 调用

```
Tab apiGet/apiPost(relativePath)
  └─► sessionSidecarFetch(sessionIdHint, Tab owner)
      └─► Tauri invoke
          └─► SidecarManager 解析当前 generation 并取得 dispatch lease
              └─► reqwest ──► 当前 Session Sidecar

Global control request
  └─► globalSidecarFetch(relativePath)
      └─► Tauri invoke ──► 当前 Global generation ──► reqwest
```

普通控制请求不查询或缓存 Sidecar 端口。`cmd_get_session_port` 只服务已登记的数据面请求和少数就绪状态调用方。

### Tauri IPC

用于 Rust 与 Renderer 之间的控制请求、命令和事件：
- Session / Global 普通 HTTP 控制请求（相对路径 + 逻辑 owner，由 Rust 解析当前 generation）
- 内嵌终端事件（`terminal:data:{id}`）
- 内嵌浏览器事件（`browser:url-changed:{tabId}:{lifecycleToken}` / `browser:loading:{tabId}:{lifecycleToken}`）
- 任务状态变更（`task:status-changed`）
- 工作区文件变更（`workspace:files-changed:{eventKey}`，`eventKey` 由 `watch_start` 返回）
- 工作区文件操作（`cmd_workspace_*`，所有 `src-tauri/src/workspace_files/` 命令）
- 已登记数据面的就绪端口查询，以及已有 Session Tab 的 owner 交接确认

不走 SSE Proxy。

### Management API（Node→Rust 反向通道）

`src-tauri/src/management_api.rs` 在 app 启动时监听 `127.0.0.1:${随机端口}`（axum），直接暴露 HTTP 路由给 Node 内部工具调用。端口通过 `MYAGENTS_MANAGEMENT_PORT` 注入到 Sidecar 进程。

| 前缀 | 职责 | 调用方 |
|------|------|--------|
| `/api/cron/*` | Scheduled Task 兼容 CRUD + 调度控制 | CLI、`im-cron-tool.ts` |
| `/api/task/*` | Task Center 任务 CRUD、run/run-now/rerun、Trigger validate/test/check-now/reset-checkpoint 与 doc 读写 | CLI、`admin-api.ts` |
| `/api/document/*`（4 条） | App-owned 本地文档 conversion job submit/status/cancel/list | `admin-api.ts` 的 AnyDoc 薄转发 |
| `/api/speech/*`（4 条） | Session-scoped attachment transcription submit/status/cancel/list；caller scope 由 Sidecar process identity 注入 | `admin-api.ts` 的 Speech 薄转发 |
| `/api/record/*` | 文字 Record 的 canonical CLI create/list | CLI、`admin-api.ts` |
| `/api/mcp/remove-references` | Task 中删除 custom MCP identity 的持久引用 | `admin-api.ts` MCP remove cascade |
| `/api/app/config-changed` | 将 disk-first AppConfig 失效信号广播到所有 WebView（空 payload，不携带 secret） | `admin-api.ts` model / MCP mutation |
| `/api/runtime/sdk-child/{admit,settle}` | Rust-owned Claude SDK native child launch circuit；按 executable identity 限流 deterministic exec denial | Global / Session Sidecar 的 `createGuardedSdkQuery()` |
| `/api/mcp/startup/*` | MyAgents-owned 本地 stdio MCP 的应用级启动准入；优先级、FIFO/aging、取消、过期与 stale settlement | Session Sidecar |
| Management `/api/browser/*` | 「浏览器」Host capability、受管 Chromium resource resolution 与 Browser Identity checkpoint/CAS | Rust/Tauri；仅当前 Global/Session birth identity 可调用 |
| `/api/thought/*`（2 条） | 已发布脚本的文字 Record create/list 兼容 facade | CLI、`admin-api.ts` |
| `/api/im/*` + `/api/im-bridge/*` | IM Bot 唤醒 + 媒体下发 + Plugin Bridge 回调 | Node.js / 社区插件 Bridge |
| `/api/plugin/*`（3 条） | OpenClaw 插件 CRUD | CLI |
| `/api/agent/runtime-status`、`/api/agent/stop-channel(s)` | Agent 运行时状态查询；durable 删除/停用/归档后的精确或整组 Channel 生命周期收敛 | Node.js / 前端 |

这是项目内**唯一**的"Node → Rust"反向 HTTP 通道，规避了"Renderer / Sidecar 控制面走 Rust proxy → Node"主流向对后端间通信的不适配。所有客户端 MUST 走 `crate::local_http::builder()`（loopback，仍复用 no_proxy 保护）。

应用级资源不能由某个 Session Sidecar 的内存计数代管。Rust 的 MCP startup admission 只裁决 MyAgents-owned 本地 stdio 启动突发，不接管远端 HTTP、SDK in-process 或 `system-cli` 用户自有 MCP；10 秒 dispatch grace 从 demand 被接受时起算，包含排队时间。Global Sidecar 内的「浏览器」Host 使用 Rust 签发、绑定 Product Session 与 Host generation 的 capability，具体持有 Playwright `Browser` / `BrowserContext`；Rust 分别拥有 Host generation、Chromium resource install authorization/active revision 与 Browser Identity Store revision，不复制 Node 对象状态。

Rust 为 Global 与 Session 两类 Sidecar 都在 spawn 前分配 process-global 单调 generation，并注入不可变的进程管理 identity（`MYAGENTS_SIDECAR_ID`）；Session pending / reset / handover 只迁移可变的业务 `sessionId` key，Management API 仍以进程出生时的 `(sidecarId, generation)` 校验 caller，不能给 Global 伪造 Session identity。SDK native child 的 EPERM / EACCES / ENOEXEC circuit 归 Rust 应用进程持有：admission 携带 epoch，half-open lease 自动过期，旧 settlement 不能清除较新的 failure epoch。该 circuit 是 best-effort 重试保护而非 SDK 启动 authority：只有携带上述确定性系统错误的显式 circuit denial 可以阻止启动；identity 缺失、`invalid_request` / `stale_sidecar`、transport 异常或畸形响应只跳过 circuit，继续调用 SDK，生命周期清理由 Sidecar owner 收敛。

### 标准 Playwright 与受管「浏览器」

工具目录中存在两个独立身份，不能把它们解释成同一个工具的模式切换：

- `playwright` 是标准上游 Playwright MCP preset，继续作为普通 `npx @playwright/mcp@<locked>` stdio MCP 进入各 Runtime。仅当 `mcpServerArgs.playwright` 缺失时默认附加 `--isolated`；显式空数组和所有上游参数原样保留。MyAgents 不接管它的 Browser Host、浏览器下载、Profile 或进程语义。
- `myagents-browser`（显示名「浏览器」）是 MyAgents 受管工具。固定使用有头 Chromium，通过保留 sentinel 投影到 Global Sidecar 的认证 HTTP MCP Host；Host 使用锁定 `@playwright/mcp` 的公共 `createConnection(config, contextGetter)`，不创建另一套 MCP 协议。

受管工具只把 JS 控制代码与 App 一起发布：`@playwright/mcp`、`playwright`、`playwright-core` 保持上游 package-local CommonJS / data-file 布局进入 `Resources/node_modules`，不折叠进 ESM `server-dist.js`。Chromium、Chromium Headless Shell 与 FFmpeg 不进入 App bundle、installer 或 updater。`src/shared/managed-browser-runtime.json` 是随 App 签名发布的 required runtime set 与各平台官方 artifact 计划：它锁定 Playwright 官方来源解析出的最终 Chrome for Testing / Playwright CDN URL、archive size、SHA-256、归档根和 executable path。Rust App owner 从未安装时只在用户点击“安装资源”后直连该锁定官方 artifact，完成摘要校验、安全解压与原子安装；读取状态不访问网络。首次成功形成 install authorization，后续 App revision 变化自动维护且最多重试两次；没有用户卸载入口。Browser Host 只能消费 Rust 投影的精确 executable path，不回退系统 Chrome、用户 Playwright cache、`npx playwright install` 或 App resources。

- 一个 App Browser generation 共享一个 Chromium Browser process；每个 Product Session 一个隔离 `BrowserContext` 和原生窗口，同一 Context 的 Pages 是 Tabs。不存在 persistent/user-data-dir/Profile lease 模式。
- Context 从 Rust-owned Browser Identity revision 初始化，Host 仅通过 `addCookies()` / `cookies()` 恢复和保存 Cookie，并在成功工具调用后防抖保存、在 close/teardown/shutdown 前强制保存；禁止对 headed Context 使用 Playwright `storageState()`，因为它会用用户可见的临时页面遍历历史 Web Storage origin。并发 checkpoint 通过 revision + key-level CAS 合并；旧版本留下的 localStorage / IndexedDB origin 只作兼容读取并在后续 checkpoint 清理，不再恢复。Browser Identity 只拥有持久化结果，不拥有 Context 生杀权：destructive close 前的 checkpoint 保持有界重试和结构化诊断，但 checkpoint-only failure 不得阻止 exact Context 退休；只有真实 Context close failure 才保留 entry 并触发既有精确 release retry。
- Runtime/transport replacement 在有界 reattach 窗口内仍以 Product Session identity 找回原 Context；Host generation 改变会关闭旧 generation 的新准入并使迟到回调失效。Renderer 只读 Runtime-neutral effective MCP snapshot，不从配置勾选数推断已连接工具。
- `config.mcpEnabledServers` 只表达全局可用性，因此两个固定内置 ID 可以同时启用。真正形成执行工具集的 Session、Agent 默认、Launcher 与 Task override 选择入口才互斥：选择一个会移除另一个，取消选择不改变对方；最终 Session 工具集仍取全局可用集与该执行选择集的交集。自定义 MCP 不参与该规则。

---

## 模块地图

每个模块：一段简介 + 关键文件 + 跳转。

### 1. Sidecar Manager (`src-tauri/src/sidecar.rs` facade + `src-tauri/src/sidecar/*`)

Tauri State `ManagedSidecars` 管理 `HashMap<sessionId, SessionSidecar>`。Owner 释放规则保证生命周期收敛。

`src-tauri/src/sidecar.rs` 是兼容导出与少量共享常量的 facade。真实 owner 在 `src-tauri/src/sidecar/`：

| Owner module | 职责 |
|------|------|
| `manager.rs` / `types.rs` | `ManagedSidecarManager`、Session owner model、Global 运行意图、按 generation 分发请求和领取完成资格、端口分配、runtime drift 判定 |
| `session_lifecycle.rs` | Session Sidecar ensure / release / upgrade / delete lifecycle |
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
| `cmd_release_tab_session` | 在 Session lifecycle guard 下释放精确的桌面 Tab owner；全部 owner 释放后停止 Sidecar |
| `cmd_delete_session_if_unowned` | 在同一 Session lifecycle guard 内检查所有持久和临时 owner；只有不存在未授权 owner 时才删除 Node Session 数据并释放调用方提交的 Tab owner。完整删除事务见 `tech_docs/session_architecture.md` |
| `cmd_get_session_port` | 查询已就绪 Session Sidecar 的端口，仅供登记的数据面和就绪状态调用方使用 |
| `cmd_reconcile_session_tab_activation` | 已有 Session Tab ensure 后确认当前 generation 仍由该 Tab owner 持有，并释放临时 `BackgroundCompletion` 交接 owner |
| `cmd_upgrade_session_id` | exact Tab owner 的 pending→real / desktop reset 升级；旧或新 Session ID 被持久 owner 占用时拒绝改名，历史导航不得调用 |

Sidecar 的 raw HashMap rekey 是 manager 内部实现，不是通用 Session 操作。生产入口必须证明完整参与 owner 集合：普通 birth/reset 只允许 exact `Tab(tabId)`；桌面“新对话并保留绑定”只允许 exact `Tab(tabId) + Agent(sessionKey)`；Runtime terminal 返回新 ID 时只允许 exact `Agent(sessionKey)`。任何额外 owner 都在 Node 改变逻辑身份前 fail closed。IM `/new` 不做 rekey：它只把 peer binding 轮换到一个 `sidecar_port=0` 的新 ID，并从旧 Session 释放目标 Agent owner，其它 owner 和旧 Sidecar identity 原地不动。
| `cmd_start_global_sidecar` | 启动 Global Sidecar |
| `cmd_stop_all_sidecars` | 显式 IPC / debug stop；不拥有应用生命周期 |

冷启动性能详见 `tech_docs/sidecar_cold_start.md`。

#### Sidecar 进程角色与 MCP OAuth 凭据所有者

Rust 启动 Node Sidecar 时必须显式传入 `--sidecar-role global|session`；`--no-pre-warm` 只控制预热，不能用于推断进程职责。Session 的两条创建路径都传入 `session`，应用级 Sidecar 传入 `global`。Global 身份只由 `GLOBAL_SIDECAR_ID` 定义：Global ID 不能带 `agent_dir`，其它 ID 必须带 `agent_dir`；创建进程前就拒绝身份与角色不一致的请求，避免绕过 manager 创建第二个 Global Sidecar。

Node 在 `sidecar-composition.ts` 统一使用该角色决定启动步骤和可访问路由。请求先分类为 `common / global / session`；未知路由或角色不匹配的路由会在解析请求体和执行业务逻辑前返回 404，测试直接覆盖这条生产路径，不维护第二份路由清单。Global 负责 Settings、Session Store、Provider/OAuth 一次性操作和应用级管理，但不运行 `initializeAgent()`、不恢复 Runtime，也不处理 Chat、Task、Goal、IM、Inbox 或当前 Runtime 配置写入。Session 负责当前 Session 的 Runtime 和 turn 接口，不运行应用级 retention 或 migration 定时任务。health、refs、Runtime 模型目录、历史 Session 读取，以及两类进程都需要的 Agent/Skill/Plugin/Admin 接口属于共享能力；其中依赖当前 Session 的 Admin 路由仍只属于 Session。

`product-session-binding.ts` 在模块加载时不创建 Session。只有 Session 初始化或 adapter 的显式 reset 才能生成并发布 `MYAGENTS_SESSION_ID`；加载共享 SDK 工具不能产生这一副作用。Browser/Vite 开发模式如需单进程提供两类接口，必须通过 `start_dev.sh --dev-union` 显式启用；这不是第三种生产角色，未提供角色时仍按 Session 处理。

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

`Tab` 是以 `view` 判别的闭合联合：generic shell 的 `TabBase` 留在 `tab-workspace/contracts.ts`，每个 feature 的准确 variant/intent 留在自己的 public `tabContract.ts`，builtin `types/tab.ts` 只聚合这些 variant 并闭合当前 edition。内置 Launcher、Chat、Settings、Capabilities、Task Center、Space、Record 只在 `src/renderer/tab-workspace/builtinComposition.ts` 这一处组成 immutable edition registry；同一 boundary 还从 module map 推导 render-binding map、配对 lifecycle composition，并注入 Launcher fallback/protection 等 edition policy。feature 的 module definition 只声明纯 shell 事实：准确 payload、renderer/lazy boundary、chrome、初始 mount、structural identity/open-reopen policy 与可选 persistence codec。`BuiltinTabSlot` 和 `TabBar` 都查询这份 registry，不再维护 page-kind fallback 或第二份标题分发表。这里是源码级 composition，不存在运行时 `registerTab()`、import side effect、远程 module 或前端插件 ABI。

App 内的 `useTabWorkspaceController` 是 `tabs + activeTabId + deferredMountTabIds` 的唯一 mutation boundary，并在一次 transition 中维持非空、Tab id 唯一、active 必须存在和 deferred 必须为 live Tab 子集。feature 只持有 typed open/focus/reopen/update/replace/remove/detach command 与结构化结果，不能直接写同步 state cell；controller 仍是 App-owned React state 的边界，不是独立 store。Session terminal/delete/reconcile 与 Space gate 等 authority-driven replace/remove 也经过该 controller，但不冒充用户 close，也不运行用户 close cleanup。

Live 页面依赖通过 feature-specific、reference-stable render binding 注入；Chat/Record 的副作用关闭编排则分别留在 feature lifecycle adapter。统一关闭顺序是 capture exact typed Tab → `prepareClose` → 原子 detach → `afterDetach`，adapter 只委托既有 TabProvider/Sidecar/Recording authority，不获得底层状态写权限。`tabPersistence.ts` 继续拥有 v1 wire、外部输入校验、去重、容量与 restore planning；只有显式 opt-in 的 Chat/Record module 提供纯 codec，async Session/Record validation 仍由原 feature restore admission 负责。

App Shell 同时也是 Task 创建 overlay 与 typed AppRoute 的唯一 UI owner。侧边栏、Task Center 和 Record 只提交创建/讨论意图，不各自挂第二个 modal；普通 Task 详情选择属于 Task Center 内部状态，`task.comment` typed route 则由 App 打开或聚焦 Task Center，再交给同一个详情 Drawer 消费。

Record detail 也是普通顶部 Tab，但不是 Chat Tab：同一 `recordId` 只打开一个实例，持久 Tab snapshot 只保存 `{ id, view:'record', recordId, title }`。恢复时必须先经 `RecordStore.get` 验证；Record 已删除则保留同一 Tab identity 并退回统一 Record 列表。Record Tab 不创建 Session、Sidecar、owner token，也不持久化录音 snapshot、播放进度或活动电平。

- 桌面主窗口的 renderable surface 投影由 App Shell 拥有：`useTrayEvents` 在 focus、resize、document visibility 与主动 hide 边界采样 Tauri `isVisible() && !isMinimized()`，零尺寸 resize 可先行判为 unavailable；Rust-owned 的全局快捷键 hide/show 通过 `tray::hide_main_window` / `tray::show_main_window` 在现有 Tauri event channel 同步投影同一个 surface edge，避免 WebView suspend 让异步 renderer 采样吞掉完整 hidden interval。`App` 只在 available→unavailable 时推进 presentation generation，并只把该投影交给 active Chat。focus 值仅服务通知/input attention，不拥有 Chat 滚动、窗口可见性或 geometry；仍在展示的窗口即使失焦也持续把 live 消息交给 Virtuoso，失焦/重新聚焦本身不得产生 scroll command。
- MessageList 外层 viewport 的非零 `ResizeObserver` 结果是当前 presentation generation 的 renderer readiness authority。internal inactive Tab、native minimized/hidden surface 或尚未 ready 的恢复 generation 都冻结 Virtuoso 的 data/index/height input；消息/SSE 与 TabProvider/Sidecar 生命周期继续推进。`useChatScrollController` 是唯一 continuity owner：viewport admission 从 true→false 时保存 follow 或最近可信 message anchor，从 false→true 时只执行一个受 Session/transaction identity 保护的恢复意图；未挂载 anchor 通过 Virtuoso `itemsRendered` 事件结算，禁止 focus snapshot、固定延时、RAF 猜测或把可见的 `align:start` 当最终位置。完整不变量见 [Chat 滚动与窗口呈现生命周期](./tech_docs/chat_scroll_presentation_lifecycle.md)。
- 侧栏只从既有 `ConfigProvider`、任务中心 store、Session 索引与当前 Tab 派生工作区/Session 展示；active 高亮是 projection，不持久化第二份“当前页面”。该投影保持单一持久选中面：Launcher 选择工作区时高亮工作区行，Chat 已进入具体 Session 时只高亮 Session 行，父工作区仅保留层级上下文而不同时涂底或声明 `aria-current`。工作区配置和 Session mutation 分别调用现有 Config / Task Center authority，不在侧栏另存领域状态。
- 侧栏与顶部 Title/Tab chrome 是同一 App Shell material surface：三者只读取完整 Theme 必需的 `--global-sidebar-bg`，该 Token 由每套 Theme 的 light/dark package 拥有；页面内容与卡片/弹层继续使用既有 `--paper / --paper-elevated / --paper-inset` 语义。App Shell chrome 不再依赖与内容区的分割线，常规 leading inset 为 8px，手动 rail 的 52px 预留同时容纳固定 toggle 与其后 8px 留白；Tab active/hover 复用全局 `--hover-bg`。不能为制造分区而翻转通用 Paper 层级、在组件内混色或为 Tab Chrome 复制一套局部 palette。
- 侧栏展开/rail 切换的布局槽一次提交最终宽度，不能给 `width` / `flex-basis` 加逐帧 transition 让 Chat、Browser、Terminal 等 resize-sensitive surface 连续重排。可见边界由固定展开宽度的独立 paint-only 材质层通过 `clip-path` 横向揭示/收回；右侧 Tab 标题栏与内容用一次布局后的 compositor transform 保持旧视觉中心，再与边界同节奏归位。Chat 右侧工作区复用镜像模式：面板材质横移，对话区在最终 flex 布局上从旧中心归位；内容只做 opacity/translate/clip 编排，且必须提供 `prefers-reduced-motion` 立即切换路径。
- App Shell 使用 Task Center store 的 passive projection：只按需读取已展开工作区的 Session，每个规范化工作区 key 独立持有 loading/error/retry；只有用户打开全局搜索时才触发一次完整索引加载。passive 与完整 Task Center 读取共享 generation/latest-wins 交接，完整读取开始时使旧 passive 写入失效，完整 owner 卸载时显式把当前展开需求交还 passive。任务列表、轮询与 Tauri 监听仍由真正挂载的 Task Center 生命周期拥有，不能因侧栏常驻而前移到 App mount。
- 点击已有 Session 必须回到 `App` 的统一 open-target-session planner：优先聚焦已打开 Tab，否则按既有恢复/创建路径 materialize；并发点击复用同一 in-flight guard。新建既有 Session Tab 时用 `flushSync` 经 workspace controller 把 `sidecarConfigDisposition:'pending'` 的 Tab 加入并激活，立即挂载 Chat owner 子树并由其既有 `ChatBootOverlay` 承担加载反馈，再异步 ensure/activate；业务 handler 不得直接写 controller 的同步 state cell。ensure 的锁内 `isNew` 仍是 `push/adopt` 唯一裁决。失败时只撤销该临时 Tab 并恢复仍存在的前一 active Tab，成功后不得把加载期间主动切走的用户强制拉回。
- 删除 Session 必须回到 `App` 的统一 deletion capability，因为只有 App 拥有全部 mounted Tab：同一 App-owned admission map 先互斥目标 Session 的 open/switch、fork attach、pending→real identity adoption、TabProvider recovery、mounted Tab turn submission 与 delete，实时非 Tab owner 预检通过后，再由 Rust 将运行中 turn 接管为 `BackgroundCompletion` 或权威确认 idle；只有明确 idle 才把全部匹配 Chat Tab ids 交给 Rust，由 Rust 在同一 lifecycle fence 内以 `SessionEngine.isBusy()` 复核已接纳队列、完成最终 owner 裁决、存储删除与这些 Tab owner 的释放，成功后 App 才清退 UI 与 SSE。任何拒绝都必须原样保留 mounted Tab，不建立 renderer rollback。Floating companion 使用独立 `Companion` owner；headless Inbox 的 healthy reuse 与 dead resume 都在同一 fence 内用 transient `Agent` owner 覆盖投递到 `BackgroundCompletion` 接管，不能伪装成 App 可释放的 Tab。删除专用 strict handoff 不吞 transport / activity-check 错误；运行中或状态查询不可用都保留 mounted Tab 与 transcript，并返回结构化拒绝，不能拿 renderer `isGenerating` 投影当删除许可。GlobalSidebar、搜索覆盖层、Chat 菜单和历史下拉只消费这项 capability；不得各自猜当前 Tab、直接删存储或把 UI 快照当最终 authority。
- `session start --agent` 的 fresh headless birth 复用现有 lifecycle：source 只提交已解析的 Agent/workspace 与 prompt，Rust 生成 Session/request identity 并持 transient `Agent` owner ensure 目标 workspace Sidecar；target 在写 metadata 前重新解析 Agent/Project lifecycle，并核对当前 Sidecar 的 Session/workspace。通过后按目标侧当前配置与实际 Runtime 创建 owned `prepared` snapshot，在 `SessionEngine` 的既有 dispatch guard 提交可见。明确拒绝按 request identity 回滚；dispatch ACK 后的 runtime 错误仍是已接纳 terminal，ACK 不明保留 ID 且不自动重试。Rust 只复用既有 `BackgroundCompletion` handoff，不为 fresh start 新增 durable token、恢复状态机、配置 fingerprint 或跨文件事务。成功 receipt 只证明 admission，不证明 terminal。
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

对话 Session 的系统上下文由四类来源共同组成：Runtime 原生 base/preset、MyAgents
产品级 Prompt append、Workspace 指令文件，以及按 Turn 注入的 `system-reminder`。
它们共享最终模型上下文，但 owner、权限层级和生命周期不同，不能当成一个字符串维护。

MyAgents 产品级 append 由 `buildSystemPromptAppend()` 统一组装：

| 层 | 用途 | 何时包含 |
|----|------|---------|
| **L1** 基础身份 | 告诉 AI 运行在 MyAgents 产品中 | 始终 |
| **L2** 交互方式 | 桌面客户端 / IM Bot / Agent Channel | 互斥选一 |
| **L3** 场景与产品交互 | Task / IM 心跳 / Registered Agent / 浮球 / Widget / Session 协作                   | 按需叠加 |
| **L4** CLI 能力发现 | Task / Goal / Record / IM 媒体 / Vision / 用户注册工具 | 按场景与能力开关叠加 |

当前 `InteractionScenario` 包含 desktop、im、agent-channel、cron 和 registeredAgent；
精确字段、预设片段条件矩阵、四种 Runtime 的投送方式、Workspace 指令兼容和
pre-warm 不可变语义见
[`tech_docs/system_prompt_architecture.md`](./tech_docs/system_prompt_architecture.md)。
逐轮隐藏消息的 wire/display 协议由
[`tech_docs/system_reminder_protocol.md`](./tech_docs/system_reminder_protocol.md) 单独拥有。

### 4. 自配置 CLI (`src/cli/` + `src-tauri/src/cli.rs`)

内置命令行 `myagents`，让 AI 和用户都能通过 Bash 管理应用配置与产品能力（MCP / Provider / Agent / Cron / Goal / Record / Speech / Plugin），能力与 GUI 对等。

**两个使用场景：**

| 场景 | 调用方式 | 端口来源 |
|------|---------|---------|
| AI 内部调用（主要） | SDK Bash 工具 → `myagents mcp add ...` | `MYAGENTS_PORT` 环境变量 |
| 用户终端调用 | `myagents mcp list`（兼容直接调用 `MyAgents mcp list`） | `~/.myagents/sidecar.port` 文件 |

CLI 业务 bundle 只位于当前 app。由于 SDK 子进程与用户 shell 的 PATH 不应依赖 app 内部路径，Rust 在 `~/.myagents/bin/` 投影确定性的薄启动器；launcher 回到当前 MyAgents executable，再由 Rust 直达同一安装树的 bundled Node + CLI CJS。HOME 不保存第二份 route、help 或请求体实现。

详见 `tech_docs/cli_architecture.md`。

#### App-owned 本地文档转换

`myagents anydoc` 是官方 CLI 工具，但转换状态不属于 CLI、Sidecar、Session 或 Runtime。Tauri App 内唯一的 `DocumentProcessingManager` 拥有全局有界 FIFO、30 天 job metadata、当前 Worker generation、取消、退出收敛和 artifact 发布；任意 Global / Session Sidecar 只经 Admin API → Management API 薄转发到同一个 owner。

每个 job 使用一个独立 Rust `myagents-document-worker` 进程。Manager 通过 `process_cmd::spawn_tree()` 保留精确 `ChildTree`，用有界 length-prefixed JSON 私有协议传入单次任务；Worker 只读取 Manager 已复制的私有输入，并在输出根内的隐藏 staging 目录运行 AnyDoc、pdf-inspector、PDFium 与 PP-OCRv6 Small。成功后由 Manager 校验 active `(jobId, generation)` 与输出根 identity，以私有 crash-durable publish intent + 随目录 marker 协调同卷 no-replace rename、目录 sync 和 terminal `job.json`；未知持久化结果必须保留 intent。启动恢复只能由同一个 Manager owner 完成已 durable 的 success，或清理未提交 authenticated public path 后把非终态收敛为 `interrupted`。durable terminal 不可逆；artifact 发布后由用户拥有，删除/修改只影响派生 `artifactAvailable`。公开 artifact 固定为 `<output-root>/<job-id>/document.md` 和实际引用的 `assets/`。Worker crash、取消、超时或 App 退出均不得发布 partial artifact。

ONNX Runtime CPU、PDFium、PP-OCRv6 Small 模型/字典和 Worker 按 target 随 App 资源发布。App setup 只做 manifest/target/path/regular-file/size 等浅检查；ready 后等待 10 秒，再以最低优先级、可被 Record live 让路的后台 lease 分块校验完整 hash。共享 ORT 只由 `LocalInferenceRuntimeRegistry` 校验一次，Document Manager 校验其余文档资源；后台失败阻止新的对应 admission。Worker 使用同一 manifest 在实际加载前再次完整校验并只从绝对资源路径加载。ONNX Runtime 是 App-owned 的共享本地推理资源：document 与 speech capability 必须消费同一 target artifact identity，speech bundle 只携带自身 Worker、sherpa adapter/C API 与 legal inventory，禁止复制第二份 ORT。只有 Worker 确认需要 PP-OCR 后，Document Manager 才通过 exact-generation 协议授予 `LocalComputeCoordinator` lease；Record live ASR waiter 会让当前 OCR generation cooperative cancel，将同一 Document job 清理未发布 staging 后安全重排，不改变 job ID 或错误终态。构建入口统一为 `scripts/prepare-native-inference.mjs`：target 只解析一次，顶层在同一仓库锁内先取得 document prepared bundle 的 immutable ORT descriptor，再交给 speech builder；两个 capability 各自校验并原子切换自己的 Tauri 投影，`resources/*/v1` 不参与跨 target cache 决策。运行时不联网，不依赖 GPT、API key、系统 Python/Node、GPU 或系统安装的 native runtime。详细状态机、限制、资源矩阵和排查见 [`tech_docs/document_processing.md`](./tech_docs/document_processing.md)。

#### App-owned 本地语音识别

`RecordStore` 是文字/音频 Record、录音 artifact、timeline、transcript revision、说话人 override、导出 source 与 audio Record 根目录 `content.md` 当前态文稿的持久权威，根目录为 `~/.myagents/records/`；旧 `thoughts/` 只作为一次性迁移输入。`content.md` 是可由当前 Record revision 重建的派生 artifact，只在结束保存后产生，并随最终转写、说话人/元数据/现场笔记/重点 Mark 变化原子覆盖刷新；AI 讨论只消费这一份源文件，不创建平行快照。`RecordingManager` 拥有 App-global 唯一采集槽、设备 identity、pause/resume/stop、Ogg Opus archive、异常恢复和录音期 wake lock。`SpeechRecognitionManager` 是 Record / Agent 语音 job、Worker generation、持久恢复与结果发布的 App-global owner；三者都不属于 Tab、Session 或 Sidecar。

录音控制面是 Renderer/托盘 → Tauri command；数据面在 Rust 内从一个有界 callback fan-out 先进入权威 archive，再可选进入 live analysis。采集使用平台 backend（macOS ScreenCaptureKit + `cpal` microphone、Windows WASAPI loopback + `cpal`、Linux PipeWire + `cpal`），重采样、容器与 codec 分别复用 `rubato`、`ogg` 和 bundled libopus；不得再实现第二套 DSP、媒体容器、设备 watcher 或通用队列。`myagents-media-worker` 是一次一 generation 的受管进程，私有 framed stdin/stdout 不监听端口、不下载资源、不写 Record；Manager 校验 exact `(jobId, generation)` 后才拥有发布权。

可下载模型权重由 `SpeechModelPackManager` 子模块拥有，native Worker、sherpa adapter 和共享 ONNX Runtime 仍属于随 App 发布的受信任执行层。用户安装只访问固定的第一方签名 manifest 和其中编译期锁定的 content-addressed 第一方模型/许可镜像，不接受远端路径或 inventory；上游 GitHub URL 只存在于 release-only origin lock，不进入 App 运行时。五个模型文件和五份许可文件在 private staging 中完成 regular-file、非执行权限、size、SHA-256、manifest byte identity 与 App-updater Minisign trust-root 校验，再由真实 media Worker 最小加载 ASR/VAD/diarization 后发布版本目录并原子切换 `active.json`。安装不会为历史 Record 自动创建 job；没有 transcript 的历史音频只能由详情页“开始转录”显式提交。

模型 revision 与 ONNX Runtime revision 在 workload 接纳时写入 immutable pipeline snapshot。排队执行只解析该 snapshot，不能用届时 active 设置覆盖；Worker 启动后对 exact model/native/runtime 再校验。compute admission 固定为 live > backfill > diarization > attachment/OCR/显式模型验证 > 后台资源校验，同级 FIFO；只有 live 抢占已经运行的 workload，其余优先级只选择下一个 admission。暂停不足 10 分钟保留 live 模型与 lease；到期后用现有 Yield checkpoint 卸载 exact generation，resume 由 durable spool/journal offset 冷恢复。启动只做模型 pack 浅检查，完整 hash 在 10 秒安静窗口后以最低优先级可让路执行；安装期模型最小加载仍使用显式 `SpeechModelValidation` lease。移除仅在没有非终态语音 job / active Worker 时执行，并只删除严格命名的 App-owned pack 目录。详见 [`tech_docs/recording_and_speech_recognition.md`](./tech_docs/recording_and_speech_recognition.md)。

Agent attachment transcription 只经当前 Session Sidecar 的 `myagents speech` 进入：CLI 不接受 `sessionId/workspacePath/sidecarId` scope 参数；Node 从 live Session context 取 process identity，Rust Management API 再用请求 header 的 Sidecar generation 解析 authoritative Session + Workspace。job 持久记录该 caller，status/cancel/list 都按 exact Session 过滤；其它 Session 不可枚举或操作。桌面 Record 不受这个 Agent 列表 scope 约束，继续由 App-global Record UI 管理。

Record 变更经现有 Tauri event 投影到统一 Record 列表、Record detail、托盘和 Tantivy Record index；录音中托盘只增加状态圆点与“正在录音...”入口，点击聚焦 exact Record Tab。产品 analytics 复用现有 renderer `track()` → Tauri event bridge，只发送 typed milestone、枚举和 hash，不建立第二个 endpoint、outbox、retry/store 或日志管道。

### 5. 定时任务系统

0.3.0 起，Task 是所有新定时自动化的唯一持久权威：

- `task.rs`：`tasks.jsonl`、状态机、schedule/runtime/notification schema 与原子 mutation。
- `task_application.rs`：create/link、status、delete/unlink、run/rerun 的唯一应用层 policy；Management/Tauri/Cron/Memory 只通过该 owner 进入 Task mutation。
- `task_scheduler.rs`：唯一 timer handle map + 瞬时 execution authority map（普通 queueId/cancel/session）；从 Running Task 重建，支持 wall-clock sleep、scheduled tick 与 manual `run-now`。
- `task_trigger.rs`：Activation Trigger v1 schema、command Detector harness、`trigger-state.json` durable outbox/checkpoint 与进程资源上限；Detector 只产出 `quiet | activate`，failure 是 harness 故障。
- `task_execution.rs`：Session 选择、`SidecarOwner::Task`、Task prompt 与同步执行 use case。
- `cron_task/*`：兼容 DTO、校验、delivery/run history 与旧文件只读 facade；没有 writer/scheduler/execution owner。
- `legacy_upgrade.rs`：在 Task scheduler 启动前把普通 At/Every/Cron、旧 Task projection 与 managed row 幂等迁移为 Task；Loop/开发期 Goal row 不迁移。

`Running` 表示 scheduler enabled，`currentlyExecuting` 来自瞬时 execution map。timer handle 与执行 Turn 分离；command Task 到点后先在 Rust 运行 Detector，`quiet` 不预留 Session、不 ensure Sidecar、不进入 SessionEngine，`activate` 则先原子提交 checkpoint + pending Activation Event，再申请普通 Task queue。Task row 中的 execution receipt 与终态先于 outbox 清理提交，重启可据同一 event id 只结算一次。pending event 持久化 scheduled/check-now origin：Running Task 由 scheduler 按原 origin 恢复，Stopped/Blocked 只执行 check-now 的一次性 manual recovery，绝不因此 arm timer 或改写暂停状态。Stop 撤销精确 queue authority，SessionEngine stop 确认后才释放 Task owner；执行授权、TaskStore outcome、history、UI event、delivery 与 terminal side effect 共用同一 Task-control 临界区，旧 queue 不能越过新一轮 birth。`check-now` 真实运行 Detector并提交状态，`run-now` 绕过 Detector 强制执行 AI；二者都不启用 scheduler 或移动 recurring timer，且 pending outbox 未结算时禁止 run-now 抢占投送 authority。Running Task 的 check-now activation 是真实 AI execution，照常服从 maxExecutions/AI-exit terminal 规则；Stopped/Blocked 保留原状态；detached check-now worker 结算后必须唤醒 timer loop，使终态、pending recovery 或新的 recurring anchor 立即被 scheduler owner 重读。command runtime state 不维护第二份 cleanup flag：deleted / non-command Task 行本身就是持久清理义务，切回 command 前必须先幂等删除旧 state，启动扫描负责恢复中断的物理删除。

**Node.js 层**：
- AI 统一通过 `myagents-task-automation` Skill 与 canonical `myagents task ...` CLI 使用定时、未来与条件激活能力；历史 `im-cron` MCP 已退役
- `src/server/tools/im-cron-tool.ts` 只保留 IM / Session cron context registry，不再创建 MCP server
- `myagents cron ...` 作为已发布兼容 alias 保留；新 Agent 工作流不把 Cron 或 Sensor 暴露成独立领域，所有 mutation 仍落 TaskStore
- `/cron/execute-sync` 只是为兼容历史保留的接口名，业务归属仍是 Task；`routes/scheduled-turns.ts` 只做请求校验和响应映射，`task-turn-orchestrator.ts` 与 Runtime adapter 负责实际准备和执行

Cron 兼容 facade 发布 list/mutation，不发布 `cron get`；单条详情统一使用 canonical `myagents task get <taskId>`，同样只读 TaskStore。未迁移旧行仅由显式只读 Legacy 诊断命令提供给历史面板。deleted Task 是 legacy id tombstone，不会让旧行复活。

Legacy `CronTask` 字段若为读盘兼容新增仍 MUST 带 `#[serde(default)]`，但禁止新增写盘路径。完整边界见 `tech_docs/task_center.md` 与 `tech_docs/task_provider_routing.md`。

### 6. Agent 架构 (`src-tauri/src/im/`)

```
Project (工作区)
  = path 权威 + stable agentId ──exact ID──> AgentConfig（执行默认）
    ├── enabled=true 时可开启主动能力（Heartbeat / Memory Update / Memory Evo）
    └── Channels: Telegram / Dingtalk / OpenClaw Plugin（飞书/微信/QQ 等）
```

**模板默认能力**：工作区文件模板内容与产品级 Agent 默认策略分离。Mino 文件模板由仓库内 `bundled-workspaces/mino/` 拥有，并投影为安装包只读资源；MyAgents 在 `WorkspaceTemplate.agentDefaults` 声明产品默认能力。新建 Mino project 会记录 `templateId=mino` / `templateSource=builtin`，随后 `buildAgentForProject()` 生成默认开启的 Agent（heartbeat + memory update），但不自动创建 channel。主动能力的 effective state 统一为 `agent.enabled && child.enabled`；Channel 的 effective state 独立为 `channel.enabled && setup/credentials ready && workspace 未归档`，不再读取 `agent.enabled`。模板只负责创建新工作区，复制后的用户实例不会被 App 升级覆盖，也不能在安装包资源缺失时反向充当模板。

**Agent identity 不变量**：每个 Project（含 `enabled=false` 与 hidden/internal）用 `Project.agentId → AgentConfig.id` 精确选择一个 stable Agent；`Project.path` 是 Project-backed UI、文件入口和新运行的当前 workspace authority。Memory Evo 的 managed Task 用 `Task.workspaceId → Project.agentId` 回到精确 Agent，workspace path 只作为实际执行目录，不能反向选择 Agent。`enabled` 只控制 Heartbeat、Memory Update、Memory Evo 三项主动能力，不控制 Channel、显式 addressability 或普通工作区使用。总开关是确定性的批量策略：每次开启/关闭都会把 master 与三个子开关一并设为相同值；之后仍可单独调整子开关。新 `AgentConfig` 不持久化 `workspacePath`；旧字段原样保留，只能由 compatibility raw-record adapter 在缺失/失效链接修复、历史 extra 关联或真 orphan runtime fallback 时读取。有效 ID 不因旧 path mismatch 被阻断或重绑；已有 Session 仍服从自己的 birth snapshot。

**迁移与归档不变量**：`config.json.agentChannelIndependenceMigrationV1` 是 Rust config owner 管理的一次性 completion marker。marker 缺失时在 config lock 内按迁移前的 `agent.enabled` 归一三个子开关；仅当 master 为 false 时同时关闭历史 enabled Channel，避免升级后意外上线。迁移复用配置备份与原子写，失败时 marker 不落盘且 Channel admission fail closed。迁移完成后 Channel 与 master 永久解耦。`Project.archivedAt` 是独立的 lifecycle gate：归档停止运行中的 Channel 和后台能力，但不改写 Channel desired state 或三个子开关组合；取消归档后 enabled Channel 可按自身状态恢复。

Project birth/repair 与 Agent-facing discovery 统一复用 `src/shared/agentWorkspaceIdentity.ts` 的 pure policy，并在既有 `agent-config-intent.lock` 下先提交 `Project.agentId`、再以同一 ID 幂等补建 pathless Agent；中断后复用 stale ID，不建立 repair journal 或跨文件补偿事务。重复 Project workspace、重复 Agent ID 仍是硬冲突；多个历史 Agent 命中同 workspace 时按持久化顺序只为缺失链接选择第一个，不覆盖有效链接。一个 Agent 被多个 Project 显式 claim 时只隔离相关目标，健康 Project 继续工作。历史 extra/orphan Agent 继续按 exact ID discovery/config/start，只有 exact `Project.agentId` claim 才能代表 Project 做 archive/unarchive/remove；`agent list` 只把 Project 选中的 Agent 标为 `isCurrent`。

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

Bridge lifecycle 也持有与 Sidecar 相同的 birth-time process-group / Job authority；显式 stop 与结构析构都沿该 authority 终止 wrapper 及其后代，不借用 Sidecar argv sweep。

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

**Context-window ingress：** 所有进入 Claude Agent SDK 的 model id 都要经过 `model-capabilities.ts` 的 suffix policy。普通 provider-aware lookup 与 live `setModel` 使用 `applyProviderContextWindowSuffix(model, providerId)`；provider 不可知的 flat 入口才用 `applyContextWindowSuffix(model)`。一个持久 SDK Query 同时装配 env、主模型、alias 与 sub-agent model 时，先用 `snapshotProviderModelContextLengths` 固定本次 launch 的 provider-scoped capability，再由 `applyContextWindowSuffixForContextLength` 统一消费；只有单模型 one-shot 可以直接复用同一次 `buildClaudeSessionEnv()` 产出的 env cap。Provider scope 对裸 model id 优先读取 active provider 的 registry row；该 provider **没有对应 row** 时才 fallback flat registry，已有 row 但缺 `contextLength` 必须保持 unknown，不能借用另一 Provider 的同名值。调用方显式传入的 `[1m]` 保持不变。bridge、cron、持久化与用户可见 surface 始终保留裸 model id。

**Provider Self-Resolve：** IM 与尚未 materialize 的 backend-created Task Session 可从磁盘初始化 Provider/Model，不依赖前端 `/api/provider/set`；已有 Task Session 保留自己的配置 authority。owned builtin session 的 canonical 身份是 `providerRoute`（providerId + model），请求时再从当前配置 materialize `ProviderEnv`；旧数据解析链兼容 `providerRoute → legacy providerId/model → providerEnvJson fallback → agent/default`，不得把 apiKey/baseUrl 作为新 snapshot 身份写回。

**受管订阅凭据：** `xai-sub` 仍属于 builtin + OpenAI Responses Bridge，不是外部 Runtime。其 `ProviderEnv` 只携带非 secret 的 `credentialSource:{kind:'managed-oauth',providerId:'xai-sub'}`；Rust 应用级 `GrokAuthManager` 是 rotating refresh token 的唯一 owner。Bridge 每个上游请求都通过带 Sidecar process identity + generation 校验的 localhost Management API 解析当前 bearer，且 Rust 区分 `execution`（必须已验证）与 lineage-bound `verification` 用途；Settings 的验证作为 Global Sidecar one-shot Provider utility 执行，不创建 Product Session。401 最多强制 refresh 并重试原请求一次，403/429 不清登录态。renderer、AppConfig、session 与静态 ProviderEnv 都不得持有 bearer，受管 bearer 的目的地址必须由 server canonicalize 到官方 xAI Responses endpoint。

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
| `types.ts` | `SessionEngine` 接口：desktop send、IM enqueue、injected turn、scheduled preparation、queue、session read/config/operation 等 route-facing 能力 |
| `scheduled-turn-lock.ts`、`task-turn-orchestrator.ts`、`goal-orchestrator.ts` | Scheduled Turn 的共享串行边界与 Task/Goal 生命周期；`routes/scheduled-turns.ts` 只负责请求校验和响应映射，真实 handler/operation tests 验证 HTTP 与 owner 契约 |

`src/server/session-core/` 是 builtin / external 会话内核共享的 pure policy 层。它不拥有 SDK/CLI 进程、副作用或 SSE，只承载可单测的决策：turn result 判定、meaningful session activity/Heartbeat ack、显式 user/assistant channel-delivery owner、runtime config snapshot/source guard、desktop/turn-boundary queue admission、MCP authority/fingerprint/restart 决策，以及 MyAgents-owned MCP 的统一 soft pre-warm budget / status 分类。

`src/server/agent-session.ts` 仍是 builtin SDK 的 public facade，供 `session-engine/builtin-adapter.ts` 委托。Phase6 后，主要 mutable state 不再由 facade 顶层变量直接拥有；Phase7 后，最重的 turn terminal 与 transcript persistence 行为也有独立 owner。真实维护入口在 `src/server/builtin-session/`：

| Owner module | 职责 |
|------|------|
| `lifecycle.ts` | SDK `Query` 进程、可同步撤销的 Query identity authority、abort flag、termination + pre-dispatch rollback barrier、generator wakeup、pre-warm control readiness、Query-scoped MCP pre-warm/mutation owner、exact Query background-task registry、Session reset/switch/stale-recovery mutation barrier |
| `queue.ts` | realtime queue、mid-turn buffer、turn-boundary queue、in-flight slot、admission ticket |
| `turn.ts` | current turn usage/output/error state、SDK output-owner FIFO（每次 user-message yield 一槽，同时保存 requestId、assistant channel owner 与成功前暂存的完整文本 block）、injected turn outcome |
| `turn-lifecycle.ts` | SDK `result` / stopped / error terminal 解释、成功终态 channel-delivery commit、usage stamping、queue/IM/inbox/watch/analytics/title hook 顺序 |
| `config.ts` | MCP/agents/plugins/model/permission/provider state、deferred restart latch |
| `transcript.ts` | live messages、message sequence、SessionStore 签发的 transcript cursor、SDK UUID freshness sets |
| `transcript-persistence.ts` | SessionStore mapping、tail-only persist chain、load/cursor seeding、命名 rewind/retraction/rollback mutation |
| `types.ts` | builtin owner 间共享的结构类型 |

Builtin SDK 工具的**可见性 authority** 是 `src/server/sdk-builtin-tools.ts::SDK_BUILTIN_TOOLS`，产品会话必须通过 `Options.tools` 显式传入该目录；Provider 验证、订阅登录、标题生成、视觉识别等纯控制面 Query 必须传 `tools: []`。`Options.tools` 只决定模型能看到哪些 SDK 内置工具，不是授权规则；真正的执行许可仍由 `allowedTools` / `disallowedTools`、`canUseTool` 和 `PreToolUse` / `PermissionRequest` hooks 分层裁决。新增或移除内置工具时只修改这一可见性 owner，并分别验证权限链，不得把工具目录复制到 route 或 UI。

约束：route modules 与 `session-engine/*` 不直接 import `builtin-session/*`；它们只看 `agent-session.ts` facade。`builtin-session/*` 也不 import route 或 SessionEngine。`session-core/*` 继续保持 pure policy，不引入 SDK/SSE/文件系统副作用。`runtime-boundary.unit.test.ts` 会目录级扫描这些边界，并拦截 `agent-session.ts` 对 owner state 的 direct write 回退，以及 turn terminal / transcript persistence 行为回流到 facade；新增写入或 terminal/persist 规则应先在对应 owner 中加命名 API。

Builtin Session 的 reset、legacy internal switch 与 stale-SDK recovery 都必须进入 `lifecycle.ts::runSerializedSessionMutation()`；enqueue 在登记可取消的 admission ticket 后等待同一 barrier，再读取 metadata 或 dispatch。不得让两个 identity mutation 并行清理 Query / transcript，也不得让用户消息越过进行中的 mutation 发给旧 runtime。

Builtin `Query` 启动时由 `lifecycle.ts` 绑定 launch Product Session id 与 expected SDK Session id；abort 或 Query replacement 必须先同步 revoke 该 authority、清除该 Query 的 buffered control state。旧 Query 的后续 streamed event（包括 retraction/result）全部只可丢弃。streamed / pre-warm buffered `system_init` 只有在 authority 仍是当前 Query、Product binding 仍属于 launch/已完成 pending adoption 的 identity、且 `session_id` 精确等于 expected SDK id 时，才可更新 metadata 或执行 `pending-* → SDK UUID` adoption；adoption 在持有 transcript/index locks 的 commit point 再检查同一 authority。legacy Product id 与 SDK id 不同、以及非 UUID Product id 启动 fresh SDK UUID 时，Product id 保持不变，只更新其 `sdkSessionId`；不得把迟到事件解释成 real→real Product identity migration。

Product Session identity 与 builtin SDK execution identity 是两个 lifecycle：前者拥有 Tab/Sidecar、JSONL、title/config 与所有产品事件 scope；后者只回答下一次 Claude SDK `query()` 应 create/resume 哪份 native transcript。两者在普通 birth 时可以相同，但 `sdkSessionId` 只是 exact SDK candidate，不是 transcript 已存在的证明。Builtin Rewind 无可用 SDK anchor、或 provider history 不兼容时，只给同一个 Product Session 持久化新的 `sdkSessionId`；禁止通过 `setCurrentProductSessionId()`、清空产品 transcript 或开启 lazy materialization 来表达执行层 fresh start。恢复时必须先 probe exact candidate：有 SDK transcript 才 `resume`，没有则用同一 candidate `sessionId` 创建，probe 异常 fail closed，不能退回 Product id 或再生成第三个 UUID。

Session transcript 的普通写入只接受 `SessionStore.loadSessionTranscript()` 签发的进程内 `TranscriptWriteCursor` 与新 tail；cursor 封装 durable file identity 和公开的 `persistedMessageCount`，Runtime 不另存 index/cache。短 live projection、stale cursor 或未知 append 结果不能触发 full rewrite；owner 必须重载 durable transcript并拒绝当前操作。rewind、retry、SDK retraction 与 admission rollback 通过 `mutateSessionTranscript()` 的命名 intent，在既有 per-Session lock 内从 durable rows 派生 target 后 temp+rename；SDK retraction 以 durable `sdkUuid` 为选择器，仅可额外删除明确传入的 open streaming tail id。legacy JSON 首次加载先原子发布 JSONL，失败保留 legacy source 并向调用方报错。Fork 只可写入空 target transcript，已有 target 一律冲突退出。Builtin Rewind 若同时更换 SDK binding，则由 `commitBuiltinConversationRewind()` 复用同一 per-Session lock 与 metadata 中 bounded `pendingConversationMutation`，只接受 source/target 两个 message count 完成崩溃恢复；Codex 对应使用 `commitCodexConversationRewind()`。这两个显式 composite command 不扩展成通用事务层。

**Builtin MCP dispatch grace 与 live capability：** `Query.initializationResult()` 与 streamed `system_init` 都不代表 MCP 已连接。初始 Query 或成功安装新 MCP map 时，`lifecycle.ts` 以 Query identity + generation + 单调 installed-map revision + runtime fingerprint 建立 owner，并记录 `startedAt + deadlineAt`；默认 dispatch grace 仍由 `session-core/mcp-prewarm-policy.ts::MCP_PREWARM_GRACE_MS` 定义（当前 10 秒）。Desktop、IM 与 Cron / Goal / Heartbeat / Memory Update 等 injected turn 全部在 `messageGenerator()` promotion 后、live mutation fence 之后消费该 owner 的**剩余**预算；首次观察即使已过 deadline 也至少做一次有界真实 status read。grace 到期只把 dispatch 标为 released，基础 AI turn 继续，不把当前 generation 永久判为无工具。用户取消仍立即取消 exact promotion；Query/map owner replacement 则 requeue 给 replacement generator，不能让旧 control response 放行旧 Query。

同一 Query generation 继续由低频 observer 读取 `mcpServerStatus()` 并发布 Runtime-neutral effective snapshot；server 可从 queued/starting 迟到变为 ready/failed/needs-auth，工具目录与 UI 由 catalog generation 更新。dispatch settlement 是 one-shot fast path，live capability observation 不是。MyAgents-owned 本地 stdio server 在真正启动前还要取得 Rust application admission；排队不会重置 10 秒 grace，名额迟到可用时仍由当前 Runtime owner 继续安装或在安全 idle boundary replacement，绝不自动重放已放行 turn。

`runInjectedTurn()` 不再拥有 MCP precheck、第二道 fence 或 408/503 MCP 映射，只保留 Goal/Task 等 domain `beforeDispatch` 与真实 turn timeout。Live MCP 更新仍由同一个 Query-generation mutation owner 串行化：mutation claim 与 promotion 通过同一事件循环内的同步 owner 顺序互斥；先 promotion 就推迟重建，先 claim 就由 promotion 等待同一 promise。真实 `setMcpServers()` 失败/30 秒 mutation timeout 仍表示 transport map 不确定，必须 requeue + replacement Query；这是配置切换正确性 fence，不属于 soft startup readiness。`mcpServerStatus()` 在每次 observer tick 内单飞，observer 有固定低频间隔且随 exact owner abort，不形成 per-turn 热循环。

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
| `external-session/*` | 外部 runtime owner modules：lifecycle、runtime config、operation queue、turn lifecycle、content blocks、transcript persistence、interactive requests；`extensions.ts` 额外拥有 Managed Codex 的 Session-local MCP/Plugin 选择、desired/effective generation 与 replacement latch |
| `managed-codex/extensions/*` | `runtimeSource:'managed-provider'` 的 Product Extension compiler 与 runtime-neutral Host tool dispatcher；把 MyAgents 权威配置投影成 Codex 原生 Skill/Agent/MCP/dynamic-tool 能力，不持久化第二份产品状态 |

`external-session.ts` 不再是 external runtime 的 state owner。真实 mutable state 归 `src/server/runtimes/external-session/`：

| Owner module | 职责 |
|------|------|
| `lifecycle.ts` | active runtime/process、starting guard、session binding、prewarm/system-init、user-stop flag |
| `runtime-config.ts` | desired/live model、permission、reasoning effort state；snapshot/source guard integration |
| `operation-queue.ts` | turn-boundary message/config FIFO（Desktop + busy IM）、drain reservation、generation-based stale dispatch rejection、direct-send tail admission/reset、force/cancel/status bookkeeping |
| `turn-lifecycle.ts` | turn completed/success、finalization gate、turn start time、usage/context usage state；`turn_complete` / `session_complete` terminal plan 分类；显式 channel-delivery admission、成功终态 commit 与 user-before-assistant delivery tail |
| `content-blocks.ts` | streaming text/thinking/tool/subagent content state、父级 `CollabAgent` lifecycle 单调投影、tool result/attachment mutation、live/turn snapshot backing state |
| `transcript-persistence.ts` | in-memory session messages、SessionStore transcript cursor、persisted runtime usage totals、tail append、命名 retry/removal mutation、last assistant read、metadata preview/context update |
| `interactive.ts` | permission/AskUserQuestion pending state、active IM request id、IM registry cleanup、inbox/watch reply metadata与错误推送；permission response 成功 delivery 后才 consume pending state |

Codex 对话回溯与分支仍走现有 `/chat/rewind`、`/sessions/fork` → `SessionEngine` → external adapter 路径，不建立 Codex 专用 route 或第二套 Session。`codex.ts` 独占 `thread/read(includeTurns:true)`、`thread/fork(lastTurnId)`、`thread/unsubscribe` 与 root `turn/start` admission；`external-session.ts` 在既有 operation serialization 边界内编排 native branch、进程切换和产品 Session；`SessionStore` 独占 transcript/metadata 的可恢复提交。成功 root terminal assistant 才持久化 `{turnId, rootUserMessageId}` 锚点。Rewind 只改变对话上下文，不恢复工作区文件；有 replacement native thread 时在 durable rebind 和 mutation lease 释放后异步复用既有 prewarm，失败只影响下一次 send 的启动延迟；第一 native Turn 之前继续用“无 runtimeSessionId”表示，不预热空 thread，下一次发送复用既有 fresh-start。Claude Code / Gemini 继续明确不支持该能力。

Managed Codex 的产品扩展也必须沿同一条链路进入：route 只调用 `SessionEngine` config 方法，external adapter 交给 `external-session` 从服务端权威配置编译一份 immutable Session Extension Snapshot，并在 idle/terminal 边界 replacement process。Codex 进程启动且 MCP startup barrier 完成 terminal/timeout 观察后，desired revision 提升为该 process generation 的 effective revision；单个 Skill、MCP、Agent 或 Plugin 的失败只降级对应组件并进入 Logs，不阻断 Runtime generation。Codex adapter 只拥有 app-server 协议投影；外部 MCP 使用启动配置，Agent 使用原生 role config，合并后的有效 Workspace/全局/Plugin Skill 通过临时 extra-root 精确投影，SDK in-process MCP 与 IM Bridge 通过 runtime-neutral Host dispatcher 暴露为 `thread/start.dynamicTools`。期望下载版本只属于后台更新与发布 conformance；当前 process generation 必须采用安装器已验证并原子发布的有效 Runtime identity，不得因它暂时落后于下载目标而拒绝启动。Codex 0.149.0 仍在 native thread birth 固定 dynamic-tool 可见目录，resume 不提供替换目录的字段；Product Session 不持久化协议版本或 Host catalog fingerprint，也不因目录变化拒绝历史 Session。恢复时始终挂载当前 Host dispatcher：线程出生时已知且语义稳定的工具按当前 descriptor、schema、权限与 generation 执行，已移除、未知或参数无效只失败当前调用；新增工具在下一条新 native thread 可见。不能偷偷恢复旧目录或建立第二套 bridge。`system-cli` Codex 不进入这套 MyAgents-owned 投影。

Managed Codex 子 Agent 的原生 child turn lifecycle 只由 `codex.ts` 在既有 turn-local ancestry / activity correlation 内归一；`external-session/content-blocks.ts` 拥有父级 `CollabAgent` 的单调内容投影、成功 turn 持久化和 root terminal fail-closed 收口。状态沿现有 `UnifiedEvent → session SSE → Renderer` 控制面传递，Renderer 只派生工具卡、Agent Status Panel 与 Companion 展示，不维护 thread registry、轮询器或第二份执行 authority。没有真实 child turn 的 control-only activity 不获得 lifecycle；builtin `Task` / `Agent` 继续走 SDK 自有状态。

全局 Skill 的 Runtime authority 是 Node `global-skill-inventory.ts` 在每个 admission / Settings 业务边界构造的 immutable、ephemeral 完整根快照；不持久化注册表、cache 或 watcher 状态。同一边界的 project capability resolver 与 `.claude/skills` 兼容投影必须消费同一个快照：强证据损坏项既不进入 builtin allowlist / Managed Codex compiler，也不进入新建 workspace 链接，但任何单个 Skill 的缺失、损坏或投影失败都只淘汰该候选并记录日志，不能阻断 Runtime 或 Session。Project Skill（包括项目目录 symlink）按 canonical name 覆盖 global；MyAgents 只维护指向 `~/.myagents/skills` 的兼容 junction/symlink，不覆盖项目条目。Builtin/Managed 可在投影失败时从本次 admission 精确排除受影响 canonical；Managed 的临时 Skill/Agent materialization 与原生 read-back 同样逐候选降级，依赖 Required Skill 的 operation 只按当前 process 的 native read-back 决定是否执行。System Codex、Claude Code 等兼容 Runtime 直接扫描共享磁盘，若 OS 拒绝删除既有链接则只记录物理歧义并继续，不为这个极端状态新增进程协议或阻断 Session。Rust Launcher 只镜像同一份分类契约并跳过这种 project 投影，跨语言 JSON fixtures 负责锁定口径，而不是新增 RPC。已有 active turn 不 retroactive 改写；effective revision 继续表达 Runtime winner 内容，integrity revision 表达诊断与 desired-link set。纯诊断变化不换代；external lifecycle 随 active process 保存启动时采用的 effective capability/projection revision，后续 admission 发现 revision 变化才复用既有 deferred process/Query replacement，不能以“当前 Sidecar 是否实际写了链接”代替进程配置 identity。

**门控链路：** Rust `sidecar/runtime_identity.rs` 读取 `config.multiAgentRuntime` + `agent.runtime`，`sidecar/session_lifecycle.rs` / `sidecar/instances.rs` 在 spawn Sidecar 时注入 `MYAGENTS_RUNTIME` 环境变量 → Node.js `factory.ts` 读取 → `session-engine/selector.ts` 通过 `shouldUseExternalRuntime()` 选择 builtin/external `SessionEngine`。前端 `Chat.tsx` 用同样门控决定 `currentRuntime`。

新增“config 同步 / 注入 user 消息 / 等待 turn 完成 / session read / session operation”的 Sidecar endpoint 时，MUST 走 `SessionEngine` facade；不要在 route handler 里直接手写 builtin/external 分流。Phase5 已迁移的代表路径包括 `/api/session-state`、`/api/session-latest-result`、`/chat/stream`、`GET /sessions/:id`、`/chat/rewind`、`/sessions/fork`、proof-bearing `/api/session/surface-migration`、`/api/mcp/set`、`/api/agents/set`、`/api/provider/set`、`/api/session/config`。IM `/new` 只在 Rust owner/binding authority 内轮换，不调用 Node reset endpoint。`/chat/external-retry` 等只适用于 external Runtime 的操作由 `selector.ts` 的显式 helper 校验后调用原生实现，不进入公共 `SessionEngine` 接口，也不允许 route 直接 import `external-session.ts`。

**测试防线：** server 测试必须显式后缀分层：`*.unit.test.ts`（pure policy / parser / boundary）、`*.integration.test.ts`（credential-free stateful server 集成，singleFork）、`*.credentialed.test.ts`（真实 Provider / SDK / upstream smoke，显式本地跑）。`unit` / `integration` 都加载 `src/test/setup-no-egress.ts`，阻断 fetch / undici / http(s) / net / tls / dns 非 loopback 出站；`npm run test:classification` 用实际 Vitest project list 扫描并禁止裸 `src/server/**/*.test.ts`。External runtime 的回归主路径通过 `external-session-mock.integration.test.ts` 在测试层 mock `runtimes/factory.ts`，fake runtime 伪装为真实 `RuntimeType`（如 `codex`），穿过 `SessionEngine` 覆盖正常 turn、failed turn、queue、permission response，不在生产代码里增加 mock runtime 类型。

详见 `tech_docs/multi_agent_runtime.md`。

### 10. 既有 Session 打开与持久历史恢复

| 场景 | 唯一行为 |
|------|----------|
| 目标 Session 已在活跃 Tab | 跳转到该 Tab，不重复创建 Sidecar 或恢复投影 |
| 目标 Tab 存在但 Sidecar 不活跃 | 复用该 Tab，由 Rust lifecycle revive 目标 Sidecar |
| 目标 Session 尚无 Tab | 新建从首帧即绑定目标 Session 的 Tab，再 ensure 目标 Sidecar |

**导航 owner**：Global Sidebar、Search Overlay、Session-targeting 通知 / Task execution 链接与开发者模式 Chat History 都必须进入 `App.handleOpenTargetSession()`，由 `planSessionOpen()` 只决定 open / jump；`space.issue`、`task.comment` 等 feature AppRoute 则由 `App.handleOpenAppRoute()` 分发到对应页面，不创建或恢复 Session。目标 Session Tab 的 live create / reuse 统一进入 App 的 existing-Session materialization，并由 `reconcileExistingSessionTabOwner()` 取得 exact Tab owner。顶部“恢复上次对话”是同一能力的批量入口：候选先按既有恢复校验过滤，再一次提交最终 live Chat Tabs 与 active correlation；所有 surviving Tab 从首帧挂载正常 `TabProvider`，并各自独立进入同一个 materialization / reconcile，单目标失败只回收该 Tab。这里“正常 `TabProvider`”只承诺 Session identity、SSE、history lifecycle 与 exact owner 立即成立，不要求一次同步提交挂载全部重型 `Chat` 子树：批量恢复先绘制 provider-owned `ChatBootOverlay`，随后只 reveal active Chat；未访问的 inactive Chat 在首次选中并完成轻量帧后 reveal，已 reveal 的 Chat 继续保持挂载。不得恢复一排尚无 owner、依赖首次切换才打开的 placeholder Tab，也不得复制 Sidecar owner、port 或 workspace 状态。Chat 与 `TabProvider` 不得自行把当前真实 Session A hot-swap 为 B；历史恢复也不得修改 Node runtime binding。旧 `POST /sessions/switch` 与 `SessionEngine.switchToExistingSession` 已删除。新对话、pending→real、desktop reset 与已确认 surface migration 继续走各自既有 identity handover，不属于历史导航。

**Sidecar owner**：目标 Tab 的 Session identity 在 mount 前已经确定；App 的 `reconcileExistingSessionTabOwner()` 串起 exact Tab owner 的 ensure 与废弃请求清理。Rust manager 在同一把锁内确认当前 generation 仍包含该 Tab owner，并释放临时 `BackgroundCompletion` 交接 owner；并发 Task owner 不受影响。pending→real adoption 按 Tab 串行，Rust 只接受 exact Tab owner 的 source 或已迁移 target。配置 push / adopt 只服从锁内返回的 `result.isNew`。

**首屏历史 owner**：`TabProvider` 的 persisted restore lifecycle（`inactive / restoring / ready / failed`）独占可见性裁决；`liveRevisionFence` 只是该 lifecycle 下属的事件连续性机制，不是第二个 UI owner。真实 persisted Session 在首帧同步进入 `restoring`；`GET /sessions/:id` 是持久历史唯一权威，统一 normalize 后原子提交，完成前 `cold-history` 不得进入可见 messages。`target + restoreToken + connectionGeneration` 共同拒绝 stale REST 结果；恢复失败保持目标壳并禁止发送。MessageList 不再维护第二层 session-loading fade。

**重连连续性**：同一 Sidecar 的新 transport generation 若延续已采纳 revision，直接更新 generation 并继续投影，不重新加载或闪动；revision gap / 无基线才进入同一 lifecycle 的 REST recovery。`session-sidecar:restarted` 表示新的权威进程 epoch，必须重新武装 REST restore 并重建基线，即使旧 epoch 已进入 failed；普通 revision 事件不能越过 failed 自动重试。恢复期间 buffer snapshot 后的连续事件，完成时按 `snapshotRevision` 去重并 replay；持续 gap 最多自动补一张快照，随后保持 failed，等待用户显式重试或下一次 Rust replacement epoch。

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

Chat / Tab 自己持有的 URL 预览器（Tauri Multi-Webview）。AI Markdown 链接和 HTML 文件优先在此打开。宽布局呈现在右侧分屏；窄布局或关闭分屏能力时，同一个 `BrowserPanel` 原位切换为覆盖 Chat 的全屏面板，不重新 mount，也不重建绑定 `tabId` 的原生 child Webview。

**关键设计：**
- 依赖 Tauri `"unstable"` feature（`Window::add_child()` 多 Webview API）
- **安全隔离**：`browser.json` Capability 零权限，Webview 无法访问 Tauri IPC；`on_navigation` 限制 http/https scheme
- **链接动作 owner**：Markdown、`ExternalLink`、WebSearch / WebFetch 与文件工具不各自解释点击。HTTP(S) 统一走 `useOpenWebLink()`：Chat 普通点击进入当前 Tab 的 `BrowserPanel`，Cmd/Ctrl 点击或 Chat 外 surface 才交给系统浏览器；反引号 HTTP(S) 仅做标准 URL 格式校验，不探测网络可达性。文件链接、inline path 与工具 path 统一走 `FileActionContext`：显式 Markdown file link 保留作者声明的链接样式并在动作时复核；系统推断的 inline/tool path 只有 Rust existence + safety check 为 `exists:true` 时才获得下划线和左右键动作。只有当前挂载的 inferred target 才订阅校验，按 target 去重并以最多 200 条分批；工作区 watcher 使 workspace cache 失效，workspace 外 local target 使用 30 秒临时验证租约。workspace identity / generation fence 与单 target request sequence 共同拒绝跨工作区、跨代次和乱序迟到结果，左右键动作均再次复核。目标在动作前失效时撤销资格并明确反馈，不能静默交给 OS。
- **Overlay 协调**：原生 Webview 浮于 React DOM 之上，Overlay 出现时通过 `closeLayer.hasOverlayLayer()` 自动 hide
- **呈现与关闭 owner**：全屏条件只由“Browser 是当前 active split view”派生，不能由残留 `browserUrl` 单独决定；分屏、全屏、工具栏和 Tab × 共用同一个资源清理与剩余 view handoff callback
- **代际 owner**：`tabId` 只表示 Chat Tab 产品 scope；每次 `BrowserPanel` effect lifetime 生成 required lifecycle token。Rust `BrowserManager` 必须在 native `add_child()` 前登记该 generation 的 birth intent，create / navigate / history / reload / resize / show / hide / close 与 URL/loading event 全部携带同一 token；迟到 birth、command、callback 或旧 close 只能作用于其 exact generation，不能覆盖或销毁复用同一 `tabId` 的新 WebView。普通 App/update shutdown 继续复用全局 lifecycle spawn gate，等待已准入 birth settlement 后统一 drain，不建立第二套退出状态机。
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

### 13.1 桌面宠物 (`src-tauri/src/floating_ball.rs` + `src/renderer/floating-ball/`)

`config.json.floatingBallEnabled` 是跨启动 desired state；Rust `floating_ball` 是 native surface lifecycle owner；`SidecarManager` 是 `Companion("floating-ball")` owner set authority；Renderer 只拥有 live WebView 内的派生视觉与调度。focus、visibility 和 companion collapse 不改写 enabled state：普通收起继续保留预热 WebView、SSE 与 Companion owner，只停止 hidden surface 的视觉调度。

**功能关闭事务：** Rust 首先关闭 exact Companion owner admission，使已在途 ensure 在 settlement 后自行释放，然后在 `SidecarManager` 同一把锁下从当前所有 Session key 移除该 exact owner（覆盖 session rotate 的短暂双持有），最后由平台 owner 销毁全部 surface。macOS 依次将 companion / shield / ball 通过 locked `tauri-nspanel` 的 `Panel::to_window()` 摘除 registry 再 `destroy()`；Windows 停止 hover / foreground poller，恢复 exact WndProc，清理 HWND / proc record，再销毁 companion / ball。所有阶段尽力执行并聚合 `stage + label` 错误；任一失败时 admission 重开且 native owner best-effort 恢复完整启用集合。

Renderer 只在上述 Rust 事务成功后才把 durable config 提交为 `false`；若写盘失败，同一 toggle 立即 best-effort 重新 enable native state。启用时反向先提交 desired `true`、再创建 surface，native 失败回滚 config。这些补偿不形成后台 retry / watchdog 或第二份状态 owner。

**渲染契约：** `PetSprite` 以显式 playback policy 将 semantic animation 与调度权分离；idle 为静态首帧，running / dragging 只在持续状态内 loop，blocked / done / error 单周期后固定末帧，settings preview 只在 hover / focus 时 loop。orb CSS 使用同一 policy class，hidden companion 禁用后代 CSS animation 并停止 activity interval；`prefers-reduced-motion` 可将任何动态 policy 降级为静态帧。

### 14. 全文搜索引擎 (`src-tauri/src/search/`)

基于 Tantivy + tantivy-jieba 的 Rust 子系统。`SearchEngine` Tauri managed state 单例，为三类查询提供全文检索：Session 历史（跨工作区）、Record 与工作区文件内容。

**仅 Tauri 可用** —— 前端通过 `invoke('cmd_search_*')` 直接调 Rust，不经 Sidecar。浏览器开发模式不提供 fallback。

**关键设计：**
- Session 索引：单一全局索引 `~/.myagents/search_index/sessions/`
- Session watcher：`notify-debouncer-full` 5s 滑动去抖观察 `~/.myagents/sessions/`，**任何**写入者的变更都自动流入索引
- Record index：`RecordStore` 的 create/update/delete 广播驱动增量 upsert；索引 title/content/tags/transcript/speaker projection，以 `record_id` 去重并限制每个 Record 只返回一个产品命中
- 读写并发：`Arc<SessionIndex>`（无外层 mutex）；正常读写共享 state 读锁，仅损坏恢复独占替换
- 中文分词：`tantivy-jieba`（~37 万词词典），字段 MUST 显式 `"chinese"` tokenizer
- Schema 版本门控：`SCHEMA_VERSION` + `.schema_version` 磁盘 marker，不一致时自动删除重建
- 工作区文件搜索结果导航：Rust 由同一 search generation 原子返回 `FolderSearchHit` + `FileSearchHit`；文件夹/文件定位、预览、命中行定位、右键菜单与回到文件树是 renderer-side 协议，复用 `DirectoryPanel` / `WorkspaceTreeViewport` / `useWorkspaceFileService`，不新增 Sidecar HTTP 或 Rust IPC

详见 `tech_docs/search_architecture.md`。

### 15. Skill 来源安装 (`src/server/skills/`)

支持从 GitHub 链接、`npx skills add` 命令、HTTPS zip、本地目录或本地 `.zip/.skill` 包，把 skill 物化安装到 `~/.myagents/skills/`（或当前工作区 `.claude/skills/`）。`owner/repo` 固定表示 GitHub；CLI 只把显式 `./` / `../` 相对路径按调用者 cwd 解析为绝对路径。

**四段流水线：**
```
url-resolver.ts      — 宽容解析 → ResolvedSkillSource
    ▼
source-loader.ts     — 远程下载或本地 no-follow 快照 → ExtractedTree
    ▼
tarball-fetcher.ts / local-tree-reader.ts — 统一安全限额与无 symlink 树
    ▼
installer.ts         — analyseTree → staging → 文件锁内复核/rename 发布/失败回滚
```

**安全限额：** 下载包与来源树总量 ≤ 50MB、单文件 ≤ 5MB、文件总数 ≤ 2000、下载超时 5 分钟；压缩包拒绝 Zip-Slip、绝对路径和 symlink，本地目录拒绝 source root / 内部 symlink 或 junction。直连压缩包必须使用 HTTPS；每个 redirect hop 都拒绝 loopback/RFC1918/link-local/IPv6 ULA，并把 fetch 钉死到已校验 DNS 结果，防 SSRF / DNS rebinding。安装永远复制为 managed root 下的普通物理目录，不保留对来源的链接。

**明确不支持：** `.tar.gz/.tgz`、GitLab、私有仓库、git SSH URL、搜索集成、市场订阅持久化、`skill update`、跨 IDE symlink 同步、npm spec 形态。来源 URL / commit 不持久化。

详见 `guides/skill_marketplace.md`。

### 16. 任务中心与 Record 列表 (`src-tauri/src/task.rs` + `src-tauri/src/record.rs` + `src/renderer/components/task-center/`)

把“文字/音频 Record → 讨论或创建 Task → 调度 → Session 执行 → 本地协作 → 审计”的工作流一等公民化。`thought` 只保留 CLI 与旧数据兼容名；新产品 surface 使用 Record。

**两个持久化 Store：**
- `RecordStore` —— `~/.myagents/records/<YYYY-MM>/<id>/`；统一文字、音频、timeline、transcript、speaker override 与 artifact
- `TaskStore` —— `~/.myagents/tasks.jsonl` + canonical `~/.myagents/tasks/<id>/task.md` + 可选 `comments.jsonl`；旧 `verify.md/progress.md/alignment.md` 仅兼容读取

**关键设计：**
- Task 状态机 + 审计链（每次状态变更原子写入 `statusHistory`）
- TaskStore 是 schedule/status/config 唯一权威；TaskScheduler 直接触发并在每次 tick 动态读取 `task.md`
- 普通 Task 的执行 prompt 永远读取完整 `task.md`，`dispatchOrigin` 只保留来源，不选择 executor Skill；旧 `verify.md` 在首次读取/编辑/执行前按字面 `# verify.md` 章节一次性并入 `task.md`
- Task Comment 先由 TaskStore 持久化，再由 TaskApplication 冻结至多一个 exact Session 并复用既有 Inbox/FIFO 接纳；首轮 Task query 真正 admission 后才追加 Session relation 并 flush pending comments
- Agent 只有显式 `myagents task comment` 才写回本地时间线；普通 assistant 输出不自动归档。Attached Task 的 Cloud Issue 与本地评论由本轮 reminder 决定回复通道，不镜像或双写
- 每个 Task 最多一个 time Activation Trigger；缺失等价 `always`。command Trigger 配置写 Task row，高频 checkpoint/health/pending event 写 `tasks/<id>/trigger-state.json`，两者都只由 TaskStore 读写
- command Detector 的合法业务结果只有 `quiet | activate`；只有 durable `activate` 才建立 Session/Sidecar/Runtime 工作，failure 在 harness 内诊断、退避或阻塞
- `TaskApplication` 统一编排 Task 的创建、状态、删除和 run/rerun；current-session Task 只在真实 Session 创建完成后才持久化，通知字段在 TaskStore 写锁内合并，成功的 run/rerun 由同一操作返回从 1 开始计数的 `attemptOrdinal`，供 GUI/CLI 上报 analytics
- Task/Session identity protection 由 per-Session lifecycle guard 串行化：任何 durable mutation（含 legacy migration）只要让 Task 进入受保护状态或新增受保护 Session binding，都与 Session 删除遵循 `lifecycle → TaskStore` 锁序；scheduler active execution 覆盖 Session id 已 claim、Sidecar `Task` owner 尚未附着的窗口，birth guard 只保留到权威 Session metadata 出现（不持满整轮），shared-session joiner 不得提前 adopt。metadata creator 由该 reservation 决定，不绑定 Sidecar `isNew`；被删除的 fixed Session 换新 UUID，不复活旧 identity
- 同一 Task 的 status、timer、execution claim 与 stop side effect 由 keyed Task-control lifecycle 串行化；stop 使用现有 `queueId` 精确停止当前 Turn。持久 `Running/Stopped` 只表达 scheduler intent，具体 Turn 以非持久 `running/stopping/stop_failed` 投影；stop 未确认时禁止 rerun。Attached Space Task 的终态不能 generic rerun，必须由新的 claim/reopen 创建新 Attached Task
- Runtime terminal 先由 TaskStore 在一笔原子提交中结算 counter/time/`lastExecution`/连续失败/可选终态，再写 `cron_runs` 审计、通知和释放 Session owner；外围 cleanup 没有 Task 状态写权限。recurring 可重试失败第 5 次才 Blocked，成功清零；永久失败、一次性任务失败或 termination 未确认立即 Blocked，manual run-now 不改 durable status
- AI 讨论路径：智能创建或 Record「AI 讨论」→ 选择工作区 → 同一个 Task discussion builder/新 Chat Tab → product-owned `myagents-task-alignment` readiness gate → 可留在 Session，也可在用户确认完整候选 `task.md` 与参数后调用通用 `task create-direct`。text Record 的可见首轮 query 使用完整当前正文；audio Record 的可见 query 以 RecordStore admission 后的唯一 `content.md` 为主，隐藏 reminder 只保留读取与 workspace scope 所需字段，并可带经 RecordStore 验证的实际音轨绝对路径供按需核听
- Record 列表统一展示 text/audio；文字 Record 可继续派发 Task，audio Record 打开单实例详情完成播放、笔记/Mark、手动补转录、说话人改名/合并/片段重分配与导出。Record 与 Task 生命周期保持独立，不把 transcription job 或录音状态塞进 Task row
- Agent comment 的本地有界 locator index 由 TaskStore 从 `comments.jsonl` 异步重建并增量维护；App 级通知投影与 Cloud source 合并排序、source-aware 已读和 typed route，但不复制评论正文 authority
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
| `path_safety` | 唯一路径解析/安全打开 chokepoint：lexical/canonical resolve、`read_workspace_file_no_follow`、`open_regular_file_no_follow`、全局 Skill 投影 mutation guard、文件名校验与 sanitize | — |
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
| `slash` | / 命令扫描（builtin + 项目 + 用户 skills；跳过 MyAgents-managed project Skill 链接，并按共享完整性契约过滤 global Skill） | `cmd_list_slash_commands` |
| `search` | 模糊文件名搜索（fuzzy_matcher，跳 node_modules / dotfiles） | `cmd_workspace_search_files_fuzzy` |
| `git_branch` | 当前 git 分支查询 | `cmd_workspace_git_branch` |
| `system_open` | 揭示在文件管理器 / 默认应用打开（`process_cmd::new` 防 Windows console flash） | `cmd_workspace_open_in_finder` / `cmd_workspace_open_with_default` / `cmd_open_path_external`（绝对路径，过 credential 黑名单） |
| `watcher` | 进程级 fs watcher 注册表（ref-counted，token-based handle） | `cmd_workspace_watch_start` / `cmd_workspace_watch_stop` |

**关键约束：**

- **路径解析**：写侧 lexical（路径可不存在），读侧 canonical（防 `evil_link → /etc/passwd` 符号链逃逸）。任意绝对路径还要 canonicalize 最近存在的 ancestor 后重跑系统/credential blacklist；Windows security identity 独立归一化 `\\?\UNC\server\share` 与 `\\?\C:`，不能复用面向 Node/cmd 的前缀剥离 helper。两套 workspace helper 命名带 "_existing_" 后缀区分。
- **symlink-safe 写**：`crud.rs::slot_occupied` / `transfer.rs::slot_occupied` 用 `fs::symlink_metadata` 不是 `Path::exists()`（断链 symlink 会被后者误报为空，CLAUDE.md v0.2.5 红线）。
- **全局 Skill 投影只读**：所有 workspace mutation command 在最终目标上调用 `reject_managed_global_skill_mutation`；链接叶子、已有后代、最近存在祖先为 managed junction 的新路径和断链都拒绝。read / reveal / copy-out 不走该 guard，Node 投影 owner 直接维护链接，无 bypass flag。
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
决定 attachments 由 sessionOwner sidecar 持有；已有 Session 的 Sidecar 创建 / revive 时通过
SessionStore 反查 attachments 重 register。跨 Sidecar fetch attachment **不支持**。

**HTTP endpoint**：`GET /api/attachment/tool/<sessionId>/<turnId>/<filename>`（CORS + Cache-Control
immutable）。第一轮查内存 `externalPathRegistry`（Codex savedPath 命中），miss 后 fallback 到
trusted root `~/.myagents/generated/tool-attachments/<sid>/<tid>/<file>`（base64/url 落盘命中）。

详见 `tech_docs/tool_attachment_pipeline.md`。

---

### 19. MyAgents Cloud Space（实验室，`src-tauri/src/space_cloud.rs` + `src-tauri/src/space_cloud/` + `src/renderer/pages/Space.tsx`）

Cloud Space 把官方/团队空间接入桌面端。0.3.0 起作为实验室能力正式随客户端发布，用户需在「设置 → 关于 → 实验室」显式开启；它不是默认稳定入口，但应作为实验室功能写入 CHANGELOG 与 GitHub Release notes。

**架构真相分工与版本：** 本仓库只维护 Desktop 客户端 owner（Rust connector、本地身份/状态、UI、CLI 与 Task/Session 执行），详细状态见 `specs/tech_docs/space_cloud.md`；Cloud Worker 的 API、鉴权、领域模型、D1/R2、一致性、quota 与运营能力由同级 `hAcKlyc/MyAgents_space` 仓库的 `specs/ARCHITECTURE.md` 维护。本地平级 checkout 路径为 `../MyAgents_space/specs/ARCHITECTURE.md`。两仓独立版本，但 0.3.2 Registered Agent execution instance 属于一次协调交付：Cloud additive migration/Worker 与 v0/v1/v2 smoke 先通过，再发布 Desktop。0.3.2 源码实现不代表 Production 已上线；实时真相仍只以两端已发布版本和 Cloud `/health` 为准。若契约变化必须同步更新两边实现、测试、文档和兼容基线。

**核心边界：**

- Space 不是 AI Runtime / Session Sidecar。云端登录、HTTP 请求、附件/Skill IO、registered-agent IssueDelivery poll/process 都由 Rust Tauri command 拥有。
- Rust 内部以 `space_cloud.rs` 为 facade 与 account/session、统一 authorized Cloud client owner；`space_cloud/{registered_agents,delivery,cli,skills,tools,attachments}.rs` 分别拥有现有领域状态与操作，`tests.rs` 承载跨模块契约。Tool 模块只负责自定义 Tool 图标的本地文件校验、归一化和 multipart transport；MCP 安装写入仍由 Renderer 的 `atomicModifyConfig` 进入 `config.json` authority。依赖只能从领域模块指向根 auth/client，且 `delivery → registered_agents`、`cli → registered_agents + attachments`；Agent mutation 后唤醒 connector、Attachment 下载的 User/Agent credential 选择由根 facade 编排，禁止 `registered_agents → delivery`、`attachments → registered_agents`、平行 HTTP/auth helper 或第二套状态。
- Renderer 只通过 `src/renderer/api/spaceCloud.ts` 调 Tauri invoke，不直连 Space 服务，也不持有 session token。
- build-time capability 由 `src-tauri/build.rs` 注入 `MYAGENTS_SPACE_*`，`cmd_space_get_capability` 只裁决构建能力与当前 build-time origin；实验室入口还受 `config.teamSpaceEnabled` 默认关闭门控。debug 构建可烘焙 `MYAGENTS_SPACE_DEV_BASE_URL`，release profile 机制性丢弃 Dev origin。
- `config.spaceEnvironment` 只在烘焙的 `production` / `dev` origin 之间二选一，Renderer 不提供自由 URL 输入。旧配置值 `staging` 仅在 debug 构建包含 Dev origin 时读取为 `dev`；新写入永远使用 `dev`，release 构建一律回落 Production。
- 本地状态 production 在 `~/.myagents/space/{session.json,registered_agents.json,delivery_log.json}`，Dev 在 `~/.myagents/space/dev/{...}`；二者不进入 SessionStore，旧 `space/staging` 不自动迁移。全局 Skill 安装仍是 `~/.myagents/skills`，不随 Space 环境切换。
- `session.json` 同时承载 redacted account context 与 tagged user credential：`authenticated` 才持有 token，Cloud 对该 user credential 返回 HTTP 401 时 Rust 在文件锁内按 opaque binding 原子改写为不含 token 的 `reauth_required`；文件不存在才表示 explicit signed out。403、429、5xx、网络与解码失败不改变认证状态，`expiresAt` 也不是本地有效性 authority。
- Rust Space HTTP boundary 是 user-session 认证终态的唯一 owner；generic JSON、typed JSON、multipart 与 raw download 共用同一结构化 response policy。Renderer `spaceStore` 只按 matching binding 派生 `reauthRequired`、清理请求/cache 并复用现有登录流，不能从错误文案、时间或组件 catch 猜测登录状态。
- Space renderer cache identity 包含服务 origin；切换 production/Dev 时即使 space slug 同为 `official` 也必须清缓存。
- 本地端点身份统一由 `~/.myagents/device_id` 表达，Rust owner 是 `src-tauri/src/device_identity.rs`。Analytics 的 `device_id` 与 Space 的 `deviceId` 消费同一个值，不再派生第二套云端 device id。
- 云端概念是 `user_devices(userId, deviceId)`，用于记录某个登录用户在某个本地端点上的设备名、平台、系统版本、客户端版本与 last seen。客户端登录/授权后会尝试 upsert；registered-agent 注册/编辑 payload 也携带这些字段供服务端落表。
- Registered Agent 是执行实例，归属于 `(ownerUserId, deviceId)`，并关联该设备上的本地 Agent 工作区；workspace 不是身份。同一 workspace 可登记多个实例，各自拥有 id/token、Instruction/revision、Subscription 集合与 Session binding。只有 `ownerUserId === current session user` 且 `deviceId === current local device_id` 的 Agent 才是当前设备可编辑/可执行的 local Agent。
- Registered Agent 执行端点使用 token-only capability：本地轮询时只带 registered-agent token，服务端由 token 映射到 user / space / device / agent 权限边界；MyAgents Desktop 用保留的 account context + 当前 device 选择本地 token，user credential 进入 `reauth_required` 不停止 exact Agent，Agent 401 也不得反向修改 user credential。
- Registered Agent delivery 处理由 Rust 长驻 connector 拥有：每个 agent 维护内存级 due time / empty streak，云端返回 transport-only v2 package 与 `poll` 提示，本地负责严格解析、Prompt 组装、clamp/jitter/错误退避、exact Session origin、inbox 注入、本地 receipt 与自动 ACK。Renderer 只能唤醒 connector，不自己 poll/process delivery，也不持有 registered-agent token。
- Space CLI 是三层薄壳：Node CLI 解析显式 slug/参数，Sidecar Admin API 补当前 project stable workspace id，Rust `SpaceCliContext` 单点拥有 User/Registered Agent token 选择与 binding fail-closed。普通 User actor 先验证 user credential，`reauth_required` 稳定返回 `SPACE_REAUTH_REQUIRED`；持久 Session origin 中 exact `spaceId + registeredAgentId` 直接使用缓存 account binding + exact Agent token，不先调用用户 `/api/me` 且绝不 fallback。workspace path/id 只做 containment/binding 校验，不能推断 actor。0.3.2 删除 Agent-facing Delivery ignore，no-op 不需要 CLI 动作；`space goal list`、`space issue --help` 与业务 leaf 继续复用既有路径。Space mutation 不实现伪 preview，出现 `--dry-run` 时由 CLI 在 HTTP 和文件 IO 前 fail closed。
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

- `themeId`：当前生效的完整 Theme 身份；production registry 的产品顺序为 MyAgents Light（`myagents-light`）、
  MyAgents Classic（canonical ID `myagents-default`）、MyAgents Classic2（`default-black`）、Sage、
  Claude（稳定内部 ID `absolutely`）、Linear、Proof、Codex、Raycast；
- `themeSelectionExplicit`：用户是否明确选过 Theme；`false` 时跟随可独立演进的产品默认
  `DEFAULT_THEME_ID`（当前为 `myagents-light`），`true` 时永久尊重 `themeId`；
- `appearanceMode`：`system | light | dark`；
- `resolvedColorScheme`：每个 Webview 此刻解析出的 `light | dark`。

`ThemeRegistry` 校验一个 Theme 同时具备 light/dark、精确 Theme root / scheme root 下的 required CSS Token、Launcher Hero 和 xterm / Monaco / Mermaid / Prism / Widget adapters；canonical default 另允许受控的 `:root, <exact-theme-root>` 合并 globals 作为 unknown-ID/pre-React fallback，可选 Theme 不得泄漏全局 selector。Preset adapter 构造与 Registry 校验复用同一个 stylesheet contract parser，按 CSS selector/declaration 语义读取实际 `?inline` 产物，不依赖开发源码的引号或空白序列化。Token 解析 Theme 内 `var(...)` 后按实际消费属性校验，Widget 值必须是 iframe 可直接消费且属性语法有效的 literal，stylesheet 与 Hero 资源禁止远程 URL。无效可选包在注册边界被拒绝且不阻断 canonical Theme，未知 ID 整套回退 default，不做逐字段拼接。组件只能 import `@/theme` 公共入口，`.dependency-cruiser.cjs::theme-consumers-public-api-only` 禁止生产 consumer 直引 concrete Theme。

Theme CSS 只拥有运行时视觉值；Tailwind 入口 `src/renderer/index.css` 用无值
`@theme inline` 把 font/radius/shadow/duration utility 编译为对 `--theme-*` 与语义
Token 的运行时引用。禁止在动态 Theme package 中放 raw `@theme`；该 CSS 不会二次经过
Tailwind，否则 utility 会静默回退 framework default。`build:web` 后的 generated-CSS 契约校验
是这条编译边界的必备护栏。

配置读取边界由 `normalizeThemeConfigRecord()` 把旧 `theme` 无损迁移为 `appearanceMode`。缺失 Theme 选择或历史自动物化的 `myagents-default` 迁为 `myagents-light + themeSelectionExplicit:false`；历史非 canonical ID 视为用户已选择，继续保留。读取只做内存归一，下一次真实的 config-lock 写入清掉 legacy 字段。Settings 仍经 `ConfigProvider.updateConfig()` 分别写 `{ themeId, themeSelectionExplicit:true }` 或 `appearanceMode`，两者不得互相覆盖。`myagents-default` 继续只承担 canonical/unknown-ID fallback，产品默认与结构兜底不得重新合并成一个概念。

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
| 关闭/切换桌面 Tab | `releaseTabSession(sessionId, tabId)`；Rust 在 Session lifecycle guard 下释放精确 Tab owner |
| 定时 Task 启动 | `TaskApplication::run*` 提交 Running 并 arm `TaskSchedulerController`；command Task 到点先运行 Rust Detector |
| Task Turn 执行/结束 | lazy `SidecarOwner::Task(taskId)`；terminal/stop/delete 取消 Turn、移除 timer、对称释放 owner |
| Detector 执行/结束 | `process_cmd::spawn_tree` 管理精确子进程树；quiet/failure 不创建 Session owner，activate 持久化后才进入普通 Task Turn |
| Memory Auto-Update | 作为隐藏 managed Task 使用 `SidecarOwner::Task(taskId)`；复用 Ready Sidecar 也先 retain，只有执行完成或进程终止已确认才由 RAII 释放，`terminationUnconfirmed` 时保留给精确 Stop |
| Goal 自动续跑 | active Goal 使用一个 one-shot continuation handle；进入 Node dispatch 前附着 `SidecarOwner::Goal(goalId)`，用户 query 最晚在 Runtime claim 时附着 |
| Goal Pause/终态 | 先提交 SessionGoal 状态，再精确 stop queue Turn；确认后才清 authority / 释放 Goal owner并广播 `goal:changed`，不确定时保留 |
| IM 消息到达 | `ensureSessionSidecar(sessionId, workspace, 'agent', sessionKey)` |
| IM Session 空闲超时 | `releaseSessionSidecar(sessionId, 'agent', sessionKey)` |
| 桌面宠物关闭 | Rust 关闭 `Companion("floating-ball")` 准入 → `SidecarManager` 全 Session exact-owner sweep → macOS / Windows 完整 native teardown → Renderer 提交 config `false` |
| 桌面录音开始 | `RecordingManager.start` 取得 App-global 唯一采集槽并创建 audio Record；不创建 Sidecar |
| 桌面录音 pause/resume/stop | 同一 Manager 串行控制 exact recording generation；stop 先提交 archive，再收敛 live Worker/backfill |
| Agent attachment 转录 | 当前 Session Sidecar → Admin API → Management API → `SpeechRecognitionManager`；scope 由进程身份注入，不新增 Sidecar owner |
| 终端打开 | `cmd_terminal_create(workspace, rows, cols, port, id)` |
| 终端关闭 / Tab 关闭 | `cmd_terminal_close(terminalId)` |
| 浏览器打开 | `cmd_browser_create(tabId, lifecycleToken, url, bounds)`；Rust 在 native birth 前登记 exact generation |
| 浏览器关闭 / Tab 关闭 | `cmd_browser_close(tabId, lifecycleToken)`；迟到 close 只退休匹配 generation |
| 任务立即执行 / 重新派发 | `TaskApplication::run*` / `cron run-now` → 直接触发 Task execution use case；不创建 CronTask |
| Task 软删除 | `TaskApplication::delete_ordinary` → `TaskStore` 写 `→ deleted` 伪状态 + 联动清理来源 Record |
| 应用退出 / 普通重启 | Rust `RunEvent::ExitRequested` 统一关闭资源创建入口，等待在途创建完成登记或释放，再通过现有进程树句柄停止 Sidecar / Plugin Bridge 并清理 IM、终端和浏览器；普通重启通过 `request_restart()` 进入同一路径 |

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
| 滚动条 | 系统 Default（服从系统显示偏好） | WebView2 Fluent Overlay（Runtime ≥ 125；旧 Runtime 原生回退） | 系统 Default |
| Shell | zsh | PowerShell / cmd | bash |
| Console window 抑制 | — | `process_cmd::new()` 注入 `CREATE_NO_WINDOW` | — |
| 系统 PATH 查找 | `system_binary::find()`（Finder 启动 PATH 缺失） | — | — |

滚动条外观与输入态属于 WebView / OS authority，不属于 Renderer Theme。`src-tauri/src/webview_policy.rs` 是原生 style 的唯一解析入口：Windows 返回 `ScrollBarStyle::FluentOverlay`，macOS / Linux 返回 `Default`；主窗口、Browser child WebView、浮球、Shield 与 Companion 的每个 builder 都必须调用该 policy，因为 WebView2 要求共享同一 data directory 的 WebView 使用相同 style。Renderer 不得用全局 `::-webkit-scrollbar`、透明 thumb、滚动计时 class 或 pointer proximity 监听复制原生行为；Theme 只通过根节点 `color-scheme` 为原生控件提供明暗语义。内容滚动、Virtuoso 虚拟化与 `scrollbar-gutter: stable` 的 classic fallback 布局保护仍由各既有 scroll container 拥有。

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

`buildClaudeSessionEnv()` 的 app-owned executable layer 优先级：`~/.myagents/bin` → `systemNodeDirs`（用户安装的 Node.js） → `bundledNodeDir` → `~/.myagents/npm-global/bin` → 其它显式目录 → 去重后的继承 PATH。这样产品保留命令 `myagents` 不会被 npm / AppData 同名脚本遮蔽；Tool Registry 对 `node` / `npm` / `bun` 等运行时名称的保留名校验继续保护既有 Node 选择策略。SDK shell env 不全局设置 `npm_config_prefix`；需要固定 npm 安装落点时使用命令级 env。

详见 `tech_docs/bundled_node.md`。

---

## 日志与排查

### Boot Banner

应用启动时输出 Rust `[boot]` 自检；每个 Session Sidecar 完成 Runtime 初始化后输出 Node `[boot]` 自检：
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
- [MyAgents 系统提示词架构](./tech_docs/system_prompt_architecture.md) — 产品 Prompt、Workspace 指令、Runtime 投送、场景片段与 `system-reminder` 边界
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
- [Recording and Speech Recognition](./tech_docs/recording_and_speech_recognition.md) — Record/Recording/Speech owner、录音状态、Worker、资源与恢复
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
- [设计系统](./DESIGN.md) — 全局视觉、组件、交互原则与功能设计索引
- [Theme System](./tech_docs/theme_system.md) — Theme/Appearance 状态、注册契约、Token/adapter owner、bootstrap 与跨窗口同步
- [React 稳定性规范](./tech_docs/react_stability_rules.md) — Context / useEffect / memo 5 条规则
- [Chat 滚动与窗口呈现生命周期](./tech_docs/chat_scroll_presentation_lifecycle.md) — native surface、container readiness、Virtuoso admission 与 continuity transaction
- [UI 国际化架构](./tech_docs/i18n_architecture.md) — `uiLanguage`、i18next resources、native tray language mirror、增加新语言流程

### CLI
- [CLI 架构](./tech_docs/cli_architecture.md) — 自配置 CLI 设计、版本门控、Admin API、PATH 注入

# MyAgents 架构总览

> 本文是项目的分层认知地图，只记录当前的 Owner、进程边界、权威数据源和主数据流。具体协议、字段、状态机、兼容读取和排障步骤由对应 `tech_docs/` 或代码维护；版本演进只进入 CHANGELOG 与发布说明。

## 项目定位

MyAgents 是基于 Tauri v2 的桌面 AI Agent 客户端。React Renderer 提供多 Tab 工作区；Rust/Tauri 拥有桌面生命周期、本地持久化与系统能力；Node.js Sidecar 承载 Claude Agent SDK 和外部 Agent Runtime。

主要产品域包括对话与 Goal、Task 自动化、Agent Channel、Record/本地语音、文档转换、MCP/Skill/Plugin、内嵌终端与浏览器，以及实验室 Cloud Space。

## 技术与进程边界

| 边界 | 当前职责 |
|------|----------|
| React 19 + TypeScript + Vite + TailwindCSS | WebView UI、Tab 内派生状态和用户交互 |
| Tauri v2 / Rust | App 生命周期、Sidecar/Worker 进程、持久化 Store、文件与系统 IO、HTTP/SSE 代理 |
| 内置 Node.js v24 | Global/Session Sidecar、Plugin Bridge、MCP Server、CLI 与随 App 运行的 Node 工具 |
| Claude Agent SDK / 外部 CLI Runtime | 具体模型会话和工具执行；只能经 SessionEngine 进入产品 Session |

正常安装中的 MyAgents 自有 Node 服务使用随 App 发布的 Node.js v24，无需用户安装系统 Node。核心服务的资源缺失回退、CLI 的严格资源定位，以及用户工具的 PATH 优先级分别由对应启动入口决定，见 [Bundled Node](./tech_docs/bundled_node.md)。SDK native binary、Codex、Claude Code、Gemini、Document Worker 和 Media Worker 都是独立进程，不共享 Node 进程内状态。

## 全景架构

```text
┌──────────────────────────────────────────────────────────────────────────────┐
│ React Renderer                                                              │
│ App Shell / Tab Workspace / Chat / Settings / Task Center / Space / Record │
└──────────────────────┬───────────────────────────────────────────────────────┘
                       │ Tauri invoke + Tauri events
┌──────────────────────▼───────────────────────────────────────────────────────┐
│ Rust/Tauri                                                                  │
│ SidecarManager · TaskStore/Scheduler · SessionGoalManager · RecordStore     │
│ Workspace IO · Search · Browser/Terminal · Cloud connector · local workers │
└──────────────┬───────────────────────┬───────────────────────┬───────────────┘
               │ HTTP/SSE proxy        │ Bridge local HTTP      │ private IPC
┌──────────────▼──────────────┐  ┌─────▼────────────────┐  ┌──▼───────────────┐
│ Node.js Sidecars            │  │ Plugin Bridge       │  │ Document/Media  │
│ Global × 1                  │  │ OpenClaw plugins    │  │ Workers         │
│ Session × active Session    │  │ independent process│  │ one workload    │
└──────────────┬──────────────┘  └──────────────────────┘  └──────────────────┘
               │ SessionEngine facade
┌──────────────▼───────────────────────────────────────────────────────────────┐
│ builtin Claude Agent SDK · Claude Code · Codex · Gemini                    │
└──────────────────────────────────────────────────────────────────────────────┘
```

应用维护一个 Global Sidecar；每个活跃 Product Session 最多有一个 Session Sidecar。Session Sidecar 可以同时被 Tab、Companion、Task、Goal、BackgroundCompletion 和 Agent 使用，只有全部 owner 释放后才停止。

## 核心抽象

### 1. Authority 按事实和生命周期划分

同一产品概念可能同时存在以下状态，它们互不替代：

| 状态 | 回答的问题 | 典型 Owner |
|------|------------|------------|
| desired state | 用户希望以后如何运行 | `config.json`、Task/Agent/Goal Store |
| birth snapshot | 本 Session 以什么身份出生 | Session metadata |
| effective runtime state | 当前 generation 实际采用什么 | SessionEngine adapter / Runtime process |
| UI projection | 当前窗口如何展示 | App、TabProvider 或 feature store |

后产生或更接近执行层的数据不会自动获得上游写权限。跨层写回必须经过对应 lifecycle owner 的现有入口；多个进程需要执行同一判断时共享 pure policy，不能各自推断。

### 2. Session、Sidecar 与 Owner

`Session : Session Sidecar = 1 : 0..1`。Sidecar 是 Session 的执行容器，不是 Tab 的私有后端；Tab 只是 owner 之一。

```rust
pub enum SidecarOwner {
    Tab(String),
    Companion(String),
    Task(String),
    Goal(String),
    BackgroundCompletion(String),
    Agent(String),
}
```

Rust `SidecarManager` 是 owner set、process generation、recovery 与 Global standing intent 的权威。进程 replacement 不改变逻辑 owner；旧 generation 的请求、事件或清理不得作用于新 generation。Global Sidecar 使用独立的 `Stopped | DesiredRunning` 意图，不通过 Session owner 集表达常驻需求。

进程停止遵循“关闭新准入 → 排空已准入请求 → 从 manager 提交移除 → 锁外释放进程对象”。Sidecar 与 Plugin Bridge 的后代进程由创建时取得的精确进程树句柄管理；全机 argv 扫描不参与普通停止与退出。

详细状态机见 [Session 架构](./tech_docs/session_architecture.md)；启动与恢复见 [Sidecar 冷启动性能](./tech_docs/sidecar_cold_start.md)。

### 3. Product Session 与 Runtime identity

Product Session 拥有产品 transcript、metadata、配置、事件 scope 和 Sidecar identity。SDK session/thread id 只标识底层 Runtime continuation，不能替代 Product Session，也不能用来表达 UI 导航。

现有 Session 打开由 App 统一规划：已打开则聚焦，未打开则创建从首帧绑定目标 Session 的 Chat Tab，再由 Rust ensure/reconcile exact Tab owner。普通历史导航不把一个真实 Session Tab hot-swap 成另一个 Session。

Builtin 与 external Runtime 的 session 操作统一经过 `src/server/session-engine/`。Route handler 只负责校验和响应映射，不直接 import Runtime 实现，也不自行分支 builtin/external。terminal 必须读取 adapter 的真实成功状态；idle 只表示没有活跃工作。

详细协议见 [Multi-Agent Runtime](./tech_docs/multi_agent_runtime.md)。

### 4. App Shell 与 Tab authority

`App` 拥有顶部 Tab workspace、active identity、持久恢复和打开/关闭规划。`Tab` 是以 `view` 判别的闭合联合；各 feature 声明准确 variant、render binding、持久 codec 与关闭 lifecycle，builtin composition 只在一个 registry 中组合。

Chat Tab 由 `TabProvider` 维护 Session projection，并使用 `useTabState()` / `useTabApi()` 提供的 Session-scoped API。Settings、Capabilities 和 Launcher 使用 Global Sidecar；Record Tab、Task Center、Space 等按各自 Rust Store 或 connector 工作，不能因复用某个组件而获得 Session owner。

Global Sidebar、搜索和通知只提交 typed navigation intent，由 App 聚焦或创建目标 Tab；它们不保存第二份“当前页面”或直接修改 Tab/Session 状态。

设计规范见 [DESIGN.md](./DESIGN.md)；Chat 呈现生命周期见 [Chat 滚动与窗口呈现](./tech_docs/chat_scroll_presentation_lifecycle.md)。

### 5. 控制面与大载荷数据面

Renderer 与 Sidecar 的普通 HTTP/SSE 控制流必须经过 Rust：

```text
Tab API / Global API
  → Tauri invoke
  → SidecarManager 按逻辑 owner 解析当前 generation
  → crate::local_http reqwest client
  → 当前 Sidecar
```

WebView 只有已登记的大载荷端点可以原生读取数据面，当前为 `/refs/:id` 与 `/attachment/*`。这些端点必须同时满足 CORS、CSP、大小限制和路径安全约束；不得把例外扩展到普通 API。

Rust SSE supervisor 绑定稳定的 `connectionKey + SidecarOwner`，每次连接前重新解析当前 process generation。REST snapshot 是持久历史与 live baseline 的权威；SSE 只按连续 revision 增量推进。新 JSON 事件必须加入 Renderer 白名单，Session-scoped 事件必须携带并校验 `sessionId`。

Node → Rust 的反向调用只经过 localhost Management API。应用级资源由 Rust owner 管理，不能交给某个 Session Sidecar 的内存计数。

### 6. 持久化 authority

| 事实 | 唯一写入权威 |
|------|--------------|
| App 配置 | `config.json`；写前锁内重读并合并，写后刷新 projection |
| Product Session metadata/transcript | SessionStore |
| Custom MCP OAuth credential | Node `mcp-oauth` state store；Global Sidecar 独占 proactive refresh scheduler，revision CAS 裁决 refresh/revoke |
| 新定时自动化 | Rust TaskStore；Cron 只是兼容 surface |
| Session Goal | SessionGoalManager |
| Record、录音与转录结果 | RecordStore / RecordingManager / SpeechRecognitionManager |
| 工作区文件 | Tauri `cmd_workspace_*` 与 `useWorkspaceFileService()` |
| Cloud 登录与 Registered Agent 本地状态 | Rust Space connector |

兼容旧格式的读取或迁移不构成第二个 writer。具体数据格式、锁序与恢复协议由各模块技术文档维护。

## 主数据流

### 对话与恢复

```text
用户输入
  → Chat Tab Session-scoped API
  → Rust generation-aware proxy
  → SessionEngine
  → builtin/external adapter
  → Runtime
  → normalized events
  → Node SSE
  → Rust SSE supervisor
  → TabProvider projection
```

Session 首屏恢复先取得 REST snapshot，再接续 revision 连续的 SSE；gap、无 baseline 或 Sidecar replacement epoch 才重新建立 snapshot fence。切换窗口可见性或 transport reconnect 不改变 Session authority。

### Task、Goal 与 Agent Channel

Task、Goal 与 Agent Channel 都复用 Product Session 和同一 Runtime queue，但拥有独立的业务状态：

- TaskStore/Scheduler 拥有 schedule、execution claim、状态与审计；Task 只在执行期持有 `SidecarOwner::Task`。
- SessionGoalManager 拥有 Goal 状态、continuation、deadline 和当前 Turn fence；Goal 不创建 Task。
- Agent/IM owner 持有 channel binding 与 delivery lifecycle；已有 Session 继续服从自己的 birth snapshot。
- BackgroundCompletion 只在前台 owner 离开而已接纳工作仍需结算时保活。

等待 Runtime idle 不能代替业务 terminal。状态提交、通知和 owner 释放必须按各自 owner 的终态协议执行。

详见 [任务中心](./tech_docs/task_center.md)、[Session 架构](./tech_docs/session_architecture.md) 和 [IM 集成](./tech_docs/im_integration_architecture.md)。

### 工作区、附件与本地计算

工作区文件 IO 属于 Rust/Tauri，不依赖 Sidecar。Runtime 产出的富媒体统一归一为 Tool Attachment 引用；用户附件、Tool Attachment 与 Record media 都通过受控资源协议投影给 WebView，二进制不进入普通控制面 JSON。

DocumentProcessingManager 和 SpeechRecognitionManager 分别拥有全局队列、Worker generation、取消与结果发布；Document/Media Worker 只执行单次计算，不拥有队列、持久化或公开 artifact。共享 ONNX Runtime 与本地计算优先级由 Rust 应用级 owner 协调。

详见 [Pit-of-Success](./tech_docs/pit_of_success.md)、[Tool Attachment](./tech_docs/tool_attachment_pipeline.md)、[文档转换](./tech_docs/document_processing.md) 和 [录音与语音识别](./tech_docs/recording_and_speech_recognition.md)。

## 模块地图

| 模块 | Owner 与边界 | 详细文档 |
|------|--------------|----------|
| Sidecar Manager | Rust；Session owner set、generation、recovery、Global intent 和请求 lease | [Session](./tech_docs/session_architecture.md)、[冷启动](./tech_docs/sidecar_cold_start.md) |
| Tab Workspace | App + feature module；Tab union、导航、恢复、关闭 lifecycle | [DESIGN](./DESIGN.md)、[Chat 呈现](./tech_docs/chat_scroll_presentation_lifecycle.md) |
| System Prompt | Node；产品 append、Workspace 指令和逐轮 reminder 分层组装 | [Prompt](./tech_docs/system_prompt_architecture.md)、[Reminder](./tech_docs/system_reminder_protocol.md) |
| SessionEngine | Node facade；builtin/external Runtime 的唯一 route-facing 入口 | [Multi-Agent Runtime](./tech_docs/multi_agent_runtime.md) |
| Builtin Session | Node；Claude Agent SDK Query、queue、turn、transcript 与配置 owner 分层 | [Session](./tech_docs/session_architecture.md) |
| External Runtime | Node；Claude Code/Codex/Gemini adapter、进程与 normalized event | [Multi-Agent Runtime](./tech_docs/multi_agent_runtime.md) |
| Provider / OpenAI Bridge | Node + Rust credential owner；Provider route materialization 与协议转换 | [第三方 Provider](./tech_docs/third_party_providers.md) |
| Custom MCP OAuth | Node state store；Global scheduler 主动刷新，Session Sidecar 观察 credential revision | [冷启动](./tech_docs/sidecar_cold_start.md) |
| CLI / Admin API | App-owned CLI bundle；Node 解析命令，Management API 进入 Rust owner | [CLI](./tech_docs/cli_architecture.md) |
| 内置小助理 | `bundled-agents/myagents_helper/` 模板 + Global Sidecar Admin API；不建立第二套业务 authority | [CLI](./tech_docs/cli_architecture.md) |
| Task Center | Rust TaskStore、TaskApplication 与 TaskScheduler | [任务中心](./tech_docs/task_center.md)、[Provider routing](./tech_docs/task_provider_routing.md) |
| Goal | Rust SessionGoalManager + Node goal orchestrator；Session 一等状态 | [Session](./tech_docs/session_architecture.md) |
| Agent / IM | Rust Agent/Channel lifecycle；Node Session 执行 | [IM 集成](./tech_docs/im_integration_architecture.md) |
| Plugin Bridge | 独立 Node 进程；OpenClaw plugin 与 SDK shim | [Plugin Bridge](./tech_docs/plugin_bridge_architecture.md) |
| Claude Plugin | Node；Claude Plugin 安装、选择与 SDK projection | [Plugin 加载](./tech_docs/plugin_loading.md) |
| Workspace IO | Rust；路径安全、文件 CRUD、watcher 与系统打开 | [Pit-of-Success](./tech_docs/pit_of_success.md) |
| Skill 安装 | Node；受限 source snapshot、staging 与原子发布 | [Skill Marketplace](./guides/skill_marketplace.md) |
| Tool Attachment | Node/Rust 数据面；统一 attachment wire、持久引用与安全读取 | [Tool Attachment](./tech_docs/tool_attachment_pipeline.md) |
| Document Processing | Rust manager + 独立 Document Worker | [文档转换](./tech_docs/document_processing.md) |
| Record / Speech | Rust RecordStore、RecordingManager、SpeechRecognitionManager + Media Worker | [录音与语音识别](./tech_docs/recording_and_speech_recognition.md) |
| Search | Rust SearchEngine；Session、Record 与工作区文件索引 | [搜索](./tech_docs/search_architecture.md) |
| Terminal / Browser | Rust native resource manager；绑定 exact Tab/resource generation | [DESIGN](./DESIGN.md)、[Pit-of-Success](./tech_docs/pit_of_success.md) |
| Floating Companion | Rust 独立窗口 + Renderer 轻量 WebView；以 `Companion` owner 复用 Product Session | [Session](./tech_docs/session_architecture.md) |
| Cloud Space | Rust connector；登录、Cloud IO、Registered Agent 与 delivery | [Cloud Space](./tech_docs/space_cloud.md)、[Delivery protocol](./tech_docs/space_issue_delivery_protocol.md) |
| Theme | Renderer app-global Theme owner；Appearance 只是明暗偏好 | [Theme](./tech_docs/theme_system.md) |
| i18n | shared locale policy + Renderer resources + Rust native mirror | [i18n](./tech_docs/i18n_architecture.md) |
| Logging / Analytics | 各业务 owner 产生有界事件；统一管道负责投影和持久化 | [日志](./tech_docs/unified_logging.md)、[埋点](./tech_docs/analytics_design.md) |

## 跨模块不变量

### 资源生命周期

- 创建者必须取得 exact resource identity 或 generation；迟到 callback、close 和 settlement 只能作用于同一代。
- 关闭或 replacement 先停止新准入，再排空已准入工作；不能在 manager 锁内等待进程、网络或阻塞文件 IO。
- Task、Goal、Agent、Tab、Browser、Terminal、Plugin Bridge 和 Worker 必须由各自 owner 对称释放；React unmount 不是后台业务终态。
- App 退出先关闭资源创建入口并等待在途 birth settlement，再按精确句柄统一收敛。

### 安全边界

- 所有 localhost Rust HTTP client 使用 `crate::local_http`，不继承系统代理。
- 文件读取和写入分别使用既有 canonical/lexical、no-follow、bounded-read 与 credential blacklist helper；不能复制路径判断。
- WebView capability 最小化；内嵌 Browser WebView 无 Tauri IPC 权限，导航仅允许 http/https。
- secret 只经显式 credential 流程传递，不进入日志、Session snapshot、Tauri event 或错误 payload；Renderer 不把它保存为独立状态源。
- 大载荷先落受控存储再传引用；外部 URL 获取必须满足协议、DNS/地址、redirect 与大小限制。

完整 helper、不变量和反例见 [Pit-of-Success](./tech_docs/pit_of_success.md)。

### 跨平台

平台差异必须收敛在 Rust policy/helper 或明确的 adapter 中；Renderer 不根据 OS 复制进程、路径、WebView 和系统 UI 规则。Windows 路径、reparse point、进程树、console 抑制和 WebView2 限制见 [Windows 平台](./tech_docs/windows_platform.md)。构建与发布以 `package.json`、`rust-toolchain.toml` 和 `specs/guides/` 为准。

### 日志与诊断

Renderer、Node 和 Rust 日志汇入本地统一日志；高频 transport delta 不重复持久化，terminal 只记录有界摘要，secret-bearing 边界只投影结构化错误。用户报告运行问题时先按本地日期读取 `~/.myagents/logs/unified-{YYYY-MM-DD}.log`。详见 [统一日志](./tech_docs/unified_logging.md)。

## Pit-of-Success 路由

`tech_docs/pit_of_success.md` 是跨模块 helper 和可执行护栏的完整索引。常见修改先按下表定位，ARCHITECTURE 不复制 helper API：

| 任务 | 先查 |
|------|------|
| localhost HTTP / SSE / spill payload | `local_http`、Tauri SSE、`maybeSpill` |
| 子进程、退出与 Windows console | `process_cmd`、`system_binary` |
| 配置与文件原子写 | config/file lock、`durable_fs`、journal |
| Workspace 路径与全局 Skill 投影 | `workspace_files`、workspace identity、system-skill gate |
| Session config snapshot | Snapshot Helpers |
| Runtime model context window | model capability helpers |
| Theme package 与 Tailwind | Theme bridge |
| 测试分层与真实网络 | test classification / no-egress |

可静态判断的边界由 ESLint、dependency-cruiser 和 Clippy 执行。遇到诊断应修复 owner 或调用路径，不得 suppress。

## 文档维护原则

- 本文只在 Owner、进程边界、权威数据源或主数据流变化时更新。
- `tech_docs/` 描述一个子系统现在如何工作；保留仍执行的兼容行为，不记录发布过程。
- 精确版本、命令清单、字段枚举和平台产物以代码、类型、测试、`package.json` 与构建脚本为准。
- PRD、issue、commit 和 CHANGELOG 解释历史动机，不能覆盖现行实现。
- 文档与代码冲突时先核对实现、测试和 git 历史，再同时修正文档图中受影响的节点。

# MyAgents — Desktop AI Agent

内置 Claude Agent SDK 与 DSH，并支持外部 Runtime 的桌面端通用 Agent 产品。开源（AGPL-3.0-only）并提供单独商业授权；使用 Conventional Commits；不得提交密钥、令牌或用户隐私数据。

## 这份自动加载文档的职责

本文件只保留每类任务都值得占用注意力的项目心智模型、决策顺序和文档路由，不收录可由代码、lint、测试、`package.json` 或局部文档直接发现的完整规则表。

权威性按用途区分：

1. **当前事实**（API、版本、脚本、文件名、可执行约束）以代码、类型、测试、lint 配置和 `package.json` 为准。
2. **Owner、边界与数据流**以 `specs/ARCHITECTURE.md` 为准。
3. **模块的不变量、事故根因和 helper 用法**以对应 `specs/tech_docs/` 为准。
4. PRD / RFC 描述目标或提案，版本历史与 issue 解释动机；均不能代替当前实现与规范。

若文档与代码冲突，不要任选一个继续：先用实现、测试和 git 历史确认现状，再修正文档。不要因为一次局部事故就把新规则追加到本文件；只有“跨任务高频、无法就近推断、违反后代价高”的知识才应常驻。

## 工作方法

1. 先判断任务影响的 owner、进程边界和权威数据源，再按下表读取**匹配的**文档；不要默认加载整个文档树。
2. 用 `rg` 搜索同类实现、调用方、测试和已有 helper，沿既有路径扩展，不为单点需求建立第二套抽象。
3. 对接外部 SDK / 插件时先核对安装版本的源码与类型定义；涉及 Claude Agent SDK 时至少检查 `node_modules/@anthropic-ai/claude-agent-sdk/sdk.d.ts`、`sdk-tools.d.ts` 和官方文档，禁止凭记忆猜接口。
4. 先修 owner / scope 的错位，再考虑 cache、guard、flag、retry、wrapper 等机制。目标是极致 UX、正确架构和更少的系统概念，而不是最小 diff。
5. 若确实需要新通信模式、新状态 owner 或新进程类型，先与用户讨论架构方案。

## 项目地图

| 区域 | 技术与职责 |
|------|------------|
| `src/renderer/` | React 19 + TypeScript + Vite + TailwindCSS；桌面 WebView UI |
| `src/server/` | Node.js v24 Sidecar；SessionEngine 与各 Runtime adapter；每 Session 独立实例 |
| `src/server/plugin-bridge/` | 独立 Node 进程；OpenClaw Plugin Bridge |
| `src/cli/` | `myagents` CLI 源码；业务 bundle 随 app 发布，`~/.myagents/bin/` 仅投影薄启动器 |
| `src/shared/` | renderer / server 共用的纯类型与逻辑 |
| `src-tauri/` | Tauri v2 Rust 壳、进程与持久化 owner、HTTP/SSE 代理 |
| `src-tauri/document-worker/` | 独立 Rust 文档转换 Worker；单 job 计算，不拥有队列或持久化 |
| `src-tauri/media-worker/`、`src-tauri/media-worker-protocol/` | 独立 Rust 音频推理 Worker 与共享 wire protocol；单 workload / generation 计算，不拥有队列或持久化 |
| `src-tauri/src/agent_network/`、`src/server/agent-network/` | 跨设备 Agent 网络客户端：Rust App 持有设备身份、连接与 TLS，Node 侧只适配进既有 Inbox / SessionEngine；公共中转/自部署属于 `MyAgents-Agenthub`，官方组合属于私有 `MyAgents_AgentNet` |
| `vendor/agent-network-protocol/`、`src-tauri/agent-network-protocol/` | 固定版本的 Agent 网络协议包及其 Rust 投影；协议源码不在本仓库，只能按 `agent_network.md` 更新 vendored 包 |
| `bundled-agents/myagents_helper/` | 内置 MA 小助理 |
| `bundled-workspaces/` | 随 App 发布的只读工作区模板源码；复制出的用户工作区不由此目录升级覆盖 |
| `specs/` | 当前架构、设计规范、模块技术文档与构建指南 |

Sidecar、Plugin Bridge、MCP Server 与 CLI 共用应用内置的单一 Node.js v24，不依赖用户系统安装的 Node。

## 必须常驻的架构心智模型

### Owner 与 authority 优先

Owner 和 source of truth 必须针对具体事实、scope 与 lifecycle phase 定义，不能针对一个笼统的产品概念定义。同一产品概念可能同时存在 desired state、Session snapshot 中固化的 execution identity、当前 generation 的 effective runtime state，以及前端派生状态；它们分别回答不同问题，不能相互替代。

后产生或更接近执行层的数据不会因此获得其他状态的写权限。跨表示的转换、比较或写回必须由对应 lifecycle owner 的既有入口裁决；多个进程或语言层需要执行同一判断时，先定义一份权威决策表，能共享 pure policy 就共享，否则用 parity tests 保证一致性。

操作归属按其读写的产品状态和生命周期确定，不按其复用的 SDK、Sidecar 或 facade 确定。修改前回答“谁创建、谁持久化、谁可以修改、谁释放、并发时谁裁决”。

### Session、Sidecar 与 Tab

- `Session : Session Sidecar = 1 : 0..1`。持久 Session 可以没有活跃进程；Tab / Companion / Task / Goal / BackgroundCompletion / Agent 通过 owner token 共享 Sidecar，全部释放后才停止进程。
- 每个 Chat Tab 独立隔离。Tab 内请求使用 `useTabState()` 提供的 `apiGet` / `apiPost`，不能误发到 Global Sidecar。
- 已有 Session 保持自己的运行时与 MCP authority。Sidecar 是否新建只由 Rust SidecarManager 锁内的 ensure 结果裁决，Renderer 不能用端口探测或缓存猜测；Tab 配置 push / adopt 与 builtin pre-warm 的细节见 Session 文档。

### 通信分为控制面和大载荷数据面

- Renderer 与 Sidecar 的控制面 HTTP / SSE 必须经 Rust：`invoke → reqwest → Sidecar`；连接 localhost 的 Rust client 使用 `crate::local_http`。
- 仅明确登记的大载荷数据面端点（当前为 `/refs/:id`、`/api/attachment/tool/*`）允许 Renderer 原生 fetch；它们必须同时满足 CORS、CSP、大小限制和路径安全约束。不要把这个例外扩展到普通 API。
- 新增 SSE JSON 事件必须同时进入 `src/renderer/api/SseConnection.ts` 的事件白名单，否则前端会静默丢弃。

### Runtime 分流只有一个入口

Builtin SDK、Integrated DSH 与 Claude Code / Codex 等外部 Runtime 的 session 操作统一经过 `src/server/session-engine/` facade，由 selector 选择 adapter。Route handler 不得自行写 builtin / external 分支；“等待 idle”也不等于 turn 成功，terminal 必须读取对应 adapter 的真实成功状态。

### 持久化 authority

- 新定时自动化以 Rust `TaskStore` 为唯一权威；Cron 只是兼容入口，旧数据只作启动迁移的只读输入。
- `config.json` 是配置写入权威。写盘前重新读取磁盘并在锁内合并，不能拿可能过期的 React state 覆盖；写盘后再刷新前端状态。
- 工作区文件 IO 属于 OS / Tauri 层，统一走 `cmd_workspace_*` 与 `useWorkspaceFileService(workspacePath)`；不要为了读写工作区启动或依赖 Sidecar。

### 可执行护栏优先于重复提示

`eslint.config.js`、`.dependency-cruiser.cjs`、`src-tauri/clippy.toml` 负责能静态判定的边界，其诊断信息应同时说明故障模式和正确路径。遇到违规应理解并修复原因，不能 suppress；完整的人类可读规范集中在 `specs/tech_docs/pit_of_success.md`，不在本文件镜像一份易漂移的表格；诊断与代码注释也应引用该 owner 文档的锚点，而不是本文件。

## 按任务加载文档

满足以下任一条件时先读 `specs/ARCHITECTURE.md`：设计 / 评估 / 规划 / 重构；跨模块或跨进程；修改 Sidecar / Session / owner / pre-warm；新增通信模式、Runtime、MCP server 或 Channel；无法判断功能应落在哪条现有路径。先读“项目定位 / 全景架构图 / 核心抽象”，再读命中的模块章节；只有真正的全系统问题才展开全文。

其余任务只读命中的模块文档和相邻代码。大文档先用目录或 `rg` 定位相关章节。

| 任务范围 | 必读文档 |
|----------|----------|
| Pit-of-Success helper、跨语言边界、测试分层 | `specs/tech_docs/pit_of_success.md` |
| Sidecar 冷启动 / pre-warm 性能 | `specs/tech_docs/sidecar_cold_start.md` |
| Session ID、状态同步、恢复、配置归置、builtin Query / pre-warm 生命周期、Inbox 与 `session start/send/watch` | `specs/tech_docs/session_architecture.md`；transcript 持久化与回放再读 `specs/tech_docs/session_transcript_v2.md` |
| 系统提示词组装、场景 Prompt、Workspace 指令注入 | `specs/tech_docs/system_prompt_architecture.md`；逐轮隐藏消息再读 `specs/tech_docs/system_reminder_protocol.md` |
| Agent Runtime | `specs/tech_docs/multi_agent_runtime.md`；Integrated DSH 再读 `specs/tech_docs/myagents_dsh_integrated_runtime.md` |
| Task / Thought / Goal / Cron provider routing | `specs/tech_docs/task_center.md`、`specs/tech_docs/task_provider_routing.md` |
| Cloud Space / Space Issue / registered agent | `specs/tech_docs/space_cloud.md`；改云 API、鉴权、数据或 quota 时再读 `../MyAgents_space/specs/ARCHITECTURE.md` |
| Space IssueDelivery / registered-agent prompt 协议 | `specs/tech_docs/space_issue_delivery_protocol.md`、`specs/tech_docs/space_cloud.md`、`specs/tech_docs/system_reminder_protocol.md` |
| 跨设备 Agent 网络、设备身份 / 连接、协议包更新 | `specs/tech_docs/agent_network.md`；同时涉及 Session 投递时再读 `specs/tech_docs/session_architecture.md` 的 Inbox 章节 |
| IM Bot / Telegram / Dingtalk / 飞书 | `specs/tech_docs/im_integration_architecture.md` |
| Plugin Bridge / OpenClaw / SDK shim | `specs/tech_docs/plugin_bridge_architecture.md` |
| Claude Plugin 加载与安装 | `specs/tech_docs/plugin_loading.md` |
| SDK 权限 hook / 自定义 Tool | `specs/tech_docs/sdk_canUseTool_guide.md`、`specs/tech_docs/sdk_custom_tools_guide.md` |
| `myagents` CLI、Admin API、内置小助理、system skill | `specs/tech_docs/cli_architecture.md` |
| 本地文档转换 / AnyDoc / OCR / Document Worker | `specs/tech_docs/document_processing.md` |
| Record / 桌面录音 / 本地 Speech / 语音模型包 / Media Worker | `specs/tech_docs/recording_and_speech_recognition.md` |
| 前端 UI、布局、交互、字号 | `specs/DESIGN.md` 的相关章节；只在主题工作时追加 `specs/tech_docs/theme_system.md` |
| React state / effect 稳定性 | `specs/tech_docs/react_stability_rules.md` |
| Tool Attachment / 富媒体 / 外部 URL | `specs/tech_docs/tool_attachment_pipeline.md` |
| 工作区文件、Markdown 编辑、预览与保存 | `specs/tech_docs/workspace_markdown_editor.md`；通用 IO / 路径安全查 `specs/tech_docs/pit_of_success.md` 对应章节 |
| 托管浏览器工具、登录保存、MCP 重连 | `specs/tech_docs/managed_browser.md`；与 UI BrowserPanel、普通 Playwright preset 区分 |
| Windows 路径、进程 / CSP / WebView | `specs/tech_docs/windows_platform.md`；按问题追加 `specs/tech_docs/windows_ai_review_traps.md` 或 `specs/tech_docs/windows_cross_platform_review.md` |
| 内置 Node / 三方 Provider / 代理 | `specs/tech_docs/bundled_node.md`、`specs/tech_docs/third_party_providers.md`、`specs/tech_docs/proxy_config.md` 中命中的文档 |
| 搜索 / i18n / 埋点 / 日志 | 对应 `specs/tech_docs/search_architecture.md`、`specs/tech_docs/i18n_architecture.md`、`specs/tech_docs/analytics_design.md`、`specs/tech_docs/unified_logging.md` |
| setup / build / 资源准备脚本（新增或修改） | `specs/tech_docs/build_resource_preparation.md`；按资源追加所属模块文档 |
| 更新 MyAgents-dsh、打包本地 handoff 并集成到客户端 | 先切换到 MyAgents-dsh 仓库，按该仓库的 Agent 指引和开发集成指南完成 setup、提交、原生 handoff 构建；再读本仓库 `specs/tech_docs/build_resource_preparation.md` 的 Integrated DSH 构建来源。本地 Dev 构建传入验证后的 handoff 绝对路径，正式构建只改 `dsh-release.json` 的版本选择 |
| 自动更新、发布 | `specs/tech_docs/auto_update.md` 与 `specs/guides/` 下对应平台文档 |

## 验证与维护

- 修改后运行与影响面匹配的最小确定性验证；命令与测试池以 `package.json`、`vitest.config.ts` 和 Rust workspace 为准。Bug 修复应新增能复现故障的回归测试；纯文档不要求代码测试。
- 默认测试不得依赖外网服务、真实密钥或真实用户目录；允许隔离的 loopback 测试服务；真实 Provider / SDK smoke 只能进入 credentialed 测试池并显式运行。
- 修改 lint / helper 时，优先把不变量固化为测试或静态检查，并在局部规范解释 WHY；只有当跨任务心智模型改变时才更新本文件。
- 用户报告运行问题时先读其提供的日志，按报告的机器与时间定位；未指定来源时读取本机对应日期日志。路径、字段与排查顺序见 `specs/tech_docs/unified_logging.md`。

## Git 与共享工作区

- 工作区可能有用户或其它 session 的未提交改动。开始与交付前检查 `git status`；只修改任务需要的文件，逐文件确认 diff，不覆盖、回滚或清理别人的改动。
- 禁止用 `git add -A`、`git add .` 或 `git add -f` 扩大提交范围；提交时显式列文件。除非用户明确要求，不把 ignored 的 `specs/prd/`、`specs/research/` 草稿纳入 Git。
- 不在 `main` 直接提交。合并、发布、打 tag 或其它外部动作需要用户明确授权。
- Commit 必须同时有 Conventional Commits subject 和解释“为什么 / 关键取舍”的非空 body，例如 `git commit -m "<subject>" -m "<reason>"`。
- Rust 工具链版本以根目录 `rust-toolchain.toml` 为唯一权威；不要用浮动工具链制造无关格式化 diff。

<!-- git-project-sync:start -->
For any task that changes this repository or resumes another agent's work, first read
`.agents/skills/git-project-sync/SKILL.md` and use `.agent-sync.json` as the
repository coordination config. Remote refs and commit SHAs define code state;
handoff prose and generated artifacts are supporting evidence only.
Require a user-supplied Git URL via `--remote` for every project-sync command;
verify it matches the config and checkout fetch/push URLs before saving work.
Read `.agent-sync/project-map.md`, `.agent-sync/plan.md`, and the current
branch record in `.agent-sync/tasks/` before continuing another agent's work.
<!-- git-project-sync:end -->

# MyAgents CLI 架构

## 概述

MyAgents 内置了一个自配置 CLI 工具（`myagents`），让 AI 和用户都能通过命令行管理应用配置。CLI 的参数解析、文件输入和输出格式位于随当前安装包发布的 `cli/myagents.cjs`；状态 authority 与业务 mutation 仍在 Sidecar Admin / Rust Management API。安装包内 bundle 是 CLI 业务代码的唯一运行时副本，用户目录只保存薄启动器。

## 设计动机

GUI 能做的配置操作（MCP 管理、Provider 配置、Agent Channel 管理、定时任务等），AI 也应该能做。传统方式是让 AI 输出操作步骤让用户去 GUI 点击，但这违背了 Agent 产品的自主性原则。CLI 让 AI 通过 Bash 工具**直接执行**管理操作，能力与 GUI 对等（部分命令如 `agent show` / `runtime describe` 甚至只在 CLI 存在，服务于 AI 的发现链路）。

Goal Mode 是 CLI 的特殊 current-session 控制能力：`myagents goal create` 与 UI `/goal` 创建同一个 session-owned Goal，`myagents goal update` 是模型把 Goal 标记为 complete / blocked 的受限出口。它不是普通 Cron command 的别名。

## 架构图

```
┌─────────────────────────────────────────────────────────────────────┐
│ 场景 1：AI 内部调用（主要用途）                                       │
│                                                                     │
│ 用户: "帮我配个 MCP"                                                 │
│   → AI Bash 工具 → `myagents mcp add --id xxx ...`                  │
│   → PATH 首先命中 ~/.myagents/bin/myagents 薄启动器                  │
│   → 当前 MyAgents executable + private marker                       │
│   → 当前 bundle Node 执行当前 bundle cli/myagents.cjs               │
│   → fetch(127.0.0.1:${MYAGENTS_PORT}/api/admin/mcp/add)             │
│   → Admin API 写 config → SSE 广播 → 前端同步                        │
└─────────────────────────────────────────────────────────────────────┘

┌─────────────────────────────────────────────────────────────────────┐
│ 场景 2：用户终端调用（次要用途）                                       │
│                                                                     │
│ 终端: `MyAgents mcp list` 或 `myagents mcp list`                    │
│   → direct app-binary group 或 launcher private marker 进入 CLI mode │
│   → 不启动 GUI / 不杀 sidecar / 不触发单实例焦点                      │
│   → 定位当前安装树中的 bundled Node + cli/myagents.cjs               │
│   → 无继承 Session 端口时才读 sidecar.port 补 Global 端口            │
│   → 注入 MYAGENTS_PORT → 转发到 Admin API                            │
└─────────────────────────────────────────────────────────────────────┘
```

## 组件分层

| 层 | 文件 | 职责 |
|----|------|------|
| **Rust CLI / launcher owner** | `src-tauri/src/cli.rs` | CLI 分流、bundle locator、薄启动器原子收敛、端口补全、spawn 子进程 |
| **CLI 脚本** | `src/cli/myagents.ts` | 参数解析、命令路由、HTTP 调用、输出格式化（含 `recoveryHint` 渲染） |
| **启动 / admission** | `src-tauri/src/lib.rs`、`src-tauri/src/sidecar/{instances,session_lifecycle}.rs` | app 启动预检；Global / legacy 与 Session lifecycle admission 复用同一个 reconciler |
| **Admin API** | `src/server/admin-api.ts` | 业务逻辑：验证 → 写 config → 更新内存状态 → SSE 广播；含跨 runtime 发现 handler |
| **PATH 注入** | `src/server/utils/session-executable-path.ts`、`src/server/utils/shell.ts`、`src-tauri/src/terminal.rs` | 在 app-owned Runtime / probe / 内嵌终端中让官方 bin 先于 npm / AppData / inherited PATH |

## 文件布局

```
源码 / 安装包 authority                    用户目录投影
──────────────────────                    ──────────────
src/cli/myagents.ts                        ~/.myagents/
  → esbuild                               ├── bin/
  → resources/cli/myagents.cjs            │   ├── myagents      (POSIX/Git Bash 薄启动器)
                                           │   └── myagents.cmd  (cmd/PowerShell 薄启动器)
src-tauri/src/cli.rs                       ├── npm-global/       (AI 自装 CLI 落点)
  → 定位 bundle Node + CLI                └── sidecar.port      (Global Sidecar 端口)
  → 生成并原子安装 launcher
```

`~/.myagents/bin/myagents` 不包含 route、help 或 body builder；历史完整 JS payload 和 `.cli-version` 会在启动时无条件收敛 / 退休，marker 值不再参与正确性判断。

## CLI 脚本设计

### 执行方式

CLI 脚本只有一条执行 authority：`cli.rs` 使用当前安装包的 bundled Node.js 执行当前安装包的 `resources/cli/myagents.cjs`。`.cjs` 是产物自描述契约：即使开发 `.app` 位于上层声明 `type: module` 的源码目录，Node 也必须按 CommonJS 加载。AI Bash 与用户终端的 `myagents` 先经过薄启动器回到当前 app executable；兼容的 `MyAgents <known-group>` 直调则直接进入同一个 Rust CLI mode。两条入口最终执行同一 bundle，不依赖系统 Node 或 HOME 中的业务脚本。

### CLI 端口选择

```
优先级：--port 标志 > 已继承 MYAGENTS_PORT > Global sidecar.port
```

- **AI 调用场景**：`buildClaudeSessionEnv()` 注入 `MYAGENTS_PORT` 环境变量（当前 Session Sidecar 端口）
- **终端调用场景**：只有环境没有有效 `MYAGENTS_PORT` 时，`cli.rs` 才从 `~/.myagents/sidecar.port` 读取并校验 Global 端口
- **显式覆盖**：Node CLI parser 最后解析 `--port`，所以命令行值高于 Rust 保留或补入的环境值

### 命令体系

```
myagents <group> <action> [args] [flags]
```

命令按 owner 分组：配置与能力（MCP/model/skill/tool/plugin/config）、Agent 与 Runtime、Session/Goal、Task/Record/Speech、Space/IM，以及 status/version/reload 等应用控制。canonical group、action、flag 和输出字段以当前 bundle 的顶层/leaf `--help` 为准；本文只记录跨命令的路由、身份和 mutation 规则，不维护静态全集。

所有 mutation 对未知 flag fail closed。`--dry-run` 只有在 leaf help 明确声明支持时才有效；不能把拒绝执行描述成成功预览。

Agent-facing system prompt、Required Skills 与 help 只推荐 canonical `myagents record` / `sourceRecordId`。`myagents thought`、`/api/admin/thought/*` 与持久层 `sourceThoughtId` 仅在已发布脚本、旧 JSON shape 和升级读取边界保留；兼容面薄映射到 Record owner，不能重新成为产品主入口或第二份 Store。

`mcp add` 是 create-only 操作：自定义 MCP ID 已存在时明确失败并保持原定义不变；需要替换时先检查并显式 `mcp remove`，避免省略的 `args/env/description` 被一次不完整 add 静默清空。

### 请求-响应模式

```typescript
// CLI 脚本的所有调用都是同一个模式
const result = await fetch(`http://127.0.0.1:${PORT}/api/admin/${group}/${action}`, {
  method: 'POST',
  body: JSON.stringify(body),
});
```

Admin API 的响应格式统一：
```jsonc
// 成功
{ "success": true, "data": { ... }, "hint": "optional free-form success tip" }
// 失败
{
  "success": false,
  "error": "error description",
  "recoveryHint": {                                 // 结构化恢复建议
    "recoveryCommand": "myagents runtime list",     //   下一步可运行的命令
    "message": "See valid runtimes + install status."
  }
}
// dry-run
{ "success": true, "dryRun": true, "preview": { ... } }
```

**`recoveryHint` 设计**：CLI 在人类可读模式下渲染为 `→ Run: <command>   <message>` 追加在错误行下方，JSON 模式保留完整字段。目的是让 AI 调用者在验证失败时能一步恢复 —— "想知道哪些 runtime 可用？按提示跑 `myagents runtime list`" —— 不需要读源码或反复试错。

### 发现型命令（Discovery）

AI 在调用写操作前通常需要先「问清楚选项」。以下三条命令是纯查询，不改状态：

```bash
myagents runtime list                             # 看哪些 runtime 装了、未装的给出安装提示
myagents runtime describe <runtime>               # 看某 runtime 的 model + permissionMode 枚举
myagents agent list --active|--archived           # 找 stable Agent ID；human/JSON 标记当前调用方
myagents agent show <agent-id>                    # 看 identity + effective Session birth 默认
myagents session list --agent <agent-id>          # 看最近可复用的 persisted Session context
```

这三条命令的存在让 `task create-direct --runtime X --model Y --permissionMode Z` 的值空间对 AI 完全自解释 —— `--help` 里只列 flag，值通过 `runtime describe` 查，避免 `--help` 文案与实际可用值漂移。

`agent set` 不是裸 JSON 属性写入：只接受帮助中列出的 canonical 字段
`enabled/runtime/runtimeConfig/providerId/model/permissionMode`，未知字段在写盘前拒绝；
`provider` / `permission` 不作为第二套 alias；未知字段应明确提示 canonical
`providerId` / `permissionMode`。providerId/model/permissionMode 属于配置 intent，
必须在 Admin API 边界校验并同步 Agent 权威记录、Project 兼容镜像和运行中的
Agent/IM Channel。Managed Codex 的 Agent 配置只接受产品 permission
（`auto | plan | fullAgency`）；`agent show` 再精确投影为 effective Codex
runtime permission。Native 值属于 Session 执行快照，不能写入 Agent 的产品字段。
`full-auto` 保留 workspace-write sandbox，不能当作 `fullAgency` 或升级为
`no-restrictions`。任何单字段更新不得重置未涉及的 provider/model/permission 字段。
Provider 目录、credential/readiness 与 model 校验必须在 `agent-config-intent.lock`
保护的磁盘最新快照上完成；Admin API 与 Renderer 的 Agent/Project 双写路径共享同一把
跨进程 intent lock，两个文件各自的原子锁只负责单文件 read-modify-write。

Agent identity 是所有 Project 的必备底层事实，不等同于主动 Agent 开关：
`Project.agentId → AgentConfig.id` 是配置 selector，`Project.path` 是 Project-backed
当前工作区，`enabled=false` 只关闭 Heartbeat、Memory Update、Memory Evo 三项主动能力，
不关闭由 `channel.enabled` 独立控制的 Channel，也不影响显式 addressability 或普通工作区使用。Renderer
birth/repair 与 Node discovery 都复用 `src/shared/agentWorkspaceIdentity.ts` 的 pure
policy，并在 `agent-config-intent.lock` 内按 Project-first 顺序提交：先落
`Project.agentId`，再以同一 ID 幂等补建不含 `workspacePath` 的 Agent。有效 ID 不按
旧 path 重新选择；缺失/失效 ID 才由 legacy adapter 按持久化数组顺序取第一个
canonical path match。历史 extra/orphan Agent 仍可用 exact ID discovery/config/start，
但只有 exact Project claim 能做 Project lifecycle mutation。重复 Project path/Agent ID
仍是硬冲突；多 Project claim 同一 Agent 只隔离相关目标，不拖垮健康 discovery。

### Goal Mode 命令

`myagents goal --help` 是 Goal Mode 的内置 skill 文档。系统提示词只告诉模型在明确 User 要求“Goal Mode / Goal Loop / 目标模式 / 设立目标 / 持续执行直到完成”时先运行 help，再按 help 使用子命令；不要把 help 全量塞进主 system prompt。

命令语义：

| 命令 | 何时调用 | 效果 |
|------|----------|------|
| `myagents goal get` / `list` | 查看当前 session 是否已有 Goal，或状态更新前确认 | 返回当前 session Goal，或 `goal: null` |
| `myagents goal create --objective-file <path> [--deadline <ISO-with-offset>] [--max-executions <n>] [--ai-can-exit <bool>]` | 仅当 User 明确要求进入 Goal/目标模式 | 从本地普通文本文件读取 objective，创建 current-session Goal，启动自动续跑，广播 `goal:changed`；可为新 Goal 设置结束条件 |
| `myagents goal update --status complete` | 当前证据证明 objective 全部完成且无剩余工作 | 停止自动续跑，标记 complete，终态通知 |
| `myagents goal update --status blocked` | 同一 blocker 连续至少 3 个 Goal turn 仍无法推进 | 停止自动续跑，标记 blocked，终态通知 |

边界：

- Goal create/update 按当前 Sidecar session 解析 `sessionId + workspacePath`；不能跨 session 创建 Goal，也不能覆盖同 session 未完成 Goal。
- `--objective-file` / `--reason-file` 可读取 workspace 外的本地普通文件（例如系统 temp）；相对路径仍以 CLI 当前目录解析。位置不做 containment，但保留 1 MB、NUL、regular-file、leaf symlink 与 open-time identity 检查。这个放宽仅属于 Goal；Space 等 workspace-scoped 输入不变。
- `--deadline` 是“最晚停止时间”，不是“最早开始时间”，必须带显式时区偏移或 `Z`；`--max-executions` 是正整数；未传参数时仍使用 `deadline=None / maxExecutions=None / aiCanExit=true`。
- `update` 只接受 `complete` / `blocked`。pause/resume/cancel 由用户或系统路径控制。
- `aiCanExit=false` 时 Management API 从服务端拒绝模型 complete/blocked；不能只依赖 prompt 隐藏命令。
- CLI 创建保留空 permission → runtime 最大权限的无人值守语义；model/provider/runtime/reasoning/MCP 不写入 Goal state，由当前 session 在每轮继续拥有。
- 普通 Cron surface 不创建或管理 Goal。`myagents cron add --schedule '{"kind":"loop"}'` 会被拒绝；Goal 创建统一走 `myagents goal create --objective-file ...`。objective/reason 是 file-only 输入，不接受 inline 或 positional 文本。
- `goal get` 的人类可读投影明确区分 `settled turns`（Rust 已 finalize 的 `turnCount`）与可选 `current turn`（`executionNumber`）；JSON 继续返回既有 `turnCount / isExecuting / executionNumber / endConditions` 字段。
- current-session Goal 不附带 `CronDelivery`；IM / Agent Channel session 依赖当前 session 输出路由。

### Cron 兼容命令

`myagents cron` 保留既有用户命令名和 JSON shape，但不再创建 `CronTask`。所有 add/list/update/start/stop/remove/run-now 都由 Rust compatibility facade 直接读写 `TaskStore`，时间触发由 `TaskSchedulerController` 管理；`cron_tasks.json` 只作为启动迁移的只读历史格式。

新 Agent 工作流以 `myagents task` 为 canonical surface；`task start/stop/runs/exit` 在 CLI 路由层复用对应 compatibility handler，不复制 Admin/Rust 业务逻辑。旧 `cron` 命令继续服务已发布脚本和人工习惯。

Cron 兼容面只提供 `list`，不发布 `cron get`；单条详情统一使用 canonical `myagents task get <taskId>`，两者都只投影 TaskStore。迁移失败的旧行不混入可操作列表，只通过桌面内部 `cmd_get_unmigrated_legacy_cron_tasks` 供只读 Legacy 面板诊断；deleted Task 保留 legacy id tombstone。

- `start` 提交 Task `Running` 并 arm timer，不绕过 schedule/Detector；若保留的 interval anchor 已过期，scheduler 可能把下一次 tick clamp 到约 2 秒后，调用方必须读取权威 `nextExecutionAt`。
- `run-now` 可执行 Stopped Task，不启用 scheduler，也不移动下一次 scheduled anchor。
- `task start/stop/run/rerun` 的成功数据继续包含 `taskId`、`status`、epoch-ms `nextExecutionAt` 与 canonical `TaskProjection` 字段 `task`。create/get/run/rerun 在 Node 边界额外派生稳定的 `data.receipt`，统一给 Agent 提供 `taskId/status/statusMeaning/changed/nextExecutionAt/executionState/resultAccess`；它不持久化、不拥有状态，也不替换旧字段。run/rerun 的内部 `attemptOrdinal` 仅用于新执行 analytics，不作为 CLI 公共语义；Running Task 的重复/并发 run 返回 `changed=false`，不产生新 attempt。Task application 失败统一在 Rust Management API 边界输出顶层 `code` + `error`，不得把 TaskStore 的 `{code,message}` 再编码进 `error` 字符串。
- `Loop` 被拒绝；持续工作使用 current-session Goal。
- `/api/admin/cron/*` 是兼容路由名，不代表独立 Cron domain/store。

### Task Automation Skill 与条件激活

`myagents-task-automation` 是 Required system skill，也是所有“定时、未来唤醒、周期执行、等待条件后继续”的统一 Agent 入口。Skill 先建立 Task，再选择默认 `always` 或低成本 `command Detector`；Sensor 不再作为独立 Skill / 产品实体。Detector 详细协议放在 Skill 的按需 reference，普通 scheduled Task 不加载这部分上下文。

```bash
myagents task trigger validate --spec-file trigger.json
myagents task trigger test --spec-file trigger.json --workspacePath /abs/workspace --expect quiet
myagents task trigger test <taskId> --expect activate
myagents task create-direct ... --trigger-file trigger.json \
  --runMode single-session --preselectedSessionId current
myagents task start <taskId>           # 恢复 stopped schedule
myagents task stop <taskId>            # 暂停 schedule / 活跃执行
myagents task runs <taskId>            # AI 执行历史
myagents task exit --reason "..."     # eligible Task run 内主动结束
myagents task check-now <taskId>       # 提交 Detector 状态，命中才唤醒 AI
myagents task run-now <taskId>         # 绕过 Detector，强制执行 AI
myagents task reset-checkpoint <taskId>
```

`task create-direct` 与 `task list` 在 Sidecar Admin 边界复用当前 workspace 解析：正常路径省略 workspace flags，Sidecar 以当前 path 匹配 `projects.json` 并补齐 Rust 所需的 stable `workspaceId + workspacePath`；只有显式跨 workspace 时由调用方提供。`agent current --json` 只返回当前 Agent/workspace/Session 的紧凑诊断，不是创建前置步骤。`task list` 的 Agent 投影默认只在当前 workspace 内返回紧凑字段与 `sessionCount`，完整 `sessionIds`、文档和 Trigger health 仍由 `task get` 拥有。兼容 `cron add/update` 必须无损转发同一组 `runtime/runtimeConfig/providerId/model/permissionMode` override，并在 dry-run 与真实写入前复用同一 validator；mutation leaf 对未知 flag fail closed，禁止静默丢字段。未显式传 override 时仍只继承目标 Agent，不增加顶层或 project runtime fallback。

CLI 从自身 `MYAGENTS_SESSION_ID` 判定 `agent/cli` 或 `user/cli`，把内部 caller metadata 传到既有 Rust transition 审计；Sidecar 不用自己的 `MYAGENTS_PORT` 猜调用者。UI 继续在 Tauri command 边界权威盖章为 `user/ui`。archive 仍由状态机执行 user-only guard，delete 记录真实 CLI actor/source。

`--preselectedSessionId current` 在 CLI 边界解析 `MYAGENTS_SESSION_ID`，持久层只接收 canonical id；新建 single-session 不允许空绑定。trigger/spec/checkpoint 文件使用有界 regular-file no-follow 读取，拒绝 NUL、无效 UTF-8、超限或非 object JSON；`trigger test --expect` 也必须在任何 Detector 调用前校验为 `quiet | activate`。test 不提交 MyAgents 状态，但命令的外部副作用仍真实发生。human/JSON failure 都保留结构化 code、suggestion、可选 suggested command，以及 Detector 的有界 stderr/stdout 诊断。pending Activation Event 未结算时，Rust authority 拒绝 `run-now`，CLI 只透传该拒绝而不建立第二条执行路径。

Agent-facing CLI 统一使用 `myagents task`。`task start/stop/runs/exit` 只是在 CLI 路由层复用既有 Cron compatibility handler，后端仍进入同一个 Rust Task authority；`myagents cron` 命令为外部用户和脚本继续兼容。Task 创建还可用 `--deadline`、`--maxExecutions`、`--aiCanExit` 写入既有 `TaskEndConditions`，不新增结束状态 owner。

### Runtime 自诊断

```bash
myagents runtime diagnose codex [--workspace=<path>] [--json]
myagents diagnose runtime codex [--workspace=<path>] [--json]    # 别名糖
```

两条命令路由到同一个 admin endpoint（`runtime/diagnose` 与 `diagnose/runtime`，handler 一致）。Spawn 一个短命 `codex app-server` 进程，跑 `initialize` + 4 个 RPC（`getAuthStatus` / `experimentalFeature.list` / `mcpServerStatus.list` / `app.list`），结构化返回 `RuntimeDiagnostics`：

- `--workspace=<path>` 让诊断按该 workspace 的 agent `runtimeConfig.envPolicy` 注入 env（共享 `env-utils.resolveAgentEnvPolicy` 做 proxy 字面量校验），结果反映真实会话会看到的状态而不是 baseline
- `--json` 输出稳定的结构化诊断，便于比较用户终端与 MyAgents Runtime 的实际环境

详见 [`multi_agent_runtime.md`](multi_agent_runtime.md) 的“诊断与环境”。

## Bundle authority 与 launcher 收敛

`npm run build:cli` 只生成 `src-tauri/resources/cli/myagents.cjs`。构建入口在每次 CLI build 前清理该目录的可变 inventory，避免旧 `myagents.cmd` 等 staging 残留被安装包继续携带。修改 `src/cli/myagents.ts` 后不再 bump 独立 CLI 复制版本；当前 app bundle 自然就是当前 CLI 版本。CLI surface 若改变，仍需同步 `bundled-skills/myagents-cli/SKILL.md`，并按 system skill 规则 bump `SYSTEM_SKILLS_VERSION`。

Rust `ensure_launcher()` 由以下边界调用：

1. app setup 在 blocking worker 做 best-effort 预检，失败写统一日志但不阻止设置 / 更新界面打开；
2. `start_tab_sidecar_admitted()` 覆盖 Global / legacy instance birth，legacy ensure 的 running-instance fast path 也必须复查；Session lifecycle ensure 入口覆盖 Session create / reuse；失败则拒绝出生或复用；
3. 应用内 terminal create 在 PTY 出生前执行同一 admission，避免 best-effort startup 失败后从后续 PATH 命中旧 HOME / npm 同名脚本。

reconciler 先确认当前安装树的 bundled Node 与 `cli/myagents.cjs` 都是普通文件，并分别 canonicalize 安装边界、resource root 和两个 leaf；任何中间 symlink / junction 使 root 逃出安装树、或使 Node / CJS 逃出 root 都以 `CLI_BUNDLE_RESOURCES_UNSAFE` fail closed。随后才计算两份确定性 launcher 内容。写入使用同目录 `create_new` 临时文件、flush / fsync、Unix 0755、atomic rename 与目录 fsync；检查和替换不跟随目标 symlink。内容与权限已正确时 no-op。旧完整 JS、旧 cmd、错误内容和 symlink 都被替换；退休的 `.cli-version` 只在 launcher 全部安装成功后删除。

bundle / launcher 缺失或不可写时没有系统 Node、npm 包或旧 HOME payload fallback。错误以 `CLI_BOOTSTRAP_FAILED` 开头，并带稳定 code、stage、path 和重试 / 重装建议。下一次 app 启动或 Sidecar admission 会重新检查真实文件，不依赖内存成功 flag、version marker、watcher 或 repair daemon。

`ADMIN_AGENT_VERSION` 与 `SYSTEM_SKILLS_VERSION` 仍各自管理小助理和版本化 system skills；它们与 CLI bundle authority 是不同生命周期：

- 修改 `bundled-agents/myagents_helper/` 的 CLAUDE.md 或 Skills：bump `ADMIN_AGENT_VERSION`；
- 修改 CLI 命令契约并影响 Agent 使用说明：同步 `bundled-skills/myagents-cli/SKILL.md`，必要时 bump `SYSTEM_SKILLS_VERSION`；
- 修改 `SYSTEM_SKILLS` 清单内内容、新增或退休 system skill：继续遵守现有 `SYSTEM_SKILLS_VERSION` 与精确清理规则。

Skill frontmatter 以 Agent Skills 标准为 canonical：作者写在 `metadata.author`，不能新增顶层 `author`。`src/shared/slashCommands.ts` 是 UI / Sidecar 共用的归一化 owner：读取时标准 `metadata.author` 优先，并兼容旧顶层 `author` / `Author`；list/detail/CLI 投影继续提供扁平 `author` 方便消费，保存时只写回 `metadata.author`，同时保留其它标准 string metadata。这样旧 Skill 无需一次性迁移也能展示，而任何后续编辑都会自然收敛到标准格式。

`SYSTEM_SKILLS` 是版本化安装集合，`REQUIRED_SYSTEM_SKILLS` 是其中始终可用的产品契约子集，二者不能混为一谈。canonical 名单在 `src/shared/systemSkills.ts`，Rust workspace/slash 路径在 `src-tauri/src/workspace_files/skills_config.rs` 维护必要镜像，并由 cross-language test 锁定；改名单必须同步这两处，禁止 UI、CLI、文档或其它模块再复制第三份。读取旧 `skills-config.json` 和每次写回都会移除这些名称的 stale disabled 项；Skills API 以 `required:true, enabled:true` 投影，disable 请求返回 409。其它版本化或用户 Skill 仍可正常 enable/disable。

内容所有权与启停权彼此独立：user scope 的 `SYSTEM_SKILLS` 内容一律由 MyAgents 持有并保持只读，不因是否 `required` 而改变；optional system Skill 仍可按现有策略 enable/disable。project scope 中同 canonical name 的实体 Skill 仍归项目所有，可独立编辑和删除；普通用户 Skill 的 CRUD 不变。

系统同步成功之后，Runtime 还必须经过全局 Skill integrity admission：Node `global-skill-inventory.ts` 是 builtin / Managed Codex / System Codex 与 Claude Code 工作区兼容链接的唯一运行时 authority，一次完整根扫描同时喂给本次边界需要的 resolver、compiler 与 projection。强冲突证据项保留磁盘但不加载；Required 缺失或 blocked 拒绝 Runtime。Rust Launcher 不建立第二份注册表，只用共享 fixtures 镜像 classifier，并跳过指向全局根的 project junction。完整分类、投影收敛与 mutation-only 只读规则见 `pit_of_success.md#system-skill-sync` 和 `pit_of_success.md#workspace-files`。

## Rust CLI 入口（场景 2）

`cli.rs` 让 launcher 和兼容的 app-binary 直调在 Tauri 初始化前进入 CLI mode：

```bash
# macOS — 直接调用 app 二进制
/Applications/MyAgents.app/Contents/MacOS/MyAgents mcp list

# canonical 用户入口由 app 启动自动生成
~/.myagents/bin/myagents status
```

### 检测逻辑

```rust
// src-tauri/src/cli.rs
pub fn is_cli_mode(args: &[String]) -> bool {
    args.first().is_some_and(|arg| arg == CLI_BOOTSTRAP_ARG)
        || /* 已发布 app-binary group / help 兼容 */
}
```

canonical HOME launcher 总是传私有 marker，Rust 在调用 Node 前剥掉它。因此新增 `myagents <group>` 不依赖 Rust group 镜像。`CLI_COMMANDS` 只保留已经发布的 `MyAgents <known-group>` 直调兼容；若产品明确承诺新 group 也支持 app-binary 直调，才扩展该兼容名单。deep link / 普通 GUI 参数不含 marker，不会误进 CLI。

应用 `main()` 在 Tauri 初始化前检查 CLI 模式，提前分流：
- **CLI 模式**：不启动 GUI、不杀 sidecar、不触发单实例窗口焦点
- **GUI 模式**：正常启动 Tauri 桌面应用

### Windows 特殊处理

```rust
#[cfg(windows)]
{
    // windows_subsystem = "windows" 隐藏了控制台
    // CLI 模式需要重新附着到父控制台才能看到 stdout/stderr
    AttachConsole(ATTACH_PARENT_PROCESS);
}
```

### Rust 端口回退

```rust
fn discover_sidecar_port() -> Option<String> {
    // 读取 ~/.myagents/sidecar.port（Global Sidecar 启动时写入）
    // 校验是合法端口号（防止陈旧/损坏文件）
}
```

Rust 只在继承环境没有有效 `MYAGENTS_PORT` 时注入这个 Global 端口。Session Runtime 已注入的端口必须保留；Node parser 的 `--port` 再覆盖环境。需要 HTTP 的命令仍要求对应 Sidecar 存活；只有 CLI 自身明确实现为本地输出的 surface（当前如顶层 help）不依赖端口。

## Admin API

Admin API 注册在 Sidecar 的 `/api/admin/*` 路由下，提供与 GUI 对等的管理能力：

| 路由前缀 | 能力 |
|---------|------|
| `/api/admin/mcp/*` | MCP 服务器 CRUD、启用/禁用、环境变量管理、连通性测试、OAuth 流程 |
| `/api/admin/model/*` | Provider CRUD、API Key 设置、模型验证、默认供应商切换 |
| `/api/admin/agent/*` | stable Agent identity `list/show`、启用/禁用/归档/取消归档/属性设置、Channel CRUD、runtime 状态查询 |
| `/api/admin/runtime/*` | 跨 runtime 发现：`list` / `describe` |
| `/api/admin/cron/*` | 定时任务 CRUD、启停、执行历史、状态查询 |
| `/api/admin/goal/*` | 当前 session Goal Mode：`get` / `create` / `update` |
| `/api/admin/task/*` | 任务中心：list/get/create/update/run/rerun/run-now、trigger validate/test/check-now/reset、status/session/archive/delete/doc |
| `/api/admin/record/*` | 统一 Record：list/create；`thought` 路由仅作兼容 |
| `/api/admin/speech/*` | 当前 Session 的附件转录 submit/status/cancel/list；`wait` 复用 status 轮询 |
| `/api/admin/skill/*` | Skills CRUD、远程/本地来源安装、启停、sync；显式相对路径由 CLI 按调用者 cwd 归一化 |
| `/api/admin/tool/*` | 用户注册 CLI 工具注册表（实验室门控，默认关闭） |
| `/api/admin/vision/*` | 官方图片理解 CLI 工具：`readme` / `analyze` |
| `/api/admin/plugin/*` | OpenClaw 插件安装/卸载/列表 |
| `/api/admin/im/*` | IM runtime actions（send-media） |
| `/api/admin/session/*` | Agent Session `list/start` discovery/fresh admission，以及 `send/watch` 既有上下文通信 |
| `/api/admin/space/*` | Cloud Space：显式 slug、whoami/assignee/Goal discovery、Issue create/read/metadata update、comment/top attachment、claim/complete/download |
| `/api/admin/widget/*` | Generative UI widget 资料 |
| `/api/admin/config/*` | 通用配置读写 |
| `/api/admin/status` | 应用运行状态 |
| `/api/admin/version` | 版本号 |
| `/api/admin/reload` | 热重载配置 |
| `/api/admin/help` | 命令帮助文本（子命令 help 来自这里） |

### Cloud Space CLI 身份与错误边界

- `space list` 是唯一不要求 `--space` 的发现命令；其它 Space 业务命令必须显式 canonical slug，不维护隐式默认 Space。
- CLI 只解析参数，不接受 `--actor` 或 token。Sidecar Admin API 以当前 workspace path 查 `projects.json` 并补 stable `workspaceId`；Rust `SpaceCliContext` 刷新 `/api/me` 后，只在当前 Session origin 明确携带 exact `spaceId + registeredAgentId`（或显式 legacy `localAgentId` 精确命中）时使用 Agent token。workspace id/path 只做 containment 与 registration 校验，不参与 actor 推断。
- delivery Session 以持久 Session origin 为 actor authority，并用 `registered_agents.json` 中该精确实例的 Space/device/workspace/owner/token 状态校验绑定；`delivery_log.json` 只保存 transport receipt，不参与 actor 选择。Agent 丢失、失效、跨 Space/device/workspace 或 ID 不一致时 fail closed，绝不降级为 User。没有 exact Agent origin 的普通 Session 始终使用当前 User session token，即使同 workspace 恰好存在一个 Agent。
- Rust Management API 统一返回 `{ok:false,code,error,suggestion,suggestedCommand?}`；Node Admin API 原样保留，CLI human mode 渲染 `Error:`/`Suggestion:`，`--json` stdout 只输出一个可解析对象且本地参数/文件错误也走同一契约。
- `myagents <exact leaf> --help` 是 Agent 的工具说明。每个 Space leaf 独立描述 WHEN TO CALL、EFFECT、REQUIRED CONTEXT、OPTIONS、ACTOR AND PERMISSIONS、FILE SAFETY、OUTPUT、EXAMPLES、RECOVERY，不能回落到泛化 group help。
- `myagents space issue --help` 是 Issue 动作面的统一 discovery 入口；具体参数继续以下一级 leaf help 为权威。不提供 `space issue delivery ignore`：不行动是合法模型决策，不需要修改 Delivery；transport ACK 由 connector 自动维护。
- Goal discovery 走 `space goal list --space <slug> [--include-archived]`，只把 active `data.items[].id` 用作 create/list/update 的 `--goal`。`myagents goal` 是本地 Session Goal Mode，`myagents space goal` 是 Cloud 组织 Goal，help 必须保持命名空间消歧。
- Issue 元数据编辑走 `space issue update <issueId>`，只接受 title/body/Goal/humanOnly。省略 Goal 表示不变；`--clear-goal` 在 CLI→Rust 使用 tagged action，Rust 最后一跳才映射成 Cloud `goalId:null`。state、assignee、claim、comment 和 attachment 仍由各自命令拥有。
- top help 不承诺全局 preview。所有 Space write-like command 携带 `--dry-run` 时，CLI 在端口发现、HTTP 与本地文件 IO 前返回 `DRY_RUN_UNSUPPORTED`；只读命令不会把无关 flag 描述成 preview。真正支持 dry-run 的配置类命令以各自精确 leaf help 为准。
- repeatable `--attachment`/`--file` 只传路径；Rust 一次 bounded/no-follow 读取后同时拥有 multipart bytes 与 complete idempotency hash，Node 不读取附件内容。

### Agent / Session discovery 与协作协议边界

`/api/admin/session/*` 是 CLI 暴露的 session 间通信入口，但协议 owner 不在 CLI
进程。CLI 只负责解析参数、把调用发给当前 Sidecar；Sidecar / Management API 负责
session 选择、结构化事件生成与投递确认。

| 子命令 | 事件 | 关键不变量 |
|--------|------|------------|
| `myagents agent list/show` | 无 | exact Agent ID 是 selector；Project-backed 与历史 extra/orphan 均可发现；只有 Project 选中的 Agent 可为 `isCurrent`；目标 claim conflict 局部失败 |
| `myagents session list --agent` | 无 | 只读 `sessions.json` 的 history-visible metadata，按 `lastActiveAt` 倒序；不唤醒、不探测 live、不读 transcript |
| `myagents session start --agent` | `send.request` / 可选 `send.result` | Rust 生成 Session/request ID，目标 Sidecar 按 Agent 当前有效配置创建 owned snapshot；Runtime dispatch acceptance 是成功点，CLI receipt 不等待 terminal |
| `myagents session send` | `send.request` / 可选 `send.result` | 目标 session 收到 `<myagents-session-event type="send.request">`；若需要回执，目标 turn terminal 后自动把 `send.result` 推回源 session |
| `myagents session watch` | `watch.already_idle` / `watch.completed` / `watch.error` | Rust Management API 先确认目标 live state；目标忙时在目标 Sidecar 注册 pending watch，完成事件确认送达后才 ack 清理；目标已 idle 时调用方立即收到最近结果 |

`start` 不是“先建空 Session，再 best-effort send”的两步写入。source 只解析目标
AgentConfig 与已解析 workspace 并提交 prompt；Project-backed workspace 来自 `Project.path`，真 orphan 才使用 legacy fallback。Rust Management API `/api/inbox/start-session` 获取 target
workspace lifecycle + transient Agent owner并确保目标 Sidecar。target 在任何 metadata 写入前
重新解析 Agent/Project lifecycle，并核对当前 Sidecar 的 Session/workspace。随后目标按自己的
当前 Agent 配置和实际 Runtime 写
`materializationState=prepared` 的隐藏 metadata，再通过 `SessionEngine.enqueueInboxMessage()`
把同一个 typed dispatch guard 交给 builtin/external adapter。guard 赢得
Runtime dispatch acceptance 时提交可见 Session。明确
rejection 按 source request ID 回滚；guard 之后的 runtime error 是已接纳 turn 的 terminal error。
ACK 丢失返回 unconfirmed receipt 并保留 ID、不自动重试。Rust 复用既有
`BackgroundCompletion` handoff 后释放 transient owner；不新增 fresh-start durable token、恢复
状态机、配置 fingerprint 或跨文件事务。

调用方只能提交 `agentId + prompt + replyBack`，且必须来自有真实 sessionId 的 MyAgents
Session。目标 Agent 是 runtime/model/permission/provider/MCP/plugin/tool birth authority；
Admin API 对调用方同名 override fail closed。默认 terminal 结果复用既有 `send.result` 回投，
receipt 的 `messageId` 对应后续 `requestEventId`。

事件 prompt 统一由 `src/server/inbox/session-event.ts` 渲染，标签形态为
`<myagents-session-event ...>`，payload 内部会 neutralize 协议结构标签。新增
session event 类型时必须同时更新该渲染层、目标 Sidecar 处理路径和 CLI help 文案。

### 写入模式

AppConfig-backed 写操作的通用路径到当前 Sidecar 的兼容事件为止：

```
CLI → Admin API → atomicModifyConfig() → 写 config.json（磁盘优先）
                → 更新 Sidecar 内存状态（setMcpServers 等）
                → broadcast() SSE 事件（当前 Sidecar 兼容面）
```

`model set-key / set-default / verify / add / remove` 与 MCP mutation 在完成各自磁盘提交后额外调用
app-wide config notifier：保留当前 Sidecar 的 `config:changed`，再经 Management API
`/api/app/config-changed` 向所有 WebView 广播空 payload 的应用级失效信号；挂载 `ConfigProvider`
的 renderer surface 收到后重读完整磁盘快照。浮球等轻量 WebView 不挂 `ConfigProvider`，不消费这条刷新链。
普通 `config set` 等写操作不拥有这条 app-wide refresh 路径；新增全窗口同步需求时必须先明确
其磁盘 authority 与完整 snapshot owner，不能把局部 Sidecar broadcast 泛化成应用级协议。

Agent 的破坏性生命周期 intent 还必须收敛 Rust live owner：`agent channel remove` 先从
`config.json` 删除精确 Channel，再调用 Management API `/api/agent/stop-channel`；`agent disable`、
`agent set <id> enabled false` 与 `agent archive` 先提交 durable disabled/archived 状态，再调用
`/api/agent/stop-channels`。Rust 在既有 Channel lifecycle lock 内 shutdown runtime、释放 Sidecar owner、
终止 Plugin Bridge 并注销 plugin-use registry；整组停止的锁集合必须合并 durable 与 live Channel ID，
从而等待尚未登记进 `ManagedAgents` 的启动流程。Management API 失败时 CLI 必须明确报告“配置已提交但
live runtime 未收敛”，不能把当前 Sidecar 的 `config:changed` 当作生命周期完成信号。

这确保了 CLI model / MCP mutation 和 GUI 配置产生相同的应用级效果。`model add/remove` 的 provider 文件必须持有 `${providerPath}.lock` 并原子替换；Provider 文件是定义权威，`availableProvidersJson` 只是 Rust IM 的派生投影。新增先提交可幂等重试的定义文件再重建投影；删除先提交 config 清理再删除定义文件，使 config 失败时定义天然保持不变，不引入跨文件伪事务。投影的 availability、primary 与 wire shape 只由 `src/shared/availableProvidersProjection.ts` 生成，renderer/Node 仅分别负责目录读取和持久化，禁止复制投影策略。GUI 不读取该投影作为 Provider authority，而是以一次 `config.json` 读取派生 credential/verify，并结合同代 projects/provider 文件形成完整 snapshot；所有磁盘 refresh 经 ConfigProvider 的同一个 snapshot commit owner，本地磁盘提交也推进同一 revision，拒绝旧读覆盖新写。应用级事件 payload 永远为空，不能把 API key/MCP env 放进 Tauri event；Management API 返回失败时 mutation 必须向 CLI 报告“已写盘但 app-wide refresh 失败”，不得返回局部 success。

`myagents model list` 的 JSON 与 human 输出都必须展示每个 Provider 的 `primaryModel` 和 `models`；human renderer 不能把 Admin 已返回的详情静默丢弃。

### 管理 API 转发（`/api/task/*` / `/api/cron/*` 等）

部分能力（Task / Cron compatibility / Plugin）在 Rust Management API 而非 Node.js。Admin handler 作为薄转发层，并通过 `wrapMgmtResponse()` / `mgmtError()` 保证：
- 成功响应剥掉 Rust `ok` 字段、包成 Admin `{ success: true, data }`
- 失败响应原样透传 `recoveryHint`（例如 Management API 不可达时 Admin handler 注入 `→ Run: myagents status` 指引）

### 官方 CLI 工具与用户 CLI 工具

MyAgents CLI 同时承载两类“工具”：

- 官方 CLI 工具：产品内置、稳定可用，由 MyAgents 自己实现和审核，例如 `myagents vision analyze`。它们可以出现在设置页「工具箱」和对话工具菜单中，但不属于 MCP，也不受用户 CLI 工具注册表实验开关影响。
- 用户注册 CLI 工具：用户通过 `myagents tool add` 注册的自定义 Agent-CLI 工具，受实验室开关控制，并通过 registry 注入新 session prompt。

`vision` 的开关语义与 MCP 类似：设置页全局启用后，对话内工具菜单还可以做 session 级启用；实际可用性还要求「设置 → 工具箱」中选择了支持图片输入的模型。`vision analyze` 只接受当前 workspace 内的本地图片路径；`--prompt` 用于短指令，`--prompt-file` 用于长/多行指令，但同样只按当前 workspace 解析，拒绝 URL、symlink 与逃逸路径。

#### `myagents anydoc` 本地文档转换

AnyDoc 是官方稳定命令组，不属于 MCP，也不受用户 CLI 工具注册表开关控制。公开 surface 固定为 `convert/status/wait/cancel/list`：Rust backend 始终异步；`convert --wait` 与独立 `wait` 只是 CLI 对 `status` 的有界退避轮询，不新增 Rust wait endpoint。`--output` 是输出根目录，最终 artifact 固定为 `<output-root>/<job-id>/document.md`；省略时 Sidecar 注入自己的 authoritative current Workspace，CLI 不得提交伪造的 workspace 字段。

Human output 以 Rust 查询时派生的 `output.artifactAvailable` 为产物真值：只有它为 `true` 才显示 `documentPath`；终态无产物明确显示 `Document: unavailable` / `(no artifact)`，queued/running list 项显示 `(pending)`。`stage` 只描述活跃 job 的当前处理进度，终态不再展示内部提交阶段 `finalizing`。JSON mode 保持完整 wire contract，accepted receipt 仍可把预留路径标为 `Output when ready`，但它不是 artifact 已存在的声明。

调用链为 app bundle CLI → 当前 Sidecar `/api/admin/anydoc/*` → Rust Management API `/api/document/*` → App-owned `DocumentProcessingManager`。Admin handler 必须保持薄转发，并用 `wrapMgmtResponse()` 保留 Rust 的 `code/suggestion/recoveryHint`。`wait` 复用 `anydoc/status` Admin route；Ctrl-C 只结束本地轮询并退出 130，不取消 App job。

Agent 使用说明由 required system Skill `/myagents-anydoc` 渐进加载；`myagents-cli` 只在正文速查中登记 `myagents anydoc --help` 与专属 Skill，不复制协议，且其 frontmatter description 不得出现 AnyDoc。AnyDoc 不进入 `system-prompt-cli-tools.ts` 的 always-on 内容。当前参数、退出码和恢复指引以逐级 exact `--help` 为二进制权威，不提供 `readme` 命令。底层 owner、资源和安全契约见 [`document_processing.md`](./document_processing.md)。

#### `myagents speech` Session-scoped 附件转录

Speech 是官方稳定命令组，不属于 MCP，也不受用户 CLI 工具注册表开关控制。公开 surface 固定为 `transcribe/status/wait/cancel/list`；App backend 始终异步，`wait` 只是 CLI 对 status 的有界退避轮询。`transcribe --file` 只接受当前 authoritative Workspace 内的一份普通本地音视频文件；默认输出根为 `myagents_files/speech-transcriptions`，成功 artifact 由 App owner 原子发布。

调用链为 app bundle CLI → 当前 Session Sidecar `/api/admin/speech/*` → Rust Management API `/api/speech/*` → App-global `SpeechRecognitionManager`。CLI 请求体只包含文件、输出根、job ID 或 limit，不发布 `--sessionId`、`--workspacePath`、`--sidecarId` 等 scope 参数。Node 从 live `SessionEngine` 取得 Sidecar process identity；Rust 用 Management request header 的 process generation 解析 authoritative `sessionId + workspacePath`，并把它冻结到 job。status/cancel/list 必须使用同一 Session identity，不能枚举或操作其它 Session 的 job。

`myagents speech list` 只返回调用 Session 最近的 durable job；这不是用户可选 filter。工具被该 Session 禁用、没有真实 Session/Workspace、caller generation 过期或资源未安装时都 fail closed。`wait` 收到 Ctrl-C 退出 130，但不会取消 App job；用户可用同一 Session 的 status/cancel 继续处理。底层 Worker、模型与恢复契约见 [`recording_and_speech_recognition.md`](./recording_and_speech_recognition.md)。

### CLI 工具注册表实验门控

用户注册 CLI 工具注册表（`myagents tool ...`、设置页「工具箱 / CLI 工具」、`tool-creator` skill、用户工具 prompt 注入）受 `config.cliToolRegistryEnabled` 控制。该开关位于「设置 → 关于&反馈 → 实验室」，默认关闭，且不能通过通用 `myagents config set cliToolRegistryEnabled ...` 修改，避免 AI 自行绕过人类可见的实验开关。

关闭时：
- Settings 不渲染工具箱里的 CLI 工具模块。
- `/api/admin/tool/*` 全部返回门控错误；`myagents tool --help` 只显示开启指引。
- `buildSystemPromptAppend(..., { userCliToolsEnabled: false })` 不读取 `~/.myagents/tools/registry.json`，因此新会话不会自动发现用户注册工具。
- Node `syncProjectUserConfig()` 不把 `tool-creator` symlink 到工作区 `.claude/skills/`；Rust Launcher 的只读 slash picker 同样把它视为 disabled。

不受影响：
- 稳定内置 `myagents` CLI 能力（cron / task / record / speech / im / widget / runtime 等）仍然注入并可用。
- 已经存在于 `~/.myagents/bin` 的工具 shim 不会被删除；门控的是 MyAgents 的注册、管理、自动发现和 `tool-creator` 注入，不是用户磁盘上可执行文件的生命周期。

由于系统提示词和 SDK skill 集合只在 session 启动 / pre-warm 时固化，开关变化对已有会话的提示内容不会 retroactive 改写；但实际 `myagents tool ...` 调用会立即被 Admin API 门控。

## Task 创建链路（关键机制）

`task create-direct` 是 ordinary Task 的唯一通用创建命令。手动表单、产品级 Task 讨论与其它 Agent 工作流都在确认最终 `task.md` 和参数后进入它；CLI 先补齐当前 workspace 与 caller provenance，再在转发给 Rust 前做一次 **pre-flight 验证**：

```
CLI → /api/admin/task/create-direct → resolveTaskWorkspace(payload)
                                      → validateTaskOverrides(payload)
                                            │
        ┌───────────────────────────────────┴────────────────────┐
        │                                                         │
        ▼                                                         ▼
   合法 → 转发 Rust → Task 落盘                           非法 → 立即 AdminResponse
                 │                                               + recoveryHint
                 ▼                                               （指向 `runtime list`
         enrichTaskCreateResponse                                  或 `runtime describe`）
         （读持久化 Task，echo
         真实的 overridden 字段，
         并附带 nextSteps）
```

**为什么 pre-flight 放在 Node 而不是 Rust**：Node.js 有现成的 `RuntimeFactory.detect()` / `queryModels()` 接口，而且 Node.js 能给出带 `recoveryCommand` 的结构化错误；Rust 侧只能返回 opaque serde 错误。

**验证三要素**：
1. `--runtime` — 必须是 `VALID_RUNTIMES` 之一，且外部 runtime 必须本机已装（`detect()` 带 2s timeout）
2. `--permissionMode` — 按 effective runtime 的 `getRuntimePermissionModes()` 枚举校验（builtin/外部统一走此路径）
3. `--model` — 外部 runtime 走 `queryRuntimeModels()`；builtin 不做本地校验（model 由 Provider 决定）

**effective runtime 解析**：`--runtime` 显式传 → 用之；否则从 `workspacePath` / `workspaceId` 查 Agent 默认；都查不到就拒绝（避免静默 trust）。

长正文使用 `--taskMdFile <path>`，读取的是 mutation 当下的文件内容；`create-from-alignment` 已退休，候选目录不是 Task row，也没有四文档 mint policy。创建成功后是否调用 `task run/start` 必须来自用户已经确认的动作，不能由来源类型隐式决定。

`task comments <taskId>` 与 `task comment [taskId] --body-file ... [--reply-to ...]` 是本地协作面。显式 Task ID 始终可用；只有带 `MYAGENTS_SESSION_ID` 且该 Session 有 Task execution context 的首轮 Task turn 才可省略 ID。用户 Comment 注入的后续 turn 必须使用 reminder 中的显式 ID，防止把回复写到碰巧最近的 Task。CLI 只调用 Task Application；Comment 的目标 Session、持久化、admission 和通知不在 Node 参数层推断。

**单一真相源**：`VALID_RUNTIMES` 常量在 `src/shared/types/runtime.ts` 定义，`HELP_TEXTS` 模板字符串、validator、factory 全部从此读取；并用一个 type-level assertion (`_exhaustiveRuntimeCheck`) 在 `typecheck` 阶段拦截 `RuntimeType` 联合与 `VALID_RUNTIMES` 元组的漂移。

## PATH 注入

`buildClaudeSessionEnv()` 构造 SDK 子进程的 PATH，决定 AI Bash 工具能找到哪些命令：

```
PATH 优先级（agent-session.ts::buildClaudeSessionEnv）：
  ~/.myagents/bin             → 官方 myagents launcher + Tool Registry shims
  systemNodeDirs              → 用户安装的 Node.js（npm 更可靠）
  bundledNodeDir              → 内置 Node.js（fallback）
  ~/.myagents/npm-global/bin  → MyAgents-localized npm installs / legacy AI 自装 CLI 落点
  系统 PATH                    → 用户其他工具
```

`myagents` 是 app-owned Runtime 中的产品保留命令，因此官方 bin 必须先于 npm-global、Windows AppData npm 和 inherited PATH；否则正确 launcher 仍会被旧同名 npm 包遮蔽。这个顺序由 shared Session builder、external shell fallback 与内嵌终端共同遵守，不修改用户普通外部终端的系统 PATH。`~/.myagents/bin` 还保存 Tool Registry shims，继续由其命名碰撞校验约束；CLI 迁移不会扫描或删除其它文件。

`~/.myagents/npm-global/` 是 MyAgents 建议的 AI 自装 CLI 落点。`buildClaudeSessionEnv()` 只注入 `MYAGENTS_NPM_GLOBAL_PREFIX` 和 PATH，不再给整个 SDK shell env 设置 `npm_config_prefix` / `NPM_CONFIG_PREFIX` / `PREFIX`，否则 nvm 会在每次 zsh/bash 初始化时吐兼容性警告。需要固定安装落点的 skill 用命令级 env：`npm_config_prefix="$MYAGENTS_NPM_GLOBAL_PREFIX" npm install -g <pkg>`。

## 安全设计

| 层面 | 措施 |
|------|------|
| **本地绑定** | Admin API 只在 `127.0.0.1` 上监听，无外部访问 |
| **端口隔离** | 每个 Sidecar 有独立端口，CLI 连接到对应 Session 的 Sidecar |
| **无持久化凭据** | CLI 脚本不存储任何 API Key，配置读写全走 Sidecar |
| **入口完整性** | HOME launcher no-follow + 原子替换；bundle Node / JS 必须是当前安装树普通文件，缺失时 fail closed |
| **权限控制** | POSIX launcher 权限 755，`~/.myagents/` 目录权限遵循用户 HOME 策略 |
| **文件大小上限** | `--taskMdFile` / `--taskMdContent` 硬上限 1 MB（防 binary 误传、runaway content） |
| **发现 detect timeout** | `runtime list` / `describe` 给每个 runtime 的 `detect()` 包 2s race，防挂起 CLI 阻塞其它 runtime |

## 排查指南

| 问题 | 排查方法 |
|------|---------|
| `ECONNREFUSED` | MyAgents GUI 未运行，先启动应用 |
| `MYAGENTS_PORT not set` | 没有 Session 环境且 Global Sidecar port 不可用；启动 MyAgents / 对应 Session 后重试 |
| `CLI_BOOTSTRAP_FAILED ... BUNDLE_RESOURCES_MISSING` | 当前安装包的 bundled Node 或 `cli/myagents.cjs` 损坏；更新或重装，不要复制旧 HOME 脚本 |
| `CLI_BOOTSTRAP_FAILED ... LAUNCHER_*` | HOME launcher 无法原子收敛；检查路径 / 权限 / 占用，关闭占用程序后重试或重启 app |
| 终端 `myagents` 找不到 | 场景 2 需要用完整路径或创建 alias，`~/.myagents/bin` 默认不在 shell PATH |
| `Management API not available` | Node.js Sidecar 起来了但 Rust Management API 没起 — CLI 会附带 `→ Run: myagents status` 指引 |
| `SPEECH_SESSION_REQUIRED` | 必须从拥有 authoritative Session + Workspace 的 MyAgents 会话调用；不要补传 scope 参数 |
| `SPEECH_JOB_NOT_FOUND` | 该 job 不属于当前 Session 或已不存在；先在同一 Session 运行 `myagents speech list` |
| `MyAgents <new-group>` 进了 GUI | app-binary 直调只兼容已发布 group；canonical `myagents <new-group>` 不受 Rust group 名单约束 |

### 已移除内置 MCP 的旧定义

Cuse 已退出内置 MCP 目录与安装包；旧配置或 Session snapshot 中的 `__bundled_cuse__` 启动标记由共享 `isRetiredBundledMcpServer` 在目录及 SDK/Codex 启动投影排除，不跨 owner 改写持久化数据。自定义真实命令（即使 ID 为 `cuse`）仍按普通 MCP 处理。历史工具结果沿用公共媒体展示。

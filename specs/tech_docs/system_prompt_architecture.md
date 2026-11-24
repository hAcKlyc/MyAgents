# MyAgents 系统提示词架构

## 文档职责

本文记录 MyAgents 对话 Session 的系统上下文如何组成、由谁拥有、何时固化，以及
各内置与外部 Runtime 如何接收同一套
产品指令。

本文拥有以下内容：

- MyAgents 产品级 system prompt append 的分层、场景选择和预设片段矩阵。
- 工作区指令文件与产品级 Prompt 的边界。
- 各 Runtime 的投送方式和 Session 生命周期语义。
- CLI 能力提示、用户注册工具和真实 Tool/Skill surface 的边界。

本文不复制以下协议的完整正文：

- 每轮隐藏消息的 envelope、badge、visible tail 与前端展示规则由
  [`system_reminder_protocol.md`](./system_reminder_protocol.md) 拥有。
- Space IssueDelivery 内部 Registered Agent Prompt contract 由
  [`space_issue_delivery_protocol.md`](./space_issue_delivery_protocol.md) 拥有。
- Runtime 原生协议与启动参数细节由
  [`multi_agent_runtime.md`](./multi_agent_runtime.md) 拥有。
- `myagents` CLI 的命令契约、工具注册表和实验门控由
  [`cli_architecture.md`](./cli_architecture.md) 拥有。

当前模板、条件和 Runtime 参数以代码、类型和测试为最终事实；本文解释 owner、边界和
数据流，不把易变的完整 Prompt 原文复制一份。

## 总体模型

模型最终收到的“系统上下文”并非来自一个字符串，而是四类来源共同作用：

```text
Runtime 原生 base/preset
        +
MyAgents 产品级 Prompt append
        +
Workspace 指令（CLAUDE.md / rules / AGENTS.md）
        +
每轮动态 system-reminder（user message envelope，不是 system role）
```

这四类来源的 owner 和生命周期不同：

| 来源                   | Owner / 权威实现                                                             | 生命周期                                              | 典型内容                                                    |
| ---------------------- | ---------------------------------------------------------------------------- | ----------------------------------------------------- | ----------------------------------------------------------- |
| Runtime 原生 Prompt    | 各 Runtime 及其 adapter                                                    | Runtime 进程或 thread 创建时                          | 工具协议、安全规则、Runtime 自身行为约定                    |
| MyAgents 产品级 append | `src/server/system-prompt.ts`、`system-prompt-cli-tools.ts`                  | Session Query / external thread 创建或 replacement 时 | MyAgents 身份、入口场景、产品能力发现提示                   |
| Workspace 指令         | Workspace 文件；加载兼容层为 `src/server/runtimes/workspace-instructions.ts` | Runtime 启动时读取，或由 Runtime 原生发现             | `CLAUDE.md`、`.claude/rules/*.md`、`AGENTS.md` |
| 动态 Reminder          | 对应业务 owner + `src/shared/systemReminder.ts`                              | 每个需要补充上下文的 Turn                             | Goal、Task、浮球、群聊、Space、Heartbeat 等动态事实         |

不要把四者都叫作“System Prompt”：`system-reminder` 在传输上仍是 user message，
Workspace 指令可能由 Runtime 原生加载，Codex 的 MyAgents append 则使用
`developerInstructions`。产品层的统一目标是语义一致，不是强迫所有 Runtime 使用同一
协议字段。

## 产品级 Prompt 组装

### 中央入口

`src/server/system-prompt.ts` 是产品级 Prompt 的唯一中央 assembler。它先用
`buildProductSessionPrompt()` 生成共同的场景/能力内容，再由两个公开出口投送：

- `buildSystemPromptAppend()` 为内置 Claude Agent SDK 和外部 CLI 生成整段 append；
- `buildDshSystemContext()` 为 Integrated DSH 输出有名字、顺序和 scope 的
  `SystemContextSnapshot`，避免把产品变化重新硬编码进 Runtime。

调用方传入：

- `InteractionScenario`：当前 Session 的交互入口和场景。
- `runtime`：用于生成准确的 Runtime 身份描述。
- `cliToolsEnabled`：是否追加稳定的 MyAgents CLI 能力提示；当前 Builtin 和全部
  External Runtime 路径都传 `true`。
- `userCliToolsEnabled`：是否读取用户 CLI 工具注册表，受实验开关控制。
- `enabledOfficialToolIds`：当前 Session 实际启用的官方 CLI 工具。

模板直接内联在 TypeScript 中，不从运行时文件系统加载。单文件 bundle 不能依赖源码
目录中的模板路径；内联内容让生产包与源码使用同一个事实来源。

受管「浏览器」的登录态保存不属于 Prompt 契约。应用级 Browser Host 会在成功工具调用和 Context teardown 边界自动 checkpoint Cookie；模型无需、也不应被提示主动调用存储工具来维持产品正确性。该 headed Context 不使用 Playwright `storageState()`，避免身份维护创建用户可见的临时页面；localStorage 与 IndexedDB 不跨 Product Session 恢复。标准 `playwright` 仍遵循上游 MCP 的 argv/storage-state 语义，MyAgents 不用隐藏 Prompt 改写它。

固定 Channel prompt 的准入由 Rust Session owner 的 `/api/im/channel-context` 返回的精确绑定投影为 `channelBound`；Agent 能力列表不参与该判断，builtin 与 external/DSH 共用入口。`scenario` 描述入口能力，不断言消息来自桌面；已绑定渠道不注入 Widget 指南。打开或从桌面输入不改变既有发送模式，实际来源与模式仍由 admission 的逐轮上下文描述。产品身份按需使用 `myagents agent current --json`，构建诊断使用 `myagents version --json`，不逐轮注入内部 Runtime ID 或构建指纹。

### 场景模型

`InteractionScenario` 当前有五类：

| 场景              | 关键区分                                                      | 说明                                   |
| ----------------- | ------------------------------------------------------------- | -------------------------------------- |
| `desktop`         | `surface: chat \| floating-ball`                              | 桌面 Chat 或浮球小窗                   |
| `im`              | platform、private/group、botName、hostInteraction             | 内置 IM 入口                           |
| `agent-channel`   | 任意 platform、private/group、Agent/Bot 信息、hostInteraction | OpenClaw 等 Channel 入口               |
| `cron`            | taskId、intervalMinutes、aiCanExit                            | Task/Cron 后台执行；枚举名保留兼容语义 |
| `registeredAgent` | Space ID、Registered Agent ID                                 | Space IssueDelivery 入口               |

`hostInteraction` 主要参与工具可用性和交互策略，不会自动变成一个通用 Prompt block；
只有确实需要模型知道的 Runtime/Channel 限制才应显式追加 Prompt。

### 组装层次

当前产品级 append 分为四类内容：

| 层                | 职责                                                                           | 组合方式             |
| ----------------- | ------------------------------------------------------------------------------ | -------------------- |
| L1 基础身份       | MyAgents 身份、当前 Runtime、全局目录、时间判断约束                            | 始终包含             |
| L2 交互渠道       | 静态渠道概念；逐轮 CHANNEL_CONTEXT 提供实际绑定与输入来源                     | 不以桌面 Tab 推断渠道 |
| L3 场景与产品交互 | Task、Heartbeat、Registered Agent、浮球、Widget、Session 协作                  | 按条件叠加           |
| L4 CLI 能力发现   | Task、Goal、Record、IM 媒体、Vision、用户注册工具                              | 按场景与能力开关叠加 |

### 当前预设片段矩阵

下表记录选择规则，不复制完整 Prompt 原文：

| XML-like block                           | 主要内容                                                | 注入条件                                           |
| ---------------------------------------- | ------------------------------------------------------- | -------------------------------------------------- |
| `myagents-identity`                      | 产品身份、准确 Runtime 名称、`~/.myagents`、时间检查    | 全部场景                                           |
| `myagents-cron-task-instructions`        | Task ID、触发间隔、可选自结束说明                       | `cron`                                             |
| `myagents-heartbeat-instructions`        | 如何处理周期 Heartbeat                                  | `im`、`agent-channel`                              |
| `myagents-registered-agent-instructions` | Registered Agent 身份、Issue 行动边界与当前状态读取要求 | `registeredAgent`                                  |
| `myagents-floating-ball-instructions`    | 小窗回复应简短、桌面相邻上下文                          | `desktop.surface === floating-ball`                |
| `myagents-generative-ui`                 | Widget 触发规则及按需读取设计契约                       | 全部 `desktop`，包括浮球                           |
| `myagents-session-events`                | Agent/Session identity、start/send/watch 协作方式       | 全部场景                                           |
| `myagents-cli-task-automation`           | “以后再做”统一使用 Task Skill/CLI，不用 OS cron         | 全部场景                                           |
| `myagents-cli-goal`                      | Goal Mode 只在用户明确要求时创建                        | `desktop`，以及私聊 `im` / `agent-channel`         |
| `myagents-cli-task-exit`                 | 目标完成时用 CLI 提前结束 Task                          | `cron && aiCanExit`                                |
| `myagents-channel` | `对话环境` / `消息发送` 两个子标题；渠道身份概念、auto/tool_only、当前直发与跨会话交接、CLI help 导航 | IM/Channel，或具有渠道发送能力的其他场景 |
| `myagents-cli-record`                    | 仅在用户明确要求“记一下”时创建文字 Record               | `desktop`，以及私聊 `im` / `agent-channel`         |
| `myagents-cli-vision`                    | 当前模型不能读图时调用图片理解 helper                   | Session 启用 image-understanding 官方工具          |
| `myagents-user-tools`                    | 用户注册 CLI 工具的名称、description 与发现方法         | 实验开关开启且注册表存在 enabled 工具              |

`cron` 与 `registeredAgent` 使用 desktop-style shell I/O 的 channel block，但不因此成为
桌面交互场景；它们不会获得 Widget、Record 或 Goal 的桌面能力提示。

### 渐进披露与工具边界

System Prompt 的职责是让模型在正确场景“想起” MyAgents 能力，不是承载每项能力的
完整手册：

1. 稳定产品能力只注入触发条件、关键边界和发现命令。
2. 完整用法由模型按需执行 `myagents <topic> readme` 或 `--help` 获取。
3. 用户注册工具只注入 enabled 工具的名称与 description；实际执行由
   `~/.myagents/bin` shim 和工具目录拥有。
4. 用户工具注入最多展开 `CLI_TOOL_PROMPT_MAX_TOOLS` 个，超出部分降级为
   `myagents tool list` 指引；description 也有独立长度上限，避免注册表无限挤占上下文。
5. 注册表读取使用 mtime + size 缓存。开关或注册表变化影响下一次 Session 创建 /
   pre-warm，不会 retroactive 改写已运行 Session 的 Prompt。

Prompt 中出现一个能力名称，不等于真实 Tool 已被注册或授权：

- SDK builtin tools、MCP tools、Codex dynamic tools 的 schema 由各自 Runtime/Session
  配置提供。
- Tool 是否可见、是否允许执行由工具 surface、permission policy、hooks 和 adapter
  共同裁决，不能只靠 Prompt 文字实现权限。
- Skill 正文由 Runtime 的 Skill 机制按需加载；Prompt 可以路由到 required system
  Skill，但不应复制整份 `SKILL.md`。
- `.claude/agents/*.md` 的 body 是委派给特定 sub-agent 时的角色 Prompt，不属于这里的
  全局产品 append。

## Workspace 指令文件

设置界面的“系统提示词”面板管理 `CLAUDE.md` 和 `.claude/rules/*.md`。这些文件属于
具体 Workspace 的用户/项目指令，不是 `buildSystemPromptAppend()` 中的 MyAgents 产品
模板。

不同 Runtime 使用各自最忠实的加载方式：

| Runtime                  | 产品级 Prompt                                               | Workspace 指令                                                                                                |
| ------------------------ | ----------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------- |
| Builtin Claude Agent SDK | Claude Code preset + `systemPrompt.append`                  | `settingSources: ['project']` 原生读取项目配置；全局启用 Skill 先投影到项目目录                               |
| Claude Code CLI          | 临时文件 + `--append-system-prompt-file`                    | Claude Code 原生发现 `CLAUDE.md` / rules                                                                      |
| Antigravity CLI          | ACP 建立或恢复会话时传入 `_meta.antigravity.systemPrompt.append` | Host 补充根目录 `CLAUDE.md`（若工作区内 `AGENTS.md` / `GEMINI.md` 已通过同路径或等价内容原生加载则去重跳过）、`.claude/CLAUDE.md`、`.claude/rules/`，以及去重后的启用 Skill `<myagents-skills>` 渐进披露索引 |
| Codex                    | `thread/start` / `thread/resume` 的 `developerInstructions` | Codex 原生发现 `AGENTS.md`，并将 `CLAUDE.md` 配为 fallback；MyAgents 另外把 `.claude/rules/*.md` 格式化后追加 |
| Integrated DSH           | 当前生成契约中的 `systemContext.sections/contexts`        | DSH 每目录互斥加载 `CLAUDE.md` → `AGENTS.override.md` → `AGENTS.md`；Host 仅冻结 `.claude/CLAUDE.md` 与 rules companion supplement |

External Runtime 的兼容读取拒绝 symlink，并限制递归深度、文件数量、单文件大小和总
大小，避免 Workspace 文件把任意工作区外文件或无界内容注入模型上下文。

Workspace Skill 是另一条 progressive-disclosure 管线，不属于 Workspace instruction
正文。Host 默认按 `.claude/skills`、`.agents/skills` 的顺序合并有效候选；相同有效
folder 由前者优先，resolver/adapter API 可传入 ordered subset。初始 Prompt 只出现有效
name/description。Integrated DSH 在调用 Skill 时通过 DSH `resourceBase` 暴露 package
目录，Codex/Claude 继续使用各自 native parser；`references/`、`scripts/`、`assets/`
只在模型实际需要时由普通工具读取，不递归塞入 system Prompt。

## Runtime 投送与生命周期

### Builtin Claude Agent SDK

`src/server/agent-session.ts` 在 Query 创建时使用：

```text
systemPrompt = { type: preset, preset: claude_code, append: MyAgentsPrompt, snapshot: false }
```

因此 Claude preset 仍拥有底层工具约定，MyAgents 只追加产品身份、场景与能力提示。
`currentScenario` 必须在 Query birth 前设置正确；persistent Query 创建后，普通状态变量
变化不会原地重写其 system prompt。

SDK 默认会记录并跨 resume 复用 system prompt；Builtin 显式关闭该快照，保证同一 native Session 的 Query replacement 仍采用本次 assembler 生成的产品 append，而不是等到下一次 compaction 才生效。此处保留产品配置生效契约；不能为了缓存命中率直接移除 `snapshot: false`。

### External Runtime

`src/server/runtimes/external-session.ts` 统一调用同一个
`buildSystemPromptAppend()`，再追加必要的 Workspace 指令和确属特定 Runtime 的限制，
最后把 `systemPromptAppend` 交给 adapter：

- Claude Code：写入有界生命周期的临时文件并使用
  `--append-system-prompt-file`；保留 Claude Code 默认 preset 和 OAuth/Keychain 行为。
- Codex：使用 `developerInstructions`，新建与 resume thread 都走同一字段。
- Antigravity 在建立或恢复会话前检查 ACP 的场景指令追加能力。需要投送指令而 CLI 不支持时，启动会返回错误。

### Integrated DSH

DSH 不消费上述单体 append。`external-session.ts` 在 Session create/resume/config apply
边界调用 `buildDshSystemContext()`，按下列稳定顺序发送：

1. `global/product-identity`（order `-80`）：MyAgents 产品身份；
2. `global/capability-routing`（order `-70`）：按需使用 Tool/Skill，不把 Prompt 当权限；
3. `root/product-session`（order `10`）：当前 scenario 和产品会话内容；
4. Runtime 根据 initialize 已接受的执行环境注册 `runtime:workspace` context（order `90`）；
5. 可选 `global/workspace-supplement` context（order `100`）：Claude companion 文件。

Runtime 自己维护更稳定的操作契约和 compaction continuity；Host 维护会随产品演进的
身份、场景和 companion 内容。正文按 literal Markdown 投送，`{{...}}` 不做 DSH 变量
替换。Snapshot 的 revision fingerprint 参与 DSH config identity；相同内容不触发无意义
replacement，已有 admitted turn 仍使用 birth 时冻结值。

`runtime:workspace` 只告诉模型受管 Workspace 的规范绝对路径，并由 DSH scope 传给 fresh
child；它不增加 allowed root，也不授予文件或进程权限。该值属于 Workspace binding 的
动态 context，不进入更稳定的 system-section 前缀，也不需要 Host 在产品 snapshot 中
重复维护。

根目录/嵌套主指令由 DSH Agent Instructions 自己发现和写入 durable Session：同一目录
只取首个非空的 `CLAUDE.md`、`AGENTS.override.md`、`AGENTS.md`。Host collector 不再把
这些主文件重复塞入 DSH system context；它只收集 `.claude/CLAUDE.md` 和按 code-point
排序的 `.claude/rules/**/*.md`，并遵循现有 symlink/深度/数量/大小边界。

Managed Codex 的 IM/Agent Channel 当前还会在中央 assembler 之后追加
`myagents-managed-codex-interaction-limits`：禁用结构化问答工具的场景必须改用普通聊天
文本向 IM 用户澄清。这是 Runtime capability 限制，不应伪装成通用场景规则。

### Pre-warm 与场景变化

Pre-warm 创建的是后续直接复用的真实 Session/Query，所以 Prompt 在 pre-warm 时就已
固化。新增场景或能力时必须同时检查：

- pre-warm 创建时是否已经知道正确 `InteractionScenario` 和能力 snapshot；
- 修改开关后是否需要现有 deferred replacement / restart 路径，而不是期待原地改写；
- 场景事实是否每轮都会变化，若会变化，应进入 `system-reminder` 而不是扩大 persistent
  Prompt。

浮球是典型双层设计：Session 创建时追加小窗交互约束，每条浮球消息再携带
`FLOATING_BALL_CONTEXT` reminder。后者既承载当前 app/window/selected text 等动态
事实，也覆盖已预热 Session 不能重新组装 Prompt 的情况。

## 与 System Reminder 的关系

`<system-reminder>` 是注入 Session 的 leading user-message envelope，让模型看到隐藏
payload，而 UI 只展示 envelope 后的 visible tail 或 badge。它适合 Turn 级动态上下文，
不属于 persistent system prompt，也不会提升消息权限。

当前典型使用包括：

- Task/Cron 唤醒和结果转述；
- Task discussion 首轮动态上下文与本地 Task Comment query；
- Goal 首轮、自动 continuation 与普通 query context；
- 浮球当前窗口、选中文本和截图上下文；
- Space IssueDelivery；
- IM Heartbeat、群聊身份/回复规则和群聊自定义指令；
- Memory Update、watchdog resume、跨 Session 事件。

生产、解析、escaping、badge、搜索/标题/预览过滤及前端接入 Checklist 全部以
[`system_reminder_protocol.md`](./system_reminder_protocol.md) 为准。这里只保留选择边界：

| 需求                                                     | 应使用                                     |
| -------------------------------------------------------- | ------------------------------------------ |
| Session 整个生命周期都成立的产品身份或能力发现           | 产品级 system prompt append                |
| 用户为某 Workspace 配置的长期规则                        | `CLAUDE.md` / rules / Runtime 原生项目指令 |
| 每轮变化、需要唤醒 Session、或只希望模型看见的动态上下文 | `system-reminder`                          |
| 图片、文件、工具大结果                                   | `ToolAttachment[]`，不要塞进 Prompt 字符串 |

安全上，`system-reminder` 只控制展示，不是 trust boundary。来自用户、群聊、Cloud、
Plugin 或工具的数据仍需结构化标记、转义并声明为 untrusted context，不能因为被隐藏就
当成系统指令。

Task 智能讨论采用“薄动态 reminder + product-owned Skill”分工：`TASK_DISCUSSION` 只携带 discussion/workspace/可选 Record identity 和原始 visible tail，`InitialMessage.requiredSystemSkill` 要求 app-owned `myagents-task-alignment` exact source/hash/inventory revision。澄清方法、完整 `task.md` 写作和确认协议留在 Skill；Task 参数事实由 `myagents-task-automation` 与 CLI leaf help 按需披露。不得在 App handler 再复制问卷、参数矩阵或四文档模板，也不得仅靠 slash 文本猜 Skill 已加载。

## 其它独立 Prompt

仓库还有一些有意独立于对话 Session assembler 的专用 Prompt：

- title generator 的一次性分类 Prompt；
- provider verification 的最小测试 Prompt；
- image-understanding official tool 内部模型 Prompt；
- sub-agent definition body；
- Plugin/Command 展开后只对某一 Turn 生效的 Runtime input。

它们不应为了“统一文件位置”并入 `buildSystemPromptAppend()`。只有所有对话 Runtime 都
需要发现、且与 Session 场景/产品身份有关的长期指令，才属于本文的产品级 append。

## 修改指南

### 新增或修改 persistent Prompt block

1. 先判断内容是否在整个 Session 生命周期内稳定；若只是 Turn 级事实，改走
   `system-reminder`。
2. 在 `system-prompt.ts` 或 `system-prompt-cli-tools.ts` 的现有 owner 中增加自包含
   block，不在 route handler 里手拼第二套产品 Prompt。
3. 明确场景矩阵：desktop / floating / private / group / cron / registeredAgent，以及
   Builtin / External 差异。
4. 能通过 `readme`、`--help`、Skill 或 Tool schema 按需发现的细节不常驻复制；Prompt
   只保留触发条件和高代价边界。
5. 检查 pre-warm、resume、replacement 和 live Session 不可变语义。
6. 更新本文件的片段矩阵，并补 `system-prompt*.unit.test.ts` 中相应的 inclusion / exclusion
   断言；若影响 DSH，同时断言 contribution id/order/scope、literal body 与 legacy Runtime
   不回归。

### 新增动态 Reminder

不要在业务 route 里直接复制 envelope 规则。先阅读并遵守
[`system_reminder_protocol.md`](./system_reminder_protocol.md) 的 builder、escaping、前端
badge、visible tail、标题、预览、搜索和测试 Checklist。

### 新增 Runtime

新 adapter 必须说明：

- 如何保留 Runtime 原生 base prompt；
- 如何投送 MyAgents product append；
- 如何发现或兼容 Workspace 指令；
- Prompt 在 start/resume/replacement 中何时固化和清理；
- 哪些差异是真实 Runtime capability 限制，不能靠 Prompt 假装支持。

## 文件索引

| 文件                                               | 职责                                                                  |
| -------------------------------------------------- | --------------------------------------------------------------------- |
| `src/server/system-prompt.ts`                      | 场景类型、基础/channel/scenario 模板、中央 assembler                  |
| `src/server/system-prompt-cli-tools.ts`            | 稳定 CLI 能力、Widget、Session collaboration Prompt blocks            |
| `src/server/utils/cli-tools-registry.ts`           | 用户 CLI 工具注册表的 Prompt projection 与缓存                        |
| `src/server/agent-session.ts`                      | Builtin SDK systemPrompt append、persistent Query 生命周期            |
| `src/server/runtimes/external-session.ts`          | External Runtime 的统一组装、Workspace merge、Runtime-specific append |
| `src/server/runtimes/workspace-instructions.ts`    | Codex/Antigravity 指令兼容与去重、DSH companion 补充与安全上限        |
| `src/server/runtimes/antigravity-skills.ts`        | Antigravity 启用 Skill 渐进披露目录投影与原生发现去重                 |
| `src/server/runtimes/claude-code.ts`               | Claude Code append-system-prompt 临时文件投送                         |
| `src/server/runtimes/codex.ts`                     | Codex developerInstructions 投送                                      |
| `src/shared/systemReminder.ts`                     | 通用 reminder 解析、escaping 与共享 builders                          |
| `src/renderer/components/SystemPromptsPanel.tsx`   | Workspace `CLAUDE.md` / rules 的用户编辑界面                          |
| `src/server/system-prompt.unit.test.ts`            | 场景级产品 Prompt 回归                                                |
| `src/server/system-prompt-cli-tools.unit.test.ts`  | CLI capability 条件矩阵回归                                           |
| `src/server/utils/cli-tools-registry.unit.test.ts` | 用户工具 Prompt projection 与保险丝回归                               |

## Channel 固定提示与逐轮事实

`channelPrompt.ts` 保存固定 S1 渠道身份原则、S2 统一发送能力、渠道澄清方式和 S3 Managed Codex 提问规则；`system-prompt.ts` 按场景/实际能力选入，禁止在稳定 system 段插入本轮 mode、sender、chat 或时间。原 `myagents-cli-im-media` 被统一发送能力取代；两种模式均有工具，区别由每轮 reminder 明示。Managed Codex 没有可用原生卡片时按本轮发送方式提出问题，不能无条件假定文本会回推。

每次实际 admission 经 `session-core/channel-context.ts` 捕获有效配置和调用入口，再用 shared renderer 合成；builtin 与 external/DSH 共用同一 schema/模板。DSH 沿既有 root/product-session 注入固定段，逐轮事实仍属于 User reminder。完整协议与快照见 [System Reminder](system_reminder_protocol.md#channel-context)。

渠道提示词只属于 Rust 确认当前实际绑定的 Session：固定 system 段与逐轮 `CHANNEL_CONTEXT` 都按精确绑定准入，不能用 Agent 的渠道能力列表或入口 scenario 代替绑定。桌面打开已绑定 Session 保留渠道语义；未绑定桌面即使所属 Agent 有渠道也不注入。mode 切换不修改固定 system 前缀，实际执行轮快照与下一轮生效策略不变。

内部 schema 保留完整状态与 null 进行校验；模型 facts 仅投影 connection/self/conversation/sender/message，递归省略未知字段和空对象。connection 存在时只补 source 和 time（本轮开始时刻与时区）两个执行信息；execution/delivery/projection 整组不进入模型。发送状态由一句自然语言 instruction 表达，参数与连接能力按需从 CLI 查询。

静态 Channel 段只在精确绑定存在时加载；无绑定桌面不加载该段，Agent 的渠道能力仍可通过 CLI 按需查询。当前直发与跨会话交接的概念固定；参数、首次回执与重试说明下沉 CLI help。引用/历史是背景，不是当前发言。

### Channel 交接的稳定前缀与动态指令

`CHANNEL_PROMPT` 声明两种发送模式、当前/其他会话的行为与普通文本/原生卡片澄清原则，不放实际模式、ID、名字或时间。跨会话内容通过 `send.request.channelHandoff` 进入原 Inbox，渲染器先生成唯一 `instruction`（来源性质、结合 context 转达 payload、尚未外发）；实际 turn owner 再用冻结的模式追加发送说明，并在其后插入仅含事实的 `CHANNEL_CONTEXT`。Runtime 都复用 `decorateChannelQuery`，不在发送端固化目标模式；不新增原生发送工具。

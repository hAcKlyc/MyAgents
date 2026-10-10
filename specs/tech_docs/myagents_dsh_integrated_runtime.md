# Integrated DSH 接入架构

> 本文描述当前客户端如何接入 MyAgents-dsh：进程与数据 owner、协议准入、配置、交互、历史恢复和联合 mutation。安装版本、方法、字段及能力以 Release 选择、effective lock、生成契约和实现为准；发布记录与验收流水账不属于本文。

## 1. 职责与进程

```text
Renderer / IM / Task / Goal / Inbox
  → SessionEngine selector
  → integrated adapter
  → external-session queue / config / transcript / interaction owners
  → DSH RuntimeProcessHost + generated client
  → Session-owned DSH process
  → native Session / AgentLoop / tools / children / jobs
```

| 事实 | Owner |
|---|---|
| Product Session、冻结 runtimeBinding、配置快照、UI transcript 与目录 | Host SessionStore |
| Tab、Sidecar generation、进程保活与删除 lifecycle fence | Rust SidecarManager 与领域 owner |
| 产品消息准入、队列、交互和结果投影 | SessionEngine 与 external-session owners |
| DSH 子进程、stdio 请求与 reverse ports | RuntimeProcessHost |
| 原生 Session/Turn、模型上下文、工具、子 Agent、Shell Jobs | DSH Runtime |
| 原生 JSONL、locator、checkpoint 和 mutation receipt | DSH 原生 persistence 与 Product 协调 owner |
| Provider、凭据、代理选择、产品扩展与附件交付 | Host 的既有 owner，通过声明与 reverse ports 提供 |

一个活跃 Product Session 最多有一个 Session Sidecar；该 Sidecar 的 DSH adapter 连接一个 Runtime generation。DSH 不是全局 daemon，不增加 TCP listener。Renderer 不直接消费 DSH wire，Rust 不解析 Runtime frames。集成复用既有队列、Store、SSE、附件和领域 owner。

## 2. Runtime 选择与冻结身份

产品发行版始终开放 Agent Runtime 选择。普通 API Provider 上，Agent 的明确 `runtimePreference` 优先；未选择时采用通用设置的 `defaultIntegratedRuntime`，缺失或不在发行 allowlist 时采用构建默认。该默认只有 Claude Agent SDK 与 DSH 两项，不自动写回 Agent。

Provider constraint 优先于通用默认：官方 Anthropic subscription/API 使用 Claude Agent SDK，`codex-sub` 使用 Managed Codex；其他 Provider 按声明的 API family 与模型能力解析。不能为了选择 DSH 把固定 Provider 伪装为普通 API。

出生时将 effective identity 固化为 Session `runtimeBinding`。已有 Session 使用自己的 binding 与配置快照；默认值或 Agent 设置变化不替换它。未知 binding 保留历史读取，不能静默改成 SDK。DSH 的 integrated engine kind 也不能进入 SDK 专属配置或 enqueue 分支。

桌面首轮的具体 `providerRoute` 经 SessionEngine 保留在原 message operation 的配置快照，并在原生启动时交给 DSH；此时 Product metadata 尚未准入，不能重新从 Agent 模板猜测已选 Provider。原生准入后的 Product 出生使用同一 operation 快照固化 Provider/model/权限/推理配置。已有 Session 的 Provider 读取与配置 adopt 复用 `resolveWorkspaceConfig` 的 owned snapshot / legacy 解析，缺失或无法唯一解析时明确失败，不借用 Agent 最新默认。外部 CLI Runtime 仍管理自己的 Provider，不消费这项 DSH 配置。

## 3. 构建与协议准入

`src/shared/integrated-runtimes/dsh-release.json` 是正式 Runtime 的版本选择。构建准备读取该 Release 的四平台资产清单，校验归档、handoff、Runtime 与契约身份，再派生本次 effective lock。已提交的 `dsh-lock.json` 和静态生成契约是未准备 source-mode 的编译快照；不能拿其中旧摘要拒绝本次已验证选择。

打包 Dev 默认也使用 Release；显式 `local` 才从绝对 handoff 路径构建。Vite、Sidecar esbuild 和 Rust build.rs 必须消费同一次选择，不能混入另一 target 或 generation 的身份。Release 准入按整包 SHA-256 与少量身份清单验证，不重扫暂存后的全部文件；显式本地 handoff 仍用公共 verifier 全量校验。运行时只核对受信资源路径、必要文件和实际协议握手，不重新扫描整个交付清单。安装诊断单独读取现有 handoff/Runtime 身份清单，报告实际版本、源码提交与清单摘要；清单不可读时返回 `dsh_identity_unavailable`，不改变资源可用性或执行准入。诊断摘要不是全量产物校验。

DSH 使用应用内置的单一 Node，不回退系统 Node。Node/npm 组合由 `scripts/node-runtime.json` 决定，handoff 声明其所需 Node；构建入口只核对版本要求，结构校验使用构建机 Node，不执行目标 Node 或 Runtime self-check。源码 setup、本地 handoff 和平台构建入口见 [构建资源准备](build_resource_preparation.md#integrated-dsh-构建来源) 与 [内置 Node](bundled_node.md#integrated-dsh)。

`contracts/myagents-dsh/public-contract.generated.ts` 与构建派生契约提供 wire 类型、validator、方法 inventory 和协议版本。Host 不手写另一份协议 schema，也不把“方法存在”当成能力已接纳。

进程启动依次完成：

1. 解析受信安装目录、canonical workspace 与 Session-owned roots；
2. 冻结 executionEnvironment、进程环境和 generation identity；
3. 注册 reverse handlers，完成 `initialize` 的精确版本、格式、profile 与 capability 检查；
4. 发送 `initialized`，读取状态并 create/resume 原生 Session；
5. 准入成功后才允许用户 turn。

进程状态与 turn activity 分开。pre-warm 可建立真实 idle Runtime，但不能制造 running turn。transport/process failure 必须通过 `session_complete` 交给共享 lifecycle owner 释放该 generation；仅发 error status 会留下无法恢复的 running/process 状态。

## 4. 数据与持久化

`dshSessionOwnedPaths()` 用 canonical Product Session id 的稳定摘要派生：

```text
<app-data>/dsh-runtime/<session-identity-hash>/
  sessions/<generation-id>/.../*.jsonl.zstd
  persistence/coordination.sqlite
<app-data>/dsh-attachments/<session-identity-hash>/
```

原生对话事件由官方 DSH JSONL persistence 管理，采用官方 V4 编码与项目/Session 目录布局。`coordination.sqlite` 每个 Runtime home 一份，只保存 locator、mutation journal、checkpoint 与文件 preimage，不保存原生会话事件。原生查询还可使用可丢弃的进程内 SQLite 派生索引；它不是第二份会话 authority。

Host 的 `sessions.json` 与 Product transcript 属于另一层：它们服务列表、UI、搜索和产品恢复。两份历史通过明确 identity 与 receipt 对齐，不能把产品气泡当作原生执行证明，也不能用原生日志替换产品历史。

Host 只接入匹配当前生成契约的 DSH 进程；原生格式解析由官方 JSONL codec 拥有。旧开发数据在写入进程停止后手动清理；应用中没有自建旧 DSH schema 迁移、开发数据自动重置或自动删除入口。其他 Runtime 仍在执行的兼容行为独立维护。

V2 产品记录先更新 canonical live projection，再由 TranscriptWriter 后台保存。正文 IO 失败或悬挂不阻止后续 AI turn；执行 journal 保留尚未落盘的准确输入与 generation。fork/rewind/reset/delete 仍遵守各自的物理写权限与发布边界。详细保存和恢复协议见 [Product transcript V2](session_transcript_v2.md)。

## 5. 模型、凭据与网络

`profile-compiler.ts` 将 Host Provider/model 能力编译为声明式 model profile。通用接口按 Anthropic Messages、OpenAI Responses、Chat Completions 分流；DeepSeek 官方路径使用原生 adapter。模型能力、reasoning 选项与子 Agent 可选集合来自当前 Provider inventory，不另建静态白名单。不可表达的可选参数采用该模型的合法默认，不使基础模型失效。

Provider credential 由 Host 的既有配置或认证 owner 管理，每个模型请求通过 `host/credential/resolve` 获取有效凭据和有界 `providerNetwork`。secret 不进入 profile、Session、argv 或常规日志；退休 generation 的 credential plane 只服务原请求，直到对应进程关闭后释放。

代理有两个 scope：模型请求采用 Provider policy；普通网络与 Shell 使用 Host 创建进程时冻结的 general snapshot。并发模型请求各自拥有连接池，不能切换进程全局 dispatcher。general 配置变化沿共享 config lifecycle 在 idle 边界换代，当前 turn 不被中断。

原生 `web_fetch` 由 Runtime 的安全 HTTP 与内容转换链执行，包含 PDF 转换；`web_search` 消费准入的 Host 搜索 backend。Host canonical Web 工具仍有自己的 dispatcher。直连校验并 pin 公网 DNS answer；显式代理仍检查 URL、hostname 和字面量 IP，域名解析交给代理。不能把代理路径描述为本地 DNS pinning，详见 [代理配置](proxy_config.md)。

子进程环境采用 allowlist。PATH 使用应用工具入口和已发现的用户执行环境；只准入 OS、用户目录、locale、临时目录和标准 proxy 等必要变量；bundled Node 目录排在 PATH 首位。内部 CLI capability 通过专用 token 注入，Provider/MCP secret 不因继承整个 `process.env` 泄漏给 Shell。

## 6. Prompt 与扩展

扩展完整快照经既有 `DshAttachmentRegistry` 发布为不可变 JSON；`extension/replace` 只传摘要引用。Runtime 在进入原有组件事务前通过 generation-scoped lease 校验大小、字节 SHA-256 与 canonical snapshot digest，并释放 lease。启动和 live replacement 共用这条路径，不能把全部技能正文重新塞进有界协议帧。协议精确版本仍由所选 handoff 决定；新的资源表示需要匹配的 Runtime。stdio 与带凭据的 remote MCP 使用 native credential owner 接受的环境变量名格式引用；启动环境与 secret 仍留在 Host reverse plane。

Host 以结构化 `systemContext` 提供 global/root contributions；DSH 的 literal-context seam 保留文本语义，不将产品提示词改写成组件摘要。主项目指令由 DSH 原生 instruction plugin 加载，每层目录按 `CLAUDE.md`、`AGENTS.override.md`、`AGENTS.md` 的优先级选择。Host 只补充其拥有的 companion/rules 内容，不重复读取原生主指令。

Skills、Commands、MCP 与 Host tools 等组件由同一次 Product capability inventory 编译。DSH 与 Managed Codex 共用 runtime-neutral `product-extensions` discovery/dispatcher；执行仍属于各自 Runtime。Host 也会生成 Agent descriptor，但当前 DSH 没有对应的角色编译器，这类组件返回 `unsupported/implementation_batch_pending`，不会据此创建子 Agent。子 Agent 由 DSH 原生工具创建并管理，Host 不运行第二套 Agent loop。

组件身份以 `(kind, id)` 为作用域；不同类型同名合法，Skill 引用只在 Skill 类型内解析。组件损坏或不支持时，只淘汰该组件并产生结构化诊断；基础 Runtime 仍可用。缺省命令描述由 DSH 注册适配处补为命令名，公开名称与模板正文不变。MCP prepare 失败通过现有 Runtime stderr 记录组件和失败阶段，不记录原始远端错误文本、凭据或子进程输出。明确依赖 required system Skill 的 turn 才必须核对该 exact capability。扩展 replacement 在原生事务边界执行，并由 catalog/read-back 确认实际结果；SSE 仅投影状态，不成为配置 authority。

## 7. 权限、计划与问答

DSH 使用 `approval-required`、`workspace-autonomous`、`full-autonomous` 三种产品模式，不复用 Claude SDK 的传参字面量。前两项采用原生 workspace-write sandbox，最后一项为 danger-full-access；受限 Shell 无可用 sandbox 时拒绝执行。权限模式先成为 Session desired state，当前 turn 使用 admission snapshot，下一条 query 前由 `config/apply` 确认 approval/sandbox 的 effective state，失败则不发送该 query。

Root/child 共享 Session-tree 的精确 grant 与产品交互，但每次调用必须绑定原 generation、operation、Agent 和 tool call。approval 不自动覆盖其他工具或未来无关调用。用户等待不套普通执行 timeout；执行 deadline 从审批完成后开始计算。

AskUser 与权限卡片通过真实 response receipt 结算。选项与自定义文字都保留；无效回答、传输失败或未确认 ACK 不清卡片，也不伪报已回答。迟到回执不能关闭新 request。

Plan 是独立状态，不等同于 permission mode。Host 显式退出与 Agent 请求审阅分别按原生 Plan owner 的契约处理；审阅消费实际 plan 文件内容。UI 不用虚构工具成功替代原生状态。

原生 sandbox 约束支持该边界的工具，不代表整个 Runtime、MCP、Host reverse tools 或内部 CLI 都被同一个 OS sandbox 覆盖。协议固定 security literal 也不是每 Session 的 sandbox 状态报告；安全能力以 composition、有效策略与工具路径判断。

## 8. Turn、队列与输出

所有 desktop、IM、Inbox、Task、Goal 和后台 turn 都经过 SessionEngine。Root admission 在 `turn/start` 前保存准确 Product input 与 operation identity；原生 receipt 才证明输入消费。RPC 返回、HTTP queued、进程 idle 都不能代替真实 terminal。

普通消息由共享 operation queue 排序。realtime 只有在当前 generation 有明确 steer target 且原生确认输入接纳后成立；明确未接收可降级为 turn-boundary，transport uncertainty 不自动重发。冷恢复取得的 operation 不具备 same-turn steer 资格。force-start 先停止并结算旧 turn 的 partial output，再提升目标项，不能丢弃无关排队消息。

Live event inbox 按 generation、sequence 与 identity 串行处理。精确重复可幂等消费；gap、冲突或 replacement 触发既有恢复。空 delta 仍推进协议位置但不制造产品正文。工具输入中的非 object JSON 只包装展示，不改原生执行参数。

DSH 原生 Agent 目录投影到产品 Agent 树；个人任务按 Agent Session 读取，共享任务单独读取。中断只停止当前轮次，可延续子 Agent 可继续收消息。Shell Jobs 的创建、状态和停止归官方 Jobs/Shell 组件，不由 Host 重建调度器。

图片输出通过 Runtime image registry 与 generation-bound lease 进入共享 Tool Attachment 管道；图片字节不放入普通 event JSON。工具发布和模型随后读图各自取得有效 request scope。输入与 native history 的 image content reference 保留，由当前模型请求按能力消费，不通过永久改写历史移除图片。

Provider `server_tool_use` 是独立、有界的内容投影，不进入 canonical Host permission，也不作为 root loading 状态。usage/latency 等可选统计缺失时省略，不填假零；统计异常不阻断有效正文或 terminal。工具执行成功与输出发布失败分开报告，不能因附件不可用把已经完成的副作用改写为未执行。

## 9. 冷恢复与 native history

`session/read` 的分页 assembler 校验 exact Session/generation、head、hash、连续 cursor 和 `inheritedEventCount`。`cursor_stale` / `session_read_unstable` 时丢弃整轮部分结果，从第一页重读，最多三轮、每轮 1,024 页；其他协议、identity 或 hash 错误不套用通用重试。

继承前缀只提供模型/UI 上下文，不拥有目标 Session 的执行状态。startup 只查询并恢复 target-owned operations；源 settled root 保持源 identity。嵌套 fork 与 inherited-prefix rewind 使用官方 inherited scope 和 seed constructor，不能只拼接看似 hash 正确的 JSONL。

`pendingDshRootOperation` 与 `pendingDshRootInputs` 属于 Host 执行恢复 journal：

- 原生未接纳且产品正文也未出现的输入，可撤销未发布 admission；
- 产品已保存、原生明确未接纳时，只能按准确输入 identity 重试；
- 原生活跃 operation 由一个恢复 owner 接管；队列派发与 force-start 先等待该恢复完成，不能把进程已存在视为恢复已完成；
- 已 terminal 的 receipt 对账输出与真实结果，再退休 journal、推进队列。

失败/停止仍保留已产生的 partial assistant，结果保持真实失败/停止。不能因有文字推断成功，也不能在 acknowledgement 不确定时自动发送第二次 prompt。

## 10. Fork、Rewind、Retry 与 Delete

这些操作统一进入 SessionEngine adapter，由 Host journal 与 DSH native mutation receipts 协调；不在 Renderer 拆成多个请求，也不只修改 UI transcript。`pendingDshMutation` 保存 intent、token、fingerprint 与预期 postconditions，恢复先核对原生结果。

| 操作 | 提交顺序与结果 |
|---|---|
| Fork | 保存 intent → native prepare → 保存 token → 隐藏 Product target/附件 → native commit → 发布 Product target |
| Rewind | native commit 发布新 generation 与受治理文件恢复 → Product history 对齐同一 cut |
| Retry | 同一 mutation scope 完成精确 rewind，再走普通 desktop admission 重发原输入 |
| Delete | Rust lifecycle fence → native tombstone → Product 隐藏 → native purge → Product 删除 |

root 文件恢复只覆盖 checkpoint 所治理的原生 Write/Edit，不回滚任意 Shell 或子 Agent 文件副作用。连续 rewind 复用不可变 checkpoint 与已提交 retained cuts，不复制第二份恢复记录。Fork 不继承源 Goal、置顶、Tag 或 registered-Agent origin。

Retry 使用原生 operation anchor 区分未接纳与已接纳：前者只移除产品未执行尾部；后者必须建立精确 native rewind（包含 genesis 边界），再截断产品历史。失败响应区分会话是否已提交、文件是否已恢复与重发是否已接纳。丢响应后读取权威 receipt，不用旧前端快照覆盖，不自动重复 mutation。

DSH recovery admission 当前按未结算 mutation 的种类限制 prepare；具体 journal 的幂等由 mutation ID 与 fingerprint 决定。不能声称 Runtime 已在入口保证“只有完全相同的请求才能再次 prepare”。Host 应继续恢复自己的稳定 intent。

## 11. 维护与验证入口

| 路径 | 职责 |
|---|---|
| `src/shared/integrated-runtimes/` | distribution、resolver、Release 选择与 effective identity |
| `contracts/myagents-dsh/` | 公共生成契约快照 |
| `scripts/integrated-runtimes/` | handoff 准备、校验与构建选择 |
| `src/server/integrated-runtimes/dsh/process-host.ts` | process/transport、握手与 reverse request |
| `src/server/integrated-runtimes/dsh/runtime.ts` | AgentRuntime、native history、事件与操作 |
| `src/server/integrated-runtimes/dsh/profile-compiler.ts` | Provider/model profile |
| `src/server/integrated-runtimes/dsh/extension-compiler.ts` | Product capability 编译 |
| `src/server/integrated-runtimes/dsh/host-ports.ts` | Host reverse port dispatcher |
| `src/server/integrated-runtimes/dsh/attachments.ts` | 输入/输出引用与 lease |
| `src/server/session-engine/` | adapter、root recovery、mutation 与产品 projection |
| `src/server/runtimes/external-session/` | 共享 queue/config/interaction/transcript owners |

默认 unit/integration 使用 fake model、隔离目录和 loopback fixture；覆盖握手与失配、generation retirement、admission uncertainty、恢复、权限、steer、附件与联合 mutation。真实 Provider/native smoke 必须显式执行，结果只证明对应 artifact、平台与模型。构建验证不代替真实桌面交互验收，也不在状态文档固化某次测试数量、源码 hash 或机器记录。

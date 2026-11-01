# Session 架构

> 本文定义 Product Session 的身份、Owner、持久化、Runtime 绑定、恢复与配置裁决。字段、端点和事件清单以代码与类型为准；Sidecar 进程拓扑见 [`../ARCHITECTURE.md`](../ARCHITECTURE.md)。

## 1. 权威边界

Session 不是单一对象，而是同一产品会话在不同生命周期阶段的几种事实：

| 事实 | Authority | 说明 |
|---|---|---|
| Product Session identity 与 metadata | `SessionStore` | 稳定 `sessionId`、workspace、标题、Runtime 类型、配置快照等 |
| 当前 Product Session 绑定 | `session-engine/product-session-binding.ts` | 当前 Sidecar 正在服务哪个 Product Session |
| Runtime execution identity | 对应 SessionEngine adapter | builtin 的 SDK Session UUID；DSH/外部 Runtime 的 session/thread id |
| Sidecar 生命周期与 Owner | Rust `SidecarManager` | 创建、复用、replacement、Owner 附着与释放 |
| transcript | `SessionStore` | MyAgents UI、搜索与恢复使用的产品历史 |
| 当前 turn 与 Runtime queue | 对应 adapter | admission、执行、stop 与 terminal settlement |
| Goal 状态 | Rust `SessionGoalManager` | 独立于 Session metadata 与 Task 的 durable state |
| Renderer 投影 | `TabProvider` / `useTabState()` | 只投影当前 Tab 所属 Session，不反向成为业务 authority |

后产生的数据不自动获得上游写权限。例如，Runtime 返回的 SDK UUID 只能更新 execution identity，不能替换 Product Session id；IM 的实时配置不能覆盖已有 Session 的 owned snapshot。

## 2. Product Session 与 Runtime identity

每个 Product Session 有稳定的 `SessionMetadata.id`。它拥有历史、Tab/Sidecar scope、workspace、配置快照和产品级状态。Runtime 还可以拥有独立执行身份：

- builtin 使用 `sdkSessionId` 作为 Claude Agent SDK 的 create/resume candidate；
- DSH、Codex、Claude Code 使用 `runtimeSessionId`；
- Rewind、Fork 或 provider history 边界可以替换执行身份，但不得偷偷替换 Product Session identity。

普通新会话中两个身份可能相同，这只是初始化结果，不是可依赖的不变量。读取和写入 metadata 时使用 `src/server/types/session.ts` 的当前类型，不在文档中复制完整字段表。

`runtimeBinding` 是已有 Session 的执行权威，Agent/Channel 的 `runtimePreference` 只影响未来 Session。新 birth 写合法 binding 与 legacy `runtime/runtimeSource` 投影；启动迁移在 index lock 内补齐合法 legacy 行，未知组合保留证据并标记 `runtimeBindingCompatibility`，只允许读历史。Fork/snapshot 复制 binding 或 compatibility，不能用 fallback 拼接身份。

### 2.1 新建、恢复与 SDK probe

builtin 启动先解析持久化的 SDK candidate，再确认对应 SDK transcript 是否存在：

1. probe 成功且 transcript 存在时，以 `resume` 恢复；
2. probe 成功但 transcript 不存在时，以同一个 candidate fresh create；
3. probe 出错时拒绝启动，不回退到 Product Session id 或随机新身份。

普通创建/恢复路径中，`sessionId` 与 `resume` 互斥；旧 lazy fork 兼容路径使用 `forkSession: true`，允许同时指定来源 `resume` 与目标 `sessionId`。`resumeSessionAt` 只指定已选定 SDK history 中的边界，不证明该历史存在。显式回溯与旧 lazy fork 按 [§4.4](#44-rewindforkretry-与-reload-anchor) 保留其来源和边界，不因启动失败改成 fresh create 或完整历史。

### 2.2 pending materialization

`pending-{tabId}` 是尚未实体化的新 Tab identity。普通惰性出生在首个被 Runtime 接纳的 turn 时实体化；显式桌面出生可在首轮前完成 prepare → owner rekey → commit，绑定真实 Product Session。已提交的空 V2 Session 仍是有效会话，不能按 legacy 空草稿规则隐藏。

Chat 菜单在 pending 阶段展示本次启动已解析的 Runtime 意图；这只是 UI 投影，不伪造持久 metadata。`chat:system-init` 的 pending→real 升级经 App 接纳后，`TabProvider` 从当前 Session Sidecar 读取 metadata，菜单优先使用 birth snapshot；metadata 尚未写入时，可使用同一 Session 的 live Runtime 报告。SSE-native 新生会话不走历史 REST restore，因此这次 metadata 读取不能依赖恢复流程；请求结果和 live Runtime 都必须按当前 Session id 防止迟到写回。已有真实 Session 在自己的 metadata 或 live Runtime 到达前不借用当前 Agent 默认值或其它 Session 的 Runtime。

identity 迁移由既有 Session binding owner 裁决，不能产生两个可继续分叉的会话。V2 的 binding CAS 修改当前内存 metadata，保存由 TranscriptWriter 后台完成；legacy 路径由 `SessionStore` 在 source/target transcript 锁与 sessions index 锁内完成 metadata 发布、已有 transcript 重命名及失败回滚。

backend-created draft 使用 `materializationState: 'prepared'` 隐藏尚未提交的 metadata。所属出生事务 commit 或首轮 admission 与 rollback 经同一 binding/CAS 入口裁决；commit/admission 赢后清除 prepared，rollback 赢后不得继续发布 accepted。逻辑绑定成功不等同于 V2 已写盘，保存状态独立报告。

### 2.3 删除

用户删除的 lifecycle authority 是 Rust `cmd_delete_session_if_unowned`，不是 Renderer 或裸 HTTP storage delete。删除必须在 per-Session lifecycle fence 内同时确认：

- 没有 Task、Goal、IM binding 或其它非 Tab owner；
- active/recovering Sidecar 没有未授权 owner；
- Runtime 已明确 idle，或正在运行的 turn 已安全移交给 `BackgroundCompletion`；
- Node storage mutation 成功或幂等 not-found。

只有满足这些条件后，Rust 才释放调用方提交且已验证的 Tab owner。失败时保留 Session 与 Tab，不能用 Renderer 的 `isGenerating`、事前端口探测或列表缓存代替最终裁决。

### 2.4 DSH 原生存储

DSH 原生会话使用官方 JSONL persistence，Runtime 自己的 coordination SQLite 只保存 locator、mutation/checkpoint 和文件恢复记录。Host SessionStore 拥有独立的产品目录、transcript 与输入/mutation journal；二者以原生 receipt 对账，不互相替代。

每个 Product Session 的 Runtime home 与附件根由 `dshSessionOwnedPaths()` 派生，进程 replacement 沿用同一 home。当前接入没有旧 DSH 协议读取、开发数据重置或迁移入口；旧开发数据由维护人员在写入进程停止后手动清理。目录和恢复约束见 [DSH 集成指南](myagents_dsh_integrated_runtime.md#4-数据与持久化)。

## 3. Session metadata 的语义

### 3.1 配置快照

已打开 Chat 的配置快照修改通过 `sessionSidecarFetch` 携带 Tab owner 调用 `PATCH /sessions/:id`，由对应 Session Sidecar 的 `SessionStore` 同时发布磁盘 metadata 并更新活动 V2 binding。不能经 Global Sidecar 保存后仅推送 runtime config：下一轮的 Session 快照会仍读到旧 binding，覆盖刚选的新配置。生产 Session Sidecar 只接受自身 Session ID 的 PATCH；未打开会话的标题、收藏等管理修改保留 Global 入口。

`configSnapshotAt` 存在表示 Session 拥有自己的执行配置快照。此后缺失字段代表产品默认或未固定，不能重新回落到 Agent/Project 当前值。Agent/Project 配置只用于：

- 新 Session 模板；
- 尚未建立 snapshot 的兼容会话；
- 独立的 Cloud registered Agent live-follow 场景。

IM/Agent Channel 与桌面一样拥有完整 snapshot；消息、heartbeat、恢复均不回落到最新默认。新 IM Session 仅在出生时采用最高 unattended 权限。私聊 `/model` 经对应 Session Sidecar CAS 保存 snapshot，再经 SessionEngine 应用，并单独提交 Agent 默认（Team AI Agent 改为同步该 peer 的专属配置，见 `im_integration_architecture.md`「Team AI 管理投影」）；忙时下一轮生效。身份不兼容时主动创建并 handover，默认 reload 不再自动轮换。默认变化仅按既有私聊 binding 投递系统提示。

`providerRoute` 是 builtin provider/model 的 canonical identity，只持久化 provider 类型、provider id 与 model。API key、base URL、auth mode 和 aliases 始终从当前 `config.json` materialize，不能写入 Session 历史。`providerEnvJson` 只作为旧 Session 的只读兼容输入；新的 snapshot 写入必须使用 `providerRoute` 并移除 legacy env。

MCP 也是分层 authority：Session snapshot 冻结 server ID 选择，当前 `config.json` 拥有 server definition 与全局 enabled 安全总闸。执行前的有效集合为：

```text
session selected IDs
∩ globally enabled IDs
∩ current server definitions
```

同 ID definition 变化需要更新 Runtime MCP surface；Project 默认变化不能改写已有 Session 的选择。 新会话与无 snapshot 的兼容解析统一读取 Agent 的选择；Agent 存在时其缺省/空选择不会回落到旧 Project 镜像，只有无 Agent 才使用 Project。桌面 pending、reset、Companion、Task 的默认解析遵循相同规则。MCP 在进入 SDK 前构建失败时，由该 Query/map owner 保存有界失败码并进入现有 effective snapshot 与 pre-warm 裁决，不能从 desired 集合中消失。

### 3.2 活跃时间、置顶与 Tag

`lastActiveAt` 是 meaningful Session activity 的排序时间，不等于最后一条真人消息时间，也不随任意 JSONL 写入变化。被 turn lifecycle 接纳的可见工作在 admission 和 terminal 更新；pre-warm、replay、silent heartbeat、Memory maintenance 与纯历史重写不更新。需要真人输入时间的调用方应读取消息时间戳。

`pinnedAt` 只表示 Workspace Session 列表中的置顶顺序。置顶与 Tag 都是整理动作，不推进 `lastActiveAt`。Tag assignment 绑定 Product Session id；pending materialization 保留，Reset 与 Fork 不继承。所有 Tag mutation 由 `SessionStore` 在 sessions index 锁内以 typed intent 更新，Renderer 不提交 replacement array，也不维护第二份 Tag catalog。

## 4. Runtime 与 turn 生命周期

### 4.1 统一 facade

所有 Session 操作经 `src/server/session-engine/` 选择 adapter。Route handler 不自行判断 builtin/external，也不借用另一 Runtime 的 reset、Session 创建或 identity 逻辑。

Product Session 的 prepare/commit/rollback 由 `product-session-binding.ts` 管理。只有 adapter 完成自己的 Runtime 清理和准备后，新的 binding 才能发布。Global Sidecar 可以加载公共类型和工具，但不能建立当前 Product Session binding；Chat、IM、Inbox 也不能间接授予它此权限。

桌面 Tab / Companion 的 pending 出生由当前 Session Sidecar 的 `POST /api/session/birth` 准备快照，再走既有 materialize commit/rollback。Global 的 `POST /sessions` 仅创建未打开 target；不能用 payload flag 将当前 Session 出生发往 Global 路由。生产 role gate 必须参与入口回归测试，development-union 的成功不能证明生产边界正确。

版本化 Session 不参与 legacy pre-query 空草稿启发式：V2 已 commit 的空会话可读取，统计是否发布不能推翻出生。Node / Rust 的可见性判断共用 `session-history-visibility.json` 测试表；prepared 与系统维护会话继续独立隐藏。

### 4.2 builtin

SDK 合并后台 task-notification 时，前置通知可产生 `origin.kind=task-notification`、成功且 `num_turns=0` 的空 result 回执（0.3.276 实测不携带 `terminal_reason`）；它只确认通知被合并，不拥有产品 turn 的 terminal、usage、队列晋级或 rewind boundary。SDK iterator 在这些副作用前过滤该精确形态，其余真人、错误、取消和实际模型结果仍走原 turn owner。不能仅按空文本或零轮数忽略 result。

SDK `result.modelUsage` 是按模型累计的快照；0.3.277 起恢复和 fork 后也继承累计量。`builtin-session/turn-lifecycle.ts` 在真正接纳 result 为产品 turn 时按上一快照求差，`transcript-persistence.ts` 将本轮增量和原始累计快照写进 Product turn usage；有 assistant 时也写进消息 usage。新 Query 从当前 Product transcript 最近的 turn 快照恢复基线，包括没有 assistant 的 `/compact` 控制回合；rewind 截断的历史自然裁剪该基线。`conversation_reset` 记录空基线，避免下一次 Query 沿用清空前累计量。升级前的历史没有原始快照，首次恢复只采用 SDK 的扁平 `result.usage` 作为保守近似，并从该轮开始建立精确基线。空的后台通知回执及自动重试结果不推进基线；最终失败的重试结果仍记录实际用量。

`src/server/agent-session.ts` 是 builtin 的 public facade。可变状态按 owner 分布在 `src/server/builtin-session/`：

| Owner | 职责 |
|---|---|
| `lifecycle.ts` | SDK `Query`、pre-warm、abort、generation 与 Query-scoped resources |
| `queue.ts` | desktop realtime/turn-boundary queue、in-flight item 与 admission ticket |
| `turn.ts` / `turn-lifecycle.ts` | 当前 turn 状态与 complete/stopped/error settlement |
| `config.ts` | model、permission、reasoning、provider、MCP 与 deferred restart |
| `transcript.ts` / `transcript-persistence.ts` | live transcript、cursor、SDK UUID tracking 与 durable mutations |

`session-core/` 只放 pure policy。`session-engine/` 与 routes 只调用 public facade，不直接 import builtin owners。`abortPersistentSession()` 是语义化 abort 入口；terminal 成功必须由真实 SDK result policy 判定，不能把 idle 或未知 reason 当成功。

Builtin 的 `messageGenerator()` 是常驻 generator。配置需要重建 Query 时，经既有 abort / restart 路径处理，并沿用 metadata 中的 SDK identity 与 resume 决策。Pre-warm 创建的真实 SDK session 会被后续复用，初始化不能只放在非 pre-warm 分支。

Claude 推理强度是可热更新的 Query 设置：config owner 保存 desired 值，lifecycle owner 按 exact Query 串行执行 `applyFlagSettings({ effortLevel })` 并记录已确认的有效值。空闲切换等待控制回执；已有 active/promoted turn 时只更新 desired，在下一轮最终 admission 前完成设置。Realtime 输入加入当前 turn 时保持该轮设置，切换不触发 Query 重启。`default` 显式发送 `null`，恢复模型默认；省略字段不能撤销先前覆盖。控制失败或 Query replacement 不得把旧回执当作生效证明，未通过设置检查的输入不能进入 SDK。OpenAI bridge 保持既有逐请求解析路径。

每次 SDK Query launch 都有只属于该 Query object 的 identity authority。`system_init` 只有在 authority 未撤销、Product binding 未改变且 SDK Session id 与启动期望相同时，才可更新 metadata。旧 Query、旧 generation 或未知 identity 的迟到事件一律丢弃。

desktop 连续发送支持 realtime 与 turn-boundary 两种策略，但两者仍共享同一个 Runtime queue owner。Stop 中止当前 turn，不凭空取消 SDK 已接纳但尚未消费的项；queue receipt、replay 或 assistant-start 才能确认后续项的真实状态。

没有活跃 turn 时，常驻 Query 不代表消息正在执行。Stop 通过精确 queue owner 取消本地 message、pending、turn-boundary、admission 与尚未提交的 promoted input，等待取消结算后才返回结果；promoted token 留给 generator 确认清理。只有没有 turn、提交、输入或重试 owner 时才归置 idle，迟到取消不能覆盖新的输入。已提交给 SDK 的后续项不进入本地 Stop 的取消快照；启动中的 Stop 仍使用既有 canonical abort。输入因必要重建停在 exact Query 的退出等待时，显式 Stop 也经该 abort 退休旧 Query，避免取消队列后保留无法接收下一条消息的输入通道；普通空闲 Query 不受影响。

强制发送在有活跃 turn 时沿既有中断与 terminal 晋级路径处理；没有活跃 turn 时，只向准备好的 generator/启动入口交接目标。找到了目标却无法交接，应保留消息并返回显式错误；只有目标不存在才返回 stale，不能调用 Stop 清掉目标后宣称发送成功。

Builtin 中断请求由 `builtin-session/interrupt.ts` 在既有 Session 内按请求和 Query 归属管理。同一目标尚未 terminal 时复用其停止操作；目标 terminal 一旦被 turn owner 接管，就同步释放中断状态，不等待控制回执。迟到回执只可核对原请求、原 Query 的精确排队项，不能关闭后续 Query、清掉新请求或把后续 turn 当作取消。真实 SDK 错误仍按错误结算；只有尚未 terminal 的目标才适用 5 秒回执超时与 ACK 后 3 秒强制关闭。

普通 turn Stop 不等于关闭整个 Query。V1 / V2 都在逻辑结算点记录 terminal，持久化完成回调只发布捕获的记录，不写回当前 turn。SDK iterator 在该停止期间或停止 terminal 后退出时，Query catch 使用本 Query 生命周期内产生的停止记录，不能再把已停止回合改写为错误；启动时继承的旧记录不能抑制替代 Query 的启动失败；未接纳输入时只发布 Session 错误，不调用 turn 结算，未发送输入由既有队列 finalization 恢复或取消。新输入 / turn 接纳通过 `resetTurnUsage` 清除旧 terminal，真实后续失败继续按错误处理。Windows 无确定根因的 exit 1 只展示退出事实，stderr 尾巴保留在日志中，不作为面向用户的故障原因。

SDK background Agent/Bash 与父 turn 共用同一个 Query 和 Sidecar。自动 deferred restart、MCP 变更与 rewind 退休以该 Query 的 `background_tasks_changed` 活动快照裁决，真实后台工作结束的整表更新会重新推进延迟重建；ambient 监听和仅用于展示的 task 边沿记录不阻塞重建；显式 Stop、Reset、Session switch、应用退出和真实 Query crash 仍可终止。

后台执行活跃性由 exact Query 的 SDK `background_tasks_changed.tasks` 整表替换，排除 `ambient`；Query replacement 时清空。它通过 SessionEngine live snapshot 的 `hasBackgroundWork` 提供给调度。不能从任务卡片或 start/terminal edge registry 推断：前台任务也可能发 start，前台转后台未必重发 start，ambient 监听也不应阻塞 Goal。

后台 task 的稳定 `task_id` 不等于一次执行。SDK `run_id` 在恢复同一 task 时变化，按字符串顺序比较运行先后；缺失值只兼容旧事件，不能覆盖已知新 run。`builtin-session/lifecycle.ts` 在 exact Query 的既有 registry 内同时裁决 start/terminal 的 run、活跃状态与双 terminal channel 的富信息补齐；已完成记录留到 Query finalization，不能让旧 run 的迟到 start/terminal 复活任务、释放新 run 或阻止新 run 完成。Renderer SSE 和通知记录携带可选 `runId`，新 run 重置旧 terminal 投影；历史 hydration 不覆盖已知更晚 run，同一 run 的摘要补齐 upsert 原通知，不同 run 使用不同通知 ID。旧历史缺字段时仍可读取，不改写磁盘历史。

MCP pre-warm 是 soft readiness observation，不是 AI turn 的 admission authority。未 connected、读取失败或观察超时不能拒绝业务 turn；真正的 MCP surface replacement 则是 Query-generation correctness fence，必须在 turn boundary 串行应用。

### 4.3 external Runtime

外部 Runtime 的当前 session、process/transport、operation queue、config state、transcript cursor 与 terminal result 分别由 `src/server/runtimes/external-session/` 下的 owners 管理，对外通过 `external-session.ts` facade 暴露。

配置变更和 message 使用同一 operation queue：当前 turn 继续使用 admission 时的 snapshot，前导 config operation 在下一个 turn boundary 应用。RPC/stdio write 开始后发生 transport error 只表示 acknowledgement 不确定，不能证明 prompt 未被执行；Stop 必须按精确 queue id 等待 startup/transport/termination settlement。

外部 Runtime 的“进程 idle”不等于 turn 成功。Task、Goal、通知和 UI terminal 都必须读取 adapter 提供的真实 result classification。

### 4.4 Rewind、Fork、Retry 与 reload anchor

SDK 输入的 queue UUID 只用于关联准入和消费。Replay、assistant-start 与 result handoff 不证明该 UUID 是持久 native chain entry，因此这些路径不能写入 `sdkUuid` 或 native UUID 集；恢复点只取原生 user/assistant 内容事件，或 SDK 历史中验证后的普通 root user 记录提供的 UUID。缺少精确边界时沿既有 mutation 校验明确拒绝，不猜测更早历史。旧数据中的同值 UUID 也可能是真实 native entry，不能按“等于 queueId”批量删除；已失效的显式边界仍通过用户选定的更早 Rewind/Retry 恢复。

Builtin 用户消息的 `sdkInputUuid` 只持有提交关联，不是恢复锚点。普通 native user 事件只能按此关联精确绑定产品消息；tool_result、child、local command、synthetic 与 replay 不得向历史未绑定用户反向补位。Fork/Rewind 在原 mutation owner 中读取 SDK 历史，验证用户候选；`isQueuedCommand` 投影仍是别名，不能充当真实 user 锚点。历史错误/缺失的可选用户锚点在 fork 目标保持未绑定，不改源历史、不按产品行与 SDK 行的位置猜配；assistant 边界与 native→native remap 仍严格校验。文件 checkpoint 同样只使用验证后的 root user UUID，由 SDK 返回实际恢复结果。

三种操作统一进入 SessionEngine，adapter 拥有 native history 操作与执行顺序，SessionStore 拥有产品 transcript、metadata 和提交裁决。Renderer 不自行选择 Runtime 路径或补做重发。

| 操作 | Product Session | 执行语义 |
|---|---|---|
| Rewind | 保持原 identity | 产品历史截断到目标 user message 之前，native continuation 对齐同一边界 |
| Fork | 创建新 identity | 先建立精确 native 分支，再发布完整产品历史与独立附件 |
| Retry | 保持原 identity | 同一 mutation 内先 Rewind，再通过普通 desktop admission 接纳原输入；接纳成功不等于 turn 成功 |

Builtin Rewind 以保留前缀末条 native 内容的精确 chain UUID 为边界，包括 user。只可越过明确标记的独立产品诊断（assistant、`messageKind: diagnostic`、无 native UUID/anchor），产品记录仍保留；第一条真实或未分类内容缺锚点时在文件副作用前失败，不能再向前找 UUID。诊断标记与 user 或 native anchor 冲突时拒绝。native 前缀为空（产品前缀为空或全为明确诊断）才分配新的 SDK execution identity。UUID 出现在 Product transcript、原始 SDK JSONL 或 SDK `getSessionMessages()` 的单链投影中，都不能证明它位于 native runtime 当前可恢复分支；同样，缺席该投影也不能证明它无效，因为投影按物理记录选择 leaf，而 CLI resume 使用 durable selected head。Query 启动是 native resumability 的唯一裁决；拒绝时保留显式边界并报告失败，不能清除锚点、恢复更长历史或自动重放。拒绝 `No message found with message.uuid` 且不能恢复推导锚点时展示恢复提示和 toast，保持用户消息及 Product 历史。边界通过既有 mutation intent 与 `sdkResumeSessionAt` metadata 一起提交；新一轮成功后先正常结束该 Query，让 native runtime 发布新的 selected head，再解除边界并发布 Product terminal，配置重启只能发生在此后。已有坏锚点通过从更早、仍可由 native runtime 接受的消息重新 Rewind / Retry 覆盖恢复。文件恢复仍使用现有 Query 的 `rewindFiles`；standalone SDK fork 不携带 undo 历史，不能用它替换 builtin Rewind。旧记录的 `reloadAnchor` 只在加载时推导，优先级低于显式回溯边界；它不是另一份持久化状态或 Session identity。若 SDK 在零模型轮次明确拒绝本次推导的 UUID，清掉这个临时锚点并以 bare resume 重试，保留 Product 历史和当前输入；旧版未持久化的回溯边界在这种失败后可能恢复较长的 native 历史，这是宽松兼容策略，不适用于显式 `sdkResumeSessionAt` 或 fork 边界。

新 Fork 统一先实体化 native history，builtin 同时映射 SDK UUID；完整执行配置复用 `snapshotForForkedSession`，不手工挑字段。Fork 不继承 source 的 Agent origin、Goal、置顶或 Tag。旧 lazy fork 通过记录的 binding/source 解析真实 native 来源，允许尚未启动的旧分支继续 fork；新请求不再生成 lazy fork 或通过设置切回旧路径。prepared 发布、附件复制和清理见 [V2 transcript](session_transcript_v2.md#生命周期与显式操作)。

Retry 经 `POST /chat/retry` 进入 adapter，`/chat/external-retry` 仅保留同一语义的路由别名。Builtin 使用现有串行 mutation scope：内部重发可以重入，外部接纳等待该 scope 结束。External 的 mutation lease 覆盖重发接纳；期间新入队的消息保留，自身 replay 排到队首后才释放 dispatch。V1 复用既有删除事件、V2 由 writer 发布删除操作，先同步移除旧消息再接收 replay。不支持精确 native history 操作的 Runtime 返回明确能力错误，不以只截断产品记录代替。Codex 的边界选择见 [Runtime 文档](multi_agent_runtime.md#53-codex)。

Retry 的 `model` / `reasoningEffort` 是与普通发送一致的可选发送意图：UI 传当前选项，adapter 在同一 mutation scope 内将其带入重新入队。不能只传消息 ID 后依赖预热进程默认模型，也不能把 Runtime 展示用的 reported model 反写成配置 authority。未传选项的旧调用仍采用既有后端默认语义。

响应必须区分会话提交、重发接纳和文件恢复结果：文件已恢复而记录修改失败不能说文件未变；会话已提交而 Runtime restore 失败不能说完全没执行。传输失败时前端回读权威历史，不用旧消息快照覆盖、不自动重发；明确的校验/能力拒绝直接展示原因。Fork 调用方用稳定的 `targetSessionId`，metadata 的 `forkOrigin` 关联来源；丢失响应后查询同一目标或重试同一身份，已发布目标返回已有结果。查询尚未确认目标只表示待确认，不证明此前失败；打开 Tab 失败也不删除已发布分支。这不承诺跨进程崩溃的 exactly-once 执行。

Stop/Reset 的结果也由 SessionEngine 决定。Stop 的回执或超时不代表 turn 已结束；前端等待执行事件，缺失时读取 `/api/session-state`，并丢弃已被更新执行事件、恢复或连接代际取代的读结果。Reset 成功返回前由 adapter 通过既有 publisher 发布新 identity 的 desktop 元数据和当前执行配置快照，并等待 writer 的 `flushForMutation` 确认磁盘可见；保证尚未发送首条消息也能绑定 Task/Goal、重启后仍能恢复模型配置。

桌面新对话统一调用 Rust `cmd_new_desktop_session`，前端的 Channel 状态轮询仅供展示，不能决定 reset 路径。Rust 从 Router 查询 source 的当前 binding，并在 peer / projection / Session lifecycle fence 下校验实际 owners；同一 lifecycle owner 校验 Tab、持久 owner 与当前进程：空闲且可独占迁移时复用原进程；有其它 owner、离线渠道 binding、进程恢复中或已有执行时，保留 source 及原渠道绑定，由 App 在同一 Tab 准备独立新会话。活动状态暂时不可读取也走保留 source 的路径，而不是据此重置或拒绝新建；保活复用既有 BackgroundCompletion owner/poller。前端只消费裁决结果，不再二次探测忙碌状态。每次独立新建使用唯一 pending key，不能复用 Tab 首次出生的 pending key；新进程就绪前不释放 source Tab owner；新 Tab 投影提交后异步释放精确的旧 Tab owner，不能让旧会话恢复或释放锁阻塞新会话使用。`pending-*` 仅是 Manager bootstrap key：Rust 在 pinned generation 上读取 Runtime 的 canonical identity，再由 adapter 在 mutation boundary 核对它；不能把临时 key 当作 Product Session ID。Node 的 `/api/session/new-conversation` 在 adapter mutation boundary 内核对 expected source，完成 reset 和 durable publication 后才回执成功；`/chat/reset` 不再接受无 Rust admission 的切换。

同一 Tab 切换到独立新建的 pending Session 时，`TabProvider` 必须在新订阅接入前结束旧 Session 的展示生命周期：复用与原地迁移相同的清理入口，清除消息、流式缓冲、消息 ID 去重、交互状态和标题。消息 ID 只在各自 Session 内唯一；保留旧投影会把新消息误认为旧消息。pending→canonical 是同一会话的实体化，必须保留已经显示的首轮内容；同会话重连也不得清空历史。

桌面新对话只在 Channel discovery、peer / projection / Router 和 source lifecycle 锁可立即取得时尝试原地迁移；任一锁忙碌即校验精确 Tab owner、复用 BackgroundCompletion 保留源并独立新建，不等待旧会话恢复，也不取消或改名旧会话。Channel 在 discovery 后已经换绑时，重新走普通 Session lifecycle 准入，不能用旧 binding 快照否决操作。源进程在 reset 请求发送前退出、或 bootstrap identity 的只读探测失败时，保留源并独立新建；这与 reset 请求发送后的不确定结果不同。显式 Channel handover 冻结旧会话时也必须经 Manager 按逻辑 Session 取得当前 generation 的 dispatch lease，并持 source lifecycle fence，不能使用 Router 缓存的旧端口。

Runtime 成功前 Manager 与 Router 保持 source，成功后才发布 target。adapter 在既有 mutation boundary 重新判断已接纳工作，不能把 Rust 的较早 idle 采样当成重置许可；busy 返回 `sourceUnchanged` / `session_busy` / HTTP 409，Rust 同样转入保留 source、独立新建。其它进入 reset 前的明确拒绝也返回 `sourceUnchanged` / HTTP 409，Rust 保留旧 writer 和正在执行的操作。超时、坏回执或 reset 后写盘失败不等于取消：Rust 持有精确 generation 的 dispatch lease，关闭 admission、终止并确认旧 writer 退出后，才通过已有 recovery 保留原 owners；不能用一次 session-state 读到 source 或 target 就推定整个 mutation 已结束。前端只采用 Rust 已提交的 identity，拒绝时保留历史。App 打开新 Tab 失败须与「可在当前空会话 reset」区分，不能用失败触发破坏性的 fallback。

## 5. Goal 与跨 Session 协作

### 5.1 Goal

Goal 是 current Session 的独立 durable state，存储在 `session_goals.json`，不嵌入 Session metadata，也不复用 Task/Cron。`SessionGoalManager` 是唯一业务 owner，同一 Session 最多一个 unfinished Goal。

Goal 只拥有 objective、状态、end conditions、permission policy、当前 turn fence、统计与 delivery outbox；Runtime/model/provider/MCP 仍由 Session 拥有。Goal turn 通过现有 SessionEngine queue 执行，不建立第二套 queue 或 outcome cache。

turn 在 adapter 的真实 promotion boundary claim，以 `goalId + queueId + sidecarGeneration` 拒绝旧 incarnation、旧 queue 与旧进程的迟到回写。Pause、Cancel 和 terminal 先 durable commit，再精确 stop owned turn；termination 未确认时保留 queue binding、Goal owner 与恢复信息。Tab 关闭只释放 Tab owner，不能停止 Goal。

自动 continuation 是 one-shot 调度，只在上一 turn settlement 后安排。deadline、execution limit、用户控制与模型 terminal 都由 `SessionGoalManager` 在线性化边界内裁决；模型只能请求允许的 terminal，不能仅靠 prompt 绕过 `aiCanExit`。

continuation 在准备前后检查 Session 的 busy/background activity，在真实 promotion 的 claim 前后复核后台活跃性；builtin 在最后一次 materialization await 后再执行同步 commit guard，拒绝时先结算 durable claim 再发布拒绝。有工作未结束时返回未 dispatch 的 `goal_work_pending`，Rust 复用 one-shot scheduler 以 5 秒间隔检查，不调用模型、不计 turn/token/failure；每次检查仍经过 Goal 状态和结束条件裁决。初始用户 turn 不受此自动续跑策略限制。此事实只覆盖 Runtime 可观测的工作，不从“等待中”的文本推断外部任务。

Goal 的详细产品行为和 Task/Goal provider routing 见 [`task_center.md`](task_center.md) 与 [`task_provider_routing.md`](task_provider_routing.md)。

### 5.2 Session Inbox 与事件

`myagents session start/send/watch` 使用结构化 session event，不是普通文本拼接。事件经 Admin/Management API 投递到目标 Session 的既有 Inbox/SessionEngine admission，并放在隐藏的 `system-reminder` envelope 中；来自其它 Session 的正文必须 neutralize 协议标签。wire protocol 以 `sourceKind` 显式区分 `internal-session` 与 `external-cli`：前者要求真实 `fromSessionId` 并可回投，后者没有来源 Session 且不注册 reply，不能用空串或用户 payload 猜来源。

- `send.request` 投递工作；Renderer 只把它的可见 payload 投影为用户气泡；
- `send.result` 在目标 turn terminal 后回传结果；
- `watch` 根据注册时的真实 activity 返回 already-idle、completed 或 error；未确认投递成功前不能清理 pending watch；
- `session watches/unwatch` 的 JSON receipt 使用 `data.watches`，仅管理真实调用方的观察。单 ID 未匹配返回 `WATCH_NOT_FOUND`；owner 未确认取消（如跨设备注册/投递尚在途）返回 `WATCH_NOT_CANCELLED` 并保留逐项 receipt。取消观察不停止目标 turn，也不能撤回已进入 Inbox 的通知；`--all` 没有观察时可成功。
- Task Comment 复用同一 Inbox 与 Session queue，但通过 task-specific event 和显式回复命令回写 Task，不自动复制普通 assistant 输出。

backend-created target 只有在 Runtime dispatch claim 成功后才发布 prepared Session；ACK 不明时保留 identity，不能自动重试导致重复执行。`session start/send` 的每一层外部 timeout 都大于内层 owner/ACK timeout；transport error、成功状态但不可解析的 ACK 和外层超时统一是 `admission_unconfirmed`，只有明确拒绝才是 definitive failure。

本地与跨设备 fresh Inbox 共用上述出生入口。目标 Sidecar 启动时 metadata 尚不存在；出生完成后，DSH/外部 adapter 必须在 Inbox admission 从已写入的 owned Session snapshot 捕获权限、模型与推理配置，不能沿用 bootstrap 的空 desired state。已有 owned Session 的缺失字段仍按产品默认解析，不重新继承 Agent 当前设置。DSH 原生 Plan 状态只更新 Runtime 的 Plan owner，不投影为权限变化或写回 Session permission snapshot。

Session Inbox 与用户手动 query 的投递时机独立：通用 `chatQueueResponseMode` 只控制手动 query；builtin / DSH / Codex 的 Inbox 固定 realtime。原 Runtime queue 负责接纳与派发，native receipt 决定消费与上屏；排队 HTTP 回执不代表模型已感知。A 运行、手动 B 等下一轮时，Inbox C 可在 A 的安全消费点进入 A，B 仍等待 A terminal。已消费的多个请求由原 turn owner 保存关联，在 terminal 前同步取走快照，分别返回同轮结果；未消费输入不能借用 A 的结果，reply / watch notification 也不触发自动回复。

`myagents session get` 不进入 Inbox、不唤醒 Runtime，也不创建 turn。它按 message id 合并持久 snapshot、活跃内存与 streaming overlay，先严格投影 user/assistant 的可见顶层 text，再执行 `before`/`limit` 分页。user 正文与请求气泡共用 `parseLeadingSystemReminder` / `parseSessionSendRequestDisplay`：可见 tail 优先，无 tail 的 `send.request` 只显示请求 payload；自动 result/watch 及其它纯隐藏提醒不显示。旧已存请求同样按此规则读取，不改写历史；裸历史 XML 保持原可见文本语义。疑似结构化 assistant 内容只要解析或 block schema 异常就 fail closed，工具、思考、隐藏控制信息和无 text 结构块绝不回退为原始 JSON。活跃 owner 的 `liveSessionState` 与 `session state` 共用 `projectSessionActivity` 的 idle/running/waiting_user_action 三态；无 live owner 时仍返回 `isLive=false / liveSessionState=null`，不采样调用方状态。Rust 在 owner transport 或响应体失败时释放旧 dispatch、重新解析当前 owner 并只重试一次；最终错误保留 `SESSION_OWNER_UNAVAILABLE` 与 `SESSION_OWNER_INVALID_RESPONSE` 的区别。锚点只在可读文本序列内成立，失效时明确报错，避免静默重复或漏读。

跨设备协作使用 Rust App 的 `agent_network` 传输适配，同样进入上述原 Inbox/SessionEngine；不建立另一 SessionStore 或执行队列。本机 `PreparedFreshSession` / `PreparedDelivery` 在冷准备后释放 lifecycle 锁，保留原 transient owner，取得网络 permit 后重读原 identity/generation，再交给原 Node owner。最后本机 handoff 后属于在途；真实 `accepted` / `delivered` 以 Node 收据为准，网络 permit 不是业务收据。远端 handoff 的 HTTP ACK 丢失返回 `Unconfirmed`，包括内部无回推调用；准备失败和明确 `accepted:false` 仍拒绝，不自动重派。

内部跨设备请求的 `networkReturn` 是 Rust 验证后的 opaque 关联，存于原 turn/watch owner。目标原 terminal 回调通过 App 当前身份 scope 的 return registry 返回，来源仍投递自己的原 Inbox，拿到真实 source settlement 后再 ACK。`watch` 复用原 one-shot registry/formatter，返回 idle/error 不创建模型 turn。来源未公开或目标退出网络不取消已接纳工作；双方协商恢复能力后，临时断线可在有界窗口内恢复终态投递，不重放原请求；旧版本仍为连接内回传。身份、加密、恢复期限与失效通知规则见 `agent_network.md`。
当前 Session 的文本分页由 Rust Management API 发往 owner Sidecar 的 `POST /api/internal/session/text-page`；该路径必须登记为 Session role 路由。否则历史 Session 可从持久化读取，当前 Session 却会在生产 role gate 返回 404。

Desktop、Goal、Task、Inbox、IM、Heartbeat 和 Memory 的执行都经 SessionEngine；DSH 的 `integrated` kind 不能落入 SDK enqueue/config 路径。DSH 强制发送先 interrupt 并持久化 partial terminal，再提升目标 queue item。跨 Sidecar Inbox 只有收到可解析的 `{ accepted: true }` 才算投递成功，HTTP 2xx 的协议错误必须保留上层重试权。

### 5.3 Registered Agent origin

Space Issue Delivery 复用 Inbox admission，但使用专用 `myagents-space-issue` reminder 与持久化 origin。Registered Agent identity 必须同时绑定 exact `spaceId` 与 `registeredAgentId`；缺失、畸形或普通 desktop origin 都 fail closed，不能因 workspace 相同或一次定向 delivery 把普通 Session 提升为 Agent。Fork 总是重置为 desktop origin。

完整协议见 [`space_issue_delivery_protocol.md`](space_issue_delivery_protocol.md) 与 [`system_reminder_protocol.md`](system_reminder_protocol.md)。

## 6. 持久化与恢复

### 6.1 MyAgents transcript

`SessionStore` 用 `sessions.json` 固定格式和 metadata；旧 Session 沿用 `sessions/` 的原 JSON/JSONL 读写，新建及 fork 目标固定到 `sessions-v2/` 的内容操作日志。无迁移、双写或 V2→V1 fallback。路径先经过 canonical Session id validation。

V2 的 live projection 与异步 writer 同属 SessionStore。约 100 ms 的持续批次保存未结束内容，插话产生稳定展示段，完整帧/工具/附件更新原目标。待写队列无容量上限，持续故障时接受积压的内存风险；保存失败或挂起只报告产品记录异常与 toast，不主动阻断 AI。显式 fork/rewind/reset/delete 仍守自身 lifecycle 和物理写权限边界。格式、恢复与接口细节见 [`session_transcript_v2.md`](session_transcript_v2.md)。

### 6.2 MyAgents 与 SDK 双重存储

两份历史服务不同 authority：

| 存储 | 用途 |
|---|---|
| MyAgents V1/V2 产品文件 | UI 展示、搜索、Session 列表、跨 Runtime 的产品历史 |
| Runtime 原生存储 | SDK/CLI resume、上下文连续性、Runtime 自有 cache 与 branch 语义 |

不能用其中一份替代另一份。产品层恢复以 MyAgents transcript 为准，执行层 resume 以 adapter 的 native identity/history 为准；两者通过显式 identity 和 rewind boundary 对齐。

### 6.3 REST snapshot 与 SSE

Rust 按 `(sidecar key, generation)` 把控制请求和 SSE 代理到当前进程。每次实际 replacement 都产生新 generation；旧 generation 的 response、terminal、activity 和 notification claim 必须丢弃。

历史 Tab 以 REST 读取历史和当前状态，再按 revision 接收 SSE 增量。SSE 建连只发送状态/live row 与 snapshot revision，不全量重放冷历史；新会话首次实时输出保持即时，后续连接发现基线缺口时同样使用既有分页 REST restore。与已有基线一致的重连无需重读，idle 时的版本缺口也不能等下一条增量才发现；详见 [V2 transcript](./session_transcript_v2.md)。不能把断线期间缺失的 SSE 当成历史不存在。

SSE transport 断开不代表用户取消，也不拥有 abort 权限。turn 继续执行并持久化；只有显式 Stop、Session lifecycle 命令、Runtime terminal 或 Sidecar termination 能改变执行状态。

会改变当前 Session snapshot、队列边界或阻塞式交互 UI 的事件必须携带 `sessionId`，并通过 `sessionScopedEventGuards.ts` 与当前 Tab identity 比较。pending→real 等已被 lifecycle authority 确认的 identity upgrade 可以沿用 transport；普通 real→real 历史导航必须 new/jump/revive 到目标 Tab，不能把旧连接标签当业务 authority。

Renderer 的 execution activity 由 `TabProvider` / Companion 对当前 Session 的 REST snapshot 与 `chat:status` 投影。`chat:message-complete/stopped/error` 只结束一轮的消息展示，不能把整个 Session 改为空闲：Builtin 有排队工作时持续 running，不会重复广播相同状态。消息归档只清 streaming 引用；backend idle/error、Session reset 或 replacement 才清 execution activity。不要通过增加另一个 `isGenerating` truth source 或延时隐藏状态错位。

Builtin 手动强制发送在旧 turn result 中把 in-flight 项从队列交给执行时，必须先保留 execution activity，再清 queue slot；旧 turn cleanup 同时检查这次已接纳的 continuation，不能仅因队列为空广播 idle。这个交接事实复用 turn lifecycle 的既有判断，不由 Renderer 根据消息气泡补推。

消息缺失、持久化与重放查 [V2 transcript](session_transcript_v2.md)；历史内容正确但滚动位置、窗口恢复或首帧呈现异常时，查 [Chat 滚动与窗口呈现](chat_scroll_presentation_lifecycle.md)。两者分别由历史与呈现 owner 裁决。

### 6.4 完成通知

普通 Session 的系统完成通知由 Rust `notification.rs` 统一裁决。Tab SSE proxy 与无 Tab 的 `BackgroundCompletion` 只能向当前 Sidecar generation 申请一次性资格，再由通知 owner 判断 origin、窗口焦点、偏好、badge 与 deep-link。

Task、Goal、Agent Channel、Memory、Heartbeat 等领域使用自己的通知/投递语义。transport 断线期间的 turn 仍可恢复历史，但普通通知没有 durable outbox，不能承诺断线窗口补发。

### 主窗口 WebContent replacement

原生主窗口的 `MainRendererState` 识别本次进程内的新 Renderer 实例。主入口在挂载 App / TabProvider 前完成 attach：冷启动维持“主动退出后 Launcher、异常退出/更新后提供恢复入口”的策略；同一 App 内的 Renderer replacement 自动走既有 Tab 恢复、Session ensure/reconcile 流程，保留原 Tab 与 Session identity。

`myagents.openTabs.v1` 中的 live Tabs 与可选 `pendingRestore` 分别表示当前布局和尚未接受的上次会话候选；后者同样使用 v1 白名单 codec，直到接受或主动忽略才消费。候选不占 live Tab 槽位；自动恢复因并发导航达到容量上限或 attach 失败的剩余项合入候选，不以 live 数量上限裁掉待恢复项。启动判定/自动恢复结算前不允许初始 Launcher 覆盖快照；手动恢复部分受容量限制或 attach 失败时保留剩余候选。冷启动优先采用本地 live 布局，其次采用更新重启的 durable live handoff，二者均为空时保留原候选。

Renderer replacement 只停止主窗口 Tab 的旧 SSE transport，不动 Companion 或任何 Session owner。Rust 从 SidecarManager 当前及 recovering 的 owner 集合提供旧 Tab token 清单；恢复完成后，未接回的 exact token 复用正常关闭的 BackgroundCompletion → stop SSE → release Tab 顺序交接。旧 token 交接完成后才能公布/接受原候选及新增剩余候选，避免同 ID 重新接入与旧 release 竞争；复用 App 的恢复结算边界，不增加 native owner generation。SSE 重新订阅获取新的初始状态，不能因稳定 connection key 相同而沿用旧 JS listener 的流。这个窗口恢复机制不诊断或修复导致 WebContent 终止的内存根因。

## 7. 配置写入方向

### 7.1 `sidecarConfigDisposition`

Chat mount 必须明确当前 Tab 对 Sidecar 配置的方向：

| 状态 | 语义 |
|---|---|
| `push` | Sidecar 是本次新建，Tab 将自己的 Session 配置推入 |
| `adopt` | Sidecar 已由 IM、Task、Goal 或 background 使用，Tab 采纳现有配置 |
| `pending` | ensure 尚未裁决；既不 push 也不 adopt |

`pending → push|adopt` 的唯一依据是 Rust manager 锁内 `ensureSessionSidecar().isNew`。端口探测、Renderer 缓存和事前 `hasSidecar` 都有 TOCTOU，不能决定配置方向。

mount 期配置同步必须受 disposition 门控；用户主动修改配置可以先持久化 intent，但在 `pending` 期间延后 Runtime push。打开已有 Session 的所有入口都复用 App 的 materialization/reconcile 流程，以 exact Tab owner ensure 并在 replacement 时保持 Owner 集合。

Sidecar ready 而 External/DSH Product Session 尚未绑定 workspace owner 时，Agent/MCP setter 返回 `pending_next_start / awaiting_product_session_owner`；birth 从落盘 authority 编译扩展，不能伪造 live apply。DSH replacement resume 先恢复当前 Session 实际 permission/config，再校验持久 permission revision chain；mutation journal 只协调 fork/rewind/delete。

### 7.2 snapshot setter guard

`sidecarConfigDisposition` 约束 desktop writer；Runtime config policy 还必须约束 IM 等其它 writer。已有 `configSnapshotAt` 的 Session 保持 snapshot authority：

- desktop 用户主动修改先写 Session snapshot，再经 desktop source 应用；
- IM warm/sync 不覆盖 owned model/provider/permission/reasoning；
- IM 每轮需要的 channel 配置通过 send context 在 admission 时解析；
- external Runtime 先执行 source-aware filtering，再把合法配置 operation 加入 turn-boundary queue；
- Task 配置只初始化新的 Task Session，已有 Session 继续使用自己的 snapshot。

纯 policy 位于 `session-core/runtime-config-policy.ts`。新增 setter 或调用方时必须显式标注 source，并在写 desired/live state 之前完成过滤，不能先污染状态再跳过 restart。

## 8. 关键实现

| 路径 | 职责 |
|---|---|
| `src/server/types/session.ts` | 当前 Session metadata 与消息类型 |
| `src/server/SessionStore.ts` | metadata、格式固定、V1/V2 历史与 typed mutations |
| `src/server/session-engine/` | Product binding、Runtime selector 与统一 adapter contract |
| `src/server/agent-session.ts` | builtin public facade |
| `src/server/builtin-session/` | builtin lifecycle、queue、turn、config 与 transcript owners |
| `src/server/integrated-runtimes/dsh/` | DSH process、生成协议、native history 与 Host ports |
| `src/server/runtimes/external-session.ts` | external public facade |
| `src/server/runtimes/external-session/` | external process、queue、config、transcript 与 result owners |
| `src-tauri/src/sidecar/` | Session Sidecar、generation、Owner 与 recovery |
| `src-tauri/src/session_goal/` | Goal durable owner |
| `src/renderer/types/tab.ts` | `sidecarConfigDisposition` |
| `src/renderer/App.tsx` | Session Tab create/open/revive 与 owner reconciliation |
| `src/renderer/context/TabProvider.tsx` | 当前 Tab 的历史、SSE 与 activity 投影 |

相关边界：

- Runtime adapter：[`multi_agent_runtime.md`](multi_agent_runtime.md)
- Task / Goal：[`task_center.md`](task_center.md)、[`task_provider_routing.md`](task_provider_routing.md)
- Prompt envelope：[`system_reminder_protocol.md`](system_reminder_protocol.md)
- 可执行护栏：[`pit_of_success.md`](pit_of_success.md)

### Channel 跨会话交接

`myagents im send-message` 的其他实际会话目标由 Rust Channel owner 解析为原 Router peer key；同会话继续直接发送。缺少目标 Session 时，复用 `ensure_peer_snapshot` 与 `ensure_sidecar` 建立正常绑定及其配置快照，不能伪造 ImMessage，也不修改入站授权。持有原 peer fence 和 model-work gate 完成 `prepare_existing_delivery` / Inbox ACK，无新增队列或重放记录。

Inbox 的可选 `send.request.channelHandoff` 是宿主数据，目标 admission 与 beforeDispatch 都检查实际 Product Session、连接 UUID、peer ID/ID 类型及私聊/群聊归属；不是从 XML 推导路由。目标 Runtime 沿原 realtime Inbox 队列消费，图片经 SessionEngine.images 进入原图片输入及 transcript，文件沿目标工作区引用持久保留。发送模式由目标本轮冻结；accepted 只表示队列 ACK。不为交接创建 replyBack 元数据，不自动返回整个私聊结果。


### Task 结果事件

`task.result` 是本地 Inbox 类型化事件，携带 Task、delivery、attempt、执行 Session 和固定的 `ConversationRef`，不使用 `replyBack` 或网络返回路径。投递记录由 [TaskStore](task_center.md#task-通知策略与投递记录) 管理，Inbox 接纳只表示已排队。

`admitTaskNotification` 复用普通 `enqueueInboxMessage` 和准确的 `dispatchAcceptance`，在目标 Session 接纳后记录 `handed-off`；Task 不等待模型终态，也不拥有 IM 外发。模型、MCP 与权限仍来自目标 Session，回复沿普通 Session binding / tool_only 发送方式处理。`automation/task_notification` 来源不触发第二次桌面完成通知。若执行 Session 即目标则不启动自我转述，纯状态在同 Session 只追加记录；其他事件均按 Inbox 输入处理。执行前复查绑定，未确认的接纳沿既有 unknown 恢复规则处理。

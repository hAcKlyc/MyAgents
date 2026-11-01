# 任务中心架构

> Task 是所有新定时自动化和任务中心执行的唯一持久化实体。Cron 只保留兼容命令名与旧数据读取，不再是 Task 的调度投影。

## 1. 所有权

两个当前 Store 位于 `~/.myagents/`：

| Store | 文件 | Owner |
|---|---|---|
| `RecordStore` | `records/<YYYY-MM>/<id>/` | 文字/音频 Record、timeline/transcript/speaker projection、artifact 与 Task 关联 |
| `TaskStore` | `tasks.jsonl` + `tasks/<id>/task.md` + 可选 `comments.jsonl` | Task 身份、状态、调度、完整任务契约、本地评论、运行统计与审计 |

`thoughts/` 是升级输入，不再是新产品 surface 的权威。`RecordStore` 在启动时按幂等锁把旧 Thought 迁入 text Record，保留原 identity/provenance；`myagents thought` 仅是 `myagents record` 的兼容 alias。audio Record 的录音、转录和说话人状态仍由 Record/Recording/Speech owner 管理，不写入 Task row，也不让 TaskStore 代管媒体 artifact。

新 Task 的唯一语义文档是完整 `task.md`。旧 `verify.md/progress.md/alignment.md` 仍可读取；其中旧 `verify.md` 在 task read/edit/dispatch 前通过 TaskStore 的幂等迁移原样追加为 `# verify.md` 章节。新建和编辑不得继续维持平行四文档协议。

`TaskStore` 是 Task 的唯一真相。不存在 `Task.cronTaskId`、关联 `CronTask` 副本、schedule 双写或启动时反向修补。

`TaskApplication` 是 create/link、status、delete/unlink、run/rerun 的应用层 owner。它复用 Task control 与 Store 的现有事务来编排规则，不保存第二份状态。Management API 与 Tauri command 只负责 DTO、调用方身份和响应映射；Cron 兼容入口与 Memory managed job 直接调用同一个应用入口，不能反向依赖 transport handler。

桌面「创建并启动」调用 `cmd_create_and_start_cron_task` → `TaskApplication::create_and_start_scheduled`，由后端完成创建、状态裁决与 scheduler 启动。返回提交后的 Task 与可选启动错误；失败记录保留供查看/重试，前端不得用 delete 补偿。用户明确取消已接纳的草稿时可以发送 stop；关闭 Tab 本身不删除或停止已接纳 Task。兼容 DTO 不构成第二份持久状态。

Task 的核心职责：

- 用户可见身份、文档、状态机与审计链。
- `once / scheduled / recurring` 执行模式及 `dispatchAt / interval / cron expression / timezone / recurring window`。
- `new-session / single-session` 会话策略。
- 新执行 Session 的 runtime/provider/model/MCP 初始配置，以及每轮 permission policy。
- notification、关联 Session、执行次数与最近执行时间。
- 一个 time Activation Trigger：缺失/`always` 直接执行 AI，`command` 先做低成本二元判断。
- 可选、线性、纯文本的本地 Comment 时间线；Comment admission 与 Task schedule/status 正交。

`Loop` 已退出 Task 模型：新建/编辑拒绝，旧 Loop 启动时转 `Stopped`，不转换为 Goal。

## 2. 状态与调度

### Renderer 的 Agent 状态投影

`cmd_all_agents_status` 的实时权威在 Rust。Renderer 复用 `taskCenterStore` 的 `agentStatuses` 切片；`useAgentStatuses` 是其窄订阅，不拥有独立轮询，也不启动 TaskCenter 的 Session/Task 全量抓取。多个 Chat 共用一个 5 秒周期与一个状态变化监听；TaskCenter 全量/按需装饰读取复用该请求入口，有 Chat 周期时不另发周期状态请求。

状态变化事件和显式刷新可以取代在途旧读取，只有当前请求可发布；等值响应保留引用。Agent 状态独立发布，不随较慢的 TaskCenter 全量结果再次写回，避免后到的会话装饰覆盖已更新状态。最后一个相关需求退出后释放相应监听/定时器，保留可供重挂载立即展示的健康投影；读取失败不清空旧数据。

最后一个持续需求退出时，释放监听与定时器并断开在途请求的复用指针；这不撤销应用级一次性状态读取的发布权，侧边栏/搜索仍可拿到结果。新的挂载会另起读取、推进 Agent 状态序号，旧响应不能覆盖新值。请求复用由指针决定，发布新鲜度由独立状态序号决定，不借 Session 读取状态推断 Agent 状态需求。

```text
Todo -> Running -> Verifying -> Done
          |             |
          +-> Blocked / Stopped
Done -> Archived
any allowed state -> Deleted (product-level irreversible tombstone)
```

`Archived` 是长期可恢复状态；`Deleted` 会从普通产品 surface 中不可恢复地移除 Task，并立即解除 scheduler、pending activation 与 Trigger state。TaskStore 保留行级 tombstone/statusHistory 是为了审计和阻止旧 Cron 重迁移，不代表存在 30 天恢复或 undelete 契约；TaskStore 也不拥有、不会删除工作区 Detector 脚本及其自持状态。

对时间型 Task，`Running` 表示 scheduler enabled，不表示某个 AI Turn 正在执行。具体 Turn 的 `checking | running | stopping | stop_failed` 只存在于 `TaskSchedulerController.executions`，Task list/get 在 wire projection 上附加 `executionState/executionError`，不写入 `tasks.jsonl`。列表只投影 Task 行与该瞬时执行态；完整 checkpoint/health/pending/error 仅由按 id 的 get 读取，因此一个损坏或较大的 `trigger-state.json` 不会击穿整个 Task 列表。

`TaskSchedulerController` 只拥有可重建的内存资源：

- 一个 `taskId -> timer JoinHandle` map。
- 一个 `taskId -> { queueId, canceled, sessionId, pendingSessionBirth?, state, error }` 的瞬时 execution map：复用 SessionEngine 普通 turn identity，原子拒绝重叠、撤销未 dispatch turn，并把 stop 与结果提交线性化；`pendingSessionBirth` 只在 metadata 尚未出生时持有该 exact generation 的 lifecycle capability，它不是持久 TaskRun。
- 启动时从 `TaskStore` 的 Running Task 重建 timer。

启动 Task 只有一个应用入口：`TaskApplication::run*` 在 Task control lock 内先裁决状态，再校验 schedule、提交 `Running` 并启动 timer；timer 启动失败则提交 `Blocked`。第一次接受执行返回从 1 开始计数的 `attemptOrdinal = executionCount + 1` 与 `changed=true`；同一 Running Task 的重复或并发 `run` 等待同一把锁后幂等返回 `changed=false`，既不重启 timer、也不产生新 ordinal。Renderer/CLI 只对真正接受的新执行上报 `task_run.run_count`，不按 Session history 预测，也不为幂等回执计数。

同一 `taskId` 的 run/rerun、终态提交、timer 替换、软删除、stop，以及 outcome/history/UI event/delivery 副作用，共用按 taskId 串行的 Task control lifecycle。完整锁序是 `Task control → Session lifecycle → TaskStore`；已经持锁的代码必须使用显式的 held-guard 入口，不能再次取得同一把锁。这样，旧 stop 或旧 queue 的迟到结果不能影响新一轮执行。

timer handle 只负责“何时触发”。真正的 AI Turn 是独立执行作业；Stop 先撤销该次 queue authority，再携带精确 `queueId` 请求 SessionEngine stop。只有精确 stop 得到业务确认才清除 execution、释放 Task owner 并发出 stopped confirmation；失败保留 `stop_failed` 投影与 Session 保护，用户只能重试 stop，不能 rerun/edit/delete。对 `blocked | stopped | done | archived` 再发 stop 只重试 transient turn，保留原终态原因，不追加伪状态迁移。`queueId` 已是执行 generation，禁止再维护冗余 generation counter。worker 异常退出由 RAII claim guard 收敛成可见的 `stop_failed`，不留下不可见的永久 owner。

隐藏的 memory auto-update batch 也复用同一 queue authority：每处理一个 Session 前把当前 Session 发布到 transient execution，`/api/memory/update` 携带 MyAgents Session id 与 `{ kind: 'task', id: taskId } + queueId` 注入 SessionEngine，并在 runtime promotion 前用 MyAgents Session id 回查 Rust authority（external runtime 自己的 thread id 只传给 `runInjectedTurn`，不可混作 Sidecar identity）。禁用/停止若先赢，后续 Session 不再启动；已启动的更新由同一个 `/task/stop` 精确终止。Sidecar owner 同样是 `Task(taskId)`；终止不确定时保留 owner。当前 execution 的成功证据仍只接受 marker 之后、内容精确等于 `MEMORY_UPDATE_OK` 的 assistant message，不做 substring 匹配，也不复用旧历史；但下一批的 cooldown 与 query reset 以已持久化的 user `<MEMORY_UPDATE>` dispatch marker 为准，即使该轮失败也不立即重发。候选范围固定为最近 7 天内存在真人输入的 Session，最终时间依据是 JSONL，而不是可能被自动 turn 污染的 `lastActiveAt`。

### Scheduled tick 与 run-now

二者复用 `task_execution::execute_task()`，但 lifecycle 不同：

- Scheduled tick 推进一次性任务终态、失败状态与 end condition。
- `cron run-now` 是兼容的 manual trigger：Running/Stopped Task 可执行，不启用 scheduler，不改变原 schedule/status；其他终态必须先走 rerun。
- `lastExecutedAt` 记录任何执行；`lastScheduledAt` 只记录 timer tick。Recurring 的下一次触发只使用后者，因此 manual run 不会移动调度锚点。

每次执行前都重新读取 `task.md`，用户修改会在下一次执行生效。Runtime terminal 返回后，scheduler 先在 TaskStore 单次原子写中提交 `executionCount`、执行时间、`lastExecution`、连续 scheduled 失败次数、可选终态与合并通知意图；然后才发桌面通知、处理 IM 回报、写 `cron_runs` 和释放 Session owner。运行历史继续写 `cron_runs/<taskId>.jsonl`，只作为查询/审计投影，Task Center 的最近执行不得从中反向拼接。Browser Host retire、Sidecar drain、通知或审计写入失败都不能改判已经结算的 Task outcome。

普通 Task 不再按 `dispatchOrigin` 选择不同的内容 executor。Scheduler 对 direct、AI 讨论后创建及 legacy provenance 都构造同一份完整 `task.md` 首轮 query；Agent 使用工作区、Skill 和工具自行执行与验证。Task status/outcome 仍由 TaskApplication/scheduler 裁决，Agent 不通过内容型 Skill 重写生命周期。

### Activation Trigger 与 Detector

每个 Task 最多一个 Trigger，Source 固定复用现有时间调度，不能在 Trigger 内复制 interval/cron/timezone。旧 Task 没有 `trigger` 时按 `time + always` 解释，不批量回写。`command` 配置是结构化 `executable + args + cwd + timeoutMs`；Rust 不拼 shell 字符串，bare `node`/`node.exe` 固定解析为 bundled Node.js v24，其他 bare executable 走系统二进制发现。

command tick 的边界固定为：

```text
timer/check-now -> Detector -> quiet: commit checkpoint/health only
                            -> failure: preserve checkpoint, record error/backoff
                            -> activate: atomic checkpoint + pending event
                                         -> ordinary Task execution claim
                                         -> SessionEngine queue -> Runtime
```

Detector protocol v1 只允许 `quiet | activate`。进程退出、timeout、输出超限、非 UTF-8、strict schema 或持久化失败属于 harness failure，不是第三种 decision，也不交给 AI 判断。`test` 真实执行命令但不提交 MyAgents 的 checkpoint/health/counter/event，也不启动 AI；脚本自己的文件、网络或数据库副作用不会回滚。`check-now` 是真实检查，会提交状态；命中时先把 event 与 ordinary queue identity 持久绑定、完成 Rust execution claim / Session reservation 并把投送交给后台 owner 后返回，不等待 AI Turn 终结。Runtime admission 或 terminal 的后续失败仍由 pending outbox、exact queue authority 与 Task health 可见恢复；已有 pending event 时拒绝新检查，绝不把 pending 投送冒充一次 Detector check。程序 failure 对 CLI/Admin 返回非成功诊断。`task run-now`/兼容 `cron run-now` 绕过 Detector，直接执行 AI，但 pending Activation Event 拥有投送优先权：outbox 未结算时 run-now 由 Rust authority 拒绝。

`trigger-state.json` 由 TaskStore 独占，保存 bounded checkpoint、检查/健康统计、最近 128 个已结算 event id 与一个 pending Activation Event。pending 同时持久化 Detector invocation cause；旧文件缺失该字段时按 `scheduled` 兼容。activate 必须先把 checkpoint 和 pending event 写入同一次原子替换，再 claim 并持久绑定 ordinary queue id，之后才能进入 Session admission；这个绑定不是“已被 Runtime 接纳”的回执，而是崩溃恢复与 stop 所需的 exact identity。AI Turn 确认接纳并终结时，Task row 原子提交 execution count、terminal status 与 `lastActivationEventId` receipt，然后才清 outbox；若在两次写之间崩溃，启动恢复只结算匹配 receipt 的 event，不重复唤醒。Running Task 的 pending 由 scheduler 按原 cause 恢复；Stopped/Blocked Task 只恢复 `check-now` 产生的一次性 manual admission，不 arm timer、不改变既有状态。Session 忙碌复用既有 SessionEngine queue，不建立 Trigger 专用队列。

`checkCount` 统计真实 scheduled/check-now Detector 检查，`executionCount` 只统计已接纳并结算的 AI Turn。Running Task 上由 check-now 命中的 AI Turn 同样服从 `maxExecutions`、AI exit 与 provider/terminal 规则；到达 end condition 后不得再做新的 check。Stopped/Blocked 上的 check-now 保留原状态。recurring 的可重试 Detector/AI failure 采用有界退避，连续第 1–4 次保持 Running，第 5 次进入 Blocked；任一次 scheduled 成功都会把连续失败数清零。once/scheduled failure、termination 无法确认，以及结构化标记的永久配置/场景/authority failure 立即 Blocked；manual run-now 只记录本轮摘要，不改变 durable status。失败类别来自 Detector/SessionEngine 的结构化结果，不从本地化 error 文本推断。Stop 保留 checkpoint 但取消尚未投送的 pending event，取消持久化失败必须返回错误供用户重试；reset 只清平台 checkpoint；delete 在精确 Detector/AI 进程确认停止后移除 trigger state，不删除用户脚本。Task 从 command 切到 always 时先持久化 non-command 行，再 best-effort 删除 state；该行本身就是启动恢复的清理义务。切回 command 时必须先幂等删除任何旧 state，失败则保持 non-command，避免旧 checkpoint/health/event 复活。

## 3. Session 与配置边界

Task 执行统一经过 `task_execution.rs` -> Rust Sidecar bridge -> Node `SessionEngine` facade，builtin/integrated/external Runtime 均走 adapter selector。

- 已存在的 Session：runtime/model/provider/reasoning/MCP 全部继承该 Session；Task 不做 turn-scoped 覆盖或回滚。
- 新建执行 Session，或首次 materialize 专属 single-session Session：Task 配置只用于初始化一次。
- 从当前 Chat 创建 single-session Task 时，Renderer 先通过既有 Session materialization transaction 得到真实 Session identity，再提交 Task；新 Task 与显式改绑的持久化边界在同一 Session lifecycle guard 内拒绝空值、`pending-*` 和不存在的 Session metadata。materialize 失败、取消、Session 并发删除或 Tab 已卸载都不会留下半绑定 Task。升级前已存在且未改绑的 legacy 缺失 binding 仍可编辑；new-session 的 scheduler reservation 不变。
- 新 Task Session 的 metadata 创建权由 scheduler 根据 `SessionStore` 决定，**与 Sidecar `EnsureSidecarResult.isNew` 无关**。guard、shared lease 与停止确认的完整事务见[第 6 节](#6-数据完整性)。
- single-session 的持久 binding 若既没有逻辑 Sidecar owner，也没有 Session metadata，执行前换成新 UUID 并原子重绑，绝不复活被用户删除的 Session id；`task:session-rebound` 提示 UI。`AttachedSession` 终态不能 generic rerun，后续工作必须重新 claim/reopen 并创建新的 Attached Task。
- permission 是本轮执行策略，可由 Task 指定；空值解析为对应 runtime 最大权限。
- durable Task 只保存 provider identity (`providerId + model`)，不保存 credential/env。
- 执行期间使用 `SidecarOwner::Task(taskId)`；terminal/stop/delete 对称释放。
- Task turn 的 completion descriptor 保留 `{ kind: 'task', id: taskId }` owner；Rust 通用 Session completion policy 据此抑制 generic toast，Task outcome/notification 仍由 Task domain lifecycle 唯一负责，attached/headless 都不因 Tab 是否存在而改变归属。
- Rust 每次 ensure attempt 只解析一次 owner-aware `RuntimeIdentity(runtime + runtimeSource)`，复用校验与 spawn 必须消费同一快照；Node 创建 Task metadata 时再从 live `SessionEngine.getRuntimeIdentity()` 取一次实际进程身份，并与同一 live config snapshot 绑定，禁止用 payload 中可能漂移的 runtime 反写。
- DSH Task 的 canonical identity 是 `runtime='dsh' + RuntimeSource:'integrated'`；显式 `runtimeConfig.source` 只能是 `integrated`，省略时也必须由 `runtime='dsh'` 确定性推导为同一 identity。TaskStore 校验、Cron payload、Rust Sidecar ensure 和 Node scheduled-turn preparation 都不得把它改写成 `system-cli`。

Task ↔ Session relation 只在 Runtime adapter 已接纳首轮 query 后，由 `onDispatched(queueId, sessionId)` 回调经 `/api/task/turn/admitted` 幂等提交。metadata 存在、Sidecar 已启动或 HTTP 请求已发出都不是 admission 证据。pending Comment 必须在该 relation 持久化后才按创建顺序进入同一 Session 的既有队列。

### 本地评论与全局通知

`comments.jsonl` 是 Comment 语义 authority；记录 author、时间、可选 reply 关系、冻结的 `conversationSessionId` 与最小 admission receipt。用户 Comment 先持久化，再选择至多一个目标：直接评论取最近一次已接纳 Session；回复有 Session 的历史 Comment 固定回该 Session；没有 Session 时保留 `pending_session`，之后不得自动改投另一个 Session。投送复用 Inbox/SessionEngine FIFO，不增加本地 Delivery、poll 或 ACK。冻结的 Session ID 只拥有 exact routing，不拥有 Session birth；投送必须在既有 Session lifecycle fence 内重新核对逻辑 Sidecar owner 或 durable metadata，已删除目标记为失败，不能用 Task workspace 复活同一 ID。

Agent 只能从已绑定 Session 显式调用 `myagents task comment` 写回；普通 assistant 输出不自动形成 Comment。Task 首轮可以从运行上下文安全解析当前 Task ID，用户 Comment 注入的后续轮必须使用 `TASK_COMMENT` reminder 中的显式 ID。Attached Task 使用同一本地时间线，但 Cloud IssueDelivery 与本地 Comment 各自保留自己的 reminder/CLI 回复通道，不镜像或双写。

TaskStore 维护可重建、最多 5000 条的 Agent Comment locator/excerpt index：启动异步扫描，之后 append/rename/delete 增量维护。全局通知 owner 只读取该 source、保存有界本地已读 receipt，并与 Cloud source 合并排序/分页；不复制 Comment 正文。通知目标使用 typed `task.comment` AppRoute，打开同一个 Task detail Drawer 并 focus exact Comment。

Drawer 的正文／评论阅读区独占评论导航滚动：通知定位、回复引用、加载更早评论和发送后的定位都通过该容器执行，焦点使用 `preventScroll`。不要在评论元素上调用会遍历祖先的 `scrollIntoView`；标题、Composer 和属性侧栏不属于评论定位的滚动范围。

带受支持 `managedKind` 的内部 Task 不属于本地 Comment 产品 surface：评论读写、pending flush、Agent CLI 写回、通知索引和执行 reminder 都必须排除；升级前若磁盘上已有这类 `comments.jsonl`，文件保留但不投送、不展示、不生成通知。

完整 provider/runtime/MCP 规则见 `task_provider_routing.md`。

## 4. Managed Task

记忆默认规则的初始化统一由 `workspace_files::memory_rules` 裁决：若工作区 `.claude/rules/` 的直接子文件中已有文件名包含 `memory` 的普通 Markdown 文件（文件名与 `.md` 扩展名均忽略大小写），视为已有记忆方案，整组跳过 `02-SOUL.md`、`03-USER.md`、`04-MEMORY.md` 的补齐。只检查文件名，不读取正文、不递归子目录、不跟随符号链接；没有匹配文件时保留既有的缺失补齐与内容保留行为。该判断覆盖开关、启动维护和 managed Task 的公共初始化入口；不改变 `UPDATE_MEMORY.md` 的独立准备。

默认模板初始化归 Rust；三个记忆 Skill 先理解工作区实际架构，沿用其职责、路径和引用，必要时可创建符合该架构的文件，不将命名差异当作补齐默认三件套的依据。Gardener / Molt 脚本盘点直接 Markdown 规则文件，以忽略大小写的文件名线索识别所有匹配层；未识别到可选层只是信息，不是默认文件缺失错误。默认日志目录检查是线索，由 Skill 结合工作区约定判断。

Gardener / Molt 的系统任务文本由 `memory_evolution` 生成。Scheduler 在 Task control guard 内、启动 timer 前通过 TaskStore 的 managed prompt 写入口收敛已有 `task.md`（仅 prompt，不改 Task row），覆盖 App 恢复、后续启动与 run-now 准入，失败沿既有调度错误路径处理，不执行旧文本。普通 Task 不参与；Task ID、运行配置、计划与历史不变。已安装的 Skill 通过现有 `SYSTEM_SKILLS_VERSION` 升级，启动同步先于 scheduler 恢复。

memory update、memory evolution 写入带 `managedKind` 的隐藏 Task，由同一个 Task scheduler 执行。普通 Task Center 列表默认过滤 managed Task，但 Session/history/audit 保留。`memory_auto_update_batch` 是遍历多个候选存量 Session 的调度器，本身不拥有持久 Session binding：Task row 使用现有 schema 的非固定绑定形态 `runMode=new-session` 且不写 `preselectedSessionId`，但该 `managedKind` 明确绕过 Session Engine，不会为调度器新建 Session；实际运行时才在 queue authority 下逐个绑定存量 Session 并发送 Memory Update query。历史 single-session 行由配置 reconcile 原位归一。Memory Gardener / Molt 才是实际创建新 Session 执行 Skill 的独立 managed Task。

Agent heartbeat 当前不属于 managed Task：由 IM Agent lifecycle 启停专用 timer/wake loop，经 `resolve_agent_heartbeat_route` 选择 private target，再交给 Channel 的 HeartbeatRunner。不要将它与上述记忆维护的 Task 调度路径混同；参见 `im/config_store.rs`、`im/commands.rs` 与 [IM 架构](im_integration_architecture.md)。

Evo configure 的 runtime/config 是完整目标配置，不是 Task PATCH：指定 runtime 却未指定 config 时，以 `{}` 显式替换旧配置；取消 runtime override 时清除两者。普通 Task PATCH 的省略字段仍表示保留。已有 Gardener / Molt 在 Task control guard 内重读、校验合并后的执行路由，再停止和原位更新；校验失败不先停任务。这样从 Codex managed-provider 切回 builtin 或同 runtime 移除配置时，不会继承不兼容配置，也不会丢失 Task ID 和历史记录。

Memory Gardener / Molt 的执行 Session 对用户保持隐藏，因此不发送逐次桌面通知，也不生成指向隐藏 Session 的 deep-link。Agent 设置中的 Evo 区域直接读取这两类 managed Task 的 `lastExecution` 权威摘要，只展示最近一次执行成功或失败及其时间；Renderer 不从隐藏 Session 文本或 `cron_runs` 推断结果，也不复制一份独立运行状态。

managed job 不再创建 managed CronTask 旁路。memory auto-update 的 configure 以 exact Agent ID 串行，并以 managed Task 的 `workspace_id` 持久化该 identity；进入锁后重新读取 `config.json`，只有 `Agent.enabled && memoryAutoUpdate.enabled` 才具备主动执行资格，关闭顶层主动能力不改写 Memory 子配置。磁盘上的 exact Agent 配置是 enable/disable、schedule 与参数的唯一权威，renderer 到达顺序和同路径 Agent 的持久化顺序都不能覆盖它。Project projection 解析出的 workspace 只负责当前执行目录与 workspace 级文件 IO 互斥，不参与 AgentConfig 选择或 Task 去重。

## 5. Legacy Cron 迁移

`cron_tasks.json` 是只读兼容输入。应用启动顺序为：

```text
校验 legacy store
-> migrate_legacy_crons_on_startup()
-> TaskSchedulerController.initialize()
-> Session Goal recovery
```

Cron 兼容 facade 发布 list/start/stop/update/delete/run-now，不发布 `cron get`；单条详情统一使用 canonical `myagents task get <taskId>`，同样只投影 TaskStore。未迁移历史行仅通过显式只读命令 `cmd_get_unmigrated_legacy_cron_tasks` 进入 Legacy 面板；deleted Task 仍作为 legacy id tombstone，旧行不会重新出现或再次迁移。

迁移规则：

| Legacy row | 处理 |
|---|---|
| 普通 At / Every / Cron | 同 ID 迁移为 Task，保留 schedule、状态、执行统计、Session 策略与通知 |
| 旧 Task-linked projection | 已有 Task 为权威，只补不倒退的 execution/session 数据 |
| managed row | 迁移/关联为隐藏 managed Task |
| Loop / 开发期 Goal row | 不迁移、不恢复 |
| credential 或 workspace 无法安全恢复 | 创建可诊断的 Blocked Task，不猜测路由 |
| store 损坏 | 整库只读，禁止用空/部分数据覆盖原文件 |

迁移幂等依赖原 ID 与 migration provenance，不另建 migration ledger。历史 run 文件尽力沿用/迁移同一 ID。所有新 `cron add/create/update/start/stop` 兼容入口均直接读写 TaskStore，永不写回 legacy 文件。

## 6. 数据完整性

界面中的列表、卡片与详情删除均先显示应用内 `ConfirmDialog`，确认后才调用 `taskDelete`；失败保持确认与错误反馈。AI CLI 删除则在执行前取得对话中的用户授权，不通过界面弹窗确认。Archive 可恢复；delete 没有 undelete / retention 承诺，也不删除用户工作区脚本。

Task mutation 的固定事务边界：

```text
TaskStore write lock
-> clone 当前权威 map
-> mutate + validate
-> 原子持久化 candidate
-> 替换内存 map
-> 解锁
-> event / notification / scheduler 副作用
```

`tasks.jsonl` 解析是 all-or-nothing；任一 malformed/duplicate row 使 Store 保持只读。写盘使用 tmp + `sync_all` + rename + parent fsync。Task id/path 入口统一经过 `validate_safe_id` 与 `task_docs_dir()` containment 校验。

Trigger 高频状态同样使用同目录临时文件、文件 `sync_all`、rename 与 parent fsync。checkpoint 与 pending activation 不允许拆成两次提交；脚本、Renderer、Node 和 CLI 只经过 TaskStore API，不能直接读写 `trigger-state.json`。

Task notification 的局部更新也在上述同一写事务内合并：字段缺失表示 unchanged，`false` 是精确值，`null` 只清除对应可选字段（desktop 恢复领域默认 `true`）。CLI 只发送用户实际指定的 patch，不先 GET 后拼出完整对象；完整 replacement 输入仍保留，但不得与 patch 同时出现。

Task 对 Session identity 的保护同时覆盖 durable 与 transient 两层：Running direct single-session Task 保护其固定 Session；`AttachedSession` Task 在 Todo/Running/Verifying/Blocked/Stopped 生命周期保护 Cloud claim 绑定的 Session；一次实际执行从 claim 发布 Session id 到 Sidecar `Task` owner 附着前，由 scheduler active-execution map 保护。任何 durable mutation 只要让 Task 进入上述受保护集合，或给已受保护 Task 新增 `preselectedSessionId/sessionIds` binding，都必须与 Session 删除取得同一个 per-Session lifecycle guard，统一使用 `lifecycle → TaskStore` 锁序；scheduler reservation 已持 guard 时使用显式的 held-guard commit 入口，禁止非重入二次 acquire。

startup legacy migration 也是 durable writer：`create_migrated_with_id` 与 `import_legacy_execution_state` 必须走同一 lifecycle policy，不能以“仅启动期”为由裸拿 TaskStore lock。`create_attached` 在取得 lifecycle 后还要复核 Session metadata；若删除先赢，拒绝创建本地 Attached Task。

首次 materialize 的 Task Session 持有 lifecycle guard，直到精确 Runtime admission 确认内存 Session 已建立，或 observer 先观察到 metadata 发布。创建方与 Sidecar ensure 通过 shared lease 表示同一次 guard 获取，ensure 不能再次获取相同 key。`confirm_turn_admitted` 必须先清除该 execution generation 的 birth lease，再提交 Task relation 和投送 Comment，避免二次获取同一 lifecycle 导致死锁。产品写盘失败不会延迟这个交接，也不影响已有逻辑 owner 的继续执行。Running single-session Task 的后续请求即使未被接纳，也保留 reservation 已确认的既有 Session；不得仅凭本轮 admission 或 metadata 缺失释放它。

如果新 Session 在内存建立和 metadata 发布前被**确认**失败，创建方必须释放 guard 与 Task owner，让下一次 reservation 重新取得创建权。如果 POST 可能已经到达 Node，只是响应丢失，lease 必须留在精确的 `ActiveTaskExecution`，worker 或 observer 异常都不能释放它。

`/task/stop` 返回 `not_found`，只有在 Node 的 metadata 创建前 admission 已取消，或 materialize 已经结束时，才表示停止已确认；Rust 随后删除精确 generation 并释放 lease。不能把“Runtime queue 尚未登记”误判为创建方已经退出，也不能在状态不确定时绑定第二个 Session identity。Sidecar 是否被其它 owner 保活不影响这一判断。

## 7. Goal 边界

Goal 是 Session 状态，不是 Task execution mode：

- 不创建 Task、不占用 Task status/schedule 字段。
- Task 与 Goal 可在同一 Session 共存；Task scheduler 不感知 Goal。
- Goal turn 的 completion descriptor 保留 `{ kind: 'goal', id: goalId }` owner；generic Session completion 被抑制，Goal terminal/outbox/notification 继续由 Goal domain lifecycle 负责。
- 在用户已明确要求使用 Goal 的前提下，Task 中的 AI 可在当前 Session 调 `myagents goal create`；Task 模型不增加 Task→Goal 编排字段。这是 API 可用的组合路径，不表示 Task 等待该 Goal 完成或停止 Task 会同时取消 Goal。
- 默认系统提示词要求显式选择 Goal Mode，且只在 desktop / 私聊场景注入 Goal guidance，不在群聊或 cron/headless 场景默认注入。该曝光/行为规则不等同于 API 按场景硬禁止创建；要支持默认自主使用，应先对齐产品规则和 `system-prompt-cli-tools.ts`。

详见 [`session_architecture.md`](session_architecture.md) 的“Goal 与跨 Session 协作”。

## 8. 主要入口

- Rust：`src-tauri/src/task.rs`、`task_application.rs`、`task_scheduler.rs`、`task_execution.rs`
- Legacy compatibility：`src-tauri/src/cron_task/*`、`legacy_upgrade.rs`
- Management API：`/api/task/*`（含 comment/list/context/retry、turn admitted、trigger validate/test/check-now/reset 与 run-now）及兼容 `/api/cron/*`。Node 的 canonical `/api/admin/task/{start,stop,runs}` 不套 ambient workspace guard，继续复用既有 Rust `/api/cron/{run,stop,runs}` TaskStore adapter；不新增第二套任务 authority。
- CLI：`myagents task ...` 是 Agent-facing canonical surface，覆盖通用 `create-direct`、评论写回、创建/启停、历史、exit、Trigger test/check-now/run-now/reset；`myagents record ...` 是 Record canonical surface，`myagents thought ...` 只保留兼容；`myagents cron ...` 只保留 App 内兼容，不在 token-authenticated 外部公开清单中
- Renderer：`src/renderer/components/task-center/`、`useCronTask`（兼容展示 hook）

用户可见的创建、列表、详情与评论交互以
[`../design/task_center.md`](../design/task_center.md) 为唯一当前规范；text/audio Record 卡片和录音详情见
[`../design/records_and_recording.md`](../design/records_and_recording.md)。本技术文档只保留下列投影边界：

- App Shell 只挂一个 `DispatchTaskDialog`。智能创建与 Record AI 讨论共用 discussion builder、runtime selection、required product Skill 和新 Chat launch；确认前不写 Task。
- 讨论原始输入由 Rust 的 `task-discussions/<discussionId>/input.json` 保管：跳转前写入完整正文、typed `TASK_DISCUSSION` scope、必需 Skill 的精确契约和 clientRequestId。保存失败不交接；Tab 只持久化 discussion locator，允许尚未 materialize 的 discussion Tab 恢复，但不从磁盘自动发送。pending discussion 的 transport/send 要等待原 Session birth owner 裁决；重载先提供恢复与显式启动重试，托管模型必须先创建真实 metadata，再附着 Sidecar。
- HTTP send receipt 只确认请求/队列接纳，不能证明 Skill dispatch 或 transcript 已持久保存。真实 user transcript（clientRequestId 或同一 typed discussion scope）到达后，历史接管恢复入口；原始 input 作为不可覆盖的讨论 artifact 留存，HTTP 成功和关闭 Tab 均不删除它。当前不设自动清理策略，讨论目录需整体保留，直到显式清理其 artifacts。
- 恢复提供原文查看、复制和完整契约重试。响应丢失显示“发送状态未确认”，先核对历史/队列再由用户明确重试；clientRequestId 只作关联，不承诺服务端幂等。`DesktopQueryDraft` 随持久 user message 保存 required Skill，原生 retry 仍经普通 admission 校验；旧 typed discussion annotation 补当前 canonical requirement，用户文本中的 XML 不获得此权限。旧目录没有正文时不推测恢复。明确 reset 与普通 pending→real materialization 分开：前者清掉 discussion locator 和 composer annotations，后者保留首轮契约；旧发送回执不能更新另一个 conversation 的投影。
- text Record 把当前完整正文作为用户可见 query；audio Record 只引用 `RecordStore` 在源 Record 根目录保证刷新的唯一 `content.md`。隐藏 reminder 只携带执行所需的 scope、Record identity/path 和文稿路径。
- 手动创建与编辑只写完整 `task.md`。`workspaceId + workspacePath` 由 TaskStore 在同一写锁内成对更新；周期专属字段不能从隐藏表单值进入一次性 Task。
- 任务中心的 Record 区只订阅 RecordStore change event，不轮询或复制 Recording/Speech 状态；详情从对应 authority 读取 snapshot。Record 与 Task 删除是独立事务。
- Task 分桶只是 durable status 的只读 Renderer projection，不拥有状态转换。详情 route 使用递增 generation；页面已经激活也不能吞掉新的 Task/Comment deep link。
- Command Task 的 test、check-now、run-now、reset 分别调用对应应用入口。新建 `single-session` Task 必须先 materialize 并持久化真实 `preselectedSessionId`。


### Retained Task audit reads

A deleted ordinary Task remains readable through get, comments, comment pagination/context
and runs. TaskStore decides this read identity; the Cron scheduling projection is not a
read authority. Comment insertion still rejects deleted Tasks. CLI schedule flags select
recurring/scheduled mode when omitted, rather than leaving accepted schedule fields unused.


### Task 通知策略与投递记录

Rust `task::notification` 统一处理通知策略与 Task 内的投递记录。`TaskApplication` 创建时按以下优先级确定 IM 目标：显式参数 → 当前执行中已确定的父 Task 策略（包括关闭）→ 经宿主验证的发起聊天 → 关闭。桌面开关和通知事件分别继承。普通 Agent 与 Team AI 规则一致；GUI 和没有有效宿主上下文的 CLI 不推测来源。

Node 只从内部调用当前轮次的 SessionEngine 快照生成来源上下文，丢弃调用者自报的 `notificationContext`；Management API 再校验 Sidecar 代次、父 Task、队列项与执行 Session。CLI 接入边界见 [CLI 架构](cli_architecture.md#task-通知)。

事件与目标分别解析。创建时未指定 `notification.events` 则继承父 Task 本轮已确定的订阅（包括空数组）；没有可继承的订阅时使用 `notification::DEFAULT_EVENTS`，当前为 `execution,done,blocked,endCondition`，覆盖每轮成功或失败的 AI 执行结果。显式列表替换默认／继承订阅，空数组不订阅任何事件；更新时省略字段保持原值。普通委托通常省略 CLI 的 `--notificationEvents`，只在需要筛选时设置；IM 回报仍需启用目标。

`execution` 是每轮 AI 执行结算，`done/blocked/stopped/verifying` 是目标状态，`endCondition` 是结束原因；状态和原因同时保留。once/scheduled 自然完成及周期任务达到结束条件的执行发布 `execution,done,endCondition`；没有 AI 执行的条件终止发布 `done,endCondition`。一次结算的多个命中事件合并为一条通知。只关心 Task 最终完成／阻塞可订阅 `done,blocked`；每轮结果订阅 `execution`。Agent-facing Skill 与 `task --help` 明确这些语义。

TaskStore 在同一结算事务的 `lastExecution.notification` 保存本轮通知决策：事件、当时订阅、`reason` 和可选 `deliveryId`。原因区分 `not-subscribed/disabled/internal-task/desktop-only/delivery-recorded`；后者只表示已有持久投递记录，进度和错误仍以 `notificationDeliveries` 为准。后续状态变更或策略编辑不得改写这份执行快照；旧数据缺失时保持未知，不按当前策略重建。它只审计最近一次 AI 执行，不建立第二份历史运行或投递存储。

现有 `notificationDestination` 只读投影增加有效 `events` 与 `executionResultsSubscribed`，`configured` 仍只描述目标地址。Node 的 `data.receipt.notification` 在 create/get/run/rerun 中直接转述该投影和最近执行决策；CLI human 输出区分当前订阅、历史决策和实际投递进度，不自行推算通知策略。

版本 1 的 `notification.im` 使用以下互斥目标，`current` 仅为输入简写，保存前必须解析：

| 目标 | 含义 |
|---|---|
| `off` | 关闭 IM 通知 |
| `conversation(channelId, sessionKey)` | 指定连接内的群聊或私聊；转述时使用其当前绑定 Session |
| `recent-private(scope=channel)` | 仅在指定 Channel 内选择最近私聊 |
| `recent-private(scope=agent)` | 在指定 Agent 的多个 Channel 中选择最近私聊 |

旧 `botChannelId` 唯一归属 Agent 时保留跨 Channel 自动选择语义；独立 Bot 保留连接范围。旧 `botThread` 不作为精确聊天地址启用，目标缺失或归属有歧义时留下可见诊断。未知通知版本使 TaskStore 只读，防止有损重写。Cron GUI/DTO 传递统一通知结构，旧 `delivery`/`notifyEnabled` 仅在兼容入口转换；局部更新不得覆盖未指定字段。

命中通知订阅的执行事件及其终态，在提交结果的同一 TaskStore 事务中合并通知意图，固定当时的策略与结果。需要 IM 投递或报告策略错误的意图写入 `notificationDeliveries`；仅桌面通知的意图不保存到该列表。IM 通知作业可据此恢复，业务任务不因投递失败重新运行。记录数量及结果、准备文本大小有明确上限，具体值见 `task/notification.rs`；超限报告失败并保留执行 Session，不挤掉待发通知。桌面通知独立尽力发送，不持久重放。

每条记录有稳定的 `deliveryId`，每次尝试有独立的 `attemptId`，后者同时作为转述队列的 `queueId`。Session 接纳回执必须匹配准确的 attempt；迟到回执必须匹配当前尝试与目标 Session。新增通知以 `handed-off` 表示目标 Session 已接纳，不代表 IM 已发送；旧版的 prepared/sending/sent/suppressed/partial 保留历史语义，准确枚举见共享 Task 类型。重启后无法确认完成的准备或发送转为 `unknown`；`unknown`/`partial` 不自动重试，用户明确 `resend` 才承担重复风险。删除 Task 时在同一事务取消未交接记录；停止、重跑和归档不等于取消通知，已被 Session 接纳的信息无法收回。旧 suppressed 可手动 retry；升级不自动补发。旧 prepared 尚未外发，恢复为 waiting 并交接原始事件，不再发旧准备文本。

`notification_worker` 解析并固定聊天地址，复用 ChannelOwner、Inbox 和 SessionEngine。`admitTaskNotification` 使用普通 `enqueueInboxMessage` 与精确 `dispatchAcceptance`：排队 ACK 不等于已交接，真正接纳后记录 `handed-off`，不等待模型回复，不代替目标 Session 向 IM 发送。目标按实际执行轮的 auto/tool_only 模式决定是否及如何通知用户，模式不阻断 Task 信息入站。排队后的 `beforeDispatch` 检查绑定，换绑则重解析同一个聊天。已接纳后的模型或 IM 失败不改判交接状态；不增加 Task 执行次数，不创建 replyBack。执行 Session 已是目标 Session 时复用已有结果，状态事件在同 Session 只补 transcript 记录；其他状态事件也进入普通 Inbox。未知交接不自动重试。

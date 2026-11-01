---
name: myagents-task-automation
description: >-
  让 Agent 建立 MyAgents Task 的完整产品心智模型，并创建、验证和治理需要持久追踪、独立 Session 或未来触发的工作：理解 Task 与立即执行/Record/Goal 的边界，以及 once/scheduled/recurring、Session routing、结束条件和 command Detector。用户提到创建 Task、定时、稍后、周期检查、持续关注、满足条件才处理时使用；普通立即执行、仅保存 Record 或明确要求 Goal Mode 的工作不使用。
metadata:
  author: MyAgents
---

# MyAgents Task 与自动化

## 先建立 Task 产品心智模型

Task 是 MyAgents 对“需要在当前对话之后继续存在、在未来被执行和追踪的工作”的统一承载。它不是一条临时提醒，也不是一段 Cron 表达式；它把用户的行动目标保存成有身份、有状态、有执行记录、可暂停和可恢复的工作项，并在合适的时机把工作交给 AI。

一个自动化 Task 由五个彼此独立的决策组成：

```text
Task = action（AI 被激活后做什么，权威内容在 task.md）
     + schedule（何时产生一次执行机会）
     + activation（机会出现时是否真的唤醒 AI）
     + Session routing（在哪段上下文中工作）
     + end conditions（何时不再继续）
```

schedule 只负责产生执行机会，不等于 AI 已经运行；activation 再决定这个机会是直接进入 AI Turn，还是先由程序筛选。这样，普通定时任务与“持续检查、命中才处理”共享同一个 Task 生命周期，而不需要两套产品实体。

Task 解决四类问题：

- **意图持久化**：工作不依赖当前聊天回合继续存在，之后仍可查到目标、配置和状态。
- **未来触发**：支持指定时间一次、固定间隔和 Cron 墙钟计划。
- **按需唤醒**：既能每次到点都运行 AI，也能先做低成本确定性检查，避免无意义的模型调用。
- **治理与追踪**：统一管理 Session 去向、运行历史、暂停/恢复、结束条件和失败健康状态。

### 与相邻能力的边界

| 用户真正需要的是什么 | 正确承载 |
|----------------------|----------|
| 现在就在当前回合完成一件事 | 直接执行，不创建 Task |
| 先保存一条文字或音频记录，暂时不执行 | Record |
| 一项已经明确、需要未来触发或持续追踪的工作 | Task |
| 当前 Session 围绕同一目标连续多轮自主推进 | Goal Mode，不用循环 Task 模拟 |
| App 完全退出后仍必须由 OS 常驻执行 | 不属于 MyAgents Task；不要伪装成已部署成功 |

Cron 只是已发布的兼容命令面，不是另一种资源；Sensor 也不是独立产品实体。`TaskStore` 是唯一权威，新 Agent 工作流统一使用 `myagents task ...`。

### 生命周期应怎样理解

创建 Task 只是把它持久化为 `Todo`；首次 `run` 后，时间型 Task 进入 `Running`，表示 scheduler 已启用，不表示 AI 此刻正在执行。每个 tick 经 activation 后才可能产生 AI Turn。首次 tick 由 schedule 决定：固定 interval 默认在 `run` 后约 2 秒产生第一次机会（要延后就显式设置 `--startAt`），Cron 等到下一个墙钟点，scheduled 等到 `dispatchAt`。`stop` 暂停未来调度并停止活跃执行；`start` 按保留的 schedule anchor 恢复，anchor 已过期时下一次机会可能接近当前时间，应以回执里的 `nextExecutionAt` 为准。`rerun` 重新派发终态 Task；`run-now` 是一次绕过 Detector 的人工执行，不改变 schedule 或 checkpoint。

MyAgents App 必须在线才会产生 tick 或执行检查。Task 可以在 App 后台驻留时运行，但完全退出或 OS 休眠期间不会运行，也不会逐个补跑错过的 tick。

正常创建和列表会自动继承当前 MyAgents workspace，不需要先查 ID。只有明确跨 workspace 操作时才同时传 `--workspaceId` / `--workspacePath`；若要诊断当前身份，使用 `myagents agent current --json`。命令语法有疑问时运行 `myagents task readme` 获取当前紧凑契约；精确参数以对应命令的 leaf help 为准。

## 选择激活方式

| 方式 | 每个 schedule tick 的效果 | 适用情况 | Task 配置 |
|------|---------------------------|----------|-----------|
| `always` | 直接派发普通 Task AI Turn；没有前置程序判断 | 每次到点都值得让 AI 行动，例如提醒、日报、定期总结；或是否行动只能由模型理解 | 省略 `--trigger-file` |
| `command Detector` | MyAgents harness 先运行本地命令；`quiet` 不创建 Session、不唤醒 AI，`activate` 才把事件证据交给普通 Task AI Turn | 外部条件能由廉价、确定的程序判断，而且大多数检查应该保持静默 | 验证后传 `--trigger-file` |

默认选择 `always`。只有“程序可以可靠判断是否命中”“运行程序明显比唤醒 AI 更便宜”“未命中时不需要 AI 参与”同时成立，才使用 `command Detector`。不要创建一个脚本，再让脚本无条件输出 `activate`；那与 `always` 等价，只增加故障点。

一旦选择 `command Detector`，在编写脚本或 Trigger 前完整读取 `references/command-detector.md`。该 reference 是命令结构、stdin/stdout 协议、checkpoint、fixture 测试、安全边界和 failure 行为的详细契约；普通 `always` Task 不需要加载它。

## 决策顺序

1. **行动**：命中时 AI 具体做什么。把它写进 `task.md`；Detector 的输出只能提供事件证据，不能代替行动目标。
2. **时间**：选择未来某时执行一次、固定间隔或 Cron 表达式。墙钟时间默认使用本机 IANA 时区；用户指定其他时区时显式保存。
3. **激活策略**：按上表选择 `always` 或 `command Detector`。只向用户澄清实际效果，不要求用户理解这两个内部名称。
4. **Session**：延续当前/已有上下文用 `single-session`；每次需要隔离上下文用 `new-session`。
5. **结束**：一次性任务自然结束；循环任务根据用户意图选择最大 AI 执行次数、截止时间、允许 AI 主动退出，或持续到用户暂停。Detector 的 quiet 检查不计入 AI 执行次数。

只澄清会改变这些选择的缺失信息。普通的明确创建请求在信息齐全后连续完成准备、验证、创建、回读和启动，不逐步索要批准；删除仍遵守 `/myagents-cli` 的确认规则。若本轮来自 `<TASK_DISCUSSION>`，则由 `myagents-task-alignment` 负责候选文档与创建前确认，必须等用户明确确认后才 mutation。

## `always`：到点直接激活

先用标准文件工具写 `task-action.md`，再创建 Task。长文本不要拼进 shell command。

未来某时执行一次：

```bash
myagents task create-direct --name "send release reminder" \
  --taskMdFile task-action.md --executionMode scheduled \
  --dispatchAt 2026-08-04T09:00:00+08:00 \
  --runMode single-session --preselectedSessionId current --json
```

周期执行：

```bash
myagents task create-direct --name "daily report" \
  --taskMdFile task-action.md --executionMode recurring \
  --cronExpression "0 9 * * *" --cronTimezone Asia/Shanghai \
  --runMode new-session --json
```

固定间隔使用 `--intervalMinutes <n>`（最小 5 分钟）。默认首次 tick 在 `run` 后约 2 秒；如果用户希望“从一个 interval 之后才第一次检查”，同时传带时区的 `--startAt <ISO-8601>`。普通 Task 省略 `--trigger-file`，其有效激活策略就是 `always`。

## `command Detector`：命中才激活

只有在上面的三个条件都成立后才进入本节。完整读取 `references/command-detector.md`，再编写脚本、隔离测试输入并部署；不要凭本文件的摘要猜协议。

条件 Task 与普通 Task 只有一个创建差异：验证通过后在 `create-direct` 加入生产用 `--trigger-file`。例如：

```bash
myagents task create-direct --name "watch CI failure" \
  --taskMdFile task-action.md --executionMode recurring --intervalMinutes 5 \
  --runMode single-session --preselectedSessionId current \
  --maxExecutions 1 --trigger-file trigger.production.json --json
```

这里的 `--maxExecutions 1` 表示首次 activate 并完成 AI Turn 后结束；之前任意数量的 quiet 检查不消耗次数。需要持续观察后续事件时省略它。

## 结束条件

创建 ordinary scheduled/recurring Task 时可组合：

```text
--deadline <ISO-8601-with-offset>  到达该时刻后不再开始新 AI Turn
--maxExecutions <positive-int>     限制已结算的 AI 执行次数
--aiCanExit true|false             是否允许任务内 AI 主动结束
```

当 `--aiCanExit true` 且行动已经完成、继续运行无意义时，Task 内的 AI 可以调用：

```bash
myagents task exit --reason "goal achieved: ..."
```

它不是临时失败的逃生按钮。瞬时错误应按 `task.md` 的处理策略重试或报告；不要擅自结束用户仍需要的周期任务。

## 创建后的确定性流程

创建命令始终加 `--json`，从结果解析权威 `taskId`，然后回读并启用：

```bash
myagents task get <taskId> --json
myagents task run <taskId> --json
```

创建、`get`、`run`、`rerun` 的 JSON 结果都提供固定的 `data.receipt`：从这里读取 `taskId`、`status`、`statusMeaning`、`changed`、`nextExecutionAt`、瞬时 `executionState` 和 `resultAccess`，不要猜测不同命令的旧字段层级。`Running` 只表示 scheduler enabled；重复或并发 `task run` 已经 Running 的 Task 会成功返回 `changed: false`，不会创建第二次派发，也不应重试。`start`、`stop` 的既有回执仍包含权威状态与 `nextExecutionAt`。首次从 Todo 启用用 `task run`；暂停后恢复用 `task start`；终态重新派发用 `task rerun`。不要通过目录时间或猜测名称寻找刚创建的 Task。

`resultAccess` 只解释现有结果通道：`single-session` 的结果留在绑定 Session；`new-session` 的结果留在各次执行 Session 和 `task runs` 历史。通知回报位置由 `notification` 决定：通过 Channel 对话创建时默认回到原聊天的当前 Session；执行 Task 中创建后续 Task 则继承本次执行的通知策略，包括 off。普通 assistant 输出不会自动复制为 Task 评论，需要沉淀到本地时间线时显式调用 `task comment`。

## 通知与结果回报

执行 Session 与通知收件人是两个独立选择。普通 Agent 和 Team AI 都默认回发起的 Channel + sessionKey；GUI 或无宿主上下文的 CLI 默认关闭 IM。创建后从 `task get` 核对最终规则、来源和可用性，不能从 prompt 中猜来源 ID。

普通委托希望每轮执行结束都回报时，通常省略 `--notificationEvents` 即可：没有可继承的父 Task 事件订阅时，默认订阅 `execution,done,blocked,endCondition`，覆盖每轮成功或失败的执行结果。执行 Task 中创建后续 Task 时，省略该参数会继承父 Task 本轮已确定的事件订阅（包括空数组）；更新时省略则保持原值。IM 回报仍需通知目标已启用。

只有需要筛选通知时才显式设置 `--notificationEvents`。显式列表会替换默认或继承的事件订阅；`'[]'` 关闭所有事件。同一次结算命中多个订阅只生成一条通知。

| 事件 | 覆盖范围 |
|---|---|
| `execution` | 每轮 AI 执行结束，包含成功和失败；周期 Task 的每轮结果也在此列 |
| `done` | Task 进入完成状态，包含自然完成、结束条件触发和手动完成；周期 Task 每轮结束不一定完成整个 Task |
| `endCondition` | 一次性／定时 Task 自然完成，或达到截止时间、执行次数、AI 主动结束等结束条件；可能没有本轮 AI 执行 |
| `blocked` | Task 进入阻塞状态；周期 Task 尚未达到阻塞条件的单次失败只触发 `execution` |
| `stopped` / `verifying` | Task 进入停止／验收状态；默认未订阅，需要时显式加入 |

需要每轮结果时保留默认订阅，或显式包含 `execution`；只关心整个 Task 完成或阻塞时，可显式订阅 `done,blocked`。

需要覆盖默认时用 `--notificationTarget off`、`--notificationTarget current`，或 `--notificationTargetFile target.json`。文件内容例如：

```json
{"type":"conversation","channelId":"实际连接 ID","sessionKey":"该连接已知聊天的 sessionKey"}
```

固定某连接最近私聊用 `{"type":"recent-private","scope":"channel","channelId":"..."}`；明确允许跨平台跟随同 Agent 最近私聊用 `{"type":"recent-private","scope":"agent","agentId":"..."}`。`current` 必须有确定来源，否则报错。`--notificationDesktop false` 只关闭桌面，`--notificationEvents '[]'` 不订阅事件；更新省略字段保持原值。

Task 结果由目标聊天当前 Session 转述，自动通知遵守 `auto/tool_only`。`data.receipt.notification.destination` 提供当前有效事件及 `executionResultsSubscribed`；`configured` 只表示目标已配置。`lastExecutionDecision` 是最近一次执行结算时的通知决策，包含当时事件、订阅、原因和可选 `deliveryId`；旧执行缺失时表示未记录，不能按当前配置猜历史。`not-subscribed/disabled/internal-task` 解释为何没有 IM 投递记录；`desktop-only` 仅计划桌面通知；`delivery-recorded` 表示已生成投递记录，实际进度查 `notificationDeliveries`，`handed-off` 只代表主 Session 已接纳。失败用 `task notification <taskId> --deliveryId <id> --action retry` 重试回报；unknown/partial 先核对目标，只有明确接受可能重复时才 `resend`；`cancel` 取消该条回报。以上操作均不重跑 Task。改规则只影响后续产生的回报。

## 治理

```bash
myagents task get <taskId> --json       # 权威配置、状态、Detector health/checkpoint
myagents task runs <taskId> --limit 5 --full --json # 最近 AI 执行历史与结果正文
myagents task check-now <taskId>        # 真实 Detector 检查；提交状态，命中会激活 AI
myagents task run-now <taskId>          # 绕过 Detector，直接执行 AI
myagents task stop <taskId>             # 暂停 schedule，保留 checkpoint
myagents task start <taskId>            # 按原 anchor 恢复；查看回执 nextExecutionAt
myagents task reset-checkpoint <taskId> # 只清平台 checkpoint
myagents task update <taskId> --clear-trigger # 改回 always
myagents task archive <taskId>           # 用户专属的长期可恢复归档
myagents task delete <taskId>            # 在对话中先取得用户确认，再执行；CLI 不弹窗
```

`check-now` 会提交真实 MyAgents 状态；部署前不提交 MyAgents 状态的验证使用 `trigger test`（脚本自身副作用仍真实发生）。`run-now` 不改变 schedule anchor 或 Detector checkpoint。

归档和删除不是同一种“软删除”：`archive` 是长期可恢复的产品状态；`delete` 会立即停止调度、移除平台 Trigger state/pending activation，并从正常产品使用中不可恢复地移除 Task。TaskStore 只保留防止旧 Cron 重新迁移所需的内部 tombstone 与审计；没有 30 天恢复承诺，也没有 undelete 命令。两者都不会越权清理工作区脚本、脚本数据库或外部状态。

## 本地 Task 评论

Task 可以作为跨 Session 的本地协作中枢。需要回看时间线时用 `myagents task comments <taskId> --json`。只有当结果、风险、经验或待用户决策的信息确实值得沉淀到 Task 时，Agent 才显式调用：

```bash
myagents task comment <taskId> --body-file result.md --json
```

在 Task 自身触发的执行 turn 内可省略 `<taskId>`；在用户评论注入的后续 turn 中，必须使用隐藏提醒提供的显式 Task ID。

回复某条评论时增加 `--reply-to <commentId>`。长文本始终先写文件，不把多行正文拼进 shell。普通 assistant 回复不会自动登记为 Task 评论；从本地 Task 评论收到的 query 应服从该轮 `TASK_COMMENT` reminder，而从 Space Issue Delivery 收到的 query 继续使用 Cloud Issue 的回复命令，二者不得默认双写。

## 给用户的部署回执

部署成功后一次说明：

- Task 名称与 ID
- 何时执行或检查，包括时区
- 到点直接激活，还是满足什么程序条件才激活
- 激活后的 AI 动作
- 目标 Session 策略
- 结束条件或“持续到手动停止”
- App 在线限制和 Task Center 治理入口

quiet 检查保持静默。activate 后由目标 Session 中的 AI 正常交付工作结果；Detector failure 只进入 Task health/backoff，不伪装成业务判断，也不再创建一个 AI Task 去监控 Detector。

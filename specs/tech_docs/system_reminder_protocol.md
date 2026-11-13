# System Reminder 隐藏消息协议

`<system-reminder>` 是注入到 AI session 的 user message 协议：让模型看到一段
系统/产品上下文，同时让用户气泡只展示 envelope 外的 visible tail，并可展示一个
小 badge。凡是需要"模型可见、用户气泡不直接展示"的投送消息，都应优先复用这套
协议，不要为单个场景另造隐藏规则。

Space IssueDelivery 在这层通用 envelope 内还有独立的 Registered Agent Prompt contract。当前结构、旧客户端兼容面、完整模板与拼接规则见 `space_issue_delivery_protocol.md`；本文只拥有 leading reminder、badge 与 visible tail 的通用语义。

## 适用场景

- 后台任务、Cron、IM heartbeat 等系统事件需要唤醒或提示 Agent。
- 浮球、Space Issue 等入口需要给模型补充上下文，但用户气泡只显示真实用户文本
  或一条短系统提示。
- 注入的 user message 需要在会话历史、标题、搜索跳转、消息预览里保持可控展示。

不适用场景：

- 整个 Session 生命周期都稳定成立的 MyAgents 身份、场景与能力发现提示，走
  [`system_prompt_architecture.md`](./system_prompt_architecture.md) 的产品级 system
  prompt append；Workspace 长期规则继续由 `CLAUDE.md` / rules / Runtime 原生项目指令
  拥有。
- 普通跨 session send/watch 事件仍走 `session_architecture.md` 的
  `<myagents-session-event>` 协议。协议整体位于隐藏 envelope 内；renderer 只对
  `send.request` 提取 `<payload>` 与 `source_label` 形成用户可见气泡，自动
  `send.result` / watch / 本地 `network.return_unavailable` 事件继续保持隐藏。不得把内部 summary / session id 暴露到气泡。
- 工具产物、图片、文件不要塞进 prompt 字符串，走 `tool_attachment_pipeline.md`
  的 `ToolAttachment[]`。

## 协议结构

标准结构：

```xml
<system-reminder>
<BADGE_TAG>
<instruction>
  只给模型看的处理指令。
</instruction>
<context>
  只给模型看的结构化上下文。
</context>
</BADGE_TAG>
</system-reminder>
用户可见文本
```

规则：

1. 整条消息必须以 `<system-reminder>` 开头；`parseLeadingSystemReminder()` 只解析
   leading envelope。
2. `<system-reminder>` 内第一层、第一枚 XML-like tag 是 `kind`，也是前端 badge
   的来源。例如 `<HEARTBEAT>` / `<CRON_TASK>` / `<FLOATING_BALL_CONTEXT>`。
3. `</system-reminder>` 后面的文本是 `visibleText`，会作为用户气泡正文展示。
4. `system-reminder` 内部 payload 会进入模型上下文；在有 `visibleText` 的标准
   mixed message 中，用户气泡、Session 搜索/预览、Query Navigator 与统计详情的
   turn trigger 都只使用 `visibleText`。
5. 同一条消息只应有一个 leading `system-reminder` envelope。对于带版本 CHANNEL_CONTEXT 的新消息，`parseLeadingSystemReminder()` 只移除一个 envelope 及一个分隔换行，literal visible tail（包括 XML 和空白）原样保留。历史消息保留第一段的 kind/body/rawReminder，并兼容性地从 visible tail 再剥离至多 8 段连续 reminder；`systemReminder.test.ts` 的 nested-envelope 用例覆盖此行为。Desktop → IM 镜像也在其防泄漏边界防御性剥离异常堆叠的 leading envelope。这些都是历史/异常输入兼容，生产者不得据此堆叠 envelope。
6. 如果没有 `visibleText` 且没有用户附件，前端应把整条 user bubble 视为纯隐藏
   reminder，不渲染气泡正文。Goal 自动续跑、objective update 等“只给模型看”的
   注入依赖这个语义。
7. 如果没有 `visibleText` 但带附件，保留附件气泡与 badge，避免误吞真实用户可见
   附件。

这里有三个正交事实，调用方不得混用：

- **visible turn**：由 `resolveVisibleUserTurnText()` / `stripLeadingSystemReminder()` 决定，只回答 UI 可以展示什么；纯 reminder 返回空，hidden payload 不得 raw fallback。
- **human query**：由 `isHumanUserMessage()` 决定，只服务 Memory 候选与 human-query 统计；附件可构成真人 query，但 Memory/Heartbeat/Cron/Space/Session Event/local command 等系统投送及对应 automation/channel/inbox origin 不因有 visible tail 就变成人类输入。
- **meaningful activity**：由 runtime 接纳后的 `session-activity-policy` 在 admission/terminal lifecycle 决定；它控制 `lastActiveAt`，不读取 `isHumanUserMessage()`。origin 是权威事实，只有 origin unknown 时才用标准 reminder kind 做兼容 fallback。

因此 `turnCount` 可以统计所有持久 user turn，`humanQueryCount` 只统计真人输入，而 preview/search/detail 只展示 visible 内容；三者不应为了数值一致而复用同一个 classifier。

Task（含 Cron 兼容入口）的当前结果通知通过既有 Inbox 的本地 `task.result` 事件进入目标
Session；`renderSessionEventPrompt` 使用 `myagents-session-event` envelope 携带 Task、delivery
及结果关联。Task 通知由 [TaskStore](task_center.md#task-通知策略与投递记录) 管理，目标 Session 接纳即记录交接成功，回复仍由目标按本轮渠道模式处理，
不再经过 Heartbeat 待发队列或唤醒流程。普通 Heartbeat 保持原协议；`cron-event-relay`
仅兼容旧 Heartbeat 请求中的 Cron 事件，不是当前 Task 通知入口。

## 前端展示规则

核心实现：

- 解析：`src/shared/systemReminder.ts::parseLeadingSystemReminder`
- 消息渲染：`src/renderer/components/Message.tsx`
- 标题/预览辅助：
  - `src/shared/sessionTitle.ts`
  - `src/server/utils/session-message-preview.ts`
  - `src/renderer/components/chat/QueryNavigator.tsx`
  - `src/renderer/floating-ball/useFloatingSession.ts`

`Message.tsx` 的行为：

- 如果有 leading `<system-reminder>`，先解析 `kind` 和 `visibleText`。
- `kind` 命中 `systemTagLabel()` 时，在用户气泡上显示对应 badge。
- 当存在 `visibleText` 时，气泡正文只展示 `visibleText`。
- `myagents-session-event type="send.request"` 是已有的可见请求例外：其 payload 虽位于 reminder 内，气泡与 CLI `session get` 共用 `parseSessionSendRequestDisplay` 提取请求正文；来源标签仅用于 badge，event-summary 与控制属性仍隐藏。有可见 tail 时优先 tail。自动 result/watch 等事件不享有该例外。
- 当不存在 `visibleText`、可见 send.request payload 且没有附件时，整条 user bubble 不渲染；hidden payload
  不得走 raw fallback 泄漏到 UI。
- 当不存在 `visibleText` 但有附件时，保留附件气泡和 badge，hidden payload 仍不展示。
- 未被 `systemTagLabel()` 识别的 `kind` 不会自动有 badge；新增 badge tag 必须显式
  更新前端映射和测试。

当前有 badge 的 tags：

| Tag | Badge | 主要生产入口 |
|-----|-------|--------------|
| `HEARTBEAT` | Heartbeat / 心跳感知 | 普通 heartbeat；保留旧 cron event payload 的兼容格式，当前 Task 通知不使用它 |
| `CRON_TASK` | Cron task / 定时任务 | Cron task 执行 prompt |
| `FLOATING_BALL_CONTEXT` | Floating context / 浮球上下文 | 浮球消息上下文注入 |
| `myagents-space-issue` | Space issue | Agent 提及 | `src/shared/agentMentions.ts::composeQueryReminder`，调用方 SessionEngine facade | 单 leading envelope 内的 `<AGENT_MENTIONS>`；正文保留完整代号，不自动执行协作 |
| Space IssueDelivery |
| `GOAL_CONTINUATION` | 目标模式 | Goal 自动续跑 / Goal 第一轮启动 |
| `GOAL_CONTEXT` | 目标模式 | Goal 运行中用户普通 query 的 hidden context |
| `TASK_DISCUSSION` | 任务讨论 | 智能创建 / Record AI 讨论首轮 |
| `TASK_COMMENT` | Task 评论 | 本地 Task 时间线向 exact Session 注入 query |

`MEMORY_UPDATE` 当前是内部纯隐藏场景，不属于有 badge 的可复用展示协议。若要让它
或新 tag 出现在用户气泡上，先补 `systemTagLabel()`、文案资源和渲染测试。

## Desktop query 的组合与重试

`src/shared/agentMentions.ts::composeQueryReminder` 是 Desktop query 组合入口；`SessionEngine` 的公共 facade 在选择具体 Runtime 后、进入 adapter 前处理结构化 context。Goal owner 提供 primary Goal context；任务讨论/悬浮球入口提供 typed context；Agent 提及提供当前 discovery 信息。各部分进入同一个 leading envelope，首个 primary tag 保留原 badge；仅 Agent 信息时使用 `AGENT_MENTIONS` badge。变量字段先 escape，Agent description 不成为产品 instruction；不能把用户输入的 XML 解析成可信 metadata。

原 `SessionMessage.desktopQuery` 保存 visibleText 与非秘密 typed context，builtin/external 原 queue/codec/rewind 都保持它。retry 使用此 annotation 重新查目录和组合，不能重用旧 hidden 字符串再追加 envelope。展示与 Desktop→IM 镜像仍走既有 visible helpers。具体 identity/草稿/分页边界见 [Agent 网络](./agent_network.md)。

## 生产使用点

严格符合"hidden payload + optional visible tail + badge tag"的生产入口：

| 入口 | Builder / 位置 | 结构 |
|------|----------------|------|
| Scheduled Task 执行 | `src/server/utils/cron-reminder.ts::buildCronTaskReminder` | `<system-reminder><CRON_TASK>...</CRON_TASK></system-reminder>` + 原 task prompt；tag/wire name 为历史兼容 |
| Task 讨论首轮 | `src/shared/systemReminder.ts::buildTaskDiscussionReminder`，调用方 App Shell 提供 typed context，SessionEngine facade 组合 | `<system-reminder><TASK_DISCUSSION>...</TASK_DISCUSSION></system-reminder>` + 用户原始目标；hidden 只携带 discussion/workspace/可选 Record identity，required Skill 另走 admission 字段 |
| Task 本地评论 | `src/shared/systemReminder.ts::buildTaskCommentReminder`，调用方 Inbox `task.comment` event drain | `<system-reminder><TASK_COMMENT>...</TASK_COMMENT></system-reminder>` + 用户评论；包含 exact Task/Comment/Session、task.md 路径与显式 CLI 回复 instruction |
| Goal 第一轮启动 | `src/shared/systemReminder.ts::buildGoalContinuationReminder`，调用方 `src/server/session-engine/goal-orchestrator.ts::goalContext` | `<system-reminder><GOAL_CONTINUATION>...</GOAL_CONTINUATION></system-reminder>` + 原始 Goal query visible tail；用户气泡显示原文与 Goal badge |
| Goal 自动续跑 | 同一 builder，调用方 `/goal/execute-sync` | `<system-reminder><GOAL_CONTINUATION>...</GOAL_CONTINUATION></system-reminder>`，第二轮起纯隐藏 |
| Goal 普通 query context | `src/shared/systemReminder.ts::buildGoalContextReminder`，调用方 Goal-aware chat enqueue 路径 | `<system-reminder><GOAL_CONTEXT>...</GOAL_CONTEXT></system-reminder>` + 用户 visible query |
| 浮球消息 | `src/shared/systemReminder.ts::buildFloatingBallContextReminder`，调用方 `src/renderer/floating-ball/useFloatingSession.ts` 提供 typed context，SessionEngine facade 组合 | `<system-reminder><FLOATING_BALL_CONTEXT>...</FLOATING_BALL_CONTEXT></system-reminder>` + 用户文本 |
| Agent 提及 | `src/shared/agentMentions.ts::composeQueryReminder`，调用方 SessionEngine facade | 单 leading envelope 内的 `<AGENT_MENTIONS>`；正文保留完整代号，不自动执行协作 |
| Space IssueDelivery | `src-tauri/src/space_cloud/delivery.rs::build_space_issue_delivery_message_for_locale` | `<system-reminder><myagents-space-issue>…</myagents-space-issue></system-reminder>` + 本地化可见提示 |
| Task 结果回到聊天 | `src/server/inbox/session-event.ts::renderSessionEventPrompt`，调用方 `session-engine/task-notification.ts` | 既有 `<myagents-session-event type="task.result">` envelope；只接受本地宿主事件，复用原展示协议，不新增 badge |
| 旧 heartbeat cron payload 兼容 | `src/server/utils/cron-event-relay.ts::buildCronEventRelayMessage` | `<system-reminder><HEARTBEAT>...</HEARTBEAT></system-reminder>` + `[System]收到来自系统投送的信息`；当前 TaskStore 通知不调用此路径 |

command Trigger 命中时仍使用 `CRON_TASK` 这一兼容 tag；builder 在 hidden payload 中追加规范化 `<activation-event>`，只包含 event id/kind/time、reason code 与 untrusted handoff。Detector checkpoint、stderr、命令路径和 harness error 永不进入 Session。handoff 来自外部事实，必须被 XML escape 并明确作为不可信上下文；它不能覆盖 `task.md`、消息 role 或 Session/Runtime 配置。没有 Activation Event 的 always Task 保持原 reminder wire shape。

`TASK_COMMENT` 与 `myagents-space-issue` 是相互独立的回复契约：前者只指向本地 `myagents task comment`，后者继续指向 Cloud Issue 命令。即使两种 query 进入同一个 Attached Task Session，也不得根据 Task 类型改写来源 reminder、自动镜像或双写。

相关但不是完整复用模板的入口：

Space 的内部 trust boundary 不改变通用 reminder wire protocol：Cloud 提供权威 Registered Agent instruction/revision、transport 索引与轻量因果导航；Desktop 描述当前 CLI/workspace/Task 执行方法并组装 Prompt；Issue 用户文本必须有界 XML escape，不能伪造结构。Renderer 仍只消费外层 `myagents-space-issue` badge 与 reminder 后的 visible tail。Cloud 继续为受支持的旧 Desktop 提供版本化 projection；current Desktop builder 只生产当前结构。

- `src/server/index.ts` 普通 heartbeat：纯
  `<system-reminder><HEARTBEAT>...</HEARTBEAT></system-reminder>`，没有 visible tail；
  如果进入可见 transcript，按纯隐藏 reminder 处理，不展示用户气泡正文。
- `src/server/index.ts` memory update：纯
  `<system-reminder><MEMORY_UPDATE>...</MEMORY_UPDATE></system-reminder>`，内部维护用途；
  不要把它当成可复用用户气泡模板。
- 当前具有精确渠道绑定的 Session：实际 admission 按[渠道上下文规则](#channel-context)插入版本化 `CHANNEL_CONTEXT`；只有该段时使用“渠道消息” badge，与已有 primary 共存时仍使用原 primary kind。
- `src/server/utils/watchdog-auto-resume.ts`：纯 reminder，没有 badge tag。

## 生成侧要求

新增场景时优先新增 builder/helper，不要在业务流程里手拼大段字符串。Builder 需要
做到：

1. 明确 `kind` tag，并决定是否需要前端 badge。
2. 明确 visible tail：用户应该看到什么，就放在 `</system-reminder>` 之后；不该
   看到的内容必须留在 envelope 内。
3. 对 prompt/tool/cloud/user 可控内容做转义或结构标签中和，至少防止：
   - 提前闭合 `</system-reminder>`
   - 提前闭合或伪造当前 `kind` tag
   - 伪造同协议内的结构标签，例如 `<instruction>` / `<task-result>`
4. XML attribute 使用专门的 attribute escape，不能直接插入原始字符串。
5. 不要把 `system-reminder` 包在 Markdown code fence 里；前端隐藏逻辑只识别真实
   leading envelope。

安全原则：`system-reminder` 只解决 UI 展示，不是权限边界。内部 payload 对模型
完全可见，因此其中来自外部的数据仍必须标注为 untrusted context，不能当作系统
指令直接信任。

## 前端接入 Checklist

新增 `kind` 或改变展示语义时，同步检查：

1. `src/shared/systemReminder.ts` 是否需要新增 tag 常量或 builder。
2. `src/renderer/components/Message.tsx::systemTagLabel()` 是否需要新增 badge 文案。
3. `src/renderer/i18n` 文案资源是否需要新增 `message.systemTags.*`。
4. `Message.tsx` 的 raw fallback tag stripping 是否需要新增 tag。
5. `src/shared/sessionTitle.ts` 是否应把纯系统注入从标题候选里过滤掉。
6. `src/server/utils/session-message-preview.ts` 是否应过滤/裁剪隐藏 payload。
7. `src/renderer/components/chat/QueryNavigator.tsx` 是否应从 mixed reminder 中提取
   真实用户 query。
8. 浮球/小窗等二级 UI 是否需要用 `stripLeadingSystemReminder()`。

## 测试 Checklist

新增或修改 builder 时至少覆盖：

- builder 输出的完整协议结构。
- `parseLeadingSystemReminder()` 能解析出正确 `kind` 和 `visibleText`。
- `Message` 渲染不会显示 hidden payload，会显示 badge 和 visible tail。
- Session 搜索不会索引 hidden payload；有 visible tail 时只索引 tail。
- prompt/tool/cloud/user 可控字段不能通过 `</system-reminder>` 或同级 tag 注入破坏
  envelope。
- 如果影响标题/预览/搜索跳转，补对应 helper 的单测。

当前 Task 结果转述及原 session-event envelope 的回归见：

- `src/server/session-engine/task-notification.unit.test.ts`
- `src/server/inbox/session-event.unit.test.ts`

旧 heartbeat cron payload 与其显示兼容的回归样例见：

- `src/server/utils/cron-event-relay.unit.test.ts`
- `src/renderer/components/Message.proseContext.test.tsx`

## Channel context

固定规范由 `src/shared/channelPrompt.ts` 与 `channelContext.ts` 的 schema/renderer 维护，完整 wire 快照位于 `channelContext.test.ts`。`CHANNEL_CONTEXT version="1"` 顺序为 facts、可选 context-data、可选 configured-instructions、固定 instruction。变量通过 compact JSON 与 XML escaping 进入数据层；32 KiB escaped UTF-8 预算按确定顺序裁剪可选字段，核心身份超限明确拒绝，不截断成另一个身份。

单 envelope 顺序为既有 primary（Goal/Task/Heartbeat/Inbox 等）→ CHANNEL_CONTEXT → AGENT_MENTIONS；原 visible tail 与附件不因渠道预算被裁剪。`decorateChannelQuery` 只在产品调用方声明已有可信 envelope 时合成，原始用户 XML 不被提升为系统上下文。无 primary 时 kind=CHANNEL_CONTEXT；存在 primary 时不改变原 badge/触发归因。

模型 facts 描述连接 scope、Bot 身份、当前发言者、容器与消息；connection 可附本轮 source/time。内部非 IM 输入 sender/message 为 null，投影后省略；内部无绑定时 mode/defaultTarget 为 null，不虚构收件人。所有 Runtime 固定提示 MyAgents CLI 命令，不注册独立发送工具。delivery 仅作为内部状态驱动短 instruction：未绑定不渲染；assistant owner 为 none 时投影 suppressed（即使配置 tool_only 也无需发送）；其余 tool_only 轮次使用显式发送指令；auto+caller_managed 由任务发起方处理投递；auto+forwarded 才说明自动推送。not_forwarded 不等于工具发送模式。必要提问仍按真实 host capability 处理。

渠道提示词只属于 Rust 确认当前实际绑定的 Session：固定 system 段与逐轮 `CHANNEL_CONTEXT` 都按精确绑定准入，不能用 Agent 的渠道能力列表或入口 scenario 代替绑定。桌面打开已绑定 Session 保留渠道语义；未绑定桌面即使所属 Agent 有渠道也不注入。mode 切换不修改固定 system 前缀，实际执行轮快照与下一轮生效策略不变。

内置 Claude SDK 的桌面直接输入和 IM 私聊单条纯文本可在实际 admission 省略本轮 `CHANNEL_CONTEXT`。仅当入队文本的首个完整词是 `/compact`、`/context`、`/usage`、`/cost` 或 `/stats`，且当前 SDK 命令清单确认它解析为相应原生命令时生效。入队后的命令及参数原样提交给 SDK。同名工作区命令、已有产品 envelope、群聊、合并入站、引用回复和附件仍按常规规则投影。渠道快照、绑定校验和投递策略仍在同一执行边界确定。

内部 schema 保留完整状态与 null 进行校验；模型 facts 仅投影 connection/self/conversation/sender/message，递归省略未知字段、空对象及空数组。facts/context-data 的 JSON 位于 XML 元素文本内，只转义 `&`、`<`、`>`，不膨胀普通 JSON 引号；预算仍按实际 escaped UTF-8 计算。connection 存在时只补 source 和 time（本轮开始时刻与时区）两个执行信息；execution/delivery/projection 整组不进入模型。发送状态由一句自然语言 instruction 表达，参数与连接能力按需从 CLI 查询。

Channel 时间只在模型投影时转换为本轮电脑时区的 ISO 时间（含实际 UTC offset，遵循该时刻夏令时）；内部 instant 与历史 transcript 不回写。connection.time 附时区名，message、reply/history/parts 的已知时间采用同一时区。context-data.reply 明确表示用户引用的旧消息，与当前 facts.sender 分离；trust=untrusted 表示数据没有指令权限，不是恶意或串话判定。

## Channel Session 交接

Channel owner 生成 `send.request.channelHandoff`（source? / target 环境、context、可选目标拥有的附件引用），双方 Product Session ID 在事件属性中。`sourceNotification=none`、`replyBack=false` 保持私聊结果不自动回到来源群；普通 Session send 不能声明此扩展。

模型投影只有一个 `instruction`，首句“这是一条来自其他 Channel 会话所关联 Session 的消息。”（无渠道来源则为“其他 Session”），随后要求结合 context 转达 payload，说明尚未外发，并由目标实际 turn snapshot 附加 auto/tool_only 指令。其后是 facts-only `CHANNEL_CONTEXT`、`channel-handoff` 中的 source/payload/context。没有 event-summary；eventId、createdAt、sourceNotification 等控制字段留在内部。结构标签在名称、正文、背景中被转义；source_label 与 payload 继续兼容原 UI badge/气泡，身份与背景保持隐藏。图片仍是独立多模态输入，文件沿原工作区 @引用处理；不将附件字节塞入 reminder。

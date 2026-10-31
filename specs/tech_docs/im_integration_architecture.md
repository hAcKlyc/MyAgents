# MyAgents IM 集成架构

> 本文定义 Agent Channel/IM 的 transport、Session 路由、Reply、交互与生命周期边界。OpenClaw loader、SDK shim 和 Bridge HTTP 协议的细节见 [`plugin_bridge_architecture.md`](plugin_bridge_architecture.md)；系统提示词与隐藏消息见 [`system_prompt_architecture.md`](system_prompt_architecture.md) 和 [`system_reminder_protocol.md`](system_reminder_protocol.md)。

## 1. 核心边界

IM 采用“Rust 持有连接，Node Runtime 持有 AI turn”的分层：

| 层 | Owner | 职责 |
|---|---|---|
| Channel transport | Rust `im/` | 平台连接、入站、出站、重连、白名单、群激活 |
| Plugin transport | 独立 Node Plugin Bridge | 加载 OpenClaw Channel Plugin，执行插件 reply renderer |
| Session routing | Rust `SessionRouter` + `SidecarManager` | peer→Product Session、Sidecar ensure/release、buffer |
| AI turn | Node Sidecar `SessionEngine` | Runtime admission、prompt、工具、transcript 与 terminal |
| UI | Renderer | 配置 intent、status 与交互投影；不拥有连接或 Session |

Transport 与 AI 生命周期彼此独立。Sidecar crash 时 Rust可以保留连接并缓冲新消息；Channel stop时必须释放其 Sidecar owner 和 Plugin Bridge资源，不能仅靠 config refresh。

当前产品模型是 Agent 拥有多个独立 Channel。legacy standalone IM Bot命令和存储只保留兼容读取/转发；新代码进入 Agent Channel lifecycle，不扩展旧模型。

## 2. Agent、Project 与 Channel desired state

`Project.agentId` 选择 AgentConfig，`Project.path` 提供 Project-backed工作目录。Agent不再以`workspacePath`作为主选择器；legacy path只在兼容修复或真 orphan中使用。

Channel 是否应运行由以下事实共同裁决：

```text
channel.enabled
&& setup / credentials ready
&& Project 未 archived
```

`agent.enabled`只门控Heartbeat、Memory Update和Memory Evo等主动能力，不控制Channel。关闭主动Agent不能隐式停止Channel；archive则在durable intent提交后显式收敛全部Channel与managed work。unarchive不改写`channel.enabled`，由标准auto-start/monitor重新恢复符合条件的Channel。

启动、停止、热配置、监控重启、proxy replacement和删除共用按`{agentId, channelId}`定位的lifecycle lock。取得锁后必须重读磁盘权威配置，避免旧snapshot启动或并发创建两个实例。

兼容迁移由Rust config owner在admission前、config lock内幂等执行。marker只表示迁移已提交，不得在后续读取时反复覆盖用户对Agent主动能力或Channel开关的修改。

### 2.1 Project 归属冲突与旧 Bot 迁移

同一 Agent 被多个 Project 显式声明时，隐藏、归档 Project 也计入冲突。运行投影拒绝该 Agent，但不影响其它健康 Agent。发现入口必须同时返回诊断，不能把“不可安全运行”伪装成“没有配置”；CLI list 保留健康条目并显示诊断，设置 → 聊天机器人与工作区通用设置展示冲突路径。

旧 `imBotConfigs` 转换由 Renderer 启动维护在既有 intent → projects → config 锁内执行，归属选择只使用共享 `reconcileAgentWorkspaceIdentities`。不能按历史 `Agent.workspacePath` 直接认领已被其它 Project 占用的 Agent。不能明确映射、不能表达相同运行配置、或渠道 ID/凭据归属不明确的旧 Bot 原样保留；不得再按凭据指纹全局清理这些残留。

GUI 只修复“多个其它方面有效的 Project 声明同一 Agent”这一种冲突：用户明确选保留方，提交看到的 claim id/path 快照；服务端持 intent/projects 锁重读校验，先通过 Rust 现有 stop-channels 收敛关联运行，再写 Project 归属。stop 的锁集合来自原始持久渠道 ID 与 live 实例的并集，不能依赖已经因冲突被过滤的运行投影，否则会漏掉尚未发布的启动。

保留方的 Agent ID、配置和渠道不变；其余 Project 只撤销冲突声明，再走标准出生/协调路径（可复用独立 legacy Agent，不复制原渠道）。目录、Session 和隐藏/归档元数据不动；新配置遵循模板默认值，包括 Mino 主动能力，因此确认框提前说明。Project-first 写入中断沿标准协调恢复，不增加事务日志或恢复 flag；未完成不能报告成功。已有 Session 不热改身份，允许用户重启应用。重复 ID、重复路径等其它损坏只诊断，不做通用合并或重绑定。

## 3. Channel lifecycle

用户启用/停用渠道走 `cmd_set_agent_channel_enabled`：在既有 Channel lifecycle lock 内，经配置锁更新磁盘最新 `enabled`，再执行对应连接启动/停止。配置意图已保存但连接处理失败时返回错误，UI 刷新配置并显示失败，不能静默声称停用完成。停止入口根据「已启用或仍在线/连接中」提供，不能因连接失败而让用户无法取消自动重连；连接状态单独展示，不替代 enabled 意图。内部临时重连与删除仍用 runtime lifecycle 入口，不改写用户的 enabled 意图。

显式启用必须校验本次 `enabled=true` 的候选配置；不能拿旧 `enabled=false` 的运行投影作为启用前提，否则凭据完整的已停止渠道也会被误拒。候选在同一配置锁内校验，失败不写盘；自动恢复仍按当前已提交的 desired state 筛选。

群授权的批准、拒绝和移除同样属于持久配置修改，渠道停止时也可执行。先提交当前配置中的 ID 级意图，再对仍在线的实例更新展示、清理群历史或发送批准通知；缺少在线实例不能否决配置修改。

### 3.1 启动

标准启动顺序：

1. 取得Channel lifecycle lock并重读Agent/Project/Channel配置；
2. 校验workspace、credentials、platform capability与archive gate；
3. 创建health、buffer、SessionRouter和平台adapter；
4. 对OpenClaw Channel启动独立Plugin Bridge并完成liveness/readiness检查；
5. 发布运行实例后启动入站loop、event consumer、monitor与可选Heartbeat runner；
6. 只有当前generation仍是desired instance时才向Renderer投影Online。

启动中被stop/remove/archive抢占时，新实例不能发布；已创建的adapter、Bridge、consumer和Sidecar owner在同一lifecycle收敛。

### 3.2 停止与恢复

停止顺序为：关闭新admission，等待/终止Channel work，持久化可恢复的health/buffer/session binding，停止平台连接与Bridge，释放所有`Agent(sessionKey)` owners，最后从运行表移除exact generation。

应用启动与monitor只恢复desired且可运行的Channel。健康检查区分：

- process/loop liveness：决定是否replacement；
- gateway functional状态：只产生degraded/recovered诊断，不因短暂上游故障反复杀进程；
- AI Sidecar health：由SidecarManager自己的generation/recovery owner处理。

### 3.3 通用代理变化

Rust adapter与Plugin Bridge都属于general request proxy consumer。effective proxy变化时，在Channel model-work gate到达idle边界后复用标准stop/start，以磁盘配置重建transport。连续变化按generation合并到最终intent；不能另建proxy专用进程管理器或复制SessionRouter。

## Team AI 管理投影

Team AI 复用既有 Project、Agent、Channel 和 Session，不另建执行器或数据库。Project service 在 `projects.json` 的写锁内维护 `purpose=team-ai`；创建复用 NewAgentPanel/mino，加入或移出只更新用途。实验室开关只控制侧栏入口，不参与后台执行和配置解析；界面规则见 [App Shell](../design/app_shell.md#team-ai)。

### 聊天身份与历史

已建立会话的管理操作以 `(agentId, channelId, sessionKey)` 定位。`sessionKey` 只在连接内标识群聊或私聊，不能单独用来合并不同 Bot 的聊天。`im/team_ai.rs` 从配置枚举连接，再合并运行中的 Router/Health 或持久化 health，停用的连接也可浏览。

Team AI 的名单包含 Channel 中已绑定的用户、已发现的群和已有会话历史；配置身份不必已有 Session。读 DTO 的 `id` 仅用于 Channel 内界面选择，`sessionKey` 可以为空；没有真实路由时只展示身份、授权与空态，不启动 Session，也不提供依赖路由的配置/会话操作。任务通知选择器只接受非空 `sessionKey`。历史中的 `userId/userUsername` 来自真实私聊入站，保存在既有 health 的 peer history 中，用于将配置用户和聊天路由精确关联；群成员不写成私聊身份。旧数据字段默认空，只按已知 adapter 地址契约归并；原生飞书 open_id 与 p2p chat_id 不相等，缺少对应证据的旧身份不按名称推测，后续消息补齐。不同历史路由保留各自 Session 操作范围，不将 Session ID 混入另一条路由。

面板活动期间监听 Agent/Session 和 IM 配置、绑定、群权限事件，激活与窗口恢复时立即补读，并以 8 秒轮询兜底。每个 Agent 工作区只有一次在途名单读取，连续事件合并为尾随补读，不让慢快照因新通知而持续作废；切换身份或卸载后丢弃旧结果。名单可先于 Session 元数据和执行状态发布，失败保留现有内容并提示。群详情复用 `cmd_approve_group/cmd_reject_group`；Team AI 请求携带 `onlyPending`，在配置锁内核对最新待审核、非开放、非屏蔽状态后写入，防止过期页面撤销别人已处理的授权。拒绝仅移除当前申请与临时群历史，不永久屏蔽，也不删除 Session 历史。前端在 Channel 写入确认后立即投影处理结果；只有写入确认推进本地读取版本，阻止写入前已开始的读取还原旧按钮，普通事件仍只触发合并补读。后续读取失败保留已确认结果并显示刷新错误。

Router 的 `peer_history` 记录已建立关联的 Session ID，与当前绑定一同保存为 health 快照中的 `peerSessionHistory`。这是可重建的历史索引，不存储聊天配置，也不向 Session origin 重复写入绑定。轮换或移除前保留原关联，未提交的候选绑定不进入历史；旧数据没有历史字段时只恢复已知的当前绑定。Session 删除后保留失效引用，不重建会话。

状态读取使用对应进程代次的 dispatch lease，限制单批数量并优先观察当前 Session；浏览不会启动 Session Sidecar 或注册 Tab owner。没有活跃进程与观察失败是两种状态，分别表示未运行和状态未知。最近活动取 Session 元数据 `lastActiveAt`；Router 的 `last_active` 是渠道启动时重置的进程内计时，只用于 Heartbeat 等运行时选择。页面不读取对话正文，关闭页面不释放渠道持有的执行 owner。

### 聊天专属配置

仅 Team AI 使用 `config.json` 中的 `agents[].channels[].peerProfiles[sessionKey]`。它定义此聊天以后新建 Session 的配置，不替代已有 Session 的快照，也不修改 Agent 默认值。配置结构定义在 `src/shared/teamAi.ts::TeamPeerProfile`，Node `src/server/utils/peer-profile.ts` 负责验证、组合与转换；字段包含 Runtime/source、Provider 或 runtime-backed identity、模型、推理强度与工具，不含权限。Rust 保存完整 JSON，随 Channel 删除。普通 Renderer Channel 写入不得修改此字段，由 `channelExecutionConfigChangeError` 检查。

配置统一由 Rust `team_ai::write_peer_profile` 在 config lock 内替换或删除，来源有两种：

- **管理页修改**：`UpdateConfig` 在 peer fence 内，将已存专属配置（没有则用 Agent 模板）交给 Global `/api/im/peer-config/compose` 组合新配置。先保存，再通过目标 Session 的接口应用兼容改动。Runtime 或不兼容模型变更返回 `sessionApply: skipped`，由界面询问是否新建；当前 Session 已使用该配置时返回 `applied`。`UpdateConfig` 本身不创建 Session。
- **当前会话修改**：`sync_peer_profile` 确认工作区为 Team AI，且 Session 仍是该聊天的当前绑定后，通过 `/api/im/peer-profile` 读取完整 Session 配置并保存。Team AI 私聊 `/model` 和 Chat 的 Session 配置更新都走此入口，不合并陈旧增量。

在线同步先取得 peer fence，写入前非阻塞取得 Channel lifecycle lock，再核对连接代次与绑定；锁不可用时报告未保存。持有 lifecycle lock 时不能等待 peer fence，否则会与会话中的配置重载互相等待。离线同步没有 peer fence，在 lifecycle lock 内检查持久绑定并写入，防止渠道同时启动。

`team_ai::birth_for_peer` 是首条 IM 消息、私聊 `/new` 和管理页新建 Session 的共同入口。它将专属配置传给 Global `POST /sessions`；没有专属配置时使用 Agent 最新模板。Node 确认 Runtime 不存在、Provider 删除或停用、模型已被移除等永久失效情况时，改用 Agent 模板创建并返回 `peerProfile: rejected`，Rust 仅在存储值仍匹配时删除失效配置。凭据、订阅校验、托管 Codex 就绪和 CLI 登录等暂时问题不清除配置；缺失的 MCP/插件仅被过滤。

新建或换绑不改专属配置；`clearProfile` 删除专属配置，恢复以后新建 Session 对 Agent 默认值的继承，当前 Session 不变。移出 Team AI 后忽略已保存的专属配置，重新加入可恢复使用。

### 管理操作与回复

新建、设为当前、修改或恢复配置沿用 Channel model-work gate、peer fence 和 `expectedSessionId` 校验，不调用 Agent 默认配置写入接口。新建 Session 经既有 handover 绑定到指定聊天；历史菜单只允许选择本聊天已关联的 Session。Global 的配置读取和组合接口不写 Session；模型、推理强度和工具的实际更新仍由目标 Session 接口执行。

换绑不停止旧任务。已接纳的 IM 请求仍通过原 ReplySlot 回复原目标；客户端普通结果依当前绑定投递。管理页不改 ReplyRouter、BackgroundCompletion 或通知协议。handover 的 `state_persisted`、平台通知结果和已创建但未绑定的 Session 必须分别反馈，不能把后续失败描述为整体回滚。

## 4. 入站消息与 SessionRouter

### 4.1 并发与 backpressure

每条消息先取得per-peer串行锁，再取得App级有界并发许可。router lock只覆盖短暂的binding读写，不能跨Sidecar启动就绪、AI执行或平台reply持有。普通入站、命令与Heartbeat统一走`SessionRouter::ensure_sidecar`的prepare → 锁外create → commit；per-peer fence始终保留。恢复中的Sidecar会通过Management API回查Channel上下文并读取同一个router，持锁等待ready会形成循环等待。

```text
platform / Plugin Bridge inbound
  -> authorize + group activation
  -> per-peer fence
  -> resolve Product Session binding
  -> ensure Session Sidecar + event consumer
  -> register requestId ReplySlot
  -> POST /api/im/enqueue
  -> SessionEngine Runtime admission
  -> /api/im/events
  -> ReplyRouter -> platform
```

Sidecar暂时不可用时，普通入站消息可以进入bounded durable buffer并在恢复后按peer顺序重放。OpenClaw `requestId/deliveryProtocol`不能写入durable buffer：原Bridge dispatcher只存在于当前进程，发送前的准备失败或明确拒绝必须立即terminal；enqueue已发出但ACK不确定时保留原请求并按§5.1核对结果，不能让已丢失owner的协议请求在重启后重放。

IM Channel 的串行边界只到**入站接管**：上一条消息进入 Rust bounded ingress 后，下一条即可继续；不得等待模型 terminal 或平台回复完成。SessionEngine / Runtime 是执行排队、追加输入与交互回答的唯一调度 owner。原生 Channel 直接遵循这一规则；Lark、企微、微信和 QQ 的插件私有队列在目标代码片段匹配时，通过加载期兼容变换接入相同 admission scope。目标缺失时保留上游队列并记录 warning，不能假定已解除串行等待；匹配边界见 [Plugin Bridge 的消息流转章节](plugin_bridge_architecture.md#阶段-4消息流转)。未来需要严格逐项完成的工作流应显式定义工作流依赖，不能由“邮件”等 transport 类型隐式推断。

普通 Desktop 与 IM 手动输入共用 `chatQueueResponseMode` 和 Runtime 实际 steer 能力；该偏好属于 AppConfig，不是 Session 独立快照。Builtin IM 也读取同一偏好；Goal、工具面 replacement 等显式 `turnBoundaryOnly` 约束优先，Inbox 仍固定 realtime。外部 Runtime 的多个 IM 输入只有在 native consumption receipt 后才加入当前 turn 的 request 集合：第一条请求保留唯一可见回复，其余请求在同一终态收到空 `finalPayloads`，各自释放 ReplySlot/lease。没有文本输出的显式空 terminal 是结算回执，原生与 OpenClaw 通道均不制造第二条占位回复；未提供 `finalPayloads` 的 legacy terminal 保留原行为。未确认消费的输入不取得当前 turn 的回复权，取消由未消费输入 owner 裁决，明确未接纳继续复用原 queue identity 等下一轮。

IM 请求的结束通知在所属 operation 上只消费一次；Runtime 停止后先结束未确认消费的 IM 请求，再释放临时上下文。DSH 已持久化的 input journal 仍由原生回执核对，用于恢复消息投影，不延续已停止请求的回复占用。实时输入在串行发送中尚未开始原生投递时，也可按 requestId 撤销。

### 4.2 Session key 与 owner

private和group使用不同、稳定的peer session key。每个binding记录Product Session id、workspace和当前Sidecar信息；Sidecar真正的存活权由`SidecarOwner::Agent(sessionKey)`表达。

IM与Desktop可以共享同一个Product Session，但owner保持独立。Tab关闭只释放Tab，Channel轮换只释放目标Agent owner；两边都不能reset或迁移无关使用方的owner。

peer binding 是持久关联，Agent owner 是当前进程的执行租约：重启恢复或空闲释放后，binding 可以存在而 Agent owner 不存在。桌面「新对话」由 Router 校验当前 binding，SidecarManager 允许当前 Tab 单独、或连同对应 Agent 租约一起迁移；其它 owner 与 recovering 实例仍禁止整进程迁移，但桌面可打开独立新会话，原渠道 binding 保留在 source。忙碌的渠道会话同样保留已有执行与绑定，只有空闲且可迁移的会话才联合移动 Tab 与渠道。离线渠道绑定不会阻止桌面另起对话。所有桌面新对话入口统一经 Rust Session lifecycle，不能根据前端尚未加载或过期的渠道标签选择普通 reset。迁移先在 Node 的 mutation boundary 内校验 source、freeze、reset 并完成新元数据持久化，再发布 Router / Manager target；任何不确定结果须先退休原 writer，才允许 source 恢复，避免超时后的迟到 reset 穿透回滚。当前端口只由 SidecarManager 提供，迁移时按实际 Agent 租约更新 Router 端口：已持有则保留当前端口以继续空闲回收，未持有则为 0，下次 Channel ensure 重新关联执行租约与 consumer。私聊 `/new` 只轮换 binding，不要求旧 Agent 租约仍在；活跃来源从 SidecarManager 获取端口完成 freeze，保留其它使用方和历史。

`/new` 仅支持私聊，在 per-peer fence 内处理：

- 从 SessionStore 读取 source；有完整快照时原样保留，活跃 legacy 由其 Session owner 捕获真实 held 配置；
- 经 `team_ai::birth_for_peer` 调用 Global `POST /sessions` 创建完整 metadata：Team AI 优先采用聊天专属配置，否则使用 Agent 最新模板。Runtime 策略、Provider 约束和快照编译与桌面同源；新 IM Session 使用该 Runtime 的最高无人值守权限档位；
- 在 projection → Router 短锁中校验 prior binding，发布已实体化 target，并持久化 peer projection；失败只回滚本次尚未提交的 binding；
- 旧 consumer 有已接纳 request 时，复用 BackgroundCompletion owner 留到原请求 terminal 后退出，再释放精确 owner；历史与其它 Tab/Task/Goal owner 保留；
- 命令无需启动目标 Runtime；首条普通消息经标准 ensure 唤醒。

desktop handover、heartbeat、模型选择和 surface migration 复用同一 per-peer fence。桌面主动的不兼容切换仍允许将当前渠道 binding 接管到新 Session，确认框明确告知转移；历史来源 tag 本身不授予 binding 修改权限。

#### 未完成请求与空闲回收

每个 ReplySlot 在注册前，按精确 Session/generation 从 SidecarManager 取得独立 `BackgroundCompletion(im-reply:UUID)` lease；取得失败拒绝准入。lease 覆盖排队、推理、工具和等待用户回答，真实 terminal 或 consumer teardown 完成后释放。UUID 使旧请求的迟到释放不能移除新请求的 owner；空 consumer 不保留 execution lease，也不会阻止桌面空闲迁移。`/new` 只将旧 consumer 标为 retire-when-idle，既有请求 lease 继续负责保活。

30 分钟计时只产生回收候选。collector 锁外取得同一 peer fence，复核 binding/活动时间及 ReplySlot；存在未完成请求即跳过。无 pending 时先把其它 surface 的已接纳执行交给现有 headless BackgroundCompletion，再释放 Agent lease，成功后提交端口投影并停止空 consumer。Router 锁不跨 owner release 或平台 I/O。

consumer 的取消、generation 丢失和 task panic 共用退出收口：短锁摘取 slots，逐 request 清除 interaction，向原 dispatcher 交付中断 terminal，并释放独立 lease；仍存活的 producer 收到显式 cancel。真实执行终态在平台 I/O 前保存在原 ReplySlot；退出发生在投递途中时保留该结果，仅重交幂等的 OpenClaw terminal，原生平台投递结果未知时不重复发送。短暂 SSE 断线只重连，不能当作执行终态。Channel stop 在 Bridge 存活时等待 consumer 收尾；网络不可达或 deadline 到期只记 delivery unknown，不声称提示已送达。

### 4.3 Session 配置与默认变更

IM 与桌面共享 owned Session 策略。`configSnapshotAt` 后，模型、Runtime/source/binding、effort、permission、MCP ID、plugins 和 official tools 服从该 Session；恢复、普通消息和 heartbeat 不读最新 Agent 模板覆盖它。SidecarManager 对 IM owner 同样优先持久执行身份，冲突 override 直接拒绝，不再按默认 Runtime drift 自动轮换。

Agent 默认设置变更只刷新新会话模板，并向所有已建立私聊 binding 发送系统提示（Team AI 中拥有 peer 专属配置的私聊不跟随默认，跳过）；不发群聊，不启动目标 Sidecar、不查询模型目录、不进入 AI queue。已与默认一致的当前 Session 不重复提示。消息从当前 metadata 读取旧模型，提供 `/new`、`/model`；在业务锁释放后由一次性后台任务投递，配置刷新不等待平台，元数据 IPC 使用 5 秒期限。单个读取或发送失败继续其他私聊，不回滚默认，不增加通知 outbox。Channel 关闭或不可达时按 best effort 处理。

旧完整快照原样使用。legacy 活跃实例仅由对应 Session owner freeze；离线数据无法证明完整配置时拒绝恢复并引导 `/new`，保留历史，不能拿当前默认制造旧 snapshot。Cloud registered Agent 的 live-follow 生命周期保持独立。

### 4.4 私聊模型命令

`/new`、`/model`、`/status`、`/help`、`/start` 为私聊管理命令；群聊识别后静默 terminal，不交给 AI、不写 binding。`/provider`、`/mode` 已移除，私聊仅返回迁移提示；平台注册菜单同步移除。凭据绑定与插件业务指令保留原准入边界。

`/model` 从 Node 读取桌面同源 Provider 顺序、启用/删除/自定义模型与 readiness，按供应商分组、模型连续编号，混入真实 Managed Codex catalog。本机 Claude Code/Codex CLI Session 仅显示该 CLI 的模型。无 Runtime 或权限选择菜单。

每个 peer 只保存最后成功展示的临时菜单（Session id、execution observation、条目 identity）；数字绑定该菜单而非重新计算的顺序。选择前重查 availability，在 SessionStore writer 锁内 CAS 校验 observation 与当前 engine binding。兼容选择先写 snapshot，再经 SessionEngine apply；忙时下一轮生效。普通 Agent 随后在 fresh config 锁内写 Agent 默认，释放 peer fence 后触发 Rust 模板刷新；Team AI Agent 改走 session-only 入口并在 fence 内同步该私聊的 peer 专属配置，不写 Agent 默认，菜单、`/help` 与回复文案同步说明作用范围。分阶段失败明确返回已提交内容。

不兼容条目标记“（会启用新会话）”，选择后创建完整 Session，并复用既有 handover 接管该私聊，不二次确认、不修改旧 snapshot、不自动重放未确认写入。`chat:session-config-changed` 仅携带 Session id；打开同一 Session 的 Tab 经自己的代理回读 metadata 更新模型展示。

## 5. ReplyRouter 与渠道投递

### 5.1 request-scoped reply

`/api/im/events`按单调sequence提供可重连event stream。`ImEventConsumer`拥有`since=<lastSeq>`重连；`ReplyRouter`拥有`requestId -> ReplySlot`。

Native adapter：

- `partial`创建/编辑draft并执行节流和平台长度限制；
- `block-end`定稿当前text block；
- terminal收尾消息、清理pending interaction和slot。

OpenClaw reply：

- `deliveryProtocol:'openclaw-reply'`只表示本次request已经注册真实dispatcher；
- partial传当前raw text block的full snapshot；
- block-end只是顺序屏障；
- complete/error/cancelled透传producer-owned terminal；
-插件拥有CardKit/streaming/static fallback和最终平台delivery，Rust只做有序transport。

每个已注册request必须且只能有一个terminal。命令、白名单拒绝、群激活拒绝等早退也要以空complete或带原因abort结算，不能让dispatcher悬空。

`ImRequestRegistry` 独立于 20,000 项 delta ring 保留最多 200 条、最长 6 小时的 producer terminal receipt。consumer 重连、gap 和既有 15 秒核对周期通过 `/api/im/requests` 核对原 request，不重跑模型。active 继续等待；过期/容量淘汰为 unknown。只有 enqueue 已返回或回执不确定的请求才允许原 registry 封闭缺失 ID，返回“执行状态无法核对”并阻止迟到 POST 再执行。显式取消先于 enqueue 注册到达时，也由同一 registry 留下取消回执，阻止迟到输入启动；已有真实终态保持不变。运行中、排队中及取消尚未完成的 registry entry 不按沉默时长淘汰。状态查询与取消入口在 `src/server/routes/im-request-lifecycle.ts`，仍由既有 SessionEngine 执行取消，不改变客户端停止和排队行为。

enqueue 的未知 HTTP ACK（连接/响应解析失败或 HTTP 5xx）不触发 buffer 重放：保留 slot/lease、核对同一 requestId；5xx 可能发生在 Runtime 已接纳之后，不能推断为拒绝。明确拒绝仍立即收尾。Bridge start/partial 投递失败不会结束执行关联。terminal handoff 是有界、幂等接纳，投递失败与 producer terminal 分别处理。

OpenClaw terminal 首次到达时，ReplySlot 固定该次 outcome、payload 与发送策略。每轮最多三次的有界交接失败后，slot/lease 继续持有原终态，由既有 15 秒核对周期重新交接；等待下次核对不占 router 锁，不重跑 AI、不重发工具媒体。已有终态直接使用本地快照，不再依赖 producer receipt 的容量、TTL 或当前可达性；后来的 partial、policy 或 unknown/error receipt 不能覆盖它。只有 Bridge 接纳终态，或结构化 `protocol_dispatch_missing` 明确证明原 dispatcher 已消失时，才结束正常交接责任；后者记录 delivery unknown，不能声称平台发送成功。Channel stop / generation 丢失仍按既有有界 teardown 收口。

渠道状态从 live ReplySlot 派生未完成交接提示，恢复后自动消失，不另建持久化投递状态，也不修改 WebSocket 的 online / error 事实。已有连接错误优先展示；渠道详情可在 online 状态同时显示回复投递待恢复。

### 5.2 Session binding delivery

ReplySlot只服务产生它的Channel user request。一个request结束后，Desktop、Session Inbox或后台触发的新turn不能复用旧slot。

跨surface投递通过`TurnChannelDelivery`显式选择owner：

| Turn来源 | user方向 | assistant方向 |
|---|---|---|
| Desktop | Session binding | Session binding |
| IM user request | none | ReplyRouter |
| Session Inbox / 普通后台消息 | none | Session binding |
| Heartbeat / Agent Channel Goal | none | caller-owned |
| Task result Inbox | none | Session binding |
| Memory或明确静默turn | none | none |

builtin/external各自在真实turn owner中capture完整text block，成功terminal后交给`im-mirror.ts`transport。V1保留原有保存完成后的投递顺序；V2在SessionStore内存接纳、排队保存后即可投递，产品写盘失败不改变AI成功结果或阻止投递。失败、停止、被重试撤回、空文本、thinking/tool/subagent和`NO_REPLY`不投递。`SessionOrigin`与`InteractionScenario`只描述归因/prompt，不能推导delivery owner。

### 5.3 渠道发送模式与显式发送

`ChannelConfig.messageDeliveryMode` 为 `auto | tool_only`，旧配置缺省 auto；UI 通过原配置 patch owner 保存，下一轮执行生效。模式不属于 Session runtime identity，更新不重建 Session。Builtin queue item / External turn lifecycle 在实际 admission 读取 Rust capability projection 并冻结；实时输入复用当前执行轮，排队输入在自己的执行边界冻结。不可按模型 prompt 或可变全局最近请求判断模式。固定渠道 prompt 与逐轮 CHANNEL_CONTEXT 仅属于当前精确绑定的 Session；Agent 的渠道能力非空不构成绑定。assistant owner 为 none 的轮次仍静默，auto 的 caller-owned 轮次由发起方投递，都不能被提示词改写成必须显式发送。

发送决策：automatic 只允许 auto；explicit 和必要 control 在两种模式均可用，且仍需通过既有权限/目标校验。普通流式、final、typing/思考占位、失败 fallback、桌面镜像、Heartbeat 和 Goal 待投递都遵循本轮模式。管理命令、权限和必要提问走原控制流程。tool_only 仍结算 request/stream；成功 Heartbeat 以 suppressed 消费 pending snapshot，Goal outbox 固化该轮模式并按无需发送结束；执行失败不被改写为成功。

`myagents im send-message` 统一经过 Node handler → Rust management API；当前会话走既有 Adapter，其他会话走原 Channel Router → Inbox。Rust 用 sidecar generation 验证调用 Session，按精确 live binding（仅不在线时读取已有 health binding）解析默认目标；歧义拒绝。高级 target 不要求已有 Session，只允许该 Agent 的渠道连接；已绑定 Session 不能用 channelId 切换连接。原生飞书 user/chat 映射 open_id/chat_id。跨会话目标缺少 Session 时，经原 Router 建立正常绑定，保留授权与 Session 隔离。无绑定 Session 只通过 Project.agentId 解析所属 Agent，不能根据共享旧工作目录反查并认领其它 Agent 的 Bot。

钉钉显式文字走真正的单次 send_text_message，而非只负责开启流的 send_message_returning_id；现有钉钉适配器无二进制上传能力，mediaTypes 为空，混合请求在任何外发前明确拒绝。

所有附件先经 workspace/tmp canonical 路径、类型和大小校验；当前会话顺序发送，遇失败或不确定结果停止。跨会话先由工作区 owner 导入副本，再交给目标 Session；不在入口直接外发。sent/failed/unknown/partial 保留逐项回执；工具结果不进入普通镜像，显式发送不改变 auto 轮次后续回答的行为。旧 send-media CLI 仅转发该 handler。能力与 Runtime 的生命周期见 [工具指南](sdk_custom_tools_guide.md#统一渠道消息工具)。

## 6. 权限与结构化提问

Node 消息、Heartbeat 与 Memory route 只能用 `engine.kind === 'builtin'` 区分 Claude Agent SDK 特有逻辑；其它 engine 一律走 SessionEngine 的非 builtin 配置路径。特别是 DSH 的 kind 是 `integrated`，不能再用历史判断 `engine.kind === 'external'`，否则会丢失模型、权限、reasoning 配置，甚至误入 builtin enqueue。

### 6.1 Permission request

新 IM Session 固定使用 Runtime 最高自动授权模式，已有 Session 保留权限 snapshot。问答不是权限批准。非自动授权模式下，Runtime permission request经IM event bus交给ReplyRouter。pending按request id保存Sidecar、chat、platform message与过期时间；用户通过原生卡片/按钮或受限文本fallback响应，Rust再POST到Sidecar permission endpoint。

Telegram / 原生飞书提供审批按钮；钉钉 / Bridge 用明确的「允许」「始终允许」「拒绝」文字命令，普通聊天不交给模型猜审批意图。只有 Runtime 返回 HTTP 成功且 `success: true` 后才能删除 pending 和更新 UI。stop、reset、terminal或expiry必须精确使对应request失效。多个pending不能用单槽位覆盖。

### 6.2 Host interaction capability

`hostInteraction.askUserQuestion`描述当前Channel host能否承接Runtime的同步结构化提问：

| 值 | 语义 |
|---|---|
| `none` | 禁用/取消同步AskUserQuestion，避免Runtime无限等待 |
| `native-card` | 原生飞书 / Telegram 优先用按钮卡片，必要时文字回答同一个 pending request |
| `text` | 保证问题、选项的文字投递和原请求回传；adapter 有已接通的原生卡片时可优先呈现卡片 |

不支持同步提问时，能力拒绝只结算该工具，不发布 IM error 或中断整轮；普通文本澄清由模型按本轮发送方式发出，用户下一条消息沿用同一 Session。固定渠道提示说明这一区别，真正 IM terminal 仍由 Runtime turn owner 发布。用户主动取消问题与能力不支持是不同意图。

未声明能力仍默认 `none`，旧调用方保持原语义。Rust 当前 Channel 都承接同步问答：原生飞书与 Telegram 声明 `native-card`，钉钉和 OpenClaw Bridge 声明 `text`。Bridge 对已安装官方 `@larksuite/openclaw-lark` 的原生发送与标准交互 dispatcher 接通后，优先发飞书卡片；其它插件或加载不支持时直接发原问题文字。插件自己的异步 AskUserQuestion 工具不替代 Runtime pending owner。

Channel host 能力不覆盖 Runtime 自身的交互限制。`managed-provider` 来源的 Codex 在 IM/Agent Channel 仍禁用结构化用户输入，即使 host 声明 `native-card` 或 `text`，也通过普通文字澄清并等待下一条消息；该限制由 external-session 的 Runtime-aware policy 裁决。系统 CLI 来源的 Codex 不继承这一来源限制。

同步文字问答会展示原题、所有选项和取消方式，用户回复编号、选项名或自己的文本，由既有 QuestionCallback 回到原待答调用；不是另开 AI 轮次。多选可用逗号分隔，多题按行回答。单题单选卡片提供按钮，其它问题使用文字回答。钉钉本次不创建自定义问答模板，走单次 send_message，不能误用只开启 draft 的 send_message_returning_id。

PendingQuestions 在发送平台请求前登记，避免快速回调丢失；卡片不可用则文字呈现，所有发送都失败则请求 Sidecar 取消该问题。只有 Sidecar 确认成功才删除 pending；按钮与文字共用当前请求者校验、取消和失效链路。Telegram callback_data 只放短 ID 与选项序号，选项正文由 pending 问题解析，不受 64 字节回调限制。

敏感问题在IM中fail closed：不能要求用户把secret作为普通聊天文本或fallback答案发送。问题响应只有Sidecar返回成功后才清理pending；同chat多题/多pending的fallback路由必须确定且记录歧义诊断。

## 7. 群聊

### 7.1 激活

| 模式 | 语义 |
|---|---|
| `Mention` | 只有明确@bot或`/ask`触发；其它消息进入bounded group history |
| `Always` | 每条消息触发；模型可用`NO_REPLY`保持静默 |

群消息默认`isMention=false`，除非native adapter或Plugin明确提供证据。平台若只在@bot时才把事件下发，UI与runtime都必须把`Always`标为不可表达，不能伪装支持。

### 7.2 Prompt context

Rust 拥有 group activation、pending history 和 group metadata；原生 Adapter 的 `inbound_metadata` 与 Bridge 的 `channel-context` 提取各自可证明的来源事实，经 ImMessage/sourceMetadata 和 request registry 传递。Sidecar 在实际 turn admission 生成 `CHANNEL_CONTEXT version="1"`，私聊和群聊每条均注入，不再依赖首轮/周期提醒。sender/message 随该次输入，配置模式冻结在该执行轮；非 IM 唤起没有当前 sender/message。引用、历史、提及、附件和插件装饰进入有来源的数据字段，用户配置指令单独标记；未知时间不以接收时间冒充。模板、escape、预算、单 envelope 和可见正文规则见 [System Reminder](system_reminder_protocol.md#channel-context)。

群名称按“用户配置 → platform/plugin hint → chat id”解析。`groupToolsDeny`只是额外可选禁用层，不替代权限模式、MCP选择或工具自己的安全检查。

## 8. OpenClaw Plugin Bridge

OpenClaw Channel通过独立Node进程适配，不把第三方插件加载进Rust或AI Sidecar。Rust `BridgeAdapter`拥有进程、health、sender registry和HTTP transport；Bridge拥有plugin import、OpenClaw compat runtime与平台reply dispatcher。

### 8.1 身份与生命周期

安装ID/npm包名/协议Channel ID是不同事实。Rust按安装ID定位目录；Bridge按manifest/registerChannel得到协议ID并构造`cfg.channels.<channelId>`。启动时敏感配置通过environment传递，runtime state按MyAgents Channel隔离，不能回落到共享`~/.openclaw`。

安装、loader、shim、health endpoint与process-tree规则只在 [`plugin_bridge_architecture.md`](plugin_bridge_architecture.md) 维护，本文不复制。

### 8.2 MCP tool surface 与 turn context

Plugin tool schema是Session-level surface；sender/chat/account/owner是request-level identity：

- stable surface identity由Bridge port、plugin和enabled tool groups规范化；
-同一generation只发现一次schema并复用settled result；identity变化才创建新generation；
- discovery/readiness共享builtin MCP soft grace；live map mutation仍是独立turn-boundary correctness fence；
- `ImBridgeTurnContext`只在exact request registry中存在，tool callback通过output-owner FIFO解析当前request；
- request context在runtime terminal后立即不可读，不能被相邻realtime消息覆盖；
- tool执行budget从真实`/mcp/call-tool`开始，不和surface discovery budget混算。

request registry的清理权在admission route与runtime之间明确移交：admission前失败由route清理；接纳后由runtime terminal清理；cancel只有在成功移除queued item时接管。任何request都不能有两个terminal emitter。

## 9. Heartbeat、Task 与 Goal

### 9.1 private target

Agent 可以连接多个 Channel。`lastActivePrivateTarget { channelId, sessionKey }` 决定 Heartbeat 和手动唤醒的最近私聊目标，只由私聊用户消息或 handover 更新，群聊活动不能覆盖。Task 的默认通知地址不从该字段推断；只有显式选择 Agent 范围的最近私聊时，才复用这里的选址规则。

解析规则：

1. 有exact private target时只验证该目标；失效则跳过，不fallback；
2. 没有target时，可从仍在线且明确为private的legacy last-active记录一次性seed；
3. 只有完全没有历史时，才在online Channels中选择最近private session；
4. wake必须携带exact target，per-Channel runner不得再次猜测。

Task/Cron 通知已从 Heartbeat 的内存 pending 队列迁出，改由 TaskStore 保存待发记录并经 Inbox / SessionEngine 转述，详见下方「Task 通知」。上述最近私聊路由仍供 Heartbeat 使用；Task 只有显式 Agent 自动策略复用其选址判断，不复用 wake 或 pending 队列。入队成功仍不等于平台已接受消息。

### 9.2 Goal

在IM/Agent Channel当前Session创建的Goal仍属于该Product Session：

- 通过统一Goal facade创建，不创建Task/Cron；
- continuation经SessionEngine恢复原interaction scenario；
- Runtime promotion时claim，terminal后由Goal owner finalize；
- 只有`agent-channel` continuation把成功文本写入Goal delivery outbox；
- outbox按stable delivery id at-least-once投递，缺binding不ACK；
- `NO_REPLY`保持静默。

detached/new-session Goal需要独立parent/return-target设计，不能混入current-session Goal。

## 10. 配置与持久化

`config.json` 保存 Agent 的新会话模板、Team AI 聊天专属配置和 Channel 连接配置。Channel 级不拥有独立执行配置；详情与 writer 移除 model/provider/runtime/permission 覆盖，旧字段只读保留以免损坏存量信息，正常解析不采用。Team AI 的 `peerProfiles` 为每个聊天指定新会话配置，不是整个 Channel 的执行配置覆盖，写入规则见「Team AI 管理投影」。连接凭据、白名单、群规则和 toolsDeny 仍由 Channel 实时拥有。所有写入在config lock内fresh read-modify-write；Renderer提交typed intent并在成功后refresh完整snapshot，不能用可能过期的React state覆盖其它Channel。

群聊与绑定用户的展示名保存于同一 Channel 配置：`groupPermissions[].groupName` 与 `userDisplayNames[userId]`。名称只用于展示，授权、群发现去重与路由继续使用 ID；不再把群名当作历史 ID 迁移依据。设置页显示 `名称（ID）`；私聊用户名称未知或等于 ID 时只显示 ID，群聊的未知/同 ID 名称留空并显示 `（ID）`。Rust 在配置锁内按最新已有 ID 合并名字，不创建授权记录，不修改群状态，查询失败/空值不清除旧名字。绑定成功和后续入站更新此元数据，沿 `im:bot-config-changed` 刷新 UI。

渠道启动时用既有 peer snapshot 补缺失名称；企微另经 Bridge `/peer-names` 查询当前账号的 `wecom-cli message aibot sessions list`，新平台证据更新名称。该接口仅返回最近 20 个会话，无分页，因此旧且不可见的会话保留已有名称或 ID；后续入站可补齐。Bridge 对 `single/group + chat_id` 做唯一精确匹配，不从 `extra_identity_context` 的授权人描述猜测昵称；账号级在途查询去重和超时只约束查询，不启动 Session、不发消息、不定时扫描。

运行时文件只保存可重建projection，例如health、bounded buffer、dedup与peer binding；它们不能覆盖config或SessionStore。health的uptime snapshot不是实时计时authority，live status由当前instance generation/started-at计算。

Channel credential、token、App Secret和provider env不得进入日志、analytics、Tauri event或错误正文。配置持久化方式的现实限制应由credential owner和安全设计统一解决，本文不维护“以后迁移”计划。

### 10.1 权限模式与黑名单的入口边界

`im/access.rs` 在同一 `mutate_bot_config` / config lock 内 fresh-read、裁决新消息并合并必要登记。支持权限模式的渠道只存在白名单/自由两种有效策略，`accessMode` 缺失等价 `review`，新建及旧数据一致；打开设置不补写配置。此默认统一覆盖先前按平台保留旧行为的设计：钉钉与空名单 Bridge 也要求新私聊用户绑定。Telegram 继续兼容可信 username（忽略大小写），缺省与显式白名单的 sender qualification 相同；昵称不授权。微信扫码例外见下文。

界面将 `review` 称为“白名单模式”、`open` 称为“自由模式”，持久化值不变。显式 `review` 统一为新私聊需绑定、群批准或已绑定成员例外；显式 `open` 在首条真实使用中将稳定 sender ID 写入原 `allowedUsers`，群有效触发还将原群记录批准。普通群发言、仅发现群、纯 help/start 不登记，平台 Mention/Always 能力仍生效。有效绑定保留；自动登记与绑定享有相同 `senderIsOwner`，没有新增权限等级。切换模式只写模式字段，不重置资格、封禁或 Session。

`blockedUserIds` 对本 Channel 的私聊及全部群生效，`blockedGroupIds` 对该群全部成员生效；任一命中先于绑定/群批准/自动登记拒绝，Bridge 通过原 dispatcher terminal 静默结算，不进入群历史、命令或 AI。黑名单与资格正交，解除一项不会解除另一项。设置提交 ID intent，绑定、发现和群审批也按最新集合合并；发现事件不能把已批准群降回 pending。缺失字段兼容旧数据，未知模式/损坏集合报错，不开放兜底。

准入发生在新消息分流、媒体聚合和 Session 准备之前；结果作为 `ImMessage.access_admission` 固化本次 sender qualification、群批准和触发事实，并随 `BufferedMessage` 保留。媒体合并重入沿原受理事实；原缓冲重放/Node 队列/Runtime 启动与执行不再查询黑名单。保存封禁只影响锁顺序在后的新 query，不撤回之前已受理的请求、历史或回复。旧请求的权限/提问沿既有 callback 继续，文本 fallback 固化精确 pending request ID / 类型，并在消费时复核同一请求、requester 和有效期；已消失或过期则静默结算，不能改选其它请求或运行新绑定/命令。Telegram 长消息聚合也要求发送者 ID 相同，不能将被封禁者的分片并入他人的请求。其他人引用的正文照常处理，不做跨发送者内容过滤。

微信 `openclaw:weixin` / `openclaw:openclaw-weixin` 在共享平台能力表声明 `accessControl: false`：只展示扫码连接，不展示多人权限、私聊名单或群管理；Rust 准入不应用旧通用模式/名单/封禁，也不自动登记或清除这些历史配置，保留既有 sender owner 计算。该路径依赖平台扫码认证，不新增 MyAgents 对不同发送者的身份绑定保证；generic QR 支持本身不意味着其它插件也豁免准入。企微和飞书继续支持两种模式。

模式及个人/群封禁可离线保存；保存成功后新入站读取磁盘，不依赖迟到的 Runtime 配置投影。已存在的 Task/Goal/Heartbeat 仍按其自身生命周期执行及发送，默认主动通知对象继续沿当前规则选择。

## 11. 安全不变量

- 私聊管理命令与普通聊天复用 Rust Channel 的 `access::admit_input` 准入；原生 adapter 只提供可信平台身份，不再用启动名单提前过滤。Telegram 的旧用户名匹配只读 `sender_username`，昵称不能授权。群管理命令仍不开放；平台凭据、扫码登录、群触发能力不随使用模式改变。
- group默认Mention，未证明mention的事件不能触发AI。
- 新 IM Session 由 snapshot compiler 固定最高 unattended 权限（DSH 为 `full-autonomous`）；`/mode` 与渠道权限覆盖已移除。已有 snapshot 权限保持原值，桌面主动修改仍按 Session 规则生效，不能在恢复或每轮隐式提权。
- credentials、prompt正文、tool参数、群history和platform payload不写常规日志。
- platform/network request使用统一proxy、timeout、rate-limit与retry policy；401/invalid credential停止或降级，不无限重试。
- QR credential provisioning只由Rust访问HTTPS allowlist并归一化response；Renderer只持短期session handle和展示数据。Provider返回的handle是opaque值，生成与新旧轮询入口共用长度/控制字符校验，禁止按字母数字白名单拒绝或过滤；WeCom query与Feishu form分别按参数编码，不能改变原值。WeCom轮询不跟随重定向，会话码不进入日志或URL错误正文。
- QR失败提示依据实际操作与终态：生成失败、状态查询失败、拒绝/取消和过期分别展示；刷新次数不能作为错误原因。新建与详情重新扫码共用runner及提示映射，失败不得覆盖既有凭据。
- Plugin Bridge是受管`ChildTree`；停止/卸载不能按进程名扫描或递归删除未验证目录。
- Session、workspace和attachment路径经过既有canonical validation；Channel不能扩大Runtime文件权限。

## 12. 关键实现

| 路径 | 职责 |
|---|---|
| `src-tauri/src/im/agent_channel.rs` | Channel lifecycle与入站编排 |
| `src-tauri/src/im/model_commands.rs` | 私聊模型菜单、选择、Session 创建与默认变更通知 |
| `src/server/routes/im-model-selection.ts` | 同源目录、兼容计划、Session CAS、Engine apply 与默认提交 |
| `src-tauri/src/im/router.rs` | peer→Session binding与Sidecar owner |
| `src-tauri/src/im/enqueue.rs` | Rust→Node admission |
| `src-tauri/src/im/event_consumer.rs` | `/api/im/events` reconnect与dispatch |
| `src-tauri/src/im/reply_router.rs` | request-scoped reply与interaction |
| `src-tauri/src/im/{telegram,feishu,dingtalk}.rs` | native adapters |
| `src-tauri/src/im/bridge.rs` | Plugin Bridge process/transport owner |
| `src-tauri/src/im/{buffer,group_history,handover}.rs` | buffer、group context与surface handover |
| `src-tauri/src/im/{health,heartbeat,runtime_change}.rs` | health、private wake与Runtime drift |
| `src-tauri/src/memory_auto_update.rs` | Memory Update managed task/config owner |
| `src/server/session-engine/` | Runtime-neutral IM admission与turn result |
| `src/server/tools/im-bridge-tools.ts` | Bridge MCP surface与request context |
| `src/server/utils/im-mirror.ts` | Session binding delivery transport |
| `src/renderer/components/AgentSettings/channels/` | Channel配置intent与status UI |

Product Session owner、删除、恢复与配置snapshot详见 [`session_architecture.md`](session_architecture.md)。

### 渠道名称与实际群接收能力

`src/shared/imPlatformCapabilities.json` 是已接入 adapter/plugin 群消息能力的单一事实表，供设置页、Bridge mention 默认值与 Rust 启动/热更新共用。微信插件仅私聊；企微、QQ 当前插件与钉钉 Stream 仅收到 @ 群事件；Telegram/飞书支持全部消息但必须满足平台隐私/权限设置。未知插件维持现有设置并提示能力依赖平台。旧 `always` 配置不改写，受限渠道的 effective activation 始终为 mention；显式入站 `false` 不会被默认值覆盖。

原生 Telegram 的昵称与 username 分开：昵称用于展示，username/数值 ID 才能参与既有用户白名单判断。Telegram chat.title、钉钉 conversationTitle、飞书 chat API 的实际名称进入 hint_group_name；空名称/接口失败不生成占位群名、不覆盖已知显示名。飞书昵称候选跳过空白后再取下一项。

启动名称补查统一经过 adapter.peer_names，仅查询已配置用户/群：Telegram getChat、原生飞书已有 user/chat API，Bridge 企微会话列表或插件标准 directory.listPeersLive/listGroupsLive。Bridge 目录搜索返回必须按 kind+ID 唯一精确匹配，插件继续持有凭证、账号与分页实现；按账号/目标合并在途查询、限制等待及并发，超时不阻塞入站。原生启动补查总预算 4 秒，慢查询/权限不足保留已知信息，后续入站继续刷新；微信和 QQ 上游缺少的昵称不推测。此路径不创建 Session、不发送聊天消息、不改变授权。

## 跨聊天会话发送的上下文交接

Rust `im/channel_handoff.rs` 复用 Channel Router、peer fence、model-work gate 和 Inbox。Management API 先验证调用 Sidecar generation/Agent scope、参数及全部附件，再比较平台规范化后的会话。当前会话直发，其他会话携带正文和 context 交给目标 Session；后续用户回复继续走原入站 Router。

平台 ID 不能按名字或字符串猜测：原生飞书 open_id 经只读平台接口转换为入站 p2p chat_id；无法读到映射明确失败，不先发探路消息。Telegram 读取 getChat；原生 adapter 尚不接收 channel_post，公开 channel 明确拒绝交接，避免伪造成 group。Bridge 飞书发送地址为 user:open_id / chat:chat_id，入站 Router key 使用已去除前缀的 open_id / chat_id；directory 查询使用原始平台 ID（不带 user:/chat: 传输前缀），新 chat 需精确 directory group 证据，无法判断 p2p 别名时提示改用 open_id。钉钉、企微、微信、QQ 沿既有 type/idType 与 transport_target 规范。名称只作展示，不参与路由或授权。

Router 持久绑定拥有 Session 身份，SidecarManager 拥有进程 generation，目标 turn owner 拥有有效发送模式。直接发送不创建 Inbox；交接 `accepted` 不是平台发送成功。没有新增 raw bypass、发送工具、授权字段、Session 划分或重试机制。


Channel 路由使用 Adapter 已验证的协议身份；OpenClaw 从注册后的 `/status` / `/capabilities` 取得 `pluginId`，安装目录 ID 不参与新 peer key。跨会话解析保留 Router 的实际 sessionKey，投递在与入站、`/new` 相同的 peer fence 内重读当前 Session，不缓存解析时的 Session ID。

启动恢复在取得协议身份后、创建 peer owner / consumer 前，统一归正历史安装 ID key 与飞书发送前缀。已有真实入站 key 优先；仅有旧 alias 时保留原 Session ID 并改正 key。多个 alias 无真实入站 key 可裁决时明确失败，不按遍历顺序猜测。归正通过 Health projection 持久化后才开放准入；仅解除重复绑定，不删除或合并 Session metadata/transcript，不重放消息，不影响 Tab/Task/Goal owner。


在线 Channel 的 capability/context projection 与 handoff world 同取 Adapter 的已注册协议身份；配置安装 ID 只负责安装与生命周期，离线 capability 保留现有配置投影。精确 live binding 查询同时返回同一快照中的 Adapter，避免另一次扫描拼接身份。Inbox 准入只核对 Product Session、连接 UUID、peer ID/ID 类型与私聊/群聊归属；platform 是环境描述，不是第二套绑定身份，旧消息中的平台别名不构成错投。无需模型填写 Session ID、平台或已有绑定的连接 ID。


### Task 通知的稳定地址与发送 owner

Task 自动回报使用 `ConversationRef { channelId, sessionKey }`。`im::task_notification` 从既有配置、health、ChannelOwner 和 Router 解析目标，不新增聊天存储。固定 Channel 的 `recent-private` 只在该连接内选择私聊；Agent 范围允许跨连接，沿用最近私聊的选址规则。两者均不经过 Heartbeat 待发队列或唤醒流程。首次解析后由 TaskStore 固定聊天地址与连接归属；目标离线时等待，归属变化时失败，不改投其他联系人。

交接前在 ChannelOwner 的 peer fence 内初始化当前 Session，复用 Inbox delivery lease。排队后的 `beforeDispatch` 再检查绑定，换绑使旧队列项失效，由 Task 通知作业重新解析同一个聊天。TaskStore 在准确 Session 接纳后记录 handed-off，不调用 IM `channel_send`；目标 Session 使用自己的普通回复/显式工具发送路径。auto/tool_only 只控制外发方式，均允许交接输入。普通 ReplyRouter、显式 handoff、Heartbeat 与 Goal 的生命周期不变。状态与重试规则由 [Task 通知策略与投递记录](task_center.md#task-通知策略与投递记录) 统一说明。

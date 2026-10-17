# Multi-Agent Runtime 架构

> 本文定义 builtin、DSH、Claude Code 与 Codex 如何接入同一 Product Session。Runtime 的安装版本、完整 RPC schema 和字段枚举以锁文件、生成类型与实现为准，不在本文维护副本。

## 1. 总体边界

```text
routes
  -> session-engine/selector.ts
      -> builtin-adapter.ts  -> agent-session.ts       -> Claude Agent SDK
      -> integrated-adapter.ts -> DSH RuntimeProcessHost -> native DSH
      -> external-adapter.ts -> external-session.ts    -> AgentRuntime
                                                         |- Claude Code CLI
                                                         `- Codex app-server
```

`SessionEngine` 是 route 面向当前 Session Runtime 的唯一 facade。Route 只做请求校验和响应映射，不自行判断 builtin/integrated/external，也不直接 import Runtime owner。

Runtime 抽象统一的是产品行为，不是 mutable state：

- Product Session identity、metadata 与 transcript 仍由 Session 层拥有；
- builtin 独立拥有 SDK Query 状态；Integrated DSH 与 external Runtime 复用 external-session 的 queue/config/transcript owners，各 adapter 拥有自己的原生执行状态；
- `src/server/session-core/` 只共享无副作用 policy；
- 不为某个 Runtime 不支持的能力建立伪对称 stub；adapter 返回明确 capability/unsupported 结果。

Session identity、恢复与配置 snapshot 见 [`session_architecture.md`](session_architecture.md)。

## 2. SessionEngine 契约

`src/server/session-engine/` 统一承担以下产品语义：

- desktop、IM、Inbox 与 scheduled turn 的 admission；
- stop by exact domain owner and queue id；
- live state、stream replay、latest result、completion terminal 与 config snapshot 读取；
- Rewind、Fork、Retry、desktop reset 与已证明的 surface migration；
- model、permission、reasoning、MCP、Agent、Plugin 与 interaction scenario 配置入口；
- 按 adapter 能力提供 pre-warm、diagnostics 与 native compact。

`product-session-binding.ts` 是 Product Session prepare/commit/rollback 的事务入口。adapter 只能在完成自身 Runtime 清理和绑定后提交产品 identity；SDK UUID、Codex thread id 等 native identity 不进入这里。

`runInjectedTurn()` 等同步入口必须等待真实 terminal settlement，并使用 adapter 的成功分类。`isBusy() === false` 或进程退出都不等于 turn 成功。

所有跨 Runtime read API 返回 immutable snapshot。REST restore、BackgroundCompletion、通知与 Task/Goal 不再猜 Runtime 类型，也不读取 owner internal。

## 3. 中性合同

### 3.1 `AgentRuntime`

外部 Runtime 实现 `src/server/runtimes/types.ts` 中的 `AgentRuntime`：检测与模型发现、启动/恢复、发送、权限响应、停止，以及可选的 steer/config/native operation。接口只描述 transport 能力，Session lifecycle 由 external-session owner 编排。

### 3.2 `UnifiedEvent`

各协议先归一化为 `UnifiedEvent`，再由 external session 转为产品事件和 transcript：

| 类别 | 产品语义 |
|---|---|
| text / thinking | 流式内容块 |
| tool use / result | 工具生命周期与附件 |
| permission / question | 结构化交互请求 |
| session / turn terminal | 进程、turn 与成功状态 |
| usage | turn token 与 context snapshot |
| runtime tool catalog | 当前 generation 实际加载的工具目录 |
| diagnostics | auth、env、MCP、extension 等运行状态 |
| agent plan | Runtime 原生计划的 transient UI 投影 |

协议 delta 不写原始正文日志；成功 terminal 后只输出有界、脱敏的 assistant summary。新增 Runtime 事件应先进入这个中性合同，不在 Renderer 建协议专属分支。

### 3.3 类型归属

跨 Runtime 或跨进程的类型放在最窄的中性模块：

- `src/shared/types/runtime.ts`：`RuntimeType` 与共享展示类型；
- `src/server/provider-types.ts`：Server provider identity/env 类型；
- `src/shared/types/tool-input.ts`：Renderer/Sidecar 共用的工具输入；
- `src/server/session-core/`：queue、terminal、activity、MCP 与 config pure policy。

中性类型不拥有进程、SessionStore、SSE 或文件系统副作用。

## 4. Runtime identity 与来源

外部 Runtime 除 `RuntimeType` 外还带 `runtimeSource`：

| Source | Authority |
|---|---|
| `system-cli` | 用户安装、登录并配置的本机 CLI |
| `managed-provider` | MyAgents 管理二进制、安装、登录与可投影扩展 |

同为 Codex，两个 source 也不能复用进程或混用配置。Rust 在一次 Sidecar ensure attempt 开始时解析完整 `RuntimeIdentity(runtime + source)`；复用校验与 spawn 使用同一快照，不能在中间重新读取 Agent 配置。

显式 system CLI 选择优先于 provider compatibility projection。Managed provider 的 readiness 由自己的 provider gate、安装清单与认证状态裁决，独立于 system CLI 的检测和安装。

owned desktop/Task/IM Session 持久化完整执行 identity 与配置 snapshot；Agent Channel 的 model/provider/permission/MCP 选择同样服从 Session。默认 reload 不改旧会话，也不触发 drift rotation；显式模型选择经 SessionEngine operation 应用，忙时下一轮生效。Analytics 和真实执行身份检查须携带完整 source，不能把 managed 与 system usage 合并。

Claude SDK 与 DSH 的权限展示名称可以相同，传参词汇仍各自独立。Agent 配置 writer 切换内置运行环境时，在同一次原子写入中清理 `runtimeConfig` 和不属于目标运行环境的顶层 `permissionMode`；未显式选择目标权限时使用目标默认值。已有旧配置由 Renderer 与服务端按当前运行环境读取，跳过外来权限值；菜单显示与发送使用同一个解析结果，不按文案转换 key。

Managed Runtime 的目标下载版本以 `src/shared/managed-codex-runtime.json` 为唯一锁定源；当前进程使用安装器已经原子发布并校验的 installed identity。更新下载期间不得因为目标锁变化而阻断现有健康版本或已有 Session。

### Integrated DSH identity

打包时的 DSH 来源由 [构建资源准备](build_resource_preparation.md#integrated-dsh-构建来源) 选定。Release lock 是正式包的 authority；显式本地 Dev 构建从已验证 handoff 派生一次性 effective lock。两种来源都在打包前冻结相同的 TypeScript/Rust 运行身份，不进入 Agent 设置或 Session 可变配置。

DSH 是受控分发的 Integrated Runtime。`shared/integrated-runtimes/resolver.ts` 结合 distribution policy、Agent `runtimePreference`、Provider constraint 与 readiness，解析 `EffectiveRuntimeBinding`。产品发行版始终开放 Runtime 选择；Agent 未明确选择时，新 ordinary-provider Session 使用 allowlisted `config.defaultIntegratedRuntime` 或构建默认，明确选择则优先。通用设置中的“Agent 功能设置”配置此默认值，仅影响新 Session，不将显示的默认值自动写回 Agent。已有 Session 优先读取 frozen `runtimeBinding`，未知组合只允许历史读取，不能静默回退 builtin。

`SessionEngine` selector 将 DSH 交给 integrated adapter，其实现复用 external-session 的队列、交互、transcript 和配置 owner；调用方判断 SDK 专属路径时使用 `engine.kind === 'builtin'`，不能把所有非 external engine 当作 SDK。

## 5. 各 Runtime 协议

### 5.1 builtin Claude Agent SDK

builtin 直接调用 SDK，并通过常驻 `messageGenerator()` 复用一个 Query。`agent-session.ts` 是 public facade；真实 lifecycle、queue、turn、config 与 transcript owners 位于 `src/server/builtin-session/`。

SDK `system_init`、terminal、MCP status 与 background task 都必须绑定 exact Query authority。旧 Query 或旧 generation 的迟到事件不能更新当前 Session。MCP startup observation 是 soft gate；MCP map mutation/replacement 是 turn-boundary correctness fence。详细规则见 [`session_architecture.md`](session_architecture.md)。

### 5.2 Claude Code

Claude Code 使用 `-p` 模式与 NDJSON stdio。每个 turn 启动一个进程，后续 turn 通过 native session id resume：

```text
stdin user message
-> stream_event / control_request / system
-> result
-> process exit
```

MyAgents 把 native stream 归一化为 UnifiedEvent，并通过 SessionStart hook 获取可靠的 session id。权限模式使用 CLI 当前支持的 native vocabulary；产品权限只在 Runtime boundary 做可证明的映射。

系统 Claude Code CLI 的权限菜单与快捷键轮换只提供 Accept Edits、Bypass Permissions、Don't Ask。Manual、Auto、Plan 仍属于支持的运行参数，已有会话保留原权限并显示实际模式；隐藏菜单项不修改持久化权限。

SessionStart 的应用自有 forwarder 通过 Sidecar `process.execPath` 启动，不从外部 CLI 的 PATH 寻找 Node。生成的 command 使用 Bash 安全参数引用并声明 `shell: bash`（Windows 使用产品已有 Git Bash）；保留 2.1.119/2.1.138 的旧 command-hook 支持，不依赖 2.1.139 新增的 `args`。外部 Runtime 与 AI Shell 的环境策略保持独立。

IM/Agent Channel 需要 native-card `AskUserQuestion` 时，启动策略必须保留 stdio permission channel。full-agency 对普通工具可以 fast-path，但不能用 bypass mode 吞掉结构化提问。

### 5.3 Codex

Codex 使用 JSON-RPC 2.0 app-server，一个进程在 Product Session 生命周期内持久存在。adapter 拥有 initialize、thread start/resume/read/fork、turn start/steer/interrupt、权限请求与订阅关联。

原生 `webSearch.results`（standalone 搜索的 opaque JSON）必须保留在既有 `WebSearch` tool-result 的 `{results, answer}` 中；`answer` 保留 query/action 摘要，不能用查询顺序或 `openPage.url` 猜测 `ref_id` 的来源。无 results 的 hosted/旧协议保留原摘要。assistant 的 delta / nativeText 与产品 transcript 保留原文；引用的可读投影属于展示层，不改写 native history 或流式 offset。

Managed Codex 的推理档位以实际 app-server `model/list` 返回的 `supportedReasoningEfforts` / `defaultReasoningEffort` 为权威，完整读取分页并透传到 RuntimeModelInfo 与 Provider 模型目录。聊天使用 Tab API 读取本 Session 已有进程的能力，不能借用 Global Sidecar 对新安装版本的目录。启动器与 Agent 配置使用安装版本的目录；刷新失败不改写用户选择。

推理强度存储保留原始字符串及 `default` sentinel，Codex transport 不使用固定枚举过滤未来档位。Managed adapter 在当前进程内解析每轮有效 effort：显式支持值原样传递，默认/已知不支持值解析为模型声明的默认并显式发送，避免 `turn/start` 省略字段而保留上轮覆盖。未知目录不删除显式选择；无法获知默认时报告错误而不伪装已恢复默认。用户主动切换模型时，UI 与模型选择一起持久化仍受支持的 effort 或 default；能力加载本身不写回 Agent/Session。系统 CLI 的菜单暂保留既有选项。

权限 UI 与 native 参数按 runtime source 分流，保留历史持久化 ID：

| Source / UI | 内部值 | approvalPolicy | sandbox | approvalsReviewer |
|---|---|---|---|---|
| managed 规划 | suggest | untrusted | read-only | user |
| managed 请求批准 | auto-edit | on-request | workspace-write | auto_review |
| managed 完全自主 | no-restrictions | never | danger-full-access | user |
| system 请求批准 | auto-edit | on-request | workspace-write | user |
| system 帮我批准 | full-auto | on-request | workspace-write | auto_review |
| system 完全访问权限 | no-restrictions | never | danger-full-access | user |

system 菜单只提供上述三项；历史 suggest 仍按只读恢复，并保留真实只读显示。auto_review 是原生审批 reviewer，不等于 never 或直接开放网络。start/resume 与每轮 turn/start 均显式传 reviewer，避免切回人工审批时沿用旧 reviewer；原生响应未启用请求的 auto_review 时明确报不支持，不能静默降级。

现有 Process 保存该 generation 的 workspace sandbox：从原生 config/read 读取 network/额外 writable roots/tmp exclusions，再以 thread/start/resume 返回的 workspaceWrite 有效策略校准；从 Full Access 切回时仍使用该配置。只读规划保持旧网络限制。不得用 thread/resume 配置尚无 rollout 的预热 thread，也不得逐轮硬编码 networkAccess=false 覆盖原生配置。未获批 command/exec 代理探针受网络限制只表示需要审批，不能据此显示整个 Codex 不可用。MyAgents Host Tool 自有审批仍属于客户端 dispatcher，不因原生 auto_review 绕过。

一个 Session Sidecar 最终只绑定一个 root thread。RPC response 和 notification 可乱序到达，turn owner 必须按 thread、turn 与 caller message identity 关联，不能仅凭“收到 completed”提交错误 turn。

`agentMessage.phase` 的 `commentary`、`partial_answer` 和 `final_answer` 只描述文本阶段；即使完成一段回答，后面仍可能有工具或其它文本。文本块在 `item/completed` 关闭，主轮次只由对应 `turn/completed` 与既有子 Agent 结算 gate 结束。原始 `additional_tools` item 是工具目录，不是工具调用，不进入产品工具 trace 或改变子 Agent 关联。

Codex Rewind/Fork/Retry 由 external owner 在 mutation lease 内编排，依赖现有 native binding 与 Runtime branching 能力：

- root `turn/start` 关联 Product user message id；成功 terminal 后持久化 native turn anchor；
- Rewind 有目标 turn anchor 时请求 `before-turn`；目标失败而没有 anchor 时，空保留前缀使用 fresh thread，非空前缀必须以紧邻目标的 assistant anchor 请求 `through-turn`。没有精确边界就返回失败，不能因 turn 失败而假设它没有 native 输出或工具副作用；
- Rewind 保留 Product Session id，提交产品截断和 replacement native binding；Fork 用 `through-turn` 建立新 Product Session；
- 创建非空 native branch 后，Runtime adapter 必须确认 source app-server 退出才交出 replacement identity；`thread/unsubscribe` 只解除订阅，不能证明 native writer 已释放。Fork 的源 Session 保留原 native identity，下一轮仍可 resume；
- fresh-thread 不需要先创建空 native 分支。若产品 Rewind 已提交，随后 source 停止或 Runtime restore 失败，返回已提交并需恢复的结果，不能伪报未执行；source 停止无法确认时由现有 Sidecar restart 路径接管。

Retry 在同一 lease 内完成上述回溯与普通 desktop admission，不再只截断产品记录。停止 source 时保留期间新入队的请求；自身 replay 通过现有队列排序进入队首后才释放 lease。公共操作与响应契约见 [Session §4.4](session_architecture.md#44-rewindforkretry-与-reload-anchor)。

不得用 experimental rollback、Renderer mirror 或猜测的 previous-turn id 替代 native history。产品 transcript 仍由 SessionStore 拥有，不从 Codex rollout 反向重建。

Codex Server → Client request 使用显式 allowlist。升级 app-server 时以当前 binary 生成的 schema 核对请求和 notification；未知 request fail closed。approval 与 structured question 可并发，后端按 request id 持有多个 pending，Renderer 以 FIFO queue 投影，不能使用单槽位覆盖。

非阻塞问题来自 root `agentMessage` 的 `delivery: "async"` / `questions`，不是 permission RPC。Adapter 在 item 完成时校验结构，使用 thread/item identity，随 `text_stop` 写入既有 text block 的 `asyncQuestions`；文字仍用于纯文本消费者，旧历史不按 Markdown 猜测结构。已关闭文本块不能继续接后续 delta，聊天与 Companion 共用该边界。

回答走普通 `sendDesktopMessage`，仅附加 `asyncQuestionReply` 关联。定义属于 Session transcript，待发状态属于现有 operation queue，已回答以真正受理的 user message 为准；HTTP queued 或 Codex steer RPC ack 都不代表已回答。普通 turn/start 回答在原生 send 成功后才进入 transcript，提前到达的 terminal 复用每个消息操作（直接发送及排队共有）的 dispatchAcceptance 保持 user → assistant 写入顺序；realtime 回答必须收到 native user echo，回合结束时只有 RPC ack 的回答释放为可重试。取消恢复输入同时恢复问题关联。Ingress 和排队后的 dispatch gate 校验同一 Session 的来源与重复回答；取消/失败释放队列项，历史与 reconnect snapshot 保留定义、关联和队列投影。子 Agent 事件保持嵌套 trace，不升级为主会话问题卡片。

工具与子 Agent item 在 adapter 内映射为标准 tool/content blocks：command、file change、MCP、dynamic tool、web search、image view/generation 与 collab-agent 都走同一 transcript/attachment pipeline。raw protocol payload 不越过 adapter，也不写日志。

### 5.4 Integrated DSH

`integrated-runtimes/dsh/runtime.ts` 通过 `RuntimeProcessHost` 和生成 client 连接一个 DSH generation。 DSH transport/process failure 必须发送 `session_complete` 给共享 lifecycle owner，释放该 generation 的 running/process 状态；只发送 error status 会阻止下一条 query 的原生恢复。Runtime 独占原生 Session/Turn、DSH 工具流水线、permission revision 与子 Agent 生命周期；Host 的 `SessionStore` 独占 Product transcript、冻结 identity 和 mutation/input journal。原生 receipt 决定输入是否被消费；legacy Session 仍等待 Product durable commit，V2 则更新 canonical projection 并保留执行恢复 journal，正文由后台 writer 提交。RPC 成功本身不能推断 DSH 输入已进入对话。

结构化 `systemContext` 分别传入 global/root contributions，主项目指令由 Runtime 的 DSH 指令插件加载。Skills/MCP 等扩展由同一次 Product capability inventory 编译为声明式快照；子 Agent 由 DSH 原生工具创建。runtime-neutral `product-extensions` dispatcher 供 DSH reverse ports 与 Managed Codex 共用。DSH extension replacement 在原生事务边界更新，当前状态通过既有 SSE 和组件诊断投影。

Fork/rewind/delete/retry/compact 走 SessionEngine 的 adapter operation；丢失回包由既有 Product journal 与原生 receipts 对账。Root/child 权限与 AskUser 复用产品交互。Agent 树来自 DSH 原生目录，个人任务按 Agent Session 读取，共享任务单独读取；客户端的中断按钮只中断当前轮次，给可延续子 Agent 发消息即可再次工作。官方 Shell/Jobs 组件拥有平台命令执行，Host 仅声明执行环境和处理权限。

DSH 权限选择先存为 Session 的期望模式；当前 turn 使用 admission 时冻结的模式，不因设置变化中断。下一条 query 启动前，adapter 在原生 `config/apply` 边界同时落实 Product 权限、DSH sandbox 与 approval policy，确认有效后才发送 `turn/start`；应用失败则阻止这条 query，不能沿用旧权限执行。

详细协议、制品边界与恢复规则见 [DSH 集成指南](./myagents_dsh_integrated_runtime.md)。

## 6. External Session owner

`src/server/runtimes/external-session.ts` 是 public facade。状态按职责拆入同名目录：

| Owner | 职责 |
|---|---|
| `lifecycle.ts` | process/start/pre-warm/stop 与 generation |
| `operation-queue.ts` | message 与 config operation 的 FIFO、steer fallback |
| `turn-lifecycle.ts` | promotion、running、terminal 与 finalization gate |
| `runtime-config.ts` | desired/effective config 与 source filtering |
| `transcript-persistence.ts` | user append、assistant commit、cursor 与产品内容投影；联合历史 mutation 由 facade 调用 SessionStore |
| `content-blocks.ts` | V1 内容块与共用展示 policy；V2 内容由 SessionStore projection 持有 |
| `interactive.ts` | permissions、questions、IM/Inbox/watch association |
| `extensions.ts` | Managed Codex extension projection |

facade 负责组装 owner，不重新保存同一份 mutable state。Route 和 SessionEngine adapter 不直接 import这些内部模块。

### 6.1 admission 与序列化

每个 ingress 先创建包含 Product user message、config snapshot、queue id 与 caller metadata 的 operation。所有路径共享同一 admission order：

1. 等待正在进行的 start/pre-warm；
2. 在持久进程中序列化 active turn；
3. 等待上一 turn 的真实执行结算；V1 仍保留原 transcript finalization 等待，V2 不等待产品 IO；
4. 对 Task/Goal 等执行 exact domain dispatch claim；
5. 在 transport 前再次验证 process generation 与 cancellation token。

guard accepted 之前不展示伪 user bubble、不写 transcript、不启动 watchdog。transport write 开始后的 error 只表示 acknowledgement 不确定；必须尝试 exact stop，未确认终止时保留 process、queue binding 和 domain owner，不能自动重放。

V1 保留 user append、成功 terminal/附件/finalization gate 内提交 assistant 的原行为。V2 在接纳和 native 内容事件中更新 canonical projection，后台持续保存；下一 turn 和同步 caller 只依赖执行结算，最新结果读 live projection。完整帧、retraction 和 Codex nativeText 按原产品目标确认；细节见 [`session_transcript_v2.md`](session_transcript_v2.md)。

### 6.2 realtime 与 turn-boundary queue

desktop response mode 决定 busy 时尝试 same-turn steer 还是排到 turn boundary。是否可 steer 由 `AgentRuntime` 静态能力与当前 process generation 的动态 target共同决定，不硬编码 Runtime 名称。

native steer 明确返回“未接收”时，同一个 operation 可以按原 admission order降级到 turn-boundary queue；timeout、process exit 等不确定错误不能自动重放。same-turn steer 不应用新的 model/permission/reasoning snapshot。

SessionEngine 的可信 Inbox ingress 固定 realtime，不读取手动 query 设置，也不根据正文的 `system-reminder` 标签判断来源。原 operation queue 在 running 时选择可实时消费的输入，可越过等待下一轮的手动消息与配置 operation；配置仍只在 boundary 生效。同消费时机的输入保持接纳顺序。builtin 使用 SDK async queue，DSH 使用 `turn/followUp`，Codex 使用 `turn/steer`；native 消费回执才上屏并关联到实际轮次，RPC ack 不能代替消费确认。多个同轮已消费的请求各自保留 Inbox 回复关联，共享 terminal 结果；reply/watch notification 不注册自动回复。

IM、Task 的直接执行与 scheduled turn 保持 turn-level admission。Task Comment 等通过 Inbox 投递的事件遵循 Inbox 策略。用户显式 force-start、取消与 Stop 都由 operation queue 按 exact queue id重排或结算，不能清除无关后续项。

### 6.3 配置变更

model、permission、reasoning 与 capability changes 都先进入 source-aware config policy，再成为 operation：

- active turn 保持其 admission snapshot；
- config operation 在下一个 turn boundary 先于后续 message 应用；
- IM sync 不覆盖 owned Session snapshot；
- 需要 replacement 的变化只在 idle boundary 换代，当前 turn 不受影响；
- native config RPC 失败时阻止使用旧配置启动已排队消息。

重复 hydration 或相同 effective config 必须 no-op。不能把“收到一次 POST”当配置真的变化，否则 adopt 已预热 Session 会被无意义重启。

### 6.4 pre-warm

Pre-warm 只适用于可保持 idle process 的 Codex/DSH；Claude Code 每 turn 启动进程，不预热。

pre-warm 建立真实、可由后续首条消息复用的 process/thread，但不把 Session 标为 running、不启动 per-turn watchdog，也不凭空发布 Product metadata。首个真实 turn 在统一 materialization helper 中提交 metadata 和 user transcript。

`isBusy()` 表达 turn activity；process liveness 由独立状态表达。idle pre-warm process不能阻塞 Goal、Memory 或其它需要 idle Session 的调用方。失败仅记录日志，真实 send 仍走正常 start/resume；cross-runtime mismatch、stale native id 或缺失 Product metadata 均 fail closed。

## 7. Managed Codex 扩展

Managed Codex 由 MyAgents 拥有 app-server launch config，所以可以把 Product capability 投影进去；system-cli Codex 继续由用户配置拥有，不接管。

`external-session/extensions.ts` 从当前权威配置编译 immutable snapshot，并用 desired/effective revision 管理 process generation：无进程等待下次启动，active turn 延后到 idle，idle 时安全 replacement。旧 generation 的结果不能回写新 revision。

| Product capability | 投影 |
|---|---|
| Skills | enabled winner 的临时精确目录、extra roots 与 native read-back |
| Commands | admission 时展开为 Runtime prompt；transcript 保留用户原始命令 |
| Agents | native agent config，只映射能忠实表达的字段 |
| external MCP | 从服务端 definition 编译 launch config |
| in-process MCP / IM bridge | generation-bound dynamic tool dispatcher |
| Plugins | 只编译 manifest 声明且当前 Runtime 可表达的组件 |

Renderer 对 MCP 只提交 ID intent；Sidecar 必须重新读取 command/env/url definition。secret 只进入进程环境或 apply fingerprint，不进入 argv、revision、diagnostics 或日志。

单个 Skill/MCP/Agent/Plugin 无法解析或不受支持时，只排除该组件并产生结构化诊断；基础 Runtime generation 仍可用。只有顶层 Runtime 无法启动/应用时才阻断 Chat。依赖 `ProductSystemSkillRequirement` 的 turn 是明确例外：它必须核对 exact app-owned candidate、内容 digest、inventory revision 与 native read-back，已知不可用时拒绝该依赖 turn，但不使普通会话失效。

动态工具目录绑定 native thread birth 和 process generation。未知、已删除、参数无效、重复或 stale tool call 只失败该调用；不得因 catalog 漂移清空 transcript、制造空 thread 或建立第二套 Agent loop。

Project Skill resolver 默认依次合并 `.claude/skills` 与 `.agents/skills`；相同有效 folder 由前者获胜，invalid candidate 不遮蔽后根。Managed Codex 按 exact native path 禁用未进入 effective inventory 的 `.agents/skills` 候选，选中项仍由原生 parser 读取。全局兼容投影继续只维护 `.claude/skills`，不建立第二套用户级目录。

## 8. Skill、Command 与工具能力

`AgentConfig.capabilitySelection` 是项目选择的持久化 authority。`project-capabilities.ts` 扫描 Project 与用户候选，按 canonical name 选择 project > global winner，再应用 disabled intent。局部候选损坏只淘汰该候选，不阻断 workspace。

Command 的 selection identity、展示名与 invocation name 是三种不同事实。invocation name 由 source-relative path稳定派生；修改 frontmatter/H1 不得改变调用协议。设置、Sidebar、slash menu 与 Managed Codex compiler消费同一个 capability snapshot。

`.claude` symlink 是 system CLI 的兼容投影，不是选择 authority。外部 process记录启动时采用的 capability revision；下一次 admission 发现 revision 改变时在 idle boundary replacement，不依赖本 Sidecar 是否刚好执行了文件写入。

slash menu 按真实 Runtime capability投影：

- `/goal` 是 Runtime-neutral 产品动作；
- Claude SDK native commands 只在 builtin 显示；
- Managed Codex只显示已经适配的 native command；
- unsupported command 隐藏，而不是发送一段模拟 prompt；
- `runtime_tool_catalog` 只描述当前 generation 实际加载的工具，不反向成为 workspace 配置 authority。

## 9. 诊断与环境

外部 Runtime 的实际环境可能与用户交互式终端不同。所有启动与 CLI diagnose共用 `resolveAgentEnvPolicy(workspacePath)`：

| proxy policy | 语义 |
|---|---|
| `myagents` | 使用 Sidecar 启动时由 MyAgents 注入的 proxy 环境 |
| `terminal` | 使用 shell warmup 捕获的交互式终端 proxy 变量 |

未知或旧字面量回落到安全默认，不能通过类型断言绕过 resolver。诊断 snapshot 只暴露有效 proxy presence、PATH 前缀、cwd、shell 和结构化 RPC 状态，不记录 secret 或完整环境。

Codex 在 Session 启动后异步收集 auth、feature、MCP 与 app 状态，并通过 `runtime_diagnostics` 投影。单个诊断 RPC 失败不阻断首轮；只有 producer 明确标记的顶层阻断状态显示 Chat banner。Renderer 不按失败数量或组件状态自行提升 severity。

Runtime tool catalog 是独立的可变 capability snapshot；只包含当前 native Runtime 已确认可用的工具。查询暂时失败保留仍健康的上一 snapshot，明确 failed/cancelled 才撤回对应 server。广播前必须校验 process generation，避免退出进程的迟到诊断污染新 Session。

Codex process 退出必须清空当前可调用目录，但不改 Session 的 desired MCP 选择。主动 stop/recycle 在 exact process teardown 前记录 intent，effective MCP 投影为 `stopped`；非预期退出及协议故障清理仍为 `failed / MCP_RUNTIME_EXITED`，不能仅凭 exit code 0 判断正常。`stopped` 环境可随下一条消息启动，也可显式启动；`failed` 可显式重试，两者共用 SessionEngine 的 MCP retry、既有 mutation lease 与 idle prewarm，不重发已取消消息。`POST /api/mcp/retry` 属于 Session role，Global role 不接纳。Renderer 等待真实 owner snapshot，不把请求接受视为工具 ready；重连失败在当前工具行显示有界原因。

外层 Session 的 watchdog、启动后 send 失败也必须把 failure teardown intent 传给 adapter，不能让调用 `stopSession` 本身成为“用户停止”的证据。显式 MCP retry 在 invalidation 后、首份 native snapshot 前启动失败时，由持有 mutation lease 的 Session owner 发布当前 desired 集合的无工具 failed snapshot；不恢复旧 ready 目录，也不覆盖已有 native 失败/授权诊断。

CLI 诊断命令与真实 Session 启动使用同一个 env resolver 和 adapter probe。命令入口见 [`cli_architecture.md`](cli_architecture.md)。

外部 CLI 选择遵循用户 Shell 的 PATH 顺序；检测、查询与启动等待同一次异步环境发现，并以子进程实际 env 解析绝对路径。平台目录只用于兜底，不抢占用户版本管理器。顺序、超时和平台边界见 [Bundled Node 的 Runtime locator 与 PATH](bundled_node.md#runtime-locator-与-path)。

Codex 模型和推理强度来自原生 `model/list`（含分页），不维护静态模型白名单。已有 Codex Session 查询自己的活跃 app-server，包含 `system-cli` 和 `managed-provider`；没有活跃对应 Session 时才临时启动已安装 CLI 查询。临时查询的五分钟缓存按 Runtime source、解析后 executable/文件 revision、原生 home 与 PATH 区分，安装来源变化不会沿用另一份 CLI 的目录。

DSH 与 Codex 共用 `runtimeSupportsPrewarm()`，先建立 Product Session/config owner 再预热。DSH compact 使用 `session/compact`；reasoning delta 若无独立 block lifecycle，由 Host 补齐 start/stop 后投影，保持与 text/tool 的顺序。

## 10. Context 用量

Context 指示器展示最近一次主模型 API 调用的 input-side 占用，不是整个 turn 的累计 token。否则工具循环会重复计算上下文并严重高估。

| 系列 | 归一化 |
|---|---|
| Anthropic（builtin / Claude Code） | ordinary input + cache read + cache creation |
| OpenAI（Codex） | Runtime 已包含 cached 的 input total，不再重复相加 |

分母优先使用 Runtime 报告的窗口，其次模型注册表，最后产品默认值。OpenAI Bridge 必须先把 total input 拆成与 Anthropic 互斥的 ordinary/read/create 分区，防止下游重复计算 cache。

external adapter 只在 UnifiedEvent 显式给出 `contextOccupiedTokens` 时广播 context usage；缺失时宁可不显示，也不拿 running total/turn total 猜测。turn settlement 的同一 snapshot同时写入 Session metadata供重开恢复，并校验 source 与 Session Runtime 一致。

native compact 是 capability，不是所有 Runtime 的共同功能。builtin 走 SDK command；Managed Codex 走 SessionEngine native compact operation并隔离 control turn事件；DSH 走 `session/compact`；没有等价语义的 Runtime 不展示入口。

## 11. 安全与日志

- Runtime binary、RPC schema 与 CLI flags 必须从当前安装版本的类型/生成物核对，不凭记忆维护。
- prompt、tool delta、raw NDJSON/JSON-RPC、provider error body 与 secret 不进入常规日志；只记录长度、hash、枚举与不可逆摘要。
- per-turn watchdog 只覆盖 active turn，不能杀死合法 idle pre-warm process。
- path、attachment、MCP template 与 subprocess env 使用共享安全 helper，不在 adapter 复制一套校验。
- Runtime mismatch 在 restore/pre-warm/send 三个入口都要检查，防止 native history 串入另一 Runtime。
- external terminal 只以 adapter 的真实 success result为成功；stale assistant text 不能被 Task/Goal/Heartbeat 复用。

## 12. 关键实现

| 路径 | 职责 |
|---|---|
| `src/server/session-engine/` | Runtime selector、adapters 与产品级 facade |
| `src/server/session-core/` | 跨 Runtime pure policy |
| `src/server/runtimes/types.ts` | `AgentRuntime`、`UnifiedEvent` 与中性 capability |
| `src/server/runtimes/factory.ts` | Runtime detection 与工厂 |
| `src/server/runtimes/claude-code.ts` | Claude Code NDJSON adapter |
| `src/server/runtimes/codex.ts` | Codex app-server adapter |
| `src/server/runtimes/external-session.ts` | external public facade |
| `src/server/runtimes/external-session/` | external lifecycle、queue、turn、config、content、interactive 与 extension owners |
| `src/server/project-capabilities.ts` | Project/global Skill 与 Command winner snapshot |
| `src/shared/managed-codex-runtime.json` | Managed Codex target version lock |
| `src/shared/contextUsage.ts` | Context usage归一化 pure policy |
| `src/renderer/components/RuntimeDiagnosticsBanner.tsx` | Runtime 诊断投影 |

工具附件的 current wire、落盘与展示规则见 [`tool_attachment_pipeline.md`](tool_attachment_pipeline.md)。

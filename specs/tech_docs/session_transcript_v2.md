# Product Session 历史 V2

`SessionStore` 拥有产品历史的格式、live projection、磁盘提交与 metadata；Runtime 的 native session/thread 只拥有执行上下文。保存状态不参与普通 AI admission、工具消费或 terminal 成功裁决。

## 格式与创建

`sessions.json` 的 `transcriptFormat: 2` 将会话固定到 `sessions-v2/<id>.jsonl`。无该字段的旧 Session 继续原 `sessions/<id>.jsonl` / `.json` 路径，包括原有保存时机和 JSON→JSONL 兼容行为。新建和所有 fork 目标用 V2；没有迁移、双写或 V2→V1 fallback。未知版本、metadata/文件冲突或缺失 V2 只报告不可安全保存，不能猜另一份历史。

`createSessionMetadata` 的出生授权与 binding owner 的 prepare/commit 固定身份。新会话先建立 active overlay，文件与 metadata 在后台发布；产品磁盘故障不撤销已合法接纳的 AI 请求。已发布旧 identity、prepared claim 与 native ACK 不确定仍由原 lifecycle 裁决。`updateSessionMetadataForBinding` 的 CAS 由当前执行 binding 裁决；产品编辑的 `updateSessionMetadata` precondition 保持锁内重读磁盘，有限等候只影响该显式编辑。Global 显式创建未打开会话使用 `publishSessionForHandoff` 发布并释放 writer。

Rust 在 metadata 尚未发布的窗口，沿 active 或 recovering SessionSidecar 保留既定 runtime/source；Agent 当前默认不能替换已经绑定的身份。pending→real 的完整出生快照沿目标 Sidecar 的现有 prepare/rekey/commit 路径传递。

跨进程续聊先尊重 SidecarManager 的逻辑 owner；只有无 owner 的身份才以磁盘索引判断是否失效。IM/Heartbeat 不因未发布 metadata 轮换仍有 owner 的 Session；Task single-session 保留已接纳的绑定，出生锁在既有 Runtime admission 回调释放；Inbox/CLI watch 与 Task 评论由生命周期 owner 判断目标是否存在。冷 metadata/空历史读取不创建产品目录，避免读取成为 AI 启动的写盘前置条件。

## 内容和读取

`src/shared/sessionTranscript.ts` 定义唯一内容投影与操作语义；`src/server/session-transcript/` 是 SessionStore 内的实现，不是另一个存储 owner。

- Message/Block/Tool 的产品 ID 稳定。用户插话结束当前展示段，后续主文本进入新段；晚到工具、附件与完整帧仍更新原目标。
- `ProductTranscriptContent` / `TranscriptPresentation` 只持有 native response、stream index、parent、SDK delivery UUID 到产品目标的关联。正文在 writer projection；完整帧确认 partial，retraction 按 root/child scope 删除对应块。
- Product binding 共享 Session identity，不共享 Runtime presentation 权限。Builtin transcript binding 只在 `builtin` Runtime 返回该 identity；DSH / external Sidecar 中 dormant SDK facade 不得订阅 writer。否则正文只追加一次，两个发布器却各自生成 SSE revision，实时显示会逐 delta 重复；这不是应由 Renderer 按文字内容去重的故障。
- 同一 native 文本块跨插话时记录片段边界，完整帧按边界确认各产品段；只有末段可取得该 native delivery 的末端锚点，中间段的 fork/rewind 明确拒绝。Codex item 的 `nativeText` 保留缩短/更正/空字符串；native item id 不伪装为 SDK UUID。
- Builtin 的产品错误提示通过 `ProductTranscriptContent.appendDiagnostic` 创建独立 assistant 记录，携带 `messageKind: diagnostic`，无 native UUID/anchor，不改变当前 native assistant、block/tool 目标和 usage。字段从创建操作进入 canonical 历史，并经 wire、冷恢复和 fork 保留；诊断自身不是 native fork 点。旧无标记 Error 不按正文猜来源或自动拆分。
- 工具 JSON 输入以 `inputJson` + `inputComplete` 表达，旧 wire 的 `input` 在读取时派生。结果/输入大字符串分块入日志；媒体字节仍走既有附件管线。
- 列表 stats 从 canonical message 的角色与 usage 标量派生，预览沿用最后可见用户 query 的既有语义；不序列化 assistant 工具正文计算统计。Turn 的 root user、状态、usage 与 message 分开，同一 turn 多个展示段不重复计费。native success/Stop/error 输出读当前 projection，不读旧磁盘结果。

每行 batch 包含连续 revision、唯一 batch ID、操作及原始 batch JSON 字节的 SHA-256。替换文件使用 header 中的 generation 与完整 baseline 结束标记。Node codec 和 Rust `session_transcript.rs` 共享 `src/shared/fixtures/session-transcript-v2.json`。冷读只 fold 有效连续前缀，不跳过损坏中间行；未完成 baseline 不可当成会话历史。

Node 冷读先校验原始 batch 字节与操作 schema，再仅在该 batch 的内存副本中合并同目标、offset 连续的相邻 `text-append`（单条至多 32 Ki UTF-16 code units），最后按原有原子 batch 语义 fold。旧文件不改写，跨 batch、跨其他操作、不同目标或 offset 断点不合并；损坏 batch 仍整体回滚。Rust reader 保持原 wire 契约，可读取 revision 跨越多次观察而仅含一条合并 append 的新 batch。

`message-update.details` 只允许 `TranscriptMessageDetails` 的非身份字段，且必须覆盖其全部字段。`src/shared/session-transcript-message-details.json` 是 Node 和 Rust reader 共用的字段表；TypeScript 编译时检查它与类型的字段集合完全一致。停止后的部分 assistant turn 使用 `completionState`、`terminalStatus`，DSH 还可能写入 `runtimeOperationAnchor`。两端共享的 wire fixture 与冷恢复后继续写入的集成测试验证这一契约；合法历史不能因 reader 漏认字段而被标为 `invalid-history`。

## 后台保存

`TranscriptWriter` 在首个待写操作起约 100 ms 启动固定批次，不做滑动 debounce；接纳/终态等边界可提前提交。批次约 256 KiB，单行上限 8 MiB，用户正文、完整工具结果等大字符串复用 `operations.ts` 拆分为 32 Ki 字符操作；达到批量阈值可提前开始实际 IO。

`observe` 先更新 live projection 并逐条发出展示操作，再排保存队列。队尾相邻、同目标、offset 连续的小段 `text-append` 可在尚未提交的队列里合并至多 32 Ki UTF-16 code units；边界操作、metadata barrier、已出队或待重试批次不合并。每次观察仍增加一次 live revision，持久 batch 保留完整 revision 范围。待写队列没有容量上限，不按积压量丢弃操作、触发降级或重建基线，也不反压 Runtime。持续故障时保留待写操作，接受额外内存增长风险；`queuedBytes` 累加合并前的序列化字节，作为保守的批量阈值统计，不是实际文件字节数或进程内存上限。创建、命名 mutation 及下述空来源恢复可用完整 projection 生成替换基线；未知/损坏来源不能覆盖已提交文件，基线 R 之后新增操作按序保留。

活跃 writer 的记录完整时，`invalid-history` 可触发一次 `recoverEmptySource`：文件 owner 在原锁内证明来源是零字节文件，或无已提交 batch 且没有 baseline 的干净 header，才用完整 live projection 发布新基线。冷读不据此制造历史；有已提交内容、损坏尾部或恢复提交不确定时保持阻断，不重复恢复，live projection 仍保留供读取和导出。

每个 Session 只有一个实际 IO。约 10 秒无提交标为异常；已结束的失败按 0.5/1.5/5/15/30 秒退避。超时仅结束等待，不能抢占尚未结束的写入。append 在原文件锁内检查 cursor、generation、文件身份和不确定批次，完成短写循环与文件 sync；重试精确确认已有批次，半写尾部仅在证据充分时修复。

替换先写独立 candidate、sync、用生产 reader 对比完整内容，再在锁内原子 rename、同步目录、发布必要 metadata。revision 只在这些步骤完成后进入 durable 状态；预览/统计不是内容提交的 authority。Node 目录同步错误必须传播；保证进程崩溃后有效前缀，未承诺整机掉电零丢失。各平台实际验证结果留在交付证据中。

## 生命周期与显式操作

冷恢复等待同一文件锁下的实际读取结果，不用超时生成空基线。临时 IO 失败保留原错误、释放未完成的 activation，后续沿原入口重新恢复；只有已验证的格式/内容错误才标记 incomplete source。append 重读同样区分 IO 与解码错误，前者复用既有 writer 重试。

显式截断由 writer 在替换 projection 的同一 revision 发布 `messages-remove`，content/presentation 订阅既有操作同步清理被删目标的身份引用；不能从截断后的结果反推删除集合。活跃 cursor 以 instance/liveRevision 判断新鲜度，磁盘 baseline publication 改变 generation 不使未变的 live snapshot 失效；冷 cursor 仍核对 generation/durableRevision。

冷恢复仅在旧 execution owner 已失效后派生并提交 interrupted 状态。未结束工具保留已观察结果，停止展示 loading，不自动重跑；不能把仍活跃的后台子任务因父 turn terminal 关掉。

`setCurrentProductSessionId` 在同进程变更真实 binding 前调用 `releaseSessionTranscriptForBinding`，在同一截止时间内先尝试保存当前 live revision，再退役 writer、移除 active 实例。普通保存失败不新增切换拦截；物理 IO 尚未结束、无法安全退役时保留原 writer 与旧 binding。SDK reset/switch 在 binding 成功后才清空展示、UUID 和交互状态。pending materialization 在 claim 目标 metadata 前完成旧 writer 退役，并在等待后复核原事务归属；失败仍可沿既有入口 retry/rollback。目标身份生效后才执行 `afterBind`。异步 candidate 清理只处理该实例独占的未发布文件。普通保存失败不阻止同一 binding 上继续 AI。

- Rewind 先由 SessionStore 检查来源；已有未落盘 mutation 时先通过 writer 的 `flushForMutation` 等待，再做 native/file 副作用；本次 commit 同样等待实际 IO 并核对 cursor 和 binding。正常慢写无业务 deadline，真实 IO 失败仍由既有 writer 后台重试；忙碌/写盘未完成不是历史损坏。复用命名 mutation 和 pending intent；target live/native binding 已裁决后，普通对话继续使用 target，磁盘发布后台补齐，不能回退 native 或重复执行。
- Fork 经 `publishForkSession` 登记隐藏的 prepared 目标，复制用户与工具附件，生成、校验并发布完整 V2 baseline，最后解除 prepared 状态进入持久列表。不完整来源不能 fork；必要附件尚未保存或缺失时显式失败。源 V1 不强刷、不改写；目标 writer 不留在源 Sidecar。失败仅清理自身未发布资源，metadata 已提交后不删除目标；正常慢写等待实际 IO，不设置固定发布取消 deadline。
- Retry 复用 Rewind 的提交与普通消息写入，不存在只修改产品 transcript 的 external retry mutation。V2 writer 在逻辑截断时发布删除操作，V1 facade 在提交后发布既有 `chat:messages-retracted`；二者均先删除后接纳 replay。native 边界、配置继承、并发次序与结果确认统一见 [Session 操作契约](session_architecture.md#44-rewindforkretry-与-reload-anchor)。
- Delete 先做原 owner/busy 检查，并确认对应 Node 进程退出后才调用 Global 删除。进程退役期间保留 owner identity，失败不删文件。不能仅凭超时假设旧 IO 已取消。
- SIGINT/SIGTERM 使用有截止时间的 `drainSessionTranscripts`；强杀只恢复已提交前缀，允许丢失最后的未提交尾部。

## DSH 原生执行与产品历史

DSH 同样使用 V2 canonical projection 和后台 writer；旧 Session 的 legacy 格式不变。流式文本、thinking、工具、插话分段、partial Stop/error 与 collaboration 均进入同一 Product 内容路径。collaboration turn 使用明确的 `origin: collaboration`，没有伪造的用户消息；Node/Rust codec 共享 fixture。native terminal 只赋给末展示段，恢复保留已展示的消息和 block 身份，不把整轮正文重复塞入末段。

DSH 的执行事务仍由 SessionStore journal 裁决，不能把 V2 的保存状态当作 native 成功状态。`pendingDshRootOperation` 表示当前 root admission；`pendingDshRootInputs` 保留尚未确认正文落盘的准确用户输入。普通后续执行使用 active projection，不获取后台正文的物理文件锁；即使正文写入一直悬挂，接纳与收据结算也不等待正文 IO，立即写执行记录时也不能提前清掉上一笔尚未落盘的输入或 rewind generation。writer 的 metadata callback 只有在本次提交覆盖当前 live revision 时才退休这些记录；异步发布返回的旧快照不能覆盖当前执行状态，也不能确认尚未覆盖的执行字段；连续发送、插话收据和 metadata 发布失败均遵守这个顺序。

冷恢复先采用 journal 中准确、缺失的 root 输入，再依据 native receipts 恢复输出。唯一允许重新建立尚未出现的 V2 文件的情形，是 journal 持有明确的未发布出生证明；已经发布却丢失或损坏的历史不能被这条路径重建。后者保持不可覆盖，并允许已验证的 native Session 继续产生 live 内容；fork/rewind 仍拒绝不完整来源。

显式 DSH fork/rewind 先确认完整来源。fork 目标通过既有 V2 candidate/file owner 写入，prepared 期间不可见，native commit 后才发布，abort 清理目标文件与复制附件。rewind 在替换前写入 source/target generation 和 revision 证明；冷恢复以此识别已经发布的替换，保留其后新接纳的输入。原生 delete 已 purge 后，先退休 active writer，再删除 V2 文件，避免后台保存复活已删除会话。

## 展示、故障提示与搜索

领域操作经现有有序 SSE/liveRevision 更新稳定 message/block 的文本、thinking、状态与回撤。较早分页按请求内保存的 ref 在 page admission 前解析最终工具输入，不能只依赖 ref 最初到达时的已加载行。大工具正文继续使用既有 bounded preview/ref；先同步显示预览，后台补引用。回填按原 Session/writer、工具目标和 renderer restore/connection generation 定位。Renderer 没有第二份完整历史 Map。

REST 返回同一 revision 的历史、live overlay 与保存状态。恢复刷新整个已加载范围；分页请求仅保存有界的 post-snapshot 操作重放，跨 Session/restore/connection 的旧响应被丢弃。展示长度与磁盘文本 offset 不等价，paced reveal 与全文修正按显示目标合并。

历史 REST、cold replay 与 live snapshot 共用辅助内容投影：256 KiB 预算只约束工具/思考预览，不能根据整条消息大小裁剪用户或助手正文，也不能在省略中间工具块时删除正文块。旧 string、JSON-string blocks 与数组 blocks 都保留完整正文，磁盘 transcript 不改写。超大 HTTP response 继续使用 Rust proxy spill；`chat:init` / `chat:message-replay` / `chat:transcript-operation` 的 JSON event 超过 256 KiB 时由 SSE transport 队列写入既有 `/refs/:id`，同名 event 携带 `sse-payload-ref` envelope。只允许队首进行异步写入，保持 snapshot capture/subscription 同步和后续 revision 顺序；写入失败或队列超限使连接失败，不能跳过正文后继续发增量。Ref 使用现有 1h TTL，不属于持久 transcript。

`SseConnection` 在业务解析前自动读取全文，后续事件等待同一连接的正文加载；Tab 与 Companion 不另建全文缓存或点击入口。新 transport generation / disconnect 撤销旧读与待处理事件，ref 读取失败或超时走既有连接重试，禁止把不完整正文当成有效 baseline。终态通知 event 不采用该 envelope，继续由 Rust notification owner 直接检查。

V2 用户正文只由 canonical `message-create` / 内容操作建立；较早的 live-user-echo 只投影受理状态，不能成为正文基线。若首次连接尚未识别 V2、legacy 回声已显示同 ID，canonical 创建仍接管正文。前端本地附件预览在用户创建时合并，晚到回声不能丢掉预览；不要用显示层 offset 去重掩盖两种基线混用。尚未 REST adoption 的 SSE-native 新会话重连，仍用有序 cold-history snapshot 补齐错过的创建/正文；已 REST 恢复的 Tab 按既有护栏拒绝该快照。

Desktop 接纳本地发送后，TabProvider 立即投影用户气泡与 loading；执行中的插话沿用立即显示的 queue pill。尚未收到后台接纳时不等待 HTTP、Runtime 启动或 SSE。请求中的 `clientRequestId` 由既有 SessionEngine 路径带入服务端用户消息 metadata，前端按该身份接替临时气泡，不能按正文或附件名称匹配。临时正文只用于显示，不写入 canonical history ref；canonical 创建的空正文与后续 offset 仍由 V2 操作维护。发送失败保留带失败标记的临时气泡，停止本次等待；临时 ID 不提供 native rewind。错误提示的显式重发对本地失败消息走普通发送并替换该失败投影，不调用依赖 native history anchor 的 retry；正式消息仍走 SessionEngine retry。该投影只属于当前 Tab，Session 切换时清除，pending Session 出生时保留。

Chat Tab 与桌宠复用 `transcriptDisplay`、`transcriptToolDisplay`、`liveRevisionFence` 和 toast consumer。桌宠只转换自身的 `ai`/`text` 展示形状，不另定义 V2 内容语义；连接/重连从 REST 建立 baseline，revision gap 刷新已展示范围。旧格式继续 legacy chunk 路径；复用的 Sidecar 不重新推送工作区 MCP/Agent 默认配置。

`chat:transcript-save-status` 与 REST transcriptSaveStatus 只产生 toast：故障 5 秒、恢复 3 秒，同一 Session/instance/incident 在 ToastProvider 生命周期去重。发送、插话、工具、草稿和焦点保持可用。恢复必须对应实际提交、出生 metadata 已发布、记录缺口消失；单次试写成功不能宣称恢复。

Rust Search watcher 同时观察 sessions 与 sessions-v2。V2 索引按 Session/message ID 更新；最多 4 会话、128 MiB 源日志的派生游标缓存绑定 generation 和有效末批边界，替换/修复不只比较长度。启动时重扫 V2 覆盖离线变化；搜索只能重建自身索引，不能修复权威记录。Memory 读端使用相同格式决策。

## 验证入口

`session-transcript/*.unit.test.ts`、`*.integration.test.ts` 覆盖 codec、writer、原始文件、binding、fork、fake SDK 与真实进程强杀；external adapter、SessionEngine、Renderer restore/toast 与 Rust reader/indexer 的原测试共同验证接线。

性能：`node --import tsx/esm scripts/benchmark-session-transcript.mjs --keep-fixtures` 生成临时合成文件并报告 10/100 MiB 冷读、四会话 20 ms 输入及 8 MiB 工具结果。把输出中的 root 传给 `MYAGENTS_TRANSCRIPT_BENCH_DIR`，运行 Rust `benchmark_cold_fold --ignored --nocapture`。`--live-only` 搭配 Node `--expose-gc` 独立测量流式队列、projection 和进程内存。索引对照用 `--index-fixtures` 生成并保留相同正文的 V1/V2 数据目录，将输出 root 传给 `MYAGENTS_TRANSCRIPT_INDEX_BENCH_DIR`，运行 Rust `benchmark_v1_v2_indexing --ignored --nocapture`；分别报告三次完整索引和无变化重扫耗时。用后删除合成目录。这些命令不读取真实用户历史，也不替代 Tauri 与跨平台验收。

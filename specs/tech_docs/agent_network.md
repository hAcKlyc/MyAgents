# Agent 网络

客户端实现位于 `src-tauri/src/agent_network/`、`src/server/agent-network/` 和 `src/renderer/features/agent-network/`。通用云端核心、协议源码及自部署属于 `hAcKlyc/MyAgents-Agenthub`（Apache-2.0）；官方部署由私有 `hAcKlyc/MyAgents_AgentNet` 固定产物组合，官方账号扩展仍属于 `MyAgents_space`。本文件说明当前代码边界，不代表云端已部署或跨设备验收已完成。

## Owner 与状态

| 事实                                                     | 权威入口                                                               |
| -------------------------------------------------------- | ---------------------------------------------------------------------- |
| 官方登录与 sessionBindingId；自部署账号 scope           | 官方沿原 Rust Space connector 与 Space 账号服务；自部署由固定 descriptor 与 Rust 连接生命周期裁决 |
| 设备身份代次                                            | 当前网络的身份签发方；Rust 按连接验证与投影                              |
| 稳定设备 ID、OS/默认主机名称                             | 原 `device_identity`                                                   |
| 用户指定的网络设备显示名称                               | 既有网络 SQLite DO 的设备记录；Rust 当前连接只读投影                  |
| 工作区与 Agent 的本地身份、路径、生命周期                | `resolvePersistedAgentWorkspaceRegistry`；不得用网络设置反向创建工作区 |
| 私钥、设备 WSS、内层 TLS、连接 epoch、传输分配           | Rust App `NetworkRegistry` / 各连接 `AgentNetwork`，不归 Tab 或 Session                             |
| 网络 membership、Agent enabled/description、CAS revision | 同网络 SQLite Durable Object                                           |
| Session 出生、接纳、queue、历史和 terminal               | 原 Inbox、SessionStore、SidecarManager 与 SessionEngine                |
| 页面与 @ 草稿                                            | Renderer 投影；不持有云凭据、私钥或可执行许可                          |

设备入网与设备在线是两个事实。入网默认全部 Agent 关闭；退出清空启用设置，重入仍全部关闭。离线设备可以管理设置；目录仅提供当前可调用对象。没有入网的来源可以主动调用已开放目标并接收当前连接内关联回程。

设备卡片与详情菜单共用「设备重命名」。同账号任意设备可修改任意在线、离线或未入网设备的网络名称；默认沿原账号 roster 的系统主机名，用户昵称在原设备记录 `customName` 持久化，roster 更新不覆盖它。列表、可调用目录和 resolve 共用同一显示名投影；昵称不影响设备/Agent/Session selector、membership/enable revision 或已有路由权限。名称为首尾空白裁剪后的单行文本，最长 160 UTF-16 单元；TS schema、Rust 校验与共享 fixture 保持一致。

改名沿原 metadata request / Rust proxy / DO mutation receipt 事务执行，按用户观察到的 `expectedName` 比较并发状态；冲突保留输入，查看最新名称后显式重试。不确定写仅查询原 receipt，不自动重放。保存沿原 `settings` invalidation 唤醒连接端读取；本机 `policy::hydrate` 从原设备列表把名称放入当前连接 snapshot，供快速本地 discovery 使用，无新增本地持久化、轮询或名称 authority。登出/断线/电源 boundary 清除连接名称；下一次连接重新读取。历史消息和已存引用快照不重写。

## 多网络连接与自部署身份

设置 → 开发者模式的「AgentNet 多网络（实验性）」由原 `config.json` 的 `agentNetworkSelfhostDevGate` 控制，缺省/非 `true` 均关闭。`NetworkRegistry` 在既有 mutation 锁内读取最新配置，裁决有效连接并通过本地 `selfhostEnabled` 投影 UI；不是网络协议字段。关闭只保留官方 actor 与官方页面，停止自部署 actor、阻止自部署加入/选择/移除及直接调用，保留已加入配置、原查看选择与 OS 凭据，不执行远端撤销。开启重建非 removing 连接并恢复原选择；重建代次必须高于停用前的 actor（包括电源 boundary），使迟到交接失效。官方登录、连接与管理保持原行为。

`registry.rs` 是 App 连接 owner：官方入口恒在，自部署连接/查看选择写入原 `config.json` 的 `agentNetworkConnections` / `agentNetworkSelectedConnection`，锁内重新读盘合并。所有已加入网络同时维持连接；标题下拉只选择展示。`account.rs` 分流原官方登录 adapter 与自部署 pinned descriptor，不改变 Space 登录/成员关系。每个自部署实例是一共同信任域；同一本地 Agent 与 Session/history 跨网络保持原实体，只逐网络配置开放。

加入时读取 HTTPS origin 的 descriptor，校验并固定 service/environment/principal/network/root/JWKS；身份兑换与 bootstrap 也必须匹配该信任。重定向不携带密钥，实例/信任变化明确拒绝。设备 key 只参与首次登记，不写 config、不保存在 Node/Renderer；私钥沿原 OS KeyScope 存储。已有活跃身份不能凭新 key 覆盖；被管理员撤销后可用新 key 递增设备代次重入。丢私钥须先撤销；官方凭据行为保留。

移除先持久化 `removing` 并停止该 actor，通过原私钥证明撤销/受限结果查询。未知保留人工重试且重启不连接。确认撤销后先把非秘密 `revokedScope` 保存进同一连接状态，再删 OS 凭据与连接配置；本地清理失败可继续，删除凭据后不再依赖远端证明。没有后台撤销队列。移除恢复使用同一连接记录的 `revokedScope`（已确认撤销的 generation）和 `reenrolling` 阶段；重新登记前先持久化该阶段。新 generation 已提交而 ACK/配置写入失败时，重试加入仅凭新 generation 私钥证明恢复；重试移除必须重新核实并撤销当前 generation，不能把旧 generation 的 checkpoint 当成整体已撤销。未尝试重新登记的已确认移除仍可离线重试本地清理。已接纳的本地执行与其他连接独立。

Registry 的递增 revision 隔离迟到拓扑/选择投影；每连接 snapshot 的 authGeneration/revision 隔离页面设置、目录读和草稿。替换同一连接 actor 从更高代次开始，旧交接 guard 不会命中新连接。连接共用 MemoryBudget 和一个 App 电源 monitor；官方登出只打断官方，睡眠唤醒通知所有连接。

@ 与 `agent list` 并行发现所有活跃网络，返回 `networks[]` 的各自 context/完整性，以及带 `connectionId` / `networkName` 的候选。健康结果保留；本地 alias 只按真实本机/localAgentId 折叠，远端不同网络 selector 不合并。查询快照按其所属网络检查，不按当前页面选择。`agent list --network NAME_OR_CONNECTION_ID` 筛选；`agent network-diagnose` 逐网络报告，分页 cursor 须同时指定 `--network`。完整 selector 决定 source routing，失败无跨网 fallback。

本地返回引用在原 opId/returnRouteId 上附带可选 `connectionId`；旧缺省仅指官方，新网络必须带自己的连接。Node watch registry 的关联比较含该字段，Rust 回程进入准确 actor；watch 取消使用读取时的 generation，避免迟到取消命中新权限。

## 调用与回程

CLI 使用原 `agent list/show`、`session list/get/state/start/send/watch` 命令。`src/shared/agentNetworkRouting.ts` 只区分本地 ID 与 `ma-agent:1:service:network:mount` / `ma-session:1:service:network:mount:localSession`。本地沿原 owner 路径；远端经来源 Node → Rust Management → App connector → relay → 目标原 owner。不能把 arbitrary Admin path、配置覆盖或远端文件路径送入 transport。

Rust 来源入口通过协议 `SourceRequest::reference()` 按操作解析完整引用，再把其中的 Agent scope 交给连接 registry。`get/state/send/watch` 的 Session 引用不能直接交给 `AgentReference::parse`；原请求须保留精确 Session ID，待目标 mount 解析后由 `bind()` 组装业务操作。连接选择只消费 service/network scope，不重新定义引用类型。

目标先由原 owner 冷准备，在网络等待期间释放 Session 生命周期锁；拿到当前授权 permit 后，在本机检查账号/连接/代次/有效期，再交给原 Inbox。最后交接以后是 in-flight，不能承诺 Rust 与 Node 跨进程原子撤销。`start/send` 返回真实接纳结果，不等待 AI terminal；明确失败、已接纳与 unconfirmed 必须区分，不自动重发。

来源/目标 return registry 只持有当前连接的关联。terminal 回调来自实际 Session Sidecar generation；目标重新获得当前授权的 route rebind ACK 后才发送私密 event。来源验证完整 peer/epoch/Session/message/watch 后投递原 Inbox，记录紧凑 settlement 再 ACK。ACK 不明不重复注入，不保存 outbox。真实断线、登出或身份改变丢弃关联；目标原执行继续。watch 绑定目标 adapter 的真实执行 queue ID，Task/Goal owner 可为空；同一 caller/设备 scope、目标和实际轮次合并成一个 canonical watchId。当前轮次完成只结算该轮观察，后续排队请求不会冒充它的结果。

本地 turn 完成入口先协调自动回传与同 caller/target/turn 观察，共享一次原 Inbox 投递 promise；失败不另行发送第二条通知。网络同一实际轮次的自动回传与观察在来源 `SourceReturns` 内按验证后的 peer/epoch、双方 Session、turnId、原 Inbox requestEventId 共享一次 Inbox 接纳结算；各 operation 仍保留自己的 event digest、receipt 与 ACK。关联不含结果正文，不按文字去重，不跨连接保存。不同请求/轮次/调用方独立。目标观察回传并行结算，单项超时不阻塞下一项。external/DSH Inbox 复用原 operation queue，入队即接纳，native dispatch 的独立 promise 在不可逆接纳时结算；启动空闲队列仍由原 queue owner 负责。

`session watches` 读取当前 caller 的全部活跃本地/网络观察；`session unwatch <watchId>` / 显式 `--all` 只取消观察，不停止执行、不取消默认自动回传、不撤回已进入 Inbox 的消息。网络观察由连接内 SourceReturns 管理，关闭原 route 触发目标精确清理；本地观察仍在目标原 registry，由 Rust 查当前 owner，不复制一套来源注册表。删除时只删除该 caller/Session/watch/reference，不能清空其它 watch。注册回执仍在途时也可取消已有 route；来源保留取消 context 到原 receipt TTL，仅用于验证并丢弃已在途事件。目标 route Context 释放时同时失效注册 job 的原 pre/post handoff guard，清理迟到注册。目标管理与精确清理入口 `/api/session-watch/manage`、`/api/session-watch/network-remove` 由 Session composition 登记并校验内部凭据；Global 不持有 watch registry。精确清理完成后，同轮重新观察可以创建新关联；取消回执不代表跨进程目标清理已原子完成。

`session state` 是按需只读投影：idle、running、waiting_user_action。SessionEngine 根据真实执行状态及阻塞 root 的工具/计划审批、必须回答的问题投影；非阻塞异步问题、普通文本问句及子 Agent 单独交互不证明整个 Session 等待。Rust 无 live owner 且原历史可见才读 idle，尚未就绪/不可观测则查询错误，不启动 Sidecar或模型。不提供远端批准、配置修改、中间状态推送或轮询。idle 不表示任务成功。

空闲 watch 优先原 live 结果，缺失再读目标原 SessionStore 的最近 assistant；回执包含 latest-session-result 范围与 live/history/none/unavailable 来源，历史保留自己的时间与已知 terminalStatus/turnId，不能沿用另一轮的终态或声称是某请求的回答。保留 partial/stopped/error 文本。V2 历史终态取原 transcriptTurns 的对应 turn.status；消息封口不能证明执行成功，transcriptRecovery unavailable 不能解释成没有回答。

跨设备内部 Agent 的初始请求沿原 `VerifiedCaller.label` 携带 `Agent名称@来源设备名称`；Rust 来源入口按当前账号/network/device scope 经原 metadata 控制面读取网络显示名称，包含用户昵称，并计入原调用 deadline / generation。目标 `start/send` 原 Inbox 和请求气泡直接使用这个展示标签。CLI 的参数与 transport 始终使用完整稳定 selector，名称仅参与展示。本地跨会话标签保持原格式，已有历史不改写。

Session label 继续表示会话标题/原摘要。来源回执和异步事件另含 Agent/设备 identity，显示为 `Agent @ device · Session label`，不拿 UUID 充当标题。`session list` 文本保留完整可复制的 Session selector。`agent network-diagnose --json` 按需列出协议能力、分页设备 appVersion 与原目录 connectionState（ready / syncing / offline），不从版本号或可发现性推断在线状态。错误记录阶段、代码、requestId，schema 日志只记录字段路径，不打印正文或配置；只有已发送的 start/send 可能接纳未知，读失败按查询错误重试。严格旧客户端会拒绝这些协议扩展（包括目录 icon），本次 dev 验收双方须升级同一固定包。

## 身份、加密与资源

### 设备身份与凭据

Rust App 在本机生成 P-256 身份密钥，以 ECDSA/SHA-256 签名证明持有私钥；桌面端私钥只持久化到系统凭据库（macOS Keychain、Windows Credential Manager、Linux Secret Service），使用时加载到 Rust 进程，不上传云端或交给 Renderer/Node。独立共享 crypto 包另提供显式选择的 headless 加密存储：仅从私有 systemd 凭据投影接收 KEK，动态私钥记录使用 AEAD 加密并受 scope 绑定、权限和持久化校验保护；没有桌面错误后的自动回退或明文降级。该后端尚未接入实际 headless 登记 owner，详见 [Headless 身份存储](./headless_identity_store.md)。当前网络的身份签发方（官方 Space / 自部署实例）验证包含公钥及签名的 CSR，签发设备 leaf 与 signed binding，将账号、设备、密钥代次绑定到证书指纹、SAN 和有效期。

外层是设备到云端的 HTTPS/WSS，接入以稳定设备公钥绑定的 DPoP 证明持有凭据对应的私钥。官方接入凭据不超过原 Space 登录剩余有效期与 30 天；自部署凭据由固定实例签发，客户端按协议最大有效期验证，不依赖 Space 登录。设备 leaf 有效 7 天，在到期前 48 小时窗口按需续签。活跃回程使用一项带 jitter 的约 6 小时检查，空闲不轮询凭据或证书。暂时签发不可用且现有 leaf 尚有效时保留当前关联，真实撤销与过期不能忽略。

### 独立账号的桌面凭据访问

`owned_account_desktop.rs` 在首次恢复时从 OS 凭据库读取并验证完整实例、设备、principal、连接、binding、CA 和有效期；浏览器登录完成后先写入 OS 凭据库，再发放进程内会话 guard。正常 actor 心跳与管理请求的 `ensure_current` 使用这个已验证 guard，不反复读取钥匙串；它仅保存 scope、binding、generation 和 expiry，不增加持久化 Token 副本或明文回退。

同一持久槽位的新登录提交会失效旧 guard；取消尚未完成的新登录不撤销此前仍有效的登录。精确 binding 删除、账号 active 失效、会话过期和服务器拒绝仍停止旧权限。恢复、登录写入及精确删除由模块内同步存储锁串行化，锁不跨网络 await。正常路径不轮询 Keychain，用户在应用外手工编辑凭据的检测边界是下次恢复；这不代替服务器的过期或撤销检查。

内部 MoXBots 试用包更新应复用固定代码签名证书。ad-hoc 签名把代码 hash 作为身份，每次新构建可能再次触发 Keychain 确认；固定 bundle identifier 和证书 designated requirement 可保留后续版本身份。签名私钥、专用构建钥匙串和随机构建密码只在本机私有目录，不进入 Git 或试用归档，不保存 Mac 登录密码、不修改全局凭据 ACL 或系统信任。旧 ad-hoc 包创建的凭据首次迁移仍可能需要一次用户系统确认；本地试用证书不等于 Developer ID 或 Apple 公证。

后台读取以同签名二进制的认证子进程执行，闭集 service/account/User-domain、匿名管道、有界结果及 5 秒期限，不请求系统 UI。真实授权错误保留固定码并停止普通重试，不把它当作条目不存在或自动生成新钥。显式“授权并恢复”仅针对已保存的 Owned 连接，整体最多 180 秒，可取消；验证会话全 scope 和服务器现有 key generation/fingerprint 后，在 registry revision、saved record、Actor generation 门禁内发布。它不执行登录、入网、密钥替换或配置写入。

恢复所得私钥仅由对应 Actor 的完整 scope 只读 store 持有；重连可再次加载它，store 拒绝写入与删除。关闭、取消、超时、账号/registry/generation 边界会阻止迟到结果发布，并保留持久记录。系统窗口仍可能要求用户处理旧签名 ACL；选择“允许一次”只能说明该次读取成功，不能承诺跨重启或更新免提示。只有真实重启/同签名更新复验才能关闭这项产品验收。

### 端到端通道与消息路径

端到端加密（E2EE）的端点是两台设备的 Rust App。内层由 `rustls` 的 `ring` provider 实现标准 TLS 1.3 双向证书认证，验证证书链、有效期及双方当前网络签发的 signed binding、SAN 与 fingerprint；禁用 0-RTT 和会话恢复。

长期身份私钥用于签名认证；每条内层连接另以临时 ECDHE 协商共同秘密，经 HKDF（SHA-256/SHA-384）派生两个方向的通信密钥。当前默认密钥交换组优先 X25519，也支持 P-256/P-384；正文以协商出的 AES-256-GCM、AES-128-GCM 或 ChaCha20-Poly1305 加密并校验完整性。临时秘密和通信密钥安全销毁后，长期身份私钥的事后泄露不能解密此前记录的通信（前向保密）。

1. 来源解析目标目录，云端安排设备间通道；双方验证签名身份并通过中转完成内层 TLS 握手。随后在加密通道内交换 `ChannelHello`，核对双方设备 scope、channel ID 与 connection epoch；业务对象还检查递增序号，通过后才接收业务消息。
2. 来源 Node 将调用交给本机 Rust；Rust 将完整 invocation 编码后交给 TLS 加密，再把 TLS chunks 加上 channel ID，封装为外层 WSS 二进制帧。云端终止外层 WSS 后，业务载荷仍是内层密文；Worker 仅按通道和流控预算转发，不终止内层 TLS 或持有其通信密钥。
3. 目标 Rust 校验、解密并解析业务对象，按上文“调用与回程”完成当前 permit/本机 owner 检查，再交给原执行或读取入口。解密成功不等于获得执行许可。response、event/history 按同一路径反向加密传递，Node/Runtime 在各自本机交接处处理明文。

设备目录、设置和有界路由元数据不要求 E2EE，云端可见设备/通道关系及流量大小、时间；完整 invocation、response、event/history 才属于内层加密范围。Worker 不组装或保存业务正文、密文和离线消息。该保护覆盖设备间传输，不代替端点本机存储或端点调用模型 Provider 时的安全边界。

官方设备身份信任 Space；自部署身份信任加入时固定的实例证书与签名体系。签发密钥不能直接解密既有通信，但签发体系若被控制，可通过伪造设备身份攻击后续连接；当前没有独立于网络签发方的人工对端指纹确认。实现入口见 [identity.rs](../../src-tauri/src/agent_network/identity.rs)、[crypto.rs](../../src-tauri/src/agent_network/crypto.rs)、[channel.rs](../../src-tauri/src/agent_network/channel.rs)。

### 协议与资源

闭合 schema、限定 selector 和预算由中立协议包定义；当前源码位置、跨仓库分发与已约定的后续调整见下文“公共协议与仓库分发”。

Resolve 响应先经固定包的 `metadata-callableAgent` schema 校验，再由 Rust `CallableAgent` 严格解析；两层都接受可选、可空的图标名称，缺省兼容旧响应。图标不参与 peer identity 或调用授权。调用测试使用真实 JSON 依次经过这两层再交给 `Calls::resolved`，避免只构造 Rust struct 而漏掉协议字段与接收类型的漂移；未知字段和非法图标类型/长度仍被拒绝。

`memory.rs::MemoryBudget` 是 App 级非阻塞字节分配，覆盖准备/排队的请求与回调、并行 owner 读取、未消费 Work 结果、TLS 编码、组装和解码。分配随实际字节增长，RAII 随取消、失败和 owner 交接释放；不能给每个小读取预占最大历史页。流控 credit 与业务接纳是不同事实。紧凑去重不保留读取正文，容量拒绝属于当前请求，不应断开其它 Agent 的正常连接。协议逻辑预算不能代替真实进程 RSS/平台缓冲容量测试。

## 目录、@ 与 query 生命周期

Renderer 只合并同一账号/连接投影 revision 下完全相同的在途目录 read；完成或失败立即释放，不缓存结果。新的 snapshot revision、账号 generation、连接状态和 mutation 会隔离旧请求；各调用者保留独立的数据投影，原分页、刷新和错误展示行为不变。

`discoverAgents/getAgentDiscovery` 复用本地身份 owner，合并 Rust 当前网络目录。CLI 保留原本地完整 registry；紧凑 @ projection 有明确预算/完整性状态。只有同设备、同 localAgentId 的网络 alias 才能与本地项折叠。目录与引用不授予执行许可。

@ 空关键词只查询/展示 Agent、想法，有关键词后按 Agent→想法→文件拼接，一个滚动/键盘导航区域；每组默认五项，展开更多每次最多增加五项，visibleCount 与 owner 页缓存分离。面板宽度 25.5rem，并限制在 viewport 留白内；展开/收起控制行居中。面板固定目标高度，加载/搜索/展开不随结果条数缩放，shared Popover size 只按 anchor 可用空间约束；composer 保留顶部栏空间。本机图标沿 ConfigData 的现有工作区身份投影；远端目录只同步拥有设备 Project 的 `icon` 字符串，复用 `WorkspaceIcon` 渲染，缺失或本机不支持的图标名称使用机器人图标，兼容旧目录和旧 @ 快照。图标只属于展示，不改变 exposure revision 或执行权限；想法日期/标签/摘要只占一行。想法沿原 ManagedRecordStore text Record projection；文件沿原 WorkspaceFileService/Rust walk。stateless cursor 绑定 scope/query/snapshot；hasMore 与 scanLimitReached 区分，通用扫描截断提示不在面板展示，但保留 partial 事实；超预算或目录不可用不得假报全部/空，网络不完整与失败提示仍保留。

首屏 Agent、想法、文件并行查询，共用一个 loading；全部完成后一次展示，最多等待 2 秒（非空搜索另有 150ms debounce）。Agent 先读取带当前账号 context 的 local-only projection，再查询云端，保证云端慢时仍能展示本机项。到期保留已取得的数据，未完成来源明确标记不完整/失败并允许主动重试；迟到首屏结果失效，不再插入当前列表。网络 presence/catalog revision 不自动刷新打开中的面板，重新打开或主动重试获取新目录；账号、工作区或关键词改变仍使旧请求失效。展开分页和主动重试仅在所属组加载。

正文保留完整 `@Agent-id:selector`。快照只含 discovery 数据与账号 generation，提交时由 SessionEngine facade 重新查同一业务目录。未知/旧账号引用保留普通正文并给重新选择提示；不猜同名对象。`composeQueryReminder` 把 AgentInfo 与固定 instruction 放入一个 leading envelope，保留 Goal/任务讨论/悬浮球 primary context；名称/description 只能作为 escaped untrusted data。

原 SessionMessage 的 `desktopQuery` 保存可见正文与结构化上下文，builtin/external codec、queue、retry 共用它。重试重新查目录，不从任意用户 XML 反推可信上下文。Launcher、失败恢复、取消排队和跨 Runtime fork 保存相同快照；发送等待期间已开始的下一份草稿不能被清空。展示/搜索/队列预览继续使用原 reminder visibility helpers。

## 公共协议与仓库分发

协议包 `@myagents/agent-network-protocol` 是 TypeScript 契约、引用编码、传输封装和资源预算的共同定义，生成的 JSON Schema 与 fixtures 供 Rust 校验使用。协议版本独立于客户端和服务端产品版本；它不包含 Cloudflare Worker、账号签发或 Agent 执行实现。

### 源码与消费入口

- 唯一可编辑源码 authority 是 `MyAgents-Agenthub/packages/agent-network-protocol/`。客户端没有该源码目录；协议更改必须回到 Agenthub，再更新固定产物，不能手工修改包内 Schema。
- 客户端提交 `vendor/agent-network-protocol/manifest.json` 和带摘要前缀的 `.tgz`；根依赖及锁文件固定引用此文件。清单记录包版本、SHA-256、源码 authority、许可及来源服务端提交。客户端产品版本不等于协议包版本。
- `scripts/verify-agent-network-protocol.mjs` 在安装后、类型检查、Web/Node bundle 构建前检查摘要和依赖/锁文件指向。损坏或错配直接失败，修复所提交的产物或引用，不从服务端下载源码回退。
- Rust 的 `src-tauri/agent-network-protocol/` 是本机类型/codec 适配层；其 `build.rs` 独立校验同一压缩包，将其中平面 JSON Schema 与 fixtures 写到 `OUT_DIR`，不需要 Node、私有仓库权限或已安装 npm 包。产物改变时 Cargo 重新生成，并清理旧投影避免缺失文件被旧缓存掩盖。Rust 类型与 TS 契约通过包内 fixtures 校验，不另写 JSON Schema。
- Agenthub 源码仓库在 `protocol:source` 中生成临时 npm pack 核对源码与所提交的包完全一致。固定产物是单一源码的分发结果，不是另一份可独立维护的契约。

### 更新流程

1. 在 Agenthub 修改源码、生成 Schema、完成类型/fixture 检查，打包并更新该仓库的产物、来源清单和依赖/锁文件；完成检查、审查并提交。
2. 从已提交的 Agenthub 来源导入同一包到客户端 `vendor/agent-network-protocol/`，记录对应服务端源码提交，更新根依赖与锁文件；不修改包内定义或提交构建投影目录。
3. 运行客户端产物校验、TS/Rust parity、受影响业务测试和构建，并运行服务端 source/artifact 校验。根据真实协议兼容责任决定部署顺序，不随客户端版本机械升级、不自动重发不确定调用。

具体打包、tag 发布与显式导入命令由 Agenthub 的 `specs/RELEASE.md` 维护（`npm run release:import -- --target ../MyAgents --release v<version>`）；普通构建不执行跨仓库打包或拉取源码。包随公开客户端提交，使新的贡献者无需私有 AgentNet 权限即可构建。源码迁移不代表自部署认证、多网络 UI 或完整产品验收已经完成。

## Dev 环境

客户端沿现有开发者设置选择 Space dev；`build.rs` 注入对应公开 AgentNet service ID，release 不携带可切换的 dev origin。服务端先部署 Space dev additive API/issuer/named `AgentNetworkEntrypoint`，再部署 AgentNet dev，最后验证客户端 dev 构建。记录 exact Git SHA、Worker Version ID 与 100% traffic；产品完成仍需 PRD/RFC 的完整矩阵。

设备详情的 `lastNetworkSeenAt` 来自网络 DO 的 ready/连接关闭与 Hibernation auto-response 在线事实，不能用账号 roster 的 `lastAccountSeenAt` 代替。Project 的 `agentNetworkExposureRevision` 由原归档配置入口持久化，UI/CLI 共用 `nextAgentNetworkExposureRevision`；unarchive 保留该代次。catalog `exposureRevision` 比旧代次增加时原 DO 事务关闭 mount，解决离线 archive→unarchive 被最终 snapshot 合并的问题；rename 不增加代次，简介仍由网络设置 owner 保留。

同 pair 连续完整对象在原 rustls writer 中有序写入，受 `receiveBytes` 和 App `MemoryBudget` 限制；信用窗口只控制 TLS 帧发出，不能把正常第二对象视为连接故障。终止性 pair 写入/加密错误只关闭该 pair，清理它的 pending 调用，保留其他 pair/有效逻辑回程；没有另建执行队列或断线重发。

### Metadata failure outcomes

Rust 原 connector 拥有连续连接失败退避：首次恢复仍为 5 秒，连续失败按 10/20/40/60 秒基线与最多 20% jitter 限速；成功 ready、账号/电源 boundary 重置。有效 429/503 `Retry-After`（秒或 HTTP date，最多一小时）仅作为后台重连等待下限，不改变业务读写的错误投影、不保存/重放请求。boundary 继续立即打断等待；Space IssueDelivery 的 60/180/300 秒轮询不变。

Metadata reads and connection snapshots do not assert a user save. After metadata queue handoff, timeout or a dropped connection future yields uncertain outcome only for metadata mutations; receipt inspection remains read-only and no write is replayed. Actual auth-generation changes fence discarded account scope; transport or power-generation changes alone are not evidence of account change. The existing actor reconnect loop owns recovery; Renderer describes that state and keeps its read retry separate from write receipt recovery.


### 公钥缓存与网络诊断

`AccountVerifier` 的克隆共享当前 identity 生命周期内的公钥及刷新时间；同一轮成功刷新合并并发等待，失败或取消不替换旧公钥。服务环境/账号实例不跨 scope 复用；验证在等待前后均检查 account binding，缓存不代替实时账号 authority。

Rust 外部 HTTP owner 通过 `network_diagnostics::RequestDiagnostic` 记录阶段、粗粒度错误分类、HTTP status、耗时及安全 requestId；路由动态段和查询参数脱敏，不记录凭据、正文或 reqwest 原始错误。AgentNet connector 和通知同步 loop 在原退避 owner 内汇总连续失败、持续时间、下一次等待与恢复。空白或非 JSON 的 HTTP 429/5xx 保留真实状态和可重试语义，成功响应的格式/schema 错误仍按响应无效处理；`Retry-After` 只影响后台重连，不自动重放业务请求。

### 持久目录失效通知

工作区目录的 authority 是 `projects.json` 与 `config.json` 的既有身份 registry；Renderer 快照不作为上传内容。Renderer 的 `notifyConfigChanged` 除无配置载荷的 DOM 通知外，向既有 native `app:config-changed` fanout；Sidecar 的 `broadcastAppConfigChanged` 同时广播 SSE 并调用既有 Management API。SSE bridge 只刷新窗口，不反向重复发布 native 通知。网络 actor 复用既有 `Notify` 后重新读取 registry，离线时由下次连接重建目录，无新增轮询。

Project 保存仅在目录字段（身份、名称、图标、路径、可见性、归档状态、exposure revision）变化时通知；打开工作区/排序/模型偏好不会产生目录上传。Agent/Project 复合写入复用 `notification: 'deferred'`，最终两份磁盘状态提交后统一发布。已持久化写入不能因通知失败被报告为回滚；通知错误保留明确日志，已有重连继续从磁盘恢复。

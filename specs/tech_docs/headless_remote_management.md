# Linux Host 远程管理接续（MAH-REMOTE-MANAGEMENT-20261012）

目标：用户从桌面 AgentNet 为已入网 Linux Host 配置模型、只写凭据、创建持久 Agent，无需手工 SSH。基础入网已真实验收；本阶段不能把本地 owner、UI fixture 或在线设备登记称为远程管理完成。

## 当前接续：独立登录与管理收发（2026-10-13）

### 本轮真实验收与修复（2026-10-13）

- [x] MAH-DESKTOP-MANAGEMENT-20261013 真实桌面账号登录和重启后在线恢复已通过；原 MyAgents 并行运行保全。此项不代表 Linux Host 已授权或管理表单验收。
- [x] 实际安装暴露并修复两处公有 CA 问题：证书不能放在 root-only 私密目录，Rust 公开证书校验不能禁止 group/other read。安全同版本迁移、状态查询失败拒绝、故障回滚等 installer/control 30 项与 connector 118 项检查通过；新 Linux CI 制品源 `710820e9` 与 `cadfa520` tree 相同，真实 `owned-auth-start` 成功。原密钥/身份/Node PID/MyAgents 和公网监听保全。
- [ ] Host 用户浏览器授权尚未完成，首次请求已过期；待用户准备好后重新发起，不能拿 native QA 的两个临时身份替代实际已安装 Host。
- [ ] 用户新增授权独立认证、AgentNet 与云 Host 的新服务器部署（MAH-CLOUD-20261013）。当前连接/已有服务基线已核查，独立 DNS/HTTPS 入口待确认，尚未发布公共服务；具体连接与凭据留在私有执行记录。

- [x] 完整已打包 MoX Host 运行时的真实远程管理联合验收通过（run `20261012225449`）：直接运行 root 管理的不可变 release 中 Node24、`host-main.mjs`、worker 和固定 SDK 资源，保持独立 QA HOME/state。实际两个 PKCE 登录/明确入网、签名 TLS/Pairs、Node IPC、模型配置/合成加密凭据/禁用 Agent、两阶段 doctor、进程重启后三类原回执、12 次额外身份恢复、幂等/CAS/原目标 scope fence 全部通过。旧自制管理 bundle 不作为本轮运行程序。真实已安装 MoX 状态未改、owned 网络仍 inactive；原 MyAgents 与 MoX 四 unit/PID/current/配置与凭据摘要/组和公网监听完整保全，运行时完整树前后摘要一致。临时 operator/服务/容器/回环监听均清理；0 模型调用、未接受桌面表单或 SDK 模型执行。私有证据 `linux-host-qa/management-full-runtime-50f3722c/PROVENANCE.json`。网络/服务保留各自 `191b3e7b` 来源，完整 Host 保留 `b98294c7` 来源；对应运行源码至当前提交无修改，未改写制品 metadata。`36b2ee4c` 完整六项 Test CI38317715747 与 owned 服务 CI38317715760 均已成功。
- [x] 工作分支 `91aca8b1` 的完整 Test 六项与 owned 服务 CI 成功（38312452871 / 38312452856）；91 制品源为 PR merge `191b3e7bc2932c09698905abeaa6c1401a0e5b89`，tree 与 `91aca8b1` 相同。`76ce62dc` 前序 CI 同样通过，旧制品源 `e50a74648f0d7cf8709f95ccdae4df8f72f998a9` 对应其旧 tree。完整 Linux Host、网络和服务制品均按各自来源核验，不改写 source-commit。
- [x] 101.42.11.29 隔离联合环境中，实际两个网络客户端完成 PKCE、加密持久化与明确入网；生产 Controller 经签名 TLS/Pairs 和真实 Node Unix IPC 获得 snapshot，保存模型配置、合成测试凭据与禁用 Agent；真实进程重启后 snapshot、配置回执与凭据回执均读回。模型调用为 0，尚不证明模型执行。
- [x] 资源原回执故障已修复并在真机复验：owned 身份恢复仅走正常 consumed PoP，静态 enrollment 撤销预探针只适用于 legacy Selfhost。三轮旧失败及 source 8 个未消费挑战证据保留，服务端上限未改。主集成 headless 118 项、定向 owner/identity、clippy 和独立源码审阅通过。新制品源 `191b3e7bc2932c09698905abeaa6c1401a0e5b89` 与 `91aca8b1` tree 相同；真 Linux run `20261012215305` 完成三类原回执、真实重启、额外 12 次生产身份恢复、幂等/CAS/原目标 scope fence，全程 0 模型调用。此项证明原生 Controller 联调，不证明桌面表单或 SDK 模型执行。
- [x] 首次 snapshot 的 Ready 循环依赖已修复并在真 Linux 联调通过：同设备、当前 live epoch、joined、Syncing/Ready 绑定的只读保全 GET 检查持久 catalog 和全部 lifecycle；只有明确空才上传新空目录。原 SelfPolicy/公共目录权限保持。主集成 117 项 headless、9 项真实 DPoP HTTP 检查与独立审阅通过。
- [x] 统一安装新增封闭 `myagents-test` / `moxbot-test` profile：MoX 使用独立固定账户、units、HOME/state、身份 pin、credentials、CA 和 IPC；build/manifest/bootstrap/installer 配对检查，旧无 profile 包仅兼容原 MyAgents 根。共享事务锁不变，无任意 prefix 覆盖。Node24 25、network 24、unified 9 项测试及独立分面终审通过；主集成 Node24 25 项无 skip。已完成干净制品的真实 systemd 安装、失败回滚、同包重试、身份 pin 修复及重复安装，原两服务状态完整保全（后续本轮证据见下）。MoX Host 内部 `.myagents` 位于独立 service HOME，不共享桌面或原 Host 数据。
- [x] `9c6a815f` 六项 Test CI（38313991914）与 owned 服务 CI（38313991910）全部通过；原生 network/完整 MoX Host 制品来源 `b98294c7244c072fba9d45d83330c8f7be5680bd`，tree 与 `9c6a815f` 相同。真实服务器只读预检发现 systemctl 属性实际顺序为 LoadState/ActiveState/UnitFileState，旧位置解析会拒绝安装。已改严格属性名解析，补足新 unit 回滚前 disable，允许完整核验后复用同包 orphan release；独立源码审阅通过。真机失败回滚、同包重试与幂等验收仍待执行。
- [x] `94af2a36` 新网络制品 `9bca98773fccb73f2a6b818aebdff2cf90c90b1b` tree 与工作分支匹配；与独立核验的完整 `b98294c7` MoX Host 包在测试服务器完成真实 marker 冲突后的 Node rollback（unit/current/Wants 均恢复不存在），随后同包重试成功、实际 Node24/SDK 存在及 encrypted provider credential 已加载。原两服务 PID/current/配置/凭据摘要/组与公网监听未变；新 MoX Node active，owned 网络 inactive，未登录/入网或调用模型。真实 repeat 拒绝揭示 `read_device_pin` 默认参数仍绑定原 MyAgents 路径；已改调用时取当前 profile pin 并加两个不同 pin 的切换回归。当时 repeat 待新制品复验，后续结果见下一项。证据目录 `linux-host-qa/unified-moxbot-9c6a815f`。
- [x] `50f3722c` 干净网络 CI 制品 `33cebe63d17bb4af076ad063eeba5cce6ad2529e` tree 与提交一致，五项摘要与四安装脚本逐字核验。在真实 MoX 已安装状态下 repair 和同 release repeat 均成功：Host identity、根管理 pin、Node PID、provider/network 加密凭据、owned CA/config 保持一致；原两服务及公网监听仍未变。新 MoX Node active/owned network inactive，无隐式登录或入网、0 模型调用。证据 `linux-host-qa/unified-moxbot-pin-fix-50f3722c/PROVENANCE.json`。完整桌面与 SDK 模型执行未验收；完整六项 Test CI 38316589447 和 owned 服务 CI 38316589433 均已成功。新版桌面包原生构建、19 类精确资源、ZIP CRC/解压与 ad-hoc 严格签名均成功，来源 `50f3722c`。
- [x] 已交付 `MoX-bot-Trial-macos-arm64-76ce62dc.zip`，独立应用身份 `com.moxbot.app`、数据目录 `~/.moxbot`，含 Space 构建配置，19 类资源和包摘要核验通过；原 MyAgents 及旧试用包保留。Apple Silicon 内部包，ad-hoc 签名、未公证。
- [x] 用户解锁并即时授权运行后，`50f3722c` 新 MoX bot 包真实启动，实际进程路径与二进制摘要一致；原 MyAgents 进程、设备身份、锁和端口保留。通过实际设置启用多网络，账号登录表单成功向独立服务创建 PKCE 请求。
- [ ] 实际浏览器登录待用户接管：隔离环境仅监听回环，通过 SSH 隧道访问；桌面显式 CA 连接成功，但内置浏览器拒绝私有测试 CA。没有绕过警告或安装全局信任。已验证临时服务的实际清理操作及原四服务/公网监听保全，再恢复该隔离服务并设置 30 分钟自动清理。真实认证、桌面管理表单与已安装 MoX Host 入网尚未验收。`1525dc37` 七项 CI 成功；PR #14 保持 draft，main 尚未包含本轮管理变更。

前序完整运行时验收的隔离单元、容器、回环监听与配置回滚检查通过；本次桌面登录隔离服务恢复运行，设有自动清理期限，尚待最终清理。原 Host 服务保全，未增加公网监听。失败证据保留，不能以已通过的部分路径替代完整桌面验收。


此前的官方接口核查和服务端仓库权限记录保留为历史证据。当前实际实现位于用户 fork `heavenzhang/MyAgents`，独立服务源码为 `services/agentnet`，不再以获取作者服务端源码作为实现前置。

- [x] 独立登录服务、OIDC/PKCE、身份签发、设备注册、网络 membership 和不解密设备间 TLS 的 relay 已实现；前序服务协议与真实 Linux 回环中转验收通过，已在 fork main 交付。
- [x] 桌面独立浏览器登录与系统 keyring、无桌面 systemd 加密凭据与独立 instance pin 已实现；官方账号保持独立。PR #13 最新七项 CI 已通过；真实 Linux PKCE、加密持久化、明确入网 Ready、重启无新 join grant 和 logout guard 失效已通过。已合入 fork main `e344dac8febabdfa64ad41e35870e85fdf532ff8`，tree 与真实测试制品源完全相同；原生桌面登录仍未验收。
- [x] 第一轮真实 Linux 客户端验证了 PKCE 登录和加密持久化，随后发现 `deviceName`/`osVersion` 为 null 时身份签发被拒绝。服务修复允许原客户端的可选值，同时保留必需 platform/appVersion 和封闭字段检查；服务 58 项测试及 clippy 通过，最新提交 `80b822da` 已推送。
- [x] 第三轮真实 Host 的明确入网、Hello/catalog/policy Ready、无新 join grant 的进程重启恢复，以及 logout 让运行中 guard 失效通过。第二轮发现 pre-Ready hydration 请求 Ready-only public catalog 的循环依赖；owned 客户端现沿已有同设备受限 self-policy 路径恢复。前两次失败原证据保留，不计作通过。
- [x] `Pairs` 显式管理模式和管理消息收发已实现，管理角色与 canonical TLS 发起方分离，复用原设备 scope、证书、epoch、序列、信用和内存约束。库内回归与独立审查完成；本轮管理通道工作分支的 CI 与主干交付仍待完成。
- [ ] 实际 Desktop controller / Headless Host actor 与 Node 专用窄管理 IPC 正在工作分支集成；设备寻址 endpoint 已实现并完成三项认证/Ready/撤销回归。寻址仅是当前 snapshot，不授予管理写权限。随后将模型配置、只写凭据和资源 owner 接到真实桌面表单。当前生产 adapter 仍明确 unavailable，不能把以上基础收发能力称为完整远程管理。

### 设备管理通道接线（工作分支，未发布）

任务 ID 沿用 `MAH-REMOTE-MANAGEMENT-20261012`；目标与真实桌面验收标准不变。

- [x] 独立服务的认证设备寻址、双端 Ready/当前 session/撤销门禁，零 Agent 设备无需虚构目录对象。
- [x] 桌面 Tauri `cmd_agent_network_management`、owned Controller、实际目标签名地址与 Offer/Accepted/TLS 校验；固定五方法：`host.snapshot`、`config.set`、`credential.set`、`resources.create`、`receipt.get`。
- [x] Host 显式启用的 reverse Unix IPC，真实 peer UID；原本地 control socket 保持 0600。管理 grant 加密绑定本地设备、服务、环境、网络、主体与登录 binding，服务/网络变化也命中同一 grant 而拒绝隐式继承。
- [x] Node 全局有界串行管理队列、断线重连、旧响应隔离、未知写入和原回执查询；真实资源 owner 的受限 root/revision/Agent inspection 已接 snapshot wire。
- [x] 主集成定向检查：109 项 headless 测试，Node IPC/资源检查 20 项通过、9 项 Linux-only 尚待 CI；TypeScript 与定向 lint 通过。独立审查发现 sent 边界把本地拒绝误报未知写，已修并用真实 Pairs 预算故障回归验证。
- [ ] 本轮完整 CI、Linux flock/资源测试、干净源码制品和主干交付。
- [ ] 真 Linux 两个 owned 设备经服务/真实签名 TLS/Node IPC 保存配置和创建禁用 Agent，读取回执及进程重启恢复；尚无该联合验收。
- [x] AES-256-GCM 动态模型凭据 owner、加密 CAS/回执账本、只写 `credential.set` 和无秘密的 snapshot；专用 Unix IPC 接真实 owner。初始化仅限主进程本次新建的私有目录，密文丢失或损坏拒绝重置。会话 generation 一次性握手接收所需模型凭据，主进程不向子进程环境转交 systemd master-key 目录；普通 config 仅保存引用，活动 worker 使用出生时的内存快照。
- [x] Node installer 首次生成并保留 root 专有的 systemd 加密 `provider-key`，不会把模型密钥放入安装命令或环境；本地仅验证脚本与 dry-run，真实 Linux systemd 投影和回滚尚待验收。
- [x] 自部署账号的真实 Renderer→Rust 管理入口与模型/只写密钥/Agent 表单接线；只读取 Host snapshot/回执/registry，不生成虚假环境或运行生效投影。官方与旧 key 连接仍沿不支持的 legacy adapter，Rust 会拒绝不属于 owned-account 的管理。
- [ ] 上述表单的真实桌面→Linux Host 联调、实际渲染与键盘验收；本地 DOM 检查不能代替该门禁。
- [ ] 一键安装包统一 Node Host 与网络 owner 的服务配置，以及真实桌面远程模型配置/Agent 创建验收。本轮 CI 会输出可信源码来源的 Linux Node Host 包，但不代表安装器已经完成统一。

补充原生验收入口：`myagents-host-network owned-manage` 复用生产 Controller、实际 owned account binding、签名设备寻址与 Pairs；必须使用已经入网且当前空 catalog 的独立源设备，不隐式 join。请求从调用者所有的 0600、单链接、有界私有文件读取，所有写操作绑定前次真实 targetScope；它只输出固定响应，调用方在 finally 清除含凭据请求文件。本地新增 4 项及 Controller 11 项通过，独立只读审阅未发现可复现 P1/P2；Linux/TLS/Node IPC 联合验收仍未通过。

接线约束：owned TLS profile 只发布空 catalog，不上传本地 Agent 目录或发送 Agent RPC/permit；管理应用使用独立 codec 和固定 Controller/Host 角色。Relay 的 ChannelReady 分支必须立即 drain 排队的管理 Ready 事件，不能等待下一帧。身份/网络/账户代次变化后关闭通道及待办；发送或写后记账失败关闭受影响 pair、报告原始 failure，不自动重复写入。模型凭据继续经产品能力配置，本阶段不获取密钥或调用收费模型。

本阶段追加验证：111 项 headless Rust、协议 11 项单测与 6 项既有 codec 集成、Node 21 项 owner/IPC/真实 Session bootstrap 检查通过；没有收费模型调用。原 CI 捕获 IPC `/tmp` 父目录权限与 subprocess 测试分类缺口，已保留生产校验修复。随后 Linux CI 捕获本地 Host 测试缺少发布 bundle 的 CJS bridge，以及嵌套工作区缺失父目录；前者已对齐真实构建，后者沿原 root directory-fd authority 逐层创建、fsync 并保留独占叶目录与原意图恢复。主审另发现 Linux 凭据目录的 `/proc/self/fd` 最终链接不能以 `O_NOFOLLOW` 重开；现直接校验并 fsync 原 pinned fd，保留写后未知结果和原回执恢复的故障回归。本地 21 项相关集成、类型检查和定向 lint 再次通过。`8fad3268` 的独立服务 Linux CI 已成功，JavaScript CI 两项故障由本轮修复；新源码完整 Linux CI 与原生联合验收仍是开放门禁。

测试部署仅使用已授权服务器的回环监听、隔离配置和唯一临时 unit/container。保留原两个 Host 服务和已有公网监听；部署前记录制品源码/摘要和原状态备份。原生桌面界面、远程配置业务、真实模型执行和正式生产发布分别保持独立验收项。

本轮桌面接线主审：Controller 首次 inspection 发现签名目标，所有后续写入/原回执查询必须携带完整 `targetScope`；发现目标后、发送前和 TLS Ready 后分别校验身份/地址。定向 Rust 11 项通过。独立源码审查发现目标变化保留未提交密钥、坏回执假成功和旧 scope unknown 锁住新 Host 三项，已修复并由原审查者复核：刷新完整 scope 时清空密钥；原回执按完整 scope 隔离；owner 对应回执 schema 拒绝异常状态/额外秘密字段。API/DOM 10 项回归、类型检查、定向 lint 通过，尚无真实桌面验收。

`77e0377b` 已在 101.42.11.29 的 ubuntu 私有 scratch 实跑凭据 owner 的显式初始化、加密/fsync 写入、CAS/幂等、owner 重建、写后 IO 故障原回执恢复和密文丢失拒绝重置六项；没有 systemd/网络/桌面联合验收，也没有模型调用。该 head 的服务 CI 成功，完整客户端 CI 914 项集成通过、1 项旧“缺少父目录应失败”预期冲突；本轮支持 nested workspace，故该负例改为拒绝可写 intermediate，保留正向逐层创建和独占叶目录回归，等待新 Linux CI。

## 最新核查：设备通道（MAH-CLIENT-HOST-MGMT-20261012）

用户要求优先核实仅修改桌面与 Linux Host 的方案。此前将“固定协议没有 Host 管理方法”直接推导为“必须改官方服务端”过强，已撤回；下方旧方案中的服务端 grant 是待确认设计，不是已证实的服务端前置。

源码核查基线为 fork main `1d2c806e2700cd70804a1174f27b6ec23acdca68`（PR #6）。本地资源 owner 已完成主干交付和完整 CI；远程模型、凭据及 Agent 创建仍未接通。

- 现有 `channel.open` 只指定目标 device、key generation、connection epoch 和可空 binding，没有 mount ID。`Pairs::Offer` 验证同 service/environment/network/principal、双方签名 binding、证书及 epoch；Agent permit 属于后续执行准入。
- 现有 `/v1/ws` 中转 TLS 帧。终端 `ObjectDecoder`/`BusinessObject` 的封闭消息校验不能证明服务端会拒绝新的加密应用对象；它证明两端需要新增独立、有界的应用 codec 和 dispatch。保持固定 vendor 1.1.0 字节不变，不以 Agent invoke、设备改名或虚构 mount 传递配置。
- 现有无桌面 connector 对 `ChannelOffer` 返回 `TARGET_UNAVAILABLE`。这属于客户端实现缺口，不是官方服务拒绝设备通道的证据。
- `/v1/devices` 不提供 `keyGeneration`；`catalogEpoch` 与当前连接 epoch 的对应关系须实测。当前 callable 目录提供 generation/epoch/binding，探针可以只读这些寻址数据，不执行 Agent；零 Agent 目标不能因此被假报可寻址，也不猜 generation。

### 核查完成标准

- [x] 区分设备通道与 Agent permit，独立复核原发送、入站、加密和固定 schema 的边界。
- [x] 撤回“必须访问或修改三个服务仓库”的前置假设。
- [ ] 显式受限探针：沿原身份 owner 与独占运行锁建立临时连接，发送现有合法 device Open/Accept/TLS/ChannelHello/Ready，限时后 Close；不执行 Agent，不写模型配置或凭据。
- [ ] 实测官方 relay 是否接纳含零 Agent Host 的设备 pair；记录拒绝发生在哪一层及实际错误码。
- [ ] 通道通过后裁决独立管理应用协议、Host 本地管理员 admission、能力协商与 Node 窄 IPC；管理权限不由“在线”或目录自动推出。
- [ ] 两端配置及持久化真实联调、主干交付、测试制品部署、实际桌面入口验收。

原生探针仅证明传输和身份路径，不能作为远程配置上线证据。若实际 relay 阻断，只请求最小已证实缺口：设备寻址描述、设备 channel admission 或加密帧转发中的具体一项；不会先要求账号服务理解模型密钥或全部管理方法。

### 自部署范围扩展（MAH-SELFHOST-SERVICE-20261012）

用户进一步授权：若不能取得服务端源码，在自己的 fork 中补齐完整可部署服务，包括登录认证。当前精确仓库访问返回 404，作者公开仓库列表与 GitHub repository search 未找到上述三个仓库，公开网页检索没有找到可用源码；这是当前可获取性记录，不断言仓库不存在或代码从未公开。

新增服务覆盖独立账号认证、设备注册/撤销、身份签发、设备目录/零 Agent 寻址、网络权限、加密中转和远程管理所需控制；不以整个 Space 市场/Issue 系统作为前置。采用成熟身份组件/密码和签名库，不导入官方账号 Token。官方网络与自部署账号/连接保持独立。

已有 selfhost descriptor/enrollment-key 路径可复用；它包含静态 principal，尚不能作为完整多用户登录。登录后的主体、信任 pin、权限和凭据生命周期须显式建立，而非关闭原 TLS/DPoP/mTLS 校验。实现自部署代码、可重复部署、模拟协议测试、真实两设备认证/持久化与桌面配置验收分别记录。

- [x] 原有 selfhost 接口、账号签发/JWT/DPoP/PoP 契约只读核对；创建独立服务工作分支 `feat/mah-selfhost-service`，基线与 probe 同为 main `1d2c806e`。
- [ ] 服务架构及接口/持久化 owner 决策，独立认证和实例初始化。
- [ ] 服务端身份、metadata、relay、管理能力与部署包实现。
- [ ] 桌面/Host 自部署登录、网络和管理适配。
- [ ] 相称 CI、主干交付、受限原生部署和完整真实路径验收。

现有官方设备通道探针仍继续，它可以缩小兼容实现和中转要求；不会把“找不到作者源码”当成停止所有开发的理由。

## 原阶段来源与范围（历史设计，受上方核查更新）

fork main 基线 `92fa2c5f24faa026f81ed6567a9bb6211f1bb144`。固定协议仍是 1.1.0，唯一源码 authority 为 `hAcKlyc/MyAgents-Agenthub/packages/agent-network-protocol`。公开 MyAgents 是客户端源码；官方组合属于 MyAgents_AgentNet，账号/grant属于 MyAgents_space。当前授权 GitHub 身份对这三个服务端仓库均不可访问，官方测试部署入口未知。用户已收到所需服务端访问问题，客户端和本地 owner 的独立准备继续推进。

现有 business RPC 只有 Agent 查询与 Session 方法，现有 metadata 只管理入退网、改名、mount 与网络回执。不能把它们改成 Host 管理隧道，不能手改 vendored protocol。桌面正式 HostManagement adapter 在协商、权限和真实 owner 接通前继续明确不可用。

## 本阶段完成标准

- [ ] 正式 authority 发布设备级管理契约及能力协商；原1.1客户端兼容且不暗发新请求。
- [ ] 官方测试服务实现目标设备的当前身份、管理权限与短时操作授权；中转不能读取凭据。
- [ ] Host配置沿原configuration owner，凭据进入专用安全存储；凭据不进入普通config、快照、回执、日志或renderer持久草稿。
- [ ] Agent创建复用 projects.json/config.agents 身份registry；受限工作区root、真实持久化与恢复，默认不开放执行或网络mount。
- [ ] 桌面模型/凭据/Agent表单接真实Rust管理入口；旧设备、离线、拒权、冲突及未知写入可恢复。
- [ ] 真实桌面→官方测试服务→Linux Host联调；保存后读回与重启保持，目录显示实际Agent；不以fixture替代。
- [ ] 主干提交、同步与可信测试制品部署，旧数据/身份/Session保持，具备回滚证据。

### 本地资源准备层进度

- [x] `src/host/resources.ts` 复用原registry与锁，严格磁盘读取、受限Linux目录fd、revision/mutation回执、Project-first中断恢复；新Agent disabled且无channels，既有Agent状态保持。
- [x] 独立源码审查未发现可复现的本地P1/P2。macOS新用例9项通过、9项Linux-only跳过；既有config/Agent registry回归23项通过，typecheck与修改文件lint通过。
- [x] 已授权Linux测试机的隔离scratch实跑：创建、幂等、CAS、独立进程重启身份保持，以及损坏/权限过宽/符号链接越界拒写通过。未修改已入网Host服务数据、凭据或catalog，未调用模型。
- [x] PR #6完整Linux CI与fork主干交付：main `1d2c806e2700cd70804a1174f27b6ec23acdca68`；CI `38221628350` 六项通过，测试 merge `49b9df977f72b1a1ea5318406c29ac40bdea5b65` 与主干 tree 相同。此准备层没有Socket/wire/UI绑定，不能满足上方远程创建Agent验收项。

源码owner提交 `3cf77e19e1c48fce6c428b100d6e735cc98fa947`，主集成提交 `f4be625eb4a9ad1727436255ad2348fcb15f658f`；交付入口 [PR #6](https://github.com/heavenzhang/MyAgents/pull/6)。Linux专项目录fd与竞争场景还需CI全量通过，本地构建的隔离probe不冒充正式发布制品。

Linux首轮CI `38220139540` 曾捕获资源写入中断回执错误。已修复 resource 的已处理失败被外层 drain 覆盖的问题，保持 generic drain 合同；原 Linux IO 故障与恢复用例保留并通过真机隔离复验，后续完整 CI 和 PR #6 主干交付已完成。

## Owner 与受信任边界

桌面人类管理动作与 Agent invoke 分离。正式 grant 应由服务端 authority 定义和签发，Host验证目标 service/network/principal/device/identity generation、当前连接、操作范围、权限代次及期限。设备在线或同账号不自动授予管理权。本文件列的是待authority确认的设计条件，不定义线上方法名或 schema。

非秘密Provider定义复用原Provider owner，Host选择默认模型时保留旧Session的出生route。凭据单独提交，凭据replacement的生效范围须明确；现有只读systemd projection不能承担动态写入。动态凭据需要独立加密secret owner与受限执行解析入口，不扩展Node对账号token/设备私钥的访问。

本地Agent资源先复用 `registerWorkspaceAgent` / `resolvePersistedAgentWorkspaceRegistry` 的原有身份与intent锁。不得创建第二套Agent registry。Host入口必须在同锁域严格读取，磁盘损坏不能回退空列表后覆盖；有界mutationId/revision与恢复回执不能受传输重试改变。创建默认disabled、空channels，不调用模型、不启动自动任务。

## 分工与下一步

primary拥有契约决策、文档、整合、Linux/桌面真实验收与主干交付。既有runtime worker负责独立Host资源owner，独立review worker负责协议与权限边界审查；实际模型/用量未知，沿用原内置协作，不调用外部。

下一步以最新设备通道核查为准：先完成合法无副作用官方 relay 探针，再确定是否存在服务端实质缺口。已有本地资源准备层不重复实现。不另开公网端口、不复用 SSH 作为产品远程管理、不索取聊天中的模型密钥。

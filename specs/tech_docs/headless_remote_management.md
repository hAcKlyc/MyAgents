# Linux Host 远程管理接续（MAH-REMOTE-MANAGEMENT-20261012）

目标：用户从桌面 AgentNet 为已入网 Linux Host 配置模型、只写凭据、创建持久 Agent，无需手工 SSH。基础入网已真实验收；本阶段不能把本地 owner、UI fixture 或在线设备登记称为远程管理完成。

## 当前接续：独立登录与管理收发（2026-10-13）

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
- [x] 桌面 Tauri `cmd_agent_network_management`、owned Controller、实际目标签名地址与 Offer/Accepted/TLS 校验；固定四方法：`host.snapshot`、`config.set`、`resources.create`、`receipt.get`。
- [x] Host 显式启用的 reverse Unix IPC，真实 peer UID；原本地 control socket 保持 0600。管理 grant 加密绑定本地设备、服务、环境、网络、主体与登录 binding，服务/网络变化也命中同一 grant 而拒绝隐式继承。
- [x] Node 全局有界串行管理队列、断线重连、旧响应隔离、未知写入和原回执查询；真实资源 owner 新增受限且只读的 root/revision/Agent inspection，尚未扩展到管理 wire。
- [x] 主集成定向检查：109 项 headless 测试，Node IPC/资源检查 20 项通过、9 项 Linux-only 尚待 CI；TypeScript 与定向 lint 通过。独立审查发现 sent 边界把本地拒绝误报未知写，已修并用真实 Pairs 预算故障回归验证。
- [ ] 本轮完整 CI、Linux flock/资源测试、干净源码制品和主干交付。
- [ ] 真 Linux 两个 owned 设备经服务/真实签名 TLS/Node IPC 保存配置和创建禁用 Agent，读取回执及进程重启恢复；尚无该联合验收。
- [ ] 动态加密模型凭据 owner、只写 wire、资源读取 wire 和真实桌面表单；当前 Renderer adapter 仍 unavailable，不生成虚假环境/权限/配置成功投影。
- [ ] 一键安装包统一 Node Host 与网络 owner 的服务配置，以及真实桌面远程模型配置/Agent 创建验收。本轮 CI 会输出可信源码来源的 Linux Node Host 包，但不代表安装器已经完成统一。

接线约束：owned TLS profile 只发布空 catalog，不上传本地 Agent 目录或发送 Agent RPC/permit；管理应用使用独立 codec 和固定 Controller/Host 角色。Relay 的 ChannelReady 分支必须立即 drain 排队的管理 Ready 事件，不能等待下一帧。身份/网络/账户代次变化后关闭通道及待办；发送或写后记账失败关闭受影响 pair、报告原始 failure，不自动重复写入。模型凭据继续经产品能力配置，本阶段不获取密钥或调用收费模型。

测试部署仅使用已授权服务器的回环监听、隔离配置和唯一临时 unit/container。保留原两个 Host 服务和已有公网监听；部署前记录制品源码/摘要和原状态备份。原生桌面界面、远程配置业务、真实模型执行和正式生产发布分别保持独立验收项。

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

# Linux Host 远程管理接续（MAH-REMOTE-MANAGEMENT-20261012）

目标：用户从桌面 AgentNet 为已入网 Linux Host 配置模型、只写凭据、创建持久 Agent，无需手工 SSH。基础入网已真实验收；本阶段不能把本地 owner、UI fixture 或在线设备登记称为远程管理完成。

## 当前来源与范围

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
- [ ] PR #6完整Linux CI与fork主干交付。此准备层没有Socket/wire/UI绑定，不能满足上方远程创建Agent验收项。

源码owner提交 `3cf77e19e1c48fce6c428b100d6e735cc98fa947`，主集成提交 `f4be625eb4a9ad1727436255ad2348fcb15f658f`；交付入口 [PR #6](https://github.com/heavenzhang/MyAgents/pull/6)。Linux专项目录fd与竞争场景还需CI全量通过，本地构建的隔离probe不冒充正式发布制品。

## Owner 与受信任边界

桌面人类管理动作与 Agent invoke 分离。正式 grant 应由服务端 authority 定义和签发，Host验证目标 service/network/principal/device/identity generation、当前连接、操作范围、权限代次及期限。设备在线或同账号不自动授予管理权。本文件列的是待authority确认的设计条件，不定义线上方法名或 schema。

非秘密Provider定义复用原Provider owner，Host选择默认模型时保留旧Session的出生route。凭据单独提交，凭据replacement的生效范围须明确；现有只读systemd projection不能承担动态写入。动态凭据需要独立加密secret owner与受限执行解析入口，不扩展Node对账号token/设备私钥的访问。

本地Agent资源先复用 `registerWorkspaceAgent` / `resolvePersistedAgentWorkspaceRegistry` 的原有身份与intent锁。不得创建第二套Agent registry。Host入口必须在同锁域严格读取，磁盘损坏不能回退空列表后覆盖；有界mutationId/revision与恢复回执不能受传输重试改变。创建默认disabled、空channels，不调用模型、不启动自动任务。

## 分工与下一步

primary拥有契约决策、文档、整合、Linux/桌面真实验收与主干交付。既有runtime worker负责独立Host资源owner，独立review worker负责协议与权限边界审查；实际模型/用量未知，沿用原内置协作，不调用外部。

下一步：完成资源准备层Linux CI及fork主干交付；等待用户提供authority仓库与官方测试部署入口后，再确定正式wire字段并连接Rust/桌面。未取得部署通道时保持远程验收开放，不另开公网端口、不复用SSH作为产品远程管理、不索取模型密钥来掩盖协议缺口。

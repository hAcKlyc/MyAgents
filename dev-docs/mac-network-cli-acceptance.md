# MOXBOTS-MAC-NETWORK-CLI-20261016 验收

源代码分支 `codex/mac-network-cli-20261016`，base `b1001048bc5877ccaae0ab7af137cd94b2ddbde2`；目标仓库 `https://github.com/heavenzhang/MoXBots.git`。用户授权源码、完整测试、main交付，明确不更新/重启日常App。命令和安全边界见 [操作说明](mac-network-cli.md)。

## 已完成验证

- TS CLI、严格参数、scope、帮助、准入和网络适配器：452项相关测试通过；其中真实Global/Session Sidecar classification → external token admission → scope → adapter → management HTTP的loopback联调，只替换远端native authority为合成fixture。覆盖六条exact routes、未知路由404、令牌关闭/无效、sidecar generation/internal capability、字段注入、UUID大小写、原code安全投影与不重试。
- 定向TypeScript检查、定向ESLint、CLI实际bundle和离线help、测试分类通过；完整lint通过。完整typecheck首次因本任务使用ignore-scripts安装依赖而缺CodeMirror修补失败，执行本工作区postinstall后重新检查通过。
- 新Rust回归覆盖strict action schema、禁止credential/device/issuer覆盖、safe revision/UUID、无秘密status、原key完整scope/fingerprint、missing不触发生成、key写删拒绝、原principal/device/binding/trust/membership pin、开始前disabled/stale/missing拒绝、direct binary GUI前分流。另增加排队读取取消不得触碰凭据、丢弃blocking JoinHandle仍持有publication锁的确定性回归。原有取消、提交回滚、late result、account isolation回归同跑。
- 本机Rust `cargo check --tests` 与clippy红线通过，均以 `DOCS_RS=1` 跳过无关Swift桥构建；不能作为native运行通过。未改Swift源码或系统工具链。真实本地Rust运行被CLT Swift PackageDescription模块/动态库符号不匹配阻断；使用任务独立module cache复核仍失败，保留原始日志。
- 既有macOS CI job增加真实 `agent_network::` 与 `cli::` native tests，不使用DOCS_RS或OS credential访问；现有Linux完整Rust/JS回归继续作为required gates。实现提交 `d39916ba60a06cad0df16d4239c864292d475d69` 的 [CI 38851858454](https://github.com/heavenzhang/MoXBots/actions/runs/38851858454) 六项全部成功：macOS network 193通过/1既有忽略、CLI 24通过、既有credential组件回归通过；Linux完整Rust 1660通过/8既有忽略，Windows原生检查通过。

完整本地回归：unit 5,970通过/5既有跳过；DOM 2,418通过；integration 1,069通过/24既有跳过。首次完整DOM的PermissionPrompt复制反馈断言超时（1失败，其余2,417通过），目标文件与本任务无diff；该文件11项及完整DOM原断言不变重跑均通过，未放宽测试。类型、lint和完整原生CI仍分别追踪。

## 独立审查与修复

`network_cli_security_review`只读审查发现并修复：生产Sidecar漏登记六命令；actor初始化后的隐式凭据迁移；CLI登录重发membership加入。额外保护包括direct app binary不走GUI、保存原选择状态、背景恢复不替换active actor、登录提交前再次检查原actor是否已经自动恢复、背景credential read与新登录guard发布串行化，锁归实际blocking worker持有直到读取结束而非归可取消async future持有。最终独立只读复核无剩余必修问题。不会给既有UI登录增加CLI pinned策略。

额外TOCTOU回归：服务器原登记在预检后消失而本地gen1 key仍存在时，ordinary初始化会尝试activation；显式恢复现在统一走existing-only初始化，拒绝missing generation/key或replacement，无法走Identity/Rotate。普通enrollment行为保持，独立复核无新增必修问题。

状态找回仅含CLI未结束attemptId/connectionId/expiresAt，poll pending可返回原授权链接；不输出PKCE verifier、session token、私钥或配置。后台读取不可授权时typed fail closed；不提供密码命令或Keychain ACL/信任修改。

## 交付与实际运行边界

此文是合并前验收快照，记录实现验证；已吸收并发main `40f7de8f11a7c848a5f0b98aff3e4969af3fd068` 的登录对话框小窗口布局修复，native/CLI运行代码与上述已验提交相同。组合后的最终head仍须独立通过全部CI。最终head、CI与remote main ancestry/tree以 [PR84最终交付回执](https://github.com/heavenzhang/MoXBots/pull/84) 为准，不把本快照当成已合入的证明。不宣称日常客户端已升级或网络已ready。没有签名/发布、模型调用、真实账号写入、真实OS Keychain读写或生产连接验收；这些不能由模拟与build替代，也不因main合入自动发生。

## 协作记录

主Agent负责Rust owner/集成/验收/main，`network_cli_surface`负责TS CLI/server，`network_cli_security_review`独立只读审查。选择依据是互斥语言文件与安全审查收益；TS经composition及UUID两轮修复，Rust按独立发现修复。未进行模型/effort切换，精确模型与用量没有可验证记录；不调用外部原因：明确采用ai-yaoren-local纯内置模式。未测算节省金额或速度。后续同类CLI应从真实composition入口开始验证，避免仅测适配器漏掉产品路由边界。

# BOTS-MODEL-CENTER-001 · 统一模型中心第一版

用户于 2026-10-14 明确授权实现。模型中心、Bot 模型分配及调用监控放在现有 `/admin`，沿用本实例账号、管理员权限和登录；不建立新后台。交互复用设置中的供应商连接字段。第一版只覆盖 builtin SDK 的 API 模型，Anthropic、OpenAI Chat Completions、OpenAI Responses；其他 runtime 不表示已接入。

## 配置与生效

管理员一次配置供应商连接、鉴权方式、接口格式、输出参数和输出上限，再登记上游模型名称、授权用户、可选单价。API Key write-only，服务端加密保存；Host 只得到指定 Bot/Session 的短期网关凭据，不能读回供应商密钥。模型列表探测为主动 GET，不能自动触发收费推理。

Bot 登记的 `model_ref` 是唯一期望配置 authority，不另建互相冲突的 assignment owner。平台模型配置 revision、Bot 登记 revision 与 Host effective snapshot 分别展示；已保存并不证明 Host 已应用。新建 Session 捕获不可变模型/供应商版本，现有 Session 不静默切换。停用模型、供应商或撤销访问会禁止新调用。供应商密钥轮换使旧供应商版本会话失效，必须重新建 Session。

## 有限权限

平台管理员可管理平台模型和指定用户的可用模型；管理员角色不隐含私人 Host 执行权。Bot/Host 所有者通过本实例有效账号明确签发有限模型访问，限定 Bot、owner、Host device/key generation/identity binding、明确模型 UUID 白名单、有效期、token/费用/并发上限。Host 本地另须开启 `cloud_models`，固定 HTTPS origin、Bot/model 白名单、期限和额度；已有生命周期授权不自动允许模型调用。

每次会话创建/网关调用重查既有 AuthStore、DeviceStore、PeerStore、MetadataStore 和实际 Relay 连接；不从 body 推定 Host 身份，不持久保存管理员 bearer 充当机器账号。Bot 改 owner/Host、删除、设备身份失效或访问撤销须拒绝旧授权。跨用户共享调用仍按共享规划另行实现。

Host 通过原 supervisor → worker → SessionEngine → builtin SDK 消费限定会话。第一版平台 cloud 模型 Bot 仅文本模型 API 消费，不拥有 Host 文件、命令、SDK 工具、插件/MCP 或私人设置权限；实际 native SDK tools/settingsSources 明确关闭，工具执行以后另行有限授权。供应商凭据不下发。私人 `/session/:id/send` 不开放 Bot；本轮控制台不新增向 Bot 发 prompt/任务界面。模型网关授权不等于整机或私人会话权限。

## 调用监控与额度

请求保存 Bot、owner、Session、模型/供应商版本、时间/耗时、结果和 token/费用，不保存 prompt/response。日 token、日 USD、并发、Session 累计 token 原子预占；已确认 usage 按捕获单价版本结算。第一版费用用 USD micro-units，价格或 usage 未确认则显示未知，不能显示为零。缓存 token 计费无法确认时保留保守预占。

请求 ID 重放不能再次调用。HTTP、SDK 重试均受控；上游结果未知的 Session 禁止继续调用，不能以新编号猜测重试。进程恢复保留未知请求及保守收费占用，释放悬挂并发。明确已完成但无 usage 的结果仅保留未知计费，不伪装为已确认费用。

## 验收和交付

- [x] core 三协议真实 loopback 传输、并发预占/回放/CAS/撤销/流中断及密钥保护独立测试。
- [x] Host 实际已安装 native SDK 三协议隔离接入、不可变配置和全目录凭据泄漏扫描。
- [x] HTTP 与实际 owner authority 接线、接口/会话/撤销端到端；130 Rust tests、clippy通过。
- [x] 真实 Rust fixture 控制台 CRUD、模型分配、监控、普通账号拒绝及响应式独立验收，详见dev-docs/bots-model-center-review.md。
- [ ] 合入远端 main、CI 和来源核验。
- [ ] 云端窗口/备份/回滚/现网控制台发布和真实账号路径复验。
- [ ] 指定平台供应商配置与单 Bot 有限 Host opt-in、费用授权后的真实收费路径。尚无本任务平台 API Key，不能复制私人 Host key 或以 mock 代替验收。

当前详细任务记录 `.agent-sync/tasks/codex-bots-model-center-001-a165b438.md`；未勾选项不代表已实现或生产完成。

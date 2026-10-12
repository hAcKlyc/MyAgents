# Host 管理 UI 准备层（MAH-20261012 / MAH-UI）

此文档描述桌面端首批及四页准备层实现，不代表网络协议或 Linux Host 管理服务已经存在。当前固定协议为 1.1.0，源码 authority 仍是 `MyAgents-Agenthub/packages/agent-network-protocol`；不得手改 vendored artifact。主聊天拥有共同接口与最终集成，桌面端仅实现 renderer 投影。

## 生产边界

设备详情保留原发现、入退网、重命名、Agent 开放和调用路径，在独立区域展示 Host 管理入口。`api/hostManagement.ts` 的类型是方案 v0 的本地 UI seam，不是网络 Schema。生产 `hostManagementAdapter.inspect` 明确返回 `clientProtocolUnavailable`，其他方法均拒绝；没有默认 fixture、HTTP 路由或未发布的 Tauri command。产品版本、OS、Agent 可调用性和同账号身份均不授予 Host 能力或管理权。

下一步只能从 authority 固定产物和 Rust 受信任人类管理入口接入。能力必须来自设备级协商；地址包含 connection、principal/auth generation、service、network、device 和 target identity generation。Host 的实际权限、revision、持久化及生效事实由 Host owner 裁决；UI 的禁用逻辑不能替代服务端授权。

## 首批状态与交互

- 执行环境只读，空 Host 不依赖 Agent mount；Provider 表单只编辑默认 API 地址与模型。首版输入约束是 HTTPS、不含 userinfo/query/fragment、非空模型；正式 authority 如定义不同约束，需要随固定产物统一调整，不能将这些 UI 约束发布为另一套 wire contract。
- read / configure / approve / operate 单独投影。读取和能力缺失显示不可用或无权限；配置与凭据各检查 configure，测试检查 operate。离线禁止修改与测试，保留非秘密草稿，无配置排队。
- Provider 配置与凭据分别提交。凭据为 password 输入、只写、从不进入快照/草稿 store/磁盘/日志；关闭详情清除该输入。非秘密草稿及未知操作仅保存在窗口内存中。
- 每次写入使用 mutationId 与 expectedRevision。accepted 不表示持久化；persisted 不表示生效；applied 仅来自 Host 回执。持久化后仍向 owner 读回配置，核对 desiredRevision；读回失败暂停新修改。
- 未确认或传输异常保留原 mutationId，关闭重开也只能查原回执，不自动重发。冲突保留输入，读取最新配置后由用户显式采用新修订继续。重复 Enter / 点击由同步锁阻止，IME 确认键不保存。
- current default、desired/effective revision 与 Session 出生快照分开说明。测试只针对已生效配置，要求没有草稿/未写凭据，且 desired/effective revision 一致。
- 草稿与回执按完整管理地址隔离；原 AgentNet store 在登出、账号代次或连接移除时清理对应 scope，页面 teardown 清空全部。本进程重启不保留未知写入状态，不承诺 crash-safe exactly-once；正式 Host operation 查询能力接通后需设计恢复入口。

## 验证与未完成范围

`HostManagement.test.tsx` 使用显式依赖注入的隔离 fixture；不接触真实账号、Host、Provider 或凭据。`hostManagement.test.ts` 验证身份隔离和输入约束，原 `store.test.ts` 验证身份边界清理。构建和 DOM/fixture 通过不证明网络协商、Host 权限、持久化或真实 Session 行为。

聚焦验证：

```sh
npx vitest run --project dom --project unit src/renderer/api/hostManagement.test.ts src/renderer/features/agent-network/HostManagement.test.tsx src/renderer/features/agent-network/store.test.ts src/renderer/features/agent-network/AgentRow.test.tsx src/renderer/features/agent-network/DeviceRenameDialog.test.tsx src/renderer/pages/AgentNetwork.test.tsx
npm run typecheck
npm run build:web
```

运行页面 fixture 位于本任务检出的同级 `work/host-ui`，与正式入口分离。视觉/交互/响应式证据由独立验收者记录；真实业务验收需要两设备、真实测试账号、仅出站连接的 Linux Host 和 authority 协议实现。

## 四页准备层（MAH-UI-PAGES-20261012）

设备详情 Host 区域提供环境/Provider、工作区/Agent、MCP/Skills、审批、日志五个 Tab。Tab 支持方向键、Home/End 和可见焦点；输入法组合事件不导航。旧设备/正式协议尚未支持时，所有 Tab 都明确不可用，不显示伪造资源或待审批项。`HostManagementAdapter.pages` 是可选的本地测试/未来投影 seam；正式 adapter 没有该属性，不产生网络管理调用。

- `HostResourcePages` 只从 Host owner 的资源快照读取允许根目录、Runtime、MCP 预设及可信 Skill 来源。工作区注册使用根目录 id 和相对路径，前端禁止绝对路径、上级跳转和控制字符；最终路径裁决仍由 Host owner 完成。Agent 创建和改名不改变原网络开放 owner。MCP 不接受任意命令、环境变量或密钥；只投影声明的 HTTPS/stdio 预设。Skills 只选择 Host 声明的可信来源。
- 资源 `resources.read` 与每种配置能力分别检查；配置要 `configure`，MCP 测试要 `operate + mcp.test`。一份窗口内非秘密草稿对应一个 typed patch，编辑其他资源前须保存或安全放弃；切页不覆盖草稿，也不在错误页展示保存按钮。CAS baseline 直到显式协调保持不变，避免普通编辑绕过冲突。资源配置使用原 mutationId 查询未知结果；读回失败保持锁定；审批 pending 不得由资源页查询或清理。
- 资源 desired/effective revision、applyState 和 effectScope 单独展示；MCP 测试只针对已启用的 owner 已生效配置，无草稿/未确认操作并且两修订一致才可用。新默认不覆盖旧 Session 出生快照。
- `HostActivityPages` 的审批页需要 `interactions.read + read`，回答/批准需要 `interaction.respond + approve`，配置和操作权限都不能替代审批权限。权限、计划、必答问题绑定真实 `sessionId/requestId/turnId/runtimeGeneration`，另携带 owner 最新 read token。提交前重新读取、核对完整身份和展示内容；过期、Runtime 替换或内容变更要求重新审阅。必答问题必须选择 owner 提供的每一个答案；未定义的自由文本回答保持不可用，不发送聊天消息代替响应。
- 审批响应的 accepted/persisted/applied 分别显示；persisted 仍锁定并查询回执，不能视为审批已执行。applied、rejected、expired、conflict 后重新读取待处理 owner；没有乐观删项。传输未知只查询原 mutationId。窗口关闭后保留的只是操作元数据，不保留审批正文、答案或凭据。断线/页面离开/身份和权限变化废弃迟到响应，重连重新读回后才开放操作。
- 日志页要 `logs.read + read`，一次最多 100 条、每条 message 最多 4096 字符。仅显示 Host 日志 owner 标记的 `redacted: true` 投影和有限关联字段，拒绝越界数量、非脱敏标记、错误 scope 或未知级别。级别改变重置 cursor，下一页替换当前页，不累计无界数组。不读本机日志作 fallback，不导出原始载荷，不新增轮询。UI 对脱敏标记的检查不能替代 Host 的实际脱敏和正式协议校验。

新增类型不是 authority schema，不定义线上方法名或服务端幂等保证；正式来源发布后必须按固定 artifact 替换这些 seam。所有读取和回执都核对完整 HostAddress；AbortSignal/generation 废弃旧身份结果。登出/连接移除复用原 store 清理窗口草稿和 pending。进程重启不会恢复 UI pending，不承诺 crash-safe exactly-once。

新增 `HostResourcePages.test.tsx`、`HostActivityPages.test.tsx` 与 API/导航回归只使用显式隔离 fixture。当前固定协议仍为 1.1.0，无 Host 管理能力；真实设备级协商、权限、持久化、MCP/Skill 执行、审批及脱敏日志仍依赖 Host/authority 和两设备真实测试账号。原生 macOS IME 和 Tauri 打包不由 DOM/Web 构建证明。

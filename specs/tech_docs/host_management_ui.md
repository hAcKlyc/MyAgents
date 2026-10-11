# Host 管理 UI 准备层（MAH-20261012 / MAH-UI）

此文档描述桌面端首批实现，不代表网络协议或 Linux Host 管理服务已经存在。当前固定协议为 1.1.0，源码 authority 仍是 `MyAgents-Agenthub/packages/agent-network-protocol`；不得手改 vendored artifact。主聊天拥有共同接口与最终集成，桌面端仅实现 renderer 投影。

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

工作区/Agent 管理、MCP/Skills、审批、日志尚未实现。远端审批必须绑定真实 SessionEngine pending interaction 的 sessionId、requestId、turnId 和 Runtime generation，重连先回读；当前不显示可批准的模拟项，不发送聊天消息代替批准。

# Linux Host 接入 AgentNet：最小实施边界

任务：MAH-AGENTNET-20261012。核查时间：2026-10-12（Asia/Shanghai）。客户端基线：`501df0ba5b32c82c6a5f4c63e46baa6737eb56f0`。

这是只读源码核查与下一阶段方案。第一阶段 Linux Host 已有本地 owner/Session 执行链路；本文没有运行远程 enrollment、发送网络管理命令、部署 Agenthub 或验证跨设备业务路径。第一阶段真实服务器验收由主智能体另行记录。

## 现有能力与具体证据

| 事实 | 当前证据 | 下一阶段含义 |
|---|---|---|
| 固定协议为 1.1.0 | `vendor/agent-network-protocol/manifest.json`，SHA-256 `445fb9d0e1e1e9f85cffcc1cf1a633914f7b018919d456be3a25d054db010ae3`，authority source commit `f53197315f169c4506315b36891c225effeff092` | 客户端只消费固定包，不改 vendored 包或其 Rust 投影 |
| 现有 RPC 为 Agent/Session 服务 | 包内 `src/contracts.ts:44–71`：agent.show、session.list/get/start/send/state/watch；strict union 绑定 targetMountId 和 localAgentId/localSessionId | 没有 device-level Host status/config/grant/approve RPC；不能借 session.send、arbitrary admin path 或 agent mount 包装管理 |
| 自部署 descriptor 固定能力 | 包内 `src/selfhost.ts:4`：protocol=1，能力闭合为 tls13-mtls/typed-rpc/permit-v1/return-v1 | 不能直接加入新的 host capability；须在 authority 设计兼容协商并发布新固定产物 |
| Rust 出站 HTTPS/WSS 和 DPoP | `src-tauri/src/agent_network/transport.rs:25–113,178–209`；WSS 经 HTTPS upgrade 到 `/v1/ws`，固定子协议，禁止重定向与传输自动重试 | 可复用连接安全语义，无需新增 Host 公网监听 |
| 内层设备 TLS、资源预算、peer/epoch | `crypto.rs`、`channel.rs:45,120,188`、`memory.rs`、`incoming.rs:240`；`specs/tech_docs/agent_network.md:63–91` | 连接加密不代表有管理权限；设备 generation 与 human grant 必须另行校验 |
| enrollment 有现有身份流程 | `identity.rs:162,277,425`；`account.rs:144`；`space_cloud/agent_network.rs:7–71` 的 IdentityState/Identity/Certificate/Rotate/Challenge/Current/Revoke/RevokeState/Jwks | 可复用 descriptor pin、P-256、CSR/PoP、signed binding、ACK recovery、renewal/revocation；当前代码仍依赖桌面 account/device owner |
| Linux 私钥存储依赖 Secret Service | `crypto.rs:98–153`，Linux concrete backend 在 :110–111，save_pending 持久化确认后才允许激活，明确无明文文件 fallback | 无桌面 systemd 服务是否有可用且可重启解锁的 Secret Service，尚未验证；不能把模型 Provider 的 systemd credential helper 当设备身份 store |
| 整个 actor 尚不能无 Tauri 构建 | `actor.rs:17,33,164,419,701`；`registry.rs:178,274,740`；`local_owner.rs:100` 依赖 AppHandle/SidecarManager/Space/事件与电源 owner | 可抽共享 core；不能把现有桌面 actor 整体复制进 Node supervisor 或启动 Tauri 模拟无桌面 |
| 桌面 Host UI 已有 seam | `src/renderer/api/hostManagement.ts` 的 HostLocator/HostAddress/HostSnapshot/HostMutation/HostReceipt/HostManagementAdapter；`DeviceDetails.tsx:195` 接入 | 地址包含 principal/network/connection/authGeneration/service/targetIdentityGeneration，已有权限与效果 scope 展示 |
| production adapter 明确 unsupported | `src/renderer/api/hostManagement.ts:121–145` | inspect 返回 clientProtocolUnavailable，其他方法拒绝；UI 测试注入不证明远程服务存在 |
| UI 已防止不确定写自动重放 | `HostManagement.tsx:291–402` 检查完整 address、mutationId、resource，未知仅查原 receipt；`hostManagementState.ts:8–21` 不存 credential | 可接新 adapter，保留这些行为，不把 TS UI seam 当 wire authority |
| 本地配置 owner 已有 CAS | `src/host/management.ts` 在 supervisor 原锁内重读 config，CAS 与本地 receipt 原子保存；不写原始 Key | 当前仅 Kimi/本地配置；本地 durable receipt 已真机通过，远端 grant 与有效配置投影尚未实现 |

包内路径指 `node_modules/@myagents/agent-network-protocol/` 的已安装只读内容，其 authority 是固定 tgz，不是该目录可编辑源码。Rust 同一包的校验/投影入口为 `src-tauri/agent-network-protocol/build.rs:9–59`。

## 权威仓库访问结果

当前 `gh api user --jq '{login}'` 返回 `heavenzhang`，证明本次 gh 请求已认证。只读请求：

- `gh api repos/hAcKlyc/MyAgents-Agenthub`：HTTP 404。
- 同仓库 `contents/specs/ARCHITECTURE.md` 与 `contents/specs/RELEASE.md`：HTTP 404。
- `search/repositories?q=MyAgents-Agenthub+in:name&per_page=10`：`total_count=0`。

客户端说明称该库为公开 Apache-2.0 authority，但这次 API 结果不能区分不存在、改名、私有或账号缺少权限。未读取 token、私钥或凭据文件。**authority 源码访问阻断**：在拿到正确可访问 URL/权限或带来源 SHA 的官方源码交付前，不能实现或发布新的 Host wire contract。现有 archive 可以支持独立接口整理与离线兼容测试，不足以授权手改协议。

## 最小模块拆分与 owner 接口

以下名称是本地设计建议，尚未成为 wire 方法或实现。

| 模块（建议位置） | 单一 owner | 最小本地接口与边界 |
|---|---|---|
| 共享 Rust network core（建议新 crate） | 网络连接、key scope、peer/epoch、memory budget、DPoP、TLS | AccountContext/IdentityStore/DeviceIdentity/LocalOwner/Events/Power 作为适配接口；抽现有实现，Desktop adapter 继续接 Tauri，Host adapter 不含 WebView |
| Headless enrollment adapter（建议 `src-host-network/`） | 设备身份 generation、descriptor pin、private key 生命周期 | local enroll/inspect/remove；key 只短暂输入 Rust，不到 Node/Renderer/config/log；activation 前确认持久化，unknown activation 按已有 PoP recovery 查身份 |
| Host network daemon（同 Rust executable） | 长连接、authGeneration、状态与授权 permit | 仅出站 HTTPS/WSS；验证 Host service、目标 generation、caller 人类身份/grant、权限与期限后交接 typed management request |
| Host management owner（建议 `src/host/management.ts`） | config desiredRevision、receipt、effective projection | inspect/read/compareAndSet/readReceipt；复用当前 supervisor/config.json，不另建配置 authority；只有允许字段进入原 mutation 串行入口 |
| Rust ↔ 本地 Host typed adapter | 已验证请求向本地 owner 交接 | 走私有 Unix socket与闭合 envelope，含目标/generation/grant context；不开放任意 URL/path/method；响应跨 IPC 不含 credential |
| Desktop Host adapter（`src/renderer/api/hostManagement.ts` 与 Rust command） | 人类发起管理动作与 UI 投影 | invoke → Rust 验证 capability/service → 原连接；unsupported 保持关闭，成功后再替换当前 adapter；CAS 冲突保留草稿 |
| Agenthub protocol/issuer/relay adapter（authority 仓库） | enrollment 签发、device-service discovery、人类 management grant 与路由授权 | 新固定协议产物和 TS/Rust fixtures；服务端验证 device scope/generation/grant，当前 Agent mount permit 不能代替 management grant |

设备业务 config 的 CAS/receipt 属于目标 Host，不属于 relay 的 Agent enable/membership revision。云端可拥有权限和目录元数据，不能写 Host 本地执行配置、原 Session birth snapshot 或模型 Key。

### 最小远程能力

先做 enrollment + status/config.read + 非秘密 Provider 配置 CAS/receipt。**首版不发布远程 credential.write、provider.test、approve、operate**；UI 的未实现能力保持禁用。这样不需为首版扩大 root credential 写权限或从远端触发付费验证。

配置 CAS 需要 authority 明确：完整 device/service/generation 地址、人类 management grant、mutationId、expectedRevision、资源 allowlist、规范化 patch、deadline、明确 conflict/rejected/persisted/unconfirmed 回执。相同 mutationId 必须核对同一请求摘要；未知传输结果只查询原 receipt，不用新 ID 重发。receipt 跨重启可恢复且不含 Key。落盘顺序与崩溃恢复必须由 Host owner 定义，不能把 socket HTTP 200 当 persisted。

status 区分 enrollment/connection ready/initialization/desiredRevision/effectiveRevision/applyState/effectScope；不以设备 online 或 Node 进程存在宣称 Runtime 已配置。已有 Session 保持自己的快照；仅在新 Session 使用新默认值时可报告 newSession 效果，不伪装为 immediate。

现有 UI 提供 baseUrl/model，但本地 Host 当前只允许 moonshot-coding/model。第一版远程 CAS 可明确只支持该 Provider、固定官方 endpoint 和 model；UI 需按真实 capability 呈现，不接受一个实际被忽略的 baseUrl。通用 Provider 配置不是当前本地 owner 已具备能力。

### 无桌面私钥持久化门禁

优先核实隔离 systemd 用户能否使用现有 Secret Service backend，包括冷启动、重启恢复、锁定/缺失失败和 revoke 后清理。若不可用，新增 systemd encrypted credential-backed IdentityStore 必须作为独立架构变更，保留 save_pending → reload verify → activation 顺序与 generation CAS；root provisioning/轮换由受限 OS owner 负责。不能降级到 config.json、Node 明文文件或仅内存 key。第一阶段 Kimi 的 `systemd-credential:kimi` 是 Provider credential reference，不能复用作设备身份。

## 实施顺序与可勾选验收

- [x] 核对客户端基线、固定协议、UI seam 与 gh 访问结果；本文件记录证据。
- [ ] 解除 Agenthub 源码访问阻断，读取其当前 ARCHITECTURE/RELEASE 与部署兼容约束，确认实际 issuer/relay authority。
- [ ] 离线抽 Rust core 接口和 Host config owner/receipt 存储；保持 Desktop 原路径，完成 parity、CAS 冲突、unknown、迟到 generation 和断线失败测试。
- [ ] 在 authority 增加 device-level service/capability 协商、人类 management grant、Host read/CAS/receipt strict schema 与兼容 fixtures，发布来源可追溯固定包；按 release import 消费，不手改 vendor。
- [ ] 解决 headless IdentityStore 与 enrollment/account/device adapter；验证 pending activation recovery、descriptor trust 变化、revoke/reentry 与私钥恢复边界。
- [ ] 接 Host 出站 daemon、私有 socket typed adapter，再接 Desktop production HostManagementAdapter；未协商能力保持 unsupported，Agent/Session 路由不受影响。
- [ ] 使用已有获授权测试实例完成真实 enrollment→status→CAS→conflict→receipt recovery→重启应用新默认值→撤销/grant expiry；没有现有可用实例时不自行新增服务器/公网监听。
- [ ] 检查 secret 不落 config/transcript/log/UI，源/目标 device generation 与人类权限均正确；未配置目标与无权管理者必须失败关闭。
- [ ] 独立审阅、桌面回归、主干/固定产物/部署版本对应核实。仅这些门禁通过后宣布远程管理可用。

当前可继续做离线 owner/interface 工作；authority 协议扩展和真实 enrollment 均未开始，访问与 Linux key-store 可用性是明确依赖，不把现有 UI 或静态测试当成已接入。

## 本地 owner 准备（独立于线协议）

`src/host/management.ts` 新增本地配置回执，调用仍由原Node supervisor串行准入。可选本地UUID mutationId和canonical安全意图摘要绑定，原config.json一次提交默认值/receipt；status只区分persisted/conflict，effect为new-session/none，未知提交查原ID，不自动重放。ledger绑定本机Host UUID、固定容量256且无自动淘汰，损坏关闭；已有receipt可在busy或workspace变化后读取。旧无ID local configure保持原结果；不会把executionAuthorized或凭据能力扩展给远端。

这些类型没有进入vendor或AgentNet transport。它们不是远端management grant、caller身份或target generation验证的替代品；未来adapter必须先完成authority定义的完整scope/授权，并把操作scope绑定到本地调用。共享Rust core、enrollment和远端协议仍未实现。主Goal不因本地回执测试通过而完成。

## 无桌面存储环境的实测补充

测试 Host 的实际服务进程与服务 UID 缺少 session D-Bus/XDG runtime，未安装gnome-keyring；现有Secret Service backend不能直接用于该环境。只读systemd credential不等价于动态save_pending。新的隔离Rust encrypted IdentityStore准备见[headless_identity_store.md](./headless_identity_store.md)，Desktop保持原OSstore。Root只初始化该隔离owner自己的新加密key，不向Node/远端增加凭据权限，不新增root运行时helper或公网接口。独立存储验收尚在实施；enrollment与Agenthub访问依赖不因此解除。

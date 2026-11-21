# 托管浏览器工具

`myagents-browser` 是工具页的应用自有 Playwright MCP；普通 `playwright` preset 与 Tauri `BrowserPanel` 页面预览分别有自己的配置与生命周期。

## Owner 与生命周期

- Rust `BrowserResourceManager` 根据随 App 的资源 lock 安装、校验和公布 Chromium；Global Sidecar 只消费它返回的 executable。上游 `browser_install` 不经过这个 owner，故从托管工具目录移除，直接调用也返回产品安装入口。普通 Playwright preset 不受影响。
- Rust `BrowserRuntimeAuthority` 按 Product Session、workspace、source/Host generation 验证 capability。Host 的 lazy Context getter 和工具后处理读取当前连接 binding；pending→正式 Session adoption 同时迁移已排队的 checkpoint timer。正在创建或关闭的 Context、冲突 owner 保留既有 rekey fence，不能猜测合并。
- Global Sidecar `BrowserContextRegistry` 拥有共享 Chromium 以及每 Product Session 的 Context；每 MCP backend 仅借用。传输断开后保留 15 秒重连窗口；真正关闭由 Registry 负责。Playwright 的 SIGINT/SIGTERM handler 关闭，信号退出先经过产品 drain/checkpoint。
- 借用代理跟踪 listener/route，清理一个 backend 不得关闭实际 Context。Page close 后释放该页监听记录；once 被触发时立即移除其跟踪记录。选择/排序引用由真实 Context 的 Page-close 观察器释放，跨越 backend 断开后的重连窗口。

## Runtime 接入与侧栏边界

内置 Claude SDK、托管 Codex、Integrated DSH 和 Antigravity CLI 在各自 adapter 中将 `myagents-browser` 的 `__browser_host__` 产品标记解析为 Rust 颁发的 HTTP capability。Antigravity 在建立或恢复会话时接入，依赖 CLI 的 ACP HTTP MCP 能力。DSH 首启、恢复和 live extension replacement 共用 `projectDshManagedBrowser`：先以 canonical Product Session ID adoption，再 acquire；不能使用 DSH native Session ID。既有 Session 的产品 MCP 选择无需迁移。

DSH 现有扩展 owner 将原始 source 与其 compiled plane 存入同一 generation 记录，按 desired/effective plane 读取配对来源；候选被拒绝并释放后自动回到 effective 的配对来源。下一次 Root turn admission 内沿同一个串行 replacement 边界重新取得 capability。该刷新只重新投影浏览器组件与凭据，其余组件、Skill 内容资源和授权根沿用已准入快照；不能因刷新浏览器而重新读取磁盘中的 Skill 或触发完整能力发现。Host generation、endpoint 或 token 变化使公开的 opaque credential revision 改变；真实 Authorization 仅留在 generation-scoped reverse credential binding，不进入公开 snapshot、argv 或配置文件。旧 effective plane 的凭据与 dispatcher 按既有 native background-work 生命周期保留到进程退出；同一 source 刷新不得 dispose 仍被有效 plane 引用的 dispatcher。Host 获取失败成为单组件诊断，基础 Runtime 可用；下一个边界可重新接入。这不承诺当前进行中的浏览器操作跨 Host 重启续跑。

普通 Playwright preset 继续使用自己的启动参数和环境，外部 Runtime 的工具配置仍按各自接入规则管理。工具页说明两类工具与侧栏的登录边界；托管浏览器不读取侧栏的 WebView Cookie。

侧栏 `Chat` 只持有显式导航请求，每次打开（包括同一个地址）生成新请求；`BrowserPanel` / native WebView 提供当前 URL。可见性、split/fullscreen 和语言变化不得重放已消费请求；创建过程中保留最新请求，native generation ready 后再导航。地址栏接受网址或本地路径，不提供搜索。localhost/IP 缺省 HTTP，普通域名缺省 HTTPS；本地文件权限仍由 Rust 原有路径校验裁决。停止使用独立的 `cmd_browser_stop`（`window.stop()`），刷新、后退、前进及导航错误反馈受同一 lifecycle token 约束。完整网站错误/崩溃状态机和 popup/download 不属于这条控制面的保证。

## MCP 取消与完成

当前安装版 Playwright MCP 不把 Protocol 的 request signal 传给实际工具。直接转发 `notifications/cancelled` 会抑制最终协议回复，导致 JSON HTTP 响应永不完成，即使实际工具已经结束。

Host 因此在公开 transport 的收发边界记录尚未响应的 request id 及其 acquisition signal：合法取消只匹配同一连接的对应 tools/call，即使同批通知先于 lazy factory 到达也保留取消；已执行工具继续 drain 并返回正常终态。原始 Protocol 不再因这个通知省略回复，请求计数在 HTTP 等待完成后释放。replacement、capability retirement、DELETE 和 shutdown 使用同一 retirement 入口，先取消连接 acquisition signal，再等待 drain；即使工具已受理而 lazy factory 尚未注册 waiter，后续获取也能读到取消。批量消息也经过同一 transport policy。

取消请求不等于强制中断已经执行的 Playwright 操作。Host 不提前宣布其完成，也不在仍有工作时销毁它使用的 Context。

## 登录保存与兼容

Context 按 Product Session 隔离，但持久登录身份由当前 OS 用户共用的 Rust `browser_identity_store.rs` 保存（`~/.myagents/browser-identity-store.json`），不按 Session 或 workspace 分库。新 Context 从共享 identity snapshot 加载 Cookie；同一 Context 在重连窗口内复用其内存状态。不能把 Context 隔离解释为账号数据隔离。

托管登录状态有意仅保存 Cookie：全量 `storageState()` 可能创建历史 origin 的临时页面并导致可见闪烁。Rust 的 CAS 存储是持久 authority，Context 同时保存权威 base 与实际 observed base，以避免反复提交被其他 Session 否决的旧值。

750 ms 防抖的 checkpoint 正在提交时，后来请求记录一次待采样状态，合并为后续一次新快照；最终关闭同样等待这个新快照，不能把旧提交成功当成最终保存成功。循环结束与释放 in-flight 状态在同一 continuation 完成，避免外置 promise.finally 的微任务间隙漏掉新触发。保存失败仍沿既有一次重试及诊断策略关闭 Context，不承诺跨崩溃无损。

Cookie 实体键包含 name/domain/path；分区 Cookie 另包含 partitionKey 和 Chromium 的 `_crHasCrossSiteAncestor`（缺省 true，与安装版 adapter 一致）。不同分区的更新、删除和 CAS 相互独立。

身份存储 schema 2 自动读取并升级 schema 1，保留 state、revision 和非 Cookie 元数据。旧三元 Cookie revision key 无法还原其原先的分区，尤其是删除记录，因此迁移为 `keyRevisions` 内不可再推进的 `cookie-legacy:` family fence。旧 snapshot 仍受历史 revision 保护；从当前 snapshot 开始的新分区操作只推进自己的精确键。已被旧代码覆盖的 Cookie 无法凭剩余数据恢复。旧版本 reader 不支持 schema 2，降级不属于此迁移的兼容保证。

## 工具能力与验证边界

托管工具仍包含 `browser_run_code` 和现有文件工具，沿用当前文件访问与 roots 行为。借用 Page 代理用于生命周期管理，不能作为任意 Playwright 代码的对象访问隔离保证。

`browser-host.lifecycle.unit.test.ts` 使用真实安装版 MCP 与生产 Host/Registry、合成 Context/资源服务验证取消、重试、adoption、目录与直接调用。Registry 测试覆盖快照交错和页面释放；Rust 测试覆盖分区实体及 schema 迁移。打包/API gate 固定上游版本和资源图；发行验收仍需对应平台、锁定 Chromium 产物的实际运行验证。

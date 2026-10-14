<!-- git-project-sync-task:version=1 -->
<!-- git-project-sync-task:branch=codex/remote-session-20261015 -->
<!-- git-project-sync-task:base=ff957fdf078d8e96e732c5b22c89ee2f41337fe9 -->
<!-- git-project-sync-task:status=in-progress -->

# REMOTE-SESSION-IMPLEMENTATION-20261015

用户授权：2026-10-15 开始开发。前序设计与本地原型已认可。

目标：同账号网络设备的 Agent 可直接打开独立远程会话窗口，查看/新建/继续会话、响应实际审批与提问、明确停止。复用远端 SessionEngine/SessionStore，不通过 @，不新增公网入口。首版有界快照同步；Host 保留单活跃执行限制。

## To Do

- [x] 确认权威仓库、分支、remote/worktree及并发状态：独立worktree从origin/main ff957fdf创建，保留原checkout。
- [x] 协议与 owner 边界：owned encrypted management session.remote 扩展，不改vendor固定协议包。
- [x] 桌面与Host执行 owner：配置冻结、权限检查、durable operation receipt、精确generation/turn审批和停止。
- [x] RemoteSessionTab：账号隔离、真实快照、分页、断线恢复、不自动重发、关闭窗口不停止。
- [ ] 代码检查及模拟验证：TypeScript/Rust、IPC/DOM/权限与重复请求反证、独立审查。
- [ ] 真实联调：两设备身份与真实Provider会话；模拟通过不替代此项。
- [ ] 提交、CI、合入远端主干并核实SHA。
- [ ] 候选包、发布、真实用户路径复验：受现有release owner/资源签名/原生工具链约束。

## 并行责任

主Agent：shared协议、desktop Node owner、receipt/projection、集成/验收/主干交付。host_audit：Host supervisor/worker/IPC。remote_transport：Rust协议/actor/desktop target。remote_ui：renderer独立Tab与入口。均在本worktree，互斥文件范围，禁止操作生产或扩大范围。

## 当前证据

- 全量unit：557 files，5607 passed / 5 skipped；无失败。
- 定向owner/receipt：含真实Global Node routes与跨进程落盘handoff、并发与失败注入、过期进程租约、10k总容量（模拟容量2）、不保存prompt。最终聚焦测试14+1通过。
- Host：service7、IPC11、真实worker3、Bot1；排队ACK helper3；保留Bot执行权限与私有history。
- Renderer：账号/冷恢复、API、持久操作编号、DOM、分页、安全Markdown等回归通过；实际组件1280/390流程由非UI实现者验收，见 `dev-docs/remote-session/ui-simulation-review.md`，均为模拟传输。
- Rust：协议25、pairs16、controller13、admission owner1通过；Host与protocol Clippy通过；DOCS_RS desktop type-check通过。
- TypeScript全量与改动文件ESLint通过；Web/Node MoXBots profile构建通过。
- 原生构建限制已重复核实：CommandLineTools Swift6.3.2的apple-metal PackageDescription arm64 undefined symbol，当前无完整Xcode。DOCS_RS不能代替真实原生构建。
- 真实双端、Provider、安装客户端、发布验收仍未完成。

## 下一步

完成desktop owner、receipt跨进程与原Session admission验证，统一检查全部文件；再独立审查与实际运行验证。代码、模拟、真实联调、主干、发布当前分别未验收完成。

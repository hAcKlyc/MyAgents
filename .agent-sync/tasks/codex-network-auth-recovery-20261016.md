<!-- git-project-sync-task:version=1 -->
<!-- git-project-sync-task:branch=codex/network-auth-recovery-20261016 -->
<!-- git-project-sync-task:base=925947e8252467392685e5b9dc6231476d1e0d75 -->
<!-- git-project-sync-task:status=in-progress -->

# MOXBOTS-NET-AUTH-001

目标：恢复现有云网络登录，并避免登录无效被描述为普通自动重连。当前 Agent 直接实现及验收；单 Agent，改动集中且复用原登录流程。UI owner 为主 Agent，沿用既有主题、网络选择器及登录弹窗。

约束：不退出/重启日常客户端，不停止任务，不改其他账号/网络，不删除凭据或重建设备，不复制 Token；正式签名客户端发布遵守统一发布 owner，不能并发换包。

- [x] 从实际 origin/main925947e8创建隔离分支，原工作树干净并保留。
- [x] 定位到已有会话恢复错误与 disconnected 提示覆盖；云实例身份一致且公开接口200。
- [ ] 通过原生原登录 owner 恢复选中网络，读回 ready 及真实设备目录。
- [x] 前端明确认证错误和重新登录入口，普通断网仍保留自动重连。
- [x] 认证失败/恢复/取消/跨账号与跨网络边界91项回归、类型及lint通过；桌面中文/390英文真实渲染交互通过。
- [x] 六项CI通过，PR78已合并；fetch核实远端main `deb26c3c6793e7931b010c9f573a78b5b2b0a6ba` 包含 `d1c57f93`。
- [ ] 新客户端发布/安装及原生新提示验收：独立跟踪，不中断运行任务；既有056制品不覆盖。

下一步：用户已完成登录并选择新账号，继续接入恢复和整体流程梳理，见 `.agent-sync/tasks/codex-network-account-identities-20261016.md`。日志/截图不保存凭据或授权URL，合成UI与真实联网验收分开。

## Current result and blocker

用户实际登录了不同账号，并明确选择继续使用该账号、目录按新账号隔离。原连接保留；新登录已通过原native owner持久化并成为选中连接，但只读真实snapshot为disconnected/KEY_GENERATION_CONFLICT，尚未ready。服务端设备认领按network/device唯一，另一个principal的identity_state返回空；新账号不能认领原账号已绑定的同一设备ID。没有修改服务器、原身份或global deviceId。

真实登录与真实连接验收分开：登录完成，连接仍阻断，不能宣称恢复。原App48419/global48462/HRM sidecar50158与任务前PID及启动时间一致；没有对运行任务stop/restart/logout。

UI验收和复现入口见 `dev-docs/network-auth-validation/README.md`。源码包含明确的认证失效、身份冲突及直接重新登录入口；旧客户端尚未安装这些变化。统一发布owner保持有效，本任务不并发打包/安装。

执行记录：主Agent直接执行，零子Agent、零新增外部模型/推理请求；当前模型/费用及token用量未由运行时提供，不估算收益。后续必须对新账号设备身份方案讨论再实现，不通过旧数据库/凭据篡改绕过安全边界。

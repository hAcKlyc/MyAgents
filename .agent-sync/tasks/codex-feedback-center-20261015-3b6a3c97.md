<!-- git-project-sync-task:version=1 -->
<!-- git-project-sync-task:branch=codex/feedback-center-20261015 -->
<!-- git-project-sync-task:base=ff957fdf078d8e96e732c5b22c89ee2f41337fe9 -->
<!-- git-project-sync-task:status=in-progress -->

# FEEDBACK-001 — 个人菜单中的小助理与云端反馈

## Objective

2026-10-15用户确认此前TITLE-001已提交，新增请求合并小助理到设置下方个人信息菜单，云平台支持反馈；用户纠正是个人菜单，不是通知。复用既有个人登录和本地AI助手，提供MoXBots云端反馈提交/查看与管理员处理。权威仓库 https://github.com/heavenzhang/MoXBots.git，main。不改变通知、用户凭据或无关项目。

## Acceptance criteria

- [x] 重新核验TITLE-001在最新main；当前installed sidecar来源5949b7f1已核验包含TITLE-001；真实Provider标题生成未复验。
- [x] 隔离新工作树，保留其他任务；约定后端/UI互斥所有权。
- [x] 桌面个人菜单含小助理和帮助反馈，去掉MoXBots单独小助理；未登录及窄屏可用，登录/退出回归。
- [x] 云端现有OIDC登录/同源页面，用户只看自己反馈；无需模型或新凭据。
- [x] 管理员回复/状态记录、持久化/幂等/CAS/账号隔离与注销拒绝。
- [x] 实际UI视觉/交互/响应式、独立复验与主Agent关键路径。
- [x] 聚焦测试、构建、最新main同步；CI/PR/远端主干仍待完成。
- [ ] 云端备份/回滚/串行发布、真实账号反馈路径及客户端发布复验。

## Completed

主Agent负责OwnedAccountEntry/GlobalSidebar、feedback-web和admin-web UI；feedback_backend worker独占feedback_store.rs/feedback_http.rs、lib.rs/server.rs，额外实现闭集/admin或/feedback登录返回路径。主Agent独占admin_http.rs仅注册feedback.js静态asset。沿用既有技术边界；Desktop用已有openExternal打开所属服务/feedback，token不跨浏览器也不下发Renderer；web自行已有PKCE登录。

## Verification

桌面DOM82/82、TypeScript、MoXBots Web构建/主题8项、ESLint（排除生成target）、依赖边界（0 errors，16既有warnings）、agent文档4项通过。Rust完整库144passed/4手工fixture忽略；最终feedback专项9passed/1fixture忽略、Clippy及全服务fmt通过。独立UI29项：桌面5、模拟18、真实本地auth/store/HTTP6；仅OIDC为合成身份。详见dev-docs/feedback-independent-review.md。源码hash冻结后仅修复lint空catch注释和格式，模拟与真实联调再次通过。未把这些当生产/真实账号验收。

## Blockers and unknowns

现网云服务与客户端更新owner/版本需复核，不并发部署或覆盖其他owner成果。现网已只读核验运行0bb3服务，目标state权限0700、pending执行/模型0，新库尚不存在；发布前仍需再次核验锁和owner。模型/付费不在反馈提单范围。凭据和真实身份留安全配置，不进入Git。

## Next step

提交候选、推送PR并等必需CI，合入main后验证远端包含；获取Linux CI来源/hash产物。串行安全发布云端，真实OIDC账号复验；客户端进入统一包并验收。跨聊天协调授权问题待用户回复，未对新功能发送消息。

## Execution

采用ai-yaoren-local，主/root负责集成、发布和整体验收；feedback_backend为原生子Agent，不调用外部原因：明确采用ai-yaoren-local纯内置模式。选择依据：后端权限/持久化可独立于前端菜单和页面，并且文件互斥。无模型升级，运行精确变体/推理档及费用未知。独立feedback_ui_review请求gpt-6.1-sol/medium，29项通过；修复管理员确定性重试锁表单和401再认证草稿恢复，主Agent复核整合。Token/费用未测，不声称节约金额。

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
- [x] 聚焦测试、构建、最新main同步；PR44七项CI通过，合入并核验远端main包含。
- [x] 云端备份/回滚/串行发布，真实受控账号反馈闭环5/5。
- [ ] 统一客户端包纳入PR44，实际个人菜单/小助理/反馈入口原生验收。
- [ ] 生产普通多主体隔离单独复验（本轮没有普通测试账号；本地真实AuthStore权限/隔离通过）。

## Completed

主Agent负责OwnedAccountEntry/GlobalSidebar、feedback-web和admin-web UI；feedback_backend worker独占feedback_store.rs/feedback_http.rs、lib.rs/server.rs，额外实现闭集/admin或/feedback登录返回路径。主Agent独占admin_http.rs仅注册feedback.js静态asset。沿用既有技术边界；Desktop用已有openExternal打开所属服务/feedback，token不跨浏览器也不下发Renderer；web自行已有PKCE登录。

## Verification

桌面DOM82/82、TypeScript、MoXBots Web构建/主题8项、ESLint（排除生成target）、依赖边界（0 errors，16既有warnings）、agent文档4项通过。Rust完整库144passed/4手工fixture忽略；最终feedback专项9passed/1fixture忽略、Clippy及全服务fmt通过。独立UI29项：桌面5、模拟18、真实本地auth/store/HTTP6；仅OIDC为合成身份。详见dev-docs/feedback-independent-review.md。源码hash冻结后仅修复lint空catch注释和格式，模拟与真实联调再次通过。未把这些当生产/真实账号验收。

## Blockers and unknowns

唯一客户端打包owner仍在推进0.5.4；“Bots 网络 可用”已登记收包队列并确认其更新分支c46df2b8尚未整合PR44。尚无含本次代码的冻结原生候选和安装证明，不能把已安装5949b7f1宣告为新菜单已生效。新增两个目标聊天的授权问题未获回复；本轮仅沿用用户明确授权的既有“Bots 网络 可用”聊天协调，没有向新目标发送消息。普通生产主体账号未取得，不以同一QA管理员走user/admin两面宣称生产多主体隔离通过。

## Next step

从已登记的统一收包队列串行整合PR44、确认新的冻结源码及原生签名/更新包。实际验收个人菜单小助理、所属issuer /feedback、未登录/退出及窄轨铃铛，再核实安装版本的源码包含main交付。云端保持本次已验证发布；不重复部署或改账号/模型/Host配置。标题真实Provider生成沿原TITLE-001验收单独追踪。

## Execution

采用ai-yaoren-local，主/root负责集成、发布和整体验收；feedback_backend为原生子Agent，不调用外部原因：明确采用ai-yaoren-local纯内置模式。选择依据：后端权限/持久化可独立于前端菜单和页面，并且文件互斥。无模型升级，运行精确变体/推理档及费用未知。独立feedback_ui_review请求gpt-6.1-sol/medium，29项通过；修复管理员确定性重试锁表单和401再认证草稿恢复，主Agent复核整合。Token/费用未测，不声称节约金额。

CI容量修复：最新主干37279ce4已无冲突整合，82 DOM及typecheck再次通过。Owned Linux run38606531983全部验证和产物上传成功，但15分钟时限在post-cache保存阶段取消job；本次仅将完整workflow时限增至20分钟，保留全部门禁并重新运行，取消run不用于发布。

最终整合基线更新到main0c7b8e72（项目看板PR42及接续记录）。仅共享plan末尾双方追加段落冲突，保留两份任务段落；产品文件无冲突。云端发布脚本独立审阅通过，修正204退出断言及原子替换失败清理/回滚证明；5项故障注入通过。未提前发布。

## Main and production delivery

PR44已合入main d7264a43db59249c207736b74991ffd210d50ff3，远端包含候选428e8a23。最终Owned Linux CI38610609896成功，产物源码86c4dfb66dac71b3e45e909b350166839b8acedc与合并main源码树完全相同；binary SHA256 ae7053dd4f83d97d84e4359f31122cfa14ce53182c340deba726fe3f7e1c73a8。运行PID1075503核验相同binary；service/auth配置摘要保持不变。停机一致备份/root/moxbots-feedback-backup-20261015T021459，回滚保留当前业务/认证库。

生产/feedback及三个关联assets与源码逐字节一致且no-store，匿名API401。真实受控QA账号5项通过：同页OIDC提单、管理员大于8KiB中文回复/解决、用户回读、退出204并确认旧token401/重登保留、390px布局；主Agent查看实际截图。第一次回读脚本未等异步refresh结束点了旧列表节点，超时证据保留，补加载完成等待后完整5/5，不改产品或降低断言。生产无模型调用或Host修改。仅2条明确标注受控验收的记录保留。

公开非秘密摘要见dev-docs/feedback-production-validation.md；完整部署、测试脚本、结果和截图在本机私有证据目录 /Users/zhangshaohua/Documents/Codex/2026-10-15/moxbots-feedback-private/，不进入Git。源码/main与云端发布通过；原生客户端交付未完成，task仍in-progress。

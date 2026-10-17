# FEEDBACK-001 正式客户端原生验收

2026-10-15，root使用已安装正式0.5.4 `/Applications/MoXBots.app`，冻结源码e5a05f76974a4962beb0b7de259690daaef08fd5，binary SHA256 c16afdde9d0b0fb2fb52ad464de167c5870282e969dacdce358ef9e63dcef561，包含PR44。使用明确释放的原生窗口，FileLock及唯一owner/token claim和release均核验。没有重新安装、重启或打断其他负责人测试。

- 实际个人菜单位于设置下方，含小助理、帮助与反馈、账号登录/退出及AgentNet/Host管理；独立小助理入口已移除。
- 实际点击小助理打开AI小助理modal，并关闭回到原页面；没有输入或发送模型消息。
- 实际点击帮助与反馈，系统浏览器新页的URL为 https://140.143.183.232/feedback，标题为“帮助与反馈 · MoXBots”；仅以浏览器inventory核对新页元数据，没有操作用户已有浏览器。不是仅阅读源码链接。
- 退出前实时确认四个现存Session均idle/isBusy=false，并从既有受控QA凭据及真实Dex/principal映射核实可恢复同一账号。实际确认“退出此实例”，本地目标owned连接移除、登录按钮恢复，另一个owned账号保留。
- 实际原生登录对话框创建新的PKCE请求，固定正确issuer。Codex内置浏览器以同账号既有凭据完成真实Dex登录/原有身份信息授权；页面显示Sign-in complete，随后原生“检查登录状态”恢复同一principal，selected为新的合法owned连接。
- 原8标签文本完整保留，App PID94409及5个Sidecar PID保留；没有发模型任务、修改Host或覆盖历史/Provider数据。
- 既有独立铃铛实际打开消息中心。通知服务联网状态不在本次证明范围。

菜单验收前后都提示网络暂时离线。账号恢复不等于Host网络ready，本轮没有对此作验收结论。窄rail/900×700适配另有[独立原生QA证据](moxbots-updater-qa-isolation-review.md)；[云端5项真实账号反馈闭环](feedback-production-validation.md)另列，不用其替代本次原生入口/退出恢复。

完整元数据收据与截图位于本机私有目录 `/Users/zhangshaohua/Documents/Codex/2026-10-15/moxbots-feedback-private/native/`：native-gui-results.json、feedback-entry.json、same-account-restore-preflight.json、activity-before-logout.json、account-after-logout.json、account-after-relogin.json、account-restored.png、sign-in-complete.png、notification-entry.png。只提交此非秘密摘要，私有身份、截图和凭据不进入Git。

结束后已按精确owner/token释放窗口，交回原Host联调负责人。FEEDBACK原生路径已通过；TITLE真实Provider及后续统一0.5.5仍由各自验收/发布记录跟踪。

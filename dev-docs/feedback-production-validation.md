# FEEDBACK-001 主干与云端验证

2026-10-15，主Agent执行发布与真实账号验收。PR44合入并确认远端main包含，交付源码 `d7264a43db59249c207736b74991ffd210d50ff3`，七项CI通过。后续任务记录提交不改变此已发布的代码来源。

Owned Linux CI `38610609896`，编译源码 `86c4dfb66dac71b3e45e909b350166839b8acedc` 与main交付源码树完全相同，binary SHA256 `ae7053dd4f83d97d84e4359f31122cfa14ce53182c340deba726fe3f7e1c73a8`。运行进程的路径与摘要复核一致；已有service/auth配置未改。维护锁内停唯一网络写入服务、备份并检查SQLite完整性；回滚只恢复旧binary/unit/nginx，保留当前数据库。

[帮助与反馈](https://140.143.183.232/feedback)及3个关联静态资源摘要与交付源码一致，no-store；未登录API返回401。现有OIDC同页登录和SSO通过。受控QA管理员账号在user/admin两面5项真实浏览器检查通过：

- 用户提交后持久化列表/详情出现。
- 管理员中文回复超过8KiB仍成功，并更新为已解决。
- 用户刷新完成后回读状态与回复。
- 退出204，旧Bearer再次访问401，重新登录仍有记录。
- 390px用户/管理页无横向溢出，主Agent核对实际截图。

未调用模型、未改Host、未增加管理员；受控测试记录明确标注为发布验收，非用户业务问题。完整结果、脚本、备份信息和实际账号截图保存在本机私有证据目录，不提交身份、令牌或凭据。

边界：这不是普通生产主体之间的隔离验收；该分支已有真实本地AuthStore/FeedbackStore多主体权限验证及[独立29项UI报告](feedback-independent-review.md)。首次回读脚本点击了刷新中的旧节点，超时证据保留，补加载结束等待后原断言5/5通过。

客户端统一更新已完成：本机正式0.5.4冻结源码 `e5a05f76974a4962beb0b7de259690daaef08fd5` 干净，实际binary SHA256 `c16afdde9d0b0fb2fb52ad464de167c5870282e969dacdce358ef9e63dcef561` 与正式交付一致，Git ancestry证明包含PR44。2026-10-15 07:14（UTC+8）远端main `c7bab28594a03dfba7167200a90ae73ad0a6b5aa` 包含功能；无需重新打包/安装。

实际原生QA个人菜单显示实例/登录/小助理/帮助反馈，小助理modal打开和关闭、窄rail账号与铃铛独立入口、900×700布局通过，见已合入主干的dev-docs/moxbots-updater-qa-isolation-review.md“附加入口与适配边界”。该早期QA没有真实账号，因此当时不证明所属issuer反馈入口或退出恢复。主Agent随后取得明确串行窗口交接，在已安装正式0.5.4上完成实际入口及同账号真实退出/重新登录；见[原生验收摘要](feedback-native-acceptance.md)。真实Provider标题生成仍待统一负责人的独立modelqa环境，后续0.5.5发布另追踪。

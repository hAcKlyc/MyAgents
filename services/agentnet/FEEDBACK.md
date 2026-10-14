# MoXBots 反馈中心

用户入口为 `/feedback`，桌面“设置”下方个人菜单的“帮助与反馈”打开所属服务。普通用户通过既有OIDC登录后提交问题、建议或使用疑问，并查看自己的记录。小助理保留本地AI会话功能，同样位于个人菜单；云端提单无需模型。

反馈使用已有opaque会话和同源HTTPS；Bearer仅在页面内存中，主动登录跳转在本Tab sessionStorage暂存未完成PKCE事务及有界草稿，回调只向同一principal恢复并清除；不自动提交，异账号不恢复。结果未确认的请求保留原mutation与内容，同账号再认证后仅允许原请求重试。`browserReturnPath`只允许`/admin`或`/feedback`，绑定原登录state；没有开放任意返回URL。账号失效时保留待提交文字并恢复编辑，需要重新登录才能提交；退出清除页面资料并撤销远端会话。

管理员在 `/admin` 的“用户反馈”查看所有记录、回复和更新“待处理/处理中/已解决”。权限仍以私有配置 `administration.admin_principal_ids` 为准；不授予新管理员。未启用administration时，普通反馈可用，管理员API拒绝。

## API与存储

- `GET/POST /api/feedback`：当前用户最近100条、提交。
- `GET /api/feedback/{id}`：本人或管理员查看详情；其他人返回相同404。
- `GET /api/admin/feedback`：管理员最近100条。
- `PATCH /api/admin/feedback/{id}`：原UUID `mutation_id`、`expected_revision`、状态与回复；版本冲突不覆盖。

提交限标题120、描述8000、可选应用版本64个字符，类型为bug/suggestion/help；回复4000字符，JSON传输最多64KiB。用户只提交这些字段，不采集日志、账号凭据、聊天历史或附件。页面提醒不填写密码及密钥。所有显示使用textContent；不执行反馈中的HTML。

原`state_dir`新增`feedback.sqlite3`，0600、network绑定、单库事务与FULL同步。反馈原文、不可变处理历史和原请求回执保留在私有库，不进入Git/服务日志。没有本轮删除/归档API。列表只返回最近100条，旧记录仍可按ID查询；未实现分页。内容与历史保留策略后续由运营方制定，不自动清理。

每次提交/处理用principal+mutation作用域的原body摘要做幂等：重放返回原快照，编号改义返回冲突。网络失败页面保留原编号和原内容，要求重试原请求，不生成新编号猜结果。管理员状态/回复采用CAS，锁内校验当前revision。

## 发布与回滚

仅升级既有网络服务和同源HTTPS页面/API，无新账号或监听端口。Nginx需在原同源配置增加精确`/feedback`、前缀`/feedback/`与`/api/feedback`代理；`/api/admin/`沿用原代理，auth/Dex/Host和下载更新路由保留。公开静态页面无反馈数据；数据API要求实时账号。

发布前核实维护owner、运行二进制/配置、无活动模型调用和悬挂Host执行，获取既有维护锁。停止唯一网络写入服务后备份私有state/config/unit/nginx并做SQLite integrity_check；新库由原服务身份创建。更改unit只切换已验证来源/摘要的二进制，不改账号、模型或Host配置。回滚恢复旧binary/unit/nginx，保留新的feedback.sqlite3及备份，不覆盖为旧认证或业务库；Dex不重启。

验收需分别覆盖：隔离auth/store/API、模拟浏览器、真实已登录账号提交/管理员处理/用户回读/持久化、客户端菜单与真实入口。CI、HTTP200和截图不替代真实路径。

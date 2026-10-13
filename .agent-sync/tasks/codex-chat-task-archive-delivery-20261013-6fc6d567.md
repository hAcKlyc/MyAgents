<!-- git-project-sync-task:version=1 -->
<!-- git-project-sync-task:branch=codex/chat-task-archive-delivery-20261013 -->
<!-- git-project-sync-task:base=2796b13eeb1ad69c1b9bd529b7108ecf534a4f7a -->
<!-- git-project-sync-task:status=in-progress -->
<!-- git-project-sync-task:scaffold=false -->

# Task: MOXBOTS-CHAT-ARCHIVE-20261013 · 左侧聊天任务归档

## Objective

MOXBOTS-CHAT-ARCHIVE-20261013，由当前Codex实现左侧聊天任务归档、已归档列表及恢复，保留聊天和文件，完成远端main交付及保留Host试用能力的macOS本机安装/原生验收。用户已选择当前Agent、左侧聊天范围。

## Acceptance criteria

- [x] 默认全部/收藏隐藏归档；独立已归档视图可打开/恢复，含自动化来源及已归档工作区；中英及窄窗支持。
- [x] 复用SessionStore/PATCH/元数据事件；不删除聊天文件、不停止运行、不改变recency/favorite/pin；新fork不继承归档。
- [x] 类型/lint、156项回归、Web/server/bridge/CLI构建及源头六项CI通过。
- [x] PR #19合main bd567cd666a97e6b09d7c2e81270378b6767b899；远端已核验59037d91源头祖先及相同Git tree。
- [x] 非实现者源码复审及原生归档/恢复、约950px rail/flyout/Escape/focus验收；主审正常退出重启、历史/附件及恢复保全。
- [x] 修正历史安装基线为实际接受的b116404e；33992eb0试用源保留其Host/凭据能力，备份/回滚/签名及源码制品对应已核验，可逆安装完成。
- [x] 用户选择回退b116404e；原应用摘要/严格签名/唯一进程及两设备在线均已核验，未请求系统密码。
- [ ] 凭据修复后与归档联合更新及整包验收；按用户选择延期，由原凭据修复任务接续。

## Completed

- 正式工作树先通过start/task-init，再迁移早期候选修改；没有reset/clean、覆盖其他任务的工作树。早期gate失败已如实保留。
- 主Agent负责renderer、集成、main、打包/安装及主审；archive_persistence负责后端，archive_review独立源码/原生审阅。请求Luna/medium，实际精确变体/用量/费用未知，无外部模型调用。
- 审阅两项问题（归档工作区可达性、过期响应假成功）已修复，最终功能源码59037d91；原生制品源33992eb0，不能称二者字节级相同。
- 交付及分层证据：dev-docs/chat-task-archive-delivery.md、chat-task-archive-review.md。实际安装/摘要在本机moxbots-chat-archive-evidence/INSTALLED-APP-UPDATE.json，制品与回滚留本地，不进Git。

## Verification

- 156项回归按侧栏61、搜索16、偏好5、共享缓存34、客户端10、策略2、存储5、V2并发/fork23分池运行；活动绑定和跨进程字段保存被覆盖。源头CI run38371359223六项成功；纯交付文档提交不声称重跑该完整矩阵。
- 主审隔离renderer+真实SessionStore在1280×720/900×800验收；独立原生及主审重启均仅操作合成聊天，未调用模型或发送任务。
- 正常退出后CLI确认原生进程为零，再启动已安装制品；归档保留，恢复后收藏/置顶时间、两消息及附件不变。附件85字节、hash不变；0 B卡片来自夹具未填大小。
- PATCH拒绝非布尔400已实现；直接无效参数route测试未单独执行。真实运行中执行不中断由源码无stop调用及回归支持，未额外调用模型制造运行任务。

## Blockers and unknowns

- 旧b116404e安装前AgentNet两设备在线，新33992eb0停在系统凭据一次授权。未点击授权或再索取密码；网络回归未通过，整包发布验收尚未完成。
- 用户已选择回退旧在线版、待凭据修复后与归档一起更新；回滚和两设备在线已实测通过。安装权交回原修复owner继续既有授权，后续联合包需同步main保留归档。
- 既有本地试用证书严格签名通过，尚未Apple公证；不称公开发行。Documents内旧包副本被File Provider附加FinderInfo，严格签名失败；实际回滚使用原始隐藏包且前后严格签名通过，不能误用该副本。

## Next step

归档源码/验收及用户选择的回滚已交付；联合发布等待原owner完成凭据修复，同步origin/main构建后重新验证归档、重启与网络自动恢复。当前旧版b116404e不含归档入口。

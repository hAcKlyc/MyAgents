<!-- git-project-sync-task:version=1 -->
<!-- git-project-sync-task:branch=codex/chat-task-archive-delivery-20261013 -->
<!-- git-project-sync-task:base=2796b13eeb1ad69c1b9bd529b7108ecf534a4f7a -->
<!-- git-project-sync-task:status=in-progress -->
<!-- git-project-sync-task:scaffold=false -->

# Task: MOXBOTS-CHAT-ARCHIVE-20261013 · 左侧聊天任务归档

## Objective

MOXBOTS-CHAT-ARCHIVE-20261013，由当前Codex实现左侧聊天任务归档、已归档列表及恢复，保留聊天和文件，完成远端main交付及保留Host试用能力的macOS本机安装/原生验收。用户已选择当前Agent、左侧聊天范围。

## Acceptance criteria

- [x] 默认全部/收藏不显示归档；已归档视图独立、可打开/恢复，包含隐藏自动化来源；中英、窄窗/flyout支持。
- [x] 复用SessionStore/PATCH及元数据事件；归档/恢复不删内容、不停进程、不改recency/favorite/pin。
- [x] 持久化重载、活动绑定并发写、fork新目标不继承归档、失败重试聚焦验证。
- [ ] 主审实际原生路径及非实现者UI审阅。
- [ ] 类型/lint/相称回归/build/PR CI，最新main同步、合并、远端祖先核实。
- [ ] 保留Host试用基线1c3449ab与已有公开服务构建配置，原生包备份/回滚/安装和运行源码对应核实。

## Completed

- 最新origin/main基线2796b13e，旧brand工作树只读，安装基线参考当前/Applications/MoXBots.app及brand-host-trial。
- 初次开发工作树start gate误在编辑后执行，明确失败；原改动保留。新正式交付工作树先通过start/task-init，再迁移候选patch；不reset/clean任何工作树。
- 主Agent负责renderer/集成/验收/交付，archive_persistence负责后端，archive_review只读审阅及报告，均互斥写范围。请求worker配置Luna/medium；实际计费用量未知，不调用外部模型。

## Verification

- 候选DOM GlobalSidebar59、preference unit5（共64），后端storage5、metadata policy2、transcript store23通过；tsc通过。扩大历史搜索共享菜单回归初次3项旧菜单断言失败，保留完整菜单断言并加入归档入口后DOM75项通过；合计110项相称回归通过（分池）。原始临时日志不作为已发布证据。
- PATCH非布尔archived拒绝400已实现，直接路由无效参数测试尚未完成。

## Blockers and unknowns

- 原应用AgentNet界面显示系统凭据需要一次授权，既有问题；本任务不修改凭据/账号/网络，不声称Host业务验收。
- 原生UI、CI与安装门槛仍待完成；尚未发布。

## Next step

冻结候选审阅、在安全合成聊天上运行原生路径，完成CI、main和本机交付。

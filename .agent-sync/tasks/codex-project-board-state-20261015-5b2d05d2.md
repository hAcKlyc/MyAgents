<!-- git-project-sync-task:version=1 -->
<!-- git-project-sync-task:branch=codex/project-board-state-20261015 -->
<!-- git-project-sync-task:base=c7bab28594a03dfba7167200a90ae73ad0a6b5aa -->
<!-- git-project-sync-task:status=in-progress -->
<!-- git-project-sync-task:scaffold=false -->

# Task: MOXBOTS-PROJECT-BOARD-004: trusted execution state and four-stage board

## Objective

用户确认 PB-003 v3：待开始→执行中→待确认→已完成，历史仅归档；同时修复 HRM 仍执行却显示空闲。当前 Agent 拥有集成、验收、主干交付；state_review 独占后端状态观察修复，之后独立审阅前端。未授权中断日常活跃任务；正式安装须满足既有空闲门禁。

## Acceptance criteria / To Do

- [x] 四列顺序及待确认细原因；列表、搜索、窄窗和详情一致。
- [x] 已完成留看板；历史仅归档；恢复完成任务不重新执行。
- [x] 后台子任务运行不得显示idle；恢复/排空/不健康实例不可伪装idle。
- [x] 仅活动可见看板有界刷新；旧请求不可覆盖新值；失效保留上次状态并提示。
- [x] 相关unit/DOM、类型、lint、构建及独立UI/代码审阅。
- [ ] 同步最新main、PR/CI、合并推送并核实远端主干。
- [ ] 发布前核实统一包owner/版本/活动任务/备份回滚；隔离验证、正式包与真实用户路径分别留证。

## Completed

- 只读核实旧看板源码、实际客户端0.5.4和统一0.5.5 dirty工作区；未改他人工作区。
- 以用户既往确认的 https://github.com/heavenzhang/MoXBots.git，从远端main c7bab285建立隔离分支，observe/start/task-init通过。
- 已核实两条可误报idle的代码路径：builtin后台子任务未入观察；Sidecar非健康过渡期被无owner折为空闲。有界读取日常HRM日志证实历史root idle期间当前Query子任务仍执行；最新读取的终态为07:17:37，不能断言截图精确时刻或此刻仍在运行。未读取/修改业务正文与凭据。

## Verification

161项相关unit/DOM通过；Node24 typecheck、完整lint通过（depcruise既存16 warnings/0errors，agentdocs4pass）；web/server构建通过。独立实际React检查四列、history/archive/restore、成果确认/重跑边界、540覆盖/焦点/返回、1440/1024无溢出。发现history跨scope需要处理计数已修。见dev-docs/project-board-validation/state/。

Rust恢复持久化实际测试1pass；本机CLT6.3.2 ManifestAPI私有接口陈旧，通过临时public-interface shadow与LIBRARY_PATH单命令修正，不改系统/registry。CLIProxy按现有签名脚本准备；其他非执行资源路径按CI fixture，不是正式打包制品。Task全组82/82与owner healthy/absent/starting/dead/draining/recovery两项测试2/2通过。

原始测试日志位于本机/tmp/board004-*（临时）；稳定摘要与合成截图保存仓库validation/state。日常CLI状态查询被EXTERNAL_CLI_TOKEN_REQUIRED拒绝；未绕过或借用他人token。

## Execution record

主Agent实现renderer/projection与Task恢复；state_review只实现session observation/Runtime/Rust manager相关文件，不改UI/Task。请求worker gpt-6.1-sol/high，工具未额外确认实际运行型号/用量。不调用外部原因：采用ai-yaoren-local纯内置模式。
UI审阅基准：PB-003 v3；1440/1024/800内容宽度及必要窄窗；四列、未知/阻塞/完成、归档恢复、导航与焦点。审阅者为非UI实现者state_review。

## Blockers and unknowns

本轮只读查看过日常GUI与有界HRM日志，未操作真实记录；统一0.5.5 owner工作区活跃且dirty。不得将本地/合成验证当作客户端真实验收。

## Next step

汇总Rust与独立review最终结果，提交并同步最新main后跑CI，交付远端main；统一0.5.5纳入与原生真实HRM复验单列等待负责人串行窗口。

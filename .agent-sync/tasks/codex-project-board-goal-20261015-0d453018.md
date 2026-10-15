<!-- git-project-sync-task:version=1 -->
<!-- git-project-sync-task:branch=codex/project-board-goal-20261015 -->
<!-- git-project-sync-task:base=5ebf2979c77e0d358fe6b3980fb57427028c453c -->
<!-- git-project-sync-task:status=in-progress -->
<!-- git-project-sync-task:scaffold=false -->

# Task: MOXBOTS-PROJECT-BOARD-006: Goal-aware board grouping

## Objective

修复截图任务「检查薪资前端构建及新测试服务器状态」在 Goal 仍执行时被分到已完成。只读复用 Rust SessionGoalManager，保留 Task/Goal 各自权威；不改用户任务状态、不触发模型执行。本 Agent 单独负责实现、UI检查和主干交付；任务范围有限，零子Agent。

## Acceptance criteria / To Do

- [x] active/isExecuting Goal 覆盖旧 done/archive Task 显示；轮次间 idle 不代表目标完成。
- [x] paused/blocked/canceled/unknown 独立待确认；complete Goal 不擅自完成关联Task。
- [x] 有界刷新、Goal变更事件、无metadata的关联Session、失败不伪完成、归档前重新读Goal。
- [x] 单元/DOM与实际React合成页面验证；类型/lint/web build。
- [ ] PR完整CI、同步最新main、合入并核实远端包含成果。
- [ ] 客户端发布和真实任务复验（下方门禁）。

## Verification

43项相关unit/DOM通过；Node24 npm run typecheck、完整lint（既存depcruise16warnings/0errors）与生产web build通过。实际React UI见dev-docs/project-board-validation/goal/；隔离合成API只验证分组和交互，不等于原生业务验收。UI由主Agent亲验（有限状态修复，无布局变动）；无独立审阅或模型用量测量。

## Release boundary / unknowns

只读检查共享work/unified-055-20261015/STATUS.json：统一0.5.5由现有owner冻结52bf6160构建；日常客户端记录存在running/isBusy任务，禁止busy时退出安装。本任务不修改该owner工作树、不退出/安装日常App，不变更服务器stable。此记录是既有证据，不冒充本轮实时执行探测。补丁需后续正式候选纳入及安装后的同一任务只读复验，未完成前不称客户端已修复。

## Next step

完成PR/main交付后，在独占原生窗口和有效发布/回滚门禁下将本补丁纳入后续正式包，核对同一真实Task/Session/Goal分组。

## Integration submission

PR https://github.com/heavenzhang/MoXBots/pull/60 。自查补充无metadata但等待审批的Session必须优先待确认（不能被active Goal遮住）；43项unit/DOM复跑通过。实际React七条旅程通过，截图已目视检查，无布局改动。CI和主干结果以远端实际检查为准。

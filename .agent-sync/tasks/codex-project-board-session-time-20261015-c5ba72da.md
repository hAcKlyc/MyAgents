<!-- git-project-sync-task:version=1 -->
<!-- git-project-sync-task:branch=codex/project-board-session-time-20261015 -->
<!-- git-project-sync-task:base=7ec5b6d47c968e7dbde71b8dbf1ad29b52b644c4 -->
<!-- git-project-sync-task:status=ready-for-review -->
<!-- git-project-sync-task:scaffold=false -->

# Task: MOXBOTS-PROJECT-BOARD-002: session execution time and direct navigation

## Objective

MOXBOTS-PROJECT-BOARD-002：会话卡片显示当前执行轮次耗时，直接进入原会话；保留详情和最近更新时间。

## Acceptance criteria

- [x] 从 SessionEngine 的当前 product transcript turn 读取开始时间，内置/外部均支持；不以更新时间替代。
- [x] 执行中/等待答复显示本轮墙钟时长，快照过期后冻结并提示刷新；空闲/缺失时间不伪造。
- [x] 卡片、列表、详情可读；单会话快捷按钮打开原 Session，不发送消息，不嵌套按钮。
- [x] 主 Agent 负责原布局、宽/窄窗口、键盘和导航回归；模拟与原生证据分开。
- [x] focused tests、typecheck、lint、build、CI 通过；合入 main 并核实远端。

## Completed

- PR42合并到main，集成提交58b6720f296484c8ccd3ada08fc38695827df016；git ls-remote与origin/main一致，源码树与验收e22b7b7c完全一致。未安装/发布新包。

- 核实指定仓库与干净隔离 worktree，从 main 7ec5b6d 创建；代码/UI质量由主 Agent 负责，零子智能体，改动紧密且有限。

## Verification

- Node24：154项组合相关unit、typecheck、完整lint、生产build:web通过。
- CI首次因2项runtime-boundary拒绝adapter直接import内部owner；已改正式facade读取，边界和计时复验通过。最终与PR43/main37279ce4组合后的head e22b7b7c1c4ad6f4ee1fb56a9f3fc36ceda3ecf4，完整CI38606936447六项全部通过。
- MoXBots profile实际React隔离合成验收14组通过；证据 `dev-docs/project-board-session-time-acceptance.md` 和 `dev-docs/project-board-validation/session-time/`。
- 同步最新origin/main ff957fdf，无产品文件并发差异；base元数据仍记录任务初始7ec5b6d。

- start/task-init 同步门禁通过，明确远端 https://github.com/heavenzhang/MoXBots.git。

## Blockers and unknowns

- 原生更新由「MyAgents 桌面端 Host 远程管理改造」任务维护；最新只读状态显示更新器无法确认会话owner活动状态，仍保留准入门禁，未通过A→B升级。
- 用户已明确授权联系实际owner（01a12bc2-907a-7702-b6dd-788225c5dfe4）并协调更新；已发送收包和原生独占窗口请求。负责人冻结候选e5a05f76974a4962beb0b7de259690daaef08fd5已包含本次源码，10个关键文件哈希与验收版本一致。A3→B3原生窗口尚未释放，未并发换包/退出客户端。
- QA明确禁止模型执行，原生准确导航/空态与真实执行计时分开验收；目前无现成真实Provider计时样本，不伪造执行状态，也不调用收费模型。

## Next step

等待更新owner明确交接QA窗口及最终候选/PID/源码，验收进入原会话/回看/空闲时长；真实执行时长须现成合法执行样本，无样本保留未覆盖。统一包安装/官网发布由既有owner串行推进。

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
- [ ] focused tests、typecheck、lint、build、CI 通过；合入 main 并核实远端。

## Completed

- 核实指定仓库与干净隔离 worktree，从 main 7ec5b6d 创建；代码/UI质量由主 Agent 负责，零子智能体，改动紧密且有限。

## Verification

- Node24：132项相关unit、typecheck、完整lint、生产build:web通过。
- 实际React隔离合成验收14组通过；证据 `dev-docs/project-board-session-time-acceptance.md` 和 `dev-docs/project-board-validation/session-time/`。
- 同步最新origin/main ff957fdf，无产品文件并发差异；base元数据仍记录任务初始7ec5b6d。

- start/task-init 同步门禁通过，明确远端 https://github.com/heavenzhang/MoXBots.git。

## Blockers and unknowns

- 原生更新须与客户端 owner 协调，本地合成页面不替代安装客户端验收。

## Next step

等待PR当前head CI，合入main核实远端；交统一更新owner收包并补原生验证。

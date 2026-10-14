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

- PR42合并到main，集成提交58b6720f296484c8ccd3ada08fc38695827df016；git ls-remote与origin/main一致，源码树与验收e22b7b7c完全一致。该时点尚未安装/发布新包；后续原生/发布进展见本记录末尾。

- 核实指定仓库与干净隔离 worktree，从 main 7ec5b6d 创建；代码/UI质量由主 Agent 负责，零子智能体，改动紧密且有限。

## Verification

- Node24：154项组合相关unit、typecheck、完整lint、生产build:web通过。
- CI首次因2项runtime-boundary拒绝adapter直接import内部owner；已改正式facade读取，边界和计时复验通过。最终与PR43/main37279ce4组合后的head e22b7b7c1c4ad6f4ee1fb56a9f3fc36ceda3ecf4，完整CI38606936447六项全部通过。
- MoXBots profile实际React隔离合成验收14组通过；证据 `dev-docs/project-board-session-time-acceptance.md` 和 `dev-docs/project-board-validation/session-time/`。
- 同步最新origin/main ff957fdf，无产品文件并发差异；base元数据仍记录任务初始7ec5b6d。

- start/task-init 同步门禁通过，明确远端 https://github.com/heavenzhang/MoXBots.git。

## Blockers and unknowns

- 更新owner已完成隔离A3→B3升级并明确释放窗口；本Agent已补验0.5.4/B3原生卡片/列表/详情导航、回看和空闲状态。04:12明确交回QA窗口，原mino三行草稿保持，没有模型发送。精选证据 `dev-docs/project-board-validation/session-time-native/`，原始AX与截图 `/tmp/moxbots-board-native-e5-20261015`。
- 源码e5a05f76974a4962beb0b7de259690daaef08fd5包含PR42，10个关键文件与已验收0c7b8e72相同；实际运行主二进制SHA256与B3匹配。当前main已含PR46/0c85b571，合并后5文件147项看板计时/owner/runtime boundary测试复验通过。
- QA明确禁止模型执行，原生导航/空闲与真实执行计时分开；无现成合法Provider计时样本，不伪造执行状态，不调用收费模型。
- 正式统一包签名公证/更新服务由01a12bc2-907a-7702-b6dd-788225c5dfe4负责；官网由01a12b99-7b38-78b1-831f-9c60257d386a负责。用户已授权联系两者，窗口已交回。官网报告0.5.4已发布，PR47和公网全量归档校验仍由owner收尾；本Agent未升级日常客户端。

## Next step

原生验收记录随本次提交交付；与两位owner核实正式发布/安装状态。真实计时缺口待合法现成执行样本补验，不能宣告全部原生计时通过。

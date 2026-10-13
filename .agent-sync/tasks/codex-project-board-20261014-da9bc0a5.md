<!-- git-project-sync-task:version=1 -->
<!-- git-project-sync-task:branch=codex/project-board-20261014 -->
<!-- git-project-sync-task:base=43994b75ca9278420ecd352af2e0cc663f4a7cdc -->
<!-- git-project-sync-task:status=in-progress -->


# Task: MOXBOTS-PROJECT-BOARD-001: workspace execution overview from PB-002

## Objective

实现用户已批准的 PB-002 工作区执行看板。当前Agent直接执行；仓库由用户明确确认 https://github.com/heavenzhang/MoXBots.git。主线程实现/集成/验收/主干交付；原生安装与已有活跃owner串行。

## Acceptance criteria / To Do

- [x] 核对仓库/最新main/指令/原型/数据authority，并创建隔离worktree。
- [x] 项目入口不改变展开或原对话行为；每工作区独立看板Tab。
- [x] Task与未关联Session均可见，关联会话不重复计数，不把idle当完成。
- [x] 四组状态、待开始入口、紧凑列表、搜索、窄面板分组和侧边详情。
- [x] run/rerun/status/get/doc使用既有owner接口；问题与权限回原会话处理。
- [x] 实际React页面点击、错误恢复、草稿/筛选保留、键盘与适配检查及独立UI审阅。
- [x] 同步最新main后typecheck/lint/99项相关用例/12组隔离交互/MoXBots build:web通过。
- [ ] CI及远端main核验。
- [ ] 发布制品/回滚与当前安装owner核实；真实运行版本和用户路径验收。

## Decisions

Rust TaskStore/TaskApplication保持任务authority。Session列表不含持久实时状态。沿用现有 `session/state` owner-addressed只读接口做有限项目快照；不启动Session，不增加模型Turn，不持续轮询全部Sidecar。快照时间和失败必须可见。普通未关联对话单独保留；idle或无owner只表示未在执行，不代表业务完成。

Tab由现有App/module registry统一管理，新增工作区看板variant，无第二份全局当前页面。问题/权限不跨Tab裸响应，进入原Chat执行既有request-owner handlers。实际字号/主题遵循DESIGN.md，不能照搬原型9/10px字阶或硬编码深色。

## Completed

观察/start/task-init门禁通过；base 43994b75ca9278420ecd352af2e0cc663f4a7cdc。依赖复用既有node_modules，无重新下载。原型及其QA在本地PB-002目录，产品改动只在此隔离worktree。

## Verification / execution record

- 只读数据审计：board_data_audit，请求gpt-6-luna/medium；无写入/部署，报告Task/Session及activity来源。精确运行模型/用量未获工具确认。
- 主Agent负责整体；独立UI审阅后续启动，避免同时占用真实App/浏览器。
- API/布局/真实联调/发布分别记录，不用fixture代替生产证据。

## Blockers and unknowns

当前App有Host/凭据owner活跃，禁止并发换包、退出或改凭据。安装阶段需核实实际owner状态与具体包来源。没有新增付费模型执行授权，不为UI验收启动模型任务。

## Next step

固定产品改动并同步最新main；验证合并后结果与CI、交付远端主干。原生包与真实路径仍需统一安装owner串行交接。

## 当前实现与审阅

真实API接线/产品组件完成，12组隔离交互通过；独立board_ui_review（请求gpt-6.1-sol/medium）完成深浅主题与4视口、失败恢复、回程和焦点审阅，两P2经一轮修复关闭。无真实Task写入、模型执行、Native联调或生产验收。报告与runner见dev-docs/project-board.md和project-board-review.md。完整typecheck/lint/build:web先前通过，修复后复验及同步最新main继续进行。

阶段验证：typecheck、完整lint（既有16条dependency warnings、0 errors）与默认/MoXBots build:web通过。状态/API等20项unit、77项既有DOM及新增入口2项，共99项相关用例已通过（新增rail测试修正初始未展开fixture，发现并修复board入口收起flyout）。12组真实React隔离交互通过，独立UI一轮修复复验、追加rail入口检查通过；真实后台/Native/生产不计通过。

集成结果：并行main只在plan追加产生冲突，双方记录均保留，产品看板/入口相对功能提交没有漂移。合并后typecheck、完整lint、99项unit/DOM、12组实际React隔离交互、MoXBots build:web成功。PR31及handoff门禁已通过；最终CI/main与统一Native包继续追踪。源与产物hash见dev-docs/project-board-validation/source-hashes.json，hash证明代码/制品对应，不代表安装或真实路径验收。

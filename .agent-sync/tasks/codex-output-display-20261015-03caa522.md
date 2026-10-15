<!-- git-project-sync-task:version=1 -->
<!-- git-project-sync-task:branch=codex/output-display-20261015 -->
<!-- git-project-sync-task:base=5ebf2979c77e0d358fe6b3980fb57427028c453c -->
<!-- git-project-sync-task:status=in-progress -->

# Task: MOXBOTS-OUTPUT-001 阶段化输出展示

## Objective

按用户确认的截图评审方向优化桌面聊天输出：阶段归组、状态区分、结果摘要、工具详情默认折叠。沿用已有 transcript owner、语义 token、模型和工具详情，不新增模型调用，不改持久化。

## Acceptance criteria / To Do

- [x] 核对权威仓库、main、并行工作树和源码，建立隔离分支。
- [x] 确定分组/状态契约：原始顺序连续阶段；工具返回不代表业务完成；历史缺失结果明确未确认。
- [x] 实现阶段卡片、动作优先、状态文字与统计摘要、默认折叠/可回折详情。
- [x] 相关单元/DOM测试、类型检查、lint、MoXBots web build。
- [x] 实际React页面交互与浅/深色、窄窗验收；非实现者复核。
- [ ] 同步main、PR/CI、合入和核实远端main。
- [ ] 原生统一发布/真实会话路径：核实既有发布owner，独立记录，禁止并发操作日常App。

## Completed

基线main 5ebf2979c77e0d358fe6b3980fb57427028c453c。现有BlockGroup只做首/尾折叠；ProcessRow工具名优先，普通工具active依赖最后一项。实现保持正文边界、媒体artifact外提/process折叠、子Agent锚点与滚动layout通知。

## Verification

91项unit、169项DOM通过；完整类型/lint及MoXBots web构建通过，最终小修后类型/lint/web构建复验通过。实际React主审及独立380浅深色/默认英文交互通过。一轮摘要结果归属歧义已修复并复验。证据`dev-docs/output-display/acceptance.md`及合成截图；不代替原生/真实Provider路径。

## Execution record

主Agent负责实现、集成、主审、主干交付；output_review独立只读代码/UI复核，按ai-yaoren-local指定gpt-6.1-sol medium，原因是状态组合与折叠/流式交互涉及复杂判断。不调用外部原因：采用本地纯内置模式，任务不需要外部模型。费用/精确用量未知。

## Blockers and unknowns

原生发布属于统一窗口；用户已授权通知，负责人已登记PR62归入0.5.6待集成，不纳入冻结0.5.5。已合并PR61版本依赖4f0ccc6d到本分支（不操作其远端分支），保留0.5.6；已同步main bf1851e4。日常App未占用、不换包、不调用付费Provider。

## Next step

PR62（产品head3be8f8ae）等待CI及main；本分支已纳入版本依赖4f0ccc6d/0.5.6及main bf1851e4；当前最终CI待运行，合入后核实远端main并发送最终锚点给统一负责人。

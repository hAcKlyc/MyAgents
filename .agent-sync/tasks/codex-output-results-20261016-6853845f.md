<!-- git-project-sync-task:version=1 -->
<!-- git-project-sync-task:branch=codex/output-results-20261016 -->
<!-- git-project-sync-task:base=925947e8252467392685e5b9dc6231476d1e0d75 -->
<!-- git-project-sync-task:status=in-progress -->

# Task: MOXBOTS-OUTPUT-002 result-first progress, timing and evidence

## Objective

MOXBOTS-OUTPUT-002：在现有聊天执行区落实用户接受的六项优化，并按追加要求优先展示结果与进展、每项执行时间、低干扰质量参考。范围为既有 transcript 时间事实、renderer 投影与呈现、TODO 摘要；不新增模型调用、存储/执行 owner 或诊断评分。

## Acceptance criteria

- [x] 主视图不重复工具/方法名称和动作明细；已完成阶段紧凑呈现结果、当前进度，保留失败/中断/未知与子任务锚点。
- [x] 同文件连续成功修改聚合，明确统计为操作累计或最近一次，不能冒充工作区净变更；原始每次结果与时间可查看。
- [x] 时间来自既有后端事件 owner，区分开始、终止、最近活动与已用时；旧历史缺失明确未知，重开不重置，计时不代表 API 健康。
- [x] 质量参考只展示可观察检查结果、失败/未确认和已有用量，内容质量无评估时明确未评估，不编造分数/重试/吞吐。
- [x] TODO 展示实际进行项；输入横条已由main PR76修复，复验相关布局而不重复覆盖。
- [x] 相称unit/DOM/构建、实际React视觉/交互/窄窗与非实现者审阅通过。
- [ ] 同步最新main、CI、合入并核实远端main包含成果；发布请求排入既定统一owner下一未冻结批次。

## Completed

- [x] 仓库/remote/工作树与origin/main核对；base 925947e8252467392685e5b9dc6231476d1e0d75，独立任务worktree，不修改其他树。
- [x] 已核读项目地图、计划、CLAUDE、设计及架构相关章节；observe/start/task-init门禁通过。
- [x] 代码实现；[x] 合成unit/DOM与真实临时文件持久化；[x] 实际React渲染/交互；[ ] 真实Provider/原生时间链路（统一owner）；[ ] CI/main；[ ] 原生发行/真实用户路径（统一发布owner）。

## Verification

- 证据在 `dev-docs/output-results/acceptance.md`、`review.md`及evidence/：158项定向、172项消息输入、25项Store通过；额外36项状态/链接回归有重叠，不叠加总数。typecheck、lint、MoXBots web构建/8主题、server构建通过。初始用户截图不提交。
- 主Agent实际IAB补查真实SimpleChatInput+TODO组合：749×974 viewport/380内容栏，横轴0、纵向滚动1455.56、TODO在输入之上；独立IAB范围与后续失效边界在review.md。
- 1000个同epoch秒delta的额外timing操作1000→0，跨秒和finish各1，开始结束精确毫秒；活动采样<1s。
- 环境采用既有Node24，不降级devEngines；最初系统Node22 npm-ci被正确拒绝，改用 `/opt/homebrew/opt/node@24/bin`。

## Blockers and unknowns

- 既定统一部署聊天 `01a12bc2-907a-7702-b6dd-788225c5dfe4` 独占own updater发布；冻结056不变。本任务不操作日常App、不自行重启或发消息给其他聊天。
- 原生/实际业务路径待统一打包验收，不能由合成UI或loopback替代；无额外付费模型请求。
- 单主Agent实现UI/集成/主审；timing_owner（请求gpt-6.1-sol medium）实现跨runtime时间事实，之后另设非实现者UI审阅。Token/费用未由runtime暴露，未知。

## Next step

- 已合入最新origin/main e872eb53（保留并发网络恢复与账号规划）；组合门禁进行中，下一步PR/CI、main包含核验。发布请求由统一owner处理。

## Deployment request

- Required: queued，既有macOS arm64桌面own updater下一未冻结批次（0.5.7队列），不回写已冻结056。
- 目标行为：默认结果与进度、逐项开始/结束/耗时和最近活动、低干扰质量参考、同文件合并和TODO当前项。无需配置迁移、无需新增权限/凭据，无模型请求成本。旧历史缺时间显示未记录。
- 依赖：纳入本任务最终main提交，沿现有签名/公证/备份/回滚流程。原生验收真实普通对话/历史重开/子任务再激活、长结果/输入/TODO，质量口径不得升级为业务通过。
- Deployment chat: 01a12bc2-907a-7702-b6dd-788225c5dfe4；只保存队列请求，未获本轮跨聊天发消息指令，因此未发送/唤醒。

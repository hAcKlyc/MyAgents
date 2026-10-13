<!-- git-project-sync-task:version=1 -->
<!-- git-project-sync-task:branch=codex/bots-admin-lifecycle-prototype -->
<!-- git-project-sync-task:base=5ee8f86200710c50e10f1a9c1df5cb95eba27237 -->
<!-- git-project-sync-task:status=ready-for-review -->

# Task: BOT-ADMIN-LIFECYCLE-PROTOTYPE-20261013

## Objective

完善管理员Bots原型与规划：新建、配置、启停、删除、所属用户/Host分配；不开发真实服务。延续用户指定MoXBots仓库和ai-yaoren-local。

## Acceptance criteria

- 生命周期与归属分配完整模拟，列表、详情、Host/用户统计、审批和审计一致。
- 停止/迁移/删除后的受保护操作拒绝；私人上下文不转移，旧审批不复活，Host状态独立。
- 独立视觉、交互、三视口验收与主审关键路径通过，文档/脚本符合仓库检查。
- 规划/TODO/接续提交并推送，当前头CI成功后交付并核验远端main，原型可打开。

## Completed

- 核验main 5ee8f862及其CI均成功，复用已完成任务的干净隔离worktree建立新分支；start/task-init gate成功。
- 明确模拟范围、状态/权限、文件所有权和验收矩阵，设计约定见原型LIFECYCLE-DESIGN-BRIEF.md。

## Verification

- Git fetch/push目标与用户已指定URL一致；最终原型hash4f963…独立视觉/交互/响应式与主审通过，正式1轮修复；完整lint、脚本语法、链接及差异检查通过，main交付待验。

## Blockers and unknowns

- 无授权或环境阻断。真实Host操作、身份鉴权、持久化与生产开发不在本轮范围。
- 复用实现Luna/medium、独立审阅Sol/medium请求配置；实际型号/effort/token/费用未知，无外部调用。

## Next step

推送本任务并通过handoff gate，等待当前头部CI；同步最新main后按审查流程合入并核验远端源码与原型hash，关闭本次交付记录。

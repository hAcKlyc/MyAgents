<!-- git-project-sync-task:version=1 -->
<!-- git-project-sync-task:branch=codex/unified-055-modelqa-20261015 -->
<!-- git-project-sync-task:base=c7bab28594a03dfba7167200a90ae73ad0a6b5aa -->
<!-- git-project-sync-task:status=in-progress -->


# Task: MOXBOTS-055 unified isolated model acceptance and formal release

## Objective

MOXBOTS-055-UNIFIED-ACCEPTANCE：隔离真实模型原生验收环境、跨聊天串行验收、统一0.5.5正式构建与安全客户端更新。Root为整合和发布owner。

## Acceptance criteria

- 独立modelqa身份/目录/端口与OS凭据拒绝；updaterqa仍拒绝模型。
- NEXT-PROMPT/FEEDBACK/TITLE/Host必要真实路径分别验收，保留不可用边界。
- 所有相关源码main/CI、0.5.5正式签名公证和真实安全更新、生产服务字节核验。

## Completed

- 已核实canonical repo/main和既有0.5.4冻结；已建立独立worktree并协调三位既有owner。profile实现/阶段独立审阅通过；真实模型/Host/UI/正式发布尚未完成。

## Verification

- git-project-sync start/task-init PASS，base c7bab28594a03dfba7167200a90ae73ad0a6b5aa。
- 7 build、最终22 modelqa/SDK unit、selector117、profile integration7与类型/scopedlint通过；独立P1/P2修复后复验通过。Rustrelease编译仍进行中。

## Blockers and unknowns

- 真实native模型/Host待验；profile已实现尚未发布/启动；各候选未全部合main；日常任务活跃，不允许抢占或重启。

## Next step

- 先完成modelqa隔离profile与focused/独立审阅，再按共同窗口租约验收。详细非秘密证据在dev-docs/unified-055-acceptance.md（随实现补齐）。

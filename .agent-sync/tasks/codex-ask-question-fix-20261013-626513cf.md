<!-- git-project-sync-task:version=1 -->
<!-- git-project-sync-task:branch=codex/ask-question-fix-20261013 -->
<!-- git-project-sync-task:base=be48a22b9eef0130bbf0f3c7e24fdcf1e52e8576 -->
<!-- git-project-sync-task:status=in-progress -->

# Task: Repair structured question rendering and answer delivery

## Objective

MOXBOTS-ASK-QUESTION-FIX-20261013. 用户明确由当前Agent修复3项问答问题，补回归、合main、统一更新当前MoXBots并验收UI→真实caller。保留现有品牌、Host、账号与凭据配置。

## Acceptance criteria

- [x] 省略multiSelect正常单选，畸形选项向caller返回字段错误，不误报用户取消。
- [x] 并发提问FIFO逐项回答，重复回放/过期/失败重试/迟到回执不丢问题。
- [x] SDK与external入口、组件、Tab和答案投影回归，typecheck/lint/build与独立审阅通过。
- [x] PR检查、最新远端main包含修复。
- [ ] 统一包更新当前客户端，保留回滚，并验证真实UI显示/回答到caller。

## Completed

- 已核验be48a22b主干并隔离worktree；主代理实现共享校验、SDK/external入口、Tab队列4文件，独立reviewer只读审阅；覆盖原生ID和现有问题文本答案别名。

## Verification

- DOM/shared/interaction 134项、Builtin+external integration 283项、Codex contract 5项相称检查（422项独立用例）；最后2项新增Tab与Builtin cancel/abort在question-boundaries复核。TS、完整ESLint、Web/server build、docs检查通过；dependency lint既有15 warning/0 errors。详细记录dev-docs/ask-user-question-repair.md；全日志在工作树外同级moxbots-ask-question-fix-evidence，不提交机器状态。

## Blockers and unknowns

- 另一聊天正在安装同一客户端/修复钥匙串。用户明确授权跨聊天协调并要求统一包；安装owner继续归该任务，主代理本任务只负责提问源码和其验收，不并发重启/换包。

## Next step

- PR #21、six-check CI与main `d9749998f743707074d6d42dc5344bcb724d55a8` 已核验交付。安装owner已收到冻结source/patch/摘要；等待统一安全包及原生窗口，再补原生提问显示/真实caller回执，不重复实现或单独换包。

## 2026-10-13 解锁后接续

- 用户已解锁；已安装native仍旧版本，未改动。安装owner确认源9149753c有问答修复，但签名07e制品无修复；同产品release缺乏隔离profile，禁止启动备份/并发换包/触发凭据。
- 独立实际组件UI→SDK原生进程→loopback caller已提交单选、多选和自定义文字并逐字段核验；生产样式/主题与wire/result证据完成。范围仅独立组件和合成provider，不等于当前客户端更新或真实推理。
- 本轮无产品修改；下一步只在owner提供安全统一包及native窗口后完成安装制品对照和原生问答验收，无需重复要求用户解锁/授权。

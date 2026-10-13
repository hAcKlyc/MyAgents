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
- [ ] PR检查、最新远端main包含修复。
- [ ] 统一包更新当前客户端，保留回滚，并验证真实UI显示/回答到caller。

## Completed

- 已核验be48a22b主干并隔离worktree；主代理实现共享校验、SDK/external入口、Tab队列4文件，独立reviewer只读审阅；覆盖原生ID和现有问题文本答案别名。

## Verification

- DOM/shared/interaction 134项、Builtin+external integration 283项、Codex contract 5项相称检查（422项独立用例）；最后2项新增Tab与Builtin cancel/abort在question-boundaries复核。TS、完整ESLint、Web/server build、docs检查通过；dependency lint既有15 warning/0 errors。详细记录dev-docs/ask-user-question-repair.md；全日志在工作树外同级moxbots-ask-question-fix-evidence，不提交机器状态。

## Blockers and unknowns

- 另一聊天正在安装同一客户端/修复钥匙串。用户明确授权跨聊天协调并要求统一包；安装owner继续归该任务，主代理本任务只负责提问源码和其验收，不并发重启/换包。

## Next step

- 当前源代码可审阅。创建PR、等待当前头CI、同步最新main集成，向安装owner交付冻结提交；统一包后补原生提问显示与真实caller回执验收。

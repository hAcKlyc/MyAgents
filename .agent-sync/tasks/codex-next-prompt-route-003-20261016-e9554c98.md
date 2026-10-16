<!-- git-project-sync-task:version=1 -->
<!-- git-project-sync-task:branch=codex/next-prompt-route-003-20261016 -->
<!-- git-project-sync-task:base=12449e4741d8f225a73ee540f68331b1bb8e24ac -->
<!-- git-project-sync-task:status=in-progress -->

# MOXBOTS-NEXT-PROMPT-003 — 正式下一步建议路由

## Objective

修复正式客户端下一步建议请求404，补正式composition回归、main交付并排入下一未冻结桌面版本。正式客户端任务结束出现建议、Enter只采纳草稿须实际验收；不得打断正在运行任务。

## Acceptance criteria / To Do

- [x] 当前0.5.7实际日志和运行实例404复现，确认漏登记而非缺少生成实现。
- [x] 仅精确Session路径登记，保留Global隔离，不开放整个/api/chat/。
- [x] 正式composition→实际route→实际owner service回归先红后绿，模型/Session数据为隔离fixture。
- [x] 189项定向unit/DOM通过，包含运行中409且不触发模型、不变更任务，以及Enter仅采纳为草稿。
- [x] 类型与scoped lint通过，主Agent审查diff。
- [ ] PR92正常六项CI通过，同步最新main合入并核验远端。
- [ ] 唯一桌面发布owner接收下一未冻结发行请求，核实冻结源码包含成果；冻结058不得直接换源码。
- [ ] 发布owner协调正式签名客户端、安全空闲/解锁、兼容备份与回退后启用，无stop/kill/强退。
- [ ] 正式客户端完整真人路径：可继续的受控任务正常结束→输入框空白→真实建议出现→Enter采纳可编辑草稿→原任务/消息数未增加。真实生成null不能算通过，也不强制每次生成。

## Completed

根因：production-consumed Sidecar ownership表未登记/api/chat/next-prompt，实际handler被composition前置拒绝。补SESSION_EXACT_PATHS精确路径；未更改提示词、模型/认证配置、客户端交互或活动owner。

## Verification

类型检查 `tsc --noEmit` 与限定两文件ESLint均exit0通过。

新文件src/server/routes/prompt-suggestion-composition.unit.test.ts含9例：修复前7失败（200/400/409均收到404）/2通过；修复后9通过。测试实际composeSidecarRequestHandler、handlePromptSuggestionRoute及suggestNextPrompt，只mock模型与Session snapshot。Builtin和Codex/Claude Code/DSH均验证原owner；Global、邻近未知路径和非POST不生成。

7文件189项：composition147、新compose9、route2、service10、shared4、hook3、input14。命令见dev-docs/next-prompt-route-003-acceptance.md。真实0.5.7日志2026-10-16 20:05/20:25/23:29请求404；受控无效JSON对象POST当前会话port32421仍返回404，此探测未到生成逻辑。

## Deployment request

Required: existing macOS arm64 MoXBots updater/client only. 唯一发布聊天01a12bc2-907a-7702-b6dd-788225c5dfe4处理下一未冻结版本；按现有058当前冻结与原生构建状态决定058重新冻结或下一版，不擅改其候选/版本/更新服务器。无配置迁移/新权限/云Host部署。源码合入不等于原生已修复。修复可回退为单路径登记删除，但正式回退仍保留全部业务数据与兼容配置。

## Blockers and unknowns

当前日常App有运行任务；本聊天不安装、不重启、不stop。正式签名版本/真实Provider建议和Enter原生链路尚未验收，须发布owner串行窗口；旧隔离modelqa验收不能关闭本门槛。

## Next step

完成类型/lint及CI/main交付，把固定源码与本记录提交给唯一发布owner；获得安全空闲窗口后实际正式客户端验收并回填证据，不以模拟替代。

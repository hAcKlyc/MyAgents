<!-- git-project-sync-task:version=1 -->
<!-- git-project-sync-task:branch=codex/next-prompt-runtimes-20261015 -->
<!-- git-project-sync-task:base=c7bab28594a03dfba7167200a90ae73ad0a6b5aa -->
<!-- git-project-sync-task:status=in-progress -->

# Task: MOXBOTS-NEXT-PROMPT-002

## Objective

支持Codex（system/managed身份保留）、Claude Code和Integrated DSH的灰色下一步建议。无工具、无原会话持久化、成功终止才显示；Enter只接纳草稿/Esc忽略。真实模型验收后完成客户端更新，不触碰无关任务和活跃会话。

## Acceptance criteria

- [x] 三种运行模式按冻结模型/原认证提供无工具文本生成，不借用其它Runtime或身份。
- [x] 成功/空/失败/取消/超时、并发和配置/会话变更拒绝过期建议；保留builtin和输入法/草稿保护。
- [ ] 真实模型生成及可编辑草稿交互，验证不执行工具/不改原会话。
- [ ] 相称测试/build/独立审查、精确HEAD CI、main合入推送核验。
- [ ] 串行安全客户端更新、源码/签名/制品对应和实际路径复验。

## Completed

- 核对remote/main/worktree/已有发布任务，从c7bab285隔离新分支；start/task-init通过。通知已获授权的原安装owner新任务及串行要求。

## Verification

源码已实现；81项聚焦unit/DOM、32项既有回归通过，dep-cruiser 0错误（16既有orphan warnings），scoped lint通过。独立审阅及真实模型receipt在dev-docs/next-prompt-runtimes/。真实Codex gpt-6.1-sol 16s、CC native default21s、DSH Kimi/k3 12s通过，均使用生产提示词和合成前序对话，不等同客户端已验收。主Agent负责集成/最终验收；requested Sol medium worker实现Codex/modelqa闭集handler，另一同tier worker独立审阅。未调用AIRouter，精确token/费用未知。

## Blockers and unknowns

当前依赖统一owner profile af6c790081efcc1fb21b099bd795aca2b31f4be2提供isModelQaBuild；阶段先保存再merge该精确commit。主干排队遵守owner统一顺序，不与品牌PR50竞争。0.5.5原生modelqa窗口、正式打包/更新仍待统一owner串行接线和验收。

## Next step

合并已推送profile依赖，完整tsc/build及精确HEAD CI通过后交统一owner排main；随后实际modelqa输入框Enter/IME/Escape验证并跟进0.5.5更新。DSH modelqa准备产生独立profile合成native工件可保留，utility自身前后原会话文件hash不变。

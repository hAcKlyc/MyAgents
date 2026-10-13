<!-- git-project-sync-task:version=1 -->
<!-- git-project-sync-task:branch=codex/resume-boundary-fix-20261013 -->
<!-- git-project-sync-task:base=e976726355918cd37fa832641028c84b78786234 -->
<!-- git-project-sync-task:status=in-progress -->

# RESUME-BOUNDARY-20261013

## Objective

目标：修复确定性 native resume 拒绝造成的自动重试和弹窗叠加，提供保留历史的恢复分支。用户明确当前 Agent 实施、交付 https://github.com/heavenzhang/MoXBots.git，实际故障客户端为 MyAgents。

## Acceptance criteria

确定性拒绝不反复启动、不叠加提示，保留原会话与失败输入；恢复新分支保留 native prefix，严格拒绝有歧义的旧 stamp。代码远端 main/CI 和当前签名客户端安装分别验收。

## Completed

- [x] 核实源码、分支、主干、并行工作树和运行应用；独立 worktree，零子 Agent。
- [x] 实际日志和无模型请求的隔离副本复现：未完成 AskUserQuestion 的原生 UUID 在恢复清理后不再可定位。
- [x] 停止同一个显式边界自动 pre-warm，保留 Product 历史和边界，结算队列后允许恢复操作。
- [x] 持久错误栏替代重复 toast；原错误的重新发送改为现有分支确认入口。
- [x] 在新分支修正 legacy 用户消息的失配 UUID：仅唯一完整纯文本原生用户条目，拒绝重复、附件、未知 assistant 和跨边界匹配；源会话不改。
- [x] 95 项 builtin 集成、103 项 Tab 事件 DOM、5 项恢复动作 DOM、20 项 remap 单元测试通过；新增测试覆盖自动重试、冷恢复、原边界保留和独立 prefix 恢复。
- [x] 本机恢复分支已通过 SessionStore birth/publish 创建；实际现有客户端 API 读到完整四条保留历史，正文深比较一致，源 Product/native 文件字节未变化。没有模型发送。
- [x] TypeScript、改动文件 ESLint、分类检查、合并最新主干、web/server 构建通过。
- [ ] PR #26 CI/main 核验。
- [x] 独立 IAB fixture 运行真实恢复组件，默认桌面布局与 Enter 选择正确；整客户端 UI 仍依赖后续安装。
- [ ] 永久客户端安装及真实发送验收：开放。

## Verification

95 项集成、128 项 unit/DOM；候选 IAB fixture；实际本机恢复分支加载成功。首次发送已实际进入 native/model 执行，无同恢复点拒绝；该发送不是本 Agent 代发，原业务任务结果不属于本修复验收。

## Blockers and unknowns

私有会话证据、备份和恢复回执在隔离 worktree 同级的 moxbots-resume-boundary-evidence/，不提交原文、账号或 UUID。恢复会话名“恢复：费用包编辑页优化”。本机发布未完成：原 MyAgents 签名团队与本机可用 Developer ID 不同，且其他会话仍在执行任务；不覆写 app，不中断任务，不将源码测试当成已安装。

初轮回归揭示同步启动失败会保留 error 状态并阻止 fork，已在停止重试后恢复 idle；DOM output 自带 status 角色，toast 回归现单独排除 Probe output。实际恢复 API 的失败 map 暴露 initial 用户 UUID 失配；按唯一完整文本证据修正新分支，不重写源历史。初轮恢复验证错误地比较 JSON 字符串键序，改为客户端 API 对两个正文的深比较后通过，现有分支已保留，未重复创建。

## Next step

下一步：完成静态检查/合并最新主干和候选构建、UI 验收，再按有效签名与安全安装窗口明确永久客户端发布状态。当前主 Agent 精确模型/推理档位、团队 token/费用未暴露，不估算；无 AIRouter 或外部模型调用。

详细技术与验收说明：`dev-docs/resume-boundary-recovery.md`。最终源头已同步并合入最新 main，待本分支 CI/main 核验；JS 构建/静态检查状态见后续更新。

2026-10-13 主干并发同步：先合入侧栏 PR25，再合入 Bot 执行 PR23；两次仅共享计划 append 冲突，保留双方完整条目。455f5fd0 的六项 CI 全部通过；同步 PR23 后的新提交需重新通过仓库 CI 才可合入。聊天/侧栏相关206项回归、95项 builtin 集成和 web/server 构建已通过。永久客户端安装的签名/空闲门槛不因源码合入解除。主干交付最终状态以 PR26 merge commit 与远端 refs 核验为权威，不把此提交前记录的待合入 checkbox 当作当前 Git 状态。

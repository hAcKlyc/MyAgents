<!-- git-project-sync-task:version=1 -->
<!-- git-project-sync-task:branch=codex/resume-boundary-fix-20261013 -->
<!-- git-project-sync-task:base=e976726355918cd37fa832641028c84b78786234 -->
<!-- git-project-sync-task:status=in-progress -->

# RESUME-BOUNDARY-20261013

目标：修复确定性 native resume 拒绝造成的自动重试和弹窗叠加，提供保留历史的恢复分支。用户明确当前 Agent 实施、交付 https://github.com/heavenzhang/MoXBots.git，实际故障客户端为 MyAgents。

- [x] 核实源码、分支、主干、并行工作树和运行应用；独立 worktree，零子 Agent。
- [x] 实际日志和无模型请求的隔离副本复现：未完成 AskUserQuestion 的原生 UUID 在恢复清理后不再可定位。
- [x] 停止同一个显式边界自动 pre-warm，保留 Product 历史和边界，结算队列后允许恢复操作。
- [x] 持久错误栏替代重复 toast；原错误的重新发送改为现有分支确认入口。
- [x] 在新分支修正 legacy 用户消息的失配 UUID：仅唯一完整纯文本原生用户条目，拒绝重复、附件、未知 assistant 和跨边界匹配；源会话不改。
- [x] 94 项 builtin 集成、103 项 Tab 事件 DOM、5 项恢复动作 DOM、20 项 remap 单元测试通过；新增测试覆盖自动重试、冷恢复、原边界保留和独立 prefix 恢复。
- [x] 本机恢复分支已通过 SessionStore birth/publish 创建；实际现有客户端 API 读到完整四条保留历史，正文深比较一致，源 Product/native 文件字节未变化。没有模型发送。
- [ ] 最终静态检查、合并最新主干、JS 构建与远端 main/CI 核验。
- [ ] 候选恢复按钮的实际渲染检查。
- [ ] 永久客户端安装及真实发送验收：开放。

私有会话证据、备份和恢复回执在隔离 worktree 同级的 moxbots-resume-boundary-evidence/，不提交原文、账号或 UUID。恢复会话名“恢复：费用包编辑页优化”。本机发布未完成：原 MyAgents 签名团队与本机可用 Developer ID 不同，且其他会话仍在执行任务；不覆写 app，不中断任务，不将源码测试当成已安装。

初轮回归揭示同步启动失败会保留 error 状态并阻止 fork，已在停止重试后恢复 idle；DOM output 自带 status 角色，toast 回归现单独排除 Probe output。实际恢复 API 的失败 map 暴露 initial 用户 UUID 失配；按唯一完整文本证据修正新分支，不重写源历史。初轮恢复验证错误地比较 JSON 字符串键序，改为客户端 API 对两个正文的深比较后通过，现有分支已保留，未重复创建。

下一步：完成静态检查/合并最新主干和候选构建、UI 验收，再按有效签名与安全安装窗口明确永久客户端发布状态。当前主 Agent 精确模型/推理档位、团队 token/费用未暴露，不估算；无 AIRouter 或外部模型调用。

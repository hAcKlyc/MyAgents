# RESUME-BOUNDARY-20261013

当 native hydration 清理未完成的工具调用后，旧 `resumeSessionAt` UUID 可能已不在可恢复消息集合里。SDK 历史读取仍可能返回该物理记录，因此本地记录存在不能代替真正启动接受。实际本机故障已在隔离副本、空输入和不可用本地模型端点下复现，零模型请求。

确定性拒绝后，客户端现在停止同边界自动 pre-warm，结算排队输入并恢复 idle，保留显式边界、原需求、历史和失败输入。前端保留一处持久错误栏；不重复 toast，也不继续提供同边界重新发送。用户可通过“保留历史，分支继续”进入既有分支确认流程：复制保留历史末端以前的独立 native 前缀，原会话与其已撤回的 native 尾部不被恢复或修改。失败输入仍在源会话，不自动发送。

本机来源还有旧 user UUID 与 native 存储失配。Fork 仅在整个 native 源链里有唯一完整纯文本用户条目、目标位于保留前缀、无附件或其它原生块、原 UUID 完全不存在且没有其它 Product 行占用该条目时，修正新分支的 user stamp。所有有歧义或未知 assistant 的情况仍拒绝。原数据不写回。该判断不把 SDK history 当作原边界 resumability 的证明。

## 验证

- `src/server/session-transcript/builtin.integration.test.ts`：95 项通过，覆盖 result/throw 拒绝不自动重试、旧边界冷恢复、推导边界的已有安全重试、独立 prefix 恢复和未成功发送输入只出现一次。
- `src/server/utils/fork-remap.unit.test.ts`：20 项通过，覆盖精确匹配、重复内容、附件/混合内容、跨边界/仍存在 UUID 和重复占用的拒绝。
- `src/renderer/context/TabProvider.activity.test.tsx`：103 项通过，持久错误保留，多次事件不创建重复 toast。
- `src/renderer/components/NativeResumeRecoveryAction.test.tsx`：5 项通过，正确 retained assistant、禁用状态和 unavailable 行为。
- 候选真实组件通过独立本地 IAB fixture 的默认桌面布局和 Enter 操作检查。fixture 未接原生应用；不把它当作整客户端安装或业务发送验收。
- 现有 MyAgents API 已读到本机恢复分支的四条保留历史；源/目标正文深比较相同，原 Product/native 文件与备份字节相同。恢复分支的隔离 native 空输入启动成功，模型发送为零。恢复分支已在实际客户端打开、历史与原模型恢复；随后真实用户输入已进入 native/model 执行，未重现该恢复点拒绝。本 Agent 未代发业务指令，原任务最终结果不在本修复范围。

## 安装边界与接续

源码目标为 MoXBots 仓库的 main；截图故障运行实例是既有 MyAgents。两个 app 的 profile、数据和签名不能混用。当前 MyAgents 签名团队与本机可用 Developer ID 不同，且其它会话仍有活跃工作；永久修复尚未换包，不修改钥匙串允许列表、不重启/中断其它任务，不把 JS 构建称作原生发布。

本机恢复会话名为“恢复：费用包编辑页优化”，原会话保留。备份、native 启动取证和回执均在任务私有 evidence 目录，未提交正文、账号或 UUID。下一步是在有效签名和安全安装窗口内提供并验证客户端更新；如采用用户自己的签名，先准备可审阅包并明确已有钥匙串访问的兼容验收与回滚条件。

执行：主 Agent 单独诊断、实现、验证与交付；零子 Agent、零 AIRouter/其它模型调用。初轮自动恢复回归发现同步启动拒绝的 error 状态会阻止 Fork，已修复为结算后 idle；实际 fork 验证暴露旧 user stamp，以唯一完整正文证据修正复制快照。token/费用未暴露，不估算节省。今后先检查 native 启动语义与 Product stamp，再评估恢复路径；不以存在 UUID 作为恢复成功证据。

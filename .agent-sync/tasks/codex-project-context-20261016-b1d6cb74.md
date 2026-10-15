<!-- git-project-sync-task:version=1 -->
<!-- git-project-sync-task:branch=codex/project-context-20261016 -->
<!-- git-project-sync-task:base=a81d2509fa92968ddaaed63416a2478d21b8a373 -->
<!-- git-project-sync-task:status=in-progress -->

# Task: MOXBOTS-PROJECT-CONTEXT-001 自动接续项目进展与决策

## Objective

同项目新桌面会话首次执行前自动带入其他会话重要进展与用户决策原文；有来源、预算、隔离和退出开关。采用现有持久对话的只读提取投影，零新增模型调用，无新状态 writer。当前 Agent 负责实现、测试与 main；统一发布会话 01a12bc2-907a-7702-b6dd-788225c5dfe4 负责后续发布，不自动加入冻结056。

## Acceptance criteria / To Do

- [x] 核实 Git、main、clean、独立 worktree 和发布 owner。
- [x] 单轮决策与进展自动带入；预热后仍在首次实际发送时读取。
- [x] 同项目隔离，群聊/自动维护/私有委派排除；失败历史不伪装成功。
- [x] 首轮有预算；后续不重复；重试/rewind/重启重新由原对话裁决。
- [x] 并发读取无覆盖；源删除/损坏不使用陈旧缓存；开关有效。
- [ ] 相关单元、隔离持久化/链路集成、类型/lint/build 与 CI。
- [ ] 远端main包含成果；固定SHA/用量边界交给发布owner。

## Verification

相关unit/DOM189项、SessionStore集成10项通过；独立复审5文件162项通过。类型/完整lint/server和Web build通过。设置实际React/IAB 1024浅色及540深色、开关/键盘/失败恢复通过。证据 `dev-docs/project-context-validation/README.md` 与token-metrics.json。无日常App或生产数据写入。模型真实语义/安装后的原生验收由统一发布owner按隔离身份进行，不拿合成测试冒充。

## Token contract

不为摘要另起模型调用；新会话一次性加载最多6000 UTF-8 bytes的来源背景（模型Token数不同，仅报告估算/文本实测）；后续普通轮次不追加。保留已注入上下文仍可能参与后续上下文计费，不能把“不重复追加”称为零后续输入费。

## Next step

提交候选、合并最新main并跑必需CI；固定main SHA和证据交统一发布会话。

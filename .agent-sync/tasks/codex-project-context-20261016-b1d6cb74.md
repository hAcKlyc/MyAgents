<!-- git-project-sync-task:version=1 -->
<!-- git-project-sync-task:branch=codex/project-context-20261016 -->
<!-- git-project-sync-task:base=a81d2509fa92968ddaaed63416a2478d21b8a373 -->
<!-- git-project-sync-task:status=complete -->

# Task: MOXBOTS-PROJECT-CONTEXT-001 自动接续项目进展与决策

## Objective

同项目新桌面会话首次执行前自动带入其他会话重要进展与用户决策原文；有来源、预算、隔离和退出开关。采用现有持久对话的只读提取投影，零新增模型调用，无新状态 writer。当前 Agent 负责实现、测试与 main；统一发布会话 01a12bc2-907a-7702-b6dd-788225c5dfe4 负责后续发布，不自动加入冻结056。

## Acceptance criteria / To Do

- [x] 核实 Git、main、clean、独立 worktree 和发布 owner。
- [x] 单轮决策与进展自动带入；预热后仍在首次实际发送时读取。
- [x] 同项目隔离，群聊/自动维护/私有委派排除；失败历史不伪装成功。
- [x] 首轮有预算；后续不重复；重试/rewind/重启重新由原对话裁决。
- [x] 并发读取无覆盖；源删除/损坏不使用陈旧缓存；开关有效。
- [x] 相关单元、隔离持久化/链路集成、类型/lint/build。
- [x] 最终提交的必需CI六项通过（run38771666288）。
- [x] PR68/main c225acd8远端包含、tree一致；固定SHA/用量已发统一发布会话。

## Completed

已实现共享安全文本投影、原SessionStore只读提取、首轮/重试动态注入、默认独立项目开关、来源/预算与故障过滤。190项相关回归+10项持久化集成、独立复审、设置浏览器检查和构建通过。预算不足时优先完整决策/进展摘录，已增加防闲聊挤占用例并独立复审12项通过。PR #68 为合并与最终CI的追溯入口。初始实现提交e5d1d6c2；最新main发布协调已合并且无代码冲突。

## Blockers and unknowns

源码main交付完成。真实Provider后台三路径已补验通过，见provider-057任务；签名包/安装后Native仍由统一发布会话验收，不将未执行项当作通过。

## Verification

相关unit/DOM190项、SessionStore集成10项通过；独立复审5文件162项通过。类型/完整lint/server和Web build通过。设置实际React/IAB 1024浅色及540深色、开关/键盘/失败恢复通过。证据 `dev-docs/project-context-validation/README.md` 与token-metrics.json。无日常App或生产数据写入。模型真实语义/安装后的原生验收由统一发布owner按隔离身份进行，不拿合成测试冒充。

## Token contract

不为摘要另起模型调用；新会话一次性加载最多6000 UTF-8 bytes的来源背景（模型Token数不同，仅报告估算/文本实测）；后续普通轮次不追加。保留已注入上下文仍可能参与后续上下文计费，不能把“不重复追加”称为零后续输入费。

## Deployment request

- 用户后续明确指定0.5.7；状态 queued，目标为统一发布 owner 管理的既有 macOS arm64 更新渠道。用户可见变化：普通项目的新桌面会话首次发送时自动带入有限来源背景，设置中可关闭。
- 远端分支 `codex/project-context-20261016`，PR #68；合入后不可变main SHA由交接回执提供。不得加入冻结056候选；由owner按用户指定0.5.7安排独立批次。
- 依赖：最终候选必需CI、main远端核验；发布前用安全测试身份完成真实Provider及签名客户端新会话/开关持久化验收。无新增服务、外网端点、凭据、数据库迁移或模型依赖；新配置 `Project.projectContextEnabled` 缺省开启，false关闭未来注入。
- 风险及回滚：关键词只能选择原文，不能保证穷尽决策或替代真实验收；历史范围/授权提示需保留。关闭开关可停止未来注入，已发送上下文不会被删除；包回滚由统一发布owner按既有备份/签名流程处理。不得以本地测试替代原生和生产验收。

## Next step

源码交付完成；真实Provider证据见 `.agent-sync/tasks/codex-project-context-provider-057-20261016-44d995ec.md` 与 `dev-docs/project-context-validation/provider-acceptance.md`。统一发布owner按用户指定0.5.7完成原生验收与正式发布。

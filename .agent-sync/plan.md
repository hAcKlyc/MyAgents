# Development Plan

## 当前目标和范围

将 Bots Net 多用户架构前提与 Bot 共享第一版规划保存到 MoXBots 源码仓库，附平台管理员 Bots 管理可交互原型、任务清单和接续记录；当前扩展Bot新建、配置、启停、归属/Host分配与逻辑删除。真实共享服务暂不开发；不改账号、业务数据、Host 配置、安装包或生产服务。

本共享计划于 2026-10-13 随 Git 协作结构首次接入，仅纳入本次任务；既有远程管理、身份、客户端和品牌工作继续由 `codex-handoff.md` 及其原 owner 负责，不在此推断完成状态。

## 里程碑

| 里程碑 | 状态 | 完成标准与证据 |
| --- | --- | --- |
| 仓库更名 heavenzhang/MoXBots | 已核验 | GitHub repository ID 1414574754 不变；origin 与远端 main 使用新地址 |
| AN-MULTIUSER-001 多用户隔离规划 | 已整理，待实现 | `services/agentnet/planning/AGENTNETS-ROADMAP.md` |
| AN-BOT-SHARE-001 第一版共享权限 | 已整理，待实现 | 同目录 `AGENTNETS-BOT-SHARING-V1.md` |
| AN-SHARE-PROTOTYPE-20261013 原型与同步 | 已交付main，后续实现另开任务 | 同目录 `TODO.md`、`dev-docs/prototypes/agentnets-bot-sharing-v1/`；UI 验收与远端 main 均须核验 |
| BOT-ADMIN-LIFECYCLE-PROTOTYPE-20261013 生命周期原型 | 已交付main，真实实现另开任务 | 新建/配置/启停/归属Host分配/逻辑删除及独立验收，真实实现另开任务 |
| 真实共享服务 | 待另行启动 | 先明确身份/网络、Bot 映射、Host 隔离与授权撤销；再真实多账号联调 |

## 当前任务和依赖

当前任务分支 `codex/bots-admin-lifecycle-prototype`，base main `5ee8f862`；前次 `codex/agentnets-sharing-v1` 已完成。当前主 Agent 负责文档、接续、集成和 Git 交付。原型 worker 只写本原型 HTML；独立 reviewer 只做 UI 验收并写自己的记录。文件所有权互斥，不操作其他工作树。

原型不依赖后端上线；真实共享依赖 Host 执行隔离、资源级授权、可撤销调用授权、并发用量预占和持久化。设备入网与同账号管理不能替代跨用户共享验收。

## 交付门槛

- [x] 两份规划、TODO、综合和分支接续记录在同一提交链中可定位。
- [x] 原型邀请、接受、使用、审批、撤销、委派边界、用量和审计完成连贯模拟。
- [x] 独立视觉、交互、响应式验收与主 Agent 复核完成；范围仅限合成原型。
- [x] 同步最新 main，处理并发改动，遵守保护与必需 CI；核验远端主干包含成果。

本次无生产发布门槛：用户要求规划同步与原型，真实共享服务暂不开发。后续保留真实账号、业务持久化、运行版本和回滚验收项。

## 下一步

管理员版原型与规划已由 PR #17 交付 main；合并锚点 `421718d6756cb73dfffaf54e94344a5e497caf8c`，源头七项CI通过，合并树一致。客户端个人网络入口后续命名为 Bots Net。管理员生命周期原型与规划也已由PR #18交付main，合并锚点 `5652048579f776c5eebe9faebdbde212ce2b93c7`；其后由用户启动真实共享开发；负责人重读最新源码，确认执行主体、实施边界与排期，不凭原型直接发布。

## 管理员生命周期扩展的当前门槛

- [x] 权威仓库、main和前轮CI已核验，当前start/task-init gate成功。
- [x] 生命周期、成对部署授权与删除/归属影响规划和验收合同。
- [x] 生命周期完整模拟、共享受保护操作和审批预留回归。
- [x] 独立视觉/交互/三视口验收及主复核。
- [x] 规划/任务/接续与原型、证据同提交链保存，当前头部CI与main交付核验。

详细需求见 services/agentnet/planning/BOT-ADMIN-LIFECYCLE-V1.md，阶段状态见同目录TODO.md；本轮不启动真实服务开发。

## MOXBOTS-CHAT-ARCHIVE-20261013

当前Agent开发左侧聊天任务归档/列表/恢复（用户2026-10-13已明确），本条不启动真实Bot共享服务。Task record见 .agent-sync/tasks/codex-chat-task-archive-delivery-20261013-6fc6d567.md。目标为持久化/UI回归、原生可控聊天验收、远端main和保留既有Host试用能力的本机安装，归档实现已由PR #19合远端main，156项回归/CI及原生独立/重启/恢复保全验收通过。试用33992eb0在实际接受的b116404e上叠加归档并可逆安装；归档候选AgentNet凭据自动恢复回归未通过；用户选择回退原在线b116404e，已恢复并核验两设备在线，无系统密码请求。联合更新等待原凭据任务修复并同步main，整包发布验收按用户选择延期。详细分项证据见dev-docs/chat-task-archive-delivery.md。

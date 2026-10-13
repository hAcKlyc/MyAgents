# Development Plan

## 当前目标和范围

用户已于2026-10-13启动 **BOTS-CLOUD-ADMIN-001** 真实实现，覆盖此前仅原型限制。基于现有 owned AgentNet 的统一管理员后台；本地鉴权、私有管理登记持久化与同源UI已验收，PR20已交付main be48a22b并发布现网，真实OIDC/admin API路径通过。独立标签页登录修复BOTS-ADMIN-LOGIN-002已由PR22交付main并发布，真实IAB登录及管理路径通过；真实有限Host执行BOTS-CLOUD-EXEC-001在独立工作树进行。真实Host启停/跨用户共享仍待执行委派，不能因登记成功称为完成。详细状态见 `services/agentnet/planning/BOTS-CLOUD-ADMIN-IMPLEMENTATION.md`。

### 已完成的规划/原型阶段（历史范围）

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

## 当前实现和依赖

当前隔离分支 `codex/bots-cloud-admin`，base main `2796b13eeb1ad69c1b9bd529b7108ecf534a4f7a`。主Agent负责前端、集成与发布；后台worker独占Rust并已交回ownership；独立UI reviewer完成三个fixture gate。保留现网04fa的四个服务文件修复，避免main升级回退；不触碰其他Host/桌面任务文件。首位现网测试管理员已由用户明确授权并配置；实际OIDC/admin API通过，Browser fallback发布门槛仍待完成。

- [x] 本地管理权限、登记API、SQLite/CAS/幂等审计、同源UI与独立验收。
- [x] PR20 exact-head CI/main与远端包含成果核验。
- [x] 现网权限确认、备份回滚、串行升级、真实OIDC/admin API验收。
- [ ] BOTS-ADMIN-LOGIN-002浏览器fallback CI/main/发布/真实登录UI复验。
- [ ] 有限Host委派与真实启停、共享执行及多账号验收。

### 前轮原型任务和依赖

当前任务分支 `codex/bots-admin-lifecycle-prototype`，base main `5ee8f862`；前次 `codex/agentnets-sharing-v1` 已完成。当前主 Agent 负责文档、接续、集成和 Git 交付。原型 worker 只写本原型 HTML；独立 reviewer 只做 UI 验收并写自己的记录。文件所有权互斥，不操作其他工作树。

原型不依赖后端上线；真实共享依赖 Host 执行隔离、资源级授权、可撤销调用授权、并发用量预占和持久化。设备入网与同账号管理不能替代跨用户共享验收。

## 交付门槛

- [x] 两份规划、TODO、综合和分支接续记录在同一提交链中可定位。
- [x] 原型邀请、接受、使用、审批、撤销、委派边界、用量和审计完成连贯模拟。
- [x] 独立视觉、交互、响应式验收与主 Agent 复核完成；范围仅限合成原型。
- [x] 同步最新 main，处理并发改动，遵守保护与必需 CI；核验远端主干包含成果。

本次无生产发布门槛：用户要求规划同步与原型，真实共享服务暂不开发。后续保留真实账号、业务持久化、运行版本和回滚验收项。

## 下一步

管理员版原型与规划已由 PR #17 交付 main；合并锚点 `421718d6756cb73dfffaf54e94344a5e497caf8c`，源头七项CI通过，合并树一致。客户端个人网络入口后续命名为 Bots Net。管理员生命周期原型与规划也已由PR #18交付main，合并锚点 `5652048579f776c5eebe9faebdbde212ce2b93c7`；其后由用户启动真实统一后台实现；当前以BOTS-CLOUD-ADMIN-001接续，不凭原型直接发布。

## 管理员生命周期扩展的当前门槛

- [x] 权威仓库、main和前轮CI已核验，当前start/task-init gate成功。
- [x] 生命周期、成对部署授权与删除/归属影响规划和验收合同。
- [x] 生命周期完整模拟、共享受保护操作和审批预留回归。
- [x] 独立视觉/交互/三视口验收及主复核。
- [x] 规划/任务/接续与原型、证据同提交链保存，当前头部CI与main交付核验。

详细需求见 services/agentnet/planning/BOT-ADMIN-LIFECYCLE-V1.md，阶段状态见同目录TODO.md；该历史轮次未启动真实服务开发；当前实现以本文件开头新任务为准。

## MOXBOTS-CHAT-ARCHIVE-20261013

当前Agent开发左侧聊天任务归档/列表/恢复（用户2026-10-13已明确），本条不启动真实Bot共享服务。Task record见 .agent-sync/tasks/codex-chat-task-archive-delivery-20261013-6fc6d567.md。目标为持久化/UI回归、原生可控聊天验收、远端main和保留既有Host试用能力的本机安装，归档实现已由PR #19合远端main，156项回归/CI及原生独立/重启/恢复保全验收通过。试用33992eb0在实际接受的b116404e上叠加归档并可逆安装；归档候选AgentNet凭据自动恢复回归未通过；用户选择回退原在线b116404e，已恢复并核验两设备在线，无系统密码请求。联合更新等待原凭据任务修复并同步main，整包发布验收按用户选择延期。详细分项证据见dev-docs/chat-task-archive-delivery.md。


## MOXBOTS-ASK-QUESTION-FIX-20261013

用户已明确由当前Agent修复AskUserQuestion输入校验/错误语义、并发提问覆盖与畸形选项渲染问题，完成回归、main和当前客户端验收。范围为既有SDK/Runtime与Tab请求链路，不启动Bot共享服务。任务记录 `.agent-sync/tasks/codex-ask-question-fix-20261013-626513cf.md`。本机安装由现有Host/钥匙串任务统一提供包，双方已获用户明确跨聊天协调授权；本任务不并发换包、退出或重启。实现/回归/独立审阅/main/统一包/真实caller验收分别追踪，不以模拟回传代替真实客户端结果。

该问答修复代码已由PR #21交付main `d9749998f743707074d6d42dc5344bcb724d55a8`，源头六项CI通过且merge tree一致；统一客户端安装/原生caller验收仍开放，详见任务记录。

### 2026-10-13 — administrator release and real browser acceptance

PR20 plus PR22 are in remote main. Login source `60e3a52c08bf79d3985e1453449719269a35fb1a` passed seven exact-head checks; PR22 merge `1cfa2f85dc6c936c02b86f1f40945961665608a7` passed Owned AgentNet run38396057654. Its CI artifact11812672883 has verified API archive digest5198fa3f… and binary SHA256 `9b9320f57685a938cee53492eec412567df8076a273e7ef72a12a461ca5f06bc`; complete source tree matches that accepted main commit. Subsequent main documentation changes do not alter the deployed service.

The user explicitly authorized the existing integration test account as this instance's first platform administrator. The binary-only release preserved exact existing role/config and ingress hashes, stopped only the dedicated network service, created consistent private SQLite/state backups and retained the previous binary and rollback. Dex, Mori and Linux Host were not restarted. Runtime executable/source/hash and health were independently verified.

Real OIDC PKCE login through the in-app browser's independent sign-in tab succeeded. Authenticated UI create/configure and approved owner/Host selection succeeded, revisions persisted, and disconnected start was truthfully rejected. Actual API verification also passed original mutation replay, reload persistence, recoverable delete/restore and logout token revocation. Controlled drafts only; no model calls. Real ordinary-user production login and actual Host execution remain unverified; fixture ordinary403 is not substituted for production evidence. Private production evidence is under `/Users/zhangshaohua/Documents/Codex/2026-10-13/moxbots-cloud-admin-evidence/deployment/`; raw accounts, tokens, credentials and Host identifiers remain outside Git.

BOTS-CLOUD-EXEC-001 continues separately: protected owner opt-in, current Host source preservation, Linux gates and true Session lifecycle release are open. Shared usage remains future planning.

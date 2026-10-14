## MOXBOTS-AUTH-HOST-20261014 — current continuation

Root owns the unified macOS candidate and real Host integration. Installed/public5f is an earlier package, not the new account UI. Normal same-account desktop credential recovery succeeded with both fixed-family slots persisted and no new OS prompt; controlled cold restart/update remains open. Account/sidebar code and explicit same-account Linux management renewal are implemented with focused tests and independent source review; Linux connector is currently stopped after binding mismatch until exact native artifact renewal. Signed unified package, real model-config/disabled-Agent persistence, CI/main and download refresh remain open. See `.agent-sync/tasks/codex-mah-auth-host-acceptance-20261014-0bfff75a.md` for ownership, authorization, checks and next step.

## MAH-CREDENTIAL-PUBLISHER-ROUTES-20261014 — current desktop gate

5f1a8feb 七CI、两个完整候选签名与资源验证通过；用户后来明确要求安装/官网上架，直接从a838更新5f并真实启动，84fd未运行。官网下载公开版本7/source7da419c，实际下载ZIP大小与SHA和安装原包相同。试用包未公证，公开不等于全部Native/业务验收。看板owner已完成真实受控任务与持久化路径；当前云会话 OWNED_SESSION_INVALID，凭据迁移/免提示冷启动/远程配置仍开放，UI遇用户操作冲突后停止。PR14仍草稿，未主干交付。下一步及精确证据见 `.agent-sync/tasks/feat-mah-credential-publisher-routes-20261014.md`。

## MAH-CREDENTIAL-PARENT-BUDGET-20261013 — native recovery continuation (historical)

Root owns integration, packaging, installation and acceptance. Exact 6ac native migration validated the old account/key but failed before routing-ledger commit; cause remains unknown. a8 sidebar native moves/section persistence passed independently. Parent-only budget/closed diagnostics candidate bae611a0 retains frozen reader v1 and has been integrated with accepted main cf741f at 4a513ec7. Parent41, AgentNet148, packaging13 and default/MoX production checks passed before this latest-main combination; combined checks and native recovery are still required. Do not repeat OS authorization automatically or declare network acceptance from synthetic probes. Record: `.agent-sync/tasks/feat-mah-credential-parent-budget-20261013.md`.

# Development Plan

## MOXBOTS-HOST-CONFIG-20261013

当前Agent按用户明确授权实现Host管理复用Settings模型配置、一键应用当前桌面主Agent来源、远端受限目录选择。交付记录 `.agent-sync/tasks/codex-host-config-delivery-20261013-5d88db02.md`（开发阶段旧记录保留），合同 `specs/tech_docs/host_configuration_reuse.md`。Node/Rust/来源及共享UI已实现，独立审查与合成IAB通过；af725700六项CI及Linux目录用例通过，已同步会话恢复main20e89b6f，组合源CI/main待核验。Host基础已由PR24交main fb92ce9c，交付分支已从其独立创建；开发冻结依赖9149753c及Mac凭据实验不进入交付；原凭据聊天负责基础拆分和统一安装，用户已授权协调。本任务未操作安装包，当前运行版本按统一安装owner回执另行核验。

- [x] 实际仓库/主干/原Host分支核验和隔离任务记录。
- [x] Provider元数据封闭合同、独立版本、凭据绑定与目录owner实现及本地相称回归。
- [x] 共享Settings UI/独立审查修复、合成IAB关键交互验收（真实Host待统一包）。
- [ ] Linux目录/完整CI、验证后的Host基础集成、远端main包含成果。
- [ ] 统一候选安装、真实Host和旧Host兼容、真实主Agent来源应用及用户路径复验。

## 当前目标和范围

用户已于2026-10-13启动 **BOTS-CLOUD-ADMIN-001** 真实实现，覆盖此前仅原型限制。基于现有 owned AgentNet 的统一管理员后台；本地鉴权、私有管理登记持久化与同源UI已验收，PR20已交付main be48a22b并发布现网，真实OIDC/admin API路径通过。独立标签页登录修复BOTS-ADMIN-LOGIN-002已由PR22交付main并发布，真实IAB登录及管理路径通过；有限Host执行BOTS-CLOUD-EXEC-001已由PR23/main75bb0269发布并完成单Bot真实六项生命周期验收；跨用户共享与收费模型调用仍为后续范围。详细状态见 `services/agentnet/planning/BOTS-CLOUD-ADMIN-IMPLEMENTATION.md`。

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

当前隔离分支 `codex/bots-cloud-admin`，base main `2796b13eeb1ad69c1b9bd529b7108ecf534a4f7a`。主Agent负责前端、集成与发布；后台worker独占Rust并已交回ownership；独立UI reviewer完成三个fixture gate。保留现网04fa的四个服务文件修复，避免main升级回退；不触碰其他Host/桌面任务文件。首位现网测试管理员已由用户明确授权并配置；实际OIDC/admin API及Browser fallback发布、登录UI均通过。

- [x] 本地管理权限、登记API、SQLite/CAS/幂等审计、同源UI与独立验收。
- [x] PR20 exact-head CI/main与远端包含成果核验。
- [x] 现网权限确认、备份回滚、串行升级、真实OIDC/admin API验收。
- [x] BOTS-ADMIN-LOGIN-002浏览器fallback CI/main/发布/真实登录UI复验（main1cfa2f85；下方实际发布记录）。
- [x] 有限单Bot Host委派、真实Session启停、删除/新授权恢复、原请求/CAS、重启及有效撤销验收。
- [ ] 共享执行、第二真实用户和收费模型路径（后续范围）。

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


## BOTS-CLOUD-EXEC-001 (approved execution continuation)

User approved finite Bot delegation on2026-10-13. New isolated codex/bots-cloud-execution-v1 starts from canonical main b421b759; registry PR20 tracked in its own branch. Current implementation contract services/agentnet/planning/BOTS-CLOUD-EXECUTION-CONTRACT.md. Primary owns cloud gate/queue/UI/integration, Sol/high requested worker owns closed execution-core+typed signer, Luna/medium requested worker owns new Host-local Bot modules; runtime model/effort unverified. No AIRouter calls or shared cache; compact owned interface and parity fixtures prevent duplicated context. Staged tests, actual Host, CI/main and release remain open. First deployment requires actual role/Host opt-in authority; original Host task source remains untouched.
## MOXBOTS-ASK-QUESTION-FIX-20261013

用户已明确由当前Agent修复AskUserQuestion输入校验/错误语义、并发提问覆盖与畸形选项渲染问题，完成回归、main和当前客户端验收。范围为既有SDK/Runtime与Tab请求链路，不启动Bot共享服务。任务记录 `.agent-sync/tasks/codex-ask-question-fix-20261013-626513cf.md`。本机安装由现有Host/钥匙串任务统一提供包，双方已获用户明确跨聊天协调授权；本任务不并发换包、退出或重启。实现/回归/独立审阅/main/统一包/真实caller验收分别追踪，不以模拟回传代替真实客户端结果。

该问答修复代码已由PR #21交付main `d9749998f743707074d6d42dc5344bcb724d55a8`，源头六项CI通过且merge tree一致；统一客户端安装/原生caller验收仍开放，详见任务记录。

### 2026-10-13 — administrator release and real browser acceptance

PR20 plus PR22 are in remote main. Login source `60e3a52c08bf79d3985e1453449719269a35fb1a` passed seven exact-head checks; PR22 merge `1cfa2f85dc6c936c02b86f1f40945961665608a7` passed Owned AgentNet run38396057654. Its CI artifact11812672883 has verified API archive digest5198fa3f… and binary SHA256 `9b9320f57685a938cee53492eec412567df8076a273e7ef72a12a461ca5f06bc`; complete source tree matches that accepted main commit. Subsequent main documentation changes do not alter the deployed service.

The user explicitly authorized the existing integration test account as this instance's first platform administrator. The binary-only release preserved exact existing role/config and ingress hashes, stopped only the dedicated network service, created consistent private SQLite/state backups and retained the previous binary and rollback. Dex, Mori and Linux Host were not restarted. Runtime executable/source/hash and health were independently verified.

Real OIDC PKCE login through the in-app browser's independent sign-in tab succeeded. Authenticated UI create/configure and approved owner/Host selection succeeded, revisions persisted, and disconnected start was truthfully rejected. Actual API verification also passed original mutation replay, reload persistence, recoverable delete/restore and logout token revocation. Controlled drafts only; no model calls. Real ordinary-user production login and actual Host execution remain unverified; fixture ordinary403 is not substituted for production evidence. Private production evidence is under `/Users/zhangshaohua/Documents/Codex/2026-10-13/moxbots-cloud-admin-evidence/deployment/`; raw accounts, tokens, credentials and Host identifiers remain outside Git.

BOTS-CLOUD-EXEC-001 continues separately: protected owner opt-in, current Host source preservation, Linux gates and true Session lifecycle release are open. Shared usage remains future planning.

## RESUME-BOUNDARY-20261013

用户确认当前 Agent 在 MoXBots 仓库修复实际 MyAgents 的 native resume 拒绝/重复提示。代码保持原边界和历史，阻断确定性自动重试，使用现有独立 native prefix Fork 恢复；旧 user stamp 只在唯一完整纯文本证据下修正新分支。任务/验收见 `.agent-sync/tasks/codex-resume-boundary-fix-20261013-4a93836a.md`、`dev-docs/resume-boundary-recovery.md`。本机恢复分支已由实际客户端 API 和零发送的隔离 native 启动核对，原文件未改。代码 main/CI 和客户端安装分别追踪；原签名团队不在本机且其它任务活跃，永久安装尚未完成；恢复分支的首次真实输入已进入 native/model 执行，原业务任务结果不在本修复范围，不代替 Host 或其它发布任务。
### BOTS-CLOUD-EXEC-001 integration update

Accepted Host foundation PR24 main fb92ce9c is incorporated into the execution continuation, preserving existing owner results. Synthetic UI and local Host/native regression gates passed; Linux exact-head CI and three-artifact provenance remain required. Production Host read-only scope preflight passed; a private single-Bot 24-hour lifecycle-only opt-in proposal is prepared but neither authorized nor installed. Protected account-binding UUID pin, exact opt-in authority, serial backup/rollback, real Session birth/exit and original receipt recovery remain open. No inference or model fees are claimed.


## MOXBOTS-SIDEBAR-ORG-001

用户明确由当前Agent为桌面端实现任务/Agent拖拽与Codex风格自定义分区。范围为本机侧栏偏好、排序与展示归属，不改变Session执行身份或真实工作目录。任务记录 `.agent-sync/tasks/codex-sidebar-organization-20261013-964955f1.md`，要求数据回归、实际嵌套拖拽/菜单/导航/刷新/rail及独立审阅、CI和远端main。原生安装与当前Host/凭据统一更新owner协调，独立追踪，不能把fixture验收当生产验收。

SIDEBAR-ORG阶段更新：PR25已交付远端main c21e9f43，源头9d879a6e六项CI与独立23项实际UI通过；原生安装仍开放。用户已授权跨聊天协调，唯一本机安装owner“Bots 网络 可用”已确认旧6ac包不含sidebar，正准备联合候选；以实际制品/签名/运行回执和原生重启验收关闭。

SIDEBAR-ORG原生更新：a8具体包已由用户许可并串行安装；主Agent实际App拖Task/Agent进分区、菜单恢复、分区管理和正常重启保留完成，详见dev-docs/sidebar-organization-native.md的覆盖限制。临时分区已清理；凭据slot保存仍失败，由原owner修复，统一更新未全部验收。

## MOXBOTS-PROJECT-BOARD-001

用户已确认MoXBots仓库并批准PB-002实现。当前Agent负责隔离分支codex/project-board-20261014及集成/主干交付；TaskStore/Session owner不变，工作区看板只读投影真实数据，有限activity快照明确新鲜度。原生更新与既有owner串行；无需新增付费模型任务。进度/门禁见`.agent-sync/tasks/codex-project-board-20261014-da9bc0a5.md`。 2026-10-14：PR31已入远端main；统一包5f1a8feb已安装，CUA原生看板关键路径验收通过，官网公开完整下载件大小/SHA与候选ZIP一致，ZIP完整性通过。PR35已修复NSIS供应门禁并以6项CI合main；受控冷启动、Task恢复/历史/文档hash保留、最终再次归档及原生800 CSS px/键盘补验通过。原生≤700/第二工作窗口不在客户端支持范围，未公证及范围外路径见任务记录与`dev-docs/project-board-native-acceptance.md`。
### 2026-10-14 — finite lifecycle release gate

BOTS-CLOUD-EXEC-001 source is delivered by PR23/main75bb0269 with all required CI successful. Linux Node/native default-off upgrade is accepted, preserving prior management/credential/source ownership. The user has now authorized the concrete single-Bot finite whitelist; it is installed with account-capped expiry. Cloud runtime switch and real owner/admin lifecycle acceptance are still pending; no model inference or shared usage is claimed. Current gate/evidence are maintained in `.agent-sync/tasks/codex-bots-cloud-execution-v1-b0a0c425.md`.

### 2026-10-14 — accepted lifecycle and one cloud console

BOTS-CLOUD-EXEC-001 is released/accepted at runtime source75bb0269. Current source/artifacts/CI, primary actual user-path and rollback boundaries are in `services/agentnet/validation/BOTS-CLOUD-EXEC-001-LINUX-ACCEPTANCE.md`; the task record is complete. Final controlled Bot is restored, stopped/admission closed, both grants effectively revoked and all receipts ACKed; no model invocation.

User requires a single MoXBots cloud administrator console for users, Hosts, Bots, permissions and audit. Existing auth components remain internal dependencies, not separate back offices. Client sign-in is retained; personal product surface is Bots Net. Current registered-user query does not imply IAM write capabilities: expand account/login/role administration in this same platform, never fork another admin system.

## TITLE-001 — 2026-10-14 概要性任务标题

当前Agent修改后端自动命名：首个成功人类问答后异步概括对象和动作，扩大有界上下文并保留尾部需求，拒绝认证错误/失败终态。手动命名不覆盖；不批量修改历史。任务记录 `.agent-sync/tasks/codex-title-summary-20261014-7b0a1e0a.md`。自动测试、真实存储重载及DOM回归通过；当前源CI/main、统一包和真实模型/原生侧栏验收分开追踪。

## MAH-CREDENTIAL-OFFICIAL-PUBLISHER-20261014

- [x] Closed formal-publisher reader release, source a8387448, signed/extracted desktop artifact and seven CI checks.
- [x] Paired Linux cf741f upgrade with backup and preserved identity/config/credential/policy evidence.
- [ ] Exact package installation confirmation and actual migration/restart/update acceptance.
- [ ] Real desktop remote configuration and disabled Agent persistence, then PR14/main delivery.

Owner: root. Record: .agent-sync/tasks/feat-mah-credential-official-publisher-20261014.md. Do not overwrite frozen package worktrees or retry old OS authorization automatically.

## MAH-HOST-DAEMON-STATUS-20261014

- [x] Explicit owned boot option and additive doctor status, source79c25045; actual MoX enablement and restart/reconnect acceptance passed.
- [x] PR32 all six checks passed; merged main d86f7505f641ecbe6d136142c11422ef063ea0e5 has the exact reviewed tree. Desktop PR14 native gates remain pending separately.

Owner root; record .agent-sync/tasks/fix-mah-host-daemon-status-20261014.md. No paid calls, other namespace or machine reboot.


### BOTS-ADMIN-LOGIN-UX-001（2026-10-14）

用户反馈管理员网页登录双窗口割裂。独立任务 `codex/bots-admin-login-ux-001` 基线 d86f7505，改为当前标签页 OIDC 登录、固定 /admin 返回、短期 tab-scoped PKCE 事务恢复，bearer仍只在内存。中文 Dex 品牌模板保持原 POST/同意授权语义；不改变账号、权限、客户端身份、Host或模型调用。服务端与loopback浏览器回归已通过，独立只读审阅与CI/生产真实路径待完成。详细任务见 `.agent-sync/tasks/codex-bots-admin-login-ux-001-2ebc1db3.md`。此条覆盖历史弹窗/独立标签页fallback的产品方向。


### BOTS-ADMIN-LOGIN-UX-001 最终交付（2026-10-14）

已交付PR33/main1ece497d并发布现有统一云后台：当前标签页中文OIDC登录及固定后台返回替代旧弹窗/独立标签页fallback，错误/取消/过期可恢复。代码七项CI通过，Linux制品及Dex资源manifest/运行源对应已核实；真实受控管理员登录→中文确认→Bots目录→退出204，以及callback400恢复通过。仅两个既有云服务更新展示和回跳，原身份与权限不变，101 Host及模型未操作。备份标记 moxbots-login-ux-backup-20261014T101958，恢复原unit+Dex配置即可回滚且保留业务状态。详细最终验收和后续状态见 `.agent-sync/tasks/codex-bots-admin-login-ux-001-2ebc1db3.md`；现网维护窗口已释放，后续无本任务云端写入。

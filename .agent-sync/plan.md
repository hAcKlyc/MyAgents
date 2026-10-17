## MOXBOTS-UI-ZOOM-002 — 2026-10-16

修复Ctrl+后文本域水平滚动条；仅改输入/建议的横轴策略和grid收缩约束。真实组件Chromium/WebKit各60组、相关107测试、类型/lint及MoXBots web构建通过；CI/main以PR76与任务记录继续追踪。源码任务`.agent-sync/tasks/codex-ui-zoom-scrollbar-20261016-d37165e0.md`，验收`dev-docs/ui-zoom-scrollbar-acceptance.md`；queued发布请求由既有统一部署聊天处理下一未冻结批次，不操作日常/QA客户端、不回写055/056。

## MOXBOTS-UI-ZOOM-001 — 2026-10-15

主窗口Ctrl/Command加减与0缩放；75%–200%，成功后记忆，设置页快捷键说明。独立分支`codex/ui-zoom-20261015`，32项相关测试、类型/lint和MoXBots web构建通过；浏览器、CI/main、原生发布各自追踪。任务`.agent-sync/tasks/codex-ui-zoom-20261015-698c789d.md`；原生验证由统一发布窗口承接，不并发操作日常App。

## MOXBOTS-AUTH-HOST-20261014 — current continuation

Root owns integration. Human-approved29 is installed; owned account restoration, bottom-left account entry, actual k3/model-directory save, disabled Agent creation and desktop plus both Host services restart persistence pass without a new keychain prompt. Read-only extended Agent list is repaired with three regressions. Latest main model-center source is being incorporated with cloud_models remaining disabled. Final combined tests/candidate/CI and PR14/main/public download delivery remain open. See `.agent-sync/tasks/codex-mah-auth-host-acceptance-20261014-0bfff75a.md`.

## MAH-CREDENTIAL-PUBLISHER-ROUTES-20261014 — current desktop gate

5f1a8feb 七CI、两个完整候选签名与资源验证通过；用户后来明确要求安装/官网上架，直接从a838更新5f并真实启动，84fd未运行。官网下载公开版本7/source7da419c，实际下载ZIP大小与SHA和安装原包相同。试用包未公证，公开不等于全部Native/业务验收。看板owner已完成真实受控任务与持久化路径；当前云会话 OWNED_SESSION_INVALID，凭据迁移/免提示冷启动/远程配置仍开放，UI遇用户操作冲突后停止。PR14仍草稿，未主干交付。下一步及精确证据见 `.agent-sync/tasks/feat-mah-credential-publisher-routes-20261014.md`。

## MAH-CREDENTIAL-PARENT-BUDGET-20261013 — native recovery continuation (historical)

Root owns integration, packaging, installation and acceptance. Exact 6ac native migration validated the old account/key but failed before routing-ledger commit; cause remains unknown. a8 sidebar native moves/section persistence passed independently. Parent-only budget/closed diagnostics candidate bae611a0 retains frozen reader v1 and has been integrated with accepted main cf741f at 4a513ec7. Parent41, AgentNet148, packaging13 and default/MoX production checks passed before this latest-main combination; combined checks and native recovery are still required. Do not repeat OS authorization automatically or declare network acceptance from synthetic probes. Record: `.agent-sync/tasks/feat-mah-credential-parent-budget-20261013.md`.
# BOTS-MODEL-CENTER-001

2026-10-14：模型中心、Bot builtin/API 模型分配和调用监控已由 PR38 合入 main 并发布现有统一 `/admin`；源码与主干七项 CI 全通过，运行二进制/资源来源以及真实管理员配置、分配、重启持久化和监控路径已复验。用户明确后续自行填写供应商，本次不导入已有配置、不调用模型，不改变实际 Host 委派权限。发布/验收与协作证据见 `dev-docs/bots-model-center-production-acceptance.md`；后续供应商/Host/付费路径与已发布的管理功能分开追踪。

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

## MOXBOTS-UPDATER-20261014

接通MoxBots独立更新地址/签名、后台检查下载、用户确认且任务安全的重启安装；官网服务器静态不可变release/原子stable，Linux及无正式包平台不自动升级。源实现/确定性测试、独立UI、真实A→B更新、Apple分发包、主干/部署各自跟踪，详见specs/tech_docs/auto_update.md与scripts/moxbot-updates/README.md和对应task record。MOXBOTS-MIGRATE-001迁移已完成，保留迁移后数据。真实更新窗口与官网聊天串行协调，正式包包含已合入main的账号/Host成果。

### MOXBOTS-AUTH-HOST-20261014 actual29 acceptance

User specifically approved29 update; native owned-account recovery, bottom-left menu, remote Kimi Code/k3 save, disabled Agent creation and client+Host service restart persistence now pass without a new keychain prompt or model call. Extended Host resources had a display gap; a read-only registered-Agent list and three regressions are added. Final latest-main integration, combined candidate/CI, PR14 merge and public trial refresh remain open. Authoritative current scope/evidence/next step: `.agent-sync/tasks/codex-mah-auth-host-acceptance-20261014-0bfff75a.md`; old114/29 pending-approval notes are historical.


### MOXBOTS-AUTH-HOST-20261014 final native acceptance

Approved combined27 is installed; actual owned account/device recovery, k3/directory and registered-disabled-Agent list readback passed. Final Linux dd7192d4 upgrade preserved config/projects/unit bytes and finite permissions; all seven exact source checks passed. Task final evidence is updated; PR14 merge/public release remain, original mailxf Site update separately awaits restored connector access (404 in current zshedu account). Migration owner completed local8-project/34-history merge; never restore pre-migration data backups.

## REMOTE-SESSION-IMPLEMENTATION-20261015

同账号远程Agent直接会话；实现/验收状态和后续门禁见 `.agent-sync/tasks/codex-remote-session-20261015-bba594f8.md`。复用SessionEngine/Store与owned管理传输，首版为有界snapshot同步。生产原生包与真实双端、Provider验收单独记录，不能用组件模拟代替。

## FEEDBACK-001 — 2026-10-15

把MoXBots小助理并入设置下方个人菜单，通知保持原功能。新增同源云端反馈页：用户提交和查看自己的反馈，管理员回复及处理；既有账号权限/PKCE登录、幂等/CAS和私有存储。记录 `.agent-sync/tasks/codex-feedback-center-20261015-3b6a3c97.md`；代码、fixture、main、云发布和客户端真实路径独立追踪。

FEEDBACK-001候选：个人菜单合并小助理/反馈与云端本人提单/管理员处理已实现，代码/本地/独立UI验证通过；CI/main、生产与安装包验收分开，状态见任务记录。

### MOXBOTS-PROJECT-BOARD-002 会话时长与直达

用户要求在项目看板看当前会话执行时长并一击打开原会话。SessionEngine当前turn只读投影、独立卡片/列表快捷入口、明确最近更新、过期冻结/刷新已实现；154项组合unit、typecheck/lint、生产web和14组合成React UI通过。PR42六CI/main58b6720f、原生补验记录main80faaab7；隔离B3卡片/列表/详情与原会话/草稿、回看状态、idle过期未知及刷新通过。真实running计时无合法模型样本仍未覆盖。原生窗口已释放，后续按各owner授权串行；记录见 `.agent-sync/tasks/codex-project-board-session-time-20261015-c5ba72da.md`。

### MOXBOTS-UPDATER-20261014 final0.5.4 delivery

Sourcee5a05f76/PR46 main0c85b571，六CI及main3351运行文件blob等同；已整合统一官网PR47 main16ab3dbd/看板记录80faaab7，无客户端重建。独立QA真实A3→B3、编辑/realPTY拒绝不中断、cancel、signed install/nativecleanup/exactdraft&Record恢复和Root实际UI复看通过。App/DMG AppleAccepted/stapled/Gatekeeper，ZIP/TAR/DMG全清单/签名门禁通过。Own官网stable0.5.4及独立ownkey签名生效；sameSHA TAR复用自有Repo CDN（官网URL和公钥不变，服务器原件保留），完整实际HTTPS343281849bytes/37.19s/9.23MBps、signature/range/privacy通过；网站新设计当前源hash已对齐、其它Nginxbase保全/cloudPID不变。正式文件WPS output/updater-20261014/final-e5a05f76/，最终交接 dev-docs/moxbots-updater-054-delivery.md。paidProvider/realissuer/Host/runningtimer不是本native覆盖；remote-session安全更新证明未就绪明确阻止安装。Root/children、board与unified均停止GUI，remoteowner后续只按其自己的授权安装/联调。已公开0.5.4不可变，下一源码变更发0.5.5。

## MOXBOTS-NEXT-PROMPT-002

用户要求扩展Codex/Claude Code/DSH下一步建议、真实模型生成验收与客户端更新。仅文本utility不执行工具/不改原对话，保持Runtime身份及冻结模型。分阶段状态见.agent-sync/tasks/codex-next-prompt-runtimes-20261015-2fee4eac.md；普通0.5.4发布不代表本任务已实现。

### MOXBOTS-055-UNIFIED-ACCEPTANCE

Unified owner builds a distinct real-model utility acceptance environment, coordinates NEXT-PROMPT/TITLE/Host and brand/community serial native acceptance, then freezes all accepted mainline work for signed/notarized 0.5.5 and idle-only actual client update. Existing updaterqa stays model-disabled; daily work is preserved. Source/tests/runtime/production/mainline gates and ownership: `dev-docs/unified-055-acceptance.md`; task `.agent-sync/tasks/codex-unified-055-modelqa-20261015-38fa9c79.md`. Not a claim of completed 0.5.5 release.
FEEDBACK-001阶段交付：PR44/main d7264a43已核验，7 CI通过；云端已发布并通过受控真实账号闭环5/5。统一原生候选尚未纳入该提交，收包已登记，当前安装入口不算通过；接续见任务记录及dev-docs/feedback-production-validation.md。

FEEDBACK-001 2026-10-15 07:14 UTC+8 接续：已安装正式0.5.4/e5a05f76包含PR44，实际binary/源码/远端main c7bab285对应通过；按新增人类授权同步给统一客户端负责人并登记FEEDBACK/TITLE原生待验队列。现有非实现者原生入口/布局证据复用；实际issuer/退出恢复及Provider标题生成待当前窗口owner明确交接，未抢占GUI或重复发布。任务保持in-progress。

FEEDBACK-001 原生补验完成：主Agent在明确串行窗口交接后使用正式0.5.4完成个人菜单/助手/正确issuer反馈入口、同账号真实Dex/PKCE退出恢复、8原标签及App/Sidecar PID保留、独立铃铛入口。实际联网状态不作为Host/通知通过。GUI已token校验释放，非秘密摘要dev-docs/feedback-native-acceptance.md。TITLE待独立modelqa，后续统一0.5.5由发布负责人处理。

## MOXBOTS-PROJECT-BOARD-004 — 四阶段与可信执行状态

用户批准PB-003 v3落实际看板：待开始→执行中→待确认→已完成；历史仅主动归档，恢复不执行。当前分支codex/project-board-state-20261015，任务记录 `.agent-sync/tasks/codex-project-board-state-20261015-5b2d05d2.md`。实现renderer与现有owner观察链路，SDK当前Query后台子任务纳入running；Sidecar非健康/恢复不可伪idle。主Agent负责集成，state_review独立检查UI；不碰统一0.5.5工作区，不并发退出/换包。代码、CI/main与统一原生安装/真实HRM复验分开记录。

- [x] 四阶段/细原因、历史归档恢复、可见页有界刷新与失败保留快照。
- [x] 相关161项unit/DOM，web/server构建。
- [x] 完整类型/lint、Rust Task82/owner2及独立UI审阅。
- [x] main20593924/PR56已交付六CI通过，用户直接授权纳入统一0.5.5。
- [ ] 统一原生安装与真实HRM复验；由统一负责人串行处理，不另起安装或付费模型任务。
## MOXBOTS-BRAND-COMMUNITY-001 — 2026-10-15

用户要求清理可见MyAgents名称/介绍，并重建社区到现有云服务体系。隔离分支`codex/brand-community-20261015`，基线c7bab285；桌面品牌/导航、同云账号社区及后台管理已由PR50交main b5b9c9c4；7CI、151云回归、独立UI和生产真实OIDC/只读路径通过。云已安全发布并释放维护hold，原生0.5.5由统一负责人继续。最终证据见`dev-docs/brand-community-delivery.md`。合同`services/agentnet/COMMUNITY.md`，任务`.agent-sync/tasks/codex-brand-community-20261015-5872226e.md`。云服务和桌面分别追踪发布；统一桌面0.5.5打包owner正在工作，本任务不并发安装或重启日常应用。不得把合成OIDC、本地fixture或主干合入称为生产/原生完成。


## MOXBOTS-PLAN-REVIEW-001

2026-10-15 用户确认 MoXBots 目标仓库，当前Agent直接修复方案审核空卡。仅当前 Session 专用 Markdown 写入例外；无完整正文时返回模型可修复错误，UI旧空卡禁用批准。任务及分项验收见 `.agent-sync/tasks/codex-plan-review-content-20261015-0fd5aae0.md`。代码/模拟/UI/main与原生安装分别追踪；不操作现有业务审核或并发替换统一055客户端。


## MOXBOTS-PROJECT-BOARD-TODO-001

在四阶段看板增量接入原会话TODO和子Agent真实进度。卡片/列表摘要、详情三态清单/子Agent状态，复用共享reducer与既有只读activity owner；历史/过期不冒充实时，TODO全勾不推导Task完成。代码、251项相关unit/DOM、类型/lint、MoXBots web/server构建、6组合成UI及独立代码/视觉审阅已通过；PR58六项CI通过并合入main7346499b（产品树与CI head一致），统一原生纳入仍待负责人队列。验收 `dev-docs/project-board-todo-acceptance.md`，任务 `.agent-sync/tasks/codex-project-board-todo-20261015-06d8ff2b.md`。


## MOXBOTS-OUTPUT-001 — 阶段化聊天输出

2026-10-15，用户确认截图评审方向并指定本仓库。连续阶段、工具/思考真实状态、结果统计及动作归属、默认折叠/回折已实现；91项unit/169项DOM、类型/lint与MoXBots web构建通过，主审及独立React浅深色/380窄窗/英文验收通过；PR/CI/main和统一原生发布分别追踪。任务`.agent-sync/tasks/codex-output-display-20261015-03caa522.md`，证据`dev-docs/output-display/acceptance.md`。不把工具返回称业务验收，不操作日常App或真实Provider。

## MOXBOTS-PROJECT-BOARD-006 — Goal-aware grouping

截图反馈由独立任务`codex/project-board-goal-20261015`修复：看板只读Rust Goal lifecycle，active覆盖旧done Task及turn idle；未知/暂停/阻塞保留待确认，归档重新核对Goal。实现/合成React/44回归/typecheck/lint/web已通过；CI/main及客户端发布/真实任务复验分开追踪。记录`.agent-sync/tasks/codex-project-board-goal-20261015-0d453018.md`。不碰现有统一0.5.5冻结源或执行中的日常App。

## 2026-10-15：055冻结发行 / 056接续

用户要求先发布冻结0.5.5，后续改动进入0.5.6。055源码main52bf6160已正式签名、公证并完成不可变服务器归档；公网完整GET/原子stable门禁和实际客户端安装分别追踪。main5ebf字体缩放PR59及以后改动属于056；各开发版本元数据推进056。当前发行与精确验收边界见 `dev-docs/releases/moxbots-0.5.5.md`、`dev-docs/releases/moxbots-0.5.6-handoff.md`，后续记录覆盖旧统一055任务的历史状态。

## 2026-10-15 16:39：055正式更新已发布，056继续开发

MOXBOTS-055-RELEASE-FREEZE已完成既有own updater stable055发布及正常TLS/完整GET/实际stat+SHA/签名独审/CAS/公开路由/054回滚核验；源main52bf6160及远端tag v0.5.5不可变。055整包平均119030B/s、全GET约47分钟，不证明云带宽上限。本机054未安装或重启：HRM16:26仍busy，须fresh完整代次准入、有效一致备份及用户确认。未把Host/IME/带数据原生UI算通过；测试network服务ACCOUNT_SESSION_EXPIRED失败明确留056。

开发主干已056（版本PR61/main6d1f8912），包含之后的PR59缩放/PR60 Goal/PR62输出/PR63 Bots Ready；均不回写055。源码交付/验收边界见dev-docs/releases/moxbots-0.5.5.md、moxbots-0.5.6-handoff.md，私有制品与README/DELIVERY/SHA256SUMS在指针output/updater-055-20261015/final-52bf6160。官网下载手动ZIP由原官网owner在其新增授权下串行发布，Root不操作该asset或日常客户端。


## MOXBOTS-RESTART-001 — 用户确认后允许中断并重启

2026-10-15 用户明确确认目标仓库并要求运行任务也能手动重启。056候选改为明确停止/保存确认；后台下载不安装，取消无副作用。Rust验包/签名、精确代次DispatchLease、SessionEngine全会话停止和writer落盘依次完成，运行中Task按用户Stop记为Stopped，空闲调度保留；安装失败恢复文档/语音准入，迟到响应不能复活旧token。当前Agent负责实现/集成/原生门禁，restart_safety_review独立只读审查。代码、回归、CI/main及签名原生发行分别追踪，见 `.agent-sync/tasks/codex-restart-001-20261015-35044beb.md` 和 `dev-docs/restart-001-acceptance.md`。不回写不可变055，未操作日常客户端。

## MOXBOTS-BOARD-DEDUP-001 — shared Session presentation

多个Task复用同一Session时只选一个当前进度代表卡片，历史任务按自身状态保留，不再把同一TODO/计时/Goal复制成多个执行。renderer限定修复，零业务数据写入；代码/React合成验证/main与056原生发布分别追踪于 `.agent-sync/tasks/codex-project-board-dedup-20261015-d944a599.md`。

## Deployment coordination — Host101 scoped operation 2026-10-16

- **Deployment chat:** `01a13320-dbf9-7c03-b7f3-37e30d15de48`（Bots 管理控制台），仅本次101.42.11.29既有MoX Host安装/网络恢复。
- **Designation:** 用户在本聊天直接要求“在101.42.11.29上面安装host程序，并配置到moxbots网络”，并提供专用SSH附件。该具体目标由当前聊天负责，不接管下方桌面updater发布owner或其目标。
- **Targets and runbook:** 仅101的moxbot-host-test及moxbot-host-network-test；沿用`scripts/host/network-control.py`，先检查维护冲突/无activeSession、备份身份/配置/加密state，原身份恢复登录/run，不重置或覆盖身份，不更改模型执行授权。旧myagents服务、140backend与日常Mac保留。
- **Current release:** `MOXBOTS-HOST-101-20261016` accepted（运行/入网）；原83e48946安装复用，正式登录+同principal管理绑定续接后ready，重启及原配置/身份保全通过；PR85记录交付另核。任务 `.agent-sync/tasks/codex-host-101-network-20261016-810cf816.md`；验收 `dev-docs/host101-network-recovery-20261016.md`。既有会话24h，本次到期2026-10-17 14:14:14 +08:00，自动续期未实现；不宣称永久在线或真实模型调用通过。窗口已结束，无后续目标写入计划。

## Deployment coordination

- **Deployment chat:** `01a12bc2-907a-7702-b6dd-788225c5dfe4`，MoxBots桌面端统一打包负责人。
- **Designation:** 既定唯一发布owner仍为本聊天。最新用户于2026-10-16在修复聊天`01a1420f-245b-7f22-8a0f-4caaaf31b91b`明确回复“授权发送并安排修复版”；Root实际核读human message`01a142d4-9285-7c93-a968-52d61de5ab7d`，覆盖下一未冻结修复版及任务空闲后启用、不中断任务。原056授权和交付保持其发行记录，不将开发者转述自身当新增授权。
- **Targets and runbook:** 本次仅既有macOS arm64 MoXBots own updater `https://140.143.183.232/updates/stable/darwin-aarch64.json`、`/srv/moxbots/updates`及其不可变归档/原子stable；流程`scripts/moxbot-updates/README.md`与`release.mjs`。复用原Developer ID、公证profile、正式Reader和自有签名根。允许确认任务空闲、Mac手动解锁且启用前兼容配置备份就绪后，在本机启用新版并验证已有授权账号；不主动停止运行任务。不扩展路径/端口，不部署auth/Host/网站服务，不扩大External Calls/模型权限。
- **Release record / concurrency:** `dev-docs/releases/moxbots-0.5.7.md`及本任务记录维护状态；仍用既有`.release-lock`及owner核验，Git计划不是原子锁。Release workflow仅特殊分支push filter、不触发main/tag；Test CI只验证。开发聊天可正常源码/CI/main交付，后来提交不自动进入冻结包，不能并发发布或切换本目标。
- **Current release:** `MOXBOTS-058-COMMUNITY-RELEASE-20261016`，`published-and-distribution-verified / installed-client-not-upgraded`。正式source/tagv0.5.8固定main `12449e4741d8f225a73ee540f68331b1bb8e24ac`，包括PR87/89/90/91及普通非中断确认。精确制品签名/公证独审、同源码隔离原生更新与真实社区持久化/退出隔离独审、外部完整GET336365173B/TAR155e6a68/真实stat+SHA/自有签名通过；0.5.8 stable已原子启用，公开no-store/Range206/私有404/unsupported204通过，057回退保留。正式binary/Reader未启动，日常客户端057未升级；QA导航/IME/ASR/真实Host模型范围保留。后来main(PR92/93/94等)不进入058。详见`dev-docs/releases/moxbots-0.5.8.md`。不改变云/Host/官网或权限，不中断任务。
- **Acceptance boundary:** 分别报告源码、签名制品/服务器分发、启用安装、真实账号session/identity/membership/relay/目录/可调用路径。只在fresh完整活动准入确认空闲、Mac手动解锁及兼容配置备份/回退就绪后启用；不强退、不stop运行任务、未知则保持pending。真实Provider/Host/薪资看板等原生边界不得因构建/CI/HTTP200而关闭；其他服务不因本次指定获得新部署授权。

## MOXBOTS-MODEL-FAILOVER-001 — 2026-10-16

内置API模型一主一备，当前Session主模型不变，在原Query token推理请求边界有限重试/备用接管，保留native历史及工具结果，指纹/SSE终态防止隐式重放。默认关闭，设置复用原配置writer；订阅/DSH/external与真实供应商另验。合同`specs/tech_docs/model_failover.md`、验收`dev-docs/model-failover-001-acceptance.md`，任务`.agent-sync/tasks/codex-model-failover-001-6b96c57f.md`。当前Agent负责源码/CI/main，发行请求排入统一owner下一未冻结批次，不改变已有056冻结源码或操作日常客户端；代码、模拟/真实SDK loopback与原生/生产分别追踪。

## MOXBOTS-PROJECT-CONTEXT-001 — 2026-10-16

用户授权同项目新会话自动带入近期重要进展/决策，测试并main交付，发布交统一发布会话。只读原对话摘录、零新增模型请求、6000 UTF-8 bytes body；typed来源、独立开关和首轮重试刷新。开发/main/发布分别追踪于 `.agent-sync/tasks/codex-project-context-20261016-b1d6cb74.md`。不自动加入已冻结056候选，不操作日常App或生产。

### PROJECT-CONTEXT-001 / 0.5.7真实Provider补验（2026-10-16）

用户明确指定纳入0.5.7。已有功能PR68/main c225acd8；本轮真实Kimi/k3源会话+同项目/异项目/关闭开关4请求200/complete、wire/持久化/回答三层与独立复核通过。全部合成数据，不操作日常App。普通文本摘录，代码块仍省略；Native/HTTP/Rust circuit及其他Runtime真实Provider不在通过范围。脱敏证据dev-docs/project-context-validation/provider-acceptance.md与provider-results.json；当前分支task为codex-project-context-provider-057-20261016-44d995ec.md。功能及材料queued给既定统一发布owner的0.5.7，冻结056不变，无并发发布或版本推进。

## MOXBOTS-HOST-INSTALL-82-20261016 — Host capability compatibility

User requested the new Linux Host reuse of current desktop main-Agent model and actual task execution. A real desktop/Host probe exposed a 13-method advertisement against the deployed v1 12-method limit. Task branch `codex/host-capabilities-compat-20261016` removes only the redundant host.snapshot advertisement while preserving its callable fallback and modern model/remote Session methods. Code/IPC regression, CI/main, controlled target-only Host package update, source-model/credential application and real task acceptance remain individually tracked in `.agent-sync/tasks/codex-host-capabilities-compat-20261016-cfb52e68.md`. No daily desktop restart/replacement or shared cloud release.

后续独立批次0.5.7（来源聊天最新用户要求，由该聊天报告）：`MOXBOTS-PROJECT-CONTEXT-001`源码已由PR68交main c225acd8，来源聊天报告真实Kimi Provider隔离补验通过（PR71，最终main及边界以其任务记录为准），签名原生与下一版本冻结仍待验；Token与预算接续在原任务记录；未纳入冻结056，不因排队信息获得新的部署授权。

## MOXBOTS-OUTPUT-002 — 2026-10-16

用户接受输出区六项优化并要求结果/进度优先、逐项具体时间与低干扰质量信息。独立分支codex/output-results-20261016；原transcript owner新增可选观测时间，UI移除默认工具/方法名，连续同文件聚合，明确操作累计，TODO当前项，质量无主观评分。代码、158项定向/172项消息输入回归/25项持久化及实际IAB与独立审阅分别记录 `dev-docs/output-results/acceptance.md`；CI/main待本任务最终核验。桌面发布queued给既定统一owner下一未冻结批次（0.5.7队列），不改冻结056、不并发操作日常App或服务器，未向其他聊天发送消息。任务 `.agent-sync/tasks/codex-output-results-20261016-6853845f.md`。

### 0.5.7 入网修复发布授权（2026-10-16）

用户在原修复聊天`01a1420f-245b-7f22-8a0f-4caaaf31b91b`对“发送给既定统一打包负责人、安排下一未冻结修复版、任务空闲后启用且不中断任务”的问题明确回复“授权发送并安排修复版”。Root已实际核读human message `01a142d4-9285-7c93-a968-52d61de5ab7d`。复用既有own updater及唯一发布owner；允许在确认空闲、Mac手动解锁、启用前兼容配置私有备份和回滚就绪后启用候选，真实入网逐项验收，不扩大云/Host/模型/External Calls权限。旧056服务器accepted记录见dev-docs/releases/moxbots-0.5.6.md，已发布字节不改。新sessionBound配置回退旧版必须恢复启用前兼容配置且保留当前业务数据与所有旧身份/凭据槽，禁止回滚旧业务库。

## MOXBOTS-OUTPUT-003 — 2026-10-16

用户接受展开区复审并要求实际展开验收。单条直接结果行，多条展开隐藏重复摘要/时间，无实际正文无箭头；执行耗时仅runtime报告，观测跨度/等待/未知分开。独立代码/截图审阅关闭Bash内部重复duration和JSON空结果两项P2，reviewer IAB不可用，实际点击由主Agent补全。用户追加的用户气泡已纳入：紧凑内边距、普通正文400字重、浮动复制/回退及窄栏预留，长文和失败态保留，主Agent实际页面和独立静态复核完成。范围/源码/合成UI/CI/main/原生发行分别见 `.agent-sync/tasks/codex-output-expanded-20261016-f48054da.md` 和 `dev-docs/output-expanded/acceptance.md`；桌面变更queued给唯一owner下一未冻结批次，不修改已冻结包或操作日常App，不向其它聊天发送消息。


## MOXBOTS-NEXT-PROMPT-003 — 正式下一步建议接口

用户要求修复正式下一步建议404、补正式路由回归、main交付并纳入下一未冻结桌面更新，在不打断任务的前提下验收正式客户端任务结束出现建议与Enter仅采纳为草稿。精确Session路径登记，组合测试先红后绿及189项通过；源码/CI/main/签名发行/安全启用/真实用户路径分别记录。任务 `.agent-sync/tasks/codex-next-prompt-route-003-20261016-e9554c98.md`，验收 `dev-docs/next-prompt-route-003-acceptance.md`。唯一发布owner仍为01a12bc2-907a-7702-b6dd-788225c5dfe4；本聊天不修改已冻结058源码或并发发布/重启。

## MOXBOTS-CONTEXT-RECOVERY-20261017

Builtin API operational compaction budget, native compact failure correction, inference-only bounded recovery, private archives and durable business-action replay ledger; Rust pauses/resumes original Goal instead of blind10 retries. Contract `specs/tech_docs/context_recovery.md`, acceptance `dev-docs/context-recovery-20261017/acceptance.md`, task `.agent-sync/tasks/codex-context-recovery-20261017-4895668c.md`. Real SDK manual/auto compact and Query restart counter=1 passed; source/CI/main and next unfrozen signed release tracked separately. Sole existing deployment owner remains unchanged; do not alter frozen058 or interrupt daily tasks.

## MOXBOTS-UPSTREAM-INTEGRATION-20261017

User authorized nine upstream repairs and consumed-settings-navigation state only; preserve existing MoXBots menu/sidebar and context recovery safeguards. Source integration includes protocol1.2 client with legacy owned relay negotiation, DSH6.2 contracts/paired release selector0.1.18, MCP/Goal/history/plugin/QR/build repairs. Combined test/main delivery tracked in `.agent-sync/tasks/codex-upstream-integration-20261017-ff567bc3.md` and `dev-docs/upstream-integration-20261017/acceptance.md`. No product version/changelog copy and no new cloud authority. Desktop release request queued to the existing sole owner for the next unfrozen batch; this source task does not install, publish, restart or message another chat.

## MOXBOTS-BROWSER-001 — 2026-10-17

补齐可自动发现的产品浏览器Skill（系统同步v61），让对话工具菜单在未安装/全局未开启时也能定位浏览器资源卡片；明确资源、选择与实际连接，增加读失败重查与事件/查询竞态保护。CLI project browser选择与UI共用互斥规则，不修改全局peer。531项定向回归、实际合成IAB交互与真实Kimi k3→生产SessionEngine/SDK→Browser Host/Registry→锁定Chromium中文表单/截图及新Session合成Cookie恢复通过；Rust authority为测试替身、headless，不冒充原生生产验收。任务 `.agent-sync/tasks/codex-browser-001-20261017-ef4fc5b6.md`；证据 `dev-docs/browser-001/acceptance.md`。主干/CI与下一未冻结桌面发行分别追踪，唯一既定发布owner不变，不并发操作日常App或通知其它聊天。

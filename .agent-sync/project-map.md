# Project Map

## 项目身份

MoXBots 是用户拥有的 MyAgents fork，包含独立品牌桌面客户端、Linux Host 和 owned AgentNet 服务。Bots Net 是后续多用户网络与 Bot 共享的产品称谓；源码及协议中的 AgentNet namespace 不随仓库更名全局替换。

权威仓库：https://github.com/heavenzhang/MoXBots.git ，主干 `main`，策略见根 `.agent-sync.json`。上游 https://github.com/hAcKlyc/MyAgents.git 仅为 upstream，不是本项目交付目标。用户于 2026-10-13 授权仓库更名；仓库 ID 和历史保留。

## 资料与源码位置

| 分类 | 仓库路径 | 职责 |
| --- | --- | --- |
| 工作规则 | `AGENTS.md`，指向 `CLAUDE.md` 的既有 symlink | 现有项目说明和增量 Git 同步规则；不解除 symlink |
| Git 策略 | `.agent-sync.json` | 目标仓库、main、任务分支与记录位置 |
| 共享开发计划 | `.agent-sync/plan.md` | 本次接入的规划里程碑；不替代既有 owner 接续 |
| 分支接续 | `.agent-sync/tasks/` | 目标、base、进度、证据及下一步 |
| 综合接续 | `codex-handoff.md` | 多个任务的接续；新增条目不改写其他 owner 事实 |
| 桌面与 Host 源码 | `src/renderer/`、`src/server/`、`src/shared/`、`src-tauri/`、`scripts/host/` | 桌面、Sidecar、Rust 身份和 Linux Host |
| owned AgentNet 服务 | `services/agentnet/` | 独立登录、身份、metadata、relay及可选管理员登记控制面；部署与桌面验收另行核实 |
| 统一管理员后台 | `services/agentnet/admin-web/`、`src/admin_http.rs`、`src/admin_store.rs`（相对服务目录） | 同源页面、实时账号校验、私有Bot登记/配置/归属与审计；可选有限Host生命周期已接线，运维见ADMINISTRATION.md |
| 架构与设计规范 | `specs/ARCHITECTURE.md`、`specs/DESIGN.md`、`specs/tech_docs/` | 当前 owner、边界和交互规范 |
| 有限 Bot 执行（默认关闭） | `services/agentnet/src/execution_*`、`execution-core/`、`src/host/bot-*`、`src-tauri/headless-network/src/bot_execution*` | 真实身份/原操作账本、有限 proof/lease、Host 本地策略和独立IPC；PR23/main75已发布并完成单Bot真实Linux验收；模型接入另见BOTS-MODEL-CENTER-001；共享仍待实施 |
| 模型中心（可选、默认关闭） | `services/agentnet/src/model_center_*`、`admin-web/`、`src/host/cloud-model*` | 同一管理台的Provider/Model、Bot期望模型、有限Host会话网关和调用计量；builtin/API三协议，PR38已交主干并发布，真实管理员配置/分配/持久化通过；真实供应商调用另追踪，证据 dev-docs/bots-model-center-production-acceptance.md |
| 多用户共享规划 | `services/agentnet/planning/` | 后续规划、共享权限、BOT-ADMIN-LIFECYCLE-V1 生命周期设计与 TODO；管理及有限执行控制面已发布；共享和扩展IAM仍待实现 |
| 交互原型 | `dev-docs/prototypes/agentnets-bot-sharing-v1/` | HTML、设计约定、合成数据和原型验收；不接生产客户端 |
| 项目看板 | `src/renderer/features/project-board/`、`pages/ProjectBoard.tsx`，`dev-docs/project-board.md` | 按真实Task/Session展示工作区执行概况；API、原生、生产验收分开追踪 |
| 测试 | 相邻 `*.test.*`、Rust crate tests、`scripts/host/*test*`；根 `package.json` 与 `.github/workflows/` | 命令以源码为准；文档任务不扩大为模型或生产测试 |
| 运维与发布 | `services/agentnet/README.md`、`specs/guides/`、`dev-docs/moxbot-trial.md` | 非秘密说明；真实账号、备份和钥匙留在原 owner 私有目录 |

## 原型与独立官网

本次原型直接作为源码文档资产提交。独立营销官网不在本 Git 仓库中；MOXBOTS-DOWNLOAD-001 已在用户明确授权下通过 Sites 独立源码工作区发布公开下载页 https://moxbot.mailxf.chatgpt.site/download/，版本7/source7da419c57642daaf5324cbd35593b77597797b41；该源码的 helper 推送与本 Git main 交付分别追踪。原型截图仅保存合成数据，少量验收图随版本管理；不提交依赖、浏览器 profile、缓存、原生包或业务证据。

## 验证和接续顺序

1. 读本地图、共享计划、当前任务分支记录和最新 `codex-handoff.md` 条目。
2. 用用户明确指定的 Git URL 检查 fetch/push、分支、base 与远端主干；保留其他工作树修改。
3. 原型实际点击、视觉和 1440×900、768×1024、390×844 响应式验证，结果见原型验收记录。
4. 服务开发启动后另行确认执行主体和运行版本；模拟不能替代真实多账号、Host 权限或生产路径验收。

## 唯一后台入口（2026-10-14）

`services/agentnet/admin-web/` 是唯一云管理后台，覆盖/扩展用户、Hosts、Bots、权限和审计。同一服务的AuthStore及现有OIDC组件承接普通用户与管理员认证；内部运行服务不新增管理门户。客户端用户登录入口保留，个人网络产品名后续Bots Net；账号写管理与登录策略未来也在本后台扩展。历史HTML原型仅为设计证据，不是第二套可操作生产后台。

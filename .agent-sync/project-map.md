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
| owned AgentNet 服务 | `services/agentnet/` | 独立登录、身份、metadata 和 relay；部署与桌面验收另行核实 |
| 架构与设计规范 | `specs/ARCHITECTURE.md`、`specs/DESIGN.md`、`specs/tech_docs/` | 当前 owner、边界和交互规范 |
| 多用户共享规划 | `services/agentnet/planning/` | 后续规划、共享权限、BOT-ADMIN-LIFECYCLE-V1 生命周期设计与 TODO；真实实现待开发 |
| 交互原型 | `dev-docs/prototypes/agentnets-bot-sharing-v1/` | HTML、设计约定、合成数据和原型验收；不接生产客户端 |
| 测试 | 相邻 `*.test.*`、Rust crate tests、`scripts/host/*test*`；根 `package.json` 与 `.github/workflows/` | 命令以源码为准；文档任务不扩大为模型或生产测试 |
| 运维与发布 | `services/agentnet/README.md`、`specs/guides/`、`dev-docs/moxbot-trial.md` | 非秘密说明；真实账号、备份和钥匙留在原 owner 私有目录 |

## 原型与独立官网

本次原型直接作为源码文档资产提交。独立营销官网不在本 Git 仓库中，本次不变更其源码或托管目标。原型截图仅保存合成数据，少量验收图随版本管理；不提交依赖、浏览器 profile、缓存、原生包或业务证据。

## 验证和接续顺序

1. 读本地图、共享计划、当前任务分支记录和最新 `codex-handoff.md` 条目。
2. 用用户明确指定的 Git URL 检查 fetch/push、分支、base 与远端主干；保留其他工作树修改。
3. 原型实际点击、视觉和 1440×900、768×1024、390×844 响应式验证，结果见原型验收记录。
4. 服务开发启动后另行确认执行主体和运行版本；模拟不能替代真实多账号、Host 权限或生产路径验收。

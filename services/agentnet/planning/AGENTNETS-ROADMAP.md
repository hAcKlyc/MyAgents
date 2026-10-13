# AgentNets 后续规划

更新日期：2026-10-13。

AgentNets 服务端按多用户系统规划：同一服务实例可以承载不同用户，每个用户具有独立身份、设备、Bot、会话、资源授权和用量记录。跨用户协作通过显式授权建立，不能依赖共享账号或客户端隐藏按钮实现隔离。

产品称谓使用 AgentNets；现有源码目录和协议中的 AgentNet 命名保持原样。以下条目是后续需求，不表示已实现或已发布。

## 规划条目

| 任务 ID | 目标与范围 | 状态 | 完成标准与依赖 |
| --- | --- | --- | --- |
| AN-MULTIUSER-001 | 明确服务端多用户身份、资源所有权、会话隔离和授权边界 | 已整理设计，待开发 | 所有资源由服务端确认所属主体；不同用户的列表、搜索、订阅、文件及执行互不越权。先核实既有账号与网络模型，再设计兼容迁移 |
| AN-BOT-SHARE-001 | 第一版 Bot 共享：指定用户邀请、角色、独立会话、资源授权、额度、撤销和审计 | 已整理需求和权限设计，待开发 | 按[第一版设计](AGENTNETS-BOT-SHARING-V1.md)通过多账号真实路径验收；依赖多用户授权基础及 Host 执行隔离 |

这两项共同形成第一版共享能力。多用户是服务端架构前提，不是共享功能上线后再补充的扩展项。

## 初始本地规划记录

任务：AN-BOT-SHARE-PLAN-20261013。负责人：当前 Agent。本次仅整理规划，暂不开发。

- [x] 核对当前项目目录与既有 AgentNet 服务端资料。
- [x] 将多用户服务端确立为设计前提。
- [x] 整理第一版需求、角色矩阵、执行身份、撤销语义和后续验收标准。
- [x] 将共享条目加入本规划，并在项目接续文档中添加入口。
- [x] 回读文档，核验四处本地文档链接均可解析；需求涵盖第一版范围及多账号后续验收。
- [ ] 后续开发启动时，由开发负责人核实最新源码与运行版本，完成数据和协议设计审查。
- [ ] 后续实现、模拟验证及真实联调。
- [ ] 后续提交、主干交付、生产发布及真实路径验收。

本次完成标准是规划可查、范围清楚、权限可审阅、下一步可接续。代码实现、测试、提交和发布不属于本次约定范围。当前规划保存在 MoxBot 的本地项目文档目录，该目录不是 Git 仓库；未宣称已经同步到服务端远端主干。

## 已核实的源码基线

2026-10-13 只读检查了 `/Users/zhangshaohua/Documents/Codex/2026-10-12/myagents-selfhost-service`，当时分支为 `feat/mah-management-device-pairs`，HEAD 为 `7cdfe315`，工作区无未提交修改。此处记录的是本机检出，不代表当前远端主干或生产版本。

结束复核时，该检出出现 `scripts/host/install.sh` 与 `scripts/host/install.test.mjs` 的并行修改；本任务没有修改、提交或清理这些文件。规划由当前 Agent 单独整理，无子 Agent、外部模型调用或生产操作。

- `services/agentnet/src/store.rs`：OIDC issuer 与 subject 映射到持久化 principal；会话关联 principal。
- `services/agentnet/metadata-core/src/lib.rs`：设备和目录包含 network、principal、device 范围。
- `services/agentnet/src/relay_controller.rs`：当前目标设备路由要求双方 principal 和 network 一致。
- `services/agentnet/README.md`：中继传输不透明载荷，Host 保留配置与凭据权威；账号、入网和管理权限需要分别处理。

上述基础可作为设计接入点，不能据此认定跨用户 Bot 共享已经可用。后续需要新增按 Bot 范围的跨用户授权路径，保留现有设备管理的账号隔离。

## 共享能力开发的下一步

待用户启动开发任务后，先确认执行主体并核实权威源码，审查身份和网络模型、Bot 与运行实例映射、Host 隔离方式、授权凭证与撤销机制，以及用量预占策略。再建立实现任务，不提前修改服务端、客户端、官网或生产配置。

## 源码仓库同步与交互原型

任务：AN-SHARE-PROTOTYPE-20261013。用户追加授权将两份规划同步到源码仓库，并制作一版交互原型；真实共享服务仍暂不开发。

- 权威 Git 目标：https://github.com/heavenzhang/MoXBots.git ，主干 `main`。2026-10-13 用户授权将 `heavenzhang/MyAgents` 更名为 `heavenzhang/MoXBots`；GitHub 仓库 ID 1414574754 保持不变。历史提交、分支和旧接续记录保留。
- 两份规划的权威位置：`services/agentnet/planning/`。上方本地规划记录仅作为起始证据，本节与任务清单记录同步任务的当前进度。
- 本次交付清单：[TODO.md](TODO.md)。后续开发清单单独保留，原型通过不勾选真实共享服务验收。
- 原型源码：[AgentNets Bot 共享原型](../../../dev-docs/prototypes/agentnets-bot-sharing-v1/index.html)；交互与视觉约定见该目录 `DESIGN-BRIEF.md`。
- 跨任务入口：根 `codex-handoff.md`、`.agent-sync/project-map.md`、`.agent-sync/plan.md` 及本任务分支记录。
- 当前状态：文档同步与原型制作中；主干交付和原型验收结果以 TODO 与验收记录为准，不以本节表示已完成。

本次原型仅使用合成数据和独立浏览器存储，不调用真实模型、业务接口或认证服务，不替换已安装客户端、官网及生产服务。

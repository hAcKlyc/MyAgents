# 原型事实和状态边界

核验日期：2026-10-13。

- 用户确认 AgentNets 服务端应当是多用户系统，并要求将 Bot 共享纳入后续规划，真实共享服务暂不开发。
- 用户追加要求同步规划到源码仓库、更新任务清单及接续记录，并交付一版原型。
- 用户明确授权 GitHub 仓库更名为 `heavenzhang/MoXBots`。GitHub API 返回相同仓库 ID `1414574754`，新 URL 为 `https://github.com/heavenzhang/MoXBots`，主干为 `main`。
- 本任务 worktree 从 main `848c0592473a95d7e332b258ff433b11d722a5a3` 建立，实际包含 `services/agentnet/`；当前代码和运行实例的验收不随原型更新。
- 服务端既有 OIDC 主体与设备范围的源码接入点来自 `services/agentnet/src/store.rs`、`metadata-core/src/lib.rs` 等。本原型不调用它们，不证明跨用户共享权限已经实现。
- 原型覆盖的角色、对象和流程以 `services/agentnet/planning/AGENTNETS-BOT-SHARING-V1.md` 为依据。合成身份切换、模拟用量和 localStorage 不构成真实身份、账单或持久化证据。

资料来源是用户本次明确要求、GitHub 对实际目标仓库的 API 返回及本机 owning source，不采用同名第三方 AgentNets 产品的发布状态或规格。

- 用户随后纠正主入口为平台管理员的Bots管理界面。个人体验放客户端网络入口，现有Agent Net后续称Bots Net；旧个人原型归档且不作为验收对象。

- 2026-10-13用户追加管理员Bots生命周期（新建、配置、启停、删除、所属用户和Host分配），仍仅规划与原型。任务base为远端main5ee8f862，该头Test/Owned AgentNet均成功。新增平台权限、停止默认、回收站和分配规则为后续设计，不称现有后端已提供。
- 参考流程于同日阅读Portainer官方新建/详情/删除确认与Dify官方应用管理文档，来源与用途见services/agentnet/planning/BOT-ADMIN-LIFECYCLE-V1.md；仅文档研究，非竞品登录实测。

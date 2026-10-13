<!-- git-project-sync-task:version=1 -->
<!-- git-project-sync-task:branch=codex/agentnets-sharing-v1 -->
<!-- git-project-sync-task:base=848c0592473a95d7e332b258ff433b11d722a5a3 -->
<!-- git-project-sync-task:status=complete -->

# Task: AN-SHARE-PROTOTYPE-20261013

## Objective

按用户授权更名自有 Git 仓库为 MoXBots，同步两份 AgentNets 规划、任务清单和接续，交付服务端平台管理员 Bots 管理原型；客户端个人网络入口后续称 Bots Net。真实共享服务暂不开发。主 Agent 负责集成、main 交付与总验收。

## Acceptance criteria

- 新 URL https://github.com/heavenzhang/MoXBots.git 与 GitHub repo ID、origin 和 main 一致。
- 两份规划、TODO、项目地图、共享计划与综合接续可查，其他工作树修改保留。
- 管理员跨用户Bots目录、详情、授权治理、额度审批、共享暂停与审计，以及次级Bots Net个人接受和使用结果可操作。
- 视觉、交互、三视口响应式独立验收和主复核完成。
- 本分支与远端一致，最新 main 含成果；没有发布真实共享服务。

## Completed

- GitHub 仓库已更名，ID 1414574754 不变；新地址与 base 核验。
- 规划、TODO、项目地图与计划已写入；综合接续新增本任务，不改旧 owner 事实。
- 首次 bind gate 在干净且等于远端 main 的 worktree 通过；本任务同时接入 Git 协作结构，后续任务遵循 start/resume gate。
- 旧代表页已查看，初轮两项UI缺陷回交；用户随后纠正为平台管理员主视角，旧稿归档未验，新版由原worker重构。

## Verification

- PR #17 合入 main 锚点 `421718d6756cb73dfffaf54e94344a5e497caf8c`；远端 fetch、源码头祖先与合并树一致、最终 HTML hash核验通过。关闭记录提交不改产品，相关文档检查另见 DELIVERY.md。

- 新 URL 的 GitHub API、gh repo view 和 git ls-remote 成功。
- 管理员版独立视觉、交互和1440/768/390响应式接受；两轮产品修复，IR-01至IR-07关闭；主审关键路径通过。证据与交付见 dev-docs/prototypes/agentnets-bot-sharing-v1/。
- 61c0be04 推送后 handoff gate 通过、远端任务分支一致；其 CI 因新增验收脚本 CommonJS 导入失败，迁移 ESM 后本地完整 lint 通过，后续源码头 `7a977724421f6c2b6923f3b8d1640aac28809185` handoff gate通过，七项CI全成功，不以旧版本通过代替。

## Blockers and unknowns

- 当前无授权或环境阻断。当前任务已按规划/原型范围交付 main，PR #17 合入与远端祖先、树已核验。
- 真实认证、Host 隔离、业务持久化和生产共享不在本次范围，后续另行开发。
- 实现 worker 请求 gpt-6-luna/medium，独立 reviewer 请求 gpt-6.1-sol/medium；主模型精确变体、实际effort与用量未知，未调用外部模型。

## Next step

后续真实共享或客户端 Bots Net 更名由用户另行启动；负责人重读最新 main、核实执行身份和运行版本，再开启隔离任务。

<!-- git-project-sync-task:version=1 -->
<!-- git-project-sync-task:branch=codex/agentnets-sharing-v1 -->
<!-- git-project-sync-task:base=848c0592473a95d7e332b258ff433b11d722a5a3 -->
<!-- git-project-sync-task:status=ready-for-review -->

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

- 新 URL 的 GitHub API、gh repo view 和 git ls-remote 成功。
- 管理员版独立视觉、交互和1440/768/390响应式接受；两轮产品修复，IR-01至IR-07关闭；主审关键路径通过。证据与交付见 dev-docs/prototypes/agentnets-bot-sharing-v1/。
- 接续 gate 与主干交付待最终提交后核验，不能以本记录代表已同步。

## Blockers and unknowns

- 当前无授权或环境阻断。最终头部 CI、main合入仍待完成；PR #17 为审查入口。
- 真实认证、Host 隔离、业务持久化和生产共享不在本次范围，后续另行开发。
- 实现 worker 请求 gpt-6-luna/medium，独立 reviewer 请求 gpt-6.1-sol/medium；主模型精确变体、实际effort与用量未知，未调用外部模型。

## Next step

核验推送后的 handoff gate，同步最新 main，在当前头部 CI 全部通过后合入 PR #17 并核验远端 main；之后关闭 Git 交付待办。

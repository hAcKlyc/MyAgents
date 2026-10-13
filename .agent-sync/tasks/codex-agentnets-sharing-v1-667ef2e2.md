<!-- git-project-sync-task:version=1 -->
<!-- git-project-sync-task:branch=codex/agentnets-sharing-v1 -->
<!-- git-project-sync-task:base=848c0592473a95d7e332b258ff433b11d722a5a3 -->
<!-- git-project-sync-task:status=in-progress -->

# Task: AN-SHARE-PROTOTYPE-20261013

## Objective

按用户授权更名自有 Git 仓库为 MoXBots，同步两份 AgentNets 规划、任务清单和接续，交付本地交互原型。真实共享服务暂不开发。主 Agent 负责集成、main 交付与总验收。

## Acceptance criteria

- 新 URL https://github.com/heavenzhang/MoXBots.git 与 GitHub repo ID、origin 和 main 一致。
- 两份规划、TODO、项目地图、共享计划与综合接续可查，其他工作树修改保留。
- 原型邀请、接受、独立会话、审批、资源维护、委派边界、撤销及用量审计连贯可操作。
- 视觉、交互、三视口响应式独立验收和主复核完成。
- 本分支与远端一致，最新 main 含成果；没有发布真实共享服务。

## Completed

- GitHub 仓库已更名，ID 1414574754 不变；新地址与 base 核验。
- 规划、TODO、项目地图与计划已写入；综合接续新增本任务，不改旧 owner 事实。
- 首次 bind gate 在干净且等于远端 main 的 worktree 通过；本任务同时接入 Git 协作结构，后续任务遵循 start/resume gate。
- 原型代表页已查看，初轮两项 UI 缺陷回交实现者。

## Verification

- 新 URL 的 GitHub API、gh repo view 和 git ls-remote 成功。
- 原型验收进行中，证据与最终交付见 dev-docs/prototypes/agentnets-bot-sharing-v1/。
- 接续 gate 与主干交付待最终提交后核验，不能以本记录代表已同步。

## Blockers and unknowns

- 当前无授权或环境阻断。UI验收、分支推送、main合入仍待完成。
- 真实认证、Host 隔离、业务持久化和生产共享不在本次范围，后续另行开发。
- worker 请求 gpt-6-luna/medium；主模型精确变体、实际effort与用量未知，未调用外部模型。

## Next step

完成原型独立验收与主复验，更新 TODO 和证据后，只提交本任务文件并同步最新 main。

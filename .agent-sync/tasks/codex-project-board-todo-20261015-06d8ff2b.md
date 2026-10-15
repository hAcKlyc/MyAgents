<!-- git-project-sync-task:version=1 -->
<!-- git-project-sync-task:branch=codex/project-board-todo-20261015 -->
<!-- git-project-sync-task:base=8f7ebc21c3f342b0c6e65474127560da71f0ed4c -->
<!-- git-project-sync-task:status=ready-for-review -->
<!-- git-project-sync-task:scaffold=false -->

# Task: MOXBOTS-PROJECT-BOARD-TODO-001

## Objective
把原会话TODO和子Agent执行状态投影到具体看板任务：卡片简洁摘要，详情完整只读清单，原会话继续承担操作。基于当前四阶段看板，不推导Task完成、不重复创建任务。

## Acceptance criteria / To Do
- [x] 核实repo/main/隔离worktree及真实面板的数据来源；基线8f7ebc21。
- [x] 共用TODO reducer，支持TodoWrite/增量Task工具与原生plan覆盖；空清单、错误、历史与缺失有区别。
- [x] 现有Session activity只读投影包括进度，跨Session身份验证与旧客户端兼容。
- [x] 卡片/列表/详情显示完成数、当前步骤、子Agent状态；过期不冒充实时，勾完不自动完成Task。
- [x] 相关unit、类型、lint/build、实际React宽窄/深浅/导航回归与独立审阅。
- [ ] PR/CI/main远端核实；候选包纳入与原生验收另计，当前安装客户端不自动退出或重启。

## Execution record
主Agent实现；todo_review只读核对同源数据及独立UI，要求gpt-6-luna/medium，例行有边界审阅。实际型号/用量未独立暴露。不调用外部原因：用户沿用ai-yaoren-local纯内置模式。未动旧任务或统一打包工作区。

## Completed

- 共享Chat/Board TODO reducer、只读owner progress、卡片/列表/详情及中英文本均实现；exact Query active后台、native plan换Session/reset和历史/过期展示分别处理。
- feature commit3992d3bf已推远端任务分支，PR https://github.com/heavenzhang/MoXBots/pull/58；CI38684226016运行中，最终以最新head checks为准。
- 251项相关测试、类型/lint、MoXBots profile web/server、6组实际React合成UI与独立review通过；验收文档和证据随版本保存。

## Verification
observe/start/task-init gate通过，明确remote https://github.com/heavenzhang/MoXBots.git。原图为需求依据，不是状态数据。

## Blockers and unknowns
真实Provider与日常运行会话不得因验收而发送或中断。统一打包已有owner，源码/main与安装/发布分别追踪。

## Next step
同步main，提交PR/CI并核实远端主干；联系已获授权统一打包owner纳入exact SHA，包与原生验收不能由合成UI替代。

## Acceptance evidence
详见dev-docs/project-board-todo-acceptance.md与validation/todo；相关11文件251项通过，类型/lint/生产web/server通过，6组合成React UI通过。todo_review代码和深浅/540视觉审阅通过，未亲自操作原生。原生/真实Provider未执行；仅背景只读观察，不发送/停止既有业务。

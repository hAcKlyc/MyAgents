<!-- git-project-sync-task:version=1 -->
<!-- git-project-sync-task:branch=codex/host-config-20261013 -->
<!-- git-project-sync-task:base=2a2415916959957f4bf2614f66fee75989b875a1 -->
<!-- git-project-sync-task:status=in-progress -->
<!-- git-project-sync-task:scaffold=false -->

# Task: MOXBOTS-HOST-CONFIG-20261013

## Objective

当前Agent实现Host远程管理复用设置模型界面、一键应用当前MoXBots客户端主Agent配置、读取远程目录并选择工作区。用户已明确执行主体、主Agent来源及跨聊天协调/统一更新授权。权威源码为MoXBots；本任务不改固定credential reader或账号/登录方案。

## Acceptance criteria

- [ ] 设置和Host使用共享模型配置UI，支持选择已配置Provider/模型，实际支持由Host能力裁决。
- [ ] 一键应用客户端主Agent来源配置，展示来源与目标；本机路径在Host范围内解析/选择，凭据只走既有安全写入，不记录明文。
- [ ] Host允许根目录内真实目录浏览/选择，加载/空/错误/取消/身份变化可用，禁止跳出允许根及符号链接绕过；不新增公网或任意文件读取。
- [ ] 复用现有管理owner、revision、mutation receipt和加密通道；兼容已安装旧Host，不覆盖运行Session出生配置。
- [ ] 类型、相称DOM/Node/Rust回归、lint/build及非实现者UI与主审关键路径验收。
- [ ] 完整源码合远端main，源头/CI/远端祖先核验；基础Host分支交付依赖单独跟踪。
- [ ] 统一候选客户端/Linux Host联调和原生安装验收，由原凭据任务统一安装并协调本任务验收，不并发换包。

## Completed

- 已核对main 2a241591与Host试用远端9149753c，原owner工作树干净；本工作树start/task-init通过。
- 用户允许跨聊天协调；已通知“评估 MyAgents 精简为 Linux Host”模块范围、统一安装顺序及基础分支依赖，不改其未提交/后续工作。

## Verification

尚无本任务产品改动或验收。源码图谱、实际运行与试用分支需区分；旧归档/问答回归不充当本次验证。

## Blockers and unknowns

main尚无OwnedHostManagement/Host管理IPC；开发需本地引入远端冻结9149753c作为明确依赖，不能独自把未验收凭据方案发布或宣称基础已交main。最终Git集成与统一客户端依赖原owner交付。

## Next step

在冻结Host依赖上确定兼容能力、Provider和目录读取契约，划分互斥实现范围并完成共享UI与Host owner实现。

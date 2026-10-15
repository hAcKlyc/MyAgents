<!-- git-project-sync-task:version=1 -->
<!-- git-project-sync-task:branch=codex/title-session-acceptance-v2-20261015 -->
<!-- git-project-sync-task:base=205939249c057363d01163c6b0e4b6df717d5064 -->
<!-- git-project-sync-task:status=in-progress -->

# TITLE-001 普通 Session 自动标题真实验收

## Objective

继续用户明确授权的普通会话自动标题验收，并交唯一统一发布负责人完成 main / 正式 0.5.5 / 空闲客户端更新，不打断运行任务。权威 https://github.com/heavenzhang/MoXBots.git，main。范围为 `dev-docs/title-session-acceptance/` 及本记录，不改产品 profile、Session owner 或 modelqa guard。

## Acceptance criteria

见 `dev-docs/title-session-acceptance/README.md` 的勾选清单，分别记录模拟、真实后端、原生、main、发布及更新状态。

## Completed

只读审查真实普通成功 hook、SessionStore、SSE 权威链；独立 worktree 的 main start gate 通过，再快进冻结集成源 01deb0b1。真实本地 SDK 纯合成 trap 权限预检通过，0 上游 / 0 真凭据；不是普通模型或原生验收。

## Verification

预检 SDK 0.3.296 SHA c9b5341637becbd423ddffc5b254afb645682a3868cb708bbc6cc0e7bb419937；实际 init 工具空 / MCP 空，实际本地 wire tools 空。命令 `/opt/homebrew/opt/node@24/bin/node dev-docs/title-session-acceptance/preflight.mjs`。原生 A6 SDK 已深签名字节不同，不能把裸依赖 SHA 当作 A6 包字节 SHA。失败阶段与边界见 README；真实模型调用尚未开始。

## Blockers and unknowns

正常 Session 已真实启动并清退，但 400（脚本混用 SDK 权限枚举）及 503（真实 Rust 目标查询依赖缺失）两份失败均为 0 上游。已修脚本并按负责人裁定准备严格 A6 GoalStore 只读 adapter；其 token 交付与最终脚本复核未完，不调用模型。精确新目录 / Session UUID 绑定，其他 path / mutation 拒绝，不能把跨 owner 只读后台联调当正常 Rust 生命周期或原生验收。

原生窗口由统一发布负责人持有，系统 QA 私有钥匙串弹窗等待人类检查，不得用其他工具绕过。日常任务仍运行，安装不得执行。费用 / token 尚无实测。

## Next step

向统一负责人提交预检证据与精确正常 Session 启动方案；工具为空门禁通过后仅一次真实普通问答，读取自动标题 / V2 / SSE / 重载。待合法 GUI 交接再补原生路径，最终交统一 main 与发布。

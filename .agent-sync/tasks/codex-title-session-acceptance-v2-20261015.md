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

只读审查真实普通成功 hook、SessionStore、SSE 权威链；独立 worktree 的 main start gate 通过，再快进冻结集成源 01deb0b1。正常后台真实普通 `/chat/send` → 完整助手成功终态 → 原 hook 自动标题 → 索引 / V2 / SSE → 同 ID 重启恢复通过。实际标题“费用包金额统一万元展示与毛利校验”，16 字，2 个实际 Kimi k3 上游请求均 200；没有额外调用或手动生成接口。

## Verification

实际普通 SDK 0.3.296 SHA c9b5341637becbd423ddffc5b254afb645682a3868cb708bbc6cc0e7bb419937 与预检一致；真实 init 工具 / MCP 空，实际 wire tools 空、助手 toolCount=0。实际两条 SDK 端点都为 loopback；父子沙盒拒绝外网 / 非授权端口 EPERM，统一负责人独立复核。只读 Goal GET 真响应 + 预期 IM 403 保持原失败；两个自己 PGID 成员均为空。私有 kSW6qJ 原件、V2 哈希及完整边界见 README。原生 A6 与裸 SDK 不能按字节 SHA 直接等同。

## Blockers and unknowns

前置失败全部保留并修正：正常配置必须用自定义 Provider 文件及 config.baseUrl authority；preset 绕代理的一次不能证明直接尝试数 0。最终在无真密钥的本地诊断与 OS 网络隔离门禁后才调用批准密钥。仅使用真实 A6 GoalStore 读依赖，精确新目录 / UUID，其他管理 mutation 未透传；不能把跨 owner 只读后台联调当正常 Rust 生命周期或原生验收。

原生窗口由统一发布负责人持有，系统 QA 私有钥匙串弹窗等待人类检查，不得用其他工具绕过。日常任务仍运行，安装不得执行。费用 / token 未知；2 次真实请求及其本地耗时已实测。

## Next step

向统一负责人交原始通过证据和最终 branch head，主审后集入唯一统一 PR。待合法 GUI 交接补原生普通侧栏 / Tab、手动标题保护；随后 main / 正式发布 / 空闲安全更新及实际安装复验。只有完整门禁通过才标完成。

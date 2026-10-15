# TITLE-001 普通会话自动标题验收

用户于 2026-10-15 要求补齐普通会话自动标题，相关改动交付 main 后统一发布 0.5.5、空闲更新客户端，不打断已有任务。统一发布由原负责人拥有；本分支只准备验收脚本和证据摘要，不修改正常产品 owner 或 modelqa 护栏。

## 验收范围与门禁

- [x] main `205939249c057363d01163c6b0e4b6df717d5064` start gate；随后正常快进至协调冻结集成源 `01deb0b1adc8970389ab2e79553cfab4a521ab3b`。
- [x] 真实本机 SDK 0.3.296 的项目 deny 规则预检：`system:init.tools=[]`、`mcp_servers=[]`，实际本地请求 `tools=[]`。本地 trap 请求 1，真实上游请求 0，无真实凭据。
- [ ] 正常 moxbot 生产 Session-role sidecar，一次真实 `/chat/send`，真实成功 terminal 自动触发命名；最多 2 上游消息请求。
- [ ] `titleSource:auto`、有效概要、V2 持久化、真实 SSE、同源重载。
- [ ] 原生侧栏 / Tab 自动刷新、关闭重开、手动标题保护。
- [ ] 本次摘要提交、统一 main 包含，正式签名发布 0.5.5、空闲更新和更新后复验。

前两份无输入预检失败保留：SDK 默认列出 5 内建 Agent 定义，无输入不发 `system:init`；另一个脚本版本错误地从注释解析工具名，已改为只解析明确导出声明并验证合法、唯一名称。第三份本地请求因为 URL 含 query 参数被错误的末尾匹配拒绝，已改为精确 `URL.pathname`。这些均没有真实凭据或上游调用，不是通过证据。最终只将同时通过真实 init 与 wire tools 的一份 receipt 计为权限预检通过。

项目 `settingSources:['project']` 与 SDK 的普通 catalog 保持原实现。验收目录只增加标准 `.claude/settings.json` 的 `permissions.deny`，包含 `*` 和全部 29 个产品工具名；不把 default/plan 权限模式当作全部工具禁止。5 个 SDK 内建 Agent 目录仍如实保留，但 Agent/Task 工具不在实际调用面，无用户 / 项目 / 插件 Agent。

现有权限机制依据：[SDK permissions](https://code.claude.com/docs/en/agent-sdk/permissions)、[项目权限规则](https://code.claude.com/docs/en/permissions)。实际安装版本以预检 receipt 内 SDK 文件 SHA 为准，不单凭当前文档推断旧二进制行为。

## 真实执行约束

物理 0700 HOME、空工作目录、独立 `.moxbot`、随机 loopback 端口与新 Session；只用任务已授权 `moonshot-coding/k3` 配置，不加载其他历史、订阅凭据、系统钥匙串或环境登录。禁止普通模型回退，禁止 MCP、项目 hooks、Skills、插件或工具执行。启动前必须复核同一依赖 / 设置 / 端口 owner；真实普通回合初始化再核对工具为空。

只有正常 `/chat/send` 经真实成功 turn hook 进入 `session-title-service.ts` 才计为自动标题。不得手调生成标题端点、写 metadata、种植问答或将 `automaticSessionTitle:false` utility receipt 替代此链路。后端成功不等于原生侧栏通过。日常客户端、运行任务和人类已有 QA `test` 保持原状；GUI 必须串行交接，发布与安装不由本分支并发执行。

## 当前普通入口依赖

正常入口先经 `goal-orchestrator.ts` 查询 Rust 管理服务的 `GET /api/goal/get`，再交普通 SessionEngine。单独正常 Session sidecar 无此 owner 时实际返回 503，尚未调用模型。先前一次 SDK / 产品权限枚举混用导致 400，也未调用模型；脚本已用合法产品 `plan` 和后台 `inherit`，不改产品实现。

协调负责人审查现有 Rust handler / GoalStore 后，允许只读复用隔离 A6 的真实目标查询：仅新工作目录与正常服务权威生成的新 Session UUID，一次请求不得读别的会话，不允许 SDK 执行准入、目标写入或任何管理 mutation。真实响应原样转发，不合成 `goal:null`。Root 管理 token 仅 adapter 内存，Node 只得到新只读 adapter 地址及本地 token。精确文件交付和最终执行仍待负责人复核。

这种受控后台联调没有注册正常桌面 Rust 生命周期和 SDK circuit，必须明确 `normalDesktopSdkCircuitAccepted:false`；不证明原生侧栏、完整 App 更新计数或 modelqa 内普通执行。modelqa 护栏保持原样。

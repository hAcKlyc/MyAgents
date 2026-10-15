# TITLE-001 普通会话自动标题验收

用户于 2026-10-15 要求补齐普通会话自动标题，相关改动交付 main 后统一发布 0.5.5、空闲更新客户端，不打断已有任务。统一发布由原负责人拥有；本分支只准备验收脚本和证据摘要，不修改正常产品 owner 或 modelqa 护栏。

## 验收范围与门禁

- [x] main `205939249c057363d01163c6b0e4b6df717d5064` start gate；随后正常快进至协调冻结集成源 `01deb0b1adc8970389ab2e79553cfab4a521ab3b`。
- [x] 真实本机 SDK 0.3.296 的项目 deny 规则预检：`system:init.tools=[]`、`mcp_servers=[]`，实际本地请求 `tools=[]`。本地 trap 请求 1，真实上游请求 0，无真实凭据。
- [x] 正常 moxbot 生产 Session-role sidecar，一次真实 `/chat/send`，真实成功 terminal 自动触发命名；实际 2 上游消息请求。
- [x] `titleSource:auto`、有效概要、V2 持久化、真实 SSE、同源重载。
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

协调负责人审查现有 Rust handler / GoalStore 后，允许只读复用隔离 A6 的真实目标查询：仅新工作目录与正常服务权威生成的新 Session UUID，一次请求不得读别的会话，不允许 SDK 执行准入、目标写入或任何管理 mutation。真实响应原样转发，不合成 `goal:null`。Root 管理 token 仅 adapter 内存，Node 只得到新只读 adapter 地址及本地 token。执行后的临时 capability 清理由该文件的原 owner 负责。

这种受控后台联调没有注册正常桌面 Rust 生命周期和 SDK circuit，必须明确 `normalDesktopSdkCircuitAccepted:false`；不证明原生侧栏、完整 App 更新计数或 modelqa 内普通执行。modelqa 护栏保持原样。

## 最终真实后台结果（2026-10-15 10:28 CST）

正常自定义 API Provider `qa-kimi-title-055` 使用标准 `providers/*.json` authority，其中端点在 `provider.config.baseUrl`。它仅是本次批准 Kimi k3 的受控本地路由名，不证明内置 `moonshot-coding` preset 的覆盖机制。源码与实际 SDK 依赖维持冻结集成源，未修改产品 owner 或护栏。

一次普通人类输入得到真实完整助手答复，终态 `complete` / idle / nonbusy。原成功 hook 自动产生 **费用包金额统一万元展示与毛利校验**（16 Unicode 字符），不是输入开头。真实 SSE 事件携带同一 Session ID 与 `titleSource:auto`；生产 SessionStore 实际写入索引和 V2，`titleGenAttempts=1`。仅重启自己隔离 Session 进程、以同一 ID 恢复后，API 标题、来源及两个问答消息一致，无新增模型请求。没有手调生成标题接口、造问答、写 metadata 或重放标题事件。

SDK init 与实际请求工具均为空，MCP 为空，助手 `toolCount=0`。两次真实上游请求都为 k3 / 200，分别 9968 ms（普通答复）、5547 ms（自动标题）；这些是本地代理测量的请求耗时，不是供应商模型纯计算时间。计费金额和 token 未获得可信统计，不估算。

正常 SDK 与后续标题 SDK 的实际日志端点都为同一受控 loopback。macOS 临时进程沙盒仅允许两个指定 loopback 出站端口及自己一个入站端口；实现者及统一负责人独立验证父 / 子允许 HTTP 成功，未准许 loopback 和外网 443 均返回 OS `EPERM`。SDK 二进制真实路径及 SHA 与预检一致。所有自己 Node / SDK 两个进程组均在最终关闭后实际成员为空。

后台只有一次真实 A6 GoalStore 只读查询。正常产品额外尝试的两个 `POST /api/im/mirror` 全部在本地返回真实 403，不转发、不对外镜像；这是已审查的预期拒绝，不伪造镜像成功，也不计 IM 验收。其余拒绝违规 0。临时内存 capability 不给普通 Node。

真实后台证据位于本机私有 `moxbots-title-session-kSW6qJ` 目录：`receipt.json`、`session-readback.json`、`session-reloaded.json`、两个 `group-*-exited.json`。真实 V2 SHA-256 `ce1910b992fe0caaa3bcc4ad3b3ae2e4723a0cac3bd4f428d89f9ebde910fa03`。原始记录 / SDK 日志 / 本地 token / 账号配置不进入 Git。前置失败记录全部保留：尤其 preset 绕代理的一次只能断言 proxy 转发 0 / 真密钥未用，使用无效本地 token 的直接上游尝试未知，不能误写成外部请求 0。随后先以完全无真密钥且有 OS 网络限制的正常本地诊断验证配置，再进行本次唯一两次真实上游调用。

尚未通过：原生普通会话侧栏 / Tab 自动刷新、关闭重开、手动命名竞态、正常 Rust SDK circuit、统一主干交付、正式 0.5.5 发布 / 安装。后台记录不替代这些门禁，也没有操作日常客户端或打断其任务。

<!-- git-project-sync-task:version=1 -->
<!-- git-project-sync-task:branch=codex/model-failover-001 -->
<!-- git-project-sync-task:base=178b8047f78e51f843e5c0636d2e0182f192c8b1 -->
<!-- git-project-sync-task:status=in-progress -->

# Task: MOXBOTS-MODEL-FAILOVER-001 一主一备自动接管

## Objective

MOXBOTS-MODEL-FAILOVER-001：为 MoXBots 内置 Runtime 的 API 模型实现一主一备自动接管。当前会话选定模型保持主模型，故障在同一 Query 的推理请求边界切换备用；不重新排队用户任务、不回放工具、不截断历史。

## Acceptance criteria / To Do

- [x] 核实 authority、main178b8047、干净隔离分支、已有发布 owner 与 Runtime 接续边界。
- [x] 配置一个备用 Provider/model，默认关闭；复用 config.json 原写入 owner，支持失效与保存错误状态。
- [x] 内置 API 主模型 transient HTTP/连接/headers timeout 最多重试一次，然后备用；当前轮使用备用，下一轮恢复主。
- [x] 保留 SDK native transcript 与 Product Session/TODO/工具结果；已交付流中断、取消、权限/余额/参数错误不重放；双失败可诊断。
- [x] 合成 loopback 关键回归、真实 SDK + 受控本地工具零供应商调用验证、设置页交互/窄窗验收。
- [ ] typecheck/lint/build、独立审查、CI、PR/main/远端包含成果。
- [ ] 交付统一发布请求与原生/实际账号后续门槛，不并发操作现有发行窗口。

## Completed

- 主 Agent 负责核心桥接、配置/Session authority、集成/验收/main交付；runtime_audit 只读审查；failover_settings 负责互斥 UI/翻译/DOM 测试。未更换主 Agent 模型；工具未暴露精确用量/费用。
- 对照 OpenClaw 官方 Model failover 文档（https://docs.openclaw.ai/concepts/model-failover）。使用既有 bridge-token、SessionStore、config.json owner，不引入新的执行或持久化 owner。

## Verification

重点35项、此前组合247项和UI26项通过；真实SDK正常接管/断流停止两个fixture通过且counter均1；typecheck、web/server构建通过。完整证据见`dev-docs/model-failover-001-acceptance.md`。完整lint通过，合并最新main项目背景接续后55项和typecheck通过。PR https://github.com/heavenzhang/MoXBots/pull/73；CI/main验收正在推进。模拟上游不代表供应商联调；真实 SDK loopback 也不代表已安装版本包含成果。

旧格式会话新增接管提示不会终结运行状态的回归；TabProvider活动状态104项通过。服务端改用已有普通消息replay，重复提示去重，继续同一partial流，真实complete/idle才结束。

## Blockers and unknowns

- 订阅专属/managed/cloud-scoped 凭据和 external/DSH Runtime 不借用 API failover；明确支持范围。
- 流已交付后的失败不自动重放，不承诺外部工具 exactly-once。
- 发布聊天为01a12bc2-907a-7702-b6dd-788225c5dfe4，056冻结a81d2509；当前开发不自动加入冻结包。用户本轮未授权向另一个聊天发消息，保留 Git 发布请求，不宣称已通知。

## Deployment request

需要后续桌面/对应Host发布，本任务只交付同一源码；无需数据库迁移。保留既有关闭默认，新版本未启用时原模型路径不变。由统一owner评估下一个未冻结发行批次，按原备份/回滚/活动任务门禁发布。真实供应商主备与原生验收单列。

## Next step

完成最终lint/CI，合入并核验远端main；发布请求留给现有统一owner的下一未冻结批次。

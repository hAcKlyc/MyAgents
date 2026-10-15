# 内置 API 模型自动接管

任务 MOXBOTS-MODEL-FAILOVER-001。参考 [OpenClaw model failover](https://docs.openclaw.ai/concepts/model-failover) 的主备候选、有限重试、本轮接管和可见提示；实现遵守 MoXBots 自己的 Session/Query/配置 authority，不移植另一套会话 owner。

## 用户行为

设置 → 模型供应商 → 备用模型。当前会话选定模型保持主模型，用户选择一个明确的 Provider/model 对并开启；默认关闭。模型目录/API key 无效时不能开启。既有 Query 的开启状态在下一次空闲发送时经原配置重建入口生效，不中断已有任务或后台 Agent。备用身份与关闭状态逐请求重读；当前轮接管后优先备用，下一轮回到主模型。

支持内置 Claude Agent SDK 的普通 API 模型，包含 Anthropic Messages、OpenAI Chat Completions、OpenAI Responses。主备必须经过既有 providerHistory policy（含精确 model isolation）；与主模型同一对、被禁用/删除或缺凭据的备用不参与。订阅/OAuth、专属 cloud-session grant、DSH 与外部 CLI 保持原执行 authority，不借 API 配置切换。已存在 SDK 后台任务时不发起新接管，因为公共 Query token 不能证明请求归属哪个 root。

## Owner 与执行位置

- config.json 是 desired 配置唯一权威；`AppConfig.modelFailover` 只含 enabled 和备用的 providerId/modelId，无密钥。Renderer 使用原 updateConfig/atomicModifyConfig，保留并发其它字段。
- Session 仍拥有选定主模型。`builtin-session/model-failover.ts` 从原 effective catalog/credential resolver materialize 备用，不能把临时接管写成用户主模型。
- 每个 Query 的既有 `/bridge/<token>/v1/messages` registry entry 拥有一个 controller。退役 token 隔离旧 Query，控制器 exact state 防止旧请求修改后续轮次；root 采用首次请求的稳定 scope，人工 steering 不重开预算。原 turn-lifecycle 终态清理释放 scope。
- 原生 SDK transcript 继续拥有执行上下文，原 SessionStore 继续拥有产品历史。SDK 接到的仍是同一次推理请求的响应；应用不重新 enqueue 用户指令，不创建 fresh native session，不回退历史、不执行任何工具。
- 本轮切换在原产品历史插入独立 diagnostic，原有工具结果/TODO 不被替换。OpenAI 备用响应投影实际备用 model，主模型 desired 不变。

## 故障与预算

可恢复错误仅 HTTP 408/429/500/502/503/504/529，以及桥接层映射的连接失败/headers timeout。主请求失败后最多重试一次，仍失败则尝试一个备用；后续该轮推理使用同一备用身份，凭据每次重新读取，失败不回切主模型。headers 上限 30 秒。错误正文读取上限 1 秒/16 KiB，截断、损坏或超限保留上游 HTTP 状态并停止自动恢复。

认证、权限、余额/付费额度、参数/上下文/模型错误和策略拒绝不切换。429 的结构化 billing code 与明确欠费消息复用既有错误分类。工具错误不是模型服务错误。可见 HTTP 200 文本不被猜测成故障；不按回答质量自动换模型。

## 重复执行与不确定性

每个 logical root 对 model/system/messages/tools 的指纹只允许一条在途/已交付请求；cache_control 不参与指纹。桥接内部有限重试属于同一请求，SDK 之后自动再次发送相同请求会收到 409，避免依赖 SDK 自己的重试配置实现安全边界。

SSE 已向 Runtime 交付后如断流、error event 或 EOF 缺 message_stop，封闭本轮所有自动恢复请求，包括修改历史后的隐式续发；保留已完成工作并报告失败。原 root 终态之后的新输入可按既有恢复路径执行。取消、token/turn/config 变化在每个异步故障决策后重新检查，不再发新备用请求。

备用推理收到完整历史和应用控制的接续指令：基于已有工具结果继续，不重做已确认写入/发送/提交/部署；结果未知时先只读核实，不能核实就停止。此机制防止本应用因故障重放整条任务，**不提供任意外部工具的 exactly-once 事务保证**；模型仍可能提出新的同义动作，外部幂等和业务核验仍由原工具/业务 owner 负责。不会删历史、工具或图片来强行适配备用；实际不支持时终止并保留现场。

## 验证与发行

`src/server/openai-bridge/model-failover.integration.test.ts` 使用真实 loopback HTTP；`builtin-session/model-failover.integration.test.ts` 验证配置/生命周期策略；组件 DOM 测试覆盖精确路由、保存与失效状态。`scripts/verify-model-failover-loopback.ts` 使用安装的真实 SDK/native child 和本地 MCP counter，无供应商调用；普通模式验证工具执行一次后503接管，`--stream-failure`验证已交付断流后停止且无备用/重复计数。

验收摘要见 `dev-docs/model-failover-001-acceptance.md`。模拟供应商、真实 SDK loopback、原生安装/真实供应商分别追踪；本任务不改变已冻结的发行候选，由统一发行 owner 选入后续批次。

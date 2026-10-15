# MOXBOTS-MODEL-FAILOVER-001 验收

2026-10-16（Asia/Shanghai）。基线main178b8047，分支codex/model-failover-001。当前Agent拥有集成、源码审查、关键路径复验和主干交付；发行由既有统一owner串行处理。

## 已验证的行为

- 设置默认关闭、精确Provider/model单备选择、缺key/失效状态、保存失败与并发保存锁：组件10项、邻接界面合计26项DOM测试通过。
- 真实loopback HTTP +策略35项重点回归通过：已完成工具结果传递至Anthropic/Chat Completions/Responses备用；主重试一次/备用一次；同体并发/重发409，不同推理并发只切一次；完整SSE terminal后正常关闭不封root；部分流断裂、缺终态、迟到成功及取消/撤scope不继续交付或重放。
- 错误正文悬挂/超大正文在有限时间/体积内停止，保留原HTTP事实；429结构化/中文欠费不换备；备用禁用/删除/撤key/更换后不偷偷回primary；key轮换采用新凭据；人工steering不重开预算，root terminal后下一轮恢复主。
- 较早组合回归247项通过，覆盖SessionEngine127、turn-result与providerHistory策略、既有bridge超时与prompt cache39、设置26；本轮后续修复重点35项重新验证，无unhandled rejection。
- TypeScript检查通过；web构建与theme8项通过；server bundle通过。完整lint（ESLint、依赖边界、文档路由）通过，现有依赖warning未新增；合入项目背景接续后的组合55项及typecheck通过。PR73与最终CI/远端main状态见Git记录及本机交付回执。
- 旧格式会话的切换提示使用普通消息replay，不触发完成事件；104项活动状态回归通过，包括重复提示去重、原流继续拼接及真正结束后提交完整回答。renderer既有Message投影不含diagnostic类型，显示普通assistant提示；服务端保留类型以隔离后续正文合并。

## 真实 SDK、模拟上游

运行安装的Claude Agent SDK/native child，经本地桥接和本地MCP counter；没有供应商模型请求、没有使用真实账号或密钥。

- 正常接管：primary调用3次（首次tool_use + 两次503），backup1次，switch1次；工具counter=1，backup收到count=1并返回真实SDK success终态。
- `--stream-failure`：首次工具后主响应已部分交付再断流，primary2次，backup0次，switch0次；counter仍1，SDK失败/停止，桥接阻止隐式恢复重新执行。
- 脚本 `scripts/verify-model-failover-loopback.ts` 可复现；零付费调用是该本地fixture的事实，不能推断真实供应商质量、价格或SLA。

## 实际组件界面

IAB后台访问隔离组件fixture，使用产品真实组件、CustomSelect、主题CSS及中文资源，合成供应商和localStorage writer。1280×720与390×844无横向溢出；选择/开启、规则展开、失败保持原设置、刷新后保留合成配置均通过。主Agent未实现此UI，进行了独立整体验收。

截图与执行日志位于本机MoxBot项目 `output/model-failover-001/`（不提交二进制截图/缓存）。这证明组件渲染与交互，不证明Tauri实际config文件或已安装客户端含本功能；原配置writer的单元/DOM合同沿用，原生实际设置持久化仍待发行窗口。

## 证据边界与发行请求

支持内置Runtime普通API模型。专属订阅/OAuth/cloud会话、DSH、外部CLI保留原authority，不借API执行；后台任务归属不明确时不启动新切备。历史/工具完整保留，不承诺任意外部工具exactly-once，未知结果必须先核实。

尚未进行真实供应商故障注入、付费推理或原生安装/生产验收。现有0.5.6已冻结其他候选，本功能不能静默加入；发布请求在任务记录，由统一owner选入下一未冻结版本。没有安装、关闭、重启用户日常客户端，没有修改真实主备配置，没有向另一个聊天发消息。

## 协作记录

主Agent：核心实现/状态owner/集成/真实SDK与UI验证/main交付。failover_settings：互斥UI与翻译/DOM；runtime_audit：只读架构/安全审查与独立HTTP行为测试。三轮重点修复覆盖协议/并发、root防重放、成功取消与迟到取消。参与者模型精确变体、Token和费用未由工具暴露，不估算节省。

复盘：在单次推理边界接管避免重放整个Agent任务；最值得保留的回归是“完整tool_use terminal后正常关闭”和“备用失效后root门禁仍在”。以后先覆盖这两种原生生命周期，再扩大Runtime范围。

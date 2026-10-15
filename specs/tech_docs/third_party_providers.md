# LLM Provider 架构

MyAgents 把“用户选择哪个 Provider / model”与“执行时如何取得 credential 和构造 transport”分开。Provider 定义、模型表和当前 endpoint 以 `src/shared/config-types.ts` 及配置 resolver 为准；本文不复制易变的预设列表。

## 核心表示

### ProviderRoute

`ProviderRoute` 是可持久化的选择 identity，表达 Provider ID、model 和 subscription/provider kind。Product Session 的 current metadata/config snapshot 使用 route，而不是保存可执行 secret。

### ProviderEnv

`src/server/provider-types.ts::ProviderEnv` 是 builtin execution 的进程内 materialization，可能包含：

- `providerId` / `providerName`；
- `baseUrl`、`apiKey`、`authType`；
- `apiProtocol`、OpenAI upstream format / token limit；
- model aliases；
- host-managed credential 或 proxy-managed endpoint 的非 secret reference。

它只供 Sidecar 当前执行、probe、title/vision one-shot 或 Bridge 使用。新 Session 不能把 materialized API key 写回 session metadata；legacy `providerEnvJson` 只在兼容读取边界使用并在外部 projection 中 redacted / 移除。Agent / IM Channel 配置仍可能维护供后台自启动的兼容 projection，但 `config.json` 的 Provider/API-key 配置仍是 credential authority，projection 不能成为第二份可编辑真相。

### Runtime-backed Provider

`codex-sub` 是 Provider-shaped 的产品选择，但 execution 实际为 Managed Codex Runtime。它不能 materialize 为 builtin `ProviderEnv`：

```text
Provider choice: codex-sub
  -> ProviderExecutionIntent(runtime-backed)
  -> runtime=codex, source=managed-provider
  -> Session birth 时冻结 execution identity
```

Agent / Channel defaults 保留 Provider choice，不把 managed runtime projection 混成用户自带 Codex CLI 配置。执行 Session snapshot 才携带完整 runtime/source/model。

## Auth owner

| Provider 类型 | Credential owner | Materialization |
| --- | --- | --- |
| `anthropic-sub` | Claude Code native credential store | 不设置第三方 base URL/key；不设置 host-managed marker |
| 普通 API Provider | `config.json` / Provider API key store | 按 Provider definition 生成 `ProviderEnv` |
| `xai-sub` | Rust `GrokAuthManager` | `ProviderEnv` 只携带 managed credential reference；SDK Bridge 或 DSH Host 凭据端口每请求取 bearer |
| `codex-sub` | Managed Codex Runtime | 不进入 builtin ProviderEnv |
| `antigravity-sub` | 原版 CLIProxy；Rust 只拥有组件、账号目录和准入 | endpointSource → 异步 binding → SDK 或 DSH 直连 Anthropic 接口 |

Subscription 是产品/计费类型，不决定执行 Runtime 或 auth owner。官方 `anthropic-sub` 和 `anthropic-api` 只在 Claude Agent SDK 执行；`codex-sub` 由 Managed Codex 执行。其余已声明通用 API family 的 Provider 可由 Claude Agent SDK 或 DSH 执行；Grok OAuth 与 Antigravity CLIProxy 仍由上述唯一 Host owner 管理。新增 subscription 必须显式选择 `sdk-native`、`host-managed-oauth`、`proxy-managed` 或 `runtime-managed`，不能把所有 subscription 当成“空 ProviderEnv”。

## API Provider env

### Token Dance 模型协议与账户接入

`tokendance` 仍是一个普通 API Provider。公开模型目录的 `supported_protocols` 经发现服务映射到 `ModelEntity.supportedProtocols`，随 `presetCustomModels` 合并保存；新增与手动输入的模型 ID 都要先取得可用的协议能力。自动刷新只更新能力，不替换用户的名称、启用列表或首选。目录返回不认识的协议集合时保留空集合，不能借 Provider 默认协议冒充兼容。

`src/shared/provider-model-routing.ts::resolveProviderForModel` 是唯一逐模型路由策略。TokenDance 保留 Anthropic Messages → OpenAI Responses → OpenAI Chat Completions 的能力优先级。该策略依据具体模型生成不可变的 Provider execution projection，配套选择 `apiProtocol` / `upstreamFormat` / `baseUrl` / 认证与输出参数。`materializeProviderRouteEnv`、Task、IM、vision 和 provider probe 在既有入口接入；Renderer 使用同一纯函数显示模型对应的推理选项。未声明 `modelRouting: 'per-model'` 的普通 Provider 保持固定路由。切换协议由既有 `providerEnvEqual` 与 Query 重建路径处理，不修改全局 Provider。

`src-tauri/src/tokendance.rs` 在应用生命周期内拥有一次临时 PKCE loopback 授权。随机 `127.0.0.1` 回调路径接收一次 code；Key 通过 `with_config_lock` 保存到原有 `config.json`，并校验开始授权时的凭据版本，避免旧授权覆盖新账户。磁盘保存失败可重试同一 Key；凭据版本冲突则终止旧授权、释放待保存 Key，并由既有失败面板引导重新授权。面板打开期间持续等待，最后一个面板关闭后保留 15 分钟；不跨重启恢复。原生事件不携带 Key，ConfigProvider 在应用层刷新配置和既有可用供应商投影，隐藏设置页不影响授权保存。

OAuth `app_url` 与请求头 `X-App-URL` 同时固定为 `https://myagents.io`（无尾斜杠）。Anthropic 请求通过既有 SDK child `ANTHROPIC_CUSTOM_HEADERS` 注入，独立验证诊断请求在 `provider-probe.ts` 的出站入口注入，OpenAI Bridge 根据该请求所属 Provider 注入，Rust 账户 / 充值 client 和模型目录请求也携带同值。大小写不同的旧归因头不能覆盖固定值，不修改进程全局环境或其他 Provider 的请求头。

余额与充值 API 经 Rust 的 Provider-aware HTTP client。余额是账户原始微元，UI 两位小数只用于展示；请求和 UI 结果绑定凭据版本。只有供应商明确返回的 `TokenDance-Recovery-Action` 控制重新授权、充值或管理 Key 额度，不从普通网络错误 / HTTP 状态推断。

充值 attempt 只属于当前面板；提交才创建，打开时轮询供应商会话，关闭后停止本地请求并忽略迟到结果。没有持久订单表、后台付款轮询或本地余额加减。关闭不代表远端订单已取消，旧二维码直到供应商过期前仍可能被支付。

### OpenCode Go 逐模型路由

`opencode-go` 是 API Provider；官网 Endpoints 表的模型和唯一协议随 App 预设于 `src/shared/opencode-go.ts`。公开 `/zen/go/v1/models` 目录用于发现 ID，当前响应不提供协议；预设之外且目录没有唯一可信协议的模型必须在原有 `ModelSettingsEditor` 选择 Protocol 才能保存。用户手选执行协议存于 `ModelEntity.executionProtocol`，与目录声明的 `supportedProtocols` 分离；前者优先于后来新增的官方映射，冲突在编辑器提示。普通固定 Provider 不显示 Protocol 设置，TokenDance 也不要求用户手选。

执行路径仍是现有 SDK Anthropic 直连或 OpenAI Bridge 的 Responses / Chat Completions 转换。SDK child 环境使用 `ANTHROPIC_CUSTOM_HEADERS` 与 `CLAUDE_AGENT_SDK_CLIENT_APP` 发送 MyAgents 身份；Bridge 和独立诊断从各自出站入口设置。`x-opencode-session` 是 Product Session ID 的不透明稳定摘要，标题和视觉等关联调用沿用该 Session ID，验证调用使用独立临时身份。它不是 Provider 静态配置，也不写入会话元数据、日志或分析。三协议不互相试错；同一 SDK Query 中显式跨协议子代理仍不支持。

### SDK child 环境

`buildClaudeSessionEnv()` 每次从 clean baseline 构造 SDK child env。切换 Provider 时必须显式设置或清除 `ANTHROPIC_BASE_URL`、`ANTHROPIC_API_KEY`、`ANTHROPIC_AUTH_TOKEN` 及 model aliases，不能让上一个 Provider 的值泄漏。

Auth header 由 Provider 的 `authType` 决定：

| authType | Env 语义 |
| --- | --- |
| `api_key` | 只设置 API key |
| `auth_token` | 设置 bearer token；当前 SDK 兼容路径同时封住 stale key lookup |
| `auth_token_clear_api_key` | bearer token + 显式空 API key |
| `both` | 两个变量都设置；只作为定义明确要求或兼容默认 |

不要在文档中把“所有 Provider 必须设置两个 key”当成通用规则。具体 Provider 的 `authType` 是唯一决策源。

Provider model aliases 同时影响主 Query 和 SDK sub-agent 选择。Context window、output token 参数、input modalities 和模型显示名从 Provider registry / discovered models 解析；静态文档不维护副本。

## Anthropic subscription

`anthropic-sub` 使用 Claude Code native OAuth / keychain：

- 不通过 MyAgents `getOAuthToken` 注入；
- 不重定向 `CLAUDE_CONFIG_DIR`；
- 清空 inherited third-party routing/auth variables后让 native client读取其 credential；
- 跳过 `CLAUDE_CODE_PROVIDER_MANAGED_BY_HOST`，避免把 native subscription误标为 host-managed Provider。

MyAgents 仍拥有 Session、permission、proxy scope 和 tool surface，但不拥有 OAuth refresh。

## Grok subscription

`src-tauri/src/grok_auth/` 的单例 `GrokAuthManager` 拥有 device login、atomic credential store、refresh gate、credential version 和 quarantine。

Claude Agent SDK 执行路径：

1. Sidecar Provider resolver生成带 `credentialSource` 的 ProviderEnv；
2. OpenAI Bridge 每个 upstream request向 Rust management API取得 bearer + opaque credential version；
3. upstream 首次返回 401 时，只允许针对被拒 generation强制 refresh一次，并以 byte-equivalent request重试；
4. recovery 后仍是 401，才 quarantine 对应 credential version；
5. 403 表示 entitlement / region / model 问题，429 表示 rate/quota，不能触发 auth refresh；
6. completion 只上报 status 与 generation，不记录 bearer。

DSH 用 OpenAI Responses profile 发起模型请求，每次经现有 Host credential port 向同一 Rust owner 取当前 bearer，不在 DSH profile、配置或环境变量中持久化 bearer。DSH 的通用 pi-ai adapter 没有 Bridge 的 upstream 401 回调，因此首次 401 的同轮强制刷新/重放仅属于 SDK Bridge 路径；DSH 目前让该轮按真实失败结算。不能把 403 或 429 推断为过期 credential，也不能声称两条路径有同轮恢复能力。

One-shot verification 必须在完整 SDK / translator terminal success 后才提交 verified state。收到 2xx headers 不等于 turn 成功；旧 generation 的 late failure 不能污染新登录 lineage。

## CLIProxy subscription

`antigravity-sub` 可由 builtin SDK 或 DSH 消费同一 CLIProxy binding。Rust `CliProxyManager` 管理原版组件、active/candidate 目录、浏览器回调运输和 Query lease；OAuth/refresh 与协议转换归 CLIProxy。统一 `prepareProviderBinding()` 覆盖主 Query、pre-warm、标题、vision 及后台 Session。登录由原版账号摘要确认后即完整可用，无模型测试；模型从原版接口读取，不加白名单。binding 携带原生模型元数据，SDK env builder 拒绝未准备或持久化拷贝的 endpoint reference。

客户端普通升版不改组件资源；CLIProxy 更新按最低 MyAgents 版本策略分发。账号清理、更新 draining、稳定 history、资源发布操作手册与原版接口合同见 [托管 CLIProxy](./managed_cliproxy.md)。Grok 继续使用自己的 Rust OAuth + Responses Bridge，不做迁移。

## OpenAI Bridge

OpenAI-protocol Provider 仍让 Claude SDK 对 loopback 发送 Anthropic-shaped request：

```text
SDK subprocess
  -> /bridge/<opaque-token>/v1/messages
  -> bridge registry resolves this subprocess's live upstream config
  -> translate to Chat Completions or Responses
  -> Provider-aware proxy + auth
  -> translate stream/result back to SDK
```

每个 SDK subprocess 使用独立 bridge token。Active Session、verify、title、vision 和 sub-agent 不能共享 process-global “current upstream”；registry entry 由创建者在 `finally` 注销，没有 token 时 fail closed。

### Cache affinity

Session affinity 只提供 conversation identity，不证明目标支持缓存扩展。`src/shared/provider-prompt-cache.ts` 根据实际 endpoint 和已翻译的模型判断 key / explicit breakpoint 能力；两者独立。当前只信任官方 OpenAI `/v1` endpoint，断点仅用于已核实支持的模型族；第三方、代理和未知 endpoint 保留基础请求形状。SDK 模型别名与 `[1m]` 修饰先经统一 model resolver 归一化，再用于能力决策和匿名 key。仅系统块确实含缓存标记时才为断点改用 developer content，不转译 Anthropic TTL，不承诺缓存语义等价或命中。

One-shot probe、title 和 vision 不使用 conversation affinity。连接验证只证明该模型的基础调用，不测试长上下文、完整工具集或实际会话的缓存命中；未知 endpoint 的 active / one-shot 缓存字段和系统消息形状保持一致。可信目标的 active request 才添加缓存特征。

上游 400/422 明确归因于缓存字段（包括结构化 param / detail.loc）或精确识别的新增 role/content shape 时，分别只允许一次 key / breakpoint 降级并从源请求重译；无关错误不重试。兼容观察属于 exact bridge generation，按 Provider、endpoint、实际模型和协议隔离；同 token 的模型/endpoint 切换不继承别的目标结论，新 subprocess 不继承旧 generation。并发首次请求各自有界，不串行探测或建立全局永久黑名单。

### Timeout 与终态

Bridge 对“等待 response headers”有有界 timeout；成功 streaming body 由 SDK turn、AbortSignal 和 stream protocol owning，不应用一个短固定总时长截断长回答。HTTP status、stream error、model refusal、translator failure 和 SDK terminal 必须保持可区分。

普通 401/403/429/5xx 不做通用重试。只有明确的 managed-auth 401 recovery 和精确识别的 cache compatibility downgrade 拥有各自单次重试预算。

Responses streaming 与 non-streaming 共用 terminal policy：completed 才允许 end_turn / tool_use；incomplete 的 max_output_tokens（无工具调用）投射为 max_tokens 并保留终态 usage；content_filter、未知 incomplete reason 和截断的工具调用进入错误，不执行不完整工具。response.failed / error 保持错误语义；没有真实协议终态的 EOF（包括空流）不能补成成功。真实终态立即结束下游并释放 upstream，不等待 provider 关闭连接。streaming failure 在 error 之前投射可用的终态 usage，Anthropic error 本身不承诺 SDK 最终失败结果会保留计费统计。

### Responses 转换契约

SDK `disable_parallel_tool_use` 保持为 `parallel_tool_calls: false`。工具 schema 原样传入并显式设置 `strict: false`，避免 Responses 的 strict normalization 改写可选字段。请求显式 `store: false`，不使用 previous_response_id / conversation；SDK 每轮发送 Anthropic-shaped history。该桥接不回放原生 reasoning item 或 encrypted reasoning，因此不能声称完整推理连续性。工具返回图片仍经现有 image saver 转成本地路径提示，保存失败时省略；这是有损兼容，不保证模型可见图片。

### Proxy

SDK child 到 Sidecar 是 loopback，必须剥离 proxy env。Bridge 到 upstream 使用 `getProxyForProviderUrl(providerId, url)`，详见 [`proxy_config.md`](proxy_config.md)。

## Session 切换与 history boundary

Provider / model 是 Session config。用户在已有 Session 修改它时：

1. 通过 SessionEngine / builtin config owner 验证并写入；
2. process-baked env 或 bridge identity 变化时 replacement 当前 Query，不在旧 child 上热改 env；
3. Product Session ID 保持不变；
4. 是否继续 resume 原 SDK transcript 由 `src/shared/providerHistory.ts` 的 policy 决定。

当前 history family：

- Anthropic direct；
- portable third-party（Anthropic protocol 与 OpenAI Bridge 都保持 Anthropic-shaped transcript）；
- runtime-backed `codex-sub`；
- 只有确有证据的 Provider/model/endpoint 才进入 isolated key。

Renderer 的 Provider definition 经 `optionResolve.ts::toProviderHistoryEnv` 转为非敏感历史身份后，再交给共享 policy 比较。转换必须读取 `subscriptionAuth`：Grok 保留声明的 API endpoint，Antigravity 保留稳定 `endpointSource`，不能因 `type: subscription` 丢掉这些信息并误归为 Anthropic direct。代理端口与本地凭据不参与历史身份。

跨 family 时不能把旧 SDK execution identity 直接 resume 到新 transport；应在同一 Product Session 中创建新的 execution lineage。不要按 Provider 名称在各 UI / route 重新实现比较规则。

## Server tool projection

部分兼容 API 会在 stream 中发送 `server_tool_use`，并可能把 input 编成 JSON string 或附带装饰性文本。`agent-session.ts` 负责：

- 把 server tool 与 client-side `tool_use` 分开建模；
- 在完整 input 到达时解析已知 JSON string；
- 只对同时满足精确多标记的已知 wrapper 过滤装饰文本；
- 保留无法安全识别的原文，避免误删用户内容；
- 对 server tool result 维持正确 stream index、计数和 UI projection。

这是一条 protocol compatibility boundary，不应写进某个 Provider UI component。

## 自定义 Provider

### 模型目录发现生命周期

Renderer 的 `useProviderModelDiscovery` 由当前面板拥有，仅在打开、连接身份（Provider ID、Base URL、modelListUrl、有效凭据 / managed 模式）或发现资格变化时重新订阅；显式刷新 / 重试由按钮触发。模型名称、启用列表、首选、配置 projection 与回调引用都不是请求身份。尤其不能让日志驱动的 Settings 重渲染触发外部请求，否则请求自身的 Rust 日志会形成并发反馈循环。

普通模型面板与 Token Dance 详情复用该生命周期；Token Dance 公开目录不依赖账户 Key。仅复用当前组件尚未完成的请求以承受 effect replay，不建立全局结果缓存或自动重试。切换、关闭或失去资格后，旧结果不能进入当前展示或发起能力补全；已提交的 native 单次 HTTP 没有取消接口，仍由 Rust 现有 15 秒 timeout 收敛。

发现服务仅在有效 `data[]` 目录为空、或过滤已停用模型后无可用项时显示空态；上游错误、未知 envelope 或没有有效模型 ID 的非空响应进入可重试错误态，不能伪装为空列表。兼容原有 OpenAI / Anthropic `data[]` 格式、URL 推断与认证规则，不通过尝试多个端点或认证方式猜测自定义供应商协议。能力补全仍由 ConfigProvider 在 Provider 文件锁内重读后补缺；磁盘上的连接已变更时丢弃旧连接的补全意图。

### 接入规则

Custom Provider 复用相同 route/env/bridge 架构。新增或修改时：

1. 在 Provider registry 定义 protocol、auth type、endpoint 和 model capability；
2. credential 留在 config authority，不写 Session；
3. OpenAI protocol 走 per-subprocess Bridge；
4. model aliases 缺失时由现有 resolver 按 primary model 补齐，不在调用点猜；
5. provider probe 使用相同 auth、proxy、timeout 和 protocol projection；
6. 用 Provider ID / model identity 做 analytics，日志不输出 key 或 bearer。

## 验证

测试至少覆盖：

- route 与 ProviderEnv materialization，以及 runtime-backed Provider 被拒进 builtin path；
- 四种 auth type 的 env set/clear 与 subscription stale-env 清理；
- Anthropic native credential owner 和 Grok managed OAuth generation；
- OpenAI Bridge token isolation、translation、headers timeout、terminal semantics；
- 401 单次 refresh / quarantine，以及 403/429 不 refresh；
- Provider history family 与 Query replacement；
- legacy session providerEnv redaction / repair；
- `server_tool_use` input 和装饰性 wrapper 的精确兼容。

## 可选主备模型接管

内置 API Session 的自动切换由原 Query bridge-token 拥有，配置、HTTP恢复/防重放和不支持范围见 [内置 API 模型自动接管](model_failover.md)。临时备用不是用户选定模型，不写回 Session desired config；已交付流中断保留现场并停止。

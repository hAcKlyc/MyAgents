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
- host-managed credential 的非 secret reference。

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
| `xai-sub` | Rust `GrokAuthManager` | `ProviderEnv` 只携带 managed credential reference，Bridge 每请求取 bearer |
| `codex-sub` | Managed Codex Runtime | 不进入 builtin ProviderEnv |

Subscription 是产品/计费类型，不决定 auth owner。新增 subscription 必须显式选择 `sdk-native`、`host-managed-oauth` 或 `runtime-managed`，不能把所有 subscription 当成“空 ProviderEnv”。

## API Provider env

### Token Dance 模型协议与账户接入

`tokendance` 仍是一个普通 API Provider。公开模型目录的 `supported_protocols` 经发现服务映射到 `ModelEntity.supportedProtocols`，随 `presetCustomModels` 合并保存；新增与手动输入的模型 ID 都要先取得可用的协议能力。自动刷新只更新能力，不替换用户的名称、启用列表或首选。目录返回不认识的协议集合时保留空集合，不能借 Provider 默认协议冒充兼容。

`src/shared/tokendance.ts::resolveProviderForModel` 是唯一优先级策略：Anthropic Messages → OpenAI Responses → OpenAI Chat Completions。它依据具体模型生成不可变的 Provider execution projection，配套选择 `apiProtocol` / `upstreamFormat` / `baseUrl` / 认证与输出参数。`materializeProviderRouteEnv`、Task、IM、vision 和 provider probe 在既有入口接入；Renderer 使用同一纯函数显示模型对应的推理选项。普通 Provider 保持原行为，Runtime / Bridge 不读取供应商能力数组。切换协议由既有 `providerEnvEqual` 与 Query 重建路径处理，不修改全局 Provider。

`src-tauri/src/tokendance.rs` 在应用生命周期内拥有一次临时 PKCE loopback 授权。随机 `127.0.0.1` 回调路径接收一次 code；Key 通过 `with_config_lock` 保存到原有 `config.json`，并校验开始授权时的凭据版本，避免旧授权覆盖新账户。保存失败可重试同一 Key。面板打开期间持续等待，最后一个面板关闭后保留 15 分钟；不跨重启恢复。原生事件不携带 Key，ConfigProvider 在应用层刷新配置和既有可用供应商投影，隐藏设置页不影响授权保存。

OAuth `app_url` 与请求头 `X-App-URL` 同时固定为 `https://myagents.io`（无尾斜杠）。Anthropic 请求通过既有 SDK child `ANTHROPIC_CUSTOM_HEADERS` 注入，独立验证诊断请求在 `provider-probe.ts` 的出站入口注入，OpenAI Bridge 根据该请求所属 Provider 注入，Rust 账户 / 充值 client 和模型目录请求也携带同值。大小写不同的旧归因头不能覆盖固定值，不修改进程全局环境或其他 Provider 的请求头。

余额与充值 API 经 Rust 的 Provider-aware HTTP client。余额是账户原始微元，UI 两位小数只用于展示；请求和 UI 结果绑定凭据版本。只有供应商明确返回的 `TokenDance-Recovery-Action` 控制重新授权、充值或管理 Key 额度，不从普通网络错误 / HTTP 状态推断。

充值 attempt 只属于当前面板；提交才创建，打开时轮询供应商会话，关闭后停止本地请求并忽略迟到结果。没有持久订单表、后台付款轮询或本地余额加减。关闭不代表远端订单已取消，旧二维码直到供应商过期前仍可能被支付。

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

执行路径：

1. Sidecar Provider resolver生成带 `credentialSource` 的 ProviderEnv；
2. OpenAI Bridge 每个 upstream request向 Rust management API取得 bearer + opaque credential version；
3. upstream 首次返回 401 时，只允许针对被拒 generation强制 refresh一次，并以 byte-equivalent request重试；
4. recovery 后仍是 401，才 quarantine 对应 credential version；
5. 403 表示 entitlement / region / model 问题，429 表示 rate/quota，不能触发 auth refresh；
6. completion 只上报 status 与 generation，不记录 bearer。

One-shot verification 必须在完整 SDK / translator terminal success 后才提交 verified state。收到 2xx headers 不等于 turn 成功；旧 generation 的 late failure 不能污染新登录 lineage。

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

Active conversation 可按 Session 设置 `prompt_cache_key` / explicit cache breakpoints。One-shot probe、title 和 vision 不使用 conversation affinity。上游明确拒绝某 cache feature 时，只在该 bridge generation 内做一次兼容降级并重放等价 request；不能全局永久关闭，也不能对任意 HTTP error 猜测重试。

### Timeout 与终态

Bridge 对“等待 response headers”有有界 timeout；成功 streaming body 由 SDK turn、AbortSignal 和 stream protocol owning，不应用一个短固定总时长截断长回答。HTTP status、stream error、model refusal、translator failure 和 SDK terminal 必须保持可区分。

普通 401/403/429/5xx 不做通用重试。只有明确的 managed-auth 401 recovery 和精确识别的 cache compatibility downgrade 拥有各自单次重试预算。

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

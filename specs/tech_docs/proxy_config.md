# 代理配置架构

MyAgents 的代理不是一个 process-global 开关，而是按网络请求 owner 分流。本文定义 current scope、baseline 和 helper；Provider 的认证与模型路由见 [`third_party_providers.md`](third_party_providers.md)。

## 配置与 scope

`config.json.proxySettings` 的权威类型在 `src/shared/config-types.ts`：

```json
{
  "enabled": true,
  "protocol": "http",
  "host": "127.0.0.1",
  "port": 7890,
  "scope": {
    "mode": "custom",
    "generalRequests": true,
    "providerIds": ["anthropic-sub"]
  }
}
```

- `protocol` 只接受 `http`、`https`、`socks5`；
- `mode: all` 表示 general 与所有 Provider owner 使用应用代理；
- `mode: custom` 分别选择 `generalRequests` 和 `providerIds`；
- 未开启、未选中的 owner 使用 inherited system / parent-process network baseline，不等于强制直连。TUN、VPN 和系统代理仍自然生效。

读取旧 custom scope 时，如果缺少 `generalRequests`，默认视为 `true`；缺字段且 Provider 列表也为空的旧空 scope 归一化为 `all`。这是仍在生效的磁盘兼容规则，新写入必须使用完整 current shape。

`providerIds` 是用户的持久选择，不是当前可用或可见 Provider 的缓存。`normalizeProxyScope` 只整理字段、空值和重复项，不接受展示目录作为允许集合。Settings / Capabilities 的挂载、CLIProxy 状态轮询、组件替换或平台/功能隐藏都不能裁剪或自动写回 scope；真正删除自定义 Provider 时由既有删除入口移除其 ID。

代理范围弹窗在打开时固定本次编辑的配置目录，而不是使用 CLIProxy 卡片的实时展示过滤；后台目录变化在下次打开时体现，避免编辑期间选项消失或准入集合变化。初始化保留不可见 ID，全选/取消全选只编辑当前展示项；保存通过 `patchProxySettings(partial, editableScopeProviderIds)` 在配置锁内保留不可编辑项的最新磁盘选择，包括从 `all` 转为 `custom` 时仍存在的隐藏内置 Provider。自定义范围即使勾选了当前所有项目仍为 `custom`；只有显式“全部”设置 `all`，原有 `all` 无修改保存仍保留。已经被旧版本删除的选择无法推断还原，需要用户重新勾选。

## Owner 模型

```text
config.json proxySettings
       |
       +-- general owner
       |     updater, resource/runtime downloads, model metadata,
       |     generic MyAgents HTTP, Plugin Bridge
       |
       +-- provider owner(providerId)
             Builtin SDK, OpenAI Bridge upstream, provider probe,
             managed/runtime-backed provider process
```

请求归类依据是拥有该请求的产品状态和 lifecycle，不是 hostname。一个 opaque SDK / Runtime 进程内部代发的 remote MCP、connector 或 tool traffic 无法再按 packet 细分；当前架构不声称代理 WebView、系统浏览器或所有第三方子流量。

## Localhost 永远直连

Renderer 与 Sidecar 的控制面、Rust 到 Sidecar、IPC 及内部 HTTP 必须排除代理。Rust 调用统一使用 `crate::local_http`；不要在调用点自己创建普通 reqwest client 再期望 `NO_PROXY` 恰好正确。

`NO_PROXY` / `no_proxy` 至少合并 `localhost`、`127.0.0.1` 和 `::1`。IPv6 parser 要接受有效的 loopback URL/host 表示，不能把带方括号的 URL authority 文本当成 host value 存入 matcher。

## Rust helper

`src-tauri/src/proxy_config.rs` 是 Rust scope 与 client/subprocess policy owner：

| 场景 | 入口 |
| --- | --- |
| general reqwest | `build_client_with_proxy` |
| Provider reqwest | `build_client_with_proxy_for_provider` / blocking variant |
| general subprocess | `apply_to_subprocess` |
| Provider subprocess | `apply_to_subprocess_for_provider` |
| loopback | `crate::local_http` |

`read_proxy_settings()` 只回答“应用代理配置是否有效”，不能替代 general-aware decision；Provider 可能在 `generalRequests=false` 时仍被选中。

应用代理注入子进程时同时保留覆盖前的 inherited proxy snapshot，并标记 `MYAGENTS_PROXY_INJECTED`。未选择应用代理时保留 inherited proxy vars，只合并 localhost exclusion；不能擅自删除 inherited `ALL_PROXY`。

## Node 三基线

`src/server/proxy-state.ts` 同时维护：

1. immutable `inheritedProxySnapshot`：Rust / MyAgents overlay 之前的 proxy env；
2. app-proxy overlay：当前应用代理 URL；SOCKS5 时是本地 bridge URL；
3. `process.env`：当前 general owner 的有效 baseline。

Provider 选中时从 overlay 构造 env，未选中时从 immutable inherited snapshot 构造。禁止从已经被 general policy 改写的 `process.env` 反推 Provider baseline。

Node generic HTTP 必须走 `fetchWithGeneralProxy()`；需要 cancellation/deadline 时走 `cancellableFetch()`。这些 helper 使用 package-pinned dispatcher，并在 baseline 改变后退休旧连接池。普通 `fetch` 不保证消费 `HTTP_PROXY`。

Integrated DSH canonical Web 是另一条显式路径：`WebFetch` 使用 general 代理决策，Provider utility/WebSearch 使用 Provider scope 决策。直连时 Host 校验并 pin 全部 public DNS answer，首个地址连接失败后继续尝试其余地址；用户显式选择代理时仍执行 URL/hostname/literal-IP policy，但远端 DNS 交给该代理。这与 Claude Code/普通 CLI 的显式代理语义一致，也允许在本地 DNS 被代理软件接管或不可直达时工作。

模型可见的原生 `web_fetch` 由 DSH Runtime 内的 `ProductSafeHttpClient` 执行；其代理入口是 DSH composition 安装的 general network transport，来源为 Host 创建子进程时冻结的 general 代理快照。Host 的 canonical `WebFetch` 选路不覆盖该原生工具。两条路径均保留 URL 与公网字面量 IP 检查；仅明确选中代理的域名请求由代理解析 DNS。

Integrated DSH 的已接纳协议通过既有 `host/credential/resolve` 返回有界 `providerNetwork`，由 Runtime 的模型请求 scope 消费；代理认证 URL 仅在请求生命周期中存在，不写入 profile、Session 或日志。该策略与 `getProviderProxyEnvironment` 共用 immutable inherited baseline / app overlay 决策；不是从 general process.env 反推。后续请求可使用新设置，并发请求不互相切换全局 dispatcher。精确协议版本和交付身份以本次构建的 effective lock 与生成契约为准，构建选择见 [Integrated DSH 构建来源](build_resource_preparation.md#integrated-dsh-构建来源)。

Integrated DSH Shell 也属于 general owner。创建 Runtime 进程时，Host 将 `getGeneralProxyEnvironment()` 的显式快照交给 `buildDshChildEnvironment()`，只准入标准大小写 HTTP/HTTPS/ALL_PROXY 与 NO_PROXY 键，并把键名纳入 Runtime 的 sealed environment。主 Agent 和子 Agent Shell 使用同一份快照；SOCKS5 使用既有 HTTP bridge，关闭或未选中 general scope 时恢复 inherited baseline。不能直接放开 `process.env` 继承，也不能使用当前模型的 Provider proxy env 代替 Shell policy。命令自身仍须支持标准代理环境变量（例如 curl）；这不会为任意程序安装透明网络代理。

Plugin Bridge 是受控例外：社区插件无法被强制改用 helper，所以 Bridge 在加载插件前安装同一 general dispatcher 为 process-global fetch/dispatcher，并在 Channel lifecycle replacement 时重建。

## Provider 路径

Provider-owned Node 路径使用：

- `applyProviderProxyPolicyToEnv(env, providerId)`：SDK / Runtime subprocess；
- `getProxyForProviderUrl(providerId, url)`：Bridge、probe 等直接 HTTP。

Builtin Anthropic subscription 的 ID 是 `anthropic-sub`。代理 owner 只决定网络 baseline，不因此接管 Claude Code native OAuth credential。

OpenAI-protocol Provider 的 SDK subprocess 只访问 Sidecar loopback。`buildClaudeSessionEnv()` 必须从该子进程 env 剥离所有 proxy vars，避免 SDK 把 `127.0.0.1` 送入代理；Bridge handler 再根据 bridge token 找到 `providerId`，以 Provider-aware helper 访问真实 upstream。Bridge 不能用 general `process.env` 代替 Provider decision。

CLIProxy 的 Google 请求由 Rust `apply_to_subprocess_for_provider(..., "antigravity-sub")` 选择 Provider scope；资源下载走 general scope。Go 环境仅在没有对应 HTTP/HTTPS 配置时投影 inherited ALL_PROXY，保留 NO_PROXY。SDK → CLIProxy 和 Rust 管理 HTTP 都是 loopback，继续服从本地直连；SDK 原生 bypass 行为须对实际安装版本验证。CLIProxy 不接收 Sidecar 的 general overlay 或其他 Provider 凭据。

## SOCKS5 bridge

多数 SDK/子进程只稳定支持 HTTP proxy。应用配置为 SOCKS5 时，Sidecar 建立稳定的本地 HTTP-to-SOCKS5 bridge：

- bridge 从完整 current settings 初始化，不从 general env 反推；
- general 与 Provider owner 分别决定是否使用该 bridge；
- `generalRequests=false` 但有 Provider 被选中时，bridge 仍存在但不会写入 general env；
- endpoint 变化后新连接使用新目标，既有 tunnel 自然排空；
- 没有任何 app-proxy consumer 时停止接收新连接，不强制切断活跃 tunnel；
- generation fence 丢弃旧配置的 callback。

## External Runtime envPolicy

Claude Code / Codex 等 external Runtime 还可在 Agent 配置选择：

| 值 | 语义 |
| --- | --- |
| `myagents` | 使用 Sidecar 当前 general baseline |
| `terminal` | 移除 Sidecar proxy vars，再恢复 interactive shell warmup 检测到的 proxy env |

`src/server/runtimes/env-utils.ts::resolveAgentEnvPolicy()` 是磁盘读取与字面量校验入口。未知值 fail-safe 到 `myagents` 并记录 warning；调用方不得裸 cast。`terminal` 没检测到 shell proxy 时形成无显式 proxy env，但仍可能通过 TUN/VPN 路由。

已打开的 PTY 拥有自己的出生 env，配置变化不会重写它；新 Terminal 使用新策略。

Integrated DSH 不使用 external CLI 的 `envPolicy`；Agent 从外部 Runtime 切换到 DSH 后，即使磁盘仍保存 `terminal`，Shell 也按 general scope 创建和更新。

## 配置变化生命周期

- Settings 在 Rust 配置写锁内更新 `config.json`；
- 活跃 Sidecar 接收 hot proxy state propagation，`/api/proxy/set` 在 `sidecar-composition.ts` 中属于 common，Global 和 Session 都必须能接收；后续 generic 请求和新 Provider subprocess 使用新 policy；
- DSH Shell 的代理快照属于进程 generation；general baseline 变化复用 external Session lifecycle 的 config invalidation，在 idle 边界释放旧进程，下次启动读取新快照。当前轮不被中断，轮内 A → B → A 撤销不必要的重启；
- Plugin Bridge 与 IM Channel 通过各自 keyed lifecycle lock 在安全空闲边界 replacement，不能并发启动第二实例；
- 连续设置变化由 generation / reconciliation 收敛到最新磁盘配置；
- 代理变化不能打断已建立的用户 Terminal 或把正在执行的 Provider turn 临时改成另一套 env。

## 安全例外

用户提供的 raw ZIP URL 经过 public-address validation 后使用 DNS-pinned direct dispatcher，避免代理侧重新解析打开 SSRF / DNS rebinding 窗口。该路径既不使用 app overlay，也不消费 inherited env proxy；它是输入安全边界，不是按域名扩展 general scope。

应用自有浏览器资源下载只访问签名版本锁中的 exact HTTPS URL，禁止 redirect，并始终执行 size、SHA-256 与安全解压校验。只有 transport failure 才允许对同一锁定 URL 做一次受限直连重试；确定性 HTTP 错误不伪装成代理故障。

## 资源下载时限

网络选路与下载时限分别由代理 owner 和资源 owner 管理。应用内 Managed Codex、Chromium、CLIProxy、语音模型和更新包的单次下载时限为 30 分钟，Rust 共用 `resource_download::RESOURCE_DOWNLOAD_TIMEOUT`；连接建立仍保留各入口的短时限，已有重试、直连回退、取消和完整性校验不变。Chromium 的正文空闲时限也为 30 分钟。更新检查仍为 15 秒，返回的 `Update.timeout` 单独设置下载预算。

GitHub/raw ZIP Skill 与共用下载器的 Claude Plugin，每个候选 ZIP（含重定向及正文）为 10 分钟；Space Skill ZIP 也为 10 分钟，继续通过 Space 原有鉴权 client，仅覆盖该下载请求的 timeout。其他 Space API 与附件不扩大时限。

Skill 安装的外层等待必须覆盖顺序执行：GitHub 默认分支可在 404 后从 main 转向 master，因此单次安装/探测允许两份下载预算和 30 秒处理时间；CLI `skill add` 还需容纳先探测、再提交两次请求。Node 的下载、Admin 自调用和 CLI 同时调整 Undici 的响应头/正文计时，避免默认 5 分钟先于业务期限中断；不修改共享连接池的全局默认值。Managed Codex 的持久下载状态保留时间覆盖清单与归档各自的网络路径回退，不能用旧的 30 分钟过期值把仍在执行的下载显示为空闲。

setup/build 的 30 分钟、最多五次尝试属于独立构建策略，见[构建资源准备](build_resource_preparation.md#下载时限重试与原始缓存)；应用内并未统一增加重试次数。

## 验证

测试应覆盖：

- `all` / `custom`、legacy missing `generalRequests` 与空 scope 归一化；
- general 和 Provider 的 overlay / inherited 组合；
- HTTP/HTTPS/ALL_PROXY 选择及 localhost/IPv6 bypass；
- SOCKS5 bridge 在 general-only、provider-only 和 endpoint replacement 下的 lifecycle；
- OpenAI Bridge 的 loopback proxy stripping 与 upstream Provider policy；
- external `envPolicy` 字面量验证；
- config hot propagation、Channel replacement generation 和 PTY 不变；
- raw ZIP DNS-pinned direct security exception。

排查时读取 unified log 中的 `owner=general` / `owner=provider` 与 `path=myagents-proxy` / `path=inherited`，不要只观察 process env 的某一个变量。

# 托管 CLIProxy 组件

`antigravity-sub` 使用 Rust 管理的原版 CLIProxy Anthropic 接口，可由 Claude Agent SDK 或 Integrated DSH 执行，不经过 OpenAI Bridge。随包基线由 `src/shared/managed-cliproxy-source.json` 锁定；线上资源按最低 MyAgents 版本选择，独立于客户端发版。组件完整性、资源策略与模型目录分开裁决。MyAgents 不维护模型白名单，不以模型请求验证登录。

## Owner 与数据流

```text
Renderer 设置操作 → Tauri commands → Rust CliProxyManager
                                      ├─ active / candidate CLIProxy child tree
                                      ├─ account-state / component-state
                                      └─ 临时 localhost OAuth callback relay

Session / Task / Goal / Channel 的 SDK Query 或 DSH 模型请求；SDK title / vision one-shot
  → prepareProviderBinding(non-secret endpointSource)
  → Rust management API（准确 Sidecar generation）
  → execution-only binding + native model metadata
  → Claude SDK / DSH → CLIProxy /v1/messages → Antigravity
```

Rust 是账号目录注册、正式/候选指针、组件选择、进程、准入和 lease 的 owner。CLIProxy 独占 OAuth state、token 文件与 refresh；MyAgents 不读取完整 token 文档、不调用强制 refresh、不自行交换 Google code。浏览器 URL 由原版生成，Rust 只校验并转交回调。

`config.json` 保存用户模型首选、启用列表、别名和 Rust 投影的账号可用性。Session snapshot 固化 Provider route；本次 Query 的端口、模型 key、instance generation 与原生模型元数据只在执行进程内存在。`providerHistory` 使用稳定 managed Provider identity，临时端口变化不构成 Provider 切换。

目录刷新追加新模型，尊重用户删除和显示名；已发现行的能力字段按原生元数据刷新。缺少元数据不隐藏模型或阻止调用。普通 Query/辅助请求的真实 SDK terminal 可记录逐模型观察，但不影响登录和准入；取消与迟到的旧 lease 结果不能污染新账号。设置挂载只读本地状态，显式刷新读取原版目录。

每个 Query/one-shot 经同一入口取得 active 的 lease，不存在候选模型验证准入。模型 key 不进入 Renderer、Session、任务或日志；管理 key 不出 Rust/CLIProxy。同步 resolver 不启动进程或返回秘密。

Provider 代理配置变化通过既有 `cmd_propagate_proxy` 通知 Rust；执行前也比较实例实际环境和磁盘策略，旧网络配置不能继续接新轮次。替换复用组件的 drain 与实例 generation 生命周期。认证停用先停止消费者，再等待实例创建锁，避免被正在等待长任务的普通更新挡住。应用安装更新复用已有可释放的 update gate；只有终止 App 才设置 CLIProxy 的永久 shutdown watch，安装失败返回应用后可重新准入。

SDK 使用既有模型别名配置；未配置别名默认解析到主模型。用户指定的子 Agent 模型和别名保留，不强制改写为主模型。原生元数据用于本次主模型的请求配置，不构成额外模型许可。

SDK 请求使用与主 Query 一致的 `claude_code` preset + 非空任务 append。`cliproxySdkSystemPrompt` 统一此模式，标题/vision 保留各自任务指令和工具隔离；其他 Provider 不变，不在 HTTP 层改写 SDK 请求。独立 SDK 排障脚本只提供开发证据，不形成模型审批或参与登录。

## 账号与进程生命周期

单账号有一个 active 和至多一个隔离 candidate。新候选先注册目录，再启动写入者。Rust 在等待健康检查前保留 child tree；失败停止未确认时不能丢掉句柄并复用同一 auth-dir。

连接依次完成：绑定 localhost callback → 请求原版 auth URL → 系统浏览器授权 → 转交一次 callback → 按准确 state 查询成功 → 原版账号摘要确认已保存且未 disabled → 保存 `authorizedAt` 并提交 active。无需模型请求。随后读取模型目录，失败保留已登录状态；实际模型权限、额度或调用错误沿正常对话链路返回。

设置卡片使用“官方”标签，登录前后统一说明“使用 Google Antigravity 订阅账户额度”，已连接时显示“已登录”。登录弹窗只承载浏览器授权与账号切换进度，成功后关闭；关闭视图不取消 Rust 操作，显式取消才清理准确候选。组件版本、检查更新、更新进度与更新失败均不提供用户界面入口，只在日志记录；账号错误仍按 generation 投影。

原版确认账号后，Rust 通过既有 drain/实例切换原子提交 candidate → active 与旧目录清理意图，投影 `providerVerifyStatus.valid`，与验证通过的 API key 具有相同路由可用性。提交后的清理失败不回退旧账号。候选授权状态不等于已保存的账号；重启后候选进入 stored，由原版账号摘要确认是否已经完成登录，无需模型测试。

取消候选只清理候选；断开覆盖该 Provider 的所有已登记目录。两者先保存删除意图，后停止 writer 并删目录。`retry_cleanup` 仅重试已有目标，不能把 retired/candidate 清理扩展成断开 active。写意图失败时不返回成功，本进程保持对应准入关闭。普通停止不扫描或误杀其他 CLIProxy 安装。

同一供应商内切模型复用 active CLIProxy 和账号目录。模型 key、别名与模型能力绑定到 SDK Query 的执行连接，因此会话可重建 Query/lease，但不会以切模型为由替换应用级 CLIProxy。组件只因组件升级、代理设置变化、账号替换或故障恢复而更换。

Binding acquire 由 Rust manager 自己的异步任务完成，HTTP 请求只等待结果。会话切模型、materialization 或 vision 超时取消 HTTP 时，不得中断组件 birth 的健康检查、attempt 清理和 current 指针提交。取消的 operation 经现有 release 收敛；无人接收的新 lease 由 manager 立即释放。启动失败同样必须走完原有进程清理，不能留下“存活 child + 未完成 attempt”再错误回退到 previous identity。失败 attempt 服从组件选择/回退规则，不清除账号凭据。

启动后台初始化完成后，仅为保留的已登录账号预热 CLIProxy，复用同一个 `active_start` 与健康检查入口。Query/one-shot 的 CLIProxy binding 在 App-owned task 内先加入 `initialize_serialized`，再选择组件并等待进程健康；连接账号和显式刷新也先等待初始化。已 ready 时不等待账号操作锁。其他 Provider 不走此 binding 分支，不等待 CLIProxy，也不受它的故障影响。预热只是优化，不能代替执行前的依赖保证。

Manager 构造结果包含成功或具体错误；构造失败不得退化成永久“尚未初始化”。状态 JSON 解码失败使用 `state_format`，区别于文件 IO 的 `storage`；日志仅记录文件名、解码类别及行列，不记录文档值。真实存储或签名失败不得以空状态静默覆盖。

会话预热连续失败达到上限后，队列恢复不能重新清零预算；尚未派发的输入经既有取消入口收敛。用户再次发送或显式配置变化才开启新的恢复上下文。

正常升级/账号替换通过 Rust → 准确 Sidecar generation 的 `/api/cliproxy/control` 通知 operation/lease/instance。此路由为 common capability，因为 Global one-shot 和 Session Query 均可持有 lease。已准入 turn 结束后释放，空闲 Query 保存 resume 后退出；控制响应收敛丢失的 release，不设独立心跳或过期强杀，不重放已执行工具。

断开/明确停用经 SessionEngine 停止持久 Query，辅助请求只取消自己的 AbortController；通信失败由 Rust 停止自己持有的代理。准确 Sidecar generation 死亡同时回收其全部 operation/lease。

## 原版接口合同

接口仅在 `cliproxy/client.rs` 有限封装，禁止添加任意管理 API 透传。

| 用途 | 原版接口 |
| --- | --- |
| 本地健康 | GET `/healthz` |
| 创建授权 | GET `/v0/management/antigravity-auth-url`，省略 `is_webui` |
| 运输回调 | POST `/v0/management/oauth-callback` |
| 查询/取消 | GET `/v0/management/get-auth-status?state=...`；DELETE `/v0/management/oauth-session?state=...` |
| 有限账号视图 | GET `/v0/management/auth-files` |
| 模型目录与元数据 | GET `/v0/management/auth-files/models?name=...`、`/v1/models`、`/v0/management/model-definitions/antigravity` |

上游 V8 保留上述旧管理接口及旧配置读取；当前集成继续复用已验证的有限合同，不为新增 V8 API 扩大管理能力。组件升版仍须验证实际二进制的 OAuth、账号摘要、目录、消息和凭据兼容，不能以路由保留代替运行证据。

原版管理 key 经 bcrypt 处理，输入不能超过 72 字节；目前生成 64 字节 base64url，随机强度为 366 bit。模型 key 独立生成。callback 固定 localhost:51121，先占用成功再打开浏览器；不使用原版 CLI/webui callback listener。URL 响应丢失不得重试创建，callback 响应丢失只按已知 state 查询，不重放 code。

OAuth HTTP 与业务结果分开保留。callback 明确拒绝及时结束；响应丢失、无法解析、服务端故障及 409 冲突只按同一 state 查询。状态轮询仅对暂时传输失败、408/429/5xx 等待恢复，鉴权、协议错误与原生终态失败及时反馈；总截止时间与取消覆盖提交、读取响应和轮询等待。不能把 callback 请求直接改成“任意错误立即销毁候选”，因为原版可能已接受授权码。

`get-auth-status.error` 按锁定版本的完整已知值映射固定错误码和中文提示：授权拒绝、state 失效/不匹配、缺少授权码、token 交换、userinfo、凭据保存；未知文本返回通用失败，不透传 `error` / `message` / `error_code` 或其截断内容。原版通常只提供失败阶段，不能据此断言底层网络/TLS/Google 拒绝的具体原因。

统一日志以现有非秘密 attempt ID 关联 `starting`、`auth_url`、`browser_callback`、`callback_submit`、`auth_status`、`authorization`、`account_summary`、`account_commit`，各阶段记录固定 outcome。授权阶段另记 HTTP 状态（未收到响应或无 HTTP 请求为 none）与自登录开始的耗时；账号摘要确认和提交完成记录对应事件。轮询只记录 HTTP/outcome 变化，完成或失败另记终态；不记录邮箱、OAuth state、授权码、token、URL、原版响应或进程原始输出。最终 candidate 为空可能是失败清理结果，不能据此判断从未创建账号。

目录探测不带 Anthropic-Version、claude-cli UA 或 client_version，读取普通 OpenAI 形状 data[].id。账号注册与路由模型合并去重，原版定义只补充元数据，不取审批交集。两个目录均读取失败时保留上次列表并标记过期；执行准入不依赖目录缓存，也不发路由预检。权限/额度失败不触发 MyAgents 刷新 token 或换模型。

MyAgents 不传 `-local-model`，保留原版启动及每三小时更新线上 models.json 的能力。Antigravity 注册来自 CLIProxy 上游维护目录，并非每次向 Google 查询订阅权益；目录不保证每次调用成功。统一日志只记录阶段、目录计数和有限错误码，不记录邮箱、回调 URL、响应内容或 key。

## 资源策略：最低客户端版本

当前清单格式为 `schemaVersion: 1`、`controls`、`releases[]`；没有精确 App/SDK 白名单，也没有额外的集成协议代际。

每条 release 保留 `version / tag / commit / artifacts`，以及以下 `compatibility`：

```json
{
  "minAppVersion": "0.4.17",
  "revision": 1,
  "credentialCompatibleVersions": []
}
```

- `minAppVersion` 是开放的最低客户端门槛。选择所有门槛不大于当前 App 的条目中，门槛最高的那条；不依赖数组顺序，不按 CLIProxy 版本大小挑选条目。同一门槛只允许一条记录。
- `revision` 是该条目的兼容记录修订号。同一组件版本只可复用原始 immutable bytes；修改凭据兼容记录时提高修订号。换到更高组件版本可从 1 开始。
- `credentialCompatibleVersions` 记录已经验证可双向共用账号文件的旧组件版本。它只在发布新 CLIProxy 时维护，不随 MyAgents 或 SDK 升版改变。已登录账号随 App 向前升级到随包组件时直接沿用账号目录。独立在线升级和向旧组件回退使用这份双向兼容记录。
- App、CLIProxy、门槛均按数值 `x.y.z` 比较，不接受预发布后缀。SDK 版本锁定与回归测试仍由客户端开发负责，SDK 版本不参与组件准入。

例：`.17 → 7.2.158` 与 `.20 → 7.3.0` 共存时（这里 `.17` 表示 `0.4.17`），0.4.17–0.4.19 使用前者，0.4.20 及未来客户端使用后者。修改 `.17` 不影响已存在的 `.20`。没有匹配条目表示没有适用更新，保持本地可用组件；不会把其它门槛的资源当成候选。

Rust 构建与运行时共用 `src-tauri/src/cliproxy_policy.rs` 的门槛选择；Node 打包/发布使用 `scripts/cliproxy-release-policy.mjs`，两者的版本边界测试必须同步。

## 随包、已安装与线上资源的关系

| 状态 | 权威与用途 |
| --- | --- |
| 随包基线 | 仓库 `managed-cliproxy-source.json` 固定版本、commit、三平台上游摘要。构建从签名清单中选这个 source lock 对应且适用于当前 App 的条目，不跟随线上最新版。 |
| 线上目标 | 固定 `https://download.myagents.io/runtimes/cliproxy/manifest-v1.json` 及其 `.sig`；按当前 App 命中最高适用门槛。source lock 不限制线上更高版本。 |
| 已安装事实 | `Installed` 保存签名原文、来源、选中的 `minAppVersion`。读取 current/previous/pending 时按保存的门槛找回原条目，不能随当前 App 版本重新选择。 |
| 全局 controls | 签名的 providerMode、revocations 与单调 policyRevision，独立于是否有适用 release。资源不适用不能遮蔽明确停用/撤销。 |

实际执行目录为 `<data>/runtimes/cliproxy/<version>/<platform>/<artifact-digest>/`。随包资源先校验并安装到该目录；相同摘要的已有文件直接复用。配置与 key 位于 `<data>/providers/cliproxy/antigravity-sub/run/<instance-generation>/`，凭据保存在独立 `accounts/<opaque-id>/auth`。

原版还可以在 `auth-dir` 内创建 `kv.db`（本地 bbolt KV 缓存），它不是 OAuth 账号 JSON。该文件随原版管理、随账号目录清理，不能把它当成已登录证明，也不能在仍有 writer 时单独删除。无账号的原生合同测试允许此文件，同时检查权限与测试秘密/拒绝请求正文未落盘。

启动优先使用可用的较新随包组件，已有账号与新账号遵循相同的随包升级规则。线上先下载了同一随包版本时也按其锁定版本和提交识别。随后启动在线检查；之后每 15 分钟检查一次。正常只升级更高组件版本，或采纳同一产物更高 compatibility revision，不因新的 App 安装包带了旧组件就强制降级。更新先下载与校验，等待消费者 drain 后启动新进程，健康后提交 current。失败按既有规则回退；账号文件不兼容或已撤销的旧组件不能作为回退。GC 只处理组件目录，并保留 current/previous/pending 引用的文件。

签名信任根复用 `resource_signature_core.rs` 和 Tauri updater 公钥。网络失败保留本机可信组件；404 记为 `update_unpublished`，传输失败记为 `update_network`。已失败 artifact/App/SDK/revision 的自动安装或启动不会无限重复；这些字段标识失败尝试的环境，不是精确版本准入。正常进程崩溃恢复另有次数上限，不重放任务。

## 普通 MyAgents 发版

只按正常流程更新 App 版本与代码。**不修改 minAppVersion，不重签 CLIProxy 清单，不重打 CLIProxy ZIP，也不修改组件 source lock。**

setup、开发构建、macOS/Windows 正式构建、直接 `npm run tauri:dev` 与 CI 统一调用 `scripts/prepare-cliproxy.mjs [platform]`。默认读取仓库 `.github/cliproxy/` 的签名快照，按 source lock 下载 immutable ZIP，校验大小/SHA-256 后写入 `src-tauri/resources/cliproxy-cache/artifacts/<digest>.zip`，再投影到 `resources/cliproxy`。完整缓存可离线复用，损坏缓存重新获取；无需本机发布目录、私钥或 minisign。Rust build.rs 仍检查同一签名信任根、锁定的 source、平台、最低 App 版本、大小和摘要。

只有明确设置 `MYAGENTS_CLIPROXY_DISTRIBUTION_DIR` 时才使用指定的本地签名清单及平台 ZIP；这是离线/组件发布验收入口，缺失或损坏直接报错，不自动改用网络资源。普通客户端构建不读取线上 latest 清单，不受组件线上策略后续变动影响。Linux 没有 CLIProxy 平台产物，遵从 Rust 的平台门槛，不下载该组件。

支持目标缺少资源时构建失败。Windows 的 compile CI 和 macOS 组件测试从 `.github/cliproxy/` 的已签名快照获取 immutable 资源，不需要私钥。快照仅在随包组件或资源策略需要更新时调整，不跟随每次 App 升版。

## CLIProxy 更新操作手册

后续执行本任务的 AI 必须先读本节，再改脚本或发布资源。组件发布沿现有脚本进行，不手工覆盖线上 ZIP，不把开发期中间清单当成外部兼容协议。

### 1. 决定发布范围并取得当前清单

CLIProxy 升版默认沿用已核验线上清单中的最低 `minAppVersion`。只有新组件的正常运行确实依赖新版 MyAgents 才具备的必要兼容支持时，才提升门槛，且应设为首个包含该支持的 MyAgents 版本。提高门槛须说明具体客户端依赖及验证依据；CLIProxy 的版本跨度、当前 MyAgents 开发/发布版本或 SDK 升版本身，都不是提高门槛的理由。

- 无新增客户端兼容依赖：保持当前线上最低门槛不变，替换该门槛的目标组件；例如从 `7.2.158` 升至 `8.0.13` 时仍使用 `0.4.17`。
- 必须依赖新版客户端支持：新增对应的更高 `minAppVersion`，保留全部既有门槛及其适用组件，旧客户端继续使用原有目标。
- 每个门槛的目标版本只能前进，不能通过删旧条目或写低版本实施隐式降级。线上需要紧急停止时使用既有 controls 撤销/停用机制。

后续发布先把线上当前 `manifest-v1.json` 与 `.sig` 下载到一个单独的 `previous` 目录。`manifest --base` 会核验签名，再保留其它门槛。首次发布可不传 `--base`。不要把 previous 与输出目录混在一起，便于核对发布前后内容。

```sh
mkdir -p /tmp/cliproxy-update/previous
curl --fail --output /tmp/cliproxy-update/previous/manifest-v1.json https://download.myagents.io/runtimes/cliproxy/manifest-v1.json
curl --fail --output /tmp/cliproxy-update/previous/manifest-v1.json.sig https://download.myagents.io/runtimes/cliproxy/manifest-v1.json.sig
```

### 2. 锁定并验证新上游资源

取得上游 release 的版本、tag、commit、三平台原包 URL/大小/SHA-256，写成与 `src/shared/managed-cliproxy-source.json` 同形状的 source lock。

- 仅发布线上更新：使用独立的 `/tmp/cliproxy-update/source.json`，通过 `--source-lock` 传入；不修改客户端随包基线。
- 同时升级未来安装包的基础组件：有意更新仓库 source lock。随后更新本机默认 distribution 和 CI 签名快照，保证它们包含新的随包基线。

验证原版启动、管理接口、SDK 消息接口及旧账号文件兼容。macOS 生产产物需要 `APPLE_SIGNING_IDENTITY` 的 Developer ID 签名；Windows 核对 PE x64 并保留上游程序。公开 enabled 必须包含三平台生产产物，不能带 `--development` 的 ad-hoc macOS 产物。

```sh
node scripts/package-cliproxy-component.mjs artifact --source-lock /tmp/cliproxy-update/source.json --platform darwin-arm64 --source /path/to/darwin-arm64.tar.gz --out /tmp/cliproxy-update/records
node scripts/package-cliproxy-component.mjs artifact --source-lock /tmp/cliproxy-update/source.json --platform darwin-x64 --source /path/to/darwin-x64.tar.gz --out /tmp/cliproxy-update/records
node scripts/package-cliproxy-component.mjs artifact --source-lock /tmp/cliproxy-update/source.json --platform win32-x64 --source /path/to/windows-x64.zip --out /tmp/cliproxy-update/records
```

### 3. 设置门槛、生成签名清单

新建 `/tmp/cliproxy-update/approval.json`，包含 `controls` 和 `compatibility`。controls 从核验后的当前清单保留；只有确实调整启用/撤销策略时才提升 policyRevision。compatibility 写目标 minAppVersion、revision 和已验证的 credentialCompatibleVersions。普通 App/SDK 版本不写入这里。

```json
{
  "controls": {
    "policyRevision": 2,
    "providerMode": "enabled",
    "revokedVersions": [],
    "revokedArtifacts": []
  },
  "compatibility": {
    "minAppVersion": "0.4.20",
    "revision": 1,
    "credentialCompatibleVersions": ["7.2.158"]
  }
}
```

上例是假设凭据兼容已验证的新门槛；不要直接覆盖实际 controls。环境需提供既有 `TAURI_SIGNING_PRIVATE_KEY`（以及需要时的密码），安装 `minisign`。密钥不写进源码、命令参数或日志。

```sh
node scripts/package-cliproxy-component.mjs manifest --source-lock /tmp/cliproxy-update/source.json --approval /tmp/cliproxy-update/approval.json --records /tmp/cliproxy-update/records --base /tmp/cliproxy-update/previous --out /tmp/cliproxy-update/distribution
node scripts/publish-cliproxy-component.mjs /tmp/cliproxy-update/distribution
```

第一个命令按门槛 upsert，并签名完整 releases 清单。第二个命令只核验并展示发布计划。其它历史门槛的 ZIP 不必重新打包或下载到本地；发布器会验证它们在线上仍可读取且摘要正确。

### 4. 发布并确认

资源发布需要用户已授权；客户端普通构建不触发发布。使用已有 `R2_ACCESS_KEY_ID`、`R2_SECRET_ACCESS_KEY`、`R2_ACCOUNT_ID` 环境与 `rclone`：

```sh
node scripts/publish-cliproxy-component.mjs /tmp/cliproxy-update/distribution --publish
```

脚本核对线上当前策略不会被回退或丢失，上传本地新增 immutable ZIP，验证全部引用的线上 bytes，再更新清单及签名。配置了 `CF_ZONE_ID` 与 `CF_API_TOKEN` 则清 CDN 缓存；最后必须确认公开清单、签名和预期内容一致。命令失败不能宣称已发布；保留输出目录与日志定位具体阶段，不直接重打同版本 ZIP。

如需更新随包基线，先确保 immutable ZIP 已在线发布，再更新 source lock，并把完整签名清单及签名复制到 `.github/cliproxy/`；普通 prepare/build 会自行下载对应产物。尚未发布的本地组件验收可以显式指定 distribution。只发布线上更新时不用改这些客户端构建输入。

```sh
MYAGENTS_CLIPROXY_DISTRIBUTION_DIR=/path/to/distribution ./build_dev.sh --build-only
```

## 验证与维护

开发版与正式版共用 `~/.myagents`。组件状态只接受当前签名资源契约；存储损坏不是可自动重置的缓存，不能通过删除账号目录或凭据修复组件状态。

- `node --test scripts/package-cliproxy-component.test.mjs scripts/prepare-cliproxy.test.mjs`：门槛选择、同门槛替换、保留旧门槛、未来 App/SDK 升版复用资源、发布完整性与 CI 下载。
- Rust `cliproxy::oauth_tests` 用离线本地 HTTP 覆盖原生失败分类、回调响应丢失后成功、单次 code 提交、轮询恢复、确定性拒绝、取消/截止时间及敏感响应隔离；不需要真实 Google 登录。
- Rust `cliproxy::` 测试：签名原文、固定 Installed 条目、资源保存、账号及进程生命周期；无账号/公网依赖。平台相关 fixture 在受支持的 macOS 执行，Linux 保留纯策略/文件合同测试。
- `verify-cliproxy-contract.mjs` 和 ignored `native_process_management_contract`：显式使用已核验的原版程序做真实进程/管理接口检查，不登录账号。
- `npm run verify:cliproxy:sdk-local`：真实已安装 SDK + 本地模拟服务，检查 loopback、子 Agent 模型选择，不访问 Google。
- ignored `native_account_sdk_tool_and_history_contract`：显式浏览器授权与真实 SDK 工具/历史检查；需要单独运行，不进入默认 CI。

发布新上游版本时检查原版接口。为独立在线升级或回退声明双向凭据兼容时，验证对应版本能共用真实账号文件。改策略选择规则时同步 Node/Rust 边界测试；改安装/切换时重测 current/pending/previous 与运行中的任务。源码仓库不提交二进制缓存、签名私钥或真实账号数据。

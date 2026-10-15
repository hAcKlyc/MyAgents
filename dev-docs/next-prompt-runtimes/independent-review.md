# MOXBOTS-NEXT-PROMPT-002 独立审阅

审阅日期：2026-10-15（Asia/Shanghai）；基线 `c7bab28594a03dfba7167200a90ae73ad0a6b5aa`。最终代码审阅结论（07:38:05 +08）：文末最终精确文件版本在本次代码/确定性审阅范围通过，未发现尚未解决的阻断缺陷，可以冻结本任务源码提交。真实模型、App、生产及随后新增实现不在本审阅者的独立复验结论内；统一入口/gate 仍按其 owner 的独立集成验收处理。

范围：SessionEngine/service 接线、Claude Code 原生文本 utility、DSH native `utility/run`、Codex 原生 utility/gateway。审阅者仅读取产品代码、运行确定性 unit 和纯 loopback 网络复现并写本报告；未改产品、提交、发布、操作真实 App、读取凭据或调用真实模型。主 Agent 的真实模型记录不属于本审阅者独立复验。

## 缺陷与处置

1. **P1，Codex gateway 的 global fetch 与 undici 8 dispatcher 不兼容，已修复并独立复验。** 初稿从 `undici` 导入 `EnvHttpProxyAgent`，却调用 global `fetch`。本地 `undici@8.1.0` / Node `v22.23.0` 纯 loopback 独立复现：相同 agent 下 global fetch 报 `UND_ERR_INVALID_ARG: invalid onRequestStart method`，同包导入 fetch 返回 `ok`。仓库 `src/server/openai-bridge/handler.ts:4-9` 同样记录 Node 24 的内置 undici 7 与项目 undici 8 不兼容。修订已将 fetch、Headers、dispatcher 改为同包导入；bundled Node 下真实双 loopback 测试通过，有效 SSE 可回放，function_call 响应返回 502 空 body。

2. **CC settings.env 复制边界过宽，已在审阅中修复并通过新增反例。** 初稿前缀正则会接纳 `AWS_CONFIG_FILE`、`GOOGLE_EXTERNAL_ACCOUNT_ALLOW_EXECUTABLES` 等凭据执行/配置控制字段，不能声称仅复制 token/base URL/model。安装的 CLI 二进制存在这些字段及 `credential_process` / `PluggableAuthHandler` / `retrieveResponseFromExecutable` 路径；未执行这些路径。主 Agent 已改成精确 `NATIVE_AUTH_ENV_KEYS`，并加拒绝 helper、任意配置文件、`NODE_OPTIONS` 和未知 ANTHROPIC 字段的 unit。2026-10-15 07:19:52 +08 所见修订 `claude-text-utility.ts` SHA-256：`39bb49a52f83afae0a495e3cef21fbe258e0bcf4d1ef14f4ef5fc9554f27a542`。

3. **Codex endpoint 环境变量歧义已通过 fail closed 消除。** 修订按显式 provider base URL、内置 OpenAI config base URL、account-dependent 默认值解析；若存在与所得 base 不一致的 `OPENAI_BASE_URL`，直接返回 null。原先未投影环境变量导致默认上游猜测的问题已不成立。含 SigV4、query params、未知 wire API、未知 provider/认证身份、URL userinfo/query/hash 的场景均拒绝；不跟随重定向。认证值由 native CLI 生成并只转发至固定 endpoint，不进入诊断信息。上述 metadata 分支已在定向测试中覆盖；本审阅者未调用真实账号或独立验证所有 native 版本对 metadata 的投影方式。

## 已核验的不变量

- service 在生成前后验证 Session owner、idle/busy、waiting、流式/队列/交互状态，并以 identity/config/messages/terminal 指纹拒绝过期结果。外部调用通过 SessionEngine；builtin 原路径保留。
- CC 传入正向空工具集、严格空 MCP、禁 hooks/settings/skills/Chrome、禁止 native session persistence、独立临时 cwd，不 resume 原 session；只接纳成功 result terminal，拒绝 `is_error`、缺失 terminal、tool use/未知控制面；流式 TextDecoder 保持 UTF-8，输出有界，取消/超时触发进程树清理。
- DSH 仅调用当前 process 的 native `utility/run`，固定 profile revision、512 token，取消信号经 host request 透传；拒绝已忙/退出/取消/失败/终态后 profile 变化。无新增 root turn 或 transcript 写入调用。DSH 原生实现自身的零工具/无持久化保证须由主 Agent 的 native 合同/真实验收记录补证。
- Codex 使用原 runtime source/home、独立 ephemeral thread/cwd；gateway 把真实发送请求的 tools 设为 `[]` 且 `tool_choice=none`，删除 previous_response/conversation，并在向 native 回放前完整校验成功且仅文本的响应；工具/未知响应不向 native 回放。该逻辑不能替代上述网络/endpoint 复核。
- 第二轮取消复核：已取消请求不解析 identity/不 spawn；主任务超时后杀本次 children、关闭 gateway/dispatcher；即使 gateway 在超时后才 listen 成功，也由局部 `createdGateway` 立即关闭，不会启动 late utility child。新测试覆盖 timeout 与 late-listen；`close()` 幂等。目录创建完成后的取消也由局部路径自行删除。诊断回调只接受固定阶段代码，异常不会改变执行。

## 独立验证记录

- 2026-10-15 07:19:02 +08：`vitest run --project unit src/server/runtimes/claude-text-utility.unit.test.ts src/server/integrated-runtimes/dsh/text-utility.unit.test.ts src/server/session-prompt-suggestion.unit.test.ts`，3 文件、23/23 通过。此轮在 CC 精确 allowlist 新增反例之前，不作为新增反例通过证据。
- 2026-10-15 07:20:49 +08：只运行修改影响的 CC `-t 'projects only exact native auth'`，新增精确 allowlist 反例 1/1 通过，其余 8 例跳过。
- 2026-10-15 07:28:44 +08：`/Applications/MoxBots.app/Contents/Resources/nodejs/bin/node node_modules/vitest/vitest.mjs run --project unit src/server/runtimes/codex-text-utility.unit.test.ts`，15/15 独立通过，包含真实双 loopback、endpoint metadata、工具响应拦截、timeout/late-listen。无外网/真实凭据/真实模型。本轮仅复核改变的 Codex 与 CC allowlist 影响，未反复重跑既有 DSH/service。
- 2026-10-15：纯 loopback `node --input-type=module` 对比 global fetch / package fetch + 同一 `EnvHttpProxyAgent`，复现上述 P1，无外网访问。
- DSH helper SHA-256：`c5bb7db7356f79ec3fee22ffa3cefd8aa6f52898bacf63dea66faaf73b588acd`；Codex 中间版本 SHA-256：`ca3664bd88e161ce7e8e73fed423d93077b40d1f0f5029aa85c2be42a314beee`（2026-10-15 07:19:52 +08）。所有后续新增实现必须复核，不能沿用本阶段结论宣称最终通过。

## 第二轮通过的精确版本

| 文件 | SHA-256 |
| --- | --- |
| `src/server/runtimes/codex-text-utility.ts` | `eea9df7449b14bd6e600be0bf86860c5c9bca7cc133420d0603a63551100f372` |
| `src/server/runtimes/codex-text-utility.unit.test.ts` | `a9b093aafa122d03a272892f12f79755c6319ebf351620e86aa67da5ac45acbd` |
| `src/server/runtimes/claude-text-utility.ts` | `39bb49a52f83afae0a495e3cef21fbe258e0bcf4d1ef14f4ef5fc9554f27a542` |
| `src/server/runtimes/claude-text-utility.unit.test.ts` | `eea9e61732d35617802c9bebb62fc092757e17feb19595f99f8388d5797970dc` |

本报告仅证明对应源码审查与确定性行为；native CLI 版本差异、真实 Provider 鉴权/成功终态、原生 Enter 草稿接纳及客户端更新，仍由主 Agent 按各自证据验收。unsupported 网络/签名/provider 模式安全返回空建议，不能称所有第三方配置都已支持。

## 第三轮：native 兼容修订与 modelqa fixture

2026-10-15 07:33:36 +08 使用 bundled Node `v24.20.0` 独立运行：Codex unit 17/17、modelqa handler unit 15/15、modelqa page DOM 3/3，共 35/35 通过。该轮 mock 了 compile-time modelqa gate，不证明入口挂载或完整构建。

- 已审 Codex builtin OpenAI 修订：仅以 native 全局 `openai_base_url` 覆盖 gateway，仍保留 provider ID `openai` 及 native auth；不再向 reserved `model_providers.openai` 插入值。CLI 与 thread config 都指向 gateway，出站工具清空与响应完整缓冲校验保持。所有 MCP 名只接受 `[A-Za-z0-9_-]+` 并按原始 dot-path 设 `enabled=false`，不能表达的名称直接拒绝，未启动 utility child；新增两回归通过。每个 RPC 15 秒仍由总 timeout/取消与进程清理包围。具体 native 版本的真实请求路径仍须主 Agent 另证，本审阅者没有运行 native CLI/模型。
- modelqa 仅接收明确授权 runtime/source/model（DSH 另需 portable、启用且模型存在的 Provider）；输入拒绝任意 prompt/workspace/endpoint/凭据。synthetic transcript 经真实 suggestion service，CLI 不借 SDK Provider，DSH prepare 不传 initialTurn/扩展并监控普通 turn/tool 事件。页面真实 composer Enter 仅采纳草稿，onSend 返回 false；DOM 已验证输入法、重复 Enter、编辑、Escape、失败提示。
- **P2，DSH prepare 取消后的单 generation slot 提前释放，已修复并独立复验。** 初稿内部 `Promise.race([preparing, aborted])` 先返回 null，service generation 即 settled，route finally 可把 `active=false`，但 prepare 尚未返回、late handle 尚未 stop。修订 `pendingNative` 包围 prepare 及 late handle 的 awaited stop，释放同时要求 handler cleanup、service generation、native prepare/stop 都 settled。07:34:46 +08 定向回归 1/1 通过：prepare 未返回仍 409，late stop 未完成仍 409，stop 完才允许新请求 200。
- 入口 gate/挂载由统一 owner 的另一 branch 提供：当前本工作区 `updaterQa.ts` 仍无 `isModelQaBuild`，index/App 未引用新 fixture。主 Agent 已明确分离交付，未声称已接线。本报告对 fixture 函数成立，对合并后的路由 auth/CORS 顺序及 compile-time gate 暂无通过结论。
- 主 Agent 通知 Codex native v5 发现预热请求与真实 POST 诊断问题，真实失败证据由主 Agent保留，不作为本独立测试成功。新 gateway 修订已独立复核：非 POST 或非 nonce 响应路径仅本地 404，不消费合法 POST、不转发认证、不污染 `failed`；同一合法响应路径的重复 POST/坏模型/无效响应仍失败。07:35:05 +08 仅新预热回归 1/1 通过。新增网络诊断只从固定 errno allowlist 和整数 HTTP status 构造，不输出 URL、body、认证值；出站空工具与回放前完整校验不变。
- DSH fixture 会调用 `startSession()` 创建随机独立 native session：`createOwnedRoots()` 落在当前构建 profile 数据目录，`session/create` 有 persistenceRef；`stopSession()` 和 fixture 的 `rm(temp workspace)` 不删除这些 native session/attachment roots。此为代码事实，不表示触碰原会话。主 Agent 已明确接受这是隔离 modelqa profile 的受控准备/取证工件，计划在 receipt/docs 说明 `qaNativeArtifacts='isolated-profile-preparation'`；不能宣称整个 prepare 完全不落盘/无残留。本审阅者未修改或删除任何此类目录，也未独立操作该构建 profile。
- 最新 Codex 禁止 `features.enable_request_compression` / `responses_websockets` / `responses_websockets_v2`，本地 native schema 的相同字段均为 boolean，已核对。压缩 body（非 `identity`）及非法 JSON 在任何 fetch 之前拒绝，保持零工具边界。尚未看到这两分支的专项 unit，本轮确定性通过项包括新预热用例；不能借此宣称 native v7 已真实成功。小问题已告知 owner：当前 `content-encoding: identity` 允许通过却先记录 `gateway_encoded_body_rejected`，应调整诊断，避免把允许输入误判为拒绝。

第三轮范围内未发现剩余代码阻断；统一入口/gate/auth 挂载及上述 QA 工件处理属于待集成确认，不在函数/DOM 通过结论内。精确源版本如下（07:35:05 +08）：

| 文件 | SHA-256 |
| --- | --- |
| `src/server/runtimes/codex-text-utility.ts` | `df236272c2949b73686851eed5d0ac63e899de4beb39775102f3cfdf96a7f654` |
| `src/server/modelqa/next-prompt.ts` | `62bcbd35be25013a2a11b27adf099411ffb31e23afd2172f0082dce4ea761dab` |
| `src/server/modelqa/next-prompt.unit.test.ts` | `4d34c25cbb5a9bc94693bbdc2a39516488eedb73eb5e0eb259155a9f9a8c16e3` |
| `src/renderer/pages/ModelQaNextPrompt.tsx` | `438485dd19bead4085d7a6959aecf4c6705ea3baf0cd286ded3bf067b8858033` |
| `src/renderer/pages/ModelQaNextPrompt.dom.test.tsx` | `41458164a7b267ddcecea9ca2594703dc1f4474d44e6499ec2d784f79fbf12e0` |

## 最终增量复核（07:38:05 +08）

- gateway 新增按 SSE framing 识别误标 `text/plain` / `application/json` 的完整 SSE，仍无条件调用原先同一 `validateCodexUtilityResponse`；工具项、未知事件、非成功终态/不完整响应照旧拒绝。通过后仅规范化响应 Content-Type，不存在绕过验证的原字节回放路径。
- 压缩请求与无效 JSON 在 fetch 前拒绝，`identity` 诊断误标已修复。独立仅运行新增影响的 4 项（2 个错误 Content-Type、zstd、invalid JSON），4/4 通过，其余 18 项跳过；未重复旧测试或调用外部模型。
- 当前 helper 未见 capture、写盘或 console instrumentation；认证值仍由 native header 路径转发，只发往已解析固定 endpoint，诊断不带 body/header/URL。
- DSH modelqa receipt 已加入 `qaNativeArtifacts: 'isolated-profile-preparation'`（仅 DSH），与已确认的独立准备工件范围一致。
- 主 Agent 报告 native v9 真实成功、15.997 秒、原 system-cli auth/model/system prompt；该结果属于主 Agent 的真实验收证据，本审阅者仅复核对应源码及新增确定性分支，不将转述当作独立真实模型复验。

冻结用最终增量 hash（替代上文旧中间版本；未列出的 CC/DSH/page 文件沿用前述已审版本）：

| 文件 | SHA-256 |
| --- | --- |
| `src/server/runtimes/codex-text-utility.ts` | `982c211a08c2e92ac0b41af365cdb5ceaa85f55de1eb8dc71ca96c684f626146` |
| `src/server/runtimes/codex-text-utility.unit.test.ts` | `0f9e06e1dc468cf3416835800a33d18144905733af09cc4854b90a9b0aeb9a27` |
| `src/server/modelqa/next-prompt.ts` | `891918b45a6d60920dbc333ee8f59a77d25a0cb0018a2ee73a929b264df56081` |
| `src/server/modelqa/next-prompt.unit.test.ts` | `4d34c25cbb5a9bc94693bbdc2a39516488eedb73eb5e0eb259155a9f9a8c16e3` |

冻结后仅清理Codex unit文件一处尾随空格，产品源码未变化；既有审阅hash对应冻结测试文本，最终HEAD应以Git及CI为准。

## QA executable 启动依赖增量复核（07:45:50 +08）

基于 HEAD `3277aeb561e0910ef316c3aa7fb54a7ed31cc15f` 后四文件增量，结论通过，可以提交。仅独立运行新 `modelqa-utility-command.unit.test.ts` 8 项，8/8 通过；未重复旧测试、模型或 App 验收，`git diff --check` 无错误。

- 可执行文件 override 只在编译期 `isModelQaBuild()`、非 updaterqa、source=`system-cli` 时读取。production/updaterqa/managed 先返回原 fallback，不读取 override。
- QA 分支要求显式绝对路径、`realpathSync(path) === path`、普通文件以及 POSIX X_OK（Windows F_OK）；缺失/无效直接失败，不回退到未批准发现路径。二进制 SHA 校验由统一 launcher 的受控 manifest 负责，本 helper 没有自称再次验证 SHA。
- Codex 先沿用原 context 取得 source/env/home/auth/model，仅本次两个 utility launch 换 commandPath；CC 仅 utility spawn 边界选择显式路径，原全局 resolver、native HOME、认证、模型均未修改。未新增通用系统命令 override。
- 这项通过只覆盖 utility 消费受控路径的代码，不代替统一 owner 对 manifest、SHA、profile 隔离及最终安装包/native 运行的验收。

| 文件 | SHA-256 |
| --- | --- |
| `src/server/runtimes/modelqa-utility-command.ts` | `cf4c05e16195c7088ea17b516b2321f831b67aaf23f261b9ef9da86088e522cd` |
| `src/server/runtimes/modelqa-utility-command.unit.test.ts` | `2a8812f3b66c5f9a0673c684e90b68a14348a6ba2edae1a536fddc8d34d4ec99` |
| `src/server/runtimes/claude-text-utility.ts` | `bc29ff21de3d86fceea40cb792f1d9e8b4a76d2e1fb937abeca08281e71b652f` |
| `src/server/runtimes/codex-text-utility.ts` | `bc741096b0eb7f2f290452681e2f4ff0431a9bd0289c6e3643f4ce7495a19630` |

## DSH QA admission 修复增量复核（08:53:33 +08）

基于 HEAD `58c819b4bb256f647b2d7aedcfbb5a42902abee2` 后三文件增量，结论通过，可提交。产品差异仅 fixture prepare 的 `permissionMode: 'plan'` 改为 DSH 支持的 `approval-required`；未修改 native utility、认证来源、原会话或全局权限策略。

- 已读实际 `compileConfiguration()`：`productPermissionMode()` 在 `resolveProviderEnv()` 前判定。旧 CLI `plan` 不属于 `DSH_PERMISSION_MODES`；新值属于 DSH 正式枚举，与实际 Kimi/k3 配置编译一致。fixture 仍不传 initialTurn/扩展，不发普通 turn；`approval-required` 不赋予工具自动执行权限。
- 仅独立运行新 2 个 actual-compileConfiguration case 及 route DSH case，3/3 通过，其余 14 项跳过。旧 plan 回归证明在凭据解析前拒绝；新 approval-required 使用 synthetic credential 编译成功，未启动进程或发送模型请求。route case 引用真实 `DSH_PERMISSION_MODES` 验证传参，并验证 native utility 文本返回与 stop。
- 测试 mock SessionStore/admin-config/managed-binding，未读写真实 config/auth 文件，未使用 GUI/Task/原生自动化。审阅者没有仍存活的原生动作或后台原生循环。`git diff --check` 无错误。

| 文件 | SHA-256 |
| --- | --- |
| `src/server/modelqa/next-prompt.ts` | `d4e5c229847444c6ff40f44c3556f59f2d91504987103e5a2b2afdcd61e4bfff` |
| `src/server/modelqa/next-prompt.unit.test.ts` | `0ba86aab5b4db38e8aa6b633b4fd28931b526d78e2525b48f7da305c79d8cb2e` |
| `src/server/modelqa/dsh-admission.unit.test.ts` | `2d8f00c2f39061953b7409025cf0eac9a11e6c276bc4ec5a8405e3fdc342ef77` |

本次通过只证明 admission 修复及 fixture 合同；A4/DSH 实际原生模型成功、统一包更新由原验收 owner 单独复验。

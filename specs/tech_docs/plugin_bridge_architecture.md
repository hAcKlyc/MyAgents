# OpenClaw Plugin Bridge 技术架构

## 概述

Plugin Bridge 是 MyAgents 加载社区 OpenClaw Channel Plugin 的核心基础设施。它以**独立 Node.js 进程**的形式运行，将 OpenClaw 生态的 Channel 插件（飞书、微信、QQ 等）适配到 MyAgents 的 Agent 架构中。

**设计哲学**：MyAgents 是 OpenClaw 的**通用 Plugin 适配层**，不是各家 IM 的硬编码集成。所有功能基于 OpenClaw SDK 协议（`ChannelPlugin` 接口），禁止为单个插件硬编码逻辑。

## 架构图

```
┌────────────────────────────────────────────────────────────────┐
│                     Rust Management Layer                       │
│  ┌──────────────────────────────────────────────────────────┐  │
│  │  BridgeAdapter (src-tauri/src/im/bridge.rs)              │  │
│  │  - Plugin 安装 (npm install → SDK shim → integrity check)│  │
│  │  - Bridge 进程管理 (spawn / health check / restart)       │  │
│  │  - HTTP 双向通信 (Rust ↔ Node.js, via local_http)            │  │
│  │  - QR 登录流程代理                                         │  │
│  └───────────────┬──────────────────────────────┬───────────┘  │
│                  │ spawn(node)                   │ HTTP         │
├──────────────────┼──────────────────────────────┼──────────────┤
│                  ▼                              ▼              │
│  ┌──────────────────────────────────────────────────────────┐  │
│  │  Node.js Bridge Process (plugin-bridge/)                     │  │
│  │                                                          │  │
│  │  index.ts          — HTTP Server + Plugin 加载入口        │  │
│  │  compat-api.ts     — OpenClaw API 适配（registerChannel） │  │
│  │  compat-runtime.ts — Channel Runtime Mock + 消息路由      │  │
│  │                                                          │  │
│  │  ┌────────────────────────────────────────────────────┐  │  │
│  │  │  sdk-shim/ (node_modules/openclaw)                 │  │  │
│  │  │  package.json (generated exports map)              │  │  │
│  │  │  plugin-sdk/                                       │  │  │
│  │  │    手写模块 — 真实 Bridge 逻辑                       │  │  │
│  │  │    自动生成 stub — import 兼容兜底                   │  │  │
│  │  └────────────────────────────────────────────────────┘  │  │
│  │                                                          │  │
│  │  ┌────────────────────────────────────────────────────┐  │  │
│  │  │  OpenClaw Channel Plugin                           │  │  │
│  │  │  (e.g., @larksuite/openclaw-lark)                  │  │  │
│  │  │                                                    │  │  │
│  │  │  import { ... } from 'openclaw/plugin-sdk/...'     │  │  │
│  │  │  → 解析到 sdk-shim 提供的模块                       │  │  │
│  │  └────────────────────────────────────────────────────┘  │  │
│  └──────────────────────────────────────────────────────────┘  │
└────────────────────────────────────────────────────────────────┘
```

## 完整生命周期

### 阶段 1：插件安装

```
用户在 UI 选择/输入插件 npm 包名
  ↓
Rust sanitize_npm_spec() 清洗输入（剥离 npx -y 等前缀）
  ↓
npm install --ignore-scripts --omit=peer（使用内置 Node.js）
  ↓
install_sdk_shim()（最后写入，覆盖 npm 可能安装的真 openclaw 包）
  ↓
读取插件 manifest → 提取 requiredFields / supportsQrLogin / compatWarning
```

**关键原则**：SDK shim 必须在 npm install **之后**安装（last-write-wins），因为 npm 可能将真实 `openclaw` 包写入 `node_modules/openclaw/`，覆盖我们的 shim。

### 阶段 2：Bridge 进程启动

```
Rust spawn_plugin_bridge()
  ↓
1. 定位内置 node 可执行文件 + `plugin-bridge-dist.mjs`
2. SDK shim 完整性与版本检查（package.json version 含 "-shim" 且匹配当前兼容版本）
   └─ 不通过 → 从 App 资源复制当前 shim，不运行 npm、不升级已安装插件
3. 构造 node 启动命令，并通过 `process_cmd::spawn_tree()` 创建进程树
   └─ 敏感配置通过 BRIDGE_PLUGIN_CONFIG 环境变量传递（不暴露到 ps）
   └─ 注入 per-channel OpenClaw 状态目录（OPENCLAW_STATE_DIR / OPENCLAW_CONFIG_PATH / OPENCLAW_OAUTH_DIR；名字以上游 utils.ts/paths.ts 实际消费者为准）
   └─ 注入 proxy_config 环境变量
4. Rust 持有返回的 ChildTree，负责 Bridge 及其后代进程的停止与 Drop 清理
5. stdout/stderr → 统一日志（Rust 是 Bridge 进程唯一持久化 owner；过滤 heartbeat 噪音）
6. Health check: GET /health × 30 次, 500ms 间隔, 最多 15s
  ↓
Bridge HTTP Server 就绪
```

Plugin Bridge 的正常停止只使用创建时保留的 `ChildTree`，不能按进程名或 argv 扫描整机。全机扫描只属于前一应用实例已经退出后的启动恢复和更新器残留检查；完整规则见 `pit_of_success.md` 的 `process_cmd` 小节。

OpenClaw 插件安装目录保持共享（`~/.myagents/openclaw-plugins/<plugin_id>`），但运行时状态必须按 MyAgents Channel 隔离：Agent Channel 使用 `~/.myagents/agents/<agentId>/channels/<channelId>/openclaw-state`，legacy IM Bot 使用 `~/.myagents/im_bots/<botId>/openclaw-state`。不要让 Bridge 回落到上游默认的 `~/.openclaw`；二维码登录类插件（例如 Weixin）会把本地 token list 带给平台，如果多个工作区共享这份状态，平台会把它们识别为同一个 OpenClaw 实例。

### 阶段 3：插件加载与注册

```
Bridge index.ts
  ↓
1. 从磁盘代理配置初始化 general proxy state（Bridge 不启用 Provider-owned consumer），安装项目锁定版本的 undici globals，并设置 general dispatcher
2. 读 plugin_dir/package.json，扫描 dependencies
3. 检测 OpenClaw 插件标记（pkg.openclaw 或 keywords 含 'openclaw'）
4. 读取插件元数据里的协议 Channel ID（优先 `openclaw.plugin.json.channels[0]`，其次 `package.json.openclaw.channel.id`，缺失时才走旧品牌推断）
5. 全局 axios 超时补丁（10s，防御性兜底"插件在网络差的环境下 hang"）
6. resolveOpenClawPluginEntry(packageDir) → 解析入口（见下方 §入口解析协议）
7. import(resolvedEntry) → 获取插件对象（tsx/esm 会自动处理 .ts）
8. 调用 plugin.register(compatApi)
   └─ compatApi 提供：registerChannel / config / runtime / registerTool
   └─ 插件注册自己的 Channel 对象（gateway、sendText、editMessage 等）
9. 解析账号凭证 → isConfigured() 校验
   ├─ 通过 → 启动 gateway（startAccount）
   └─ 不通过 + supportsQrLogin → 等待 QR 登录
```

代理 bootstrap 必须发生在插件 `import()` 之前。社区插件可能在模块初始化阶段创建 HTTP client 或读取 global dispatcher；如果先加载插件，之后再补 general policy，首批连接会永久绑定旧网络基线。Bridge 的网络 owner 是通用请求，代理范围变化后由 Rust 复用现有 Channel stop/start lifecycle 重建 Bridge 进程。

### Channel 身份边界

OpenClaw 插件有三种容易混淆的身份：

| 身份 | 示例 | Owner | 用途 |
|------|------|-------|------|
| 安装 ID / pluginId | `wecom-openclaw-plugin`、`openclaw-lark` | MyAgents Rust/Renderer | 定位 `~/.myagents/openclaw-plugins/<pluginId>`、卸载、重启相关 channel |
| npm 包名 | `@wecom/wecom-openclaw-plugin` | npm/OpenClaw 包 | 安装与入口解析 |
| 协议 Channel ID | `wecom`、`feishu` | OpenClaw manifest / `registerChannel()` | `cfg.channels.<channelId>`、插件运行时配置读取 |

**Bridge 内部 OpenClaw config 的 canonical key 必须是协议 Channel ID**，优先来自 OpenClaw manifest 的 `channels[0]`，其次来自 `package.json.openclaw.channel.id` 或单一 `channelConfigs` key，最后才从历史包名规则推断。安装 ID 和 manifest `id` 只能作为 alias 兼容旧数据，不能作为 canonical config key。典型反例：`@wecom/wecom-openclaw-plugin` 的 manifest `id` 是 `wecom-openclaw-plugin`，但 channel 是 `wecom`，插件源码读取的是 `cfg.channels.wecom`。

### 入口解析协议

Bridge 按 OpenClaw **上游规范**解析入口（`openclaw/src/plugins/manifest.ts::resolvePackageExtensionEntries`），不能只信任可能指向未发布 `dist/` 的 `main` / `exports`：

```ts
// resolveOpenClawPluginEntry(packageDir) 顺序：
// 1. package.json["openclaw"].extensions[0..n] — 主协议
// 2. 回退：DEFAULT_PLUGIN_ENTRY_CANDIDATES = ["index.ts","index.js","index.mjs","index.cjs"]
```

任一路径存在即返回。插件包的实际入口属于安装时探测结果，不在文档维护白名单。

### CJS + ESM 混用插件的运行时补丁

某些插件（`@larksuite/openclaw-lark` 全版本、部分 Microsoft Teams 插件）用 TypeScript 编译到 CJS（`"use strict"; Object.defineProperty(exports, "__esModule", ...)`），但同时调用了 `import.meta.url`（ESM-only）。Node 严格按 ECMAScript 规范：看到 `import.meta.url` 就必须按 ESM 解析 → CJS `exports` 未定义 → `ReferenceError: exports is not defined in ES module scope`。

Node 不允许在 CJS scope 直接使用 `import.meta`。Bridge 通过 `module.registerHooks()` 的同步 loader hook **运行时改写**命中的 `.js` 源：

```ts
// 触发条件：URL 在 ~/.myagents/openclaw-plugins/*/node_modules/** 且 .js 且同时含
//   - "use strict"; 开头 + Object.defineProperty(exports|exports.X=|module.exports=)
//   - import.meta 字样
// 改写：
//   (0, x.fileURLToPath)(import.meta.url) → __filename
//   fileURLToPath(import.meta.url) → __filename
//   import.meta.url → require("node:url").pathToFileURL(__filename).href
// 返回：{ format: 'commonjs', source: patched, shortCircuit: true }
```

**关键点**：必须用同步 `registerHooks`，不能换成异步 `register`。`require()` → `loadESMFromCJS` 走同步路径，异步 hook 捕获不到。

`--import tsx/esm` **在 dev 和 prod 都要注入**（不是只 dev）：qqbot / weixin 这类插件入口是 `.ts`，Node 拒绝对 `node_modules/*.ts` strip types；tsx 对已编译的 `.js` 是 no-op，无副作用。

**tsx 的安装位置**：tsx 预先打包到 `src-tauri/resources/tsx-runtime/`，per-platform `@esbuild/<triple>` 由构建脚本选择。Spawn 时 Rust 通过 `find_tsx_runtime_loader()` 解析绝对路径并以 file URL 注入。不得在每个 plugin directory 运行 `npm install tsx --no-save`：npm prune 可能删除由 MyAgents 安装、但不在插件 package manifest 中的 SDK shim。

**cwd 不变量**：spawn Plugin Bridge 进程时 cwd 不能依赖任何相对路径（节点 ESM 的 bare specifier 解析与 Node 启动 cwd 强相关）。Rust 端用 `set_current_dir(plugin_dir)` 把工作目录锚定到插件目录，所有运行时文件引用都通过 `import.meta.url` 或绝对 file URL，不允许出现 `./node_modules/x` 这类相对路径。

### 阶段 4：消息流转

```
用户发消息到 IM 平台 → 插件 gateway 收到
  ↓
插件调用 runtime.channel.reply.dispatchReplyFromConfig(params)
  ↓
compat-runtime.ts：
  - 创建 OpenClaw reply dispatcher
  - 生成 requestId，并先注册 request-scoped pending dispatch
  - 提取 chatId、text、attachments、metadata
  ↓
POST /api/im-bridge/message
  { requestId, deliveryProtocol: "openclaw-reply", ... } → Rust
  ↓
Rust 路由到 AI Sidecar → Claude 处理 → 生成回复
  ↓
ReplyRouter 按同一 requestId 有序回传：
  /start-dispatch       → 建立 turn
  /start-stream         → 建立 raw text block transport segment
  /stream-chunk         → 插件 onPartialReply 回调
  /finish-stream-block  → raw block barrier（不是 turn final）
  /complete-dispatch    → 插件 sendFinalReply 回调
  /abort-dispatch       → producer-owned error/cancel terminal
  ↓
插件将回复发送到 IM 平台（CardKit / 原生消息）
```

官方 Lark 插件自身还有一层私有的 `accountId + chatId + threadId` 串行队列。上游默认把
整段 `dispatchReplyFromConfig → AI terminal → CardKit delivery settled` 当成队列租约，导致
第一条回复尚未完成时，第二、第三条消息连 MyAgents 的 Rust 入站队列都进不来。Bridge 对
当前已知的官方 `chat-queue.js` 结构做窄兼容变换：每个 task 的 dispatcher / completion
promise 仍存活到平台投递结束，但同 chat 的下一条只等待当前 task 的 Bridge→Rust POST
收到 2xx（bounded mpsc 已接管）。作用域由 `AsyncLocalStorage` token 绑定，重叠 dispatcher
不会互相 unregister；未知源码结构保持上游原行为并打印 warning，禁止猜测式 patch。

这不是新增平台消息队列，也不改变 ReplyRouter / CardKit owner。Rust 入站队列仍是消息接管
权威，官方插件仍是渲染与终态投递 owner；Bridge 只移除两个 owner 之间重复且生命周期错位的
串行等待。

#### Reply protocol ownership

OpenClaw Channel Plugin 是回复渲染 owner：由插件决定是否启用 streaming、CardKit 的创建/更新节奏、静态消息 fallback 与最终收尾。MyAgents 不复制任何平台 SDK 会话，也不根据凭据或插件 ID 推导流式能力；Bridge 只提供 OpenClaw dispatcher 所需的**请求级、有序、可等待传输**。

`deliveryProtocol: "openclaw-reply"` 是本次入站已经成功创建真实 dispatcher 的事实，只能在 pending dispatch 按同一 `requestId` 注册后随该次请求发送。它不是 channel capability，也不能由 `streaming` 配置反推。Rust 将这个值保存在对应 `ReplySlot`，不影响同一 channel 的其他并发请求。

Bridge 的 pending queue 只做一项背压优化：相邻、同 stream、同 lane 的 full-snapshot partial 可被更新值替换。run start、block barrier 与 terminal 都是顺序屏障；任何平台 I/O 延迟均由插件 dispatcher 自身消化，不得把 CardKit 请求放回 Rust `ReplyRouter` 的锁内。

turn 的 canonical final 由 Sidecar terminal outcome 产生，以 `finalPayloads` 原样穿过 Rust/Bridge。raw `block-end` 只表示 SDK 内容块边界，不参与拼接最终文本。

统一日志同样服从 terminal ownership：插件 logger 的逐次 `onPartialReply` debug snapshot 不落盘；assistant 正文唯一由 Sidecar Runtime terminal 记录，pending dispatch 在 `complete/abort` 边界只把 `finalPayloads` 组合后记录一条无正文的 `canonical_final`（count / chars / hash），避免同一 IM 回复在 Runtime 与 Bridge 各留一份文本。partial 的数量、coalesced 数与 terminal timing 可继续作为无正文诊断字段。

Bridge 的 `dispatcher_delivery_idle` 只表示 core dispatcher queue 已 drain；shim 在既有 `markDispatchIdle → onIdle` 边界记录 `plugin_delivery_settled`，它才覆盖插件私有的异步 renderer 收尾（飞书为 CardKit 终态更新）。该 observer 只测量现有 lifecycle promise，不读写平台状态，也不改变投递结果。

一旦 Bridge 注册 pending dispatcher，Rust 就必须为该 request 产生且仅产生一个 terminal：进入模型的请求由 Sidecar outcome 完成；命令、白名单拒绝、群聊 activation 拒绝等 admission 分支用空 `complete` 或带提示的 `abort` 收口。协议请求不能落入磁盘 buffer，也不能只发送普通 `/send-text` 后悬空 dispatcher。

#### Outbound 媒体文件名

Rust `BridgeAdapter::send_file/send_photo` 会把 `{ filename, data }` POST 到 Bridge `/send-media`。Bridge 需要把 base64 payload materialize 成临时文件，再把绝对路径作为 `mediaUrl` 传给 OpenClaw plugin 的 `outbound.sendMedia`。

这个临时文件的 basename 对部分插件就是用户最终看到的上传文件名：WeChat / WeCom / Lark 等媒体 loader 会从 `path.basename(mediaUrl)` 推导 `fileName`。因此 Bridge 的文件名清洗边界是：

- 必须保留 UTF-8 / 中文等 Unicode 展示名；
- 必须移除路径分隔符、控制字符、Windows forbidden characters、Windows device names；
- 必须把展示名规范化到 NFC，并限制单个 path component 长度，保证 macOS / Windows 都能稳定落盘；
- 不能用 ASCII-only regex 把非拉丁字符替换为 `_`。

### 阶段 5：错误恢复

| 场景 | 检测方式 | 恢复策略 |
|------|---------|---------|
| Bridge 进程崩溃 | `/health/live` 连续 3 次失败（旧 Bridge 的 404 才回退 `/health`） | Rust 自动重启 Bridge |
| 上游 Gateway 暂时不可用 | `/health/functional` 非 2xx / 请求失败 | 仅在 degraded/recovered 状态切换时记日志；Bridge 保持存活，不清理插件连接与 backoff 状态 |
| 插件注册失败 | `register()` 抛异常 | 存入 `gatewayError`，`/status` 返回错误 |
| Gateway 启动失败 | `startAccount()` 抛异常 | Bridge 保持存活，用户可从 UI 重试 |
| SDK shim 被覆盖 | 启动时 version 检查 | 自动重新安装 shim |

## SDK Shim 系统

### 问题与方案

**问题**：OpenClaw SDK 声明大量 `plugin-sdk/*` 子路径导出。插件通过 `require('openclaw/plugin-sdk/xxx')` 导入。如果 shim 缺少某个模块，Bridge 直接崩溃（`Cannot find module`）。

**方案**：Generator + Override Manifest（全量覆盖 + 手写保护）

```
sdk-shim/
├── package.json                    ← generated exports（含 ./plugin-sdk 根子路径）
└── plugin-sdk/
    ├── _handwritten.json           ← 手写清单，生成器绝不覆盖
    ├── index.js                    ← 手写：根模块
    ├── core.js                     ← 手写：defineChannelPluginEntry 等
    ├── agent-runtime.js            ← 手写：jsonResult / textResult / ToolInputError
    ├── routing.js                  ← 手写：session key 解析
    ├── feishu.js                   ← 手写：飞书专用适配
    ├── ...                         ← 其它手写适配
    ├── discord.js                  ← 自动生成 stub
    ├── telegram.js                 ← 自动生成 stub
    └── ...                         ← 其它自动生成 stub
```

### 手写模块 vs 自动生成 stub

| 维度 | 手写模块 | 自动生成 stub |
|------|---------|-------------|
| 保护机制 | `_handwritten.json` 清单 | `AUTO-GENERATED STUB` header |
| 函数行为 | 真实逻辑（简化版） | 首次调用打印警告，返回安全默认值 |
| 维护方式 | 手动编写和更新 | `npm run generate:sdk-shims` 自动生成 |
| 用途 | 插件实际调用的核心 API | 防止 `Cannot find module` 崩溃 |

### 生成器工作原理

`scripts/generate-sdk-shims.ts`：

1. 读取 `openclaw/package.json` → 提取全部 `./plugin-sdk/*` 导出路径
2. 读取 `_handwritten.json` → 跳过手写模块
3. 对每个非手写模块：
   - 读取 `openclaw/src/plugin-sdk/{name}.ts`
   - 正则提取运行时导出符号（函数、常量、类、枚举）
   - 递归跟踪 `export * from "..."`（深度限制 5 层，`.js` → `.ts` 路径转换）
   - 匹配 `export { foo, bar }` 和 `export { foo } from "..."`（跳过 `type` 前缀）
4. 渲染 stub 文件（命名导出 + 返回值启发式 + 首次调用警告）
5. 更新 `package.json` exports map

**返回值启发式**：

| 函数名模式 | 默认返回值 | 原因 |
|-----------|-----------|------|
| `is*`, `has*`, `should*`, `can*` | `false` | 布尔判断，false 不启用功能 |
| `list*`, `collect*` | `[]` | 空数组避免 `.map()` 崩溃 |
| `format*`, `normalize*`, `strip*` | `""` | 空串安全 |
| `*Schema`, `*Config`, `*Defaults` | `undefined`（const） | 识别为配置对象常量 |
| 其他 | `undefined` | |

### Shim identity 同步

| 位置 | 变量 | 用途 |
|------|------|------|
| `sdk-shim/package.json` | `version` + `"type": "module"` | Bridge 启动完整性检查 |
| `compat-runtime.ts` | `SHIM_COMPAT_VERSION` | 插件 `assertHostCompatibility()` |
| `bridge.rs` | `SHIM_COMPAT_VERSION` | Rust 层 peerDependencies 比对 |

三处 identity 必须一致；当前字面值以源码和生成器校验为准，不在文档复制。

修改 shim 内容或 exports 时也必须同步更新三处 identity，否则已安装插件会在启动时继续复用旧 shim。普通 Channel 启动只检查并刷新 shim；npm 安装或升级由显式插件安装 / 更新入口执行。

Shim 用 ESM 格式（`"type": "module"`），生成器输出 `export function`，与上游 OpenClaw `plugin-sdk/*` 子路径导出对齐。

### 维护工作流

**OpenClaw 更新时**：
```bash
cd ../openclaw && git pull
cd ../MyAgents && npm run generate:sdk-shims
git diff src/server/plugin-bridge/sdk-shim/  # 审查变更
```

**Stub 需要真实逻辑时**：
1. 在 `_handwritten.json` 添加模块名
2. 编辑 `.js` 文件实现真实逻辑
3. 重跑生成器（它会跳过该文件）

插件引入尚未手写适配的 SDK export 时，生成 stub 让单项功能按兼容合同降级并记录未实现警告；不能因一个缺失 module 使整个 Bridge 在 import 阶段崩溃。需要真实行为时再把对应模块升级为受保护的手写实现。

插件使用的兼容子路径可能已不在当前上游源码的 exports 中，仍需登记到 `_handwritten.json` 才能在生成时保留。例如微信 2.4.8 的 `channel-message.createTypingCallbacks` 复用 `channel-runtime` 的既有实现，与 2.4.6 保持相同的 Bridge typing 行为。

## HTTP 端点一览

| 端点 | 方法 | 用途 |
|------|------|------|
| `/health` | GET | `/health/live` 的 legacy alias |
| `/health/live` | GET | Bridge 进程存活探针；运行期 watchdog 唯一重启依据 |
| `/health/ready` | GET | 插件已加载且 gateway 已注册/启动 |
| `/health/functional` | GET | 上游 gateway 最近仍能成功工作；只用于诊断，不触发进程重启 |
| `/status` | GET | 就绪状态 + 错误信息 |
| `/capabilities` | GET | 插件能力标记 |
| `/send-text` | POST | 发送消息 |
| `/edit-message` | POST | 编辑已发消息 |
| `/delete-message` | POST | 删除消息 |
| `/send-media` | POST | 发送图片/文件 |
| `/validate-credentials` | POST | 凭证验证（dry-run） |
| `/start-dispatch` | POST | 按 requestId 开始 OpenClaw reply turn |
| `/start-stream` | POST | 建立该 request 下的 raw text block transport segment |
| `/stream-chunk` | POST | 入队 full-snapshot partial |
| `/finish-stream-block` | POST | 建立 raw block 顺序屏障，不结束 turn |
| `/complete-dispatch` | POST | 接纳 producer-owned `finalPayloads` terminal；HTTP ACK 仅表示已合法入队 |
| `/abort-dispatch` | POST | 接纳 error/cancel terminal；HTTP ACK 仅表示已合法入队 |
| `/mcp/tools` | GET | 列出插件工具；每个 Sidecar Session 的 stable surface generation 至多发现一次 |
| `/mcp/call-tool` | POST | 执行插件工具 |
| `/execute-command` | POST | 执行斜杠命令 |
| `/qr-login-start` | POST | 发起 QR 登录 |
| `/qr-login-wait` | POST | 轮询 QR 扫码结果 |
| `/restart-gateway` | POST | QR 登录后重启 gateway |
| `/stop` | POST | 优雅关闭 |

### MCP surface 预热与工具调用预算

`/mcp/tools` 是 Session 级工具面 discovery，不是每条消息的业务调用。Sidecar 以
规范化的 `{bridgePort, pluginId, sorted enabledToolGroups}` 作为 stable surface identity
（规范化时统一加入 `interaction`）；同一 identity 成功或失败后都不按消息重试。非空
工具 schema 才创建 SDK server；零工具 terminal ready，失败/超时 terminal degraded，
两者都会发布 surface identity，避免后续消息再次 discovery。新 identity / 新 Session 才建立新 generation，并从
`src/server/session-core/mcp-prewarm-policy.ts::MCP_PREWARM_GRACE_MS` 派生一次当前为
10 秒的 absolute discovery + SDK readiness observation 预算。live SDK map mutation
仍使用独立的 30 秒正确性 fence：mutation 不被 10 秒 deadline 截断，但墙钟耗时会减少
后续 readiness observation 的剩余 absolute window，且不会重置或延长它。soft 预算到期
只让该 surface generation degraded，AI turn 继续。

存在工具 schema 时，SDK server 是 Session-stable；sender/chat/account/owner 由 exact
IM request registry entry 和 SDK output FIFO owner 在工具执行时解析，不能 capture 首条消息 context。这样连续 Session
既不重复 `/mcp/tools`，也不会因复用 server 而串身份。

真正的工具调用使用另一条独立预算：

Sidecar 通过 `/mcp/call-tool` 调用插件工具时，使用
`src/server/session-core/tool-call-policy.ts::MYAGENTS_TOOL_CALL_TIMEOUT_MS`
作为 MyAgents 管理的整个工具调用外层预算，当前为 300 秒。主动停止
Turn 仍通过 `getCurrentTurnSignal()` 立即取消 Sidecar 的请求等待。插件内部单次
网络请求、分片或重试的超时继续由插件自己负责，不与这个外层预算混用。

所有经该代理暴露的 OpenClaw 插件工具都使用同一预算；同一 IM 会话中的 SDK
原生工具和其它 MCP 工具不经过该代理，因此本期不受影响。该参数当前只由 IM
Bridge 消费；Builtin SDK、Managed Codex 与用户原生外部 Runtime 仍保留各自的
工具调用 timeout authority。未来只有在产品明确决定接管对应路径时才复用该参数，
不能因为参数已存在就隐式改变其它 Runtime 行为。

## QR 登录流程

```
1. isConfigured() → false + supportsQrLogin → 等待 QR 登录
2. 前端 POST /qr-login-start → 插件生成 QR 数据
3. 前端轮询 /qr-login-wait（最长 35s）
4. 用户扫码 → 插件保存凭证到磁盘
5. 前端 POST /restart-gateway (accountId)
6. Bridge 重新解析账号 → isConfigured() 通过 → 启动 gateway
```

## 资源打包

| 资源 | 开发模式 | 生产模式 |
|------|---------|---------|
| Bridge 脚本 | `src/server/plugin-bridge/index.ts`（tsx/esm 加载） | `Contents/Resources/plugin-bridge-dist.mjs`（esbuild bundle） |
| SDK shim | `src/server/plugin-bridge/sdk-shim/`（源码目录） | `Contents/Resources/plugin-bridge-sdk-shim/` |
| Node.js 运行时 | `src-tauri/resources/nodejs/`（含 node / npm / npx） | `Contents/Resources/nodejs/` |

## 关键文件索引

| 文件 | 职责 |
|------|------|
| `src-tauri/src/im/bridge.rs` | Rust 层：安装、启动、健康检查、消息路由 |
| `src-tauri/src/process_cmd.rs` | Bridge 进程树创建与精确停止 |
| `src/server/plugin-bridge/index.ts` | Bridge HTTP Server + 插件加载入口 |
| `src/server/plugin-bridge/compat-api.ts` | OpenClaw API 适配（registerChannel/Tool） |
| `src/server/plugin-bridge/compat-runtime.ts` | Channel Runtime Mock + 消息拦截路由 |
| `src/server/plugin-bridge/lark-admission.ts` | 官方 Lark 同 chat task 的 admission scope/token owner |
| `src/server/plugin-bridge/plugin-compat-patches.ts` | 已知官方 Lark queue 源码的 fail-closed 窄变换 |
| `src/server/plugin-bridge/pending-dispatch.ts` | requestId → OpenClaw dispatcher 的有序传输队列 |
| `src/server/plugin-bridge/sdk-shim/` | SDK shim 包（293 个 exports） |
| `src/server/plugin-bridge/sdk-shim/plugin-sdk/_handwritten.json` | 手写模块保护清单 |
| `scripts/generate-sdk-shims.ts` | Stub 自动生成器 |
| `src-tauri/tauri.conf.json` (resources) | shim 打包配置 |

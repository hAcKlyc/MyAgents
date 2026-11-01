# Sidecar 冷启动性能架构

> 本文记录 Sidecar 冷启动的当前执行顺序和性能约束。具体耗时受机器、Runtime 与 MCP 配置影响，应以启动日志中的计时点为准，不把历史本机数据作为性能合同。
> 核心思路：**尽快开始监听 → 延后非必要初始化 → MCP 按需加载**。

## 总览

冷启动路径上有四个降延迟杠杆：

1. **Rust 侧 health check 探测节奏** — 让 Rust 尽早检测到 Sidecar listen
2. **Node `main()` 重排序** — listen 前只做极轻量操作，重活在 listen 后跑
3. **Tab fast-path** — Tab session 跳过 MCP 磁盘扫描
4. **Tier 2 懒加载** — Settings UI / OpenAI bridge / 大模块按需 import

## Rust 侧启动时序 (`src-tauri/src/sidecar/*`)

`src-tauri/src/sidecar.rs` 现在是 facade。冷启动路径的真实 owner：

- `sidecar/session_lifecycle.rs`：session sidecar ensure、spawn 后 health/readiness 等待
- `sidecar/instances.rs`：global/tab sidecar spawn 与 monitor
- `sidecar/health.rs`：`wait_for_health`、`wait_for_readiness`、`check_sidecar_http_health`
- `sidecar/spawn.rs`：Node/script 定位、路径 normalize、spawn diagnostic

- TCP health check 指数退避 50→500ms（前 5 次累计 1.25s 覆盖常见冷启动窗口），代替固定 500ms 轮询
- `try_wait()` 非阻塞，crash 检测由 health loop 的 alive check 承担，不另加固定 guard sleep。
- TCP 可连接只表示存活。Global 初次启动与 monitor replacement 均在 manager 锁外等待 `/health/ready`，完成后由 manager 校验当前 generation / desired owner，再发布 `healthy` 与 CLI port。Session 也在自己的生命周期入口等待 readiness；不得将 TCP 成功直接当作路由可用，否则启动期一次性模型查询会收到 503。

## Node Sidecar `main()` 重排序 (`src/server/index.ts`)

**监听端口前只做轻量操作：**
- `ensureAgentDir`
- `initLogger`
- `setSidecarPort`
- `createBridgeHandler`

**`honoServe` 随后绑定 `127.0.0.1:port`**，让 Rust 尽早完成 health check。

**监听端口后，再根据进程角色执行延迟初始化：**
- Global：应用级 retention / migration cleanup、OAuth proactive scheduler
- Common：skill seed、plugin dir setup、socks bridge
- Session：OAuth revision observer、`initializeAgent`、external runtime restore、boot banner

因此 Global 不会为了 Settings 或 Provider 一次性操作创建虚假的当前 Session，也不会启动持久 Query 或恢复 Runtime；Session 进程也不会重复运行应用级 retention timer 和 migration scan。Skill seed 仍是可重复执行的共享初始化：更新后第一个启动的进程可能是 Session，它在接收 turn 前必须能够看到必需的 bundled skills，不能依赖另一个进程已经完成初始化。

SDK `schedulePreWarm` 只接受 `builtin` Runtime，不能用“不是 external CLI”推断 SDK ownership：Integrated DSH 的 Runtime 也是集成分发，但拥有自己的原生进程。配置刷新经 SessionEngine 路由；SDK content binding 同样只绑定 builtin，避免误预热同时给 DSH transcript 挂上第二个 SSE publisher。

`DeferredInitState` 是路由级就绪权威：`sidecar-composition.ts` 会在调用 handler 或解析请求体前拒绝未知路由和角色不匹配的路由；其余允许的路由除 `/health`、`/refs/:id` 外，由 route gate 读取状态机，未就绪时返回结构化 503。`/health/live`、`/health/ready`、`/health/functional` 分别表达存活、就绪和功能状态；初始化失败只写入这一状态机，不再维护第二条 Promise 失败通道。稳定运行后，这些检查都只是内存判断。Browser/Vite 的单进程开发模式由 `start_dev.sh --dev-union` 显式启用；生产环境只有 Rust 传入的 `global|session` 两种角色。详见 `pit_of_success.md` 的「DeferredInitState」节。

`warmupShellPath()` 用异步 `execFile` 发现 interactive login Shell 的 PATH，不阻塞 Sidecar TCP accept；真正依赖 CLI 定位的入口等待同一次发现结果。

## Tab fast-path

`initializeAgent` 对 Tab session 传 `resolveWorkspaceConfig(..., { includeMcp: false })`，跳过 MCP 磁盘扫描。

**为什么 Tab 不需要 self-resolve MCP：**
- Tab 的 MCP 由前端 `/api/mcp/set` 下发
- self-resolve 不仅做白工，还会触发 fingerprint 差异 → abort → 30s 重启循环

启动解析复用同一次 metadata 读取，避免重复磁盘 IO。

## External Runtime pre-warm：process ready ≠ MCP ready

Codex / DSH 的 persistent runtime 预热和 Sidecar HTTP readiness 是两层不同契约。Sidecar `/health/ready` 只说明 Node owner 可接请求；external `startSession()` 返回才说明该 runtime 能接首轮 turn。

Managed Codex 又多一层：`initialize` 完成后 app-server 已存活，但 MyAgents 通过进程参数注入的 MCP 仍异步启动。`CodexRuntime.startSession()` 在发起 `thread/start|resume` 的 native startup boundary 消费从应用级 demand 接受时开始的 10 秒 absolute dispatch grace；Codex 原生 `startup_timeout_sec=60` 是单次启动尝试的上界，不重置也不延长前者。grace 到期只放行基础 turn，Runtime 状态与 tool catalog 仍持续观察；late-ready 会直接更新当前 Product Session，若启动准入时尚未把本地 MCP 放入进程，则 external-session owner 在 idle boundary replacement 并自动 pre-warm。这个 owner 不包含 Codex 用户目录自有配置；只有 process exit、thread/RPC failure 仍是 Runtime startup failure。

MCP definition 在到达 runtime 前也必须保持可执行：`mcpServerArgs[id]` 是 preset 的附加参数，不得替换 package/base argv。标准 `playwright` 继续产生普通 stdio MCP；只有固定 ID `myagents-browser` 的保留 sentinel 会投影成带短期 capability 的应用 Browser Host HTTP endpoint。启动失败、资源未 ready、鉴权与 late-ready 都必须进入 effective snapshot；dispatch grace 不能充当 capability terminal。

## Builtin 控制面、turn metadata 与 MCP readiness

三项事实必须分开：

| 信号 | 含义 | 不能证明 |
|---|---|---|
| `Query.initializationResult()` | SDK 子进程控制面就绪、返回初始化信息 | 每个 MCP 已 connected |
| streamed `system_init` | 当前 turn 的 model/tools/session 等 metadata | 子进程直到此时才启动完成 |
| `Query.mcpServerStatus()` 与 live catalog | 当前 MCP 连接和可用工具 | 整个 turn 已完成 |

`builtin-session/lifecycle.ts` 持有 `sdkControlReady` 与 Query identity。启动时异步观察 `initializationResult()`；resolve 只更新仍属于当前 Query 的状态，不阻塞消息 generator。入队/启动状态按 `systemInitInfo || sdkControlReady` 决定 running/starting，避免已预热的慢首轮一直显示“AI 启动中”。没有 pre-warm 的冷启动也在控制面 ready 后推进 running。abort/reset/replacement 同时撤销旧 authority、清理初始化状态，迟到 Promise 或 streamed event 不能污染新 Query。

每次 Query launch 捕获 Product Session id 与 expected SDK id。`system_init` 只有在 Query authority 未撤销、Product binding 未改变且 native id 精确匹配时才能更新 metadata；pending adoption 在存储提交边界再次验证。legacy/non-UUID Product id 保持自身 binding，只记录 SDK id。真实 Session 导航不能伪装为 pending birth。

MCP 连接是非阻塞的：初始化返回或 metadata 中列出服务后，该服务仍可能 pending/failed/needs-auth/disabled。每个 Query/MCP map generation 建立一次 10 秒 absolute dispatch grace；Desktop、IM 与 injected queue 的公共 dispatch seam 只消费剩余预算。到期后至少观察一次真实状态，再放行基础 turn；低频 observer 持续发布 late-ready 与 catalog，不把 timeout 记成永久无能力。

observer 每次异步完成都核对原 Query/map revision。读取失败只标记 observation stale；明确清理连接时发布同 Session、递增 revision 的空能力快照。`classifyMcpFailure()` 在 Runtime 错误仍可见的位置映射有限错误码，UI 不接收原始命令、路径或凭据。

`/api/mcp/retry` 经过 SessionEngine，处理当前选择且失败的工具；Managed Codex 还支持显式启动当前选择且已停止的工具。Builtin 复用 resume/rebuild/pre-warm；Managed Codex 复用 mutation lease 与 idle replacement。回执表示重连尝试已接纳/执行，是否 ready 仍由新 generation 的状态决定，不写配置或 transcript。

pre-warm 创建后续直接复用的真实 Query，builtin 的 Query-scoped 配置和资源始终服从既有 lifecycle owner；不能假设首条消息一定经过非 pre-warm 初始化分支。

## Tier 2 懒加载

### 大模块改为 `await import()`

| 模块 | 触发条件 |
|------|---------|
| `admin-api` | 首次处理 `/api/admin/*` 请求 |
| `openai-bridge` | 首次使用 OpenAI 兼容 Provider |
| `adm-zip` | 首次执行需要 ZIP 读写的操作 |

只在用户真正触发对应功能时才 parse。

### Builtin MCP 懒加载架构

当前两个 user-toggleable in-process MCP（`gemini-image` / `edge-tts`）通过 `src/server/tools/builtin-mcp-meta.ts` 集中登记 META，运行时按需 `getBuiltinMcpInstance(id)` 加载。Task/IM 命令归 `myagents` CLI，runtime-dynamic `im-bridge-tools` 走独立的 context-injected surface owner；它们都不进入该 registry。

- 首次调用才初始化 SDK/Zod schema；
- 同一进程复用已加载 instance promise
- 失败自动 evict 防 poisoned cache
- ESLint `@typescript-eslint/no-restricted-imports` 规则（作用域 `src/server/tools/*.ts`）结构性禁止顶层 value-import SDK/zod

详见 `pit_of_success.md` 的「Builtin MCP 懒加载架构」节。

### Settings UI 的 MCP 列表

从**静态** `PRESET_MCP_SERVERS`（权威定义在 `src/shared/config-types.ts`，renderer 通过 `src/renderer/config/types.ts` barrel 读取）获取——与运行时 META 解耦。META 在 Sidecar 启动时只登记轻量 factory；本次 Sidecar 生命周期内从未启用或测试的 builtin 不会加载 tool module，也不会创建重型 INSTANCE。

### Custom MCP OAuth maintenance

Custom MCP credential 的持久化 authority 是 `src/server/mcp-oauth/state-store.ts`。Global Sidecar 是 proactive refresh scheduler 的唯一 owner；Session Sidecar 只在启动时建立全量 revision baseline 并观察后续 credential revision，不能各自启动周期刷新器。

每个 token grant、refresh 或 revoke 都在 state-store 锁内推进单调 `tokenRevision`。token endpoint 请求开始前捕获 revision，响应只允许通过 `setServerTokenIfRevision()` 做 compare-and-set；若期间发生 revoke 或新的 authorization，旧 refresh 响应必须丢弃，不能复活已删除 credential 或覆盖新 grant。credential 写盘失败必须向调用方报失败，不能把仅存在于当前进程内存的 token 当成功。

## 排查冷启动退化的 checklist

如果某次改动后 Tab 打开变慢，按下面顺序排查：

1. **是否给 `src/server/tools/*.ts` 顶层加了 SDK/zod value import？** —— ESLint 应该会拦下，但旧代码可能漏。
2. **是否在 listen 之前加了同步重活？** —— 检查 `index.ts main()` 的 listen 前代码段。
3. **是否新加了路由不走 deferred-init gate？** —— 除 `/health/*` 和 `/refs/:id` 外都应走 gate。
4. **是否 Tab session 误开启了 MCP self-resolve？** —— 检查 `initializeAgent` 的 `includeMcp` 参数。
5. **是否新加了 `console.log` 在 hot path 而 logger 未 buffered？** —— `UnifiedLogger` 是 in-memory bounded queue，但极高频日志仍可能拖慢。
6. **是否第一条用户消息整段都被标成「AI 启动中」？** —— 先确认 `sdkControlReady` 是否在 pre-warm spawn 后被 `initializationResult()` 设为 true（搜索 `[agent] SDK control plane ready in`）。再核对所有 session 重置点同时清 `systemInitInfo` 和 `sdkControlReady`。详见上方「Builtin 控制面、turn metadata 与 MCP readiness」节。
7. **External 日志是否把 dispatch 与 capability 分开？** —— Managed Codex 记录 `MCP dispatch outcome=ready|released` 及 `releaseReason`，10 秒只决定当前 turn 是否继续等待；后续 native status/tool catalog 仍可在同一 Product Session 发布 late-ready，或触发一次 idle replacement。RPC 失败属于 Runtime failure，不能伪造 capability terminal。
8. **同一 Codex pid/thread 的每轮首响仍固定慢约 30 秒？** —— 检查 MyAgents injected server 的最终 launch config 是否带 `startup_timeout_sec=60`，并确认 preset package/base argv 没被 `mcpServerArgs` 覆盖；不要先假设进程发生了重启。

## 与其他文档的关系

- 启动期 readiness 状态机 → `pit_of_success.md` 的 DeferredInitState 节
- Builtin MCP 懒加载完整规范 → `pit_of_success.md` 的对应节
- 内置 Node.js 路径与 PATH 注入 → `bundled_node.md`
- 整体启动时序 → [ARCHITECTURE](../ARCHITECTURE.md) 的“Session、Sidecar 与 Owner”和“控制面与大载荷数据面”章节

# In-process MCP 工具架构

MyAgents 的 builtin custom tools 以 MCP server handler 为复用边界。Builtin Claude 通过 Claude Agent SDK 的 in-process MCP transport 使用它们；Managed Codex 与 Integrated DSH 经共享 `product-extensions` dispatcher，把同一 handler 投影到各自的原生 Host tool 协议。

本文不维护完整工具清单。当前注册项以 `src/server/tools/builtin-mcp-meta.ts`、动态 Channel owner 和测试为准。

## Surface 分类

| 类型 | Owner | Lifecycle |
| --- | --- | --- |
| User-toggleable builtin | `builtin-mcp-meta.ts` + `builtin-mcp-registry.ts` | Sidecar 内按 ID 懒加载、按 Session 配置 |
| Context-injected Channel tools | 对应 Channel/context module，例如 `im-bridge-tools.ts` | 只在所需 context 已建立后创建，可 live sync |
| External stdio / HTTP MCP | 用户或 preset 配置 + MCP resolver | 由 Runtime adapter 启动或连接 |
| Task、Goal、Record 等产品命令 | `myagents` CLI | 不再复制为 SDK-only MCP |

只有真正需要 in-process schema/handler、并且应暴露为模型工具的能力才进入 builtin MCP。普通应用 API、跨 Runtime 产品命令或一次性 helper 不应为了“方便调用”再造 MCP surface。

## 两层 lazy registry

Sidecar 冷启动只执行轻量 metadata 注册：

```text
builtin-mcp-meta.ts
  -> registerBuiltinMcpMeta({ id, load })
  -> 用户启用 / Settings 验证 / Session pre-warm
  -> getBuiltinMcpInstance(id)
  -> dynamic import tool module
  -> createSdkMcpServer + Zod schema construction
```

约束：

1. metadata 模块顶层不能导入 `@anthropic-ai/claude-agent-sdk` 或 `zod`；
2. tool module 的 `createXxxServer()` 内部动态导入 SDK 与 Zod；
3. `configure` / `validate` 保持轻量 export，由 registry 在实例需要时调用；
4. instance promise 按 ID 去重并缓存；load reject 时必须逐出 poisoned cache，允许下次重试；
5. esbuild 当前仍输出单一 server bundle，lazy import 的收益是避免模块执行和 schema construction，不是减少 artifact 体积。

新增 user-toggleable builtin 只在 metadata registry 增加一处登记，并提供对应 async factory。不要在 `agent-session.ts` 再维护平行 switch 或静态工具名单。

## SDK API 边界

当前安装 SDK 的核心 shape 是：

```ts
createSdkMcpServer({
  name,
  version,
  tools: [
    tool(name, description, zodRawShape, async (args, extra) => ({
      content: [{ type: 'text', text: '...' }],
    })),
  ],
});
```

精确签名以 `node_modules/@anthropic-ai/claude-agent-sdk/sdk.d.ts` 为准。Schema 使用当前 SDK 接受的 Zod raw shape；不要从旧版文档复制 wrapper。Handler 返回 MCP `CallToolResult`：

- 成功内容放在 `content`；
- 失败设置 `isError: true` 并返回对模型有行动意义、但不泄漏 secret 的文字；
- image/audio 使用 MCP 支持的 base64 content block；
- 大文本遵守现有 spill / ref policy，不能无界塞回模型上下文。

工具命名使用稳定、可读、snake_case 的 server-local name。最终 wire name 由 Runtime 投影拥有，handler 不解析 `mcp__server__tool` 或 Codex dynamic name。

## Session context

工具需要 Session/workspace/config 时，由 factory 的 `configure(env, context)` 或专用 context owner 注入。要求：

- context 按 Session/generation 更新，不能从 process-global “当前 Tab”猜测；
- credential 只在执行进程内存在，不出现在 tool result、日志或 public wire type；
- tool call 开始时冻结本次所需 identity，异步 completion 不得写入已经替换的 Session；
- handler 结束时释放临时文件、网络 response 和模型 context；
- 多个 Sidecar 各自拥有实例，不依赖跨进程 module singleton。

需要动态 Channel 信息的工具不进入静态 metadata registry；必须在 Channel context 建立后由 `buildSdkMcpServers()` / live MCP sync 注入。Session reset 不能误清仍由活跃 Channel owner 使用的 context。

## Builtin Claude 投送

`buildSdkMcpServers()` 根据 current Session effective MCP 配置：

1. 解析 user-toggleable builtin ID；
2. 懒加载 instance；
3. 以当前 env / Session context configure；
4. 与 external MCP 和 context-injected MCP 合并；
5. Query 启动时通过 `mcpServersDelivery: 'initialize'` 从标准输入发送外部服务配置，使凭据和长配置避开原生进程命令行。进程内服务仍由 SDK 持有，运行中更新继续走受控的 `setMcpServers()`。

Live mutation 由单一 mutation owner 串行化，有 timeout、fingerprint 和 replacement fallback。不能在 Settings handler 直接修改 active Query 的 MCP map。

工具是否已注册只决定可见性；执行权限仍由 [`sdk_canUseTool_guide.md`](sdk_canUseTool_guide.md) 中的 permission policy 和 hooks 裁决。

## Managed Codex 复用

`src/server/runtimes/product-extensions/host-dispatcher.ts` 是共用执行 owner；Managed Codex 的同名模块只转发这个入口，不重写 builtin handler：

1. 取得同一个 `McpServer` instance；
2. 用 linked `InMemoryTransport` 建立 MCP Client/Server connection；
3. `listTools` 后投影为 Codex `dynamicTools`；
4. 把 Codex call 还原为原生 MCP tool call；
5. 将 MCP result 映射为 Codex host result，并对大值 spill；
6. generation 结束时关闭 client、server 和两个 transport。

Codex 保留 `mcp` / `mcp__*` namespace，因此 host tool 使用独立的 `myagents__mcp__<server>__<tool>` wire name。这个名字只是 adapter projection，不能写回 MCP registry identity。

同一 cached server reconnect 前要等待上一 connection 完整关闭；否则共享 `McpServer` 会发生 generation 间 transport 竞争。

其它 external Runtime 没有等价 host-tool protocol 时，不得假装 in-process MCP 已跨 Runtime 可用。是否支持必须由 adapter capability 明确表达。

Integrated DSH 使用同一 discovery/dispatcher，但由 DSH compiler 创建 `host_tool` 声明，reverse port 把原生调用交给共享 handler。声明、实际调用与输出附件分别按 generation 校验，不复用 Codex wire name。

## 不应恢复的旧 surface

Task/Cron completion 与 IM scheduled delivery 由统一 `myagents` CLI / management API 拥有。继续在工具指南中保留它们的旧 schema 会诱导新代码建立第二套 owner。这些能力保持 CLI discovery；渠道文本/媒体复用下述 CLI handler，不注册 MCP/host tool，也不恢复独立 IM media owner。

## 新增工具检查

1. 确认能力属于 in-process MCP，而不是 CLI、普通 API 或 external MCP。
2. 定义 owner、Session/generation context、credential 和 cleanup。
3. 在 tool module 内创建 SDK server，保持 SDK/Zod lazy import。
4. 只在 metadata registry 或动态 context owner 登记一次。
5. 返回标准 MCP content；复用 attachment/spill helper。
6. 验证 effective MCP enablement 与 permission path。
7. 若 Managed Codex 也应支持，验证 host dispatcher 的 schema、name、result 和 teardown projection。

测试至少覆盖 schema validation、成功/失败 result、并发 lazy load、load failure retry、Session reconfigure、MCP live mutation、Managed Codex reconnect 和大结果 spill。

## 统一渠道消息工具

`tools/channel-messaging.ts` 为 `myagents im send-message` 的统一 Node handler，各 Runtime 的 CLI 共用请求 schema、文件约束及 Rust management API。Rust 拥有连接、精确默认绑定和最终发送；调用方身份来自 Sidecar/generation，schema 不接受模型指定 sessionId。两种 mode 都提供工具，配置只管普通回推。

Builtin、Managed Codex 新旧 thread、DSH、Claude Code 和系统 Codex 均通过既有 MyAgents CLI 运行 `myagents im send-message`。不注册新 MCP/host tool；system prompt 和逐轮 reminder 统一写 CLI 方法。可用性依赖可信 Session/Agent 资格，不依赖正在进行的 IM request。

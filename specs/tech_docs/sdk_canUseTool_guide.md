# Builtin Claude 工具权限架构

本文描述 Builtin Claude Agent SDK 的工具可见性、`canUseTool` 与 hooks 如何共同形成 MyAgents 权限边界。Integrated DSH 与 External Runtime 由 `session-engine` adapter 和各 Runtime 原生协议拥有，不复用本文回调。

SDK 类型与行为必须先核对当前安装的：

- `node_modules/@anthropic-ai/claude-agent-sdk/sdk.d.ts`；
- `node_modules/@anthropic-ai/claude-agent-sdk/sdk-tools.d.ts`；
- 对应 native package / SDK 实现。

## 可见性不等于授权

三层职责不能互换：

| 层 | Owner | 回答的问题 |
| --- | --- | --- |
| Tool surface | `tools`、`allowedTools`、`disallowedTools`、MCP map | 模型能否看见或调用这个名字 |
| Permission policy | `canUseTool`、session grants、用户卡片 | 当前调用是否允许 |
| Hard invariant | `PreToolUse` / `PermissionRequest` 等 hook | 绕过普通 permission resolver 的路径是否仍安全 |

Prompt 或 tool description 只帮助模型选择工具，不构成权限控制。MCP server 被用户关闭后，所有允许路径都必须重新检查 effective MCP set，不能让旧的 session grant 绕过 enablement。

## Permission mode 映射

MyAgents 在 Query 创建时把产品模式映射到 SDK mode：

| MyAgents | SDK | 语义 |
| --- | --- | --- |
| `auto` | `acceptEdits` | 编辑自动接受，其它调用按产品 policy |
| `plan` | `plan` | 只允许规划期安全 surface |
| `fullAgency` | `bypassPermissions` | 用户明确选择的最大权限 |
| `custom` | `default` | 逐项规则和确认 |

`allowDangerouslySkipPermissions` 在 Query birth 时开启，使 live Session 能切到 `bypassPermissions`。这也意味着不能假设 SDK 一定调用 `canUseTool`；hard invariant 必须放在所有 mode 都执行的 hook。

## canUseTool 返回契约

当前 SDK 的 allow result 为：

```ts
{
  behavior: 'allow',
  updatedInput: input
}
```

MyAgents 的允许路径必须带 `updatedInput`。AskUserQuestion 等会改变输入的工具返回补全后的 input；普通允许则原样回传。拒绝返回用户可理解的 `message`；控制转移工具在用户取消时使用 `interrupt: true`，防止模型把取消当作普通 tool error 后继续执行。

不要从旧示例猜 SDK shape，类型字段和 hook output 以已安装 `sdk.d.ts` 为准。

## Hard gates

### Plan mode

旧 SDK 在 `allowDangerouslySkipPermissions` / plan 组合下可能自行 resolve 调用，不产生普通 `canUseTool` request；上游已修复该短路，但产品更严格的只读保证与切换竞态仍由 `PreToolUse` 使用 `src/server/utils/plan-mode-gate.ts` 的共享 policy 裁决，不能因升级移除。

有效 mode 同时观察 hook 的 `permission_mode` 与 Sidecar 的 live mirror；任一表示 plan 都按 plan 处理，以关闭切换期间的异步窗口。非只读工具 fail closed。`canUseTool` 与 hook 共用同一 policy，不能各维护一份名单。

规划期仅有一个文件写入例外：`Write` / `Edit` 当前 Product Session 的 `.claude/plans/myagents/<sessionId>/` 目录内直接 Markdown 文件。`plan-files.ts` 校验既存各级目录和叶文件，拒绝符号链接、硬链接、跨 Session 和项目源文件；PreToolUse 与 canUseTool 共用该检查。不允许 Bash/MultiEdit 等借此扩大写入范围。模型须沿用原生规划提示给出的具体方案文件名；SDK resolver 仍执行其正常检查，不新增全局工具白名单。

`ExitPlanMode` 必须取得当前轮可完整展示的方案（兼容显式 `plan`，或读取该 Session 专用目录）。缺失、空白、读取失败或超过展示上限时返回可修复的 `deny + interrupt:false`，不广播空审核、不冒充用户拒绝、不改变权限模式。用户看到的卡片正文是该次 pending request 的快照；重连 replay 保持同一正文。旧空请求在 UI 明确提示并禁止批准，仍可拒绝或提交补充要求。正文随审批结果保留，只有有效用户批准才恢复执行模式。

### 不支持交互的 Channel

AskUserQuestion、EnterPlanMode、ExitPlanMode 等需要原生 UI 的工具，在不支持 native card 的 IM / Channel 上由 tool visibility 与 `PreToolUse` 双重阻止，并提示模型改用普通文本。不能发出无人能够回答的 permission request。

### Background sub-agent

`run_in_background` sub-agent 的 gated tool 由 SDK `PermissionRequest` hook 决策，不保证经过前台 `canUseTool`。当前 owner 为：

- `src/server/utils/background-agent-permission.ts`：pure policy；
- Query exact-task registry：确认 `agent_id` 是否属于仍在运行的 background task；
- `PermissionRequest` hook：检查 MCP enablement，再继承允许 grant 或应用 background policy。

无法确认 background identity 时 passthrough，让 SDK 保持默认拒绝方向；不能猜测为前台或自动放行。

## 用户确认 lifecycle

SDK `canUseTool.mcpServer` 与 hook `mcp_server` 是工具服务来源的事实。只有 `source: sdk` 且处于当前 Query 已安装集合的 context-injected MCP 才能走应用内置信任入口；同名 plugin/project/dynamic 或缺失来源不能继承。MCP Session grant 按工具名、server 原名和 source 隔离；enablement 仍由原 MCP policy 裁决。PreToolUse 在 bypass 下同样阻止禁用服务和冒用保留名。

插件 MCP 的启用由当前 Query 的 `Options.plugins` 管理，不套用独立的用户 MCP 选择列表；仍需经过普通审批和 plan gate，也不能凭同名获得内置信任。桌面的产品 CLI 自动放行只适用于未携带以下单次约束的调用。

`defaultToNo` / `suppressAlwaysAllowRule` 是单次审批约束，保存在 `pendingPermissions` 并通过 SSE、REST replay 投影到 Chat/Companion。受约束请求不复用普通 Session grant 或同名请求级联批准；禁止持久放行时 UI 隐藏该选项，server 也拒绝 `always_allow`（保留请求供重新作答）。`defaultToNo` 把初始焦点落在拒绝按钮，不增加单键允许快捷方式。显式 fullAgency/headless 产品策略保持既有语义。

`pendingPermissions`、`pendingAskUserQuestions` 与 plan interaction map 表示 Query 正在等待用户。它们没有 wall-clock timeout：

- 用户可能长时间阅读或切走应用；
- inactivity watchdog 必须把 pending human interaction 视为合法停顿；
- 请求只由用户回答/取消、SDK AbortSignal、Session reset/stop 或 Query finally drain 结束。

不要给 permission promise 增加任意分钟数 timer。真正需要的边界是所有 terminal path 都能清理 map、解除 listener，并且 late response 不能命中新 Query。

Abort handler 必须先确认 entry 仍 pending，再 reject `AbortError`。如果用户回答与 SDK abort 交错，不能先 resolve deny 再让 SDK生成第二个 `tool_result`。

## AskUserQuestion

`handleAskUserQuestion()` 负责：

1. 复用共享 `normalizeAskUserQuestionInput` 校验 questions、每个 option 与字段类型；省略 `multiSelect` 归一化为单选。无效输入返回可修正的字段错误，不使用用户取消语义；
2. 生成 request ID 并广播到支持的 UI；
3. 注册 abort-aware pending entry；
4. 接收 renderer / native Channel card 的答案；
5. 把 index-keyed UI 答案投影为当前 SDK 读取的 question-text keys；
6. 通过 `updatedInput.answers` 交回 SDK。

用户取消返回 deny + interrupt。当前 host 不支持 native card 时 fail closed，并要求模型用普通文本询问；不能把 request 丢到没有 response route 的 event bus。

Tab 的待回答提问按 `requestId` 去重并 FIFO 展示，支持并行子Agent提问与重连回放；成功/过期只移除匹配项，随后显示下一个。Session边界清空整个队列。无效提问不能退化成普通allow/deny卡片。

Chat 与 Companion 的问答表单保留 `requestId` 和提交 Promise。只有后端明确 `success=true` 才移除对应卡片；失败保留答案、显示错误并恢复操作。旧 request 的回执不能清新问题，取消也必须走对应的产品响应入口。

Permission card 与 AskUserQuestion card 是两种协议：前者回答 allow/deny，后者返回结构化答案。不得复用 payload shape 或 response endpoint。

## SSE 与 UI 投影

新增权限、问答或 plan 事件时必须同步：

- Sidecar broadcaster；
- Renderer `SseConnection` event allowlist；
- Tab / Floating / Channel 对应 reducer；
- response API 与 abort cleanup；
- Session 切换、unmount 和 reconnect 行为。

只在 server emit 一个新 event 会被前端白名单静默丢弃。

## 修改与验证

改权限逻辑时至少验证：

- 每个产品 mode 到 SDK mode 的映射；
- allow 都携带正确 `updatedInput`；
- plan hard gate 在 `canUseTool` 被跳过时仍拒绝写工具；
- background `PermissionRequest` 的 confirmed / unknown identity、MCP disabled 和 grant；
- AskUserQuestion answer mapping、cancel、abort 与 response/abort race；
- pending interaction 不触发 inactivity failure，所有 Query terminal path 会 drain；
- 不支持 native interaction 的 Channel 不产生悬空请求；
- SSE allowlist 和各 UI surface 能消费对应事件。

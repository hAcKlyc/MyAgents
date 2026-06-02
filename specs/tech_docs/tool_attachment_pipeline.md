# Tool Attachment 一等公民管道

> AI 运行时（Codex / builtin / 未来 Gemini / CC）产出的富媒体（图片为主，预留音频/PDF）走同一条
> `UnifiedEvent.tool_result.attachments[]` 通道，前端用单一 `ToolAttachmentGallery` 组件渲染。
>
> 引入版本：v0.2.15。Codex Runtime 先接入；v0.2.27 已接入 builtin SDK 的 MCP/SDK image
> `tool_result.content[]`。Gemini / CC Runtime 接入留后续版本。
>
> 设计 PRD：`specs/prd/prd_0.2.15_codex_tool_outputs_normalization.md`（本地存档，未入 git）。

---

## 1. 为什么需要

老路径"按工具名前缀分发到专门组件 + tool result 文本写 filePath 字符串再前端正则解析"只为内置
`mcp__gemini-image__*` 单点写。Codex 接入 OpenAI 官方 `image_generation`（不叫 `mcp__gemini-image__*`）
后图片完全不渲染——`codex.ts::parseNotification` 在 `imageGeneration` 完成事件上只读了
`revisedPrompt/status`，把真正的 `result`（base64 图片字节）和 `savedPath`（Codex v0.117+ 自动落盘的
绝对路径）丢了。同类问题在 `mcpToolCall.result.content[]` 含 MCP `image` ContentBlock、
`dynamicToolCall.contentItems[]` 含 `inputImage{imageUrl}` 路径也存在。

归一化要解决：

- 任意 runtime、任意工具产图，**前端组件改样式不需要改后端**
- 大图（base64 ≥ 数 MB）**不进 SSE / IPC JSON**（CLAUDE.md 红线：>256KB payload 走引用而非内联）
- 异步落盘**不阻塞** SSE 流（同 turn 多图不出现 head-of-line block）
- session resume / sidecar restart 后历史回放图片**仍能渲染**

---

## 2. 数据流

```
                            ┌─────────────────────────────┐
                            │ Codex CLI (app-server)       │
                            │ item/completed:              │
                            │   imageGeneration            │
                            │   { result: <b64>,           │
                            │     savedPath: <abs path>,   │
                            │     revisedPrompt: ... }     │
                            └────────────┬─────────────────┘
                                         │ JSON-RPC notification
                                         ▼
           ┌─────────────────────────────────────────────────────┐
           │ codex.ts::parseNotification (Sidecar)               │
           │                                                     │
           │  scheduleAttachmentSave(source, ctx, asyncEmit)     │
           │  ├── makePlaceholderAttachment → pendingId          │
           │  └── trackInFlightSave(promise)                     │
           │      └── saveToolAttachment(...)  (async)           │
           │          ├── base64: 落盘到 ~/.myagents/generated/  │
           │          │       tool-attachments/<sid>/<tid>/      │
           │          ├── externalPath: 零拷贝引用 + register     │
           │          └── url: cancellableFetch (https-only) +   │
           │                  落盘                                │
           │                                                     │
           │  return UnifiedEvent.tool_result {                  │
           │    content: revisedPrompt,                          │
           │    attachments: [placeholder]   ← refPath: '',      │
           │  }                                  pendingId        │
           └──────────────┬──────────────────────────────────────┘
                          │ UnifiedEvent
                          ▼
           ┌──────────────────────────────────────────────────┐
           │ external-session.ts::handleUnifiedEvent          │
           │   case 'tool_result':                            │
           │     broadcast 'chat:tool-result-start/complete'  │
           │       payload includes attachments[]             │
           │     PersistContentBlock.tool.attachments = [...] │
           │   case 'tool_attachment_update':                 │
           │     patch matching pendingId in attachments[]    │
           │     broadcast 'chat:tool-attachment-update'      │
           │     (saved to disk via same currentContentBlocks)│
           │                                                  │
           │ persistTurnResult():                             │
           │   await awaitInFlightSaves() ← drains async      │
           │   JSON.stringify(currentContentBlocks) → 写盘    │
           └──────────────┬───────────────────────────────────┘
                          │ SSE
                          ▼
           ┌──────────────────────────────────────────────────┐
           │ TabProvider.tsx                                  │
           │   case 'chat:tool-result-start/complete':        │
           │     mergeAttachmentsByPendingId(existing, in)    │
           │     → 不覆盖已 patched 的 entry                  │
           │   case 'chat:tool-attachment-update':            │
           │     replace by pendingId in streamingMessage     │
           │                                                  │
           │ history hydration:                               │
           │   PersistContentBlock → ContentBlock[] →         │
           │   ToolUseSimple.attachments transparent          │
           └──────────────┬───────────────────────────────────┘
                          │ React state
                          ▼
           ┌──────────────────────────────────────────────────┐
           │ ToolUse.tsx                                      │
           │   baseRender = <BashTool|EditTool|...>           │
           │   showGallery = tool.attachments?.length > 0     │
           │                 && !ownsGallery(tool.name)       │
           │   → render: {baseRender}                         │
           │             {showGallery && <Gallery/>}          │
           │                                                  │
           │ ToolAttachmentGallery → ToolImageAttachment      │
           │   useAttachmentUrl(attachment, sessionId)        │
           │     state: pending | loading | ready | error     │
           │     ready:   <img src={baseUrl + refPath}>       │
           │     pending: loading skeleton                    │
           │     error:   "⚠️ Image failed: <code>"            │
           └──────────────┬───────────────────────────────────┘
                          │ HTTP GET
                          ▼
           ┌──────────────────────────────────────────────────┐
           │ Sidecar /api/attachment/tool/<sid>/<tid>/<file>  │
           │   1. Sanity check (no ../, no control chars)     │
           │   2. lookupExternalAttachment(sid, tid, file)    │
           │      hit → Codex savedPath (zero-copy)           │
           │   3. miss → trusted root <gen>/<sid>/<tid>/<file>│
           │   4. validateExternalReadPathNode (blacklist)    │
           │   5. fileResponse with CORS + cache-control      │
           └──────────────────────────────────────────────────┘
```

---

## 3. 核心类型

`src/shared/types/tool-attachment.ts`：

```typescript
export interface ToolAttachment {
  kind: 'image' | 'audio' | 'pdf' | 'file';
  mimeType: string;
  /** 相对路径形态 `/api/attachment/tool/<sid>/<tid>/<file>` — 前端运行时拼当前 sidecar baseUrl。
   *  不存绝对 URL：sidecar 端口 dynamic，session resume 后端口已变。 */
  refPath: string;
  /** 落盘绝对路径，仅 sessionOwner sidecar 写。 */
  savedPath?: string;
  sizeBytes?: number;
  width?: number;
  height?: number;
  /** 4KB 硬上限 — 防 unbounded 入侵 SSE 256KB 红线。 */
  caption?: string;
  producedBy?: string;
  /** Placeholder 占位 ID — 异步落盘期间先 emit 占位 attachment，
   *  落盘完成后通过 chat:tool-attachment-update 替换。 */
  pendingId?: string;
}
```

UnifiedEvent 扩展：

```typescript
| { kind: 'tool_result';
    toolUseId, content, isError, metadata,
    attachments?: ToolAttachment[];                 // 新增
  }
| { kind: 'tool_attachment_update';                 // 新增
    toolUseId; pendingId; attachment: ToolAttachment;
  }
```

---

## 4. 安全模型

落盘和路径校验有 5 层防护：

| 层 | 位置 | 防的攻击 |
|---|---|---|
| Node path-safety 黑名单 | `src/server/utils/path-safety.ts::validateExternalReadPathNode` | `/etc/passwd`、`~/.ssh/id_rsa` 等系统/凭据目录 |
| Canonicalize symlinks（读侧） | 同上，`canonicalizeSymlinks:true` | `~/.codex/evil.png → /etc/passwd` symlink 逃逸 |
| 拒绝 symlink leaf | `lstatSync.isSymbolicLink()` | 防范 fs.realpath 行为漂移 |
| Positive allow-list | `tool-attachments.ts::isAllowedExternalAttachmentPrefix` | 拒绝引用 `~/Documents/secrets.docx` 等"既不在黑名单也不该读"的路径；只允许 `~/.codex/` `~/.myagents/` `~/Documents/` `~/Desktop/` `~/Downloads/` 及子目录 |
| Trusted root（写侧） | `validateTrustedAttachmentRoot` | 禁止把 base64 落盘写到 attachment root 之外 |

URL 下载额外防 SSRF：

- 限定 `https:` scheme；`http:` / `file:` / 自定义 scheme 拒绝
- 拒绝 `localhost` / `127.0.0.1` / `0.0.0.0` / `::1`
- 拒绝 RFC 1918 私网（`10/8`、`192.168/16`、`172.16/12`）
- 拒绝 `169.254/16` 链路本地（AWS/GCP/Azure metadata service）
- 拒绝 IPv6 ULA / link-local（`fc00:` / `fd*:` / `fe80:`）
- `redirect: 'error'` — 拒绝跨 scheme/host 跳转
- `cancellableFetch` 30s timeout

错误暴露面：`makeErrorAttachment(ctx, err, pendingId)` 把 throw 映射到固定 enum
（`too_large` / `rejected_path` / `not_found` / `fetch_failed` / `unsupported_url` /
`decode_failed` / `unknown`），refPath 形如 `error://<code>`。**raw error.message
不进 SSE / 不写 SessionStore**——绝对路径 / `~/.codex/sessions/<id>` 等敏感信息只
留在 server log。

---

## 5. 异步落盘 & Placeholder 生命周期

`scheduleAttachmentSave` 是 fire-and-forget — 落盘走 await 但不阻塞 `parseNotification` 返回：

1. parseNotification 同步返回 `tool_result` event，attachments = `[placeholder]`
2. external-session 立即 broadcast `chat:tool-result-start/complete`，渲染器显示 loading 骨架
3. 异步落盘成功 → `asyncEmit({ kind:'tool_attachment_update', pendingId, attachment: real })`
4. external-session 更新 `currentContentBlocks` 中匹配 pendingId 的 entry，broadcast SSE update
5. TabProvider 在 streamingMessage 中按 pendingId 替换占位 → 骨架变成图片

**关键守卫**：`persistTurnResult` 进入即 `await awaitInFlightSaves()`，保证所有 in-flight
落盘完成后再 `JSON.stringify(currentContentBlocks)` 写盘——避免"placeholder 飞越 turn boundary
落到磁盘永远 stranded"。session resume 时反查 PersistContentBlock attachments，调
`rebuildAttachmentRegistryFromBlocks` 把 Codex savedPath 重新 register 进 in-process map。

---

## 6. 前端归一化原则

`ToolUse.tsx` 在 specialized tool body 渲染**之后**外挂统一 `ToolAttachmentGallery`：

```tsx
return (
  <>
    {baseRender}                                                // BashTool / EditTool / ...
    {showGallery && <ToolAttachmentGallery attachments={...}/>} // 自动渲染 image/audio/...
  </>
);
```

例外：`TOOLS_THAT_OWN_GALLERY_PREFIXES = ['mcp__gemini-image__']`。这条规则是兜底——老
GeminiImageTool 仍走 filePath 文本协议自渲染图片；外层 Gallery 跳过，避免双重渲染。等 builtin
runtime (P5) 接入后 GeminiImageTool 也走 attachments，这条 prefix 列表清空，规则自然失效。

`mergeAttachmentsByPendingId` 防 `chat:tool-result-complete` 重发覆盖已 patched 的 entry —
identity key 是 `pendingId || refPath`，若 existing 已 resolved（refPath 非空 + 无 pendingId），
保留 existing，不接受 incoming placeholder 覆盖。

---

## 7. 多 Sidecar 边界

attachment endpoint `/api/attachment/tool/...` 注册在每个 Sidecar 的 HTTP server 上。Sidecar
Owner 模型决定 attachments 由 sessionOwner sidecar 持有：

| Owner | attachment 写入位置 |
|---|---|
| Tab session | Chat Tab Sidecar 的 trusted root + 内存 registry |
| IM Bot session | IM Bot Sidecar 的 trusted root + 内存 registry |
| Cron / Background | 各自 owner Sidecar |
| Handover (scenario 4) | 切到目标 Sidecar 时通过 SessionStore 反查 attachments，调 `rebuildAttachmentRegistryFromBlocks` 重 register |

**out-of-scope（本期不支持）**：A Sidecar 上的 renderer 跨进程 fetch B Sidecar 持有的
attachment。任何触发这种路径的入口视为 bug。

---

## 8. Codex Runtime parseNotification 改造矩阵

基于 Codex v0.128 `codex app-server generate-ts` 生成的 schema（`/tmp/codex-schema/v2/`），
本期补齐 9 个长期被丢弃的字段：

| Codex item.type | 修复内容 |
|---|---|
| `imageGeneration` | 优先 savedPath（零拷贝引用），fallback `result` base64 落盘 |
| `mcpToolCall` | `result.content[]` 走 MCP ContentBlock union（text / image / audio / resource_link）；attachments 收集图片/音频 |
| `dynamicToolCall` | `contentItems[]` 处理 `inputImage{imageUrl}`；namespace / durationMs 透出 |
| `webSearch` | `action` union 全分支（search/openPage/findInPage/other），多 query 显示 |
| `commandExecution` | `commandActions[]`（已 parse 的 read/listFiles/search）+ source 透传 |
| `fileChange` | `status`（inProgress/completed/failed/declined）显式标 `declined`/`failed` 为 isError |
| `collabAgentToolCall` | 多 agent 协作工具卡（之前 default silent drop） |
| `plan` | started → thinking_start，delta 通过 `item/plan/delta` 走 thinking 渲染 |
| `enteredReviewMode` / `exitedReviewMode` / `hookPrompt` | 透出为 log 事件 |

内层 default 分支加 `console.warn` — Codex 升级新增 item 类型时不再 silent drop。

---

## 9. 关键文件

| 文件 | 职责 |
|---|---|
| `src/shared/types/tool-attachment.ts` | 类型 + 上限常量 |
| `src/server/runtimes/tool-attachments.ts` | `saveToolAttachment` 三入口 + in-flight tracker + external-path registry |
| `src/server/utils/path-safety.ts` | Node 镜像 Rust validate_file_path 黑名单 |
| `src/server/runtimes/codex.ts` | parseNotification 9 case 改造 + scheduleAttachmentSave |
| `src/server/runtimes/external-session.ts` | tool_result attachments 写持久化；tool_attachment_update SSE 转发；session resume 重 register |
| `src/server/index.ts` | `/api/attachment/tool/<sid>/<tid>/<file>` endpoint |
| `src/renderer/utils/toolAttachment.ts` | `useAttachmentUrl` hook + `resolveToolAttachmentUrl` |
| `src/renderer/components/tools/ToolAttachmentGallery.tsx` | 归一化容器 |
| `src/renderer/components/tools/ToolImageAttachment.tsx` | 单张图片渲染 + placeholder / error 状态 |
| `src/renderer/components/ToolUse.tsx` | Gallery 外挂 + `TOOLS_THAT_OWN_GALLERY_PREFIXES` |
| `src/renderer/context/TabProvider.tsx` | SSE 事件处理 + `mergeAttachmentsByPendingId` |

---

## 10. 后续 Phase（v0.2.16+）

- **已完成 v0.2.27 — builtin SDK image content**：`agent-session.ts` 通过
  `utils/tool-result-attachments.ts` array-aware 处理 SDK / MCP 返回的 `content[]` 中
  `type:'image'` ContentBlock，调用 `saveToolAttachment` → attachments。
  旧 `gemini-image-tool.ts` filePath 文本协议退役仍需单独跟进。
- **Gemini / CC Runtime tool image**：协议层就位，对应 Runtime parseNotification 改造接入
- **IM Bot 媒体下发**：tool_result 转发链路消费 attachments，把图片送达 Telegram / 飞书 / 微信
- **GC / size limits**：session 软删除时清理 `~/.myagents/generated/tool-attachments/<sid>/`；
  per-session attachment 上限（500）+ oldest-first 淘汰
- **Node ↔ Rust 黑名单同步测试**：PRD 7.2 承诺的 cross-check 测试（防 Rust 改了 Node 没跟）

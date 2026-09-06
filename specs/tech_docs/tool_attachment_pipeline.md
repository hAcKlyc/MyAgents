# Tool Attachment 管道

## 文档职责

本文描述 Runtime 工具产物进入 MyAgents 消息、持久化和 WebView 数据面的当前契约。历史接入过程和未来能力不属于本文。

`ToolAttachment` wire 与 Renderer 都是 Runtime-neutral；当前生产者包括 builtin Claude Agent SDK 和 Codex。没有产物映射的 Runtime 不伪造附件。

## Owner 与数据流

```text
Runtime tool result
  → Runtime adapter 提取 attachment source
  → Session Sidecar 保存或登记产物
  → ToolAttachment refPath
  → normalized tool_result / attachment update event
  → Session transcript 保存引用
  → Renderer ToolAttachmentGallery
  → app-owned resource protocol
  → Rust 转发到当前 Session Sidecar attachment endpoint
```

Owner 分工：

| 事实 | Owner |
|------|-------|
| Runtime 原始 result 的解释 | 对应 Runtime adapter |
| attachment source 校验、保存与 external-path registry | `src/server/runtimes/tool-attachments.ts` |
| builtin 媒体提取和双写 | `builtin-media-attachments.ts` + `agent-session.ts` |
| external streaming content 与 nested sub-agent attachment | `external-session/content-blocks.ts` |
| Product Session 持久引用 | SessionStore transcript |
| WebView URL 投影 | `myagentsProtocol.ts` + Rust `attachment_protocol.rs` |
| 展示 | `ToolAttachmentGallery` 及 kind-specific component |

Sidecar 只拥有本 Session 的 attachment registry。跨 Session 或跨 Sidecar 读取必须拒绝；Renderer 不能从 `savedPath` 直接读取文件。

## 当前 source 形态

`saveToolAttachment()` 接受三类来源：

- `base64`：解码后写入 trusted root。
- `externalPath`：通过路径策略校验后登记原文件，不复制字节。
- `url`：通过受控 HTTPS 下载写入 trusted root。

Builtin tool result 还会从结构化 image block、data URL、file ref 和受支持的工具结果文本中提取媒体。可交付原件写入工作区 `myagents_files/<tool>/`；trusted-root 副本用于稳定渲染和 Sidecar restart 后恢复。没有工作区的执行使用 App-owned generated root。

Builtin SDK 同时提供模型侧 `tool_result.content` 和辅助 `tool_use_result`。后者也可能含 Read 的 image/PDF 字节，不能在提取前者后再原样序列化辅助结果。`extractSdkToolResultRenderParts()` 在分发到主 Agent / sub-agent 前统一转换两种表示：保留可解析的结构化结果、移除明确媒体字段中的内联字节，并延续 `_meta` envelope 的显示隔离。辅助结果中的普通 Read/Bash/search 文本不得套用未知块的 base64 猜测规则，否则 `data:` 开头的 YAML 或长字母序列会被误删。SDK 0.3.243+ PDF 分页图片从 `tool_result.content` 提取；完整 PDF 文档块只保留脱敏文本，不额外创建卡片。已持久化的历史结果不在此入口重写。

Codex adapter 从 `imageGeneration`、`mcpToolCall`、`dynamicToolCall` 等原生 item 提取附件；Runtime schema 的完整事件映射由 `src/server/runtimes/codex.ts` 和对应协议测试维护，不在文档复制字段清单。

## Wire 与持久化

权威类型在 `src/shared/types/tool-attachment.ts`：

```ts
interface ToolAttachment {
  kind: 'image' | 'audio' | 'pdf' | 'file';
  mimeType: string;
  refPath: string;
  savedPath?: string;
  sourcePath?: string;
  sizeBytes?: number;
  width?: number;
  height?: number;
  caption?: string;
  producedBy?: string;
  pendingId?: string;
  presentation?: 'artifact' | 'process';
}
```

必须遵守以下边界：

- `refPath` 是 `/api/attachment/tool/<sessionId>/<turnId>/<filename>` 形态的相对引用；Session 数据不保存端口或绝对资源 URL。
- `savedPath` 只供 Sidecar registry 恢复和受控 Rust 导出使用，不授予 Renderer 文件读取权限。
- `sourcePath` 表示用户可见的原始产物位置；reveal/open 动作仍须重新经过 workspace/file safety owner。
- `pendingId` 只标识一次异步保存；resolved attachment 以真实 `refPath` 取代 placeholder。
- `presentation` 缺失等价 `artifact`；`process` 用于截图等过程产物，不改变持久化或安全语义。
- 单附件上限由共享常量定义为 25 MiB。caption 当前通过 JavaScript `String.length` / `slice` 限制为 4096 个 UTF-16 code units；常量名中的 `BYTES` 不代表 UTF-8 字节数。

Session transcript 只保存附件 metadata 和 path 引用，不保存图片或音频字节。结构化 result 中的内联大载荷必须在进入 SSE/JSONL 前提取或省略；模型自己的 native transcript 不由这条产品存储规则改写。

## 异步保存与 Turn 边界

Codex 的大载荷保存不阻塞原始 Runtime notification：

1. adapter 生成带 `pendingId` 的 placeholder，并登记 in-flight save；
2. `tool_result` 先进入 streaming content 和 Renderer；
3. 保存完成后发出 attachment update，以 `pendingId` 精确替换；
4. root 或 nested sub-agent content owner 同步更新自己的 attachment；
5. Turn 持久化前 `awaitInFlightSaves()`，保证 placeholder 不跨过 terminal 写盘。

顶层更新使用 `chat:tool-attachment-update`；nested sub-agent 更新使用 `chat:subagent-tool-attachment-update`。两者都必须在 SSE JSON 白名单，并按当前 Session scope 处理。

Builtin 的结构化媒体在 tool result commit 路径完成保存后再写入 tool block，不建立第二套 placeholder owner。

`mergeAttachmentsByPendingId()` 在重复的 tool-result event 与 attachment update 之间保持单调：已 resolved entry 不能被迟到 placeholder 覆盖。

## Sidecar restart 与历史恢复

Session Sidecar 启动或恢复历史时，`rebuildAttachmentRegistryFromBlocks()` 从持久 content blocks 重建可验证的 external-path registry。重建只接受本 Session 的合法引用和仍通过当前路径策略的文件；失效、被拒绝或只有 `error://` sentinel 的旧条目保持不可用，不绕过安全校验。

Attachment endpoint 先解析并验证 Session/Turn/filename，再查询 registry；未命中时只允许从 trusted root 读取。响应使用受控 MIME、CORS 与 immutable cache policy。

## WebView 资源协议

Renderer 通过 `resolveTauriToolAttachmentUrl()` 把相对 `refPath` 映射为：

- macOS/Linux：`myagents-resource://tool-attachment/<session>/<turn>/<file>`
- Windows/WebView2：`http://myagents-resource.localhost/tool-attachment/<session>/<turn>/<file>`
- Browser development：保持 `/api/attachment/tool/...`，由开发代理处理

`myagents://attachment` 与 `myagents://tool-attachment` 只在历史内容规范化边界兼容；新内容不得生成旧 scheme。资源 URL 解析不是 AppRoute 解析，二者不能共用入口。

## 展示契约

`ToolAttachmentGallery` 是附件类型的统一 Renderer：

- `artifact` 附件在对应 message block group 后作为独立内容展示。
- `process` 附件在 `ProcessRow` 展开内容中展示，折叠状态只影响可见性，不影响数据。
- nested sub-agent attachment 保存在 `subagentCalls[]`，由 `TaskTool` 内对应调用展示，不提升到父级避免重复。
- placeholder 显示 loading；`error://<code>` 只显示固定错误类别，不暴露 raw error。

特殊工具组件可以显示自己的文字 metadata，但不得再次渲染同一媒体或从结果文本正则恢复第二份附件。

### 音频播放资源生命周期

附件音频的播放 owner 是 Renderer `audioPlayer.ts` 单例；消息行只订阅状态，因此虚拟列表回收行不停止用户主动播放的音频。暂停保留 element、URL 和 position，结束、错误、`play()` 拒绝、显式停止则统一经过 `stopAudio()`：先摘除 listener，再 pause、移除 `src`、`load()` 重置媒体资源，最后撤销 blob URL 并清空状态。只清除 UI 的 path 或撤销 blob URL 不会卸载已加载的媒体元素。

Settings TTS 试听由设置弹窗自身持有，`useTtsPreview` 只是其局部 lifecycle 实现，不复用附件单例。一次试听的 synthesis request、blob URL、media element 和 `play()` Promise 属于同一 operation。关闭、卸载或修改试听配置时立即使 operation 失效并释放媒体；旧请求完成、旧媒体事件、旧 `play()` Promise 均不得创建播放器、修改新试听状态或显示过期错误。现有 `apiPostJson` transport 不支持取消请求，因此在异步边界撤销后续播放资格；不增加通信模式，也不把后端合成完成等同于仍有播放许可。

回归测试见 `audioPlayer.test.tsx` 与 `useTtsPreview.test.tsx`；覆盖终态资源释放、暂停/恢复保留位置、关闭期间异步返回、重新打开后的旧回调，以及 StrictMode setup/cleanup。

## 安全不变量

### 本地路径

- 先经过 Node path-safety blacklist，再 canonicalize symlink，拒绝 symlink leaf。
- external path 还必须命中允许的用户产物根；blacklist 通过不等于可读取。
- base64/url 只写入经过验证的 trusted root，filename 和 Session/Turn segment 必须 sanitize。
- 每次读取、导出、reveal 和 open 都在动作边界重新校验，不信任历史 metadata。

### 外部 URL

- 只允许 HTTPS。
- DNS 解析后的所有地址都必须拒绝 loopback、私网、link-local 和 IPv6 ULA/link-local。
- 请求通过 per-request undici dispatcher 固定到已验证地址，并拒绝 redirect，防 DNS rebinding。
- body 流式累计；无论是否存在 `Content-Length` 都执行相同字节上限。
- `downloadAndSaveUrl()` 使用 `withAbortSignal` 组合取消与 timeout。这里不能替换为不支持 per-request dispatcher 的通用 fetch wrapper，否则会丢失 DNS pinning。

### 错误投影

保存错误只映射为固定 code，如 `too_large`、`rejected_path`、`not_found`、`fetch_failed`、`unsupported_url` 和 `decode_failed`。raw error、绝对路径、credential 路径与响应正文只能留在受控的有界 server log。

## 关键文件

| 文件 | 职责 |
|------|------|
| `src/shared/types/tool-attachment.ts` | wire 类型与上限 |
| `src/server/runtimes/tool-attachments.ts` | source 保存、SSRF、registry 与 in-flight tracker |
| `src/server/runtimes/builtin-media-attachments.ts` | builtin result 媒体提取和保存 |
| `src/server/utils/tool-result-attachments.ts` | builtin 结构化 result 归一化 |
| `src/server/runtimes/codex.ts` | Codex 原生 item → normalized attachment |
| `src/server/runtimes/external-session/content-blocks.ts` | 顶层与 nested streaming content owner |
| `src/server/index.ts` | Session Sidecar attachment endpoint |
| `src-tauri/src/attachment_protocol.rs` | app-owned resource protocol 与 current Sidecar resolution |
| `src-tauri/src/workspace_files/attachment_export.rs` | 受控读取与导出 |
| `src/renderer/utils/toolAttachment.ts` | refPath 验证与 WebView URL 投影 |
| `src/renderer/utils/myagentsProtocol.ts` | 当前与历史 resource scheme 规范化 |
| `src/renderer/components/tools/ToolAttachmentGallery.tsx` | 统一展示入口 |
| `src/renderer/context/TabProvider.tsx` | 顶层 SSE attachment merge |
| `src/renderer/components/tools/TaskTool.tsx` | nested sub-agent attachment 展示 |

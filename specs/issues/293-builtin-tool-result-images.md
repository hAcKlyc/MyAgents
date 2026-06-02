---
issue: 293
url: https://github.com/hAcKlyc/MyAgents/issues/293
reporter: "@Helix3781"
created: 2026-06-02
processed: 2026-06-02 16:19 Asia/Shanghai
type: bug
status: fixed
---

# AI 生成的图片在聊天界面不显示

## Issue 概述

Reporter is on v0.2.26 / Windows 10 using the builtin Claude Agent SDK runtime with MCP Playwright screenshots. Tool execution completes and `chat:tool-result-complete` reaches the frontend, but the chat UI does not render the generated screenshot/image. User-uploaded images still render normally.

## Root Cause

Builtin SDK tool results were still treated as text. `agent-session.ts` received SDK `tool_result.content[]` blocks such as MCP `ImageContent` (`{ type: "image", data, mimeType }`), but non-string content was only `JSON.stringify`-ed. No `ToolAttachment[]` was produced, no `saveToolAttachment(...)` call happened, and no `attachments` field was sent on `chat:tool-result-start` / `chat:tool-result-complete`.

Playwright made the symptom stronger: its raw tool-result payload is intentionally replaced with `[playwright_result_stripped]` to avoid huge SSE/persistence payloads. Without extracting the image into an attachment first, that stripping hid the only image data from the renderer.

## Fix

- Added `src/server/utils/tool-result-attachments.ts` to parse SDK/MCP image tool-result shapes into attachment sources while redacting base64 from fallback text.
- Added `ToolUseState.attachments` for builtin SDK tool cards.
- Wired builtin `agent-session.ts` to:
  - emit placeholder attachments immediately;
  - save image bytes through the existing trusted `saveToolAttachment(...)` pipeline;
  - broadcast `chat:tool-attachment-update` when saves complete;
  - wait for in-flight attachment saves before persisting message history.
- Preserved existing WebSearch structured-result text behavior.

## Verification

- `npm run test:unit -- src/server/utils/tool-result-attachments.unit.test.ts src/renderer/utils/optionResolve.test.ts`
- `npm run test:unit`
- `npm run typecheck`
- `npm run lint`

`npm run lint` passed with the existing dependency-cruiser warning for `src/renderer/constants/chatSuggestions.ts`.

## GitHub Handling

Label `bug`; comment with root cause/fix/verification; close as completed after commit/push.

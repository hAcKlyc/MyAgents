# SSE 状态同步与新会话机制

## 背景

MyAgents 采用 SSE (Server-Sent Events) 实现前后端实时通信。当 SSE 连接断开并重连时，后端会重放当前会话的所有消息。这带来了一个问题：如果用户在前端点击「新对话」，但后端不知道，SSE 重连时会把旧消息发回来。

## 问题场景

```
1. 用户正在对话，messages = [msg1, msg2, msg3]
2. 用户点击「新对话」→ 前端清空 messages = []
3. SSE 连接断开（网络波动、超时等）
4. SSE 重连 → 后端发送 chat:message-replay 事件
5. 前端收到旧消息 → messages = [msg1, msg2, msg3]  ← BUG!
```

**根本原因**：前后端状态不同步。前端认为是新会话，后端仍持有旧会话数据。

## 解决方案

### 1. 前后端同步重置

点击「新对话」时，前端调用 `/chat/reset` API，后端同步重置：

```typescript
// TabProvider.tsx
const resetSession = useCallback(async (): Promise<boolean> => {
    // 1. 立即清理前端状态
    setMessages([]);
    seenIdsRef.current.clear();
    isNewSessionRef.current = true;  // 防护标志

    // 2. 通知后端重置
    const response = await postJson('/chat/reset');
    return response.success;
}, [postJson]);
```

```typescript
// agent-session.ts
export async function resetSession(): Promise<void> {
    // 1. 中断进行中的响应
    if (querySession) {
        await querySession.interrupt();
    }

    // 2. 清空消息
    clearMessageState();

    // 3. 生成新 sessionId
    sessionId = randomUUID();

    // 4. 清理权限
    clearSessionPermissions();

    // 5. 广播新状态
    broadcast('chat:init', { ... });
}
```

### 2. 防护标志 (Defense in Depth)

即使有同步重置，仍可能存在竞态条件（如 API 调用期间 SSE 事件到达）。使用 `isNewSessionRef` 作为额外防护：

```typescript
// 新会话期间，跳过所有可能带来旧数据的事件
case 'chat:init':
case 'chat:message-replay':
case 'chat:message-chunk':
case 'chat:thinking-start':
case 'chat:tool-use-start':
    if (isNewSessionRef.current) {
        console.log('[TabProvider] Skipping event (new session)');
        break;
    }
    // 正常处理...
```

### 3. 标志重置时机

`isNewSessionRef` 必须在 **API 调用之前** 重置，而不是等返回后：

```typescript
// sendMessage 开始时就重置，而不是等 API 返回
const sendMessage = async (text) => {
    isNewSessionRef.current = false;  // ← 必须在这里！

    const response = await postJson('/chat/send', { text });
    // 此时 chat:message-replay 已经到达并被正确处理
    return response.success;
};
```

**为什么不能等 API 返回后？**

```
时序问题：
1. sendMessage() 开始
2. POST /chat/send 发出 (异步)
3. 后端收到消息，存入 messages
4. 后端发送 chat:message-replay 事件 (用户消息)  ← 此时 API 还没返回！
5. 如果 isNewSessionRef 还是 true，用户消息被过滤
6. API 返回，才重置 isNewSessionRef = false
7. AI 回复正常，但用户消息已丢失

正确做法：
1. sendMessage() 开始
2. isNewSessionRef = false  ← 在这里重置
3. POST /chat/send 发出 (异步)
4. chat:message-replay 到达 → 用户消息正常显示
5. API 返回
6. AI 回复正常
```

## 时序图

```
用户点击「新对话」
       │
       ▼
┌──────────────────────────────────────────────────────┐
│ resetSession()                                       │
│  ├─ setMessages([])                                  │
│  ├─ isNewSessionRef = true  ◄── 防护开启            │
│  └─ POST /chat/reset                                 │
│         │                                            │
│         ▼                                            │
│    Backend: resetSession()                           │
│      ├─ interrupt()                                  │
│      ├─ messages = []                                │
│      ├─ sessionId = newUUID()                        │
│      └─ broadcast('chat:init')                       │
│              │                                       │
│              ▼                                       │
│    [SSE 事件被 isNewSessionRef 过滤]                 │
└──────────────────────────────────────────────────────┘
       │
       ▼
用户发送新消息
       │
       ▼
┌──────────────────────────────────────────────────────┐
│ sendMessage()                                        │
│  ├─ isNewSessionRef = false  ◄── 防护关闭 (先!)     │
│  ├─ POST /chat/send (异步)                           │
│  │        │                                          │
│  │        ├─ Backend 收到消息                        │
│  │        ├─ chat:message-replay (用户消息)          │
│  │        │       └─ 正常显示 ✓                      │
│  │        └─ AI 开始回复...                          │
│  └─ API 返回                                         │
└──────────────────────────────────────────────────────┘
```

## API 设计

### POST /chat/reset

重置当前会话，用于「新对话」功能。

**请求**：无参数

**响应**：
```json
{ "success": true }
```

**后端行为**：
1. 中断任何进行中的 AI 响应
2. 清空 messages 数组
3. 生成新 sessionId
4. 清空权限缓存
5. 广播 chat:init 事件

## 关键原则

1. **状态同步是必须的**：不要只清理前端或只清理后端
2. **防护标志是防御性的**：即使同步逻辑正确，仍保留额外检查
3. **单一入口**：只有 `resetSession()` 可以开始新会话，避免多处修改状态
4. **标志管理**：在明确的时机设置和重置标志，避免状态混乱

## 常见问题

### Q: 为什么不直接断开 SSE 再重连？

断开重连会导致：
1. 用户感知到连接中断
2. 重连期间可能丢失事件
3. 增加服务端连接压力

### Q: 为什么需要 isNewSessionRef？

作为防御性编程：
1. API 调用是异步的，期间可能收到旧事件
2. 网络延迟可能导致事件乱序
3. 代码重构时容易遗漏同步逻辑

### Q: 标志何时重置？

在 `sendMessage` **开始时**（API 调用之前）。这确保：
1. `chat:message-replay` 事件能正常显示用户消息
2. 新的 AI 响应可以正常显示
3. 时序正确：标志重置 → API 调用 → SSE 事件到达

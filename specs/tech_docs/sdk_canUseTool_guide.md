# Claude Agent SDK: canUseTool 回调实现指南

> 本文档记录了在 MyAgents 中实现人工干预工具权限（Human-in-the-Loop）时的关键发现和最佳实践。

## 核心概念

`canUseTool` 是 Claude Agent SDK 提供的回调，允许在 Agent 调用工具前进行权限检查。

## 关键配置

### permissionMode 与 canUseTool 的关系

| permissionMode | canUseTool 行为 |
|----------------|-----------------|
| `'bypassPermissions'` | ❌ 不调用 |
| `'default'` | ✅ 正常调用 |
| `'plan'` | ✅ 正常调用 |
| `'acceptEdits'` | ✅ 正常调用 |

```typescript
// 正确配置
query({
  options: {
    // 根据业务需求选择模式
    permissionMode: needsPermissionCheck ? 'default' : 'bypassPermissions',
    
    canUseTool: async (toolName, input, options) => {
      // 仅在 permissionMode !== 'bypassPermissions' 时被调用
    }
  }
});
```

## ⚠️ 必须包含 updatedInput

当 `canUseTool` 返回 `allow` 时，**必须**包含 `updatedInput` 字段：

```typescript
// ❌ 错误 - 会导致 ZodError
return { behavior: 'allow' };

// ✅ 正确
return { 
  behavior: 'allow',
  updatedInput: input as Record<string, unknown>
};
```

**错误现象**：
```
ZodError: [
  { "code": "invalid_type", "expected": "record", "received": "undefined" }
]
```

## 异步用户确认模式

实现前端用户确认的完整流程：

```typescript
// 1. 存储 pending 请求
const pendingPermissions = new Map<string, {
  resolve: (decision: 'allow' | 'deny') => void;
  timer: ReturnType<typeof setTimeout>;
}>();

// 2. canUseTool 返回 Promise
canUseTool: async (toolName, input, options) => {
  // 检查规则...
  
  // 需要用户确认时
  const decision = await new Promise<'allow' | 'deny'>((resolve) => {
    const requestId = generateId();
    const timer = setTimeout(() => resolve('deny'), 5 * 60 * 1000);
    
    pendingPermissions.set(requestId, { resolve, timer });
    
    // 发送 SSE 事件到前端
    broadcast('permission:request', { requestId, toolName, input });
    
    // 监听 AbortSignal
    options.signal?.addEventListener('abort', () => {
      cleanup();
      resolve('deny');
    });
  });
  
  return decision === 'allow'
    ? { behavior: 'allow', updatedInput: input }
    : { behavior: 'deny', message: '用户拒绝' };
};

// 3. API 端点处理用户响应
app.post('/api/permission/respond', (req) => {
  const { requestId, decision } = req.body;
  const pending = pendingPermissions.get(requestId);
  if (pending) {
    clearTimeout(pending.timer);  // 清理 timer
    pendingPermissions.delete(requestId);
    pending.resolve(decision === 'deny' ? 'deny' : 'allow');
  }
});
```

## 特殊工具处理：AskUserQuestion

`AskUserQuestion` 是 SDK 内置工具，用于向用户提问。与普通权限检查不同，它需要收集用户答案并通过 `updatedInput` 返回。

### 关键实现要点

```typescript
canUseTool: async (toolName, input, options) => {
  // 1. 检测 AskUserQuestion 工具
  if (toolName === 'AskUserQuestion') {
    // 2. 验证输入结构
    if (!isValidAskUserQuestionInput(input)) {
      return { behavior: 'deny', message: '无效的问题格式' };
    }

    // 3. 广播到前端，等待用户回答
    const answers = await handleAskUserQuestion(input, options.signal);

    // 4. 用户取消 → deny
    if (answers === null) {
      return { behavior: 'deny', message: '用户取消了问答' };
    }

    // 5. 返回带 answers 的 updatedInput
    return {
      behavior: 'allow',
      updatedInput: { ...input, answers }  // ⚠️ 必须包含 answers
    };
  }

  // 其他工具走正常权限检查...
};
```

### 答案格式

SDK 期望的 `answers` 格式：
```typescript
{
  "0": "选项标签",           // 单选
  "1": "标签1,标签2,标签3"   // 多选用逗号分隔
}
```

### 输入验证函数

```typescript
function isValidAskUserQuestionInput(input: unknown): boolean {
  if (!input || typeof input !== 'object') return false;
  const obj = input as Record<string, unknown>;
  if (!Array.isArray(obj.questions) || obj.questions.length === 0) return false;

  return obj.questions.every((q: unknown) => {
    if (!q || typeof q !== 'object') return false;
    const question = q as Record<string, unknown>;
    return (
      typeof question.question === 'string' &&
      typeof question.header === 'string' &&
      Array.isArray(question.options) &&
      question.options.length >= 2 &&
      typeof question.multiSelect === 'boolean'
    );
  });
}
```

### 与 Permission 处理的区别

| 方面 | Permission | AskUserQuestion |
|------|-----------|-----------------|
| 返回值 | `'allow'` / `'deny'` | `answers` / `null` |
| updatedInput | 原样返回 | 必须添加 `answers` 字段 |
| 超时时间 | 5 分钟 | 10 分钟（用户需要思考） |
| 用途 | 权限控制 | 收集用户输入 |

## 最佳实践

1. **始终处理 AbortSignal** - SDK 可能在任何时候中止请求
2. **设置超时** - 防止无限等待用户响应
3. **清理 Timer** - 用户响应后立即清理，避免内存泄漏
4. **日志分级** - 内部机制用 `debug`，用户操作用 `info`
5. **输入验证** - 对 AskUserQuestion 等复杂工具，验证输入结构
6. **共享类型** - 前后端使用共享类型定义，避免重复和不一致

## ⚠️ 常见问题：SSE 事件白名单

新增 SSE 事件时，必须同时更新 `src/renderer/api/SseConnection.ts` 中的事件白名单：

```typescript
// src/renderer/api/SseConnection.ts
const JSON_EVENTS = new Set([
    // ... 其他事件
    'permission:request',
    'ask-user-question:request',  // ← 新事件必须加到这里
]);
```

**症状**：后端 `broadcast()` 正常执行，但前端收不到事件，UI 不响应。

**原因**：`SseConnection` 只为白名单中的事件注册监听器，未注册的事件会被静默忽略。

**检查步骤**：
1. 确认后端日志显示 broadcast 已执行
2. 确认前端 TabProvider 的 switch case 中没有收到日志
3. 检查 `SseConnection.ts` 的 `JSON_EVENTS` / `STRING_EVENTS` / `NULL_EVENTS`

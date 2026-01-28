# 第三方 LLM 供应商集成指南

本文档总结了在 MyAgents 中集成第三方 LLM 供应商（DeepSeek、智谱、Moonshot、MiniMax 等）的关键技术经验。

---

## 核心原理

Claude Agent SDK 支持通过环境变量配置第三方 API：

| 环境变量 | 作用 |
|----------|------|
| `ANTHROPIC_BASE_URL` | API 端点地址 |
| `ANTHROPIC_AUTH_TOKEN` | API 认证令牌 |
| `ANTHROPIC_API_KEY` | API 密钥（SDK 可能使用此变量）|
| `ANTHROPIC_MODEL` | 默认模型 ID |

---

## 关键经验

### 1. 环境变量必须同时设置两个 Key 变量

SDK 不同版本可能使用不同的环境变量名，建议同时设置：

```typescript
env.ANTHROPIC_AUTH_TOKEN = apiKey;
env.ANTHROPIC_API_KEY = apiKey;
```

### 2. 切换回官方订阅时必须清除环境变量

问题：切换到第三方后再切回 Anthropic 订阅，如果 `ANTHROPIC_BASE_URL` 仍存在，请求会发到错误的端点。

解决：显式删除环境变量：

```typescript
if (currentProviderEnv?.baseUrl) {
  env.ANTHROPIC_BASE_URL = currentProviderEnv.baseUrl;
} else {
  delete env.ANTHROPIC_BASE_URL; // 关键！
}
```

### 3. API Key 存储与读取

- **存储位置**: `apiKeys[provider.id]`（通过 useConfig 获取）
- **常见错误**: 误用 `provider.apiKey`（始终为 undefined）
- **正确做法**: 

```typescript
const { apiKeys } = useConfig();
const apiKey = apiKeys[currentProvider.id];
```

### 4. Provider 配置结构

```typescript
interface Provider {
  id: string;
  name: string;
  config: {
    baseUrl?: string;  // 第三方 API 端点
  };
  models: ModelEntity[];
  primaryModel: string;
}
```

---

## 预设供应商 BaseURL

| 供应商 | BaseURL | 备注 |
|--------|---------|------|
| DeepSeek | `https://api.deepseek.com/anthropic` | Anthropic 兼容 |
| Moonshot | `https://api.moonshot.cn/anthropic` | Anthropic 兼容 |
| 智谱 AI | `https://open.bigmodel.cn/api/anthropic` | Anthropic 兼容 |
| MiniMax | `https://api.minimaxi.com/anthropic` | Anthropic 兼容 |

> **注意**：所有供应商现在都使用 Anthropic 兼容端点，确保 SDK 正确处理请求格式。

---

## 数据流

```
┌─────────────────────────────────────────────────────────────┐
│ Chat.tsx                                                     │
│  - 从 apiKeys[provider.id] 获取 API Key                     │
│  - 从 provider.config.baseUrl 获取端点                       │
│  - 构建 providerEnv: { baseUrl, apiKey }                    │
└──────────────────────────┬──────────────────────────────────┘
                           │ POST /chat/send
                           ▼
┌─────────────────────────────────────────────────────────────┐
│ server/index.ts                                              │
│  - 解析 providerEnv 并传递给 enqueueUserMessage             │
└──────────────────────────┬──────────────────────────────────┘
                           │
                           ▼
┌─────────────────────────────────────────────────────────────┐
│ agent-session.ts                                             │
│  - 存储到 currentProviderEnv 模块变量                        │
│  - buildClaudeSessionEnv() 设置环境变量                      │
│  - SDK query() 使用这些环境变量                             │
└─────────────────────────────────────────────────────────────┘
```

---

## 调试技巧

查看后端日志确认环境变量是否正确设置：

```
[env] ANTHROPIC_BASE_URL set to: https://open.bigmodel.cn/api/anthropic
[env] ANTHROPIC_AUTH_TOKEN and ANTHROPIC_API_KEY set from provider config
[agent] starting query with model: glm-4.7
```

如果看到 `apiKeySource: "none"`，说明 API Key 未正确传递。

---

## ⚠️ 关键陷阱：会话中途切换供应商

### 问题

环境变量（`ANTHROPIC_BASE_URL`）在 SDK 子进程启动时设置，**无法在运行时更新**。如果用户在会话中途切换供应商：

1. `currentProviderEnv` 更新 ✅
2. 正在运行的 SDK 进程仍使用旧的 baseUrl ❌
3. API 请求发往错误的端点 → 报错"模型不存在"

### 解决方案

检测供应商变化时，**终止当前会话并重启**：

```typescript
if (providerChanged && querySession) {
  currentProviderEnv = providerEnv;
  shouldAbortSession = true;
  
  // 等待旧会话完全终止，避免竞态条件
  if (sessionTerminationPromise) {
    await sessionTerminationPromise;
  }
  
  querySession = null;
  isProcessing = false;
  // 新消息会触发 startStreamingSession() 使用新环境变量
}
```

### 注意事项

- **应用层 session 保留**：`sessionId`、`messages` 不变
- **SDK 层 session 重建**：`querySession` 重新创建
- **状态清理**：`streamIndexToToolId`、`toolResultIndexToId` 需清理

---

## ⚠️ 关键陷阱：订阅模式与 API Key 模式切换

### 问题

从 API Key 模式（如 GLM）切换到 Anthropic 订阅模式时报错：`Invalid signature in thinking block`

### 根因

订阅模式的 Provider 配置是 `config: {}`（空对象），前端构建的 providerEnv 变成：

```typescript
// 实际发送的对象
{ baseUrl: undefined, apiKey: undefined, authType: undefined }
```

后端检查 `providerEnv && (providerEnv.baseUrl !== ...)` 为 true（因为对象存在），误判为 provider 变化，触发 resume session。但不同 provider 的 thinking block signature 不兼容。

### 解决方案

前端判断 provider 类型，**订阅模式不发送 providerEnv**：

```typescript
// Before: 只要 currentProvider 存在就发送
const providerEnv = currentProvider ? { ... } : undefined;

// After: 订阅模式发送 undefined
const providerEnv = currentProvider && currentProvider.type !== 'subscription'
  ? { baseUrl: ..., apiKey: ..., authType: ... }
  : undefined;
```

### 原则

- `providerEnv = undefined`：使用 SDK 默认认证（订阅）
- `providerEnv = { baseUrl, apiKey }`：使用第三方 API


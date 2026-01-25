# 统一日志系统 (Unified Logging)

## 概述

MyAgents 使用统一日志系统聚合来自三个来源的日志：
- **React** - 前端 `console.log/error/warn/debug`
- **Bun** - Sidecar 后端日志
- **Rust** - Tauri 原生层日志

所有日志通过 TabProvider 统一管理，显示在 UnifiedLogsPanel，并持久化到文件。

## 架构

```
┌─────────────────────────────────────────────────────────────┐
│                      TabProvider                             │
│                                                              │
│  React logs ──► CustomEvent ──► appendUnifiedLog ──► UI     │
│                              └─► buffer ──► /api/unified-log│
│                                                              │
│  Bun logs ────► SSE chat:log ──► appendUnifiedLog ──► UI    │
│                (server-side persistence via UnifiedLogger)   │
│                                                              │
│  Rust logs ───► Tauri event ──► appendUnifiedLog ──► UI     │
│                (Rust 侧直接写入文件，不经过前端 API)          │
└─────────────────────────────────────────────────────────────┘
```

### 持久化机制

| 来源 | 持久化方式 | 说明 |
|------|-----------|------|
| React | 前端 buffer → `/api/unified-log` | 批量发送，500ms debounce |
| Bun | 服务端 `UnifiedLogger.ts` 直接写入 | 同步写入 |
| Rust | `logger.rs` 直接写入 | 同步写入，避免循环 |

Rust 日志直接在 Rust 侧写入文件，而不是通过前端 API，这样可以避免日志循环：
```
❌ Rust log → 前端 → POST /api/unified-log → Rust proxy 日志 → 新 Rust log → ...
✅ Rust log → 直接写入文件 (无循环)
```

## 日志类型

```typescript
// src/renderer/types/log.ts
export type LogSource = 'bun' | 'rust' | 'react';
export type LogLevel = 'info' | 'warn' | 'error' | 'debug';

export interface LogEntry {
  source: LogSource;
  level: LogLevel;
  message: string;
  timestamp: string;  // ISO 8601
  meta?: Record<string, unknown>;
}
```

## 核心组件

### 1. frontendLogger.ts (React 日志拦截)

拦截前端 `console.*` 方法，将日志分发到 UI 和持久化队列。

```typescript
// 初始化（在 main.tsx 调用一次）
import { initFrontendLogger } from '@/utils/frontendLogger';
initFrontendLogger();

// 之后所有 console.log 自动被拦截
console.log('[MyComponent] something happened');  // 自动分发
```

**关键特性**：
- 批量发送：500ms debounce，50 条强制刷新
- 防递归：过滤 `[FrontendLogger]` 前缀的消息
- Cleanup：`forceFlushLogs()` 在 App unmount 时调用

### 2. UnifiedLogger.ts (服务端持久化)

将日志写入每日文件 `~/.myagents/logs/unified-{YYYY-MM-DD}.log`。

```typescript
// 服务端使用
import { appendUnifiedLog, cleanupOldUnifiedLogs } from './UnifiedLogger';

// 启动时清理旧日志
cleanupOldUnifiedLogs();

// 写入日志
appendUnifiedLog({
  source: 'bun',
  level: 'info',
  message: 'Server started',
  timestamp: new Date().toISOString()
});
```

### 3. AgentLogger.ts (Agent 会话日志)

独立的 Agent 会话日志，与统一日志分开存储。

```typescript
// 文件命名：{YYYY-MM-DD}-{sessionId}.log
// 存储位置：~/.myagents/logs/
// 特性：懒加载创建（首次写入时才创建文件）
```

### 4. logUtils.ts (共享常量)

```typescript
export const MYAGENTS_DIR = join(homedir(), '.myagents');
export const LOGS_DIR = join(MYAGENTS_DIR, 'logs');
export const LOG_RETENTION_DAYS = 30;
```

## API 端点

### POST /api/unified-log

接收前端日志批次并持久化。

```typescript
// Request
{
  entries: LogEntry[]
}

// Response
{ success: true }
```

## 最佳实践

### 1. 使用标准 console 方法

```typescript
// ✅ 直接使用，自动被拦截
console.log('[MyComponent] info');
console.warn('[MyComponent] warning');
console.error('[MyComponent] error');
console.debug('[MyComponent] debug');

// ❌ 不要直接调用 frontendLogger 内部方法
```

### 2. 日志前缀规范

```typescript
// ✅ 使用模块名前缀
console.log('[TabProvider] SSE connected');
console.log('[Chat] Message sent');

// ❌ 无前缀或不一致
console.log('connected');
console.log('Chat - sent');
```

### 3. 避免日志循环

```typescript
// ✅ 在日志相关代码中使用原始 console
import { getOriginalConsole } from '@/utils/frontendLogger';
const originalConsole = getOriginalConsole();
originalConsole.log('[FrontendLogger] internal message');

// ❌ 在日志代码中使用被拦截的 console
console.log('[FrontendLogger] ...');  // 会被过滤掉
```

### 4. Cleanup 时刷新日志

```typescript
// App.tsx
useEffect(() => {
  return () => {
    forceFlushLogs();  // 确保日志不丢失
    void stopAllSidecars();
  };
}, []);
```

### 5. 批量发送日志

```typescript
// ✅ 使用 queueLogsForPersistence 批量入队
import { queueLogsForPersistence } from '@/utils/frontendLogger';
queueLogsForPersistence(entries);  // 自动批量发送

// ❌ 每条日志单独发送 HTTP 请求
for (const entry of entries) {
  await fetch('/api/unified-log', { body: JSON.stringify({ entries: [entry] }) });
}
```

## 文件结构

```
~/.myagents/
└── logs/
    ├── unified-2025-01-25.log      # 统一日志（React/Bun/Rust）
    ├── unified-2025-01-24.log
    ├── 2025-01-25-abc123.log       # Agent 会话日志
    └── 2025-01-25-def456.log
```

## 日志格式

### 统一日志文件格式

```
2025-01-25T10:30:45.123Z [REACT] [INFO ] [TabProvider] SSE connected
2025-01-25T10:30:45.234Z [BUN  ] [INFO ] Server started on port 31415
2025-01-25T10:30:45.345Z [RUST ] [INFO ] Sidecar process spawned
```

### Agent 会话日志格式

```
[2025-01-25T10:30:45.123Z] User: Hello
[2025-01-25T10:30:46.234Z] Assistant: Hi there!
```

## 故障排查

### 日志不显示

1. 检查 `initFrontendLogger()` 是否在 `main.tsx` 中调用
2. 检查 TabProvider 是否正确监听 `REACT_LOG_EVENT`
3. 检查 UnifiedLogsPanel 的 `sseLogs` prop

### 日志不持久化

1. 检查 `serverUrl` 是否已设置（SSE 连接后设置）
2. 检查 `/api/unified-log` 端点是否正常
3. 检查 `~/.myagents/logs/` 目录权限

### Rust 日志不显示

1. 确认在 Tauri 环境中运行（`isTauri()` 返回 true）
2. 检查 Rust 侧是否 emit `log:rust` 事件
3. 检查 TabProvider 中的 Tauri event listener

## 相关文件

| 文件 | 说明 |
|------|------|
| `src/renderer/utils/frontendLogger.ts` | React console 拦截 |
| `src/renderer/context/TabProvider.tsx` | 日志状态管理 |
| `src/renderer/components/UnifiedLogsPanel.tsx` | 日志 UI 面板 |
| `src/renderer/types/log.ts` | 日志类型定义 |
| `src/server/logger.ts` | Bun 日志拦截 |
| `src/server/UnifiedLogger.ts` | 统一日志持久化 |
| `src/server/AgentLogger.ts` | Agent 会话日志 |
| `src/server/logUtils.ts` | 共享常量 |
| `src-tauri/src/logger.rs` | Rust 日志模块 |

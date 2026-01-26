# MyAgents 技术架构

## 概述

MyAgents 是基于 Tauri v2 的桌面应用，提供 Claude Agent SDK 的图形界面。

## 技术栈

| 层级 | 技术 |
|------|------|
| 前端 | React + TypeScript + Vite + TailwindCSS |
| 桌面框架 | Tauri v2 (Rust) |
| 后端 | Bun + TypeScript (多实例 Sidecar 进程) |
| AI | Anthropic Claude Agent SDK |
| 拖拽 | @dnd-kit/sortable |

## 架构图

```
┌─────────────────────────────────────────────────────────────┐
│                    Tauri Desktop App                         │
├──────────────────────────┬──────────────────────────────────┤
│     React Frontend       │        Rust Backend              │
│      (WebView)           │        (src-tauri)               │
│                          │                                  │
│  ┌──────────────────┐    │    ┌────────────────────────┐    │
│  │   SseConnection  │    │    │     sse_proxy.rs       │    │
│  │ (per-Tab 实例)   │◄───┼────│  多实例连接管理         │    │
│  │ listen(sse:tabId:*)│   │   │  HashMap<tabId, conn>  │    │
│  └──────────────────┘    │    └───────────┬────────────┘    │
│                          │                │ reqwest         │
│  ┌──────────────────┐    │                ▼                 │
│  │  TabProvider.tsx │    │       ┌──────────────────┐       │
│  │  (仅 Chat 页面)  │────┼────►  │ Bun Sidecar 多实例│       │
│  │  apiGet/apiPost  │    │       │ :31415 :31416 ...│       │
│  └──────────────────┘    │       └──────────────────┘       │
│                          │                                  │
│  ┌──────────────────┐    │    ┌────────────────────────┐    │
│  │ Settings/Launcher│────┼────│   Global Sidecar       │    │
│  │  (无 TabProvider)│    │    │  (全局功能/API验证)    │    │
│  │   Global API     │    │    └────────────────────────┘    │
│  └──────────────────┘    │                                  │
└──────────────────────────┴──────────────────────────────────┘
```

### Sidecar 使用边界

| 页面类型 | TabProvider | Sidecar 类型 | API 来源 |
|----------|-------------|--------------|----------|
| Chat | ✅ 包裹 | Tab Sidecar | `useTabState()` |
| Settings | ❌ 不包裹 | Global Sidecar | `apiFetch.ts` |
| Launcher | ❌ 不包裹 | Global Sidecar | `apiFetch.ts` |

**设计原则**：
- **Chat 页面**需要独立的 Sidecar（有 `agentDir`，项目级 AI 对话）
- **Settings/Launcher**使用 Global Sidecar（全局功能、API 验证等）
- 不在 TabProvider 内的组件调用 `useTabStateOptional()` 返回 `null`，自动 fallback 到 Global API

## 核心模块

### 1. Multi-Tab 多实例架构 (`src/renderer/context/`)

**每个 Tab 拥有独立的 Sidecar 进程和 SSE 连接**：

| 组件 | 职责 |
|------|------|
| `TabContext.tsx` | Context 定义，提供 Tab-scoped API |
| `TabProvider.tsx` | 状态容器，管理 messages/logs/SSE/Sidecar |

**Tab-Scoped API**：
```typescript
// 每个 Tab 使用自己的 Sidecar 端口
const { apiGet, apiPost, stopResponse } = useTabState();
```

### 2. Rust Sidecar Manager (`src-tauri/src/sidecar.rs`)

**多实例进程管理**：

```rust
pub struct SidecarManager {
    instances: HashMap<String, SidecarInstance>, // tabId -> instance
    port_counter: AtomicU16,                     // 动态端口分配
}

pub struct SidecarInstance {
    process: Child,
    port: u16,
    agent_dir: Option<PathBuf>,
    healthy: bool,
    is_global: bool,
}
```

**IPC 命令**：
| 命令 | 用途 |
|------|------|
| `cmd_start_tab_sidecar` | 为 Tab 启动独立 Sidecar |
| `cmd_stop_tab_sidecar` | 停止指定 Tab 的 Sidecar |
| `cmd_get_tab_server_url` | 获取 Tab 的服务端口 URL |
| `cmd_start_global_sidecar` | 启动全局 Sidecar (Settings) |
| `cmd_stop_all_sidecars` | 应用退出时清理全部 |

### 3. Rust SSE Proxy (`src-tauri/src/sse_proxy.rs`)

**多连接 SSE 代理**：

```rust
pub struct SseProxyState {
    connections: Mutex<HashMap<String, SseConnection>>, // tabId -> connection
}
```

**事件隔离**：
```
事件格式: sse:${tabId}:${eventName}
示例:     sse:tab-xxx:chat:message-chunk
```

### 4. Chrome 风格标题栏 (`src/renderer/components/`)

| 组件 | 职责 |
|------|------|
| `CustomTitleBar.tsx` | 标题栏容器，处理拖拽区域和全屏检测 |
| `TabBar.tsx` | 可拖拽排序的标签栏，支持横向滚动 |
| `SortableTabItem.tsx` | 单个可排序标签 (@dnd-kit) |

**Tauri 配置要点**：
- `titleBarStyle: "Overlay"` - macOS 原生双击放大
- `trafficLightPosition: { x: 14, y: 20 }` - 交通灯居中
- `data-tauri-drag-region` - 拖拽区域标记

### 5. Session API (`src/server/`)

| 文件 | 用途 |
|------|------|
| `SessionStore.ts` | 会话 CRUD，文件持久化到 `.agent/` |
| `types/session.ts` | Session 类型定义 |
| `agent-session.ts` | 会话状态管理，包含 `resetSession()` |

### 6. 会话重置机制

用户点击「新对话」时，必须同步重置前后端状态：

```
前端 resetSession() → POST /chat/reset → 后端 resetSession()
                                              ├─ 中断响应
                                              ├─ 清空 messages
                                              └─ 生成新 sessionId
```

详见 [SSE 状态同步文档](./session_state_sync.md)。

## 通信流程

### SSE 流式事件（多实例）
```
Tab1 listen('sse:tab1:*') ◄── Rust emit(sse:tab1:event) ◄── reqwest stream ◄── Sidecar:31415
Tab2 listen('sse:tab2:*') ◄── Rust emit(sse:tab2:event) ◄── reqwest stream ◄── Sidecar:31416
```

### HTTP API 调用（多实例）
```
Tab1 apiPost() ──► getTabServerUrl(tab1) ──► Rust proxy ──► Sidecar:31415
Tab2 apiPost() ──► getTabServerUrl(tab2) ──► Rust proxy ──► Sidecar:31416
```

## 资源管理

| 事件 | 操作 |
|------|------|
| 打开工作区 | `startTabSidecar(tabId, agentDir)` |
| 关闭 Tab | `stopTabSidecar(tabId)`，Drop trait 清理进程 |
| 应用退出 | `stopAllSidecars()`，清理临时目录 |

## 安全设计

- **FS 权限**: 仅允许 `~/.myagents` 配置目录
- **Agent 目录验证**: 阻止访问系统敏感目录
- **Tauri Capabilities**: 最小权限原则
- **本地绑定**: Sidecar 仅监听 `127.0.0.1`

## 开发脚本

| 脚本 | 用途 |
|------|------|
| `setup.sh` | 首次环境初始化 |
| `start_dev.sh` | 浏览器开发模式 |
| `build_dev.sh` | Debug 构建 (含 DevTools) |
| `build_macos.sh` | 生产 DMG 构建 |

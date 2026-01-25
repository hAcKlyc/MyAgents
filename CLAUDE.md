# MyAgents - Claude Agent Desktop Client

## 产品定位

MyAgents 是一款基于 Claude Agent SDK 开发的**桌面端通用 Agent 产品**，目标是让非开发者也能使用强大的 AI Agent 能力。Claude Code（官方 CLI）需要命令行操作，普通用户难以上手；ChatGPT/Claude 网页版只能对话，无法操作本地文件。MyAgents 填补了这个空白：**低技术门槛 + 强 Agent 能力**。目标用户包括内容创作者、产品经理、学生、独立开发者等希望 AI 能真正帮忙做事（而非仅聊天）的人群。核心差异化：图形界面零门槛、多标签页并行工作、多模型供应商可选、数据本地存储保护隐私、开源免费。

## 核心架构

**多实例 Sidecar 架构**：每个 Tab 拥有独立的 Bun Sidecar 进程和 SSE 连接。

```
┌─────────────────────────────────────────────────────────────┐
│                    Tauri Desktop App                         │
├──────────────────────────────────────────────────────────────┤
│                        React Frontend                        │
│  ┌─────────────┐  ┌─────────────┐  ┌─────────────┐          │
│  │   Tab 1     │  │   Tab 2     │  │  Settings   │          │
│  │ TabProvider │  │ TabProvider │  │   (Global)  │          │
│  └──────┬──────┘  └──────┬──────┘  └──────┬──────┘          │
│         │                │                │                  │
├─────────┼────────────────┼────────────────┼──────────────────┤
│         ▼                ▼                ▼     Rust Layer   │
│    SSE:tab1:*       SSE:tab2:*      Global Sidecar           │
│  ┌─────────────┐  ┌─────────────┐  ┌─────────────┐          │
│  │ sse_proxy   │  │ sse_proxy   │  │ sse_proxy   │          │
│  │ :31415      │  │ :31416      │  │ :31417      │          │
│  └──────┬──────┘  └──────┬──────┘  └──────┬──────┘          │
└─────────┼────────────────┼────────────────┼──────────────────┘
          ▼                ▼                ▼
   Sidecar:31415    Sidecar:31416    Sidecar:31417
   (project-a)      (project-b)      (settings)
```

## 技术栈

| 层级 | 技术 |
|------|------|
| 桌面框架 | Tauri v2 (Rust) |
| 前端 | React 19 + TypeScript + Vite + TailwindCSS |
| 后端 | Bun + Claude Agent SDK (多实例 Sidecar) |
| 通信 | Rust HTTP/SSE Proxy (reqwest) |
| 运行时 | Bun 内置于应用包（用户无需安装 Bun 或 Node.js） |

## 项目结构

```
hermitcrab/
├── src/
│   ├── renderer/          # React 前端
│   │   ├── api/           # SSE/HTTP 客户端 (多实例)
│   │   │   ├── SseConnection.ts  # Tab-scoped SSE
│   │   │   └── tauriClient.ts    # Tab Sidecar 管理
│   │   ├── context/       # Tab 状态管理
│   │   │   ├── TabContext.tsx    # Tab 上下文定义
│   │   │   └── TabProvider.tsx   # Tab 状态 + SSE 连接
│   │   ├── hooks/         # 自定义 Hooks
│   │   ├── config/        # Provider/Model 配置
│   │   ├── components/    # UI 组件
│   │   └── pages/         # 页面组件
│   ├── server/            # Bun 后端 (Sidecar)
│   │   └── utils/
│   │       └── runtime.ts # 运行时路径工具 (bundled bun 检测)
│   └── shared/            # 前后端共享代码
│       ├── types/         # 共享类型 (askUserQuestion.ts 等)
│       └── parsePartialJson.ts
├── src-tauri/             # Tauri Rust 代码
│   └── src/
│       ├── sidecar.rs     # 多实例进程管理
│       ├── sse_proxy.rs   # 多实例 SSE 代理
│       ├── updater.rs     # 静默自动更新
│       ├── logger.rs      # 统一日志系统
│       └── lib.rs         # 应用入口
├── specs/                 # 设计文档 (见「文档索引」)
└── .agent/                # Agent 配置
```

## 开发命令

```bash
# 依赖安装
bun install

# 浏览器开发模式 (快速迭代，无 Tauri)
./start_dev.sh

# Tauri 开发模式 (完整桌面体验)
npm run tauri:dev

# Debug 构建 (含 DevTools)
./build_dev.sh

# 生产构建 (macOS DMG，支持 ARM/Intel/Both)
./build_macos.sh

# 发布到 Cloudflare R2 (官网下载 + 自动更新)
./publish_release.sh

# 代码质量
npm run typecheck && npm run lint
```

> **构建和发布详情**：请查阅 [构建与发布指南](./specs/guides/build_and_release_guide.md)

---

## 核心原则

### 1. Tab-scoped 隔离

每个 Tab 拥有独立的 Sidecar 进程，API 调用必须发送到正确的 Sidecar。

**核心原则**：
- **影响 SDK 会话状态的 API**（MCP、Provider、Model）→ 必须用 Tab-scoped API
- **全局设置类 API**（订阅验证、API Key）→ 使用全局 API
- **文件操作类 API** → 优先用 Tab-scoped；若用全局 API 则必须显式传 `agentDir`

```typescript
// ✅ Tab 内：使用 Tab-scoped API
const { apiGet, apiPost } = useTabState();
await apiPost('/api/mcp/set', { servers });

// ❌ Tab 内误用全局 API（会发到 Global Sidecar，SDK 收不到配置）
import { apiPostJson } from '@/api/apiFetch';
await apiPostJson('/api/mcp/set', { servers }); // 错误！
```

**关键组件**：
- `TabProvider` - 封装 Tab 级别的状态和 API
- `useTabState()` - 获取当前 Tab 的 API 函数
- `SseConnection` - Tab-scoped SSE 连接

### 2. Rust 代理层是核心

所有 HTTP/SSE 流量必须通过 Rust 代理层：

```
前端 ──(invoke)──> Rust Proxy ──(reqwest)──> Bun Sidecar
        <──(emit sse:tabId:event)──
```

- 使用 `proxyFetch()` 或 Tab-scoped `apiGet/apiPost`
- SSE 事件格式：`sse:${tabId}:${eventName}`
- **禁止**直接从 WebView 发起 HTTP 请求

### 3. 稳定回调模式

当需要将 callback 传递给子组件并在 useEffect 中使用时，必须使用 `useRef` 稳定引用：

```typescript
// ❌ 问题：inline callback 每次渲染创建新引用
<TabProvider onGeneratingChange={(v) => updateTab(v)} />

// ✅ 解决：使用 useRef 稳定回调
const onGeneratingChangeRef = useRef(onGeneratingChange);
onGeneratingChangeRef.current = onGeneratingChange;

useEffect(() => {
    onGeneratingChangeRef.current?.(isLoading);
}, [isLoading]); // 只在 isLoading 变化时触发
```

### 4. 定时器清理

所有 setTimeout/setInterval 必须在组件卸载时清理：

```typescript
const timeoutRef = useRef<NodeJS.Timeout>();

useEffect(() => {
    return () => {
        if (timeoutRef.current) clearTimeout(timeoutRef.current);
    };
}, []);
```

### 5. 配置持久化

- 配置目录: `~/.myagents/`
- 项目列表: `projects.json`
- 应用配置: `config.json`
- API Keys: `apiKeys` (通过 useConfig hook 访问)

### 6. 零外部依赖原则

应用内置 Bun 运行时，**不依赖用户系统的 Node.js/npm/npx**：

```typescript
// ✅ 正确：使用内置 bun
import { getBundledRuntimePath, getPackageManagerPath, isBunRuntime } from './utils/runtime';
const runtime = getBundledRuntimePath();  // 自动检测内置 bun
const pkgManager = getPackageManagerPath();  // 返回 bun add 命令

// ❌ 错误：依赖系统 npm/npx
spawn('npm', ['install', pkg]);  // 用户可能没有 Node.js
spawn('npx', ['-y', pkg]);       // 用户可能没有 npm
```

详见 [Bundled Bun 文档](./specs/tech_docs/bundled_bun.md)

### 7. SDK Session 与配置变更

**核心概念**：Claude Agent SDK 的 `session_id` 是 SDK 层面的概念，与底层 LLM Provider 无关。LLM 是无状态的，SDK 负责维护对话历史。

**关键原则**：配置变更（Provider/Model/MCP）时必须保持对话上下文，只有用户主动点击「新对话」才能创建全新 session。

```typescript
// ✅ 正确：配置变更时通过 resume 保持对话上下文
if (configChanged && querySession) {
    // 先保存当前 session_id 用于 resume
    if (systemInitInfo?.session_id) {
        resumeSessionId = systemInitInfo.session_id;
    }
    // 再触发会话重启
    shouldAbortSession = true;
}

// ❌ 错误：配置变更直接重启，导致 AI "失忆"
if (configChanged && querySession) {
    shouldAbortSession = true;  // 没有设置 resumeSessionId！
}
```

**实现要点**：
- 切换 Provider/Model：设置 `resumeSessionId` 后再设置 `shouldAbortSession = true`
- 切换 MCP 配置：同样需要 resume，因为 SDK 需要重启以加载新工具
- 用户点击「新对话」：不设置 `resumeSessionId`，创建全新 session
- 用户界面应完全无感知 session 重启过程

详见 `src/server/agent-session.ts` 中的 `setMcpServers()` 和 provider 变更处理逻辑。

---

## 禁止事项

| 禁止 | 原因 | 正确做法 |
|------|------|----------|
| 直接 fetch 请求 | WebView CORS 限制 | 使用 `proxyFetch()` |
| 全局 API 访问 Tab 资源 | 会访问错误的 Sidecar | 使用 `useTabState()` |
| useEffect 依赖 inline callback | 导致无限循环 | 使用 `useRef` 稳定 |
| 不清理定时器 | 内存泄漏 | cleanup 函数清理 |
| 提交前不 typecheck | CI 会失败 | `npm run typecheck` |
| 硬编码 API 端点 | 环境切换困难 | 使用配置文件 |
| 依赖 npm/npx/Node.js | 用户可能未安装 | 使用内置 bun (`runtime.ts`) |
| 配置变更不 resume session | AI 会"失忆"丢失对话 | 先设置 `resumeSessionId` 再 `shouldAbortSession` |

---

## 命名规范

| 类型 | 规范 | 示例 |
|------|------|------|
| React 组件 | PascalCase | `CustomTitleBar.tsx` |
| Hook | camelCase + use 前缀 | `useUpdater.ts` |
| Context | PascalCase + Context 后缀 | `TabContext.tsx` |
| Rust 模块 | snake_case | `sse_proxy.rs` |
| 类型文件 | PascalCase 或 camelCase | `types.ts`, `SessionTypes.ts` |
| 工具函数 | camelCase | `formatDate.ts` |

---

## 错误处理

### Rust 侧

```rust
// 返回 Result<T, String> 给前端，错误信息包含上下文
fn some_command() -> Result<Data, String> {
    do_something().map_err(|e| format!("[模块名] 操作失败: {}", e))?;
    Ok(data)
}
```

### TypeScript 侧

```typescript
// API 调用统一 try-catch，用户可见错误需 Toast 提示
try {
    const result = await apiPost('/api/action', data);
} catch (err) {
    console.error('[module] Action failed:', err);
    toast.error('操作失败，请重试');
}
```

---

## 统一日志系统

**Rust 侧** (`src-tauri/src/logger.rs`):
```rust
logger::info(app, "[模块名] 操作开始");
logger::error(app, format!("[模块名] 错误: {}", e));
```

**TypeScript 侧**（使用 isDebugMode）:
```typescript
import { isDebugMode } from '@/utils/debug';

if (isDebugMode()) {
    console.log('[module] debug message');
}
```

---

## 工作流规范

1. **代码提交前**：必须运行 `npm run typecheck`
2. **Commit 格式**：使用 Conventional Commits (`feat:`, `fix:`, `refactor:`, `docs:`)
3. **测试构建**：使用 `./build_dev.sh` 验证 Tauri 打包正确
4. **分支策略**：功能分支 `dev/prd-x.x.x`，完成后合并到 `main`
5. **发布流程**：
   - 更新版本号 (`package.json` + `tauri.conf.json`)
   - 运行 `./build_macos.sh` 构建 (选择 Both 构建双架构)
   - 运行 `./publish_release.sh` 发布到 R2
   - 打 `v*` tag 推送到远程
   - 详见 [构建与发布指南](./specs/guides/build_and_release_guide.md)

---

## 常见问题

### Tab 切换后功能异常
检查是否使用了全局 API 而非 Tab-scoped API。

### SSE 事件未收到
1. 确认 SSE 连接状态 (`isConnected`)
2. 检查事件名格式 `sse:${tabId}:${eventName}`
3. 查看 Rust 日志确认代理是否工作

### 子组件 useEffect 频繁触发
检查是否将 inline callback 作为依赖项，应使用 `useRef` 稳定引用。

### 新对话后旧消息重现
SSE 重连时后端会重放消息。确保使用 `resetSession()` 而非直接清理前端状态。
详见 [SSE 状态同步文档](./specs/tech_docs/session_state_sync.md)。

### 更新按钮不显示
1. 检查 Console 是否有 `[useUpdater]` 日志
2. 确认 Rust 日志有下载完成记录
3. 参考 [自动更新文档](./specs/tech_docs/auto_update.md)

---

## 文档索引

### 何时查阅哪个文档？

| 场景 | 文档 |
|------|------|
| 了解整体架构、数据流 | [architecture.md](./specs/tech_docs/architecture.md) |
| 集成新的 LLM 供应商 | [third_party_providers.md](./specs/tech_docs/third_party_providers.md) |
| 理解 Bun Sidecar 打包机制 | [bundled_bun.md](./specs/tech_docs/bundled_bun.md) |
| 实现自动更新、CI/CD 配置 | [auto_update.md](./specs/tech_docs/auto_update.md) |
| 实现工具权限控制 | [sdk_canUseTool_guide.md](./specs/tech_docs/sdk_canUseTool_guide.md) |
| SSE 状态同步、新会话机制 | [session_state_sync.md](./specs/tech_docs/session_state_sync.md) |
| **日志系统、持久化、调试** | [unified_logging.md](./specs/tech_docs/unified_logging.md) |
| UI/设计规范、颜色/组件 | [design_guide.md](./specs/guides/design_guide.md) |
| macOS 签名、公证、分发 | [macos_distribution_guide.md](./specs/guides/macos_distribution_guide.md) |
| **构建、发布、分发渠道** | [build_and_release_guide.md](./specs/guides/build_and_release_guide.md) |
| 了解 Skills 功能设计 | [claude_code_skills_research.md](./specs/research/claude_code_skills_research.md) |

### 技术文档 (specs/tech_docs/)

| 文档 | 内容 |
|------|------|
| `architecture.md` | 多实例架构、Rust 代理层、SSE 通信机制 |
| `auto_update.md` | 静默更新流程、R2 配置、CI/CD、故障排查 |
| `bundled_bun.md` | Bun 运行时内置方案、Sidecar 启动流程 |
| `third_party_providers.md` | 第三方 LLM 接入、API 兼容层 |
| `sdk_canUseTool_guide.md` | Claude Agent SDK 工具权限回调实现 |
| `session_state_sync.md` | SSE 状态同步、新会话重置机制、防护标志 |
| `unified_logging.md` | 统一日志系统、React/Bun/Rust 日志聚合、持久化 |

### 指南文档 (specs/guides/)

| 文档 | 内容 |
|------|------|
| `design_guide.md` | 设计系统、颜色变量、组件规范 |
| `macos_distribution_guide.md` | 代码签名、公证、DMG 分发 |
| `build_and_release_guide.md` | **构建脚本、发布流程、分发渠道、防呆机制** |

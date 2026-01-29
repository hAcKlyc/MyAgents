# MyAgents - Claude Agent Desktop Client

> **开源项目** | 仓库地址：https://github.com/hAcKlyc/MyAgents | License: Apache-2.0
>
> 作为开源项目，请遵循以下规范：
> - **代码质量**：保持代码可读性，添加必要注释，遵循项目既有风格
> - **提交规范**：使用 Conventional Commits，提交信息清晰描述变更
> - **安全意识**：不提交敏感信息（API Key、密码），不引入已知漏洞的依赖
> - **文档同步**：重要功能变更需同步更新相关文档
> - **向后兼容**：破坏性变更需谨慎，考虑用户升级路径

## 产品定位

MyAgents 是一款基于 Claude Agent SDK 开发的**桌面端通用 Agent 产品**，目标是让非开发者也能使用强大的 AI Agent 能力。核心差异化：图形界面零门槛、多标签页并行工作、多模型供应商可选、数据本地存储保护隐私、开源免费。

## 核心架构

**多实例 Sidecar 架构**：每个 Chat Tab 拥有独立的 Bun Sidecar 进程，Settings/Launcher 使用 Global Sidecar。

```
┌─────────────────────────────────────────────────────────────┐
│                    Tauri Desktop App                         │
├──────────────────────────────────────────────────────────────┤
│                        React Frontend                        │
│  ┌─────────────┐  ┌─────────────┐  ┌─────────────┐          │
│  │   Chat 1    │  │   Chat 2    │  │  Settings   │          │
│  │ TabProvider │  │ TabProvider │  │  Launcher   │          │
│  │ Tab Sidecar │  │ Tab Sidecar │  │ Global API  │          │
│  └──────┬──────┘  └──────┬──────┘  └──────┬──────┘          │
│         │                │                │                  │
├─────────┼────────────────┼────────────────┼──────────────────┤
│         ▼                ▼                ▼     Rust Layer   │
│  ┌─────────────┐  ┌─────────────┐  ┌─────────────┐          │
│  │ Tab Sidecar │  │ Tab Sidecar │  │   Global    │          │
│  │ :31415      │  │ :31416      │  │  Sidecar    │          │
│  └─────────────┘  └─────────────┘  └─────────────┘          │
└─────────────────────────────────────────────────────────────┘
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
myagents/
├── src/
│   ├── renderer/          # React 前端
│   │   ├── api/           # SSE/HTTP 客户端 (多实例)
│   │   ├── context/       # Tab 状态管理
│   │   ├── hooks/         # 自定义 Hooks
│   │   ├── components/    # UI 组件
│   │   └── pages/         # 页面组件
│   ├── server/            # Bun 后端 (Sidecar)
│   └── shared/            # 前后端共享代码
├── src-tauri/             # Tauri Rust 代码
├── specs/                 # 设计文档
└── .agent/                # Agent 配置
```

## 开发命令

```bash
bun install                 # 依赖安装
./start_dev.sh              # 浏览器开发模式 (快速迭代)
npm run tauri:dev           # Tauri 开发模式 (完整桌面体验)
./build_dev.sh              # Debug 构建 (含 DevTools)
./build_macos.sh            # 生产构建
./publish_release.sh        # 发布到 R2
npm run typecheck && npm run lint  # 代码质量检查
```

---

## 核心原则

### 1. Tab-scoped 隔离

每个 Tab 拥有独立的 Sidecar 进程，API 调用必须发送到正确的 Sidecar。

```typescript
// ✅ Tab 内：使用 Tab-scoped API
const { apiGet, apiPost } = useTabState();
await apiPost('/api/mcp/set', { servers });

// ❌ 错误：Tab 内使用全局 API
import { apiPostJson } from '@/api/apiFetch';
await apiPostJson('/api/mcp/set', { servers }); // 会发到 Global Sidecar！
```

### 2. Rust 代理层

所有 HTTP/SSE 流量必须通过 Rust 代理层，**禁止**直接从 WebView 发起 HTTP 请求：

```
前端 ──(invoke)──> Rust Proxy ──(reqwest)──> Bun Sidecar
```

### 3. 零外部依赖

应用内置 Bun 运行时，**不依赖用户系统的 Node.js/npm/npx**：

```typescript
// ✅ 使用内置 bun
import { getBundledRuntimePath } from './utils/runtime';

// ❌ 依赖系统 npm/npx
spawn('npm', ['install', pkg]);
```

### 4. Session 上下文保持

配置变更（Provider/Model/MCP）时必须保持对话上下文，只有用户点击「新对话」才创建全新 session：

```typescript
// ✅ 配置变更时 resume
if (configChanged) {
    resumeSessionId = systemInitInfo?.session_id;
    shouldAbortSession = true;
}

// ❌ 配置变更直接重启，AI 会"失忆"
shouldAbortSession = true;  // 没有 resumeSessionId！
```

---

## React 稳定性规范

> **核心原则**：React 重新渲染时，对象/函数引用会改变。依赖这些引用的 useEffect 会重新执行，可能触发 API 调用、文件访问等副作用。

### 规则 1：Context Provider 必须 useMemo

Provider value 必须使用 `useMemo` 包装，否则每次渲染都会创建新对象，导致所有消费者重新渲染。

```typescript
// ✅ 正确
const contextValue = useMemo(() => ({
    showToast, success, error, warning, info
}), [showToast, success, error, warning, info]);

return <ToastContext.Provider value={contextValue}>{children}</ToastContext.Provider>;

// ❌ 错误：对象字面量每次渲染都是新引用
return <ToastContext.Provider value={{ showToast, success, error }}>{children}</ToastContext.Provider>;
```

### 规则 2：useEffect 依赖数组规范

**禁止**将以下内容放入依赖数组（除非确实需要响应其变化）：

| 禁止依赖 | 原因 | 替代方案 |
|----------|------|----------|
| `toast` hook 返回值 | 可能不稳定 | 在 effect 内部调用，不加依赖 |
| `api` 对象 | 依赖 Provider 稳定性 | 使用 `useRef` 缓存 |
| inline callback | 每次渲染新引用 | `useCallback` 或 `useRef` |
| 对象/数组字面量 | 每次渲染新引用 | `useMemo` 包装 |

```typescript
// ✅ 正确：稳定依赖
useEffect(() => {
    loadData();
}, [id]);  // 只依赖原始值

// ❌ 错误：不稳定依赖导致无限循环
useEffect(() => {
    loadData();
}, [id, toast, api, { config }]);  // toast/api/对象字面量都不稳定
```

### 规则 3：跨组件回调稳定化

父组件传递给子组件的回调，若在子组件 useEffect 中使用，必须稳定化：

```typescript
// 子组件内部
const onChangeRef = useRef(onChange);
onChangeRef.current = onChange;  // 每次渲染更新

useEffect(() => {
    onChangeRef.current?.(value);  // 使用 ref 调用
}, [value]);  // 不依赖 onChange
```

### 规则 4：定时器必须清理

```typescript
const timeoutRef = useRef<NodeJS.Timeout>();

useEffect(() => {
    timeoutRef.current = setTimeout(doSomething, 1000);
    return () => {
        if (timeoutRef.current) clearTimeout(timeoutRef.current);
    };
}, []);
```

---

## 禁止事项速查表

| 禁止 | 原因 | 正确做法 |
|------|------|----------|
| 直接 fetch 请求 | WebView CORS 限制 | `proxyFetch()` |
| 全局 API 访问 Tab 资源 | 访问错误 Sidecar | `useTabState()` |
| Context value 不用 useMemo | 消费者无限重渲染 | `useMemo` 包装 |
| useEffect 依赖 hook 返回值 | 引用不稳定致循环 | `useRef` 或移除依赖 |
| useEffect 依赖 inline callback | 无限循环 | `useRef` 稳定 |
| 不清理定时器 | 内存泄漏 | cleanup 函数 |
| 依赖 npm/npx/Node.js | 用户可能未安装 | 内置 bun |
| 配置变更不 resume session | AI 失忆 | 先设 `resumeSessionId` |
| 提交前不 typecheck | CI 失败 | `npm run typecheck` |

---

## 命名规范

| 类型 | 规范 | 示例 |
|------|------|------|
| React 组件 | PascalCase | `CustomTitleBar.tsx` |
| Hook | camelCase + use 前缀 | `useUpdater.ts` |
| Context | PascalCase + Context 后缀 | `TabContext.tsx` |
| Rust 模块 | snake_case | `sse_proxy.rs` |

---

## 错误处理 & 日志

**Rust 侧**：
```rust
fn some_command() -> Result<Data, String> {
    do_something().map_err(|e| format!("[模块名] 操作失败: {}", e))?;
    Ok(data)
}
```

**TypeScript 侧**：
```typescript
try {
    await apiPost('/api/action', data);
} catch (err) {
    console.error('[module] Action failed:', err);
    toast.error('操作失败，请重试');
}
```

**调试日志**：
```typescript
import { isDebugMode } from '@/utils/debug';
if (isDebugMode()) console.log('[module] debug message');
```

---

## 工作流规范

1. **提交前**：`npm run typecheck`
2. **Commit 格式**：Conventional Commits (`feat:`, `fix:`, `refactor:`)
3. **分支策略**：功能分支 `dev/prd-x.x.x` → 合并到 `main`
4. **版本管理**：`npm version patch/minor/major` 自动同步所有配置
5. **发布流程**：`npm version` → `./build_macos.sh` → `./publish_release.sh` → push tag
6. **版本发布**：发布前**先更新 [version.md](./specs/version.md)，再打 tag**，tag message 从 version.md 复制

---

## 常见问题

| 问题 | 排查方向 |
|------|----------|
| Tab 切换后功能异常 | 检查是否用了全局 API 而非 Tab-scoped API |
| SSE 事件未收到 | 确认连接状态、事件名格式 `sse:${tabId}:${event}` |
| useEffect 频繁触发 | 检查依赖数组是否有不稳定引用 |
| 保存文件弹权限框 | Context 不稳定导致 loadData 重复执行 |
| 新对话后旧消息重现 | 使用 `resetSession()` 而非直接清理状态 |

---

## 文档索引

| 场景 | 文档 |
|------|------|
| **版本发布记录** | [version.md](./specs/version.md) |
| 整体架构、数据流 | [architecture.md](./specs/tech_docs/architecture.md) |
| 集成新 LLM 供应商 | [third_party_providers.md](./specs/tech_docs/third_party_providers.md) |
| Bun Sidecar 打包机制 | [bundled_bun.md](./specs/tech_docs/bundled_bun.md) |
| 自动更新、CI/CD | [auto_update.md](./specs/tech_docs/auto_update.md) |
| 工具权限控制 | [sdk_canUseTool_guide.md](./specs/tech_docs/sdk_canUseTool_guide.md) |
| SSE 状态同步 | [session_state_sync.md](./specs/tech_docs/session_state_sync.md) |
| Session 存储架构 | [session_storage.md](./specs/tech_docs/session_storage.md) |
| 日志系统 | [unified_logging.md](./specs/tech_docs/unified_logging.md) |
| UI/设计规范 | [design_guide.md](./specs/guides/design_guide.md) |
| macOS 签名、公证 | [macos_distribution_guide.md](./specs/guides/macos_distribution_guide.md) |
| 构建、发布流程 | [build_and_release_guide.md](./specs/guides/build_and_release_guide.md) |

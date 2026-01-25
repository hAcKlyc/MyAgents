# Bundled Bun 运行时架构

## 概述

MyAgents 将 Bun 运行时打包到应用内，实现零外部依赖分发。用户无需安装 Bun 或 Node.js 即可运行应用，包括 MCP（Model Context Protocol）功能。

## 二进制获取方式

Bun 二进制通过 `setup.sh` 从 GitHub Releases 下载：

```bash
./setup.sh  # 自动下载 Bun 二进制到 src-tauri/binaries/
```

**版本控制**：`BUN_VERSION` 变量在 `setup.sh` 中定义
**存储位置**：`src-tauri/binaries/`（已加入 .gitignore）

### 支持的平台

| 文件名 | 平台 | 来源 |
|--------|------|------|
| `bun-aarch64-apple-darwin` | macOS ARM (M1/M2) | GitHub Releases |
| `bun-x86_64-apple-darwin` | macOS Intel | GitHub Releases |

## 应用结构

```
MyAgents.app/
└── Contents/
    ├── MacOS/
    │   ├── app              # Rust 主程序
    │   └── bun              # 打包的 Bun 运行时 (Tauri 去除平台后缀)
    └── Resources/
        ├── server-dist.js   # 打包后的服务端代码 (单文件)
        └── claude-agent-sdk/# SDK 运行时依赖
            ├── cli.js       # CLI 入口
            ├── sdk.mjs      # SDK 主模块
            ├── *.wasm       # WebAssembly 模块
            └── vendor/      # 第三方依赖
```

## 运行时路径工具 (`src/server/utils/runtime.ts`)

统一的运行时路径检测工具，确保所有功能都能使用内置 bun，无需外部依赖。

### 核心函数

```typescript
// 获取脚本目录（运行时计算，避免 bun build 编译时硬编码）
getScriptDir(): string

// 获取 JS 运行时路径（优先内置 bun）
getBundledRuntimePath(): string

// 获取包管理器（用于安装 npm 包）
getPackageManagerPath(): { command, installArgs, type: 'bun' | 'npm' }

// 判断是否为 bun 运行时
isBunRuntime(runtimePath: string): boolean
```

### 路径优先级

**运行时路径** (`getBundledRuntimePath`):
1. 内置 bun (`Contents/MacOS/bun`)
2. 系统 bun (`~/.bun/bin/bun`, `/opt/homebrew/bin/bun`)
3. 系统 node (`/opt/homebrew/bin/node`, `/usr/local/bin/node`)
4. Fallback: `'node'`（依赖 PATH）

**包管理器** (`getPackageManagerPath`):
1. 内置 bun → `bun add`
2. 系统 bun → `bun add`
3. 系统 npm → `npm install`
4. Fallback: `'npm'`（依赖 PATH）

## MCP 安装与执行

### MCP 包安装 (`/api/mcp/install`)

使用内置 bun 安装 MCP 包到本地目录，无需用户安装 Node.js：

```
安装目录: ~/.myagents/mcp/<serverId>/
安装命令: bun add <package>  (使用内置 bun)
```

**流程**：
1. 创建安装目录和 `package.json`
2. 使用 `getPackageManagerPath()` 获取包管理器
3. 执行 `bun add <package>` 安装到本地
4. 返回安装结果和入口点路径

### MCP 执行 (`buildSdkMcpServers`)

**已安装的包**：
```typescript
// 查找本地安装的包
const localPkgJson = join(serverDir, 'node_modules', packageName, 'package.json');
if (existsSync(localPkgJson)) {
  const runtimePath = getBundledRuntimePath();  // 使用内置 bun
  result[server.id] = {
    command: runtimePath,
    args: [entryPoint],
    // ...
  };
}
```

**未安装的包（Fallback）**：
```typescript
const runtimePath = getBundledRuntimePath();
if (isBunRuntime(runtimePath)) {
  // 使用 bun x (bunx) 运行，类似 npx
  result[server.id] = {
    command: runtimePath,
    args: ['x', ...args],
    // ...
  };
} else {
  // Node fallback: 使用 npx（需要用户有 Node.js）
  // ...
}
```

## 生产构建流程

### 服务端打包

`build_macos.sh` 自动执行以下步骤：

1. **服务端代码打包**：使用 `bun build` 将 `src/server/index.ts` 打包成单文件 `server-dist.js`
2. **SDK 依赖复制**：复制 `@anthropic-ai/claude-agent-sdk` 运行时文件到资源目录
3. **Tauri 构建**：将所有资源打包进 App Bundle

```bash
# 构建命令
bun build ./src/server/index.ts --outfile=./src-tauri/resources/server-dist.js --target=bun

# SDK 复制（只复制运行时必需文件）
cp cli.js sdk.mjs *.wasm vendor/ → src-tauri/resources/claude-agent-sdk/
```

### SDK 路径解析

`agent-session.ts` 中的 `resolveClaudeCodeCli()` 实现分层解析：

1. **标准解析**：`require.resolve('@anthropic-ai/claude-agent-sdk/cli.js')`
2. **生产回退**：`process.cwd()/claude-agent-sdk/cli.js`（资源目录）

## 运行时检测

### Rust 侧 (sidecar.rs)

Bun 路径优先级：`Contents/MacOS/bun` → `Resources/binaries/bun` → 系统安装

服务脚本优先级：`Resources/server-dist.js`（生产）→ `src/server/index.ts`（开发）

### TypeScript 侧 (runtime.ts)

通过 `getScriptDir()` + `getBundledRuntimePath()` 确保路径正确：

```typescript
// getScriptDir() 返回运行时脚本目录
// 生产环境: .../Contents/Resources
// 开发环境: .../src/server/utils

const bundledBunPaths = [
  scriptDir.replace('/Resources', '/MacOS') + '/bun',
  resolve(scriptDir, '..', 'MacOS', 'bun'),
];
```

**⚠️ 注意事项**：
- 生产环境中 `server-dist.js` 直接在 `Resources/` 下，不是 `Resources/server/`
- 从 `Resources` 到 `MacOS` 只需上一级（`..`），不是两级（`../..`）
- 使用 `path.resolve()` 确保路径规范化，避免 `/a/b/../c` 风格的非规范路径
- 使用 `isBunRuntime()` 判断运行时类型，而非 `path.includes('bun')`

## 调试

**开发模式**：设置 `DEBUG=1` 或在设置中启用 `showDevTools`

```bash
DEBUG=1 open MyAgents.app
```

**生产诊断日志**：Rust 层 `[bun-out]` 和 `[bun-err]` 前缀的日志会捕获 Bun 进程输出。

## 常见问题

| 问题 | 原因 | 解决方案 |
|------|------|----------|
| `ENOENT: @anthropic-ai/claude-agent-sdk/cli.js` | SDK 未打包到资源目录 | 确保 `tauri.conf.json` 包含 `claude-agent-sdk` 资源映射 |
| Sidecar 立即退出 (Exit Status 1) | 依赖解析失败 | 检查 `server-dist.js` 打包是否成功 |
| 120s 超时 | 健康检查失败 | 查看 `[bun-err]` 日志定位根因 |
| `ProcessTransport is not ready for writing` | TypeScript 侧无法找到 bundled bun | 检查 `buildClaudeSessionEnv()` 中的路径检测逻辑 |
| MCP 安装失败 | 包管理器未找到 | 检查 `getPackageManagerPath()` 日志，确认内置 bun 路径正确 |

## 注意事项

1. **开发者首次 clone** - 必须运行 `./setup.sh` 下载 Bun 二进制
2. **最终用户** - 无需安装任何依赖（包括 Node.js）
3. **CI/CD** - 需在构建前运行 `./setup.sh` 或缓存 binaries 目录
4. **生产构建** - 必须使用 `./build_macos.sh` 确保正确打包服务端代码
5. **MCP 功能** - 完全使用内置 bun，用户无需安装 npm/npx

# Bundled Node.js 运行时架构

MyAgents 随应用提供单一 Node.js v24，用于 Sidecar、Plugin Bridge、MCP Server 和 `myagents` CLI。用户不需要安装系统 Node 才能运行产品功能；Node/npm 的精确组合以 `scripts/node-runtime.json` 为唯一构建权威，下载脚本和前端版本展示共同读取。开发用的 `package.json#packageManager` 不代表应用内置 npm。

## 获取、缓存与打包

Node 下载脚本从 nodejs.org 取得官方 target artifact，并维护两层目录：

- `src-tauri/resources/nodejs-cache/<platform>-<arch>-v<version>/`：按平台、架构和版本隔离的本地 cache；
- `src-tauri/resources/nodejs/`：当前 Tauri target 的 staging projection。

macOS/Linux 构建脚本在每个 target build 前从正确 cache 重建 staging，并验证版本、平台与架构。`resources/nodejs/` 不是跨 target 的权威缓存；双架构或交叉构建不能复用上一个 target 遗留的 staging。

Windows setup、dev build 和 release build 共用 `scripts/download_nodejs.ps1`，直接核验 staging 中 Node 的版本/平台/架构与 npm/npx 版本；不匹配则重新下载官方 ZIP 并用 robocopy 复制深层依赖。

npm 随官方 Node 发行包整组获取，禁止通过 `npm/latest` 或独立升级覆盖它。缓存复用和 staging 校验必须读取 npm 自身的 `package.json` 并检查 npm/npx 入口，不能仅凭 Node 版本命中缓存。需要调整组合时修改 manifest，且所选官方发行包必须自带声明的 npm；不匹配即准备失败。

打包后的主路径为：

| 平台 | Runtime |
| --- | --- |
| macOS / Linux | `Resources/nodejs/bin/node` |
| Windows | `resources/nodejs/node.exe` |

构建产物还包含 `server-dist.js`、`plugin-bridge-dist.mjs` 和 `cli/myagents.cjs`。这些业务 bundle 与 Node 一起由当前安装目录拥有，不投影到用户 HOME。

## Claude Agent SDK native child

Builtin Claude Agent SDK 自带 target-specific native executable；它是独立进程，不复用 MyAgents Node 的进程内状态。MyAgents 只通过 SDK transport 与它通信。

构建脚本从已安装的 `@anthropic-ai/claude-agent-sdk-<triple>` package 复制对应 binary，macOS release 还必须 codesign。路径、package 版本和 artifact 大小以 lockfile、安装包与构建脚本为准。

所有生产 builtin `query()` 经过 `src/server/utils/sdk-child-launch-guard.ts::createGuardedSdkQuery()`：

- `EPERM`、`EACCES`、`ENOEXEC` 属于 executable launch rejection，不得伪装成 Provider 或网络错误；
- Rust 按 executable identity 维护跨 Sidecar circuit 与有界 half-open probe；
- 只有 Rust 明确返回的 launch denial 能阻止本次启动；管理通道不可用时跳过 circuit，不能误杀可运行的 SDK；
- executable identity 随更新或重装变化，旧 circuit 自动失效；
- external runtime 不进入 builtin SDK circuit。

Builtin `anthropic-sub` 的 OAuth credential 仍由 Claude Code native credential store 拥有。MyAgents 不用 `CLAUDE_CONFIG_DIR` 重定向它，也不接管 token 生命周期。

## Runtime locator 与 PATH

`src/server/utils/runtime.ts` 是 Node/npm/npx 定位入口。产品自身的可执行链与交互 shell 的 PATH 有意不同。

### MyAgents-owned 入口

- Rust 启动 Sidecar、Plugin Bridge 和 CLI 时使用安装目录中 bundled Node 的绝对路径。
- `~/.myagents/bin/{myagents,myagents.cmd}` 是 Rust 原子生成的薄启动器，只回到当前 MyAgents executable 并透明转发 argv。
- `src-tauri/src/cli.rs` 从当前 executable 的受信 resource root 定位 Node 与 `myagents.cjs`；资源缺失或路径逃逸时 fail closed，不回退系统 Node 或 HOME 里的旧业务脚本。

### SDK shell

AI 的 Bash 工具需要尊重用户开发环境，因此 `buildClaudeSessionEnv()` 构造的 PATH 顺序是：

1. `~/.myagents/bin`，保证产品保留命令不被 shadow；
2. 用户系统 Node 目录；
3. bundled Node 目录；
4. MyAgents-localized npm global bin；
5. inherited PATH。

SDK shell 不设置全局 `npm_config_prefix` 等会干扰 nvm 的变量。需要固定 npm 安装目录时，在单条命令上显式设置。

### Task command Detector

Activation Trigger 的 command Detector 不是交互 shell。bare `node` / `node.exe` 固定解析到 bundled Node；其它 bare executable 走 `system_binary::find()`。它使用结构化 executable、args 与 cwd，不经 shell 字符串重拼。

Detector 在 `env_clear()` 后只恢复 OS、证书、general proxy、PATH 和 UTF-8 基线，不继承 Provider credential、Session 控制端口或启动 shell 的任意变量。

## npm / npx 与 MCP

`src/server/utils/mcp-command.ts::resolveNpxMcpInvocation()` 是 stdio MCP 的 npx 解释入口，Builtin Claude、Managed Codex 和 MCP warmup 共用：

- 优先系统 npx，再用 bundled npx 和 runtime sibling fallback；
- Windows 不把 `.cmd` shim 直接交给不支持它的原生 spawn，而是解析为同一 Node distribution 的 `node.exe + npx-cli.js`；
- product preset 使用 `src/shared/mcpPackages.ts` 的精确 package spec；
- 用户附加参数只追加，不覆盖 preset 的 package / 基础参数；
- localhost 保护和 proxy env 由对应进程 owner 注入。

标准 `playwright` preset 仍是上游 stdio MCP。应用自有「浏览器」由 Global Sidecar Browser Host 和 Rust resource owner 管理，不通过 npx，也不从 bundled Node、系统 Chrome 或用户 Playwright cache 猜浏览器。Chromium artifact 不是 Node bundle 的一部分。

## In-process builtin MCP

User-toggleable builtin MCP 通过 `src/server/tools/builtin-mcp-meta.ts` 登记轻量 metadata，再由 `getBuiltinMcpInstance()` 按需加载工具模块和构建 schema。禁止在 metadata 模块顶层导入 SDK 或 Zod，否则每个 Sidecar 冷启动都会支付全部 schema 初始化成本。

动态 Channel 工具由自己的 context owner 注入，不进入静态 metadata registry。Task、Goal 和 IM media 等产品能力由 `myagents` CLI surface 拥有，不应重新复制成一套 builtin MCP。

详见 [`sdk_custom_tools_guide.md`](sdk_custom_tools_guide.md)。

## 构建不变量

正式构建必须：

1. 为当前 target staging 正确的 Node、SDK native child 和业务 bundle；
2. 用 CommonJS 语义发布 `cli/myagents.cjs`；
3. 保持依赖 package-local 文件结构的 runtime package 为 external resource，不能错误地压进单文件 bundle；
4. 检查 release resource 中没有跨架构或旧 target 残留；
5. 让 Rust owner 对 resource path 做 no-follow / root containment 校验。

构建命令、签名和平台依赖由 `specs/guides/` 中的对应指南维护。

## Windows Git Bash

Builtin Claude 的 shell 工具在 Windows 需要 Git Bash。安装器与启动环境负责提供或定位它，SDK 使用 `CLAUDE_CODE_GIT_BASH_PATH` 或受控 PATH。缺失时应呈现明确的 runtime dependency 错误；不要把 Git Bash 当成 Node fallback，也不要通过 `cmd /c` 模拟 Bash。

## 验证

- locator 测试覆盖 dev/release layout、Windows wrapper 和 resource 缺失；
- cache/staging 测试或构建检查覆盖 target、arch、version；
- CLI launcher 测试覆盖空格、Unicode、`%`、argv 透明转发与旧 payload 替换；
- MCP invocation 测试覆盖系统/bundled npx 及 Windows `.cmd`；
- release smoke 在无系统 Node 的环境验证 Sidecar、Plugin Bridge、CLI 和 builtin MCP。

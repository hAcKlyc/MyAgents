# Bundled Node.js 运行时架构

MyAgents 随应用提供单一 Node.js v24，用于 Sidecar、Plugin Bridge、MCP Server 和 `myagents` CLI。用户不需要安装系统 Node 才能运行产品功能；内置 Node/npm 的精确组合以 `scripts/node-runtime.json` 为唯一构建权威，下载脚本和前端版本展示共同读取。

开发与构建工具链由 `package.json#engines` / `devEngines` 定义最低版本：Node `>=24.14.0`、npm `>=11.15.0`。`.nvmrc` 推荐与内置运行时一致的 Node 版本。setup 的无依赖版本检查与 npm 的安装、构建检查通过回归测试保持一致。原生扩展仍须针对内置 Node 的 ABI 重建，不能用构建机版本替代运行时 identity。

## 获取、缓存与打包

Node 下载脚本从 nodejs.org 取得官方 target artifact，并维护两层目录：

- `src-tauri/resources/nodejs-cache/<platform>-<arch>-v<version>/`：按平台、架构和版本隔离的本地 cache；
- `src-tauri/resources/nodejs/`：当前 Tauri target 的 staging projection。

macOS/Linux 构建脚本在每个 target build 前从正确 cache 重建 staging，并验证版本、平台与架构。版本诊断读取已验证的 metadata，不要求 host 能运行目标二进制。`resources/nodejs/` 不是跨 target 的权威缓存；双架构或交叉构建不能复用上一个 target 遗留的 staging。

Windows setup、dev build 和 release build 共用 `scripts/download_nodejs.ps1`，直接核验 staging 中 Node 的版本/平台/架构与 npm/npx 版本；不匹配则重新下载官方 ZIP 并用 robocopy 复制深层依赖。

npm 随官方 Node 发行包整组获取，禁止通过 `npm/latest` 或独立升级覆盖它。缓存复用和 staging 校验必须读取 npm 自身的 `package.json` 并检查 npm/npx 入口，不能仅凭 Node 版本命中缓存。需要调整组合时修改 manifest，且所选官方发行包必须自带声明的 npm；不匹配即准备失败。

Windows NSIS 在进程清理后、复制新资源前完整删除安装目录下的 `nodejs/`，卸载也清理同一组件；删除失败立即停止，不使用延迟到重启的删除。自动更新、手动覆盖升级和同版本重装共用此入口，已有残留随下一次安装清除。仅覆盖当前文件清单会保留旧 npm 已移除的嵌套依赖，Node 的就近解析可让它们遮蔽新依赖（#636）；npm/npx 的 `--version` 成功不能证明该模块树可用。插件安装不拥有此目录，也不通过换包管理器修复它；用户 `.myagents/` 数据不在清理范围。

打包后的主路径为：

| 平台 | Runtime |
| --- | --- |
| macOS / Linux | `Resources/nodejs/bin/node` |
| Windows | `resources/nodejs/node.exe` |

构建产物还包含 `server-dist.js`、`plugin-bridge-dist.mjs` 和 `cli/myagents.cjs`。这些业务 bundle 与 Node 一起由当前安装目录拥有，不投影到用户 HOME。

## Integrated DSH

DSH Runtime 使用同一个 bundled Node，不增加第二份 Node，也不回退到系统 Node。`scripts/node-runtime.json` 拥有产品内置 Node/npm 组合；DSH handoff 的 Runtime manifest 拥有构建 provenance 和所需 Node 版本。内置运行时当前固定为 Node `24.20.0` / npm `11.19.0`，其中 Node 必须与 handoff 所需版本一致；DSH 的 npm 记录仅表示构建 provenance，Runtime 不执行 npm。构建 MyAgents 的本机 Node/npm 只需满足开发工具链最低版本，不必与内置运行时相等。

`src-tauri/resources/integrated-runtimes/dsh/` 保存完整不可变交付。`ingest:dsh-runtime` 在临时副本内设置可打包权限并验证后原子接纳；`verify:dsh-runtime` 校验交付、契约与所需 Node 版本；开发 freshness 检查还对照配置的 Runtime 仓库 HEAD。构建默认从绑定的 GitHub Release 准备 DSH；本地来源只能显式选择已验证 handoff，不在打包时从兄弟仓库临时编译。

DSH 准备入口只核对 `scripts/node-runtime.json` 的 Node 版本与 handoff 所需版本，不重复探测目标 Node/npm。Node 下载器负责目标资源的版本、架构与完整性。Release 打包以发布归档摘要验证完整字节；本地 handoff 和显式资源校验使用构建机 Node 调用官方 `verifyBatch3IntegrationHandoffReport()`，验证文件与契约，不调用包含原生 Runtime self-check 的 `verify.mjs`。目标运行验证由 DSH 各平台发布流程负责，跨目标打包不执行目标 Node，也不因 Intel DSH 校验要求 Rosetta。

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

- Rust 启动 Sidecar 时优先使用安装目录中 bundled Node 的绝对路径：先查 resource root，再查 executable-relative layout，最后调用 `system_binary::find()` 查找 Node。最后一步虽注释为开发回退，代码没有仅 debug 生效的限制；不能宣称 Sidecar 生产环境绝不回退系统 Node。
- Plugin Bridge 的安装、repair 和启动共用 `im/bridge.rs::find_bundled_node_npm()`，仅接受应用资源中的完整 Node/npm；缺失时明确报错，不回退系统发行包。仅该子进程的 PATH 前置内置 Node 目录。
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

这里的“系统 Node 目录”是 `getSystemNodeDirs()` 枚举的常见位置，并不等于原终端 PATH 的完整优先级。macOS/Linux 按 Homebrew、`/usr/local/bin`、`/usr/bin`、Volta、nvm/current、fnm/current 排序；只存在于 inherited PATH 的自定义版本目录在 bundled 之后。Shell 初始化、版本管理器或命令显式修改 PATH/指定绝对路径后，实际选择可以改变。此处没有版本兼容性探测，也不会因系统 Node 较旧或命令失败就自动再试 bundled Node。

### 外部 Runtime 与应用内终端

- Claude Code / Codex 等外部 Runtime 的进程环境走 `runtimes/env-utils.ts → getShellEnv()`，不是 `buildClaudeSessionEnv()`。macOS/Linux 的 PATH 顺序为用户交互登录 Shell 检测结果、inherited PATH、缺失的兜底目录；Windows 使用 inherited PATH，再追加兜底目录。保留用户目录顺序，去重时不按软件版本重排。Shell 发现失败时保留 inherited PATH 优先级。
- 外部 Runtime 的检测、Codex 模型查询/诊断与会话启动，必须先等待 `ensureShellPath()` 完成首次发现，再从即将交给子进程的同一份 env 解析 CLI 绝对路径。发现异步执行且有五秒超时，不阻塞 Sidecar HTTP 启动。Rust `system_binary` 使用相同优先规则，CLI 版本探测也传入匹配的 PATH，使 npm shim 的 `env node` 使用同一用户环境。两端规则通过 `runtime-search-path.json` 共享案例验证。
- 环境发现按当前进程生命周期缓存，默认对齐用户 Shell 启动配置；修改默认 Node/Shell 配置后重启应用重新发现。独立终端窗口中临时执行的 `fnm use`、alias/function 或项目切换 hook 不属于自动同步范围。CLI 内部 Shell 的最终环境由相应 Runtime 决定。应用自有 Node 仍使用资源定位入口，不参与外部 CLI 的选择。
- MyAgents 自有 CC SessionStart forwarder 使用当前 Sidecar `process.execPath`，路径按 Bash 参数安全引用，并显式声明 hook shell。保留旧版 CC 的 command-hook 协议，不要求 2.1.139 才增加的 exec-form args；Windows 沿用产品的 Git Bash 依赖。它不改变外部 Runtime 的 AI Shell PATH。
- 应用内 PTY 终端由 `src-tauri/src/terminal.rs::inject_terminal_env()` 注入：`~/.myagents/bin`、应用可执行资源目录、bundled Node、inherited PATH。因此它的初始优先级与内置 AI 的 Shell 不同；终端 Shell 加载用户配置后还可能重排。
- `myagents tool add` 注册的用户工具也不等同于官方 CLI：POSIX 启动器使用 `#!/usr/bin/env node`，随后沿用该 Node；Windows shim 优先使用写入时的 bundled Node 绝对路径，失效后才回退 PATH 上的 Node。

### Task command Detector

Activation Trigger 的 command Detector 不是交互 shell。bare `node` / `node.exe` 使用 Sidecar 的 Node locator，优先 bundled，缺失时也有上述系统查找回退；其它 bare executable 走 `system_binary::find()`。它使用结构化 executable、args 与 cwd，不经 shell 字符串重拼。

Detector 在 `env_clear()` 后只恢复 OS、证书、general proxy、PATH 和 UTF-8 基线，不继承 Provider credential、Session 控制端口或启动 shell 的任意变量。

## npm / npx 与 MCP

`src/server/utils/mcp-command.ts::resolveNpxMcpInvocation()` 是 stdio MCP 的 npx 解释入口，Builtin Claude、Managed Codex 和 MCP warmup 共用：

- 优先系统 npx，再用 bundled npx 和 runtime sibling fallback；
- Windows 不把 `.cmd` shim 直接交给不支持它的原生 spawn，而是解析为同一 Node distribution 的 `node.exe + npx-cli.js`；
- product preset 使用 `src/shared/mcpPackages.ts` 的精确 package spec；
- 用户附加参数只追加，不覆盖 preset 的 package / 基础参数；
- localhost 保护和 proxy env 由对应进程 owner 注入。

`buildMcpStdioLaunchConfig()` 统一配置检查、preset 预热、initialize probe、builtin prewarm/live 与 Managed Codex 的 stdio 参数：默认 PATH 复用 `buildSessionExecutablePath()`，随后将选中 npx/Node 的目录移到最前，最后合并 per-server env。Windows 统一输出大写 `PATH`，覆盖 MCP SDK 同名默认值，避免 `Path` 与 `PATH` 并存。预热同时使用 server.env 和当前 workspace cwd；custom command 检查使用同一解析结果和 PATH，无需外部 `which/where`。

“系统 npx 优先”特指常见目录中的入口选择；POSIX 仍执行 npx 文件（可包含包管理器 shim），Windows 使用完整 Node/npx CLI 配对。用户显式 command/env 继续生效，npm 的包内 `.bin` 优先级也保持；这不是强制所有 MCP 使用内置 Node。Managed Codex 仅通过每个 MCP 的原生 `env.PATH` 设置子进程 PATH，不污染 Codex parent 或 AI Shell；用户 env 仍经过既有安全校验，代理由对应 Runtime owner 决定。

全局设置预热只缓存包，CLI `mcp test` 只证明当前全局配置可 initialize；它们不拥有 Session 的 effective MCP 或 Runtime acceptance。Managed Codex 仍可能拒绝受保护 env/不支持的 transport，system CLI Runtime 仍自管自己的 MCP。实际可用状态由 Session adapter 的现有 readback 给出。

### OpenClaw 插件安装

`src-tauri/src/im/bridge.rs` 初装只运行内置 Node + `npm-cli.js install <spec> --omit=peer`，保留包生命周期脚本；repair 复用本次已选择的同套运行时，执行 `install --ignore-scripts --omit=peer`，保持既有 best-effort 语义。SDK shim 始终最后写入。初装失败保留实际退出码/诊断，不换系统 npm 重跑生命周期脚本，也不误报“未安装 Node”。

已有插件不自动重装；下一次 Bridge 启动使用相同内置 Node 与 PATH 策略。插件显式可执行路径和 npm 包内 `.bin` 仍遵从包自身语义。`runtime.ts::getPackageManagerPath()` 没有生产调用方，不能用它代表插件安装路径。

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

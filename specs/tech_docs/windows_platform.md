# Windows 平台架构

本文记录 Windows 特有的 path、process、WebView2、file IO 与 packaged runtime 边界。构建和发布命令由 [`../guides/windows_build_guide.md`](../guides/windows_build_guide.md) 与脚本本身拥有；跨端 UI 真机矩阵见 [`windows_cross_platform_review.md`](windows_cross_platform_review.md)。

## 路径与 identity

### Workspace path

跨 config、Task、Session、Agent 或 UI store比较 workspace时，使用：

- `normalizeWorkspacePathIdentity()` 生成 Map/Set key；
- `workspacePathsEqual()` 比较两个可能为空的路径。

Windows normalization处理盘符大小写、`/` / `\` 和 trailing separator；Unix仍保持 case-sensitive。不要把 display path、canonical filesystem path和持久化 identity混为同一个字段。

### 文件系统、URL 与 archive

- Node filesystem path ↔ `file://` 使用 `pathToFileURL` / `fileURLToPath`；
- app内 attachment/resource使用 `myagents-resource` protocol helper；
- ZIP、manifest和installed metadata中的 relative key用 `/`，不是 OS separator；
- Rust `PathBuf` 交给 Node、npm、URL或child process前走现有 `normalize_external_path`，剥离 `\\?\`；
- 不存在的 write target走 workspace lexical resolver；已存在 source才可依赖 canonical identity；
- source、ancestor和publish target的 reparse-point检查由 workspace/path safety owner完成。

不要手拼 slash、`file://` prefix或用字符串 `starts_with` 做 containment。

### Managed global Skill junction

`~/.myagents/skills/<name>` 是 global Skill 的物理 authority；`<workspace>/.claude/skills/<name>` 可以是 Windows junction projection。通过 projection写入会直接修改全局源。

所有 workspace mutation command统一调用 `path_safety::reject_managed_global_skill_mutation`，覆盖链接叶子、后代、尚不存在但祖先受管的路径和 broken reparse point。普通 project-owned Skill目录仍可写；read、reveal和copy-out允许。

Runtime admission基于 `global-skill-inventory.ts` 的完整快照和可信链接 identity。命名冲突只在证据足够时 block单个候选；不自动 rename/delete/merge，也不建立 watcher或后台 repair。

## UTF-8 boundary

Claude SDK 的 Bash output最终以 UTF-8 string进入 Session JSONL/SSE，但 Windows child可能按 ANSI/OEM code page输出。`buildClaudeSessionEnv()` 为 SDK subprocess设置：

- `LANG=C.UTF-8` / `LC_ALL=C.UTF-8`；
- `PYTHONUTF8=1` / `PYTHONIOENCODING=utf-8`；
- `LESSCHARSET=utf-8`；
- MyAgents-owned `BASH_ENV` prelude，在 Git Bash启动时切换到 UTF-8 code page。

PowerShell不读取 `BASH_ENV`。机器可读 PowerShell结果应在 producer端转成 base64(UTF-8(JSON)) 等 ASCII-safe envelope；不要在 Renderer修复已经错误解码的 string。

用户可编辑 JSON读取边界剥 UTF-8 BOM。严格协议遇到非 UTF-8应返回可诊断错误；lossy decode只用于人读 stderr。

## Process owner

### Live lifecycle

App 拥有的后台 Rust child 默认通过 `crate::process_cmd`：

- 普通短进程：`process_cmd::new()`，Windows使用 `CREATE_NO_WINDOW`；
- 会派生后代的长生命周期进程：`spawn_tree()`，owner持有 `ChildTree`。

Windows `spawn_tree()` 先 suspended创建根进程、绑定 `JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE` Job Object，再恢复线程，避免 child在进入 Job前逃逸。stop / Drop终止整棵树。`CREATE_NO_WINDOW` child没有可靠 console signal，不增加无效 graceful wait。

创建入口在 App shutdown关闭后必须拒绝新 spawn；owner等待已登记 children，不能边退出边产生新进程。

需要继承用户 console 的 CLI mode 是明确例外，使用 raw `Command`；Terminal 的进程创建由 `portable-pty` / ConPTY owner 管理。不要把后台进程的 `CREATE_NO_WINDOW` 规则套到这两条交互路径。

### Recovery

`process_cleanup::kill_stale_processes()` 只用于 prior instance已死亡后的启动恢复和 updater verified-clean。Normal shutdown不扫描全机进程，也不按 `node.exe` / `chrome.exe` 名称清理。

Task Activation Detector同样拥有 Job Object。timeout、stdout超限、Task stop/delete和App shutdown都结束同一树；structured executable、args和cwd不经 `cmd /c`。

### Executable discovery

`system_binary::find()` 补充 GUI应用缺少的常见 PATH。具体 runtime优先使用自己的 locator：

- Sidecar、Plugin Bridge和CLI使用 bundled Node绝对路径；
- Task Detector的 bare Node固定到 bundled Node；
- SDK shell允许系统 Node优先、bundled Node兜底；
- managed runtime使用签名/验证后的绝对 executable，不回退 PATH同名程序。

详见 [`bundled_node.md`](bundled_node.md) 和 [`multi_agent_runtime.md`](multi_agent_runtime.md)。

## CLI launcher

`%USERPROFILE%\.myagents\bin\myagents.cmd` 和 extensionless `myagents` 是 Rust生成的薄 launcher，只调用当前 `MyAgents.exe` 的私有 CLI入口并透明转发 argv。业务代码只存在安装目录 `resources/cli/myagents.cjs`。

Launcher使用 no-follow检查、临时文件和原子 replace；路径 quoting必须覆盖空格、Unicode和 `%`。CLI mode attach parent console，并只使用当前 bundle的 Node和CLI。资源缺失时fail closed，不执行HOME旧 payload或系统 Node。

## WebView2 与 CSP

Windows production document origin、IPC和custom resource URL与macOS不同：

- Tauri IPC通过 `http://ipc.localhost` 的 Fetch，需要同时被 `default-src` / `connect-src` 允许；
- `fetch-src` 不是标准 CSP directive，不能代替 `connect-src`；
- loopback只出现在 control-plane `connect-src`，工具/用户 attachment subresource走 `myagents-resource` origin；
- `srcdoc` widget继承 top-level CSP，已登记外部库在 render时替换为bundled inline source；
- `webview_policy.rs` 为所有共享 data directory的 WebView统一选择 Windows Fluent Overlay scrollbar。

CSP authority是 `src-tauri/tauri.conf.json`。新增 network/subresource surface必须明确归入 control面或登记的数据面，不能为了通过WebView2直接扩大 `http:` / CDN通配。

### 空闲 CPU / GPU / I/O 诊断

持续负载必须追到仍在工作的生产者：JS timer/rAF、CSS 动画、媒体播放、native browser 页面或真实业务事件。页面复杂度会放大一次更新的成本，但不能单凭历史消息数量认定空闲持续渲染的原因；Chat 已有分页和虚拟列表。

- 只采样 MyAgents 精确进程树，按 `--type` 区分 browser、renderer、GPU 和 utility；全机同名 `msedgewebview2.exe` 不都属于本应用。
- `Win32_Perf*Data_PerfProc_Process` 的 I/O bytes 包含文件、网络和设备 I/O，不能换算成 SSD 写入量。目录净大小、缓存文件存在或单次修改时间也不能证明持续原地改写。需要用 ProcMon/ETW 的具体路径、操作和字节量确定磁盘写入；参见 [Microsoft 计数器定义](https://learn.microsoft.com/en-us/previous-versions/aa394323(v=vs.85))。
- GPU 重启必须有进程退出/启动或失败事件；“存在 ShaderCache / GPUCache”不构成证据。性能定位优先采集 DevTools Performance 与 WebView2 ETW trace，见 [Microsoft WebView2 性能指南](https://learn.microsoft.com/en-us/microsoft-edge/webview2/concepts/performance)。
- 对比前台会话、非会话 Tab、窗口隐藏/最小化、恢复和托盘彻底退出；记录桌宠、内嵌浏览器与媒体是否活跃。未经控制的低负载样本不能用作前台高占用问题的修复验收。
- `--autoplay-policy=no-user-gesture-required` 只是播放权限，不会自行创建音频流。媒体 owner 仍须在结束/失败时卸载资源，并拒绝所属 UI 关闭后的异步播放，见 [音频资源生命周期](tool_attachment_pipeline.md#音频播放资源生命周期)。

## Native Browser child

应用自有「浏览器」为每个 Product Session建立独立 BrowserContext和原生窗口/child WebView。Browser Host由Global Sidecar拥有，Chromium后代进入同一 process tree。

Renderer `BrowserPanel` 通过 lifecycle token和常驻 geometry reconciler维护OS child bounds；split过渡、拖拽和overlay期间隐藏native view但继续更新Rust cache。不能用一次性 ResizeObserver或transition-end采样替代。

Browser resource由Rust按随App签名的lock下载官方artifact、校验URL/size/SHA-256并安装到应用数据目录。Release不捆绑Chromium，也不回退系统Chrome、npx或用户cache。正常shutdown先做有界Browser checkpoint/close，再由Job Object containment。

## Windows file IO

Config/workspace写入沿现有owner的 lock、disk reread/merge、temp write、fsync和atomic rename。

`cmd_fsync_path` 的Windows差异：

- `FlushFileBuffers` 需要可写handle，因此 `opts_for_fsync()` 使用对应权限；
- Defender/indexer/sync工具可能短暂返回sharing violation或access denied，helper只对精确transient错误做有限退避；
- parent directory fsync在Windows是no-op，不伪造Unix语义。

不能把所有权限错误都重试，也不能在失败后继续刷新UI为成功。

## Recording、Document 与 Media Worker

Windows microphone/system audio使用 cpal WASAPI；system audio从默认输出设备取得loopback config，不依赖ffmpeg、PowerShell、浏览器capture或虚拟声卡。Recording admission冻结exact device ID，设备变化返回 `RECORDING_DEVICE_CHANGED`，不静默切换。

Document/Media Worker及native inference artifact由resource lock和target manifest拥有：

- executable通过 `spawn_tree()` 进入Job Object；
- DLL/model只从manifest的绝对resource path加载；
- 不搜索PATH、系统ONNX Runtime/PDFium或用户cache；
- document source/output拒绝reparse escape；
- callback只写bounded buffer/atomic状态，不执行阻塞IO。

详细协议见 [`document_processing.md`](document_processing.md) 和 [`recording_and_speech_recognition.md`](recording_and_speech_recognition.md)。

## Proxy

Localhost Rust HTTP统一走 `crate::local_http` 并显式no-proxy。外部request/subprocess按general或Provider owner走 `proxy_config`；未选择应用代理时继承系统/TUN baseline，不强制direct。完整规则见 [`proxy_config.md`](proxy_config.md)。

## Builtin shell tools

`buildClaudeSessionEnv()` 在 Windows 显式设置 `CLAUDE_CODE_USE_POWERSHELL_TOOL=1`。SDK 的 PowerShell 工具启用不再依赖上游 rollout（MyAgents 的非必要联网策略会关闭该机制）；产品工具目录同时保留 Bash 与 PowerShell，由模型选择，权限仍由既有 policy 裁决。macOS / Linux 不设置此开关。

Bash 工具在 Windows 使用 Git Bash；PowerShell 工具由 SDK 直接执行 PowerShell。NSIS installer 检测并可安装随包 Git installer；开发或自定义环境也可通过 `CLAUDE_CODE_GIT_BASH_PATH` 指定。不能通过 `cmd.exe` 模拟 Git Bash 或把 shell 缺失归因于 Node。

具体Git artifact/version、构建前置和签名以 `build_windows.ps1`、NSIS模板及Windows构建指南为准。

## 验证

确定性测试覆盖path identity、URL conversion、reparse safety、launcher quoting、process tree、CSP/resource URL、UTF-8/BOM、fsync retry policy和runtime locator。

Windows release-like smoke还必须在Explorer启动、无系统Node/native DLL fallback、断网/代理组合和有空格/Unicode安装路径下验证：

- Builtin/External Runtime与Git Bash；
- Sidecar/Plugin Bridge/Task Detector child-tree cleanup；
- attachment/widget/Browser child WebView；
- microphone/WASAPI loopback与workers；
- NSIS install、updater handoff、Defender/file-lock场景。

# Pit-of-Success 模块完整规范

> "正确路径默认化"——把容易踩的坑做成"不可能写错"。本文档汇总所有 helper 层的 Problem / Surface / Invariants / Don't 四要素规范。

本文档是 Pit-of-Success helper 的**唯一完整规范**，包含 API surface、不变量、踩坑根因与迁移指南。根 `CLAUDE.md` 只保留跨任务心智模型和按需路由；可静态判定的约束以 lint / 测试为可执行契约。

## 目录

**Rust 层**
- [`local_http`](#local_http) — 防系统代理拦截 localhost
- [`process_cmd`](#process_cmd) — 防 Windows 控制台窗口弹出
- [`proxy_config`](#proxy_config) — 子进程 NO_PROXY 注入
- [`system_binary`](#system_binary) — 系统工具查找（Finder PATH 缺失）
- [`normalize_external_path`](#normalize_external_path) — Windows `\\?\` 长路径前缀剥离
- [`filesystem_capacity::available_space`](#filesystem_capacity) — 查询目标路径所属文件系统的可用容量
- [`durable_fs`](#durable-fs) — 跨平台目录持久化与 no-replace rename
- [`tauri::async_runtime::spawn`](#async_runtime) — 防 macOS startup-abort
- [Session watcher](#session-watcher) — 文件系统观察索引

**跨进程与持久化 helper**
- [`withConfigLock` / `with_config_lock`](#withconfiglock) — config.json 跨进程串行写入
- [`withFileLock` / `with_file_lock`](#withfilelock) — 单写者文件原子性
- [`DurableRecordJournal`](#durable-record-journal) — Record append-only 事实的 typed JSONL durability
- [`copyPlainText`](#renderer-clipboard) — WebView 普通文本复制 fallback + 真实成功语义
- [`killWithEscalation`](#killwithescalation) — 子进程 stop 升级链
- [`withAbortSignal` / `cancellableFetch`](#cancellation) — 统一 cancel 协议
- [`maybeSpill` + `/refs/:id` + SSE 优先级](#maybespill) — 大 payload 分流
- [Tauri SSE subscription authority](#tauri-sse-subscription) — Rust owner 路由、重试与 connected 语义
- [`withLogContext` + ALS pipeline](#withlogcontext) — 自动注入 correlation
- [`DeferredInitState` + readiness endpoints](#deferredinitstate) — 三分健康探针

**Node.js 辅助层**
- [`fs-utils`](#fs-utils) — 跨平台 mkdir / 目录判定 + 断链 symlink 探针（cpSync C++ 异常）
- [`subprocess`](#subprocess) — Node 子进程 stream 形态适配
- [`file-response`](#file-response) — 流式 HTTP 文件响应 + 渲染器直连接口的 CORS/CSP
- [Context-window suffix helpers](#context-window-suffix) — >200K 模型上下文窗口解锁（provider-scoped lookup + `[1m]` wrap + env cap）

**结构性其他**
- [Builtin MCP 懒加载](#builtin-mcp) — META/INSTANCE 两层架构
- [snapshot helpers](#snapshot-helpers) — owned vs live-follow 命名分裂
- [legacy Cron startup migration](#legacy-cron-migration) — 后端启动期幂等迁移
- [workspace_files 路径解析双轨](#workspace-files) — 写侧 lexical / 读侧 canonical
- [`workspacePath` 工作区路径标识比较](#workspace-path-identity) — 跨存储路径相等判定（防 Win 斜杠/盘符误判）
- [Project / Agent workspace authority](#project-agent-workspace-authority) — ID 选配置、Project 选路径、旧字段仅兼容读取
- [Client-action 斜杠命令](#client-action-slash) — 渲染层 UI 动作命令，名字保留、勿进文本插入 builtin 清单
- [Theme package 与 Tailwind bridge](#theme-tailwind-bridge) — runtime Theme 值与编译期 utility 映射分离
- [System-skill 同步完整性门控](#system-skill-sync) — 验源完整再清目标 + 全落地才写版本戳
- [同步 Tauri 命令与主线程冻结](#sync-tauri-command) — 阻塞命令改 async + spawn_blocking，否则 WKWebView 整体冻结
- [Test classification + non-credentialed no-egress](#test-classification-no-egress) — server 测试显式分层，非 credentialed Node 测试禁止真实出站

---

<a id="test-classification-no-egress"></a>
## Test classification + non-credentialed no-egress

**Problem.** 旧 `stateful` 测试池把两类东西混在一起：可稳定进 CI 的后端集成测试，以及需要真实 Provider / SDK / upstream network 的 smoke 测试。结果是高价值集成测试长期不进 CI，后续 AI 也容易新增裸 `src/server/**/*.test.ts`，不知道它到底应该跑在哪个 gate。

**Surface.**
- `vitest.config.ts` 四池：`unit` / `dom` / `integration` / `credentialed`
- `scripts/check-test-classification.mjs`：`npm run test:classification`
- `src/test/setup-no-egress.ts`：`unit` / `integration` project 的 no-egress setup

**Invariants enforced.**
- server 测试文件名必须是 `*.unit.test.ts` / `*.integration.test.ts` / `*.credentialed.test.ts`
- `integration` 与 `credentialed` include 不重叠；裸 `src/server/**/*.test.ts` 直接失败
- `unit` / `integration` 不能访问非 loopback 网络；`fetch` / undici / `http(s)` / `net` / `tls` / `dns` 的常见出口都被 no-egress guard 拦截
- 非 credentialed 测试不能直接 import `child_process`；确需跨进程验证时必须在 `scripts/check-test-classification.mjs` 加窄 allowlist 和注释
- 真实 Provider / SDK / upstream smoke 只能进 `credentialed`，不被 `npm test` 和 public CI 跑到

**Don't.** 不要为了测试方便在生产 `RuntimeType`、config、UI 或 route 中新增 `mock` 分支；fake runtime 应只在测试层 mock `runtimes/factory.ts`，并伪装成真实 runtime type。不要用 `skip` 或弱断言让失败测试“变绿”；先判断是产品 bug、测试契约漂移，还是测试应迁入 `credentialed`。

<a id="local_http"></a>
## `local_http` (`src-tauri/src/local_http.rs`)

**Problem.** 用户系统代理（Clash / V2Ray）配置不完善时会拦截 `127.0.0.1`，应用内 Sidecar / admin-api / cron-tool / bridge-tools 等 localhost 通信被代理拦下 → 502 / connection refused。每个 reqwest 调用点都需要 `.no_proxy()`，集中维护成本高。

**Surface.**
- `crate::local_http::builder()` — 异步 reqwest::ClientBuilder，预置 `.no_proxy()`
- `blocking_builder()` — 同步孪生
- `json_client()` — 默认 JSON 头
- `sse_client()` — SSE 连接（无超时 + Accept: text/event-stream）

**Invariants enforced.**
- 所有连接 localhost 的 reqwest 都通过 helper，不会忘记加 `.no_proxy()`
- proxy_config 不存在副作用——helper 不读取系统代理环境变量

**Don't.** 任何 `reqwest::Client::builder()` / `reqwest::Client::new()` 直接连 `127.0.0.1`。即使是 "看起来一定不会被拦"的环境也禁止——出问题难以排查。

---

<a id="tauri-sse-subscription"></a>
## Tauri SSE subscription authority

**Problem.** Renderer 用 raw Sidecar URL 启动一次性 Rust stream，再靠一次性 error event 和有限 JS timer 重建连接，会同时缓存旧端口、误把 command ack 当 connected，并在 EOF/error event 丢失时永久假在线。

**Surface.** `sse_proxy.rs` 的长期 supervisor；`SidecarManager::resolve_session_sidecar_url_for_frontend_owner()`；Rust `{ transportGeneration, data }` envelope；Renderer `SseConnection.isActive()`。

**Invariants enforced.** Tauri transport connect/EOF/error/read-timeout/retry 只归 Rust；每次 attempt 都用 `sessionIdHint + SidecarOwner` 向 SidecarManager 取当前端口。command ack 只代表 subscription attachment，第一条新 generation envelope 才代表 Renderer 观察到物理流。subscription generation 与 transport generation 不得合并；旧 generation 在 cleanup 和 emit 两处都 fail closed，stop/replacement 返回后旧 task 不得再向复用的 event namespace 发布。Browser EventSource retry 是独立开发路径。

**Don't.** 不向 `start_sse_proxy` 传 Renderer 构造的 URL；不以 `sse:*:error`、Sidecar restart event、React watchdog 或有限 JS retry 作为 Tauri transport authority；不因 SSE disconnect abort turn；不为 owner→port 建第二张 map。

---

<a id="process_cmd"></a>
## `process_cmd` (`src-tauri/src/process_cmd.rs`)

**Problem.** Windows 上 GUI 应用（Tauri）直接启动子进程（node.exe Sidecar / Plugin Bridge / npm install）会弹出黑色控制台窗口。长生命周期 Node 进程还会创建 SDK / MCP 后代；如果所有者只保存直接 `Child`，正常退出时只能按 argv 猜测哪些后代属于 MyAgents，既可能漏掉后代，也可能误杀同机的外部进程。在 Windows 上先启动再调用 `taskkill /T`，还会留下 wrapper 提前退出、Job Object 尚未绑定的竞态窗口。

**Surface.** `crate::process_cmd::new(program)` 返回已注入 Windows `CREATE_NO_WINDOW` 的 `Command`；`crate::process_cmd::spawn_tree(&mut command)` 为会创建后代的长生命周期进程返回 `ChildTree`；`ChildTree::kill_and_wait()` force-stop exact tree 并最多等待 10 秒确认退出；`crate::process_cmd::settle_tree(child, natural_grace)` 先允许调用方定义的 cooperative / natural grace，再统一落到同一个 bounded force-stop。

**Invariants enforced.** `ChildTree` 在子进程执行用户代码前建立进程树边界：Unix child 进入独立 process group；Windows child 以 suspended 状态创建，绑定 kill-on-close Job Object 后再恢复运行。所有者必须保留 `ChildTree`，显式 stop 与 Drop 只终止这棵精确进程树。应用退出先禁止新的资源创建，等待已经获准的创建流程完成登记或释放，再释放 Sidecar / Plugin Bridge owner；Unix 还要等待有上限的 SIGTERM→SIGKILL 清理任务结束。Windows GUI child 没有可靠的 console signal，stop 直接终止已保留的 Job Object。Task command Detector 同样属于受管进程树：timeout、stdout 超限、Stop、delete 与 App shutdown 都必须通过 retained `ChildTree` 收敛，读取 stdout/stderr 的线程也要 join 后再判断最终上限状态。进程树边界建立失败时必须终止 child 并返回错误，不能降级为未受管理的进程。

**Don't.** 不要直接使用 `std::process::Command::new()`；Sidecar / Plugin Bridge 也不能直接 `.spawn()`。正常 shutdown 不能通过进程名、安装路径或 argv 子串扫描整机来弥补 owner 缺失。`process_cleanup::kill_stale_processes()` 只用于确认前一实例已经退出后的启动恢复，以及更新器的残留进程检查（Windows 更新器另有受保护目录和文件锁验证）；它不是正常生命周期 API。

`myagents-document-worker` 同样走 `process_cmd::new()` + `spawn_tree()`，但它是一 job 一进程的 App-owned 隔离边界，不属于 Sidecar。Manager 必须同时保留 `ChildTree`、stdin 和 active `(jobId, generation)`；4-byte big-endian length + JSON frame 上限 1 MiB，clean EOF 与截断 prefix/payload 必须分开处理，terminal identity 不匹配一律按协议失败。密码不进入 argv/env：只在 start frame 中出现，序列化/接收 buffer 写完即 zeroize。取消先发 exact generation frame，给 Worker 15 秒 cooperative settlement；App shutdown 使用 10 秒 cooperative settlement；超时后 force-stop retained tree，并最多再等 10 秒确认 exact tree 已退出。完整协议见 `document_processing.md`。

**例外（已内联处理或不适用）：**
- `#[cfg(windows)]` 守卫内的系统工具命令（taskkill / powershell）
- `commands.rs` / `workspace_files/system_open.rs` 的 OS opener（open / explorer / xdg-open）——用户可见的系统命令，无需隐藏
- `terminal.rs` 的 PTY 进程由 `portable-pty` 的 `CommandBuilder` + `slave.spawn_command()` 管理，不走 `std::process::Command`
- `cli.rs` 的 Node CLI spawn——CLI 模式需要在控制台显示 stdout/stderr

---

<a id="proxy_config"></a>
## `proxy_config` (`src-tauri/src/proxy_config.rs`)

**Problem.** Node.js global `fetch()` 默认不会可靠消费运行时变化的 `HTTP_PROXY`；但 SDK、子进程和其它 HTTP 库可能读取继承环境。如果把 app overlay、启动时 inherited baseline 与 Provider owner 混成一份 `process.env`，会同时造成通用请求选项失效、Provider 串线，或 localhost 被代理拦截 → 502。

**Surface.** 通用 owner 使用 `crate::proxy_config::apply_to_subprocess(&mut cmd)` / `build_client_with_proxy()`；Provider-owned 使用 `apply_to_subprocess_for_provider()` / `build_client_with_proxy_for_provider()`。通用 decision 统一由 `read_proxy_settings_for_general_requests()` 提供。

**Invariants enforced.**
- 用户配置代理且对应 general/provider owner 被选择时注入 `HTTP_PROXY` + `NO_PROXY`（保护 localhost 列表）
- 总开关关闭或 owner 未选择时继承系统网络，但**始终**补齐 `NO_PROXY` 保护 localhost
- Node generic fetch 走 `fetchWithGeneralProxy()`：由 `proxy-state` 在 app overlay / immutable inherited snapshot 间选择 package-pinned dispatcher；不要靠 global fetch 猜 env
- 与 `local_http` 形成纵深防御——即使 Rust 层忘记 `.no_proxy()`，Node 子进程内的 localhost 通信仍受 `NO_PROXY` 保护

**Don't.** 手动 `cmd.env("HTTP_PROXY", ...)` / `cmd.env_remove("HTTP_PROXY")`；不要让 Provider-owned 路径调用 generic helper，也不要把 `read_proxy_settings()` 改成 general-aware（否则 general=false 时选中的 Provider 会丢代理）。

完整代理策略详见 `proxy_config.md`。

---

<a id="system_binary"></a>
## `system_binary` (`src-tauri/src/system_binary.rs`)

**Problem.** macOS 上从 Finder 启动的 Tauri 应用，PATH 不包含 `/opt/homebrew/bin`、`/usr/local/bin` 等用户工具路径，`which::which("npm")` / `which::which("node")` 会失败。

**Surface.** `crate::system_binary::find(name)` — 在标准系统路径列表中查找。

**Don't.** 裸 `which::which()` 查找系统工具。

---

<a id="normalize_external_path"></a>
## `normalize_external_path` (`src-tauri/src/sidecar/spawn.rs`，经 `crate::sidecar` facade re-export)

**Problem.** Windows 上 Tauri 2 的 `app_handle.path().resource_dir()`、Rust 的 `std::env::current_exe()` / `std::fs::canonicalize()` 返回的 `PathBuf` 带有 `\\?\` 长路径前缀（NT namespace `extended-length path`）。Rust 自家的 `fs::*` 接受这种形式，但**任何把路径带出 Rust 的边界都会炸**：

- Node `fileURLToPath` → `ERR_INVALID_FILE_URL_PATH: must be absolute`（`file://///?/C:/...` 不合规）
- npm / Bun / 子进程的 cwd 或 arg → 部分版本静默挂起或路径解析失败
- 拼成日志 / 配置时人眼难读

该 trap 会让 Plugin Bridge 启动即 crash：`find_tsx_runtime_loader` 的结果若未经归一化就生成 Node `--import file:///...` URL，Windows 长路径前缀会形成非法 URL。

**Surface.** `crate::sidecar::normalize_external_path(path: PathBuf) -> PathBuf` —— Windows 上 strip `\\?\` 前缀，其他平台 no-op。

**调用边界规则（关键）.** **不是所有路径都要 normalize**：

- 纯 Rust fs 操作（`fs::copy` / `read_to_string` / `copy_dir_recursive` 等）→ 不需要，stdlib 自己处理 `\\?\`
- 路径要传给 Node / npm / 子进程 spawn arg / cwd → **必须 normalize**
- 路径要拼成 file URL / log / 配置 / IPC 序列化 → **必须 normalize**

口诀：**路径"出 Rust"的那一刻 normalize**，不是路径产生时也不是消费时——明确的边界规则比"防御性 normalize"更经得起未来扩展。

**Don't.** 把 `resource_dir()` / `current_exe()` / `canonicalize()` 的结果直接喂给 Node / npm / URL / 子进程 arg。也不要在每个 call site 重新发明 `s.strip_prefix("\\\\?\\")`——`path_to_file_url` 之类纯格式化函数应保持纯净，由调用方在边界 normalize。

---

<a id="filesystem_capacity"></a>
## `filesystem_capacity::available_space` (`src-tauri/src/filesystem_capacity.rs`)

**Problem.** 文件系统容量是“这个现存目标路径属于哪个文件系统”的 OS 事实。枚举 mount 后用 `Path::starts_with()` 推断，在 Windows canonical `\\?\C:\...` 与 `C:\` 表示不一致时会找不到目标盘，也会把无关的未就绪卷带入裁决。

**Surface.** `crate::filesystem_capacity::available_space(path: &Path) -> io::Result<u64>`——直接查询现存路径所属文件系统。调用方继续拥有容量预算、业务错误和 lifecycle。

**Don't.** 不要枚举卷、比较路径字符串、剥掉 `\\?\` 后继续做前缀匹配，也不要为容量查询增加 mount cache、坏盘表或扫描重试。`normalize_external_path` 只用于路径离开 Rust 的边界，不用于修补 Rust 内 filesystem query。

---

<a id="durable-fs"></a>
## `durable_fs` (`src-tauri/src/durable_fs.rs`)

**Problem.** 原子写入与目录发布只有在“文件内容同步 → rename → 父目录元数据同步”全部成功后才能报告 durable。Unix 可用只读目录 handle 执行 `fsync`；Windows 的 `FlushFileBuffers` 则要求 handle 具备 `GENERIC_WRITE`。仅加 `FILE_FLAG_BACKUP_SEMANTICS` 后以只读方式打开目录虽然成功，但 `File::sync_all()` 会稳定返回 `ERROR_ACCESS_DENIED`，使 Record 迁移、文档发布和语音模型安装把可写目录误判为存储失败。

**Surface.** `crate::durable_fs::sync_directory(path)` 同步已存在的普通目录；`crate::durable_fs::rename_directory_noreplace(source, destination)` 执行不覆盖既有目标的目录发布。调用方仍拥有业务错误、rollback 和“rename 已可见但 durability 未确认”的生命周期裁决。

**Invariants enforced.** Windows 目录 handle 使用 `FILE_FLAG_BACKUP_SEMANTICS + GENERIC_WRITE` 后再执行 `FlushFileBuffers`；Unix 继续对目录执行 `fsync`。Windows no-replace 发布使用 `MoveFileExW(MOVEFILE_WRITE_THROUGH)`，Linux/macOS 使用各自的原子 no-replace primitive。真实同步失败必须向调用方返回，不能伪装成成功；调用方应先同步新文件，再发布目录或指针，最后同步对应父目录。

**Don't.** 不要在各业务模块复制平台分支；不要把 Windows 目录同步改成无条件 no-op；不要吞掉 `AccessDenied`；也不要用只读 Windows 目录 handle 调用 `sync_all()`。用户可写性、磁盘容量与 durability barrier 是不同事实，错误投影必须在 owner 边界区分。

---

<a id="async_runtime"></a>
## `tauri::async_runtime::spawn` + `clippy.toml` ban

**Problem.** `tokio::spawn` 在 Tauri 的 `.setup()` 回调（运行在 tao `did_finish_launching` ObjC FFI 边界内）没有 reactor，panic 跨 FFI 不能 unwind → `panic_cannot_unwind` → 进程 abort。crash 信号是 main thread + `Mutex::lock::fail` + `panic_in_cleanup`，**无 panic 消息**（panic 在 logger 起来之前就发生）—— 极难排查。

**Surface.**
- `tauri::async_runtime::spawn(future)` — 自带 lazy-init 全局 runtime + `enter()` guard，任何上下文都安全
- `tauri::async_runtime::spawn_blocking(closure)` — 不在禁单内（无需 reactor）

**Invariants enforced.** `src-tauri/clippy.toml` 用 `disallowed-methods` 编译期硬封禁 `tokio::spawn` / `tokio::task::spawn` —— `cargo clippy` 直接拦下。新代码**不可能**写错。

**Don't.** 裸 `tokio::spawn` / `tokio::task::spawn`。

---

<a id="session-watcher"></a>
## Session watchers (`src-tauri/src/search/watcher.rs` + `src-tauri/src/session_metadata.rs`)

**Problem.** Session 搜索索引与 App 级导航投影都需要感知每个写者（Sidecar / IM / Cron / CLI / 迁移）的结果。新写者忘记调用来源专属通知 → 索引漂移或 GlobalSidebar 长期停留在旧 snapshot。

**Surface.** 两个不同延迟/生命周期的 `notify-debouncer-full` observer 读取同一权威文件：搜索 watcher 用 5s 滑动去抖更新 Tantivy；App 级 metadata watcher 用 300ms 去抖投影 history-visible metadata，并发出携带受影响 workspace 的 `session:metadata-changed`。后者独立于可选 SearchEngine，Renderer 只定向重读当前需要的 workspace slice。

**Invariants enforced.** 搜索与导航 freshness 都由“观察权威结果目录”保证，与写入路径、Runtime、Channel 和 mounted Tab 解耦；两个 watcher 因成本和可用性目标不同而不共享生命周期。Tauri event 与 OS watcher 都不提供注册前 replay：Rust observer 在 watches + baseline 建立后发一次 broad ready invalidation，OS watch 初始化/通道异常退出则由同一 app-lifetime thread 重建；Renderer listener 每次注册成功后再从持久化 authority 对账一次，以覆盖两侧异步注册窗口和零 subscriber 间隔。注册失败时只要仍有 subscriber 就重试；启动 baseline 不可读必须保留为 unknown，首次恢复即使为空也 broad invalidate。

**Don't.** 在写入路径里硬编码“通知索引/侧栏”调用，也不要让 GlobalSidebar 靠打开搜索、临时 Task Center subscriber 或来源事件碰巧刷新——这种约束无法在编译期保证。

完整搜索架构详见 `search_architecture.md`。

---

<a id="withconfiglock"></a>
## `withConfigLock` / `with_config_lock`

**Problem.** `~/.myagents/config.json` 被三方独立写者（renderer plugin-fs / Node admin API / Rust IM commands）read-modify-write，无任何协调；并发写 rename 上"最后一名 wins"，用户密钥/设置静默丢失。

**Surface.**
- Node `withConfigLock(fn)` / `atomicModifyConfig(fn)` (`src/server/utils/admin-config.ts`)：async
- Rust `with_config_lock(fn)` (`src-tauri/src/config_io.rs`)：同步，内部走 `with_file_lock_blocking`
- Renderer `withConfigLock(fn)` (`src/renderer/config/services/configStore.ts`)：async，`cmd_fsync_path` 调 Rust 完成 fsync

**Invariants enforced.**
- 三端共享同一个 `config.json.lock` lockdir（atomic mkdir 协议）
- 协议：lock → re-read → mutate → tmp write → fsync → rename → fsync parent dir → release
- Stale recovery 跨运行时——renderer 信任自己的 mtime（1× threshold），node/rust owner 用 4× threshold（renderer 无法 probe pid liveness）
- Node/Rust owner sentinel 是 `<runtime>:<pid>:<startMs>`；renderer 无可探测的独立 PID owner，使用 `renderer:<createdMs>:<uuid>`。三端 release 都必须逐字校验自己取得的完整 token，防止"暂停过 staleMs 后误删继任者"

**Don't.**
- 任何 `config.json` 写入用裸 `tmp + rename`（绕过锁）
- Renderer 直接 `writeFile(config.json, ...)`
- Rust 旧的"自己用 std fs 写"路径——全部要走 `with_config_lock`

---

<a id="withfilelock"></a>
## `withFileLock` / `with_file_lock`

**Problem.** 单写者文件（`tasks.jsonl` / `session_goals.json` / `sessions/*.jsonl` / `mcp-oauth state`）裸 append 或 read-modify-write，应用内多 owner 并发触发 race；之前用 `Atomics.wait` 同步 busy-wait 阻塞 event loop。

**Surface.**
- Node `withFileLock(targetPath, fn, { staleMs })` (`src/server/utils/file-lock.ts`)：async；抛 `FileBusyError`
- Renderer `withFileLock(targetPath, fn)` (`src/renderer/config/services/configStore.ts`)：与 Node/Rust 共用 `${targetPath}.lock` 协议；provider JSON 写删必须走它
- Rust `with_file_lock(path, fn)` (`src-tauri/src/utils/file_lock.rs`)：async via `spawn_blocking`
- Rust `with_file_lock_blocking(path, fn)`：同步孪生（给 `config_io` 的现有同步 API 用）

**Invariants enforced.**
- Atomic-mkdir-based 协议，跨进程互斥
- Owner sentinel `<runtime>:<pid>:<startMs>`；确认 PID 已死亡时立即回收，不等待 stale age。合法进程 owner 只要仍存活或 liveness 不确定就必须保守保留；v1 `startMs` 受墙上时间与平台 probe 差异影响，只用于兼容和 release fencing，mismatch 不能授权删除 live writer
- Node/Rust parser 只接受严格 ASCII 十进制的 2-tuple（旧）与 3-tuple（新）owner，并共享 PID / `startMs` 数值范围；owner 缺失、格式不可识别或 `renderer:*` 时才等待 stale age
- `delay()` **不** `unref`——unref 会让进程在 acquire 等待中提前退出
- Async 实现，零 sync busy-wait

**Don't.**
- 任何单写者文件用裸 append
- 用 `Atomics.wait` / CPU spin / `while (Date.now() < end)` 做阻塞等待
- 自己手写 lockdir 协议

ConfigProvider 的 `config/projects/providers/apiKeys/verifyStatus` 属于一个磁盘快照：所有 refresh 必须委托给同一个 snapshot request/commit owner；本地写盘成功后也必须推进同一 revision，再镜像 React state。禁止为 provider/key 单独写一个无 fence 的异步 setter，否则旧的外部读取可以覆盖更新鲜的本地写入。

---

<a id="durable-record-journal"></a>
## `DurableRecordJournal` (`src-tauri/src/durable_journal.rs`)

**Problem.** Record lifecycle 与 transcript revision 都是 append-only 事实。如果各自实现 JSONL append/recovery，很容易在 torn tail、identity、sequence、checksum、单行上限或 fsync 上漂移；直接套通用数据库/事件框架又会为两个局部日志引入额外进程、schema owner 和迁移面。

**Surface.**
- `DurableRecordJournal<Event>::open(path, record_id, schema_version, max_line_bytes)`：验证配置、恢复合法前缀并取得 next sequence
- `append(wall_time_ms, media_ms, event)`：写 typed event，flush + `sync_data` 后才返回已提交 entry
- `recover_and_read<Event>(...)`：只返回通过 identity/schema/sequence/checksum 校验的 durable entry

**Invariants enforced.**
- 目标只能是普通文件或不存在；拒绝 symlink/special file
- 每行固定绑定 `recordId + schemaVersion + seq + eventId`，checksum 覆盖 body；sequence 必须从 1 连续递增
- 尾部 partial/畸形/超限行只在最后合法字节边界修复；identity/schema mismatch fail closed，不能把其它 Record 的内容截成“可用”日志
- caller 必须给出领域 event enum 与 projection；helper 不拥有 recording/transcript 状态机，也不扩张成通用 event bus、数据库或跨进程队列

**Don't.** Record-owned append-only 事实不得再裸写 JSONL，或复制一套 checksum/torn-tail repair。普通可原子替换的 snapshot、TaskStore 和 speech job metadata 不应为了“统一”迁入该 journal。

---

<a id="renderer-clipboard"></a>
## `copyPlainText`（Renderer clipboard）

**Problem.** WKWebView/WebView2 可能暴露 `navigator.clipboard.writeText`，却因焦点或权限状态拒绝调用；直接调用会让复制按钮静默失效，若 UI 同步翻转 `copied` 还会误报成功。

**Surface.** `copyPlainText(text)`（`src/renderer/utils/clipboard.ts`）。先尝试 Async Clipboard，拒绝后使用隐藏 textarea selection + `document.execCommand('copy')`；只有任一路径实际返回成功才 resolve，两路都失败则 reject。富文本复制仍由 `markdownClipboard.tsx` 拥有，并复用此 plain-text leaf，避免普通组件加载 Markdown 依赖。

**Don't.** 生产 renderer 代码不得直接调用 `navigator.clipboard.writeText()`；带 copied/toast 状态的调用方只能在 helper resolve 后显示成功，reject 时保持未复制并按 surface 反馈失败。ESLint 对直接调用设结构守卫。

---

<a id="killwithescalation"></a>
## `killWithEscalation`

**Problem.** 三个外部 runtime adapter（claude-code / codex / gemini）之前共用反模式：SIGTERM + 短 wait + 无界 `waitForExit()`。子进程拒收 SIGTERM 时 sidecar 永久卡死，每条 stop 路径都中招（用户停止、模型切换、权限切换、runtime 切换）。

**Surface.** `killWithEscalation(child, { gracefulMs, hardMs, label })` (`src/server/runtimes/utils/kill-with-escalation.ts`) — 返回 `Promise<void>`。

**Invariants enforced.**
- 升级链：SIGTERM → 等 `gracefulMs` → SIGKILL → 等 `hardMs` → orphan-log
- 硬截止：worst case `gracefulMs + hardMs` 内必返回
- 永不抛——所有失败路径降级为 orphan log
- 三个 runtime 的 stop 路径 + `external-session.ts` 的 catch-fallback SIGTERM 全部走它

**Don't.**
- 任何子 sidecar / agent 的 stop 用裸 `setTimeout + child.kill('SIGTERM')` + `await waitForExit`
- 自己手写 escalation 倒计时

---

<a id="cancellation"></a>
## `withAbortSignal` / `cancellableFetch` / `withBoundedTimeout` / `anySignal`

**Problem.** 工具 / bridge 大量裸 `fetch()` 无 AbortSignal，下游卡住 → tool turn 永久 hang；OpenAI bridge 的 `AbortController` 只覆盖 headers 阶段；SSE proxy 有"客户端断开但 SDK 仍在烧 token"的孤儿态。

**Surface.** (`src/server/utils/cancellation.ts`)
- `CancelReason` 枚举：`'user' | 'timeout' | 'upstream' | 'shutdown' | 'error'`
- `withAbortSignal(op, { signal, timeoutMs, reason })` —— 组合外部 signal + timeout 跑 op
- `anySignal(...signals)` —— 多 signal 合并，存在时委托 `AbortSignal.any`，否则 polyfill
- `cancellableDelay(ms, signal)` —— 可取消的 sleep
- `withBoundedTimeout(p, ms)` —— bound Promise 等待但不 reject；late op rejection 静默吞掉
- `cancellableFetch(url, init, { timeoutMs, signal })` —— 上层 fetch 便利层

**Invariants enforced.**
- 每条 cancellable 资源（stream / fetch / process / 子进程）都有 bounded-time `cancel(reason)` 路径
- 所有工具 fetch（im-bridge / im-cron / im-media / edge-tts / plugin-bridge compat）都迁到 `cancellableFetch`，带显式超时
- `withBoundedTimeout` 的 `void p.catch(() => undefined)` 防止 timeout 后的 unhandledRejection

**Don't.**
- 写新的 fetch / stream pump 不带 AbortSignal
- 自己手写 `AbortController` + `setTimeout` 的 dance

---

<a id="maybespill"></a>
## `maybeSpill` + `/refs/:id` + SSE 优先级队列

**Problem.** 大 payload（图片、长 tool result、巨型 HTTP 响应）直接走 SSE/IPC JSON channel，OOM、UI 线程被 base64 阻塞、慢 client 无界排队拖死 sidecar。

**Surface.**
- Node `maybeSpill(value, { mimetype, sessionId })` (`src/server/utils/large-value-store.ts`) —— ≤256KiB 返 inline，超阈值写到 `~/.myagents/refs/<id>` 返 `LargeValueRef { id, preview, mimetype, sizeBytes, expiresAt }`（1h TTL，8KiB head preview）
- `fetchRef(id)` / `getRefStreamPath(id)` —— 消费方拉回
- `/refs/:id` HTTP 路由 —— 使用 `createReadStream` 流式返回，绕过 deferred-init gate；新 writer 生成 32 个小写十六进制字符，reader 保留 `^[a-f0-9]{8,32}$` 的历史读取范围
- Node / Rust writer 共用不可覆盖的提交协议：独占创建 `<id>.part` → flush/sync body → 用 hard link 发布 body → 独占创建 `<id>.meta.json.part` → flush/sync meta → 用 hard link 发布 meta；reader 只读取完整的 body + meta 组合
- `clearExpiredRefs` / `clearSessionRefs` + 60s `startRefsGc` 后台清理；session reset 联动；GC 同时回收陈旧 `.part`、`.meta.json.part` 与 body-without-meta
- Rust `proxy_spill.rs` 边读边决定：loopback >1MiB spill、单响应最多 512MiB；external 单响应最多 8MiB、只在内存中返回，不创建本地 ref
- Rust `ProxySpillManager` 只统计 proxy 的在途写入与删除失败残留（合计 1GiB）；提交成功后，文件回到既有 ref TTL 管理。启动清点必须等前一实例的 writer 确认停止后执行一次；若残留清理、panic 恢复或清点失败，本次运行拒绝新的 Rust spill，不能在运行期间重扫共享目录。残留大小按物理文件 identity 统计，hard-link alias 不重复计费；只有新的 spill 请求到达且重试时间已到时，才有上限地重试已知残留，不运行长期后台配额任务
- SSE 三档优先级（`src/server/sse.ts`）：
  - **critical**（errors / status / message-stopped 等）
  - **coalescible**（chunk / delta，同类合并替换）
  - **droppable**（log）
  - per-client 软上限 1000、硬上限 10×；critical 突破硬上限强制断开慢 client

**Invariants enforced.**
- Node tool/result 超过 256KiB、loopback proxy response 超过 1MiB 时不进入 SSE / IPC base64，改走 ref 数据面
- ref writer 不能截断或覆盖已有 body、meta 或临时文件；发生碰撞时更换 128-bit id，并按固定次数重试
- `Content-Length` 只做提前拒绝，实际 chunk 累计仍必须执行同一响应上限；external origin 永远不能收到本地 `/refs/<id>` URL
- 用户从文件系统拖入 / 桌面文件选择的图片不走 `/chat/send` inline base64：≤10MB 由 `cmd_prepare_user_image_attachments` staged 到 `~/.myagents/attachments/<session>/` 后发送 `attachment_ref`，>10MB 走 `cmd_workspace_copy_paths` 进入 `myagents_files/` 并插入 `@path`。无绝对路径的剪贴板 / 浏览器 `File` 超过 10MB 必须拒绝并提示用户用文件路径入口，禁止为了“自动转文件”把它 base64 塞进 IPC。
- Bridge tool result 经 `maybeSpill` 再交给 SDK，超阈值替换为 `@ref:<id>` marker
- OpenAI bridge / `/chat/stream` 用 pull-driven `ReadableStream`，consumer pace 决定 pull 节奏（避免 controller 内部 queue 无界增长）
- Renderer 检到 `ref_url` 直接 fetch ref 跳过 `atob`

**Don't.**
- 把应经过 Node `maybeSpill` 的超 256KiB 值直接 `JSON.stringify` 进 SSE / IPC
- 自己手写 base64 round-trip
- 为 proxy spill 再建持久化预留日志、全局 attachment/ref 配额或长期后台清理器；当前 owner 只覆盖在途写入与已知清理残留
- 新加 `controller.enqueue` 不过 priority gate
- 新增 SSE 事件只注册一处。两处都要：renderer `SseConnection.ts::JSON_EVENTS`（否则前端静默丢弃）+ server `sse.ts::SSE_EVENT_PRIORITIES`（否则回落 `critical` → 永不 coalesce + 每进程一次性 `[sse] missing from SSE_EVENT_PRIORITIES` warn）。latest-wins 快照类（如 `chat:context-usage`）选 `coalescible`

---

<a id="withlogcontext"></a>
## `withLogContext` + AsyncLocalStorage logger pipeline

**Problem.** 日志按 sessionId/tabId/turnId/runtime 关联缺失；为补 correlation 改 932 个 `console.*` 调用是 cost-prohibitive；同时 `appendFileSync` 同步落盘阻塞 event loop。

**Surface.**
- `withLogContext({ sessionId, tabId, turnId, runtime, requestId, ownerId }, fn)` (`src/server/logger-context.ts`) —— 进入 ALS frame
- HTTP 中间件从 `X-MyAgents-Tab-Id` / `X-MyAgents-Session-Id` 头自动起 frame；renderer `proxyFetch` 自动盖头
- SDK turn 用 module-level 的 ambient TLS（`Map<sessionId|ownerId, LogContext>`，**不是** singleton）—— 因为 persistent `messageGenerator` 会 yield 出 ALS frame
- Runtime adapter 在事件处理路径外层包 `withLogContext({ runtime })`
- `LogEntry` schema 增 6 个可选 correlation 字段；`console.*` capture 自动注入
- `UnifiedLogger` (`src/server/UnifiedLogger.ts`) in-memory bounded queue（1000）+ 100ms async flusher + 50MB per-file rotation + 500MB per-dir cap + drop counter + 进程退出 hooks 同步 flush
- Rust 端 `ulog_*!` macro 增 kv-pair arms，932 个 legacy 调用零迁移；底层换成 tokio task + bounded mpsc(1024) + 200ms flush tick

**Invariants enforced.**
- 所有 `console.*` 在合适的 boundary 内调用（HTTP middleware / SDK turn / runtime spawn 已包好），就自动带 correlation——零 call-site migration
- Ambient store 按 `sessionId|ownerId` 隔离，同 sidecar 内多 owner 不互踩
- 同步落盘绝迹（`grep appendFileSync UnifiedLogger.ts` 应为空）

**Don't.**
- 写新的"跨进程 trace"需求时改 `console.*` 加前缀
- 引入并行的 `sendLog` 通道
- 用 process-singleton 存 correlation

**ADR：不替换为 pino / tracing-appender。** 决策理由见 `decision_logger_library.md`。

---

<a id="deferredinitstate"></a>
## `DeferredInitState` + readiness endpoints

**Problem.** 单一 `healthy` 信号让 renderer 在 sidecar deferred init 还在跑时就以为可用——首次发消息卡住、route 用 `await __myagentsDeferredInit` 无限等。

**Surface.**
- `DeferredInitState` 状态机（`src/server/readiness-state.ts`）：`pending → phase(<name>) → ready` 或 `→ failed { phase, error, retryable }`
- Phases: `cleanup / skill-seed / socks-bridge / sdk-init / external-runtime-restore`
- `GET /health` —— liveness alias（旧 watchdog 兼容）
- `GET /health/live` —— 显式 liveness
- `GET /health/ready` —— 200 only when `state=ready`；否则返回 503 + `{ state, phase?, error?, retryable? }`
- `GET /health/functional` —— sidecar 等同 ready；plugin bridge 检"过去 60s 是否成功 forward 到 Rust"
- failed readiness 不提供进程内 retry route；由 Sidecar 进程重启重新建立初始化 owner
- 普通 Route gate 改成查状态机并返回结构化 503 + `Retry-After: 1`，不再 await indefinitely 或 rethrow
- Rust `wait_for_readiness`（30s timeout / 250ms cadence）wired 到 `ensure_session_sidecar`，启动 loading 自然覆盖 warm-up

**Invariants enforced.**
- Liveness ≠ readiness ≠ functional——三个语义独立
- Renderer loading 挂 ready 信号，不挂 liveness
- Watchdog 用 ready，404 fallback 到 `/health`（rollout 安全）
- Failed init 不再静默 poison 所有 route，error+phase 暴露在响应体里

**Don't.**
- 把 readiness 等同于 liveness
- 新加 route 用 `await __myagentsDeferredInit`（已下线）
- Renderer loading 挂 `/health`

---

<a id="fs-utils"></a>
## `fs-utils` (`src/server/utils/fs-utils.ts`)

**Problem.** Windows junction / POSIX symlink-to-dir 上 `Dirent.isDirectory()` 返回 false，每个扫目录的代码都要手写 fallback。

**Surface.** `ensureDirSync` / `ensureDir` / `isDirEntry`

**断链 symlink 探针.** `existsSync` / `Path::exists()` 跟随 symlink——**断链 symlink 返回 false**，代码会误以为“路径为空”。紧接着的 Node v24 sync `cpSync({recursive:true})` 可能在 `std::filesystem::equivalent` 抛出 JS 无法捕获的 C++ 异常，使 Sidecar abort 并进入健康检查重启循环。async `fs.cp` 的行为不同，不能用它的结果推断 sync 路径安全。

在跑写操作（`cpSync` / `fs::create_dir_all` / `fs::remove_dir_all`）之前 MUST 用**不跟随 symlink** 的 API 探测：

- **Node**：`lstatSync` + `existsSync` 双探——`isSymbolicLink() && !existsSync(p)` ⇒ 断链，先 `unlinkSync` 再写。修复样板 `src/server/index.ts::seedBundledSkills`。
- **Rust**：`fs::symlink_metadata`（**不要** `fs::metadata()` / `Path::exists()`，同为跟随语义）；拿到 `Metadata` 后 `is_symlink() || is_file()` → `remove_file`，是目录 → `remove_dir_all`。修复样板 `src-tauri/src/commands.rs::cmd_sync_system_skills`。

---

<a id="subprocess"></a>
## `subprocess` (`src/server/utils/subprocess.ts`)

**Problem.** Node `child_process.spawn` 的 stream 形态需要适配：`exited` Promise 触发时机、stdin 背压、stdout 是否 cached Web Stream 等。

**Surface.** spawn 兼容 adapter：
- `exited` Promise 在 `'close'` 而非 `'exit'`（stdio 已 drain）
- stdin.write 用 Node callback 驱动避免背压 hang
- 保留 spawn error
- cached `Readable.toWeb` stream
- 配套 `fireAndForget()` helper（open / explorer / xdg-open 等一次性 spawn）

**Invariants enforced.** 单一 spawn 入口，不在每处重写 stream-shape 差异。

---

<a id="file-response"></a>
## `file-response` (`src/server/utils/file-response.ts`)

**Problem.** Node 没有 `new Response(Bun.file(p))` 这种文件直接转 Response 的便利构造，每个 HTTP 路由返回文件都要内联 `fs.readFile + new Response`。

**Surface.**
- `fileResponse(p, { contentType })` — 用 `createReadStream + Readable.toWeb` 生成流式 Web Response
- `sniffMime(path)` — ext→MIME 映射

**CORS / CSP（Renderer 直连 Sidecar HTTP）.** 绝大部分 Sidecar 接口走 Tauri invoke proxy；只有明确登记的大载荷端点由 Renderer 原生 `fetch('http://127.0.0.1:<port>/...')`。这些端点必须返回 `Access-Control-Allow-Origin: '*'`，并把允许的地址列进 CSP `connect-src`。非标准 `fetch-src` 不生效，不能替代 `connect-src`。

---

<a id="context-window-suffix"></a>
## Context-window suffix helpers (`src/server/utils/model-capabilities.ts`)

**Problem.** SDK 对不认识的 model id 按默认上下文窗口 fallback。更大窗口的模型若不经过 provider-scoped capability lookup，会错误显示、提前 auto-compact，并按错误窗口截断附件。`CLAUDE_CODE_AUTO_COMPACT_WINDOW` 只能下调阈值，不能修正这类上限。

**Surface.** wrap 策略统一为 contextLength **>200K 即加 `[1m]` 后缀**（不是只 ≥1M）。SDK 窗口先解锁到 1M，再由 env cap 钳回真实值；builtin 的自动压缩阈值统一为 `90% × min(1M, registry)`。SDK `normalizeModelStringForAPI` 在 wire 上剥 `[1m]`，上游 API 看不到后缀。已知装饰性偏差：SDK `/context` 头条会显 1M，MyAgents 自己的占用圆环显 registry 真值。

- `applyProviderContextWindowSuffix(model, providerId)`：调用点已知 active provider 时的首选入口。裸 model id 先查该 provider 自己的 model row；没有对应 row 时再 fallback flat registry，已有 row 但 capability 字段缺失时保持 unknown，不能跨 Provider 补字段；调用方显式传入的 `[1m]` 原样保留。
- `applyContextWindowSuffix(model)`：只有调用点确实不知道 provider 时才用的 flat fallback。
- 创建包含主模型、alias 与 sub-agent model 的持久 SDK Query 时，必须先通过 `snapshotProviderModelContextLengths` 固定同一份 capability 视图；`buildClaudeSessionEnv()` 与所有 `options.model` 再用 `applyContextWindowSuffixForContextLength` 消费它。单模型 one-shot（title / verify / vision）可以先构建 env，再用该 env 的 `CLAUDE_CODE_AUTO_COMPACT_WINDOW` 生成自己的 query model。两种路径都禁止在异步启动间隔后重新读 Provider 文件，否则 env cap 与 model unlock 可能来自两版配置。

**Invariants enforced.**
- 所有 SDK ingress 必须过 wrap：`query({ model })`、`query({ agents: { ...{ model } } })`、`querySession.setModel()`、`ANTHROPIC_DEFAULT_{FABLE,SONNET,OPUS,HAIKU}_MODEL` env；已知 provider 的入口必须走 provider-scoped helper。
- **反向同样是红线**：bridge `modelOverride`、`*_MODEL_NAME` env、cron / persisted state、所有用户可见处必须用**未 wrap** 的原始 model id。

**Don't.**
- 不能只凭模型营销名称声明超长窗口；需要 beta header、账户等级或付费开关的能力必须由实际 provider offering 表达，默认配置保持 wire-default。
- registry key 永远存**裸 id**：`[1m]` / 手填空格形 ` 1m` 必须在 ingest + lookup 两侧 strip；不完整 capability 条目要 per-field merge（`mergeCapabilityInto`），per-entry first-wins 会遮蔽已知字段。
- LiteLLM 的 `provider/model` 只能生成安全的 tail fallback：有不带 provider 的 literal 时按 literal裁决；没有 literal 时只暴露候选一致的字段。禁止按目录顺序或取 max；相同 tail在不同 Provider 上可能代表完全不同能力。
- 模态能力保留 `supported / unsupported / unknown` 三态和逐字段来源。不完整证据的字段缺失不能转成 `false`；tail alias逐模态取共识，冲突保持 unknown。图片理解模型选择以 Provider offering row为 authority，推断信息只能提供正向提示，不能跨 Provider veto。

---

<a id="sync-tauri-command"></a>
## 同步 Tauri 命令与 WebView 主线程冻结

**Problem.** 同步 `#[tauri::command] pub fn` 跑在主线程；macOS 上这也是 WKWebView UI线程。命令等待Sidecar冷启动或文件IO时，React即使提交DOM也无法绘制，前端调度补丁不能修复Rust主线程冻结。

**排查信号.** 点击后页面不变但 React 已 commit → 用 double-rAF `chat_painted` 探针量**真实绘制时刻**（不是 commit 时刻）；若绘制时刻 ≈ 某同步命令返回时刻，即是它。注意 unified 日志只显 commit 不显 paint，容易被误导去改前端。

**正确做法.** 改 `pub async fn` + 把阻塞部分丢进 `tauri::async_runtime::spawn_blocking`。先把 `State` 里的 Arc clone 出来，**别跨 `.await` 持 State guard**。Condvar drain 即使不做 IO 也属于阻塞等待，不能直接占用 async runtime worker；等待 per-Session 资源时也不能持有跨 Session 共享的 manager / Router 锁。快速查表 / getter 类同步命令不受影响，无需改。

**Don't.** 在同步命令里做：等 sidecar 就绪 / 轮询 / 网络请求 / 大量文件 copy / kill+wait。改动任何可能阻塞 >1 帧的命令时必查此节。

---

<a id="builtin-mcp"></a>
## Builtin MCP 懒加载架构

**Problem.** in-process MCP 若在 tool module 顶层 import `@anthropic-ai/claude-agent-sdk`（~900KB）+ `zod/v4`（~470KB）并构造 per-tool schema，Sidecar 冷启动会无条件支付约 500-1000ms 税，即使当前 Session 根本不用该 MCP。当前 META registry 只有 user-toggleable `gemini-image` / `edge-tts`；历史 `cron-tools` / `im-cron` / `im-media` 已迁移到 `myagents` CLI，runtime-dynamic `im-bridge-tools` 由独立 context-injected surface owner 懒初始化。

**Architecture: 两层 META / INSTANCE**

- **META 层** (`src/server/tools/builtin-mcp-meta.ts`)：每个 MCP 登记一个 `{ id, load: async () => ... }` 工厂。**模块加载时只存函数引用**，不 eval 任何 tool 代码。
- **INSTANCE 层** (`src/server/tools/builtin-mcp-registry.ts::getBuiltinMcpInstance(id)`)：按需触发 factory，SDK + zod + per-tool schema 构造全部在此发生。**首次 call 付 100-400ms，后续缓存命中 0ms。** Promise 失败自动 evict，防止 poisoned cache。
- **Settings UI 的 MCP 列表**从静态 `PRESET_MCP_SERVERS` 读取；权威定义在 `src/shared/config-types.ts`，renderer 的 `src/renderer/config/types.ts` 只是兼容 barrel，**不依赖** INSTANCE 层。本次 Sidecar 生命周期内从未启用或测试的 builtin 只登记轻量 META factory，不加载 tool module，也不创建 INSTANCE；已创建的 INSTANCE 则按进程生命周期缓存。

**新增 builtin MCP 流程：**
1. 新建 `src/server/tools/xxx-tool.ts`，导出 `async function createXxxServer()`。**SDK/zod 的 value import 必须在 factory 内部 `await import(...)`**，顶层只能 light 依赖 + `import type`。
2. 在 `src/server/tools/builtin-mcp-meta.ts` 加：
   ```ts
   registerBuiltinMcpMeta({
     id,
     load: async () => {
       const m = await import('./xxx-tool');
       return { server: await m.createXxxServer() };
     }
   })
   ```
3. 用户可开关的 MCP（Settings 可见）：另导出 `configureXxx` + `validateXxx`（纯 JS，不 import SDK/zod），在 META 的 load() 里一并返回。

**Invariants enforced.** ESLint `@typescript-eslint/no-restricted-imports` 规则（作用域 `src/server/tools/*.ts`）禁止顶层 value-import SDK/zod（`allowTypeImports: true` 保留 type-only 零成本）。**破坏这条规则 → lint 立即报错**。

**Don't.** 顶层 `import { createSdkMcpServer, tool } from '@anthropic-ai/claude-agent-sdk'` 或 `import { z } from 'zod/v4'` 在 `src/server/tools/*.ts`。

---

<a id="snapshot-helpers"></a>
## Session Config Snapshot Helpers

**Problem.** Tab/Cron/Background 与 IM/Agent Channel 对 config 变更的感知策略不同——前者要冻结快照（Agent 配置变更不影响已开 session），后者要 live follow（每条消息都按当前配置 resolve）。如果用一个 snapshot helper + 布尔参数，调用方容易忘记某个分支。

**Surface.** 两个**独立命名函数**：
- `snapshotForOwnedSession(agent, { runtimeOverride?, runtimeSourceOverride? })` —— 冻结 `model / permissionMode / mcpEnabledServers / providerId / providerEnvJson / runtime identity`
- `snapshotForImSession(agent, { runtimeOverride?, runtimeSourceOverride? })` —— 只记录 `runtime identity`（runtime drift 触发 session fork），其它 config 每次消息 live resolve

`runtime identity` = `runtime` + `runtimeSource`。`codex/system-cli` 与 `codex/managed-provider` 是两个不同身份；只传 `runtimeOverride:'codex'` 而不传 `runtimeSourceOverride:'managed-provider'` 的路径会被当作 system CLI。`runtimeOverride` / `runtimeSourceOverride` 只用于“会话出生时目标 runtime 已由 sidecar/用户动作决定，但 AgentConfig 还没落盘”的 materialization 路径。它必须在 helper 内构造目标 runtime identity 下的 agent view，并复用 `buildRuntimeChangePatch` 清掉非 portable `runtimeConfig` 字段；禁止先按旧 agent snapshot 再在 route 层 post-hoc 覆盖 `snapshot.runtime`。

**Invariants enforced.** 任何新增字段都必须在两处显式处理，无法"忘记"。读侧用 `resolveSessionConfig(sessionMeta, ownerKind)` (`src/server/utils/resolve-session-config.ts`) 统一消费——owned session 走 meta 冻结值，IM session 走 live agent；meta 缺失时 fallback 到 agent config，向后兼容老 session。

**Don't.** 用一个布尔参数分派两种语义。

Session snapshot 的完整 authority 与写入方向见 [`session_architecture.md`](session_architecture.md)。

---

<a id="legacy-cron-migration"></a>
## Legacy Cron Startup Migration (`legacy_upgrade.rs`)

**Problem.** legacy `cron_tasks.json` 同时包含裸 Cron、Task projection、managed job 与 Loop。当前只有 Task scheduler；如果 Renderer 或多个 Sidecar 各自迁移，会产生重复 Task、启动顺序竞态或双 scheduler。

**Surface.** Rust app setup 中的 `migrate_legacy_crons_on_startup()`，在唯一 `TaskStore` 初始化后、`TaskSchedulerController.initialize()` 前运行。legacy manager 只保存一次性 validated snapshot，不写旧文件。

**Invariants enforced.**
- 幂等：沿用 legacy id；已存在同 id 且 provenance 匹配时只合并不会倒退的 execution/session 状态
- 单 scheduler：迁移完成后才恢复 Running Task，旧 Cron 永不启动
- 分类明确：At/Every/Cron 迁移；Task-linked/managed row 收口到既有/managed Task；Loop 与开发期 Goal row 跳过
- 安全路由：credential env 不复制；无法安全恢复 provider/workspace 时创建 Blocked Task
- 损坏保护：legacy/Task store 任一校验失败都保持只读，禁止部分 map 覆盖原始字节

**Don't.** 在 renderer mount、Sidecar 启动或 Cron facade mutation 中迁移；也不要写 `cron.task_id` backpointer 或额外 migration ledger。

---

<a id="workspace-files"></a>
## `workspace_files` 路径解析双轨 (`src-tauri/src/workspace_files/path_safety.rs`)

**Problem.** 工作区文件操作（读/写/CRUD/搜索/watcher）涉及 14 个 Tauri command，每个都要做 path traversal 防护、blacklist 校验、symlink 安全。如果每个 cmd 自己写 `Path::join + canonicalize` 或 `Path::exists`，会出现两类持续踩坑：
1. **写侧**：`Path::exists()` 跟随 symlink → 断链 symlink 误报为空 → 紧接着 `fs::create_dir_all` / `fs::copy` 失败或写穿 symlink target。
2. **读侧**：`fs::read_to_string` 默认跟随 symlink → 含 `evil_link → /etc/passwd` 的恶意 repo 被克隆后，AI 工具调 `cmd_workspace_read_preview({path:'evil_link'})` → 内容外泄。

**Surface.**

| Helper | 用途 | 用在哪 |
|--------|------|--------|
| `validate_workspace_root(path)` | 工作区根校验：必须是绝对路径 + 存在 + 通过 `commands::validate_file_path` 黑名单 | 所有 cmd 入口（读+写）|
| `resolve_inside_workspace(root, rel)` | **写侧** 路径解析：lexical resolve `..`/`.` + `starts_with(root)` 校验。允许目标不存在（write/create cmd 必须） | `crud`、`gitignore`、`transfer`、`save_file` 等创建/重命名场景 |
| `resolve_existing_inside_workspace(root, rel)` | **读侧** 路径解析：先调 lexical 版本，再 `fs::canonicalize` 把整条 symlink 链解开，最终路径必须 `starts_with(canonicalize(root))`。不存在 → 返回 `File not found` | `read_preview`、`download`、`save_file`（require existing）、`check_paths`、`claude_md` |
| `reject_managed_global_skill_mutation(root, target)` | **mutation-only**：逐组件检查 canonical target、junction/symlink payload 与最近存在祖先，拒绝写入 `.claude/skills/*` 中指向 `~/.myagents/skills` 的链接叶子或后代（含目标尚不存在、断链） | `save_file`、`crud`、`delete`、`transfer` destination、`files_b64` destination |
| `read_workspace_file_no_follow(root, rel, max)` | workspace 附件的强 no-follow 有界读：Unix 用目录 fd + `openat(O_NOFOLLOW)`；Windows 用 `NtCreateFile(ObjectAttributes.RootDirectory=parentHandle, FILE_OPEN_REPARSE_POINT)` 逐级相对打开目录与 leaf | Space CLI workspace attachments |
| `open_regular_file_no_follow(path, label)` | 显式用户选择本地文件的统一 leaf opener，拒绝 symlink / Windows reparse leaf | Space GUI attachments、avatar、Skill package |
| `validate_external_read_path(abs)` | 绝对路径外部读校验：先做 lexical blacklist；路径存在时再 `fs::canonicalize` 复查，阻断中间 symlink组件逃逸；不存在时仅lexical放行。返回lexical路径以保留调用方的leaf-symlink拒绝语义 | `slash`（workspace 根）、`transfer::copy_paths`、`files_b64::read_files_b64` |
| `validate_item_name(name)` | 文件名校验：禁止空 / 路径分隔符 / 控制符 / Windows 保留名（含 trailing dot/space）| `crud::new_file/folder/rename` |
| `sanitize_filename(name)` | 修复型清洗：把非法字符替换为 `_`，用于"用户上传文件名带 `<`/`?`"等 | `files_b64::write_unique_file` |

每个 workspace_files 子模块**只能**通过这些 helper 访问路径——直接用 `PathBuf::from(user_input)` 或 `Path::canonicalize` 是反模式。

**Invariants enforced.**
- **路径解析单 chokepoint**：所有 cmd 走 `validate_workspace_root` + 一个 resolve helper，新增"也禁止 X 目录"只改 `commands::validate_file_path`，14 个 cmd 同时收紧。
- **写侧不存在路径可解析**：`resolve_inside_workspace` 是纯 lexical，不调 fs，可处理 `new_file` 这种"目标不存在"场景。
- **读侧 symlink 逃逸防护**：`resolve_existing_inside_workspace` canonicalize 双侧（path + workspace_root），通过 `starts_with` 拦截 `evil_link → /etc/passwd`。读 `read_preview`/`download`/`save_file` 必须用此 helper；只用 lexical 版会被穿透。
- **destructive 写用 `fs::symlink_metadata`**：`crud.rs::slot_occupied`、`transfer.rs::slot_occupied` 都是 `fs::symlink_metadata(p).is_ok()`，**不**是 `Path::exists()`——断链 symlink 必须报告为占用，否则后续 `fs::write` / `fs::rename` 会写穿或报莫名错误。
- **managed Skill 投影是 mutation-only 只读边界**：读取、揭示路径和从 Skill 向工作区 copy-out 继续允许；保存、新建、重命名、移动、删除、copy/import destination 必须经过 `reject_managed_global_skill_mutation`。不要把它并入通用 read resolver，也不要给 Node 投影增加 bypass flag。
- **bounded read 防 TOCTOU**：所有读取大文件命令（`read_preview` 512KB cap、`download` 25MB、`files_b64::read_one_image_as_b64` 10MB）用 `File::open + take(MAX+1).read_to_end` 模式——不是 `fs::read_to_string` / `fs::read`。元数据 `len()` 与实际读取之间文件可能被攻击者扩张，bounded read 是唯一可靠防御。
- **validate 与 open 必须是一体的**：workspace attachment 不得退回 `metadata/canonicalize → File::open(path)`；Windows 的 share flags 不约束 `FILE_WRITE_ATTRIBUTES`，攻击者仍可把空目录原地设为 junction。必须由 `read_workspace_file_no_follow` 从已验证 parent handle 做 handle-relative child open/create，leaf 与 temp/final rename 也不得重新解析可变路径。

**Don't.**
- 写侧 cmd 用 `Path::exists()` 探"占位"——断链 symlink 会让你以为路径空。MUST 用 `slot_occupied` helper（`fs::symlink_metadata(p).is_ok()`）。
- 读侧 cmd 用 `resolve_inside_workspace`（lexical 版）——symlink 逃逸不被拦。MUST 用 `resolve_existing_inside_workspace`。
- 读取大文件用 `fs::read_to_string` 不带 cap——TOCTOU 增长直接 OOM。MUST 用 `take(MAX+1).read_to_end`。
- 把 workspace 路径 hardcode 在 cmd 内部——renderer 端 `useWorkspaceFileService(workspacePath)` 传入，不要在 Rust 侧再 hardcode `dirs::home_dir().join(".myagents/workspaces")`。
- 在单个 mutation command 里自行判断 `.claude/skills` 字符串前缀——Windows junction、大小写与断链会绕过。MUST 调用共享 mutation guard；普通项目 Skill 物理目录不应被误伤。
- watcher 用 path-derived key 做 stop 索引——重命名/删除/symlink swap 后 stop 失效。MUST 用 `watch_start` 返回的 opaque token；`watch_stop({token})` 索引；进程 nonce 防跨重启 token 碰撞。

应用内 rename/move 提交成功后，由 Rust mutation owner 在既有 `workspace:files-changed:<eventKey>` 通道立即发出 `{moves: [{oldPath, newPath}]}`，多项 move 只包含成功项。`useWorkspaceChangeSignal` 先交付映射再触发重读，打开的预览按路径组件映射文件及目录后代；同文档搬迁保留编辑缓冲与已保存基线，普通文件切换仍重置。保存、rename、move 通过 `acquire_edit_mutation` 复用按 canonical workspace identity 的 `KeyedLifecycleRegistry`，使已有文件校验与原子保存不会跨越应用内搬迁、重建旧路径。预览关闭及视图转换复用同一个保存流程，失败不卸载草稿。OS watcher 仍只发粗粒度刷新；外部路径失效显示提示，不推测新路径、不承诺外部进程事务或强制退出时的草稿恢复。

Sidecar HTTP workspace IO endpoint 已全部下线，Renderer 唯一入口是 `useWorkspaceFileService(workspacePath)`。eslint `no-restricted-syntax` 规则封禁已删除 endpoint 的字符串字面量。

---

<a id="workspace-path-identity"></a>
## `workspacePath` 工作区路径标识比较 (`src/shared/workspacePath.ts`)

**Problem.** 同一工作区在不同存储里可能使用Windows反斜杠或POSIX正斜杠。raw `===`（或只替换斜杠的局部归一化）会让 Task、Recent Session和工作区过滤静默失配；每个调用点自行实现比较也必然漂移。

**Surface.**
- `workspacePathsEqual(a, b)` — `.find` / `.some` 谓词用（接受 nullish）
- `normalizeWorkspacePathIdentity(p)` — Set / Map 键用（**build + lookup 两侧都要过**）

**Invariants enforced.** 是 Rust `normalize_path` 的逐行 TS 端口：Windows 式路径分隔符归一 + 去尾斜杠（保留根）+ Windows 盘符/UNC 小写；POSIX 大小写敏感、反斜杠当字面字符。于是渲染层"哪个 Project 拥有这个路径"与 Rust 对 cron 的分组**按构造一致**，不靠各调用点记得归一。

**Don't.** 比较工作区路径（`Project.path` ↔ `CronTask`/`Task`.workspacePath / session `agentDir` / config `defaultWorkspacePath`）禁止 raw `===` 或 inline `.replace(/\\/g,'/')`。需要分组时用 `normalizeWorkspacePathIdentity` 作为 Map/Set key；若分组结果要写回配置，仍保留用户原始路径作为 persisted value。已知**有意留白**：同源 within-tree 的 `node.path` 比较；React.memo prop 相等。

---

<a id="project-agent-workspace-authority"></a>
## Project / Agent workspace authority (`src/shared/agentWorkspaceIdentity.ts`)

**Problem.** 历史 `Agent.workspacePath` 与 `Project.path` 会因移动目录、旧版本重复 Agent 或跨平台路径形态而分叉。用 path 同时选择 AgentConfig 和工作目录会形成双 authority：严格检查会卡住旧用户，宽松 `.find()` 又会静默选错数组中的 Agent。

**Surface.** Project-backed 调用方先定位唯一 Project，再用 `Project.agentId` exact lookup AgentConfig；工作目录始终取 `Project.path`。Renderer/Node 的修复与 historical extra/orphan 投影统一走 shared policy。Rust 只做等价的只读 runtime projection。旧 `Agent.workspacePath` 只能由 `src/shared/legacyAgentWorkspace.ts` 与 Rust `im/config_store.rs` 的 raw adapter 读取。

**Invariants enforced.** 有效 ID 优先于任何旧 path；缺失/失效 ID 才按 canonical path 选择持久化顺序中的第一个旧 Agent。新 birth 在 `agent-config-intent.lock` 内先写 Project ID、再创建同 ID 的 pathless Agent，重试复用 stale ID。已有 Session 不参与 live 修复。历史 extra/orphan 保留 exact-ID addressability 与 Rust auto-start；legacy Project association 没有 Project lifecycle mutation 权限。

**Don't.** 不要恢复 `getAgentByWorkspacePath` / `findAgentByWorkspacePath`，不要在正常 `AgentConfig`、Tauri command payload 或 UI props 中重新加入 workspace 字段，不要把旧 path mismatch 当权限检查，也不要从 Agent 删除反推或级联删除 Project。源码护栏 `agentWorkspaceAuthority.guard.unit.test.ts` 固化这些边界。

---

<a id="client-action-slash"></a>
## Client-action 斜杠命令 (`src/renderer/utils/slashActions.ts`)

**Problem.** 多数斜杠命令要么插文本发给 AI（`/compact`），要么是 Rust 扫描器发现的磁盘 skill/command。但有一类是 **client-action**：选中触发**渲染层 UI 动作**（`/goal` 打开目标模式面板，`/loop` 作为兼容 alias），从不发给 AI。若把它当普通 builtin 注册进 Rust/shared 文本插入清单，会在没接处理器的宿主里成为"点了没反应"的死条目；若不保留名字，用户一个叫 `goal` / `loop` 的磁盘 skill 会把 `/goal` / `/loop` 静默 shadow 成插文本。

**Surface.**
- `CLIENT_ACTION_SLASH_COMMANDS` — 定义（仅渲染层，唯一来源）
- `withClientActionCommands(commands, enabled)` — **仅当**宿主接了 `onSlashAction`（`enabled`）才注入，并 **reserve** 其名字（抢占同名磁盘 skill）
- `isClientActionCommand(cmd)` — 分发时判断走动作还是插文本

**Invariants enforced.** 命令与其动作**按构造耦合**：没处理器就不出现（不会死条目），名字被保留（不会被同名 skill shadow）。

**Don't.** 把 client-action 命令（如 `goal` / `loop`）加进 Rust / `shared` 的文本插入 builtin 清单——会在 launcher 等无处理器场景出现死条目。它只属于 `slashActions.ts`。

---

<a id="theme-tailwind-bridge"></a>
## Theme package 与 Tailwind utility bridge

**Problem.** Theme stylesheet 由 runtime 动态激活，不会再次经过 Tailwind 编译。把 raw `@theme` 放进 Theme package，或只在 runtime CSS 新增 Tailwind utility 对应值，会让 `font-sans`、`shadow-sm`、`rounded-*` 等 utility 静默退回 framework default；切换 Theme 时表面 Token 已变，实际组件却仍使用旧/默认视觉值。

**Surface.**
- concrete Theme runtime values：`src/renderer/theme/themes/*.css`
- 唯一编译期 bridge：`src/renderer/index.css` 的无值 `@theme inline`
- contract/build guard：`ThemeRegistry` stylesheet 校验 + `npm run verify:theme-css`

**Invariants enforced.** Theme package 只交付完整、精确 scope 的 runtime Token 与 adapters，不声明 Tailwind 编译元数据；`index.css` 只把 utility 名映射到语义 runtime Token，不拥有视觉值。新增或改名 utility Token 时必须同步 bridge，并让 `verify:theme-css` 在生成 CSS 中证明映射真实生效。

**Don't.** 不要在 `src/renderer/theme/themes/**` 写 raw `@theme` / `@property` / `@font-face` 等全局副作用，也不要仅凭 Theme stylesheet 中存在某个变量就假设 Tailwind utility 会自动消费它。完整 Theme contract、selector 与 adapter 规则见 `theme_system.md`。

---

<a id="system-skill-sync"></a>
## System-skill 同步完整性门控 (`cmd_sync_system_skills` + `seedBundledSkills`)

**Problem.** 把内置 system skill同步到`~/.myagents/skills/`时，若**先清/替换目标再校验源**，打包不完整的bundle会把可用副本换成空目录；如果随后写入版本戳，坏状态会被永久视为已完成。

**Surface / Invariants enforced.**
- 普通 "完整 skill" = 含顶层 `SKILL.md`；Cuse 携带 native CLI，还必须通过 metadata/完整文件清单与执行权限校验，并在版本 fast path 比较 App 源实际 payload（签名后的字节为准，见 [Cuse bundle](cuse_bundle.md)）。源不完整 → **保留现有副本** + `ulog_warn`，**不**清目标。
- 版本戳 `complete = missing.is_empty() && incomplete.is_empty()` 时才写；任一缺/不完整 → 不写戳 → 下次启动重试。平台跳过的 skill 是有意的、不算缺陷、不阻塞。
- Rust `cmd_sync_system_skills` 与 Node `seedBundledSkills` 两条 seed 路径**同款逻辑**。
- `SYSTEM_SKILLS` 是版本化安装集合；`src/shared/systemSkills.ts::REQUIRED_SYSTEM_SKILLS` 是其中始终启用的 canonical 产品契约子集，Rust workspace/slash 路径在 `src-tauri/src/workspace_files/skills_config.rs` 维护必要镜像，并由 cross-language test 锁定。读取/写回 `skills-config.json` 都会移除 Required 的 stale disabled 项，list 投影固定为 `required:true, enabled:true`，disable API fail closed；普通系统/用户 Skill 仍保留可禁用语义。
- 同步之后的 Runtime admission 不再把“目录存在”当“Skill 完整”。`global-skill-inventory.ts` 每个业务边界完整扫描一次，只把可信物理目录、可读 canonical `SKILL.md` 且未命中强冲突证据的项交给 resolver / workspace projection。`SKILL(N).md` sibling 与无其它证据的 `(N)` 目录只 warning；缺 canonical、collision identity/sibling、global symlink/junction 与扫描竞态 blocked。Required blocked/missing 拒绝 Runtime；optional blocked 只移除当前工作区 managed link，所有原始文件保留。
- `EffectiveProjectCapabilitySnapshot.revision` 仍只表示 effective Runtime 内容；`integrityRevision` 单独表示诊断与 desired managed-link set。纯 warning/no-op reconcile 不换代，只有实际 unlink/create 才复用既有 deferred replacement。二者不进入持久 cache。Rust Launcher 使用共享 JSON fixtures 镜像 classifier，并先跳过指向 global root 的 project junction，避免同一 Skill 被误认成 project winner。

**Don't.** seed/sync 里覆盖前不验源完整就 `remove_dir_all(dst)`；或对不完整结果照写版本戳。两者都会把瞬时打包缺陷固化成持久态。不要用 watcher、后台 timer、持久 registry 或全工作区 sweep 代替 admission snapshot，也不要自动 rename/delete/merge 可疑目录。改 Required 名单时必须同步 TS canonical 与 Rust mirror，禁止在 UI、CLI 或其它模块新增第三份名单，也不要把 Required 名称重新写进 disabled 配置。

---

## 与文档的协作关系

- **CLAUDE.md** —— 只保留跨任务长期有效的心智模型，并把命中的任务路由到本文档；不镜像 helper / 红线清单。
- **ARCHITECTURE.md** —— 只描述 owner、进程边界与主数据流；helper 改变这些内容时才更新对应章节。
- **本文档** —— helper 的完整 spec、API surface、不变量与踩坑根因。
- **代码、lint 与测试** —— 当前 API 和可执行约束的权威来源；诊断文字必须同时说明故障模式与正确路径。

新增 helper 时更新实现、测试 / lint（可机械判定时）和本文档。只有跨任务心智模型变化才更新 `CLAUDE.md`；只有 owner、进程边界或主数据流变化才更新 `ARCHITECTURE.md`。避免为了“保持三份同步”制造三个会漂移的权威来源。

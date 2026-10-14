# 自动更新架构

本文只描述桌面应用自动更新的当前 owner、平台差异和安全不变量。发布凭据、构建命令和上传步骤由 [`../guides/build_and_release_guide.md`](../guides/build_and_release_guide.md)、各平台构建指南与 `.github/workflows/release.yml` 管理。

## 产品语义

更新检查与下载默认静默进行。用户只在新版本已可安装时看到「重启更新」入口：

```text
应用启动
  -> 延迟检查；Renderer 后续定时检查
  -> 有新版本时 emit updater:download-started
  -> 下载并形成平台对应的可安装状态
  -> 成功 emit updater:ready-to-restart
     失败 emit updater:download-failed
  -> 用户明确点击后安装并重启
```

Rust `src-tauri/src/updater.rs` 拥有检查、下载、pending package、安装和重启流程。Renderer `src/renderer/hooks/useUpdater.ts` 只投影 Rust 事件、控制按钮互斥，并发起安装命令；它不拥有更新包或安装结果。

启动检查在应用启动后延迟 60 秒；Renderer 每 30 分钟再次触发检查。常量与实际时序以实现为准。Debug 构建禁止真实下载和安装，避免线上版本覆盖开发 bundle。

## 平台路径

| 平台 | 下载阶段 | 用户点击后的安装阶段 |
| --- | --- | --- |
| macOS | 先原子替换 package 文件，再写版本元数据 | 从 pending bytes 安装，成功后立即受管重启 |
| Windows | 以相同顺序持久化 pending NSIS installer 与元数据 | 进入 update-quiesce，完成 verified-clean handoff 后启动 installer |
| Linux（当前 Ubuntu deb） | 不自动检查或下载 | 从发布页下载 deb，手动覆盖安装 |

macOS 和 Windows 的 pending package 是跨进程重启的 durable truth。应用下次启动仍会检测它并提供安装入口。当前 Linux 只交付 deb，不能套用 AppImage 原地替换流程：Rust updater 的统一准入在网络请求与安装前拒绝 Linux，Renderer 不订阅更新事件、不创建周期检查、不提供应用内更新动作；设置保留发布页链接并说明手动升级。`createUpdaterArtifacts: false` 仅控制构建产物，不能替代运行期禁用。

## Pending package 与内存状态

macOS / Windows 使用：

- `pending_update.bin`：已验证的更新包字节；
- `pending_update.json`：与字节对应的版本元数据；
- `DOWNLOADED_VERSION`：当前进程对已提交磁盘版本的镜像；
- `LATEST_UPDATE`：仅用于安装 API 所需的 `Update` 对象缓存。

当前提交与校验语义：

1. 新下载替换路径不在 `updater.check()` 刚返回时更新 `LATEST_UPDATE`，而是在 `save_pending_update_to_disk()` 成功后缓存。已下载版本或磁盘同版本命中时会直接对齐 cache；安装期 cache miss 的网络 fallback 也会缓存取得的 `Update`。
2. package 使用临时文件加 rename 发布，metadata 随后直接写入；两者不是一个原子事务。只有两个步骤都成功后才发 `ready-to-restart`，但 package rename 后 metadata 写入失败会留下可能不一致的磁盘 pair。
3. 清理 pending package 时必须同时清空 `DOWNLOADED_VERSION` 和 `LATEST_UPDATE`。
4. 启动期 `check_pending_update()` 用当前应用版本淘汰 stale metadata；安装期读取磁盘 bytes / metadata，优先使用 cache、缺失时经网络取得 `Update`，再要求 `Update.version == pending_version`。版本不匹配时 fail closed 并清理 pending state。
5. 新版本下载替换旧 pending package 时，`download-started` 到 `ready-to-restart` / `download-failed` 形成完整终态对。`download-failed` 只结束本次 preparing 状态，不保证旧 package 仍然完整可安装。

Renderer 的 `updateReady`、`preparing` 和启动对话框只是上述磁盘状态的 UI 投影。`preparing=true` 时所有安装入口都必须隐藏，避免用户在替换 pending bytes 的临界区点击。

## macOS live bundle 约束

运行中的 macOS bundle 不能在后台被替换。Tauri 安装过程会移动当前 `.app`；继续运行的旧进程将失去可解析的 bundle path，TCC 无法正确归因麦克风、屏幕录制等权限请求。

因此 macOS 只后台下载，不后台安装。安装必须由用户点击触发，成功后立即进入 `request_restart`，旧进程不能返回普通交互状态。

## 用户确认重启与活动保护

macOS 的安装入口先取得已有 lifecycle update-quiesce exclusive permit，再检查
`TaskSchedulerController.executions` 与每个 Sidecar 的精确 generation。Task 的
`Running` 行仅表示调度已启用，不是执行证据；只有瞬时 execution 才阻止安装。
所有新的 scheduler execution claim 与进程创建使用同一 shared permit。已准入创建尚未完成时安装直接返回 busy，保持原准入开放，不关闭 gate 后等待并误拒其后续资源创建。

录音 live/paused/settling、文档及语音队列/活动/探测 reservation 由各自 owner
检查，新提交复用同一 shared permit。Terminal 没有可靠的当前命令 idle 协议；
任何仍打开的用户 PTY 都要求用户完成并主动关闭后重试，更新不终止终端。

每个 Node Sidecar 通过具有内部 caller 凭据和 generation 校验的 lifecycle 端点，
在既有 SessionEngine query facade 同步关闭 turn admission 并读取 adapter 活动。
正在执行、已准入且仍等待 IO、排队、等待审批/提问、SDK 后台任务或 compaction
均返回 `UPDATE_BUSY`。代次、网络或状态读取失败返回 `UPDATE_ACTIVITY_UNKNOWN`；
两者都保留 pending 更新包且不停止原任务。已冻结的 idle owner 由同一事务 token
释放，迟到 release 不能打开新事务。成功安装后保持关闭直到受管重启；安装失败
释放冻结和 lifecycle gate。Renderer 状态不参与此安全裁决。

独立 Host daemon 和远端机器的执行有自己的生命周期，不能从桌面 Session idle
推断它们空闲，也不能为了更新桌面客户端主动停止它们。

## Windows installer handoff

Windows 安装前必须证明当前安装目录不再被 MyAgents 进程树占用：

1. installer handoff 获取 update-quiesce exclusive permit；Sidecar、Plugin Bridge、IM Channel、Terminal、Browser 等创建入口使用 shared permit。exclusive permit 到手后不能再产生新进程。
2. 按 owner 依次停止 IM、Agent/Sidecar、Terminal 和 Browser。Terminal kill 后必须 bounded wait。
3. `process_cleanup` 只在这个 recovery / updater 场景枚举和清理指向当前安装或 resource root 的残留进程；正常 shutdown 不使用全机扫描。
4. 再次扫描残留 descendant，并对关键 executable / bundle 文件执行 Windows 独占打开 probe。
5. 只有进程扫描和文件锁 probe 都通过，才调用 `Update::install(bytes)`。

任何 owner 无法停止、残留进程、关键路径无法解析或文件仍被占用，都在 MyAgents UI 内 fail closed，并保留 pending package 供用户重试。不得把用户送进 NSIS 的 Abort/Retry/Ignore 分叉。

verified-clean handoff 只证明进程与锁已释放，安装资源的完整替换仍由 NSIS 拥有。自动更新跳过旧版卸载，但 PREINSTALL 在复制资源前完整移除应用自有 `nodejs/`；PREUNINSTALL 同样清理该组件，避免新版本卸载清单遗漏旧依赖。删除失败停止安装，不混合新旧 npm，也不安排重启后删除新文件。手动覆盖升级与同版本重装复用这条路径，用户数据目录不受影响。

上游 installer 可能在 `%TEMP%` 创建 `MyAgents-<version>-updater-*` 派生目录。它们不是 pending authority；启动 GC 只清理名称精确匹配、类型为普通目录且超过保留期的条目，不读取或改写应用数据目录中的 pending package。

## 事件与 UI

| 事件 | 含义 | Renderer 行为 |
| --- | --- | --- |
| `updater:download-started` | 新版本的 pending state 正在构建 | 设置 `preparing`，隐藏安装入口 |
| `updater:download-failed` | 本次下载或持久化未完成 | 清除 `preparing`；不能据此推断旧 package 仍完整 |
| `updater:ready-to-restart` | 对应版本已经形成可安装状态 | 设置 `updateReady` 并显示版本 |
| 下载进度事件 | 后台状态或诊断 | 不改变“静默下载”的产品语义 |

`CustomTitleBar`、Settings 和启动 pending 对话框必须共用 `useUpdater` 的同一状态，不各自推导更新是否可安装。

## 网络与发布契约

- Updater endpoint、公钥和 capability 以 `src-tauri/tauri.conf.json` 及 capability 配置为准。
- 外部更新请求属于 general network owner，使用 `proxy_config` 的 general helper；loopback 不参与更新下载。
- 清单、artifact、签名和版本必须由 release workflow 一起发布。文档不复制域名目录结构和示例 JSON，以免与 workflow 漂移。
- 应用拒绝降级；server/CDN 返回的 stale version 不能覆盖更高的当前版本或 pending version。

## 验证

确定性测试至少覆盖：

- pending package 的原子提交、清理和 cache=disk 一致性；
- stale / downgrade / version mismatch；
- latest-wins 下载的成功与失败终态；
- Windows quiesce admission、残留进程与文件锁 fail-closed；
- Windows updater 临时目录 GC 的精确范围；
- Renderer 三个事件与多入口按钮状态一致。

发布前还需在对应平台的已签名安装包上验证真实更新：后台下载、退出后恢复 pending、点击安装、进程树收敛、应用重启与版本变化。构建及发布步骤以平台指南为准。

## MoxBots 独立发布与任务保护

Mox profile 使用独立更新地址、公钥与0.5.3发行版本，MyAgents默认地址/公钥保持原值。首个支持更新的版本必须手动安装，旧的updater-disabled 0.5.2不能自行发现此更新。当前部署仅交付macOS arm64，其他目标端点返回204，Linux保持手动deb。发布准备/验证/原子推广/回滚见scripts/moxbot-updates/README.md。

确认重启不提供中断任务的覆盖选项。读任务/会话/审批、SDK后台和DSH子Agent、录音/处理队列及用户终端的真实owner；busy或unknown均保留pending并继续原工作。既有Lifecycle shared admission与nonwaiting exclusive检查保护资源出生，已准入创建导致更新暂缓；Node mutable准入与builtin delayed warm-up同步冻结，仅空闲owner可安装。必须确认active transcript writer健康且liveRevision==durableRevision，原生异步子Agent观测后再次复读，避免已完成但未落盘的回答丢失。

安装和下载共享pending guard，install前用profile pinned public key复验磁盘字节，不能依赖早先download验签。签名失败清理失效pending，用户可重新检查下载。上游可下载资源继续用原资源签名根，不替换为Mox更新密钥。

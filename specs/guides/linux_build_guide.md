# Linux 平台构建与运行指南

MyAgents 在 Linux 上通过 AppImage（便携）+ deb（apt 源）分发。

## 支持矩阵

| 发行版 | 架构 | libc | 支持级别 |
|--------|------|------|---------|
| Ubuntu 22.04+ LTS | x64, arm64 | glibc | 一等（官方测试 baseline） |
| Debian 12+ | x64, arm64 | glibc | 一等 |
| Fedora 40+, openSUSE | x64 | glibc | 二等（应该工作，未严格测试） |
| Arch / Manjaro | x64 | glibc | 二等 |
| Alpine | x64, arm64 | **musl** | 三等（需用户手动替换 SDK native binary 和 Node.js） |

**架构说明**：MyAgents Linux 默认构建 `x86_64-unknown-linux-gnu`，对应 glibc 发行版。arm64（`aarch64-unknown-linux-gnu`）需在对应 Linux arm64 主机上构建 —— Tauri 不支持从 macOS 交叉编译 Linux。

## 构建环境准备

### 系统依赖（Ubuntu 22.04+ / Debian 12+）

```bash
sudo apt-get update
sudo apt-get install -y \
    build-essential \
    cmake \
    curl \
    wget \
    file \
    libssl-dev \
    libgtk-3-dev \
    libayatana-appindicator3-dev \
    librsvg2-dev \
    libwebkit2gtk-4.1-dev \
    patchelf \
    pkg-config
```

**说明**：
- `cmake` — speech native adapter 要求 3.28+；若发行版仓库版本较旧，需从 CMake 官方渠道安装满足要求的版本
- `libwebkit2gtk-4.1-dev` — Tauri WebView 后端（Linux 用 WebKit2GTK；不像 macOS 的 WKWebView 或 Windows 的 WebView2）
- `libayatana-appindicator3-dev` — 系统托盘图标库
- `patchelf` — AppImage 打包要求的 RPATH 补丁工具

### 开发者环境（非构建用）

```bash
./setup.sh  # 已自动检测 Linux 并调用 download_nodejs.sh 下载 Linux Node.js
```

`setup.sh` 在 Linux 上的行为：
- 检查 Node.js / npm / Rust / Cargo / rustup，并按 `rust-toolchain.toml` 准备固定 toolchain 与 `rustfmt` / `clippy`
- 根据当前 target 和 exact prepared cache 提前检查 CMake 3.28+/C++ 等原生推理构建工具；缺失时在下载或安装项目依赖前给出修复命令，不自动安装原生构建工具
- `scripts/download_nodejs.sh` 下载 Node.js v24 Linux x64/arm64 tarball（按 `uname -m` 自动选择）
- `npm install` 拉取依赖（包括 SDK platform optional dep `@anthropic-ai/claude-agent-sdk-linux-<arch>`）
- Rust `cargo fetch`
- 准备当前架构的离线文档 Worker、media Worker、OCR、speech native、ONNX Runtime 与 PDFium；资源缓存跨 `npm run clean` 复用

Mino 默认工作区模板已提交在 `bundled-workspaces/mino/`，setup 和构建不再下载外部模板仓库。

## 构建

```bash
./build_linux.sh                    # 按 uname -m 默认 target
./build_linux.sh aarch64-unknown-linux-gnu  # 明确 target
```

产物路径：
- AppImage：`src-tauri/target/<target>/release/bundle/appimage/MyAgents_<ver>_<arch>.AppImage`
- deb：`src-tauri/target/<target>/release/bundle/deb/MyAgents_<ver>_<arch>.deb`

### AppImage 用法

```bash
chmod +x MyAgents_0.2.0_amd64.AppImage
./MyAgents_0.2.0_amd64.AppImage
```

AppImage 是**便携格式**：自带所有依赖，不需要 root，直接双击运行。桌面快捷方式可用 [AppImageLauncher](https://github.com/TheAssassin/AppImageLauncher) 自动集成。

### deb 用法

```bash
sudo dpkg -i MyAgents_0.2.0_amd64.deb
sudo apt-get install -f  # 补齐缺失的系统依赖（正常情况下 deb 元数据已声明）
```

安装后启动：
```bash
myagents  # deb 把可执行文件链接到 /usr/bin/
# 或从桌面菜单启动（Applications > Development > MyAgents）
```

## 运行时依赖

AppImage 和 deb 内部都包含：

| 组件 | 路径（app 内） |
|------|--------------|
| Sidecar / Bridge / CLI | `resources/server-dist.js` / `resources/plugin-bridge-dist.mjs` / `resources/cli/myagents.cjs` |
| Node.js v24（含 npm/npx） | `resources/nodejs/bin/node`（+ `lib/node_modules/npm`） |
| Claude Agent SDK native binary | `resources/claude-agent-sdk/claude`（~210 MB，SDK team 静态链接） |
| 本地文档/语音推理 | `resources/document-processing/v1/` + `resources/speech-inference/v1/`；两者共享同 target ONNX Runtime identity |
| mino 默认工作区模板 | `resources/bundled-workspaces/mino/` |
| bundled skills / agents / workspaces | `resources/bundled-skills/` / `resources/bundled-agents/` / `resources/bundled-workspaces/` |

`resources/bundled-workspaces/mino/` 只承载默认工作区的文件内容。Mino project 的 Agent 默认开启、heartbeat、memory 自动更新等产品策略仍由应用内 `src/shared/config-types.ts::PRESET_TEMPLATES[].agentDefaults` 声明，Launcher / Config migration 在创建 `AgentConfig` 时复制这些默认值。安装包模板只创建新实例，不覆盖用户已有工作区。

**不内置**：
- `git` — 大多数发行版默认安装；缺失时 Claude Code 工具会降级
- `bash` / 核心 POSIX 工具 — 系统自带
- 「浏览器」的 Chromium / Headless Shell / FFmpeg — 只在用户首次点击“安装资源”后由 Rust owner 下载 signed runtime set；普通 AppImage/deb build 不下载也不打包

Linux 录音使用 `cpal` 的 PipeWire host：microphone 来自默认 input，system audio 只接受 PipeWire `default_sink` monitor input。monitor 不可用时允许以明确 warning 继续 microphone-only；PipeWire host 不可用或没有任何来源时录音 admission 失败。安装包不得通过捆绑 ffmpeg/PulseAudio bridge 或脚本 fallback 改变这一契约。x86_64/aarch64 发布都要在真实 PipeWire 环境验证 microphone；system audio 支持只在 monitor 可用的发行版/桌面组合声明。

## 常见问题

### `libwebkit2gtk` 版本不对（WebView 打不开）

**现象**：AppImage 启动后白屏或"failed to connect to dbus"

**排查**：
```bash
apt list --installed | grep webkit2gtk
```

Ubuntu 22.04 默认是 `libwebkit2gtk-4.1-0`，这是正确的。如果你是从 Ubuntu 20.04 升级来的，可能卡在 4.0 导致兼容性问题。

### SDK native binary 执行失败（musl / Alpine）

`@anthropic-ai/claude-agent-sdk-linux-<arch>-musl` 包提供 musl 变体。若构建 Alpine 发行版，在 `build_linux.sh` 中把 `SDK_TRIPLE` 改为 `linux-x64-musl` 或 `linux-arm64-musl`。

### deb 安装失败提示依赖缺失

```bash
sudo apt-get install -f
```

或显式安装声明的依赖：

```bash
sudo apt-get install -y libwebkit2gtk-4.1-0 libayatana-appindicator3-1 librsvg2-2
```

### FUSE 未安装（AppImage 启动错误）

某些最小化发行版（如某些 Docker 镜像、裁剪过的服务器镜像）默认不装 FUSE。

```bash
sudo apt-get install -y fuse libfuse2
```

或用 `--appimage-extract-and-run` 跳过 FUSE：

```bash
./MyAgents_0.2.0_amd64.AppImage --appimage-extract-and-run
```

## 发布 / CI

[`publish_linux.sh`]（待建 —— 当前手动上传）：产物上传到 R2 的 `https://releases.myagents.io/linux/` 路径；Tauri updater manifest 自动包含 Linux 条目。

---

**为什么 Linux 到 v0.2.0 才一等支持**：v0.1.x 的 Bun-based Sidecar 理论能跑 Linux，但双 runtime 策略（Bun + Node.js）导致 Linux 构建 pipeline 需要分别处理两套 binary 分发；v0.2.0 统一到 Node.js 后，Linux 只需维护单一 runtime 链路，刚好是收敛这块的最佳时机。详见 [prd_0.2.0_node_runtime_migration.md](../prd/prd_0.2.0_node_runtime_migration.md)。

Cuse 目前只发布 macOS/Windows Skill+CLI；Linux 构建会清除共享构建树里的 Cuse staging，启动同步跳过该 Skill。详见 [Cuse bundle](../tech_docs/cuse_bundle.md)。

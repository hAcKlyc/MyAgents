# MyAgents Windows 构建与测试指南

本文档描述 MyAgents Windows 版本的构建流程、发布流程以及测试注意事项。

---

## 概览

MyAgents Windows 版本支持 **x86_64 (64位)** 架构，提供两种分发格式：

| 格式 | 文件 | 用途 |
|------|------|------|
| **NSIS 安装包** | `MyAgents_x.x.x_x64-setup.exe` | 标准安装，有向导界面 |
| **便携版** | `MyAgents_x.x.x_x86_64-portable.zip` | 解压即用，无需安装 |

### 存储位置

与 macOS 版本共用 Cloudflare R2 存储：

```
myagents-releases/
├── update/
│   ├── darwin-aarch64.json     # macOS ARM (Tauri Updater)
│   ├── darwin-x86_64.json      # macOS Intel (Tauri Updater)
│   ├── windows-x86_64.json     # Windows x64 (Tauri Updater)
│   ├── latest.json             # macOS 网站下载 API
│   └── latest_win.json         # Windows 网站下载 API
└── releases/
    └── v{VERSION}/
        ├── MyAgents_{VERSION}_x64-setup.exe       # NSIS 安装包
        ├── MyAgents_{VERSION}_x86_64-portable.zip # 便携版
        ├── MyAgents_{VERSION}_x86_64.nsis.zip     # 自动更新包
        └── MyAgents_{VERSION}_x86_64.nsis.zip.sig # 更新签名
```

---

## 环境准备

### 系统要求

- Windows 10/11 (x64)
- PowerShell 5.1+ (推荐 PowerShell 7)

### 必需软件

| 软件 | 用途 | 安装方式 |
|------|------|---------|
| **Rust** | 编译 Tauri 后端 | https://rustup.rs（必须使用 rustup；仓库 `rust-toolchain.toml` 固定实际 toolchain） |
| **Node.js / npm** | 前端构建、Node bundle 打包、依赖安装 | https://nodejs.org |
| **CMake 3.28+** | 构建离线 speech native 依赖 | https://cmake.org/download/ |
| **Visual Studio Build Tools** | MSVC 编译器 | 见下方说明 |
| **rclone** | 发布到 R2 (仅发布时需要) | https://rclone.org |

### Visual Studio Build Tools 安装

1. 下载 [Visual Studio Build Tools](https://visualstudio.microsoft.com/visual-cpp-build-tools/)
2. 运行安装程序
3. 选择 **"Desktop development with C++"** 工作负载
4. 确保勾选以下组件：
   - MSVC v143 (或最新版本)
   - Windows 10/11 SDK

### 环境初始化

首次 clone 仓库后运行：

```powershell
.\setup_windows.ps1
```

此脚本会：
1. 检查基础依赖，并按 `rust-toolchain.toml` 准备 Rust toolchain、`rustfmt` / `clippy`、`x86_64-pc-windows-msvc` target
2. 根据 exact prepared cache 提前检查 CMake 3.28+/MSVC 等原生推理构建工具；缺失时在下载或安装项目依赖前给出修复命令，不自动安装原生构建工具
3. 下载 bundled Node.js v24 运行时、Git 安装包和 VC++ Runtime DLL
4. 安装前端/后端依赖 (`npm install`)
5. 下载 Rust crates（`cargo fetch`）
6. 准备 x64 离线文档 Worker、OCR、ONNX Runtime 与 PDFium；资源缓存跨 `npm run clean` 复用

### Git 安装包（构建必需）

NSIS 安装程序会内置 Git for Windows，需要手动放置安装包：

1. 下载 Git for Windows：https://git-scm.com/downloads/win
2. 将安装包重命名为 `Git-Installer.exe`
3. 放置到 `src-tauri/nsis/Git-Installer.exe`

> **注意**：此文件已加入 `.gitignore`，不会提交到仓库

---

## 构建流程

### build_dev_win.ps1

**用途**：快速打一个带 DevTools 的 Windows debug 构建，用于真机功能验证；默认不生成安装包。

**运行方式**：

```powershell
.\build_dev_win.ps1
```

默认产物：

```
src-tauri/target/x86_64-pc-windows-msvc/debug/myagents.exe
```

如果需要验证安装器、NSIS hook、VC++ Runtime app-local 部署或安装后启动行为，再显式构建 Debug NSIS：

```powershell
.\build_dev_win.ps1 -BundleNsis
```

`build_dev_win.ps1` 会清理 `debug/resources` 缓存、启用 `VITE_DEBUG_MODE=true`、构建 web/Sidecar/Plugin Bridge/CLI 一次，并在 Tauri build 阶段禁用重复的 `beforeBuildCommand`；这条路径用于快速测试，不替代正式发布构建。

两条 Windows 构建路径都会在 Tauri snapshot 前调用 `scripts/prepare-native-inference.mjs x86_64-pc-windows-msvc`，统一准备 document/speech capability。Sherpa 的锁定源码包只展开构建所需的根 `CMakeLists.txt`、`LICENSE`、`cmake/` 与 `sherpa-onnx/`；上游仓库其它目录中的 symlink 不会在 Windows 上落盘，不需要启用 Developer Mode、管理员权限或长路径开关。正式安装器验证除既有文档转换外，还必须检查 `speech-inference/v1` 的签名 manifest、media Worker/sherpa native inventory、与 `document-processing/v1` 共享的 ONNX Runtime identity，以及无系统 ORT/ffmpeg/Python 时的 WASAPI microphone/loopback、转录与 Job Object 取消。

### build_windows.ps1

**运行方式**：

```powershell
.\build_windows.ps1
```

**可选参数**：

| 参数 | 说明 |
|------|------|
| `-SkipTypeCheck` | 跳过 TypeScript 类型检查 |
| `-SkipPortable` | 跳过便携版 ZIP 生成 |

**构建流程**（7 步）：

1. **加载环境配置** - 从 `.env` 读取签名密钥
2. **检查依赖与原生推理 preflight** - 验证 Rust/rustup、npm，补齐固定 Rust components/Windows target，初始化 MSVC 环境，并在下载、清理或构建前检查 CMake 3.28+/MSVC
3. **配置生产 CSP** - 更新安全策略
4. **TypeScript 类型检查** - 确保代码无类型错误
5. **构建前端和服务端** - 打包服务端代码、复制 SDK 依赖、构建前端
6. **构建 Tauri 应用** - 生成 NSIS 安装包
7. **创建便携版** - 打包 ZIP 文件

**构建产物位置**：

```
src-tauri/target/x86_64-pc-windows-msvc/release/bundle/nsis/
├── MyAgents_x.x.x_x64-setup.exe       # NSIS 安装包
├── MyAgents_x.x.x_x86_64-portable.zip # 便携版
├── MyAgents_x.x.x_x64-setup.nsis.zip  # 自动更新包
└── MyAgents_x.x.x_x64-setup.nsis.zip.sig  # 更新签名
```

**环境变量**：

| 变量 | 用途 | 必需 |
|------|------|------|
| `TAURI_SIGNING_PRIVATE_KEY` | Tauri 更新签名私钥 | 自动更新需要 |
| `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` | 私钥密码 | 自动更新需要 |

> **注意**：签名密钥与 macOS 版本共用。

---

## 发布流程

### publish_windows.ps1

**前置条件**：

1. 已运行 `build_windows.ps1` 完成构建
2. `.env` 中配置了 R2 凭证
3. 已安装 rclone

**运行方式**：

```powershell
.\publish_windows.ps1
```

**发布流程**（7 步）：

1. **加载配置** - 读取 R2 凭证
2. **检查 rclone** - 确保上传工具可用
3. **物料完整性检查** - 验证所有文件存在
4. **生成更新清单** - 创建 `windows-x86_64.json` (Tauri Updater) 和 `latest_win.json` (网站下载 API)
5. **上传确认** - 显示文件列表，等待确认
6. **上传构建产物** - 上传到 R2
7. **上传更新清单** - 上传 JSON 文件

`publish_windows.ps1` 只发布 Windows 桌面 App 和自动更新清单，不上传 Managed Codex Runtime，也不上传「浏览器」Chromium 资源。

### publish_managed_codex_runtime.ps1

**用途**：单独发布 Windows 平台的 Managed Codex Runtime 资源。它上传同一个 runtime set 下的 `win32-x64` manifest/artifact，和 macOS 的 `publish_managed_codex_runtime.sh` 共同补齐跨平台 runtime set。

```powershell
.\publish_managed_codex_runtime.ps1 -Yes
```

默认读取唯一权威锁 `src\shared\managed-codex-runtime.json::version`，并固定派生 `runtimeSet = codex-<version>`；升级时只改这个值，Rust、TypeScript、打包器和两端发布脚本都会自动派生相同版本，正式发布入口不接受版本 / set 覆盖。脚本会拒绝覆盖已存在的同平台 manifest；确实需要重发时显式加 `-ForceRepublish`。客户端按版本目录安装，旧 Sidecar 继续使用旧 exe，新 Sidecar 才切新版，因此不会尝试覆盖 Windows 正在运行的 `codex.exe`。

**环境变量**：

| 变量 | 用途 |
|------|------|
| `R2_ACCESS_KEY_ID` | Cloudflare R2 Access Key |
| `R2_SECRET_ACCESS_KEY` | Cloudflare R2 Secret Key |
| `R2_ACCOUNT_ID` | Cloudflare Account ID |
| `CF_ZONE_ID` | Cloudflare Zone ID (可选，用于清除 CDN 缓存) |
| `CF_API_TOKEN` | Cloudflare API Token (可选) |
| `MANAGED_CODEX_WINDOWS_PUBLISHER` | 可选，Windows Authenticode publisher 断言；默认 `OpenAI OpCo, LLC` |

### 「浏览器」Runtime（Windows x64）

Windows 不再运行 Browser packager 或向 R2 上传 Chromium，`build_windows.ps1` / `publish_windows.ps1` 也不会下载 Chrome 或把它放进 installer。`src\shared\managed-browser-runtime.json` 的 `win32-x64` 项锁定当前 Playwright Core registry 对应的官方 Chrome for Testing URL、archive size、SHA-256、archive root 与 `chrome.exe` 路径。升级该锁后，必须用 Windows release-like App 验证首次安装、更新进度、重启恢复和真实有头窗口；官方 exact artifact 不可读、摘要不匹配或 smoke 失败时，不能发布锁定它的 App 版本。

---

## 测试清单

### 一、环境初始化测试

```powershell
.\setup_windows.ps1
```

- [ ] 依赖检查正确识别已安装/未安装的组件
- [ ] Rust toolchain/components/Windows target 准备完成
- [ ] bundled Node.js 运行时下载成功
- [ ] 前端/后端依赖安装成功
- [ ] Rust crates 下载完成

### 二、构建测试

```powershell
.\build_windows.ps1
```

- [ ] 版本同步检查正常
- [ ] 服务端代码打包成功
- [ ] SDK 依赖复制完整
- [ ] Tauri 构建成功
- [ ] 生成 NSIS 安装包
- [ ] 生成便携版 ZIP
- [ ] 生成更新包和签名文件

### 三、安装包测试

**NSIS 安装包**：

- [ ] 安装向导正常显示（中文/英文）
- [ ] 可选择安装路径
- [ ] 安装完成后创建桌面/开始菜单快捷方式
- [ ] 从"添加/删除程序"卸载正常

**便携版 ZIP**：

- [ ] 解压后直接运行 `myagents.exe`（Cargo 包名是小写，主二进制即 `myagents.exe`）

### 四、应用功能测试

**启动**：

- [ ] 应用正常启动，无崩溃
- [ ] 窗口标题栏显示正常
- [ ] Sidecar 进程正常启动

**验证 Sidecar**：
```powershell
Get-Process | Where-Object { $_.ProcessName -eq "node" }
```

**核心功能**：

- [ ] 新建 Tab / 切换 Tab
- [ ] 发送消息，AI 正常响应
- [ ] 配置 Provider / Model
- [ ] MCP 服务器安装和使用

**进程管理**：

- [ ] 关闭应用后，所有子进程被清理
- [ ] 多 Tab 场景下，关闭单个 Tab 只杀对应 Sidecar

**验证进程清理**（关闭应用后执行）：
```powershell
Get-Process | Where-Object { $_.ProcessName -eq "node" }
# 应该返回空
```

**数据存储**：

- [ ] 配置保存在 `%APPDATA%\MyAgents\` 目录

**验证数据目录**：
```powershell
ls $env:APPDATA\MyAgents
```

### 五、自动更新测试

> 需要先运行 `publish_windows.ps1` 发布到 R2

- [ ] 应用启动后检测到更新提示
- [ ] 更新下载和安装正常

**验证更新清单**：
```powershell
# Tauri Updater (客户端自动更新)
curl -s https://download.myagents.io/update/windows-x86_64.json

# 网站下载 API
curl -s https://download.myagents.io/update/latest_win.json
```

---

## 注意事项

### 窗口标题栏

当前配置使用 `titleBarStyle: "Overlay"`，这是 macOS 风格。在 Windows 上需要额外配置：

- 自定义标题栏按钮需要 Tauri 权限：`core:window:allow-minimize`、`core:window:allow-close`
- 这些权限已在 `src-tauri/capabilities/default.json` 中配置

### WebView2 依赖

- Windows 10 (20H2+) 和 Windows 11 已预装 WebView2
- NSIS 安装包会在需要时自动下载安装 WebView2
- 便携版需要系统已有 WebView2（现代 Windows 默认已有）

### 代码签名

当前 Windows 版本**未签名**，用户首次运行时会看到 SmartScreen 警告：

> "Windows 已保护你的电脑"

用户需要点击"更多信息" → "仍要运行"。

后续如需消除此警告，需购买 Windows 代码签名证书（EV 证书可直接获得信任）。

### 路径问题

测试时注意以下场景：

- 用户名包含中文字符
- 路径包含空格
- 安装在非默认目录

---

## 故障排查

### 构建问题

**Rust 编译失败**

```
error: linker `link.exe` not found
```

解决：确保已安装 Visual Studio Build Tools 并选择了 C++ 工作负载。

**Node.js / npm 找不到**

```
npm : 无法将"npm"项识别为 cmdlet...
```

解决：
1. 确认 Node.js 已安装：https://nodejs.org
2. 重新打开 PowerShell 以刷新 PATH

**Rust target / component 缺失**

```
can't find crate for `core`
target may not be installed
component 'rustfmt' is unavailable/not installed
```

解决：

```powershell
.\scripts\ensure_rust_toolchain.ps1 -Targets x86_64-pc-windows-msvc
```

**前端构建 OOM**

```
FATAL ERROR: Reached heap limit Allocation failed
```

解决：`build_windows.ps1` 已设置 `NODE_OPTIONS=--max-old-space-size=4096`，如仍不够可增大此值。

**PowerShell 脚本中文乱码**

解决：所有 `.ps1` 脚本已添加 UTF-8 BOM，如手动创建脚本需确保编码正确。

**tauri.conf.json 解析错误**

```
Error: Invalid JSON
```

可能原因：Node.js 写入文件时添加了 BOM。解决方法见 `build_windows.ps1` 中的 BOM 移除逻辑。

### 运行问题

**应用启动后立即退出**

可能原因：
1. WebView2 未安装 - 安装 [WebView2 Runtime](https://developer.microsoft.com/en-us/microsoft-edge/webview2/)
2. bundled Node.js 运行时缺失 - 检查安装目录 resources 下是否包含 `nodejs\node.exe`

**Sidecar 启动失败**

检查日志文件，或在 PowerShell 中查看进程：

```powershell
# 检查是否有 Node sidecar 进程
Get-Process | Where-Object { $_.ProcessName -eq "node" }

# 检查端口占用
netstat -ano | findstr "31415"
```

### 升级体验问题

**安装新版本时提示必须先卸载旧版本**

**问题描述**：
从 v0.1.6 升级到 v0.1.7 时，双击安装包后提示"建议卸载现有版本"，用户必须手动卸载后才能安装新版本。

**根本原因**：
Tauri NSIS 安装程序的默认行为会在检测到旧版本时推荐卸载。

**解决方案**：

1. **配置 allowDowngrades**（已在 v0.1.7 实施）

   在 `src-tauri/tauri.conf.json` 中显式设置：
   ```json
   {
     "bundle": {
       "windows": {
         "allowDowngrades": true,
         "nsis": {
           "installMode": "currentUser",
           "languages": ["SimpChinese", "English"]
         }
       }
     }
   }
   ```

   效果：安装提示中应该提供"不卸载，继续"选项。

2. **使用自动更新（推荐）**

   最佳体验是不要手动安装，使用内置的自动更新功能：
   - 应用启动时自动检测更新
   - 后台下载更新包
   - 提示用户"重启以更新"
   - 自动安装，无需手动操作

   详见 [自动更新系统](../tech_docs/auto_update.md)

3. **验证测试步骤**

   ```powershell
   # 1. 确保已安装旧版本
   # 2. 双击新版本安装包
   # 3. 查看安装提示是否有"不卸载，继续"或"继续安装"按钮
   # 4. 选择继续安装（不卸载）
   # 5. 验证安装后版本号和用户数据是否保留
   ```

**注意事项**：
- 覆盖安装后，用户数据（Projects、Providers）应该保留在 `%APPDATA%\MyAgents`
- 如遇到 WebView 缓存问题，可清理 `%LOCALAPPDATA%\MyAgents\EBWebView`

### 发布问题

**rclone 上传失败**

```
ERROR : Failed to copy: AccessDenied
```

解决：检查 `.env` 中的 R2 凭证是否正确。

---

## 相关文档

- [macOS 构建与发布指南](./build_and_release_guide.md) - macOS 版本构建流程
- [自动更新系统](../tech_docs/auto_update.md) - 更新机制详解
- [Node.js Sidecar 打包](../tech_docs/bundled_node.md) - 运行时打包机制

## Cuse 内置桌面操作 Skill

`build_windows.ps1` 与 `build_dev_win.ps1` 在打包前调用 `prepare-cuse-bundle.mjs x86_64-pc-windows-msvc`，获取最新完整 Skill+CLI 到 `bundled-skills/cuse/`；不恢复旧 MCP sidecar。下载/校验失败终止构建，客户端更新覆盖内容并保留用户全局关闭状态。详见 [Cuse bundle](../tech_docs/cuse_bundle.md)。

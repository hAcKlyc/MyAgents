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
│   ├── darwin-aarch64.json     # macOS ARM
│   ├── darwin-x86_64.json      # macOS Intel
│   └── windows-x86_64.json     # Windows x64
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
| **Rust** | 编译 Tauri 后端 | https://rustup.rs |
| **Node.js** | 前端构建工具 | https://nodejs.org |
| **Bun** | 包管理和服务端运行时 | https://bun.sh |
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
1. 检查所有依赖是否已安装
2. 下载 Bun 二进制文件到 `src-tauri/binaries/`
3. 安装前端依赖 (`bun install`)
4. 检查 Rust 依赖

---

## 构建流程

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
2. **检查依赖** - 验证 Rust、npm、bun 是否可用
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
4. **生成更新清单** - 创建 `windows-x86_64.json`
5. **上传确认** - 显示文件列表，等待确认
6. **上传构建产物** - 上传到 R2
7. **上传更新清单** - 上传 JSON 文件

**环境变量**：

| 变量 | 用途 |
|------|------|
| `R2_ACCESS_KEY_ID` | Cloudflare R2 Access Key |
| `R2_SECRET_ACCESS_KEY` | Cloudflare R2 Secret Key |
| `R2_ACCOUNT_ID` | Cloudflare Account ID |
| `CF_ZONE_ID` | Cloudflare Zone ID (可选，用于清除 CDN 缓存) |
| `CF_API_TOKEN` | Cloudflare API Token (可选) |

---

## 测试清单

### 一、环境初始化测试

```powershell
.\setup_windows.ps1
```

- [ ] 依赖检查正确识别已安装/未安装的组件
- [ ] Bun 二进制下载成功
- [ ] 前端依赖安装成功
- [ ] Rust 依赖检查通过

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

- [ ] 解压后直接运行 `MyAgents.exe`

### 四、应用功能测试

**启动**：

- [ ] 应用正常启动，无崩溃
- [ ] 窗口标题栏显示正常
- [ ] Sidecar 进程正常启动

**验证 Sidecar**：
```powershell
Get-Process | Where-Object { $_.ProcessName -eq "bun" }
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
Get-Process | Where-Object { $_.ProcessName -eq "bun" }
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
curl -s https://download.myagents.io/update/windows-x86_64.json
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

**Bun 找不到**

```
bun : 无法将"bun"项识别为 cmdlet...
```

解决：
1. 确认 Bun 已安装：https://bun.sh
2. 重新打开 PowerShell 以刷新 PATH

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
2. Bun 可执行文件缺失 - 检查安装目录是否包含 `bun-x86_64-pc-windows-msvc.exe`

**Sidecar 启动失败**

检查日志文件，或在 PowerShell 中查看进程：

```powershell
# 检查是否有 bun 进程
Get-Process | Where-Object { $_.ProcessName -like "*bun*" }

# 检查端口占用
netstat -ano | findstr "31415"
```

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
- [Bun Sidecar 打包](../tech_docs/bundled_bun.md) - 运行时打包机制

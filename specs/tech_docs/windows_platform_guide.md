# Windows 平台适配指南

**最后更新**: 2026-01-31
**适用版本**: v0.1.7+

---

## 📋 概述

本文档总结了 MyAgents Windows 平台适配的关键技术点和最佳实践，包含路径处理、进程管理、环境变量、CSP 配置等方面的经验。

---

## 🗂️ 路径处理

### 跨平台路径工具

**核心原则**：
- 使用 Tauri `path` 插件获取系统目录
- 使用 Node.js `path.join()` 拼接路径（自动处理分隔符）
- 避免硬编码路径分隔符（`/` 或 `\`）

**示例**：
```typescript
import { join } from 'path';
import { homeDir, tempDir } from '@tauri-apps/api/path';

// ✅ 正确
const configPath = join(await homeDir(), '.myagents', 'config.json');
const tempPath = join(await tempDir(), 'myagents-cache');

// ❌ 错误
const configPath = `${homeDir}/.myagents/config.json`;  // Linux 路径
const tempPath = `${homeDir}\\.myagents\\config.json`;  // Windows 路径
```

### 环境变量

**跨平台环境变量**：
```typescript
// src/server/utils/platform.ts
export function getPlatformPaths() {
  const isWin = process.platform === 'win32';

  return {
    home: isWin
      ? (process.env.USERPROFILE || 'C:\\Users\\Default')
      : (process.env.HOME || '/home/user'),
    temp: isWin
      ? (process.env.TEMP || process.env.TMP || 'C:\\Windows\\Temp')
      : (process.env.TMPDIR || '/tmp'),
  };
}
```

**常用环境变量对照**：

| 用途 | Windows | macOS/Linux |
|------|---------|-------------|
| 用户主目录 | `USERPROFILE` | `HOME` |
| 临时目录 | `TEMP` / `TMP` | `TMPDIR` |
| 应用数据 | `APPDATA` | `~/.config` |
| 路径分隔符 | `;` | `:` |

---

## 🔧 进程管理

### Bun 运行时路径

**Windows 查找顺序**（`src/server/utils/runtime.ts`）：
1. 环境变量 `BUN_EXECUTABLE`
2. Tauri resources 目录 `/binaries/bun.exe`
3. 用户安装路径 `%USERPROFILE%\.bun\bin\bun.exe`
4. 系统 PATH（`bun.exe` 或 `bun`）

**macOS 查找顺序**：
1. 环境变量 `BUN_EXECUTABLE`
2. Tauri resources 目录 `/binaries/bun`
3. 用户安装路径 `~/.bun/bin/bun`
4. 系统 PATH

### 进程清理

**Windows**（使用 `wmic` + `taskkill`）：
```rust
// src-tauri/src/sidecar.rs
#[cfg(target_os = "windows")]
fn kill_by_port(port: u16) {
    // wmic process where (commandline like '%--port 31415%') get processid
    let output = Command::new("wmic")
        .args(&["process", "where", &format!("(commandline like '%--port {}%')", port)])
        .output();

    // taskkill /F /PID 12345
    Command::new("taskkill")
        .args(&["/F", "/PID", &pid])
        .spawn();
}
```

**macOS/Linux**（使用 `lsof` + `kill`）：
```rust
#[cfg(not(target_os = "windows"))]
fn kill_by_port(port: u16) {
    // lsof -ti:31415
    let output = Command::new("lsof")
        .args(&[&format!("-ti:{}", port)])
        .output();

    // kill -9 12345
    Command::new("kill")
        .args(&["-9", &pid])
        .spawn();
}
```

---

## 🌐 CSP 配置

### Windows Tauri IPC 特殊要求

**关键点**：
- Windows Tauri v2 使用 `http://ipc.localhost` 协议
- IPC 调用使用 **Fetch API**（不是 XHR/WebSocket）
- 必须在 CSP 中同时配置 `default-src`、`connect-src` 和 `fetch-src`

**正确配置**：
```json
{
  "app": {
    "security": {
      "csp": "default-src 'self' ipc: tauri: asset: http://ipc.localhost; fetch-src 'self' ipc: tauri: asset: http://ipc.localhost https://download.myagents.io; ..."
    }
  }
}
```

**常见错误**：
```
❌ 缺少 fetch-src 指令
❌ fetch-src 中缺少 http://ipc.localhost
❌ 只配置了 connect-src（用于 XHR/WebSocket）
```

**详见**：[build_troubleshooting.md#CSP配置错误](./build_troubleshooting.md#csp-配置错误)

---

## 🔌 代理配置

### localhost 排除

**问题**：
- reqwest 默认使用系统代理
- Windows 系统代理（如 Clash）未正确处理 localhost 排除
- 导致 localhost 请求失败

**解决方案**：

所有 localhost 请求强制禁用代理：
```rust
let client = reqwest::Client::builder()
    .no_proxy()  // 禁用所有代理（包括系统代理）
    .build()?;
```

外部请求使用应用内代理配置：
```rust
use crate::proxy_config;

let builder = reqwest::Client::builder()
    .timeout(Duration::from_secs(30));

let client = proxy_config::build_client_with_proxy(builder)?;
```

**详见**：[proxy_config.md](./proxy_config.md)

---

## 📦 构建脚本

### 关键清理步骤

**必须清理的目录**：
1. `dist/` - 前端构建产物
2. `src-tauri/target/{arch}/{profile}/bundle/` - Tauri 安装包
3. `src-tauri/target/{arch}/{profile}/resources/` - **缓存的配置文件**（最容易被忽略）

**resources 目录的重要性**：
- Tauri 在此目录缓存 `tauri.conf.json` 等配置文件
- 如果不清理，配置更新后构建仍使用旧缓存
- 导致 CSP 等配置修改不生效

**正确的清理脚本**（`build_windows.ps1`）：
```powershell
# 杀死残留进程
Get-Process | Where-Object { $_.ProcessName -eq "bun" } | Stop-Process -Force
Get-Process | Where-Object { $_.ProcessName -eq "MyAgents" } | Stop-Process -Force

# 清理构建产物
Remove-Item dist -Recurse -Force
Remove-Item src-tauri\target\x86_64-pc-windows-msvc\release\bundle -Recurse -Force

# CRITICAL: 清理 resources 缓存
Remove-Item src-tauri\target\x86_64-pc-windows-msvc\release\resources -Recurse -Force
```

**详见**：[build_troubleshooting.md](./build_troubleshooting.md)

---

## 🧪 测试工具

### 诊断脚本

**diagnose_windows.ps1**：
```powershell
# 基础诊断
.\diagnose_windows.ps1

# 详细模式（含日志）
.\diagnose_windows.ps1 -Verbose
```

**检查内容**：
- Bun 进程状态和 PID
- 端口监听状态（31415-31418）
- 配置目录（`%USERPROFILE%\.myagents`）
- 日志文件（最新 20 行）
- 临时目录和缓存
- localhost 连接测试

### 连接测试脚本

**test_connection.ps1**：
```powershell
.\test_connection.ps1
```

**测试内容**：
- GET /sessions - 检查 Sidecar API 可用性
- POST /api/unified-log - 测试 API 写入
- curl 测试（如果可用）

---

## 🚀 发布流程

### Windows 发布检查清单

**构建前**：
- [ ] 版本号同步（`package.json`, `tauri.conf.json`, `Cargo.toml`）
- [ ] TypeScript 类型检查通过
- [ ] `.env` 文件包含 `TAURI_SIGNING_PRIVATE_KEY`
- [ ] Rust 工具链已安装目标 `x86_64-pc-windows-msvc`

**构建**：
```powershell
.\build_windows.ps1
```

**产物验证**：
- [ ] NSIS 安装包（~150MB）
- [ ] 便携版 ZIP（~150MB）
- [ ] Updater 签名文件（`.sig`）

**发布**：
```powershell
.\publish_windows.ps1
```

**发布验证**：
- [ ] R2 上传成功（NSIS, ZIP, SIG）
- [ ] `latest_win.json` 生成正确
- [ ] 版本号、下载链接、签名正确

**详见**：[windows_build_guide.md](../guides/windows_build_guide.md)

---

## 📚 相关文档

- [Windows 构建指南](../guides/windows_build_guide.md)
- [构建问题排查](./build_troubleshooting.md)
- [代理配置](./proxy_config.md)
- [自动更新](./auto_update.md)

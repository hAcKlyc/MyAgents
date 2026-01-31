# Windows 版本问题排查指南

**最后更新**: 2026-01-31
**适用版本**: v0.1.7
**问题状态**: 🔴 Critical - 需要验证

---

## 📋 问题概述

Windows 生产包出现循环错误，导致应用无法正常工作：

### 症状
1. **CSP 错误**：`Fetch API cannot load http://ipc.localhost`
2. **IPC 协议失败**：`IPC custom protocol failed, Tauri will now use the postMessage interface`
3. **Sidecar 连接失败**：`[proxyFetch] Error: error sending request for url (http://127.0.0.1:31415/...)`

### 影响
- ✅ Global Sidecar 显示启动成功
- ❌ 实际无法连接，功能完全不可用
- ❌ 前端无法调用任何 API

---

## 🔍 根本原因分析

### 原因 1: CSP 配置错误 ✅ 已修复

**问题**：CSP 缺少 `fetch-src` 指令

- Windows Tauri v2 使用 **Fetch API** 进行 IPC 通信（`http://ipc.localhost`）
- 现有 CSP 只有 `connect-src`（用于 WebSocket/XHR）
- Fetch API 无对应指令，回退到 `default-src`，仍被阻止

**修复**（commit af22dc6）：
```diff
"csp": "
  default-src 'self' ipc: tauri: asset: http://ipc.localhost;
  connect-src 'self' ipc: tauri: ... https://download.myagents.io;
+ fetch-src 'self' ipc: tauri: asset: http://ipc.localhost https://download.myagents.io;
  ...
"
```

**影响**：
- ✅ 允许 Tauri IPC 通信
- ✅ 允许从 CDN 下载资源（二维码等）
- ✅ 前端可以正常调用 `invoke()` 等 API

### 原因 2: Sidecar 连接失败 ⚠️ 需要验证

**可能原因**：

#### A. Bun 进程未真正启动
- **症状**：日志显示"started"但任务管理器中无 `bun.exe`
- **原因**：启动后立即崩溃
- **排查**：使用 `diagnose_windows.ps1` 检查进程

#### B. 端口绑定失败
- **症状**：进程存在但端口未监听
- **原因**：端口被占用或权限不足
- **排查**：`Get-NetTCPConnection -LocalPort 31415`

#### C. Rust Proxy 层问题
- **症状**："error sending request"
- **原因**：HTTP 客户端配置错误或网络栈问题
- **排查**：检查 Tauri 日志

### 原因 3: 路径处理问题 ✅ 已简化

**历史问题**：
- 我之前添加的路径安全检查（`relative()` + `isAbsolute()`）可能在 Windows 上失败
- 用户已在 commit d76ebac 中移除复杂检查，使用简单的 `tmpdir() + join()`

**当前状态**：
```typescript
// 简化版本（d76ebac）
const CACHE_DIR = join(tmpdir(), 'myagents-cache');
```

---

## 🛠️ 立即行动

### 步骤 1: 重新构建（必须）

CSP 修复需要重新构建应用：

```powershell
# Windows
.\build_windows.ps1

# 或 Dev 构建
.\build_dev_win.ps1
```

### 步骤 2: 运行诊断工具

```powershell
# 基础诊断
.\diagnose_windows.ps1

# 详细诊断（含日志）
.\diagnose_windows.ps1 -Verbose
```

### 步骤 3: 检查关键指标

| 检查项 | 预期 | 异常处理 |
|--------|------|----------|
| Bun 进程 | ✅ 存在 | 检查启动日志，查找崩溃原因 |
| 端口 31415 | ✅ LISTEN | 检查端口占用：`netstat -ano \| findstr 31415` |
| 配置目录 | ✅ 存在 | 应用首次运行自动创建 |
| 日志文件 | ✅ 存在 | 查看最新日志，查找错误 |
| localhost 连接 | ✅ 200 OK | 连接拒绝 = Sidecar 未启动 |

### 步骤 4: 查看日志

```powershell
# Tauri 日志
$logDir = Join-Path $env:USERPROFILE ".myagents\logs"
Get-ChildItem $logDir | Sort-Object LastWriteTime -Descending | Select-Object -First 1 | Get-Content -Tail 50

# 统一日志
$unifiedLog = Join-Path $env:USERPROFILE ".myagents\unified-logs\*.log"
Get-Content $unifiedLog -Tail 50
```

---

## 🧪 手动测试 Sidecar 启动

如果诊断工具显示 Bun 进程未启动，手动测试：

```powershell
# 1. 找到 Bun 可执行文件
$bunPath = "C:\Program Files\MyAgents\bun-x86_64-pc-windows-msvc.exe"

# 2. 找到 server 脚本
$serverScript = "C:\Program Files\MyAgents\resources\server-dist.js"

# 3. 手动启动
& $bunPath $serverScript --port 31415 --agent-dir "$env:TEMP\myagents-test"

# 4. 测试连接（另一个终端）
Invoke-WebRequest -Uri "http://127.0.0.1:31415/health"
```

### 预期输出
```
✅ StatusCode: 200
✅ 或 404（端点不存在，但连接成功）
```

### 异常输出
```
❌ 连接被拒绝 → Bun 进程崩溃或未监听
❌ 超时 → 防火墙阻止（但之前版本正常，不太可能）
```

---

## 🐛 常见错误场景

### 场景 1: Bun 找不到依赖

**症状**：
```
Error: Cannot find module '@anthropic-ai/claude-agent-sdk'
```

**原因**：`claude-agent-sdk` 未正确打包

**解决**：
```powershell
# 检查资源目录
Test-Path "C:\Program Files\MyAgents\resources\claude-agent-sdk\cli.js"

# 重新构建
.\build_windows.ps1
```

### 场景 2: 权限错误

**症状**：
```
Error: EACCES: permission denied, mkdir 'C:\...\myagents-cache'
```

**原因**：临时目录无写权限

**解决**：
1. 检查 `$env:TEMP` 权限
2. 以管理员身份运行应用
3. 修改环境变量 `TEMP` 指向有权限的目录

### 场景 3: 端口占用

**症状**：
```
Error: EADDRINUSE: address already in use 127.0.0.1:31415
```

**原因**：端口被其他应用占用

**解决**：
```powershell
# 查找占用进程
netstat -ano | findstr 31415

# 结束进程（替换 PID）
taskkill /F /PID <PID>
```

---

## 📊 诊断检查清单

- [ ] **CSP 修复已应用**：重新构建后的版本
- [ ] **Bun 进程运行**：任务管理器中可见
- [ ] **端口监听**：31415 处于 LISTEN 状态
- [ ] **localhost 连接成功**：`Invoke-WebRequest` 返回 200/404
- [ ] **日志无错误**：最新日志文件无 CRASH/ERROR
- [ ] **资源文件存在**：`resources/server-dist.js` 和 `claude-agent-sdk/`
- [ ] **配置目录可写**：`~/.myagents/` 有写权限
- [ ] **临时目录可写**：`%TEMP%/myagents-cache/` 可创建

---

## 🔄 回滚方案

如果 v0.1.7 无法修复，回滚到 v0.1.6：

```powershell
# 1. 卸载 v0.1.7
# 控制面板 → 程序和功能 → MyAgents → 卸载

# 2. 下载 v0.1.6
# https://download.myagents.io/releases/v0.1.6/MyAgents_x64_en-US.msi

# 3. 安装 v0.1.6
```

**注意**：v0.1.6 只有网络错误，但核心功能可用

---

## 📝 反馈信息模板

如果问题仍存在，请提供以下信息：

```
### 环境信息
- Windows 版本：[Win 10/11]
- MyAgents 版本：[从「关于」页面复制]
- 安装路径：[默认/自定义路径]

### 诊断结果
[粘贴 diagnose_windows.ps1 的完整输出]

### 日志文件
[粘贴最新日志文件的最后 50 行]

### 手动测试结果
[粘贴手动启动 Bun 的输出]

### 补充说明
[其他观察到的异常现象]
```

---

## ✅ 预期修复结果

修复成功后应该看到：

1. **控制台无 CSP 错误**
2. **Global Sidecar 启动成功**：`http://127.0.0.1:31415`
3. **Tab Sidecar 启动成功**：`http://127.0.0.1:31416+`
4. **Settings 页面加载正常**
5. **Chat 页面可以发送消息**
6. **About 页面二维码显示正常**

---

**修复提交**:
- af22dc6: fix: 修复 Windows Tauri IPC CSP 错误 + 添加诊断工具
- 1cf784b: fix: 修复跨平台路径兼容性问题
- d76ebac: fix: 移除路径安全检查以恢复 Windows 功能

**下一步**: 在 Windows 环境重新构建并测试，确认所有问题已解决

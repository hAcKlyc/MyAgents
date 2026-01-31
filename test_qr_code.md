# QR Code 缓存功能测试清单

## 测试环境

- **Windows 打包版本**：主要测试目标
- **macOS 打包版本**：验证跨平台兼容性
- **浏览器开发模式**：快速验证前端逻辑

---

## 测试场景

### 1. 基础功能测试

#### 1.1 首次加载
**步骤**：
1. 清理缓存目录（`%TEMP%\myagents-cache` 或 `/tmp/myagents-cache`）
2. 启动应用
3. 打开 Settings → About

**预期结果**：
- ✅ 显示 Loading 动画（转圈）
- ✅ 1-2 秒后显示二维码
- ✅ 后端日志显示：
  ```
  [api/assets/qr-code] Cache miss, downloading
  [api/assets/qr-code] Downloaded and cached (446KB in XXXms)
  [api/assets/qr-code] Request completed in XXXms
  ```

#### 1.2 缓存命中
**步骤**：
1. 重启应用（或切换到其他页面再回来）
2. 打开 Settings → About

**预期结果**：
- ✅ Loading 闪现即消失（<100ms）
- ✅ 立即显示二维码
- ✅ 后端日志显示：
  ```
  [api/assets/qr-code] Cache hit (age: 1min)
  [api/assets/qr-code] Request completed in 5ms
  ```

---

### 2. 并发安全性测试

#### 2.1 多标签并发请求
**步骤**：
1. 清理缓存
2. 打开多个 Settings 窗口/标签（如果支持）
3. 同时切换到 About 页面

**预期结果**：
- ✅ 所有标签正常显示二维码
- ✅ 后端日志只有一次下载：
  ```
  [api/assets/qr-code] Cache miss, downloading
  [api/assets/qr-code] Download in progress, waiting...
  [api/assets/qr-code] Downloaded and cached (446KB in XXXms)
  ```
- ✅ 缓存文件完整且正确

---

### 3. 网络异常处理

#### 3.1 首次加载时网络断开
**步骤**：
1. 清理缓存
2. 断开网络
3. 启动应用并打开 Settings → About

**预期结果**：
- ✅ Loading 状态持续 10 秒（超时）
- ✅ 然后隐藏二维码区域（不显示错误界面）
- ✅ 后端日志显示：
  ```
  [api/assets/qr-code] Cache miss, downloading
  [api/assets/qr-code] Error: ...
  ```

#### 3.2 缓存过期时网络断开
**步骤**：
1. 正常加载二维码（建立缓存）
2. 修改系统时间，推进 2 小时
3. 断开网络
4. 重启应用并打开 Settings → About

**预期结果**：
- ✅ 显示过期缓存的二维码（降级处理）
- ✅ 后端日志显示：
  ```
  [api/assets/qr-code] Cache expired (age: 120min), re-downloading
  [api/assets/qr-code] Download failed (HTTP XXX), using stale cache
  ```

---

### 4. 缓存刷新测试

#### 4.1 缓存自动过期
**步骤**：
1. 正常加载二维码
2. 修改系统时间，推进 2 小时
3. 重启应用并打开 Settings → About

**预期结果**：
- ✅ 先显示 Loading
- ✅ 然后重新下载并显示新二维码
- ✅ 后端日志显示：
  ```
  [api/assets/qr-code] Cache expired (age: 120min), re-downloading
  [api/assets/qr-code] Downloaded and cached (446KB in XXXms)
  ```

---

### 5. 路径安全性测试

#### 5.1 验证缓存路径
**Windows**:
```powershell
ls $env:TEMP\myagents-cache
```

**macOS/Linux**:
```bash
ls -la /tmp/myagents-cache
# 或者
ls -la /var/folders/.../T/myagents-cache
```

**预期结果**：
- ✅ 目录存在
- ✅ 包含 `feedback_qr_code.png` 文件
- ✅ 文件大小约 400-500 KB
- ✅ 文件修改时间正确

#### 5.2 权限验证
**步骤**：
```bash
# macOS/Linux
ls -la /tmp/myagents-cache/feedback_qr_code.png

# Windows
icacls "%TEMP%\myagents-cache\feedback_qr_code.png"
```

**预期结果**：
- ✅ 当前用户有读写权限
- ✅ 其他用户无权限（如果是单用户目录）

---

### 6. 前端 UI 测试

#### 6.1 Loading 状态
**步骤**：
1. 清理缓存
2. 限制网络速度（Windows: 任务管理器 → 性能；macOS: Network Link Conditioner）
3. 打开 Settings → About

**预期结果**：
- ✅ 显示灰色转圈动画
- ✅ 动画居中显示
- ✅ 尺寸与二维码一致（36x36）

#### 6.2 页面切换
**步骤**：
1. 在 Settings 不同页面间快速切换
2. 多次进入/离开 About 页面

**预期结果**：
- ✅ 离开 About 时 Loading 消失
- ✅ 重新进入时快速加载
- ✅ 无内存泄漏（多次切换后内存稳定）

---

### 7. 性能监控验证

#### 7.1 日志格式检查
**打开应用控制台（DevTools），查看日志**：

**首次下载**：
```
[api/assets/qr-code] Cache miss, downloading
[api/assets/qr-code] Downloaded and cached (446KB in 523ms)
[api/assets/qr-code] Request completed in 530ms
```

**缓存命中**：
```
[api/assets/qr-code] Cache hit (age: 15min)
[api/assets/qr-code] Request completed in 6ms
```

**缓存过期**：
```
[api/assets/qr-code] Cache expired (age: 63min), re-downloading
[api/assets/qr-code] Downloaded and cached (446KB in 498ms)
[api/assets/qr-code] Request completed in 505ms
```

**预期结果**：
- ✅ 日志包含缓存年龄（分钟）
- ✅ 日志包含文件大小（KB）
- ✅ 日志包含下载时间（毫秒）
- ✅ 日志包含总耗时（毫秒）

---

## 回归测试

### Windows 特定测试

1. **CSP 违规检查**
   - ✅ 控制台无 CSP 错误
   - ✅ 无 `ipc.localhost` 相关错误

2. **路径分隔符**
   - ✅ 缓存路径使用 `\` 分隔符
   - ✅ 路径规范化正确

3. **WebView2 兼容性**
   - ✅ base64 图片正常显示
   - ✅ 无内存占用异常

### macOS 特定测试

1. **符号链接处理**
   - ✅ `/var` → `/private/var` 正确处理
   - ✅ tmpdir 路径正确解析

2. **权限处理**
   - ✅ 缓存目录创建成功
   - ✅ 文件写入无权限错误

---

## 性能基准

| 场景 | 目标耗时 | 可接受范围 |
|------|----------|------------|
| 首次下载 | 500ms | 300-1000ms |
| 缓存命中 | 5ms | 3-10ms |
| 并发请求 | 500ms | 同首次下载 |
| 超时限制 | 10s | 固定 |

---

## 问题排查

### 如果二维码不显示

1. **检查缓存目录**：
   ```bash
   # 是否存在？
   ls /tmp/myagents-cache
   # 或
   ls %TEMP%\myagents-cache
   ```

2. **检查后端日志**：
   - 是否有下载日志？
   - 是否有错误日志？

3. **检查网络**：
   ```bash
   curl https://download.myagents.io/assets/feedback_qr_code.png -o test.png
   ```

4. **手动清理缓存重试**：
   ```bash
   rm -rf /tmp/myagents-cache
   # 或
   rmdir /s /q %TEMP%\myagents-cache
   ```

### 如果显示错误

1. **检查 CSP 配置**：
   - 控制台是否有 CSP 错误？
   - `img-src` 是否包含 `data:`？

2. **检查文件完整性**：
   ```bash
   file /tmp/myagents-cache/feedback_qr_code.png
   # 应该显示：PNG image data
   ```

3. **检查文件锁**：
   ```bash
   ls -la /tmp/myagents-cache/*.lock
   # 应该为空或不存在
   ```

---

## 测试报告模板

```markdown
## QR Code 功能测试报告

**测试时间**: 2026-01-31
**测试版本**: v0.1.7
**测试平台**: Windows 11 / macOS 14.x

### 测试结果

| 场景 | 状态 | 备注 |
|------|------|------|
| 首次加载 | ✅ / ❌ | |
| 缓存命中 | ✅ / ❌ | |
| 并发安全 | ✅ / ❌ | |
| 网络异常 | ✅ / ❌ | |
| 缓存刷新 | ✅ / ❌ | |
| 路径安全 | ✅ / ❌ | |
| UI 状态 | ✅ / ❌ | |
| 性能监控 | ✅ / ❌ | |

### 性能数据

- 首次下载: XXX ms
- 缓存命中: XXX ms
- 文件大小: XXX KB

### 发现的问题

1. [如有问题，在此描述]
2. ...

### 总体评价

[通过 / 需修复]
```

---

## 自动化测试脚本（可选）

```bash
#!/bin/bash
# test_qr_cache.sh

echo "=== QR Code 缓存功能自动化测试 ==="

# 清理缓存
rm -rf /tmp/myagents-cache
echo "✓ 缓存已清理"

# 测试 1: 缓存目录不存在时下载
echo "测试 1: 首次下载..."
# TODO: 调用 API 并验证

# 测试 2: 缓存命中
echo "测试 2: 缓存命中..."
# TODO: 再次调用 API

# 测试 3: 缓存过期
echo "测试 3: 缓存过期..."
# TODO: 修改文件时间戳并验证

echo "=== 测试完成 ==="
```

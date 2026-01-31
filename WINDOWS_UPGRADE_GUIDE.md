# Windows 升级体验优化指南

**问题**: 从 0.1.6 升级到 0.1.7 时，安装程序提示必须先卸载旧版本

**更新日期**: 2026-01-31

---

## 📋 问题分析

### 当前行为

1. 双击 `MyAgents_0.1.7_x64-setup.exe`
2. 安装程序检测到已安装 0.1.6
3. 提示：**"建议卸载现有版本"**
4. 用户必须手动卸载 → 重新安装

### 期望行为

1. 双击安装包
2. 检测到旧版本
3. 自动覆盖安装，无需手动卸载

### 根本原因

Tauri NSIS 安装程序的默认行为：
- 检测到旧版本时**会推荐卸载**
- 但应该提供**"不卸载，直接安装"**选项
- 可能的问题：
  - 中文语言文件翻译不清晰
  - 选项按钮不明显
  - `allowDowngrades` 配置未显式设置

---

## ✅ 解决方案

### 方案 1：配置 allowDowngrades（已实施）

**修改**: `src-tauri/tauri.conf.json`

```json
{
  "bundle": {
    "windows": {
      "allowDowngrades": true,  // ← 显式设置
      "nsis": {
        "installMode": "currentUser",
        "languages": ["SimpChinese", "English"]
      }
    }
  }
}
```

**效果**:
- 明确允许版本覆盖（包括降级）
- 应该在安装提示中提供"不卸载"选项

**测试**:
```powershell
# 重新构建
.\build_windows.ps1

# 安装测试
1. 确保已安装 0.1.6
2. 双击新构建的 0.1.7 安装包
3. 查看是否有"不卸载"或"继续安装"按钮
```

---

### 方案 2：使用自动更新（推荐）

**最佳体验**: 不要手动安装，使用内置的自动更新功能

**流程**:
1. 用户安装 0.1.6（或任何版本）
2. 发布 0.1.7 到 R2 CDN
3. 应用启动时自动检测更新
4. 后台下载更新包
5. 提示用户"重启以更新"
6. **自动安装，无需手动操作**

**优点**:
- ✅ 完全自动化，用户体验最佳
- ✅ 无需手动卸载
- ✅ 支持增量更新
- ✅ 已有完整实现（updater 插件）

**已实现**: `src-tauri/src/updater.rs` + `src/renderer/hooks/useUpdater.ts`

---

### 方案 3：自定义 NSIS 安装提示

如果方案 1 无效，可以自定义 NSIS 安装脚本。

**创建**: `src-tauri/resources/nsis/installer-hooks.nsh`

```nsis
!macro preInstall
  ; 检测旧版本
  ReadRegStr $0 HKCU "Software\MyAgents" "Version"

  ${If} $0 != ""
    ; 友好的中文提示
    MessageBox MB_OK|MB_ICONINFORMATION \
      "检测到 MyAgents $0$\n$\n即将升级到 ${VERSION}，无需卸载旧版本。"
  ${EndIf}
!macroend
```

**配置**: `tauri.conf.json`

```json
{
  "bundle": {
    "windows": {
      "nsis": {
        "template": "./resources/nsis/installer.nsi"  // 可选
      }
    }
  }
}
```

**注意**: 需要 Tauri v2.6+ 支持 installer hooks

---

### 方案 4：改用 perMachine 安装模式

**问题**: `currentUser` 模式可能导致权限问题

**修改**: `tauri.conf.json`

```json
{
  "bundle": {
    "windows": {
      "nsis": {
        "installMode": "perMachine"  // 改为系统级安装
      }
    }
  }
}
```

**权衡**:
- ✅ 升级体验可能更好
- ❌ 需要管理员权限
- ❌ 所有用户共享安装

---

## 🧪 测试步骤

### 测试 1: 验证"不卸载"选项

1. **准备**:
   ```powershell
   # 确保已安装 0.1.6
   # 构建 0.1.7
   .\build_windows.ps1
   ```

2. **安装**:
   - 双击 `MyAgents_0.1.7_x64-setup.exe`
   - **仔细查看**安装提示窗口

3. **预期结果**:
   ```
   ╔════════════════════════════════════╗
   ║  MyAgents 0.1.6 已安装              ║
   ╠════════════════════════════════════╣
   ║  建议卸载现有版本后再安装新版本。    ║
   ║                                    ║
   ║  [卸载并安装]  [不卸载，继续]  [取消] ║ ← 关键！
   ╚════════════════════════════════════╝
   ```

4. **操作**:
   - 点击 **"不卸载，继续"** 按钮
   - 观察是否能够正常覆盖安装

### 测试 2: 验证覆盖安装

1. **安装 0.1.7**（使用"不卸载"选项）
2. **启动应用**
3. **检查**:
   - 设置 → 关于 → 版本号是否为 0.1.7
   - 用户数据（Projects、Providers）是否保留
   - 应用功能是否正常

### 测试 3: 自动更新流程

1. **模拟**:
   ```powershell
   # 安装 0.1.6
   # 发布 0.1.7 到 R2
   .\publish_windows.ps1
   ```

2. **启动 0.1.6 版本**
3. **观察**:
   - 是否自动检测到更新
   - 是否显示"重启以更新"按钮
   - 点击后是否自动安装 0.1.7

---

## 📊 故障排查

### 问题：仍然强制卸载

**可能原因**:
1. 中文语言文件翻译问题
2. 安装模式冲突（currentUser vs perMachine）
3. Tauri 版本不支持覆盖安装

**解决**:
```powershell
# 方案 A: 尝试英文界面
# 修改 tauri.conf.json
"languages": ["English"]

# 方案 B: 使用自动更新（推荐）
# 见"方案 2"

# 方案 C: 联系 Tauri 社区
# 提交 issue: https://github.com/tauri-apps/tauri/issues
```

### 问题：覆盖安装后数据丢失

**原因**: WebView 缓存未清理

**解决**:
- 参考 `diagnose_csp_issue.ps1`
- 清理 `%LOCALAPPDATA%\MyAgents\EBWebView`

---

## 🎯 推荐策略

### 短期（当前版本）

1. ✅ **已实施**: `allowDowngrades: true`
2. 📝 **测试**: 验证"不卸载"选项是否可见
3. 📄 **文档**: 告知用户可以选择"不卸载"

### 中期（v0.1.8）

1. 🔧 **自定义提示**: 如果测试发现选项不明显，添加自定义 NSIS hooks
2. 🌐 **优化语言**: 改善中文提示文本

### 长期（v0.2.0+）

1. 🚀 **主推自动更新**: 在应用内明显提示用户使用自动更新
2. 📦 **减少手动安装**: 只在首次安装时需要手动下载
3. ✨ **无感知升级**: 自动更新 + 后台下载 + 一键重启

---

## 📚 参考资料

- [Tauri Windows Installer Documentation](https://v2.tauri.app/distribute/windows-installer/)
- [Tauri NSIS Configuration](https://v2.tauri.app/reference/config/)
- [Tauri Updater Plugin](https://v2.tauri.app/plugin/updater/)
- [GitHub Issue #9668: NSIS Customization](https://github.com/tauri-apps/tauri/issues/9668)

---

**下一步**: 在 Windows 上测试 0.1.7 安装包，验证"不卸载"选项是否可见。

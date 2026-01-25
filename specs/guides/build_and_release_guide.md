# MyAgents 构建与发布指南

本文档描述 MyAgents 的构建流程、发布流程以及分发渠道的完整信息。

---

## 概览

MyAgents 目前支持 **macOS** 平台，包括 Apple Silicon (ARM64) 和 Intel (x86_64) 两种架构。

### 分发渠道

| 渠道 | 用途 | 所需文件 | 清单文件 |
|------|------|---------|---------|
| **官网下载** | 用户从官网手动下载安装 | `.dmg` | `latest.json` |
| **自动更新** | 应用内静默更新 (Tauri Updater) | `.app.tar.gz` + `.sig` | `darwin-aarch64.json` / `darwin-x86_64.json` |

### 存储位置

所有发布文件存储在 **Cloudflare R2**，通过自定义域名 `download.myagents.io` 提供访问。

```
myagents-releases/
├── update/
│   ├── darwin-aarch64.json    # ARM 自动更新清单
│   ├── darwin-x86_64.json     # Intel 自动更新清单
│   └── latest.json            # 官网下载 API
└── releases/
    └── v{VERSION}/
        ├── MyAgents_{VERSION}_aarch64.dmg         # ARM DMG
        ├── MyAgents_{VERSION}_x64.dmg             # Intel DMG
        ├── MyAgents_{VERSION}_aarch64.app.tar.gz  # ARM 更新包
        ├── MyAgents_{VERSION}_aarch64.app.tar.gz.sig  # ARM 签名
        ├── MyAgents_{VERSION}_x64.app.tar.gz      # Intel 更新包
        └── MyAgents_{VERSION}_x64.app.tar.gz.sig  # Intel 签名
```

---

## 构建脚本

### build_macos.sh

**用途**：构建 macOS 签名版应用，包含 Apple 签名和公证。

**运行方式**：
```bash
./build_macos.sh
```

**交互选项**：
```
请选择目标架构:
  1) ARM (Apple Silicon M1/M2) [默认]
  2) Intel (x86_64)
  3) Both (同时构建两个版本)
```

**构建流程**：
1. 加载 `.env` 签名配置
2. 检查依赖 (Rust, Node.js, codesign)
3. 配置生产环境 CSP
4. TypeScript 类型检查
5. 构建前端和服务端代码
6. 签名 Vendor 二进制文件 (ripgrep 等)
7. 构建 Tauri 应用 (Release + 签名 + 公证)
8. 恢复开发配置

**产物检查**：
构建完成后会显示每个架构的文件状态：
- DMG 文件（官网下载用）
- tar.gz 文件（自动更新用）
- .sig 签名文件（自动更新验证用）
- Apple 签名验证结果
- 公证验证结果

**环境变量要求**：

| 变量 | 用途 | 必需 |
|------|------|------|
| `APPLE_SIGNING_IDENTITY` | Apple Developer ID 签名身份 | ✅ |
| `APPLE_TEAM_ID` | Apple 开发者团队 ID | ✅ |
| `APPLE_API_ISSUER` | App Store Connect API Issuer | ✅ |
| `APPLE_API_KEY` | App Store Connect API Key ID | ✅ |
| `APPLE_API_KEY_PATH` | API Key 文件路径 | ✅ |
| `TAURI_SIGNING_PRIVATE_KEY` | Tauri 更新签名私钥 | 自动更新需要 |
| `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` | 私钥密码 | 自动更新需要 |

**注意**：如果未设置 `TAURI_SIGNING_PRIVATE_KEY`，脚本会显示警告并询问是否继续。构建出的应用**无法使用自动更新功能**。

---

## 发布脚本

### publish_release.sh

**用途**：将构建产物上传到 Cloudflare R2，并生成更新清单。

**运行方式**：
```bash
./publish_release.sh
```

**发布流程**（7 步）：

1. **加载配置** - 从 `.env` 读取 R2 凭证
2. **检查 rclone** - 确保 rclone 已安装
3. **物料完整性检查** - 检测所有必要文件是否存在
4. **生成更新清单** - 创建 JSON 清单文件
5. **上传前最终确认** - 显示完整文件列表，等待用户确认
6. **上传构建产物** - 上传 DMG、tar.gz、sig 文件到 R2
7. **上传更新清单** - 上传 JSON 清单文件

**防呆机制**：

脚本包含多层检查，防止上传不完整的发布：

```
物料检查 → 问题分级 → 最终确认 → 上传 → 验证
    ↓           ↓           ↓              ↓
  缺失警告   严重=退出    Y/n确认      HTTP验证
            警告=输入yes
```

**问题分级**：

| 级别 | 触发条件 | 行为 |
|------|---------|------|
| 严重错误 | 没有任何 DMG 文件 | 直接退出，不允许发布 |
| 警告 | 缺少某个架构的文件 / 缺少签名文件 | 必须输入 `yes` 才能继续 |
| 通过 | 所有文件就绪 | 自动继续 |

**物料清单显示**：

```
  ┌─────────────────────────────────────────────────────────┐
  │  物料清单 - v0.1.0                                      │
  ├─────────────────────────────────────────────────────────┤
  │  Apple Silicon (ARM64)                                  │
  │    ✓ DMG:    MyAgents_0.1.0_aarch64.dmg              │
  │    ✓ tar.gz: MyAgents.app.tar.gz                      │
  │    ✓ 签名:   MyAgents.app.tar.gz.sig                  │
  │                                                         │
  │  Intel (x86_64)                                         │
  │    ✓ DMG:    MyAgents_0.1.0_x64.dmg                   │
  │    ✓ tar.gz: MyAgents.app.tar.gz                      │
  │    ✓ 签名:   MyAgents.app.tar.gz.sig                  │
  └─────────────────────────────────────────────────────────┘
```

**上传后验证**：

脚本会自动验证上传的文件是否可访问：
```
  📋 验证上传结果...
    检查 latest.json... ✓
    检查 darwin-aarch64.json... ✓
    检查 darwin-x86_64.json... ✓
    检查 ARM DMG... ✓
    检查 Intel DMG... ✓
```

**环境变量要求**：

| 变量 | 用途 |
|------|------|
| `R2_ACCESS_KEY_ID` | Cloudflare R2 Access Key |
| `R2_SECRET_ACCESS_KEY` | Cloudflare R2 Secret Key |
| `R2_ACCOUNT_ID` | Cloudflare Account ID |

---

## 清单文件格式

### latest.json（官网下载用）

```json
{
  "version": "0.1.0",
  "pub_date": "2026-01-24T10:00:00Z",
  "release_notes": "MyAgents v0.1.0",
  "downloads": {
    "mac_arm64": {
      "name": "Apple Silicon",
      "url": "https://download.myagents.io/releases/v0.1.0/MyAgents_0.1.0_aarch64.dmg"
    },
    "mac_intel": {
      "name": "Intel Mac",
      "url": "https://download.myagents.io/releases/v0.1.0/MyAgents_0.1.0_x64.dmg"
    }
  }
}
```

**官网使用示例**：
```typescript
const res = await fetch('https://download.myagents.io/update/latest.json');
const data = await res.json();

// 根据用户设备选择下载链接
const isMacARM = navigator.userAgent.includes('ARM64');
const downloadUrl = isMacARM
  ? data.downloads.mac_arm64.url
  : data.downloads.mac_intel.url;
```

### darwin-aarch64.json / darwin-x86_64.json（自动更新用）

```json
{
  "version": "0.1.0",
  "notes": "MyAgents v0.1.0",
  "pub_date": "2026-01-24T10:00:00Z",
  "platforms": {
    "darwin-aarch64": {
      "signature": "dW50cnVzdGVkIGNvbW1lbnQ6...",
      "url": "https://download.myagents.io/releases/v0.1.0/MyAgents.app.tar.gz"
    }
  }
}
```

**Tauri 配置** (`tauri.conf.json`)：
```json
{
  "plugins": {
    "updater": {
      "pubkey": "dW50cnVzdGVkIGNvbW1lbnQ6...",
      "endpoints": [
        "https://download.myagents.io/update/{{target}}.json"
      ]
    }
  }
}
```

---

## 完整发布流程

### 1. 更新版本号

同时修改两个文件：
- `package.json`: `"version": "x.x.x"`
- `src-tauri/tauri.conf.json`: `"version": "x.x.x"`

### 2. 构建应用

```bash
# 构建两个架构
./build_macos.sh
# 选择 3) Both
```

### 3. 验证构建产物

确保以下文件都存在：
- `src-tauri/target/aarch64-apple-darwin/release/bundle/dmg/*.dmg`
- `src-tauri/target/aarch64-apple-darwin/release/bundle/macos/*.app.tar.gz`
- `src-tauri/target/aarch64-apple-darwin/release/bundle/macos/*.app.tar.gz.sig`
- `src-tauri/target/x86_64-apple-darwin/release/bundle/dmg/*.dmg`
- `src-tauri/target/x86_64-apple-darwin/release/bundle/macos/*.app.tar.gz`
- `src-tauri/target/x86_64-apple-darwin/release/bundle/macos/*.app.tar.gz.sig`

### 4. 发布到 R2

```bash
./publish_release.sh
```

### 5. 验证发布

```bash
# 检查官网 API
curl -s https://download.myagents.io/update/latest.json | jq .

# 检查自动更新清单
curl -s https://download.myagents.io/update/darwin-aarch64.json | jq .
```

### 6. 提交代码和打 Tag

```bash
git add -A
git commit -m "chore: release v0.1.0"
git tag v0.1.0
git push origin main --tags
```

---

## 环境配置参考

### .env 文件模板

```bash
# === Apple 签名配置 ===
APPLE_SIGNING_IDENTITY="Developer ID Application: Your Name (TEAM_ID)"
APPLE_TEAM_ID="TEAM_ID"
APPLE_API_ISSUER="xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx"
APPLE_API_KEY="XXXXXXXXXX"
APPLE_API_KEY_PATH="/path/to/AuthKey_XXXXXXXXXX.p8"

# === Tauri 更新签名 ===
# 注意: 私钥必须是单行格式，换行符用 \n 表示
# 可以用以下命令转换: cat key.pem | tr '\n' '\\n'
TAURI_SIGNING_PRIVATE_KEY="dW50cnVzdGVkIGNvbW1lbnQ6IG1pbmlzaWduIHNlY3JldCBrZXk..."
TAURI_SIGNING_PRIVATE_KEY_PASSWORD="your-password"

# === Cloudflare R2 ===
R2_ACCESS_KEY_ID="xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx"
R2_SECRET_ACCESS_KEY="xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx"
R2_ACCOUNT_ID="xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx"
```

> **安全提示**: `.env` 文件包含敏感凭证，确保:
> - 已加入 `.gitignore`
> - 文件权限设为 `600` (`chmod 600 .env`)

### 生成 Tauri 签名密钥

```bash
npx tauri signer generate -w ~/.tauri/myagents.key
```

生成后：
1. 私钥内容添加到 `.env` 的 `TAURI_SIGNING_PRIVATE_KEY`
2. 公钥更新到 `tauri.conf.json` 的 `plugins.updater.pubkey`

---

## 故障排查

### 构建问题

**签名文件未生成**
- 原因：未设置 `TAURI_SIGNING_PRIVATE_KEY`
- 解决：在 `.env` 中配置签名私钥

**公证失败**
- 检查 Apple API 凭证是否正确
- 确认网络能访问 Apple 服务器

### 发布问题

**物料检查报错**
- 根据提示信息确认缺失的文件
- 重新运行 `./build_macos.sh` 构建

**上传后验证失败**
- 可能是 CDN 缓存延迟，等待几分钟后重试
- 检查 R2 bucket 公开访问配置

### 自动更新问题

**更新检查失败**
- 检查 CSP 配置是否允许 `download.myagents.io`
- 查看 Rust 日志 `[Updater]` 前缀

**签名验证失败**
- 确认 `tauri.conf.json` 中的 pubkey 与构建时使用的私钥匹配
- 检查 .sig 文件是否正确上传

---

## 相关文档

- [自动更新系统](../tech_docs/auto_update.md) - 静默更新流程、CI/CD 配置
- [macOS 分发指南](./macos_distribution_guide.md) - 代码签名、公证详解
- [Bun Sidecar 打包](../tech_docs/bundled_bun.md) - 运行时打包机制

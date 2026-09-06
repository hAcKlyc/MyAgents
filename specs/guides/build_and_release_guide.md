# MyAgents 构建与发布指南

本文档描述 MyAgents 的构建流程、发布流程以及分发渠道的完整信息。

---

## 概览

MyAgents 支持 **macOS** 和 **Windows** 平台：

| 平台 | 架构 | 构建脚本 | 发布脚本 |
|------|------|---------|---------|
| macOS | ARM64 (M1/M2), x86_64 (Intel) | `build_macos.sh` | `publish_release.sh` |
| Windows | x86_64 | `build_windows.ps1` | `publish_windows.ps1` |

> **Windows 用户**：请参阅 [Windows 构建与测试指南](./windows_build_guide.md)

本文档主要描述 **macOS** 版本的构建流程。macOS 支持 Apple Silicon (ARM64) 和 Intel (x86_64) 两种架构。

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
2. 检查依赖（Rust 通过 `rustup` 使用仓库 `rust-toolchain.toml` 固定版本、Node.js、codesign；任一 macOS 架构的原生推理资源冷构建额外检查 Git、Python ≥ 3.10、CMake ≥ 3.28 与 Apple Clang）
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

MyAgents 支持 macOS 13，而官方 ONNX Runtime 1.28 arm64 archive 的最低系统版本是 macOS 14，且没有 x64 archive。因此 Apple Silicon 与 Intel 都从锁定源码按 deployment target 13.0 构建共享 ONNX Runtime。`build_macos.sh` 会在正式构建前对每个所选 target 调用 `scripts/prepare-native-inference.mjs`；顶层入口只解析一次 target，并以 exact target prepared cache（而非当前 `resources/*/v1` 投影）完成 document/speech 预检和准备。因此在 Apple Silicon 上选择 Both 时，先前的 arm64 投影不会参与 x86_64 的 cache 或 ORT identity 决策。已有当前 fingerprint 的完整 prepared cache 时不会强制要求源码构建工具。脚本不会自动执行 Homebrew 或修改系统环境，缺项时会给出对应的安装与验证命令。

native inference 的受支持 target 由 `src-tauri/document-worker/resource-lock.json::targets` 唯一锁定：`aarch64-apple-darwin`、`x86_64-apple-darwin`、`x86_64-pc-windows-msvc`、`x86_64-unknown-linux-gnu`、`aarch64-unknown-linux-gnu`。每个正式产物都必须由同一 `prepare-native-inference` 入口生成 document/speech 两份 target manifest；speech bundle 只携带 media Worker、sherpa adapter/native 依赖与 legal inventory，ONNX Runtime 必须引用同 target document artifact，不能复制第二份。真实发布验收需在对应 target 机器/runner 上检查签名、notices、Worker 最小加载和至少一份媒体 smoke；不能用 host-only 单测替代五 target 产物证据。

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

### publish_managed_codex_runtime.sh

**用途**：单独打包并上传 MyAgents 托管的 Codex Runtime 到 R2。它是开发 / 发版准备阶段的资源发布入口，不属于桌面 App 的 `publish_release.sh` / `publish_windows.ps1` 流程。

桌面 App 客户端会锁定一个固定的 runtime set manifest 地址，例如 `runtimes/codex/sets/<runtime-set>/...`。多个 App 版本可以复用同一个 runtime set；只有决定升级内置 Codex runtime 时，才修改唯一权威锁 `src/shared/managed-codex-runtime.json::version` 并上传新的 runtime set。`runtimeSet` 固定派生为 `codex-<version>`；Rust、TypeScript、打包器与两端发布脚本都从该值派生，不再手工同步版本。正式发布入口不接受 version / runtime set 覆盖，防止不同平台向同一个 immutable set 上传不同 Codex 版本。脚本默认会检查远端 manifest，发现同一个 runtime set 已存在时拒绝覆盖；只有显式传 `--force-republish` 才允许重发同一路径。

**运行方式**：
```bash
./publish_managed_codex_runtime.sh
```

默认读取 `src/shared/managed-codex-runtime.json`，而不是读取 `tauri.conf.json` 的桌面应用版本。正常升级或补发都无需传版本参数：

```bash
./publish_managed_codex_runtime.sh -y
```

脚本复用 `.env` 凭证、R2 bucket、`download.myagents.io` 域名、Cloudflare purge 和上传后 HTTP 验证。正式上传仍要求 `scripts/package-managed-codex-runtime.mjs` 完成 manifest/artifact 校验；它会逐个枚举 Mach-O / PE，固定 native 文件集合，并校验上游签名。macOS 主 `codex` 与 `codex-code-mode-host` 必须保持 OpenAI Team/Developer ID；macOS `rg` / `zsh` helper 若已有同一 OpenAI Developer ID 或旧版 ad-hoc 签名则原样保留并复验，只有固定路径且确认为完全未签名时才使用 `.env` 中的 `APPLE_SIGNING_IDENTITY` 补签。Windows 的 OpenAI 原生二进制必须通过 Authenticode 且 publisher 默认为 `OpenAI OpCo, LLC`，实际 signer certificate SHA-256 只写入 `release-audit-v1.json`，不作为每个版本都要人工更新的发布锁；Windows `codex-path/rg.exe` 保持上游未签名状态并写入 audit。开发用 unsigned 包只应使用 `npm run package:managed-codex` 本地生成，不应上传到正式 R2 路径。

客户端升级采用版本目录 + Sidecar 启动边界切换：已验证安装的旧 runtime 在 `update-required`、后台下载或下载失败期间仍可使用；运行中的 Codex `app-server` 固定其启动时的绝对 binary path，不会因下载完成被 abort 或热替换。新 artifact 安装完成后只原子更新后续进程的安装指针，新建 / 自然重启的 Sidecar 使用新版，既有 Sidecar 继续使用旧版直到 owner 自然释放。macOS 与 Windows 产品时序相同，Windows 也因此无需覆盖运行中的 `codex.exe`。

Runtime set 是按平台分片补发的：macOS 主机默认发布 `darwin-arm64,darwin-x64`，Windows 主机使用 `publish_managed_codex_runtime.ps1` 发布 `win32-x64`。两边上传到同一个 `sets/<runtime-set>/` 前缀，默认只允许新增缺失平台；如果同平台 manifest 已存在会拒绝覆盖。

```powershell
.\publish_managed_codex_runtime.ps1 -Yes
```

### publish_speech_model_set.sh

**用途**：把当前 App/Worker 已编译锁定的标准语音模型资源与签名清单发布到 R2。当前 `local-standard-speech-v2` 将四个模型 asset 和三个 remote legal source 放在 `models/speech/assets/sha256/<sha256>/<filename>` 的 content-addressed 第一方路径；manifest 目录仍只使用 pack revision，JSON 内的 `schemaVersion: 1` 是 manifest schema，因此文件名不重复带 `-v1` / `-v2`。

本地可用 unsigned 模式验证输出路径与逐字节 identity，但该产物不能发布，也不会被 App 接受：

```bash
npm run package:speech-model-set -- --allow-unsigned
```

正式发布从 source lock 自动派生 immutable `packRevision`，复用现有 Tauri updater Minisign 私钥、R2 配置和 Cloudflare 域名；发布机需安装成熟的 `minisign` CLI，脚本会用 App 内同一 updater 公钥在上传前验签：

```bash
npm run publish:speech-model-set -- -y
```

发布脚本把运行时 source lock 与 release-only `model-pack-mirror-origin-lock.json` 按 exact ID join，复用构建资源的 content-addressed cache 从锁定的上游 URL 下载并校验七个 source。它先只补传缺失的 immutable source，并逐个从公网完整回读比对；确认全部可用后才上传 `manifest.json` 与 `manifest.json.sig`。远端已有 source/manifest 必须与本地逐字节一致，已有或新签名都必须通过 App updater 公钥验签；任何漂移都要求提升 `packRevision`。脚本不接受 revision、URL、asset 或 trust-root 覆盖，避免发布内容与客户端编译 lock 分叉。模型资源发布是独立 release 动作，不应绑到每次桌面 App build；锁变化或首次启用新 revision 时必须先完成发布和真实安装 smoke。

### 可选「浏览器」Runtime 资源

`myagents-browser` /「浏览器」直接下载 Playwright 锁定版本对应的官方 Chromium artifact。桌面 App 只包含 `@playwright/mcp` / Playwright 控制代码；三个锁定控制包以原生目录结构位于 `Resources/node_modules`，不合并进 ESM `server-dist.js`。MyAgents 不镜像、不重新打包、也不上传浏览器资源。`tauri:dev`、`tauri:build`、`build_macos.sh`、`build_windows.ps1` 和桌面发布脚本均不得访问 Playwright CDN 或下载 Chromium。

唯一版本锁是 `src/shared/managed-browser-runtime.json`。它必须同时满足：

- MCP/Core/Chromium revision 与当前安装的 `@playwright/mcp`、`playwright-core/browsers.json` 完全一致；
- 五个平台的 `sourceUrl` 与该 Playwright Core registry 解析结果一致；
- `url` 是该 source URL 当前受控跳转后的官方 Chrome for Testing / Playwright CDN 最终地址；
- `archiveSizeBytes`、SHA-256、archive root 与 executable path 来自同一个 exact artifact；
- 每个平台只描述有头 Chromium，不包含 Headless Shell、FFmpeg、winldd、Firefox 或 WebKit。

升级 Playwright 时，维护者在显式网络核对流程中下载五个官方 artifact、复核 URL 跳转链并计算 size/SHA-256，再提交新的版本锁。这个动作不是 App build 或发布脚本的一部分，也不产生待上传的 MyAgents Browser artifact。发布 App 前必须在对应 release-like 真机完成首次显式安装、进度、重启恢复、自动更新与有头 Chromium smoke。

首次安装由用户在工具卡点击“安装资源”触发；只有首次完整成功后，Rust owner 才在后续 App 版本需要新 set 时自动维护。App/installer/updater artifact scan 必须确认不存在 `playwright-browsers`、Chromium、Headless Shell 或 FFmpeg 可执行资源。

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

桌面 App 版本的单一数据源是 `package.json`。使用 npm 的版本命令更新它，并让仓库内置
`version` hook 同步 Tauri 与 Cargo 配置：

```bash
npm version x.x.x --no-git-tag-version
cargo metadata --manifest-path src-tauri/Cargo.toml --no-deps --format-version 1 >/dev/null
cargo metadata --manifest-path src-tauri/Cargo.toml --locked --no-deps --format-version 1 >/dev/null
```

提交前确认以下位置一致：

- `package.json` 与 `package-lock.json` 根包版本；
- `src-tauri/tauri.conf.json`；
- `src-tauri/Cargo.toml` 与 `Cargo.lock` 中的 `myagents` 根包版本。

构建脚本会校验 package / Tauri / Cargo 三处版本，不一致时拒绝继续。Managed Codex Runtime
使用 `src/shared/managed-codex-runtime.json` 的独立版本锁，不能随桌面 App 版本自动递增。

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

发布脚本只上传桌面 App 安装包、自动更新包和更新清单；不会打包或上传 Managed Codex Runtime、Speech model set，也不会处理「浏览器」Runtime。若本客户端版本锁定了新的 Codex runtime set，必须先确认对应平台资源已上传且 exact manifest 可读；若更新了 Speech model source lock，则先运行独立的 `publish:speech-model-set`，确认固定 manifest/signature 可读并完成真实模型安装 smoke；若更新了 Browser runtime lock，则确认各平台官方 exact artifact 可读并完成 release-like 安装 smoke。

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

feature 分支 push 后，必须等待现有 GitHub `Test` workflow 对 feature HEAD 的精确 SHA 成功，再以 `--no-ff` 合并并 push `main`。随后再次等待 `Test` 对最终 main SHA 成功；没有 run、run 被取消或任一 job 失败都停止发布，不能拿父 commit 或其它分支的绿色结果替代。测试内容只由该 workflow 定义，发布步骤不复制一份 job 清单。

```bash
git add package.json package-lock.json src-tauri/tauri.conf.json src-tauri/Cargo.toml src-tauri/Cargo.lock CHANGELOG.md
git commit -m "chore: release v0.1.0" -m "Prepare the tracked version metadata and changelog for the v0.1.0 release."
git push origin main
# 确认 Test 对当前 git rev-parse HEAD 的 run 已 terminal success
git tag -a v0.1.0 -m "v0.1.0"
git push origin v0.1.0
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
TAURI_SIGNING_PRIVATE_KEY="xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx"
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

- [Windows 构建与测试指南](./windows_build_guide.md) - Windows 版本构建流程
- [自动更新系统](../tech_docs/auto_update.md) - 运行时 owner、平台安装流程与安全不变量
- [macOS 分发指南](./macos_distribution_guide.md) - 代码签名、公证详解
- [Node.js Sidecar 打包](../tech_docs/bundled_node.md) - 运行时打包机制

### Cuse 桌面操作 Skill

Mac 正式/开发构建会按目标拉取并校验 Cuse 完整 Skill+CLI，再对 CLI 使用客户端身份签名。Windows 构建使用独立 Windows 包。资源随 App 更新，全局关闭状态保留；协议、低层构建准备命令和校验规则见 [Cuse bundle](../tech_docs/cuse_bundle.md)。

# macOS 应用分发方案

## 概述

将 Tauri 应用分发给其他用户安装，需要完成以下步骤：
1. **代码签名** - 使用 Apple Developer ID 签名应用
2. **公证 (Notarization)** - Apple 验证应用安全性
3. **打包** - 生成 .dmg 或 .pkg 安装包

> [!IMPORTANT]
> macOS Catalina (10.15) 及以后版本要求所有分发的应用必须经过代码签名和公证，否则 Gatekeeper 会阻止运行。

---

## 前置条件

- [x] Apple Developer 账号（付费版，$99/年）
- [ ] macOS 电脑（用于生成证书）
- [ ] Xcode 14+ 已安装
- [ ] Tauri 项目可正常构建

---

## 第一步：创建证书签名请求 (CSR)

1. 打开 **钥匙串访问** (Keychain Access)
2. 菜单栏：钥匙串访问 → 证书助理 → 从证书颁发机构请求证书
3. 填写：
   - 用户电子邮件：你的 Apple ID
   - 常用名称：你的名字
   - 选择「存储到磁盘」
4. 保存 `.certSigningRequest` 文件

---

## 第二步：在 Apple Developer 创建证书

1. 登录 [Apple Developer](https://developer.apple.com/account)
2. 进入 **Certificates, Identifiers & Profiles**
3. 点击 **Certificates** → **+** 创建新证书
4. 选择 **Developer ID Application**（App Store 外分发必选）
5. 上传第一步创建的 CSR 文件
6. 下载生成的 `.cer` 证书文件
7. 双击安装到钥匙串

### 验证证书安装

```bash
security find-identity -v -p codesigning
```

应该看到类似输出：
```
1) XXXXXXXX "Developer ID Application: Your Name (TEAM_ID)"
```

---

## 第三步：创建 App Store Connect API 密钥

用于自动化公证流程：

1. 登录 [App Store Connect](https://appstoreconnect.apple.com)
2. 用户和访问 → 集成 → 团队密钥
3. 点击 **+** 生成新密钥
4. 名称：`Notarization Key`
5. 权限：`Developer`（最小权限原则）
6. 下载 `.p8` 私钥文件（**只能下载一次！**）
7. 记录：
   - **Issuer ID**: 页面顶部显示
   - **Key ID**: 密钥列表中显示

---

## 第四步：配置环境变量

在 `~/.zshrc` 或项目 `.env` 文件中添加：

```bash
# 签名身份（从 security find-identity 输出获取）
export APPLE_SIGNING_IDENTITY="Developer ID Application: Your Name (TEAM_ID)"

# Team ID（在 Apple Developer 会员页面查看）
export APPLE_TEAM_ID="XXXXXXXXXX"

# API 密钥认证（推荐方式）
export APPLE_API_ISSUER="xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx"
export APPLE_API_KEY="XXXXXXXXXX"
export APPLE_API_KEY_PATH="/path/to/AuthKey_XXXXXXXXXX.p8"
```

刷新环境：
```bash
source ~/.zshrc
```

---

## 第五步：更新 Tauri 配置

编辑 `src-tauri/tauri.conf.json`：

```json
{
  "bundle": {
    "macOS": {
      "signingIdentity": null,
      "minimumSystemVersion": "13.0",
      "entitlements": null,
      "exceptionDomain": null
    }
  }
}
```

> `signingIdentity: null` 表示使用环境变量 `APPLE_SIGNING_IDENTITY`

---

## 第六步：构建签名并公证的应用

```bash
# 确保环境变量已设置
echo $APPLE_SIGNING_IDENTITY

# 构建 universal binary（同时支持 Intel 和 Apple Silicon）
npm run tauri build -- --target universal-apple-darwin
```

如果环境变量配置正确，Tauri 会自动：
1. ✅ 使用 Developer ID 签名应用
2. ✅ 提交到 Apple 进行公证
3. ✅ 等待公证完成（通常 2-5 分钟）
4. ✅ Staple 公证票据到应用

---

## 第七步：验证签名和公证

```bash
# 验证签名
codesign --verify --deep --strict --verbose=2 \
  src-tauri/target/universal-apple-darwin/release/bundle/macos/MyAgents.app

# 验证公证
spctl --assess --type exec --verbose=2 \
  src-tauri/target/universal-apple-darwin/release/bundle/macos/MyAgents.app

# 查看公证状态
xcrun stapler validate \
  src-tauri/target/universal-apple-darwin/release/bundle/macos/MyAgents.app
```

---

## 分发方式

### 方式一：.dmg 安装包（推荐）

Tauri 默认会生成 `.dmg` 文件，位于：
```
src-tauri/target/universal-apple-darwin/release/bundle/dmg/
```

### 方式二：直接分发 .app

压缩 `.app` 文件夹为 `.zip` 分发。

---

## 常见问题

### Q: 公证失败怎么办？

查看详细错误：
```bash
xcrun notarytool log <submission-id> --keychain-profile "notarytool-profile"
```

### Q: 用户打开时仍显示「无法验证开发者」

可能原因：
1. 公证未完成 - 等待几分钟后重试
2. 需要 staple - 运行 `xcrun stapler staple Your.app`
3. 用户离线 - 首次运行需要联网验证

### Q: CI/CD 中如何配置？

在 GitHub Actions 中设置 secrets：
- `APPLE_CERTIFICATE`: base64 编码的 .p12 文件
- `APPLE_CERTIFICATE_PASSWORD`: 导出密码
- `APPLE_SIGNING_IDENTITY`
- `APPLE_API_ISSUER`, `APPLE_API_KEY`, `APPLE_API_KEY_PATH`

---

## 检查清单

- [ ] 创建 CSR 文件
- [ ] 创建 Developer ID Application 证书
- [ ] 安装证书到钥匙串
- [ ] 创建 App Store Connect API 密钥
- [ ] 配置环境变量
- [ ] 运行带签名的构建
- [ ] 验证签名和公证
- [ ] 测试在新 Mac 上安装

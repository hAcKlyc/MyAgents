# MyAgents Windows 正式发布构建脚本
# 构建 NSIS 安装包和便携版 ZIP
# 支持 Windows x64

param(
    [switch]$SkipTypeCheck,
    [switch]$SkipPortable
)

$ErrorActionPreference = "Stop"

$ProjectDir = Split-Path -Parent $MyInvocation.MyCommand.Path
Set-Location $ProjectDir

# 读取版本号
$TauriConf = Get-Content "src-tauri\tauri.conf.json" -Raw | ConvertFrom-Json
$Version = $TauriConf.version
$TauriConfPath = Join-Path $ProjectDir "src-tauri\tauri.conf.json"
$EnvFile = Join-Path $ProjectDir ".env"

Write-Host ""
Write-Host "=========================================" -ForegroundColor Cyan
Write-Host "  MyAgents Windows 发布构建" -ForegroundColor Green
Write-Host "  Version: $Version" -ForegroundColor Blue
Write-Host "=========================================" -ForegroundColor Cyan
Write-Host ""

# ========================================
# 版本同步检查
# ========================================
$PkgJson = Get-Content "package.json" -Raw | ConvertFrom-Json
$PkgVersion = $PkgJson.version

$CargoToml = Get-Content "src-tauri\Cargo.toml" -Raw
$CargoVersionMatch = [regex]::Match($CargoToml, 'version = "([^"]+)"')
$CargoVersion = if ($CargoVersionMatch.Success) { $CargoVersionMatch.Groups[1].Value } else { "" }

if ($PkgVersion -ne $Version -or $PkgVersion -ne $CargoVersion) {
    Write-Host "版本号不一致:" -ForegroundColor Yellow
    Write-Host "  package.json:    $PkgVersion" -ForegroundColor Cyan
    Write-Host "  tauri.conf.json: $Version" -ForegroundColor Cyan
    Write-Host "  Cargo.toml:      $CargoVersion" -ForegroundColor Cyan
    Write-Host ""
    $sync = Read-Host "是否同步版本号到 $PkgVersion? (y/N)"
    if ($sync -eq "y" -or $sync -eq "Y") {
        & node "$ProjectDir\scripts\sync-version.js"
        $Version = $PkgVersion
        Write-Host ""
    }
}

# ========================================
# 加载环境变量
# ========================================
Write-Host "[1/7] 加载环境配置..." -ForegroundColor Blue

if (Test-Path $EnvFile) {
    Get-Content $EnvFile | ForEach-Object {
        if ($_ -match '^([^#=]+)=(.*)$') {
            $name = $Matches[1].Trim()
            $value = $Matches[2].Trim()
            # 移除引号
            $value = $value -replace '^["'']|["'']$', ''
            [Environment]::SetEnvironmentVariable($name, $value, "Process")
        }
    }
    Write-Host "[OK] 已加载 .env" -ForegroundColor Green
}
else {
    Write-Host "[!] .env 文件不存在，将使用默认配置" -ForegroundColor Yellow
}

# 检查 Tauri 签名密钥
$TauriSigningKey = [Environment]::GetEnvironmentVariable("TAURI_SIGNING_PRIVATE_KEY", "Process")
if (-not $TauriSigningKey) {
    Write-Host ""
    Write-Host "=========================================" -ForegroundColor Yellow
    Write-Host "  警告: TAURI_SIGNING_PRIVATE_KEY 未设置" -ForegroundColor Yellow
    Write-Host "  自动更新功能将不可用!" -ForegroundColor Yellow
    Write-Host "=========================================" -ForegroundColor Yellow
    Write-Host ""
    $continue = Read-Host "是否继续构建? (Y/n)"
    if ($continue -eq "n" -or $continue -eq "N") {
        Write-Host "构建已取消" -ForegroundColor Red
        exit 1
    }
}
else {
    Write-Host "  [OK] Tauri 签名私钥已配置" -ForegroundColor Green
}
Write-Host ""

# ========================================
# 检查依赖
# ========================================
Write-Host "[2/7] 检查依赖..." -ForegroundColor Blue

function Test-Command {
    param([string]$Command, [string]$HelpUrl)
    try {
        $null = & $Command 2>&1
        return $true
    }
    catch {
        Write-Host "  [X] $Command 未安装" -ForegroundColor Red
        Write-Host "      请安装: $HelpUrl" -ForegroundColor Yellow
        return $false
    }
}

$depOk = $true
if (-not (Test-Command "rustc --version" "https://rustup.rs")) { $depOk = $false }
if (-not (Test-Command "npm --version" "https://nodejs.org")) { $depOk = $false }
if (-not (Test-Command "bun --version" "https://bun.sh")) { $depOk = $false }

# 检查 Rust Windows 目标
$installedTargets = & rustup target list --installed 2>$null
if ($installedTargets -notcontains "x86_64-pc-windows-msvc") {
    Write-Host "  安装 Rust 目标: x86_64-pc-windows-msvc" -ForegroundColor Yellow
    & rustup target add x86_64-pc-windows-msvc
}
else {
    Write-Host "  [OK] Rust 目标已安装: x86_64-pc-windows-msvc" -ForegroundColor Green
}

if (-not $depOk) {
    Write-Host "请先安装缺失的依赖" -ForegroundColor Red
    exit 1
}

Write-Host "[OK] 依赖检查通过" -ForegroundColor Green
Write-Host ""

# ========================================
# 配置生产 CSP
# ========================================
Write-Host "[3/7] 配置生产环境 CSP..." -ForegroundColor Blue

# 备份配置
Copy-Item $TauriConfPath "$TauriConfPath.bak" -Force

# 更新 CSP
$conf = Get-Content $TauriConfPath -Raw | ConvertFrom-Json
$conf.app.security.csp = "default-src 'self' ipc: tauri:; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; font-src 'self' data:; connect-src 'self' ipc: tauri: http://localhost:* http://127.0.0.1:* ws://localhost:* ws://127.0.0.1:*; img-src 'self' data: blob:;"
$conf | ConvertTo-Json -Depth 10 | Set-Content $TauriConfPath -Encoding UTF8

Write-Host "[OK] CSP 已配置" -ForegroundColor Green
Write-Host ""

# ========================================
# 清理旧构建
# ========================================
Write-Host "[准备] 清理旧构建..." -ForegroundColor Blue

if (Test-Path "dist") {
    Remove-Item -Recurse -Force "dist"
}

$bundleDir = "src-tauri\target\x86_64-pc-windows-msvc\release\bundle"
if (Test-Path $bundleDir) {
    Remove-Item -Recurse -Force $bundleDir
}

Write-Host "[OK] 清理完成" -ForegroundColor Green
Write-Host ""

# ========================================
# TypeScript 类型检查
# ========================================
if (-not $SkipTypeCheck) {
    Write-Host "[4/7] TypeScript 类型检查..." -ForegroundColor Blue
    & bun run typecheck
    if ($LASTEXITCODE -ne 0) {
        Write-Host "[X] TypeScript 检查失败，请修复后重试" -ForegroundColor Red
        # 恢复配置
        if (Test-Path "$TauriConfPath.bak") {
            Move-Item "$TauriConfPath.bak" $TauriConfPath -Force
        }
        exit 1
    }
    Write-Host "[OK] TypeScript 检查通过" -ForegroundColor Green
    Write-Host ""
}
else {
    Write-Host "[4/7] 跳过 TypeScript 类型检查" -ForegroundColor Yellow
    Write-Host ""
}

# ========================================
# 构建前端和服务端
# ========================================
Write-Host "[5/7] 构建前端和服务端..." -ForegroundColor Blue

# 打包服务端代码
Write-Host "  打包服务端代码..." -ForegroundColor Cyan
$resourcesDir = Join-Path $ProjectDir "src-tauri\resources"
if (-not (Test-Path $resourcesDir)) {
    New-Item -ItemType Directory -Path $resourcesDir -Force | Out-Null
}

& bun build ./src/server/index.ts --outfile=./src-tauri/resources/server-dist.js --target=bun
if ($LASTEXITCODE -ne 0) {
    Write-Host "[X] 服务端打包失败" -ForegroundColor Red
    exit 1
}

# 验证打包结果不包含硬编码路径
$serverDist = Get-Content "src-tauri\resources\server-dist.js" -Raw
if ($serverDist -match 'var __dirname = "/Users/[^"]+"') {
    Write-Host "[X] 错误: server-dist.js 包含硬编码的 __dirname 路径!" -ForegroundColor Red
    exit 1
}
Write-Host "  [OK] 服务端代码验证通过 (无硬编码路径)" -ForegroundColor Green

# 复制 SDK 依赖
Write-Host "  复制 SDK 依赖..." -ForegroundColor Cyan
$sdkSrc = Join-Path $ProjectDir "node_modules\@anthropic-ai\claude-agent-sdk"
$sdkDest = Join-Path $ProjectDir "src-tauri\resources\claude-agent-sdk"

if (Test-Path $sdkDest) {
    Remove-Item -Recurse -Force $sdkDest
}
New-Item -ItemType Directory -Path $sdkDest -Force | Out-Null

Copy-Item "$sdkSrc\cli.js" $sdkDest -Force
Copy-Item "$sdkSrc\sdk.mjs" $sdkDest -Force
Copy-Item "$sdkSrc\*.wasm" $sdkDest -Force
Copy-Item "$sdkSrc\vendor" $sdkDest -Recurse -Force

# 构建前端
Write-Host "  构建前端..." -ForegroundColor Cyan
& bun run build:web
if ($LASTEXITCODE -ne 0) {
    Write-Host "[X] 前端构建失败" -ForegroundColor Red
    exit 1
}

Write-Host "[OK] 前端和服务端构建完成" -ForegroundColor Green
Write-Host ""

# ========================================
# 构建 Tauri 应用
# ========================================
Write-Host "[6/7] 构建 Tauri 应用 (Release)..." -ForegroundColor Blue
Write-Host "这可能需要几分钟..." -ForegroundColor Yellow

& bun run tauri:build -- --target x86_64-pc-windows-msvc
if ($LASTEXITCODE -ne 0) {
    Write-Host "[X] Tauri 构建失败" -ForegroundColor Red
    # 恢复配置
    if (Test-Path "$TauriConfPath.bak") {
        Move-Item "$TauriConfPath.bak" $TauriConfPath -Force
    }
    exit 1
}

Write-Host "[OK] Tauri 构建完成" -ForegroundColor Green
Write-Host ""

# ========================================
# 创建便携版 ZIP
# ========================================
if (-not $SkipPortable) {
    Write-Host "[6.5/7] 创建便携版 ZIP..." -ForegroundColor Blue

    $targetDir = "src-tauri\target\x86_64-pc-windows-msvc\release"
    $nsisDir = "$targetDir\bundle\nsis"
    $exePath = "$targetDir\MyAgents.exe"

    if (Test-Path $exePath) {
        $portableDir = Join-Path $targetDir "portable"
        $zipName = "MyAgents_${Version}_x86_64-portable.zip"
        $zipPath = Join-Path $nsisDir $zipName

        # 创建便携版目录
        if (Test-Path $portableDir) {
            Remove-Item -Recurse -Force $portableDir
        }
        New-Item -ItemType Directory -Path $portableDir -Force | Out-Null

        # 复制必要文件
        Copy-Item $exePath $portableDir -Force

        # 复制 Bun 可执行文件
        $bunExe = Join-Path $targetDir "bun-x86_64-pc-windows-msvc.exe"
        if (Test-Path $bunExe) {
            Copy-Item $bunExe $portableDir -Force
        }

        # 复制 resources 目录
        $resourcesSource = Join-Path $targetDir "resources"
        if (Test-Path $resourcesSource) {
            Copy-Item $resourcesSource $portableDir -Recurse -Force
        }

        # 创建 ZIP
        if (Test-Path $zipPath) {
            Remove-Item -Force $zipPath
        }
        Compress-Archive -Path "$portableDir\*" -DestinationPath $zipPath -Force

        # 清理临时目录
        Remove-Item -Recurse -Force $portableDir

        Write-Host "[OK] 便携版 ZIP 创建完成: $zipName" -ForegroundColor Green
    }
    else {
        Write-Host "[!] 未找到 MyAgents.exe，跳过便携版创建" -ForegroundColor Yellow
    }
    Write-Host ""
}

# ========================================
# 恢复配置
# ========================================
Write-Host "[7/7] 恢复开发配置..." -ForegroundColor Blue

if (Test-Path "$TauriConfPath.bak") {
    Move-Item "$TauriConfPath.bak" $TauriConfPath -Force
    Write-Host "[OK] 配置已恢复" -ForegroundColor Green
}
else {
    Write-Host "[!] 备份文件不存在，跳过恢复" -ForegroundColor Yellow
}
Write-Host ""

# ========================================
# 显示构建产物
# ========================================
$bundleDir = "src-tauri\target\x86_64-pc-windows-msvc\release\bundle"
$nsisDir = Join-Path $bundleDir "nsis"

Write-Host "=========================================" -ForegroundColor Green
Write-Host "  构建成功!" -ForegroundColor Green
Write-Host "=========================================" -ForegroundColor Green
Write-Host ""
Write-Host "  版本: $Version" -ForegroundColor Cyan
Write-Host ""
Write-Host "  构建产物:" -ForegroundColor Blue

# 查找 NSIS 安装包
$nsisFiles = Get-ChildItem -Path $nsisDir -Filter "*.exe" -ErrorAction SilentlyContinue
foreach ($file in $nsisFiles) {
    $size = "{0:N2} MB" -f ($file.Length / 1MB)
    Write-Host "    NSIS: $($file.Name) ($size)" -ForegroundColor Cyan
}

# 查找便携版 ZIP
$zipFiles = Get-ChildItem -Path $nsisDir -Filter "*portable*.zip" -ErrorAction SilentlyContinue
foreach ($file in $zipFiles) {
    $size = "{0:N2} MB" -f ($file.Length / 1MB)
    Write-Host "    ZIP:  $($file.Name) ($size)" -ForegroundColor Cyan
}

# 查找更新包
$tarFiles = Get-ChildItem -Path $nsisDir -Filter "*.nsis.zip" -ErrorAction SilentlyContinue
foreach ($file in $tarFiles) {
    $size = "{0:N2} MB" -f ($file.Length / 1MB)
    Write-Host "    更新包: $($file.Name) ($size)" -ForegroundColor Cyan
}

Write-Host ""
Write-Host "  输出目录:" -ForegroundColor Blue
Write-Host "    $nsisDir" -ForegroundColor Cyan
Write-Host ""

# 检查自动更新签名
$sigFiles = Get-ChildItem -Path $nsisDir -Filter "*.sig" -ErrorAction SilentlyContinue
if ($sigFiles) {
    Write-Host "  [OK] 自动更新签名已生成" -ForegroundColor Green
}
else {
    Write-Host "  [!] 未生成自动更新签名 (TAURI_SIGNING_PRIVATE_KEY 未设置)" -ForegroundColor Yellow
}

Write-Host ""
Write-Host "后续步骤:" -ForegroundColor Blue
Write-Host "  1. 测试安装包" -ForegroundColor White
Write-Host "  2. 运行 .\publish_windows.ps1 发布到 R2" -ForegroundColor White
Write-Host ""

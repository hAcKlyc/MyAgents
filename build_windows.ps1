#!/usr/bin/env pwsh
# MyAgents Windows 正式发布构建脚本
# 构建 NSIS 安装包和便携版 ZIP
# 支持 Windows x64

param(
    [switch]$SkipTypeCheck,
    [switch]$SkipPortable
)

$ErrorActionPreference = "Stop"
$BuildSuccess = $false

try {
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
        # 加载 .env (支持行内注释)
        Get-Content $EnvFile | ForEach-Object {
            if ($_ -match '^([^#=]+)=(.*)$') {
                $name = $Matches[1].Trim()
                $value = $Matches[2].Trim()

                # 处理带引号的值（提取引号内的内容，忽略引号外的注释）
                if ($value -match '^"([^"]*)"' -or $value -match "^'([^']*)'") {
                    $value = $Matches[1]
                } else {
                    # 无引号的值，移除行内注释
                    $value = $value -replace '\s+#.*$', ''
                    $value = $value.Trim()
                }

                [Environment]::SetEnvironmentVariable($name, $value, "Process")
            }
        }
        Write-Host "  OK - 已加载 .env" -ForegroundColor Green
    }
    else {
        Write-Host "  警告: .env 文件不存在，将使用默认配置" -ForegroundColor Yellow
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
            throw "用户取消构建"
        }
    }
    else {
        Write-Host "  OK - Tauri 签名私钥已配置" -ForegroundColor Green
    }
    Write-Host ""

    # ========================================
    # 检查依赖
    # ========================================
    Write-Host "[2/7] 检查依赖..." -ForegroundColor Blue

    function Test-Command {
        param([string]$Command, [string]$HelpUrl)
        try {
            $null = Invoke-Expression $Command 2>&1
            return $true
        }
        catch {
            Write-Host "  X - $Command 未安装" -ForegroundColor Red
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
        Write-Host "  OK - Rust 目标已安装: x86_64-pc-windows-msvc" -ForegroundColor Green
    }

    if (-not $depOk) {
        throw "请先安装缺失的依赖"
    }

    Write-Host "  OK - 依赖检查通过" -ForegroundColor Green
    Write-Host ""

    # ========================================
    # 验证 CSP 配置（不再覆盖）
    # ========================================
    Write-Host "[3/7] 验证 CSP 配置..." -ForegroundColor Blue

    $conf = Get-Content $TauriConfPath -Raw | ConvertFrom-Json
    $currentCsp = $conf.app.security.csp

    # 验证关键 CSP 指令是否存在
    $requiredCspParts = @(
        "http://ipc.localhost",
        "asset:",
        "https://download.myagents.io"
    )

    $missingParts = @()
    foreach ($part in $requiredCspParts) {
        if ($currentCsp -notlike "*$part*") {
            $missingParts += $part
        }
    }

    # 特殊验证: fetch-src 指令必须包含 http://ipc.localhost (Windows Tauri IPC 关键)
    if ($currentCsp -match "fetch-src\s+([^;]+)") {
        $fetchSrcDirective = $matches[1]
        if ($fetchSrcDirective -notlike "*http://ipc.localhost*") {
            $missingParts += "fetch-src 缺少 http://ipc.localhost (Windows 必需)"
        }
    } else {
        $missingParts += "fetch-src 指令"
    }

    if ($missingParts.Count -gt 0) {
        Write-Host "  错误: CSP 配置不符合 Windows 要求:" -ForegroundColor Red
        $missingParts | ForEach-Object { Write-Host "    - $_" -ForegroundColor Red }
        Write-Host ""
        Write-Host "  Windows Tauri IPC 需要 fetch-src 包含 http://ipc.localhost" -ForegroundColor Yellow
        Write-Host "  请检查 tauri.conf.json 中的 CSP 配置" -ForegroundColor Yellow
        Write-Host ""
        throw "CSP 配置不完整，无法在 Windows 上正常运行"
    } else {
        Write-Host "  OK - CSP 配置完整 (包含 Windows IPC 支持)" -ForegroundColor Green
    }
    Write-Host ""

    # ========================================
    # 清理旧构建（包括缓存的 resources）
    # ========================================
    Write-Host "[准备] 清理旧构建..." -ForegroundColor Blue

    # 杀死残留进程（避免文件锁定）
    $bunProcesses = Get-Process | Where-Object { $_.ProcessName -eq "bun" }
    $appProcesses = Get-Process | Where-Object { $_.ProcessName -eq "MyAgents" }

    if ($bunProcesses) {
        $bunProcesses | Stop-Process -Force -ErrorAction SilentlyContinue
        Write-Host "  清理了 $($bunProcesses.Count) 个 Bun 进程" -ForegroundColor Gray
    }

    if ($appProcesses) {
        $appProcesses | Stop-Process -Force -ErrorAction SilentlyContinue
        Write-Host "  清理了 $($appProcesses.Count) 个 MyAgents 进程" -ForegroundColor Gray
    }

    # 验证进程清理完成（最多等待 2 秒）
    $maxWait = 20  # 20 * 100ms = 2s
    $waited = 0
    while ($waited -lt $maxWait) {
        $remainingBun = Get-Process -Name "bun" -ErrorAction SilentlyContinue
        $remainingApp = Get-Process -Name "MyAgents" -ErrorAction SilentlyContinue
        if (-not $remainingBun -and -not $remainingApp) {
            break
        }
        Start-Sleep -Milliseconds 100
        $waited++
    }

    if ($waited -gt 0) {
        Write-Host "  进程清理验证完成 (耗时 $($waited * 100)ms)" -ForegroundColor Gray
    }

    # 清理构建输出目录
    $dirsToClean = @(
        @{ Path = "dist"; Name = "前端构建输出" },
        @{ Path = "src-tauri\target\x86_64-pc-windows-msvc\release\bundle"; Name = "打包输出" },
        @{ Path = "src-tauri\target\x86_64-pc-windows-msvc\release\resources"; Name = "resources 缓存 (CRITICAL)" }
    )

    foreach ($dir in $dirsToClean) {
        if (Test-Path $dir.Path) {
            try {
                Remove-Item -Recurse -Force $dir.Path -ErrorAction Stop
                Write-Host "  已清理: $($dir.Name)" -ForegroundColor Gray
            } catch {
                Write-Host "  警告: 清理 $($dir.Name) 失败: $_" -ForegroundColor Yellow
                Write-Host "  路径: $($dir.Path)" -ForegroundColor Yellow
                # 不抛出异常，继续构建
            }
        }
    }

    Write-Host "  OK - 清理完成（含 resources 缓存）" -ForegroundColor Green
    Write-Host ""

    # ========================================
    # TypeScript 类型检查
    # ========================================
    if (-not $SkipTypeCheck) {
        Write-Host "[4/7] TypeScript 类型检查..." -ForegroundColor Blue
        & bun run typecheck
        if ($LASTEXITCODE -ne 0) {
            throw "TypeScript 检查失败，请修复后重试"
        }
        Write-Host "  OK - TypeScript 检查通过" -ForegroundColor Green
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
        throw "服务端打包失败"
    }

    # 验证打包结果不包含硬编码路径
    $serverDist = Get-Content "src-tauri\resources\server-dist.js" -Raw
    if ($serverDist -match 'var __dirname = "/Users/[^"]+"') {
        throw "server-dist.js 包含硬编码的 __dirname 路径!"
    }
    Write-Host "    OK - 服务端代码验证通过" -ForegroundColor Green

    # 复制 SDK 依赖
    Write-Host "  复制 SDK 依赖..." -ForegroundColor Cyan
    $sdkSrc = Join-Path $ProjectDir "node_modules\@anthropic-ai\claude-agent-sdk"
    $sdkDest = Join-Path $ProjectDir "src-tauri\resources\claude-agent-sdk"

    if (-not (Test-Path $sdkSrc)) {
        throw "SDK 目录不存在: $sdkSrc"
    }

    if (Test-Path $sdkDest) {
        Remove-Item -Recurse -Force $sdkDest
    }
    New-Item -ItemType Directory -Path $sdkDest -Force | Out-Null

    Copy-Item "$sdkSrc\cli.js" $sdkDest -Force
    Copy-Item "$sdkSrc\sdk.mjs" $sdkDest -Force
    Copy-Item "$sdkSrc\*.wasm" $sdkDest -Force
    Copy-Item "$sdkSrc\vendor" $sdkDest -Recurse -Force
    Write-Host "    OK - SDK 依赖复制完成" -ForegroundColor Green

    # 构建前端 (增加内存限制避免 OOM)
    Write-Host "  构建前端..." -ForegroundColor Cyan
    $env:NODE_OPTIONS = "--max-old-space-size=4096"
    & bun run build:web
    if ($LASTEXITCODE -ne 0) {
        throw "前端构建失败"
    }

    Write-Host "  OK - 前端和服务端构建完成" -ForegroundColor Green
    Write-Host ""

    # ========================================
    # 构建 Tauri 应用
    # ========================================
    Write-Host "[6/7] 构建 Tauri 应用 (Release)..." -ForegroundColor Blue
    Write-Host "  这可能需要几分钟，请耐心等待..." -ForegroundColor Yellow

    & bun run tauri:build -- --target x86_64-pc-windows-msvc
    if ($LASTEXITCODE -ne 0) {
        throw "Tauri 构建失败"
    }

    Write-Host "  OK - Tauri 构建完成" -ForegroundColor Green
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

            if (Test-Path $portableDir) {
                Remove-Item -Recurse -Force $portableDir
            }
            New-Item -ItemType Directory -Path $portableDir -Force | Out-Null

            Copy-Item $exePath $portableDir -Force

            $bunExe = Join-Path $targetDir "bun-x86_64-pc-windows-msvc.exe"
            if (Test-Path $bunExe) {
                Copy-Item $bunExe $portableDir -Force
            }

            $resourcesSource = Join-Path $targetDir "resources"
            if (Test-Path $resourcesSource) {
                Copy-Item $resourcesSource $portableDir -Recurse -Force
            }

            if (Test-Path $zipPath) {
                Remove-Item -Force $zipPath
            }
            Compress-Archive -Path "$portableDir\*" -DestinationPath $zipPath -Force

            Remove-Item -Recurse -Force $portableDir

            Write-Host "  OK - 便携版 ZIP: $zipName" -ForegroundColor Green
        }
        else {
            Write-Host "  警告: 未找到 MyAgents.exe，跳过便携版创建" -ForegroundColor Yellow
        }
        Write-Host ""
    }

    # ========================================
    # 恢复配置
    # ========================================
    Write-Host "[7/7] 恢复开发配置..." -ForegroundColor Blue

    if (Test-Path "$TauriConfPath.bak") {
        Move-Item "$TauriConfPath.bak" $TauriConfPath -Force
        Write-Host "  OK - 配置已恢复" -ForegroundColor Green
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

    $nsisFiles = Get-ChildItem -Path $nsisDir -Filter "*.exe" -ErrorAction SilentlyContinue
    foreach ($file in $nsisFiles) {
        $size = "{0:N2} MB" -f ($file.Length / 1MB)
        Write-Host "    NSIS: $($file.Name) ($size)" -ForegroundColor Cyan
    }

    $zipFiles = Get-ChildItem -Path $nsisDir -Filter "*portable*.zip" -ErrorAction SilentlyContinue
    foreach ($file in $zipFiles) {
        $size = "{0:N2} MB" -f ($file.Length / 1MB)
        Write-Host "    ZIP:  $($file.Name) ($size)" -ForegroundColor Cyan
    }

    $tarFiles = Get-ChildItem -Path $nsisDir -Filter "*.nsis.zip" -ErrorAction SilentlyContinue
    foreach ($file in $tarFiles) {
        $size = "{0:N2} MB" -f ($file.Length / 1MB)
        Write-Host "    更新包: $($file.Name) ($size)" -ForegroundColor Cyan
    }

    Write-Host ""
    Write-Host "  输出目录:" -ForegroundColor Blue
    Write-Host "    $nsisDir" -ForegroundColor Cyan
    Write-Host ""

    $sigFiles = Get-ChildItem -Path $nsisDir -Filter "*.sig" -ErrorAction SilentlyContinue
    if ($sigFiles) {
        Write-Host "  OK - 自动更新签名已生成" -ForegroundColor Green
    }
    else {
        Write-Host "  警告: 未生成自动更新签名 (TAURI_SIGNING_PRIVATE_KEY 未设置)" -ForegroundColor Yellow
    }

    Write-Host ""
    Write-Host "后续步骤:" -ForegroundColor Blue
    Write-Host "  1. 测试安装包" -ForegroundColor White
    Write-Host "  2. 运行 .\publish_windows.ps1 发布到 R2" -ForegroundColor White
    Write-Host ""

    $BuildSuccess = $true

} catch {
    Write-Host ""
    Write-Host "=========================================" -ForegroundColor Red
    Write-Host "  构建失败!" -ForegroundColor Red
    Write-Host "=========================================" -ForegroundColor Red
    Write-Host ""
    Write-Host "错误: $_" -ForegroundColor Red
    Write-Host ""
    if ($_.InvocationInfo.PositionMessage) {
        Write-Host "位置: $($_.InvocationInfo.PositionMessage)" -ForegroundColor Yellow
    }
    Write-Host ""

    # 尝试恢复配置
    $TauriConfPath = Join-Path $ProjectDir "src-tauri\tauri.conf.json"
    if (Test-Path "$TauriConfPath.bak") {
        Move-Item "$TauriConfPath.bak" $TauriConfPath -Force
        Write-Host "已恢复 tauri.conf.json" -ForegroundColor Yellow
    }
}

Write-Host ""
if ($BuildSuccess) {
    Write-Host "按回车键退出..." -ForegroundColor Cyan
} else {
    Write-Host "按回车键退出..." -ForegroundColor Yellow
}
Read-Host

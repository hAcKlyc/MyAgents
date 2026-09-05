#!/usr/bin/env pwsh
# MyAgents Windows 正式发布构建脚本
# 构建 NSIS 安装包和便携版 ZIP
# 支持 Windows x64

param(
    [switch]$SkipTypeCheck,
    [switch]$SkipPortable
)

$ErrorActionPreference = "Stop"
$PSNativeCommandUseErrorActionPreference = $false
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
    # 检查统计上报配置 (VITE_ANALYTICS_*)
    # ========================================
    # 埋点是编译期 gate：isAnalyticsEnabled() 要求 VITE_ANALYTICS_ENABLED=true 且
    # API_KEY / ENDPOINT 非空 (src/renderer/analytics/config.ts)。.env 是 gitignored，
    # 不会随 git checkout 过来——若这台 Windows 构建机没填好 .env，Vite 会把这三个变量
    # 编译成空字符串，整个 Windows 包**完全不上报统计**，平台分布看板里 Windows 凭空消失。
    # build_macos.sh 在 .env 缺失时直接 exit，所以 mac 包从不会静默掉这个；Windows 这条
    # 之前是"警告 + 继续"，于是出现过 Windows 包带着 analytics OFF 发版。这里改成显式确认，
    # 与上面的签名私钥检查同一套交互（Fork / 自建无需上报者直接回车继续）。
    Write-Host "[1.5/7] 检查统计上报配置..." -ForegroundColor Blue
    $AnalyticsEnabled = [Environment]::GetEnvironmentVariable("VITE_ANALYTICS_ENABLED", "Process")
    $AnalyticsKey = [Environment]::GetEnvironmentVariable("VITE_ANALYTICS_API_KEY", "Process")
    $AnalyticsEndpoint = [Environment]::GetEnvironmentVariable("VITE_ANALYTICS_ENDPOINT", "Process")
    $AnalyticsOn = ($AnalyticsEnabled -eq "true") `
        -and -not [string]::IsNullOrWhiteSpace($AnalyticsKey) `
        -and -not [string]::IsNullOrWhiteSpace($AnalyticsEndpoint)
    if ($AnalyticsOn) {
        Write-Host "  OK - 统计上报已启用 (endpoint=$AnalyticsEndpoint)" -ForegroundColor Green
    }
    else {
        Write-Host ""
        Write-Host "=========================================" -ForegroundColor Yellow
        Write-Host "  警告: 统计上报未启用 (VITE_ANALYTICS_* 缺失或为空)" -ForegroundColor Yellow
        Write-Host "  此 Windows 构建将不会上报任何统计事件！" -ForegroundColor Yellow
        Write-Host "  → 平台分布看板里 Windows 用户会凭空消失。" -ForegroundColor Yellow
        Write-Host "  官方发版请确认本机 .env 已配置:" -ForegroundColor Yellow
        Write-Host "    VITE_ANALYTICS_ENABLED=true" -ForegroundColor Yellow
        Write-Host "    VITE_ANALYTICS_API_KEY=<key>" -ForegroundColor Yellow
        Write-Host "    VITE_ANALYTICS_ENDPOINT=<url>" -ForegroundColor Yellow
        Write-Host "  (Fork / 自建无需上报可忽略本提示。)" -ForegroundColor Yellow
        Write-Host "=========================================" -ForegroundColor Yellow
        Write-Host ""
        $continueAnalytics = Read-Host "是否继续构建? (Y/n)"
        if ($continueAnalytics -eq "n" -or $continueAnalytics -eq "N") {
            Write-Host "构建已取消" -ForegroundColor Red
            throw "用户取消构建"
        }
    }
    Write-Host ""

    # ========================================
    # 检查依赖
    # ========================================
    Write-Host "[2/7] 检查依赖..." -ForegroundColor Blue

    function Get-CargoBinPath {
        if ($env:CARGO_HOME) {
            return (Join-Path $env:CARGO_HOME "bin")
        }
        return (Join-Path $env:USERPROFILE ".cargo\bin")
    }

    function Refresh-ProcessPath {
        $cargoBin = Get-CargoBinPath
        $pathValues = @(
            [Environment]::GetEnvironmentVariable("Path", "Process"),
            [Environment]::GetEnvironmentVariable("Path", "Machine"),
            [Environment]::GetEnvironmentVariable("Path", "User"),
            $cargoBin
        )

        $seen = @{}
        $segments = @()
        foreach ($pathValue in $pathValues) {
            if ([string]::IsNullOrWhiteSpace($pathValue)) { continue }
            foreach ($part in ($pathValue -split ';')) {
                $trimmed = $part.Trim()
                if ([string]::IsNullOrWhiteSpace($trimmed)) { continue }
                $key = $trimmed.TrimEnd('\').ToLowerInvariant()
                if (-not $seen.ContainsKey($key)) {
                    $seen[$key] = $true
                    $segments += $trimmed
                }
            }
        }

        $env:Path = ($segments -join ';')
    }

    function Test-Command {
        param([string]$Command, [string]$HelpUrl)
        Refresh-ProcessPath
        & cmd.exe /d /s /c "$Command >NUL 2>NUL"
        if ($LASTEXITCODE -eq 0) {
            return $true
        }
        Write-Host "  X - $Command 未安装" -ForegroundColor Red
        Write-Host "      请安装: $HelpUrl" -ForegroundColor Yellow
        return $false
    }

    Refresh-ProcessPath
    $depOk = $true
    if (-not (Test-Command "rustup --version" "https://rustup.rs")) { $depOk = $false }
    if (-not (Test-Command "npm --version" "https://nodejs.org")) { $depOk = $false }

    # Rust toolchain/components/target 必须与 rust-toolchain.toml 和 CI 对齐。
    if ($depOk) {
        try {
            & "$ProjectDir\scripts\ensure_rust_toolchain.ps1" -Targets @("x86_64-pc-windows-msvc")
        } catch {
            Write-Host "  Rust toolchain 准备失败: $_" -ForegroundColor Red
            $depOk = $false
        }
    }

    if ($depOk) {
        if (-not (Test-Command "rustc --version" "https://rustup.rs")) { $depOk = $false }
        if (-not (Test-Command "cargo --version" "https://rustup.rs")) { $depOk = $false }
    }

    if (-not $depOk) {
        throw "请先安装缺失的依赖"
    }

    # ========================================
    # 初始化 MSVC 编译环境 (link.exe / cl.exe)
    # ========================================
    if (-not (Get-Command link.exe -ErrorAction SilentlyContinue)) {
        Write-Host "[准备] 初始化 MSVC 编译环境..." -ForegroundColor Blue
        $vcFound = $false

        # Find vcvarsall.bat via vswhere
        $programFilesX86 = [Environment]::GetFolderPath("ProgramFilesX86")
        $vsWhere = Join-Path $programFilesX86 "Microsoft Visual Studio\Installer\vswhere.exe"
        if (Test-Path $vsWhere) {
            $vsPath = & $vsWhere -latest -products * -property installationPath 2>$null
            if ($vsPath) {
                $vcvarsall = Join-Path $vsPath "VC\Auxiliary\Build\vcvarsall.bat"
                if (Test-Path $vcvarsall) {
                    Write-Host "  找到: $vcvarsall" -ForegroundColor Cyan
                    # Import environment variables from vcvarsall into PowerShell
                    $tempFile = [System.IO.Path]::GetTempFileName()
                    cmd /c "`"$vcvarsall`" x64 > nul 2>&1 && set > `"$tempFile`""
                    Get-Content $tempFile | ForEach-Object {
                        if ($_ -match '^([^=]+)=(.*)$') {
                            [System.Environment]::SetEnvironmentVariable($Matches[1], $Matches[2], 'Process')
                        }
                    }
                    Remove-Item $tempFile -ErrorAction SilentlyContinue
                    $vcFound = $true
                    Write-Host "  OK - MSVC x64 环境已加载" -ForegroundColor Green
                }
            }
        }

        if (-not $vcFound) {
            Write-Host "  未找到 vcvarsall.bat，Rust 编译可能失败" -ForegroundColor Yellow
            Write-Host "  建议从 Developer PowerShell for VS 运行此脚本" -ForegroundColor Yellow
        }
        Write-Host ""
    }

    # The prepare owner is the only source of target/cache-specific native
    # prerequisites. Check before downloads, npm install, cleanup, or builds.
    Write-Host "  检查原生推理构建依赖..." -ForegroundColor Cyan
    & node "$ProjectDir\scripts\prepare-native-inference.mjs" "x86_64-pc-windows-msvc" --check-prerequisites
    if ($LASTEXITCODE -ne 0) {
        throw "原生推理构建依赖不完整，请按上方提示安装后重试"
    }
    Write-Host "  OK - 原生推理构建依赖检查完成" -ForegroundColor Green
    Write-Host ""

    # Setup and release builds share the same pinned runtime preparation.
    & "$ProjectDir\scripts\download_nodejs.ps1"

    $gitInstallerPath = "src-tauri\nsis\Git-Installer.exe"
    Write-Host "  检查 Git installer... " -NoNewline
    if (Test-Path $gitInstallerPath) {
        Write-Host "OK" -ForegroundColor Green
    } else {
        Write-Host "MISSING" -ForegroundColor Red
        Write-Host "    请先运行 .\setup_windows.ps1 下载 Git 安装包" -ForegroundColor Yellow
        $depOk = $false
    }

    # VC++ Runtime DLL (app-local deployment for bundled Node.js + native modules)
    $resDir = "src-tauri\resources"
    $vcDlls = @("vcruntime140.dll", "vcruntime140_1.dll")
    Write-Host "  检查 VC++ Runtime DLL... " -NoNewline
    $allPresent = $true
    foreach ($dll in $vcDlls) {
        if (-not (Test-Path (Join-Path $resDir $dll))) { $allPresent = $false; break }
    }
    if ($allPresent) {
        Write-Host "OK" -ForegroundColor Green
    } else {
        # Auto-extract from system if not present (dev machine always has MSVC)
        $systemDll = "$env:SystemRoot\System32\vcruntime140.dll"
        if (Test-Path $systemDll) {
            if (-not (Test-Path $resDir)) { New-Item -ItemType Directory -Path $resDir -Force | Out-Null }
            foreach ($dll in $vcDlls) {
                $src = "$env:SystemRoot\System32\$dll"
                if (Test-Path $src) {
                    Copy-Item $src (Join-Path $resDir $dll) -Force
                }
            }
            Write-Host "OK (auto-extracted)" -ForegroundColor Green
        } else {
            Write-Host "MISSING" -ForegroundColor Red
            Write-Host "    请先运行 .\setup_windows.ps1 提取 VC++ Runtime DLL" -ForegroundColor Yellow
            $depOk = $false
        }
    }

    if (-not $depOk) {
        throw "缺少构建必需文件，请运行 .\setup_windows.ps1"
    }

    Write-Host "  OK - 依赖检查通过" -ForegroundColor Green
    Write-Host ""

    # package.json/package-lock.json are the dependency authority; node_modules
    # is derived state and may be stale after switching branches. Keep the
    # release build self-contained by letting npm reconcile it before any Node
    # consumer runs. A current tree is a fast no-op.
    Write-Host "  对齐 Node.js 项目依赖..." -ForegroundColor Cyan
    & npm install --no-audit --no-fund
    if ($LASTEXITCODE -ne 0) {
        throw "Node.js 项目依赖安装失败"
    }
    Write-Host "  OK - Node.js 项目依赖已就绪" -ForegroundColor Green
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

    # 特殊验证: connect-src 指令必须包含 http://ipc.localhost (Windows Tauri IPC 关键)
    # connect-src 是管 fetch/XHR/WebSocket 的标准 CSP 指令；Windows Tauri IPC 走
    # Fetch API 打到 http://ipc.localhost，必须由 connect-src 放行。（旧版校验的
    # 是非标准指令 fetch-src——WebKit/WebView2 都忽略它、只在 console 报
    # "Unrecognized"，已从 CSP 移除；真正生效的一直是 connect-src。）
    if ($currentCsp -match "connect-src\s+([^;]+)") {
        $connectSrcDirective = $matches[1]
        if ($connectSrcDirective -notlike "*http://ipc.localhost*") {
            $missingParts += "connect-src 缺少 http://ipc.localhost (Windows 必需)"
        }
    } else {
        $missingParts += "connect-src 指令"
    }

    if ($missingParts.Count -gt 0) {
        Write-Host "  错误: CSP 配置不符合 Windows 要求:" -ForegroundColor Red
        $missingParts | ForEach-Object { Write-Host "    - $_" -ForegroundColor Red }
        Write-Host ""
        Write-Host "  Windows Tauri IPC 需要 connect-src 包含 http://ipc.localhost" -ForegroundColor Yellow
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
    $appProcesses = Get-Process | Where-Object { $_.ProcessName -eq "MyAgents" }

    if ($appProcesses) {
        $appProcesses | Stop-Process -Force -ErrorAction SilentlyContinue
        Write-Host "  清理了 $($appProcesses.Count) 个 MyAgents 进程" -ForegroundColor Gray
    }

    # 验证进程清理完成（最多等待 2 秒）
    $maxWait = 20  # 20 * 100ms = 2s
    $waited = 0
    while ($waited -lt $maxWait) {
        $remainingApp = Get-Process -Name "MyAgents" -ErrorAction SilentlyContinue
        if (-not $remainingApp) {
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
        & npm run typecheck
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

    # Sidecar / Bridge / CLI 三件套统一通过 npm scripts，由
    # `scripts/esbuild-bundle.mjs` 单一入口驱动。Driver 自带 target 生命周期职责：
    #   - cli: 构建前清理 staging，随后只产出 bundle authority myagents.cjs
    #   - server: 构建后校验产物不含硬编码 __dirname 路径
    # 实际上 tauri:build 的 beforeBuildCommand (tauri.conf.json) 也会
    # 跑同一组 npm 脚本——这里显式提前一步是为了 build 阶段提早暴露
    # 错误（避免等到 cargo 链接成功才发现 server-dist.js 有问题）。
    Write-Host "  打包 Sidecar / Bridge / CLI..." -ForegroundColor Cyan
    & npm run build:server
    if ($LASTEXITCODE -ne 0) { throw "服务端打包失败" }
    & npm run build:bridge
    if ($LASTEXITCODE -ne 0) { throw "Plugin Bridge 打包失败" }
    & npm run build:cli
    if ($LASTEXITCODE -ne 0) { throw "myagents CLI 打包失败" }
    Write-Host "    OK - Sidecar / Bridge / CLI 打包完成" -ForegroundColor Green

    # 填充 tsx-runtime（Plugin Bridge 走绝对路径 --import）—— Windows 当前
    # 仅 x64 构建；将来加 arm64 时把 --cpu 参数化。
    Write-Host "  填充 tsx-runtime (win32-x64)..." -ForegroundColor Cyan
    & npm run build:tsx-runtime -- win32 x64
    if ($LASTEXITCODE -ne 0) { throw "tsx-runtime 填充失败" }
    Write-Host "    OK - tsx-runtime 就绪" -ForegroundColor Green

    # 拷贝 Claude Agent SDK native binary（0.2.113+ 取代 cli.js 分发模式）
    # Windows 默认构建 x64；arm64 需另行处理（本脚本目前仅 x64）
    Write-Host "  拷贝 Claude native binary (win32-x64)..." -ForegroundColor Cyan
    $sdkTriple = "win32-x64"
    & "$ProjectDir\scripts\ensure_claude_sdk_package.ps1" -Arch x64
    if ($LASTEXITCODE -ne 0 -and $LASTEXITCODE -ne $null) { throw "Claude SDK win32-x64 校验失败" }
    $claudeSrc = Join-Path $ProjectDir "node_modules\@anthropic-ai\claude-agent-sdk-${sdkTriple}\claude.exe"
    $sdkDest = Join-Path $ProjectDir "src-tauri\resources\claude-agent-sdk"

    if (-not (Test-Path $claudeSrc)) {
        throw "Claude native binary 不存在: $claudeSrc — 请运行 npm install 安装 @anthropic-ai/claude-agent-sdk-$sdkTriple"
    }

    if (Test-Path $sdkDest) {
        Remove-Item -Recurse -Force $sdkDest
    }
    New-Item -ItemType Directory -Path $sdkDest -Force | Out-Null
    Copy-Item $claudeSrc (Join-Path $sdkDest "claude.exe") -Force
    Write-Host "    OK - Claude native binary 就绪 ($sdkTriple)" -ForegroundColor Green

    # 预装 sharp 图像处理（替代 jimp，libvips 原生）
    Write-Host "  预装 sharp 图像处理（libvips 原生）..." -ForegroundColor Cyan
    $sharpDir = Join-Path $ProjectDir "src-tauri\resources\sharp-runtime"
    if (Test-Path $sharpDir) {
        Remove-Item -Recurse -Force $sharpDir
    }
    New-Item -ItemType Directory -Path $sharpDir -Force | Out-Null
    $sharpPkgJson = @"
{
  "name": "sharp-runtime",
  "private": true,
  "version": "1.0.0",
  "dependencies": { "sharp": "0.34.5" }
}
"@
    Set-Content -Path (Join-Path $sharpDir "package.json") -Value $sharpPkgJson -Encoding utf8
    Push-Location $sharpDir
    & npm install --no-audit --no-fund --no-save --ignore-scripts
    Pop-Location
    if ($LASTEXITCODE -ne 0) {
        throw "sharp 主包预装失败"
    }
    # Windows 只装 x64 变体（arm64 Windows 用户少且 sharp 0.34 也支持，可按需扩展）
    $sharpWinArch = if ($Target -match "aarch64") { "arm64" } else { "x64" }
    Push-Location $sharpDir
    & npm install --no-save --force --no-audit --no-fund --ignore-scripts `
        "@img/sharp-win32-$sharpWinArch@0.34.5"
    Pop-Location
    if ($LASTEXITCODE -ne 0) {
        throw "sharp Windows 平台包安装失败"
    }
    $sharpNode = Join-Path $sharpDir "node_modules\@img\sharp-win32-$sharpWinArch\lib\sharp-win32-$sharpWinArch.node"
    if (-not (Test-Path $sharpNode)) {
        throw "sharp-win32-$sharpWinArch.node 缺失"
    }
    # 删除非 win32 变体（节省 NSIS 安装包大小）
    $imgDir = Join-Path $sharpDir "node_modules\@img"
    Get-ChildItem -Path $imgDir -Directory -ErrorAction SilentlyContinue |
        Where-Object { $_.Name -like "sharp-darwin*" -or $_.Name -like "sharp-linux*" -or $_.Name -like "sharp-libvips-darwin*" -or $_.Name -like "sharp-libvips-linux*" -or $_.Name -eq "sharp-wasm32" } |
        Remove-Item -Recurse -Force -ErrorAction SilentlyContinue
    Write-Host "    OK - sharp 预装完成 (win32-$sharpWinArch)" -ForegroundColor Green

    # 构建前端 (增加内存限制避免 OOM)
    Write-Host "  构建前端..." -ForegroundColor Cyan
    $env:NODE_OPTIONS = "--max-old-space-size=4096"
    & npm run build:web
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

    Write-Host "  准备离线文档与语音推理资源..." -ForegroundColor Cyan
    & node "$ProjectDir\scripts\prepare-native-inference.mjs" "x86_64-pc-windows-msvc"
    if ($LASTEXITCODE -ne 0) { throw "原生推理资源准备失败" }

    & npm run tauri:build -- --target x86_64-pc-windows-msvc --config src-tauri/tauri.windows.conf.json
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
        # Cargo package name is `myagents` (lowercase), so Tauri's main binary is
        # myagents.exe — NOT MyAgents.exe (that's only the productName / shortcut).
        # The old MyAgents.exe path worked by luck on case-insensitive NTFS; use the
        # real name so this stays correct on case-sensitive filesystems too.
        $exePath = "$targetDir\myagents.exe"

        if (Test-Path $exePath) {
            $portableDir = Join-Path $targetDir "portable"
            $zipName = "MyAgents_${Version}_x86_64-portable.zip"
            $zipPath = Join-Path $nsisDir $zipName

            if (Test-Path $portableDir) {
                Remove-Item -Recurse -Force $portableDir
            }
            New-Item -ItemType Directory -Path $portableDir -Force | Out-Null

            Copy-Item $exePath $portableDir -Force

            # Copy VC++ Runtime DLLs for portable version (app-local deployment)
            foreach ($dll in @("vcruntime140.dll", "vcruntime140_1.dll")) {
                $dllSrc = Join-Path "src-tauri\resources" $dll
                if (Test-Path $dllSrc) {
                    Copy-Item $dllSrc $portableDir -Force
                }
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
            Write-Host "  警告: 未找到 myagents.exe，跳过便携版创建" -ForegroundColor Yellow
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
if (-not $BuildSuccess) {
    exit 1
}

#!/usr/bin/env pwsh
# MyAgents Windows Dev 构建脚本
# 构建带 DevTools 的调试版本，启动时自动打开控制台
# 只构建 NSIS 安装包 (Debug 模式)

$ErrorActionPreference = "Stop"

$PROJECT_DIR = $PSScriptRoot

# 加载 .env 文件（如果存在）
$envFile = Join-Path $PROJECT_DIR ".env"
if (Test-Path $envFile) {
    Get-Content $envFile | ForEach-Object {
        if ($_ -match '^([^=]+)=(.*)$') {
            $key = $matches[1].Trim()
            $value = $matches[2].Trim()
            # 移除可能的引号
            $value = $value -replace '^["'']|["'']$', ''
            [System.Environment]::SetEnvironmentVariable($key, $value, "Process")
        }
    }
}

# 颜色输出函数
function Write-ColorOutput {
    param(
        [string]$Message,
        [string]$Color = "White"
    )
    Write-Host $Message -ForegroundColor $Color
}

Write-Host ""
Write-ColorOutput "╔═══════════════════════════════════════════════════════╗" "Cyan"
Write-ColorOutput "║  🤖 MyAgents Windows Dev 构建                         ║" "Cyan"
Write-ColorOutput "║  ⚠ DevTools 启用 + Debug 模式                        ║" "Cyan"
Write-ColorOutput "╚═══════════════════════════════════════════════════════╝" "Cyan"
Write-Host ""

# ========================================
# 版本同步检查
# ========================================
$packageJson = Get-Content (Join-Path $PROJECT_DIR "package.json") | ConvertFrom-Json
$PKG_VERSION = $packageJson.version

$tauriJson = Get-Content (Join-Path $PROJECT_DIR "src-tauri/tauri.conf.json") | ConvertFrom-Json
$TAURI_VERSION = $tauriJson.version

$cargoToml = Get-Content (Join-Path $PROJECT_DIR "src-tauri/Cargo.toml")
$CARGO_VERSION = ($cargoToml | Select-String 'version = "([^"]+)"' | Select-Object -First 1).Matches.Groups[1].Value

if ($PKG_VERSION -ne $TAURI_VERSION -or $PKG_VERSION -ne $CARGO_VERSION) {
    Write-ColorOutput "⚠ 版本号不一致:" "Yellow"
    Write-ColorOutput "  package.json:      $PKG_VERSION" "Cyan"
    Write-ColorOutput "  tauri.conf.json:   $TAURI_VERSION" "Cyan"
    Write-ColorOutput "  Cargo.toml:        $CARGO_VERSION" "Cyan"
    Write-Host ""
    $reply = Read-Host "是否同步版本号到 $PKG_VERSION? (y/N)"
    if ($reply -eq "y" -or $reply -eq "Y") {
        node (Join-Path $PROJECT_DIR "scripts/sync-version.js")
        Write-Host ""
    }
}

# 杀死残留进程（避免"旧代码"问题）
Write-ColorOutput "[准备] 杀死残留进程..." "Blue"

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

Write-ColorOutput "✓ 进程已清理" "Green"
Write-Host ""

# 清理旧构建（包括 Rust 缓存的 resources）
Write-ColorOutput "[准备] 清理旧构建..." "Blue"

# 清理构建输出目录
$dirsToClean = @(
    @{ Path = (Join-Path $PROJECT_DIR "dist"); Name = "前端构建输出" },
    @{ Path = (Join-Path $PROJECT_DIR "src-tauri/target/x86_64-pc-windows-msvc/debug/bundle"); Name = "Debug 打包输出" },
    @{ Path = (Join-Path $PROJECT_DIR "src-tauri/target/x86_64-pc-windows-msvc/debug/resources"); Name = "Debug resources 缓存" }
)

foreach ($dir in $dirsToClean) {
    if (Test-Path $dir.Path) {
        try {
            Remove-Item -Recurse -Force $dir.Path -ErrorAction Stop
            Write-Host "  已清理: $($dir.Name)" -ForegroundColor Gray
        } catch {
            Write-Host "  警告: 清理 $($dir.Name) 失败: $_" -ForegroundColor Yellow
            # 不抛出异常，继续构建
        }
    }
}

# 创建占位符资源 (关键: 满足 tauri build 需求，但 sidecar.rs 在 debug 模式下会忽略它们)
$resourcesDir = Join-Path $PROJECT_DIR "src-tauri/resources/claude-agent-sdk"
if (-not (Test-Path $resourcesDir)) {
    New-Item -ItemType Directory -Path $resourcesDir -Force | Out-Null
}
"// dev placeholder" | Out-File -FilePath (Join-Path $PROJECT_DIR "src-tauri/resources/server-dist.js") -Encoding UTF8

Write-ColorOutput "✓ 已清理并创建占位符" "Green"
Write-Host ""

# TypeScript 检查
Write-ColorOutput "[1/3] TypeScript 类型检查..." "Blue"
Set-Location $PROJECT_DIR
$typecheckResult = & bun run typecheck
if ($LASTEXITCODE -ne 0) {
    Write-ColorOutput "✗ TypeScript 检查失败，请修复后重试" "Red"
    exit 1
}
Write-ColorOutput "✓ TypeScript 检查通过" "Green"
Write-Host ""

# 构建前端
Write-ColorOutput "[2/3] 构建前端..." "Blue"
$env:VITE_DEBUG_MODE = "true"
Write-ColorOutput "  VITE_DEBUG_MODE=$env:VITE_DEBUG_MODE" "Yellow"
& bun run build:web
if ($LASTEXITCODE -ne 0) {
    Write-ColorOutput "✗ 前端构建失败" "Red"
    exit 1
}
Write-ColorOutput "✓ 前端构建完成" "Green"
Write-Host ""

# 强制触发 Rust 重新编译 (确保 sidecar.rs 的逻辑修改生效)
$sidecarFile = Join-Path $PROJECT_DIR "src-tauri/src/sidecar.rs"
$mainFile = Join-Path $PROJECT_DIR "src-tauri/src/main.rs"
(Get-Date).ToString() | Out-File -FilePath $sidecarFile -Append -Encoding UTF8
(Get-Date).ToString() | Out-File -FilePath $mainFile -Append -Encoding UTF8

# 构建 Tauri 应用
Write-ColorOutput "[3/3] 构建 Tauri 应用 (Debug 模式, NSIS)..." "Blue"

# 强制移除旧的可执行文件，防止 cargo 偷懒不重新链接
$oldExe = Join-Path $PROJECT_DIR "src-tauri/target/x86_64-pc-windows-msvc/debug/myagents.exe"
if (Test-Path $oldExe) {
    Remove-Item $oldExe -Force
}

# 如果没有设置 TAURI_SIGNING_PRIVATE_KEY，跳过签名错误
# (App 本身会正常构建，只是 updater 签名会失败)
if (-not $env:TAURI_SIGNING_PRIVATE_KEY) {
    Write-ColorOutput "⚠ 未设置 TAURI_SIGNING_PRIVATE_KEY，更新签名将被跳过" "Yellow"
}

Write-ColorOutput "这可能需要几分钟..." "Yellow"

# 使用 --target 指定架构，确保构建正确的版本
try {
    & bun run tauri:build -- --debug --bundles nsis --target x86_64-pc-windows-msvc
    if ($LASTEXITCODE -ne 0 -and $env:TAURI_SIGNING_PRIVATE_KEY) {
        throw "Tauri build failed"
    }
} catch {
    if (-not $env:TAURI_SIGNING_PRIVATE_KEY) {
        Write-ColorOutput "⚠ 构建完成（签名跳过）" "Yellow"
    } else {
        throw
    }
}

# 查找输出
$BUNDLE_DIR = Join-Path $PROJECT_DIR "src-tauri/target/x86_64-pc-windows-msvc/debug/bundle/nsis"
$SETUP_EXE = Get-ChildItem -Path $BUNDLE_DIR -Filter "*-setup.exe" -ErrorAction SilentlyContinue | Select-Object -First 1

Write-Host ""
Write-ColorOutput "═══════════════════════════════════════════════════════" "Green"
Write-ColorOutput "  Dev 构建完成!" "Green"
Write-ColorOutput "═══════════════════════════════════════════════════════" "Green"
Write-Host ""

if ($SETUP_EXE) {
    $APP_SIZE = "{0:N2} MB" -f ($SETUP_EXE.Length / 1MB)
    Write-ColorOutput "  应用路径:" "Cyan"
    Write-Host "    🪟 $($SETUP_EXE.FullName)"
    Write-ColorOutput "    📏 大小: $APP_SIZE" "White"
    Write-Host ""
    Write-ColorOutput "  Dev 特性:" "Cyan"
    Write-ColorOutput "    ✅ 启动时自动打开 DevTools" "White"
    Write-ColorOutput "    ✅ 宽松 CSP (允许 IPC)" "White"
    Write-ColorOutput "    ✅ 包含最新 server 代码" "White"
    Write-Host ""
} else {
    Write-ColorOutput "  未找到构建产物，请检查上方输出" "Yellow"
    Write-ColorOutput "  预期路径: $BUNDLE_DIR" "Yellow"
}

Write-ColorOutput "  运行方式:" "Cyan"
if ($SETUP_EXE) {
    Write-Host "    1. 安装: .\$($SETUP_EXE.Name)"
    Write-Host "    2. 或直接运行安装包测试"
} else {
    Write-Host "    (构建失败，无可用安装包)"
}
Write-Host ""

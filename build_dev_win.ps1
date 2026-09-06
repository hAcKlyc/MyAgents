#!/usr/bin/env pwsh
# MyAgents Windows Dev 构建脚本
# 构建带 DevTools 的调试版本，启动时自动打开控制台
# 默认只构建可直接运行的 Debug exe（不打安装包，便于快速测试）
# 如需验证安装器，可传入 -BundleNsis 构建 Debug NSIS 安装包。

param(
    [switch]$BundleNsis
)

$ErrorActionPreference = "Stop"

$PROJECT_DIR = $PSScriptRoot
$BUILD_MODE_LABEL = if ($BundleNsis) { "Debug NSIS 安装包" } else { "快速 Debug exe（不打安装包）" }

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
Write-ColorOutput "║  ⚠ DevTools 启用 + $BUILD_MODE_LABEL                 ║" "Cyan"
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

# Establish the pinned Rust identity, then ask the native owner for the exact
# target/cache-aware prerequisites before stopping processes or cleaning output.
Write-ColorOutput "[准备] 准备 Rust toolchain / components / Windows target..." "Blue"
try {
    & "$PROJECT_DIR\scripts\ensure_rust_toolchain.ps1" -Targets @("x86_64-pc-windows-msvc")
} catch {
    Write-ColorOutput "✗ Rust toolchain 准备失败: $_" "Red"
    exit 1
}
Write-ColorOutput "✓ Rust toolchain ready" "Green"
Write-Host ""

Write-ColorOutput "[准备] 检查原生推理构建依赖 (x86_64-pc-windows-msvc)..." "Blue"
& node "$PROJECT_DIR\scripts\prepare-native-inference.mjs" "x86_64-pc-windows-msvc" --check-prerequisites
if ($LASTEXITCODE -ne 0) {
    Write-ColorOutput "✗ 原生推理构建依赖不完整，请按上方提示安装后重试" "Red"
    exit 1
}
Write-ColorOutput "✓ 原生推理构建依赖检查完成" "Green"
Write-Host ""

# 杀死残留进程（避免"旧代码"问题）
Write-ColorOutput "[准备] 杀死残留进程..." "Blue"

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

Write-ColorOutput "✓ 进程已清理" "Green"
Write-Host ""

# 清理旧构建（包括 Rust 缓存的 resources）
Write-ColorOutput "[准备] 清理旧构建..." "Blue"

# 清理构建输出目录
$dirsToClean = @(
    @{ Path = (Join-Path $PROJECT_DIR "dist"); Name = "前端构建输出" },
    @{ Path = (Join-Path $PROJECT_DIR "src-tauri/target/x86_64-pc-windows-msvc/debug/resources"); Name = "Debug resources 缓存" }
)
if ($BundleNsis) {
    $dirsToClean += @{ Path = (Join-Path $PROJECT_DIR "src-tauri/target/x86_64-pc-windows-msvc/debug/bundle"); Name = "Debug 打包输出" }
}

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

# Prepare the same pinned Node/npm pair as setup and release builds.
& "$PROJECT_DIR\scripts\download_nodejs.ps1"

# 创建占位符资源目录（满足 Tauri bundle 阶段的资源校验）。
# server-dist.js / plugin-bridge-dist.mjs / cli/myagents.cjs 在下面的
# [2/3] 步骤显式生成；Tauri build 阶段会禁掉 beforeBuildCommand，避免重复打包。
#   - claude-agent-sdk/ : SDK native binary 占位目录
#   - sharp-runtime/ : sharp 在 dev 走 walk-up 加载，目录只是 bundler 的资源指针
#   - cli/ : 仅占位，CLI bundle 由 esbuild-bundle.mjs 的 post-build hook 写入
foreach ($subdir in @("claude-agent-sdk", "sharp-runtime", "tsx-runtime", "cli")) {
    $d = Join-Path $PROJECT_DIR "src-tauri/resources/$subdir"
    if (-not (Test-Path $d)) {
        New-Item -ItemType Directory -Path $d -Force | Out-Null
    }
}
$sharpPlaceholder = Join-Path $PROJECT_DIR "src-tauri/resources/sharp-runtime/.dev-placeholder"
if (-not (Test-Path $sharpPlaceholder)) {
    "dev mode: sharp loads from top-level node_modules/sharp; this dir is prod-only" | Out-File -FilePath $sharpPlaceholder -Encoding UTF8
}
$tsxPlaceholder = Join-Path $PROJECT_DIR "src-tauri/resources/tsx-runtime/.dev-placeholder"
if (-not (Test-Path $tsxPlaceholder)) {
    "dev mode: tsx loads from top-level node_modules/tsx via find_tsx_runtime_loader fallback" | Out-File -FilePath $tsxPlaceholder -Encoding UTF8
}

# VC++ Runtime DLL 占位符（满足 tauri.windows.conf.json 资源校验）
foreach ($dll in @("vcruntime140.dll", "vcruntime140_1.dll")) {
    $dllPath = Join-Path $PROJECT_DIR "src-tauri/resources/$dll"
    if (-not (Test-Path $dllPath)) {
        $systemDll = "$env:SystemRoot\System32\$dll"
        if (Test-Path $systemDll) {
            Copy-Item $systemDll $dllPath -Force
        } else {
            "placeholder" | Out-File -FilePath $dllPath -Encoding UTF8
        }
    }
}

Write-ColorOutput "✓ 已清理并创建占位符" "Green"
Write-Host ""

# package.json/package-lock.json are the dependency authority; node_modules
# is derived state and may be stale after switching branches. Keep the dev
# build self-contained by reconciling it before any Node consumer runs.
Write-ColorOutput "[准备] 对齐 Node.js 项目依赖..." "Blue"
& npm install --no-audit --no-fund
if ($LASTEXITCODE -ne 0) {
    Write-ColorOutput "✗ Node.js 项目依赖安装失败" "Red"
    exit 1
}
Write-ColorOutput "✓ Node.js 项目依赖已就绪" "Green"
Write-Host ""

# Prepare the same target-locked document Worker/OCR/PDFium projection used by
# release builds. The prepare owner is fingerprinted, so a warm invocation is
# an offline no-op instead of repeating downloads, extraction, or signing.
Write-ColorOutput "[准备] 准备离线文档与语音推理资源 (x86_64-pc-windows-msvc)..." "Blue"
& node "$PROJECT_DIR\scripts\prepare-cuse-bundle.mjs" "x86_64-pc-windows-msvc"
if ($LASTEXITCODE -ne 0) { throw "Cuse Skill+CLI preparation failed" }
& node "$PROJECT_DIR\scripts\prepare-native-inference.mjs" "x86_64-pc-windows-msvc"
if ($LASTEXITCODE -ne 0) {
    Write-ColorOutput "✗ 原生推理资源准备失败" "Red"
    exit 1
}
Write-ColorOutput "✓ 原生推理资源 ready" "Green"
Write-Host ""

# TypeScript 检查
Write-ColorOutput "[1/3] TypeScript 类型检查..." "Blue"
Set-Location $PROJECT_DIR
$typecheckResult = & npm run typecheck
if ($LASTEXITCODE -ne 0) {
    Write-ColorOutput "✗ TypeScript 检查失败，请修复后重试" "Red"
    exit 1
}
Write-ColorOutput "✓ TypeScript 检查通过" "Green"
Write-Host ""

# 构建前端和运行时资源
Write-ColorOutput "[2/3] 构建前端和运行时资源..." "Blue"
$env:VITE_DEBUG_MODE = "true"
Write-ColorOutput "  VITE_DEBUG_MODE=$env:VITE_DEBUG_MODE" "Yellow"
$nodeOptionsWithoutHeap = (($env:NODE_OPTIONS -replace '(^|\s)--max-old-space-size=\S+', '').Trim())
$env:NODE_OPTIONS = if ([string]::IsNullOrWhiteSpace($nodeOptionsWithoutHeap)) {
    "--max-old-space-size=4096"
} else {
    "$nodeOptionsWithoutHeap --max-old-space-size=4096"
}
Write-ColorOutput "  NODE_OPTIONS=$env:NODE_OPTIONS" "Yellow"
& npm run build:web
if ($LASTEXITCODE -ne 0) {
    Write-ColorOutput "✗ 前端构建失败" "Red"
    exit 1
}
& npm run build:server
if ($LASTEXITCODE -ne 0) {
    Write-ColorOutput "✗ Sidecar 打包失败" "Red"
    exit 1
}
& npm run build:bridge
if ($LASTEXITCODE -ne 0) {
    Write-ColorOutput "✗ Plugin Bridge 打包失败" "Red"
    exit 1
}
& npm run build:cli
if ($LASTEXITCODE -ne 0) {
    Write-ColorOutput "✗ myagents CLI 打包失败" "Red"
    exit 1
}
Write-ColorOutput "✓ 前端和运行时资源构建完成" "Green"
Write-Host ""

# 下面会用临时 Tauri config 把 beforeBuildCommand 置空，避免 Tauri build
# 再重复执行 build:web/server/bridge/cli。dev 脚本自己已经完成这些步骤。

# 强制触发 Rust 重新编译 (确保 sidecar.rs 的逻辑修改生效)
# build_dev.sh 用 `touch` 只更新 mtime；旧版本这里写的是
# `(Get-Date) | Out-File -Append`，把时间戳直接 *append 到源码文件内容*，
# 每次 dev build 都给 sidecar.rs / main.rs 屁股加一行垃圾，污染 git 工作区。
# PS 没有 touch，但等价做法是改 LastWriteTime 属性。
$sidecarFile = Join-Path $PROJECT_DIR "src-tauri/src/sidecar.rs"
$mainFile = Join-Path $PROJECT_DIR "src-tauri/src/main.rs"
(Get-Item $sidecarFile).LastWriteTime = Get-Date
(Get-Item $mainFile).LastWriteTime = Get-Date

# 构建 Tauri 应用
Write-ColorOutput "[3/3] 构建 Tauri 应用 ($BUILD_MODE_LABEL)..." "Blue"

# 强制移除旧的可执行文件，防止 cargo 偷懒不重新链接
$oldExe = Join-Path $PROJECT_DIR "src-tauri/target/x86_64-pc-windows-msvc/debug/myagents.exe"
if (Test-Path $oldExe) {
    Remove-Item $oldExe -Force
}

Write-ColorOutput "这可能需要几分钟..." "Yellow"

$fastConfig = Join-Path $env:TEMP "myagents-tauri-dev-fast-$PID.json"
$fastConfigJson = @'
{
  "build": {
    "beforeBuildCommand": null
  },
  "bundle": {
    "createUpdaterArtifacts": false
  }
}
'@
[System.IO.File]::WriteAllText(
    $fastConfig,
    $fastConfigJson,
    [System.Text.UTF8Encoding]::new($false)
)

try {
    if ($BundleNsis) {
        & npm run tauri:build -- --debug --bundles nsis --target x86_64-pc-windows-msvc --config src-tauri/tauri.windows.conf.json --config $fastConfig
        if ($LASTEXITCODE -ne 0) {
            throw "Tauri build failed"
        }
    } else {
        & npm run tauri:build -- --debug --no-bundle --target x86_64-pc-windows-msvc --config src-tauri/tauri.windows.conf.json --config $fastConfig
        if ($LASTEXITCODE -ne 0) {
            throw "Tauri build failed"
        }
    }
} finally {
    Remove-Item $fastConfig -Force -ErrorAction SilentlyContinue
}

# 查找输出
$DEBUG_DIR = Join-Path $PROJECT_DIR "src-tauri/target/x86_64-pc-windows-msvc/debug"
$EXE_PATH = Join-Path $DEBUG_DIR "myagents.exe"
$BUNDLE_DIR = Join-Path $DEBUG_DIR "bundle/nsis"
$SETUP_EXE = if ($BundleNsis) {
    Get-ChildItem -Path $BUNDLE_DIR -Filter "*-setup.exe" -ErrorAction SilentlyContinue | Select-Object -First 1
} else {
    $null
}

Write-Host ""
Write-ColorOutput "═══════════════════════════════════════════════════════" "Green"
Write-ColorOutput "  Dev 构建完成!" "Green"
Write-ColorOutput "═══════════════════════════════════════════════════════" "Green"
Write-Host ""

if (-not $BundleNsis -and (Test-Path $EXE_PATH)) {
    $APP_SIZE = "{0:N2} MB" -f ((Get-Item $EXE_PATH).Length / 1MB)
    Write-ColorOutput "  应用路径:" "Cyan"
    Write-Host "    🪟 $EXE_PATH"
    Write-ColorOutput "    📏 大小: $APP_SIZE" "White"
    Write-Host ""
    Write-ColorOutput "  Dev 特性:" "Cyan"
    Write-ColorOutput "    ✅ 启动时自动打开 DevTools" "White"
    Write-ColorOutput "    ✅ 宽松 CSP (允许 IPC)" "White"
    Write-ColorOutput "    ✅ 不打 NSIS，适合快速功能验证" "White"
    Write-Host ""
} elseif ($BundleNsis -and $SETUP_EXE) {
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
    if ($BundleNsis) {
        Write-ColorOutput "  预期路径: $BUNDLE_DIR" "Yellow"
    } else {
        Write-ColorOutput "  预期路径: $EXE_PATH" "Yellow"
    }
}

Write-ColorOutput "  运行方式:" "Cyan"
if (-not $BundleNsis -and (Test-Path $EXE_PATH)) {
    Write-Host "    & `"$EXE_PATH`""
    Write-Host "    如需测试安装器: .\build_dev_win.ps1 -BundleNsis"
} elseif ($BundleNsis -and $SETUP_EXE) {
    Write-Host "    1. 安装: .\$($SETUP_EXE.Name)"
    Write-Host "    2. 或直接运行安装包测试"
} else {
    Write-Host "    (构建失败，无可用安装包)"
}
Write-Host ""

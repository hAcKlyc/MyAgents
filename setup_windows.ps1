# MyAgents Windows 开发环境初始化脚本
# 首次 clone 仓库后运行此脚本
# PowerShell 7+ 推荐

$ErrorActionPreference = "Stop"

$ProjectDir = Split-Path -Parent $MyInvocation.MyCommand.Path
Set-Location $ProjectDir

# Bun 版本配置
$BunVersion = "1.3.6"

Write-Host ""
Write-Host "=========================================" -ForegroundColor Blue
Write-Host "  MyAgents Windows 开发环境初始化" -ForegroundColor Green
Write-Host "=========================================" -ForegroundColor Blue
Write-Host ""

# 检查依赖函数
function Test-Dependency {
    param(
        [string]$Name,
        [string]$Command,
        [string]$InstallHint
    )

    Write-Host "  检查 $Name... " -NoNewline
    try {
        # 使用 Invoke-Expression 安全执行命令字符串
        $null = Invoke-Expression $Command 2>&1
        if ($LASTEXITCODE -eq 0 -or $?) {
            Write-Host "[OK]" -ForegroundColor Green
            return $true
        }
    }
    catch {}

    Write-Host "[X]" -ForegroundColor Red
    Write-Host "    请安装: $InstallHint" -ForegroundColor Yellow
    return $false
}

# 下载 Bun 二进制
function Get-BunBinary {
    $BinariesDir = Join-Path $ProjectDir "src-tauri\binaries"
    if (-not (Test-Path $BinariesDir)) {
        New-Item -ItemType Directory -Path $BinariesDir -Force | Out-Null
    }

    Write-Host "下载 Bun 运行时 (v$BunVersion)..." -ForegroundColor Blue

    # Windows x64
    $WinFile = Join-Path $BinariesDir "bun-x86_64-pc-windows-msvc.exe"
    if (-not (Test-Path $WinFile)) {
        Write-Host "  下载 Windows x64 版本..." -ForegroundColor Cyan
        $TempZip = Join-Path $env:TEMP "bun-windows.zip"
        $TempDir = Join-Path $env:TEMP "bun-windows-extract"

        try {
            # 下载
            $DownloadUrl = "https://github.com/oven-sh/bun/releases/download/bun-v$BunVersion/bun-windows-x64.zip"
            Invoke-WebRequest -Uri $DownloadUrl -OutFile $TempZip -UseBasicParsing

            # 解压
            if (Test-Path $TempDir) {
                Remove-Item -Recurse -Force $TempDir
            }
            Expand-Archive -Path $TempZip -DestinationPath $TempDir -Force

            # 移动文件
            $ExtractedBun = Join-Path $TempDir "bun-windows-x64\bun.exe"
            if (Test-Path $ExtractedBun) {
                Copy-Item -Path $ExtractedBun -Destination $WinFile -Force
                Write-Host "  [OK] Windows x64" -ForegroundColor Green
            }
            else {
                throw "解压后找不到 bun.exe"
            }
        }
        finally {
            # 清理临时文件
            if (Test-Path $TempZip) { Remove-Item -Force $TempZip }
            if (Test-Path $TempDir) { Remove-Item -Recurse -Force $TempDir }
        }
    }
    else {
        Write-Host "  [OK] Windows x64 (已存在)" -ForegroundColor Green
    }

    Write-Host "[OK] Bun 运行时准备完成" -ForegroundColor Green
}

# 检查 MSVC 工具链
function Test-MSVC {
    Write-Host "  检查 MSVC Build Tools... " -NoNewline

    # 检查 cl.exe 是否在 PATH 中
    $cl = Get-Command cl.exe -ErrorAction SilentlyContinue
    if ($cl) {
        Write-Host "[OK]" -ForegroundColor Green
        return $true
    }

    # 检查 Visual Studio 安装目录
    $vsWhere = "${env:ProgramFiles(x86)}\Microsoft Visual Studio\Installer\vswhere.exe"
    if (Test-Path $vsWhere) {
        $vsPath = & $vsWhere -latest -property installationPath 2>$null
        if ($vsPath) {
            Write-Host "[OK] (VS: $vsPath)" -ForegroundColor Green
            return $true
        }
    }

    Write-Host "[X]" -ForegroundColor Red
    Write-Host "    请安装 Visual Studio Build Tools:" -ForegroundColor Yellow
    Write-Host "    https://visualstudio.microsoft.com/visual-cpp-build-tools/" -ForegroundColor Yellow
    Write-Host "    安装时选择 'Desktop development with C++' 工作负载" -ForegroundColor Yellow
    return $false
}

# ========== 开始初始化 ==========

Write-Host "[1/5] 检查依赖" -ForegroundColor Blue
$Missing = $false

if (-not (Test-Dependency "Node.js" "node --version" "https://nodejs.org")) { $Missing = $true }
if (-not (Test-Dependency "npm" "npm --version" "随 Node.js 安装")) { $Missing = $true }
if (-not (Test-Dependency "Bun" "bun --version" "https://bun.sh/docs/installation")) { $Missing = $true }
if (-not (Test-Dependency "Rust" "rustc --version" "https://rustup.rs")) { $Missing = $true }
if (-not (Test-Dependency "Cargo" "cargo --version" "随 Rust 安装")) { $Missing = $true }
if (-not (Test-MSVC)) { $Missing = $true }

Write-Host ""
if ($Missing) {
    Write-Host "请先安装上述缺失的依赖，然后重新运行此脚本" -ForegroundColor Red
    Write-Host "注意: Bun 在最终用户运行时无需安装，已打包到应用内" -ForegroundColor Yellow
    exit 1
}

# 下载 Bun 二进制
Write-Host ""
Write-Host "[2/5] 下载 Bun 运行时" -ForegroundColor Blue
Get-BunBinary
Write-Host ""

# 安装前端依赖
Write-Host "[3/5] 安装前端依赖" -ForegroundColor Blue
& bun install
if ($LASTEXITCODE -ne 0) {
    Write-Host "前端依赖安装失败" -ForegroundColor Red
    exit 1
}
Write-Host "[OK] 前端依赖安装完成" -ForegroundColor Green
Write-Host ""

# 安装 Rust 依赖
Write-Host "[4/5] 检查 Rust 依赖" -ForegroundColor Blue
Set-Location (Join-Path $ProjectDir "src-tauri")
& cargo check --quiet 2>$null
if ($LASTEXITCODE -ne 0) {
    & cargo fetch
}
Set-Location $ProjectDir
Write-Host "[OK] Rust 依赖准备完成" -ForegroundColor Green
Write-Host ""

# 完成
Write-Host "[5/5] 初始化完成!" -ForegroundColor Blue
Write-Host ""
Write-Host "=========================================" -ForegroundColor Green
Write-Host "  开发环境准备就绪!" -ForegroundColor Green
Write-Host "=========================================" -ForegroundColor Green
Write-Host ""
Write-Host "  后续步骤:"
Write-Host ""
Write-Host "  运行 Tauri 应用:" -ForegroundColor Blue
Write-Host "    npm run tauri:dev"
Write-Host ""
Write-Host "  构建 Windows 安装包:" -ForegroundColor Blue
Write-Host "    .\build_windows.ps1"
Write-Host ""

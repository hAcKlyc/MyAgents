<#
.SYNOPSIS
    MyAgents Windows 开发环境初始化脚本
.DESCRIPTION
    首次 clone 仓库后运行此脚本
#>

$ErrorActionPreference = "Stop"

try {
    $ProjectDir = Split-Path -Parent $MyInvocation.MyCommand.Path
    Set-Location $ProjectDir

    $BunVersion = "1.3.6"

    Write-Host "`n=========================================" -ForegroundColor Blue
    Write-Host "  MyAgents Windows 开发环境初始化" -ForegroundColor Green
    Write-Host "=========================================`n" -ForegroundColor Blue

    function Test-Dependency {
        param($Name, $Command, $InstallHint)
        Write-Host "  检查 $Name... " -NoNewline
        try {
            Invoke-Expression $Command 2>&1 | Out-Null
            if ($LASTEXITCODE -eq 0 -or $?) {
                Write-Host "OK" -ForegroundColor Green
                return $true
            }
        } catch { }
        Write-Host "MISSING" -ForegroundColor Red
        Write-Host "    请安装: $InstallHint" -ForegroundColor Yellow
        return $false
    }

    function Get-BunBinary {
        $BinariesDir = Join-Path $ProjectDir "src-tauri\binaries"
        if (-not (Test-Path $BinariesDir)) {
            New-Item -ItemType Directory -Path $BinariesDir -Force | Out-Null
        }

        Write-Host "下载 Bun 运行时 (v$BunVersion)..." -ForegroundColor Blue

        $WinFile = Join-Path $BinariesDir "bun-x86_64-pc-windows-msvc.exe"
        if (-not (Test-Path $WinFile)) {
            Write-Host "  下载 Windows x64 版本..." -ForegroundColor Cyan
            $TempZip = Join-Path $env:TEMP "bun-windows.zip"
            $TempDir = Join-Path $env:TEMP "bun-windows-extract"

            try {
                $DownloadUrl = "https://github.com/oven-sh/bun/releases/download/bun-v$BunVersion/bun-windows-x64.zip"
                Invoke-WebRequest -Uri $DownloadUrl -OutFile $TempZip -UseBasicParsing

                if (Test-Path $TempDir) { Remove-Item -Recurse -Force $TempDir }
                Expand-Archive -Path $TempZip -DestinationPath $TempDir -Force

                $ExtractedBun = Join-Path $TempDir "bun-windows-x64\bun.exe"
                if (Test-Path $ExtractedBun) {
                    Copy-Item -Path $ExtractedBun -Destination $WinFile -Force
                    Write-Host "  OK - Windows x64" -ForegroundColor Green
                } else {
                    throw "bun.exe not found after extraction"
                }
            } finally {
                if (Test-Path $TempZip) { Remove-Item -Force $TempZip }
                if (Test-Path $TempDir) { Remove-Item -Recurse -Force $TempDir }
            }
        } else {
            Write-Host "  OK - Windows x64 (already exists)" -ForegroundColor Green
        }
        Write-Host "OK - Bun runtime ready" -ForegroundColor Green
    }

    function Test-MSVC {
        Write-Host "  检查 MSVC Build Tools... " -NoNewline

        $cl = Get-Command cl.exe -ErrorAction SilentlyContinue
        if ($cl) {
            Write-Host "OK" -ForegroundColor Green
            return $true
        }

        $programFilesX86 = [Environment]::GetFolderPath("ProgramFilesX86")
        $vsWhere = Join-Path $programFilesX86 "Microsoft Visual Studio\Installer\vswhere.exe"
        if (Test-Path $vsWhere) {
            $vsPath = & $vsWhere -latest -property installationPath 2>$null
            if ($vsPath) {
                Write-Host "OK" -ForegroundColor Green
                return $true
            }
        }

        Write-Host "MISSING" -ForegroundColor Red
        Write-Host "    请安装 Visual Studio Build Tools" -ForegroundColor Yellow
        return $false
    }

    # Main
    Write-Host "Step 1/5: 检查依赖" -ForegroundColor Blue
    $Missing = $false

    if (-not (Test-Dependency "Node.js" "node --version" "https://nodejs.org")) { $Missing = $true }
    if (-not (Test-Dependency "npm" "npm --version" "with Node.js")) { $Missing = $true }
    if (-not (Test-Dependency "Bun" "bun --version" "https://bun.sh")) { $Missing = $true }
    if (-not (Test-Dependency "Rust" "rustc --version" "https://rustup.rs")) { $Missing = $true }
    if (-not (Test-Dependency "Cargo" "cargo --version" "with Rust")) { $Missing = $true }
    if (-not (Test-MSVC)) { $Missing = $true }

    if ($Missing) {
        Write-Host "`n请先安装缺失的依赖" -ForegroundColor Red
        Write-Host "`n按回车键退出..." -ForegroundColor Yellow
        Read-Host
        exit 1
    }

    Write-Host "`nStep 2/5: 下载 Bun 运行时" -ForegroundColor Blue
    Get-BunBinary

    Write-Host "`nStep 3/5: 安装前端依赖" -ForegroundColor Blue
    & bun install
    if ($LASTEXITCODE -ne 0) {
        Write-Host "前端依赖安装失败" -ForegroundColor Red
        Write-Host "`n按回车键退出..." -ForegroundColor Yellow
        Read-Host
        exit 1
    }
    Write-Host "OK - 前端依赖安装完成" -ForegroundColor Green

    Write-Host "`nStep 4/5: 下载 Rust 依赖" -ForegroundColor Blue
    Write-Host "  正在下载 Rust 依赖包，请稍候..." -ForegroundColor Cyan
    Push-Location (Join-Path $ProjectDir "src-tauri")
    & cargo fetch
    if ($LASTEXITCODE -ne 0) {
        Write-Host "  Rust 依赖下载失败" -ForegroundColor Red
        Pop-Location
        Write-Host "`n按回车键退出..." -ForegroundColor Yellow
        Read-Host
        exit 1
    }
    Pop-Location
    Write-Host "OK - Rust 依赖下载完成" -ForegroundColor Green

    Write-Host "`nStep 5/5: 初始化完成!" -ForegroundColor Blue
    Write-Host "`n=========================================" -ForegroundColor Green
    Write-Host "  开发环境准备就绪!" -ForegroundColor Green
    Write-Host "=========================================`n" -ForegroundColor Green
    Write-Host "后续步骤:"
    Write-Host "  npm run tauri:dev      - 运行开发版"
    Write-Host "  .\build_windows.ps1    - 构建安装包`n"

} catch {
    Write-Host "`n=========================================" -ForegroundColor Red
    Write-Host "  发生错误!" -ForegroundColor Red
    Write-Host "=========================================`n" -ForegroundColor Red
    Write-Host "错误信息: $_" -ForegroundColor Red
    Write-Host "位置: $($_.InvocationInfo.PositionMessage)" -ForegroundColor Yellow
}

Write-Host "`n按回车键退出..." -ForegroundColor Cyan
Read-Host

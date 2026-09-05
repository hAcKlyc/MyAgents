<#
.SYNOPSIS
    MyAgents Windows 开发环境初始化脚本
.DESCRIPTION
    首次 clone 仓库后运行此脚本
#>

$ErrorActionPreference = "Stop"
$PSNativeCommandUseErrorActionPreference = $false

try {
    $ProjectDir = Split-Path -Parent $MyInvocation.MyCommand.Path
    Set-Location $ProjectDir

    Write-Host "`n=========================================" -ForegroundColor Blue
    Write-Host "  MyAgents Windows 开发环境初始化" -ForegroundColor Green
    Write-Host "=========================================`n" -ForegroundColor Blue

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

    function Resolve-ToolPath {
        param([string]$Name)
        Refresh-ProcessPath
        $cmd = Get-Command $Name -ErrorAction SilentlyContinue
        if ($cmd) {
            return $cmd.Source
        }
        $cargoBin = Get-CargoBinPath
        $exeName = if ($Name.EndsWith(".exe")) { $Name } else { "$Name.exe" }
        $fallback = Join-Path $cargoBin $exeName
        if (Test-Path $fallback) {
            return $fallback
        }
        return $null
    }

    function Test-Dependency {
        param($Name, $Command, $InstallHint)
        Refresh-ProcessPath
        Write-Host "  检查 $Name... " -NoNewline
        & cmd.exe /d /s /c "$Command >NUL 2>NUL"
        if ($LASTEXITCODE -eq 0) {
            Write-Host "OK" -ForegroundColor Green
            return $true
        }
        Write-Host "MISSING" -ForegroundColor Red
        return $false
    }

    function Install-WithWinget {
        param($Name, $WingetId, $ExtraArgs)
        Write-Host "  自动安装 $Name..." -ForegroundColor Cyan
        $cmd = "winget install --id $WingetId -e --accept-source-agreements --accept-package-agreements"
        if ($ExtraArgs) { $cmd += " $ExtraArgs" }
        Invoke-Expression $cmd
        # winget exit codes: 0=success, -1978335189=already installed/no upgrade
        if ($LASTEXITCODE -ne 0 -and $LASTEXITCODE -ne -1978335189) {
            Write-Host "  $Name 安装失败，请手动安装: winget install $WingetId" -ForegroundColor Red
            return $false
        }
        Write-Host "  $Name 安装完成" -ForegroundColor Green
        return $true
    }

    function Install-RustupDirect {
        Write-Host "  winget 未提供可用 rustup，直接下载 rustup-init..." -ForegroundColor Cyan
        $installer = Join-Path $env:TEMP "rustup-init-x86_64-pc-windows-msvc.exe"
        $cargoBin = Get-CargoBinPath
        try {
            [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
            Invoke-WebRequest -Uri "https://win.rustup.rs/x86_64" -OutFile $installer -UseBasicParsing -TimeoutSec 300
            & $installer -y --default-toolchain none
            if ($LASTEXITCODE -ne 0) {
                throw "rustup-init exited with $LASTEXITCODE"
            }
            Refresh-ProcessPath
            $rustupPath = Resolve-ToolPath "rustup"
            if (-not $rustupPath) {
                New-Item -ItemType Directory -Path $cargoBin -Force | Out-Null
                $rustupPath = Join-Path $cargoBin "rustup.exe"
                Copy-Item -Path $installer -Destination $rustupPath -Force
                Refresh-ProcessPath
            }
            & cmd.exe /d /s /c "`"$rustupPath`" --version >NUL 2>NUL"
            if ($LASTEXITCODE -ne 0) {
                throw "rustup.exe is not usable at $rustupPath"
            }
            Write-Host "  rustup-init 安装完成 ($rustupPath)" -ForegroundColor Green
            return $true
        } catch {
            Write-Host "  rustup-init 安装失败: $_" -ForegroundColor Red
            return $false
        } finally {
            Remove-Item -Force $installer -ErrorAction SilentlyContinue
        }
    }

    function Ensure-Rustup {
        if (Test-Dependency "Rustup" "rustup --version" "") {
            return $true
        }

        if ($HasWinget) {
            $null = Install-WithWinget "Rust (rustup)" "Rustlang.Rustup"
            Refresh-ProcessPath
        }

        if (Test-Dependency "Rustup" "rustup --version" "") {
            return $true
        }

        if (Install-RustupDirect) {
            return (Test-Dependency "Rustup" "rustup --version" "")
        }

        Write-Host "    请通过 rustup 安装 Rust: https://rustup.rs" -ForegroundColor Yellow
        return $false
    }

    function Get-GitInstaller {
        # Git for Windows version - update this when upgrading
        # Also update version comment in: src-tauri/nsis/installer.nsi (search "Current version: Git for Windows")
        # Download page: https://git-scm.com/downloads/win
        $GitVersion = "2.52.0"
        $GitUrl = "https://github.com/git-for-windows/git/releases/download/v$GitVersion.windows.1/Git-$GitVersion-64-bit.exe"

        $NsisDir = Join-Path $ProjectDir "src-tauri\nsis"
        if (-not (Test-Path $NsisDir)) {
            New-Item -ItemType Directory -Path $NsisDir -Force | Out-Null
        }

        $GitFile = Join-Path $NsisDir "Git-Installer.exe"

        Write-Host "下载 Git for Windows (v$GitVersion)..." -ForegroundColor Blue

        if (-not (Test-Path $GitFile)) {
            Write-Host "  下载 Git 安装包..." -ForegroundColor Cyan
            try {
                [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
                Invoke-WebRequest -Uri $GitUrl -OutFile $GitFile -UseBasicParsing -TimeoutSec 300
                Write-Host "  OK - Git installer downloaded" -ForegroundColor Green
            } catch {
                Write-Host "  下载失败: $_" -ForegroundColor Red
                Write-Host "  请手动下载: $GitUrl" -ForegroundColor Yellow
                Write-Host "  并保存到: $GitFile" -ForegroundColor Yellow
                throw "Git installer download failed"
            }
        } else {
            Write-Host "  OK - Git installer (already exists)" -ForegroundColor Green
        }
        Write-Host "OK - Git installer ready" -ForegroundColor Green
    }

    function Get-NodeJSBinary {
        & "$ProjectDir\scripts\download_nodejs.ps1"
    }

    function Get-VCRuntime {
        $ResourcesDir = Join-Path $ProjectDir "src-tauri\resources"
        if (-not (Test-Path $ResourcesDir)) {
            New-Item -ItemType Directory -Path $ResourcesDir -Force | Out-Null
        }

        Write-Host "提取 VC++ Runtime DLL (app-local deployment)..." -ForegroundColor Blue

        # Native binaries (SDK Claude, cuse, etc.) on Windows may require VCRUNTIME140.dll.
        # App-local deployment: copy DLLs into resources/ so end users don't need to install
        # VC++ Redistributable separately.
        $dlls = @("vcruntime140.dll", "vcruntime140_1.dll")
        foreach ($dll in $dlls) {
            $destFile = Join-Path $ResourcesDir $dll
            $systemFile = Join-Path $env:SystemRoot "System32\$dll"

            if (-not (Test-Path $destFile)) {
                if (Test-Path $systemFile) {
                    Copy-Item -Path $systemFile -Destination $destFile -Force
                    Write-Host "  OK - $dll" -ForegroundColor Green
                } else {
                    # vcruntime140_1.dll may not exist on older MSVC versions, only warn
                    if ($dll -eq "vcruntime140.dll") {
                        throw "$dll not found in $env:SystemRoot\System32. Please install Visual C++ Build Tools."
                    } else {
                        Write-Host "  SKIP - $dll (not found, optional)" -ForegroundColor Yellow
                    }
                }
            } else {
                Write-Host "  OK - $dll (already exists)" -ForegroundColor Green
            }
        }
        Write-Host "OK - VC++ Runtime ready" -ForegroundColor Green
    }

    # Main
    Write-Host "Step 1/8: 检查并安装依赖" -ForegroundColor Blue
    # Eight numbered steps remain: the Mino template now ships with the repo,
    # so setup no longer owns a separate clone/preparation step.

    # Check winget availability for auto-install
    $HasWinget = $false
    & cmd.exe /d /s /c "winget --version >NUL 2>NUL"
    if ($LASTEXITCODE -eq 0) { $HasWinget = $true }

    Refresh-ProcessPath

    # Node.js (needed for typecheck/lint)
    if (-not (Test-Dependency "Node.js" "node --version" "")) {
        if ($HasWinget) {
            $null = Install-WithWinget "Node.js LTS" "OpenJS.NodeJS.LTS"
            Refresh-ProcessPath
        } else {
            Write-Host "    请安装: https://nodejs.org" -ForegroundColor Yellow
        }
    }

    # Rust is prepared via rustup + rust-toolchain.toml below. Do not require
    # rustc/cargo before ensure_rust_toolchain.ps1 has a chance to install them.
    if (-not (Ensure-Rustup)) {
        Write-Host "    请安装: https://rustup.rs" -ForegroundColor Yellow
    }

    # Pre-toolchain check: rustc/cargo are installed by ensure_rust_toolchain.ps1.
    $Missing = $false
    if (-not (Test-Dependency "Node.js" "node --version" "")) { $Missing = $true }
    if (-not (Test-Dependency "Rustup" "rustup --version" "")) { $Missing = $true }

    if ($Missing) {
        Write-Host "`n仍有缺失依赖，请手动安装后重新运行" -ForegroundColor Red
        Write-Host "按回车键退出..." -ForegroundColor Yellow
        Read-Host
        exit 1
    }

    Write-Host "`nStep 1.5/9: 准备 Rust toolchain / components / Windows target" -ForegroundColor Blue
    & "$ProjectDir\scripts\ensure_rust_toolchain.ps1" -Targets @("x86_64-pc-windows-msvc")
    if ($LASTEXITCODE -ne 0) {
        Write-Host "  Rust toolchain 准备失败" -ForegroundColor Red
        Write-Host "`n按回车键退出..." -ForegroundColor Yellow
        Read-Host
        exit 1
    }
    Write-Host "OK - Rust toolchain ready" -ForegroundColor Green

    $MissingAfterToolchain = $false
    if (-not (Test-Dependency "Rust" "rustc --version" "")) { $MissingAfterToolchain = $true }
    if (-not (Test-Dependency "Cargo" "cargo --version" "")) { $MissingAfterToolchain = $true }
    if (-not (Test-Dependency "Rustup" "rustup --version" "")) { $MissingAfterToolchain = $true }
    if ($MissingAfterToolchain) {
        Write-Host "`nRust toolchain 仍不可用，请检查 rustup 安装日志" -ForegroundColor Red
        Write-Host "`n按回车键退出..." -ForegroundColor Yellow
        Read-Host
        exit 1
    }

    # Keep target/cache/tool policy in the native prepare owner. Run its
    # read-only preflight before runtime downloads, npm install, or cargo fetch.
    Write-Host "`nStep 1.75/8: 检查原生推理构建依赖" -ForegroundColor Blue
    & node "$ProjectDir\scripts\prepare-native-inference.mjs" "x86_64-pc-windows-msvc" --check-prerequisites
    if ($LASTEXITCODE -ne 0) {
        Write-Host "  原生推理构建依赖不完整，请按上方提示安装后重新运行" -ForegroundColor Red
        Write-Host "`n按回车键退出..." -ForegroundColor Yellow
        Read-Host
        exit 1
    }
    Write-Host "OK - 原生推理构建依赖检查完成" -ForegroundColor Green

    Write-Host "`nStep 2/8: 下载 Node.js 运行时 (Sidecar + MCP Server + 社区工具统一 runtime)" -ForegroundColor Blue
    Get-NodeJSBinary

    # cuse (computer-use MCP) 二进制 — 与 build_windows.ps1 同一脚本，dev 模式
    # 通过 src/server/utils/runtime.ts::getBundledCusePath() 在 src-tauri/binaries/
    # 下找。download_cuse.ps1 自带版本短路（latest.json + .cuse-version + PE
    # header 烟雾测试），重跑是 noop。网络失败按软失败处理：dev 下 cuse
    # 缺失会被 getBundledCusePath() 返回 null，MCP 优雅 skip + warn，不应阻断
    # 整个 setup。
    Write-Host "`nStep 3/8: 下载 cuse computer-use 二进制" -ForegroundColor Blue
    try {
        & "$ProjectDir\scripts\download_cuse.ps1"
        if ($LASTEXITCODE -ne 0 -and $LASTEXITCODE -ne $null) {
            throw "download_cuse.ps1 exit $LASTEXITCODE"
        }
        Write-Host "OK - cuse ready" -ForegroundColor Green
    } catch {
        Write-Host "  cuse 下载失败: $_" -ForegroundColor Yellow
        Write-Host "  ⚠ computer-use 功能在 dev 模式下将不可用，网络恢复后可重跑：" -ForegroundColor Yellow
        Write-Host "    .\scripts\download_cuse.ps1" -ForegroundColor Yellow
    }

    Write-Host "`nStep 4/8: 下载 Git 安装包 (用于 NSIS 打包)" -ForegroundColor Blue
    Get-GitInstaller

    Write-Host "`nStep 5/8: 提取 VC++ Runtime DLL" -ForegroundColor Blue
    Get-VCRuntime

    Write-Host "`nStep 6/8: 安装前端/后端依赖" -ForegroundColor Blue
    & npm install
    if ($LASTEXITCODE -ne 0) {
        Write-Host "依赖安装失败" -ForegroundColor Red
        Write-Host "`n按回车键退出..." -ForegroundColor Yellow
        Read-Host
        exit 1
    }
    Write-Host "OK - 依赖安装完成" -ForegroundColor Green
    Write-Host "  校验 Claude Agent SDK native package..." -ForegroundColor Cyan
    & "$ProjectDir\scripts\ensure_claude_sdk_package.ps1" -Arch x64
    if ($LASTEXITCODE -ne 0 -and $LASTEXITCODE -ne $null) {
        Write-Host "Claude Agent SDK native package 校验失败" -ForegroundColor Red
        Write-Host "`n按回车键退出..." -ForegroundColor Yellow
        Read-Host
        exit 1
    }

    Write-Host "`nStep 7/8: 下载 Rust 依赖" -ForegroundColor Blue
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

    Write-Host "`nStep 7.5/8: 准备离线文档与语音推理资源" -ForegroundColor Blue
    & node "$ProjectDir\scripts\prepare-native-inference.mjs" "x86_64-pc-windows-msvc"
    if ($LASTEXITCODE -ne 0) {
        Write-Host "  原生推理资源准备失败" -ForegroundColor Red
        Write-Host "`n按回车键退出..." -ForegroundColor Yellow
        Read-Host
        exit 1
    }
    Write-Host "OK - 原生推理资源 ready" -ForegroundColor Green

    Write-Host "`nStep 8/8: 初始化完成!" -ForegroundColor Blue
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
    Write-Host "`n按回车键退出..." -ForegroundColor Yellow
    Read-Host
    exit 1
}

Write-Host "`n按回车键退出..." -ForegroundColor Cyan
Read-Host

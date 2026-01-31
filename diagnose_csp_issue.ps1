# CSP 问题诊断脚本 - 精准定位问题根源

$ErrorActionPreference = "Continue"

Write-Host ""
Write-Host "╔═══════════════════════════════════════════════════════╗" -ForegroundColor Cyan
Write-Host "║  🔍 CSP 问题诊断工具                                   ║" -ForegroundColor Cyan
Write-Host "╚═══════════════════════════════════════════════════════╝" -ForegroundColor Cyan
Write-Host ""

$ProjectDir = $PSScriptRoot

# ========================================
# 1. 检查源代码 CSP
# ========================================
Write-Host "[1] 检查源代码 CSP 配置..." -ForegroundColor Yellow

$sourceConf = Join-Path $ProjectDir "src-tauri\tauri.conf.json"
if (Test-Path $sourceConf) {
    $conf = Get-Content $sourceConf -Raw | ConvertFrom-Json
    $sourceCsp = $conf.app.security.csp

    Write-Host "  源文件路径: $sourceConf" -ForegroundColor Gray
    Write-Host ""
    Write-Host "  CSP 内容:" -ForegroundColor Gray
    Write-Host "  $sourceCsp" -ForegroundColor DarkGray
    Write-Host ""

    # 检查关键部分
    $checks = @{
        "http://ipc.localhost" = $sourceCsp -like "*http://ipc.localhost*"
        "asset:" = $sourceCsp -like "*asset:*"
        "fetch-src" = $sourceCsp -like "*fetch-src*"
        "https://download.myagents.io" = $sourceCsp -like "*https://download.myagents.io*"
    }

    foreach ($key in $checks.Keys) {
        if ($checks[$key]) {
            Write-Host "  ✓ 包含: $key" -ForegroundColor Green
        } else {
            Write-Host "  ✗ 缺少: $key" -ForegroundColor Red
        }
    }
} else {
    Write-Host "  ✗ 文件不存在: $sourceConf" -ForegroundColor Red
}

Write-Host ""

# ========================================
# 2. 检查最新构建产物
# ========================================
Write-Host "[2] 检查最新构建产物..." -ForegroundColor Yellow

$bundleDir = Join-Path $ProjectDir "src-tauri\target\x86_64-pc-windows-msvc\release\bundle\nsis"
if (Test-Path $bundleDir) {
    $setupExe = Get-ChildItem -Path $bundleDir -Filter "*-setup.exe" -ErrorAction SilentlyContinue | Select-Object -First 1

    if ($setupExe) {
        Write-Host "  ✓ 找到安装包:" -ForegroundColor Green
        Write-Host "    文件: $($setupExe.Name)" -ForegroundColor Gray
        Write-Host "    大小: $([math]::Round($setupExe.Length/1MB, 2)) MB" -ForegroundColor Gray
        Write-Host "    修改时间: $($setupExe.LastWriteTime)" -ForegroundColor Gray

        # 检查是否是新构建的（5分钟内）
        $age = (Get-Date) - $setupExe.LastWriteTime
        if ($age.TotalMinutes -lt 5) {
            Write-Host "    ⚠ 这是 $([math]::Round($age.TotalMinutes, 1)) 分钟前构建的（很新）" -ForegroundColor Yellow
        } elseif ($age.TotalHours -lt 1) {
            Write-Host "    ⚠ 这是 $([math]::Round($age.TotalMinutes, 0)) 分钟前构建的" -ForegroundColor Yellow
        } else {
            Write-Host "    ⚠ 这是 $([math]::Round($age.TotalHours, 1)) 小时前构建的（可能是旧版本）" -ForegroundColor Red
        }
    } else {
        Write-Host "  ✗ 未找到安装包" -ForegroundColor Red
    }
} else {
    Write-Host "  ✗ 构建目录不存在: $bundleDir" -ForegroundColor Red
}

Write-Host ""

# ========================================
# 3. 检查已安装版本
# ========================================
Write-Host "[3] 检查已安装版本..." -ForegroundColor Yellow

$app = Get-WmiObject -Class Win32_Product | Where-Object { $_.Name -like "MyAgents*" } | Select-Object -First 1

if ($app) {
    Write-Host "  ✓ 找到已安装版本:" -ForegroundColor Green
    Write-Host "    名称: $($app.Name)" -ForegroundColor Gray
    Write-Host "    版本: $($app.Version)" -ForegroundColor Gray
    Write-Host "    安装日期: $($app.InstallDate)" -ForegroundColor Gray
    Write-Host "    路径: $($app.InstallLocation)" -ForegroundColor Gray
} else {
    Write-Host "  ! 未找到已安装版本" -ForegroundColor Yellow
}

Write-Host ""

# ========================================
# 4. 检查 WebView 缓存
# ========================================
Write-Host "[4] 检查 WebView 缓存..." -ForegroundColor Yellow

$webviewCache = "$env:LOCALAPPDATA\MyAgents\EBWebView"
if (Test-Path $webviewCache) {
    $cacheSize = (Get-ChildItem $webviewCache -Recurse | Measure-Object -Property Length -Sum).Sum
    Write-Host "  ✓ WebView 缓存存在:" -ForegroundColor Yellow
    Write-Host "    路径: $webviewCache" -ForegroundColor Gray
    Write-Host "    大小: $([math]::Round($cacheSize/1MB, 2)) MB" -ForegroundColor Gray
    Write-Host "    ⚠ 这可能包含旧的 CSP 缓存！" -ForegroundColor Yellow
} else {
    Write-Host "  ! 未找到 WebView 缓存" -ForegroundColor Gray
}

Write-Host ""

# ========================================
# 5. 检查运行中的进程
# ========================================
Write-Host "[5] 检查运行中的进程..." -ForegroundColor Yellow

$myagentsProc = Get-Process -Name "MyAgents" -ErrorAction SilentlyContinue
if ($myagentsProc) {
    Write-Host "  ⚠ MyAgents 正在运行:" -ForegroundColor Yellow
    $myagentsProc | ForEach-Object {
        Write-Host "    PID: $($_.Id), 启动时间: $($_.StartTime)" -ForegroundColor Gray
    }
    Write-Host "    建议: 关闭应用后重新安装" -ForegroundColor Yellow
} else {
    Write-Host "  ✓ MyAgents 未运行" -ForegroundColor Green
}

$bunProc = Get-Process -Name "bun" -ErrorAction SilentlyContinue
if ($bunProc) {
    Write-Host "  ⚠ Bun 进程正在运行 ($($bunProc.Count) 个)" -ForegroundColor Yellow
    Write-Host "    建议: 关闭应用后重新安装" -ForegroundColor Yellow
} else {
    Write-Host "  ✓ Bun 进程未运行" -ForegroundColor Green
}

Write-Host ""

# ========================================
# 6. 诊断结论
# ========================================
Write-Host "╔═══════════════════════════════════════════════════════╗" -ForegroundColor Cyan
Write-Host "║  📋 诊断结论                                           ║" -ForegroundColor Cyan
Write-Host "╚═══════════════════════════════════════════════════════╝" -ForegroundColor Cyan
Write-Host ""

# 根据诊断结果给出建议
if ($sourceCsp -notlike "*fetch-src*") {
    Write-Host "🔴 问题: 源代码 CSP 配置不正确" -ForegroundColor Red
    Write-Host "   修复: 请先运行 git pull 获取最新代码" -ForegroundColor Yellow
} elseif ($setupExe -and $age.TotalHours -gt 1) {
    Write-Host "🟡 问题: 构建产物可能过旧" -ForegroundColor Yellow
    Write-Host "   修复: 运行 .\build_windows.ps1 重新构建" -ForegroundColor Yellow
} elseif ($webviewCache) {
    Write-Host "🟡 问题: WebView 缓存可能包含旧配置" -ForegroundColor Yellow
    Write-Host "   修复步骤:" -ForegroundColor Yellow
    Write-Host "     1. 卸载 MyAgents" -ForegroundColor White
    Write-Host "     2. 删除: $webviewCache" -ForegroundColor White
    Write-Host "     3. 重新安装" -ForegroundColor White
} elseif ($myagentsProc -or $bunProc) {
    Write-Host "🟡 问题: 应用正在运行" -ForegroundColor Yellow
    Write-Host "   修复: 关闭应用后重新安装" -ForegroundColor Yellow
} else {
    Write-Host "✅ 源代码 CSP 配置正确" -ForegroundColor Green
    Write-Host "   如果仍有 CSP 错误，请:" -ForegroundColor Yellow
    Write-Host "     1. 完全卸载现有版本" -ForegroundColor White
    Write-Host "     2. 删除 WebView 缓存" -ForegroundColor White
    Write-Host "     3. 重新构建并安装" -ForegroundColor White
}

Write-Host ""
Write-Host "按任意键退出..." -ForegroundColor DarkGray
$null = $Host.UI.RawUI.ReadKey("NoEcho,IncludeKeyDown")

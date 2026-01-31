# Windows 问题诊断脚本
# 用于诊断 MyAgents Windows 版本的启动问题

param(
    [switch]$Verbose
)

$ErrorActionPreference = "Continue"
Write-Host "===== MyAgents Windows 诊断工具 =====" -ForegroundColor Cyan
Write-Host ""

# 1. 检查 Bun 进程
Write-Host "[1] 检查 Bun 进程..." -ForegroundColor Yellow
$bunProcesses = Get-Process -Name "bun" -ErrorAction SilentlyContinue
if ($bunProcesses) {
    Write-Host "  ✓ 找到 $($bunProcesses.Count) 个 Bun 进程:" -ForegroundColor Green
    $bunProcesses | ForEach-Object {
        Write-Host "    PID: $($_.Id), 内存: $([math]::Round($_.WorkingSet64/1MB, 2))MB" -ForegroundColor Gray
    }
} else {
    Write-Host "  × 未找到 Bun 进程 - Sidecar 可能未启动" -ForegroundColor Red
}
Write-Host ""

# 2. 检查端口监听
Write-Host "[2] 检查端口监听..." -ForegroundColor Yellow
$ports = @(31415, 31416, 31417, 31418)
foreach ($port in $ports) {
    $listener = Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction SilentlyContinue
    if ($listener) {
        Write-Host "  ✓ 端口 $port 正在监听 (PID: $($listener.OwningProcess))" -ForegroundColor Green
    } else {
        Write-Host "  × 端口 $port 未监听" -ForegroundColor Red
    }
}
Write-Host ""

# 3. 检查配置目录
Write-Host "[3] 检查配置目录..." -ForegroundColor Yellow
$configDir = Join-Path $env:USERPROFILE ".myagents"
if (Test-Path $configDir) {
    Write-Host "  ✓ 配置目录存在: $configDir" -ForegroundColor Green
    $configFile = Join-Path $configDir "config.json"
    if (Test-Path $configFile) {
        Write-Host "    配置文件: ✓ 存在" -ForegroundColor Gray
    } else {
        Write-Host "    配置文件: × 不存在" -ForegroundColor Red
    }
} else {
    Write-Host "  × 配置目录不存在: $configDir" -ForegroundColor Red
}
Write-Host ""

# 4. 检查日志目录
Write-Host "[4] 检查日志文件..." -ForegroundColor Yellow
$logsDir = Join-Path $configDir "logs"
if (Test-Path $logsDir) {
    Write-Host "  ✓ 日志目录: $logsDir" -ForegroundColor Green
    $latestLog = Get-ChildItem $logsDir -Filter "*.log" | Sort-Object LastWriteTime -Descending | Select-Object -First 1
    if ($latestLog) {
        Write-Host "    最新日志: $($latestLog.Name)" -ForegroundColor Gray
        Write-Host "    修改时间: $($latestLog.LastWriteTime)" -ForegroundColor Gray

        if ($Verbose) {
            Write-Host ""
            Write-Host "    === 最后 20 行日志 ===" -ForegroundColor Cyan
            Get-Content $latestLog.FullName -Tail 20 | ForEach-Object {
                Write-Host "    $_" -ForegroundColor DarkGray
            }
        }
    } else {
        Write-Host "    ! 未找到日志文件" -ForegroundColor Yellow
    }
} else {
    Write-Host "  × 日志目录不存在" -ForegroundColor Red
}
Write-Host ""

# 5. 检查临时目录
Write-Host "[5] 检查临时目录..." -ForegroundColor Yellow
$tempDir = $env:TEMP
Write-Host "  临时目录: $tempDir" -ForegroundColor Gray
$myagentsCache = Join-Path $tempDir "myagents-cache"
if (Test-Path $myagentsCache) {
    Write-Host "  ✓ MyAgents 缓存目录存在" -ForegroundColor Green
} else {
    Write-Host "  ! MyAgents 缓存目录不存在 (正常，首次运行时创建)" -ForegroundColor Yellow
}

# 检查 global sidecar 临时目录
$globalSidecars = Get-ChildItem $tempDir -Filter "myagents-global-*" -Directory -ErrorAction SilentlyContinue
if ($globalSidecars) {
    Write-Host "  ✓ 找到 $($globalSidecars.Count) 个 global sidecar 目录" -ForegroundColor Green
} else {
    Write-Host "  ! 未找到 global sidecar 目录" -ForegroundColor Yellow
}
Write-Host ""

# 6. 测试 localhost 连接
Write-Host "[6] 测试 localhost 连接..." -ForegroundColor Yellow
foreach ($port in @(31415)) {
    try {
        $response = Invoke-WebRequest -Uri "http://127.0.0.1:$port/health" -TimeoutSec 2 -ErrorAction Stop
        Write-Host "  ✓ 端口 $port 响应正常 (HTTP $($response.StatusCode))" -ForegroundColor Green
    } catch {
        $errorMsg = $_.Exception.Message
        if ($errorMsg -match "无法连接|Unable to connect|refused") {
            Write-Host "  × 端口 $port 连接被拒绝 - Sidecar 未启动或崩溃" -ForegroundColor Red
        } elseif ($errorMsg -match "404|Not Found") {
            Write-Host "  ! 端口 $port 可连接但 /health 端点不存在" -ForegroundColor Yellow
        } else {
            Write-Host "  × 端口 $port 错误: $errorMsg" -ForegroundColor Red
        }
    }
}
Write-Host ""

# 7. 检查防火墙规则
Write-Host "[7] 检查防火墙规则..." -ForegroundColor Yellow
try {
    $firewallRules = Get-NetFirewallRule -DisplayName "*MyAgents*" -ErrorAction SilentlyContinue
    if ($firewallRules) {
        Write-Host "  ✓ 找到 MyAgents 防火墙规则" -ForegroundColor Green
    } else {
        Write-Host "  ! 未找到 MyAgents 防火墙规则 (可能不需要)" -ForegroundColor Yellow
    }
} catch {
    Write-Host "  ! 无法检查防火墙规则 (需要管理员权限)" -ForegroundColor Yellow
}
Write-Host ""

# 8. 总结
Write-Host "===== 诊断总结 =====" -ForegroundColor Cyan
Write-Host ""
Write-Host "请检查以上输出中的 × 和 ! 标记。" -ForegroundColor White
Write-Host ""
Write-Host "常见问题解决方案:" -ForegroundColor Yellow
Write-Host "  1. Bun 进程未运行 -> 应用启动失败，检查应用日志" -ForegroundColor Gray
Write-Host "  2. 端口未监听 -> Sidecar 启动失败或崩溃" -ForegroundColor Gray
Write-Host "  3. 连接被拒绝 -> 检查防火墙或网络配置" -ForegroundColor Gray
Write-Host ""
Write-Host "使用 -Verbose 参数查看详细日志:" -ForegroundColor Yellow
Write-Host "  .\diagnose_windows.ps1 -Verbose" -ForegroundColor Gray
Write-Host ""

# 等待用户按键，避免窗口闪退
Write-Host "按任意键退出..." -ForegroundColor DarkGray
$null = $Host.UI.RawUI.ReadKey("NoEcho,IncludeKeyDown")

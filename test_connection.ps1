# 测试连接脚本
# 用于验证 Bun Sidecar 是否可以正常响应

Write-Host "===== 连接测试 =====" -ForegroundColor Cyan
Write-Host ""

# 1. 测试 /sessions 端点
Write-Host "[1] 测试 GET /sessions..." -ForegroundColor Yellow
try {
    $response = Invoke-WebRequest -Uri "http://127.0.0.1:31415/sessions" -Method GET -TimeoutSec 5
    Write-Host "  ✓ 成功! HTTP $($response.StatusCode)" -ForegroundColor Green
    Write-Host "  响应内容: $($response.Content.Substring(0, [Math]::Min(100, $response.Content.Length)))..." -ForegroundColor Gray
} catch {
    Write-Host "  × 失败: $($_.Exception.Message)" -ForegroundColor Red
}
Write-Host ""

# 2. 测试 POST /api/unified-log
Write-Host "[2] 测试 POST /api/unified-log..." -ForegroundColor Yellow
try {
    $body = @{
        logs = @(
            @{ level = "info"; message = "test"; timestamp = (Get-Date).ToString("o") }
        )
    } | ConvertTo-Json

    $response = Invoke-WebRequest -Uri "http://127.0.0.1:31415/api/unified-log" -Method POST -Body $body -ContentType "application/json" -TimeoutSec 5
    Write-Host "  ✓ 成功! HTTP $($response.StatusCode)" -ForegroundColor Green
} catch {
    Write-Host "  × 失败: $($_.Exception.Message)" -ForegroundColor Red
}
Write-Host ""

# 3. 使用 curl 测试（如果可用）
Write-Host "[3] 使用 curl 测试..." -ForegroundColor Yellow
$curlAvailable = Get-Command curl -ErrorAction SilentlyContinue
if ($curlAvailable) {
    try {
        $curlResult = & curl -s -w "\nHTTP_CODE:%{http_code}" http://127.0.0.1:31415/sessions
        Write-Host "  ✓ curl 测试完成" -ForegroundColor Green
        Write-Host "  结果: $($curlResult[-1])" -ForegroundColor Gray
    } catch {
        Write-Host "  × curl 失败: $_" -ForegroundColor Red
    }
} else {
    Write-Host "  ! curl 不可用" -ForegroundColor Yellow
}
Write-Host ""

# 4. 检查 Bun 进程日志
Write-Host "[4] 检查 Bun 进程输出..." -ForegroundColor Yellow
$bunProcess = Get-Process -Name "bun" -ErrorAction SilentlyContinue | Select-Object -First 1
if ($bunProcess) {
    Write-Host "  进程 ID: $($bunProcess.Id)" -ForegroundColor Gray
    Write-Host "  启动时间: $($bunProcess.StartTime)" -ForegroundColor Gray
    Write-Host "  CPU 时间: $([math]::Round($bunProcess.CPU, 2))s" -ForegroundColor Gray
} else {
    Write-Host "  × 未找到 Bun 进程" -ForegroundColor Red
}
Write-Host ""

Write-Host "按任意键退出..." -ForegroundColor DarkGray
$null = $Host.UI.RawUI.ReadKey("NoEcho,IncludeKeyDown")

﻿#!/usr/bin/env pwsh
# 彻底清理并重新构建 - 解决 CSP 缓存问题

param(
    [switch]$SkipUninstall
)

$ErrorActionPreference = "Stop"

Write-Host ""
Write-Host "╔═══════════════════════════════════════════════════════╗" -ForegroundColor Cyan
Write-Host "║  🔧 MyAgents 彻底清理重建                              ║" -ForegroundColor Cyan
Write-Host "╚═══════════════════════════════════════════════════════╝" -ForegroundColor Cyan
Write-Host ""

$ProjectDir = $PSScriptRoot
Set-Location $ProjectDir

# ========================================
# Step 1: 验证 CSP 配置
# ========================================
Write-Host "[1/6] 验证源代码 CSP 配置..." -ForegroundColor Blue

$tauriConf = Get-Content "src-tauri\tauri.conf.json" -Raw | ConvertFrom-Json
$csp = $tauriConf.app.security.csp

Write-Host "  当前 CSP 配置:" -ForegroundColor Gray
Write-Host "  $csp" -ForegroundColor DarkGray
Write-Host ""

# 验证关键部分
$required = @("http://ipc.localhost", "asset:", "fetch-src", "https://download.myagents.io")
$missing = @()

foreach ($part in $required) {
    if ($csp -notlike "*$part*") {
        $missing += $part
        Write-Host "  ✗ 缺少: $part" -ForegroundColor Red
    } else {
        Write-Host "  ✓ 包含: $part" -ForegroundColor Green
    }
}

if ($missing.Count -gt 0) {
    Write-Host ""
    Write-Host "错误: CSP 配置不完整！" -ForegroundColor Red
    Write-Host "请先修复 src-tauri/tauri.conf.json" -ForegroundColor Yellow
    exit 1
}

Write-Host "  ✓ CSP 配置完整" -ForegroundColor Green
Write-Host ""

# ========================================
# Step 2: 卸载旧版本（可选）
# ========================================
if (-not $SkipUninstall) {
    Write-Host "[2/6] 检查并卸载旧版本..." -ForegroundColor Blue

    # 检查是否安装
    $app = Get-WmiObject -Class Win32_Product | Where-Object { $_.Name -like "MyAgents*" } | Select-Object -First 1

    if ($app) {
        Write-Host "  找到已安装版本: $($app.Name) $($app.Version)" -ForegroundColor Yellow
        $uninstall = Read-Host "  是否卸载? (Y/n)"
        if ($uninstall -ne "n" -and $uninstall -ne "N") {
            Write-Host "  正在卸载..." -ForegroundColor Yellow
            try {
                $result = $app.Uninstall()
                if ($result.ReturnValue -eq 0) {
                    Start-Sleep -Seconds 2
                    Write-Host "  ✓ 卸载完成" -ForegroundColor Green
                } else {
                    Write-Host "  警告: 卸载返回非零状态码 $($result.ReturnValue)" -ForegroundColor Yellow
                    Write-Host "  建议手动检查控制面板确认卸载状态" -ForegroundColor Yellow
                }
            } catch {
                Write-Host "  警告: 卸载失败: $_" -ForegroundColor Yellow
                Write-Host "  您可能需要手动从控制面板卸载" -ForegroundColor Yellow
                # 不抛出异常，允许继续执行
            }
        }
    } else {
        Write-Host "  未找到已安装版本" -ForegroundColor Gray
    }
    Write-Host ""
} else {
    Write-Host "[2/6] 跳过卸载检查" -ForegroundColor Yellow
    Write-Host ""
}

# ========================================
# Step 3: 清理 WebView 缓存
# ========================================
Write-Host "[3/6] 清理 WebView 缓存..." -ForegroundColor Blue

$webviewCache = "$env:LOCALAPPDATA\MyAgents\EBWebView"
if (Test-Path $webviewCache) {
    Write-Host "  删除: $webviewCache" -ForegroundColor Yellow
    Remove-Item -Recurse -Force $webviewCache -ErrorAction SilentlyContinue
    Write-Host "  ✓ WebView 缓存已清理" -ForegroundColor Green
} else {
    Write-Host "  未找到 WebView 缓存" -ForegroundColor Gray
}

$appData = "$env:APPDATA\MyAgents"
if (Test-Path $appData) {
    Write-Host "  保留用户数据: $appData" -ForegroundColor Gray
}

Write-Host ""

# ========================================
# Step 4: 杀死残留进程
# ========================================
Write-Host "[4/6] 杀死残留进程..." -ForegroundColor Blue

$killed = 0
Get-Process | Where-Object { $_.ProcessName -eq "bun" } | ForEach-Object {
    Stop-Process -Id $_.Id -Force -ErrorAction SilentlyContinue
    $killed++
}

Get-Process | Where-Object { $_.ProcessName -eq "MyAgents" } | ForEach-Object {
    Stop-Process -Id $_.Id -Force -ErrorAction SilentlyContinue
    $killed++
}

if ($killed -gt 0) {
    Write-Host "  ✓ 已杀死 $killed 个进程" -ForegroundColor Green
    Start-Sleep -Seconds 1
} else {
    Write-Host "  未找到残留进程" -ForegroundColor Gray
}

Write-Host ""

# ========================================
# Step 5: 彻底清理构建缓存
# ========================================
Write-Host "[5/6] 彻底清理构建缓存..." -ForegroundColor Blue

$cleanDirs = @(
    "dist",
    "src-tauri\target\x86_64-pc-windows-msvc\release\bundle",
    "src-tauri\target\x86_64-pc-windows-msvc\release\resources",
    "src-tauri\target\x86_64-pc-windows-msvc\release\build\myagents-*",
    "src-tauri\target\release\bundle",
    "src-tauri\target\release\resources"
)

$cleaned = 0
foreach ($dir in $cleanDirs) {
    if (Test-Path $dir) {
        Write-Host "  删除: $dir" -ForegroundColor Yellow
        Remove-Item -Recurse -Force $dir -ErrorAction SilentlyContinue
        $cleaned++
    }
}

Write-Host "  ✓ 已清理 $cleaned 个目录" -ForegroundColor Green
Write-Host ""

# ========================================
# Step 6: 调用构建脚本
# ========================================
Write-Host "[6/6] 开始构建..." -ForegroundColor Blue
Write-Host ""

& "$ProjectDir\build_windows.ps1"

if ($LASTEXITCODE -ne 0) {
    Write-Host ""
    Write-Host "构建失败！" -ForegroundColor Red
    exit 1
}

Write-Host ""
Write-Host "╔═══════════════════════════════════════════════════════╗" -ForegroundColor Green
Write-Host "║  ✅ 清理并重建完成                                     ║" -ForegroundColor Green
Write-Host "╚═══════════════════════════════════════════════════════╝" -ForegroundColor Green
Write-Host ""
Write-Host "下一步操作:" -ForegroundColor Cyan
Write-Host "  1. 找到构建产物并安装" -ForegroundColor White
Write-Host "  2. 启动应用并打开 DevTools (Ctrl+Shift+I)" -ForegroundColor White
Write-Host "  3. 检查控制台是否还有 CSP 错误" -ForegroundColor White
Write-Host ""

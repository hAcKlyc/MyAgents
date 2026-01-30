# MyAgents Windows 发布脚本
# 将构建产物上传到 Cloudflare R2，并生成更新清单
#
# 前置条件：
# 1. 已运行 build_windows.ps1 完成构建
# 2. .env 中配置了 R2 凭证：
#    - R2_ACCESS_KEY_ID
#    - R2_SECRET_ACCESS_KEY
#    - R2_ACCOUNT_ID
# 3. .env 中配置了 Cloudflare 缓存清除凭证（可选但推荐）：
#    - CF_ZONE_ID
#    - CF_API_TOKEN
# 4. 安装 rclone: https://rclone.org/downloads/

$ErrorActionPreference = "Stop"
$PublishSuccess = $false

# 用于清理的临时文件路径
$script:rcloneConfig = $null
$script:ManifestDir = $null

function Exit-WithPause {
    param([int]$Code = 0)
    Write-Host ""
    if ($Code -eq 0) {
        Write-Host "按回车键退出..." -ForegroundColor Cyan
    } else {
        Write-Host "按回车键退出..." -ForegroundColor Yellow
    }
    Read-Host
    exit $Code
}

function Cleanup-TempFiles {
    if ($script:rcloneConfig -and (Test-Path $script:rcloneConfig)) {
        Remove-Item $script:rcloneConfig -Force -ErrorAction SilentlyContinue
    }
    if ($script:ManifestDir -and (Test-Path $script:ManifestDir)) {
        Remove-Item $script:ManifestDir -Recurse -Force -ErrorAction SilentlyContinue
    }
}

try {

$ProjectDir = Split-Path -Parent $MyInvocation.MyCommand.Path
Set-Location $ProjectDir

# 读取版本号
$TauriConf = Get-Content "src-tauri\tauri.conf.json" -Raw | ConvertFrom-Json
$Version = $TauriConf.version
$BundleDir = Join-Path $ProjectDir "src-tauri\target"
$EnvFile = Join-Path $ProjectDir ".env"

# 配置
$R2Bucket = "myagents-releases"
$DownloadBaseUrl = "https://download.myagents.io"

Write-Host ""
Write-Host "=========================================" -ForegroundColor Cyan
Write-Host "  MyAgents Windows 发布到 R2" -ForegroundColor Green
Write-Host "  Version: $Version" -ForegroundColor Blue
Write-Host "=========================================" -ForegroundColor Cyan
Write-Host ""

# ========================================
# 加载环境变量
# ========================================
Write-Host "[1/7] 加载配置..." -ForegroundColor Blue

if (-not (Test-Path $EnvFile)) {
    Write-Host "[X] .env 文件不存在!" -ForegroundColor Red
    throw ".env 文件不存在"
}

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
Write-Host "[OK] 已加载 .env" -ForegroundColor Green

# 验证 R2 配置
$R2AccessKeyId = $env:R2_ACCESS_KEY_ID
$R2SecretAccessKey = $env:R2_SECRET_ACCESS_KEY
$R2AccountId = $env:R2_ACCOUNT_ID

if (-not $R2AccessKeyId -or -not $R2SecretAccessKey -or -not $R2AccountId) {
    Write-Host "[X] R2 配置不完整!" -ForegroundColor Red
    Write-Host "请在 .env 中配置:" -ForegroundColor Yellow
    Write-Host "  R2_ACCESS_KEY_ID=xxx"
    Write-Host "  R2_SECRET_ACCESS_KEY=xxx"
    Write-Host "  R2_ACCOUNT_ID=xxx"
    throw "R2 配置不完整"
}
Write-Host "[OK] R2 配置已验证" -ForegroundColor Green
Write-Host ""

# ========================================
# 检查 rclone
# ========================================
Write-Host "[2/7] 检查 rclone..." -ForegroundColor Blue

# 优先检查项目目录下的 rclone.exe
$localRclone = Join-Path $ProjectDir "rclone.exe"
if (Test-Path $localRclone) {
    $rclonePath = $localRclone
    Write-Host "[OK] 使用项目目录 rclone.exe" -ForegroundColor Green
} else {
    # 检查系统 PATH
    $rclone = Get-Command rclone -ErrorAction SilentlyContinue
    if (-not $rclone) {
        Write-Host "[X] rclone 未找到" -ForegroundColor Red
        Write-Host "请将 rclone.exe 放到项目根目录，或添加到系统 PATH" -ForegroundColor Yellow
        Write-Host "下载地址: https://rclone.org/downloads/" -ForegroundColor Yellow
        throw "rclone 未找到"
    }
    $rclonePath = $rclone.Source
    Write-Host "[OK] 使用系统 rclone" -ForegroundColor Green
}

# 创建临时 rclone 配置 (凭证通过环境变量传递，更安全)
$rcloneConfig = [System.IO.Path]::GetTempFileName()
$script:rcloneConfig = $rcloneConfig
@"
[r2]
type = s3
provider = Cloudflare
env_auth = true
endpoint = https://$R2AccountId.r2.cloudflarestorage.com
acl = private
"@ | Set-Content $rcloneConfig -Encoding UTF8

# 设置 rclone 环境变量 (避免在配置文件中存储明文凭证)
$env:RCLONE_CONFIG_R2_ACCESS_KEY_ID = $R2AccessKeyId
$env:RCLONE_CONFIG_R2_SECRET_ACCESS_KEY = $R2SecretAccessKey

Write-Host ""

# ========================================
# 物料完整性检查
# ========================================
Write-Host "[3/7] 物料完整性检查..." -ForegroundColor Blue
Write-Host ""

$TargetDir = Join-Path $BundleDir "x86_64-pc-windows-msvc\release\bundle\nsis"

# 查找文件
$NsisExe = Get-ChildItem -Path $TargetDir -Filter "*.exe" -ErrorAction SilentlyContinue | Where-Object { $_.Name -notmatch "portable" } | Select-Object -First 1
$PortableZip = Get-ChildItem -Path $TargetDir -Filter "*portable*.zip" -ErrorAction SilentlyContinue | Select-Object -First 1
$UpdateZip = Get-ChildItem -Path $TargetDir -Filter "*.nsis.zip" -ErrorAction SilentlyContinue | Select-Object -First 1
$SigFile = Get-ChildItem -Path $TargetDir -Filter "*.nsis.zip.sig" -ErrorAction SilentlyContinue | Select-Object -First 1

Write-Host "  物料清单 - v$Version" -ForegroundColor Cyan
Write-Host "  -----------------------------------------"

if ($NsisExe) {
    Write-Host "    [OK] NSIS:    $($NsisExe.Name)" -ForegroundColor Green
}
else {
    Write-Host "    [X] NSIS:    缺失" -ForegroundColor Red
}

if ($PortableZip) {
    Write-Host "    [OK] ZIP:     $($PortableZip.Name)" -ForegroundColor Green
}
else {
    Write-Host "    [X] ZIP:     缺失" -ForegroundColor Yellow
}

if ($UpdateZip) {
    Write-Host "    [OK] 更新包:  $($UpdateZip.Name)" -ForegroundColor Green
}
else {
    Write-Host "    [X] 更新包:  缺失" -ForegroundColor Red
}

if ($SigFile) {
    Write-Host "    [OK] 签名:    $($SigFile.Name)" -ForegroundColor Green
}
else {
    Write-Host "    [X] 签名:    缺失" -ForegroundColor Yellow
}

Write-Host ""

# 检查关键文件
if (-not $NsisExe) {
    Write-Host "[X] NSIS 安装包缺失，无法继续" -ForegroundColor Red
    Write-Host "请先运行 .\build_windows.ps1 完成构建" -ForegroundColor Yellow
    throw "NSIS 安装包缺失"
}

if (-not $UpdateZip) {
    Write-Host "[!] 更新包缺失，自动更新将不可用" -ForegroundColor Yellow
    $continue = Read-Host "是否继续? (y/N)"
    if ($continue -ne "y" -and $continue -ne "Y") {
        Write-Host "发布已取消" -ForegroundColor Red
        throw "用户取消发布"
    }
}

Write-Host ""

# ========================================
# 生成更新清单
# ========================================
Write-Host "[4/7] 生成更新清单..." -ForegroundColor Blue

$ManifestDir = [System.IO.Path]::GetTempPath() + "myagents-manifest-" + [System.Guid]::NewGuid().ToString("N")
$script:ManifestDir = $ManifestDir
New-Item -ItemType Directory -Path $ManifestDir -Force | Out-Null

$PubDate = (Get-Date).ToUniversalTime().ToString("yyyy-MM-ddTHH:mm:ssZ")

# 读取签名
$Signature = ""
if ($SigFile) {
    $Signature = Get-Content $SigFile.FullName -Raw
    $Signature = $Signature.Trim()
}

# 生成 windows-x86_64.json
if ($UpdateZip) {
    $UpdateFileName = $UpdateZip.Name
    # 重命名上传文件名，添加版本和架构标识
    $UpdateUploadName = "MyAgents_${Version}_x86_64.nsis.zip"

    $manifest = @{
        version   = $Version
        notes     = "MyAgents v$Version"
        pub_date  = $PubDate
        signature = $Signature
        url       = "$DownloadBaseUrl/releases/v$Version/$UpdateUploadName"
    }

    # 添加下载链接
    $downloads = @{}
    if ($NsisExe) {
        $downloads["installer"] = "$DownloadBaseUrl/releases/v$Version/$($NsisExe.Name)"
    }
    if ($PortableZip) {
        $downloads["portable"] = "$DownloadBaseUrl/releases/v$Version/$($PortableZip.Name)"
    }
    if ($downloads.Count -gt 0) {
        $manifest["downloads"] = $downloads
    }

    $manifestJson = $manifest | ConvertTo-Json -Depth 5
    $manifestJson | Set-Content (Join-Path $ManifestDir "windows-x86_64.json") -Encoding UTF8

    Write-Host "  [OK] windows-x86_64.json 已生成" -ForegroundColor Green

    if (-not $Signature) {
        Write-Host "  [!] 警告: 签名为空，自动更新将验证失败" -ForegroundColor Yellow
    }
}
else {
    Write-Host "  [!] 跳过更新清单生成 (无更新包)" -ForegroundColor Yellow
}

# 生成 latest_win.json (网站下载页 API)
# 注意：只发布 NSIS 安装包，便携版暂不对外发布
if ($NsisExe) {
    $latestWinDownloads = @{
        "win_x64" = @{
            name = "Windows x64"
            url  = "$DownloadBaseUrl/releases/v$Version/$($NsisExe.Name)"
        }
    }

    $latestWinManifest = @{
        version       = $Version
        pub_date      = $PubDate
        release_notes = "MyAgents v$Version"
        downloads     = $latestWinDownloads
    }

    $latestWinJson = $latestWinManifest | ConvertTo-Json -Depth 5
    $latestWinJson | Set-Content (Join-Path $ManifestDir "latest_win.json") -Encoding UTF8

    Write-Host "  [OK] latest_win.json 已生成" -ForegroundColor Green
}

Write-Host ""

# ========================================
# 上传确认
# ========================================
Write-Host "[5/7] 上传前确认..." -ForegroundColor Blue
Write-Host ""
Write-Host "  即将上传的文件:" -ForegroundColor Cyan

$uploadFiles = @()
if ($NsisExe) {
    $size = "{0:N2} MB" -f ($NsisExe.Length / 1MB)
    Write-Host "    - $($NsisExe.Name) ($size)"
    $uploadFiles += $NsisExe
}
if ($PortableZip) {
    $size = "{0:N2} MB" -f ($PortableZip.Length / 1MB)
    Write-Host "    - $($PortableZip.Name) ($size)"
    $uploadFiles += $PortableZip
}
if ($UpdateZip) {
    $size = "{0:N2} MB" -f ($UpdateZip.Length / 1MB)
    Write-Host "    - $UpdateUploadName ($size)"
    $uploadFiles += $UpdateZip
}
if ($SigFile) {
    Write-Host "    - MyAgents_${Version}_x86_64.nsis.zip.sig"
    $uploadFiles += $SigFile
}

Write-Host ""
Write-Host "  即将上传的清单:" -ForegroundColor Cyan
Write-Host "    - windows-x86_64.json (Tauri Updater)"
Write-Host "    - latest_win.json (网站下载 API)"
Write-Host ""
Write-Host "  目标位置:" -ForegroundColor Cyan
Write-Host "    - 文件: $DownloadBaseUrl/releases/v$Version/"
Write-Host "    - 清单: $DownloadBaseUrl/update/"
Write-Host ""

$confirm = Read-Host "确认上传? (Y/n)"
if ($confirm -eq "n" -or $confirm -eq "N") {
    Write-Host "发布已取消" -ForegroundColor Red
    throw "用户取消发布"
}

Write-Host ""

# ========================================
# 上传构建产物
# ========================================
Write-Host "[6/7] 上传构建产物到 R2..." -ForegroundColor Blue

$uploadSuccess = 0
$uploadFailed = 0

# 上传 NSIS 安装包
if ($NsisExe) {
    Write-Host "  上传 NSIS 安装包..." -ForegroundColor Cyan
    & $rclonePath --config=$rcloneConfig copy $NsisExe.FullName "r2:$R2Bucket/releases/v$Version/" --s3-no-check-bucket --progress
    if ($LASTEXITCODE -eq 0) {
        Write-Host "    [OK] $($NsisExe.Name)" -ForegroundColor Green
        $uploadSuccess++
    }
    else {
        Write-Host "    [X] NSIS 上传失败" -ForegroundColor Red
        $uploadFailed++
    }
}

# 上传便携版 ZIP
if ($PortableZip) {
    Write-Host "  上传便携版 ZIP..." -ForegroundColor Cyan
    & $rclonePath --config=$rcloneConfig copy $PortableZip.FullName "r2:$R2Bucket/releases/v$Version/" --s3-no-check-bucket --progress
    if ($LASTEXITCODE -eq 0) {
        Write-Host "    [OK] $($PortableZip.Name)" -ForegroundColor Green
        $uploadSuccess++
    }
    else {
        Write-Host "    [X] ZIP 上传失败" -ForegroundColor Red
        $uploadFailed++
    }
}

# 上传更新包 (使用新文件名)
if ($UpdateZip) {
    Write-Host "  上传更新包..." -ForegroundColor Cyan
    & $rclonePath --config=$rcloneConfig copyto $UpdateZip.FullName "r2:$R2Bucket/releases/v$Version/$UpdateUploadName" --s3-no-check-bucket --progress
    if ($LASTEXITCODE -eq 0) {
        Write-Host "    [OK] $UpdateUploadName" -ForegroundColor Green
        $uploadSuccess++
    }
    else {
        Write-Host "    [X] 更新包上传失败" -ForegroundColor Red
        $uploadFailed++
    }
}

# 上传签名文件
if ($SigFile) {
    Write-Host "  上传签名文件..." -ForegroundColor Cyan
    $sigUploadName = "MyAgents_${Version}_x86_64.nsis.zip.sig"
    & $rclonePath --config=$rcloneConfig copyto $SigFile.FullName "r2:$R2Bucket/releases/v$Version/$sigUploadName" --s3-no-check-bucket --progress
    if ($LASTEXITCODE -eq 0) {
        Write-Host "    [OK] $sigUploadName" -ForegroundColor Green
        $uploadSuccess++
    }
    else {
        Write-Host "    [X] 签名上传失败" -ForegroundColor Red
        $uploadFailed++
    }
}

Write-Host ""
Write-Host "  上传统计: 成功 $uploadSuccess / 失败 $uploadFailed" -ForegroundColor Cyan

if ($uploadFailed -gt 0) {
    Write-Host "[!] 部分文件上传失败!" -ForegroundColor Yellow
}

Write-Host ""

# ========================================
# 上传清单
# ========================================
Write-Host "[7/7] 上传更新清单..." -ForegroundColor Blue

& $rclonePath --config=$rcloneConfig copy "$ManifestDir/" "r2:$R2Bucket/update/" --s3-no-check-bucket --progress
if ($LASTEXITCODE -eq 0) {
    Write-Host "[OK] 清单已上传" -ForegroundColor Green
}
else {
    Write-Host "[X] 清单上传失败" -ForegroundColor Red
}

Write-Host ""

# ========================================
# 清除 CDN 缓存
# ========================================
$CfZoneId = $env:CF_ZONE_ID
$CfApiToken = $env:CF_API_TOKEN

if ($CfZoneId -and $CfApiToken) {
    Write-Host "清除 Cloudflare CDN 缓存..." -ForegroundColor Cyan

    $purgeUrls = @(
        "$DownloadBaseUrl/update/windows-x86_64.json",
        "$DownloadBaseUrl/update/latest_win.json"
    )

    if ($NsisExe) {
        $purgeUrls += "$DownloadBaseUrl/releases/v$Version/$($NsisExe.Name)"
    }
    if ($PortableZip) {
        $purgeUrls += "$DownloadBaseUrl/releases/v$Version/$($PortableZip.Name)"
    }
    if ($UpdateZip) {
        $purgeUrls += "$DownloadBaseUrl/releases/v$Version/$UpdateUploadName"
    }

    $purgeBody = @{ files = $purgeUrls } | ConvertTo-Json

    try {
        $response = Invoke-RestMethod -Uri "https://api.cloudflare.com/client/v4/zones/$CfZoneId/purge_cache" `
            -Method Post `
            -Headers @{ "Authorization" = "Bearer $CfApiToken"; "Content-Type" = "application/json" } `
            -Body $purgeBody

        if ($response.success) {
            Write-Host "  [OK] CDN 缓存已清除 ($($purgeUrls.Count) 个文件)" -ForegroundColor Green
        }
        else {
            Write-Host "  [!] CDN 缓存清除可能失败" -ForegroundColor Yellow
        }
    }
    catch {
        Write-Host "  [!] CDN 缓存清除请求失败: $_" -ForegroundColor Yellow
    }
}
else {
    Write-Host "[!] 未配置 CF_ZONE_ID 或 CF_API_TOKEN，跳过 CDN 缓存清除" -ForegroundColor Yellow
    Write-Host "    建议在 .env 中配置以确保更新立即生效" -ForegroundColor Yellow
}

Write-Host ""

# ========================================
# 清理临时文件
# ========================================
Cleanup-TempFiles

# 标记发布成功
$PublishSuccess = $true

# ========================================
# 完成
# ========================================
Write-Host "=========================================" -ForegroundColor Green
Write-Host "  发布完成!" -ForegroundColor Green
Write-Host "=========================================" -ForegroundColor Green
Write-Host ""
Write-Host "  版本: v$Version" -ForegroundColor Cyan
Write-Host ""
Write-Host "  下载地址 (NSIS):" -ForegroundColor Blue
if ($NsisExe) {
    Write-Host "    $DownloadBaseUrl/releases/v$Version/$($NsisExe.Name)" -ForegroundColor Cyan
}
Write-Host ""
Write-Host "  下载地址 (便携版):" -ForegroundColor Blue
if ($PortableZip) {
    Write-Host "    $DownloadBaseUrl/releases/v$Version/$($PortableZip.Name)" -ForegroundColor Cyan
}
Write-Host ""
Write-Host "  自动更新清单 (Tauri Updater):" -ForegroundColor Blue
Write-Host "    $DownloadBaseUrl/update/windows-x86_64.json" -ForegroundColor Cyan
Write-Host ""
Write-Host "  网站下载 API:" -ForegroundColor Blue
Write-Host "    $DownloadBaseUrl/update/latest_win.json" -ForegroundColor Cyan
Write-Host ""
Write-Host "  验证命令:" -ForegroundColor Blue
Write-Host "    curl -s $DownloadBaseUrl/update/windows-x86_64.json | jq ." -ForegroundColor White
Write-Host "    curl -s $DownloadBaseUrl/update/latest_win.json | jq ." -ForegroundColor White
Write-Host ""

} catch {
    Write-Host ""
    Write-Host "=========================================" -ForegroundColor Red
    Write-Host "  发布失败!" -ForegroundColor Red
    Write-Host "=========================================" -ForegroundColor Red
    Write-Host ""
    Write-Host "错误: $_" -ForegroundColor Red
    Write-Host ""
    Cleanup-TempFiles
}

# ========================================
# 暂停退出 (防止窗口直接关闭)
# ========================================
Write-Host ""
if ($PublishSuccess) {
    Write-Host "按回车键退出..." -ForegroundColor Cyan
} else {
    Write-Host "按回车键退出..." -ForegroundColor Yellow
}
Read-Host

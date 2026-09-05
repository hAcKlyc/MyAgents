# Prepare the official Windows x64 Node/npm distribution for setup and builds.
# Keep this compatible with Windows PowerShell 5.1 (no system Node required).
$ErrorActionPreference = "Stop"
$PSNativeCommandUseErrorActionPreference = $false

$ProjectDir = Split-Path -Parent $PSScriptRoot
$Runtime = Get-Content (Join-Path $PSScriptRoot "node-runtime.json") -Raw | ConvertFrom-Json
$NodeVersion = $Runtime.node
$NpmVersion = $Runtime.npm
if ($NodeVersion -notmatch '^\d+\.\d+\.\d+$' -or $NpmVersion -notmatch '^\d+\.\d+\.\d+$') {
    throw "Invalid pinned Node/npm versions in node-runtime.json"
}
$NodeDir = Join-Path $ProjectDir "src-tauri\resources\nodejs"

function Test-BundledNode {
    param([string]$Directory)
    $NodeExe = Join-Path $Directory "node.exe"
    $NpmDir = Join-Path $Directory "node_modules\npm"
    foreach ($File in @($NodeExe, (Join-Path $NpmDir "package.json"),
        (Join-Path $NpmDir "bin\npm-cli.js"), (Join-Path $NpmDir "bin\npx-cli.js"),
        (Join-Path $Directory "npm.cmd"), (Join-Path $Directory "npx.cmd"))) {
        if (-not (Test-Path -LiteralPath $File -PathType Leaf)) { return $false }
    }
    try {
        $Identity = & $NodeExe -p 'JSON.stringify([process.versions.node,process.platform,process.arch])' 2>$null
        if ($LASTEXITCODE -ne 0) { return $false }
        $Parts = $Identity | ConvertFrom-Json
        if ($Parts.Count -ne 3 -or $Parts[0] -ne $NodeVersion -or $Parts[1] -ne "win32" -or $Parts[2] -ne "x64") { return $false }
        $NpmPackage = Get-Content (Join-Path $NpmDir "package.json") -Raw | ConvertFrom-Json
        if ($NpmPackage.version -ne $NpmVersion) { return $false }
        $ActualNpm = & $NodeExe (Join-Path $NpmDir "bin\npm-cli.js") --version 2>$null
        if ($LASTEXITCODE -ne 0 -or $ActualNpm -ne $NpmVersion) { return $false }
        $ActualNpx = & $NodeExe (Join-Path $NpmDir "bin\npx-cli.js") --version 2>$null
        return ($LASTEXITCODE -eq 0 -and $ActualNpx -eq $NpmVersion)
    } catch {
        return $false
    }
}

if (Test-BundledNode $NodeDir) {
    Write-Host "Node.js $NodeVersion / npm $NpmVersion (win-x64) already verified" -ForegroundColor Green
    $global:LASTEXITCODE = 0
    return
}

# Replace the whole pair, including stale/missing npm. Never independently
# upgrade npm: the official Node artifact already contains the pinned version.
$TempDir = Join-Path ([IO.Path]::GetTempPath()) ("myagents-node-" + [guid]::NewGuid().ToString("N"))
$ZipName = "node-v$NodeVersion-win-x64.zip"
try {
    New-Item -ItemType Directory -Path $TempDir -Force | Out-Null
    $TempZip = Join-Path $TempDir $ZipName
    [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
    Write-Host "Downloading Node.js $NodeVersion / npm $NpmVersion (win-x64)..." -ForegroundColor Cyan
    Invoke-WebRequest -Uri "https://nodejs.org/dist/v$NodeVersion/$ZipName" -OutFile $TempZip -UseBasicParsing -TimeoutSec 300
    Expand-Archive -LiteralPath $TempZip -DestinationPath $TempDir -Force
    $ExtractedDir = Join-Path $TempDir "node-v$NodeVersion-win-x64"
    if (-not (Test-BundledNode $ExtractedDir)) { throw "Downloaded runtime does not match Node $NodeVersion / npm $NpmVersion (win-x64)" }

    if (Test-Path $NodeDir) { Remove-Item -Recurse -Force $NodeDir }
    New-Item -ItemType Directory -Path $NodeDir -Force | Out-Null
    foreach ($File in @("node.exe", "npm.cmd", "npx.cmd", "npm", "npx")) {
        Copy-Item -LiteralPath (Join-Path $ExtractedDir $File) -Destination $NodeDir -Force
    }
    # Copy-Item -Recurse can lose deep npm dependencies on Windows MAX_PATH.
    & robocopy (Join-Path $ExtractedDir "node_modules") (Join-Path $NodeDir "node_modules") /E /NFL /NDL /NJH /NJS /NC /NS /NP | Out-Null
    if ($LASTEXITCODE -ge 8) { throw "robocopy failed: exit $LASTEXITCODE" }
    if (-not (Test-BundledNode $NodeDir)) { throw "Staged runtime failed Node/npm verification" }
    Write-Host "Node.js $NodeVersion / npm $NpmVersion (win-x64) ready" -ForegroundColor Green
    $global:LASTEXITCODE = 0
} finally {
    if (Test-Path $TempDir) { Remove-Item -Recurse -Force $TempDir }
}

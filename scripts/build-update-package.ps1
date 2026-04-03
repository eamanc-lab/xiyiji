param(
  [string]$WinUnpackedDir = '',
  [string]$OutputDir = ''
)

. "$PSScriptRoot/build-common.ps1"

$projectDir = Get-ProjectDir
$releaseDir = Get-ReleaseDir
$updateConfigPath = Join-Path $projectDir 'update-config.json'

if ([string]::IsNullOrWhiteSpace($WinUnpackedDir)) {
  $WinUnpackedDir = Join-Path $releaseDir 'win-unpacked'
}
if ([string]::IsNullOrWhiteSpace($OutputDir)) {
  $OutputDir = Join-Path $releaseDir 'online-update'
}

if (-not (Test-Path $WinUnpackedDir)) {
  throw "win-unpacked directory not found: $WinUnpackedDir"
}

$packageJsonRaw = Get-Content (Join-Path $projectDir 'package.json') -Raw
$versionMatch = [regex]::Match($packageJsonRaw, '"version"\s*:\s*"([^"]+)"')
$version = if ($versionMatch.Success) { $versionMatch.Groups[1].Value.Trim() } else { '' }
if ([string]::IsNullOrWhiteSpace($version)) {
  throw 'package.json version is empty.'
}

$appExe = Get-ChildItem -LiteralPath $WinUnpackedDir -Filter '*.exe' -File | Select-Object -First 1
if (-not $appExe) {
  throw "No root EXE found in win-unpacked: $WinUnpackedDir"
}

New-Item -ItemType Directory -Path $OutputDir -Force | Out-Null

$zipName = "xiyiji-app-update-$version.zip"
$zipPath = Join-Path $OutputDir $zipName
$manifestPath = Join-Path $OutputDir 'manifest.json'
$manifestTemplatePath = Join-Path $OutputDir 'manifest.template.json'

Remove-IfExists $zipPath
Remove-IfExists $manifestPath
Remove-IfExists $manifestTemplatePath

$archiveInputs = Get-ChildItem -LiteralPath $WinUnpackedDir -Force | Select-Object -ExpandProperty FullName
if (-not $archiveInputs -or $archiveInputs.Count -eq 0) {
  throw "win-unpacked is empty: $WinUnpackedDir"
}

Compress-Archive -Path $archiveInputs -DestinationPath $zipPath -Force

$hash = (Get-FileHash -LiteralPath $zipPath -Algorithm SHA256).Hash.ToLower()
$size = (Get-Item -LiteralPath $zipPath).Length

$updateConfig = $null
if (Test-Path $updateConfigPath) {
  $updateConfig = Get-Content $updateConfigPath -Raw | ConvertFrom-Json
}

$baseUrl = [string]$env:XIYIJI_UPDATE_BASE_URL
if ([string]::IsNullOrWhiteSpace($baseUrl)) {
  $baseUrl = [string]$updateConfig.baseUrl
}
$baseUrl = $baseUrl.Trim()
$packageUrl = if ($baseUrl) {
  '{0}/{1}' -f $baseUrl.TrimEnd('/'), $zipName
} else {
  ''
}

$fullPackageUrl = [string]$env:XIYIJI_FULL_PACKAGE_URL
if ([string]::IsNullOrWhiteSpace($fullPackageUrl)) {
  $fullPackageUrl = [string]$updateConfig.fullPackageUrl
}

$fullPackageCode = [string]$env:XIYIJI_FULL_PACKAGE_CODE
if ([string]::IsNullOrWhiteSpace($fullPackageCode)) {
  $fullPackageCode = [string]$updateConfig.fullPackageCode
}

$manifest = [ordered]@{
  version = $version
  publishedAt = [DateTime]::UtcNow.ToString('o')
  notes = ''
  forceUpdate = $false
  appPackage = [ordered]@{
    url = $packageUrl
    sha256 = $hash
    size = $size
    fileName = $zipName
    launchExecutable = $appExe.Name
  }
  fullPackage = [ordered]@{
    url = $fullPackageUrl
    code = $fullPackageCode
  }
}

$manifestJson = $manifest | ConvertTo-Json -Depth 6
$utf8NoBom = New-Object System.Text.UTF8Encoding($false)
[System.IO.File]::WriteAllText($manifestPath, $manifestJson, $utf8NoBom)
[System.IO.File]::WriteAllText($manifestTemplatePath, $manifestJson, $utf8NoBom)

Write-Host ''
Write-Host '========================================================'
Write-Host 'Online update package ready.'
Write-Host ("ZIP:      {0}" -f $zipPath)
Write-Host ("SHA256:   {0}" -f $hash)
Write-Host ("Manifest: {0}" -f $manifestPath)
Write-Host '========================================================'

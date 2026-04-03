param(
  [switch]$SkipBuild,
  [switch]$DryRun
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

. "$PSScriptRoot/build-common.ps1"

$projectDir = Get-ProjectDir
$updateConfigPath = Join-Path $projectDir 'update-config.json'
$manifestPath = Join-Path $projectDir 'release\online-update\manifest.json'

function Ensure-FileExists {
  param(
    [string]$Path,
    [string]$Label
  )

  if (-not (Test-Path $Path)) {
    throw "$Label not found: $Path"
  }
}

function Parse-JsonFile {
  param([string]$Path)
  return (Get-Content $Path -Raw | ConvertFrom-Json)
}

function Convert-HttpUrlToOssTarget {
  param(
    [string]$Url,
    [string]$Label
  )

  if ([string]::IsNullOrWhiteSpace($Url)) {
    throw "$Label is empty."
  }

  $uri = [System.Uri]$Url
  $uriHost = $uri.Host
  $match = [regex]::Match($uriHost, '^([^.]+)\.oss-[^.]+\.aliyuncs\.com$', [System.Text.RegularExpressions.RegexOptions]::IgnoreCase)
  if (-not $match.Success) {
    throw "$Label must use the default OSS domain format: https://<bucket>.oss-<region>.aliyuncs.com/..."
  }

  $bucket = $match.Groups[1].Value
  $objectKey = $uri.AbsolutePath.TrimStart('/')
  if ([string]::IsNullOrWhiteSpace($objectKey)) {
    throw "$Label does not contain an object key: $Url"
  }

  return [PSCustomObject]@{
    Bucket = $bucket
    ObjectKey = $objectKey
    OssUrl = "oss://$bucket/$objectKey"
  }
}

function Invoke-OssUpload {
  param(
    [string]$LocalPath,
    [string]$OssPath,
    [string]$OssutilExe,
    [switch]$DryRunMode
  )

  if ($DryRunMode) {
    Write-Host ("[DRY RUN] ossutil cp `"{0}`" `"{1}`" -f" -f $LocalPath, $OssPath)
    return
  }

  & $OssutilExe cp $LocalPath $OssPath -f
  if ($LASTEXITCODE -ne 0) {
    throw "ossutil upload failed: $LocalPath -> $OssPath"
  }
}

function Resolve-OssutilExe {
  param([string]$ProjectDir)

  $command = Get-Command ossutil -ErrorAction SilentlyContinue | Select-Object -First 1
  if ($command) {
    return $command.Source
  }

  $candidates = @(
    $env:XIYIJI_OSSUTIL_PATH,
    (Join-Path $ProjectDir 'docs\ossutil-2.2.1-windows-amd64\ossutil.exe'),
    (Join-Path $ProjectDir 'tools\ossutil\ossutil.exe'),
    'D:\XYJ2\xiyiji\docs\ossutil-2.2.1-windows-amd64\ossutil.exe',
    'D:\yunyin\XYJ2\xiyiji\docs\ossutil-2.2.1-windows-amd64\ossutil.exe'
  ) | Where-Object { $_ }

  foreach ($candidate in $candidates) {
    if (Test-Path $candidate) {
      return (Resolve-Path $candidate).Path
    }
  }

  throw "ossutil not found. Put ossutil.exe in <project>\\docs\\ossutil-2.2.1-windows-amd64\\ossutil.exe or set XIYIJI_OSSUTIL_PATH."
}

function Test-HttpReachable {
  param(
    [string]$Url,
    [switch]$DryRunMode
  )

  if ($DryRunMode) {
    Write-Host ("[DRY RUN] verify {0}" -f $Url)
    return
  }

  try {
    $response = Invoke-WebRequest -Uri $Url -Method Head -UseBasicParsing -TimeoutSec 30
    if ($response.StatusCode -lt 200 -or $response.StatusCode -ge 400) {
      throw "HTTP $($response.StatusCode)"
    }
  } catch {
    throw "Public URL verification failed: $Url. $($_.Exception.Message)"
  }
}

if (-not $SkipBuild) {
  Write-Step '1/3' 'Building release artifacts'
  $npmCmd = Resolve-NpmCmd
  Invoke-CheckedCommand -FilePath $npmCmd -Arguments @('run', 'release') -WorkingDirectory $projectDir
}

Write-Step '2/3' 'Preparing OSS publish targets'
Ensure-FileExists -Path $updateConfigPath -Label 'update-config.json'
Ensure-FileExists -Path $manifestPath -Label 'manifest.json'

$updateConfig = Parse-JsonFile -Path $updateConfigPath
$manifest = Parse-JsonFile -Path $manifestPath

$zipFileName = [string]$manifest.appPackage.fileName
if ([string]::IsNullOrWhiteSpace($zipFileName)) {
  throw "manifest.json missing appPackage.fileName"
}

$zipPath = Join-Path (Join-Path $projectDir 'release\online-update') $zipFileName
Ensure-FileExists -Path $zipPath -Label 'update zip'

$manifestTarget = Convert-HttpUrlToOssTarget -Url ([string]$updateConfig.manifestUrl) -Label 'update-config.json manifestUrl'
$zipTarget = Convert-HttpUrlToOssTarget -Url ([string]$manifest.appPackage.url) -Label 'manifest.json appPackage.url'

Write-Host ("ZIP target:      {0}" -f $zipTarget.OssUrl)
Write-Host ("Manifest target: {0}" -f $manifestTarget.OssUrl)

$ossutilExe = Resolve-OssutilExe -ProjectDir $projectDir
Write-Host ("ossutil:         {0}" -f $ossutilExe)

Write-Step '3/3' 'Uploading to OSS'
Invoke-OssUpload -LocalPath $zipPath -OssPath $zipTarget.OssUrl -OssutilExe $ossutilExe -DryRunMode:$DryRun
Invoke-OssUpload -LocalPath $manifestPath -OssPath $manifestTarget.OssUrl -OssutilExe $ossutilExe -DryRunMode:$DryRun

Test-HttpReachable -Url ([string]$manifest.appPackage.url) -DryRunMode:$DryRun
Test-HttpReachable -Url ([string]$updateConfig.manifestUrl) -DryRunMode:$DryRun

Write-Host ''
Write-Host '========================================================'
Write-Host 'OSS publish completed.'
Write-Host ("Manifest URL: {0}" -f [string]$updateConfig.manifestUrl)
Write-Host ("ZIP URL:      {0}" -f [string]$manifest.appPackage.url)
Write-Host '========================================================'

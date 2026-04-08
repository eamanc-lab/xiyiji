param(
  [switch]$Full,
  [switch]$FullForce,
  [switch]$CustomerSample
)

foreach ($arg in $args) {
  switch ($arg) {
    '--full' { $Full = $true }
    '--full-force' {
      $Full = $true
      $FullForce = $true
    }
    '--customer-sample' {
      # IMPORTANT: customer-sample 不再隐含 $Full = $true。
      # customer-sample 只裁剪 db + 应用文件 + 形象素材，不需要重新复制
      # yundingyunbo_v163（30+ GB），那会触发 PowerShell Copy-Item + Move-Item
      # 流程，遇到 Windows 文件系统延迟锁会失败。
      # 如果 release 还没有 yundingyunbo_v163，下方 $needYundingCopy 检查
      # 会自动触发首次复制（fallback 安全）。
      $CustomerSample = $true
    }
  }
}

. "$PSScriptRoot/build-common.ps1"

$projectDir = Get-ProjectDir
$releaseDir = Get-ReleaseDir
$fullReleaseDir = Get-FullReleaseDir
$winUnpacked = Join-Path $releaseDir 'win-unpacked'
$npmCmd = Resolve-NpmCmd
$nodeExe = Join-Path (Resolve-NodeRuntimeDir) 'node.exe'

function Get-YundingVersion {
  param(
    [string]$BaseDir
  )

  if ([string]::IsNullOrWhiteSpace($BaseDir)) {
    return ''
  }

  $configPath = Join-Path $BaseDir 'config\config.yaml'
  if (-not (Test-Path $configPath)) {
    return ''
  }

  $match = Select-String -Path $configPath -Pattern '^\s*version:\s*(.+?)\s*$' | Select-Object -First 1
  if (-not $match) {
    return ''
  }

  return $match.Matches[0].Groups[1].Value.Trim()
}

function Move-ItemWithRetry {
  # Windows 文件系统在 Copy-Item 完成后会保留 handle / index 锁
  # （Search Indexer / Antimalware Service / metadata 同步等），导致
  # Move-Item 报"对路径访问被拒绝"。这个函数加 retry + backoff 兜底。
  # 函数有自己的作用域，参数是局部变量，避开 strict mode 的边界问题。
  param(
    [Parameter(Mandatory = $true)] [string]$Source,
    [Parameter(Mandatory = $true)] [string]$Destination,
    [int]$MaxAttempts = 5,
    [int]$DelaySeconds = 3
  )

  $attempt = 1
  while ($attempt -le $MaxAttempts) {
    try {
      Move-Item -LiteralPath $Source -Destination $Destination -ErrorAction Stop
      return
    } catch {
      $errMsg = $_.Exception.Message
      if ($attempt -ge $MaxAttempts) {
        Write-Host ("Move-ItemWithRetry failed after {0} attempts: {1}" -f $attempt, $errMsg)
        throw
      }
      Write-Host ("Move-ItemWithRetry attempt {0}/{1} failed: {2}. Retrying in {3}s..." -f $attempt, $MaxAttempts, $errMsg, $DelaySeconds)
      Start-Sleep -Seconds $DelaySeconds
      $attempt = $attempt + 1
    }
  }
}

Write-Host ''
Write-Host '========================================================'
Write-Host '  YunYing Digital Human Build & Package'
$modeLabel = if ($CustomerSample) {
  'CUSTOMER SAMPLE (szr.mp4 + ttt only, reuse existing yundingyunbo_v163 if present)'
} elseif ($Full) {
  'FULL (App + yundingyunbo v191)'
} else {
  'APP ONLY (update)'
}
Write-Host ('  Mode: {0}' -f $modeLabel)
Write-Host '========================================================'

Write-Step '0/6' 'Cleaning build caches'
Remove-IfExists (Join-Path $projectDir 'out')
Remove-IfExists (Join-Path $projectDir 'node_modules\.vite')
Remove-IfExists $winUnpacked
if (Test-Path (Join-Path $releaseDir 'builder-debug.yml')) {
  Remove-Item -LiteralPath (Join-Path $releaseDir 'builder-debug.yml') -Force
}
if (Test-Path (Join-Path $releaseDir 'builder-effective-config.yaml')) {
  Remove-Item -LiteralPath (Join-Path $releaseDir 'builder-effective-config.yaml') -Force
}
Write-Host 'Cache cleanup complete.'

Write-Step '1/6' 'Compiling protected YDB bridge bytecode'
& (Join-Path $PSScriptRoot 'protect-ydb-scripts.ps1')

Write-Step '2/6' 'Building renderer and main bundles'
Invoke-CheckedCommand -FilePath $npmCmd -Arguments @('run', 'build') -WorkingDirectory $projectDir
Write-Host 'Build complete.'

Write-Step '3/6' 'Packaging win-unpacked'
$builderEnv = @{
  ELECTRON_MIRROR = 'https://npmmirror.com/mirrors/electron/'
  ELECTRON_BUILDER_BINARIES_MIRROR = 'https://npmmirror.com/mirrors/electron-builder-binaries/'
}
Invoke-CheckedCommand -FilePath $npmCmd -Arguments @('exec', '--', 'electron-builder', '--win', '--dir') -WorkingDirectory $projectDir -ExtraEnvironment $builderEnv
if (-not (Test-Path $winUnpacked)) {
  throw "win-unpacked not found: $winUnpacked"
}
Write-Host 'Packaging complete.'

Write-Step '4/6' 'Assembling portable release'
Stop-ProcessesUnderPath -RootPath $fullReleaseDir
Remove-AppFilesPreservingRuntimeDirs -RootPath $fullReleaseDir
Copy-Item -Path (Join-Path $winUnpacked '*') -Destination $fullReleaseDir -Recurse -Force
Write-Host 'App files updated.'

$legacyDianjtDir = Join-Path $fullReleaseDir 'DIANJT'
$yundingDst = Join-Path $fullReleaseDir 'yundingyunbo_v163'
$yundingOverlayRoot = Join-Path $projectDir 'resources\yundingyunbo-overlay'

Remove-IfExists $legacyDianjtDir

if ($FullForce) {
  Remove-IfExists $yundingDst
}

$yundingSrc = Resolve-YundingyunboBase
$yundingSrcVersion = Get-YundingVersion $yundingSrc
$yundingDstVersion = Get-YundingVersion $yundingDst

$needYundingCopy = $Full -or -not (Test-Path (Join-Path $yundingDst 'live'))
if (
  -not $needYundingCopy -and
  -not [string]::IsNullOrWhiteSpace($yundingSrcVersion) -and
  -not [string]::IsNullOrWhiteSpace($yundingDstVersion) -and
  $yundingSrcVersion -ne $yundingDstVersion
) {
  Write-Host ("yundingyunbo version drift detected ({0} -> {1}), refreshing runtime." -f $yundingDstVersion, $yundingSrcVersion)
  $needYundingCopy = $true
}

if ($needYundingCopy) {
  if (-not $Full) {
    if (-not (Test-Path (Join-Path $yundingDst 'live'))) {
      Write-Host 'yundingyunbo missing in release, copying automatically.'
    } else {
      Write-Host 'yundingyunbo runtime changed, copying automatically.'
    }
  }
  $resolvedYundingSrc = (Resolve-Path $yundingSrc).Path
  $resolvedYundingDst = Resolve-Path $yundingDst -ErrorAction SilentlyContinue | ForEach-Object Path | Select-Object -First 1
  if ($resolvedYundingSrc -eq $resolvedYundingDst) {
    throw 'Full packaging needs a real yundingyunbo source directory. Set XIYIJI_YUNDINGYUNBO_SRC / YUNDINGYUNBO_SRC, or place yundingyunbo_v163 next to the project.'
  }

  $yundingStage = Join-Path $fullReleaseDir 'yundingyunbo_v163.__tmp'
  Remove-IfExists $yundingStage

  try {
    New-Item -ItemType Directory -Path $yundingStage -Force | Out-Null

    foreach ($dir in @('bin', 'live', 'config', 'env', 'env_50', 'tools')) {
      $srcDir = Join-Path $yundingSrc $dir
      if (Test-Path $srcDir) {
        Copy-Item -LiteralPath $srcDir -Destination $yundingStage -Recurse -Force
      }
    }

    # ws_danmu_capture contains volatile browser cache files and is not needed by xiyiji's runtime.
    $assetDirsToCopy = @('pretrained_models', 'plugin', 'srs', 'web')
    $assetsDst = Join-Path $yundingStage 'assets'
    New-Item -ItemType Directory -Path $assetsDst -Force | Out-Null
    foreach ($dir in $assetDirsToCopy) {
      $srcDir = Join-Path $yundingSrc ("assets\{0}" -f $dir)
      if (Test-Path $srcDir) {
        Copy-Item -LiteralPath $srcDir -Destination $assetsDst -Recurse -Force
      }
    }

    Get-ChildItem -LiteralPath $yundingSrc -File -Force | ForEach-Object {
      Copy-Item -LiteralPath $_.FullName -Destination $yundingStage -Force
    }

    foreach ($dir in @(
      'logs',
      'temp',
      'assets\characters\images',
      'assets\local_voices',
      'assets\short_images',
      'assets\short_videos'
    )) {
      New-Item -ItemType Directory -Path (Join-Path $yundingStage $dir) -Force | Out-Null
    }

    Remove-IfExists $yundingDst
    Move-ItemWithRetry -Source $yundingStage -Destination $yundingDst -MaxAttempts 5 -DelaySeconds 3
    Write-Host 'yundingyunbo copied.'
  } catch {
    Remove-IfExists $yundingStage
    throw
  }
} else {
  Write-Host 'yundingyunbo already present, skipping copy.'
}

if (Test-Path $yundingDst) {
  if (Test-Path $yundingOverlayRoot) {
    Copy-Item -Path (Join-Path $yundingOverlayRoot '*') -Destination $yundingDst -Recurse -Force
    Write-Host 'Applied yundingyunbo runtime overlay.'
  }

  $portableNodeDst = Join-Path $yundingDst 'node'
  $needNodeCopy = $Full -or -not (Test-Path (Join-Path $portableNodeDst 'node.exe'))
  if ($needNodeCopy) {
    $nodeSrc = Resolve-NodeRuntimeDir
    Remove-IfExists $portableNodeDst
    New-Item -ItemType Directory -Path $portableNodeDst -Force | Out-Null
    Get-ChildItem -LiteralPath $nodeSrc -Force | ForEach-Object {
      Copy-Item -LiteralPath $_.FullName -Destination $portableNodeDst -Recurse -Force
    }
    Write-Host 'Portable Node.js copied into yundingyunbo runtime.'
  } else {
    Write-Host 'Portable Node.js already present, skipping copy.'
  }
}

foreach ($dir in @(
  'logs',
  'heygem_data\face2face\audio',
  'heygem_data\face2face\video',
  'heygem_data\face2face\chunks',
  'heygem_data\face2face\result',
  'xiyiji_output'
)) {
  Clear-DirectoryContents (Join-Path $fullReleaseDir $dir)
}

New-Item -ItemType Directory -Path (Join-Path $fullReleaseDir 'heygem_data\yundingyunbo_characters') -Force | Out-Null
$ydbCacheIndex = Join-Path $fullReleaseDir 'heygem_data\yundingyunbo_characters\_cache.json'
if (Test-Path $ydbCacheIndex) {
  Remove-Item -LiteralPath $ydbCacheIndex -Force
}

if (Test-Path $yundingDst) {
  foreach ($dir in @(
    'logs',
    'temp',
    'assets\characters\images',
    'assets\local_voices',
    'assets\short_images',
    'assets\short_videos'
  )) {
    Clear-DirectoryContents (Join-Path $yundingDst $dir)
  }
}

Write-Host 'Seeding portable database, managed assets, and YDB caches.'
$seedArgs = @(
  (Join-Path $projectDir 'scripts\seed-portable-release.cjs'),
  '--project-dir', $projectDir,
  '--release-dir', $fullReleaseDir,
  '--skip-prewarm', '1'
)
if ($CustomerSample) {
  Write-Host 'Customer sample mode: keep szr.mp4 + ttt only, others pruned.'
  $seedArgs += @('--customer-sample', '1')
}
Invoke-CheckedCommand -FilePath $nodeExe -Arguments $seedArgs -WorkingDirectory $projectDir
Invoke-CheckedCommand -FilePath 'powershell.exe' -Arguments @(
  '-NoProfile',
  '-ExecutionPolicy', 'Bypass',
  '-File', (Join-Path $projectDir 'scripts\prewarm-release-ydb.ps1'),
  '-ProjectDir', $projectDir,
  '-ReleaseDir', $fullReleaseDir
) -WorkingDirectory $projectDir

Write-Step '5/6' 'Verifying portable release'
& (Join-Path $PSScriptRoot 'verify-release.ps1') -ReleaseDir $fullReleaseDir

Write-Step '6/6' 'Generating online update package'
& (Join-Path $PSScriptRoot 'build-update-package.ps1') -WinUnpackedDir $winUnpacked

$appAsar = Join-Path $winUnpacked 'resources\app.asar'
$appSize = if (Test-Path $appAsar) { [Math]::Round((Get-Item $appAsar).Length / 1MB, 2) } else { 0 }
$totalSize = [Math]::Round(((Get-ChildItem -LiteralPath $fullReleaseDir -Recurse -File | Measure-Object Length -Sum).Sum / 1GB), 2)

Write-Host ''
Write-Host '========================================================'
Write-Host 'Release ready.'
Write-Host "Location: $fullReleaseDir"
Write-Host "App asar: ${appSize} MB"
Write-Host "Total:    ${totalSize} GB"
Write-Host '========================================================'

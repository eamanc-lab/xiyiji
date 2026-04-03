param(
  [string]$ReleaseDir
)

$requestedReleaseDir = $ReleaseDir

. "$PSScriptRoot/build-common.ps1"

if (-not $requestedReleaseDir) {
  $requestedReleaseDir = Get-FullReleaseDir
}

$ReleaseDir = (Resolve-Path $requestedReleaseDir).Path
if (
  (Test-Path (Join-Path $ReleaseDir 'xiyiji-release')) -and
  -not (Test-Path (Join-Path $ReleaseDir 'resources\app.asar'))
) {
  $ReleaseDir = (Resolve-Path (Join-Path $ReleaseDir 'xiyiji-release')).Path
}

function Write-Verify {
  param([string]$Message)
  Write-Host ("[verify] {0}" -f $Message)
}

function Require-Path {
  param(
    [string]$Path,
    [string]$Label
  )

  if (-not (Test-Path $Path)) {
    throw ("Missing {0}: {1}" -f $Label, $Path)
  }

  Write-Verify ("ok  {0}: {1}" -f $Label, $Path)
}

function Ensure-MissingPath {
  param(
    [string]$Path,
    [string]$Label
  )

  if (Test-Path $Path) {
    throw ("Unexpected legacy artifact present for {0}: {1}" -f $Label, $Path)
  }

  Write-Verify ("ok  legacy artifact absent: {0}" -f $Label)
}

function Invoke-ExecutableProbe {
  param(
    [string]$Label,
    [string]$FilePath,
    [string[]]$Arguments
  )

  if (-not (Test-Path $FilePath)) {
    throw ("Cannot probe {0}, file missing: {1}" -f $Label, $FilePath)
  }

  $output = & $FilePath @Arguments 2>&1
  if ($LASTEXITCODE -ne 0) {
    throw ("Probe failed for {0}: {1}" -f $Label, ($output | Out-String).Trim())
  }

  $firstLine = (($output | Out-String).Trim() -split "`r?`n" | Select-Object -First 1)
  Write-Verify ("ok  {0}: {1}" -f $Label, $firstLine)
}

function Invoke-YdbBridgeSmokeTest {
  param(
    [string]$YdbBase,
    [string]$BridgeScript,
    [string]$DataDir
  )

  $python = Join-Path $YdbBase 'env\python.exe'
  Require-Path $python 'YDB python for smoke test'

  $oldPath = $env:PATH
  $oldYdbBase = $env:YUNDINGYUNBO_BASE
  $oldDataDir = $env:XIYIJI_DATA_DIR

  try {
    $env:YUNDINGYUNBO_BASE = $YdbBase
    $env:XIYIJI_DATA_DIR = $DataDir
    $env:PATH = (($oldPath -split ';') | Where-Object {
      $_ -and $_ -notmatch 'nodejs' -and $_ -notmatch '\\node($|\\)'
    }) -join ';'

    $quotedPython = '"' + $python + '"'
    $quotedBridge = '"' + $BridgeScript + '"'
    $output = cmd.exe /d /c "$quotedPython -u $quotedBridge < nul 2>&1"
    $text = ($output | Out-String)

    if ($LASTEXITCODE -ne 0) {
      throw ("YDB bridge smoke test exited with code {0}: {1}" -f $LASTEXITCODE, $text.Trim())
    }

    if ($text -notmatch '"type"\s*:\s*"ready"') {
      throw ("YDB bridge smoke test did not reach ready state. Output:`n{0}" -f $text.Trim())
    }

    Write-Verify 'ok  YDB bridge smoke test reached ready state without system Node.js in PATH'
  } finally {
    $env:PATH = $oldPath
    $env:YUNDINGYUNBO_BASE = $oldYdbBase
    $env:XIYIJI_DATA_DIR = $oldDataDir
  }
}

function Invoke-YdbInitAvatarSmokeTest {
  param(
    [string]$YdbBase,
    [string]$BridgeScript,
    [string]$DataDir,
    [string]$VideoPath
  )

  $python = Join-Path $YdbBase 'env\python.exe'
  $smokeScript = Join-Path (Get-ProjectDir) 'scripts\ydb_bridge_init_smoke.py'

  Require-Path $python 'YDB python for init-avatar smoke test'
  Require-Path $smokeScript 'YDB init-avatar smoke script'
  Require-Path $VideoPath 'YDB init-avatar smoke video'

  $output = & $python $smokeScript `
    --ydb-base $YdbBase `
    --bridge-script $BridgeScript `
    --data-dir $DataDir `
    --video $VideoPath 2>&1

  if ($LASTEXITCODE -ne 0) {
    throw ("YDB init-avatar smoke test failed: {0}" -f (($output | Out-String).Trim()))
  }

  Write-Verify 'ok  YDB init-avatar preview smoke passed'
}

Write-Verify ("release dir: {0}" -f $ReleaseDir)

$rootExe = Get-ChildItem -LiteralPath $ReleaseDir -File -Filter '*.exe' | Select-Object -First 1
if (-not $rootExe) {
  throw "No root EXE found in release directory: $ReleaseDir"
}
Write-Verify ("ok  root exe: {0}" -f $rootExe.Name)

$appAsar = Join-Path $ReleaseDir 'resources\app.asar'
$embeddedScripts = Join-Path $ReleaseDir 'resources\resources\scripts'
$embeddedFfmpeg = Join-Path $ReleaseDir 'resources\resources\ffmpeg\ffmpeg.exe'
$logsDir = Join-Path $ReleaseDir 'logs'
$portableDbDir = Join-Path $ReleaseDir 'data'
$portableDbPath = Join-Path $portableDbDir 'xiyiji.db'
$portableAvatarDir = Join-Path $portableDbDir 'avatar_videos'
$dataDir = Join-Path $ReleaseDir 'heygem_data'
$outputDir = Join-Path $ReleaseDir 'xiyiji_output'
$ydbBase = Join-Path $ReleaseDir 'yundingyunbo_v163'
$ydbPython = Join-Path $ydbBase 'env\python.exe'
$ydbNode = Join-Path $ydbBase 'node\node.exe'
$ydbFfmpeg = Join-Path $ydbBase 'env\ffmpeg\bin\ffmpeg.exe'
$ydbBridge = Join-Path $embeddedScripts 'yundingyunbo_bridge.pyc'
$ydbCameraProxy = Join-Path $embeddedScripts 'yundingyunbo_camera_proxy.pyc'
$ydbInitPatch = Join-Path $ydbBase 'tools\get_douyin_flv\src\__init__.py'
$ydbAvatarRefDir = Join-Path $dataDir 'yundingyunbo_avatar_refs'

Require-Path $appAsar 'app.asar'
Require-Path $embeddedScripts 'embedded scripts directory'
Require-Path $embeddedFfmpeg 'embedded ffmpeg.exe'
Require-Path $logsDir 'logs directory'
Require-Path $portableDbDir 'portable data directory'
Require-Path $portableDbPath 'portable sqlite database'
Require-Path $portableAvatarDir 'portable avatar video directory'
Require-Path $dataDir 'heygem_data directory'
Require-Path $outputDir 'xiyiji_output directory'
Require-Path (Join-Path $dataDir 'face2face\audio') 'face2face audio directory'
Require-Path (Join-Path $dataDir 'face2face\video') 'face2face video directory'
Require-Path (Join-Path $dataDir 'face2face\chunks') 'face2face chunks directory'
Require-Path (Join-Path $dataDir 'face2face\result') 'face2face result directory'
Require-Path (Join-Path $dataDir 'yundingyunbo_characters') 'yundingyunbo characters directory'
Require-Path $ydbAvatarRefDir 'yundingyunbo avatar reference directory'

Require-Path $ydbBase 'YDB base'
Require-Path (Join-Path $ydbBase 'live') 'YDB live directory'
Require-Path $ydbPython 'YDB python'
Require-Path $ydbNode 'YDB portable node.exe'
Require-Path $ydbFfmpeg 'YDB ffmpeg.exe'
Require-Path $ydbBridge 'YDB bridge bytecode'
Require-Path $ydbCameraProxy 'YDB camera proxy bytecode'
Require-Path $ydbInitPatch 'YDB get_douyin_flv init patch'

foreach ($legacy in @(
  @{ Path = (Join-Path $ReleaseDir 'DIANJT'); Label = 'release DIANJT directory' },
  @{ Path = (Join-Path $embeddedScripts 'dianjt_host_server.py'); Label = 'legacy DIANJT host script' },
  @{ Path = (Join-Path $embeddedScripts 'setup_core.py'); Label = 'legacy DIANJT setup script' },
  @{ Path = (Join-Path $embeddedScripts 'stream_dinet.py'); Label = 'legacy heygem stream_dinet script' },
  @{ Path = (Join-Path $embeddedScripts 'stream_server.py'); Label = 'legacy heygem stream_server script' },
  @{ Path = (Join-Path $embeddedScripts '_compile_core.bat'); Label = 'legacy core compile script' },
  @{ Path = (Join-Path $embeddedScripts '_dianjt_core.py'); Label = 'legacy core source' },
  @{ Path = (Join-Path $embeddedScripts '_dianjt_core.py.bak'); Label = 'legacy core backup' },
  @{ Path = (Join-Path $embeddedScripts '_dianjt_core.pyd'); Label = 'legacy DIANJT core binary' },
  @{ Path = (Join-Path $embeddedScripts 'yundingyunbo_bridge.py'); Label = 'YDB bridge source' },
  @{ Path = (Join-Path $embeddedScripts 'yundingyunbo_camera_proxy.py'); Label = 'YDB camera proxy source' }
)) {
  Ensure-MissingPath -Path $legacy.Path -Label $legacy.Label
}

Invoke-ExecutableProbe -Label 'YDB portable node' -FilePath $ydbNode -Arguments @('-v')
Invoke-ExecutableProbe -Label 'embedded ffmpeg' -FilePath $embeddedFfmpeg -Arguments @('-version')

Invoke-YdbBridgeSmokeTest -YdbBase $ydbBase -BridgeScript $ydbBridge -DataDir $dataDir

$previewSmokeVideo = Get-ChildItem -LiteralPath $ydbAvatarRefDir -Filter '*.mp4' -File |
  Where-Object { $_.Name -notlike 'normalized_*' } |
  Sort-Object Name |
  Select-Object -First 1
if (-not $previewSmokeVideo) {
  throw "No packaged YDB avatar reference video found in $ydbAvatarRefDir"
}

Invoke-YdbInitAvatarSmokeTest `
  -YdbBase $ydbBase `
  -BridgeScript $ydbBridge `
  -DataDir $dataDir `
  -VideoPath $previewSmokeVideo.FullName

Write-Verify 'release verification passed'

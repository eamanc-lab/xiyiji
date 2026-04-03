param(
  [string]$ReleaseDir,
  [string]$ProjectDir
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

if (-not $ProjectDir) {
  $ProjectDir = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
}

if (-not $ReleaseDir) {
  $ReleaseDir = Join-Path $ProjectDir 'release\xiyiji-release'
}

$ProjectDir = (Resolve-Path $ProjectDir).Path
$ReleaseDir = (Resolve-Path $ReleaseDir).Path

$releaseDb = Join-Path $ReleaseDir 'data\xiyiji.db'
$dataDir = Join-Path $ReleaseDir 'heygem_data'
$charactersDir = Join-Path $dataDir 'yundingyunbo_characters'
$avatarRefDir = Join-Path $dataDir 'yundingyunbo_avatar_refs'
$ydbBase = Join-Path $ReleaseDir 'yundingyunbo_v163'
$ydbPython = Join-Path $ydbBase 'env\python.exe'
$ffmpegExe = Join-Path $ydbBase 'env\ffmpeg\bin\ffmpeg.exe'
$ffprobeExe = Join-Path $ydbBase 'env\ffmpeg\bin\ffprobe.exe'
$helperScript = Join-Path $ProjectDir 'scripts\ydb_prewarm_character.py'
$avatarClipPolicyVersion = 'v3'
$avatarReferenceMaxDurationSec = 180
$avatarReferenceMinDurationSec = 30
$avatarReferenceTargetFrames = 4500

foreach ($required in @($releaseDb, $dataDir, $ydbBase, $ydbPython, $ffmpegExe, $ffprobeExe, $helperScript)) {
  if (-not (Test-Path $required)) {
    throw "Missing prewarm dependency: $required"
  }
}

New-Item -ItemType Directory -Path $avatarRefDir -Force | Out-Null

function Write-Prewarm {
  param([string]$Message)
  Write-Host ("[prewarm-ydb] {0}" -f $Message)
}

function Get-StableHash10 {
  param([string]$Value)
  $md5 = [System.Security.Cryptography.MD5]::Create()
  try {
    $bytes = [System.Text.Encoding]::UTF8.GetBytes($Value)
    $hashBytes = $md5.ComputeHash($bytes)
  } finally {
    $md5.Dispose()
  }

  $hash = -join ($hashBytes | ForEach-Object { $_.ToString('x2') })
  return $hash.Substring(0, 10)
}

function Get-FileMtimeMs {
  param([string]$Path)
  $item = Get-Item -LiteralPath $Path
  return [DateTimeOffset]::new($item.LastWriteTimeUtc).ToUnixTimeMilliseconds()
}

function Get-PreparedClipPath {
  param(
    [string]$SourcePath,
    [string]$ClipDir,
    [double]$StartSec,
    [double]$ClipDurationSec
  )

  $item = Get-Item -LiteralPath $SourcePath
  $stem = [System.IO.Path]::GetFileNameWithoutExtension($SourcePath)
  $sanitizedStem = [regex]::Replace($stem, '[^a-zA-Z0-9._-]+', '_').Trim('_')
  if (-not $sanitizedStem) {
    $sanitizedStem = 'avatar'
  }

  $startKey = '{0:N1}' -f $StartSec
  $key = [string]::Join('|', @(
    [System.IO.Path]::GetFileName($SourcePath),
    $item.Length,
    [Math]::Round((Get-FileMtimeMs -Path $SourcePath)),
    'yundingyunbo_avatar_refs',
    $ClipDurationSec,
    $avatarClipPolicyVersion,
    $startKey
  ))
  $hash = Get-StableHash10 -Value $key
  return Join-Path $ClipDir ("{0}_{1}.mp4" -f $sanitizedStem, $hash)
}

function Clamp-Double {
  param(
    [double]$Value,
    [double]$Min,
    [double]$Max
  )

  if ($Value -lt $Min) { return $Min }
  if ($Value -gt $Max) { return $Max }
  return $Value
}

function Round-ClipSecond {
  param([double]$Value)
  return [Math]::Max(0, [Math]::Round($Value, 1))
}

function Get-AvatarReferenceClipStart {
  param(
    [double]$Duration,
    [double]$MaxDurationSec
  )

  $maxStartSec = [Math]::Max(0, $Duration - $MaxDurationSec)
  if ($maxStartSec -le 0) {
    return 0
  }

  if ($Duration -ge 600) {
    $targetFraction = 0.35
  } elseif ($Duration -ge 180) {
    $targetFraction = 0.25
  } else {
    $targetFraction = 0.15
  }

  $minStartTarget = if ($Duration -ge 180) { 8 } else { 3 }
  $minStartSec = [Math]::Min($maxStartSec, $minStartTarget)
  $preferredStartSec = Clamp-Double -Value ($Duration * $targetFraction) -Min $minStartSec -Max $maxStartSec
  return Round-ClipSecond -Value $preferredStartSec
}

function Get-VideoDuration {
  param([string]$Path)

  $jsonText = & $ffprobeExe -v quiet -print_format json -show_format -show_streams $Path
  if ($LASTEXITCODE -ne 0) {
    throw "ffprobe failed for: $Path"
  }

  $json = $jsonText | ConvertFrom-Json
  if ($null -ne $json -and $null -ne $json.format -and $null -ne $json.format.duration) {
    return [double]$json.format.duration
  }
  return 0
}

function Get-VideoInfo {
  param([string]$Path)

  $jsonText = & $ffprobeExe -v quiet -print_format json -show_format -show_streams $Path
  if ($LASTEXITCODE -ne 0) {
    throw "ffprobe failed for: $Path"
  }

  $json = $jsonText | ConvertFrom-Json
  $duration = 0.0
  if ($null -ne $json -and $null -ne $json.format -and $null -ne $json.format.duration) {
    $duration = [double]$json.format.duration
  }

  $fps = 25.0
  $videoStream = $null
  if ($null -ne $json -and $null -ne $json.streams) {
    $videoStream = @($json.streams | Where-Object { $_.codec_type -eq 'video' } | Select-Object -First 1)[0]
  }
  if ($null -ne $videoStream -and -not [string]::IsNullOrWhiteSpace([string]$videoStream.r_frame_rate)) {
    $parts = ([string]$videoStream.r_frame_rate).Split('/', 2)
    if ($parts.Count -eq 2) {
      $num = [double]$parts[0]
      $den = [double]$parts[1]
      if ([Math]::Abs($den) -gt 0.000001) {
        $fps = [Math]::Max(1.0, [Math]::Round($num / $den))
      }
    }
  }

  return @{
    duration = $duration
    fps = $fps
  }
}

function Resolve-AvatarReferenceClipDurationSec {
  param(
    [double]$Duration,
    [double]$Fps
  )

  if ($avatarReferenceMaxDurationSec -le 0) {
    return 0.0
  }

  if ($Duration -le 0) {
    return [double]$avatarReferenceMaxDurationSec
  }

  if ($Fps -le 0) {
    $Fps = 25.0
  }

  $frameLimitedDuration = if ($avatarReferenceTargetFrames -gt 0) {
    [double]$avatarReferenceTargetFrames / $Fps
  } else {
    [double]$avatarReferenceMaxDurationSec
  }
  $effectiveMinDuration = [Math]::Min($Duration, [double]$avatarReferenceMinDurationSec)
  $effectiveMaxDuration = [Math]::Min($Duration, [double]$avatarReferenceMaxDurationSec)
  return Round-ClipSecond -Value (Clamp-Double -Value $frameLimitedDuration -Min $effectiveMinDuration -Max $effectiveMaxDuration)
}

function Ensure-PreparedReferenceClip {
  param([string]$SourcePath)

  $videoInfo = Get-VideoInfo -Path $SourcePath
  $clipDurationSec = Resolve-AvatarReferenceClipDurationSec -Duration ([double]$videoInfo.duration) -Fps ([double]$videoInfo.fps)
  if ($clipDurationSec -le 0 -or [double]$videoInfo.duration -le ($clipDurationSec + 0.5)) {
    return $SourcePath
  }

  $startSec = Get-AvatarReferenceClipStart -Duration ([double]$videoInfo.duration) -MaxDurationSec $clipDurationSec
  $clipPath = Get-PreparedClipPath -SourcePath $SourcePath -ClipDir $avatarRefDir -StartSec $startSec -ClipDurationSec $clipDurationSec
  if (Test-Path $clipPath) {
    $clipDuration = Get-VideoDuration -Path $clipPath
    if ($clipDuration -gt 0 -and $clipDuration -le ($clipDurationSec + 1.0)) {
      return $clipPath
    }
  }

  & $ffmpegExe -ss $startSec -i $SourcePath -t $clipDurationSec -c:v libx264 -preset ultrafast -crf 18 -c:a copy -y $clipPath | Out-Host
  if ($LASTEXITCODE -ne 0) {
    throw "ffmpeg failed while creating prepared clip: $clipPath"
  }

  return $clipPath
}

$avatarQuery = @'
import json
import sqlite3
import sys

conn = sqlite3.connect(sys.argv[1])
cur = conn.cursor()
cur.execute("SELECT DISTINCT file_path FROM avatar_videos WHERE TRIM(COALESCE(file_path,'')) <> '' ORDER BY created_at DESC")
rows = [row[0] for row in cur.fetchall() if row and row[0]]
conn.close()
print(json.dumps(rows, ensure_ascii=False))
'@

$avatarJson = $avatarQuery | & $ydbPython - $releaseDb
if ($LASTEXITCODE -ne 0) {
  throw 'Failed to query avatar_videos from portable database.'
}

$avatarPaths = @()
if ($avatarJson) {
  $parsedAvatarPaths = $avatarJson | ConvertFrom-Json
  if ($parsedAvatarPaths -is [System.Array]) {
    $avatarPaths = $parsedAvatarPaths
  } elseif ($null -ne $parsedAvatarPaths) {
    $avatarPaths = @($parsedAvatarPaths)
  }
}

if (-not $avatarPaths -or $avatarPaths.Count -eq 0) {
  Write-Prewarm 'No avatar videos found; skipping YDB cache prewarm.'
  return
}

$uniquePaths = @($avatarPaths | Where-Object { $_ } | Sort-Object -Unique)
Write-Prewarm ("Prewarming {0} avatar video(s)" -f $uniquePaths.Count)

foreach ($avatarPath in $uniquePaths) {
  if (-not (Test-Path $avatarPath)) {
    throw "Avatar video missing during prewarm: $avatarPath"
  }

  $preparedPath = Ensure-PreparedReferenceClip -SourcePath $avatarPath
  Write-Prewarm ("Preparing cache for {0}" -f ([System.IO.Path]::GetFileName($preparedPath)))

  & $ydbPython $helperScript --ydb-base $ydbBase --data-dir $dataDir --video $preparedPath | Out-Host
  if ($LASTEXITCODE -ne 0) {
    throw "YDB cache prewarm failed for: $preparedPath"
  }
}

Get-ChildItem -LiteralPath $charactersDir -Directory -ErrorAction SilentlyContinue | ForEach-Object {
  $paramsPath = Join-Path $_.FullName 'params.json'
  $framesDir = Join-Path $_.FullName 'frames'
  $frameCount = (Get-ChildItem -LiteralPath $framesDir -Force -ErrorAction SilentlyContinue | Measure-Object).Count
  if ((-not (Test-Path $paramsPath)) -or (-not (Test-Path $framesDir)) -or $frameCount -le 0) {
    Write-Prewarm ("Removing invalid character cache: {0}" -f $_.FullName)
    Remove-Item -LiteralPath $_.FullName -Recurse -Force -ErrorAction SilentlyContinue
  }
}

Write-Prewarm 'YDB cache prewarm complete.'

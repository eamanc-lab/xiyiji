param(
  [string]$LogsDir = "$env:APPDATA\xiyiji\logs",
  [int]$Tail = 0
)

if (-not (Test-Path $LogsDir)) {
  Write-Output "AUTO-JUNC REPORT: logs dir not found: $LogsDir"
  exit 0
}

$latest = Get-ChildItem $LogsDir -File | Sort-Object LastWriteTime -Descending | Select-Object -First 1
if (-not $latest) {
  Write-Output "AUTO-JUNC REPORT: no log files in $LogsDir"
  exit 0
}

$lines = Get-Content $latest.FullName
if ($Tail -gt 0 -and $lines.Count -gt $Tail) {
  $lines = $lines[($lines.Count - $Tail)..($lines.Count - 1)]
}

$startPat = '\[AUTO-JUNC\] start id=(\d+) holdMs=(\d+)'
$donePat = '\[AUTO-JUNC\] done id=(\d+) reason=([a-zA-Z\-]+) gapMs=(\d+) fallbackFrames=(\d+) smooth=(\d+) holdMs=(\d+)'
$fallbackPat = '\[AUTO-JUNC\] fallback frame id=(\d+) count=(\d+)'

$starts = @()
$done = @()
$fallback = @()

foreach ($line in $lines) {
  if ($line -match $startPat) {
    $starts += [pscustomobject]@{
      id = [int]$matches[1]
      hold_ms = [int]$matches[2]
    }
    continue
  }
  if ($line -match $donePat) {
    $done += [pscustomobject]@{
      id = [int]$matches[1]
      reason = $matches[2]
      gap_ms = [int]$matches[3]
      fallback_frames = [int]$matches[4]
      smooth = [int]$matches[5]
      hold_ms = [int]$matches[6]
    }
    continue
  }
  if ($line -match $fallbackPat) {
    $fallback += [pscustomobject]@{
      id = [int]$matches[1]
      count = [int]$matches[2]
    }
  }
}

Write-Output "AUTO-JUNC REPORT"
Write-Output "log_file=$($latest.FullName)"
Write-Output "starts=$($starts.Count) done=$($done.Count) fallback_logs=$($fallback.Count)"

if ($done.Count -eq 0) {
  Write-Output "no AUTO-JUNC done records yet."
  exit 0
}

$avgGap = [math]::Round((($done | Measure-Object gap_ms -Average).Average), 1)
$maxGap = ($done | Measure-Object gap_ms -Maximum).Maximum
$avgSmooth = [math]::Round((($done | Measure-Object smooth -Average).Average), 1)
$minSmooth = ($done | Measure-Object smooth -Minimum).Minimum
$avgHold = [math]::Round((($done | Measure-Object hold_ms -Average).Average), 1)
$totalFallback = ($done | Measure-Object fallback_frames -Sum).Sum
$worst = $done | Sort-Object @{Expression='smooth';Descending=$false}, @{Expression='gap_ms';Descending=$true} | Select-Object -First 5

Write-Output "avg_gap_ms=$avgGap max_gap_ms=$maxGap avg_smooth=$avgSmooth min_smooth=$minSmooth avg_hold_ms=$avgHold total_fallback_frames=$totalFallback"
if ($avgGap -le 500 -and $minSmooth -ge 45) {
  Write-Output "quality=GOOD"
} elseif ($avgGap -le 850 -and $minSmooth -ge 20) {
  Write-Output "quality=FAIR"
} else {
  Write-Output "quality=POOR"
}
Write-Output "worst_junctions(top5):"
foreach ($w in $worst) {
  Write-Output "id=$($w.id) reason=$($w.reason) gap_ms=$($w.gap_ms) fallback=$($w.fallback_frames) smooth=$($w.smooth) hold_ms=$($w.hold_ms)"
}

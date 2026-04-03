Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$script:ProjectDir = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$script:ReleaseDir = Join-Path $script:ProjectDir 'release'
$script:FullReleaseDir = Join-Path $script:ReleaseDir 'xiyiji-release'

function Get-ProjectDir {
  return $script:ProjectDir
}

function Get-ReleaseDir {
  return $script:ReleaseDir
}

function Get-FullReleaseDir {
  return $script:FullReleaseDir
}

function Write-Step {
  param(
    [string]$Step,
    [string]$Message
  )

  Write-Host ''
  Write-Host ('=' * 56)
  Write-Host ("[{0}] {1}" -f $Step, $Message)
  Write-Host ('=' * 56)
}

function Resolve-NpmCmd {
  $command = Get-Command 'npm.cmd' -ErrorAction SilentlyContinue | Select-Object -First 1
  if ($command) {
    return $command.Source
  }

  $candidates = @()
  if ($env:ProgramFiles) {
    $candidates += (Join-Path $env:ProgramFiles 'nodejs\npm.cmd')
  }
  if (${env:ProgramFiles(x86)}) {
    $candidates += (Join-Path ${env:ProgramFiles(x86)} 'nodejs\npm.cmd')
  }
  if ($env:LocalAppData) {
    $candidates += (Join-Path $env:LocalAppData 'Programs\nodejs\npm.cmd')
  }
  if ($env:NVM_HOME) {
    $candidates += (Join-Path $env:NVM_HOME 'npm.cmd')
  }

  foreach ($candidate in $candidates) {
    if (Test-Path $candidate) {
      return (Resolve-Path $candidate).Path
    }
  }

  throw 'npm.cmd not found. Please install Node.js and ensure npm is available.'
}

function Resolve-NodeRuntimeDir {
  $nodeCommand = Get-Command 'node' -ErrorAction SilentlyContinue | Select-Object -First 1
  $npmCmd = $null
  try {
    $npmCmd = Resolve-NpmCmd
  } catch {
    $npmCmd = $null
  }

  $candidates = @(
    $env:XIYIJI_NODE_RUNTIME_SRC,
    $env:NODE_RUNTIME_SRC,
    $env:NODEJS_HOME,
    $env:NVM_SYMLINK,
    $(if ($nodeCommand) { Split-Path $nodeCommand.Source -Parent }),
    $(if ($npmCmd) { Split-Path $npmCmd -Parent }),
    $(if ($env:ProgramFiles) { Join-Path $env:ProgramFiles 'nodejs' }),
    $(if (${env:ProgramFiles(x86)}) { Join-Path ${env:ProgramFiles(x86)} 'nodejs' }),
    $(if ($env:LocalAppData) { Join-Path $env:LocalAppData 'Programs\nodejs' })
  ) | Where-Object { $_ } | Select-Object -Unique

  foreach ($candidate in $candidates) {
    if (Test-Path (Join-Path $candidate 'node.exe')) {
      return (Resolve-Path $candidate).Path
    }
  }

  throw 'Node.js runtime not found. Please install Node.js or set XIYIJI_NODE_RUNTIME_SRC / NODE_RUNTIME_SRC.'
}

function Invoke-CheckedCommand {
  param(
    [string]$FilePath,
    [string[]]$Arguments = @(),
    [string]$WorkingDirectory = (Get-ProjectDir),
    [hashtable]$ExtraEnvironment = @{},
    [switch]$PassThruOutput
  )

  Push-Location $WorkingDirectory
  try {
    foreach ($entry in $ExtraEnvironment.GetEnumerator()) {
      Set-Item -Path ("Env:{0}" -f $entry.Key) -Value $entry.Value
    }

    if ($PassThruOutput) {
      & $FilePath @Arguments
    } else {
      & $FilePath @Arguments | Out-Host
    }

    if ($LASTEXITCODE -ne 0) {
      throw ("Command failed ({0} {1}) with exit code {2}" -f $FilePath, ($Arguments -join ' '), $LASTEXITCODE)
    }
  } finally {
    Pop-Location
  }
}

function Remove-PathWithRetry {
  param(
    [string]$Path,
    [int]$RetryCount = 5,
    [int]$DelayMs = 400
  )

  if (-not (Test-Path $Path)) {
    return
  }

  for ($attempt = 1; $attempt -le $RetryCount; $attempt++) {
    try {
      Remove-Item -LiteralPath $Path -Recurse -Force -ErrorAction Stop
      return
    } catch {
      if ($attempt -ge $RetryCount) {
        throw
      }
      Start-Sleep -Milliseconds $DelayMs
    }
  }
}

function Stop-ProcessesUnderPath {
  param([string]$RootPath)

  if (-not (Test-Path $RootPath)) {
    return
  }

  $resolvedRoot = ((Resolve-Path $RootPath).Path).TrimEnd('\')

  try {
    $processes = Get-CimInstance Win32_Process -ErrorAction Stop | Where-Object {
      $exePath = [string]$_.ExecutablePath
      $exePath -and $exePath.StartsWith($resolvedRoot, [System.StringComparison]::OrdinalIgnoreCase)
    } | Sort-Object ProcessId -Descending
  } catch {
    Write-Warning ("Failed to enumerate processes under {0}: {1}" -f $resolvedRoot, $_.Exception.Message)
    return
  }

  foreach ($process in $processes) {
    try {
      Stop-Process -Id $process.ProcessId -Force -ErrorAction Stop
      Write-Host ("Stopped release process: {0} ({1})" -f $process.Name, $process.ProcessId)
    } catch {
      Write-Warning ("Failed to stop process {0} ({1}): {2}" -f $process.Name, $process.ProcessId, $_.Exception.Message)
    }
  }

  if ($processes) {
    Start-Sleep -Seconds 1
  }
}

function Remove-IfExists {
  param([string]$Path)
  if (Test-Path $Path) {
    Remove-PathWithRetry -Path $Path
  }
}

function Clear-DirectoryContents {
  param([string]$Path)

  if (-not (Test-Path $Path)) {
    New-Item -ItemType Directory -Path $Path -Force | Out-Null
    return
  }

  Get-ChildItem -LiteralPath $Path -Force | ForEach-Object {
    Remove-PathWithRetry -Path $_.FullName
  }
}

function Remove-AppFilesPreservingRuntimeDirs {
  param([string]$RootPath)

  if (-not (Test-Path $RootPath)) {
    New-Item -ItemType Directory -Path $RootPath -Force | Out-Null
    return
  }

  $preserve = @('DIANJT', 'yundingyunbo_v163', 'heygem_data', 'data')
  Get-ChildItem -LiteralPath $RootPath -Force | ForEach-Object {
    if ($preserve -contains $_.Name) {
      return
    }
    Remove-PathWithRetry -Path $_.FullName
  }
}

function Get-SearchRoots {
  $roots = @()
  $projectDir = Get-ProjectDir
  $projectParent = Split-Path $projectDir -Parent
  $projectGrandParent = Split-Path $projectParent -Parent
  $projectDrive = [System.IO.Path]::GetPathRoot($projectDir)
  $userProfileDrive = if ($env:USERPROFILE) { [System.IO.Path]::GetPathRoot($env:USERPROFILE) } else { $null }

  foreach ($candidate in @($projectDir, $projectParent, $projectGrandParent, $projectDrive, $userProfileDrive)) {
    if ($candidate -and (Test-Path $candidate)) {
      $roots += (Resolve-Path $candidate).Path
    }
  }

  return $roots | Select-Object -Unique
}

function Find-DirectoryByNameAndMarker {
  param(
    [string]$RootPath,
    [string]$TargetName,
    [string]$MarkerRelativePath,
    [int]$MaxDepth = 4
  )

  if (-not (Test-Path $RootPath)) {
    return $null
  }

  $queue = New-Object 'System.Collections.Generic.Queue[object]'
  $queue.Enqueue([PSCustomObject]@{ Path = (Resolve-Path $RootPath).Path; Depth = 0 })

  while ($queue.Count -gt 0) {
    $item = $queue.Dequeue()
    if ($item.Depth -gt $MaxDepth) {
      continue
    }

    try {
      $children = Get-ChildItem -LiteralPath $item.Path -Directory -Force -ErrorAction Stop
    } catch {
      continue
    }

    foreach ($child in $children) {
      if ($child.Name -ieq $TargetName) {
        $marker = Join-Path $child.FullName $MarkerRelativePath
        if (Test-Path $marker) {
          return $child.FullName
        }
      }

      if ($item.Depth + 1 -le $MaxDepth) {
        $queue.Enqueue([PSCustomObject]@{ Path = $child.FullName; Depth = $item.Depth + 1 })
      }
    }
  }

  return $null
}

function Resolve-DianjtBase {
  $projectDir = Get-ProjectDir
  $releaseDianjtBase = (Join-Path (Get-FullReleaseDir) 'DIANJT')
  $candidates = @(
    $env:XIYIJI_DIANJT_SRC,
    $env:DIANJT_SRC,
    $env:DIANJT_BASE,
    (Join-Path $projectDir 'DIANJT\DianJT_Pro'),
    (Join-Path $projectDir 'DIANJT'),
    (Join-Path $projectDir 'vendor\DIANJT\DianJT_Pro'),
    (Join-Path $projectDir 'vendor\DIANJT'),
    (Join-Path (Split-Path $projectDir -Parent) 'DIANJT\DianJT_Pro'),
    (Join-Path (Split-Path $projectDir -Parent) 'DIANJT')
  ) | Where-Object { $_ }

  foreach ($candidate in $candidates) {
    if (Test-Path (Join-Path $candidate 'heyi\python.exe')) {
      return (Resolve-Path $candidate).Path
    }
    $nested = Join-Path $candidate 'DianJT_Pro'
    if (Test-Path (Join-Path $nested 'heyi\python.exe')) {
      return (Resolve-Path $nested).Path
    }
  }

  foreach ($root in (Get-SearchRoots)) {
    $found = Find-DirectoryByNameAndMarker -RootPath $root -TargetName 'DianJT_Pro' -MarkerRelativePath 'heyi\python.exe' -MaxDepth 4
    if ($found) {
      $resolvedFound = (Resolve-Path $found).Path
      if (-not $resolvedFound.StartsWith($releaseDianjtBase, [System.StringComparison]::OrdinalIgnoreCase)) {
        return $resolvedFound
      }
    }
  }

  foreach ($candidate in @(
    (Join-Path (Get-FullReleaseDir) 'DIANJT\DianJT_Pro'),
    (Join-Path (Get-FullReleaseDir) 'DIANJT')
  )) {
    if (Test-Path (Join-Path $candidate 'heyi\python.exe')) {
      return (Resolve-Path $candidate).Path
    }
    $nested = Join-Path $candidate 'DianJT_Pro'
    if (Test-Path (Join-Path $nested 'heyi\python.exe')) {
      return (Resolve-Path $nested).Path
    }
  }

  throw 'DIANJT runtime not found. Set DIANJT_BASE / XIYIJI_DIANJT_SRC or place DIANJT near the project/release folder.'
}

function Resolve-YundingyunboBase {
  $projectDir = Get-ProjectDir
  $projectParent = Split-Path $projectDir -Parent
  $projectGrandParent = Split-Path $projectParent -Parent
  $releaseYundingBase = (Join-Path (Get-FullReleaseDir) 'yundingyunbo_v163')
  $candidates = @(
    $env:XIYIJI_YUNDINGYUNBO_SRC,
    $env:YUNDINGYUNBO_SRC,
    $env:YUNDINGYUNBO_BASE,
    (Join-Path $projectDir 'yundingyunbo_v163'),
    (Join-Path $projectDir 'vendor\yundingyunbo_v163'),
    (Join-Path $projectParent 'yundingyunbo_v163'),
    (Join-Path $projectGrandParent 'yundingyunbo_v163')
  ) | Where-Object { $_ }

  foreach ($candidate in $candidates) {
    if (Test-Path (Join-Path $candidate 'live')) {
      return (Resolve-Path $candidate).Path
    }
    $nested = Join-Path $candidate 'yundingyunbo_v163'
    if (Test-Path (Join-Path $nested 'live')) {
      return (Resolve-Path $nested).Path
    }
  }

  foreach ($root in (Get-SearchRoots)) {
    $found = Find-DirectoryByNameAndMarker -RootPath $root -TargetName 'yundingyunbo_v163' -MarkerRelativePath 'live' -MaxDepth 4
    if ($found) {
      $resolvedFound = (Resolve-Path $found).Path
      if (-not $resolvedFound.StartsWith($releaseYundingBase, [System.StringComparison]::OrdinalIgnoreCase)) {
        return $resolvedFound
      }
    }
  }

  foreach ($candidate in @(
    (Join-Path (Get-FullReleaseDir) 'yundingyunbo_v163')
  )) {
    if (Test-Path (Join-Path $candidate 'live')) {
      return (Resolve-Path $candidate).Path
    }
    $nested = Join-Path $candidate 'yundingyunbo_v163'
    if (Test-Path (Join-Path $nested 'live')) {
      return (Resolve-Path $nested).Path
    }
  }

  throw 'yundingyunbo runtime not found. Set YUNDINGYUNBO_BASE / XIYIJI_YUNDINGYUNBO_SRC or place yundingyunbo_v163 near the project/release folder.'
}

function Resolve-VcVars64Bat {
  if ($env:VCINSTALLDIR -and (Test-Path (Join-Path $env:VCINSTALLDIR 'Auxiliary\Build\vcvars64.bat'))) {
    return (Join-Path $env:VCINSTALLDIR 'Auxiliary\Build\vcvars64.bat')
  }

  if (${env:ProgramFiles(x86)}) {
    $vswhere = Join-Path ${env:ProgramFiles(x86)} 'Microsoft Visual Studio\Installer\vswhere.exe'
    if (Test-Path $vswhere) {
      $installPath = & $vswhere -latest -products * -requires Microsoft.VisualStudio.Component.VC.Tools.x86.x64 -property installationPath
      if ($LASTEXITCODE -eq 0 -and $installPath) {
        $candidate = Join-Path $installPath 'VC\Auxiliary\Build\vcvars64.bat'
        if (Test-Path $candidate) {
          return $candidate
        }
      }
    }
  }

  $fallbacks = @()
  if (${env:ProgramFiles(x86)}) {
    $fallbacks += (Join-Path ${env:ProgramFiles(x86)} 'Microsoft Visual Studio\2022\BuildTools\VC\Auxiliary\Build\vcvars64.bat')
    $fallbacks += (Join-Path ${env:ProgramFiles(x86)} 'Microsoft Visual Studio\2022\Community\VC\Auxiliary\Build\vcvars64.bat')
  }

  foreach ($candidate in $fallbacks) {
    if (Test-Path $candidate) {
      return $candidate
    }
  }

  throw 'Visual Studio C++ Build Tools not found. Please install Desktop development with C++.'
}

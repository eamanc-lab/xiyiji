Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

. "$PSScriptRoot/build-common.ps1"

$projectDir = Get-ProjectDir
$ydbBase = Resolve-YundingyunboBase
$pythonExe = Join-Path $ydbBase 'env\python.exe'

if (-not (Test-Path $pythonExe)) {
  throw "Yundingyunbo Python not found: $pythonExe"
}

$scriptPaths = @(
  (Join-Path $projectDir 'resources\scripts\yundingyunbo_bridge.py'),
  (Join-Path $projectDir 'resources\scripts\yundingyunbo_camera_proxy.py')
)

foreach ($scriptPath in $scriptPaths) {
  if (-not (Test-Path $scriptPath)) {
    throw "Protected YDB script missing: $scriptPath"
  }
}

$pythonCode = @'
import py_compile
import sys
from pathlib import Path

for raw in sys.argv[1:]:
    src = Path(raw)
    dst = src.with_suffix(src.suffix + "c")
    py_compile.compile(str(src), cfile=str(dst), doraise=True)
    print(f"[protect-ydb] compiled {src.name} -> {dst.name}")
'@

[string]$tempScript = Join-Path ([System.IO.Path]::GetTempPath()) ("xiyiji_protect_ydb_" + [System.Guid]::NewGuid().ToString('N') + '.py')
Set-Content -LiteralPath $tempScript -Value $pythonCode -Encoding UTF8

try {
  & $pythonExe $tempScript @scriptPaths
  if ($LASTEXITCODE -ne 0) {
    throw 'Failed to compile protected YDB scripts.'
  }
} finally {
  if (Test-Path $tempScript) {
    Remove-Item -LiteralPath $tempScript -Force
  }
}

foreach ($scriptPath in $scriptPaths) {
  $compiledPath = "$scriptPath" + 'c'
  if (-not (Test-Path $compiledPath)) {
    throw "Protected YDB bytecode missing after compile: $compiledPath"
  }
}

Write-Host '[protect-ydb] Bytecode refresh complete.'

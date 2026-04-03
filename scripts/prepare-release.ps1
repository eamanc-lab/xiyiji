. "$PSScriptRoot/build-common.ps1"

Write-Step '1/2' 'Building Windows installer'
& powershell -NoProfile -ExecutionPolicy Bypass -File (Join-Path $PSScriptRoot 'build-win.ps1')
if ($LASTEXITCODE -ne 0) {
  exit $LASTEXITCODE
}

Write-Step '2/2' 'Building full portable release'
& powershell -NoProfile -ExecutionPolicy Bypass -File (Join-Path $PSScriptRoot 'build-release.ps1') --full
if ($LASTEXITCODE -ne 0) {
  exit $LASTEXITCODE
}

Write-Host 'Installer + portable release are ready in the release directory.'

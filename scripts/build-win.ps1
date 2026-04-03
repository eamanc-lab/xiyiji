. "$PSScriptRoot/build-common.ps1"

$projectDir = Get-ProjectDir
$npmCmd = Resolve-NpmCmd

Write-Step '1/2' 'Building renderer and main bundles'
Invoke-CheckedCommand -FilePath $npmCmd -Arguments @('run', 'build') -WorkingDirectory $projectDir

Write-Step '2/2' 'Packaging Windows installer'
$builderEnv = @{
  ELECTRON_MIRROR = 'https://npmmirror.com/mirrors/electron/'
  ELECTRON_BUILDER_BINARIES_MIRROR = 'https://npmmirror.com/mirrors/electron-builder-binaries/'
}
Invoke-CheckedCommand -FilePath $npmCmd -Arguments @('exec', '--', 'electron-builder', '--win') -WorkingDirectory $projectDir -ExtraEnvironment $builderEnv

Write-Host 'Windows packaging complete.'

$projectDir = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$outputPath = Join-Path $projectDir 'tmp\pipeline\test_tone.wav'
$outputDir = Split-Path $outputPath -Parent
New-Item -ItemType Directory -Path $outputDir -Force | Out-Null

$sampleRate = 16000
$channels = 1
$bitsPerSample = 16
$durationSeconds = 2
$numSamples = $sampleRate * $durationSeconds
$dataSize = $numSamples * $channels * ($bitsPerSample / 8)
$headerSize = 44
$totalSize = $headerSize + $dataSize

$bytes = New-Object byte[] $totalSize
$ms = New-Object System.IO.MemoryStream($bytes, $true)
$bw = New-Object System.IO.BinaryWriter($ms)

$bw.Write([System.Text.Encoding]::ASCII.GetBytes('RIFF'))
$bw.Write([int]($totalSize - 8))
$bw.Write([System.Text.Encoding]::ASCII.GetBytes('WAVE'))
$bw.Write([System.Text.Encoding]::ASCII.GetBytes('fmt '))
$bw.Write([int]16)
$bw.Write([int16]1)
$bw.Write([int16]$channels)
$bw.Write([int]$sampleRate)
$bw.Write([int]($sampleRate * $channels * $bitsPerSample / 8))
$bw.Write([int16]($channels * $bitsPerSample / 8))
$bw.Write([int16]$bitsPerSample)
$bw.Write([System.Text.Encoding]::ASCII.GetBytes('data'))
$bw.Write([int]$dataSize)

for ($i = 0; $i -lt $numSamples; $i++) {
    $val = [int16]([Math]::Sin(2 * [Math]::PI * 440 * $i / $sampleRate) * 16000)
    $bw.Write($val)
}

$bw.Close()
[System.IO.File]::WriteAllBytes($outputPath, $bytes)
Write-Host "WAV file created: $totalSize bytes"

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$projectDir = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$outDir = Join-Path $projectDir 'tmp\bench_audio_tts10_full'
New-Item -ItemType Directory -Force -Path $outDir | Out-Null
Get-ChildItem $outDir -Filter '*.wav' -ErrorAction SilentlyContinue | Remove-Item -Force

Add-Type -AssemblyName System.Speech
$synth = New-Object System.Speech.Synthesis.SpeechSynthesizer
$synth.SelectVoice('Microsoft Zira Desktop')
$synth.Rate = -1
$synth.Volume = 100

$texts = @(
  'Sentence one is a complete speech sample with a clean ending.',
  'Sentence two checks whether the lip motion keeps matching the spoken rhythm.',
  'Sentence three verifies that no random cut appears in the middle of playback.',
  'Sentence four focuses on smooth transition from one segment to the next.',
  'Sentence five includes short pauses to test natural continuity and timing.',
  'Sentence six is slightly faster to stress the realtime generation pipeline.',
  'Sentence seven checks frame stability and avoids sudden jumps or flicker.',
  'Sentence eight validates that the final word is not clipped at segment boundaries.',
  'Sentence nine confirms audio and video remain synchronized from start to end.',
  'Sentence ten is the final full sample to confirm no truncation in source audio.'
)

$meta = @()
for ($i = 0; $i -lt $texts.Count; $i++) {
  $idx = $i + 1
  $name = ('t{0:D2}.wav' -f $idx)
  $path = Join-Path $outDir $name
  $synth.SetOutputToWaveFile($path)
  $synth.Speak($texts[$i])
  $synth.SetOutputToNull()

  $fi = Get-Item $path
  $meta += [PSCustomObject]@{
    index = $idx
    file = $name
    bytes = $fi.Length
    text = $texts[$i]
  }
}

$meta | ConvertTo-Json -Depth 4 | Set-Content -Path (Join-Path $outDir 'manifest.json') -Encoding UTF8
Write-Output "Generated $($texts.Count) files in $outDir"
Get-ChildItem $outDir -Filter '*.wav' | Sort-Object Name | Select-Object Name,Length

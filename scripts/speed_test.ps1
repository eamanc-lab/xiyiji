$startTime = Get-Date

Write-Host "Waiting for container to be free..."
do {
    Start-Sleep -Seconds 3
    $body = '{"video_url":"/data/face2face/video/avatar_007e72c8-e501-45e1-833b-71b3c5edcaf7_szr.mp4","audio_url":"/data/face2face/audio/test_tone.wav","code":"speed_test_final","chaofen":0,"watermark_switch":0,"pn":1}'
    $submit = Invoke-RestMethod -Uri "http://127.0.0.1:8383/easy/submit" -Method Post -ContentType "application/json" -Body $body
} while ($submit.msg -eq [char]0x5FD9 + [char]0x788C + [char]0x4E2D)

$startTime = Get-Date
Write-Host "Submitted at $startTime"

do {
    Start-Sleep -Seconds 2
    $r = Invoke-RestMethod -Uri "http://127.0.0.1:8383/easy/query?code=speed_test_final"
    $elapsed = [int]((Get-Date) - $startTime).TotalSeconds
    Write-Host "  Status=$($r.data.status) Progress=$($r.data.progress) Time=${elapsed}s"
} while ($r.data.status -eq 0 -or $r.data.status -eq 1)

$totalTime = [int]((Get-Date) - $startTime).TotalSeconds
Write-Host ""
Write-Host "=== Result ==="
Write-Host "Audio: 2 seconds"
Write-Host "Process: ${totalTime} seconds"
$rtf = [math]::Round($totalTime / 2, 1)
Write-Host "RTF: $rtf"
Write-Host "Status: $($r.data.status)"
Write-Host "Msg: $($r.data.msg)"

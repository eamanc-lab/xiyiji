# 自动创建数据目录结构脚本（在 4090 机器上运行）

param(
    [string]$BasePath = "E:\heygem_data"
)

Write-Host "========================================" -ForegroundColor Cyan
Write-Host "西忆集 - 创建数据目录" -ForegroundColor Cyan
Write-Host "========================================" -ForegroundColor Cyan
Write-Host ""

Write-Host "目标路径: $BasePath" -ForegroundColor Yellow
Write-Host ""

$directories = @(
    $BasePath,
    "$BasePath\face2face",
    "$BasePath\face2face\video",
    "$BasePath\face2face\audio",
    "$BasePath\face2face\result",
    "$BasePath\voice",
    "$BasePath\voice\data"
)

foreach ($dir in $directories) {
    if (Test-Path $dir) {
        Write-Host "  ✓ 已存在: $dir" -ForegroundColor Green
    } else {
        try {
            New-Item -Path $dir -ItemType Directory -Force | Out-Null
            Write-Host "  + 已创建: $dir" -ForegroundColor Cyan
        } catch {
            Write-Host "  ✗ 创建失败: $dir" -ForegroundColor Red
            Write-Host "    错误: $_" -ForegroundColor Gray
        }
    }
}

Write-Host ""
Write-Host "========================================" -ForegroundColor Cyan
Write-Host "目录创建完成！" -ForegroundColor Green
Write-Host ""
Write-Host "下一步:" -ForegroundColor Yellow
Write-Host "  1. 复制形象视频到: $BasePath\face2face\video\" -ForegroundColor Gray
Write-Host "  2. 复制测试音频到: $BasePath\face2face\audio\" -ForegroundColor Gray
Write-Host "  3. 修改 electron\config.ts 中的 data_dir 路径为: $BasePath" -ForegroundColor Gray
Write-Host "========================================" -ForegroundColor Cyan

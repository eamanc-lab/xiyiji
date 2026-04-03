@echo off
setlocal
chcp 65001 >nul 2>&1
title YunYing Build

echo.
echo ========================================
echo   YunYing Digital Human - Build
echo ========================================
echo.
set "SCRIPT_DIR=%~dp0"
set "PS_CMD=powershell -NoProfile -ExecutionPolicy Bypass"

%PS_CMD% -File "%SCRIPT_DIR%scripts\build-release.ps1" %*
if %ERRORLEVEL% NEQ 0 (
    echo [ERROR] Build failed!
    pause
    exit /b %ERRORLEVEL%
)

echo.
pause

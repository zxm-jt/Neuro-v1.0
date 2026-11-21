@echo off
if /i not "%~1"=="--child" (
    start "" /min "%~f0" --child
    exit /b
)
chcp 65001 >nul
cd /d %~dp0

set "ELECTRON_RUN_AS_NODE="
set "NODE_OPTIONS="



if not exist "%~dp0logs" mkdir "%~dp0logs" >nul
if not exist "%~dp0node_modules\electron\dist\electron.exe" (
    echo [start] Electron is not installed yet.
    echo [start] Run tools\install_deps.bat once, or copy node_modules here.
    pause
    exit /b 1
)
"%~dp0node_modules\electron\dist\electron.exe" . --disable-gpu --disable-gpu-compositing --no-sandbox >> "%~dp0logs\electron_console.log" 2>&1
exit /b

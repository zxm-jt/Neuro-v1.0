@echo off
setlocal
chcp 65001 >nul
cd /d %~dp0..

if not defined NEURO_PY set "NEURO_PY=python"
if not exist "%NEURO_PY%" (
    where python >nul 2>nul
    if errorlevel 1 (
        echo [flybridge] python not found. Set NEURO_PY to a Python 3.10+ with numba.
        pause
        exit /b 1
    )
    set "NEURO_PY=python"
)

"%NEURO_PY%" -m flybridge.brain_server --port 6007 --hz 30
if errorlevel 1 (
    echo.
    echo [flybridge] exited with error. State is in flybridge\state\
    pause
)
endlocal

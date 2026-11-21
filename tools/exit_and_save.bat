@echo off
setlocal
cd /d "%~dp0.."
if not exist "%~dp0..\config.json" (
    echo [exit] this does not look like the Neuro folder: config.json missing
    pause
    exit /b 1
)
> "%~dp0..\.quit_request" echo quit
echo [exit] wrote .quit_request
echo [exit] Neuro will say goodbye, save memory, then close by itself.
echo [exit] if it does not close within 30s, close the window manually.
timeout /t 3 >nul
endlocal

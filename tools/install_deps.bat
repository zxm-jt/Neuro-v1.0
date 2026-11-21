@echo off
cd /d "%~dp0.."

where npm >nul 2>nul
if errorlevel 1 (
    echo [deps] npm not found - install Node.js first, then run this again.
) else (
    echo [deps] npm install ...
    call npm install
)

if not defined PY set PY=python
echo [deps] pip install -r backend\requirements.txt ...
"%PY%" -m pip install -r "backend\requirements.txt"

echo.
echo Done. Now run start_neuro.bat
pause

@echo off
chcp 65001 >nul
title Neuro Chat Log
set LOG=%~dp0..\backend\chat_log.txt

if not exist "%LOG%" (
  type nul > "%LOG%"
)

echo.
echo ==================================================
echo   Neuro backend chat log
echo   ASR transcript / her reply / intent routing
echo   Auto-refreshes every 3s. Close this window to exit.
echo ==================================================
echo.

:loop
echo.
echo ---------- latest ----------
powershell -NoProfile -Command "[Console]::OutputEncoding=[System.Text.Encoding]::UTF8; Get-Content -Path '%LOG%' -Tail 25 -Encoding UTF8"
echo.
echo [refreshing every 3s ...]
timeout /t 3 >nul
goto loop

# ============================================================================
# tests/run_all.ps1 -- one command to run every regression check we own
# ============================================================================
# ASCII-ONLY ON PURPOSE: Windows PowerShell 5.1 reads .ps1 as ANSI unless it
# has a UTF-8 BOM; non-ASCII text then becomes parse errors (same lesson as
# start_neuro.bat and tools/hide_windows.ps1 in this project).
#
# Covers:
#   1. python syntax of every backend module
#   2. node --check on every front-end js file
#   3. every unit test we added (node + python)
#
# Usage:
#   powershell -NoProfile -ExecutionPolicy Bypass -File tests\run_all.ps1
# ============================================================================
$ErrorActionPreference = 'Continue'
$root = Split-Path -Parent $PSScriptRoot
Set-Location $root

$node = Join-Path $root 'node\node.exe'
if (-not (Test-Path $node)) { $node = 'node' }
# NOTE: this project ships a venv, so the interpreter lives in python\Scripts\,
# NOT python\ directly. Try both, then fall back to whatever is on PATH.
$py = Join-Path $root 'python\Scripts\python.exe'
if (-not (Test-Path $py)) { $py = Join-Path $root 'python\python.exe' }
if (-not (Test-Path $py)) { $py = 'python' }
# Windows default GBK console turns the test output's non-ASCII into
# UnicodeEncodeError, which would look like a test failure.
$env:PYTHONIOENCODING = 'utf-8'

$fail = 0
function Step($name, $block) {
    Write-Host ("== " + $name) -ForegroundColor Cyan
    $code = 0
    try { & $block; $code = $LASTEXITCODE } catch { $code = 99 }
    if ($code -ne 0) { Write-Host ("   FAILED (exit " + $code + ")") -ForegroundColor Red; $script:fail++ }
    else { Write-Host "   ok" -ForegroundColor Green }
}

Step 'python syntax (backend/*.py)' {
    & $py -m compileall -q backend 2>&1 | Out-Null
}

# config.json must NOT carry a UTF-8 BOM: Python's json.load(open(..., encoding='utf-8'))
# raises "Unexpected UTF-8 BOM" and the backend then runs with DEFAULT config.
Step 'config.json has no BOM' {
    $bytes = [System.IO.File]::ReadAllBytes((Join-Path $root 'config.json'))
    $bad = ($bytes.Length -ge 3 -and $bytes[0] -eq 0xEF -and $bytes[1] -eq 0xBB -and $bytes[2] -eq 0xBF)
    if ($bad) { Write-Host '   config.json starts with UTF-8 BOM -> python json.load will fail' -ForegroundColor Red }
    $global:LASTEXITCODE = if ($bad) { 1 } else { 0 }
}

Step 'node --check (front-end)' {
    $bad = 0
    Get-ChildItem (Join-Path $root 'js') -File -Filter '*.js' | ForEach-Object {
        & $node --check $_.FullName 2>$null
        if ($LASTEXITCODE -ne 0) { Write-Host ("   syntax: " + $_.Name) -ForegroundColor Red; $bad++ }
    }
    if ($bad -gt 0) { $global:LASTEXITCODE = 1 }
}

$jsTests = @(
    'tests\check_brevity.js'
)
foreach ($t in $jsTests) {
    if (-not (Test-Path (Join-Path $root $t))) { continue }
    Step ("node " + $t) { & $node (Join-Path $root $t) 2>&1 | Out-Null }
}

$pyTests = @(
    'tests\check_persona.py',
    'tests\check_example_reuse.py',
    'tests\check_short_reply_flush.py',
    'tests\check_subtitle_order.py',
    'tests\check_tts_playback_loop.py'
)
foreach ($t in $pyTests) {
    if (-not (Test-Path (Join-Path $root $t))) { continue }
    Step ("python " + $t) { & $py $t 2>&1 | Out-Null }
}

Write-Host ''
if ($fail -eq 0) { Write-Host 'ALL GREEN' -ForegroundColor Green; exit 0 }
Write-Host ('' + $fail + ' STEP(S) FAILED') -ForegroundColor Red
exit 1

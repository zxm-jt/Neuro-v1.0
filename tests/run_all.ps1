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
#   4. OPTIONAL: live checks (-Live) that need the app running on :9222/:6006
#
# Usage:
#   powershell -NoProfile -ExecutionPolicy Bypass -File tests\run_all.ps1
#   powershell -NoProfile -ExecutionPolicy Bypass -File tests\run_all.ps1 -Live
# ============================================================================
param([switch]$Live)

$ErrorActionPreference = 'Continue'
$root = Split-Path -Parent $PSScriptRoot
Set-Location $root

$node = Join-Path $root 'node\node.exe'
$py = 'python'   # 用你环境里的 Python 3.10+（或先 set PY=...）
if (-not (Test-Path $node)) { $node = 'node' }
if (-not (Test-Path $py)) { $py = 'python' }
# Windows 默认 GBK 控制台会把测试里的 ✓/中文转义符号打成 UnicodeEncodeError
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
# (PowerShell 5.1's `Set-Content -Encoding UTF8` DOES add a BOM -- this has bitten us.)
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
    foreach ($f in 'js\app.js', 'js\main.js') {
        & $node --check (Join-Path $root $f) 2>$null
        if ($LASTEXITCODE -ne 0) { Write-Host ("   syntax: " + $f) -ForegroundColor Red; $bad++ }
    }
    if ($bad -gt 0) { $global:LASTEXITCODE = 1 }
}

# Auto-discover tests\check_*.js / check_*.py. Adding a test needs no edit here.
$jsTests = Get-ChildItem (Join-Path $root 'tests') -File -Filter 'check_*.js' | Sort-Object Name
foreach ($t in $jsTests) {
    Step ("node tests\" + $t.Name) { & $node $t.FullName 2>&1 | Out-Null }
}

$pyTests = Get-ChildItem (Join-Path $root 'tests') -File -Filter 'check_*.py' | Sort-Object Name
foreach ($t in $pyTests) {
    Step ("python tests\" + $t.Name) { & $py $t.FullName 2>&1 | Out-Null }
}

if ($Live) {
    Step 'live: renderer via CDP (:9222)' {
        $r = Invoke-WebRequest -Uri 'http://127.0.0.1:9222/json/version' -TimeoutSec 5 -UseBasicParsing
        Write-Host ("   " + $r.Content)
        if ($r.StatusCode -ne 200) { $global:LASTEXITCODE = 1 }
    }
    Step 'live: backend health (:6006)' {
        $r = Invoke-WebRequest -Uri 'http://127.0.0.1:6006/v1/stream-health' -TimeoutSec 5 -UseBasicParsing
        Write-Host ("   " + $r.Content)
        if ($r.StatusCode -ne 200) { $global:LASTEXITCODE = 1 }
    }
}

Write-Host ''
if ($fail -eq 0) { Write-Host 'ALL GREEN' -ForegroundColor Green; exit 0 }
Write-Host ('' + $fail + ' STEP(S) FAILED') -ForegroundColor Red
exit 1

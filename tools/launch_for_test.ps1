# ============================================================================
# tools/launch_for_test.ps1 -- SAFE headless-ish launch for verification only
# ============================================================================
# WHY THIS EXISTS (2026-11-15 02:39):
#   During automated checks I launched the pet with --mute-audio while the
#   owner was actually talking to it. The app answered silently (they heard
#   nothing) and its ASR consumed their speech. That must never happen again.
#
# WHAT IT DOES
#   1. Refuses to start if the pet is ALREADY running (never kills it).
#   2. Refuses to start if chat_log.txt shows a "cmd:" line in the last
#      <Quiet> seconds -> assumes the owner is actively using the pet.
#   3. Starts Electron muted, with remote debugging, in a hidden window.
#   4. Waits <Seconds> seconds, prints diagnostics, then quits GRACEFULLY
#      (writes .quit_request, same path as the desktop close bat).
#
# Usage:
#   powershell -NoProfile -ExecutionPolicy Bypass -File tools\launch_for_test.ps1
#   ... -Seconds 25 -Quiet 180
# ============================================================================
param(
    [int]$Seconds = 25,
    [int]$Quiet = 180,        # seconds of "no cmd: line" required before we start
    [int]$DebugPort = 9222
)

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
Set-Location $root

$electron = Join-Path $root 'node_modules\electron\dist\electron.exe'
if (-not (Test-Path $electron)) { Write-Host 'electron.exe not found' -ForegroundColor Red; exit 2 }

# ---- 1) already running? ----
$running = @(Get-Process electron -ErrorAction SilentlyContinue)
if ($running.Count -gt 0) {
    Write-Host ('REFUSING: electron already running (pids: ' + (($running | ForEach-Object { $_.Id }) -join ', ') + ')') -ForegroundColor Yellow
    Write-Host 'The owner may be using the pet right now. Not touching it.' -ForegroundColor Yellow
    exit 3
}

# ---- 2) recent owner activity? ----
$logPath = Join-Path $root 'backend\chat_log.txt'
if (Test-Path $logPath) {
    $recent = Get-Content $logPath -Encoding UTF8 -Tail 20 | Where-Object { $_ -match '\]\s*cmd:' }
    if ($recent) {
        $last = $recent[-1]
        $m = [regex]::Match($last, '^\[(\d{2}):(\d{2}):(\d{2})\]')
        if ($m.Success) {
            $today = Get-Date
            $t = Get-Date -Hour ([int]$m.Groups[1].Value) -Minute ([int]$m.Groups[2].Value) -Second ([int]$m.Groups[3].Value)
            $age = ($today - $t).TotalSeconds
            if ($age -lt $Quiet) {
                Write-Host ('REFUSING: owner spoke to the pet ' + [int]$age + 's ago (' + $last + ')') -ForegroundColor Yellow
                Write-Host ('Wait until quiet, or pass -Quiet 0 to override.' ) -ForegroundColor Yellow
                exit 4
            }
            Write-Host ('last owner line was ' + [int]$age + 's ago -> quiet enough') -ForegroundColor Green
        }
    }
}

# ---- 3) launch muted ----
$out = Join-Path $root 'logs\launch_for_test.out'
$err = Join-Path $root 'logs\launch_for_test.err'
Remove-Item $out, $err -ErrorAction SilentlyContinue
$env:ELECTRON_RUN_AS_NODE = ''
$args = @('.', '--disable-gpu', '--disable-gpu-compositing', '--no-sandbox', '--mute-audio',
          ('--remote-debugging-port=' + $DebugPort))
$p = Start-Process -FilePath $electron -ArgumentList $args -RedirectStandardOutput $out -RedirectStandardError $err -PassThru -WindowStyle Hidden
Write-Host ('launched pid=' + $p.Id + ' (muted, will quit in ' + $Seconds + 's)') -ForegroundColor Cyan

# ---- 4) wait + diagnostics ----
Start-Sleep -Seconds $Seconds
Write-Host '--- backend health'
try {
    $h = Invoke-WebRequest -Uri 'http://127.0.0.1:6006/v1/stream-health' -TimeoutSec 5 -UseBasicParsing
    Write-Host $h.Content
} catch { Write-Host ('health failed: ' + $_.Exception.Message) -ForegroundColor Yellow }

Write-Host '--- renderer (CDP)'
$node = Join-Path $root 'node\node.exe'
if (-not (Test-Path $node)) { $node = 'node' }
try { & $node (Join-Path $root 'tests\probe_renderer.js') $DebugPort } catch { Write-Host 'probe failed' -ForegroundColor Yellow }

# ---- 5) graceful quit ----
Set-Content -LiteralPath (Join-Path $root '.quit_request') -Value 'quit' -Encoding UTF8
for ($i = 0; $i -lt 30; $i++) {
    Start-Sleep -Milliseconds 500
    if (-not (Get-Process electron -ErrorAction SilentlyContinue)) { break }
}
Write-Host 'quit done'

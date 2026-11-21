# ============================================================================
# tools/hide_windows.ps1 -- temporarily hide specific windows (read-only)
# ============================================================================
# WHY: during end-to-end checks we need to see the full-screen transparent
# pet window (character + state ring). The "Neuro Chat Room" / "Neuro Console"
# windows normally cover it. This only calls ShowWindow(SW_HIDE); restarting
# the app restores everything. No program state is modified.
#
# NOTE: keep this file ASCII-only. Windows PowerShell 5.1 reads .ps1 as ANSI
# unless it has a UTF-8 BOM, and Chinese text gets mangled into parse errors
# (same lesson as start_neuro.bat in this project).
#
# Usage: powershell -NoProfile -ExecutionPolicy Bypass -File tools\hide_windows.ps1
# ============================================================================
Add-Type @"
using System;
using System.Runtime.InteropServices;
using System.Text;
public class Win32Hide {
    [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr hWnd, int nCmdShow);
    [DllImport("user32.dll")] public static extern int GetWindowText(IntPtr hWnd, StringBuilder text, int count);
    [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr hWnd);
    [DllImport("user32.dll")] public static extern bool EnumWindows(EnumWindowsProc lpEnumFunc, IntPtr lParam);
    public delegate bool EnumWindowsProc(IntPtr hWnd, IntPtr lParam);
}
"@

$targets = @('Neuro Chat Room', 'Neuro Console')
$script:hidden = @()

$cb = [Win32Hide+EnumWindowsProc]{
    param($hWnd, $lParam)
    $sb = New-Object System.Text.StringBuilder 512
    [void][Win32Hide]::GetWindowText($hWnd, $sb, 512)
    $t = $sb.ToString()
    foreach ($want in $targets) {
        if ($t -eq $want -and [Win32Hide]::IsWindowVisible($hWnd)) {
            [void][Win32Hide]::ShowWindow($hWnd, 0)   # SW_HIDE
            $script:hidden += $t
        }
    }
    return $true
}
[void][Win32Hide]::EnumWindows($cb, [IntPtr]::Zero)
if ($script:hidden.Count -eq 0) {
    Write-Output 'no visible Neuro window found (not opened yet?)'
} else {
    Write-Output ('hidden: ' + ($script:hidden -join ', '))
}

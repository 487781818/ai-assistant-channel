# cleanup-mei-orphans.ps1
# PyInstaller onefile programs extract themselves into %TEMP%\_MEI* on every
# start and delete the folder on clean exit. When the process is killed
# (taskkill /F, crash, forced update), the folder stays behind as an orphan
# (~126 MB each for a Playwright-sized bundle). They add up fast.
#
# This script deletes every _MEI* folder EXCEPT the live one. A folder is
# treated as live when some running process started within 5 seconds of the
# folder's creation time (the extraction happens at process start).
#
# Run:  powershell -NoProfile -ExecutionPolicy Bypass -File cleanup-mei-orphans.ps1
# Dry:  add -WhatIf to only report.

param([switch]$WhatIf)

$ErrorActionPreference = 'SilentlyContinue'
$procs = Get-Process | Where-Object { $_.StartTime }
$dirs = Get-ChildItem $env:TEMP -Directory -Filter '_MEI*' -Force
$freed = 0; $kept = @(); $deleted = 0

foreach ($d in $dirs) {
    $live = $procs | Where-Object { [math]::Abs(($d.CreationTime - $_.StartTime).TotalSeconds) -lt 5 }
    if ($live) { $kept += $d.Name; continue }
    $size = (Get-ChildItem -LiteralPath $d.FullName -Recurse -Force | Measure-Object -Property Length -Sum).Sum
    if ($WhatIf) {
        Write-Host ("WOULD DELETE  {0}  {1} MB" -f $d.Name, [math]::Round($size / 1MB, 1))
    } else {
        Remove-Item -LiteralPath $d.FullName -Recurse -Force
        if (Test-Path $d.FullName) { Write-Host ("FAILED        {0}" -f $d.Name) }
        else { $deleted++; $freed += $size; Write-Host ("DELETED       {0}  {1} MB" -f $d.Name, [math]::Round($size / 1MB, 1)) }
    }
}
Write-Host ("Kept live:    {0}" -f ($kept -join ', '))
Write-Host ("Deleted:      {0} folders, {1} MB freed" -f $deleted, [math]::Round($freed / 1MB, 1))

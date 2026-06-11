$lines = Get-Content 'c:\Users\Khalid\Desktop\GitHub\AzTracker\AzTracker\src\routes\crm_dashboard.js'
$tabLines = 0
$spaceLines = 0
$mixedLines = 0
$total = $lines.Count

for ($i = 0; $i -lt $total; $i++) {
    $line = $lines[$i]
    if ($line.Trim() -eq '') { continue }
    $indent = $line -replace '^(\s+).*', '$1'
    $hasTab = $indent -match "`t"
    $hasSpace = $indent -match ' '
    if ($hasTab -and $hasSpace) { $mixedLines++ }
    elseif ($hasTab) { $tabLines++ }
    elseif ($hasSpace) { $spaceLines++ }
}

Write-Output "Total lines: $total"
Write-Output "Tab-indented lines: $tabLines"
Write-Output "Space-indented lines: $spaceLines"
Write-Output "Mixed indent lines: $mixedLines"

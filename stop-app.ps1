$ErrorActionPreference = "SilentlyContinue"

$port = 3001
$connections = Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction SilentlyContinue

if (-not $connections) {
  Write-Host "No SLP Knowledge Assistant server is listening on port $port." -ForegroundColor Yellow
  exit 0
}

$pids = $connections | Select-Object -ExpandProperty OwningProcess -Unique
foreach ($processId in $pids) {
  $process = Get-Process -Id $processId -ErrorAction SilentlyContinue
  if ($process) {
    Write-Host "Stopping process $processId ($($process.ProcessName)) on port $port..." -ForegroundColor Yellow
    Stop-Process -Id $processId -Force
  }
}

Write-Host "SLP Knowledge Assistant server stopped." -ForegroundColor Green

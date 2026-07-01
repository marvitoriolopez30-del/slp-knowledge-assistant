$ErrorActionPreference = "Stop"

$Root = Split-Path -Parent $MyInvocation.MyCommand.Path
Set-Location $Root

function Get-LocalIPv4 {
  Get-NetIPAddress -AddressFamily IPv4 |
    Where-Object {
      $_.IPAddress -notlike "127.*" -and
      $_.IPAddress -notlike "169.254.*" -and
      $_.PrefixOrigin -ne "WellKnown"
    } |
    Select-Object -ExpandProperty IPAddress -First 1
}

Write-Host "Starting SLP Knowledge Assistant..." -ForegroundColor Green

if (-not (Test-Path "node_modules")) {
  Write-Host "node_modules is missing. Running npm install..." -ForegroundColor Yellow
  npm install
}

if (-not (Test-Path "dist\index.html")) {
  Write-Host "dist build is missing. Running npm run build..." -ForegroundColor Yellow
  npm run build
}

$ip = Get-LocalIPv4
$localUrl = "http://localhost:3001"
$lanUrl = if ($ip) { "http://$ip`:3001" } else { "http://PC_IP_ADDRESS:3001" }

Write-Host ""
Write-Host "Local URL: $localUrl" -ForegroundColor Cyan
Write-Host "LAN URL:   $lanUrl" -ForegroundColor Cyan
Write-Host ""
Write-Host "If Windows Firewall asks, allow Node.js on Private networks." -ForegroundColor Yellow
Write-Host "Keep this window open while using the app. Press Ctrl+C to stop." -ForegroundColor Yellow

Start-Process $localUrl
$env:PORT = "3001"
npm start

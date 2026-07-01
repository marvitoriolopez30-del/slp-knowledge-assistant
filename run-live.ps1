$ErrorActionPreference = "Stop"

$projectRoot = Split-Path -Parent $MyInvocation.MyCommand.Path
Set-Location $projectRoot

function Test-PortInUse {
    param([int]$Port)

    $connection = Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue
    return $null -ne $connection
}

function Test-ApiIsCurrent {
    try {
        $health = Invoke-RestMethod -Uri "http://127.0.0.1:3001/api/health" -Method Get -TimeoutSec 3
        return $health.ok -eq $true -and ($health.service -eq "api" -or $health.service -eq "slp-knowledge-assistant-api")
    }
    catch {
        return $false
    }
}

function Stop-PortProcess {
    param([int]$Port)

    $processIds = Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue |
        Select-Object -ExpandProperty OwningProcess -Unique

    foreach ($processId in $processIds) {
        if ($processId -and $processId -ne $PID) {
            Stop-Process -Id $processId -Force -ErrorAction SilentlyContinue
        }
    }
}

Write-Host ""
Write-Host "Starting SLP Knowledge Assistant live dev servers..." -ForegroundColor Cyan
Write-Host "Project: $projectRoot" -ForegroundColor DarkGray
Write-Host ""

if (-not (Test-Path "node_modules")) {
    Write-Host "node_modules was not found. Installing dependencies first..." -ForegroundColor Yellow
    npm.cmd install
    Write-Host ""
}

$lanIp = (Get-NetIPAddress -AddressFamily IPv4 |
    Where-Object {
        $_.IPAddress -notlike "127.*" -and
        $_.IPAddress -notlike "169.254.*" -and
        $_.PrefixOrigin -ne "WellKnown"
    } |
    Select-Object -First 1 -ExpandProperty IPAddress)

Write-Host "API server: http://localhost:3001" -ForegroundColor Green
Write-Host "App URL:    http://localhost:5173" -ForegroundColor Green
if ($lanIp) {
    Write-Host "LAN URL:    http://$($lanIp):5173" -ForegroundColor Green
}
Write-Host ""
Write-Host "In your IDE, open: Command Palette -> Simple Browser: Show" -ForegroundColor Green
Write-Host "Then paste: http://localhost:5173" -ForegroundColor Green
if ($lanIp) {
    Write-Host "On another phone/PC on the same Wi-Fi, open: http://$($lanIp):5173" -ForegroundColor Green
}
Write-Host ""
Write-Host "Press Ctrl+C in this terminal to stop the app." -ForegroundColor DarkGray
Write-Host ""

$apiStdOut = Join-Path $projectRoot "api-server.out.log"
$apiStdErr = Join-Path $projectRoot "api-server.err.log"
if (Test-Path $apiStdOut) { Remove-Item $apiStdOut -Force -ErrorAction SilentlyContinue }
if (Test-Path $apiStdErr) { Remove-Item $apiStdErr -Force -ErrorAction SilentlyContinue }
Write-Host "API startup logs: stdout=$apiStdOut stderr=$apiStdErr" -ForegroundColor DarkGray

$apiProcess = $null
$startedApi = $false

try {
    if (Test-PortInUse -Port 3001) {
        if (Test-ApiIsCurrent) {
            Write-Host "Restarting the existing API server on port 3001 so code changes are used..." -ForegroundColor Yellow
            Stop-PortProcess -Port 3001
            Start-Sleep -Seconds 1
        }
        else {
            throw "Port 3001 is in use, but it is not the current API server. Stop the old server using port 3001, then run this script again."
        }
    }

    if (-not (Test-PortInUse -Port 3001)) {
        Write-Host "Starting Express API on http://localhost:3001..." -ForegroundColor Cyan
        $apiProcess = Start-Process -FilePath "npm.cmd" -ArgumentList @("run", "dev:api") -WorkingDirectory $projectRoot -RedirectStandardOutput $apiStdOut -RedirectStandardError $apiStdErr -PassThru -WindowStyle Hidden
        $startedApi = $true

        Start-Sleep -Seconds 4

        if (-not (Test-ApiIsCurrent)) {
            Write-Host "The API server did not start correctly on port 3001." -ForegroundColor Red
            Write-Host "See the backend startup logs at: stdout=$apiStdOut stderr=$apiStdErr" -ForegroundColor Yellow
            throw "The API server did not start correctly on port 3001. See stdout=$apiStdOut stderr=$apiStdErr for details."
        }
    }

    Write-Host ""
    Write-Host "Starting Vite app on http://localhost:5173..." -ForegroundColor Cyan
    Write-Host ""

    npm.cmd run dev:web -- --host 0.0.0.0
}
finally {
    if ($startedApi -and $apiProcess) {
        Write-Host ""
        Write-Host "Stopping Express API server..." -ForegroundColor DarkGray
        Stop-Process -Id $apiProcess.Id -Force -ErrorAction SilentlyContinue
    }
}

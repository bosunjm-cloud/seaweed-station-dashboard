<#
.SYNOPSIS
    Scheduled runner for the Seaweed Station ThingSpeak downloader.
.DESCRIPTION
    Called by Windows Task Scheduler.
    Reads config.json (written by settings.html), then invokes download_data.ps1
    with the configured parameters.
    Logs output to .\logs\download_YYYYMMDD.log

    To register the scheduled task, run the schtasks command shown in settings.html,
    or use the Task Scheduler GUI to point the action at:
        powershell.exe -NonInteractive -ExecutionPolicy Bypass -File "C:\...\apply_schedule.ps1"
#>

$ErrorActionPreference = "Stop"
$scriptDir = $PSScriptRoot

# -- Ensure logs folder -------------------------------------------------------
$logDir = Join-Path $scriptDir "logs"
if (!(Test-Path $logDir)) {
    New-Item -ItemType Directory -Path $logDir -Force | Out-Null
}

$logFile = Join-Path $logDir ("download_" + (Get-Date -Format "yyyyMMdd") + ".log")

# -- Tee output to both console and log file ----------------------------------
function Write-Log {
    param([string]$Message, [string]$Color = "")
    $ts = Get-Date -Format "HH:mm:ss"
    $line = "[$ts] $Message"
    if ($Color) {
        Write-Host $line -ForegroundColor $Color
    } else {
        Write-Host $line
    }
    Add-Content -Path $logFile -Value $line -Encoding UTF8
}

Write-Log "===== apply_schedule.ps1 started ====="
Write-Log "Script folder: $scriptDir"

# -- Read config.json ---------------------------------------------------------
$cfgFile = Join-Path $scriptDir "config.json"
$maxResults    = 8000
$retentionDays = 90
$scheduleType  = "daily"

if (Test-Path $cfgFile) {
    try {
        $cfg = [System.IO.File]::ReadAllText($cfgFile, [System.Text.Encoding]::UTF8) | ConvertFrom-Json
        if ($cfg.scheduleType)                                          { $scheduleType  = $cfg.scheduleType }
        if ($cfg.maxResults   -and $cfg.maxResults   -gt 0)             { $maxResults    = [int]$cfg.maxResults }
        if ($cfg.retentionDays -and $cfg.retentionDays -gt 0)           { $retentionDays = [int]$cfg.retentionDays }

        Write-Log "Config loaded from config.json"
        Write-Log "  ScheduleType : $scheduleType"
        Write-Log "  MaxResults   : $maxResults"
        Write-Log "  Retention    : $retentionDays days"

        # Log channel info
        if ($cfg.channels -and $cfg.channels.Count -gt 0) {
            Write-Log "  Channels     : $($cfg.channels.Count)"
            foreach ($ch in $cfg.channels) {
                $cid = if ($ch.channelId) { $ch.channelId } else { "(not configured)" }
                Write-Log "    - $($ch.name): $cid -> $($ch.dataFolder)/"
            }
        }
        elseif ($cfg.channelId) {
            Write-Log "  Channel (legacy): $($cfg.channelId)"
        }
    }
    catch {
        Write-Log "WARNING: Could not read config.json ($_) -- using defaults" "Yellow"
    }
} else {
    Write-Log "config.json not found, using defaults" "Yellow"
}

# -- Call download_data.ps1 ---------------------------------------------------
$downloaderScript = Join-Path $scriptDir "download_data.ps1"

if (!(Test-Path $downloaderScript)) {
    Write-Log "ERROR: download_data.ps1 not found at $downloaderScript" "Red"
    exit 1
}

Write-Log "Invoking download_data.ps1..."

try {
    & $downloaderScript `
        -MaxResults    $maxResults `
        -RetentionDays $retentionDays `
        -ScheduleType  $scheduleType 2>&1 | ForEach-Object {
            $line = "[$( Get-Date -Format 'HH:mm:ss' )] $_"
            Write-Host $line
            Add-Content -Path $logFile -Value $line -Encoding UTF8
        }

    Write-Log "===== apply_schedule.ps1 finished OK ====="
}
catch {
    Write-Log "ERROR during download: $_" "Red"
    Write-Log "===== apply_schedule.ps1 FAILED =====" "Red"
    exit 1
}

# -- Trim old log files (keep last 30 days) -----------------------------------
$cutoff = (Get-Date).AddDays(-30)
Get-ChildItem -Path $logDir -Filter "download_*.log" -ErrorAction SilentlyContinue |
    Where-Object { $_.CreationTime -lt $cutoff } |
    Remove-Item -Force

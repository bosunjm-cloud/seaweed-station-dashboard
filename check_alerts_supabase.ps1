# check_alerts_supabase.ps1
# Monitors Supabase sensor_readings and opens/closes GitHub Issues for alert conditions.
# Called by GitHub Actions after every data download.
#
# Alerts checked:
#   ALL stations : device offline  (no new data for > OFFLINE_HOURS)
#   ALL stations : battery critical (battery_pct < BATTERY_CRITICAL %)
#   ALL stations : battery low      (battery_pct < BATTERY_LOW %)
#   ALL stations : overtemp         (temp_1 or temp_2 > TEMP_CRITICAL degC)
#
# Deduplication: uses gh issue list to avoid re-opening an already-open issue.
# Auto-close:    when a condition clears the matching issue is closed automatically.
#
# Requires: gh CLI authenticated via GH_TOKEN environment variable (automatic in Actions)

param(
    [switch]$DryRun
)

Set-StrictMode -Off
$ErrorActionPreference = "Continue"

$OFFLINE_HOURS    = 3
$BATTERY_CRITICAL = 10
$BATTERY_LOW      = 25
$TEMP_CRITICAL    = 65

# ═══════════════════════════════════════════════════════════════════
# LOAD CONFIG
# ═══════════════════════════════════════════════════════════════════

$supabaseUrl = ""
$supabaseKey = ""

$cfgFile = Join-Path $PSScriptRoot "config.json"
if (Test-Path $cfgFile) {
    try {
        $fileJson = [System.IO.File]::ReadAllText($cfgFile, [System.Text.Encoding]::UTF8) | ConvertFrom-Json
        if ($fileJson.supabaseUrl)     { $supabaseUrl = $fileJson.supabaseUrl }
        if ($fileJson.supabaseAnonKey) { $supabaseKey = $fileJson.supabaseAnonKey }
    } catch {}
}

# Env var overrides (GitHub Actions)
if ($env:SUPABASE_URL) { $supabaseUrl = $env:SUPABASE_URL }
if ($env:SUPABASE_KEY) { $supabaseKey = $env:SUPABASE_KEY }

if (-not $supabaseUrl -or -not $supabaseKey) {
    Write-Host "  [!] ERROR: Supabase URL and key are required." -ForegroundColor Red
    exit 1
}
$supabaseUrl = $supabaseUrl.TrimEnd('/')

$supaHeaders = @{
    "apikey"        = $supabaseKey
    "Authorization" = "Bearer $supabaseKey"
}

# Station definitions
$stationsCfg = @()
try {
    $fileJson2 = [System.IO.File]::ReadAllText($cfgFile, [System.Text.Encoding]::UTF8) | ConvertFrom-Json
    if ($fileJson2.stations -and $fileJson2.stations.Count -gt 0) {
        foreach ($s in $fileJson2.stations) {
            $stationsCfg += @{ id = $s.id; name = if ($s.name) { $s.name } else { $s.id } }
        }
    }
} catch {}
if ($stationsCfg.Count -eq 0) {
    $stationsCfg = @(
        @{ id = "perth";    name = "Perth Test Table" },
        @{ id = "shangani"; name = "Shangani Aramani" },
        @{ id = "funzi";    name = "Funzi Island" }
    )
}

# ═══════════════════════════════════════════════════════════════════
# HELPERS
# ═══════════════════════════════════════════════════════════════════

function Get-LatestReadings {
    param($deviceId, $results = 5)
    try {
        $url = "$supabaseUrl/rest/v1/sensor_readings" +
               "?device_id=eq.$deviceId" +
               "&order=recorded_at.desc" +
               "&limit=$results" +
               "&select=id,recorded_at,battery_pct,temp_1,temp_2,battery_v"
        $rows = Invoke-RestMethod -Uri $url -Headers $supaHeaders -Method Get -TimeoutSec 20
        return $rows
    } catch {
        Write-Warning "  [API] Failed to fetch readings for $deviceId : $_"
        return $null
    }
}

function Get-OpenIssue {
    param($title)
    try {
        $json   = gh issue list --label "alert" --state open --json title 2>$null
        $issues = $json | ConvertFrom-Json
        return ($issues | Where-Object { $_.title -eq $title } | Select-Object -First 1)
    } catch {
        return $null
    }
}

function Open-Alert {
    param($title, $body, [string]$extraLabel = "")
    if ($DryRun) {
        Write-Host "  [DRY-RUN] Would open issue: $title"
        return
    }
    $existing = Get-OpenIssue $title
    if ($existing) {
        Write-Host "  [SKIP] Already open: $title"
        return
    }
    $labels = if ($extraLabel) { "alert,$extraLabel" } else { "alert" }
    gh issue create --title $title --body $body --label $labels | Out-Null
    Write-Host "  [ALERT] Opened: $title"
}

function Close-Alert {
    param($title, $clearMsg = "Alert condition cleared automatically.")
    if ($DryRun) {
        Write-Host "  [DRY-RUN] Would close issue: $title"
        return
    }
    try {
        $json   = gh issue list --label "alert" --state open --json number,title 2>$null
        $issues = $json | ConvertFrom-Json
        $issue  = $issues | Where-Object { $_.title -eq $title } | Select-Object -First 1
        if ($issue) {
            gh issue close $issue.number --comment "CLEARED: $clearMsg" | Out-Null
            Write-Host "  [CLEAR] Closed: $title"
        }
    } catch { }
}

# ═══════════════════════════════════════════════════════════════════
# ENSURE LABELS
# ═══════════════════════════════════════════════════════════════════

if (-not $DryRun) {
    try {
        gh label create "alert"    --color "e11d48" --description "Automated monitoring alert"  --force 2>$null | Out-Null
        gh label create "critical" --color "dc2626" --description "Critical - immediate action" --force 2>$null | Out-Null
        gh label create "warning"  --color "d97706" --description "Warning - action needed"     --force 2>$null | Out-Null
    } catch { }
}

# ═══════════════════════════════════════════════════════════════════
# CHECK EACH STATION
# ═══════════════════════════════════════════════════════════════════

$nowUtc  = [DateTime]::UtcNow
$anyFail = $false

foreach ($station in $stationsCfg) {

    Write-Host ""
    Write-Host "-- $($station.name) ($($station.id)) --"

    $rows = Get-LatestReadings $station.id 5

    if (-not $rows -or ($rows -is [array] -and $rows.Count -eq 0)) {
        Write-Warning "  No readings returned - skipping $($station.name)"
        $anyFail = $true
        continue
    }

    # Ensure array
    if ($rows -isnot [array]) { $rows = @($rows) }

    $latest   = $rows | Sort-Object { [DateTime]$_.recorded_at } | Select-Object -Last 1
    $lastSeen = [DateTime]::Parse($latest.recorded_at, $null, [System.Globalization.DateTimeStyles]::AdjustToUniversal)
    $ageH     = ($nowUtc - $lastSeen).TotalHours
    $ageRound = [Math]::Round($ageH, 1)
    Write-Host "  Last entry : $($latest.recorded_at) UTC  ($ageRound h ago)"

    # ── Offline check ──────────────────────────────────────────────
    $offlineTitle = "[OFFLINE] $($station.name) - device offline"

    if ($ageH -gt $OFFLINE_HOURS) {
        $body  = "**Station:** $($station.name) (device_id: $($station.id))`n`n"
        $body += "**Last seen:** $($latest.recorded_at) UTC`n"
        $body += "**Age:** $ageRound hours`n`n"
        $body += "No new data received for over $OFFLINE_HOURS hours.`n`n"
        $body += "Possible causes: device powered off, battery flat, cellular/SIM failure, hardware fault.`n`n"
        $body += "Supabase console: check device_status table for last_seen value."
        Open-Alert $offlineTitle $body "critical"
    } else {
        Close-Alert $offlineTitle "Device is back online - last seen $($latest.recorded_at) UTC."
    }

    # ── Battery check (direct column access — no CSV parsing!) ─────
    $batPct = $latest.battery_pct
    if ($null -ne $batPct) {
        Write-Host "  Battery    : $batPct %"
    } else {
        Write-Host "  Battery    : (not reported)"
    }

    $batCritTitle = "[CRITICAL] $($station.name) - battery critical"
    $batLowTitle  = "[WARNING]  $($station.name) - battery low"

    if ($null -ne $batPct -and $batPct -ge 0 -and $batPct -lt $BATTERY_CRITICAL) {
        $body  = "**Station:** $($station.name) (device_id: $($station.id))`n`n"
        $body += "**Battery:** $batPct %  (threshold: below $BATTERY_CRITICAL %)`n"
        $body += "**Last seen:** $($latest.recorded_at) UTC`n`n"
        $body += "Battery is critically low - device may die within hours."
        Open-Alert  $batCritTitle $body "critical"
        Close-Alert $batLowTitle  "Promoted to critical battery alert."

    } elseif ($null -ne $batPct -and $batPct -ge 0 -and $batPct -lt $BATTERY_LOW) {
        $body  = "**Station:** $($station.name) (device_id: $($station.id))`n`n"
        $body += "**Battery:** $batPct %  (threshold: below $BATTERY_LOW %)`n"
        $body += "**Last seen:** $($latest.recorded_at) UTC`n`n"
        $body += "Battery is getting low - plan a site visit."
        Open-Alert  $batLowTitle  $body "warning"
        Close-Alert $batCritTitle "Battery recovered above critical threshold."

    } else {
        Close-Alert $batCritTitle "Battery recovered."
        Close-Alert $batLowTitle  "Battery recovered."
    }

    # ── Temperature check (direct column access) ───────────────────
    $tempValues = @()
    if ($null -ne $latest.temp_1) { $tempValues += $latest.temp_1 }
    if ($null -ne $latest.temp_2) { $tempValues += $latest.temp_2 }

    $overtempTitle = "[CRITICAL] $($station.name) - overtemp"
    $overtempFound = $false

    foreach ($tVal in $tempValues) {
        Write-Host "  Temp check : $tVal degC"
        if ($tVal -gt $TEMP_CRITICAL) {
            $overtempFound = $true
            $body  = "**Station:** $($station.name) (device_id: $($station.id))`n`n"
            $body += "**Temperature:** $tVal degC  (threshold: above $TEMP_CRITICAL degC)`n"
            $body += "**Last seen:** $($latest.recorded_at) UTC`n`n"
            $body += "Device enclosure is dangerously hot - check installation and ventilation."
            Open-Alert $overtempTitle $body "critical"
            break
        }
    }

    if (-not $overtempFound) {
        Close-Alert $overtempTitle "Temperature returned to normal range."
    }
}

Write-Host ""
Write-Host "-- check_alerts_supabase complete --"
if ($anyFail) { exit 1 }

# check_alerts.ps1
# Monitors ThingSpeak channels and opens/closes GitHub Issues for alert conditions.
# Called by GitHub Actions after every data download.
#
# Alerts checked:
#   ALL channels  : device offline  (no new data for > OFFLINE_HOURS)
#   Perth T0 only : battery critical (field1 < BATTERY_CRITICAL %)
#   Perth T0 only : battery low      (field1 < BATTERY_LOW %)
#   Perth T0 only : overtemp         (field2 t1 or t2 > TEMP_CRITICAL degC)
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

$channels = @(
    @{
        id         = "perth"
        name       = "Perth Test Table"
        channelId  = "3262071"
        apiKey     = "VVHUX39KINYPLCVI"
        hasBattery = $true
    },
    @{
        id         = "wroom"
        name       = "Perth WROOM"
        channelId  = "3246116"
        apiKey     = "7K00B1Y8DNOTEIM0"
        hasBattery = $false
    }
)

function Get-LatestFeeds {
    param($channelId, $apiKey, $results = 5)
    try {
        $url  = "https://api.thingspeak.com/channels/$channelId/feeds.json?api_key=$apiKey&results=$results"
        $resp = Invoke-RestMethod -Uri $url -Method Get -TimeoutSec 20
        return $resp.feeds
    } catch {
        Write-Warning "  [API] Failed to fetch channel $channelId : $_"
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

if (-not $DryRun) {
    try {
        gh label create "alert"    --color "e11d48" --description "Automated monitoring alert"  --force 2>$null | Out-Null
        gh label create "critical" --color "dc2626" --description "Critical - immediate action" --force 2>$null | Out-Null
        gh label create "warning"  --color "d97706" --description "Warning - action needed"     --force 2>$null | Out-Null
    } catch { }
}

$nowUtc  = [DateTime]::UtcNow
$anyFail = $false

foreach ($ch in $channels) {

    Write-Host ""
    Write-Host "-- $($ch.name)  (channel $($ch.channelId)) --"

    $feeds = Get-LatestFeeds $ch.channelId $ch.apiKey 5

    if (-not $feeds -or $feeds.Count -eq 0) {
        Write-Warning "  No feeds returned - skipping $($ch.name)"
        $anyFail = $true
        continue
    }

    $latest   = $feeds | Sort-Object { [DateTime]$_.created_at } | Select-Object -Last 1
    $lastSeen = [DateTime]::Parse($latest.created_at, $null, [System.Globalization.DateTimeStyles]::AdjustToUniversal)
    $ageH     = ($nowUtc - $lastSeen).TotalHours
    $ageRound = [Math]::Round($ageH, 1)
    Write-Host "  Last entry : $($latest.created_at) UTC  ($ageRound h ago)"

    $offlineTitle = "[OFFLINE] $($ch.name) - device offline"

    if ($ageH -gt $OFFLINE_HOURS) {
        $body  = "**Channel:** $($ch.name) (ID: $($ch.channelId))`n`n"
        $body += "**Last seen:** $($latest.created_at) UTC`n"
        $body += "**Age:** $ageRound hours`n`n"
        $body += "No new data received for over $OFFLINE_HOURS hours.`n`n"
        $body += "Possible causes: device powered off, battery flat, cellular/SIM failure, hardware fault.`n`n"
        $body += "ThingSpeak: https://thingspeak.com/channels/$($ch.channelId)"
        Open-Alert $offlineTitle $body "critical"
    } else {
        Close-Alert $offlineTitle "Device is back online - last seen $($latest.created_at) UTC."
    }

    if (-not $ch.hasBattery) {
        Write-Host "  (offline-only monitoring for this channel)"
        continue
    }

    $batRaw   = $latest.field1
    $batPct   = if ($batRaw -match '^\d') { [double]$batRaw } else { -1 }
    Write-Host "  Battery    : $batPct %"

    $batCritTitle = "[CRITICAL] $($ch.name) - battery critical"
    $batLowTitle  = "[WARNING]  $($ch.name) - battery low"

    if ($batPct -ge 0 -and $batPct -lt $BATTERY_CRITICAL) {
        $body  = "**Channel:** $($ch.name) (ID: $($ch.channelId))`n`n"
        $body += "**Battery:** $batPct %  (threshold: below $BATTERY_CRITICAL %)`n"
        $body += "**Last seen:** $($latest.created_at) UTC`n`n"
        $body += "Battery is critically low - device may die within hours.`n`n"
        $body += "ThingSpeak: https://thingspeak.com/channels/$($ch.channelId)"
        Open-Alert  $batCritTitle $body "critical"
        Close-Alert $batLowTitle  "Promoted to critical battery alert."

    } elseif ($batPct -ge 0 -and $batPct -lt $BATTERY_LOW) {
        $body  = "**Channel:** $($ch.name) (ID: $($ch.channelId))`n`n"
        $body += "**Battery:** $batPct %  (threshold: below $BATTERY_LOW %)`n"
        $body += "**Last seen:** $($latest.created_at) UTC`n`n"
        $body += "Battery is getting low - plan a site visit.`n`n"
        $body += "ThingSpeak: https://thingspeak.com/channels/$($ch.channelId)"
        Open-Alert  $batLowTitle  $body "warning"
        Close-Alert $batCritTitle "Battery recovered above critical threshold."

    } else {
        Close-Alert $batCritTitle "Battery recovered."
        Close-Alert $batLowTitle  "Battery recovered."
    }

    $field2 = $latest.field2
    if ($field2) {
        $parts         = $field2 -split ","
        $tempValues    = @($parts[0], $parts[2]) | Where-Object { $_ -and $_ -ne "NC" }
        $overtempTitle = "[CRITICAL] $($ch.name) - overtemp"
        $overtempFound = $false

        foreach ($tv in $tempValues) {
            try {
                $tVal = [double]$tv
                Write-Host "  Temp check : $tVal degC"
                if ($tVal -gt $TEMP_CRITICAL) {
                    $overtempFound = $true
                    $body  = "**Channel:** $($ch.name) (ID: $($ch.channelId))`n`n"
                    $body += "**Temperature:** $tVal degC  (threshold: above $TEMP_CRITICAL degC)`n"
                    $body += "**Last seen:** $($latest.created_at) UTC`n`n"
                    $body += "Device enclosure is dangerously hot - check installation and ventilation.`n`n"
                    $body += "ThingSpeak: https://thingspeak.com/channels/$($ch.channelId)"
                    Open-Alert $overtempTitle $body "critical"
                    break
                }
            } catch { }
        }

        if (-not $overtempFound) {
            Close-Alert $overtempTitle "Temperature returned to normal range."
        }
    }
}

Write-Host ""
Write-Host "-- check_alerts complete --"
if ($anyFail) { exit 1 }
# check_alerts.ps1
# Monitors ThingSpeak channels and opens/closes GitHub Issues for alert conditions.
# Called by GitHub Actions after every data download.
#
# Alerts checked:
#   ALL channels  : device offline (no new data for > OFFLINE_HOURS)
#   Perth T0 only : battery critical (field1 < BATTERY_CRITICAL %)
#   Perth T0 only : battery low      (field1 < BATTERY_LOW %)
#   Perth T0 only : overtemp         (field2 t1 or t2 > TEMP_CRITICAL °C)
#
# Deduplication: uses `gh issue list` to avoid re-opening an already-open issue.
# Auto-close:    when a condition clears the matching issue is closed automatically.
#
# Requires: gh CLI authenticated via GH_TOKEN environment variable (automatic in Actions)

param(
    [switch]$DryRun   # Print what would happen without touching GitHub Issues
)

Set-StrictMode -Off
$ErrorActionPreference = "Continue"

# ── Thresholds ───────────────────────────────────────────────────────────────
$OFFLINE_HOURS    = 3      # hours since last ThingSpeak entry before "offline" alert
$BATTERY_CRITICAL = 10     # %  — open critical issue
$BATTERY_LOW      = 25     # %  — open warning issue
$TEMP_CRITICAL    = 65     # °C — open critical issue

# ── Channels to monitor ───────────────────────────────────────────────────────
# hasBattery : field1 = battery %, field2 = "t1,rh1,t2,rh2"
# offline only if hasBattery = $false
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
        channelId  = "3246116"          # temperature channel — used only for timestamp
        apiKey     = "7K00B1Y8DNOTEIM0"
        hasBattery = $false
    }
)

# ── Helpers ───────────────────────────────────────────────────────────────────

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
            gh issue close $issue.number --comment "✅ $clearMsg" | Out-Null
            Write-Host "  [CLEAR] Closed: $title"
        }
    } catch { }
}

# ── Ensure required labels exist ──────────────────────────────────────────────
if (-not $DryRun) {
    try {
        gh label create "alert"    --color "e11d48" --description "Automated monitoring alert"  --force 2>$null | Out-Null
        gh label create "critical" --color "dc2626" --description "Critical — immediate action" --force 2>$null | Out-Null
        gh label create "warning"  --color "d97706" --description "Warning — action needed"     --force 2>$null | Out-Null
    } catch { }
}

# ── Main loop ─────────────────────────────────────────────────────────────────
$nowUtc  = [DateTime]::UtcNow
$anyFail = $false

foreach ($ch in $channels) {

    Write-Host "`n── $($ch.name)  (channel $($ch.channelId)) ──────────────────"

    $feeds = Get-LatestFeeds $ch.channelId $ch.apiKey 5

    if (-not $feeds -or $feeds.Count -eq 0) {
        Write-Warning "  No feeds returned — skipping checks for $($ch.name)"
        $anyFail = $true
        continue
    }

    # Most recent entry
    $latest   = $feeds | Sort-Object { [DateTime]$_.created_at } | Select-Object -Last 1
    $lastSeen = [DateTime]::Parse($latest.created_at, $null, [System.Globalization.DateTimeStyles]::AdjustToUniversal)
    $ageH     = ($nowUtc - $lastSeen).TotalHours
    Write-Host "  Last entry : $($latest.created_at) UTC  ($([Math]::Round($ageH, 1)) h ago)"

    # ── 1. Offline check (all channels) ─────────────────────────────────────────
    $offlineTitle = "🔴 $($ch.name) — device offline"

    if ($ageH -gt $OFFLINE_HOURS) {
        $body = @"
**Channel:** $($ch.name) (ID: ``$($ch.channelId)``)
**Last seen:** $($latest.created_at) UTC
**Age:** $([Math]::Round($ageH, 1)) hours

No new data received for over $OFFLINE_HOURS hours.

Possible causes:
- Device powered off or battery flat
- Cellular / SIM failure
- Hardware fault

[View ThingSpeak channel](https://thingspeak.com/channels/$($ch.channelId))
"@
        Open-Alert $offlineTitle $body "critical"
    } else {
        Close-Alert $offlineTitle "Device is back online — last seen $($latest.created_at) UTC."
    }

    # No battery / sensor fields on WROOM — stop here for that channel
    if (-not $ch.hasBattery) {
        Write-Host "  (offline-only monitoring for this channel)"
        continue
    }

    # ── 2. Battery critical ──────────────────────────────────────────────────────
    $batRaw   = $latest.field1
    $batPct   = if ($batRaw -match '^\d') { [double]$batRaw } else { -1 }
    Write-Host "  Battery    : $batPct %"

    $batCritTitle = "🔴 $($ch.name) — battery critical"
    $batLowTitle  = "🟡 $($ch.name) — battery low"

    if ($batPct -ge 0 -and $batPct -lt $BATTERY_CRITICAL) {
        $body = @"
**Channel:** $($ch.name) (ID: ``$($ch.channelId)``)
**Battery:** $batPct %
**Threshold:** < $BATTERY_CRITICAL %
**Last seen:** $($latest.created_at) UTC

Battery is critically low — device may die within hours.

[View ThingSpeak channel](https://thingspeak.com/channels/$($ch.channelId))
"@
        Open-Alert  $batCritTitle $body "critical"
        Close-Alert $batLowTitle  "Promoted to critical battery alert."

    } elseif ($batPct -ge 0 -and $batPct -lt $BATTERY_LOW) {
        $body = @"
**Channel:** $($ch.name) (ID: ``$($ch.channelId)``)
**Battery:** $batPct %
**Threshold:** < $BATTERY_LOW %
**Last seen:** $($latest.created_at) UTC

Battery is getting low — plan a site visit.

[View ThingSpeak channel](https://thingspeak.com/channels/$($ch.channelId))
"@
        Open-Alert  $batLowTitle  $body "warning"
        Close-Alert $batCritTitle "Battery recovered above critical threshold."

    } else {
        # Battery OK — clear both
        Close-Alert $batCritTitle "Battery recovered."
        Close-Alert $batLowTitle  "Battery recovered."
    }

    # ── 3. Overtemp (field2 = "t1,rh1,t2,rh2") ──────────────────────────────────
    $field2 = $latest.field2
    if ($field2) {
        $parts = $field2 -split ","
        # Indices 0 and 2 are temperatures (t1, t2); 1 and 3 are humidity
        $tempValues = @($parts[0], $parts[2]) | Where-Object { $_ -and $_ -ne "NC" }

        foreach ($tv in $tempValues) {
            try {
                $tVal = [double]$tv
                Write-Host "  Temp check : $tVal °C"

                $overtempTitle = "🔴 $($ch.name) — overtemp"

                if ($tVal -gt $TEMP_CRITICAL) {
                    $body = @"
**Channel:** $($ch.name) (ID: ``$($ch.channelId)``)
**Temperature:** $tVal °C
**Threshold:** > $TEMP_CRITICAL °C
**Last seen:** $($latest.created_at) UTC

Device enclosure is dangerously hot — check installation and ventilation.

[View ThingSpeak channel](https://thingspeak.com/channels/$($ch.channelId))
"@
                    Open-Alert $overtempTitle $body "critical"
                    break
                } else {
                    Close-Alert $overtempTitle "Temperature returned below threshold ($tVal °C)."
                }
            } catch { }
        }
    }
}

Write-Host "`n── check_alerts complete ─────────────────────────────────────────"
if ($anyFail) { exit 1 }

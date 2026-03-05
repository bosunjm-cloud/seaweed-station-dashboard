<#
.SYNOPSIS
    Downloads station data from Supabase for the Seaweed Station Dashboard.
.DESCRIPTION
    Phase 3 replacement for download_data.ps1 (ThingSpeak).
    Queries Supabase PostgREST for sensor_readings, maps columns back to the
    ThingSpeak field1-8 shape so existing dashboard pages work unmodified.
    Output: data/<dataFolder>/merged_data.js → window.STATION_DATA = {...}
    Also downloads Open-Meteo weather data for each station location.
.PARAMETER MaxResults
    Override max rows per station (default: from config.json or 8000)
.PARAMETER RetentionDays
    Override retention window in days (default: from config.json or 90)
.PARAMETER ScheduleType
    Override schedule type: 'daily' or 'hourly' (affects archive filenames)
.EXAMPLE
    .\download_data_supabase.ps1
    .\download_data_supabase.ps1 -MaxResults 500
#>

param(
    [int]$MaxResults      = 0,
    [int]$RetentionDays   = 0,
    [string]$ScheduleType = ""
)

$ErrorActionPreference = "Stop"

# ═══════════════════════════════════════════════════════════════════
# LOAD CONFIG
# ═══════════════════════════════════════════════════════════════════

$defaultStations = @(
    @{ id = "perth";    name = "Perth Test Table";    dataFolder = "data_3262071_TT" }
    @{ id = "shangani"; name = "Shangani Aramani";    dataFolder = "data_Shangani" }
    @{ id = "funzi";    name = "Funzi Island";        dataFolder = "data_Funzi" }
)

$cfg = @{
    supabaseUrl    = ""
    supabaseKey    = ""
    scheduleType   = "hourly"
    maxResults     = 8000
    retentionDays  = 90
    dataPath       = ""
}
$stations = $defaultStations

$cfgFile = Join-Path $PSScriptRoot "config.json"
if (Test-Path $cfgFile) {
    try {
        $fileJson = [System.IO.File]::ReadAllText($cfgFile, [System.Text.Encoding]::UTF8) | ConvertFrom-Json
        if ($fileJson.supabaseUrl)    { $cfg.supabaseUrl  = $fileJson.supabaseUrl }
        if ($fileJson.supabaseAnonKey){ $cfg.supabaseKey   = $fileJson.supabaseAnonKey }
        if ($fileJson.scheduleType)   { $cfg.scheduleType  = $fileJson.scheduleType }
        if ($fileJson.maxResults -and $fileJson.maxResults -gt 0) { $cfg.maxResults = [int]$fileJson.maxResults }
        if ($fileJson.retentionDays -and $fileJson.retentionDays -gt 0) { $cfg.retentionDays = [int]$fileJson.retentionDays }
        if ($fileJson.dataPath -and $fileJson.dataPath.Trim() -ne "") { $cfg.dataPath = $fileJson.dataPath.Trim() }
        if ($fileJson.stations -and $fileJson.stations.Count -gt 0) {
            $stations = @()
            foreach ($s in $fileJson.stations) {
                $stations += @{
                    id         = $s.id
                    name       = if ($s.name) { $s.name } else { $s.id }
                    dataFolder = if ($s.dataFolder) { $s.dataFolder } else { "data_$($s.id)" }
                }
            }
        }
    } catch {
        Write-Host "  [!] Warning: could not read config.json ($_) -- using defaults" -ForegroundColor Yellow
    }
}

# Environment variable overrides (GitHub Actions)
if ($env:SUPABASE_URL) { $cfg.supabaseUrl = $env:SUPABASE_URL }
if ($env:SUPABASE_KEY) { $cfg.supabaseKey = $env:SUPABASE_KEY }

# Parameter overrides
if ($MaxResults -gt 0)    { $cfg.maxResults    = $MaxResults }
if ($RetentionDays -gt 0) { $cfg.retentionDays = $RetentionDays }
if ($ScheduleType -ne "") { $cfg.scheduleType  = $ScheduleType }

# Validate Supabase credentials
if (-not $cfg.supabaseUrl -or -not $cfg.supabaseKey) {
    Write-Host "  [!] ERROR: Supabase URL and key are required." -ForegroundColor Red
    Write-Host "      Set in config.json (supabaseUrl + supabaseAnonKey)" -ForegroundColor Red
    Write-Host "      or via env vars SUPABASE_URL + SUPABASE_KEY" -ForegroundColor Red
    exit 1
}

# Strip trailing slash from URL
$cfg.supabaseUrl = $cfg.supabaseUrl.TrimEnd('/')

# Resolve data root
$dataRoot = if ($cfg.dataPath -ne "") {
    if ([System.IO.Path]::IsPathRooted($cfg.dataPath)) { $cfg.dataPath }
    else { Join-Path $PSScriptRoot $cfg.dataPath }
} else { Join-Path $PSScriptRoot "data" }

if (!(Test-Path $dataRoot)) {
    New-Item -ItemType Directory -Path $dataRoot -Force | Out-Null
}

# Archive filename
$archiveName = if ($cfg.scheduleType -eq "hourly") {
    (Get-Date -Format "yyyyMMddHH") + "_supa.json"
} else {
    (Get-Date -Format "yyyyMMdd") + "_supa.json"
}

# Retention cutoff
$cutoffDate = (Get-Date).AddDays(-$cfg.retentionDays)
$cutoffISO  = $cutoffDate.ToUniversalTime().ToString("yyyy-MM-ddTHH:mm:ssZ")

# Supabase headers
$supaHeaders = @{
    "apikey"        = $cfg.supabaseKey
    "Authorization" = "Bearer $($cfg.supabaseKey)"
}

# ═══════════════════════════════════════════════════════════════════
# BANNER
# ═══════════════════════════════════════════════════════════════════
Write-Host ""
Write-Host "  ============================================"
Write-Host "   Seaweed Station - Supabase Download"
Write-Host "  ============================================"
Write-Host "  Script     : $PSScriptRoot"
Write-Host "  Data root  : $dataRoot"
Write-Host "  Supabase   : $($cfg.supabaseUrl)"
Write-Host "  Schedule   : $($cfg.scheduleType)  ->  $archiveName"
Write-Host "  Stations   : $($stations.Count)"
foreach ($s in $stations) {
    Write-Host "    - $($s.name) ($($s.id)) -> $($s.dataFolder)/"
}
Write-Host "  Retention  : $($cfg.retentionDays) days (cutoff: $($cutoffDate.ToString('yyyy-MM-dd')))"
Write-Host "  Time       : $(Get-Date -Format 'yyyy-MM-dd HH:mm:ss')"
Write-Host ""

# ═══════════════════════════════════════════════════════════════════
# HELPER: Map a Supabase row to ThingSpeak-compatible feed object
# ═══════════════════════════════════════════════════════════════════
function ConvertTo-ThingSpeakFeed {
    param($row)

    # field1: battery %
    $f1 = if ($null -ne $row.battery_pct) { [string]$row.battery_pct } else { $null }

    # field2: temp1,hum1,temp2,hum2
    $f2Parts = @(
        $(if ($null -ne $row.temp_1)     { $row.temp_1 }     else { "" }),
        $(if ($null -ne $row.humidity_1)  { $row.humidity_1 }  else { "" }),
        $(if ($null -ne $row.temp_2)     { $row.temp_2 }     else { "" }),
        $(if ($null -ne $row.humidity_2)  { $row.humidity_2 }  else { "" })
    )
    $f2 = $f2Parts -join ","

    # field3: batV,rssi,bootCnt,heap|fwVersion,buildDate
    $f3Parts = @(
        $(if ($null -ne $row.battery_v)  { $row.battery_v }  else { "" }),
        $(if ($null -ne $row.rssi)       { $row.rssi }       else { "" }),
        $(if ($null -ne $row.boot_count) { $row.boot_count } else { "" }),
        $(if ($null -ne $row.free_heap)  { $row.free_heap }  else { "" })
    )
    $f3 = ($f3Parts -join ",")
    if ($row.fw_version -or $row.fw_date) {
        $fwV = if ($row.fw_version) { $row.fw_version } else { "" }
        $fwD = if ($row.fw_date)    { $row.fw_date }    else { "" }
        $f3 += "|$fwV,$fwD"
    }

    # field4: satA status — batV,batPct,rssi,sampleId,flashPct,syncDrift,fwVer
    $f4Parts = @(
        $(if ($null -ne $row.sat_a_battery_v)   { $row.sat_a_battery_v }   else { "" }),
        $(if ($null -ne $row.sat_a_battery_pct)  { $row.sat_a_battery_pct } else { "" }),
        $(if ($null -ne $row.sat_a_rssi)         { $row.sat_a_rssi }        else { "" }),
        $(if ($null -ne $row.sat_a_sample_id)    { $row.sat_a_sample_id }   else { "" }),
        $(if ($null -ne $row.sat_a_flash_pct)    { $row.sat_a_flash_pct }   else { "" }),
        $(if ($null -ne $row.sat_a_sync_drift)   { $row.sat_a_sync_drift }  else { "" }),
        $(if ($row.sat_a_fw_ver)                 { $row.sat_a_fw_ver }      else { "" })
    )
    $f4 = $f4Parts -join ","

    # field5: satA sensors — temp1,hum1,temp2,hum2
    $f5Parts = @(
        $(if ($null -ne $row.sat_a_temp_1)     { $row.sat_a_temp_1 }     else { "" }),
        $(if ($null -ne $row.sat_a_humidity_1)  { $row.sat_a_humidity_1 }  else { "" }),
        $(if ($null -ne $row.sat_a_temp_2)     { $row.sat_a_temp_2 }     else { "" }),
        $(if ($null -ne $row.sat_a_humidity_2)  { $row.sat_a_humidity_2 }  else { "" })
    )
    $f5 = $f5Parts -join ","

    # field6: satB status
    $f6Parts = @(
        $(if ($null -ne $row.sat_b_battery_v)   { $row.sat_b_battery_v }   else { "" }),
        $(if ($null -ne $row.sat_b_battery_pct)  { $row.sat_b_battery_pct } else { "" }),
        $(if ($null -ne $row.sat_b_rssi)         { $row.sat_b_rssi }        else { "" }),
        $(if ($null -ne $row.sat_b_sample_id)    { $row.sat_b_sample_id }   else { "" }),
        $(if ($null -ne $row.sat_b_flash_pct)    { $row.sat_b_flash_pct }   else { "" }),
        $(if ($null -ne $row.sat_b_sync_drift)   { $row.sat_b_sync_drift }  else { "" }),
        $(if ($row.sat_b_fw_ver)                 { $row.sat_b_fw_ver }      else { "" })
    )
    $f6 = $f6Parts -join ","

    # field7: satB sensors
    $f7Parts = @(
        $(if ($null -ne $row.sat_b_temp_1)     { $row.sat_b_temp_1 }     else { "" }),
        $(if ($null -ne $row.sat_b_humidity_1)  { $row.sat_b_humidity_1 }  else { "" }),
        $(if ($null -ne $row.sat_b_temp_2)     { $row.sat_b_temp_2 }     else { "" }),
        $(if ($null -ne $row.sat_b_humidity_2)  { $row.sat_b_humidity_2 }  else { "" })
    )
    $f7 = $f7Parts -join ","

    # field8: diag|config|fw  (diag section empty — sdFreeKB/csq not in Supabase schema)
    $configCsv = @(
        $(if ($null -ne $row.deploy_mode)     { $row.deploy_mode }     else { "" }),
        $(if ($null -ne $row.sample_period_s) { $row.sample_period_s } else { "" }),
        $(if ($null -ne $row.bulk_interval_s) { $row.bulk_interval_s } else { "" }),
        $(if ($null -ne $row.bulk_freq_hours) { $row.bulk_freq_hours } else { "" })
    ) -join ","
    $fwCsv = @(
        $(if ($row.fw_version) { $row.fw_version } else { "" }),
        $(if ($row.fw_date)    { $row.fw_date }    else { "" })
    ) -join ","
    $f8 = "|$configCsv|$fwCsv"

    return [ordered]@{
        created_at = $row.recorded_at
        entry_id   = $row.id
        field1     = $f1
        field2     = $f2
        field3     = $f3
        field4     = $f4
        field5     = $f5
        field6     = $f6
        field7     = $f7
        field8     = $f8
    }
}

# ═══════════════════════════════════════════════════════════════════
# PROCESS EACH STATION
# ═══════════════════════════════════════════════════════════════════

$stationResults = @()
$allSortedFeeds = @{}

foreach ($station in $stations) {
    Write-Host ""
    Write-Host "  ──────────────────────────────────────────"
    Write-Host "  Station: $($station.name) ($($station.id))"
    Write-Host "  ──────────────────────────────────────────"

    $archiveFolder = Join-Path $dataRoot $station.dataFolder
    if (!(Test-Path $archiveFolder)) {
        New-Item -ItemType Directory -Path $archiveFolder -Force | Out-Null
        Write-Host "    [+] Created folder: $archiveFolder"
    }

    # -- Step 1: Query Supabase PostgREST ------------------------------------
    # Fetch all readings for this station within the retention window.
    # PostgREST returns max 1000 rows by default; use Range header for pagination.
    $allRows = @()
    $offset  = 0
    $pageSize = 1000
    $maxRows  = $cfg.maxResults

    Write-Host "    [1/3] Downloading from Supabase (device_id=$($station.id))..."
    try {
        while ($allRows.Count -lt $maxRows) {
            $rangeEnd = $offset + $pageSize - 1
            $url = "$($cfg.supabaseUrl)/rest/v1/sensor_readings" +
                   "?device_id=eq.$($station.id)" +
                   "&recorded_at=gte.$cutoffISO" +
                   "&order=recorded_at.asc" +
                   "&limit=$pageSize" +
                   "&offset=$offset"

            $headers = $supaHeaders.Clone()
            $headers["Prefer"] = "count=exact"

            $response = Invoke-RestMethod -Uri $url -Headers $headers -Method Get -TimeoutSec 30

            if ($response -is [array]) {
                $allRows += $response
                if ($response.Count -lt $pageSize) { break }  # Last page
                $offset += $pageSize
            } else {
                # Single row returned as object
                if ($null -ne $response) { $allRows += $response }
                break
            }
        }
        Write-Host "          Downloaded: $($allRows.Count) rows"
    } catch {
        Write-Host "    [!] Supabase download FAILED: $_" -ForegroundColor Red
        $stationResults += @{ name = $station.name; status = "FAILED"; entries = 0 }
        continue
    }

    if ($allRows.Count -eq 0) {
        Write-Host "    [!] No data returned for $($station.id)" -ForegroundColor Yellow
        $stationResults += @{ name = $station.name; status = "empty"; entries = 0 }
        continue
    }

    # -- Step 2: Archive raw Supabase response --------------------------------
    $archiveFile = Join-Path $archiveFolder $archiveName
    try {
        $allRows | ConvertTo-Json -Depth 10 -Compress | Set-Content $archiveFile -Encoding UTF8
        $archiveSize = [math]::Round((Get-Item $archiveFile).Length / 1024, 1)
        Write-Host "    [2/3] Archived: $archiveName ($archiveSize KB, $($allRows.Count) rows)"
    } catch {
        Write-Host "    [!] Archive write failed: $_" -ForegroundColor Yellow
    }

    # -- Step 3: Build merged_data.js (backward-compatible ThingSpeak format) --
    Write-Host "    [3/3] Building merged_data.js..."

    $feeds = @()
    foreach ($row in $allRows) {
        $feeds += ConvertTo-ThingSpeakFeed $row
    }

    $allSortedFeeds[$station.id] = $feeds

    # Build a synthetic channel object for backward compat
    $channelBlock = [ordered]@{
        id             = $station.id
        name           = $station.name
        created_at     = if ($feeds.Count -gt 0) { $feeds[0].created_at } else { "" }
        updated_at     = if ($feeds.Count -gt 0) { $feeds[$feeds.Count - 1].created_at } else { "" }
        last_entry_id  = if ($feeds.Count -gt 0) { $feeds[$feeds.Count - 1].entry_id } else { 0 }
    }

    $mergedObj = [ordered]@{
        channel = $channelBlock
        feeds   = @($feeds)
    }
    $mergedJson = $mergedObj | ConvertTo-Json -Depth 10 -Compress

    # Check if data changed (skip no-op writes to avoid noisy git commits)
    $jsFile   = Join-Path $archiveFolder "merged_data.js"
    $metaFile = Join-Path $archiveFolder "data_meta.json"
    $lastFeed = if ($feeds.Count -gt 0) { $feeds[$feeds.Count - 1] } else { $null }
    $metaLastEntryId = if ($lastFeed) { [string]$lastFeed.entry_id } else { "" }
    $metaLastEntryTs = if ($lastFeed) { [string]$lastFeed.created_at } else { "" }

    $dataChanged = $true
    if (Test-Path $metaFile) {
        try {
            $oldMeta = Get-Content $metaFile -Raw | ConvertFrom-Json
            if ($oldMeta.entries -eq $feeds.Count -and $oldMeta.lastEntryId -eq $metaLastEntryId) {
                $dataChanged = $false
                Write-Host "          No new data — skipping merged_data.js rewrite ($($feeds.Count) entries unchanged)"
            }
        } catch { $dataChanged = $true }
    }

    if ($dataChanged) {
        $header  = "// Auto-generated by download_data_supabase.ps1`r`n"
        $header += "// Station: $($station.name) ($($station.id))`r`n"
        $header += "// Source: Supabase PostgREST`r`n"
        $header += "// Downloaded: $(Get-Date -Format 'yyyy-MM-dd HH:mm:ss')`r`n"
        $header += "// Total entries: $($feeds.Count)`r`n"
        $jsContent = $header + "window.STATION_DATA = " + $mergedJson + ";`r`n"

        [System.IO.File]::WriteAllText($jsFile, $jsContent, [System.Text.Encoding]::UTF8)
        $jsSize = [math]::Round($jsContent.Length / 1024, 1)
        Write-Host "          Written: merged_data.js ($jsSize KB, $($feeds.Count) entries)"

        $metaObj = [ordered]@{
            lastUpdate  = (Get-Date -Format 'o')
            entries     = $feeds.Count
            lastEntryId = $metaLastEntryId
            lastEntryTs = $metaLastEntryTs
            source      = "supabase"
        }
        $metaObj | ConvertTo-Json -Depth 2 | Set-Content $metaFile -Encoding UTF8
        Write-Host "          Written: data_meta.json"
    }

    # Cleanup old Supabase archives
    $oldArchives = Get-ChildItem -Path $archiveFolder -Filter "*_supa.json" -ErrorAction SilentlyContinue |
                   Where-Object { $_.CreationTime -lt $cutoffDate }
    if ($oldArchives -and $oldArchives.Count -gt 0) {
        $oldArchives | Remove-Item -Force
        Write-Host "          Cleaned up $($oldArchives.Count) old archive(s)"
    }

    $stationResults += @{ name = $station.name; status = "OK"; entries = $feeds.Count }
}

# ═══════════════════════════════════════════════════════════════════
# WEATHER DATA (Open-Meteo) — unchanged from ThingSpeak version
# ═══════════════════════════════════════════════════════════════════
Write-Host ""
Write-Host "  ──────────────────────────────────────────"
Write-Host "  Open-Meteo Weather Data"
Write-Host "  ──────────────────────────────────────────"

$weatherLocations = @(
    @{ name = "Perth / Noranda";  lat = -31.87; lon = 115.90; stationKey = "perth" }
    @{ name = "Shangani Aramani"; lat =  -4.55; lon =  39.50; stationKey = "shangani" }
    @{ name = "Funzi Island";     lat =  -4.55; lon =  39.45; stationKey = "funzi" }
)

$todayStr    = (Get-Date).ToString("yyyy-MM-dd")
$weatherFail = 0

foreach ($wloc in $weatherLocations) {
    $st = $stations | Where-Object { $_.id -eq $wloc.stationKey } | Select-Object -First 1
    $wFolder = Join-Path $dataRoot $(if ($st) { $st.dataFolder } else { "data_$($wloc.stationKey)" })
    if (!(Test-Path $wFolder)) {
        New-Item -ItemType Directory -Path $wFolder -Force | Out-Null
    }

    # Date range from feed data
    $weatherStartStr = ""
    $weatherEndStr   = ""
    $feeds = $allSortedFeeds[$wloc.stationKey]
    if ($feeds -and $feeds.Count -gt 0) {
        try {
            $sd = [datetime]::Parse($feeds[0].created_at).AddDays(-1)
            $ed = [datetime]::Parse($feeds[$feeds.Count - 1].created_at).AddDays(1)
            $weatherStartStr = $sd.ToString("yyyy-MM-dd")
            $weatherEndStr   = $ed.ToString("yyyy-MM-dd")
        } catch {}
    }
    if ($weatherStartStr -eq "" -or $weatherEndStr -eq "") {
        $weatherStartStr = (Get-Date).AddDays(-7).ToString("yyyy-MM-dd")
        $weatherEndStr   = $todayStr
    }

    # Clamp start to 90 days ago
    $minAllowed = (Get-Date).AddDays(-90).ToString("yyyy-MM-dd")
    if ($weatherStartStr -lt $minAllowed) { $weatherStartStr = $minAllowed }

    $apiBase = if ($weatherEndStr -ge $todayStr) {
        "https://api.open-meteo.com/v1/forecast"
    } else {
        "https://archive-api.open-meteo.com/v1/archive"
    }

    $wUrl = "${apiBase}?latitude=$($wloc.lat)&longitude=$($wloc.lon)" +
            "&start_date=$weatherStartStr&end_date=$weatherEndStr" +
            "&hourly=temperature_2m,relative_humidity_2m,precipitation,cloud_cover,weather_code,uv_index" +
            "&daily=sunrise,sunset" +
            "&timezone=auto"

    try {
        $wResp = Invoke-WebRequest -Uri $wUrl -UseBasicParsing
        $wJson = $wResp.Content

        if ($wJson -notmatch '"hourly"') {
            Write-Host "    [!] No hourly data for $($wloc.name)" -ForegroundColor Yellow
            $weatherFail++
            continue
        }

        $wHeader  = "// Auto-generated weather cache by download_data_supabase.ps1`r`n"
        $wHeader += "// Downloaded: $(Get-Date -Format 'yyyy-MM-dd HH:mm:ss')`r`n"
        $wHeader += "// Location: $($wloc.name) ($($wloc.lat), $($wloc.lon))`r`n"
        $wHeader += "// Range: $weatherStartStr to $weatherEndStr`r`n"
        $wContent = $wHeader + "window.WEATHER_CACHE = " + $wJson + ";`r`n"

        $wFile = Join-Path $wFolder "weather_data.js"
        [System.IO.File]::WriteAllText($wFile, $wContent, [System.Text.Encoding]::UTF8)
        $wSize = [math]::Round($wContent.Length / 1024, 1)
        Write-Host "    $($wloc.name): weather_data.js ($wSize KB) -> $(Split-Path $wFolder -Leaf)/"
    } catch {
        Write-Host "    [!] Weather FAILED for $($wloc.name): $_" -ForegroundColor Yellow
        $weatherFail++
    }
}

# ═══════════════════════════════════════════════════════════════════
# SUMMARY
# ═══════════════════════════════════════════════════════════════════
Write-Host ""
Write-Host "  ============================================"
Write-Host "   Download complete!"
Write-Host "  ============================================"
foreach ($sr in $stationResults) {
    $icon = if ($sr.status -eq "OK") { "[OK]" } elseif ($sr.status -eq "empty") { "[--]" } else { "[!!]" }
    Write-Host "  $icon $($sr.name): $($sr.status) ($($sr.entries) entries)"
}
Write-Host "  Weather: $($weatherLocations.Count - $weatherFail)/$($weatherLocations.Count) locations"
Write-Host ""
Write-Host "  Tides use client-side harmonic prediction (no download needed)."
Write-Host "  Open the dashboard HTML files in a browser to view."
Write-Host ""

<#
.SYNOPSIS
    Downloads station data from Supabase for the Seaweed Station Dashboard.
.DESCRIPTION
    Phase 3 replacement for download_data.ps1 (ThingSpeak).
    Queries Supabase PostgREST for samples_raw and flattens hub + satellite rows
    into the structured dashboard feed shape used by the current pages.
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
    @{ id = "spare";    name = "Spare Station";       dataFolder = "data_spare" }
    @{ id = "wroom";    name = "Perth WROOM";         dataFolder = "data_WROOM_PTT" }
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
# HELPER: Map a compatibility row to structured feed object (v2)
# ═══════════════════════════════════════════════════════════════════
function ConvertTo-StructuredFeed {
    param($row)

    return [ordered]@{
        created_at       = $row.recorded_at
        entry_id         = $row.id
        # T0
        battery_pct      = $row.battery_pct
        battery_v        = $row.battery_v
        boot_count       = $row.boot_count
        temp_1           = $row.temp_1
        humidity_1       = $row.humidity_1
        temp_2           = $row.temp_2
        humidity_2       = $row.humidity_2
        temp_3           = $row.temp_3
        humidity_3       = $row.humidity_3
        # Slot 1
        sat_1_battery_v   = $row.sat_1_battery_v
        sat_1_battery_pct = $row.sat_1_battery_pct
        sat_1_flash_pct   = $row.sat_1_flash_pct
        sat_1_temp_1      = $row.sat_1_temp_1
        sat_1_humidity_1  = $row.sat_1_humidity_1
        sat_1_temp_2      = $row.sat_1_temp_2
        sat_1_humidity_2  = $row.sat_1_humidity_2
        # Slot 2
        sat_2_battery_v   = $row.sat_2_battery_v
        sat_2_battery_pct = $row.sat_2_battery_pct
        sat_2_flash_pct   = $row.sat_2_flash_pct
        sat_2_temp_1      = $row.sat_2_temp_1
        sat_2_humidity_1  = $row.sat_2_humidity_1
        sat_2_temp_2      = $row.sat_2_temp_2
        sat_2_humidity_2  = $row.sat_2_humidity_2
        # Config / firmware now come from upload_sessions + sync_sessions.
        deploy_mode          = $null
        sample_period_s      = $null
        sleep_enable         = $null
        espnow_sync_period_s = $null
        sat_1_installed      = $null
        sat_2_installed      = $null
        fw_version    = $null
        fw_date       = $null
        sat_1_fw_ver  = $null
        sat_2_fw_ver  = $null
        _discovered_slots = @(1, 2)
    }
}

function Get-SamplesRawRows {
    param(
        [string]$DeviceId,
        [string]$NodeFilter,
        [string]$SelectClause,
        [string]$OrderClause,
        [int]$Limit,
        [string]$SampleEpochGte = "",
        [string]$SampleEpochLte = ""
    )

    $rows = @()
    $offset = 0
    $pageSize = 1000

    while ($rows.Count -lt $Limit) {
        $batchLimit = [Math]::Min($pageSize, $Limit - $rows.Count)
        $url = "$($cfg.supabaseUrl)/rest/v1/samples_raw" +
               "?device_id=eq.$DeviceId" +
               "&$NodeFilter" +
               "&select=$SelectClause" +
               $(if ($SampleEpochGte) { "&sample_epoch=gte.$SampleEpochGte" } else { "" }) +
               $(if ($SampleEpochLte) { "&sample_epoch=lte.$SampleEpochLte" } else { "" }) +
               "&order=$OrderClause" +
               "&limit=$batchLimit" +
               "&offset=$offset"

        $response = Invoke-RestMethod -Uri $url -Headers $supaHeaders -Method Get -TimeoutSec 30
        $batch = if ($response -is [array]) { @($response) } elseif ($null -ne $response) { @($response) } else { @() }
        if ($batch.Count -eq 0) { break }

        $rows += $batch
        if ($batch.Count -lt $batchLimit) { break }
        $offset += $batch.Count
    }

    return $rows
}

function Get-TimeMs {
    param($Value)
    if (-not $Value) { return [double]::NaN }
    try {
        return [DateTimeOffset]::Parse([string]$Value).ToUnixTimeMilliseconds()
    } catch {
        return [double]::NaN
    }
}

function Get-LatestInsertedRow {
    param($Current, $Candidate)
    if ($null -eq $Current) { return $Candidate }

    $currentInserted = Get-TimeMs $Current.inserted_at
    $candidateInserted = Get-TimeMs $Candidate.inserted_at
    if ($candidateInserted -gt $currentInserted) { return $Candidate }
    if ($candidateInserted -lt $currentInserted) { return $Current }

    $currentId = if ($Current.id -ne $null) { [int64]$Current.id } else { -1 }
    $candidateId = if ($Candidate.id -ne $null) { [int64]$Candidate.id } else { -1 }
    if ($candidateId -gt $currentId) { return $Candidate }
    return $Current
}

function Get-DedupedNodeRows {
    param([array]$Rows)

    $byKey = @{}
    foreach ($row in $Rows) {
        if ($null -eq $row -or -not $row.node_id -or -not $row.sample_epoch) { continue }
        $key = ([string]$row.node_id).ToUpperInvariant() + '|' + [string]$row.sample_epoch
        $byKey[$key] = Get-LatestInsertedRow $byKey[$key] $row
    }

    return @($byKey.Values | Sort-Object { Get-TimeMs $_.sample_epoch })
}

function Find-ClosestNodeSample {
    param(
        [array]$Rows,
        [double]$TargetMs,
        [double]$WindowMs = 150000
    )

    if (-not $Rows -or $Rows.Count -eq 0 -or [double]::IsNaN($TargetMs)) { return $null }

    $low = 0
    $high = $Rows.Count
    while ($low -lt $high) {
        $mid = [Math]::Floor(($low + $high) / 2)
        if ((Get-TimeMs $Rows[$mid].sample_epoch) -lt $TargetMs) { $low = $mid + 1 }
        else { $high = $mid }
    }

    $best = $null
    $bestDelta = [double]::PositiveInfinity
    foreach ($idx in @($low - 1, $low)) {
        if ($idx -lt 0 -or $idx -ge $Rows.Count) { continue }
        $rowMs = Get-TimeMs $Rows[$idx].sample_epoch
        if ([double]::IsNaN($rowMs)) { continue }
        $delta = [Math]::Abs($rowMs - $TargetMs)
        if ($delta -le $WindowMs -and $delta -lt $bestDelta) {
            $best = $Rows[$idx]
            $bestDelta = $delta
        }
    }

    return $best
}

function ConvertTo-CompatRowsFromSamplesRaw {
    param(
        [array]$HubRows,
        [array]$SatRows
    )

    $rowsByNode = @{ A = @(); B = @() }
    foreach ($row in $SatRows) {
        if ($null -eq $row -or -not $row.node_id) { continue }
        $nodeId = ([string]$row.node_id).ToUpperInvariant()
        if ($rowsByNode.ContainsKey($nodeId)) {
            $rowsByNode[$nodeId] += $row
        }
    }

    $slot1Rows = Get-DedupedNodeRows $rowsByNode['A']
    $slot2Rows = Get-DedupedNodeRows $rowsByNode['B']
    $orderedHub = @($HubRows | Sort-Object { Get-TimeMs $_.sample_epoch })
    $out = @()

    for ($i = 0; $i -lt $orderedHub.Count; $i++) {
        $hub = $orderedHub[$i]
        $hubMs = Get-TimeMs $hub.sample_epoch
        $match1 = Find-ClosestNodeSample $slot1Rows $hubMs
        $match2 = Find-ClosestNodeSample $slot2Rows $hubMs

        $out += [ordered]@{
            id                = if ($hub.id -ne $null) { $hub.id } else { $i + 1 }
            device_id         = $hub.device_id
            recorded_at       = $hub.sample_epoch
            inserted_at       = $hub.inserted_at
            temp_1            = $hub.temp_1
            humidity_1        = $hub.humidity_1
            temp_2            = $hub.temp_2
            humidity_2        = $hub.humidity_2
            temp_3            = $hub.temp_3
            humidity_3        = $hub.humidity_3
            battery_pct       = $hub.battery_pct
            battery_v         = $hub.battery_v
            boot_count        = $hub.boot_count
            sat_1_temp_1      = if ($match1) { $match1.temp_1 } else { $null }
            sat_1_humidity_1  = if ($match1) { $match1.humidity_1 } else { $null }
            sat_1_temp_2      = if ($match1) { $match1.temp_2 } else { $null }
            sat_1_humidity_2  = if ($match1) { $match1.humidity_2 } else { $null }
            sat_1_battery_v   = if ($match1) { $match1.battery_v } else { $null }
            sat_1_battery_pct = if ($match1) { $match1.battery_pct } else { $null }
            sat_1_flash_pct   = if ($match1) { $match1.flash_pct } else { $null }
            sat_2_temp_1      = if ($match2) { $match2.temp_1 } else { $null }
            sat_2_humidity_1  = if ($match2) { $match2.humidity_1 } else { $null }
            sat_2_temp_2      = if ($match2) { $match2.temp_2 } else { $null }
            sat_2_humidity_2  = if ($match2) { $match2.humidity_2 } else { $null }
            sat_2_battery_v   = if ($match2) { $match2.battery_v } else { $null }
            sat_2_battery_pct = if ($match2) { $match2.battery_pct } else { $null }
            sat_2_flash_pct   = if ($match2) { $match2.flash_pct } else { $null }
        }
    }

    return $out
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
    $compatRows = @()

    Write-Host "    [1/3] Downloading from Supabase samples_raw (device_id=$($station.id))..."
    try {
        $hubRows = Get-SamplesRawRows -DeviceId $station.id `
                          -NodeFilter 'node_id=eq.hub' `
                          -SelectClause 'id,device_id,sample_epoch,inserted_at,temp_1,humidity_1,temp_2,humidity_2,temp_3,humidity_3,battery_v,battery_pct,boot_count' `
                          -OrderClause 'sample_epoch.asc' `
                          -Limit $cfg.maxResults `
                          -SampleEpochGte $cutoffISO

        if ($hubRows.Count -gt 0) {
            $minHubIso = [string]$hubRows[0].sample_epoch
            $maxHubIso = [string]$hubRows[$hubRows.Count - 1].sample_epoch
            $minHub = [DateTimeOffset]::Parse($minHubIso).AddSeconds(-150).ToString('yyyy-MM-ddTHH:mm:ssZ')
            $maxHub = [DateTimeOffset]::Parse($maxHubIso).AddSeconds(150).ToString('yyyy-MM-ddTHH:mm:ssZ')
            $satRows = Get-SamplesRawRows -DeviceId $station.id `
                                          -NodeFilter 'node_id=in.(A,B)' `
                                          -SelectClause 'id,device_id,node_id,sample_id,sample_epoch,inserted_at,temp_1,humidity_1,temp_2,humidity_2,battery_v,battery_pct,flash_pct' `
                                          -OrderClause 'sample_epoch.asc' `
                                          -Limit ([Math]::Max($cfg.maxResults * 3, 3000)) `
                                          -SampleEpochGte $minHub `
                                          -SampleEpochLte $maxHub
            $compatRows = ConvertTo-CompatRowsFromSamplesRaw -HubRows $hubRows -SatRows $satRows
        }

        Write-Host "          Downloaded: $($hubRows.Count) hub rows -> $($compatRows.Count) flattened rows"
    } catch {
        Write-Host "    [!] Supabase download FAILED: $_" -ForegroundColor Red
        $stationResults += @{ name = $station.name; status = "FAILED"; entries = 0 }
        continue
    }

    if ($compatRows.Count -eq 0) {
        Write-Host "    [!] No data returned for $($station.id)" -ForegroundColor Yellow
        $stationResults += @{ name = $station.name; status = "empty"; entries = 0 }
        continue
    }

    # -- Step 2: Archive raw Supabase response --------------------------------
    $archiveFile = Join-Path $archiveFolder $archiveName
    try {
        $compatRows | ConvertTo-Json -Depth 10 -Compress | Set-Content $archiveFile -Encoding UTF8
        $archiveSize = [math]::Round((Get-Item $archiveFile).Length / 1024, 1)
        Write-Host "    [2/3] Archived: $archiveName ($archiveSize KB, $($compatRows.Count) rows)"
    } catch {
        Write-Host "    [!] Archive write failed: $_" -ForegroundColor Yellow
    }

    # -- Step 3: Build merged_data.js (structured v2 format) --
    Write-Host "    [3/3] Building merged_data.js..."

    $feeds = @()
    foreach ($row in $compatRows) {
        $feeds += ConvertTo-StructuredFeed $row
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
                Write-Host "          No new data - skipping merged_data.js rewrite ($($feeds.Count) entries unchanged)"
            }
        } catch { $dataChanged = $true }
    }

    # Force one-time canonical rewrite if legacy sat_a/sat_b keys are present.
    if (-not $dataChanged -and (Test-Path $jsFile)) {
        try {
            $existingJs = Get-Content $jsFile -Raw
            if ($existingJs -match 'sat_a_' -or $existingJs -match 'sat_b_') {
                $dataChanged = $true
                Write-Host "          Legacy satellite keys detected (sat_a/sat_b) - forcing schema rewrite"
            }
        } catch {
            $dataChanged = $true
        }
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
    @{ name = "Perth / Noranda";  lat = -31.87; lon = 115.90; stationKey = "wroom" }
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

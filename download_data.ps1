<#
.SYNOPSIS
    Downloads ThingSpeak channel data for the Seaweed Station Dashboard.
.DESCRIPTION
    - Reads configuration from config.json (written by settings.html)
    - Downloads data for ALL configured ThingSpeak channels (Perth, Shangani, Funzi)
    - Each channel's data is stored in data/(dataFolder)/ subfolders (e.g. data/data_3262071_TT/)
    - Archives raw JSON with dated filenames: yyyyMMdd.json (daily) or yyyyMMddHH.json (hourly)
    - Merges ALL archived downloads into a deduplicated merged_data.js per channel
    - Downloads Open-Meteo weather data for each table location
    - Cleans up archive files older than RetentionDays
    Run manually or via Task Scheduler using apply_schedule.ps1
.PARAMETER MaxResults
    Override max entries to fetch per channel (default: from config.json or 8000)
.PARAMETER RetentionDays
    Override retention in days (default: from config.json or 90)
.PARAMETER ScheduleType
    Override schedule type: 'daily' (yyyyMMdd) or 'hourly' (yyyyMMddHH). Default: from config.json
.EXAMPLE
    .\download_data.ps1
#>

param(
    [int]$MaxResults      = 0,
    [int]$RetentionDays   = 0,
    [string]$ScheduleType = ""
)

$ErrorActionPreference = "Stop"

# ═══════════════════════════════════════════════════════════════════
# LOAD config.json
# ═══════════════════════════════════════════════════════════════════

# Default channel definitions -- one per table
$defaultChannels = @(
    @{ id = "perth";    name = "Perth Test Table";    channelId = "3262071"; apiKey = "VVHUX39KINYPLCVI"; dataFolder = "data_3262071_TT" }
    @{ id = "wroom";    name = "Perth WROOM PTT";     channelId = "3246116"; apiKey = "7K00B1Y8DNOTEIM0"; dataFolder = "data_WROOM_PTT" }
    @{ id = "shangani"; name = "Shangani Aramani";    channelId = "3262074";  apiKey = "X7ZETMYRRQCAFE8S";  dataFolder = "data_Shangani" }
    @{ id = "funzi";    name = "Funzi Island";        channelId = "3256756";  apiKey = "D8TXB5B33KPWRIHO";  dataFolder = "data_Funzi" }
)

$cfgDefaults = @{
    scheduleType   = "daily"
    maxResults     = 8000
    retentionDays  = 90
    dataPath       = ""          # Full path to the data/ folder; channel subfolders are created inside here
}

$cfgFile = Join-Path $PSScriptRoot "config.json"
$cfg = $cfgDefaults.Clone()
$channels = $defaultChannels

if (Test-Path $cfgFile) {
    try {
        $fileJson = [System.IO.File]::ReadAllText($cfgFile, [System.Text.Encoding]::UTF8) | ConvertFrom-Json

        if ($fileJson.scheduleType)                                       { $cfg.scheduleType   = $fileJson.scheduleType }
        if ($fileJson.maxResults  -and $fileJson.maxResults  -gt 0)       { $cfg.maxResults     = [int]$fileJson.maxResults }
        if ($fileJson.retentionDays -and $fileJson.retentionDays -gt 0)   { $cfg.retentionDays  = [int]$fileJson.retentionDays }
        if ($fileJson.dataPath -and $fileJson.dataPath.Trim() -ne "") { $cfg.dataPath = $fileJson.dataPath.Trim() }

        # Load per-channel config if present
        if ($fileJson.channels -and $fileJson.channels.Count -gt 0) {
            $channels = @()
            foreach ($ch in $fileJson.channels) {
                $chObj = @{
                    id         = if ($ch.id)         { $ch.id }         else { "" }
                    name       = if ($ch.name)       { $ch.name }       else { $ch.id }
                    channelId  = if ($ch.channelId)  { $ch.channelId }  else { "" }
                    apiKey     = if ($ch.apiKey)      { $ch.apiKey }     else { "" }
                    dataFolder = if ($ch.dataFolder) { $ch.dataFolder } else { "data_$($ch.id)" }
                    dualChannel = $false
                    channelId2  = ""
                    apiKey2     = ""
                }
                if ($ch.dualChannel -eq $true) {
                    $chObj.dualChannel = $true
                    $chObj.channelId2  = if ($ch.channelId2) { $ch.channelId2 } else { "" }
                    $chObj.apiKey2     = if ($ch.apiKey2)     { $ch.apiKey2 }    else { "" }
                }
                $channels += $chObj
            }
        }
        # Legacy single-channel config fallback
        elseif ($fileJson.channelId) {
            $channels[0].channelId = $fileJson.channelId
            if ($fileJson.apiKey) { $channels[0].apiKey = $fileJson.apiKey }
            if ($fileJson.dataFolder -and $fileJson.dataFolder.Trim() -ne "") {
                $channels[0].dataFolder = $fileJson.dataFolder.Trim()
            }
        }
    }
    catch {
        Write-Host "  [!] Warning: could not read config.json ($_) -- using defaults" -ForegroundColor Yellow
    }
}

# Command-line overrides
if ($MaxResults   -gt 0)  { $cfg.maxResults    = $MaxResults }
if ($RetentionDays -gt 0) { $cfg.retentionDays = $RetentionDays }
if ($ScheduleType -ne "") { $cfg.scheduleType  = $ScheduleType }

# -- Resolve data root (the data/ folder containing channel subfolders) ------
$dataRoot = if ($cfg.dataPath -ne "") {
    if ([System.IO.Path]::IsPathRooted($cfg.dataPath)) {
        $cfg.dataPath
    } else {
        Join-Path $PSScriptRoot $cfg.dataPath
    }
} else {
    Join-Path $PSScriptRoot "data"
}

if (!(Test-Path $dataRoot)) {
    New-Item -ItemType Directory -Path $dataRoot -Force | Out-Null
    Write-Host "  [+] Created data root: $dataRoot" -ForegroundColor Cyan
}

# -- Resolve project-local data folder (the data/ folder that HTML pages reference) --
$pagesDataRoot = ""
if ($cfg.ContainsKey("pagesPath") -or $null -ne $fileJson.pagesPath) {
    $ppRaw = ""
    try { $ppRaw = $fileJson.pagesPath } catch {}
    if ($ppRaw -and $ppRaw.Trim() -ne "") {
        #  pagesPath points to .../ThingSpeak_Dashboard/pages, so data/ is ../data/
        $pagesDataRoot = Join-Path (Split-Path $ppRaw -Parent) "data"
        if (!(Test-Path $pagesDataRoot)) {
            New-Item -ItemType Directory -Path $pagesDataRoot -Force | Out-Null
            Write-Host "  [+] Created pages data root: $pagesDataRoot" -ForegroundColor Cyan
        }
    }
}

# -- Dated archive filename ---------------------------------------------------
if ($cfg.scheduleType -eq "hourly") {
    $archiveName = (Get-Date -Format "yyyyMMddHH") + ".json"
} else {
    $archiveName = (Get-Date -Format "yyyyMMdd") + ".json"
}

# ═══════════════════════════════════════════════════════════════════
# BANNER
# ═══════════════════════════════════════════════════════════════════
Write-Host ""
Write-Host "  ============================================"
Write-Host "   Seaweed Station - ThingSpeak Download"
Write-Host "  ============================================"
Write-Host "  Script     : $PSScriptRoot"
  Write-Host "  Data root  : $dataRoot"
Write-Host "  Schedule   : $($cfg.scheduleType)  ->  $archiveName"
Write-Host "  Channels   : $($channels.Count)"
foreach ($ch in $channels) {
    $status = if ($ch.channelId) { $ch.channelId } else { "(not configured)" }
    Write-Host "    - $($ch.name): $status -> $($ch.dataFolder)/"
}
Write-Host "  Time       : $(Get-Date -Format 'yyyy-MM-dd HH:mm:ss')"
Write-Host ""

# ═══════════════════════════════════════════════════════════════════
# PROCESS EACH CHANNEL
# ═══════════════════════════════════════════════════════════════════

$channelResults = @()
$allSortedFeeds = @{}  # keyed by channel id for weather date range

foreach ($channel in $channels) {
    Write-Host ""
    Write-Host "  ──────────────────────────────────────────"
    Write-Host "  Channel: $($channel.name)"
    Write-Host "  ──────────────────────────────────────────"

    # Skip channels with no channelId configured
    if (-not $channel.channelId -or $channel.channelId.Trim() -eq "") {
        Write-Host "    [skip] No Channel ID configured -- skipping" -ForegroundColor Yellow
        $channelResults += @{ name = $channel.name; status = "skipped"; entries = 0 }
        continue
    }

    # Resolve folder paths (relative to dashboard root, not script root)
    $archiveFolder = if ([System.IO.Path]::IsPathRooted($channel.dataFolder)) {
        $channel.dataFolder
    } else {
        Join-Path $dataRoot $channel.dataFolder
    }

    # Ensure directory exists
    if (!(Test-Path $archiveFolder)) {
        New-Item -ItemType Directory -Path $archiveFolder -Force | Out-Null
        Write-Host "    [+] Created folder: $archiveFolder"
    }

    # ==================================================================
    # DUAL-CHANNEL MODE (e.g. WROOM: separate temp + humidity channels)
    # ==================================================================
    if ($channel.dualChannel -eq $true -and $channel.channelId2 -ne "") {
        $archiveBase = $archiveName -replace '\.json$', ''
        $outTemp = Join-Path $archiveFolder ("temp_$archiveBase.json")
        $outHum  = Join-Path $archiveFolder ("hum_$archiveBase.json")

        # Download Channel 1 (Temperature)
        $url1 = "https://api.thingspeak.com/channels/$($channel.channelId)/feeds.json?api_key=$($channel.apiKey)&results=$($cfg.maxResults)"
        Write-Host "    [1/4] Downloading TEMP channel $($channel.channelId)..."
        try {
            Invoke-WebRequest -Uri $url1 -OutFile $outTemp -UseBasicParsing
            $fs1 = (Get-Item $outTemp).Length
            Write-Host "          Saved: temp_$archiveBase.json ($([math]::Round($fs1/1024, 1)) KB)"
        } catch {
            Write-Host "    [!] Temp download FAILED: $_" -ForegroundColor Red
            $channelResults += @{ name = $channel.name; status = "FAILED"; entries = 0 }
            continue
        }

        # Download Channel 2 (Humidity)
        $url2 = "https://api.thingspeak.com/channels/$($channel.channelId2)/feeds.json?api_key=$($channel.apiKey2)&results=$($cfg.maxResults)"
        Write-Host "    [2/4] Downloading HUM channel $($channel.channelId2)..."
        try {
            Invoke-WebRequest -Uri $url2 -OutFile $outHum -UseBasicParsing
            $fs2 = (Get-Item $outHum).Length
            Write-Host "          Saved: hum_$archiveBase.json ($([math]::Round($fs2/1024, 1)) KB)"
        } catch {
            Write-Host "    [!] Hum download FAILED: $_" -ForegroundColor Red
            $channelResults += @{ name = $channel.name; status = "FAILED"; entries = 0 }
            continue
        }

        # Validate both
        Write-Host "    [3/4] Validating & merging..."
        $rawTemp = [System.IO.File]::ReadAllText($outTemp, [System.Text.Encoding]::UTF8)
        $rawHum  = [System.IO.File]::ReadAllText($outHum,  [System.Text.Encoding]::UTF8)
        if ($rawTemp -notmatch '"feeds"\s*:\s*\[' -or $rawHum -notmatch '"feeds"\s*:\s*\[') {
            Write-Host "    [!] Invalid response - no feeds array found" -ForegroundColor Red
            $channelResults += @{ name = $channel.name; status = "FAILED"; entries = 0 }
            continue
        }

        # Merge ALL temp archives
        $tempFeeds = @{}
        $tempChannel = $null
        $tempArchives = @()
        $tempArchives += Get-ChildItem -Path $archiveFolder -Filter "temp_????????.json"   -ErrorAction SilentlyContinue
        $tempArchives += Get-ChildItem -Path $archiveFolder -Filter "temp_??????????.json" -ErrorAction SilentlyContinue
        $tempArchives = $tempArchives | Sort-Object Name -Unique
        foreach ($af in $tempArchives) {
            try {
                $j = [System.IO.File]::ReadAllText($af.FullName, [System.Text.Encoding]::UTF8) | ConvertFrom-Json
                if ($j.channel) { $tempChannel = $j.channel }
                if ($j.feeds) { foreach ($f in $j.feeds) { $tempFeeds[[string]$f.entry_id] = $f } }
            } catch { Write-Host "          [!] Skipped corrupt: $($af.Name)" -ForegroundColor Yellow }
        }

        # Merge ALL hum archives
        $humFeeds = @{}
        $humChannel = $null
        $humArchives = @()
        $humArchives += Get-ChildItem -Path $archiveFolder -Filter "hum_????????.json"   -ErrorAction SilentlyContinue
        $humArchives += Get-ChildItem -Path $archiveFolder -Filter "hum_??????????.json" -ErrorAction SilentlyContinue
        $humArchives = $humArchives | Sort-Object Name -Unique
        foreach ($af in $humArchives) {
            try {
                $j = [System.IO.File]::ReadAllText($af.FullName, [System.Text.Encoding]::UTF8) | ConvertFrom-Json
                if ($j.channel) { $humChannel = $j.channel }
                if ($j.feeds) { foreach ($f in $j.feeds) { $humFeeds[[string]$f.entry_id] = $f } }
            } catch { Write-Host "          [!] Skipped corrupt: $($af.Name)" -ForegroundColor Yellow }
        }

        $sortedTemp = $tempFeeds.Values | Sort-Object { [int]$_.entry_id }
        $sortedHum  = $humFeeds.Values  | Sort-Object { [int]$_.entry_id }
        $totalTemp = $tempFeeds.Count
        $totalHum  = $humFeeds.Count
        $totalArchives = $tempArchives.Count + $humArchives.Count
        Write-Host "          Temp entries: $totalTemp  |  Hum entries: $totalHum  |  Archives: $totalArchives"

        # Use temp feeds for weather date range lookup
        $allSortedFeeds[$channel.id] = $sortedTemp

        # Build merged_data.js with dual-channel structure
        $mergedObj = [ordered]@{
            tempChannel = $tempChannel
            humChannel  = $humChannel
            tempFeeds   = @($sortedTemp)
            humFeeds    = @($sortedHum)
        }
        $mergedJson = $mergedObj | ConvertTo-Json -Depth 10 -Compress

        Write-Host "    [4/4] Writing merged_data.js..."
        $header  = "// Auto-generated by download_data.ps1`r`n"
        $header += "// Dual-channel: Temp=$($channel.channelId), Hum=$($channel.channelId2)`r`n"
        $header += "// Downloaded: $(Get-Date -Format 'yyyy-MM-dd HH:mm:ss')`r`n"
        $header += "// Temp entries: $totalTemp | Hum entries: $totalHum (from $totalArchives archives)`r`n"
        $jsContent = $header + "window.THINGSPEAK_DATA = " + $mergedJson + ";`r`n"

        $jsFile = Join-Path $archiveFolder "merged_data.js"
        [System.IO.File]::WriteAllText($jsFile, $jsContent, [System.Text.Encoding]::UTF8)
        $jsSize = [math]::Round($jsContent.Length / 1024, 1)
        Write-Host "          Written: merged_data.js ($jsSize KB)"

        # Sync to project-local pages data folder
        if ($pagesDataRoot -ne "") {
            $pagesChFolder = Join-Path $pagesDataRoot $channel.dataFolder
            if (!(Test-Path $pagesChFolder)) {
                New-Item -ItemType Directory -Path $pagesChFolder -Force | Out-Null
            }
            Copy-Item -Path $jsFile -Destination (Join-Path $pagesChFolder "merged_data.js") -Force
            Write-Host "          Synced -> $pagesChFolder\merged_data.js"
        }

        # Cleanup old archives
        $cutoffDate = (Get-Date).AddDays(-$cfg.retentionDays)
        $allDualArchives = @($tempArchives) + @($humArchives)
        $oldFiles = $allDualArchives | Where-Object { $_.CreationTime -lt $cutoffDate }
        if ($oldFiles -and $oldFiles.Count -gt 0) {
            $oldFiles | Remove-Item -Force
            Write-Host "          Cleaned up $($oldFiles.Count) old archive(s)"
        }

        $channelResults += @{ name = $channel.name; status = "OK"; entries = ($totalTemp + $totalHum) }
        continue
    }

    # ==================================================================
    # STANDARD SINGLE-CHANNEL MODE
    # ==================================================================

    # -- Step 1: Download from ThingSpeak -------------------------------------
    $outFile = Join-Path $archiveFolder $archiveName
    $url = "https://api.thingspeak.com/channels/$($channel.channelId)/feeds.json?api_key=$($channel.apiKey)&results=$($cfg.maxResults)"

    Write-Host "    [1/3] Downloading channel $($channel.channelId)..."
    try {
        Invoke-WebRequest -Uri $url -OutFile $outFile -UseBasicParsing
        $fileSize = (Get-Item $outFile).Length
        Write-Host "          Saved: $archiveName ($([math]::Round($fileSize/1024, 1)) KB)"
    }
    catch {
        Write-Host "    [!] Download FAILED: $_" -ForegroundColor Red
        $channelResults += @{ name = $channel.name; status = "FAILED"; entries = 0 }
        continue
    }

    # -- Step 2: Validate download --------------------------------------------
    Write-Host "    [2/3] Validating..."
    $rawJson = [System.IO.File]::ReadAllText($outFile, [System.Text.Encoding]::UTF8)

    if ($rawJson -notmatch '"feeds"\s*:\s*\[') {
        Write-Host "    [!] Invalid response - no feeds array found" -ForegroundColor Red
        Remove-Item $outFile -ErrorAction SilentlyContinue
        $channelResults += @{ name = $channel.name; status = "FAILED"; entries = 0 }
        continue
    }

    $feedCount = ([regex]::Matches($rawJson, '"entry_id"')).Count
    $lastEntryId = if ($rawJson -match '"last_entry_id":\s*(\d+)') { $Matches[1] } else { "?" }
    Write-Host "          New entries: $feedCount  (last: #$lastEntryId)"

    if ($feedCount -ge $cfg.maxResults) {
        Write-Host "    [!] Channel may have >$($cfg.maxResults) entries" -ForegroundColor Yellow
    }

    # -- Step 3: Merge all archives into deduplicated dataset -----------------
    Write-Host "    [3/3] Merging archives..."

    $allFeeds = @{}
    $channelBlock = $null

    $archiveFiles = @()
    $archiveFiles += Get-ChildItem -Path $archiveFolder -Filter "????????.json"     -ErrorAction SilentlyContinue
    $archiveFiles += Get-ChildItem -Path $archiveFolder -Filter "??????????.json"   -ErrorAction SilentlyContinue
    $archiveFiles += Get-ChildItem -Path $archiveFolder -Filter "thingspeak_*.json" -ErrorAction SilentlyContinue
    $archiveFiles = $archiveFiles | Sort-Object Name -Unique

    $archiveCount = $archiveFiles.Count
    Write-Host "          Archive files: $archiveCount"

    foreach ($af in $archiveFiles) {
        try {
            $json = [System.IO.File]::ReadAllText($af.FullName, [System.Text.Encoding]::UTF8)
            $parsed = $json | ConvertFrom-Json
            if ($parsed.channel -and $null -ne $parsed.channel) { $channelBlock = $parsed.channel }
            if ($parsed.feeds -and $parsed.feeds.Count -gt 0) {
                foreach ($f in $parsed.feeds) {
                    $eid = [string]$f.entry_id
                    $allFeeds[$eid] = $f
                }
            }
        }
        catch {
            Write-Host "          [!] Skipped corrupt file: $($af.Name)" -ForegroundColor Yellow
        }
    }

    $totalEntries = $allFeeds.Count
    Write-Host "          Total unique entries: $totalEntries"

    # Sort feeds by entry_id
    $sortedFeeds = $allFeeds.Values | Sort-Object { [int]$_.entry_id }
    $allSortedFeeds[$channel.id] = $sortedFeeds

    # Build merged object
    $mergedObj = [ordered]@{
        channel = $channelBlock
        feeds   = @($sortedFeeds)
    }
    $mergedJson = $mergedObj | ConvertTo-Json -Depth 10 -Compress

    # Write merged_data.js into the channel's data folder
    $header  = "// Auto-generated by download_data.ps1`r`n"
    $header += "// Channel: $($channel.name) ($($channel.channelId))`r`n"
    $header += "// Downloaded: $(Get-Date -Format 'yyyy-MM-dd HH:mm:ss')`r`n"
    $header += "// Total unique entries: $totalEntries (from $archiveCount archives)`r`n"
    $jsContent = $header + "window.THINGSPEAK_DATA = " + $mergedJson + ";`r`n"

    $jsFile = Join-Path $archiveFolder "merged_data.js"
    [System.IO.File]::WriteAllText($jsFile, $jsContent, [System.Text.Encoding]::UTF8)
    $jsSize = [math]::Round($jsContent.Length / 1024, 1)
    Write-Host "          Written: merged_data.js ($jsSize KB, $totalEntries entries)"

    # Sync to project-local pages data folder
    if ($pagesDataRoot -ne "") {
        $pagesChFolder = Join-Path $pagesDataRoot $channel.dataFolder
        if (!(Test-Path $pagesChFolder)) {
            New-Item -ItemType Directory -Path $pagesChFolder -Force | Out-Null
        }
        Copy-Item -Path $jsFile -Destination (Join-Path $pagesChFolder "merged_data.js") -Force
        Write-Host "          Synced -> $pagesChFolder\merged_data.js"
    }

    # -- Cleanup old archives -------------------------------------------------
    $cutoffDate = (Get-Date).AddDays(-$cfg.retentionDays)
    $oldFiles = $archiveFiles | Where-Object { $_.CreationTime -lt $cutoffDate }
    if ($oldFiles -and $oldFiles.Count -gt 0) {
        $oldFiles | Remove-Item -Force
        Write-Host "          Cleaned up $($oldFiles.Count) old archive(s)"
    }

    $channelResults += @{ name = $channel.name; status = "OK"; entries = $totalEntries }
}

# ═══════════════════════════════════════════════════════════════════
# WEATHER DATA (Open-Meteo) -- one download per table location
# ═══════════════════════════════════════════════════════════════════
Write-Host ""
Write-Host "  ──────────────────────────────────────────"
Write-Host "  Open-Meteo Weather Data"
Write-Host "  ──────────────────────────────────────────"

# Weather locations: folder is derived from matched channel's dataFolder
$weatherLocationsBase = @(
    @{ name = "Perth / Noranda";  lat = -31.87; lon = 115.90; channelKey = "perth" }
    @{ name = "Perth / Noranda";  lat = -31.87; lon = 115.90; channelKey = "wroom" }
    @{ name = "Shangani Aramani"; lat =  -4.55; lon =  39.50; channelKey = "shangani" }
    @{ name = "Funzi Island";     lat =  -4.55; lon =  39.45; channelKey = "funzi" }
)
$weatherLocations = @()
foreach ($wlb in $weatherLocationsBase) {
    $wch = $channels | Where-Object { $_.id -eq $wlb.channelKey } | Select-Object -First 1
    $weatherLocations += @{
        name       = $wlb.name
        lat        = $wlb.lat
        lon        = $wlb.lon
        channelKey = $wlb.channelKey
        folder     = if ($wch) { $wch.dataFolder } else { "data_$($wlb.channelKey)" }
    }
}

$todayStr    = (Get-Date).ToString("yyyy-MM-dd")
$weatherFail = 0

foreach ($wloc in $weatherLocations) {
    $wFolder = Join-Path $dataRoot $wloc.folder
    if (!(Test-Path $wFolder)) {
        New-Item -ItemType Directory -Path $wFolder -Force | Out-Null
    }

    # Determine date range from this channel's feed data, or fall back to 7 days
    $weatherStartStr = ""
    $weatherEndStr   = ""
    $feeds = $allSortedFeeds[$wloc.channelKey]
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

    # Clamp start_date to no earlier than 90 days ago (Open-Meteo archive limit)
    $minAllowed = (Get-Date).AddDays(-90).ToString("yyyy-MM-dd")
    if ($weatherStartStr -lt $minAllowed) {
        $weatherStartStr = $minAllowed
    }

    if ($weatherEndStr -ge $todayStr) {
        $apiBase = "https://api.open-meteo.com/v1/forecast"
    } else {
        $apiBase = "https://archive-api.open-meteo.com/v1/archive"
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

        $wHeader  = "// Auto-generated weather cache by download_data.ps1`r`n"
        $wHeader += "// Downloaded: $(Get-Date -Format 'yyyy-MM-dd HH:mm:ss')`r`n"
        $wHeader += "// Location: $($wloc.name) ($($wloc.lat), $($wloc.lon))`r`n"
        $wHeader += "// Range: $weatherStartStr to $weatherEndStr`r`n"
        $wContent = $wHeader + "window.WEATHER_CACHE = " + $wJson + ";`r`n"

        $wFile = Join-Path $wFolder "weather_data.js"
        [System.IO.File]::WriteAllText($wFile, $wContent, [System.Text.Encoding]::UTF8)
        $wSize = [math]::Round($wContent.Length / 1024, 1)
        Write-Host "    $($wloc.name): weather_data.js ($wSize KB) -> $($wloc.folder)/"

        # Sync to project-local pages data folder
        if ($pagesDataRoot -ne "") {
            $pagesWFolder = Join-Path $pagesDataRoot $wloc.folder
            if (!(Test-Path $pagesWFolder)) {
                New-Item -ItemType Directory -Path $pagesWFolder -Force | Out-Null
            }
            Copy-Item -Path $wFile -Destination (Join-Path $pagesWFolder "weather_data.js") -Force
            Write-Host "          Synced -> $pagesWFolder\weather_data.js"
        }
    }
    catch {
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
foreach ($cr in $channelResults) {
    $icon = if ($cr.status -eq "OK") { "[OK]" } elseif ($cr.status -eq "skipped") { "[--]" } else { "[!!]" }
    Write-Host "  $icon $($cr.name): $($cr.status) ($($cr.entries) entries)"
}
Write-Host "  Weather: $($weatherLocations.Count - $weatherFail)/$($weatherLocations.Count) locations"
Write-Host ""
Write-Host "  Tides use client-side harmonic prediction (no download needed)."
Write-Host "  Open the dashboard HTML files in a browser to view."
Write-Host ""

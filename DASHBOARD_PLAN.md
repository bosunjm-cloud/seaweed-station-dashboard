# Seaweed Station — ThingSpeak Dashboard & Data Pipeline

## Overview

Offline-capable dashboard that auto-downloads ThingSpeak channel data daily,
processes the CSV-encoded fields, deduplicates across downloads, and presents
a clean monitoring UI for the Seaweed Station network (T0 gateway + Sat-A + Sat-B).

---

## Architecture

```
 ThingSpeak Cloud                     Your PC / Google Drive
 ┌─────────────────┐     daily       ┌──────────────────────────────────┐
 │ Channel 3262071 │ ──(PS1 script)──▶ data/thingspeak_YYYY-MM-DD.json │
 │  8 fields/entry │                 │ data/merged_data.js (auto-gen)  │
 └─────────────────┘                 └──────────────┬───────────────────┘
                                                    │
                                        ┌───────────▼───────────────┐
                                        │    dashboard.html         │
                                        │  ┌─────────────────────┐  │
                                        │  │ Status Cards (T0,   │  │
                                        │  │ Sat-A, Sat-B, Sys)  │  │
                                        │  ├─────────────────────┤  │
                                        │  │ Temp Chart (D/W/M)  │  │
                                        │  ├─────────────────────┤  │
                                        │  │ Humidity Chart      │  │
                                        │  ├─────────────────────┤  │
                                        │  │ Battery Chart       │  │
                                        │  ├─────────────────────┤  │
                                        │  │ Daily Peaks Table   │  │
                                        │  ├─────────────────────┤  │
                                        │  │ Data Health / Gaps  │  │
                                        │  └─────────────────────┘  │
                                        └───────────────────────────┘
```

---

## ThingSpeak Field Mapping (Channel 3262071)

| Field  | Name             | Format                           | Example                  |
|--------|------------------|----------------------------------|--------------------------|
| field1 | T0 Battery %     | Numeric                          | `87.4`                   |
| field2 | T0 Sensors       | `t1,rh1,t2,rh2` (°C, %RH)      | `23.45,65.2,24.10,63.8`  |
| field3 | T0 Status        | `batV,rssi,bootCnt,heap`         | `3.98,0,498,237652`      |
| field4 | Sat-A Status     | `batV,bat%,rssi,sampleId`        | `4.03,86.0,0,2`          |
| field5 | Sat-A Sensors    | `t1,rh1,t2,rh2` (°C, %RH)      | `NC,NC,NC,NC`            |
| field6 | Sat-B Status     | `batV,bat%,rssi,sampleId`        | `3.35,29.0,0,2`          |
| field7 | Sat-B Sensors    | `t1,rh1,t2,rh2` (°C, %RH)      | `NC,NC,NC,NC`            |
| field8 | System           | `sdFreeKB,csq,uploadOk`          | `30515552,0,0`           |

**NC** = Not Connected (sensor probe absent or fault). Dashboard treats NC as null.

---

## Folder Structure

```
ThingSpeak_Dashboard/
├── dashboard.html              ← Open this in a browser (the dashboard)
├── download_data.ps1           ← Run to download data (manual or scheduled)
├── setup_daily_download.ps1    ← Run ONCE to create a daily Task Scheduler job
├── DASHBOARD_PLAN.md           ← This file
└── data/                       ← Created automatically by download_data.ps1
    ├── merged_data.js          ← Auto-generated; loaded by dashboard.html
    ├── thingspeak_2026-02-21_0800.json   ← Archived raw download
    ├── thingspeak_2026-02-22_0800.json
    └── ...
```

---

## Data Flow

1. **download_data.ps1** runs (manually or via Task Scheduler)
2. Fetches `https://api.thingspeak.com/channels/3262071/feeds.json?api_key=...&results=8000`
3. Saves raw JSON as `data/thingspeak_YYYY-MM-DD_HHMM.json` (timestamped archive)
4. Generates `data/merged_data.js` — wraps the JSON as `window.THINGSPEAK_DATA = {...};`
5. **dashboard.html** opened in browser → auto-loads `data/merged_data.js`
6. JavaScript parses CSV sub-fields, deduplicates, renders charts & status cards

### Deduplication Strategy

ThingSpeak returns all channel data (up to 8000) on each request, so each daily
download is a superset of the previous one. The `merged_data.js` file is simply
the latest download wrapped as JS. No cross-file merging is needed until the
channel exceeds 8000 entries.

The dashboard also deduplicates by `entry_id` if multiple data sources are loaded
(e.g., live fetch + local file), so duplicates are never an issue.

### ThingSpeak API Notes

- **Free tier**: Max 8000 entries per request, min 15s between data points
- **Pagination**: Use `start` and `end` query params for >8000 entries
- **CORS**: ThingSpeak API supports CORS, so the dashboard can also fetch live
  data directly from the browser (works in Chrome from `file://`)
- **Read API Key**: `VVHUX39KINYPLCVI` (read-only, safe to share)

---

## Dashboard Features

### Status Cards
- **T0 Gateway**: Battery %, voltage, RSSI, boot count, free heap, last seen
- **Satellite A**: Battery %, voltage, RSSI, sample ID, last seen, sensor status
- **Satellite B**: Battery %, voltage, RSSI, sample ID, last seen, sensor status
- **System**: SD free space, cell signal quality, upload success count
- Color-coded health indicators (green/amber/red)

### Charts (with Day / Week / Month / All selector)
- **Temperature**: All T/H sensor temps on one plot (T0-S1, T0-S2, Sat-A-S1, Sat-A-S2, Sat-B-S1, Sat-B-S2)
- **Humidity**: All humidity readings on one plot (same sensors)
- **Battery**: Battery % for all three nodes over time

### Data Health
- Estimated sample period (auto-detected from data intervals)
- Data gaps detected (missed uploads / outages)
- Data completeness % per node
- Sensor connection status per node

### Daily Peaks Table
- Per-day min/max/avg for each sensor reading
- Battery trend (start, end, delta per day)

---

## Setup Instructions

### First-Time Setup

1. **Open PowerShell** in this folder (`ThingSpeak_Dashboard/`)
2. Run the download script once to get initial data:
   ```powershell
   .\download_data.ps1
   ```
3. Open `dashboard.html` in your browser — data loads automatically

### Automatic Daily Download

Run the scheduler setup script (requires admin):
```powershell
.\setup_daily_download.ps1
```
This creates a Windows Task Scheduler job that runs `download_data.ps1`
daily at 08:00. Change the time with `-Time "06:30"`.

### Manual Operation

- **Quick download**: Double-click `download_data.ps1` (or right-click → Run with PowerShell)
- **Live fetch**: Click "Fetch Live" button in the dashboard (requires internet)
- **Load file**: Click "Load JSON" in the dashboard to load any downloaded file

---

## Google Drive Sharing

### For You (Owner)
1. Place this entire `ThingSpeak_Dashboard` folder in Google Drive
2. Google Drive for Desktop syncs it automatically
3. The PS1 script downloads into `data/` → Drive syncs to cloud
4. Open `dashboard.html` from your local Drive folder — works immediately

### For Others (Shared Link Recipients)
Google Drive **cannot** render HTML files as live web pages. Options:

| Method | Effort | Result |
|--------|--------|--------|
| **Share folder** → they sync to their PC → open locally | Low | Full dashboard |
| **Host on GitHub Pages** (copy files to a GitHub repo) | Medium | Shareable URL |
| **Screenshots / PDF export** (Ctrl+P → Save as PDF) | Low | Static snapshot |

**Recommended**: Share the Google Drive folder. Recipients add it to their
Drive, sync via Drive for Desktop, and open `dashboard.html` locally.
The `data/merged_data.js` syncs too, so everyone sees the same data.

---

## Future Enhancements

- [ ] Pagination for channels with >8000 entries
- [ ] Email/notification alerts for low battery or data gaps
- [ ] CSV export of processed data
- [ ] GitHub Pages auto-deployment
- [ ] Multi-channel support (additional stations)
- [ ] Historical comparison (this week vs last week)

// station_config.js — Extracted from station.html (Sprint 6)
// Station configuration, state, SENSOR_MAPS, utility helpers
"use strict";

// =====================================================================
// STATION CONFIG (resolved from boot loader)
// =====================================================================
var TABLE_ID = window.__TABLE_ID || 'perth';
var STATION  = window.__STATION;

var DEFAULTS = {
  channelId:      STATION.channelId,
  apiKey:         STATION.apiKey,
  autoRefreshMin: 15,
};

var WEATHER_LOCATION = STATION.weather;

// =====================================================================
// STATE
// =====================================================================
var state = {
  allEntries:       [],
  filteredEntries:  [],
  syncSessions:     [],
  deviceStatus:     null,
  timeRange:        'week',
  dateStart:        null,
  dateEnd:          null,
  channelInfo:      null,
  dataSource:       '',
  charts:           { temp: null, hum: null, bat: null, volt: null, weather: null },
  weatherTimeRange: 'week',
  autoRefreshTimer: null,
};

var _stationSlotMap = {};

async function refreshDeviceStatus(renderAfter) {
  try {
    state.deviceStatus = await fetchDeviceStatus(TABLE_ID);
  } catch (e) {
    console.warn('[Dashboard] device_status fetch failed:', e.message || e);
  }
  if (renderAfter && state.allEntries && state.allEntries.length) {
    updateFreshnessBanner();
  }
}

// =====================================================================
// SENSOR MAP SVGs (per-station)
// =====================================================================
var SENSOR_MAPS = {
  perth: {
    viewBox: '0 0 820 280',
    label: 'Perth test table sensor placement diagram',
    svg:
      '<rect x="0" y="256" width="700" height="8" fill="#334155" rx="2"/>' +
      '<rect x="60" y="60" width="18" height="196" fill="#8B7355" rx="3"/>' +
      '<rect x="340" y="60" width="18" height="196" fill="#8B7355" rx="3"/>' +
      '<rect x="618" y="60" width="18" height="196" fill="#8B7355" rx="3"/>' +
      '<line x1="69" y1="252" x2="55" y2="268" stroke="#1e293b" stroke-width="4" stroke-linecap="round"/>' +
      '<line x1="69" y1="252" x2="83" y2="268" stroke="#1e293b" stroke-width="4" stroke-linecap="round"/>' +
      '<line x1="349" y1="252" x2="335" y2="268" stroke="#1e293b" stroke-width="4" stroke-linecap="round"/>' +
      '<line x1="349" y1="252" x2="363" y2="268" stroke="#1e293b" stroke-width="4" stroke-linecap="round"/>' +
      '<line x1="627" y1="252" x2="613" y2="268" stroke="#1e293b" stroke-width="4" stroke-linecap="round"/>' +
      '<line x1="627" y1="252" x2="641" y2="268" stroke="#1e293b" stroke-width="4" stroke-linecap="round"/>' +
      '<rect x="60" y="82" width="578" height="12" fill="#C8A96E" rx="2"/>' +
      '<rect x="60" y="102" width="578" height="12" fill="#C8A96E" rx="2"/>' +
      '<rect x="60" y="162" width="578" height="12" fill="#C8A96E" rx="2"/>' +
      '<rect x="60" y="182" width="578" height="12" fill="#C8A96E" rx="2"/>' +
      '<rect x="52" y="76" width="34" height="30" fill="#7A6040" rx="3"/>' +
      '<rect x="332" y="76" width="34" height="30" fill="#7A6040" rx="3"/>' +
      '<rect x="610" y="76" width="34" height="30" fill="#7A6040" rx="3"/>' +
      '<rect x="52" y="156" width="34" height="30" fill="#7A6040" rx="3"/>' +
      '<rect x="332" y="156" width="34" height="30" fill="#7A6040" rx="3"/>' +
      '<rect x="610" y="156" width="34" height="30" fill="#7A6040" rx="3"/>' +
      '<rect x="638" y="90" width="24" height="8" fill="#C8A96E" rx="2"/>' +
      '<rect x="638" y="170" width="24" height="8" fill="#C8A96E" rx="2"/>' +
      '<rect x="120" y="48" width="120" height="26" rx="4" fill="none" stroke="#a855f7" stroke-width="2"/>' +
      '<text x="180" y="66" font-family="sans-serif" font-size="13" font-weight="700" fill="#a855f7" text-anchor="middle">S4 - TL (Top Left)</text>' +
      '<rect x="390" y="48" width="130" height="26" rx="4" fill="none" stroke="#ef4444" stroke-width="2"/>' +
      '<text x="455" y="66" font-family="sans-serif" font-size="13" font-weight="700" fill="#ef4444" text-anchor="middle">S5 - TR (Top Right)</text>' +
      '<rect x="120" y="200" width="120" height="26" rx="4" fill="none" stroke="#38bdf8" stroke-width="2"/>' +
      '<text x="180" y="218" font-family="sans-serif" font-size="13" font-weight="700" fill="#38bdf8" text-anchor="middle">S1 - BL (Bot Left)</text>' +
      '<rect x="390" y="200" width="130" height="26" rx="4" fill="none" stroke="#eab308" stroke-width="2"/>' +
      '<text x="455" y="218" font-family="sans-serif" font-size="13" font-weight="700" fill="#eab308" text-anchor="middle">S3 - BR (Bot Right)</text>' +
      '<line x1="662" y1="133" x2="682" y2="133" stroke="#22c55e88" stroke-width="1.5" stroke-dasharray="4 3"/>' +
      '<rect x="682" y="120" width="110" height="26" rx="4" fill="none" stroke="#22c55e" stroke-width="2"/>' +
      '<text x="737" y="138" font-family="sans-serif" font-size="13" font-weight="700" fill="#22c55e" text-anchor="middle">S2 - CTRL</text>' +
      '<text x="349" y="280" text-anchor="middle" fill="#64748b" font-size="9">Wooden Rack (3 posts)</text>',
    legend: [
      { color: '#38bdf8', label: 'S1 \u2014 BL (Bottom Left)' },
      { color: '#22c55e', label: 'S2 \u2014 CTRL (Control)' },
      { color: '#eab308', label: 'S3 \u2014 BR (Bottom Right)' },
      { color: '#a855f7', label: 'S4 \u2014 TL (Top Left)' },
      { color: '#ef4444', label: 'S5 \u2014 TR (Top Right)' },
    ],
  },
  shangani: {
    viewBox: '0 0 900 300',
    label: 'Shangani seaweed table sensor placement diagram',
    svg: '<rect x="40" y="266" width="760" height="8" fill="#334155" rx="2"/>' +
      '<rect x="78" y="24" width="16" height="242" fill="#107c41" rx="3"/>' +
      '<rect x="238" y="24" width="16" height="242" fill="#107c41" rx="3"/>' +
      '<rect x="398" y="24" width="16" height="242" fill="#107c41" rx="3"/>' +
      '<rect x="558" y="24" width="16" height="242" fill="#107c41" rx="3"/>' +
      '<rect x="718" y="24" width="16" height="242" fill="#107c41" rx="3"/>' +
      '<line x1="86" y1="24" x2="726" y2="24" stroke="#21a366" stroke-width="4" stroke-linecap="round"/>' +
      '<line x1="86" y1="262" x2="72" y2="278" stroke="#1e293b" stroke-width="4" stroke-linecap="round"/>' +
      '<line x1="86" y1="262" x2="100" y2="278" stroke="#1e293b" stroke-width="4" stroke-linecap="round"/>' +
      '<line x1="246" y1="262" x2="232" y2="278" stroke="#1e293b" stroke-width="4" stroke-linecap="round"/>' +
      '<line x1="246" y1="262" x2="260" y2="278" stroke="#1e293b" stroke-width="4" stroke-linecap="round"/>' +
      '<line x1="406" y1="262" x2="392" y2="278" stroke="#1e293b" stroke-width="4" stroke-linecap="round"/>' +
      '<line x1="406" y1="262" x2="420" y2="278" stroke="#1e293b" stroke-width="4" stroke-linecap="round"/>' +
      '<line x1="566" y1="262" x2="552" y2="278" stroke="#1e293b" stroke-width="4" stroke-linecap="round"/>' +
      '<line x1="566" y1="262" x2="580" y2="278" stroke="#1e293b" stroke-width="4" stroke-linecap="round"/>' +
      '<line x1="726" y1="262" x2="712" y2="278" stroke="#1e293b" stroke-width="4" stroke-linecap="round"/>' +
      '<line x1="726" y1="262" x2="740" y2="278" stroke="#1e293b" stroke-width="4" stroke-linecap="round"/>' +
      '<rect x="46" y="85" width="720" height="12" fill="#21a366" rx="2"/>' +
      '<rect x="46" y="177" width="720" height="12" fill="#21a366" rx="2"/>' +
      '<rect x="68" y="68" width="36" height="34" fill="#0f6b3a" rx="3"/>' +
      '<rect x="228" y="68" width="36" height="34" fill="#0f6b3a" rx="3"/>' +
      '<rect x="388" y="68" width="36" height="34" fill="#0f6b3a" rx="3"/>' +
      '<rect x="548" y="68" width="36" height="34" fill="#0f6b3a" rx="3"/>' +
      '<rect x="708" y="68" width="36" height="34" fill="#0f6b3a" rx="3"/>' +
      '<rect x="68" y="160" width="36" height="34" fill="#0f6b3a" rx="3"/>' +
      '<rect x="228" y="160" width="36" height="34" fill="#0f6b3a" rx="3"/>' +
      '<rect x="388" y="160" width="36" height="34" fill="#0f6b3a" rx="3"/>' +
      '<rect x="548" y="160" width="36" height="34" fill="#0f6b3a" rx="3"/>' +
      '<rect x="708" y="160" width="36" height="34" fill="#0f6b3a" rx="3"/>' +
      '<text x="166" y="74" font-family="sans-serif" font-size="22" font-weight="800" fill="#33c481" opacity="0.58" text-anchor="middle">B1</text>' +
      '<text x="326" y="74" font-family="sans-serif" font-size="22" font-weight="800" fill="#33c481" opacity="0.58" text-anchor="middle">B2</text>' +
      '<text x="486" y="74" font-family="sans-serif" font-size="22" font-weight="800" fill="#33c481" opacity="0.58" text-anchor="middle">B3</text>' +
      '<text x="646" y="74" font-family="sans-serif" font-size="22" font-weight="800" fill="#33c481" opacity="0.58" text-anchor="middle">B4</text>' +
      '<text x="166" y="154" font-family="sans-serif" font-size="22" font-weight="800" fill="#33c481" opacity="0.58" text-anchor="middle">B5</text>' +
      '<text x="326" y="154" font-family="sans-serif" font-size="22" font-weight="800" fill="#33c481" opacity="0.58" text-anchor="middle">B6</text>' +
      '<text x="486" y="154" font-family="sans-serif" font-size="22" font-weight="800" fill="#33c481" opacity="0.58" text-anchor="middle">B7</text>' +
      '<text x="646" y="154" font-family="sans-serif" font-size="22" font-weight="800" fill="#33c481" opacity="0.58" text-anchor="middle">B8</text>' +
      '<rect x="190" y="38" width="44" height="26" rx="4" fill="none" stroke="#ef4444" stroke-width="2"/>' +
      '<text x="212" y="56" font-family="sans-serif" font-size="13" font-weight="700" fill="#ef4444" text-anchor="middle">S5</text>' +
      '<rect x="578" y="38" width="44" height="26" rx="4" fill="none" stroke="#eab308" stroke-width="2"/>' +
      '<text x="600" y="56" font-family="sans-serif" font-size="13" font-weight="700" fill="#eab308" text-anchor="middle">S3</text>' +
      '<rect x="190" y="112" width="44" height="26" rx="4" fill="none" stroke="#a855f7" stroke-width="2"/>' +
      '<text x="212" y="130" font-family="sans-serif" font-size="13" font-weight="700" fill="#a855f7" text-anchor="middle">S4</text>' +
      '<rect x="578" y="112" width="44" height="26" rx="4" fill="none" stroke="#22c55e" stroke-width="2"/>' +
      '<text x="600" y="130" font-family="sans-serif" font-size="13" font-weight="700" fill="#22c55e" text-anchor="middle">S2</text>' +
      '<rect x="578" y="215" width="44" height="26" rx="4" fill="none" stroke="#38bdf8" stroke-width="2"/>' +
      '<text x="600" y="233" font-family="sans-serif" font-size="13" font-weight="700" fill="#38bdf8" text-anchor="middle">S1</text>',
    legend: [
      { color: '#38bdf8', label: 'S1' },
      { color: '#22c55e', label: 'S2' },
      { color: '#eab308', label: 'S3' },
      { color: '#a855f7', label: 'S4' },
      { color: '#ef4444', label: 'S5' },
    ],
  },
  funzi: {
    viewBox: '0 0 930 280',
    label: 'Funzi sensor placement diagram',
    svg: '<rect x="55" y="132" width="12" height="108" fill="#3a7d44" rx="3"/>' +
      '<rect x="265" y="132" width="12" height="108" fill="#3a7d44" rx="3"/>' +
      '<rect x="475" y="132" width="12" height="108" fill="#3a7d44" rx="3"/>' +
      '<rect x="685" y="132" width="12" height="108" fill="#3a7d44" rx="3"/>' +
      '<line x1="58" y1="132" x2="58" y2="240" stroke="#6fc47e" stroke-width="2" stroke-opacity="0.6"/>' +
      '<line x1="268" y1="132" x2="268" y2="240" stroke="#6fc47e" stroke-width="2" stroke-opacity="0.6"/>' +
      '<line x1="478" y1="132" x2="478" y2="240" stroke="#6fc47e" stroke-width="2" stroke-opacity="0.6"/>' +
      '<line x1="688" y1="132" x2="688" y2="240" stroke="#6fc47e" stroke-width="2" stroke-opacity="0.6"/>' +
      '<rect x="55" y="132" width="642" height="8" fill="#3a7d44" rx="2"/>' +
      '<rect x="55" y="144" width="642" height="8" fill="#3a7d44" rx="2"/>' +
      '<line x1="55" y1="134" x2="697" y2="134" stroke="#6fc47e" stroke-width="1.5" stroke-opacity="0.6"/>' +
      '<line x1="55" y1="146" x2="697" y2="146" stroke="#6fc47e" stroke-width="1.5" stroke-opacity="0.6"/>' +
      '<rect x="55" y="194" width="642" height="8" fill="#3a7d44" rx="2"/>' +
      '<rect x="55" y="206" width="642" height="8" fill="#3a7d44" rx="2"/>' +
      '<line x1="55" y1="196" x2="697" y2="196" stroke="#6fc47e" stroke-width="1.5" stroke-opacity="0.6"/>' +
      '<line x1="55" y1="208" x2="697" y2="208" stroke="#6fc47e" stroke-width="1.5" stroke-opacity="0.6"/>' +
      '<rect x="50" y="127" width="22" height="28" fill="#2d5e35" rx="3"/><rect x="50" y="189" width="22" height="28" fill="#2d5e35" rx="3"/>' +
      '<rect x="260" y="127" width="22" height="28" fill="#2d5e35" rx="3"/><rect x="260" y="189" width="22" height="28" fill="#2d5e35" rx="3"/>' +
      '<rect x="470" y="127" width="22" height="28" fill="#2d5e35" rx="3"/><rect x="470" y="189" width="22" height="28" fill="#2d5e35" rx="3"/>' +
      '<rect x="680" y="127" width="22" height="28" fill="#2d5e35" rx="3"/><rect x="680" y="189" width="22" height="28" fill="#2d5e35" rx="3"/>' +
      '<line x1="30" y1="252" x2="720" y2="252" stroke="#888" stroke-width="2"/>' +
      '<rect x="48" y="249" width="26" height="6" fill="#555" rx="1"/><rect x="258" y="249" width="26" height="6" fill="#555" rx="1"/>' +
      '<rect x="468" y="249" width="26" height="6" fill="#555" rx="1"/><rect x="678" y="249" width="26" height="6" fill="#555" rx="1"/>' +
      '<line x1="61" y1="240" x2="61" y2="255" stroke="#888" stroke-width="1.5"/>' +
      '<line x1="271" y1="240" x2="271" y2="255" stroke="#888" stroke-width="1.5"/>' +
      '<line x1="481" y1="240" x2="481" y2="255" stroke="#888" stroke-width="1.5"/>' +
      '<line x1="691" y1="240" x2="691" y2="255" stroke="#888" stroke-width="1.5"/>' +
      '<rect x="107" y="74" width="120" height="36" fill="#7e22ce" fill-opacity="0.15" stroke="#a855f7" stroke-width="1.5" rx="5"/>' +
      '<text x="167" y="88" text-anchor="middle" fill="#a855f7" font-size="12" font-weight="700">S4</text>' +
      '<text x="167" y="103" text-anchor="middle" fill="#a855f7" font-size="10">Upper West</text>' +
      '<rect x="527" y="74" width="120" height="36" fill="#15803d" fill-opacity="0.15" stroke="#22c55e" stroke-width="1.5" rx="5"/>' +
      '<text x="587" y="88" text-anchor="middle" fill="#22c55e" font-size="12" font-weight="700">S2</text>' +
      '<text x="587" y="103" text-anchor="middle" fill="#22c55e" font-size="10">Upper East</text>' +
      '<rect x="107" y="220" width="120" height="36" fill="#0369a1" fill-opacity="0.15" stroke="#38bdf8" stroke-width="1.5" rx="5"/>' +
      '<text x="167" y="234" text-anchor="middle" fill="#38bdf8" font-size="12" font-weight="700">S1</text>' +
      '<text x="167" y="249" text-anchor="middle" fill="#38bdf8" font-size="10">Lower West</text>' +
      '<rect x="527" y="220" width="120" height="36" fill="#854d0e" fill-opacity="0.15" stroke="#eab308" stroke-width="1.5" rx="5"/>' +
      '<text x="587" y="234" text-anchor="middle" fill="#eab308" font-size="12" font-weight="700">S3</text>' +
      '<text x="587" y="249" text-anchor="middle" fill="#eab308" font-size="10">Lower East</text>' +
      '<line x1="697" y1="138" x2="762" y2="138" stroke="#f97316" stroke-width="1.5" stroke-dasharray="6,4"/>' +
      '<rect x="762" y="120" width="120" height="36" fill="#9a3412" fill-opacity="0.15" stroke="#f97316" stroke-width="1.5" rx="5"/>' +
      '<text x="822" y="134" text-anchor="middle" fill="#f97316" font-size="12" font-weight="700">Control</text>' +
      '<text x="822" y="149" text-anchor="middle" fill="#f97316" font-size="10">External Ref</text>' +
      '<text x="376" y="270" text-anchor="middle" fill="#64748b" font-size="9">Green Metal Rack (4 posts)</text>',
    legend: [
      { color: '#38bdf8', label: 'S1 — Lower West' },
      { color: '#22c55e', label: 'S2 — Upper East' },
      { color: '#eab308', label: 'S3 — Lower East' },
      { color: '#a855f7', label: 'S4 — Upper West' },
      { color: '#f97316', label: 'Control — External Ref' },
    ],
  },
};

// =====================================================================
// CONFIGURATION (persisted in localStorage)
// =====================================================================
function getConfig() {
  try {
    var s = JSON.parse(localStorage.getItem('seaweed_dashboard_config'));
    if (!s) return {};
    if (s.deviceProfiles && s.deviceProfiles.length) {
      var dp = s.deviceProfiles.find(function(p) { return p.id === TABLE_ID; });
      if (dp) {
        return { autoRefreshMin: s.autoRefreshMin, dataFolder: dp.dataFolder };
      }
    }
    return s;
  } catch (e) { return {}; }
}

// =====================================================================
// AUTO-REFRESH
// =====================================================================
function setupAutoRefresh() {
  if (state.autoRefreshTimer) clearInterval(state.autoRefreshTimer);
  state.autoRefreshTimer = null;

  var mins = 2;
  var label = document.getElementById('autoRefreshLabel');

  if (mins > 0) {
    state.autoRefreshTimer = setInterval(function () {
      console.log('[Dashboard] Auto-refresh triggered');
      fetchLiveData(true);
    }, mins * 60000);
    if (label) label.textContent = 'Auto-refresh: every ' + mins + 'm';
  } else {
    if (label) label.textContent = 'Auto-refresh: off';
  }
}

// =====================================================================
// UTILITIES  (csvParse, numParse, timeAgo provided by seaweed_common.js)
// =====================================================================

function fmtDate(d) {
  if (!d) return '--';
  return d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' })
       + ' ' + d.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });
}

function getTimezoneLabel() {
  try {
    var tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
    var offset = new Date().getTimezoneOffset();
    var sign = offset <= 0 ? '+' : '-';
    var absH = Math.floor(Math.abs(offset) / 60);
    var absM = Math.abs(offset) % 60;
    return tz + ' (UTC' + sign + absH + (absM ? ':' + String(absM).padStart(2, '0') : '') + ')';
  } catch (e) { return 'Local time'; }
}

function timeRangeLabel() {
  if (!state.filteredEntries.length) return 'No data';
  var first = state.filteredEntries[0].timestamp;
  var last  = state.filteredEntries[state.filteredEntries.length - 1].timestamp;
  var rangeText = { day: 'Last 24 hours', week: 'Last 7 days', month: 'Last 30 days', all: 'All data', custom: 'Custom range' };
  return (rangeText[state.timeRange] || 'All data') + ' | ' +
    first.toLocaleDateString('en-GB', { day: 'numeric', month: 'short' }) + ' - ' +
    last.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' }) +
    ' (' + state.filteredEntries.length + ' points)';
}

function toggleSensorMap() {
  var body = document.getElementById('sensorMapBody');
  var chevron = document.getElementById('sensorMapChevron');
  var toggle = document.getElementById('sensorMapToggle');
  var open = body.style.display === 'none';
  body.style.display = open ? 'block' : 'none';
  chevron.classList.toggle('open', open);
  toggle.setAttribute('aria-expanded', open ? 'true' : 'false');
  if (open) {
    setTimeout(function() {
      if (_sensorMiniMap) _sensorMiniMap.invalidateSize();
    }, 80);
  }
}

function toggleCollapsible(id) {
  var section = document.getElementById(id);
  if (!section) return;
  var body    = section.querySelector('.collapsible-body');
  var chevron = section.querySelector('.collapsible-chevron');
  if (!body) return;
  var open = body.style.display === 'none';
  body.style.display = open ? 'block' : 'none';
  if (chevron) chevron.style.transform = open ? 'rotate(180deg)' : '';
  // Resize charts inside the section after expand so Chart.js paints at correct size
  if (open) {
    requestAnimationFrame(function () {
      ['tideChartDetail', 'tideChartOverview',
       'weatherTempChart', 'weatherHumChart', 'weatherPrecipChart', 'weatherUVChart'
      ].forEach(function (cid) {
        var c = typeof Chart !== 'undefined' && Chart.getChart ? Chart.getChart(cid) : null;
        if (c) c.resize();
      });
    });
  }
}

function findLastEntryWith(entries, key) {
  for (var i = entries.length - 1; i >= 0; i--) {
    if (entries[i][key] !== null && entries[i][key] !== undefined) return entries[i];
  }
  return null;
}

function findLastEntryWhere(entries, predicate) {
  for (var i = entries.length - 1; i >= 0; i--) {
    if (predicate(entries[i])) return entries[i];
  }
  return null;
}

// =====================================================================
// SYNC HELPERS -- delegate to seaweed_sync.js (loaded above)
// countRecentMissing wraps evaluateSyncWindows for backward compat
// =====================================================================
function countRecentMissing(entries, key, hoursBack, sampleIdKey, defaultPeriodHours, satInstallKey) {
  if (!entries || !entries.length) return { total: 0, missing: 0, synced: 0 };
  var latestMs = entries[entries.length - 1].timestamp.getTime();
  var startMs  = latestMs - hoursBack * 3600000;
  var defaultPeriodMs = (defaultPeriodHours || 3) * 3600000;
  var result = evaluateSyncWindows(entries, sampleIdKey, key, startMs, latestMs, defaultPeriodMs, satInstallKey);
  return { total: result.total, missing: result.missed, synced: result.synced };
}

function latestInstalledFlag(entries, key) {
  if (!entries || !entries.length) return null;
  for (var i = entries.length - 1; i >= 0; i--) {
    if (entries[i][key] === true || entries[i][key] === false) return entries[i][key];
  }
  return null;
}

function hasSatelliteSignals(entries, slotNumber) {
  if (!entries || !entries.length) return false;
  var p = 'sat' + slotNumber;
  var keys = [p + 'BatV', p + 'BatPct', p + 'Temp1', p + 'Temp2', p + 'Hum1', p + 'Hum2', p + 'SampleId'];
  return entries.some(function(e) {
    for (var i = 0; i < keys.length; i++) {
      if (e[keys[i]] !== null && e[keys[i]] !== undefined) return true;
    }
    return false;
  });
}

function isSatelliteInstalled(entries, slotNumber) {
  var key = 'sat' + slotNumber + 'Installed';
  var explicit = latestInstalledFlag(entries, key);
  if (explicit === true || explicit === false) return explicit;
  return hasSatelliteSignals(entries, slotNumber);
}

// =====================================================================
// tides.js -- Tide prediction & moon phase engine
// Seaweed Station Dashboard
//
// Uses harmonic analysis with published tidal constituents for:
//   - Fremantle (Perth, WA)       -- predominantly diurnal
//       Source: Australian Bureau of Meteorology (BOM) / National Tidal Centre
//               Australian National Tide Tables (ANTT)
//               https://www.bom.gov.au/oceanography/tides/
//   - Mombasa (Kenya coast)       -- strongly semidiurnal
//       Source: IOC -- Intergovernmental Oceanographic Commission
//               Sea Level Station Monitoring Facility (SLSMF)
//               https://www.ioc-sealevelmonitoring.org/
//
// Moon phase from synodic month calculation.
// Harvest windows: +/-3 days around lowest spring low tide
//   (~1.5 days after each new & full moon).
//
// No API key required -- all predictions are pure math.
// =====================================================================
(function () {
"use strict";

var DEG = Math.PI / 180;
var SYNODIC_MONTH = 29.530588853;
// Known new moon reference: 2000-01-06 18:14 UTC
var NEW_MOON_REF = Date.UTC(2000, 0, 6, 18, 14, 0);
// J2000.0 epoch (2000-01-01 12:00 UTC)
var J2000 = Date.UTC(2000, 0, 1, 12, 0, 0);

// =================================================================
// Tidal constituent speeds (degrees per mean solar hour)
// =================================================================
var SPEEDS = {
  M2: 28.9841042,   // principal lunar semidiurnal
  S2: 30.0000000,   // principal solar semidiurnal
  N2: 28.4397295,   // larger lunar elliptic
  K1: 15.0410686,   // lunisolar diurnal
  O1: 13.9430356,   // principal lunar diurnal
  P1: 14.9589314,   // principal solar diurnal
  K2: 30.0821373,   // lunisolar semidiurnal
};

// Equilibrium arguments V0 at J2000.0 noon UTC (degrees)
// Computed from: s=218.3165, h=280.4661, p=83.3535, T0=0 at noon
var V0_J2000 = {
  M2: 124.30,  // 2T + 2h - 2s
  S2:   0.00,  // 2T
  N2: 349.34,  // 2T + 2h - 3s + p
  K1: 190.47,  // T + h - 90
  O1: 293.83,  // T + h - 2s + 90
  P1: 169.53,  // T - h + 90
  K2: 200.93,  // 2T + 2h
};

// Nodal factors for ~2025-2027 (N ~ 342 deg)
var NODAL_F = { M2: 0.965, S2: 1.0, N2: 0.965, K1: 1.115, O1: 1.187, P1: 1.0, K2: 1.23 };
var NODAL_U = { M2: 0.66, S2: 0, N2: 0.66, K1: 2.71, O1: -3.31, P1: 0, K2: 5.42 };

// =================================================================
// Location presets (published harmonic constants)
// =================================================================
var LOCATIONS = {
  perth: {
    name: 'Fremantle, WA',
    z0: 0.80,  // mean level above chart datum (m)
    // Harmonic constituents from: Australian Bureau of Meteorology (BOM)
    // National Tidal Centre -- Australian National Tide Tables (ANTT)
    // https://www.bom.gov.au/oceanography/tides/
    source: 'BOM / National Tidal Centre — Australian National Tide Tables',
    sourceUrl: 'https://www.bom.gov.au/oceanography/tides/',
    constituents: [
      { id: 'M2', amp: 0.158, phase: 211 },
      { id: 'S2', amp: 0.059, phase: 240 },
      { id: 'N2', amp: 0.033, phase: 199 },
      { id: 'K1', amp: 0.169, phase: 108 },
      { id: 'O1', amp: 0.102, phase:  91 },
      { id: 'P1', amp: 0.055, phase: 108 },
      { id: 'K2', amp: 0.016, phase: 240 },
    ],
  },
  kenya: {
    name: 'Mombasa, Kenya',
    z0: 2.00,
    // Harmonic constituents from: IOC — Intergovernmental Oceanographic Commission
    // Sea Level Station Monitoring Facility (SLSMF)
    // https://www.ioc-sealevelmonitoring.org/
    source: 'IOC — Intergovernmental Oceanographic Commission, Sea Level Monitoring Facility',
    sourceUrl: 'https://www.ioc-sealevelmonitoring.org/',
    constituents: [
      { id: 'M2', amp: 1.14, phase:  28 },
      { id: 'S2', amp: 0.58, phase:  59 },
      { id: 'N2', amp: 0.24, phase:   8 },
      { id: 'K1', amp: 0.23, phase: 206 },
      { id: 'O1', amp: 0.12, phase: 176 },
      { id: 'P1', amp: 0.08, phase: 206 },
      { id: 'K2', amp: 0.16, phase:  59 },
    ],
  },
};

// =================================================================
// MOON PHASE
// =================================================================
function moonPhase(date) {
  var d = (date.getTime() - NEW_MOON_REF) / 86400000;
  return (((d % SYNODIC_MONTH) + SYNODIC_MONTH) % SYNODIC_MONTH) / SYNODIC_MONTH;
}

function moonIllumination(phase) {
  return Math.round((1 - Math.cos(phase * 2 * Math.PI)) / 2 * 100);
}

function moonPhaseName(phase) {
  if (phase < 0.0625 || phase >= 0.9375) return 'New Moon';
  if (phase < 0.1875) return 'Waxing Crescent';
  if (phase < 0.3125) return 'First Quarter';
  if (phase < 0.4375) return 'Waxing Gibbous';
  if (phase < 0.5625) return 'Full Moon';
  if (phase < 0.6875) return 'Waning Gibbous';
  if (phase < 0.8125) return 'Last Quarter';
  return 'Waning Crescent';
}

function moonEmoji(phase) {
  if (phase < 0.0625 || phase >= 0.9375) return '\uD83C\uDF11'; // new
  if (phase < 0.1875) return '\uD83C\uDF12';
  if (phase < 0.3125) return '\uD83C\uDF13';
  if (phase < 0.4375) return '\uD83C\uDF14';
  if (phase < 0.5625) return '\uD83C\uDF15'; // full
  if (phase < 0.6875) return '\uD83C\uDF16';
  if (phase < 0.8125) return '\uD83C\uDF17';
  return '\uD83C\uDF18';
}

// Find next occurrence of a target phase (0 = new, 0.5 = full)
function nextMoonEvent(fromDate, target) {
  var cur = moonPhase(fromDate);
  var diff = target - cur;
  if (diff <= 0.005) diff += 1;
  return new Date(fromDate.getTime() + diff * SYNODIC_MONTH * 86400000);
}

// All new & full moons in a date range
function moonEvents(startDate, endDate) {
  var events = [];
  var probe = new Date(startDate.getTime() - 35 * 86400000);
  var endMs = endDate.getTime();

  while (probe.getTime() < endMs + 35 * 86400000) {
    var nm = nextMoonEvent(probe, 0);
    var fm = nextMoonEvent(probe, 0.5);

    if (nm.getTime() >= startDate.getTime() && nm.getTime() <= endMs) {
      events.push({ date: nm, type: 'new', label: 'New Moon', emoji: '\uD83C\uDF11' });
    }
    if (fm.getTime() >= startDate.getTime() && fm.getTime() <= endMs) {
      events.push({ date: fm, type: 'full', label: 'Full Moon', emoji: '\uD83C\uDF15' });
    }
    probe = new Date(probe.getTime() + 14 * 86400000);
  }

  // Deduplicate within 2 days
  events.sort(function (a, b) { return a.date - b.date; });
  var out = [];
  for (var i = 0; i < events.length; i++) {
    var dominated = false;
    for (var j = 0; j < out.length; j++) {
      if (Math.abs(events[i].date - out[j].date) < 48 * 3600000 && events[i].type === out[j].type) {
        dominated = true; break;
      }
    }
    if (!dominated) out.push(events[i]);
  }
  return out;
}

// =================================================================
// TIDE PREDICTION (harmonic)
// =================================================================
function tideHeight(date, locationKey) {
  var loc = LOCATIONS[locationKey];
  if (!loc) return 0;
  var hrs = (date.getTime() - J2000) / 3600000;
  var h = loc.z0;
  for (var i = 0; i < loc.constituents.length; i++) {
    var c = loc.constituents[i];
    var arg = SPEEDS[c.id] * hrs + V0_J2000[c.id] + (NODAL_U[c.id] || 0) - c.phase;
    h += (NODAL_F[c.id] || 1) * c.amp * Math.cos(arg * DEG);
  }
  return h;
}

function tideCurve(startDate, endDate, locationKey, intervalMin) {
  intervalMin = intervalMin || 15;
  var pts = [], t = startDate.getTime(), end = endDate.getTime();
  while (t <= end) {
    var d = new Date(t);
    pts.push({ x: t, y: tideHeight(d, locationKey), date: d });
    t += intervalMin * 60000;
  }
  return pts;
}

function tideExtremes(curve) {
  var ex = [];
  for (var i = 1; i < curve.length - 1; i++) {
    var p = curve[i - 1].y, c = curve[i].y, n = curve[i + 1].y;
    if (c > p && c > n) ex.push({ date: curve[i].date, height: c, type: 'high', t: curve[i].x });
    else if (c < p && c < n) ex.push({ date: curve[i].date, height: c, type: 'low', t: curve[i].x });
  }
  return ex;
}

// =================================================================
// HARVEST WINDOWS
// =================================================================
function harvestWindows(startDate, endDate) {
  var events = moonEvents(
    new Date(startDate.getTime() - 8 * 86400000),
    new Date(endDate.getTime() + 8 * 86400000)
  );
  var wins = [];
  for (var i = 0; i < events.length; i++) {
    // Spring low tide ~ 1.5 days after new/full moon
    var springLow = new Date(events[i].date.getTime() + 1.5 * 86400000);
    var ws = new Date(springLow.getTime() - 3 * 86400000);
    var we = new Date(springLow.getTime() + 3 * 86400000);
    if (we.getTime() < startDate.getTime() || ws.getTime() > endDate.getTime()) continue;
    wins.push({
      moonEvent: events[i],
      springLow: springLow,
      start: ws,
      end: we,
    });
  }
  return wins;
}

function isInHarvestWindow(dateMs, windows) {
  for (var i = 0; i < windows.length; i++) {
    if (dateMs >= windows[i].start.getTime() && dateMs <= windows[i].end.getTime()) return windows[i];
  }
  return null;
}

// =================================================================
// DATE HELPERS
// =================================================================
function fmtDate(d) {
  return d.toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short' });
}
function fmtDateTime(d) {
  return d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short' }) + ' ' +
    d.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });
}

// =================================================================
// HARVEST DAY RANGES (per-day eligibility for chart shading)
// Returns [{start: Date, end: Date}, ...] for each calendar day in
// [startDate..endDate] whose lowest low tide is <= the threshold.
// Moon-phase windows are NOT required — threshold alone defines it.
// =================================================================
function harvestDayRanges(startDate, endDate, locationKey) {
  var _hOpts = window._harvestOpts || { enabled: true, maxHeight: 0.50 };
  if (!_hOpts.enabled) return [];
  var ranges = [];
  var d = new Date(startDate.getFullYear(), startDate.getMonth(), startDate.getDate());
  var endMs = endDate.getTime();
  while (d.getTime() <= endMs) {
    var dayStart = new Date(d.getFullYear(), d.getMonth(), d.getDate(), 0, 0, 0);
    var dayEnd   = new Date(d.getFullYear(), d.getMonth(), d.getDate(), 23, 59, 0);
    var curve = tideCurve(dayStart, dayEnd, locationKey, 30);
    var extr  = tideExtremes(curve);
    var lows  = extr.filter(function (ex) { return ex.type === 'low'; });
    if (lows.length) {
      var minH = lows.reduce(function (m, l) { return l.height < m ? l.height : m; }, Infinity);
      if (minH <= _hOpts.maxHeight) {
        ranges.push({ start: dayStart, end: dayEnd });
      }
    }
    d = new Date(d.getTime() + 86400000);
  }
  return ranges;
}

// =================================================================
// RENDER: Moon info panel
// =================================================================
function renderMoonInfo(now, events) {
  var phase = moonPhase(now);
  var nextNew = nextMoonEvent(now, 0);
  var nextFull = nextMoonEvent(now, 0.5);

  var el = document.getElementById('moonInfo');
  if (el) {
    el.innerHTML =
      '<span style="font-size:2.4rem;line-height:1">' + moonEmoji(phase) + '</span>' +
      '<div style="display:flex;flex-direction:column;gap:2px">' +
        '<span style="font-weight:700;font-size:1rem">' + moonPhaseName(phase) + '</span>' +
        '<span style="font-size:0.78rem;color:var(--text-muted)">' + moonIllumination(phase) + '% illuminated</span>' +
      '</div>';
  }

  var det = document.getElementById('moonDetails');
  if (det) {
    det.innerHTML =
      '<div class="moon-next"><span class="mn-label">Next New Moon</span><span class="mn-date">\uD83C\uDF11 ' + fmtDate(nextNew) + '</span></div>' +
      '<div class="moon-next"><span class="mn-label">Next Full Moon</span><span class="mn-date">\uD83C\uDF15 ' + fmtDate(nextFull) + '</span></div>';
  }
}

// =================================================================
// RENDER: Harvest info banner
// =================================================================
function renderHarvestInfo(wins, now) {
  var el = document.getElementById('harvestInfo');
  if (!el) return;

  var current = isInHarvestWindow(now.getTime(), wins);
  if (current) {
    var daysLeft = Math.ceil((current.end.getTime() - now.getTime()) / 86400000);
    el.className = 'harvest-info harvest-active';
    el.innerHTML =
      '<span class="harvest-icon">\uD83C\uDF3F</span>' +
      '<div><strong>Harvest window ACTIVE</strong> (' + current.moonEvent.label + ' spring tide)' +
      '<br><span style="font-size:0.78rem;color:var(--text-sec)">' + daysLeft + ' day(s) remaining -- ends ' + fmtDate(current.end) + '</span></div>';
    return;
  }

  // Find next window
  var next = null;
  for (var i = 0; i < wins.length; i++) {
    if (wins[i].start.getTime() > now.getTime()) { next = wins[i]; break; }
  }
  if (next) {
    var daysUntil = Math.ceil((next.start.getTime() - now.getTime()) / 86400000);
    el.className = 'harvest-info harvest-upcoming';
    el.innerHTML =
      '<span class="harvest-icon">\u23F3</span>' +
      '<div><strong>Next harvest window in ' + daysUntil + ' day(s)</strong>' +
      '<br><span style="font-size:0.78rem;color:var(--text-sec)">' + fmtDate(next.start) + ' - ' + fmtDate(next.end) +
      ' (' + next.moonEvent.label + ' spring tide)</span></div>';
  } else {
    el.className = 'harvest-info';
    el.innerHTML = '<span style="color:var(--text-muted)">No upcoming harvest windows in range</span>';
  }
}

// =================================================================
// RENDER: 7-day tide chart (detailed)
// =================================================================
function renderDetailChart(canvasId, curve, extremes, windows, locationKey, now) {
  var el = document.getElementById(canvasId);
  if (!el) return;

  var tideData = curve.map(function (p) { return { x: p.x, y: Math.round(p.y * 100) / 100 }; });
  var nowH = tideHeight(now, locationKey);

  // High / low scatter points
  var highs = extremes.filter(function (e) { return e.type === 'high'; })
    .map(function (e) { return { x: e.t, y: Math.round(e.height * 100) / 100 }; });
  var lows = extremes.filter(function (e) { return e.type === 'low'; })
    .map(function (e) { return { x: e.t, y: Math.round(e.height * 100) / 100 }; });

  new Chart(el, {
    type: 'line',
    data: {
      datasets: [
        {
          label: 'Tide Height',
          data: tideData,
          borderColor: '#3b82f6',
          backgroundColor: '#3b82f618',
          borderWidth: 1.5,
          pointRadius: 0,
          tension: 0.4,
          fill: true,
        },
        {
          label: 'High Tide',
          data: highs,
          borderColor: '#ef444400',
          backgroundColor: '#f59e0b',
          pointRadius: 4,
          pointStyle: 'triangle',
          showLine: false,
        },
        {
          label: 'Low Tide',
          data: lows,
          borderColor: '#22c55e00',
          backgroundColor: '#22c55e',
          pointRadius: 4,
          pointStyle: 'rectRot',
          showLine: false,
        },
        {
          label: 'Now',
          data: [{ x: now.getTime(), y: Math.round(nowH * 100) / 100 }],
          backgroundColor: '#ef4444',
          borderColor: '#ef4444',
          pointRadius: 7,
          pointStyle: 'crossRot',
          showLine: false,
        },
      ],
    },
    plugins: [{
      id: 'harvestBands',
      beforeDraw: function (chart) {
        var ctx = chart.ctx, xA = chart.scales.x, yA = chart.scales.y;
        var _hO = window._harvestOpts || { enabled: true, maxHeight: 0.50 };
        // Green band top = threshold pixel (or chart top if threshold is above visible range)
        var bandTop = _hO.enabled ? Math.max(yA.top, Math.min(yA.getPixelForValue(_hO.maxHeight), yA.bottom)) : yA.top;
        for (var i = 0; i < windows.length; i++) {
          var x1 = xA.getPixelForValue(windows[i].start.getTime());
          var x2 = xA.getPixelForValue(windows[i].end.getTime());
          if (x2 < xA.left || x1 > xA.right) continue;
          x1 = Math.max(x1, xA.left); x2 = Math.min(x2, xA.right);
          ctx.save();
          ctx.fillStyle = 'rgba(34, 197, 94, 0.08)';
          ctx.fillRect(x1, bandTop, x2 - x1, yA.bottom - bandTop);
          ctx.strokeStyle = 'rgba(34, 197, 94, 0.3)';
          ctx.setLineDash([4, 4]);
          ctx.strokeRect(x1, bandTop, x2 - x1, yA.bottom - bandTop);
          ctx.restore();
        }
        // Now line
        var nx = xA.getPixelForValue(now.getTime());
        if (nx >= xA.left && nx <= xA.right) {
          ctx.save();
          ctx.strokeStyle = '#ef444488';
          ctx.lineWidth = 1.5;
          ctx.setLineDash([3, 3]);
          ctx.beginPath(); ctx.moveTo(nx, yA.top); ctx.lineTo(nx, yA.bottom); ctx.stroke();
          ctx.restore();
        }
        // Harvest threshold line
        var _hOpts = window._harvestOpts || { enabled: true, maxHeight: 0.50 };
        if (_hOpts.enabled) {
          var ty = yA.getPixelForValue(_hOpts.maxHeight);
          if (ty >= yA.top && ty <= yA.bottom) {
            ctx.save();
            ctx.strokeStyle = '#22c55e99';
            ctx.lineWidth = 1;
            ctx.setLineDash([6, 3]);
            ctx.beginPath(); ctx.moveTo(xA.left, ty); ctx.lineTo(xA.right, ty); ctx.stroke();
            ctx.fillStyle = '#22c55ecc';
            ctx.font = '9px sans-serif';
            ctx.textAlign = 'left';
            ctx.fillText('\u2264 ' + _hOpts.maxHeight.toFixed(2) + 'm harvest', xA.left + 4, ty - 3);
            ctx.restore();
          }
        }
      }
    }],
    options: {
      responsive: true, maintainAspectRatio: false,
      interaction: { mode: 'index', intersect: false },
      plugins: {
        legend: {
          position: 'top',
          labels: { color: '#94a3b8', usePointStyle: true, padding: 12, font: { size: 10 } },
        },
        tooltip: {
          backgroundColor: '#1e293bee', titleColor: '#f1f5f9', bodyColor: '#cbd5e1',
          borderColor: '#334155', borderWidth: 1, padding: 10,
          callbacks: {
            title: function (items) {
              if (!items.length) return '';
              return new Date(items[0].parsed.x).toLocaleString('en-GB', {
                weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit'
              });
            },
            label: function (ctx) {
              if (ctx.dataset.label === 'Now') return ' Now: ' + ctx.parsed.y.toFixed(2) + ' m';
              return ' ' + ctx.dataset.label + ': ' + ctx.parsed.y.toFixed(2) + ' m';
            },
          },
        },
      },
      scales: {
        x: {
          type: 'time', grid: { color: '#1e293b', lineWidth: 0.5 },
          ticks: { color: '#64748b', font: { size: 10 }, maxTicksLimit: 14 },
          time: { unit: 'hour', displayFormats: { hour: 'ccc HH:mm' }, stepSize: 6 },
        },
        y: {
          title: { display: true, text: 'Height (m)', color: '#94a3b8', font: { size: 11 } },
          grid: { color: '#1e293b', lineWidth: 0.5 },
          ticks: { color: '#64748b', font: { size: 10 } },
        },
      },
    },
  });
}

// =================================================================
// RENDER: 60-day overview chart
// =================================================================
function renderOverviewChart(canvasId, curve, extremes, windows, events, locationKey, now) {
  var el = document.getElementById(canvasId);
  if (!el) return;

  var tideData = curve.map(function (p) { return { x: p.x, y: Math.round(p.y * 100) / 100 }; });

  // Moon event annotations as scatter points
  var moonPts = events.map(function (e) {
    return { x: e.date.getTime(), y: tideHeight(e.date, locationKey), label: e.label };
  });

  new Chart(el, {
    type: 'line',
    data: {
      datasets: [
        {
          label: 'Tide Height',
          data: tideData,
          borderColor: '#3b82f6',
          backgroundColor: '#3b82f610',
          borderWidth: 1,
          pointRadius: 0,
          tension: 0.3,
          fill: true,
        },
        {
          label: 'Moon Events',
          data: moonPts.map(function (p) { return { x: p.x, y: Math.round(p.y * 100) / 100 }; }),
          backgroundColor: '#fbbf24',
          borderColor: '#fbbf24',
          pointRadius: 6,
          pointStyle: 'star',
          showLine: false,
        },
      ],
    },
    plugins: [{
      id: 'overviewBands',
      beforeDraw: function (chart) {
        var ctx = chart.ctx, xA = chart.scales.x, yA = chart.scales.y;
        var _hO = window._harvestOpts || { enabled: true, maxHeight: 0.50 };
        var bandTop = _hO.enabled ? Math.max(yA.top, Math.min(yA.getPixelForValue(_hO.maxHeight), yA.bottom)) : yA.top;
        // Merge consecutive days into contiguous groups for cleaner rendering
        var groups = [];
        for (var i = 0; i < windows.length; i++) {
          var ws = windows[i].start.getTime(), we = windows[i].end.getTime();
          if (groups.length && ws - groups[groups.length - 1].end <= 86400000 * 1.1) {
            groups[groups.length - 1].end = we; // extend group
          } else {
            groups.push({ start: ws, end: we });
          }
        }
        for (var g = 0; g < groups.length; g++) {
          var x1 = xA.getPixelForValue(groups[g].start);
          var x2 = xA.getPixelForValue(groups[g].end);
          if (x2 < xA.left || x1 > xA.right) continue;
          x1 = Math.max(x1, xA.left); x2 = Math.min(x2, xA.right);
          ctx.save();
          ctx.fillStyle = 'rgba(34, 197, 94, 0.10)';
          ctx.fillRect(x1, bandTop, x2 - x1, yA.bottom - bandTop);
          // Label once per group
          ctx.fillStyle = '#22c55ecc';
          ctx.font = '9px sans-serif';
          ctx.textAlign = 'center';
          ctx.fillText('Harvest', (x1 + x2) / 2, yA.top + 10);
          ctx.restore();
        }
        // Moon events
        for (var j = 0; j < events.length; j++) {
          var mx = xA.getPixelForValue(events[j].date.getTime());
          if (mx >= xA.left && mx <= xA.right) {
            ctx.save();
            ctx.strokeStyle = '#fbbf2466';
            ctx.lineWidth = 1;
            ctx.setLineDash([2, 4]);
            ctx.beginPath(); ctx.moveTo(mx, yA.top); ctx.lineTo(mx, yA.bottom); ctx.stroke();
            ctx.fillStyle = '#fbbf24';
            ctx.font = '10px sans-serif';
            ctx.textAlign = 'center';
            ctx.fillText(events[j].emoji + ' ' + events[j].label, mx, yA.bottom + 12);
            ctx.restore();
          }
        }
        // Now line
        var nx = xA.getPixelForValue(now.getTime());
        if (nx >= xA.left && nx <= xA.right) {
          ctx.save();
          ctx.strokeStyle = '#ef444488';
          ctx.lineWidth = 1.5;
          ctx.setLineDash([3, 3]);
          ctx.beginPath(); ctx.moveTo(nx, yA.top); ctx.lineTo(nx, yA.bottom); ctx.stroke();
          ctx.fillStyle = '#ef4444cc';
          ctx.font = 'bold 9px sans-serif';
          ctx.textAlign = 'center';
          ctx.fillText('TODAY', nx, yA.top - 4);
          ctx.restore();
        }
        // Harvest threshold line
        var _hOpts = window._harvestOpts || { enabled: true, maxHeight: 0.50 };
        if (_hOpts.enabled) {
          var ty = yA.getPixelForValue(_hOpts.maxHeight);
          if (ty >= yA.top && ty <= yA.bottom) {
            ctx.save();
            ctx.strokeStyle = '#22c55e99';
            ctx.lineWidth = 1;
            ctx.setLineDash([6, 3]);
            ctx.beginPath(); ctx.moveTo(xA.left, ty); ctx.lineTo(xA.right, ty); ctx.stroke();
            ctx.fillStyle = '#22c55ecc';
            ctx.font = '9px sans-serif';
            ctx.textAlign = 'left';
            ctx.fillText('\u2264 ' + _hOpts.maxHeight.toFixed(2) + 'm harvest', xA.left + 4, ty - 3);
            ctx.restore();
          }
        }
      }
    }],
    options: {
      responsive: true, maintainAspectRatio: false,
      interaction: { mode: 'nearest', intersect: false },
      plugins: {
        legend: { display: false },
        tooltip: {
          backgroundColor: '#1e293bee', titleColor: '#f1f5f9', bodyColor: '#cbd5e1',
          callbacks: {
            title: function (items) {
              if (!items.length) return '';
              return new Date(items[0].parsed.x).toLocaleDateString('en-GB', {
                weekday: 'short', day: 'numeric', month: 'short', year: 'numeric'
              });
            },
            label: function (ctx) {
              if (ctx.datasetIndex === 1) return ' ' + moonPts[ctx.dataIndex].label;
              return ' Tide: ' + ctx.parsed.y.toFixed(2) + ' m';
            },
          },
        },
      },
      scales: {
        x: {
          type: 'time', grid: { color: '#1e293b', lineWidth: 0.5 },
          ticks: { color: '#64748b', font: { size: 10 }, maxTicksLimit: 12 },
          time: { unit: 'week', displayFormats: { week: 'd MMM' } },
        },
        y: {
          title: { display: true, text: 'Height (m)', color: '#94a3b8', font: { size: 11 } },
          grid: { color: '#1e293b', lineWidth: 0.5 },
          ticks: { color: '#64748b', font: { size: 10 } },
        },
      },
      layout: { padding: { bottom: 18 } },
    },
  });
}

// =================================================================
// RENDER: Harvest calendar (2 months)
// =================================================================
function renderHarvestCalendar(windows, events, now, locationKey) {
  var el = document.getElementById('harvestCalendar');
  if (!el) return;

  var _hOpts = window._harvestOpts || { enabled: true, maxHeight: 0.50 };

  var months = [];
  // Current month + next month
  var m0 = new Date(now.getFullYear(), now.getMonth(), 1);
  months.push(m0);
  months.push(new Date(m0.getFullYear(), m0.getMonth() + 1, 1));
  months.push(new Date(m0.getFullYear(), m0.getMonth() + 2, 1));

  var html = '';
  for (var mi = 0; mi < months.length; mi++) {
    var mStart = months[mi];
    var mEnd = new Date(mStart.getFullYear(), mStart.getMonth() + 1, 0);
    var daysInMonth = mEnd.getDate();
    var firstDow = (mStart.getDay() + 6) % 7; // Mon=0

    html += '<div class="cal-month">';
    html += '<div class="cal-title">' + mStart.toLocaleDateString('en-GB', { month: 'long', year: 'numeric' }) + '</div>';
    html += '<div class="cal-grid">';
    // Day-of-week headers
    var dows = ['Mo', 'Tu', 'We', 'Th', 'Fr', 'Sa', 'Su'];
    for (var di = 0; di < 7; di++) html += '<div class="cal-dow">' + dows[di] + '</div>';

    // Empty cells before 1st
    for (var e = 0; e < firstDow; e++) html += '<div class="cal-day empty"></div>';

    for (var day = 1; day <= daysInMonth; day++) {
      var dayDate = new Date(mStart.getFullYear(), mStart.getMonth(), day, 12, 0, 0);
      var dayMs = dayDate.getTime();
      var inWin = isInHarvestWindow(dayMs, windows);

      // Check if the day's lowest tide is below harvest threshold
      var isHarvest = false;
      if (inWin && _hOpts.enabled && locationKey) {
        var dayStart = new Date(mStart.getFullYear(), mStart.getMonth(), day, 0, 0, 0);
        var dayEnd   = new Date(mStart.getFullYear(), mStart.getMonth(), day, 23, 59, 0);
        var dayCurve = tideCurve(dayStart, dayEnd, locationKey, 30);
        var dayEx    = tideExtremes(dayCurve);
        var dayLows  = dayEx.filter(function (ex) { return ex.type === 'low'; });
        if (dayLows.length) {
          var minH = dayLows.reduce(function (m, l) { return l.height < m ? l.height : m; }, Infinity);
          isHarvest = minH <= _hOpts.maxHeight;
        }
      } else if (inWin && !_hOpts.enabled) {
        isHarvest = false;
      }

      var isToday = (dayDate.toDateString() === now.toDateString());

      // Check for moon event on this day
      var moonEv = null;
      for (var ei = 0; ei < events.length; ei++) {
        if (events[ei].date.toDateString() === dayDate.toDateString()) {
          moonEv = events[ei]; break;
        }
      }

      var cls = 'cal-day';
      if (isHarvest) cls += ' harvest';
      if (isToday) cls += ' today';
      if (moonEv) cls += ' moon';

      var inner = String(day);
      if (moonEv) inner += '<span class="moon-icon">' + moonEv.emoji + '</span>';

      var title = dayDate.toLocaleDateString('en-GB', { weekday: 'long', day: 'numeric', month: 'long' });
      if (isHarvest) title += ' -- HARVEST WINDOW';
      if (moonEv) title += ' -- ' + moonEv.label;

      html += '<div class="' + cls + '" title="' + title + '">' + inner + '</div>';
    }
    html += '</div></div>';
  }
  el.innerHTML = html;
}

// =================================================================
// RENDER: Low tide table (upcoming days)
// =================================================================
function renderLowTideTable(extremes, windows, now) {
  var el = document.getElementById('lowTideTable');
  if (!el) return;

  // Use ALL low extremes passed in (caller controls the date range)
  var upcoming = extremes.filter(function (e) {
    return e.type === 'low' && e.t >= now.getTime();
  });

  if (!upcoming.length) {
    el.innerHTML = '<tr><td colspan="4" style="color:var(--text-muted);text-align:center;padding:12px">No data</td></tr>';
    return;
  }

  var _hOpts = window._harvestOpts || { enabled: true, maxHeight: 0.50 };

  // ── One row per day: keep only the lowest low for each calendar day ──
  var byDay = {};
  var dayOrder = [];
  for (var i = 0; i < upcoming.length; i++) {
    var low = upcoming[i];
    var dayKey = low.date.toLocaleDateString('en-CA'); // YYYY-MM-DD key
    if (!byDay[dayKey]) { byDay[dayKey] = low; dayOrder.push(dayKey); }
    else if (low.height < byDay[dayKey].height) byDay[dayKey] = low;
  }

  // ── Spring marker: lowest daily minimum within each moon-phase window ──
  var springKeys = {};
  for (var w = 0; w < windows.length; w++) {
    var win = windows[w];
    var winDays = dayOrder.filter(function (dk) {
      return byDay[dk].t >= win.start.getTime() && byDay[dk].t <= win.end.getTime();
    });
    if (!winDays.length) continue;
    var minDay = winDays.reduce(function (best, dk) {
      return byDay[dk].height < byDay[best].height ? dk : best;
    }, winDays[0]);
    springKeys[minDay] = true;
  }

  // ── Moon-day lookup: calendar day -> moon event (only show moon on exact day) ──
  var moonDayMap = {};
  for (var w = 0; w < windows.length; w++) {
    var me = windows[w].moonEvent;
    var moonKey = me.date.toLocaleDateString('en-CA');
    moonDayMap[moonKey] = me;
  }

  var html = '';
  for (var d = 0; d < dayOrder.length; d++) {
    var key = dayOrder[d];
    var row = byDay[key];
    var belowThreshold = _hOpts.enabled && row.height <= _hOpts.maxHeight;
    var inWindow = isInHarvestWindow(row.t, windows);
    var isSpring = springKeys[key] || false;
    var moonToday = moonDayMap[key] || null;

    var rowStyle = '';
    var harvestCell = '';
    var moonPrefix = moonToday ? (moonToday.type === 'full' ? '\uD83C\uDF15 ' : '\uD83C\uDF11 ') : '';

    if (belowThreshold) {
      if (isSpring && inWindow) {
        // Absolute lowest in a spring tide window
        rowStyle = ' style="color:#4ade80;font-weight:700"';
        harvestCell = moonPrefix + '\uD83C\uDF3F Spring Low \u25BC'; // 🌿 Spring Low ▼
      } else {
        rowStyle = ' style="color:#22c55e;font-weight:600"';
        harvestCell = moonPrefix + '\uD83C\uDF3F Harvest'; // 🌿 Harvest
      }
    } else if (moonToday) {
      // Not below threshold but show moon event for reference
      harvestCell = moonPrefix;
    }

    html += '<tr' + rowStyle + '>' +
      '<td>' + row.date.toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short' }) + '</td>' +
      '<td>' + row.date.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' }) + '</td>' +
      '<td>' + row.height.toFixed(2) + ' m</td>' +
      '<td>' + harvestCell + '</td>' +
    '</tr>';
  }
  el.innerHTML = html;
}

// =================================================================
// MAIN INIT
// =================================================================
function initTides(locationKey) {
  var loc = LOCATIONS[locationKey];
  if (!loc) { console.warn('[Tides] Unknown location:', locationKey); return; }

  var container = document.getElementById('tidesSection');
  if (!container) return;
  container.style.display = '';
  // Show collapsible wrapper if present (station pages use collapsible tides)
  var tidesCollapsible = document.getElementById('tidesCollapsible');
  if (tidesCollapsible) tidesCollapsible.style.display = '';

  var stationEl = document.getElementById('tideStation');
  if (stationEl) {
    stationEl.innerHTML = 'Reference station: ' + loc.name
      + ' &mdash; harmonic prediction'
      + (loc.sourceUrl
        ? ' &mdash; constituents: <a href="' + loc.sourceUrl + '" target="_blank" rel="noopener" style="color:#64748b;text-decoration:underline dotted">' + loc.source + '</a>'
        : (loc.source ? ' (' + loc.source + ')' : ''));
  }

  var now = new Date();
  var past1d = new Date(now.getTime() - 1 * 86400000);
  var future7d = new Date(now.getTime() + 6 * 86400000);
  var future60d = new Date(now.getTime() + 60 * 86400000);

  // Moon info
  var events = moonEvents(new Date(now.getFullYear(), now.getMonth(), 1), future60d);
  renderMoonInfo(now, events);

  // Harvest windows
  var wins = harvestWindows(past1d, future60d);
  var _hOpts = window._harvestOpts || { enabled: true, maxHeight: 0.50 };
  var activeWins = _hOpts.enabled ? wins : [];
  window._tideLocationKey = locationKey;
  window._tideActiveWins  = activeWins;
  renderHarvestInfo(activeWins, now);

  // 7-day detailed tide chart
  var curveWeek = tideCurve(past1d, future7d, locationKey, 10);
  var weekExtremes = tideExtremes(curveWeek);
  var weekDayRanges = harvestDayRanges(past1d, future7d, locationKey);
  renderDetailChart('tideChartDetail', curveWeek, weekExtremes, weekDayRanges, locationKey, now);

  // 60-day overview
  var curveFull = tideCurve(past1d, future60d, locationKey, 60);
  var fullExtremes = tideExtremes(curveFull);
  var fullDayRanges = harvestDayRanges(past1d, future60d, locationKey);
  renderOverviewChart('tideChartOverview', curveFull, fullExtremes, fullDayRanges, events, locationKey, now);

  // Expose day-level ranges for sensor chart overlay (sensorBandsPlugin)
  window._tideWindows = fullDayRanges;

  // Harvest calendar
  renderHarvestCalendar(activeWins, events, now, locationKey);

  // Low tide table
  var tableDays = window._tideTableDays || 14;
  var tableCurve = tideCurve(now, new Date(now.getTime() + tableDays * 86400000), locationKey, 10);
  var tableExtremes = tideExtremes(tableCurve);
  renderLowTideTable(tableExtremes, activeWins, now);
  var ttsEl = document.getElementById('tideTableSubhead');
  if (ttsEl) ttsEl.textContent = 'Upcoming Low Tides (next ' + tableDays + ' days)';
}

// Export
window.SeaweedTides = {
  init: initTides,
  moonPhase: moonPhase,
  tideHeight: tideHeight,
  harvestWindows: harvestWindows,
  LOCATIONS: LOCATIONS,
  loadMoreTides: function () {
    var locKey = window._tideLocationKey;
    if (!locKey) return;
    window._tideTableDays = (window._tideTableDays || 14) + 14;
    var days  = window._tideTableDays;
    var now   = new Date();
    var endDate = new Date(now.getTime() + days * 86400000);
    // Regenerate harvest windows to cover the extended range
    var _hOpts = window._harvestOpts || { enabled: true, maxHeight: 0.50 };
    var wins = _hOpts.enabled ? harvestWindows(now, endDate) : [];
    var curve = tideCurve(now, endDate, locKey, 10);
    renderLowTideTable(tideExtremes(curve), wins, now);
    var el = document.getElementById('tideTableSubhead');
    if (el) el.textContent = 'Upcoming Low Tides (next ' + days + ' days)';
  },
};

})();

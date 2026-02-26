// ============================================================================
// battery_forecast_widget.js — Battery Prediction Panel for Live Dashboards
// ============================================================================
// Depends on: battery_model.js, Chart.js (already loaded by parent pages)
//
// Usage:  BatteryForecast.init(state)   — call from renderDashboard()
//         BatteryForecast.update(state) — call from createOrUpdateCharts()
//
// Version: 1.0  (2026-02-24)
// ============================================================================
"use strict";

window.BatteryForecast = (function () {

  var chart = null;
  var anchorMode = 'auto';   // 'auto' | 'locked'
  var lockedAnchorIdx = -1;  // index into allEntries when locked
  // Previous-Calculated tracking: keep prior projection visible when auto anchor drifts
  var _lastKnownAnchorT = { t0: -1, satA: -1, satB: -1 };
  var _prevCalcAnchorT  = { t0: -1, satA: -1, satB: -1 };
  var showT0  = true;   // Always true — chart legend handles show/hide
  var showSatA = true;
  var showSatB = true;
  var fcTimeRange = 'week'; // 'day' | 'week' | 'month' | 'all' | 'custom'
  var fcStartDate = null;  // Date — set on first init from latest data; driven by the date picker
  var _activeState = null;  // Current state passed to init/update — used by closures

  // Persistent forecast state (survives renderDashboard calls)
  var lastConfig     = null;  // latest parsed device config
  var configChanges  = [];    // [{timestamp, oldCfg, newCfg}]

  // Colors matching the parent dashboard
  var C = {
    t0Actual:    '#3b82f6',
    t0Predict:   '#3b82f6',
    t0Trend:     '#93c5fd',  // lighter blue for trend
    satAActual:  '#10b981',
    satAPredict: '#10b981',
    satATrend:   '#6ee7b7',  // lighter green
    satBActual:  '#f59e0b',
    satBPredict: '#f59e0b',
    satBTrend:   '#fcd34d',  // lighter amber
    configLine:  '#ef4444',
  };

  // ========================================================================
  // FORECAST TIME RANGE HELPERS
  // ========================================================================
  function applyFcRange() {
    if (!chart || fcTimeRange === 'custom') return;
    var start = fcStartDate ? fcStartDate.getTime() : undefined;
    var end;
    if (fcTimeRange === 'day') {
      end = start + 1 * 24 * 3600 * 1000;
    } else if (fcTimeRange === 'week') {
      end = start + 7 * 24 * 3600 * 1000;
    } else if (fcTimeRange === 'month') {
      end = start + 30 * 24 * 3600 * 1000;
    } else { // 'all'
      end = undefined;
    }
    chart.options.scales.x.min = start;
    chart.options.scales.x.max = end;
    // Keep the date input in sync
    var inp = document.getElementById('fcStartDate');
    if (inp && fcStartDate) inp.value = fcStartDate.toISOString().slice(0, 10);
  }

  function setFcTimeRange(range) {
    fcTimeRange = range;
    applyFcRange();
    if (chart) chart.update('none');
    document.querySelectorAll('[data-fcrange]').forEach(function (b) {
      b.classList.toggle('active', b.dataset.fcrange === range);
    });
  }

  // ========================================================================
  // TREND ENGINE  (linear regression on actual discharge data)
  // ========================================================================
  // Window ladder: start small (48 h) and promote as data accumulates.
  var TREND_WINDOWS = [
    { ms:  2 * 86400000, label: '48 h', minPoints:  4 },
    { ms:  5 * 86400000, label: '5 d',  minPoints:  8 },
    { ms: 10 * 86400000, label: '10 d', minPoints: 12 },
    { ms: 14 * 86400000, label: '2 wk', minPoints: 16 },
    { ms: 28 * 86400000, label: '4 wk', minPoints: 24 },
    { ms: 42 * 86400000, label: '6 wk', minPoints: 32 },
    { ms: 56 * 86400000, label: '8 wk', minPoints: 40 },
  ];

  // Walk backwards from the newest point, stopping at charge events or gaps.
  function usableStreak(pts) {
    if (!pts || pts.length < 2) return [];
    var CHARGE_DELTA = 3;          // % rise that signals a recharge
    var GAP_MS       = 3 * 3600000; // 3 h gap breaks continuity
    var toMs = function (x) { return x instanceof Date ? x.getTime() : +x; };
    var streak = [pts[pts.length - 1]];
    for (var i = pts.length - 2; i >= 0; i--) {
      var tCur  = toMs(pts[i + 1].x);
      var tPrev = toMs(pts[i].x);
      if ((tCur - tPrev) > GAP_MS)                break; // gap
      if ((pts[i + 1].y - pts[i].y) > CHARGE_DELTA) break; // charge event
      streak.unshift(pts[i]);
    }
    return streak;
  }

  // Ordinary least-squares linear regression.
  // Returns { slope (pct/ms), intercept, r2, t0 (origin ms) } or null.
  function linReg(pts) {
    var n = pts.length;
    if (n < 2) return null;
    var toMs = function (x) { return x instanceof Date ? x.getTime() : +x; };
    var t0    = toMs(pts[0].x);
    var sumX = 0, sumY = 0, sumXY = 0, sumX2 = 0;
    pts.forEach(function (p) {
      var x = toMs(p.x) - t0;
      sumX += x; sumY += p.y; sumXY += x * p.y; sumX2 += x * x;
    });
    var denom = n * sumX2 - sumX * sumX;
    if (Math.abs(denom) < 1e-12) return null;
    var slope     = (n * sumXY - sumX * sumY) / denom;
    var intercept = (sumY - slope * sumX) / n;
    var yMean = sumY / n, ssTot = 0, ssRes = 0;
    pts.forEach(function (p) {
      var yHat = slope * (toMs(p.x) - t0) + intercept;
      ssTot += (p.y - yMean) * (p.y - yMean);
      ssRes += (p.y - yHat)  * (p.y - yHat);
    });
    var r2 = ssTot > 1e-9 ? Math.max(0, 1 - ssRes / ssTot) : 0;
    return { slope: slope, intercept: intercept, r2: r2, t0: t0 };
  }

  // Build a trend dataset from actual battery-% points.
  // Returns null if data is insufficient or trend is non-negative (not discharging).
  function buildTrendDataset(actualPts, deviceLabel, color) {
    var streak = usableStreak(actualPts);
    var toMs = function (x) { return x instanceof Date ? x.getTime() : +x; };

    if (streak.length < 2) {
      return { dataset: null, reason: 'No clean data' };
    }
    var streakSpanMs = toMs(streak[streak.length - 1].x) - toMs(streak[0].x);
    var streakHours  = Math.round(streakSpanMs / 3600000);

    // Pick the largest window that fits inside the streak with enough points.
    var usedWindow = null;
    for (var i = TREND_WINDOWS.length - 1; i >= 0; i--) {
      var w = TREND_WINDOWS[i];
      if (streakSpanMs < w.ms) continue;
      var winStart = toMs(streak[streak.length - 1].x) - w.ms;
      var trimmed  = streak.filter(function (p) { return toMs(p.x) >= winStart; });
      if (trimmed.length >= w.minPoints) { usedWindow = { w: w, pts: trimmed }; break; }
    }
    if (!usedWindow) {
      // Tell the user how far along they are toward the first window (48 h / 4 pts)
      var first = TREND_WINDOWS[0];
      var needMs   = first.ms;
      var pctTime  = Math.min(99, Math.round(streakSpanMs / needMs * 100));
      return { dataset: null, reason: 'Need 48 h clean (' + streakHours + 'h / ' + pctTime + '%)' };
    }

    var reg = linReg(usedWindow.pts);
    if (!reg || reg.slope >= 0) {
      return { dataset: null, reason: 'No discharge slope yet' };
    }

    // Project: back to start of regression window, forward until 0% (max 90 d).
    var latestT  = toMs(usedWindow.pts[usedWindow.pts.length - 1].x);
    var latestY  = usedWindow.pts[usedWindow.pts.length - 1].y;
    var projMs   = Math.min((latestY / (-reg.slope * 86400000)) * 86400000 * 1.05, 90 * 86400000);
    var startT   = toMs(usedWindow.pts[0].x);
    var endT     = latestT + projMs;
    var STEPS    = 80;
    var trendData = [];
    for (var s = 0; s <= STEPS; s++) {
      var t = startT + ((endT - startT) * s / STEPS);
      var y = reg.slope * (t - reg.t0) + reg.intercept;
      if (y <= 0) { trendData.push({ x: new Date(t), y: 0 }); break; }
      trendData.push({ x: new Date(t), y: parseFloat(y.toFixed(2)) });
    }

    return {
      dataset: {
        label: deviceLabel + ' Trending',
        data:  trendData,
        borderColor: color,
        backgroundColor: 'transparent',
        borderWidth: 2,
        borderDash: [3, 3],
        pointRadius: 0,
        tension: 0,
        fill: false,
      },
      windowLabel:       usedWindow.w.label,
      r2:                reg.r2,
      slope_pct_per_day: reg.slope * 86400000,
      pointCount:        usedWindow.pts.length,
      reason:            null,
    };
  }

  // ========================================================================
  // EXTRACT CONFIG FROM ENTRIES  (scan field8 for pipe-delimited config)
  // ========================================================================
  function extractLatestConfig(entries) {
    // field8 is stored as raw string in the original feed; but parseFeeds() already
    // split it by comma into sys[0..N].  The pipe character lands inside one of the
    // sys tokens (sys[3] often has "drift|dm" concatenated).
    //
    // To handle this gracefully, we re-scan the raw entries backwards looking for
    // the first field8 string that contains a pipe.
    //
    // However, our parsed entries only have numeric sys fields.  We need the RAW
    // field8 string.  We store it during parseFeeds as entry._rawField8.
    //
    // If _rawField8 is available, use it; otherwise fall back to defaults.
    var cfg = null;
    for (var i = entries.length - 1; i >= 0; i--) {
      if (entries[i]._rawField8) {
        cfg = BatteryModel.parseField8Config(entries[i]._rawField8);
        if (cfg) break;
      }
    }
    return cfg;
  }

  // Detect all config change points in the data
  function detectConfigChanges(entries) {
    var changes = [];
    var prevCfg = null;
    for (var i = 0; i < entries.length; i++) {
      if (!entries[i]._rawField8) continue;
      var cfg = BatteryModel.parseField8Config(entries[i]._rawField8);
      if (!cfg) continue;
      if (prevCfg && BatteryModel.configChanged(prevCfg, cfg)) {
        changes.push({
          timestamp: entries[i].timestamp,
          entryIdx:  i,
          oldCfg:    prevCfg,
          newCfg:    cfg,
        });
      }
      prevCfg = cfg;
    }
    return changes;
  }

  // ========================================================================
  // FIND ANCHOR POINT
  // ========================================================================
  function getAnchor(entries) {
    if (anchorMode === 'locked' && lockedAnchorIdx >= 0 && lockedAnchorIdx < entries.length) {
      return lockedAnchorIdx;
    }
    // Auto: use latest entry with valid T0 battery %
    for (var i = entries.length - 1; i >= 0; i--) {
      if (entries[i].t0BatPct !== null && entries[i].t0BatPct > 0) return i;
    }
    return -1;
  }

  function getSatAAnchor(entries) {
    if (anchorMode === 'locked' && lockedAnchorIdx >= 0 && lockedAnchorIdx < entries.length) {
      // Find nearest Sat-A reading at or before locked index
      for (var i = lockedAnchorIdx; i >= 0; i--) {
        if (entries[i].satABatPct !== null && entries[i].satABatPct > 0) return i;
      }
    }
    for (var i = entries.length - 1; i >= 0; i--) {
      if (entries[i].satABatPct !== null && entries[i].satABatPct > 0) return i;
    }
    return -1;
  }

  function getSatBAnchor(entries) {
    if (anchorMode === 'locked' && lockedAnchorIdx >= 0 && lockedAnchorIdx < entries.length) {
      for (var i = lockedAnchorIdx; i >= 0; i--) {
        if (entries[i].satBBatPct !== null && entries[i].satBBatPct > 0) return i;
      }
    }
    for (var i = entries.length - 1; i >= 0; i--) {
      if (entries[i].satBBatPct !== null && entries[i].satBBatPct > 0) return i;
    }
    return -1;
  }

  // ========================================================================
  // COMPUTE MAE (Mean Absolute Error) between predicted and actual
  // ========================================================================
  function computeMAE(entries, anchorIdx, projectedPoints, batPctKey) {
    if (!projectedPoints || projectedPoints.length < 2 || anchorIdx < 0) return null;

    var anchorTime = entries[anchorIdx].timestamp.getTime();
    var errors = [];

    for (var i = anchorIdx + 1; i < entries.length; i++) {
      var actual = entries[i][batPctKey];
      if (actual === null || actual <= 0) continue;

      var entryTime = entries[i].timestamp.getTime();
      var elapsedDays = (entryTime - anchorTime) / 86400000;

      // Interpolate predicted value at this time
      var predicted = null;
      for (var p = 0; p < projectedPoints.length - 1; p++) {
        var pTime0 = projectedPoints[p].time.getTime();
        var pTime1 = projectedPoints[p + 1].time.getTime();
        if (entryTime >= pTime0 && entryTime <= pTime1) {
          var frac = (entryTime - pTime0) / (pTime1 - pTime0);
          predicted = projectedPoints[p].pct + frac * (projectedPoints[p + 1].pct - projectedPoints[p].pct);
          break;
        }
      }
      if (predicted !== null) {
        errors.push(Math.abs(actual - predicted));
      }
    }

    if (errors.length === 0) return null;
    var sum = 0;
    for (var e = 0; e < errors.length; e++) sum += errors[e];
    return { mae: sum / errors.length, samples: errors.length };
  }

  // ========================================================================
  // BUILD DATASETS
  // ========================================================================
  function buildDatasets(state) {
    var entries = state.allEntries;
    if (!entries || !entries.length) return { datasets: [], info: {} };

    var cfg = extractLatestConfig(entries);
    var changes = detectConfigChanges(entries);
    lastConfig = cfg;
    configChanges = changes;

    // Use device config if available, otherwise sensible defaults
    var t0Cfg = cfg || {
      deployMode: 1, sleepEnable: true, samplePeriod_s: 600,
      tsBulkInterval_s: 900, tsBulkFreqHours: 24,
      espnowSyncPeriod_s: 3600, satAInstalled: true, satBInstalled: false,
    };

    var t0Result  = BatteryModel.calcT0Daily(t0Cfg);
    var teResult  = BatteryModel.calcTEDaily({
      samplePeriod_s:      t0Cfg.samplePeriod_s,
      espnowSyncPeriod_s:  t0Cfg.espnowSyncPeriod_s,
      sleepEnable:         true,
    });

    var datasets = [];
    var info = {
      t0DaysLeft: null, satADaysLeft: null, satBDaysLeft: null,
      t0Mae: null, satAMae: null, satBMae: null,
      configAvailable: !!cfg,
      configSummary: BatteryModel.configSummary(cfg),
      configChanges: changes,
      _trendConfidence:   [],   // { label, windowLabel, r2, color }
      _trendInsufficient: [],   // { label, reason, color }
    };

    // --- T0 ---
    if (showT0) {
      // Actual
      var t0Actual = [];
      entries.forEach(function (e) {
        if (e.t0BatPct !== null && e.t0BatPct > 0) t0Actual.push({ x: e.timestamp, y: e.t0BatPct });
      });
      datasets.push({
        label: 'T0 Actual (' + t0Actual.length + ')',
        data: t0Actual,
        borderColor: C.t0Actual,
        backgroundColor: C.t0Actual + '22',
        borderWidth: 2,
        pointRadius: 0,
        pointHoverRadius: 4,
        tension: 0.3,
        fill: false,
        hidden: t0Actual.length === 0,
      });

      // Predicted
      var t0AnchorIdx = getAnchor(entries);
      if (t0AnchorIdx >= 0) {
        var t0AnchorEntry = entries[t0AnchorIdx];
        var t0Proj = BatteryModel.projectCurve(
          t0AnchorEntry.t0BatPct,
          t0AnchorEntry.timestamp,
          t0Result.dailyTotal_mAh,
          t0Result.batteryCapacity,
          t0Result.derating
        );
        var t0PredictData = t0Proj.map(function (p) { return { x: p.time, y: p.pct }; });
        datasets.push({
          label: 'T0 Calculated',
          data: t0PredictData,
          borderColor: C.t0Predict,
          backgroundColor: 'transparent',
          borderWidth: 1.5,
          borderDash: [6, 4],
          pointRadius: 0,
          tension: 0.3,
          fill: false,
        });
        // Days remaining from latest actual
        var latestT0Idx = getAnchor(entries); // in auto mode this is latest
        if (latestT0Idx >= 0) {
          var latestT0 = entries[latestT0Idx];
          var remainMah = (latestT0.t0BatPct / 100.0) * t0Result.usable_mAh;
          info.t0DaysLeft = t0Result.dailyTotal_mAh > 0 ? remainMah / t0Result.dailyTotal_mAh : null;
        }
        // MAE
        info.t0Mae = computeMAE(entries, t0AnchorIdx, t0Proj, 't0BatPct');
      }
      // Previous Calculated — shown when auto anchor has advanced
      if (anchorMode === 'auto' && t0AnchorIdx >= 0) {
        var _curT0T = entries[t0AnchorIdx].timestamp.getTime();
        if (_lastKnownAnchorT.t0 < 0) {
          _lastKnownAnchorT.t0 = _curT0T;
        } else if (_curT0T !== _lastKnownAnchorT.t0) {
          _prevCalcAnchorT.t0 = _lastKnownAnchorT.t0;
          _lastKnownAnchorT.t0 = _curT0T;
        }
        if (_prevCalcAnchorT.t0 > 0) {
          var _pt0i = -1, _pt0d = Infinity;
          for (var pi = 0; pi < entries.length; pi++) {
            var _di = Math.abs(entries[pi].timestamp.getTime() - _prevCalcAnchorT.t0);
            if (_di < _pt0d && entries[pi].t0BatPct > 0) { _pt0d = _di; _pt0i = pi; }
          }
          if (_pt0i >= 0) {
            var _pt0Proj = BatteryModel.projectCurve(
              entries[_pt0i].t0BatPct, entries[_pt0i].timestamp,
              t0Result.dailyTotal_mAh, t0Result.batteryCapacity, t0Result.derating
            );
            datasets.push({
              label: 'T0 Calc. (prior)',
              data:  _pt0Proj.map(function (p) { return { x: p.time, y: p.pct }; }),
              borderColor: C.t0Predict + '44',
              backgroundColor: 'transparent',
              borderWidth: 1,
              borderDash: [2, 6],
              pointRadius: 0,
              tension: 0.3,
              fill: false,
            });
          }
        }
      }
      // Trending
      var t0Trend = buildTrendDataset(t0Actual, 'T0', C.t0Trend);
      if (t0Trend.dataset) {
        datasets.push(t0Trend.dataset);
        info._trendConfidence.push({ label: 'T0', windowLabel: t0Trend.windowLabel, r2: t0Trend.r2, color: C.t0Trend });
      } else {
        if (t0Actual.length > 0) info._trendInsufficient.push({ label: 'T0', reason: t0Trend.reason, color: C.t0Trend });
      }
    }

    // --- Sat-A ---
    if (showSatA) {
      var satAActual = [];
      entries.forEach(function (e) {
        if (e.satABatPct !== null && e.satABatPct > 0) satAActual.push({ x: e.timestamp, y: e.satABatPct });
      });
      datasets.push({
        label: 'Sat-A Actual (' + satAActual.length + ')',
        data: satAActual,
        borderColor: C.satAActual,
        backgroundColor: C.satAActual + '22',
        borderWidth: 2,
        pointRadius: 0,
        pointHoverRadius: 4,
        tension: 0.3,
        fill: false,
        hidden: satAActual.length === 0,
      });

      var satAAnchorIdx = getSatAAnchor(entries);
      if (satAAnchorIdx >= 0) {
        var satAEntry = entries[satAAnchorIdx];
        var teProj = BatteryModel.projectCurve(
          satAEntry.satABatPct,
          satAEntry.timestamp,
          teResult.dailyTotal_mAh,
          teResult.batteryCapacity,
          teResult.derating
        );
        var satAPredData = teProj.map(function (p) { return { x: p.time, y: p.pct }; });
        datasets.push({
          label: 'Sat-A Calculated',
          data: satAPredData,
          borderColor: C.satAPredict,
          backgroundColor: 'transparent',
          borderWidth: 1.5,
          borderDash: [6, 4],
          pointRadius: 0,
          tension: 0.3,
          fill: false,
          hidden: satAActual.length === 0,
        });
        // Days remaining
        var latestSatA = getSatAAnchor(entries);
        if (latestSatA >= 0) {
          var saEntry = entries[latestSatA];
          var saRemain = (saEntry.satABatPct / 100.0) * teResult.usable_mAh;
          info.satADaysLeft = teResult.dailyTotal_mAh > 0 ? saRemain / teResult.dailyTotal_mAh : null;
        }
        info.satAMae = computeMAE(entries, satAAnchorIdx, teProj, 'satABatPct');
      }
      // Previous Calculated
      if (anchorMode === 'auto' && satAAnchorIdx >= 0) {
        var _curSaT = entries[satAAnchorIdx].timestamp.getTime();
        if (_lastKnownAnchorT.satA < 0) {
          _lastKnownAnchorT.satA = _curSaT;
        } else if (_curSaT !== _lastKnownAnchorT.satA) {
          _prevCalcAnchorT.satA = _lastKnownAnchorT.satA;
          _lastKnownAnchorT.satA = _curSaT;
        }
        if (_prevCalcAnchorT.satA > 0) {
          var _psai = -1, _psad = Infinity;
          for (var psi = 0; psi < entries.length; psi++) {
            var _dsa = Math.abs(entries[psi].timestamp.getTime() - _prevCalcAnchorT.satA);
            if (_dsa < _psad && entries[psi].satABatPct > 0) { _psad = _dsa; _psai = psi; }
          }
          if (_psai >= 0) {
            var _psaProj = BatteryModel.projectCurve(
              entries[_psai].satABatPct, entries[_psai].timestamp,
              teResult.dailyTotal_mAh, teResult.batteryCapacity, teResult.derating
            );
            datasets.push({
              label: 'Sat-A Calc. (prior)',
              data:  _psaProj.map(function (p) { return { x: p.time, y: p.pct }; }),
              borderColor: C.satAPredict + '44',
              backgroundColor: 'transparent',
              borderWidth: 1,
              borderDash: [2, 6],
              pointRadius: 0,
              tension: 0.3,
              fill: false,
            });
          }
        }
      }
      // Trending
      var satATrend = buildTrendDataset(satAActual, 'Sat-A', C.satATrend);
      if (satATrend.dataset) {
        datasets.push(satATrend.dataset);
        info._trendConfidence.push({ label: 'Sat-A', windowLabel: satATrend.windowLabel, r2: satATrend.r2, color: C.satATrend });
      } else {
        if (satAActual.length > 0) info._trendInsufficient.push({ label: 'Sat-A', reason: satATrend.reason, color: C.satATrend });
      }
    }

    // --- Sat-B ---
    if (showSatB) {
      var satBActual = [];
      entries.forEach(function (e) {
        if (e.satBBatPct !== null && e.satBBatPct > 0) satBActual.push({ x: e.timestamp, y: e.satBBatPct });
      });
      datasets.push({
        label: 'Sat-B Actual (' + satBActual.length + ')',
        data: satBActual,
        borderColor: C.satBActual,
        backgroundColor: C.satBActual + '22',
        borderWidth: 2,
        pointRadius: 0,
        pointHoverRadius: 4,
        tension: 0.3,
        fill: false,
        hidden: satBActual.length === 0,
      });

      var satBAnchorIdx = getSatBAnchor(entries);
      if (satBAnchorIdx >= 0) {
        var satBEntry = entries[satBAnchorIdx];
        var teProjB = BatteryModel.projectCurve(
          satBEntry.satBBatPct,
          satBEntry.timestamp,
          teResult.dailyTotal_mAh,
          teResult.batteryCapacity,
          teResult.derating
        );
        var satBPredData = teProjB.map(function (p) { return { x: p.time, y: p.pct }; });
        datasets.push({
          label: 'Sat-B Calculated',
          data: satBPredData,
          borderColor: C.satBPredict,
          backgroundColor: 'transparent',
          borderWidth: 1.5,
          borderDash: [6, 4],
          pointRadius: 0,
          tension: 0.3,
          fill: false,
          hidden: satBActual.length === 0,
        });
        var latestSatB = getSatBAnchor(entries);
        if (latestSatB >= 0) {
          var sbEntry = entries[latestSatB];
          var sbRemain = (sbEntry.satBBatPct / 100.0) * teResult.usable_mAh;
          info.satBDaysLeft = teResult.dailyTotal_mAh > 0 ? sbRemain / teResult.dailyTotal_mAh : null;
        }
        info.satBMae = computeMAE(entries, satBAnchorIdx, teProjB, 'satBBatPct');
      }
      // Previous Calculated
      if (anchorMode === 'auto' && satBAnchorIdx >= 0) {
        var _curSbT = entries[satBAnchorIdx].timestamp.getTime();
        if (_lastKnownAnchorT.satB < 0) {
          _lastKnownAnchorT.satB = _curSbT;
        } else if (_curSbT !== _lastKnownAnchorT.satB) {
          _prevCalcAnchorT.satB = _lastKnownAnchorT.satB;
          _lastKnownAnchorT.satB = _curSbT;
        }
        if (_prevCalcAnchorT.satB > 0) {
          var _psbi = -1, _psbd = Infinity;
          for (var pbsi = 0; pbsi < entries.length; pbsi++) {
            var _dsb = Math.abs(entries[pbsi].timestamp.getTime() - _prevCalcAnchorT.satB);
            if (_dsb < _psbd && entries[pbsi].satBBatPct > 0) { _psbd = _dsb; _psbi = pbsi; }
          }
          if (_psbi >= 0) {
            var _psbProj = BatteryModel.projectCurve(
              entries[_psbi].satBBatPct, entries[_psbi].timestamp,
              teResult.dailyTotal_mAh, teResult.batteryCapacity, teResult.derating
            );
            datasets.push({
              label: 'Sat-B Calc. (prior)',
              data:  _psbProj.map(function (p) { return { x: p.time, y: p.pct }; }),
              borderColor: C.satBPredict + '44',
              backgroundColor: 'transparent',
              borderWidth: 1,
              borderDash: [2, 6],
              pointRadius: 0,
              tension: 0.3,
              fill: false,
            });
          }
        }
      }
      // Trending
      var satBTrend = buildTrendDataset(satBActual, 'Sat-B', C.satBTrend);
      if (satBTrend.dataset) {
        datasets.push(satBTrend.dataset);
        info._trendConfidence.push({ label: 'Sat-B', windowLabel: satBTrend.windowLabel, r2: satBTrend.r2, color: C.satBTrend });
      } else {
        if (satBActual.length > 0) info._trendInsufficient.push({ label: 'Sat-B', reason: satBTrend.reason, color: C.satBTrend });
      }
    }

    return { datasets: datasets, info: info };
  }

  // ========================================================================
  // CONFIG CHANGE ANNOTATION PLUGIN (vertical lines on chart)
  // ========================================================================
  var configAnnotationPlugin = {
    id: 'configAnnotation',
    afterDraw: function (chartInstance) {
      if (!configChanges || !configChanges.length) return;
      var xAxis = chartInstance.scales.x;
      var yAxis = chartInstance.scales.y;
      if (!xAxis || !yAxis) return;
      var ctx = chartInstance.ctx;
      ctx.save();
      configChanges.forEach(function (cc) {
        var xPx = xAxis.getPixelForValue(cc.timestamp.getTime());
        if (xPx < xAxis.left || xPx > xAxis.right) return;
        ctx.beginPath();
        ctx.setLineDash([4, 4]);
        ctx.strokeStyle = C.configLine;
        ctx.lineWidth = 1.5;
        ctx.moveTo(xPx, yAxis.top);
        ctx.lineTo(xPx, yAxis.bottom);
        ctx.stroke();
        // Label
        ctx.setLineDash([]);
        ctx.fillStyle = C.configLine;
        ctx.font = '10px sans-serif';
        ctx.textAlign = 'center';
        ctx.fillText('Config \u0394', xPx, yAxis.top - 4);
      });
      ctx.restore();
    }
  };

  // ========================================================================
  // ANCHOR LINE PLUGIN (shows anchor point)
  // ========================================================================
  var anchorLinePlugin = {
    id: 'anchorLine',
    afterDraw: function (chartInstance) {
      if (!chartInstance._forecastAnchorTime) return;
      var xAxis = chartInstance.scales.x;
      var yAxis = chartInstance.scales.y;
      if (!xAxis || !yAxis) return;
      var xPx = xAxis.getPixelForValue(chartInstance._forecastAnchorTime);
      if (xPx < xAxis.left || xPx > xAxis.right) return;
      var ctx = chartInstance.ctx;
      ctx.save();
      ctx.beginPath();
      ctx.setLineDash([2, 3]);
      ctx.strokeStyle = '#94a3b8';
      ctx.lineWidth = 1;
      ctx.moveTo(xPx, yAxis.top);
      ctx.lineTo(xPx, yAxis.bottom);
      ctx.stroke();
      ctx.setLineDash([]);
      ctx.fillStyle = '#94a3b8';
      ctx.font = '10px sans-serif';
      ctx.textAlign = 'center';
      var label = anchorMode === 'locked' ? '\u{1F4CC} Anchor (locked)' : '\u25C6 Anchor';
      ctx.fillText(label, xPx, yAxis.bottom + 14);
      ctx.restore();
    }
  };

  // ========================================================================
  // TREND CONFIDENCE OVERLAY PLUGIN (top-right of chart area)
  // ========================================================================
  var trendConfidencePlugin = {
    id: 'trendConfidence',
    afterDraw: function (chartInstance) {
      var tInfo   = chartInstance._trendInfo        || [];
      var tInsuff = chartInstance._trendInsufficient || [];
      var allRows = tInfo.length + tInsuff.length;
      if (!allRows) return;
      var xAxis = chartInstance.scales.x;
      var yAxis = chartInstance.scales.y;
      if (!xAxis || !yAxis) return;
      var ctx = chartInstance.ctx;
      ctx.save();
      var lineH = 14;
      var pad   = 5;
      var boxW  = 210;
      var boxH  = allRows * lineH + pad * 2;
      var boxX  = xAxis.right - boxW - 4;
      var boxY  = yAxis.top + 4;
      ctx.fillStyle = 'rgba(15,23,42,0.80)';
      ctx.beginPath();
      ctx.roundRect ? ctx.roundRect(boxX, boxY, boxW, boxH, 4)
                    : ctx.rect(boxX, boxY, boxW, boxH);
      ctx.fill();
      ctx.font      = '10px sans-serif';
      ctx.textAlign = 'right';
      var textX = xAxis.right - 8;
      var textY = boxY + pad + 10;
      tInfo.forEach(function (t) {
        var pct = Math.round(t.r2 * 100);
        ctx.fillStyle = t.color;
        ctx.fillText(t.label + ' trend: ' + t.windowLabel + '  (' + pct + '% fit)', textX, textY);
        textY += lineH;
      });
      tInsuff.forEach(function (t) {
        ctx.fillStyle = '#64748b';
        ctx.fillText(t.label + ' trend: ' + t.reason, textX, textY);
        textY += lineH;
      });
      ctx.restore();
    }
  };

  // ========================================================================
  // RENDER INFO CARDS
  // ========================================================================
  function renderInfoCards(info) {
    var html = '';

    // Config status
    var cfgColor = info.configAvailable ? '#22c55e' : '#f59e0b';
    var cfgText  = info.configAvailable ? info.configSummary : 'Using defaults (no config in field8 yet)';
    html += '<div class="fc-info-chip" style="border-color:' + cfgColor + ';color:' + cfgColor + '">'
         +  '\u2699 ' + cfgText + '</div>';

    if (info.configChanges && info.configChanges.length > 0) {
      html += '<div class="fc-info-chip" style="border-color:#ef4444;color:#ef4444">'
           +  '\u26A0 ' + info.configChanges.length + ' config change' + (info.configChanges.length > 1 ? 's' : '') + ' detected</div>';
    }

    // Days remaining cards — accuracy merged in when available
    function daysCard(label, days, mae, color) {
      if (days === null) return '';
      var dStr = days < 1 ? '< 1' : Math.round(days).toString();
      var mStr = (days / 30.44).toFixed(1);
      var accLine = mae
        ? '<div class="fc-card-sub">\u00b1' + mae.mae.toFixed(1) + '% accuracy (' + mae.samples + ' pts)</div>'
        : '';
      return '<div class="fc-card" style="border-top:3px solid ' + color + '">'
           + '<div class="fc-card-label">' + label + '</div>'
           + '<div class="fc-card-value" style="color:' + color + '">' + dStr + ' <span class="fc-card-unit">days</span></div>'
           + '<div class="fc-card-sub">' + mStr + ' months</div>'
           + accLine
           + '</div>';
    }

    html += '<div class="fc-cards">';
    html += daysCard('T0 Gateway',  info.t0DaysLeft,   info.t0Mae,   C.t0Actual);
    html += daysCard('Satellite A', info.satADaysLeft, info.satAMae, C.satAActual);
    html += daysCard('Satellite B', info.satBDaysLeft, info.satBMae, C.satBActual);
    html += '</div>';

    var el = document.getElementById('fcInfoCards');
    if (el) el.innerHTML = html;
  }

  // ========================================================================
  // INIT / UPDATE
  // ========================================================================
  function update(state) {
    if (state) _activeState = state;
    var canvas = document.getElementById('forecastChart');
    if (!canvas) return;
    if (!_activeState || !_activeState.allEntries || !_activeState.allEntries.length) return;
    state = _activeState;

    var result = buildDatasets(state);
    renderInfoCards(result.info);

    // Determine anchor time for plugin
    var entries = state.allEntries;
    var anchorIdx = getAnchor(entries);
    var anchorTime = anchorIdx >= 0 ? entries[anchorIdx].timestamp.getTime() : null;

    if (chart) {
      chart.data.datasets = result.datasets;
      chart._trendInfo = result.info._trendConfidence || [];
      chart._trendInsufficient = result.info._trendInsufficient || [];
      chart._trendInsufficient = result.info._trendInsufficient || [];
      chart._forecastAnchorTime = anchorTime;
      applyFcRange();
      chart.update('none');
    } else {
      chart = new Chart(canvas, {
        type: 'line',
        data: { datasets: result.datasets },
        options: {
          responsive: true,
          maintainAspectRatio: false,
          interaction: { mode: 'index', intersect: false },
          plugins: {
            legend: { position: 'top', labels: { color: '#94a3b8', font: { size: 11 }, usePointStyle: true, pointStyle: 'line' } },
            tooltip: {
              backgroundColor: '#1e293b',
              borderColor: '#334155',
              borderWidth: 1,
              titleColor: '#f1f5f9',
              bodyColor: '#94a3b8',
              callbacks: {
                label: function (ctx) { return ctx.dataset.label + ': ' + ctx.parsed.y.toFixed(1) + '%'; }
              }
            },
          },
          scales: {
            x: {
              type: 'time',
              time: { unit: 'day', displayFormats: { day: 'dd MMM', hour: 'HH:mm' } },
              grid: { color: '#1e293b' },
              ticks: { color: '#64748b', maxTicksLimit: 12 },
            },
            y: {
              min: 0, max: 100,
              title: { display: true, text: 'Battery (%)', color: '#94a3b8' },
              grid: { color: '#1e293b' },
              ticks: { color: '#64748b' },
            }
          },
          onClick: function (evt, elements) {
            if (anchorMode !== 'locked') return;
            // Click to set anchor on locked mode
            var xVal = chart.scales.x.getValueForPixel(evt.x);
            if (!xVal) return;
            // Find nearest entry in current active dataset
            var _clickEntries = _activeState ? _activeState.allEntries : [];
            var best = -1, bestDist = Infinity;
            for (var i = 0; i < _clickEntries.length; i++) {
              var d = Math.abs(_clickEntries[i].timestamp.getTime() - xVal);
              if (d < bestDist) { bestDist = d; best = i; }
            }
            if (best >= 0) {
              lockedAnchorIdx = best;
              try { localStorage.setItem('fc_anchor_time', _clickEntries[best].timestamp.toISOString()); } catch (e) {}
              update(_activeState);
            }
          }
        },
        plugins: [configAnnotationPlugin, anchorLinePlugin, trendConfidencePlugin],
      });      chart._trendInfo = result.info._trendConfidence || [];      chart._forecastAnchorTime = anchorTime;
      applyFcRange();
      chart.update('none');
    }

    // Update anchor mode button state
    var btnAuto   = document.getElementById('fcAnchorAuto');
    var btnLocked = document.getElementById('fcAnchorLock');
    if (btnAuto)   btnAuto.classList.toggle('active', anchorMode === 'auto');
    if (btnLocked) btnLocked.classList.toggle('active', anchorMode === 'locked');
  }

  var _inited = false;

  function init(state) {
    _activeState = state;
    if (_inited) { update(state); return; }
    _inited = true;

    var btnAuto = document.getElementById('fcAnchorAuto');
    var btnLock = document.getElementById('fcAnchorLock');

    // Restore anchor mode from localStorage
    try {
      var _savedMode = localStorage.getItem('fc_anchor_mode');
      var _savedAnchorTs = localStorage.getItem('fc_anchor_time');
      if (_savedMode === 'locked' && _savedAnchorTs) {
        var _targetMs = new Date(_savedAnchorTs).getTime();
        if (!isNaN(_targetMs)) {
          anchorMode = 'locked';
          var _bst = -1, _bstD = Infinity;
          for (var _ai = 0; _ai < state.allEntries.length; _ai++) {
            var _ad = Math.abs(state.allEntries[_ai].timestamp.getTime() - _targetMs);
            if (_ad < _bstD) { _bstD = _ad; _bst = _ai; }
          }
          lockedAnchorIdx = _bst;
        }
      }
    } catch (e) {}

    // Restore or default start date.
    // Priority: (1) localStorage, (2) 24 hours before now.
    if (!fcStartDate) {
      var saved = null;
      try { saved = localStorage.getItem('fc_start_date'); } catch (e) {}
      if (saved) {
        var parsed = new Date(saved + 'T00:00:00');
        fcStartDate = isNaN(parsed.getTime()) ? null : parsed;
      }
      if (!fcStartDate) {
        // Default: midnight of yesterday (24 h before now, rounded to day boundary)
        var d24 = new Date(Date.now() - 24 * 3600 * 1000);
        d24.setHours(0, 0, 0, 0);
        fcStartDate = d24;
      }
    }

    // Date picker — updates fcStartDate, persists to localStorage, re-applies span
    var fcDateEl = document.getElementById('fcStartDate');
    if (fcDateEl) {
      fcDateEl.value = fcStartDate.toISOString().slice(0, 10);
      fcDateEl.addEventListener('change', function () {
        var d = new Date(this.value + 'T00:00:00');
        if (!isNaN(d.getTime())) {
          fcStartDate = d;
          try { localStorage.setItem('fc_start_date', this.value); } catch (e) {}
          if (fcTimeRange === 'custom') fcTimeRange = 'week';
          setFcTimeRange(fcTimeRange);
        }
      });
    }

    // Forecast span buttons (Day / Week / Month / All)
    document.querySelectorAll('[data-fcrange]').forEach(function (btn) {
      btn.addEventListener('click', function () { setFcTimeRange(this.dataset.fcrange); });
    });

    // Scroll-wheel zoom on forecast chart
    var fcCanvas = document.getElementById('forecastChart');
    if (fcCanvas) {
      fcCanvas.addEventListener('wheel', function (e) {
        e.preventDefault();
        if (!chart) return;
        var xScale  = chart.scales.x;
        var curMin  = xScale.min;
        var curMax  = xScale.max;
        var range   = curMax - curMin;
        var factor  = e.deltaY > 0 ? 1.2 : (1 / 1.2);
        var rect    = fcCanvas.getBoundingClientRect();
        var ratio   = (e.clientX - rect.left) / rect.width;
        var newRange = range * factor;
        var newMin   = curMin + ratio * (range - newRange);
        chart.options.scales.x.min = newMin;
        chart.options.scales.x.max = newMin + newRange;
        fcTimeRange = 'custom';
        document.querySelectorAll('[data-fcrange]').forEach(function (b) { b.classList.remove('active'); });
        chart.update('none');
      }, { passive: false });
    }

    if (btnAuto) btnAuto.addEventListener('click', function () {
      anchorMode = 'auto'; lockedAnchorIdx = -1;
      try { localStorage.setItem('fc_anchor_mode', 'auto'); localStorage.removeItem('fc_anchor_time'); } catch (e) {}
      update(_activeState);
    });
    if (btnLock) btnLock.addEventListener('click', function () {
      if (anchorMode === 'locked') {
        // Toggle back to auto
        anchorMode = 'auto'; lockedAnchorIdx = -1;
        try { localStorage.setItem('fc_anchor_mode', 'auto'); localStorage.removeItem('fc_anchor_time'); } catch (e) {}
      } else {
        anchorMode = 'locked';
        // Default lock to latest available T0 entry
        var _aEntries = _activeState ? _activeState.allEntries : [];
        for (var i = _aEntries.length - 1; i >= 0; i--) {
          if (_aEntries[i].t0BatPct !== null && _aEntries[i].t0BatPct > 0) {
            lockedAnchorIdx = i; break;
          }
        }
        try {
          localStorage.setItem('fc_anchor_mode', 'locked');
          if (lockedAnchorIdx >= 0)
            localStorage.setItem('fc_anchor_time', _aEntries[lockedAnchorIdx].timestamp.toISOString());
        } catch (e) {}
      }
      update(_activeState);
    });

    update(state);
  }

  // Destroy chart on page unload (cleanup)
  function destroy() {
    if (chart) { chart.destroy(); chart = null; }
  }

  // Reset anchor / prior-calc state — call before switching stations
  function reset() {
    anchorMode = 'auto';
    lockedAnchorIdx = -1;
    _lastKnownAnchorT = { t0: -1, satA: -1, satB: -1 };
    _prevCalcAnchorT  = { t0: -1, satA: -1, satB: -1 };
  }

  return {
    init:     init,
    update:   update,
    destroy:  destroy,
    reset:    reset,
    setRange: setFcTimeRange,
  };

})();

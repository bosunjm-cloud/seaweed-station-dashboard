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
  var showT0  = true;
  var showSatA = true;
  var showSatB = true;

  // Persistent forecast state (survives renderDashboard calls)
  var lastConfig     = null;  // latest parsed device config
  var configChanges  = [];    // [{timestamp, oldCfg, newCfg}]

  // Colors matching the parent dashboard
  var C = {
    t0Actual:    '#3b82f6',
    t0Predict:   '#3b82f6',
    satAActual:  '#10b981',
    satAPredict: '#10b981',
    satBActual:  '#f59e0b',
    satBPredict: '#f59e0b',
    configLine:  '#ef4444',
  };

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
          label: 'T0 Predicted',
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
          label: 'Sat-A Predicted',
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
        if (latestSatA >= 0 && anchorMode === 'auto') {
          var saEntry = entries[latestSatA];
          var saRemain = (saEntry.satABatPct / 100.0) * teResult.usable_mAh;
          info.satADaysLeft = teResult.dailyTotal_mAh > 0 ? saRemain / teResult.dailyTotal_mAh : null;
        }
        info.satAMae = computeMAE(entries, satAAnchorIdx, teProj, 'satABatPct');
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
          label: 'Sat-B Predicted',
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
        if (latestSatB >= 0 && anchorMode === 'auto') {
          var sbEntry = entries[latestSatB];
          var sbRemain = (sbEntry.satBBatPct / 100.0) * teResult.usable_mAh;
          info.satBDaysLeft = teResult.dailyTotal_mAh > 0 ? sbRemain / teResult.dailyTotal_mAh : null;
        }
        info.satBMae = computeMAE(entries, satBAnchorIdx, teProjB, 'satBBatPct');
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

    // Days remaining cards
    function daysCard(label, days, color) {
      if (days === null) return '';
      var dStr = days < 1 ? '< 1' : Math.round(days).toString();
      var mStr = (days / 30.44).toFixed(1);
      return '<div class="fc-card" style="border-top:3px solid ' + color + '">'
           + '<div class="fc-card-label">' + label + '</div>'
           + '<div class="fc-card-value" style="color:' + color + '">' + dStr + ' <span class="fc-card-unit">days</span></div>'
           + '<div class="fc-card-sub">' + mStr + ' months</div>'
           + '</div>';
    }

    html += '<div class="fc-cards">';
    html += daysCard('T0 Gateway', info.t0DaysLeft, C.t0Actual);
    html += daysCard('Satellite A', info.satADaysLeft, C.satAActual);
    html += daysCard('Satellite B', info.satBDaysLeft, C.satBActual);

    // MAE cards
    function maeCard(label, mae, color) {
      if (!mae) return '';
      return '<div class="fc-card fc-card-sm">'
           + '<div class="fc-card-label">' + label + ' Accuracy</div>'
           + '<div class="fc-card-value" style="color:' + color + '">\u00B1' + mae.mae.toFixed(1) + ' <span class="fc-card-unit">%</span></div>'
           + '<div class="fc-card-sub">MAE over ' + mae.samples + ' points</div>'
           + '</div>';
    }
    html += maeCard('T0', info.t0Mae, C.t0Actual);
    html += maeCard('Sat-A', info.satAMae, C.satAActual);
    html += maeCard('Sat-B', info.satBMae, C.satBActual);
    html += '</div>';

    var el = document.getElementById('fcInfoCards');
    if (el) el.innerHTML = html;
  }

  // ========================================================================
  // INIT / UPDATE
  // ========================================================================
  function update(state) {
    var canvas = document.getElementById('forecastChart');
    if (!canvas) return;
    if (!state.allEntries || !state.allEntries.length) return;

    var result = buildDatasets(state);
    renderInfoCards(result.info);

    // Determine anchor time for plugin
    var entries = state.allEntries;
    var anchorIdx = getAnchor(entries);
    var anchorTime = anchorIdx >= 0 ? entries[anchorIdx].timestamp.getTime() : null;

    if (chart) {
      chart.data.datasets = result.datasets;
      chart._forecastAnchorTime = anchorTime;
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
            // Find nearest entry
            var best = -1, bestDist = Infinity;
            for (var i = 0; i < entries.length; i++) {
              var d = Math.abs(entries[i].timestamp.getTime() - xVal);
              if (d < bestDist) { bestDist = d; best = i; }
            }
            if (best >= 0) {
              lockedAnchorIdx = best;
              update(state);
            }
          }
        },
        plugins: [configAnnotationPlugin, anchorLinePlugin],
      });
      chart._forecastAnchorTime = anchorTime;
    }

    // Update anchor mode button state
    var btnAuto   = document.getElementById('fcAnchorAuto');
    var btnLocked = document.getElementById('fcAnchorLock');
    if (btnAuto)   btnAuto.classList.toggle('active', anchorMode === 'auto');
    if (btnLocked) btnLocked.classList.toggle('active', anchorMode === 'locked');
  }

  var _inited = false;

  function init(state) {
    if (_inited) { update(state); return; }
    _inited = true;

    // Wire up toggle buttons
    var btnT0   = document.getElementById('fcToggleT0');
    var btnSatA = document.getElementById('fcToggleSatA');
    var btnSatB = document.getElementById('fcToggleSatB');
    var btnAuto = document.getElementById('fcAnchorAuto');
    var btnLock = document.getElementById('fcAnchorLock');

    if (btnT0) btnT0.addEventListener('click', function () {
      showT0 = !showT0; this.classList.toggle('active', showT0); update(state);
    });
    if (btnSatA) btnSatA.addEventListener('click', function () {
      showSatA = !showSatA; this.classList.toggle('active', showSatA); update(state);
    });
    if (btnSatB) btnSatB.addEventListener('click', function () {
      showSatB = !showSatB; this.classList.toggle('active', showSatB); update(state);
    });
    if (btnAuto) btnAuto.addEventListener('click', function () {
      anchorMode = 'auto'; lockedAnchorIdx = -1; update(state);
    });
    if (btnLock) btnLock.addEventListener('click', function () {
      if (anchorMode === 'locked') {
        // Toggle back to auto
        anchorMode = 'auto'; lockedAnchorIdx = -1;
      } else {
        anchorMode = 'locked';
        // Default lock to first available entry
        for (var i = 0; i < state.allEntries.length; i++) {
          if (state.allEntries[i].t0BatPct !== null && state.allEntries[i].t0BatPct > 0) {
            lockedAnchorIdx = i; break;
          }
        }
      }
      update(state);
    });

    update(state);
  }

  // Destroy chart on page unload (cleanup)
  function destroy() {
    if (chart) { chart.destroy(); chart = null; }
  }

  return {
    init:    init,
    update:  update,
    destroy: destroy,
  };

})();

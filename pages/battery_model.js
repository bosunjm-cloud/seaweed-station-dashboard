// ============================================================================
// battery_model.js — Shared Battery Lifetime Prediction Engine
// ============================================================================
// Single source of truth for T0 and T-Energy energy models.
// Used by:  battery_estimator.html  (manual what-if UI)
//           perth.html / shangani.html / funzi.html  (live forecast)
//
// Version: 1.0  (2026-02-24)
// ============================================================================
"use strict";

window.BatteryModel = (function () {

  // ========================================================================
  // HARDWARE DEFAULTS (match battery_estimator.html Advanced Settings)
  // ========================================================================
  var HW_T0 = {
    sleepCurrent_mA:    0.35,     // deep-sleep draw
    mcuActive_mA:       60,       // ESP32-S3 active (no radio)
    wifiActive_mA:      150,      // WiFi TX/RX
    cellActive_mA:      200,      // SIM7670G modem active
    sampleDuration_s:   1.5,      // base sample wake (excl sensors)
    sensorMs:           25,       // per-sensor read time (ms)
    sensorCurrent_mA:   1.0,      // per-sensor current (mA)
    sensorCount:        2,        // default T/H sensor count
    modemBoot_s:        12,
    modemShutdown_s:    3,
    cellBulkBase_s:     20,
    cellInitReg_s:      35,
    cellBulkPerRow_s:   0.1,
    blynkOps_s:         8,
    modemBlockMax_s:    180,
    wifiConnect_s:      4,
    wifiBulkUpload_s:   10,
    sdWriteCurrent_mA:  90,
    sdWriteTime_s:      0.2,
    bootOverhead_s:     1.0,
    teRxWindowMs:       800,      // ESP-NOW listen per satellite
    teTxSyncMs:         15,       // SYNC+ACK send per satellite
    teRxProcMs:         120,      // parse/store overhead per satellite
    teEarlyWake_s:      1.0,      // early wake before epoch grid
    batteryDerating:    0.85,     // usable fraction of nameplate capacity
    batteryCapacity_mAh: 3000,
  };

  var HW_TE = {
    sleepUa:            10,       // deep-sleep draw (µA)
    bootCurrent_mA:     80,
    bootMs:             300,
    i2cCurrent_mA:      20,
    i2cMs:              10,
    mcuActive_mA:       50,
    txCurrent_mA:       120,
    txMs:               10,
    rxCurrent_mA:       80,
    flashCurrent_mA:    40,
    flashMs:            20,
    syncApplyMs:        20,
    sensorMs:           25,
    sensorCurrent_mA:   40,
    sensorCount:        2,
    listenMs:           400,      // normal listen window
    listenLongMs:       1200,     // extended listen window
    listenEveryN:       10,       // every Nth wake uses long listen
    retries:            2,
    batteryDerating:    0.85,
    batteryCapacity_mAh: 3000,
  };

  // ========================================================================
  // T0 ENERGY MODEL  (from battery_estimator.html runT0Estimate)
  // ========================================================================
  // cfg = { deployMode, sleepEnable, samplePeriod_s, tsBulkInterval_s,
  //         tsBulkFreqHours, espnowSyncPeriod_s, satAInstalled, satBInstalled }
  // hwOverrides (optional) can override any key from HW_T0
  function calcT0Daily(cfg, hwOverrides) {
    var hw = Object.assign({}, HW_T0, hwOverrides || {});

    var mode            = cfg.deployMode === 0 ? 'wifi' : 'cell';
    var sleepEn         = !!cfg.sleepEnable;
    var samplePeriod    = Math.max(10, cfg.samplePeriod_s || 600);
    var bulkInterval_s  = Math.max(60, cfg.tsBulkInterval_s || 900);
    var syncFreqHours   = Math.max(1, cfg.tsBulkFreqHours || 24);
    var syncPeriod_s    = Math.max(60, cfg.espnowSyncPeriod_s || 3600);
    var tEnergyNodes    = (cfg.satAInstalled ? 1 : 0) + (cfg.satBInstalled ? 1 : 0);
    var battCap         = hw.batteryCapacity_mAh;
    var derating        = hw.batteryDerating;

    var usable_mAh      = battCap * derating;
    var samplesPerDay   = Math.floor(86400 / samplePeriod);
    var syncsPerDay     = tEnergyNodes > 0 ? Math.floor(86400 / syncPeriod_s) : 0;
    var uploadsPerDay   = 24.0 / syncFreqHours;
    var rowsPerUpload   = Math.max(1, Math.floor((syncFreqHours * 3600) / bulkInterval_s));

    // Sensor read time
    var sensorCount     = hw.sensorCount;
    var t0Sensors_s     = (sensorCount * hw.sensorMs) / 1000.0;
    var t_sampleTotal   = hw.sampleDuration_s + t0Sensors_s;

    // Sample active time per day
    var sampleActivePerDay_s;
    if (sleepEn) {
      sampleActivePerDay_s = samplesPerDay * t_sampleTotal;
    } else {
      var t_readOnly = Math.max(0, t_sampleTotal - hw.bootOverhead_s);
      sampleActivePerDay_s = samplesPerDay * t_readOnly;
    }

    var sdEnergy_mAh     = (samplesPerDay * hw.sdWriteTime_s * hw.sdWriteCurrent_mA) / 3600.0;
    var sensorEnergy_mAh = (samplesPerDay * t0Sensors_s * hw.sensorCurrent_mA) / 3600.0;
    var sampleEnergy_mAh = (sampleActivePerDay_s * hw.mcuActive_mA) / 3600.0 + sdEnergy_mAh + sensorEnergy_mAh;

    // Early wake penalty for satellite sync
    var earlyWakePerDay_s   = tEnergyNodes > 0 ? syncsPerDay * hw.teEarlyWake_s : 0;
    var earlyWakeEnergy_mAh = (earlyWakePerDay_s * hw.mcuActive_mA) / 3600.0;

    // ESP-NOW window
    var tePerSync_s      = (tEnergyNodes * (hw.teRxWindowMs + hw.teTxSyncMs + hw.teRxProcMs)) / 1000.0;
    var teActivePerDay_s = syncsPerDay * tePerSync_s;
    var teEnergy_mAh     = (teActivePerDay_s * hw.wifiActive_mA) / 3600.0;

    // Upload energy
    var uploadDuration_s = 0;
    var I_radio = hw.mcuActive_mA;
    if (mode === 'cell') {
      I_radio = hw.cellActive_mA;
      uploadDuration_s = hw.modemBoot_s + hw.cellInitReg_s + hw.cellBulkBase_s
                       + (rowsPerUpload * hw.cellBulkPerRow_s) + hw.blynkOps_s + hw.modemShutdown_s;
      uploadDuration_s = Math.min(uploadDuration_s, hw.modemBlockMax_s);
    } else {
      I_radio = hw.wifiActive_mA;
      uploadDuration_s = hw.wifiConnect_s + hw.wifiBulkUpload_s + (rowsPerUpload * 0.05);
    }
    var uploadActivePerDay_s = uploadsPerDay * uploadDuration_s;
    var uploadEnergy_mAh     = (uploadActivePerDay_s * I_radio) / 3600.0;

    // Sleep energy
    var totalActivePerDay_s = sampleActivePerDay_s + earlyWakePerDay_s + teActivePerDay_s + uploadActivePerDay_s;
    var sleepEnergy_mAh;
    if (sleepEn) {
      var sleepTime_s = Math.max(0, 86400 - totalActivePerDay_s);
      sleepEnergy_mAh = (sleepTime_s * hw.sleepCurrent_mA) / 3600.0;
    } else {
      var idleTime_s = Math.max(0, 86400 - totalActivePerDay_s);
      sleepEnergy_mAh = (idleTime_s * hw.mcuActive_mA) / 3600.0;
    }

    var dailyTotal_mAh = sleepEnergy_mAh + sampleEnergy_mAh + earlyWakeEnergy_mAh + teEnergy_mAh + uploadEnergy_mAh;
    var lifetimeDays   = dailyTotal_mAh > 0 ? usable_mAh / dailyTotal_mAh : 0;

    return {
      dailyTotal_mAh:   dailyTotal_mAh,
      lifetimeDays:     lifetimeDays,
      usable_mAh:       usable_mAh,
      batteryCapacity:  battCap,
      derating:         derating,
      // Breakdown
      sleepMah:         sleepEnergy_mAh,
      sampleMah:        sampleEnergy_mAh,
      uploadMah:        uploadEnergy_mAh,
      espNowMah:        teEnergy_mAh,
      earlyWakeMah:     earlyWakeEnergy_mAh,
      // Config echo (for display)
      mode:             mode,
      sleepEn:          sleepEn,
      samplePeriod_s:   samplePeriod,
      tEnergyNodes:     tEnergyNodes,
    };
  }

  // ========================================================================
  // T-ENERGY ENERGY MODEL  (from battery_estimator.html runTEEstimate)
  // ========================================================================
  // cfg = { samplePeriod_s, espnowSyncPeriod_s, sleepEnable }
  function calcTEDaily(cfg, hwOverrides) {
    var hw = Object.assign({}, HW_TE, hwOverrides || {});

    var samplePeriod = Math.max(10, cfg.samplePeriod_s || 600);
    var syncPeriod   = Math.max(60, cfg.espnowSyncPeriod_s || 3600);
    var sleepEn      = cfg.sleepEnable !== undefined ? !!cfg.sleepEnable : true;
    var battCap      = hw.batteryCapacity_mAh;
    var derating     = hw.batteryDerating;

    var usable_mAh   = battCap * derating;
    var samplesPerDay = Math.floor(86400 / samplePeriod);
    var syncsPerDay   = Math.floor(86400 / syncPeriod);
    var periodsMatch  = Math.abs(samplePeriod - syncPeriod) < 0.001;

    var sensorCount  = hw.sensorCount;
    var boot_ms      = hw.bootMs;
    var sensor_ms    = sensorCount * hw.sensorMs;
    var i2c_ms       = hw.i2cMs + sensor_ms;
    var tx_frames    = 2 * (1 + hw.retries);
    var tx_ms        = tx_frames * hw.txMs;
    var normalFraction = (hw.listenEveryN - 1) / hw.listenEveryN;
    var longFraction   = 1.0 / hw.listenEveryN;
    var avgListenMs    = normalFraction * hw.listenMs + longFraction * hw.listenLongMs;
    var flash_ms       = hw.flashMs;
    var sync_ms        = hw.syncApplyMs;

    var sampleWakeCount = samplesPerDay;
    var syncWakeCount   = periodsMatch ? samplesPerDay : syncsPerDay;
    var bootWakeCount   = periodsMatch ? sampleWakeCount : (sampleWakeCount + syncWakeCount);

    var sampleWakeMs = boot_ms + i2c_ms + flash_ms;
    var syncWakeMs   = boot_ms + tx_ms + avgListenMs + sync_ms;
    var totalActiveMs = periodsMatch
      ? (sampleWakeCount * (sampleWakeMs + tx_ms + avgListenMs + sync_ms))
      : (sampleWakeCount * sampleWakeMs) + (syncWakeCount * syncWakeMs);
    var totalMsDay   = 86400 * 1000;
    var sleepMsDay   = Math.max(0, totalMsDay - totalActiveMs);

    var mAhPerMs = 1.0 / 3600000.0;

    var e_boot_uAh    = hw.bootCurrent_mA * boot_ms * mAhPerMs * 1000;
    var e_i2c_uAh     = hw.i2cCurrent_mA  * hw.i2cMs * mAhPerMs * 1000;
    var e_sensor_uAh  = hw.sensorCurrent_mA * sensor_ms * mAhPerMs * 1000;
    var e_tx_uAh      = hw.txCurrent_mA   * tx_ms * mAhPerMs * 1000;
    var e_rx_uAh      = hw.rxCurrent_mA   * avgListenMs * mAhPerMs * 1000;
    var e_flash_uAh   = hw.flashCurrent_mA * flash_ms * mAhPerMs * 1000;

    var sampleMcuMs    = hw.i2cMs + sensor_ms + flash_ms;
    var syncApplyMcuMs = sync_ms;
    var e_mcuActive_uAh = hw.mcuActive_mA * ((sampleWakeCount * sampleMcuMs) + (syncWakeCount * syncApplyMcuMs)) * mAhPerMs * 1000;

    var e_active_uAh =
      (e_boot_uAh * bootWakeCount) +
      e_mcuActive_uAh +
      (e_i2c_uAh * sampleWakeCount) +
      (e_sensor_uAh * sampleWakeCount) +
      (e_flash_uAh * sampleWakeCount) +
      (e_tx_uAh * syncWakeCount) +
      (e_rx_uAh * syncWakeCount);

    var e_sleep_uAh = sleepEn
      ? (hw.sleepUa * sleepMsDay / 3600000.0)
      : (hw.bootCurrent_mA * sleepMsDay * mAhPerMs * 1000);

    var dailyEnergy_mAh = (e_active_uAh + e_sleep_uAh) / 1000.0;
    var lifetimeDays    = dailyEnergy_mAh > 0 ? usable_mAh / dailyEnergy_mAh : 0;

    return {
      dailyTotal_mAh:  dailyEnergy_mAh,
      lifetimeDays:    lifetimeDays,
      usable_mAh:      usable_mAh,
      batteryCapacity: battCap,
      derating:        derating,
    };
  }

  // ========================================================================
  // PROJECTION: Generate predicted battery % curve from an anchor point
  // ========================================================================
  // startPct:   battery % at anchor (e.g. 91.8)
  // startTime:  Date object at anchor
  // dailyMah:   daily energy consumption (from calcT0Daily or calcTEDaily)
  // battCap:    battery capacity in mAh
  // derating:   usable fraction (0-1, e.g. 0.85)
  // maxDays:    how far to project (default: until 0%)
  //
  // Returns: [ { time: Date, pct: number }, ... ]  (one point per day)
  function projectCurve(startPct, startTime, dailyMah, battCap, derating, maxDays) {
    if (!battCap || !dailyMah || dailyMah <= 0) return [];
    derating = derating || 0.85;
    var usable = battCap * derating;

    // Convert start % to remaining mAh
    var remainingMah = (startPct / 100.0) * usable;
    var maxD = maxDays || Math.ceil(remainingMah / dailyMah) + 1;
    maxD = Math.min(maxD, 730); // cap at 2 years

    var points = [];
    var startMs = startTime.getTime();

    for (var d = 0; d <= maxD; d++) {
      var mah = Math.max(0, remainingMah - d * dailyMah);
      var pct = (mah / usable) * 100.0;
      points.push({
        time: new Date(startMs + d * 86400000),
        pct:  Math.max(0, Math.min(100, pct)),
      });
      if (pct <= 0) break;
    }
    return points;
  }

  // ========================================================================
  // CONFIG PARSER: Extract device config from field8 pipe-delimited block
  // ========================================================================
  // field8 format: "sdFreeKB,csq,uploadOk,drift|dm,sl,sp,bi,bf,es,sA,sB"
  // Returns { deployMode, sleepEnable, samplePeriod_s, tsBulkInterval_s,
  //           tsBulkFreqHours, espnowSyncPeriod_s, satAInstalled, satBInstalled }
  // or null if no config block present.
  function parseField8Config(field8str) {
    if (!field8str || typeof field8str !== 'string') return null;
    var pipeIdx = field8str.indexOf('|');
    if (pipeIdx < 0) return null;

    var cfgPart = field8str.substring(pipeIdx + 1);
    var tokens = cfgPart.split(',');
    if (tokens.length < 8) return null;

    return {
      deployMode:          parseInt(tokens[0], 10) || 0,
      sleepEnable:         parseInt(tokens[1], 10) === 1,
      samplePeriod_s:      parseInt(tokens[2], 10) || 600,
      tsBulkInterval_s:    parseInt(tokens[3], 10) || 900,
      tsBulkFreqHours:     parseInt(tokens[4], 10) || 24,
      espnowSyncPeriod_s:  parseInt(tokens[5], 10) || 3600,
      satAInstalled:       parseInt(tokens[6], 10) === 1,
      satBInstalled:       parseInt(tokens[7], 10) === 1,
    };
  }

  // ========================================================================
  // CONFIG CHANGE DETECTION: Compare two config strings
  // ========================================================================
  function configChanged(cfgA, cfgB) {
    if (!cfgA || !cfgB) return false;
    return cfgA.deployMode !== cfgB.deployMode ||
           cfgA.sleepEnable !== cfgB.sleepEnable ||
           cfgA.samplePeriod_s !== cfgB.samplePeriod_s ||
           cfgA.tsBulkInterval_s !== cfgB.tsBulkInterval_s ||
           cfgA.tsBulkFreqHours !== cfgB.tsBulkFreqHours ||
           cfgA.espnowSyncPeriod_s !== cfgB.espnowSyncPeriod_s ||
           cfgA.satAInstalled !== cfgB.satAInstalled ||
           cfgA.satBInstalled !== cfgB.satBInstalled;
  }

  // ========================================================================
  // CONFIG SUMMARY: Human-readable config string for display
  // ========================================================================
  function configSummary(cfg) {
    if (!cfg) return 'No config received';
    var mode  = cfg.deployMode === 0 ? 'WiFi' : 'Cell';
    var sleep = cfg.sleepEnable ? 'Sleep ON' : 'Sleep OFF';
    var sp    = cfg.samplePeriod_s >= 3600
      ? (cfg.samplePeriod_s / 3600).toFixed(1) + 'h'
      : (cfg.samplePeriod_s / 60).toFixed(0) + 'm';
    var sats  = (cfg.satAInstalled ? 1 : 0) + (cfg.satBInstalled ? 1 : 0);
    var webSync = cfg.tsBulkFreqHours != null
      ? (cfg.tsBulkFreqHours >= 1
          ? cfg.tsBulkFreqHours.toFixed(0) + 'h'
          : (cfg.tsBulkFreqHours * 60).toFixed(0) + 'm')
      : '?';
    var satSync = cfg.espnowSyncPeriod_s != null
      ? (cfg.espnowSyncPeriod_s >= 3600
          ? (cfg.espnowSyncPeriod_s / 3600).toFixed(1) + 'h'
          : (cfg.espnowSyncPeriod_s / 60).toFixed(0) + 'm')
      : '?';
    return mode + ' | ' + sleep + ' | Sample ' + sp + ' | ' + sats + ' sat'
         + ' | Web ' + webSync + ' | Sat sync ' + satSync;
  }

  // ========================================================================
  // PUBLIC API
  // ========================================================================
  return {
    calcT0Daily:       calcT0Daily,
    calcTEDaily:       calcTEDaily,
    projectCurve:      projectCurve,
    parseField8Config: parseField8Config,
    configChanged:     configChanged,
    configSummary:     configSummary,
    HW_T0:             HW_T0,
    HW_TE:             HW_TE,
  };

})();

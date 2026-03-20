/**
 * seaweed_sync.js — Sync-window analysis functions for Seaweed Dashboard.
 *
 * Provides:  collectSyncEventTimes, parseSyncConfigFromEntry,
 *            estimateSyncPeriodMs, buildSyncPeriodTimeline,
 *            syncCfgAt, evaluateSyncWindows
 *
 * Legacy field8 helpers (parseField8ConfigUnified, parseSyncConfigFromField8)
 * are retained only as fallback for old exported datasets.
 *
 * Depends on: (none — standalone pure functions)
 *
 * Load via <script src="seaweed_sync.js"></script>  BEFORE page-specific JS.
 */

// =====================================================================
// LEGACY FIELD-8 CONFIG PARSING (fallback for old data only)
// =====================================================================

/**
 * Parse the config section of field8 ("diag|config|fw") into a config object.
 * Delegates to BatteryModel.parseField8Config when available, otherwise
 * falls back to manual CSV parsing of the config pipe-segment.
 *
 * @param {string} rawField8 - Full field8 string (e.g. "sdFree,csq,ok|deployMode,...|fwVer,buildDate").
 * @returns {Object|null} Config object or null if unparseable.
 */
function parseField8ConfigUnified(rawField8) {
  if (!rawField8 || typeof rawField8 !== 'string') return null;
  if (window.BatteryModel && typeof window.BatteryModel.parseField8Config === 'function') {
    return window.BatteryModel.parseField8Config(rawField8);
  }
  var parts = rawField8.split('|');
  if (parts.length < 2) return null;
  var tokens = parts[1].split(',');
  if (!tokens.length) return null;
  var deployMode = parseInt(tokens[0], 10);
  var samplePeriod = parseInt(tokens[1], 10);
  var sleepEnable = parseInt(tokens[1], 10);
  var legacyLayout = tokens.length >= 8;
  return {
    deployMode:        isFinite(deployMode) ? deployMode : 0,
    sleepEnable:       legacyLayout ? (sleepEnable === 1) : false,
    samplePeriod_s:    legacyLayout ? (parseInt(tokens[2], 10) || 600)
                                    : (isFinite(samplePeriod) ? samplePeriod : 600),
    tsBulkInterval_s:  legacyLayout ? (parseInt(tokens[3], 10) || 900) : 900,
    tsBulkFreqHours:   legacyLayout ? (parseInt(tokens[4], 10) || 24) : 24,
    espnowSyncPeriod_s:legacyLayout ? (parseInt(tokens[5], 10) || 3600) : 3600,
    satAInstalled:     legacyLayout ? (parseInt(tokens[6], 10) === 1) : true,
    satBInstalled:     legacyLayout ? (parseInt(tokens[7], 10) === 1) : true
  };
}

/**
 * Extract satellite sync configuration from field8.
 *
 * @param {string} rawField8
 * @returns {{ periodMs: number, satAInstalled: boolean, satBInstalled: boolean }|null}
 */
function parseSyncConfigFromField8(rawField8) {
  var cfg = parseField8ConfigUnified(rawField8);
  if (!cfg) return null;
  var periodSec = parseInt(cfg.espnowSyncPeriod_s, 10);
  if (!isFinite(periodSec) || periodSec <= 0) return null;
  periodSec = Math.max(60, Math.min(24 * 3600, periodSec));
  return {
    periodMs:       periodSec * 1000,
    satAInstalled:  !!cfg.satAInstalled,
    satBInstalled:  !!cfg.satBInstalled
  };
}

/**
 * Extract sync config from a parsed entry, preferring structured fields.
 * Falls back to legacy field8 parsing for older datasets.
 *
 * @param {Object} entry
 * @returns {{ periodMs: number, satAInstalled: boolean, satBInstalled: boolean }|null}
 */
function parseSyncConfigFromEntry(entry) {
  if (!entry || typeof entry !== 'object') return null;

  var periodSec = parseInt(entry.espnowSyncPeriod_s, 10);
  if (isFinite(periodSec) && periodSec > 0) {
    periodSec = Math.max(60, Math.min(24 * 3600, periodSec));
    var satAInstalled = (entry.satAInstalled !== null && entry.satAInstalled !== undefined)
      ? !!entry.satAInstalled
      : (entry.satASampleId != null);
    var satBInstalled = (entry.satBInstalled !== null && entry.satBInstalled !== undefined)
      ? !!entry.satBInstalled
      : (entry.satBSampleId != null);
    return {
      periodMs: periodSec * 1000,
      satAInstalled: satAInstalled,
      satBInstalled: satBInstalled
    };
  }

  return parseSyncConfigFromField8(entry._rawField8);
}

// =====================================================================
// SYNC EVENT DETECTION
// =====================================================================

/**
 * Collect timestamps of sync events from parsed entries.
 * A sync event is detected when sampleId changes, or when a non-null
 * value appears at valueKey.
 *
 * @param {Array}  entries       - Parsed entry objects with .timestamp.
 * @param {string} sampleIdKey   - Property name for sample-ID (e.g. 'satASampleId').
 * @param {string} valueKey      - Fallback property to detect activity.
 * @returns {number[]} Array of epoch-ms timestamps.
 */
function collectSyncEventTimes(entries, sampleIdKey, valueKey) {
  var times = [];
  var lastSampleId = null;
  for (var i = 0; i < entries.length; i++) {
    var entry = entries[i];
    var sid = sampleIdKey ? entry[sampleIdKey] : null;
    if (sid !== null && sid !== undefined) {
      if (lastSampleId === null || sid !== lastSampleId) {
        times.push(entry.timestamp.getTime());
        lastSampleId = sid;
      }
      continue;
    }
    if (entry[valueKey] !== null && entry[valueKey] !== undefined) {
      times.push(entry.timestamp.getTime());
    }
  }
  return times;
}

// =====================================================================
// SYNC PERIOD ESTIMATION
// =====================================================================

/**
 * Estimate the dominant sync period from observed event gaps.
 * Uses median of inter-event deltas, clamped to [45 min, 12 h].
 *
 * @param {number[]} eventTimes     - Sorted epoch-ms timestamps of sync events.
 * @param {number}   defaultPeriodMs - Fallback if not enough data.
 * @returns {number} Period in milliseconds.
 */
function estimateSyncPeriodMs(eventTimes, defaultPeriodMs) {
  if (!eventTimes || eventTimes.length < 2) return defaultPeriodMs;
  var deltas = [];
  for (var i = 1; i < eventTimes.length; i++) {
    var d = eventTimes[i] - eventTimes[i - 1];
    if (d > 0) deltas.push(d);
  }
  if (!deltas.length) return defaultPeriodMs;
  deltas.sort(function (a, b) { return a - b; });
  var median = deltas[Math.floor(deltas.length / 2)];
  if (!(median > 0)) return defaultPeriodMs;
  var minMs = 45 * 60000;
  var maxMs = 12 * 3600000;
  return Math.max(minMs, Math.min(maxMs, median));
}

// =====================================================================
// SYNC PERIOD TIMELINE (handles config changes mid-dataset)
// =====================================================================

/**
 * Build a timeline of sync-period configurations from entries.
 * Each element marks when the sync period (or satellite install flags) changed.
 *
 * @param {Array}  entries         - Parsed entry objects with ._rawField8.
 * @param {string} sampleIdKey
 * @param {string} valueKey
 * @param {number} defaultPeriodMs
 * @returns {Array<{ ts: number, periodMs: number, satAInstalled: boolean, satBInstalled: boolean }>}
 */
function buildSyncPeriodTimeline(entries, sampleIdKey, valueKey, defaultPeriodMs) {
  var eventTimes       = collectSyncEventTimes(entries, sampleIdKey, valueKey);
  // Favor explicit/default cadence over inferred cadence. Inference can be noisy
  // when fallback valueKey appears on every T0 sample row.
  var inferredPeriodMs = (defaultPeriodMs && defaultPeriodMs > 0)
    ? defaultPeriodMs
    : estimateSyncPeriodMs(eventTimes, 3 * 3600000);
  var timeline = [];
  var lastPeriod       = inferredPeriodMs;
  var lastSatAInstalled = true;
  var lastSatBInstalled = true;

  timeline.push({
    ts: entries[0].timestamp.getTime(),
    periodMs: inferredPeriodMs,
    satAInstalled: true,
    satBInstalled: true
  });

  for (var i = 0; i < entries.length; i++) {
    var syncCfg = parseSyncConfigFromEntry(entries[i]);
    if (!syncCfg) continue;
    var changed = syncCfg.periodMs !== lastPeriod ||
                  syncCfg.satAInstalled !== lastSatAInstalled ||
                  syncCfg.satBInstalled !== lastSatBInstalled;
    if (changed) {
      timeline.push({
        ts:             entries[i].timestamp.getTime(),
        periodMs:       syncCfg.periodMs,
        satAInstalled:  syncCfg.satAInstalled,
        satBInstalled:  syncCfg.satBInstalled
      });
      lastPeriod        = syncCfg.periodMs;
      lastSatAInstalled = syncCfg.satAInstalled;
      lastSatBInstalled = syncCfg.satBInstalled;
    }
  }

  return timeline;
}

/**
 * Look up the effective sync config at a given timestamp.
 *
 * @param {number} tsMs           - Epoch-ms to query.
 * @param {Array}  timeline       - Output of buildSyncPeriodTimeline().
 * @param {number} defaultPeriodMs
 * @returns {{ periodMs: number, satAInstalled: boolean, satBInstalled: boolean }}
 */
function syncCfgAt(tsMs, timeline, defaultPeriodMs) {
  var cfg = { periodMs: defaultPeriodMs, satAInstalled: true, satBInstalled: true };
  for (var i = 0; i < timeline.length; i++) {
    if (timeline[i].ts <= tsMs) {
      cfg.periodMs       = timeline[i].periodMs;
      cfg.satAInstalled  = timeline[i].satAInstalled;
      cfg.satBInstalled  = timeline[i].satBInstalled;
    } else {
      break;
    }
  }
  return cfg;
}

// =====================================================================
// SYNC WINDOW EVALUATION (slot-by-slot synced / missed analysis)
// =====================================================================

/**
 * Evaluate sync windows over a time range, reporting synced / missed / total
 * counts plus individual slot details.
 *
 * @param {Array}  entries         - Parsed entry objects.
 * @param {string} sampleIdKey     - e.g. 'satASampleId'.
 * @param {string} valueKey        - Fallback key for activity detection.
 * @param {number} startMs         - Epoch-ms start of evaluation range.
 * @param {number} endMs           - Epoch-ms end of evaluation range.
 * @param {number} defaultPeriodMs - Fallback sync period.
 * @param {string} [satInstallKey] - Optional key to check whether satellite is installed.
 * @param {number[]} [observedEventTimes] - Optional explicit epoch-ms sync events.
 * @returns {{ synced: number, missed: number, total: number, slots: Array, periodMs: number, installKey: string }}
 */
function evaluateSyncWindows(entries, sampleIdKey, valueKey, startMs, endMs, defaultPeriodMs, satInstallKey, observedEventTimes) {
  if (!entries || !entries.length || !(endMs >= startMs)) {
    return { synced: 0, missed: 0, total: 0, slots: [], periodMs: defaultPeriodMs, installKey: satInstallKey };
  }

  var eventTimes = Array.isArray(observedEventTimes) && observedEventTimes.length
    ? observedEventTimes.filter(function(ts) { return isFinite(ts); }).sort(function(a, b) { return a - b; })
    : collectSyncEventTimes(entries, sampleIdKey, valueKey);
  var periodTimeline = buildSyncPeriodTimeline(entries, sampleIdKey, valueKey, defaultPeriodMs);

  // Anchor backward walk at the latest event before endMs
  var anchor = endMs;
  for (var i = eventTimes.length - 1; i >= 0; i--) {
    if (eventTimes[i] <= endMs) { anchor = eventTimes[i]; break; }
  }

  // Generate expected slot times walking backward
  var slotTimes = [];
  var t = anchor;
  var guard = 0;
  while (t >= startMs && guard < 20000) {
    slotTimes.push(t);
    var stepMs = syncCfgAt(t, periodTimeline, defaultPeriodMs).periodMs;
    if (!(stepMs > 0)) stepMs = defaultPeriodMs;
    t -= stepMs;
    guard++;
  }
  if (!slotTimes.length) slotTimes.push(endMs);
  slotTimes.sort(function (a, b) { return a - b; });

  // Match each slot against observed events within a grace window
  var slots  = [];
  var synced = 0;
  for (var s = 0; s < slotTimes.length; s++) {
    var slotTs  = slotTimes[s];
    var slotCfg = syncCfgAt(slotTs, periodTimeline, defaultPeriodMs);
    if (satInstallKey && slotCfg[satInstallKey] === false) continue;

    var slotPeriodMs = slotCfg.periodMs;
    var graceMs = Math.min(30 * 60000, Math.max(10 * 60000, Math.round(slotPeriodMs * 0.2)));
    var minTs = slotTs - graceMs;
    var maxTs = slotTs + graceMs;

    var hit = false;
    for (var j = 0; j < eventTimes.length; j++) {
      var evTs = eventTimes[j];
      if (evTs < minTs) continue;
      if (evTs > maxTs) break;
      hit = true;
      break;
    }
    if (hit) synced++;
    slots.push({ ts: slotTs, hit: hit, periodMs: slotPeriodMs });
  }

  return {
    synced:     synced,
    missed:     slots.length - synced,
    total:      slots.length,
    slots:      slots,
    periodMs:   syncCfgAt(endMs, periodTimeline, defaultPeriodMs).periodMs,
    installKey: satInstallKey
  };
}

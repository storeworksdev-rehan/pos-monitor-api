import path from 'node:path';

const int = (value, fallback) => {
  const n = Number.parseInt(value ?? '', 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
};

const dataWindowMinutes = int(process.env.DATA_WINDOW_MINUTES, 10);

export const config = Object.freeze({
  port: int(process.env.PORT, 4000),
  host: process.env.HOST?.trim() || '0.0.0.0',
  // Browser origins allowed to read the API (the Next.js dashboard). "*" allows any.
  corsOrigins: (process.env.CORS_ORIGINS ?? 'http://localhost:3100')
    .split(',')
    .map((o) => o.trim())
    .filter(Boolean),

  apiKeys: (process.env.TELEMETRY_API_KEYS ?? '')
    .split(',')
    .map((k) => k.trim())
    .filter(Boolean),

  // ---- retention -------------------------------------------------------------
  // Routine data (metrics history, routine events) is kept only for this rolling window,
  // in memory and in MongoDB. Older data is deleted.
  dataWindowMinutes,
  dataWindowMs: dataWindowMinutes * 60_000,

  // Failures, errors and warnings are frozen into incident snapshots and kept this long.
  incidentRetentionDays: int(process.env.INCIDENT_RETENTION_DAYS, 30),
  // Triggers on the same device within this many seconds are merged into one incident.
  incidentMergeSeconds: int(process.env.INCIDENT_MERGE_SECONDS, 120),
  // Incident snapshots held in memory (MongoDB keeps all of them for the retention period).
  incidentsMax: int(process.env.INCIDENTS_MAX, 500),
  incidentTriggersMax: 50,
  incidentEventsMax: 25,

  // How often expired data is swept out of memory and offline devices are detected.
  sweepSeconds: 30,

  // ---- MongoDB (optional) ----------------------------------------------------
  mongoUri: process.env.MONGODB_URI?.trim() || '',
  mongoDb: process.env.MONGODB_DB?.trim() || 'pos_monitoring',
  spoolMaxBytes: int(process.env.SPOOL_MAX_MB, 500) * 1024 * 1024,

  // ---- local files -----------------------------------------------------------
  dataDir: path.resolve(process.env.DATA_DIR?.trim() || '.data'),
  snapshotSeconds: int(process.env.SNAPSHOT_SECONDS, 60),

  // ---- memory safety caps (the time window normally trims first) -------------
  historyPoints: int(process.env.HISTORY_POINTS, 600),
  eventsPerDevice: int(process.env.EVENTS_PER_DEVICE, 100),
  alertsMax: int(process.env.ALERTS_MAX, 300),
  dedupePerDevice: 512,

  staleSeconds: int(process.env.STALE_SECONDS, 180),
  offlineSeconds: int(process.env.OFFLINE_SECONDS, 600),

  maxBodyBytes: int(process.env.MAX_BODY_MB, 10) * 1024 * 1024,

  // ---- remote file access (POS log browsing) -----------------------------------
  // Folder on the POS that may be browsed. The agent enforces its own lock (FileAccess:RootPath);
  // this is checked again here before a request is relayed.
  fileRoot: process.env.FILE_ROOT?.trim() || String.raw`C:\XeniaRetail`,
  fileRequestTimeoutSeconds: int(process.env.FILE_REQUEST_TIMEOUT_SECONDS, 30),

  // Live updates are coalesced into one message per interval, however many batches arrive.
  broadcastMs: 1000,
  keepAliveMs: 20000,
});

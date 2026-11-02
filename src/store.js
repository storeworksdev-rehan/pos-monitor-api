import { config } from './config.js';
import { archiveStatus } from './archive.js';
import { isAgentListening } from './commands.js';
import {
  clearCondition,
  incidentStatus,
  incidentSummary,
  pruneIncidents,
  raiseCondition,
  triggerFromEvent,
} from './incidents.js';
import { RANK, isNotable } from './rules.js';

export { RANK };

/**
 * In-memory fleet state.
 *
 * Routine data is kept only for the live window (DATA_WINDOW_MINUTES, default 10):
 *   - history: metric samples per device, for charts
 *   - events:  recent events per device
 * Failures, errors and warnings outlive the window as incident snapshots (see incidents.js)
 * and in the fleet alert feed. Device identity and latest status are always kept so an
 * offline device stays visible.
 *
 * Live subscribers (Server-Sent Events) get one coalesced update per second with only what changed.
 */

// history tuple layout
export const H = { T: 0, CPU: 1, MEM: 2, DISK: 3, APP_CPU: 4, SQL_MS: 5 };

function createState() {
  return {
    booted: false,
    dirty: false,
    devices: new Map(),
    alerts: [],
    incidents: [],
    incidentIndex: new Map(),
    changedIncidents: new Set(),
    unpersistedIncidents: new Set(),
    subscribers: new Set(),
    changed: new Set(),
    pendingAlerts: [],
    flushTimer: null,
    keepAlive: null,
    stats: {
      startedAt: Date.now(),
      received: 0,
      duplicates: 0,
      rejected: 0,
      expired: 0,
      buckets: new Array(12).fill(0), // 12 x 5 s = events in the last minute
      bucketSlot: 0,
      bucketIdx: 0,
    },
  };
}

export const state = (globalThis.__posMonitorState ??= createState());

// ---------------------------------------------------------------- ingest

export function isDuplicate(ev) {
  return state.devices.get(ev.deviceId)?.seen.set.has(ev.eventId) ?? false;
}

export function applyEvents(events, receivedAt = Date.now()) {
  for (const ev of events) {
    const d = getDevice(ev.deviceId, receivedAt);
    remember(d, ev.eventId);
    if (receivedAt > d.lastSeen) d.lastSeen = receivedAt;
    if (ev.storeId) d.storeId = ev.storeId;
    if (ev.agentVersion) d.agentVersion = ev.agentVersion;
    if (ev.sequenceNumber > d.maxSequence) d.maxSequence = ev.sequenceNumber;

    if (d.offline) {
      d.offline = false;
      clearCondition(state, d, 'offline', 'Device back online', receivedAt);
    }

    const t = Date.parse(ev.timestamp) || receivedAt;
    let live = false;
    if (ev.eventType === 'metrics') live = applyMetrics(d, ev, t);
    else if (ev.eventType === 'heartbeat') live = applyHeartbeat(d, ev, t);
    else addEvent(d, ev, t);

    // Conditions are judged on live data only, not on a backlog replayed after an outage.
    if (live && receivedAt - t < config.dataWindowMs) evaluateConditions(d, t);

    state.changed.add(d.deviceId);
  }

  countReceived(events.length);
  state.dirty = true;
  scheduleBroadcast();
}

export function countRejected(n) {
  state.stats.rejected += n;
}

export function countDuplicates(n) {
  state.stats.duplicates += n;
}

function getDevice(deviceId, now) {
  let d = state.devices.get(deviceId);
  if (!d) {
    d = {
      deviceId,
      storeId: null,
      agentVersion: null,
      firstSeen: now,
      lastSeen: 0,
      maxSequence: 0,
      latestAt: 0,
      heartbeatAt: 0,
      system: null,
      application: null,
      connectivity: null,
      heartbeat: null,
      history: [],
      events: [],
      activeIssues: [],
      issueIncident: {},
      openIncidentId: null,
      offline: false,
      seen: { ids: [], set: new Set() },
    };
    state.devices.set(deviceId, d);
  }
  return d;
}

function remember(d, id) {
  d.seen.set.add(id);
  d.seen.ids.push(id);
  if (d.seen.ids.length > config.dedupePerDevice) d.seen.set.delete(d.seen.ids.shift());
}

const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : null);
const round1 = (v) => Math.round(v * 10) / 10;
const windowStart = () => Date.now() - config.dataWindowMs;

/** Returns true when this sample became the device's latest state. */
function applyMetrics(d, ev, t) {
  const s = ev.system ?? {};
  if (t >= windowStart()) {
    const sysDisk = Array.isArray(s.disks) ? s.disks.find((x) => x.isSystemDrive) : null;
    insertSorted(d.history, [
      t,
      num(s.cpuUsage),
      s.totalMemoryMB > 0 ? round1((s.usedMemoryMB * 100) / s.totalMemoryMB) : null,
      num(sysDisk?.freePercent),
      num(ev.application?.cpuUsage),
      num(ev.connectivity?.sqlResponseTimeMs),
    ], config.historyPoints);
  } else {
    state.stats.expired++; // older than the live window: nothing to keep
  }

  // After an outage the backlog arrives late and out of order; only newer data replaces "latest".
  if (t < d.latestAt) return false;
  d.latestAt = t;
  d.system = ev.system ?? null;
  d.application = ev.application ?? null;
  d.connectivity = ev.connectivity ?? null;
  return true;
}

function applyHeartbeat(d, ev, t) {
  if (t < d.heartbeatAt) return false;
  d.heartbeatAt = t;
  d.heartbeat = {
    machineName: ev.machineName ?? null,
    agentStartedAt: ev.agentStartedAt ?? null,
    agentUptimeSeconds: num(ev.agentUptimeSeconds),
    pendingEvents: num(ev.pendingEvents),
    pendingCriticalEvents: num(ev.pendingCriticalEvents),
    pendingBytes: num(ev.pendingBytes),
    oldestPendingAgeSeconds: num(ev.oldestPendingAgeSeconds),
    lastSuccessfulUploadAt: ev.lastSuccessfulUploadAt ?? null,
    consecutiveUploadFailures: num(ev.consecutiveUploadFailures),
  };
  return true;
}

function addEvent(d, ev, t) {
  const item = describe(ev, t, d);
  const notable = isNotable(ev);

  if (t >= windowStart()) insertSorted(d.events, item, config.eventsPerDevice, (e) => e.t);
  else if (!notable) state.stats.expired++;

  if (notable) {
    insertSorted(state.alerts, item, config.alertsMax, (e) => e.t);
    state.pendingAlerts.push(item);
    triggerFromEvent(state, d, item, () => captureContext(d));
  }
}

function evaluateConditions(d, t) {
  const issues = issuesOf(summarize(d));
  const current = new Set(issues.map((i) => i.code));
  const previous = new Set(d.activeIssues);

  for (const issue of issues) {
    if (!previous.has(issue.code)) raiseCondition(state, d, issue, t, () => captureContext(d));
  }
  for (const code of previous) {
    if (!current.has(code)) clearCondition(state, d, code, `${ISSUE_LABEL[code] ?? code} cleared`, t);
  }
  d.activeIssues = [...current];
}

/** Frozen copy of everything known about the device right now. */
function captureContext(d) {
  return {
    summary: summarize(d),
    system: d.system,
    application: d.application,
    connectivity: d.connectivity,
    heartbeat: d.heartbeat,
    history: d.history.slice(),
    events: d.events.slice(-config.incidentEventsMax).reverse(),
  };
}

const clip = (s, n) => (typeof s === 'string' && s.length > n ? `${s.slice(0, n)}…` : s ?? '');

function describe(ev, t, d) {
  let title = ev.eventType;
  let detail = '';
  switch (ev.eventType) {
    case 'application.state':
      title = `${ev.name ?? 'POS'} ${ev.currentState ?? 'changed'}`;
      detail = [ev.reason, ev.version && `v${ev.version}`].filter(Boolean).join(' · ');
      break;
    case 'connectivity.change': {
      const target = ev.target === 'local-sql' ? 'Local SQL' : ev.target ?? 'Connection';
      title = `${target} ${ev.connected ? 'restored' : 'lost'}`;
      detail = ev.errorCode ? `error ${ev.errorCode}` : ev.responseTimeMs != null ? `${ev.responseTimeMs} ms` : '';
      break;
    }
    case 'log': {
      const origin = [ev.provider ?? ev.file ?? ev.source ?? 'log', ev.windowsEventId && `#${ev.windowsEventId}`]
        .filter(Boolean)
        .join(' ');
      const firstLine = typeof ev.message === 'string' ? ev.message.split('\n', 1)[0].trim() : '';
      title = firstLine ? `${origin}: ${clip(firstLine, 110)}` : origin;
      detail = clip(ev.message, 800);
      break;
    }
    default:
      detail = '';
  }
  return {
    id: ev.eventId,
    t,
    type: ev.eventType,
    priority: ev.priority ?? 'normal',
    level: ev.level ?? null,
    title,
    detail,
    occurrences: ev.occurrences > 1 ? ev.occurrences : undefined,
    deviceId: d.deviceId,
    storeId: d.storeId,
  };
}

/** Keeps arr sorted by key and at most max long (drops the oldest). Usually a plain append. */
function insertSorted(arr, item, max, key = (p) => p[0]) {
  let i = arr.length;
  const k = key(item);
  while (i > 0 && key(arr[i - 1]) > k) i--;
  if (i === arr.length) arr.push(item);
  else arr.splice(i, 0, item);
  while (arr.length > max) arr.shift();
}

function countReceived(n) {
  const s = state.stats;
  rotateBuckets();
  s.buckets[s.bucketIdx] += n;
  s.received += n;
}

function rotateBuckets() {
  const s = state.stats;
  const slot = Math.floor(Date.now() / 5000);
  if (slot === s.bucketSlot) return;
  const steps = Math.min(12, slot - s.bucketSlot);
  for (let i = 0; i < steps; i++) {
    s.bucketIdx = (s.bucketIdx + 1) % 12;
    s.buckets[s.bucketIdx] = 0;
  }
  s.bucketSlot = slot;
}

// ---------------------------------------------------------------- retention sweep

/**
 * Runs every SWEEP seconds: deletes routine data older than the live window, expires old
 * incidents and alerts, and raises an "offline" incident for devices that went silent.
 */
export function sweep(now = Date.now()) {
  const cutoff = now - config.dataWindowMs;
  let pruned = 0;

  for (const d of state.devices.values()) {
    let n = 0;
    while (d.history.length && d.history[0][0] < cutoff) {
      d.history.shift();
      n++;
    }
    while (d.events.length && d.events[0].t < cutoff) {
      d.events.shift();
      n++;
    }
    if (n) {
      pruned += n;
      state.changed.add(d.deviceId);
    }

    if (!d.offline && d.lastSeen && now - d.lastSeen > config.offlineSeconds * 1000) {
      d.offline = true;
      raiseCondition(
        state,
        d,
        { code: 'offline', level: 'critical', text: 'Device offline' },
        now,
        () => captureContext(d),
        `No data since ${new Date(d.lastSeen).toISOString()}`,
      );
      state.changed.add(d.deviceId);
    }
  }

  const alertCutoff = now - config.incidentRetentionDays * 86_400_000;
  while (state.alerts.length && state.alerts[0].t < alertCutoff) state.alerts.shift();
  const expiredIncidents = pruneIncidents(state, now);

  state.stats.expired += pruned;
  if (pruned || expiredIncidents || state.changedIncidents.size) {
    state.dirty = true;
    scheduleBroadcast();
  }
}

// ---------------------------------------------------------------- read models

const ISSUE_LABEL = {
  'pos-down': 'POS not running',
  'pos-hung': 'POS not responding',
  'sql-down': 'SQL unreachable',
  'cpu-high': 'High CPU',
  'mem-high': 'High memory',
  'disk-low': 'Low disk',
  backlog: 'Upload backlog',
  'upload-failing': 'Upload failures',
  offline: 'Device offline',
};

export function summarize(d) {
  const s = d.system;
  const a = d.application;
  const c = d.connectivity;
  const h = d.heartbeat;
  const sysDisk = Array.isArray(s?.disks) ? s.disks.find((x) => x.isSystemDrive) : null;
  const memPct = s?.totalMemoryMB > 0 ? round1((s.usedMemoryMB * 100) / s.totalMemoryMB) : null;

  const summary = {
    deviceId: d.deviceId,
    storeId: d.storeId,
    agentVersion: d.agentVersion,
    lastSeen: d.lastSeen,
    latestAt: d.latestAt || null,
    os: s?.os ?? null,
    cpu: num(s?.cpuUsage),
    memPct,
    memUsedMB: num(s?.usedMemoryMB),
    memTotalMB: num(s?.totalMemoryMB),
    diskFreeGB: num(s?.diskFreeGB),
    diskFreePct: num(sysDisk?.freePercent),
    uptimeSeconds: num(s?.uptimeSeconds),
    app: a
      ? { name: a.name, version: a.version ?? null, running: Boolean(a.processRunning), responding: a.responding ?? null }
      : null,
    sql: c && c.localSqlConnected != null ? { connected: c.localSqlConnected, ms: num(c.sqlResponseTimeMs) } : null,
    api: c && c.centralApiConnected != null ? { connected: c.centralApiConnected, ms: num(c.apiResponseTimeMs) } : null,
    queue: h
      ? {
          pending: h.pendingEvents ?? 0,
          critical: h.pendingCriticalEvents ?? 0,
          oldestAge: h.oldestPendingAgeSeconds,
          failures: h.consecutiveUploadFailures ?? 0,
        }
      : null,
    spark: d.history.slice(-40).map((p) => p[H.CPU] ?? 0),
    lastAlert: lastAlert(d),
    openIncident: openIncidentOf(d),
    fileAccess: isAgentListening(d.deviceId),
  };
  summary.issues = issuesOf(summary);
  return summary;
}

function lastAlert(d) {
  for (let i = d.events.length - 1; i >= 0; i--) {
    const e = d.events[i];
    if ((RANK[e.priority] ?? 1) >= RANK.high) return { title: e.title, t: e.t, priority: e.priority };
  }
  return null;
}

function openIncidentOf(d) {
  const inc = d.openIncidentId ? state.incidentIndex.get(d.openIncidentId) : null;
  return inc && incidentStatus(inc) === 'active' ? { id: inc.id, title: inc.title, severity: inc.severity } : null;
}

function issuesOf(s) {
  const out = [];
  const add = (code, level, text) => out.push({ code, level, text });
  if (s.app && !s.app.running) add('pos-down', 'critical', 'POS not running');
  if (s.app?.responding === false) add('pos-hung', 'critical', 'POS not responding');
  if (s.sql && !s.sql.connected) add('sql-down', 'critical', 'SQL unreachable');
  if (s.cpu != null && s.cpu >= 90) add('cpu-high', 'warning', `CPU ${Math.round(s.cpu)}%`);
  if (s.memPct != null && s.memPct >= 92) add('mem-high', 'warning', `Memory ${Math.round(s.memPct)}%`);
  if (s.diskFreePct != null && s.diskFreePct < 10) add('disk-low', 'warning', `Disk ${s.diskFreeGB ?? '?'} GB free`);
  if (s.queue && (s.queue.pending > 500 || (s.queue.oldestAge ?? 0) > 900)) add('backlog', 'warning', `Backlog ${s.queue.pending}`);
  if (s.queue && s.queue.failures >= 3) add('upload-failing', 'warning', 'Upload failing');
  return out;
}

export function deviceDetail(deviceId) {
  const d = state.devices.get(deviceId);
  if (!d) return null;
  return {
    summary: summarize(d),
    firstSeen: d.firstSeen,
    maxSequence: d.maxSequence,
    system: d.system,
    application: d.application,
    connectivity: d.connectivity,
    heartbeat: d.heartbeat,
    history: d.history,
    events: d.events.slice().reverse(),
    incidents: listIncidents({ deviceId, limit: 20 }),
    windowMinutes: config.dataWindowMinutes,
  };
}

export function listAlerts({ deviceId, priority, limit = 100 } = {}) {
  const out = [];
  for (let i = state.alerts.length - 1; i >= 0 && out.length < limit; i--) {
    const a = state.alerts[i];
    if (deviceId && a.deviceId !== deviceId) continue;
    if (priority && a.priority !== priority) continue;
    out.push(a);
  }
  return out;
}

export function listIncidents({ deviceId, severity, status, limit = 100 } = {}) {
  const out = [];
  for (let i = state.incidents.length - 1; i >= 0 && out.length < limit; i--) {
    const inc = state.incidents[i];
    if (deviceId && inc.deviceId !== deviceId) continue;
    if (severity && inc.severity !== severity) continue;
    if (status && incidentStatus(inc) !== status) continue;
    out.push(incidentSummary(inc));
  }
  return out.sort((a, b) => b.updatedAt - a.updatedAt);
}

export function getIncident(id) {
  const inc = state.incidentIndex.get(id);
  return inc ? { ...inc, status: incidentStatus(inc) } : null;
}

export function publicStats() {
  rotateBuckets();
  const s = state.stats;
  return {
    devices: state.devices.size,
    received: s.received,
    duplicates: s.duplicates,
    rejected: s.rejected,
    expired: s.expired,
    incidents: state.incidents.length,
    eventsPerMinute: s.buckets.reduce((x, y) => x + y, 0),
    viewers: state.subscribers.size,
    uptimeSeconds: Math.round((Date.now() - s.startedAt) / 1000),
    memoryMB: Math.round(process.memoryUsage().rss / 1048576),
    windowMinutes: config.dataWindowMinutes,
    incidentRetentionDays: config.incidentRetentionDays,
    fileRoot: config.fileRoot,
    storage: archiveStatus(),
  };
}

export function snapshotPayload() {
  return {
    devices: [...state.devices.values()].map(summarize),
    alerts: listAlerts({ limit: 80 }),
    incidents: listIncidents({ limit: 80 }),
    stats: publicStats(),
    thresholds: { stale: config.staleSeconds, offline: config.offlineSeconds },
  };
}

// ---------------------------------------------------------------- live stream (SSE)

export function subscribe(send) {
  state.subscribers.add(send);
  state.keepAlive ??= setInterval(() => {
    if (state.subscribers.size === 0) return;
    broadcast(`event: stats\ndata: ${JSON.stringify(publicStats())}\n\n`);
  }, config.keepAliveMs);
  state.keepAlive.unref?.();
  return send;
}

export function unsubscribe(send) {
  state.subscribers.delete(send);
}

function scheduleBroadcast() {
  if (state.subscribers.size === 0) {
    // Nobody is watching: skip all summarizing work.
    state.changed.clear();
    state.changedIncidents.clear();
    state.pendingAlerts.length = 0;
    return;
  }
  state.flushTimer ??= setTimeout(flush, config.broadcastMs);
}

function flush() {
  state.flushTimer = null;
  const devices = [];
  for (const id of state.changed) {
    const d = state.devices.get(id);
    if (d) devices.push(summarize(d));
  }
  state.changed.clear();

  const incidents = [];
  for (const id of state.changedIncidents) {
    const inc = state.incidentIndex.get(id);
    if (inc) incidents.push(incidentSummary(inc));
  }
  state.changedIncidents.clear();

  const alerts = state.pendingAlerts.splice(0).slice(-50);
  broadcast(`event: update\ndata: ${JSON.stringify({ devices, alerts, incidents, stats: publicStats() })}\n\n`);
}

function broadcast(message) {
  for (const send of state.subscribers) send(message);
}

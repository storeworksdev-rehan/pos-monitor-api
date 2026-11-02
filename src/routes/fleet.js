import express from 'express';
import { archiveEnabled, findIncident, queryArchive, queryIncidents } from '../archive.js';
import { resolveUnderRoot, sendCommand } from '../commands.js';
import { incidentStatus } from '../incidents.js';
import {
  deviceDetail,
  getIncident,
  listAlerts,
  listIncidents,
  snapshotPayload,
  state,
  subscribe,
  summarize,
  unsubscribe,
} from '../store.js';

const router = express.Router();
const limitOf = (q, max = 500) => Math.min(Number(q.limit) || 100, max);

/** GET /api/snapshot - everything the dashboard needs on first load. */
router.get('/snapshot', (req, res) => {
  res.json(snapshotPayload());
});

/**
 * GET /api/stream - Server-Sent Events for the live dashboard.
 *   event: snapshot  full fleet state on connect
 *   event: update    changed devices, new alerts and incidents, at most once per second
 *   event: stats     ingest counters every 20 s (also keeps proxies from closing the stream)
 */
router.get('/stream', (req, res) => {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  res.write(`retry: 3000\nevent: snapshot\ndata: ${JSON.stringify(snapshotPayload())}\n\n`);

  const send = subscribe((message) => {
    if (!res.writableEnded) res.write(message);
  });
  req.on('close', () => unsubscribe(send));
});

/** GET /api/devices?storeId= - live summary of every device. */
router.get('/devices', (req, res) => {
  const { storeId } = req.query;
  const devices = [];
  for (const d of state.devices.values()) {
    if (!storeId || d.storeId === storeId) devices.push(summarize(d));
  }
  res.json({ devices });
});

/** GET /api/devices/:deviceId - latest metrics, live-window history and events, incidents. */
router.get('/devices/:deviceId', (req, res) => {
  const detail = deviceDetail(req.params.deviceId);
  if (!detail) return res.status(404).json({ error: 'Unknown device' });
  res.json(detail);
});

const AGENT_ERROR_STATUS = { 'not-found': 404, denied: 403, disabled: 403, unsupported: 415, 'io-error': 502 };

/**
 * GET /api/devices/:deviceId/files?path=C:\XeniaRetail\Logs\BackOffice[&recursive=true]
 *   path is a folder -> { kind: "directory", entries: [{ name, path, type, size, modified, readable }] }
 *   path is a file   -> { kind: "file", content, size, offset, length, hasMoreBefore, hasMoreAfter, ... }
 *                       (large files: last 1 MB by default; &offset=N pages, &tail=false starts at the top)
 *   neither          -> 404
 * Only paths under FILE_ROOT (default C:\XeniaRetail\Logs) are accepted; the agent enforces the same lock.
 */
router.get('/devices/:deviceId/files', async (req, res) => {
  const { deviceId } = req.params;
  if (!state.devices.has(deviceId)) return res.status(404).json({ error: 'Unknown device', code: 'unknown-device' });

  const target = resolveUnderRoot(req.query.path);
  if (!target.ok) return res.status(403).json({ error: target.error, code: 'denied' });

  const offset = req.query.offset != null && req.query.offset !== '' ? Number(req.query.offset) : undefined;
  const args = {
    path: target.path,
    recursive: req.query.recursive === 'true',
    tail: req.query.tail !== 'false',
    ...(Number.isFinite(offset) && offset >= 0 ? { offset } : {}),
  };

  try {
    const reply = await sendCommand(deviceId, 'files.browse', args);
    if (reply?.ok) return res.json({ deviceId, ...reply.result });
    const code = reply?.error?.code ?? 'agent-error';
    return res.status(AGENT_ERROR_STATUS[code] ?? 502).json({ error: reply?.error?.message ?? 'The agent could not complete the request.', code });
  } catch (err) {
    const status = err.status ?? 500;
    return res.status(status).json({ error: err.message, code: status === 503 ? 'agent-offline' : status === 504 ? 'timeout' : 'error' });
  }
});

/**
 * GET /api/events?deviceId=&priority=&limit=                   recent failures/errors/warnings (memory)
 * GET /api/events?source=archive&deviceId=&eventType=&before=   MongoDB, when configured
 */
router.get('/events', async (req, res) => {
  const q = req.query;
  if (q.source === 'archive') {
    if (!archiveEnabled()) return res.status(404).json({ error: 'MongoDB archive is not configured' });
    try {
      const events = await queryArchive({
        deviceId: q.deviceId || undefined,
        eventType: q.eventType || undefined,
        priority: q.priority || undefined,
        before: q.before || undefined,
        limit: limitOf(q),
      });
      return res.json({ source: 'archive', events });
    } catch (err) {
      return res.status(503).json({ error: `Archive unavailable: ${err.message}` });
    }
  }
  res.json({
    source: 'memory',
    events: listAlerts({ deviceId: q.deviceId || undefined, priority: q.priority || undefined, limit: limitOf(q) }),
  });
});

/**
 * GET /api/incidents?deviceId=&severity=&status=&limit=        incident snapshots in memory
 * GET /api/incidents?source=archive&deviceId=&severity=&before= MongoDB, when configured
 */
router.get('/incidents', async (req, res) => {
  const q = req.query;
  const filter = { deviceId: q.deviceId || undefined, severity: q.severity || undefined };
  if (q.source === 'archive') {
    if (!archiveEnabled()) return res.status(404).json({ error: 'MongoDB archive is not configured' });
    try {
      const incidents = await queryIncidents({ ...filter, before: q.before || undefined, limit: limitOf(q) });
      return res.json({ source: 'archive', incidents });
    } catch (err) {
      return res.status(503).json({ error: `Archive unavailable: ${err.message}` });
    }
  }
  res.json({ source: 'memory', incidents: listIncidents({ ...filter, status: q.status || undefined, limit: limitOf(q) }) });
});

/** GET /api/incidents/:id - full snapshot: triggers plus the device state frozen at the time. */
router.get('/incidents/:id', async (req, res) => {
  const incident = getIncident(req.params.id);
  if (incident) return res.json(incident);

  // No longer in memory: try MongoDB.
  if (archiveEnabled()) {
    try {
      const archived = await findIncident(req.params.id);
      if (archived) {
        const toMs = (v) => (v ? new Date(v).getTime() : null);
        const inc = { ...archived, openedAt: toMs(archived.openedAt), updatedAt: toMs(archived.updatedAt), resolvedAt: toMs(archived.resolvedAt) };
        return res.json({ ...inc, status: incidentStatus(inc) });
      }
    } catch {
      // fall through to 404
    }
  }
  res.status(404).json({ error: 'Unknown incident' });
});

export default router;

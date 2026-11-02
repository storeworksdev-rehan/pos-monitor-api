import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import { config } from './config.js';
import { isNotable } from './rules.js';
import { fingerprint, signatureOf } from './dedupe.js';

/**
 * Optional MongoDB archive.
 *
 * - No MONGODB_URI: disabled; the driver is never even loaded.
 * - events: routine events are inserted with _id = eventId, so resends are ignored. Failures, errors
 *   and warnings are folded: one document per device and error signature (see dedupe.js), whose
 *   `occurrences` count, latest fields and `ts` are updated on every repeat. Each document gets an
 *   expiresAt and a TTL index deletes it: routine data after DATA_WINDOW_MINUTES,
 *   failures/errors/warnings after INCIDENT_RETENTION_DAYS.
 * - incidents: incident snapshots, upserted, expiring INCIDENT_RETENTION_DAYS after their last update.
 * - MongoDB unreachable: events are appended to a local spool file and replayed when it returns.
 *   The live dashboard keeps working throughout. Only a full spool makes the API answer 503,
 *   which tells the agents to keep the data in their own queues and retry later.
 */
const a = (globalThis.__posArchive ??= {
  db: null,
  connecting: null,
  state: config.mongoUri ? 'connecting' : 'disabled',
  lastError: null,
  lastFailureAt: 0,
  spoolBytes: 0,
  spoolChain: Promise.resolve(),
  draining: false,
  started: false,
});

const RETRY_AFTER_FAILURE_MS = 15000;
const DRAIN_INTERVAL_MS = 15000;
const DRAIN_CHUNK = 500;

const spoolFile = () => path.join(config.dataDir, 'spool.jsonl');

export const archiveEnabled = () => Boolean(config.mongoUri);

export function archiveStatus() {
  return {
    mode: config.mongoUri ? 'mongodb' : 'memory',
    state: a.state,
    spoolBytes: a.spoolBytes,
    lastError: a.state === 'connected' ? null : a.lastError,
  };
}

export function startArchive() {
  if (!config.mongoUri || a.started) return;
  a.started = true;
  try {
    a.spoolBytes = fs.statSync(spoolFile()).size;
  } catch {
    a.spoolBytes = 0;
  }
  getDb().catch(() => {});
  setInterval(() => drainSpool().catch(() => {}), DRAIN_INTERVAL_MS).unref?.();
}

/** Stores events durably (MongoDB or spool). Throws only when neither is possible. */
export async function persist(events, receivedAt) {
  if (!config.mongoUri || events.length === 0) return;

  // Routine data that is already outside the live window would be deleted at once: skip it.
  events = events.filter((ev) => expiresAt(ev, receivedAt) > Date.now());
  if (events.length === 0) return;

  // While MongoDB is known to be down, do not make every agent wait for a connection timeout.
  if (a.state !== 'connected' && Date.now() - a.lastFailureAt < RETRY_AFTER_FAILURE_MS) {
    return spool(events, receivedAt);
  }

  try {
    await insertDocs(events.map((ev) => toDoc(ev, receivedAt)));
  } catch (err) {
    markFailure(err);
    await spool(events, receivedAt);
  }
}

export async function queryArchive({ deviceId, eventType, priority, limit = 100, before }) {
  const db = await getDb();
  const filter = {};
  if (deviceId) filter.deviceId = deviceId;
  if (eventType) filter.eventType = eventType;
  if (priority) filter.priority = priority;
  if (before) filter.ts = { $lt: new Date(before) };
  return db
    .collection('events')
    .find(filter, { projection: { _id: 0 } })
    .sort({ ts: -1 })
    .limit(Math.min(Math.max(1, limit), 500))
    .toArray();
}

async function getDb() {
  if (a.db) return a.db;
  a.connecting ??= (async () => {
    const { MongoClient } = await import('mongodb');
    const client = new MongoClient(config.mongoUri, {
      appName: 'pos-monitoring-central',
      serverSelectionTimeoutMS: 3000,
      maxPoolSize: 5,
      minPoolSize: 0,
    });
    try {
      await client.connect();
      const db = client.db(config.mongoDb);
      const events = db.collection('events');
      const incidents = db.collection('incidents');
      // Replaced by the expiresAt TTL index (older versions expired on receivedAt).
      await events.dropIndex('receivedAt_1').catch(() => {});
      await Promise.all([
        events.createIndex({ expiresAt: 1 }, { expireAfterSeconds: 0 }),
        events.createIndex({ deviceId: 1, ts: -1 }),
        events.createIndex({ eventType: 1, priority: 1, ts: -1 }),
        incidents.createIndex({ expiresAt: 1 }, { expireAfterSeconds: 0 }),
        incidents.createIndex({ deviceId: 1, updatedAt: -1 }),
        incidents.createIndex({ updatedAt: -1 }),
      ]);
      a.db = db;
      a.state = 'connected';
      a.lastError = null;
      console.info(`[archive] connected to MongoDB database "${config.mongoDb}"`);
      drainSpool().catch(() => {});
      return db;
    } catch (err) {
      await client.close().catch(() => {});
      throw err;
    }
  })().catch((err) => {
    a.connecting = null;
    markFailure(err);
    throw err;
  });
  return a.connecting;
}

async function insertDocs(docs) {
  if (docs.length === 0) return;
  const db = await getDb();
  try {
    await db.collection('events').bulkWrite(docs.map((doc) => (doc.sig ? foldOp(doc) : { insertOne: { document: doc } })), {
      ordered: false,
    });
  } catch (err) {
    if (!isOnlyDuplicates(err)) throw err;
  }
  if (a.state !== 'connected') console.info('[archive] MongoDB available again');
  a.state = 'connected';
  a.lastError = null;
}

function expiresAt(ev, receivedAt) {
  if (isNotable(ev)) return receivedAt + config.incidentRetentionDays * 86_400_000;
  return (Date.parse(ev.timestamp) || receivedAt) + config.dataWindowMs;
}

function toDoc(ev, receivedAt) {
  return {
    _id: ev.eventId,
    ...ev,
    ts: new Date(Date.parse(ev.timestamp) || receivedAt),
    receivedAt: new Date(receivedAt),
    expiresAt: new Date(expiresAt(ev, receivedAt)),
    ...(isNotable(ev) ? { sig: signatureOf(ev) } : {}),
  };
}

/** Upsert that adds a repeat of an error to its existing document instead of storing a new one. */
function foldOp(doc) {
  const { _id, occurrences, eventId, ts, expiresAt: expires, ...latest } = doc;
  return {
    updateOne: {
      filter: { _id: fingerprint(doc.deviceId, doc.sig) },
      update: {
        $setOnInsert: { firstTs: ts, firstEventId: eventId },
        $set: { ...latest, eventId },
        $max: { ts, expiresAt: expires },
        $inc: { occurrences: occurrences > 1 ? occurrences : 1 },
      },
      upsert: true,
    },
  };
}

/** Upserts incident snapshots. Throws if MongoDB is unavailable (the caller retries later). */
export async function saveIncidents(incidents) {
  if (!config.mongoUri || incidents.length === 0) return;
  const db = await getDb();
  await db.collection('incidents').bulkWrite(
    incidents.map((inc) => ({
      replaceOne: {
        filter: { _id: inc.id },
        replacement: {
          ...inc,
          _id: inc.id,
          openedAt: new Date(inc.openedAt),
          updatedAt: new Date(inc.updatedAt),
          resolvedAt: inc.resolvedAt ? new Date(inc.resolvedAt) : null,
          expiresAt: new Date(inc.updatedAt + config.incidentRetentionDays * 86_400_000),
        },
        upsert: true,
      },
    })),
    { ordered: false },
  );
}

export async function queryIncidents({ deviceId, severity, limit = 100, before }) {
  const db = await getDb();
  const filter = {};
  if (deviceId) filter.deviceId = deviceId;
  if (severity) filter.severity = severity;
  if (before) filter.updatedAt = { $lt: new Date(before) };
  return db
    .collection('incidents')
    .find(filter, { projection: { _id: 0, context: 0, triggers: 0 } })
    .sort({ updatedAt: -1 })
    .limit(Math.min(Math.max(1, limit), 500))
    .toArray();
}

export async function findIncident(id) {
  const db = await getDb();
  return db.collection('incidents').findOne({ _id: id }, { projection: { _id: 0 } });
}

function isOnlyDuplicates(err) {
  if (err?.code === 11000) return true;
  const writeErrors = err?.writeErrors;
  const list = Array.isArray(writeErrors) ? writeErrors : writeErrors ? [writeErrors] : [];
  return list.length > 0 && list.every((e) => (e.code ?? e.err?.code) === 11000);
}

function markFailure(err) {
  if (a.state !== 'unavailable') console.warn(`[archive] MongoDB unavailable, spooling to disk: ${err?.message}`);
  a.state = 'unavailable';
  a.lastError = err?.message ?? String(err);
  a.lastFailureAt = Date.now();
}

/** Appends are serialized so concurrent requests never interleave lines. */
function spool(events, receivedAt) {
  const run = async () => {
    if (a.spoolBytes >= config.spoolMaxBytes) {
      const error = new Error('Archive spool is full');
      error.status = 503;
      throw error;
    }
    const text = events.map((ev) => JSON.stringify({ r: receivedAt, ev })).join('\n') + '\n';
    await fs.promises.mkdir(config.dataDir, { recursive: true });
    await fs.promises.appendFile(spoolFile(), text);
    a.spoolBytes += Buffer.byteLength(text);
  };
  const result = a.spoolChain.then(run, run);
  a.spoolChain = result.catch(() => {});
  return result;
}

async function drainSpool() {
  if (a.draining || !config.mongoUri) return;
  a.draining = true;
  try {
    await getDb();

    // Move the live spool aside (inside the append chain) so new appends go to a fresh file.
    await (a.spoolChain = a.spoolChain.then(async () => {
      try {
        await fs.promises.rename(spoolFile(), path.join(config.dataDir, `spool-${Date.now()}.draining.jsonl`));
        a.spoolBytes = 0;
      } catch (err) {
        if (err.code !== 'ENOENT') throw err;
      }
    }).catch(() => {}));

    const files = (await fs.promises.readdir(config.dataDir).catch(() => []))
      .filter((f) => f.endsWith('.draining.jsonl'))
      .sort();

    for (const name of files) {
      const file = path.join(config.dataDir, name);
      let batch = [];
      let total = 0;
      const lines = readline.createInterface({ input: fs.createReadStream(file), crlfDelay: Infinity });
      for await (const line of lines) {
        if (!line) continue;
        try {
          const { r, ev } = JSON.parse(line);
          if (expiresAt(ev, r) <= Date.now()) continue; // already outside its retention
          batch.push(toDoc(ev, r));
        } catch {
          continue; // a torn last line after a crash
        }
        if (batch.length >= DRAIN_CHUNK) {
          await insertDocs(batch);
          total += batch.length;
          batch = [];
        }
      }
      await insertDocs(batch);
      total += batch.length;
      await fs.promises.unlink(file);
      console.info(`[archive] replayed ${total} spooled event(s) into MongoDB`);
    }
  } catch (err) {
    markFailure(err);
  } finally {
    a.draining = false;
  }
}

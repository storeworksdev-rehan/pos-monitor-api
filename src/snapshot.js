import fs from 'node:fs';
import path from 'node:path';
import { config } from './config.js';

/**
 * Persists the in-memory state to DATA_DIR/state.json so a restart (or running with no
 * database at all) keeps device status, the live window, incident snapshots and the dedupe
 * window. Written atomically: temp file, then rename.
 */
const file = () => path.join(config.dataDir, 'state.json');
const VERSION = 2;

export function loadSnapshot(state) {
  let raw;
  try {
    raw = fs.readFileSync(file(), 'utf8');
  } catch (err) {
    if (err.code !== 'ENOENT') console.warn(`[snapshot] could not read ${file()}: ${err.message}`);
    return;
  }

  try {
    const data = JSON.parse(raw);
    if (data.version !== VERSION) {
      console.info(`[snapshot] ignoring snapshot format v${data.version}; starting fresh`);
      return;
    }
    for (const d of data.devices ?? []) {
      const ids = Array.isArray(d.seenIds) ? d.seenIds : [];
      delete d.seenIds;
      d.seen = { ids, set: new Set(ids) };
      d.activeIssues ??= [];
      d.issueIncident ??= {};
      state.devices.set(d.deviceId, d);
    }
    state.alerts = Array.isArray(data.alerts) ? data.alerts : [];
    state.incidents = Array.isArray(data.incidents) ? data.incidents : [];
    state.incidentIndex = new Map(state.incidents.map((i) => [i.id, i]));
    console.info(`[snapshot] restored ${state.devices.size} device(s) and ${state.incidents.length} incident(s) from ${file()}`);
  } catch (err) {
    console.warn(`[snapshot] ignoring unreadable snapshot: ${err.message}`);
  }
}

// Event ids saved per device: enough to recognize a resent upload (the agent sends at most 200
// events per batch) without making the file huge. Memory keeps more (config.dedupePerDevice).
const SAVED_IDS = 200;
// Serialize this many devices or incidents, then let requests run, so a save never stalls the API.
const CHUNK = 100;

const toSaved = ({ seen, ...rest }) => ({ ...rest, seenIds: seen.ids.slice(-SAVED_IDS) });

/** Synchronous save, for shutdown only. */
export function saveSnapshot(state, { force = false } = {}) {
  if (!state.dirty && !force) return;
  state.dirty = false;
  const json = JSON.stringify({
    version: VERSION,
    savedAt: Date.now(),
    devices: [...state.devices.values()].map(toSaved),
    alerts: state.alerts,
    incidents: state.incidents,
  });
  fs.mkdirSync(config.dataDir, { recursive: true });
  const tmp = `${file()}.tmp`;
  fs.writeFileSync(tmp, json);
  fs.renameSync(tmp, file());
}

let saving = false;

/**
 * Routine save. Serializes in chunks and yields between them, then writes asynchronously,
 * so uploads and dashboards keep being served while a large fleet is saved.
 */
export async function saveSnapshotAsync(state) {
  if (saving || !state.dirty) return;
  saving = true;
  state.dirty = false;
  try {
    const devices = [...state.devices.values()];
    const incidents = state.incidents.slice();
    const parts = [`{"version":${VERSION},"savedAt":${Date.now()},"devices":[`];
    for (let i = 0; i < devices.length; i++) {
      parts.push(`${i ? ',' : ''}${JSON.stringify(toSaved(devices[i]))}`);
      if (i % CHUNK === CHUNK - 1) await yieldToRequests();
    }
    parts.push(`],"alerts":${JSON.stringify(state.alerts)},"incidents":[`);
    for (let i = 0; i < incidents.length; i++) {
      parts.push(`${i ? ',' : ''}${JSON.stringify(incidents[i])}`);
      if (i % CHUNK === CHUNK - 1) await yieldToRequests();
    }
    parts.push(']}');

    await fs.promises.mkdir(config.dataDir, { recursive: true });
    const tmp = `${file()}.tmp`;
    await fs.promises.writeFile(tmp, parts.join(''));
    await fs.promises.rename(tmp, file());
  } catch (err) {
    state.dirty = true; // try again next time
    throw err;
  } finally {
    saving = false;
  }
}

const yieldToRequests = () => new Promise((resolve) => setImmediate(resolve));

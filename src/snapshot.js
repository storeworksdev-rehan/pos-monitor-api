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

export function saveSnapshot(state, { force = false } = {}) {
  if (!state.dirty && !force) return;
  state.dirty = false;
  const devices = [];
  for (const { seen, ...rest } of state.devices.values()) devices.push({ ...rest, seenIds: seen.ids });
  const json = JSON.stringify({
    version: VERSION,
    savedAt: Date.now(),
    devices,
    alerts: state.alerts,
    incidents: state.incidents,
  });
  fs.mkdirSync(config.dataDir, { recursive: true });
  const tmp = `${file()}.tmp`;
  fs.writeFileSync(tmp, json);
  fs.renameSync(tmp, file());
}

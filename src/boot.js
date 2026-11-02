import { config } from './config.js';
import { archiveEnabled, saveIncidents, startArchive } from './archive.js';
import { loadSnapshot, saveSnapshot } from './snapshot.js';
import { state, sweep } from './store.js';

/** Idempotent one-time startup: restore snapshot, start background timers. */
export function ensureBooted() {
  if (state.booted) return;
  state.booted = true;

  loadSnapshot(state);

  const safely = (name, fn) => async () => {
    try {
      await fn();
    } catch (err) {
      console.warn(`[${name}] ${err.message}`);
    }
  };

  // Delete routine data older than the live window; detect devices that went offline.
  const runSweep = safely('sweep', () => sweep());
  runSweep();
  setInterval(runSweep, config.sweepSeconds * 1000).unref?.();

  const save = safely('snapshot', () => {
    state.urgentSave = false;
    saveSnapshot(state);
  });
  setInterval(save, config.snapshotSeconds * 1000).unref?.();
  // New or changed incident snapshots reach disk within 5 s.
  setInterval(() => state.urgentSave && save(), 5000).unref?.();

  // Incident snapshots go to MongoDB as well when configured; failed writes are retried.
  if (archiveEnabled()) {
    setInterval(
      safely('incidents', async () => {
        if (state.unpersistedIncidents.size === 0) return;
        const ids = [...state.unpersistedIncidents];
        const incidents = ids.map((id) => state.incidentIndex.get(id)).filter(Boolean);
        await saveIncidents(incidents);
        for (const id of ids) state.unpersistedIncidents.delete(id);
      }),
      3000,
    ).unref?.();
  }

  const saveAndExit = () => {
    try {
      saveSnapshot(state, { force: true });
    } catch {
      // best effort
    }
    process.exit(0);
  };
  process.once('SIGINT', saveAndExit);
  process.once('SIGTERM', saveAndExit);

  if (config.apiKeys.length === 0) {
    console.warn('[auth] TELEMETRY_API_KEYS is empty: any agent can post telemetry (development mode)');
  }
  if (config.adminApiKeys.length === 0) {
    console.warn('[auth] ADMIN_API_KEYS is empty: anyone who can reach the API can remove stores and devices (development mode)');
  }
  console.info(
    `[boot] storage: ${config.mongoUri ? `MongoDB (${config.mongoDb}) + live memory` : 'live memory + snapshot (no database)'}; ` +
      `live window ${config.dataWindowMinutes} min; incident snapshots kept ${config.incidentRetentionDays} days`,
  );
  startArchive();
}

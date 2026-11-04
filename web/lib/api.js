/**
 * Where the Express API lives.
 *   NEXT_PUBLIC_API_URL  used by the browser (live stream, drawers). Baked in at build time.
 *   API_URL              optional server-side override for the first render (e.g. an internal hostname).
 */
export const API_URL = (
  process.env.NEXT_PUBLIC_API_URL ||
  "https://pos-monitor-api-dzeacbc9fra5asa8.southcentralus-01.azurewebsites.net"
).replace(/\/$/, "");

export const apiUrl = (path) => `${API_URL}${path}`;

/** Shown while the API cannot be reached; the live stream keeps retrying. */
export const EMPTY_SNAPSHOT = {
  apiDown: true,
  devices: [],
  alerts: [],
  incidents: [],
  thresholds: { stale: 180, offline: 600 },
  stats: {
    devices: 0,
    eventsPerMinute: 0,
    memoryMB: 0,
    windowMinutes: 10,
    incidentRetentionDays: 30,
    storage: {
      mode: "unknown",
      state: "unknown",
      spoolBytes: 0,
      lastError: null,
    },
  },
};

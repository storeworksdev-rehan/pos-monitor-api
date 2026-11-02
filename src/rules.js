export const RANK = { low: 0, normal: 1, high: 2, critical: 3 };

const NOTABLE_LEVELS = new Set(['critical', 'error', 'warning']);
const ROUTINE_TYPES = new Set(['metrics', 'heartbeat']);

/**
 * A failure, error or warning worth keeping beyond the live data window:
 * high/critical priority, or a log entry at warning level or worse.
 * Metrics and heartbeats are never notable themselves (conditions derived from them are).
 */
export function isNotable(ev) {
  if (ROUTINE_TYPES.has(ev.eventType)) return false;
  if ((RANK[ev.priority] ?? 1) >= RANK.high) return true;
  return NOTABLE_LEVELS.has(String(ev.level ?? '').toLowerCase());
}

import { randomUUID } from 'node:crypto';
import { config } from './config.js';

/**
 * Incident snapshots.
 *
 * Routine data only lives for DATA_WINDOW_MINUTES. When something goes wrong
 * (an error/warning event, or a newly detected condition such as "POS not running"),
 * the device's state at that moment is frozen into an incident snapshot:
 * latest metrics, POS/SQL status, queue state, plus the chart history and events
 * of the live window. Snapshots are kept for INCIDENT_RETENTION_DAYS.
 *
 * Triggers on the same device within INCIDENT_MERGE_SECONDS join the same incident.
 * The same error again (same signature, see dedupe.js) within DUPLICATE_WINDOW_HOURS joins the incident
 * that already has it, and only raises that trigger's count; no new incident or trigger is stored.
 * A condition-based incident is marked resolved once every condition it raised has cleared.
 */

const SEVERITY = { warning: 1, critical: 2 };

export function incidentStatus(inc) {
  if (inc.openCodes.length > 0) return 'active';
  if (inc.resolvedAt) return 'resolved';
  return 'recorded';
}

export function incidentSummary(inc) {
  const last = inc.triggers.at(-1);
  return {
    id: inc.id,
    deviceId: inc.deviceId,
    storeId: inc.storeId,
    severity: inc.severity,
    title: inc.title,
    status: incidentStatus(inc),
    openedAt: inc.openedAt,
    updatedAt: inc.updatedAt,
    resolvedAt: inc.resolvedAt,
    triggerCount: inc.triggerCount,
    repeats: inc.repeats ?? 0,
    lastTrigger: last && last !== inc.triggers[0] ? last.title : null,
  };
}

/** Event-based trigger (error/warning log, POS crash event, SQL loss event, ...). */
export function triggerFromEvent(state, d, item, capture) {
  return addTrigger(state, d, {
    t: item.t,
    kind: 'event',
    severity: item.priority === 'critical' ? 'critical' : 'warning',
    title: item.title,
    detail: item.detail || null,
    priority: item.priority,
    eventId: item.id,
    sig: item.sig,
    count: item.occurrences ?? 1,
  }, capture);
}

/** A condition (issue code) newly appeared on the device. */
export function raiseCondition(state, d, issue, t, capture, detail = null) {
  const inc = addTrigger(state, d, {
    t,
    kind: 'condition',
    code: issue.code,
    severity: issue.level === 'critical' ? 'critical' : 'warning',
    title: issue.text,
    detail,
    priority: issue.level === 'critical' ? 'critical' : 'high',
  }, capture);
  if (!inc.openCodes.includes(issue.code)) inc.openCodes.push(issue.code);
  d.issueIncident[issue.code] = inc.id;
  return inc;
}

/** A condition cleared: attach a "resolved" trigger to the incident that raised it. */
export function clearCondition(state, d, code, label, t) {
  const id = d.issueIncident[code];
  delete d.issueIncident[code];
  const inc = id ? state.incidentIndex.get(id) : null;
  if (!inc) return null;

  pushTrigger(inc, { t, kind: 'resolved', code, severity: 'info', title: label, priority: 'normal' });
  inc.openCodes = inc.openCodes.filter((c) => c !== code);
  if (inc.openCodes.length === 0) inc.resolvedAt = t;
  markChanged(state, inc);
  return inc;
}

function addTrigger(state, d, trigger, capture) {
  const mergeMs = config.incidentMergeSeconds * 1000;
  let inc = d.openIncidentId ? state.incidentIndex.get(d.openIncidentId) : null;
  const canMerge = inc && trigger.t <= inc.updatedAt + mergeMs && trigger.t >= inc.openedAt - mergeMs;
  if (!canMerge) inc = trigger.sig ? findDuplicateIncident(state, d.deviceId, trigger) : null;
  if (inc) d.openIncidentId = inc.id;

  if (!inc) {
    const now = Date.now();
    inc = {
      id: randomUUID(),
      deviceId: d.deviceId,
      storeId: d.storeId,
      severity: trigger.severity,
      title: trigger.title,
      openedAt: trigger.t,
      updatedAt: trigger.t,
      resolvedAt: null,
      openCodes: [],
      triggerCount: 0,
      triggers: [],
      capturedAt: now,
      // Backlog uploaded after an outage: the frozen state is from arrival, not from the event.
      capturedLate: now - trigger.t > 2 * 60_000,
      context: capture(),
    };
    state.incidents.push(inc);
    state.incidentIndex.set(inc.id, inc);
    d.openIncidentId = inc.id;
    while (state.incidents.length > config.incidentsMax) {
      state.incidentIndex.delete(state.incidents.shift().id);
    }
  }

  const same = trigger.sig ? inc.triggers.findLast((x) => x.sig === trigger.sig) : null;
  if (same) {
    same.count = (same.count ?? 1) + trigger.count;
    same.lastAt = Math.max(same.lastAt ?? same.t, trigger.t);
    if (trigger.t >= same.lastAt) same.detail = trigger.detail;
    inc.repeats = (inc.repeats ?? 0) + trigger.count;
  } else {
    pushTrigger(inc, trigger);
  }
  inc.updatedAt = Math.max(inc.updatedAt, trigger.t);
  inc.openedAt = Math.min(inc.openedAt, trigger.t);
  if (SEVERITY[trigger.severity] > SEVERITY[inc.severity]) {
    inc.severity = trigger.severity;
    inc.title = trigger.title;
  }
  inc.resolvedAt = null;
  markChanged(state, inc);
  return inc;
}

/** The device's most recent incident that already holds this error, if updated within the duplicate window. */
function findDuplicateIncident(state, deviceId, trigger) {
  const since = trigger.t - config.duplicateWindowHours * 3_600_000;
  let best = null;
  for (let i = state.incidents.length - 1; i >= 0; i--) {
    const inc = state.incidents[i];
    if (inc.deviceId !== deviceId || inc.updatedAt < since) continue;
    if (best && inc.updatedAt <= best.updatedAt) continue;
    if (inc.triggers.some((x) => x.sig === trigger.sig)) best = inc;
  }
  return best;
}

function pushTrigger(inc, trigger) {
  inc.triggers.push(trigger);
  inc.triggerCount++;
  // Keep the first trigger (what started it) and the most recent ones.
  if (inc.triggers.length > config.incidentTriggersMax) inc.triggers.splice(1, 1);
}

function markChanged(state, inc) {
  state.changedIncidents.add(inc.id);
  state.unpersistedIncidents.add(inc.id);
  state.dirty = true;
  state.urgentSave = true; // incidents are the long-lived record: save soon, not at the next routine snapshot
}

export function pruneIncidents(state, now) {
  const cutoff = now - config.incidentRetentionDays * 86_400_000;
  let removed = 0;
  while (state.incidents.length && state.incidents[0].updatedAt < cutoff) {
    state.incidentIndex.delete(state.incidents.shift().id);
    removed++;
  }
  return removed;
}

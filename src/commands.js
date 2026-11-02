import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { config } from './config.js';

/**
 * Relay for on-demand requests to agents (e.g. browsing C:\XeniaRetail on a POS).
 *
 * Stores are behind firewalls, so the server never connects to a POS. Each agent keeps one
 * long-poll open (GET /api/agent/commands); a dashboard request is queued for that device and
 * handed to the waiting poll immediately. The agent posts the result back and the dashboard's
 * HTTP request completes with it. Nothing here is persisted: requests live only seconds.
 */
const c = (globalThis.__posCommands ??= { slots: new Map(), pending: new Map() });

const LISTENING_GRACE_MS = 60_000;
const MAX_PER_POLL = 10;

function slotOf(deviceId) {
  let s = c.slots.get(deviceId);
  if (!s) {
    s = { queue: [], waiter: null, lastPollAt: 0 };
    c.slots.set(deviceId, s);
  }
  return s;
}

/** True when the device's agent is polling for requests (newer agents with FileAccess enabled). */
export function isAgentListening(deviceId) {
  const s = c.slots.get(deviceId);
  return Boolean(s && (s.waiter || Date.now() - s.lastPollAt < LISTENING_GRACE_MS));
}

/** Queues a request for the device's agent and resolves with its reply { ok, result, error }. */
export function sendCommand(deviceId, op, args) {
  if (!isAgentListening(deviceId)) {
    return Promise.reject(
      httpError(503, 'The agent on this device is not connected for file access (offline, disabled, or an older agent version).'),
    );
  }

  const id = randomUUID();
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      c.pending.delete(id);
      const s = c.slots.get(deviceId);
      if (s) s.queue = s.queue.filter((cmd) => cmd.id !== id);
      reject(httpError(504, `No answer from ${deviceId} within ${config.fileRequestTimeoutSeconds} s.`));
    }, config.fileRequestTimeoutSeconds * 1000);

    c.pending.set(id, { deviceId, resolve, timer });
    const s = slotOf(deviceId);
    s.queue.push({ id, op, args });
    deliver(s);
  });
}

/** Agent long-poll: answers at once if requests are waiting, otherwise holds up to waitMs. */
export function pollCommands(deviceId, waitMs, req, res) {
  const s = slotOf(deviceId);
  s.lastPollAt = Date.now();
  if (s.queue.length) return res.json({ commands: take(s) });

  if (s.waiter) finish(s, s.waiter, []); // a newer poll replaces an older one
  const waiter = { res, timer: null };
  waiter.timer = setTimeout(() => finish(s, waiter, []), waitMs);
  s.waiter = waiter;

  res.on('close', () => {
    if (s.waiter === waiter) {
      clearTimeout(waiter.timer);
      s.waiter = null;
    }
  });
}

/** Agent posts a result; returns false when the request is unknown or already timed out. */
export function completeCommand(deviceId, id, reply) {
  const p = c.pending.get(id);
  if (!p || p.deviceId !== deviceId) return false;
  clearTimeout(p.timer);
  c.pending.delete(id);
  p.resolve(reply);
  return true;
}

function deliver(s) {
  if (s.waiter && s.queue.length) finish(s, s.waiter, take(s));
}

function finish(s, waiter, commands) {
  clearTimeout(waiter.timer);
  if (s.waiter === waiter) s.waiter = null;
  s.lastPollAt = Date.now();
  if (!waiter.res.headersSent && !waiter.res.writableEnded) waiter.res.json({ commands });
}

function take(s) {
  return s.queue.splice(0, MAX_PER_POLL).filter((cmd) => c.pending.has(cmd.id));
}

function httpError(status, message) {
  return Object.assign(new Error(message), { status });
}

/**
 * Server-side check before anything is sent to an agent (the agent enforces its own lock too).
 * Accepts absolute paths under FILE_ROOT or paths relative to it; returns the absolute path.
 */
export function resolveUnderRoot(requested) {
  const root = path.win32.normalize(config.fileRoot).replace(/\\+$/, '');
  const p = String(requested ?? '').trim().replace(/\//g, '\\');
  if (!p) return { ok: true, path: root };

  const colon = p.indexOf(':');
  if (p.startsWith('\\\\') || /[\0*?"<>|]/.test(p) || (colon >= 0 && (colon !== 1 || p.indexOf(':', colon + 1) >= 0))) {
    return { ok: false, error: 'The path format is not allowed.' };
  }

  const full = (colon === 1 ? path.win32.normalize(p) : path.win32.resolve(root, p.replace(/^\\+/, ''))).replace(/\\+$/, '');
  const lower = full.toLowerCase();
  const rootLower = root.toLowerCase();
  if (lower !== rootLower && !lower.startsWith(`${rootLower}\\`)) {
    return { ok: false, error: `Only files under ${root} can be accessed.` };
  }
  return { ok: true, path: full };
}

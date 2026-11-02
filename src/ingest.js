import { createHash, timingSafeEqual } from 'node:crypto';
import { config } from './config.js';
import { persist } from './archive.js';
import { applyEvents, countDuplicates, countRejected, isDuplicate } from './store.js';

const digest = (s) => createHash('sha256').update(s).digest();
const keyDigests = config.apiKeys.map(digest);

/** @param {string | undefined} key value of the X-Api-Key header */
export function isAuthorized(key) {
  if (keyDigests.length === 0) return true;
  if (!key) return false;
  const d = digest(key);
  return keyDigests.some((k) => timingSafeEqual(k, d));
}

const ID_PATTERN = /^[0-9A-Za-z-]{8,64}$/;

function validate(ev, batchDeviceId) {
  if (!ev || typeof ev !== 'object' || Array.isArray(ev)) return 'not an object';
  if (typeof ev.eventId !== 'string' || !ID_PATTERN.test(ev.eventId)) return 'invalid eventId';
  if (typeof ev.deviceId !== 'string' || ev.deviceId.length === 0 || ev.deviceId.length > 128) return 'invalid deviceId';
  if (batchDeviceId && ev.deviceId !== batchDeviceId) return 'deviceId does not match batch';
  if (typeof ev.eventType !== 'string' || ev.eventType.length > 64) return 'invalid eventType';
  if (!Number.isFinite(ev.sequenceNumber)) return 'invalid sequenceNumber';
  if (!Number.isFinite(ev.schemaVersion)) return 'invalid schemaVersion';
  if (typeof ev.timestamp !== 'string' || Number.isNaN(Date.parse(ev.timestamp))) return 'invalid timestamp';
  return null;
}

/**
 * Validates, deduplicates, stores and applies one agent batch.
 * Returns the acknowledgement the agent needs before it deletes events locally.
 */
export async function ingestBatch(body) {
  const receivedAt = Date.now();
  const batchDeviceId = typeof body.deviceId === 'string' ? body.deviceId : null;
  const acknowledgedEventIds = [];
  const rejectedEventIds = [];
  const fresh = [];
  const inBatch = new Set();
  let duplicates = 0;

  for (const ev of body.events) {
    const problem = validate(ev, batchDeviceId);
    if (problem) {
      if (typeof ev?.eventId === 'string') rejectedEventIds.push(ev.eventId);
      continue;
    }
    if (inBatch.has(ev.eventId) || isDuplicate(ev)) {
      // Already stored: acknowledge again so the agent can delete it.
      acknowledgedEventIds.push(ev.eventId);
      duplicates++;
      continue;
    }
    inBatch.add(ev.eventId);
    fresh.push(ev);
  }

  // Durable first (MongoDB or spool, when configured); throws 503 only if that is impossible.
  await persist(fresh, receivedAt);

  if (fresh.length > 0) applyEvents(fresh, receivedAt);
  for (const ev of fresh) acknowledgedEventIds.push(ev.eventId);
  countDuplicates(duplicates);
  countRejected(rejectedEventIds.length);

  return { acknowledgedEventIds, rejectedEventIds };
}

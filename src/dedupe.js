import { createHash } from 'node:crypto';

/**
 * Content-based duplicate detection for failures, errors and warnings.
 *
 * Event ids already stop the same upload from being stored twice (see ingest.js). This catches the
 * other kind of duplicate: the same error raised again and again (a retry loop, a log line every few
 * seconds). Such repeats are folded into the first record with a count and a "last seen" time
 * instead of being stored and listed one by one.
 *
 * The signature is what the error says with the variable parts removed: numbers, GUIDs, hex codes,
 * timestamps, so "Timeout after 5003 ms (order 1182)" and "Timeout after 5011 ms (order 1190)" match.
 */
const GUID = /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/g;
const HEX = /\b0x[0-9a-f]+\b/g;
const LONG_HEX = /\b[0-9a-f]{12,}\b/g;
const DIGITS = /\d+/g;

export function normalizeText(text) {
  if (typeof text !== 'string') return '';
  return text
    .toLowerCase()
    .replace(GUID, '#')
    .replace(HEX, '#')
    .replace(LONG_HEX, '#')
    .replace(DIGITS, '#')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 300);
}

const firstLine = (s) => (typeof s === 'string' ? s.split('\n', 1)[0] : '');

/** Identifies "the same error" independently of when it happened or which upload carried it. */
export function signatureOf(ev) {
  const level = String(ev.level ?? ev.priority ?? '').toLowerCase();
  let what;
  switch (ev.eventType) {
    case 'log':
      what = [ev.provider ?? ev.file ?? ev.source, ev.windowsEventId, firstLine(ev.message)];
      break;
    case 'application.state':
      what = [ev.name, ev.currentState, ev.reason];
      break;
    case 'connectivity.change':
      what = [ev.target, ev.connected, ev.errorCode];
      break;
    default:
      what = [ev.message ?? ev.reason ?? ev.errorCode];
  }
  return `${ev.eventType}|${level}|${what.map((x) => normalizeText(String(x ?? ''))).join('|')}`;
}

/** Stable short key for one device's signature (MongoDB _id of the folded record). */
export function fingerprint(deviceId, signature) {
  return createHash('sha1').update(`${deviceId}\n${signature}`).digest('hex');
}

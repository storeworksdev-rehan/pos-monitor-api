import { config } from './config.js';

const allowAll = config.corsOrigins.includes('*');
const allowed = new Set(config.corsOrigins);

/** Minimal CORS for the read-only dashboard endpoints (no extra dependency). */
export function cors(req, res, next) {
  const origin = req.get('origin');
  if (origin && (allowAll || allowed.has(origin))) {
    res.set('Access-Control-Allow-Origin', origin);
    res.set('Access-Control-Allow-Methods', 'GET, OPTIONS');
    res.set('Access-Control-Allow-Headers', 'Content-Type');
    res.set('Access-Control-Max-Age', '600');
  }
  res.vary('Origin');
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
}

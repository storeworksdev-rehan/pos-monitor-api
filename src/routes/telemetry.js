import express from 'express';
import { config } from '../config.js';
import { ingestBatch, isAuthorized } from '../ingest.js';
import { publicStats } from '../store.js';

const router = express.Router();

/**
 * POST /api/telemetry/batch
 * Body:  { deviceId, storeId, sentAt, events: [envelope, ...] }  (gzip or plain JSON)
 * Reply: { acknowledgedEventIds: [...], rejectedEventIds: [...] }
 * The agent deletes events from its local queue only after they are acknowledged.
 */
router.post(
  '/telemetry/batch',
  (req, res, next) => {
    // Check the key before reading a potentially large body.
    if (!isAuthorized(req.get('x-api-key'))) return res.status(401).json({ error: 'Invalid or missing X-Api-Key' });
    next();
  },
  // inflate: true decodes the agent's optional "Content-Encoding: gzip".
  express.json({ limit: config.maxBodyBytes, inflate: true, type: () => true }),
  async (req, res) => {
    const body = req.body;
    if (!body || !Array.isArray(body.events)) return res.status(400).json({ error: 'Expected { events: [...] }' });

    try {
      res.json(await ingestBatch(body));
    } catch (err) {
      if (err?.status === 503) {
        // Archive spool full: agents keep the events in their own durable queue and retry.
        res.set('Retry-After', '60');
        return res.status(503).json({ error: err.message });
      }
      throw err;
    }
  },
);

/** GET /api/health - used by agents for centralApiConnected / apiResponseTimeMs. */
router.get('/health', (req, res) => {
  const stats = publicStats();
  res.json({ status: 'ok', time: new Date().toISOString(), storage: stats.storage, devices: stats.devices });
});

export default router;

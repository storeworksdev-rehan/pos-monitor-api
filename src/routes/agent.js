import express from 'express';
import { completeCommand, pollCommands } from '../commands.js';
import { config } from '../config.js';
import { isAuthorized } from '../ingest.js';

/** Endpoints only the agents call. Authenticated with X-Api-Key; the device is X-Device-Id. */
const router = express.Router();

router.use((req, res, next) => {
  if (!isAuthorized(req.get('x-api-key'))) return res.status(401).json({ error: 'Invalid or missing X-Api-Key' });
  const deviceId = req.get('x-device-id');
  if (!deviceId || deviceId.length > 128) return res.status(400).json({ error: 'X-Device-Id header is required' });
  req.deviceId = deviceId;
  next();
});

/** GET /api/agent/commands?wait=20 - long-poll for on-demand requests for this device. */
router.get('/commands', (req, res) => {
  const waitSeconds = Math.min(Math.max(Number(req.query.wait) || 20, 1), 25);
  pollCommands(req.deviceId, waitSeconds * 1000, req, res);
});

/** POST /api/agent/commands/:id/result - { ok, result } or { ok: false, error: { code, message } }. */
router.post(
  '/commands/:id/result',
  express.json({ limit: config.maxBodyBytes, inflate: true, type: () => true }),
  (req, res) => {
    if (completeCommand(req.deviceId, req.params.id, req.body)) return res.status(204).end();
    res.status(404).json({ error: 'Unknown or expired request' });
  },
);

export default router;

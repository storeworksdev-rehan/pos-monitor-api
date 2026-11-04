import express from 'express';
import { config } from './config.js';
import { ensureBooted } from './boot.js';
import { cors } from './cors.js';
import telemetryRoutes from './routes/telemetry.js';
import agentRoutes from './routes/agent.js';
import fleetRoutes from './routes/fleet.js';

ensureBooted();

const app = express();
app.disable('x-powered-by');
app.disable('etag');

// Agent-facing endpoints (POST /api/telemetry/batch, GET /api/health, on-demand request channel).
app.use('/api', telemetryRoutes);
app.use('/api/agent', agentRoutes);
// Dashboard-facing read endpoints and the live stream, readable from the Next.js origin.
app.use('/api', cors, fleetRoutes);

app.use((req, res) => res.status(404).json({ error: 'Not found' }));

// Body-parser and handler errors (Express 5 forwards rejected promises here too).
app.use((err, req, res, _next) => {
  const status = err.status ?? err.statusCode ?? 500;
  if (status >= 500) console.error(`[api] ${req.method} ${req.originalUrl} failed`, err);
  const message =
    status === 413 ? 'Batch too large'
    : err.type === 'entity.parse.failed' ? 'Body is not valid JSON'
    : status === 415 ? 'Unsupported content encoding'
    : status < 500 ? err.message
    : 'Internal error';
  if (!res.headersSent) res.status(status).json({ error: message });
});

app.listen(config.port, config.host, () => {
  console.info(`[api] listening on http://${config.host}:${config.port} (dashboard origins: ${config.corsOrigins.join(', ')})`);
});

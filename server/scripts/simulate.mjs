#!/usr/bin/env node
/**
 * Simulates a fleet of POS agents posting telemetry exactly like the .NET agent does.
 *
 *   npm run simulate -- --devices 24 --stores 6 --interval 5 --url http://localhost:4000 --key <api-key>
 *
 * Each device sends metrics + heartbeat every interval, and now and then a POS crash,
 * a SQL outage or an error log, so the dashboard has something to show.
 */
import { randomUUID } from 'node:crypto';

const args = Object.fromEntries(
  process.argv.slice(2).reduce((acc, a, i, all) => (a.startsWith('--') ? [...acc, [a.slice(2), all[i + 1]]] : acc), []),
);
const URL_BASE = (args.url ?? process.env.API_URL ?? 'http://localhost:4000').replace(/\/$/, '');
const API_KEY = args.key ?? process.env.API_KEY ?? '';
const DEVICES = Number(args.devices ?? 12);
const STORES = Number(args.stores ?? Math.max(1, Math.ceil(DEVICES / 4)));
const INTERVAL = Number(args.interval ?? 5) * 1000;

const rnd = (min, max) => min + Math.random() * (max - min);
const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
const walk = (v, step, lo, hi) => clamp(v + rnd(-step, step), lo, hi);

const fleet = Array.from({ length: DEVICES }, (_, i) => {
  const store = `STORE${String((i % STORES) + 1).padStart(3, '0')}`;
  const lane = Math.floor(i / STORES) + 1;
  return {
    deviceId: `POS-${store}-${String(lane).padStart(2, '0')}`,
    storeId: store,
    seq: 0,
    cpu: rnd(10, 40),
    mem: rnd(45, 75),
    disk: rnd(15, 60),
    totalMemoryMB: [8192, 16384][i % 2],
    posRunning: true,
    posStarted: Date.now() - rnd(1, 48) * 3600_000,
    pid: 4000 + i,
    sqlUp: true,
    startedAt: new Date(),
    uptime: Math.round(rnd(1, 30) * 86400),
  };
});

function envelope(d, eventType, priority, body) {
  return {
    eventId: randomUUID(),
    schemaVersion: 1,
    sequenceNumber: ++d.seq,
    eventType,
    priority,
    deviceId: d.deviceId,
    storeId: d.storeId,
    timestamp: new Date().toISOString(),
    agentVersion: '1.0.0',
    ...body,
  };
}

function tick(d) {
  const events = [];
  d.uptime += INTERVAL / 1000;
  d.cpu = walk(d.cpu, 12, 2, 99);
  d.mem = walk(d.mem, 3, 30, 97);
  d.disk = walk(d.disk, 0.2, 4, 80);

  // Occasional incidents
  if (d.posRunning && Math.random() < 0.01) {
    d.posRunning = false;
    events.push(envelope(d, 'application.state', 'critical', { name: 'StellaNova POS', previousState: 'running', currentState: 'stopped', reason: 'POS process exited', processId: d.pid, version: '5.2.1' }));
    events.push(envelope(d, 'log', 'critical', { source: 'windows-event', level: 'error', channel: 'Application', provider: 'Application Error', windowsEventId: 1000, occurredAt: new Date().toISOString(), message: 'Faulting application name: StellaNovaPOS.exe, version: 5.2.1.0\nException code: 0xc0000005', occurrences: 1 }));
  } else if (!d.posRunning && Math.random() < 0.25) {
    d.posRunning = true;
    d.pid += 100;
    d.posStarted = Date.now();
    events.push(envelope(d, 'application.state', 'high', { name: 'StellaNova POS', previousState: 'stopped', currentState: 'running', reason: 'POS process started', processId: d.pid, version: '5.2.1' }));
  }
  if (d.sqlUp && Math.random() < 0.006) {
    d.sqlUp = false;
    events.push(envelope(d, 'connectivity.change', 'high', { target: 'local-sql', connected: false, errorCode: 53 }));
  } else if (!d.sqlUp && Math.random() < 0.3) {
    d.sqlUp = true;
    events.push(envelope(d, 'connectivity.change', 'normal', { target: 'local-sql', connected: true, responseTimeMs: 21 }));
  }
  if (Math.random() < 0.02) {
    events.push(envelope(d, 'log', 'high', { source: 'pos-log', level: 'error', file: 'pos.log', occurredAt: new Date().toISOString(), message: 'ERROR PaymentService: Terminal timeout after 30000 ms (code PT-408)\n   at Pos.Payment.Terminal.Charge()', occurrences: Math.ceil(rnd(1, 4)) }));
  }

  const usedMB = Math.round((d.totalMemoryMB * d.mem) / 100);
  events.push(
    envelope(d, 'metrics', 'normal', {
      system: {
        os: 'Windows 11',
        osEdition: 'IoTEnterprise',
        osBuild: '10.0.26100.4652',
        cpuUsage: Math.round(d.cpu * 10) / 10,
        totalMemoryMB: d.totalMemoryMB,
        usedMemoryMB: usedMB,
        memoryLoadPercent: Math.round(d.mem),
        diskFreeGB: Math.round(d.disk * 2.38) / 10,
        uptimeSeconds: Math.round(d.uptime),
        disks: [{ name: 'C:\\', totalGB: 238, freeGB: Math.round(d.disk * 2.38) / 10, freePercent: Math.round(d.disk * 10) / 10, isSystemDrive: true }],
        network: { isAvailable: true, activeInterfaces: 1, bytesSentPerSec: Math.round(rnd(500, 9000)), bytesReceivedPerSec: Math.round(rnd(500, 20000)) },
      },
      application: d.posRunning
        ? { name: 'StellaNova POS', version: '5.2.1', processRunning: true, instanceCount: 1, processId: d.pid, uptimeSeconds: Math.round((Date.now() - d.posStarted) / 1000), cpuUsage: Math.round(d.cpu * 4) / 10, workingSetMB: Math.round(rnd(380, 620)), handleCount: 1200, threadCount: 48 }
        : { name: 'StellaNova POS', version: '5.2.1', processRunning: false, instanceCount: 0 },
      connectivity: {
        localSqlConnected: d.sqlUp,
        sqlResponseTimeMs: d.sqlUp ? Math.round(rnd(8, 60)) : undefined,
        sqlErrorCode: d.sqlUp ? undefined : 53,
        centralApiConnected: true,
        apiResponseTimeMs: Math.round(rnd(40, 180)),
        transactionHealth: { transactionsLastHour: Math.round(rnd(20, 140)), failedLastHour: Math.round(rnd(0, 3)) },
        checkedAt: new Date().toISOString(),
      },
    }),
    envelope(d, 'heartbeat', 'high', {
      lastSeen: new Date().toISOString(),
      machineName: d.deviceId.replace('POS-', 'TILL-'),
      installationId: randomUUID(),
      agentStartedAt: d.startedAt.toISOString(),
      agentUptimeSeconds: Math.round((Date.now() - d.startedAt) / 1000),
      pendingEvents: 0,
      pendingCriticalEvents: 0,
      pendingBytes: 0,
      consecutiveUploadFailures: 0,
    }),
  );
  return events;
}

async function send(d) {
  const events = tick(d);
  const res = await fetch(`${URL_BASE}/api/telemetry/batch`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Device-Id': d.deviceId, ...(API_KEY ? { 'X-Api-Key': API_KEY } : {}) },
    body: JSON.stringify({ deviceId: d.deviceId, storeId: d.storeId, sentAt: new Date().toISOString(), events }),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status} ${await res.text()}`);
  const ack = await res.json();
  return ack.acknowledgedEventIds.length;
}

console.log(`Simulating ${DEVICES} device(s) in ${STORES} store(s) -> ${URL_BASE} every ${INTERVAL / 1000}s (Ctrl+C to stop)`);
let round = 0;
for (;;) {
  const started = Date.now();
  const results = await Promise.allSettled(fleet.map(send));
  const acked = results.reduce((n, r) => n + (r.status === 'fulfilled' ? r.value : 0), 0);
  const failed = results.filter((r) => r.status === 'rejected');
  round++;
  console.log(`round ${round}: ${acked} event(s) acknowledged${failed.length ? `, ${failed.length} failed (${failed[0].reason.message})` : ''}`);
  await new Promise((r) => setTimeout(r, Math.max(0, INTERVAL - (Date.now() - started))));
}

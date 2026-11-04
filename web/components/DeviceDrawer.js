'use client';

import { apiUrl } from '@/lib/api';
import { useEffect, useState } from 'react';
import FileBrowser from './FileBrowser';
import { Ago, AreaChart, GlassCard, Meter, PRIORITY, Pill, STATUS, Segmented, StatusDot, formatBytes, formatDuration, pct, statusOf, useNow } from './ui';

const isProblemEvent = (e) =>
  e.priority === 'critical' || e.priority === 'high' || ['critical', 'error', 'warning'].includes(String(e.level ?? '').toLowerCase());

// history tuple indexes (see server/src/store.js)
const H = { CPU: 1, MEM: 2, DISK: 3, APP_CPU: 4, SQL_MS: 5 };

export default function DeviceDrawer({ deviceId, summary, thresholds, fileRoot, onClose, onOpenIncident }) {
  const [detail, setDetail] = useState(null);
  const [missing, setMissing] = useState(false);
  const [tab, setTab] = useState('overview');
  const lastSeen = summary?.lastSeen;
  const now = useNow();

  // Refetch only when this device actually reports something new.
  useEffect(() => {
    const ctrl = new AbortController();
    fetch(apiUrl(`/api/devices/${encodeURIComponent(deviceId)}`), { signal: ctrl.signal, cache: 'no-store' })
      .then((r) => (r.ok ? r.json() : Promise.reject(r.status)))
      .then((d) => {
        setDetail(d);
        setMissing(false);
      })
      .catch((e) => {
        if (e === 404) setMissing(true);
      });
    return () => ctrl.abort();
  }, [deviceId, lastSeen]);

  const s = detail?.summary ?? summary;
  const status = s ? statusOf(s.lastSeen, now, thresholds) : 'offline';

  return (
    <div className="fixed inset-0 z-50" role="dialog" aria-modal="true" aria-label={`Device ${deviceId}`}>
      <div className="absolute inset-0 animate-fade bg-black/50 backdrop-blur-sm" onClick={onClose} />
      <div className="absolute inset-y-0 right-0 flex w-full max-w-3xl animate-drawer flex-col border-l border-white/10 bg-[#070a12]/95 shadow-2xl shadow-black backdrop-blur-2xl">
        <header className="flex items-start justify-between gap-4 border-b border-white/5 px-6 py-5">
          <div className="min-w-0">
            <div className="flex items-center gap-2.5">
              <StatusDot status={status} />
              <h2 className="truncate font-mono text-lg font-semibold">{deviceId}</h2>
            </div>
            <p className="mt-1 pl-4 text-xs text-slate-400">
              {[s?.storeId, s?.os, detail?.heartbeat?.machineName, s?.agentVersion && `agent ${s.agentVersion}`].filter(Boolean).join(' · ')}
            </p>
            <p className={`mt-1 pl-4 text-xs ${STATUS[status].text}`}>
              {STATUS[status].label} · last data <Ago ts={s?.lastSeen} />
            </p>
          </div>
          <button
            onClick={onClose}
            className="rounded-lg p-2 text-slate-400 transition hover:bg-white/5 hover:text-white"
            aria-label="Close"
          >
            <svg viewBox="0 0 20 20" className="h-5 w-5" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true">
              <path d="M5 5l10 10M15 5L5 15" />
            </svg>
          </button>
        </header>

        <div className="flex gap-1 border-b border-white/5 px-6 pt-2">
          {[
            ['overview', 'Overview'],
            ['files', 'Log files'],
          ].map(([key, label]) => (
            <button
              key={key}
              onClick={() => setTab(key)}
              className={`-mb-px border-b-2 px-3 py-2 text-sm transition ${
                tab === key ? 'border-cyan-400 text-white' : 'border-transparent text-slate-400 hover:text-slate-200'
              }`}
            >
              {label}
              {key === 'files' && (
                <span
                  className={`ml-2 inline-block h-1.5 w-1.5 rounded-full align-middle ${s?.fileAccess ? 'bg-emerald-400' : 'bg-slate-600'}`}
                  title={s?.fileAccess ? 'Agent connected for file access' : 'Agent not connected for file access'}
                />
              )}
            </button>
          ))}
        </div>

        <div className="flex-1 space-y-5 overflow-y-auto px-6 py-6">
          {tab === 'files' ? (
            <FileBrowser deviceId={deviceId} root={fileRoot} available={Boolean(s?.fileAccess)} />
          ) : (
            <>
              {missing && <p className="text-sm text-slate-400">This device is no longer known to the server.</p>}
              {!detail && !missing && <SkeletonBlocks />}
              {detail && <DetailBody detail={detail} onOpenIncident={onOpenIncident} />}
            </>
          )}
        </div>
      </div>
    </div>
  );
}

function DetailBody({ detail, onOpenIncident }) {
  const { summary: s, system, application: app, connectivity: c, heartbeat: hb, history, events: allEvents, incidents = [] } = detail;
  const [eventView, setEventView] = useState('all');
  const problemCount = allEvents.filter(isProblemEvent).length;
  const events = eventView === 'problems' ? allEvents.filter(isProblemEvent) : allEvents;

  return (
    <>
      {incidents.length > 0 && (
        <GlassCard className="p-4">
          <SectionTitle>Incident snapshots</SectionTitle>
          <ul className="space-y-1">
            {incidents.map((i) => (
              <li key={i.id}>
                <button
                  onClick={() => onOpenIncident?.(i.id)}
                  className="flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-left text-sm transition hover:bg-white/[0.05]"
                >
                  <span className={`h-1.5 w-1.5 shrink-0 rounded-full ${i.severity === 'critical' ? PRIORITY.critical.dot : PRIORITY.high.dot}`} />
                  <span className="truncate">{i.title}</span>
                  <Pill tone={i.status === 'active' ? 'bad' : i.status === 'resolved' ? 'ok' : 'neutral'}>{i.status}</Pill>
                  <span className="ml-auto shrink-0 text-[11px] text-slate-500">
                    <Ago ts={i.updatedAt} />
                  </span>
                </button>
              </li>
            ))}
          </ul>
        </GlassCard>
      )}

      {s.issues.length > 0 && (
        <div className="flex flex-wrap gap-2">
          {s.issues.map((i) => (
            <Pill key={i.text} tone={i.level === 'critical' ? 'bad' : 'warn'}>
              {i.text}
            </Pill>
          ))}
        </div>
      )}

      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        <Tile label="CPU" value={pct(s.cpu)} />
        <Tile label="Memory" value={pct(s.memPct)} sub={s.memUsedMB != null ? `${formatBytes(s.memUsedMB * 1048576)} of ${formatBytes(s.memTotalMB * 1048576)}` : null} />
        <Tile label="System disk free" value={s.diskFreeGB != null ? `${s.diskFreeGB} GB` : '—'} sub={pct(s.diskFreePct)} />
        <Tile label="Uptime" value={formatDuration(s.uptimeSeconds)} />
      </div>

      <GlassCard className="p-4">
        <SectionTitle>CPU &amp; memory · last {detail.windowMinutes} min</SectionTitle>
        <div className="grid gap-4 sm:grid-cols-2">
          <AreaChart history={history} index={H.CPU} className="text-cyan-300" format={(v) => `${Math.round(v)}%`} />
          <AreaChart history={history} index={H.MEM} className="text-violet-300" format={(v) => `${Math.round(v)}%`} />
        </div>
      </GlassCard>

      <div className="grid gap-5 sm:grid-cols-2">
        <GlassCard className="p-4">
          <SectionTitle>POS application</SectionTitle>
          {app ? (
            <dl className="space-y-2 text-sm">
              <Row k="Name" v={app.name} />
              <Row k="Status" v={<Pill tone={app.processRunning ? 'ok' : 'bad'}>{app.processRunning ? 'Running' : 'Not running'}</Pill>} />
              <Row k="Version" v={app.version ?? '—'} />
              <Row k="Instances" v={app.instanceCount ?? '—'} />
              <Row k="Process uptime" v={formatDuration(app.uptimeSeconds)} />
              <Row k="CPU" v={pct(app.cpuUsage)} />
              <Row k="Working set" v={app.workingSetMB != null ? `${app.workingSetMB} MB` : '—'} />
              <Row k="Handles / threads" v={`${app.handleCount ?? '—'} / ${app.threadCount ?? '—'}`} />
              {app.responding != null && <Row k="Responding" v={app.responding ? 'Yes' : 'No'} />}
            </dl>
          ) : (
            <Empty>No recent application data.</Empty>
          )}
          <div className="mt-4">
            <AreaChart history={history} index={H.APP_CPU} className="text-emerald-300" height="h-20" format={(v) => `${Math.round(v)}%`} />
          </div>
        </GlassCard>

        <GlassCard className="p-4">
          <SectionTitle>Connectivity</SectionTitle>
          {c ? (
            <dl className="space-y-2 text-sm">
              <Row
                k="Local SQL"
                v={
                  c.localSqlConnected == null ? '—' : (
                    <Pill tone={c.localSqlConnected ? 'ok' : 'bad'}>
                      {c.localSqlConnected ? `Connected · ${c.sqlResponseTimeMs ?? '?'} ms` : `Down${c.sqlErrorCode ? ` · error ${c.sqlErrorCode}` : ''}`}
                    </Pill>
                  )
                }
              />
              <Row
                k="Central API"
                v={
                  c.centralApiConnected == null ? '—' : (
                    <Pill tone={c.centralApiConnected ? 'ok' : 'bad'}>
                      {c.centralApiConnected ? `Reachable · ${c.apiResponseTimeMs ?? '?'} ms` : 'Unreachable'}
                    </Pill>
                  )
                }
              />
              {c.transactionHealth &&
                Object.entries(c.transactionHealth).map(([k, v]) => <Row key={k} k={humanize(k)} v={String(v ?? '—')} />)}
            </dl>
          ) : (
            <Empty>No recent connectivity data.</Empty>
          )}
          <div className="mt-4">
            <AreaChart history={history} index={H.SQL_MS} max={null} className="text-sky-300" height="h-20" format={(v) => `${Math.round(v)} ms`} />
          </div>
        </GlassCard>
      </div>

      <div className="grid gap-5 sm:grid-cols-2">
        <GlassCard className="p-4">
          <SectionTitle>Disks &amp; network</SectionTitle>
          <div className="space-y-3">
            {(system?.disks ?? []).map((d) => (
              <Meter
                key={d.name}
                label={`${d.name}${d.isSystemDrive ? ' (system)' : ''}`}
                value={d.freePercent}
                display={`${d.freeGB} / ${d.totalGB} GB free`}
                warnAt={20}
                badAt={10}
                invert
              />
            ))}
            {system?.network && (
              <dl className="space-y-2 pt-2 text-sm">
                <Row k="Network" v={system.network.isAvailable ? `${system.network.activeInterfaces} interface(s) up` : 'Unavailable'} />
                <Row k="Sent / received" v={`${formatBytes(system.network.bytesSentPerSec)}/s · ${formatBytes(system.network.bytesReceivedPerSec)}/s`} />
              </dl>
            )}
            {!system && <Empty>No system metrics yet.</Empty>}
          </div>
        </GlassCard>

        <GlassCard className="p-4">
          <SectionTitle>Agent &amp; upload queue</SectionTitle>
          {hb ? (
            <dl className="space-y-2 text-sm">
              <Row k="Agent uptime" v={formatDuration(hb.agentUptimeSeconds)} />
              <Row k="Pending events" v={`${hb.pendingEvents ?? 0}${hb.pendingCriticalEvents ? ` (${hb.pendingCriticalEvents} critical)` : ''}`} />
              <Row k="Pending size" v={formatBytes(hb.pendingBytes)} />
              <Row k="Oldest pending" v={hb.oldestPendingAgeSeconds != null ? formatDuration(hb.oldestPendingAgeSeconds) : '—'} />
              <Row k="Upload failures in a row" v={hb.consecutiveUploadFailures ?? 0} />
              <Row k="Last sequence" v={detail.maxSequence} />
            </dl>
          ) : (
            <Empty>No heartbeat yet.</Empty>
          )}
        </GlassCard>
      </div>

      <GlassCard className="p-4">
        <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
          <h3 className="text-[11px] font-semibold uppercase tracking-widest text-slate-400">Events · last {detail.windowMinutes} min</h3>
          {allEvents.length > 0 && (
            <Segmented
              size="sm"
              label="Event filter"
              value={eventView}
              onChange={setEventView}
              options={[
                ['all', 'All', allEvents.length],
                ['problems', 'Errors & warnings', problemCount],
              ]}
            />
          )}
        </div>
        {events.length === 0 ? (
          <Empty>
            {allEvents.length
              ? 'No errors or warnings in the live window.'
              : 'No events in the live window. Older failures and errors are kept in incident snapshots.'}
          </Empty>
        ) : (
          <ol className="relative space-y-4 border-l border-white/10 pl-5">
            {events.map((e) => (
              <li key={e.id} className="relative">
                <span className={`absolute -left-[23px] top-1.5 h-2 w-2 rounded-full ring-4 ring-[#070a12] ${PRIORITY[e.priority]?.dot ?? PRIORITY.normal.dot}`} />
                <div className="flex flex-wrap items-baseline gap-x-2">
                  <span className={`text-sm font-medium ${PRIORITY[e.priority]?.text ?? ''}`}>{e.title}</span>
                  {e.occurrences > 1 && <span className="text-[11px] text-slate-400">×{e.occurrences}</span>}
                  <span className="text-[11px] text-slate-500">
                    {new Date(e.t).toLocaleString()} · <Ago ts={e.t} />
                  </span>
                </div>
                {e.detail && (
                  <pre className="mt-1 max-h-40 overflow-auto whitespace-pre-wrap break-words rounded-lg bg-black/30 p-2.5 font-mono text-[11px] leading-relaxed text-slate-400">
                    {e.detail}
                  </pre>
                )}
              </li>
            ))}
          </ol>
        )}
      </GlassCard>
    </>
  );
}

const humanize = (k) => k.replace(/([a-z])([A-Z])/g, '$1 $2').replace(/^./, (c) => c.toUpperCase());

function Tile({ label, value, sub }) {
  return (
    <GlassCard className="p-3.5">
      <div className="text-[10px] uppercase tracking-widest text-slate-500">{label}</div>
      <div className="mt-1.5 text-xl font-semibold tabular-nums">{value}</div>
      {sub && <div className="mt-0.5 text-[11px] text-slate-500">{sub}</div>}
    </GlassCard>
  );
}

function SectionTitle({ children }) {
  return <h3 className="mb-3 text-[11px] font-semibold uppercase tracking-widest text-slate-400">{children}</h3>;
}

function Row({ k, v }) {
  return (
    <div className="flex items-center justify-between gap-4">
      <dt className="text-slate-400">{k}</dt>
      <dd className="text-right tabular-nums text-slate-200">{v}</dd>
    </div>
  );
}

function Empty({ children }) {
  return <p className="text-sm text-slate-500">{children}</p>;
}

function SkeletonBlocks() {
  return (
    <div className="space-y-4">
      {[96, 180, 220].map((h) => (
        <div key={h} className="animate-pulse rounded-2xl bg-white/[0.04]" style={{ height: h }} />
      ))}
    </div>
  );
}

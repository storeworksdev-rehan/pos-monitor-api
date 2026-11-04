'use client';

import { apiUrl } from '@/lib/api';
import { useEffect, useState } from 'react';
import { Ago, AreaChart, GlassCard, PRIORITY, Pill, formatDuration, pct } from './ui';

const H = { CPU: 1, MEM: 2, APP_CPU: 4, SQL_MS: 5 };
const STATUS_TONE = { active: 'bad', resolved: 'ok', recorded: 'neutral' };
const STATUS_TEXT = {
  active: 'Still happening',
  resolved: 'Resolved',
  recorded: 'Recorded (event only)',
};

/** Shows one incident snapshot: what triggered it and the device state frozen at that moment. */
export default function IncidentDrawer({ incidentId, onClose }) {
  const [inc, setInc] = useState(null);
  const [error, setError] = useState(null);

  useEffect(() => {
    const ctrl = new AbortController();
    const load = () =>
      fetch(apiUrl(`/api/incidents/${encodeURIComponent(incidentId)}`), { signal: ctrl.signal, cache: 'no-store' })
        .then((r) => (r.ok ? r.json() : Promise.reject(new Error(r.status === 404 ? 'This incident has expired.' : `HTTP ${r.status}`))))
        .then(setInc)
        .catch((e) => e.name !== 'AbortError' && setError(e.message));
    load();
    // Active incidents can still gain triggers; refresh gently while open.
    const timer = setInterval(load, 15000);
    return () => {
      clearInterval(timer);
      ctrl.abort();
    };
  }, [incidentId]);

  const ctx = inc?.context;
  const s = ctx?.summary;

  return (
    <div className="fixed inset-0 z-[60]" role="dialog" aria-modal="true" aria-label="Incident snapshot">
      <div className="absolute inset-0 animate-fade bg-black/40 backdrop-blur-[2px]" onClick={onClose} />
      <div className="absolute inset-y-0 right-0 flex w-full max-w-2xl animate-drawer flex-col border-l border-white/10 bg-[#090b14]/95 shadow-2xl shadow-black backdrop-blur-2xl">
        <header className="relative overflow-hidden border-b border-white/5 px-6 py-5">
          <div
            className={`pointer-events-none absolute -right-16 -top-16 h-48 w-48 rounded-full blur-3xl ${inc?.severity === 'critical' ? 'bg-rose-500/25' : 'bg-amber-400/20'}`}
          />
          <div className="relative flex items-start justify-between gap-4">
            <div className="min-w-0">
              <div className="text-[11px] uppercase tracking-widest text-slate-400">Incident snapshot</div>
              <h2 className={`mt-1 text-lg font-semibold ${inc?.severity === 'critical' ? 'text-rose-200' : 'text-amber-200'}`}>
                {inc?.title ?? 'Loading…'}
              </h2>
              {inc && (
                <div className="mt-2 flex flex-wrap items-center gap-2 text-xs text-slate-400">
                  <Pill tone={STATUS_TONE[inc.status]}>{STATUS_TEXT[inc.status]}</Pill>
                  <Pill tone={inc.severity === 'critical' ? 'bad' : 'warn'}>{inc.severity}</Pill>
                  <span className="font-mono text-slate-300">{inc.deviceId}</span>
                  {inc.storeId && <span>· {inc.storeId}</span>}
                </div>
              )}
            </div>
            <button onClick={onClose} className="rounded-lg p-2 text-slate-400 transition hover:bg-white/5 hover:text-white" aria-label="Close">
              <svg viewBox="0 0 20 20" className="h-5 w-5" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true">
                <path d="M5 5l10 10M15 5L5 15" />
              </svg>
            </button>
          </div>
        </header>

        <div className="flex-1 space-y-5 overflow-y-auto px-6 py-6">
          {error && <p className="text-sm text-slate-400">{error}</p>}
          {!inc && !error && <div className="h-40 animate-pulse rounded-2xl bg-white/[0.04]" />}

          {inc && (
            <>
              <div className="grid grid-cols-3 gap-3 text-sm">
                <Stat label="Started" value={new Date(inc.openedAt).toLocaleString()} />
                <Stat label="Last trigger" value={<Ago ts={inc.updatedAt} />} />
                <Stat
                  label={inc.resolvedAt ? 'Lasted' : 'Duration'}
                  value={formatDuration(Math.round(((inc.resolvedAt ?? Date.now()) - inc.openedAt) / 1000))}
                />
              </div>

              <GlassCard className="p-4">
                <h3 className="mb-3 text-[11px] font-semibold uppercase tracking-widest text-slate-400">
                  What happened · {inc.triggerCount} trigger{inc.triggerCount === 1 ? '' : 's'}
                </h3>
                <ol className="relative space-y-3 border-l border-white/10 pl-5">
                  {inc.triggers.map((t, i) => (
                    <li key={`${t.t}-${i}`} className="relative">
                      <span
                        className={`absolute -left-[23px] top-1.5 h-2 w-2 rounded-full ring-4 ring-[#090b14] ${
                          t.kind === 'resolved' ? 'bg-emerald-400' : t.severity === 'critical' ? PRIORITY.critical.dot : PRIORITY.high.dot
                        }`}
                      />
                      <div className="flex flex-wrap items-baseline gap-x-2">
                        <span className={`text-sm font-medium ${t.kind === 'resolved' ? 'text-emerald-200' : t.severity === 'critical' ? 'text-rose-200' : 'text-amber-200'}`}>
                          {t.title}
                        </span>
                        <span className="text-[11px] text-slate-500">
                          {t.kind === 'event' ? 'event' : t.kind === 'resolved' ? 'recovered' : 'detected'} · {new Date(t.t).toLocaleTimeString()}
                          {t.count > 1 && ` · ×${t.count}, last ${new Date(t.lastAt ?? t.t).toLocaleString()}`}
                        </span>
                      </div>
                      {t.detail && (
                        <pre className="mt-1 max-h-32 overflow-auto whitespace-pre-wrap break-words rounded-lg bg-black/30 p-2 font-mono text-[11px] text-slate-400">
                          {t.detail}
                        </pre>
                      )}
                    </li>
                  ))}
                </ol>
                {inc.triggerCount > inc.triggers.length && (
                  <p className="mt-3 text-[11px] text-slate-500">{inc.triggerCount - inc.triggers.length} intermediate trigger(s) not shown.</p>
                )}
              </GlassCard>

              {ctx && (
                <>
                  <div className="flex items-baseline justify-between">
                    <h3 className="text-[11px] font-semibold uppercase tracking-widest text-slate-400">Device state when captured</h3>
                    <span className="text-[11px] text-slate-500">{new Date(inc.capturedAt).toLocaleString()}</span>
                  </div>
                  {inc.capturedLate && (
                    <p className="rounded-xl bg-amber-400/10 px-3 py-2 text-xs text-amber-200 ring-1 ring-inset ring-amber-400/20">
                      This event arrived late, after an outage. The state below is from when it arrived, not from when it happened.
                    </p>
                  )}

                  <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
                    <Stat label="CPU" value={pct(s?.cpu)} />
                    <Stat label="Memory" value={pct(s?.memPct)} />
                    <Stat label="Disk free" value={s?.diskFreeGB != null ? `${s.diskFreeGB} GB` : '—'} />
                    <Stat label="Uptime" value={formatDuration(s?.uptimeSeconds)} />
                  </div>

                  <div className="flex flex-wrap gap-2">
                    {s?.app ? (
                      <Pill tone={s.app.running ? 'ok' : 'bad'}>
                        POS {s.app.running ? `running${s.app.version ? ` v${s.app.version}` : ''}` : 'not running'}
                      </Pill>
                    ) : (
                      <Pill>POS unknown</Pill>
                    )}
                    {s?.sql && <Pill tone={s.sql.connected ? 'ok' : 'bad'}>SQL {s.sql.connected ? `${s.sql.ms ?? '?'} ms` : 'unreachable'}</Pill>}
                    {s?.api && <Pill tone={s.api.connected ? 'ok' : 'bad'}>API {s.api.connected ? `${s.api.ms ?? '?'} ms` : 'unreachable'}</Pill>}
                    {s?.queue && <Pill tone={s.queue.pending > 500 ? 'warn' : 'neutral'}>queue {s.queue.pending}</Pill>}
                    {(s?.issues ?? []).map((i) => (
                      <Pill key={i.code ?? i.text} tone={i.level === 'critical' ? 'bad' : 'warn'}>
                        {i.text}
                      </Pill>
                    ))}
                  </div>

                  <GlassCard className="p-4">
                    <h3 className="mb-3 text-[11px] font-semibold uppercase tracking-widest text-slate-400">Leading up to it</h3>
                    <div className="grid gap-4 sm:grid-cols-2">
                      <Labeled label="CPU">
                        <AreaChart history={ctx.history} index={H.CPU} className="text-cyan-300" height="h-20" format={(v) => `${Math.round(v)}%`} />
                      </Labeled>
                      <Labeled label="Memory">
                        <AreaChart history={ctx.history} index={H.MEM} className="text-violet-300" height="h-20" format={(v) => `${Math.round(v)}%`} />
                      </Labeled>
                      <Labeled label="POS CPU">
                        <AreaChart history={ctx.history} index={H.APP_CPU} className="text-emerald-300" height="h-20" format={(v) => `${Math.round(v)}%`} />
                      </Labeled>
                      <Labeled label="SQL latency">
                        <AreaChart history={ctx.history} index={H.SQL_MS} max={null} className="text-sky-300" height="h-20" format={(v) => `${Math.round(v)} ms`} />
                      </Labeled>
                    </div>
                  </GlassCard>

                  {ctx.events?.length > 0 && (
                    <GlassCard className="p-4">
                      <h3 className="mb-3 text-[11px] font-semibold uppercase tracking-widest text-slate-400">Events in the window</h3>
                      <ul className="space-y-2">
                        {ctx.events.map((e) => (
                          <li key={e.id} className="text-sm">
                            <div className="flex items-baseline gap-2">
                              <span className={`h-1.5 w-1.5 shrink-0 translate-y-[-1px] rounded-full ${PRIORITY[e.priority]?.dot ?? PRIORITY.normal.dot}`} />
                              <span className={PRIORITY[e.priority]?.text ?? ''}>{e.title}</span>
                              <span className="ml-auto shrink-0 text-[11px] text-slate-500">{new Date(e.t).toLocaleTimeString()}</span>
                            </div>
                            {e.detail && <div className="mt-0.5 line-clamp-2 pl-3.5 text-xs text-slate-400">{e.detail}</div>}
                          </li>
                        ))}
                      </ul>
                    </GlassCard>
                  )}

                  {ctx.application && (
                    <GlassCard className="p-4 text-sm">
                      <h3 className="mb-3 text-[11px] font-semibold uppercase tracking-widest text-slate-400">POS process</h3>
                      <dl className="grid grid-cols-2 gap-x-6 gap-y-1.5">
                        <Row k="Process id" v={ctx.application.processId ?? '—'} />
                        <Row k="Instances" v={ctx.application.instanceCount ?? '—'} />
                        <Row k="Working set" v={ctx.application.workingSetMB != null ? `${ctx.application.workingSetMB} MB` : '—'} />
                        <Row k="Process uptime" v={formatDuration(ctx.application.uptimeSeconds)} />
                      </dl>
                    </GlassCard>
                  )}
                </>
              )}
            </>
          )}
        </div>
      </div>
    </div>
  );
}

function Stat({ label, value }) {
  return (
    <GlassCard className="p-3">
      <div className="text-[10px] uppercase tracking-widest text-slate-500">{label}</div>
      <div className="mt-1 text-sm font-semibold tabular-nums text-slate-100">{value}</div>
    </GlassCard>
  );
}

function Labeled({ label, children }) {
  return (
    <div>
      <div className="mb-1 text-[11px] text-slate-500">{label}</div>
      {children}
    </div>
  );
}

function Row({ k, v }) {
  return (
    <div className="flex justify-between gap-3">
      <dt className="text-slate-400">{k}</dt>
      <dd className="tabular-nums text-slate-200">{v}</dd>
    </div>
  );
}

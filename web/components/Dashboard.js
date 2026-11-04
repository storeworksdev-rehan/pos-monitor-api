'use client';

import { apiUrl } from '@/lib/api';
import { memo, useCallback, useDeferredValue, useEffect, useMemo, useRef, useState } from 'react';
import DeviceDrawer from './DeviceDrawer';
import IncidentDrawer from './IncidentDrawer';
import {
  Ago,
  GlassCard,
  Meter,
  PRIORITY,
  FilterInput,
  Pill,
  Ring,
  STATUS,
  Segmented,
  Select,
  Sparkline,
  StatusDot,
  formatBytes,
  pct,
  statusOf,
  useNow,
} from './ui';

const toMap = (list) => new Map(list.map((d) => [d.deviceId, d]));
const MAX_ALERTS = 120;
const EXPANDED_KEY = 'pos-monitor.expanded-stores';
const STORES_PER_PAGE = 40;

// Problem filter: issue codes from the API, plus connection state and open incidents.
const PROBLEMS = [
  ['any', 'Any problem'],
  ['pos-down', 'POS down'],
  ['pos-hung', 'POS not responding'],
  ['sql-down', 'SQL unreachable'],
  ['offline', 'Offline'],
  ['stale', 'Delayed'],
  ['incident', 'Incident open'],
  ['cpu-high', 'High CPU'],
  ['mem-high', 'High memory'],
  ['disk-low', 'Low disk'],
  ['backlog', 'Upload backlog'],
  ['upload-failing', 'Upload failures'],
];
const SORTS = [
  ['worst', 'Sort: worst first'],
  ['store', 'Sort: store ID'],
  ['silent', 'Sort: longest silent'],
  ['recent', 'Sort: most recent data'],
];

function hasProblem(d, problem, status) {
  if (problem === 'any') return true;
  if (problem === 'offline' || problem === 'stale') return status === problem;
  if (problem === 'incident') return Boolean(d.openIncident);
  return d.issues.some((i) => i.code === problem);
}

export default function Dashboard({ initial }) {
  const [devices, setDevices] = useState(() => toMap(initial.devices));
  const [alerts, setAlerts] = useState(initial.alerts);
  const [incidents, setIncidents] = useState(initial.incidents);
  const [incidentId, setIncidentId] = useState(null);
  const [stats, setStats] = useState(initial.stats);
  const [conn, setConn] = useState('connecting');
  const [query, setQuery] = useState('');
  const [filter, setFilter] = useState('all');
  const [problem, setProblem] = useState('any');
  const [sort, setSort] = useState('worst');
  const [storeLimit, setStoreLimit] = useState(STORES_PER_PAGE);
  const [selectedId, setSelectedId] = useState(null);
  const searchRef = useRef(null);
  const thresholds = initial.thresholds;
  const now = useNow();
  const deferredQuery = useDeferredValue(query);

  useLiveStream(
    {
      snapshot(p) {
        setDevices(toMap(p.devices));
        setAlerts(p.alerts);
        setIncidents(p.incidents);
        setStats(p.stats);
      },
      update(p) {
        if (p.devices.length) {
          setDevices((prev) => {
            const next = new Map(prev);
            for (const d of p.devices) next.set(d.deviceId, d);
            return next;
          });
        }
        if (p.alerts.length) setAlerts((prev) => mergeAlerts(prev, p.alerts));
        if (p.incidents?.length) setIncidents((prev) => mergeIncidents(prev, p.incidents));
        setStats(p.stats);
      },
      // A store or device was removed through the API.
      removed({ deviceIds }) {
        const gone = new Set(deviceIds);
        setDevices((prev) => new Map([...prev].filter(([id]) => !gone.has(id))));
        setAlerts((prev) => prev.filter((a) => !gone.has(a.deviceId)));
        setIncidents((prev) => prev.filter((i) => !gone.has(i.deviceId)));
        setSelectedId((id) => (gone.has(id) ? null : id));
      },
      stats: setStats,
    },
    setConn,
  );

  // "/" focuses search, Escape closes the drawer or clears search.
  useEffect(() => {
    const onKey = (e) => {
      if (e.key === '/' && document.activeElement?.tagName !== 'INPUT') {
        e.preventDefault();
        searchRef.current?.focus();
      } else if (e.key === 'Escape') {
        if (incidentId) setIncidentId(null);
        else if (selectedId) setSelectedId(null);
        else if (document.activeElement === searchRef.current) {
          setQuery('');
          searchRef.current.blur();
        }
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [selectedId, incidentId]);

  const list = useMemo(() => [...devices.values()], [devices]);

  const counts = useMemo(() => {
    const c = { online: 0, stale: 0, offline: 0, attention: 0, posRunning: 0, posKnown: 0, sqlOk: 0, sqlKnown: 0, problems: {} };
    for (const d of list) {
      const s = statusOf(d.lastSeen, now, thresholds);
      c[s]++;
      for (const [key] of PROBLEMS) {
        if (key !== 'any' && hasProblem(d, key, s)) c.problems[key] = (c.problems[key] ?? 0) + 1;
      }
      if (s !== 'online' || d.issues.length) c.attention++;
      if (d.app) {
        c.posKnown++;
        if (d.app.running) c.posRunning++;
      }
      if (d.sql) {
        c.sqlKnown++;
        if (d.sql.connected) c.sqlOk++;
      }
    }
    return c;
  }, [list, now, thresholds]);

  const criticalToday = useMemo(
    () => alerts.filter((a) => a.priority === 'critical' && now - a.t < 86_400_000).length,
    [alerts, now],
  );

  const groups = useMemo(() => {
    const q = deferredQuery.trim().toLowerCase();
    const storeSize = new Map();
    for (const d of list) storeSize.set(d.storeId ?? 'Unassigned', (storeSize.get(d.storeId ?? 'Unassigned') ?? 0) + 1);
    const filtered = list.filter((d) => {
      const s = statusOf(d.lastSeen, now, thresholds);
      if (filter === 'attention' && s === 'online' && d.issues.length === 0) return false;
      if (filter === 'offline' && s === 'online') return false;
      if (!hasProblem(d, problem, s)) return false;
      if (!q) return true;
      return (
        d.deviceId.toLowerCase().includes(q) ||
        (d.storeId ?? '').toLowerCase().includes(q) ||
        d.issues.some((i) => i.text.toLowerCase().includes(q))
      );
    });
    const byStore = new Map();
    for (const d of filtered) {
      const key = d.storeId ?? 'Unassigned';
      if (!byStore.has(key)) byStore.set(key, []);
      byStore.get(key).push(d);
    }
    const severity = (d) => (d.issues.some((i) => i.level === 'critical') ? 0 : d.issues.length ? 1 : 2);
    const order = {
      worst: (a, b) => a.worst - b.worst || a.store.localeCompare(b.store),
      store: (a, b) => a.store.localeCompare(b.store, undefined, { numeric: true }),
      silent: (a, b) => a.lastSeen - b.lastSeen,
      recent: (a, b) => b.lastSeen - a.lastSeen,
    }[sort];
    return [...byStore.entries()]
      .map(([store, items]) => ({
        store,
        total: storeSize.get(store) ?? items.length,
        items: items.sort((a, b) => severity(a) - severity(b) || a.deviceId.localeCompare(b.deviceId)),
        worst: Math.min(...items.map(severity)),
        lastSeen: Math.max(...items.map((d) => d.lastSeen ?? 0)),
      }))
      .sort(order);
  }, [list, deferredQuery, filter, problem, sort, now, thresholds]);

  // A new filter starts again from the first page of stores.
  useEffect(() => setStoreLimit(STORES_PER_PAGE), [deferredQuery, filter, problem, sort]);
  const filtersActive = query !== '' || filter !== 'all' || problem !== 'any' || sort !== 'worst';
  const clearFilters = () => {
    setQuery('');
    setFilter('all');
    setProblem('any');
    setSort('worst');
  };

  const select = useCallback((id) => setSelectedId(id), []);

  // Stores are collapsed rows; register cards render only for expanded stores (remembered per browser).
  // Searching, or a fleet of three stores or fewer, shows every card.
  const [expanded, setExpanded] = useState(() => new Set());
  useEffect(() => {
    try {
      const saved = JSON.parse(localStorage.getItem(EXPANDED_KEY) ?? '[]');
      if (Array.isArray(saved)) setExpanded(new Set(saved));
    } catch {
      // storage unavailable: start collapsed
    }
  }, []);
  const setExpandedAll = useCallback((stores) => {
    setExpanded(new Set(stores));
    try {
      localStorage.setItem(EXPANDED_KEY, JSON.stringify(stores));
    } catch {
      // not remembered, still works
    }
  }, []);
  const toggleStore = useCallback((store) => {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(store)) next.delete(store);
      else next.add(store);
      try {
        localStorage.setItem(EXPANDED_KEY, JSON.stringify([...next]));
      } catch {
        // not remembered, still works
      }
      return next;
    });
  }, []);
  const autoOpen = deferredQuery.trim() !== '' || groups.length <= 3;

  const total = list.length;
  const healthy = list.filter((d) => statusOf(d.lastSeen, now, thresholds) === 'online' && d.issues.length === 0).length;

  return (
    <div className="relative min-h-screen overflow-x-hidden">
      <Aurora />

      <div className="relative mx-auto max-w-[1680px] px-4 pb-16 pt-6 sm:px-6 lg:px-8">
        <Header conn={conn} stats={stats} />

        {/* KPIs */}
        <section className="mt-6 grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-[minmax(300px,1.3fr)_repeat(4,minmax(0,1fr))]">
          <GlassCard className="flex items-center gap-5 p-5 sm:col-span-2 lg:col-span-1">
            <Ring
              segments={[
                { key: 'ok', value: healthy, className: 'text-emerald-400' },
                { key: 'warn', value: counts.online - healthy, className: 'text-amber-400' },
                { key: 'stale', value: counts.stale, className: 'text-orange-400' },
                { key: 'off', value: counts.offline, className: 'text-slate-600' },
              ]}
            >
              <div>
                <div className="text-3xl font-semibold tabular-nums tracking-tight">{total ? Math.round((healthy / total) * 100) : 0}%</div>
                <div className="text-[11px] uppercase tracking-widest text-slate-400">healthy</div>
              </div>
            </Ring>
            <div className="space-y-2 text-sm">
              <Legend className="bg-emerald-400" label="Healthy" value={healthy} />
              <Legend className="bg-amber-400" label="Online with issues" value={counts.online - healthy} />
              <Legend className="bg-orange-400" label="Delayed" value={counts.stale} />
              <Legend className="bg-slate-600" label="Offline" value={counts.offline} />
            </div>
          </GlassCard>
          <Kpi label="Devices online" value={counts.online} of={total} accent="from-cyan-400/20" />
          <Kpi label="POS running" value={counts.posRunning} of={counts.posKnown} accent="from-emerald-400/20" bad={counts.posRunning < counts.posKnown} />
          <Kpi label="SQL reachable" value={counts.sqlOk} of={counts.sqlKnown} accent="from-violet-400/20" bad={counts.sqlOk < counts.sqlKnown} />
          <Kpi label="Critical, 24 h" value={criticalToday} accent="from-rose-500/25" bad={criticalToday > 0} />
        </section>

        {/* Toolbar */}
        <section className="mt-6 flex flex-wrap items-center gap-2">
          <label className="relative w-full sm:w-72">
            <span className="sr-only">Search devices</span>
            <svg className="pointer-events-none absolute left-3.5 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-500" viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
              <circle cx="9" cy="9" r="6" />
              <path d="m14 14 4 4" strokeLinecap="round" />
            </svg>
            <input
              ref={searchRef}
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Search store, register, issue"
              className="w-full rounded-xl border border-white/10 bg-white/[0.04] py-2.5 pl-10 pr-12 text-sm placeholder:text-slate-500 focus:border-cyan-400/50 focus:outline-none focus:ring-4 focus:ring-cyan-400/10"
            />
            <kbd className="absolute right-3 top-1/2 -translate-y-1/2 rounded-md border border-white/10 px-1.5 text-[11px] text-slate-500">/</kbd>
          </label>
          <div className="flex flex-wrap items-center gap-2">
            <Select
              label="Status"
              value={filter}
              onChange={setFilter}
              options={[
                ['all', `All registers (${total})`],
                ['attention', `Needs attention (${counts.attention})`],
                ['offline', `Not online (${counts.stale + counts.offline})`],
              ]}
            />
            <Select
              label="Problem"
              value={problem}
              onChange={setProblem}
              options={PROBLEMS.map(([key, text]) => [key, key === 'any' ? text : `${text} (${counts.problems[key] ?? 0})`])}
            />
            <Select label="Sort" value={sort} onChange={setSort} options={SORTS} />
            {filtersActive && (
              <button onClick={clearFilters} className="rounded-lg px-2.5 py-2 text-sm text-cyan-300 transition hover:bg-white/5">
                Clear filters
              </button>
            )}
          </div>
        </section>

        <div className="mt-6 grid grid-cols-1 gap-6 xl:grid-cols-[minmax(0,1fr)_380px]">
          <main className="min-w-0 space-y-3">
            {total === 0 ? (
              <EmptyState />
            ) : groups.length === 0 ? (
              <p className="py-16 text-center text-sm text-slate-500">
                No registers match.{' '}
                <button onClick={clearFilters} className="text-cyan-300 hover:underline">
                  Clear filters
                </button>
              </p>
            ) : (
              <>
                <div className="flex items-center gap-3 text-xs text-slate-500">
                  <span>
                    {groups.length} store{groups.length === 1 ? '' : 's'} · {groups.reduce((n, g) => n + g.items.length, 0)} registers
                    {autoOpen && groups.length > 3 && ' · showing every match'}
                  </span>
                  <span className="ml-auto flex gap-1">
                    <button onClick={() => setExpandedAll(groups.map((g) => g.store))} className="rounded-lg px-2 py-1 transition hover:bg-white/5 hover:text-slate-200">
                      Expand all
                    </button>
                    <button onClick={() => setExpandedAll([])} className="rounded-lg px-2 py-1 transition hover:bg-white/5 hover:text-slate-200">
                      Collapse all
                    </button>
                  </span>
                </div>
                {groups.slice(0, storeLimit).map((g) => (
                  <StoreGroup
                    key={g.store}
                    group={g}
                    open={autoOpen || expanded.has(g.store)}
                    onToggle={toggleStore}
                    thresholds={thresholds}
                    onSelect={select}
                  />
                ))}
                {groups.length > storeLimit && (
                  <button
                    onClick={() => setStoreLimit((n) => n + STORES_PER_PAGE)}
                    className="w-full rounded-2xl border border-dashed border-white/10 py-3 text-sm text-slate-400 transition hover:border-white/20 hover:text-slate-200"
                  >
                    Show {Math.min(STORES_PER_PAGE, groups.length - storeLimit)} more stores · {groups.length - storeLimit} not shown
                  </button>
                )}
              </>
            )}
          </main>

          <SidePanel alerts={alerts} incidents={incidents} onSelectDevice={select} onSelectIncident={setIncidentId} />
        </div>
      </div>

      {selectedId && (
        <DeviceDrawer
          key={selectedId}
          deviceId={selectedId}
          summary={devices.get(selectedId)}
          thresholds={thresholds}
          fileRoot={stats.fileRoot ?? String.raw`C:\XeniaRetail\Logs`}
          onClose={() => setSelectedId(null)}
          onOpenIncident={setIncidentId}
        />
      )}
      {incidentId && <IncidentDrawer key={incidentId} incidentId={incidentId} onClose={() => setIncidentId(null)} />}
    </div>
  );
}

function mergeIncidents(prev, incoming) {
  const byId = new Map(prev.map((i) => [i.id, i]));
  for (const i of incoming) byId.set(i.id, i);
  return [...byId.values()].sort((a, b) => b.updatedAt - a.updatedAt).slice(0, MAX_ALERTS);
}

function mergeAlerts(prev, incoming) {
  const seen = new Set();
  return [...incoming, ...prev]
    .filter((a) => (seen.has(a.id) ? false : (seen.add(a.id), true)))
    .sort((a, b) => b.t - a.t)
    .slice(0, MAX_ALERTS);
}

/**
 * EventSource with auto-reconnect. The stream closes 30 s after the tab is hidden
 * and reopens (with a fresh snapshot) when it is visible again.
 */
function useLiveStream(handlers, setConn) {
  const ref = useRef(handlers);
  ref.current = handlers;

  useEffect(() => {
    let es = null;
    let hideTimer = null;
    let retryTimer = null;

    const open = () => {
      if (es) return;
      setConn('connecting');
      es = new EventSource(apiUrl('/api/stream'));
      es.onopen = () => setConn('live');
      es.onerror = () => {
        if (es?.readyState === EventSource.CLOSED) {
          es = null;
          setConn('offline');
          retryTimer = setTimeout(open, 5000);
        } else {
          setConn('reconnecting');
        }
      };
      for (const type of ['snapshot', 'update', 'removed', 'stats']) {
        es.addEventListener(type, (e) => ref.current[type](JSON.parse(e.data)));
      }
    };
    const close = () => {
      es?.close();
      es = null;
      setConn('paused');
    };
    const onVisibility = () => {
      clearTimeout(hideTimer);
      if (document.hidden) hideTimer = setTimeout(close, 30000);
      else open();
    };

    open();
    document.addEventListener('visibilitychange', onVisibility);
    return () => {
      document.removeEventListener('visibilitychange', onVisibility);
      clearTimeout(hideTimer);
      clearTimeout(retryTimer);
      es?.close();
    };
  }, [setConn]);
}

// ------------------------------------------------------------------ pieces

function Aurora() {
  // Static gradients: the glow costs nothing after first paint.
  return (
    <div aria-hidden="true" className="pointer-events-none fixed inset-0 overflow-hidden">
      <div className="absolute -left-40 -top-40 h-[520px] w-[520px] rounded-full bg-cyan-500/[0.13] blur-[120px]" />
      <div className="absolute -right-32 top-24 h-[460px] w-[460px] rounded-full bg-violet-600/[0.14] blur-[120px]" />
      <div className="absolute bottom-[-200px] left-1/3 h-[480px] w-[640px] rounded-full bg-emerald-500/[0.08] blur-[140px]" />
      <div className="absolute inset-0 bg-[radial-gradient(rgba(255,255,255,0.045)_1px,transparent_1px)] [background-size:22px_22px] [mask-image:radial-gradient(ellipse_at_top,black,transparent_70%)]" />
    </div>
  );
}

function Header({ conn, stats }) {
  const live = {
    live: ['Live', 'bg-emerald-400', 'text-emerald-200'],
    connecting: ['Connecting', 'bg-sky-400', 'text-sky-200'],
    reconnecting: ['Reconnecting', 'bg-amber-400', 'text-amber-200'],
    offline: ['API unreachable', 'bg-rose-500', 'text-rose-200'],
    paused: ['Paused', 'bg-slate-400', 'text-slate-300'],
  }[conn];
  const storage = stats.storage;
  const storageBadge =
    storage.mode === 'unknown'
      ? { tone: 'bad', text: 'Waiting for API', title: 'The Express API is not reachable. Retrying automatically.' }
      : storage.mode === 'memory'
      ? { tone: 'neutral', text: 'In-memory · snapshot', title: 'No database configured. State is kept in memory and saved to a snapshot file.' }
      : storage.state === 'connected'
        ? { tone: 'ok', text: 'MongoDB', title: 'Every event is archived in MongoDB.' }
        : {
            tone: 'warn',
            text: `MongoDB ${storage.state === 'connecting' ? 'connecting' : 'offline'}${storage.spoolBytes ? ` · spooled ${formatBytes(storage.spoolBytes)}` : ''}`,
            title: storage.lastError ?? 'Events are spooled to disk and replayed when MongoDB returns.',
          };

  return (
    <header className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
      <div className="flex items-center gap-3">
        <div className="grid h-11 w-11 place-items-center rounded-xl bg-gradient-to-br from-cyan-400 to-violet-500 shadow-lg shadow-cyan-500/20">
          <svg viewBox="0 0 24 24" className="h-6 w-6 text-slate-950" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <path d="M3 12h4l2-6 4 12 2-6h6" />
          </svg>
        </div>
        <div>
          <h1 className="text-xl font-semibold tracking-tight">
            POS Fleet{' '}
            <span className="bg-gradient-to-r from-cyan-300 to-violet-300 bg-clip-text text-transparent">Monitor</span>
          </h1>
          <p className="text-xs text-slate-400">System, POS application, SQL and error telemetry from every store</p>
        </div>
      </div>
      <div className="flex flex-wrap items-center gap-2 text-xs">
        <span className={`inline-flex items-center gap-2 rounded-full border border-white/10 bg-white/[0.04] px-3 py-1.5 ${live[2]}`}>
          <span className="relative flex h-2 w-2">
            {conn === 'live' && <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-emerald-400 opacity-60" />}
            <span className={`relative inline-flex h-2 w-2 rounded-full ${live[1]}`} />
          </span>
          {live[0]}
        </span>
        <Pill tone={storageBadge.tone} title={storageBadge.title}>{storageBadge.text}</Pill>
        <Pill title={`Routine data is deleted after ${stats.windowMinutes} minutes. Failures, errors and warnings are kept as incident snapshots for ${stats.incidentRetentionDays} days.`}>
          live window {stats.windowMinutes} min · incidents {stats.incidentRetentionDays} d
        </Pill>
        <Pill title="Events received in the last minute">{stats.eventsPerMinute.toLocaleString()} events/min</Pill>
        <Pill title="Server memory (RSS)">{stats.memoryMB} MB</Pill>
      </div>
    </header>
  );
}

function Legend({ className, label, value }) {
  return (
    <div className="flex items-center gap-2.5">
      <span className={`h-2 w-2 rounded-full ${className}`} />
      <span className="text-slate-400">{label}</span>
      <span className="ml-auto pl-4 font-medium tabular-nums">{value}</span>
    </div>
  );
}

function Kpi({ label, value, of, accent, bad }) {
  return (
    <GlassCard className="relative overflow-hidden p-5">
      <div className={`pointer-events-none absolute -right-10 -top-10 h-32 w-32 rounded-full bg-gradient-to-br ${accent} to-transparent blur-2xl`} />
      <div className="text-[11px] uppercase tracking-widest text-slate-400">{label}</div>
      <div className="mt-3 flex items-baseline gap-1.5">
        <span className={`text-4xl font-semibold tabular-nums tracking-tight ${bad ? 'text-rose-300' : ''}`}>{value}</span>
        {of != null && <span className="text-lg text-slate-500 tabular-nums">/ {of}</span>}
      </div>
    </GlassCard>
  );
}

const DeviceCard = memo(function DeviceCard({ d, thresholds, onSelect }) {
  const now = useNow();
  const status = statusOf(d.lastSeen, now, thresholds);
  const critical = d.issues.some((i) => i.level === 'critical');
  const frame =
    status === 'offline'
      ? 'border-white/5 opacity-60 saturate-50'
      : critical
        ? 'border-rose-500/40 shadow-[0_0_40px_-12px] shadow-rose-500/50'
        : d.issues.length
          ? 'border-amber-400/30'
          : 'border-white/[0.07]';

  return (
    <button
      onClick={() => onSelect(d.deviceId)}
      className={`group relative w-full animate-rise overflow-hidden rounded-2xl border bg-gradient-to-b from-white/[0.06] to-white/[0.015] p-4 text-left backdrop-blur-xl transition duration-300 hover:-translate-y-0.5 hover:border-cyan-300/30 hover:from-white/[0.08] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-cyan-400/60 ${frame}`}
    >
      {/* one-shot glow whenever fresh data lands */}
      <span key={d.lastSeen} className="pointer-events-none absolute inset-0 animate-flash rounded-2xl" />

      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <StatusDot status={status} />
            <span className="truncate font-mono text-sm font-semibold text-slate-100">{d.deviceId}</span>
          </div>
          <div className="mt-0.5 truncate pl-4 text-[11px] text-slate-500">
            {[d.os, d.agentVersion && `agent ${d.agentVersion}`].filter(Boolean).join(' · ') || 'waiting for metrics'}
          </div>
        </div>
        <div className={`shrink-0 text-right text-[11px] ${STATUS[status].text}`}>
          <Ago ts={d.lastSeen} />
        </div>
      </div>

      <div className="mt-4 flex items-end justify-between gap-3">
        <div>
          <div className="text-[10px] uppercase tracking-widest text-slate-500">CPU</div>
          <div className="text-2xl font-semibold tabular-nums tracking-tight">{pct(d.cpu)}</div>
        </div>
        <Sparkline values={d.spark} className={`h-10 w-36 ${d.cpu >= 90 ? 'text-rose-400' : d.cpu >= 70 ? 'text-amber-300' : 'text-cyan-300'}`} />
      </div>

      <div className="mt-3 grid grid-cols-2 gap-3">
        <Meter label="Memory" value={d.memPct} display={pct(d.memPct)} warnAt={85} badAt={92} />
        <Meter
          label="Disk free"
          value={d.diskFreePct}
          display={d.diskFreeGB != null ? `${d.diskFreeGB} GB` : '—'}
          warnAt={20}
          badAt={10}
          invert
        />
      </div>

      <div className="mt-4 flex flex-wrap gap-1.5">
        {d.app ? (
          <Pill tone={d.app.running ? (d.app.responding === false ? 'bad' : 'ok') : 'bad'}>
            <span className={`h-1.5 w-1.5 rounded-full ${d.app.running ? 'bg-emerald-400' : 'bg-rose-400'}`} />
            POS {d.app.running ? (d.app.version ? `v${d.app.version}` : 'running') : 'down'}
          </Pill>
        ) : (
          <Pill>POS unknown</Pill>
        )}
        {d.sql && (
          <Pill tone={d.sql.connected ? 'ok' : 'bad'}>SQL {d.sql.connected ? (d.sql.ms != null ? `${d.sql.ms} ms` : 'ok') : 'down'}</Pill>
        )}
        {d.openIncident && (
          <Pill tone={d.openIncident.severity === 'critical' ? 'bad' : 'warn'} title={d.openIncident.title}>
            incident open
          </Pill>
        )}
        {d.queue && d.queue.pending > 0 && (
          <Pill tone={d.queue.pending > 500 ? 'warn' : 'neutral'} title="Events waiting in the agent's local queue">
            queue {d.queue.pending}
          </Pill>
        )}
      </div>

      {d.issues.length > 0 && (
        <div className="mt-3 flex flex-wrap gap-1.5 border-t border-white/5 pt-3">
          {d.issues.map((i) => (
            <span key={i.text} className={`text-[11px] font-medium ${i.level === 'critical' ? 'text-rose-300' : 'text-amber-200'}`}>
              {i.level === 'critical' ? '● ' : '▲ '}
              {i.text}
            </span>
          ))}
        </div>
      )}
    </button>
  );
});

/** Colour of one register's dot: critical issue, other issue, offline, delayed, healthy. */
function registerTone(d, status) {
  if (status === 'offline') return 'bg-slate-500';
  if (d.issues.some((i) => i.level === 'critical')) return 'bg-rose-500 shadow-[0_0_8px_1px] shadow-rose-500/60';
  if (d.issues.length || status === 'stale') return 'bg-amber-400';
  return 'bg-emerald-400';
}

/**
 * One store: a compact row with its overall state and a dot per register (click one to open it).
 * The register cards render only when the store is expanded, which keeps a 200-store fleet light.
 */
const StoreGroup = memo(function StoreGroup({ group, open, onToggle, thresholds, onSelect }) {
  const now = useNow();
  const { store, items } = group;

  const s = useMemo(() => {
    const out = { offline: 0, stale: 0, posDown: 0, sqlDown: 0, incidents: 0, issues: new Map(), lastSeen: 0, statuses: [] };
    for (const d of items) {
      const status = statusOf(d.lastSeen, now, thresholds);
      out.statuses.push(status);
      if (status === 'offline') out.offline++;
      else if (status === 'stale') out.stale++;
      if (d.app && !d.app.running) out.posDown++;
      if (d.sql && !d.sql.connected) out.sqlDown++;
      if (d.openIncident) out.incidents++;
      for (const i of d.issues) {
        if (i.code !== 'pos-down' && i.code !== 'sql-down') out.issues.set(i.text, i.level);
      }
      out.lastSeen = Math.max(out.lastSeen, d.lastSeen ?? 0);
    }
    return out;
  }, [items, now, thresholds]);

  const worst = group.worst === 0 ? 'critical' : group.worst === 1 || s.stale ? 'warn' : s.offline === items.length ? 'offline' : 'ok';
  const frame = {
    critical: 'border-rose-500/40 bg-rose-500/[0.06]',
    warn: 'border-amber-400/25 bg-amber-400/[0.04]',
    offline: 'border-white/5 bg-white/[0.02] opacity-70',
    ok: 'border-white/[0.07] bg-white/[0.03]',
  }[worst];
  const healthy = !s.offline && !s.stale && !s.posDown && !s.sqlDown && !s.incidents && s.issues.size === 0;

  return (
    <section>
      <div className={`flex flex-wrap items-center gap-x-4 gap-y-2 rounded-2xl border px-4 py-3 backdrop-blur-xl transition ${frame}`}>
        <button
          onClick={() => onToggle(store)}
          aria-expanded={open}
          className="flex min-w-0 flex-1 items-center gap-3 text-left focus-visible:outline-none"
        >
          <svg viewBox="0 0 20 20" className={`h-4 w-4 shrink-0 text-slate-500 transition ${open ? 'rotate-90' : ''}`} fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
            <path d="m8 5 5 5-5 5" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
          <h2 className="shrink-0 font-mono text-sm font-semibold tracking-wide text-slate-100">{store}</h2>
          <span className="shrink-0 text-xs text-slate-500">
            {items.length < group.total ? `${items.length} of ${group.total} registers` : `${items.length} register${items.length === 1 ? '' : 's'}`}
          </span>
          <span className="flex min-w-0 flex-wrap gap-1.5">
            {healthy && <Pill tone="ok">All OK</Pill>}
            {s.posDown > 0 && <Pill tone="bad">POS down {s.posDown}</Pill>}
            {s.sqlDown > 0 && <Pill tone="bad">SQL down {s.sqlDown}</Pill>}
            {s.offline > 0 && <Pill>{s.offline} offline</Pill>}
            {s.stale > 0 && <Pill tone="warn">{s.stale} delayed</Pill>}
            {s.incidents > 0 && <Pill tone="bad">{s.incidents} incident{s.incidents === 1 ? '' : 's'} open</Pill>}
            {[...s.issues].slice(0, 2).map(([text, level]) => (
              <Pill key={text} tone={level === 'critical' ? 'bad' : 'warn'}>
                {text}
              </Pill>
            ))}
          </span>
        </button>
        <div className="ml-auto flex shrink-0 items-center gap-3">
          <span className="flex items-center gap-1.5">
            {items.map((d, i) => (
              <button
                key={d.deviceId}
                onClick={() => onSelect(d.deviceId)}
                title={`${d.deviceId} · ${STATUS[s.statuses[i]].label}${d.issues.length ? ` · ${d.issues.map((x) => x.text).join(', ')}` : ''}`}
                aria-label={`Open ${d.deviceId}`}
                className={`h-3 w-3 rounded-full ring-2 ring-transparent transition hover:ring-white/40 ${registerTone(d, s.statuses[i])}`}
              />
            ))}
          </span>
          <span className="w-20 text-right text-[11px] text-slate-500">
            <Ago ts={s.lastSeen} />
          </span>
        </div>
      </div>
      {open && (
        <div className="mt-3 grid grid-cols-1 gap-4 sm:grid-cols-2 2xl:grid-cols-3">
          {items.map((d) => (
            <DeviceCard key={d.deviceId} d={d} thresholds={thresholds} onSelect={onSelect} />
          ))}
        </div>
      )}
    </section>
  );
});

const ALERT_KIND = {
  critical: (a) => a.priority === 'critical' || a.level === 'critical',
  error: (a) => a.level === 'error' || (a.priority === 'high' && !a.level),
  warning: (a) => a.level === 'warning',
};

function SidePanel({ alerts, incidents, onSelectDevice, onSelectIncident }) {
  const [tab, setTab] = useState('incidents');
  const [text, setText] = useState('');
  const [incidentView, setIncidentView] = useState('all');
  const [alertView, setAlertView] = useState('all');
  const active = incidents.filter((i) => i.status === 'active').length;

  const q = text.trim().toLowerCase();
  const matches = (x) =>
    !q || x.deviceId?.toLowerCase().includes(q) || (x.storeId ?? '').toLowerCase().includes(q) || x.title?.toLowerCase().includes(q);
  const incidentKinds = {
    all: () => true,
    active: (i) => i.status === 'active',
    critical: (i) => i.severity === 'critical',
  };
  const textIncidents = incidents.filter(matches);
  const shownIncidents = textIncidents.filter(incidentKinds[incidentView]);
  const textAlerts = alerts.filter(matches);
  const shownAlerts = alertView === 'all' ? textAlerts : textAlerts.filter(ALERT_KIND[alertView]);
  const count = (list, fn) => list.filter(fn).length;
  return (
    <aside className="xl:sticky xl:top-6 xl:self-start">
      <GlassCard className="flex max-h-[calc(100vh-3rem)] flex-col overflow-hidden">
        <div className="flex items-center gap-1 border-b border-white/5 p-2">
          {[
            ['incidents', 'Incidents', active ? `${active} active` : incidents.length || null],
            ['alerts', 'Live alerts', alerts.length || null],
          ].map(([key, label, badge]) => (
            <button
              key={key}
              onClick={() => setTab(key)}
              className={`flex items-center gap-2 rounded-lg px-3 py-1.5 text-sm transition ${tab === key ? 'bg-white/10 text-white' : 'text-slate-400 hover:text-slate-200'}`}
            >
              {label}
              {badge != null && (
                <span className={`rounded-full px-1.5 text-[10px] tabular-nums ${key === 'incidents' && active ? 'bg-rose-500/20 text-rose-200' : 'bg-white/10 text-slate-300'}`}>
                  {badge}
                </span>
              )}
            </button>
          ))}
        </div>
        <div className="space-y-2 border-b border-white/5 p-2">
          <FilterInput value={text} onChange={setText} placeholder="Filter by store, register or text" />
          {tab === 'incidents' ? (
            <Segmented
              size="sm"
              label="Incident filter"
              value={incidentView}
              onChange={setIncidentView}
              options={[
                ['all', 'All', textIncidents.length],
                ['active', 'Active', count(textIncidents, incidentKinds.active)],
                ['critical', 'Critical', count(textIncidents, incidentKinds.critical)],
              ]}
            />
          ) : (
            <Segmented
              size="sm"
              label="Alert filter"
              value={alertView}
              onChange={setAlertView}
              options={[
                ['all', 'All', textAlerts.length],
                ['critical', 'Critical', count(textAlerts, ALERT_KIND.critical)],
                ['error', 'Errors', count(textAlerts, ALERT_KIND.error)],
                ['warning', 'Warnings', count(textAlerts, ALERT_KIND.warning)],
              ]}
            />
          )}
        </div>
        {tab === 'incidents' ? (
          <IncidentList incidents={shownIncidents} filtered={shownIncidents.length < incidents.length} onSelect={onSelectIncident} />
        ) : (
          <AlertList alerts={shownAlerts} filtered={shownAlerts.length < alerts.length} onSelect={onSelectDevice} />
        )}
      </GlassCard>
    </aside>
  );
}

const INCIDENT_STATUS = {
  active: 'bg-rose-500/15 text-rose-200 ring-rose-500/30',
  resolved: 'bg-emerald-400/10 text-emerald-200 ring-emerald-400/25',
  recorded: 'bg-white/5 text-slate-300 ring-white/10',
};

function IncidentList({ incidents, filtered, onSelect }) {
  return (
    <ol className="flex-1 space-y-1 overflow-y-auto p-2">
      {incidents.length === 0 && (
        <li className="px-3 py-10 text-center text-sm text-slate-500">
          {filtered ? 'No incidents match the filter.' : 'No incidents. Failures, errors and warnings are captured here as snapshots.'}
        </li>
      )}
      {incidents.map((i) => (
        <li key={i.id} className="animate-slide-in">
          <button onClick={() => onSelect(i.id)} className="w-full rounded-xl px-3 py-2.5 text-left transition hover:bg-white/[0.05]">
            <div className="flex items-center gap-2">
              <span className={`h-1.5 w-1.5 shrink-0 rounded-full ${i.severity === 'critical' ? PRIORITY.critical.dot : PRIORITY.high.dot}`} />
              <span className={`truncate text-sm font-medium ${i.severity === 'critical' ? 'text-rose-200' : 'text-amber-200'}`}>{i.title}</span>
              <span className={`ml-auto shrink-0 rounded-full px-1.5 py-px text-[10px] ring-1 ring-inset ${INCIDENT_STATUS[i.status]}`}>{i.status}</span>
            </div>
            <div className="mt-0.5 flex gap-2 pl-3.5 text-[11px] text-slate-500">
              <span className="truncate font-mono">{i.deviceId}</span>
              <span className="ml-auto shrink-0">
                {i.repeats > 0 && `repeated ×${i.repeats} · `}
                {i.triggerCount > 1 && `${i.triggerCount} triggers · `}
                <Ago ts={i.updatedAt} />
              </span>
            </div>
            {i.lastTrigger && <div className="mt-1 truncate pl-3.5 text-xs text-slate-400">latest: {i.lastTrigger}</div>}
          </button>
        </li>
      ))}
    </ol>
  );
}

function AlertList({ alerts, filtered, onSelect }) {
  return (
    <ol className="flex-1 space-y-1 overflow-y-auto p-2">
      {alerts.length === 0 && (
        <li className="px-3 py-10 text-center text-sm text-slate-500">{filtered ? 'No alerts match the filter.' : 'All quiet. Nothing needs attention.'}</li>
      )}
      {alerts.map((a) => (
        <li key={a.id} className="animate-slide-in">
          <button onClick={() => onSelect(a.deviceId)} className="w-full rounded-xl px-3 py-2.5 text-left transition hover:bg-white/[0.05]">
            <div className="flex items-center gap-2">
              <span className={`h-1.5 w-1.5 shrink-0 rounded-full ${PRIORITY[a.priority]?.dot ?? PRIORITY.normal.dot}`} />
              <span className={`truncate text-sm font-medium ${PRIORITY[a.priority]?.text ?? ''}`}>{a.title}</span>
              {a.occurrences > 1 && (
                <span className="shrink-0 rounded-full bg-white/5 px-1.5 text-[10px] text-slate-400 ring-1 ring-inset ring-white/10">
                  ×{a.occurrences}
                </span>
              )}
              <span className="ml-auto shrink-0 text-[11px] text-slate-500">
                <Ago ts={a.t} />
              </span>
            </div>
            <div className="mt-0.5 flex gap-2 pl-3.5 text-[11px] text-slate-500">
              <span className="truncate font-mono">{a.deviceId}</span>
              {a.occurrences > 1 && a.firstAt < a.t && (
                <span className="ml-auto shrink-0">
                  first <Ago ts={a.firstAt} />
                </span>
              )}
            </div>
            {a.detail && <div className="mt-1 line-clamp-2 pl-3.5 text-xs text-slate-400">{a.detail}</div>}
          </button>
        </li>
      ))}
    </ol>
  );
}

function EmptyState() {
  return (
    <GlassCard className="relative grid place-items-center overflow-hidden px-6 py-20 text-center">
      <div className="relative mb-8 grid h-28 w-28 place-items-center">
        {[0, 1, 2].map((i) => (
          <span
            key={i}
            className="absolute inset-0 animate-ping rounded-full border border-cyan-400/30"
            style={{ animationDuration: '3s', animationDelay: `${i}s` }}
          />
        ))}
        <span className="h-3 w-3 rounded-full bg-cyan-300 shadow-[0_0_24px_6px] shadow-cyan-400/50" />
      </div>
      <h2 className="text-lg font-semibold">Listening for agents…</h2>
      <p className="mt-2 max-w-md text-sm text-slate-400">
        Point an agent&apos;s <code className="rounded bg-white/5 px-1.5 py-0.5 font-mono text-cyan-200">TelemetryApi:BaseUrl</code> at this
        server, or run <code className="rounded bg-white/5 px-1.5 py-0.5 font-mono text-cyan-200">npm run simulate</code> to see a demo fleet.
        Devices appear here the moment their first batch arrives.
      </p>
    </GlassCard>
  );
}

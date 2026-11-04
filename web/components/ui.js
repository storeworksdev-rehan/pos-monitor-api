'use client';

import { useId, useSyncExternalStore } from 'react';

// ------------------------------------------------------------------ shared clock
// One 5-second timer for the whole page. Only components that show relative time or
// time-based status subscribe, so idle cards never re-render.
let nowValue = Date.now();
const clockListeners = new Set();
let clockTimer = null;

function subscribeClock(listener) {
  clockListeners.add(listener);
  clockTimer ??= setInterval(() => {
    nowValue = Date.now();
    clockListeners.forEach((l) => l());
  }, 5000);
  return () => {
    clockListeners.delete(listener);
    if (clockListeners.size === 0) {
      clearInterval(clockTimer);
      clockTimer = null;
    }
  };
}

export function useNow() {
  return useSyncExternalStore(subscribeClock, () => nowValue, () => nowValue);
}

// ------------------------------------------------------------------ formatting

export function statusOf(lastSeen, now, thresholds) {
  if (!lastSeen) return 'offline';
  const age = (now - lastSeen) / 1000;
  if (age <= thresholds.stale) return 'online';
  if (age <= thresholds.offline) return 'stale';
  return 'offline';
}

export function formatAgo(ts, now) {
  if (!ts) return 'never';
  const s = Math.max(0, Math.round((now - ts) / 1000));
  if (s < 10) return 'just now';
  if (s < 60) return `${s}s ago`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.round(m / 60);
  if (h < 48) return `${h}h ago`;
  return `${Math.round(h / 24)}d ago`;
}

export function formatDuration(seconds) {
  if (seconds == null) return '—';
  const d = Math.floor(seconds / 86400);
  const h = Math.floor((seconds % 86400) / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  if (d > 0) return `${d}d ${h}h`;
  if (h > 0) return `${h}h ${m}m`;
  return `${m}m`;
}

export function formatBytes(bytes) {
  if (bytes == null) return '—';
  const units = ['B', 'KB', 'MB', 'GB'];
  let v = bytes;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  return `${v < 10 && i > 0 ? v.toFixed(1) : Math.round(v)} ${units[i]}`;
}

export const pct = (v) => (v == null ? '—' : `${Math.round(v)}%`);

export function Ago({ ts }) {
  const now = useNow();
  return <span suppressHydrationWarning>{formatAgo(ts, now)}</span>;
}

// ------------------------------------------------------------------ status

export const STATUS = {
  online: { label: 'Online', dot: 'bg-emerald-400 shadow-[0_0_10px_2px] shadow-emerald-400/50', text: 'text-emerald-300' },
  stale: { label: 'Delayed', dot: 'bg-amber-400 shadow-[0_0_10px_2px] shadow-amber-400/40', text: 'text-amber-300' },
  offline: { label: 'Offline', dot: 'bg-slate-500', text: 'text-slate-400' },
};

export const PRIORITY = {
  critical: { dot: 'bg-rose-500 shadow-[0_0_10px_2px] shadow-rose-500/50', text: 'text-rose-300', chip: 'bg-rose-500/15 text-rose-200 ring-rose-500/30' },
  high: { dot: 'bg-amber-400', text: 'text-amber-300', chip: 'bg-amber-400/10 text-amber-200 ring-amber-400/25' },
  normal: { dot: 'bg-sky-400', text: 'text-sky-300', chip: 'bg-sky-400/10 text-sky-200 ring-sky-400/25' },
  low: { dot: 'bg-slate-400', text: 'text-slate-300', chip: 'bg-slate-400/10 text-slate-300 ring-slate-400/20' },
};

export function StatusDot({ status, className = '' }) {
  return <span className={`inline-block h-2 w-2 shrink-0 rounded-full ${STATUS[status].dot} ${className}`} />;
}

export function Pill({ tone = 'neutral', children, title }) {
  const tones = {
    ok: 'bg-emerald-400/10 text-emerald-200 ring-emerald-400/25',
    bad: 'bg-rose-500/15 text-rose-200 ring-rose-500/30',
    warn: 'bg-amber-400/10 text-amber-200 ring-amber-400/25',
    neutral: 'bg-white/5 text-slate-300 ring-white/10',
  };
  return (
    <span title={title} className={`inline-flex items-center gap-1.5 rounded-full px-2 py-0.5 text-[11px] font-medium ring-1 ring-inset ${tones[tone]}`}>
      {children}
    </span>
  );
}

export function GlassCard({ className = '', children, ...rest }) {
  return (
    <div
      className={`rounded-2xl border border-white/[0.07] bg-gradient-to-b from-white/[0.06] to-white/[0.02] shadow-[0_1px_0_0_rgba(255,255,255,0.05)_inset] backdrop-blur-xl ${className}`}
      {...rest}
    >
      {children}
    </div>
  );
}

// ------------------------------------------------------------------ charts (plain SVG)

export function Sparkline({ values, className = '' }) {
  if (!values || values.length < 2) return <div className={className} />;
  const W = 120;
  const H = 32;
  const step = W / (values.length - 1);
  const line = values.map((v, i) => `${i ? 'L' : 'M'}${(i * step).toFixed(1)},${(H - 2 - (Math.min(v, 100) / 100) * (H - 4)).toFixed(1)}`).join('');
  return (
    <svg viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" className={className} aria-hidden="true">
      <path d={`${line}L${W},${H}L0,${H}Z`} fill="currentColor" opacity="0.12" />
      <path d={line} fill="none" stroke="currentColor" strokeWidth="1.5" vectorEffect="non-scaling-stroke" strokeLinejoin="round" />
    </svg>
  );
}

export function AreaChart({ history, index, max = 100, className = 'text-cyan-300', height = 'h-28', format = (v) => v }) {
  const rawId = useId();
  const gradientId = `g${rawId.replace(/[^a-zA-Z0-9_-]/g, '')}`;
  const pts = (history ?? []).filter((p) => p[index] != null);
  if (pts.length < 2) {
    return <div className={`${height} grid place-items-center text-xs text-slate-500`}>Collecting data…</div>;
  }

  const W = 600;
  const H = 120;
  const t0 = pts[0][0];
  const span = Math.max(1, pts.at(-1)[0] - t0);
  const peak = Math.max(...pts.map((p) => p[index]));
  const top = max ?? Math.max(1, peak * 1.25);
  const x = (t) => ((t - t0) / span) * W;
  const y = (v) => H - 2 - (Math.min(v, top) / top) * (H - 6);
  const line = pts.map((p, i) => `${i ? 'L' : 'M'}${x(p[0]).toFixed(1)},${y(p[index]).toFixed(1)}`).join('');
  const area = `${line}L${x(pts.at(-1)[0]).toFixed(1)},${H}L${x(t0).toFixed(1)},${H}Z`;
  const last = pts.at(-1)[index];

  return (
    <div className={`relative ${className}`}>
      <svg viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" className={`${height} w-full`} aria-hidden="true">
        <defs>
          <linearGradient id={gradientId} x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor="currentColor" stopOpacity="0.35" />
            <stop offset="100%" stopColor="currentColor" stopOpacity="0" />
          </linearGradient>
        </defs>
        {[0.25, 0.5, 0.75].map((f) => (
          <line key={f} x1="0" x2={W} y1={H * f} y2={H * f} stroke="white" strokeOpacity="0.05" vectorEffect="non-scaling-stroke" />
        ))}
        <path d={area} fill={`url(#${gradientId})`} />
        <path d={line} fill="none" stroke="currentColor" strokeWidth="1.75" vectorEffect="non-scaling-stroke" strokeLinejoin="round" />
      </svg>
      <div className="pointer-events-none absolute right-1 top-0 text-xs font-semibold tabular-nums">{format(last)}</div>
      <div className="pointer-events-none absolute bottom-0 left-1 text-[10px] text-slate-500">
        peak {format(peak)} · {Math.round(span / 60000)} min
      </div>
    </div>
  );
}

export function Ring({ segments, size = 132, stroke = 12, children }) {
  const r = (size - stroke) / 2;
  const c = 2 * Math.PI * r;
  const total = segments.reduce((s, x) => s + x.value, 0);
  let offset = 0;
  return (
    <div className="relative grid place-items-center" style={{ width: size, height: size }}>
      <svg width={size} height={size} className="-rotate-90" aria-hidden="true">
        <circle cx={size / 2} cy={size / 2} r={r} fill="none" stroke="white" strokeOpacity="0.06" strokeWidth={stroke} />
        {total > 0 &&
          segments.map((s) => {
            const len = (s.value / total) * c;
            const el = (
              <circle
                key={s.key}
                cx={size / 2}
                cy={size / 2}
                r={r}
                fill="none"
                stroke="currentColor"
                strokeWidth={stroke}
                strokeLinecap={len > 2 ? 'round' : 'butt'}
                strokeDasharray={`${Math.max(0, len - 2)} ${c}`}
                strokeDashoffset={-offset}
                className={`${s.className} transition-all duration-700`}
              />
            );
            offset += len;
            return el;
          })}
      </svg>
      <div className="absolute inset-0 grid place-items-center text-center">{children}</div>
    </div>
  );
}

export function Meter({ label, value, display, warnAt, badAt, invert = false }) {
  const v = value == null ? 0 : Math.max(0, Math.min(100, value));
  const bad = value != null && (invert ? value <= badAt : value >= badAt);
  const warn = value != null && !bad && (invert ? value <= warnAt : value >= warnAt);
  const color = bad ? 'from-rose-500 to-rose-400' : warn ? 'from-amber-500 to-amber-300' : 'from-cyan-500 to-emerald-400';
  return (
    <div>
      <div className="mb-1 flex justify-between text-[11px] text-slate-400">
        <span>{label}</span>
        <span className={`tabular-nums ${bad ? 'text-rose-300' : warn ? 'text-amber-200' : 'text-slate-300'}`}>{display}</span>
      </div>
      <div className="h-1.5 overflow-hidden rounded-full bg-white/[0.06]">
        <div className={`h-full rounded-full bg-gradient-to-r ${color} transition-[width] duration-700`} style={{ width: `${v}%` }} />
      </div>
    </div>
  );
}

// ------------------------------------------------------------------ filter controls

/** Segmented filter. options: [value, label, count?][]. */
export function Segmented({ value, onChange, options, label, size = 'md' }) {
  const pad = size === 'sm' ? 'px-2 py-1 text-xs' : 'px-3 py-1.5 text-sm';
  return (
    <div role="group" aria-label={label} className="flex shrink-0 gap-1 rounded-xl border border-white/10 bg-white/[0.03] p-1">
      {options.map(([key, text, count]) => (
        <button
          key={key}
          type="button"
          aria-pressed={value === key}
          onClick={() => onChange(key)}
          className={`flex items-center gap-1.5 whitespace-nowrap rounded-lg transition ${pad} ${
            value === key ? 'bg-white/10 text-white shadow-sm' : 'text-slate-400 hover:text-slate-200'
          }`}
        >
          {text}
          {count != null && <span className="text-[10px] tabular-nums text-slate-400">{count}</span>}
        </button>
      ))}
    </div>
  );
}

/** Native select styled like the toolbar. options: [value, label][]. */
export function Select({ value, onChange, options, label }) {
  return (
    <label className="relative shrink-0">
      <span className="sr-only">{label}</span>
      <select
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className={`w-full appearance-none rounded-xl border bg-white/[0.04] py-2.5 pl-3 pr-9 text-sm focus:border-cyan-400/50 focus:outline-none focus:ring-4 focus:ring-cyan-400/10 [&>option]:bg-slate-900 [&>option]:text-slate-100 ${
          value === options[0][0] ? 'border-white/10 text-slate-300' : 'border-cyan-400/40 text-white'
        }`}
      >
        {options.map(([key, text]) => (
          <option key={key} value={key}>
            {text}
          </option>
        ))}
      </select>
      <svg viewBox="0 0 20 20" className="pointer-events-none absolute right-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-500" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
        <path d="m6 8 4 4 4-4" strokeLinecap="round" strokeLinejoin="round" />
      </svg>
    </label>
  );
}

/** Small text filter for side lists. */
export function FilterInput({ value, onChange, placeholder }) {
  return (
    <label className="relative block">
      <span className="sr-only">{placeholder}</span>
      <input
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        className="w-full rounded-lg border border-white/10 bg-white/[0.04] py-1.5 pl-3 pr-8 text-xs placeholder:text-slate-500 focus:border-cyan-400/50 focus:outline-none"
      />
      {value && (
        <button type="button" onClick={() => onChange('')} aria-label="Clear filter" className="absolute right-1.5 top-1/2 -translate-y-1/2 rounded px-1.5 text-slate-500 hover:text-slate-200">
          ×
        </button>
      )}
    </label>
  );
}

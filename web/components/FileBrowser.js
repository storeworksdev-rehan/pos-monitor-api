'use client';

import { apiUrl } from '@/lib/api';
import { useCallback, useDeferredValue, useEffect, useMemo, useRef, useState } from 'react';
import { Ago, GlassCard, Pill, formatBytes } from './ui';

const ERRORS = {
  'not-found': { title: 'Not found on this device', tone: 'text-amber-200' },
  denied: { title: 'Access denied', tone: 'text-rose-200' },
  disabled: { title: 'File access is disabled on this device', tone: 'text-rose-200' },
  unsupported: { title: 'Cannot be shown', tone: 'text-amber-200' },
  'agent-offline': { title: 'Agent not connected', tone: 'text-rose-200' },
  timeout: { title: 'The device did not answer in time', tone: 'text-amber-200' },
};

/**
 * Browse the locked log folder (default C:\XeniaRetail\Logs) on one POS through the API.
 * A folder path lists its files with full paths; a file path shows its content.
 */
export default function FileBrowser({ deviceId, root, available }) {
  const [input, setInput] = useState(root);
  const [recursive, setRecursive] = useState(false);
  const [listing, setListing] = useState(null);
  const [file, setFile] = useState(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);
  const requestId = useRef(0);

  const open = useCallback(
    async (path, { offset, tail, recursive: rec } = {}) => {
      const id = ++requestId.current;
      setLoading(true);
      setError(null);
      const q = new URLSearchParams({ path });
      if (rec) q.set('recursive', 'true');
      if (offset != null) q.set('offset', String(offset));
      if (tail === false) q.set('tail', 'false');
      try {
        const res = await fetch(apiUrl(`/api/devices/${encodeURIComponent(deviceId)}/files?${q}`), { cache: 'no-store' });
        const body = await res.json().catch(() => ({ error: `HTTP ${res.status}` }));
        if (id !== requestId.current) return;
        if (!res.ok) {
          setError({ code: body.code, message: body.error ?? `HTTP ${res.status}`, path });
          return;
        }
        setInput(body.path);
        if (body.kind === 'directory') {
          setListing(body);
          setFile(null);
        } else {
          setFile(body);
        }
      } catch {
        if (id === requestId.current) setError({ code: 'network', message: 'Could not reach the monitoring API.', path });
      } finally {
        if (id === requestId.current) setLoading(false);
      }
    },
    [deviceId],
  );

  useEffect(() => {
    open(root);
  }, [root, open]);

  const current = file?.path ?? listing?.path ?? root;

  return (
    <div className="space-y-4">
      {!available && (
        <p className="rounded-xl bg-amber-400/10 px-3 py-2 text-xs text-amber-200 ring-1 ring-inset ring-amber-400/20">
          This device&apos;s agent is not currently polling for file requests. It may be offline, or running an agent version without file access.
        </p>
      )}

      <form
        onSubmit={(e) => {
          e.preventDefault();
          open(input.trim() || root, { recursive });
        }}
        className="space-y-2"
      >
        <div className="flex gap-2">
          <input
            value={input}
            onChange={(e) => setInput(e.target.value)}
            spellCheck={false}
            aria-label="Folder or file path"
            placeholder={`${root}\\Logs\\BackOffice`}
            className="min-w-0 flex-1 rounded-xl border border-white/10 bg-black/30 px-3 py-2 font-mono text-xs text-slate-100 placeholder:text-slate-600 focus:border-cyan-400/50 focus:outline-none focus:ring-4 focus:ring-cyan-400/10"
          />
          <button
            type="submit"
            disabled={loading}
            className="shrink-0 rounded-xl bg-gradient-to-r from-cyan-500 to-violet-500 px-4 py-2 text-sm font-medium text-slate-950 shadow-lg shadow-cyan-500/20 transition hover:brightness-110 disabled:opacity-60"
          >
            {loading ? 'Asking device…' : 'Open'}
          </button>
        </div>
        <div className="flex flex-wrap items-center justify-between gap-2 text-[11px] text-slate-500">
          <span>
            Enter a folder to list its files, or a file to view it. Only <span className="font-mono text-slate-400">{root}</span> is accessible.
          </span>
          <label className="flex cursor-pointer items-center gap-1.5 text-slate-400">
            <input type="checkbox" checked={recursive} onChange={(e) => setRecursive(e.target.checked)} className="accent-cyan-400" />
            include subfolders
          </label>
        </div>
      </form>

      <Breadcrumbs path={current} root={root} onOpen={(p) => open(p, { recursive })} />

      {loading && <LoadingBar deviceId={deviceId} />}

      {error && (
        <GlassCard className="p-4">
          <div className={`text-sm font-medium ${ERRORS[error.code]?.tone ?? 'text-rose-200'}`}>{ERRORS[error.code]?.title ?? 'Request failed'}</div>
          <p className="mt-1 break-words text-xs text-slate-400">{error.message}</p>
          {error.path && <p className="mt-1 break-all font-mono text-[11px] text-slate-500">{error.path}</p>}
        </GlassCard>
      )}

      {file ? (
        <FileViewer
          file={file}
          loading={loading}
          onBack={() => (listing && listing.path.toLowerCase() === file.parent?.toLowerCase() ? setFile(null) : open(file.parent ?? root))}
          onPage={(opts) => open(file.path, opts)}
        />
      ) : (
        listing && <Listing listing={listing} root={root} onOpen={(p, isDir) => open(p, isDir ? { recursive } : {})} />
      )}
    </div>
  );
}

function LoadingBar({ deviceId }) {
  return (
    <div className="flex items-center gap-3 text-xs text-slate-400">
      <span className="relative h-1 w-24 overflow-hidden rounded-full bg-white/10">
        <span className="absolute inset-y-0 left-0 w-1/3 animate-pulse rounded-full bg-gradient-to-r from-cyan-400 to-violet-400" />
      </span>
      Waiting for <span className="font-mono">{deviceId}</span> to answer…
    </div>
  );
}

function Breadcrumbs({ path, root, onOpen }) {
  const parts = useMemo(() => {
    const crumbs = [{ label: root, path: root }];
    if (!path || path.length <= root.length) return crumbs;
    let acc = root;
    for (const segment of path.slice(root.length).split('\\').filter(Boolean)) {
      acc = `${acc}\\${segment}`;
      crumbs.push({ label: segment, path: acc });
    }
    return crumbs;
  }, [path, root]);

  return (
    <nav aria-label="Path" className="flex flex-wrap items-center gap-1 font-mono text-xs">
      {parts.map((c, i) => (
        <span key={c.path} className="flex items-center gap-1">
          {i > 0 && <span className="text-slate-600">\</span>}
          <button
            onClick={() => onOpen(c.path)}
            className={`rounded px-1 py-0.5 transition hover:bg-white/10 ${i === parts.length - 1 ? 'text-cyan-200' : 'text-slate-400'}`}
          >
            {c.label}
          </button>
        </span>
      ))}
    </nav>
  );
}

function Listing({ listing, root, onOpen }) {
  const [filter, setFilter] = useState('');
  const q = useDeferredValue(filter.trim().toLowerCase());
  const entries = useMemo(
    () => (q ? listing.entries.filter((e) => e.path.toLowerCase().includes(q)) : listing.entries),
    [listing.entries, q],
  );
  const files = listing.entries.filter((e) => e.type === 'file');
  const total = files.reduce((n, e) => n + (e.size ?? 0), 0);

  return (
    <GlassCard className="overflow-hidden">
      <div className="flex flex-wrap items-center gap-3 border-b border-white/5 px-4 py-3">
        <div className="text-xs text-slate-400">
          <span className="font-medium text-slate-200">{files.length}</span> file{files.length === 1 ? '' : 's'} ·{' '}
          {listing.entries.length - files.length} folder{listing.entries.length - files.length === 1 ? '' : 's'} · {formatBytes(total)}
          {listing.recursive && ' · including subfolders'}
        </div>
        <input
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
          placeholder="Filter by name"
          className="ml-auto w-44 rounded-lg border border-white/10 bg-black/20 px-2.5 py-1 text-xs placeholder:text-slate-600 focus:border-cyan-400/40 focus:outline-none"
        />
      </div>
      {listing.truncated && (
        <p className="border-b border-white/5 bg-amber-400/5 px-4 py-2 text-[11px] text-amber-200">
          Only the first {listing.count} entries are shown. Open a subfolder to narrow it down.
        </p>
      )}
      <ul className="max-h-[60vh] divide-y divide-white/[0.04] overflow-y-auto">
        {listing.parent && (
          <li>
            <button onClick={() => onOpen(listing.parent, true)} className="flex w-full items-center gap-3 px-4 py-2 text-left text-xs text-slate-400 hover:bg-white/[0.04]">
              <FolderIcon className="text-slate-500" /> ..
            </button>
          </li>
        )}
        {entries.length === 0 && <li className="px-4 py-8 text-center text-xs text-slate-500">{q ? 'No matches.' : 'This folder is empty.'}</li>}
        {entries.map((e) => {
          const dir = e.type === 'directory';
          const rel = e.path.slice(listing.path.length + 1);
          return (
            <li key={e.path}>
              <button
                onClick={() => (dir || e.readable) && onOpen(e.path, dir)}
                disabled={!dir && !e.readable}
                title={e.path}
                className="group flex w-full items-center gap-3 px-4 py-2 text-left transition hover:bg-white/[0.04] disabled:cursor-not-allowed disabled:opacity-50"
              >
                {dir ? <FolderIcon className="text-cyan-300" /> : <FileIcon className={e.readable ? 'text-slate-300' : 'text-slate-600'} />}
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-sm text-slate-100 group-hover:text-white">{listing.recursive ? rel : e.name}</span>
                  <span className="block truncate font-mono text-[10px] text-slate-500">{e.path}</span>
                </span>
                {!dir && <span className="shrink-0 text-xs tabular-nums text-slate-400">{formatBytes(e.size)}</span>}
                <span className="w-20 shrink-0 text-right text-[11px] text-slate-500" title={new Date(e.modified).toLocaleString()}>
                  <Ago ts={Date.parse(e.modified)} />
                </span>
              </button>
            </li>
          );
        })}
      </ul>
      {!listing.recursive && listing.path.toLowerCase() === root.toLowerCase() && (
        <p className="border-t border-white/5 px-4 py-2 text-[11px] text-slate-500">Tip: tick “include subfolders” to see every file under a folder.</p>
      )}
    </GlassCard>
  );
}

const LINE_TONE = [
  [/\b(FATAL|CRITICAL)\b/i, 'text-rose-300 bg-rose-500/[0.07]'],
  [/\b(ERROR|ERR)\b|Exception/i, 'text-rose-200'],
  [/\bWARN(ING)?\b/i, 'text-amber-200'],
];

function FileViewer({ file, loading, onBack, onPage }) {
  const [grep, setGrep] = useState('');
  const [wrap, setWrap] = useState(true);
  const [copied, setCopied] = useState(false);
  const q = useDeferredValue(grep.trim().toLowerCase());

  const lines = useMemo(() => file.content.replace(/\r/g, '').split('\n'), [file.content]);
  const shown = useMemo(() => {
    const out = [];
    for (let i = 0; i < lines.length; i++) {
      if (!q || lines[i].toLowerCase().includes(q)) out.push(i);
    }
    return out;
  }, [lines, q]);

  const download = () => {
    const url = URL.createObjectURL(new Blob([file.content], { type: 'text/plain;charset=utf-8' }));
    const a = Object.assign(document.createElement('a'), { href: url, download: file.truncated ? `${file.name}.part` : file.name });
    a.click();
    URL.revokeObjectURL(url);
  };

  const copyPath = async () => {
    try {
      await navigator.clipboard.writeText(file.path);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      // clipboard not available
    }
  };

  const end = file.offset + file.length;

  return (
    <GlassCard className="overflow-hidden">
      <div className="space-y-2 border-b border-white/5 px-4 py-3">
        <div className="flex items-start gap-3">
          <button onClick={onBack} className="mt-0.5 rounded-lg p-1 text-slate-400 transition hover:bg-white/10 hover:text-white" aria-label="Back to folder">
            <svg viewBox="0 0 20 20" className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              <path d="M12 5l-5 5 5 5" />
            </svg>
          </button>
          <div className="min-w-0 flex-1">
            <div className="truncate text-sm font-semibold text-slate-100">{file.name}</div>
            <button onClick={copyPath} title="Copy path" className="block max-w-full truncate font-mono text-[10px] text-slate-500 hover:text-slate-300">
              {copied ? 'path copied' : file.path}
            </button>
          </div>
          <div className="flex shrink-0 flex-wrap justify-end gap-1.5">
            <Pill>{formatBytes(file.size)}</Pill>
            <Pill title={new Date(file.modified).toLocaleString()}>
              modified <Ago ts={Date.parse(file.modified)} />
            </Pill>
            {file.redacted && <Pill tone="warn" title="Card numbers, passwords, tokens and emails are masked">redacted</Pill>}
          </div>
        </div>

        {file.truncated && (
          <div className="flex flex-wrap items-center gap-2 rounded-lg bg-white/[0.03] px-3 py-2 text-[11px] text-slate-400">
            Showing {formatBytes(file.offset)} to {formatBytes(end)} of {formatBytes(file.size)}
            <span className="ml-auto flex gap-1">
              <PageButton disabled={loading || !file.hasMoreBefore} onClick={() => onPage({ tail: false })}>Start</PageButton>
              <PageButton disabled={loading || !file.hasMoreBefore} onClick={() => onPage({ offset: Math.max(0, file.offset - file.length) })}>Earlier</PageButton>
              <PageButton disabled={loading || !file.hasMoreAfter} onClick={() => onPage({ offset: end })}>Later</PageButton>
              <PageButton disabled={loading || !file.hasMoreAfter} onClick={() => onPage({})}>End</PageButton>
            </span>
          </div>
        )}

        <div className="flex flex-wrap items-center gap-2">
          <input
            value={grep}
            onChange={(e) => setGrep(e.target.value)}
            placeholder="Filter lines (e.g. ERROR)"
            className="min-w-0 flex-1 rounded-lg border border-white/10 bg-black/20 px-2.5 py-1 text-xs placeholder:text-slate-600 focus:border-cyan-400/40 focus:outline-none"
          />
          <span className="text-[11px] tabular-nums text-slate-500">
            {q ? `${shown.length} of ${lines.length}` : lines.length} lines
          </span>
          <PageButton onClick={() => setWrap((w) => !w)}>{wrap ? 'No wrap' : 'Wrap'}</PageButton>
          <PageButton onClick={download}>Download</PageButton>
        </div>
      </div>

      <div className="max-h-[62vh] overflow-auto bg-black/30 py-2 font-mono text-[11.5px] leading-[1.6]">
        {shown.length === 0 && <div className="px-4 py-6 text-center text-xs text-slate-500">{q ? 'No lines match.' : 'The file is empty.'}</div>}
        {shown.map((i) => {
          const line = lines[i];
          const tone = LINE_TONE.find(([re]) => re.test(line))?.[1] ?? 'text-slate-300';
          return (
            <div key={i} className={`flex gap-3 px-3 [content-visibility:auto] [contain-intrinsic-size:auto_18px] hover:bg-white/[0.03] ${tone}`}>
              <span className="w-12 shrink-0 select-none text-right text-slate-600">{i + 1}</span>
              <span className={wrap ? 'min-w-0 whitespace-pre-wrap break-all' : 'whitespace-pre'}>{line || ' '}</span>
            </div>
          );
        })}
      </div>
    </GlassCard>
  );
}

function PageButton({ children, ...rest }) {
  return (
    <button
      type="button"
      {...rest}
      className="rounded-md border border-white/10 px-2 py-0.5 text-[11px] text-slate-300 transition hover:bg-white/10 disabled:cursor-not-allowed disabled:opacity-40"
    >
      {children}
    </button>
  );
}

function FolderIcon({ className = '' }) {
  return (
    <svg viewBox="0 0 20 20" className={`h-4 w-4 shrink-0 ${className}`} fill="currentColor" aria-hidden="true">
      <path d="M2 5.5A1.5 1.5 0 0 1 3.5 4h4l1.5 2h7.5A1.5 1.5 0 0 1 18 7.5v7a1.5 1.5 0 0 1-1.5 1.5h-13A1.5 1.5 0 0 1 2 14.5v-9z" opacity="0.85" />
    </svg>
  );
}

function FileIcon({ className = '' }) {
  return (
    <svg viewBox="0 0 20 20" className={`h-4 w-4 shrink-0 ${className}`} fill="none" stroke="currentColor" strokeWidth="1.5" aria-hidden="true">
      <path d="M5 2.5h6.5L15.5 6.5v11h-10.5z" strokeLinejoin="round" />
      <path d="M11.5 2.5v4h4M7.5 10h5M7.5 13h5" strokeLinecap="round" />
    </svg>
  );
}

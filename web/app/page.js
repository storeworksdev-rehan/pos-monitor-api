import Dashboard from '@/components/Dashboard';
import { API_URL, EMPTY_SNAPSHOT } from '@/lib/api';

export const dynamic = 'force-dynamic';

async function loadSnapshot() {
  const base = (process.env.API_URL || API_URL).replace(/\/$/, '');
  try {
    const res = await fetch(`${base}/api/snapshot`, { cache: 'no-store', signal: AbortSignal.timeout(3000) });
    if (res.ok) return await res.json();
  } catch {
    // API not reachable: render the shell; the browser's live stream keeps retrying.
  }
  return EMPTY_SNAPSHOT;
}

export default async function Page() {
  // First paint with current data from the Express API, then kept live over its /api/stream.
  return <Dashboard initial={await loadSnapshot()} />;
}

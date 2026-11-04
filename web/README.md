# POS Fleet Monitor (Next.js dashboard)

This is the frontend for the Express API in `../server`. It has no API routes and no database code.
It loads the fleet state from the API for the first render, then stays live over the API's `/api/stream`.

The dependencies are `next`, `react` and `react-dom`, plus Tailwind CSS at build time.

## Run

```powershell
npm install
copy .env.example .env.local     # set NEXT_PUBLIC_API_URL if the API is not on http://localhost:4000
npm run build
npm start                        # http://localhost:3100
npm run dev                      # development mode with hot reload
```

`NEXT_PUBLIC_API_URL` is baked in at build time, so rebuild after you change it.
The API must list this site's origin in its `CORS_ORIGINS` setting. The default there is `http://localhost:3100`.

## What it shows

- **Fleet health ring and KPIs.** Online devices, POS running, SQL reachable, and critical incidents in the last 24 h.
- **One row per store**, worst first. Each row shows the store's register count and its problems: POS down, SQL down, offline, delayed, open incidents and other issues. It also has one coloured dot per register; click a dot to open that register.
  - Expand a store to see its register cards. Each card has a CPU sparkline, memory and disk meters, and POS and SQL status, and flags issues and open incidents.
  - Expanded stores are remembered in the browser. *Expand all* and *Collapse all* are above the list.
  - Searching shows every matching card, and so does a fleet of three stores or fewer.
  - Only expanded stores render cards, which keeps a few hundred stores light: about 1 MB of page for 1,000 registers.
- **Filters,** to keep the page short:
  - Above the store list:
    - Search.
    - A **Status** dropdown: all, needs attention, or not online.
    - A **Problem** dropdown: POS down, SQL unreachable, offline, delayed, incident open, high CPU or memory, low disk, or upload problems. Each option shows how many registers it matches.
    - A **Sort** order: worst first, store ID, longest silent, or most recent data.
    - *Clear filters*.
    - Stores load 40 at a time, with a *Show more* button.
  - The side panel has a text filter, plus All / Active / Critical for incidents and All / Critical / Errors / Warnings for alerts.
  - A register's event list can be narrowed to *Errors & warnings*.
- **Side panel.** An Incidents tab lists snapshots of failures, errors and warnings with active, resolved or recorded status. A Live alerts tab shows the alert feed.
- **Device drawer.** Shows the live window of charts and events, plus the device's incident snapshots.
- **Log files tab in the device drawer.** Browse that POS's `C:\XeniaRetail\Logs` folder:
  - Type a folder or a file path, or click through breadcrumbs. Folders list every file with its full path, newest first.
  - "Include subfolders" lists every file below the chosen folder.
  - Opening a file shows its content with line numbers and colored error and warning lines.
  - A line filter narrows the content, and a download button saves it.
  - For large files, Start, Earlier, Later and End buttons page through the content.
- **Incident drawer.** Shows what triggered the incident and the device state frozen at that moment, including the charts that led up to it.

Keyboard shortcuts: `/` focuses search, and `Esc` closes drawers.

To keep the browser light:
- The live stream pauses 30 s after the tab is hidden.
- All relative times share one 5-second timer.
- Charts are plain SVG.
- Device cards only re-render when their own data changes.

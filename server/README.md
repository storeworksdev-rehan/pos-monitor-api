# POS Monitoring API (Express)

This Express server receives telemetry from the POS Monitoring Agent. It keeps a live window of data in memory, captures failures, errors and warnings as incident snapshots, and serves the Next.js dashboard in `../web`.

The only dependencies are `express` and `mongodb`, and MongoDB is optional.

## Run

```powershell
npm install
copy .env.example .env      # optional; loaded automatically
npm start                   # http://localhost:4000
npm run dev                 # restarts on file changes
npm run simulate -- --devices 24 --stores 6 --interval 5 --key <api-key>   # demo fleet
```

Point each agent at this server in its settings:

```json
"TelemetryApi": { "BaseUrl": "http://<server>:4000", "ApiKey": "<one of TELEMETRY_API_KEYS>" }
```

The agent's gzip option, `EnableGzip`, is supported.

## What is kept, and for how long

| Data | Kept for |
| --- | --- |
| Metric history and routine events | `DATA_WINDOW_MINUTES`, 10 by default. Older data is deleted in memory, and in MongoDB through a time-to-live (TTL) index. |
| Latest status of each device | Always, so offline devices stay visible. |
| Failures, errors and warnings | `INCIDENT_RETENTION_DAYS`, 30 by default. |
| Incident snapshots | `INCIDENT_RETENTION_DAYS`. Memory keeps the latest `INCIDENTS_MAX`. The snapshot file and MongoDB keep them all. |

An incident snapshot is taken when one of these happens:

- An event arrives with high or critical priority.
- A log entry arrives at warning, error or critical level.
- A condition newly appears on live data:
  - POS not running or not responding
  - SQL unreachable
  - CPU at 90% or more
  - Memory at 92% or more
  - Less than 10% disk free
  - An upload backlog, or repeated upload failures
- A device stops sending data for `OFFLINE_SECONDS`.

The snapshot freezes the device's state at that moment, plus the charts and events of the live window that led up to it.
Triggers on the same device within `INCIDENT_MERGE_SECONDS` join one incident.
An incident is marked resolved when every condition it raised has cleared.

### Repeated errors are stored once

The same error raised again is not stored or listed again. Instead, the existing record's count goes up, and it moves to the top with the latest time and text.

Two errors count as the same when they come from the same device and say the same thing once numbers, GUIDs, hex codes and timestamps are ignored. For example, `SQL timeout after 5003 ms (order 1182)` and `SQL timeout after 5011 ms (order 1190)` are the same error.

| Where | What happens to a repeat |
| --- | --- |
| Live alerts and device events | One entry with `×N` and the time it was first seen |
| Incidents | Joins the incident that already holds the error, if that incident was updated within `DUPLICATE_WINDOW_HOURS` (24 by default). The trigger shows `×N` and the last time it happened. |
| MongoDB `events` | One document per device and error, with `occurrences`, `firstTs` and the latest `ts` |

Routine events, such as metrics and heartbeats, are not affected. A re-sent upload with the same event id is still recognized by its id and acknowledged without being counted.

## Storage modes

| Mode | Set up with | What happens |
| --- | --- | --- |
| No database | `MONGODB_URI` left empty | Data is held in memory and saved to `.data/state.json` every minute, and within 5 s of any incident change. It is restored on start. |
| MongoDB | `MONGODB_URI` set | Events and incident snapshots are also written to MongoDB. TTL indexes delete each document when it expires. |
| MongoDB down | Happens automatically | Ingest and the dashboard keep working. Events are spooled to `.data/spool.jsonl` and replayed later. If the spool reaches `SPOOL_MAX_MB`, the API answers 503 and agents keep the data in their own queues. |

## API

| Endpoint | Used by | Purpose |
| --- | --- | --- |
| `POST /api/telemetry/batch` | Agent | Upload a batch. Requires `X-Api-Key` when `TELEMETRY_API_KEYS` is set. Replies `{ acknowledgedEventIds, rejectedEventIds }`. |
| `GET /api/health` | Agent | Reachability check, plus storage state. |
| `GET /api/snapshot` | Dashboard | Full fleet state for the first render. |
| `GET /api/stream` | Dashboard | Server-Sent Events. Sends `snapshot` on connect, then `update` at most once per second, then `stats` every 20 s. |
| `GET /api/devices` and `GET /api/devices/:deviceId` | Dashboard | Device summaries, and the detail for one device. |
| `GET /api/incidents` and `GET /api/incidents/:id` | Dashboard | Incident snapshots. Add `?source=archive` to read from MongoDB. |
| `GET /api/events` | Dashboard | Recent failures, errors and warnings. Add `?source=archive` to read from MongoDB. |
| `GET /api/devices/:deviceId/files?path=` | Dashboard | Browse POS log files under `FILE_ROOT`. A folder returns its listing with full paths, a file returns its content, and anything else returns 404. |
| `GET /api/agent/commands`, `POST /api/agent/commands/:id/result` | Agent | Request channel for file browsing. The agent long-polls, so no inbound port is opened at the store. |
| `DELETE /api/stores/:storeId` | Admin | Remove a store and all its registers. See [Removing a store or register](#removing-a-store-or-register). |
| `DELETE /api/devices/:deviceId` | Admin | Remove one register. |

## Removing a store or register

This is available through the API only; the dashboard has no remove button.
Removal deletes the registers' live state, alerts and incident snapshots. With MongoDB, their stored events and incidents are deleted too.
Open dashboards drop them straight away.

```bash
curl -X DELETE -H "X-Admin-Key: <key>" https://<server>/api/stores/00001        # the store and every register in it
curl -X DELETE -H "X-Admin-Key: <key>" https://<server>/api/devices/POS-00001-REG01-PC   # one register
```

- The reply lists what was removed: `{ removed: { devices, alerts, incidents }, archive }`. An unknown store or register returns 404.
- Registers with no store ID are grouped as `Unassigned`, which is also the store ID to use for them.
- `X-Admin-Key` must be one of `ADMIN_API_KEYS`. When that setting is empty, anyone who can reach the API can remove stores, so set it in production.
- **Uninstall the agent first** (`./pos-agent.sh uninstall` on each register). A register whose agent is still running reappears at its next upload, which is at most a minute later.

## POS log files

Logs stay on each POS under `C:\XeniaRetail\Logs`. A request travels through the server to the agent and back:

```
web ── GET /api/devices/POS-01/files?path=C:\XeniaRetail\Logs\BackOffice ──► server ──► agent (waiting long-poll)
web ◄──────────────── listing or file content ──────────────── server ◄── POST result ── agent reads the folder
```

The response depends on the path:

| Path | Response |
| --- | --- |
| A folder | `{ kind: "directory", entries: [{ name, path, type, size, modified, readable }] }`. Add `&recursive=true` to include subfolders. |
| A file | `{ kind: "file", content, size, offset, length, hasMoreBefore, hasMoreAfter, redacted }` |
| Missing | 404 `not-found`. If the folder exists, the message says so. |
| Outside the root | 403 `denied`, from both the server and the agent. |
| Agent not polling | 503 `agent-offline`, returned immediately. |
| No answer | 504 `timeout`, after `FILE_REQUEST_TIMEOUT_SECONDS`. |

Large files are paged:
- By default the request returns the last chunk, which holds the newest lines. The chunk size is set by the agent's `FileAccess:MaxReadBytes`, 1 MB by default.
- `&offset=N` returns the chunk starting at byte N.
- `&tail=false` starts from the top of the file.

Paths can be absolute, such as `C:\XeniaRetail\Logs\BackOffice`, or relative to the root, such as `BackOffice`.

The server checks every path and refuses parent-folder steps, other drives, network paths, wildcards and alternate data streams. The agent repeats every check and also refuses links and junctions.
The agent opens only the extensions in `FileAccess:AllowedExtensions`, but lists all files. It masks card numbers, passwords, tokens and emails in the content, and it logs every request on the POS.

The dashboard endpoints send cross-origin (CORS) headers only for the origins listed in `CORS_ORIGINS`.
Set `TELEMETRY_API_KEYS` in production. The read endpoints have no login, so put them behind a VPN or an authenticating reverse proxy.

## Deploy to Azure Web App

The workflow `.github/workflows/azure-webapp.yml` at the repository root deploys this folder. It runs on pushes to `main` that change `server/`.
It runs on every push to `main`, or manually from the Actions tab. It installs production dependencies, starts the API once and checks `/api/health`, then zips `src`, `node_modules` and the package files and deploys them. After the deploy it calls `/api/health` on the live site.

One-time setup:

1. Create a Web App: **Linux**, runtime **Node 22 LTS**. The startup command can stay empty, because App Service runs `npm start` and sets `PORT` itself.
2. In the Web App, download the **publish profile**. If the download is disabled, turn on *SCM Basic Auth Publishing Credentials* under **Configuration > General settings**.
3. In the GitHub repository, under **Settings > Secrets and variables > Actions**:
   - add the secret `AZURE_WEBAPP_PUBLISH_PROFILE` with the full XML of the publish profile;
   - add the variable `AZURE_WEBAPP_NAME` with the Web App's name.
4. Under **Configuration > General settings**, turn **Always on** on, so the in-memory live window and the agents' long-polls are not stopped when the site is idle.
5. Under **Environment variables**, add these app settings:

| Setting | Value |
| --- | --- |
| `SCM_DO_BUILD_DURING_DEPLOYMENT` | `false`. The package already contains `node_modules`. |
| `DATA_DIR` | `/home/data`. `/home` survives restarts and redeploys; the app folder may not. |
| `CORS_ORIGINS` | The dashboard's URL, such as `https://pos-dashboard.azurewebsites.net` |
| `TELEMETRY_API_KEYS` | The keys the agents use |
| `ADMIN_API_KEYS` | The key for removing stores and registers |
| `MONGODB_URI` | Optional, such as an Azure Cosmos DB for MongoDB or Atlas connection string |

Keep the Web App at **one instance**. Live data, incident state and the file-request relay are held in the process, so a second instance would see a different set of devices.

Point agents at the site over HTTPS, with no port:

```json
"TelemetryApi": { "BaseUrl": "https://<app-name>.azurewebsites.net", "ApiKey": "<one of TELEMETRY_API_KEYS>" }
```

Set the dashboard's `NEXT_PUBLIC_API_URL` to the same address and rebuild it.

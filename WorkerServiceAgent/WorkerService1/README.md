# POS Monitoring Agent

A Windows service (.NET 8 Worker Service) that runs on each POS machine. It collects
operating-system metrics, POS application health, SQL connectivity, and filtered logs.
Everything goes into a local SQLite queue first and is uploaded to the central API when
the network is available.

## Layout

| Folder | Contents |
| --- | --- |
| `Workers/` | `SystemMetricsWorker`, `ApplicationHealthWorker`, `LogCollectionWorker`, `HeartbeatWorker`, `TelemetryUploadWorker`, plus the `PeriodicWorker` base class |
| `Collectors/` | CPU, memory, disk, network, process, SQL health, Windows Event Log, and POS log files |
| `Services/` | `DeviceIdentityService`, `LocalQueueService` (SQLite outbox), `TelemetryApiClient`, `SensitiveDataRedactor`, shared runtime state |
| `Models/` | Event payloads and queue/upload types |
| `Configuration/` | Strongly typed options bound from `appsettings.json` |
| `Installer/` | `publish.ps1`, `install.ps1`, `uninstall.ps1`, `pos-agent.sh` (Git Bash wrapper for both) |

## What is sent and how often (defaults)

| Event type | Content | Priority | Interval |
| --- | --- | --- | --- |
| `metrics` | CPU, RAM, disks, network, uptime, latest application + connectivity snapshot | normal | 60 s |
| `heartbeat` | last seen, agent uptime, queue backlog, upload health | high | 60 s (only newest kept while offline) |
| `application.state` | POS stopped / started / restarted / not responding | critical when it stops | on change (checked every 30 s) |
| `connectivity.change` | local SQL lost / restored | high / normal | on change (checked every 60 s) |
| `log` | Windows Critical/Error events and POS log errors, redacted | critical / high / normal | batch every 2 min |

Critical events wake the upload worker immediately. Those immediate uploads are rate-limited
by `TelemetryApi:CriticalFlushMinIntervalSeconds`.

### Event envelope

Every event carries these fields; the payload fields are merged in at the top level.

```json
{
  "eventId": "6f1c...",          // GUID, unique per event – use it for deduplication
  "schemaVersion": 1,
  "sequenceNumber": 1042,        // per device, strictly increasing, persisted across restarts
  "eventType": "metrics",
  "priority": "normal",
  "deviceId": "POS-STORE001-01",
  "storeId": "STORE001",
  "timestamp": "2026-11-02T10:30:00.000Z",
  "agentVersion": "1.0.0",
  "system": { "os": "Windows 11", "cpuUsage": 42.5, "totalMemoryMB": 16384, "usedMemoryMB": 11200, "diskFreeGB": 120.5, "uptimeSeconds": 864000, ... },
  "application": { "name": "StellaNova POS", "version": "5.2.1", "processRunning": true, ... },
  "connectivity": { "localSqlConnected": true, "centralApiConnected": true, "apiResponseTimeMs": 125, ... }
}
```

Sequence numbers can have gaps. Gaps appear when an older pending heartbeat is replaced,
or when retention drops old events during a long outage. Gaps do not mean events were lost in transit.

## Central API contract

```
POST {BaseUrl}/api/telemetry/batch
Headers: X-Api-Key, X-Device-Id, Content-Type: application/json (Content-Encoding: gzip if EnableGzip)
Body:    { "deviceId": "...", "storeId": "...", "sentAt": "...", "events": [ <envelope>, ... ] }

200 OK
Body:    { "acknowledgedEventIds": ["..."], "rejectedEventIds": ["..."] }

GET {BaseUrl}/api/health   -> any 2xx (used for centralApiConnected / apiResponseTimeMs)
```

- An event is deleted locally only when its id appears in `acknowledgedEventIds` or `rejectedEventIds`.
- A 2xx response without that body is treated as a failure, and the data is kept.
- 408, 429 and 5xx responses are retried with exponential backoff and jitter. `Retry-After` is honoured.
- 401 and 403 are retried, because they indicate a configuration problem, not bad data.
- Other 4xx responses split the batch in half to isolate the bad event. That event is dropped after `LocalQueue:MaxDeliveryAttempts` rejections.
- The server must deduplicate on `eventId`, because a lost response leads to a resend.

## Offline behaviour

1. Every event is written to `%ProgramData%\PosMonitoringAgent\telemetry-queue.db` first, inside a transaction that assigns its sequence number.
2. Uploads that fail back off from 5 s up to 5 min, with jitter.
3. When the API is reachable again, the queue drains highest priority first, then oldest first.
4. Retention runs every 10 minutes, even while offline.
   - Routine events older than 72 h are deleted.
   - Critical and high events older than 14 days are deleted.
   - Metrics older than 6 h are thinned to one sample per 15 minutes.
   - The database is capped at 200 MB. At the cap, the lowest-priority, oldest events are dropped first.

## Privacy

- The agent never reads transaction tables row by row. `SqlHealth:TransactionHealthQuery` is optional. Only its numeric, boolean and date columns are reported, and text columns are ignored.
- Every log message passes through `SensitiveDataRedactor`. It redacts Luhn-valid card numbers, track data, CVV/PIN values, password/token/API-key values, bearer tokens, emails and SSN-style numbers.
- Messages are truncated, identical log lines are merged, and each collection cycle is capped.

## Configuration

`appsettings.json` ships with the exe and holds the defaults. Machine-specific values go in
`%ProgramData%\PosMonitoringAgent\agentsettings.json`, which `install.ps1` writes and upgrades keep.
Environment variables prefixed `POSAGENT_` (e.g. `POSAGENT_Agent__StoreId`) and command-line
arguments (`--Agent:StoreId=STORE001`) override both.

Settings you must provide per deployment:

- `Agent:StoreId` (required, from `appsettings.json` or `-StoreId`). `Agent:DeviceId` defaults to `POS-{StoreId}-{MachineName}`.
- `TelemetryApi:BaseUrl` and `TelemetryApi:ApiKey`. If BaseUrl is empty, data stays in the local queue.
- `PosApplication:ProcessNames`, the real POS exe name without `.exe`. Optionally `ExecutablePath` and `LogDirectory`.
- `SqlHealth:ConnectionString`. The service runs as LocalSystem, so with Integrated Security the SQL login is `NT AUTHORITY\SYSTEM`. That login needs CONNECT permission, plus SELECT on whatever `TransactionHealthQuery` reads.

## Build, run, deploy

```powershell
# Local run (Development settings: .\data queue, short intervals, notepad as the "POS")
dotnet run --project WorkerService1

# Self-contained single-file package in <solution>\publish (includes install/uninstall scripts)
.\WorkerService1\Installer\publish.ps1

# On the POS, elevated PowerShell, from the publish folder.
# Every option is optional: anything not given comes from appsettings.json (Agent:StoreId, TelemetryApi:BaseUrl, ...).
.\install.ps1
.\install.ps1 -StoreId STORE001 -ApiBaseUrl https://telemetry.example.com -ApiKey "<key>" `
    -SqlConnectionString "Server=localhost;Database=StellaNovaMRF;Integrated Security=True;TrustServerCertificate=True"
.\uninstall.ps1            # add -RemoveData to delete queue and settings
```

The same from Git Bash, from the publish folder. When the shell is not elevated, a UAC prompt opens:

```bash
./pos-agent.sh install                      # values from appsettings.json
./pos-agent.sh install --store-id STORE001 --api-url https://<app>.azurewebsites.net --sql "Server=...;Database=StellaNovaMRF;..."
./pos-agent.sh status
./pos-agent.sh uninstall                    # add --remove-data to delete queue and settings
```

The service is registered with delayed automatic start and restarts automatically on failure.
Its own warnings and errors also go to the Windows Application event log under the source `PosMonitoringAgent`.

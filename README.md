# POS Monitoring

| Folder | What it is | Default port |
| --- | --- | --- |
| `WorkerServiceAgent/` | .NET Windows service on each POS. Collects OS metrics, POS health, SQL connectivity and logs, and queues them offline in SQLite. | none |
| `server/` | Express API. Receives agent batches, keeps a live 10-minute window, and captures incident snapshots. MongoDB is optional. | 4000 |
| `web/` | Next.js and Tailwind dashboard. Reads from the Express API and stays live over Server-Sent Events. | 3100 |

## Run locally

```powershell
cd server; npm install; npm start          # http://localhost:4000
cd web;    npm install; npm run build; npm start   # http://localhost:3100
cd server; npm run simulate                # optional demo fleet
```

Point agents at the API by setting `TelemetryApi:BaseUrl` to `http://<server>:4000`.

# logikos-dsp

An open, self-hostable replacement for **ManageEngine DataSecurity Plus**.

logikos-dsp covers the four core DSP capabilities:

- **File audit / FIM** — real-time file create/modify/delete/rename/permission events from watched paths.
- **Data risk assessment** — content classification of files (PII/PCI-style pattern matches) to flag sensitive data sitting in the wrong place.
- **Ransomware / anomaly detection** — rate- and pattern-based detection of mass file changes, with alerting.
- **Disk / storage analysis** — periodic storage usage snapshots per watched path.

See [ARCHITECTURE.md](./ARCHITECTURE.md) for how the pieces fit together and why.

## Layout

```
packages/
  shared/          # shared TypeScript types (events, alerts, policies) used by every service
  backend/         # Fastify API: ingestion, storage (Postgres/Prisma), rules engine, REST API
  agent/           # filesystem watcher — runs on/near a file server, emits FileEvents
  classification/  # background worker — scans file content for sensitive data patterns
  dashboard/       # React admin console
```

## Quickstart (dev)

```bash
pnpm install
pnpm db:up           # starts Postgres via docker compose
pnpm db:migrate       # applies Prisma schema
pnpm dev:backend      # http://localhost:4000
pnpm dev:classification
pnpm dev:agent        # set WATCH_PATH env var to the directory to monitor
pnpm dev:dashboard    # http://localhost:5173
```

## Status

Early scaffold — a thin vertical slice runs end to end (agent → backend ingest → rules/classification → dashboard), but detection rules, storage backends (NAS/SMB/cloud), and auth are still minimal. Not production-ready.

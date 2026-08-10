# logikos-dsp

An open, self-hostable replacement for **ManageEngine DataSecurity Plus**.

logikos-dsp covers the four core DSP capabilities:

- **File audit / FIM** — real-time file create/modify/delete/rename/permission events from watched paths.
- **Data risk assessment** — content classification of files (PII/PCI-style pattern matches, plus local named-entity recognition for names/organizations/locations) to flag sensitive data sitting in the wrong place.
- **Ransomware / anomaly detection** — rate- and pattern-based detection of mass file changes, with alerting and an approve-first webhook notification response.
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
cp packages/backend/.env.example packages/backend/.env  # set a real JWT_SECRET/ADMIN_PASSWORD/RESPONSE_WEBHOOK_URL before anything but local dev
pnpm db:seed          # creates the first ADMIN user from ADMIN_EMAIL/ADMIN_PASSWORD in that .env
pnpm dev:backend      # http://localhost:4000
pnpm dev:classification  # first run downloads the local NER model (~100MB, cached after) — expect ~20-30s startup
pnpm dev:agent        # set WATCH_PATH env var to the directory to monitor
pnpm dev:dashboard    # http://localhost:5173 — log in with ADMIN_EMAIL/ADMIN_PASSWORD
```

Dashboard endpoints (`/events`, `/alerts`, `/storage`, `/classification-*`, `/users`) require login; agent endpoints (`/agents/register`, `/ingest/*`) don't and never will — see [ARCHITECTURE.md](./ARCHITECTURE.md#authrbac).

### SMB connector (dev)

Watches a real SMB/CIFS share instead of a local path (see [ARCHITECTURE.md](./ARCHITECTURE.md) for why it uses periodic snapshot diffing rather than real-time events). Point it at a real file server, or spin up a local test share:

```bash
pnpm smb:up   # starts a test Samba share (dperson/samba) at localhost:445, backed by ./.smb-test-data

NODE_OPTIONS=--openssl-legacy-provider \
SOURCE_TYPE=smb \
SMB_HOST=localhost \
SMB_SHARE=share \
SMB_USERNAME=testuser \
SMB_PASSWORD=testpass \
pnpm dev:agent

pnpm smb:down # when done
```

## Running tests

`packages/agent` and `packages/classification` run pure-logic unit tests with no external services. `packages/backend` needs a dedicated test database (one-time setup):

```bash
pnpm db:up   # if not already running
docker exec logikos-dsp-postgres-1 psql -U logikos -d postgres -c "CREATE DATABASE logikos_dsp_test;"
cp packages/backend/.env.test.example packages/backend/.env.test  # edit if you changed Postgres credentials

pnpm test    # runs every package's suite (pnpm -r test); packages without one are skipped
```

`packages/backend`'s suite applies pending migrations to `logikos_dsp_test` automatically on every run — no separate migrate step needed. `packages/dashboard` has no test suite yet (see [ARCHITECTURE.md](./ARCHITECTURE.md#testing)).

## Status

Early scaffold — a thin vertical slice runs end to end (agent → backend ingest → rules/classification → dashboard) for both local paths and SMB shares, with cookie/JWT auth and two-role RBAC (ADMIN/VIEWER) gating the dashboard API, classification combining regex pattern matching with a local NER model (person/org/location detection, no data leaves the machine), and an approve-first webhook notification response action for HIGH/CRITICAL alerts. Cloud storage connectors and file quarantine are still open. Not production-ready.

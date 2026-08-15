# logikos-dsp

An open, self-hostable replacement for **ManageEngine DataSecurity Plus**.

logikos-dsp covers the four core DSP capabilities:

- **File audit / FIM** — real-time file create/modify/delete/rename/permission events from watched paths.
- **Data risk assessment** — content classification of files (PII/PCI-style pattern matches, plus local named-entity recognition for names/organizations/locations) to flag sensitive data sitting in the wrong place.
- **Ransomware / anomaly detection** — rate- and pattern-based detection of mass file changes, with alerting and approve-first response actions (webhook notification; file quarantine for sensitive-data alerts on local paths).
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

### Microsoft 365 connector (setup)

Watches a OneDrive/SharePoint drive via Microsoft Graph (see [ARCHITECTURE.md](./ARCHITECTURE.md) for the design, and — importantly — that **this connector hasn't been verified against a real tenant yet**, only against Microsoft's documented API contract). One-time Azure AD setup:

1. In the [Azure Portal](https://portal.azure.com) → Microsoft Entra ID → App registrations, register a new app.
2. Under **API permissions**, add **Microsoft Graph → Application permissions** → `Files.Read.All` (and `Sites.Read.All` if watching a SharePoint document library rather than a personal OneDrive). Click **Grant admin consent**.
3. Under **Certificates & secrets**, create a new client secret — copy its value immediately, it's not shown again.
4. Note the **Application (client) ID**, **Directory (tenant) ID**, and the client secret from steps above.
5. Find the `driveId` to watch: with an admin token, `GET https://graph.microsoft.com/v1.0/me/drive` (for a specific user's OneDrive: `/users/{id}/drive`) or `GET https://graph.microsoft.com/v1.0/sites/{site-id}/drive` (for a SharePoint document library) — the [Graph Explorer](https://developer.microsoft.com/en-us/graph/graph-explorer) is the easiest way to run these once signed in as an admin.

```bash
SOURCE_TYPE=m365 \
M365_TENANT_ID=<tenant-id> \
M365_CLIENT_ID=<client-id> \
M365_CLIENT_SECRET=<client-secret> \
M365_DRIVE_ID=<drive-id> \
pnpm dev:agent
```

## Deployment

Each service has its own Dockerfile (`packages/*/Dockerfile`); `docker-compose.yml` wires all of them together with Postgres for a single-host deployment. This is separate from `pnpm db:up` above, which only starts Postgres for local dev and still works unchanged.

```bash
cp packages/backend/.env.example packages/backend/.env  # real JWT_SECRET/ADMIN_PASSWORD/RESPONSE_WEBHOOK_URL — required, not just for local dev this time
docker compose up -d --build
docker compose exec backend node_modules/.bin/prisma migrate deploy   # first deployment only — the backend image also runs this on every start, so this line is just to seed sooner
docker compose exec backend sh -c 'ADMIN_EMAIL=... ADMIN_PASSWORD=... node_modules/.bin/tsx prisma/seed.ts'
```

The dashboard (`http://localhost:8080` by default) needs to reach the backend from your **browser**, not from inside the Docker network — if the backend isn't reachable at `http://localhost:4000` from wherever you open the dashboard (a different host, a reverse proxy, HTTPS), rebuild it with the real URL: `DASHBOARD_BACKEND_URL=https://dsp.example.com docker compose up -d --build dashboard`.

The agent watches `./data/watched` on the host by default (bind-mounted into the container) — point `WATCH_PATH_HOST` at a real directory instead, or set `SOURCE_TYPE`/`SMB_*`/`M365_*` in `docker-compose.yml`'s `agent` service to watch a share instead of a local path (see the SMB/M365 sections above for what each connector needs).

The classification worker's NER model (~100MB) downloads on first start into a named volume (`classification_cache`) so it persists across restarts — same one-time ~20-30s cost as local dev, just paid once per deployment instead of once per developer machine.

See [ARCHITECTURE.md](./ARCHITECTURE.md#production-packaging) for the packaging design and the bugs it surfaced (Prisma Client silently not generating from a workspace-root install, an OpenSSL version-detection issue that only breaks at runtime).

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

Early scaffold — a thin vertical slice runs end to end (agent → backend ingest → rules/classification → dashboard) for local paths, SMB shares, and (unverified against a live tenant — see above) Microsoft 365 drives, with cookie/JWT auth and two-role RBAC (ADMIN/VIEWER) gating the dashboard API, classification combining regex pattern matching with a local NER model (person/org/location detection, no data leaves the machine), an automated test suite, and approve-first response actions (webhook notification for HIGH/CRITICAL alerts; file quarantine for local-path sensitive-data alerts, via the agent polling for approved commands). Every service now has a Dockerfile and deploys together via `docker compose` (see Deployment above) — verified end to end through real container networking, not just individual `docker build`s. A Google Drive connector and SMB/M365 quarantine are still open. No native low-footprint agent yet (still Node/chokidar — see ARCHITECTURE.md). Not yet hardened for production (no TLS termination, secrets management, or backup story documented).

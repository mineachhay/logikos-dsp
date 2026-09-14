# logikos-dsp

An open, self-hostable replacement for **ManageEngine DataSecurity Plus**.

logikos-dsp covers the four core DSP capabilities:

- **File audit / FIM** — real-time file create/modify/delete/rename/permission events from watched paths.
- **Data risk assessment** — content classification of files (PII/PCI-style pattern matches, plus local named-entity recognition for names/organizations/locations) to flag sensitive data sitting in the wrong place.
- **Ransomware / anomaly detection** — rate- and pattern-based detection of mass file changes, with alerting and approve-first response actions (webhook notification; file quarantine — single file for a sensitive-data alert, every file touched in the burst for a ransomware-rate alert — on local paths).
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
native-agent/      # Go rewrite of packages/agent's local-path watching only — see native-agent/README.md
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

### Google Drive connector (setup)

Watches a Google Drive folder via the Drive API (see [ARCHITECTURE.md](./ARCHITECTURE.md) for the design — same caveat as Microsoft 365 above: **this connector hasn't been verified against a real Google account yet**, only against Google's documented API contract). One-time Google Cloud setup:

1. In the [Google Cloud Console](https://console.cloud.google.com) → IAM & Admin → Service Accounts, create a new service account (no roles/permissions needed at the project level — access is granted per-folder in step 3).
2. On that service account, **Keys** → **Add key** → **Create new key** (JSON) — downloads a JSON file containing `client_email` and `private_key`.
3. In Google Drive, share the folder to watch with the service account's `client_email` (Viewer access) — exactly like sharing it with another person. No Workspace admin/domain-wide delegation needed, personal Google accounts work the same way.
4. Get the folder's ID from its URL: `https://drive.google.com/drive/folders/<folder-id>`.

```bash
SOURCE_TYPE=gdrive \
GDRIVE_CLIENT_EMAIL=<client_email from the JSON key> \
GDRIVE_PRIVATE_KEY=<private_key from the JSON key, \n sequences intact> \
GDRIVE_FOLDER_ID=<folder-id> \
pnpm dev:agent
```

Native Google Docs/Sheets/Slides inside the watched folder are listed (so they show up in File Events and Storage) but not content-scanned — they have no binary representation to sample (see ARCHITECTURE.md).

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

### Behind a shared reverse proxy (this install)

If the backend and dashboard sit behind an existing nginx that terminates TLS —
rather than being reached on `localhost:4000`/`:8080` directly — copy the vhost
from this repo and reload the proxy:

```bash
cp deploy/dsp.conf ../logikos-gateway/conf.d/dsp.conf
cd ../logikos-gateway
docker compose exec nginx nginx -t      # ALWAYS test first; a syntax error on
docker compose exec nginx nginx -s reload   # restart takes every other vhost down
```

It serves the dashboard at `/` and proxies `/api/` to the backend with the
`/api` prefix stripped, so the SPA and the API are same-origin and the session
cookie needs no CORS exemption. Because `VITE_BACKEND_URL` is inlined at image
build time, the public URL belongs in a root `.env` so rebuilds keep it:

```bash
cat > .env << 'ENV'
WATCH_PATH_HOST=/srv/dsp-watch
DASHBOARD_BACKEND_URL=https://dsp.example.com/api
ENV
docker compose up -d --build
```

Also set `NODE_ENV=production` in `packages/backend/.env` — the session cookie's
`Secure` flag is derived from it.

The vhost returns 403 for `/api/ingest/*`, `/api/agent-commands` and
`/api/agents/register`. Those authenticate agents rather than users (and
`register` takes no credential at all), so they are not safe to expose; the
bundled agent reaches the backend over the compose network and is unaffected.
Running an agent on a **remote** host means removing those blocks and putting
real authentication in front of them first.

If you have no Slack/Telegram endpoint yet, `RESPONSE_WEBHOOK_URL` can point at
the bundled `webhook-logger` service, which logs the payload and returns 200 —
without something listening, approving a webhook notification always fails.

## Backup and restore

Everything the product knows lives in one Postgres database. The NER model
cache and the built images are reproducible; the database is not.

```bash
deploy/backup.sh                  # dump now, prune to the newest 30
deploy/restore.sh verify          # prove the newest dump restores (safe)
deploy/restore.sh live --yes      # restore OVER the live database
```

`backup.sh` runs `pg_dump -Fc` **inside** the postgres container, so the client
version always matches the server and the host needs no postgres tooling. It
writes to a `.partial` file and renames only after `pg_restore --list` reads the
result back, so an interrupted or corrupt dump can never be mistaken for a good
one. Dumps land in `BACKUP_DIR` (default `/home/ubnt/backups/logikos-dsp`); at
this data volume they are ~20KB each.

Schedule it from cron — the deployed install uses:

```
PATH=/usr/bin:/bin
15 3 * * * /home/ubnt/logikos-dsp/deploy/backup.sh >> /home/ubnt/backups/logikos-dsp/backup.log 2>&1
```

**Run `deploy/restore.sh verify` periodically.** It restores the newest dump
into a throwaway database, prints its row counts beside the live ones, and drops
it — an untested backup is a guess. `live` refuses to run without `--yes`,
stops the services holding connections, and restarts them afterward, because the
agent registers only at startup and would otherwise keep ingesting against an
`Agent.key` the restored database no longer contains.

**These dumps sit on the same disk as the database they protect**, which covers
operator error, a bad migration or a corrupted table, but not loss of the host
or its disk. Copying `BACKUP_DIR` off-box is the remaining gap. Not covered
either: the gitignored `.env` files — losing `JWT_SECRET` only invalidates
existing sessions, but the values are not reproducible from the repo.

## Running tests

`packages/agent` and `packages/classification` run pure-logic unit tests with no external services. `packages/backend` needs a dedicated test database (one-time setup):

```bash
pnpm db:up   # if not already running
docker exec logikos-dsp-postgres-1 psql -U logikos -d postgres -c "CREATE DATABASE logikos_dsp_test;"
cp packages/backend/.env.test.example packages/backend/.env.test  # edit if you changed Postgres credentials

pnpm test    # runs every package's suite (pnpm -r test); packages without one are skipped
```

`packages/backend`'s suite applies pending migrations to `logikos_dsp_test` automatically on every run — no separate migrate step needed. `packages/dashboard` has no test suite yet (see [ARCHITECTURE.md](./ARCHITECTURE.md#testing)).

CI (`.github/workflows/ci.yml`) runs on every push to `main` and every pull request: install, Prisma generate, `pnpm build` for all packages (type-check), `pnpm test` against a Postgres service, and `gofmt`/`go vet`/`go test` for `native-agent/`.

## Status

Early scaffold — a thin vertical slice runs end to end (agent → backend ingest → rules/classification → dashboard) for local paths, SMB shares, and (unverified against a live tenant/account — see above) Microsoft 365 and Google Drive, with cookie/JWT auth and two-role RBAC (ADMIN/VIEWER) gating the dashboard API, classification combining regex pattern matching with a local NER model (person/org/location detection, no data leaves the machine), an automated test suite, and approve-first response actions (webhook notification for HIGH/CRITICAL alerts; file quarantine for local-path agents, covering both single-file sensitive-data alerts and multi-file ransomware-rate bursts). Every service now has a Dockerfile and deploys together via `docker compose` (see Deployment above) — verified end to end through real container networking, not just individual `docker build`s. SMB/M365/Google Drive quarantine are not supported — all three connectors stay read-only, SMB by hard library limitation rather than by choice (see ARCHITECTURE.md's "SMB quarantine" note — it was actually built and live-tested against a real Samba container, then reverted when that testing found it doesn't work). A native low-footprint agent now exists (`native-agent/`, Go, local-path watching only — SMB/M365/Google Drive stay on the TypeScript agent), live-verified end to end, but uses `fsnotify` rather than the originally-planned NTFS USN journal (no Windows machine available to build/test that against safely — see ARCHITECTURE.md). The dashboard has a module-grouped sidebar (File Audit / Data Risk Assessment / Disk Analysis / Administration), an Overview page with real aggregate charts, search/filter/sort/CSV export on every table, and a Compliance view — deliberately scoped as a data-discovery lens over existing classification results, not a certified compliance audit (see ARCHITECTURE.md's "Dashboard" section). No real share-admin response actions ("disable this share," "kill this process") — the agent watches shares, it doesn't administer them. Deployed behind a TLS-terminating reverse proxy with the agent-facing endpoints closed at the edge, with nightly Postgres backups and an exercised restore path (see above); still missing: authentication for agents on remote hosts, off-box copies of the backups, and secrets management beyond gitignored `.env` files.

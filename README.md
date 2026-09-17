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
cp packages/backend/.env.example packages/backend/.env  # set a real JWT_SECRET/AGENT_ENROLL_TOKEN/ADMIN_PASSWORD/RESPONSE_WEBHOOK_URL before anything but local dev
pnpm db:seed          # creates the first ADMIN user from ADMIN_EMAIL/ADMIN_PASSWORD in that .env
pnpm dev:backend      # http://localhost:4000
pnpm dev:classification  # first run downloads the local NER model (~100MB, cached after) — expect ~20-30s startup
pnpm dev:agent        # set WATCH_PATH (directory to monitor) and AGENT_ENROLL_TOKEN (same value as the backend's)
pnpm dev:dashboard    # http://localhost:5173 — log in with ADMIN_EMAIL/ADMIN_PASSWORD
```

Dashboard endpoints (`/events`, `/alerts`, `/storage`, `/classification-*`, `/agents`, `/users`) require login. Agent endpoints don't use logins; they use machine credentials instead: an agent registers with `AGENT_ENROLL_TOKEN` and gets back its own secret for everything else, re-registering by itself if that secret stops working. Admins can revoke an agent from **Administration → Agents**. See [ARCHITECTURE.md](./ARCHITECTURE.md#agent-authentication).

## File servers (SMB) from the dashboard

Admins add SMB file servers under **Administration → File Servers**, then the
shares (and optionally a folder inside each) to watch. The agent picks up
changes within ~10 seconds — no restart, no env vars:

1. **Add file server** — name, host (`fs01.corp.local` or an IP), optional port
   and domain, and a **read-only** account. The password is encrypted at rest
   and never shown again; editing a server with the password left blank keeps it.
2. **Add share** — share name, optional folder, scan schedule, and which agent
   scans it. **Test connection** has the agent log on and list the folder.
3. The share's **status** shows the last scan, file count and size, or the error.

**Disable** stops scanning and keeps all history. **Delete** also deletes every
event, alert and snapshot collected from it, and asks you to type the name.
Every change is recorded under **Recent changes**.

What to expect from SMB monitoring: changes appear within one scan interval
(each scan walks the whole share, so large shares want longer intervals), events
say *what* changed but not *who*, and quarantine isn't available for shares.

Requirements: the backend needs `SOURCE_CREDENTIALS_KEY` (32 bytes,
`openssl rand -base64 32`) — **back it up somewhere other than the database
dumps**, since restored share passwords can't be decrypted without it. The agent
needs `NODE_OPTIONS=--openssl-legacy-provider` (set in `docker-compose.yml`)
because SMB's NTLM logon uses DES/MD4. Only the TypeScript agent scans managed
shares; the Go agent watches its own `WATCH_PATH` only.

### Who changed files (Windows)

File events normally say *what* changed. To also record *who*, turn on
**Record who changes files** when adding or editing the file server. The agent
then reads the server's Security log over WinRM every 30 seconds and fills in a
**Who** column in File Events.

On the Windows server, once, as administrator:

```powershell
auditpol /set /subcategory:"Detailed File Share" /success:enable
```

The account used for this needs to be in **Event Log Readers** and **Remote
Management Users** — WinRM refuses the connection outright for accounts that
aren't, which looks like a rejected password:

```powershell
Add-LocalGroupMember -Group "Remote Management Users" -Member dsp
Add-LocalGroupMember -Group "Event Log Readers" -Member dsp
```

Nothing else is needed: the collector reads events with `wevtutil`, which works
with that group alone. (`Get-WinEvent` would also require the "Manage auditing
and security log" privilege, which Event Log Readers doesn't grant.) If reads
are refused anyway, check that the log still grants the group with
`wevtutil gl Security` — its `channelAccess` should contain `S-1-5-32-573`:

```powershell
wevtutil sl Security /ca:"O:BAG:SYD:(A;;0xf0005;;;SY)(A;;0x5;;;BA)(A;;0x1;;;S-1-5-32-573)"
``` It can be a different account from the share account — the
share account can stay read-only — or blank to reuse it. WinRM's default port
is 5985.

**Reading and copying out:** a file copied *out* of the share, or simply opened,
changes nothing on it — so there is no file event to record, only a read. Those
reads appear both under **File Access** and (toggleable) in **File Events**, so
a copy to someone's laptop is visible where you'd look for it. Windows logs opening a file
and copying it identically, so a single read can't be called a copy; what does
stand out is volume, which is what the `BULK_FILE_READ` alert is for. Folder
listings are logged the same way as file reads and are filtered out, or they
would bury everything else.

**Copying to a laptop or another machine:** install the Go agent on that
machine (see `native-agent/README.md`) pointed at the folders people copy into.
Each machine becomes its own source, and a file arriving there seconds after
being read from a share is recorded as one `COPIED` event naming both ends and
the person. Without an agent on the receiving machine the copy can only ever
appear as a read — the file server never learns where the bytes went.

**Copying:** a file copied or pasted into the share is reported as `COPIED`,
naming the file it came from when that file is still on the share (copying
preserves a file's timestamp, which is how a paste is told apart from a file
written in place). When several identical files could be the source — the same
file in three folders — the source is only named if read recording is on, since
the copy's read of the original is the only thing that identifies it. A file copied *out* of the share changes nothing
on it, so the only trace is a read — tick **Also record who reads files** to
record those under **File Access**, and logikos-dsp will alert when one account
reads more than 50 different files within five minutes, which is what copying a
folder off a share looks like. Reads are most of a busy share's audit volume, so
this is off by default.

Notes: the username appears within a few seconds of the change, not instantly;
this is Windows-only (Samba doesn't produce 5145 events); the agent's own
access through the share account is ignored, so it never reports itself; and
**only access over the share is recorded** — changes made while signed in to
the server itself, in a local folder, produce no share-access events and so
carry no user.

### SMB connector via env (dev)

Watches one SMB/CIFS share configured on the agent itself, instead of a local path (see [ARCHITECTURE.md](./ARCHITECTURE.md) for why it uses periodic snapshot diffing rather than real-time events). Point it at a real file server, or spin up a local test share:

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
echo "AGENT_ENROLL_TOKEN=$(openssl rand -hex 32)" >> .env  # root .env: compose gives this one value to both backend and agent
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

Also set `NODE_ENV=production` in the backend's env file — the session cookie's
`Secure` flag is derived from it.

Two more root `.env` settings are worth using on a proxied install:

```bash
# Bind backend/dashboard to the address the proxy connects to, so the proxy is
# the only way in. For logikos-gateway (host.docker.internal) that's docker0:
PUBLISH_ADDR=172.17.0.1
# If this host is also used for development, give the deployment its own
# secrets file so dev and prod don't share JWT_SECRET and NODE_ENV:
BACKEND_ENV_FILE=.env.backend
```

Without `PUBLISH_ADDR`, ports publish on `0.0.0.0` — Docker's port rules bypass
ufw — and anyone who can reach the host on `:4000` skips the proxy's blocks
below and can forge `X-Forwarded-For`. With `BACKEND_ENV_FILE` set, point
`packages/backend/.env` at a separate database (e.g. `logikos_dsp_dev`) and
another port (`PORT=4001`, plus `VITE_BACKEND_URL=http://localhost:4001` in
`packages/dashboard/.env.local` and `BACKEND_URL` for the agent).

The vhost used to return 403 for `/api/ingest/*`, `/api/agent-commands` and
`/api/agents/register`, from before agents authenticated. They now carry a
per-agent secret, so they are exposed like any other authenticated route, which
is what lets an agent run on a **remote** machine — a workstation watching the
folders people copy files into. `/api/agents/register` is the exception: it
takes the deployment-wide `AGENT_ENROLL_TOKEN`, so the vhost rate limits it to
6 requests/minute per IP (429 when exceeded) to keep that one shared secret out
of reach of online guessing. Real agents register at startup and after a 401,
far below the limit.

## Sign-in protection

The dashboard throttles password guessing: five wrong passwords in a row locks
that account for a minute, then longer (up to half an hour) if it continues, and
twenty failures from one IP address in fifteen minutes blocks that address for
fifteen. Locks expire on their own — nobody can lock an admin out permanently.

Every failed sign-in says the same thing, so the form can't be used to find out
which accounts exist. A lockout raises a `LOGIN_ATTACK` alert you can send to
Telegram like any other.

## Notifications (Telegram)

Approving a **webhook notification** response action sends the alert to every
configured channel. For Telegram, in the backend's env file:

```bash
TELEGRAM_BOT_TOKEN="123456:ABC..."   # from @BotFather
TELEGRAM_CHAT_ID="..."               # see below
```

A bot can only message a chat that has talked to it first. Send the bot any
message (or add it to a group and post there), then read the chat id:

```bash
curl -s "https://api.telegram.org/bot$TELEGRAM_BOT_TOKEN/getUpdates" | grep -o '"chat":{"id":-\?[0-9]*'
```

Group ids are negative. If Telegram upgrades the group to a supergroup (it does
this on its own, e.g. when group settings change), the id changes to a
`-100...` one and sends to the old id fail with "bot was kicked from the group
chat" — read `getUpdates` again and use the new id. `RESPONSE_WEBHOOK_URL` (a generic JSON POST — Slack,
n8n, anything) can be set alongside or instead; with both, the action is
`EXECUTED` only if both succeed, and its result message records each. If you
have no endpoint at all yet, point `RESPONSE_WEBHOOK_URL` at the bundled
`webhook-logger` service, which logs the payload and returns 200. It's opt-in:
`docker compose --profile webhook-logger up -d webhook-logger`, then
`RESPONSE_WEBHOOK_URL="http://webhook-logger:9099/hook"`.

## Backup and restore

Everything the product knows lives in one Postgres database (plus the env files
holding its secrets). Backups are configured in the dashboard under
**Administration → Backups** and run by the `backup` container.

**Set up (once):**

1. On **your own computer**, install [age](https://age-encryption.org) and run
   `age-keygen -o logikos-dsp-backup.key`. Keep that file offline — a password
   manager is ideal. **Without it no off-box backup can be restored.** Paste only
   its `Public key: age1…` line into the dashboard.
2. Pick a destination:
   - **S3-compatible bucket** — Cloudflare R2, Backblaze B2, AWS S3, Wasabi or
     MinIO. Create the bucket and a key that can read, write and delete in it.
   - **Another server over SFTP** — preferably a dedicated user with a private
     key; paste `ssh-keyscan <host>` output into *Server host key* so the
     server's identity is checked.
   - **Google Drive** — either a Google account (run `rclone authorize "drive"`
     on any computer with a browser and paste the JSON it prints) or a service
     account, which only works with a **Shared drive** it's a member of.
3. **Save**, then **Test destination**, then **Back up now**, and turn on the
   daily schedule (time is UTC) and the weekly restore check.

**What a backup is:** a local dump in `BACKUP_DIR_HOST` (for fast restores on
this host), and an encrypted bundle uploaded to the destination —
`logikos-dsp-<UTC time>.tar.age` containing the dump, the backend and root env
files, a manifest with checksums, and `RESTORE.txt`. That one file is enough to
rebuild on a new host. Retention (how many to keep locally and remotely) is set
on the same page. A failed backup or restore check raises a `BACKUP_FAILED`
alert, which you can approve to send to Telegram.

**Restore from an off-box backup:**

```bash
age -d -i logikos-dsp-backup.key logikos-dsp-20260915T031500Z.tar.age | tar -x
# then follow RESTORE.txt: put backend.env and root.env back, restore logikos_dsp.dump
```

**Roll this host back to a recent local dump:**

```bash
deploy/restore.sh verify          # prove the newest dump restores (safe)
deploy/restore.sh live --yes      # restore OVER the live database
```

`live` refuses to run without `--yes`, stops the services holding connections,
and restarts them afterwards. `deploy/backup.sh` still works for a one-off dump
from the host. If you schedule it from cron, remove that entry once the
dashboard schedule is on, or both will dump nightly.

Deployment notes: the `backup` service needs the root `.env` to exist, runs as
UID/GID `BACKUP_UID`/`BACKUP_GID` (default 1000, the owner of the env files and
the dump directory), and writes dumps to `BACKUP_DIR_HOST` (default
`./data/backups`).

## Data retention

Under **Administration → Retention**, set how long to keep file events,
who-changed-files records, storage snapshots, resolved alerts and sign-in
attempts. It's **off until you turn it on**, and each limit is shown beside how
many rows are stored today. Cleanup runs hourly, or immediately with **Run
cleanup now**.

Deleting is permanent — set up Backups first. Some things are never deleted: the
newest storage snapshot for each source (so a quiet share keeps showing its
size), and alerts that are still open or acknowledged.

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

# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

logikos-dsp is a self-hostable replacement for ManageEngine DataSecurity Plus: file audit/FIM, data risk assessment (content classification), ransomware/anomaly detection with approve-first response actions, and storage analysis.

`README.md` covers setup and connector credentials. **`ARCHITECTURE.md` is the primary design record** — it documents not just what exists but why, including several things that were built and then reverted (SMB quarantine) or deliberately scoped out (USN journal, share-admin response actions). Read the relevant section before changing a design decision; the rationale is usually load-bearing and the failures it records were found the hard way.

## Commands

```bash
pnpm install
pnpm db:up                # Postgres only (docker compose up -d postgres)
pnpm db:migrate           # prisma migrate dev
pnpm db:seed              # first ADMIN from ADMIN_EMAIL/ADMIN_PASSWORD in packages/backend/.env

pnpm dev:backend          # :4000
pnpm dev:dashboard        # :5173
pnpm dev:agent            # needs WATCH_PATH (local mode) or SOURCE_TYPE + that connector's vars
pnpm dev:classification   # first run downloads the ~100MB NER model (~20-30s)

pnpm build                # all packages; shared must build before the others
pnpm test                 # pnpm -r test
```

Env files are per-package and gitignored: `packages/backend/.env` (from `.env.example`), `packages/backend/.env.test` (from `.env.test.example`), and `packages/classification/.env` — which has **no** example file; it needs `DATABASE_URL` (and optionally `POLL_INTERVAL_MS`) — and optionally `packages/dashboard/.env.local` (from `.env.example`, just `VITE_BACKEND_URL`). Backend and classification both start via `--env-file=.env`, so a missing file is a hard startup failure.

There is no linter configured anywhere — `tsc` (via each package's `build`) is the only static check, plus `gofmt`/`go vet` for `native-agent/`. CI (`.github/workflows/ci.yml`) runs build, tests (with a Postgres service) and the Go checks on every push to `main` and on pull requests. CI runs `prisma generate` explicitly before `pnpm build` — the backend's `tsc` fails without a generated client, so do the same after a fresh install.

### Tests

Agent, classification, shared and backup run pure-logic Vitest suites (the dashboard has none) with no external services. **Backend tests need a real Postgres test database**, one-time:

```bash
docker exec logikos-dsp-postgres-1 psql -U logikos -d postgres -c "CREATE DATABASE logikos_dsp_test;"
cp packages/backend/.env.test.example packages/backend/.env.test
```

On a machine without Docker, the `run-logikos-dsp` skill sets up Postgres 16 in `$HOME` from Ubuntu's own `.deb`s (no root) and creates both databases with plain `psql`.

`packages/backend/vitest.config.ts`'s `globalSetup` runs `prisma migrate deploy` on every invocation; `test/setup.ts` truncates tables per test. `fileParallelism: false` is deliberate — all files share that one database. Only `pnpm test` loads `.env.test`; bare `npx vitest` lets Prisma fall back to `packages/backend/.env`, so `test/assertTestDatabase.ts` aborts unless the database name ends in `_test` (that path has already wiped the dev database once).

```bash
pnpm --filter @logikos-dsp/backend test                          # one package
pnpm --filter @logikos-dsp/backend test src/routes/auth.test.ts  # one file — never bare `npx vitest` (see below)
cd native-agent && go test ./...                                 # Go agent
```

Vitest is pinned to `3.2.4` in every package that has tests (4.x would force a Vite major bump the dashboard isn't ready for); `@fastify/jwt`@8.0.1 and `@fastify/cookie`@9.4.0 are pinned to their last Fastify-4-compatible majors. Don't bump any of these piecemeal.

There is a `run-logikos-dsp` skill (`.claude/skills/`) for starting the stack and driving the dashboard with Playwright — prefer it over ad-hoc startup. Its `stack.sh up|down|restart|status` brings up Postgres, backend :4000, agent, classification and dashboard :5173 in one step. Note it assumes a clean machine where 5432/4000/5173 are free, which is not true on the production host (see below).

## Architecture

Six workspace packages (shared, backend, agent, classification, dashboard, backup) plus a Go agent, joined by one deliberately plain HTTP contract:

```
watched source → [agent] --FileEvent/StorageSnapshot--> POST /ingest/* → [backend/Fastify] → Postgres
                                                                            ├─ ransomware-rate rule (inline)
                                                                            └─ ClassificationJob queue
                                                   [classification worker] ─┘ → ClassificationMatch + Alert
                                        [dashboard/React] ←── REST ──→ [backend]
```

**Remote install (`routes/deployments.ts`, `agent/winrm/deploy.py`) never stores credentials**: `Deployment` has no password column, and `deployCredentials.ts` holds them in backend memory until the agent collects the job. A restart loses pending jobs, deliberately. The install goes over WinRM/PSRP, pushing the binary from `AGENT_INSTALLER_PATH` (`./dist`, mounted into both backend and agent).

**Discovery is queued by the backend and run by an agent** (`routes/discovery.ts`, `agent/src/discovery.ts`): a TCP sweep of 445/3389/5985 over a CIDR the backend expands and caps at 1,024 addresses, joined against registered agents by `coverageFor` in `packages/shared/src/discovery.ts` to show which machines have no agent. No credentials anywhere in it.

**The Agents page serves the agent binary** (`GET /agents/installer`, ADMIN-only, read from `AGENT_INSTALLER_PATH` — `./dist` mounted in compose, not baked into the image) together with a ready-to-paste install command carrying this deployment's URL and enroll token. Dropping a new `dist/agent.exe` on the host is the whole of shipping an agent update.

**The Go agent is also a Windows service** (`cmd/agent/service_windows.go`, `install_windows.go`): it implements `svc.Handler` and installs itself, because `sc.exe create` on a plain console program produces a service that dies with error 1053. `runAgent(cfg, stop)` in `run.go` is shared by the console, service and container paths.

**The Go agent is configured by `agent.json` next to its executable, or the environment, which wins** (`native-agent/internal/config/file.go`; `Resolve` is the pure part, `Load` the disk-and-exit part). `connectIp` and `caCertFile` exist because this deployment sits behind Cloudflare: a workstation dials the origin's LAN address while still verifying `serverUrl`'s hostname, trusting the Cloudflare Origin CA that Windows doesn't ship. An IP in `serverUrl` cannot work — origin certs carry DNS names, and nginx routes by `server_name`.

**`packages/shared` is the wire contract, and it matters more than its size suggests.** The agent is isolated behind plain HTTP specifically so it can be reimplemented in another language — which has already happened once (`native-agent/`, Go). `native-agent/internal/wire` hand-mirrors the backend's Zod schemas and `internal/config` reproduces the TypeScript agent's key derivation (`agent-<sha256(hostname:local:watchPath)[:24]>`) exactly, so both implementations register as the *same* `Agent` row. Changing an ingest schema means updating the Zod schema, `packages/shared`, and the Go `wire` package together — and since agent auth, agents and backend must be upgraded together too.

**Two identity systems, on separate code paths, never mixed.** Agents authenticate as machines on `/agents/register`, `/ingest/*`, `/agent-commands*` — never behind the user JWT — via `auth/agentAuth.ts`: `AGENT_ENROLL_TOKEN` on register only, which returns a per-agent secret (sha256 stored, **rotated on every registration**) for everything else. Agents hold the secret in memory and re-register on 401 (`packages/agent/src/agentSession.ts`, Go `internal/client`); 403 means revoked and isn't retried. `Agent.key` alone is derivable, not a credential. `User` + a cookie-based JWT authenticates people: every dashboard route self-gates via `app.addHook("onRequest", app.authenticate)` inside its own route file. `app.ts` marks the split with comments — keep them accurate when adding routes. Roles are `ADMIN` (everything, incl. `PATCH /alerts/:id`, user management and agent revoke/restore) and `VIEWER` (read-only). Login is throttled per account (lockout with backoff) and per IP (`auth/loginThrottle.ts`, state in Postgres), with one deliberately vague failure message; a lock raises a `LOGIN_ATTACK` alert. A global error handler in `app.ts` turns `ZodError` from any route's `schema.parse()` into a 400.

**Two database clients, by design.** The backend uses Prisma and owns the schema and migrations for everything; the classification worker talks to the same tables with raw `pg` (`SELECT ... FOR UPDATE SKIP LOCKED` job claiming, safe for multiple workers). Consequently the "HIGH/CRITICAL alert also gets a PENDING `ResponseAction`" step is duplicated at both alert-creation sites (`rules/ransomwareRate.ts` and `classification/src/index.ts`) rather than centralized across that process boundary. Adding an alert source means adding that step again, deliberately.

**Response actions are suggest-and-approve, never automatic.** `WEBHOOK_NOTIFICATION` executes synchronously on approve (`EXECUTED`/`FAILED`), sending to every configured channel — Telegram (`TELEGRAM_BOT_TOKEN`+`TELEGRAM_CHAT_ID`, `responseActions/telegram.ts`) and/or `RESPONSE_WEBHOOK_URL` — and fails if any configured channel does. `FILE_QUARANTINE` can't — only the agent can touch the filesystem — so it has an extra `APPROVED` state that exists solely for this: the agent polls `GET /agent-commands?agentKey=...`, acts, then `POST /agent-commands/:id/complete`. Target paths come from the linked `Alert.metadata` (`path` for sensitive-data, `affectedPaths` for a ransomware burst, capped at 200), normalized to one `paths: string[]` shape server-side.

**`supportsQuarantine(watchedRoot)` in `packages/shared` (`!watchedRoot.includes("://")`) is the single gate** on whether a connector is write-capable. Local paths qualify; SMB/M365/Google Drive all carry a scheme and don't — SMB because `v9u-smb2`'s write path is broken against a properly secured server (built, live-tested, reverted; see ARCHITECTURE.md), M365/Google Drive because their OAuth scopes are read-only by choice. A new URI-based connector is excluded automatically.

**Attribution stops where knowledge does.** Local file events carry no user — `ReadDirectoryChangesW` reports what changed, never who — so an audited actor exists only where a Windows audit log does (the share's 5145) or where a copy correlates to one. The agent additionally reports the file's *owner* (`FileEvent.ownerUser`, `watch/owner_windows.go`), kept apart from `actorUser` and displayed as "(owner)" because ownership survives a move and can be changed: it answers whose file it is, not who did it. On a shared machine, several accounts reading the same file in the window means the copy is recorded without an actor rather than with a guessed one.

**Removable media is its own case.** The Go agent watches USB drives while plugged in (`cmd/agent/watchset.go`, polled — `WM_DEVICECHANGE` needs a message loop a service hasn't got) and tags every event with the volume's label and serial, because drive letters are reused. `rules/copyToRemovable.ts` raises one alert per device per burst, HIGH when `previousSourceId` ties the files to a monitored share.

**Copy detection splits in two.** Copies *into/within* a share are found by the scan (`pairCopies` in `agent/src/diff.ts`: a new path whose size+mtime match a file still present → `COPIED` with `previousPath`); copies *out* are invisible to scanning and only appear as audit reads, hence per-server `recordReads` (off by default — reads dominate audit volume), the **File Access** view, and the `BULK_FILE_READ` rule (distinct files read by one account in 5 min over a threshold — per file server via `FileServer.bulkReadThreshold`, defaulting to `BULK_READ_THRESHOLD` = 50 in `shared/activity.ts`).

**"Who changed a file" comes from the Windows Security log, not SMB.** Optional per file server (`activityEnabled` + WinRM account): the agent polls event 5145 over WinRM via `packages/agent/winrm/collect.py` (Debian `python3-winrm`; no maintained Node WinRM client), parses in TS (`shared/activity.ts`), and posts to `/ingest/activity`. Records land in `FileActivity` and are matched onto `FileEvent.actorUser`/`actorIp` by path and time — in both directions, since scans and audit records arrive in either order (`backend/src/activity.ts`). Polls ask for a bounded `EventRecordID` range so a busy server's backlog can't be silently skipped. Reads and machine accounts are dropped in the agent.

**File servers are configured in the dashboard; the agent does the scanning.** `FileServer` (host, account, AES-GCM-encrypted password via `SOURCE_CREDENTIALS_KEY`) has shares, each a `Source` row assigned to an agent. The TypeScript agent polls `GET /agent-sync` and reconciles one snapshot-diff loop per share (`managedSources.ts`, pure planning in `sourceReconcile.ts`); the backend never talks SMB. **`Source`, not `Agent`, is what events/snapshots/alerts hang off** (`sourceId`), and the ransomware rule and `supportsQuarantine` are per source; `agentId` on those rows means "reported by". Each agent's own env-configured root is also a `Source` (`fileServerId` null), upserted at registration. Ingest without `sourceId` means that default source — the Go agent never sends one. Share passwords are write-only in the API and decrypted only in `/agent-sync`.

**Connectors are pluggable behind the agent's `Source` interface (`packages/agent/src/sources/types.ts`: `describe`/`listTree`/`readSample` — unrelated to the Prisma `Source` model), but detection strategy differs by source.** Local paths use chokidar for real-time OS events (`watcher.ts`). SMB, M365, and Google Drive all share `snapshotDiff.ts` — walk on an interval, diff `{size, mtime}` against the previous walk, synthesize created/modified/deleted events. Adding a connector means one new `Source` implementation and nothing downstream: `Agent.watchedRoot`, `FileEvent.path`, and `StorageSnapshot.rootPath` are unconstrained strings.

**Classification runs two passes**: `patterns.ts` (regex + Luhn for SSN/card/email/phone) and `ner.ts` (local `Xenova/bert-base-NER` via `@huggingface/transformers`, PER/ORG/LOC only). Local model, not a cloud API — routing protected content through a third party would undermine the product. Only the file's `contentSample` (first 8KB, base64, gated by `contentSampling.ts`) is ever scanned; the worker never reads the file itself.

**Pure logic is split out of I/O-heavy modules specifically so it's testable.** `mapEntitiesToMatches` (from model inference), `diffSnapshots`, `computeQuarantinePath`, `isSampleable`, `isLocalWatchedRoot` all live in files with no import of `agent/src/config.ts` — that module validates env vars at import time and calls `process.exit(1)`, so anything transitively importing it can't be unit tested. Keep new pure logic on the same side of that line.

**Backend entry is split `app.ts` (`buildApp()` returns the instance) / `index.ts` (listens)** so tests drive real routes via `app.inject()`.

## Deployment gotchas

`docker-compose.yml` is both the dev-Postgres file and the full-stack deployment file — `pnpm db:up` names one service, `docker compose up` brings up the six services — backend, agent, classification, dashboard, backup, postgres (`webhook-logger` is opt-in via `--profile webhook-logger`, and so is `proxy`, a bundled HTTPS nginx in `deploy/proxy/` for hosts without their own reverse proxy — never enable it on the production host, whose gateway already holds :80/:443). `docker-compose.smb-test.yml` (`pnpm smb:up`/`smb:down`) is a separate Samba server for exercising the SMB connector. Each package has its own Dockerfile (`node:24-bookworm-slim`, not Alpine: Prisma and `onnxruntime-node` prebuilds are glibc).

Three Prisma packaging traps, all documented in ARCHITECTURE.md and all fixed in `packages/backend/Dockerfile` — don't undo them: a workspace-root `pnpm install` silently leaves the client ungenerated (needs an explicit `prisma generate`), Prisma misdetects OpenSSL on bookworm-slim and fails at *runtime* (needs `apt-get install openssl` in both stages), and `pnpm --prod deploy` builds a fresh `node_modules` that loses the earlier generate (needs generating again inside the deployed tree). A successful `docker build` proves none of this works — start the container and read its logs.

**The dashboard's backend URL is baked in at image build time** (`VITE_BACKEND_URL` → `DASHBOARD_BACKEND_URL` build arg), and must be reachable *from the browser*, not from inside the compose network. Changing it requires a rebuild. The deployed value lives in the gitignored root `.env` (`DASHBOARD_BACKEND_URL=https://dsp.logikos.dev/api`) so `docker compose up --build` doesn't silently revert it to `localhost:4000`.

### The production host

**Not every checkout is on it — check first.** The production host (user `ubnt`, repo alongside `../logikos-gateway`, gitignored root `.env` and `.env.backend` present) runs the full compose stack serving `https://dsp.logikos.dev` through the shared `logikos-gateway` nginx (see `/home/ubnt/CLAUDE.md`). On any other machine (no `/home/ubnt`, no root `.env`), none of this section applies: there is no live stack, ports 5432/4000/5173 are normally free, and the standard `.env.example` defaults (backend on :4000) apply. On the production host, the consequences for dev work are:

- **Dev and prod are split by config on this host, not by container.** One Postgres container holds three databases: `logikos_dsp` (**production**), `logikos_dsp_dev` and `logikos_dsp_test`. `packages/backend/.env`, `packages/classification/.env` and `packages/dashboard/.env.local` are **dev-only** — dev database, backend on **:4001** (the container holds :4000), its own `JWT_SECRET`, no `NODE_ENV=production`. Run the dev agent with `BACKEND_URL=http://localhost:4001` and `AGENT_ENROLL_TOKEN` from `packages/backend/.env`. `pnpm db:up` does not create a separate dev Postgres; it's the same container.
- **Production's backend secrets live in the gitignored root `.env.backend`**, selected by `BACKEND_ENV_FILE` in the root `.env` — except `AGENT_ENROLL_TOKEN`, which compose passes from the root `.env` to both backend and agent; `PUBLISH_ADDR=172.17.0.1` there binds backend/dashboard to the docker0 bridge (what the gateway's `host.docker.internal` resolves to) so the LAN can't reach :4000 and skip the gateway. Both default to the old behavior in `docker-compose.yml`, so a compose command run without that root `.env` silently reverts to shared secrets and `0.0.0.0`.
- **`docker compose up --build` redeploys prod**, and recreating the agent re-registers it. The agent pins `hostname: dsp-agent` because `Agent.key` derives from the hostname — without it every recreate orphans the previous `Agent` row's history.

The gateway vhost is tracked here as `deploy/dsp.conf` and **copied** into `../logikos-gateway/conf.d/` (read-only mount, not a git repo) — edit it here, copy, then `nginx -t` before `nginx -s reload`. It strips the `/api` prefix (the backend has none of its own; same-origin is what makes the `SameSite=Lax` cookie work). The agent-facing paths used to 403 here; they are now open so agents can run on remote workstations, with `= /api/agents/register` **rate limited to 6r/m per IP** because it takes the deployment-wide enroll token — the `limit_req_zone dsp_register` it uses is declared at the top of `deploy/dsp.conf` itself — `conf.d/*.conf` is included inside nginx's `http` block, so the file's own top level is `http` context, and the shared `nginx.conf` needs no edit. See ARCHITECTURE.md "Agent authentication".

Two backend settings are load-bearing for the deployment: `trustProxy: true` in `app.ts` (request logs are the only audit trail of who approved actions; safe only while the backend is reachable solely via nginx) and `NODE_ENV=production` in `.env.backend` (the session cookie's `Secure` flag derives from it). Notifications go to Telegram (`TELEGRAM_*` in `.env.backend`); `RESPONSE_WEBHOOK_URL` is commented out there and the `webhook-logger` container was removed from this host.

Retention (Administration → Retention, `backend/src/retention.ts`) is **off by default** and swept hourly from `index.ts` — not `app.ts`, so tests never start a timer that deletes their fixtures. Each source keeps its newest storage snapshot, only `RESOLVED` alerts expire, and file events take their classification jobs/matches with them (FKs are `RESTRICT`).

Backups are configured under Administration → Backups and run by the `backup` container (`packages/backup`, built on `postgres:16-alpine` for a matching `pg_dump`, plus rclone and age): a local dump in `BACKUP_DIR_HOST` (`/home/ubnt/backups/logikos-dsp` here), and an age-encrypted bundle (dump + `.env.backend` + root `.env` + manifest) uploaded to S3/SFTP/Google Drive/SMB. Only the age *public* key is on the server — backups can't be decrypted here, by design. Destination secrets are encrypted with `SOURCE_CREDENTIALS_KEY` like share passwords. `deploy/restore.sh verify` / `live --yes` still restore local dumps; the old `deploy/backup.sh` cron job stays in the user crontab until a destination and the dashboard schedule are set up in production — then remove it, or both dump nightly. Run the worker's pure tests with `pnpm --filter @logikos-dsp/backup test`; anything touching real destinations needs the container (the host has no rclone/age).

## Repo conventions

Commits go straight to `main`, one feature per commit, subject in the imperative ("Add ..."). Every feature commit also updates `ARCHITECTURE.md` and, where user-facing, `README.md` — including recording what was tried and rejected. Check `git config user.name` before committing — hosts used for this repo have tended to have no git identity; pass `GIT_AUTHOR_*`/`GIT_COMMITTER_*` or set it globally.

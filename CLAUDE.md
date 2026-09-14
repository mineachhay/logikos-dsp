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

Env files are per-package and gitignored: `packages/backend/.env` (from `.env.example`), `packages/backend/.env.test` (from `.env.test.example`), and `packages/classification/.env` — the last has **no** example file; it needs `DATABASE_URL` (and optionally `POLL_INTERVAL_MS`). Backend and classification both start via `--env-file=.env`, so a missing file is a hard startup failure.

There is no linter configured anywhere — `tsc` (via each package's `build`) is the only static check, plus `gofmt`/`go vet` for `native-agent/`. CI (`.github/workflows/ci.yml`) runs build, tests (with a Postgres service) and the Go checks on every push to `main`.

### Tests

Agent, classification, and shared run pure-logic Vitest suites with no external services. **Backend tests need a real Postgres test database**, one-time:

```bash
docker exec logikos-dsp-postgres-1 psql -U logikos -d postgres -c "CREATE DATABASE logikos_dsp_test;"
cp packages/backend/.env.test.example packages/backend/.env.test
```

`packages/backend/vitest.config.ts`'s `globalSetup` runs `prisma migrate deploy` on every invocation; `test/setup.ts` truncates tables per test. `fileParallelism: false` is deliberate — all files share that one database. Only `pnpm test` loads `.env.test`; bare `npx vitest` lets Prisma fall back to `packages/backend/.env`, so `test/assertTestDatabase.ts` aborts unless the database name ends in `_test` (that path has already wiped the dev database once).

```bash
pnpm --filter @logikos-dsp/backend test                          # one package
pnpm --filter @logikos-dsp/backend test src/routes/auth.test.ts  # one file — never bare `npx vitest` (see below)
cd native-agent && go test ./...                                 # Go agent
```

Vitest is pinned to `3.2.4` across every package (4.x would force a Vite major bump the dashboard isn't ready for); `@fastify/jwt`@8.0.1 and `@fastify/cookie`@9.4.0 are pinned to their last Fastify-4-compatible majors. Don't bump any of these piecemeal.

There is a `run-logikos-dsp` skill (`.claude/skills/`) for starting the stack and driving the dashboard with Playwright — prefer it over ad-hoc startup. Note it assumes a clean machine where 5432/4000/5173 are free, which is not true on this host (see below).

## Architecture

Five workspace packages plus a Go agent, joined by one deliberately plain HTTP contract:

```
watched source → [agent] --FileEvent/StorageSnapshot--> POST /ingest/* → [backend/Fastify] → Postgres
                                                                            ├─ ransomware-rate rule (inline)
                                                                            └─ ClassificationJob queue
                                                   [classification worker] ─┘ → ClassificationMatch + Alert
                                        [dashboard/React] ←── REST ──→ [backend]
```

**`packages/shared` is the wire contract, and it matters more than its size suggests.** The agent is isolated behind plain HTTP specifically so it can be reimplemented in another language — which has already happened once (`native-agent/`, Go). `native-agent/internal/wire` hand-mirrors the backend's Zod schemas and `internal/config` reproduces the TypeScript agent's key derivation (`agent-<sha256(hostname:local:watchPath)[:24]>`) exactly, so both implementations register as the *same* `Agent` row. Changing an ingest schema means updating the Zod schema, `packages/shared`, and the Go `wire` package together — and since agent auth, agents and backend must be upgraded together too.

**Two identity systems, on separate code paths, never mixed.** Agents authenticate as machines on `/agents/register`, `/ingest/*`, `/agent-commands*` — never behind the user JWT — via `auth/agentAuth.ts`: `AGENT_ENROLL_TOKEN` on register only, which returns a per-agent secret (sha256 stored, **rotated on every registration**) for everything else. Agents hold the secret in memory and re-register on 401 (`packages/agent/src/agentSession.ts`, Go `internal/client`); 403 means revoked and isn't retried. `Agent.key` alone is derivable, not a credential. `User` + a cookie-based JWT authenticates people: every dashboard route self-gates via `app.addHook("onRequest", app.authenticate)` inside its own route file. `app.ts` marks the split with comments — keep them accurate when adding routes. Roles are `ADMIN` (everything, incl. `PATCH /alerts/:id`, user management and agent revoke/restore) and `VIEWER` (read-only). A global error handler in `app.ts` turns `ZodError` from any route's `schema.parse()` into a 400.

**Two database clients, by design.** The backend uses Prisma and owns the schema and migrations for everything; the classification worker talks to the same tables with raw `pg` (`SELECT ... FOR UPDATE SKIP LOCKED` job claiming, safe for multiple workers). Consequently the "HIGH/CRITICAL alert also gets a PENDING `ResponseAction`" step is duplicated at both alert-creation sites (`rules/ransomwareRate.ts` and `classification/src/index.ts`) rather than centralized across that process boundary. Adding an alert source means adding that step again, deliberately.

**Response actions are suggest-and-approve, never automatic.** `WEBHOOK_NOTIFICATION` executes synchronously on approve (`EXECUTED`/`FAILED`), sending to every configured channel — Telegram (`TELEGRAM_BOT_TOKEN`+`TELEGRAM_CHAT_ID`, `responseActions/telegram.ts`) and/or `RESPONSE_WEBHOOK_URL` — and fails if any configured channel does. `FILE_QUARANTINE` can't — only the agent can touch the filesystem — so it has an extra `APPROVED` state that exists solely for this: the agent polls `GET /agent-commands?agentKey=...`, acts, then `POST /agent-commands/:id/complete`. Target paths come from the linked `Alert.metadata` (`path` for sensitive-data, `affectedPaths` for a ransomware burst, capped at 200), normalized to one `paths: string[]` shape server-side.

**`supportsQuarantine(watchedRoot)` in `packages/shared` (`!watchedRoot.includes("://")`) is the single gate** on whether a connector is write-capable. Local paths qualify; SMB/M365/Google Drive all carry a scheme and don't — SMB because `v9u-smb2`'s write path is broken against a properly secured server (built, live-tested, reverted; see ARCHITECTURE.md), M365/Google Drive because their OAuth scopes are read-only by choice. A new URI-based connector is excluded automatically.

**Connectors are pluggable behind `Source` (`packages/agent/src/sources/types.ts`: `describe`/`listTree`/`readSample`), but detection strategy differs by source.** Local paths use chokidar for real-time OS events (`watcher.ts`). SMB, M365, and Google Drive all share `snapshotDiff.ts` — walk on an interval, diff `{size, mtime}` against the previous walk, synthesize created/modified/deleted events. Adding a connector means one new `Source` implementation and nothing downstream: `Agent.watchedRoot`, `FileEvent.path`, and `StorageSnapshot.rootPath` are unconstrained strings.

**Classification runs two passes**: `patterns.ts` (regex + Luhn for SSN/card/email/phone) and `ner.ts` (local `Xenova/bert-base-NER` via `@huggingface/transformers`, PER/ORG/LOC only). Local model, not a cloud API — routing protected content through a third party would undermine the product. Only the file's `contentSample` (first 8KB, base64, gated by `contentSampling.ts`) is ever scanned; the worker never reads the file itself.

**Pure logic is split out of I/O-heavy modules specifically so it's testable.** `mapEntitiesToMatches` (from model inference), `diffSnapshots`, `computeQuarantinePath`, `isSampleable`, `isLocalWatchedRoot` all live in files with no import of `agent/src/config.ts` — that module validates env vars at import time and calls `process.exit(1)`, so anything transitively importing it can't be unit tested. Keep new pure logic on the same side of that line.

**Backend entry is split `app.ts` (`buildApp()` returns the instance) / `index.ts` (listens)** so tests drive real routes via `app.inject()`.

## Deployment gotchas

`docker-compose.yml` is both the dev-Postgres file and the full-stack deployment file — `pnpm db:up` names one service, `docker compose up` brings up all six (five product services plus `webhook-logger`). `docker-compose.smb-test.yml` (`pnpm smb:up`/`smb:down`) is a separate Samba server for exercising the SMB connector. Each package has its own Dockerfile (`node:24-bookworm-slim`, not Alpine: Prisma and `onnxruntime-node` prebuilds are glibc).

Three Prisma packaging traps, all documented in ARCHITECTURE.md and all fixed in `packages/backend/Dockerfile` — don't undo them: a workspace-root `pnpm install` silently leaves the client ungenerated (needs an explicit `prisma generate`), Prisma misdetects OpenSSL on bookworm-slim and fails at *runtime* (needs `apt-get install openssl` in both stages), and `pnpm --prod deploy` builds a fresh `node_modules` that loses the earlier generate (needs generating again inside the deployed tree). A successful `docker build` proves none of this works — start the container and read its logs.

**The dashboard's backend URL is baked in at image build time** (`VITE_BACKEND_URL` → `DASHBOARD_BACKEND_URL` build arg), and must be reachable *from the browser*, not from inside the compose network. Changing it requires a rebuild. The deployed value lives in the gitignored root `.env` (`DASHBOARD_BACKEND_URL=https://dsp.logikos.dev/api`) so `docker compose up --build` doesn't silently revert it to `localhost:4000`.

### This host runs the live deployment

**The full compose stack is up here and serves `https://dsp.logikos.dev`** through the shared `logikos-gateway` nginx (see `/home/ubnt/CLAUDE.md`). Consequences for dev work:

- **Dev and prod are split by config on this host, not by container.** One Postgres container holds three databases: `logikos_dsp` (**production**), `logikos_dsp_dev` and `logikos_dsp_test`. `packages/backend/.env`, `packages/classification/.env` and `packages/dashboard/.env.local` are **dev-only** — dev database, backend on **:4001** (the container holds :4000), its own `JWT_SECRET`, no `NODE_ENV=production`. Run the dev agent with `BACKEND_URL=http://localhost:4001` and `AGENT_ENROLL_TOKEN` from `packages/backend/.env`. `pnpm db:up` does not create a separate dev Postgres; it's the same container.
- **Production's backend secrets live in the gitignored root `.env.backend`**, selected by `BACKEND_ENV_FILE` in the root `.env` — except `AGENT_ENROLL_TOKEN`, which compose passes from the root `.env` to both backend and agent; `PUBLISH_ADDR=172.17.0.1` there binds backend/dashboard to the docker0 bridge (what the gateway's `host.docker.internal` resolves to) so the LAN can't reach :4000 and skip the gateway. Both default to the old behavior in `docker-compose.yml`, so a compose command run without that root `.env` silently reverts to shared secrets and `0.0.0.0`.
- **`docker compose up --build` redeploys prod**, and recreating the agent re-registers it. The agent pins `hostname: dsp-agent` because `Agent.key` derives from the hostname — without it every recreate orphans the previous `Agent` row's history.

The gateway vhost is tracked here as `deploy/dsp.conf` and **copied** into `../logikos-gateway/conf.d/` (read-only mount, not a git repo) — edit it here, copy, then `nginx -t` before `nginx -s reload`. It strips the `/api` prefix (the backend has none of its own; same-origin is what makes the `SameSite=Lax` cookie work) and **403s `/api/ingest/*`, `/api/agent-commands*` and `/api/agents/register`**: the bundled agent reaches the backend over the compose network and doesn't need them. They predate agent auth; lifting them for remote agents is a separate decision (exposes the enroll token to online guessing — see ARCHITECTURE.md "Agent authentication").

Two backend settings are load-bearing for the deployment: `trustProxy: true` in `app.ts` (request logs are the only audit trail of who approved actions; safe only while the backend is reachable solely via nginx) and `NODE_ENV=production` in `.env.backend` (the session cookie's `Secure` flag derives from it). `webhook-logger` is a stand-in `RESPONSE_WEBHOOK_URL` sink — without a listener every `WEBHOOK_NOTIFICATION` approval lands in `FAILED`.

Backups: `deploy/backup.sh` (nightly via the user crontab, `pg_dump -Fc` run inside the container, to `/home/ubnt/backups/logikos-dsp`), `deploy/restore.sh verify` (restores newest dump into a throwaway DB and diffs row counts — safe), `deploy/restore.sh live --yes` (overwrites prod, stops/restarts dependent services).

## Repo conventions

Commits go straight to `main`, one feature per commit, subject in the imperative ("Add ..."). Every feature commit also updates `ARCHITECTURE.md` and, where user-facing, `README.md` — including recording what was tried and rejected. Git has no user identity configured on this host; pass `GIT_AUTHOR_*`/`GIT_COMMITTER_*` or set it globally.

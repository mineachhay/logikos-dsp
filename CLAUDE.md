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

There is no linter configured anywhere — `tsc` (via each package's `build`) is the only static check.

### Tests

Agent, classification, and shared run pure-logic Vitest suites with no external services. **Backend tests need a real Postgres test database**, one-time:

```bash
docker exec logikos-dsp-postgres-1 psql -U logikos -d postgres -c "CREATE DATABASE logikos_dsp_test;"
cp packages/backend/.env.test.example packages/backend/.env.test
```

`packages/backend/vitest.config.ts`'s `globalSetup` runs `prisma migrate deploy` on every invocation; `test/setup.ts` truncates tables per test. `fileParallelism: false` is deliberate — all files share that one database.

```bash
pnpm --filter @logikos-dsp/backend test                          # one package
pnpm --filter @logikos-dsp/backend test src/routes/auth.test.ts  # one file
cd native-agent && go test ./...                                 # Go agent
```

Vitest is pinned to `3.2.4` across every package (4.x would force a Vite major bump the dashboard isn't ready for); `@fastify/jwt`@8.0.1 and `@fastify/cookie`@9.4.0 are pinned to their last Fastify-4-compatible majors. Don't bump any of these piecemeal.

There is a `run-logikos-dsp` skill (`.claude/skills/`) for starting the stack and driving the dashboard with Playwright — prefer it over ad-hoc startup. Its SKILL.md hardcodes a different repo root path than this checkout; the commands are still correct.

## Architecture

Five workspace packages plus a Go agent, joined by one deliberately plain HTTP contract:

```
watched source → [agent] --FileEvent/StorageSnapshot--> POST /ingest/* → [backend/Fastify] → Postgres
                                                                            ├─ ransomware-rate rule (inline)
                                                                            └─ ClassificationJob queue
                                                   [classification worker] ─┘ → ClassificationMatch + Alert
                                        [dashboard/React] ←── REST ──→ [backend]
```

**`packages/shared` is the wire contract, and it matters more than its size suggests.** The agent is isolated behind plain HTTP specifically so it can be reimplemented in another language — which has already happened once (`native-agent/`, Go). `native-agent/internal/wire` hand-mirrors the backend's Zod schemas and `internal/config` reproduces the TypeScript agent's key derivation (`agent-<sha256(hostname:local:watchPath)[:24]>`) exactly, so both implementations register as the *same* `Agent` row. Changing an ingest schema means updating the Zod schema, `packages/shared`, and the Go `wire` package together.

**Two identity systems, on separate code paths, never mixed.** `Agent.key` authenticates machines: `/agents/register`, `/ingest/*`, `/agent-commands*` are never gated. `User` + a cookie-based JWT authenticates people: every dashboard route self-gates via `app.addHook("onRequest", app.authenticate)` inside its own route file. `app.ts` marks the split with comments — keep them accurate when adding routes. Roles are `ADMIN` (everything, incl. `PATCH /alerts/:id` and user management) and `VIEWER` (read-only).

**Two database clients, by design.** The backend uses Prisma and owns the schema and migrations for everything; the classification worker talks to the same tables with raw `pg` (`SELECT ... FOR UPDATE SKIP LOCKED` job claiming, safe for multiple workers). Consequently the "HIGH/CRITICAL alert also gets a PENDING `ResponseAction`" step is duplicated at both alert-creation sites (`rules/ransomwareRate.ts` and `classification/src/index.ts`) rather than centralized across that process boundary. Adding an alert source means adding that step again, deliberately.

**Response actions are suggest-and-approve, never automatic.** `WEBHOOK_NOTIFICATION` executes synchronously on approve (`EXECUTED`/`FAILED`). `FILE_QUARANTINE` can't — only the agent can touch the filesystem — so it has an extra `APPROVED` state that exists solely for this: the agent polls `GET /agent-commands?agentKey=...`, acts, then `POST /agent-commands/:id/complete`. Target paths come from the linked `Alert.metadata` (`path` for sensitive-data, `affectedPaths` for a ransomware burst, capped at 200), normalized to one `paths: string[]` shape server-side.

**`supportsQuarantine(watchedRoot)` in `packages/shared` (`!watchedRoot.includes("://")`) is the single gate** on whether a connector is write-capable. Local paths qualify; SMB/M365/Google Drive all carry a scheme and don't — SMB because `v9u-smb2`'s write path is broken against a properly secured server (built, live-tested, reverted; see ARCHITECTURE.md), M365/Google Drive because their OAuth scopes are read-only by choice. A new URI-based connector is excluded automatically.

**Connectors are pluggable behind `Source` (`packages/agent/src/sources/types.ts`: `describe`/`listTree`/`readSample`), but detection strategy differs by source.** Local paths use chokidar for real-time OS events (`watcher.ts`). SMB, M365, and Google Drive all share `snapshotDiff.ts` — walk on an interval, diff `{size, mtime}` against the previous walk, synthesize created/modified/deleted events. Adding a connector means one new `Source` implementation and nothing downstream: `Agent.watchedRoot`, `FileEvent.path`, and `StorageSnapshot.rootPath` are unconstrained strings.

**Classification runs two passes**: `patterns.ts` (regex + Luhn for SSN/card/email/phone) and `ner.ts` (local `Xenova/bert-base-NER` via `@huggingface/transformers`, PER/ORG/LOC only). Local model, not a cloud API — routing protected content through a third party would undermine the product. Only the file's `contentSample` (first 8KB, base64, gated by `contentSampling.ts`) is ever scanned; the worker never reads the file itself.

**Pure logic is split out of I/O-heavy modules specifically so it's testable.** `mapEntitiesToMatches` (from model inference), `diffSnapshots`, `computeQuarantinePath`, `isSampleable`, `isLocalWatchedRoot` all live in files with no import of `agent/src/config.ts` — that module validates env vars at import time and calls `process.exit(1)`, so anything transitively importing it can't be unit tested. Keep new pure logic on the same side of that line.

**Backend entry is split `app.ts` (`buildApp()` returns the instance) / `index.ts` (listens)** so tests drive real routes via `app.inject()`.

## Deployment gotchas

`docker-compose.yml` is both the dev-Postgres file and the full-stack deployment file — `pnpm db:up` names one service, `docker compose up` brings up all five. Each package has its own Dockerfile (`node:24-bookworm-slim`, not Alpine: Prisma and `onnxruntime-node` prebuilds are glibc).

Three Prisma packaging traps, all documented in ARCHITECTURE.md and all fixed in `packages/backend/Dockerfile` — don't undo them: a workspace-root `pnpm install` silently leaves the client ungenerated (needs an explicit `prisma generate`), Prisma misdetects OpenSSL on bookworm-slim and fails at *runtime* (needs `apt-get install openssl` in both stages), and `pnpm --prod deploy` builds a fresh `node_modules` that loses the earlier generate (needs generating again inside the deployed tree). A successful `docker build` proves none of this works — start the container and read its logs.

**The dashboard's backend URL is baked in at image build time** (`VITE_BACKEND_URL` → `DASHBOARD_BACKEND_URL` build arg), and must be reachable *from the browser*, not from inside the compose network. Changing it requires a rebuild.

## Repo conventions

Commits go straight to `main`, one feature per commit, subject in the imperative ("Add ..."). Every feature commit also updates `ARCHITECTURE.md` and, where user-facing, `README.md` — including recording what was tried and rejected. Git has no user identity configured on this host; pass `GIT_AUTHOR_*`/`GIT_COMMITTER_*` or set it globally.

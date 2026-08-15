---
name: run-logikos-dsp
description: Build, run, and drive logikos-dsp (backend API, agent file-watcher, classification worker, React dashboard). Use when asked to start logikos-dsp, run its tests, build it, take a screenshot of the dashboard, or verify a change end-to-end (file event → alert → dashboard).
---

logikos-dsp is a 4-service product (Fastify backend, file-watching agent,
NER classification worker, React dashboard) plus a `shared` types package,
in one pnpm workspace. There's no browser-automation CLI installed in this
environment, so the dashboard is driven with a small Playwright REPL at
`.claude/skills/run-logikos-dsp/driver.mjs` (same command vocabulary as
`chromium-cli`, built because that tool isn't present here). The other
three services are headless — drive them with `curl` and by dropping files
into the watched directory.

All paths below are relative to the repo root (`/home/cg/logikos-dsp`).

## Prerequisites

Already satisfied in this container — nothing to install. For reference,
what's actually used:

- Node 24, pnpm 9.12.0 (via corepack), Docker (for Postgres).
- `/usr/bin/google-chrome` (system Chrome — the driver launches this
  directly instead of downloading Playwright's own Chromium, since disk
  space here is tight).
- `packages/classification/.cache/` already has the ~100MB NER model
  (`Xenova/bert-base-NER`) cached from a prior run; first-ever run
  downloads it and takes ~20-30s longer to start.

## Setup

```bash
pnpm install                 # workspace deps (already installed here)
pnpm db:up                   # starts Postgres via docker compose, waits aren't automatic — poll it (below)
```

Poll for Postgres readiness instead of sleeping:

```bash
for i in $(seq 1 20); do
  s=$(docker inspect --format='{{.State.Health.Status}}' logikos-dsp-postgres-1 2>/dev/null)
  [ "$s" = "healthy" ] && break
  sleep 2
done
```

`packages/backend/.env` and `packages/classification/.env` already exist
in this environment (backend's has `DATABASE_URL`, `JWT_SECRET`,
`ADMIN_EMAIL`/`ADMIN_PASSWORD`, `RESPONSE_WEBHOOK_URL`). If they're
missing, copy from `.env.example` and fill in real values — see
`README.md`. The `logikos_dsp` and `logikos_dsp_test` databases already
exist with migrations applied (`\dt` in `logikos_dsp` shows `User`,
`Agent`, `FileEvent`, `Alert`, `ClassificationJob`, `ClassificationMatch`,
`ResponseAction`, `StorageSnapshot`). If starting from a fresh DB:

```bash
pnpm db:migrate               # prisma migrate dev, backend package
pnpm db:seed                  # creates first ADMIN from ADMIN_EMAIL/ADMIN_PASSWORD in .env
```

The dashboard needs no env config — `VITE_BACKEND_URL` defaults to
`http://localhost:4000`.

## Build

Only `shared` and `backend` need a build step before their dev servers
will type-check cleanly (Prisma Client must exist before `backend`'s
`tsc` runs):

```bash
pnpm --filter @logikos-dsp/shared build
pnpm --filter @logikos-dsp/backend exec prisma generate
```

`agent`, `classification`, and `dashboard` run straight off `tsx
watch` / `vite` in dev — no separate build needed to run them locally.

## Run (agent path)

Start the three headless services in the background (this container has
no `tmux`, so plain `&` + a log file works fine — background processes
survive between tool calls here):

```bash
pnpm --filter @logikos-dsp/backend dev        > /tmp/backend.log 2>&1 &
disown
# poll instead of sleeping:
timeout 30 bash -c 'until curl -sf http://localhost:4000/health -o /dev/null; do sleep 1; done' \
  || tail -30 /tmp/backend.log

mkdir -p /tmp/logikos-watch
WATCH_PATH=/tmp/logikos-watch BACKEND_URL=http://localhost:4000 \
  pnpm --filter @logikos-dsp/agent dev         > /tmp/agent.log 2>&1 &
disown

pnpm --filter @logikos-dsp/classification dev  > /tmp/classification.log 2>&1 &
disown
# classification takes ~5-10s to load the NER model — watch its log for
# "classification worker started, polling every 2000ms"
```

Prove the whole pipeline in one shot — drop a file with fake PII into the
watched directory and check for an alert:

```bash
cat > /tmp/logikos-watch/sensitive-test.txt << 'EOF'
Employee record: John Smith works at Acme Corporation in New York.
Contact: john.smith@example.com, SSN: 123-45-6789
Credit card: 4111 1111 1111 1111
EOF
sleep 3   # agent debounce + classification poll interval (2s)
```

You need a logged-in session to read `/alerts` etc. — agent/ingest routes
are open, everything else needs a cookie. Don't read `packages/backend/.env`
to get `ADMIN_PASSWORD` (it's a secret file, and the harness blocks
reading it anyway) — create a disposable test admin instead. The seed
script (`prisma/seed.ts`) only seeds when the `User` table is empty, so
it can't be reused for this; a one-off script placed *inside*
`packages/backend/` (relative imports like `./src/db.js` break from
outside the package) works:

```bash
cd packages/backend
cat > create-test-user.ts << 'EOF'
import { prisma } from "./src/db.js";
import { hashPassword } from "./src/auth/passwords.js";
const email = "runskill-test@example.com";
const password = "RunSkillTest123!";
if (!(await prisma.user.findUnique({ where: { email } }))) {
  await prisma.user.create({ data: { email, passwordHash: await hashPassword(password), role: "ADMIN" } });
  console.log("created", email);
}
await prisma.$disconnect();
EOF
npx --no-install tsx --env-file=.env create-test-user.ts
rm create-test-user.ts
cd ../..

curl -s -c /tmp/cookies.txt -X POST http://localhost:4000/auth/login \
  -H 'Content-Type: application/json' \
  -d '{"email":"runskill-test@example.com","password":"RunSkillTest123!"}'
curl -s -b /tmp/cookies.txt http://localhost:4000/alerts | python3 -m json.tool | head -30
```

You should see a `SENSITIVE_DATA_EXPOSED` alert for
`/tmp/logikos-watch/sensitive-test.txt` listing `ssn, credit_card, email,
person, organization, location`, with two `PENDING` `responseActions`
(`WEBHOOK_NOTIFICATION`, `FILE_QUARANTINE`).

For the dashboard, start Vite and drive it with the Playwright REPL:

```bash
pnpm --filter @logikos-dsp/dashboard dev > /tmp/dashboard.log 2>&1 &
disown
timeout 30 bash -c 'until curl -sf http://localhost:5173 -o /dev/null; do sleep 1; done'

cd .claude/skills/run-logikos-dsp
node driver.mjs << 'EOF'
nav http://localhost:5173
wait-for text=Sign in
fill input[type=email] runskill-test@example.com
fill input[type=password] RunSkillTest123!
click button[type=submit]
wait-for text=Alerts
screenshot dashboard-home
click text=Approve notification
wait-for text=notification: executed
screenshot approved-action
console
EOF
```

Screenshots land in `.claude/skills/run-logikos-dsp/screenshots/`
(`<name>.png`, or `01.png`/`02.png`/... if no name given).

| driver command | what it does |
|---|---|
| `nav <url>` | navigate |
| `wait-for text=<substring>` or `wait-for <css selector>` | wait up to 15s |
| `click <selector>` | click |
| `fill <selector> <text>` | fill an input (goes through real input events, not `.value =`) |
| `press <key>` | keyboard press, e.g. `Enter` |
| `eval <js>` | run JS in page context, prints the JSON result |
| `screenshot [name]` | full-page screenshot |
| `console` | dump buffered `console.*` and page errors since launch |
| `quit` | close the browser |

Stop everything cleanly when done:

Backend and dashboard have listening ports — kill by port, this is
reliable in one command:

```bash
lsof -ti:4000 -sTCP:LISTEN | xargs -r kill
lsof -ti:5173 -sTCP:LISTEN | xargs -r kill
```

Agent and classification have no port. Find their PIDs in one tool call,
then kill them in a **separate** tool call — see the Gotchas entry below
for why combining find-and-kill into one `pkill -f` / `... | xargs kill`
command for *these two* is unreliable here:

```bash
ps -eo pid,ppid,cmd | grep "tsx watch" | grep -v grep
```

```bash
kill <agent-wrapper-pid> <agent-node-pid> <classification-wrapper-pid> <classification-node-pid>
```

(`tsx watch` spawns via an internal `sh -c "tsx watch ..."` wrapper, so
each of agent/classification shows as two PIDs — the wrapper and its
`node` child.)

```bash
# docker compose stop postgres    # optional — this dev DB is usually left running between sessions
```

## Run (human path)

```bash
pnpm dev:backend         # → http://localhost:4000
pnpm dev:classification  # background worker, no port
WATCH_PATH=/some/dir pnpm dev:agent   # background worker, no port
pnpm dev:dashboard       # → http://localhost:5173, log in with ADMIN_EMAIL/ADMIN_PASSWORD
```
Ctrl-C each to stop. Useless in a headless container — that's what the
driver above is for.

## Test

```bash
pnpm test    # runs vitest across agent, backend, classification (5 of 6 workspace projects — shared and dashboard have no test script)
```

All 3 suites pass here: agent 25 tests, classification 18 tests, backend
12 tests. Backend's suite needs Postgres reachable (`.env.test` →
`logikos_dsp_test`, already migrated in this environment) — it uses one
real database with `fileParallelism: false` (see
`packages/backend/vitest.config.ts`) because every test file truncates
shared tables in `beforeEach`.

---

## Gotchas

- **`pnpm install --frozen-lockfile` in a Docker build silently skips
  Prisma Client generation.** Installing the whole workspace at once runs
  `@prisma/client`'s postinstall from a working directory where it can't
  find `packages/backend/prisma/schema.prisma` — it prints a warning and
  moves on rather than failing, leaving the client ungenerated. Every
  Prisma-typed query then becomes `any`, which fails `tsc` with
  `TS7006: implicitly has an 'any' type` on unrelated-looking lines. Fix:
  run `pnpm --filter @logikos-dsp/backend exec prisma generate` explicitly,
  scoped to the package that owns the schema, before building.
- **Prisma's engine postinstall can't detect OpenSSL on
  `node:24-bookworm-slim`** and defaults to guessing `openssl-1.1.x`,
  which doesn't match bookworm's actual OpenSSL 3.x — this doesn't fail
  the build, it fails the query engine at *runtime*. Install `openssl`
  via `apt-get` in both the build and runtime Docker stages.
- **No `tmux` and no root in this container** — `apt-get install tmux`
  fails on the dpkg lock (permission denied) with no `sudo`. Background
  processes still work fine across tool calls with plain
  `cmd > log 2>&1 & disown`; the driver above uses that instead of tmux.
- **No `chromium-cli`, and installing Playwright's own Chromium would
  blow the ~1.7GB free disk budget.** `playwright-core` (client library
  only, no bundled browser, ~12MB) plus the system `/usr/bin/google-chrome`
  via `executablePath` avoids the download entirely — see `driver.mjs`.
- **`wait-for text=X` matches anywhere on the page, not scoped to a
  specific row/element.** The alerts table has many rows with recurring
  status strings (`notification: executed` appears on several rows from
  past test runs) — a `wait-for` after clicking one row's action button
  can pass because a *different* row already has that text, not because
  your click's effect landed. Use `screenshot` + look, or a more specific
  selector, when you need to confirm one specific row changed.
- **`tsx watch` spawns two processes per service** (an `sh -c "tsx watch
  ..."` wrapper plus its real `node` child), and killing the agent's or
  classification's processes with `pkill -f <pattern>`, or with
  `pgrep -f <pattern> | xargs kill`, **in the same tool call that started
  or is otherwise driving them**, reproducibly cut the tool call short
  (exit 144, no output) partway through, leaving one of the two services
  half-killed. Root cause unconfirmed — plain `kill <pid>` against PIDs
  found by a *separate*, prior `ps` call never had this problem, which is
  why the stop sequence above splits "find the PIDs" and "kill the PIDs"
  into two tool calls instead of one pipeline. Backend/dashboard were
  never affected (port-based `lsof -ti:<port> | xargs kill` in one
  command was reliable every time) — this seems specific to
  agent/classification's process shape or how they were originally
  backgrounded, not to `pkill`/`xargs` in general.
- **The backend's login route needs real credentials, and `.env` is
  correctly off-limits to read directly** (secrets). If you don't know
  `ADMIN_EMAIL`/`ADMIN_PASSWORD`, don't try to `cat`/`grep` the file —
  create a disposable test admin instead via a small script placed
  *inside* `packages/backend/` (relative imports like `./src/db.js`
  break if the script lives outside the package) using
  `hashPassword` from `src/auth/passwords.js`, run with
  `npx --no-install tsx --env-file=.env <script>`, then delete it.

## Troubleshooting

- **`docker inspect` health status stuck on `starting`**: normal for the
  first ~6-8s; the compose healthcheck polls every 5s with 10 retries.
  Poll, don't fixed-sleep.
- **`tsc` errors like `Parameter 'action' implicitly has an 'any' type`
  in `packages/backend/src/routes/*.ts` that don't reproduce when you run
  `tsc` locally in dev**: Prisma Client wasn't generated before this
  build — see the Gotchas entry above.
- **`Prisma failed to detect the libssl/openssl version... Defaulting to
  "openssl-1.1.x"`** during `pnpm install`: harmless in this dev
  container (already has a compatible engine installed), but treat it as
  a real problem in any Docker build — see the Gotchas entry above.
- **`chromium-cli: command not found`**: not installed here; use
  `driver.mjs` in this skill directory instead (same command
  vocabulary).
- **`sudo: a password is required` / `Could not open lock file
  /var/lib/dpkg/lock-frontend`**: no root in this container. Don't try to
  `apt-get install` anything not already present — find a workaround
  (system Chrome, `playwright-core` without the browser download, `&
  disown` instead of tmux) rather than escalating privileges.

---
name: run-logikos-dsp
description: Build, run, and drive logikos-dsp (backend API, agent file-watcher, classification worker, React dashboard, native Go agent). Use when asked to start logikos-dsp, run its tests, build it, take a screenshot of the dashboard, or verify a change end-to-end (file event → alert → dashboard → quarantine).
---

logikos-dsp is a 4-service product (Fastify backend, file-watching agent,
NER classification worker, React dashboard) plus a `shared` types package
and a Go reimplementation of the agent (`native-agent/`), in one pnpm
workspace. The three non-dashboard services are headless — drive them with
`curl` and by dropping files into the watched directory. The dashboard is
driven with a small Playwright REPL at
`.claude/skills/run-logikos-dsp/driver.mjs` (same command vocabulary as
`chromium-cli`, which isn't installed here).

**All paths below are relative to the repo root** — the directory holding
`pnpm-workspace.yaml`. Everything below was run from a container with no
Node, no Go, no browser and **no root**; the Prerequisites section is the
part that actually matters.

## Prerequisites

Check what's already here before installing anything:

```bash
node -v; pnpm -v; go version; docker --version; ls /usr/bin/google-chrome
```

If any are missing there is **no root and no passwordless sudo** in this
container (`sudo -n true` fails, `apt-get install` dies on the dpkg lock).
Everything below installs into `$HOME` instead. Network is IPv4-only —
`curl -4` if a plain `curl` hangs.

### Node + pnpm (needed for everything)

```bash
curl -4 -fsSL -o /tmp/node.tar.xz https://nodejs.org/dist/v24.21.0/node-v24.21.0-linux-x64.tar.xz
mkdir -p ~/.local/node && tar -xJf /tmp/node.tar.xz -C ~/.local/node --strip-components=1
export PATH="$HOME/.local/node/bin:$PATH"
corepack enable --install-directory ~/.local/node/bin
corepack prepare pnpm@9.12.0 --activate
```

### Go (only for `native-agent/`)

```bash
curl -4 -fsSL -o /tmp/go.tar.gz "https://go.dev/dl/$(curl -4 -s https://go.dev/VERSION?m=text | head -1).linux-amd64.tar.gz"
tar -xzf /tmp/go.tar.gz -C ~/.local
export PATH="$HOME/.local/go/bin:$PATH"
```

### Browser for the dashboard driver

Three separate problems, all solved in userspace. **Every fresh shell needs
the `PATH` exports above**; the browser bits are baked into `driver.mjs` and
need no exports.

```bash
cd .claude/skills/run-logikos-dsp && npm install && cd -

# 1. Playwright refuses to install on Ubuntu 26.04 — override the detected platform.
PLAYWRIGHT_HOST_PLATFORM_OVERRIDE=ubuntu24.04-x64 \
  npx --no-install --prefix .claude/skills/run-logikos-dsp playwright-core install chromium

# 2. The downloaded Chromium is missing 12 shared libs. Fetch + unpack them as a
#    normal user (apt-get download needs no root; dpkg-deb -x just extracts).
mkdir -p /tmp/debs && cd /tmp/debs
PKGS="libasound2t64 libatk1.0-0t64 libatk-bridge2.0-0t64 libatspi2.0-0t64 libcairo2 \
libcups2t64 libgbm1 libpango-1.0-0 libxcomposite1 libxdamage1 libxfixes3 libxrandr2"
apt-get download $(apt-cache depends --recurse --no-recommends --no-suggests \
  --no-conflicts --no-breaks --no-replaces --no-enhances $PKGS | grep -E '^[a-z]' | sort -u)
# 3. ...and has no fonts, which renders every screenshot as blank boxes.
apt-get download fontconfig fontconfig-config fonts-liberation fonts-dejavu-core
for d in *.deb; do dpkg-deb -x "$d" ~/.local/chrome-deps; done
cd -
```

`driver.mjs` points the browser at `~/.local/chrome-deps` automatically
(`LD_LIBRARY_PATH`/`FONTCONFIG_PATH`/`XDG_DATA_HOME`) when that directory
exists, so nothing needs exporting per-shell. Verify — **the
`LD_LIBRARY_PATH` prefix is part of the check**, a bare `ldd` reports all 12
libs missing even when the driver works fine:

```bash
LD_LIBRARY_PATH="$HOME/.local/chrome-deps/usr/lib/x86_64-linux-gnu:$HOME/.local/chrome-deps/lib/x86_64-linux-gnu" \
  ldd ~/.cache/ms-playwright/chromium-1217/chrome-linux64/chrome | grep "not found"   # expect no output
```

## Setup

```bash
export PATH="$HOME/.local/node/bin:$PATH"
pnpm install          # ~40s; the Prisma "could not find your schema" warning here is expected — see Gotchas
```

Env files are gitignored and must be created. **You create them, so you know
the admin password** — no need to read secrets back out later:

```bash
cp packages/backend/.env.example packages/backend/.env
cp packages/backend/.env.test.example packages/backend/.env.test
sed -i 's|^JWT_SECRET=.*|JWT_SECRET="dev-only-local-secret-a7f3c1e9b45d28f06c3a91e7d5b2408f"|' packages/backend/.env
sed -i 's|^ADMIN_PASSWORD=.*|ADMIN_PASSWORD="DevAdmin123!"|' packages/backend/.env
sed -i 's|^RESPONSE_WEBHOOK_URL=.*|RESPONSE_WEBHOOK_URL="http://localhost:9099/hook"|' packages/backend/.env
echo "AGENT_ENROLL_TOKEN=\"$(openssl rand -hex 32)\"" >> packages/backend/.env   # agents need the same value
echo 'DATABASE_URL="postgresql://logikos:logikos@localhost:5432/logikos_dsp"' > packages/classification/.env
```

`packages/classification/.env` has **no** `.env.example` — the one line above
is its entire contents. The dashboard needs no env (`VITE_BACKEND_URL`
defaults to `http://localhost:4000`).

Postgres, then schema + admin user. This host may be running other projects'
containers — confirm 5432/4000/5173 are free first (`ss -lntp | grep -E
':5432|:4000|:5173'`):

```bash
pnpm db:up
for i in $(seq 1 30); do
  s=$(docker inspect --format='{{.State.Health.Status}}' logikos-dsp-postgres-1 2>/dev/null)
  [ "$s" = "healthy" ] && break
  sleep 2
done

pnpm --filter @logikos-dsp/backend exec prisma generate   # REQUIRED — see Gotchas
pnpm --filter @logikos-dsp/shared build                   # other packages import its dist/
pnpm db:migrate                                           # applies the 5 migrations
pnpm db:seed                                              # creates admin@example.com from .env
docker exec logikos-dsp-postgres-1 psql -U logikos -d postgres -c "CREATE DATABASE logikos_dsp_test;"
```

## Run (agent path)

`tmux` exists here, but the services are headless and log to files, so plain
`& disown` is simpler and is what's verified below. Background processes
survive between tool calls.

```bash
export PATH="$HOME/.local/node/bin:$PATH"

pnpm --filter @logikos-dsp/backend dev > /tmp/backend.log 2>&1 & disown
timeout 60 bash -c 'until curl -sf http://localhost:4000/health -o /dev/null; do sleep 1; done' \
  || tail -30 /tmp/backend.log

mkdir -p /tmp/logikos-watch
export $(grep ^AGENT_ENROLL_TOKEN packages/backend/.env | tr -d '"')   # agents register with it
WATCH_PATH=/tmp/logikos-watch BACKEND_URL=http://localhost:4000 \
  pnpm --filter @logikos-dsp/agent dev > /tmp/agent.log 2>&1 & disown

pnpm --filter @logikos-dsp/classification dev > /tmp/classification.log 2>&1 & disown
timeout 120 bash -c 'until grep -q "polling every" /tmp/classification.log; do sleep 2; done'
```

The classification worker downloads the ~100MB NER model on first ever run
(into `packages/classification/.cache/`); after that it loads in ~10s.

### Prove the pipeline end to end

Drop a file with fake PII in the watched directory, then log in and read the
alert. Login is required for everything except the agent/ingest routes:

```bash
cat > /tmp/logikos-watch/sensitive-test.txt << 'EOF'
Employee record: John Smith works at Acme Corporation in New York.
Contact: john.smith@example.com, SSN: 123-45-6789
Credit card: 4111 1111 1111 1111
EOF
sleep 6

curl -s -c /tmp/cookies.txt -X POST http://localhost:4000/auth/login \
  -H 'Content-Type: application/json' \
  -d '{"email":"admin@example.com","password":"DevAdmin123!"}'
curl -s -b /tmp/cookies.txt http://localhost:4000/alerts | python3 -m json.tool | head -50
```

Expect one `SENSITIVE_DATA_EXPOSED` / `HIGH` alert listing `ssn, credit_card,
email, person, organization, location`, with two `PENDING` response actions
(`WEBHOOK_NOTIFICATION`, `FILE_QUARANTINE`).

The other alert path is the ransomware-rate rule — 50 events from one agent
in 60s (`RANSOMWARE_RATE_THRESHOLD` in `packages/shared/src/index.ts`):

```bash
for i in $(seq 1 60); do echo "burst payload $i" > /tmp/logikos-watch/burst-$i.txt; done
sleep 8
curl -s -b /tmp/cookies.txt http://localhost:4000/alerts \
  | python3 -c "import json,sys; [print(a['type'], a['severity'], len((a.get('metadata') or {}).get('affectedPaths') or [])) for a in json.load(sys.stdin)]"
```

Expect a `RANSOMWARE_RATE` / `CRITICAL` alert whose `metadata.affectedPaths`
holds 50 paths (capped at `MAX_QUARANTINE_PATHS`, not 60).

### Drive the dashboard

```bash
pnpm --filter @logikos-dsp/dashboard dev > /tmp/dashboard.log 2>&1 & disown
timeout 60 bash -c 'until curl -sf http://localhost:5173 -o /dev/null; do sleep 1; done'

cd .claude/skills/run-logikos-dsp
node driver.mjs << 'EOF'
nav http://localhost:5173
wait-for text=Sign in
fill input[type=email] admin@example.com
fill input[type=password] DevAdmin123!
click button[type=submit]
wait-for text=Alerts
screenshot 02-overview
click text=Alerts
wait-for text=SENSITIVE_DATA_EXPOSED
click text=Approve quarantine
wait-for text=quarantine: approved
screenshot 04-quarantine-approved
console
quit
EOF
```

Screenshots land in `.claude/skills/run-logikos-dsp/screenshots/`
(`<name>.png`, or `01.png`/`02.png`/... if no name given). **Open the PNG and
look at it** — the driver reports `ok screenshot` for a blank page too.

Approving quarantine only sets the action to `APPROVED`; the *agent* polls
every 10s and does the move. Verify the file physically moved:

```bash
sleep 14
ls -laR /tmp/logikos-watch/            # file is now under .logikos-quarantine/
tail -3 /tmp/agent.log                 # "quarantined /tmp/... -> /tmp/.../.logikos-quarantine/..."
```

| driver command | what it does |
|---|---|
| `nav <url>` | navigate |
| `wait-for text=<substring>` or `wait-for <css selector>` | wait up to 15s |
| `click <selector>` | click (a bare `text=Alerts` works too) |
| `fill <selector> <text>` | fill an input (real input events, not `.value =`). The line splits at the first space, so the selector can't contain one — use `a>b`, not `a b` |
| `press <key>` | keyboard press, e.g. `Enter` |
| `eval <js>` | run JS in page context, prints the JSON result |
| `viewport <w>x<h>` | resize, e.g. `viewport 390x844` (phone), `768x1024` (tablet); default 1280x720 |
| `screenshot [name]` | full-page screenshot |
| `console` | dump buffered `console.*` and page errors since launch |
| `quit` | close the browser |

`eval Array.from(document.querySelectorAll('button')).map(b=>b.textContent).join(' | ')`

Driving the **deployed** site through the gateway (no DNS for `*.logikos.dev` on this host, self-signed cert): `CHROME_ARGS="--host-resolver-rules=MAP dsp.logikos.dev 127.0.0.1|--ignore-certificate-errors" node driver.mjs`, then `nav https://dsp.logikos.dev/` and log in with the credentials from the root `.env.backend`. Flags are `|`-separated because they contain spaces.

Checking a layout at a width: `viewport 390x844`, then `eval document.documentElement.scrollWidth - innerWidth` — anything above 0 means the page scrolls sideways. Below 900px the sidebar is a drawer, so click `.nav-toggle` before a nav item, and prefer an exact match (`eval [...document.querySelectorAll('.sidebar nav button')].find(b => b.textContent === 'Data Risk').click()`) — `text=Data Risk` also matches the "Data Risk Assessment" group label.
is the fastest way to find out what's clickable on the current view.

## Run: native Go agent

A drop-in replacement for the TypeScript agent's **local-path mode only**
(SMB/M365/Google Drive stay on the TS agent).

```bash
export PATH="$HOME/.local/go/bin:$PATH"
cd native-agent
go test ./...                                                  # 2 packages with tests, both pass
go build -o /tmp/logikos-native-agent ./cmd/agent               # ~10MB static binary
GOOS=windows GOARCH=amd64 go build -o /tmp/logikos-native-agent.exe ./cmd/agent   # cross-compiles
cd -
```

It takes the same env vars as the TS agent's local mode. **Stop the TS agent
first** — both derive the same `Agent.key` and would double-report:

```bash
AGENT_ENROLL_TOKEN=$(grep ^AGENT_ENROLL_TOKEN packages/backend/.env | cut -d= -f2 | tr -d '"') \
WATCH_PATH=/tmp/logikos-watch BACKEND_URL=http://localhost:4000 \
  /tmp/logikos-native-agent > /tmp/native-agent.log 2>&1 & disown
sleep 6; cat /tmp/native-agent.log
docker exec logikos-dsp-postgres-1 psql -U logikos -d logikos_dsp -t \
  -c 'SELECT "key", "hostname", "watchedRoot" FROM "Agent";'
```

That key-identity claim is worth re-verifying after any change to either
agent's config code: pointed at the same host + `WATCH_PATH`, the Go agent
logs the *same* `agent-<hash>` the TS agent used and the `Agent` table still
holds exactly **one** row. Unlike the TS agent it logs no per-event line —
confirm detection through `/alerts`, not its log.

## Stop

The two services with a listening port are safe to kill in one command:

```bash
lsof -ti:4000 -sTCP:LISTEN | xargs -r kill      # backend
lsof -ti:5173 -sTCP:LISTEN | xargs -r kill      # dashboard
```

The agent, the classification worker and the Go agent have no port. **Do not
reach for `pkill -f`** — it kills the tool call running it (see Gotchas).
Find the PIDs in one tool call:

```bash
ps -eo pid,ppid,cmd | grep -E "src/index\.ts|native-age[n]t" | grep -v grep
```

then kill every PID it listed in a **separate** tool call:

```bash
kill <pid> <pid> <pid> ...
```

Match on `src/index.ts`, not `tsx watch` — the latter only matches the
outermost `sh -c` of each 3-process tree and misses the two `node` processes
that do the actual work. The split `[n]` keeps the pattern from matching this
command's own shell. Re-run the same `ps` to confirm; anything left with
`PPID 1` is an orphan from an earlier session and should be killed too:

```bash
ps -eo pid,cmd | grep -E "src/index\.ts|native-age[n]t" | grep -v grep || echo "ALL STOPPED"
```

Postgres is normally left running between sessions
(`docker compose stop postgres` to stop it).

## Run (human path)

```bash
pnpm dev:backend         # → http://localhost:4000
pnpm dev:classification  # background worker, no port
WATCH_PATH=/some/dir AGENT_ENROLL_TOKEN=<from packages/backend/.env> pnpm dev:agent
pnpm dev:dashboard       # → http://localhost:5173
```

Ctrl-C each. Useless headless — that's what the driver is for.

## Test

```bash
pnpm test     # vitest across shared, agent, backend, classification
pnpm build    # tsc for all 5 packages + vite build for the dashboard
```

Current counts, all passing: **agent 34, backend 19, classification 14,
shared 5** (72 total). `packages/dashboard` is the only package with no test
script. Backend's suite needs Postgres and the `logikos_dsp_test` database;
it applies migrations itself via `globalSetup`, and runs with
`fileParallelism: false` because every file truncates shared tables in
`beforeEach`.

---

## Gotchas

- **A workspace-root `pnpm install` silently leaves Prisma Client
  ungenerated.** `@prisma/client`'s postinstall can't find
  `packages/backend/prisma/schema.prisma` from the root, prints
  `prisma:warn We could not find your Prisma schema in the default
  locations`, and moves on. Every Prisma-typed query then becomes `any` and
  `tsc` fails with `implicitly has an 'any' type` on unrelated-looking lines.
  Always run `pnpm --filter @logikos-dsp/backend exec prisma generate` after
  installing. (Reproduces on every fresh install here.)
- **Playwright will not install a browser on Ubuntu 26.04** — `ERROR:
  Playwright does not support chromium on ubuntu26.04-x64` (exit 1).
  `PLAYWRIGHT_HOST_PLATFORM_OVERRIDE=ubuntu24.04-x64` fixes it. The value
  must be a full `<distro><version>-<arch>` string — the bare `ubuntu-24.04`
  is read but still rejected (exit 1); `ubuntu22.04-x64` also works. On a
  re-run it prints three alarming `BEWARE: your OS is not officially
  supported` lines and exits 0 — that's the idempotent "already installed"
  path, not a failure. Check the exit code, not the output.
- **The downloaded Chromium then can't start**, with only
  `browserType.launch: Target page, context or browser has been closed` to
  show for it — the real cause is 12 missing `lib*.so` files, visible with
  `ldd <chrome> | grep "not found"`, not in the Playwright error. `apt-get
  download` + `dpkg-deb -x` into `~/.local/chrome-deps` fixes it with no
  root.
- **Chromium in this container has no fonts**, so the *first* working
  screenshot is a page of blank boxes plus `Could not find any font: , sans`
  on stderr. Extract `fontconfig` + `fonts-liberation` into the same prefix
  and set `FONTCONFIG_PATH`/`XDG_DATA_HOME` (`driver.mjs` does this).
- **The browser path is `chrome-linux64/`, not `chrome-linux/`** — worth
  knowing when poking at `~/.cache/ms-playwright` by hand.
- **`text=` selectors are page-wide and always hit the first match** — for
  `click` as well as `wait-for` (`driver.mjs` uses `getByText(...).first()`).
  The alerts table repeats every button label and status string down the
  rows, so once there is more than one alert, `click text=Approve quarantine`
  silently acts on whichever row sorted to the top, and the following
  `wait-for text=quarantine: approved` can pass off a *different* row that
  was already in that state. Both still print `ok`. Screenshot and look, or
  narrow the selector, whenever row identity matters. (Alerts accumulate in
  the dev database across sessions, so this is the normal case, not the edge
  case.)
- **`pkill -f <name>` kills the tool call that runs it, exit 144, output
  truncated mid-command.** The Bash tool wraps each call in a `bash -c` whose
  *own* `/proc/<pid>/cmdline` contains the full command text — so `pkill -f
  logikos-native-agent` matches that wrapper and SIGTERMs its own parent. The
  target does die, but everything after that line in the same call never
  runs. The `[l]ogikos` bracket trick does **not** save you: any other
  mention of the bare name elsewhere in the same command (a following
  `pgrep`, an `echo`) puts the literal string back in the cmdline and it
  self-matches again. Use `ps` in one tool call and `kill <pid>` in the next.
  (An earlier version of this skill recorded the exit-144 symptom with "root
  cause unconfirmed" — this is the cause.)
- **Each `tsx watch` service is a 3-process tree** — `sh -c "tsx watch ..."`
  → `node tsx/dist/cli.mjs` → the real `node ... src/index.ts`. Killing the
  listener by port (`lsof -ti:4000 | xargs kill`) reaps the node processes
  but leaves the `sh -c` wrapper orphaned and still visible in `ps`; sweep it
  separately or it looks like the service is still up.
- **`pgrep -x` silently fails on these names** — `logikos-native-agent` is
  over the 15-character comm limit, so `pgrep -x` returns nothing and warns.
  `ps -eo pid,cmd | grep` is the reliable form.
- **`packages/classification/.env` has no example file** and the worker
  starts with `node --env-file=.env`, so a missing file is a hard startup
  failure, not a default-to-localhost.
- **This host runs other projects' containers** (`logikos-school`,
  `logikos-chms`, `logikos-asset` on 3000-3010/8000-8020/5433-5434). 5432,
  4000 and 5173 were free, but check before `pnpm db:up`.
- Docker-image packaging has its own separate trap list (OpenSSL detection,
  `pnpm --prod deploy` losing the Prisma generate). Not exercised by this
  skill — see `ARCHITECTURE.md` § Production packaging before building
  images.

## Troubleshooting

- **`node: command not found` in a fresh shell** — the Node install lives in
  `~/.local/node`, which nothing adds to `PATH` automatically. Re-export it
  (same for `~/.local/go/bin`). This bites between tool calls constantly.
- **`docker inspect` health stuck on `starting`** — normal for the first
  ~6-8s (healthcheck polls every 5s). Poll, don't fixed-sleep.
- **`sudo: interactive authentication is required` / `Could not open lock
  file /var/lib/dpkg/lock-frontend`** — no root here. Don't escalate; use the
  `$HOME` installs above.
- **`err launch: ... browser has been closed`** from `driver.mjs` — missing
  browser libs. Run the `ldd ... | grep "not found"` check; if
  `~/.local/chrome-deps` is missing, redo the Prerequisites browser steps.
- **Driver prints `ok` for everything but the screenshot is the login page** —
  the login `fill`/`click` silently failed (wrong password, or the backend
  isn't up). Add `console` to the command list and check `/tmp/backend.log`.
- **`console` shows `Failed to load resource: ... 401 (Unauthorized)` on a
  successful run** — expected. The app probes `/auth/me` before there's a
  cookie; two 401s before the login POST are normal and not a symptom.
- **`chromium-cli: command not found`** — not installed here; `driver.mjs` is
  the replacement, same vocabulary.
- **Alert never appears after dropping a file** — check
  `/tmp/classification.log` says `polling every 2000ms` (the model load
  finished), and that the agent log shows it registered. The Go agent logs no
  per-event line, so an empty log there is not a symptom.

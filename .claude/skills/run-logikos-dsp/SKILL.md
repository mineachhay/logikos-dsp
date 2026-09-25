---
name: run-logikos-dsp
description: Build, run, start, stop and drive logikos-dsp (backend API, agent file-watcher, classification worker, React dashboard, native Go agent). Use when asked to start logikos-dsp, run its tests, build it, take a screenshot of the dashboard, or verify a change end-to-end (file event → alert → dashboard → quarantine), including the Windows audit-log paths (who changed a file, copies off a share, bulk reads) without a Windows server.
---

logikos-dsp is a 4-service dev stack (Fastify backend, file-watching agent,
NER classification worker, React dashboard) over Postgres, plus `shared`,
`backup` and a Go reimplementation of the agent (`native-agent/`), in one pnpm
workspace. Two committed harnesses drive it:

- `.claude/skills/run-logikos-dsp/stack.sh up|down|restart|status` — starts
  each service as its own process group with a pidfile, waits for readiness,
  and stops it cleanly. The headless services are then driven with `curl` and
  by dropping files into the watched directory.
- `.claude/skills/run-logikos-dsp/fake-share.sh` — sourced; fakes a Windows
  file server + share held by a second agent and posts audit READ records as
  it, for the activity / copy / bulk-read paths.
- `.claude/skills/run-logikos-dsp/driver.mjs` — a stdin Playwright REPL for
  the dashboard (`chromium-cli`'s command vocabulary; `chromium-cli` itself
  isn't installed).

**All paths below are relative to the repo root** (the directory holding
`pnpm-workspace.yaml`). Everything was verified on a machine with no Node, no
Go, no browser and no root — Ubuntu 24.04 and 26.04. Some such machines have a
working Docker, some don't; the recipe never needs it. The Prerequisites
section is the part that matters.

**On the production host** (see CLAUDE.md "The production host" — Docker,
live stack on :4000/:5432) don't use this recipe as-is: its dev backend runs
on :4001 against `logikos_dsp_dev`.

## Prerequisites

Every fresh shell needs the exports below — and **each Bash tool call is a
fresh shell**, so prefix every call that runs `node`/`pnpm`/`go`/`psql`
(the symptom otherwise is `node: command not found`, and anything after it in
the same call runs against nothing):

```bash
export PATH="$HOME/.local/node/bin:$HOME/.local/go/bin:$HOME/.local/pg/usr/lib/postgresql/16/bin:$PATH"
export LD_LIBRARY_PATH=$HOME/.local/pg/usr/lib/x86_64-linux-gnu PGHOST=localhost PGUSER=logikos PGPASSWORD=logikos
```

(`stack.sh` sets its own PATH; the exports are for your ad-hoc commands and `psql`.)

### Node 24 + pnpm (needed for everything)

```bash
curl -4 -fsSL -o /tmp/node.tar.xz https://nodejs.org/dist/v24.21.0/node-v24.21.0-linux-x64.tar.xz
mkdir -p ~/.local/node && tar -xJf /tmp/node.tar.xz -C ~/.local/node --strip-components=1
corepack enable --install-directory ~/.local/node/bin
corepack prepare pnpm@9.12.0 --activate
```

### Postgres 16 without Docker or root

Skip if something already answers on :5432 (e.g. `pnpm db:up` on a machine
with Docker). Otherwise unpack Ubuntu's own packages into `$HOME`:

```bash
mkdir -p /tmp/pgdebs && cd /tmp/pgdebs
apt-get download postgresql-16 postgresql-client-16 libpq5
for d in *.deb; do dpkg-deb -x "$d" ~/.local/pg; done
cd -
echo logikos > /tmp/pwfile
initdb -D ~/.local/pgdata -U logikos --pwfile=/tmp/pwfile -A scram-sha-256
echo "unix_socket_directories = '/tmp'" >> ~/.local/pgdata/postgresql.conf   # REQUIRED — see Gotchas
pg_ctl -D ~/.local/pgdata -l ~/.local/pgdata/server.log -w start
psql -d postgres -c "CREATE DATABASE logikos_dsp;" -c "CREATE DATABASE logikos_dsp_test;"
```

The role/password `logikos`/`logikos` match every `.env*.example`, so no env
edits are needed. After a reboot, `stack.sh up` restarts it.

### Go (only for `native-agent/`)

```bash
curl -4 -fsSL -o /tmp/go.tar.gz "https://go.dev/dl/$(curl -4 -s https://go.dev/VERSION?m=text | head -1).linux-amd64.tar.gz"
tar -xzf /tmp/go.tar.gz -C ~/.local
```

### Browser for the dashboard driver

```bash
cd .claude/skills/run-logikos-dsp && npm install && cd -
npx --no-install --prefix .claude/skills/run-logikos-dsp playwright-core install chromium
# On Ubuntu 26.04 only, prefix that with PLAYWRIGHT_HOST_PLATFORM_OVERRIDE=ubuntu24.04-x64 (see Gotchas).

# The downloaded Chromium is missing 12 shared libs and has no fonts. Fetch +
# unpack them as a normal user (apt-get download needs no root).
mkdir -p /tmp/debs && cd /tmp/debs
PKGS="libasound2t64 libatk1.0-0t64 libatk-bridge2.0-0t64 libatspi2.0-0t64 libcairo2 \
libcups2t64 libgbm1 libpango-1.0-0 libxcomposite1 libxdamage1 libxfixes3 libxrandr2"
apt-get download $(apt-cache depends --recurse --no-recommends --no-suggests \
  --no-conflicts --no-breaks --no-replaces --no-enhances $PKGS | grep -E '^[a-z]' | sort -u)
apt-get download fontconfig fontconfig-config fonts-liberation fonts-dejavu-core
for d in *.deb; do dpkg-deb -x "$d" ~/.local/chrome-deps; done
cd -
```

That's ~115 debs / 121MB (~50s). `driver.mjs` points the browser at
`~/.local/chrome-deps` automatically. Verify — **the `LD_LIBRARY_PATH` prefix
is part of the check**; a bare `ldd` reports all 12 libs missing even when the
driver works:

```bash
LD_LIBRARY_PATH="$HOME/.local/chrome-deps/usr/lib/x86_64-linux-gnu:$HOME/.local/chrome-deps/lib/x86_64-linux-gnu" \
  ldd ~/.cache/ms-playwright/chromium-1217/chrome-linux64/chrome | grep "not found"   # expect no output
```

## Setup

```bash
pnpm install          # ~75s; the Prisma "could not find your schema" warning is expected — see Gotchas
```

Env files are gitignored and must be created. **You create them, so you know
the admin password.** Replace keys in place — `.env.example` already has
`AGENT_ENROLL_TOKEN` and `SOURCE_CREDENTIALS_KEY` lines, and the latter's
placeholder `change-me` is rejected (must decode to 32 bytes):

```bash
cp packages/backend/.env.example packages/backend/.env
cp packages/backend/.env.test.example packages/backend/.env.test
sed -i \
  -e 's|^JWT_SECRET=.*|JWT_SECRET="dev-only-local-secret-a7f3c1e9b45d28f06c3a91e7d5b2408f"|' \
  -e 's|^ADMIN_PASSWORD=.*|ADMIN_PASSWORD="DevAdmin123!"|' \
  -e 's|^RESPONSE_WEBHOOK_URL=.*|RESPONSE_WEBHOOK_URL="http://localhost:9099/hook"|' \
  -e "s|^AGENT_ENROLL_TOKEN=.*|AGENT_ENROLL_TOKEN=\"$(openssl rand -hex 32)\"|" \
  -e "s|^SOURCE_CREDENTIALS_KEY=.*|SOURCE_CREDENTIALS_KEY=\"$(openssl rand -base64 32)\"|" \
  packages/backend/.env
echo 'DATABASE_URL="postgresql://logikos:logikos@localhost:5432/logikos_dsp"' > packages/classification/.env
```

`packages/classification/.env` has **no** example file — that one line is all
of it. The dashboard needs no env (`VITE_BACKEND_URL` defaults to `:4000`).

Schema + admin user (Postgres must be up):

```bash
pnpm --filter @logikos-dsp/backend exec prisma generate   # REQUIRED — see Gotchas
pnpm --filter @logikos-dsp/shared build                   # other packages import its dist/
pnpm db:migrate                                           # applies all 15 migrations, creates none
pnpm db:seed                                              # "Created admin user admin@example.com"
```

## Run (agent path)

```bash
.claude/skills/run-logikos-dsp/stack.sh up       # postgres + backend :4000, agent, classification, dashboard :5173
.claude/skills/run-logikos-dsp/stack.sh status
```

`up` blocks until each service is ready and prints the log tail of any that
isn't. Logs: `/tmp/{backend,agent,classification,dashboard}.log`. The agent
watches `/tmp/logikos-watch` (override with `WATCH_PATH=`). Takes ~5s; the
very first classification start downloads the ~100MB NER model into
`packages/classification/.cache/` (~10s here). Name services to act on a
subset: `stack.sh restart agent`, `stack.sh up backend`.

### Prove the pipeline end to end

Drop a file with fake PII, then log in and read the alert. Use a **unique
filename** each time — alerts accumulate across runs, and the dashboard
script below finds the row by that name:

```bash
F=pii-$(date +%s).txt
printf 'Employee record: John Smith works at Acme Corporation in New York.\nContact: john.smith@example.com, SSN: 123-45-6789\nCredit card: 4111 1111 1111 1111\n' > /tmp/logikos-watch/$F
sleep 6
curl -s -c /tmp/cookies.txt -X POST http://localhost:4000/auth/login \
  -H 'Content-Type: application/json' -d '{"email":"admin@example.com","password":"DevAdmin123!"}'
curl -s -b /tmp/cookies.txt http://localhost:4000/alerts | python3 -c "
import json,sys
for a in json.load(sys.stdin):
    if '$F' in a['message']: print(a['type'], a['severity'], a['metadata']['patternTypes'], [(r['type'], r['status']) for r in a['responseActions']])"
```

Expect `SENSITIVE_DATA_EXPOSED HIGH ['ssn', 'credit_card', 'email', 'person',
'organization', 'location']` with `WEBHOOK_NOTIFICATION` and `FILE_QUARANTINE`
both `PENDING`.

The other alert path is the ransomware-rate rule — 50 events from one source
in 60s (`RANSOMWARE_RATE_THRESHOLD` in `packages/shared/src/index.ts`):

```bash
for i in $(seq 1 60); do echo "burst payload $i" > /tmp/logikos-watch/burst-$i.txt; done
sleep 8
curl -s -b /tmp/cookies.txt http://localhost:4000/alerts \
  | python3 -c "import json,sys; [print(a['type'], a['severity'], len((a.get('metadata') or {}).get('affectedPaths') or [])) for a in json.load(sys.stdin)]"
```

Expect a `RANSOMWARE_RATE` / `CRITICAL` alert. Its `affectedPaths` holds every
distinct path seen in the window **at the moment the rule fired** (51 in the
verified run: the 50th burst file tripped it, plus the PII file from just
before) — not the full 60, and not a cap (`MAX_QUARANTINE_PATHS` is 200).
**Don't approve quarantine on it** unless you mean to: see Gotchas.

### Simulate a file server: audit reads, copies off a share, bulk reads

Most recent work is in the audit-log path (`/ingest/activity` →
`backend/src/activity.ts`: actor matching, cross-source `COPIED`,
`BULK_FILE_READ`), which normally needs a Windows server over WinRM.
`fake-share.sh` stands one in: it registers a second, fake agent with the
`managed-sources`/`windows-activity` capabilities, creates a file server
(`recordReads` on) with a share assigned to that agent, and defines
`post_reads <user> <path>...` to post 5145 READ records as it. The real agent
never scans the fake share (it isn't assigned to it), so nothing tries SMB.

```bash
source .claude/skills/run-logikos-dsp/fake-share.sh      # prints FSNAME/FSID/SHID
N=report-$(date +%s).xlsx
post_reads alice Q3/$N                                   # alice read Q3/<N> on the share...
echo "quarterly numbers" > /tmp/logikos-watch/$N          # ...and the same name lands in the watched folder
sleep 5
curl -s -b /tmp/cookies.txt $B/events | python3 -c "
import json,sys
for e in json.load(sys.stdin):
    if '$N' in e['path']: print(e['eventType'], e['previousPath'], e['actorUser'], e['actorIp'])"
post_reads mallory $(seq -f 'HR/emp-%g.pdf' 1 55)
curl -s -b /tmp/cookies.txt $B/alerts | python3 -c "
import json,sys
for a in json.load(sys.stdin):
    if a['type']=='BULK_FILE_READ': print(a['severity'], a['message'])"
curl -s -b /tmp/cookies.txt -X DELETE "$B/file-servers/$FSID?confirm=$FSNAME"; echo   # cleanup
```

Expect `COPIED Q3/report-….xlsx alice 10.0.0.7` — one event, carrying the
share path as `previousPath` (and `previousSourceId`), not a plain `CREATED` —
then `MEDIUM mallory read 51+ different files on smb://fs01.example.test/finance
…` (threshold `BULK_READ_THRESHOLD` = 50 unless the server sets
`bulkReadThreshold`). The delete removes the share's reads and its alert; the
fake `Agent` row stays (there's no agent delete), harmless.

To see it in the dashboard (run before the cleanup line), after logging in as
below: `click .sidebar >> text=File Events`, `wait-for td:has-text("COPIED")`,
`fill input[type=text] report-`, `screenshot 05-file-events-copied` — the
COPIED row shows `fs01-… · finance: Q3/<N> ⧉ /tmp/logikos-watch/<N>` next to its
READ row. `click .sidebar >> text=File Access` + `wait-for
td:has-text("mallory")` shows the reads.

### Drive the dashboard

Run from the repo root, in the same shell as `$F` above (the heredoc is
unquoted so `$F` expands):

```bash
node .claude/skills/run-logikos-dsp/driver.mjs << EOF
nav http://localhost:5173
wait-for text=Sign in
fill input[type=email] admin@example.com
fill input[type=password] DevAdmin123!
click button[type=submit]
wait-for text=Alerts
screenshot 02-overview
click .sidebar >> text=Alerts
wait-for tr:has-text("$F")
click tr:has-text("$F") >> text=Approve quarantine
wait-for tr:has-text("$F") >> text=/quarantine: (approved|executed)/
screenshot 04-quarantine-approved
console
quit
EOF
```

Every line should print `ok ...`; the two `401 (Unauthorized)` lines that
`console` prints are the dashboard's session probe before login, not a
failure. Screenshots land in
`.claude/skills/run-logikos-dsp/screenshots/<name>.png`. **Open the PNG and
look at it** — the driver says `ok screenshot` for a blank page too. The row
reads "quarantine: approved, waiting for agent" until the agent's next 10s
poll; then the file physically moves:

```bash
sleep 14
ls /tmp/logikos-watch/.logikos-quarantine/ | grep "$F"
grep "$F" /tmp/agent.log            # "quarantined /tmp/... -> /tmp/.../.logikos-quarantine/..."
```

| driver command | what it does |
|---|---|
| `nav <url>` | navigate |
| `wait-for text=<substring>` or `wait-for <selector>` | wait up to 15s. Any Playwright selector works, incl. chains: `tr:has-text("x") >> text=/re/` |
| `click <selector>` | click (same selector syntax; `text=Alerts` works) |
| `fill <selector> <text>` | fill an input (real input events). Splits at the first space, so the selector can't contain one — use `a>b`, not `a b` |
| `press <key>` | keyboard press, e.g. `Enter` |
| `eval <js>` | run JS in page context, prints the JSON result |
| `viewport <w>x<h>` | resize, e.g. `390x844` (phone); default 1280x720 |
| `screenshot [name]` | full-page screenshot |
| `console` | dump buffered `console.*` and page errors since launch |
| `quit` | close the browser |

`eval Array.from(document.querySelectorAll('button')).map(b=>b.textContent).join(' | ')`
is the fastest way to find out what's clickable on the current view.

Checking a layout at a width: `viewport 390x844`, then `eval
document.documentElement.scrollWidth - innerWidth` — anything above 0 means
the page scrolls sideways. Below 900px the sidebar is a drawer, so click
`.nav-toggle` before a nav item, and prefer an exact match (`eval
[...document.querySelectorAll('.sidebar nav button')].find(b => b.textContent
=== 'Data Risk').click()`) — `text=Data Risk` also matches the "Data Risk
Assessment" group label.

Driving the **deployed** site from the production host (no DNS for
`*.logikos.dev` there, self-signed cert): `CHROME_ARGS="--host-resolver-rules=MAP
dsp.logikos.dev 127.0.0.1|--ignore-certificate-errors" node driver.mjs`, then
`nav https://dsp.logikos.dev/`. Flags are `|`-separated because they contain
spaces. (Not re-verified this session — no production host here.)

## Run: native Go agent

A drop-in replacement for the TypeScript agent's **local-path mode only**
(SMB/M365/Google Drive stay on the TS agent).

```bash
cd native-agent
go test ./...                                                  # cmd/agent, internal/client, internal/watch — all ok
go build -o /tmp/logikos-native-agent ./cmd/agent               # ~10MB static binary
GOOS=windows GOARCH=amd64 go build -o /tmp/logikos-native-agent.exe ./cmd/agent   # cross-compiles
cd -
```

Same env vars as the TS agent's local mode. **Stop the TS agent first** — both
derive the same `Agent.key` and would double-report:

```bash
.claude/skills/run-logikos-dsp/stack.sh down agent
AGENT_ENROLL_TOKEN=$(grep ^AGENT_ENROLL_TOKEN packages/backend/.env | cut -d= -f2 | tr -d '"') \
WATCH_PATH=/tmp/logikos-watch BACKEND_URL=http://localhost:4000 \
  /tmp/logikos-native-agent > /tmp/native-agent.log 2>&1 & disown
sleep 6; cat /tmp/native-agent.log
psql -d logikos_dsp -t -c 'SELECT "key", "hostname", "watchedRoot" FROM "Agent";'
```

Pointed at the same host + `WATCH_PATH`, it logs the *same* `agent-<hash>` the
TS agent used and the `Agent` table still holds exactly **one** row — re-check
this after touching either agent's config code. It logs no per-event line;
confirm detection through `/alerts` (drop a PII file as above). Stop it with
`ps -eo pid,cmd | grep 'native-age[n]t'` in one tool call, `kill <pid>` in the
next. **Keep the quotes**: unquoted, the shell glob-expands `native-age[n]t` to
the `native-agent/` directory when run from the repo root, and grep matches
itself again. Then `stack.sh up agent` to bring the TS agent back.

## Stop

```bash
.claude/skills/run-logikos-dsp/stack.sh down            # the 4 services; postgres keeps running
.claude/skills/run-logikos-dsp/stack.sh down postgres   # only if you started it from ~/.local/pg
```

A `pnpm ... ERR_PNPM_RECURSIVE_RUN_FIRST_FAIL ... SIGTERM` line at the end of
each log is the normal result of `down`, not a crash.

## Run (human path)

`pnpm dev:backend`, `pnpm dev:classification`, `WATCH_PATH=/some/dir
AGENT_ENROLL_TOKEN=<from packages/backend/.env> pnpm dev:agent`, `pnpm
dev:dashboard` in four terminals, Ctrl-C each. Useless headless.

## Test

```bash
pnpm test     # vitest in shared, agent, backend, backup, classification — ~40s
pnpm build    # tsc for all 6 packages + vite build for the dashboard — ~8s
```

Counts at the time of writing, all passing: **agent 76, backend 107,
classification 14, backup 12, shared 48** (257). `dashboard` has no test
script. Backend's suite needs Postgres and `logikos_dsp_test`; it migrates
itself (`globalSetup`) and must not be run as bare `npx vitest` (CLAUDE.md
explains why). **Running `pnpm build` while the stack is up kills the TS
agent** — see Gotchas.

---

## Gotchas

- **`pnpm build` during a dev session silently kills the TS agent.** It
  rewrites `packages/shared/dist/`, which every `tsx watch` service imports,
  so backend, agent and classification all restart at once. The agent comes
  back before the backend is listening, dies with `agent failed to start
  [TypeError: fetch failed] ... ECONNREFUSED 127.0.0.1:4000`, and `tsx watch`
  does not retry — it waits for the next file change. Its wrapper processes
  stay alive, so `stack.sh status` still says "running". After any build:
  `stack.sh restart agent`.
- **Approving quarantine on a `RANSOMWARE_RATE` alert raises another one.**
  The agent moves every `affectedPaths` file into `.logikos-quarantine/`;
  each move is a delete event on the watched root, so 50+ moves trip the rate
  rule again — a fresh CRITICAL alert whose `affectedPaths` is empty (the
  files are gone). It also quarantines the unrelated PII file if that was
  still in the window.
- **`text=` selectors are page-wide and hit the first match** (`driver.mjs`
  uses `getByText(...).first()` / `page.click`). The alerts table repeats
  every button label down the rows, newest first. The old version of this
  skill ran the burst *before* `click text=Approve quarantine` — which
  therefore approved quarantine on the ransomware row (moving 51 files) and
  then timed out waiting for text that never appeared in that row. Always
  scope to a row: `tr:has-text("<unique filename>") >> text=...`.
- **`text=X` can resolve to a hidden `<option>` and time out.** On File
  Events, `wait-for text=COPIED` fails even with a COPIED row on screen: the
  first match is the "All types" filter's `<option>`, which is never visible.
  Scope to cells — `td:has-text("COPIED")`.
- **The driver doesn't stop on an `err` line**; later commands run against
  whatever state the page is in (a failed `wait-for` followed by `ok
  screenshot` is common). Read every line, not just the last.
- **`eval` doesn't wait for render.** Straight after a `click .sidebar >>`
  it sees the previous view or nothing (`=> ""`). `wait-for` something on the
  new view first.
- **Driver `fill` selectors:** the table search boxes are `input[type=text]`
  (not `type=search` — that waits 30s then errs); the placeholder has spaces,
  so it can't be used either.
- **A fake agent needs capabilities to hold a share** — `POST
  /file-servers/:id/shares` returns 400 `agent … can't scan dashboard-managed
  shares` unless it registered with `"capabilities":["managed-sources"]`.
  Re-registering (same key) with them fixes it; `fake-share.sh` does this.
- **Postgres from the Ubuntu .deb won't start as a normal user** —
  `FATAL: could not create lock file
  "/var/run/postgresql/.s.PGSQL.5432.lock": No such file or directory` (that
  dir is created by the package's postinst, which never ran). The
  `unix_socket_directories = '/tmp'` line in `postgresql.conf` fixes it for
  good; TCP on localhost is what the app uses anyway.
- **A workspace-root `pnpm install` silently leaves Prisma Client
  ungenerated** — `prisma:warn We could not find your Prisma schema in the
  default locations`, then `tsc` fails with `implicitly has an 'any' type` on
  unrelated-looking lines. Always run `prisma generate` after installing.
- **Playwright refuses to install a browser on Ubuntu 26.04** — `ERROR:
  Playwright does not support chromium on ubuntu26.04-x64`.
  `PLAYWRIGHT_HOST_PLATFORM_OVERRIDE=ubuntu24.04-x64` fixes it (full
  `<distro><version>-<arch>` string; bare `ubuntu-24.04` is rejected). Not
  needed on 24.04. On a re-run it prints `BEWARE: your OS is not officially
  supported` and exits 0 — that's the "already installed" path.
- **The downloaded Chromium then can't start** — the only error is
  `browserType.launch: Target page, context or browser has been closed`; the
  real cause is 12 missing `lib*.so`, visible with `ldd`. The same 12 are
  missing on 24.04 and 26.04. `apt-cache depends --recurse` also pulls
  `libc6`/`libstdc++6` into the prefix; harmless when they match the system
  version (they do on stock Ubuntu).
- **No fonts → blank boxes.** The first working screenshot is all tofu plus
  `Could not find any font: , sans` on stderr, fixed by the fontconfig +
  fonts debs above (`driver.mjs` sets `FONTCONFIG_PATH`/`XDG_DATA_HOME`).
- **`pkill -f <name>` kills the tool call that runs it** (exit 144, output
  truncated): the Bash tool's own `bash -c` wrapper has the pattern in its
  cmdline. The `[x]yz` bracket trick fails as soon as the bare name appears
  anywhere else in the same command. `stack.sh` avoids this with pidfiles;
  for anything else, `ps` in one tool call and `kill <pid>` in the next.
- **Each dev service is a 4-level tree**: `pnpm --filter ... dev` → `sh -c
  tsx watch ...` → `node tsx/dist/cli.mjs` → the real `node ... src/index.ts`.
  Killing the listener by port (`lsof -ti:4000 | xargs kill`) kills only the
  bottom process — the tsx watcher survives and **brings the backend back on
  the next file save**. Killing the top `pnpm` orphans the watcher under PID
  1. Only killing the whole process group is clean, which is what `stack.sh`
  does (`setsid` + `kill -- -<pgid>`).

## Troubleshooting

| Symptom | Fix |
|---|---|
| `pg_ctl: could not start server` + `could not create lock file "/var/run/postgresql/..."` in `~/.local/pgdata/server.log` | Add `unix_socket_directories = '/tmp'` to `~/.local/pgdata/postgresql.conf` |
| `/tmp/agent.log` ends with `agent failed to start ... ECONNREFUSED 127.0.0.1:4000` | Backend was restarting (usually after `pnpm build`): `stack.sh restart agent` |
| Driver: `err wait-for: locator.waitFor: Timeout 15000ms exceeded` after an `Approve` click | The click hit a different row; scope with `tr:has-text("<file>") >>` and look at the screenshot |
| `browserType.launch: Target page, context or browser has been closed` | Chromium libs missing — the `apt-get download` / `dpkg-deb -x` step |
| `node: command not found` (or `pnpm`, `psql`) | The Prerequisites `export` lines weren't in this tool call |
| Driver `err wait-for: ... Timeout` although the screenshot shows the text | `text=` matched a hidden `<option>`/element; use `td:has-text("...")` |

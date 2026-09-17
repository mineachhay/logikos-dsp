# logikos-dsp native agent

A Go rewrite of `packages/agent`'s `SOURCE_TYPE=local` mode — same wire
contract (`GET/POST` shapes match `packages/backend`'s ingest routes
exactly, see `internal/wire`), same observable behavior (debounce window,
content-sampling rule, quarantine-dir exclusion), but a single static
binary with no Node.js runtime. SMB, Microsoft 365, and Google Drive
watching are **not** reimplemented here — those stay on the TypeScript
agent; this is specifically the low-footprint local-path rewrite
`ARCHITECTURE.md`'s "Design decisions" section named as v0's deferred cost.

**Scope note:** the original ambition was a Windows service reading the
NTFS USN journal directly. This uses `fsnotify` instead (inotify on Linux,
`ReadDirectoryChangesW` on Windows) — still native and pollless, but not
the USN journal specifically. See the doc comment at the top of
`cmd/agent/main.go` for why, in full. Short version: USN journal parsing is
real systems-programming risk on a production file server's boot volume,
and there's no Windows machine available anywhere in this project's history
to test it against.

**What's actually verified:** the Linux/inotify path, live, against a real
running backend — register, file create/modify/delete detection, storage
snapshots, the full classification pipeline (a test file with fake SSN/
email/name content produced a real alert), and the quarantine approve →
execute round trip. The Windows/`ReadDirectoryChangesW` path only
cross-compiles (`GOOS=windows go build`) — it has never run on a real
Windows machine.

## Build

```bash
export PATH="$HOME/.local/go/bin:$PATH"   # if Go isn't already on PATH
go build -o agent ./cmd/agent             # native (Linux here)
GOOS=windows GOARCH=amd64 go build -o agent.exe ./cmd/agent   # cross-compile
```

No CGO, no external runtime — the output is a single ~9MB binary.

## Run

Same environment variables as `packages/agent`'s local mode:

```bash
WATCH_PATH=/path/to/watch BACKEND_URL=http://localhost:4000 AGENT_ENROLL_TOKEN=... ./agent
```

`AGENT_ENROLL_TOKEN` is required and must match the backend's. The agent
registers with it, then authenticates with the per-agent secret the backend
returns, re-registering by itself on a 401 — same rules as the TypeScript
agent (`packages/agent/src/agentSession.ts`).

Optional: `AGENT_KEY` (override the derived key — see `internal/config`'s
`deriveKey` doc comment for why the default matches the TypeScript agent's
formula), `STORAGE_SCAN_INTERVAL_MS` (default 60000),
`QUARANTINE_POLL_INTERVAL_MS` (default 10000).

## Test

```bash
go test ./...
```

`internal/client` tests the credential handling (rotation, concurrent 401s,
throttling, revoked agents) against an `httptest` fake backend. Otherwise
covers the same pure-logic cases `packages/agent`'s test suite does
(`isSampleable`, `computeQuarantinePath`) — mirrored 1:1 so both
implementations are provably consistent on filename/sampling decisions.
Not covered by automated tests (same boundary the TypeScript agent draws):
the actual `fsnotify` event handling — that's what got live-verified
against a real backend instead (see above).

## Running on a workstation, to see where files are copied *to*

A file server only ever learns that its file was **read** — where the bytes
went is known solely to the machine that received them. Run this agent on that
machine, watching the folders people copy into, and logikos-dsp joins the two
halves: a file appearing here, seconds after the same file was read from a
share, is recorded as one `COPIED` event naming both ends and the person.

Configure it with an `agent.json` sitting next to the executable — an
installer can write that file, and an administrator can read it, neither of
which is true of environment variables under a service account:

```json
{
  "serverUrl": "https://dsp.example.com/api",
  "connectIp": "20.20.0.92",
  "caCertFile": "cloudflare-origin-ca.pem",
  "enrollToken": "<the same token the server uses>",
  "watchPath": "C:\\Users\\jdoe\\Downloads"
}
```

Then just `.\agent.exe`. Only `enrollToken` and `watchPath` are required.

**`serverUrl` keeps the hostname even when the server is on your LAN.**
`connectIp` changes the address dialled, not the name verified — so TLS still
checks the certificate against `serverUrl`'s hostname. That combination is what
lets a workstation reach a server sitting beside it instead of sending every
file event out to a CDN and back. Putting an IP in `serverUrl` does not work:
origin certificates carry DNS names, so `https://<ip>/` fails hostname
verification, and nginx routes by `server_name`, so a bare IP lands on whichever
vhost happens to be first.

**`caCertFile` trusts a private CA in addition to the system roots** — needed
when the origin's certificate is issued by one Windows doesn't know, such as
Cloudflare's Origin CA. Relative paths resolve next to `agent.json`, which
matters because a Windows service's working directory is `C:\Windows\System32`.
Trust is only ever added, never relaxed; there is deliberately no option to skip
certificate verification.

Every setting can also come from the environment — `BACKEND_URL`,
`AGENT_ENROLL_TOKEN`, `WATCH_PATH`, `BACKEND_CONNECT_IP`, `BACKEND_CA_CERT_FILE`
— and **the environment wins over the file**, so one setting can be overridden
for a single debugging run without editing the installed config. With no file at
all the agent behaves exactly as it always has, which is how it runs under
docker-compose. `AGENT_CONFIG_FILE` moves the file somewhere else.

### Installing it as a service

One file, one command, from an elevated PowerShell or cmd. Nothing else needs
to be copied to the machine and nothing needs editing:

```powershell
.\agent.exe install -server "https://dsp.example.com/api" -ip "20.20.0.92" `
                    -token "<enroll token>" -watch "C:\Users\jdoe\Downloads" `
                    -ca cloudflare-origin
```

That copies itself to `C:\Program Files\logikos-dsp-agent`, writes `agent.json`
restricted to Administrators and SYSTEM, writes the CA, registers the service
and starts it. It is the same command for the fiftieth machine as the first, so
a deployment tool, a GPO startup script or Intune can run it unattended.

- `-ip` is optional, and is how a workstation reaches a server on its own
  network rather than resolving a public name — see above.
- `-ca cloudflare-origin` uses the Cloudflare Origin CA built into the binary.
  Any other private CA: give `-ca` a path to a PEM file, which is copied in.
  Omit it entirely when the server's certificate is publicly trusted.
- `-dir` installs somewhere other than Program Files.
- With no options at all, `install` uses whatever `agent.json` sits beside the
  executable — useful when a config was prepared by hand.

Managing it afterwards:

```powershell
agent.exe status        # installed? running?
agent.exe stop | start
agent.exe uninstall
```

The service runs as LocalSystem (watching another user's profile needs more
than that user's own rights), starts automatically, and restarts itself after
30s, 60s and 120s if it fails — an agent nobody knows has stopped is worse
than no agent, because the dashboard just shows no copies. Having no console,
it logs to `agent.log` beside the executable and reports start, stop and
configuration errors to the Windows event log.

**Two things deliberately avoided.** Don't use `sc.exe create` on this binary:
Windows expects a service to report status to the SCM within ~30 seconds, and
a plain console program registered that way looks installed and dies with
error 1053. And there is no PowerShell installer — one existed briefly and
broke on a real machine three ways at once (execution policy, the
mark-of-the-web on a copied file, and Windows PowerShell 5.1 reading a UTF-8
script as ANSI, which turned an em dash into a parse error). A single
executable has none of those failure modes.

Notes:

- **One watch path per agent process.** Watching several folders means several
  services, or one agent per user profile root.
- **Each machine becomes its own source** in the dashboard, named by its watch
  path, so its events are separate from the share's.
- **The enroll token is a deployment-wide secret**, and `agent.json` holds it in
  plaintext on every machine. Anyone with local administrator rights there can
  read it and register or impersonate agents. Acceptable for a handful of
  servers; before rolling this out to many workstations, per-machine enrollment
  tokens are the fix. Revoking a machine is a click on the Agents page.
- Copies to a machine with no agent — an unmanaged laptop, a USB stick — still
  show only as reads on the share, plus the bulk-read alert.

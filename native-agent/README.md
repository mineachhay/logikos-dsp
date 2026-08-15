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
WATCH_PATH=/path/to/watch BACKEND_URL=http://localhost:4000 ./agent
```

Optional: `AGENT_KEY` (override the derived key — see `internal/config`'s
`deriveKey` doc comment for why the default matches the TypeScript agent's
formula), `STORAGE_SCAN_INTERVAL_MS` (default 60000),
`QUARANTINE_POLL_INTERVAL_MS` (default 10000).

## Test

```bash
go test ./...
```

Covers the same pure-logic cases `packages/agent`'s test suite does
(`isSampleable`, `computeQuarantinePath`) — mirrored 1:1 so both
implementations are provably consistent on filename/sampling decisions.
Not covered by automated tests (same boundary the TypeScript agent draws):
the actual `fsnotify` event handling — that's what got live-verified
against a real backend instead (see above).

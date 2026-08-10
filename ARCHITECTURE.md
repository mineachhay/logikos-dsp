# Architecture

## Goal

Replace the core workflows of ManageEngine DataSecurity Plus:

1. **File Audit / FIM** — who touched what file, when, from where.
2. **Data Risk Assessment (DRA)** — where is sensitive data (PII/PCI/PHI-shaped content) sitting, and is it over-exposed.
3. **Ransomware / anomaly detection** — spot mass-encryption/mass-delete behavior fast and raise an alert.
4. **Disk/storage analysis** — track storage growth and usage per share/path over time.

## Design decisions

**All TypeScript for v0, not Go/Rust for the agent.** DSP's real agent needs to run as a low-footprint Windows service reading the NTFS USN journal, which argues for Go or Rust in production. This dev environment doesn't have a Go toolchain, and the priority right now is proving the end-to-end pipeline (event → rule → alert → dashboard) rather than agent footprint. The agent package is isolated behind a plain HTTP ingest contract specifically so it can be rewritten in Go/Rust later without touching the backend, classification worker, or dashboard — only `packages/agent` changes.

**Postgres only, no Kafka/Elasticsearch yet.** Event volume at pilot scale (a handful of watched paths) fits comfortably in a well-indexed Postgres table partitioned by day. Introducing a stream broker or search cluster before there's a concrete scale/query problem would be premature — revisit if/when: (a) ingest volume needs durable buffering across backend restarts, or (b) full-text/fuzzy search across audit history becomes a product requirement.

**Rules run inline in the backend, not a separate stream processor.** The ransomware/anomaly rule (event-rate-per-agent-per-minute) is cheap enough to evaluate synchronously on ingest. A dedicated stream-processing layer (Flink/ksqlDB-style) is overkill until rules get materially more complex (cross-path correlation, ML-based baselining).

**Classification is a separate worker, not inline on ingest.** Content scanning (reading file bytes, running pattern/format checks) is I/O- and CPU-heavier and shouldn't block the hot ingest path. It polls a `ClassificationJob` queue backed by Postgres (`pg-boss`-style `FOR UPDATE SKIP LOCKED`), which avoids standing up Redis/RabbitMQ for v0 while still being safe for multiple workers.

**Storage analysis piggybacks on the agent.** Rather than a separate crawler, the agent periodically walks its watched root and reports aggregate size/file-count snapshots — same transport, same auth, no new component.

**Storage sources are pluggable behind a `Source` interface, each free to use its own detection strategy.** `packages/agent/src/sources/types.ts` defines `Source` (`describe()`, `listTree()`, `readSample()`). Local paths (`packages/agent/src/watcher.ts`) use `chokidar` for real-time OS filesystem events, unchanged since v0. SMB/network shares (`packages/agent/src/sources/smb.ts`) instead use **periodic snapshot diffing** (`packages/agent/src/snapshotDiff.ts`): walk the share on an interval, diff against the previous walk's `{size, mtime}` map, synthesize created/modified/deleted events. This was a deliberate choice over mounting the share locally and reusing chokidar — CIFS/NFS client mounts don't reliably propagate inotify events for remote-side changes, so a "real-time" mount-based watcher can silently miss changes. The tradeoff is detection latency bounded by the scan interval (`SMB_SCAN_INTERVAL_MS`, default 30s) instead of true real-time, and — same limitation chokidar already has for local paths — no reliable rename or permission-change detection (a move shows up as delete+create). One walk serves both FIM events and the storage snapshot for SMB sources, since the tree walk already has full size/count data; local mode still does these separately (chokidar has no "list everything" step to piggyback on).

This required **no backend or dashboard changes** — `Agent.watchedRoot`, `FileEvent.path`, and `StorageSnapshot.rootPath` were already unconstrained strings, so an SMB agent just registers with `watchedRoot: "smb://host/share/sub"` and everything downstream works unchanged. Confirms the v0 bet on isolating the agent behind a plain HTTP contract.

**SMB client: `v9u-smb2`, not the more well-known `@marsaud/smb2` it forks — verified the hard way.** Both are pure-JS SMB2/3 clients (no OS-level `mount -t cifs`, no root/CAP_SYS_ADMIN needed — works from a container), and both self-describe as "experimental." `@marsaud/smb2` was tried first and rejected: it bundles the `ntlm` package, which only ever speaks NTLMv1 (confirmed by reading its source — no HMAC-MD5/NTLMv2 code at all) and reliably failed `STATUS_LOGON_FAILURE` against this project's test Samba container even with NTLMv1 explicitly permitted server-side. `v9u-smb2` swaps that dependency for `ntlm2`, which implements real NTLMv2, and connects successfully. Both libraries still hash the legacy LM response via DES-ECB and the NT hash via MD4 — algorithms OpenSSL 3's default provider disables — so **the agent process requires `NODE_OPTIONS=--openssl-legacy-provider` whenever `SOURCE_TYPE=smb`** (see README). Separately, the shipped `index.d.ts` doesn't resolve cleanly as a default export under this project's `moduleResolution: NodeNext`, and omits `size` from stat results even though the underlying implementation always sets it (verified by reading `lib/tools/stats.js`). `sources/smb.ts` works around both by loading the package via `createRequire` and declaring only the surface it actually uses, checked against the real implementation — rather than fighting the package's types. If `v9u-smb2` itself proves unreliable in practice, the next fallback is shelling out to the `smbclient` CLI, not pursued since NTLMv2 auth is now working.

## Data flow

```
 watched filesystem
        |
        v
   [agent]  --(FileEvent)-->  POST /ingest/events  --> [backend] --> Postgres (file_event)
        |                                                  |
        |--(StorageSnapshot, periodic)-->  POST /ingest/storage        |-- rate rule --> alert (Postgres)
                                                                        |
                                                        [classification worker] <-- polls classification_job
                                                                        |
                                                                        v
                                                        classification_match (+ alert if sensitive)

                                        [dashboard] <--REST--> [backend]  (events, alerts, storage trends, matches)
```

## Core entities (Prisma schema, `packages/backend/prisma/schema.prisma`)

- `Agent` — a registered watcher (host + watched root).
- `FileEvent` — one filesystem event (create/modify/delete/rename/permission_change) from an agent.
- `StorageSnapshot` — periodic size/file-count rollup for an agent's watched root.
- `ClassificationJob` — queued "scan this file" work item, created on file create/modify events.
- `ClassificationMatch` — a sensitivity-pattern hit (type: SSN/credit-card/email/etc, with a redacted sample) for a file.
- `Alert` — a raised alert (ransomware-rate, sensitive-data-exposed, ...), with severity and status.

## What's deliberately out of scope for v0

- Auth/RBAC beyond a single shared API key (multi-tenant auth is a real feature, not a scaffolding detail).
- Cloud storage connectors (Google Drive, OneDrive/SharePoint) — needs real OAuth app credentials against a live tenant to build/test against, not available in this environment. SMB/network shares are covered (see above).
- ML-based classification (regex/format-validator rules only: SSN, credit card w/ Luhn check, email, phone).
- Automated response actions (disabling shares, killing processes) — DSP does this; it's high-blast-radius and needs its own design/review pass before being wired up.

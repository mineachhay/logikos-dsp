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

**Classification runs a regex pass and a local NER pass, not just one or the other.** `packages/classification/src/patterns.ts` (unchanged) catches structured data — SSN, Luhn-checked credit card, email, phone. `packages/classification/src/ner.ts` adds unstructured detection — person names, organizations, locations — via a local named-entity-recognition model (`@huggingface/transformers` running `Xenova/bert-base-NER`, CoNLL entity types PER/ORG/LOC; MISC is dropped as too broad to be a useful signal). **Local was a deliberate choice over calling a cloud LLM API**: a data-security product routing the content it's protecting through a third-party API to classify it would undermine its own purpose, and would be a real compliance problem for actual PII/PHI. "Local" means inference — the part that touches file content — never leaves the machine via ONNX Runtime/WASM. Model *weights* (~100MB, cached under `packages/classification/.cache/`, gitignored) download once from Hugging Face Hub on first run; that's a one-time setup step comparable to `docker pull`, not an ongoing data path, but worth being explicit about so "local model" isn't misread as "no internet, ever." The model loads once at worker startup (`preloadNerModel()`, before the poll loop begins) rather than per job, so a broken load fails loudly at boot instead of silently mid-job, and the first real classification job isn't stuck paying multi-second load latency. Matches below a confidence threshold (0.85) are dropped — BERT NER can misfire on short/lowercase tokens. **Known v1 tradeoff, not yet solved**: NER inference runs sequentially per job like the regex pass, and is meaningfully slower (seconds, not microseconds) — this will visibly reduce worker throughput under load; batching/concurrency is a natural follow-up once that's a real bottleneck rather than a hypothetical one.

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
- `User` — a dashboard login (`email`, `passwordHash`, `role`). Unrelated to `Agent`, see below.

## Auth/RBAC

**Two identity systems, deliberately kept separate.** `Agent.key` authenticates *machines* (agent processes calling `POST /agents/register`, `POST /ingest/events`, `POST /ingest/storage`) and was never touched by this feature. `User` + a cookie-based JWT authenticates *people* using the dashboard, gating every other endpoint (`/events`, `/alerts`, `/storage`, `/classification-*`, `/agents` GET, `/users`). Mixing these would mean either forcing unattended agent processes to hold a user session (no such user exists) or weakening the dashboard's auth to match agents' simple shared-secret model — neither is right, so the two stay on completely separate code paths. In `packages/backend/src/index.ts`, agent-facing routes are registered with a comment marking them as never-gated; dashboard-facing route files each self-gate via `app.addHook("onRequest", app.authenticate)`.

**Cookie-based JWT, not a session table.** Consistent with the "Postgres only, no extra infra" stance below: a signed JWT in an httpOnly cookie (`@fastify/jwt` + `@fastify/cookie`) needs no session store, while still being safe against XSS token theft (unlike JWT-in-localStorage). No refresh-token flow in v1 — a user just logs in again after the token expires; revisit if session lifetime becomes a real complaint.

**Two roles: `ADMIN` and `VIEWER`.** ADMIN can do everything, including managing users and acknowledging/resolving alerts (`PATCH /alerts/:id` requires it); VIEWER is read-only. A finer-grained role (e.g. can-acknowledge-but-not-manage-users) is a natural v2 addition once there's a real need for it.

**`@fastify/jwt`/`@fastify/cookie` are pinned to their last Fastify-4-compatible majors** (`8.0.1` / `9.4.0`) — their current majors (10.x / 11.x) require Fastify 5, which this project isn't on. Bumping Fastify itself would be the right way to pick up newer versions, not a piecemeal plugin upgrade.

**Bootstrap admin via a seed script, not auto-creation.** `packages/backend/prisma/seed.ts` creates one `ADMIN` from `ADMIN_EMAIL`/`ADMIN_PASSWORD` env vars if no `User` rows exist yet (`pnpm db:seed`) — explicit and scriptable, rather than a magic first-run behavior that's easy to trigger by accident.

## What's deliberately out of scope for v0

- Cloud storage connectors (Google Drive, OneDrive/SharePoint) — needs real OAuth app credentials against a live tenant to build/test against, not available in this environment. SMB/network shares are covered (see above).
- Automated response actions (disabling shares, killing processes) — DSP does this; it's high-blast-radius and needs its own design/review pass before being wired up.

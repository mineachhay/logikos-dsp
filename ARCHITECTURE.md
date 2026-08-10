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
- Real NAS/SMB/cloud storage connectors (agent watches a local/mounted path only).
- ML-based classification (regex/format-validator rules only: SSN, credit card w/ Luhn check, email, phone).
- Automated response actions (disabling shares, killing processes) — DSP does this; it's high-blast-radius and needs its own design/review pass before being wired up.

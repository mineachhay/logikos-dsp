#!/usr/bin/env bash
#
# Postgres backup for logikos-dsp.
#
# Everything the product knows lives in one Postgres database — file events,
# alerts, classification matches, response actions and the user table. The
# NER model cache and the built images are reproducible; this is not.
#
# pg_dump runs INSIDE the postgres container on purpose: pg_dump refuses to
# dump from a server newer than itself, and the container image is the only
# place a matching client version is guaranteed to exist. It also means this
# script needs no postgres-client install on the host.
#
# Custom format (-Fc) rather than plain SQL: it is compressed already, and it
# restores with pg_restore, which can run in parallel and can restore a subset
# of tables. Plain SQL would need a separate gzip and gives less control.
#
# Usage:
#   deploy/backup.sh                 # write a new dump, prune old ones
#   BACKUP_DIR=/mnt/nas deploy/backup.sh
#
# Restore: see README "Backup and restore".

set -euo pipefail

CONTAINER="${CONTAINER:-logikos-dsp-postgres-1}"
PGUSER_="${PGUSER_:-logikos}"
DB="${DB:-logikos_dsp}"
BACKUP_DIR="${BACKUP_DIR:-/home/ubnt/backups/logikos-dsp}"
KEEP="${KEEP:-30}"

stamp="$(date -u +%Y%m%dT%H%M%SZ)"
dest="${BACKUP_DIR}/${DB}-${stamp}.dump"

log() { echo "[$(date -u +%Y-%m-%dT%H:%M:%SZ)] $*"; }

mkdir -p "$BACKUP_DIR"

if ! docker inspect -f '{{.State.Running}}' "$CONTAINER" 2>/dev/null | grep -q true; then
  log "ERROR: container $CONTAINER is not running — no backup taken"
  exit 1
fi

log "dumping $DB from $CONTAINER"
# Write to a .partial name first so an interrupted run can never leave a
# truncated file that looks like a good backup to the pruning step below.
if ! docker exec "$CONTAINER" pg_dump -U "$PGUSER_" -d "$DB" -Fc > "${dest}.partial"; then
  log "ERROR: pg_dump failed"
  rm -f "${dest}.partial"
  exit 1
fi

# Verify the dump is actually readable before trusting it. A dump that cannot
# be listed cannot be restored, and finding that out at restore time is the
# classic way a backup story turns out to be fiction.
if ! docker exec -i "$CONTAINER" pg_restore --list > /dev/null < "${dest}.partial"; then
  log "ERROR: dump failed verification (pg_restore --list) — discarding"
  rm -f "${dest}.partial"
  exit 1
fi

mv "${dest}.partial" "$dest"
log "wrote $dest ($(du -h "$dest" | cut -f1))"

# Prune: keep the newest $KEEP dumps.
mapfile -t old < <(ls -1t "${BACKUP_DIR}/${DB}-"*.dump 2>/dev/null | tail -n "+$((KEEP + 1))")
if [ "${#old[@]}" -gt 0 ]; then
  for f in "${old[@]}"; do
    log "pruning $(basename "$f")"
    rm -f "$f"
  done
fi

log "done — $(ls -1 "${BACKUP_DIR}/${DB}-"*.dump 2>/dev/null | wc -l) dump(s) retained"

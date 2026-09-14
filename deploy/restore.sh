#!/usr/bin/env bash
#
# Restore a logikos-dsp Postgres dump produced by deploy/backup.sh.
#
# Two modes, because the two things you actually want are different:
#
#   verify  (default) — restore into a throwaway database and compare it to
#                       the live one, then drop it. Touches nothing real.
#                       Run this periodically: an untested backup is a guess.
#   live              — restore OVER the live database. Destructive, and
#                       refuses to run unless you pass --yes.
#
# Usage:
#   deploy/restore.sh verify [dump]
#   deploy/restore.sh live --yes [dump]
#
# With no dump path, the newest dump in BACKUP_DIR is used.
#
# The backend and classification worker hold open connections and will fight a
# live restore, so `live` stops them first and starts them again afterwards.

set -euo pipefail

CONTAINER="${CONTAINER:-logikos-dsp-postgres-1}"
PGUSER_="${PGUSER_:-logikos}"
DB="${DB:-logikos_dsp}"
BACKUP_DIR="${BACKUP_DIR:-/home/ubnt/backups/logikos-dsp}"
COMPOSE_DIR="${COMPOSE_DIR:-$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)}"

mode="${1:-verify}"
shift || true

confirm=""
dump=""
for arg in "$@"; do
  case "$arg" in
    --yes) confirm=yes ;;
    *) dump="$arg" ;;
  esac
done

[ -n "$dump" ] || dump="$(ls -1t "${BACKUP_DIR}/${DB}-"*.dump 2>/dev/null | head -1 || true)"
[ -n "$dump" ] || { echo "ERROR: no dump found in $BACKUP_DIR"; exit 1; }
[ -f "$dump" ] || { echo "ERROR: no such dump: $dump"; exit 1; }

psql_() { docker exec "$CONTAINER" psql -U "$PGUSER_" "$@"; }
counts() {
  psql_ -d "$1" -t -c \
    "SELECT 'User='||count(*) FROM \"User\" UNION ALL SELECT 'Agent='||count(*) FROM \"Agent\"
     UNION ALL SELECT 'Alert='||count(*) FROM \"Alert\" UNION ALL SELECT 'FileEvent='||count(*) FROM \"FileEvent\";" \
    | tr -d ' ' | grep . | sort
}

echo "dump: $dump"

case "$mode" in
  verify)
    scratch="${DB}_restore_check"
    psql_ -d postgres -c "DROP DATABASE IF EXISTS ${scratch};" >/dev/null
    psql_ -d postgres -c "CREATE DATABASE ${scratch};" >/dev/null
    docker exec -i "$CONTAINER" pg_restore -U "$PGUSER_" -d "$scratch" --no-owner < "$dump"

    echo "--- restored ---"; counts "$scratch"
    echo "--- live ---";     counts "$DB"
    tables=$(psql_ -d "$scratch" -t -c \
      "SELECT count(*) FROM information_schema.tables WHERE table_schema='public';" | xargs)
    echo "tables restored: $tables"

    psql_ -d postgres -c "DROP DATABASE ${scratch};" >/dev/null
    echo "OK — dump is restorable (scratch database dropped)"
    ;;

  live)
    [ "$confirm" = yes ] || {
      echo "REFUSING: 'live' overwrites $DB. Re-run with --yes if that is what you want."
      exit 1
    }
    echo "stopping services that hold connections..."
    (cd "$COMPOSE_DIR" && docker compose stop backend classification agent >/dev/null 2>&1 || true)

    psql_ -d postgres -c "DROP DATABASE IF EXISTS ${DB};"
    psql_ -d postgres -c "CREATE DATABASE ${DB};"
    docker exec -i "$CONTAINER" pg_restore -U "$PGUSER_" -d "$DB" --no-owner < "$dump"

    echo "--- restored ---"; counts "$DB"
    (cd "$COMPOSE_DIR" && docker compose start backend classification agent >/dev/null)
    # The agent registers only at startup, so if the Agent row changed under it
    # the running process would ingest against a key the server no longer knows.
    echo "OK — services restarted. Check: docker compose logs --since 60s agent"
    ;;

  *)
    echo "usage: $0 [verify|live --yes] [dump]"; exit 1 ;;
esac

#!/usr/bin/env bash
# Start/stop the logikos-dsp dev stack as background process groups.
#
#   stack.sh up [svc...]       start postgres + backend, agent, classification, dashboard (default: all)
#   stack.sh down [svc...]     stop them (postgres is left running unless named: `down postgres`)
#   stack.sh restart <svc...>
#   stack.sh status
#
# Each service runs under `setsid` with its PID in /tmp/logikos-dsp/<svc>.pid and its
# log in /tmp/<svc>.log, so `down` kills the whole process group (pnpm -> sh -> tsx
# watch -> node) by PID. No pkill -f: see SKILL.md Gotchas for why.
#
# Postgres: uses whatever already answers on localhost:5432 (e.g. `pnpm db:up` where
# Docker exists); otherwise starts the userspace install in ~/.local/pg + ~/.local/pgdata
# (SKILL.md Prerequisites). WATCH_PATH defaults to /tmp/logikos-watch.
set -u
cd "$(dirname "$0")/../../.." || exit 1          # repo root
export PATH="$HOME/.local/node/bin:$HOME/.local/go/bin:$PATH"
RUN=/tmp/logikos-dsp; mkdir -p "$RUN"
WATCH_PATH=${WATCH_PATH:-/tmp/logikos-watch}
PGBIN=$HOME/.local/pg/usr/lib/postgresql/16/bin
PGLIB=$HOME/.local/pg/usr/lib/x86_64-linux-gnu
PGDATA=$HOME/.local/pgdata
ALL="backend agent classification dashboard"

alive() { [ -f "$RUN/$1.pid" ] && kill -0 "$(cat "$RUN/$1.pid")" 2>/dev/null; }
pg_up() { (exec 3<>/dev/tcp/127.0.0.1/5432) 2>/dev/null; }

start_pg() {
  pg_up && { echo "postgres: already up on :5432"; return; }
  [ -x "$PGBIN/pg_ctl" ] || { echo "postgres: nothing on :5432 and no $PGBIN — run 'pnpm db:up' or see SKILL.md"; return 1; }
  LD_LIBRARY_PATH=$PGLIB "$PGBIN/pg_ctl" -D "$PGDATA" -l "$PGDATA/server.log" -w start >/dev/null \
    && echo "postgres: started" || { tail -5 "$PGDATA/server.log"; return 1; }
}

wait_until() {  # <seconds> <cmd...>
  local t=$1; shift
  for _ in $(seq 1 "$t"); do "$@" && return 0; sleep 1; done
  return 1
}

start() {
  local svc=$1 log=/tmp/$1.log
  if alive "$svc"; then echo "$svc: already running (pid $(cat "$RUN/$svc.pid"))"; return; fi
  case $svc in
    agent)
      mkdir -p "$WATCH_PATH"
      local tok; tok=$(grep ^AGENT_ENROLL_TOKEN packages/backend/.env | cut -d= -f2- | tr -d '"')
      AGENT_ENROLL_TOKEN=$tok WATCH_PATH=$WATCH_PATH BACKEND_URL=${BACKEND_URL:-http://localhost:4000} \
        setsid pnpm --filter @logikos-dsp/agent dev >"$log" 2>&1 < /dev/null &
      ;;
    *) setsid pnpm --filter "@logikos-dsp/$svc" dev >"$log" 2>&1 < /dev/null & ;;
  esac
  echo $! >"$RUN/$svc.pid"
  local ok=0
  case $svc in
    backend)        wait_until 60  curl -sf http://localhost:4000/health -o /dev/null && ok=1 ;;
    dashboard)      wait_until 60  curl -sf http://localhost:5173 -o /dev/null && ok=1 ;;
    agent)          wait_until 30  grep -q "registered agent" "$log" && ok=1 ;;
    classification) wait_until 180 grep -q "polling every" "$log" && ok=1 ;;
  esac
  if [ $ok = 1 ]; then echo "$svc: up (log $log)"; else echo "$svc: NOT READY — tail of $log:"; tail -15 "$log"; fi
}

stop() {
  local svc=$1
  if [ "$svc" = postgres ]; then
    LD_LIBRARY_PATH=$PGLIB "$PGBIN/pg_ctl" -D "$PGDATA" stop 2>/dev/null || echo "postgres: not ours to stop"; return
  fi
  if alive "$svc"; then kill -- "-$(cat "$RUN/$svc.pid")" 2>/dev/null; echo "$svc: stopped"; else echo "$svc: not running"; fi
  rm -f "$RUN/$svc.pid"
}

cmd=${1:-status}; shift || true
svcs=${*:-$ALL}
case $cmd in
  up)      start_pg || exit 1; for s in $svcs; do [ "$s" = postgres ] || start "$s"; done ;;
  down)    for s in $svcs; do stop "$s"; done ;;
  restart) for s in $svcs; do stop "$s"; done; sleep 1; for s in $svcs; do start "$s"; done ;;
  status)
    pg_up && echo "postgres: up" || echo "postgres: down"
    for s in $ALL; do alive "$s" && echo "$s: running (pid $(cat "$RUN/$s.pid"))" || echo "$s: stopped"; done ;;
  *) sed -n '2,8p' "$0"; exit 2 ;;
esac

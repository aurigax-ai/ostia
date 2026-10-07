#!/usr/bin/env bash
set -uo pipefail

attempts=${RETRY_ATTEMPTS:-4}
delay=${RETRY_DELAY:-10}
limit=${RETRY_TIMEOUT:-300}

run_once() {
  local marker
  marker=$(mktemp)
  rm -f "$marker"
  "$@" &
  local pid=$!
  (
    trap 'pkill -P "$BASHPID" 2>/dev/null; exit 0' TERM
    sleep "$limit" &
    wait $!
    touch "$marker"
    kill -TERM "$pid" 2>/dev/null
    sleep 10 &
    wait $!
    kill -KILL "$pid" 2>/dev/null
  ) >/dev/null 2>&1 &
  local watchdog=$!
  wait "$pid"
  local status=$?
  kill -TERM "$watchdog" 2>/dev/null
  wait "$watchdog" 2>/dev/null
  if [ -e "$marker" ]; then
    rm -f "$marker"
    echo "retry: '$*' timed out after ${limit}s" >&2
    return 124
  fi
  return "$status"
}

for ((attempt = 1; ; attempt++)); do
  run_once "$@"
  status=$?
  if [ "$status" -eq 0 ] || [ "$attempt" -ge "$attempts" ]; then
    exit "$status"
  fi
  echo "retry: '$*' exited $status (attempt $attempt of $attempts), trying again in ${delay}s" >&2
  sleep "$delay"
  delay=$((delay * 2))
done

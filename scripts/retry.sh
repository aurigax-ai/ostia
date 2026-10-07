#!/usr/bin/env bash
set -uo pipefail

attempts=${RETRY_ATTEMPTS:-4}
delay=${RETRY_DELAY:-10}

for ((attempt = 1; ; attempt++)); do
  "$@"
  status=$?
  if [ "$status" -eq 0 ] || [ "$attempt" -ge "$attempts" ]; then
    exit "$status"
  fi
  echo "retry: '$*' exited $status (attempt $attempt of $attempts), trying again in ${delay}s" >&2
  sleep "$delay"
  delay=$((delay * 2))
done

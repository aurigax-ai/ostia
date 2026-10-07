#!/usr/bin/env bash
set -euo pipefail

if [ "${OSTIA_E2E_VISIBLE:-}" = "1" ] || [ "$(uname -s)" = "Darwin" ]; then
  exec playwright test "$@"
fi

if ! command -v Xvfb >/dev/null; then
  echo "e2e: Xvfb not found; windows will open on your desktop." >&2
  echo "e2e: install it with: sudo pacman -S --needed xorg-server-xvfb" >&2
  exec playwright test "$@"
fi

display_file=$(mktemp)
Xvfb -displayfd 3 -screen 0 1600x1000x24 -nolisten tcp 3>"$display_file" 2>/dev/null &
xvfb_pid=$!
trap 'kill "$xvfb_pid" 2>/dev/null || true; rm -f "$display_file"' EXIT

until [ -s "$display_file" ]; do
  if ! kill -0 "$xvfb_pid" 2>/dev/null; then
    echo "e2e: Xvfb exited before it named a display." >&2
    exit 1
  fi
  sleep 0.05
done

DISPLAY=":$(cat "$display_file")" env -u WAYLAND_DISPLAY -u XDG_SESSION_TYPE \
  -u VK_LOADER_DRIVERS_SELECT -u VK_LOADER_DRIVERS_DISABLE playwright test "$@"

#!/usr/bin/env bash
set -euo pipefail

if [ "${PINE_E2E_VISIBLE:-}" != "1" ] && command -v xvfb-run >/dev/null; then
  exec xvfb-run -a -s '-screen 0 1600x1000x24' env -u WAYLAND_DISPLAY playwright test "$@"
fi

if [ "${PINE_E2E_VISIBLE:-}" != "1" ]; then
  echo "e2e: xvfb-run not found; windows will open on your desktop." >&2
  echo "e2e: install it with: sudo pacman -S --needed xorg-server-xvfb" >&2
fi
exec playwright test "$@"

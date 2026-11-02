#!/bin/sh
set -eu
here=$(cd "$(dirname "$0")/.." && pwd)
bin=${SPIKE_BIN:-$here/target/release/spike-cef}
out=${SPIKE_OUT:-/tmp/spike-cef-out}
xdg=/tmp/spike-xdg
mkdir -p "$out" "$xdg"
chmod 700 "$xdg"
export SPIKE_URL=${SPIKE_URL:-file://$here/fixtures/page.html} SPIKE_PAGES=${SPIKE_PAGES:-1} SPIKE_RUN_SECS=${SPIKE_RUN_SECS:-20}
export SPIKE_CEF_SWITCHES=${SPIKE_CEF_SWITCHES:-ozone-platform=wayland}
env -u DISPLAY -u WAYLAND_DISPLAY XDG_RUNTIME_DIR=$xdg dbus-run-session -- sh -c '
  mutter --headless --wayland --no-x11 --virtual-monitor 1280x800 --wayland-display=wl-spike >"$1/mutter.log" 2>&1 &
  comp=$!
  sleep 3
  WAYLAND_DISPLAY=wl-spike XDG_SESSION_TYPE=wayland "$0" 2>"$1/stderr-wayland.log" &
  app=$!
  python3 -I "$2/scripts/sample.py" "$app" "$1/sample-wayland.csv" &
  sampler=$!
  wait "$app" || true
  kill "$sampler" "$comp" 2>/dev/null || true
' "$bin" "$out" "$here"

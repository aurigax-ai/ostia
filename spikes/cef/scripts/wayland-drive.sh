#!/bin/sh
set -eu
here=$(cd "$(dirname "$0")/.." && pwd)
bin=${SPIKE_BIN:-$here/target/release/spike-cef}
out=${SPIKE_OUT:-/tmp/spike-cef-out}
xdg=/tmp/spike-xdg
mkdir -p "$out" "$xdg"
chmod 700 "$xdg"
export SPIKE_URL=${SPIKE_URL:-file://$here/fixtures/page.html} SPIKE_PAGES=1 SPIKE_RUN_SECS=${SPIKE_RUN_SECS:-34}
export SPIKE_CEF_SWITCHES=${SPIKE_CEF_SWITCHES:-ozone-platform=wayland}
env -u DISPLAY -u WAYLAND_DISPLAY XDG_RUNTIME_DIR=$xdg dbus-run-session -- sh -c '
  pipewire >"$1/pipewire.log" 2>&1 &
  pw=$!
  wireplumber >"$1/wireplumber.log" 2>&1 &
  wp=$!
  mutter --headless --wayland --no-x11 --virtual-monitor 1280x800 --wayland-display=wl-spike >"$1/mutter.log" 2>&1 &
  comp=$!
  sleep 3
  WAYLAND_DISPLAY=wl-spike XDG_SESSION_TYPE=wayland "$0" 2>"$1/stderr-wldrive.log" &
  app=$!
  python3 -I "$2/scripts/wayland-drive.py" "$1" 12 >"$1/wldrive.log" 2>&1 || true
  wait "$app" || true
  kill "$comp" "$pw" "$wp" 2>/dev/null || true
' "$bin" "$out" "$here"

#!/bin/sh
set -eu
here=$(cd "$(dirname "$0")/.." && pwd)
bin=${SPIKE_BIN:-$here/target/release/spike-cef}
out=${SPIKE_OUT:-/tmp/spike-cef-out}
mkdir -p "$out"
export SPIKE_URL=file://$here/fixtures/page.html SPIKE_PAGES=1 SPIKE_RUN_SECS=14
export SPIKE_CEF_SWITCHES=disable-gpu,ozone-platform=x11
env -u WAYLAND_DISPLAY -u XDG_SESSION_TYPE xvfb-run -a -s "-screen 0 1280x800x24" sh -c '
  "$0" 2>"$1/stderr-menu.log" &
  app=$!
  sleep 7
  xdotool mousemove 30 20 click 1
  sleep 2
  ffmpeg -loglevel error -y -f x11grab -video_size 1280x800 -i "$DISPLAY" -frames:v 1 "$1/menu.png"
  wait "$app" || true
' "$bin" "$out"

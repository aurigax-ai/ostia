#!/bin/sh
set -eu
here=$(cd "$(dirname "$0")/.." && pwd)
bin=${SPIKE_BIN:-$here/target/release/spike-cef}
out=${SPIKE_OUT:-/tmp/spike-cef-out}
mkdir -p "$out"
export SPIKE_URL=file://$here/fixtures/page.html SPIKE_PAGES=1 SPIKE_RUN_SECS=${SPIKE_RUN_SECS:-30}
export SPIKE_CEF_SWITCHES=${SPIKE_CEF_SWITCHES:-disable-gpu,ozone-platform=x11}
xvfb-run -a -s "-screen 0 1280x800x24" sh -c '
  "$0" 2>"$1/stderr-drive.log" &
  app=$!
  sleep 8
  xdotool mousemove 400 300
  sleep 1
  xdotool click 4 click 4 click 4 click 5 click 5 click 5 click 5 click 5
  sleep 1
  xdotool mousemove 300 120 click 1
  sleep 1
  xdotool type --delay 80 "hello"
  sleep 1
  xdotool key Return
  sleep 2
  wait "$app" || true
' "$bin" "$out"

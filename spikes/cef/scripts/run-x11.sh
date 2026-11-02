#!/bin/sh
set -eu
here=$(cd "$(dirname "$0")/.." && pwd)
bin=${SPIKE_BIN:-$here/target/release/spike-cef}
pages=${SPIKE_PAGES:-1}
secs=${SPIKE_RUN_SECS:-30}
lazy=${SPIKE_LAZY_MS:-0}
out=${SPIKE_OUT:-/tmp/spike-cef-out}
mkdir -p "$out"
SPIKE_URL=${SPIKE_URL:-file://$here/fixtures/page.html} \
SPIKE_PAGES=$pages SPIKE_RUN_SECS=$secs SPIKE_LAZY_MS=$lazy \
SPIKE_CEF_SWITCHES=${SPIKE_CEF_SWITCHES:-disable-gpu,ozone-platform=x11} \
xvfb-run -a -s "-screen 0 1280x800x24" sh -c '
  "$0" 2>"$1/stderr-$2p.log" &
  app=$!
  python3 -I "$3/scripts/sample.py" "$app" "$1/sample-$2p.csv" &
  sampler=$!
  wait "$app" || true
  kill "$sampler" 2>/dev/null || true
' "$bin" "$out" "$pages" "$here"

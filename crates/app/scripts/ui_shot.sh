#!/bin/bash
set -euo pipefail
here=$(cd "$(dirname "$0")" && pwd)
out=${UI_SHOT_OUT:?set UI_SHOT_OUT to the screenshot folder}
name=${UI_SHOT_NAME:?set UI_SHOT_NAME to the file name without .png}
keys=${UI_SHOT_KEYS:-}
settle=${UI_SHOT_SETTLE:-4}
monitor=${UI_SHOT_MONITOR:-1440x900}
private=$(mktemp -d /tmp/ostia-ui-shot.XXXXXX)
chmod 700 "$private"
mkdir -p "$out" "$private/home" "$private/state" "$private/config" "$private/cache" "$private/data"
trap 'rm -rf "$private" 2>/dev/null || true' EXIT
env -u DISPLAY -u WAYLAND_DISPLAY -u WAYLAND_SOCKET \
  XDG_RUNTIME_DIR="$private" XDG_STATE_HOME="$private/state" XDG_CONFIG_HOME="$private/config" \
  XDG_CACHE_HOME="$private/cache" XDG_DATA_HOME="$private/data" HOME="$private/home" \
  UI_SHOT_LOG="$private" SHELL=/bin/bash \
  dbus-run-session -- bash -c '
    pipewire >"$UI_SHOT_LOG/pipewire.log" 2>&1 &
    pipewire_pid=$!
    wireplumber >"$UI_SHOT_LOG/wireplumber.log" 2>&1 &
    plumber_pid=$!
    mutter --headless --wayland --no-x11 --virtual-monitor "$1" --wayland-display=wl-ui-shot >"$UI_SHOT_LOG/mutter.log" 2>&1 &
    mutter_pid=$!
    for _ in $(seq 50); do [ -S "$XDG_RUNTIME_DIR/wl-ui-shot" ] && break; sleep 0.2; done
    here=$2; out=$3; name=$4; keys=$5; settle=$6
    shift 6
    WAYLAND_DISPLAY=wl-ui-shot XDG_SESSION_TYPE=wayland "$@" >"$out/$name.app.log" 2>&1 &
    app_pid=$!
    status=0
    python3 -I "$here/ui_shot.py" "$out" "$name" "$settle" "$keys" || status=$?
    kill "$app_pid" 2>/dev/null || true
    wait "$app_pid" 2>/dev/null || true
    kill "$mutter_pid" "$plumber_pid" "$pipewire_pid" 2>/dev/null || true
    exit "$status"
  ' _ "$monitor" "$here" "$out" "$name" "$keys" "$settle" "$@"

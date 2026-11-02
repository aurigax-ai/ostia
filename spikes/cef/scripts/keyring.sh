#!/bin/sh
set -eu
here=$(cd "$(dirname "$0")/.." && pwd)
mode=$1; kmode=${KR_KEYRING:-$1}
run=${2:-1}
case_dir=/tmp/spike-kr/$mode
out=$case_dir/out-$run
xdg=$case_dir/xdg
bin=${SPIKE_BIN:-$HOME/.cache/ostia-rs/target/release/spike-cef}
mkdir -p "$out" "$xdg" "$case_dir/data" "$case_dir/home" "$case_dir/config" "$case_dir/profile"
chmod 700 "$xdg"
export SPIKE_URL=http://127.0.0.1:8765/page.html SPIKE_PAGES=1 SPIKE_RUN_SECS=${SPIKE_RUN_SECS:-34} SPIKE_KIND=disk SPIKE_PROFILE=$case_dir/profile
export SPIKE_CEF_SWITCHES=${SPIKE_CEF_SWITCHES:-ozone-platform=wayland}
export LD_LIBRARY_PATH=$(dirname "$bin")
export KR_LATE_UNLOCK=${KR_LATE_UNLOCK:-} KR_PROMPTER_DISPLAY=${KR_PROMPTER_DISPLAY:-} KR_APP_TIMEOUT=${KR_APP_TIMEOUT:-75}
export KR_KMODE=$kmode KR_MODE=$mode KR_CASE=$case_dir KR_OUT=$out KR_HERE=$here KR_BIN=$bin
env -u DISPLAY -u WAYLAND_DISPLAY -u DBUS_SESSION_BUS_ADDRESS -u XDG_CURRENT_DESKTOP \
  HOME=$case_dir/home XDG_DATA_HOME=$case_dir/data XDG_CONFIG_HOME=$case_dir/config XDG_RUNTIME_DIR=$xdg \
  dbus-run-session ${KR_BUS_CONF:+--config-file=$KR_BUS_CONF} -- sh -c '
  python3 -I "$KR_HERE/scripts/keyring-server.py" "$KR_HERE/fixtures" "$KR_OUT/requests.log" 8765 &
  srv=$!
  pipewire >"$KR_OUT/pipewire.log" 2>&1 &
  pw=$!
  wireplumber >"$KR_OUT/wireplumber.log" 2>&1 &
  wp=$!
  mutter --headless --wayland --no-x11 --virtual-monitor 1280x800 --wayland-display=wl-spike >"$KR_OUT/mutter.log" 2>&1 &
  comp=$!
  kr=
  case "$KR_KMODE" in
    unlocked) printf "%s" testpass | gnome-keyring-daemon --foreground --components=secrets --control-directory="$KR_CASE/ctl" --unlock >"$KR_OUT/keyring.log" 2>&1 & kr=$! ;;
    locked) gnome-keyring-daemon --foreground --components=secrets --control-directory="$KR_CASE/ctl" --start >"$KR_OUT/keyring.log" 2>&1 & kr=$! ;;
  esac
  if [ -n "${KR_LATE_UNLOCK:-}" ]; then
    ( sleep "$KR_LATE_UNLOCK"; python3 -I "$KR_HERE/scripts/keyring-unlock.py" testpass >"$KR_OUT/late-unlock.log" 2>&1; date +%s.%N >"$KR_OUT/unlocked-at"; busctl --user get-property org.freedesktop.secrets /org/freedesktop/secrets/collection/login org.freedesktop.Secret.Collection Locked >"$KR_OUT/locked-prop.log" 2>&1 ) &
  fi
  sleep 3
  date +%s.%N >"$KR_OUT/app-start"
  if [ -n "${KR_PROMPTER_DISPLAY:-}" ]; then dbus-update-activation-environment WAYLAND_DISPLAY=wl-spike; fi
  WAYLAND_DISPLAY=wl-spike XDG_SESSION_TYPE=wayland timeout ${KR_APP_TIMEOUT:-75} "$KR_BIN" 2>&1 >/dev/null | python3 -I "$KR_HERE/scripts/keyring-stamp.py" "$KR_OUT/stderr.log" &
  app=$!
  SPIKE_DRIVE_MODE= python3 -I "$KR_HERE/scripts/wayland-drive.py" "$KR_OUT" 12 >"$KR_OUT/wldrive.log" 2>&1 || true
  wait "$app" || true
  kill $srv $comp $pw $wp $kr 2>/dev/null || true
'

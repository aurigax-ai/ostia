#!/usr/bin/env bash
set -euo pipefail
scratch=$(mktemp -d)
trap 'rm -rf "$scratch"' EXIT
export XDG_DATA_HOME="$scratch/data" XDG_CONFIG_HOME="$scratch/config" XDG_RUNTIME_DIR="$scratch/run"
mkdir -p "$XDG_DATA_HOME" "$XDG_CONFIG_HOME" "$XDG_RUNTIME_DIR"
chmod 700 "$XDG_RUNTIME_DIR"
exec dbus-run-session -- bash -c '
set -euo pipefail
printf "spike-test-password" | gnome-keyring-daemon --unlock --components=secrets >/dev/null
cargo test --test os_crypt -- --ignored
'

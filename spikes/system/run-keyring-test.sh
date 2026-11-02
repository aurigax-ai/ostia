#!/usr/bin/env bash
set -euo pipefail
exec dbus-run-session -- bash -c '
set -euo pipefail
printf "spike-test-password" | gnome-keyring-daemon --unlock --components=secrets >/dev/null
cargo test --test os_crypt -- --ignored
'

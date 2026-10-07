#!/usr/bin/env bash
set -euo pipefail

src=$1
here=$(cd "$(dirname "$0")" && pwd)
images=${APT_TEST_IMAGES:-debian:13 ubuntu:24.04}

if [ -d "$src" ]; then
  port=8765
  python3 -m http.server "$port" --bind 127.0.0.1 --directory "$src" >/dev/null 2>&1 &
  server=$!
  trap 'kill "$server"' EXIT
  for _ in $(seq 1 20); do
    curl -fs -o /dev/null "http://127.0.0.1:$port/Packages" && break
    sleep 0.5
  done
  url="http://127.0.0.1:$port"
  packages=$(cat "$src/Packages")
else
  url=$src
  packages=$(curl -fsSL "$url/Packages")
fi

mapfile -t versions < <(awk '/^Version:/ {print $2}' <<<"$packages" | sort -V)
want=${versions[-1]}
from=""
if [ ${#versions[@]} -gt 1 ]; then
  from=${versions[-2]}
fi
echo "repository $url: ${versions[*]}"

for image in $images; do
  docker run --rm --network host -v "$here/smoke.sh:/smoke.sh:ro" -v "$here/../../scripts/retry.sh:/retry.sh:ro" "$image" bash /smoke.sh "$url" "$want" "$from"
done

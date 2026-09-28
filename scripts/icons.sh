#!/usr/bin/env bash
set -euo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
out="$root/resources/icons"
mkdir -p "$out"

for size in 16 24; do
  rsvg-convert -w "$size" -h "$size" "$root/resources/icon-small.svg" -o "$out/${size}x${size}.png"
done
for size in 32 48 64 128 256 512; do
  rsvg-convert -w "$size" -h "$size" "$root/resources/icon.svg" -o "$out/${size}x${size}.png"
done
cp "$out/512x512.png" "$root/resources/icon.png"
echo "icons written to $out"

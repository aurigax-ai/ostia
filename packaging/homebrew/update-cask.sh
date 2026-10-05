#!/usr/bin/env bash
set -euo pipefail

cask=$1
tag=$2
repo=${3:-aurigax-ai/ostia}
version=${tag#v}
asset="ostia-$version-arm64.dmg"

digest=$(gh release view "$tag" -R "$repo" --json assets \
  -q ".assets[] | select(.name == \"$asset\") | .digest")
sha=${digest#sha256:}
if ! [[ $sha =~ ^[0-9a-f]{64}$ ]]; then
  echo "no sha256 digest for $asset in $repo $tag" >&2
  exit 1
fi

sed -i.bak \
  -e "s/^  version \".*\"$/  version \"$version\"/" \
  -e "s/^  sha256 \".*\"$/  sha256 \"$sha\"/" \
  "$cask"
rm -f "$cask.bak"

grep -qx "  version \"$version\"" "$cask"
grep -qx "  sha256 \"$sha\"" "$cask"
echo "$cask: $version $sha"

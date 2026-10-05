#!/usr/bin/env bash
set -euo pipefail

cask=$1
tag=$2
repo=${3:-aurigax-ai/ostia}
here=$(cd "$(dirname "$0")" && pwd)
version=${tag#v}
asset="ostia-$version-arm64.dmg"

digest=$(gh release view "$tag" -R "$repo" --json assets \
  -q ".assets[] | select(.name == \"$asset\") | .digest")
sha=${digest#sha256:}
if ! [[ $sha =~ ^[0-9a-f]{64}$ ]]; then
  echo "no sha256 digest for $asset in $repo $tag" >&2
  exit 1
fi

work=$(mktemp -d)
mount="$work/mnt"
trap 'hdiutil detach -quiet "$mount" 2>/dev/null || true; rm -rf "$work"' EXIT
gh release download "$tag" -R "$repo" -p "$asset" -D "$work"
test "$(shasum -a 256 "$work/$asset" | cut -d' ' -f1)" = "$sha"
hdiutil attach -quiet -nobrowse -readonly -mountpoint "$mount" "$work/$asset"
minimum=$(/usr/libexec/PlistBuddy -c 'Print LSMinimumSystemVersion' "$mount/Ostia.app/Contents/Info.plist")
macos=$("$here/macos-name.sh" "$minimum")

sed -i.bak \
  -e "s/^  version \".*\"$/  version \"$version\"/" \
  -e "s/^  sha256 \".*\"$/  sha256 \"$sha\"/" \
  -e "s/^  depends_on macos: .*$/  depends_on macos: :$macos/" \
  "$cask"
rm -f "$cask.bak"

grep -qx "  version \"$version\"" "$cask"
grep -qx "  sha256 \"$sha\"" "$cask"
grep -qx "  depends_on macos: :$macos" "$cask"
echo "$cask: $version $sha, macOS $minimum or later (:$macos)"

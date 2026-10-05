#!/usr/bin/env bash
set -euo pipefail

dir=$1
repo=$2
tag=$3

remote=$(gh release view "$tag" -R "$repo" --json assets -q '.assets[].name')

for deb in "$dir"/ostia_*.deb; do
  name=$(basename "$deb")
  if ! grep -qxF "$name" <<<"$remote"; then
    gh release upload "$tag" "$deb" -R "$repo"
  fi
done

for file in Packages Packages.gz Release Release.gpg InRelease; do
  gh release upload "$tag" "$dir/$file" -R "$repo" --clobber
done

while read -r name; do
  case $name in
    ostia_*.deb)
      if [ ! -e "$dir/$name" ]; then
        gh release delete-asset "$tag" "$name" -R "$repo" -y
      fi
      ;;
  esac
done <<<"$remote"

gh release view "$tag" -R "$repo" --json assets -q '.assets[].name'

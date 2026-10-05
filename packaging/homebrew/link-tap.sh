#!/usr/bin/env bash
set -euo pipefail

checkout=$(cd "$1" && pwd)
tap="$(brew --repository)/Library/Taps/aurigax-ai/homebrew-tap"
mkdir -p "$(dirname "$tap")"
rm -rf "$tap"
ln -s "$checkout" "$tap"

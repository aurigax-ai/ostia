#!/usr/bin/env bash
#
# install-skills.sh — symlink Pine's in-repo Claude Code skills into ~/.claude/skills
# so a coding agent (Claude Code) running on this machine picks up the `pine` skill.
#
# For now this is a dev-time symlink; later these get published as a proper skill/plugin.
# Re-run any time — it's idempotent. Pass --copy to hard-copy instead of symlink,
# or --uninstall to remove the installed links.
#
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SKILLS_SRC="$REPO_ROOT/.claude/skills"
SKILLS_DEST="$HOME/.claude/skills"

mode="symlink"
case "${1:-}" in
  --copy) mode="copy" ;;
  --uninstall) mode="uninstall" ;;
  --help|-h) echo "usage: $0 [--copy|--uninstall]"; exit 0 ;;
esac

if [ ! -d "$SKILLS_SRC" ]; then
  echo "error: no skills found at $SKILLS_SRC" >&2
  exit 1
fi

mkdir -p "$SKILLS_DEST"

for skill_dir in "$SKILLS_SRC"/*/; do
  [ -d "$skill_dir" ] || continue
  name="$(basename "$skill_dir")"
  dest="$SKILLS_DEST/$name"

  # Remove any existing install (symlink or dir) so we can re-link cleanly.
  if [ -L "$dest" ] || [ -e "$dest" ]; then
    rm -rf "$dest"
  fi

  case "$mode" in
    uninstall)
      echo "removed  $dest"
      ;;
    copy)
      cp -R "$skill_dir" "$dest"
      echo "copied   $dest"
      ;;
    symlink)
      ln -s "${skill_dir%/}" "$dest"
      echo "linked   $dest -> ${skill_dir%/}"
      ;;
  esac
done

if [ "$mode" != "uninstall" ]; then
  echo ""
  echo "Done. Restart Claude Code (or /reload-skills) to pick up the 'pine' skill."
fi

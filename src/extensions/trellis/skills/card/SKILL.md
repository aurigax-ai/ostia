---
name: card
description: Works a Trellis card with the trellis CLI by its ref (such as SHOP-12) - reads it, claims it, comments progress, renews the claim, moves it to another column, and writes findings to the project's vault. Use when a task names a Trellis card or ref, or asks to claim, comment on or move one.
---

# Working a Trellis card

A card is named by its ref, `KEY-N` (for example `SHOP-12`). A ref names its own project, so the
card commands work from any directory.

## Identity

Trellis reads the actor from `TRELLIS_AGENT`. Without it every call is a new actor, so a claim
made by one command does not belong to the next. When `TRELLIS_AGENT` is unset, set one value
unique to the session (`export TRELLIS_AGENT=<value>`, or a prefix on each command).

## Card commands

```bash
trellis card show <ref>                       # title, body, column, claim and its expiry
trellis card claim <ref>                      # fails when another actor holds the claim
trellis card comment <ref> --body "what changed"
trellis card renew <ref> [--ttl <minutes>]    # a claim expires; a comment does not extend it
trellis card move <ref> <column>
trellis column ls [--project KEY]             # the board's columns
```

## Text arguments

`--body` and `--title` take text, `-` for stdin, or `@file` for a file's contents (`--body
@notes.md`). A value that starts with `@` is always a file name, and a lone `-` is stdin. Text
with backticks, quotes or `$` passes unchanged through stdin:

```bash
trellis card comment <ref> --body - <<'COMMENT'
Markdown with `backticks` and $variables, unchanged.
COMMENT
```

## Output and errors

Output is JSON when stdout is not a terminal. A failed command exits non-zero and writes its
error as JSON on **stderr**:

```json
{ "error": { "code": "...", "message": "...", "fix": "..." } }
```

A usage error (an unknown flag, a missing argument) is plain text. `trellis <command> --help`
lists every flag.

## Vault entries

```bash
trellis vault ls
trellis vault show <entry>                    # prints the entry and its version
trellis vault new --title "..." --body @notes.md [--in <directory>] [--template <name>] [--source <evidence>]
trellis vault edit <entry> --body @notes.md --if-version <n>
trellis template show <name>                  # what a template asks for
```

`vault edit` replaces the whole body and fails when `<n>` is no longer the entry's version.

---
name: card
description: Use when asked to work on a Trellis card (a ref such as SHOP-12) - reading it, claiming it, commenting your progress, keeping the claim alive, moving it to review, and writing what you learned to the vault.
---

# Working a Trellis card

A card is named by its ref, `KEY-N` (for example `SHOP-12`). A ref names its own project, so the
card commands below work from any directory.

## One identity for the whole session

Trellis reads who you are from `TRELLIS_AGENT`. Without it every call is a new actor, so a claim
made by one command is not yours in the next.

- If `TRELLIS_AGENT` is already set, leave it as it is.
- If it is not, pick one value that is unique to this session and use that same value on every
  command: `export TRELLIS_AGENT=<value>` once, or prefix each command with
  `TRELLIS_AGENT=<value>` when your shell does not keep exports between commands.

## The loop

1. **Read it.** `trellis card show <ref>` prints the card: title, body, column, who claims it and
   until when.
2. **Claim it before you start.** `trellis card claim <ref>`. If another actor holds the claim,
   the command fails: stop and tell the human instead of taking the card.
3. **Comment as you go.** `trellis card comment <ref> --body "what changed"`. Say what you found,
   what you decided and what is left, so someone else could pick the card up from the comments.
4. **Keep the claim alive.** A claim expires, and a comment does not extend it. Run
   `trellis card renew <ref>` before a long stretch of work and after a long pause
   (`--ttl <minutes>` asks for a longer claim).
5. **Finish.** Comment what you did and how to check it, then move the card to the column where
   work waits for review: `trellis card move <ref> <column>`. `trellis column ls` lists the
   board's columns (add `--project KEY` outside the project's folder). Use a name from that list;
   leave the done column to the human unless you were told otherwise.

## Text arguments

`--body` and `--title` take text, `-` for stdin, or `@file` for a file's contents. For anything
longer than a line, or with backticks, quotes or `$`, write the text to a file and pass
`--body @notes.md`, or use stdin:

```bash
trellis card comment <ref> --body - <<'COMMENT'
Markdown with `backticks` and $variables, unchanged.
COMMENT
```

A value that starts with `@` is always read as a file name, and a lone `-` as stdin.

## Output and errors

Output is JSON when stdout is not a terminal. A command that fails exits non-zero and writes its
error as JSON on **stderr**, not stdout:

```json
{ "error": { "code": "...", "message": "...", "fix": "..." } }
```

Read `message` and `fix` before retrying. A usage error (an unknown flag, a missing argument) is
plain text instead. `trellis <command> --help` lists every flag; check it rather than guessing.

## Write down what you learned

A finding the next session would have to work out again belongs in the project's vault, not only
in a comment.

- See what exists first: `trellis vault ls`, then `trellis vault show <entry>`.
- New entry: `trellis vault new --title "..." --body @notes.md`. `--in <directory>` places it,
  `--template <name>` picks a template and `--source <evidence>` cites where the claim comes from
  (some templates require one; `trellis template show <name>` says what a template asks for).
- Change an entry: `trellis vault edit <entry> --body @notes.md --if-version <n>`, where `<n>` is
  the `version` that `trellis vault show <entry>` printed. The body is replaced whole, so start
  from the current text. If the version no longer matches, read the entry again and redo the
  change instead of retrying blind.

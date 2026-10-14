---
name: activity
description: Use inside Ostia to leave the human something that does not block you - a decision to review later, a manual step, a credential to set, a result to check - or to read what other agents in this workspace reported. Covers ostia activity add, list, show and done, and when to use add --needs-you instead of ostia ask.
---

# Activity: notes and needs-you items

Activity is this workspace's record of what agents did and of what needs the human. You write to
it and read from it with `ostia activity`.

## Pick the right command

- **Blocked and need an answer now:** `ostia ask "<question>"`. It waits for the human's reply.
- **The human must see or do something, but you can keep working:**
  `ostia activity add "<text>" --needs-you`. It returns at once. The item stays open, with a
  count in the sidebar, until the human or you mark it done.
- **Worth recording, nothing to do:** `ostia activity add "<text>"`.

## Add

```sh
ostia activity add "Set STRIPE_KEY in .env.local before running the payment tests" --needs-you
ostia activity add "Migrated the orders table; check the row counts" --needs-you --link db/report.md
ostia activity add "Split the API client into transport and retry layers"
```

- One entry per call, at most 2000 characters. Write it so it reads alone, later.
- `--link` takes an http(s) URL or a file path (relative to your directory).
- It prints the entry's id. Keep it if you plan to mark the item done.
- Secrets are replaced before the text is stored. If the secret scan fails, nothing is stored and
  the command fails: try again without the sensitive part.

## Read

```sh
ostia activity list                    # notes, needs-you items and agents' closing recaps
ostia activity list --open             # needs-you items nobody has marked done
ostia activity list --since 2h --json  # also: --needs-you, --archived, --since 2026-10-14T09:00
ostia activity show <id>
```

- You read your own workspace. `--workspace <id>` reads another one and needs the
  `all-workspaces` capability.
- `--archived` reads entries that moved out of the live view.

## Done

```sh
ostia activity done <id>
```

You can mark only your own needs-you items done, once the thing is resolved. The human marks the
others in the Activity panel.

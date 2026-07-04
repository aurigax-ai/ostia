---
name: pine
description: Use when a coding agent is running inside Pine (a terminal-workspace app) — detectable via the env vars PINE_SOCKET/PINE_TOKEN/PINE_PANE_ID/PINE_WORKSPACE — and wants to control its own pane or coordinate with other agents/panes in the workspace. Covers the `pine` CLI: identity (whoami), introspection (commands, docs), opening files, desktop notifications, background processes, an encrypted secret vault, a project/global wiki, a per-project kanban board, a cross-agent message bus, and reading/writing app settings. Also covers the capability/elevation model and a recipe for two agents (e.g. Claude + Codex) in different panes coordinating work. Triggers on "pine", "pine CLI", "am I in Pine", "control the terminal workspace", "talk to the other pane/agent", "hand off a task to another agent", "pine bus/wiki/kanban/vault/settings".
---

# Pine — the agent toolbelt

Pine is a terminal-workspace app (terminal + editor + agent panes). When a coding
agent's shell is a pane inside Pine, that pane's environment carries:

- `PINE_SOCKET` — path to the app's control-plane Unix socket
- `PINE_TOKEN` — a per-pane auth token (proves *this* pane, nothing else)
- `PINE_PANE_ID` — this pane's external id (a UUID — same value `whoami` calls `externalId`)
- `PINE_WORKSPACE` — the workDir this pane/session was anchored to
- `PINE_CLI` — (dev builds only) path to the CLI's bundled JS; a shell function
  `pine() { node "$PINE_CLI" "$@"; }` is injected for bash/zsh panes with shell
  integration, so the bare `pine` command just works. If `pine` isn't found, check
  `echo $PINE_CLI` and `type pine`, or invoke it directly: `node "$PINE_CLI" whoami`.
  (A packaged/installed build ships `pine` on `PATH` directly.)

If those env vars are unset, you are not inside a Pine pane — `pine` has nothing to
dial and every command will fail with "not inside a Pine pane (PINE_SOCKET unset)".

Every `pine` invocation dials the socket, authenticates with `hello` (using
`PINE_TOKEN`), then sends one JSON-RPC request. `pine docs` prints the same
reference this skill is based on — treat it as the live source of truth if the two
ever disagree (e.g. after an app update).

## Identity & introspection

```sh
pine whoami          # { externalId, paneId, sessionId } — externalId is the id used
                      # everywhere else (bus.send's <to>, etc.); PINE_PANE_ID == externalId
pine commands        # JSON array of commands available in this window: id, title,
                      # category, hidden, argsSchema, resultSchema, capabilities, target
pine docs            # this same reference, generated from the running app
pine info            # this pane's mirrored terminal state (cwd, running, gen, ...)
pine cwd             # just this pane's current working directory
```

`pine commands` always prints JSON (there's no separate `--json` flag to pass —
JSON is the only output format). It lists *commands*, not other panes; there is no
roster/"list all panes" verb yet (see the coordination recipe below for how to work
around that).

## Everyday actions

```sh
pine open <file>                    # open <file> in this pane's editor surface
pine notify "<title>" ["<body>"]    # fire a desktop notification (title required)
```

## Raw UI commands

Anything registered in the command palette can be run directly by id, with an
optional JSON args blob as the next argv:

```sh
pine pane.splitRight
pine pane.splitDown
pine pane.close
pine session.new
pine editor.open '{"path":"src/index.ts"}'   # same as `pine open`, spelled out
```

`pine commands` is the authoritative list (id + argsSchema + capabilities) — check
it before guessing an id or an args shape.

## Background processes

```sh
pine process run "npm run dev" [--name web] [--cwd /path]   # -> { id, name, pid }
pine process ls                                              # id, name, status, pid, cmd
pine process logs <id|name> [--since N]                      # prints captured stdout+stderr
pine process kill <id|name>
pine process restart <id|name>                                # kill (if running) + re-run
```

Tracked processes are scoped to the session that started them (cross-session
visibility needs the elevated `workspace-wide` capability). `logs` prints the
buffered output followed by `(cursor=N)` on stderr — pass `--since` that cursor to
resume from where you left off instead of re-reading everything.

## Vault — encrypted secrets

```sh
echo -n "sk-..." | pine vault set OPENAI_KEY [--global]   # value read from STDIN, never argv
pine vault get OPENAI_KEY [--global]
pine vault ls [--global]                                    # keys only, never values
pine vault rm OPENAI_KEY [--global]
```

`set` **always** reads the secret from stdin (piped, or an interactive no-echo
prompt) — never put a secret in the command line where it would land in shell
history / `ps`. Default scope is `project` (keyed by this pane's session workDir);
`--global` is machine-wide. Requires OS keychain-backed encryption to be available;
if it isn't, every vault call fails closed with `encryption-unavailable` rather than
ever writing plaintext. `--global` **writes** (`set`/`rm`) need the elevated
`workspace-wide` grant on top of the default vault capability — global reads don't.

## Wiki — project/global shared notes

```sh
pine wiki set <slug> [--global] <<< "body text"   # body read from STDIN (pipe/heredoc)
pine wiki get <slug> [--global]
pine wiki ls [--global]                            # slug, title, updatedAt
pine wiki search "<query>" [--global]
pine wiki rm <slug> [--global]
```

Good for anything two agents (or an agent and its future self) should share:
design decisions, a roster of known pane ids, running notes. Default scope is
`project` — two panes anchored to the *same* workDir automatically share the same
project wiki (and vault, and kanban board). `--global` **writes** (`set`/`rm`) need
the elevated `workspace-wide` grant on top of the default wiki capability — global
reads don't.

## Kanban — per-project task board

```sh
pine kanban ls                                       # columns + cards, grouped
pine kanban add "<title>" [--column doing] [--body "..."]
pine kanban move <id> <column>
pine kanban assign <id> <who>
pine kanban done <id>                                # shorthand for move <id> done
pine kanban rm <id>
```

Board is per-project only (no `--global`) — same sharing rule as the wiki. Columns
are seeded as `todo`/`doing`/`done` on first use; `add`/`move` reject an unknown
column id (`unknown-column`) rather than silently creating one.

## Bus — cross-agent messages & handoffs

```sh
pine bus send <toExternalId> "<message>"
pine bus inbox [--drain]                                     # print (and optionally clear) your inbox
pine bus wait [--timeout MS]                                  # block until a message arrives
                                                                # (clamped to 1s–120s, default 30s)
pine bus handoff <toExternalId> --task "<task>" --summary "<summary>"
pine bus claim <id>                                           # claim a handoff addressed to you
pine bus handoffs [--all]                                     # your handoffs (to/from you);
                                                                # --all needs workspace-wide
pine bus done <id>                                            # mark a handoff completed
```

Bus is global (no project scoping) — it works across different projects/workdirs
too. Sending/handing off to yourself needs nothing extra; sending/handing off to
*another* pane's externalId needs the elevated `send-other-pane` capability.
`bus.handoffs` defaults to just the handoffs addressed to or from you — pass
`--all` for the workspace-wide view (needs the `workspace-wide` grant). Each
inbox and the handoff ledger are bounded (oldest entries drop off) so a chatty
pane can't grow the shared store forever.

## Settings — read/write the app's settings.json

```sh
pine settings get                        # whole { locale, appearance, behavior } state
pine settings get appearance.terminal.size
pine settings set appearance.terminal.size 14      # value parsed as JSON if it parses...
pine settings set locale '"en"'                    # ...else used as the raw string
pine settings set behavior.showHiddenFiles true
```

`set` deep-sets a dot-path immutably into the live `settingsStore` (so the Settings
UI updates instantly, no restart) and debounce-persists it to `settings.json`.
Unknown paths are created rather than rejected. `get` with no key returns the whole
state; with a key it walks the path and prints `null` (JSON for `undefined`) if
absent.

## Capabilities & elevation

Posture: **pane-scoped trust** — a process running inside a pane is trusted at
pane scope, so every pane holds a fixed set of **default** capabilities:
`drive-self`, `read-board`, `notify`, `wiki-read`, `wiki-write`, `settings-read`,
`board-write`, `process`, `vault-read`, `vault-write`. Everything cross-boundary,
system-facing, or dangerous is **elevated** and starts withheld: `send-other-pane`,
`kill-pane`, `workspace-wide`, `shell`, `destructive`, `phone`, `browse`,
`settings-write`.

A call that needs a capability the pane doesn't hold fails fast with
`needs-elevation: <cap>` (surfaced as `pine: needs-elevation: <cap>` on stderr,
nonzero exit) — it never gets partway through. As of this build there is no `pine`
verb or UI to self-grant a capability: elevation is a human-in-the-loop decision.
The human grants elevated caps to *every* pane up front by adding them to
`capabilities.grants` in `settings.json`, e.g.:

```json
{ "capabilities": { "grants": ["browse", "send-other-pane"] } }
```

That array is read once at process start (main seeds each pane's caps with
`DEFAULT_CAPABILITIES ∪ grants`), so a restart is required after editing it. Since
`settings-write` is itself elevated, an agent can't grant this to itself — the
human edits the file directly (or a future UI/`pine settings set` does it on their
behalf, pre-granted). If you hit `needs-elevation`, say so plainly (e.g. in your
response, or as a `pine notify`) rather than guessing at a workaround — don't retry
the same call expecting a different result.

`pine commands` reports each command's `capabilities` array so you can check before
you act. Commands without an explicit list default to the same default set above.

## Multi-agent coordination recipe

Two agents in different panes of the same Pine window (e.g. Claude driving pane A,
Codex driving pane B) can coordinate like this:

1. **Learn identities.** Each agent runs `pine whoami` and notes its own
   `externalId`. There's no pane-roster command yet, so the *other* agent's id has
   to come from somewhere out-of-band — the human relays it, or (better, so it
   survives restarts) each agent publishes it once:
   ```sh
   pine wiki set agents/claude-a <<< "$(pine whoami)"
   ```
   and the other agent reads it back with `pine wiki get agents/claude-a` (works
   automatically if both panes share a project workDir; otherwise add `--global`
   on both sides).
2. **Hand off or ping.** Use `pine bus send <externalId> "..."` for a quick note,
   or `pine bus handoff <externalId> --task "..." --summary "..."` for a real
   unit of work; the receiving agent runs `pine bus wait` (or polls `pine bus
   inbox`) to notice it, then `pine bus claim <id>` and eventually `pine bus done
   <id>`.
3. **Plan shared work** on `pine kanban` (`add`/`assign`/`move`/`done`) so both
   agents (and the human) see one board instead of duplicating state in two
   contexts.
4. **Store shared knowledge** — design decisions, "here's what I tried and why it
   didn't work" — in `pine wiki`, not just in your own conversation, so the other
   agent (or your own next session) can `pine wiki get`/`pine wiki search` it
   instead of re-deriving it.

Remember: `send-other-pane` (bus send/handoff to someone else) and `board-write`
(kanban writes) are elevated — if either agent hits `needs-elevation`, that's the
signal to stop and flag it rather than silently falling back to writing files on
disk as a workaround.

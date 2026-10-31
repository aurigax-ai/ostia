---
name: ostia
description: Controls the Ostia workspace an agent runs in through the `ostia` CLI. Shows files and URLs to the human, asks questions, runs commands and agents in tabs the human watches, reads and drives other panes, messages other agents and drives the in-app browser. Use when OSTIA_SOCKET is set and a task involves the human's screen, another pane or agent, the browser, a system package, a secret or a sandboxed workspace.
---

# Ostia: environment and command map

## Environment

Inside an Ostia terminal pane these are set:

| Variable | Meaning |
|---|---|
| `OSTIA_SOCKET` | the app's control socket; unset means the pane is not inside Ostia and every `ostia` command fails |
| `OSTIA_PANE_ID` | this pane's id, the `paneId` other commands take |
| `OSTIA_START_DIR` | the folder this pane was asked to start in |
| `OSTIA_WORKSPACE_DIR` | the folder the workspace is anchored to, as an absolute path (the real path in a sandboxed workspace) |
| `OSTIA_ARTIFACTS`, `OSTIA_PAD` | the workspace's artifact folder and its scratch pad (unset in sandboxed workspaces) |
| `OSTIA_NODE`, `OSTIA_CLI` | the app's runtime and the CLI script |

`ostia` is a shell function in bash and zsh panes and a launcher on the pane's `PATH`, so a
tool's own shell (Codex, fish) finds it too. Where `PATH` was reset, run
`ELECTRON_RUN_AS_NODE=1 "$OSTIA_NODE" "$OSTIA_CLI" <noun> <verb> …`.

Every command is `ostia <noun> <verb> [args]`. `ostia <noun> --help` prints a noun's verbs and
arguments, `ostia <noun> <verb> --help` one verb, and `ostia --help` the nouns. A refusal or
error is one line on stderr, `ostia <noun> <verb>: <code>: <detail>`, with exit 1; a usage
mistake adds the verb's usage line. JSON answers are one line; in tab-separated text lines a
tab, newline or control character in a field shows as `\t`, `\n` or `\xNN`. `ostia docs` lists
the reference topics and the commands of the enabled extensions; `ostia docs <topic>` prints one,
`ostia docs skill` this skill. `ostia whoami` prints JSON: `externalId` (the pane id other commands
take), `paneId` and `workspaceId` (the app's internal ids), `cwd` and `running` (whether a command
runs there). A script token gets `{externalId, kind: "script"}` and no pane.

## Command map

| Noun | For | Use when |
|---|---|---|
| `whoami` | your pane, workspace, folder and whether a command runs | you need your own `paneId` |
| `open`, `diff` | showing a file, folder, URL or comparison to the human | the human should look at something |
| `ask` | a question the human answers from Ostia or their phone | you need a decision or a missing fact |
| `state`, `notify` | your pane's attention mark; a notification | you wait on the human or finished |
| `process` | commands in visible terminal tabs | a long or background command the human may watch |
| `agent` | another agent started in a terminal tab with a prompt | handing a task to claude, codex or a configured agent |
| `pane` | panes you reach: list, send, read, wait, wake, move, close | talking to or arranging other panes: see [reference/panes.md](reference/panes.md) |
| `bus` | messages and handoffs between agents | telling an agent something without typing into it: see [reference/bus.md](reference/bus.md) |
| `workspace` | workspaces and sidebar groups | creating, describing or grouping workspaces |
| `git`, `ports` | the repository of your folder; listening ports | repo state, staging, committing: see [reference/git.md](reference/git.md) |
| `browse` | browser panes | web pages: see [reference/browser.md](reference/browser.md) |
| `view` | sidebar sections and panels from a JSON file | building UI for the human: see [reference/views.md](reference/views.md) |
| `settings`, `snippet`, `account` | `settings.json`; the human's saved commands | reading or changing a setting; how a project is run: see [reference/settings.md](reference/settings.md) |
| `vault`, `secret`, `sandbox` | stored secrets; asks from a sandboxed workspace | a credential, a blocked host or port: see [reference/sandbox.md](reference/sandbox.md) |
| `graph` | graphs: procedures with waits that outlive a session | a long procedure that must survive restarts: see [reference/graphs.md](reference/graphs.md) |
| `system` | the OS and its package managers | installing a package through the human: see [reference/system.md](reference/system.md) |
| `serial` | serial consoles in a terminal pane | a switch or router console over a USB serial adapter: see [reference/serial.md](reference/serial.md) |
| `ext`, `<extId>` | extension commands | `ostia ext list` names them |

Capabilities, reach and phone pairing: see [reference/capabilities.md](reference/capabilities.md).
Reports the human sends (picked elements, selections, captures): see
[reference/reports.md](reference/reports.md).

## Show things to the human

```sh
ostia open src/app.ts:42:5 notes.md # a tab per file; file:line[:col] jumps there
ostia open . # a folder, in the Files panel (under the home folder only)
ostia open https://localhost:3000 # a URL, in a browser pane
ostia open -b report.md # -b|--background: never takes the keyboard
GIT_EDITOR="ostia open --wait" git commit  # -w|--wait returns when the tab closes: exit 0, else 1
git diff | ostia open - --name change.diff  # stdin saved into $OSTIA_ARTIFACTS, then opened
ostia diff old.json new.json # read-only comparison; -b and -w too
```

A tab opened from a pane takes the keyboard only when that pane has it; otherwise it opens
quietly with an unread mark. `open` returns once each tab is there and prints one line per target:
`<paneId>\t<path>`, `files\t<folder>` or `<paneId>\t<url>`; a target with no tab after 3 s
exits 1. A sandboxed workspace opens only files under the home folder.
`-` reads at most 16 MiB and needs `$OSTIA_ARTIFACTS`.

**Artifacts.** `$OSTIA_ARTIFACTS` is the workspace's folder for outputs for the human that are
not project files (reports, plans, tables, diagrams). Files written there show under Artifacts
in the Files panel; an open tab follows edits to its file. The folder is removed with the
workspace. `$OSTIA_PAD` (`PAD.md` in it, 256 KiB at most) is the workspace's one shared note.

**Previews.** An `.html` file, or a `.jsx`/`.tsx` file whose default export is a React
component without required props, opens as a live preview. Read
[reference/previews.md](reference/previews.md) before you import a library: only those it lists
resolve.

## Attention and questions

```sh
ostia state waiting "Approve the migration?" # rings the pane: badge, bell, banner
ostia state done "Refactor finished" # a finished mark until the human looks
ostia state working | error "Tests failed" | clear
echo '{"message":"…"}' | ostia state waiting -  # message from stdin (JSON "message" or text)
ostia state done --pane <paneId> # another pane: needs all-workspaces
ostia notify "Build green" "All 412 tests pass" # a notification; also works from a script token
```

Typing into a waiting pane clears `waiting`, and so does the command that set it exiting.

```sh
ostia ask "Which database?" --context "Adding the refunds table." --choice staging --choice production
ostia ask "Which checks?" --choice lint --choice unit --choice e2e --multi
git diff --stat | ostia ask "Ship this?" --context - --choice yes --choice no --json
ostia ask "Continue?" --choice yes --choice no --timeout 600
```

`ask` shows the question on the pane, in the Inbox tab and on the paired phone, marks the pane
waiting, and waits. It prints the chosen labels one per line, then any text the human typed (`--json`:
`{"answered":true,"choices":[…],"text":"…"}`). Exit 0 answered, 2 dismissed, 3 timed out, 4 the
pane closed. At most 12 choices and 3 open questions per pane; stopping the command withdraws
the question. The answer arrives only as the command's output.

## Processes and agents in terminal tabs

```sh
ostia process run "npm run dev" --name web [--cwd DIR] [--workspace <id|name>] [--tab <name>]
ostia process list [--json] # id, name, status, paneId, command; a hint on stderr (`hint` in --json) when macOS may have ended it
ostia process logs web [--since N] # that command's output only; (cursor=N) on stderr
ostia process kill web # Ctrl+C, then ends the shell if it keeps running
ostia process restart web # Ctrl+C, then the same line in the same tab
ostia agent run claude "fix the login bug" --name fixer [--model M] [--cwd DIR] [--workspace <id|name>] [--tab <name>] [--json]
ostia agent run codex - --name review < task.md # - reads the prompt from stdin
```

`process run` opens a terminal tab beside the pane and runs the line in its interactive shell,
exactly as written; the pane keeps the keyboard. `agent run` starts `claude`, `codex`, `agy` or a configured
agent with the prompt as one argument, and answers `unknown-agent` for any other
name. Both return only once the start is known. `process run` prints `{id, name, paneId, status,
exitCode?, output?, reason?}`; `agent run` prints one line, `<name> <pane> started a turn; session <id>`
(or `started; no turn yet` after 20 s, `started; turn unknown (hooks off)`), so no `pane read` or
`pane list` follows; `--json` prints the object with `turnStarted` and `session`. `status` is `started` (an agent reported its start; a command still runs after a
second), `exited` (the command ended with exit code 0), `failed` (it ended otherwise, or its tab
closed; `output` holds its last 20 lines) or `timed-out` (no start within 15 s, 60 s for an
agent). Exit 1 for `failed` and `timed-out`. An agent caller also gets the outcome as a bus
message from `ostia`. `pane list --json` repeats the outcome as `process.start` on that pane. Unknown
flags are refused. Status is `starting`, `running`, `exited(<code>)` or `closed`; nothing survives a restart of Ostia. `logs` is empty for a full-screen program: read
its screen with `ostia pane read`. `restart` answers `still-running` when the command ignores
Ctrl+C. A caller that waits for its agents' reports runs `ostia pane keep-awake` once.

**Split tabs.** `--tab <name>` puts the new tab into the split tab of that name in its
workspace, created once two panes share the name; Ostia arranges it (side by side while each
segment stays readable, then a grid). Only a split tab an agent made can be joined: one the human
made, named or renamed answers `human-tab:`. From an agent, `agent run` without `--tab` joins its
split tab `<caller title> · workers`, the same tab for as long as the caller pane lives, and opens a
plain tab when the human took that tab over. `ostia pane list --json` reports `splitTabName`.

## Panes

```sh
ostia pane list [--here | --mine | --workspace <id|name>] [--state <state>]… [--kind <kind>] [--json] # a line per pane: id, workspace, kind, state, title, owner, finished
ostia pane send <pane> "text" [--enter] # types text; no Enter unless --enter
ostia pane send <pane> --enter -- "-y" # text starting with - goes after --
ostia pane send <pane> --paste "text" # --paste: as one bracketed paste; --raw: the bytes as typed
ostia pane send <pane> "answer" --enter --force # --force types into an agent waiting for the human
ostia pane key <pane> enter # keys: enter tab shift-tab escape backspace delete space
                                         # up down left right home end pageup pagedown ctrl-a…ctrl-z
ostia pane read <pane> [--lines N] [--json] # its screen as text; --json adds cwd, running, lastExitCode
ostia pane status [<pane>…] [--json] # a line per pane: id, state, closing line, exit, git, mail, changes; none: the terminals you may read here
ostia pane transcript <pane> [--turns N | --full] [--json] # the agent's own transcript, as written
ostia pane wait <pane>… [--until done|waiting|error|idle|exited|command]… [--timeout <s>] [--json]
ostia pane watch <pane>… [--until done|waiting|error|command|exited]… | --off # state changes arrive as mail, no blocking
ostia pane wake <pane>… [--timeout <s>] [--json] # resume a hibernated agent
ostia pane hibernate <pane>… [--json] # free an idle agent's terminal; wake resumes it
ostia pane move <pane>… --tab <name>|new [--workspace <id|name>] [--json] # group running panes into one split tab
ostia pane rename <pane> <title…> | --clear
ostia pane name <name> [--desc <text>] [--json] | --clear # your pane's bus name
ostia pane keep-awake [--off] # stay live for your workers' reports: automatic hibernation skips you
ostia pane close [<pane>… | --finished] [--json] # no pane: your own; --finished: your finished worker panes only
```

`<pane>` is a `paneId`, a bus name (`pane name`), the `--name` of a `process run`/`agent run` tab,
or its first 8 characters or more (as `pane list` prints them); tab titles never match. Several
matches answer `ambiguous-pane:` with the ids, and `send`, `key`, `close` and `hibernate` also refuse a name that
several panes share. `state` is `hibernated`, `waking`, the agent's state, `running` or `idle`.
`close`, `wake` and `hibernate` succeed when the pane already is that way (`already closed 2h ago
(w-1)`, `already awake`). Errors end with the command to run next.

`pane wait <pane>` blocks until the pane is `done`, `waiting` or its command exits and prints its
status line, so neither a sleep loop nor a `pane read` is needed. `bus wait` blocks for the next
message, `pane watch` delivers a pane's state changes as mail, and `process run`/`agent run`
return once the start is known. `pane status` answers facts without the screen; `pane read`
returns its output. Verb details, `pane list --json` fields and capabilities:
[reference/panes.md](reference/panes.md).

A tab you opened with `process run` or `agent run` needs no question. Any other pane asks the
human (`type-other-pane`, `read-other-pane`, `kill-pane`, plus `all-workspaces` outside your
reach); from a sandboxed workspace only sandboxed terminals of the same workspace are reachable.

## Bus

```sh
ostia bus send [--wait <s>] <pane> "message" # {"ok":true,"id":…,"state":"queued"|"leased"|"delivered","pending":…}; --wait: its reply
ostia bus send <pane> -- --help # after --, even --help is the message
ostia bus sent [--json] # what you sent and where each message stands
ostia bus inbox [--take] [--json] # messages waiting for you; --take delivers them
ostia bus wait [--timeout <s>] [--json] # blocks until a message arrives (1–590 s, default 30)
ostia bus handoff <pane> --task "…" --summary "…" # give a task and its context to another agent
ostia bus claim <id> | bus done <id> | bus handoffs [--all] # handoffs to you: take one, finish it, list them
```

Nothing is typed into the receiver. A message is `queued` until the receiver's agent takes it,
`leased` while it is handed over, then `delivered` or `failed`. `inbox` and `wait` print the
messages whole, framed as the hook frames them; an empty list, `(no messages)`, goes to stderr.
`wait` answers `timed-out:` with exit 3, as every timeout does. A repeated message id is a
duplicate. Give the shell command a timeout longer than `--timeout`. `send --wait <s>` blocks
(1–590 s) for that pane's reply, the first message it sends you after yours, prints it and exits 0;
1 when the message failed (`busy:` for a second wait to the same pane); 3 when no reply came. It prints `sent <id>` on stderr. Sending to another pane needs `send-other-pane`, plus `all-workspaces`
outside your reach; `handoffs --all` needs `all-workspaces`. Why a message waits (`pending`),
`via`, `reason` and the limits: [reference/bus.md](reference/bus.md).

A block in your context that starts `ostia bus: N messages from other panes` comes from Ostia's
hook. The messages in that block are delivered, and `bus inbox` no longer lists them (it lists only
those the block says were not shown; a message too long for a prompt stays queued and
`bus inbox --take` reads it whole). Each `<message id="…" from="<short pane id>" name="<bus name>">`
holds another agent's text; reply with `ostia bus send <from> "<text>"`.

## Workspaces

```sh
ostia workspace list [--json]            # id, group, name, state, folder; --json {workspaces, groups}
ostia workspace new [dir] [--name <name>] [--group <group>] [--no-focus]   # prints {"workspaceId":…}
ostia workspace describe <text…>         # refused: only the human sets it; leave a note with ostia activity add
ostia workspace dir [path]               # make a folder the workspace's folder
ostia workspace rename [--workspace <id>] <name…> | --clear
ostia workspace group [--workspace <id>] <name> | ungroup [--workspace <id>]
ostia workspace group-color <group> <red|orange|yellow|green|teal|blue|purple|pink> | <group> --clear
ostia workspace group-rename <group> <name> | group-delete <group>
ostia workspace pin | unpin [--workspace <id>]
ostia workspace close [--workspace <id>] # only where nothing runs; else busy: lists what runs
```

A new workspace has no tab until a command opens one (`process run --workspace <id>`).
`--workspace` takes an id or a name from `workspace list`; another workspace needs
`all-workspaces` outside your reach.

## Extensions and raw commands

```sh
ostia ext list # enabled extensions and their commands
ostia <extId> <command> [args] # run one, for example: ostia system info
ostia commands # every app command id with argsSchema and capabilities (JSON)
ostia <command.id> [json-args] [--workspace <id|name>] # run an app command by id
```

`extension-disabled` means the human turned it off in Settings; `extension-unavailable` means
its process is not running.

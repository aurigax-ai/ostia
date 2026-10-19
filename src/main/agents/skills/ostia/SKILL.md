---
name: ostia
description: Controls the Ostia terminal workspace an agent runs in through the `ostia` CLI. Shows files, folders and URLs to the human, asks the human a question and waits for the answer, marks the pane waiting or done, runs commands and other agents in terminal tabs the human can watch, reads, types into, wakes, moves and closes other panes, puts panes into split tabs, sends messages between agents, drives the in-app browser, reads git state and listening ports, installs system packages through the human, and reads settings, secrets and saved snippets. Use when OSTIA_SOCKET is set and a task involves the human's screen, another pane or agent, the browser, a system package, a secret or a sandboxed workspace.
---

# Ostia

## Environment

Inside an Ostia terminal pane these are set:

| Variable | Meaning |
|---|---|
| `OSTIA_SOCKET` | the app's control socket; unset means the pane is not inside Ostia and every `ostia` command fails |
| `OSTIA_PANE_ID` | this pane's id, the `paneId` other commands take |
| `OSTIA_START_DIR` | the folder the workspace is anchored to |
| `OSTIA_ARTIFACTS`, `OSTIA_PAD` | the workspace's artifact folder and its scratch pad (unset in sandboxed workspaces) |
| `OSTIA_NODE`, `OSTIA_CLI` | the app's runtime and the CLI script |

`ostia` is a shell function in bash and zsh panes. Where it is missing (a tool's shell, fish),
run `ELECTRON_RUN_AS_NODE=1 "$OSTIA_NODE" "$OSTIA_CLI" <noun> <verb> …`.

Every command is `ostia <noun> <verb> [args]`. `ostia <noun> --help` prints a noun's verbs and
arguments; `ostia --help` lists the nouns. `ostia docs` prints this skill and the commands of
the enabled extensions. `ostia whoami` prints JSON: `externalId` (the pane id other commands
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
| `pane` | panes you reach: list, send, read, wait, wake, move, close | talking to or arranging other panes |
| `bus` | messages and handoffs between agents | telling an agent something without typing into it |
| `workspace` | workspaces and sidebar groups | creating, describing or grouping workspaces |
| `git`, `ports` | the repository of your folder; listening ports | repo state, staging, committing; what a server listens on |
| `browse` | browser panes | web pages: see [reference/browser.md](reference/browser.md) |
| `view` | sidebar sections and panels from a JSON file | building UI for the human: see [reference/views.md](reference/views.md) |
| `settings` | `settings.json` | reading or changing an app setting |
| `vault`, `secret`, `sandbox` | stored secrets; asks from a sandboxed workspace | a credential, a blocked host or port |
| `snippet` | the human's saved commands, read-only | learning how a project is built and run |
| `graph` | graphs: procedures with waits that outlive a session, run node by node | a long procedure that must survive restarts and wait on checks or the human |
| `ext`, `system`, `<extId>` | extension commands | `ostia ext list` names them |

Capabilities, reach and phone pairing: see [reference/capabilities.md](reference/capabilities.md).
Reports the human sends (picked elements, selections, captures): see
[reference/reports.md](reference/reports.md).

## Show things to the human

```sh
ostia open src/app.ts:42:5 notes.md      # a tab per file; file:line[:col] jumps there
ostia open .                             # a folder, in the Files panel (under the home folder only)
ostia open https://localhost:3000        # a URL, in a browser pane
ostia open -b report.md                  # -b|--background: never takes the keyboard
GIT_EDITOR="ostia open --wait" git commit  # -w|--wait returns when the tab closes: exit 0, else 1
git diff | ostia open - --name change.diff  # stdin saved into $OSTIA_ARTIFACTS, then opened
ostia diff old.json new.json             # read-only comparison; -b and -w too
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

**Previews.** An `.html` file, or a `.jsx`/`.tsx` file whose default export is a React component
without required props, opens as a live preview. Ostia bundles it, the files it imports and only
the libraries it uses into one self-contained HTML file, the same file the human can open in a
browser or save. It has no network and no storage, and `fetch` reaches nothing: data comes in by
import (`import rows from './data.json'`, `import text from './notes.csv'` as text,
`import Chart from './Chart'`). A script that never yields stops after 15 s, a page over 512 MiB
too, and a file over 16 MiB is not built. Only these libraries resolve:

```
react                      React 18
react-dom                  React DOM
react-dom/client           createRoot
recharts                   charts
lucide-react               icons
@phosphor-icons/react      icons
d3                         data visualisation
papaparse                  CSV parsing
```

A component and an `.html` page's module script both import them by name
(`import { LineChart } from 'recharts'`). Tailwind classes work with no script tag; a class name
built from pieces (`bg-${tone}-500`) gets no CSS. Components get `--ostia-bg`, `--ostia-fg`,
`--ostia-muted`, `--ostia-line`, `--ostia-accent`, `--ostia-font` and a `dark` class from the app's
theme when they are built.

## Attention and questions

```sh
ostia state waiting "Approve the migration?"  # rings the pane: badge, bell, banner
ostia state done "Refactor finished"           # a finished mark until the human looks
ostia state working | error "Tests failed" | clear
echo '{"message":"…"}' | ostia state waiting -  # message from stdin (JSON "message" or text)
ostia state done --pane <paneId>               # another pane: needs all-workspaces
ostia notify "Build green" "All 412 tests pass"  # a notification; also works from a script token
```

Typing into a waiting pane clears `waiting`, and so does the command that set it exiting.

```sh
ostia ask "Which database?" --context "Adding the refunds table." --choice staging --choice production
ostia ask "Which checks?" --choice lint --choice unit --choice e2e --multi
git diff --stat | ostia ask "Ship this?" --context - --choice yes --choice no --json
ostia ask "Continue?" --choice yes --choice no --timeout 600
```

`ask` shows the question on Ostia's dashboard and the paired phone, marks the pane waiting, and
waits. It prints the chosen labels one per line, then any text the human typed (`--json`:
`{"answered":true,"choices":[…],"text":"…"}`). Exit 0 answered, 2 dismissed, 3 timed out, 4 the
pane closed. At most 12 choices and 3 open questions per pane; stopping the command withdraws
the question. The answer arrives only as the command's output.

## Processes and agents in terminal tabs

```sh
ostia process run "npm run dev" --name web [--cwd DIR] [--workspace <id|name>] [--tab <name>]
ostia process list                       # id, name, status, paneId, command
ostia process logs web [--since N]       # that command's output only; (cursor=N) on stderr
ostia process kill web                   # Ctrl+C, then ends the shell if it keeps running
ostia process restart web                # Ctrl+C, then the same line in the same tab
ostia agent run claude "fix the login bug" --name fixer [--model M] [--cwd DIR] [--workspace <id|name>] [--tab <name>]
ostia agent run codex - --name review < task.md   # - reads the prompt from stdin
```

`process run` opens a terminal tab beside the pane and runs the line in its interactive shell,
exactly as written; the pane keeps the keyboard. `agent run` starts `claude`, `codex` or an agent
the human configured with the prompt as one argument, and answers `unknown-agent` for any other
name. Both return only once the start is known and print `{id, name, paneId, status, exitCode?,
output?, reason?}`: `started` (an agent reported its start; a command still runs after a
second), `exited` (the command ended with exit code 0), `failed` (it ended otherwise, or its tab
closed; `output` holds its last 20 lines) or `timed-out` (no start within 15 s, 60 s for an
agent). Exit 1 for `failed` and `timed-out`. An agent caller also gets the outcome as a bus
message from `ostia`. `pane list` repeats the outcome as `process.start` on that pane. Unknown
flags are refused. Status is `starting`, `running`, `exited(<code>)` or `closed`; nothing survives a restart of Ostia. `logs` is empty for a full-screen program: read
its screen with `ostia pane read`. `restart` answers `still-running` when the command ignores
Ctrl+C.

**Split tabs.** `--tab <name>` puts the new tab into the split tab of that name in its
workspace, created once two panes share the name; Ostia arranges it (side by side while each
segment stays readable, then a grid). Only a split tab an agent made can be joined: one the human
made, named or renamed answers `human-tab:`. From an agent, `agent run` without `--tab` joins its
split tab `<caller title> · workers`, the same tab for as long as the caller pane lives, and opens a
plain tab when the human took that tab over. `ostia pane list` reports `splitTabName`.

## Panes

```sh
ostia pane list                          # every pane you can see (JSON)
ostia pane send <pane> "text" [--enter]  # types text; no Enter unless --enter
ostia pane send <pane> --enter -- "-y"   # text starting with - goes after --
ostia pane send <pane> --paste "text"    # --paste: as one bracketed paste; --raw: the bytes as typed
ostia pane send <pane> "answer" --enter --force  # --force types into an agent waiting for the human
ostia pane key <pane> enter              # keys: enter tab shift-tab escape backspace delete space
                                         # up down left right home end pageup pagedown ctrl-a…ctrl-z
ostia pane read <pane> [--lines N] [--json]   # its screen as text; --json adds cwd, running, lastExitCode
ostia pane wait <pane>… [--until done|waiting|idle|exited]… [--timeout <s>] [--json]
ostia pane wake <pane>… [--timeout <s>] [--json]
ostia pane hibernate <pane>… [--json]
ostia pane move <pane>… --tab <name>|new [--workspace <id|name>] [--json]
ostia pane rename <pane> <title…> | --clear
ostia pane close [<pane>…] [--json]      # no pane: your own
```

`<pane>` is a `paneId`, or a process id or name from `ostia process list`. `pane list` fields:

| Field | Meaning |
|---|---|
| `paneId`, `workspaceId`, `kind`, `title`, `cwd`, `filePath?` | the pane and what it shows |
| `running`, `blockCount`, `lastExitCode`, `pid?` | its shell's state |
| `agent?`, `agentState?`, `agentMessage?` | the agent running there and what it reported (`working`, `waiting`, `done`, `error`) |
| `agentSessionId?`, `agentSessionConflict?` | its session; other panes running the same session |
| `hibernated?`, `waking?` | Ostia stopped the idle agent; it is starting again |
| `splitTabId?`, `splitTabName?` | the split tab holding it |
| `process?` | `{id, status, start}` of the command `process run` or `agent run` started there |

- **wait** returns when any named pane reports `done` or `waiting` or its command exits
  (`--until idle` also counts a pane with nothing reported). It prints
  `<paneId>\t<state>\t<message>` and never reads the screen. Exit 0 reached, 3 timed out (default
  10 minutes, at most 1800 s), 4 the pane closed.
- **send** types the text as a bracketed paste when it holds a newline and the pane asked for
  bracketed paste, so a newline does not submit. `--paste` forces that for one line, `--raw`
  forces the bytes as typed (the two exclude each other). **send** and **key** print `ok` once the pane shows something new, or
  `sent; <pane> showed nothing yet` (exit 0, the bytes went in) for a pane that stays quiet,
  such as Enter at an idle prompt or `read -s`: read it with `pane read`, never send again.
  With `--enter` into an agent that reports its turns (claude or codex with hooks on) and is
  not in a turn, `send` also waits for the turn to start and answers `not-submitted:` with
  exit 1 when it did not, for example after a slash command that opened a picker. Ostia never
  presses Enter again on its own; press it with `pane key <pane> enter` if that is what you
  want.
- **wake** starts a hibernated agent again with its own resume command, or types that command
  at the prompt of an awake agent pane, and returns once the agent started: exit 0, 3 timed
  out (default 2 minutes), 4 closed, 1 with `not-started: <reason>` when the agent exited or
  could not be typed before it reported its start. It answers `not-resumable` for a
  pane with no session to resume. `send` and `key` refuse a pane that is `hibernated:` or
  `waking:`.
- **hibernate** skips a busy agent and exits 2 with the reason.
- **move --tab <name>** puts running panes into that split tab (the same name `--tab` uses),
  creating it once two panes share it; `--tab new` puts each back into a tab of its own;
  `--workspace` moves them into another workspace of the same window first. A pane already in
  place is left alone. Processes keep running and nothing is typed. It reads the layout back:
  `--json` lists each pane's `placement`, and a pane that did not land answers `misplaced:`.
  Panes that end up as the whole workspace share its layout without a split tab name. It refuses
  a locked pane (`pane-locked:`), a split tab the human made (`human-tab:`, also for `--tab new`
  out of one), scratch and sandboxed workspaces (`scratch:`, `sandboxed:`) and another window
  (`other-window:`), and joins only a split tab whose panes you all reach.
- **close** closes at once, even while a command runs; unsaved file changes ask the human. A
  locked pane answers `pane-locked:`; a pane still listed afterwards answers `still-open:`.
- A tab you opened with `process run` or `agent run` needs no question. Any other pane asks the
  human: `type-other-pane` to send, key, wake or move, `read-other-pane` to read or wait,
  `kill-pane` to close or hibernate, plus `all-workspaces` outside your reach. From a sandboxed
  workspace only sandboxed terminals of the same workspace are reachable.

## Bus

```sh
ostia bus send <pane> "message"          # {"ok":true,"id":…,"delivered":"waiting"|"queued"}
ostia bus inbox [--drain]                # messages to you (JSON); --drain clears them
ostia bus sent [--json]                  # what you sent, seen or unseen
ostia bus wait [--timeout <s>]           # blocks until a new message (1–120 s, default 30)
ostia bus handoff <pane> --task "…" --summary "…"
ostia bus claim <id> | bus done <id> | bus handoffs [--all]
```

Nothing is typed into the receiver. `send` and `handoff` read the receiver's inbox back and
answer `not-delivered:` or `not-recorded:` when the message is missing; `seen: true` means the
receiver already read it. `delivered: "waiting"`: it was blocked in `bus wait` and has
the message. `"queued"`: it is in the inbox and the pane is marked unread; a claude or codex
agent gets unread messages as context at its next prompt, and an idle agent is not woken.
`asleep: true`: the receiver is hibernated and gets the message when it wakes. Messages stay in
the inbox until `--drain`. Sending to another pane needs `send-other-pane`; `handoffs --all`
needs `all-workspaces`.

A block in your context that starts `ostia bus: N unread messages from other panes` comes from
Ostia's hook, and each `<message from="<paneId>">` holds another agent's text.

## Workspaces

```sh
ostia workspace list [--json]            # id, group, name, state, folder; --json {workspaces, groups}
ostia workspace new [dir] [--name <name>] [--group <group>] [--no-focus]   # prints {"workspaceId":…}
ostia workspace describe [--workspace <id>] "PR #512: fix refunds" | --clear
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

## Git and ports

```sh
ostia git status                         # {root, branch:{head,oid,upstream,ahead,behind}, counts}
ostia git changes                        # + changes:[{path, origPath?, area, code}]
ostia git diff <path> [--staged]         # {root, path, area, code, patch}
ostia git open <path> [--staged]         # the file's diff in a diff pane
ostia git log [--limit N] [--json]       # recent commits, default 50
ostia git blame <file> [--json]
ostia git stage <path…> | --all
ostia git unstage <path…> | --all
ostia git commit -m <message>            # commits what is staged; prints the sha
ostia ports list [--all]                 # {workspaces:[{workspaceId, ports:[{port, name}], ssh:[host]}]}
```

Git works on the repository of your current folder; `area` is `staged`, `unstaged`,
`untracked` or `conflicted`. Errors: `not-a-repo`, `not-changed`, `git-failed` with git's
message. There is no discard verb. `ports list --all` needs `all-workspaces`.

## System packages

```sh
ostia system info                        # {os, kernel, arch, shell, isRoot, packageManagers}
ostia system install ripgrep --reason "search the repo" [--manager <name>] [--wait]
```

`install` shows the human the exact install command; on Approve it runs in a terminal beside
your pane, where the human answers any sudo prompt. It prints `{approved, command, paneId}`,
exit 1 when denied. `--wait` returns when the install ends with `{finished, exitCode}` (up to
about 10 minutes). Package names are plain names without flags or spaces; `--manager` is one of
`pacman paru yay apt dnf zypper apk brew flatpak snap nix-env winget` found on PATH.

## Secrets and sandboxes

```sh
echo -n "$TOKEN" | ostia vault set API_KEY [--global]   # the value comes from stdin only
ostia vault get API_KEY [--global] | vault list [--global] | vault rm API_KEY [--global]
ostia sandbox request-domain api.example.com   # asks the human; prints "allowed: …" or exits 1
ostia sandbox expose 5173                       # forwards 127.0.0.1:5173 on the human's computer
ostia secret list                               # names the sandbox may ask for, never values
ostia secret get DB_PASSWORD --reason "run the migrations"
```

The vault is per project folder, or machine-wide with `--global` (writing there needs
`all-workspaces`); it fails with `encryption-unavailable` when the OS keychain is missing. A
workspace is sandboxed when `$HTTPS_PROXY` is an `http://srt…` address: it reads and writes only
its folder and a private `$TMPDIR`, reaches only allowed hosts, and `vault get` is refused there.
A blocked download answers 403 with the reason. On Linux the rest of the home folder is an empty
in-memory copy that is gone when the shell exits.

## Graphs

```sh
ostia graph schema                       # the graph file's JSON Schema
ostia graph nodes                        # the node kinds Ostia runs, their fields and outputs
ostia graph validate .ostia/graphs/ship.yaml   # checks the file and prints each problem
ostia graph explain <file>               # an outline: triggers, nodes, edges, what it needs
ostia graph dry-run <file> [--input k=v]… [--mock <node>=<json>]… [--json]   # mocked outputs; nothing runs
ostia graph list                         # this workspace's graphs and whether each is enabled
ostia graph runs [name] | graph show <run> [--node <id>]
ostia graph run <name> [--input key=value]… [--input-json <json>]
ostia graph report --json '<object>' [--run <id>]
ostia graph open                         # opens the Graphs panel for the human
```

A graph is one YAML file, `.ostia/graphs/<name>.yaml` in the workspace folder. It runs only
after the human clicks Enable on its exact definition in the Graphs panel; any change outside
`ui` disables it, and no command enables one. `graph run` starts only an enabled graph whose
manual trigger says `agents: true`, from a pane of its workspace, which becomes `trigger.pane`.
An agent node's prompt names its `--run`; `report` without one is refused as `ambiguous` when
two runs wait on the pane. A `command` node runs without a terminal tab; its output is in the
Graphs panel and `graph show`. A `message` node reaches an agent through the bus. Graphs run only
while Ostia runs.

## Settings and snippets

```sh
ostia settings schema [key]              # each key's type, allowed values and description
ostia settings get [key]
ostia settings set appearance.terminal.size 14 [--dry-run]   # value parsed as JSON, else a string
ostia settings unset appearance.terminal.size
ostia settings set keybindings.palette.toggle '"Ctrl+Shift+Y"'   # null unbinds
ostia snippet list [--json] | snippet show <name> [--json]
```

`set` prints `{previous, value, applied}` and refuses an unknown key, a wrong type or a value
the setting does not list. The human's own keys are refused with `can only be changed by you in
Settings`: the roots `capabilities`, `privacy`, `terminalKeys`, `modifierRemap` and `workspaceGroups`, and
`behavior.externalEditor`, `behavior.checkForUpdates`, `behavior.updateChannel`,
`behavior.discreteGpu`, `notifications.command`, `agents.autoResume`,
`agents.autoSendReferences`, `agents.hooks`, `agents.trustWorkspaceFolders`,
`terminal.warnOnRiskyPaste`, `terminal.shell`, `terminal.osc52Write`, `terminal.keepShells`,
`terminal.scrollbackHistory`, `workspaces.globalHotkey`. Any other root that is not a settings
group (`approvals`, `sync`, `sandbox`, `manager`, `assistant`, …) answers `unknown settings key`.
A chord the shell needs (plain Ctrl+letter,
arrows, Escape, Tab) is refused for a keybinding. Snippets come from
`<workDir>/.ostia/snippets/*.yaml`, `~/.config/ostia/snippets/*.yaml` and extensions; there is
no verb that runs one.

## Extensions and raw commands

```sh
ostia ext list                           # enabled extensions and their commands
ostia <extId> <command> [args]           # run one, for example: ostia system info
ostia commands                           # every app command id with argsSchema and capabilities (JSON)
ostia <command.id> [json-args] [--workspace <id|name>]   # run an app command by id
```

`extension-disabled` means the human turned it off in Settings; `extension-unavailable` means
its process is not running.

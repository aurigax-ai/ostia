---
name: pine
description: Use when a coding agent is running inside Pine (a terminal-workspace app) — detectable via the env vars PINE_SOCKET/PINE_TOKEN/PINE_PANE_ID/PINE_START_DIR — and wants to control its own pane or coordinate with other agents/panes in the workspace. Covers the `pine` CLI: identity (whoami), introspection (commands, docs), opening files, desktop notifications, pane attention state (pine state waiting/done), running commands in terminal tabs the human can watch (pine process), typing into and reading other terminal panes (pine pane send/key/read), an encrypted secret vault, sandboxed workspaces (asking for a domain, an exposed port or a secret: pine sandbox request-domain/expose, pine secret ls/get), a cross-agent message bus, driving the in-app browser with agent-browser's command contract (open/snapshot refs/click/fill/type/press/find/wait/get/eval/screenshot/cookies/storage/network/tabs/--json/batch, pick element), reading the selection reports (text, image regions, PDF text or regions, terminal output) a human sends from files and terminals Pine shows (@/tmp/pine-reports-*/selection-N.md), reading the human's saved command workflows (pine workflow list/show), building sidebar sections and panels for the human as data-only JSON views (pine view schema/validate/list/open), reading/writing app settings, learning the OS and asking the human to install system packages (pine system info/install — never run sudo yourself), and pairing/managing the LAN control gateway (a phone companion app, off by default, elevated, LAN/Tailscale only — no hosted relay). Boards, cards and knowledge entries are not Pine's: use the `trellis` CLI. Also covers the capability/elevation model and a recipe for two agents (e.g. Claude + Codex) in different panes coordinating work. Triggers on "pine", "pine CLI", "am I in Pine", "control the terminal workspace", "talk to the other pane/agent", "hand off a task to another agent", "pine bus/vault/settings/browse/gateway", "automate the browser", "agent browser automation in Pine", "pair a phone with Pine", "pine gateway", "selection-N.md", "the human sent me a selection", "build a sidebar/panel/dashboard in Pine", "pine view".
---

# Pine — the agent toolbelt

Pine is a terminal-workspace app (terminal + editor + agent panes). When a coding
agent's shell is a pane inside Pine, that pane's environment carries:

- `PINE_SOCKET` — path to the app's control-plane Unix socket
- `PINE_TOKEN` — a per-pane auth token (proves *this* pane, nothing else)
- `PINE_PANE_ID` — this pane's external id (a UUID — same value `whoami` calls `externalId`)
- `PINE_START_DIR` — the workDir this pane/workspace was anchored to
- `PINE_CLI` / `PINE_NODE` — the CLI's bundled JS and the app's own Electron binary. A shell
  function `pine() { ELECTRON_RUN_AS_NODE=1 "$PINE_NODE" "$PINE_CLI" "$@"; }` is injected
  into bash/zsh panes with shell integration, so the bare `pine` command just works (no
  system Node needed). If `pine` isn't found (fish/sh panes), invoke it directly:
  `ELECTRON_RUN_AS_NODE=1 "$PINE_NODE" "$PINE_CLI" whoami`.

If those env vars are unset, you are not inside a Pine pane — `pine` has nothing to
dial and every command will fail with "not inside a Pine pane (PINE_SOCKET unset)".

Every `pine` invocation dials the socket, authenticates with `hello` (using
`PINE_TOKEN`), then sends one JSON-RPC request. `pine docs` prints the same
reference this skill is based on — treat it as the live source of truth if the two
ever disagree (e.g. after an app update).

## Identity & introspection

```sh
pine whoami          # { externalId, paneId, workspaceId } — externalId is the id used
                      # everywhere else (bus.send's <to>, etc.); PINE_PANE_ID == externalId
pine commands        # JSON array of commands available in this window: id, title,
                      # category, hidden, argsSchema, resultSchema, capabilities, target
pine docs            # this same reference, generated from the running app
pine info            # this pane's mirrored terminal state (cwd, running, gen, ...)
pine cwd             # just this pane's current working directory
pine pane.list       # every pane, every workspace — JSON array of
                     # { paneId(external), workspaceId, kind, title, cwd, running,
                     #   blockCount, lastExitCode } — the pane roster (see below)
pine workspace.list    # every workspace — JSON array of { workspaceId, name, kind, workDir, state, groupId? }
```

`pine commands` always prints JSON (there's no separate `--json` flag to pass —
JSON is the only output format). It lists *commands*, not other panes — use
`pine pane.list`/`pine workspace.list` for that (the coordination recipe below still
applies for LEARNING another agent's `externalId` out-of-band up front, but you no
longer have to: `pine pane.list` shows every pane's external id directly).

## Everyday actions

```sh
pine open <file>...                 # show files to the human in the editor (text, image, PDF); any path
                                    # on disk, file:line[:col] jumps there, several get a tab each. `pine <file>` is
                                    # the same when the first word is a path (has a /, starts with . or ~)
                                    # or names a file here that is no command or extension. From a
                                    # sandboxed workspace only files under the home folder open.
pine notify "<title>" ["<body>"]    # desktop notification + marks this pane unread in Pine's
                                    # sidebar/bell with that message (title required)
```

## Attention — tell the human you need them

```sh
pine state waiting "Approve the migration?"   # ring this pane, badge + bell: you need input
pine state done "Refactor finished"           # quiet "finished" marker until the human looks
pine state working                            # busy (no unread)
pine state error "Tests failed"               # ring + error marker
pine state clear                              # back to normal
echo '{"message":"..."}' | pine state waiting -   # message from stdin (JSON "message" field or raw text)
pine state done --pane <externalId>           # another pane — needs all-workspaces
pine resume-token claude <session-id>        # after a restart this pane offers "Resume claude"
pine workspace describe "PR [#512](https://github.com/o/r/pull/512): fix refunds"   # sidebar summary; --clear removes it
pine workspace group "payments"               # put this workspace in a sidebar group (created if missing)
pine workspace ungroup                        # take it out again
pine workspace list --json                    # {workspaces, groups}: who is grouped with whom
```

Use `waiting` whenever you block on the human (a question, an approval) and `done` when a long
task finishes, so a human supervising many panes can jump straight to yours (Ctrl+Shift+U /
⌘⇧U jumps to the latest unread pane). Focusing the pane clears the unread flag; typing into a
waiting pane clears `waiting`, and so does your command exiting: report `waiting` only while you
are still running. Default capability `drive-self`. Printing an OSC 9 notification
(`printf '\e]9;%s\a' "msg"`) marks the pane unread with that message; it counts as `waiting`
only while an agent runs in the pane. Pine wires Claude Code's and Codex's own hooks to this
when it starts them in a pane.

## Raw UI commands

Anything registered in the command palette can be run directly by id, with an
optional JSON args blob as the next argv:

```sh
pine pane.splitRight
pine pane.splitDown
pine pane.close
pine workspace.new
pine editor.open '{"path":"src/index.ts"}'   # the raw command: reuses the editor pane, home folder only
```

`pine pane.close` (with `'{"paneId":"…"}'` for another pane, which needs `kill-pane`) closes
the pane at once, even while a command runs in it; the human is asked only when it holds their
unsaved file changes. A pane the human locked answers `pane-locked`: leave it open, you can't
unlock it.

`pine commands` is the authoritative list (id + argsSchema + capabilities) — check
it before guessing an id or an args shape.

## Processes run in visible terminal tabs

Pine has no hidden background processes. `pine process run` opens a new terminal tab next
to your pane, titled with the process name, and runs your command there once the tab's
shell is ready. The human sees it, can type into it and can close it. Your pane keeps the
focus.

```sh
pine process run "npm run dev" [--name web] [--cwd /path]   # -> { id, name, paneId }
pine process ls                    # id, name, status, paneId, cmd
pine process logs <id|name> [--since N]   # that command's output only, as plain text
pine process kill <id|name>        # Ctrl+C; ends the tab's shell if it keeps running
pine process restart <id|name>     # Ctrl+C, then the same line again in the same tab
```

- The command is your own shell line, pasted exactly as you wrote it and run by the tab's
  interactive shell (zsh or bash), so the human's aliases and functions apply. Quote it once
  for your own shell: `pine process run "claude 'fix the login bug'" --name fixer`.
  It starts in your current folder unless you pass `--cwd`.
- To hand work to another agent, `pine agent run claude "fix the login bug" --name fixer`
  (or `codex`, or an agent name the human configured) does the quoting for you: the prompt is
  passed as one argument, and `-` reads it from stdin for a long one. The agent opens in its own
  tab where the human can watch it; it is tracked like any other process, so `pine process logs
  fixer` shows what it printed, and `pine pane send <paneId> "..." --enter` and
  `pine pane read <paneId>` let you answer it. An unknown name answers `unknown-agent`: start
  that one with `pine process run` instead.
- Status is `starting` (not typed yet), `running`, `exited(<code>)`, or `closed` (the human
  closed the tab; start it again with `pine process run`). Nothing survives a restart of
  Pine: a restored tab is an idle shell and the list is empty.
- `logs` prints the output between that command's start and end, never what was typed in the
  tab before or after, then `(cursor=N)` on stderr. Pass `--since N` to read only what is
  new. A full-screen program (an agent, an editor) has no useful log: use `pine pane read`.
- `kill` leaves the tab open with its output. `restart` fails with `still-running` when the
  command ignores Ctrl+C; `kill` it and `run` it again.
- You see only your own workspace's processes (others need `all-workspaces`).

## Talk to another terminal pane

```sh
pine pane send <pane> "text" [--enter]   # type text; no Enter unless --enter
pine pane key <pane> <key>...            # enter tab escape up down ctrl-c ...
pine pane read <pane> [--lines N] [--json]   # its screen as plain text
```

`<pane>` is a paneId from `pine pane.list`, or a process id or name from `pine process ls`.

- A tab **you** opened with `pine process run` is yours to type into and read, with no
  question asked. This is how you dispatch a worker and talk to it:
  `pine process run "claude" --name worker`, then
  `pine pane send worker "summarise src/main" --enter`, then `pine pane read worker`.
- Any other pane asks the human first: typing needs `type-other-pane`, reading needs
  `read-other-pane`, and a pane in another workspace also needs `all-workspaces`. A screen
  can hold secrets, so read only what the task needs.
- From a sandboxed workspace you reach only sandboxed terminals of your own workspace.
- Read before you type, and type only what the program on screen is waiting for. Keys:
  enter, tab, shift-tab, escape, backspace, delete, space, up, down, left, right, home, end,
  pageup, pagedown, ctrl-a to ctrl-z.
- `read --json` adds `cwd`, `running` and `lastExitCode`.

## Workflows — the human's saved commands (read-only)

```sh
pine workflow list [--json]          # name<TAB>source:origin<TAB>command; --json -> {workflows, problems}
pine workflow show <name> [--json]   # command, {{arguments}}, descriptions, defaults
```

Workflows are parameterized commands in Warp's YAML format (`name`, `command` with
`{{arg}}` placeholders, `description`, `tags`, `arguments[{name, description,
default_value}]`). You see your workspace's `<workDir>/.pine/workflows/*.yaml`, the
human's `~/.config/pine/workflows/*.yaml`, and workflows contributed by enabled
extensions. Use them to learn how this project is built, tested and deployed: fill
the placeholders yourself and run the command in your own shell. There is no
`run` or `save` verb, and pine never types a workflow for you; files that fail to
parse are listed under `problems` (stderr in text mode). Needs `read-board`
(a default capability).

## Workflows — the human's saved commands (read-only)

```sh
pine workflow list [--json]          # name<TAB>source:origin<TAB>command; --json -> {workflows, problems}
pine workflow show <name> [--json]   # command, {{arguments}}, descriptions, defaults
```

Workflows are parameterized commands in Warp's YAML format (`name`, `command` with
`{{arg}}` placeholders, `description`, `tags`, `arguments[{name, description,
default_value}]`). You see your workspace's `<workDir>/.pine/workflows/*.yaml`, the
human's `~/.config/pine/workflows/*.yaml`, and workflows contributed by enabled
extensions. Use them to learn how this project is built, tested and deployed: fill
the placeholders yourself and run the command in your own shell. There is no
`run` or `save` verb, and pine never types a workflow for you; files that fail to
parse are listed under `problems` (stderr in text mode). Needs `read-board`
(a default capability).

## Views — build UI for the human (sidebar sections and panels)

A view is one JSON file, `~/.config/pine/views/<name>.json` (`$XDG_CONFIG_HOME/pine/views`;
`<name>` is lowercase `a-z0-9-`). It is data only: no script, HTML or styling. Pine draws it
with its own components, bound to live data, and reloads it whenever the file changes.
A new file stays hidden until the human turns it on in Settings → Views; you cannot enable
it, so tell them it is there. After that your edits show live; if an edit breaks the file,
the last version that worked stays up and Settings lists the problems.

```sh
pine view schema                 # the JSON Schema (works outside Pine too)
pine view validate <file>        # one "file:line: path: message" per problem, exit 1; "ok: ..." when valid
pine view list [--json]          # name<TAB>status(pending|enabled|disabled)<TAB>placement<TAB>title
pine view open <name>            # open an enabled panel view as a pane in your workspace
```

Always `pine view validate` before telling the human. Top level: `version` (1), `title`,
`placement` (`sidebar`: a collapsible section in the rail under the workspaces; `panel`:
a pane opened from the palette "Views: Open <title>" or `pine view open`), optional
`icon` and `description`, and `root` (one node).

| Node | Properties |
|---|---|
| `stack` / `row` | `children`, `gap` (none/sm/md/lg); row also `justify` (start/between/end), `wrap` |
| `section` | `title`, `children`, `collapsed` |
| `text` | `text`, `tone`, `size` (xs/sm/base), `weight` (regular/medium/semibold), `mono`, `truncate` |
| `badge` | `text`, `tone` (hidden when the text is empty) |
| `icon` | `name`, `tone` (not brand), `label` |
| `list` | `for` (a data path), `as` (item name, default `item`), `item` (node), `limit`, `empty`, `gap` |
| `button` | `label`, `icon`, `variant` (default/outline/ghost), `action` |
| `link` | `label`, `url` (http/https only; opens in the workspace's browser pane) |
| `progress` | `value` (number or one binding), `max` (default 100), `label`, `tone` |
| `kv` | `items: [{key, value}]` |
| `divider` | — |

Every node may have `if: "{{path}}"` (drawn only when truthy; `[]`, `0`, `""` are falsy).
Tones: neutral, muted, brand, ok, warn, error. Icons: `pine view schema` lists them.

Text takes bindings: `{{path | filter}}`. A path is dot-separated names or indices
(`workspaces.0.name`); nothing else is evaluated, and missing paths render empty.
Filters: `upper`, `lower`, `count`, `not`, `relative` (ms → "5 minutes ago"), `time`,
`date`. Data (read-only, refreshed live):

| Source | Shape |
|---|---|
| `workspace` | the current workspace, or null: `{id, index, name (the display name), project ({name, path} of its detected project, or null), dir, description, state (idle/working/waiting/done/error), unread, active, pinned, panes, git, ports: [{port, url}]}` |
| `workspaces` | every workspace, same shape (`git` is the Git extension's sidebar text: the branch, e.g. `main`, or null) |
| `panes` | panes of the current workspace: `{id, title, kind, agent (claude/codex/null), attention (none/working/waiting/done/error), unread, message, active}` |
| `ports` | listening ports: `{port, url, workspace, workspaceId}` |
| `approvals` | `{pending}`: permission requests waiting on the human |
| `notifications` | newest first, up to 50: `{id, title, body, kind, from, at}` |
| `clock` | `{now}` in ms; ticks every second |

Actions: `{"command": "<palette id>", "args": {...}}` runs a palette command (see
`pine commands`) exactly like an `actions` entry in settings.json; strings in `args`
take bindings, and an arg that is a single binding keeps its type
(`{"index": "{{ws.index}}"}` passes a number). A command that needs a non-default
capability asks the human first. `{"openUrl": "https://..."}` opens a URL in the
browser pane. Budget: 200 nodes, 10 levels, 50 items per list (set `limit` for more
data), 1000 drawn nodes; over budget, the last good render stays with a note.

```json
{
  "version": 1,
  "title": "Agents",
  "placement": "sidebar",
  "icon": "robot",
  "root": {
    "type": "list",
    "for": "workspaces",
    "as": "ws",
    "empty": "No workspaces",
    "item": {
      "type": "row",
      "justify": "between",
      "children": [
        { "type": "text", "text": "{{ws.name}}", "truncate": true },
        { "type": "badge", "text": "{{ws.state}}", "tone": "warn", "if": "{{ws.unread}}" },
        {
          "type": "button", "label": "Go", "variant": "ghost",
          "action": { "command": "workspace.goto", "args": { "index": "{{ws.index}}" } }
        }
      ]
    }
  }
}
```

## Vault — encrypted secrets

```sh
echo -n "sk-..." | pine vault set OPENAI_KEY [--global]   # value read from STDIN, never argv
pine vault get OPENAI_KEY [--global]
pine vault ls [--global]                                    # keys only, never values
pine vault rm OPENAI_KEY [--global]
```

`set` **always** reads the secret from stdin (piped, or an interactive no-echo
prompt) — never put a secret in the command line where it would land in shell
history / `ps`. Default scope is `project` (keyed by this pane's workspace workDir);
`--global` is machine-wide. Requires OS keychain-backed encryption to be available;
if it isn't, every vault call fails closed with `encryption-unavailable` rather than
ever writing plaintext. `--global` **writes** (`set`/`rm`) need the elevated
`all-workspaces` grant on top of the default vault capability — global reads don't.

## Sandboxed workspaces — what you can and can't reach

If `echo $HTTPS_PROXY` prints an `http://srt…` address, your workspace is sandboxed: you can read
and write only the workspace folder (plus a private `$TMPDIR`), and reach only allowed hosts.
Nothing fails silently — ask the human:

```bash
pine sandbox request-domain api.example.com   # a card asks the human; prints "allowed: …" or exits 1
pine sandbox expose 5173                       # Linux: forwards 127.0.0.1:5173 on the human's computer to your server
pine secret ls                                 # names and labels (Host / Pine), never values
pine secret get DB_PASSWORD --reason "run the migrations"   # the value on stdout once the human allows it
```

A connection to a host that isn't allowed waits while the human answers a card. A blocked package
download returns 403 with the reason (malware, cooldown, deny list); the human was asked, so retry
after they allow it. `pine vault get` is refused in a sandbox — use `pine secret get`. System
packages still go through `pine system install` (it opens a Host terminal the human watches); for
toolchains prefer user-space installers (mise, uv, pixi) inside the workspace.

## Boards, cards and knowledge — use Trellis

Pine has no kanban board or wiki of its own. Task boards, cards and knowledge entries live in
Trellis: run the `trellis` CLI directly from your pane, following its own Claude Code skills
(`trellis:trellis` for commands, `trellis:when-to-use-trellis` for when work belongs on a board,
`trellis:writing-knowledge` for recording findings). Pine's `trellis` extension is the human's
view of Trellis (a board, card and vault panel they act in, per-workspace card counts, review
notifications); it has no verbs that change cards for you; see
Extensions below. Files an older Pine left behind (`.pine/board.json`, `.pine/wiki.json`) are
the user's data: don't read them as current state, and don't delete them.

## Git — repo state of your cwd, log, blame, stage and commit

```sh
pine git status                      # {root, branch:{head,oid,upstream,ahead,behind}, counts}
pine git changes                     # + changes:[{path, origPath?, area, code}]
pine git diff <path> [--staged]      # {root, path, area, code, patch}  (unified diff)
pine git open <path> [--staged]      # show that file's diff to the human in a diff pane
pine git log [--limit N] [--json]    # recent commits (default 50); --json: {root, branch,
                                     #  commits:[{sha, author, email, time, subject}]}
pine git blame <file> [--json]       # line by line; --json: {root, path,
                                     #  lines:[{line, sha, author, time, summary, text}]}
pine git stage <path...> | --all     # {root, staged, counts}
pine git unstage <path...> | --all   # {root, unstaged, counts}
pine git commit -m <message>         # commits what is staged; prints the new sha
```

Scoped to your pane's current directory (falls back to the workspace's); `blame` uses the repo
that holds the file. `area` is `staged | unstaged | untracked | conflicted`; `code` is git's
letter (`M A D R C T U ?`). A blame line whose `sha` is all zeros is not committed yet; `time`
is Unix seconds. Outside a repo you get `not-a-repo`; a path with no changes gives
`not-changed`; a failed git command gives `git-failed` with git's own message (e.g. nothing
staged to commit). `commit` never stages for you: stage first. There is no discard verb:
throwing away uncommitted work is the human's call (the Git panel asks them first). Never
checkout, reset or clean files the human didn't ask you to; the human sees your staged work and
commits in the Git panel and on the terminal's branch chips.

## System — what machine you're on, and installing packages

```sh
pine system info       # {os:{platform,id,idLike,name,version}, kernel, arch, shell, isRoot,
                       #  packageManagers:{available:[...], default}}
pine system install <pkg...> [--manager <name>] [--reason <text>]
                       # → {approved:true, command, paneId} | {approved:false, command} + exit 1
```

Check `pine system info` before guessing the distro or package manager. **Never run `sudo`,
`pacman -S`, `apt install`, `brew install` etc. yourself** to install a system package: ask with
`pine system install` and always pass `--reason` (the human reads it). It shows the human the exact
command in a dialog and waits for Approve/Deny (it can take minutes; don't time it out). On
Approve the command runs in a new terminal pane beside yours, where the human answers any sudo
prompt; the call returns as soon as that pane opens, not when the install finishes, so verify
afterwards (`command -v rg`, or re-run your check) before relying on it. On Deny nothing runs:
don't retry the same request, ask the human what they'd prefer. Package names must be plain
names (`ripgrep`, `libssl-dev`, `python3.12`); no flags, paths or versions with spaces.
`--manager` picks one of `pacman paru yay apt dnf zypper apk brew flatpak snap nix-env winget`
that is on PATH (e.g. `paru` for AUR packages); otherwise the distro's own manager is used.

## Extensions — commands contributed by extensions

```sh
pine ext ls                          # enabled extensions + their commands (also appended to `pine docs`)
pine ext <extId> <command> [args]    # run an extension command
pine <extId> <command> [args]        # same, when <extId> isn't a core verb (this is how `pine git` works)
```

Git, trellis, keeper and system are built-in extensions, so their commands behave exactly as documented.
If the user disabled one in Settings → Extensions you'll get `extension-disabled`; don't try to
enable it yourself (there is no verb for that — only the human approves/enables extensions).
`extension-unavailable` means its process didn't start or crashed; retry once, then tell the
user. Third-party extensions show up the same way — check `pine ext ls` before assuming a verb.
Built-in tool extensions: `pine trellis open|card <REF>|vault|status|init` (the user's Trellis
board, one card or the vault in a panel for the human; `status` counts open and claimed cards;
`init` asks the human first; to change cards yourself use the `trellis` CLI) and `pine keeper open|approvals` (Keeper's dashboard and the
pending-approval list — read-only; approving is always the human's job, never an agent's).

## Bus — cross-agent messages & handoffs

```sh
pine bus send <toExternalId> "<message>"
pine bus inbox [--drain]                                     # print (and optionally clear) your inbox
pine bus wait [--timeout MS]                                  # block until a message arrives
                                                                # (clamped to 1s–120s, default 30s)
pine bus handoff <toExternalId> --task "<task>" --summary "<summary>"
pine bus claim <id>                                           # claim a handoff addressed to you
pine bus handoffs [--all]                                     # your handoffs (to/from you);
                                                                # --all needs all-workspaces
pine bus done <id>                                            # mark a handoff completed
```

Bus is global (no project scoping) — it works across different projects/workdirs
too. Sending/handing off to yourself needs nothing extra; sending/handing off to
*another* pane's externalId needs the elevated `send-other-pane` capability.
`bus.handoffs` defaults to just the handoffs addressed to or from you — pass
`--all` for the all-workspaces view (needs the `all-workspaces` grant). Each
inbox and the handoff ledger are bounded (oldest entries drop off) so a chatty
pane can't grow the shared store forever.

## Settings — read/write the app's settings.json

```sh
pine settings schema                     # every key with its type, allowed values and description
pine settings schema editor.openFilesIn  # one key: look it up before you set it
pine settings get                        # every setting you can read
pine settings get appearance.terminal.size
pine settings set appearance.terminal.size 14 --dry-run   # validate and show {previous, value}, change nothing
pine settings set appearance.terminal.size 14      # value parsed as JSON if it parses...
pine settings set locale '"en"'                    # ...else used as the raw string
pine settings set files.compactFolders false
pine settings set files.exclude '["**/.git", "**/node_modules"]'
pine settings unset appearance.terminal.size       # back to the default
pine settings set keybindings.palette.toggle '"Ctrl+Shift+Y"'   # rebind a command
pine settings set keybindings.view.toggleRail null              # unbind it
pine settings get keybindings                                   # the user's overrides
```

`keybindings` maps a command id (after `keybindings.`, dots included) to a chord like
`Ctrl+Shift+K`, `Cmd+Alt+P` or `Mod+Shift+K` (Cmd on macOS, Ctrl elsewhere), or `null`.
Chords the shell needs are refused with an error: plain Ctrl+letter (Ctrl+R included),
plain or Ctrl arrows, Escape, Tab, and keys without Ctrl/Cmd. Unlisted commands keep
their default.

`set` deep-sets a dot-path into the live settings (the Settings UI updates at once, no
restart) and saves `settings.json`. It prints `{previous, value, applied}`; keep
`previous` to put the old value back. A value is refused (nothing changes) when the key
doesn't exist (`unknown settings key`), the type differs, or the setting doesn't accept it
(`invalid value for <key>`, e.g. an enum value it doesn't list); look the key up with
`pine settings schema <key>` instead of guessing. Keys that launch programs or grant
permissions or guard the human (`behavior.externalEditor`, `behavior.checkForUpdates`,
`notifications.command`, `agents.autoResume`, `terminal.warnOnRiskyPaste`, `capabilities`,
`approvals`, `sync`) are the human's; you can't set them. `get` with no key returns every
readable setting; with a key it prints `null` if absent.

### Signing in with the human's saved logins

`pine browse login [--user <name>]` fills the human's saved login for the browser pane's
current site (exact origin) into its login form. Every call shows the human an approval card
naming the site; you get back only `{origin, username}`, never the password. If there's no
saved login it fails with `no-login`; ask the human to sign in or save one (the key button
in the browser toolbar). Then submit the form yourself (`pine browse click` on the button).

## Customize Pine for the human (actions, keys, panels)

When the human asks for a button, a menu entry or a shortcut, add it as data; never
patch Pine's code for that.

- **Actions** (`settings.json` → `actions`, see `pine settings schema actions`): each runs
  one palette command (`pine commands` lists ids and their `argsSchema`) and can show as a
  pane-header button (`"in": ["paneHeader"]`) and/or in the pane tab's right-click menu
  (`"tabMenu"`), optionally only on some pane kinds. It is always in the palette as
  `action.<id>`. String args may use `{cwd}` and `{file}`.

  ```sh
  pine settings set actions '[{"id":"split-down","title":"Split below","command":"pane.split",
    "args":{"direction":"vertical"},"icon":"terminal","in":["paneHeader"],"paneKinds":["terminal"]}]'
  ```

  `set` replaces the whole list: read it with `pine settings get actions` first and write
  it back with yours added. An action whose command needs more than the default
  permissions asks the human (showing the command and args) before its first run; you
  can't mark one trusted.
- **Shortcuts**: `pine settings set keybindings.action.<id> '"Ctrl+Shift+K"'`.
- **A custom panel or sidebar item** (dashboards, lists, status): write a user extension
  in `~/.config/pine/extensions/<name>/` (`pine docs extensions`); Pine hot-reloads it and
  the human approves it once.

## Browser — agent-driven web automation

`pine browse` speaks the same command contract as
[agent-browser](https://github.com/vercel-labs/agent-browser) (verbs, arguments, `@eN` refs,
`--json`), but drives Pine's own browser panes, which the human sees next to your terminal. If you
know agent-browser, replace `agent-browser` with `pine browse`. The whole group needs the elevated
`browse` capability (see below); nothing works until a human grants it.

The core loop:

```sh
pine browse open localhost:3000        # loads the url; creates your own browser pane if you have none
pine browse snapshot -i                # interactive elements with refs:  - button "Submit" [ref=e2]
pine browse fill @e3 "ada@example.com" # act on refs from the snapshot
pine browse click @e2
pine browse wait --text "Welcome"      # then re-snapshot: refs reset on navigation
pine browse snapshot -i --json         # {"success":true,"data":{"snapshot":"…","refs":{"e2":{"role":"button","name":"Submit"}}},"error":null}
```

```sh
# navigation
pine browse open [url]                  # no scheme → https:// (http:// for localhost/127.x); prints the url
pine browse back | forward | reload
pine browse close                       # closes the browser pane
pine browse read                        # the page's visible text
pine browse pushstate <url>             # SPA navigation (next.router.push, else history.pushState + popstate)
# page analysis
pine browse snapshot [-i] [-c] [-d N] [-s <selector>] [-u]
                                        # aria tree "- role "name" [ref=eN] [level=1]"; -i interactive only,
                                        # -c compact, -d depth, -s scope, -u link urls
pine browse get text|html|value <sel>   # innerText / innerHTML / input value
pine browse get attr <sel> <name>
pine browse get title | url
pine browse get count <sel> | box <sel> | styles <sel> [property]
pine browse is visible|enabled|checked <sel>   # prints true/false
# interaction (sel = @eN ref, CSS selector, text=Label or xpath=//…)
pine browse click <sel> [--new-tab]     # real mouse click; fails "covered by <div#x>" if something is on top
pine browse dblclick <sel> | hover <sel> | focus <sel>
pine browse fill <sel> <text>           # clear and set
pine browse type <sel> <text>           # key events appended at the end of the field
pine browse press <key>                 # Enter, Tab, Control+a, Shift+ArrowDown …
pine browse keydown <key> | keyup <key>
pine browse keyboard type <text> | keyboard inserttext <text>   # into whatever has focus
pine browse select <sel> <value...>     # by value or visible label
pine browse check <sel> | uncheck <sel>
pine browse scroll [up|down|left|right] [px] [--selector <sel>]  # default down 300
pine browse scrollintoview <sel>
pine browse drag <from> <to>
pine browse upload <sel> <file...>
pine browse mouse move <x> <y> | down [button] | up [button] | wheel <dy> [dx]
# semantic locators (default action: click)
pine browse find role <role> [action] [--name <name>] [--exact]
pine browse find text|label|placeholder|alt|title|testid <value> [action] [text]
pine browse find first|last <sel> [action] | find nth <index> <sel> [action]
                                        # actions: click, fill <text>, type <text>, check, uncheck, hover, text
# waiting (default timeout 25 s, --timeout <ms>, max 120 s)
pine browse wait <sel> [--state visible|hidden|attached|detached]
pine browse wait <ms> | --text <text> | --url <glob> | --load load|domcontentloaded|networkidle | --fn <js>
pine browse wait --download [path]      # next download of this pane
# javascript
pine browse eval <js> | eval -b <base64> | eval --stdin
pine browse addinitscript <js>          # runs before every future page load; prints its identifier
pine browse removeinitscript <identifier>
pine browse addstyle <css>
# output
pine browse screenshot [path] [--full]  # PNG; default a private tmp path; prints the path
pine browse pdf <path>
# state
pine browse cookies [get] [--url U]
pine browse cookies set <name> <value> [--url U] [--domain D] [--path P] [--httpOnly] [--secure] [--sameSite Strict|Lax|None] [--expires <epoch s>]
pine browse cookies clear
pine browse storage local|session [key]  # all entries, or one value
pine browse storage local|session set <key> <value> | clear
pine browse state save|load <path>      # cookies + both storage areas as JSON
# network and emulation
pine browse network requests [--filter <text>] [--type xhr,fetch] [--method POST] [--status 2xx|404|400-499] [--clear]
pine browse network request <requestId> # headers of one request
pine browse network route <url-glob> [--abort] [--body <json>]
pine browse network unroute [url-glob]
pine browse set viewport <w> <h> [scale] | media [dark|light] [reduced-motion] | offline [on|off]
pine browse set headers '<json>' | geo <lat> <lng>
# tabs, frames, dialogs, debugging
pine browse tab                         # list: * marks the tab your commands go to
pine browse tab new [url] | tab <tabId> | tab close [tabId]
pine browse frame <sel|@ref|main>
pine browse dialog accept [text] | dismiss | status
pine browse console [--clear] | errors [--clear]
pine browse highlight <sel>
pine browse inspect                     # opens DevTools for the human
# batch: many commands, one connection
pine browse batch [--bail] "open x.test" "snapshot -i" "click @e1"
echo '[["open","x.test"],["snapshot","-i"]]' | pine browse batch --json
# Pine extras (no agent-browser equivalent)
pine browse identify                    # {tabId, url, title, workspaceId, windowId}
pine browse zoom in|out|reset
pine browse history clear
pine browse focus-mode enter|exit|toggle   # zoom the browser pane over its siblings
pine browse react-grab toggle|get       # click a React element, get {component,file,line}
pine browse focus-webview | is-webview-focused
pine browse pick [--timeout MS]         # ask the HUMAN to click an element (see below)
```

Every command takes `--pane <externalId>` (a browser pane's id from `pine browse tab` or
`pine pane.list`) and `--json`. With `--json` the output is agent-browser's shape,
`{"success": bool, "data": {…} | null, "error": "code: detail" | null}`; without it, text (the
snapshot tree, the value, `ok`) on stdout and `pine browse <verb>: <error>` on stderr with exit 1.
Relative paths resolve against your cwd and must stay under your home directory.

**Tabs.** A tab is a browser pane in your workspace; its id is the pane's external id.
Commands go to your active tab: the one `open` created, `tab new` opened or `tab <id>` switched to,
else the first browser pane in your workspace that is not on the human's profile. Another
workspace's pane needs `--pane` and `all-workspaces`.

**Refs.** `snapshot` (and `find`) give each element an `eN` ref. An element keeps its ref across
snapshots while it stays in the page; a navigation resets them, so snapshot again after `open`,
a link click or `back`. Same-origin iframes are inlined in the snapshot and their refs work
directly; `frame <sel>` scopes selectors and snapshots to one iframe, `frame main` goes back.
Refs live in an isolated JavaScript world, so the page can't read or fake them.

**Profiles.** A browser pane you open (`open`, `tab new`, `click --new-tab`) has its own
in-memory cookie and storage jar, shared with nothing and gone when it closes. Browser panes the
human opens share their own persistent profile: their cookies, logins and open sessions.
`pine browse tab` lists those as `[the human's browser profile…]` without their page, and
`open` never falls back to one. Every command that targets one (`--pane`, or `tab <id>` then any
command) shows the human an approval card for `credentials`, every time; it is never granted for
the session. Use one only when the human asked you to work in their signed-in browser. Scratch
and sandboxed workspaces never use the human's profile. The human can see and edit a pane's
cookies, local storage and session storage from its storage button.

**Console and errors** are captured from the moment the pane opens (500 entries each). `errors`
also catches uncaught exceptions and unhandled rejections through a hook Pine adds to every page.

**Dialogs** never block: `alert` is logged, and `confirm`/`prompt` follow the policy you set with
`dialog accept [text]` or `dialog dismiss` (default dismiss, reset on each navigation).
`dialog status` prints the policy and the log.

**DevTools.** CDP features (`addinitscript`, `upload`, `screenshot --full`, `set`,
`network route`, request logging, the error hook) share the page's one debugger. While the human
has DevTools open on that pane (`inspect`), they fail; ask them to close it.

Not available (Pine owns the browser): launch, session, profile and `connect` options, `clipboard`,
`diff`, `trace`, `profiler`, `record`, HAR, `react tree`, `vitals`, `a11y`,
`screenshot --annotate`, `set device|credentials`, `window new` and tab labels.

### Pointing at UI problems (pick element)

The human and the agent can both point at an element in a browser pane:

- **Human → agent.** The human clicks **Point at element** in a browser pane's toolbar, clicks the
  broken thing, writes what's wrong, and sends it to a terminal pane. Pine writes a markdown
  report to a private tmp dir (`/tmp/pine-reports-<uid>/ui-issue-N.md`) and:
  - pastes `@<report path> ` at that pane's prompt (never presses Enter) if the pane is at an idle
    shell prompt or its agent reported `pine state waiting`/`done`; otherwise the path goes to the
    human's clipboard;
  - delivers a bus message to that pane whose `text` is JSON:
    `{"kind":"ui-issue","report":"<path>","url":"…","selector":"…","note":"…"}` (read it with
    `pine bus inbox`);
  - sets the pane's attention to `working` (no ring).
  Read the report file: it has the note, page URL/title, a robust CSS selector, role/name, box,
  computed-style subset, the element's outerHTML (≤2 KB), recent console errors, failed network
  requests, and a PNG screenshot path of the element. Then act on it with `pine browse …`
  (e.g. `pine browse get styles '<selector>'`) or in the source.
- **Agent → human.** `pine browse pick` puts the browser pane into inspect mode (the pane shows
  "An agent asked you to point at an element"), waits for the human's click (default 120 s,
  `--timeout` 1 s–10 min; Esc or the toolbar toggle cancels), and prints the same capture as JSON:
  `{id,url,title,selector,label,html,htmlTruncated,box,styles,role,name,consoleErrors,failedRequests,screenshotPath,capturedAt}`.
  Fails with `cancelled`, `timeout`, `navigated`, or `busy` (a pick is already running there).
  Say what you want clicked *before* running it, e.g. with `pine state waiting "click the broken
  price label"`.

The inspector runs in an isolated JavaScript world of the page, so page scripts can't see or
fake it (synthetic clicks are ignored). For your real Chrome (logged-in workspaces, extensions,
performance traces) use Chrome DevTools MCP instead.

### Selections sent from files and terminals (text, images, PDFs, terminal output)

The human can also select something in a file Pine shows and send it to your pane: text in the
editor or the Markdown preview (**Send Selection to Agent**, Ctrl+Shift+E / ⌘⇧E, or the editor's
context menu), a dragged region of an image, or selected text or a region of a PDF page. From a
terminal pane they can send selected text or a command block's output (the block's
**Send output to agent…**). Pine
writes `/tmp/pine-reports-<uid>/selection-N.md` (plus `selection-N.png` for image and PDF
regions), pastes `@<report path> ` under the same rules as a pick report (idle prompt, or your
agent reported `waiting`/`done`; otherwise the human's clipboard), sets your pane to `working`,
and sends a bus message whose `text` is JSON:
`{"kind":"selection","report":"<path>","file":"<path>|null","image":"<png path>|null","note":"…"}`
(`file` is null for terminal text).

Read the report: its title says what was sent (`Text selection`, `Image region`, `PDF text
selection`, `PDF page region`, …), then the human's note, then `## Source` with the absolute
`File`, and either `Lines` (`12:5-14:1`, 1-based line:column, end exclusive; from the Markdown
preview only source lines `12-14`), or the image size and `Region` in image pixels, or `Pages`,
or `Page` with its size and `Region` in PDF points (origin top-left). Image and region reports
have a `Snapshot` PNG path: open it to see exactly what the human pointed at. Text reports end
with the selected text in a fenced block. Edit the file at `File` itself; the report is a copy.
Terminal reports (`Terminal text`, or `Terminal output` for a block) have no `File`: `## Source`
gives the pane's `Directory` and, for a block, the `Command` that printed it, and the report ends
with `## Terminal text`.

The human can also paste just a path at your prompt (`@<path> `, from the file tree's or an editor
tab's **Send path to agent**): that is the file itself, not a report.

## Gateway — LAN phone pairing (elevated)

```sh
pine gateway enable [--host H] [--port P]   # start the LAN control gateway (default 127.0.0.1:8722)
pine gateway pair                           # mint a pairing code + QR payload (also enables the
                                             # gateway if it wasn't already running)
pine gateway status                         # { running, host, port, fingerprint, deviceCount }
pine gateway devices                        # list paired phones — deviceId, name, caps, createdAt
                                             # (never prints bearer tokens)
pine gateway revoke <deviceId>               # revoke a paired phone immediately
pine gateway disable                        # stop the gateway
```

Lets the Pine Companion phone app pair over LAN (or your own Tailscale/VPN — **no hosted relay,
no cloud rendezvous, no accounts**) and mirror/drive this desktop. **Off by default**; every verb
here needs the elevated `gateway` capability (see below) on top of whatever the human has granted.
`pair` prints the pairing JSON (and a `pine-pair://` URI wrapping the same payload) for the phone
to scan/paste — there's no ASCII-QR rendering in the CLI itself, pipe the JSON through your own QR
tool if you want one. A paired device only gets a strict phone-facing capability subset
(`read`/`notify` by default). `command`/`input`/`destructive` are
granted per device only by the human in Settings → Remote — there is deliberately no CLI verb or
socket method for it, so don't try to raise a phone's caps; ask the user. This is a separate,
smaller vocabulary from the `Capability` list below; see `pine-companion/NETWORK-CONTRACT.md` for
the full protocol.

## Capabilities & elevation

Posture: **pane-scoped trust** — a process running inside a pane is trusted at
pane scope, so every pane holds a fixed set of **default** capabilities:
`drive-self`, `read-board`, `notify`, `settings-read`, `process`, `vault-read`,
`vault-write`. Everything cross-boundary,
system-facing, or dangerous is **elevated** and starts withheld: `send-other-pane`,
`type-other-pane`, `read-other-pane`, `kill-pane`, `all-workspaces`, `shell`, `destructive`, `phone`, `gateway`, `browse`,
`settings-write`.

A call that needs a capability your pane doesn't hold **asks the human** in Pine: the
call waits (up to 90 s) while a card on your pane shows what you asked for and the human
picks Allow once, Allow for this pane (lasts until the pane closes), or Deny. On approval
the same call simply succeeds; you don't retry. Otherwise it fails before doing anything:

- `pine: denied: <caps>`: the human said no. Don't ask again for the same thing; say what
  you needed and why, and continue without it.
- `pine: not-approved: <caps>`: nobody answered in time. Tell the human what is waiting
  on them, then try again once they reply.
- `pine: needs-elevation: <cap>`: no way to ask (e.g. an extension caller).

If the human set **Settings → Agents → Agent permission requests** to "Allow and record",
calls go through without a card and are only logged; destructive actions still ask. There
is no verb to grant or approve anything yourself, and `approvals` / `capabilities` can't be
changed with `pine settings set`. A human can also pre-grant caps to every pane with
`capabilities.grants` in `settings.json` (read at start):

```json
{ "capabilities": { "grants": ["browse", "send-other-pane"] } }
```

Ask for what the task needs in one go where you can (e.g. make the call that needs
`shell` directly) rather than probing; every ask interrupts the human.

`pine commands` reports each command's `capabilities` array so you can check before
you act. Commands without an explicit list default to the same default set above.

## Multi-agent coordination recipe

Two agents in different panes of the same Pine window (e.g. Claude driving pane A,
Codex driving pane B) can coordinate like this:

1. **Learn identities.** Run `pine pane.list` to see every pane's `externalId`
   (its `paneId` field) plus `title`/`cwd`, which is often enough to tell panes
   apart on its own. If it isn't (e.g. two otherwise-identical terminal panes),
   fall back to each agent running `pine whoami` and publishing its own
   `externalId` somewhere both can read (a Trellis card or entry, or ask the
   human to relay it).
2. **Hand off or ping.** Use `pine bus send <externalId> "..."` for a quick note,
   or `pine bus handoff <externalId> --task "..." --summary "..."` for a real
   unit of work; the receiving agent runs `pine bus wait` (or polls `pine bus
   inbox`) to notice it, then `pine bus claim <id>` and eventually `pine bus done
   <id>`.
3. **Plan shared work** on the project's Trellis board (the `trellis` CLI: cards,
   claims, columns) so both agents (and the human, in Pine's Trellis panel) see
   one board instead of duplicating state in two contexts.
4. **Store shared knowledge** — design decisions, "here's what I tried and why it
   didn't work" — as Trellis entries, not just in your own conversation, so the
   other agent (or your own next workspace) can find it instead of re-deriving it.

Remember: `send-other-pane` (bus send/handoff to someone else) is elevated, so the first
send asks the human. If it's denied, stop and flag it rather than silently falling back to
writing files on disk as a workaround.

---
name: pine
description: Use when a coding agent is running inside Pine (a terminal-workspace app) — detectable via the env vars PINE_SOCKET/PINE_TOKEN/PINE_PANE_ID/PINE_START_DIR — and wants to control its own pane or coordinate with other agents/panes in the workspace. Covers the `pine` CLI: identity (whoami), introspection (commands, docs), opening files, desktop notifications, pane attention state (pine state waiting/done), background processes, an encrypted secret vault, a cross-agent message bus, driving the in-app browser (open/read/click/type/eval/screenshot/cookies/storage/state/devtools/script-injection/console/errors/frame/download/pick element), reading the selection reports (text, image regions, PDF text or regions, terminal output) a human sends from files and terminals Pine shows (@/tmp/pine-reports-*/selection-N.md), reading the human's saved command workflows (pine workflow list/show), reading/writing app settings, learning the OS and asking the human to install system packages (pine system info/install — never run sudo yourself), and pairing/managing the LAN control gateway (a phone companion app, off by default, elevated, LAN/Tailscale only — no hosted relay). Boards, cards and knowledge entries are not Pine's: use the `trellis` CLI. Also covers the capability/elevation model and a recipe for two agents (e.g. Claude + Codex) in different panes coordinating work. Triggers on "pine", "pine CLI", "am I in Pine", "control the terminal workspace", "talk to the other pane/agent", "hand off a task to another agent", "pine bus/vault/settings/browse/gateway", "automate the browser", "agent browser automation in Pine", "pair a phone with Pine", "pine gateway", "selection-N.md", "the human sent me a selection".
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
pine open <file>                    # open <file> in this pane's editor surface
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
waiting pane clears `waiting`. Default capability `drive-self`. Printing an OSC 9 notification
(`printf '\e]9;%s\a' "msg"`) does the same as `state waiting` from any program. For wiring
Claude Code/Codex hooks to this automatically, see `docs/AGENT-HOOKS.md` in the Pine repo.

## Raw UI commands

Anything registered in the command palette can be run directly by id, with an
optional JSON args blob as the next argv:

```sh
pine pane.splitRight
pine pane.splitDown
pine pane.close
pine workspace.new
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

Tracked processes are scoped to the workspace that started them (cross-workspace
visibility needs the elevated `all-workspaces` capability). `logs` prints the
buffered output followed by `(cursor=N)` on stderr — pass `--since` that cursor to
resume from where you left off instead of re-reading everything.

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

## Boards, cards and knowledge — use Trellis

Pine has no kanban board or wiki of its own. Task boards, cards and knowledge entries live in
Trellis: run the `trellis` CLI directly from your pane, following its own Claude Code skills
(`trellis:trellis` for commands, `trellis:when-to-use-trellis` for when work belongs on a board,
`trellis:writing-knowledge` for recording findings). Pine's `trellis` extension only *shows*
Trellis to the human (board panel, per-workspace card counts, review notifications); see
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
If the user disabled one in Settings → Plugins you'll get `extension-disabled`; don't try to
enable it yourself (there is no verb for that — only the human approves/enables extensions).
`extension-unavailable` means its process didn't start or crashed; retry once, then tell the
user. Third-party extensions show up the same way — check `pine ext ls` before assuming a verb.
Built-in tool extensions: `pine trellis open|status|init` (the user's Trellis board for this
project; `init` asks the human first) and `pine keeper open|approvals` (Keeper's dashboard and the
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
pine settings get                        # whole { locale, appearance, behavior } state
pine settings get appearance.terminal.size
pine settings set appearance.terminal.size 14      # value parsed as JSON if it parses...
pine settings set locale '"en"'                    # ...else used as the raw string
pine settings set behavior.showHiddenFiles true
pine settings set keybindings.palette.toggle '"Ctrl+Shift+Y"'   # rebind a command
pine settings set keybindings.view.toggleRail null              # unbind it
pine settings get keybindings                                   # the user's overrides
```

`keybindings` maps a command id (after `keybindings.`, dots included) to a chord like
`Ctrl+Shift+K`, `Cmd+Alt+P` or `Mod+Shift+K` (Cmd on macOS, Ctrl elsewhere), or `null`.
Chords the shell needs are refused with an error: plain Ctrl+letter (Ctrl+R included),
plain or Ctrl arrows, Escape, Tab, and keys without Ctrl/Cmd. Unlisted commands keep
their default.

`set` deep-sets a dot-path immutably into the live `settingsStore` (so the Settings
UI updates instantly, no restart) and debounce-persists it to `settings.json`.
Unknown paths are created rather than rejected. `get` with no key returns the whole
state; with a key it walks the path and prints `null` (JSON for `undefined`) if
absent.

## Browser — agent-driven web automation

```sh
pine browse open <url> [--pane ID]                  # loads <url>; creates a browser pane if none exists
pine browse nav <back|forward|reload> [--pane ID]
pine browse read [selector] [--pane ID]              # visible text: whole page, or one element
pine browse click <selector> [--pane ID]
pine browse type <selector> "<text>" [--pane ID]     # sets .value, fires input + change events
pine browse dblclick <selector> [--pane ID]          # dispatches a double-click
pine browse hover <selector> [--pane ID]             # dispatches mouseover + mouseenter + mousemove
pine browse focus <selector> [--pane ID]             # el.focus()
pine browse check <selector> [--pane ID]             # checked = true, fires input + change
pine browse uncheck <selector> [--pane ID]           # checked = false, fires input + change
pine browse scroll-into-view <selector> [--pane ID]  # el.scrollIntoView({block:'center'})
pine browse fill <selector> "<text>" [--pane ID]     # whole-value set (plain .value=), fires input + change
pine browse select <selector> <value> [--pane ID]    # sets a <select>'s value (or matching option), fires change
pine browse scroll [--x N] [--y N] [--selector S] [--pane ID]   # scrolls the page, or an element with --selector
pine browse press <key> [--selector S] [--pane ID]   # real keyDown+keyUp (focuses --selector first if given)
pine browse keydown <key> [--selector S] [--pane ID] # real keyDown only
pine browse keyup <key> [--selector S] [--pane ID]   # real keyUp only
pine browse eval "<js>" [--pane ID]                  # runs JS in the page, prints the JSON result
pine browse wait <selector> [--timeout MS] [--pane ID]   # polls (default 10s, capped 30s)
pine browse screenshot [path] [--pane ID]            # PNG to `path` (default a tmp scratch path); prints the path
pine browse content [--pane ID]                      # document.documentElement.outerHTML, capped ~1MB
pine browse snapshot [selector] [--interactive] [--pane ID]
                                                      # a11y-ish text tree ("[e3] button \"Submit\"", "[e4] link \"Home\" → /home"),
                                                      # assigning each relevant element an [eN] ref; --interactive narrows to actionable elements only
pine browse get <sub> [selector] [--attr X] [--property P] [--pane ID]
                                                      # sub: url|title|text|html|value|attr|count|box|styles — prints the value
pine browse is <sub> <selector> [--pane ID]          # sub: visible|enabled|checked — prints true/false, exit 1 if false
pine browse find <by> <query> [--exact] [--index N] [--selector S] [--pane ID]
                                                      # by: role|text|label|placeholder|alt|title|testid|first|last|nth — prints an @eN ref
pine browse highlight <selector> [--ms N] [--pane ID]  # briefly outlines the element (default 1500ms)
pine browse url [--pane ID]                          # prints location.href
pine browse zoom <in|out|reset> [--pane ID]          # +/-0.5 zoom level (reset = 0), prints the new level
pine browse devtools [toggle|open|close|console] [--pane ID]
                                                      # opens/closes DevTools (default: toggle); 'console' just opens
                                                      # (Electron can't target the Console panel specifically)
pine browse focus-webview [--pane ID]                # OS-level focus() on the guest webContents
pine browse is-webview-focused [--pane ID]           # prints true/false, exit 1 if false
pine browse identify [--pane ID]                     # self-locate: {paneId, url, title, workspaceId, windowId}
pine browse cookies <get|set|clear> [name] [value] [--url U] [--domain D] [--pane ID]
                                                      # this surface's own cookie jar (per-pane partition)
pine browse storage <local|session> <get|set|clear> [key] [value] [--pane ID]
                                                      # localStorage/sessionStorage — omit [key] on get for all keys
pine browse state <save|load> <path> [--pane ID]     # save/restore cookies + both Web Storage areas to/from a JSON file
                                                      # (path is allow-listed, same as `screenshot`)
pine browse history clear [--pane ID]                # clears this surface's back/forward navigation history
pine browse addscript "<js>" [--pane ID]              # runs JS now, prints the JSON result (like `eval`, framed as injection)
pine browse addstyle "<css>" [--pane ID]              # insertCSS(css), prints the returned style key
pine browse addinitscript "<js>" [--pane ID]          # persists JS to run before EVERY future navigation (via CDP), prints its identifier
pine browse console [list|clear] [--pane ID]          # this surface's buffered console.* messages (capped ~500); default sub is list
pine browse errors [list|clear] [--pane ID]           # error-level / uncaught-exception subset of console (see below)
pine browse frame <selector|main> [--pane ID]         # point later selector-driven verbs (click/type/get/is/...) at an iframe; `main`/`top` resets to the page
pine browse download wait [--path P] [--timeout MS] [--pane ID]   # blocks for this surface's next completed download (default 30s, capped 5m)
pine browse navigate <url> [--pane ID]                # like `open`, but only on an EXISTING surface — fails if none exists yet
pine browse open-split [url] [--pane ID]              # always creates a NEW browser pane (a split); never reuses one
pine browse tab <new|list|switch|close> [url|target] [--pane ID]
                                                      # cmux-parity "tabs" — see divergence note below
pine browse dialog <accept|dismiss|list> [text] [--pane ID]
                                                      # auto-response policy + log for alert/confirm/prompt — see divergence note below
pine browse focus-mode <enter|exit|toggle> [--pane ID]  # minimal single-pane zoom/zen (maximize a pane, hiding its siblings)
pine browse react-grab <toggle|get> [--pane ID]       # minimal React-fiber inspector: click an element while on, `get` prints {component,file,line}
pine browse pick [--timeout MS] [--pane ID]           # ask the HUMAN to click an element; blocks until they do, prints the capture JSON
```

Drives the `browser` surface's `<webview>` guest page (Stage 1's in-app browser) — the same
one a human opened with `browser.open`/the command palette, or that `browse open` creates on
demand. `--pane <externalId>` targets a *specific* browser pane by another pane's `whoami`
externalId (from `pine pane.list`, same as the coordination recipe below); omit it
and the CLI targets the first browser pane in your own workspace. A selector/JS argument that
doesn't match anything fails with a typed error (`not-found`, `eval-failed`, ...) rather than
throwing — check the CLI's stderr/exit code. This entire group needs the elevated `browse`
capability (see below) — nothing here works until a human grants it.

**Per-surface isolation**: every browser pane gets its own cookie/storage jar (a distinct
Electron `partition`), so `cookies`/`storage`/`state` only ever see *that* pane's data — never
shared across panes or with the OS-level Chrome profile. `addinitscript` attaches a Chrome
DevTools Protocol debugger workspace to the surface to persist the script; Chrome only allows one
CDP consumer per page, so opening DevTools on the same pane (`devtools open`) afterward can
detach that workspace — if a follow-up `addinitscript` call then fails with
`debugger-attach-failed`, close DevTools first and retry.

**Ref workflow**: every selector-accepting command above (`click`, `type`, `get`, `is`, ...)
also accepts an `@eN`/`eN` element ref in place of a CSS selector. `snapshot` and `find` are
what mint refs — run `pine browse snapshot` first to see a text tree of the page annotated with
`[eN]` tags (or `pine browse find role Submit` to locate one element and get back its `@eN`
directly), then act on that ref: `pine browse click @e3`, `pine browse get text @e4`. Refs live
in the guest page's `window.__pine.refs` map and are valid until the next navigation — a `nav`/
`open`/link click invalidates them, so re-`snapshot`/`find` after navigating.

**Console/errors**: every browser pane's `console.*` calls are captured automatically (no setup
needed) into a ~500-entry ring buffer as soon as the pane registers, and `pine browse console
list` prints it (`clear` empties it; `list` is the default if you omit the sub). `pine browse
errors` is the same buffer filtered to error-level entries — which also includes otherwise
invisible failures: an injected catcher hooks `window.onerror`/`onunhandledrejection` on every
navigation and reports them via a `[pine-error]`-prefixed `console.error`, so an uncaught
exception or unhandled promise rejection shows up in `errors` even if the page never explicitly
logged anything. Both buffers are per-surface and cleared when the pane closes.

**Frame targeting**: `pine browse frame <selector>` points every later selector-driven verb
(`click`, `type`, `get`, `is`, ...) at that `<iframe>`'s document instead of the top-level page —
useful for content embedded in a same-origin iframe. `pine browse frame main` (or `top`) resets
back to the top document. Selecting a cross-origin iframe fails with `cross-origin-frame` (the
guest page can't reach its `contentDocument` either) rather than silently acting on the wrong
document.

**Downloads**: `pine browse download wait` blocks until this surface's next download finishes
(default 30s timeout, capped at 5 minutes) — pass `--path` to force the save location (allow-
listed the same way `state`'s path is) or omit it to let the browser pick its default location;
prints `{path, filename, state}`, or `{timedOut: true}` (and a non-zero exit) if nothing
downloaded in time.

**`navigate` vs `open` vs `open-split`**: `open` loads a url, creating a browser pane first if
none exists yet in your workspace; `navigate` is the same load but REQUIRES an existing surface
(fails rather than creating one) — useful when you specifically mean "drive the pane I already
have"; `open-split` is the opposite extreme — it always creates a brand new browser pane (a
split) regardless of whether one already exists, for when you explicitly want a second surface.

**Tabs, dialogs, focus-mode, react-grab (cmux parity, PRAGMATIC)**: these four mirror cmux verbs
that in cmux lean on native/product features Pine doesn't have — each is a simplified Electron
version, with the divergence called out below.

- **`tab`** — a "tab" here is a browser **PANE**, not a tab bar living inside one pane: cmux
  multiplexes multiple surfaces per pane slot, but Pine's own unit of multiplexing is already the
  pane, so `tab new/list/switch/close` just operate one level up. `new [url]` opens a browser pane
  in your workspace (reusing an existing one, same as `open`'s fallback — use `open-split` if you
  need a guaranteed-fresh pane); `list` prints every browser pane in your OWN workspace as
  `[{paneId, url, title}]`; `switch <target>`/`close <target>` take another pane's external
  `paneId` (same as `--pane`, but positional here) and focus/close it — cross-workspace targets need
  the same `all-workspaces` elevation `--pane` on any other verb needs.
- **`dialog`** — Electron's `<webview>` guest can't cleanly intercept a page's SYNCHRONOUS
  `alert`/`confirm`/`prompt` the way a real automation framework's dialog-event hook does, so this
  is a per-surface auto-response **POLICY** an agent sets ahead of time, not a one-at-a-time
  blocking queue: `accept [text]`/`dismiss` set what the NEXT `confirm`/`prompt` resolves to
  (`accept` → `true`/the given `text`; `dismiss` → `false`/`null`) and are logged either way;
  `list` prints the buffered `{type, message, ts}` log (capped ~200). The policy is pushed live
  into the CURRENTLY loaded page, but only seeded with a SAFE default (dismiss) on a fresh
  navigation — re-issue `accept`/`dismiss` after navigating if a non-default policy still needs to
  apply.
- **`focus-mode`** — a minimal single-pane zoom/zen, not a full maximize/restore animation system:
  `enter` shows only that browser pane (every sibling pane's surface just stops being portaled
  into a live slot — nothing unmounts, `SurfacePool` parks it until zoom clears); `exit` restores
  the split view; `toggle` flips between the two. Backed by a small `pane.zoom` renderer command
  (`layoutStore.ts`'s `zoomedPaneId`) that didn't previously exist — didn't turn out invasive, so
  it's a real (if minimal) implementation, not a no-op.
- **`react-grab`** — a MINIMAL React-fiber walk, not the upstream react-grab overlay/UI: `toggle`
  on installs a capturing click listener that walks up from the clicked element to its nearest
  React fiber (`__reactFiber$*`/`__reactInternalInstance$*`), then up the fiber's `return` chain
  to the nearest component (function/class `type`, skipping host elements like `div`), recording
  `{component, file, line}` (file/line come from `_debugSource`, only present in dev builds — often
  `null` in production) into `window.__pineReactGrab`; `toggle` again removes the listener.
  `get` prints the last grabbed entry. Installed via plain `executeJavaScript`, not persisted via
  CDP, so a navigation silently drops it — `toggle` on again after navigating if still wanted.

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
performance traces) use Chrome DevTools MCP instead: see `docs/CHROME.md` in the Pine repo.

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
`kill-pane`, `all-workspaces`, `shell`, `destructive`, `phone`, `gateway`, `browse`,
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

Remember: `send-other-pane` (bus send/handoff to someone else) is elevated — if
either agent hits `needs-elevation`, that's the signal to stop and flag it rather
than silently falling back to writing files on disk as a workaround.

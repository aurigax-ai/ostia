# Panes: verb details

`pane list --json` fields:

| Field | Meaning |
|---|---|
| `paneId`, `workspaceId`, `kind`, `title`, `cwd`, `filePath?` | the pane and what it shows |
| `running`, `blockCount`, `lastExitCode`, `pid?` | its shell's state |
| `agent?`, `agentState?`, `agentMessage?` | the agent running there and what it reported (`working`, `waiting`, `done`, `error`) |
| `agentSessionId?`, `agentSessionConflict?` | its session; other panes running the same session |
| `hibernated?`, `waking?` | Ostia stopped the idle agent; it is starting again |
| `splitTabId?`, `splitTabName?` | the split tab holding it |
| `process?` | `{id, status, start}` of the command `process run` or `agent run` started there |

- **list** keeps every pane you can see by default; `--here` keeps your workspace, `--workspace
  <id|name>` another, `--state` (repeat it: `idle`, `running`, `working`, `waiting`, `done`, `error`,
  `hibernated`, `waking`) and `--kind` narrow it further. Text shows the first 8 characters of each
  id; `--json` keeps the full ids.
- **status** with no pane answers the other terminals in your workspace you may read without asking (the tabs you opened, at most 32). Each line
  starts with the pane's id. It answers facts, never the screen: `state` (`working`, `waiting`, `done`, `error`,
  `idle`, `hibernated`, `waking`, `exited`, `shell`), how long it has been in it, the closing line,
  the last exit code, the branch with changed files and ahead/behind, the pane's queued and failed
  mail, and what changed since you last asked about that pane (`first look` the first time). The
  closing line is what the agent set with `ostia state done "<line>"`, else the first line of its
  last message (280 characters at most). It needs the same reach as `pane read` and holds no
  command output; read the screen with `pane read` only when the line is unclear.
- **transcript** prints what a claude or codex agent in that pane wrote, read from the agent's own
  session file: for each turn `> ` and the prompt, one `· ` line per tool call, then the final
  message in full. The default is the last turn; `--turns N` the last N (at most 50), `--full`
  every turn (the last 256 KiB of text). It is shown as written, without redaction, and is never
  stored or sent on. It needs the same reach as `pane read`, is refused from a sandboxed
  workspace, and answers `no-transcript:` for a pane with no agent session. A turn still running
  ends in `(no answer yet)`.
- **wait** returns when any named pane reports `done` or `waiting` or its command exits
  (`--until idle` also counts a pane with nothing reported, `error` an agent that reported an
  error, `command` a command block in that pane that finished after the wait began). It prints
  the pane's status line, so no read follows (`--json` adds `exitCode` for `command`), and never
  reads the screen. Exit 0 reached, 3 timed out (default 10 minutes, at most 1800 s), 4 the pane
  closed.
- **watch** is wait that arrives as mail. Each time a watched pane reaches one of the states
  (default `done`, `waiting`, `error`, `exited`), one `event` message from that pane lands in your
  inbox, with its status line as the text; an event still waiting there is replaced by the newer
  one, not stacked. You read it like any bus message: as context at your next prompt, or with
  `bus wait`. The watch needs the reach of `wait`, lasts until you run `watch <pane> --off` (no pane
  stops all) or either pane closes, and holds at most 32 panes. It prints what you now watch.
- **send** types the text as a bracketed paste when it holds a newline and the pane asked for
  bracketed paste, so a newline does not submit. `--paste` forces that for one line, `--raw`
  forces the bytes as typed (the two exclude each other). **send** and **key** answer what the pane did: `ok: <pane> started a
  turn`, `ok: <pane> showed new output; a command is running` (or `no command is running`), or
  `sent; <pane> showed nothing yet (…)` (exit 0, the bytes went in) for a pane that stays quiet,
  such as Enter at an idle prompt or `read -s`: read it with `pane read`, never send again.
  `--json` gives `responded`, `turnStarted` and `running`.
  With `--enter` into an agent that reports its turns (claude or codex with hooks on) and is
  not in a turn, `send` also waits for the turn to start and answers `not-submitted:` with
  exit 1 when it did not, for example after a slash command that opened a picker. Ostia never
  presses Enter again on its own; press it with `pane key <pane> enter` if that is what you
  want.
- **wake** starts a hibernated agent again with its own resume command, or types that command
  at the prompt of an awake agent pane, and returns once the agent started: exit 0, 3 timed
  out (default 2 minutes), 4 closed, 1 with `not-started: <reason>` when the agent exited or
  could not be typed before it reported its start. An agent that is running already answers
  `<id> already awake` and nothing is typed. It answers `not-resumable` for a
  pane with no session to resume. `send` and `key` refuse a pane that is `hibernated:` or
  `waking:`.
- **hibernate** skips a busy agent and exits 2 with the reason; a pane that is asleep already is
  listed as hibernated.
- **move --tab <name>** puts running panes into that split tab (the same name `--tab` uses),
  creating it once two panes share it; `--tab new` puts each back into a tab of its own;
  `--workspace` moves them into another workspace of the same window first. A pane already in
  place is left alone. Processes keep running and nothing is typed. It reads the layout back:
  `--json` lists each pane's `placement`, and a pane that did not land answers `misplaced:`.
  Panes that end up as the whole workspace share its layout without a split tab name. It refuses
  a locked pane (`pane-locked:`), a split tab the human made (`human-tab:`, also for `--tab new`
  out of one), scratch and sandboxed workspaces (`scratch:`, `sandboxed:`) and another window
  (`other-window:`), and joins only a split tab whose panes you all reach.
- **close** of a pane that closed earlier answers `<id> already closed <age> ago (<name>)`, exit 0.
  An unknown id of a pane that closed answers `unknown-pane: <id> closed <age> ago (<name>)`.
  It closes at once, even while a command runs; unsaved file changes ask the human. A
  locked pane answers `pane-locked:`; a pane still listed afterwards answers `still-open:`.
- **Reach.** A tab you opened with `process run` or `agent run` asks nothing. For another pane the
  human is asked for `type-other-pane` (send, key, wake, move), `read-other-pane` (read, wait,
  status, transcript, watch) or `kill-pane` (close, hibernate), plus `all-workspaces` outside your
  reach. From a sandboxed workspace only sandboxed terminals of the same workspace are reachable.

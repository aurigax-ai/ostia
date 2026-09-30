# Agent hooks

Pane attention (the ring, sidebar badges, the bell, Ctrl+Shift+U / ⌘⇧U) works for any program
through terminal notifications (OSC 9 / 99 / 777) or `pine state`. Agent CLIs that don't emit
those can be wired up with their own hooks. The recipes below call `pine state`, which sets the
attention state of the pane the agent runs in:

| State | Meaning | Look |
|---|---|---|
| `working` | agent is busy | brand dot in the sidebar |
| `waiting` | agent needs you | attention ring on the pane, badge, bell count |
| `done` | agent finished its turn | quiet marker on the pane, badge until you look |
| `error` | something failed | attention ring, square dot |
| `clear` | back to normal | nothing |

Focusing the pane clears its unread flag and turns `done` back to normal. Typing into a `waiting`
pane clears the waiting state.

## Why the commands look like this

- Hooks run under `sh -c`, not your interactive shell, so the `pine` shell function that Pine
  injects into bash/zsh isn't defined. The recipes call the CLI the way that function does:
  `ELECTRON_RUN_AS_NODE=1 "$PINE_NODE" "$PINE_CLI" …`. The agent inherits `PINE_*` from the pane.
- `[ -n "$PINE_SOCKET" ] && … || true` makes every hook a no-op outside Pine and never fails the
  hook, even if Pine has quit.
- Output goes to `/dev/null`: Claude Code adds a `UserPromptSubmit` hook's stdout to the model's
  context, and nothing here should reach it.
- `pine state waiting -` reads the message from stdin. Claude Code passes the hook event as JSON on
  stdin (there is no `$message` variable); when stdin is a JSON object, `pine state` uses its
  `message` field, so no `jq` is needed.

## Claude Code

**In a zsh or bash pane there is nothing to set up.** Pine's shell integration defines a
`claude` function that runs `command claude --plugin-dir <tmp>/claude-plugin "$@"`. That generated
plugin (`pine@inline`) holds the `pine` skill, so Claude knows the `pine` CLI in every project, and
the hooks below plus the `SessionStart` resume hook. A session plugin adds to your own settings
and plugins, so your hooks still run; if you also pasted these recipes, each fires twice, which
is harmless. `command claude` runs Claude without Pine's plugin.

The recipe is for Claude started any other way (fish, a script that calls the binary directly).
Paste into `~/.claude/settings.json` (all projects) or `.claude/settings.json` (one project),
merging with any `hooks` you already have:

```json
{
  "hooks": {
    "UserPromptSubmit": [
      {
        "hooks": [
          {
            "type": "command",
            "command": "[ -n \"$PINE_SOCKET\" ] && ELECTRON_RUN_AS_NODE=1 \"$PINE_NODE\" \"$PINE_CLI\" state working >/dev/null 2>&1 || true"
          }
        ]
      }
    ],
    "Notification": [
      {
        "hooks": [
          {
            "type": "command",
            "command": "[ -n \"$PINE_SOCKET\" ] && ELECTRON_RUN_AS_NODE=1 \"$PINE_NODE\" \"$PINE_CLI\" state waiting - >/dev/null 2>&1 || true"
          }
        ]
      }
    ],
    "Stop": [
      {
        "hooks": [
          {
            "type": "command",
            "command": "[ -n \"$PINE_SOCKET\" ] && ELECTRON_RUN_AS_NODE=1 \"$PINE_NODE\" \"$PINE_CLI\" state done >/dev/null 2>&1 || true"
          }
        ]
      }
    ]
  }
}
```

- `Notification` fires when Claude needs permission or has been idle waiting for input. Its stdin
  JSON carries `message` (e.g. "Claude needs your permission to use Bash") and `title`. With no
  `matcher` it fires for every notification type; set `"matcher": "permission_prompt|idle_prompt"`
  to limit it.
- `Stop` fires when Claude finishes responding. It has no matcher.
- `UserPromptSubmit` is optional; it marks the pane `working` as soon as you send a prompt.

Reference: <https://code.claude.com/docs/en/hooks> (event names, stdin fields, `sh -c` execution).

## Codex CLI

**In a zsh or bash pane there is nothing to set up.** Pine's shell integration defines a `codex`
function. When the call starts an interactive session (`codex`, `codex "<prompt>"`,
`codex resume …`, `codex fork …`), it runs `command codex` with these arguments in front of
yours:

- `-c hooks.SessionStart=…`: `pine resume-token codex -` records the session id, and a second
  handler prints a short note that this is a Pine pane, how to run the `pine` CLI, and where
  the full `pine` skill is (`<tmp>/pine-shell-integration-<uid>/codex/SKILL.md`). Codex adds a
  `SessionStart` hook's output to the model's context, so Codex learns the CLI.
- `-c hooks.UserPromptSubmit=…` → `pine state working`
- `-c hooks.PermissionRequest=…` → `pine state waiting -`. The message names the tool, e.g.
  "Needs your permission to use Bash" (Codex's payload has no `message` field; `pine state`
  uses its `tool_name`).
- `-c hooks.Stop=…` → `pine state done`
- `-c hooks.state={…}`: marks exactly those handlers trusted, by the hash Codex itself computes,
  so Codex runs them without asking you to review them in `/hooks`. Pine does not pass
  `--dangerously-bypass-hook-trust`, which would also run your own and your projects' hooks
  unreviewed.
- `--no-daemon`: the session runs in this `codex` process, not in Codex's shared background
  server, so the hooks see this pane's `PINE_*` environment. `-c` alone already has that
  effect; `codex agents` won't list these sessions.

Nothing is written to `~/.codex`. The `-c` values form Codex's session-flags layer, which Codex
adds after your `~/.codex/config.toml`, `~/.codex/hooks.json` and trusted project hooks, so
those still run as well. `exec`, `review`, `login`, `mcp` and every other subcommand, `--help`
and `--version` run untouched, and `command codex` runs Codex without Pine's hooks.

Verified against codex-cli 0.157.0 (the TUI in bash and zsh, `resume`, and a turn that asked for
approval, driven by a local fake model server). Limits of that version:

- **No session skill.** Codex reads skills only from its config folders, `~/.agents/skills` and
  the repo; `skills.config` in `config.toml` only enables or disables skills it already found,
  and no flag adds a folder. Pine passes the skill's location as `SessionStart` context
  instead of installing it. Overriding `developer_instructions` would replace yours.
- **`waiting` fires for every approval request, even ones no human answers.** `PermissionRequest`
  runs before Codex's automatic reviewer (`--approve-for-me`, `approvals_reviewer`), so a
  request that the reviewer approves still marks the pane `waiting` until the turn ends
  (`done`) or you type into the pane. Codex has no event for "the human must answer now".
- **The session id is recorded at the first turn.** Codex fires `SessionStart` when the first
  prompt is sent (`source` `startup`, `resume`, `fork`, `clear` or `compact`), not at launch, so
  a session you opened but never prompted has no id to resume.
- **Hook trust is tied to Codex's hash format.** If a later Codex changes how it hashes a hook,
  Pine's hooks show as untrusted in `/hooks` and don't run until you trust them there.

For Codex started any other way (fish, a script that calls the binary directly), put the same
hooks in `~/.codex/hooks.json` (all projects) or `.codex/hooks.json` (a trusted project) and
trust them once in Codex's `/hooks` view:

```json
{
  "hooks": {
    "SessionStart": [
      {
        "hooks": [
          {
            "type": "command",
            "command": "[ -n \"$PINE_SOCKET\" ] && ELECTRON_RUN_AS_NODE=1 \"$PINE_NODE\" \"$PINE_CLI\" resume-token codex - >/dev/null 2>&1 || true"
          }
        ]
      }
    ],
    "UserPromptSubmit": [
      {
        "hooks": [
          {
            "type": "command",
            "command": "[ -n \"$PINE_SOCKET\" ] && ELECTRON_RUN_AS_NODE=1 \"$PINE_NODE\" \"$PINE_CLI\" state working >/dev/null 2>&1 || true"
          }
        ]
      }
    ],
    "PermissionRequest": [
      {
        "hooks": [
          {
            "type": "command",
            "command": "[ -n \"$PINE_SOCKET\" ] && ELECTRON_RUN_AS_NODE=1 \"$PINE_NODE\" \"$PINE_CLI\" state waiting - >/dev/null 2>&1 || true"
          }
        ]
      }
    ],
    "Stop": [
      {
        "hooks": [
          {
            "type": "command",
            "command": "[ -n \"$PINE_SOCKET\" ] && ELECTRON_RUN_AS_NODE=1 \"$PINE_NODE\" \"$PINE_CLI\" state done >/dev/null 2>&1 || true"
          }
        ]
      }
    ]
  }
}
```

- Codex runs each hook with `$SHELL -lc` and the event as JSON on stdin.
- Empty stdout with exit 0 is a no-op for every event: `PermissionRequest` neither approves nor
  denies, and `Stop` doesn't continue the turn. That is why the output goes to `/dev/null`.

Reference: <https://learn.chatgpt.com/docs/hooks>, and the hook event schemas in
`codex-rs/hooks/schema/generated/` of <https://github.com/openai/codex>.

## Resume after a restart

Pine can't keep an agent process alive across a quit, a crash or a reboot (CLAUDE.md §8), but it
can remember which agent session a pane was running and offer to resume it. The pane stores the
session id; after a restart its header shows **Resume claude** (or codex), and `Ctrl+Shift+R` /
`⌘⇧R` types `claude --resume <id>` (or `codex resume <id>`) at the idle prompt and runs it.

The id is recorded when the agent **starts**, not when it stops: a locked screen, a killed
process or a crash never gets to run a stop hook, so waiting for one would lose exactly the
sessions you most want back.

Claude Code in a zsh or bash pane already has this hook (see "Claude Code" above). Otherwise, add
a `SessionStart` hook. It fires on start, `--resume`, `/clear` and compaction,
so the pane always holds the current session id; `resume-token claude -` reads `session_id` from
the hook's stdin JSON.

```json
{
  "hooks": {
    "SessionStart": [
      {
        "hooks": [
          {
            "type": "command",
            "command": "[ -n \"$PINE_SOCKET\" ] && ELECTRON_RUN_AS_NODE=1 \"$PINE_NODE\" \"$PINE_CLI\" resume-token claude - >/dev/null 2>&1 || true"
          }
        ]
      }
    ]
  }
}
```

Codex in a zsh or bash pane already has this hook, and the recipe for Codex started any other
way is in "Codex CLI" above. `resume-token codex -` reads `session_id` from the `SessionStart`
JSON; it is the id `codex resume <id>` takes.

Pine only accepts `claude` or `codex` and an id of letters, digits, `.`, `_` and `-`, and builds
the command itself, so nothing that reaches the hook can make Pine type an arbitrary command.

## Any other program

Print an OSC 9 notification; Pine marks the pane `waiting` and adds it to the bell:

```sh
printf '\e]9;%s\a' "build finished"
```

OSC 777 (`\e]777;notify;TITLE;BODY\a`) and kitty's OSC 99 work the same way. Or call
`pine state waiting "message"` / `pine notify "title" "body"` from a script running in a pane.

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

Codex's `notify` key in `~/.codex/config.toml` runs a program after each agent turn with the
event JSON appended as its last argument (type `agent-turn-complete`). It has no "needs input"
event, so this recipe only marks the pane `done`:

```toml
notify = ["sh", "-c", "[ -n \"$PINE_SOCKET\" ] && ELECTRON_RUN_AS_NODE=1 \"$PINE_NODE\" \"$PINE_CLI\" state done >/dev/null 2>&1 || true"]
```

The appended JSON becomes `$0` of the `sh -c` script and is ignored.

Codex also has a `hooks.json` system with `PermissionRequest`, `Stop` and `UserPromptSubmit`
events, but its `Stop` hook expects JSON on stdout and `PermissionRequest` can answer the approval
itself, so a `waiting` recipe for it isn't included until it's been verified against a real Codex
build.

Reference: <https://learn.chatgpt.com/docs/config-file/config-advanced> (the `notify` key) and
<https://learn.chatgpt.com/docs/hooks>.

## Any other program

Print an OSC 9 notification; Pine marks the pane `waiting` and adds it to the bell:

```sh
printf '\e]9;%s\a' "build finished"
```

OSC 777 (`\e]777;notify;TITLE;BODY\a`) and kitty's OSC 99 work the same way. Or call
`pine state waiting "message"` / `pine notify "title" "body"` from a script running in a pane.

# Views and actions: UI as data

## Contents

- View files and commands
- Nodes
- Bindings and data
- Actions, budget and an example
- Actions, shortcuts and panels in settings

## View files and commands

A view is one JSON file, `~/.config/ostia/views/<name>.json` (`$XDG_CONFIG_HOME/ostia/views`;
`<name>` is lowercase `a-z0-9-`). It holds data only: no script, HTML or styling. Ostia draws it
with its own components, bound to live data, and reloads it when the file changes. A new file
stays hidden until the human turns it on in Settings → Views; no command enables one. When an
edit breaks an enabled view, the last version that worked stays up and Settings lists the
problems.

```sh
ostia view schema                # the JSON Schema; works outside Ostia too
ostia view validate <file>       # "file:line: path: message" per problem and exit 1, or "ok: …"
ostia view list [--json]         # name, status (pending|enabled|disabled), placement, title
ostia view open <name>           # an enabled panel view as a pane of your workspace
```

Top level: `version` (1), `title`, `placement` (`sidebar`: a collapsible section under the
workspaces; `panel`: a pane opened from the palette "Views: Open <title>" or `view open`),
optional `icon` and `description`, and `root` (one node).

## Nodes

| Node | Properties |
|---|---|
| `stack` / `row` | `children`, `gap` (none/sm/md/lg); row also `justify` (start/between/end), `wrap` |
| `section` | `title`, `children`, `collapsed` |
| `text` | `text`, `tone`, `size` (xs/sm/base), `weight` (regular/medium/semibold), `mono`, `truncate` |
| `badge` | `text`, `tone` (hidden when the text is empty) |
| `icon` | `name`, `tone` (not brand), `label` |
| `list` | `for` (a data path), `as` (item name, default `item`), `item` (node), `limit`, `empty`, `gap` |
| `button` | `label`, `icon`, `variant` (default/outline/ghost), `action` |
| `link` | `label`, `url` (http/https; opens in the workspace's browser pane) |
| `progress` | `value` (a number or one binding), `max` (default 100), `label`, `tone` |
| `kv` | `items: [{key, value}]` |
| `divider` | — |

Every node may have `if: "{{path}}"`, drawn only when truthy (`[]`, `0` and `""` are falsy).
Tones: neutral, muted, brand, ok, warn, error. `ostia view schema` lists the icon names.

## Bindings and data

Text takes `{{path | filter}}`. A path is dot-separated names or indices (`workspaces.0.name`);
nothing else is evaluated, and a missing path renders empty. Filters: `upper`, `lower`, `count`,
`not`, `relative` (ms to "5 minutes ago"), `time`, `date`.

| Source | Shape |
|---|---|
| `workspace` | the current workspace or null: `{id, index, name, project ({name, path} or null), dir, description, state (idle/working/waiting/done/error), unread, active, pinned, panes, git, ports: [{port, url}]}` |
| `workspaces` | every workspace, same shape (`git` is the branch shown in the sidebar, or null) |
| `panes` | panes of the current workspace: `{id, title, kind, agent (claude/codex/null), attention (none/working/waiting/done/error), unread, message, active}` |
| `ports` | listening ports: `{port, url, workspace, workspaceId}` |
| `approvals` | `{pending}`: permission requests waiting on the human |
| `notifications` | newest first, up to 50: `{id, title, body, kind, from, at}` |
| `clock` | `{now}` in ms; ticks every second |

## Actions, budget and an example

`{"command": "<palette id>", "args": {...}}` runs a palette command (`ostia commands` lists the
ids) as an `actions` entry in settings.json does; strings in `args` take bindings, and an arg that
is one binding keeps its type (`{"index": "{{ws.index}}"}` passes a number). A command that needs
a non-default capability asks the human first. `{"openUrl": "https://…"}` opens a URL in the
browser pane. Budget: 200 nodes, 10 levels, 50 items per list (`limit` for more), 1000 drawn
nodes; over budget, the last good render stays with a note.

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

## Actions, shortcuts and panels in settings

`actions` in settings.json (`ostia settings schema actions`): each entry runs one palette command
and can show as a pane-header button (`"in": ["paneHeader"]`) or in a tab's right-click menu
(`"tabMenu"`), optionally only on some pane kinds; it is always in the palette as `action.<id>`.
String args may use `{cwd}` and `{file}`. `settings set actions` replaces the whole list, so read
it with `ostia settings get actions` first. An action whose command needs more than the default
capabilities asks the human before its first run.

```sh
ostia settings set actions '[{"id":"split-down","title":"Split below","command":"pane.split",
  "args":{"direction":"vertical"},"icon":"terminal","in":["paneHeader"],"paneKinds":["terminal"]}]'
ostia settings set keybindings.action.split-down '"Ctrl+Shift+K"'
```

A keybinding is a chord (`Ctrl+Shift+K`, `Cmd+Alt+P`, `Mod+Shift+K`: Cmd on macOS, Ctrl
elsewhere), a list of chords, or `null`; `terminal:Cmd+K` applies only while a terminal has the
keyboard. `keymap`, `terminalKeymap`, `keybindings` and `terminalKeys` are kept per platform.

A panel or sidebar item with its own code is a user extension in
`~/.config/ostia/extensions/<name>/`, which the human approves once.

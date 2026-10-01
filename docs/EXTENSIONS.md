# Writing a pine extension

An extension is a directory with a `pine.json` manifest and, usually, a program pine starts for
you. The program talks JSON-RPC to pine over the same control socket the `pine` CLI uses. That
gives it palette and CLI commands, events, sidebar status items, pane chips, typed settings,
encrypted secrets, the assist hook points (typo fix and prompt review, command suggestions, editor
completions, the Ask conversation), notifications and a panel surface. The built-in Git, Trellis,
Keeper, System and Assistant (`src/extensions/`) use nothing else, so they are the reference
implementations.

How it works inside pine: `docs/ARCHITECTURE.md` §11. Why it's out-of-process: `docs/ROADMAP.md` §2.
If you only need to show something (a sidebar section, a panel with buttons), a
[declarative view](#declarative-views-ui-without-a-process) is one JSON file and no process.

## Where extensions live

| Location | Kind |
|---|---|
| `resources/extensions/<id>/` in the app (`out/extensions` in dev) | Built-in: pre-approved, enabled by default |
| `~/.config/pine/extensions/<id>/` (`$XDG_CONFIG_HOME` is honored) | Yours: asks for approval on first launch |

Extensions are discovered at startup, and pine watches your extensions directory while it
runs: adding, changing or removing a `pine.json` takes effect within a moment, no restart needed.
A new extension still asks for approval first, and a changed manifest that asks for more
capabilities runs with what you approved before until you review it. A changed extension that
was running is restarted. Settings → Plugins lists every extension with its status, permissions,
settings form and an enable switch. A disabled extension has no process, no commands, no panel,
no sidebar items and no pane chips. Plugins in the Settings nav expands into one entry per
extension (its panel icon, if it has one) that scrolls to that extension's block; core code links
there with `openSettings('plugins', { extension: id })` or `openSettings('plugins/<id>')`, and the
Settings search box finds an extension by its name, a setting title or a setting key.

## Manifest (`pine.json`)

```json
{
  "id": "ports",
  "name": "Ports",
  "version": "0.1.0",
  "description": "Shows listening dev servers per workspace.",
  "capabilities": ["read-board", "notify"],
  "main": "main.js",
  "contributes": {
    "commands": [
      { "id": "open", "title": "Open Ports", "category": "App" },
      { "id": "find", "title": "Find a Port", "usage": "find <port>", "argument": "Port number" },
      { "id": "ls", "title": "List ports", "usage": "ls [--all]", "palette": false,
        "capabilities": ["read-board"] },
      { "id": "note", "title": "Attach a note", "usage": "note <port>", "palette": false,
        "stdin": true },
      { "id": "kill", "title": "Stop a dev server", "usage": "kill <port>", "palette": false,
        "interactive": true }
    ],
    "sidebarItems": true,
    "panel": { "title": "Ports", "icon": "server", "entry": "url" },
    "paneChips": [{ "id": "port", "title": "Listening port" }],
    "settings": {
      "interval": { "type": "number", "title": "Scan interval", "default": 3,
        "minimum": 1, "maximum": 60, "unit": "seconds",
        "description": "Time between scans while {product} is focused" },
      "showSsh": { "type": "boolean", "title": "Show ssh host", "default": true,
        "description": "Show the host of a foreground ssh" },
      "sort": { "type": "enum", "title": "Sort order", "values": ["port", "name"],
        "valueTitles": { "port": "By port", "name": "By name" }, "default": "port",
        "description": "Order of the items" }
    }
  }
}
```

| Field | Meaning |
|---|---|
| `id` | Lowercase letters, digits and dashes, 2–40 chars. It is the CLI verb (`pine ports ls`) and the command prefix (`ports.open`). |
| `name`, `version`, `description` | Shown in Settings and the approval dialog. |
| `capabilities` | What the extension process may do through pine. It gets this list intersected with what the user approved. Names are pine's capability names (`shared/capabilities.ts`). |
| `main` | Path inside the extension dir. `.js`/`.cjs`/`.mjs` run with pine's own Electron binary as Node (`ELECTRON_RUN_AS_NODE=1`), so no system Node is needed; anything else is executed directly (any language). cwd is the extension dir. Required if you contribute commands, sidebar items or a `url` panel. |
| `contributes.commands[]` | `id` (no dots), `title`, optional `category`, `usage` (shown in `pine docs` / `pine ext ls`), `palette` (default `true`; `false` = CLI/agents only), `stdin` (CLI pipes stdin to you), `interactive` (the command waits on the human, usually through `ext.confirm`: pine waits up to 10 min for your reply instead of 30 s), `argument` (a label, 80 chars: picking the command in the palette asks the human for one value, shown with this label, and you get it as `args.argv[0]`, the same shape as `pine <id> <command> <value>`; without `argument` palette runs get `null` args), `capabilities` (what the **caller** must hold; checked by pine before your process sees the call). |
| `contributes.sidebarItems` | `true` if you call `ext.setSidebarItem`. Such extensions start with the window instead of on first use. |
| `contributes.panel` | `title`, optional `icon`, and `entry`: a `.html` path inside the extension, or `"url"` to hand pine a loopback URL at runtime. |
| `contributes.paneChips` | Up to 8 `{id, title}`. Each is a slot for a short value you put on a pane's header with `ext.setPaneChip` (for example a branch, a venv, a test count). `title` names it in tooltips and in Settings → Prompt: the human can also place your chip in the Pine prompt's chip row (`terminal.prompt.chips` id `<extId>.<chip>`), where it shows the same value. Needs `main`. |
| `contributes.settings` | Up to 32 keys (`[A-Za-z][A-Za-z0-9_-]*`), each `{type, default, description}` with `type` one of `string` (≤ 1000 chars), `number`, `boolean`, `enum` (plus `values: string[]`). The default must match the type. Optional: `title`, the label Settings shows (sentence case, ≤ 80 chars, no control characters; without it Settings humanizes the key, `intervalSeconds` → "Interval seconds"); for `enum`, `valueTitles: {<value>: <label>}` for the options (keys must be in `values`); for `number`, `minimum` and `maximum` (main refuses values outside them, and the default must be inside) and `unit` (`seconds` or `per-minute`), which Settings shows after the description as "(1 to 60 seconds)", so leave the range out of the description. Settings shows the raw key in small mono type next to the title for people who edit `settings.json`. Titles, descriptions and value titles may say `{product}`, which Settings replaces with the product name; never write the product name itself. Main checks all of it when it loads the manifest. Manifest strings are not localized. Settings → Plugins shows a form for them; the human's values are stored in `settings.json` under `extensionSettings.<id>` and synced with it, so never put a secret there. |
| `contributes.workflows[]` | Saved workflows in Warp's format (at most 64): `name`, `command` with `{{arg}}` placeholders (`{{{x}}}` is a literal `{{x}}`), optional `description`, `tags`, `arguments[{name, description, default_value}]`, `shells`, `author`, `source_url`. Data only: no `main` needed. They appear in "Workflows: Search" and `pine workflow list` while the extension is enabled and approved; pine inserts one at an idle prompt only when the human picks it. |
| `contributes.completions` | A folder inside the extension holding command completion specs, one `<command>.json` per command: `{names, description, subcommands[], options[{names, description, args, isPersistent, isRepeatable}], args[{name, description, suggestions[{name, description}], template: ["filepaths" \| "folders"], isOptional, isVariadic}]}`. Data only: no `main` needed, and nothing in a spec runs. Main reads a spec when the input editor completes that command (size-capped, symlinks refused, validated); `~/.config/pine/completions/<command>.json` wins over any extension's. The built-in `completions` extension ships about 700 specs converted from Fig's `@withfig/autocomplete` at build time (`scripts/completionSpecs.mjs`). |

| `contributes.secrets` | Up to 8 keys (same pattern as settings), each `{description}` and an optional `title` (same rules as a setting's). Settings → Plugins shows a password field per key; the value is stored encrypted in pine's data dir (never in `settings.json`, never synced) and never sent back to the renderer. Read it with `ext.getSecret`. |
| `contributes.assist` | Which assist points you serve: any of `input`, `command`, `completion`, `terminal`, `chat` (see [Assist](#assist)). Needs the `assist` capability and `main`; such an extension starts with the window. |
| `contributes.iconThemes[]` | Up to 16 `{id, label, path}` file icon themes in VS Code's format (`path` is the theme JSON inside the extension). Data only: no `main` needed. See [Icon themes](#icon-themes). |

Icons are a fixed set: `puzzle`, `kanban`, `book-open`, `git-branch`, `globe`, `bell`, `server`,
`terminal`, `circle`, `check`, `alert`, `shield`, `chat`.

## Icon themes

`contributes.iconThemes` takes VS Code file icon themes as they ship in a `.vsix`, so a theme
such as Material Icon Theme works without changes:

1. Unzip the `.vsix` (it is a zip) and copy its `extension/` folder to
   `~/.config/pine/extensions/<name>/`.
2. Add a `pine.json` next to its `package.json`, pointing at the theme JSON the `package.json`
   lists under `contributes.iconThemes[].path`:

   ```json
   {
     "id": "material-icons",
     "name": "Material Icon Theme",
     "version": "5.0.0",
     "contributes": {
       "iconThemes": [
         { "id": "material-icon-theme", "label": "Material Icon Theme", "path": "dist/material-icons.json" }
       ]
     }
   }
   ```

3. Approve the extension when Pine asks, then pick the theme in Settings → Files → File icon
   theme or the Files header's view options.

What Pine reads from the theme JSON: `iconDefinitions` (entries with an `iconPath` to an SVG,
PNG, JPEG, GIF or WebP file), `file`, `folder`, `folderExpanded`, `fileExtensions`, `fileNames`,
`folderNames`, `folderNamesExpanded`, `languageIds`, and the same keys under `light` (used with a
light Pine theme) and `highContrast`. A file resolves like VS Code: `fileNames`, then
`fileExtensions` from the longest suffix (`d.ts` before `ts`), then `languageIds` (the VS Code
language id of the name), then `file`; an open folder tries `folderNamesExpanded`, `folderNames`,
`folderExpanded`, `folder`. Names match case-insensitively.

Not supported: font icon themes (`fonts`, `fontCharacter` definitions are skipped),
`rootFolder*` keys (Pine's tree has no root row), and `hidesExplorerArrows`.

Main loads a theme only for an enabled extension and checks it: the theme JSON at most 4 MiB,
each icon at most 512 KiB, all icons at most 48 MiB, every path inside the extension folder
after resolving symlinks, and no symlinked file. Icons reach the renderer as `data:` URLs;
the renderer never gets a path.

## Approval and capabilities

- The first launch of a user extension shows a dialog listing its `capabilities`. Approve and it
  runs with exactly those; "Keep disabled" records the decision. Built-ins skip the dialog.
- If a new version asks for more, it runs with the previously approved subset until the user
  reviews it in Settings.
- Only the human approves. There is no socket method or CLI verb for it, and agents can't grant
  themselves anything.
- Your process runs as the user, like any program. Capabilities limit what you can do **through
  pine** (events, notifications, other panes); they are not an OS sandbox.

## Talking to pine

Your process gets:

| Env | Value |
|---|---|
| `PINE_SOCKET` | Control socket path |
| `PINE_TOKEN` | This run's token (a new one on every start) |
| `PINE_EXTENSION_ID` | Your `id` |
| `PINE_EXTENSION_DIR` | Your directory |
| `PINE_EXTENSION_DATA` | A folder for your own state (`<userData>/extension-data/<id>`); create it when you first write. It isn't synced. |

Connect to the unix socket and speak JSON-RPC 2.0 with LSP-style framing
(`Content-Length: N\r\n\r\n<json>`); `vscode-jsonrpc` does this for Node. Then:

1. `hello {token}`.
2. `ext.registerCommands {commands}` — always, even with `[]`; it is also your "ready" signal.
   Pass the ids of manifest commands you handle. You may also pass full objects
   (`{id, title, …}`) for extra commands that exist only while you run.
3. Whatever else you need.

### Methods you call

| Method | Params | Notes |
|---|---|---|
| `ext.registerCommands` | `{commands: (string \| CommandContribution)[]}` | Returns `{ok, commands}`. |
| `ext.subscribe` | `{events: string[]}` | `pane.created`, `pane.closed`, `command.started`, `command.finished`, `cwd.changed`, `focus.changed` need `read-board`; `notification` needs `notify`. |
| `ext.setSidebarItem` | `{key?, workspaceId?, text, icon?, tone?, kind?, url?}` | With `workspaceId` it shows on that workspace's row, without it in the sidebar footer. `tone`: `neutral`, `brand`, `ok`, `warn`, `error`. `kind` places a row item: `location` (where the workspace is, like a branch) shares the line with the folder; `live` (the default; what is running, like ports or counts) goes on the line below, where items that don't fit fold into a `+N` popover. The footer ignores `kind`. Empty `text` removes the item. 80 chars, 32 items. With an http(s) `url` the item is a link: clicking it switches to that workspace and opens the URL in its browser pane. |
| `ext.notify` | `{title, body?, openPanel?}` | Needs `notify`. Goes into the notification center and the desktop. With `openPanel: true` (and a panel in your manifest) clicking it opens your panel instead of jumping to a pane; with `openPanel: "/path"` it opens the panel at that path (or navigates your open panel there), from the desktop notice and from the notification center alike. |
| `ext.openPanel` | `{workspaceId?, path?}` | Opens (or focuses) your panel in that workspace, else the active one. An already-open panel is focused, not reloaded; with `path` it navigates the open panel there instead of opening a second one. See [Panels](#panels) for what `path` means. |
| `ext.setPaneChip` | `{paneId, id, text, tooltip?, tone?, command?, url?}` | Shows `text` (40 chars) as chip `id` (from your `contributes.paneChips`) on that pane's header; setting it again replaces the value. `paneId` is an external pane id (`caller.paneId`, `pane.list`, events). `tone`: as for sidebar items. `command`: one of your own palette commands; clicking the chip focuses the pane and runs it, so `caller.paneId` is that pane. `url` (http/https, instead of `command`): clicking the chip opens it in the browser pane of that pane's workspace. Empty `text` clears it. Chips vanish when the pane closes or your process stops; set them again after a restart. |
| `ext.clearPaneChip` | `{paneId, id}` | Removes that chip. |
| `ext.getSettings` | — | `{ok, values}`: every key of your `contributes.settings`, with the human's value when it is valid, else the default. You also get `settings.changed` (below) whenever the values change. |
| `ext.setSetting` | `{key, value}` | Changes one of **your own** settings, for a control in your panel that mirrors it (Git's graph scope and changed-files view). Validated against your manifest exactly like Settings → Plugins (`unknown-setting`, `invalid-value`); `null` resets the key. Pine saves it in `settings.json`, shows it in Settings, and sends you `settings.changed`. Returns `{ok, values}`. You can't touch another extension's settings or any core setting. |
| `ext.openDiff` | `{title, original, modified, language?, path?, workspaceId?}` | Opens a read-only diff pane (Monaco's diff editor, side-by-side with an inline toggle) in that workspace, else the active one. Reuses the workspace's diff pane if it has one. Each side is capped at 5 MiB; `path` must be absolute and enables "Open in External Editor" at the cursor; `language` is a Monaco id, otherwise inferred from `path`. The content lives only in memory: a restored workspace drops diff panes. |
| `workspace.list` | — | Needs `read-board`. `[{workspaceId, name, kind, workDir, state, activePaneId?}]`. |
| `pane.list` | — | Needs `read-board`. `[{paneId, workspaceId, kind, title, cwd?, filePath?, running, blockCount, lastExitCode?, pid?}]`; `cwd` is the live shell cwd for terminals; `filePath` is the absolute path a file view (`kind: 'editor'`) shows, so a palette command can act on the file in the caller's pane; `pid` is the shell process of a terminal whose pty is running (absent for other kinds and for a hibernated pane). Its descendants are what the pane runs. They inherit pine's own open descriptors, so ignore sockets your parent process (pine) also holds. |
| `ext.confirm` | `{title, message, detail?, confirmLabel?, cancelLabel?}` | Asks the human in a native dialog that names your extension; Cancel is the default. Returns `{ok, confirmed}`. Use it before anything that changes the user's files or data. It waits for the human: mark a command that calls it `interactive` so its caller waits too. If the human answers after the timeout anyway, finish the work they chose. |
| `ext.getSecret` | `{key}` | `{ok, value}`: the value the human stored for one of your `contributes.secrets` keys, or `null`. Keep it in memory; don't log it. |
| `ext.setAssistStatus` | `{status: {<point>: {ready, label?, tools?}}, features?, setup?, lastError?, label?}` | Needs `assist`. Which of your assist points are usable right now and a short label naming the provider and model (`model-runtime · gemma`, 80 chars) that pine shows next to the feature. Only `ready` points are offered to the human. `tools: true` on `chat` says you handle the tool fields of a chat request (see [Chat tools](#chat-tools)); without it pine sends none. `features` lists the switches pine shows in its Assistant menu and next to each feature: `[{id, setting, ready}]` with `id` one of `chat`, `typos`, `promptReview`, `commandSuggest`, `terminalCompletions`, `editorCompletions`, `explainError` and `setting` one of your own boolean settings (pine reads on/off from it and flips it when the human does). `setup` names what is missing (`no-provider`, `no-endpoint`, `no-key`, `no-model`, `unreachable`, or `null`), `lastError` the last provider error (240 chars). `models: true` says you answer `ext.assistModels`. Call it at start and whenever your configuration or health changes. |
| `ext.shortcuts` | `{ids: string[]}` | `{ok, shortcuts: {<command id>: label \| null}}`: the human's effective key for pine palette commands (`assist.chat`, `assist.compose`, `palette.toggle`, …), so a panel can show the real shortcut. |
| `ext.openAssistUi` | `{ui, workspaceId?}` | Opens pine's own UI for an assist point you contribute: `chat` (the chat pane), `ask` (the palette's Ask) or `compose` (the composer on the active terminal). It opens the UI only; nothing is sent until the human asks. |
| `ext.assistChunk` | `{requestId, text}` | Needs `assist`. One streamed delta of a `chat` answer (256 KiB max; a JSON chunk that doesn't fit the request's 1M-character budget is dropped whole). Returns `{live}`; stop streaming when it is `false` (the human stopped or closed it). |
| `ext.openTerminal` | `{command: string[], workspaceId?, afterPaneId?, cwd?, title?}` | Needs `shell`. Opens a **new** terminal pane right of `afterPaneId` (a pane id from `caller.paneId` or `pane.list`), else of the workspace's active pane (it becomes the first pane of an empty workspace), switches to that workspace, and runs `command` there once the shell shows its first prompt. Returns `{ok, paneId}`. `command` is an argv (1–64 strings, no control characters); pine quotes each argument for the shell, so pass data, never a shell string. `cwd` must be absolute. The command runs once, and never in an existing pane. Use it for things the human should watch or answer (sudo prompts), after `ext.confirm`. |

`whoami` works too. Pane-scoped methods (`command.exec`, `pane.info`, `bus.*`, …) are refused
for extension identities, except the targetable ones below.

### Acting on a pane: `targetPaneId`

The browser methods (`browse.*`, as the `pine browse` CLI uses them), the background process
methods (`process.run|list|info|output|kill|restart`) and `pane.setAttention` accept an extra
`targetPaneId` (an external pane id) from an extension. Pine then runs the method as if the pane
you named had called it: `browse.read` without `paneId` reads that pane's workspace's browser,
`process.run` starts the process in that pane's workspace, `pane.setAttention {state, message?}`
sets that pane's attention (`waiting`, `done`, `working`, `error`, `clear`), which rings like any
other signal.

Your extension needs both the method's own capability (`browse`, `process`, `drive-self`) and
`all-workspaces` in its manifest, approved by the human. Why `all-workspaces`: an extension has
no pane of its own, so every pane is another pane, and acting on another pane always needs it.
Errors: `needs-elevation: <cap>`, `needs-target: targetPaneId` (you left it out),
`unknown-target: <id>` (not a pane). The SDK has `callAs(paneId, method, params)` and
`setAttention(paneId, state, message?)`. Pick element (`browse.pick`) is not available to
extensions: it waits for the human's click.

The SDK (`src/extensions/sdk/index.ts`, `connect()`) wraps all of this: `setPaneChip`,
`clearPaneChip`, `getSettings`, `setSetting(key, value)`, `onSettingsChanged(values => …)`, `numberSetting(values, key,
fallback, {min, max})` and `booleanSetting(values, key, fallback)` (read a value, clamped, with
a fallback), `openPanel(workspaceId?, path?)`, `notifyPanel(title, body?, path?)`,
`onPanel((caller, path) => ({url}))`, `callAs` and `setAttention`.

### Requests pine sends you

| Method | Params | Reply |
|---|---|---|
| `ext.command` | `{command, args, caller}` | A result (below). 30 s timeout, 10 min for an `interactive` command. The CLI waits as long as pine does. |
| `ext.assist` | `{point, requestId, input}` | The result for that point (below), or `{error, message?}` with `error` one of `unavailable`, `rate-limited`, `failed`, `cancelled`, `invalid`, `busy`. Carries a jsonrpc cancellation token: stop work when it fires. 30 s timeout, 5 min for `chat`. |
| `ext.assistModels` | `{action: 'list'}` or `{action: 'load' \| 'unload', id}` | Sent only to an extension whose last `ext.setAssistStatus` said `models: true`, when the human opens or acts in Settings → Assistant → Models. `list` replies `{lifecycle, models: [{id, name?, description?, installed?, loaded?, busy?, idleSecs?}], error?}` (64 models, normalized by `normalizeAssistModels`); `lifecycle: true` shows Load/Unload, otherwise each id gets Copy. `load`/`unload` reply `{ok: true}` or `{ok: false, error}`. 15 s timeout for `list`, 5 min for a load. The SDK wraps it: `onAssistModels({list, setLoaded})`. |
| `ext.panel` | `{caller, path?}` | `{url}` for a `"url"` panel: must be `http://127.0.0.1:<port>/…` or `http://localhost:<port>/…`. `path` is present when the panel is opened or navigated to a path (`ext.openPanel {path}`, a notification with `openPanel: "/path"`); return the URL for it on the same origin. |

And the notification `ext.event {type, payload}`:

| Event | Payload |
|---|---|
| `pane.created`, `pane.closed` | `{paneId, workspaceId}` |
| `command.started` | `{paneId, workspaceId, cwd?}` |
| `command.finished` | `{paneId, workspaceId, cwd?, exitCode?}` |
| `cwd.changed` | `{paneId, workspaceId, cwd}` |
| `focus.changed` | `{focused}`: whether any pine window has focus. Assume focused at start; use it to pause polling while the user is elsewhere. |
| `notification` | `{title, body?, from}` |
| `settings.changed` | `{values}`: all your settings after the human changed one, or after the human changed one of your secrets (read it again with `ext.getSecret`). Sent without `ext.subscribe`. |

`paneId` is always the external id agents see (`pine whoami`).

### The caller

Every command and panel request carries who is asking:

```ts
{ kind: 'pane' | 'user', paneId?, workspaceId?, workDir?, cwd?, locale?, capabilities: string[] }
```

- `pane`: an agent or shell via `pine`; `capabilities` are that pane's; `locale` is the app's
  language, so text you show the human can follow it.
- `user`: the palette (capabilities = the command's own declared ones; `paneId` is the focused
  pane, and a chip click's pane) or your panel request (the SDK's panel server fills `locale`
  from the page's query).

Use `workDir` for project-scoped data (it is the workspace's anchor directory, possibly `~`).
`cwd` is the live shell directory of the calling pane (CLI) or of the active pane (palette) when
that is a terminal; use it for "where the user is" (the git extension finds the repo from it).
Panel requests carry no `cwd`; derive one from `workspace.list` + `pane.list` if you need it.
Enforce conditional rules yourself from `capabilities`, for example refuse a write outside the
workspace's project unless the caller holds `all-workspaces`.

### Results

Return `{ok: true, text?, data?}` or `{ok: false, error, message?, data?}`. The CLI prints `text`
if present, else `data` as JSON, else `ok`; a failure goes to stderr with exit code 1, after its
`data` (if any) as JSON on stdout, so an agent can read a structured "no" (`pine system install`
returns `{approved: false, command}` this way). The palette
shows failures as a failed command. Anything else you return is wrapped as `{ok: true, data}`.

Errors pine produces before reaching you: `unknown-extension`, `extension-disabled`,
`unknown-command`, `needs-elevation` (message = the missing cap), `extension-unavailable`
(didn't start, crashed, timed out).

## Assist

Pine draws the UI for four hook points and hands you the request; you own the model, the provider
and the prompts. Nothing is sent to you until the human acts: every request comes from something
they typed or clicked, and terminal output only when they switched a context chip on or asked to
explain a failed block. Pine normalizes each request before you see it (size caps, known fields)
and each result before the renderer sees it.

| Point | Where the human sees it | `input` | Your result |
|---|---|---|---|
| `input` | The composer over an agent pane (Ctrl+Shift+J / ⌘J): a typo fix accepted with Tab, a prompt review on Ctrl+Enter | `{text, tasks: ('typos'\|'review')[], agent?}` | `{corrected?, review?: {score? (1-5), notes: string[] (≤5)}}` |
| `command` | The composer at a shell prompt, and `# <what you want>` in the input editor | `{query, cwd?, shell?, platform?}` | `{suggestions: [{command, description?}]}` (≤3, inserted at the prompt only when the human picks one, never run) |
| `completion` | Ghost text in the editor, accepted with Tab | `{path, language, prefix, suffix, neighbors?: [{path, text}]}` | `{text}`: only the insertion at the cursor |
| `terminal` | Ghost text continuing the command in the input editor at a shell prompt, accepted with Tab or → | `{line, cwd?, shell?, platform?, history?: [{command, exitCode?}], context?: [{label, text}]}` (never terminal output) | `{text}`: the rest of the line (pine keeps the first line only) |
| `chat` | The chat pane, Ask in the palette (Tab), and "Explain error" on a failed block | `{messages: [{role, content, tools?}], context: [{kind, label, text}], tools?: [{name, description, inputSchema}]}` | `{text}`. While producing it, send each AI SDK `UIMessageChunk` (`streamText(...).toUIMessageStream()`) JSON-encoded as one `ext.assistChunk`; pine feeds them to `useChat` |

The SDK wraps it: `onAssist(async (point, input, {requestId, signal, chunk}) => result)`,
`setAssistStatus(status)`, `getSecret(key)`, and `throw new AssistFailure('rate-limited')` for a
typed failure. Debounce and rate-limit on your side too; pine debounces keystrokes and cancels
stale requests.

### Chat tools

Pine, not your extension, runs the chat's tools, so a chat extension gains no power beyond the
public API. If you report `tools: true` on the `chat` status, a chat request may carry:

- `tools`: the tools the human left on for that chat, each `{name, description, inputSchema}`
  (a JSON schema object; names match `[A-Za-z0-9_-]{1,64}`, up to 64). Built-ins are
  `read_file`, `list_directory`, `search_files`, `terminal_context`, `git_status`, `load_skill`,
  `propose_command`, `write_file`, `open_file`, `open_url`; tools from the human's MCP servers
  are named `mcp__<server>__<tool>`.
- `messages[].tools` on assistant turns: the calls of that step with their outcome,
  `{id, name, input, state: 'done' | 'error' | 'denied', output?, error?}` (`output` is text,
  at most 32 000 characters). A request may end with such a turn instead of a user turn.

Declare the tools to your model without executing them (the AI SDK's `dynamicTool` with
`jsonSchema(inputSchema)` and no `execute`) and stream as usual: when the model calls one, the
`tool-input-available` chunk ends your step and your reply. Pine then runs the call (asking the
human when the tool acts: writes and commands every time, opening files or URLs and MCP tools
until the human allows them for the chat, reads outside the workspace folder once), records it in
the conversation, and sends you a new request with the outcome, up to 8 rounds per question.
Treat `denied` as the human's answer, not an error to retry. Skip `tool-input-delta` chunks if
you like; pine uses only the complete input.

## The CLI

```
pine ext ls                              enabled extensions and their commands
pine ext <id> <command> [args...]        run a command
pine <id> <command> [args...]            same, when <id> isn't a core verb
```

Arguments arrive as `args = {argv: [...], stdin?}`. Parse `argv` however you like. `pine docs`
appends every enabled extension's commands (from `usage`) to the core help, so agents discover
you there.

## Panels

A panel is a pane surface rendering your page in a sandboxed `<webview>`:

- its own partition (`pine-ext-<id>`), no preload, no Node, no `window.pine`, permissions denied;
- it may only show your `file://` html (file entry) or the loopback origin you returned (url
  entry); other navigations are blocked and `window.open` goes to the OS browser for http(s);
- it talks to **your process**, never to pine directly — serve an API next to the page.

The built-ins run a small HTTP server on `127.0.0.1:0` (`src/extensions/sdk/index.ts`,
`startPanelServer`): the panel URL carries a per-run secret, `/api` requires it in a header,
requests with a foreign `Host` or `Origin` are refused, and `/events` pushes "changed" over SSE
so the panel updates when an agent edits data from the CLI. Do the same if your panel has data.

A **path** addresses a page inside your panel: it starts with a single `/`, may carry `?query`
and `#hash`, and has no spaces, control characters or backslashes. For a file panel it is a file
in your extension directory (`/card.html?id=4`), and anything that resolves outside it is
refused. For a `url` panel pine hands the path to your process in `ext.panel` and you return the
full URL (keep your secret in it). Either way the result must pass the same check as any panel
URL. Navigating keeps the existing panel pane and webview.

pine injects its theme into the page as CSS custom properties once it loads and whenever the
theme changes: `--pine-<token>` for every theme token (`--pine-bg`, `--pine-surface-1`,
`--pine-fg`, `--pine-fg-muted`, `--pine-brand`, `--pine-line`, `--pine-attn-fg`, …) plus
`--pine-font-ui`, `--pine-font-mono`, `--pine-color-scheme` (`dark` or `light`; set
`color-scheme: var(--pine-color-scheme, dark)` so scrollbars and native controls follow a light
theme) and `--pine-motion-scale` (`1`, or `0` while the human has reduced motion on). Use them
with fallbacks (`var(--pine-surface-1, #272a2d)`); `src/extensions/sdk/panel.css` is a ready
base. It also defines Pine's type scale (`--text-ui-xs|sm|base|lg`), control radii
(`--radius-sm`, `--radius-md`), a `.switch` class that draws an `<input type="checkbox">` like
Pine's switch, and motion tokens (`--motion-fast`, `--motion-base`, their `-exit`
pair, `--ease-out`, `--ease-in`), already multiplied by `--pine-motion-scale`: time every
transition with them and animate only opacity and transform (hover may change colors), so a
panel follows Pine's motion rules and its reduced-motion setting (`docs/DESIGN.md` §8).

### Resizable splits

`splitter()` (`src/extensions/sdk/splitter.ts`, styles in `sdk/panel.css`) stacks two
elements with a draggable divider between them, so the human sets how tall each part is:

```ts
import { splitter } from '../sdk/splitter'
import { loadPanelSizes } from '../sdk/panel'

await loadPanelSizes()
const body = splitter({
  key: 'list-details',
  label: 'Resize details',
  first: list,
  second: details,
  defaultFraction: 0.55,
  minFirst: 96,
  minSecond: 96,
  collapseSecond: true,
})
```

- The divider is a focusable `role="separator"` (`aria-orientation="horizontal"`,
  `aria-valuenow|min|max` in percent of the height, `aria-label` from `label`). Drag it with the
  pointer (captured, never selects text), move it 16px with ↑/↓, 64px with PageUp/PageDown, to
  the minimum or maximum with Home/End; double-click resets it to `defaultFraction`.
- Both minimums hold while the panel resizes. With `collapseSecond`, a panel too short for both
  shrinks `second` to its own height (`.pine-split[data-collapsed]`; hide what shouldn't show,
  e.g. everything but a header) and hides the divider. `first` never shrinks below its own
  content when it isn't a scroll container, so content that grows (a textarea with
  `field-sizing: content`) pushes the divider down.
- Sizes are remembered per `key` as a fraction of the height, across reopen and restart:
  `startPanelServer` keeps them in `$PINE_EXTENSION_DATA/panel-sizes.json` (64 keys of
  `[A-Za-z0-9._-]`, values 0–1) and serves them at `/sizes` behind the panel secret;
  `loadPanelSizes()` reads them once, before the first split is drawn. `localStorage` doesn't
  work for this: the panel partition isn't persistent and its origin's port changes every run.
- Nothing animates the layout: only the divider's highlight fades in (opacity).

## Lifecycle

- Started on first use of a contribution (command, panel), or with the window if it contributes
  sidebar items. Stopped with SIGTERM when disabled, removed, or when pine quits; its token stops
  working at that moment, before the process exits. Re-enabled while still exiting, it starts
  again as soon as the old process is gone. A changed manifest stops the process too, and pine
  starts the new version again if the old one was running.
- If the process exits unexpectedly pine restarts it (0.5 s, 1 s, 2 s); after 3 restarts it is
  marked crashed until the user toggles it off and on. Your sidebar items, pane chips and
  subscriptions are cleared on exit; set them again after you reconnect.
- Exit when the socket closes (pine went away).
- stdout/stderr go to pine's log, prefixed `[ext:<id>]`.

## Example: a minimal extension

`~/.config/pine/extensions/hello/pine.json`:

```json
{
  "id": "hello",
  "name": "Hello",
  "version": "0.1.0",
  "description": "Greets, and shows the last exit code per workspace.",
  "capabilities": ["read-board", "notify"],
  "main": "main.js",
  "contributes": {
    "commands": [{ "id": "greet", "title": "Say Hello", "usage": "greet [name]" }],
    "sidebarItems": true
  }
}
```

`main.js` (install `vscode-jsonrpc` next to it, or bundle it):

```js
const { createConnection } = require('node:net')
const rpc = require('vscode-jsonrpc/node')

const socket = createConnection(process.env.PINE_SOCKET)
const conn = rpc.createMessageConnection(
  new rpc.StreamMessageReader(socket),
  new rpc.StreamMessageWriter(socket),
)

conn.onRequest('ext.command', async ({ command, args, caller }) => {
  if (command !== 'greet') return { ok: false, error: 'unknown-command' }
  const name = args?.argv?.[0] ?? 'there'
  await conn.sendRequest('ext.notify', { title: `Hello, ${name}` })
  return { ok: true, text: `hello ${name} from ${caller.kind}` }
})

conn.onNotification('ext.event', ({ type, payload }) => {
  if (type !== 'command.finished') return
  conn.sendRequest('ext.setSidebarItem', {
    workspaceId: payload.workspaceId,
    key: 'exit',
    text: `exit ${payload.exitCode ?? '?'}`,
    tone: payload.exitCode ? 'error' : 'ok',
  })
})

socket.on('close', () => process.exit(0))
conn.listen()
socket.on('connect', async () => {
  await conn.sendRequest('hello', { token: process.env.PINE_TOKEN })
  await conn.sendRequest('ext.subscribe', { events: ['command.finished'] })
  await conn.sendRequest('ext.registerCommands', { commands: ['greet'] })
})
```

Restart pine, approve "Hello", then run `pine hello greet you` in a pane or "Say Hello" from the
palette.

## Wrapping a CLI tool you already have

The built-in `trellis` and `keeper` extensions are the reference for this. The pattern:

- Run the tool with `runTool(bin, args, {cwd, timeoutMs})` from the SDK: no shell, stdin
  closed, a timeout, and `missing: true` when the binary isn't on `PATH`. Parse its `--json`
  output in a pure module and unit-test that against captured real output.
- Missing tool or stopped daemon: set no sidebar items, return `{ok: false, error, message}`
  from commands with what to install or start, and have your panel handler return a static
  explanation page (`startMessageServer().url(title, body)`) instead of throwing. Retry with
  backoff (`nextBackoff`), never in a tight loop.
- If you start a long-running server, stop it in `onShutdown(fn)` (runs on exit, SIGTERM, SIGINT,
  SIGHUP). If you found it already running, leave it alone.
- If the tool's web UI needs a token, keep it in your process: serve a loopback proxy that adds
  the token upstream (trellis's `proxy.ts`), so the panel URL pine sees carries only your own
  per-run secret.
- Confirm with `ext.confirm` before changing the user's data. Never automate a decision the tool
  reserves for a human (keeper approvals).
- `call(method, params)` reaches any other control method your identity may use, for example
  `workspace.list` to put an item on every workspace whose workDir belongs to the tool.

## Declarative views: UI without a process

When all you need is something for the human to look at (a sidebar section of agents and their
state, a panel with a checklist, a few buttons that run palette commands), write a view instead
of an extension. A view is one JSON file, `~/.config/pine/views/<name>.json` (`$XDG_CONFIG_HOME`
is honored; `<name>` is lowercase `a-z0-9-`, up to 40 characters). It has no process, no HTML and
no script: pine validates the file and draws it with its own components, bound to live data.

```json
{
  "version": 1,
  "title": "Agents",
  "placement": "sidebar",
  "icon": "robot",
  "root": {
    "type": "list", "for": "workspaces", "as": "ws", "empty": "No workspaces",
    "item": {
      "type": "row", "justify": "between",
      "children": [
        { "type": "text", "text": "{{ws.name}}", "truncate": true },
        { "type": "badge", "text": "{{ws.unread}}", "tone": "warn", "if": "{{ws.unread}}" },
        { "type": "button", "label": "Go", "variant": "ghost",
          "action": { "command": "workspace.goto", "args": { "index": "{{ws.index}}" } } }
      ]
    }
  }
}
```

- **Placement.** `sidebar`: a collapsible section in the workspace rail, under the workspaces.
  `panel`: a pane, opened from the palette ("Views: Open <title>") or with `pine view open <name>`.
- **Components.** `stack`, `row`, `section`, `text`, `badge`, `icon` (a fixed list of Phosphor
  icons), `list` (`for` a data path, `as` an item name), `button`, `link`, `progress`, `kv`,
  `divider`. Every node may carry `if: "{{path}}"`. Unknown properties are errors.
- **Data** (read-only, live): `workspace` (the current one), `workspaces`, `panes` (of the current
  workspace, with their agent and attention), `ports` (from the Ports extension), `approvals`
  (`{pending}`), `notifications` (newest 50), `clock` (`{now}`, ticking each second). A
  workspace also carries `git`: the Git extension's sidebar text for it.
- **Bindings.** `{{path | filter}}` inside strings: dot-separated names or indices only, own
  properties only (`__proto__`, `constructor`, `prototype` are refused), missing paths render
  empty. Filters: `upper`, `lower`, `count`, `not`, `relative`, `time`, `date`.
- **Actions.** `{"command", "args"}` runs a palette command exactly like a user action in
  `settings.json`: strings in `args` take bindings (a whole-string binding keeps its type), and a
  command that needs a non-default capability asks the human first (Run once / Run and trust).
  `{"openUrl"}` and `link` open http/https URLs in the workspace's browser pane; any other scheme
  is refused when the file is read, and a binding that resolves to one draws a disabled control.
- **Budget.** 200 nodes, 10 levels and a 64 KiB file when read; while drawing, 50 items per list
  unless `limit` says fewer, and 1000 drawn nodes. Over budget, the last good render stays with a
  note saying why.
- **Approval.** A new file is pending: nothing is drawn until the human turns it on in
  Settings → Views, which lists every file with its placement, errors (line and path) and a
  reveal button. Agents can write files but can't enable them. Edits to an enabled view show
  live; an edit that breaks it keeps the last version that worked on screen.
- **Tools.** `pine view schema` prints the JSON Schema, `pine view validate <file>` prints one
  `file:line: path: message` per problem (both work outside Pine), `pine view list` shows
  each file's status.

## Built-in extensions

`src/extensions/<id>/` holds `pine.json`, `main.ts` and optionally `panel.html`, `panel.ts`,
`panel.css`. `scripts/build-extensions.mjs` (part of `pnpm build`) bundles them into
`out/extensions/<id>/`; electron-builder ships that dir as `resources/extensions`. They import
only `src/extensions/sdk/` and `src/shared/` — never `src/main` or `src/renderer`.

| Id | What it does |
|---|---|
| `git` | Branch and change counts per workspace in the sidebar; `git.branch` (`main • ↑2 ↓1`, click opens the panel) and `git.diff-stats` (`3 • +12 -4`) chips on every terminal in a repo; a Git panel with Changes (stage, unstage, discard after `ext.confirm`, commit; flat list or folder tree), Graph (lanes, ref badges, an uncommitted-changes row, the current, all or chosen branches; a commit's files open as diffs) and Blame pages ("Show Changes", "Show Graph", "Blame File"); settings `pollSeconds`, `showDiffStats`, `graphScope`, `changesView` (the panel's controls write the last two with `ext.setSetting`); `pine git status|changes|diff|open|log|blame|stage|unstage|commit` (discard is panel only) |
| `trellis` | The Trellis web UI as a panel on the workspace's project, open/claimed card counts per workspace, notifications when an agent moves a card to review or blocked that open the card, "Trellis: Open Board", "Trellis: Open Card" (`pine trellis card <REF>`), "Trellis: Init Project Here", `pine trellis status`. Settings: `notifyReview`, `notifyBlocked`, `refreshSeconds` |
| `ports` | Per workspace, the TCP ports its terminals' processes listen on as `:port` links that open in the browser pane, and the host of a foreground `ssh`; per terminal pane, a `ports` chip (click opens the first port) and an `ssh` chip with `user@host`. Polls only while pine is focused. `pine ports ls [--all]`. Settings: `intervalSeconds` (default 3), `portHost` (`localhost` or `127.0.0.1`) |
| `system` | `pine system info` (OS, kernel, arch, shell, package managers on PATH and the default one) and `pine system install <pkg...> [--manager <name>] [--reason <text>]`: validates the names, shows the human the exact install command and the reason, and on Approve runs it in a new terminal next to the agent (`ext.openTerminal`). Returns `{approved, command, paneId?}`; a denial exits 1 |
| `assistant` | The assist points on a provider the human picks in its settings: `model-runtime` (the user's local runtime on `$XDG_RUNTIME_DIR/model-runtime.sock`, with load and unload in Settings → Assistant → Models), `ollama`, any `openai-compatible` endpoint (LM Studio, llama.cpp server, …), `openrouter`, `openai` or `anthropic`; the API key is a secret. Built on the AI SDK (`ai`, `@ai-sdk/openai-compatible` with a unix-socket `fetch` for model-runtime, `@ai-sdk/openai`, `@ai-sdk/anthropic`, `@openrouter/ai-sdk-provider`, zod for structured answers). A fast model for typos, reviews, commands and terminal/editor completions, a chat model for the chat pane and Ask, a switch per feature (`typos`, `promptReview`, `commandSuggest`, `terminalCompletions`, `editorCompletions`, `chat`, `explainError`) and a requests-per-minute limit. Inert until a provider is chosen. It has no panel: Settings → Assistant shows each feature with its switch, readiness, shortcut and "Try it", its settings, and the provider's models (`ext.assistModels`); "Assistant: Chat" opens the chat pane |
| `keeper` | The Keeper dashboard as a panel, a footer count of queries waiting for approval, "Keeper needs approval" notifications that open the approvals queue (Keeper has no per-ticket page), "Keeper: Open Dashboard", "Keeper: Show Pending Approvals" (`pine keeper approvals`). It only reads the queue. Settings: `notify`, `pollSeconds`, `idlePollSeconds` |

Earlier versions also shipped `kanban` and `wiki` extensions. They were removed: boards, cards and
knowledge entries live in Trellis (the `trellis` extension and the `trellis` CLI). pine leaves
their data where it was (`<workDir>/.pine/board.json`, `<workDir>/.pine/wiki.json`,
`$XDG_DATA_HOME/pine/wiki.json`) and no longer reads it; entries for them in `extensions.json`
are ignored.

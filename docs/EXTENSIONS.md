# Writing a pine extension

An extension is a directory with a `pine.json` manifest and, usually, a program pine starts for
you. The program talks JSON-RPC to pine over the same control socket the `pine` CLI uses. That
gives it palette and CLI commands, events, sidebar status items, pane chips, typed settings,
notifications and a panel surface. The built-in Git, Trellis, Keeper and System (`src/extensions/`) use nothing else, so they
are the reference implementations.

How it works inside pine: `docs/ARCHITECTURE.md` §11. Why it's out-of-process: `docs/ROADMAP.md` §2.

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
no sidebar items and no pane chips.

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
      "interval": { "type": "number", "default": 3, "description": "Seconds between scans" },
      "showSsh": { "type": "boolean", "default": true, "description": "Show the ssh host" },
      "sort": { "type": "enum", "values": ["port", "name"], "default": "port",
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
| `contributes.commands[]` | `id` (no dots), `title`, optional `category`, `usage` (shown in `pine docs` / `pine ext ls`), `palette` (default `true`; `false` = CLI/agents only), `stdin` (CLI pipes stdin to you), `interactive` (the command waits on the human, usually through `ext.confirm`: pine waits up to 10 min for your reply instead of 30 s), `capabilities` (what the **caller** must hold; checked by pine before your process sees the call). |
| `contributes.sidebarItems` | `true` if you call `ext.setSidebarItem`. Such extensions start with the window instead of on first use. |
| `contributes.panel` | `title`, optional `icon`, and `entry`: a `.html` path inside the extension, or `"url"` to hand pine a loopback URL at runtime. |
| `contributes.paneChips` | Up to 8 `{id, title}`. Each is a slot for a short value you put on a pane's header with `ext.setPaneChip` (for example a branch, a venv, a test count). `title` names it in tooltips and in views that list chips. Needs `main`. |
| `contributes.settings` | Up to 32 keys (`[A-Za-z][A-Za-z0-9_-]*`), each `{type, default, description}` with `type` one of `string` (≤ 1000 chars), `number`, `boolean`, `enum` (plus `values: string[]`). The default must match the type. Settings → Plugins shows a form for them; the human's values are stored in `settings.json` under `extensionSettings.<id>` and synced with it, so never put a secret there. |
| `contributes.workflows[]` | Saved workflows in Warp's format (at most 64): `name`, `command` with `{{arg}}` placeholders (`{{{x}}}` is a literal `{{x}}`), optional `description`, `tags`, `arguments[{name, description, default_value}]`, `shells`, `author`, `source_url`. Data only: no `main` needed. They appear in "Workflows: Search" and `pine workflow list` while the extension is enabled and approved; pine inserts one at an idle prompt only when the human picks it. |

Icons are a fixed set: `puzzle`, `kanban`, `book-open`, `git-branch`, `globe`, `bell`, `server`,
`terminal`, `circle`, `check`, `alert`, `shield`.

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
| `ext.setSidebarItem` | `{key?, workspaceId?, text, icon?, tone?, url?}` | With `workspaceId` it shows on that workspace's row, without it in the sidebar footer. `tone`: `neutral`, `brand`, `ok`, `warn`, `error`. Empty `text` removes the item. 80 chars, 32 items. With an http(s) `url` the item is a link: clicking it switches to that workspace and opens the URL in its browser pane. |
| `ext.notify` | `{title, body?, openPanel?}` | Needs `notify`. Goes into the notification center and the desktop. With `openPanel: true` (and a panel in your manifest) clicking it opens your panel instead of jumping to a pane; with `openPanel: "/path"` it opens the panel at that path. |
| `ext.openPanel` | `{workspaceId?, path?}` | Opens (or focuses) your panel in that workspace, else the active one. An already-open panel is focused, not reloaded; with `path` it navigates the open panel there instead of opening a second one. See [Panels](#panels) for what `path` means. |
| `ext.setPaneChip` | `{paneId, id, text, tooltip?, tone?, command?}` | Shows `text` (40 chars) as chip `id` (from your `contributes.paneChips`) on that pane's header; setting it again replaces the value. `paneId` is an external pane id (`caller.paneId`, `pane.list`, events). `tone`: as for sidebar items. `command`: one of your own palette commands; clicking the chip focuses the pane and runs it, so `caller.paneId` is that pane. Empty `text` clears it. Chips vanish when the pane closes or your process stops; set them again after a restart. |
| `ext.clearPaneChip` | `{paneId, id}` | Removes that chip. |
| `ext.getSettings` | — | `{ok, values}`: every key of your `contributes.settings`, with the human's value when it is valid, else the default. You also get `settings.changed` (below) whenever the values change. |
| `ext.openDiff` | `{title, original, modified, language?, path?, workspaceId?}` | Opens a read-only diff pane (Monaco's diff editor, side-by-side with an inline toggle) in that workspace, else the active one. Reuses the workspace's diff pane if it has one. Each side is capped at 5 MiB; `path` must be absolute and enables "Open in External Editor" at the cursor; `language` is a Monaco id, otherwise inferred from `path`. The content lives only in memory: a restored workspace drops diff panes. |
| `workspace.list` | — | Needs `read-board`. `[{workspaceId, name, kind, workDir, state, activePaneId?}]`. |
| `pane.list` | — | Needs `read-board`. `[{paneId, workspaceId, kind, title, cwd?, running, blockCount, lastExitCode?, pid?}]`; `cwd` is the live shell cwd for terminals; `pid` is the shell process of a terminal whose pty is running (absent for other kinds and for a hibernated pane). Its descendants are what the pane runs. They inherit pine's own open descriptors, so ignore sockets your parent process (pine) also holds. |
| `ext.confirm` | `{title, message, detail?, confirmLabel?, cancelLabel?}` | Asks the human in a native dialog that names your extension; Cancel is the default. Returns `{ok, confirmed}`. Use it before anything that changes the user's files or data. It waits for the human: mark a command that calls it `interactive` so its caller waits too. If the human answers after the timeout anyway, finish the work they chose. |
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
`clearPaneChip`, `getSettings`, `onSettingsChanged(values => …)`, `openPanel(workspaceId?,
path?)`, `notifyPanel(title, body?, path?)`, `onPanel((caller, path) => ({url}))`, `callAs` and
`setAttention`.

### Requests pine sends you

| Method | Params | Reply |
|---|---|---|
| `ext.command` | `{command, args, caller}` | A result (below). 30 s timeout, 10 min for an `interactive` command. The CLI waits as long as pine does. |
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
| `settings.changed` | `{values}`: all your settings after the human changed one. Sent to every extension that contributes settings, without `ext.subscribe`. |

`paneId` is always the external id agents see (`pine whoami`).

### The caller

Every command and panel request carries who is asking:

```ts
{ kind: 'pane' | 'user', paneId?, workspaceId?, workDir?, cwd?, locale?, capabilities: string[] }
```

- `pane`: an agent or shell via `pine`; `capabilities` are that pane's; `locale` is the app's
  language, so text you show the human can follow it.
- `user`: the palette (capabilities = the command's own declared ones) or your panel request.

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
`--pine-font-ui` and `--pine-font-mono`. Use them with fallbacks
(`var(--pine-surface-1, #272a2d)`); `src/extensions/sdk/panel.css` is a ready base.

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

## Built-in extensions

`src/extensions/<id>/` holds `pine.json`, `main.ts` and optionally `panel.html`, `panel.ts`,
`panel.css`. `scripts/build-extensions.mjs` (part of `pnpm build`) bundles them into
`out/extensions/<id>/`; electron-builder ships that dir as `resources/extensions`. They import
only `src/extensions/sdk/` and `src/shared/` — never `src/main` or `src/renderer`.

| Id | What it does |
|---|---|
| `git` | Branch and change counts per workspace in the sidebar, a changes panel ("Show Changes"), diffs of changed files, `pine git status|changes|diff|open` |
| `trellis` | The Trellis web UI as a panel on the workspace's project, open/claimed card counts per workspace, notifications when an agent moves a card to review, "Trellis: Open Board", "Trellis: Init Project Here", `pine trellis status` |
| `ports` | Per workspace, the TCP ports its terminals' processes listen on as `:port` links that open in the browser pane, and the host of a foreground `ssh`. Polls every 3 s only while pine is focused. `pine ports ls [--all]` |
| `system` | `pine system info` (OS, kernel, arch, shell, package managers on PATH and the default one) and `pine system install <pkg...> [--manager <name>] [--reason <text>]`: validates the names, shows the human the exact install command and the reason, and on Approve runs it in a new terminal next to the agent (`ext.openTerminal`). Returns `{approved, command, paneId?}`; a denial exits 1 |
| `keeper` | The Keeper dashboard as a panel, a footer count of queries waiting for approval, "Keeper needs approval" notifications, "Keeper: Open Dashboard", "Keeper: Show Pending Approvals" (`pine keeper approvals`). It only reads the queue |

Earlier versions also shipped `kanban` and `wiki` extensions. They were removed: boards, cards and
knowledge entries live in Trellis (the `trellis` extension and the `trellis` CLI). pine leaves
their data where it was (`<workDir>/.pine/board.json`, `<workDir>/.pine/wiki.json`,
`$XDG_DATA_HOME/pine/wiki.json`) and no longer reads it; entries for them in `extensions.json`
are ignored.

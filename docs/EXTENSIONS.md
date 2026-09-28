# Writing a pine extension

An extension is a directory with a `pine.json` manifest and, usually, a program pine starts for
you. The program talks JSON-RPC to pine over the same control socket the `pine` CLI uses. That
gives it palette and CLI commands, events, sidebar status items, notifications and a panel
surface. The built-in Kanban and Wiki (`src/extensions/`) use nothing else, so they are the
reference implementations.

How it works inside pine: `docs/ARCHITECTURE.md` §11. Why it's out-of-process: `docs/ROADMAP.md` §2.

## Where extensions live

| Location | Kind |
|---|---|
| `resources/extensions/<id>/` in the app (`out/extensions` in dev) | Built-in: pre-approved, enabled by default |
| `~/.config/pine/extensions/<id>/` (`$XDG_CONFIG_HOME` is honored) | Yours: asks for approval on first launch |

Extensions are discovered at startup; restart pine after adding one. Settings → Plugins lists
every extension with its status and permissions and has an enable switch for each. A disabled
extension has no process, no commands, no panel and no sidebar items.

## Manifest (`pine.json`)

```json
{
  "id": "ports",
  "name": "Ports",
  "version": "0.1.0",
  "description": "Shows listening dev servers per session.",
  "capabilities": ["read-board", "notify"],
  "main": "main.js",
  "contributes": {
    "commands": [
      { "id": "open", "title": "Open Ports", "category": "App" },
      { "id": "ls", "title": "List ports", "usage": "ls [--all]", "palette": false,
        "capabilities": ["read-board"] },
      { "id": "note", "title": "Attach a note", "usage": "note <port>", "palette": false,
        "stdin": true }
    ],
    "sidebarItems": true,
    "panel": { "title": "Ports", "icon": "server", "entry": "url" }
  }
}
```

| Field | Meaning |
|---|---|
| `id` | Lowercase letters, digits and dashes, 2–40 chars. It is the CLI verb (`pine ports ls`) and the command prefix (`ports.open`). |
| `name`, `version`, `description` | Shown in Settings and the approval dialog. |
| `capabilities` | What the extension process may do through pine. It gets this list intersected with what the user approved. Names are pine's capability names (`shared/capabilities.ts`). |
| `main` | Path inside the extension dir. `.js`/`.cjs`/`.mjs` run with pine's own Electron binary as Node (`ELECTRON_RUN_AS_NODE=1`), so no system Node is needed; anything else is executed directly (any language). cwd is the extension dir. Required if you contribute commands, sidebar items or a `url` panel. |
| `contributes.commands[]` | `id` (no dots), `title`, optional `category`, `usage` (shown in `pine docs` / `pine ext ls`), `palette` (default `true`; `false` = CLI/agents only), `stdin` (CLI pipes stdin to you), `capabilities` (what the **caller** must hold; checked by pine before your process sees the call). |
| `contributes.sidebarItems` | `true` if you call `ext.setSidebarItem`. Such extensions start with the window instead of on first use. |
| `contributes.panel` | `title`, optional `icon`, and `entry`: a `.html` path inside the extension, or `"url"` to hand pine a loopback URL at runtime. |

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
| `ext.subscribe` | `{events: string[]}` | `pane.created`, `pane.closed`, `command.started`, `command.finished`, `cwd.changed` need `read-board`; `notification` needs `notify`. |
| `ext.setSidebarItem` | `{key?, sessionId?, text, icon?, tone?}` | With `sessionId` it shows on that session's row, without it in the sidebar footer. `tone`: `neutral`, `brand`, `ok`, `warn`, `error`. Empty `text` removes the item. 80 chars, 32 items. |
| `ext.notify` | `{title, body?, openPanel?}` | Needs `notify`. Goes into the notification center and the desktop. With `openPanel: true` (and a panel in your manifest) clicking it opens your panel instead of jumping to a pane. |
| `ext.openPanel` | `{sessionId?}` | Opens (or focuses) your panel in that session, else the active one. An already-open panel is focused, not reloaded. |
| `ext.confirm` | `{title, message, detail?, confirmLabel?, cancelLabel?}` | Asks the human in a native dialog that names your extension; Cancel is the default. Returns `{ok, confirmed}`. Use it before anything that changes the user's files or data. It waits for the human, so a palette command that calls it may outlive the 30 s command timeout; finish the work anyway. |

`whoami` works too. Pane-scoped methods (`command.exec`, `pane.info`, `browse.*`, …) are refused
for extension identities.

### Requests pine sends you

| Method | Params | Reply |
|---|---|---|
| `ext.command` | `{command, args, caller}` | A result (below). 30 s timeout. |
| `ext.panel` | `{caller}` | `{url}` for a `"url"` panel: must be `http://127.0.0.1:<port>/…` or `http://localhost:<port>/…`. |

And the notification `ext.event {type, payload}`:

| Event | Payload |
|---|---|
| `pane.created`, `pane.closed` | `{paneId, sessionId}` |
| `command.started` | `{paneId, sessionId, cwd?}` |
| `command.finished` | `{paneId, sessionId, cwd?, exitCode?}` |
| `cwd.changed` | `{paneId, sessionId, cwd}` |
| `notification` | `{title, body?, from}` |

`paneId` is always the external id agents see (`pine whoami`).

### The caller

Every command and panel request carries who is asking:

```ts
{ kind: 'pane' | 'user' | 'phone', paneId?, sessionId?, workDir?, locale?, capabilities: string[] }
```

- `pane`: an agent or shell via `pine`; `capabilities` are that pane's.
- `user`: the palette (capabilities = the command's own declared ones) or your panel request.
- `phone`: the companion app through the gateway.

Use `workDir` for project-scoped data (it is the session's anchor directory, possibly `~`).
Enforce conditional rules yourself from `capabilities` — the wiki refuses `--global` writes
without `workspace-wide` this way.

### Results

Return `{ok: true, text?, data?}` or `{ok: false, error, message?}`. The CLI prints `text` if
present, else `data` as JSON, else `ok`; a failure goes to stderr with exit code 1. The palette
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

pine injects its theme into the page as CSS custom properties once it loads and whenever the
theme changes: `--pine-<token>` for every theme token (`--pine-bg`, `--pine-surface-1`,
`--pine-fg`, `--pine-fg-muted`, `--pine-brand`, `--pine-line`, `--pine-attn-fg`, …) plus
`--pine-font-ui` and `--pine-font-mono`. Use them with fallbacks
(`var(--pine-surface-1, #272a2d)`); `src/extensions/sdk/panel.css` is a ready base.

## Lifecycle

- Started on first use of a contribution (command, panel), or with the window if it contributes
  sidebar items. Stopped with SIGTERM when disabled or when pine quits.
- If the process exits unexpectedly pine restarts it (0.5 s, 1 s, 2 s); after 3 restarts it is
  marked crashed until the user toggles it off and on. Your sidebar items and subscriptions are
  cleared on exit; set them again after you reconnect.
- Exit when the socket closes (pine went away).
- stdout/stderr go to pine's log, prefixed `[ext:<id>]`.

## Example: a minimal extension

`~/.config/pine/extensions/hello/pine.json`:

```json
{
  "id": "hello",
  "name": "Hello",
  "version": "0.1.0",
  "description": "Greets, and shows the last exit code per session.",
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
    sessionId: payload.sessionId,
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
  `session.list` to put an item on every session whose workDir belongs to the tool.

## Built-in extensions

`src/extensions/<id>/` holds `pine.json`, `main.ts` and optionally `panel.html`, `panel.ts`,
`panel.css`. `scripts/build-extensions.mjs` (part of `pnpm build`) bundles them into
`out/extensions/<id>/`; electron-builder ships that dir as `resources/extensions`. They import
only `src/extensions/sdk/` and `src/shared/` — never `src/main` or `src/renderer`.

| Id | What it does |
|---|---|
| `kanban` | Per-project board (`.pine/board.json`), panel + `pine kanban …` |
| `wiki` | Project and global notes, panel + `pine wiki …` |
| `trellis` | The Trellis web UI as a panel on the session's project, open/claimed card counts per session, notifications when an agent moves a card to review, "Trellis: Open Board", "Trellis: Init Project Here", `pine trellis status` |
| `keeper` | The Keeper dashboard as a panel, a footer count of queries waiting for approval, "Keeper needs approval" notifications, "Keeper: Open Dashboard", "Keeper: Show Pending Approvals" (`pine keeper approvals`). It only reads the queue |

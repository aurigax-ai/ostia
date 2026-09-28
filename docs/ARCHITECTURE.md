# Architecture

How pine is built today. Product intent is in [`PRODUCT.md`](../PRODUCT.md); the look is in
[`DESIGN.md`](DESIGN.md); the rules an agent must follow when editing code (invariants,
dragons) are in [`CLAUDE.md`](../CLAUDE.md). This file describes structure and records the
reasons behind non-obvious choices ("Why:" notes). The code has no comments, so this is where
the reasons live.

## 1. Stack

| Layer | Choice |
|---|---|
| Shell | Electron, electron-vite (dev/build), electron-builder (package) |
| UI | React 18 + TypeScript strict, zustand, Tailwind v4, shadcn on Base UI, lucide-react, cmdk |
| Terminal | node-pty in main; `@xterm/xterm` 6 + fit, search, web-links, unicode11 addons (DOM renderer) |
| Splits | allotment |
| Editor | monaco-editor with locally bundled workers; hand-written LSP client over `vscode-jsonrpc` |
| Control plane | `vscode-jsonrpc` over a unix socket; `pine` CLI bundled by esbuild |
| Gateway | node `https` + `ws`, `selfsigned` cert, `qrcode` in the renderer |
| Tests | Vitest (node + jsdom projects), Playwright against the built app |

Why xterm.js and not a native engine (Ghostty, alacritty): a native terminal renders to its own
GPU surface and cannot composite into Chromium. Using one means dropping Electron and rebuilding
the UI natively. If input latency ever becomes a hard requirement, the thing to revisit is
Electron itself.

## 2. Processes

```
main (Node, privileged)  ──ipcMain / webContents.send──  preload (contextBridge)  ──  renderer (React, no Node)
   │                                                                                     │
   ├─ unix socket (JSON-RPC) ── pine CLI (in each pane's shell)                          └─ <webview> guests (browser panes)
   └─ https + wss (off by default) ── phone companion
```

- **main** (`src/main/*.ts`, `src/main/gateway/*`): windows, ptys, fs, LSP processes, background
  processes, the JSON stores, the control socket and the gateway.
- **preload** (`src/preload/index.ts`): one `contextBridge.exposeInMainWorld('pine', …)`. Each
  method forwards to `ipcRenderer.invoke/send/on`. It holds no logic.
- **renderer** (`src/renderer/`): all UI state. It reaches privileged operations only through
  `window.pine`.
- **shared** (`src/shared/`): `types.ts` (the `PineBridge` contract and snapshot types),
  `capabilities.ts` (capability names), `protoGuard.ts` (prototype-pollution guard).
- **cli** (`src/cli/index.ts`): the `pine` binary, built to `out/cli/index.js`.

Every window uses `contextIsolation`, `sandbox`, no `nodeIntegration`, and `webviewTag: true`
(for browser panes). External links are denied in-window and opened by the OS. Windows are
frameless: macOS keeps native traffic lights (`titleBarStyle: hidden`); Linux/Windows draw their
own min/max/close (`WindowControls.tsx`). There is one main window; tear-off windows were removed.

### Main module map

| File | Owns |
|---|---|
| `index.ts` | App and window lifecycle, all core IPC handlers, pty spawn/attach, scrollback autosave, quit sequence, `execCommand` (control plane → renderer) |
| `ptySession.ts` | `PtySession`: one pty fanned out to many subscribers (owners write and keep it alive; observers read) |
| `ptyRingBuffer.ts` | Capped output ring with a monotonic cursor; `since(cursor)` reports `dropped` when the cursor fell off |
| `shellIntegration.ts` | Generates zsh/bash init files that emit OSC 133 + OSC 7 and define the `pine()` shell function |
| `privateTmp.ts` | Per-uid, mode-0700 temp dir for those files |
| `sessionSnapshot.ts` | Reads/validates/writes `sessions.json` and `scrollback.json`; one-shot restored scrollback |
| `pathGuard.ts` | `resolveSafe` / `isPathAllowed` / `expandHome` for fs IPC and browser file outputs |
| `lsp.ts` | Spawns language servers found on `PATH`, relays JSON-RPC to the renderer |
| `controlServer.ts`, `controlAuth.ts`, `capabilityStore.ts`, `idRegistry.ts` | Control socket, token auth, per-pane capabilities, pane id ↔ external id ↔ token |
| `sessionRegistry.ts` | Session id → workDir, fed by lifecycle events |
| `paneList.ts` | `pane.list`, `session.list` (maps renderer ids to external ids) |
| `events.ts` | In-process platform events (`notify`, `agent.needs-input`, `agent.done`, `session.state`, `pane.state`); only the gateway listens |
| `jsonStore.ts` | Atomic JSON persistence, project (`<workDir>/.pine/<name>.json`) or global (`$XDG_DATA_HOME/pine/<name>.json`) |
| `processManager.ts`, `vault.ts`, `wiki.ts`, `kanban.ts`, `bus.ts`, `notify.ts`, `docs.ts` | Agent toolbelt control methods (§6) |
| `browse.ts` | `browse.*` automation of browser panes (§9) |
| `gateway/` | LAN gateway: `index.ts` (methods + IPC), `server.ts`, `controlDispatch.ts`, `devices.ts`, `pairing.ts`, `cert.ts`, `interfaces.ts` (§7) |

Why the control-plane modules never import `main/index.ts`: that creates an import cycle.
`index.ts` passes its functions in instead (`registerControlServer(deps)`,
`registerPaneListMethods`, the gateway's deps).

### Data locations

- `~/.config/pine/settings.json` (Electron `userData`): settings, including `capabilities.grants`.
- `userData/gateway/{cert,key}.pem`: gateway TLS identity.
- `$XDG_DATA_HOME/pine/` (default `~/.local/share/pine/`): `sessions.json`, `scrollback.json`,
  `notifications.json`, processes, bus, global wiki/vault, `gateway-devices.json`,
  `gateway-config.json`, `gateway-pair-audit.log`.
- `<workDir>/.pine/`: project-scoped wiki, vault, `board.json` (kanban).
- `$XDG_RUNTIME_DIR/pine-<pid>.sock` (or the OS tmp dir): control socket.

`jsonStore` writes a temp file and renames it over the target. With `{secure}` it re-applies mode 0600
to the file and 0700 to the dir on every save (vault, gateway devices).

## 3. IPC contract

`PineBridge` in `shared/types.ts` is the whole renderer→main surface. Adding a capability means
adding it there, adding a handler in main, and adding a forwarder in preload. `test/mocks/pine.ts`
is typed as `PineBridge`, so drift breaks the build.

| Area | Methods |
|---|---|
| app / window | `ping`, `info`, `platform`; `minimize`, `toggleMaximize`, `close`, `isMaximized`, `onMaximizeChange` |
| pty | `attach`, `detach`, `write`, `resize`, `onData`, `onExit` (push channels `pty:data:<id>`, `pty:exit:<id>`) |
| fs | `list`, `read`, `write` (confined by `resolveSafe` to `[homedir, userData]`) |
| lsp | `list`, `start`, `send`, `stop`, `onMessage`, `onExit` |
| settings / session | `settings.path`; `session.save`, `session.load` |
| lifecycle | `lifecycle.emit` (`pane-created`, `pane-closed`, `session-added`, `session-closed`, `session-activated`, `session-state`) |
| commands | `publish` (renderer's command list), `onInvoke` (run a command for main) |
| terminal state | `terminalState.push` |
| browser | `register`, `unregister` |
| kanban / wiki | `kanban.get`, `kanban.mutate`; `wiki.list`, `wiki.get`, `wiki.set` |
| gateway | `enable`, `disable`, `pair`, `status`, `devices`, `revoke`, `bind-options`, `set-cap` (IPC only) |

- Main derives the window from `e.sender.id` and never trusts a window id the renderer sends.
- `pane-closed` drops the pane's capabilities, identity, pending restored scrollback and cached
  terminal state.
- The kanban/wiki/gateway IPC skips capability checks. Only Pine's own renderer can call it,
  and it is the trusted UI. The socket and gateway enforce capabilities for everything else.
- Path containment in `pathGuard` is lexical. A symlink inside home that points outside is not
  caught.

## 4. Terminal

### Pty lifecycle

Ptys live in main keyed by renderer pane id (see CLAUDE.md §4). Spawn happens on the first
`pty:attach`, at the size the renderer actually fitted (see CLAUDE.md §6 for the sizing
dragons). Terminal name `xterm-color`.

Spawn env: `PINE_PANE_ID` (the external id, not the renderer id), `PINE_TOKEN`, `PINE_SOCKET`,
`PINE_WORKSPACE` (despite the name, the pane's spawn cwd), `PINE_CLI` (`out/cli/index.js`),
`PINE_NODE` (`process.execPath`), plus the shell-integration env.

- The live ring is capped at 1 MB. `pty:attach` returns a replay from the ring; `pty:detach`
  starts `DETACH_GRACE_MS` (3 s) before the pty is reaped.
- The window `closed` handler removes that window's subscriber from every pty. Why: a crashed or
  force-closed window never sends `pty:detach`, and without this the ptys leak. Browser panes are
  pruned before `removeWindow()` because pruning needs the registry entries.
- Renderer attach order (`Terminal.tsx`): subscribe `onData`, then attach, then dispose the pane's
  markers and call `blocksStore.resetPane`, then write the replay, then flush queued bytes.
  `resetPane` also bumps the pane's generation, which lets main reject stale terminal-state snapshots.

### Shell integration

`shellIntegration.ts` writes init files into `privateTmpDir('pine-shell-integration')`, which is
`tmpdir()/pine-shell-integration-<uid>` with mode 0700. The dir is refused if it is a symlink or
owned by another user. Why: on a shared `/tmp`, another user could plant rc files your shell sources.

- **zsh**: a generated `ZDOTDIR` whose `.zshenv` and `.zshrc` source the user's real files. If
  the user's `.zshenv` itself changes `ZDOTDIR`, the generated `.zshenv` records the new value
  as `PINE_ZDOTDIR_ORIG` and resets `ZDOTDIR` to Pine's dir. Why: otherwise Pine's `.zshrc` is
  skipped and integration silently vanishes.
- **bash**: `--rcfile`. The OSC 133;B mark is appended after the user's `PROMPT_COMMAND` runs,
  because starship and powerline rebuild `PS1` there. A bash 5.1 array `PROMPT_COMMAND` is kept
  and each element is eval'd.
- **Other shells** spawn with no integration.
- **`pine()` shell function**: it runs `ELECTRON_RUN_AS_NODE=1 $PINE_NODE $PINE_CLI`, so no
  system Node is needed. electron-builder unpacks `out/cli/**` from the asar for this.

### Rendering, blocks, state

- `Terminal.tsx` registers OSC 7 (cwd, raw path) and OSC 133 A/B/C/D handlers. Scrollback is 10k.
  Web links open on Ctrl/Cmd+click. `TerminalFind.tsx` wraps the search addon.
- **Blocks** (`stores/blocksStore.ts`, `components/Blocks.tsx`):
  - Each OSC 133 mark registers an xterm marker (`registerMarker(0)`), which tracks its line
    through reflow and trimming. Line -1 means the line was trimmed away.
  - A→C is the draft; C→D is a running block. At most 200 blocks are kept per pane.
  - A second C with no D closes the previous block. Why: a D can be lost to buffer truncation.
  - The overlay is non-interactive. It redraws on `onRender`/`onScroll`, draws up to 80
    left-edge bars (red on non-zero exit), and draws nothing in the alternate buffer or when
    the cell height measures 0.
- **Long-command notification**: when a command runs ≥ 10 s (`NOTIFY_AFTER_MS`) while the window
  is unfocused, the renderer raises a desktop `Notification`. The command text comes from the
  buffer line at mark B, starting at the cursor column recorded at B.
- **Terminal state bridge** (`commands/terminalStateBridge.ts`): a read-only listener on
  `blocksStore` + `layoutStore` that pushes `{cwd, running, blockCount, lastExitCode, generation}`
  per pane, debounced 100 ms. cwd is watched in `layoutStore` because an OSC 7 change doesn't
  touch `blocksStore`.
  - Main keeps the snapshot only if its `generation` is ≥ the cached one.
  - Main emits `pane.state` only when a field actually changed.
- **Terminal palette** (`components/terminalTheme.ts`): xterm draws to canvas and can't read CSS
  variables, so each theme's palette is duplicated here. Only `adeberry` and `one-dark-vivid` have
  palettes; other themes fall back to One Dark Vivid.

## 5. Renderer model

### Sessions, layout, surfaces

- **Session** (`stores/sessionsStore.ts`) → **split tree** (`layout/tree.ts`, pure; `stores/layoutStore.ts`)
  → **Pane** → one **Surface**: `terminal | editor | browser | kanban | wiki`.
  - The `agent` kind exists but has no surface (it shows a ghost title).
  - Zoom renders only `zoomedPaneId`.
  - Closing the zoomed pane clears the zoom.
- **Surface persistence** (`components/SurfacePool.tsx`, `stores/surfaceSlotsStore.ts`):
  - SurfacePool portals every pane's surface, across all sessions, into a persistent,
    absolutely-positioned host div created in a detached parking holder.
  - `Pane` has a callback ref that calls `mountSurface`, which moves the host into the pane's slot.
    `parkSurface` moves it back, but only if that slot still owns it.
  - `releaseSurfaces` drops hosts for pane ids that no longer exist.
  - Why: the portal target never changes, so split, move and zoom only move DOM nodes. xterm,
    Monaco and webview state survive, and ptys are not re-attached.
- **Split rendering** (`PaneTree.tsx`): Allotment keyed by the child-id list. Why: Allotment
  caches sizes, so a structural change must rebuild it or panes collapse to a sliver; a pure
  resize keeps the instance.
- **Hidden sessions** (`WorkZone.tsx`): each session mounts on first visit and stays mounted.
  Inactive ones get `visibility: hidden` + `inert`.
  - Why `visibility`, not `display: none`: the box keeps its size, so the fit stays valid.
  - `inert` is cleared in a layout effect so focus can move back into a terminal (focus cannot
    land in an inert subtree).
- **Pane drag/drop** (`Pane.tsx`): the header is the drag handle and uses the MIME type
  `application/x-pine-pane`, so file and text drags are ignored. Dropping within 25% of an edge
  re-splits on that side; the center swaps the two panes.

### Live session state

`lib/sessionActivity.ts` `syncSessionState` runs on OSC 133 C and D, on attach, and on unmount.
A session is `working` if any of its panes has a running block. Otherwise it drops from `working`
to `idle`, and any other state is kept. The renderer never sets `waiting` or `done` today. Each
change emits a `session-state` lifecycle event.

When main receives that event, `waiting` also raises `agent.needs-input` and `done` raises
`agent.done` for the gateway. The sidebar dot is hidden for `idle`.

### Commands and chords

- **Registry** (`commands/registry.ts`): every action is a named command with arg schema.
  `describe()` backs `pine commands --json`. `execWith` never throws; it returns a `CommandResult`.
  Built-ins (`commands/builtins.ts`): `pane.*` (split/close/focus/zoom/move/list), `session.new/list/save`,
  `palette.toggle`, `view.toggleRail`, `app.openSettings`, `editor.open`, `browser.new/open`,
  `kanban.open`, `wiki.open`, `settings.get/set`.
- The renderer doesn't check capabilities; the socket and gateway do.
- There is deliberately no `session.restore`. Restoring into a live window would tear down every
  attached pty; restore happens only at boot.
- **Chords** (`lib/chords.ts`): macOS uses Cmd+K (palette), Cmd+\ (sidebar), Cmd+, (settings) and
  native Cmd+C/V/F. Other platforms use Ctrl+Shift+P, Ctrl+Shift+B, Ctrl+, and Ctrl+Shift+C/V/F
  (copy/paste/find).
  - Any combination with Alt is ignored.
  - App.tsx has a window keydown listener that runs app chords.
  - Inside the terminal, xterm's key handler returns false for app chords so they reach the
    window listener.
  - On non-mac platforms the terminal handles copy, paste and find itself.

### Settings and plugins

- `stores/settingsStore.ts` persists `userData/settings.json` (debounced 300 ms): `locale`,
  `appearance` (theme + ui/terminal/editor fonts), `behavior` (`showHiddenFiles`, `cursorStyle`,
  `cursorBlink`, `restoreSession`), `capabilities.grants`.
  - `setByPath` rejects prototype-pollution segments, keys outside locale/appearance/behavior,
    and type changes.
  - `capabilities.grants` is changed only by hand-editing the file, and is read at startup.
  - `settings/schema.ts` registers a JSON Schema for that file with Monaco.
- `plugins/builtin.ts` is a registry of built-in contributions only: themes (`adeberry`,
  `one-dark-vivid`, `instrument-night`, `dracula`, `oxocarbon`), LSP entries, locales (`en`, `zh-Hant`).
  There is no third-party loader.
- i18n: typed catalogs in `i18n/dict.ts`, read via `useDict()`.

## 6. Control plane

**Transport.** `vscode-jsonrpc` over the unix socket at `controlSocketPath()`. A stale socket
file is unlinked first, and the new socket is chmod 0600.
- A connection must call `hello {token}` first, or every call fails with InvalidRequest.
  Reaching the socket grants nothing.
- A missing capability returns InvalidRequest with `needs-elevation: <cap>`.
- Socket clients receive no push events.

**Identity** (`idRegistry.ts`): each pane gets `{externalId: uuid, token: 32 random bytes hex,
windowId, sessionId}`. Registering a pane twice returns the existing entry. Agents only ever
see external ids.

**Capabilities** (`shared/capabilities.ts`, `capabilityStore.ts`).
- Defaults for every pane: `drive-self`, `read-board`, `notify`, `wiki-read`, `wiki-write`,
  `settings-read`, `board-write`, `process`, `vault-read`, `vault-write`.
- Elevated: `send-other-pane`, `kill-pane`, `workspace-wide`, `shell`, `destructive`, `phone`,
  `gateway`, `browse`, `settings-write`.
- Elevated caps are granted only by `capabilities.grants` in `settings.json`. A grant applies to
  every pane, is read once per run, and unknown names are dropped.
- `phone`, `shell` and `destructive` are never checked on the socket.

**Methods.**
- `controlServer.ts` itself serves `hello`, `whoami`, `command.list`, `command.exec`, `pane.info`,
  `cwd.get`.
- Other modules add methods with `registerControlMethod(name, {cap, handler})`.
- `command.exec` goes through main's `execCommand`: `command:invoke` IPC to a window's registry,
  answered by `command:result`, 5 s timeout. A target with no window goes to the first window.
- If the target differs from the caller's own pane, window or session in any way, the caller
  needs `workspace-wide`. Each command's declared capabilities are checked as well.

**Toolbelt** (all `registerControlMethod`):

| Module | Methods | Notes |
|---|---|---|
| `processManager.ts` | `process.run/list/info/output/kill/restart` | Details below |
| `vault.ts` | `vault.set/get/list/delete` | Details below |
| `wiki.ts` | `wiki.get/set/list/search/delete` | 256 KB per page, 2000 pages per scope |
| `kanban.ts` | `kanban.get/add/move/assign/update/remove` | Project only (`.pine/board.json`); 64 KB per field, 2000 cards |
| `bus.ts` | `bus.send/inbox/wait/handoff/claim/handoffs/update` | Details below |
| `notify.ts` | `notify`, `notify.list` | Log capped at 500; emits a `notify` platform event |
| `docs.ts` | `docs` | Static CLI help, no capability needed |
| `paneList.ts` | `pane.list`, `session.list` | Needs `read-board`; panes without an external id are omitted |

- **`process.*`**:
  - Uses `child_process.spawn` with `detached`, so `killTree` can signal the process group and
    take grandchildren (dev servers) down too.
  - Only the command's first word is persisted, so secrets in args never reach disk.
  - A process owned by another session reports `not-found`, the same as a missing one, so ids
    can't be probed.
  - At load, `running` entries become `exited` and the id counter is advanced past saved ids.
- **`vault.*`**: encrypted with Electron `safeStorage`. With no OS keyring it refuses with
  `encryption-unavailable` and never falls back to plaintext. Files are 0600 and dirs 0700.
  `list` returns names only.
- **`bus.*`**:
  - Sending to yourself is free; another pane needs `send-other-pane`, and `--all` handoffs
    need `workspace-wide`.
  - `wait` checks the inbox before blocking, with a timeout clamped to 1–120 s (default 30 s).
  - Each inbox keeps up to 200 messages and the handoff list up to 500 (finished handoffs are
    evicted first).
- **Existing items stay editable** when a wiki or kanban store is full.

Project-scoped stores refuse with `no-project-workdir` while the session's workDir is unknown.
Why: `jsonStore` would otherwise fall back to main's cwd and pool every unknown session into one
file. Writing to global scope needs `workspace-wide`; reading it does not.

`protoGuard.hasDangerousSegment` rejects `__proto__`, `prototype` and `constructor` in any segment
of a key, not just the last one. It guards wiki slugs, settings dot-paths and snapshot pane-id keys.

**CLI** (`src/cli/index.ts`):
- Reads `PINE_SOCKET` and `PINE_TOKEN`. An unknown verb is sent as `command.exec` with the next
  argument parsed as JSON.
- `pine pane.list` calls the socket method directly, because only that method maps to external ids.
- `pine vault set` reads the secret from stdin with echo off, and restores the tty on every exit path.
- `pine settings get/set` goes through renderer commands so the Settings UI updates live.

The agent-facing guide is the `pine` skill (`.claude/skills/pine/`).

## 7. Gateway (phone companion)

Off by default and never auto-started. Contract: `pine-companion/NETWORK-CONTRACT.md`.

- **Control.** `gateway/index.ts` registers `gateway.enable/disable/pair/status/devices/revoke`
  (elevated `gateway` cap). It also exposes the same functions as `gateway:*` IPC for
  Settings → `GatewaySection.tsx`.
  - `pair` starts the server if needed and returns `{v:1, host, port, fingerprint, pairCode,
    name, warning}`; the renderer draws the QR.
  - `devices` never returns tokens.
  - Two more IPC-only handlers back the Settings UI: `gateway:bind-options` and
    `gateway:set-cap`. Neither is a control-socket method, so no agent or CLI verb can reach them
    (`server.test.ts` pins the registered method list). `gateway:set-cap` also refuses any sender
    that isn't a top-level window (e.g. a `<webview>` guest).
    Why: a phone with `input` is a remote shell. Raising that must be a human at the desktop,
    the same rule as `capabilities.*` in `settings.json`.
- **Server** (`server.ts`): `https` with `POST /pair` and a `ws` endpoint at `/ws` (1 MiB max
  payload); everything else is 404.
  - Default bind is `127.0.0.1:8722`. A LAN or Tailscale host must be chosen explicitly; it is
    persisted in `gateway-config`, and every start and pair response then carries a `warning`.
    Why: an earlier `0.0.0.0` default exposed pairing to the whole network.
  - Bind choices (`interfaces.ts`): loopback, each non-internal IPv4 (LAN), and Tailscale
    addresses from `tailscale ip -4` (2 s timeout) plus any interface in `100.64.0.0/10`. A saved
    host that no longer exists is listed as `custom` so the Select never lies. `0.0.0.0` is not
    offered. Settings shows an exposure warning as soon as a non-loopback address is selected.
    Why: remote use is "bind to your tailnet address", with no hosted relay; picking from real
    interfaces avoids typos that silently bind somewhere else.
  - `startGateway` is idempotent (stop, then start). A 15 s ping heartbeat drops dead sockets.
    `stopGateway` runs at quit.
- **Origin/Host checks.** Any request with an `Origin` header gets 403, and the WS upgrade is
  refused; no browser page is a legitimate caller. `Host` must match the bound host:port, which
  blocks DNS rebinding.
- **TLS** (`cert.ts`): RSA-2048 self-signed cert, 10-year validity, created once in
  `userData/gateway/`. The fingerprint is `sha256/<base64 DER hash>`, and phones pin it on first
  use. Never regenerate or rotate it, because every paired device would be cut off. Dir and key
  permissions are re-applied (0700/0600) on each load.
- **Pairing** (`pairing.ts`):
  - Codes are in-memory, 8 characters with no `0 O 1 I`, valid for 120 s, single use. A code is
    burned even when the attempt fails.
  - Rate limit: 5 attempts per IP per 60 s, and rejected attempts count.
  - Every attempt is logged as NDJSON to `gateway-pair-audit.log`.
  - The Settings countdown only mirrors the TTL; main is what expires the code.
- **Devices** (`devices.ts`): stored with `secure: true`. Each device gets `dev_<uuid>`, a 32-byte
  hex bearer token and phone caps. `verifyToken` compares against every device in constant time.
- **Session.**
  - The first WS message must be `hello {deviceToken}` within 10 s, or the socket closes with 4001.
  - Binary frames start with a type byte: `0x01` pty output, `0x02` input, `0x03` resize (JSON
    `{paneId?, cols, rows}`, integers 1–1000; a `paneId` that isn't the attached pane is ignored).
  - `pty.attach` as `owner` is downgraded to `observer` when the device lacks `input`; the result
    carries the effective `role`.
  - `0x02` and `0x03` need an owner attachment AND `input` in the device's current caps;
    otherwise the frame is dropped and a `-32003 {cap:'input'}` error (id `null`) is sent.
    Why: an observer resizing would SIGWINCH the desktop's shell and reflow the user's terminal,
    which is a write, not a read.
  - Each socket attaches at most one pane and detaches it on close.
  - `device.caps` returns the current caps.
  - Platform events are rebroadcast as `method: 'event'`. `notify`, `agent.needs-input` and
    `agent.done` need the `notify` cap; `session.state` and `pane.state` need `read`. `notify`'s
    `from` is rewritten to the pane's external id (or `null`), the id space phones see.
  - Emitters: `pine notify` (`notify.ts`) emits `notify`; the renderer's `session-state`
    lifecycle event goes through `emitSessionState` (`events.ts`), which emits `session.state`
    plus `agent.needs-input` for `waiting` and `agent.done` for `done`; `terminal:state` emits
    `pane.state`.
- **Revocation** has two parts and both must stay. `closeDeviceSockets` closes live sockets with
  code 4003, and every authenticated frame re-reads the device from the store (`refreshDevice`):
  gone means close 4003, present means its caps replace the socket's cached ones.
- **Grants** (`devices.setDeviceCap`, Settings → Remote per-device switches): only
  `PHONE_GRANTABLE_CAPS` (`command`, `input`, `board.write`, `destructive`) can change; the base
  caps can't be stripped. `destructive` requires `command` and is dropped when `command` is;
  the UI asks for confirmation before granting it. After a change, `applyDeviceCaps` updates live
  sockets: if any cap was removed they are closed with 4004 `caps-changed` (and their pty
  attachment detached); if caps were only added they get a `caps.changed` event.
  Why: closing on removal is the simple correct option. An owner attachment made under the old
  caps can't linger, and the phone's reconnect + `hello` returns the smaller set. Additions
  don't need a reconnect, and the per-frame re-read makes them effective immediately.
- **Phone capabilities** (`controlDispatch.ts`) are a separate vocabulary from the internal
  `Capability` set, and the gateway checks them itself.
  - `read` allows `session.list`, `pane.list`, `command.list`, `pane.info`, `cwd.get`.
  - `command` allows `command.exec`; `board.read` and `board.write` allow `board.get` and
    `board.update`.
  - A missing cap returns `-32003 needs-elevation`.
  - `PHONE_CAP_ALLOWS` is an allowlist from phone caps to internal caps. Why: an earlier bug let
    `command` alone run any command. `input` must never map to a command cap; it only gates
    `0x02` frames.
  - A non-empty target that doesn't resolve is an error, never a fallback to the default window.
  - Only the desktop Settings UI raises a device above its default caps (see Grants).

## 8. Session restore

Two files written by two processes (see CLAUDE.md §6): the renderer writes `sessions.json`
(layout), and main writes `scrollback.json` (pty rings).

- **Layout** (`stores/persistence.ts`, `layout/snapshot.ts`): saved 400 ms after any change to the
  sessions, layout or settings stores, plus once at start and once on `beforeunload`.
  - `buildSnapshot` returns null when no sessions remain, so a blank workspace is never written.
  - `zoomedPaneId` is not saved.
  - The two node converters are a compile-time check that `layout/types.ts` and the snapshot
    types in `shared/types.ts` agree.
- **Scrollback**: main saves it every 5 s (unref'd timer, skipped when no pane cursor moved) and
  again at `before-quit`, so a crash loses at most 5 s. The saved copy is capped at 128 KB per
  pane (the live ring holds 1 MB).
  - `persistScrollback` merges `pendingRestoredScrollback()`. Why: a restored pane that is never
    attached this run keeps its history through a second restart.
- **Quit order**: `persistScrollback` → kill ptys → `killAllLsp` → `killAllProcesses` →
  `stopControlServer` → `stopGateway`.
- **Validation** (`parseSnapshot`): files are hand-editable, so a corrupt one degrades to a cold boot.
  - The file must have `v === 1`. Limits: 32 sessions, 64 panes, tree depth 12.
  - A duplicate pane id drops that session, and bad `sizes` fall back to an even split.
  - Pane-id keys pass `isDangerousSegment` and go into a `Map`.
- **Boot** (`main.tsx`):
  - `hydrate(snapshot)` must run before the first render. Why: otherwise `WorkZone.ensure`
    spawns a pty for the seeded pane, and hydration orphans it.
  - If loading fails, the app boots a fresh workspace.
  - `sessionsStore.hydrate` / `layoutStore.hydrate` re-emit `session-added`, `session-activated`
    and `pane-created`. Why: restored items never went through `ensure`/`split`, so main's id
    registry and the socket would otherwise not know them.
- **Turning `restoreSession` off** calls `session.save(null)`, which deletes both files and
  stops scrollback writes.

## 9. Editor, LSP, browser

- **Monaco** (`monaco/setup.ts`, `components/Editor.tsx`):
  - Workers are bundled with Vite `?worker` imports (editor, json, css, html, ts), with no CDN.
  - The editor uses the single `one-dark-vivid` Monaco theme; it does not yet follow the app theme.
  - Ctrl/Cmd+S saves through `fs.write`. Dirty state compares `getAlternativeVersionId` with the
    saved version (mirrored to `editorStatusStore`).
  - Files with a NUL byte in the first 8 KB are not opened.
- **LSP**:
  - `main/lsp.ts` spawns pyright, rust-analyzer, gopls, clangd, bash-, lua-, json- and
    yaml-language-server when they are on `PATH` (a POSIX `:` split).
  - Servers are keyed `lang::root`, where root is found by walking up to a marker (`.git`,
    `package.json`, `go.mod`, `Cargo.toml`, …), and are shared across files.
  - A later `lsp:start` rebinds output to the newest webContents.
  - TS/JS are left out on purpose. Monaco's TS worker already covers them, and adding tsserver
    would double every diagnostic.
  - `renderer/lsp/client.ts` is a hand-written client over `vscode-jsonrpc` with the IPC
    reader/writer in `lsp/transport.ts`. It syncs full text and provides completion, hover,
    definition, and diagnostics as markers (owner `lsp`).
  - The client goes into the map before `initialize` completes, so concurrent opens share it. Every
    request awaits `client.ready`. LSP is best-effort and must never throw into the editor.
- **Browser panes** (`components/BrowserView.tsx`):
  - Each pane is an Electron `<webview>` with a per-pane in-memory partition
    `pine-browser-<paneId>`. Why: a shared `persist:` partition leaked cookies between panes.
  - A new URL for an existing pane calls `loadURL` on the guest, because `src` is only read at
    mount. If the guest isn't ready yet, the URL waits for `dom-ready`.
  - Main's `will-attach-webview` rejects any partition not starting with `pine-browser` and forces
    no preload, no nodeIntegration, contextIsolation and sandbox.
  - `browser:register` requires that the sender owns the pane and that the webContents is a
    `webview` guest hosted by that sender. Why: otherwise a renderer could register Pine's own
    webContents and drive it with `browse.eval`.
- **Automation** (`main/browse.ts`): about 45 `browse.*` methods, all behind the elevated
  `browse` cap.
  - **Target**: an explicit pane id is an external id, and driving another session's pane also
    needs `workspace-wide`. With no pane id, the first browser pane in the caller's session is used.
  - **Mechanics**:
    - Most methods use `executeJavaScript` with an injected `window.__pine` helper (element refs
      `eN`, role/name guesses, a current-frame pointer).
    - Keys use `sendInputEvent`, screenshots use `capturePage`, and cookies/storage use
      `guest.session`.
    - Scripts that must run on every future page load (`addinitscript`, the dialog override, the
      error catcher) go through the CDP debugger (`Page.addScriptToEvaluateOnNewDocument`).
  - **Security**: every agent-supplied string is `JSON.stringify`-ed into generated JS.
    `screenshot`, `state` and `download` output paths go through `resolveSafe`.
  - **Gotchas**:
    - `dom-ready` fires on every navigation, so the console listener is attached once
      (`listenerCount` guard) and injected scripts guard against running twice.
    - Chrome allows one debugger per guest, so the error catcher silently fails if DevTools is
      open on that pane.
    - `<webview>` can't intercept synchronous dialogs, so `alert/confirm/prompt` are replaced and
      follow a standing accept/dismiss policy that resets to dismiss on every navigation.
    - Element refs and `reactGrab` state are lost on navigation.
  - **Limits**: console and errors 500 each, dialogs 200, snapshot 2000 nodes, depth 40
    (max 200).

## 10. Testing and packaging

- Test layout and house rules: CLAUDE.md §7.
- E2E runs the built app serially (`workers: 1`) because each instance owns a pty set and a
  per-PID socket. Every launch spreads `isolatedLaunch()` (`e2e/dataHome.ts`) to get a throwaway
  `XDG_DATA_HOME` and `--user-data-dir`. `session-restore.spec.ts` shares one data home across
  two launches and quits through `app.quit()` so `before-quit` runs.
- `pnpm install:local` runs `pnpm package` (electron-builder → `dist/linux-unpacked`), then
  `scripts/install-linux.sh`. The script copies the build to `~/.local/share/pine/app` and writes
  `~/.local/share/applications/pine.desktop`.
